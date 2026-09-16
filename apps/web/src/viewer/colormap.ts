import * as THREE from 'three';

/**
 * Thermal colormap: Turbo (Anton Mikhailov, Google LLC, 2019 — Apache-2.0,
 * https://research.google/blog/turbo-an-improved-rainbow-colormap-for-visualization/ ,
 * LUT https://gist.github.com/mikhailov-work/6a308c20e494d9e0ccc29036b28faa7a). The 17 control points below are
 * entries 0, 16, …, 240, 255 of the official 256-entry sRGB lookup table, interpolated linearly.
 * Copyright 2019 Google LLC. SPDX-License-Identifier: Apache-2.0 (these colour values only).
 */
const TURBO_SRGB: [number, number, number][] = [
  [0.18995, 0.07176, 0.23217], [0.25107, 0.25237, 0.63374], [0.27628, 0.42118, 0.89123], [0.25862, 0.57958, 0.99876],
  [0.15844, 0.73551, 0.92305], [0.09267, 0.86554, 0.7623], [0.19659, 0.94901, 0.59466], [0.42778, 0.99419, 0.38575],
  [0.64362, 0.98999, 0.23356], [0.80473, 0.92452, 0.20459], [0.93301, 0.81236, 0.22667], [0.99314, 0.67408, 0.20348],
  [0.9836, 0.49291, 0.12849], [0.92105, 0.31489, 0.05475], [0.81608, 0.18462, 0.01809], [0.66449, 0.08436, 0.00424],
  [0.4796, 0.01583, 0.01055],
];
const TURBO_X = TURBO_SRGB.map((_, i) => (i === TURBO_SRGB.length - 1 ? 255 : i * 16) / 255);

const smoothstep = (a: number, b: number, t: number) => {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/**
 * Volume opacity transfer function (AIDC-authored): transparent for the coolest ~6 % of the range, rising smoothly to 0.65
 * by mid-range so hot plumes read through cooler air, easing back to ~0.45 at the very top so saturated cores do not hide
 * the geometry behind them.
 */
export function thermalOpacity(t: number): number {
  const v = Math.min(1, Math.max(0, t));
  return 0.65 * smoothstep(0.06, 0.5, v) * (1 - 0.3 * smoothstep(0.8, 1, v));
}

/** Temperature colormap for CFD / thermal overlays and their legends: Turbo RGB + thermalOpacity() alpha. */
export const THERMAL_COLORMAP: { name: string; license: string; x: number[]; rgba: [number, number, number, number][] } = {
  name: 'Turbo',
  license: 'Apache-2.0 (Google LLC, 2019)',
  x: TURBO_X,
  rgba: TURBO_SRGB.map((c, i) => [c[0], c[1], c[2], Math.round(thermalOpacity(TURBO_X[i]) * 1e4) / 1e4]),
};

export function sampleColormap(t: number, out: [number, number, number, number] = [0, 0, 0, 0]): [number, number, number, number] {
  const { x, rgba } = THERMAL_COLORMAP;
  const v = Math.min(1, Math.max(0, t));
  let i = 1;
  while (i < x.length - 1 && v > x[i]) i++;
  const f = (v - x[i - 1]) / Math.max(1e-9, x[i] - x[i - 1]);
  const a = rgba[i - 1];
  const b = rgba[i];
  for (let c = 0; c < 4; c++) out[c] = a[c] + (b[c] - a[c]) * Math.min(1, Math.max(0, f));
  return out;
}

let cachedTexture: THREE.DataTexture | null = null;

/** 256×1 RGBA lookup texture (sRGB-ish display colors, linear filtering). */
export function colormapTexture(): THREE.DataTexture {
  if (cachedTexture) return cachedTexture;
  const n = 256;
  const data = new Uint8Array(n * 4);
  const tmp: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    sampleColormap(i / (n - 1), tmp);
    data[i * 4] = Math.round(tmp[0] * 255);
    data[i * 4 + 1] = Math.round(tmp[1] * 255);
    data[i * 4 + 2] = Math.round(tmp[2] * 255);
    data[i * 4 + 3] = Math.round(tmp[3] * 255);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  cachedTexture = tex;
  return tex;
}

/** Sequential ramp for value color modes (power, inlet temperature): deep blue → teal → yellow → red. */
const VALUE_STOPS: [number, [number, number, number]][] = [
  [0, [0.12, 0.23, 0.55]],
  [0.3, [0.05, 0.55, 0.72]],
  [0.55, [0.35, 0.78, 0.45]],
  [0.75, [0.98, 0.8, 0.2]],
  [1, [0.9, 0.2, 0.15]],
];

export function valueColor(t: number, target = new THREE.Color()): THREE.Color {
  const v = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  let i = 1;
  while (i < VALUE_STOPS.length - 1 && v > VALUE_STOPS[i][0]) i++;
  const [x0, c0] = VALUE_STOPS[i - 1];
  const [x1, c1] = VALUE_STOPS[i];
  const f = Math.min(1, Math.max(0, (v - x0) / (x1 - x0)));
  return target.setRGB(c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f, THREE.SRGBColorSpace);
}

export function valueGradientCss(): string {
  return `linear-gradient(90deg, ${VALUE_STOPS.map(([x, c]) => `rgb(${c.map((v) => Math.round(v * 255)).join(',')}) ${x * 100}%`).join(', ')})`;
}

export function cfdGradientCss(): string {
  const { x, rgba } = THERMAL_COLORMAP;
  return `linear-gradient(90deg, ${x.map((p, i) => `rgb(${rgba[i].slice(0, 3).map((v) => Math.round(v * 255)).join(',')}) ${p * 100}%`).join(', ')})`;
}

export const CATEGORY_COLORS: Record<string, string> = {
  'gpu-rack': '#4fb477',
  'cpu-rack': '#4f8cc9',
  'storage-rack': '#b07cd8',
  'network-rack': '#e0a526',
  'mgmt-rack': '#9aa5b1',
  cdu: '#2fb5c8',
  crah: '#5fc3e8',
  'fan-wall': '#5fc3e8',
  rpp: '#d65a5a',
  ups: '#d65a5a',
  other: '#8a8f96',
};

export const WAVE_COLORS = ['#4fb477', '#2fb5c8', '#e0a526', '#b07cd8', '#d65a5a', '#4f8cc9', '#e67e22', '#1abc9c'];

export const NETWORK_ROLE_COLORS: Record<string, string> = {
  'scale-out-leaf': '#4fb477',
  'scale-out-spine': '#2fb5c8',
  'scale-out-core': '#1b7f8f',
  frontend: '#e0a526',
  storage: '#b07cd8',
  oob: '#9aa5b1',
  mixed: '#d65a5a',
  none: '#3a4048',
};

export const FABRIC_COLORS: Record<string, string> = {
  'scale-out': '#4fb477',
  scaleout: '#4fb477',
  frontend: '#ff8f00',
  storage: '#b07cd8',
  oob: '#8fa3b8',
  nvlink: '#2fb5c8',
  spine: '#2fb5c8',
};

export function fabricColor(fabric: string): string {
  const f = fabric.toLowerCase();
  if (f.includes('front')) return FABRIC_COLORS.frontend;
  if (f.includes('stor')) return FABRIC_COLORS.storage;
  if (f.includes('oob') || f.includes('mgmt')) return FABRIC_COLORS.oob;
  if (f.includes('spine')) return FABRIC_COLORS.spine;
  if (f.includes('nvlink')) return FABRIC_COLORS.nvlink;
  return FABRIC_COLORS['scale-out'];
}
