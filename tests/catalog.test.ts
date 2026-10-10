import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogError, createCatalogService } from '../server/catalog';
import type { Observation } from '../shared/types';
import { bookSchema } from '../shared/schemas';
import { confirmCandidate, updateBook } from '../src/lib/books';

const ISBN = '9780743273565';
const OTHER_ISBN = '9780306406157';

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    title: 'The Great Gatsby',
    authors: ['F. Scott Fitzgerald'],
    visibleIsbn: null,
    publisher: null,
    language: 'en',
    evidence: 'Titolo e autore leggibili sul dorso.',
    position: 'Primo libro a sinistra',
    confidence: 'high',
    boundingBox: null,
    ...overrides,
  };
}

function googleVolume(overrides: Record<string, unknown> = {}) {
  return {
    id: 'gatsby-edition',
    volumeInfo: {
      title: 'The Great Gatsby',
      authors: ['F. Scott Fitzgerald'],
      industryIdentifiers: [{ type: 'ISBN_13', identifier: ISBN }],
      publisher: 'Scribner',
      publishedDate: '2004-09-30',
      language: 'en',
      pageCount: 180,
      imageLinks: { thumbnail: 'http://books.google.com/cover.jpg' },
      ...overrides,
    },
  };
}

function edition(overrides: Record<string, unknown> = {}) {
  return {
    title: 'The Great Gatsby',
    authors: [{ name: 'F. Scott Fitzgerald' }],
    identifiers: { isbn_13: [ISBN], openlibrary: ['OL123M'] },
    publishers: [{ name: 'Scribner' }],
    publish_date: '2004',
    number_of_pages: 180,
    cover: { medium: 'https://covers.openlibrary.org/b/id/1-M.jpg' },
    ...overrides,
  };
}

function fetchMock(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return handler(url, init);
  });
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

afterEach(() => {
  vi.useRealTimers();
});

describe('sourced Studio metadata', () => {
  it('retains bounded plain-text description/categories on a verified edition and through client persistence', async () => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume({
      description: '<p>A&nbsp;<b>coastal garden</b> &amp; café.</p><script>private script</script>\u0000',
      categories: ['Fiction', '<b>Nature</b>', 'Fiction'],
    })] }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation({ visibleIsbn: ISBN }));
    expect(book.description).toBe('A coastal garden & café.');
    expect(book.categories).toEqual(['Fiction', 'Nature']);
    expect(bookSchema.parse(book).description).toBe(book.description);
    expect(bookSchema.parse(book).candidates[0].categories).toEqual(book.categories);
    const confirmed = confirmCandidate(book, book.candidates[0]);
    expect(confirmed.description).toBe(book.description);
    expect(updateBook(confirmed, { title: 'A different book' })).toMatchObject({ description: null, categories: [], source: null });
  });

  it('keeps proposed synopsis out of observed book fields until the edition is chosen', async () => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume({ description: 'Source synopsis', categories: ['Fiction'] })] }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation());
    expect(book.description).toBeUndefined();
    expect(book.categories).toBeUndefined();
    expect(book.candidates[0]).toMatchObject({ description: 'Source synopsis', categories: ['Fiction'] });
  });

  it('caps provider text/categories and clones categories out of the cache', async () => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume({
      description: 'x'.repeat(10_000), categories: Array.from({ length: 12 }, (_, index) => `${index}:` + 'y'.repeat(200)),
    })] }));
    const service = createCatalogService({ fetchImpl });
    const first = await service.search('Gatsby');
    expect(first[0].description).toHaveLength(4_000);
    expect(first[0].categories).toHaveLength(8);
    expect(first[0].categories![0]).toHaveLength(100);
    first[0].categories![0] = 'changed by client';
    expect((await service.search('Gatsby'))[0].categories![0]).not.toBe('changed by client');
  });

  it('retrieves the selected Google ID from a fixed API endpoint and checks the returned ISBN', async () => {
    const fetchImpl = fetchMock((url, init) => {
      expect(url.origin + url.pathname).toBe('https://www.googleapis.com/books/v1/volumes/gatsby-edition');
      expect(url.searchParams.get('key')).toBe('server-catalog-key');
      expect(init?.redirect).toBe('error');
      return json(googleVolume({ description: '<p>Exact edition synopsis.</p>', categories: ['Fiction'] }));
    });
    const service = createCatalogService({ fetchImpl, googleBooksApiKey: 'server-catalog-key' });
    const candidate = await service.getCandidate({ source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=gatsby-edition', isbn13: ISBN });
    expect(candidate).toMatchObject({ id: 'google:gatsby-edition', isbn13: ISBN, description: 'Exact edition synopsis.', categories: ['Fiction'] });
    await expect(service.getCandidate({ source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=gatsby-edition', isbn13: OTHER_ISBN })).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    'https://example.com/private',
    'http://books.google.com/books?id=gatsby-edition',
    'https://books.google.com.evil.example/books?id=gatsby-edition',
    'https://user:password@books.google.com/books?id=gatsby-edition',
    'https://books.google.com/books?id=..%2Fprivate',
    'https://books.google.com/books?id=a&id=b',
    'https://books.google.com/books?id=a&url=https://example.com',
    'https://127.0.0.1/books?id=gatsby-edition',
  ])('rejects untrusted selected source URLs without fetching: %s', async (sourceUrl) => {
    const fetchImpl = fetchMock(() => json({}));
    await expect(createCatalogService({ fetchImpl }).getCandidate({ source: 'Google Books', sourceUrl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a selected Google ID if the API returns a different record', async () => {
    const fetchImpl = fetchMock(() => json({ ...googleVolume(), id: 'some-other-edition' }));
    await expect(createCatalogService({ fetchImpl }).getCandidate({ source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=gatsby-edition' })).resolves.toBeNull();
  });

  it('reads Open Library description/subjects only from the selected edition response', async () => {
    const fetchImpl = fetchMock((url) => {
      expect(url.pathname).toBe('/api/books');
      expect(url.searchParams.get('bibkeys')).toBe('OLID:OL123M');
      return json({ 'OLID:OL123M': edition({ description: { value: 'An edition description.' }, subjects: [{ name: 'Fiction' }] }) });
    });
    const candidate = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 }).getCandidate({ source: 'Open Library', sourceUrl: 'https://openlibrary.org/books/OL123M' });
    expect(candidate).toMatchObject({ sourceUrl: 'https://openlibrary.org/books/OL123M', description: 'An edition description.', categories: ['Fiction'] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not fetch Open Library work URLs or accept another edition returned for the chosen ID', async () => {
    const fetchImpl = fetchMock(() => json({ 'OLID:OL123M': edition({ identifiers: { openlibrary: ['OL456M'] } }) }));
    const service = createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 });
    await expect(service.getCandidate({ source: 'Open Library', sourceUrl: 'https://openlibrary.org/works/OL123W' })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(service.getCandidate({ source: 'Open Library', sourceUrl: 'https://openlibrary.org/books/OL123M' })).resolves.toBeNull();
  });

  it('distinguishes unavailable selected catalogues from absent metadata without exposing provider text', async () => {
    const fetchImpl = fetchMock(() => new Response('secret provider details', { status: 503 }));
    const service = createCatalogService({ fetchImpl });
    await expect(service.getCandidate({ source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=gatsby-edition' })).rejects.toThrow(CatalogError);
  });
});

describe('catalog enrichment', () => {
  it('verifies an actually visible valid ISBN only after catalog identity agrees', async () => {
    const fetchImpl = fetchMock((url, init) => {
      expect(url.hostname).toBe('www.googleapis.com');
      expect(url.searchParams.get('q')).toBe('isbn:' + ISBN);
      expect(init?.redirect).toBe('error');
      return json({ items: [googleVolume()] });
    });
    const service = createCatalogService({ fetchImpl });
    const book = await service.enrich(observation({ visibleIsbn: ISBN }));
    expect(book).toMatchObject({
      status: 'verified', isbn13: ISBN, title: 'The Great Gatsby',
      authors: ['F. Scott Fitzgerald'], publisher: 'Scribner', publishedDate: '2004-09-30',
      source: 'Google Books', pageCount: 180,
    });
    expect(book.thumbnail).toBe('https://books.google.com/cover.jpg');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves ISBN-10 and normalizes author initials without changing the observed evidence', async () => {
    const fetchImpl = fetchMock(() => json({
      items: [googleVolume({
        title: 'Gravitation',
        authors: ['Charles W. Misner'],
        industryIdentifiers: [{ type: 'ISBN_10', identifier: '0306406152' }],
      })],
    }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation({
      title: 'Gravitation', authors: ['C. W. Misner'], visibleIsbn: '0-306-40615-2',
    }));
    expect(book.status).toBe('verified');
    expect(book.isbn13).toBe(OTHER_ISBN);
    expect(book.observation.visibleIsbn).toBe('0-306-40615-2');
  });

  it('never confirms an edition from title alone or mixes a candidate into observed fields', async () => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume({
      title: 'A different book', authors: ['Another writer'], publisher: 'Another publisher',
    })] }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation({ publisher: 'Editore visibile' }));
    expect(book).toMatchObject({
      status: 'review', title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'],
      isbn13: null, publisher: 'Editore visibile', publishedDate: null,
      source: null, sourceUrl: null, pageCount: null, thumbnail: null,
    });
    expect(book.candidates[0]).toMatchObject({
      title: 'A different book', publisher: 'Another publisher', isbn13: ISBN,
    });
  });

  it('rejects a Google result that does not contain the ISBN that was requested', async () => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ items: [googleVolume({ industryIdentifiers: [{ type: 'ISBN_13', identifier: OTHER_ISBN }] })] })
      : json({}));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 })
      .enrich(observation({ visibleIsbn: ISBN }));
    expect(book.isbn13).toBeNull();
    expect(book.status).toBe('unresolved');
    expect(book.candidates).toEqual([]);
    expect(book.notes).toContain('non è stato riscontrato');
  });

  it.each([
    { title: 'Nineteen Eighty-Four' },
    { authors: ['George Orwell'] },
    { authors: [] },
  ])('requires review for conflicting or missing corroboration: %o', async (conflict) => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ items: [googleVolume(conflict)] }) : json({}));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 })
      .enrich(observation({ visibleIsbn: ISBN }));
    expect(book.status).toBe('review');
    expect(book.isbn13).toBeNull();
    expect(book.title).toBe('The Great Gatsby');
    expect(book.notes).toContain('non coincidono');
  });

  it.each([
    { catalog: { publisher: 'Penguin' }, observed: { publisher: 'Scribner' }, reason: 'editore' },
    { catalog: { language: 'it' }, observed: { language: 'en' }, reason: 'lingua' },
  ])('keeps an edition under review when visible $reason conflicts', async ({ catalog, observed, reason }) => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ items: [googleVolume(catalog)] }) : json({}));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 })
      .enrich(observation({ visibleIsbn: ISBN, ...observed }));
    expect(book.status).toBe('review');
    expect(book.isbn13).toBeNull();
    expect(book.notes.toLowerCase()).toContain(reason);
  });

  it('accepts equivalent language codes and conservative publisher name variants', async () => {
    const fetchImpl = fetchMock(() => json({
      items: [googleVolume({ language: 'eng', publisher: 'Giangiacomo Feltrinelli Editore S.p.A.' })],
    }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation({
      visibleIsbn: ISBN, language: 'en-GB', publisher: 'Feltrinelli',
    }));
    expect(book.status).toBe('verified');
    expect(book.isbn13).toBe(ISBN);
  });

  it('does not verify an ebook ISBN or let a fallback with unknown format erase that conflict', async () => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ items: [{ ...googleVolume(), saleInfo: { isEbook: true } }] })
      : json({ ['ISBN:' + ISBN]: edition() }));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 })
      .enrich(observation({ visibleIsbn: ISBN }));
    expect(book.status).toBe('review');
    expect(book.isbn13).toBeNull();
    expect(book.notes).toContain('ebook');
    expect(book.candidates.every((candidate) => candidate.matchReason.includes('ebook'))).toBe(true);
    expect(book.candidates[0]).not.toHaveProperty('ebookConflict');
  });

  it.each([
    'https://untrusted.example/tracking.jpg',
    'https://books.google.com.untrusted.example/cover.jpg',
    'javascript:alert(1)',
    'data:image/jpeg;base64,aaaa',
    'https://user:password@books.google.com/cover.jpg',
  ])('does not expose an unapproved remote cover URL: %s', async (url) => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume({ imageLinks: { thumbnail: url } })] }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation({ visibleIsbn: ISBN }));
    expect(book.status).toBe('verified');
    expect(book.thumbnail).toBeNull();
  });

  it('can verify a coherent fallback edition even when Google returned five conflicting records', async () => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ items: Array.from({ length: 5 }, () => googleVolume({ title: 'Wrong title' })) })
      : json({ ['ISBN:' + ISBN]: edition() }));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 })
      .enrich(observation({ visibleIsbn: ISBN }));
    expect(book.status).toBe('verified');
    expect(book.source).toBe('Open Library');
    expect(book.isbn13).toBe(ISBN);
  });

  it('does not repair a checksum and keeps invalid observed ISBNs out of the result', async () => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume()] }));
    const book = await createCatalogService({ fetchImpl })
      .enrich(observation({ visibleIsbn: ISBN.slice(0, -1) + '6' }));
    expect(book.status).toBe('review');
    expect(book.isbn13).toBeNull();
    expect(book.notes).toContain('non è un ISBN valido');
  });

  it('gets Open Library fields from an actual edition, never from aggregated work ISBNs', async () => {
    const fetchImpl = fetchMock((url) => {
      if (url.hostname === 'www.googleapis.com') return json({ items: [] });
      if (url.pathname === '/search.json') {
        return json({ docs: [{
          key: '/works/OL1W', title: 'Work title', isbn: [OTHER_ISBN],
          author_name: ['Wrong work author'], editions: { docs: [{ key: '/books/OL123M' }] },
        }] });
      }
      expect(url.searchParams.get('bibkeys')).toBe('OLID:OL123M');
      return json({ 'OLID:OL123M': edition() });
    });
    const candidates = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 })
      .search('The Great Gatsby Fitzgerald');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      title: 'The Great Gatsby', isbn13: ISBN, authors: ['F. Scott Fitzgerald'],
      publisher: 'Scribner', sourceUrl: 'https://openlibrary.org/books/OL123M',
    });
  });

  it('preserves a partial record and explains provider failures instead of rejecting the scan', async () => {
    const fetchImpl = fetchMock((url) => json({ error: 'unavailable' }, url.hostname === 'www.googleapis.com' ? 429 : 503));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 }).enrich(observation());
    expect(book.title).toBe('The Great Gatsby');
    expect(book.authors).toEqual(['F. Scott Fitzgerald']);
    expect(book.status).toBe('unresolved');
    expect(book.isbn13).toBeNull();
    expect(book.notes).toContain('Google Books: limite di richieste');
    expect(book.notes).toContain('Open Library: servizio temporaneamente');
  });

  it('skips a throttled provider for later books, keeps its fallback working, and retries after the cooldown', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-10-10T10:00:00Z').getTime();
    vi.setSystemTime(startedAt);
    let googleRequests = 0;
    let openLibrarySearches = 0;
    const fetchImpl = fetchMock((url) => {
      if (url.hostname === 'www.googleapis.com') {
        googleRequests += 1;
        return googleRequests === 1
          ? json({ error: 'quota exceeded' }, 429)
          : json({ items: [googleVolume({ title: 'Pride and Prejudice', authors: ['Jane Austen'] })] });
      }
      if (url.pathname === '/search.json') {
        openLibrarySearches += 1;
        const id = url.searchParams.get('q')?.includes('Gravitation') ? 'OL456M' : 'OL123M';
        return json({ docs: [{ editions: { docs: [{ key: '/books/' + id }] } }] });
      }
      if (url.searchParams.get('bibkeys') === 'OLID:OL456M') {
        return json({ 'OLID:OL456M': edition({
          title: 'Gravitation', authors: [{ name: 'Charles W. Misner' }],
          identifiers: { isbn_13: [OTHER_ISBN], openlibrary: ['OL456M'] },
        }) });
      }
      return json({ 'OLID:OL123M': edition() });
    });
    const service = createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 });
    const first = await service.enrich(observation());
    const second = await service.enrich(observation({ title: 'Gravitation', authors: ['Charles W. Misner'] }));
    expect(googleRequests).toBe(1);
    expect(openLibrarySearches).toBe(2);
    expect(first.candidates[0].source).toBe('Open Library');
    expect(second.candidates[0]).toMatchObject({ title: 'Gravitation', source: 'Open Library' });
    expect(second.notes).toContain('Google Books: limite di richieste');
    expect(second.notes).toContain('Nuovo tentativo disponibile');
    vi.setSystemTime(startedAt + 30_001);
    const third = await service.enrich(observation({ title: 'Pride and Prejudice', authors: ['Jane Austen'] }));
    expect(googleRequests).toBe(2);
    expect(third.candidates[0].source).toBe('Google Books');
    expect(openLibrarySearches).toBe(2);
  });

  it.each(['120', 'Sat, 10 Oct 2026 10:02:00 GMT'])('caps Retry-After at 60 seconds: %s', async (retryAfter) => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-10-10T10:00:00Z').getTime();
    vi.setSystemTime(startedAt);
    let googleRequests = 0;
    const fetchImpl = fetchMock((url) => {
      if (url.hostname === 'www.googleapis.com') {
        googleRequests += 1;
        return Response.json({ error: 'unavailable' }, { status: 503, headers: { 'Retry-After': retryAfter } });
      }
      return json({ docs: [] });
    });
    const service = createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 });
    await service.search('First title');
    vi.setSystemTime(startedAt + 59_999);
    await service.search('Second title');
    expect(googleRequests).toBe(1);
    vi.setSystemTime(startedAt + 60_001);
    await service.search('Third title');
    expect(googleRequests).toBe(2);
  });

  it('distinguishes a search outage from a successful search with no results', async () => {
    const fetchImpl = fetchMock(() => json({ error: 'unavailable' }, 503));
    const service = createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 });
    await expect(service.search('Gatsby')).rejects.toBeInstanceOf(CatalogError);
    await expect(service.search(ISBN)).rejects.toMatchObject({
      status: 503, code: 'CATALOG_UNAVAILABLE',
      message: 'I cataloghi sono temporaneamente indisponibili. Riprova tra poco.',
    });
  });

  it('returns an empty search when an available provider reports no matches', async () => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ error: 'unavailable' }, 503) : json({ docs: [] }));
    await expect(createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 }).search('Gatsby'))
      .resolves.toEqual([]);
  });

  it('bounds the actual response body even without a Content-Length header', async () => {
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? json({ items: [googleVolume({ description: 'x'.repeat(1024 * 1024) })] })
      : json({ docs: [] }));
    const book = await createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 }).enrich(observation());
    expect(book.status).toBe('unresolved');
    expect(book.notes).toContain('risposta troppo grande');
    expect(book.title).toBe('The Great Gatsby');
  });

  it('keeps source fields edition-specific even when other information is visible in the photo', async () => {
    const fetchImpl = fetchMock(() => json({ items: [googleVolume({ publisher: undefined, language: undefined })] }));
    const book = await createCatalogService({ fetchImpl }).enrich(observation({
      visibleIsbn: ISBN, publisher: 'Scribner', language: 'en',
    }));
    expect(book.status).toBe('verified');
    expect(book.publisher).toBeNull();
    expect(book.language).toBeNull();
    expect(book.observation.publisher).toBe('Scribner');
    expect(book.observation.language).toBe('en');
  });

  it('retains unreadable observations without calling a catalog', async () => {
    const fetchImpl = fetchMock(() => { throw new Error('should not be called'); });
    const book = await createCatalogService({ fetchImpl })
      .enrich(observation({ title: null, authors: [], confidence: 'low' }));
    expect(book.status).toBe('unresolved');
    expect(book.title).toBe('Libro da identificare');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('caches catalog responses without sharing editable records, and expires the cache', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
    const fetchImpl = fetchMock(() => json({ items: [googleVolume()] }));
    const service = createCatalogService({ fetchImpl });
    const first = await service.enrich(observation({ visibleIsbn: ISBN }));
    first.candidates[0].authors[0] = 'Edited author';
    const second = await service.enrich(observation({ visibleIsbn: ISBN }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second.id).not.toBe(first.id);
    expect(second.candidates[0].authors).toEqual(['F. Scott Fitzgerald']);
    vi.setSystemTime(new Date('2026-10-10T10:16:00Z'));
    await service.enrich(observation({ visibleIsbn: ISBN }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation and aborts the underlying request without calling a fallback', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = fetchMock((_url, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const pending = createCatalogService({ fetchImpl }).search('Gatsby', controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('finishes with a partial record when a provider never answers', async () => {
    vi.useFakeTimers();
    const fetchImpl = fetchMock((url) => url.hostname === 'www.googleapis.com'
      ? new Promise<Response>(() => undefined) : json({ docs: [] }));
    const pending = createCatalogService({ fetchImpl, openLibraryIntervalMs: 0 }).enrich(observation());
    await vi.advanceTimersByTimeAsync(8_001);
    const book = await pending;
    expect(book.title).toBe('The Great Gatsby');
    expect(book.status).toBe('unresolved');
    expect(book.notes).toContain('tempo di attesa scaduto');
  });

  it('paces Open Library globally across concurrent lookups', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
    const starts: number[] = [];
    const fetchImpl = fetchMock((url) => {
      if (url.hostname === 'www.googleapis.com') return json({ items: [] });
      starts.push(Date.now());
      return json({});
    });
    const service = createCatalogService({ fetchImpl });
    const pending = Promise.all([service.search(ISBN), service.search(OTHER_ISBN)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1_000);
  });
});
