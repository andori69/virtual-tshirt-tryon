import type { Point } from '../types';
import { len, mid, sub } from './geometry';

export type Landmark = { x: number; y: number; visibility?: number };

export const LM = {
  nose: 0, leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8, mouthL: 9, mouthR: 10,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16, lIndex: 19, rIndex: 20,
  lHip: 23, rHip: 24,
} as const;

export const MIN_VIS = 0.5;

/** One Euro filter: low jitter when still, low lag when moving (Casiez et al. 2012). */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1.0) {}
  private static alpha(cutoff: number, dt: number) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.t = tMs;
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    this.t = tMs;
    const ad = OneEuro.alpha(this.dCutoff, dt);
    this.dx = ad * ((value - this.x) / dt) + (1 - ad) * this.dx;
    const a = OneEuro.alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
  reset() {
    this.x = null;
    this.dx = 0;
  }
}

/** Smooths visible landmarks; landmarks below MIN_VIS are reported as null (never invented). */
export class LandmarkSmoother {
  private filters = new Map<number, [OneEuro, OneEuro]>();
  smooth(lms: Landmark[], idx: number[], width: number, height: number, tMs: number): Map<number, Point | null> {
    const out = new Map<number, Point | null>();
    for (const i of idx) {
      const lm = lms[i];
      if (!lm || (lm.visibility ?? 1) < MIN_VIS) {
        this.filters.get(i)?.forEach((f) => f.reset());
        out.set(i, null);
        continue;
      }
      let f = this.filters.get(i);
      if (!f) this.filters.set(i, (f = [new OneEuro(), new OneEuro()]));
      out.set(i, { x: f[0].filter(lm.x * width, tMs), y: f[1].filter(lm.y * height, tMs) });
    }
    return out;
  }
  reset() {
    this.filters.clear();
  }
}

export type BodyFrame = {
  leftShoulder: Point; // image-left (smaller x), unmirrored video pixels
  rightShoulder: Point;
  hipMid: Point | null;
  shoulderSpan: number;
  torsoLength: number | null;
  center: Point;
  visibility: number;
  inFrame: boolean;
};

/** Image-space body proportions from raw landmarks (normalized), or null if shoulders are not visible. */
export function bodyFromLandmarks(lms: Landmark[], width: number, height: number, pts?: Map<number, Point | null>): BodyFrame | null {
  const get = (i: number): Point | null => {
    if (pts) return pts.get(i) ?? null;
    const lm = lms[i];
    return lm && (lm.visibility ?? 1) >= MIN_VIS ? { x: lm.x * width, y: lm.y * height } : null;
  };
  const a = get(LM.lShoulder);
  const b = get(LM.rShoulder);
  if (!a || !b) return null;
  const [leftShoulder, rightShoulder] = a.x <= b.x ? [a, b] : [b, a];
  const lh = get(LM.lHip);
  const rh = get(LM.rHip);
  const hipMid = lh && rh ? mid(lh, rh) : null;
  const sMid = mid(leftShoulder, rightShoulder);
  const vis = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip].map((i) => lms[i]?.visibility ?? 0);
  const shoulderSpan = len(sub(rightShoulder, leftShoulder));
  const margin = 0.02;
  const inFrame = [leftShoulder, rightShoulder].every(
    (p) => p.x > width * margin && p.x < width * (1 - margin) && p.y > height * margin && p.y < height * (1 - margin),
  );
  return {
    leftShoulder,
    rightShoulder,
    hipMid,
    shoulderSpan,
    torsoLength: hipMid ? len(sub(hipMid, sMid)) : null,
    center: hipMid ? mid(sMid, hipMid) : sMid,
    visibility: vis.reduce((s, v) => s + v, 0) / vis.length,
    inFrame,
  };
}

/** Width (px) of the person-mask run containing `x` on row `y`; null if the run looks like arms merged in. */
export function chestWidthFromMask(
  mask: Float32Array, maskW: number, maskH: number, x: number, y: number, frameW: number, frameH: number,
  shoulderSpan: number, threshold = 0.5,
): number | null {
  const mx = Math.round((x / frameW) * (maskW - 1));
  const my = Math.round((y / frameH) * (maskH - 1));
  if (mx < 0 || mx >= maskW || my < 0 || my >= maskH) return null;
  const row = my * maskW;
  if (mask[row + mx] < threshold) return null;
  let l = mx;
  let r = mx;
  while (l > 0 && mask[row + l - 1] >= threshold) l--;
  while (r < maskW - 1 && mask[row + r + 1] >= threshold) r++;
  if (l === 0 || r === maskW - 1) return null; // touches frame edge
  const width = ((r - l + 1) / maskW) * frameW;
  // Chest is wider than the shoulder-joint span but not by much; arms resting against the body make it much wider.
  if (width < shoulderSpan * 0.8 || width > shoulderSpan * 1.45) return null;
  return width;
}

/**
 * Distances (px) from `center` to the person-mask edge along -dir and +dir (dir = unit shoulder direction).
 * A side is null when the centre isn't on the person or the edge is beyond `maxPx` (arm merged in, frame edge).
 * `maxPx` may be [-dir side, +dir side] to stop each side at a different distance (e.g. at that side's arm).
 */
export function silhouetteHalfWidths(
  mask: Float32Array, maskW: number, maskH: number, frameW: number, frameH: number,
  center: Point, dir: Point, maxPx: number | [number, number], threshold = 0.5,
): [number | null, number | null] {
  const sample = (x: number, y: number) => {
    const mx = Math.round((x / frameW) * (maskW - 1));
    const my = Math.round((y / frameH) * (maskH - 1));
    if (mx < 0 || mx >= maskW || my < 0 || my >= maskH) return -1;
    return mask[my * maskW + mx];
  };
  if (sample(center.x, center.y) < threshold) return [null, null];
  const step = frameW / maskW;
  const march = (sign: -1 | 1) => {
    const max = typeof maxPx === 'number' ? maxPx : maxPx[sign < 0 ? 0 : 1];
    for (let d = step; d <= max; d += step) {
      const v = sample(center.x + sign * dir.x * d, center.y + sign * dir.y * d);
      if (v < 0) return null;
      if (v < threshold) return d;
    }
    return null;
  };
  return [march(-1), march(1)];
}

/** Body turn from MediaPipe world landmarks (metres): 0 = facing the camera. */
export function yawFromWorld(world: { x: number; z: number }[] | null): number | null {
  const l = world?.[LM.lShoulder], r = world?.[LM.rShoulder];
  if (!l || !r) return null;
  return Math.atan2(Math.abs(r.z - l.z), Math.abs(r.x - l.x));
}

export type BodySampleSummary = {
  shoulder_span_px: number;
  chest_width_px: number | null;
  torso_length_px: number | null;
  visibility: number;
  stability_cv: number;
  samples: number;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Rolling window of per-frame measurements. Lives only in memory and is cleared on session reset. */
export class BodySampler {
  private rows: { span: number; chest: number | null; torso: number | null; vis: number }[] = [];
  constructor(private capacity = 60) {}
  add(span: number, chest: number | null, torso: number | null, vis: number) {
    this.rows.push({ span, chest, torso, vis });
    if (this.rows.length > this.capacity) this.rows.shift();
  }
  clear() {
    this.rows = [];
  }
  get count() {
    return this.rows.length;
  }
  summary(): BodySampleSummary | null {
    if (!this.rows.length) return null;
    const spans = this.rows.map((r) => r.span);
    const m = spans.reduce((s, v) => s + v, 0) / spans.length;
    const sd = Math.sqrt(spans.reduce((s, v) => s + (v - m) ** 2, 0) / spans.length);
    const chests = this.rows.map((r) => r.chest).filter((v): v is number => v != null);
    const torsos = this.rows.map((r) => r.torso).filter((v): v is number => v != null);
    return {
      shoulder_span_px: median(spans),
      // Require chest in at least a third of frames before trusting it.
      chest_width_px: chests.length >= this.rows.length / 3 ? median(chests) : null,
      torso_length_px: torsos.length >= this.rows.length / 3 ? median(torsos) : null,
      visibility: Math.min(1, this.rows.reduce((s, r) => s + r.vis, 0) / this.rows.length),
      stability_cv: m ? sd / m : 1,
      samples: this.rows.length,
    };
  }
}
