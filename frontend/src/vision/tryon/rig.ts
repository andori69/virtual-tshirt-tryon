/**
 * Body rig for the 3D shirt, in DISPLAY space: the selfie view is mirrored, so x is flipped (x_display = W - x_video).
 * Only the video is mirrored on screen; the shirt is built directly in display space so its texture is never flipped.
 *
 * Units are video pixels. z points toward the viewer and uses the same pixel scale as x/y (from MediaPipe world
 * landmarks), with 0 at the shoulder midpoint.
 */
import type { Point } from '../../types';
import { LM, OneEuro } from '../body';
import { headEllipse } from '../render';

export type V3 = { x: number; y: number; z: number };
export type World = { x: number; y: number; z: number; visibility?: number }[];

export const HAND = { lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lThumb: 21, rThumb: 22 } as const;

/** `front`: the wrist is clearly in front of the chest (world depth), so forearm and hand draw over the shirt. */
export type Arm = { shoulder: V3; elbow: V3 | null; wrist: V3 | null; hand: V3[]; front: boolean };

export type Rig = {
  W: number; H: number;
  sL: V3; sR: V3;               // shoulder joints, display-left / display-right
  u: Point;                     // unit shoulder direction on screen (display-left -> right)
  down: Point;                  // unit spine direction on screen (shoulders -> hips)
  span: number;                 // 3D shoulder-joint distance in px (screen span corrected for turn)
  yaw: number;                  // torso turn, radians; + = display-right shoulder toward the viewer
  facing: 'front' | 'back';     // from face visibility, with hysteresis
  turn: number;                 // smoothed rotation for the shirt: yaw when facing, ~pi when the back faces the camera
  top: V3;                      // shoulder-line centre at the top of the shoulders
  hip: V3;                      // hip centre (measured, or estimated from shoulder width)
  hipsVisible: boolean;
  neck: V3;                     // collar ring centre at the base of the neck
  chinY: number | null;
  head: { center: Point; rx: number; ry: number; chinY: number } | null;
  arms: { L: Arm; R: Arm };
  /** Top of each shoulder (display-left/right): where the person mask ends straight above the shoulder joint. The
   *  shirt's shoulder seam sits here; MediaPipe's shoulder landmarks are the joints, well inside the body. */
  shoulderTop: { L: V3; R: V3 };
  neckHalf: number;             // half-width of the neck (px), from the mask just above the neck base
  /** Body silhouette half-widths across the torso (screen px, along u), t = 0 shoulder line .. 1 hips. */
  silhouette: { t: number; l: number | null; r: number | null }[];
};

/** Mask half-width sampler: distances from `c` to the person edge along -dir / +dir, each side stopped at its cap. */
export type SilhouetteFn = (c: Point, dir: Point, caps: [number, number]) => [number | null, number | null];

export const SILHOUETTE_T = [0.2, 0.35, 0.5, 0.65, 0.8, 0.95];
export const SHOULDER_LIFT = 0.11;  // landmarks are shoulder joints; the shirt's shoulder line sits this far above them
export const TORSO_PER_SPAN = 1.4;
// Wrist this much closer to the camera than the shoulders counts as in front of the shirt. Looser values let hands
// behind the back (whose depth MediaPipe guesses) punch holes in the shirt.
const HAND_FRONT_M = 0.06;
const NOSE_BEHIND_M = 0.03;
const SHOULDER_TOP_FALLBACK = 0.12; // joint -> top of shoulder, in shoulder spans, when the mask can't tell
const FLIP_FRAMES = 6;   // consecutive frames with/without a visible face before front/back switches (no flicker)
const TURN_OMEGA = 12;   // turn smoothing rate (1/s)  // shoulder-to-hip length ~ 1.4 x shoulder-joint span (adult average)
const COS_MIN = 0.45;              // beyond ~63 degrees of turn the shoulder span stops being a usable scale

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Point) => Math.hypot(a.x, a.y);
const unit = (a: Point): Point => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };

/**
 * Builds the rig from smoothed video-pixel landmarks. Stateful only for yaw smoothing and silhouette averaging, so
 * one instance lives per camera session.
 */
export class RigBuilder {
  private yawF = new OneEuro(1.0, 0.02);
  private facing: 'front' | 'back' = 'front';
  private flip = 0;
  private turn: number | null = null;
  private lastT = 0;
  private sil: { l: number | null; r: number | null }[] = SILHOUETTE_T.map(() => ({ l: null, r: null }));
  private topUp: [number | null, number | null] = [null, null];
  private neckHalf: number | null = null;

  reset() {
    this.yawF.reset();
    this.facing = 'front';
    this.flip = 0;
    this.turn = null;
    this.sil = SILHOUETTE_T.map(() => ({ l: null, r: null }));
    this.topUp = [null, null];
    this.neckHalf = null;
  }

  build(pts: Map<number, Point | null>, world: World | null, W: number, H: number, tMs: number, silhouette: SilhouetteFn | null): Rig | null {
    const m = (p: Point | null | undefined): Point | null => (p ? { x: W - p.x, y: p.y } : null);
    const a = m(pts.get(LM.lShoulder)), b = m(pts.get(LM.rShoulder));
    if (!a || !b) return null;
    // Landmark index on each display side (the person's own left/right swap places when mirrored).
    const leftIs11 = a.x <= b.x;
    const idx = (l: number, r: number) => (leftIs11 ? [l, r] : [r, l]) as [number, number];
    const [iSL, iSR] = idx(LM.lShoulder, LM.rShoulder);
    const sL2 = leftIs11 ? a : b, sR2 = leftIs11 ? b : a;
    const span2 = len(sub(sR2, sL2));
    if (span2 < 8) return null;

    // World landmarks (metres, hip-centred, z away from camera) -> px with z toward the viewer.
    let pxPerM = 0, zOf = (_i: number) => 0;
    let yawRaw = 0;
    if (world && world[iSL] && world[iSR]) {
      const wl = world[iSL], wr = world[iSR];
      pxPerM = span2 / (Math.hypot(wr.x - wl.x, wr.y - wl.y) || 1);
      const z0 = (wl.z + wr.z) / 2;
      zOf = (i: number) => (world[i] ? -(world[i].z - z0) * pxPerM : 0);
      // Turn = depth difference between the display-right and display-left shoulder (toward the viewer is +).
      yawRaw = Math.atan2(-(wr.z - wl.z), Math.abs(wr.x - wl.x));
    }
    const mid = { x: (sL2.x + sR2.x) / 2, y: (sL2.y + sR2.y) / 2 };
    const [iHL, iHR] = idx(LM.lHip, LM.rHip);
    const hL = m(pts.get(iHL)), hR = m(pts.get(iHR));
    const inFrame = (p: Point | null) => !!p && p.y < H * 0.98 && p.x > 0 && p.x < W;
    const hipsVisible = inFrame(hL) && inFrame(hR);
    const torso2 = hipsVisible ? len(sub({ x: (hL!.x + hR!.x) / 2, y: (hL!.y + hR!.y) / 2 }, mid)) : 0;

    // Turn: world depth works up to ~45 degrees; beyond, the shoulders' 2D span against torso length is the better
    // measure (in profile the span collapses). Sign from world depth.
    // Size reference for a frontal shoulder span: torso length, or (hips out of frame) nose-to-shoulders distance.
    const noseP = m(pts.get(LM.nose));
    const headRef = noseP ? len(sub(noseP, mid)) * 1.8 : 0;
    const frontalSpan = torso2 ? torso2 / TORSO_PER_SPAN : headRef;
    const geom = frontalSpan ? Math.acos(Math.min(1, span2 / frontalSpan)) : 0;
    const profile = geom > 0.9;
    const yawMag = profile ? Math.max(Math.abs(yawRaw), geom) : Math.abs(yawRaw);
    const yaw = Math.max(-1.5, Math.min(1.5, this.yawF.filter((yawRaw < 0 ? -1 : 1) * yawMag, tMs)));
    // Body scale: shoulder span corrected for the turn, or from the torso length when the shoulders overlap.
    const span = profile ? frontalSpan : span2 / Math.max(COS_MIN, Math.cos(yaw));
    const v3 = (p: Point, i: number): V3 => ({ x: p.x, y: p.y, z: zOf(i) });
    const sL = v3(sL2, iSL), sR = v3(sR2, iSR);
    // In profile the two shoulder points nearly coincide; take the across-body direction from the spine instead.
    const spineDir = hipsVisible ? unit(sub({ x: (hL!.x + hR!.x) / 2, y: (hL!.y + hR!.y) / 2 }, mid)) : { x: 0, y: 1 };
    const u = profile ? { x: spineDir.y, y: -spineDir.x } : unit(sub(sR2, sL2));

    // Hips: both visible and inside the frame, else estimated straight down the body from the shoulder width.
    const perp = { x: -u.y, y: u.x }; // u rotated +90 degrees: points down when shoulders are level
    let hip2: Point, hipZ = 0;
    if (hipsVisible) {
      hip2 = { x: (hL!.x + hR!.x) / 2, y: (hL!.y + hR!.y) / 2 };
      hipZ = (zOf(iHL) + zOf(iHR)) / 2;
    } else {
      hip2 = { x: mid.x + perp.x * span * TORSO_PER_SPAN, y: mid.y + perp.y * span * TORSO_PER_SPAN };
    }
    const down = unit(sub(hip2, mid));
    const lift = span * SHOULDER_LIFT;
    const top: V3 = { x: mid.x - down.x * lift, y: mid.y - down.y * lift, z: 0 };

    // Head and chin (display space). The collar ring must stay below the chin.
    const P = (i: number) => m(pts.get(i));
    const nose = P(LM.nose);
    const le = P(LM.leftEye), re = P(LM.rightEye), ml = P(LM.mouthL), mr = P(LM.mouthR);
    const head = nose ? headEllipse({
      nose,
      eyes: le && re ? { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 } : null,
      mouth: ml && mr ? { x: (ml.x + mr.x) / 2, y: (ml.y + mr.y) / 2 } : null,
      ears: [P(LM.leftEar), P(LM.rightEar)],
    }, span2) : null;
    const chinY = head?.chinY ?? null;
    // Neck base: shoulder midpoint raised 0.25 x shoulder width toward the ears, set back from the chest.
    let neck: V3 = { x: mid.x - down.x * span * 0.25, y: mid.y - down.y * span * 0.25, z: -span * 0.06 };
    if (chinY != null) {
      // Top of the front rib band (neck.y + 0.07 span dip - 0.035 span band) at least 0.02 span below the chin.
      const minY = chinY - span * 0.015;
      if (neck.y < minY) neck = { ...neck, y: minY };
    }

    const arm = (iE: number, iW: number, hand: number[], s: V3): Arm => {
      const e = P(iE), w = P(iW);
      const visible = (world?.[iW]?.visibility ?? 1) >= 0.5;
      return {
        shoulder: s,
        elbow: e ? v3(e, iE) : null,
        wrist: w ? v3(w, iW) : null,
        hand: hand.flatMap((i) => { const p = P(i); return p ? [v3(p, i)] : []; }),
        front: !!w && pxPerM > 0 && visible && zOf(iW) > HAND_FRONT_M * pxPerM,
      };
    };
    const [iEL, iER] = idx(LM.lElbow, LM.rElbow), [iWL, iWR] = idx(LM.lWrist, LM.rWrist);
    const [pL, pR] = idx(HAND.lPinky, HAND.rPinky), [xL, xR] = idx(HAND.lIndex, HAND.rIndex), [tL, tR] = idx(HAND.lThumb, HAND.rThumb);
    const arms = { L: arm(iEL, iWL, [pL, xL, tL], sL), R: arm(iER, iWR, [pR, xR, tR], sR) };

    // Silhouette half-widths, each side capped at its own elbow/wrist so a resting arm isn't taken for torso.
    const cosY = Math.max(COS_MIN, Math.cos(yaw));
    // Shoulder tops: walk up (toward the ears) from each joint until the mask ends; EMA-smoothed like the widths.
    const top3 = (s: V3, i: 0 | 1): V3 => {
      let d: number | null = null;
      if (silhouette) d = silhouette(s, down, [span * 0.5, 1])[0];
      if (d == null || d < span * 0.04) d = this.topUp[i] ?? span * SHOULDER_TOP_FALLBACK;
      this.topUp[i] = this.topUp[i] == null ? d : this.topUp[i]! * 0.75 + d * 0.25;
      const up = this.topUp[i]!;
      return { x: s.x - down.x * up, y: s.y - down.y * up, z: s.z };
    };
    const shoulderTop = { L: top3(sL, 0), R: top3(sR, 1) };
    // Neck width: across the mask a little above the neck base (collar level), clamped to human proportions.
    let nh: number | null = null;
    if (silhouette) {
      const c = { x: neck.x - down.x * span * 0.08, y: neck.y - down.y * span * 0.08 };
      const [l, r] = silhouette(c, u, [span * 0.3, span * 0.3]);
      if (l != null && r != null) nh = (l + r) / 2;
    }
    nh = Math.min(span * 0.22, Math.max(span * 0.12, nh ?? this.neckHalf ?? span * 0.15));
    this.neckHalf = this.neckHalf == null ? nh : this.neckHalf * 0.8 + nh * 0.2;
    const silOut = SILHOUETTE_T.map((t, i) => {
      const c = { x: mid.x + (hip2.x - mid.x) * t, y: mid.y + (hip2.y - mid.y) * t };
      let l: number | null = null, r: number | null = null;
      if (silhouette) {
        // Where the arm crosses this row (or, failing that, how far out the elbow/wrist are), minus the arm's own width.
        const lat = (p: Point) => (p.x - c.x) * u.x + (p.y - c.y) * u.y;
        const along = (p: Point) => (p.x - c.x) * down.x + (p.y - c.y) * down.y;
        const cap = (sign: -1 | 1, a: Arm) => {
          const pts = [a.shoulder, a.elbow, a.wrist].filter((p): p is V3 => !!p);
          const d: number[] = [];
          for (let k = 1; k < pts.length; k++) {
            const da = along(pts[k - 1]), db = along(pts[k]);
            if (da * db <= 0 && da !== db) {
              const f = da / (da - db);
              d.push(sign * lat({ x: pts[k - 1].x + (pts[k].x - pts[k - 1].x) * f, y: pts[k - 1].y + (pts[k].y - pts[k - 1].y) * f }) - span * 0.06);
            }
          }
          if (!d.length) d.push(...pts.slice(1).map((p) => sign * lat(p)));
          return Math.min(span * 0.8, ...d.filter((v) => v > span * 0.15));
        };
        [l, r] = silhouette(c, u, [cap(-1, arms.L), cap(1, arms.R)]);
        // A torso half is 0.3-0.8 shoulder spans wide (projected); anything else is a merged arm or a bad mask.
        const ok = (d: number | null) => (d != null && d > span * cosY * 0.3 && d < span * 0.8 ? d : null);
        l = ok(l);
        r = ok(r);
      }
      const prev = this.sil[i];
      const ema = (p0: number | null, v: number | null) => (v == null ? p0 : p0 == null ? v : p0 * 0.75 + v * 0.25);
      this.sil[i] = { l: ema(prev.l, l), r: ema(prev.r, r) };
      return { t, ...this.sil[i] };
    });

    // Front/back: the face is gone, or (MediaPipe often still reports a face from behind) the nose sits behind the
    // shoulders in world depth. Measured on photos: facing the camera the nose is >= 12 cm in front; from behind,
    // half the photos put it 5-22 cm behind. Hysteresis stops flicker at the boundary.
    // Only trusted with the shoulders square to the camera: in profile, nose depth vs the shoulder midpoint means little.
    const square = !frontalSpan || span2 / frontalSpan > 0.63;
    const noseBehind = square && !!world?.[LM.nose] && !!world[iSL] && !!world[iSR]
      && world[LM.nose].z - (world[iSL].z + world[iSR].z) / 2 > NOSE_BEHIND_M;
    const faceSeen = !!(pts.get(LM.nose) && (pts.get(LM.leftEye) || pts.get(LM.rightEye))) && !noseBehind;
    if ((this.facing === 'front') !== faceSeen) {
      if (++this.flip >= FLIP_FRAMES) { this.facing = faceSeen ? 'front' : 'back'; this.flip = 0; }
    } else this.flip = 0;
    const target = this.facing === 'front' ? yaw : Math.PI;
    const dt = Math.min(0.1, Math.max(0.001, (tMs - this.lastT) / 1000));
    this.lastT = tMs;
    // Exponential approach: stable at any frame rate, no overshoot; a front/back switch swings round in ~0.25 s.
    this.turn = this.turn == null ? target : this.turn + (target - this.turn) * (1 - Math.exp(-TURN_OMEGA * dt));
    // Seen from behind there are no face landmarks: protect the head and hair from an estimate above the neck.
    const headOut = this.facing === 'back'
      ? { center: { x: neck.x - down.x * span * 0.55, y: neck.y - down.y * span * 0.55 }, rx: span * 0.3, ry: span * 0.42, chinY: neck.y }
      : head;

    return {
      W, H, sL, sR, u, down, span, yaw, facing: this.facing, turn: this.turn,
      top, hip: { x: hip2.x, y: hip2.y, z: hipZ }, hipsVisible, neck, chinY: this.facing === 'back' ? null : chinY,
      head: headOut, arms, silhouette: silOut, shoulderTop, neckHalf: this.neckHalf,
    };
  }
}
