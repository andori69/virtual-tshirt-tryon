import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AnchorEditor from '../../components/AnchorEditor';
import { Problems, StatusBadge } from '../../components/common';
import FittingStage from '../../components/FittingStage';
import ImageInput from '../../components/ImageInput';
import { api, ApiError, upload } from '../../services/api';
import { SIZE_LABELS, type Anchors, type KioskConfig, type OwnerVariant, type ProductDetail, type SizeChartRow, type SizeLabel } from '../../types';
import { referenceSize } from '../../vision/geometry';

type Busy = string | null;

function useErrors() {
  const [error, setError] = useState<{ message: string; problems: string[] } | null>(null);
  const capture = (e: unknown) => {
    const err = e as ApiError;
    setError({ message: err.message, problems: err.problems ?? [] });
  };
  return { error, setError, capture };
}

// ---------------- details ----------------

function DetailsForm({ product, onSaved, onCreate }: {
  product: ProductDetail | null;
  onSaved?: (p: ProductDetail) => void;
  onCreate?: (p: ProductDetail) => void;
}) {
  const [form, setForm] = useState({
    name: product?.name ?? '',
    brand: product?.brand ?? '',
    description: product?.description ?? '',
    price: product?.price ?? '',
    currency: product?.currency ?? 'PHP',
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const { error, setError, capture } = useErrors();

  useEffect(() => {
    if (!product) api<{ store: { default_currency: string } }>('/api/owner/settings')
      .then((s) => setForm((f) => ({ ...f, currency: s.store.default_currency }))).catch(() => undefined);
  }, [product]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    const body = { ...form, price: form.price === '' ? null : form.price };
    try {
      if (product) {
        onSaved?.(await api<ProductDetail>(`/api/owner/products/${product.id}`, { method: 'PATCH', json: body }));
        setSaved(true);
      } else {
        onCreate?.(await api<ProductDetail>('/api/owner/products', { method: 'POST', json: body }));
      }
    } catch (err) {
      capture(err);
    } finally {
      setBusy(false);
    }
  };
  const field = (k: keyof typeof form) => ({
    value: form[k],
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value }),
  });

  return (
    <form className="card form-grid" onSubmit={submit}>
      <h2>Product details</h2>
      <label className="span-2">Name *<input required maxLength={120} {...field('name')} /></label>
      <label>Brand<input maxLength={120} {...field('brand')} /></label>
      <div className="row">
        <label>Price *<input type="number" min="0" step="0.01" inputMode="decimal" {...field('price')} /></label>
        <label className="narrow">Currency<input maxLength={3} pattern="[A-Z]{3}" {...field('currency')}
          onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} /></label>
      </div>
      <label className="span-2">Description<textarea rows={3} maxLength={4000} {...field('description')} /></label>
      {error && <div className="span-2"><p className="error" role="alert">{error.message}</p><Problems items={error.problems} /></div>}
      <div className="span-2 row">
        <button className="btn btn-primary" disabled={busy}>{product ? 'Save details' : 'Save as Draft'}</button>
        {saved && <span className="ok">Saved</span>}
      </div>
    </form>
  );
}

// ---------------- sizes ----------------

type SizeDraft = Record<SizeLabel, { on: boolean; chest: string; shoulder: string; length: string; sleeve: string; opening: string }>;

function toDraft(rows: SizeChartRow[]): SizeDraft {
  const d = {} as SizeDraft;
  for (const label of SIZE_LABELS) {
    const r = rows.find((x) => x.label === label);
    d[label] = {
      on: !!r,
      chest: r ? String(r.chest_width_cm) : '',
      shoulder: r ? String(r.shoulder_width_cm) : '',
      length: r ? String(r.length_cm) : '',
      sleeve: r ? String(r.sleeve_length_cm) : '',
      opening: r?.sleeve_opening_cm != null ? String(r.sleeve_opening_cm) : '',
    };
  }
  return d;
}

export function validateSizeDraft(d: SizeDraft): { rows: SizeChartRow[]; problems: string[] } {
  const rows: SizeChartRow[] = [];
  const problems: string[] = [];
  for (const label of SIZE_LABELS) {
    const s = d[label];
    if (!s.on) continue;
    const num = (v: string, name: string, optional = false) => {
      if (optional && v.trim() === '') return null;
      const n = Number(v);
      if (v.trim() === '' || !Number.isFinite(n) || n <= 0) {
        problems.push(`${label}: ${name} must be a positive number.`);
        return NaN;
      }
      return n;
    };
    rows.push({
      label,
      chest_width_cm: num(s.chest, 'chest width') as number,
      shoulder_width_cm: num(s.shoulder, 'shoulder width') as number,
      length_cm: num(s.length, 'length') as number,
      sleeve_length_cm: num(s.sleeve, 'sleeve length') as number,
      sleeve_opening_cm: num(s.opening, 'sleeve opening', true),
    });
  }
  if (!rows.length) problems.push('Turn on at least one size.');
  return { rows, problems };
}

function SizesForm({ product, onSaved }: { product: ProductDetail; onSaved: (p: ProductDetail) => void }) {
  const [draft, setDraft] = useState<SizeDraft>(() => toDraft(product.sizes));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const { error, setError, capture } = useErrors();

  const set = (label: SizeLabel, k: keyof SizeDraft[SizeLabel], v: string | boolean) =>
    setDraft({ ...draft, [label]: { ...draft[label], [k]: v } });

  const save = async () => {
    setSaved(false);
    const { rows, problems } = validateSizeDraft(draft);
    if (problems.length) return setError({ message: 'Check the measurements.', problems });
    setBusy(true);
    setError(null);
    try {
      onSaved(await api<ProductDetail>(`/api/owner/products/${product.id}/sizes`, { method: 'PUT', json: rows }));
      setSaved(true);
    } catch (e) {
      capture(e);
    } finally {
      setBusy(false);
    }
  };

  const cols = [['chest', 'Chest width'], ['shoulder', 'Shoulder width'], ['length', 'Body length'],
    ['sleeve', 'Sleeve length'], ['opening', 'Sleeve opening (opt.)']] as const;

  return (
    <section className="card">
      <h2>Sizes & measurements (cm)</h2>
      <details className="guidance">
        <summary>How to measure</summary>
        <ul>
          <li><b>Chest width</b>: lay the shirt flat and measure straight across from armpit to armpit. This is half the
            shirt's circumference — not a body chest measurement.</li>
          <li><b>Shoulder width</b>: seam to seam across the back of the shoulders.</li>
          <li><b>Body length</b>: from the highest point of the shoulder, next to the collar, down to the hem.</li>
          <li><b>Sleeve length</b>: from the shoulder seam to the end of the sleeve.</li>
          <li><b>Sleeve opening</b>: straight across the sleeve end, laid flat.</li>
          <li>Measure your actual stock — brands differ, so don't copy a generic size chart.</li>
        </ul>
      </details>
      <table className="table size-table">
        <thead><tr><th>Size</th>{cols.map(([, h]) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>
          {SIZE_LABELS.map((label) => (
            <tr key={label} className={draft[label].on ? '' : 'is-off'}>
              <td>
                <label className="inline">
                  <input type="checkbox" checked={draft[label].on} onChange={(e) => set(label, 'on', e.target.checked)} />
                  {label}
                </label>
              </td>
              {cols.map(([k, h]) => (
                <td key={k}>
                  <input type="number" min="0" step="0.5" inputMode="decimal" aria-label={`${label} ${h}`}
                    disabled={!draft[label].on} value={draft[label][k]} onChange={(e) => set(label, k, e.target.value)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {error && <><p className="error" role="alert">{error.message}</p><Problems items={error.problems} /></>}
      <div className="row">
        <button className="btn btn-primary" onClick={save} disabled={busy}>Save sizes</button>
        {saved && <span className="ok">Saved</span>}
      </div>
    </section>
  );
}

// ---------------- colors / images / stock ----------------

function VariantCard({ product, variant, onChange }: {
  product: ProductDetail;
  variant: OwnerVariant;
  onChange: (p: ProductDetail) => void;
}) {
  const [busy, setBusy] = useState<Busy>(null);
  const [replacing, setReplacing] = useState(false);
  const [anchors, setAnchors] = useState<Anchors | null>(variant.image?.anchors ?? null);
  const [cropMode, setCropMode] = useState(false);
  const [stock, setStock] = useState<Record<string, string>>(
    Object.fromEntries(product.sizes.map((s) => [s.label, String(variant.stock[s.label] ?? 0)])),
  );
  const [name, setName] = useState(variant.color_name);
  const [hex, setHex] = useState(variant.color_hex);
  const { error, setError, capture } = useErrors();
  const img = variant.image;

  useEffect(() => setAnchors(variant.image?.anchors ?? null), [variant.image?.anchors, variant.image?.updated_at]);
  useEffect(() => setStock(Object.fromEntries(product.sizes.map((s) => [s.label, String(variant.stock[s.label] ?? 0)]))),
    [product.sizes, variant.stock]);

  const run = async (label: string, fn: () => Promise<ProductDetail>) => {
    setBusy(label);
    setError(null);
    try {
      onChange(await fn());
      return true;
    } catch (e) {
      capture(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const uploadImage = async (file: File) => {
    if (await run('process', () => upload<ProductDetail>(`/api/owner/variants/${variant.id}/image`, { file }))) setReplacing(false);
  };
  const adjust = (body: object) => run('adjust', () => api(`/api/owner/images/${img!.id}/adjust`, { method: 'POST', json: body }));
  const saveAnchors = (confirmed: boolean) =>
    run('anchors', () => api(`/api/owner/images/${img!.id}/anchors`, { method: 'PUT', json: { anchors, confirmed } }));
  const saveStock = () => {
    const quantities: Record<string, number> = {};
    for (const [k, v] of Object.entries(stock)) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return setError({ message: `Stock for ${k} must be a whole number ≥ 0.`, problems: [] });
      quantities[k] = n;
    }
    run('stock', () => api(`/api/owner/variants/${variant.id}/stock`, { method: 'PUT', json: { quantities } }));
  };
  const deleteColor = () => {
    if (confirm(`Delete the color "${variant.color_name}" and its images?`)) {
      run('delete', () => api(`/api/owner/variants/${variant.id}`, { method: 'DELETE' }));
    }
  };

  const anchorsDirty = JSON.stringify(anchors) !== JSON.stringify(img?.anchors);

  return (
    <article className="card variant">
      <header className="variant-head">
        <span className="swatch-dot big" style={{ background: hex }} />
        <input aria-label="Color name" value={name} onChange={(e) => setName(e.target.value)} />
        <input aria-label="Color" type="color" value={hex} onChange={(e) => setHex(e.target.value)} />
        {(name !== variant.color_name || hex !== variant.color_hex) && (
          <button className="btn" onClick={() => run('color', () => api(`/api/owner/variants/${variant.id}`,
            { method: 'PATCH', json: { color_name: name, color_hex: hex } }))}>Save color</button>
        )}
        {variant.ready ? <span className="badge badge-published">ready</span> : <span className="badge badge-draft">not ready</span>}
        <button className="btn btn-ghost danger push" onClick={deleteColor} disabled={!!busy}>Delete color</button>
      </header>

      {error && <><p className="error" role="alert">{error.message}</p><Problems items={error.problems} /></>}

      {(!img || replacing) && (
        <>
          <ImageInput onSubmit={uploadImage} busy={busy === 'process'} />
          {busy === 'process' && <p className="muted" role="status">Removing background… this takes a few seconds.</p>}
          {replacing && <button className="btn btn-ghost" onClick={() => setReplacing(false)}>Cancel</button>}
        </>
      )}

      {img && !replacing && (
        <>
          <div className="compare">
            <figure>
              <figcaption>Original</figcaption>
              <img src={img.original_url} alt="Original garment" />
            </figure>
            <figure>
              <figcaption>
                Processed {img.status === 'processed' && !img.anchors_confirmed && '· drag the points to the garment, then confirm'}
              </figcaption>
              {img.status === 'processed' && img.processed_url && anchors ? (
                <AnchorEditor imageUrl={img.processed_url} anchors={anchors} onChange={setAnchors} cropMode={cropMode}
                  onCrop={(rect) => { setCropMode(false); adjust({ crop: rect }); }} />
              ) : img.status === 'processed' && img.processed_url ? (
                <div className="checker"><img src={img.processed_url} alt="Processed garment" /></div>
              ) : (
                <div className="process-failed" role="alert">
                  <p><b>Processing failed.</b> {img.error}</p>
                </div>
              )}
            </figure>
          </div>
          {img.meta?.warnings?.length ? <Problems title="Check the result:" items={img.meta.warnings} /> : null}
          {img.status === 'processed' && !anchors && (
            <p className="error">Anchor points could not be found automatically. Use “Reset anchors”, or retry with a clearer photo.</p>
          )}
          <div className="row wrap">
            {img.status === 'processed' && anchors && (
              <>
                <button className="btn btn-primary" disabled={!!busy} onClick={() => saveAnchors(true)}>
                  {img.anchors_confirmed && !anchorsDirty ? 'Anchors confirmed ✓' : 'Confirm anchors'}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => run('anchors', () => api(`/api/owner/images/${img.id}/anchors/reset`, { method: 'POST' }))}>
                  Reset anchors
                </button>
                <button className="btn" disabled={!!busy} onClick={() => adjust({ rotate_deg: -2 })} aria-label="Rotate 2 degrees counter-clockwise">⟲ 2°</button>
                <button className="btn" disabled={!!busy} onClick={() => adjust({ rotate_deg: 2 })} aria-label="Rotate 2 degrees clockwise">⟳ 2°</button>
                <button className={`btn ${cropMode ? 'is-active' : ''}`} disabled={!!busy} onClick={() => setCropMode(!cropMode)}>
                  {cropMode ? 'Drag a box to keep… (cancel)' : 'Crop'}
                </button>
                <button className="btn" disabled={!!busy} onClick={() => adjust({ reset: true })}>Undo rotate/crop</button>
              </>
            )}
            <button className="btn" disabled={!!busy} onClick={() => run('process', () => api(`/api/owner/images/${img.id}/reprocess`, { method: 'POST' }))}>
              {busy === 'process' ? 'Processing…' : 'Retry processing'}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => setReplacing(true)}>Replace image</button>
          </div>
          {busy === 'adjust' && <p className="muted" role="status">Updating image…</p>}
        </>
      )}

      <h3>Stock</h3>
      {product.sizes.length === 0 ? <p className="muted">Add sizes first.</p> : (
        <div className="stock-row">
          {product.sizes.map((s) => (
            <label key={s.label} className={Number(stock[s.label]) === 0 ? 'is-out' : ''}>
              {s.label}
              <input type="number" min="0" step="1" value={stock[s.label] ?? '0'}
                onChange={(e) => setStock({ ...stock, [s.label]: e.target.value })} />
            </label>
          ))}
          <button className="btn" onClick={saveStock} disabled={!!busy}>Save stock</button>
        </div>
      )}
    </article>
  );
}

function AddColor({ productId, onChange }: { productId: number; onChange: (p: ProductDetail) => void }) {
  const [name, setName] = useState('');
  const [hex, setHex] = useState('#555555');
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onChange(await api<ProductDetail>(`/api/owner/products/${productId}/variants`, { method: 'POST', json: { color_name: name, color_hex: hex } }));
      setName('');
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form className="row add-color" onSubmit={add}>
      <input placeholder="Color name, e.g. Navy" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} aria-label="New color name" />
      <input type="color" value={hex} onChange={(e) => setHex(e.target.value)} aria-label="New color" />
      <button className="btn">Add color</button>
      {error && <span className="error">{error}</span>}
    </form>
  );
}

// ---------------- preview ----------------

function PreviewModal({ product, onClose }: { product: ProductDetail; onClose: () => void }) {
  const [config, setConfig] = useState<KioskConfig | null>(null);
  const ready = product.variants.filter((v) => v.image?.status === 'processed' && v.image.anchors);
  const [variantId, setVariantId] = useState(ready[0]?.id);
  const [sizeLabel, setSizeLabel] = useState(product.sizes[0]?.label);
  useEffect(() => {
    api<KioskConfig>('/api/kiosk/config').then(setConfig).catch(() => undefined);
  }, []);
  const v = ready.find((x) => x.id === variantId);
  const size = product.sizes.find((s) => s.label === sizeLabel) ?? null;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Virtual garment preview">
      <div className="modal-body">
        <header className="row">
          <h2>Preview: {product.name}</h2>
          <button className="btn push" onClick={onClose}>Close</button>
        </header>
        {!ready.length || !product.sizes.length ? (
          <p className="muted">Add sizes and a processed garment image to preview.</p>
        ) : (
          <>
            <div className="row">
              <select value={variantId} onChange={(e) => setVariantId(Number(e.target.value))} aria-label="Color">
                {ready.map((x) => <option key={x.id} value={x.id}>{x.color_name}</option>)}
              </select>
              <div className="sizes compact">
                {product.sizes.map((s) => (
                  <button key={s.label} className={`size-btn ${s.label === sizeLabel ? 'is-selected' : ''}`} onClick={() => setSizeLabel(s.label)}>{s.label}</button>
                ))}
              </div>
            </div>
            <p className="muted small">Stand in front of the camera to see the garment as customers will. Landmarks are shown for checking alignment.</p>
            {config && v && (
              <div className="preview-stage">
                <FittingStage config={config} garment={{ url: v.image!.processed_url!, anchors: v.image!.anchors! }}
                  size={size} reference={referenceSize(product.sizes)} sessionKey={0} showLandmarks showCameraPicker />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- page ----------------

export default function ProductEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const { error, setError, capture } = useErrors();
  const isNew = id === 'new';

  const load = useCallback(() => {
    if (isNew) return;
    api<ProductDetail>(`/api/owner/products/${id}`).then(setProduct).catch((e) => setLoadError(e.message));
  }, [id, isNew]);
  useEffect(load, [load]);

  const action = async (path: string, method = 'POST') => {
    setError(null);
    try {
      const p = await api<ProductDetail>(`/api/owner/products/${product!.id}${path}`, { method });
      setProduct(p);
    } catch (e) {
      capture(e);
    }
  };
  const remove = async () => {
    if (!confirm(`Permanently delete "${product!.name}" and all its images? Use Archive to keep a record instead.`)) return;
    try {
      await api(`/api/owner/products/${product!.id}`, { method: 'DELETE' });
      navigate('/owner/products');
    } catch (e) {
      capture(e);
    }
  };

  if (isNew) {
    return (
      <>
        <header className="page-head"><h1>Add New T-shirt</h1></header>
        <p className="muted">Start with the basic details. You can add sizes, colors and photos after saving the draft.</p>
        <DetailsForm product={null} onCreate={(p) => navigate(`/owner/products/${p.id}`, { replace: true })} />
      </>
    );
  }
  if (loadError) return <p className="error" role="alert">{loadError}</p>;
  if (!product) return <p className="muted">Loading…</p>;

  return (
    <div className="editor">
      <header className="page-head">
        <div>
          <h1>{product.name}</h1>
          <StatusBadge status={product.status} /> {product.is_sample && <span className="badge">sample</span>}
        </div>
      </header>

      <div className="editor-grid">
        <div className="editor-main">
          <DetailsForm key={product.id} product={product} onSaved={setProduct} />
          <SizesForm key={`sizes-${product.id}`} product={product} onSaved={setProduct} />
          <section className="card">
            <h2>Colors & garment images</h2>
            <p className="muted small">Each color needs a front photo. The background is removed automatically on this computer.</p>
            {product.variants.map((v) => <VariantCard key={v.id} product={product} variant={v} onChange={setProduct} />)}
            <AddColor productId={product.id} onChange={setProduct} />
          </section>
        </div>

        <aside className="editor-side card">
          <h2>Publishing</h2>
          <p>Status: <StatusBadge status={product.status} /></p>
          {product.publish_ready ? <p className="ok">Ready to publish.</p> : <Problems title="Before publishing:" items={product.publish_problems} />}
          {error && <><p className="error" role="alert">{error.message}</p><Problems items={error.problems} /></>}
          <div className="stack">
            <button className="btn" onClick={() => setPreview(true)}>Preview Virtual Garment</button>
            {product.status === 'published' ? (
              <button className="btn" onClick={() => action('/unpublish')}>Unpublish (back to draft)</button>
            ) : (
              <>
                {product.status === 'archived' && <button className="btn" onClick={() => action('/unpublish')}>Restore as draft</button>}
                <button className="btn btn-primary" onClick={() => action('/publish')} disabled={!product.publish_ready}>Publish Product</button>
              </>
            )}
            {product.status !== 'archived' && <button className="btn" onClick={() => action('/archive')}>Archive</button>}
            <button className="btn danger" onClick={remove}>Delete permanently</button>
          </div>
        </aside>
      </div>
      {preview && <PreviewModal product={product} onClose={() => setPreview(false)} />}
    </div>
  );
}
