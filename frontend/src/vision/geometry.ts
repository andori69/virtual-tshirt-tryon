import type { Point, SizeChartRow } from '../types';

export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const scale = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k });
export const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const len = (a: Point): number => Math.hypot(a.x, a.y);
export const unit = (a: Point): Point => scale(a, 1 / (len(a) || 1));

/** Middle size of the chart, used as the uncalibrated reference. */
export function referenceSize(chart: SizeChartRow[]): SizeChartRow {
  return chart[Math.floor((chart.length - 1) / 2)];
}
