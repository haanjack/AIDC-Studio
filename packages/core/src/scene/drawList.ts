// r4 contract (spec §2.3, S3): the 2D draw list. World metres: plan = hall-local (x, y); section / elevation = (u along the cut, z).
// The live Canvas2D view and the SVG sheets / exports render the same list. `packDrawList` flattens it into typed arrays for a
// zero-copy worker transfer. Owner after the contract: stream A.
import type { DrawingCut, DrawingSpace, ElevationTarget, Id, Rect } from '../model/types.ts';
import type { LayerId } from './layers.ts';
import { sceneHash } from './prims.ts';

export type Space2D = DrawingSpace;
export type DrawKind2D = 'rect' | 'polyline' | 'polygon' | 'circle' | 'text';
/** cut = intersected by the cut plane · beyond = seen past it · below / overhead = plan classification · ghost = context */
export type DrawRole2D = 'cut' | 'beyond' | 'below' | 'overhead' | 'ghost';

export interface DrawItem2D {
  kind: DrawKind2D;
  /** flat [x0,y0,x1,y1,…]; rect = [x,y,w,h]; circle = [cx,cy,r]; text = [x,y] */
  pts: number[];
  role: DrawRole2D;
  layer: LayerId;
  lodMin: 0 | 1 | 2 | 3;
  /** style id → drawings/palette.ts (paper) / web palette2d.ts (dark) */
  style: string;
  primId?: string;
  refId?: string;
  /** painter order for section / elevation (distance from the cut plane, m; far first) */
  depth?: number;
  text?: string;
  size?: number;
  rot?: number;
}

export interface DrawList2D {
  space: Space2D;
  hallId: string;
  /** world bounds: plan {x, y, w, d}; section / elevation {x: u0, y: z0, w: Δu, d: Δz} */
  bounds: Rect;
  items: DrawItem2D[];
  cut?: DrawingCut;
  elevation?: ElevationTarget;
  hash: string;
}

/** An empty draw list (stubs, empty halls). */
export function emptyDrawList(space: Space2D, hallId: Id, bounds: Rect, extra: { cut?: DrawingCut; elevation?: ElevationTarget } = {}): DrawList2D {
  return {
    space,
    hallId,
    bounds,
    items: [],
    ...(extra.cut ? { cut: extra.cut } : {}),
    ...(extra.elevation ? { elevation: extra.elevation } : {}),
    hash: sceneHash(JSON.stringify([space, hallId, bounds, extra.cut ?? null, extra.elevation ?? null])),
  };
}

/** Hash of a draw list's content (order-sensitive). */
export function drawListHash(list: Pick<DrawList2D, 'space' | 'hallId' | 'bounds' | 'items' | 'cut' | 'elevation'>): string {
  return sceneHash(JSON.stringify([list.space, list.hallId, list.bounds, list.cut ?? null, list.elevation ?? null, list.items]));
}

const KINDS: readonly DrawKind2D[] = ['rect', 'polyline', 'polygon', 'circle', 'text'];
const ROLES: readonly DrawRole2D[] = ['cut', 'beyond', 'below', 'overhead', 'ghost'];

/** Typed-array form of a DrawList2D. Numbers are Float64 so pack → unpack is exact. String fields index `strings` (−1 = absent). */
export interface PackedDrawList {
  space: Space2D;
  hallId: string;
  bounds: Rect;
  cut?: DrawingCut;
  elevation?: ElevationTarget;
  hash: string;
  count: number;
  strings: string[];
  kind: Uint8Array;
  role: Uint8Array;
  lodMin: Uint8Array;
  layer: Int32Array;
  style: Int32Array;
  primId: Int32Array;
  refId: Int32Array;
  text: Int32Array;
  /** item i owns pts[ptsStart[i] .. ptsStart[i+1]) */
  ptsStart: Uint32Array;
  pts: Float64Array;
  /** NaN = absent */
  depth: Float64Array;
  size: Float64Array;
  rot: Float64Array;
}

export function packDrawList(list: DrawList2D): PackedDrawList {
  const n = list.items.length;
  const strings: string[] = [];
  const sIdx = new Map<string, number>();
  const str = (s: string | undefined): number => {
    if (s === undefined) return -1;
    let i = sIdx.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      sIdx.set(s, i);
    }
    return i;
  };
  let nPts = 0;
  for (const it of list.items) nPts += it.pts.length;
  const p: PackedDrawList = {
    space: list.space,
    hallId: list.hallId,
    bounds: { ...list.bounds },
    ...(list.cut ? { cut: list.cut } : {}),
    ...(list.elevation ? { elevation: list.elevation } : {}),
    hash: list.hash,
    count: n,
    strings,
    kind: new Uint8Array(n),
    role: new Uint8Array(n),
    lodMin: new Uint8Array(n),
    layer: new Int32Array(n),
    style: new Int32Array(n),
    primId: new Int32Array(n),
    refId: new Int32Array(n),
    text: new Int32Array(n),
    ptsStart: new Uint32Array(n + 1),
    pts: new Float64Array(nPts),
    depth: new Float64Array(n),
    size: new Float64Array(n),
    rot: new Float64Array(n),
  };
  let o = 0;
  list.items.forEach((it, i) => {
    p.kind[i] = KINDS.indexOf(it.kind);
    p.role[i] = ROLES.indexOf(it.role);
    p.lodMin[i] = it.lodMin;
    p.layer[i] = str(it.layer);
    p.style[i] = str(it.style);
    p.primId[i] = str(it.primId);
    p.refId[i] = str(it.refId);
    p.text[i] = str(it.text);
    p.ptsStart[i] = o;
    p.pts.set(it.pts, o);
    o += it.pts.length;
    p.depth[i] = it.depth ?? NaN;
    p.size[i] = it.size ?? NaN;
    p.rot[i] = it.rot ?? NaN;
  });
  p.ptsStart[n] = o;
  return p;
}

/** ArrayBuffers of a packed list, for postMessage(…, transfer). */
export function packedTransferables(p: PackedDrawList): ArrayBuffer[] {
  return [p.kind, p.role, p.lodMin, p.layer, p.style, p.primId, p.refId, p.text, p.ptsStart, p.pts, p.depth, p.size, p.rot].map((a) => a.buffer as ArrayBuffer);
}

export function unpackDrawList(p: PackedDrawList): DrawList2D {
  const items: DrawItem2D[] = [];
  const s = (i: number) => (i < 0 ? undefined : p.strings[i]);
  for (let i = 0; i < p.count; i++) {
    const it: DrawItem2D = {
      kind: KINDS[p.kind[i]],
      pts: Array.from(p.pts.subarray(p.ptsStart[i], p.ptsStart[i + 1])),
      role: ROLES[p.role[i]],
      layer: s(p.layer[i]) as LayerId,
      lodMin: p.lodMin[i] as DrawItem2D['lodMin'],
      style: s(p.style[i]) ?? '',
    };
    const primId = s(p.primId[i]);
    const refId = s(p.refId[i]);
    const text = s(p.text[i]);
    if (primId !== undefined) it.primId = primId;
    if (refId !== undefined) it.refId = refId;
    if (!Number.isNaN(p.depth[i])) it.depth = p.depth[i];
    if (text !== undefined) it.text = text;
    if (!Number.isNaN(p.size[i])) it.size = p.size[i];
    if (!Number.isNaN(p.rot[i])) it.rot = p.rot[i];
    items.push(it);
  }
  return {
    space: p.space,
    hallId: p.hallId,
    bounds: { ...p.bounds },
    items,
    ...(p.cut ? { cut: p.cut } : {}),
    ...(p.elevation ? { elevation: p.elevation } : {}),
    hash: p.hash,
  };
}
