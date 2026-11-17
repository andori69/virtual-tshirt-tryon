/**
 * Shirt mesh built from the product photo (backend `garment_mesh.py`), deformed onto the body every frame.
 *
 * - Two shells share the photo outline: front (+depth) and back (-depth). Closed seams meet at depth 0; the hem,
 *   cuffs and collar stay open. The front shell has a crew opening; through it the inside of the back shows.
 * - Torso: a thin-plate spline maps photo keypoints (shoulder tips, neck points, armpits, hem corners, chest and hem
 *   centre) to targets on the body, in a body-local frame (x across the shoulders, y down the spine, z toward the
 *   viewer). Widths come from the person silhouette x the fit factor and are clamped to it per row.
 * - Sleeves: a rigid rotation + scale per sleeve from the photo's sleeve axis onto the upper arm, blended into the
 *   torso across the armhole by the backend's sleeve weights.
 * - The local frame is turned about the spine by `rig.turn` (yaw, or ~180 degrees when the back faces the camera), so
 *   the real back shell and back photo come round as the customer turns.
 * UVs are the photo coordinates themselves: the print appears as photographed and is never mirrored.
 */
import type { Point } from '../../types';
import { OneEuro } from '../body';
import { SHOULDER_LIFT, type Rig, type V3 } from './rig';
import { Spring, STYLES, type Fit, type ShirtStats, type SleeveKind } from './shirt';

export type PhotoMesh = {
  uv: number[]; depth: number[]; sleeveL: number[]; sleeveR: number[]; boundary: number; open: number[];
  trisFront: number[]; trisBack: number[]; uvBack: number[] | null;
  keypoints: Record<'shoulder_l' | 'shoulder_r' | 'neck_l' | 'neck_r' | 'sleeve_l' | 'sleeve_r' | 'armpit_l' | 'armpit_r'
    | 'hem_l' | 'hem_r' | 'hem_c', [number, number]>;
  neck: { x: number; y: number; halfW: number };
};

/** Shirt width may reach the body width times this, never more. */
export const FIT_FACTOR = { slim: 1.05, regular: 1.12, oversized: 1.25 } as const;
const BODY_DEPTH = 0.6; // body depth / width, to undo the foreshortening of a turned silhouette

/** Thin-plate spline through control points: returns f with f(src[i]) = dst[i], smooth in between. */
export function tps(src: Point[], dst: Point[]): (p: Point) => Point {
  const n = src.length, N = n + 3;
  const U = (dx: number, dy: number) => { const r2 = dx * dx + dy * dy; return r2 < 1e-12 ? 0 : r2 * Math.log(r2); };
  const A: number[][] = Array.from({ length: N }, () => new Array(N + 2).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i][j] = U(src[i].x - src[j].x, src[i].y - src[j].y);
    A[i][n] = A[n][i] = 1;
    A[i][n + 1] = A[n + 1][i] = src[i].x;
    A[i][n + 2] = A[n + 2][i] = src[i].y;
    A[i][N] = dst[i].x;
    A[i][N + 1] = dst[i].y;
  }
  // Gaussian elimination with partial pivoting, both right-hand sides at once.
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c] || 1e-12;
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (f) for (let k = c; k < N + 2; k++) A[r][k] -= f * A[c][k];
    }
  }
  const wx = A.map((row, i) => row[N] / (A[i][i] || 1e-12)), wy = A.map((row, i) => row[N + 1] / (A[i][i] || 1e-12));
  return (q: Point) => {
    let x = wx[n] + wx[n + 1] * q.x + wx[n + 2] * q.y, y = wy[n] + wy[n + 1] * q.x + wy[n + 2] * q.y;
    for (let i = 0; i < n; i++) { const u = U(q.x - src[i].x, q.y - src[i].y); x += wx[i] * u; y += wy[i] * u; }
    return { x, y };
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class PhotoShirt {
  readonly position: Float32Array; readonly normal: Float32Array; readonly uv: Float32Array; readonly uv2: Float32Array;
  readonly tex: Float32Array; readonly ao: Float32Array; readonly tanU: Float32Array; readonly tanV: Float32Array;
  readonly index: Uint32Array;
  stats: ShirtStats = { hemY: 0, collarFrontY: 0, collarTopY: 0, visibleLengthFrac: 1, aspectK: 1, widthRatio: null };
  private n: number;
  private p: Point[];           // photo coords per (single-shell) vertex
  private kp: Record<string, Point>;
  private hemSpring = new Spring();
  private sleeveSprings = [new Spring(), new Spring()];
  private frontSign = 1;
  private pinF = Array.from({ length: 20 }, () => new OneEuro(1.5, 0.01));
  readonly cull: 'front' | 'back';
  readonly mid: { position: Float32Array; index: Uint32Array };
  readonly collar: { x: number; y: number; halfW: number };
  private lx: Float32Array; private ly: Float32Array; private lz: Float32Array; private clamped: Uint8Array;
  private nbrs: number[][];
  private ao0: Float32Array; // static AO (armpits, seams) before the per-frame fold shading
  private t = 0;
  /** Display-space body pins and the shirt keypoints pinned to them (for the debug overlay). */
  debug: { pins: Point[]; keys: Point[] } = { pins: [], keys: [] };

  constructor(private mesh: PhotoMesh, private sleeve: SleeveKind = 'short') {
    const n = (this.n = mesh.uv.length / 2);
    this.p = Array.from({ length: n }, (_, i) => ({ x: mesh.uv[2 * i], y: mesh.uv[2 * i + 1] }));
    this.kp = Object.fromEntries(Object.entries(mesh.keypoints).map(([k, v]) => [k, { x: v[0], y: v[1] }]));
    const N = 2 * n;
    this.position = new Float32Array(N * 3); this.normal = new Float32Array(N * 3);
    this.uv = new Float32Array(N * 2); this.uv2 = new Float32Array(N * 2); this.tex = new Float32Array(N);
    this.ao = new Float32Array(N); this.tanU = new Float32Array(N * 3); this.tanV = new Float32Array(N * 3);
    const back = mesh.uvBack;
    const dMax = Math.max(...mesh.depth) || 1;
    for (let i = 0; i < n; i++) for (const s of [0, 1]) {
      const j = i + s * n;
      this.uv[2 * j] = mesh.uv[2 * i]; this.uv[2 * j + 1] = mesh.uv[2 * i + 1];
      this.uv2[2 * j] = back ? back[2 * i] : mesh.uv[2 * i]; this.uv2[2 * j + 1] = back ? back[2 * i + 1] : mesh.uv[2 * i + 1];
      this.tex[j] = s;
      // AO: darker in the armpits and where the shells close at the seams.
      const pit = Math.max(...['armpit_l', 'armpit_r'].map((k) => Math.exp(-((this.p[i].x - this.kp[k].x) ** 2 + (this.p[i].y - this.kp[k].y) ** 2) / 0.004)));
      this.ao[j] = (1 - 0.35 * pit) * (0.86 + 0.14 * Math.min(1, mesh.depth[i] / (0.35 * dMax)));
    }
    this.ao0 = Float32Array.from(this.ao);
    const tb = mesh.trisBack;
    this.index = new Uint32Array(mesh.trisFront.length + tb.length);
    this.index.set(mesh.trisFront);
    for (let k = 0; k < tb.length; k += 3) { // back shell, reversed winding
      this.index[mesh.trisFront.length + k] = tb[k] + n;
      this.index[mesh.trisFront.length + k + 1] = tb[k + 2] + n;
      this.index[mesh.trisFront.length + k + 2] = tb[k + 1] + n;
    }
    // Which way the front shell's winding faces (photo y points down): fix normals to face the viewer.
    let z = 0;
    const tf = mesh.trisFront;
    for (let k = 0; k < tf.length; k += 3) {
      const [a, b, c] = [this.p[tf[k]], this.p[tf[k + 1]], this.p[tf[k + 2]]];
      z += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    this.frontSign = z >= 0 ? 1 : -1;
    // Screen y points down, so a positive photo-space winding is clockwise on screen: three.js's back side.
    this.cull = this.frontSign < 0 ? 'front' : 'back';
    this.collar = mesh.neck;
    this.lx = new Float32Array(n); this.ly = new Float32Array(n); this.lz = new Float32Array(n); this.clamped = new Uint8Array(n);
    const sets = Array.from({ length: n }, () => new Set<number>());
    for (let k = 0; k < tb.length; k += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      sets[tb[k + a]].add(tb[k + b]); sets[tb[k + b]].add(tb[k + a]);
    }
    this.nbrs = sets.map((x) => [...x]);
    // Mid-surface (depth 0, between the shells), slightly behind the front shell's closed seams.
    this.mid = { position: new Float32Array(n * 3), index: Uint32Array.from(tb) };
  }

  reset() {
    this.hemSpring.reset();
    this.sleeveSprings.forEach((s) => s.reset());
    this.pinF.forEach((f) => f.reset());
  }

  update(rig: Rig, fit: Fit, dtMs: number) {
    const { u, down, span } = rig;
    const st = STYLES[fit.style];
    const factor = FIT_FACTOR[fit.style] * fit.width;
    const psi = rig.turn, cosT = Math.cos(psi), sinT = Math.sin(psi);
    const dt = clamp(dtMs / 1000, 0.001, 0.05);
    const O = rig.top;
    const lift = span * SHOULDER_LIFT;
    const bodyLen = Math.hypot(rig.hip.x - O.x, rig.hip.y - O.y);
    // Tilted shoulders make u and the spine non-perpendicular: solve q - O = u*x + down*y exactly.
    const det = u.x * down.y - u.y * down.x || 1e-9;
    const toLocal = (q: V3) => { // display -> body-local (undo the turn)
      const dx = q.x - O.x, dy = q.y - O.y;
      const x = (dx * down.y - dy * down.x) / det, y = (u.x * dy - u.y * dx) / det, zz = q.z - O.z;
      return { x: x * cosT + zz * sinT, y, z: -x * sinT + zz * cosT };
    };

    // Body half-width (true, local px) at a fraction t of shoulder-joints -> hips, from the silhouette x fit factor.
    const proj = Math.sqrt(cosT * cosT + BODY_DEPTH * BODY_DEPTH * sinT * sinT);
    const bodyHalf = (t: number): { v: number; measured: boolean } => {
      const s = rig.silhouette;
      const near = s.filter((r) => r.l != null && r.r != null).sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
      const heur = span * (t < 0.5 ? lerp(0.56, 0.5, clamp(t, 0, 0.5) / 0.5) : lerp(0.5, 0.55, (t - 0.5) / 0.5));
      if (near && Math.abs(near.t - t) < 0.2) return { v: clamp((near.l! + near.r!) / 2 / proj, span * 0.38, span * 0.8), measured: true };
      return { v: heur, measured: false };
    };

    // Pins (body-local): shoulder tips on top of the shoulders (above the landmarks), neck base above their midpoint, armpits
    // 35% of the way down to the hips, hem corners at hip level. Scale and tilt follow from the shoulder pins.
    const K = this.kp;
    const shL = toLocal(rig.shoulderTop.L), shR = toLocal(rig.shoulderTop.R);
    const [pinSL, pinSR] = shL.x <= shR.x ? [shL, shR] : [shR, shL];
    const seamHalfPhoto = (K.shoulder_r.x - K.shoulder_l.x) / 2;
    const seamHalf = Math.max(span * 0.3, (pinSR.x - pinSL.x) / 2);
    const scale = seamHalf / seamHalfPhoto; // px per photo unit
    const yS = (pinSL.y + pinSR.y) / 2;
    const neckL = toLocal(rig.neck);
    const yN = neckL.y;
    // Collar hugs the neck: neck points at the measured neck width plus a little ease (not the photo's proportions).
    const neckHalf = rig.neckHalf * 1.15;
    const joint = Math.max(span * 0.5, bodyLen - lift); // shoulder joints -> hips
    const yA = yS + 0.35 * joint;
    const pit = bodyHalf(0.35), hip = bodyHalf(0.95);
    const armHalf = clamp(((K.armpit_r.x - K.armpit_l.x) / 2) * scale, pit.v, pit.v * factor);
    const hemHalf = clamp(((K.hem_r.x - K.hem_l.x) / 2) * scale, hip.v, hip.v * factor);
    const lenFull = joint * st.len * fit.length;
    let yH = yS + lenFull;
    // Hem stays inside the frame (rows below are pulled up rather than drawn off-screen).
    if (down.y > 0.05) yH = Math.min(yH, (rig.H - 2 - O.y) / down.y - Math.abs(u.y) * hemHalf);
    const sway = this.hemSpring.step({ x: 0, y: yH }, dt, 0.1 * lenFull);
    const src = [K.shoulder_l, K.shoulder_r, K.neck_l, K.neck_r, K.armpit_l, K.armpit_r, K.hem_l, K.hem_r, K.hem_c,
      { x: (K.armpit_l.x + K.armpit_r.x) / 2, y: (K.armpit_l.y + K.armpit_r.y) / 2 }];
    const raw = [
      { x: pinSL.x, y: pinSL.y }, { x: pinSR.x, y: pinSR.y }, { x: neckL.x - neckHalf, y: yN }, { x: neckL.x + neckHalf, y: yN },
      { x: -armHalf, y: yA }, { x: armHalf, y: yA },
      { x: -hemHalf + sway.x, y: yH + sway.y }, { x: hemHalf + sway.x, y: yH + sway.y }, { x: sway.x, y: yH + sway.y },
      { x: 0, y: yA },
    ];
    // One Euro on every pin: steady when still, little lag when moving.
    this.t += Math.max(1, dtMs);
    const dst = raw.map((q, i) => ({ x: this.pinF[2 * i].filter(q.x, this.t), y: this.pinF[2 * i + 1].filter(q.y, this.t) }));
    const torso = tps(src, dst);
    const halfLimit = (y: number) => {
      if (y <= yA) return lerp(seamHalf, armHalf, clamp((y - yS) / (yA - yS || 1), 0, 1)) + span * 0.02;
      const t = clamp((y - lift) / bodyLen, 0, 1);
      return Math.min(lerp(armHalf, hemHalf, clamp((y - yA) / (yH - yA || 1), 0, 1)), bodyHalf(t).v * factor) + span * 0.01;
    };

    // Sleeves: which body arm hangs on each local side (they swap sides when the back faces the camera).
    const arms = [rig.arms.L, rig.arms.R].map((a) => ({ s: toLocal(a.shoulder), e: a.elbow ? toLocal(a.elbow) : null }));
    const leftArm = arms[0].s.x <= arms[1].s.x ? arms[0] : arms[1], rightArm = leftArm === arms[0] ? arms[1] : arms[0];
    const sleeveXf = ([sh, tip, pit, arm, pin, side, si]: [Point, Point, Point, typeof arms[0], Point, -1 | 1, number]) => {
      const a = { x: tip.x - sh.x, y: tip.y - sh.y }, la = Math.hypot(a.x, a.y) || 1;
      const ah = { x: a.x / la, y: a.y / la }, an = { x: -ah.y, y: ah.x };
      const upper = arm.e ? Math.hypot(arm.e.x - arm.s.x, arm.e.y - arm.s.y) : span * 0.75;
      const dir = arm.e && upper > span * 0.2 ? { x: (arm.e.x - arm.s.x) / upper, y: (arm.e.y - arm.s.y) / upper } : { x: side * 0.35, y: 0.94 };
      const nrm = { x: -dir.y, y: dir.x };
      // shortcut: long sleeves stay straight along the upper arm (no elbow bend); bend them if long sleeves get stocked
      const len = clamp(la * scale, upper * 0.25, (this.sleeve === 'long' ? 1.9 : 0.85) * upper);
      const k = len / la;
      // Sleeve width capped to an upper arm plus ease, so a wide photographed sleeve can't fly out past the body.
      const pitPerp = (pit.x - sh.x) * an.x + (pit.y - sh.y) * an.y; // signed: which side of the axis the sleeve lies
      const photoW = Math.abs(pitPerp) || la;
      const kPerp = Math.min(k, (0.34 * span * factor) / photoW);
      const lag = this.sleeveSprings[si].step({ x: pin.x + dir.x * len, y: pin.y + dir.y * len }, dt, 0.1 * len); // offset
      const zArm = arm.e ? arm.e.z - arm.s.z : 0;
      return (q: Point) => {
        const dx = q.x - sh.x, dy = q.y - sh.y;
        // The photo's sleeve axis runs along its top edge; centre the sleeve on the arm instead (half its width out).
        const along = dx * ah.x + dy * ah.y, perp = dx * an.x + dy * an.y - pitPerp / 2, f = clamp(along / la, 0, 1);
        const sw = { x: lag.x * f * f, y: lag.y * f * f };
        return {
          x: pin.x + dir.x * along * k + nrm.x * perp * kPerp + sw.x,
          y: pin.y + dir.y * along * k + nrm.y * perp * kPerp + sw.y,
          z: zArm * f,
        };
      };
    };
    const sl = sleeveXf([K.shoulder_l, K.sleeve_l, K.armpit_l, leftArm, dst[0], -1, 0]);
    const sr = sleeveXf([K.shoulder_r, K.sleeve_r, K.armpit_r, rightArm, dst[1], 1, 1]);

    // Vertices: local position per photo point (torso TPS, width clamp, sleeves), then both shells, turned about the
    // spine and placed on screen.
    const P = this.position, n = this.n, M = this.mesh;
    const lx = this.lx, ly = this.ly, lz = this.lz, clamped = this.clamped;
    for (let i = 0; i < n; i++) {
      const q = this.p[i];
      let { x, y } = torso(q);
      const lim = halfLimit(y);
      clamped[i] = Math.abs(x) > lim ? 1 : 0;
      x = clamp(x, -lim, lim);
      let zOff = 0;
      const wl = M.sleeveL[i], wr = M.sleeveR[i];
      if (wl > 0) { const v = sl(q); x = lerp(x, v.x, wl); y = lerp(y, v.y, wl); zOff = v.z * wl; }
      if (wr > 0) { const v = sr(q); x = lerp(x, v.x, wr); y = lerp(y, v.y, wr); zOff = v.z * wr; }
      lx[i] = x; ly[i] = y; lz[i] = zOff;
    }
    // Width clamps squash a band of triangles at the edge; relax clamped vertices and their neighbours toward the
    // average of their neighbours (twice), then clamp again, so no triangle is stretched or folded.
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < n; i++) {
        const nb = this.nbrs[i];
        if (!nb.length || !(clamped[i] || nb.some((j) => clamped[j])) || M.sleeveL[i] > 0.5 || M.sleeveR[i] > 0.5) continue;
        let sx = 0, sy = 0;
        for (const j of nb) { sx += lx[j]; sy += ly[j]; }
        lx[i] = 0.5 * lx[i] + 0.5 * (sx / nb.length);
        ly[i] = 0.5 * ly[i] + 0.5 * (sy / nb.length);
        const lim = halfLimit(ly[i]);
        lx[i] = clamp(lx[i], -lim, lim);
      }
    }
    let hemY = -Infinity, topY = Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < n; i++) {
      const q = this.p[i], x = lx[i], y = ly[i];
      // Sleeves wrap the upper arm: keep the shells at least an arm's radius apart there, so the arm (and its
      // depth occluder) sits inside the sleeve instead of poking through it.
      const d = Math.max(M.depth[i] * scale, Math.max(M.sleeveL[i], M.sleeveR[i]) * span * 0.11);
      { // mid-surface vertex: a hair behind centre so the front shell's seam edge isn't hidden
        const zl = lz[i] - span * 0.02, xr = x * cosT - zl * sinT, zr = x * sinT + zl * cosT;
        this.mid.position[i * 3] = O.x + u.x * xr + down.x * y;
        this.mid.position[i * 3 + 1] = Math.min(O.y + u.y * xr + down.y * y, rig.H - 1);
        this.mid.position[i * 3 + 2] = O.z + zr;
      }
      for (const s of [0, 1]) {
        const zl = (s ? -d : d) + lz[i];
        const xr = x * cosT - zl * sinT, zr = x * sinT + zl * cosT;
        const j = (i + s * n) * 3;
        P[j] = O.x + u.x * xr + down.x * y;
        P[j + 1] = Math.min(O.y + u.y * xr + down.y * y, rig.H - 1);
        P[j + 2] = O.z + zr;
        if (q.y > K.hem_c.y - 0.03) hemY = Math.max(hemY, P[j + 1]);
        topY = Math.min(topY, P[j + 1]);
        minX = Math.min(minX, P[j]); maxX = Math.max(maxX, P[j]);
      }
    }
    this.computeNormals();

    // Debug: body pins and where the shirt's keypoints actually landed (after width clamps and sleeve transforms).
    const toScreen = (q: Point) => ({ x: O.x + u.x * q.x * cosT + down.x * q.y, y: O.y + u.y * q.x * cosT + down.y * q.y });
    const keyAt = (q: Point) => { const t = torso(q), l = halfLimit(t.y); return toScreen({ x: clamp(t.x, -l, l), y: t.y }); };
    this.debug = {
      pins: [...dst.slice(0, 9).map(toScreen), toScreen(sl(K.sleeve_l)), toScreen(sr(K.sleeve_r))],
      keys: [...src.slice(0, 9).map(keyAt), toScreen(sl(K.sleeve_l)), toScreen(sr(K.sleeve_r))],
    };
    const front = torso({ x: M.neck.x, y: M.neck.y + 0.85 * M.neck.halfW });
    const fx = front.x * cosT, fy = front.y;
    this.stats = {
      hemY, collarTopY: topY, collarFrontY: O.y + u.y * fx + down.y * fy,
      visibleLengthFrac: (yH - yS) / lenFull, aspectK: 1,
      widthRatio: pit.measured ? armHalf / pit.v : null,
      minX, maxX,
      // A body is ~0.5-0.56 shoulder spans per side at the chest; a mask much wider than that is a bulky top.
      bulky: pit.measured && pit.v > span * 0.66,
    };
  }

  /** Area-weighted normals per shell, smoothed across the closed seams; tangents from the photo UV gradient. */
  private computeNormals() {
    const P = this.position, Nn = this.normal, Tu = this.tanU, Tv = this.tanV, UV = this.uv, idx = this.index;
    Nn.fill(0); Tu.fill(0); Tv.fill(0);
    for (let k = 0; k < idx.length; k += 3) {
      const a = idx[k], b = idx[k + 1], c = idx[k + 2];
      const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
      const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const du1 = UV[b * 2] - UV[a * 2], dv1 = UV[b * 2 + 1] - UV[a * 2 + 1], du2 = UV[c * 2] - UV[a * 2], dv2 = UV[c * 2 + 1] - UV[a * 2 + 1];
      const r = du1 * dv2 - du2 * dv1 || 1e-9;
      for (const v of [a, b, c]) {
        Nn[v * 3] += nx; Nn[v * 3 + 1] += ny; Nn[v * 3 + 2] += nz;
        for (let m = 0; m < 3; m++) {
          Tu[v * 3 + m] += (e1[m] * dv2 - e2[m] * dv1) / r;
          Tv[v * 3 + m] += (e2[m] * du1 - e1[m] * du2) / r;
        }
      }
    }
    const n = this.n, nb = this.mesh.boundary, open = this.mesh.open;
    // Orientation: photo winding sign -> front normals face the viewer; the back shell's reversed winding faces away.
    const s0 = this.frontSign;
    for (let i = 0; i < 6 * n; i++) Nn[i] *= s0;
    for (let i = 0; i < nb; i++) {
      // Closed seam where the shells actually meet: one smooth normal shared by both. Not on sleeves, whose shells
      // are held apart around the arm.
      if (open[i] || this.mesh.sleeveL[i] > 0.2 || this.mesh.sleeveR[i] > 0.2) continue;
      for (let m = 0; m < 3; m++) {
        const avg = Nn[i * 3 + m] + Nn[(i + n) * 3 + m];
        Nn[i * 3 + m] = Nn[(i + n) * 3 + m] = avg;
      }
    }
    for (let i = 0; i < 2 * n; i++) {
      const j = i * 3;
      const l = Math.hypot(Nn[j], Nn[j + 1], Nn[j + 2]) || 1;
      Nn[j] /= l; Nn[j + 1] /= l; Nn[j + 2] /= l;
      // Soft folds: drag lines from the armpits and bunching at the waist sides (normal perturbation only).
      const q = this.p[i % n], f = this.fold(q), e = 0.004;
      // Fold valleys sit in shadow and ridges catch light: under frontal light that, not the normal tilt, is what
      // makes folds readable.
      this.ao[i] = this.ao0[i] * (1 + 0.14 * f);
      const gu = (this.fold({ x: q.x + e, y: q.y }) - f) / e, gv = (this.fold({ x: q.x, y: q.y + e }) - f) / e;
      for (const T of [Tu, Tv]) {
        const tl = Math.hypot(T[j], T[j + 1], T[j + 2]) || 1;
        T[j] /= tl; T[j + 1] /= tl; T[j + 2] /= tl;
      }
      const k = 0.0055;
      const x = Nn[j] - k * (gu * Tu[j] + gv * Tv[j]), y = Nn[j + 1] - k * (gu * Tu[j + 1] + gv * Tv[j + 1]), z = Nn[j + 2] - k * (gu * Tu[j + 2] + gv * Tv[j + 2]);
      const l2 = Math.hypot(x, y, z) || 1;
      Nn[j] = x / l2; Nn[j + 1] = y / l2; Nn[j + 2] = z / l2;
    }
  }

  private fold(q: Point): number {
    // Soft fabric folds as a height field in photo space (normal perturbation only): broad diagonal drag folds from
    // each armpit toward the chest, gravity drape hanging from the chest, and bunching at the waist sides.
    const K = this.kp;
    let h = 0;
    for (const [pit, side] of [[K.armpit_l, 1], [K.armpit_r, -1]] as const) {
      const dx = q.x - pit.x, dy = q.y - pit.y, w = Math.exp(-(dx * dx + dy * dy) / 0.02);
      h += w * Math.sin(2 * Math.PI * 9 * (dx * 0.5 * side + dy * 0.85));
    }
    const top = (K.armpit_l.y + K.armpit_r.y) / 2, cx = (K.hem_l.x + K.hem_r.x) / 2, half = (K.hem_r.x - K.hem_l.x) / 2 || 1;
    const u = (q.x - cx) / half;
    h += 0.7 * smooth(top - 0.05, top + 0.2, q.y) * Math.sin(2 * Math.PI * (u * 2.6 + 0.15 * Math.sin(q.y * 9)));
    h += 0.6 * smooth(top + 0.15, K.hem_c.y, q.y) * u * u * Math.sin(2 * Math.PI * (q.y * 7 + 0.4 * Math.sin(q.x * 11)));
    return h;
  }

}
