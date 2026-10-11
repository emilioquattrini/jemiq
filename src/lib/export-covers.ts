import { normalizeCoverUrl } from '../../shared/covers';
import { apiHeaders } from './api';

export const MAX_EXPORT_COVERS = 48;
export const MAX_EXPORT_COVER_BYTES = 1024 * 1024;
export const MAX_EXPORT_COVERS_BYTES = 10 * 1024 * 1024;
export const EXPORT_COVER_DEADLINE_MS = 15_000;
const COVER_CONCURRENCY = 3;
const COVER_TIMEOUT_MS = 8_000;

export interface CoverData { bytes: Uint8Array; mimeType: string }
export interface ExportCoverImage {
  buffer: ArrayBuffer;
  extension: 'png' | 'jpeg';
  width: number;
  height: number;
}
export type CoverLoader = (url: string, signal: AbortSignal) => Promise<CoverData | null>;

/** The promise race also bounds injected/non-cooperating transports. */
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    if (signal.aborted) abort();
  });
}

async function readCoverBytes(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  if (signal.aborted || !response.body || Number(response.headers.get('content-length')) > MAX_EXPORT_COVER_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const chunk = await untilAbort(reader.read(), signal);
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_EXPORT_COVER_BYTES) return null;
      chunks.push(chunk.value);
    }
    finished = true;
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

/** Captures authentication once, and never sends it to the remote image host. */
export function createCoverLoader(options: { fetchImpl?: typeof fetch; headers?: HeadersInit } = {}): CoverLoader {
  const fetchImpl = options.fetchImpl ?? fetch;
  const capturedHeaders = new Headers(options.headers ?? apiHeaders());
  capturedHeaders.delete('Content-Type');
  capturedHeaders.set('Accept', 'image/jpeg, image/png');
  return async (rawUrl, signal) => {
    const url = normalizeCoverUrl(rawUrl);
    if (!url || signal.aborted) return null;
    let response: Response | undefined;
    try {
      response = await untilAbort(fetchImpl(`/api/cover?url=${encodeURIComponent(url)}`, {
        headers: new Headers(capturedHeaders), credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal,
      }), signal);
      const mimeType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (!response.ok || !['image/png', 'image/jpeg'].includes(mimeType ?? '')) {
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      const bytes = await readCoverBytes(response, signal);
      return bytes ? { bytes, mimeType: mimeType! } : null;
    } catch {
      if (response && !response.bodyUsed) void response.body?.cancel().catch(() => undefined);
      return null;
    }
  };
}

function dimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png') {
    if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
      || ![73, 72, 68, 82].every((value, index) => bytes[12 + index] === value)) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (mimeType !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) return null;
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset++] !== 255) return null;
    while (offset < bytes.length && bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 217 || marker === 218) return null;
    if (marker === 1 || (marker >= 208 && marker <= 216)) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
      if (length < 8) return null;
      return { height: bytes[offset + 3] * 256 + bytes[offset + 4], width: bytes[offset + 5] * 256 + bytes[offset + 6] };
    }
    offset += length;
  }
  return null;
}

function validatedImage(data: CoverData | null): ExportCoverImage | null {
  if (!data || !(data.bytes instanceof Uint8Array) || data.bytes.byteLength === 0 || data.bytes.byteLength > MAX_EXPORT_COVER_BYTES) return null;
  const size = dimensions(data.bytes, data.mimeType);
  if (!size || size.width < 1 || size.height < 1 || size.width > 8192 || size.height > 8192 || size.width * size.height > 32_000_000) return null;
  return {
    // ExcelJS/JSZip accepts ArrayBuffer, avoiding a larger base64 copy in memory.
    buffer: Uint8Array.from(data.bytes).buffer,
    extension: data.mimeType === 'image/png' ? 'png' : 'jpeg', ...size,
  };
}

/** Only Excel calls this helper. Failures leave complete book rows with placeholders. */
export async function loadExportCovers(rawUrls: ReadonlyArray<string | null>, options: { loadCover?: CoverLoader } = {}): Promise<Map<string, ExportCoverImage>> {
  const images = new Map<string, ExportCoverImage>();
  const urls = [...new Set(rawUrls.map(url => normalizeCoverUrl(url)).filter((url): url is string => !!url))].slice(0, MAX_EXPORT_COVERS);
  const loadCover = options.loadCover ?? (typeof window !== 'undefined' ? createCoverLoader() : null);
  if (!urls.length || !loadCover) return images;

  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), EXPORT_COVER_DEADLINE_MS);
  let next = 0;
  let totalBytes = 0;
  const worker = async () => {
    while (next < urls.length && !deadline.signal.aborted && totalBytes < MAX_EXPORT_COVERS_BYTES) {
      const url = urls[next++];
      const perImage = new AbortController();
      const abort = () => perImage.abort();
      deadline.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(abort, COVER_TIMEOUT_MS);
      try {
        const data = await untilAbort(Promise.resolve().then(() => loadCover(url, perImage.signal)), perImage.signal);
        if (deadline.signal.aborted || perImage.signal.aborted) continue;
        const image = validatedImage(data);
        if (!image || totalBytes + image.buffer.byteLength > MAX_EXPORT_COVERS_BYTES) continue;
        totalBytes += image.buffer.byteLength;
        images.set(url, image);
      } catch { /* An unavailable cover must never prevent exporting the catalogue. */ }
      finally {
        clearTimeout(timeout);
        deadline.signal.removeEventListener('abort', abort);
        perImage.abort();
      }
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, urls.length) }, worker)); }
  finally { clearTimeout(timer); deadline.abort(); }
  return images;
}
