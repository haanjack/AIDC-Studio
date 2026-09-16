import type { ThermalResult } from './types.ts';

/** Axis-aligned zone in hall-local meters (z up). */
export interface ZoneBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface ZoneStats {
  cells: number;
  avgC: number;
  minC: number;
  maxC: number;
  avgSpeed: number;
}

/** Temperature / speed statistics over the fluid cells whose centers lie inside the box. */
export function zoneStats(result: ThermalResult, box: ZoneBox): ZoneStats {
  const { nx, ny, nz, cellSize: h, origin } = result.grid;
  const i0 = Math.max(0, Math.ceil((box.x0 - origin.x) / h - 0.5));
  const i1 = Math.min(nx - 1, Math.floor((box.x1 - origin.x) / h - 0.5));
  const j0 = Math.max(0, Math.ceil((box.y0 - origin.y) / h - 0.5));
  const j1 = Math.min(ny - 1, Math.floor((box.y1 - origin.y) / h - 0.5));
  const k0 = Math.max(0, Math.ceil((box.z0 - origin.z) / h - 0.5));
  const k1 = Math.min(nz - 1, Math.floor((box.z1 - origin.z) / h - 0.5));
  let n = 0;
  let sum = 0;
  let sp = 0;
  let mn = Infinity;
  let mx = -Infinity;
  for (let k = k0; k <= k1; k++)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = i + nx * (j + ny * k);
        if (result.solid[c]) continue;
        const t = result.temperature[c];
        sum += t;
        if (t < mn) mn = t;
        if (t > mx) mx = t;
        const o = 3 * c;
        sp += Math.hypot(result.velocity[o], result.velocity[o + 1], result.velocity[o + 2]);
        n++;
      }
  return { cells: n, avgC: n ? sum / n : Number.NaN, minC: n ? mn : Number.NaN, maxC: n ? mx : Number.NaN, avgSpeed: n ? sp / n : Number.NaN };
}

/** Trilinear temperature sample at a hall-local point (m). */
export function sampleTemperature(result: ThermalResult, x: number, y: number, z: number): number {
  const { nx, ny, nz, cellSize: h, origin } = result.grid;
  const fx = Math.min(nx - 1, Math.max(0, (x - origin.x) / h - 0.5));
  const fy = Math.min(ny - 1, Math.max(0, (y - origin.y) / h - 0.5));
  const fz = Math.min(nz - 1, Math.max(0, (z - origin.z) / h - 0.5));
  const i = Math.min(nx - 2, Math.floor(fx));
  const j = Math.min(ny - 2, Math.floor(fy));
  const k = Math.min(nz - 2, Math.floor(fz));
  const tx = fx - i;
  const ty = fy - j;
  const tz = fz - k;
  const T = result.temperature;
  const at = (a: number, b: number, c: number) => T[a + nx * (b + ny * c)];
  const c00 = at(i, j, k) * (1 - tx) + at(i + 1, j, k) * tx;
  const c10 = at(i, j + 1, k) * (1 - tx) + at(i + 1, j + 1, k) * tx;
  const c01 = at(i, j, k + 1) * (1 - tx) + at(i + 1, j, k + 1) * tx;
  const c11 = at(i, j + 1, k + 1) * (1 - tx) + at(i + 1, j + 1, k + 1) * tx;
  return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
}
