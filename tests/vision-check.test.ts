import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVisionCheckService, type VisionCheckOptions } from '../server/vision-check.js';
import { VisionError } from '../server/vision.js';

const success = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }] };

function withResponse(response: Response, options: Partial<VisionCheckOptions> = {}) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
  return {
    fetchMock,
    service: createVisionCheckService({
      apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock, ...options,
    }),
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('vision service check', () => {
  it('sends exactly one fixed text-only request using server-side credentials', async () => {
    const { service, fetchMock } = withResponse(Response.json(success), {
      apiKey: ' private-test-key ', model: ' models/gemini-3.8-flash ',
    });
    await expect(service.check()).resolves.toEqual({ ready: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
    expect(String(url)).not.toContain('private-test-key');
    expect(request).toMatchObject({ method: 'POST', redirect: 'manual', headers: {
      'Content-Type': 'application/json', 'x-goog-api-key': 'private-test-key',
    } });
    expect(JSON.parse(String(request?.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Reply with OK.' }] }],
      generationConfig: { maxOutputTokens: 256 },
    });
    expect(request?.body).not.toContain('private-test-key');
  });

  it('rejects redirects without forwarding credentials, retrying or reading their bodies', async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const cancel = vi.fn();
      const onDiagnostic = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { status, headers: { Location: 'https://untrusted.example/credential-sink' } });
      const { service, fetchMock } = withResponse(response, { onDiagnostic });
      await expect(service.check()).rejects.toMatchObject({ code: 'VISION_UNAVAILABLE', status: 503 });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(fetchMock.mock.calls[0][1]?.redirect).toBe('manual');
      expect(String(fetchMock.mock.calls[0][0])).not.toContain('untrusted.example');
      expect(cancel).toHaveBeenCalledOnce();
      expect(onDiagnostic).not.toHaveBeenCalled();
    }
  });

  it.each([
    { candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model' } }] },
    { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'A different answer.' }] } }] },
  ])('reports request acceptance without claiming a complete or exact answer', async (body) => {
    const { service } = withResponse(Response.json(body));
    await expect(service.check()).resolves.toEqual({ ready: true });
  });

  it.each([
    {},
    { candidates: [{ finishReason: 'STOP', content: { parts: 'not an array' } }] },
    { ...success, error: { message: 'An error in a 2xx body is not a successful check.' } },
  ])('rejects an invalid successful response envelope', async (body) => {
    const { service } = withResponse(Response.json(body));
    await expect(service.check()).rejects.toMatchObject({
      code: 'VISION_INVALID_RESPONSE', status: 502,
      message: 'Il servizio ha restituito una risposta di verifica non valida. Riprova tra poco.',
    });
  });

  it('maps the observed HTTP 400 without retrying or exposing upstream details', async () => {
    const { service, fetchMock } = withResponse(new Response('private-test-key provider-details', {
      status: 400,
    }));
    const error: unknown = await service.check().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(VisionError);
    expect(error).toMatchObject({ code: 'VISION_REQUEST_REJECTED', status: 502 });
    expect((error as Error).message).not.toMatch(/private-test-key|provider-details/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps only redacted diagnostics and preserves the HTTP failure if logging throws', async () => {
    const onDiagnostic = vi.fn().mockImplementation(() => { throw new Error('logging failed'); });
    const { service, fetchMock } = withResponse(Response.json({ error: {
      code: 400, status: 'INVALID_ARGUMENT',
      message: 'API key not valid: private-test-key. Consumer: projects/private-project.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', metadata: { secret: 'private metadata' } }],
    } }, { status: 400 }), { onDiagnostic });
    await expect(service.check()).rejects.toMatchObject({ code: 'VISION_REQUEST_REJECTED' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic.mock.calls[0][0]).toMatchObject({
      httpStatus: 400, providerStatus: 'INVALID_ARGUMENT', reasons: ['API_KEY_INVALID'], categories: ['INVALID_API_KEY'],
    });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private-test-key|private-project|private metadata/);
  });

  it('preserves HTTP failure when its diagnostic body is invalid', async () => {
    const onDiagnostic = vi.fn();
    const { service } = withResponse(new Response('not JSON', { status: 400 }), { onDiagnostic });
    await expect(service.check()).rejects.toMatchObject({ code: 'VISION_REQUEST_REJECTED' });
    expect(onDiagnostic).toHaveBeenCalledWith({ httpStatus: 400, reasons: [], categories: [], fields: [], messages: [] });
  });

  it.each([
    { apiKey: '', model: 'gemini-3.8-flash' },
    { apiKey: 'key\r\nX-Injected: value', model: 'gemini-3.8-flash' },
    { apiKey: 'key', model: '../injected?key=secret' },
  ])('validates server configuration before spending a request', async (options) => {
    const { service, fetchMock } = withResponse(Response.json(success), options);
    await expect(service.check()).rejects.toMatchObject({ code: 'VISION_NOT_CONFIGURED', status: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not spend a request when already aborted', async () => {
    const { service, fetchMock } = withResponse(Response.json(success));
    const controller = new AbortController();
    controller.abort('private reason');
    await expect(service.check(controller.signal)).rejects.toMatchObject({
      code: 'VISION_ABORTED', status: 499, message: 'Verifica annullata.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels a stalled transport and redacts the caller abort reason', async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, request) => {
      upstreamSignal = request?.signal;
      return new Promise<Response>(() => undefined);
    });
    const service = createVisionCheckService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock });
    const controller = new AbortController();
    const assertion = expect(service.check(controller.signal)).rejects.toMatchObject({
      code: 'VISION_ABORTED', status: 499, message: 'Verifica annullata.',
    });
    controller.abort('private reason');
    await assertion;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('caps the request deadline at 30 seconds even if configured longer', async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_url, request) => {
      upstreamSignal = request?.signal;
      return new Promise<Response>(() => undefined);
    });
    const service = createVisionCheckService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock, timeoutMs: 90_000 });
    const assertion = expect(service.check()).rejects.toMatchObject({ code: 'VISION_TIMEOUT', status: 504 });
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(upstreamSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds and cancels a stalled response body', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { service } = withResponse(new Response(new ReadableStream({ cancel })), { timeoutMs: 25 });
    const assertion = expect(service.check()).rejects.toMatchObject({ code: 'VISION_TIMEOUT', status: 504 });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    new Response('x'.repeat(32 * 1024 + 1)),
    new Response(new Uint8Array([0xff, 0xff])),
    new Response('not JSON'),
    new Response(null, { status: 204 }),
  ])('bounds and validates response bodies', async (response) => {
    const { service } = withResponse(response);
    await expect(service.check()).rejects.toMatchObject({ code: 'VISION_INVALID_RESPONSE' });
  });

  it('redacts transport errors without retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('private-test-key internal stack'));
    const service = createVisionCheckService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl: fetchMock });
    const error: unknown = await service.check().catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'VISION_UNAVAILABLE', status: 503 });
    expect((error as Error).message).not.toMatch(/private-test-key|internal stack/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
