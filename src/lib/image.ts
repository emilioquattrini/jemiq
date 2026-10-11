import type { PreparedImage } from '../../shared/types';

const MAX_INPUT = 32 * 1024 * 1024;
const MAX_OUTPUT = 4 * 1024 * 1024;
const LONG_EDGE = 3200;

async function decode(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; release: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch { /* Safari may decode camera formats only through an image element. */ }
  }
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  try { await image.decode(); }
  catch { URL.revokeObjectURL(url); throw new Error('Questo formato non è leggibile nel browser. Scegli una foto JPEG, PNG o WebP.'); }
  return { source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

function encode(canvas: HTMLCanvasElement): PreparedImage {
  let quality = 0.9;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length * 0.75 > MAX_OUTPUT && quality > 0.55) { quality -= 0.1; dataUrl = canvas.toDataURL('image/jpeg', quality); }
  if (dataUrl.length * 0.75 > MAX_OUTPUT) throw new Error('La foto è troppo pesante. Ritagliala in due immagini più ravvicinate.');
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) throw new Error('Non è stato possibile preparare questa foto. Prova con un altro file.');
  return { dataUrl, data: dataUrl.split(',')[1], mimeType: 'image/jpeg', width: canvas.width, height: canvas.height };
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (file.size === 0) throw new Error('Il file selezionato è vuoto.');
  if (file.size > MAX_INPUT) throw new Error('La foto supera 32 MB. Scegli una versione più piccola.');
  if (!/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(file.type)) throw new Error('Scegli una foto JPEG, PNG o WebP. Le foto HEIC sono supportate solo nei browser compatibili.');
  const decoded = await decode(file);
  try {
    if (decoded.width < 120 || decoded.height < 120) throw new Error('La foto è troppo piccola per leggere i libri. Usa l’originale.');
    if (decoded.width * decoded.height > 80_000_000) throw new Error('La risoluzione è troppo alta. Esporta la foto a dimensioni inferiori.');
    const scale = Math.min(1, LONG_EDGE / Math.max(decoded.width, decoded.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(decoded.width * scale);
    canvas.height = Math.round(decoded.height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Il browser non può preparare questa foto.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
    return encode(canvas);
  } finally { decoded.release(); }
}

export async function rotateImage(image: PreparedImage): Promise<PreparedImage> {
  const blob = await (await fetch(image.dataUrl)).blob();
  const decoded = await decode(blob);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = decoded.height;
    canvas.height = decoded.width;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Il browser non può ruotare la foto.');
    context.translate(canvas.width, 0);
    context.rotate(Math.PI / 2);
    context.drawImage(decoded.source, 0, 0);
    return encode(canvas);
  } finally { decoded.release(); }
}
