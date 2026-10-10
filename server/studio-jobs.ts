import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { studioBriefSchema, studioImageSchema, type StudioBrief, type StudioImage, type StudioJob } from '../shared/studio';
import { StudioError } from './studio-errors';

export interface StudioJobOptions {
  generate: (brief: StudioBrief, signal?: AbortSignal) => Promise<StudioImage>;
  maxActive?: number;
  maxDurationMs?: number;
  ttlMs?: number;
  /** Retention of small request tombstones, separate from the image retention TTL. */
  idempotencyTtlMs?: number;
  maxJobs?: number;
  maxResults?: number;
  /** Conservative memory charge: two bytes per retained base64 character. */
  maxTotalBytes?: number;
  now?: () => number;
}

interface StoredJob {
  ownerId: string;
  fingerprint: string;
  job: StudioJob;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: number;
  forgetAt: number;
  expired: boolean;
  chargedBytes: number;
}

const bounded = (value: number | undefined, fallback: number, maximum: number) =>
  value !== undefined && Number.isFinite(value) && value >= 1 ? Math.min(Math.floor(value), maximum) : fallback;
const missing = () => new StudioError(404, 'STUDIO_JOB_NOT_FOUND',
  'La generazione non è disponibile in questa sessione. Il server potrebbe essere stato riavviato; il progetto locale è conservato.');
const expired = () => new StudioError(410, 'STUDIO_JOB_EXPIRED',
  'Lo sfondo temporaneo è scaduto. Usa la copia salvata nel progetto oppure avvia una nuova generazione.');
const unavailable = () => new StudioError(503, 'STUDIO_JOBS_UNAVAILABLE', 'Il servizio si sta riavviando. Il progetto locale è conservato.');
const publicFailure = (error: unknown): StudioJob['error'] => error instanceof StudioError
  ? { code: error.code.slice(0, 80), message: error.message.slice(0, 700) }
  : { code: 'STUDIO_GENERATION_FAILED', message: 'La generazione non è riuscita. Il progetto è conservato; puoi riprovare manualmente.' };

/** A bounded, single-process store for the private Render deployment, not a durable queue.
 * Authentication and request-rate budgets belong to the HTTP layer. ownerId must be
 * derived there from the authenticated, signed session, never accepted from a JSON body.
 * Tombstones prevent duplicate spending within their retention period; restarts lose
 * this store, so clients recover using GET and never automatically resubmit an old job.
 */
export function createStudioJobManager(options: StudioJobOptions) {
  const now = options.now ?? Date.now;
  const maxActive = bounded(options.maxActive, 1, 2);
  const maxDurationMs = bounded(options.maxDurationMs, 180_000, 300_000);
  const ttlMs = bounded(options.ttlMs, 30 * 60_000, 24 * 60 * 60_000);
  const idempotencyTtlMs = Math.max(ttlMs, bounded(options.idempotencyTtlMs, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000));
  const maxJobs = bounded(options.maxJobs, 256, 2000);
  const maxResults = bounded(options.maxResults, 4, 32);
  const maxTotalBytes = bounded(options.maxTotalBytes, 32 * 1024 * 1024, 128 * 1024 * 1024);
  const records = new Map<string, StoredJob>();
  const activeOwners = new Set<string>();
  let active = 0;
  let resultCount = 0;
  let resultBytes = 0;
  let closed = false;

  function identity(ownerId: string, id: string): { key: string; id: string } {
    if (typeof ownerId !== 'string' || !ownerId.length || ownerId.length > 256
      || !z.string().uuid().safeParse(id).success) {
      throw new StudioError(400, 'STUDIO_INVALID_JOB', 'L’identificativo della generazione non è valido.');
    }
    const canonical = id.toLowerCase();
    return { key: JSON.stringify([ownerId, canonical]), id: canonical };
  }

  function snapshot(record: StoredJob): StudioJob {
    // Images contain only immutable primitive fields. No caller receives mutable store objects.
    return { ...record.job, image: record.job.image ? { ...record.job.image } : null, error: record.job.error ? { ...record.job.error } : null };
  }

  function removeImage(record: StoredJob) {
    if (record.job.image) {
      resultCount--;
      resultBytes -= record.chargedBytes;
      record.job.image = null;
      record.chargedBytes = 0;
    }
  }

  function expire(record: StoredJob) {
    if (record.expired || record.job.status === 'running') return;
    removeImage(record);
    record.expired = true;
    record.job.expiresAt = new Date(now()).toISOString();
  }

  function finish(record: StoredJob, status: 'failed' | 'cancelled' | 'completed', error: StudioJob['error']) {
    if (record.job.status !== 'running') return false;
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    active--;
    activeOwners.delete(record.ownerId);
    record.job.status = status;
    record.job.error = error;
    record.job.updatedAt = new Date(now()).toISOString();
    record.job.expiresAt = new Date(now() + ttlMs).toISOString();
    record.forgetAt = Math.max(record.forgetAt, now() + ttlMs);
    return true;
  }

  function timeout(record: StoredJob) {
    if (!finish(record, 'failed', { code: 'STUDIO_JOB_TIMEOUT', message: 'La generazione ha superato il tempo disponibile. Il progetto è conservato; puoi riprovare manualmente.' })) return;
    record.controller.abort(new StudioError(504, 'STUDIO_JOB_TIMEOUT', 'Tempo disponibile superato.'));
  }

  function cleanup() {
    const timestamp = now();
    for (const [key, record] of records) {
      if (record.job.status === 'running' && timestamp >= record.deadline) timeout(record);
      if (record.job.status !== 'running' && timestamp >= Date.parse(record.job.expiresAt)) expire(record);
      if (record.job.status !== 'running' && timestamp >= record.forgetAt) {
        removeImage(record);
        records.delete(key);
      }
    }
  }

  const sweeper = setInterval(cleanup, Math.max(1000, Math.min(ttlMs, 60_000)));
  sweeper.unref?.();

  function find(ownerId: string, id: string) {
    cleanup();
    const { key } = identity(ownerId, id);
    const record = records.get(key);
    if (!record) throw missing();
    if (record.expired) throw expired();
    return record;
  }

  function complete(record: StoredJob, output: unknown) {
    if (record.job.status !== 'running') return; // Ignore late completion after cancellation or a deadline.
    const parsed = studioImageSchema.safeParse(output);
    if (!parsed.success) {
      finish(record, 'failed', { code: 'STUDIO_IMAGE_INVALID_RESPONSE', message: 'Il servizio non ha restituito uno sfondo valido. Il progetto è conservato.' });
      return;
    }
    const image = parsed.data;
    if (image.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)
      || Buffer.from(image.data, 'base64').toString('base64') !== image.data) {
      finish(record, 'failed', { code: 'STUDIO_IMAGE_INVALID_RESPONSE', message: 'Il servizio non ha restituito uno sfondo valido. Il progetto è conservato.' });
      return;
    }
    const chargedBytes = 2 * image.data.length;
    if (chargedBytes > maxTotalBytes) {
      finish(record, 'failed', { code: 'STUDIO_RESULT_TOO_LARGE', message: 'Lo sfondo supera lo spazio temporaneo disponibile sul server. Il progetto locale è conservato.' });
      return;
    }
    // Evict image payloads, not their idempotency tombstones. A known expired request
    // can never quietly become a second paid generation.
    const previous = [...records.values()].filter(item => item.job.status === 'completed' && item.job.image)
      .sort((a, b) => Date.parse(a.job.updatedAt) - Date.parse(b.job.updatedAt));
    for (const candidate of previous) {
      if (resultCount < maxResults && resultBytes + chargedBytes <= maxTotalBytes) break;
      expire(candidate);
    }
    if (!finish(record, 'completed', null)) return;
    record.job.image = image;
    record.chargedBytes = chargedBytes;
    resultCount++;
    resultBytes += chargedBytes;
  }

  return {
    submit(ownerId: string, requestId: string, brief: StudioBrief): StudioJob {
      if (closed) throw unavailable();
      cleanup();
      const identityValue = identity(ownerId, requestId);
      const parsed = studioBriefSchema.safeParse(brief);
      if (!parsed.success) throw new StudioError(400, 'STUDIO_INVALID_BRIEF', 'Controlla la descrizione e gli oggetti dell’ambientazione.');
      const fingerprint = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex');
      const existing = records.get(identityValue.key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new StudioError(409, 'STUDIO_REQUEST_CONFLICT',
          'Questo identificativo appartiene a un’altra richiesta. Avvia una nuova generazione per usare le modifiche.');
        if (existing.expired) throw expired();
        return snapshot(existing);
      }
      if (active >= maxActive || activeOwners.has(ownerId)) throw new StudioError(429, 'STUDIO_BUSY',
        'È già in corso una generazione. Attendi la conclusione prima di avviarne un’altra.');
      if (records.size >= maxJobs) throw new StudioError(429, 'STUDIO_JOB_CAPACITY',
        'Il servizio ha raggiunto il limite di richieste conservabili. Attendi prima di creare un nuovo sfondo.');
      const timestamp = now();
      const job: StudioJob = {
        id: identityValue.id,
        requestId: identityValue.id,
        status: 'running',
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
        expiresAt: new Date(timestamp + maxDurationMs + ttlMs).toISOString(),
        image: null,
        error: null,
      };
      const record: StoredJob = {
        ownerId, fingerprint, job, controller: new AbortController(), timer: null,
        deadline: timestamp + maxDurationMs, forgetAt: timestamp + idempotencyTtlMs,
        expired: false, chargedBytes: 0,
      };
      // Reserve the identity and slot synchronously before calling the provider.
      records.set(identityValue.key, record);
      active++;
      activeOwners.add(ownerId);
      record.timer = setTimeout(() => timeout(record), maxDurationMs);
      record.timer.unref?.();
      void Promise.resolve().then(() => {
        record.controller.signal.throwIfAborted();
        return options.generate(parsed.data, record.controller.signal);
      }).then(output => complete(record, output)).catch(error => {
        finish(record, 'failed', publicFailure(error));
      });
      return snapshot(record);
    },

    get(ownerId: string, id: string): StudioJob { return snapshot(find(ownerId, id)); },

    cancel(ownerId: string, id: string): StudioJob {
      const record = find(ownerId, id);
      if (finish(record, 'cancelled', { code: 'STUDIO_JOB_CANCELLED', message: 'Generazione annullata. Il progetto è conservato.' })) {
        record.controller.abort(new StudioError(499, 'STUDIO_JOB_CANCELLED', 'Generazione annullata.'));
      }
      return snapshot(record);
    },

    /** Called during server shutdown; work is never silently restarted by this manager. */
    dispose() {
      if (closed) return;
      closed = true;
      clearInterval(sweeper);
      for (const record of records.values()) {
        if (finish(record, 'failed', { code: 'STUDIO_JOB_INTERRUPTED', message: 'Il server ha interrotto la generazione. Il progetto locale è conservato.' })) {
          record.controller.abort(new StudioError(503, 'STUDIO_JOB_INTERRUPTED', 'Generazione interrotta.'));
        }
      }
    },
  };
}

export type StudioJobManager = ReturnType<typeof createStudioJobManager>;
