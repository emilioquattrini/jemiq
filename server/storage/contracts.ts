import type { ScanSession } from '../../shared/types';

export const MAX_CATALOG_BYTES = 1024 * 1024;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export interface CatalogPutOptions {
  /** null creates only; a timestamp updates that revision; undefined explicitly permits an upsert. */
  expectedUpdatedAt?: string | null;
  /** Keep the existing photo without uploading it again; requires image:null and an existing photo. */
  preservePhoto?: boolean;
}

export interface CatalogStore {
  /** History records omit image bytes. Use get before editing or exporting a complete backup. */
  list(ownerId: string): Promise<ScanSession[]>;
  get(ownerId: string, id: string): Promise<ScanSession | null>;
  put(ownerId: string, session: ScanSession, options?: CatalogPutOptions): Promise<ScanSession>;
  delete(ownerId: string, id: string): Promise<boolean>;
}

export class StorageError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export function storageFailure(error: unknown): never {
  if (error instanceof StorageError) throw error;
  throw new StorageError(503, 'STORAGE_UNAVAILABLE', 'L’archivio non è disponibile. I dati locali sono conservati; riprova tra poco.');
}

export function conflict(): never {
  throw new StorageError(409, 'CATALOG_CONFLICT', 'Questo catalogo è stato modificato altrove. La tua copia locale è conservata: ricarica la versione aggiornata o importa una copia dal backup.');
}
