import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../server/app';
import { createStudioJobManager, type StudioJobManager } from '../server/studio-jobs';
import { StudioError } from '../server/studio-errors';
import { studioJobSchema, type StudioBrief, type StudioBriefInput, type StudioImage } from '../shared/studio';

type AppOptions = Parameters<typeof createApp>[0];
const accessToken = 'studio-http-private-access-code';
const authorized = { Authorization: 'Bearer ' + accessToken };
const headers = (cookie?: string) => ({ ...authorized, ...(cookie ? { Cookie: cookie } : {}) });
const servers = new Set<Server>();
const managers = new Set<StudioJobManager>();
const briefInput: StudioBriefInput = {
  book: { title: 'Le case del vento', authors: ['Ada Rossi'], isbn13: null, publisher: null, language: 'it', source: null, sourceUrl: null },
  style: 'atmospheric', readerNote: 'Sereno e raccolto.', mood: 'Sereno',
};
const brief: StudioBrief = {
  book: briefInput.book, style: briefInput.style, summary: 'Luce naturale su lino, spazio libero per il libro.',
  mood: 'Sereno', palette: ['#DDD5C7', '#7A856C'], elements: [{ id: 'one', label: 'Lino chiaro', basis: 'style' }],
  sources: [], warnings: [], basis: 'reader',
};
// Synthetic provider output for HTTP/job-store tests; actual image decoding has its own suite.
const image: StudioImage = { data: Buffer.from('synthetic image payload').toString('base64'), mimeType: 'image/png', width: 1024, height: 1536 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function launch(options: Partial<AppOptions> = {}) {
  const generate = vi.fn<(brief: StudioBrief, signal?: AbortSignal) => Promise<StudioImage>>().mockResolvedValue(image);
  const createBrief = vi.fn<(input: StudioBriefInput, signal?: AbortSignal) => Promise<StudioBrief>>().mockResolvedValue(brief);
  const jobs = createStudioJobManager({ generate, maxDurationMs: 5_000 });
  managers.add(jobs);
  const server = createServer(createApp({
    production: true, accessToken, recognitionReady: true,
    recognize: async () => ({ observations: [], warnings: [] }),
    catalog: { enrich: async () => { throw new Error('Unexpected catalogue call'); }, search: async () => [] },
    studio: { ready: true, createBrief, jobs }, ...options,
  }));
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test HTTP address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const post = (path: string, payload: unknown, init: RequestInit = {}) => fetch(baseUrl + path, {
    method: 'POST', body: JSON.stringify(payload), ...init,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(init.headers).entries()) },
    signal: init.signal ?? AbortSignal.timeout(3_000),
  });
  const get = (path: string, cookie?: string) => fetch(baseUrl + path, { headers: headers(cookie), signal: AbortSignal.timeout(3_000) });
  return { baseUrl, post, get, generate, createBrief, jobs };
}

async function session(app: Awaited<ReturnType<typeof launch>>, previousCookie?: string) {
  const response = await app.post('/api/studio/session', {}, { headers: headers(previousCookie) });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  return { cookie: setCookie!.split(';')[0], setCookie: setCookie! };
}

afterEach(async () => {
  for (const manager of managers) manager.dispose();
  managers.clear();
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
  servers.clear();
  vi.restoreAllMocks();
});

describe('Studio HTTP authorization and signed sessions', () => {
  it.each([undefined, '', 'too-short'])('reports Studio unavailable and fails closed without a production access code: %s', async (token) => {
    const app = await launch({ accessToken: token });
    const health = await fetch(app.baseUrl + '/api/health');
    expect(await health.json()).toEqual({ recognitionReady: false, accessRequired: true, studioReady: false });
    expect(health.headers.get('cache-control')).toBe('no-store');
    for (const [path, body] of [
      ['/api/studio/session', {}], ['/api/studio/brief', briefInput], ['/api/studio/jobs', { requestId: randomUUID(), brief }],
    ] as const) {
      const response = await app.post(path, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'ACCESS_NOT_CONFIGURED' });
    }
    expect(app.createBrief).not.toHaveBeenCalled();
    expect(app.generate).not.toHaveBeenCalled();
  });

  it.each(['/api/studio/session', '/api/studio/brief', '/api/studio/jobs'])('authenticates before doing any work at %s', async (path) => {
    const app = await launch();
    const response = await app.post(path, {});
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'ACCESS_REQUIRED' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(app.createBrief).not.toHaveBeenCalled();
    expect(app.generate).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([
    { Origin: 'https://other.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
  ])('rejects cross-origin Studio actions with valid authentication: %o', async (extra) => {
    const app = await launch({ origin: 'https://jemiq.example' });
    for (const [path, body] of [
      ['/api/studio/session', {}], ['/api/studio/brief', briefInput], ['/api/studio/jobs', { requestId: randomUUID(), brief }],
    ] as const) {
      const response = await app.post(path, body, { headers: { ...authorized, ...extra } });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'ORIGIN_FORBIDDEN' });
    }
    expect(app.createBrief).not.toHaveBeenCalled();
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('establishes a signed HttpOnly, Secure, same-site cookie and renews the same browser identity', async () => {
    const app = await launch({ origin: 'https://jemiq.example' });
    const response = await app.post('/api/studio/session', {}, { headers: { ...authorized, Origin: 'https://jemiq.example' } });
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^jemiq_studio=[a-f0-9]{32}\.[a-f0-9]{64};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/api/studio');
    const originalCookie = setCookie.split(';')[0];
    expect((await session(app, originalCookie)).cookie).toBe(originalCookie);
    expect((await session(app)).cookie).not.toBe(originalCookie);
    expect(setCookie).not.toContain(accessToken);
  });

  it.each([undefined, 'jemiq_studio=' + 'a'.repeat(32) + '.' + 'b'.repeat(64), 'jemiq_studio=broken'])('rejects missing or forged generation cookies before invoking AI: %s', async (cookie) => {
    const app = await launch();
    const response = await app.post('/api/studio/jobs', { requestId: randomUUID(), brief }, { headers: headers(cookie) });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_SESSION_REQUIRED' });
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('rejects a modified genuine signature and a cookie issued by a different app instance', async () => {
    const first = await launch();
    const second = await launch();
    const { cookie } = await session(first);
    const altered = cookie.slice(0, -1) + (cookie.endsWith('0') ? '1' : '0');
    for (const [app, value] of [[first, altered], [second, cookie]] as const) {
      const response = await app.post('/api/studio/jobs', { requestId: randomUUID(), brief }, { headers: headers(value) });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'STUDIO_SESSION_REQUIRED' });
      expect(app.generate).not.toHaveBeenCalled();
    }
  });

  it('keeps generation disabled when Studio is absent', async () => {
    const app = await launch({ studio: undefined });
    expect(await (await app.get('/api/health')).json()).toMatchObject({ studioReady: false });
    const response = await app.post('/api/studio/session', {}, { headers: authorized });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_NOT_CONFIGURED' });
    expect(app.generate).not.toHaveBeenCalled();
  });
});

describe('Studio HTTP job ownership, recovery and idempotency', () => {
  it('returns 202 for a new job and exposes the completed image through polling', async () => {
    const app = await launch();
    const gate = deferred<StudioImage>();
    app.generate.mockReturnValue(gate.promise);
    const { cookie } = await session(app);
    const requestId = randomUUID();
    const created = await app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(cookie) });
    expect(created.status).toBe(202);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const job = studioJobSchema.parse(await created.json());
    expect(job).toMatchObject({ id: requestId, requestId, status: 'running', image: null });
    expect(await (await app.get('/api/studio/jobs/' + job.id, cookie)).json()).toMatchObject({ status: 'running' });
    gate.resolve(image);
    await vi.waitFor(async () => {
      const response = await app.get('/api/studio/jobs/' + job.id, cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'completed', image, error: null });
    });
    expect(app.generate).toHaveBeenCalledOnce();
  });

  it('reserves only one generation for a repeated request UUID and rejects a changed brief with 409', async () => {
    const app = await launch();
    const gate = deferred<StudioImage>();
    app.generate.mockReturnValue(gate.promise);
    const { cookie } = await session(app);
    const requestId = randomUUID();
    const requests = await Promise.all(Array.from({ length: 3 }, () => app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(cookie) })));
    for (const response of requests) {
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ id: requestId, status: 'running' });
    }
    expect(app.generate).toHaveBeenCalledOnce();
    const conflict = await app.post('/api/studio/jobs', { requestId, brief: { ...brief, mood: 'Un altro mood' } }, { headers: headers(cookie) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'STUDIO_REQUEST_CONFLICT' });
    expect(app.generate).toHaveBeenCalledOnce();
    gate.resolve(image);
    await vi.waitFor(async () => expect((await app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(cookie) })).status).toBe(200));
    expect(app.generate).toHaveBeenCalledOnce();
  });

  it('does not let a different signed browser read or cancel a job even with the same access code', async () => {
    const app = await launch();
    const gate = deferred<StudioImage>();
    app.generate.mockReturnValue(gate.promise);
    const first = await session(app);
    const second = await session(app);
    const requestId = randomUUID();
    expect((await app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(first.cookie) })).status).toBe(202);
    const read = await app.get('/api/studio/jobs/' + requestId, second.cookie);
    expect(read.status).toBe(404);
    expect(await read.json()).toMatchObject({ code: 'STUDIO_JOB_NOT_FOUND' });
    const cancel = await app.post('/api/studio/jobs/' + requestId + '/cancel', {}, { headers: headers(second.cookie) });
    expect(cancel.status).toBe(404);
    expect(await cancel.json()).toMatchObject({ code: 'STUDIO_JOB_NOT_FOUND' });
    expect(await (await app.get('/api/studio/jobs/' + requestId, first.cookie)).json()).toMatchObject({ status: 'running' });
    expect(app.generate.mock.calls[0][1]?.aborted).toBe(false);
  });

  it('cancels the owner’s running request and ignores late completion without starting another generation', async () => {
    const app = await launch();
    const gate = deferred<StudioImage>();
    app.generate.mockReturnValue(gate.promise);
    const { cookie } = await session(app);
    const requestId = randomUUID();
    await app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(cookie) });
    const cancelled = await app.post('/api/studio/jobs/' + requestId + '/cancel', {}, { headers: headers(cookie) });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ status: 'cancelled', image: null });
    expect(app.generate.mock.calls[0][1]?.aborted).toBe(true);
    gate.resolve(image);
    const repeated = await app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(cookie) });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ status: 'cancelled', image: null });
    expect(app.generate).toHaveBeenCalledOnce();
  });

  it('redacts unexpected generation errors in poll results', async () => {
    const app = await launch();
    app.generate.mockRejectedValue(new Error('private-provider-key full-prompt internal-stack'));
    const { cookie } = await session(app);
    const requestId = randomUUID();
    await app.post('/api/studio/jobs', { requestId, brief }, { headers: headers(cookie) });
    const response = await app.get('/api/studio/jobs/' + requestId, cookie);
    const body = await response.text();
    expect(body).toContain('STUDIO_GENERATION_FAILED');
    expect(body).not.toMatch(/private-provider-key|full-prompt|internal-stack/);
    expect(app.generate).toHaveBeenCalledOnce();
  });

  it('bounds new generations while allowing recovery of an existing request without spending more quota', async () => {
    const app = await launch();
    const { cookie } = await session(app);
    let lastRequestId = '';
    for (let index = 0; index < 10; index++) {
      lastRequestId = randomUUID();
      const response = await app.post('/api/studio/jobs', { requestId: lastRequestId, brief }, { headers: headers(cookie) });
      expect(response.status).toBe(202);
    }
    const limited = await app.post('/api/studio/jobs', { requestId: randomUUID(), brief }, { headers: headers(cookie) });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'STUDIO_RATE_LIMIT' });
    for (let index = 0; index < 3; index++) {
      const recovered = await app.post('/api/studio/jobs', { requestId: lastRequestId, brief }, { headers: headers(cookie) });
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ status: 'completed' });
    }
    expect(app.generate).toHaveBeenCalledTimes(10);
  });
});

describe('Studio HTTP validation and brief limits', () => {
  it.each([
    {}, { ...briefInput, style: 'unknown' }, { ...briefInput, readerNote: 'x'.repeat(1201) },
    { ...briefInput, mood: 'x'.repeat(121) }, { ...briefInput, book: { ...briefInput.book, description: 'Client-forged synopsis' } },
    { ...briefInput, book: { ...briefInput.book, categories: ['Client-forged source'] } },
  ])('rejects invalid brief input before the text service: %o', async (body) => {
    const app = await launch();
    const response = await app.post('/api/studio/brief', body, { headers: authorized });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_INVALID_BRIEF_INPUT' });
    expect(app.createBrief).not.toHaveBeenCalled();
    expect(app.generate).not.toHaveBeenCalled();
  });

  it.each([
    { requestId: 'invalid', brief }, { requestId: randomUUID(), brief: { ...brief, palette: ['red'] } },
    { requestId: randomUUID(), brief: { ...brief, elements: Array.from({ length: 4 }, () => brief.elements[0]) } },
    { requestId: randomUUID(), brief, ownerId: 'client-chosen-owner' },
    { requestId: randomUUID(), brief, apiKey: 'client-secret' },
  ])('rejects invalid generation payloads and client-selected ownership before AI', async (body) => {
    const app = await launch();
    const { cookie } = await session(app);
    const response = await app.post('/api/studio/jobs', body, { headers: headers(cookie) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'STUDIO_INVALID_REQUEST' });
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON and invalid job IDs without exposing internals', async () => {
    const app = await launch();
    const { cookie } = await session(app);
    const malformed = await app.post('/api/studio/jobs', {}, { headers: headers(cookie), body: '{"secret":' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'INVALID_JSON' });
    for (const response of [await app.get('/api/studio/jobs/not-a-uuid', cookie), await app.post('/api/studio/jobs/not-a-uuid/cancel', {}, { headers: headers(cookie) })]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'STUDIO_INVALID_JOB' });
    }
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('returns a valid editable brief and redacts unexpected text-service failures', async () => {
    const app = await launch();
    const successful = await app.post('/api/studio/brief', briefInput, { headers: authorized });
    expect(successful.status).toBe(200);
    expect(await successful.json()).toEqual(brief);
    app.createBrief.mockRejectedValueOnce(new Error('private-text-key reader-note provider stack'));
    const failed = await app.post('/api/studio/brief', briefInput, { headers: authorized });
    expect(failed.status).toBe(500);
    const body = await failed.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toMatch(/private-text-key|reader-note|provider stack/);
    app.createBrief.mockRejectedValueOnce(new StudioError(429, 'STUDIO_TEST_LIMIT', 'Attendi e riprova.'));
    const known = await app.post('/api/studio/brief', briefInput, { headers: authorized });
    expect(known.status).toBe(429);
    expect(await known.json()).toEqual({ code: 'STUDIO_TEST_LIMIT', error: 'Attendi e riprova.' });
    expect(app.generate).not.toHaveBeenCalled();
  });

  it('limits brief requests in a fixed window before calling the service', async () => {
    const app = await launch();
    for (let index = 0; index < 30; index++) expect((await app.post('/api/studio/brief', briefInput, { headers: authorized })).status).toBe(200);
    const limited = await app.post('/api/studio/brief', briefInput, { headers: authorized });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'STUDIO_BRIEF_RATE_LIMIT' });
    expect(app.createBrief).toHaveBeenCalledTimes(30);
  });

  it('rejects a concurrent brief for the same client and frees admission when the caller disconnects', async () => {
    const app = await launch();
    let upstreamSignal: AbortSignal | undefined;
    app.createBrief.mockImplementationOnce((_input, signal) => {
      upstreamSignal = signal;
      return new Promise<StudioBrief>(() => undefined);
    });
    const controller = new AbortController();
    const pending = app.post('/api/studio/brief', briefInput, { headers: authorized, signal: controller.signal }).catch(error => error);
    await vi.waitFor(() => expect(app.createBrief).toHaveBeenCalledOnce());
    const busy = await app.post('/api/studio/brief', briefInput, { headers: authorized });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ code: 'STUDIO_BRIEF_BUSY' });
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    const retried = await app.post('/api/studio/brief', briefInput, { headers: authorized });
    expect(retried.status).toBe(200);
    expect(app.createBrief).toHaveBeenCalledTimes(2);
  });

  it('limits active briefs globally even when clients have different proxy IPs', async () => {
    const app = await launch({ trustProxy: 1 });
    app.createBrief.mockImplementation(() => new Promise<StudioBrief>(() => undefined));
    const controllers = [new AbortController(), new AbortController()];
    const pending = controllers.map((controller, index) => app.post('/api/studio/brief', briefInput, {
      headers: { ...authorized, 'X-Forwarded-For': `203.0.113.${index + 1}` }, signal: controller.signal,
    }).catch(error => error));
    await vi.waitFor(() => expect(app.createBrief).toHaveBeenCalledTimes(2));
    const busy = await app.post('/api/studio/brief', briefInput, { headers: { ...authorized, 'X-Forwarded-For': '203.0.113.3' } });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toMatchObject({ code: 'STUDIO_BRIEF_BUSY' });
    controllers.forEach(controller => controller.abort());
    await Promise.all(pending);
    expect(app.createBrief).toHaveBeenCalledTimes(2);
  });
});
