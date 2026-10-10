import { z } from 'zod';
import { candidateSchema, scanEventSchema } from '../../shared/schemas';
import type { CatalogCandidate, HealthStatus, PreparedImage, ScanEvent } from '../../shared/types';

export class ApiError extends Error {
  constructor(message: string, public status = 0, public code = 'REQUEST_FAILED') { super(message); this.name = 'ApiError'; }
}

let accessToken = '';
try { accessToken = sessionStorage.getItem('jemiq.access') ?? ''; } catch { /* Storage may be unavailable in private browsing. */ }
export function setAccessToken(value: string) {
  accessToken = value.trim();
  try { if (accessToken) sessionStorage.setItem('jemiq.access', accessToken); else sessionStorage.removeItem('jemiq.access'); } catch { /* In-memory access still works. */ }
}
export function hasAccessToken(): boolean { return accessToken.length > 0; }

function headers(): HeadersInit {
  return { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) };
}

export { headers as apiHeaders, responseError as rejectApiResponse };

async function responseError(response: Response): Promise<never> {
  const body = await response.json().catch(() => ({}));
  throw new ApiError(typeof body.error === 'string' ? body.error : 'Il servizio non risponde. Riprova tra poco.', response.status, body.code);
}

export async function getHealth(): Promise<HealthStatus> {
  const response = await fetch('/api/health', { signal: AbortSignal.timeout(8000), cache: 'no-store' });
  if (!response.ok) return responseError(response);
  return z.object({ recognitionReady: z.boolean(), accessRequired: z.boolean(), studioReady: z.boolean().default(false) }).parse(await response.json());
}

/** Consume actual server events. An interrupted stream must not become a successful scan. */
export async function readScanStream(response: Response, onEvent: (event: ScanEvent) => void, signal?: AbortSignal) {
  if (!response.ok) return responseError(response);
  if (!response.body) throw new ApiError('Il browser non può leggere i risultati. Ricarica la pagina.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  const parseLine = (line: string) => {
    if (!line.trim()) return;
    let event: ScanEvent;
    try { event = scanEventSchema.parse(JSON.parse(line)); }
    catch { throw new ApiError('Il servizio ha restituito dati non leggibili. I risultati già ricevuti sono conservati.', 502, 'INVALID_STREAM'); }
    if (event.type === 'error') throw new ApiError(event.error, 502, event.code);
    if (event.type === 'done') completed = true;
    onEvent(event);
  };
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) throw new ApiError('Risposta troppo grande. Riprova con meno libri nella foto.');
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) parseLine(line);
    }
    signal?.throwIfAborted();
    buffer += decoder.decode();
    parseLine(buffer);
    if (!completed) throw new ApiError('La connessione si è interrotta. I risultati ricevuti sono conservati.', 502, 'INCOMPLETE_SCAN');
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function scanImage(image: PreparedImage, mode: 'shelf' | 'table', onEvent: (event: ScanEvent) => void, signal?: AbortSignal): Promise<void> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : AbortSignal.timeout(180_000);
  try {
    const response = await fetch('/api/scan', { method: 'POST', headers: headers(), body: JSON.stringify({ image: { data: image.data, mimeType: image.mimeType }, mode }), signal: requestSignal });
    await readScanStream(response, onEvent, requestSignal);
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    if (requestSignal.aborted) throw new ApiError('L’analisi ha impiegato troppo tempo. I risultati ricevuti sono conservati. Prova una foto più ravvicinata.', 504, 'SCAN_TIMEOUT');
    throw new ApiError('Connessione non disponibile. Controlla la rete e riprova; i risultati ricevuti sono conservati.');
  }
}

export async function searchCatalog(query: string, signal?: AbortSignal): Promise<CatalogCandidate[]> {
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  try {
    const response = await fetch('/api/search', { method: 'POST', headers: headers(), body: JSON.stringify({ query }), signal: requestSignal });
    if (!response.ok) return await responseError(response);
    const result = z.object({ candidates: z.array(candidateSchema).max(30) }).safeParse(await response.json().catch(() => null));
    if (!result.success) throw new ApiError('Il catalogo ha restituito dati non leggibili. Riprova tra poco.', 502, 'INVALID_CATALOG');
    return result.data.candidates;
  } catch (error) {
    if (signal?.aborted || error instanceof ApiError) throw error;
    if (requestSignal.aborted) throw new ApiError('La ricerca ha impiegato troppo tempo. Riprova tra poco o inserisci i dati a mano.', 504, 'SEARCH_TIMEOUT');
    throw new ApiError('Connessione non disponibile. Controlla la rete e riprova, oppure inserisci i dati a mano.', 0, 'NETWORK_ERROR');
  }
}
