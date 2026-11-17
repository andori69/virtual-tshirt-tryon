import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FittingStage, { type StageDebug, type StageUpdate, type TrackingState } from '../../components/FittingStage';
import { CatalogList, ColorPicker, FitPanel, ShirtInfo, ShirtPicker, SizePicker, StylePicker } from '../../components/kiosk';
import { api, formatPrice } from '../../services/api';
import type { CatalogProduct, CatalogVariant, KioskConfig, Recommendation, SizeLabel, WardrobeItem } from '../../types';
import { referenceSize } from '../../vision/geometry';
import type { Style } from '../../vision/tryon/shirt';

const TRACKING_TEXT: Record<TrackingState, string> = {
  loading: 'Starting…',
  'no-person': 'No one detected',
  detecting: 'Detecting…',
  tracking: 'Tracking',
  lost: 'Tracking lost',
  error: 'Tracking unavailable',
};
const MIN_SAMPLES = 15;
const RECOMMEND_EVERY_MS = 4000;

export default function Kiosk() {
  const [config, setConfig] = useState<KioskConfig | null>(null);
  const [catalog, setCatalog] = useState<CatalogProduct[]>([]);
  const [shirts, setShirts] = useState<WardrobeItem[]>([]);
  const [shirtId, setShirtId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [sizeLabel, setSizeLabel] = useState<SizeLabel | null>(null);
  const [rec, setRec] = useState<Recommendation | null>(null);
  const [stage, setStage] = useState<StageUpdate | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [showStats, setShowStats] = useState(false);
  const [realism, setRealism] = useState(true);
  const [style, setStyle] = useState<Style>('regular');
  const [debug, setDebug] = useState<StageDebug>({});
  const lastRecAt = useRef(0);
  const noPersonSince = useRef<number | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      const [cfg, items, folder] = await Promise.all([
        api<KioskConfig>('/api/kiosk/config'),
        api<CatalogProduct[]>('/api/catalog'),
        api<WardrobeItem[]>('/api/wardrobe'),
      ]);
      setConfig(cfg);
      setCatalog(items);
      setShirts(folder);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadCatalog();
    const id = setInterval(loadCatalog, 60_000); // pick up owner changes without a reload
    return () => clearInterval(id);
  }, [loadCatalog]);

  // Newly dropped shirt files are processed in the background; poll until they are ready.
  const preparing = shirts.some((s) => s.status === 'processing');
  useEffect(() => {
    if (!preparing) return;
    const id = setInterval(() => api<WardrobeItem[]>('/api/wardrobe').then(setShirts).catch(() => undefined), 3000);
    return () => clearInterval(id);
  }, [preparing]);

  useEffect(() => {
    // Staff shortcuts: Alt+D stats overlay, Alt+R toggle scene-matched lighting (for comparison).
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.code === 'KeyD') setShowStats((s) => !s);
      if (e.code === 'KeyR') setRealism((r) => !r);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shirt = shirts.find((s) => s.id === shirtId && s.status === 'ready') ?? null;
  const product = catalog.find((p) => p.id === productId) ?? null;
  const variant: CatalogVariant | null = product?.variants.find((v) => v.id === variantId) ?? product?.variants[0] ?? null;
  const size = product?.size_chart.find((s) => s.label === sizeLabel) ?? null;
  const reference = product ? referenceSize(product.size_chart) : null;
  const recommended = rec?.status === 'ok' ? rec.recommended_available : null;

  // If a refresh removed the selection (unpublished, sold out), fall back gracefully.
  useEffect(() => {
    if (productId !== null && !product) {
      setProductId(null);
      setSizeLabel(null);
    } else if (variant && sizeLabel && !variant.sizes.find((s) => s.label === sizeLabel)?.available) {
      setSizeLabel(variant.sizes.find((s) => s.available)?.label ?? null);
    }
  }, [product, productId, variant, sizeLabel]);

  const selectShirt = (s: WardrobeItem) => {
    setShirtId(s.id);
    setProductId(null);
    setSizeLabel(null);
    setRec(null);
  };

  const selectProduct = (p: CatalogProduct) => {
    setShirtId(null);
    setProductId(p.id);
    setVariantId(p.variants[0].id);
    setRec(null);
    lastRecAt.current = 0;
    const firstAvailable = p.variants[0].sizes.find((s) => s.available)?.label ?? null;
    setSizeLabel(firstAvailable);
  };

  const reset = useCallback(() => {
    // Ends the customer session: selection, recommendation and in-memory body samples are discarded.
    setProductId(null);
    setShirtId(null);
    setVariantId(null);
    setSizeLabel(null);
    setRec(null);
    lastRecAt.current = 0;
    setSessionKey((k) => k + 1);
    loadCatalog();
  }, [loadCatalog]);

  const onStage = useCallback((u: StageUpdate) => setStage(u), []);

  // Size recommendation, refreshed while the customer is tracked.
  useEffect(() => {
    if (!stage?.body || !stage.frame || !product || !variant) return;
    if (stage.body.samples < MIN_SAMPLES || Date.now() - lastRecAt.current < RECOMMEND_EVERY_MS) return;
    lastRecAt.current = Date.now();
    api<Recommendation>('/api/fitting/recommend', {
      method: 'POST',
      json: {
        product_id: product.id,
        variant_id: variant.id,
        body: { ...stage.body, frame_width: stage.frame.width, frame_height: stage.frame.height },
      },
    })
      .then((r) => {
        setRec(r);
        if (r.status === 'ok' && r.recommended_available && !sizeLabel) setSizeLabel(r.recommended_available);
      })
      .catch(() => setRec({ status: 'insufficient', reason: 'Size estimate is unavailable right now.' }));
  }, [stage, product, variant, sizeLabel]);

  // Idle timeout: nobody in front of the camera for a while ends the session.
  useEffect(() => {
    if (!config || !stage) return;
    const idle = stage.tracking === 'no-person';
    if (!idle) {
      noPersonSince.current = null;
      return;
    }
    noPersonSince.current ??= Date.now();
    if ((productId !== null || shirtId !== null || rec) && Date.now() - noPersonSince.current > config.idle_reset_s * 1000) reset();
  }, [stage, config, productId, shirtId, rec, reset]);

  const garment = useMemo(() => {
    if (shirt?.garment_url && shirt.anchors) {
      return { url: shirt.garment_url, backUrl: shirt.back_url, meshUrl: shirt.mesh_url, anchors: shirt.anchors,
        color: shirt.attributes?.base_color_hex, sleeve: shirt.attributes?.sleeve_length };
    }
    return variant ? { url: variant.garment_url, anchors: variant.anchors, color: variant.color_hex } : null;
  }, [variant, shirt]);

  if (!config) {
    return (
      <div className="kiosk kiosk-loading">
        {loadError ? (
          <div role="alert">
            <p>{loadError}</p>
            <button className="btn" onClick={loadCatalog}>Try again</button>
          </div>
        ) : <p>Loading…</p>}
      </div>
    );
  }

  const tracking = stage?.tracking ?? 'loading';
  const showWelcome = tracking === 'no-person' || tracking === 'loading';

  return (
    <div className="kiosk">
      <header className="kiosk-bar">
        <h1>Virtual Fitting Room</h1>
        <div className="pills">
          <span className={`pill pill-${tracking}`}>{TRACKING_TEXT[tracking]}</span>
          {stage && !stage.inFrame && tracking === 'tracking' && <span className="pill pill-lost">Step back a little</span>}
          {!config.calibration && <span className="pill pill-warn">Size estimates off (not calibrated)</span>}
        </div>
        <button className="btn btn-ghost kiosk-reset" onClick={reset}>End session</button>
      </header>

      <main className="kiosk-main">
        <div className="kiosk-stage">
          <FittingStage
            config={config}
            garment={garment}
            size={size}
            reference={reference}
            sessionKey={sessionKey}
            onUpdate={onStage}
            cameraStorageKey="vfr.kiosk.camera"
            realism={realism}
            style={style}
            debug={debug}
          />
          {showWelcome && (
            <div className="welcome">
              <h2>Try on a T-shirt</h2>
              <p>Stand about 2 metres from the screen, facing it.</p>
              <p>Keep your shoulders and hips in view and hold your arms slightly away from your body.</p>
            </div>
          )}
          {product?.is_sample && <div className="stage-banner">Sample product</div>}
          {tracking === 'tracking' && stage?.stepBack && garment && (
            <>
              <svg className="step-guide" viewBox="0 0 100 220" aria-hidden="true">
                <path d="M50 8a16 16 0 1 1 0 32a16 16 0 1 1 0-32M30 48h40l14 10l-4 60l-8 0l-2 50l-6 46h-12l-2-46h-0l-2 46h-12l-6-46l-2-50l-8 0l-4-60z" />
              </svg>
              <div className="stage-banner stage-banner-low" role="status">Step back: fit your shoulders and hips inside the outline</div>
            </>
          )}
          {tracking === 'tracking' && !stage?.stepBack && stage?.bulkyTop && garment && (
            <div className="stage-banner stage-banner-low" role="status">Wear a plain fitted top for the best result</div>
          )}
          {showStats && stage && (
            <div className="stats">
              <div>
                {stage.frame?.width}×{stage.frame?.height} · {stage.fps} fps · detect {stage.latencyMs} ms · {stage.delegate}
                {' '}· {stage.renderer ?? '—'}{realism ? '' : ' (lighting off)'}
                {stage.body && <> · samples {stage.body.samples}</>}
              </div>
              {stage.light && (
                <div>
                  light: exposure {stage.light.exposure.toFixed(2)} · contrast {stage.light.contrast.toFixed(2)} · tint{' '}
                  {stage.light.tint.map((v) => v.toFixed(2)).join('/')} · dir {stage.light.lightDir.map((v) => v.toFixed(2)).join(', ')}
                </div>
              )}
              <div className="stats-toggles">
                {(['landmarks', 'mask', 'wireframe'] as const).map((k) => (
                  <label key={k}>
                    <input type="checkbox" checked={!!debug[k]} onChange={(e) => setDebug((d) => ({ ...d, [k]: e.target.checked }))} /> {k}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>

        <aside className="kiosk-panel">
          {loadError && <p className="error" role="alert">{loadError}</p>}
          <h2 className="panel-title">Shirts</h2>
          <ShirtPicker items={shirts} selectedId={shirtId} onSelect={selectShirt} />
          {shirt && <ShirtInfo shirt={shirt} />}
          {garment && <StylePicker value={style} onChange={setStyle} />}

          {catalog.length > 0 && (
            <>
              <h2 className="panel-title">Store catalog</h2>
              <CatalogList products={catalog} selectedId={productId} onSelect={selectProduct} />
            </>
          )}

          {product && variant && (
            <section className="product-info">
              <div className="product-head">
                <div>
                  <h3>{product.name}</h3>
                  {product.brand && <p className="muted">{product.brand}</p>}
                </div>
                <p className="price">{formatPrice(product.price, product.currency)}</p>
              </div>
              {product.description && <p className="desc">{product.description}</p>}
              <ColorPicker
                variants={product.variants}
                selectedId={variant.id}
                onSelect={(v) => {
                  setVariantId(v.id);
                  if (sizeLabel && !v.sizes.find((s) => s.label === sizeLabel)?.available) {
                    setSizeLabel(v.sizes.find((s) => s.available)?.label ?? null);
                  }
                }}
              />
              <SizePicker sizes={variant.sizes} selected={sizeLabel} recommended={recommended} onSelect={setSizeLabel} />
              <FitPanel size={size} rec={rec} waiting={tracking === 'tracking'} />
              <p className="disclaimer">
                The virtual shirt is an approximation from one product photo. It does not show how fabric drapes.
              </p>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}
