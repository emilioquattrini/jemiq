import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { resolve } from 'node:path';
import { createServices } from './services';
import { createFileCatalogStore } from './storage/file';

dotenv.config({ quiet: true });
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve essere un numero tra 1 e 65535.');
if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 5) throw new Error('TRUST_PROXY deve indicare il numero di proxy fidati (0–5).');
const services = createServices({ geminiApiKey: process.env.GEMINI_API_KEY || '', googleBooksApiKey: process.env.GOOGLE_BOOKS_API_KEY || '', model: process.env.GEMINI_MODEL || 'gemini-3.8-flash' });
const app = createApp({ ...services.fallback, settings: services.settings, authMode: 'token', accessToken: process.env.JEMIQ_ACCESS_TOKEN, production, origin: process.env.APP_ORIGIN || undefined, trustProxy, catalogStore: createFileCatalogStore({ directory: resolve(process.env.JEMIQ_DATA_DIR || '.data') }) });
const server = createServer(app);

if (production) {
  const client = fileURLToPath(new URL('../client/', import.meta.url));
  app.use(express.static(client, { index: false, maxAge: '1h' }));
  app.get('/', (_request, response) => { response.setHeader('Cache-Control', 'no-cache'); response.sendFile(`${client}index.html`); });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ configFile: 'vite.client.config.ts', server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
}

server.requestTimeout = 190_000;
server.headersTimeout = 15_000;
server.listen(port, host, () => {
  console.info(`Jemiq: http://${host}:${port}`);
  if (!process.env.GEMINI_API_KEY) console.info('Riconoscimento da configurare: imposta GEMINI_API_KEY nel server.');
  if (production && (process.env.JEMIQ_ACCESS_TOKEN?.length ?? 0) < 16) console.info('API protette: configura JEMIQ_ACCESS_TOKEN (almeno 16 caratteri) per abilitare il servizio.');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
