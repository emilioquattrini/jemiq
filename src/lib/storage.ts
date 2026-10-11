import { z } from 'zod';
import { sessionSchema } from '../../shared/schemas';
import type { ScanSession } from '../../shared/types';
import { prepareCatalog } from '../../server/storage/codec';
import { ApiError, apiHeaders } from './api';

export interface StorageStatus {
  mode: 'local' | 'cloud';
  state: 'local' | 'synced' | 'offline' | 'error' | 'conflict';
  message: string;
  pending: number;
}
export interface StorageConfiguration {
  mode: 'local' | 'cloud';
  ownerId?: string;
  onStatus?: (status: StorageStatus) => void;
}
export interface BackupImportResult { imported: number; renamed: number; sessions: ScanSession[] }
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;

interface Context { configuration: StorageConfiguration; namespace: string; headers: Headers }
interface SyncState {
  id: string;
  remoteUpdatedAt: string | null;
  pending: 'put' | 'delete' | null;
  conflict: boolean;
  hydrated: boolean;
  photoHash: string | null;
  // Identifies the local edit captured by an in-flight request. Older caches have no token.
  writeId?: string;
}
interface SyncRun { promise: Promise<void>; start: () => void; requested: number }
const SESSIONS = 'sessions';
const SYNC = 'sync';
const databases = new Map<string, Promise<IDBDatabase>>();
const writes = new Map<string, Promise<unknown>>();
const synchronizations = new Map<string, SyncRun>();
const SAVE_DELAY_MS = 180;
let configuration: StorageConfiguration = { mode: 'local' };

export function configureStorage(next: StorageConfiguration): void {
  configuration = { ...next };
}

function context(override?: StorageConfiguration): Context {
  const current = override ?? configuration;
  if (current.mode === 'cloud' && (!current.ownerId?.trim() || current.ownerId.length > 1024)) {
    throw new ApiError('Accedi prima di aprire l’archivio online.', 401, 'OWNER_REQUIRED');
  }
  const headers = new Headers(apiHeaders());
  if (current.mode === 'cloud') headers.set('X-Jemiq-Owner', current.ownerId!);
  return { configuration: current, namespace: current.mode === 'local' ? 'jemiq' : 'jemiq.cloud.' + encodeURIComponent(current.ownerId!), headers };
}

function database(ctx: Context): Promise<IDBDatabase> {
  const existing = databases.get(ctx.namespace);
  if (existing) return existing;
  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Il browser non consente il salvataggio locale. Esporta il catalogo prima di chiudere.'));
    // Version 2 adds sync bookkeeping; the original sessions object store is preserved.
    const request = indexedDB.open(ctx.namespace, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SESSIONS)) request.result.createObjectStore(SESSIONS, { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains(SYNC)) request.result.createObjectStore(SYNC, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); databases.delete(ctx.namespace); };
      resolve(db);
    };
    request.onerror = () => { databases.delete(ctx.namespace); reject(new Error('Il salvataggio locale non è disponibile. Esporta il catalogo prima di chiudere.')); };
    request.onblocked = () => { databases.delete(ctx.namespace); reject(new Error('Chiudi le altre schede di Jemiq e riprova a salvare.')); };
  });
  databases.set(ctx.namespace, promise);
  return promise;
}

async function readAll(ctx: Context): Promise<{ sessions: ScanSession[]; sync: SyncState[] }> {
  const db = await database(ctx);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SESSIONS, SYNC], 'readonly');
    const sessions = tx.objectStore(SESSIONS).getAll();
    const sync = tx.objectStore(SYNC).getAll();
    tx.oncomplete = () => {
      const parsed = z.array(sessionSchema).safeParse(sessions.result);
      if (!parsed.success) return reject(new Error('Una sessione salvata non è leggibile. I dati non sono stati cancellati; non svuotare i dati del browser.'));
      resolve({ sessions: parsed.data, sync: sync.result as SyncState[] });
    };
    tx.onerror = tx.onabort = () => reject(new Error('Non è stato possibile leggere la cronologia. Riprova a ricaricare la pagina.'));
  });
}

async function readOne(ctx: Context, id: string): Promise<{ session: ScanSession | null; sync: SyncState | null }> {
  const db = await database(ctx);
  return new Promise((resolve, reject) => {
    const tx = db.transaction([SESSIONS, SYNC], 'readonly');
    const session = tx.objectStore(SESSIONS).get(id);
    const sync = tx.objectStore(SYNC).get(id);
    tx.oncomplete = () => {
      const parsed = session.result === undefined ? null : sessionSchema.safeParse(session.result);
      if (parsed && !parsed.success) return reject(new Error('Il catalogo locale non è leggibile. I dati non sono stati cancellati.'));
      resolve({ session: parsed?.success ? parsed.data : null, sync: sync.result ?? null });
    };
    tx.onerror = tx.onabort = () => reject(new Error('Non è stato possibile leggere il catalogo locale.'));
  });
}

async function persist(ctx: Context, id: string, session: ScanSession | null, sync: SyncState | null): Promise<void> {
  const db = await database(ctx);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([SESSIONS, SYNC], 'readwrite');
    if (session) tx.objectStore(SESSIONS).put(session); else tx.objectStore(SESSIONS).delete(id);
    if (sync) tx.objectStore(SYNC).put(sync); else tx.objectStore(SYNC).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error('Spazio insufficiente o salvataggio locale non disponibile. Esporta il catalogo prima di chiudere.'));
  });
}

function serialize<T>(ctx: Context, id: string, operation: () => Promise<T>): Promise<T> {
  const key = ctx.namespace + '\0' + id;
  const previous = writes.get(key) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(() => undefined, () => undefined);
  writes.set(key, settled);
  void settled.then(() => { if (writes.get(key) === settled) writes.delete(key); });
  return result;
}

async function settle(ctx: Context): Promise<void> {
  await Promise.all([...writes].filter(([key]) => key.startsWith(ctx.namespace + '\0')).map(([, pending]) => pending));
}

async function emit(ctx: Context, state: StorageStatus['state'], message: string): Promise<void> {
  if (ctx.configuration !== configuration) return;
  let pending = 0;
  try { pending = (await readAll(ctx)).sync.filter((item) => item.pending).length; } catch { /* Preserve the original storage error. */ }
  if (ctx.configuration !== configuration) return;
  if (state === 'synced' && pending > 0) {
    state = 'offline';
    message = 'Alcune modifiche sono ancora nella copia locale e devono essere sincronizzate.';
  }
  try { ctx.configuration.onStatus?.({ mode: ctx.configuration.mode, state, message, pending }); } catch { /* Observers cannot prevent persistence. */ }
}

async function imageHash(image: string | null): Promise<string | null> {
  if (image === null) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readResponse(response: Response, limit = 12 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new ApiError('L’archivio ha restituito una risposta vuota.', 502, 'INVALID_STORAGE_RESPONSE');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body.cancel();
    throw new ApiError('La risposta dell’archivio è troppo grande.', 502, 'INVALID_STORAGE_RESPONSE');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ApiError('La risposta dell’archivio è troppo grande.', 502, 'INVALID_STORAGE_RESPONSE');
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

async function request(ctx: Context, path: string, init: RequestInit = {}, list = false): Promise<unknown> {
  try {
    const response = await fetch(path, { ...init, headers: ctx.headers, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(25_000) });
    if (!response.ok) {
      const body = await readResponse(response, 16 * 1024).catch(() => null);
      const parsed = z.object({ error: z.string().max(1000), code: z.string().max(80).optional() }).safeParse(body);
      throw new ApiError(parsed.success ? parsed.data.error : 'L’archivio non è disponibile. La copia locale è conservata.', response.status, parsed.success ? parsed.data.code : 'STORAGE_UNAVAILABLE');
    }
    return response.status === 204 ? null : await readResponse(response, list ? 32 * 1024 * 1024 : undefined);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('Connessione all’archivio non disponibile. La copia locale è conservata e sarà ritentata alla prossima apertura.', 0, 'STORAGE_OFFLINE');
  }
}

function catalogResponse(value: unknown, id: string): ScanSession {
  const result = z.object({ catalog: sessionSchema }).safeParse(value);
  if (!result.success || result.data.catalog.id !== id) throw new ApiError('L’archivio ha restituito un catalogo non valido.', 502, 'INVALID_STORAGE_RESPONSE');
  return result.data.catalog;
}

async function syncOne(ctx: Context, id: string): Promise<boolean> {
  const local = await serialize(ctx, id, () => readOne(ctx, id));
  if (!local.sync?.pending) return false;
  if (local.sync.conflict) throw new ApiError('La copia locale è conservata, ma esiste una versione online diversa.', 409, 'CATALOG_CONFLICT');
  try {
    if (local.sync.pending === 'delete') {
      try { await request(ctx, '/api/catalogs/' + encodeURIComponent(id), { method: 'DELETE' }); }
      catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
      await serialize(ctx, id, async () => {
        const current = await readOne(ctx, id);
        if (current.sync?.pending === 'delete' && current.sync.writeId === local.sync!.writeId) {
          await persist(ctx, id, null, null);
        } else if (current.sync?.pending) {
          // An edit made while DELETE was in flight becomes a new record after deletion.
          await persist(ctx, id, current.session, { ...current.sync, remoteUpdatedAt: null, photoHash: null });
        }
      });
    } else if (local.session) {
      const hash = await imageHash(local.session.image);
      const preservePhoto = local.sync.remoteUpdatedAt !== null && hash !== null && hash === local.sync.photoHash;
      const value = await request(ctx, '/api/catalogs/' + encodeURIComponent(id), {
        method: 'PUT',
        body: JSON.stringify({ catalog: { ...local.session, image: preservePhoto ? null : local.session.image }, expectedUpdatedAt: local.sync.remoteUpdatedAt, preservePhoto }),
      });
      const saved = catalogResponse(value, id);
      if (preservePhoto) saved.image = local.session.image;
      await serialize(ctx, id, async () => {
        const current = await readOne(ctx, id);
        if (current.sync?.pending === 'put' && current.sync.writeId === local.sync!.writeId) {
          await persist(ctx, id, saved, { id, remoteUpdatedAt: saved.updatedAt, pending: null, conflict: false, hydrated: true, photoHash: hash });
        } else if (current.sync?.pending) {
          // Keep the newest local snapshot, but use the acknowledged revision for its next CAS.
          await persist(ctx, id, current.session, { ...current.sync, remoteUpdatedAt: saved.updatedAt, photoHash: hash });
        }
      });
    } else {
      throw new ApiError('La copia locale da sincronizzare non è leggibile. I dati non sono stati cancellati.', 409, 'CATALOG_CONFLICT');
    }
    return true;
  } catch (error) {
    const conflict = error instanceof ApiError && error.status === 409;
    if (conflict) await serialize(ctx, id, async () => {
      const current = await readOne(ctx, id);
      if (current.sync?.pending === 'put') await persist(ctx, id, current.session, { ...current.sync, conflict: true });
    });
    await emit(ctx, conflict ? 'conflict' : error instanceof ApiError && [401, 403].includes(error.status) ? 'error' : 'offline',
      error instanceof Error ? error.message : 'La copia locale è conservata, ma il salvataggio online non è riuscito.');
    // Saving locally is useful, but the caller must never display a successful cloud save.
    throw error;
  }
}

function synchronize(ctx: Context, id: string, immediately = false): Promise<void> {
  const key = ctx.namespace + '\0' + id;
  const existing = synchronizations.get(key);
  if (existing) {
    existing.requested++;
    if (immediately) existing.start();
    return existing.promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start!: () => void;
  const ready = new Promise<void>((resolve) => {
    start = () => { clearTimeout(timer); resolve(); };
  });
  let run!: SyncRun;
  const promise = ready.then(async () => {
    while (true) {
      const requested = run.requested;
      if (await syncOne(ctx, id) || requested !== run.requested) continue;
      // Remove the completed drain before awaiting observers: a new edit must get a new drain.
      if (synchronizations.get(key) === run) synchronizations.delete(key);
      await emit(ctx, 'synced', 'Catalogo salvato nell’archivio online.');
      return;
    }
  });
  run = { promise, start, requested: 0 };
  synchronizations.set(key, run);
  const cleanup = () => { if (synchronizations.get(key) === run) synchronizations.delete(key); };
  void promise.then(cleanup, cleanup);
  timer = setTimeout(start, SAVE_DELAY_MS);
  if (immediately) start();
  return promise;
}

async function flush(ctx: Context): Promise<void> {
  const { sync } = await readAll(ctx);
  for (const item of sync.filter((item) => item.pending && !item.conflict)) {
    await synchronize(ctx, item.id, true);
  }
}

const sorted = (sessions: ScanSession[]) => sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

async function listSessions(ctx: Context, requireRemote = false): Promise<ScanSession[]> {
  await settle(ctx);
  const initial = await readAll(ctx);
  if (ctx.configuration.mode === 'local') return sorted(initial.sessions);
  try {
    await flush(ctx);
    const value = await request(ctx, '/api/catalogs', {}, true);
    const parsed = z.object({ catalogs: z.array(sessionSchema).max(5000) }).safeParse(value);
    if (!parsed.success) throw new ApiError('La cronologia online non è leggibile. I dati locali sono conservati.', 502, 'INVALID_STORAGE_RESPONSE');
    const remoteIds = new Set(parsed.data.catalogs.map((session) => session.id));
    const result: ScanSession[] = [];
    for (const remote of parsed.data.catalogs) {
      await serialize(ctx, remote.id, async () => {
        const local = await readOne(ctx, remote.id);
        if (local.sync?.pending === 'delete') return;
        if (local.sync?.pending === 'put' && local.session) { result.push(local.session); return; }
        // A list request may have started before an autosave completed. Never roll that save back.
        if (local.session && local.sync?.remoteUpdatedAt && local.sync.remoteUpdatedAt > remote.updatedAt) {
          result.push(local.session);
          return;
        }
        const sameRevision = local.sync?.remoteUpdatedAt === remote.updatedAt;
        const session = { ...remote, image: sameRevision ? local.session?.image ?? null : null };
        await persist(ctx, remote.id, session, { id: remote.id, remoteUpdatedAt: remote.updatedAt, pending: null, conflict: false,
          hydrated: !!sameRevision && !!local.sync?.hydrated, photoHash: sameRevision ? local.sync?.photoHash ?? null : null });
        result.push(session);
      });
    }
    const remaining = await readAll(ctx);
    for (const session of remaining.sessions) {
      if (remoteIds.has(session.id)) continue;
      const state = remaining.sync.find((item) => item.id === session.id);
      if (state?.pending === 'put' || !state?.remoteUpdatedAt) result.push(session);
      else if (!state?.pending) {
        const before = initial.sync.find((item) => item.id === session.id);
        if (before?.pending === null && before.remoteUpdatedAt === state.remoteUpdatedAt) {
          await serialize(ctx, session.id, async () => {
            const current = await readOne(ctx, session.id);
            if (!current.sync?.pending && current.sync?.remoteUpdatedAt === before.remoteUpdatedAt) await persist(ctx, session.id, null, null);
          });
        } else result.push(session);
      }
    }
    const conflicts = remaining.sync.filter((state) => state.conflict).length;
    await emit(ctx, conflicts ? 'conflict' : 'synced', conflicts ? 'Alcune modifiche locali richiedono una verifica prima della sincronizzazione.' : 'Archivio online aggiornato.');
    return sorted(result);
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 0;
    await emit(ctx, status === 409 ? 'conflict' : [401, 403].includes(status) ? 'error' : 'offline',
      'Archivio online non disponibile. Stai vedendo la copia conservata in questo browser.');
    if (requireRemote || [401, 403].includes(status)) throw error;
    const local = await readAll(ctx);
    const deleted = new Set(local.sync.filter((item) => item.pending === 'delete').map((item) => item.id));
    return sorted(local.sessions.filter((session) => !deleted.has(session.id)));
  }
}

export function loadSessions(): Promise<ScanSession[]> { return listSessions(context()); }

async function getSession(ctx: Context, id: string, requireRemote = false): Promise<ScanSession | null> {
  return serialize(ctx, id, async () => {
    const local = await readOne(ctx, id);
    if (local.sync?.pending === 'delete') return null;
    if (ctx.configuration.mode === 'local' || local.sync?.pending === 'put') return local.session;
    try {
      const saved = catalogResponse(await request(ctx, '/api/catalogs/' + encodeURIComponent(id)), id);
      await persist(ctx, id, saved, { id, remoteUpdatedAt: saved.updatedAt, pending: null, conflict: false, hydrated: true, photoHash: await imageHash(saved.image) });
      await emit(ctx, 'synced', 'Catalogo caricato dall’archivio online.');
      return saved;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        if (requireRemote) throw error;
        await persist(ctx, id, null, null);
        return null;
      }
      await emit(ctx, 'offline', 'Il catalogo online non è disponibile; la copia locale è conservata.');
      if (requireRemote || !local.sync?.hydrated || error instanceof ApiError && [401, 403].includes(error.status)) throw error;
      return local.session;
    }
  });
}

export function loadSession(id: string): Promise<ScanSession | null> { return getSession(context(), id); }

function save(ctx: Context, input: ScanSession): Promise<void> {
  const snapshot = sessionSchema.parse(input);
  // Local legacy data is preserved as-is. Cloud/backup writes additionally enforce portable storage limits.
  if (ctx.configuration.mode === 'cloud') prepareCatalog(snapshot);
  const savedLocally = serialize(ctx, snapshot.id, async () => {
    const previous = await readOne(ctx, snapshot.id);
    if (ctx.configuration.mode === 'local') {
      await persist(ctx, snapshot.id, snapshot, null);
      await emit(ctx, 'local', 'Catalogo salvato in questo browser.');
      return;
    }
    if (previous.sync && !previous.sync.hydrated && !previous.sync.pending) {
      throw new ApiError('Carica il catalogo completo prima di modificarlo: la foto non è ancora stata recuperata.', 409, 'CATALOG_NOT_LOADED');
    }
    const state: SyncState = { id: snapshot.id, remoteUpdatedAt: previous.sync?.remoteUpdatedAt ?? null, pending: 'put',
      conflict: previous.sync?.conflict ?? false, hydrated: true, photoHash: previous.sync?.photoHash ?? null, writeId: crypto.randomUUID() };
    await persist(ctx, snapshot.id, snapshot, state);
    if (state.conflict) {
      await emit(ctx, 'conflict', 'La modifica è conservata in locale. La versione online è cambiata: importa una copia dal backup per conservarle entrambe.');
      throw new ApiError('La copia locale è conservata, ma esiste una versione online diversa.', 409, 'CATALOG_CONFLICT');
    }
  });
  // A slow PUT never delays the next IndexedDB snapshot. Nearby edits share one remote drain.
  return savedLocally.then(() => ctx.configuration.mode === 'cloud' ? synchronize(ctx, snapshot.id) : undefined);
}

export function saveSession(session: ScanSession): Promise<void> { return save(context(), session); }

export function deleteSession(id: string): Promise<void> {
  const ctx = context();
  const savedLocally = serialize(ctx, id, async () => {
    const local = await readOne(ctx, id);
    if (ctx.configuration.mode === 'local') {
      await persist(ctx, id, null, null);
      await emit(ctx, 'local', 'Catalogo eliminato.');
      return;
    }
    await persist(ctx, id, local.session, { id, remoteUpdatedAt: local.sync?.remoteUpdatedAt ?? null, pending: 'delete',
      conflict: false, hydrated: local.sync?.hydrated ?? false, photoHash: local.sync?.photoHash ?? null, writeId: crypto.randomUUID() });
  });
  return savedLocally.then(() => ctx.configuration.mode === 'cloud' ? synchronize(ctx, id, true) : undefined);
}

export async function loadLocalSessions(): Promise<ScanSession[]> {
  return listSessions(context({ mode: 'local' }));
}

const backupSchema = z.object({
  format: z.literal('jemiq-catalog-backup'), version: z.literal(1), createdAt: z.string().datetime(),
  sessions: z.array(sessionSchema).max(5000),
}).strict();

export function parseBackup(text: string): z.infer<typeof backupSchema> {
  if (text.length > MAX_BACKUP_BYTES || new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) {
    throw new Error('Il backup supera 64 MiB. Importa cataloghi in gruppi più piccoli.');
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Il file non contiene un backup JSON leggibile.'); }
  const parsed = backupSchema.safeParse(value);
  if (!parsed.success) throw new Error('Questo file non è un backup Jemiq compatibile. Nessun catalogo è stato modificato.');
  for (const session of parsed.data.sessions) prepareCatalog(session);
  return parsed.data;
}

export function exportBackup(sessions: ScanSession[]): string {
  const backup = { format: 'jemiq-catalog-backup' as const, version: 1 as const, createdAt: new Date().toISOString(),
    sessions: sessions.map((session) => prepareCatalog(session).session) };
  const text = JSON.stringify(backup);
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new Error('Il backup supera 64 MiB. Esporta cataloghi in gruppi più piccoli.');
  return text;
}

/** A cloud backup is complete only after every required remote photograph has been fetched. */
export async function createBackup(): Promise<string> {
  const ctx = context();
  const sessions = await listSessions(ctx, ctx.configuration.mode === 'cloud');
  const complete: ScanSession[] = new Array(sessions.length);
  let next = 0;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(2, sessions.length) }, async () => {
    try {
      while (!failed && next < sessions.length) {
        const index = next++;
        const session = await getSession(ctx, sessions[index].id, true);
        if (!session) throw new Error('Un catalogo non è più disponibile. Riprova il backup; non è stato creato un file parziale.');
        complete[index] = session;
      }
    } catch (error) { failed = true; throw error; }
  }));
  return exportBackup(complete);
}

async function importSessions(ctx: Context, source: ScanSession[]): Promise<BackupImportResult> {
  const existing = await listSessions(ctx, ctx.configuration.mode === 'cloud');
  const ids = new Set(existing.map((session) => session.id));
  const sessions: ScanSession[] = [];
  let renamed = 0;
  // Validate the complete file before the first write. Collisions never overwrite an existing catalogue.
  const snapshots = source.map((session) => prepareCatalog(session).session);
  for (const original of snapshots) {
    const collision = ids.has(original.id);
    // Imports create independent records, including concurrent imports on another device.
    // Original IDs identify conflicts for the user; they are never an overwrite destination.
    let id = crypto.randomUUID();
    while (ids.has(id)) id = crypto.randomUUID();
    if (collision) renamed++;
    ids.add(original.id);
    ids.add(id);
    const session = { ...original, id, name: collision ? (original.name.slice(0, 1976) + ' — copia importata') : original.name,
      updatedAt: new Date().toISOString() };
    try { await save(ctx, session); }
    catch (error) {
      // The validated copy has already been retained locally if the remote write failed.
      const message = 'Importazione interrotta dopo ' + sessions.length + ' cataloghi. Le copie già salvate restano disponibili; controlla l’archivio prima di riprovare. ' + (error instanceof Error ? error.message : '');
      if (error instanceof ApiError) throw new ApiError(message, error.status, error.code);
      throw new Error(message);
    }
    sessions.push(session);
  }
  return { imported: sessions.length, renamed, sessions };
}

export function importBackup(text: string): Promise<BackupImportResult> {
  const parsed = parseBackup(text);
  return importSessions(context(), parsed.sessions);
}

export async function importLocalSessions(): Promise<BackupImportResult> {
  const ctx = context();
  if (ctx.configuration.mode !== 'cloud') throw new Error('Attiva l’archivio online prima di importare i cataloghi locali.');
  const local = await loadLocalSessions();
  return importSessions(ctx, local);
}
