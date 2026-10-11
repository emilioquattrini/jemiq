import { normalizeCoverUrl } from '../shared/covers';

export const MAX_COVER_BYTES = 1024 * 1024;
export class CoverError extends Error {
  constructor(public status: number, public code: string, message = 'Copertina non disponibile') { super(message); }
}

/** Bounded, credential-free image retrieval shared by both runtime adapters. */
export async function retrieveCover(value: unknown, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = normalizeCoverUrl(value);
  if (!url) throw new CoverError(400, 'INVALID_COVER');
  const upstream = await fetcher(url, {
    signal, redirect: 'manual', credentials: 'omit',
    headers: { Accept: 'image/jpeg, image/png' },
  });
  const reject = async (status: number, code: string): Promise<never> => {
    await upstream.body?.cancel().catch(() => {});
    throw new CoverError(status, code);
  };
  if (!upstream.ok || (upstream.status >= 300 && upstream.status < 400)) return reject(502, 'COVER_UNAVAILABLE');
  const mime = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!['image/jpeg', 'image/png'].includes(mime ?? '')) return reject(415, 'INVALID_COVER_TYPE');
  if (Number(upstream.headers.get('content-length')) > MAX_COVER_BYTES) return reject(413, 'COVER_TOO_LARGE');
  const reader = upstream.body?.getReader();
  if (!reader) throw new CoverError(502, 'COVER_UNAVAILABLE');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_COVER_BYTES) {
        await reader.cancel().catch(() => {});
        throw new CoverError(413, 'COVER_TOO_LARGE');
      }
      chunks.push(chunk.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  // Do not pass through an HTML/SVG response mislabeled by an upstream service.
  const jpeg = bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  const png = bytes.length >= 24 && pngSignature.every((value, index) => bytes[index] === value);
  if ((mime === 'image/jpeg' && !jpeg) || (mime === 'image/png' && !png)) throw new CoverError(415, 'INVALID_COVER_TYPE');
  return new Response(bytes, { headers: { 'Content-Type': mime!, 'Content-Length': String(bytes.length), 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}
