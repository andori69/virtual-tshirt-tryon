import { describe, expect, it } from 'vitest';
import type { Anchors, Point } from '../../types';
import { LM, silhouetteHalfWidths, yawFromWorld } from '../body';
import { HAND, RigBuilder, type World } from './rig';
import { M, NR, ShirtModel, STYLES, analyzeShape, type Fit } from './shirt';

const W = 1280, H = 720;

/** Video-pixel landmarks of a person facing the camera; hips at `hipY` (null = out of frame). */
function person(opts: { cx?: number; span?: number; shoulderY?: number; hipY?: number | null } = {}) {
  const { cx = 640, span = 200, shoulderY = 260, hipY = 560 } = opts;
  const pts = new Map<number, Point | null>();
  const set = (i: number, x: number, y: number) => pts.set(i, { x, y });
  // Video space: the person's left shoulder (11) is on the image right.
  set(LM.lShoulder, cx + span / 2, shoulderY); set(LM.rShoulder, cx - span / 2, shoulderY);
  set(LM.lElbow, cx + span * 0.62, shoulderY + span * 0.75); set(LM.rElbow, cx - span * 0.62, shoulderY + span * 0.75);
  set(LM.lWrist, cx + span * 0.65, shoulderY + span * 1.4); set(LM.rWrist, cx - span * 0.65, shoulderY + span * 1.4);
  for (const i of Object.values(HAND)) set(i, cx + (i % 2 ? 1 : -1) * span * 0.66, shoulderY + span * 1.55);
  if (hipY != null) { set(LM.lHip, cx + span * 0.3, hipY); set(LM.rHip, cx - span * 0.3, hipY); } else { pts.set(LM.lHip, null); pts.set(LM.rHip, null); }
  set(LM.nose, cx, shoulderY - span * 0.55);
  set(LM.leftEye, cx + 15, shoulderY - span * 0.62); set(LM.rightEye, cx - 15, shoulderY - span * 0.62);
  set(LM.mouthL, cx + 10, shoulderY - span * 0.45); set(LM.mouthR, cx - 10, shoulderY - span * 0.45);
  set(LM.leftEar, cx + span * 0.22, shoulderY - span * 0.58); set(LM.rightEar, cx - span * 0.22, shoulderY - span * 0.58);
  return pts;
}

/** World landmarks (metres, z away from camera); `turn` moves the person's left shoulder (11) toward the camera. */
function world(turn = 0): World {
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  w[LM.lShoulder] = { x: 0.18 * Math.cos(turn), y: -0.45, z: -0.18 * Math.sin(turn) };
  w[LM.rShoulder] = { x: -0.18 * Math.cos(turn), y: -0.45, z: 0.18 * Math.sin(turn) };
  return w;
}

const anchors: Anchors = {
  left_shoulder: { x: 0.3, y: 0.2 }, right_shoulder: { x: 0.7, y: 0.2 }, neckline_center: { x: 0.5, y: 0.16 },
  left_sleeve: { x: 0.12, y: 0.42 }, right_sleeve: { x: 0.88, y: 0.42 },
  left_hem: { x: 0.28, y: 0.86 }, right_hem: { x: 0.72, y: 0.86 }, bottom_center: { x: 0.5, y: 0.86 },
};
const shape = analyzeShape(anchors, null, 256);
const regular: Fit = { style: 'regular', width: 1, length: 1 };

function build(pts = person(), w: World | null = world(), t = 0) {
  return new RigBuilder().build(pts, w, W, H, t, null)!;
}

describe('rig (display space)', () => {
  it('mirrors x and puts the person\'s right shoulder on the display left', () => {
    const rig = build();
    // Person's right shoulder (12) is at video x 540 -> display x 740: display-right. Left (11) at 740 -> 540.
    expect(rig.sL.x).toBeCloseTo(540);
    expect(rig.sR.x).toBeCloseTo(740);
    expect(rig.u.x).toBeCloseTo(1);
  });
  it('signs the turn: display-right shoulder toward the viewer is positive', () => {
    // The person's left shoulder (11) is display-left; bring the person's right (12, display-right) forward.
    const b = new RigBuilder();
    let yaw = 0;
    for (let t = 0; t < 2000; t += 33) yaw = b.build(person(), world(-0.5), W, H, t, null)!.yaw;
    expect(yaw).toBeGreaterThan(0.3);
    const b2 = new RigBuilder();
    for (let t = 0; t < 2000; t += 33) yaw = b2.build(person(), world(0.5), W, H, t, null)!.yaw;
    expect(yaw).toBeLessThan(-0.3);
  });
  it('estimates the hips when they are out of frame', () => {
    const rig = build(person({ hipY: null }));
    expect(rig.hipsVisible).toBe(false);
    expect(rig.hip.y - rig.top.y).toBeGreaterThan(rig.span * 1.2);
  });
  it('keeps the collar ring below the chin', () => {
    const rig = build(person({ shoulderY: 200 }));
    expect(rig.chinY).not.toBeNull();
    expect(rig.neck.y + rig.span * (0.07 - 0.035)).toBeGreaterThan(rig.chinY!);
  });
});

describe('shirt mesh', () => {
  const front = (s: ShirtModel, ring: number, j: number) => {
    const i = (1 + 4 + ring) * M + j; // collar + yoke rows come first
    return { x: s.position[i * 3], u: s.uv[i * 2], tex: s.tex[i], nz: s.normal[i * 3 + 2] };
  };
  it('maps the photo unflipped: print left -> display left, front faces the viewer', () => {
    const s = new ShirtModel();
    s.update(build(), shape, regular, 33);
    const l = front(s, 8, M / 2 - 3), c = front(s, 8, M / 2), r = front(s, 8, M / 2 + 3);
    expect(l.x).toBeLessThan(c.x);
    expect(c.x).toBeLessThan(r.x);
    expect(l.u).toBeLessThan(c.u);
    expect(c.u).toBeLessThan(r.u);
    expect(c.tex).toBe(0);
    expect(c.nz).toBeGreaterThan(0.9);
    expect(front(s, 8, 0).tex).toBe(1); // centre back uses the back photo
  });
  it('never draws the hem below the frame', () => {
    const s = new ShirtModel();
    const rig = build(person({ shoulderY: 420, hipY: null }));
    for (let t = 0; t < 30; t++) s.update(rig, shape, { ...regular, style: 'oversized' }, 33);
    expect(s.stats.hemY).toBeLessThanOrEqual(H);
    expect(s.stats.visibleLengthFrac).toBeLessThan(1);
  });
  it('puts the crew front below the chin', () => {
    const s = new ShirtModel();
    const rig = build(person({ shoulderY: 200 }));
    s.update(rig, shape, regular, 33);
    expect(s.stats.collarFrontY).toBeGreaterThan(rig.chinY!);
  });
  it('limits sudden stretching to 10%', () => {
    const s = new ShirtModel();
    for (let t = 0; t < 60; t++) s.update(build(), shape, regular, 33);
    const width = () => { const a = front(s, 12, M / 4), b = front(s, 12, (3 * M) / 4); return Math.abs(b.x - a.x); };
    const w0 = width();
    s.update(build(), shape, { ...regular, width: 1.6 }, 33);
    expect(width() / w0).toBeLessThanOrEqual(1.1 + 1e-6);
  });
  it('keeps hem sway within 10% of the length', () => {
    const s = new ShirtModel();
    for (let t = 0; t < 20; t++) s.update(build(person({ cx: 640 })), shape, regular, 33);
    const hemX = () => front(s, NR - 1, M / 2).x;
    const before = hemX();
    s.update(build(person({ cx: 900 })), shape, regular, 33); // jump 260 px sideways
    const lag = Math.abs((hemX() - before) - (-260)); // display x moves the other way (mirror)
    expect(lag).toBeGreaterThan(0);
    expect(lag).toBeLessThanOrEqual(0.1 * 300 * 1.35 + 30);
  });
  it('oversized is wider than slim', () => {
    const width = (style: Fit['style']) => {
      const s = new ShirtModel();
      s.update(build(), shape, { ...regular, style }, 33);
      return Math.abs(front(s, 14, (3 * M) / 4).x - front(s, 14, M / 4).x);
    };
    expect(width('oversized')).toBeGreaterThan(width('slim') * (STYLES.oversized.ease / STYLES.slim.ease) * 0.95);
  });
  it('collapses sleeves for sleeveless shirts', () => {
    const s = new ShirtModel();
    s.update(build(), { ...shape, sleeve: 'sleeveless' }, regular, 33);
    expect(s.sleevesVisible).toBe(false);
  });
});

describe('body helpers', () => {
  it('measures silhouette half-widths along a direction', () => {
    const N = 100;
    const mask = new Float32Array(N * N);
    for (let x = 30; x < 70; x++) mask[50 * N + x] = 1;
    const [l, r] = silhouetteHalfWidths(mask, N, N, 1000, 1000, { x: 500, y: 500 }, { x: 1, y: 0 }, 400);
    // 40 mask px of 100 = 400 frame px wide; ±1 mask px (10 frame px) quantization.
    for (const d of [l!, r!]) expect(Math.abs(d - 205)).toBeLessThanOrEqual(10);
    expect(silhouetteHalfWidths(mask, N, N, 1000, 1000, { x: 500, y: 100 }, { x: 1, y: 0 }, 400)).toEqual([null, null]);
    expect(silhouetteHalfWidths(mask, N, N, 1000, 1000, { x: 500, y: 500 }, { x: 1, y: 0 }, 100)).toEqual([null, null]);
    // Per-side limit: an arm cap at 150 px on the left hides that edge; the right side still finds its edge.
    const [l2, r2] = silhouetteHalfWidths(mask, N, N, 1000, 1000, { x: 500, y: 500 }, { x: 1, y: 0 }, [150, 400]);
    expect(l2).toBeNull();
    expect(Math.abs(r2! - 205)).toBeLessThanOrEqual(10);
  });
  it('estimates yaw from world landmarks', () => {
    const w = Array.from({ length: 33 }, () => ({ x: 0, z: 0 }));
    w[LM.lShoulder] = { x: 0.18, z: 0 };
    w[LM.rShoulder] = { x: -0.18, z: 0 };
    expect(yawFromWorld(w)).toBeCloseTo(0, 5);
    w[LM.rShoulder] = { x: -0.18, z: 0.36 * Math.tan(0.5) };
    expect(yawFromWorld(w)!).toBeGreaterThan(0.3);
    expect(yawFromWorld(null)).toBeNull();
  });
});

describe('photo-built shirt', async () => {
  const { PhotoShirt, tps, FIT_FACTOR } = await import('./photoShirt');
  const mesh = (await import('./__fixtures__/tee.mesh.json')).default as unknown as import('./photoShirt').PhotoMesh;
  const n = mesh.uv.length / 2;
  const at = (s: InstanceType<typeof PhotoShirt>, i: number) => ({ x: s.position[i * 3], y: s.position[i * 3 + 1], z: s.position[i * 3 + 2] });
  const nearest = (u: number, v: number) => {
    let best = 0, d = Infinity;
    for (let i = 0; i < n; i++) { const e = (mesh.uv[2 * i] - u) ** 2 + (mesh.uv[2 * i + 1] - v) ** 2; if (e < d) { d = e; best = i; } }
    return best;
  };

  it('thin-plate spline passes through its control points', () => {
    const src = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0.5, y: 0.4 }];
    const dst = src.map((p) => ({ x: 10 + 200 * p.x + 5 * p.y * p.y, y: 300 * p.y }));
    const f = tps(src, dst);
    src.forEach((p, i) => { const q = f(p); expect(q.x).toBeCloseTo(dst[i].x, 4); expect(q.y).toBeCloseTo(dst[i].y, 4); });
  });
  it('keeps the photo unmirrored and faces the viewer', () => {
    const s = new PhotoShirt(mesh);
    s.update(build(), regular, 33);
    const l = nearest(0.4, 0.55), r = nearest(0.6, 0.55);
    expect(at(s, l).x).toBeLessThan(at(s, r).x);
    expect(s.normal[l * 3 + 2]).toBeGreaterThan(0.5);              // front shell toward the viewer
    expect(s.normal[(l + n) * 3 + 2]).toBeLessThan(-0.5);          // back shell away
  });
  it('is hollow: shells part at the hem and meet at the side seams', () => {
    const s = new PhotoShirt(mesh);
    s.update(build(), regular, 33);
    const k = mesh.keypoints;
    const hem = nearest(k.hem_c[0], k.hem_c[1]), side = nearest(k.hem_l[0] + 0.01, (k.armpit_l[1] + k.hem_l[1]) / 2);
    expect(at(s, hem).z - at(s, hem + n).z).toBeGreaterThan(5);
    expect(Math.abs(at(s, side).z - at(s, side + n).z)).toBeLessThan(2);
  });
  it('never gets wider than the body times the fit factor', () => {
    const rig = build();
    for (const style of ['slim', 'regular', 'oversized'] as const) {
      const s = new PhotoShirt(mesh);
      s.update(rig, { ...regular, style }, 33);
      const cx = rig.top.x;
      let maxHalf = 0;
      for (let i = 0; i < n; i++) if (mesh.sleeveL[i] === 0 && mesh.sleeveR[i] === 0) maxHalf = Math.max(maxHalf, Math.abs(at(s, i).x - cx));
      expect(maxHalf).toBeLessThanOrEqual(rig.span * 0.625 * FIT_FACTOR[style] + rig.span * 0.03);
    }
  });
  it('shows the back shell when turned round, with sides swapped', () => {
    const rig = build();
    const s = new PhotoShirt(mesh);
    s.update({ ...rig, turn: Math.PI }, regular, 33);
    const c = nearest(0.5, 0.55), l = nearest(0.4, 0.55), r = nearest(0.6, 0.55);
    expect(at(s, c + n).z).toBeGreaterThan(at(s, c).z);            // back shell is now nearer the viewer
    expect(at(s, l).x).toBeGreaterThan(at(s, r).x);                // photo-left goes to display-right
  });
});

describe('front/back facing', () => {
  it('switches only after several frames without a face, then swings round smoothly', () => {
    const b = new RigBuilder();
    const noFace = person();
    for (const i of [LM.nose, LM.leftEye, LM.rightEye]) noFace.set(i, null);
    let r = b.build(person(), world(), W, H, 0, null)!;
    expect(r.facing).toBe('front');
    r = b.build(noFace, world(), W, H, 33, null)!;
    expect(r.facing).toBe('front');                               // one missing frame is not enough
    for (let t = 66; t < 400; t += 33) r = b.build(noFace, world(), W, H, t, null)!;
    expect(r.facing).toBe('back');
    expect(r.turn).toBeGreaterThan(0.3);
    expect(r.turn).toBeLessThan(Math.PI);                         // still swinging, no jump
    for (let t = 400; t < 2000; t += 33) r = b.build(noFace, world(), W, H, t, null)!;
    expect(r.turn).toBeCloseTo(Math.PI, 1);
  });
  it('stays bounded at a slow frame rate (no spring blow-up)', () => {
    const b = new RigBuilder();
    const noFace = person();
    for (const i of [LM.nose, LM.leftEye, LM.rightEye]) noFace.set(i, null);
    let r = b.build(person(), world(), W, H, 0, null)!;
    for (let t = 250; t < 5000; t += 250) {
      r = b.build(noFace, world(), W, H, t, null)!;
      expect(r.turn).toBeGreaterThanOrEqual(-0.01);
      expect(r.turn).toBeLessThanOrEqual(Math.PI + 0.01);
    }
  });
  it('reads a profile from the collapsed shoulder span', () => {
    const b = new RigBuilder();
    const side = person({ span: 30 });             // shoulders almost on top of each other, torso 300 px long
    let r = b.build(side, world(0.2), W, H, 0, null)!;
    for (let t = 33; t < 1000; t += 33) r = b.build(side, world(0.2), W, H, t, null)!;
    expect(Math.abs(r.yaw)).toBeGreaterThan(1.0);
    expect(r.span).toBeGreaterThan(150);           // body scale from the torso, not the 30 px span
    expect(r.facing).toBe('front');
  });
  it('treats a nose behind the shoulders as the back, even when a face is reported', () => {
    const b = new RigBuilder();
    const w = world();
    w[LM.nose] = { x: 0, y: -0.6, z: 0.12 };   // 12 cm behind the shoulders
    let r = b.build(person(), w, W, H, 0, null)!;
    for (let t = 33; t < 600; t += 33) r = b.build(person(), w, W, H, t, null)!;
    expect(r.facing).toBe('back');
    w[LM.nose] = { x: 0, y: -0.6, z: -0.15 };  // facing the camera again
    for (let t = 600; t < 1200; t += 33) r = b.build(person(), w, W, H, t, null)!;
    expect(r.facing).toBe('front');
  });
});

describe('shoulder anchoring (pins)', async () => {
  const { PhotoShirt } = await import('./photoShirt');
  const mesh = (await import('./__fixtures__/tee.mesh.json')).default as unknown as import('./photoShirt').PhotoMesh;
  const tilted = () => {
    const p = person();
    p.set(LM.lShoulder, { x: 740, y: 240 });  // the person's left shoulder 40 px higher
    p.set(LM.rShoulder, { x: 540, y: 280 });
    return p;
  };
  it('puts the shirt shoulder tips on the shoulder landmarks and tilts with them', () => {
    for (const pts of [person(), tilted()]) {
      const rig = new RigBuilder().build(pts, null, W, H, 0, null)!;
      const s = new PhotoShirt(mesh);
      s.update(rig, regular, 33);
      const [kl, kr] = s.debug.keys;
      const tl = rig.shoulderTop.L, tr = rig.shoulderTop.R;
      expect(Math.hypot(kl.x - tl.x, kl.y - tl.y)).toBeLessThan(3);
      expect(Math.hypot(kr.x - tr.x, kr.y - tr.y)).toBeLessThan(3);
      expect(tl.y).toBeLessThan(rig.sL.y);                          // seam above the joint
      expect((tr.y - tl.y) / (tr.x - tl.x)).toBeCloseTo((rig.sR.y - rig.sL.y) / (rig.sR.x - rig.sL.x), 2); // tilts with it
    }
  });
  it('raises the neck base 0.25 shoulder widths above the shoulder midpoint', () => {
    const rig = new RigBuilder().build(person({ shoulderY: 300 }), null, W, H, 0, null)!;
    expect((rig.sL.y + rig.sR.y) / 2 - rig.neck.y).toBeCloseTo(0.25 * rig.span, 0);
  });
  it('keeps sleeves no wider than an upper arm plus ease', () => {
    const rig = new RigBuilder().build(person(), null, W, H, 0, null)!;
    const s = new PhotoShirt(mesh);
    s.update(rig, regular, 33);
    const n = mesh.uv.length / 2;
    // Distance of left-sleeve vertices from the shoulder->elbow line.
    const a = rig.arms.L.shoulder, e = rig.arms.L.elbow!;
    const d = { x: e.x - a.x, y: e.y - a.y }, l = Math.hypot(d.x, d.y);
    let far = 0;
    for (let i = 0; i < n; i++) if (mesh.sleeveL[i] === 1) {
      const px = s.position[i * 3] - a.x, py = s.position[i * 3 + 1] - a.y;
      far = Math.max(far, Math.abs(px * d.y - py * d.x) / l);
    }
    expect(far).toBeLessThan(0.34 * rig.span * 1.12 + 0.05 * rig.span);
  });
});

describe('shoulder top from the mask', () => {
  it('pins the seam where the mask ends above the joint', () => {
    // Mask edge 40 px above each shoulder joint.
    const sil = (_c: Point, dir: Point): [number | null, number | null] =>
      Math.abs(dir.y) > 0.9 ? [40, null] : [null, null];
    const rig = new RigBuilder().build(person(), null, W, H, 0, sil)!;
    expect(rig.sL.y - rig.shoulderTop.L.y).toBeCloseTo(40, 0);
  });
});

describe('sleeve placement', async () => {
  const { PhotoShirt } = await import('./photoShirt');
  const mesh = (await import('./__fixtures__/tee.mesh.json')).default as unknown as import('./photoShirt').PhotoMesh;
  it('centres both sleeves on their arms (symmetric)', () => {
    const rig = new RigBuilder().build(person(), null, W, H, 0, null)!;
    const s = new PhotoShirt(mesh);
    s.update(rig, regular, 33);
    const n = mesh.uv.length / 2, cx = rig.top.x;
    const reach = (w: number[]) => { let m = 0; for (let i = 0; i < n; i++) if (w[i] === 1) m = Math.max(m, Math.abs(s.position[i * 3] - cx)); return m; };
    const l = reach(mesh.sleeveL), r = reach(mesh.sleeveR);
    expect(Math.abs(l - r)).toBeLessThan(0.05 * rig.span);
    expect(l).toBeGreaterThan(Math.abs(rig.arms.L.shoulder.x - cx)); // sleeve reaches outside the shoulder joint
  });
});
