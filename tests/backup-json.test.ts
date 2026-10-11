import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureStorage, exportBackup, importBackup, importLocalSessions, loadLocalSessions, loadSessions, parseBackup, saveSession } from '../src/lib/storage';
import { createDemoSession } from '../src/lib/demo';

afterEach(() => { configureStorage({ mode: 'local' }); vi.unstubAllGlobals(); });

describe('portable catalogue backups', () => {
  it('preserves a legacy version-one IndexedDB database during the schema upgrade', async () => {
    const legacy = createDemoSession();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('jemiq', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'id' });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(legacy);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect((await loadLocalSessions()).some((session) => session.id === legacy.id)).toBe(true);
  });

  it('round-trips photos, edition candidates, warning notes and demo markers', () => {
    const session = { ...createDemoSession(), image: 'data:image/jpeg;base64,/9j/2Q==', warnings: ['Analisi interrotta.'] };
    const restored = parseBackup(exportBackup([session])).sessions[0];
    expect(restored).toEqual(session);
    expect(restored.books[0].candidates).not.toHaveLength(0);
  });

  it('validates the entire import before any writes and rejects unknown formats and unsafe photo content', async () => {
    const first = createDemoSession();
    const valid = JSON.parse(exportBackup([first, createDemoSession()]));
    valid.sessions[1].books[0].quantity = -1;
    expect(() => importBackup(JSON.stringify(valid))).toThrow('backup Jemiq');
    expect((await loadSessions()).some((session) => session.id === first.id)).toBe(false);
    expect(() => parseBackup('{"version":99,"sessions":[]}')).toThrow('compatibile');
    expect(() => parseBackup('not json')).toThrow('JSON');
    expect(() => exportBackup([{ ...first, image: 'data:image/svg+xml;base64,PHN2Zz4=' }])).toThrow('JPEG');
  });

  it('imports collisions as independent copies and never overwrites the existing catalogue', async () => {
    const original = createDemoSession();
    await saveSession(original);
    const result = await importBackup(exportBackup([{ ...original, name: 'Imported edit' }, { ...original, name: 'Second imported edit' }]));
    expect(result.imported).toBe(2);
    expect(result.renamed).toBe(2);
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(2);
    expect(result.sessions.every((session) => session.id !== original.id)).toBe(true);
    expect((await loadSessions()).find((session) => session.id === original.id)?.name).toBe(original.name);
  });

  it('uses new IDs for concurrent imports even when the original ID is not in the destination', async () => {
    const original = createDemoSession();
    const text = exportBackup([original]);
    const [first, second] = await Promise.all([importBackup(text), importBackup(text)]);
    expect(first.sessions[0].id).not.toBe(second.sessions[0].id);
    expect(first.sessions[0].id).not.toBe(original.id);
  });

  it('does not migrate legacy sessions automatically and retains access errors from explicit migration', async () => {
    const legacy = createDemoSession();
    configureStorage({ mode: 'local' });
    await saveSession(legacy);
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      calls.push(init?.method ?? 'GET');
      if (String(url) === '/api/catalogs') return Response.json({ catalogs: [] });
      return Response.json({ error: 'Accedi di nuovo.', code: 'UNAUTHORIZED' }, { status: 401 });
    }));
    configureStorage({ mode: 'cloud', ownerId: crypto.randomUUID() });
    expect(await loadSessions()).toEqual([]);
    expect(calls).toEqual(['GET']);
    await expect(importLocalSessions()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect((await loadLocalSessions()).some((session) => session.id === legacy.id)).toBe(true);
  });
});
