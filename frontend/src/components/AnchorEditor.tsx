import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ANCHOR_KEYS, type AnchorKey, type Anchors, type Point } from '../types';

export const ANCHOR_LABELS: Record<AnchorKey, string> = {
  left_shoulder: 'Shoulder seam (picture left)',
  right_shoulder: 'Shoulder seam (picture right)',
  neckline_center: 'Neckline center',
  left_sleeve: 'Sleeve edge (picture left)',
  right_sleeve: 'Sleeve edge (picture right)',
  left_hem: 'Hem corner (picture left)',
  right_hem: 'Hem corner (picture right)',
  bottom_center: 'Bottom center',
};

const LINES: [AnchorKey, AnchorKey][] = [
  ['left_sleeve', 'left_shoulder'], ['left_shoulder', 'neckline_center'], ['neckline_center', 'right_shoulder'],
  ['right_shoulder', 'right_sleeve'], ['left_hem', 'bottom_center'], ['bottom_center', 'right_hem'],
];

type Props = {
  imageUrl: string;
  anchors: Anchors;
  onChange: (a: Anchors) => void;
  cropMode?: boolean;
  onCrop?: (rect: { x: number; y: number; w: number; h: number }) => void;
};

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** Drag (mouse/touch) or arrow-key editing of garment anchors, stored as fractions of the image. */
export default function AnchorEditor({ imageUrl, anchors, onChange, cropMode, onCrop }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<AnchorKey | null>(null);
  const [crop, setCrop] = useState<{ a: Point; b: Point } | null>(null);

  const toLocal = (e: PointerEvent): Point => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  const onDown = (e: PointerEvent<SVGSVGElement>) => {
    if (!cropMode) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toLocal(e);
    setCrop({ a: p, b: p });
  };
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (drag) onChange({ ...anchors, [drag]: toLocal(e) });
    else if (cropMode && crop) setCrop({ ...crop, b: toLocal(e) });
  };
  const onUp = () => {
    setDrag(null);
    if (cropMode && crop && onCrop) {
      const x = Math.min(crop.a.x, crop.b.x), y = Math.min(crop.a.y, crop.b.y);
      const w = Math.abs(crop.b.x - crop.a.x), h = Math.abs(crop.b.y - crop.a.y);
      if (w > 0.06 && h > 0.06) onCrop({ x, y, w, h });
      setCrop(null);
    }
  };
  const onKey = (key: AnchorKey) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.02 : 0.004;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const p = anchors[key];
    onChange({ ...anchors, [key]: { x: clamp(p.x + d[0]), y: clamp(p.y + d[1]) } });
  };

  return (
    <div className="anchor-editor checker">
      <img src={imageUrl} alt="Processed garment" draggable={false} />
      <svg
        ref={svgRef}
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
        className={cropMode ? 'is-cropping' : ''}
        role="group"
        aria-label="Garment anchor points"
      >
        {!cropMode && LINES.map(([a, b]) => (
          <line key={a + b} x1={anchors[a].x} y1={anchors[a].y} x2={anchors[b].x} y2={anchors[b].y} className="anchor-line" />
        ))}
        {!cropMode && ANCHOR_KEYS.map((k) => (
          <circle
            key={k}
            cx={anchors[k].x}
            cy={anchors[k].y}
            r={0.016}
            className={`anchor-dot ${drag === k ? 'is-dragging' : ''}`}
            tabIndex={0}
            role="slider"
            aria-label={ANCHOR_LABELS[k]}
            aria-valuetext={`x ${Math.round(anchors[k].x * 100)}%, y ${Math.round(anchors[k].y * 100)}%`}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDrag(k);
            }}
            onKeyDown={onKey(k)}
          >
            <title>{ANCHOR_LABELS[k]}</title>
          </circle>
        ))}
        {crop && (
          <rect
            x={Math.min(crop.a.x, crop.b.x)} y={Math.min(crop.a.y, crop.b.y)}
            width={Math.abs(crop.b.x - crop.a.x)} height={Math.abs(crop.b.y - crop.a.y)}
            className="crop-rect"
          />
        )}
      </svg>
    </div>
  );
}
