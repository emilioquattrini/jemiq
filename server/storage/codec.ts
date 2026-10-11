import { sessionSchema } from '../../shared/schemas';
import type { ScanSession } from '../../shared/types';
import { MAX_CATALOG_BYTES, MAX_PHOTO_BYTES, StorageError } from './contracts';

export interface Photo { bytes: Uint8Array; mime: 'image/jpeg' | 'image/png' | 'image/webp' }
export interface StoredCatalog {
  owner_id: string;
  id: string;
  data_json: string;
  created_at: string;
  updated_at: string;
  photo_key: string | null;
  photo_mime: string | null;
}

export function validateIdentity(ownerId: string, id?: string): void {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 1024) {
    throw new StorageError(401, 'OWNER_REQUIRED', 'Accedi prima di usare l’archivio.');
  }
  if (id !== undefined && (typeof id !== 'string' || !id.trim() || id.length > 2000)) {
    throw new StorageError(400, 'INVALID_CATALOG_ID', 'L’identificativo del catalogo non è valido.');
  }
}

export function parsePhoto(value: string | null): Photo | null {
  if (value === null) return null;
  if (value.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 40) {
    throw new StorageError(413, 'PHOTO_TOO_LARGE', 'La foto supera 8 MiB. Riduci l’immagine prima di salvarla.');
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[2].length % 4 !== 0) {
    throw new StorageError(400, 'INVALID_PHOTO', 'La foto deve essere JPEG, PNG o WebP in un formato valido.');
  }
  let binary: string;
  try {
    binary = atob(match[2]);
    if (btoa(binary) !== match[2]) throw new Error();
  } catch {
    throw new StorageError(400, 'INVALID_PHOTO', 'I dati della foto non sono leggibili.');
  }
  if (!binary.length || binary.length > MAX_PHOTO_BYTES) {
    throw new StorageError(413, 'PHOTO_TOO_LARGE', 'La foto supera 8 MiB.');
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const mime = match[1] as Photo['mime'];
  const matches = mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : mime === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)
    : bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF'
      && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
  if (!matches) throw new StorageError(400, 'INVALID_PHOTO', 'Il contenuto della foto non corrisponde al formato dichiarato.');
  return { bytes, mime };
}

export function photoDataUrl(photo: Photo): string {
  let binary = '';
  for (let offset = 0; offset < photo.bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...photo.bytes.subarray(offset, offset + 0x8000));
  }
  return 'data:' + photo.mime + ';base64,' + btoa(binary);
}

export function prepareCatalog(input: unknown): { session: ScanSession; json: string; photo: Photo | null } {
  const parsed = sessionSchema.safeParse(input);
  if (!parsed.success || !parsed.data.id.trim()) {
    throw new StorageError(400, 'INVALID_CATALOG', 'Il catalogo contiene dati non validi. La copia originale non è stata modificata.');
  }
  const session = parsed.data;
  const photo = parsePhoto(session.image);
  const json = JSON.stringify({ ...session, image: null });
  validateCatalogJson(json);
  return { session, json, photo };
}

export function validateCatalogJson(json: string): void {
  if (new TextEncoder().encode(json).byteLength >= MAX_CATALOG_BYTES) {
    throw new StorageError(413, 'CATALOG_TOO_LARGE', 'Il catalogo supera 1 MiB di dati. Dividilo in cataloghi più piccoli.');
  }
}

export function metadata(row: StoredCatalog): ScanSession {
  const parsed = sessionSchema.safeParse(JSON.parse(row.data_json));
  if (!parsed.success || parsed.data.id !== row.id || parsed.data.image !== null) {
    throw new StorageError(503, 'STORAGE_CORRUPT', 'Il catalogo salvato non è leggibile. I dati non sono stati cancellati.');
  }
  return { ...parsed.data, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function nextRevision(previous?: string): string {
  return new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString();
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function photoPrefix(ownerId: string, id: string): Promise<string> {
  validateIdentity(ownerId, id);
  const [ownerHash, idHash] = await Promise.all([digest(ownerId), digest(id)]);
  return 'catalogs/' + ownerHash + '/' + idHash + '/';
}

export async function newPhotoKey(ownerId: string, id: string, mime: Photo['mime']): Promise<string> {
  return await photoPrefix(ownerId, id) + crypto.randomUUID() + (mime === 'image/jpeg' ? '.jpg' : mime === 'image/png' ? '.png' : '.webp');
}

export async function assertPhotoOwnership(ownerId: string, id: string, key: string): Promise<void> {
  const prefix = await photoPrefix(ownerId, id);
  if (!key.startsWith(prefix) || !/^[a-f\d-]{36}\.(?:jpg|png|webp)$/.test(key.slice(prefix.length))) {
    throw new StorageError(503, 'STORAGE_CORRUPT', 'Il riferimento alla foto salvata non è valido.');
  }
}

/** Serializes only mutations of the same record; independent catalogues do not block each other. */
export function keyedQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = pending.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    pending.set(key, settled);
    void settled.then(() => { if (pending.get(key) === settled) pending.delete(key); });
    return result;
  };
}
