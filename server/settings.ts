import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { z } from 'zod';
import type { D1Database } from './storage/d1-r2';
import { StorageError } from './storage/contracts';

export interface ProviderConfig { geminiApiKey: string; googleBooksApiKey: string; model: string }
export interface SettingsStore { get(owner: string): Promise<ProviderConfig | null>; put(owner: string, config: ProviderConfig): Promise<void> }
export interface SettingsStatus { configured: boolean; googleBooksConfigured: boolean; model: string; source: 'environment' | 'saved' | 'none'; editable: boolean }
export const settingsInputSchema = z.object({
  geminiApiKey: z.string().trim().max(512).regex(/^[^\r\n]*$/).optional(),
  googleBooksApiKey: z.string().trim().max(512).regex(/^[^\r\n]*$/).optional(),
  model: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
  verify: z.literal(true),
}).strict();
const configSchema = z.object({ geminiApiKey: z.string().max(512), googleBooksApiKey: z.string().max(512), model: z.string().max(128) }).strict();

/** AES-GCM binds each encrypted record to its authenticated owner. */
export function createSettingsCipher(secret: string) {
  if (secret.length < 32) throw new Error('SETTINGS_ENCRYPTION_KEY requires at least 32 characters');
  const key = createHash('sha256').update(secret).digest();
  return {
    encrypt(owner: string, config: ProviderConfig): string {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(owner));
      const data = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join('.');
    },
    decrypt(owner: string, value: string): ProviderConfig {
      const [version, iv, tag, body, extra] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !body || extra) throw new Error('Invalid encrypted configuration');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(owner)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return configSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')));
    },
  };
}

export function createD1SettingsStore(db: D1Database, secret: string): SettingsStore {
  const cipher = createSettingsCipher(secret);
  return {
    async get(owner) {
      try {
        const row = await db.prepare('SELECT ciphertext FROM provider_settings WHERE owner_id = ?').bind(owner).first<{ ciphertext: string }>();
        return row ? cipher.decrypt(owner, row.ciphertext) : null;
      } catch { throw new StorageError(503, 'SETTINGS_UNAVAILABLE', 'Le impostazioni non sono disponibili. Riprova tra poco.'); }
    },
    async put(owner, config) {
      try {
        await db.prepare('INSERT INTO provider_settings (owner_id, ciphertext, updated_at) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at')
          .bind(owner, cipher.encrypt(owner, config), new Date().toISOString()).run();
      } catch { throw new StorageError(503, 'SETTINGS_UNAVAILABLE', 'Non riesco a salvare le impostazioni. Riprova tra poco.'); }
    },
  };
}

export function settingsStatus(config: ProviderConfig, saved: boolean, editable: boolean): SettingsStatus {
  return { configured: !!config.geminiApiKey, googleBooksConfigured: !!config.googleBooksApiKey, model: config.model, source: saved ? 'saved' : config.geminiApiKey ? 'environment' : 'none', editable };
}
