// r4 stream A0: orthographic projection onto a vertical plane shared by projectSection (with cut) and projectElevation (no cut).
// Frame (DrawingCut convention, model/types.ts): the plane is ⟂ `axis` at `at`; s = look·(n − at) is the distance in front of the
// viewer; beyond = (0, depthM]. u increases to the viewer's right: axis 'y' → u = look·x; axis 'x' → u = −look·y.
import type { Rect } from '../../model/types.ts';
import type { DrawItem2D } from '../drawList.ts';
import type { LayerId } from '../layers.ts';
import { primAabb, type Aabb3, type HallPrims, type Prim } from '../prims.ts';
import { FLOOR_MARK_LAYERS, hallIndex, primLod } from './common.ts';
import { visibleOutlines, type OccRect } from './occlude.ts';

export interface OrthoFrame {
  axis: 'x' | 'y';
  at: number;
  look: 1 | -1;
  depthM: number;
  window?: { u0: number; u1: number };
}

/** u of a plan point */
export function frameU(f: Pick<OrthoFrame, 'axis' | 'look'>, x: number, y: number): number {
  return f.axis === 'y' ? f.look * x : -f.look * y;
}

/** signed distance of a plan point in front of the plane */
export function frameS(f: Pick<OrthoFrame, 'axis' | 'look' | 'at'>, x: number, y: number): number {
  return f.look * ((f.axis === 'y' ? y : x) - f.at);
}

/** plan point at (u, s) */
export function frameToWorld(f: Pick<OrthoFrame, 'axis' | 'look' | 'at'>, u: number, s = 0): { x: number; y: number } {
  return f.axis === 'y' ? { x: f.look * u, y: f.at + f.look * s } : { x: f.at + f.look * s, y: -f.look * u };
}

/** (u, s, z) ranges of a world AABB */
export function frameBox(f: Pick<OrthoFrame, 'axis' | 'look' | 'at'>, b: Aabb3): { u0: number; u1: number; s0: number; s1: number; z0: number; z1: number } {
  const ua = frameU(f, b.min.x, b.min.y);
  const ub = frameU(f, b.max.x, b.max.y);
  const sa = frameS(f, b.min.x, b.min.y);
  const sb = frameS(f, b.max.x, b.max.y);
  return { u0: Math.min(ua, ub), u1: Math.max(ua, ub), s0: Math.min(sa, sb), s1: Math.max(sa, sb), z0: b.min.z, z1: b.max.z };
}

/** plan rectangle covering the plane (inside the window) and the depth band */
export function frameQueryRect(f: OrthoFrame): Rect {
  const n0 = Math.min(f.at, f.at + f.look * Math.max(0, f.depthM)) - 1e-6;
  const n1 = Math.max(f.at, f.at + f.look * Math.max(0, f.depthM)) + 1e-6;
  let t0 = -1e7;
  let t1 = 1e7;
  if (f.window) {
    const p = frameToWorld(f, f.window.u0);
    const q = frameToWorld(f, f.window.u1);
    t0 = (f.axis === 'y' ? Math.min(p.x, q.x) : Math.min(p.y, q.y)) - 1e-6;
    t1 = (f.axis === 'y' ? Math.max(p.x, q.x) : Math.max(p.y, q.y)) + 1e-6;
  }
  return f.axis === 'y' ? { x: t0, y: n0, w: t1 - t0, d: n1 - n0 } : { x: n0, y: t0, w: n1 - n0, d: t1 - t0 };
}

export interface OrthoOptions {
  /** true: prims intersecting the plane → role 'cut' (section); false: everything in front is 'beyond' (elevation) */
  withCut: boolean;
  layers?: readonly LayerId[];
  /**
   * 'exact' (default): a partly hidden beyond prim is emitted as the polylines of its visible outline (line work, DXF later).
   * 'painter': every beyond prim that is not fully hidden is emitted as a closed rect, far → near, for opaque-fill renderers (SVG sheets).
   */
  outlines?: 'exact' | 'painter';
}

interface Entry {
  p: Prim;
  i: number;
  m: ReturnType<typeof frameBox>;
  depth: number;
  cut: boolean;
  circle?: [number, number, number];
}

export function projectOrtho(hp: HallPrims, f: OrthoFrame, o: OrthoOptions): { items: DrawItem2D[]; bounds: Rect } {
  const idx = hallIndex(hp);
  const allow = o.layers ? new Set(o.layers) : null;
  const depthM = Math.max(0, f.depthM);
  const entries: Entry[] = [];
  for (const i of idx.query(frameQueryRect(f))) {
    const p = hp.prims[i];
    if (FLOOR_MARK_LAYERS.has(p.layer) || (allow && !allow.has(p.layer))) continue;
    const m = frameBox(f, primAabb(p));
    if (f.window && (m.u1 < f.window.u0 - 1e-9 || m.u0 > f.window.u1 + 1e-9)) continue;
    let cut = false;
    let depth: number;
    if (o.withCut) {
      if (m.s0 <= 1e-9 && m.s1 >= -1e-9) {
        cut = true;
        depth = 0;
      } else if (m.s0 > 1e-9 && m.s0 <= depthM + 1e-9) depth = m.s0;
      else continue;
    } else {
      if (m.s1 <= 1e-9 || m.s0 > depthM + 1e-9) continue;
      depth = Math.max(0, m.s0);
    }
    const e: Entry = { p, i, m, depth, cut };
    if (p.shape === 'tube') {
      const dx = Math.abs(p.b.x - p.a.x);
      const dy = Math.abs(p.b.y - p.a.y);
      const dz = Math.abs(p.b.z - p.a.z);
      const endOn = f.axis === 'y' ? dx <= 1e-9 && dz <= 1e-9 : dy <= 1e-9 && dz <= 1e-9;
      if (endOn) e.circle = [frameU(f, p.a.x, p.a.y), p.a.z, p.halfW];
    }
    entries.push(e);
  }
  const occ: OccRect[] = entries.map((e) => ({ u0: e.m.u0, z0: e.m.z0, u1: e.m.u1, z1: e.m.z1, depth: e.cut ? -1 : e.depth }));
  const vis = visibleOutlines(occ);
  const items: DrawItem2D[] = [];
  const base = (e: Entry) => ({ layer: e.p.layer, lodMin: primLod(e.p), style: e.p.emitter, primId: e.p.id, ...(e.p.refId ? { refId: e.p.refId } : {}), depth: e.depth });
  const beyond = entries.map((e, k) => [e, k] as const).filter(([e]) => !e.cut).sort((a, b) => b[0].depth - a[0].depth || a[0].i - b[0].i);
  for (const [e, k] of beyond) {
    const v = vis[k];
    const w = e.m.u1 - e.m.u0;
    const h = e.m.z1 - e.m.z0;
    if (e.circle) {
      if (v.full || v.chains.length) items.push({ kind: 'circle', pts: [...e.circle], role: 'beyond', ...base(e) });
      continue;
    }
    const area = w > 1e-9 && h > 1e-9;
    if (v.full || (area && o.outlines === 'painter' && v.chains.length)) items.push({ kind: 'rect', pts: [e.m.u0, e.m.z0, w, h], role: 'beyond', ...base(e) });
    else for (const c of v.chains) items.push({ kind: 'polyline', pts: c, role: 'beyond', ...base(e) });
  }
  for (const e of entries) {
    if (!e.cut) continue;
    const w = e.m.u1 - e.m.u0;
    const h = e.m.z1 - e.m.z0;
    if (e.circle) items.push({ kind: 'circle', pts: [...e.circle], role: 'cut', ...base(e) });
    else if (h <= 1e-9 || w <= 1e-9) items.push({ kind: 'polyline', pts: [e.m.u0, e.m.z0, e.m.u1, e.m.z1], role: 'cut', ...base(e) });
    else items.push({ kind: 'rect', pts: [e.m.u0, e.m.z0, w, h], role: 'cut', ...base(e) });
  }
  let u0 = Infinity;
  let u1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const e of entries) {
    u0 = Math.min(u0, e.m.u0);
    u1 = Math.max(u1, e.m.u1);
    z0 = Math.min(z0, e.m.z0);
    z1 = Math.max(z1, e.m.z1);
  }
  if (f.window) {
    u0 = f.window.u0;
    u1 = f.window.u1;
  }
  const bounds: Rect = Number.isFinite(u0) && Number.isFinite(z0) ? { x: u0, y: z0, w: u1 - u0, d: z1 - z0 } : { x: f.window?.u0 ?? 0, y: 0, w: f.window ? f.window.u1 - f.window.u0 : 0, d: 0 };
  return { items, bounds };
}
