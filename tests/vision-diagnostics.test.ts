import { describe, expect, it, vi } from 'vitest';
import { summarizeVisionRejection } from '../server/vision-diagnostics.js';
import { createVisionService } from '../server/vision.js';

const image = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==',
};

describe('server-only Gemini diagnostics', () => {
  it('recognizes an invalid-key reason without retaining provider prose or metadata', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key. private-secret',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID',
        metadata: { apiKey: 'private-secret', consumer: 'private-project' } }],
    } });
    expect(diagnostic).toMatchObject({ httpStatus: 400, providerStatus: 'INVALID_ARGUMENT',
      reasons: ['API_KEY_INVALID'], categories: ['INVALID_API_KEY'] });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-secret|private-project|Please pass|apiKey/);
  });

  it('records known rejected field names while excluding echoed image and prompt content', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT',
      message: `Invalid JSON payload received. Unknown name "responseFormat" at 'generation_config': Cannot find field. Private prompt: confidential-book. Image: ${image.data}`,
      details: [{ reason: 'SENSITIVE_UNKNOWN_REASON' }],
    } });
    expect(diagnostic.categories).toEqual(['INVALID_JSON_PAYLOAD', 'UNKNOWN_FIELD']);
    expect(diagnostic.fields).toEqual(['responseFormat', 'generation_config']);
    expect(JSON.stringify(diagnostic)).not.toMatch(/confidential-book|Private prompt|SENSITIVE_UNKNOWN_REASON|iVBOR/);
  });

  it('logs a rejection once while keeping upstream details out of the public error', async () => {
    const onDiagnostic = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: {
      status: 'FAILED_PRECONDITION', message: 'Billing must be enabled. private-account',
      details: [{ reason: 'BILLING_DISABLED' }],
    } }, { status: 400 }));
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl, onDiagnostic });
    const error = await service.recognize(image, 'table').catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'VISION_REQUEST_REJECTED' });
    expect((error as Error).message).not.toContain('private-account');
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(onDiagnostic.mock.calls[0][0]).toMatchObject({ providerStatus: 'FAILED_PRECONDITION', reasons: ['BILLING_DISABLED'] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('keeps the original HTTP classification when the error body exceeds the diagnostic limit', async () => {
    const onDiagnostic = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-data'.repeat(3000), { status: 400 }));
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl, onDiagnostic });
    await expect(service.recognize(image, 'table')).rejects.toMatchObject({ code: 'VISION_REQUEST_REJECTED' });
    expect(onDiagnostic).toHaveBeenCalledWith({ httpStatus: 400, reasons: [], categories: [], fields: [] });
  });

  it('does not let a logging failure replace the actionable public error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }));
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl,
      onDiagnostic: () => { throw new Error('private-logger-detail'); } });
    await expect(service.recognize(image, 'table')).rejects.toMatchObject({ code: 'VISION_AUTH_ERROR' });
  });
});
