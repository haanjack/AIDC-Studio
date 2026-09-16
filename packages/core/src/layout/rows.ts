import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect, frontVector, rectsOverlap, round6 } from '../model/geometry.ts';
import { resolveVerticals } from '../scene/datums.ts';
import type { Busway, CableTray, EquipmentInstance, Hall, Keepout, Project, Rect, RowGroup, Vec3 } from '../model/types.ts';

/**
 * Row / tray / busway geometry (stream S1, PROPOSAL-v2 §3.1 Phase A).
 *
 * `detectRowGroups` groups equipment by `rowId` (the derivation the viewer used to do at render time);
 * `generateTrays` / `generateBusways` build polylines from the rows and clip every polyline to the hall
 * rectangle minus column / shaft keepouts, so nothing can pierce a wall in core, in the viewer, in USD or in
 * the drawings. `generateHallLayout` calls the same builders with the rows it lays out itself.
 *
 * Geometry conventions (all `estimate`, matching the v0.1 viewer):
 *   row tray      0.3 m wide at hall.trayHeight, 0.3 m in front of the row centre line (cold-aisle side)
 *   main tray     0.45 m wide, one tray level higher (+0.35 m), 0.45 m beyond the row ends of each pod column
 *   drops         per rack (vertical from the row tray to the rack top) + per row (row tray → main tray)
 *   busway A/B    0.2 m apart above the rear of the racks, z = min(trayHeight − 0.22, rack height + 0.4)
 */

export const RACK_CATEGORIES_FOR_ROWS: ReadonlySet<string> = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);

const TRAY_ROW_WIDTH_M = 0.3;
const TRAY_MAIN_WIDTH_M = 0.45;
const TRAY_MAIN_OFFSET_M = 0.45;
const TRAY_MAIN_RAISE_M = 0.35;
const TRAY_FRONT_OFFSET_M = 0.3;
/** junction drop stub along the row / main tray (m): keeps the tray graph's end-to-segment join unambiguous */
const JUNCTION_STUB_M = 0.15;
/** longest cross aisle a row start is led in across to the previous main tray (m) */
export const LEAD_IN_MAX_M = 3;
/** main-tray keep-off from a row end (m): end-fed busway feeders rise within this distance of the row end (engines/powerGeometry.ts) */
export const FEED_ZONE_M = 2.5;
/** busway band half-width around the row centre incl. feeders (m) */
const BUSWAY_BAND_HALF_M = 0.35;
const BUSWAY_AMPACITY_A = 800; // rpp-800a class busway (estimate)
/** ladder-tray rail height used for tier crossings when the tier has no height (m, as scene/datums T1–T3) */
const TIER_RAIL_H_M = 0.096;
/** plan clearance a tier tray keeps to a main / drop tray crossing its level (m, estimate) */
const TIER_CROSS_CLEAR_M = 0.05;
/** parallel main trays closer than their width + this clearance merge into one (m, estimate; backlog finish) */
const MAIN_MERGE_CLEAR_M = 0.1;
const DEFAULT_RACK_H = 2.3;

/** Row kind from the pod id and the members' network roles. */
export function rowKindOf(podId: string | undefined, members: readonly EquipmentInstance[]): RowGroup['kind'] {
  if (!podId || !podId.startsWith('pod-services')) return 'compute';
  const core = members.filter((e) => e.networkRole === 'scale-out-spine' || e.networkRole === 'scale-out-core' || (e.networkRole && ['frontend', 'storage', 'oob', 'mixed'].includes(e.networkRole) && findCatalogItem(e.catalogId)?.category === 'network-rack')).length;
  return core * 2 >= members.length ? 'network-core' : 'services';
}

/** Group `equipment` (already filtered to one hall) into RowGroups by `rowId`. */
export function rowGroupsFromEquipment(hallId: string, equipment: readonly EquipmentInstance[]): RowGroup[] {
  const map = new Map<string, EquipmentInstance[]>();
  for (const e of equipment) {
    if (!e.rowId || e.hallId !== hallId) continue;
    const list = map.get(e.rowId) ?? [];
    list.push(e);
    map.set(e.rowId, list);
  }
  const rows: RowGroup[] = [];
  for (const [id, members] of map) {
    const rot = members[0].rotationDeg;
    const axis: 'x' | 'y' = rot % 180 === 0 ? 'x' : 'y';
    const f = frontVector(rot);
    let a0 = Infinity;
    let a1 = -Infinity;
    let c = 0;
    let n = 0;
    for (const e of members) {
      const item = findCatalogItem(e.catalogId);
      if (!item) continue;
      const r = footprintRect(item.dims, e.position, e.rotationDeg);
      if (axis === 'x') {
        a0 = Math.min(a0, r.x);
        a1 = Math.max(a1, r.x + r.w);
        c += e.position.y;
      } else {
        a0 = Math.min(a0, r.y);
        a1 = Math.max(a1, r.y + r.d);
        c += e.position.x;
      }
      n++;
    }
    if (n === 0) continue;
    const frontSign: 1 | -1 = (axis === 'x' ? f.y : f.x) >= 0 ? 1 : -1;
    rows.push({ id, hallId, podId: members[0].podId, kind: rowKindOf(members[0].podId, members), axis, a0: round6(a0), a1: round6(a1), center: round6(c / n), frontSign, memberIds: members.map((e) => e.id) });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function detectRowGroups(project: Project, hall: Hall): RowGroup[] {
  return rowGroupsFromEquipment(hall.id, project.equipment);
}

// ───────────────────────────── clipping ─────────────────────────────

/** Keepouts that block overhead runs (columns and shafts go floor-to-ceiling; doors / egress do not). */
export function blockingKeepouts(keepouts: readonly Keepout[], grow = 0.05): Rect[] {
  return keepouts.filter((k) => k.kind === 'column' || k.kind === 'shaft').map((k) => ({ x: k.rect.x - grow, y: k.rect.y - grow, w: k.rect.w + 2 * grow, d: k.rect.d + 2 * grow }));
}

/**
 * Clip an axis-aligned polyline to `rect` and cut out `blockers`. Returns zero or more polylines
 * (a blocker in the middle of a segment splits the run). Vertical segments (same x,y) are kept when the point lies inside.
 */
export function clipPolyline(points: readonly Vec3[], rect: Rect, blockers: readonly Rect[] = []): Vec3[][] {
  const out: Vec3[][] = [];
  let cur: Vec3[] = [];
  const flush = () => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  const inside = (p: Vec3) => p.x >= rect.x - 1e-6 && p.x <= rect.x + rect.w + 1e-6 && p.y >= rect.y - 1e-6 && p.y <= rect.y + rect.d + 1e-6;
  const blocked = (p: Vec3) => blockers.some((b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.d);
  const push = (p: Vec3) => {
    const q = { x: round6(p.x), y: round6(p.y), z: round6(p.z) };
    const last = cur[cur.length - 1];
    if (last && Math.abs(last.x - q.x) < 1e-6 && Math.abs(last.y - q.y) < 1e-6 && Math.abs(last.z - q.z) < 1e-6) return;
    cur.push(q);
  };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    // parametric clip of the segment against the rect (segments are axis-aligned or vertical)
    let t0 = 0;
    let t1 = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const clipAxis = (p: number, q: number) => {
      // p·t ≤ q form
      if (Math.abs(p) < 1e-12) return q >= -1e-9;
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      return t0 <= t1 + 1e-9;
    };
    const ok = clipAxis(-dx, a.x - rect.x) && clipAxis(dx, rect.x + rect.w - a.x) && clipAxis(-dy, a.y - rect.y) && clipAxis(dy, rect.y + rect.d - a.y);
    if (!ok || t0 > t1) {
      flush();
      continue;
    }
    const pa = { x: a.x + dx * t0, y: a.y + dy * t0, z: a.z + (b.z - a.z) * t0 };
    const pb = { x: a.x + dx * t1, y: a.y + dy * t1, z: a.z + (b.z - a.z) * t1 };
    if (t0 > 1e-9) flush();
    // subtract blockers along the segment (only for horizontal runs)
    const len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    const cuts: [number, number][] = [];
    if (len > 1e-9) {
      for (const bl of blockers) {
        // interval of the segment inside the blocker
        let u0 = 0;
        let u1 = 1;
        const sx = pb.x - pa.x;
        const sy = pb.y - pa.y;
        const slab = (p: number, q: number) => {
          if (Math.abs(p) < 1e-12) return q >= 0;
          const r = q / p;
          if (p < 0) u0 = Math.max(u0, r);
          else u1 = Math.min(u1, r);
          return u0 <= u1;
        };
        if (slab(-sx, pa.x - bl.x) && slab(sx, bl.x + bl.w - pa.x) && slab(-sy, pa.y - bl.y) && slab(sy, bl.y + bl.d - pa.y) && u1 - u0 > 1e-6) cuts.push([u0, u1]);
      }
      cuts.sort((p, q) => p[0] - q[0]);
    }
    if (!inside(pa) || blocked(pa)) flush();
    push(pa);
    let u = 0;
    for (const [c0, c1] of cuts) {
      if (c0 > u + 1e-9) push({ x: pa.x + (pb.x - pa.x) * c0, y: pa.y + (pb.y - pa.y) * c0, z: pa.z + (pb.z - pa.z) * c0 });
      flush();
      u = Math.max(u, c1);
      push({ x: pa.x + (pb.x - pa.x) * u, y: pa.y + (pb.y - pa.y) * u, z: pa.z + (pb.z - pa.z) * u });
    }
    push(pb);
    if (t1 < 1 - 1e-9) flush();
  }
  flush();
  return out;
}

// ───────────────────────────── builders ─────────────────────────────

interface RowMeta {
  rackH: number;
  members: EquipmentInstance[];
}

function rowMeta(row: RowGroup, byId: Map<string, EquipmentInstance>): RowMeta {
  let rackH = 0;
  const members: EquipmentInstance[] = [];
  for (const id of row.memberIds) {
    const e = byId.get(id);
    if (!e) continue;
    members.push(e);
    const item = findCatalogItem(e.catalogId);
    if (item && RACK_CATEGORIES_FOR_ROWS.has(item.category)) rackH = Math.max(rackH, item.dims.h);
  }
  return { rackH: rackH || DEFAULT_RACK_H, members };
}

/** Along-axis point helper: `a` along the row axis, `c` perpendicular. */
function pt(axis: 'x' | 'y', a: number, c: number, z: number): Vec3 {
  return axis === 'x' ? { x: a, y: c, z } : { x: c, y: a, z };
}

export interface TrayBuildOptions {
  /** per-rack drops (one vertical polyline per rack). Default false: the viewer draws them from the row members and
   *  the network engine's tray-graph router (engines/network.ts) gets a graph ~5× smaller. */
  rackDrops?: boolean;
}

/** Build trays from rows and the equipment they reference (hall-local coordinates), clipped to the hall. */
export function buildTrays(hall: Hall, rows: readonly RowGroup[], equipment: readonly EquipmentInstance[], opts: TrayBuildOptions = {}): CableTray[] {
  const byId = new Map(equipment.map((e) => [e.id, e]));
  const rect: Rect = { x: 0.05, y: 0.05, w: Math.max(0, hall.width - 0.1), d: Math.max(0, hall.depth - 0.1) };
  const blockers = blockingKeepouts(hall.keepouts);
  const zt = hall.trayHeight;
  const zm = zt + TRAY_MAIN_RAISE_M;
  const out: CableTray[] = [];
  const emit = (id: string, kind: CableTray['kind'], points: Vec3[], widthM: number, cableCount?: number) => {
    const parts = clipPolyline(points, rect, blockers);
    parts.forEach((p, i) => out.push({ id: parts.length > 1 ? `${id}-${i + 1}` : id, hallId: hall.id, kind, points: p, widthM, cableCount }));
  };
  const trayC = (r: RowGroup) => r.center + r.frontSign * TRAY_FRONT_OFFSET_M;

  for (const axis of ['x', 'y'] as const) {
    const ax = rows.filter((r) => r.axis === axis);
    if (!ax.length) continue;
    // row trays + rack drops
    for (const r of ax) {
      emit(`tray-${r.id}`, 'row', [pt(axis, r.a0, trayC(r), zt), pt(axis, r.a1, trayC(r), zt)], TRAY_ROW_WIDTH_M, r.memberIds.length);
      if (opts.rackDrops === true) {
        const meta = rowMeta(r, byId);
        for (const e of meta.members) {
          const item = findCatalogItem(e.catalogId);
          if (!item || !RACK_CATEGORIES_FOR_ROWS.has(item.category)) continue;
          const a = axis === 'x' ? e.position.x : e.position.y;
          emit(`drop-${e.id}`, 'drop', [pt(axis, a, trayC(r), zt), pt(axis, a, trayC(r), item.dims.h)], 0.15, 1);
        }
      }
    }
    // main trays: one per cluster of row ends (pod columns share an end coordinate), running perpendicular to the rows
    const cMin = Math.min(...ax.map(trayC)) - 0.15;
    const cMax = Math.max(...ax.map(trayC)) + 0.15;
    const clusters = new Map<number, RowGroup[]>();
    for (const r of ax) {
      const key = Math.round(r.a1 / 0.6);
      const list = clusters.get(key) ?? [];
      list.push(r);
      clusters.set(key, list);
    }
    const ends = [...clusters.entries()].sort((p, q) => p[0] - q[0]);
    const hallMax = axis === 'x' ? hall.width : hall.depth;
    // T1b (backlog-T1b §1): a cluster of short rows (e.g. a services row in a centre band) was joined to the pod trays only at the far end of
    // its main tray. Junctions: a main tray that passes over another row tray gets a drop there (J2) and its span reaches the nearest such
    // row below its own rows; a row that starts just past a main tray (the cross aisle between pod columns) gets a lead-in to it (J3).
    // Neither passes over the busway band of a row whose end is within FEED_ZONE_M of the main tray (end-fed busway risers).
    const mains0 = ends.map(([, list], i) => {
      const am = Math.min(Math.max(...list.map((r) => r.a1)) + TRAY_MAIN_OFFSET_M, hallMax - 0.35);
      const span: [number, number] = i === ends.length - 1 ? [cMin, cMax] : [Math.min(...list.map(trayC)) - 0.15, cMax];
      return { id: `tray-main-${axis}${i + 1}`, list, am, span };
    });
    // backlog finish (qa-backlog-geometry.md open item 4): row ends that straddle a 0.6 m bucket (e.g. 19.6 / 20.0 / 20.2 m: pod rows of
    // one column and a services row whose containment runs to the pod column end) gave two main trays 0.2 m apart at the same level —
    // overlapping in plan, the inner one grazing the end transom of the ducted chimney. Mains closer than a tray width + clearance merge
    // into the outer line (the merged span covers both); halls whose mains are clear of each other keep their trays and ids unchanged.
    const mains: typeof mains0 = [];
    for (const m of mains0) {
      const last = mains[mains.length - 1];
      if (last && Math.abs(m.am - last.am) < TRAY_MAIN_WIDTH_M + MAIN_MERGE_CLEAR_M) {
        last.list = [...last.list, ...m.list];
        last.am = Math.max(last.am, m.am);
        last.span = [Math.min(last.span[0], m.span[0]), Math.max(last.span[1], m.span[1])];
      } else mains.push({ ...m, id: `tray-main-${axis}${mains.length + 1}`, span: [m.span[0], m.span[1]] });
    }
    const nearEnd = (r: RowGroup, am: number) => am >= r.a0 - FEED_ZONE_M && am <= r.a1 + FEED_ZONE_M && !(am > r.a0 + FEED_ZONE_M && am < r.a1 - FEED_ZONE_M);
    const crossing = new Map<string, RowGroup[]>();
    const leadIn = new Map<string, RowGroup[]>();
    for (const m of mains) {
      const over = ax.filter((r) => !m.list.includes(r) && r.a0 + FEED_ZONE_M < m.am && m.am < r.a1 - FEED_ZONE_M);
      const below = over.filter((r) => trayC(r) < m.span[0]).sort((p, q) => trayC(q) - trayC(p))[0];
      if (below) {
        const lo = trayC(below) - 0.15;
        const blocked = ax.some((r) => !m.list.includes(r) && nearEnd(r, m.am) && r.center + BUSWAY_BAND_HALF_M > lo && r.center - BUSWAY_BAND_HALF_M < m.span[0]);
        if (!blocked) m.span[0] = Math.max(cMin, lo);
      }
      // QA backlog geometry (qa-backlog-geometry.md §4): a junction at EVERY row tray the main passes over, also within the feed zone of a
      // short row (the zone only limits the J1 extension above). A rack under such a main attached to the main tray (0.15 m) instead of its
      // row tray (0.30 m) and the run went round the main tray's far end: 101–114 m between neighbouring racks of one row (HGX-class 16 DU).
      const passes = ax.filter((r) => !m.list.includes(r) && r.a0 + 2 * JUNCTION_STUB_M < m.am && m.am < r.a1 - 2 * JUNCTION_STUB_M);
      crossing.set(m.id, passes.filter((r) => trayC(r) >= m.span[0] && trayC(r) <= m.span[1]));
      leadIn.set(m.id, []);
    }
    for (const r of ax) {
      const before = mains.filter((m) => !m.list.includes(r) && m.am < r.a0 - 1e-6 && r.a0 - m.am <= LEAD_IN_MAX_M && trayC(r) >= m.span[0] && trayC(r) <= m.span[1]).sort((p, q) => q.am - p.am)[0];
      if (before) leadIn.get(before.id)!.push(r);
    }
    const stub = (c: number, span: readonly number[]) => (c + JUNCTION_STUB_M <= span[1] ? c + JUNCTION_STUB_M : c - JUNCTION_STUB_M);
    for (const m of mains) {
      const { list, am } = m;
      const joined = [...list, ...crossing.get(m.id)!, ...leadIn.get(m.id)!];
      // a vertex at every row junction so the tray graph (engines/network.ts) connects rows along the main tray directly
      const stops = [...new Set([round6(m.span[0]), ...joined.map((r) => round6(trayC(r))).filter((c) => c > m.span[0] && c < m.span[1]), round6(m.span[1])])].sort((p, q) => p - q);
      emit(m.id, 'main', stops.map((c) => pt(axis, am, c, zm)), TRAY_MAIN_WIDTH_M, list.reduce((s, r) => s + r.memberIds.length, 0));
      for (const r of list) emit(`drop-${r.id}-main`, 'drop', [pt(axis, r.a1, trayC(r), zt), pt(axis, am, trayC(r), zt), pt(axis, am, trayC(r), zm)], TRAY_ROW_WIDTH_M, r.memberIds.length);
      // J2: the end stubs keep the graph's end-to-segment join unambiguous (bottom end on the row tray, top end on the main tray)
      for (const r of crossing.get(m.id)!) {
        const c = trayC(r);
        const aLow = am - JUNCTION_STUB_M > r.a0 ? am - JUNCTION_STUB_M : am + JUNCTION_STUB_M;
        emit(`drop-${r.id}-x-${axis}${mains.indexOf(m) + 1}`, 'drop', [pt(axis, aLow, c, zt), pt(axis, am, c, zt), pt(axis, am, c, zm), pt(axis, am, stub(c, m.span), zm)], TRAY_ROW_WIDTH_M, r.memberIds.length);
      }
      // J3: lead-in from the row start back across the cross aisle to the main tray of the previous pod column
      for (const r of leadIn.get(m.id)!) {
        const c = trayC(r);
        emit(`drop-${r.id}-lead-${axis}${mains.indexOf(m) + 1}`, 'drop', [pt(axis, r.a0, c, zt), pt(axis, am, c, zt), pt(axis, am, c, zm), pt(axis, am, stub(c, m.span), zm)], TRAY_ROW_WIDTH_M, r.memberIds.length);
      }
    }
  }
  return out;
}

/**
 * Per-tier trays (T1b, backlog-T1b §2): one tray per row on every tray tier above T1 of `resolveVerticals` (default T2 = front-end +
 * storage at T1 + 0.35 m, T3 = OOB at T1 + 0.70 m; explicit `Hall.verticals.tiers` are honoured). They stack over the row's T1 tray
 * (same plan line, cold-aisle side, clear of the busway band and the hot-aisle chimney) and are clipped to the hall like every tray.
 * Not part of `project.trays`: the network engine keeps routing on T1 + main trays, so cable lengths and stored projects are unchanged.
 * `main` in a tier's `carries` is the main (cross) tray set, already emitted by `buildTrays` at its own level (T1 + 0.35 m = default T2).
 */
export function buildTierTrays(hall: Hall, rows: readonly RowGroup[], equipment: readonly EquipmentInstance[], trays?: readonly CableTray[]): CableTray[] {
  const byId = new Map(equipment.map((e) => [e.id, e]));
  const rect: Rect = { x: 0.05, y: 0.05, w: Math.max(0, hall.width - 0.1), d: Math.max(0, hall.depth - 0.1) };
  const blockers = blockingKeepouts(hall.keepouts);
  const out: CableTray[] = [];
  const hallRows = rows.filter((r) => r.hallId === hall.id);
  if (!hallRows.length) return out;
  const rackH = Math.max(...hallRows.map((r) => rowMeta(r, byId).rackH));
  const trayTiers = resolveVerticals(hall, rackH).tiers.filter((t) => t.kind === 'tray').sort((p, q) => p.z - q.z);
  // QA backlog geometry (qa-backlog-geometry.md §3): main trays sit at T1 + 0.35 m, which is the default T2 level, so a main tray passing
  // over a row line (J2 junction mains, mains inside a row's span) and its junction drop ran through that row's T2 tray (5 / 5 sampled
  // halls, 1–34 crossings). The tier tray now stops short of every main / drop tray whose rails reach its level (a crossing, as a tee /
  // cross fitting would) — `trays` defaults to the trays buildTrays makes for these rows.
  const crossing = (trays ?? buildTrays(hall, hallRows, equipment)).filter((t) => t.hallId === hall.id && (t.kind === 'main' || t.kind === 'drop'));
  for (const tier of trayTiers.slice(1)) {
    const carries = tier.carries.filter((c) => c !== 'main');
    if (!carries.length) continue;
    const tid = tier.id.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const width = tier.widthM ?? TRAY_ROW_WIDTH_M;
    const half = (tier.heightM ?? TIER_RAIL_H_M) / 2;
    const cuts: Rect[] = [];
    for (const t of crossing) {
      for (let i = 0; i < t.points.length - 1; i++) {
        const a = t.points[i];
        const b = t.points[i + 1];
        if (Math.max(a.z, b.z) + TIER_RAIL_H_M / 2 <= tier.z - half || Math.min(a.z, b.z) - TIER_RAIL_H_M / 2 >= tier.z + half) continue;
        const g = t.widthM / 2 + TIER_CROSS_CLEAR_M + width / 2;
        cuts.push({ x: Math.min(a.x, b.x) - g, y: Math.min(a.y, b.y) - g, w: Math.abs(b.x - a.x) + 2 * g, d: Math.abs(b.y - a.y) + 2 * g });
      }
    }
    for (const r of hallRows) {
      // QA backlog geometry: a tier wider than T1 grows toward the cold aisle, keeping T1's busway-side edge. Centred on the T1 line, the
      // 0.45 m T2 tray overhung the busway band by 0.075 m: tap-off bars and the end-fed feeder risers passed through it (VR-class rows:
      // 2,088 tap-off and 870 feeder crossings in the sweep).
      const c = r.center + r.frontSign * (TRAY_FRONT_OFFSET_M + Math.max(0, width - TRAY_ROW_WIDTH_M) / 2);
      const parts = clipPolyline([pt(r.axis, r.a0, c, tier.z), pt(r.axis, r.a1, c, tier.z)], rect, [...blockers, ...cuts]);
      parts.forEach((p, i) => out.push({ id: `tray-${r.id}-${tid}${parts.length > 1 ? `-${i + 1}` : ''}`, hallId: hall.id, kind: 'row', points: p, widthM: width, cableCount: r.memberIds.length, tier: tier.id, carries }));
    }
  }
  return out;
}

/** A/B busways per row with one tap-off per rack, clipped to the hall. */
export function buildBusways(hall: Hall, rows: readonly RowGroup[], equipment: readonly EquipmentInstance[], ampacityA = BUSWAY_AMPACITY_A): Busway[] {
  const byId = new Map(equipment.map((e) => [e.id, e]));
  const rect: Rect = { x: 0.05, y: 0.05, w: Math.max(0, hall.width - 0.1), d: Math.max(0, hall.depth - 0.1) };
  const blockers = blockingKeepouts(hall.keepouts);
  const out: Busway[] = [];
  for (const r of rows) {
    const meta = rowMeta(r, byId);
    const zb = Math.min(hall.trayHeight - 0.22, meta.rackH + 0.4);
    const tapoffs = meta.members
      .filter((e) => {
        const item = findCatalogItem(e.catalogId);
        return !!item && RACK_CATEGORIES_FOR_ROWS.has(item.category);
      })
      .map((e) => ({ x: round6(e.position.x), y: round6(e.position.y), equipmentId: e.id }));
    (['A', 'B'] as const).forEach((path, i) => {
      const c = r.center + r.frontSign * 0.02 + (i === 0 ? -0.1 : 0.1);
      const parts = clipPolyline([pt(r.axis, r.a0, c, zb), pt(r.axis, r.a1, c, zb)], rect, blockers);
      parts.forEach((p, j) => out.push({ id: parts.length > 1 ? `bus-${path}-${r.id}-${j + 1}` : `bus-${path}-${r.id}`, hallId: hall.id, path, points: p, ampacityA, tapoffs: path === 'A' ? tapoffs : tapoffs.map((t) => ({ ...t })) }));
    });
  }
  return out;
}

export function generateTrays(project: Project, hall: Hall, rows: RowGroup[]): CableTray[] {
  return buildTrays(hall, rows, project.equipment.filter((e) => e.hallId === hall.id));
}

export function generateBusways(project: Project, hall: Hall, rows: RowGroup[]): Busway[] {
  const rpp = findCatalogItem(project.power.rppCatalogId);
  return buildBusways(hall, rows, project.equipment.filter((e) => e.hallId === hall.id), rpp?.capacity?.currentA ?? BUSWAY_AMPACITY_A);
}

/** True when every point of the polyline lies inside the hall rectangle (with a small tolerance). */
export function polylineInside(points: readonly Vec3[], hall: Pick<Hall, 'width' | 'depth'>, eps = 1e-3): boolean {
  return points.every((p) => p.x >= -eps && p.y >= -eps && p.x <= hall.width + eps && p.y <= hall.depth + eps);
}

export { rectsOverlap };
