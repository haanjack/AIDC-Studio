import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { sampleColormap } from './colormap.ts';
import type { PreparedField } from './field.ts';

type Clip = [number, number, number, number];

interface SeedPools {
  fast: Int32Array;
  fluid: Int32Array;
}

/** Seed cells: fast-moving fluid (supply jets, chimneys) + a uniform fluid sample, inside the clip rect. */
function buildPools(field: PreparedField, clip: Clip): SeedPools {
  const vel = field.vel;
  const { nx, ny, nz, cs, solid } = field;
  const N = nx * ny * nz;
  const [cx0, cy0, cx1, cy1] = clip;
  if (!vel) return { fast: new Int32Array(0), fluid: new Int32Array(0) };
  const fastThr = Math.max(0.25, field.maxSpeed * 0.3);
  const fast: number[] = [];
  const fluid: number[] = [];
  const strideFluid = Math.max(1, Math.floor(N / 400000));
  for (let i = 0; i < N; i++) {
    if (solid[i]) continue;
    const ii = i % nx;
    const jj = Math.floor(i / nx) % ny;
    const px = field.origin.x + (ii + 0.5) * cs;
    const py = field.origin.y + (jj + 0.5) * cs;
    if (px < cx0 || py < cy0 || px > cx1 || py > cy1) continue;
    const sp = Math.hypot(vel[i * 3], vel[i * 3 + 1], vel[i * 3 + 2]);
    if (sp > fastThr && fast.length < 300000) fast.push(i);
    if (i % strideFluid === 0 && sp > 0.05) fluid.push(i);
  }
  return {
    fast: Int32Array.from(fast.length ? fast : fluid),
    fluid: Int32Array.from(fluid.length ? fluid : fast),
  };
}

/**
 * CPU-advected airflow tracers: short velocity-aligned streaks (LineSegments) with bright heads,
 * coloured by local temperature using the thermal (Turbo) colormap.
 * Particle buffers persist across in-place field updates (same PreparedField); only seed pools refresh.
 */
export function Airflow({ field, version = 0, rangeC, count = 16000, speed = 1, clip }: { field: PreparedField; version?: number; rangeC: [number, number]; count?: number; speed?: number; clip?: Clip }) {
  const [cx0, cy0, cx1, cy1] = clip ?? [-1e6, -1e6, 1e6, 1e6];
  const pools = useMemo(
    () => buildPools(field, [cx0, cy0, cx1, cy1]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field, version, cx0, cy0, cx1, cy1],
  );
  const poolsRef = useRef(pools);
  poolsRef.current = pools;

  const sim = useMemo(() => {
    const { nx, ny, cs } = field;
    const n = Math.min(count, Math.max(2000, Math.round(poolsRef.current.fluid.length * 0.4)));
    const pos = new Float32Array(n * 3);
    const age = new Float32Array(n);
    const life = new Float32Array(n);
    const linePos = new Float32Array(n * 6);
    const lineCol = new Float32Array(n * 8);
    const headPos = new Float32Array(n * 3);
    const headCol = new Float32Array(n * 4);
    const lut = new Float32Array(256 * 3);
    const c = new THREE.Color();
    const tmp: [number, number, number, number] = [0, 0, 0, 0];
    for (let i = 0; i < 256; i++) {
      sampleColormap(i / 255, tmp);
      c.setRGB(tmp[0], tmp[1], tmp[2], THREE.SRGBColorSpace);
      lut[i * 3] = c.r;
      lut[i * 3 + 1] = c.g;
      lut[i * 3 + 2] = c.b;
    }
    const nxy = nx * ny;
    const spawn = (p: number) => {
      const { fast, fluid } = poolsRef.current;
      const pool = Math.random() < 0.75 && fast.length ? fast : fluid;
      if (!pool.length) {
        age[p] = 0;
        life[p] = 0.01;
        return;
      }
      const idx = pool[(Math.random() * pool.length) | 0] ?? 0;
      const k = Math.floor(idx / nxy);
      const j = Math.floor((idx - k * nxy) / nx);
      const i = idx - k * nxy - j * nx;
      pos[p * 3] = field.origin.x + (i + Math.random()) * cs;
      pos[p * 3 + 1] = field.origin.y + (j + Math.random()) * cs;
      pos[p * 3 + 2] = field.origin.z + (k + Math.random()) * cs;
      age[p] = 0;
      life[p] = 2.5 + Math.random() * 5;
    };
    for (let p = 0; p < n; p++) {
      spawn(p);
      age[p] = Math.random() * life[p];
    }
    const lines = new THREE.BufferGeometry();
    lines.setAttribute('position', new THREE.BufferAttribute(linePos, 3).setUsage(THREE.DynamicDrawUsage));
    lines.setAttribute('color', new THREE.BufferAttribute(lineCol, 4).setUsage(THREE.DynamicDrawUsage));
    const heads = new THREE.BufferGeometry();
    heads.setAttribute('position', new THREE.BufferAttribute(headPos, 3).setUsage(THREE.DynamicDrawUsage));
    heads.setAttribute('color', new THREE.BufferAttribute(headCol, 4).setUsage(THREE.DynamicDrawUsage));
    return { n, pos, age, life, linePos, lineCol, headPos, headCol, lut, spawn, lines, heads };
  }, [field, count]);

  const materials = useMemo(
    () => ({
      line: new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
      head: new THREE.PointsMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, size: 2.2, sizeAttenuation: false, toneMapped: false }),
    }),
    [],
  );

  useEffect(
    () => () => {
      sim.lines.dispose();
      sim.heads.dispose();
    },
    [sim],
  );

  useFrame((_, delta) => {
    const vel = field.vel;
    if (!vel) return;
    const dt = Math.min(delta, 0.05) * speed;
    const { n, pos, age, life, linePos, lineCol, headPos, headCol, lut, spawn } = sim;
    const T = field.temp;
    const { nx, ny, nz, cs, solid } = field;
    const ox = field.origin.x;
    const oy = field.origin.y;
    const oz = field.origin.z;
    const nxy = nx * ny;
    const r0 = rangeC[0];
    const rs = 255 / Math.max(0.1, rangeC[1] - rangeC[0]);
    const trail = 0.22;
    for (let p = 0; p < n; p++) {
      let x = pos[p * 3];
      let y = pos[p * 3 + 1];
      let z = pos[p * 3 + 2];
      const gx = (x - ox) / cs - 0.5;
      const gy = (y - oy) / cs - 0.5;
      const gz = (z - oz) / cs - 0.5;
      const ci = Math.floor(gx + 0.5);
      const cj = Math.floor(gy + 0.5);
      const ck = Math.floor(gz + 0.5);
      age[p] += dt;
      if (ci < 0 || cj < 0 || ck < 0 || ci >= nx || cj >= ny || ck >= nz || x < cx0 || y < cy0 || x > cx1 || y > cy1 || solid[ci + nx * cj + nxy * ck] || age[p] > life[p]) {
        spawn(p);
        lineCol[p * 8 + 3] = 0;
        headCol[p * 4 + 3] = 0;
        continue;
      }
      const i0 = gx < 0 ? 0 : gx > nx - 2 ? nx - 2 : gx | 0;
      const j0 = gy < 0 ? 0 : gy > ny - 2 ? ny - 2 : gy | 0;
      const k0 = gz < 0 ? 0 : gz > nz - 2 ? nz - 2 : gz | 0;
      let fx = gx - i0;
      let fy = gy - j0;
      let fz = gz - k0;
      fx = fx < 0 ? 0 : fx > 1 ? 1 : fx;
      fy = fy < 0 ? 0 : fy > 1 ? 1 : fy;
      fz = fz < 0 ? 0 : fz > 1 ? 1 : fz;
      const b = i0 + nx * j0 + nxy * k0;
      const w000 = (1 - fx) * (1 - fy) * (1 - fz);
      const w100 = fx * (1 - fy) * (1 - fz);
      const w010 = (1 - fx) * fy * (1 - fz);
      const w110 = fx * fy * (1 - fz);
      const w001 = (1 - fx) * (1 - fy) * fz;
      const w101 = fx * (1 - fy) * fz;
      const w011 = (1 - fx) * fy * fz;
      const w111 = fx * fy * fz;
      const b1 = b + 1;
      const b2 = b + nx;
      const b3 = b + nx + 1;
      const b4 = b + nxy;
      const b5 = b + nxy + 1;
      const b6 = b + nxy + nx;
      const b7 = b + nxy + nx + 1;
      const vx = vel[b * 3] * w000 + vel[b1 * 3] * w100 + vel[b2 * 3] * w010 + vel[b3 * 3] * w110 + vel[b4 * 3] * w001 + vel[b5 * 3] * w101 + vel[b6 * 3] * w011 + vel[b7 * 3] * w111;
      const vy = vel[b * 3 + 1] * w000 + vel[b1 * 3 + 1] * w100 + vel[b2 * 3 + 1] * w010 + vel[b3 * 3 + 1] * w110 + vel[b4 * 3 + 1] * w001 + vel[b5 * 3 + 1] * w101 + vel[b6 * 3 + 1] * w011 + vel[b7 * 3 + 1] * w111;
      const vz = vel[b * 3 + 2] * w000 + vel[b1 * 3 + 2] * w100 + vel[b2 * 3 + 2] * w010 + vel[b3 * 3 + 2] * w110 + vel[b4 * 3 + 2] * w001 + vel[b5 * 3 + 2] * w101 + vel[b6 * 3 + 2] * w011 + vel[b7 * 3 + 2] * w111;
      const sp = Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (sp < 0.02 && age[p] > 1.2) {
        spawn(p);
        continue;
      }
      x += vx * dt;
      y += vy * dt;
      z += vz * dt;
      pos[p * 3] = x;
      pos[p * 3 + 1] = y;
      pos[p * 3 + 2] = z;
      const temp = T[ci + nx * cj + nxy * ck];
      let li = ((temp - r0) * rs) | 0;
      li = li < 0 ? 0 : li > 255 ? 255 : li;
      const fade = Math.min(1, age[p] * 2.5, (life[p] - age[p]) * 1.5) * Math.min(0.85, 0.2 + sp * 0.8);
      const cr = lut[li * 3];
      const cg = lut[li * 3 + 1];
      const cb = lut[li * 3 + 2];
      const o6 = p * 6;
      linePos[o6] = x;
      linePos[o6 + 1] = z;
      linePos[o6 + 2] = -y;
      linePos[o6 + 3] = x - vx * trail;
      linePos[o6 + 4] = z - vz * trail;
      linePos[o6 + 5] = -(y - vy * trail);
      const o8 = p * 8;
      lineCol[o8] = cr;
      lineCol[o8 + 1] = cg;
      lineCol[o8 + 2] = cb;
      lineCol[o8 + 3] = fade;
      lineCol[o8 + 4] = cr;
      lineCol[o8 + 5] = cg;
      lineCol[o8 + 6] = cb;
      lineCol[o8 + 7] = 0;
      headPos[p * 3] = x;
      headPos[p * 3 + 1] = z;
      headPos[p * 3 + 2] = -y;
      headCol[p * 4] = cr;
      headCol[p * 4 + 1] = cg;
      headCol[p * 4 + 2] = cb;
      headCol[p * 4 + 3] = fade * 0.9;
    }
    (sim.lines.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (sim.lines.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (sim.heads.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (sim.heads.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  });

  return (
    <group renderOrder={20}>
      <lineSegments geometry={sim.lines} material={materials.line} frustumCulled={false} raycast={() => null} />
      <points geometry={sim.heads} material={materials.head} frustumCulled={false} raycast={() => null} />
    </group>
  );
}
