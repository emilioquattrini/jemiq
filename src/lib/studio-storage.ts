import { z } from 'zod';
import { studioBookSchema, studioBriefSchema, studioImageSchema, studioStyleSchema, type StudioProject } from '../../shared/studio';

const photo = z.object({ dataUrl: z.string().max(22_400_000).regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/), width: z.number().int().min(1).max(8192), height: z.number().int().min(1).max(8192) }).strict();
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).strict();
// Local drafts may contain fields cleared during editing. The shared generation
// schema still requires nonempty text; all other brief constraints are inherited.
const draftBriefSchema = studioBriefSchema.extend({
  summary: z.string().trim().max(900),
  mood: z.string().trim().max(160),
  elements: z.array(studioBriefSchema.shape.elements.element.extend({ label: z.string().trim().max(140) })).max(3),
});
export const studioProjectSchema = z.object({
  id: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  photo: photo.nullable(), corners: z.tuple([point, point, point, point]), cover: photo.nullable(),
  book: studioBookSchema.extend({ title: z.string().max(400) }),
  style: studioStyleSchema, readerNote: z.string().max(1200), mood: z.string().max(120),
  brief: draftBriefSchema.nullable(), image: studioImageSchema.nullable(),
  format: z.enum(['post', 'story']), scale: z.number().min(0.55).max(1.3), rotation: z.number().min(-18).max(18),
  offsetX: z.number().min(-0.3).max(0.3), offsetY: z.number().min(-0.3).max(0.3), caption: z.string().max(100),
  jobId: z.string().uuid().nullable(), requestId: z.string().uuid().nullable(),
}).strict();
let opening: Promise<IDBDatabase> | null = null;
let queue: Promise<unknown> = Promise.resolve();
const MAX_PROJECTS = 20;
function database(): Promise<IDBDatabase> {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { opening = null; reject(new Error('Il salvataggio locale non è disponibile. Scarica le immagini prima di chiudere.')); return; }
    const request = indexedDB.open('jemiq-studio', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('projects', { keyPath: 'id' });
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    request.onerror = () => { opening = null; reject(new Error('Non è possibile salvare questo progetto nel browser. Scarica l’immagine prima di chiudere.')); };
    request.onblocked = () => { opening = null; reject(new Error('Chiudi le altre schede di Jemiq e riprova a salvare.')); };
  });
  return opening;
}
function serialize<T>(operation: () => Promise<T>): Promise<T> { const task = queue.then(operation, operation); queue = task.catch(() => {}); return task; }
export async function loadStudioProjects(): Promise<StudioProject[]> {
  await queue;
  const db = await database();
  const values = await new Promise<unknown[]>((resolve, reject) => { const request = db.transaction('projects', 'readonly').objectStore('projects').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Non è possibile leggere i progetti salvati. Riprova a ricaricare la pagina.')); });
  const parsed = z.array(studioProjectSchema).safeParse(values);
  if (!parsed.success) throw new Error('Un progetto salvato non è leggibile. I dati sono conservati; evita di svuotare il browser.');
  return parsed.data.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function saveStudioProject(project: StudioProject): Promise<void> {
  const snapshot = studioProjectSchema.parse(project);
  return serialize(async () => {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('projects', 'readwrite'), store = transaction.objectStore('projects');
      let reason = 'Spazio insufficiente o salvataggio non disponibile. Scarica l’immagine prima di chiudere.';
      const existing = store.getKey(snapshot.id);
      existing.onsuccess = () => {
        if (existing.result !== undefined) { store.put(snapshot); return; }
        const count = store.count(); count.onsuccess = () => {
          if (count.result >= MAX_PROJECTS) { reason = 'Hai 20 progetti salvati. Scarica le immagini ed elimina un progetto prima di crearne un altro.'; transaction.abort(); }
          else store.put(snapshot);
        };
      };
      transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(new Error(reason));
    });
  });
}
export function deleteStudioProject(id: string): Promise<void> {
  return serialize(async () => { const db = await database(); await new Promise<void>((resolve, reject) => { const transaction = db.transaction('projects', 'readwrite'); transaction.objectStore('projects').delete(id); transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(new Error('Non è stato possibile eliminare il progetto. Riprova.')); }); });
}
