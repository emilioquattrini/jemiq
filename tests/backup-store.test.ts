import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoSession } from '../src/lib/demo';
import { createFileCatalogStore } from '../server/storage/file';
import { createD1R2CatalogStore, type D1Database, type R2Bucket } from '../server/storage/d1-r2';
import { MAX_PHOTO_BYTES, type CatalogStore } from '../server/storage/contracts';
import { prepareCatalog } from '../server/storage/codec';

const PHOTO = 'data:image/jpeg;base64,/9j/2Q==';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanup.splice(0)) await clean(); });

function d1Fixture(options: { beforeRun?: (sql: string) => Promise<void> } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE catalogs (owner_id TEXT NOT NULL, id TEXT NOT NULL, data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, photo_key TEXT, photo_mime TEXT, PRIMARY KEY(owner_id,id))');
  cleanup.push(async () => { database.close(); });
  const db: D1Database = {
    prepare(sql) {
      let values: unknown[] = [];
      return {
        bind(...parameters) { values = parameters; return this; },
        async first<T>() { return database.prepare(sql).get(...values as never[]) as T ?? null; },
        async all<T>() { return { results: database.prepare(sql).all(...values as never[]) as T[], success: true }; },
        async run() {
          await options.beforeRun?.(sql);
          return { success: true, meta: { changes: Number(database.prepare(sql).run(...values as never[]).changes) } };
        },
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
  return { db, bucket, photos, database, store: createD1R2CatalogStore({ db, bucket }) };
}

async function fileFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jemiq-catalog-store-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createFileCatalogStore({ directory }) };
}

describe.each(['file', 'D1/R2'] as const)('portable %s catalogue storage', (adapter) => {
  async function fixture(): Promise<CatalogStore> {
    return adapter === 'file' ? (await fileFixture()).store : d1Fixture().store;
  }
  it('isolates owner data and preserves complete photographs outside list records', async () => {
    const store = await fixture();
    const input = { ...createDemoSession(), image: PHOTO, id: '../../same-id' };
    const saved = await store.put('owner-a', input, { expectedUpdatedAt: null });
    expect((await store.get('owner-a', input.id))?.image).toBe(PHOTO);
    expect((await store.list('owner-a'))[0].image).toBeNull();
    expect(await store.get('owner-b', input.id)).toBeNull();
    expect(await store.list('owner-b')).toEqual([]);
    expect(await store.delete('owner-b', input.id)).toBe(false);
    await store.put('owner-b', { ...input, name: 'B' }, { expectedUpdatedAt: null });
    expect((await store.get('owner-a', input.id))?.name).toBe(saved.name);
    expect(await store.delete('owner-a', input.id)).toBe(true);
    expect(await store.get('owner-a', input.id)).toBeNull();
    expect((await store.get('owner-b', input.id))?.name).toBe('B');
  });

  it('protects creates and updates with compare-and-swap instead of overwriting concurrent edits', async () => {
    const store = await fixture();
    const input = createDemoSession();
    const first = await store.put('owner', input, { expectedUpdatedAt: null });
    await expect(store.put('owner', input, { expectedUpdatedAt: null })).rejects.toMatchObject({ status: 409, code: 'CATALOG_CONFLICT' });
    const results = await Promise.allSettled([
      store.put('owner', { ...first, name: 'Edit A' }, { expectedUpdatedAt: first.updatedAt }),
      store.put('owner', { ...first, name: 'Edit B' }, { expectedUpdatedAt: first.updatedAt }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const saved = await store.get('owner', input.id);
    expect(saved?.name).toBe('Edit A');
    expect(saved?.updatedAt).not.toBe(first.updatedAt);
    await store.delete('owner', input.id);
    await expect(store.put('owner', first, { expectedUpdatedAt: first.updatedAt })).rejects.toMatchObject({ status: 409 });
  });

  it('can preserve the existing photo for metadata changes and explicitly remove it', async () => {
    const store = await fixture();
    const first = await store.put('owner', { ...createDemoSession(), image: PHOTO }, { expectedUpdatedAt: null });
    const updated = await store.put('owner', { ...first, image: null, name: 'New name' }, { expectedUpdatedAt: first.updatedAt, preservePhoto: true });
    expect((await store.get('owner', first.id))?.image).toBe(PHOTO);
    await expect(store.put('owner', { ...updated, image: PHOTO }, { expectedUpdatedAt: updated.updatedAt, preservePhoto: true })).rejects.toMatchObject({ status: 409 });
    await store.put('owner', { ...updated, image: null }, { expectedUpdatedAt: updated.updatedAt });
    expect((await store.get('owner', first.id))?.image).toBeNull();
    await expect(store.put('owner', { ...createDemoSession(), image: null }, { expectedUpdatedAt: null, preservePhoto: true })).rejects.toMatchObject({ code: 'PHOTO_CONFLICT' });
  });

  it('rejects invalid identities, foreign photo URLs and oversized catalogue rows before writing', async () => {
    const store = await fixture();
    const input = createDemoSession();
    await expect(store.put('', input)).rejects.toMatchObject({ status: 401 });
    await expect(store.put('owner', { ...input, image: 'https://example.test/photo.jpg' })).rejects.toMatchObject({ code: 'INVALID_PHOTO' });
    const books = Array.from({ length: 700 }, (_, index) => ({ ...input.books[0], id: String(index), notes: 'é'.repeat(1800) }));
    await expect(store.put('owner', { ...input, books })).rejects.toMatchObject({ status: 413, code: 'CATALOG_TOO_LARGE' });
    expect(await store.list('owner')).toEqual([]);
  });
});

describe('adapter durability and cleanup', () => {
  it('reopens Node files in a new instance and keeps image data out of metadata JSON', async () => {
    const { store, directory } = await fileFixture();
    const saved = await store.put('owner', { ...createDemoSession(), image: PHOTO });
    const reopened = createFileCatalogStore({ directory });
    expect(await reopened.get('owner', saved.id)).toEqual(saved);
    const owners = await readdir(join(directory, 'records'));
    const files = await readdir(join(directory, 'records', owners[0]));
    const record = JSON.parse(await readFile(join(directory, 'records', owners[0], files[0]), 'utf8'));
    expect(JSON.parse(record.data_json).image).toBeNull();
    expect(record.photo_key).toMatch(/^catalogs\/[a-f\d]{64}\//);
    expect(JSON.stringify(record)).not.toContain('base64');
  });

  it('uses database CAS across two D1 adapter instances and cleans losing uploads', async () => {
    const fixture = d1Fixture();
    const second = createD1R2CatalogStore({ db: fixture.db, bucket: fixture.bucket });
    const input = { ...createDemoSession(), image: PHOTO };
    const results = await Promise.allSettled([
      fixture.store.put('owner', input, { expectedUpdatedAt: null }),
      second.put('owner', input, { expectedUpdatedAt: null }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fixture.photos.size).toBe(1);
    const row = fixture.database.prepare('SELECT data_json FROM catalogs').get()!;
    expect(JSON.parse(String(row.data_json)).image).toBeNull();
  });

  it('preserves a photo when a concurrent adapter updates the revision before a DELETE CAS executes', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let blockDelete = true;
    const fixture = d1Fixture({ beforeRun: async (sql) => {
      if (blockDelete && sql.startsWith('DELETE FROM catalogs')) {
        blockDelete = false;
        entered();
        await gate;
      }
    } });
    const second = createD1R2CatalogStore({ db: fixture.db, bucket: fixture.bucket });
    const first = await fixture.store.put('owner', { ...createDemoSession(), image: PHOTO }, { expectedUpdatedAt: null });
    const deleting = fixture.store.delete('owner', first.id);
    const rejected = expect(deleting).rejects.toMatchObject({ status: 409, code: 'CATALOG_CONFLICT' });
    await started;
    try {
      await second.put('owner', { ...first, name: 'Concurrent edit', image: null }, {
        expectedUpdatedAt: first.updatedAt, preservePhoto: true,
      });
    } finally { release(); }
    await rejected;
    expect(await second.get('owner', first.id)).toMatchObject({ name: 'Concurrent edit', image: PHOTO });
    expect(fixture.photos.size).toBe(1);
    expect(await second.delete('owner', first.id)).toBe(true);
    expect(fixture.photos.size).toBe(0);
  });

  it('does not read a different owner photo even if a stored pointer is corrupt', async () => {
    const fixture = d1Fixture();
    const a = await fixture.store.put('a', { ...createDemoSession(), image: PHOTO });
    const b = await fixture.store.put('b', { ...createDemoSession(), image: PHOTO });
    const foreign = fixture.database.prepare('SELECT photo_key FROM catalogs WHERE owner_id = ?').get('b')!;
    fixture.database.prepare('UPDATE catalogs SET photo_key = ? WHERE owner_id = ?').run(foreign.photo_key, 'a');
    await expect(fixture.store.get('a', a.id)).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    expect((await fixture.store.get('b', b.id))?.image).toBe(PHOTO);
  });

  it('enforces the decoded image size and declared image signature', () => {
    const bytes = new Uint8Array(MAX_PHOTO_BYTES + 1);
    bytes.set([255, 216, 255]);
    const image = 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
    expect(() => prepareCatalog({ ...createDemoSession(), image })).toThrow('8 MiB');
    expect(() => prepareCatalog({ ...createDemoSession(), image: 'data:image/png;base64,/9j/2Q==' })).toThrow('formato');
  });
});
