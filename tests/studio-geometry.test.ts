import { describe, expect, it } from 'vitest';
import { DEFAULT_STUDIO_CORNERS, type StudioQuad } from '../shared/studio';
import { perspectiveTransform, studioCropSize, studioPlacement, validateStudioQuad } from '../src/lib/studio-geometry';

describe('photographic cover geometry', () => {
  it('preserves a frontal cover without altering proportions', () => {
    const map = perspectiveTransform(DEFAULT_STUDIO_CORNERS);
    expect(map(0.3, 0.8)).toEqual({ x: 0.3, y: 0.8 });
    expect(studioCropSize(DEFAULT_STUDIO_CORNERS, 800, 1200)).toEqual({ width: 800, height: 1200 });
  });
  it('maps all four original corners and internal straight edges under perspective', () => {
    const corners: StudioQuad = [{ x: .2, y: .1 }, { x: .7, y: .2 }, { x: .9, y: .9 }, { x: .1, y: .85 }];
    const map = perspectiveTransform(corners);
    const target = [[0, 0], [1, 0], [1, 1], [0, 1]];
    target.forEach(([u, v], i) => { expect(map(u, v).x).toBeCloseTo(corners[i].x, 10); expect(map(u, v).y).toBeCloseTo(corners[i].y, 10); });
    const middle = map(.5, 0);
    const cross = (middle.x - corners[0].x) * (corners[1].y - corners[0].y) - (middle.y - corners[0].y) * (corners[1].x - corners[0].x);
    expect(cross).toBeCloseTo(0, 10);
    expect(middle.x).toBeGreaterThan(corners[0].x); expect(middle.x).toBeLessThan(corners[1].x);
  });
  it.each<StudioQuad>([
    [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: .01, y: 0 }, { x: .01, y: .01 }, { x: 0, y: .01 }],
    [{ x: -.1, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  ])('rejects crossed, negligible or out-of-photo crops before sampling', (...corners) => {
    expect(() => validateStudioQuad(corners as StudioQuad)).toThrow();
  });
  it('caps sampling resolution without stretching the book', () => {
    expect(studioCropSize(DEFAULT_STUDIO_CORNERS, 2400, 3600)).toEqual({ width: 1067, height: 1600 });
    expect(() => studioCropSize(DEFAULT_STUDIO_CORNERS, 40, 80)).toThrow();
  });
  it.each([1350, 1920])('keeps every rotated cover corner inside format height %i even at extreme controls', height => {
    const p = studioPlacement(1080, height, 800, 1200, 1.3, 18, .3, -.3, true);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const x = p.x + sx * p.width / 2 * Math.cos(p.angle) - sy * p.height / 2 * Math.sin(p.angle);
      const y = p.y + sx * p.width / 2 * Math.sin(p.angle) + sy * p.height / 2 * Math.cos(p.angle);
      expect(x).toBeGreaterThanOrEqual(1080 * .085 - 1e-8); expect(x).toBeLessThanOrEqual(1080 * .915 + 1e-8);
      expect(y).toBeGreaterThanOrEqual(1080 * .085 - 1e-8); expect(y).toBeLessThan(height - 1080 * .2);
    }
  });
});
