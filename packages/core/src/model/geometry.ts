import type { CatalogItem, Dims, EquipmentInstance, Rect, Vec2 } from './types.ts';

const DEG = Math.PI / 180;

/** Unit vector the equipment FRONT faces (see coordinate conventions in types.ts). */
export function frontVector(rotationDeg: number): Vec2 {
  const t = rotationDeg * DEG;
  return { x: round6(-Math.sin(t)), y: round6(Math.cos(t)) };
}

/** Plan-view footprint size (x extent, y extent) after rotation. Rotations are multiples of 90°. */
export function footprintSize(dims: Dims, rotationDeg: number): { sx: number; sy: number } {
  const quarter = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
  return quarter % 2 === 0 ? { sx: dims.w, sy: dims.d } : { sx: dims.d, sy: dims.w };
}

export function footprintRect(dims: Dims, position: Vec2, rotationDeg: number): Rect {
  const { sx, sy } = footprintSize(dims, rotationDeg);
  return { x: position.x - sx / 2, y: position.y - sy / 2, w: sx, d: sy };
}

export function instanceRect(inst: EquipmentInstance, item: CatalogItem): Rect {
  return footprintRect(item.dims, inst.position, inst.rotationDeg);
}

/** Footprint grown by service clearances (front/rear along the facing axis, sides perpendicular). */
export function clearanceRect(inst: EquipmentInstance, item: CatalogItem): Rect {
  const r = instanceRect(inst, item);
  const f = frontVector(inst.rotationDeg);
  const { front, rear, sides } = item.clearance;
  let { x, y, w, d } = r;
  if (Math.abs(f.y) > 0.5) {
    // facing ±y
    const plusY = f.y > 0 ? front : rear;
    const minusY = f.y > 0 ? rear : front;
    y -= minusY;
    d += plusY + minusY;
    x -= sides;
    w += 2 * sides;
  } else {
    const plusX = f.x > 0 ? front : rear;
    const minusX = f.x > 0 ? rear : front;
    x -= minusX;
    w += plusX + minusX;
    y -= sides;
    d += 2 * sides;
  }
  return { x, y, w, d };
}

/** Center of the front (inlet) face and rear (exhaust) face in plan. */
export function faceCenters(inst: EquipmentInstance, item: CatalogItem): { front: Vec2; rear: Vec2 } {
  const f = frontVector(inst.rotationDeg);
  const half = item.dims.d / 2;
  return {
    front: { x: inst.position.x + f.x * half, y: inst.position.y + f.y * half },
    rear: { x: inst.position.x - f.x * half, y: inst.position.y - f.y * half },
  };
}

export function rectsOverlap(a: Rect, b: Rect, eps = 1e-3): boolean {
  return a.x + a.w > b.x + eps && b.x + b.w > a.x + eps && a.y + a.d > b.y + eps && b.y + b.d > a.y + eps;
}

export function rectContains(outer: Rect, inner: Rect, eps = 1e-3): boolean {
  return inner.x >= outer.x - eps && inner.y >= outer.y - eps && inner.x + inner.w <= outer.x + outer.w + eps && inner.y + inner.d <= outer.y + outer.d + eps;
}

export function rectCenter(r: Rect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.d / 2 };
}

export function rectArea(r: Rect): number {
  return r.w * r.d;
}

export function manhattan(a: Vec2, b: Vec2): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function snap(v: number, step: number): number {
  return Math.round(v / step) * step;
}

export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export function newId(prefix: string): string {
  const rnd = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rnd}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
