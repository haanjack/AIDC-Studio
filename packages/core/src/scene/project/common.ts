// r4 stream A0: helpers shared by the plan / section / elevation projections (LOD tags, grid index reuse, hall extent).
import type { Rect } from '../../model/types.ts';
import type { LayerId } from '../layers.ts';
import { GridIndex, type HallPrims, type Prim } from '../prims.ts';

/** zero-height floor marks (hall outline, egress, reserve positions): plan only, never in sections / elevations */
export const FLOOR_MARK_LAYERS: ReadonlySet<LayerId> = new Set<LayerId>(['hall-outline', 'egress', 'reserves']);

/**
 * LOD band a prim first appears in (spec §3.2): 0 campus · 1 hall (walls, racks, containment, busway / tray centre lines, CDU) ·
 * 2 pod (tap-offs, drops, pipes, doors, circuits, feeders, sleeves, lights) · 3 detail (fittings).
 */
const LOD: Record<Prim['emitter'], 0 | 1 | 2 | 3> = {
  wall: 0,
  room: 0,
  rack: 1,
  unit: 1,
  column: 1,
  partition: 1,
  'containment-panel': 1,
  'containment-roof': 1,
  busway: 1,
  tray: 1,
  slab: 1,
  ceiling: 1,
  pipe: 2,
  door: 2,
  tapoff: 2,
  drop: 2,
  circuit: 2,
  feeder: 2,
  sleeve: 2,
  light: 2,
  fitting: 3,
};

export function primLod(p: Prim): 0 | 1 | 2 | 3 {
  if (p.emitter === 'room' && p.layer !== 'hall-outline' && p.layer !== 'electrical-rooms') return 1;
  return LOD[p.emitter] ?? 1;
}

const indexCache = new WeakMap<HallPrims, GridIndex>();

/** The hall's grid index; rebuilt (and cached per object) when `hp` went through structured cloning. */
export function hallIndex(hp: HallPrims): GridIndex {
  if (hp.index instanceof GridIndex && hp.index.count === hp.prims.length) return hp.index;
  let g = indexCache.get(hp);
  if (!g || g.count !== hp.prims.length) {
    g = GridIndex.build(hp.prims);
    indexCache.set(hp, g);
  }
  return g;
}

/** Plan union of every prim AABB (walls, rooms and feeders outside the hall included). */
export function primsBounds(hp: HallPrims): Rect {
  const idx = hallIndex(hp);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < idx.count; i++) {
    const r = idx.rectOf(i);
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.d);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, d: y1 - y0 } : { x: 0, y: 0, w: 0, d: 0 };
}

/** Interior hall rectangle [0, W] × [0, D] from the outline prim (else the prim bounds). */
export function hallExtent(hp: HallPrims): Rect {
  const o = hp.prims.find((p) => p.emitter === 'room' && p.layer === 'hall-outline');
  if (o) return { x: Math.min(o.a.x, o.b.x), y: Math.min(o.a.y, o.b.y), w: Math.abs(o.b.x - o.a.x), d: Math.abs(o.b.y - o.a.y) };
  return primsBounds(hp);
}
