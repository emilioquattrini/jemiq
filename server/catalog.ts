import { randomUUID } from 'node:crypto';
import type { BookRecord, CatalogCandidate, CatalogSource, Observation } from '../shared/types';
import { toIsbn13 } from '../shared/isbn';

export interface CatalogServiceOptions {
  fetchImpl?: typeof fetch;
  googleBooksApiKey?: string;
  userAgent?: string;
  /** Keep the default in production. A shorter interval is useful in isolated tests. */
  openLibraryIntervalMs?: number;
  /** Bounds a complete lookup, including provider fallback and pacing. */
  lookupTimeoutMs?: number;
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
type LookupResult = { candidates: InternalCandidate[]; issues: string[]; incomplete?: boolean };

/** Only locally authored provider messages may enter a book's notes. */
class ProviderError extends Error {}
class LookupTimeout extends Error {}

const REQUEST_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const LOOKUP_TIMEOUT_MS = 16_000;
const TITLE_FALLBACK_DELAY_MS = 1_200;
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
  const sizeError = () => new ProviderError(source + ': risposta troppo grande, consulta di nuovo il catalogo.');
  const declaredSize = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw sizeError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError(source + ': risposta del catalogo vuota.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  let finished = false;
  const abort = () => { void reader.cancel(signal.reason).catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw sizeError();
      }
      chunks.push(value);
    }
    throwIfAborted(signal);
    finished = true;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) void reader.cancel().catch(() => undefined);
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

function rankCandidates(candidates: InternalCandidate[], query: string, observation?: Observation): InternalCandidate[] {
  const tokens = normalizedText(query).split(' ').filter((token) => token.length > 1);
  return candidates.map((candidate) => {
    const haystack = normalizedText(candidate.title + ' ' + candidate.authors.join(' '));
    const score = tokens.length ? tokens.filter((token) => haystack.includes(token)).length / tokens.length : 0;
    return { ...candidate, score };
  }).sort((a, b) => (observation
    ? Number(mismatch(observation, a) !== null) - Number(mismatch(observation, b) !== null) : 0)
    || b.score - a.score).slice(0, MAX_CANDIDATES);
}

export function createCatalogService(options: CatalogServiceOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs = Number.isFinite(options.openLibraryIntervalMs)
    ? Math.min(60_000, Math.max(0, options.openLibraryIntervalMs!)) : 1_000;
  const lookupTimeoutMs = Number.isFinite(options.lookupTimeoutMs) && options.lookupTimeoutMs! > 0
    ? Math.min(30_000, options.lookupTimeoutMs!) : LOOKUP_TIMEOUT_MS;
  const cache = new Map<string, { value: unknown; expiresAt: number; bytes: number }>();
  let cacheBytes = 0;
  type PendingRequest = { promise: Promise<unknown>; controller: AbortController; consumers: number; settled: boolean };
  const pendingRequests = new Map<string, PendingRequest>();
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
    throw new ProviderError(cooldown.message + ' Nuovo tentativo disponibile tra ' + Math.ceil(remainingMs / 1_000) + ' s.');
  }

  function pauseProvider(source: CatalogSource, message: string, retryAfter: string | null = null) {
    const until = Date.now() + providerCooldownMs(retryAfter);
    if ((providerCooldowns.get(source)?.until ?? 0) < until) providerCooldowns.set(source, { until, message });
  }

  function removeCached(key: string) {
    const cached = cache.get(key);
    if (cached) cacheBytes -= cached.bytes;
    cache.delete(key);
  }

  function readCached(key: string): { value: unknown } | undefined {
    const cached = cache.get(key);
    if (!cached) return;
    if (cached.expiresAt <= Date.now()) { removeCached(key); return; }
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  function remember(key: string, value: unknown) {
    // Conservatively account for UTF-16 strings, as well as the entry count. The
    // cache must remain small on serverless runtimes and modest Node instances.
    const bytes = JSON.stringify(value).length * 2;
    if (bytes > MAX_CACHE_BYTES) return;
    removeCached(key);
    for (const [entryKey, entry] of cache) if (entry.expiresAt <= Date.now()) removeCached(entryKey);
    cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS, bytes });
    cacheBytes += bytes;
    while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) removeCached(cache.keys().next().value as string);
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

  async function performRequest(url: URL, source: CatalogSource, signal: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const key = url.href;
    const controller = new AbortController();
    let networkStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const failure = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const message = source + (networkStarted ? ': tempo di attesa scaduto.' : ': coda di richieste occupata, riprova tra poco.');
          const error = new ProviderError(message);
          if (networkStarted) pauseProvider(source, message);
          controller.abort(error);
          reject(error);
        }, REQUEST_TIMEOUT_MS);
        onAbort = () => {
          const error = signal.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError');
          controller.abort(error);
          reject(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const request = (async () => {
        checkProviderCooldown(source);
        if (source === 'Open Library') await paceOpenLibrary(controller.signal);
        throwIfAborted(controller.signal);
        // Another request can populate the cache or learn about an outage while
        // this one is waiting for the provider's permitted request rate.
        const cached = readCached(key);
        if (cached) return cached.value;
        checkProviderCooldown(source);
        networkStarted = true;
        const response = await fetchImpl(url.href, {
          headers: {
            Accept: 'application/json',
            ...(source === 'Open Library'
              ? { 'User-Agent': options.userAgent ?? 'Jemiq/1.0 (+https://github.com/emilioquattrini/jemiq)' }
              : {}),
          },
          // Workers rejects redirect:'error'; manual also prevents forwarding
          // an optional catalogue key to a different endpoint.
          redirect: 'manual',
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throwIfAborted(controller.signal);
        }
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError(source + ': reindirizzamento inatteso del catalogo.');
        }
        if (!response.ok) {
          const reason = response.status === 429 ? 'limite di richieste raggiunto'
            : 'servizio temporaneamente non disponibile';
          const message = source + ': ' + reason + ' (HTTP ' + response.status + ').';
          if (response.status === 429 || response.status >= 500) pauseProvider(source, message, response.headers.get('retry-after'));
          void response.body?.cancel().catch(() => undefined);
          throw new ProviderError(message);
        }
        const value = await readJsonBounded(response, source, controller.signal);
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new ProviderError(source + ': risposta del catalogo non valida.');
        }
        const data = object(value);
        if (Object.hasOwn(data, 'error')) throw new ProviderError(source + ': risposta del catalogo non valida.');
        if (source === 'Google Books' && url.pathname === '/books/v1/volumes' && (
          (data.items !== undefined && !Array.isArray(data.items))
          || (data.items === undefined && typeof data.totalItems !== 'number')
        )) {
          throw new ProviderError(source + ': risposta del catalogo non valida.');
        }
        if (source === 'Open Library' && url.pathname === '/search.json' && !Array.isArray(data.docs)) {
          throw new ProviderError(source + ': risposta del catalogo non valida.');
        }
        return value;
      })();
      const value = await Promise.race([request, failure]);
      throwIfAborted(signal);
      remember(key, value);
      return value;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof ProviderError) throw error;
      const message = source + ': impossibile consultare il catalogo.';
      if (networkStarted) pauseProvider(source, message);
      throw new ProviderError(message);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async function requestJson(url: URL, source: CatalogSource, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    const key = url.href;
    const cached = readCached(key);
    if (cached) return cached.value;
    let pending = pendingRequests.get(key);
    if (!pending || pending.controller.signal.aborted) {
      if (pendingRequests.size >= MAX_PENDING_REQUESTS) throw new ProviderError(source + ': molte ricerche in corso, riprova tra poco.');
      pending = { promise: Promise.resolve(), controller: new AbortController(), consumers: 0, settled: false };
      pendingRequests.set(key, pending);
      pending.promise = performRequest(url, source, pending.controller.signal);
      const current = pending;
      const settled = () => {
        current.settled = true;
        if (pendingRequests.get(key) === current) pendingRequests.delete(key);
      };
      void current.promise.then(settled, settled);
    }
    const current = pending;
    current.consumers++;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (result: { value: unknown } | { error: unknown }) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', abort);
        current.consumers--;
        if (!current.consumers && !current.settled) {
          current.controller.abort(new DOMException('Nessuna ricerca in attesa.', 'AbortError'));
          if (pendingRequests.get(key) === current) pendingRequests.delete(key);
        }
        if ('error' in result) reject(result.error); else resolve(result.value);
      };
      const abort = () => finish({ error: signal?.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError') });
      signal?.addEventListener('abort', abort, { once: true });
      void current.promise.then((value) => finish({ value }), (error: unknown) => finish({ error }));
      if (signal?.aborted) abort();
    });
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
      const message = error instanceof ProviderError
        ? error.message : source + ': impossibile consultare il catalogo.';
      issues.push(message);
      return [];
    }
  }

  async function boundedLookup(
    work: (signal: AbortSignal, result: LookupResult) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<LookupResult> {
    throwIfAborted(signal);
    const controller = new AbortController();
    const result: LookupResult = { candidates: [], issues: [] };
    const abort = () => controller.abort(signal?.reason instanceof Error ? signal.reason : new DOMException('Operazione annullata.', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    let rejectAbort: () => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new LookupTimeout('Catalog lookup deadline')), lookupTimeoutMs);
    try {
      if (signal?.aborted) abort();
      await Promise.race([work(controller.signal, result), stopped]);
      return { candidates: [...result.candidates], issues: [...result.issues] };
    } catch (error) {
      throwIfAborted(signal);
      if (!(controller.signal.reason instanceof LookupTimeout)) throw error;
      return {
        candidates: [...result.candidates],
        issues: [...result.issues, 'La ricerca nei cataloghi ha raggiunto il tempo disponibile. I dati già ricevuti sono conservati; puoi completare o ripetere la ricerca di questo libro.'],
        incomplete: true,
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
      controller.abort();
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

  async function lookupTitle(query: string, fieldQuery: string, signal?: AbortSignal, observation?: Observation): Promise<LookupResult> {
    return boundedLookup(async (lookupSignal, result) => {
      const googleController = new AbortController();
      const openController = new AbortController();
      const googleSignal = AbortSignal.any([lookupSignal, googleController.signal]);
      const openSignal = AbortSignal.any([lookupSignal, openController.signal]);
      // A quick but unrelated result is not a useful reason to cancel the other
      // catalogue. Term coverage ranks manual searches; it is not a probability.
      const useful = (candidates: InternalCandidate[]) => candidates.some((candidate) =>
        observation ? mismatch(observation, candidate) === null : candidate.score >= 0.6);
      let googleCandidates: InternalCandidate[] = [];
      const google = (async (): Promise<LookupResult> => {
        const issues: string[] = [];
        let candidates = await tryProvider('Google Books', () => googleSearch(fieldQuery, googleSignal), issues, googleSignal);
        if (!candidates.length && !issues.length && fieldQuery !== query) {
          candidates = await tryProvider('Google Books', () => googleSearch(query, googleSignal), issues, googleSignal);
        }
        googleCandidates = rankCandidates(candidates, query, observation);
        return { candidates: googleCandidates, issues };
      })();
      const open = (async (): Promise<LookupResult> => {
        // A fast primary response avoids a second provider call. A slow primary
        // must not hold up an available fallback until its full timeout expires.
        await Promise.race([delay(TITLE_FALLBACK_DELAY_MS, openSignal), google.then(() => undefined)]);
        throwIfAborted(openSignal);
        const issues: string[] = [];
        if (useful(googleCandidates)) return { candidates: [], issues };
        return { candidates: await tryProvider('Open Library', () => openLibrarySearch(query, openSignal), issues, openSignal), issues };
      })();
      const pending = new Map([
        ['google', google.then((value) => ({ provider: 'google', value }))],
        ['open', open.then((value) => ({ provider: 'open', value }))],
      ]);
      try {
        while (pending.size) {
          const { provider, value } = await Promise.race(pending.values());
          pending.delete(provider);
          result.issues.push(...value.issues);
          if (value.candidates.length) {
            // These are suggestions only. An ISBN from a title search is never
            // attached to the observed book without the user's confirmation.
            result.candidates = rankCandidates([...result.candidates, ...value.candidates], query, observation);
            if (useful(result.candidates)) return;
          }
        }
      } finally {
        googleController.abort();
        openController.abort();
      }
    }, signal);
  }

  async function lookupIsbn(isbn: string, signal?: AbortSignal, observation?: Observation): Promise<LookupResult> {
    const result = await boundedLookup(async (lookupSignal, result) => {
      result.candidates = await tryProvider('Google Books', () => googleSearch('isbn:' + isbn, lookupSignal, isbn), result.issues, lookupSignal);
      if (!result.candidates.some((candidate) => !observation || mismatch(observation, candidate) === null)) {
        const fallback = await tryProvider(
          'Open Library', () => openLibraryEditions(['ISBN:' + isbn], lookupSignal, isbn), result.issues, lookupSignal,
        );
        result.candidates = [...result.candidates, ...fallback];
      }
    }, signal);
    let candidates = result.candidates;
    // A second provider without format data must not erase an explicit ebook conflict.
    if (candidates.some((candidate) => candidate.ebookConflict)) {
      candidates = candidates.map((candidate) => ({ ...candidate, ebookConflict: true, matchReason: EBOOK_REASON }));
    }
    if (observation) {
      candidates.sort((a, b) => Number(mismatch(observation, a) !== null) - Number(mismatch(observation, b) !== null));
    }
    return { ...result, candidates: candidates.slice(0, MAX_CANDIDATES) };
  }

  async function search(query: string, signal?: AbortSignal): Promise<CatalogCandidate[]> {
    throwIfAborted(signal);
    const cleanQuery = query.trim().slice(0, 500);
    if (!cleanQuery) return [];
    const isbn = toIsbn13(cleanQuery);
    const result = isbn ? await lookupIsbn(isbn, signal) : await lookupTitle(cleanQuery, cleanQuery, signal);
    if (result.candidates.length === 0 && (result.incomplete || ['Google Books', 'Open Library'].every(
      (source) => result.issues.some((issue) => issue.startsWith(source + ':')),
    ))) {
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
      result = await lookupTitle(query, fieldQuery, signal, observation);
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
