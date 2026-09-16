// Pure 3D geometry shared by the viewer, the wall audit and (later) USD / Godot / drawings (finish v2 2차, DECISIONS-v2-2 §D1, D-defaults).
// Hall-local plan coordinates: x east, y north, z up (m); the hall interior is [0, W] × [0, D], wall slabs sit outside it.
//
//  - partitionWalls: separate-room partitions built to the clear height and closed against the hall walls (D4). The stored reservation
//    rect only spans the pod area; the wall is extended along its long axis to both hall walls and cut around equipment standing in its line.
//  - cableRunPaths: the cable-bundle polylines the 3D viewer draws (Trays.tsx CableRuns), axis-aware (rows along X or Y, F8), with the
//    4 000-bundle budget applied per hall, row-less endpoints (CRAH / CDU) routed through the main tray, inter-hall trunks routed to the
//    declared trunk sleeve, and a count of every bundle that is not drawn by reason (audit coverage).
import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect } from '../model/geometry.ts';
import type { CableRun, CableTray, Containment, EquipmentInstance, Hall, LayoutReservation, Rect, RowGroup, Vec3, WallPenetration } from '../model/types.ts';
import { blockingKeepouts, rowGroupsFromEquipment } from './rows.ts';

// ───────────────────────────── partitions ─────────────────────────────

export interface PartitionWall {
  id: string;
  reservationId: string;
  hallId: string;
  /** axis the partition runs along */
  axis: 'x' | 'y';
  /** perpendicular extent of the wall (thickness) */
  c0: number;
  c1: number;
  /** solid spans along `axis` after cutting around equipment standing in the wall line */
  spans: [number, number][];
  height: number;
}

/** Separate-room partitions of a hall, extended to the hall walls and cut around equipment footprints (finish v2 2차, D4). */
export function partitionWalls(hall: Hall, reservations: readonly LayoutReservation[] | undefined, equipment: readonly EquipmentInstance[] = []): PartitionWall[] {
  const out: PartitionWall[] = [];
  for (const r of reservations ?? []) {
    if (r.hallId !== hall.id || r.kind !== 'room-partition') continue;
    const axis: 'x' | 'y' = r.rect.w >= r.rect.d ? 'x' : 'y';
    const c0 = axis === 'x' ? r.rect.y : r.rect.x;
    const c1 = axis === 'x' ? r.rect.y + r.rect.d : r.rect.x + r.rect.w;
    const L = axis === 'x' ? hall.width : hall.depth;
    const cuts: [number, number][] = [];
    for (const e of equipment) {
      if (e.hallId !== hall.id) continue;
      const item = findCatalogItem(e.catalogId);
      if (!item) continue;
      const f = footprintRect(item.dims, e.position, e.rotationDeg);
      const p0 = axis === 'x' ? f.y : f.x;
      const p1 = axis === 'x' ? f.y + f.d : f.x + f.w;
      if (p1 <= c0 + 1e-6 || p0 >= c1 - 1e-6) continue;
      cuts.push(axis === 'x' ? [f.x, f.x + f.w] : [f.y, f.y + f.d]);
    }
    cuts.sort((a, b) => a[0] - b[0]);
    const spans: [number, number][] = [];
    let cur = 0;
    for (const [a0, a1] of cuts) {
      if (a0 > cur + 1e-6) spans.push([cur, Math.min(a0, L)]);
      cur = Math.max(cur, a1);
    }
    if (cur < L - 1e-6) spans.push([cur, L]);
    out.push({ id: `partition-${r.id}`, reservationId: r.id, hallId: hall.id, axis, c0, c1, spans: spans.filter(([a, b]) => b - a > 1e-3), height: hall.clearHeight });
  }
  return out;
}

// ───────────────────────────── cable runs ─────────────────────────────

export const CABLE_BUNDLE_BUDGET_PER_HALL = 4000;

export interface CablePath {
  runId: string;
  fabric: string;
  count: number;
  radius: number;
  points: Vec3[];
  tier?: CableRun['tier'];
}

export type CableSkipReason = 'other-hall' | 'inter-hall-no-sleeve' | 'mixed-axis' | 'no-row' | 'missing' | 'budget';

export interface CableRunGeometry {
  paths: CablePath[];
  skipped: Partial<Record<CableSkipReason, number>>;
  /** bundles considered for this hall (after aggregation) */
  bundles: number;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function fabricLevel(fabric: string): number {
  const f = fabric.toLowerCase();
  if (f.includes('front')) return 1;
  if (f.includes('stor')) return 2;
  if (f.includes('oob') || f.includes('mgmt')) return 3;
  return 0;
}

export interface CableRunPathOptions {
  /** every equipment instance of the project (to tell inter-hall runs from missing endpoints) */
  allEquipment?: readonly EquipmentInstance[];
  /** trunk sleeves of this hall (analysis.network.penetrations, kind 'trunk-sleeve') */
  trunkSleeves?: readonly WallPenetration[];
  budget?: number;
  /** containments of the project: column detours never step into a ducted chimney (optional) */
  containments?: readonly Containment[];
}

/** keepout growth the wall audit uses for columns / shafts (m) */
const COLUMN_GROW_M = 0.05;
/** clearance between a bundle and a grown column on a detour (m, estimate; staggered per bundle by up to +0.045 m) */
const DODGE_MARGIN_M = 0.03;

/** Plan rectangles a column detour must not enter: ducted containments (their chimneys reach the ceiling), grown by the panel offset. */
function containmentRects(hall: Hall, containments: readonly Containment[] | undefined): Rect[] {
  return (containments ?? []).filter((c) => c.hallId === hall.id && c.ductedToPlenum).map((c) => ({ x: c.rect.x - 0.06, y: c.rect.y - 0.06, w: c.rect.w + 0.12, d: c.rect.d + 0.12 }));
}

const capsuleHitsRect = (x0: number, y0: number, x1: number, y1: number, r: number, b: Rect, eps = 0.004) =>
  Math.min(x1 + r, b.x + b.w) - Math.max(x0 - r, b.x) > eps && Math.min(y1 + r, b.y + b.d) - Math.max(y0 - r, b.y) > eps;

/**
 * r4 A1 (W8 open issue: bundles past interior columns). Every horizontal, axis-parallel segment whose capsule (radius r) passes through a
 * grown column / shaft is replaced by a rectangular detour on the nearer side that stays inside the hall and clear of `avoid`; clusters
 * of nearby blockers share one detour. Rises, oblique segments and segments starting inside a blocker are kept as they are.
 */
export function dodgeBlockers(points: readonly Vec3[], blockers: readonly Rect[], avoid: readonly Rect[], r: number, margin: number, hall: Pick<Hall, 'width' | 'depth'>): Vec3[] {
  const out: Vec3[] = points.length ? [points[0]] : [];
  for (let i = 0; i < points.length - 1; i++) {
    const s = points[i];
    const t = points[i + 1];
    const dx = Math.abs(t.x - s.x);
    const dy = Math.abs(t.y - s.y);
    const k: 'x' | 'y' | null = dx > 1e-6 && dy <= 1e-6 ? 'x' : dy > 1e-6 && dx <= 1e-6 ? 'y' : null;
    if (!k) {
      out.push(t);
      continue;
    }
    const j: 'x' | 'y' = k === 'x' ? 'y' : 'x';
    const c = s[j];
    const sk = s[k];
    const tk = t[k];
    const dir = tk > sk ? 1 : -1;
    const lo = Math.min(sk, tk);
    const hi = Math.max(sk, tk);
    const iv = blockers
      .map((b) => (k === 'x' ? { k0: b.x, k1: b.x + b.w, j0: b.y, j1: b.y + b.d } : { k0: b.y, k1: b.y + b.d, j0: b.x, j1: b.x + b.w }))
      .filter((b) => Math.min(c + r, b.j1) - Math.max(c - r, b.j0) > 0.004 && Math.min(hi + r, b.k1) - Math.max(lo - r, b.k0) > 0.004)
      .sort((p, q) => p.k0 - q.k0);
    if (!iv.length) {
      out.push(t);
      continue;
    }
    const gap = 2 * (r + margin);
    const clusters: typeof iv = [];
    for (const b of iv) {
      const last = clusters[clusters.length - 1];
      if (last && b.k0 <= last.k1 + gap) {
        last.k1 = Math.max(last.k1, b.k1);
        last.j0 = Math.min(last.j0, b.j0);
        last.j1 = Math.max(last.j1, b.j1);
      } else clusters.push({ ...b });
    }
    if (dir < 0) clusters.reverse();
    const span = j === 'x' ? hall.width : hall.depth;
    const zAt = (kv: number) => s.z + (t.z - s.z) * ((kv - sk) / (tk - sk));
    const P = (kv: number, jv: number): Vec3 => (k === 'x' ? { x: kv, y: jv, z: zAt(kv) } : { x: jv, y: kv, z: zAt(kv) });
    const legHits = (ka: number, kb: number, ja: number, jb: number) =>
      avoid.some((b) => (k === 'x' ? capsuleHitsRect(Math.min(ka, kb), Math.min(ja, jb), Math.max(ka, kb), Math.max(ja, jb), r, b) : capsuleHitsRect(Math.min(ja, jb), Math.min(ka, kb), Math.max(ja, jb), Math.max(ka, kb), r, b)));
    for (const cl of clusters) {
      const inside = (kv: number) => kv > cl.k0 - r && kv < cl.k1 + r && c > cl.j0 - r && c < cl.j1 + r;
      if (inside(sk) || inside(tk)) continue;
      let enter = dir > 0 ? cl.k0 - r - margin : cl.k1 + r + margin;
      let exit = dir > 0 ? cl.k1 + r + margin : cl.k0 - r - margin;
      if (dir * (enter - sk) < 0) enter = sk;
      if (dir * (tk - exit) < 0) exit = tk;
      const cands = [cl.j0 - r - margin, cl.j1 + r + margin].sort((p, q) => Math.abs(p - c) - Math.abs(q - c));
      const cj = cands.find((v) => v - r >= 0.05 && v + r <= span - 0.05 && !legHits(enter, enter, c, v) && !legHits(enter, exit, v, v) && !legHits(exit, exit, v, c));
      if (cj === undefined) continue;
      out.push(P(enter, c), P(enter, cj), P(exit, cj), P(exit, c));
    }
    out.push(t);
  }
  return out;
}

/**
 * Cable-bundle polylines for one hall. Rows along X keep the v2 viewer path exactly (rise at the rack to the row tray, along the row tray,
 * over the main tray to the other row); rows along Y use the same path with x and y swapped (main tray along X, F8).
 */
export function cableRunPaths(hall: Hall, items: readonly EquipmentInstance[], runs: readonly CableRun[], trays: readonly CableTray[] | undefined, opts: CableRunPathOptions = {}): CableRunGeometry {
  const byId = new Map(items.filter((e) => e.hallId === hall.id).map((e) => [e.id, e]));
  const allById = new Map((opts.allEquipment ?? items).map((e) => [e.id, e]));
  const rows = rowGroupsFromEquipment(hall.id, [...byId.values()]);
  const rowOf = new Map<string, RowGroup>();
  for (const r of rows) for (const id of r.memberIds) rowOf.set(id, r);
  const skipped: Partial<Record<CableSkipReason, number>> = {};
  const bump = (k: CableSkipReason, n = 1) => (skipped[k] = (skipped[k] ?? 0) + n);

  // hall axis: the rows' majority axis
  const xRows = rows.filter((r) => r.axis === 'x').length;
  const axis: 'x' | 'y' = xRows * 2 >= rows.length ? 'x' : 'y';
  const L = axis === 'x' ? hall.width : hall.depth;
  const P = axis === 'x' ? hall.depth : hall.width;
  const A = (p: { x: number; y: number }) => (axis === 'x' ? p.x : p.y);
  const Pp = (p: { x: number; y: number }) => (axis === 'x' ? p.y : p.x);
  const V = (a: number, p: number, z: number): Vec3 => (axis === 'x' ? { x: a, y: p, z } : { x: p, y: a, z });
  const axisRows = rows.filter((r) => r.axis === axis);
  // main tray position along the row axis: stored main trays running across the rows (constant a), else the derived cross tray
  const mains = (trays ?? []).filter((t) => t.hallId === hall.id && t.kind === 'main' && t.points.length > 1 && Math.abs(A(t.points[0]) - A(t.points[t.points.length - 1])) < 1e-3);
  const derived = axisRows.length ? Math.max(...axisRows.map((r) => r.a1)) + 0.45 : 0;
  const ac0 = mains.length ? Math.max(...mains.map((t) => A(t.points[0]))) : Math.min(derived, L - 0.35);
  const rowP0 = axisRows.length ? Math.min(...axisRows.map((r) => r.center)) - 1.5 : 0;
  const rowP1 = axisRows.length ? Math.max(...axisRows.map((r) => r.center)) + 1.5 : P;
  const rowA0 = axisRows.length ? Math.min(...axisRows.map((r) => r.a0)) : 0;
  const rowA1 = axisRows.length ? Math.max(...axisRows.map((r) => r.a1)) : L;

  // aggregate identical bundles of this hall, keep the heaviest per hall when over budget
  const agg = new Map<string, CableRun>();
  for (const run of runs) {
    const fa = allById.get(run.fromId)?.hallId;
    const fb = allById.get(run.toId)?.hallId;
    if (fa !== hall.id && fb !== hall.id) continue;
    const key = `${run.fromId}|${run.toId}|${run.fabric}`;
    const prev = agg.get(key);
    if (prev) prev.count += run.count;
    else agg.set(key, { ...run });
  }
  let list = [...agg.values()];
  const bundles = list.length;
  const budget = opts.budget ?? CABLE_BUNDLE_BUDGET_PER_HALL;
  if (list.length > budget) {
    list = list.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
    bump('budget', list.length - budget);
    list = list.slice(0, budget);
  }

  const zt = hall.trayHeight;
  const sleeves = (opts.trunkSleeves ?? []).filter((s) => s.hallId === hall.id && s.kind === 'trunk-sleeve');
  // r4 A1 (W8 open issue): bundles step around interior columns / shafts (the audit's grown keepouts) instead of passing through them
  const blockers = blockingKeepouts(hall.keepouts, COLUMN_GROW_M);
  const avoid = [...blockers, ...containmentRects(hall, opts.containments)];
  const paths: CablePath[] = [];
  for (const run of list) {
    const a = byId.get(run.fromId);
    const b = byId.get(run.toId);
    const h = hash(run.id || `${run.fromId}${run.toId}`);
    const lat = (((h % 17) / 16) * 2 - 1) * 0.11;
    const lvl = fabricLevel(run.fabric);
    const zl = zt + 0.07 + lvl * 0.035 + ((h >> 5) % 3) * 0.012;
    const zc = zt + 0.35 + 0.07 + lvl * 0.035;
    const radius = Math.min(0.04, Math.max(0.008, 0.005 * Math.sqrt(run.count)));
    const ac = ac0 + lat;
    const margin = DODGE_MARGIN_M + ((h >>> 11) % 4) * 0.015;
    const push = (raw: Vec3[]) => {
      const points = blockers.length ? dodgeBlockers(raw, blockers, avoid, radius, margin, hall) : raw;
      paths.push({ runId: run.id, fabric: run.fabric, count: run.count, radius, points: points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y, p.z - points[i - 1].z) > 1e-6), tier: run.tier });
    };

    if (!a || !b) {
      const local = a ?? b;
      const far = allById.get(a ? run.toId : run.fromId);
      if (!local || !far) {
        bump('missing');
        continue;
      }
      // inter-hall trunk: rack → row tray → main tray → trunk sleeve on the facing wall → 1 m outside
      const sleeve = sleeves.find((s) => s.targetId === far.hallId);
      const r = rowOf.get(local.id);
      const it = findCatalogItem(local.catalogId);
      if (!sleeve || !r || !it || r.axis !== axis) {
        bump(sleeve ? 'no-row' : 'inter-hall-no-sleeve');
        continue;
      }
      const pA = r.center + r.frontSign * 0.3 + lat;
      const zT = (sleeve.z[0] + sleeve.z[1]) / 2 + lat * 0.5;
      const mid = (sleeve.along[0] + sleeve.along[1]) / 2 + lat * Math.min(1, (sleeve.along[1] - sleeve.along[0]) / 0.3);
      const pts: Vec3[] = [V(A(local.position), pA, it.dims.h), V(A(local.position), pA, zl), V(ac - 0.3, pA, zl), V(ac, pA, zc)];
      const aWall = (sleeve.wall === 'W' || sleeve.wall === 'E') === (axis === 'x');
      if (aWall) {
        // sleeve on a wall across the row axis: along the main tray to the sleeve line, up to the trunk level, straight to the wall
        const aOut = sleeve.wall === 'W' || sleeve.wall === 'S' ? -1.0 : L + 1.0;
        pts.push(V(ac, mid, zc), V(ac, mid, zT), V(aOut, mid, zT));
      } else {
        // sleeve on a wall parallel to the rows: to the main tray end nearest the wall, up, along to the sleeve, out through the wall
        const toHigh = sleeve.wall === 'N' || sleeve.wall === 'E';
        const pEnd = toHigh ? Math.min(P - 0.6, rowP1) : Math.max(0.6, rowP0);
        const pOut = toHigh ? P + 1.0 : -1.0;
        pts.push(V(ac, pEnd, zc), V(ac, pEnd, zT), V(mid, pEnd, zT), V(mid, pOut, zT));
      }
      push(pts);
      continue;
    }
    const ra = rowOf.get(a.id);
    const rb = rowOf.get(b.id);
    const ia = findCatalogItem(a.catalogId);
    const ib = findCatalogItem(b.catalogId);
    if (!ia || !ib) {
      bump('missing');
      continue;
    }
    if (ra && rb) {
      if (ra.axis !== axis || rb.axis !== axis) {
        bump('mixed-axis');
        continue;
      }
      const pA = ra.center + ra.frontSign * 0.3 + lat;
      const pB = rb.center + rb.frontSign * 0.3 + lat;
      const pts: Vec3[] = [V(A(a.position), pA, ia.dims.h), V(A(a.position), pA, zl)];
      if (ra === rb) pts.push(V(A(b.position), pA, zl), V(A(b.position), pA, ib.dims.h));
      else pts.push(V(ac - 0.3, pA, zl), V(ac, pA, zc), V(ac, pB, zc), V(ac - 0.3, pB, zl), V(A(b.position), pB, zl), V(A(b.position), pB, ib.dims.h));
      push(pts);
      continue;
    }
    // one row-less endpoint (CRAH / CDU / in-room unit): route it to the row endpoint through the perimeter or the end aisle
    const [u, iu, rr, ir, ru] = ra ? [b, ib, a, ia, ra] : [a, ia, b, ib, rb];
    if (!ru) {
      bump('no-row');
      continue;
    }
    if (ru.axis !== axis) {
      bump('mixed-axis');
      continue;
    }
    const pR = ru.center + ru.frontSign * 0.3 + lat;
    const ua = A(u.position);
    const up = Pp(u.position);
    const uTop = (u.elevation ?? 0) + iu.dims.h;
    let pts: Vec3[];
    if (up < rowP0 || up > rowP1) {
      // perimeter unit: along the perimeter to the main tray, across on the main tray, down the row tray to the rack
      pts = [V(ua, up, uTop), V(ua, up, Math.max(zc, uTop + 0.1)), V(ac, up, Math.max(zc, uTop + 0.1)), V(ac, up, zc), V(ac, pR, zc), V(ac - 0.3, pR, zl), V(A(rr.position), pR, zl), V(A(rr.position), pR, ir.dims.h)];
    } else if (ua < rowA0 - 0.3 || ua > rowA1 + 0.3) {
      // end-aisle unit: across the end aisle to the row-tray line, along the row tray to the rack
      pts = [V(ua, up, uTop), V(ua, up, Math.max(zc, uTop + 0.1)), V(ua, pR, Math.max(zc, uTop + 0.1)), V(ua, pR, zl), V(A(rr.position), pR, zl), V(A(rr.position), pR, ir.dims.h)];
    } else {
      bump('no-row');
      continue;
    }
    push(ra ? pts.reverse() : pts);
  }
  return { paths, skipped, bundles };
}

/** Plan rectangle helpers used by the router and the audit. */
export const rectOverlapStrict = (a: Rect, b: Rect, eps = 1e-6) => a.x < b.x + b.w - eps && a.x + a.w > b.x + eps && a.y < b.y + b.d - eps && a.y + a.d > b.y + eps;
