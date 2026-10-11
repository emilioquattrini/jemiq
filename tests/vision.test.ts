import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisionService, MAX_IMAGE_BYTES, MAX_OBSERVATIONS, VisionError } from '../server/vision.js';
import type { Observation } from '../shared/types.js';
import jsonRequestContract from './fixtures/gemini-json-request.json';
import modelContract from './fixtures/gemini-3.8-generation-config.json';

// A tiny PNG exercises the transport contract only. These mocked tests do not measure
// recognition accuracy on photographs, which requires a configured API and real book photos.
const image = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==',
};
const observed: Observation = {
  title: 'Il nome della rosa', authors: ['Umberto Eco'], visibleIsbn: null,
  publisher: 'Bompiani', language: 'it', evidence: 'UMBERTO ECO — IL NOME DELLA ROSA — BOMPIANI',
  position: 'Primo ripiano, primo da sinistra', confidence: 'high', boundingBox: [100, 80, 700, 160],
};

function envelope(result: unknown, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { parts: [{ text: JSON.stringify(result) }] } }] };
}

function withResponse(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  return {
    fetchMock,
    service: createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('vision recognition contract', () => {
  it('uses one server-side authenticated request and keeps separate physical copies', async () => {
    const duplicate: Observation = { ...observed, position: 'Primo ripiano, secondo da sinistra', boundingBox: [100, 165, 700, 245] };
    const { service, fetchMock } = withResponse(Response.json(envelope({ observations: [observed, duplicate], warnings: [] })));
    const result = await service.recognize(image, 'shelf');

    expect(result.observations).toEqual([observed, duplicate]);
    expect(result.observations.every((book) => book.visibleIsbn === null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(String(url)).not.toContain('private-test-key');
    expect(request?.headers).toMatchObject({ 'x-goog-api-key': 'private-test-key' });
    expect(request?.redirect).toBe('manual');
    expect(request?.body).not.toContain('private-test-key');
    const body = JSON.parse(String(request?.body));
    expect(body.contents[0].parts[0].inlineData).toEqual(image);
    expect(body.generationConfig.responseJsonSchema.required).toEqual(['observations', 'warnings']);
    expect(body.tools).toBeUndefined();
    expect(body.systemInstruction.parts[0].text).toContain('UNTRUSTED DATA');
  });

  it('rejects redirects without forwarding the photo or API key to another endpoint', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { status, headers: { Location: 'https://untrusted.example/photo-sink' } });
      const { service, fetchMock } = withResponse(response);
      await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_UNAVAILABLE', status: 503 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
      expect(String(fetchMock.mock.calls[0][0])).not.toContain('untrusted.example');
      expect(cancel).toHaveBeenCalledOnce();
    }
  });

  it('serializes the JSON request using the official SDK field pair', async () => {
    // This controlled transport protects the selected serialization contract.
    // It does not establish which part of the production request caused HTTP 400.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, request) => {
      const config = JSON.parse(String(request?.body)).generationConfig;
      if (Object.hasOwn(config, 'responseFormat')) return Response.json({ error: {
        code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.',
      } }, { status: 400 });
      expect(config.responseMimeType).toBe(jsonRequestContract.responseMimeType);
      expect(config.responseJsonSchema.type).toBe('object');
      expect(config.responseJsonSchema.required).toEqual(['observations', 'warnings']);
      expect(config.responseJsonSchema.properties.observations.items.properties.title.type).toEqual(['string', 'null']);
      expect(config.responseSchema).toBeUndefined();
      expect(config._responseJsonSchema).toBeUndefined();
      return Response.json(envelope({ observations: [observed], warnings: [] }));
    });
    const service = createVisionService({ apiKey: 'private-test-key', model: modelContract.model, fetchImpl: fetchMock });
    await expect(service.recognize(image, 'shelf')).resolves.toEqual({ observations: [observed], warnings: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('passes the Gemini 3.8 model contract when unsupported fields are rejected', async () => {
    // The general discovery schema covers several model generations. The model's
    // migration guide adds restrictions that the MIME-enum fixture cannot verify.
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, request) => {
      const body = JSON.parse(String(request?.body));
      const unsupported = modelContract.unsupportedGenerationFields.find((field) =>
        Object.hasOwn(body.generationConfig, field));
      if (unsupported) return Response.json({ error: {
        code: 400, status: 'INVALID_ARGUMENT', message: `Unsupported field: ${unsupported}`,
      } }, { status: 400 });
      return Response.json(envelope({ observations: [observed], warnings: [] }));
    });
    const service = createVisionService({
      apiKey: 'private-test-key', model: modelContract.model, fetchImpl: fetchMock,
    });

    await expect(service.recognize(image, 'shelf')).resolves.toEqual({ observations: [observed], warnings: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps partial observations incomplete instead of requiring invented fields', async () => {
    const partial = { ...observed, title: 'Il nome', authors: [], publisher: null, language: null, confidence: 'low', boundingBox: null };
    const warning = 'Alcuni dorsi sono sfocati: avvicina la fotocamera.';
    const { service } = withResponse(Response.json(envelope({ observations: [partial], warnings: [warning, warning] })));
    await expect(service.recognize(image, 'table')).resolves.toEqual({ observations: [partial], warnings: [warning] });
  });

  it('keeps valid physical copies when another row is malformed, with an explicit partial-results warning', async () => {
    const secondCopy = { ...observed, position: 'Seconda copia, a destra' };
    const invalid = { ...observed, authors: Array.from({ length: 9 }, (_, index) => `Autore ${index}`) };
    const { service, fetchMock } = withResponse(Response.json(envelope({
      observations: [observed, invalid, secondCopy], warnings: ['Un dorso è sfocato.'],
    })));
    const result = await service.recognize(image, 'shelf');
    expect(result.observations).toEqual([observed, secondCopy]);
    expect(result.warnings[0]).toBe('Un dorso è sfocato.');
    expect(result.warnings.join(' ')).toMatch(/Escluse 1 letture.*elementi 2/);
    expect(result.warnings.join(' ')).toContain('Gli altri libri sono conservati');
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request.generationConfig.responseJsonSchema.properties.observations.items.properties.authors.description).toContain('At most 8');
    expect(request.generationConfig.responseJsonSchema.properties.warnings.description).toContain('At most 12');
    expect(request.systemInstruction.parts[0].text).toContain('at most 8 authors');
  });

  it('retains books even when some model warnings are malformed or excessive', async () => {
    const validWarnings = Array.from({ length: 13 }, (_, index) => `Avviso ${index}`);
    const { service } = withResponse(Response.json(envelope({
      observations: [observed], warnings: [...validWarnings, 42, 'x'.repeat(351)],
    })));
    const result = await service.recognize(image, 'table');
    expect(result.observations).toEqual([observed]);
    expect(result.warnings.slice(0, 12)).toEqual(validWarnings.slice(0, 12));
    expect(result.warnings).toHaveLength(13);
    expect(result.warnings[12]).toContain('avvisi del servizio');
    expect(result.warnings).not.toContain('Avviso 12');
  });

  it('caps oversized completed results in reading order while clearly warning about omitted books', async () => {
    const observations = Array.from({ length: MAX_OBSERVATIONS + 2 }, (_, index) => ({ ...observed, position: `Libro ${index + 1}` }));
    const { service, fetchMock } = withResponse(Response.json(envelope({ observations, warnings: [] })));
    const result = await service.recognize(image, 'shelf');
    expect(result.observations).toEqual(observations.slice(0, MAX_OBSERVATIONS));
    expect(result.warnings.join(' ')).toContain('limite di 40 libri');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('ignores thought parts and accepts only a completed JSON result', async () => {
    const { service } = withResponse(Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { thought: true, text: 'Not output JSON.' },
      { text: JSON.stringify({ observations: [observed], warnings: [] }) },
    ] } }] }));
    const result = await service.recognize(image, 'shelf');
    expect(result.observations).toEqual([observed]);
  });

  it('warns when the per-photo limit is reached instead of claiming completeness', async () => {
    const observations = Array.from({ length: MAX_OBSERVATIONS }, (_, i) => ({ ...observed, position: `Libro ${i + 1}` }));
    const { service } = withResponse(Response.json(envelope({ observations, warnings: [] })));
    const result = await service.recognize(image, 'shelf');
    expect(result.observations).toHaveLength(MAX_OBSERVATIONS);
    expect(result.warnings.join(' ')).toContain('potrebbero esserci altri volumi');
  });

  it('provides useful guidance for a valid no-books result', async () => {
    const { service } = withResponse(Response.json(envelope({ observations: [], warnings: [] })));
    const result = await service.recognize(image, 'table');
    expect(result.observations).toEqual([]);
    expect(result.warnings.join(' ')).toContain('Nessun testo di libro leggibile');
  });

  it.each([
    ['reversed vertical bounds', { ...observed, boundingBox: [700, 80, 100, 160] }],
    ['reversed horizontal bounds', { ...observed, boundingBox: [100, 160, 700, 80] }],
    ['zero-area box', { ...observed, boundingBox: [100, 80, 100, 160] }],
    ['coordinates outside image', { ...observed, boundingBox: [100, -1, 700, 160] }],
    ['coordinates above maximum', { ...observed, boundingBox: [100, 80, 1001, 160] }],
    ['numeric confidence', { ...observed, confidence: 0.99 }],
    ['missing evidence', { ...observed, evidence: undefined }],
    ['oversized title', { ...observed, title: 'x'.repeat(301) }],
    ['oversized author', { ...observed, authors: ['x'.repeat(161)] }],
    ['non-ISBN text', { ...observed, visibleIsbn: 'probably this one' }],
    ['unexpected catalogue data', { ...observed, sourceUrl: 'https://example.com/fabricated' }],
  ])('rejects %s instead of silently accepting unreliable observations', async (_name, observation) => {
    const { service } = withResponse(Response.json(envelope({ observations: [observation], warnings: [] })));
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
  });

  it.each([
    ['missing candidate', {}],
    ['missing finish reason', { candidates: [{ content: { parts: [{ text: '{"observations":[],"warnings":[]}' }] } }] }],
    ['malformed JSON', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{"observations":[' }] } }] }],
    ['missing observations', envelope({ warnings: [] })],
    ['missing warnings', envelope({ observations: [] })],
    ['an excessive response array', envelope({ observations: Array.from({ length: 201 }, () => observed), warnings: [] })],
    ['empty response text', { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '' }] } }] }],
  ])('fails explicitly for %s, never returning a fake empty success', async (_name, response) => {
    const { service } = withResponse(Response.json(response));
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
  });

  it('rejects token-truncated output even if its JSON happens to be parseable', async () => {
    const { service } = withResponse(Response.json(envelope({ observations: [observed], warnings: [] }, 'MAX_TOKENS')));
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_TRUNCATED_RESPONSE' });
  });

  it.each([
    { promptFeedback: { blockReason: 'SAFETY' } },
    { candidates: [{ finishReason: 'SAFETY' }] },
  ])('reports blocked images clearly', async (response) => {
    const { service } = withResponse(Response.json(response));
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_BLOCKED', status: 422 });
  });
});

describe('vision failure boundaries', () => {
  it.each([
    [429, 'VISION_RATE_LIMIT', 429],
    [401, 'VISION_AUTH_ERROR', 503],
    [403, 'VISION_AUTH_ERROR', 503],
    [404, 'VISION_MODEL_UNAVAILABLE', 503],
    [400, 'VISION_REQUEST_REJECTED', 502],
    [504, 'VISION_TIMEOUT', 504],
    [503, 'VISION_UNAVAILABLE', 503],
  ])('maps HTTP %s to an actionable error without retrying or leaking provider data', async (status, code, publicStatus) => {
    const { service, fetchMock } = withResponse(new Response('private-test-key provider-details private-photo', {
      status: Number(status), headers: { 'Retry-After': '60' },
    }));
    const error: unknown = await service.recognize(image, 'shelf').catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VisionError);
    expect(error).toMatchObject({ code, status: publicStatus });
    expect((error as Error).message).not.toMatch(/private-test-key|provider-details|private-photo/);
    if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 60 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('redacts raw transport errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-key private-photo internal-stack'));
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock });
    const error: unknown = await service.recognize(image, 'shelf').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'VISION_UNAVAILABLE' });
    expect((error as Error).message).not.toMatch(/secret-key|private-photo|internal-stack/);
  });

  it('does not spend a request when already cancelled', async () => {
    const { service, fetchMock } = withResponse(Response.json({}));
    const controller = new AbortController();
    controller.abort();
    await expect(service.recognize(image, 'shelf', controller.signal)).rejects.toMatchObject({ code: 'VISION_ABORTED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('propagates cancellation to the upstream request', async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, request) => {
      upstreamSignal = request?.signal;
      return new Promise<Response>(() => undefined);
    });
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock });
    const controller = new AbortController();
    const result = service.recognize(image, 'shelf', controller.signal);
    const assertion = expect(result).rejects.toMatchObject({ code: 'VISION_ABORTED', status: 499, message: 'Scansione annullata.' });
    controller.abort('private user context');
    await assertion;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('bounds the whole request even if the transport stalls', async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, request) => {
      upstreamSignal = request?.signal;
      return new Promise<Response>(() => undefined);
    });
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', timeoutMs: 25, fetchImpl: fetchMock });
    const result = service.recognize(image, 'table');
    const assertion = expect(result).rejects.toMatchObject({ code: 'VISION_TIMEOUT', status: 504 });
    await vi.advanceTimersByTimeAsync(26);
    await assertion;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('also aborts and cancels a stalled response body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', timeoutMs: 25, fetchImpl: fetchMock });
    const result = service.recognize(image, 'shelf');
    const assertion = expect(result).rejects.toMatchObject({ code: 'VISION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(26);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('limits upstream response size without trusting content-length', async () => {
    const { service } = withResponse(new Response('x'.repeat(512 * 1024 + 1)));
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
  });

  it('rejects a malformed UTF-8 response', async () => {
    const { service } = withResponse(new Response(new Uint8Array([0xff, 0xff])));
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
  });
});

describe('vision input validation', () => {
  it.each([
    ['a disguised text file', { mimeType: 'image/jpeg', data: Buffer.from('this is not a photo').toString('base64') }],
    ['a MIME mismatch', { ...image, mimeType: 'image/jpeg' }],
    ['an unsupported format', { ...image, mimeType: 'image/svg+xml' }],
    ['malformed base64', { ...image, data: '****' }],
    ['a data URL instead of base64', { ...image, data: `data:image/png;base64,${image.data}` }],
  ])('rejects %s before contacting the paid service', async (_name, payload) => {
    const { service, fetchMock } = withResponse(Response.json({}));
    await expect(service.recognize(payload, 'shelf')).rejects.toMatchObject({ code: 'INVALID_IMAGE', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects oversized input before contacting the paid service', async () => {
    const { service, fetchMock } = withResponse(Response.json({}));
    const tooLarge = { ...image, data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) };
    await expect(service.recognize(tooLarge, 'shelf')).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE', status: 413 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: '', model: 'gemini-3.8-flash' },
    { apiKey: 'key', model: '../injected?key=secret' },
    { apiKey: 'key\r\nX-Injected: value', model: 'gemini-3.8-flash' },
  ])('fails safely for missing or invalid server configuration', async (options) => {
    const fetchMock = vi.fn<typeof fetch>();
    const service = createVisionService({ ...options, fetchImpl: fetchMock });
    await expect(service.recognize(image, 'shelf')).rejects.toMatchObject({ code: 'VISION_NOT_CONFIGURED', status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
