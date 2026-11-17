/**
 * Procedural T-shirt mesh wrapped around the body rig (display space, see rig.ts).
 *
 * - Torso: a stack of elliptical rings from the shoulder line to the hem. Widths come from the person silhouette
 *   (or shoulder width when the mask can't see the torso edge), times the style's ease; depth = width x ratio.
 * - Yoke: from the collar ring at the base of the neck down to the shoulder line; crew front dips below it.
 * - Sleeves: tapered tubes along shoulder -> elbow (-> wrist for long sleeves).
 * - Texture: the product photo is projected cylindrically onto the front half (u follows the angle around the body,
 *   so the print curves and the sides fall away); the back photo (if any) onto the back half. Print aspect is kept by
 *   widening/narrowing the sampled photo range instead of stretching it.
 * - Fake folds (armpits, waist, elbows) perturb normals; secondary motion springs lag the hem and sleeve ends.
 */
import type { Anchors, Point } from '../../types';
import { SHOULDER_LIFT, type Rig, type V3 } from './rig';

export type Style = 'slim' | 'regular' | 'oversized';
export type SleeveKind = 'short' | 'long' | 'sleeveless';

/** ease: garment/body width; seam: shoulder seam vs body; box: 0 follows the body, 1 straight boxy cut. */
export const STYLES: Record<Style, { ease: number; seam: number; box: number; len: number; sleeveR: number }> = {
  slim: { ease: 1.03, seam: 1.0, box: 0.0, len: 0.97, sleeveR: 0.85 },
  regular: { ease: 1.1, seam: 1.06, box: 0.5, len: 1.0, sleeveR: 1.0 },
  oversized: { ease: 1.24, seam: 1.2, box: 1.0, len: 1.04, sleeveR: 1.22 },
};

/** Size multipliers relative to the reference size (1 = as photographed / fitted to the body). */
export type Fit = { style: Style; width: number; length: number };

/** Garment geometry measured on the processed product photo (normalized 0..1 canvas coordinates). */
export type GarmentShape = {
  shoulderY: number; hemY: number; neckY: number;
  torsoL: number; torsoR: number;
  seamHalf: number;
  sleeves: { L: { a: Point; b: Point; half: number }; R: { a: Point; b: Point; half: number } };
  sleeve: SleeveKind;
};

export function analyzeShape(an: Anchors, alpha: Uint8ClampedArray | null, size: number, sleeve: SleeveKind = 'short'): GarmentShape {
  const shoulderY = (an.left_shoulder.y + an.right_shoulder.y) / 2;
  const seamHalf = Math.max(0.05, (an.right_shoulder.x - an.left_shoulder.x) / 2);
  // Half-width of a sleeve: walk perpendicular to its axis from the midpoint until the photo turns transparent.
  const half = (a: Point, b: Point) => {
    if (!alpha) return seamHalf * 0.35;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = { x: b.x - a.x, y: b.y - a.y }, l = Math.hypot(d.x, d.y) || 1;
    const n = { x: -d.y / l, y: d.x / l };
    const reach = (s: number) => {
      for (let k = 1; k < size; k++) {
        const x = Math.round((m.x + n.x * s * k / size) * (size - 1)), y = Math.round((m.y + n.y * s * k / size) * (size - 1));
        if (x < 0 || y < 0 || x >= size || y >= size || alpha[y * size + x] < 128) return k / size;
      }
      return 0;
    };
    const h = (reach(1) + reach(-1)) / 2;
    return h > 0.01 ? h : seamHalf * 0.35;
  };
  const sl = { a: an.left_shoulder, b: an.left_sleeve }, sr = { a: an.right_shoulder, b: an.right_sleeve };
  return {
    shoulderY, hemY: an.bottom_center.y, neckY: an.neckline_center.y,
    torsoL: an.left_hem.x, torsoR: an.right_hem.x, seamHalf,
    sleeves: { L: { ...sl, half: half(sl.a, sl.b) }, R: { ...sr, half: half(sr.a, sr.b) } },
    sleeve,
  };
}

// Topology
export const M = 48;            // segments around the torso
const NC = 1;                   // collar rib row (above the neck ring)
const NY = 4;                   // yoke rows from the neck ring down to the shoulder line
export const NR = 22;           // torso rings, shoulder line -> hem
export const MS = 20;           // segments around a sleeve
export const NS = 10;           // sleeve rings
const ROWS = NC + NY + NR;      // rows in the torso stack
const TORSO_V = ROWS * M;
export const VERTS = TORSO_V + 2 * NS * MS;

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const norm3 = (v: V3): V3 => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const ellipsePerimeter = (a: number, b: number) => {
  const h = ((a - b) ** 2) / ((a + b) ** 2);
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
};

/** Critically-damped-ish spring on a 2D point; returns the lagged offset from the target. */
export class Spring {
  private p: Point | null = null;
  private v: Point = { x: 0, y: 0 };
  step(target: Point, dt: number, maxOffset: number): Point {
    if (!this.p) this.p = { ...target };
    const k = 90, c = 2 * Math.sqrt(k) * 0.55; // slightly under-damped: a small sway, no ringing
    const ax = k * (target.x - this.p.x) - c * this.v.x, ay = k * (target.y - this.p.y) - c * this.v.y;
    this.v = { x: this.v.x + ax * dt, y: this.v.y + ay * dt };
    this.p = { x: this.p.x + this.v.x * dt, y: this.p.y + this.v.y * dt };
    let ox = this.p.x - target.x, oy = this.p.y - target.y;
    const d = Math.hypot(ox, oy);
    if (d > maxOffset) { // never stretch past the limit: pull the state back onto it
      ox *= maxOffset / d; oy *= maxOffset / d;
      this.p = { x: target.x + ox, y: target.y + oy };
    }
    return { x: ox, y: oy };
  }
  reset() { this.p = null; this.v = { x: 0, y: 0 }; }
}

/** widthRatio: drawn chest width / measured body chest width (null when the silhouette couldn't see the torso). */
export type ShirtStats = {
  hemY: number; collarFrontY: number; collarTopY: number; visibleLengthFrac: number; aspectK: number; widthRatio: number | null;
  minX?: number; maxX?: number;  // on-screen extent (photo mesh)
  bulky?: boolean;               // the customer's own top is much wider than a body (hoodie, jacket)
};

export class ShirtModel {
  readonly position = new Float32Array(VERTS * 3);
  readonly normal = new Float32Array(VERTS * 3);
  readonly uv = new Float32Array(VERTS * 2);     // front photo
  readonly uv2 = new Float32Array(VERTS * 2);    // back photo
  readonly tex = new Float32Array(VERTS);        // 0 = front photo, 1 = back photo
  readonly ao = new Float32Array(VERTS);
  readonly tanU = new Float32Array(VERTS * 3);
  readonly tanV = new Float32Array(VERTS * 3);
  readonly index: Uint32Array;
  sleevesVisible = true;
  stats: ShirtStats = { hemY: 0, collarFrontY: 0, collarTopY: 0, visibleLengthFrac: 1, aspectK: 1, widthRatio: null };

  private rest: { a: number[]; L: number } | null = null;
  private ringSprings = Array.from({ length: NR }, () => new Spring());
  private sleeveSprings = [new Spring(), new Spring()];
  private aspectK = 1;

  constructor() {
    const idx: number[] = [];
    const quadStrip = (base: number, rows: number, cols: number) => {
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) {
        const a = base + r * cols + c, b = base + r * cols + ((c + 1) % cols);
        const d = a + cols, e = b + cols;
        idx.push(a, d, b, b, d, e);
      }
    };
    quadStrip(0, ROWS, M);
    quadStrip(TORSO_V, NS, MS);
    quadStrip(TORSO_V + NS * MS, NS, MS);
    this.index = new Uint32Array(idx);
  }

  reset() {
    this.rest = null;
    this.ringSprings.forEach((s) => s.reset());
    this.sleeveSprings.forEach((s) => s.reset());
  }

  update(rig: Rig, shape: GarmentShape, fit: Fit, dtMs: number) {
    const st = STYLES[fit.style];
    const { u, down, span, yaw } = rig;
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
    const dt = clamp(dtMs / 1000, 0.001, 0.05);

    // Body length from the shoulder line to the hips, and the garment's own proportions from the photo.
    const bodyLen = Math.hypot(rig.hip.x - rig.top.x, rig.hip.y - rig.top.y);
    const seamHalf = 0.5 * span * 1.15 * st.seam * fit.width;
    const photoLen = (shape.hemY - shape.shoulderY) / (2 * shape.seamHalf);
    let L = clamp(2 * seamHalf * photoLen * st.len * fit.length, 0.8 * bodyLen, 1.35 * bodyLen);

    // Body half-widths (3D) along the torso from the silhouette, else from shoulder width.
    const depthRatio = (t: number) => (t < 0.2 ? lerp(0.5, 0.62, t / 0.2) : lerp(0.62, 0.58, (t - 0.2) / 0.8));
    const proj = (r: number) => Math.sqrt(cosY * cosY + r * r * sinY * sinY); // projected/true half-width of a turned ellipse
    const sil = rig.silhouette;
    const silAt = (tb: number) => {
      // Linear interpolation between the nearest measured rows on each side (nulls skipped).
      const side = (key: 'l' | 'r') => {
        const pts = sil.filter((s) => s[key] != null);
        if (!pts.length) return null;
        if (tb <= pts[0].t) return pts[0][key]!;
        if (tb >= pts[pts.length - 1].t) return pts[pts.length - 1][key]!;
        for (let i = 1; i < pts.length; i++) if (tb <= pts[i].t) {
          const k = (tb - pts[i - 1].t) / (pts[i].t - pts[i - 1].t);
          return lerp(pts[i - 1][key]!, pts[i][key]!, k);
        }
        return null;
      };
      return [side('l'), side('r')] as const;
    };
    const lift = span * SHOULDER_LIFT;
    const tArm = clamp((0.2 * bodyLen + lift) / L, 0.12, 0.3);  // armpit level on the garment
    const g: number[] = [], offs: number[] = [];
    for (let k = 0; k < NR; k++) {
      const t = k / (NR - 1);
      const tb = (t * L - lift) / bodyLen;
      const r = depthRatio(t);
      const heur = span * (tb < 0.5 ? lerp(0.56, 0.5, clamp(tb, 0, 0.5) / 0.5) : lerp(0.5, 0.55, (tb - 0.5) / 0.5));
      const [l, rr] = silAt(clamp(tb, 0, 1));
      const pl = l ?? heur * proj(r), pr = rr ?? heur * proj(r);
      g.push(((pl + pr) / 2 / proj(r)) * st.ease * fit.width);
      offs.push(clamp((pr - pl) / 2, -0.1 * span, 0.1 * span));
    }
    // Boxy cuts hang straight from the chest; the width comes from chest/waist rows only (hips and skirts would turn
    // the whole shirt into a poncho). Lower rows still widen if the body below is wider.
    const box = Math.max(...g.filter((_, k) => k / (NR - 1) >= tArm && k / (NR - 1) <= 0.7));
    const a = g.map((v, k) => {
      const t = k / (NR - 1);
      const body = t <= 0.7 ? lerp(v, Math.max(v, box), st.box) : Math.max(v, lerp(v, box, st.box));
      return t < tArm ? lerp(seamHalf, Math.max(seamHalf * 0.9, body), smooth(0, tArm, t)) : body;
    });
    // Stretch limit: the shirt's shape (widths and length in shoulder spans, so walking closer/farther scales freely)
    // may move at most 10% away from its slowly-adapting rest shape.
    const kRest = 1 - Math.exp(-dtMs / 500);
    const an = a.map((v) => v / span), Ln = L / span;
    if (!this.rest) this.rest = { a: [...an], L: Ln };
    const rest = this.rest;
    this.rest = { a: rest.a.map((r, k) => lerp(r, an[k], kRest)), L: lerp(rest.L, Ln, kRest) };
    for (let k = 0; k < NR; k++) a[k] = clamp(an[k], rest.a[k] * 0.9, rest.a[k] * 1.1) * span;
    L = clamp(Ln, rest.L * 0.9, rest.L * 1.1) * span;

    // Never draw the hem past the bottom of the frame: crop the shirt (and its print), don't squash it.
    let vis = 1;
    const tilt = Math.abs(u.y) * a[NR - 1] + 0.02 * L; // a tilted hem ring and the sway reach lower than its centre
    const hemY0 = rig.top.y + down.y * L + tilt;
    if (down.y > 0.05 && hemY0 > rig.H - 2) vis = clamp((rig.H - 2 - tilt - rig.top.y) / (down.y * L), 0.2, 1);

    // Print aspect: compare the front arc at the chest with the shirt length, and sample a wider/narrower photo range.
    const kChest = Math.round(tArm * (NR - 1)) + 2;
    const arc = ellipsePerimeter(a[kChest], a[kChest] * depthRatio(kChest / (NR - 1))) / 2;
    const photoAspect = (shape.torsoR - shape.torsoL) / (shape.hemY - shape.shoulderY);
    this.aspectK = lerp(this.aspectK, clamp(arc / L / photoAspect, 0.6, 1.8), 0.2);
    const cx = (shape.torsoL + shape.torsoR) / 2, uSpan = (shape.torsoR - shape.torsoL) * this.aspectK;

    const P = this.position, UV = this.uv, UV2 = this.uv2, TEX = this.tex, AO = this.ao;
    const setV = (i: number, x: number, y: number, z: number) => { P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z; };
    const thetaOf = (j: number) => (2 * Math.PI * j) / M - Math.PI; // 0 = front centre
    const ringPoint = (cxy: Point, cz: number, ax: number, bz: number, th: number, dy = 0): V3 => {
      const X = ax * Math.sin(th), Z = bz * Math.cos(th);
      const xr = X * cosY - Z * sinY, zr = X * sinY + Z * cosY;
      return { x: cxy.x + u.x * xr + down.x * dy, y: cxy.y + u.y * xr + down.y * dy, z: cz + zr };
    };
    const frontUV = (th: number, vy: number, i: number) => {
      UV[i * 2] = cx + (th / Math.PI) * uSpan;
      UV[i * 2 + 1] = vy;
      const ph = th >= 0 ? th : th + 2 * Math.PI;
      UV2[i * 2] = cx + ((Math.PI - ph) / Math.PI) * uSpan;
      UV2[i * 2 + 1] = vy;
      TEX[i] = clamp((Math.abs(th) - Math.PI / 2) / ((2 * Math.PI) / M) + 0.5, 0, 1);
    };

    // Torso rings (with hem sway from the springs).
    const armDown = (s: V3, e: V3 | null) => (e ? clamp((e.y - s.y) / (span * 0.6), 0, 1) : 1);
    const downL = armDown(rig.arms.L.shoulder, rig.arms.L.elbow), downR = armDown(rig.arms.R.shoulder, rig.arms.R.elbow);
    const ringBase = NC + NY;
    for (let k = 0; k < NR; k++) {
      const t = (k / (NR - 1)) * vis;
      const cz = lerp(0, rig.hip.z, clamp((t * L - lift) / bodyLen, 0, 1));
      let c = { x: rig.top.x + down.x * L * t + u.x * offs[k], y: rig.top.y + down.y * L * t + u.y * offs[k] };
      const w = smooth(0.45, 1, t);
      if (w > 0) {
        const o = this.ringSprings[k].step(c, dt, 0.1 * L * w);
        c = { x: c.x + o.x * w, y: c.y + o.y * w };
      }
      const b = a[k] * depthRatio(t);
      const vy = lerp(shape.shoulderY, shape.hemY, t);
      for (let j = 0; j < M; j++) {
        const i = (ringBase + k) * M + j, th = thetaOf(j);
        const p = ringPoint(c, cz, a[k], b, th);
        setV(i, p.x, Math.min(p.y, rig.H - 1), p.z); // safety: nothing of the torso below the frame
        frontUV(th, vy, i);
        // AO: armpits (on the side of a lowered arm), slightly darker sides, hem edge.
        const s = Math.sin(th);
        const pit = Math.exp(-(((Math.abs(th) - 1.35) / 0.35) ** 2) - (((t - tArm) / 0.1) ** 2)) * (s < 0 ? downL : downR);
        AO[i] = (1 - 0.35 * pit) * (1 - 0.1 * s * s) * (k === NR - 1 ? 0.95 : 1);
      }
    }

    // Collar ring at the base of the neck: crew front dips, back rises slightly.
    const aN = span * 0.19, bN = span * 0.17, dip = span * 0.07;
    const neckPt = (th: number, shrink = 1, up = 0) => ringPoint(rig.neck, rig.neck.z, aN * shrink, bN * shrink, th,
      dip * Math.max(0, Math.cos(th)) ** 2 - span * 0.012 * Math.max(0, -Math.cos(th)) - up);
    const vNeck = shape.neckY + 0.02;
    for (let j = 0; j < M; j++) {
      const th = thetaOf(j);
      const cP = neckPt(th, 0.97, span * 0.035); // rib band
      setV(j, cP.x, cP.y, cP.z);
      frontUV(th, shape.neckY, j);
      AO[j] = 0.8;
      const top = { x: P[(ringBase * M + j) * 3], y: P[(ringBase * M + j) * 3 + 1], z: P[(ringBase * M + j) * 3 + 2] };
      const n0 = neckPt(th);
      for (let r = 0; r < NY; r++) {
        const s = r / NY, i = (NC + r) * M + j;
        const bulge = Math.sin(Math.PI * s) * span * 0.03; // rounded shoulders
        setV(i, lerp(n0.x, top.x, s) - down.x * bulge, lerp(n0.y, top.y, s) - down.y * bulge, lerp(n0.z, top.z, s) + bulge * 0.5);
        frontUV(th, lerp(vNeck, shape.shoulderY, s), i);
        AO[i] = r === 0 ? 0.85 : 0.95;
      }
    }

    // Normals and tangents for the stack from neighbouring vertices (rows run downward, columns around the body).
    const at = (i: number): V3 => ({ x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] });
    const foldH = (th: number, t: number) => {
      const side = Math.sin(th) ** 2;
      const waist = smooth(0.45, 0.95, t) * side * Math.sin(2 * Math.PI * (t * 6 + 0.15 * Math.sin(3 * th)));
      const pitW = Math.exp(-(((Math.abs(th) - 1.25) / 0.4) ** 2) - (((t - tArm - 0.05) / 0.13) ** 2)) * (th < 0 ? downL : downR);
      const pit = pitW * Math.sin(2 * Math.PI * (t * 5 + Math.abs(th) * 0.8));
      return 0.6 * waist + 0.9 * pit;
    };
    for (let r = 0; r < ROWS; r++) for (let j = 0; j < M; j++) {
      const i = r * M + j;
      const jl = r * M + ((j + M - 1) % M), jr = r * M + ((j + 1) % M);
      const ru = Math.max(0, r - 1) * M + j, rd = Math.min(ROWS - 1, r + 1) * M + j;
      const tu = norm3(sub3(at(jr), at(jl))), tv = norm3(sub3(at(rd), at(ru)));
      let n = norm3(cross(tu, tv));
      if (r >= ringBase) { // folds only on the torso
        const th = thetaOf(j), t = ((r - ringBase) / (NR - 1)) * vis, e = 0.02;
        const dh = (foldH(th + e, t) - foldH(th - e, t)) / (2 * e) * 0.08;
        const dv = (foldH(th, t + e) - foldH(th, t - e)) / (2 * e) * 0.04;
        n = norm3({ x: n.x - tu.x * dh - tv.x * dv, y: n.y - tu.y * dh - tv.y * dv, z: n.z - tu.z * dh - tv.z * dv });
        AO[i] *= 1 - 0.12 * Math.max(0, -foldH(th, t));
      }
      put3(this.normal, i, n); put3(this.tanU, i, tu); put3(this.tanV, i, tv);
    }

    // Sleeves.
    this.sleevesVisible = shape.sleeve !== 'sleeveless';
    (['L', 'R'] as const).forEach((sideKey, si) => {
      const base = TORSO_V + si * NS * MS;
      const arm = rig.arms[sideKey];
      const sign = sideKey === 'L' ? -1 : 1;
      const S = arm.shoulder;
      const fallback: V3 = { x: S.x + down.x * span * 0.6 + u.x * sign * span * 0.2, y: S.y + down.y * span * 0.6 + u.y * sign * span * 0.2, z: S.z };
      const E = arm.elbow ?? fallback;
      const path: V3[] = [S, E];
      if (shape.sleeve === 'long' && arm.wrist) path.push(arm.wrist);
      const segLen = (p: V3, q: V3) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
      const total = path.slice(1).reduce((s, p, i) => s + segLen(path[i], p), 0) || 1;
      const ph = shape.sleeves[sideKey];
      const photoSleeve = Math.hypot(ph.b.x - ph.a.x, ph.b.y - ph.a.y) / (2 * shape.seamHalf);
      const cap = span * 0.1; // the sleeve cap starts above the shoulder joint and rounds over it
      const s0 = Math.max(0, seamHalf - 0.5 * span) * 0.8 - cap; // drop shoulder: further out on the upper arm
      const upper = segLen(S, E);
      const maxLen = shape.sleeve === 'long' ? total * 0.97 : upper * 0.85;
      const Ls = clamp(2 * seamHalf * photoSleeve, upper * 0.25, maxLen) - s0 * 0.5;
      const pointAt = (s: number): { c: V3; d: V3 } => {
        if (s < 0) { const d = norm3(sub3(E, S)); return { c: { x: S.x + d.x * s, y: S.y + d.y * s, z: S.z + d.z * s }, d }; }
        let acc = 0;
        for (let i = 1; i < path.length; i++) {
          const l = segLen(path[i - 1], path[i]);
          if (s <= acc + l || i === path.length - 1) {
            const k = clamp((s - acc) / (l || 1), 0, 1);
            const p = path[i - 1], q = path[i];
            return { c: { x: lerp(p.x, q.x, k), y: lerp(p.y, q.y, k), z: lerp(p.z, q.z, k) }, d: norm3(sub3(q, p)) };
          }
          acc += l;
        }
        return { c: S, d: norm3(sub3(E, S)) };
      };
      const r0 = span * 0.21 * st.sleeveR * fit.width, r1 = (shape.sleeve === 'long' ? 0.1 : 0.16) * span * st.sleeveR * fit.width;
      const endSway = this.sleeveSprings[si].step(pointAt(s0 + Ls).c, dt, 0.1 * Ls);
      const dPhoto = { x: ph.b.x - ph.a.x, y: ph.b.y - ph.a.y }, lp = Math.hypot(dPhoto.x, dPhoto.y) || 1;
      const nPhoto = { x: -dPhoto.y / lp, y: dPhoto.x / lp };
      for (let k = 0; k < NS; k++) {
        const f = k / (NS - 1);
        const { c, d } = pointAt(s0 + Ls * f);
        const cc = { x: c.x + endSway.x * f * f, y: c.y + endSway.y * f * f, z: c.z };
        // Rounded cap over the first quarter, then a straight taper to the opening.
        const r = f < 0.25 ? r0 * (0.6 + 0.4 * Math.sin((f / 0.25) * Math.PI / 2)) : lerp(r0, r1, (f - 0.25) / 0.75);
        let p1 = cross(d, { x: 0, y: 0, z: 1 });
        if (Math.hypot(p1.x, p1.y, p1.z) < 0.2) p1 = { x: u.x, y: u.y, z: 0 }; // arm pointing at the camera
        p1 = norm3(p1);
        const p2 = norm3(cross(d, p1));
        const perp2 = { x: -d.y, y: d.x };
        const pl = Math.hypot(perp2.x, perp2.y) || 1;
        for (let j = 0; j < MS; j++) {
          const phi = (2 * Math.PI * j) / MS;
          const o = { x: p1.x * Math.cos(phi) + p2.x * Math.sin(phi), y: p1.y * Math.cos(phi) + p2.y * Math.sin(phi), z: p1.z * Math.cos(phi) + p2.z * Math.sin(phi) };
          const i = base + k * MS + j;
          setV(i, cc.x + o.x * r, cc.y + o.y * r, cc.z + o.z * r);
          put3(this.normal, i, o);
          put3(this.tanU, i, norm3(cross(o, d)));
          put3(this.tanV, i, d);
          const kk = clamp((o.x * perp2.x + o.y * perp2.y) / pl, -1, 1);
          const along = lerp(0.08, 1, f);
          UV[i * 2] = lerp(ph.a.x, ph.b.x, along) + nPhoto.x * ph.half * kk;
          UV[i * 2 + 1] = lerp(ph.a.y, ph.b.y, along) + nPhoto.y * ph.half * kk;
          UV2[i * 2] = UV[i * 2]; UV2[i * 2 + 1] = UV[i * 2 + 1];
          TEX[i] = 0;
          // Armhole and the side facing the torso are darker.
          const towardBody = -sign * (o.x * u.x + o.y * u.y);
          AO[i] = (k === 0 ? 0.75 : 1) * (1 - 0.25 * Math.max(0, towardBody) * (1 - f));
        }
      }
      if (!this.sleevesVisible) for (let i = base; i < base + NS * MS; i++) setV(i, S.x, S.y, S.z - span); // collapsed, hidden
    });

    const hemRow = (ringBase + NR - 1) * M;
    let hemY = -Infinity;
    for (let j = 0; j < M; j++) hemY = Math.max(hemY, P[(hemRow + j) * 3 + 1]);
    let collarTop = Infinity;
    for (let j = 0; j < M; j++) collarTop = Math.min(collarTop, P[j * 3 + 1]);
    const chestSil = sil.find((x) => x.t === 0.35);
    const kc = Math.round(((0.35 * bodyLen + lift) / L) * (NR - 1));
    const widthRatio = chestSil?.l != null && chestSil.r != null && kc < NR
      ? (2 * a[kc] * proj(depthRatio(kc / (NR - 1)))) / (chestSil.l + chestSil.r) : null;
    this.stats = { hemY, collarFrontY: P[(M / 2) * 3 + 1], collarTopY: collarTop, visibleLengthFrac: vis, aspectK: this.aspectK, widthRatio };
  }
}

function sub3(a: V3, b: V3): V3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function put3(arr: Float32Array, i: number, v: V3) { arr[i * 3] = v.x; arr[i * 3 + 1] = v.y; arr[i * 3 + 2] = v.z; }
