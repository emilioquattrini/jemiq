import { toIsbn13 } from './isbn';
import { MAX_BOOK_QUANTITY, type BookRecord, type BookStatus, type CatalogCandidate, type Observation } from './types';

const MAX_OBSERVATIONS = 5000;
const MAX_CANDIDATES = 30;
const MAX_NOTES = 2000;
const ISBN_CONFLICT = 'Stesso ISBN con dati di edizione in conflitto: righe tenute separate. Verifica titolo, autore, editore, lingua e anno.';
const REVIEW_GROUP = 'Il gruppo comprende copie ancora da verificare. Controlla tutte le prove prima di confermare l’edizione.';
const MIXED_SOURCES = 'I dati del gruppo provengono da più copie. Controlla le prove e le edizioni proposte per le rispettive fonti.';
const LIMITED_CANDIDATES = 'Sono mostrate le prime 30 edizioni proposte per il gruppo.';
const PLACEHOLDER_TITLES = new Set(['libro da identificare', 'titolo da completare', 'nuovo libro', 'un libro da completare']);

function normalized(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function normalizePublisherIdentity(value: string | null | undefined): string {
  const original = normalized(value);
  const name = original.replace(/\b(?:s p a|s r l|spa|srl|ltd|limited|inc|incorporated)\b/g, '')
    .replace(/\b(?:editore|editori|edizioni|publisher|publishers|publishing|books|press)\b/g, '')
    .trim().replace(/\s+/g, ' ');
  const aliases: Record<string, string> = {
    'giangiacomo feltrinelli': 'feltrinelli', 'arnoldo mondadori': 'mondadori',
    'giulio einaudi': 'einaudi', 'ugo guanda': 'guanda',
  };
  return aliases[name] ?? (name || original);
}

export function normalizeLanguageIdentity(value: string | null | undefined): string {
  const name = normalized(value).split(' ')[0] ?? '';
  const aliases: Record<string, string> = {
    it: 'it', ita: 'it', italian: 'it', italiano: 'it',
    en: 'en', eng: 'en', english: 'en', inglese: 'en',
    fr: 'fr', fra: 'fr', fre: 'fr', french: 'fr', francais: 'fr', francese: 'fr',
    de: 'de', deu: 'de', ger: 'de', german: 'de', deutsch: 'de', tedesco: 'de',
    es: 'es', spa: 'es', spanish: 'es', espanol: 'es', spagnolo: 'es',
    pt: 'pt', por: 'pt', portuguese: 'pt', portugues: 'pt', portoghese: 'pt',
    ja: 'ja', jpn: 'ja', japanese: 'ja', giapponese: 'ja',
    zh: 'zh', zho: 'zh', chi: 'zh', chinese: 'zh', cinese: 'zh',
  };
  return aliases[name] ?? normalized(value);
}

function year(value: string | null): string {
  return value?.match(/(?:^|\D)(\d{4})(?:\D|$)/)?.[1] ?? normalized(value);
}

function authorNames(authors: string[]): string {
  return [...new Set(authors.map(normalized).filter(Boolean))].sort().join('\0');
}

function observationKey(observation: Observation): string {
  return JSON.stringify([observation.title, observation.authors, observation.visibleIsbn, observation.publisher,
    observation.language, observation.evidence, observation.position, observation.confidence, observation.boundingBox]);
}

function cloneObservation(observation: Observation): Observation {
  return { ...observation, authors: [...observation.authors], boundingBox: observation.boundingBox ? [...observation.boundingBox] : null };
}

/** Existing aggregates are authoritative: the primary legacy observation is included only once. */
export function observationsFor(book: BookRecord): Observation[] {
  const observations = book.observations?.length ? book.observations : [book.observation];
  const primary = observationKey(book.observation);
  const complete = observations.some((item) => observationKey(item) === primary) ? observations : [book.observation, ...observations];
  return complete.map(cloneObservation);
}

interface Identity {
  isbn: string | null;
  invalidIsbn: boolean;
  title: string;
  authors: string;
  publishers: Set<string>;
  languages: Set<string>;
  years: Set<string>;
  visibleIsbns: Set<string>;
}

function values(items: Array<string | null | undefined>, normalize: (value: string | null | undefined) => string): Set<string> {
  return new Set(items.map(normalize).filter(Boolean));
}

function identity(book: BookRecord): Identity {
  const observations = observationsFor(book);
  const isbn = toIsbn13(book.isbn13);
  return {
    isbn, invalidIsbn: !!book.isbn13?.trim() && !isbn, title: normalized(book.title), authors: authorNames(book.authors),
    publishers: values([book.publisher, ...observations.map((item) => item.publisher)], normalizePublisherIdentity),
    languages: values([book.language, ...observations.map((item) => item.language)], normalizeLanguageIdentity),
    years: new Set([year(book.publishedDate)].filter(Boolean)),
    visibleIsbns: new Set([isbn, ...observations.map((item) => toIsbn13(item.visibleIsbn))].filter((item): item is string => item !== null)),
  };
}

function contradictory(left: Identity, right: Identity): boolean {
  if (left.invalidIsbn || right.invalidIsbn) return true;
  if (left.title && right.title && left.title !== right.title) return true;
  if (left.authors && right.authors && left.authors !== right.authors) return true;
  return (['publishers', 'languages', 'years', 'visibleIsbns'] as const)
    .some((field) => new Set([...left[field], ...right[field]]).size > 1);
}

function sharedValue(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function sharedYear(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((value) => /^\d{4}$/.test(value) && right.has(value));
}

function keyFor(item: Identity): string | null {
  if (item.invalidIsbn) return null;
  if (item.isbn) return 'isbn:' + item.isbn;
  // Missing OCR text must not identify a book through an app-generated placeholder.
  // Real titles entered manually remain usable even when the original observation was blank.
  if (!item.title || PLACEHOLDER_TITLES.has(item.title)) return null;
  if (item.authors) return 'title:' + item.title + '\0authors:' + item.authors;
  // A generic title without an author is not enough to identify another physical copy.
  if (item.title.split(' ').length < 3 || item.title.replace(/\s/g, '').length < 12) return null;
  if (!item.publishers.size && ![...item.years].some((value) => /^\d{4}$/.test(value))) return null;
  return 'title:' + item.title + '\0authors:unknown';
}

function canMerge(left: Identity, right: Identity): boolean {
  if (contradictory(left, right)) return false;
  if (left.isbn || right.isbn) return left.isbn !== null && left.isbn === right.isbn;
  if (left.title !== right.title || left.authors !== right.authors) return false;
  return !!left.authors || sharedValue(left.publishers, right.publishers) || sharedYear(left.years, right.years);
}

function combinedIdentity(first: Identity, next: Identity): Identity {
  return { ...first, title: first.title || next.title, authors: first.authors || next.authors,
    publishers: new Set([...first.publishers, ...next.publishers]), languages: new Set([...first.languages, ...next.languages]),
    years: new Set([...first.years, ...next.years]), visibleIsbns: new Set([...first.visibleIsbns, ...next.visibleIsbns]) };
}

function notes(parts: string[], priority: string[] = []): string {
  const lines = [...new Set([...priority, ...parts.flatMap((part) => part.split('\n'))].map((line) => line.trim()).filter(Boolean))];
  const combined = lines.join('\n');
  const suffix = '… [note abbreviate]';
  return combined.length <= MAX_NOTES ? combined : combined.slice(0, MAX_NOTES - suffix.length) + suffix;
}

function cloneCandidate(candidate: CatalogCandidate): CatalogCandidate {
  return { ...candidate, authors: [...candidate.authors], ...(candidate.categories ? { categories: [...candidate.categories] } : {}) };
}

function cloneBook(book: BookRecord): BookRecord {
  return { ...book, isbn13: toIsbn13(book.isbn13) ?? book.isbn13, authors: [...book.authors], observation: cloneObservation(book.observation),
    observations: observationsFor(book), candidates: book.candidates.map(cloneCandidate),
    ...(book.categories ? { categories: [...book.categories] } : {}) };
}

function combinedStatus(left: BookStatus, right: BookStatus): BookStatus {
  if (left === 'verified' && right === 'verified') return 'verified';
  if ([left, right].every((status) => status === 'verified' || status === 'confirmed')) return 'confirmed';
  return left === 'unresolved' && right === 'unresolved' ? 'unresolved' : 'review';
}

function merge(first: BookRecord, next: BookRecord): BookRecord {
  const quantity = first.quantity + next.quantity;
  if (!Number.isSafeInteger(quantity) || quantity > MAX_BOOK_QUANTITY) {
    throw new RangeError('La quantità complessiva del gruppo supera ' + MAX_BOOK_QUANTITY + '. Nessuna copia è stata eliminata.');
  }
  // Both rows are private clones. Append once, instead of recloning a growing evidence array
  // for every copy in a large legacy catalogue; caller-owned arrays are never mutated.
  const observations = first.observations!;
  const additional = next.observations!;
  if (observations.length + additional.length > MAX_OBSERVATIONS) throw new RangeError('Il gruppo supera 5000 prove fotografiche. Nessuna prova è stata eliminata.');
  observations.push(...additional);
  const merged = { ...first, quantity, selected: first.selected || next.selected, observations,
    status: combinedStatus(first.status, next.status) };
  let completedIdentity = false;
  if (!normalized(merged.title) && normalized(next.title)) { merged.title = next.title; completedIdentity = true; }
  if (!authorNames(merged.authors) && authorNames(next.authors)) { merged.authors = [...next.authors]; completedIdentity = true; }
  if (!normalizePublisherIdentity(merged.publisher) && normalizePublisherIdentity(next.publisher)) { merged.publisher = next.publisher; completedIdentity = true; }
  if (!year(merged.publishedDate) && year(next.publishedDate)) { merged.publishedDate = next.publishedDate; completedIdentity = true; }
  if (!normalizeLanguageIdentity(merged.language) && normalizeLanguageIdentity(next.language)) { merged.language = next.language; completedIdentity = true; }
  if (!merged.thumbnail && first.isbn13 && toIsbn13(first.isbn13) === toIsbn13(next.isbn13)) merged.thumbnail = next.thumbnail;
  const mixedSources = completedIdentity && (first.source !== next.source || first.sourceUrl !== next.sourceUrl);
  if (mixedSources) { merged.source = null; merged.sourceUrl = null; }
  const candidates = new Map<string, CatalogCandidate>();
  for (const candidate of [...first.candidates, ...next.candidates]) {
    const key = candidate.source + '\0' + candidate.id;
    if (!candidates.has(key)) candidates.set(key, cloneCandidate(candidate));
  }
  merged.candidates = [...candidates.values()].slice(0, MAX_CANDIDATES);
  merged.notes = notes([first.notes, next.notes], [
    ...(mixedSources ? [MIXED_SOURCES] : []),
    ...(merged.status === 'review' && (first.status === 'verified' || first.status === 'confirmed' || next.status === 'verified' || next.status === 'confirmed') ? [REVIEW_GROUP] : []),
    ...(candidates.size > MAX_CANDIDATES ? [LIMITED_CANDIDATES] : []),
  ]);
  return merged;
}

/**
 * Groups copies within one photograph. ISBN-bearing rows never absorb title-only rows.
 * The first row keeps its ID, order and existing metadata; quantities are always added,
 * independently of the number of observations or earlier manual quantity edits.
 */
export function groupBooks(books: BookRecord[]): BookRecord[] {
  const groups: Array<{ book: BookRecord; identity: Identity; conflict: boolean }> = [];
  const indexes = new Map<string, number[]>();
  for (const original of books) {
    const book = cloneBook(original);
    if (!Number.isSafeInteger(book.quantity) || book.quantity < 1 || book.quantity > MAX_BOOK_QUANTITY) throw new RangeError('La quantità del libro non è valida.');
    if (book.observations!.length > MAX_OBSERVATIONS) throw new RangeError('Il gruppo supera 5000 prove fotografiche. Nessuna prova è stata eliminata.');
    const item = identity(book);
    const key = keyFor(item);
    const previous = key ? indexes.get(key) ?? [] : [];
    let target: number | undefined;
    let conflict = false;
    for (const index of previous) {
      const group = groups[index];
      if (item.isbn && contradictory(group.identity, item)) { group.conflict = true; conflict = true; }
      if (target === undefined && canMerge(group.identity, item)) target = index;
    }
    if (target !== undefined) {
      const group = groups[target];
      group.book = merge(group.book, book);
      group.identity = combinedIdentity(group.identity, item);
      group.conflict ||= conflict;
    } else {
      const index = groups.push({ book, identity: item, conflict }) - 1;
      if (key) indexes.set(key, [...previous, index]);
    }
  }
  return groups.map(({ book, conflict }) => conflict ? { ...book, status: 'review', notes: notes([book.notes], [ISBN_CONFLICT]) } : book);
}
