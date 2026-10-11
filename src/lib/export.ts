import type { BookRecord, ScanSession } from '../../shared/types';
import { STATUS_LABELS } from '../../shared/types';
import { toIsbn13 } from '../../shared/isbn';
import { groupBooks, observationsFor } from '../../shared/book-groups';
import { COVER_UNAVAILABLE, resolveBookCover } from '../../shared/covers';
import { loadExportCovers, type CoverLoader, type ExportCoverImage } from './export-covers';

export const EXPORT_COLUMNS = ['ISBN', 'Titolo', 'Autore', 'Editore', 'Data pubblicazione', 'Lingua', 'Pagine', 'Quantità', 'Stato', 'ISBN suggerito (da verificare)', 'Fonte', 'URL fonte', 'Testo letto nella foto', 'Posizione', 'Note', 'ISBN letto nella foto (non confermato)', 'Avvisi del catalogo', 'Copertina', 'Tipo copertina'];
type Cell = string | number;
const EXCEL_CELL_TEXT_LIMIT = 32_767;
const EVIDENCE_COLUMNS = [12, 13, 15];

function selectedGroups(session: ScanSession): BookRecord[] {
  // Filter first: a deselected legacy copy must not increase a selected quantity.
  return groupBooks(session.books.filter(book => book.selected));
}

function rowsForBooks(session: ScanSession, books: BookRecord[]): Cell[][] {
  // Repeat scan-wide warnings on every selected row so CSV exports and subsets
  // retain interruptions and visibility limits without adding artificial books.
  const warnings = session.warnings.join('\n');
  return books.map(book => {
    const observations = observationsFor(book);
    const cover = resolveBookCover(book);
    const confirmed = book.status === 'confirmed' || book.status === 'verified';
    const isbn = book.isbn13 ? toIsbn13(book.isbn13) : null;
    const suggestion = !confirmed ? toIsbn13(book.candidates.find(candidate => candidate.isbn13)?.isbn13) ?? '' : '';
    return [
      confirmed ? isbn ?? '' : '', book.title, book.authors.join('; '), book.publisher ?? '',
      book.publishedDate ?? '', book.language ?? '', book.pageCount ?? '', book.quantity,
      STATUS_LABELS[book.status], suggestion, book.source ?? (book.status === 'confirmed' ? 'Inserimento manuale' : observations.some(item => item.evidence) ? 'Foto / revisione manuale' : 'Inserimento manuale'),
      book.sourceUrl ?? '', observations.map(item => item.evidence).filter(Boolean).join('\n'), observations.map(item => item.position).filter(Boolean).join('\n'),
      [session.isDemo ? 'DATI DI ESEMPIO — non provengono da un riconoscimento reale.' : '', book.notes].filter(Boolean).join(' '),
      observations.map(item => item.visibleIsbn).filter(Boolean).join('\n'),
      warnings,
      cover.url ?? COVER_UNAVAILABLE,
      cover.url ? cover.suggested ? 'indicativa' : 'edizione' : '',
    ];
  });
}

export function exportRows(session: ScanSession): Cell[][] {
  return rowsForBooks(session, selectedGroups(session));
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
export async function createWorkbook(session: ScanSession, options: { loadCover?: CoverLoader } = {}) {
  const books = selectedGroups(session);
  const covers = books.map(resolveBookCover);
  // Start the bounded batch before loading ExcelJS; auth is captured once here.
  const pendingImages = loadExportCovers(covers.map(cover => cover.url), options).catch(() => new Map<string, ExportCoverImage>());
  const { default: ExcelJS } = await import('exceljs');
  const images = await pendingImages;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Jemiq';
  workbook.created = new Date(session.createdAt);
  const sheet = workbook.addWorksheet(session.isDemo ? 'Esempio' : 'Libri', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [...EXPORT_COLUMNS, 'URL copertina'].map((header, index) => ({ header, key: String(index), width: [20, 42, 30, 24, 20, 12, 10, 12, 24, 30, 20, 45, 45, 20, 55, 34, 60, 16, 16, 45][index] }));
  const rows = rowsForBooks(session, books);
  const hasLongEvidence = (values: Cell[]) => EVIDENCE_COLUMNS.some(column => String(values[column]).length > EXCEL_CELL_TEXT_LIMIT);
  const evidenceSheet = rows.some(hasLongEvidence)
    ? workbook.addWorksheet('Prove fotografiche', { views: [{ state: 'frozen', ySplit: 1 }] }) : null;
  if (evidenceSheet) evidenceSheet.columns = [
    { header: 'Riga nel catalogo', width: 20 }, { header: 'Titolo', width: 42 },
    { header: 'Osservazione', width: 18 }, { header: 'Testo letto nella foto', width: 70 },
    { header: 'Posizione', width: 35 }, { header: 'ISBN letto nella foto (non confermato)', width: 34 },
  ];
  const imageIds = new Map<string, number>();
  for (const [index, values] of rows.entries()) {
    const cover = covers[index];
    let workbookValues = values;
    if (evidenceSheet && hasLongEvidence(values)) {
      const firstEvidenceRow = evidenceSheet.rowCount + 1;
      for (const [observationIndex, observation] of observationsFor(books[index]).entries()) {
        evidenceSheet.addRow([index + 2, books[index].title, observationIndex + 1, observation.evidence, observation.position, observation.visibleIsbn ?? '']);
      }
      const reference = `Contenuto completo nel foglio «Prove fotografiche», righe ${firstEvidenceRow}–${evidenceSheet.rowCount}.`;
      workbookValues = values.map((value, column) => EVIDENCE_COLUMNS.includes(column) && String(value).length > EXCEL_CELL_TEXT_LIMIT ? reference : value);
    }
    const row = sheet.addRow([...workbookValues.slice(0, 17), COVER_UNAVAILABLE, values[18], cover.url ?? '']);
    row.height = 32;
    row.getCell(18).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    row.getCell(18).font = { size: 10, color: { argb: 'FF515A55' } };
    const image = cover.url ? images.get(cover.url) : null;
    if (!image || !cover.url) continue;
    let imageId = imageIds.get(cover.url);
    if (imageId === undefined) {
      imageId = workbook.addImage({ buffer: image.buffer, extension: image.extension });
      imageIds.set(cover.url, imageId);
    }
    const scale = Math.min(80 / image.width, 120 / image.height, 1);
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    row.height = 100;
    row.getCell(18).value = '';
    sheet.addImage(imageId, {
      tl: { col: 17.12, row: index + 1.05 }, ext: { width, height }, editAs: 'oneCell',
      hyperlinks: { hyperlink: cover.url, tooltip: cover.suggested ? 'Copertina indicativa: verifica l’edizione.' : 'Fonte della copertina' },
    });
  }
  sheet.getRow(1).height = 30;
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF252C2A' } };
  sheet.autoFilter = { from: 'A1', to: `T${Math.max(1, sheet.rowCount)}` };
  sheet.eachRow((row, index) => {
    row.alignment = { vertical: 'top', wrapText: true };
    if (index > 1) {
      row.getCell(1).numFmt = '@';
      row.getCell(10).numFmt = '@';
      row.getCell(16).numFmt = '@';
      row.getCell(18).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      if (index % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F4EF' } };
    }
  });
  if (evidenceSheet) {
    evidenceSheet.getRow(1).height = 30;
    evidenceSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    evidenceSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF252C2A' } };
    evidenceSheet.autoFilter = { from: 'A1', to: `F${evidenceSheet.rowCount}` };
    evidenceSheet.eachRow((row, index) => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (index > 1) row.getCell(6).numFmt = '@';
    });
  }
  const info = workbook.addWorksheet('Informazioni');
  info.columns = [{ width: 28 }, { width: 105 }];
  info.addRows([
    ['Catalogo', session.name], ['Creato', session.createdAt],
    ['Origine', session.isDemo ? 'DEMO: dati di esempio, non riconosciuti da una foto.' : 'Foto e ricerche bibliografiche, con revisione dell’utente.'],
    ['ISBN', 'Compilato solo per codici riscontrati nella foto e nel catalogo o confermati dall’utente. Salvato come testo.'],
    ['ISBN suggerito', 'Un’edizione candidata, da confrontare con il volume fisico. Non usare come codice ordine prima della verifica.'],
    ['Quantità', 'Somma delle quantità delle copie selezionate raggruppate come lo stesso libro. Le quantità modificate dall’utente sono conservate. Non include copie nascoste o righe deselezionate.'],
    ['Prove fotografiche', 'I testi letti, le posizioni e gli ISBN osservati di tutte le copie raggruppate sono conservati nelle rispettive colonne.'],
    ...(evidenceSheet ? [['Prove estese', 'Quando le prove di un gruppo superano il limite di 32.767 caratteri di una cella Excel, la cella rimanda al foglio «Prove fotografiche». Quel foglio conserva una riga per osservazione; la quantità complessiva resta nel catalogo.']] : []),
    ['Copertine', '«indicativa» identifica una copertina suggerita e non conferma l’ISBN dell’edizione. «edizione» si riferisce ai dati dell’edizione scelta o riscontrata.'],
    ['Miniature Excel', 'Si caricano fino a 48 copertine diverse, entro 15 secondi e un limite di 10 MiB di immagini. Se il caricamento fallisce o supera questi limiti, compare «Copertina non disponibile»; l’URL disponibile resta nella colonna T.'],
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
