import { z } from 'zod';

export const studioStyleSchema = z.enum(['atmospheric', 'minimal', 'cinematic']);
export type StudioStyle = z.infer<typeof studioStyleSchema>;
export const STUDIO_STYLES: Record<StudioStyle, { label: string; description: string }> = {
  atmospheric: { label: 'Atmosferico', description: 'Materiali, luce naturale e pochi oggetti evocativi.' },
  minimal: { label: 'Essenziale', description: 'Spazio, colori coordinati e una composizione pulita.' },
  cinematic: { label: 'Cinematografico', description: 'Ombre, profondità e luce espressiva.' },
};
export type StudioFormat = 'post' | 'story';
export const studioBookSchema = z.object({
  title: z.string().trim().min(1).max(400),
  authors: z.array(z.string().trim().min(1).max(200)).max(12),
  isbn13: z.string().max(20).nullable(),
  publisher: z.string().max(240).nullable(),
  language: z.string().max(30).nullable(),
  source: z.enum(['Google Books', 'Open Library']).nullable(),
  sourceUrl: z.string().max(1200).nullable(),
}).strict();
export type StudioBook = z.infer<typeof studioBookSchema>;
export const studioBriefInputSchema = z.object({
  book: studioBookSchema,
  style: studioStyleSchema,
  readerNote: z.string().trim().max(1200).default(''),
  mood: z.string().trim().max(120).default(''),
}).strict();
export type StudioBriefInput = z.infer<typeof studioBriefInputSchema>;
export const studioBriefSchema = z.object({
  book: studioBookSchema,
  style: studioStyleSchema,
  summary: z.string().trim().min(1).max(900),
  mood: z.string().trim().min(1).max(160),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(2).max(5),
  elements: z.array(z.object({
    id: z.string().min(1).max(80),
    label: z.string().trim().min(1).max(140),
    basis: z.enum(['catalog', 'reader', 'style']),
  }).strict()).max(3),
  sources: z.array(z.object({ provider: z.enum(['Google Books', 'Open Library']), url: z.string().url().max(1200) }).strict()).max(3),
  warnings: z.array(z.string().max(600)).max(6),
  basis: z.enum(['catalog', 'reader', 'style']),
}).strict();
export type StudioBrief = z.infer<typeof studioBriefSchema>;
export const studioImageSchema = z.object({
  data: z.string().min(1).max(22_400_000),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  width: z.number().int().min(256).max(8192),
  height: z.number().int().min(256).max(8192),
}).strict();
export type StudioImage = z.infer<typeof studioImageSchema>;
export const studioJobSchema = z.object({
  id: z.string().uuid(),
  requestId: z.string().uuid(),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  image: studioImageSchema.nullable(),
  error: z.object({ code: z.string().max(80), message: z.string().max(700) }).nullable(),
}).strict();
export type StudioJob = z.infer<typeof studioJobSchema>;
export const studioGenerationSchema = z.object({ requestId: z.string().uuid(), brief: studioBriefSchema }).strict();

export interface StudioPoint { x: number; y: number }
/** Normalized coordinates: top-left, top-right, bottom-right, bottom-left. */
export type StudioQuad = [StudioPoint, StudioPoint, StudioPoint, StudioPoint];
export interface StudioPhoto { dataUrl: string; width: number; height: number }
export const DEFAULT_STUDIO_CORNERS: StudioQuad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
export interface StudioComposition {
  cover: StudioPhoto;
  background: StudioImage;
  format: StudioFormat;
  /** Relative size of the book; 1 is the proposed layout. */
  scale: number;
  rotation: number;
  /** Offsets relative to the canvas; bounded so the full cover stays visible. */
  offsetX: number;
  offsetY: number;
  caption: string;
}
export interface StudioProject {
  id: string;
  createdAt: string;
  updatedAt: string;
  photo: StudioPhoto | null;
  corners: StudioQuad;
  cover: StudioPhoto | null;
  book: StudioBook;
  style: StudioStyle;
  readerNote: string;
  mood: string;
  brief: StudioBrief | null;
  image: StudioImage | null;
  format: StudioFormat;
  scale: number;
  rotation: number;
  offsetX: number;
  offsetY: number;
  caption: string;
  jobId: string | null;
  requestId: string | null;
}
export const EMPTY_STUDIO_BOOK: StudioBook = { title: '', authors: [], isbn13: null, publisher: null, language: null, source: null, sourceUrl: null };
