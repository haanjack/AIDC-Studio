// r4 stream A0 (spec §2.3 projection rules): plan projection of a hall's prims.
//   floor     cutZ = 1.2 m (typical): AABB crossing cutZ → 'cut'; wholly below → 'below'; wholly above → 'overhead' (dashed)
//   services  cutZ just under the lowest overhead service (busway / tray / pipe / circuit underside − 0.05 m), racks + units 'ghost'
//   rcp       cutZ = ceiling − 0.01 m, racks + units 'ghost', ceiling planes included
// Slab is never drawn in plan; ceiling planes only in rcp (unless `layers` lists them explicitly). Item order: ghost → below → cut →
// overhead, then by top z (lower first) and prim order. Geometry: box / plane / axis-parallel bar or tube → rect [x, y, w, d] of the
// plan AABB (a bar's rect height is 2 × halfW, G3); oblique bar → 4-point polygon; vertical tube / point → circle [cx, cy, r].
import type { Rect } from '../../model/types.ts';
import { drawListHash, type DrawItem2D, type DrawList2D, type DrawRole2D } from '../drawList.ts';
import type { LayerId } from '../layers.ts';
import { primAabb, type Aabb3, type HallPrims, type Prim } from '../prims.ts';
import { hallIndex, primLod, primsBounds } from './common.ts';

/** typical plan cut height (m) */
export const PLAN_CUT_Z_M = 1.2;

export interface ProjectPlanOptions {
  window?: Rect;
  /** default PLAN_CUT_Z_M (floor), derived for services / rcp */
  cutZ?: number;
  mode?: 'floor' | 'services' | 'rcp';
  layers?: LayerId[];
}

const SERVICE_EMITTERS = new Set<Prim['emitter']>(['busway', 'tray', 'pipe', 'circuit']);
const ROLE_RANK: Record<DrawRole2D, number> = { ghost: 0, below: 1, cut: 2, overhead: 3, beyond: 4 };

/** The cut height a plan mode uses. */
export function planCutZ(hp: HallPrims, mode: NonNullable<ProjectPlanOptions['mode']> = 'floor', cutZ?: number): number {
  if (cutZ !== undefined) return cutZ;
  if (mode === 'services') {
    let z = Infinity;
    for (const p of hp.prims) if (SERVICE_EMITTERS.has(p.emitter)) z = Math.min(z, primAabb(p).min.z);
    if (Number.isFinite(z)) return z - 0.05;
    const d = hp.datums.filter((x) => x.id === 'pipe' || x.id === 'busway' || x.id === 'T1').map((x) => x.z);
    return d.length ? Math.min(...d) - 0.1 : PLAN_CUT_Z_M;
  }
  if (mode === 'rcp') {
    const c = hp.prims.find((p) => p.emitter === 'ceiling' && p.meta?.kind === 'ceiling');
    if (c) return c.a.z - 0.01;
    const d = hp.datums.find((x) => x.id === 'ceiling');
    return d ? d.z - 0.01 : PLAN_CUT_Z_M;
  }
  return PLAN_CUT_Z_M;
}

/** Plan geometry of one prim. */
export function planShape(p: Prim, box: Aabb3 = primAabb(p)): Pick<DrawItem2D, 'kind' | 'pts'> {
  const dx = Math.abs(p.b.x - p.a.x);
  const dy = Math.abs(p.b.y - p.a.y);
  if ((p.shape === 'bar' || p.shape === 'tube') && dx > 1e-9 && dy > 1e-9) {
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
    const px = (-(p.b.y - p.a.y) / len) * p.halfW;
    const py = ((p.b.x - p.a.x) / len) * p.halfW;
    return { kind: 'polygon', pts: [p.a.x + px, p.a.y + py, p.b.x + px, p.b.y + py, p.b.x - px, p.b.y - py, p.a.x - px, p.a.y - py] };
  }
  if (p.shape === 'point' || (p.shape === 'tube' && dx <= 1e-9 && dy <= 1e-9)) return { kind: 'circle', pts: [p.a.x, p.a.y, p.halfW] };
  return { kind: 'rect', pts: [box.min.x, box.min.y, box.max.x - box.min.x, box.max.y - box.min.y] };
}

export function projectPlan(hp: HallPrims, o: ProjectPlanOptions = {}): DrawList2D {
  const mode = o.mode ?? 'floor';
  const cutZ = planCutZ(hp, mode, o.cutZ);
  const idx = hallIndex(hp);
  const allow = o.layers ? new Set(o.layers) : null;
  const ids = o.window ? idx.query(o.window) : hp.prims.map((_, i) => i);
  const keyed: { it: DrawItem2D; rank: number; top: number; i: number }[] = [];
  for (const i of ids) {
    const p = hp.prims[i];
    if (allow ? !allow.has(p.layer) : p.layer === 'slab' || (p.layer === 'ceiling' && mode !== 'rcp')) continue;
    const box = primAabb(p);
    let role: DrawRole2D = box.max.z < cutZ - 1e-9 ? 'below' : box.min.z > cutZ + 1e-9 ? 'overhead' : 'cut';
    if (mode !== 'floor' && (p.emitter === 'rack' || p.emitter === 'unit')) role = 'ghost';
    const it: DrawItem2D = { ...planShape(p, box), role, layer: p.layer, lodMin: primLod(p), style: p.emitter, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) };
    keyed.push({ it, rank: ROLE_RANK[role], top: box.max.z, i });
  }
  keyed.sort((a, b) => a.rank - b.rank || a.top - b.top || a.i - b.i);
  const list = { space: 'plan' as const, hallId: hp.hallId, bounds: o.window ? { ...o.window } : primsBounds(hp), items: keyed.map((k) => k.it) };
  return { ...list, hash: drawListHash(list) };
}
