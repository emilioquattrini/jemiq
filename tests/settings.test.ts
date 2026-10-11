import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createD1SettingsStore, createSettingsCipher, settingsInputSchema, settingsStatus, type ProviderConfig } from '../server/settings';
import type { D1Database } from '../server/storage/d1-r2';

// Deliberately fake provider keys. No network or environment credentials are used.
const SECRET = 'test-only-encryption-key-32-characters-long';
const CONFIG: ProviderConfig = { geminiApiKey: 'test-gemini-key-private', googleBooksApiKey: 'test-books-key-private', model: 'gemini-3.8-flash' };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
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
  return { database, db, store: createD1SettingsStore(db, SECRET) };
}

describe('owner-bound provider settings', () => {
  it('encrypts repeat saves differently, retains all values and exposes no key in the ciphertext', () => {
    const cipher = createSettingsCipher(SECRET);
    const first = cipher.encrypt('owner-a', CONFIG);
    const second = cipher.encrypt('owner-a', CONFIG);
    expect(first).not.toBe(second);
    expect(cipher.decrypt('owner-a', first)).toEqual(CONFIG);
    expect(cipher.decrypt('owner-a', second)).toEqual(CONFIG);
    expect(first).not.toContain(CONFIG.geminiApiKey);
    expect(first).not.toContain(CONFIG.googleBooksApiKey);
    expect(first).not.toContain(CONFIG.model);
  });

  it('rejects another owner, another encryption key and a weak server secret', () => {
    const cipher = createSettingsCipher(SECRET);
    const value = cipher.encrypt('owner-a', CONFIG);
    expect(() => cipher.decrypt('owner-b', value)).toThrow();
    expect(() => createSettingsCipher(SECRET + '-changed').decrypt('owner-a', value)).toThrow();
    expect(() => createSettingsCipher('short')).toThrow();
  });

  it.each([1, 2, 3])('rejects a modified encrypted component %i without yielding plaintext', (component) => {
    const cipher = createSettingsCipher(SECRET);
    const parts = cipher.encrypt('owner-a', CONFIG).split('.');
    const bytes = Buffer.from(parts[component], 'base64');
    bytes[0] ^= 1;
    parts[component] = bytes.toString('base64');
    expect(() => cipher.decrypt('owner-a', parts.join('.'))).toThrow();
  });

  it('persists separate encrypted records and fails safely if ciphertext is copied between owners', async () => {
    const { store, database } = fixture();
    expect(await store.get('owner-a')).toBeNull();
    await store.put('owner-a', CONFIG);
    await store.put('owner-b', { ...CONFIG, geminiApiKey: 'test-owner-b-key' });
    expect(await store.get('owner-a')).toEqual(CONFIG);
    expect((await store.get('owner-b'))?.geminiApiKey).toBe('test-owner-b-key');
    const raw = database.prepare('SELECT ciphertext FROM provider_settings WHERE owner_id = ?').get('owner-a')!;
    expect(String(raw.ciphertext)).not.toContain(CONFIG.geminiApiKey);
    database.prepare('UPDATE provider_settings SET ciphertext = ? WHERE owner_id = ?').run(raw.ciphertext, 'owner-b');
    await expect(store.get('owner-b')).rejects.toMatchObject({ status: 503, code: 'SETTINGS_UNAVAILABLE' });
    expect(await store.get('owner-a')).toEqual(CONFIG);
  });

  it('redacts database failures on reads and writes instead of returning provider secrets', async () => {
    const db: D1Database = { prepare() { throw new Error(`database account@example.test: ${CONFIG.geminiApiKey}`); } };
    const store = createD1SettingsStore(db, SECRET);
    for (const work of [() => store.get('owner-a'), () => store.put('owner-a', CONFIG)]) {
      const error = await work().catch((error: unknown) => error);
      expect(error).toMatchObject({ status: 503, code: 'SETTINGS_UNAVAILABLE' });
      expect(String(error)).not.toContain(CONFIG.geminiApiKey);
      expect(String(error)).not.toContain('account@example.test');
    }
  });

  it('publishes only configuration status and requires explicit verification on updates', () => {
    expect(settingsStatus(CONFIG, true, true)).toEqual({ configured: true, googleBooksConfigured: true, model: CONFIG.model, source: 'saved', editable: true });
    expect(settingsStatus(CONFIG, false, false).source).toBe('environment');
    expect(settingsStatus({ ...CONFIG, geminiApiKey: '', googleBooksApiKey: '' }, false, true).source).toBe('none');
    expect(JSON.stringify(settingsStatus(CONFIG, true, true))).not.toContain(CONFIG.geminiApiKey);
    expect(JSON.stringify(settingsStatus(CONFIG, true, true))).not.toContain(CONFIG.googleBooksApiKey);
    expect(settingsInputSchema.parse({ geminiApiKey: '  test-new-key  ', verify: true })).toEqual({ geminiApiKey: 'test-new-key', verify: true });
    for (const input of [
      { geminiApiKey: 'test-new-key' },
      { geminiApiKey: 'test-new-key', verify: false },
      { geminiApiKey: 'prefix\r\nInjected: value', verify: true },
      { model: '../models/other', verify: true },
      { geminiApiKey: 'test-new-key', ownerId: 'someone-else', verify: true },
    ]) expect(settingsInputSchema.safeParse(input).success).toBe(false);
  });
});
