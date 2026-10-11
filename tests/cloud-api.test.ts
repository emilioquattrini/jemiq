import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchApp, type AppOptions, type RecognitionServices } from '../server/fetch-app';
import { createD1R2CatalogStore, type D1Database, type R2Bucket } from '../server/storage/d1-r2';
import { StorageError } from '../server/storage/contracts';
import { createD1Budget } from '../server/rate-limit';
import type { SettingsStatus } from '../server/settings';
import type { BookRecord, Observation, ScanEvent, ScanSession } from '../shared/types';

const ORIGIN = 'https://jemiq.example.test';
const ACCESS_TOKEN = 'test-only-service-token-never-a-real-secret';
const PHOTO = 'data:image/jpeg;base64,/9j/2Q==';
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

function storageFixture() {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  database.exec(readFileSync(new URL('../drizzle/0000_sudden_nightmare.sql', import.meta.url), 'utf8'));
  const db: D1Database = {
    prepare(sql) {
      let values: unknown[] = [];
      return {
        bind(...parameters) { values = parameters; return this; },
        async first<T>() { return database.prepare(sql).get(...values as never[]) as T ?? null; },
        async all<T>() { return { results: database.prepare(sql).all(...values as never[]) as T[], success: true }; },
        async run() { return { success: true, meta: { changes: Number(database.prepare(sql).run(...values as never[]).changes) } }; },
      };
    },
  };
  const photos = new Map<string, Uint8Array>();
  const bucket: R2Bucket = {
    async put(key, value) { photos.set(key, new Uint8Array(value)); },
    async get(key) {
      const value = photos.get(key);
      return value ? { size: value.length, async arrayBuffer() { return Uint8Array.from(value).buffer; } } : null;
    },
    async delete(key) { photos.delete(key); },
  };
  return { database, db, store: createD1R2CatalogStore({ db, bucket }) };
}

function services(ready = false): RecognitionServices {
  return {
    recognitionReady: ready,
    recognize: vi.fn(async () => ({ observations: [] as Observation[], warnings: [] as string[] })),
    checkVision: vi.fn(async () => ({ ready: true as const })),
    catalog: { enrich: vi.fn(async (observation: Observation) => book(observation)), search: vi.fn(async () => []) },
  };
}
function fixture(overrides: Partial<AppOptions> = {}) {
  const storage = storageFixture();
  const dependencies = services();
  const app = createFetchApp({ ...dependencies, authMode: 'platform', production: true, origin: ORIGIN, catalogStore: storage.store, ...overrides });
  return { ...storage, app, dependencies };
}
function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request(ORIGIN + path, {
    method, headers: { origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
  });
}
function catalog(name = 'Scaffale A'): ScanSession {
  return { id: 'same-catalog-id', name, createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', mode: 'shelf', image: null, books: [], warnings: [], isDemo: false };
}
function observation(title = 'Libro di prova'): Observation {
  return { title, authors: ['Autore di prova'], visibleIsbn: null, publisher: null, language: 'it', evidence: title, position: 'Primo libro', confidence: 'high', boundingBox: null };
}
function book(observed: Observation): BookRecord {
  return { id: observed.title!, observation: observed, title: observed.title!, authors: observed.authors, isbn13: null, publisher: null, publishedDate: null, language: 'it', pageCount: null, thumbnail: null, source: null, sourceUrl: null, status: 'unresolved', candidates: [], notes: '', quantity: 1, selected: true };
}
async function events(response: Response): Promise<ScanEvent[]> {
  return (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as ScanEvent);
}

describe('portable Fetch API authentication and owner isolation', () => {
  it('requires a trusted platform identity even when a client supplies owner headers or a valid service token', async () => {
    const { app, dependencies, store } = fixture({ accessToken: ACCESS_TOKEN });
    for (const [path, method, body] of [
      ['/api/catalogs', 'GET', undefined],
      ['/api/catalogs/same-catalog-id', 'PUT', { catalog: catalog() }],
      ['/api/search', 'POST', { query: 'libri' }],
      ['/api/vision/check', 'POST', {}],
      ['/api/settings', 'GET', undefined],
    ] as const) {
      const response = await app(request(path, method, body, { 'x-jemiq-owner': 'victim', 'x-user-id': 'victim', authorization: `Bearer ${ACCESS_TOKEN}` }), { clientId: 'test-client' });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: 'ACCESS_REQUIRED' });
    }
    expect(await store.list('victim')).toEqual([]);
    expect(dependencies.catalog.search).not.toHaveBeenCalled();
    expect(dependencies.recognize).not.toHaveBeenCalled();
    expect(dependencies.checkVision).not.toHaveBeenCalled();
  });

  it('keeps explicitly enabled operational tokens in the service owner instead of a client-selected account', async () => {
    const { app, store } = fixture({ accessToken: ACCESS_TOKEN, allowServiceToken: true });
    await store.put('real-owner', catalog('Privato'));
    const auth = { authorization: `Bearer ${ACCESS_TOKEN}` };
    const health = await app(request('/api/health', 'GET', undefined, { ...auth, 'x-jemiq-owner': 'real-owner' }));
    expect(await health.json()).toMatchObject({ ownerId: 'service' });
    const spoofed = await app(request('/api/catalogs', 'GET', undefined, { ...auth, 'x-jemiq-owner': 'real-owner' }));
    expect(spoofed.status).toBe(403);
    const own = await app(request('/api/catalogs', 'GET', undefined, { ...auth, 'x-jemiq-owner': 'service' }));
    expect(await own.json()).toEqual({ catalogs: [] });
    const foreignId = await app(request('/api/catalogs/same-catalog-id', 'GET', undefined, { ...auth, 'x-jemiq-owner': 'service' }));
    expect(foreignId.status).toBe(404);
  });

  it('exposes only the authenticated owner in health and resolves that owner’s services', async () => {
    const ownServices = services(true);
    const getServices = vi.fn(async () => ownServices);
    const { app } = fixture({ getServices, accessToken: ACCESS_TOKEN });
    const anonymous = await app(request('/api/health', 'GET', undefined, { 'x-jemiq-owner': 'victim' }));
    expect(await anonymous.json()).toEqual({ recognitionReady: false, accessRequired: true, authMode: 'platform', storageMode: 'cloud' });
    expect(getServices).not.toHaveBeenCalled();
    const own = await app(request('/api/health', 'GET', undefined, { 'x-jemiq-owner': 'victim' }), { ownerId: 'alice' });
    expect(await own.json()).toEqual({ recognitionReady: true, accessRequired: false, authMode: 'platform', storageMode: 'cloud', ownerId: 'alice' });
    expect(getServices).toHaveBeenCalledWith('alice');
    expect(own.headers.get('cache-control')).toBe('no-store');
    expect(own.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('rejects stale or spoofed catalog owner headers before any read or mutation', async () => {
    const { app, store } = fixture();
    await store.put('alice', catalog());
    const ownerHeaders: Array<Record<string, string>> = [{}, { 'x-jemiq-owner': 'alice' }];
    for (const headers of ownerHeaders) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const response = await app(request('/api/catalogs/same-catalog-id', method, method === 'PUT' ? { catalog: catalog('Sovrascritto') } : undefined, headers), { ownerId: 'bob' });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: 'OWNER_CHANGED' });
      }
    }
    expect((await store.get('alice', 'same-catalog-id'))?.name).toBe('Scaffale A');
    expect(await store.list('bob')).toEqual([]);
  });

  it('blocks cross-site writes even with valid platform context and matching owner header', async () => {
    const { app, store } = fixture();
    const externalHeaders: Array<Record<string, string>> = [{ origin: 'https://attacker.example.test' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of externalHeaders) {
      const response = await app(request('/api/catalogs/same-catalog-id', 'PUT', { catalog: catalog() }, { 'x-jemiq-owner': 'alice', ...headers }), { ownerId: 'alice' });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'ORIGIN_FORBIDDEN' });
    }
    expect(await store.list('alice')).toEqual([]);
  });
});

describe('catalogue HTTP persistence without any provider key', () => {
  it('supports create/list/read/update/delete for separate owners with the same catalog id', async () => {
    const { app, dependencies } = fixture();
    const call = (owner: string, path: string, method = 'GET', body?: unknown) => app(request(path, method, body, { 'x-jemiq-owner': owner }), { ownerId: owner });
    const created = await call('alice', '/api/catalogs/same-catalog-id', 'PUT', { catalog: { ...catalog(), image: PHOTO }, expectedUpdatedAt: null });
    expect(created.status).toBe(200);
    const first = (await created.json() as { catalog: ScanSession }).catalog;
    expect((await call('bob', '/api/catalogs/same-catalog-id', 'PUT', { catalog: catalog('Scaffale B'), expectedUpdatedAt: null })).status).toBe(200);
    const history = await call('alice', '/api/catalogs');
    expect(await history.json()).toMatchObject({ catalogs: [{ name: 'Scaffale A', image: null }] });
    const full = await call('alice', '/api/catalogs/same-catalog-id');
    expect(await full.json()).toMatchObject({ catalog: { image: PHOTO } });
    const changed = await call('alice', '/api/catalogs/same-catalog-id', 'PUT', { catalog: { ...first, name: 'Letti', image: null }, expectedUpdatedAt: first.updatedAt, preservePhoto: true });
    expect(changed.status).toBe(200);
    expect(await (await call('alice', '/api/catalogs/same-catalog-id')).json()).toMatchObject({ catalog: { name: 'Letti', image: PHOTO } });
    expect(await (await call('bob', '/api/catalogs/same-catalog-id')).json()).toMatchObject({ catalog: { name: 'Scaffale B' } });
    const removed = await call('alice', '/api/catalogs/same-catalog-id', 'DELETE');
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe('');
    expect((await call('alice', '/api/catalogs/same-catalog-id')).status).toBe(404);
    expect((await call('bob', '/api/catalogs/same-catalog-id')).status).toBe(200);
    expect(dependencies.recognize).not.toHaveBeenCalled();
    expect(dependencies.catalog.search).not.toHaveBeenCalled();
  });

  it('preserves the last valid revision on stale saves, malformed JSON and invalid catalog data', async () => {
    const { app, store } = fixture();
    const first = await store.put('alice', catalog());
    await store.put('alice', { ...first, name: 'Modifica recente' }, { expectedUpdatedAt: first.updatedAt });
    const headers = { 'x-jemiq-owner': 'alice' };
    const stale = await app(request('/api/catalogs/same-catalog-id', 'PUT', { catalog: { ...first, name: 'Vecchio' }, expectedUpdatedAt: first.updatedAt }, headers), { ownerId: 'alice' });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'CATALOG_CONFLICT' });
    for (const body of [
      { catalog: { ...first, id: 'another-id' } },
      { catalog: { ...first, books: [{}] } },
      { catalog: { ...first, image: 'https://attacker.example.test/photo.jpg' } },
      { catalog: first, ownerId: 'bob' },
    ]) expect((await app(request('/api/catalogs/same-catalog-id', 'PUT', body, headers), { ownerId: 'alice' })).status).toBe(400);
    const invalidJson = new Request(ORIGIN + '/api/catalogs/same-catalog-id', { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: '{"catalog":' });
    expect((await app(invalidJson, { ownerId: 'alice' })).status).toBe(400);
    expect((await store.get('alice', first.id))?.name).toBe('Modifica recente');
  });

  it('returns actionable known errors and redacts unexpected storage failures', async () => {
    const { store } = storageFixture();
    const list = vi.fn()
      .mockRejectedValueOnce(new StorageError(503, 'STORAGE_UNAVAILABLE', 'Archivio temporaneamente non disponibile.'))
      .mockRejectedValueOnce(new Error(`private-account@example.test provider-key=${ACCESS_TOKEN}`));
    const { app } = fixture({ catalogStore: { ...store, list } });
    const first = await app(request('/api/catalogs', 'GET', undefined, { 'x-jemiq-owner': 'alice' }), { ownerId: 'alice' });
    expect(first.status).toBe(503);
    expect(await first.json()).toEqual({ error: 'Archivio temporaneamente non disponibile.', code: 'STORAGE_UNAVAILABLE' });
    const second = await app(request('/api/catalogs', 'GET', undefined, { 'x-jemiq-owner': 'alice' }), { ownerId: 'alice' });
    expect(second.status).toBe(500);
    const body = await second.text();
    expect(body).toContain('INTERNAL_ERROR');
    expect(body).not.toContain(ACCESS_TOKEN);
    expect(body).not.toContain('private-account@example.test');
    expect(second.headers.get('cache-control')).toBe('no-store');
  });
});

describe('settings HTTP boundary', () => {
  const status: SettingsStatus = { configured: true, googleBooksConfigured: false, model: 'gemini-3.8-flash', source: 'saved', editable: true };

  it('uses the trusted owner for reads and verified updates without echoing submitted keys', async () => {
    const update = vi.fn(async () => status);
    const read = vi.fn(async () => status);
    const { app } = fixture({ settings: { editable: true, status: read, update } });
    const headers = { 'x-jemiq-owner': 'victim' };
    expect((await app(request('/api/settings', 'GET', undefined, headers), { ownerId: 'alice' })).status).toBe(200);
    expect(read).toHaveBeenCalledWith('alice');
    const response = await app(request('/api/settings', 'POST', { geminiApiKey: 'test-private-new-key', verify: true }, headers), { ownerId: 'alice' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(status);
    expect(update).toHaveBeenCalledWith('alice', { geminiApiKey: 'test-private-new-key', verify: true }, expect.any(AbortSignal));
  });

  it('requires explicit verification, respects read-only settings and redacts failed updates', async () => {
    const update = vi.fn(async () => { throw new Error('test-private-new-key account@example.test'); });
    const settingOptions = { editable: true, status: async () => status, update };
    const { app } = fixture({ settings: settingOptions });
    for (const body of [{ geminiApiKey: 'test-private-new-key' }, { geminiApiKey: 'test-private-new-key', verify: false }, { ownerId: 'victim', verify: true }]) {
      const response = await app(request('/api/settings', 'POST', body), { ownerId: 'alice' });
      expect(response.status).toBe(400);
    }
    expect(update).not.toHaveBeenCalled();
    const readOnly = fixture({ settings: { ...settingOptions, editable: false } }).app;
    expect((await readOnly(request('/api/settings', 'POST', { verify: true }), { ownerId: 'alice' })).status).toBe(403);
    expect(update).not.toHaveBeenCalled();
    const failure = await app(request('/api/settings', 'POST', { geminiApiKey: 'test-private-new-key', verify: true }), { ownerId: 'alice' });
    expect(failure.status).toBe(500);
    const body = await failure.text();
    expect(body).not.toContain('test-private-new-key');
    expect(body).not.toContain('account@example.test');
  });
});

describe('Fetch streaming and persistent request budgets', () => {
  it('keeps emitted books when a later enrichment fails and releases capacity for the next scan', async () => {
    const dependencies = services(true);
    dependencies.recognize = vi.fn(async () => ({ observations: [observation('Primo'), observation('Secondo')], warnings: [] }));
    dependencies.catalog.enrich = vi.fn()
      .mockResolvedValueOnce(book(observation('Primo')))
      .mockRejectedValueOnce(new Error(`private provider diagnostic ${ACCESS_TOKEN}`))
      .mockImplementation(async (value: Observation) => book(value));
    const { app } = fixture({ ...dependencies, maxConcurrentScans: 1, enrichmentConcurrency: 1 });
    const scan = () => app(request('/api/scan', 'POST', { image: { data: '/9j/2Q==', mimeType: 'image/jpeg' }, mode: 'shelf' }), { ownerId: 'alice' });
    const first = await events(await scan());
    expect(first.filter((event) => event.type === 'book')).toHaveLength(1);
    expect(first.at(-1)).toMatchObject({ type: 'error', code: 'SCAN_FAILED' });
    expect(JSON.stringify(first)).not.toContain(ACCESS_TOKEN);
    const second = await scan();
    expect(second.status).toBe(200);
    expect((await events(second)).at(-1)).toMatchObject({ type: 'done' });
  });

  it('aborts upstream and frees a scan slot even if its dependency ignores cancellation', async () => {
    let upstream: AbortSignal | undefined;
    const dependencies = services(true);
    dependencies.recognize = vi.fn()
      .mockImplementationOnce((_image: unknown, _mode: unknown, signal: AbortSignal) => {
        upstream = signal;
        return new Promise(() => undefined);
      })
      .mockResolvedValue({ observations: [], warnings: [] });
    const { app } = fixture({ ...dependencies, maxConcurrentScans: 1 });
    const body = { image: { data: '/9j/2Q==', mimeType: 'image/jpeg' }, mode: 'shelf' };
    const response = await app(request('/api/scan', 'POST', body), { ownerId: 'alice' });
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.resolve();
    expect(upstream?.aborted).toBe(true);
    const next = await app(request('/api/scan', 'POST', body), { ownerId: 'alice' });
    expect(next.status).toBe(200);
    expect((await events(next)).at(-1)).toMatchObject({ type: 'done' });
  });

  it('never starts recognition if persistent budget storage fails', async () => {
    const dependencies = services(true);
    const { app } = fixture({ ...dependencies, budget: { async take() { throw new Error(`D1 connection token=${ACCESS_TOKEN}`); } } });
    const response = await app(request('/api/scan', 'POST', { image: { data: '/9j/2Q==', mimeType: 'image/jpeg' }, mode: 'shelf' }), { ownerId: 'alice' });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(ACCESS_TOKEN);
    expect(dependencies.recognize).not.toHaveBeenCalled();
  });

  it('shares atomic D1 limits across instances, separates owners and scopes, then resets the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
    const { db, database } = storageFixture();
    const first = createD1Budget(db);
    const second = createD1Budget(db);
    const concurrent = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).take('scan', 'private-owner@example.test', 5, 60_000)));
    expect(concurrent.filter(Boolean)).toHaveLength(5);
    expect(await second.take('scan', 'different-owner', 5, 60_000)).toBe(true);
    expect(await second.take('search', 'private-owner@example.test', 5, 60_000)).toBe(true);
    const persisted = database.prepare('SELECT key, count FROM request_budgets').all();
    expect(persisted).toHaveLength(3);
    expect(persisted.every((row) => /^[a-f\d]{64}$/.test(String(row.key)))).toBe(true);
    expect(JSON.stringify(persisted)).not.toContain('private-owner@example.test');
    vi.advanceTimersByTime(60_000);
    expect(await createD1Budget(db).take('scan', 'private-owner@example.test', 5, 60_000)).toBe(true);
  });
});
