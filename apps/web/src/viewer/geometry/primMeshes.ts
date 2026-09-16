// r4 stream A1 (spec §2.1 G1–G11, §2.5 rule 4, T3 (d)): pure mesh builders of the 3D viewer that read the scene prims of
// `buildHallPrims` (packages/core/src/scene) — the one geometry source shared with the 2D view, the sheets and the wall audit.
//
// Every builder returns `MeshPart`s in three.js space (x, z up, −y). A body part carries the prim id it draws; the union of the vertex
// AABBs of a prim's body parts equals `primAabb(prim)` (±1 mm, checked by packages/core/test/consistency-2d3d.test.ts on the sweep).
// Decoration (hanger rods, door leaves, handles, glass, accent strips, floor decals, rack-state plates) is flagged `deco` and is not part
// of the parity check. React-free and store-free: the emitters (Hall / Containment / Trays / PowerPath / Penetrations .tsx) merge the
// parts per material and own the materials.
import * as THREE from 'three';
import { primAabb, type Aabb3, type Prim, type PowerPath, type PowerRackState, type PowerScenarioResult } from '@aidc/core';

export interface MeshPart {
  /** material / bucket key of the emitter */
  mat: string;
  g: THREE.BufferGeometry;
  /** prim drawn by this part (body parts only) */
  primId?: string;
  /** decoration: not part of the prim parity */
  deco?: boolean;
  /** vertex colour (power plane / sleeves) */
  color?: THREE.Color;
}

const EPS = 1e-6;

/** Non-indexed box between two plan-space corners (hall-local x, y, z up). */
export function boxBetween(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.max(Math.abs(x1 - x0), 1e-4), Math.max(Math.abs(z1 - z0), 1e-4), Math.max(Math.abs(y1 - y0), 1e-4));
  g.translate((x0 + x1) / 2, (z0 + z1) / 2, -(y0 + y1) / 2);
  const n = g.toNonIndexed();
  g.dispose();
  return n;
}

const aabbBox = (b: Aabb3) => boxBetween(b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);

/** Box in an along / across frame: `axis` = direction of `a`, `p` perpendicular in plan. */
function frameBox(axis: 'x' | 'y', a0: number, a1: number, p0: number, p1: number, z0: number, z1: number): THREE.BufferGeometry {
  return axis === 'x' ? boxBetween(a0, p0, z0, a1, p1, z1) : boxBetween(p0, a0, z0, p1, a1, z1);
}

/** Plan axis of an axis-parallel horizontal bar / tube (null for vertical or oblique). */
function barAxis(p: Prim): 'x' | 'y' | null {
  const dx = Math.abs(p.b.x - p.a.x);
  const dy = Math.abs(p.b.y - p.a.y);
  const dz = Math.abs(p.b.z - p.a.z);
  if (dz > EPS) return null;
  if (dx > EPS && dy <= EPS) return 'x';
  if (dy > EPS && dx <= EPS) return 'y';
  return null;
}

/** True when a bar / tube is neither axis-parallel nor vertical (drawn oriented; the parity test counts and skips these). */
export function isObliquePrim(p: Prim): boolean {
  if (p.shape !== 'bar' && p.shape !== 'tube') return false;
  const dx = Math.abs(p.b.x - p.a.x) > EPS;
  const dy = Math.abs(p.b.y - p.a.y) > EPS;
  const dz = Math.abs(p.b.z - p.a.z) > EPS;
  return Number(dx) + Number(dy) + Number(dz) > 1;
}

/** Oriented bar (rare oblique fallback): box of length |b − a|, width 2·halfW, height 2·halfH. */
function orientedBar(p: Prim): THREE.BufferGeometry {
  const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y, p.b.z - p.a.z);
  const g = new THREE.BoxGeometry(Math.max(len, 1e-4), Math.max(2 * p.halfH, 1e-4), Math.max(2 * p.halfW, 1e-4));
  const dir = new THREE.Vector3(p.b.x - p.a.x, p.b.z - p.a.z, -(p.b.y - p.a.y)).normalize();
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir));
  g.translate((p.a.x + p.b.x) / 2, (p.a.z + p.b.z) / 2, -(p.a.y + p.b.y) / 2);
  const n = g.toNonIndexed();
  g.dispose();
  return n;
}

const byEmitter = (prims: readonly Prim[], ...emitters: Prim['emitter'][]) => {
  const set = new Set(emitters);
  return prims.filter((p) => set.has(p.emitter));
};

// ───────────────────────────── trays, drops, busways, tap-off boxes, pipes ─────────────────────────────

/** tray rail section (m), matches core TRAY_RAIL_M */
const RAIL = 0.012;
/** deck plate thickness (m): the prim z range starts 0.006 below the model deck */
const DECK = 0.012;
const ROD = 0.012;
const ROD_STEP = 2.4;

/**
 * Ladder trays (deck + two side rails filling the prim box exactly), vertical tray drops and per-rack cable drops, plus hanger rods to
 * `rodTop` (decoration) when given. Materials: 'tray', 'rods'.
 */
export function trayParts(prims: readonly Prim[], o: { rodTop?: number } = {}): MeshPart[] {
  const out: MeshPart[] = [];
  for (const p of byEmitter(prims, 'tray', 'drop')) {
    if (p.emitter === 'drop') {
      out.push({ mat: 'tray', g: aabbBox(primAabb(p)), primId: p.id });
      continue;
    }
    const axis = barAxis(p);
    if (!axis) {
      out.push({ mat: 'tray', g: orientedBar(p), primId: p.id });
      continue;
    }
    const a0 = axis === 'x' ? Math.min(p.a.x, p.b.x) : Math.min(p.a.y, p.b.y);
    const a1 = axis === 'x' ? Math.max(p.a.x, p.b.x) : Math.max(p.a.y, p.b.y);
    const c = axis === 'x' ? p.a.y : p.a.x;
    const hw = p.halfW;
    const z0 = p.a.z - p.halfH;
    const z1 = p.a.z + p.halfH;
    out.push({ mat: 'tray', g: frameBox(axis, a0, a1, c - hw + RAIL / 2, c + hw - RAIL / 2, z0, z0 + DECK), primId: p.id });
    out.push({ mat: 'tray', g: frameBox(axis, a0, a1, c - hw, c - hw + RAIL, z0 + DECK / 2, z1), primId: p.id });
    out.push({ mat: 'tray', g: frameBox(axis, a0, a1, c + hw - RAIL, c + hw, z0 + DECK / 2, z1), primId: p.id });
    if (o.rodTop !== undefined && o.rodTop > z1 + 0.05) {
      for (let a = a0 + 0.3; a < a1; a += ROD_STEP) {
        for (const side of [-1, 1]) {
          const pc = c + side * (hw + 0.014);
          out.push({ mat: 'rods', g: frameBox(axis, a - ROD / 2, a + ROD / 2, pc - ROD / 2, pc + ROD / 2, z1, o.rodTop), deco: true });
        }
      }
    }
  }
  return out;
}

/** Busway bars (2·halfW × 2·halfH, G3) and tap-off boxes on both sides (G6). Materials: 'busway', 'tapoff'. */
export function buswayParts(prims: readonly Prim[]): MeshPart[] {
  const out: MeshPart[] = [];
  for (const p of byEmitter(prims, 'busway', 'tapoff')) {
    if (p.emitter === 'tapoff' && p.shape !== 'box') continue; // tap-off drop bars belong to the power plane
    out.push({ mat: p.emitter, g: p.emitter === 'busway' && isObliquePrim(p) ? orientedBar(p) : aabbBox(primAabb(p)), primId: p.id });
  }
  return out;
}

/** radial segments of pipe tubes: a multiple of 4 puts vertices on both cross-section axes (vertex AABB = ±r) */
export const PIPE_RADIAL_SEGMENTS = 16;

/** TCS pipes (open tubes, radius halfW) and fittings (valve bodies). Materials: 'supply', 'return', 'fitting'. */
export function pipeParts(prims: readonly Prim[]): MeshPart[] {
  const out: MeshPart[] = [];
  for (const p of byEmitter(prims, 'pipe', 'fitting')) {
    if (p.emitter === 'fitting') {
      out.push({ mat: 'fitting', g: aabbBox(primAabb(p)), primId: p.id });
      continue;
    }
    const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y, p.b.z - p.a.z);
    if (len < EPS) continue;
    const g = new THREE.CylinderGeometry(p.halfW, p.halfW, len, PIPE_RADIAL_SEGMENTS, 1, true);
    const axis = barAxis(p);
    if (axis === 'x') g.rotateZ(Math.PI / 2);
    else if (axis === 'y') g.rotateX(Math.PI / 2);
    else {
      const dir = new THREE.Vector3(p.b.x - p.a.x, p.b.z - p.a.z, -(p.b.y - p.a.y)).normalize();
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
    }
    g.translate((p.a.x + p.b.x) / 2, (p.a.z + p.b.z) / 2, -(p.a.y + p.b.y) / 2);
    out.push({ mat: p.system === 'cdu-return' ? 'return' : 'supply', g: g.toNonIndexed(), primId: p.id });
    g.dispose();
  }
  return out;
}

// ───────────────────────────── power plane ─────────────────────────────

/** A / B path colours (dataviz series 1 and 3 — kept apart from the amber warning and red overload states). */
export const POWER_SIDE_COLORS = { A: '#3987e5', B: '#199e70' } as const;
export const POWER_STATE_COLORS: Record<'warn' | 'over' | 'failed' | Exclude<PowerRackState, 'normal'>, string> = {
  warn: '#fab219',
  over: '#d03b3b',
  failed: '#50565d',
  'single-path': '#aab4be',
  'on-bypass': '#9085e9',
  capped: '#fab219',
  dropped: '#d03b3b',
};

export interface PowerPlaneOptions {
  /** power paths of the analysis (loading, circuit / feeder / tap-off links); prims carry the path id in `refId` */
  paths: readonly PowerPath[];
  scenario?: PowerScenarioResult | null;
  highlightIds?: readonly string[];
}

/**
 * Busway circuits (loading heat, overloaded bucket), feeders, tap-off drop bars and electrical rooms from the power-plane prims, plus
 * highlight glow and scenario rack plates / veils (decoration, placed on the rack prims so elevation is honoured).
 * Buckets: 'runs', 'over', 'feeders', 'taps', 'rooms-A', 'rooms-B', 'glow', 'plates', 'veil'.
 */
export function powerPlaneParts(prims: readonly Prim[], o: PowerPlaneOptions): MeshPart[] {
  const SIDE = { A: new THREE.Color(POWER_SIDE_COLORS.A), B: new THREE.Color(POWER_SIDE_COLORS.B) };
  const WARN = new THREE.Color(POWER_STATE_COLORS.warn);
  const CRIT = new THREE.Color(POWER_STATE_COLORS.over);
  const FAILED = new THREE.Color(POWER_STATE_COLORS.failed);
  const WHITE = new THREE.Color('#ffffff');
  const BLACK = new THREE.Color('#05070a');
  const pathById = new Map(o.paths.map((p) => [p.id, p]));
  const byScenario = new Map((o.scenario?.paths ?? []).map((p) => [p.id, p]));
  const failed = new Set(o.scenario?.failedIds ?? []);
  const warnFrac = o.scenario?.summary ? o.scenario.summary.warnAt / o.scenario.summary.limitFactor : 0.9;
  const rackState = new Map((o.scenario?.racks ?? []).map((r) => [r.id, r]));
  const hl = new Set(o.highlightIds ?? []);
  const circuitFailed = new Map<string, boolean>();
  for (const p of o.paths) if (p.kind === 'busway') circuitFailed.set(p.id, failed.has(p.id) || (!!p.buswayId && failed.has(p.buswayId)));
  const out: MeshPart[] = [];
  const body = (p: Prim) => (isObliquePrim(p) ? orientedBar(p) : aabbBox(primAabb(p)));
  for (const p of prims) {
    const path = p.refId ? pathById.get(p.refId) : undefined;
    if (p.emitter === 'circuit') {
      const s = path ? byScenario.get(path.id) : undefined;
      const isFailed = path ? circuitFailed.get(path.id) ?? false : false;
      const loading = s ? s.loadingPct / 100 : path?.loading ?? 0;
      const side = (path?.side ?? p.meta?.side ?? 'A') as 'A' | 'B';
      const overloaded = !isFailed && loading > 1 + 1e-9;
      const color = isFailed ? FAILED : overloaded ? CRIT : loading > warnFrac + 1e-9 ? WARN : SIDE[side].clone().multiplyScalar(0.35 + 0.65 * Math.min(1, loading / warnFrac));
      out.push({ mat: overloaded ? 'over' : 'runs', g: body(p), primId: p.id, color });
      if (path && (hl.has(path.id) || (path.buswayId && hl.has(path.buswayId)) || (path.rowId && hl.has(path.rowId)))) {
        const b = primAabb(p);
        const gx = b.max.x - b.min.x > b.max.y - b.min.y ? 0 : 0.045;
        const gy = gx ? 0 : 0.045;
        out.push({ mat: 'glow', g: boxBetween(b.min.x - gx, b.min.y - gy, b.min.z - 0.04, b.max.x + gx, b.max.y + gy, b.max.z + 0.04), deco: true, color: WHITE });
      }
    } else if (p.emitter === 'feeder') {
      const dead = path ? circuitFailed.get(path.toId) : false;
      const side = (path?.side ?? p.meta?.side ?? 'A') as 'A' | 'B';
      out.push({ mat: 'feeders', g: body(p), primId: p.id, color: dead ? FAILED : SIDE[side].clone().multiplyScalar(0.8) });
    } else if (p.emitter === 'tapoff' && p.shape === 'bar') {
      const dead = (path && circuitFailed.get(path.fromId)) || (path && rackState.get(path.toId)?.state === 'dropped');
      const side = (path?.side ?? p.meta?.side ?? 'A') as 'A' | 'B';
      out.push({ mat: 'taps', g: body(p), primId: p.id, color: dead ? FAILED : SIDE[side] });
    } else if (p.emitter === 'room' && p.layer === 'electrical-rooms') {
      out.push({ mat: p.meta?.side === 'B' ? 'rooms-B' : 'rooms-A', g: aabbBox(primAabb(p)), primId: p.id });
    }
  }
  if (rackState.size) {
    const rackPrim = new Map<string, Prim>();
    for (const p of prims) if ((p.emitter === 'rack' || p.emitter === 'unit') && p.refId) rackPrim.set(p.refId, p);
    for (const r of rackState.values()) {
      if (r.state === 'normal') continue;
      const rp = rackPrim.get(r.id);
      if (!rp) continue;
      const b = primAabb(rp);
      const cx = (b.min.x + b.max.x) / 2;
      const cy = (b.min.y + b.max.y) / 2;
      const w = b.max.x - b.min.x;
      const d = b.max.y - b.min.y;
      if (r.state === 'dropped') out.push({ mat: 'veil', g: boxBetween(b.min.x - 0.02, b.min.y - 0.02, b.min.z - 0.01, b.max.x + 0.02, b.max.y + 0.02, b.max.z + 0.01), deco: true, color: BLACK });
      out.push({ mat: 'plates', g: boxBetween(cx - w * 0.45, cy - d * 0.45, b.max.z + 0.015, cx + w * 0.45, cy + d * 0.45, b.max.z + 0.065), deco: true, color: new THREE.Color(POWER_STATE_COLORS[r.state]) });
    }
  }
  return out;
}

const SLEEVE_COLORS: Record<string, string> = { 'feeder-sleeve': '#22d3ee', 'trunk-sleeve': '#c084fc', 'partition-sleeve': '#5eead4' };

/** Declared wall / partition / chimney sleeves (the `sleeve` prims whose penetration id is in `ids`). Bucket 'sleeves'. */
export function sleeveParts(prims: readonly Prim[], ids?: ReadonlySet<string>): MeshPart[] {
  const out: MeshPart[] = [];
  for (const p of byEmitter(prims, 'sleeve')) {
    if (ids && !(p.refId && ids.has(p.refId))) continue;
    out.push({ mat: 'sleeves', g: aabbBox(primAabb(p)), primId: p.id, color: new THREE.Color(SLEEVE_COLORS[String(p.meta?.kind)] ?? SLEEVE_COLORS['feeder-sleeve']) });
  }
  return out;
}

// ───────────────────────────── containment ─────────────────────────────

const FT = 0.05; // frame section (m)
const MODULE = 1.2;

/** along / across extents of a containment prim box on its aisle axis */
function aisleFrame(p: Prim, b: Aabb3) {
  const axis: 'x' | 'y' = p.meta?.axis === 'y' ? 'y' : 'x';
  return axis === 'x'
    ? { axis, a0: b.min.x, a1: b.max.x, p0: b.min.y, p1: b.max.y }
    : { axis, a0: b.min.y, a1: b.max.y, p0: b.min.x, p1: b.max.x };
}

/**
 * Containment from its prims (G8): blanking panels, ducted chimney walls with rails and posts, transoms over the doors, glass roof with
 * a perimeter frame, end doors (frame + head = the door prim; leaves, stiles, handles and the accent strip are decoration; sliding or
 * swing-double per `meta.doorType`). Materials: 'frame', 'glassHot', 'glassCold', 'frosted', 'blank', 'accentHot', 'accentCold'.
 */
export function containmentParts(prims: readonly Prim[]): MeshPart[] {
  const out: MeshPart[] = [];
  for (const p of prims) {
    const isDoor = p.emitter === 'door' && p.layer === 'containment-doors';
    if (p.emitter !== 'containment-panel' && p.emitter !== 'containment-roof' && !isDoor) continue;
    const b = primAabb(p);
    const hot = p.meta?.kind !== 'cold-aisle';
    const glass = hot ? 'glassHot' : 'glassCold';
    const accent = hot ? 'accentHot' : 'accentCold';
    const f = aisleFrame(p, b);
    const z0 = b.min.z;
    const z1 = b.max.z;
    const body = (mat: string, g: THREE.BufferGeometry) => out.push({ mat, g, primId: p.id });
    const deco = (mat: string, g: THREE.BufferGeometry) => out.push({ mat, g, deco: true });
    if (p.emitter === 'containment-panel') {
      body('blank', aabbBox(b));
      continue;
    }
    if (p.emitter === 'containment-roof') {
      const part = p.meta?.part;
      if (part === 'chimney') {
        // wall along the aisle: thin across p, rails at the bottom and top, frosted pane, posts every module (inset at the ends)
        const pc = (f.p0 + f.p1) / 2;
        body('frame', frameBox(f.axis, f.a0, f.a1, f.p0, f.p1, z0, Math.min(z1, z0 + 0.06)));
        body('frame', frameBox(f.axis, f.a0, f.a1, f.p0, f.p1, Math.max(z0, z1 - 0.06), z1));
        if (z1 - z0 > 0.12) {
          body('frosted', frameBox(f.axis, f.a0, f.a1, pc - 0.006, pc + 0.006, z0 + 0.06, z1 - 0.06));
          for (let m = f.a0; m <= f.a1 + 1e-6; m += MODULE) {
            const mc = Math.min(Math.max(m, f.a0 + 0.02), f.a1 - 0.02);
            body('frame', frameBox(f.axis, mc - 0.02, mc + 0.02, pc - 0.02, pc + 0.02, z0 + 0.06, z1 - 0.06));
          }
        }
      } else if (part === 'transom') {
        // pane across the aisle over a door: thin along a (the prim box is on the other axis than meta.axis)
        const ta: 'x' | 'y' = f.axis === 'x' ? 'y' : 'x';
        const g = ta === 'x' ? { a0: b.min.x, a1: b.max.x, p0: b.min.y, p1: b.max.y } : { a0: b.min.y, a1: b.max.y, p0: b.min.x, p1: b.max.x };
        const pc = (g.p0 + g.p1) / 2;
        body('frame', frameBox(ta, g.a0, g.a1, g.p0, g.p1, z0, Math.min(z1, z0 + 0.06)));
        body('frame', frameBox(ta, g.a0, g.a1, g.p0, g.p1, Math.max(z0, z1 - 0.06), z1));
        if (z1 - z0 > 0.12) body('frosted', frameBox(ta, g.a0, g.a1, pc - 0.006, pc + 0.006, z0 + 0.06, z1 - 0.06));
      } else {
        // glass roof: perimeter frame fills the prim box, module bars and glass inside
        body('frame', frameBox(f.axis, f.a0, f.a1, f.p0, f.p0 + 0.04, z0, z1));
        body('frame', frameBox(f.axis, f.a0, f.a1, f.p1 - 0.04, f.p1, z0, z1));
        body('frame', frameBox(f.axis, f.a0, f.a0 + 0.04, f.p0, f.p1, z0, z1));
        body('frame', frameBox(f.axis, f.a1 - 0.04, f.a1, f.p0, f.p1, z0, z1));
        body(glass, frameBox(f.axis, f.a0 + 0.04, f.a1 - 0.04, f.p0 + 0.04, f.p1 - 0.04, z0 + 0.012, z0 + 0.022));
        for (let m = f.a0 + MODULE; m < f.a1 - 0.05; m += MODULE) body('frame', frameBox(f.axis, m - 0.02, m + 0.02, f.p0, f.p1, z0 + 0.005, z1 - 0.005));
      }
      continue;
    }
    // end door: the prim is thin along the aisle axis (meta.axis) at the aisle end
    const ae = (f.a0 + f.a1) / 2;
    const inward = p.meta?.end === 1 ? -1 : 1;
    const d = f.p1 - f.p0;
    const h = z1 - z0;
    body('frame', frameBox(f.axis, f.a0, f.a1, f.p0, f.p0 + FT, z0, z1));
    body('frame', frameBox(f.axis, f.a0, f.a1, f.p1 - FT, f.p1, z0, z1));
    body('frame', frameBox(f.axis, f.a0, f.a1, f.p0, f.p1, z1 - 0.08, z1));
    const at = (off: number, half: number) => [ae + inward * off - half, ae + inward * off + half] as const;
    deco(accent, frameBox(f.axis, ...at(-0.028, 0.003), f.p0 + d * 0.02, f.p1 - d * 0.02, z1 - 0.05, z1 - 0.03));
    const leafTop = h - 0.1;
    if (p.meta?.doorType === 'swing-double') {
      // two leaves closed in the door plane, meeting in the middle; vertical pull handles next to the meeting stile
      const mid = (f.p0 + f.p1) / 2;
      deco(glass, frameBox(f.axis, ...at(0.004, 0.006), f.p0 + FT + 0.01, mid - 0.005, z0 + 0.02, z0 + leafTop));
      deco(glass, frameBox(f.axis, ...at(0.004, 0.006), mid + 0.005, f.p1 - FT - 0.01, z0 + 0.02, z0 + leafTop));
      for (const s of [f.p0 + FT, mid - 0.03, mid + 0.005, f.p1 - FT - 0.025]) deco('frame', frameBox(f.axis, ...at(0.004, 0.015), s, s + 0.025, z0 + 0.02, z0 + leafTop));
      deco('frame', frameBox(f.axis, ...at(0.035, 0.01), mid - 0.09, mid - 0.07, z0 + h * 0.4, z0 + h * 0.4 + 0.35));
      deco('frame', frameBox(f.axis, ...at(0.035, 0.01), mid + 0.07, mid + 0.09, z0 + h * 0.4, z0 + h * 0.4 + 0.35));
    } else {
      // two sliding leaves, slightly offset along the aisle so they overlap like a bi-parting door
      const leaf = d / 2 + 0.03;
      deco(glass, frameBox(f.axis, ...at(0.02, 0.006), f.p0 + 0.02, f.p0 + 0.02 + leaf - 0.04, z0 + 0.02, z0 + leafTop));
      deco(glass, frameBox(f.axis, ...at(0.05, 0.006), f.p1 - 0.02 - (leaf - 0.04), f.p1 - 0.02, z0 + 0.02, z0 + leafTop));
      for (const s of [f.p0 + 0.04, f.p0 + leaf, f.p1 - leaf, f.p1 - 0.04]) deco('frame', frameBox(f.axis, ...at(0.035, 0.015), s - 0.0125, s + 0.0125, z0 + 0.02, z0 + leafTop));
      deco('frame', frameBox(f.axis, ...at(0.035, 0.015), f.p0 + 0.01, f.p1 - 0.01, z0 + 0.01, z0 + 0.05));
      deco('frame', frameBox(f.axis, ...at(0.075, 0.01), f.p0 + leaf - 0.13, f.p0 + leaf - 0.11, z0 + h * 0.48 - 0.175, z0 + h * 0.48 + 0.175));
      deco('frame', frameBox(f.axis, ...at(0.075, 0.01), f.p1 - leaf + 0.11, f.p1 - leaf + 0.13, z0 + h * 0.48 - 0.175, z0 + h * 0.48 + 0.175));
    }
  }
  return out;
}

// ───────────────────────────── hall shell ─────────────────────────────

/** Texture-space UVs in metres / `tile` for a merged wall geometry (keeps the texture continuous across split spans). */
export function worldUv(g: THREE.BufferGeometry, tile = 4): void {
  const pos = g.attributes.position;
  const nor = g.attributes.normal;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    // faces facing ±x use (z, y), ±z use (x, y), ±y (top / bottom) use (x, z)
    if (ny > 0.5) {
      uv[i * 2] = x / tile;
      uv[i * 2 + 1] = z / tile;
    } else if (nx > 0.5) {
      uv[i * 2] = -z / tile;
      uv[i * 2 + 1] = y / tile;
    } else {
      uv[i * 2] = x / tile;
      uv[i * 2 + 1] = y / tile;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

export interface LightStrip {
  primId: string;
  axis: 'x' | 'y';
  /** centre (hall-local plan x, y, z) */
  x: number;
  y: number;
  z: number;
  len: number;
}

/** fixture strip unit box (length 1 along the strip, 0.05 m high, 0.08 m wide): the prim's 2·halfH × 2·halfW */
export const LIGHT_UNIT = { h: 0.05, w: 0.08 } as const;

/** Instances of the fixture strips (`light` prims, V1 / V2 rules in core scene/shell.ts). */
export function lightStrips(prims: readonly Prim[]): LightStrip[] {
  const out: LightStrip[] = [];
  for (const p of byEmitter(prims, 'light')) {
    const axis = barAxis(p) ?? 'x';
    const len = Math.max(0.05, axis === 'x' ? Math.abs(p.b.x - p.a.x) : Math.abs(p.b.y - p.a.y));
    out.push({ primId: p.id, axis, x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2, z: p.a.z, len });
  }
  return out;
}

/** Instance matrix of a strip (three space) for a unit box geometry of LIGHT_UNIT size along x. */
export function lightMatrix(s: LightStrip, m = new THREE.Matrix4()): THREE.Matrix4 {
  const q = s.axis === 'x' ? new THREE.Quaternion() : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  return m.compose(new THREE.Vector3(s.x, s.z, -s.y), q, new THREE.Vector3(s.len, 1, 1));
}

/** Unit geometry of the fixture strips (instanced). */
export function lightUnitGeometry(): THREE.BufferGeometry {
  return new THREE.BoxGeometry(1, LIGHT_UNIT.h, LIGHT_UNIT.w);
}

export interface ReserveOutline {
  primId: string;
  /** flat [x0, y0, x1, y1, …] segment pairs at floor level (plan) */
  segs: number[];
}

/** Dashed reserve-position outlines (one per position, 0.05 m inset) from the `reserves` floor-mark prims (decoration). */
export function reserveOutlines(prims: readonly Prim[]): ReserveOutline[] {
  const out: ReserveOutline[] = [];
  for (const p of prims) {
    if (p.emitter !== 'room' || p.layer !== 'reserves') continue;
    const b = primAabb(p);
    const x = b.min.x;
    const y = b.min.y;
    const w = b.max.x - x;
    const d = b.max.y - y;
    const n = Math.max(1, Number(p.meta?.positions ?? 1));
    const along = p.meta?.axis === 'y' ? 'y' : 'x';
    const step = (along === 'x' ? w : d) / n;
    const segs: number[] = [];
    for (let i = 0; i < n; i++) {
      const px0 = along === 'x' ? x + i * step + 0.05 : x + 0.05;
      const py0 = along === 'x' ? y + 0.05 : y + i * step + 0.05;
      const px1 = along === 'x' ? px0 + step - 0.1 : x + w - 0.05;
      const py1 = along === 'x' ? y + d - 0.05 : py0 + step - 0.1;
      segs.push(px0, py0, px1, py0, px1, py0, px1, py1, px1, py1, px0, py1, px0, py1, px0, py0);
    }
    out.push({ primId: p.id, segs });
  }
  return out;
}

/**
 * Hall shell from the prims (G9 / G10): walls split around room doors with headers ('wall-N/S/E/W', world UVs), curbs (decoration),
 * columns / shafts, partitions to the clear height, room doors (jambs + head = the door prim; leaves and the swing decal are
 * decoration), ceiling and deck planes ('ceiling', 'deck', only drawn when the ceiling overlay is on), the floor ('floor', hall outline
 * plane) and egress / ramp decals ('egress', decoration).
 */
export function shellParts(prims: readonly Prim[]): MeshPart[] {
  const out: MeshPart[] = [];
  for (const p of prims) {
    const b = primAabb(p);
    if (p.emitter === 'wall') {
      const side = String(p.meta?.wall ?? p.tag ?? 'S');
      out.push({ mat: `wall-${side}`, g: aabbBox(b), primId: p.id });
      if (b.min.z < 1e-6) {
        // curb along the room face of the wall
        const inX = side === 'W' || side === 'E';
        const face = side === 'S' ? b.max.y : side === 'N' ? b.min.y : side === 'W' ? b.max.x : b.min.x;
        const dir = side === 'S' || side === 'W' ? -1 : 1;
        const g = inX ? boxBetween(face + dir * 0.3, b.min.y, 0, face, b.max.y, 0.12) : boxBetween(b.min.x, face + dir * 0.3, 0, b.max.x, face, 0.12);
        out.push({ mat: 'curb', g, deco: true });
      }
    } else if (p.emitter === 'column') {
      out.push({ mat: 'column', g: aabbBox(b), primId: p.id });
    } else if (p.emitter === 'partition') {
      out.push({ mat: 'partition', g: aabbBox(b), primId: p.id });
    } else if (p.emitter === 'door' && p.layer === 'doors') {
      const side = String(p.meta?.wall ?? 'S');
      const alongY = side === 'W' || side === 'E';
      const s0 = alongY ? b.min.y : b.min.x;
      const s1 = alongY ? b.max.y : b.max.x;
      const t0 = alongY ? b.min.x : b.min.y;
      const t1 = alongY ? b.max.x : b.max.y;
      const ax: 'x' | 'y' = alongY ? 'y' : 'x';
      const zh = b.max.z;
      out.push({ mat: 'doorFrame', g: frameBox(ax, s0, s0 + 0.06, t0, t1, 0, zh), primId: p.id });
      out.push({ mat: 'doorFrame', g: frameBox(ax, s1 - 0.06, s1, t0, t1, 0, zh), primId: p.id });
      out.push({ mat: 'doorFrame', g: frameBox(ax, s0, s1, t0, t1, zh - 0.08, zh), primId: p.id });
      const leaves = Number(p.meta?.leaves ?? 1) === 2 ? 2 : 1;
      const tc = (t0 + t1) / 2;
      const inner = [s0 + 0.06, s1 - 0.06] as const;
      const lw = (inner[1] - inner[0]) / leaves;
      for (let i = 0; i < leaves; i++) out.push({ mat: 'doorLeaf', g: frameBox(ax, inner[0] + i * lw + 0.004, inner[0] + (i + 1) * lw - 0.004, tc - 0.022, tc + 0.022, 0.01, zh - 0.08), deco: true });
      // swing / approach decal on the room floor in front of the opening (clamped to the hall)
      const inward = side === 'S' || side === 'W' ? 1 : -1;
      const face = inward > 0 ? t1 : t0;
      out.push({ mat: 'doorDecal', g: frameBox(ax, s0, s1, Math.min(face, face + inward * 1.2), Math.max(face, face + inward * 1.2), 0.003, 0.005), deco: true });
    } else if (p.emitter === 'ceiling') {
      out.push({ mat: p.meta?.kind === 'deck' ? 'deck' : 'ceiling', g: aabbBox(b), primId: p.id });
    } else if (p.emitter === 'room' && p.layer === 'hall-outline') {
      out.push({ mat: 'floor', g: aabbBox(b), primId: p.id });
    } else if (p.emitter === 'room' && p.layer === 'egress') {
      out.push({ mat: 'egress', g: boxBetween(b.min.x, b.min.y, 0.003, b.max.x, b.max.y, 0.005), deco: true });
    }
  }
  return out;
}

// ───────────────────────────── merging / parity helpers ─────────────────────────────

/** Merge non-indexed parts (position, normal, optional uv / per-part colour) into one geometry. */
export function mergeParts(parts: readonly MeshPart[], o: { colors?: boolean; uv?: boolean } = {}): THREE.BufferGeometry | null {
  if (!parts.length) return null;
  let n = 0;
  for (const p of parts) n += p.g.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = o.colors ? new Float32Array(n * 3) : null;
  const uv = o.uv && parts.every((p) => p.g.attributes.uv) ? new Float32Array(n * 2) : null;
  let k = 0;
  for (const part of parts) {
    const g = part.g.index ? part.g.toNonIndexed() : part.g;
    const cnt = g.attributes.position.count;
    pos.set(g.attributes.position.array as Float32Array, k * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array as Float32Array, k * 3);
    if (uv) uv.set(g.attributes.uv.array as Float32Array, k * 2);
    if (col) {
      const c = part.color ?? new THREE.Color('#ffffff');
      for (let i = 0; i < cnt; i++) {
        col[(k + i) * 3] = c.r;
        col[(k + i) * 3 + 1] = c.g;
        col[(k + i) * 3 + 2] = c.b;
      }
    }
    k += cnt;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

/** Group parts by material key. */
export function partsByMat(parts: readonly MeshPart[]): Map<string, MeshPart[]> {
  const m = new Map<string, MeshPart[]>();
  for (const p of parts) {
    const list = m.get(p.mat);
    if (list) list.push(p);
    else m.set(p.mat, [p]);
  }
  return m;
}

export function disposeParts(parts: readonly MeshPart[]): void {
  for (const p of parts) p.g.dispose();
}

/** Vertex AABB (hall-local plan space) of a set of geometries. */
export function vertexAabb(geoms: readonly THREE.BufferGeometry[], matrix?: THREE.Matrix4): Aabb3 | null {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  const v = new THREE.Vector3();
  for (const g of geoms) {
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (matrix) v.applyMatrix4(matrix);
      // three (x, z up, −y) → plan (x, y, z)
      const px = v.x;
      const py = -v.z;
      const pz = v.y;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
      if (pz < z0) z0 = pz;
      if (pz > z1) z1 = pz;
    }
  }
  return Number.isFinite(x0) ? { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } } : null;
}

/** Vertex AABB per prim id of the body parts. */
export function bodyAabbs(parts: readonly MeshPart[]): Map<string, Aabb3> {
  const groups = new Map<string, THREE.BufferGeometry[]>();
  for (const p of parts) {
    if (p.deco || !p.primId) continue;
    const list = groups.get(p.primId);
    if (list) list.push(p.g);
    else groups.set(p.primId, [p.g]);
  }
  const out = new Map<string, Aabb3>();
  for (const [id, gs] of groups) {
    const b = vertexAabb(gs);
    if (b) out.set(id, b);
  }
  return out;
}
