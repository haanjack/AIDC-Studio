// Inter-hall trunk sleeves (finish v2 2차, DECISIONS-v2-2 §D5: "홀 간 트렁크는 슬리브 사이 사이트 경로로 그림(홀 원점 규칙 폐기)").
//
// A trunk between two halls leaves its hall through a sleeve on the wall that faces the peer hall, at the quarter point of the part of
// that wall that overlaps the peer (the middle is kept for the feeder sleeve) (moved in 0.1 m steps off columns, shafts and ducted hot-aisle chimneys, ≥ 0.8 m from a corner), and runs
// on a site pathway to the peer's sleeve. The network length model (engines/network.ts interHallLengthM) and the 3D / audit geometry
// (engines/interHall.ts) read the same position, so the cable length and the drawing never disagree.
import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect } from '../model/geometry.ts';
import type { Hall, Project, Rect } from '../model/types.ts';
import { blockingKeepouts } from './rows.ts';

export interface TrunkSleeveSpot {
  hallId: string;
  peerHallId: string;
  wall: 'N' | 'S' | 'E' | 'W';
  /** along the wall (x for S / N, y for W / E), hall-local */
  along: number;
  /** sleeve centre on the inner wall face, hall-local and site coordinates */
  local: { x: number; y: number };
  site: { x: number; y: number };
}

const cache = new WeakMap<Project, Map<string, TrunkSleeveSpot | null>>();
const overlap = (r: Rect, q: Rect) => r.x < q.x + q.w - 1e-6 && r.x + r.w > q.x + 1e-6 && r.y < q.y + q.d - 1e-6 && r.y + r.d > q.y + 1e-6;

function facingWall(a: Hall, b: Hall): 'N' | 'S' | 'E' | 'W' {
  const gaps: ['N' | 'S' | 'E' | 'W', number][] = [
    ['E', b.origin.x - (a.origin.x + a.width)],
    ['W', a.origin.x - (b.origin.x + b.width)],
    ['N', b.origin.y - (a.origin.y + a.depth)],
    ['S', a.origin.y - (b.origin.y + b.depth)],
  ];
  const best = gaps.reduce((p, q) => (q[1] > p[1] ? q : p));
  if (best[1] >= 0) return best[0];
  // overlapping halls: the dominant direction between the centres
  const dx = b.origin.x + b.width / 2 - (a.origin.x + a.width / 2);
  const dy = b.origin.y + b.depth / 2 - (a.origin.y + a.depth / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : dy >= 0 ? 'N' : 'S';
}

/** Trunk sleeve of `hallId` towards `peerHallId` (memoised per project object). */
export function trunkSleeveSpot(project: Project, hallId: string, peerHallId: string): TrunkSleeveSpot | undefined {
  let m = cache.get(project);
  if (!m) {
    m = new Map();
    cache.set(project, m);
  }
  const key = `${hallId}|${peerHallId}`;
  if (m.has(key)) return m.get(key) ?? undefined;
  const a = project.halls.find((h) => h.id === hallId);
  const b = project.halls.find((h) => h.id === peerHallId);
  if (!a || !b || a.id === b.id) {
    m.set(key, null);
    return undefined;
  }
  const wall = facingWall(a, b);
  const alongY = wall === 'E' || wall === 'W';
  const len = alongY ? a.depth : a.width;
  const a0 = alongY ? a.origin.y : a.origin.x;
  const b0 = alongY ? b.origin.y : b.origin.x;
  const b1 = b0 + (alongY ? b.depth : b.width);
  const lo = Math.max(a0, b0);
  const hi = Math.min(a0 + len, b1);
  // quarter point of the overlap: feeder sleeves take the middle of a wall (engines/powerGeometry.ts), so the trunk keeps clear of them
  const target = (hi - lo > 1.6 ? lo + (hi - lo) * 0.25 : Math.min(a0 + len, Math.max(a0, (b0 + b1) / 2))) - a0;
  // obstacles near the wall: columns / shafts, ducted chimneys and row footprints within 3 m of the inner face
  const obstacles: Rect[] = [
    ...blockingKeepouts(a.keepouts, 0.1),
    ...project.containments.filter((c) => c.hallId === a.id && c.ductedToPlenum).map((c) => ({ x: c.rect.x - 0.1, y: c.rect.y - 0.1, w: c.rect.w + 0.2, d: c.rect.d + 0.2 })),
    ...project.equipment.filter((e) => e.hallId === a.id && e.rowId).map((e) => {
      const it = findCatalogItem(e.catalogId);
      return it ? footprintRect(it.dims, e.position, e.rotationDeg) : { x: 0, y: 0, w: 0, d: 0 };
    }),
  ];
  const strip = (s: number): Rect => {
    const depth = 3;
    switch (wall) {
      case 'W': return { x: 0, y: s - 0.3, w: depth, d: 0.6 };
      case 'E': return { x: a.width - depth, y: s - 0.3, w: depth, d: 0.6 };
      case 'S': return { x: s - 0.3, y: 0, w: 0.6, d: depth };
      default: return { x: s - 0.3, y: a.depth - depth, w: 0.6, d: depth };
    }
  };
  let along = Math.min(len - 0.8, Math.max(0.8, target));
  for (let i = 0; i <= Math.ceil(len / 0.1); i++) {
    const s = target + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.1;
    if (s < 0.8 || s > len - 0.8) continue;
    if (obstacles.some((o) => overlap(strip(s), o))) continue;
    along = s;
    break;
  }
  along = Math.round(along * 1000) / 1000;
  const local = wall === 'W' ? { x: 0, y: along } : wall === 'E' ? { x: a.width, y: along } : wall === 'S' ? { x: along, y: 0 } : { x: along, y: a.depth };
  const spot: TrunkSleeveSpot = { hallId, peerHallId, wall, along, local, site: { x: a.origin.x + local.x, y: a.origin.y + local.y } };
  m.set(key, spot);
  return spot;
}
