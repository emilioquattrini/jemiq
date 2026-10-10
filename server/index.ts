import dotenv from 'dotenv';
import express from 'express';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { createVisionService } from './vision';
import { createVisionCheckService } from './vision-check';
import { createCatalogService } from './catalog';
import { createStudioBriefService } from './studio-brief';
import { createStudioImageService } from './studio-image';
import { createStudioJobManager } from './studio-jobs';

dotenv.config({ quiet: true });
const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT deve essere un numero tra 1 e 65535.');
if (!Number.isInteger(trustProxy) || trustProxy < 0 || trustProxy > 5) throw new Error('TRUST_PROXY deve indicare il numero di proxy fidati (0–5).');
const vision = createVisionService({
  apiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  onDiagnostic: (diagnostic) => console.warn('Jemiq Gemini rejection:', JSON.stringify(diagnostic)),
});
const visionCheck = createVisionCheckService({
  apiKey: process.env.GEMINI_API_KEY || '',
  model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  onDiagnostic: (diagnostic) => console.warn('Jemiq Gemini text check:', JSON.stringify(diagnostic)),
});
const catalog = createCatalogService({ googleBooksApiKey: process.env.GOOGLE_BOOKS_API_KEY, userAgent: 'Jemiq/1.0 (https://github.com/emilioquattrini/jemiq)' });
const studioBrief = createStudioBriefService({ apiKey: process.env.GEMINI_API_KEY || '', model: process.env.GEMINI_MODEL || 'gemini-3.8-flash', catalog });
const imageApiKey = process.env.GEMINI_IMAGE_API_KEY || process.env.GEMINI_API_KEY || '';
const studioImage = createStudioImageService({ apiKey: imageApiKey, model: process.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1' });
const studioJobs = createStudioJobManager({ generate: studioImage.generate, maxActive: 1, maxResults: 4, maxTotalBytes: 32 * 1024 * 1024 });
const app = createApp({ recognize: vision.recognize, checkVision: visionCheck.check, catalog, recognitionReady: !!process.env.GEMINI_API_KEY, accessToken: process.env.JEMIQ_ACCESS_TOKEN, production, origin: process.env.APP_ORIGIN || undefined, trustProxy, studio: { ready: !!imageApiKey && process.env.STUDIO_ENABLED !== 'false', createBrief: studioBrief.create, jobs: studioJobs } });
const server = createServer(app);

if (production) {
  const client = fileURLToPath(new URL('../client/', import.meta.url));
  app.use(express.static(client, { index: false, maxAge: '1h' }));
  app.get('/', (_request, response) => { response.setHeader('Cache-Control', 'no-cache'); response.sendFile(`${client}index.html`); });
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
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
  studioJobs.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
