import { z } from 'zod';
import { readBoundedJson, upstreamError, VisionError, type VisionOptions } from './vision.js';
import { summarizeVisionRejection } from './vision-diagnostics.js';

const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 32 * 1024;
const CHECK_PROMPT = 'Reply with OK.';

export type VisionCheckOptions = VisionOptions;

const checkEnvelope = z.object({
  candidates: z.array(z.object({
    finishReason: z.string().min(1).max(64),
    content: z.object({
      parts: z.array(z.object({
        text: z.string().optional(),
        thought: z.boolean().optional(),
      }).passthrough()).max(32).optional(),
    }).passthrough().optional(),
  }).passthrough()).length(1),
  error: z.never().optional(),
}).passthrough();

const invalidResponse = () => new VisionError('VISION_INVALID_RESPONSE',
  'Il servizio ha restituito una risposta di verifica non valida. Riprova tra poco.');

/** A user-triggered, text-only request checks acceptance, not recognition or output quality. */
export function createVisionCheckService(options: VisionCheckOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey.trim();
  const model = options.model.trim().replace(/^models\//, '');
  const timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.min(options.timeoutMs, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;

  return {
    async check(signal?: AbortSignal): Promise<{ ready: true }> {
      const abortError = () => new VisionError('VISION_ABORTED', 'Verifica annullata.', 499);
      if (signal?.aborted) throw abortError();
      if (!apiKey || /[\r\n]/.test(apiKey) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
        throw new VisionError('VISION_NOT_CONFIGURED',
          'Configura GEMINI_API_KEY e GEMINI_MODEL sul server per verificare il servizio.', 503);
      }

      const controller = new AbortController();
      const forwardAbort = () => controller.abort(abortError());
      signal?.addEventListener('abort', forwardAbort, { once: true });
      let rejectAbort: () => void = () => undefined;
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      const timer = setTimeout(() => controller.abort(new VisionError('VISION_TIMEOUT',
        'La verifica del servizio sta impiegando troppo tempo. Riprova tra poco.', 504)), timeoutMs);

      try {
        const execute = async (): Promise<{ ready: true }> => {
          // Exactly one fixed request; no image, schema, system prompt or automatic retry.
          const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: CHECK_PROMPT }] }],
              generationConfig: { maxOutputTokens: 256 },
            }),
            signal: controller.signal,
            // Keep credentials at the fixed provider endpoint on Node and Workers.
            redirect: 'manual',
          });
          if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => undefined);
            throw upstreamError(response);
          }
          if (!response.ok) {
            if (options.onDiagnostic) {
              let rejection: unknown;
              try {
                rejection = await readBoundedJson(response,
                  AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]), 16 * 1024);
              } catch { /* Keep the HTTP error if the diagnostic body is unusable. */ }
              try { options.onDiagnostic(summarizeVisionRejection(response.status, rejection)); }
              catch { /* Logging must not alter the request result. */ }
            } else {
              void response.body?.cancel().catch(() => undefined);
            }
            throw upstreamError(response);
          }

          const envelope = checkEnvelope.safeParse(await readBoundedJson(response, controller.signal, MAX_RESPONSE_BYTES));
          if (!envelope.success) throw invalidResponse();
          // MAX_TOKENS can exhaust the small budget during thinking. A valid 2xx
          // response still proves request acceptance, without proving an "OK" answer.
          return { ready: true };
        };
        return await Promise.race([execute(), aborted]);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (error instanceof VisionError) {
          if (error.code === 'VISION_INVALID_RESPONSE') throw invalidResponse();
          throw error;
        }
        throw new VisionError('VISION_UNAVAILABLE',
          'Non riesco a contattare Gemini per verificare il servizio. Riprova tra poco.', 503);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', forwardAbort);
        controller.signal.removeEventListener('abort', rejectAbort);
      }
    },
  };
}
