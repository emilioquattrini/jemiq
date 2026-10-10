import type { PreparedImage } from '../../shared/types';
import type { StudioPhoto, StudioQuad, StudioComposition } from '../../shared/studio';
import { perspectiveTransform, studioCropSize, studioPlacement } from './studio-geometry';

const MAX_FILE = 32 * 1024 * 1024;
const MAX_DATA_URL = 22_400_000;
const renderVersions = new WeakMap<HTMLCanvasElement, number>();
function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = width; element.height = height;
  const context = element.getContext('2d');
  if (!context) throw new Error('Il browser non può preparare l’immagine. Prova ad aggiornare la pagina.');
  return [element, context];
}
async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl) || dataUrl.length > MAX_DATA_URL) throw new Error('L’immagine non è leggibile. Scegli un’altra foto.');
  const image = new Image(); image.src = dataUrl;
  try { await image.decode(); } catch { throw new Error('L’immagine non è leggibile. Scegli un’altra foto.'); }
  if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 80_000_000) throw new Error('L’immagine ha una risoluzione non supportata.');
  return image;
}
function asPhoto(element: HTMLCanvasElement, mimeType: 'image/jpeg' | 'image/png'): StudioPhoto {
  const dataUrl = element.toDataURL(mimeType, 0.94);
  if (!dataUrl.startsWith(`data:${mimeType};base64,`) || dataUrl.length > MAX_DATA_URL) throw new Error('L’immagine è troppo grande. Scegli una foto più piccola.');
  return { dataUrl, width: element.width, height: element.height };
}

/** Keep alpha when available; the recognition JPEG is a separate derivative. */
export async function prepareStudioPhoto(file: File): Promise<StudioPhoto> {
  if (!file.size || file.size > MAX_FILE) throw new Error(file.size ? 'La foto supera 32 MB. Scegli una versione più piccola.' : 'Il file selezionato è vuoto.');
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.type)) throw new Error('Scegli una foto JPEG, PNG o WebP. HEIC richiede un browser compatibile.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    try { await image.decode(); } catch { throw new Error('Questo formato non è leggibile nel browser. Usa JPEG o PNG.'); }
    if (image.naturalWidth < 240 || image.naturalHeight < 240) throw new Error('La foto è troppo piccola. Usa una foto originale con la copertina intera.');
    if (image.naturalWidth * image.naturalHeight > 80_000_000) throw new Error('La risoluzione è troppo alta. Scegli una foto più piccola.');
    const ratio = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
    const [element, context] = canvas(Math.round(image.naturalWidth * ratio), Math.round(image.naturalHeight * ratio));
    context.drawImage(image, 0, 0, element.width, element.height);
    return asPhoto(element, /png|webp/i.test(file.type) ? 'image/png' : 'image/jpeg');
  } finally { URL.revokeObjectURL(url); }
}

export async function rotateStudioPhoto(photo: StudioPhoto): Promise<StudioPhoto> {
  const image = await loadImage(photo.dataUrl);
  const [element, context] = canvas(image.naturalHeight, image.naturalWidth);
  context.translate(element.width, 0); context.rotate(Math.PI / 2); context.drawImage(image, 0, 0);
  return asPhoto(element, photo.dataUrl.startsWith('data:image/png;') ? 'image/png' : 'image/jpeg');
}

export async function studioPhotoToPreparedImage(photo: StudioPhoto): Promise<PreparedImage> {
  const image = await loadImage(photo.dataUrl);
  const [element, context] = canvas(image.naturalWidth, image.naturalHeight);
  context.fillStyle = '#FFFFFF'; context.fillRect(0, 0, element.width, element.height); context.drawImage(image, 0, 0);
  const prepared = asPhoto(element, 'image/jpeg');
  return { ...prepared, data: prepared.dataUrl.split(',')[1], mimeType: 'image/jpeg' };
}

/** Rectify perspective using the photograph; no reconstruction or generated cover pixels. */
export async function cropStudioCover(photo: StudioPhoto, corners: StudioQuad, signal?: AbortSignal): Promise<StudioPhoto> {
  signal?.throwIfAborted();
  const image = await loadImage(photo.dataUrl);
  const transform = perspectiveTransform(corners);
  const size = studioCropSize(corners, image.naturalWidth, image.naturalHeight);
  const [source, sourceContext] = canvas(image.naturalWidth, image.naturalHeight);
  sourceContext.drawImage(image, 0, 0);
  const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
  const [result, resultContext] = canvas(size.width, size.height);
  const output = resultContext.createImageData(size.width, size.height);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max, v));
  for (let y = 0; y < size.height; y++) {
    if (y % 64 === 0) { signal?.throwIfAborted(); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
    for (let x = 0; x < size.width; x++) {
      const point = transform(x / (size.width - 1), y / (size.height - 1));
      const sx = clamp(point.x * (source.width - 1), source.width - 1), sy = clamp(point.y * (source.height - 1), source.height - 1);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, source.width - 1), y1 = Math.min(y0 + 1, source.height - 1);
      const fx = sx - x0, fy = sy - y0;
      const i0 = (y0 * source.width + x0) * 4, i1 = (y0 * source.width + x1) * 4;
      const i2 = (y1 * source.width + x0) * 4, i3 = (y1 * source.width + x1) * 4;
      const a0 = sourcePixels[i0 + 3] * (1 - fx) * (1 - fy), a1 = sourcePixels[i1 + 3] * fx * (1 - fy);
      const a2 = sourcePixels[i2 + 3] * (1 - fx) * fy, a3 = sourcePixels[i3 + 3] * fx * fy;
      const alpha = a0 + a1 + a2 + a3;
      const offset = (y * size.width + x) * 4;
      output.data[offset + 3] = alpha;
      if (alpha > 0) for (let channel = 0; channel < 3; channel++) output.data[offset + channel] = (sourcePixels[i0 + channel] * a0 + sourcePixels[i1 + channel] * a1 + sourcePixels[i2 + channel] * a2 + sourcePixels[i3 + channel] * a3) / alpha;
    }
  }
  signal?.throwIfAborted(); resultContext.putImageData(output, 0, 0);
  return asPhoto(result, 'image/png');
}

export async function renderStudioComposition(target: HTMLCanvasElement, options: StudioComposition, width = 1080): Promise<void> {
  const version = (renderVersions.get(target) ?? 0) + 1;
  renderVersions.set(target, version);
  if (!Number.isFinite(width)) throw new Error('La dimensione dell’immagine non è valida.');
  const [cover, background] = await Promise.all([loadImage(options.cover.dataUrl), loadImage(`data:${options.background.mimeType};base64,${options.background.data}`)]);
  const exportWidth = Math.max(270, Math.min(2160, Math.round(width)));
  const exportHeight = Math.round(exportWidth * (options.format === 'story' ? 16 / 9 : 5 / 4));
  // Draw in an offscreen canvas so incomplete async renders cannot clear a newer preview.
  const [element, context] = canvas(exportWidth, exportHeight);
  const fit = Math.max(exportWidth / background.naturalWidth, exportHeight / background.naturalHeight);
  const bw = background.naturalWidth * fit, bh = background.naturalHeight * fit;
  context.fillStyle = '#F7F8F6'; context.fillRect(0, 0, exportWidth, exportHeight);
  context.drawImage(background, (exportWidth - bw) / 2, (exportHeight - bh) / 2, bw, bh);
  const caption = options.caption.trim().slice(0, 100);
  const placement = studioPlacement(exportWidth, exportHeight, cover.naturalWidth, cover.naturalHeight, options.scale, options.rotation, options.offsetX, options.offsetY, !!caption);
  context.save(); context.translate(placement.x, placement.y); context.rotate(placement.angle);
  context.shadowColor = 'rgba(15, 22, 25, 0.28)'; context.shadowBlur = exportWidth * 0.025; context.shadowOffsetX = exportWidth * 0.006; context.shadowOffsetY = exportWidth * 0.013;
  context.drawImage(cover, -placement.width / 2, -placement.height / 2, placement.width, placement.height);
  context.restore();
  if (caption) {
    if (document.fonts) await document.fonts.load('700 24px "Noto Sans"').catch(() => undefined);
    const fontSize = exportWidth * 0.028;
    const padding = exportWidth * 0.035;
    const boxWidth = exportWidth * 0.83;
    const boxHeight = exportWidth * 0.12;
    const boxX = (exportWidth - boxWidth) / 2, boxY = exportHeight - exportWidth * 0.055 - boxHeight;
    context.fillStyle = 'rgba(255,255,255,0.95)'; context.fillRect(boxX, boxY, boxWidth, boxHeight);
    context.fillStyle = '#172A31'; context.font = `700 ${fontSize}px "Noto Sans", system-ui, sans-serif`; context.textAlign = 'center'; context.textBaseline = 'middle';
    const words = caption.split(/\s+/); const lines: string[] = []; let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && context.measureText(next).width > boxWidth - 2 * padding) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > 2) throw new Error('La frase è troppo lunga per questo formato. Riducila prima di scaricare.');
    lines.forEach((text, index) => context.fillText(text, exportWidth / 2, boxY + boxHeight / 2 + (index - (lines.length - 1) / 2) * fontSize * 1.4, boxWidth - 2 * padding));
  }
  if (renderVersions.get(target) !== version) return;
  const targetContext = target.getContext('2d');
  if (!targetContext) throw new Error('Anteprima non disponibile in questo browser.');
  target.width = exportWidth; target.height = exportHeight; targetContext.drawImage(element, 0, 0);
}

export async function exportStudioImage(options: StudioComposition): Promise<Blob> {
  const element = document.createElement('canvas');
  await renderStudioComposition(element, options);
  return new Promise((resolve, reject) => element.toBlob(blob => blob ? resolve(blob) : reject(new Error('Impossibile preparare il download. Riprova.')), 'image/jpeg', 0.95));
}
export function downloadStudioImage(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 180); document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
