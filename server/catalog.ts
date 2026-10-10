import { randomUUID } from 'node:crypto';
import type { BookRecord, CatalogCandidate, CatalogSource, Observation } from '../shared/types';
import { toIsbn13 } from '../shared/isbn';

export interface CatalogServiceOptions {
  fetchImpl?: typeof fetch;
  googleBooksApiKey?: string;
  userAgent?: string;
  /** Keep the default in production. A shorter interval is useful in isolated tests. */
  openLibraryIntervalMs?: number;
}

/** A selected catalogue reference, resolved into a fixed provider endpoint on the server. */
export interface CatalogReference {
  source: CatalogSource;
  sourceUrl: string;
  isbn13?: string | null;
}

export class CatalogError extends Error {
  readonly status = 503;
  readonly code = 'CATALOG_UNAVAILABLE';

  constructor() {
    super('I cataloghi sono temporaneamente indisponibili. Riprova tra poco.');
    this.name = 'CatalogError';
  }
}

type JsonObject = Record<string, unknown>;
type InternalCandidate = CatalogCandidate & { ebookConflict?: boolean };
type LookupResult = { candidates: InternalCandidate[]; issues: string[] };

const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_CANDIDATES = 5;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_PROVIDER_COOLDOWN_MS = 30_000;
const MAX_PROVIDER_COOLDOWN_MS = 60_000;
const COVER_HOSTS = new Set(['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org']);
const EBOOK_REASON = 'Il catalogo associa questo ISBN a un ebook: verifica il formato del volume fotografato.';

function object(value: unknown): JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown, limit = 500): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().slice(0, limit) || null;
}

function strings(value: unknown): string[] {
  return [...new Set(array(value).map((item) => string(item, 200)).filter((item): item is string => !!item))].slice(0, 20);
}

/** Catalogue descriptions may contain HTML. Keep bounded plain text, never executable markup. */
function catalogueText(value: unknown, limit = 4_000): string | null {
  if (typeof value !== 'string') return null;
  const entities: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…',
  };
  return value.slice(0, 30_000)
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (entity[0] !== '#') return entities[entity.toLowerCase()] ?? match;
      const code = entity[1]?.toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isSafeInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code) : ' ';
    })
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, limit) || null;
}

function catalogueCategories(value: unknown): string[] {
  return [...new Set(array(value).slice(0, 30).map((item) =>
    catalogueText(typeof item === 'string' ? item : object(item).name, 100),
  ).filter((item): item is string => !!item))].slice(0, 8);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function providerCooldownMs(retryAfter: string | null): number {
  if (!retryAfter) return DEFAULT_PROVIDER_COOLDOWN_MS;
  const value = retryAfter.trim();
  const milliseconds = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return DEFAULT_PROVIDER_COOLDOWN_MS;
  return Math.min(MAX_PROVIDER_COOLDOWN_MS, Math.max(1_000, milliseconds));
}

function imageUrl(value: unknown): string | null {
  const text = string(value, 2_000);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!COVER_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) return null;
    url.protocol = 'https:';
    return url.href;
  } catch {
    return null;
  }
}

function normalizedText(value: string): string {
  return value.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function titlesAgree(observed: string, candidate: string): boolean {
  const a = normalizedText(observed);
  const b = normalizedText(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const mainTitle = normalizedText(candidate.split(/:|\s[—–]\s/u)[0]);
  if (a === mainTitle) return true;
  // Permit a small catalog subtitle or OCR omission, but not a short generic title.
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  if (Math.min(aTokens.size, bTokens.size) < 3) return false;
  const common = [...aTokens].filter((token) => bTokens.has(token)).length;
  const union = new Set([...aTokens, ...bTokens]).size;
  return common / union >= 0.85 && Math.min(a.length, b.length) / Math.max(a.length, b.length) >= 0.75;
}

function authorsAgree(observed: string, candidate: string): boolean {
  const a = normalizedText(observed).split(' ').filter(Boolean);
  const b = normalizedText(candidate).split(' ').filter(Boolean);
  if (a.length === 0 || b.length === 0) return false;
  const namesMatch = (left: string, right: string) =>
    left === right || (Math.min(left.length, right.length) === 1 && left[0] === right[0]);
  // A surname alone may corroborate a full catalog name; differing full names cannot.
  return a.every((left) => b.some((right) => namesMatch(left, right)))
    && a.some((left) => left.length > 1 && b.includes(left));
}

function publisherIdentity(value: string): string {
  const name = normalizedText(value)
    .replace(/\b(?:s p a|s r l|spa|srl|ltd|limited|inc|incorporated)\b/g, '')
    .replace(/\b(?:editore|editori|edizioni|publisher|publishers|publishing|books|press)\b/g, '')
    .replace(/\s+/g, ' ').trim();
  const aliases: Record<string, string> = {
    'giangiacomo feltrinelli': 'feltrinelli',
    'arnoldo mondadori': 'mondadori',
    'giulio einaudi': 'einaudi',
    'ugo guanda': 'guanda',
  };
  return (aliases[name] ?? name).replace(/\s/g, '');
}

function languageIdentity(value: string): string | null {
  const code = normalizedText(value).split(' ')[0];
  const aliases: Record<string, string> = {
    it: 'it', ita: 'it', italian: 'it', italiano: 'it',
    en: 'en', eng: 'en', english: 'en', inglese: 'en',
    fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', francais: 'fr', francese: 'fr',
    de: 'de', deu: 'de', ger: 'de', german: 'de', deutsch: 'de', tedesco: 'de',
    es: 'es', spa: 'es', spanish: 'es', espanol: 'es', spagnolo: 'es',
    pt: 'pt', por: 'pt', portuguese: 'pt', portugues: 'pt', portoghese: 'pt',
    zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh', cinese: 'zh',
    ja: 'ja', jpn: 'ja', japanese: 'ja', giapponese: 'ja',
    ko: 'ko', kor: 'ko', korean: 'ko', coreano: 'ko',
    ru: 'ru', rus: 'ru', russian: 'ru', russo: 'ru',
    la: 'la', lat: 'la', latin: 'la', latino: 'la',
  };
  return aliases[code] ?? (/^[a-z]{2}$/.test(code) ? code : null);
}

function mismatch(observation: Observation, candidate: InternalCandidate): string | null {
  if (candidate.ebookConflict) return EBOOK_REASON;
  if (observation.title && !titlesAgree(observation.title, candidate.title)) {
    return 'Il titolo del catalogo non coincide con quello letto nella foto.';
  }
  if (observation.authors.length > 0 && !observation.authors.every(
    (author) => candidate.authors.some((other) => authorsAgree(author, other)),
  )) {
    return 'L’autore del catalogo non coincide con quello letto nella foto, oppure manca.';
  }
  if (observation.publisher && candidate.publisher) {
    const observed = publisherIdentity(observation.publisher);
    const catalog = publisherIdentity(candidate.publisher);
    if (observed && catalog && observed !== catalog) return 'L’editore del catalogo non coincide con quello letto nella foto.';
  }
  if (observation.language && candidate.language) {
    const observed = languageIdentity(observation.language);
    const catalog = languageIdentity(candidate.language);
    if (observed && catalog && observed !== catalog) return 'La lingua del catalogo non coincide con quella osservata.';
  }
  return null;
}

function cloneCandidates(candidates: InternalCandidate[]): CatalogCandidate[] {
  return candidates.map(({ ebookConflict: _ebookConflict, ...candidate }) => ({
    ...candidate, authors: [...candidate.authors], categories: [...(candidate.categories ?? [])],
  }));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError');
  }
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function readJsonBounded(response: Response, source: CatalogSource, signal: AbortSignal): Promise<unknown> {
  const sizeError = () => new Error(source + ': risposta troppo grande, consulta di nuovo il catalogo.');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw sizeError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(source + ': risposta del catalogo vuota.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw sizeError();
      }
      chunks.push(value);
    }
    throwIfAborted(signal);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}

function googleIsbns(volume: JsonObject): string[] {
  return [...new Set(array(object(volume.volumeInfo).industryIdentifiers).flatMap((value) => {
    const identifier = object(value);
    if (identifier.type !== 'ISBN_10' && identifier.type !== 'ISBN_13') return [];
    const isbn = toIsbn13(string(identifier.identifier));
    return isbn ? [isbn] : [];
  }))];
}

function googleCandidate(value: unknown, exactIsbn?: string): InternalCandidate | null {
  const volume = object(value);
  const info = object(volume.volumeInfo);
  const id = string(volume.id, 150);
  const title = string(info.title);
  if (!id || !title) return null;
  const isbns = googleIsbns(volume);
  if (exactIsbn && !isbns.includes(exactIsbn)) return null;
  const ebookConflict = object(volume.saleInfo).isEbook === true;
  return {
    id: 'google:' + id,
    title,
    authors: strings(info.authors),
    isbn13: exactIsbn ?? (isbns.length === 1 ? isbns[0] : null),
    publisher: string(info.publisher),
    publishedDate: string(info.publishedDate, 80),
    language: string(info.language, 30),
    pageCount: positiveInteger(info.pageCount),
    description: catalogueText(info.description),
    categories: catalogueCategories(info.categories),
    thumbnail: imageUrl(object(info.imageLinks).thumbnail ?? object(info.imageLinks).smallThumbnail),
    source: 'Google Books',
    sourceUrl: 'https://books.google.com/books?id=' + encodeURIComponent(id),
    score: exactIsbn ? 1 : 0,
    matchReason: ebookConflict ? EBOOK_REASON
      : exactIsbn ? 'ISBN presente negli identificativi del catalogo.' : 'Edizione proposta dal catalogo: da confermare.',
    ebookConflict,
  };
}

function openLibraryCandidate(value: unknown, key: string, exactIsbn?: string): InternalCandidate | null {
  const data = object(value);
  const title = string(data.title);
  if (!title) return null;
  const identifiers = object(data.identifiers);
  const isbns = [...new Set([...strings(identifiers.isbn_13), ...strings(identifiers.isbn_10)]
    .map(toIsbn13).filter((isbn): isbn is string => isbn !== null))];
  if (exactIsbn && !isbns.includes(exactIsbn)) return null;
  const editionId = strings(identifiers.openlibrary).find((id) => /^OL\d+M$/.test(id))
    ?? (key.startsWith('OLID:') && /^OL\d+M$/.test(key.slice(5)) ? key.slice(5) : null);
  if (!editionId && !exactIsbn) return null;
  const languageValue = array(data.languages)[0];
  const language = typeof languageValue === 'string' ? string(languageValue, 30)
    : string(object(languageValue).key, 80)?.replace('/languages/', '') ?? null;
  return {
    id: 'openlibrary:' + (editionId ?? 'ISBN:' + exactIsbn),
    title,
    authors: array(data.authors).map((author) => string(object(author).name, 200))
      .filter((name): name is string => !!name).slice(0, 20),
    isbn13: exactIsbn ?? (isbns.length === 1 ? isbns[0] : null),
    publisher: array(data.publishers).map((publisher) => string(object(publisher).name))
      .filter(Boolean).join('; ') || null,
    publishedDate: string(data.publish_date, 80),
    language,
    pageCount: positiveInteger(data.number_of_pages),
    // Only fields returned with this edition; never fill from a work/search aggregate.
    description: catalogueText(typeof data.description === 'string' ? data.description : object(data.description).value),
    categories: catalogueCategories(data.subjects),
    thumbnail: imageUrl(object(data.cover).medium ?? object(data.cover).small),
    source: 'Open Library',
    sourceUrl: editionId ? 'https://openlibrary.org/books/' + editionId : 'https://openlibrary.org/isbn/' + exactIsbn,
    score: exactIsbn ? 1 : 0,
    matchReason: exactIsbn ? 'ISBN presente nella scheda dell’edizione.' : 'Edizione proposta dal catalogo: da confermare.',
  };
}

function rankCandidates(candidates: InternalCandidate[], query: string): InternalCandidate[] {
  const tokens = normalizedText(query).split(' ').filter((token) => token.length > 1);
  return candidates.map((candidate) => {
    const haystack = normalizedText(candidate.title + ' ' + candidate.authors.join(' '));
    const score = tokens.length ? tokens.filter((token) => haystack.includes(token)).length / tokens.length : 0;
    return { ...candidate, score };
  }).sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
}

export function createCatalogService(options: CatalogServiceOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = Math.max(0, options.openLibraryIntervalMs ?? 1_000);
  const cache = new Map<string, { value: unknown; expiresAt: number }>();
  const providerCooldowns = new Map<CatalogSource, { until: number; message: string }>();
  let openLibraryTail: Promise<void> = Promise.resolve();
  let nextOpenLibraryStart = 0;

  function checkProviderCooldown(source: CatalogSource): void {
    const cooldown = providerCooldowns.get(source);
    if (!cooldown) return;
    const remainingMs = cooldown.until - Date.now();
    if (remainingMs <= 0) {
      providerCooldowns.delete(source);
      return;
    }
    throw new Error(cooldown.message + ' Nuovo tentativo disponibile tra ' + Math.ceil(remainingMs / 1_000) + ' s.');
  }

  // One gate shared by every lookup on this service, including parallel scan jobs.
  async function paceOpenLibrary(signal?: AbortSignal): Promise<void> {
    const turn = openLibraryTail.then(async () => {
      throwIfAborted(signal);
      await delay(Math.max(0, nextOpenLibraryStart - Date.now()), signal);
      throwIfAborted(signal);
      nextOpenLibraryStart = Date.now() + intervalMs;
    });
    openLibraryTail = turn.catch(() => undefined);
    if (!signal) return turn;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      turn.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }

  async function requestJson(url: URL, source: CatalogSource, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const key = url.href;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      cache.delete(key);
      cache.set(key, cached);
      return cached.value;
    }
    if (cached) cache.delete(key);
    checkProviderCooldown(source);
    if (source === 'Open Library') await paceOpenLibrary(signal);
    throwIfAborted(signal);
    // A queued request may have learned about the outage while waiting for its turn.
    checkProviderCooldown(source);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const failure = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(source + ': tempo di attesa scaduto.'));
        }, REQUEST_TIMEOUT_MS);
        onAbort = () => {
          controller.abort();
          reject(signal?.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
      const request = (async () => {
        const response = await fetchImpl(url.href, {
          headers: {
            Accept: 'application/json',
            ...(source === 'Open Library'
              ? { 'User-Agent': options.userAgent ?? 'Jemiq/1.0 (+https://github.com/emilioquattrini/jemiq)' }
              : {}),
          },
          redirect: 'error',
          signal: controller.signal,
        });
        if (!response.ok) {
          const reason = response.status === 429 ? 'limite di richieste raggiunto'
            : 'servizio temporaneamente non disponibile';
          const message = source + ': ' + reason + ' (HTTP ' + response.status + ').';
          if (response.status === 429 || response.status === 503) {
            providerCooldowns.set(source, {
              until: Date.now() + providerCooldownMs(response.headers.get('retry-after')),
              message,
            });
          }
          void response.body?.cancel().catch(() => undefined);
          throw new Error(message);
        }
        const value = await readJsonBounded(response, source, controller.signal);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error(source + ': risposta del catalogo non valida.');
        }
        const data = object(value);
        if (source === 'Google Books' && url.pathname === '/books/v1/volumes' && (
          (data.items !== undefined && !Array.isArray(data.items))
          || (data.items === undefined && typeof data.totalItems !== 'number')
        )) {
          throw new Error(source + ': risposta del catalogo non valida.');
        }
        if (source === 'Open Library' && url.pathname === '/search.json' && !Array.isArray(data.docs)) {
          throw new Error(source + ': risposta del catalogo non valida.');
        }
        return value;
      })();
      const value = await Promise.race([request, failure]);
      throwIfAborted(signal);
      cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
      return value;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }

  async function tryProvider(
    source: CatalogSource,
    work: () => Promise<InternalCandidate[]>,
    issues: string[],
    signal?: AbortSignal,
  ): Promise<InternalCandidate[]> {
    try {
      return await work();
    } catch (error) {
      throwIfAborted(signal);
      const message = error instanceof Error && error.message.startsWith(source + ':')
        ? error.message : source + ': impossibile consultare il catalogo.';
      issues.push(message);
      return [];
    }
  }

  async function googleSearch(query: string, signal?: AbortSignal, exactIsbn?: string): Promise<InternalCandidate[]> {
    const url = new URL('https://www.googleapis.com/books/v1/volumes');
    url.search = new URLSearchParams({ q: query, maxResults: String(MAX_CANDIDATES), printType: 'books' }).toString();
    if (options.googleBooksApiKey) url.searchParams.set('key', options.googleBooksApiKey);
    const data = object(await requestJson(url, 'Google Books', signal));
    return array(data.items).map((value) => googleCandidate(value, exactIsbn))
      .filter((candidate): candidate is InternalCandidate => candidate !== null);
  }

  async function openLibraryEditions(keys: string[], signal?: AbortSignal, exactIsbn?: string): Promise<InternalCandidate[]> {
    if (keys.length === 0) return [];
    const url = new URL('https://openlibrary.org/api/books');
    url.search = new URLSearchParams({ bibkeys: keys.join(','), format: 'json', jscmd: 'data' }).toString();
    const data = object(await requestJson(url, 'Open Library', signal));
    return keys.map((key) => openLibraryCandidate(data[key], key, exactIsbn))
      .filter((candidate): candidate is InternalCandidate => candidate !== null);
  }

  async function openLibrarySearch(query: string, signal?: AbortSignal): Promise<InternalCandidate[]> {
    const url = new URL('https://openlibrary.org/search.json');
    url.search = new URLSearchParams({
      q: query, limit: '3', lang: 'it',
      fields: 'key,title,editions,editions.key,edition_key',
    }).toString();
    const data = object(await requestJson(url, 'Open Library', signal));
    const keys = [...new Set(array(data.docs).flatMap((value) => {
      const doc = object(value);
      const editions = array(object(doc.editions).docs).map((edition) => string(object(edition).key));
      const identifiers = editions.length > 0 ? editions : strings(doc.edition_key).slice(0, 1);
      return identifiers.flatMap((key) => {
        const id = key?.replace(/^\/books\//, '');
        return id && /^OL\d+M$/.test(id) ? ['OLID:' + id] : [];
      });
    }))].slice(0, 3);
    // Work-level ISBN arrays are deliberately never read. Resolve actual editions in one batch.
    return openLibraryEditions(keys, signal);
  }

  async function lookupTitle(query: string, fieldQuery: string, signal?: AbortSignal): Promise<LookupResult> {
    const issues: string[] = [];
    let candidates = await tryProvider('Google Books', () => googleSearch(fieldQuery, signal), issues, signal);
    if (!candidates.length && !issues.length && fieldQuery !== query) {
      candidates = await tryProvider('Google Books', () => googleSearch(query, signal), issues, signal);
    }
    if (!candidates.length) {
      candidates = await tryProvider('Open Library', () => openLibrarySearch(query, signal), issues, signal);
    }
    return { candidates: rankCandidates(candidates, query), issues };
  }

  async function lookupIsbn(isbn: string, signal?: AbortSignal, observation?: Observation): Promise<LookupResult> {
    const issues: string[] = [];
    let candidates = await tryProvider('Google Books', () => googleSearch('isbn:' + isbn, signal, isbn), issues, signal);
    if (!candidates.some((candidate) => !observation || mismatch(observation, candidate) === null)) {
      const fallback = await tryProvider(
        'Open Library', () => openLibraryEditions(['ISBN:' + isbn], signal, isbn), issues, signal,
      );
      candidates = [...candidates, ...fallback];
    }
    // A second provider without format data must not erase an explicit ebook conflict.
    if (candidates.some((candidate) => candidate.ebookConflict)) {
      candidates = candidates.map((candidate) => ({ ...candidate, ebookConflict: true, matchReason: EBOOK_REASON }));
    }
    if (observation) {
      candidates.sort((a, b) => Number(mismatch(observation, a) !== null) - Number(mismatch(observation, b) !== null));
    }
    return { candidates: candidates.slice(0, MAX_CANDIDATES), issues };
  }

  async function search(query: string, signal?: AbortSignal): Promise<CatalogCandidate[]> {
    throwIfAborted(signal);
    const cleanQuery = query.trim().slice(0, 500);
    if (!cleanQuery) return [];
    const isbn = toIsbn13(cleanQuery);
    const result = isbn ? await lookupIsbn(isbn, signal) : await lookupTitle(cleanQuery, cleanQuery, signal);
    if (result.candidates.length === 0 && ['Google Books', 'Open Library'].every(
      (source) => result.issues.some((issue) => issue.startsWith(source + ':')),
    )) {
      throw new CatalogError();
    }
    return cloneCandidates(result.candidates);
  }

  async function getCandidate(reference: CatalogReference, signal?: AbortSignal): Promise<CatalogCandidate | null> {
    throwIfAborted(signal);
    // Never fetch the supplied URL itself. Recognize only the links emitted by this
    // catalogue and construct an API URL from a validated provider identifier.
    if (typeof reference?.sourceUrl !== 'string' || reference.sourceUrl.length > 2_000) return null;
    let sourceUrl: URL;
    try { sourceUrl = new URL(reference.sourceUrl); } catch { return null; }
    if (sourceUrl.protocol !== 'https:' || sourceUrl.username || sourceUrl.password || sourceUrl.port || sourceUrl.hash) return null;
    const isbn = reference.isbn13 ? toIsbn13(reference.isbn13) : null;
    if (reference.isbn13 && !isbn) return null;
    const issues: string[] = [];
    let candidates: InternalCandidate[];
    if (reference.source === 'Google Books') {
      const id = sourceUrl.searchParams.get('id');
      if (sourceUrl.hostname !== 'books.google.com' || sourceUrl.pathname !== '/books'
        || sourceUrl.searchParams.getAll('id').length !== 1 || [...sourceUrl.searchParams.keys()].some((key) => key !== 'id')
        || !id || !/^[A-Za-z0-9_-]{1,150}$/.test(id)) return null;
      candidates = await tryProvider('Google Books', async () => {
        const url = new URL('https://www.googleapis.com/books/v1/volumes/' + encodeURIComponent(id));
        if (options.googleBooksApiKey) url.searchParams.set('key', options.googleBooksApiKey);
        const value = await requestJson(url, 'Google Books', signal);
        const candidate = googleCandidate(value, isbn ?? undefined);
        return candidate?.id === 'google:' + id ? [candidate] : [];
      }, issues, signal);
    } else if (reference.source === 'Open Library') {
      if (sourceUrl.hostname !== 'openlibrary.org' || sourceUrl.search) return null;
      const editionId = /^\/books\/(OL\d{1,12}M)$/.exec(sourceUrl.pathname)?.[1];
      const urlIsbn = /^\/isbn\/([\dXx-]{10,20})$/.exec(sourceUrl.pathname)?.[1];
      const requestedIsbn = urlIsbn ? toIsbn13(urlIsbn) : null;
      if (!editionId && !requestedIsbn) return null;
      if (isbn && requestedIsbn && isbn !== requestedIsbn) return null;
      candidates = await tryProvider('Open Library', async () => {
        const result = await openLibraryEditions(
          [editionId ? 'OLID:' + editionId : 'ISBN:' + requestedIsbn], signal, isbn ?? requestedIsbn ?? undefined,
        );
        return result.filter((candidate) => !editionId || candidate.id === 'openlibrary:' + editionId);
      }, issues, signal);
    } else return null;
    if (issues.length) throw new CatalogError();
    return cloneCandidates(candidates)[0] ?? null;
  }

  async function enrich(observation: Observation, signal?: AbortSignal): Promise<BookRecord> {
    throwIfAborted(signal);
    const record: BookRecord = {
      id: randomUUID(),
      observation: { ...observation, authors: [...observation.authors], boundingBox: observation.boundingBox ? [...observation.boundingBox] : null },
      title: observation.title?.trim() || 'Libro da identificare',
      authors: [...observation.authors],
      isbn13: null,
      publisher: observation.publisher,
      publishedDate: null,
      language: observation.language,
      pageCount: null,
      thumbnail: null,
      source: null,
      sourceUrl: null,
      status: 'unresolved',
      candidates: [],
      notes: '',
      quantity: 1,
      selected: true,
    };
    const notes: string[] = [];
    const isbn = toIsbn13(observation.visibleIsbn);
    if (observation.visibleIsbn && !isbn) {
      notes.push('Il codice letto non è un ISBN valido: controlla le cifre sul libro.');
    }
    let result: LookupResult;
    if (isbn) {
      result = await lookupIsbn(isbn, signal, observation);
      const candidate = result.candidates.find((item) => item.isbn13 === isbn && mismatch(observation, item) === null);
      if (candidate) {
        return {
          ...record,
          title: candidate.title,
          authors: [...candidate.authors],
          isbn13: isbn,
          publisher: candidate.publisher,
          publishedDate: candidate.publishedDate,
          language: candidate.language,
          pageCount: candidate.pageCount,
          description: candidate.description ?? null,
          categories: [...(candidate.categories ?? [])],
          thumbnail: candidate.thumbnail,
          source: candidate.source,
          sourceUrl: candidate.sourceUrl,
          status: 'verified',
          candidates: cloneCandidates(result.candidates),
          notes: ['ISBN letto nella foto e riscontrato nel catalogo.', ...result.issues].join(' '),
        };
      }
      if (result.candidates.length) {
        notes.push('L’ISBN esiste nel catalogo, ma i dati non coincidono con la foto: conferma l’edizione.');
        notes.push(...new Set(result.candidates.map((candidate) => mismatch(observation, candidate)).filter((reason): reason is string => !!reason)));
      } else {
        notes.push('L’ISBN letto è formalmente valido, ma non è stato riscontrato nei cataloghi.');
      }
    } else if (observation.title?.trim()) {
      const title = observation.title.trim().slice(0, 300);
      const authors = observation.authors.join(' ').slice(0, 180);
      const query = [title, authors].filter(Boolean).join(' ');
      const fieldQuery = 'intitle:"' + title.replace(/"/g, '') + '"'
        + (authors ? ' inauthor:"' + authors.replace(/"/g, '') + '"' : '');
      result = await lookupTitle(query, fieldQuery, signal);
      if (result.candidates.length) notes.push('Titolo riconosciuto. L’ISBN appartiene a un’edizione proposta: confermala prima di esportarlo.');
      else notes.push('Nessuna edizione trovata: i dati letti nella foto sono conservati e modificabili.');
    } else {
      result = { candidates: [], issues: [] };
      notes.push('Titolo o ISBN non leggibili. Aggiungi i dati o scatta una foto più vicina.');
    }
    // Candidate metadata remains in candidates until a person confirms the edition.
    // In particular, never attach the first result's publisher, cover or ISBN to the observed title.
    record.candidates = cloneCandidates(result.candidates);
    record.status = result.candidates.length ? 'review' : 'unresolved';
    record.notes = [...notes, ...result.issues].join(' ');
    return record;
  }

  return { enrich, search, getCandidate };
}
