import { describe, expect, it } from 'vitest';
import { NEUTRAL_LIGHT, blendLight, estimateLight } from './lighting';

const W = 40, H = 20;
function frame(fn: (x: number, y: number) => [number, number, number]) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = fn(x, y);
    px.set([r, g, b, 255], (y * W + x) * 4);
  }
  return px;
}
const face = { x0: 15, y0: 2, x1: 25, y1: 8 };
const torso = { x0: 12, y0: 10, x1: 28, y1: 19 };

describe('estimateLight', () => {
  it('reads light direction from face shading', () => {
    const lit = estimateLight(frame((x) => (x >= 20 ? [200, 180, 160] : [90, 80, 70])), W, face, torso);
    expect(lit.lightDir[0]).toBeGreaterThan(0.5); // brighter on the image right
    const mirrored = estimateLight(frame((x) => (x < 20 ? [200, 180, 160] : [90, 80, 70])), W, face, torso);
    expect(mirrored.lightDir[0]).toBeLessThan(-0.5);
  });
  it('dims the shirt in a dark room and brightens it in a bright one', () => {
    expect(estimateLight(frame(() => [40, 40, 40]), W, face, torso).exposure).toBeLessThan(0.7);
    expect(estimateLight(frame(() => [220, 220, 220]), W, face, torso).exposure).toBeGreaterThan(1.1);
  });
  it('ignores the colour of the customer\'s own clothes for exposure', () => {
    const dark = estimateLight(frame((_, y) => (y >= 10 ? [20, 20, 20] : [150, 150, 150])), W, face, torso).exposure;
    const light = estimateLight(frame((_, y) => (y >= 10 ? [240, 240, 240] : [150, 150, 150])), W, face, torso).exposure;
    expect(Math.abs(dark - light)).toBeLessThan(0.3);
  });
  it('warms or cools the shirt with the room, keeping luminance', () => {
    const warm = estimateLight(frame(() => [200, 150, 100]), W, face, torso);
    expect(warm.tint[0]).toBeGreaterThan(warm.tint[2]);
    const luma = 0.2126 * warm.tint[0] + 0.7152 * warm.tint[1] + 0.0722 * warm.tint[2];
    expect(luma).toBeCloseTo(1, 5);
  });
  it('flat lighting lowers contrast; samples skin from the face', () => {
    const flat = estimateLight(frame(() => [128, 128, 128]), W, face, torso);
    expect(flat.contrast).toBeLessThan(1);
    expect(flat.contrast).toBeGreaterThanOrEqual(0.9);
    expect(flat.skin![0]).toBeCloseTo(128 / 255, 2);
    expect(estimateLight(frame(() => [128, 128, 128]), W, null, null).skin).toBeNull();
  });
  it('blends smoothly', () => {
    const b = blendLight(NEUTRAL_LIGHT, { ...NEUTRAL_LIGHT, exposure: 2 }, 0.25);
    expect(b.exposure).toBeCloseTo(1.25);
  });
});
