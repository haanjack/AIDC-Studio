// r4 stream C: world ↔ screen transform of the 2D view (pure). World is y-up metres: plan = hall-local (x, y); section /
// elevation = (u along the cut, z). Screen is CSS px, y down. `ppm` = screen px per metre.
import type { Rect } from '@aidc/core';

export interface View2DFrame {
  /** world point at the pane centre */
  cx: number;
  cy: number;
  /** CSS px per metre */
  ppm: number;
}

export const PPM_MIN = 0.05;
export const PPM_MAX = 4000;

export const clampPpm = (ppm: number) => Math.min(PPM_MAX, Math.max(PPM_MIN, ppm));

export function worldToScreen(v: View2DFrame, w: number, h: number, x: number, y: number): [number, number] {
  return [w / 2 + (x - v.cx) * v.ppm, h / 2 - (y - v.cy) * v.ppm];
}

export function screenToWorld(v: View2DFrame, w: number, h: number, sx: number, sy: number): [number, number] {
  return [v.cx + (sx - w / 2) / v.ppm, v.cy - (sy - h / 2) / v.ppm];
}

/** World rect visible in a w × h pane. */
export function visibleRect(v: View2DFrame, w: number, h: number): Rect {
  return { x: v.cx - w / 2 / v.ppm, y: v.cy - h / 2 / v.ppm, w: w / v.ppm, d: h / v.ppm };
}

/** Frame that fits `r` in a w × h pane with `pad` (fraction of the pane on each side, default 6 %). */
export function fitRect(r: Rect, w: number, h: number, pad = 0.06): View2DFrame {
  const rw = Math.max(r.w, 1e-3);
  const rd = Math.max(r.d, 1e-3);
  const aw = Math.max(1, w * (1 - 2 * pad));
  const ah = Math.max(1, h * (1 - 2 * pad));
  return { cx: r.x + r.w / 2, cy: r.y + r.d / 2, ppm: clampPpm(Math.min(aw / rw, ah / rd)) };
}

/** Zoom by `factor` keeping the world point under (sx, sy) fixed. */
export function zoomAt(v: View2DFrame, w: number, h: number, sx: number, sy: number, factor: number): View2DFrame {
  const ppm = clampPpm(v.ppm * factor);
  const [wx, wy] = screenToWorld(v, w, h, sx, sy);
  return { ppm, cx: wx - (sx - w / 2) / ppm, cy: wy + (sy - h / 2) / ppm };
}

/** Pan by a screen delta (px). */
export function panBy(v: View2DFrame, dx: number, dy: number): View2DFrame {
  return { ...v, cx: v.cx - dx / v.ppm, cy: v.cy + dy / v.ppm };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, d: Math.max(a.y + a.d, b.y + b.d) - y0 };
}

/** Grow a rect by a fraction of its size on each side (F fit selection uses 30 %). */
export function padRect(r: Rect, frac: number, minM = 0.5): Rect {
  const px = Math.max(r.w * frac, minM);
  const py = Math.max(r.d * frac, minM);
  return { x: r.x - px, y: r.y - py, w: r.w + 2 * px, d: r.d + 2 * py };
}
