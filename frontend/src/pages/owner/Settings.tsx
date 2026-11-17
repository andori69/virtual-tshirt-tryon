import { useEffect, useState, type FormEvent } from 'react';
import { Problems } from '../../components/common';
import { api, ApiError } from '../../services/api';

type Settings = Record<string, Record<string, unknown>> & { defaults: Record<string, Record<string, unknown>> };

const LABELS: Record<string, Record<string, string>> = {
  fit_rules: {
    ease_tight_max_cm: 'Tight below (cm of chest ease)',
    ease_regular_max_cm: 'Regular up to (cm)',
    ease_relaxed_max_cm: 'Relaxed up to (cm); above is oversized',
    preferred_fit: 'Recommend sizes for this fit',
    shoulder_landmark_factor: 'Shoulder seam ÷ shoulder-joint span',
    body_depth_ratio: 'Chest depth ÷ visible chest width',
    shoulder_tight_cm: 'Shoulder-only: tight below (cm)',
    shoulder_relaxed_cm: 'Shoulder-only: regular up to (cm)',
    shoulder_oversized_cm: 'Shoulder-only: relaxed up to (cm)',
    min_confidence: 'Minimum confidence to recommend (0–1)',
  },
  store: {
    default_currency: 'Default currency (ISO code)',
    low_stock_threshold: 'Low-stock threshold (units)',
    kiosk_idle_reset_s: 'End kiosk session after no one is seen for (s)',
  },
  camera: { width: 'Width (px)', height: 'Height (px)', frame_rate: 'Frame rate (fps)' },
  measurement_limits: {
    chest_width_cm: 'Chest width', shoulder_width_cm: 'Shoulder width', length_cm: 'Body length',
    sleeve_length_cm: 'Sleeve length', sleeve_opening_cm: 'Sleeve opening',
  },
};
const TITLES: Record<string, string> = {
  store: 'Store', camera: 'Kiosk camera (recalibrate after changing)', fit_rules: 'Size recommendation rules',
  measurement_limits: 'Allowed measurement range (cm, min–max)',
};

function SettingsSection({ name, value, defaults }: { name: string; value: Record<string, unknown>; defaults: Record<string, unknown> }) {
  const [form, setForm] = useState<Record<string, unknown>>(value);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      setForm(await api(`/api/owner/settings/${name}`, { method: 'PUT', json: form }));
      setMsg('Saved');
    } catch (x) {
      setErr(x as ApiError);
    }
  };

  return (
    <form className="card form-grid" onSubmit={save}>
      <h2 className="span-2">{TITLES[name]}</h2>
      {Object.keys(LABELS[name]).map((k) => {
        const v = form[k];
        const label = LABELS[name][k];
        if (k === 'preferred_fit') {
          return (
            <label key={k}>{label}
              <select value={String(v)} onChange={(e) => setForm({ ...form, [k]: e.target.value })}>
                {['tight', 'regular', 'relaxed', 'oversized'].map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
          );
        }
        if (Array.isArray(v)) {
          return (
            <label key={k}>{label}
              <span className="row">
                {[0, 1].map((i) => (
                  <input key={i} type="number" step="0.5" className="qty" value={String(v[i])} aria-label={`${label} ${i ? 'max' : 'min'}`}
                    onChange={(e) => { const n = [...v]; n[i] = Number(e.target.value); setForm({ ...form, [k]: n }); }} />
                ))}
              </span>
            </label>
          );
        }
        return (
          <label key={k}>{label}
            <input type={typeof defaults[k] === 'number' ? 'number' : 'text'} step="any" value={String(v)}
              onChange={(e) => setForm({ ...form, [k]: typeof defaults[k] === 'number' ? Number(e.target.value) : e.target.value })} />
          </label>
        );
      })}
      {err && <div className="span-2"><p className="error" role="alert">{err.message}</p><Problems items={err.problems} /></div>}
      <div className="span-2 row">
        <button className="btn btn-primary">Save</button>
        <button type="button" className="btn btn-ghost" onClick={() => setForm(defaults)}>Restore defaults</button>
        {msg && <span className="ok">{msg}</span>}
      </div>
    </form>
  );
}

function PasswordForm() {
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    setErr(null);
    try {
      await api('/api/auth/change-password', { method: 'POST', json: { current_password: cur, new_password: next } });
      setMsg('Password changed.');
      setCur('');
      setNext('');
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2 className="span-2">Change password</h2>
      <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
      <label>New password (10+ characters)<input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required /></label>
      {err && <p className="error span-2" role="alert">{err}</p>}
      <div className="span-2 row"><button className="btn btn-primary">Change password</button>{msg && <span className="ok">{msg}</span>}</div>
    </form>
  );
}

export default function SettingsPage() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<Settings>('/api/owner/settings').then(setS).catch((e) => setError(e.message));
  }, []);
  if (error) return <p className="error">{error}</p>;
  if (!s) return <p className="muted">Loading…</p>;
  return (
    <>
      <header className="page-head"><h1>Settings</h1></header>
      {['store', 'camera', 'fit_rules', 'measurement_limits'].map((k) => (
        <SettingsSection key={k} name={k} value={s[k]} defaults={s.defaults[k]} />
      ))}
      <section className="card">
        <h2>How the fit estimate works</h2>
        <p>Chest ease = 2 × garment flat chest width − estimated body chest circumference. The body circumference is an
          ellipse estimate from the visible chest width and the depth ratio above. Ease bands decide Tight / Regular /
          Relaxed / Oversized; the recommended size is the one closest to the middle of the preferred band.</p>
      </section>
      <PasswordForm />
    </>
  );
}
