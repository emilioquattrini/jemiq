import type { BookRecord, CatalogCandidate } from '../../shared/types';
import { toIsbn13 } from '../../shared/isbn';

export function createManualBook(): BookRecord {
  return {
    id: crypto.randomUUID(),
    observation: { title: null, authors: [], visibleIsbn: null, publisher: null, language: null, evidence: '', position: '', confidence: 'low', boundingBox: null },
    title: '', authors: [], isbn13: null, publisher: null, publishedDate: null,
    language: null, pageCount: null, thumbnail: null, source: null, sourceUrl: null,
    status: 'unresolved', candidates: [], notes: '', quantity: 1, selected: true,
  };
}

export function confirmCandidate(book: BookRecord, candidate: CatalogCandidate): BookRecord {
  const isbn13 = candidate.isbn13 ? toIsbn13(candidate.isbn13) : null;
  if (candidate.isbn13 && !isbn13) throw new Error('Il codice ISBN di questa edizione non è valido. Scegli un altro risultato.');
  return {
    ...book, title: candidate.title, authors: [...candidate.authors], isbn13,
    publisher: candidate.publisher, publishedDate: candidate.publishedDate, language: candidate.language,
    pageCount: candidate.pageCount, thumbnail: candidate.thumbnail, source: candidate.source,
    description: candidate.description ?? null, categories: [...(candidate.categories ?? [])],
    sourceUrl: candidate.sourceUrl, status: 'confirmed', notes: 'Edizione scelta e confermata dall’utente.',
  };
}

export function updateBook(book: BookRecord, patch: Partial<BookRecord>): BookRecord {
  const updated = { ...book, ...patch, id: book.id, observation: book.observation };
  updated.title = updated.title.trim().slice(0, 2000);
  updated.authors = updated.authors.map(author => author.trim()).filter(Boolean).slice(0, 30);
  if (updated.isbn13?.trim()) {
    const normalized = toIsbn13(updated.isbn13);
    if (!normalized) throw new Error('L’ISBN non è valido: controlla tutte le cifre. Puoi lasciarlo vuoto.');
    updated.isbn13 = normalized;
  } else updated.isbn13 = null;
  if (!Number.isInteger(updated.quantity) || updated.quantity < 1 || updated.quantity > 9999) throw new Error('Inserisci una quantità tra 1 e 9999.');
  const changed = ['title', 'authors', 'isbn13', 'publisher', 'publishedDate', 'language', 'pageCount'].some(key => JSON.stringify(updated[key as keyof BookRecord]) !== JSON.stringify(book[key as keyof BookRecord]));
  const identityChanged = ['title', 'authors', 'isbn13'].some(key => JSON.stringify(updated[key as keyof BookRecord]) !== JSON.stringify(book[key as keyof BookRecord]));
  if (changed) {
    // A human correction is not a machine-verified catalogue match. Preserve the observation for auditing.
    updated.status = patch.status === 'confirmed' ? 'confirmed' : updated.title ? 'review' : 'unresolved';
    updated.source = null;
    updated.sourceUrl = null;
    updated.notes = [updated.notes, 'Dati modificati manualmente.'].filter(Boolean).join(' ').slice(0, 2000);
    updated.thumbnail = null;
    // A sourced synopsis must not outlive a manual change to its bibliographic identity.
    updated.description = null;
    updated.categories = [];
    if (identityChanged) {
      // Old edition metadata is not evidence for a newly entered title/ISBN.
      // Keep only fields actually changed by the user in this same edit.
      for (const key of ['publisher', 'publishedDate', 'language', 'pageCount'] as const) {
        if (!(key in patch) || patch[key] === book[key]) updated[key] = null;
      }
      updated.candidates = [];
    }
  }
  if (updated.status === 'confirmed' && !updated.title) throw new Error('Inserisci almeno il titolo prima di confermare.');
  if ((updated.status === 'review' || updated.status === 'unresolved') && updated.isbn13) {
    // Manual entry is kept only with explicit confirmation; avoid accidentally exporting unverified codes.
    if (patch.status !== 'confirmed') updated.isbn13 = null;
  }
  return updated;
}

const normalized = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function findDuplicates(books: BookRecord[]): Set<string> {
  const groups = new Map<string, BookRecord[]>();
  const duplicateIds = new Set<string>();
  for (const book of books) {
    const title = normalized(book.title);
    if (!title && !book.isbn13) continue;
    const keys = [book.isbn13 ? `isbn:${book.isbn13}` : '', title ? `title:${title}|${book.authors.map(normalized).sort().join('|')}` : ''].filter(Boolean);
    for (const key of keys) {
      const previous = groups.get(key) ?? [];
      for (const other of previous) {
        // Different confirmed ISBNs identify different editions, not duplicate rows.
        if (book.isbn13 && other.isbn13 && book.isbn13 !== other.isbn13) continue;
        duplicateIds.add(book.id); duplicateIds.add(other.id);
      }
      previous.push(book);
      groups.set(key, previous);
    }
  }
  return duplicateIds;
}
