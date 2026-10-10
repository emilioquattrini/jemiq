import type { StudioPoint, StudioQuad } from '../../shared/studio';

export function validateStudioQuad(points: StudioQuad): void {
  if (points.length !== 4 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1)) {
    throw new Error('I quattro angoli devono restare dentro la foto.');
  }
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4], c = points[(i + 2) % 4];
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0.00001) {
      throw new Error('Gli angoli si incrociano. Segui il bordo della copertina in senso orario.');
    }
    area += a.x * b.y - b.x * a.y;
  }
  if (area / 2 < 0.015) throw new Error('Il ritaglio è troppo piccolo. Avvicina il libro e scatta un’altra foto.');
}

/** Maps an upright unit rectangle to the four original photo corners. */
export function perspectiveTransform(points: StudioQuad): (u: number, v: number) => StudioPoint {
  validateStudioQuad(points);
  const [p0, p1, p2, p3] = points;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) + Math.abs(dy3) > 1e-12) {
    const divisor = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(divisor) < 1e-12) throw new Error('Non è possibile raddrizzare questo ritaglio. Controlla gli angoli.');
    g = (dx3 * dy2 - dx2 * dy3) / divisor;
    h = (dx1 * dy3 - dx3 * dy1) / divisor;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y;
  return (u, v) => {
    const divisor = g * u + h * v + 1;
    return { x: (a * u + b * v + p0.x) / divisor, y: (d * u + e * v + p0.y) / divisor };
  };
}

export function studioCropSize(points: StudioQuad, width: number, height: number, maxEdge = 1600): { width: number; height: number } {
  validateStudioQuad(points);
  const distance = (a: StudioPoint, b: StudioPoint) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
  const w = (distance(points[0], points[1]) + distance(points[3], points[2])) / 2;
  const h = (distance(points[0], points[3]) + distance(points[1], points[2])) / 2;
  if (w < 120 || h < 120 || w / h < 0.2 || w / h > 5) throw new Error('La copertina è troppo piccola o inclinata. Usa una foto più frontale.');
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Clamp a rotated cover inside the export, including a safe margin and caption area. */
export function studioPlacement(canvasWidth: number, canvasHeight: number, coverWidth: number, coverHeight: number, scale: number, rotation: number, offsetX: number, offsetY: number, hasCaption = false) {
  if ([canvasWidth, canvasHeight, coverWidth, coverHeight, scale, rotation, offsetX, offsetY].some(v => !Number.isFinite(v)) || Math.min(canvasWidth, canvasHeight, coverWidth, coverHeight) <= 0) throw new Error('Dimensioni della composizione non valide.');
  const angle = Math.max(-18, Math.min(18, rotation)) * Math.PI / 180;
  const margin = canvasWidth * 0.085;
  const availableHeight = canvasHeight - margin * 2 - (hasCaption ? canvasWidth * 0.16 : 0);
  const fitted = Math.min(canvasWidth * 0.60 / coverWidth, canvasHeight * 0.63 / coverHeight) * Math.max(0.55, Math.min(1.3, scale));
  const cosine = Math.abs(Math.cos(angle)), sine = Math.abs(Math.sin(angle));
  const initialWidth = coverWidth * fitted, initialHeight = coverHeight * fitted;
  const fit = Math.min(1, (canvasWidth - 2 * margin) / (initialWidth * cosine + initialHeight * sine), availableHeight / (initialWidth * sine + initialHeight * cosine));
  const width = initialWidth * fit, height = initialHeight * fit;
  const halfX = (width * cosine + height * sine) / 2;
  const halfY = (width * sine + height * cosine) / 2;
  const centerY = margin + availableHeight / 2;
  return {
    width, height, angle,
    x: Math.max(margin + halfX, Math.min(canvasWidth - margin - halfX, canvasWidth / 2 + Math.max(-0.3, Math.min(0.3, offsetX)) * canvasWidth)),
    y: Math.max(margin + halfY, Math.min(margin + availableHeight - halfY, centerY + Math.max(-0.3, Math.min(0.3, offsetY)) * canvasHeight)),
  };
}
