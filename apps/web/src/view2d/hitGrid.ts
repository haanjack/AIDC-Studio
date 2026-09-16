// r4 stream C (spec §3.4): uniform grid over draw-item bounding boxes, for viewport culling and hit tests (pure).
// Boxes are world [x0, y0, x1, y1] per item. `query(rect)` returns ascending indices of every box touching the rect (closed
// intervals) — the brute-force answer. `pick(x, y, tol, exact?)` returns the candidates containing the point grown by `tol`,
// filtered by an optional exact test.
export class HitGrid {
  readonly cell: number;
  readonly count: number;
  readonly boxes: Float64Array;
  private readonly cells = new Map<number, number[]>();
  private readonly big: number[] = [];
  private readonly stamp: Uint32Array;
  private gen = 0;
  private static readonly OFF = 1 << 19;
  private static readonly MUL = 1 << 20;

  constructor(boxes: Float64Array, cell = 4) {
    this.cell = cell > 0 ? cell : 4;
    this.boxes = boxes;
    this.count = boxes.length >> 2;
    this.stamp = new Uint32Array(this.count);
    const c = this.cell;
    for (let i = 0; i < this.count; i++) {
      const x0 = boxes[i * 4];
      const y0 = boxes[i * 4 + 1];
      const x1 = boxes[i * 4 + 2];
      const y1 = boxes[i * 4 + 3];
      if (!(x0 <= x1 && y0 <= y1)) continue; // NaN / empty: never hit
      const ix0 = Math.floor(x0 / c);
      const ix1 = Math.floor(x1 / c);
      const iy0 = Math.floor(y0 / c);
      const iy1 = Math.floor(y1 / c);
      if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 1024 || Math.abs(ix0) >= HitGrid.OFF || Math.abs(ix1) >= HitGrid.OFF || Math.abs(iy0) >= HitGrid.OFF || Math.abs(iy1) >= HitGrid.OFF) {
        this.big.push(i);
        continue;
      }
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++) {
          const k = (ix + HitGrid.OFF) * HitGrid.MUL + (iy + HitGrid.OFF);
          const l = this.cells.get(k);
          if (l) l.push(i);
          else this.cells.set(k, [i]);
        }
    }
  }

  private visit(x0: number, y0: number, x1: number, y1: number, fn: (i: number) => void) {
    if (!this.count) return;
    if (++this.gen === 0xffffffff) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    const g = this.gen;
    const b = this.boxes;
    const test = (i: number) => {
      if (this.stamp[i] === g) return;
      this.stamp[i] = g;
      if (b[i * 4] <= x1 && b[i * 4 + 2] >= x0 && b[i * 4 + 1] <= y1 && b[i * 4 + 3] >= y0) fn(i);
    };
    for (const i of this.big) test(i);
    const c = this.cell;
    const ix0 = Math.max(Math.floor(x0 / c), -HitGrid.OFF + 1);
    const ix1 = Math.min(Math.floor(x1 / c), HitGrid.OFF - 1);
    const iy0 = Math.max(Math.floor(y0 / c), -HitGrid.OFF + 1);
    const iy1 = Math.min(Math.floor(y1 / c), HitGrid.OFF - 1);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > this.cells.size) {
      for (const l of this.cells.values()) for (const i of l) test(i);
    } else {
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++) {
          const l = this.cells.get((ix + HitGrid.OFF) * HitGrid.MUL + (iy + HitGrid.OFF));
          if (l) for (const i of l) test(i);
        }
    }
  }

  /** Ascending indices of every box touching the world rect. */
  query(x: number, y: number, w: number, d: number): number[] {
    const out: number[] = [];
    this.visit(x, y, x + w, y + d, (i) => out.push(i));
    return out.sort((p, q) => p - q);
  }

  /** Ascending indices of boxes containing (x, y) grown by `tol`, passing `exact` when given. */
  pick(x: number, y: number, tol = 0, exact?: (i: number) => boolean): number[] {
    const out: number[] = [];
    this.visit(x - tol, y - tol, x + tol, y + tol, (i) => {
      if (!exact || exact(i)) out.push(i);
    });
    return out.sort((p, q) => p - q);
  }
}

/** Brute-force reference (tests). */
export function bruteQuery(boxes: Float64Array, x: number, y: number, w: number, d: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < boxes.length >> 2; i++) if (boxes[i * 4] <= x + w && boxes[i * 4 + 2] >= x && boxes[i * 4 + 1] <= y + d && boxes[i * 4 + 3] >= y) out.push(i);
  return out;
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Even-odd point-in-polygon on a flat [x0, y0, x1, y1, …] ring. */
export function pointInPolygon(px: number, py: number, pts: ArrayLike<number>, start = 0, end = pts.length): boolean {
  let inside = false;
  const n = (end - start) >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[start + 2 * i];
    const yi = pts[start + 2 * i + 1];
    const xj = pts[start + 2 * j];
    const yj = pts[start + 2 * j + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
