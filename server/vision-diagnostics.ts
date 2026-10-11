/** Server-only diagnostics. Provider prose and account metadata are never retained. */
export interface VisionDiagnostic {
  httpStatus: number;
  providerStatus?: string;
  reasons: string[];
  categories: string[];
  fields: string[];
  messages: string[];
}

const statuses = new Set(['INVALID_ARGUMENT', 'UNAUTHENTICATED', 'PERMISSION_DENIED',
  'NOT_FOUND', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'OUT_OF_RANGE',
  'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED']);
const reasons = new Set(['API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_NOT_FOUND',
  'API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED',
  'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED', 'API_KEY_CREATION_BLOCKED',
  'SERVICE_DISABLED', 'BILLING_DISABLED', 'CONSUMER_INVALID', 'PROJECT_DELETED',
  'PROJECT_INVALID', 'RATE_LIMIT_EXCEEDED', 'RESOURCE_QUOTA_EXCEEDED',
  'ACCESS_TOKEN_EXPIRED', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
const fields = new Set(['generationConfig', 'generation_config', 'responseFormat', 'response_format',
  'responseMimeType', 'response_mime_type', 'responseSchema', 'response_schema',
  'responseJsonSchema', 'response_json_schema', 'mimeType', 'mime_type', 'schema',
  'candidateCount', 'candidate_count', 'maxOutputTokens', 'max_output_tokens',
  'systemInstruction', 'system_instruction', 'contents', 'parts', 'inlineData', 'inline_data',
  'additionalProperties', 'additional_properties', 'anyOf', 'any_of', 'type', 'nullable',
  'minItems', 'min_items', 'maxItems', 'max_items', 'required', 'properties', 'items',
  'observations', 'warnings', 'title', 'authors', 'visibleIsbn', 'publisher', 'language',
  'evidence', 'position', 'confidence', 'boundingBox']);
const categoryMessages: Record<string, string> = {
  INVALID_JSON_PAYLOAD: 'Il provider segnala una struttura JSON della richiesta non valida.',
  UNKNOWN_FIELD: 'Il provider segnala un campo della richiesta non riconosciuto.',
  UNSUPPORTED_ARGUMENT: 'Il provider segnala un parametro non supportato.',
  INVALID_ENUM: 'Il provider segnala un valore enumerato non valido.',
  INVALID_API_KEY: 'Il provider segnala una chiave API non valida o scaduta.',
  REGION_RESTRICTED: 'Il provider segnala una limitazione geografica del servizio.',
  BILLING_REQUIRED: 'Il provider segnala un requisito di fatturazione.',
  SCHEMA_REJECTED: 'Il provider segnala uno schema non valido o troppo complesso.',
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

export function summarizeVisionRejection(httpStatus: number, body: unknown): VisionDiagnostic {
  const diagnostic: VisionDiagnostic = { httpStatus, reasons: [], categories: [], fields: [], messages: [] };
  const error = record(record(body)?.error);
  if (!error) return diagnostic;
  if (typeof error.status === 'string' && statuses.has(error.status)) diagnostic.providerStatus = error.status;
  const details = Array.isArray(error.details) ? error.details.slice(0, 20) : [];
  const messages = typeof error.message === 'string' ? [error.message] : [];
  const fieldPaths: string[] = [];
  for (const detail of details) {
    const item = record(detail);
    const reason = item?.reason;
    if (typeof reason === 'string' && reasons.has(reason)) diagnostic.reasons.push(reason);
    if (item?.['@type'] === 'type.googleapis.com/google.rpc.LocalizedMessage' && typeof item.message === 'string') messages.push(item.message);
    for (const violation of Array.isArray(item?.fieldViolations) ? item.fieldViolations.slice(0, 12) : []) {
      const entry = record(violation);
      if (typeof entry?.field === 'string') fieldPaths.push(entry.field);
      if (typeof entry?.description === 'string') messages.push(entry.description);
    }
    for (const violation of Array.isArray(item?.violations) ? item.violations.slice(0, 12) : []) {
      const description = record(violation)?.description;
      if (typeof description === 'string') messages.push(description);
    }
  }
  // Classify untrusted provider prose, then discard it. Redacting known patterns
  // alone cannot reliably remove emails, account IDs, or partial prompt echoes.
  const message = [...messages, ...fieldPaths].join(' ').slice(0, 12_000);
  const categories: Array<[string, RegExp]> = [
    ['INVALID_JSON_PAYLOAD', /invalid json payload/i],
    ['UNKNOWN_FIELD', /unknown name|cannot find field|unrecognized (?:field|parameter)/i],
    ['UNSUPPORTED_ARGUMENT', /not supported|unsupported/i],
    ['INVALID_ENUM', /invalid enum|invalid value at[^\n]*type\.google/i],
    ['INVALID_API_KEY', /api key (?:not valid|is not valid|is invalid|invalid|expired)/i],
    ['REGION_RESTRICTED', /(?:user )?location is not supported|not available in (?:your|this) (?:country|region)/i],
    ['BILLING_REQUIRED', /billing.{0,80}(?:enable|required)|(?:enable|required).{0,80}billing|only available.{0,80}(?:paid|billed)/i],
    ['SCHEMA_REJECTED', /schema.{0,80}(?:invalid|complex|unsupported)|(?:invalid|unsupported).{0,80}schema/i],
  ];
  for (const [category, pattern] of categories) if (pattern.test(message)) diagnostic.categories.push(category);
  for (const token of message.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []) {
    if (fields.has(token)) diagnostic.fields.push(token);
  }
  diagnostic.reasons = [...new Set(diagnostic.reasons)];
  diagnostic.fields = [...new Set(diagnostic.fields)].slice(0, 24);
  diagnostic.messages = diagnostic.categories.slice(0, 4).map((category) => categoryMessages[category]);
  if (!diagnostic.messages.length && diagnostic.providerStatus === 'INVALID_ARGUMENT') {
    diagnostic.messages.push('Il provider ha rifiutato un argomento della richiesta senza un motivo classificabile.');
  }
  return diagnostic;
}
