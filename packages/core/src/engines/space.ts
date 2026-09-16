import { clearanceRect, frontVector, instanceRect, rectArea, rectsOverlap } from '../model/geometry.ts';
import type { Hall, Rect, SpaceAnalysis } from '../model/types.ts';
import { type Ctx, IT_LOAD_CATEGORIES, type Placed, RACK_CATEGORIES } from './context.ts';

/** Floor-standing equipment (switches live inside racks). */
export function floorItems(items: readonly Placed[]): Placed[] {
  return items.filter((p) => p.item.category !== 'switch');
}

/** Service clearance zones (front / rear / sides) as separate rects, excluding the footprint. */
export function clearanceZones(p: Placed): { zone: 'front' | 'rear' | 'side'; rect: Rect }[] {
  const r = instanceRect(p.e, p.item);
  const f = frontVector(p.e.rotationDeg);
  const { front, rear, sides } = p.item.clearance;
  const zones: { zone: 'front' | 'rear' | 'side'; rect: Rect }[] = [];
  if (Math.abs(f.y) > 0.5) {
    const plusY = f.y > 0 ? front : rear;
    const minusY = f.y > 0 ? rear : front;
    if (plusY > 0) zones.push({ zone: f.y > 0 ? 'front' : 'rear', rect: { x: r.x, y: r.y + r.d, w: r.w, d: plusY } });
    if (minusY > 0) zones.push({ zone: f.y > 0 ? 'rear' : 'front', rect: { x: r.x, y: r.y - minusY, w: r.w, d: minusY } });
    if (sides > 0) {
      zones.push({ zone: 'side', rect: { x: r.x - sides, y: r.y, w: sides, d: r.d } });
      zones.push({ zone: 'side', rect: { x: r.x + r.w, y: r.y, w: sides, d: r.d } });
    }
  } else {
    const plusX = f.x > 0 ? front : rear;
    const minusX = f.x > 0 ? rear : front;
    if (plusX > 0) zones.push({ zone: f.x > 0 ? 'front' : 'rear', rect: { x: r.x + r.w, y: r.y, w: plusX, d: r.d } });
    if (minusX > 0) zones.push({ zone: f.x > 0 ? 'rear' : 'front', rect: { x: r.x - minusX, y: r.y, w: minusX, d: r.d } });
    if (sides > 0) {
      zones.push({ zone: 'side', rect: { x: r.x, y: r.y - sides, w: r.w, d: sides } });
      zones.push({ zone: 'side', rect: { x: r.x, y: r.y + r.d, w: r.w, d: sides } });
    }
  }
  return zones;
}

const BUCKET = 2.0;

/** Spatial hash of footprints for O(n) neighbour queries. */
export class FootprintIndex {
  private cells = new Map<string, number[]>();
  readonly rects: Rect[];
  constructor(readonly items: readonly Placed[]) {
    this.rects = items.map((p) => instanceRect(p.e, p.item));
    this.rects.forEach((r, i) => {
      for (const key of this.keys(r)) {
        const c = this.cells.get(key);
        if (c) c.push(i);
        else this.cells.set(key, [i]);
      }
    });
  }
  private *keys(r: Rect) {
    const x0 = Math.floor(r.x / BUCKET);
    const x1 = Math.floor((r.x + r.w) / BUCKET);
    const y0 = Math.floor(r.y / BUCKET);
    const y1 = Math.floor((r.y + r.d) / BUCKET);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) yield `${x},${y}`;
  }
  /** indices of footprints overlapping r */
  query(r: Rect, eps = 1e-3): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    for (const key of this.keys(r)) {
      for (const i of this.cells.get(key) ?? []) {
        if (seen.has(i)) continue;
        seen.add(i);
        if (rectsOverlap(r, this.rects[i], eps)) out.push(i);
      }
    }
    return out;
  }
}

export interface ClearanceIntrusion {
  id: string;
  otherId: string;
  zone: 'front' | 'rear' | 'side';
}

/** Clearance zones intruded by other equipment footprints (zones may overlap each other). */
export function findClearanceIntrusions(items: readonly Placed[], index = new FootprintIndex(items)): ClearanceIntrusion[] {
  const out: ClearanceIntrusion[] = [];
  items.forEach((p, i) => {
    for (const z of clearanceZones(p)) {
      for (const j of index.query(z.rect, 0.01)) {
        if (j === i) continue;
        out.push({ id: p.e.id, otherId: items[j].e.id, zone: z.zone });
      }
    }
  });
  return out;
}

/** Fraction of the hall covered by footprints + clearance zones (raster union). */
function coveredArea(hall: Hall, items: readonly Placed[]): number {
  const area = hall.width * hall.depth;
  if (area <= 0) return 0;
  const res = Math.max(0.1, Math.sqrt(area / 2_000_000));
  const nx = Math.max(1, Math.ceil(hall.width / res));
  const ny = Math.max(1, Math.ceil(hall.depth / res));
  const grid = new Uint8Array(nx * ny);
  for (const p of items) {
    const r = clearanceRect(p.e, p.item);
    const i0 = Math.max(0, Math.floor(r.x / res));
    const i1 = Math.min(nx, Math.ceil((r.x + r.w) / res));
    const j0 = Math.max(0, Math.floor(r.y / res));
    const j1 = Math.min(ny, Math.ceil((r.y + r.d) / res));
    for (let j = j0; j < j1; j++) grid.fill(1, j * nx + i0, j * nx + Math.max(i0, i1));
  }
  let n = 0;
  for (let k = 0; k < grid.length; k++) n += grid[k];
  return Math.min(area, n * res * res);
}

/** Distributed floor load: weight over footprint grown by half of each clearance. */
export function floorLoadKgPerM2(p: Placed): number {
  const r = instanceRect(p.e, p.item);
  const { front, rear, sides } = p.item.clearance;
  const f = frontVector(p.e.rotationDeg);
  const along = (front + rear) / 2;
  const area = Math.abs(f.y) > 0.5 ? (r.w + sides) * (r.d + along) : (r.w + along) * (r.d + sides);
  return area > 0 ? p.item.weightKg / area : 0;
}

export function analyzeSpaceCtx(ctx: Ctx): SpaceAnalysis[] {
  return ctx.project.halls.map((hall) => {
    const items = floorItems(ctx.byHall.get(hall.id) ?? []);
    const areaM2 = hall.width * hall.depth;
    const occupiedM2 = items.reduce((s, p) => s + rectArea(instanceRect(p.e, p.item)), 0);
    const racks = items.filter((p) => RACK_CATEGORIES.has(p.item.category));
    const gpuCount = items.reduce((s, p) => s + (p.item.category === 'gpu-rack' ? p.item.compute?.gpus ?? 0 : 0), 0);
    const itKW = items.reduce((s, p) => s + (IT_LOAD_CATEGORIES.has(p.item.category) ? p.item.power?.nameplateKW ?? 0 : 0), 0);
    const intrusions = findClearanceIntrusions(items);
    return {
      hallId: hall.id,
      areaM2,
      occupiedM2,
      whiteSpaceUtilization: areaM2 > 0 ? coveredArea(hall, items) / areaM2 : 0,
      rackCount: racks.length,
      gpuCount,
      itDensityKWPerM2: areaM2 > 0 ? itKW / areaM2 : 0,
      maxFloorLoadKgPerM2: items.reduce((m, p) => Math.max(m, floorLoadKgPerM2(p)), 0),
      clearanceViolations: new Set(intrusions.map((v) => v.id)).size,
    };
  });
}
