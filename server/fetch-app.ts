import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { BookRecord, CatalogCandidate, Observation, ScanEvent } from '../shared/types';
import { VisionError } from './vision';
import { CatalogError } from './catalog';
import { StorageError, type CatalogStore } from './storage/contracts';
import { createMemoryBudget, type RateBudget } from './rate-limit';
import { settingsInputSchema, type SettingsStatus } from './settings';

export interface RecognitionServices {
  recognize: (image: { data: string; mimeType: string }, mode: 'shelf' | 'table', signal?: AbortSignal) => Promise<{ observations: Observation[]; warnings: string[] }>;
  catalog: { enrich: (observation: Observation, signal?: AbortSignal) => Promise<BookRecord>; search: (query: string, signal?: AbortSignal) => Promise<CatalogCandidate[]> };
  recognitionReady: boolean;
  checkVision?: (signal?: AbortSignal) => Promise<{ ready: true }>;
}
export interface AppOptions extends RecognitionServices {
  accessToken?: string;
  production?: boolean;
  origin?: string;
  trustProxy?: number;
  authMode?: 'platform' | 'token';
  /** Explicit, isolated maintenance access. Disabled by default on hosted installations. */
  allowServiceToken?: boolean;
  scanDeadlineMs?: number;
  maxConcurrentScans?: number;
  enrichmentConcurrency?: number;
  catalogStore?: CatalogStore;
  budget?: RateBudget;
  getServices?: (owner: string) => Promise<RecognitionServices>;
  settings?: {
    editable: boolean;
    status(owner: string): Promise<SettingsStatus>;
    update(owner: string, input: z.infer<typeof settingsInputSchema>, signal: AbortSignal): Promise<SettingsStatus>;
  };
}
/** Supplied by the host adapter, never populated from a client-selected owner header. */
export interface RequestContext { ownerId?: string; clientId?: string }
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest();
const scanSchema = z.object({
  image: z.object({ data: z.string().min(1).max(11_200_000), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']) }).strict(),
  mode: z.enum(['shelf', 'table']),
}).strict();
const searchSchema = z.object({ query: z.string().trim().min(2).max(240) }).strict();
const putSchema = z.object({ catalog: z.unknown(), expectedUpdatedAt: z.string().max(64).nullable(), preservePhoto: z.boolean().optional() }).strict();

export const API_HEADERS = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
};
export const STANDALONE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://books.google.com https://books.googleusercontent.com https://covers.openlibrary.org; connect-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}
function knownError(error: unknown): error is HttpError | VisionError | CatalogError | StorageError {
  return error instanceof HttpError || error instanceof VisionError || error instanceof CatalogError || error instanceof StorageError;
}
function errorResponse(error: unknown): Response {
  const known = knownError(error);
  const aborted = error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name);
  return Response.json({
    error: known ? error.message : aborted ? 'La ricerca ha impiegato troppo tempo. Riprova.' : 'Il servizio ha incontrato un problema. Riprova tra poco.',
    code: known ? error.code : aborted ? 'TIMEOUT' : 'INTERNAL_ERROR',
  }, { status: known ? error.status : aborted ? 504 : 500 });
}
async function readJson(request: Request, maxBytes = 12 * 1024 * 1024): Promise<unknown> {
  const length = Number(request.headers.get('content-length'));
  const tooLarge = () => new HttpError(413, 'IMAGE_TOO_LARGE', 'La foto è troppo grande. Scegli un file più piccolo.');
  if (length > maxBytes) throw tooLarge();
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new HttpError(400, 'INVALID_JSON', 'La richiesta non è leggibile. Ricarica la pagina e riprova.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'La richiesta è vuota.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await withAbort(reader.read(), request.signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw tooLarge(); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new HttpError(400, 'INVALID_JSON', 'La richiesta non è leggibile. Ricarica la pagina e riprova.'); }
  } finally { reader.releaseLock(); }
}
async function timed<T>(request: Request, timeout: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const disconnect = () => controller.abort(request.signal.reason);
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeout);
  request.signal.addEventListener('abort', disconnect, { once: true });
  if (request.signal.aborted) disconnect();
  try { return await withAbort(work(controller.signal), controller.signal); }
  finally { clearTimeout(timer); request.signal.removeEventListener('abort', disconnect); controller.abort(); }
}

export function createFetchApp(options: AppOptions) {
  const budget = options.budget ?? createMemoryBudget();
  const platform = options.authMode === 'platform';
  const accessConfigured = platform || !options.production || (options.accessToken?.length ?? 0) >= 16;
  const activeClients = new Set<string>();
  let activeScans = 0;
  let visionCheckActive = false;
  const take = (scope: string, key: string, limit: number, windowMs: number) => budget.take(scope, key, limit, windowMs);
  const suppliedOwner = (request: Request, context: RequestContext): string | undefined => {
    if (platform && context.ownerId) return context.ownerId;
    const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if ((!platform || options.allowServiceToken) && options.accessToken && timingSafeEqual(hash(supplied), hash(options.accessToken))) return platform ? 'service' : 'self-hosted';
    return !platform && !options.production && !options.accessToken ? 'self-hosted' : undefined;
  };
  const servicesFor = (owner: string) => options.getServices?.(owner) ?? Promise.resolve(options);

  async function route(request: Request, context: RequestContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '');
    const client = context.clientId ?? 'unknown';
    const owner = suppliedOwner(request, context);
    if (path === '/api/health' && request.method === 'GET') {
      const services = owner ? await servicesFor(owner) : options;
      return Response.json({
        recognitionReady: services.recognitionReady && accessConfigured,
        accessRequired: platform ? !owner : !!options.accessToken || (!!options.production && !accessConfigured),
        ...(options.authMode ? { authMode: options.authMode } : {}),
        ...(options.catalogStore ? { storageMode: 'cloud', ...(owner ? { ownerId: owner } : {}) } : {}),
        ...(options.settings ? { settingsSupported: true } : {}),
      });
    }
    const origin = request.headers.get('origin');
    const expectedOrigin = options.origin || url.origin;
    if (request.headers.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin)) throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'Apri Jemiq dal suo indirizzo originale.');
    if (!accessConfigured) throw new HttpError(503, 'ACCESS_NOT_CONFIGURED', 'Il servizio è in fase di configurazione. Puoi usare l’esempio e creare elenchi manuali.');
    if (!owner) {
      if (!await take('auth', client, 30, 15 * 60_000)) throw new HttpError(429, 'ACCESS_RATE_LIMIT', 'Troppi tentativi. Attendi qualche minuto e riprova.');
      throw new HttpError(401, 'ACCESS_REQUIRED', platform ? 'La sessione è scaduta. Riapri Jemiq e accedi al tuo spazio.' : 'Inserisci il codice di accesso di Jemiq.');
    }
    const budgetClient = platform ? owner : client;
    if (path === '/api/settings') {
      if (!options.settings) throw new HttpError(503, 'SETTINGS_NOT_AVAILABLE', 'Le impostazioni sono gestite sul server.');
      if (request.method === 'GET') return Response.json(await options.settings.status(owner));
      if (request.method === 'POST') {
        if (!options.settings.editable) throw new HttpError(403, 'SETTINGS_READ_ONLY', 'Le chiavi sono gestite nei segreti del server.');
        const parsed = settingsInputSchema.safeParse(await readJson(request, 4096));
        if (!parsed.success) throw new HttpError(400, 'INVALID_SETTINGS', 'Controlla le chiavi e il modello indicato.');
        if (!await take('settings', owner, 5, 10 * 60_000) || !await take('check-global', 'all', 20, 10 * 60_000)) throw new HttpError(429, 'VISION_CHECK_RATE_LIMIT', 'Sono state eseguite molte verifiche. Attendi qualche minuto.');
        return Response.json(await timed(request, 35_000, signal => options.settings!.update(owner, parsed.data, signal)));
      }
    }
    if (path === '/api/catalogs' || path.startsWith('/api/catalogs/')) {
      if (!options.catalogStore) throw new HttpError(503, 'STORAGE_NOT_CONFIGURED', 'L’archivio del server non è configurato.');
      const expectedOwner = request.headers.get('x-jemiq-owner');
      if (!expectedOwner || expectedOwner !== owner) throw new HttpError(403, 'OWNER_CHANGED', 'L’account è cambiato. Ricarica Jemiq prima di sincronizzare i cataloghi.');
      if (!await take('catalog-write', owner, 600, 10 * 60_000)) throw new HttpError(429, 'STORAGE_RATE_LIMIT', 'Troppe operazioni sull’archivio. Attendi e riprova.');
      if (path === '/api/catalogs' && request.method === 'GET') return Response.json({ catalogs: await options.catalogStore.list(owner) });
      const encodedId = path.slice('/api/catalogs/'.length);
      let id: string;
      try { id = decodeURIComponent(encodedId); } catch { throw new HttpError(400, 'INVALID_CATALOG', 'Il riferimento al catalogo non è valido.'); }
      if (!id || id.length > 160 || id.includes('/')) throw new HttpError(400, 'INVALID_CATALOG', 'Il riferimento al catalogo non è valido.');
      if (request.method === 'GET') {
        const catalog = await options.catalogStore.get(owner, id);
        if (!catalog) throw new HttpError(404, 'CATALOG_NOT_FOUND', 'Questo catalogo non è disponibile.');
        return Response.json({ catalog });
      }
      if (request.method === 'PUT') {
        const parsed = putSchema.safeParse(await readJson(request));
        if (!parsed.success || !parsed.data.catalog || typeof parsed.data.catalog !== 'object' || !('id' in parsed.data.catalog) || parsed.data.catalog.id !== id) throw new HttpError(400, 'INVALID_CATALOG', 'I dati del catalogo non sono validi.');
        const catalog = await options.catalogStore.put(owner, parsed.data.catalog as Parameters<CatalogStore['put']>[1], { expectedUpdatedAt: parsed.data.expectedUpdatedAt, preservePhoto: parsed.data.preservePhoto });
        return Response.json({ catalog });
      }
      if (request.method === 'DELETE') { await options.catalogStore.delete(owner, id); return new Response(null, { status: 204 }); }
    }
    if (path === '/api/vision/check' && request.method === 'POST') {
      const services = await servicesFor(owner);
      if (!services.recognitionReady || !services.checkVision) throw new HttpError(503, 'VISION_NOT_CONFIGURED', 'Il servizio di lettura non è configurato.');
      if (!z.object({}).strict().safeParse(await readJson(request, 4096)).success) throw new HttpError(400, 'INVALID_REQUEST', 'La richiesta di verifica non è valida.');
      if (visionCheckActive) throw new HttpError(429, 'VISION_CHECK_BUSY', 'È già in corso una verifica. Attendi la conclusione.');
      if (!await take('check', budgetClient, 5, 10 * 60_000) || !await take('check-global', 'all', 20, 10 * 60_000)) throw new HttpError(429, 'VISION_CHECK_RATE_LIMIT', 'Sono state eseguite molte verifiche. Attendi qualche minuto.');
      if (visionCheckActive) throw new HttpError(429, 'VISION_CHECK_BUSY', 'È già in corso una verifica. Attendi la conclusione.');
      visionCheckActive = true;
      try { return Response.json(await timed(request, 35_000, signal => services.checkVision!(signal))); }
      finally { visionCheckActive = false; }
    }
    if (path === '/api/search' && request.method === 'POST') {
      const parsed = searchSchema.safeParse(await readJson(request, 4096));
      if (!parsed.success) throw new HttpError(400, 'INVALID_QUERY', 'Inserisci un titolo, un autore o un ISBN valido.');
      if (!await take('search', budgetClient, 100, 10 * 60_000)) throw new HttpError(429, 'SEARCH_RATE_LIMIT', 'Troppe ricerche. Attendi qualche minuto e riprova.');
      const services = await servicesFor(owner);
      return Response.json({ candidates: await timed(request, 18_000, signal => services.catalog.search(parsed.data.query, signal)) });
    }
    if (path === '/api/scan' && request.method === 'POST') {
      const services = await servicesFor(owner);
      if (!services.recognitionReady) throw new HttpError(503, 'RECOGNITION_NOT_CONFIGURED', 'Il riconoscimento non è ancora attivo. Puoi usare l’esempio o inserire i libri manualmente.');
      const parsed = scanSchema.safeParse(await readJson(request));
      if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', 'Scegli una foto JPEG, PNG o WebP e riprova.');
      const assertCapacity = () => { if (activeClients.has(budgetClient) || activeScans >= (options.maxConcurrentScans ?? 2)) throw new HttpError(429, 'SCAN_BUSY', 'È già in corso un’analisi. Attendi la conclusione e riprova.'); };
      assertCapacity();
      if (!await take('scan', budgetClient, 20, 10 * 60_000) || !await take('scan-global', 'all', 100, 60 * 60_000)) throw new HttpError(429, 'SCAN_RATE_LIMIT', 'Sono state eseguite molte analisi. Attendi qualche minuto e riprova.');
      assertCapacity();
      activeScans++; activeClients.add(budgetClient);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException('Analysis timeout', 'TimeoutError')), options.scanDeadlineMs ?? 165_000);
      const disconnected = () => controller.abort(request.signal.reason);
      request.signal.addEventListener('abort', disconnected, { once: true });
      if (request.signal.aborted) disconnected();
      const encoder = new TextEncoder();
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        async start(output) {
          const started = Date.now();
          const send = (event: ScanEvent) => { controller.signal.throwIfAborted(); output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); };
          try {
            send({ type: 'stage', stage: 'recognizing', message: 'Leggo titoli e autori visibili nella foto.' });
            const result = await withAbort(services.recognize(parsed.data.image, parsed.data.mode, controller.signal), controller.signal);
            send({ type: 'observations', total: result.observations.length, warnings: result.warnings });
            if (result.observations.length) send({ type: 'stage', stage: 'enriching', message: 'Cerco i dati nei cataloghi bibliografici.' });
            let next = 0; let completed = 0;
            const work = async () => {
              while (next < result.observations.length) {
                controller.signal.throwIfAborted();
                const observation = result.observations[next++];
                const book = await withAbort(services.catalog.enrich(observation, controller.signal), controller.signal);
                send({ type: 'book', book, completed: ++completed, total: result.observations.length });
              }
            };
            await Promise.all(Array.from({ length: Math.min(options.enrichmentConcurrency ?? 3, result.observations.length) }, work));
            send({ type: 'done', warnings: result.warnings, elapsedMs: Date.now() - started });
          } catch (error) {
            if (!cancelled && !request.signal.aborted) {
              const code = controller.signal.aborted ? 'SCAN_INTERRUPTED' : knownError(error) ? error.code : 'SCAN_FAILED';
              const message = controller.signal.aborted ? 'L’analisi è stata interrotta o ha superato il tempo disponibile. I risultati ricevuti sono conservati.' : knownError(error) ? error.message : 'Il servizio ha incontrato un problema. I risultati ricevuti sono conservati. Riprova tra poco.';
              output.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', error: message, code })}\n`));
            }
          } finally {
            clearTimeout(timer); request.signal.removeEventListener('abort', disconnected); controller.abort();
            activeScans--; activeClients.delete(budgetClient);
            if (!cancelled) output.close();
          }
        },
        cancel() { cancelled = true; controller.abort(); },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' } });
    }
    throw new HttpError(404, 'NOT_FOUND', 'Operazione non disponibile.');
  }
  return async (request: Request, context: RequestContext = {}): Promise<Response> => {
    let response: Response;
    try { response = await route(request, context); }
    catch (error) { response = errorResponse(error); }
    for (const [key, value] of Object.entries(API_HEADERS)) response.headers.set(key, value);
    if (options.production) response.headers.set('Content-Security-Policy', STANDALONE_CSP);
    return response;
  };
}
