// r4 stream C (spec §3.2 label culling): greedy screen-space label placement (pure).
// Candidates are placed by priority (descending, stable) over a 16 px occupancy grid; a label overlapping an already placed box is
// dropped. Labels below MIN_LABEL_PX are dropped. `force` labels (selected / hovered) are placed first and always kept. Widths
// come from the caller's measure function (canvas measureText: KO-safe).
import { MIN_LABEL_PX } from './lod.ts';

export interface LabelBox {
  /** top-left, screen px */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LabelCandidate {
  box: LabelBox;
  priority: number;
  /** text height (px) */
  size: number;
  force?: boolean;
}

export class ScreenOccupancy {
  private readonly cells = new Map<number, LabelBox[]>();
  constructor(readonly cell = 16, readonly pad = 1) {}

  private keys(b: LabelBox): number[] {
    const c = this.cell;
    const out: number[] = [];
    const x0 = Math.floor((b.x - this.pad) / c);
    const x1 = Math.floor((b.x + b.w + this.pad) / c);
    const y0 = Math.floor((b.y - this.pad) / c);
    const y1 = Math.floor((b.y + b.h + this.pad) / c);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) out.push((ix + 32768) * 65536 + (iy + 32768));
    return out;
  }

  fits(b: LabelBox): boolean {
    const p = this.pad;
    for (const k of this.keys(b)) {
      const l = this.cells.get(k);
      if (!l) continue;
      for (const o of l) if (b.x - p < o.x + o.w && b.x + b.w + p > o.x && b.y - p < o.y + o.h && b.y + b.h + p > o.y) return false;
    }
    return true;
  }

  reserve(b: LabelBox) {
    for (const k of this.keys(b)) {
      const l = this.cells.get(k);
      if (l) l.push(b);
      else this.cells.set(k, [b]);
    }
  }
}

/** Indices of kept candidates, in input order. */
export function cullScreenLabels(cands: readonly LabelCandidate[], occ: ScreenOccupancy = new ScreenOccupancy(), minPx = MIN_LABEL_PX): number[] {
  const order = cands.map((_, i) => i);
  order.sort((a, b) => Number(!!cands[b].force) - Number(!!cands[a].force) || cands[b].priority - cands[a].priority || a - b);
  const kept: number[] = [];
  for (const i of order) {
    const c = cands[i];
    if (c.force) {
      occ.reserve(c.box);
      kept.push(i);
      continue;
    }
    if (!(c.size >= minPx - 1e-9) || !(c.box.w > 0)) continue;
    if (!occ.fits(c.box)) continue;
    occ.reserve(c.box);
    kept.push(i);
  }
  return kept.sort((a, b) => a - b);
}

/** Screen box of a text centred at (x, y) with rotation ±90 swapping extents. */
export function centredBox(x: number, y: number, w: number, h: number, rotDeg = 0): LabelBox {
  const vertical = Math.abs(Math.abs(rotDeg % 180) - 90) < 1;
  return vertical ? { x: x - h / 2, y: y - w / 2, w: h, h: w } : { x: x - w / 2, y: y - h / 2, w, h };
}

/** Largest font px (≤ maxPx) at which `text` fits along `longPx` and across `shortPx`; 0 when even minPx does not fit. */
export function fitFontPx(measure: (s: string, px: number) => number, s: string, longPx: number, shortPx: number, maxPx = 12, minPx = MIN_LABEL_PX, pad = 2): number {
  const w1 = measure(s, 1);
  if (!(w1 > 0)) return 0;
  const byLong = (longPx - 2 * pad) / w1;
  const byShort = (shortPx - pad) * 0.8;
  const px = Math.min(maxPx, byLong, byShort);
  return px >= minPx ? px : 0;
}
