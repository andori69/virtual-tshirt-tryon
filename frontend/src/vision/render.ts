import type { Point } from '../types';
import { len, mid, sub } from './geometry';

export type Occluders = {
  head: { nose: Point; eyes: Point | null; mouth: Point | null; ears: [Point | null, Point | null] } | null;
};

/** Ellipse covering the face from forehead to chin. */
export function headEllipse(head: NonNullable<Occluders['head']>, shoulderSpan: number) {
  const { nose, eyes, mouth, ears } = head;
  const headW = ears[0] && ears[1] ? len(sub(ears[1], ears[0])) * 1.25 : shoulderSpan * 0.55;
  const top = eyes ? eyes.y - headW * 0.55 : nose.y - headW * 0.75;
  const chin = mouth ? mouth.y + (mouth.y - (eyes?.y ?? nose.y)) * 1.1 : nose.y + headW * 0.6;
  const cx = mid(ears[0] ?? nose, ears[1] ?? nose).x;
  return { center: { x: cx, y: (top + chin) / 2 }, rx: headW / 2, ry: (chin - top) / 2, chinY: chin };
}

export function drawLandmarks(ctx: CanvasRenderingContext2D, pts: Point[], bones: [Point, Point][]) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.lineWidth = 3;
  for (const [a, b] of bones) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.fillStyle = '#ffb547';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }
}
