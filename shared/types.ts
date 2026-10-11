export type BookStatus = 'verified' | 'confirmed' | 'review' | 'unresolved';
export type CatalogSource = 'Google Books' | 'Open Library';
/** Allows aggregation of all 5000 legacy rows, each previously limited to 9999 copies. */
export const MAX_BOOK_QUANTITY = 49_995_000;

/** Only information actually visible in the photo. No ISBN inferred from a title. */
export interface Observation {
  title: string | null;
  authors: string[];
  visibleIsbn: string | null;
  publisher: string | null;
  language: string | null;
  evidence: string;
  position: string;
  confidence: 'high' | 'medium' | 'low';
  boundingBox: [number, number, number, number] | null;
}

/** An edition-level catalogue record. The source must support its own fields. */
export interface CatalogCandidate {
  id: string;
  title: string;
  authors: string[];
  isbn13: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  pageCount: number | null;
  /** Plain-text synopsis supplied by this edition's catalogue record, when available. */
  description?: string | null;
  categories?: string[];
  thumbnail: string | null;
  source: CatalogSource;
  sourceUrl: string;
  score: number;
  matchReason: string;
}

export interface BookRecord {
  id: string;
  observation: Observation;
  /** Evidence for every grouped copy, including the legacy primary observation. */
  observations?: Observation[];
  title: string;
  authors: string[];
  /** Empty until visible ISBN + consistent catalogue, or explicit user confirmation. */
  isbn13: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  pageCount: number | null;
  /** Optional catalogue metadata; never inferred from a title or copied from another edition. */
  description?: string | null;
  categories?: string[];
  thumbnail: string | null;
  source: CatalogSource | null;
  sourceUrl: string | null;
  status: BookStatus;
  candidates: CatalogCandidate[];
  notes: string;
  quantity: number;
  selected: boolean;
}

export interface ScanSession {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mode: 'shelf' | 'table';
  image: string | null;
  books: BookRecord[];
  warnings: string[];
  isDemo: boolean;
}

export type ScanEvent =
  | { type: 'stage'; stage: 'recognizing' | 'enriching'; message: string }
  | { type: 'observations'; total: number; warnings: string[] }
  | { type: 'book'; book: BookRecord; completed: number; total: number; removedIds?: string[] }
  | { type: 'done'; warnings: string[]; elapsedMs: number }
  | { type: 'error'; error: string; code: string };

export interface HealthStatus {
  recognitionReady: boolean;
  accessRequired: boolean;
  authMode?: 'platform' | 'token';
  storageMode?: 'cloud' | 'local';
  ownerId?: string;
  settingsSupported?: boolean;
}
export interface PreparedImage { dataUrl: string; data: string; mimeType: 'image/jpeg'; width: number; height: number }

export const STATUS_LABELS: Record<BookStatus, string> = {
  verified: 'ISBN riscontrato', confirmed: 'Confermato da te', review: 'Da verificare', unresolved: 'Da completare',
};
