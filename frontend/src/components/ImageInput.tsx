import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useCamera } from '../hooks/useCamera';

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_MB = 15;

export function GuidanceList() {
  return (
    <details className="guidance">
      <summary>How to photograph a T-shirt</summary>
      <ul>
        <li>Photograph the front of the shirt, with the whole garment in frame — sleeves and hem included.</li>
        <li>Lay it flat or hang it straight; smooth out folds.</li>
        <li>Use a plain background that contrasts with the shirt color.</li>
        <li>Use even, bright light. Avoid strong shadows and anything covering the shirt.</li>
        <li>Hold the camera level with the garment, pointing straight at it.</li>
      </ul>
    </details>
  );
}

/** Client-side pre-check for fast feedback; the server re-validates the actual image content. */
export function precheckFile(file: File): string | null {
  if (!ACCEPT.includes(file.type)) return 'Choose a PNG, JPG or WEBP image.';
  if (file.size > MAX_MB * 1024 * 1024) return `The image is larger than ${MAX_MB} MB.`;
  if (file.size === 0) return 'The file is empty.';
  return null;
}

function UploadPane({ onSubmit, busy }: { onSubmit: (f: File) => void; busy: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const choose = (f: File | undefined) => {
    if (!f) return;
    const problem = precheckFile(f);
    setError(problem);
    if (problem) return;
    setFile(f);
    setPreview(URL.createObjectURL(f));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    choose(e.dataTransfer.files[0]);
  };

  return (
    <div>
      {!preview ? (
        <div
          className={`dropzone ${over ? 'is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <p>Drag a photo here, or</p>
          <button type="button" className="btn" onClick={() => inputRef.current?.click()}>Choose file</button>
          <input ref={inputRef} type="file" accept={ACCEPT.join(',')} hidden aria-label="Garment image file"
            onChange={(e) => choose(e.target.files?.[0])} />
          <p className="muted small">PNG, JPG or WEBP · up to {MAX_MB} MB</p>
        </div>
      ) : (
        <div className="capture-preview">
          <img src={preview} alt="Selected garment" />
          <div className="row">
            <button type="button" className="btn" disabled={busy} onClick={() => { setFile(null); setPreview(null); }}>Choose another</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => file && onSubmit(file)}>
              {busy ? 'Processing…' : 'Confirm & process'}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function CameraPane({ onSubmit, busy }: { onSubmit: (f: File) => void; busy: boolean }) {
  const cam = useCamera({ width: 1920, height: 1080, storageKey: 'vfr.owner.captureCamera' });
  const [shot, setShot] = useState<{ blob: Blob; url: string } | null>(null);
  const { start, stop } = cam;

  useEffect(() => {
    start();
    return stop;
  }, [start, stop]);
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  const capture = () => {
    const v = cam.videoRef.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    c.toBlob((b) => b && setShot({ blob: b, url: URL.createObjectURL(b) }), 'image/jpeg', 0.95);
  };

  return (
    <div>
      {cam.devices.length > 1 && (
        <label className="inline">
          Camera
          <select value={cam.deviceId} onChange={(e) => cam.setDeviceId(e.target.value)}>
            <option value="">Default</option>
            {cam.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
          </select>
        </label>
      )}
      <div className="capture-preview">
        <video ref={cam.videoRef} playsInline muted hidden={!!shot} aria-label="Camera preview" />
        {shot && <img src={shot.url} alt="Captured garment" />}
        {cam.status === 'starting' && <p className="muted">Starting camera…</p>}
        {cam.status === 'error' && (
          <div role="alert" className="error">
            <p>{cam.error}</p>
            <button type="button" className="btn" onClick={() => cam.start()}>Retry</button>
          </div>
        )}
      </div>
      {cam.actual && <p className="muted small">{cam.actual.label} · {cam.actual.width}×{cam.actual.height}</p>}
      <div className="row">
        {!shot ? (
          <button type="button" className="btn btn-primary" disabled={cam.status !== 'live'} onClick={capture}>Capture</button>
        ) : (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => setShot(null)}>Retake</button>
            <button type="button" className="btn btn-primary" disabled={busy}
              onClick={() => onSubmit(new File([shot.blob], 'capture.jpg', { type: 'image/jpeg' }))}>
              {busy ? 'Processing…' : 'Confirm & process'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ImageInput({ onSubmit, busy }: { onSubmit: (f: File) => void; busy: boolean }) {
  const [mode, setMode] = useState<'upload' | 'camera'>('upload');
  return (
    <div className="image-input">
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'upload'} className={mode === 'upload' ? 'is-active' : ''}
          onClick={() => setMode('upload')}>Upload photo</button>
        <button type="button" role="tab" aria-selected={mode === 'camera'} className={mode === 'camera' ? 'is-active' : ''}
          onClick={() => setMode('camera')}>Use camera</button>
      </div>
      <GuidanceList />
      {mode === 'upload' ? <UploadPane onSubmit={onSubmit} busy={busy} /> : <CameraPane onSubmit={onSubmit} busy={busy} />}
    </div>
  );
}
