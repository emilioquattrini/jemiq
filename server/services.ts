import { createHash } from 'node:crypto';
import { createVisionService } from './vision';
import { createVisionCheckService } from './vision-check';
import { createCatalogService } from './catalog';
import { settingsStatus, type ProviderConfig, type SettingsStore } from './settings';

export function createServices(environment: ProviderConfig, store?: SettingsStore) {
  const cache = new Map<string, ReturnType<typeof build>>();
  function build(config: ProviderConfig) {
    const vision = createVisionService({ apiKey: config.geminiApiKey, model: config.model });
    const check = createVisionCheckService({ apiKey: config.geminiApiKey, model: config.model });
    const catalog = createCatalogService({ googleBooksApiKey: config.googleBooksApiKey, userAgent: 'Jemiq/2.0 (https://github.com/emilioquattrini/jemiq)' });
    return { recognize: vision.recognize, checkVision: check.check, catalog, recognitionReady: !!config.geminiApiKey };
  }
  const resolve = async (owner: string) => {
    const saved = await store?.get(owner) ?? null;
    return { config: saved ?? environment, saved: !!saved };
  };
  return {
    fallback: build(environment),
    async get(owner: string) {
      const { config } = await resolve(owner);
      const fingerprint = createHash('sha256').update(JSON.stringify(config)).digest('hex');
      let services = cache.get(fingerprint);
      if (!services) {
        services = build(config);
        if (cache.size >= 4) cache.delete(cache.keys().next().value!);
        cache.set(fingerprint, services);
      }
      return services;
    },
    settings: {
      editable: !!store,
      async status(owner: string) { const { config, saved } = await resolve(owner); return settingsStatus(config, saved, !!store); },
      async update(owner: string, input: { geminiApiKey?: string; googleBooksApiKey?: string; model?: string }, signal: AbortSignal) {
        if (!store) throw new Error('Settings are managed by the environment');
        const { config: current } = await resolve(owner);
        const config = { geminiApiKey: input.geminiApiKey || current.geminiApiKey, googleBooksApiKey: input.googleBooksApiKey || current.googleBooksApiKey, model: input.model || current.model };
        // Verify the new candidate before changing a working configuration; never return its secrets.
        await createVisionCheckService({ apiKey: config.geminiApiKey, model: config.model }).check(signal);
        await store.put(owner, config);
        return settingsStatus(config, true, true);
      },
    },
  };
}
