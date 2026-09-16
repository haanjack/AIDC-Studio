// r4 contract (docs/research/r4-2d-drawings-spec.md §2.3, S1): one geometry source. Core builds a `Prim[]` per hall; the 3D viewer,
// the 2D view, every sheet, the exports and the wall audit read only that list. Owner after the contract: stream A.
// Pure and deterministic: no Date / random; ids are stable across builds.
import type { Id, PipeNetwork, Rect, RowGroup, Vec3 } from '../model/types.ts';
import type { SystemId } from '../drawings/palette.ts';
import type { LayerId } from './layers.ts';

export type PrimEmitter =
  | 'rack' | 'unit' | 'tray' | 'drop' | 'busway' | 'tapoff' | 'circuit' | 'feeder' | 'pipe' | 'fitting'
  | 'containment-panel' | 'containment-roof' | 'door' | 'wall' | 'column' | 'partition' | 'slab' | 'ceiling' | 'light' | 'room' | 'sleeve';

/** wall-audit classes (r3-geometry-audit-plan §4.1): inside the hall overhead / on the floor, legitimate penetration, exempt */
export type PrimClass = 'IN-overhead' | 'IN-floor' | 'PEN' | 'EXEMPT';

/**
 * box / plane: `a` = min corner, `b` = max corner.
 * bar / tube: centre-line from `a` to `b` (axis-parallel except rare fallbacks); cross-section half sizes `halfW` (horizontal) and
 * `halfH` (vertical). A vertical bar takes `halfW` across x and `halfH` across y. A tube is round: radius `halfW`.
 * point: centre `a` (= `b`), half sizes halfW (x, y) and halfH (z).
 */
export type PrimShape = 'box' | 'bar' | 'tube' | 'point' | 'plane';

export interface Prim {
  /** stable: 'rack:DU01-A-07', 'tray:tray-pod-01-a#T1', 'busway:bw-A-r3', 'pipe:DU01-A#S' */
  id: string;
  emitter: PrimEmitter;
  cls: PrimClass;
  shape: PrimShape;
  a: Vec3;
  b: Vec3;
  halfW: number;
  halfH: number;
  layer: LayerId;
  /** model id: equipment / tray / busway / circuit / containment / keepout */
  refId?: string;
  system?: SystemId | 'arch' | 'it';
  tier?: string;
  podId?: string;
  rowId?: string;
  tag?: string;
  meta?: Record<string, string | number | boolean>;
}

/** Source tag of a default (spec header). */
export type DatumSource = 'existing' | 'observed' | 'standard' | 'typical' | 'estimate' | 'derived';

/** Level datum (FFL, top of rack, containment, pipe, busway, T1–T3, light, ceiling, deck). `label` follows project.locale. */
export interface Datum {
  id: string;
  z: number;
  label: string;
  source: DatumSource;
}

export interface HallPrims {
  hallId: string;
  detail: 'hall' | 'pod';
  prims: Prim[];
  /** plan grid index over `prims` (rebuild with GridIndex.build after structured cloning: it is a class instance) */
  index: GridIndex;
  datums: Datum[];
  rows: RowGroup[];
  hash: string;
  /** full derived TCS pipe network of the hall (layout/pipes.ts; at 'hall' detail the branch / fitting prims are omitted, the network is not) */
  pipes?: PipeNetwork;
}

export interface Aabb3 {
  min: Vec3;
  max: Vec3;
}

const EPS = 1e-9;

/** Axis-aligned bounding box of a prim (world m). Non-axis-parallel bars / tubes are bounded conservatively. */
export function primAabb(p: Prim): Aabb3 {
  const lo = { x: Math.min(p.a.x, p.b.x), y: Math.min(p.a.y, p.b.y), z: Math.min(p.a.z, p.b.z) };
  const hi = { x: Math.max(p.a.x, p.b.x), y: Math.max(p.a.y, p.b.y), z: Math.max(p.a.z, p.b.z) };
  if (p.shape === 'box' || p.shape === 'plane') return { min: lo, max: hi };
  if (p.shape === 'point') {
    return {
      min: { x: p.a.x - p.halfW, y: p.a.y - p.halfW, z: p.a.z - p.halfH },
      max: { x: p.a.x + p.halfW, y: p.a.y + p.halfW, z: p.a.z + p.halfH },
    };
  }
  const w = p.halfW;
  const h = p.shape === 'tube' ? p.halfW : p.halfH;
  const dx = hi.x - lo.x;
  const dy = hi.y - lo.y;
  const dz = hi.z - lo.z;
  let ex: number;
  let ey: number;
  let ez: number;
  if (dy <= EPS && dz <= EPS) [ex, ey, ez] = [0, w, h]; // along x (or zero length)
  else if (dx <= EPS && dz <= EPS) [ex, ey, ez] = [w, 0, h]; // along y
  else if (dx <= EPS && dy <= EPS) [ex, ey, ez] = [w, p.shape === 'tube' ? w : p.halfH, 0]; // vertical
  else {
    const m = Math.max(w, h);
    [ex, ey, ez] = [m, m, dz <= EPS ? h : m];
  }
  return { min: { x: lo.x - ex, y: lo.y - ey, z: lo.z - ez }, max: { x: hi.x + ex, y: hi.y + ey, z: hi.z + ez } };
}

/** Plan (x, y) rectangle of a prim's AABB. */
export function primPlanRect(p: Prim): Rect {
  const { min, max } = primAabb(p);
  return { x: min.x, y: min.y, w: max.x - min.x, d: max.y - min.y };
}

const KEY_OFF = 1 << 19;
const KEY_MUL = 1 << 20;
/** prims spanning more cells than this go to an always-checked list instead of being rasterised */
const MAX_CELLS_PER_PRIM = 4096;

/**
 * Uniform plan grid over prim AABBs (spec §3.4: 4 m cells). `query(rect)` returns the ascending indices of every prim whose plan
 * AABB intersects `rect` (closed intervals: touching counts) — exactly the brute-force answer.
 */
export class GridIndex {
  readonly cellM: number;
  readonly count: number;
  private readonly boxes: Float64Array;
  private readonly cells: Map<number, number[]>;
  private readonly oversize: number[];
  private readonly stamp: Uint32Array;
  private gen = 0;

  private constructor(cellM: number, boxes: Float64Array, cells: Map<number, number[]>, oversize: number[]) {
    this.cellM = cellM;
    this.boxes = boxes;
    this.count = boxes.length / 4;
    this.cells = cells;
    this.oversize = oversize;
    this.stamp = new Uint32Array(this.count);
  }

  static build(prims: readonly Prim[], cellM = 4): GridIndex {
    const cell = cellM > 0 ? cellM : 4;
    const boxes = new Float64Array(prims.length * 4);
    const cells = new Map<number, number[]>();
    const oversize: number[] = [];
    prims.forEach((p, i) => {
      const { min, max } = primAabb(p);
      boxes[i * 4] = min.x;
      boxes[i * 4 + 1] = min.y;
      boxes[i * 4 + 2] = max.x;
      boxes[i * 4 + 3] = max.y;
      const ix0 = Math.floor(min.x / cell);
      const ix1 = Math.floor(max.x / cell);
      const iy0 = Math.floor(min.y / cell);
      const iy1 = Math.floor(max.y / cell);
      if (!Number.isFinite(ix0 + ix1 + iy0 + iy1) || (ix1 - ix0 + 1) * (iy1 - iy0 + 1) > MAX_CELLS_PER_PRIM || Math.abs(ix0) >= KEY_OFF || Math.abs(ix1) >= KEY_OFF || Math.abs(iy0) >= KEY_OFF || Math.abs(iy1) >= KEY_OFF) {
        oversize.push(i);
        return;
      }
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++) {
          const k = (ix + KEY_OFF) * KEY_MUL + (iy + KEY_OFF);
          const list = cells.get(k);
          if (list) list.push(i);
          else cells.set(k, [i]);
        }
    });
    return new GridIndex(cell, boxes, cells, oversize);
  }

  /** plan AABB of prim `i` */
  rectOf(i: number): Rect {
    const b = this.boxes;
    return { x: b[i * 4], y: b[i * 4 + 1], w: b[i * 4 + 2] - b[i * 4], d: b[i * 4 + 3] - b[i * 4 + 1] };
  }

  query(rect: Rect): number[] {
    if (!this.count) return [];
    const x0 = rect.x;
    const y0 = rect.y;
    const x1 = rect.x + rect.w;
    const y1 = rect.y + rect.d;
    if (++this.gen === 0xffffffff) {
      this.stamp.fill(0);
      this.gen = 1;
    }
    const g = this.gen;
    const out: number[] = [];
    const b = this.boxes;
    const test = (i: number) => {
      if (this.stamp[i] === g) return;
      this.stamp[i] = g;
      if (b[i * 4] <= x1 && b[i * 4 + 2] >= x0 && b[i * 4 + 1] <= y1 && b[i * 4 + 3] >= y0) out.push(i);
    };
    for (const i of this.oversize) test(i);
    const c = this.cellM;
    const ix0 = Math.max(Math.floor(x0 / c), -KEY_OFF + 1);
    const ix1 = Math.min(Math.floor(x1 / c), KEY_OFF - 1);
    const iy0 = Math.max(Math.floor(y0 / c), -KEY_OFF + 1);
    const iy1 = Math.min(Math.floor(y1 / c), KEY_OFF - 1);
    if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > this.cells.size) {
      // huge window: walk the occupied cells instead of the window
      for (const list of this.cells.values()) for (const i of list) test(i);
    } else {
      for (let ix = ix0; ix <= ix1; ix++)
        for (let iy = iy0; iy <= iy1; iy++) {
          const list = this.cells.get((ix + KEY_OFF) * KEY_MUL + (iy + KEY_OFF));
          if (list) for (const i of list) test(i);
        }
    }
    return out.sort((p, q) => p - q);
  }
}

/** Deterministic 64-bit-ish string hash (two 32-bit FNV-style lanes, 16 hex chars). */
export function sceneHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Hash of a prim list (order-sensitive). Streams every field into two 32-bit lanes without building an intermediate JSON string
 * (≈ 10× faster than hashing JSON.stringify at 16 k prims). Deterministic for identical input on the same platform.
 */
export function primsHash(prims: readonly Prim[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const num = (v: number) => {
    f64[0] = v;
    h1 = Math.imul(h1 ^ u32[0], 0x01000193);
    h2 = Math.imul(h2 ^ u32[1], 0x5bd1e995);
    h1 = Math.imul(h1 ^ u32[1], 0x01000193);
    h2 = Math.imul(h2 ^ u32[0], 0x5bd1e995);
  };
  const str = (s: string | undefined) => {
    if (s === undefined) {
      h1 = Math.imul(h1 ^ 0x1f, 0x01000193);
      h2 = Math.imul(h2 ^ 0x1f, 0x5bd1e995);
      return;
    }
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    }
    h1 = Math.imul(h1 ^ 0x1e, 0x01000193);
    h2 = Math.imul(h2 ^ 0x1e, 0x5bd1e995);
  };
  for (const p of prims) {
    str(p.id);
    str(p.emitter);
    str(p.cls);
    str(p.shape);
    num(p.a.x);
    num(p.a.y);
    num(p.a.z);
    num(p.b.x);
    num(p.b.y);
    num(p.b.z);
    num(p.halfW);
    num(p.halfH);
    str(p.layer);
    str(p.refId);
    str(p.system);
    str(p.tier);
    str(p.podId);
    str(p.rowId);
    str(p.tag);
    if (p.meta) {
      for (const k in p.meta) {
        const v = p.meta[k];
        str(k);
        if (typeof v === 'string') str(v);
        else if (typeof v === 'number') num(v);
        else num(v ? 1.5 : -1.5);
      }
    }
    str(undefined);
  }
  num(prims.length);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** An empty HallPrims (stubs, empty halls). */
export function emptyHallPrims(hallId: Id, detail: HallPrims['detail'] = 'hall'): HallPrims {
  return { hallId, detail, prims: [], index: GridIndex.build([]), datums: [], rows: [], hash: sceneHash(`${hallId}|${detail}|[]`) };
}
