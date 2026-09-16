import type { EquipmentCategory, Hall, Project, Vec2 } from '../model/types.ts';

/** Site-space point: Z-up, right-handed, meters (hall.origin + hall-local). */
export interface SitePoint {
  x: number;
  y: number;
  z: number;
}

export type Tuple3 = [number, number, number];

export function selectHalls(project: Project, hallId?: string): Hall[] {
  return hallId ? project.halls.filter((h) => h.id === hallId) : project.halls;
}

export function toSite(hall: Hall, p: Vec2, z = 0): SitePoint {
  return { x: hall.origin.x + p.x, y: hall.origin.y + p.y, z };
}

/** Z-up RH (USD) → Y-up RH (glTF / Godot / three.js): (x, y, z) → (x, z, -y). Rotation about +Z maps to rotation about +Y by the same angle. */
export function zUpToYUp(p: SitePoint): Tuple3 {
  return [r4(p.x), r4(p.z), r4(-p.y)];
}

/** Z-up RH meters → Unreal (Z-up, left-handed, centimeters): (x, y, z) → (100x, -100y, 100z). Yaw = -rotationDeg. */
export function zUpToUnreal(p: SitePoint): Tuple3 {
  return [r4(p.x * 100), r4(-p.y * 100), r4(p.z * 100)];
}

export function r4(v: number): number {
  const r = Math.round(v * 1e4) / 1e4;
  return Object.is(r, -0) ? 0 : r;
}

/** Identifier safe for USD prim names and Godot node names. */
export function primName(s: string): string {
  let n = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(n)) n = `_${n}`;
  return n || '_';
}

/** Returns a function producing unique identifiers within one scope. */
export function uniqueNamer(): (s: string) => string {
  const used = new Map<string, number>();
  return (s: string) => {
    const base = primName(s);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}_${n}`;
  };
}

export function hexToRgb(hex: string | undefined, fallback: Tuple3 = [0.5, 0.5, 0.5]): Tuple3 {
  if (!hex) return fallback;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [r4(((v >> 16) & 255) / 255), r4(((v >> 8) & 255) / 255), r4((v & 255) / 255)];
}

export const CATEGORY_COLORS: Record<EquipmentCategory, string> = {
  'gpu-rack': '#3a3f44',
  'cpu-rack': '#30353a',
  'storage-rack': '#26435a',
  'network-rack': '#1f3b2b',
  'mgmt-rack': '#3b3320',
  switch: '#1f3b2b',
  nic: '#1f3b2b',
  cdu: '#d9dadb',
  crah: '#e3e4e6',
  'fan-wall': '#cfd2d4',
  rpp: '#5a6b7a',
  'busway-tapoff': '#5a6b7a',
  ups: '#e6e7e8',
  battery: '#4a7a5a',
  transformer: '#8a9096',
  generator: '#d8c35a',
  switchgear: '#7d8791',
  chiller: '#c7cacc',
  'dry-cooler': '#c7cacc',
  'cooling-tower': '#c7cacc',
  column: '#9a9a9a',
  other: '#808080',
};

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'project';
}
