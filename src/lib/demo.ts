import type { BookRecord, CatalogCandidate, ScanSession } from '../../shared/types';
import { createManualBook } from './books';

// Explicit demonstration data. Edition details checked against Open Library on 2026-10-10.
// No AI request is made, and no fixture is substituted for a real scan.
const editions: CatalogCandidate[] = [
  { id: 'openlibrary:OL24211017M', title: 'Invisible cities', authors: ['Italo Calvino'], isbn13: '9780156453806', publisher: 'Harvest', publishedDate: '1972', language: 'en', pageCount: 165, thumbnail: null, source: 'Open Library', sourceUrl: 'https://openlibrary.org/books/OL24211017M', score: 1, matchReason: 'Esempio: titolo e autore coincidono, edizione da confermare.' },
  { id: 'openlibrary:OL7358964M', title: "A Room of One’s Own", authors: ['Virginia Woolf'], isbn13: '9780141183534', publisher: 'Penguin Books Ltd', publishedDate: '2002', language: 'en', pageCount: 112, thumbnail: null, source: 'Open Library', sourceUrl: 'https://openlibrary.org/books/OL7358964M', score: 1, matchReason: 'Esempio: titolo e autore coincidono, edizione da confermare.' },
];

export function createDemoSession(): ScanSession {
  const now = new Date().toISOString();
  const books: BookRecord[] = editions.map((candidate, index) => {
    const book = createManualBook();
    return { ...book, title: candidate.title, authors: candidate.authors, status: 'review', candidates: [candidate],
      observation: { ...book.observation, title: candidate.title, authors: candidate.authors, evidence: `${candidate.title} — ${candidate.authors.join(', ')}`, position: `Libro ${index + 1}`, confidence: 'high' },
      notes: 'Esempio: il titolo è leggibile, ma l’ISBN della specifica edizione deve essere confermato.',
    };
  });
  const incomplete = createManualBook();
  books.push({ ...incomplete, title: 'Un libro da completare', observation: { ...incomplete.observation, position: 'Libro 3', evidence: 'Titolo parzialmente coperto', confidence: 'low' }, notes: 'Esempio di un libro poco leggibile. Apri la scheda e prova una ricerca o inserisci i dati manualmente.' });
  return { id: crypto.randomUUID(), name: 'Un piccolo scaffale · esempio', createdAt: now, updatedAt: now, mode: 'shelf', image: null, books, warnings: ['Questa è una dimostrazione con dati di esempio. Nessuna fotografia è stata analizzata.'], isDemo: true };
}
