import { useEffect, useRef, useState } from 'react';
import { useCamera } from '../hooks/useCamera';
import type { Anchors, KioskConfig, Point, SizeChartRow } from '../types';
import {
  BodySampler, LM, LandmarkSmoother, bodyFromLandmarks, chestWidthFromMask, silhouetteHalfWidths, yawFromWorld,
  type BodySampleSummary,
} from '../vision/body';
import { NEUTRAL_LIGHT, blendLight, estimateLight, type SceneLight } from '../vision/lighting';
import { drawLandmarks, headEllipse } from '../vision/render';
import { Tracker, type TrackerResult } from '../vision/tracker';
import { TryOnRenderer } from '../vision/tryon/renderer';
import { HAND, RigBuilder, type SilhouetteFn } from '../vision/tryon/rig';
import { PhotoShirt, type PhotoMesh } from '../vision/tryon/photoShirt';
import { ShirtModel, analyzeShape, type Fit, type GarmentShape, type SleeveKind, type Style } from '../vision/tryon/shirt';

export type TrackingState = 'loading' | 'no-person' | 'detecting' | 'tracking' | 'lost' | 'error';

export type StageUpdate = {
  tracking: TrackingState;
  body: BodySampleSummary | null;
  frame: { width: number; height: number } | null;
  fps: number;
  latencyMs: number;
  delegate: string | null;
  inFrame: boolean;
  hipsVisible?: boolean;
  stepBack?: boolean;   // shoulders/hips out of frame or poorly seen: the fit is frozen until the customer steps back
  bulkyTop?: boolean;   // own clothing much wider than the body
  light?: SceneLight;
  renderer?: 'webgl' | 'none';
};

export type StageDebug = { landmarks?: boolean; mask?: boolean; wireframe?: boolean };

type Props = {
  config: KioskConfig;
  garment: {
    url: string; backUrl?: string | null; meshUrl?: string | null; anchors: Anchors; color?: string | null; sleeve?: SleeveKind;
  } | null;
  size: SizeChartRow | null;        // chosen size; with `reference`, scales the shirt relative to the body fit
  reference: SizeChartRow | null;
  style?: Style;
  sessionKey: number;               // change to drop all smoothing and body samples
  onUpdate?: (u: StageUpdate) => void;
  showLandmarks?: boolean;
  debug?: StageDebug;
  cameraStorageKey?: string;
  showCameraPicker?: boolean;
  realism?: boolean;                // scene-matched lighting, folds, shadows and grain; off = flat colours
};

const STABLE_FRAMES = 10;     // consecutive good frames before the overlay appears
const LOST_GRACE_MS = 400;    // keep the last overlay briefly through single-frame dropouts
const MAX_SAMPLE_YAW = 0.26;  // only measure the body when it faces the camera (±15°)
const FADE_MS = 250;          // garment fade-in on product change
const LIGHT_EVERY = 6;        // frames between scene-light samples
const SEG_EVERY = 2;          // person segmentation every other frame (low-res; feeds widths and shadows only)
const TRACKED = [LM.nose, LM.leftEye, LM.rightEye, LM.leftEar, LM.rightEar, LM.mouthL, LM.mouthR,
  LM.lShoulder, LM.rShoulder, LM.lElbow, LM.rElbow, LM.lWrist, LM.rWrist, LM.lHip, LM.rHip, ...Object.values(HAND)];

// photo: mesh built from the product photo; without one (catalog uploads) the procedural shirt is drawn.
type Model = { shape: GarmentShape; url: string; loadedAt: number; photo: PhotoShirt | null };

const hexRgb = (hex: string | null | undefined): [number, number, number] | null => {
  const m = hex?.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
};

/** Garment alpha (and mean opaque colour) at 256 px, read once per garment. */
function readPhoto(img: HTMLImageElement, size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, size, size);
  const rgba = ctx.getImageData(0, 0, size, size).data;
  const alpha = new Uint8ClampedArray(size * size);
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < alpha.length; i++) {
    alpha[i] = rgba[i * 4 + 3];
    if (alpha[i] > 200) { r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; n++; }
  }
  return { alpha, mean: (n ? [r / n / 255, g / n / 255, b / n / 255] : [0.5, 0.5, 0.5]) as [number, number, number] };
}

const loadImage = (url: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = url;
});

export default function FittingStage(p: Props) {
  const cam = useCamera({
    width: p.config.camera.width, height: p.config.camera.height, frameRate: p.config.camera.frame_rate,
    storageKey: p.cameraStorageKey,
  });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const debugRef = useRef<HTMLCanvasElement | null>(null);
  const trackerRef = useRef<Tracker | null>(null);
  const glRef = useRef<TryOnRenderer | null | undefined>(undefined);
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [glError, setGlError] = useState(false);
  const [trackerReady, setTrackerReady] = useState(false);
  const model = useRef<Model | null>(null);
  const pendingGarment = useRef<{ front: HTMLImageElement; back: HTMLImageElement | null; color: [number, number, number] } | null>(null);
  const [garmentError, setGarmentError] = useState(false);
  const smoother = useRef(new LandmarkSmoother());
  const sampler = useRef(new BodySampler());
  const rigBuilder = useRef(new RigBuilder());
  const props = useRef(p);
  props.current = p;
  const [aspect, setAspect] = useState(16 / 9);

  const { start } = cam;
  useEffect(() => {
    start();
  }, [start]);

  // Model, loaded once per mount and reused for every frame.
  useEffect(() => {
    let cancelled = false;
    Tracker.create()
      .then((t) => {
        if (cancelled) return t.close();
        trackerRef.current = t;
        setTrackerReady(true);
      })
      .catch((e) => {
        console.error(e);
        setTrackerError('Body tracking could not start. Reload the page; if it persists, check that the model files exist (npm run fetch-models).');
      });
    return () => {
      cancelled = true;
      trackerRef.current?.close();
      trackerRef.current = null;
    };
  }, []);

  useEffect(() => () => glRef.current?.dispose(), []);

  // Garment photos (front, optional back) -> shape analysis + GPU upload.
  const g = p.garment;
  useEffect(() => {
    setGarmentError(false);
    model.current = null;
    if (!g) return;
    let cancelled = false;
    const mesh = g.meshUrl
      ? fetch(g.meshUrl).then((r) => (r.ok ? (r.json() as Promise<PhotoMesh>) : null)).catch(() => null)
      : Promise.resolve(null);
    Promise.all([loadImage(g.url), g.backUrl ? loadImage(g.backUrl).catch(() => null) : Promise.resolve(null), mesh])
      .then(([front, back, pm]) => {
        if (cancelled) return;
        const { alpha, mean } = readPhoto(front);
        const shape = analyzeShape(g.anchors, alpha, 256, g.sleeve ?? 'short');
        const color = hexRgb(g.color) ?? mean;
        if (glRef.current) glRef.current.setGarment(front, back, color);
        else pendingGarment.current = { front, back, color };
        model.current = { shape, url: g.url, loadedAt: performance.now(), photo: pm ? new PhotoShirt(pm, g.sleeve ?? 'short') : null };
      })
      .catch(() => !cancelled && setGarmentError(true));
    return () => { cancelled = true; };
  }, [g?.url, g?.backUrl, g?.meshUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    smoother.current.reset();
    sampler.current.clear();
    rigBuilder.current.reset();
  }, [p.sessionKey]);

  // Frame loop
  useEffect(() => {
    if (!trackerReady || cam.status !== 'live') return;
    const canvas = canvasRef.current!;
    if (glRef.current === undefined) {
      glRef.current = TryOnRenderer.create(canvas);
      if (!glRef.current) setGlError(true);
      const pg = pendingGarment.current;
      if (glRef.current && pg) glRef.current.setGarment(pg.front, pg.back, pg.color);
      pendingGarment.current = null;
    }
    const gl = glRef.current;
    let raf = 0;
    let lastVideoTime = -1;
    let goodFrames = 0;
    let lastGood = 0;
    let lastChest: number | null = null;
    let lastReport = 0;
    let lastNow = performance.now();
    const times: number[] = [];
    let latency = 0;
    let state: TrackingState = 'no-person';
    let inFrame = false;
    let hipsVisible = true;
    let stepBack = false;
    let bulkyTop = false;
    let lastRig: import('../vision/tryon/rig').Rig | null = null;
    let light: SceneLight = NEUTRAL_LIGHT;
    let frameNo = 0;
    let lastMask: TrackerResult['mask'] = null;
    const procedural = new ShirtModel();
    const probe = document.createElement('canvas');
    probe.width = 96;
    probe.height = 54;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true })!;

    const loop = () => {
      raf = requestAnimationFrame(loop);
      const video = cam.videoRef.current;
      const tracker = trackerRef.current;
      if (!video || !tracker || video.readyState < 2 || video.currentTime === lastVideoTime) return;
      lastVideoTime = video.currentTime;
      const W = video.videoWidth;
      const H = video.videoHeight;
      const debug = debugRef.current;
      if (debug && (debug.width !== W || debug.height !== H)) {
        debug.width = W;
        debug.height = H;
        setAspect(W / H);
      }
      const now = performance.now();
      const dt = now - lastNow;
      lastNow = now;
      const t0 = performance.now();
      let result;
      const segFrame = frameNo++ % SEG_EVERY === 0;
      gl?.captureFrame(video); // same frame as detection below
      try {
        result = tracker.detect(video, now, segFrame);
      } catch (e) {
        console.error(e);
        return;
      }
      if (result.mask) {
        lastMask = result.mask;
        gl?.setMask(result.mask);
      } else result = { ...result, mask: lastMask };
      latency = latency * 0.9 + (performance.now() - t0) * 0.1;
      times.push(now);
      while (times.length && now - times[0] > 1000) times.shift();

      const { size, reference, garment, showLandmarks, realism = true, style = 'regular', debug: dbg = {} } = props.current;
      const lms = result.landmarks;
      const pts = lms ? smoother.current.smooth(lms, TRACKED, W, H, now) : null;
      const body = lms && pts ? bodyFromLandmarks(lms, W, H, pts) : null;
      const rawYaw = yawFromWorld(result.world);

      if (body) {
        goodFrames++;
        lastGood = now;
        inFrame = body.inFrame;
        state = goodFrames >= STABLE_FRAMES ? 'tracking' : 'detecting';
        const raw = bodyFromLandmarks(lms!, W, H); // unsmoothed values for measurement
        if (raw && state === 'tracking' && raw.inFrame && (rawYaw ?? 0) < MAX_SAMPLE_YAW) {
          if (result.mask && raw.torsoLength) {
            const sMid = { x: (raw.leftShoulder.x + raw.rightShoulder.x) / 2, y: (raw.leftShoulder.y + raw.rightShoulder.y) / 2 };
            lastChest = chestWidthFromMask(result.mask.data, result.mask.width, result.mask.height,
              raw.center.x, sMid.y + raw.torsoLength * 0.22, W, H, raw.shoulderSpan);
          } else if (result.mask) {
            lastChest = null;
          }
          sampler.current.add(raw.shoulderSpan, lastChest, raw.torsoLength, raw.visibility);
        }
      } else {
        goodFrames = 0;
        if (!(state === 'tracking' && now - lastGood < LOST_GRACE_MS)) {
          state = lms ? 'lost' : 'no-person';
          rigBuilder.current.reset();
          procedural.reset();
          model.current?.photo?.reset();
        }
      }

      const m = model.current;
      let stats: Record<string, unknown> | null = null;
      if (body && state === 'tracking' && m && garment && gl) {
        // Silhouette sampler in display space (the mask is in video space: mirror x).
        const mask = result.mask;
        const silFn: SilhouetteFn | null = mask ? (c: Point, dir: Point, caps: [number, number]) =>
          silhouetteHalfWidths(mask.data, mask.width, mask.height, W, H, { x: W - c.x, y: c.y }, { x: -dir.x, y: dir.y }, caps) : null;
        const built = rigBuilder.current.build(pts!, result.world, W, H, now, silFn);
        // Step back: shoulders near the frame edge, hips out of frame or a poorly seen body. Keep the last good fit
        // instead of drifting with unreliable landmarks; with no good fit yet, draw nothing.
        const good = !!built && body.inFrame && built.hipsVisible && body.visibility >= 0.7;
        stepBack = !good;
        if (good) lastRig = built;
        const rig = good ? built : m.photo ? lastRig : built;
        if (rig) {
          hipsVisible = rig.hipsVisible;
          // Scene light from face + torso, refreshed every few frames and smoothed (video space, then mirrored).
          if (realism && frameNo % LIGHT_EVERY === 0) {
            const sx = probe.width / W, sy = probe.height / H;
            probeCtx.drawImage(video, 0, 0, probe.width, probe.height);
            const P = (i: number) => pts!.get(i) ?? null;
            const nose = P(LM.nose), le = P(LM.leftEye), re = P(LM.rightEye), ml = P(LM.mouthL), mr = P(LM.mouthR);
            const he = nose ? headEllipse({
              nose, eyes: le && re ? { x: (le.x + re.x) / 2, y: (le.y + re.y) / 2 } : null,
              mouth: ml && mr ? { x: (ml.x + mr.x) / 2, y: (ml.y + mr.y) / 2 } : null, ears: [P(LM.leftEar), P(LM.rightEar)],
            }, body.shoulderSpan) : null;
            const face = he ? { x0: (he.center.x - he.rx * 0.6) * sx, x1: (he.center.x + he.rx * 0.6) * sx,
              y0: (he.center.y - he.ry * 0.5) * sy, y1: (he.center.y + he.ry * 0.5) * sy } : null;
            const hipY = body.hipMid?.y ?? body.leftShoulder.y + body.shoulderSpan * 1.3;
            const torso = { x0: (body.leftShoulder.x + body.shoulderSpan * 0.15) * sx, x1: (body.rightShoulder.x - body.shoulderSpan * 0.15) * sx,
              y0: (body.leftShoulder.y + body.shoulderSpan * 0.2) * sy, y1: Math.min(hipY, H) * sy };
            const est = estimateLight(probeCtx.getImageData(0, 0, probe.width, probe.height).data, probe.width, face, torso);
            est.lightDir = [-est.lightDir[0], est.lightDir[1]]; // display is mirrored
            light = light === NEUTRAL_LIGHT ? est : blendLight(light, est, 0.3);
          }
          // Size relative to the reference size (product chart); folder shirts are fitted to the body (1, 1).
          const fit: Fit = {
            style,
            width: size && reference ? size.chest_width_cm / reference.chest_width_cm : 1,
            length: size && reference ? size.length_cm / reference.length_cm : 1,
          };
          const shirt = m.photo ?? procedural;
          gl.setModel(shirt);
          if (m.photo) { if (good) m.photo.update(rig, fit, dt); }
          else procedural.update(rig, m.shape, fit, dt);
          const st = shirt.stats;
          bulkyTop = !!st.bulky;
          gl.render(rig, {
            light: realism ? light : NEUTRAL_LIGHT,
            realism,
            fade: Math.min(1, (now - m.loadedAt) / FADE_MS),
            wireframe: !!dbg.wireframe,
            grain: Math.min(0.05, Math.max(0.01, 0.012 + 0.035 * (1 - light.exposure))),
            time: now / 1000,
            shadeTransfer: !!m.photo,
            // Clothing clean-up around the photo shirt: from just above the shoulders to just below the hem.
            inpaint: m.photo && realism && st.minX != null ? {
              x0: st.minX! - rig.span * 0.15, x1: st.maxX! + rig.span * 0.15,
              y0: Math.min(rig.shoulderTop.L.y, rig.shoulderTop.R.y) - rig.span * 0.1, y1: st.hemY,
            } : null,
          });
          stats = { ...shirt.stats, mesh: m.photo ? 'photo' : 'procedural', facing: rig.facing, turn: rig.turn, chinY: rig.chinY, W, H, hipsVisible, yaw: rig.yaw, span: rig.span,
            head: rig.head, light, fps: times.length };
        }
      }
      if (!stats) gl?.renderVideo(W, H);
      (window as unknown as { __vfr?: unknown }).__vfr = stats; // test/debug hook: live geometry numbers

      if (debug) {
        const dctx = debug.getContext('2d')!;
        dctx.setTransform(1, 0, 0, 1, 0, 0);
        dctx.clearRect(0, 0, W, H);
        if ((showLandmarks || dbg.landmarks) && body && pts) {
          const P = (i: number) => pts.get(i);
          const seg = (a: number, b: number) => (P(a) && P(b) ? [[P(a)!, P(b)!] as [Point, Point]] : []);
          drawLandmarks(dctx, [...pts.values()].filter((x): x is Point => !!x), [
            ...seg(LM.lShoulder, LM.rShoulder), ...seg(LM.lShoulder, LM.lElbow), ...seg(LM.lElbow, LM.lWrist),
            ...seg(LM.rShoulder, LM.rElbow), ...seg(LM.rElbow, LM.rWrist), ...seg(LM.lShoulder, LM.lHip),
            ...seg(LM.rShoulder, LM.rHip), ...seg(LM.lHip, LM.rHip),
          ]);
        }
        const photo = model.current?.photo;
        if (dbg.landmarks && photo && state === 'tracking') {
          // Body pins (orange) vs shirt keypoints (cyan). This canvas is mirrored with the video: flip display x.
          const { pins, keys } = photo.debug;
          dctx.lineWidth = 2;
          pins.forEach((p0, i) => {
            const k = keys[i];
            if (!k) return;
            dctx.strokeStyle = 'rgba(255,255,255,0.7)';
            dctx.beginPath(); dctx.moveTo(W - p0.x, p0.y); dctx.lineTo(W - k.x, k.y); dctx.stroke();
            dctx.fillStyle = '#ff8a00';
            dctx.beginPath(); dctx.arc(W - p0.x, p0.y, 7, 0, Math.PI * 2); dctx.fill();
            dctx.strokeStyle = '#00e5ff';
            dctx.beginPath(); dctx.arc(W - k.x, k.y, 10, 0, Math.PI * 2); dctx.stroke();
          });
        }
        if (dbg.mask && result.mask) {
          // Mask preview in the corner (this canvas is mirrored with the video, so draw it in video coordinates).
          const mk = result.mask, img = dctx.createImageData(mk.width, mk.height);
          for (let i = 0; i < mk.data.length; i++) {
            const v = mk.data[i] * 255;
            img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 220;
          }
          dctx.putImageData(img, W - mk.width - 8, H - mk.height - 8);
        }
      }

      if (now - lastReport > 250) {
        lastReport = now;
        props.current.onUpdate?.({
          tracking: state,
          body: state === 'tracking' ? sampler.current.summary() : null,
          frame: { width: W, height: H },
          fps: times.length,
          latencyMs: Math.round(latency * 10) / 10,
          delegate: tracker.delegate,
          inFrame,
          hipsVisible,
          stepBack: state === 'tracking' && stepBack,
          bulkyTop,
          light,
          renderer: gl ? 'webgl' : 'none',
        });
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [trackerReady, cam.status, cam.videoRef]);

  useEffect(() => {
    if (trackerError) p.onUpdate?.({ tracking: 'error', body: null, frame: null, fps: 0, latencyMs: 0, delegate: null, inFrame: false });
  }, [trackerError]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stage">
      <div className="stage-media" style={{ aspectRatio: aspect }}>
        <video ref={cam.videoRef} className="mirror" playsInline muted aria-label="Live camera" />
        {/* Camera + shirt, drawn together from the same frame. Not mirrored by CSS: the renderer mirrors only the
            video, so the shirt's print reads correctly. The <video> underneath shows until the first frame is drawn. */}
        <canvas ref={canvasRef} className="stage-overlay" aria-hidden="true" />
        <canvas ref={debugRef} className="mirror stage-overlay" aria-hidden="true" />
      </div>
      {cam.status === 'starting' && <div className="stage-message">Starting camera…</div>}
      {cam.status === 'live' && !trackerReady && !trackerError && <div className="stage-message">Loading body tracking…</div>}
      {(cam.status === 'error' || trackerError) && (
        <div className="stage-message stage-error" role="alert">
          <p>{cam.error ?? trackerError}</p>
          {cam.error && <button className="btn" onClick={() => cam.start()}>Retry camera</button>}
        </div>
      )}
      {glError && <div className="stage-banner" role="alert">This browser has no WebGL, so the virtual shirt can't be drawn.</div>}
      {garmentError && <div className="stage-banner" role="alert">The garment image could not be loaded.</div>}
      {p.showCameraPicker && cam.devices.length > 1 && (
        <select
          className="stage-camera-picker"
          aria-label="Camera"
          value={cam.deviceId}
          onChange={(e) => cam.setDeviceId(e.target.value)}
        >
          <option value="">Default camera</option>
          {cam.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
        </select>
      )}
    </div>
  );
}
