import express, { type Request, type Response, type ErrorRequestHandler } from 'express';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { z } from 'zod';
import type { BookRecord, CatalogCandidate, Observation, ScanEvent } from '../shared/types';
import { VisionError } from './vision';
import { CatalogError } from './catalog';
import { StudioError } from './studio-errors';
import { studioBriefInputSchema, studioGenerationSchema, type StudioBrief, type StudioBriefInput, type StudioJob } from '../shared/studio';

interface AppOptions {
  recognize: (image: { data: string; mimeType: string }, mode: 'shelf' | 'table', signal?: AbortSignal) => Promise<{ observations: Observation[]; warnings: string[] }>;
  catalog: { enrich: (observation: Observation, signal?: AbortSignal) => Promise<BookRecord>; search: (query: string, signal?: AbortSignal) => Promise<CatalogCandidate[]> };
  recognitionReady: boolean;
  accessToken?: string;
  production?: boolean;
  origin?: string;
  trustProxy?: number;
  scanDeadlineMs?: number;
  maxConcurrentScans?: number;
  /** A bounded metadata pool; deliberately smaller than the observed book count. */
  enrichmentConcurrency?: number;
  studio?: {
    ready: boolean;
    createBrief: (input: StudioBriefInput, signal?: AbortSignal) => Promise<StudioBrief>;
    jobs: {
      submit: (ownerId: string, requestId: string, brief: StudioBrief) => StudioJob;
      get: (ownerId: string, id: string) => StudioJob;
      cancel: (ownerId: string, id: string) => StudioJob;
    };
  };
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const hash = (value: string) => createHash('sha256').update(value).digest();

/** Release HTTP/concurrency resources even if a dependency ignores its abort signal. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason ?? new DOMException('Cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

function fixedWindow(limit: number, windowMs: number) {
  const clients = new Map<string, { started: number; count: number }>();
  return (key: string) => {
    const now = Date.now();
    for (const [client, value] of clients) if (now - value.started >= windowMs) clients.delete(client);
    let record = clients.get(key);
    if (!record) {
      if (clients.size >= 5000) return false;
      record = { started: now, count: 0 };
      clients.set(key, record);
    }
    return ++record.count <= limit;
  };
}

export function createApp(options: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);
  const accessConfigured = !options.production || (options.accessToken?.length ?? 0) >= 16;
  const recognitionReady = options.recognitionReady && accessConfigured;
  const authBudget = fixedWindow(30, 15 * 60_000);
  const scanBudget = fixedWindow(20, 10 * 60_000);
  const globalBudget = fixedWindow(100, 60 * 60_000);
  const searchBudget = fixedWindow(100, 10 * 60_000);
  const briefBudget = fixedWindow(30, 10 * 60_000);
  const briefGlobalBudget = fixedWindow(100, 60 * 60_000);
  const studioBudget = fixedWindow(10, 10 * 60_000);
  const studioGlobalBudget = fixedWindow(40, 60 * 60_000);
  const studioCookieSecret = randomBytes(32);
  const activeBriefClients = new Set<string>();
  const activeClients = new Set<string>();
  let activeScans = 0;

  app.use((request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    response.setHeader('X-Frame-Options', 'DENY');
    if (options.production) response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://books.google.com https://books.googleusercontent.com https://covers.openlibrary.org; connect-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    if (request.path.startsWith('/api/')) response.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({ recognitionReady, accessRequired: !!options.accessToken || (!!options.production && !accessConfigured), studioReady: !!options.studio?.ready && accessConfigured });
  });

  app.use('/api', (request, _response, next) => {
    try {
      const origin = request.get('origin');
      const expectedOrigin = options.origin || `${request.protocol}://${request.get('host')}`;
      if (request.get('sec-fetch-site') === 'cross-site' || (origin && origin !== expectedOrigin)) throw new HttpError(403, 'ORIGIN_FORBIDDEN', 'Apri Jemiq dal suo indirizzo originale.');
      if (!accessConfigured) throw new HttpError(503, 'ACCESS_NOT_CONFIGURED', 'Il servizio è in fase di configurazione. Puoi usare l’esempio e creare elenchi manuali.');
      if (options.accessToken) {
        const supplied = request.get('authorization')?.replace(/^Bearer /, '') ?? '';
        if (!timingSafeEqual(hash(supplied), hash(options.accessToken))) {
          if (!authBudget(request.ip ?? 'unknown')) throw new HttpError(429, 'ACCESS_RATE_LIMIT', 'Troppi tentativi. Attendi qualche minuto e riprova.');
          throw new HttpError(401, 'ACCESS_REQUIRED', 'Inserisci il codice di accesso di Jemiq.');
        }
      }
      next();
    } catch (error) { next(error); }
  });

  app.use('/api', express.json({ limit: '12mb', strict: true }));
  const scanSchema = z.object({
    image: z.object({ data: z.string().min(1).max(11_200_000), mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']) }).strict(),
    mode: z.enum(['shelf', 'table']),
  }).strict();

  app.post('/api/scan', async (request, response, next) => {
    let admitted = false;
    const client = request.ip ?? 'unknown';
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new DOMException('Analysis timeout', 'TimeoutError')), options.scanDeadlineMs ?? 165_000);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    const send = async (event: ScanEvent) => {
      controller.signal.throwIfAborted();
      if (!response.write(`${JSON.stringify(event)}\n`)) await once(response, 'drain', { signal: controller.signal });
    };
    try {
      if (!recognitionReady) throw new HttpError(503, 'RECOGNITION_NOT_CONFIGURED', 'Il riconoscimento non è ancora attivo. Puoi usare l’esempio o inserire i libri manualmente.');
      const parsed = scanSchema.safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, 'INVALID_REQUEST', 'Scegli una foto JPEG, PNG o WebP e riprova.');
      if (activeClients.has(client) || activeScans >= (options.maxConcurrentScans ?? 2)) throw new HttpError(429, 'SCAN_BUSY', 'È già in corso un’analisi. Attendi la conclusione e riprova.');
      if (!scanBudget(client) || !globalBudget('all')) throw new HttpError(429, 'SCAN_RATE_LIMIT', 'Sono state eseguite molte analisi. Attendi qualche minuto e riprova.');
      activeScans++;
      activeClients.add(client);
      admitted = true;
      const started = Date.now();
      // Admission errors retain their HTTP status; later failures are explicit stream events.
      response.status(200).set({ 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      await send({ type: 'stage', stage: 'recognizing', message: 'Leggo titoli e autori visibili nella foto.' });
      const result = await withAbort(options.recognize(parsed.data.image, parsed.data.mode, controller.signal), controller.signal);
      await send({ type: 'observations', total: result.observations.length, warnings: result.warnings });
      if (result.observations.length) await send({ type: 'stage', stage: 'enriching', message: 'Cerco i dati nei cataloghi bibliografici.' });
      let nextIndex = 0;
      let completed = 0;
      const work = async () => {
        while (nextIndex < result.observations.length) {
          controller.signal.throwIfAborted();
          const index = nextIndex++;
          const book = await withAbort(options.catalog.enrich(result.observations[index], controller.signal), controller.signal);
          await send({ type: 'book', book, completed: ++completed, total: result.observations.length });
        }
      };
      await Promise.all(Array.from({ length: Math.min(options.enrichmentConcurrency ?? 3, result.observations.length) }, () => work()));
      await send({ type: 'done', warnings: result.warnings, elapsedMs: Date.now() - started });
      response.end();
    } catch (error) {
      if (!response.headersSent) next(error);
      else if (!response.destroyed && !response.writableEnded) {
        const known = error instanceof HttpError || error instanceof VisionError || error instanceof CatalogError;
        const code = controller.signal.aborted ? 'SCAN_INTERRUPTED' : known ? error.code : 'SCAN_FAILED';
        const safeMessage = controller.signal.aborted ? 'L’analisi è stata interrotta o ha superato il tempo disponibile. I risultati ricevuti sono conservati.' : known ? error.message : 'Il servizio ha incontrato un problema. I risultati ricevuti sono conservati. Riprova tra poco.';
        response.end(`${JSON.stringify({ type: 'error', error: safeMessage, code })}\n`);
      }
    } finally {
      clearTimeout(deadline);
      response.off('close', disconnected);
      controller.abort();
      if (admitted) { activeScans--; activeClients.delete(client); }
    }
  });

  app.post('/api/search', async (request, response, next) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18_000);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    try {
      const parsed = z.object({ query: z.string().trim().min(2).max(240) }).strict().safeParse(request.body);
      if (!parsed.success) throw new HttpError(400, 'INVALID_QUERY', 'Inserisci un titolo, un autore o un ISBN valido.');
      if (!searchBudget(request.ip ?? 'unknown')) throw new HttpError(429, 'SEARCH_RATE_LIMIT', 'Troppe ricerche. Attendi qualche minuto e riprova.');
      response.json({ candidates: await withAbort(options.catalog.search(parsed.data.query, controller.signal), controller.signal) });
    } catch (error) { next(error); }
    finally { clearTimeout(timeout); response.off('close', disconnected); controller.abort(); }
  });

  const studioSignature = (id: string) => createHmac('sha256', studioCookieSecret).update(id).digest('hex');
  const studioOwner = (request: Request): string | null => {
    const cookie = request.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('jemiq_studio='))?.slice(13);
    if (!cookie || !/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(cookie)) return null;
    const [id, signature] = cookie.split('.');
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(studioSignature(id), 'hex')) ? id : null;
  };
  const requireStudioOwner = (request: Request) => {
    const owner = studioOwner(request);
    if (!owner) throw new StudioError(403, 'STUDIO_SESSION_REQUIRED', 'La sessione di Studio è scaduta o i cookie sono bloccati. Riapri il progetto; una nuova generazione richiede una tua scelta.');
    return owner;
  };

  app.post('/api/studio/session', (request, response, next) => {
    try {
      if (!options.studio) throw new StudioError(503, 'STUDIO_NOT_CONFIGURED', 'Studio non è ancora configurato.');
      const owner = studioOwner(request) ?? randomBytes(16).toString('hex');
      response.setHeader('Set-Cookie', `jemiq_studio=${owner}.${studioSignature(owner)}; Path=/api/studio; HttpOnly; SameSite=Strict; Max-Age=86400${options.production ? '; Secure' : ''}`);
      response.json({ ready: true });
    } catch (error) { next(error); }
  });

  app.post('/api/studio/brief', async (request, response, next) => {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 60_000);
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    const client = request.ip ?? 'unknown';
    let admitted = false;
    try {
      if (!options.studio) throw new StudioError(503, 'STUDIO_NOT_CONFIGURED', 'Studio non è ancora configurato.');
      const input = studioBriefInputSchema.safeParse(request.body);
      if (!input.success) throw new StudioError(400, 'STUDIO_INVALID_BRIEF_INPUT', 'Controlla titolo, autore e indicazioni per l’atmosfera.');
      if (activeBriefClients.has(client) || activeBriefClients.size >= 2) throw new StudioError(429, 'STUDIO_BRIEF_BUSY', 'È già in preparazione una proposta. Attendi e riprova.');
      if (!briefBudget(client) || !briefGlobalBudget('all')) throw new StudioError(429, 'STUDIO_BRIEF_RATE_LIMIT', 'Sono state preparate molte proposte. Attendi qualche minuto e riprova.');
      activeBriefClients.add(client); admitted = true;
      response.json(await withAbort(options.studio.createBrief(input.data, controller.signal), controller.signal));
    } catch (error) { next(error); }
    finally { clearTimeout(deadline); response.off('close', disconnected); controller.abort(); if (admitted) activeBriefClients.delete(client); }
  });

  app.post('/api/studio/jobs', (request, response, next) => {
    try {
      if (!options.studio?.ready || !accessConfigured) throw new StudioError(503, 'STUDIO_NOT_CONFIGURED', 'La generazione di immagini non è ancora configurata. Il progetto e il ritaglio restano disponibili.');
      const owner = requireStudioOwner(request);
      const parsed = studioGenerationSchema.safeParse(request.body);
      if (!parsed.success) throw new StudioError(400, 'STUDIO_INVALID_REQUEST', 'Controlla la proposta prima di creare l’immagine.');
      let existing = false;
      try { options.studio.jobs.get(owner, parsed.data.requestId); existing = true; }
      catch (error) { if (!(error instanceof StudioError) || error.status !== 404) throw error; }
      if (!existing && (!studioBudget(request.ip ?? 'unknown') || !studioGlobalBudget('all'))) throw new StudioError(429, 'STUDIO_RATE_LIMIT', 'Hai raggiunto il limite temporaneo di generazioni. Attendi e riprova; i risultati esistenti restano recuperabili.');
      const job = options.studio.jobs.submit(owner, parsed.data.requestId, parsed.data.brief);
      response.status(job.status === 'running' ? 202 : 200).json(job);
    } catch (error) { next(error); }
  });
  app.get('/api/studio/jobs/:id', (request, response, next) => {
    try {
      if (!options.studio) throw new StudioError(503, 'STUDIO_NOT_CONFIGURED', 'Studio non è ancora configurato.');
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) throw new StudioError(400, 'STUDIO_INVALID_JOB', 'Il riferimento al progetto non è valido.');
      response.json(options.studio.jobs.get(requireStudioOwner(request), id.data));
    } catch (error) { next(error); }
  });
  app.post('/api/studio/jobs/:id/cancel', (request, response, next) => {
    try {
      if (!options.studio) throw new StudioError(503, 'STUDIO_NOT_CONFIGURED', 'Studio non è ancora configurato.');
      const id = z.string().uuid().safeParse(request.params.id);
      if (!id.success) throw new StudioError(400, 'STUDIO_INVALID_JOB', 'Il riferimento al progetto non è valido.');
      response.json(options.studio.jobs.cancel(requireStudioOwner(request), id.data));
    } catch (error) { next(error); }
  });

  app.use('/api', (_request, _response, next) => next(new HttpError(404, 'NOT_FOUND', 'Operazione non disponibile.')));
  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    if (error?.type === 'entity.too.large') { response.status(413).json({ error: 'La foto è troppo grande. Scegli un file più piccolo.', code: 'IMAGE_TOO_LARGE' }); return; }
    if (error instanceof SyntaxError && 'body' in error) { response.status(400).json({ error: 'La richiesta non è leggibile. Ricarica la pagina e riprova.', code: 'INVALID_JSON' }); return; }
    const known = error instanceof HttpError || error instanceof VisionError || error instanceof CatalogError || error instanceof StudioError;
    const aborted = error?.name === 'AbortError' || error?.name === 'TimeoutError';
    response.status(known ? error.status : aborted ? 504 : 500).json({ error: known ? error.message : aborted ? 'La ricerca ha impiegato troppo tempo. Riprova.' : 'Il servizio ha incontrato un problema. Riprova tra poco.', code: known ? error.code : aborted ? 'TIMEOUT' : 'INTERNAL_ERROR' });
  };
  app.use(errorHandler);
  return app;
}
