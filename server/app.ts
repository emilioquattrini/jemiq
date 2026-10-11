import express from 'express';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { createFetchApp, API_HEADERS, STANDALONE_CSP, type AppOptions } from './fetch-app';

/** Portable Node adapter; the API is shared with the hosted Worker. */
export function createApp(options: AppOptions) {
  const app = express();
  const handle = createFetchApp(options);
  app.disable('x-powered-by');
  if (options.trustProxy) app.set('trust proxy', options.trustProxy);
  app.use((request, response, next) => {
    for (const [key, value] of Object.entries(API_HEADERS)) if (key !== 'Cache-Control') response.setHeader(key, value);
    if (options.production) response.setHeader('Content-Security-Policy', STANDALONE_CSP);
    if (!request.path.startsWith('/api/')) { next(); return; }
    const controller = new AbortController();
    const disconnected = () => { if (!response.writableEnded) controller.abort(); };
    response.on('close', disconnected);
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const init: RequestInit & { duplex?: 'half' } = { method: request.method, headers, signal: controller.signal };
        if (!['GET', 'HEAD'].includes(request.method)) { init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>; init.duplex = 'half'; }
        const result = await handle(new Request(`${request.protocol}://${request.get('host')}${request.originalUrl}`, init), { clientId: request.ip ?? 'unknown' });
        if (response.destroyed) { await result.body?.cancel(); return; }
        response.status(result.status);
        result.headers.forEach((value, key) => response.setHeader(key, value));
        response.flushHeaders();
        reader = result.body?.getReader();
        if (reader) {
          while (!controller.signal.aborted) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!response.write(chunk.value)) await once(response, 'drain', { signal: controller.signal });
          }
        }
        response.end();
      } catch {
        if (!response.headersSent && !response.destroyed) response.status(500).json({ code: 'INTERNAL_ERROR', error: 'Il servizio ha incontrato un problema. Riprova tra poco.' });
        else if (!response.destroyed) response.end();
      } finally {
        await reader?.cancel().catch(() => undefined); reader?.releaseLock();
        response.off('close', disconnected); controller.abort();
      }
    })();
  });
  return app;
}
