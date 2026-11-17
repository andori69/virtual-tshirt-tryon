import type { CatalogProduct, CatalogVariant, Recommendation, SizeChartRow, SizeLabel, WardrobeItem } from '../types';
import type { Style } from '../vision/tryon/shirt';

/** Thumbnail grid of shirts found in the ./Tshirts folder. */
export function ShirtPicker({ items, selectedId, onSelect }: {
  items: WardrobeItem[];
  selectedId: string | null;
  onSelect: (s: WardrobeItem) => void;
}) {
  if (!items.length) return <p className="empty">No shirt images found in the Tshirts folder.</p>;
  return (
    <ul className="catalog" aria-label="Shirts">
      {items.map((s) => (
        <li key={s.id}>
          <button
            className={`catalog-card ${s.id === selectedId ? 'is-selected' : ''}`}
            onClick={() => s.status === 'ready' && onSelect(s)}
            aria-pressed={s.id === selectedId}
            disabled={s.status !== 'ready'}
            title={s.status === 'failed' ? s.error ?? 'Could not be processed' : undefined}
          >
            {s.thumb_url ? <img src={s.thumb_url} alt="" /> : <span className="catalog-wait">{s.status === 'failed' ? 'Could not process' : 'Preparing…'}</span>}
            <span className="catalog-name">{s.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const STYLE_LABELS: Record<Style, string> = { slim: 'Slim', regular: 'Regular', oversized: 'Oversized' };

/** How loose the shirt is drawn around the body. */
export function StylePicker({ value, onChange }: { value: Style; onChange: (s: Style) => void }) {
  return (
    <div className="sizes styles" role="radiogroup" aria-label="Fit">
      {(Object.keys(STYLE_LABELS) as Style[]).map((s) => (
        <button key={s} role="radio" aria-checked={s === value} className={`size-btn ${s === value ? 'is-selected' : ''}`} onClick={() => onChange(s)}>
          {STYLE_LABELS[s]}
        </button>
      ))}
    </div>
  );
}

export function ShirtInfo({ shirt }: { shirt: WardrobeItem }) {
  const a = shirt.attributes ?? {};
  const chips = [
    a.base_color_name && { label: a.base_color_name, color: a.base_color_hex },
    a.sleeve_length && { label: `${a.sleeve_length} sleeve` },
    a.neckline && { label: a.neckline },
    a.print?.has_print && { label: `${a.print.color_name ?? ''} print`.trim() },
  ].filter(Boolean) as { label: string; color?: string }[];
  return (
    <section className="product-info">
      <h3>{shirt.label}</h3>
      <div className="chips">
        {chips.map((c) => (
          <span key={c.label} className="chip">
            {c.color && <span className="swatch-dot" style={{ background: c.color }} />}
            {c.label}
          </span>
        ))}
      </div>
      <p className="muted">Fitted to your body. This shirt has no size chart, so no size is suggested.</p>
      <p className="disclaimer">Attributes are detected automatically from the photo and may be imperfect.</p>
    </section>
  );
}
import { formatPrice } from '../services/api';

export function CatalogList({ products, selectedId, onSelect }: {
  products: CatalogProduct[];
  selectedId: number | null;
  onSelect: (p: CatalogProduct) => void;
}) {
  if (!products.length) {
    return <p className="empty">No T-shirts are available right now. Please ask a staff member.</p>;
  }
  return (
    <ul className="catalog" aria-label="T-shirts">
      {products.map((p) => (
        <li key={p.id}>
          <button
            className={`catalog-card ${p.id === selectedId ? 'is-selected' : ''}`}
            onClick={() => onSelect(p)}
            aria-pressed={p.id === selectedId}
          >
            <img src={p.variants[0].thumb_url} alt="" />
            <span className="catalog-name">{p.name}</span>
            <span className="catalog-price">{formatPrice(p.price, p.currency)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ColorPicker({ variants, selectedId, onSelect }: {
  variants: CatalogVariant[];
  selectedId: number | null;
  onSelect: (v: CatalogVariant) => void;
}) {
  return (
    <div className="swatches" role="radiogroup" aria-label="Color">
      {variants.map((v) => (
        <button
          key={v.id}
          role="radio"
          aria-checked={v.id === selectedId}
          className={`swatch ${v.id === selectedId ? 'is-selected' : ''}`}
          onClick={() => onSelect(v)}
        >
          <span className="swatch-dot" style={{ background: v.color_hex }} />
          {v.color_name}
        </button>
      ))}
    </div>
  );
}

export function SizePicker({ sizes, selected, recommended, onSelect }: {
  sizes: CatalogVariant['sizes'];
  selected: SizeLabel | null;
  recommended: SizeLabel | null;
  onSelect: (label: SizeLabel) => void;
}) {
  return (
    <div className="sizes" role="radiogroup" aria-label="Size">
      {sizes.map((s) => (
        <button
          key={s.label}
          role="radio"
          aria-checked={s.label === selected}
          disabled={!s.available}
          className={`size-btn ${s.label === selected ? 'is-selected' : ''}`}
          onClick={() => s.available && onSelect(s.label)}
          title={s.available ? undefined : 'Out of stock'}
        >
          <span>{s.label}</span>
          {!s.available && <small>Sold out</small>}
          {s.available && s.low_stock && <small>Few left</small>}
          {s.available && s.label === recommended && <small className="size-rec">Suggested</small>}
        </button>
      ))}
    </div>
  );
}

const FIT_LABEL = { tight: 'Tight', regular: 'Regular', relaxed: 'Relaxed', oversized: 'Oversized' } as const;

export function FitPanel({ size, rec, waiting }: {
  size: SizeChartRow | null;
  rec: Recommendation | null;
  waiting: boolean;
}) {
  const fit = rec?.status === 'ok' && size ? rec.sizes.find((s) => s.label === size.label) : null;
  return (
    <section className="fit-panel" aria-live="polite">
      {size && (
        <dl className="measurements">
          <div><dt>Chest (flat)</dt><dd>{size.chest_width_cm} cm</dd></div>
          <div><dt>Shoulder</dt><dd>{size.shoulder_width_cm} cm</dd></div>
          <div><dt>Length</dt><dd>{size.length_cm} cm</dd></div>
          <div><dt>Sleeve</dt><dd>{size.sleeve_length_cm} cm</dd></div>
        </dl>
      )}
      {waiting && !rec && <p className="muted">Stand still facing the camera to get a size estimate…</p>}
      {rec?.status === 'insufficient' && <p className="muted">{rec.reason}</p>}
      {rec?.status === 'ok' && (
        <>
          <p className="fit-headline">
            Suggested size <strong>{rec.recommended_available ?? rec.recommended}</strong>
            {fit && <> · {size?.label} looks <strong>{FIT_LABEL[fit.fit]}</strong></>}
          </p>
          <p className="fit-explain">{rec.explanation}</p>
          <p className={`confidence confidence-${rec.confidence_label}`}>
            Estimate confidence: {rec.confidence_label} ({Math.round(rec.confidence * 100)}%)
          </p>
          <details>
            <summary>How is this estimated?</summary>
            <ul>{rec.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            <p>This is an estimate from a single camera, not a measurement. Fit is not guaranteed — try the shirt on if unsure.</p>
          </details>
        </>
      )}
    </section>
  );
}
