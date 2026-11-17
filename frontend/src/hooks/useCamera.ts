import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus = 'idle' | 'starting' | 'live' | 'error';
export type CameraOptions = { width?: number; height?: number; frameRate?: number; storageKey?: string };

export function cameraErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access for this site in the browser settings, then press Retry.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No usable camera was found. Connect a camera, then press Retry.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy or unavailable. Close other apps that use the camera, then press Retry.';
    default:
      if (typeof navigator !== 'undefined' && !navigator.mediaDevices?.getUserMedia) {
        return 'This browser cannot access cameras here. Use Chrome or Safari via http://localhost.';
      }
      return 'The camera could not be started. Press Retry.';
  }
}

function readStored(key?: string): string {
  if (!key) return '';
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Live camera stream with device selection, disconnect detection, restart and cleanup. */
export function useCamera(opts: CameraOptions = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdState] = useState<string>(() => readStored(opts.storageKey));
  const [actual, setActual] = useState<{ width: number; height: number; frameRate: number; label: string } | null>(null);
  const { width, height, frameRate, storageKey } = opts;

  const generation = useRef(0); // bumps on every start/stop so a stale getUserMedia result is discarded

  const stop = useCallback(() => {
    generation.current++;
    streamRef.current?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStatus('idle');
  }, []);

  const refreshDevices = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'videoinput'));
    } catch {
      setDevices([]);
    }
  }, []);

  const start = useCallback(async () => {
    stop();
    const gen = generation.current;
    setStatus('starting');
    setError(null);
    const video: MediaTrackConstraints = {
      width: width ? { ideal: width } : undefined,
      height: height ? { ideal: height } : undefined,
      frameRate: frameRate ? { ideal: frameRate } : undefined,
      deviceId: deviceId ? { exact: deviceId } : undefined,
    };
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (e) {
        // A remembered camera may be unplugged; fall back to any camera once.
        const name = (e as { name?: string }).name;
        if (!deviceId || (name !== 'OverconstrainedError' && name !== 'NotFoundError')) throw e;
        stream = await navigator.mediaDevices.getUserMedia({ video: { ...video, deviceId: undefined }, audio: false });
      }
      if (gen !== generation.current) {
        stream.getTracks().forEach((t) => t.stop()); // superseded by a newer start/stop
        return;
      }
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () => {
        setStatus('error');
        setError('The camera was disconnected. Reconnect it, then press Retry.');
      };
      const s = track.getSettings();
      setActual({ width: s.width ?? 0, height: s.height ?? 0, frameRate: s.frameRate ?? 0, label: track.label });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setStatus('live');
      refreshDevices(); // labels are only available after permission is granted
    } catch (e) {
      if (gen !== generation.current) return;
      setStatus('error');
      setError(cameraErrorMessage(e));
    }
  }, [deviceId, width, height, frameRate, stop, refreshDevices]);

  const setDeviceId = useCallback((id: string) => {
    setDeviceIdState(id);
    if (storageKey) {
      try {
        localStorage.setItem(storageKey, id);
      } catch {
        /* storage unavailable: selection just isn't remembered */
      }
    }
  }, [storageKey]);

  useEffect(() => {
    if (!navigator.mediaDevices) return;
    const onChange = () => refreshDevices();
    navigator.mediaDevices.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', onChange);
  }, [refreshDevices]);

  useEffect(() => stop, [stop]);

  return { videoRef, status, error, devices, deviceId, setDeviceId, start, stop, actual };
}
