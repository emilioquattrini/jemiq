import 'fake-indexeddb/auto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureStorage, createBackup, loadSession, loadSessions, loadLocalSessions, saveSession, deleteSession, parseBackup, type StorageStatus } from '../src/lib/storage';
import { createDemoSession } from '../src/lib/demo';
import { setAccessToken } from '../src/lib/api';
import { createFileCatalogStore } from '../server/storage/file';
import { StorageError } from '../server/storage/contracts';

const PHOTO = 'data:image/jpeg;base64,/9j/2Q==';
const directories: string[] = [];
afterEach(async () => {
  configureStorage({ mode: 'local' });
  setAccessToken('');
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function cloudFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jemiq-client-store-'));
  directories.push(directory);
  const store = createFileCatalogStore({ directory });
  const owner = crypto.randomUUID();
  const states: StorageStatus[] = [];
  const calls: Array<{ method: string; path: string; headers: Headers; body: Record<string, unknown> | null }> = [];
  const connection = { offline: false, unauthorized: false, getDelay: 0, failGet: '', active: 0, peak: 0,
    beforePut: null as (() => Promise<void>) | null };
  const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const path = String(url);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ method, path, headers, body });
    if (connection.offline) throw new TypeError('offline');
    if (connection.unauthorized) return Response.json({ error: 'Accedi di nuovo.', code: 'UNAUTHORIZED' }, { status: 401 });
    if (headers.get('X-Jemiq-Owner') !== owner) return Response.json({ error: 'Account cambiato.', code: 'OWNER_MISMATCH' }, { status: 403 });
    const id = decodeURIComponent(path.slice('/api/catalogs/'.length));
    try {
      if (path === '/api/catalogs') return Response.json({ catalogs: await store.list(owner) });
      if (method === 'GET') {
        connection.active++;
        connection.peak = Math.max(connection.peak, connection.active);
        try {
          if (connection.getDelay) await new Promise((resolve) => setTimeout(resolve, connection.getDelay));
          if (connection.failGet === id) return Response.json({ error: 'Foto non disponibile.', code: 'PHOTO_UNAVAILABLE' }, { status: 503 });
          const catalog = await store.get(owner, id);
          return catalog ? Response.json({ catalog }) : Response.json({ error: 'Non trovato.', code: 'NOT_FOUND' }, { status: 404 });
        } finally { connection.active--; }
      }
      if (method === 'PUT') {
        await connection.beforePut?.();
        const catalog = await store.put(owner, body!.catalog as never, {
          expectedUpdatedAt: body!.expectedUpdatedAt as string | null, preservePhoto: body!.preservePhoto as boolean,
        });
        return Response.json({ catalog });
      }
      if (method === 'DELETE') { await store.delete(owner, id); return new Response(null, { status: 204 }); }
      return new Response(null, { status: 405 });
    } catch (error) {
      if (error instanceof StorageError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
      throw error;
    }
  });
  vi.stubGlobal('fetch', transport);
  configureStorage({ mode: 'cloud', ownerId: owner, onStatus: (state) => states.push(state) });
  return { owner, store, connection, calls, states, transport };
}

describe('local session persistence', () => {
  it('preserves edits through a reload and serializes rapid updates in order', async () => {
    const session = createDemoSession();
    await saveSession(session);
    const first = saveSession({ ...session, name: 'Modifica 1' });
    const second = saveSession({ ...session, name: 'Modifica 2', books: session.books.map(book => ({ ...book, quantity: 4 })) });
    await Promise.all([first, second]);
    const recovered = (await loadSessions()).find(item => item.id === session.id)!;
    expect(recovered.name).toBe('Modifica 2');
    expect(recovered.books[0].quantity).toBe(4);
    expect(recovered.isDemo).toBe(true);
    await deleteSession(session.id);
    expect((await loadSessions()).find(item => item.id === session.id)).toBeUndefined();
  });

  it('does not mutate a saved snapshot when the calling object is edited later', async () => {
    const session = createDemoSession();
    const saving = saveSession(session);
    session.name = 'Unsaved edit';
    session.books[0].title = 'Unsaved title';
    await saving;
    const loaded = (await loadSessions()).find(item => item.id === session.id)!;
    expect(loaded.name).not.toBe('Unsaved edit');
    expect(loaded.books[0].title).not.toBe('Unsaved title');
    await deleteSession(session.id);
  });
});

describe('owner-scoped cloud cache', () => {
  it('keeps legacy data local, loads photos on demand, and never exposes another owner cache', async () => {
    configureStorage({ mode: 'local' });
    const legacy = createDemoSession();
    await saveSession(legacy);
    const fixture = await cloudFixture();
    const remote = await fixture.store.put(fixture.owner, { ...createDemoSession(), image: PHOTO });
    expect((await loadSessions()).map((session) => session.id)).toEqual([remote.id]);
    expect(fixture.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect((await loadSession(remote.id))?.image).toBe(PHOTO);
    expect((await loadLocalSessions()).some((session) => session.id === legacy.id)).toBe(true);
    fixture.connection.offline = true;
    configureStorage({ mode: 'cloud', ownerId: 'another-owner' });
    expect(await loadSessions()).toEqual([]);
    configureStorage({ mode: 'cloud', ownerId: fixture.owner });
    expect((await loadSessions())[0].id).toBe(remote.id);
    expect((await loadSession(remote.id))?.image).toBe(PHOTO);
    configureStorage({ mode: 'local' });
    await deleteSession(legacy.id);
  });

  it('retains offline edits, rejects the cloud save, and syncs pending writes on the next load', async () => {
    const fixture = await cloudFixture();
    const session = { ...createDemoSession(), image: PHOTO };
    fixture.connection.offline = true;
    await expect(saveSession(session)).rejects.toMatchObject({ code: 'STORAGE_OFFLINE' });
    expect(fixture.states.at(-1)).toMatchObject({ state: 'offline', pending: 1 });
    expect((await loadSessions())[0].id).toBe(session.id);
    fixture.connection.offline = false;
    expect((await loadSessions())[0].image).toBe(PHOTO);
    expect((await fixture.store.get(fixture.owner, session.id))?.image).toBe(PHOTO);
    expect(fixture.states.at(-1)).toMatchObject({ state: 'synced', pending: 0 });
  });

  it('coalesces nearby edits using the latest server revision and avoids reuploading an unchanged photo', async () => {
    const fixture = await cloudFixture();
    setAccessToken('test-only-access-token');
    const session = { ...createDemoSession(), image: PHOTO };
    await saveSession(session);
    const initial = (await fixture.store.get(fixture.owner, session.id))!;
    await Promise.all([
      saveSession({ ...session, name: 'First edit' }),
      saveSession({ ...session, name: 'Latest edit' }),
    ]);
    const puts = fixture.calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(2);
    expect(puts[0].body?.expectedUpdatedAt).toBeNull();
    expect(puts[1].body?.expectedUpdatedAt).toBe(initial.updatedAt);
    expect(puts[1].body).toMatchObject({ preservePhoto: true, catalog: { image: null } });
    expect(puts[0].headers.get('Authorization')).toBe('Bearer test-only-access-token');
    expect(puts[0].headers.get('X-Jemiq-Owner')).toBe(fixture.owner);
    expect((await fixture.store.get(fixture.owner, session.id))?.name).toBe('Latest edit');
    expect((await loadSession(session.id))?.image).toBe(PHOTO);
  });

  it('persists the newest local edit during an in-flight PUT, then sends only the latest pending snapshot', async () => {
    const fixture = await cloudFixture();
    const session = { ...createDemoSession(), image: PHOTO };
    await saveSession(session);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    fixture.connection.beforePut = async () => { fixture.connection.beforePut = null; entered(); await gate; };
    const first = saveSession({ ...session, name: 'Already in flight' });
    await started;
    const middle = saveSession({ ...session, name: 'Intermediate draft' });
    const latest = saveSession({ ...session, name: 'Latest local draft' });
    try {
      // This must finish before the network acknowledgement, proving IndexedDB is not blocked by it.
      expect((await loadSession(session.id))?.name).toBe('Latest local draft');
      expect(fixture.calls.filter((call) => call.method === 'PUT')).toHaveLength(2);
    } finally { release(); }
    await Promise.all([first, middle, latest]);
    const puts = fixture.calls.filter((call) => call.method === 'PUT');
    expect(puts).toHaveLength(3);
    expect(puts[2].body?.expectedUpdatedAt).not.toBe(puts[1].body?.expectedUpdatedAt);
    expect(puts[2].body).toMatchObject({ preservePhoto: true, catalog: { name: 'Latest local draft', image: null } });
    expect((await fixture.store.get(fixture.owner, session.id))?.name).toBe('Latest local draft');
    expect((await loadSession(session.id))?.image).toBe(PHOTO);
    expect(fixture.states.at(-1)).toMatchObject({ state: 'synced', pending: 0 });
  });

  it('keeps a conflicting local edit without overwriting the newer server catalogue', async () => {
    const fixture = await cloudFixture();
    const session = createDemoSession();
    await saveSession(session);
    const remote = (await fixture.store.get(fixture.owner, session.id))!;
    await fixture.store.put(fixture.owner, { ...remote, name: 'Other device' }, { expectedUpdatedAt: remote.updatedAt });
    await expect(saveSession({ ...session, name: 'My local edit' })).rejects.toMatchObject({ status: 409 });
    expect((await loadSessions())[0].name).toBe('My local edit');
    expect((await fixture.store.get(fixture.owner, session.id))?.name).toBe('Other device');
    expect(fixture.states.at(-1)?.state).toBe('conflict');
  });

  it('rejects editing a list-only record before the photo is hydrated', async () => {
    const fixture = await cloudFixture();
    const remote = await fixture.store.put(fixture.owner, { ...createDemoSession(), image: PHOTO });
    const summary = (await loadSessions())[0];
    expect(summary.image).toBeNull();
    await expect(saveSession({ ...summary, name: 'Unsafe edit' })).rejects.toMatchObject({ code: 'CATALOG_NOT_LOADED' });
    expect(fixture.calls.some((call) => call.method === 'PUT')).toBe(false);
    expect((await fixture.store.get(fixture.owner, remote.id))?.image).toBe(PHOTO);
  });

  it('keeps failed deletes pending and removes them from the server after reconnecting', async () => {
    const fixture = await cloudFixture();
    const session = createDemoSession();
    await saveSession(session);
    fixture.connection.offline = true;
    await expect(deleteSession(session.id)).rejects.toMatchObject({ code: 'STORAGE_OFFLINE' });
    expect(await loadSessions()).toEqual([]);
    fixture.connection.offline = false;
    expect(await loadSessions()).toEqual([]);
    expect(await fixture.store.get(fixture.owner, session.id)).toBeNull();
  });

  it('propagates access failures rather than presenting stale data as an authenticated archive', async () => {
    const fixture = await cloudFixture();
    await saveSession(createDemoSession());
    fixture.connection.unauthorized = true;
    await expect(loadSessions()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(fixture.states.at(-1)?.state).toBe('error');
  });

  it('creates complete backups with at most two concurrent photo downloads', async () => {
    const fixture = await cloudFixture();
    for (let index = 0; index < 5; index++) await fixture.store.put(fixture.owner, { ...createDemoSession(), image: PHOTO });
    fixture.connection.getDelay = 5;
    const backup = parseBackup(await createBackup());
    expect(backup.sessions).toHaveLength(5);
    expect(backup.sessions.every((session) => session.image === PHOTO)).toBe(true);
    expect(fixture.connection.peak).toBe(2);
  });

  it('does not produce a backup with omitted photographs when one remote detail fails', async () => {
    const fixture = await cloudFixture();
    const remote = await fixture.store.put(fixture.owner, { ...createDemoSession(), image: PHOTO });
    fixture.connection.failGet = remote.id;
    await expect(createBackup()).rejects.toMatchObject({ status: 503, code: 'PHOTO_UNAVAILABLE' });
  });
});
