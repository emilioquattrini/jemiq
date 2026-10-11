import { describe, expect, it } from 'vitest';
import { groupBooks, observationsFor } from '../shared/book-groups';
import { bookSchema, scanEventSchema } from '../shared/schemas';
import { MAX_BOOK_QUANTITY, type BookRecord, type CatalogCandidate, type Observation } from '../shared/types';

const ISBN = '9780306406157';
const OTHER_ISBN = '9780141183534';

function observation(position: string, patch: Partial<Observation> = {}): Observation {
  return { title: 'Le città invisibili', authors: ['Italo Calvino'], visibleIsbn: null, publisher: null, language: null,
    evidence: 'LE CITTÀ INVISIBILI — ITALO CALVINO', position, confidence: 'high', boundingBox: [10, 20, 200, 400], ...patch };
}

function book(id: string, patch: Partial<BookRecord> = {}): BookRecord {
  return { id, observation: observation(id), title: 'Le città invisibili', authors: ['Italo Calvino'], isbn13: null,
    publisher: null, publishedDate: null, language: null, pageCount: null, thumbnail: null, source: null, sourceUrl: null,
    status: 'review', candidates: [], notes: '', quantity: 1, selected: true, ...patch };
}

function verified(id: string, patch: Partial<BookRecord> = {}): BookRecord {
  return book(id, { isbn13: ISBN, status: 'verified', observation: observation(id, { visibleIsbn: ISBN }), ...patch });
}

function candidate(id: number): CatalogCandidate {
  return { id: 'google:' + id, title: 'Le città invisibili', authors: ['Italo Calvino'], isbn13: ISBN,
    publisher: 'Einaudi', publishedDate: '1972', language: 'it', pageCount: 165, thumbnail: null,
    source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=' + id, score: 1, matchReason: 'Edizione proposta.' };
}

describe('physical copies in one photograph', () => {
  it('groups valid ISBN-10 and ISBN-13 representations without changing the first ID or primary proof', () => {
    const first = verified('first', { isbn13: '0-306-40615-2', observation: observation('left', { visibleIsbn: '0-306-40615-2' }) });
    const second = verified('second', { isbn13: '978 0 306 40615 7', observation: observation('right', { visibleIsbn: '978 0 306 40615 7', boundingBox: [10, 500, 200, 900] }) });
    const grouped = groupBooks([first, second]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ id: 'first', isbn13: ISBN, quantity: 2, status: 'verified', observation: first.observation });
    expect(observationsFor(grouped[0])).toEqual([first.observation, second.observation]);
    expect(first.isbn13).toBe('0-306-40615-2');
  });

  it('sums edited quantities, keeps original order, and preserves selection with OR', () => {
    const first = book('first', { quantity: 7, selected: false });
    const another = book('other', { title: 'Un libro diverso', quantity: 2 });
    const second = book('second', { title: ' LE CITTA INVISIBILI! ', authors: ['ITALO CALVINO'], quantity: 4 });
    const grouped = groupBooks([first, another, second]);
    expect(grouped.map((item) => item.id)).toEqual(['first', 'other']);
    expect(grouped[0]).toMatchObject({ title: first.title, quantity: 11, selected: true, isbn13: null });
    expect(observationsFor(grouped[0])).toHaveLength(2);
    expect(groupBooks([{ ...first, selected: false }, { ...second, selected: false }])[0].selected).toBe(false);
  });

  it('matches complete titles and the same nonempty author set, regardless of author order', () => {
    const first = book('a', { title: '1984', authors: ['George Orwell', 'Jane Editor'] });
    const second = book('b', { title: '1984', authors: ['JANE EDITOR', 'George Orwell'] });
    expect(groupBooks([first, second])).toHaveLength(1);
    expect(groupBooks([first, { ...second, authors: ['Another Writer'] }])).toHaveLength(2);
    expect(groupBooks([book('a', { title: 'Storia: volume primo' }), book('b', { title: 'Storia: volume secondo' })])).toHaveLength(2);
  });

  it('keeps ISBN editions distinct and never lends a known ISBN to a title-only copy', () => {
    const known = verified('known');
    const undecided = book('undecided', { observation: observation('second', { visibleIsbn: ISBN }) });
    const anotherEdition = verified('other', { isbn13: OTHER_ISBN, observation: observation('third', { visibleIsbn: OTHER_ISBN }) });
    const grouped = groupBooks([known, undecided, anotherEdition]);
    expect(grouped).toHaveLength(3);
    expect(grouped.map((item) => item.isbn13)).toEqual([ISBN, null, OTHER_ISBN]);
    expect(grouped[1].status).toBe('review');
    expect(grouped[0].status).toBe('verified');
    expect(grouped[2].status).toBe('verified');
  });

  it('keeps differing visible ISBNs apart even when neither edition has been verified', () => {
    const first = book('a', { observation: observation('a', { visibleIsbn: ISBN }) });
    const second = book('b', { observation: observation('b', { visibleIsbn: OTHER_ISBN }) });
    expect(groupBooks([first, second])).toHaveLength(2);
    const invalid = book('invalid', { isbn13: '9780306406158' });
    expect(groupBooks([invalid, book('unverified')])).toHaveLength(2);
    expect(groupBooks([invalid])[0].isbn13).toBe('9780306406158');
  });

  it.each([
    ['publisher', 'Einaudi', 'Feltrinelli'],
    ['language', 'it', 'en'],
    ['publishedDate', '1972', '2020-04-01'],
  ] as const)('does not merge an explicitly different %s, with or without a known ISBN', (field, firstValue, secondValue) => {
    for (const known of [false, true]) {
      const make = known ? verified : book;
      const grouped = groupBooks([make('first', { [field]: firstValue }), make('second', { [field]: secondValue })]);
      expect(grouped).toHaveLength(2);
      if (known) {
        expect(grouped.every((item) => item.status === 'review')).toBe(true);
        expect(grouped.every((item) => item.notes.includes('Stesso ISBN'))).toBe(true);
      }
    }
  });

  it('accepts equivalent publisher names, language codes and date precision within one year', () => {
    const first = verified('first', { publisher: 'Giangiacomo Feltrinelli Editore S.p.A.', language: 'ita', publishedDate: '1972' });
    const second = verified('second', { publisher: 'Feltrinelli', language: 'it-IT', publishedDate: '1972-10-01' });
    expect(groupBooks([first, second])).toHaveLength(1);
    expect(groupBooks([first, second])[0].publishedDate).toBe('1972');
  });

  it.each([
    { title: 'Un altro titolo' },
    { authors: ['Un altro autore'] },
  ])('keeps contradictory data for one ISBN in separate visible review rows', (patch) => {
    const grouped = groupBooks([verified('first'), verified('second', patch)]);
    expect(grouped).toHaveLength(2);
    expect(grouped.every((item) => item.status === 'review')).toBe(true);
    expect(grouped.every((item) => item.notes.includes('righe tenute separate'))).toBe(true);
    expect(grouped[1]).toMatchObject(patch);
    expect(groupBooks(grouped)).toEqual(grouped);
  });

  it('does not use missing metadata as a bridge between contradictory editions', () => {
    const first = verified('first', { source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=first' });
    const second = verified('second', { publisher: 'Einaudi', source: 'Open Library', sourceUrl: 'https://openlibrary.org/books/OL1M' });
    const third = verified('third', { publisher: 'Feltrinelli' });
    const grouped = groupBooks([first, second, third]);
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ id: 'first', quantity: 2, publisher: 'Einaudi', source: null, sourceUrl: null, status: 'review' });
    expect(grouped[0].notes).toContain('più copie');
    expect(groupBooks(grouped)).toEqual(grouped);
    const partialYears = groupBooks([book('a'), book('b', { publishedDate: '1972' }), book('c', { publishedDate: '2020' })]);
    expect(partialYears).toHaveLength(2);
    expect(groupBooks(partialYears)).toEqual(partialYears);
  });

  it('requires additional edition evidence for a full title with an unknown author', () => {
    expect(groupBooks([book('a', { title: 'Poesie', authors: [], publisher: 'Einaudi' }), book('b', { title: 'Poesie', authors: [], publisher: 'Einaudi' })])).toHaveLength(2);
    expect(groupBooks([book('a', { authors: [] }), book('b', { authors: [] })])).toHaveLength(2);
    expect(groupBooks([book('a', { authors: [], publisher: 'Einaudi' }), book('b', { authors: [], publisher: 'Einaudi' })])).toHaveLength(1);
    expect(groupBooks([book('a', { authors: [], publishedDate: '1972' }), book('b', { authors: [], publishedDate: '1972-10' })])).toHaveLength(1);
    expect(groupBooks([book('a', { publisher: 'Einaudi' }), book('b', { authors: [], publisher: 'Einaudi' })])).toHaveLength(2);
  });

  it('does not collapse blank manual rows', () => {
    const empty = { title: '', authors: [], observation: observation('', { title: null, authors: [], evidence: '', boundingBox: null }) };
    expect(groupBooks([book('a', empty), book('b', empty)])).toHaveLength(2);
  });

  it.each(['Libro da identificare', 'Titolo da completare', 'Nuovo libro'])('does not aggregate the %s placeholder when OCR found no title', (title) => {
    const unknown = { title, authors: [], publisher: 'Einaudi', status: 'unresolved' as const,
      observation: observation('unknown', { title: null, authors: [], publisher: 'Einaudi', evidence: 'Editore leggibile; titolo coperto.' }) };
    expect(groupBooks([book('first', unknown), book('second', unknown)])).toHaveLength(2);
    const corrected = { ...unknown, title: 'Le città invisibili', authors: ['Italo Calvino'], status: 'confirmed' as const };
    expect(groupBooks([book('first', corrected), book('second', corrected)])).toHaveLength(1);
  });

  it('keeps the least certain aggregate status and never upgrades a review copy', () => {
    const mixed = groupBooks([verified('first'), verified('second', { status: 'review' })])[0];
    expect(mixed.status).toBe('review');
    expect(mixed.notes).toContain('ancora da verificare');
    expect(groupBooks([verified('first'), verified('second', { status: 'confirmed' })])[0].status).toBe('confirmed');
    expect(groupBooks([book('first', { status: 'unresolved' }), book('second', { status: 'unresolved' })])[0].status).toBe('unresolved');
  });
});

describe('aggregate evidence and portable limits', () => {
  it('preserves every position and bounding box without duplicating the legacy proof on repeated grouping', () => {
    const first = book('a', { quantity: 5 });
    const second = book('b', { observation: observation('right', { boundingBox: [50, 500, 250, 950] }) });
    const third = book('c', { observation: observation('back row', { boundingBox: null }) });
    const grouped = groupBooks([first, second, third]);
    expect(observationsFor(grouped[0])).toEqual([first.observation, second.observation, third.observation]);
    expect(grouped[0].quantity).toBe(7);
    expect(groupBooks(grouped)).toEqual(grouped);
    expect(groupBooks(groupBooks(grouped))).toEqual(grouped);
    const withoutPrimary = { ...first, observations: [second.observation] };
    expect(observationsFor(withoutPrimary)).toEqual([first.observation, second.observation]);
    expect(observationsFor({ ...first, observations: [first.observation, first.observation] })).toHaveLength(2);
  });

  it('does not alias mutable input observations, candidates or author arrays', () => {
    const first = book('a', { candidates: [candidate(1)], categories: ['Fiction'] });
    const saved = structuredClone(first);
    const grouped = groupBooks([first, book('b')]);
    grouped[0].authors[0] = 'Changed';
    grouped[0].observations![0].authors[0] = 'Changed';
    grouped[0].observations![0].boundingBox![0] = 999;
    grouped[0].candidates[0].authors[0] = 'Changed';
    grouped[0].categories![0] = 'Changed';
    expect(first).toEqual(saved);
  });

  it('preserves the first existing metadata while merging candidate suggestions within schema limits', () => {
    const first = book('a', { notes: 'a'.repeat(2000), candidates: Array.from({ length: 20 }, (_, index) => candidate(index)),
      pageCount: 165, description: 'First catalogue synopsis.', categories: ['Fiction'], thumbnail: 'https://books.google.com/first.jpg' });
    const second = book('b', { notes: 'b'.repeat(2000), candidates: [candidate(0), ...Array.from({ length: 20 }, (_, index) => candidate(index + 20))],
      pageCount: 200, description: 'Different synopsis.', categories: ['Other'], thumbnail: 'https://books.google.com/second.jpg' });
    const grouped = groupBooks([first, second])[0];
    expect(grouped).toMatchObject({ pageCount: 165, description: first.description, categories: ['Fiction'], thumbnail: first.thumbnail });
    expect(grouped.candidates).toHaveLength(30);
    expect(new Set(grouped.candidates.map((item) => item.id)).size).toBe(30);
    expect(grouped.notes.length).toBeLessThanOrEqual(2000);
    expect(grouped.notes).toContain('prime 30');
    expect(bookSchema.safeParse(grouped).success).toBe(true);
    expect(groupBooks([grouped])[0]).toEqual(grouped);
  });

  it('fills a missing thumbnail only from a compatible copy with the same valid ISBN', () => {
    const thumbnail = 'https://covers.openlibrary.org/b/id/12345-M.jpg';
    const known = groupBooks([verified('first'), verified('second', { thumbnail })])[0];
    expect(known).toMatchObject({ thumbnail, status: 'verified', isbn13: ISBN });
    expect(groupBooks([book('first'), book('second', { thumbnail })])[0].thumbnail).toBeNull();
    const conflict = groupBooks([verified('first'), verified('second', { title: 'Altro libro', thumbnail })]);
    expect(conflict).toHaveLength(2);
    expect(conflict[0].thumbnail).toBeNull();
  });

  it('supports quantities above the former limit without truncating or splitting copies', () => {
    const grouped = groupBooks([book('a', { quantity: 9999 }), book('b', { quantity: 2 })]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].quantity).toBe(10001);
    expect(bookSchema.safeParse(grouped[0]).success).toBe(true);
    expect(groupBooks([book('a', { quantity: MAX_BOOK_QUANTITY - 1 }), book('b')])[0].quantity).toBe(MAX_BOOK_QUANTITY);
    const tooMany = [book('a', { quantity: MAX_BOOK_QUANTITY }), book('b')];
    expect(() => groupBooks(tooMany)).toThrow(RangeError);
    expect(tooMany[0].quantity).toBe(MAX_BOOK_QUANTITY);
    expect(bookSchema.safeParse(book('a', { quantity: MAX_BOOK_QUANTITY + 1 })).success).toBe(false);
  });

  it('preserves 5000 observations and fails explicitly rather than discarding an excess proof', () => {
    const first = book('first');
    const complete = { ...first, observations: [first.observation, ...Array.from({ length: 4999 }, (_, index) => observation(String(index)))] };
    expect(bookSchema.safeParse(complete).success).toBe(true);
    expect(groupBooks([complete])[0].observations).toHaveLength(5000);
    expect(() => groupBooks([complete, book('another')])).toThrow('5000 prove');
    expect(complete.observations).toHaveLength(5000);
    expect(bookSchema.safeParse({ ...complete, observations: [...complete.observations, observation('extra')] }).success).toBe(false);
  });

  it('aggregates all 5000 legacy rows at their previous maximum without losing quantity or evidence order', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => book(String(index), { quantity: 9999 }));
    const grouped = groupBooks(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].quantity).toBe(MAX_BOOK_QUANTITY);
    expect(grouped[0].observations?.map((item) => item.position)).toEqual(rows.map((item) => item.observation.position));
    expect(groupBooks(grouped)).toEqual(grouped);
    expect(rows[0].quantity).toBe(9999);
  });

  it('accepts legacy events and retains grouped observations and removed IDs in new events', () => {
    const legacy = { type: 'book', book: book('first'), completed: 1, total: 2 };
    expect(scanEventSchema.safeParse(legacy).success).toBe(true);
    const grouped = groupBooks([book('first'), book('second')])[0];
    const event = scanEventSchema.parse({ ...legacy, book: grouped, completed: 2, removedIds: ['second'] });
    expect(event).toMatchObject({ removedIds: ['second'], book: { observations: grouped.observations, quantity: 2 } });
  });
});
