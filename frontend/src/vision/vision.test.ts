import { describe, expect, it } from 'vitest';
import type { SizeChartRow } from '../types';
import { BodySampler, LM, OneEuro, bodyFromLandmarks, chestWidthFromMask, type Landmark } from './body';
import { len, referenceSize, sub } from './geometry';

const size = (label: string, chest: number, shoulder: number, length: number): SizeChartRow =>
  ({ label, chest_width_cm: chest, shoulder_width_cm: shoulder, length_cm: length, sleeve_length_cm: 20, sleeve_opening_cm: null }) as SizeChartRow;
const S = size('S', 48, 42, 66), M = size('M', 51, 44, 69), L = size('L', 54, 46, 72);

describe('geometry', () => {
  it('referenceSize picks the middle of the chart', () => {
    expect(referenceSize([S, M, L]).label).toBe('M');
    expect(referenceSize([S, M]).label).toBe('S');
  });
});

describe('body tracking helpers', () => {
  const lms = (vis = 0.9): Landmark[] => {
    const a: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
    a[LM.lShoulder] = { x: 0.6, y: 0.3, visibility: vis }; // person's left = image right (unmirrored)
    a[LM.rShoulder] = { x: 0.4, y: 0.3, visibility: vis };
    a[LM.lHip] = { x: 0.57, y: 0.7, visibility: vis };
    a[LM.rHip] = { x: 0.43, y: 0.7, visibility: vis };
    return a;
  };

  it('orders shoulders by image side and computes proportions', () => {
    const b = bodyFromLandmarks(lms(), 1000, 1000)!;
    expect(b.leftShoulder.x).toBe(400);
    expect(b.rightShoulder.x).toBe(600);
    expect(b.shoulderSpan).toBeCloseTo(200);
    expect(b.torsoLength).toBeCloseTo(400);
    expect(b.inFrame).toBe(true);
  });

  it('returns null instead of inventing landmarks when shoulders are not visible', () => {
    expect(bodyFromLandmarks(lms(0.2), 1000, 1000)).toBeNull();
  });

  it('One Euro filter reduces jitter but converges to a step', () => {
    const f = new OneEuro();
    const noisy = [100, 104, 97, 103, 98, 102].map((v, i) => f.filter(v, i * 33));
    expect(Math.max(...noisy.slice(1)) - Math.min(...noisy.slice(1))).toBeLessThan(7);
    let v = 0;
    for (let i = 0; i < 60; i++) v = f.filter(200, 300 + i * 33);
    expect(v).toBeCloseTo(200, 0);
  });

  it('measures chest width from the person mask and rejects arms merged in', () => {
    const W = 100, H = 100;
    const mask = new Float32Array(W * H);
    for (let x = 40; x < 60; x++) mask[50 * W + x] = 1; // 20 mask px wide on row 50
    expect(chestWidthFromMask(mask, W, H, 500, 500, 1000, 1000, 180)).toBeCloseTo(200);
    expect(chestWidthFromMask(mask, W, H, 500, 500, 1000, 1000, 100)).toBeNull(); // 2x span: arms merged
    expect(chestWidthFromMask(mask, W, H, 100, 500, 1000, 1000, 180)).toBeNull(); // not on the person
  });

  it('sampler summarises with medians and clears', () => {
    const s = new BodySampler(10);
    [100, 102, 98, 101, 99].forEach((v) => s.add(v, v * 1.1, 300, 0.9));
    const sum = s.summary()!;
    expect(sum.shoulder_span_px).toBe(100);
    expect(sum.chest_width_px).toBeCloseTo(110);
    expect(sum.samples).toBe(5);
    expect(sum.stability_cv).toBeLessThan(0.02);
    s.clear();
    expect(s.summary()).toBeNull();
  });

  it('distance helpers', () => {
    expect(len(sub({ x: 3, y: 4 }, { x: 0, y: 0 }))).toBe(5);
  });
});
