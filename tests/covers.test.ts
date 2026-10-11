import { describe, expect, it, vi } from 'vitest';
import { normalizeCoverUrl, resolveBookCover } from '../shared/covers';
import { MAX_COVER_BYTES, retrieveCover } from '../server/covers';
import { createFetchApp } from '../server/fetch-app';
import { createDemoSession } from '../src/lib/demo';

const URL = 'https://covers.openlibrary.org/b/id/123-M.jpg';
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==', 'base64'));
const imageResponse = () => new Response(PNG, { headers: { 'Content-Type': 'image/png' } });

describe('catalogue cover choice', () => {
  it('upgrades known image hosts to HTTPS and rejects credentials and arbitrary targets', () => {
    expect(normalizeCoverUrl('http://covers.openlibrary.org/b/id/123-M.jpg#fragment')).toBe(URL);
    for (const value of ['https://127.0.0.1/cover', 'https://covers.openlibrary.org.example.test/cover', 'https://user:secret@books.google.com/image', 'https://books.google.com:8443/image', 'file:///cover', 'data:image/svg+xml,test', '/cover', null]) {
      expect(normalizeCoverUrl(value)).toBeNull();
    }
  });

  it('offers a matching candidate only as an indicative cover without confirming its ISBN', () => {
    const book = createDemoSession().books[0];
    book.candidates = [{ ...book.candidates[0], thumbnail: URL }];
    expect(resolveBookCover(book)).toEqual({ url: URL, suggested: true });
    expect(book.isbn13).toBeNull();
    expect(book.thumbnail).toBeNull();
    expect(book.status).toBe('review');
  });

  it('does not use an unrelated candidate or another known edition to fill a missing image', () => {
    const book = createDemoSession().books[0];
    const candidate = { ...book.candidates[0], thumbnail: URL };
    for (const patch of [{ title: 'Un altro titolo' }, { authors: ['Un altro autore'] }, { publisher: 'Altro editore' }, { language: 'xx' }]) {
      const comparison = { ...book, publisher: candidate.publisher, language: candidate.language, candidates: [{ ...candidate, ...patch }] };
      expect(resolveBookCover(comparison).url).toBeNull();
    }
    expect(resolveBookCover({ ...book, isbn13: '9780141183534', candidates: [candidate] }).url).toBeNull();
    expect(resolveBookCover({ ...book, thumbnail: URL }).suggested).toBe(false);
  });

  it('uses an indicative image for an exact non-generic title with one consistent candidate author', () => {
    const book = createDemoSession().books[0];
    const candidate = { ...book.candidates[0], thumbnail: URL };
    expect(resolveBookCover({ ...book, authors: [], candidates: [candidate] })).toEqual({ url: URL, suggested: true });
    expect(resolveBookCover({ ...book, authors: [], candidates: [candidate, { ...candidate, id: 'other', authors: ['Altro autore'] }] }).url).toBeNull();
  });

  it('accepts equivalent language and publisher aliases while rejecting real edition conflicts', () => {
    const book = { ...createDemoSession().books[0], publisher: 'Feltrinelli', language: 'en-GB' };
    const candidate = { ...book.candidates[0], thumbnail: URL, publisher: 'Giangiacomo Feltrinelli Editore S.p.A.', language: 'eng' };
    expect(resolveBookCover({ ...book, candidates: [candidate] })).toEqual({ url: URL, suggested: true });
    expect(resolveBookCover({ ...book, language: 'it', candidates: [{ ...candidate, language: 'ita' }] }).url).toBe(URL);
    expect(resolveBookCover({ ...book, candidates: [{ ...candidate, language: 'ita' }] }).url).toBeNull();
    expect(resolveBookCover({ ...book, candidates: [{ ...candidate, publisher: 'Einaudi' }] }).url).toBeNull();
  });
});

describe('bounded public image retrieval', () => {
  it('retrieves PNG bytes without forwarding any account credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(imageResponse());
    const response = await retrieveCover(URL, new AbortController().signal, fetcher);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    const [target, init] = fetcher.mock.calls[0];
    expect(target).toBe(URL);
    expect(init).toMatchObject({ redirect: 'manual', credentials: 'omit' });
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({ accept: 'image/jpeg, image/png' });
  });

  it.each([301, 302, 303, 307, 308])('rejects redirect %s without following its destination', async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('redirect', { status, headers: { Location: 'https://private.example.test/' } }));
    await expect(retrieveCover(URL, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: 'COVER_UNAVAILABLE' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('rejects SVG/HTML, false image headers and responses exceeding the byte limit', async () => {
    for (const response of [
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
      new Response('<html>not an image</html>', { headers: { 'content-type': 'image/png' } }),
    ]) {
      await expect(retrieveCover(URL, new AbortController().signal, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject({ code: 'INVALID_COVER_TYPE' });
    }
    for (const response of [
      new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(MAX_COVER_BYTES + 1) } }),
      new Response(new Uint8Array(MAX_COVER_BYTES + 1), { headers: { 'content-type': 'image/png' } }),
    ]) {
      await expect(retrieveCover(URL, new AbortController().signal, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject({ code: 'COVER_TOO_LARGE' });
    }
  });

  it('cancels a stalled response body on abort', async () => {
    const abort = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { headers: { 'content-type': 'image/png' } }));
    const result = retrieveCover(URL, abort.signal, fetcher);
    const rejected = expect(result).rejects.toHaveProperty('name', 'AbortError');
    await Promise.resolve();
    abort.abort();
    await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('requires the same trusted owner as the other API routes before contacting the catalogue host', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => imageResponse());
    const app = createFetchApp({
      authMode: 'platform', production: true, recognitionReady: false, coverFetcher: fetcher,
      recognize: async () => ({ observations: [], warnings: [] }),
      catalog: { enrich: async () => { throw new Error('unused'); }, search: async () => [] },
    });
    const request = () => new Request('https://jemiq.example.test/api/cover?url=' + encodeURIComponent(URL));
    expect((await app(request())).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await app(request(), { ownerId: 'signed-in-owner' });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(fetcher).toHaveBeenCalledOnce();
    const invalid = await app(new Request('https://jemiq.example.test/api/cover?url=https://127.0.0.1/'), { ownerId: 'signed-in-owner' });
    expect(invalid.status).toBe(400);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
