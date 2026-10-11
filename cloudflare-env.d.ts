declare module 'cloudflare:workers' {
  export const env: {
    DB?: import('@cloudflare/workers-types').D1Database;
    BUCKET?: import('@cloudflare/workers-types').R2Bucket;
    GEMINI_API_KEY?: string;
    GEMINI_MODEL?: string;
    GOOGLE_BOOKS_API_KEY?: string;
    JEMIQ_ACCESS_TOKEN?: string;
    JEMIQ_SERVICE_ACCESS_ENABLED?: string;
    SETTINGS_ENCRYPTION_KEY?: string;
    APP_ORIGIN?: string;
  };
}
