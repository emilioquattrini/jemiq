import type { ScanSession } from '../../shared/types';
import { STATUS_LABELS } from '../../shared/types';
import { toIsbn13 } from '../../shared/isbn';

export const EXPORT_COLUMNS = ['ISBN', 'Titolo', 'Autore', 'Editore', 'Data pubblicazione', 'Lingua', 'Pagine', 'Quantità', 'Stato', 'ISBN suggerito (da verificare)', 'Fonte', 'URL fonte', 'Testo letto nella foto', 'Posizione', 'Note', 'ISBN letto nella foto (non confermato)', 'Avvisi del catalogo'];
type Cell = string | number;

export function exportRows(session: ScanSession): Cell[][] {
  // Repeat scan-wide warnings on every selected row so CSV exports and subsets
  // retain interruptions and visibility limits without adding artificial books.
  const warnings = session.warnings.join('\n');
  return session.books.filter(book => book.selected).map(book => {
    const confirmed = book.status === 'confirmed' || book.status === 'verified';
    const isbn = book.isbn13 ? toIsbn13(book.isbn13) : null;
    const suggestion = !confirmed ? toIsbn13(book.candidates.find(candidate => candidate.isbn13)?.isbn13) ?? '' : '';
    return [
      confirmed ? isbn ?? '' : '', book.title, book.authors.join('; '), book.publisher ?? '',
      book.publishedDate ?? '', book.language ?? '', book.pageCount ?? '', book.quantity,
      STATUS_LABELS[book.status], suggestion, book.source ?? (book.status === 'confirmed' ? 'Inserimento manuale' : book.observation.evidence ? 'Foto / revisione manuale' : 'Inserimento manuale'),
      book.sourceUrl ?? '', book.observation.evidence, book.observation.position,
      [session.isDemo ? 'DATI DI ESEMPIO — non provengono da un riconoscimento reale.' : '', book.notes].filter(Boolean).join(' '),
      book.observation.visibleIsbn ?? '',
      warnings,
    ];
  });
}

/** Neutralize spreadsheet formulas without formulas such as ="ISBN". */
export function safeCsvCell(value: Cell): string {
  let text = String(value);
  if (/^[\s\u0000-\u001f]*[=+@-]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function createCsv(session: ScanSession): string {
  return '\uFEFF' + [EXPORT_COLUMNS, ...exportRows(session)].map(row => row.map(safeCsvCell).join(';')).join('\r\n') + '\r\n';
}

function filename(session: ScanSession, extension: string): string {
  const title = session.name.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'catalogo';
  return `${session.isDemo ? 'esempio-' : ''}jemiq-${title}-${session.createdAt.slice(0, 10)}.${extension}`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function exportCsv(session: ScanSession): void {
  if (!session.books.some(book => book.selected)) throw new Error('Seleziona almeno un libro da esportare.');
  download(new Blob([createCsv(session)], { type: 'text/csv;charset=utf-8;' }), filename(session, 'csv'));
}

/** Lazy loaded so the spreadsheet library is not on the camera's critical path. */
export async function createWorkbook(session: ScanSession) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Jemiq';
  workbook.created = new Date(session.createdAt);
  const sheet = workbook.addWorksheet(session.isDemo ? 'Esempio' : 'Libri', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = EXPORT_COLUMNS.map((header, index) => ({ header, key: String(index), width: [20, 42, 30, 24, 20, 12, 10, 12, 24, 30, 20, 45, 45, 20, 55, 34, 60][index] }));
  for (const row of exportRows(session)) sheet.addRow(row);
  sheet.getRow(1).height = 30;
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF252C2A' } };
  sheet.autoFilter = { from: 'A1', to: `Q${Math.max(1, sheet.rowCount)}` };
  sheet.eachRow((row, index) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (index > 1) {
      row.getCell(1).numFmt = '@';
      row.getCell(10).numFmt = '@';
      row.getCell(16).numFmt = '@';
      if (index % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F4EF' } };
    }
  });
  const info = workbook.addWorksheet('Informazioni');
  info.columns = [{ width: 28 }, { width: 105 }];
  info.addRows([
    ['Catalogo', session.name], ['Creato', session.createdAt],
    ['Origine', session.isDemo ? 'DEMO: dati di esempio, non riconosciuti da una foto.' : 'Foto e ricerche bibliografiche, con revisione dell’utente.'],
    ['ISBN', 'Compilato solo per codici riscontrati nella foto e nel catalogo o confermati dall’utente. Salvato come testo.'],
    ['ISBN suggerito', 'Un’edizione candidata, da confrontare con il volume fisico. Non usare come codice ordine prima della verifica.'],
    ['Quantità', 'Valore inserito dall’utente, inizialmente 1 per ogni rilevamento. Non è una stima della giacenza né delle copie nascoste.'],
    ['Fonti', 'Le fonti identificano i dati di una singola edizione. Le correzioni manuali non sono nuove verifiche di catalogo.'],
    ['Avvisi', session.warnings.join(' ')],
  ]);
  info.eachRow(row => { row.alignment = { wrapText: true, vertical: 'top' }; row.getCell(1).font = { bold: true }; });
  return workbook;
}

export async function exportXlsx(session: ScanSession): Promise<void> {
  if (!session.books.some(book => book.selected)) throw new Error('Seleziona almeno un libro da esportare.');
  const workbook = await createWorkbook(session);
  const buffer = await workbook.xlsx.writeBuffer();
  download(new Blob([new Uint8Array(buffer as ArrayBuffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename(session, 'xlsx'));
}
