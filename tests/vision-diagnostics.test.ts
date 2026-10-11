import { describe, expect, it, vi } from 'vitest';
import { summarizeVisionRejection } from '../server/vision-diagnostics.js';
import { createVisionService } from '../server/vision.js';

const image = {
  mimeType: 'image/png',
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtQAAAABJRU5ErkJggg==',
};

describe('server-only Gemini diagnostics', () => {
  it('recognizes an invalid-key reason while redacting credentials and discarding account metadata', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key. private-secret',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID',
        metadata: { apiKey: 'private-secret', consumer: 'private-project' } }],
    } });
    expect(diagnostic).toMatchObject({ httpStatus: 400, providerStatus: 'INVALID_ARGUMENT',
      reasons: ['API_KEY_INVALID'], categories: ['INVALID_API_KEY'] });
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-secret|private-project|apiKey/);
  });

  it('records known rejected field names while excluding echoed image and prompt content', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT',
      message: `Invalid JSON payload received. Unknown name "responseFormat" at 'generation_config': Cannot find field. Private prompt: confidential-book. Image: ${image.data}`,
      details: [{ reason: 'SENSITIVE_UNKNOWN_REASON' }],
    } });
    expect(diagnostic.categories).toEqual(['INVALID_JSON_PAYLOAD', 'UNKNOWN_FIELD']);
    expect(diagnostic.fields).toEqual(['responseFormat', 'generation_config']);
    expect(JSON.stringify(diagnostic)).not.toMatch(/confidential-book|SENSITIVE_UNKNOWN_REASON|iVBOR/);
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
    expect(onDiagnostic).toHaveBeenCalledWith({ httpStatus: 400, reasons: [], categories: [], fields: [], messages: [] });
  });

  it('extracts nested field violations while redacting quoted values and long payload fragments', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument.',
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{
        field: 'generation_config.response_format',
        description: `Unknown name "responseFormat". Value: "private-title". Image: ${'A'.repeat(100)}. URL https://example.com/private-account`,
      }] }],
    } });
    expect(diagnostic.fields).toEqual(expect.arrayContaining(['generation_config', 'response_format', 'responseFormat']));
    expect(diagnostic.categories).toContain('UNKNOWN_FIELD');
    expect(diagnostic.messages).toEqual(['Il provider segnala un campo della richiesta non riconosciuto.']);
    expect(JSON.stringify(diagnostic)).not.toMatch(/private-title|private-account|A{32}/);
  });

  it('retains the rejected field without copying free-form provider text into diagnostics', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT',
      message: 'Invalid value at "mimeType": "APPLICATION_JSON". Expected "application/json"; "TEXT_PLAIN" maps to "text/plain". Types: "string", "number", "integer", "boolean", "array", "object", "null". Value: "private-title".',
    } });
    expect(diagnostic.fields).toContain('mimeType');
    expect(diagnostic.messages).toEqual(['Il provider ha rifiutato un argomento della richiesta senza un motivo classificabile.']);
    expect(JSON.stringify(diagnostic)).not.toContain('private-title');
  });

  it('redacts project and consumer resource paths even when they are not quoted', () => {
    const diagnostic = summarizeVisionRejection(400, { error: {
      status: 'INVALID_ARGUMENT',
      message: 'Consumer: projects/demo-project-123; project: projects/123456789012; resource: consumers/private-consumer/services/generative-language; field: "mimeType".',
    } });
    expect(diagnostic.fields).toContain('mimeType');
    expect(JSON.stringify(diagnostic)).not.toMatch(/demo-project-123|123456789012|private-consumer|generative-language/);
  });

  it('never retains unquoted emails, account identifiers, network addresses, or partial private text', () => {
    const privateText = 'A fragment of a confidential document';
    const diagnostic = summarizeVisionRejection(403, { error: {
      status: 'PERMISSION_DENIED',
      message: `Generative Language API is not enabled for project 123456789012. Contact owner@example.invalid at IP 203.0.113.42. Account demo-customer-123: ${privateText}`,
      details: [{ reason: 'SERVICE_DISABLED', metadata: { project: 'private-project' } }, {
        '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', message: 'Account 999999999999, amministratore nome@esempio.invalid.',
      }],
    } });
    expect(diagnostic).toMatchObject({ providerStatus: 'PERMISSION_DENIED', reasons: ['SERVICE_DISABLED'] });
    expect(JSON.stringify(diagnostic)).not.toMatch(/123456789012|999999999999|@|203\.0\.113\.42|demo-customer|confidential|private-project/);
  });

  it('does not let a logging failure replace the actionable public error', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { status: 'PERMISSION_DENIED' } }, { status: 403 }));
    const service = createVisionService({ apiKey: 'private-test-key', model: 'gemini-3.8-flash', fetchImpl,
      onDiagnostic: () => { throw new Error('private-logger-detail'); } });
    await expect(service.recognize(image, 'table')).rejects.toMatchObject({ code: 'VISION_AUTH_ERROR' });
  });
});
