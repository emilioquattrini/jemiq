import { z } from 'zod';

const text = z.string().max(2000);
const nullableText = text.nullable();
export const observationSchema = z.object({
  title: nullableText, authors: z.array(text).max(30), visibleIsbn: nullableText,
  publisher: nullableText, language: nullableText, evidence: text, position: text,
  confidence: z.enum(['high', 'medium', 'low']),
  boundingBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
});
export const candidateSchema = z.object({
  id: text, title: text, authors: z.array(text).max(30), isbn13: nullableText,
  publisher: nullableText, publishedDate: nullableText, language: nullableText,
  pageCount: z.number().finite().int().nonnegative().nullable(), thumbnail: nullableText,
  description: z.string().max(4000).nullable().optional(), categories: z.array(z.string().max(100)).max(8).optional(),
  source: z.enum(['Google Books', 'Open Library']), sourceUrl: text,
  score: z.number().finite(), matchReason: text,
});
export const bookSchema = z.object({
  id: text, observation: observationSchema, title: text, authors: z.array(text).max(30),
  isbn13: nullableText, publisher: nullableText, publishedDate: nullableText,
  language: nullableText, pageCount: z.number().finite().int().nonnegative().nullable(),
  description: z.string().max(4000).nullable().optional(), categories: z.array(z.string().max(100)).max(8).optional(),
  thumbnail: nullableText, source: z.enum(['Google Books', 'Open Library']).nullable(), sourceUrl: nullableText,
  status: z.enum(['verified', 'confirmed', 'review', 'unresolved']),
  candidates: z.array(candidateSchema).max(30), notes: text,
  quantity: z.number().int().min(1).max(9999), selected: z.boolean(),
});
export const sessionSchema = z.object({
  id: text, name: text, createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  mode: z.enum(['shelf', 'table']), image: z.string().max(12_000_000).nullable(),
  books: z.array(bookSchema).max(5000), warnings: z.array(text).max(100), isDemo: z.boolean(),
});
export const scanEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stage'), stage: z.enum(['recognizing', 'enriching']), message: text }),
  z.object({ type: z.literal('observations'), total: z.number().int().nonnegative(), warnings: z.array(text) }),
  z.object({ type: z.literal('book'), book: bookSchema, completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  z.object({ type: z.literal('done'), warnings: z.array(text), elapsedMs: z.number().finite().nonnegative() }),
  z.object({ type: z.literal('error'), error: text, code: text }),
]);
