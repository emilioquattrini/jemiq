import type { ScanSession } from '../../shared/types';
import { type CatalogPutOptions, type CatalogStore, MAX_PHOTO_BYTES, StorageError, conflict, storageFailure } from './contracts';
import { assertPhotoOwnership, metadata, newPhotoKey, nextRevision, photoDataUrl, prepareCatalog, validateCatalogJson, validateIdentity, keyedQueue, type Photo, type StoredCatalog } from './codec';

/** Structural interfaces keep the adapter usable in Workers without an SDK dependency. */
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success?: boolean }>;
  run(): Promise<{ success?: boolean; meta?: { changes?: number } }>;
}
export interface D1Database { prepare(sql: string): D1Statement }
export interface R2Bucket {
  get(key: string): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(key: string, value: Uint8Array, options?: { httpMetadata: { contentType: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

const COLUMNS = 'owner_id, id, data_json, created_at, updated_at, photo_key, photo_mime';

export function createD1R2CatalogStore({ db, bucket }: { db: D1Database; bucket: R2Bucket }): CatalogStore {
  const serialize = keyedQueue();
  const row = (ownerId: string, id: string) => db.prepare('SELECT ' + COLUMNS + ' FROM catalogs WHERE owner_id = ? AND id = ?')
    .bind(ownerId, id).first<StoredCatalog>();

  return {
    async list(ownerId) {
      validateIdentity(ownerId);
      try {
        const response = await db.prepare('SELECT ' + COLUMNS + ' FROM catalogs WHERE owner_id = ? ORDER BY updated_at DESC, id ASC')
          .bind(ownerId).all<StoredCatalog>();
        if (response.success === false) throw new Error();
        return response.results.map(metadata);
      } catch (error) { return storageFailure(error); }
    },
    async get(ownerId, id) {
      validateIdentity(ownerId, id);
      try {
        const saved = await row(ownerId, id);
        if (!saved) return null;
        const session = metadata(saved);
        if (!saved.photo_key) return session;
        await assertPhotoOwnership(ownerId, id, saved.photo_key);
        const object = await bucket.get(saved.photo_key);
        if (!object || object.size > MAX_PHOTO_BYTES || !['image/jpeg', 'image/png', 'image/webp'].includes(saved.photo_mime ?? '')) {
          throw new StorageError(503, 'PHOTO_UNAVAILABLE', 'La foto archiviata non è disponibile. Riprova senza sovrascrivere il catalogo.');
        }
        const bytes = new Uint8Array(await object.arrayBuffer());
        if (bytes.length > MAX_PHOTO_BYTES) throw new Error();
        return { ...session, image: photoDataUrl({ bytes, mime: saved.photo_mime as Photo['mime'] }) };
      } catch (error) { return storageFailure(error); }
    },
    async put(ownerId, input, options: CatalogPutOptions = {}) {
      validateIdentity(ownerId, input?.id);
      const prepared = prepareCatalog(input);
      return serialize(ownerId + '\0' + prepared.session.id, async () => {
        let uploaded: string | null = null;
        let committed = false;
        try {
          const previous = await row(ownerId, prepared.session.id);
          if (options.expectedUpdatedAt === null && previous) conflict();
          if (typeof options.expectedUpdatedAt === 'string' && previous?.updated_at !== options.expectedUpdatedAt) conflict();
          if (options.preservePhoto && (prepared.session.image !== null || !previous?.photo_key)) {
            throw new StorageError(409, 'PHOTO_CONFLICT', 'Ricarica la foto del catalogo prima di salvarlo.');
          }
          if (previous?.photo_key) await assertPhotoOwnership(ownerId, prepared.session.id, previous.photo_key);
          const session: ScanSession = { ...prepared.session, createdAt: previous?.created_at ?? prepared.session.createdAt, updatedAt: nextRevision(previous?.updated_at) };
          const json = JSON.stringify({ ...session, image: null });
          validateCatalogJson(json);
          if (prepared.photo) {
            uploaded = await newPhotoKey(ownerId, session.id, prepared.photo.mime);
            await bucket.put(uploaded, prepared.photo.bytes, { httpMetadata: { contentType: prepared.photo.mime } });
          }
          // CAS also protects separate Worker isolates; the in-process queue is only an optimization.
          const expected = options.expectedUpdatedAt;
          const photoKey = options.preservePhoto ? previous!.photo_key : uploaded;
          const photoMime = options.preservePhoto ? previous!.photo_mime : prepared.photo?.mime ?? null;
          const sql = typeof expected === 'string'
            ? 'UPDATE catalogs SET data_json = ?, updated_at = ?, photo_key = ?, photo_mime = ? WHERE owner_id = ? AND id = ? AND updated_at = ?'
            : 'INSERT INTO catalogs (' + COLUMNS + ') VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner_id, id) '
              + (expected === null ? 'DO NOTHING' : 'DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at, photo_key = excluded.photo_key, photo_mime = excluded.photo_mime');
          const values: unknown[] = typeof expected === 'string'
            ? [json, session.updatedAt, photoKey, photoMime, ownerId, session.id, expected]
            : [ownerId, session.id, json, session.createdAt, session.updatedAt, photoKey, photoMime];
          const result = await db.prepare(sql).bind(...values).run();
          if (result.success === false || typeof result.meta?.changes !== 'number') throw new Error();
          if (result.meta?.changes === 0) conflict();
          committed = true;
          if (previous?.photo_key && previous.photo_key !== photoKey) {
            await bucket.delete(previous.photo_key).catch(() => undefined);
          }
          return session;
        } catch (error) {
          if (uploaded && !committed) await bucket.delete(uploaded).catch(() => undefined);
          return storageFailure(error);
        }
      });
    },
    async delete(ownerId, id) {
      validateIdentity(ownerId, id);
      return serialize(ownerId + '\0' + id, async () => {
        try {
          const saved = await row(ownerId, id);
          if (!saved) return false;
          if (saved.photo_key) await assertPhotoOwnership(ownerId, id, saved.photo_key);
          const result = await db.prepare('DELETE FROM catalogs WHERE owner_id = ? AND id = ? AND updated_at = ?').bind(ownerId, id, saved.updated_at).run();
          if (result.success === false || typeof result.meta?.changes !== 'number') throw new Error();
          if (result.meta?.changes === 0) conflict();
          // Another isolate may have updated the row while preserving this photo. Delete
          // its immutable object only after the matching revision has actually been removed.
          if (saved.photo_key) await bucket.delete(saved.photo_key).catch(() => undefined);
          return true;
        } catch (error) { return storageFailure(error); }
      });
    },
  };
}
