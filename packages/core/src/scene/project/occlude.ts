// r4 stream A0 (spec §2.3 "visible outline = rectangle minus the union of nearer ones"): exact hidden-line removal for axis-aligned
// rectangles in the (u, z) plane of a section / elevation. Every rectangle's outline is clipped against the union of strictly nearer
// rectangles (equal depths never occlude each other); the result per rectangle is either `full` (draw it closed) or the visible chains
// of its perimeter (polylines, perimeter order bottom → right → top → left).
// Nearer rectangles are closed: an edge lying on a nearer rectangle's boundary is hidden (the nearer one draws that line), so the
// output has no duplicate coincident lines — e.g. a rack standing on the cut slab keeps three sides, the slab top draws the fourth.
// Acceleration (exact): an adaptive uniform (u, z) grid over the occluders, and a rectangle contained in a single strictly nearer
// occluder is hidden and never inserted (its area is already inside the union, so no farther outline changes).
export interface OccRect {
  u0: number;
  z0: number;
  u1: number;
  z1: number;
  /** distance from the view plane (smaller = nearer); cut items use a negative depth */
  depth: number;
  /** default true; zero-area rectangles never occlude */
  occludes?: boolean;
}

export interface VisibleOutline {
  /** the whole closed outline is visible (rectangles with area only) */
  full: boolean;
  /** visible perimeter chains as flat [u0, z0, u1, z1, …]; for a degenerate (line) rectangle the visible pieces of the line */
  chains: number[][];
}

export interface VisibleOutlineOptions {
  /** grid cell sizes (m); default adaptive (≤ 128 columns × 32 rows over the rectangles' extent) */
  cellU?: number;
  cellZ?: number;
}

const EPS = 1e-7;
const JOIN = 1e-9;
const OFF = 1 << 20;
const MUL = 1 << 21;
const MAX_CELLS = 1024;

function subtract(lo: number, hi: number, cov: [number, number][]): [number, number][] {
  if (!cov.length) return [[lo, hi]];
  cov.sort((p, q) => p[0] - q[0]);
  const vis: [number, number][] = [];
  let cur = lo;
  for (const [c0, c1] of cov) {
    if (c0 > cur + EPS) vis.push([cur, Math.min(c0, hi)]);
    cur = Math.max(cur, c1);
    if (cur >= hi - EPS) break;
  }
  if (hi - cur > EPS) vis.push([cur, hi]);
  return vis.filter(([a, b]) => b - a > EPS);
}

export function visibleOutlines(rects: readonly OccRect[], opts: VisibleOutlineOptions = {}): VisibleOutline[] {
  const n = rects.length;
  const out: VisibleOutline[] = new Array(n);
  if (!n) return out;
  let uMin = Infinity;
  let uMax = -Infinity;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const r of rects) {
    uMin = Math.min(uMin, r.u0);
    uMax = Math.max(uMax, r.u1);
    zMin = Math.min(zMin, r.z0);
    zMax = Math.max(zMax, r.z1);
  }
  const cellU = opts.cellU ?? Math.max(0.2, (uMax - uMin) / 128);
  const cellZ = opts.cellZ ?? Math.max(0.1, (zMax - zMin) / 32);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rects[a].depth - rects[b].depth || a - b);
  const cells = new Map<number, number[]>();
  const oversize: number[] = [];
  const stamp = new Uint32Array(n);
  let gen = 0;
  const cu = (u: number) => Math.min(OFF - 1, Math.max(-OFF + 1, Math.floor(u / cellU)));
  const cz = (z: number) => Math.min(OFF - 1, Math.max(-OFF + 1, Math.floor(z / cellZ)));
  const key = (i: number, j: number) => (i + OFF) * MUL + (j + OFF);

  const insert = (i: number) => {
    const r = rects[i];
    if (r.occludes === false || r.u1 - r.u0 <= EPS || r.z1 - r.z0 <= EPS) return;
    const i0 = cu(r.u0);
    const i1 = cu(r.u1);
    const j0 = cz(r.z0);
    const j1 = cz(r.z1);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > MAX_CELLS) {
      oversize.push(i);
      return;
    }
    for (let a = i0; a <= i1; a++)
      for (let b = j0; b <= j1; b++) {
        const k = key(a, b);
        const l = cells.get(k);
        if (l) l.push(i);
        else cells.set(k, [i]);
      }
  };
  /** visit every occluder registered in the cells of [ua, ub] × [za, zb] once */
  const each = (ua: number, ub: number, za: number, zb: number, fn: (j: number) => void) => {
    if (++gen === 0xffffffff) {
      stamp.fill(0);
      gen = 1;
    }
    const g = gen;
    const visit = (j: number) => {
      if (stamp[j] === g) return;
      stamp[j] = g;
      fn(j);
    };
    for (const j of oversize) visit(j);
    const i0 = cu(ua);
    const i1 = cu(ub);
    const j0 = cz(za);
    const j1 = cz(zb);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > cells.size) {
      for (const l of cells.values()) for (const j of l) visit(j);
      return;
    }
    for (let a = i0; a <= i1; a++)
      for (let b = j0; b <= j1; b++) {
        const l = cells.get(key(a, b));
        if (l) for (const j of l) visit(j);
      }
  };
  const hEdge = (z: number, ua: number, ub: number) => {
    const cov: [number, number][] = [];
    each(ua, ub, z - EPS, z + EPS, (j) => {
      const o = rects[j];
      if (o.z0 <= z + EPS && o.z1 >= z - EPS && o.u1 > ua + EPS && o.u0 < ub - EPS) cov.push([Math.max(o.u0, ua), Math.min(o.u1, ub)]);
    });
    return subtract(ua, ub, cov);
  };
  const vEdge = (u: number, za: number, zb: number) => {
    const cov: [number, number][] = [];
    each(u - EPS, u + EPS, za, zb, (j) => {
      const o = rects[j];
      if (o.u0 <= u + EPS && o.u1 >= u - EPS && o.z1 > za + EPS && o.z0 < zb - EPS) cov.push([Math.max(o.z0, za), Math.min(o.z1, zb)]);
    });
    return subtract(za, zb, cov);
  };
  /** a single inserted (strictly nearer) occluder contains r */
  const contained = (r: OccRect) => {
    let hit = false;
    each(r.u0 - EPS, r.u0 + EPS, r.z0 - EPS, r.z0 + EPS, (j) => {
      if (hit) return;
      const o = rects[j];
      if (o.u0 <= r.u0 + EPS && o.u1 >= r.u1 - EPS && o.z0 <= r.z0 + EPS && o.z1 >= r.z1 - EPS) hit = true;
    });
    return hit;
  };

  const redundant = new Uint8Array(n);
  const visibleOf = (i: number): VisibleOutline => {
    const r = rects[i];
    const w = r.u1 - r.u0;
    const h = r.z1 - r.z0;
    if (w <= EPS && h <= EPS) return { full: false, chains: [] };
    if (contained(r)) {
      redundant[i] = 1;
      return { full: false, chains: [] };
    }
    if (h <= EPS) return { full: false, chains: hEdge(r.z0, r.u0, r.u1).map(([a, b]) => [a, r.z0, b, r.z0]) };
    if (w <= EPS) return { full: false, chains: vEdge(r.u0, r.z0, r.z1).map(([a, b]) => [r.u0, a, r.u0, b]) };
    const bottom = hEdge(r.z0, r.u0, r.u1);
    const right = vEdge(r.u1, r.z0, r.z1);
    const top = hEdge(r.z1, r.u0, r.u1);
    const left = vEdge(r.u0, r.z0, r.z1);
    const whole = (s: [number, number][], lo: number, hi: number) => s.length === 1 && s[0][0] <= lo + EPS && s[0][1] >= hi - EPS;
    if (whole(bottom, r.u0, r.u1) && whole(top, r.u0, r.u1) && whole(right, r.z0, r.z1) && whole(left, r.z0, r.z1)) return { full: true, chains: [] };
    const segs: number[][] = [
      ...bottom.map(([a, b]) => [a, r.z0, b, r.z0]),
      ...right.map(([a, b]) => [r.u1, a, r.u1, b]),
      ...top.reverse().map(([a, b]) => [b, r.z1, a, r.z1]),
      ...left.reverse().map(([a, b]) => [r.u0, b, r.u0, a]),
    ];
    const chains: number[][] = [];
    let cur: number[] | null = null;
    for (const s of segs) {
      if (cur && Math.abs(cur[cur.length - 2] - s[0]) <= JOIN && Math.abs(cur[cur.length - 1] - s[1]) <= JOIN) cur.push(s[2], s[3]);
      else {
        cur = [s[0], s[1], s[2], s[3]];
        chains.push(cur);
      }
    }
    if (chains.length > 1) {
      const first = chains[0];
      const last = chains[chains.length - 1];
      if (Math.abs(last[last.length - 2] - first[0]) <= JOIN && Math.abs(last[last.length - 1] - first[1]) <= JOIN) {
        last.push(...first.slice(2));
        chains.shift();
      }
    }
    return { full: false, chains };
  };

  let g = 0;
  while (g < n) {
    const d = rects[order[g]].depth;
    let h = g;
    while (h < n && rects[order[h]].depth - d <= EPS) h++;
    for (let k = g; k < h; k++) out[order[k]] = visibleOf(order[k]);
    for (let k = g; k < h; k++) if (!redundant[order[k]]) insert(order[k]);
    g = h;
  }
  return out;
}
