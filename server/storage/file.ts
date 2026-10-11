import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { ScanSession } from '../../shared/types';
import { type CatalogPutOptions, type CatalogStore, MAX_CATALOG_BYTES, MAX_PHOTO_BYTES, StorageError, conflict, storageFailure } from './contracts';
import { assertPhotoOwnership, metadata, newPhotoKey, nextRevision, photoDataUrl, prepareCatalog, validateCatalogJson, validateIdentity, keyedQueue, type Photo, type StoredCatalog } from './codec';

const serialize = keyedQueue();
const MAX_RECORD_FILE_BYTES = MAX_CATALOG_BYTES * 2 + 32 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Persistent Node adapter. The configured directory must be backed up or mounted on a durable volume. */
export function createFileCatalogStore({ directory }: { directory: string }): CatalogStore {
  const root = resolve(directory);
  const ownerPath = (ownerId: string) => join(root, 'records', hash(ownerId));
  const recordPath = (ownerId: string, id: string) => join(ownerPath(ownerId), hash(id) + '.json');
  async function row(ownerId: string, id: string): Promise<StoredCatalog | null> {
    try {
      const path = recordPath(ownerId, id);
      if ((await stat(path)).size > MAX_RECORD_FILE_BYTES) throw new Error();
      const saved = JSON.parse(await readFile(path, 'utf8')) as StoredCatalog;
      if (saved.owner_id !== ownerId || saved.id !== id) throw new Error();
      return saved;
    } catch (error) { if (missing(error)) return null; throw error; }
  }
  async function removePhoto(ownerId: string, id: string, key: string): Promise<void> {
    await assertPhotoOwnership(ownerId, id, key);
    await rm(join(root, key), { force: true });
  }
  return {
    async list(ownerId) {
      validateIdentity(ownerId);
      try {
        const files = await readdir(ownerPath(ownerId)).catch((error: unknown) => { if (missing(error)) return []; throw error; });
        const sessions: ScanSession[] = [];
        for (const name of files) {
          if (!/^[a-f\d]{64}\.json$/.test(name)) continue;
          const path = join(ownerPath(ownerId), name);
          if ((await stat(path)).size > MAX_RECORD_FILE_BYTES) throw new Error();
          const saved = JSON.parse(await readFile(path, 'utf8')) as StoredCatalog;
          if (saved.owner_id !== ownerId || name !== hash(saved.id) + '.json') throw new Error();
          sessions.push(metadata(saved));
        }
        return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
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
        const path = join(root, saved.photo_key);
        if ((await stat(path)).size > MAX_PHOTO_BYTES || !['image/jpeg', 'image/png', 'image/webp'].includes(saved.photo_mime ?? '')) throw new Error();
        const bytes = new Uint8Array(await readFile(path));
        return { ...session, image: photoDataUrl({ bytes, mime: saved.photo_mime as Photo['mime'] }) };
      } catch (error) { return storageFailure(error); }
    },
    async put(ownerId, input, options: CatalogPutOptions = {}) {
      validateIdentity(ownerId, input?.id);
      const prepared = prepareCatalog(input);
      return serialize(recordPath(ownerId, prepared.session.id), async () => {
        let uploaded: string | null = null;
        let temporary: string | null = null;
        let committed = false;
        try {
          const previous = await row(ownerId, prepared.session.id);
          if (options.expectedUpdatedAt === null && previous) conflict();
          if (typeof options.expectedUpdatedAt === 'string' && previous?.updated_at !== options.expectedUpdatedAt) conflict();
          if (options.preservePhoto && (prepared.session.image !== null || !previous?.photo_key)) {
            throw new StorageError(409, 'PHOTO_CONFLICT', 'Ricarica la foto del catalogo prima di salvarlo.');
          }
          if (previous?.photo_key) await assertPhotoOwnership(ownerId, prepared.session.id, previous.photo_key);
          const session = { ...prepared.session, createdAt: previous?.created_at ?? prepared.session.createdAt, updatedAt: nextRevision(previous?.updated_at) };
          const json = JSON.stringify({ ...session, image: null });
          validateCatalogJson(json);
          if (prepared.photo) {
            uploaded = await newPhotoKey(ownerId, session.id, prepared.photo.mime);
            const path = join(root, uploaded);
            await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
            await writeFile(path, prepared.photo.bytes, { flag: 'wx', mode: 0o600 });
          }
          await mkdir(ownerPath(ownerId), { recursive: true, mode: 0o700 });
          const photoKey = options.preservePhoto ? previous!.photo_key : uploaded;
          const saved: StoredCatalog = { owner_id: ownerId, id: session.id, data_json: json,
            created_at: session.createdAt, updated_at: session.updatedAt, photo_key: photoKey, photo_mime: options.preservePhoto ? previous!.photo_mime : prepared.photo?.mime ?? null };
          const path = recordPath(ownerId, session.id);
          temporary = path + '.' + crypto.randomUUID() + '.tmp';
          await writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
          await rename(temporary, path);
          committed = true;
          if (previous?.photo_key && previous.photo_key !== photoKey) await removePhoto(ownerId, session.id, previous.photo_key).catch(() => undefined);
          return session;
        } catch (error) {
          if (uploaded && !committed) await removePhoto(ownerId, prepared.session.id, uploaded).catch(() => undefined);
          if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
          return storageFailure(error);
        }
      });
    },
    async delete(ownerId, id) {
      validateIdentity(ownerId, id);
      return serialize(recordPath(ownerId, id), async () => {
        try {
          const saved = await row(ownerId, id);
          if (!saved) return false;
          if (saved.photo_key) await removePhoto(ownerId, id, saved.photo_key);
          await rm(recordPath(ownerId, id), { force: true });
          return true;
        } catch (error) { return storageFailure(error); }
      });
    },
  };
}
