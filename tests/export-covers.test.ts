import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookRecord, CatalogCandidate, ScanSession } from '../shared/types';
import { COVER_UNAVAILABLE } from '../shared/covers';
import { groupBooks } from '../shared/book-groups';
import { createCsv, createWorkbook, exportRows, EXPORT_COLUMNS } from '../src/lib/export';
import { createCoverLoader, loadExportCovers, EXPORT_COVER_DEADLINE_MS, MAX_EXPORT_COVER_BYTES, MAX_EXPORT_COVERS_BYTES, type CoverData } from '../src/lib/export-covers';

// Real tiny PNG bytes exercise XLSX embedding and transport only, without a network request.
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==', 'base64'));
const COVER = 'https://covers.openlibrary.org/b/id/123-S.jpg';
const ISBN = '9780743273565';
const coverData = (): CoverData => ({ bytes: PNG, mimeType: 'image/png' });
const coverUrl = (index: number) => `https://covers.openlibrary.org/b/id/${index}-S.jpg`;

function candidate(): CatalogCandidate {
  return { id: 'edition', title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'], isbn13: ISBN,
    publisher: 'Scribner', publishedDate: '2004', language: 'en', pageCount: 180, thumbnail: COVER,
    source: 'Open Library', sourceUrl: 'https://openlibrary.org/books/OL123M', score: 1, matchReason: 'Titolo e autore' };
}
function book(id: string, overrides: Partial<BookRecord> = {}): BookRecord {
  return { id, title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'], isbn13: null,
    publisher: 'Scribner', publishedDate: '2004', language: 'en', pageCount: null,
    thumbnail: null, source: null, sourceUrl: null, status: 'review', candidates: [candidate()],
    notes: `Nota ${id}`, quantity: 1, selected: true,
    observation: { title: 'The Great Gatsby', authors: ['F. Scott Fitzgerald'], visibleIsbn: null,
      publisher: 'Scribner', language: 'en', evidence: `Testo ${id}`, position: `Posizione ${id}`, confidence: 'high', boundingBox: null },
    ...overrides };
}
function session(books: BookRecord[]): ScanSession {
  return { id: 'catalog', name: 'Scaffale', createdAt: '2026-10-11T00:00:00.000Z', updatedAt: '2026-10-11T00:00:00.000Z', mode: 'shelf', image: null, books, warnings: ['Ripiano parzialmente coperto.'], isDemo: false };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('consolidated exports with honest cover provenance', () => {
  it('groups only selected copies, sums edited quantities and preserves all evidence without mutating the catalog', () => {
    const first = book('a', { quantity: 2 });
    first.observation.visibleIsbn = ISBN;
    const second = book('b', { quantity: 3 });
    second.observation.visibleIsbn = '978-0-7432-7356-5';
    const input = session([first, second, book('deselected', { quantity: 40, selected: false })]);
    const before = JSON.stringify(input);
    const rows = exportRows(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveLength(19);
    expect(rows[0][7]).toBe(5);
    expect(rows[0][0]).toBe('');
    expect(rows[0][9]).toBe(ISBN);
    expect(rows[0][12]).toBe('Testo a\nTesto b');
    expect(rows[0][13]).toBe('Posizione a\nPosizione b');
    expect(rows[0][15]).toBe(`${ISBN}\n978-0-7432-7356-5`);
    expect(rows[0][16]).toBe('Ripiano parzialmente coperto.');
    expect(rows[0].slice(17)).toEqual([COVER, 'indicativa']);
    expect(exportRows({ ...input, books: groupBooks(input.books.filter(item => item.selected)) })).toEqual(rows);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('keeps the original A–Q columns and writes a safe cover URL or the exact fallback in CSV without fetching', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const input = session([
      book('known', { status: 'confirmed', isbn13: ISBN, thumbnail: 'http://covers.openlibrary.org/b/id/123-S.jpg#fragment' }),
      book('missing', { title: 'Another title', candidates: [], thumbnail: 'https://covers.openlibrary.org.attacker.example/image.png' }),
    ]);
    expect(EXPORT_COLUMNS.slice(0, 17)).toEqual(['ISBN', 'Titolo', 'Autore', 'Editore', 'Data pubblicazione', 'Lingua', 'Pagine', 'Quantità', 'Stato', 'ISBN suggerito (da verificare)', 'Fonte', 'URL fonte', 'Testo letto nella foto', 'Posizione', 'Note', 'ISBN letto nella foto (non confermato)', 'Avvisi del catalogo']);
    expect(EXPORT_COLUMNS.slice(17)).toEqual(['Copertina', 'Tipo copertina']);
    const rows = exportRows(input);
    expect(rows[0].slice(17)).toEqual([COVER, 'edizione']);
    expect(rows[1].slice(17)).toEqual([COVER_UNAVAILABLE, '']);
    const csv = createCsv(input);
    expect(csv).toContain(`"${COVER}";"edizione"`);
    expect(csv).toContain(`"${COVER_UNAVAILABLE}";""`);
    expect(csv).not.toContain('attacker.example');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reopens an XLSX with consolidated quantities and embedded images while downloading a shared URL once', async () => {
    const input = session([
      book('copy-a', { quantity: 2 }), book('copy-b', { quantity: 3 }),
      book('chosen-edition', { quantity: 4, status: 'confirmed', isbn13: ISBN, thumbnail: COVER }),
    ]);
    const loadCover = vi.fn(async () => coverData());
    const workbook = await createWorkbook(input, { loadCover });
    const bytes = await workbook.xlsx.writeBuffer();
    const ExcelJS = (await import('exceljs')).default;
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(bytes);
    const sheet = reopened.getWorksheet('Libri')!;
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getCell('H2').value).toBe(5);
    expect(sheet.getCell('H3').value).toBe(4);
    expect(sheet.getCell('A2').value).toBe('');
    expect(sheet.getCell('A3').value).toBe(ISBN);
    expect(sheet.getCell('M2').value).toBe('Testo copy-a\nTesto copy-b');
    expect(sheet.getCell('N2').value).toBe('Posizione copy-a\nPosizione copy-b');
    expect(sheet.getCell('S2').value).toBe('indicativa');
    expect(sheet.getCell('S3').value).toBe('edizione');
    expect(sheet.getCell('T2').value).toBe(COVER);
    expect(sheet.getImages()).toHaveLength(2);
    expect(sheet.getImages()[0].imageId).toBe(sheet.getImages()[1].imageId);
    const image = reopened.getImage(Number(sheet.getImages()[0].imageId));
    expect(image.extension).toBe('png');
    expect(new Uint8Array(image.buffer!)).toEqual(PNG);
    expect(loadCover).toHaveBeenCalledOnce();
    expect(reopened.getWorksheet('Informazioni')).toBeDefined();
  });

  it('still produces a usable workbook when cover download fails, preserving its source URL', async () => {
    const loadCover = vi.fn(async () => { throw new Error('private provider diagnostic'); });
    const workbook = await createWorkbook(session([book('a', { quantity: 7 })]), { loadCover });
    const sheet = workbook.getWorksheet('Libri')!;
    expect(sheet.getCell('R2').value).toBe(COVER_UNAVAILABLE);
    expect(sheet.getCell('S2').value).toBe('indicativa');
    expect(sheet.getCell('T2').value).toBe(COVER);
    expect(sheet.getCell('H2').value).toBe(7);
    expect(sheet.getImages()).toHaveLength(0);
    await expect(workbook.xlsx.writeBuffer()).resolves.toBeDefined();
  });

  it('preserves long combined photographic evidence in a separate sheet without splitting the catalog group', async () => {
    const copies = Array.from({ length: 20 }, (_, index) => {
      const copy = book(`copy-${index}`, { candidates: [] });
      copy.observation.evidence = `Prova ${index}: ${'x'.repeat(1990)}`;
      return copy;
    });
    const input = session(copies);
    const completeEvidence = exportRows(input)[0][12];
    expect(String(completeEvidence).length).toBeGreaterThan(32_767);
    const workbook = await createWorkbook(input);
    const ExcelJS = (await import('exceljs')).default;
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(await workbook.xlsx.writeBuffer());
    const sheet = reopened.getWorksheet('Libri')!;
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell('H2').value).toBe(20);
    expect(sheet.getCell('M2').value).toBe('Contenuto completo nel foglio «Prove fotografiche», righe 2–21.');
    expect(sheet.getCell('N2').value).toBe(copies.map(copy => copy.observation.position).join('\n'));
    const evidence = reopened.getWorksheet('Prove fotografiche')!;
    expect(evidence.rowCount).toBe(21);
    expect(copies.map((_, index) => evidence.getCell(`D${index + 2}`).value).join('\n')).toBe(completeEvidence);
    expect(copies.every((_, index) => evidence.getCell(`A${index + 2}`).value === 2)).toBe(true);
    expect(createCsv(input)).toContain(String(completeEvidence));
  });

  it('never starts the default browser download path in Node/SSR', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const workbook = await createWorkbook(session([book('a')]));
    expect(workbook.getWorksheet('Libri')!.getCell('R2').value).toBe(COVER_UNAVAILABLE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('bounded cover loading', () => {
  it('requests only the authenticated same-origin proxy and captures headers once', async () => {
    const headers = new Headers({ Authorization: 'Bearer test-initial-token' });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(PNG, { headers: { 'content-type': 'image/png' } }));
    const loadCover = createCoverLoader({ fetchImpl, headers });
    headers.set('Authorization', 'Bearer changed-token');
    const signal = new AbortController().signal;
    await expect(loadCover(COVER, signal)).resolves.toMatchObject({ bytes: PNG, mimeType: 'image/png' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`/api/cover?url=${encodeURIComponent(COVER)}`);
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-initial-token');
    (init!.headers as Headers).set('Authorization', 'mutated-by-transport');
    await loadCover(COVER, signal);
    expect(new Headers(fetchImpl.mock.calls[1][1]?.headers).get('authorization')).toBe('Bearer test-initial-token');
  });

  it('rejects unsafe image URLs before any transport runs', async () => {
    const loadCover = vi.fn(async () => coverData());
    const result = await loadExportCovers([
      'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://127.0.0.1/private',
      'https://user:password@covers.openlibrary.org/b/id/123-S.jpg',
      'https://covers.openlibrary.org.attacker.example/image.png',
    ], { loadCover });
    expect(result.size).toBe(0);
    expect(loadCover).not.toHaveBeenCalled();
  });

  it('deduplicates URLs, runs at most three downloads together and stops after 48 different covers', async () => {
    let active = 0;
    let maximum = 0;
    const loadCover = vi.fn(async (_url: string, _signal: AbortSignal) => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return coverData();
    });
    const urls = Array.from({ length: 70 }, (_, index) => coverUrl(index));
    const images = await loadExportCovers([urls[0], urls[0].replace('https:', 'http:'), ...urls], { loadCover });
    expect(images.size).toBe(48);
    expect(loadCover).toHaveBeenCalledTimes(48);
    expect(maximum).toBe(3);
    expect(new Set(loadCover.mock.calls.map(call => call[0])).size).toBe(48);
  });

  it('bounds retained image bytes and rejects invalid MIME, signatures and excessive dimensions', async () => {
    const padded = new Uint8Array(MAX_EXPORT_COVER_BYTES);
    padded.set(PNG);
    const loadCover = vi.fn(async () => ({ bytes: padded, mimeType: 'image/png' }));
    const images = await loadExportCovers(Array.from({ length: 40 }, (_, index) => coverUrl(index)), { loadCover });
    expect([...images.values()].reduce((sum, image) => sum + image.buffer.byteLength, 0)).toBe(MAX_EXPORT_COVERS_BYTES);
    expect(images.size).toBe(10);
    expect(loadCover.mock.calls.length).toBeLessThanOrEqual(12);
    const enormous = Uint8Array.from(PNG);
    new DataView(enormous.buffer).setUint32(16, 9000);
    for (const data of [
      { bytes: PNG, mimeType: 'image/jpeg' }, { bytes: new TextEncoder().encode('<html>error</html>'), mimeType: 'image/png' },
      { bytes: enormous, mimeType: 'image/png' }, { bytes: new Uint8Array(MAX_EXPORT_COVER_BYTES + 1), mimeType: 'image/png' },
    ]) expect((await loadExportCovers([COVER], { loadCover: async () => data })).size).toBe(0);
  });

  it('keeps completed covers and exits at the overall deadline even if later downloads ignore abort', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const loadCover = vi.fn(async (_url: string, signal: AbortSignal) => {
      signals.push(signal);
      if (signals.length === 1) return coverData();
      return new Promise<CoverData>(() => undefined);
    });
    const pending = loadExportCovers(Array.from({ length: 40 }, (_, index) => coverUrl(index)), { loadCover });
    await vi.advanceTimersByTimeAsync(EXPORT_COVER_DEADLINE_MS);
    const images = await pending;
    expect(images.size).toBe(1);
    expect(loadCover.mock.calls.length).toBeLessThanOrEqual(7);
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });

  it('cancels oversized or non-image proxy responses and treats them as unavailable', async () => {
    for (const [mimeType, length] of [['image/png', MAX_EXPORT_COVER_BYTES + 1], ['application/json', 20]] as const) {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { headers: { 'content-type': mimeType, 'content-length': String(length) } });
      const loadCover = createCoverLoader({ fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response), headers: {} });
      await expect(loadCover(COVER, new AbortController().signal)).resolves.toBeNull();
      expect(cancel).toHaveBeenCalledOnce();
    }
  });
});
