import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualBook, confirmCandidate, updateBook, findDuplicates } from '../src/lib/books';
import { createDemoSession } from '../src/lib/demo';
import { createCsv, createWorkbook, exportRows, safeCsvCell } from '../src/lib/export';
import { readScanStream, searchCatalog, ApiError } from '../src/lib/api';
import type { ScanEvent } from '../shared/types';

describe('review and edition confirmation', () => {
  it('never turns a suggested catalogue edition into a verified ISBN without confirmation', () => {
    const session = createDemoSession();
    const book = session.books[0];
    expect(book.isbn13).toBeNull();
    expect(exportRows(session)[0][0]).toBe('');
    expect(exportRows(session)[0][9]).toBe('9780156453806');
    const confirmed = confirmCandidate(book, book.candidates[0]);
    expect(confirmed.isbn13).toBe('9780156453806');
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.sourceUrl).toBe(book.candidates[0].sourceUrl);
  });

  it('demotes a catalogue verification after manual bibliographical edits', () => {
    const example = createDemoSession().books[0];
    const book = { ...confirmCandidate(example, example.candidates[0]), status: 'verified' as const };
    const edited = updateBook(book, { title: 'Un altro titolo' });
    expect(edited.status).toBe('review');
    expect(edited.isbn13).toBeNull();
    expect(edited.source).toBeNull();
    expect(edited.publisher).toBeNull();
    expect(edited.publishedDate).toBeNull();
    expect(edited.pageCount).toBeNull();
    expect(edited.thumbnail).toBeNull();
    expect(edited.candidates).toEqual([]);
    expect(edited.observation).toEqual(book.observation);
    expect(updateBook(book, { quantity: 2 }).status).toBe('verified');
  });

  it('validates manual ISBNs and quantities, accepting ISBN-10 only after explicit confirmation', () => {
    expect(() => updateBook(createManualBook(), { isbn13: '9780156453807', status: 'confirmed', title: 'Un libro' })).toThrow('ISBN');
    expect(updateBook(createManualBook(), { isbn13: '0156453800', status: 'confirmed', title: 'Invisible cities' }).isbn13).toBe('9780156453806');
    expect(() => updateBook(createManualBook(), { quantity: -3 })).toThrow('quantità');
    expect(() => updateBook(createManualBook(), { quantity: 1.5 })).toThrow('quantità');
    expect(() => updateBook(createManualBook(), { status: 'confirmed' })).toThrow('titolo');
  });

  it('reports duplicates without changing physical observations or incrementing quantities', () => {
    const original = createDemoSession().books[0];
    const second = { ...original, id: 'second', title: 'INVISIBLE CITIES' };
    const books = [original, second];
    expect(findDuplicates(books)).toEqual(new Set([original.id, 'second']));
    expect(books.map(book => book.quantity)).toEqual([1, 1]);
    expect(findDuplicates([createManualBook(), createManualBook()]).size).toBe(0);
    const verified = confirmCandidate(original, original.candidates[0]);
    expect(findDuplicates([verified, second])).toEqual(new Set([original.id, 'second']));
    expect(findDuplicates([verified, { ...second, isbn13: '9780141183534' }]).size).toBe(0);
  });
});

describe('exports for spreadsheets', () => {
  it('exports only selected rows, keeps uncertain ISBN separate and labels demo data', () => {
    const session = createDemoSession();
    session.books[1].selected = false;
    expect(exportRows(session)).toHaveLength(2);
    expect(exportRows(session)[0][0]).toBe('');
    expect(exportRows(session)[0][9]).toBe('9780156453806');
    expect(exportRows(session)[0][14]).toContain('DATI DI ESEMPIO');
    const manual = { ...createManualBook(), title: 'Libro manuale' };
    expect(exportRows({ ...session, books: [manual] })[0][10]).toBe('Inserimento manuale');
  });

  it('quotes delimiters, newlines and accents and prevents leading spreadsheet formulas', () => {
    expect(safeCsvCell('Titolo; "Città"\nRiga')).toBe('"Titolo; ""Città""\nRiga"');
    for (const input of ['=HYPERLINK("https://bad")', '+cmd', '-formula', '@SUM(1)', ' \t=1+2', '\r=1']) {
      expect(safeCsvCell(input)).toMatch(/^"'/);
    }
    const csv = createCsv(createDemoSession());
    expect(csv.startsWith('\uFEFF"ISBN";"Titolo"')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('writes true XLSX text cells for ISBN and formula-shaped titles', async () => {
    const session = createDemoSession();
    session.books = [confirmCandidate(session.books[0], session.books[0].candidates[0])];
    session.books[0].title = '=1+1';
    const workbook = await createWorkbook(session);
    const bytes = await workbook.xlsx.writeBuffer();
    const ExcelJS = (await import('exceljs')).default;
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(bytes);
    const sheet = reloaded.worksheets[0];
    expect(sheet.getCell('A2').value).toBe('9780156453806');
    expect(sheet.getCell('A2').numFmt).toBe('@');
    expect(sheet.getCell('B2').value).toBe('=1+1');
    expect(sheet.getCell('B2').type).toBe(ExcelJS.ValueType.String);
    expect(sheet.getCell('H2').value).toBe(1);
    expect(reloaded.getWorksheet('Informazioni')).toBeDefined();
  });
});

function responseFrom(parts: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(encoder.encode(part)); controller.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

describe('progressive scan client', () => {
  it('handles chunks splitting JSON records and preserves event order', async () => {
    const events: ScanEvent[] = [{ type: 'stage', stage: 'recognizing', message: 'Leggo…' }, { type: 'done', warnings: [], elapsedMs: 10 }];
    const text = events.map(event => JSON.stringify(event)).join('\n');
    const received: ScanEvent[] = [];
    await readScanStream(responseFrom([text.slice(0, 12), text.slice(12, 53), text.slice(53)]), event => received.push(event));
    expect(received).toEqual(events);
  });

  it('rejects incomplete streams while retaining rows already delivered', async () => {
    const book = createDemoSession().books[0];
    const partial = JSON.stringify({ type: 'book', book, completed: 1, total: 3 }) + '\n';
    const received: ScanEvent[] = [];
    await expect(readScanStream(responseFrom([partial]), event => received.push(event))).rejects.toMatchObject({ code: 'INCOMPLETE_SCAN' });
    expect(received).toHaveLength(1);
  });

  it('rejects malformed provider records and propagates useful stream errors', async () => {
    await expect(readScanStream(responseFrom(['{"type":"book","book":{}}\n']), () => {})).rejects.toBeInstanceOf(ApiError);
    await expect(readScanStream(responseFrom(['{"type":"error","error":"Quota esaurita","code":"VISION_RATE_LIMIT"}\n']), () => {})).rejects.toMatchObject({ code: 'VISION_RATE_LIMIT', message: 'Quota esaurita' });
  });

  it('cancellation never reports success or consumes additional rows', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(readScanStream(responseFrom(['{"type":"done","warnings":[],"elapsedMs":5}']), () => {}, abort.signal)).rejects.toHaveProperty('name', 'AbortError');
  });
});

describe('catalogue search errors', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps network errors readable and preserves access failures', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(searchCatalog('Calvino')).rejects.toMatchObject({ code: 'NETWORK_ERROR', message: expect.stringContaining('Connessione non disponibile') });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Codice di accesso non valido.', code: 'UNAUTHORIZED' }), { status: 401 })));
    await expect(searchCatalog('Calvino')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('does not expose schema diagnostics for malformed responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"candidates":[{"title":12}]}')));
    await expect(searchCatalog('Calvino')).rejects.toMatchObject({ code: 'INVALID_CATALOG', message: expect.stringContaining('dati non leggibili') });
  });
});
