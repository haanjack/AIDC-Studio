// r4 stream A0 (spec §2.3 "Elevation: a section with no cut, painter's order by depth"): elevations of a hall.
//   wall N/E/S/W     viewer inside the hall facing that wall; plane at the opposite interior face (or `depthM` in front of the wall),
//                    window = hall width plus the wall slabs
//   row-face         front: viewer on the front side facing the fronts; rear: viewer behind the row (u runs mirrored with respect to
//                    the front view, as seen from the rear); plane 0.05 m off the face, depth = row depth + 0.06 m, window = row ± 0.6 m
//   aisle-end        viewer at the containment end (0 = low end, 1 = high end) looking along the aisle, plane 0.05 m outside the door,
//                    depth = aisle length + 0.1 m, window = aisle ± 1.8 m (both rows' racks)
// Every item is role 'beyond' with `depth` = near-face distance, emitted far → near with exact visible outlines (occlude.ts).
// `elevationCut` returns the equivalent DrawingCut so sheets / the 2D view share the u ↔ world mapping.
import type { DrawingCut, ElevationTarget } from '../../model/types.ts';
import { drawListHash, emptyDrawList, type DrawList2D } from '../drawList.ts';
import type { LayerId } from '../layers.ts';
import { primAabb, type HallPrims } from '../prims.ts';
import { WALL_THICKNESS_M } from '../shell.ts';
import { hallExtent } from './common.ts';
import { frameU, projectOrtho } from './ortho.ts';

export interface ProjectElevationOptions {
  layers?: LayerId[];
  /** view depth (m); defaults per target kind (see header) */
  depthM?: number;
  /** u window override */
  window?: { u0: number; u1: number };
  /** 'exact' visible-outline polylines (default) or 'painter' closed rects for opaque fills (see OrthoOptions) */
  outlines?: 'exact' | 'painter';
}

const uWindow = (axis: 'x' | 'y', look: 1 | -1, t0: number, t1: number) => {
  const a = frameU({ axis, look }, axis === 'y' ? t0 : 0, axis === 'y' ? 0 : t0);
  const b = frameU({ axis, look }, axis === 'y' ? t1 : 0, axis === 'y' ? 0 : t1);
  return { u0: Math.min(a, b), u1: Math.max(a, b) };
};

/** The view plane of an elevation target as a DrawingCut (null when the target does not exist in the hall). */
export function elevationCut(hp: HallPrims, t: ElevationTarget, o: ProjectElevationOptions = {}): DrawingCut | null {
  const T = WALL_THICKNESS_M;
  if (t.kind === 'wall') {
    const ext = hallExtent(hp);
    if (!(ext.w > 0 && ext.d > 0)) return null;
    const axis: 'x' | 'y' = t.wall === 'N' || t.wall === 'S' ? 'y' : 'x';
    const look: 1 | -1 = t.wall === 'N' || t.wall === 'E' ? 1 : -1;
    const lo = axis === 'y' ? ext.y : ext.x;
    const hi = lo + (axis === 'y' ? ext.d : ext.w);
    const span = hi - lo;
    const depthM = Math.min(o.depthM ?? span, span);
    const at = look === 1 ? hi - depthM : lo + depthM;
    const t0 = (axis === 'y' ? ext.x : ext.y) - T;
    const t1 = (axis === 'y' ? ext.x + ext.w : ext.y + ext.d) + T;
    return { id: `elev-wall-${t.wall}`, label: t.wall, hallId: hp.hallId, axis, at, look, depthM: depthM + T, window: o.window ?? uWindow(axis, look, t0, t1) };
  }
  if (t.kind === 'row-face') {
    const row = hp.rows.find((r) => r.id === t.rowId);
    const members = hp.prims.filter((p) => p.rowId === t.rowId && (p.emitter === 'rack' || p.emitter === 'unit'));
    if (!row || !members.length) return null;
    const axis: 'x' | 'y' = row.axis === 'x' ? 'y' : 'x';
    let p0 = Infinity;
    let p1 = -Infinity;
    let a0 = Infinity;
    let a1 = -Infinity;
    for (const m of members) {
      const b = primAabb(m);
      p0 = Math.min(p0, axis === 'y' ? b.min.y : b.min.x);
      p1 = Math.max(p1, axis === 'y' ? b.max.y : b.max.x);
      a0 = Math.min(a0, axis === 'y' ? b.min.x : b.min.y);
      a1 = Math.max(a1, axis === 'y' ? b.max.x : b.max.y);
    }
    const faceSign = t.face === 'front' ? row.frontSign : -row.frontSign;
    const look: 1 | -1 = faceSign > 0 ? -1 : 1;
    const at = faceSign > 0 ? p1 + 0.05 : p0 - 0.05;
    return { id: `elev-row-${t.rowId}-${t.face}`, label: `${t.rowId} ${t.face}`, hallId: hp.hallId, axis, at, look, depthM: o.depthM ?? p1 - p0 + 0.06, window: o.window ?? uWindow(axis, look, a0 - 0.6, a1 + 0.6) };
  }
  const parts = hp.prims.filter((p) => p.refId === t.containmentId && (p.emitter === 'containment-panel' || p.emitter === 'containment-roof' || p.emitter === 'door'));
  if (!parts.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of parts) {
    const b = primAabb(p);
    x0 = Math.min(x0, b.min.x);
    y0 = Math.min(y0, b.min.y);
    x1 = Math.max(x1, b.max.x);
    y1 = Math.max(y1, b.max.y);
  }
  const metaAxis = parts.find((p) => p.meta?.axis === 'x' || p.meta?.axis === 'y')?.meta?.axis as 'x' | 'y' | undefined;
  const aisleAxis: 'x' | 'y' = metaAxis ?? (x1 - x0 >= y1 - y0 ? 'x' : 'y');
  const axis = aisleAxis;
  const a0 = aisleAxis === 'x' ? x0 : y0;
  const a1 = aisleAxis === 'x' ? x1 : y1;
  const look: 1 | -1 = t.end === 0 ? 1 : -1;
  const at = t.end === 0 ? a0 - 0.05 : a1 + 0.05;
  const q0 = (aisleAxis === 'x' ? y0 : x0) - 1.8;
  const q1 = (aisleAxis === 'x' ? y1 : x1) + 1.8;
  return { id: `elev-aisle-${t.containmentId}-${t.end}`, label: `${t.containmentId} end ${t.end}`, hallId: hp.hallId, axis, at, look, depthM: o.depthM ?? a1 - a0 + 0.1, window: o.window ?? uWindow(axis, look, q0, q1) };
}

export function projectElevation(hp: HallPrims, t: ElevationTarget, o: ProjectElevationOptions = {}): DrawList2D {
  const cut = elevationCut(hp, t, o);
  if (!cut) return emptyDrawList('elevation', hp.hallId, { x: 0, y: 0, w: 0, d: 0 }, { elevation: t });
  const { items, bounds } = projectOrtho(hp, { axis: cut.axis, at: cut.at, look: cut.look, depthM: cut.depthM, ...(cut.window ? { window: cut.window } : {}) }, { withCut: false, ...(o.layers ? { layers: o.layers } : {}), ...(o.outlines ? { outlines: o.outlines } : {}) });
  const list = { space: 'elevation' as const, hallId: hp.hallId, bounds, items, elevation: t };
  return { ...list, hash: drawListHash(list) };
}
