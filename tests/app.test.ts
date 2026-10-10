import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app.js';
import { CatalogError } from '../server/catalog.js';
import { VisionError } from '../server/vision.js';
import type { BookRecord, CatalogCandidate, Observation, ScanEvent } from '../shared/types.js';

type AppOptions = Parameters<typeof createApp>[0];
const servers = new Set<Server>();
const accessToken = 'test-access-code-123456789';
const authorized = { Authorization: `Bearer ${accessToken}` };
const image = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==',
};
const scan = { image, mode: 'shelf' };
const observations: Observation[] = ['Il nome della rosa', 'Le città invisibili', 'Il barone rampante'].map((title, index) => ({
  title, authors: [], visibleIsbn: null, publisher: null, language: 'it', evidence: title,
  position: `Libro ${index + 1}`, confidence: 'high', boundingBox: null,
}));

function record(observation: Observation, index = 0): BookRecord {
  return {
    id: `book-${index}`, observation, title: observation.title ?? 'Libro da identificare', authors: observation.authors,
    isbn13: null, publisher: null, publishedDate: null, language: 'it', pageCount: null, thumbnail: null,
    source: null, sourceUrl: null, status: 'unresolved', candidates: [], notes: '', quantity: 1, selected: true,
  };
}
const candidate: CatalogCandidate = {
  id: 'google:example', title: 'Il nome della rosa', authors: ['Umberto Eco'], isbn13: null,
  publisher: 'Bompiani', publishedDate: null, language: 'it', pageCount: null, thumbnail: null,
  source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=example', score: 1,
  matchReason: 'Edizione da confermare.',
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function launch(options: Partial<AppOptions> = {}) {
  const recognize = vi.fn<AppOptions['recognize']>().mockResolvedValue({ observations: [], warnings: [] });
  const enrich = vi.fn<AppOptions['catalog']['enrich']>().mockImplementation(async (observation) => record(observation));
  const search = vi.fn<AppOptions['catalog']['search']>().mockResolvedValue([candidate]);
  const server = createServer(createApp({ recognitionReady: true, recognize, catalog: { enrich, search }, ...options }));
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (path: string, payload: unknown, init: RequestInit = {}) => fetch(baseUrl + path, {
    method: 'POST', body: JSON.stringify(payload), ...init,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(init.headers).entries()) },
    signal: init.signal ?? AbortSignal.timeout(3000),
  });
  return { baseUrl, post, recognize, enrich, search };
}

async function allEvents(response: Response): Promise<ScanEvent[]> {
  return (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as ScanEvent);
}

async function* streamEvents(response: Response): AsyncGenerator<ScanEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n');
      while (boundary >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line) yield JSON.parse(line) as ScanEvent;
        boundary = buffer.indexOf('\n');
      }
    }
  } finally { reader.releaseLock(); }
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  servers.clear();
  vi.restoreAllMocks();
});

describe('HTTP access and validation', () => {
  it('reports missing recognition configuration and allows catalogue search without an AI key', async () => {
    const app = await launch({ recognitionReady: false });
    const health = await fetch(app.baseUrl + '/api/health');
    expect(await health.json()).toEqual({ recognitionReady: false, accessRequired: false });
    expect(health.headers.get('cache-control')).toBe('no-store');
    const response = await app.post('/api/scan', scan);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'RECOGNITION_NOT_CONFIGURED' });
    expect(app.recognize).not.toHaveBeenCalled();
    const search = await app.post('/api/search', { query: 'Umberto Eco' });
    expect(search.status).toBe(200);
    expect(await search.json()).toEqual({ candidates: [candidate] });
  });

  it.each([undefined, '', 'too-short'])('fails closed in production with missing or inadequate access token (%s)', async (token) => {
    const app = await launch({ production: true, accessToken: token });
    const health = await fetch(app.baseUrl + '/api/health');
    expect(await health.json()).toEqual({ recognitionReady: false, accessRequired: true });
    for (const [path, payload] of [['/api/scan', scan], ['/api/search', { query: 'Umberto Eco' }]] as const) {
      const response = await app.post(path, payload);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'ACCESS_NOT_CONFIGURED' });
    }
    expect(app.recognize).not.toHaveBeenCalled();
    expect(app.search).not.toHaveBeenCalled();
  });

  it.each(['/api/scan', '/api/search'])('requires authentication before accessing %s', async (path) => {
    const app = await launch({ production: true, accessToken });
    const response = await app.post(path, path === '/api/scan' ? scan : { query: 'Umberto Eco' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'ACCESS_REQUIRED' });
    expect(app.recognize).not.toHaveBeenCalled();
    expect(app.search).not.toHaveBeenCalled();
    const denied = await app.post(path, scan, { headers: { Authorization: 'Bearer incorrect-code' } });
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(accessToken);
  });

  it('accepts the correct token without exposing it in health or results', async () => {
    const app = await launch({ production: true, accessToken });
    const response = await app.post('/api/scan', scan, { headers: authorized });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-powered-by')).toBeNull();
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('permissions-policy')).toContain('camera=(self)');
    expect((await allEvents(response)).at(-1)?.type).toBe('done');
    expect(app.recognize).toHaveBeenCalledOnce();
    expect(await (await fetch(app.baseUrl + '/api/health')).text()).not.toContain(accessToken);
  });

  it.each<Record<string, string>>([
    { Origin: 'https://unrelated.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])('rejects a cross-site request even with a correct token', async (crossSiteHeaders) => {
    const app = await launch({ production: true, accessToken });
    const response = await app.post('/api/scan', scan, { headers: { ...authorized, ...crossSiteHeaders } });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'ORIGIN_FORBIDDEN' });
    expect(app.recognize).not.toHaveBeenCalled();
  });

  it('accepts the configured public origin behind a proxy', async () => {
    const app = await launch({ production: true, accessToken, origin: 'https://jemiq.example' });
    const response = await app.post('/api/scan', scan, { headers: { ...authorized, Origin: 'https://jemiq.example' } });
    expect(response.status).toBe(200);
    expect((await allEvents(response)).at(-1)?.type).toBe('done');
  });

  it('rejects malformed JSON before invoking recognition', async () => {
    const app = await launch();
    const response = await app.post('/api/scan', {}, { body: '{"image":' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_JSON' });
    expect(app.recognize).not.toHaveBeenCalled();
  });

  it.each([
    {}, { ...scan, mode: 'unknown' }, { ...scan, image: { mimeType: 'text/html', data: 'x' } },
    { ...scan, image: { ...image, url: 'https://untrusted.example/photo' } },
    { ...scan, apiKey: 'client-supplied-secret' }, { ...scan, image: { ...image, data: '' } },
  ])('rejects invalid scan payloads before invoking recognition', async (payload) => {
    const app = await launch();
    const response = await app.post('/api/scan', payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_REQUEST' });
    expect(app.recognize).not.toHaveBeenCalled();
  });

  it('rejects an oversized HTTP body before invoking recognition', async () => {
    const app = await launch();
    const response = await app.post('/api/scan', { ...scan, image: { ...image, data: 'x'.repeat(12 * 1024 * 1024) } });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    expect(app.recognize).not.toHaveBeenCalled();
  });

  it.each([{ query: ' ' }, { query: 'x' }, { query: 'x'.repeat(241) }, { query: 'Eco', extra: true }])('rejects invalid manual-search requests', async (payload) => {
    const app = await launch();
    const response = await app.post('/api/search', payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'INVALID_QUERY' });
    expect(app.search).not.toHaveBeenCalled();
  });

  it('returns sanitized JSON for unknown API paths and unexpected search failures', async () => {
    const app = await launch();
    const missing = await app.post('/api/unknown', {});
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'NOT_FOUND' });
    app.search.mockRejectedValue(new Error('SECRET database-connection credential=private'));
    const response = await app.post('/api/search', { query: 'Umberto Eco' });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toMatch(/SECRET|credential|database-connection/);
  });

  it('distinguishes an unavailable catalogue from a successful search with no results', async () => {
    const app = await launch();
    app.search.mockRejectedValueOnce(new CatalogError()).mockResolvedValueOnce([]);
    const failed = await app.post('/api/search', { query: 'Umberto Eco' });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
    const empty = await app.post('/api/search', { query: 'Libro non presente' });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ candidates: [] });
  });
});

describe('progressive scanning over real HTTP', () => {
  it('streams the first book while other lookups are still pending, then completes all three', async () => {
    const app = await launch({ enrichmentConcurrency: 2 });
    const gates = observations.map(() => deferred<BookRecord>());
    const poolStarted = deferred<void>();
    app.recognize.mockResolvedValue({ observations, warnings: ['Controlla i dorsi in ombra.'] });
    app.enrich.mockImplementation((observation) => {
      const index = observations.indexOf(observation);
      if (app.enrich.mock.calls.length === 2) poolStarted.resolve();
      return gates[index].promise;
    });
    const response = await app.post('/api/scan', scan);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const events = streamEvents(response);
    expect((await events.next()).value).toMatchObject({ type: 'stage', stage: 'recognizing' });
    expect((await events.next()).value).toEqual({ type: 'observations', total: 3, warnings: ['Controlla i dorsi in ombra.'] });
    expect((await events.next()).value).toMatchObject({ type: 'stage', stage: 'enriching' });
    await poolStarted.promise;
    expect(app.enrich).toHaveBeenCalledTimes(2);
    gates[0].resolve(record(observations[0], 0));
    const firstBook = (await events.next()).value;
    expect(firstBook).toMatchObject({ type: 'book', book: { id: 'book-0' }, completed: 1, total: 3 });
    // Only now release the other two: the first row really arrived before the batch completed.
    gates[1].resolve(record(observations[1], 1));
    gates[2].resolve(record(observations[2], 2));
    const remaining: ScanEvent[] = [];
    for await (const event of events) remaining.push(event);
    const books = [firstBook, ...remaining].filter((event): event is Extract<ScanEvent, { type: 'book' }> => !!event && event.type === 'book');
    expect(books.map((event) => event.completed)).toEqual([1, 2, 3]);
    expect(new Set(books.map((event) => event.book.id)).size).toBe(3);
    expect(remaining.at(-1)).toMatchObject({ type: 'done', warnings: ['Controlla i dorsi in ombra.'] });
    expect(app.recognize).toHaveBeenCalledOnce();
    expect(app.enrich).toHaveBeenCalledTimes(3);
  });

  it('preserves an emitted row on later failure, sanitizes the error, and releases admission', async () => {
    const app = await launch({ enrichmentConcurrency: 1, maxConcurrentScans: 1 });
    app.recognize.mockResolvedValueOnce({ observations, warnings: [] });
    app.enrich.mockResolvedValueOnce(record(observations[0])).mockRejectedValueOnce(new Error('SECRET internal-catalog-state'));
    const response = await app.post('/api/scan', scan);
    const events = await allEvents(response);
    expect(events.filter((event) => event.type === 'book')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SCAN_FAILED' });
    expect(JSON.stringify(events)).not.toContain('SECRET');
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const next = await app.post('/api/scan', scan);
    expect(next.status).toBe(200);
    expect((await allEvents(next)).at(-1)?.type).toBe('done');
  });

  it('preserves actionable safe recognition errors after the stream has started', async () => {
    const app = await launch();
    app.recognize.mockRejectedValue(new VisionError('VISION_RATE_LIMIT', 'Attendi un minuto e riprova.', 429));
    const response = await app.post('/api/scan', scan);
    expect(response.status).toBe(200);
    expect(await allEvents(response)).toEqual([
      expect.objectContaining({ type: 'stage', stage: 'recognizing' }),
      { type: 'error', code: 'VISION_RATE_LIMIT', error: 'Attendi un minuto e riprova.' },
    ]);
    expect(app.enrich).not.toHaveBeenCalled();
  });

  it('aborts upstream work on client disconnection and permits a subsequent scan', async () => {
    const app = await launch({ maxConcurrentScans: 1 });
    const started = deferred<void>();
    const aborted = deferred<void>();
    let upstreamSignal: AbortSignal | undefined;
    app.recognize.mockImplementationOnce((_image, _mode, signal) => {
      upstreamSignal = signal;
      started.resolve();
      return new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
        aborted.resolve(); reject(signal.reason);
      }, { once: true }));
    });
    const controller = new AbortController();
    const response = await app.post('/api/scan', scan, { signal: controller.signal });
    await started.promise;
    const assertion = expect(response.text()).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    await aborted.promise;
    expect(upstreamSignal?.aborted).toBe(true);
    const next = await app.post('/api/scan', scan);
    expect(next.status).toBe(200);
    expect((await allEvents(next)).at(-1)?.type).toBe('done');
  });

  it('enforces the scan deadline and releases capacity even when recognition ignores cancellation', async () => {
    const app = await launch({ scanDeadlineMs: 35, maxConcurrentScans: 1 });
    let upstreamSignal: AbortSignal | undefined;
    app.recognize.mockImplementationOnce((_image, _mode, signal) => {
      upstreamSignal = signal;
      return new Promise(() => undefined);
    });
    const response = await app.post('/api/scan', scan);
    const events = await allEvents(response);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SCAN_INTERRUPTED' });
    expect(upstreamSignal?.aborted).toBe(true);
    const next = await app.post('/api/scan', scan);
    expect(next.status).toBe(200);
    expect((await allEvents(next)).at(-1)?.type).toBe('done');
  });

  it('bounds a stalled enrichment while retaining previously emitted books', async () => {
    const app = await launch({ scanDeadlineMs: 35, enrichmentConcurrency: 1, maxConcurrentScans: 1 });
    app.recognize.mockResolvedValueOnce({ observations, warnings: [] });
    app.enrich.mockResolvedValueOnce(record(observations[0])).mockImplementationOnce(() => new Promise(() => undefined));
    const events = await allEvents(await app.post('/api/scan', scan));
    expect(events.filter((event) => event.type === 'book')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'SCAN_INTERRUPTED' });
    expect(events.some((event) => event.type === 'done')).toBe(false);
    const next = await app.post('/api/scan', scan);
    expect(next.status).toBe(200);
    expect((await allEvents(next)).at(-1)?.type).toBe('done');
  });

  it('blocks simultaneous scans from one client while permitting a different client within capacity', async () => {
    const app = await launch({ trustProxy: 1, maxConcurrentScans: 2 });
    const gate = deferred<{ observations: Observation[]; warnings: string[] }>();
    app.recognize.mockImplementationOnce(() => gate.promise);
    const headers = { 'X-Forwarded-For': '192.0.2.1' };
    const first = await app.post('/api/scan', scan, { headers });
    const duplicate = await app.post('/api/scan', scan, { headers });
    expect(duplicate.status).toBe(429);
    expect(await duplicate.json()).toMatchObject({ code: 'SCAN_BUSY' });
    const other = await app.post('/api/scan', scan, { headers: { 'X-Forwarded-For': '192.0.2.2' } });
    expect(other.status).toBe(200);
    expect((await allEvents(other)).at(-1)?.type).toBe('done');
    gate.resolve({ observations: [], warnings: [] });
    expect((await allEvents(first)).at(-1)?.type).toBe('done');
    expect(app.recognize).toHaveBeenCalledTimes(2);
  });

  it('honors the global concurrency cap and releases it after a failed scan', async () => {
    const app = await launch({ trustProxy: 1, maxConcurrentScans: 1 });
    const gate = deferred<{ observations: Observation[]; warnings: string[] }>();
    app.recognize.mockImplementationOnce(() => gate.promise);
    const first = await app.post('/api/scan', scan, { headers: { 'X-Forwarded-For': '192.0.2.1' } });
    const other = await app.post('/api/scan', scan, { headers: { 'X-Forwarded-For': '192.0.2.2' } });
    expect(other.status).toBe(429);
    expect(await other.json()).toMatchObject({ code: 'SCAN_BUSY' });
    gate.reject(new Error('Test dependency failure'));
    expect((await allEvents(first)).at(-1)?.type).toBe('error');
    const next = await app.post('/api/scan', scan, { headers: { 'X-Forwarded-For': '192.0.2.2' } });
    expect(next.status).toBe(200);
    expect((await allEvents(next)).at(-1)?.type).toBe('done');
  });
});

describe('HTTP rate limits and manual search cancellation', () => {
  it('limits repeated incorrect access codes before any paid operation', async () => {
    const app = await launch({ production: true, accessToken });
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await app.post('/api/scan', scan);
      expect(response.status).toBe(401);
      await response.text();
    }
    const blocked = await app.post('/api/scan', scan);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'ACCESS_RATE_LIMIT' });
    expect(app.recognize).not.toHaveBeenCalled();
    const correct = await app.post('/api/scan', scan, { headers: authorized });
    expect(correct.status).toBe(200);
    await allEvents(correct);
  });

  it('enforces the per-client scan budget and allows scanning after its window resets', async () => {
    const app = await launch();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    for (let count = 0; count < 20; count++) {
      const response = await app.post('/api/scan', scan);
      expect(response.status).toBe(200);
      await allEvents(response);
    }
    const blocked = await app.post('/api/scan', scan);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'SCAN_RATE_LIMIT' });
    expect(app.recognize).toHaveBeenCalledTimes(20);
    vi.mocked(Date.now).mockReturnValue(now + 10 * 60_000 + 1);
    const next = await app.post('/api/scan', scan);
    expect(next.status).toBe(200);
    await allEvents(next);
    expect(app.recognize).toHaveBeenCalledTimes(21);
  });

  it('enforces a shared paid-request budget across different client addresses', async () => {
    const app = await launch({ trustProxy: 1 });
    for (let count = 1; count <= 100; count++) {
      const response = await app.post('/api/scan', scan, { headers: { 'X-Forwarded-For': `192.0.2.${count}` } });
      expect(response.status).toBe(200);
      await allEvents(response);
    }
    const blocked = await app.post('/api/scan', scan, { headers: { 'X-Forwarded-For': '192.0.2.101' } });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'SCAN_RATE_LIMIT' });
    expect(app.recognize).toHaveBeenCalledTimes(100);
  });

  it('rate-limits manual searches before consulting a catalogue', async () => {
    const app = await launch();
    for (let count = 0; count < 100; count++) {
      const response = await app.post('/api/search', { query: 'Umberto Eco' });
      expect(response.status).toBe(200);
      await response.json();
    }
    const blocked = await app.post('/api/search', { query: 'Umberto Eco' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ code: 'SEARCH_RATE_LIMIT' });
    expect(app.search).toHaveBeenCalledTimes(100);
  });

  it('aborts manual catalogue search when the requesting client disconnects', async () => {
    const app = await launch();
    const started = deferred<void>();
    const aborted = deferred<void>();
    let upstreamSignal: AbortSignal | undefined;
    app.search.mockImplementationOnce((_query, signal) => {
      upstreamSignal = signal;
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      started.resolve();
      return new Promise(() => undefined);
    });
    const controller = new AbortController();
    const result = app.post('/api/search', { query: 'Umberto Eco' }, { signal: controller.signal });
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    await started.promise;
    controller.abort();
    await assertion;
    await aborted.promise;
    expect(upstreamSignal?.aborted).toBe(true);
    const next = await app.post('/api/search', { query: 'Italo Calvino' });
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual({ candidates: [candidate] });
  });
});
