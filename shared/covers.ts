import { toIsbn13 } from './isbn';
import { normalizeLanguageIdentity, normalizePublisherIdentity } from './book-groups';
import type { BookRecord } from './types';

export const COVER_UNAVAILABLE = 'Copertina non disponibile';
const COVER_HOSTS = new Set(['books.google.com', 'books.googleusercontent.com', 'covers.openlibrary.org']);

/** Only public catalogue image hosts; never accept credentials or an arbitrary proxy target. */
export function normalizeCoverUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !COVER_HOSTS.has(url.hostname)
      || url.username || url.password || url.port) return null;
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  } catch { return null; }
}

const normalize = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLocaleLowerCase('it-IT').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const authorKey = (authors: string[]) => authors.map(normalize).filter(Boolean).sort().join('|');

/** An indicative image never confirms an ISBN or mutates the bibliographic record. */
export function resolveBookCover(book: BookRecord): { url: string | null; suggested: boolean } {
  const actual = normalizeCoverUrl(book.thumbnail);
  if (actual) return { url: actual, suggested: false };
  const title = normalize(book.title);
  if (!title || ['libro da identificare', 'titolo da completare', 'nuovo libro'].includes(title)) {
    return { url: null, suggested: false };
  }
  const authors = authorKey(book.authors);
  const isbn = toIsbn13(book.isbn13);
  const titleCandidates = book.candidates.filter(candidate => normalize(candidate.title) === title);
  const candidateAuthors = new Set(titleCandidates.map(candidate => authorKey(candidate.authors)).filter(Boolean));
  const unambiguousTitle = title.split(' ').length >= 2 && title.replace(/\s/g, '').length >= 8 && candidateAuthors.size === 1;
  for (const candidate of book.candidates) {
    const url = normalizeCoverUrl(candidate.thumbnail);
    if (!url || normalize(candidate.title) !== title) continue;
    if (authors ? authorKey(candidate.authors) !== authors : !isbn && !unambiguousTitle) continue;
    if (isbn && toIsbn13(candidate.isbn13) !== isbn) continue;
    if (book.publisher && candidate.publisher && normalizePublisherIdentity(book.publisher) !== normalizePublisherIdentity(candidate.publisher)) continue;
    if (book.language && candidate.language && normalizeLanguageIdentity(book.language) !== normalizeLanguageIdentity(candidate.language)) continue;
    if (book.publishedDate && candidate.publishedDate && book.publishedDate.slice(0, 4) !== candidate.publishedDate.slice(0, 4)) continue;
    return { url, suggested: !isbn };
  }
  return { url: null, suggested: false };
}
