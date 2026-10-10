import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioJobManager, type StudioJobManager, type StudioJobOptions } from '../server/studio-jobs';
import { StudioError } from '../server/studio-errors';
import type { StudioBrief, StudioImage } from '../shared/studio';

const brief: StudioBrief = {
  book: { title: 'Un libro', authors: ['Una autrice'], isbn13: null, publisher: null, language: 'it', source: null, sourceUrl: null },
  style: 'minimal', summary: 'La descrizione del lettore.', mood: 'Sereno', palette: ['#335577', '#DDEEFF'],
  elements: [{ id: 'leaf', label: 'Una foglia', basis: 'reader' }], sources: [], warnings: [], basis: 'reader',
};
// This suite exercises job ownership, lifecycle and retained bytes. Image container
// decoding belongs to the separately tested image adapter; no Gemini calls are made.
const image: StudioImage = { mimeType: 'image/png', data: Buffer.from('mocked stored image bytes').toString('base64'), width: 1856, height: 2304 };
const charge = 2 * image.data.length;
const managers: StudioJobManager[] = [];

function create(options: Partial<StudioJobOptions> = {}) {
  const generate = vi.fn<StudioJobOptions['generate']>().mockResolvedValue(image);
  const manager = createStudioJobManager({ generate, ...options });
  managers.push(manager);
  return { manager, generate };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.useRealTimers();
});

describe('studio job identity and recovery', () => {
  it('registers a request synchronously and recovers it using the client-persisted requestId', async () => {
    const pending = deferred<StudioImage>();
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValue(pending.promise);
    const { manager } = create({ generate });
    const id = randomUUID();
    const submitted = manager.submit('signed-owner', id, brief);
    expect(submitted).toMatchObject({ id, requestId: id, status: 'running', image: null, error: null });
    // Simulate losing the POST response: GET works using only the persisted requestId.
    expect(manager.get('signed-owner', id)).toEqual(submitted);
    await settle();
    expect(generate).toHaveBeenCalledOnce();
    pending.resolve(image);
    await settle();
    expect(manager.get('signed-owner', id)).toMatchObject({ id, status: 'completed', image, error: null });
    expect(submitted.status).toBe('running');
  });

  it('deduplicates simultaneous POSTs before calling the paid dependency', async () => {
    const pending = deferred<StudioImage>();
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValue(pending.promise);
    const { manager } = create({ generate });
    const id = randomUUID();
    const jobs = Array.from({ length: 20 }, () => manager.submit('owner', id, structuredClone(brief)));
    expect(jobs.every(job => job.id === id && job.status === 'running')).toBe(true);
    await settle();
    expect(generate).toHaveBeenCalledOnce();
    pending.resolve(image); await settle();
    expect(manager.submit('owner', id, brief)).toMatchObject({ status: 'completed', image });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('rejects reuse of an identity with changed inspiration instead of silently charging again', async () => {
    const { manager, generate } = create();
    const id = randomUUID();
    manager.submit('owner', id, brief);
    expect(() => manager.submit('owner', id, { ...brief, mood: 'Drammatico' })).toThrow(expect.objectContaining({ status: 409, code: 'STUDIO_REQUEST_CONFLICT' }));
    await settle();
    expect(generate).toHaveBeenCalledOnce();
  });

  it('canonicalizes UUID case without creating a second request', async () => {
    const { manager, generate } = create();
    const id = randomUUID();
    expect(manager.submit('owner', id.toUpperCase(), brief).id).toBe(id);
    expect(manager.submit('owner', id, brief).id).toBe(id);
    await settle();
    expect(generate).toHaveBeenCalledOnce();
    expect(manager.get('owner', id.toUpperCase()).status).toBe('completed');
  });

  it('isolates the same requestId across independently authenticated owners', async () => {
    const { manager, generate } = create({ maxActive: 2 });
    const id = randomUUID();
    manager.submit('owner-a', id, brief);
    manager.submit('owner-b', id, { ...brief, mood: 'Diverso' });
    expect(() => manager.get('owner-c', id)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => manager.cancel('owner-c', id)).toThrow(expect.objectContaining({ status: 404 }));
    await settle();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(manager.get('owner-a', id).status).toBe('completed');
    expect(manager.get('owner-b', id).status).toBe('completed');
  });

  it('does not expose mutable job, image or error objects to callers', async () => {
    const { manager } = create();
    const id = randomUUID();
    const job = manager.submit('owner', id, brief);
    job.status = 'failed';
    expect(manager.get('owner', id).status).toBe('running');
    await settle();
    const finished = manager.get('owner', id);
    finished.image!.data = 'modified by caller';
    finished.expiresAt = new Date(0).toISOString();
    expect(manager.get('owner', id)).toMatchObject({ status: 'completed', image });
  });

  it('snapshots the validated brief before asynchronous work starts', async () => {
    const { manager, generate } = create();
    const input = structuredClone(brief);
    manager.submit('owner', randomUUID(), input);
    input.summary = 'Changed after submission';
    input.elements[0].label = 'Changed object';
    await settle();
    expect(generate.mock.calls[0][0].summary).toBe(brief.summary);
    expect(generate.mock.calls[0][0].elements[0].label).toBe(brief.elements[0].label);
  });

  it('does not implicitly recreate a job after a simulated process restart', async () => {
    const first = create();
    const id = randomUUID(); first.manager.submit('owner', id, brief); await settle();
    first.manager.dispose();
    const restarted = create();
    expect(() => restarted.manager.get('owner', id)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_NOT_FOUND', status: 404 }));
    expect(restarted.generate).not.toHaveBeenCalled();
  });

  it.each(['not-a-uuid', '', '../../other-job'])('rejects invalid request identity %s before spending a request', async id => {
    const { manager, generate } = create();
    expect(() => manager.submit('owner', id, brief)).toThrow(expect.objectContaining({ code: 'STUDIO_INVALID_JOB', status: 400 }));
    await settle(); expect(generate).not.toHaveBeenCalled();
  });

  it('rejects invalid briefs and cover payloads without occupying a slot', async () => {
    const { manager, generate } = create();
    const id = randomUUID();
    expect(() => manager.submit('owner', id, { ...brief, image } as StudioBrief)).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => manager.submit('owner', id, { ...brief, summary: '' })).toThrow(expect.objectContaining({ status: 400 }));
    manager.submit('owner', id, brief); await settle();
    expect(generate).toHaveBeenCalledOnce();
  });
});

describe('studio job failure and cancellation', () => {
  it('redacts unexpected provider exceptions and does not retry failed identities', async () => {
    const generate = vi.fn<StudioJobOptions['generate']>().mockRejectedValue(new Error('private-key upstream prompt personal-data'));
    const { manager } = create({ generate });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    const failed = manager.get('owner', id);
    expect(failed).toMatchObject({ status: 'failed', image: null, error: { code: 'STUDIO_GENERATION_FAILED' } });
    expect(failed.error?.message).not.toMatch(/private-key|upstream prompt|personal-data/);
    expect(manager.submit('owner', id, brief)).toEqual(failed);
    expect(generate).toHaveBeenCalledOnce();
    manager.submit('owner', randomUUID(), brief); await settle();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('preserves safe shared StudioError messages in failed jobs', async () => {
    const generate = vi.fn<StudioJobOptions['generate']>().mockRejectedValue(new StudioError(429, 'STUDIO_IMAGE_RATE_LIMIT', 'Quota esaurita.'));
    const { manager } = create({ generate });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    expect(manager.get('owner', id)).toMatchObject({ status: 'failed', error: { code: 'STUDIO_IMAGE_RATE_LIMIT', message: 'Quota esaurita.' } });
    const returned = manager.get('owner', id); returned.error!.message = 'changed';
    expect(manager.get('owner', id).error?.message).toBe('Quota esaurita.');
  });

  it('handles synchronous dependency failure without leaking an active slot', async () => {
    const generate = vi.fn<StudioJobOptions['generate']>().mockImplementation(() => { throw new Error('internal'); });
    const { manager } = create({ generate });
    const first = randomUUID(); manager.submit('owner', first, brief); await settle();
    expect(manager.get('owner', first).status).toBe('failed');
    expect(() => manager.submit('owner', randomUUID(), brief)).not.toThrow();
    await settle(); expect(generate).toHaveBeenCalledTimes(2);
  });

  it('cancels before provider dispatch without spending a request', async () => {
    const { manager, generate } = create();
    const id = randomUUID(); manager.submit('owner', id, brief);
    expect(manager.cancel('owner', id)).toMatchObject({ status: 'cancelled', error: { code: 'STUDIO_JOB_CANCELLED' } });
    await settle(); expect(generate).not.toHaveBeenCalled();
    expect(manager.submit('owner', id, brief).status).toBe('cancelled');
    expect(generate).not.toHaveBeenCalled();
  });

  it('propagates cancellation and ignores late completion without releasing a newer job’s slot', async () => {
    const first = deferred<StudioImage>(); const second = deferred<StudioImage>();
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { manager } = create({ generate });
    const firstId = randomUUID(); manager.submit('owner', firstId, brief); await settle();
    const signal = generate.mock.calls[0][1]!;
    manager.cancel('owner', firstId);
    expect(signal.aborted).toBe(true);
    const secondId = randomUUID(); manager.submit('owner', secondId, brief); await settle();
    first.resolve(image); await settle();
    expect(manager.get('owner', firstId).status).toBe('cancelled');
    expect(manager.get('owner', firstId).image).toBeNull();
    expect(manager.get('owner', secondId).status).toBe('running');
    expect(() => manager.submit('another-owner', randomUUID(), brief)).toThrow(expect.objectContaining({ code: 'STUDIO_BUSY' }));
    second.resolve(image); await settle();
    expect(manager.get('owner', secondId).status).toBe('completed');
  });

  it('bounds an uncooperative dependency and releases its slot at the job deadline', async () => {
    vi.useFakeTimers();
    const first = deferred<StudioImage>(); const second = deferred<StudioImage>();
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { manager } = create({ generate, maxDurationMs: 25 });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    await vi.advanceTimersByTimeAsync(26);
    expect(generate.mock.calls[0][1]?.aborted).toBe(true);
    expect(manager.get('owner', id)).toMatchObject({ status: 'failed', image: null, error: { code: 'STUDIO_JOB_TIMEOUT' } });
    const nextId = randomUUID(); manager.submit('owner', nextId, brief); await settle();
    first.resolve(image); await settle();
    expect(manager.get('owner', id).status).toBe('failed');
    expect(manager.get('owner', nextId).status).toBe('running');
    expect(() => manager.submit('other', randomUUID(), brief)).toThrow(expect.objectContaining({ code: 'STUDIO_BUSY' }));
    second.resolve(image); await settle();
    expect(manager.get('owner', nextId).status).toBe('completed');
  });

  it('does not extend generation deadlines through polling or duplicate submits', async () => {
    vi.useFakeTimers();
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValue(new Promise(() => undefined));
    const { manager } = create({ generate, maxDurationMs: 25 });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    await vi.advanceTimersByTimeAsync(15);
    manager.get('owner', id); manager.submit('owner', id, brief);
    await vi.advanceTimersByTimeAsync(11);
    expect(manager.get('owner', id).error?.code).toBe('STUDIO_JOB_TIMEOUT');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('leaves a completed result intact if cancellation arrives late', async () => {
    const { manager, generate } = create();
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    expect(manager.cancel('owner', id)).toMatchObject({ status: 'completed', image });
    expect(generate).toHaveBeenCalledOnce();
  });

  it('interrupts outstanding work on shutdown and forbids new work', async () => {
    const pending = deferred<StudioImage>();
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValue(pending.promise);
    const { manager } = create({ generate });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    manager.dispose(); manager.dispose();
    expect(generate.mock.calls[0][1]?.aborted).toBe(true);
    expect(manager.get('owner', id)).toMatchObject({ status: 'failed', error: { code: 'STUDIO_JOB_INTERRUPTED' } });
    expect(() => manager.submit('owner', randomUUID(), brief)).toThrow(expect.objectContaining({ code: 'STUDIO_JOBS_UNAVAILABLE', status: 503 }));
    pending.resolve(image); await settle();
    expect(manager.get('owner', id).status).toBe('failed');
  });
});

describe('studio job resource limits', () => {
  it('enforces both the global active limit and one active job per owner', async () => {
    const generate = vi.fn<StudioJobOptions['generate']>().mockReturnValue(new Promise(() => undefined));
    const { manager } = create({ generate, maxActive: 2 });
    manager.submit('owner-a', randomUUID(), brief);
    expect(() => manager.submit('owner-a', randomUUID(), brief)).toThrow(expect.objectContaining({ code: 'STUDIO_BUSY' }));
    manager.submit('owner-b', randomUUID(), brief);
    expect(() => manager.submit('owner-c', randomUUID(), brief)).toThrow(expect.objectContaining({ code: 'STUDIO_BUSY' }));
    await settle(); expect(generate).toHaveBeenCalledTimes(2);
  });

  it('expires image payloads while preserving the tombstone against duplicate spending', async () => {
    vi.useFakeTimers();
    const { manager, generate } = create({ ttlMs: 10, idempotencyTtlMs: 1000 });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    await vi.advanceTimersByTimeAsync(11);
    expect(() => manager.get('owner', id)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_EXPIRED', status: 410 }));
    expect(() => manager.submit('owner', id, brief)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_EXPIRED', status: 410 }));
    expect(generate).toHaveBeenCalledOnce();
  });

  it.each([
    { maxResults: 1 },
    { maxResults: 8, maxTotalBytes: charge + Math.floor(charge / 2) },
  ])('bounds retained results by count and conservative byte charge', async options => {
    const { manager, generate } = create(options);
    const first = randomUUID(); manager.submit('owner', first, brief); await settle();
    const second = randomUUID(); manager.submit('owner', second, brief); await settle();
    expect(() => manager.get('owner', first)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_EXPIRED', status: 410 }));
    expect(() => manager.submit('owner', first, brief)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_EXPIRED' }));
    expect(manager.get('owner', second)).toMatchObject({ status: 'completed', image });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('fails safely for a single result larger than the entire memory budget', async () => {
    const { manager, generate } = create({ maxTotalBytes: charge - 1 });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    expect(manager.get('owner', id)).toMatchObject({ status: 'failed', image: null, error: { code: 'STUDIO_RESULT_TOO_LARGE' } });
    expect(manager.submit('owner', id, brief).status).toBe('failed');
    expect(generate).toHaveBeenCalledOnce();
  });

  it('bounds metadata without evicting idempotency protection early', async () => {
    vi.useFakeTimers();
    const { manager, generate } = create({ maxJobs: 2, ttlMs: 10, idempotencyTtlMs: 1000 });
    const first = randomUUID(); const second = randomUUID();
    manager.submit('owner', first, brief); await settle();
    manager.submit('owner', second, brief); await settle();
    await vi.advanceTimersByTimeAsync(11);
    expect(() => manager.submit('owner', randomUUID(), brief)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_CAPACITY', status: 429 }));
    expect(() => manager.submit('owner', first, brief)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_EXPIRED' }));
    expect(generate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(() => manager.get('owner', first)).toThrow(expect.objectContaining({ code: 'STUDIO_JOB_NOT_FOUND' }));
    manager.submit('owner', randomUUID(), brief); await settle();
    expect(generate).toHaveBeenCalledTimes(3);
  });

  it.each([
    { ...image, data: 'not canonical base64' },
    { ...image, width: 0 },
    { ...image, mimeType: 'text/html' },
    { ...image, unexpected: 'provider metadata' },
  ])('does not store malformed generator output or expose it as a completed job', async output => {
    const generate = vi.fn<StudioJobOptions['generate']>().mockResolvedValue(output as StudioImage);
    const { manager } = create({ generate });
    const id = randomUUID(); manager.submit('owner', id, brief); await settle();
    expect(manager.get('owner', id)).toMatchObject({ status: 'failed', image: null, error: { code: 'STUDIO_IMAGE_INVALID_RESPONSE' } });
  });
});
