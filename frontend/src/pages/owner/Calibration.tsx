import { useEffect, useRef, useState } from 'react';
import { useCamera } from '../../hooks/useCamera';
import { api, upload } from '../../services/api';
import type { KioskConfig } from '../../types';

type Cal = {
  id: number; marker_id: number; marker_size_cm: number; marker_side_px: number; px_per_cm: number;
  frame_width: number; frame_height: number; skew_ratio: number; camera_label: string; created_at: string;
};
type Detection = { corners_px: number[][]; marker_side_px: number; px_per_cm: number; skew_ratio: number; frame_width: number; frame_height: number; marker_id: number };

function CalibrationCamera({ config, onSaved }: { config: KioskConfig; onSaved: (c: Cal) => void }) {
  // Same camera, resolution and storage key as the kiosk so the scale applies to what customers see.
  const cam = useCamera({ width: config.camera.width, height: config.camera.height, frameRate: config.camera.frame_rate, storageKey: 'vfr.kiosk.camera' });
  const [size, setSize] = useState('15');
  const [frame, setFrame] = useState<{ blob: Blob; url: string } | null>(null);
  const [det, setDet] = useState<Detection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { start, stop } = cam;
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);

  const capture = async () => {
    const v = cam.videoRef.current;
    if (!v?.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    if (!blob) return;
    setFrame({ blob, url: URL.createObjectURL(blob) });
    setBusy(true);
    setError(null);
    setDet(null);
    try {
      setDet(await upload<Detection>('/api/owner/calibration/detect', { file: blob, marker_size_cm: size }, 'frame.png'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!frame) return;
    setBusy(true);
    try {
      const r = await upload<{ active: Cal }>('/api/owner/calibration',
        { file: frame.blob, marker_size_cm: size, camera_label: cam.actual?.label ?? '' }, 'frame.png');
      onSaved(r.active);
      setFrame(null);
      setDet(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Measure scale</h2>
      <div className="row wrap">
        <label className="inline">Printed marker side (cm, measured with a ruler)
          <input type="number" min="1" max="100" step="0.1" value={size} onChange={(e) => setSize(e.target.value)} className="qty" />
        </label>
        {cam.devices.length > 1 && (
          <label className="inline">Camera
            <select value={cam.deviceId} onChange={(e) => cam.setDeviceId(e.target.value)}>
              <option value="">Default</option>
              {cam.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="calib-view">
        <video ref={cam.videoRef} playsInline muted hidden={!!frame} aria-label="Calibration camera" />
        {frame && (
          <div className="calib-frame">
            <img ref={imgRef} src={frame.url} alt="Captured calibration frame" />
            {det && (
              <svg viewBox={`0 0 ${det.frame_width} ${det.frame_height}`} preserveAspectRatio="none">
                <polygon points={det.corners_px.map((p) => p.join(',')).join(' ')} className="marker-outline" />
              </svg>
            )}
          </div>
        )}
        {cam.status === 'error' && <div className="error" role="alert">{cam.error} <button className="btn" onClick={() => cam.start()}>Retry</button></div>}
      </div>
      {cam.actual && <p className="muted small">{cam.actual.label} · {cam.actual.width}×{cam.actual.height}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {det && (
        <p className="ok">
          Marker {det.marker_id} found: {det.marker_side_px.toFixed(1)} px per side → <b>{det.px_per_cm.toFixed(2)} px/cm</b> (tilt ratio {det.skew_ratio.toFixed(2)}).
        </p>
      )}
      <div className="row">
        {!frame ? (
          <button className="btn btn-primary" onClick={capture} disabled={cam.status !== 'live' || busy}>Capture & detect</button>
        ) : (
          <>
            <button className="btn" onClick={() => { setFrame(null); setDet(null); setError(null); }}>Retake</button>
            <button className="btn btn-primary" onClick={save} disabled={!det || busy}>Save calibration</button>
          </>
        )}
      </div>
    </section>
  );
}

export default function Calibration() {
  const [active, setActive] = useState<Cal | null | undefined>(undefined);
  const [config, setConfig] = useState<KioskConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ active: Cal | null }>('/api/owner/calibration').then((r) => setActive(r.active)).catch((e) => setError(e.message));
    api<KioskConfig>('/api/kiosk/config').then(setConfig).catch((e) => setError(e.message));
  }, []);

  const clear = async () => {
    if (!confirm('Remove the active calibration? Size estimates will be disabled until you recalibrate.')) return;
    await api('/api/owner/calibration', { method: 'DELETE' });
    setActive(null);
  };

  return (
    <>
      <header className="page-head"><h1>Camera Calibration</h1></header>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="card">
        <h2>Status</h2>
        {active === undefined ? <p className="muted">Loading…</p> : active ? (
          <>
            <p className="ok">Calibrated: {active.px_per_cm.toFixed(2)} px/cm at {active.frame_width}×{active.frame_height}
              {active.camera_label && <> · {active.camera_label}</>} · {new Date(active.created_at).toLocaleString()}</p>
            <button className="btn btn-ghost danger" onClick={clear}>Remove calibration</button>
          </>
        ) : <p className="error">Not calibrated. Customers can still try shirts on, but size estimates are disabled.</p>}
      </section>

      <section className="card">
        <h2>How to calibrate</h2>
        <ol>
          <li><a href="/api/owner/calibration/marker.png" target="_blank" rel="noreferrer">Open the marker image</a> and print it
            at about 15 cm wide on plain paper. Don't use "fit to page" if you can avoid it.</li>
          <li>Measure the black square's side with a ruler and enter that value below. Your printer's scaling doesn't matter as long as you measure.</li>
          <li>Mount the kiosk camera in its final position. Hold the marker flat and upright where customers will stand,
            at chest height, facing the camera.</li>
          <li>Press “Capture & detect”, check the outline, then save.</li>
          <li>Recalibrate whenever the camera is moved, zoomed, or its resolution setting changes.</li>
        </ol>
        <details className="guidance">
          <summary>What calibration can and cannot do</summary>
          <ul>
            <li>The scale is only correct at the marker's distance. A customer standing closer or further away will be over- or under-estimated.</li>
            <li>A single front camera sees width, not depth, so chest circumference is approximated.</li>
            <li>Lens distortion is not corrected (no checkerboard calibration). Keep customers near the center of the frame.</li>
          </ul>
        </details>
      </section>

      {config && <CalibrationCamera config={config} onSaved={setActive} />}
    </>
  );
}
