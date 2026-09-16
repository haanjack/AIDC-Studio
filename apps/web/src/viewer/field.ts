import * as THREE from 'three';
import { findCatalogItem, footprintRect, frontVector, type CatalogItem, type EquipmentInstance, type Project } from '@aidc/core';
import type { ScalarField } from './types.ts';

/** Decoded, GPU-ready voxel field in hall-local plan coordinates (updated in place across snapshots). */
export interface PreparedField {
  /** grid identity: dims + cell size + origin; same key ⇒ buffers and 3D textures are reused */
  key: string;
  /** incremented on every data update */
  version: number;
  nx: number;
  ny: number;
  nz: number;
  cs: number;
  origin: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  /** °C, solids filled with neighbouring fluid temperature (for smooth sampling) */
  temp: Float32Array;
  tMin: number;
  tMax: number;
  fluidMean: number;
  /** m/s interleaved plan (vx, vy, vz) or null */
  vel: Float32Array | null;
  maxSpeed: number;
  solid: Uint8Array;
  tempTex: THREE.Data3DTexture;
  solidTex: THREE.Data3DTexture;
  dispose(): void;
  /** @internal scratch + caches */
  _filled: Uint8Array;
  _raster: { equipment: unknown; hallId: string; mask: Uint8Array } | null;
  _solidRef: Uint8Array | null;
}

function tex3d(data: Uint8Array, nx: number, ny: number, nz: number): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, nx, ny, nz);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.wrapR = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

/** Rasterize equipment footprints of a hall into a solid mask on the field grid. */
export function rasterizeSolids(project: Project, hallId: string, nx: number, ny: number, nz: number, cs: number, origin: { x: number; y: number; z: number }): Uint8Array {
  const solid = new Uint8Array(nx * ny * nz);
  for (const e of project.equipment) {
    if (e.hallId !== hallId) continue;
    const item = findCatalogItem(e.catalogId);
    if (!item || item.category === 'switch') continue;
    const r = footprintRect(item.dims, e.position, e.rotationDeg);
    const z0 = e.elevation ?? 0;
    const z1 = z0 + item.dims.h;
    const i0 = Math.max(0, Math.ceil((r.x - origin.x) / cs - 0.5));
    const i1 = Math.min(nx - 1, Math.floor((r.x + r.w - origin.x) / cs - 0.5));
    const j0 = Math.max(0, Math.ceil((r.y - origin.y) / cs - 0.5));
    const j1 = Math.min(ny - 1, Math.floor((r.y + r.d - origin.y) / cs - 0.5));
    const k0 = Math.max(0, Math.ceil((z0 - origin.z) / cs - 0.5));
    const k1 = Math.min(nz - 1, Math.floor((z1 - origin.z) / cs - 0.5));
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++) {
        const row = nx * (j + ny * k);
        for (let i = i0; i <= i1; i++) solid[i + row] = 1;
      }
  }
  return solid;
}

function allocateField(nx: number, ny: number, nz: number, cs: number, origin: { x: number; y: number; z: number }, key: string): PreparedField {
  const N = nx * ny * nz;
  const tempTex = tex3d(new Uint8Array(N), nx, ny, nz);
  const solidTex = tex3d(new Uint8Array(N), nx, ny, nz);
  return {
    key,
    version: 0,
    nx,
    ny,
    nz,
    cs,
    origin,
    size: { x: nx * cs, y: ny * cs, z: nz * cs },
    temp: new Float32Array(N),
    tMin: 20,
    tMax: 40,
    fluidMean: 30,
    vel: null,
    maxSpeed: 0,
    solid: new Uint8Array(0),
    tempTex,
    solidTex,
    dispose() {
      tempTex.dispose();
      solidTex.dispose();
    },
    _filled: new Uint8Array(N),
    _raster: null,
    _solidRef: null,
  };
}

/**
 * Decode a ScalarField into GPU-ready form. Pass the previous PreparedField to update it in place:
 * when the grid key (dims, cell size, origin incl. anchor) is unchanged, typed arrays and 3D textures
 * are reused and only their contents are rewritten (no reallocation per solver snapshot).
 */
export function prepareField(field: ScalarField, anchor: { x: number; y: number } | undefined, project: Project, hallId: string, prev?: PreparedField | null): PreparedField {
  const { nx, ny, nz, cellSize: cs } = field.grid;
  const N = nx * ny * nz;
  const origin = { x: field.grid.origin.x + (anchor?.x ?? 0), y: field.grid.origin.y + (anchor?.y ?? 0), z: field.grid.origin.z };
  const key = [nx, ny, nz, cs, origin.x, origin.y, origin.z].join('|');
  let pf: PreparedField;
  if (prev && prev.key === key) pf = prev;
  else {
    prev?.dispose();
    pf = allocateField(nx, ny, nz, cs, origin, key);
  }

  // temperature → °C
  const temp = pf.temp;
  if (field.temperature instanceof Uint8Array) {
    const [lo, hi] = field.tempRange ?? [0, 255];
    const k = (hi - lo) / 255;
    for (let i = 0; i < N; i++) temp[i] = lo + field.temperature[i] * k;
  } else {
    temp.set(field.temperature.subarray(0, N));
  }

  let solid: Uint8Array;
  if (field.solid && field.solid.length >= N) solid = field.solid;
  else if (pf._raster && pf._raster.equipment === project.equipment && pf._raster.hallId === hallId) solid = pf._raster.mask;
  else {
    const mask = rasterizeSolids(project, hallId, nx, ny, nz, cs, origin);
    pf._raster = { equipment: project.equipment, hallId, mask };
    solid = mask;
  }
  pf.solid = solid;

  // statistics over fluid
  let tMin = Infinity;
  let tMax = -Infinity;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < N; i++) {
    if (solid[i]) continue;
    const t = temp[i];
    if (!Number.isFinite(t)) continue;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
    sum += t;
    cnt++;
  }
  if (!cnt) {
    tMin = 20;
    tMax = 40;
  }
  const fluidMean = cnt ? sum / cnt : 30;
  if (tMax - tMin < 0.5) tMax = tMin + 0.5;

  // fill solid cells from fluid neighbours so linear filtering does not bleed
  const filled = pf._filled;
  for (let i = 0; i < N; i++) filled[i] = solid[i] ? 0 : 1;
  const sxy = nx * ny;
  for (let pass = 0; pass < 8; pass++) {
    let changed = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const idx = i + nx * (j + ny * k);
          if (filled[idx]) continue;
          let s = 0;
          let c = 0;
          if (i > 0 && filled[idx - 1] === 1) (s += temp[idx - 1]), c++;
          if (i < nx - 1 && filled[idx + 1] === 1) (s += temp[idx + 1]), c++;
          if (j > 0 && filled[idx - nx] === 1) (s += temp[idx - nx]), c++;
          if (j < ny - 1 && filled[idx + nx] === 1) (s += temp[idx + nx]), c++;
          if (k > 0 && filled[idx - sxy] === 1) (s += temp[idx - sxy]), c++;
          if (k < nz - 1 && filled[idx + sxy] === 1) (s += temp[idx + sxy]), c++;
          if (c) {
            temp[idx] = s / c;
            filled[idx] = 2;
            changed++;
          }
        }
    for (let i = 0; i < N; i++) if (filled[i] === 2) filled[i] = 1;
    if (!changed) break;
  }
  for (let i = 0; i < N; i++) if (!filled[i] || !Number.isFinite(temp[i])) temp[i] = fluidMean;

  const q = (pf.tempTex.image as { data: Uint8Array }).data;
  const inv = 255 / (tMax - tMin);
  for (let i = 0; i < N; i++) q[i] = Math.max(0, Math.min(255, Math.round((temp[i] - tMin) * inv)));
  pf.tempTex.needsUpdate = true;
  if (pf._solidRef !== solid) {
    const sq = (pf.solidTex.image as { data: Uint8Array }).data;
    for (let i = 0; i < N; i++) sq[i] = solid[i] ? 255 : 0;
    pf.solidTex.needsUpdate = true;
    pf._solidRef = solid;
  }

  let maxSpeed = 0;
  if (field.velocity && field.velocity.length >= N * 3) {
    const vel = pf.vel ?? (pf.vel = new Float32Array(N * 3));
    if (field.velocity instanceof Int8Array) {
      const sc = field.velocityScale ?? 0.05;
      for (let i = 0; i < N * 3; i++) vel[i] = field.velocity[i] * sc;
    } else {
      vel.set(field.velocity.subarray(0, N * 3));
    }
    for (let i = 0; i < N; i++) {
      if (solid[i]) {
        vel[i * 3] = vel[i * 3 + 1] = vel[i * 3 + 2] = 0;
        continue;
      }
      const sp = Math.hypot(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
      if (sp > maxSpeed) maxSpeed = sp;
    }
  } else {
    pf.vel = null;
  }

  pf.tMin = tMin;
  pf.tMax = tMax;
  pf.fluidMean = fluidMean;
  pf.maxSpeed = maxSpeed;
  pf.version++;
  return pf;
}

/** Trilinear (cell-centred) temperature at plan (x, y, z). NaN outside. */
export function sampleTemp(f: PreparedField, x: number, y: number, z: number): number {
  const gx = (x - f.origin.x) / f.cs - 0.5;
  const gy = (y - f.origin.y) / f.cs - 0.5;
  const gz = (z - f.origin.z) / f.cs - 0.5;
  if (gx < -0.5 || gy < -0.5 || gz < -0.5 || gx > f.nx - 0.5 || gy > f.ny - 0.5 || gz > f.nz - 0.5) return NaN;
  const i0 = Math.min(f.nx - 2, Math.max(0, Math.floor(gx)));
  const j0 = Math.min(f.ny - 2, Math.max(0, Math.floor(gy)));
  const k0 = Math.min(f.nz - 2, Math.max(0, Math.floor(gz)));
  const fx = Math.min(1, Math.max(0, gx - i0));
  const fy = Math.min(1, Math.max(0, gy - j0));
  const fz = Math.min(1, Math.max(0, gz - k0));
  const nx = f.nx;
  const nxy = f.nx * f.ny;
  const b = i0 + nx * j0 + nxy * k0;
  const T = f.temp;
  const c00 = T[b] * (1 - fx) + T[b + 1] * fx;
  const c10 = T[b + nx] * (1 - fx) + T[b + nx + 1] * fx;
  const c01 = T[b + nxy] * (1 - fx) + T[b + nxy + 1] * fx;
  const c11 = T[b + nxy + nx] * (1 - fx) + T[b + nxy + nx + 1] * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/** Max air temperature sampled just in front of an equipment's inlet face (0.5 / 1.2 / 1.9 m). */
export function rackInletTemp(field: PreparedField, e: EquipmentInstance, item: CatalogItem): number {
  const f = frontVector(Number.isFinite(e.rotationDeg) ? e.rotationDeg : 0);
  const off = item.dims.d / 2 + Math.max(0.1, field.cs * 0.75);
  const x = e.position.x + f.x * off;
  const y = e.position.y + f.y * off;
  let best = NaN;
  for (const z of [0.5, 1.2, 1.9]) {
    const t = sampleTemp(field, x, y, z);
    if (Number.isFinite(t) && !(t <= best)) best = t;
  }
  return best;
}

export function cellIndexAt(f: PreparedField, x: number, y: number, z: number): number {
  const i = Math.floor((x - f.origin.x) / f.cs);
  const j = Math.floor((y - f.origin.y) / f.cs);
  const k = Math.floor((z - f.origin.z) / f.cs);
  if (i < 0 || j < 0 || k < 0 || i >= f.nx || j >= f.ny || k >= f.nz) return -1;
  return i + f.nx * (j + f.ny * k);
}
