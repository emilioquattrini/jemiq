import { env } from 'cloudflare:workers';
import { createFetchApp } from './fetch-app';
import { createD1R2CatalogStore } from './storage/d1-r2';
import { createD1SettingsStore } from './settings';
import { createD1Budget } from './rate-limit';
import { createServices } from './services';

let app: ReturnType<typeof createFetchApp> | undefined;
export function getCloudApp() {
  if (app) return app;
  if (!env.DB || !env.BUCKET) throw new Error('Persistent storage bindings are unavailable');
  const settings = env.SETTINGS_ENCRYPTION_KEY ? createD1SettingsStore(env.DB, env.SETTINGS_ENCRYPTION_KEY) : undefined;
  const services = createServices({ geminiApiKey: env.GEMINI_API_KEY || '', googleBooksApiKey: env.GOOGLE_BOOKS_API_KEY || '', model: env.GEMINI_MODEL || 'gemini-3.8-flash' }, settings);
  app = createFetchApp({
    ...services.fallback, getServices: services.get, settings: services.settings,
    authMode: 'platform', production: true, accessToken: env.JEMIQ_ACCESS_TOKEN,
    allowServiceToken: env.JEMIQ_SERVICE_ACCESS_ENABLED === 'true',
    origin: env.APP_ORIGIN,
    catalogStore: createD1R2CatalogStore({ db: env.DB, bucket: env.BUCKET }),
    budget: createD1Budget(env.DB),
    maxConcurrentScans: 1,
  });
  return app;
}
