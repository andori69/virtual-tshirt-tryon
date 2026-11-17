/**
 * Scene light estimate from a small RGBA copy of the camera frame (sampled every few frames).
 * Face and torso boxes are in the same small-image pixel coordinates.
 */
export type Box = { x0: number; y0: number; x1: number; y1: number };

export type SceneLight = {
  exposure: number;              // multiply garment brightness
  contrast: number;              // >1 punchier, <1 flatter
  tint: [number, number, number]; // per-channel gain for color temperature (gray-world), luminance-neutral
  lightDir: [number, number];     // x: + = light from image right; y: + = light from above
  skin: [number, number, number] | null; // average face color (0..1), for the skin-only neck opening
  torso: number | null;          // mean luminance of the torso box: reference for transferring the real shading
};

export const NEUTRAL_LIGHT: SceneLight = { exposure: 1, contrast: 1, tint: [1, 1, 1], lightDir: [0, 0.3], skin: null, torso: null };

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function stats(px: Uint8ClampedArray, w: number, b: Box) {
  let n = 0, r = 0, g = 0, bl = 0, l = 0, l2 = 0;
  const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(w - 1, Math.ceil(b.x1));
  const h = px.length / 4 / w;
  const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(h - 1, Math.ceil(b.y1));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * w + x) * 4;
    const R = px[i] / 255, G = px[i + 1] / 255, B = px[i + 2] / 255;
    const L = luma(R, G, B);
    r += R; g += G; bl += B; l += L; l2 += L * L; n++;
  }
  if (!n) return null;
  const mean = l / n;
  return { n, rgb: [r / n, g / n, bl / n] as [number, number, number], mean, std: Math.sqrt(Math.max(0, l2 / n - mean * mean)) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function estimateLight(px: Uint8ClampedArray, w: number, face: Box | null, torso: Box | null): SceneLight {
  const h = px.length / 4 / w;
  const frame = stats(px, w, { x0: 0, y0: 0, x1: w - 1, y1: h - 1 })!;
  const f = face ? stats(px, w, face) : null;

  // Exposure: scene key from the whole frame and the face (product photos are shot near 0.45 mid-gray). The torso is
  // left out: it shows the customer's own clothes, whose colour says nothing about the light. Kept gentle because
  // the camera's auto-exposure already normalises most scenes.
  const key = 0.6 * frame.mean + 0.4 * (f?.mean ?? frame.mean);
  const exposure = Math.min(1.12, Math.pow(clamp(key / 0.45, 0.5, 1.25), 0.6));

  // Contrast relative to a typical frame.
  const contrast = clamp(frame.std / 0.2, 0.9, 1.1); // gentle: product photos already carry their own contrast

  // Color temperature: gray-world over the frame, half strength, normalised to keep luminance.
  const [r, g, b] = frame.rgb;
  const m = (r + g + b) / 3 || 1;
  const raw: [number, number, number] = [r / m, g / m, b / m];
  const tint = raw.map((v) => 1 + (clamp(v, 0.7, 1.3) - 1) * 0.5) as [number, number, number];
  const tl = luma(...tint);
  const tintN = tint.map((v) => v / tl) as [number, number, number];

  // Light direction from the left/right and top/bottom brightness of the face and torso (both roughly symmetric).
  const gradient = (b: Box): [number, number] | null => {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const L = stats(px, w, { ...b, x1: cx }), R = stats(px, w, { ...b, x0: cx });
    const T = stats(px, w, { ...b, y1: cy }), B = stats(px, w, { ...b, y0: cy });
    if (!L || !R || !T || !B) return null;
    return [(3 * (R.mean - L.mean)) / (R.mean + L.mean + 1e-3), (2 * (T.mean - B.mean)) / (T.mean + B.mean + 1e-3)];
  };
  const gs = [face && gradient(face), torso && gradient(torso)].filter((g): g is [number, number] => !!g);
  let lightDir: [number, number] = [0, 0.3];
  if (gs.length) {
    const gx = gs.reduce((s, g) => s + g[0], 0) / gs.length, gy = gs.reduce((s, g) => s + g[1], 0) / gs.length;
    lightDir = [clamp(gx, -1, 1), clamp(0.3 + gy, -0.5, 1)];
  }
  const t = torso ? stats(px, w, torso) : null;
  return { exposure, contrast, tint: tintN, lightDir, skin: f ? f.rgb : null, torso: t ? t.mean : null };
}

/** Exponential smoothing between estimates so lighting never flickers. */
export function blendLight(a: SceneLight, b: SceneLight, k: number): SceneLight {
  const mix = (x: number, y: number) => x + (y - x) * k;
  return {
    exposure: mix(a.exposure, b.exposure),
    contrast: mix(a.contrast, b.contrast),
    tint: a.tint.map((v, i) => mix(v, b.tint[i])) as [number, number, number],
    lightDir: [mix(a.lightDir[0], b.lightDir[0]), mix(a.lightDir[1], b.lightDir[1])],
    skin: b.skin ? (a.skin ? (a.skin.map((v, i) => mix(v, b.skin![i])) as [number, number, number]) : b.skin) : a.skin,
    torso: b.torso != null ? (a.torso != null ? mix(a.torso, b.torso) : b.torso) : a.torso,
  };
}
