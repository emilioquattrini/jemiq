import { sessionSchema } from '../../shared/schemas';
import type { ScanSession } from '../../shared/types';

const DB_NAME = 'jemiq';
const STORE = 'sessions';
let opening: Promise<IDBDatabase> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Il browser non consente il salvataggio locale. Esporta il catalogo prima di chiudere.'));
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    request.onerror = () => { opening = null; reject(new Error('Il salvataggio locale non è disponibile. Esporta il catalogo prima di chiudere.')); };
    request.onblocked = () => { opening = null; reject(new Error('Chiudi le altre schede di Jemiq e riprova a salvare.')); };
  });
  return opening;
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const task = queue.then(operation, operation);
  queue = task.catch(() => {});
  return task;
}

export async function loadSessions(): Promise<ScanSession[]> {
  await queue;
  const db = await database();
  const values = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Non è stato possibile leggere la cronologia. Riprova a ricaricare la pagina.'));
  });
  const sessions: ScanSession[] = [];
  for (const value of values) {
    const parsed = sessionSchema.safeParse(value);
    if (!parsed.success) throw new Error('Una sessione salvata non è leggibile. I dati non sono stati cancellati; non svuotare i dati del browser.');
    sessions.push(parsed.data);
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveSession(session: ScanSession): Promise<void> {
  const snapshot = sessionSchema.parse(session);
  return serialize(async () => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(snapshot);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('Spazio insufficiente o salvataggio non disponibile. Esporta il catalogo prima di chiudere la pagina.'));
    });
  });
}

export function deleteSession(id: string): Promise<void> {
  return serialize(async () => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(new Error('Non è stato possibile eliminare questa sessione. Riprova.'));
    });
  });
}
