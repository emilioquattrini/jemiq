import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudioBriefService } from '../server/studio-brief';
import { studioBriefSchema, type StudioBriefInput } from '../shared/studio';
import type { CatalogCandidate } from '../shared/types';
import restDiscovery from './fixtures/gemini-text-response-format.json';
import modelContract from './fixtures/gemini-3.8-generation-config.json';

const input: StudioBriefInput = {
  book: { title: 'Le case del vento', authors: ['Ada Rossi'], isbn13: '9780743273565', publisher: 'Editore della prova', language: 'it', source: 'Google Books', sourceUrl: 'https://books.google.com/books?id=test-edition' },
  style: 'atmospheric', readerNote: 'Una lettura malinconica e serena.', mood: 'Sereno',
};
const candidate: CatalogCandidate = {
  id: 'google:test-edition', ...input.book, source: 'Google Books', sourceUrl: input.book.sourceUrl!,
  publishedDate: '2025', pageCount: 200, thumbnail: null, score: 1, matchReason: 'Edizione selezionata.',
  description: 'Una storia ambientata in un giardino vicino al mare.', categories: ['Narrativa'],
};
const generated = {
  summary: 'Luce naturale su un fondo chiaro, con pochi elementi ai lati e spazio libero per la copertina.',
  mood: 'Sereno e raccolto', palette: ['#E8DFD0', '#667B66'],
  elements: [
    { label: 'Una piccola foglia verde', basis: 'catalog', evidence: 'un giardino' },
    { label: 'Un lembo di lino chiaro', basis: 'style', evidence: null },
  ],
};
const envelope = (value: unknown, finishReason = 'STOP') => ({ candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(value) }] } }] });

function setup(options: { selected?: CatalogCandidate | null; response?: Response; key?: string; model?: string; timeoutMs?: number } = {}) {
  const getCandidate = vi.fn().mockResolvedValue(options.selected === undefined ? candidate : options.selected);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(options.response ?? Response.json(envelope(generated)));
  const service = createStudioBriefService({ apiKey: options.key ?? 'private-test-key', model: options.model ?? 'gemini-3.8-flash', catalog: { getCandidate }, fetchImpl, timeoutMs: options.timeoutMs });
  return { getCandidate, fetchImpl, service };
}

afterEach(() => vi.useRealTimers());

describe('Studio brief grounding', () => {
  it('retrieves the selected edition, preserves its identity and returns editable, sourced elements', async () => {
    const { service, getCandidate, fetchImpl } = setup();
    const brief = await service.create(input);
    expect(getCandidate).toHaveBeenCalledWith({ source: 'Google Books', sourceUrl: input.book.sourceUrl, isbn13: input.book.isbn13 }, expect.any(AbortSignal));
    expect(brief.book).toEqual(input.book);
    expect(brief.sources).toEqual([{ provider: 'Google Books', url: candidate.sourceUrl }]);
    expect(brief.basis).toBe('catalog');
    expect(brief.elements).toEqual(generated.elements.map(({ label, basis }, index) => ({ id: 'element-' + (index + 1), label, basis })));
    expect(brief.elements[0]).not.toHaveProperty('evidence');
    expect(studioBriefSchema.safeParse(brief).success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('uses the independently recorded REST output enum and keeps credentials out of URL and body', async () => {
    const { service, fetchImpl } = setup();
    await service.create(input);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(request?.headers).toMatchObject({ 'x-goog-api-key': 'private-test-key' });
    expect(request?.redirect).toBe('error');
    expect(request?.body).not.toContain('private-test-key');
    const body = JSON.parse(String(request?.body));
    const jsonIndex = restDiscovery.mimeType.enumDescriptions.indexOf('JSON output format.');
    expect(jsonIndex).toBeGreaterThanOrEqual(0);
    expect(body.generationConfig.responseFormat.text.mimeType).toBe(restDiscovery.mimeType.enum[jsonIndex]);
    for (const field of modelContract.unsupportedGenerationFields) expect(body.generationConfig).not.toHaveProperty(field);
    expect(body.tools).toBeUndefined();
    expect(body.systemInstruction.parts[0].text).toContain('UNTRUSTED DATA');
    expect(body.systemInstruction.parts[0].text).toContain('NO SPOILERS');
    const data = JSON.parse(body.contents[0].parts[0].text);
    expect(data.catalog.description).toBe(candidate.description);
    expect(data.reader.note).toBe(input.readerNote);
    expect(data.book).toEqual({ title: input.book.title, authors: input.book.authors });
  });

  it.each([
    { title: 'Un altro libro' }, { authors: ['Altro Autore'] }, { isbn13: '9780306406157' },
    { publisher: 'Altro editore' }, { language: 'en' }, { source: 'Open Library' as const },
  ])('does not use a conflicting selected source: %o', async (patch) => {
    const response = Response.json(envelope({ ...generated, elements: [{ label: 'Un lino morbido', basis: 'reader', evidence: 'serena' }] }));
    const { service, fetchImpl } = setup({ selected: { ...candidate, ...patch }, response });
    const brief = await service.create(input);
    expect(brief.sources).toEqual([]);
    expect(brief.basis).toBe('reader');
    expect(brief.warnings.join(' ')).toContain('non è stata riscontrata');
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(JSON.parse(body.contents[0].parts[0].text).catalog).toBeNull();
  });

  it('rejects client-supplied synopsis instead of treating it as catalogue evidence', async () => {
    const { service, fetchImpl, getCandidate } = setup();
    const forged = { ...input, book: { ...input.book, description: 'Invented source text' } };
    await expect(service.create(forged)).rejects.toMatchObject({ status: 400, code: 'STUDIO_INVALID_REQUEST' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getCandidate).not.toHaveBeenCalled();
  });

  it('supports reader-only inspiration without inventing a catalogue source', async () => {
    const { service } = setup({ selected: null, response: Response.json(envelope({ ...generated,
      elements: [{ label: 'Un tessuto dai toni delicati', basis: 'reader', evidence: 'malinconica e serena' }],
    })) });
    const brief = await service.create(input);
    expect(brief.sources).toEqual([]);
    expect(brief.basis).toBe('reader');
    expect(brief.elements[0].basis).toBe('reader');
    expect(brief.warnings.join(' ')).toContain('nessun elemento viene attribuito alla trama');
  });

  it.each(['atmospheric', 'minimal', 'cinematic'] as const)('provides a usable %s preset without a paid call when no metadata or reader context exists', async (style) => {
    const { service, fetchImpl } = setup({ selected: { ...candidate, description: null, categories: [] } });
    const brief = await service.create({ ...input, readerNote: '', mood: '', style });
    expect(brief.basis).toBe('style');
    expect(brief.style).toBe(style);
    expect(brief.sources).toEqual([]);
    expect(brief.elements.length).toBeLessThanOrEqual(3);
    expect(brief.elements.every((element) => element.basis === 'style')).toBe(true);
    expect(brief.warnings.join(' ')).toContain('solo sullo stile');
    expect(studioBriefSchema.safeParse(brief).success).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes the unconfigured AI fallback explicit and preserves an entered mood without interpreting the note', async () => {
    const { service, fetchImpl } = setup({ key: '' });
    const brief = await service.create(input);
    expect(brief.basis).toBe('reader');
    expect(brief.mood).toBe('Sereno');
    expect(brief.sources).toEqual([]);
    expect(brief.warnings.join(' ')).toContain('non è configurata');
    expect(brief.warnings.join(' ')).toContain('nota della recensione non è stata interpretata');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('Studio brief failure boundaries', () => {
  it.each([
    { ...generated, elements: [{ label: 'Una chiave', basis: 'catalog', evidence: 'un segreto svelato' }] },
    { ...generated, elements: [{ label: 'Una chiave', basis: 'reader', evidence: 'un giardino' }] },
    { ...generated, elements: [{ label: 'Un lino', basis: 'style', evidence: 'decorazione' }] },
    { ...generated, elements: Array.from({ length: 4 }, () => ({ label: 'Foglia', basis: 'style', evidence: null })) },
    { ...generated, palette: ['blue', 'green'] },
    { ...generated, sourceUrl: 'https://invented.example' },
  ])('falls back visibly for unsupported or malformed generated content without retrying', async (result) => {
    const { service, fetchImpl } = setup({ response: Response.json(envelope(result)) });
    const brief = await service.create(input);
    expect(brief.sources).toEqual([]);
    expect(brief.elements.every((element) => element.basis === 'style')).toBe(true);
    expect(brief.warnings.join(' ')).toContain('non era utilizzabile');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not accept a model assigning catalogue provenance when no catalogue text exists', async () => {
    const { service } = setup({ selected: null });
    const brief = await service.create(input);
    expect(brief.sources).toEqual([]);
    expect(brief.elements.every((element) => element.basis === 'style')).toBe(true);
    expect(brief.warnings.join(' ')).toContain('non era utilizzabile');
  });

  it.each(['MAX_TOKENS', 'SAFETY'])('does not accept a %s completion even when the JSON parses', async (reason) => {
    const { service } = setup({ response: Response.json(envelope(generated, reason)) });
    expect((await service.create(input)).warnings.join(' ')).toContain('non era utilizzabile');
  });

  it.each([400, 401, 429, 503])('redacts provider HTTP %s failures and makes only one request', async (status) => {
    const { service, fetchImpl } = setup({ response: new Response('private-test-key private-note provider stack', { status }) });
    const brief = await service.create(input);
    expect(brief.warnings.join(' ')).not.toMatch(/private-test-key|private-note|provider stack/);
    expect(brief.warnings.join(' ')).toContain('composizione semplice');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps a provider metadata failure distinct from a source synopsis and never echoes its raw message', async () => {
    const { service, getCandidate } = setup({ response: Response.json(envelope({ ...generated, elements: [] })) });
    getCandidate.mockRejectedValue(new Error('private catalog key'));
    const brief = await service.create(input);
    expect(brief.sources).toEqual([]);
    expect(brief.warnings.join(' ')).toContain('Il catalogo non è disponibile');
    expect(brief.warnings.join(' ')).not.toContain('private catalog key');
  });

  it('does not contact providers when the caller has already cancelled', async () => {
    const { service, getCandidate, fetchImpl } = setup();
    const controller = new AbortController();
    controller.abort('private reason');
    await expect(service.create(input, controller.signal)).rejects.toMatchObject({ status: 499, code: 'STUDIO_ABORTED' });
    expect(getCandidate).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds a stalled transport, cancels it and returns an explicit preset without a retry', async () => {
    vi.useFakeTimers();
    const { service, fetchImpl } = setup({ timeoutMs: 25 });
    let upstreamSignal: AbortSignal | null | undefined;
    fetchImpl.mockImplementation((_url, request) => {
      upstreamSignal = request?.signal;
      return new Promise<Response>(() => undefined);
    });
    const pending = service.create(input);
    await vi.advanceTimersByTimeAsync(26);
    const brief = await pending;
    expect(brief.warnings.join(' ')).toContain('troppo tempo');
    expect(brief.sources).toEqual([]);
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('bounds a stalled catalogue and prevents a later paid call', async () => {
    vi.useFakeTimers();
    const { service, getCandidate, fetchImpl } = setup({ timeoutMs: 25 });
    let resolveCandidate: (value: CatalogCandidate) => void = () => undefined;
    getCandidate.mockImplementation(() => new Promise<CatalogCandidate>((resolve) => { resolveCandidate = resolve; }));
    const pending = service.create(input);
    await vi.advanceTimersByTimeAsync(26);
    expect((await pending).warnings.join(' ')).toContain('troppo tempo');
    resolveCandidate(candidate);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cancels an in-flight body and does not turn user cancellation into a fallback', async () => {
    const cancel = vi.fn();
    const { service, fetchImpl } = setup({ response: new Response(new ReadableStream({ cancel })) });
    const controller = new AbortController();
    const pending = service.create(input, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'STUDIO_ABORTED', status: 499 });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort('private reason');
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects oversized upstream bodies without trusting content-length', async () => {
    const { service } = setup({ response: new Response('x'.repeat(256 * 1024 + 1)) });
    expect((await service.create(input)).warnings.join(' ')).toContain('non era utilizzabile');
  });
});
