import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { COVER_UNAVAILABLE } from '../shared/covers';
import { groupBooks } from '../shared/book-groups';
import { MAX_BOOK_QUANTITY } from '../shared/types';
import type { BookRecord, CatalogCandidate, ScanSession } from '../shared/types';
import { applyCatalogUpdate } from '../src/App';
import BookCover from '../src/components/BookCover';
import BookEditor from '../src/components/BookEditor';
import { createManualBook } from '../src/lib/books';

const candidate: CatalogCandidate = {
  id: 'openlibrary:edition', title: 'Le città invisibili', authors: ['Italo Calvino'], isbn13: '9780156453806',
  publisher: 'Einaudi', publishedDate: '1972', language: 'it', pageCount: 165,
  thumbnail: 'https://covers.openlibrary.org/b/id/123-M.jpg', source: 'Open Library',
  sourceUrl: 'https://openlibrary.org/books/OL123M', score: 1, matchReason: 'Titolo e autore corrispondono.',
};

function book(patch: Partial<BookRecord> = {}): BookRecord {
  return { ...createManualBook(), title: candidate.title, authors: [...candidate.authors], ...patch };
}

describe('cover presentation', () => {
  it('renders the exact visible fallback for a missing or rejected image URL', () => {
    for (const thumbnail of [null, 'https://example.com/private-cover.jpg', 'javascript:alert(1)']) {
      const html = renderToStaticMarkup(createElement(BookCover, { book: book({ thumbnail }) }));
      expect(html).toContain(`<span class="book-cover-note">${COVER_UNAVAILABLE}</span>`);
      expect(html).not.toContain('<img');
    }
  });

  it('renders the normalized edition image and meaningful alternative text', () => {
    const html = renderToStaticMarkup(createElement(BookCover, { book: book({ thumbnail: 'http://covers.openlibrary.org/b/id/345-M.jpg#fragment' }) }));
    expect(html).toContain('src="https://covers.openlibrary.org/b/id/345-M.jpg"');
    expect(html).toContain('alt="Copertina di Le città invisibili"');
    expect(html).toContain('loading="lazy"');
    expect(html).not.toContain(COVER_UNAVAILABLE);
  });

  it('marks a coherent suggested cover without changing the book or confirming its ISBN', () => {
    const record = book({ candidates: [candidate], status: 'review' });
    const snapshot = structuredClone(record);
    const html = renderToStaticMarkup(createElement(BookCover, { book: record }));
    expect(html).toContain('src="https://covers.openlibrary.org/b/id/123-M.jpg"');
    expect(html).toContain('Copertina indicativa');
    expect(record).toEqual(snapshot);
    expect(record.isbn13).toBeNull();
  });

  it('does not present a different book candidate as the current cover', () => {
    const html = renderToStaticMarkup(createElement(BookCover, { book: book({ candidates: [{ ...candidate, title: 'Un altro romanzo' }] }) }));
    expect(html).toContain(COVER_UNAVAILABLE);
    expect(html).not.toContain('<img');
  });

  it('also uses a visible fallback inside an edition candidate', () => {
    const html = renderToStaticMarkup(createElement(BookCover, { candidate: { ...candidate, thumbnail: null } }));
    expect(html).toContain(COVER_UNAVAILABLE);
    expect(html).not.toContain('<img');
  });
});

describe('group review presentation', () => {
  it('keeps the original catalog snapshot and exposes an error if a change overflows a group', () => {
    const first = book({ quantity: MAX_BOOK_QUANTITY });
    const second = book({ title: 'Un altro libro' });
    const current: ScanSession = {
      id: 'overflow-catalog', name: 'Il mio catalogo', mode: 'shelf', image: null,
      createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z',
      books: [first, second], warnings: [], isDemo: false,
    };
    const snapshot = structuredClone(current);
    const next = applyCatalogUpdate({ current, error: null }, (session) => ({
      ...session!, books: groupBooks(session!.books.map((record) => record.id === second.id ? { ...record, title: first.title } : record)),
    }));
    expect(next.current).toBe(current);
    expect(current).toEqual(snapshot);
    expect(next.error).toContain('Modifica non applicata');
    expect(next.error).toContain('Il catalogo precedente è conservato');
    expect(next.error).toContain(String(MAX_BOOK_QUANTITY));
  });

  it('shows every photographed position and makes the scope of edition confirmation explicit', () => {
    const first = book();
    first.observation = { ...first.observation, title: first.title, evidence: 'Prima copia sul ripiano', position: 'A sinistra' };
    const second = book({ quantity: 2 });
    second.observation = { ...second.observation, title: second.title, evidence: 'Seconda copia sul ripiano', position: 'A destra', visibleIsbn: '9780156453806' };
    const grouped = groupBooks([first, second])[0];
    const html = renderToStaticMarkup(createElement(BookEditor, {
      book: grouped, onSave: () => {}, onDelete: () => {}, onAccessRequired: () => {}, onClose: () => {},
    }));
    expect(html).toContain('3 copie in catalogo');
    expect(html).toContain('si applicano a tutte le');
    expect(html).toContain('2 letture nella foto');
    expect(html).toContain('Prima copia sul ripiano');
    expect(html).toContain('Seconda copia sul ripiano');
    expect(html).toContain('Posizione: A sinistra');
    expect(html).toContain('Posizione: A destra');
    expect(html).toContain('9780156453806');
    expect(html).toContain(`max="${MAX_BOOK_QUANTITY}"`);
    expect(html).toContain(COVER_UNAVAILABLE);
  });
});
