// r4 stream A0 (spec §2.2–2.3, S1): one geometry source per hall. buildHallPrims wraps the geometry that landed in W8:
//   rows        layout/rows.ts rowGroupsFromEquipment (the only row detector, G1)
//   equipment   catalog dims at position / rotation, base z = EquipmentInstance.elevation (G11)
//   trays       project.trays, else the G4 fallback (row tray T1; cross tray 0.45 m + FE 0.3 m at +0.6 + OOB 0.2 m at +1.0, x and y rows)
//   busways     engines/powerPaths.ts resolveBusways (stored, else derived like the power plane), halfW = BUSWAY_W_M / 2 (G3)
//   power plane analysis.power.paths / rooms / penetrations, else buildPowerPlane(project): circuits, feeders, tap-off bars, rooms (G7)
//   sleeves     analysis.power.penetrations + analysis.network.penetrations (else the plane's feeder / partition sleeves)
//   pipes       layout/pipes.ts buildHallPipes → pipePrimsFromNetwork (integration r4): one derivation for the 3D viewer, plans,
//               sections and the 411 iso (HallPrims.pipes carries the full network). Keepout-aware, sized per DN (estimate) (G2).
//               'hall' detail: risers, CDU links, distribution + row headers; 'pod' adds the per-rack branches and every fitting.
//   shell       scene/shell.ts (walls, slab, ceiling, columns, doors, partitions, containment, lights, floor marks)
// Detail 'hall' = model-level prims; 'pod' adds per-rack sub-elements: tap-off boxes, tap-off drop bars and rack cable drops (G5 / G6).
import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect } from '../model/geometry.ts';
import type { Busway, CableTray, EquipmentInstance, Hall, PipeNetwork, PowerPath, PowerRoom, Project, ProjectAnalysis, Rect, RowGroup, Vec3, WallPenetration } from '../model/types.ts';
import { networkRoleSystem, type SystemId } from '../drawings/palette.ts';
import { blockingKeepouts, clipPolyline, rowGroupsFromEquipment, RACK_CATEGORIES_FOR_ROWS } from '../layout/rows.ts';
import { buildPowerPlane, resolveBusways } from '../engines/powerPaths.ts';
import { buildHallPipes } from '../layout/pipes.ts';
import { hallDatums } from './datums.ts';
import type { LayerId } from './layers.ts';
import { emptyHallPrims, GridIndex, primsHash, type HallPrims, type Prim } from './prims.ts';
import { shellPrims } from './shell.ts';

export interface BuildHallPrimsOptions {
  hallId: string;
  /** 'hall' for hall plans (101/111), 'pod' adds per-rack detail (121/301/302/311). Default 'hall'. */
  detail?: HallPrims['detail'];
}

/** busway bar width (m), estimate — the plan stroke and the 3D bar both follow it (G3) */
export const BUSWAY_W_M = 0.17;
/** busway bar height (m), existing viewer */
export const BUSWAY_H_M = 0.13;
/** tray deck z range relative to the stored tray point z (viewer ladder profile / audit box) */
export const TRAY_Z_BELOW_M = 0.006;
export const TRAY_Z_ABOVE_M = 0.09;
/** tray rail allowance added to the stored width (viewer rails / audit box) */
export const TRAY_RAIL_M = 0.012;
/** TCS pipe outer radius (m), existing viewer (OD 0.11) */
export const PIPE_RADIUS_M = 0.055;
/** tap-off box edge (m), existing viewer */
export const TAPOFF_BOX_M = 0.2;
/** per-rack cable drop section (m), existing viewer */
export const RACK_DROP_M = 0.12;
/** power-plane bar sections (m), PowerPath.tsx / layout/wallAudit.ts */
export const CIRCUIT_W_M = 0.07;
export const CIRCUIT_H_M = 0.08;
export const FEEDER_W_M = 0.05;
export const TAPOFF_BAR_W_M = 0.035;
/** electrical room box height cap (m), existing viewer */
export const ROOM_MAX_H_M = 4;

const EPS = 1e-6;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const V = (x: number, y: number, z: number): Vec3 => ({ x: r6(x), y: r6(y), z: r6(z) });
const P = (axis: 'x' | 'y', a: number, c: number, z: number): Vec3 => (axis === 'x' ? V(a, c, z) : V(c, a, z));
const COOLING_UNITS = new Set(['cdu', 'crah', 'fan-wall', 'chiller', 'dry-cooler', 'cooling-tower']);

/**
 * Prim for an axis-aligned (or oblique) segment drawn as a bar of lateral width `w` and height `h` — the same box PowerPath.tsx `seg()`
 * and the wall audit `barBox()` build: vertical segments are w × w, horizontal ones w wide and h high.
 */
function segPrim(base: Omit<Prim, 'shape' | 'a' | 'b' | 'halfW' | 'halfH'>, a: Vec3, b: Vec3, w: number, h: number): Prim {
  // `base` is a fresh object literal at every call site: complete it in place (no spread copy on the hot power-plane loop)
  const p = base as Prim;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const dz = Math.abs(b.z - a.z);
  const vertical = dz > dx && dz > dy;
  p.shape = 'bar';
  p.halfW = w / 2;
  if (vertical && (dx > EPS || dy > EPS)) {
    // mostly vertical with a lateral offset: bound like the viewer (box at the midpoint)
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    p.a = V(cx, cy, Math.min(a.z, b.z));
    p.b = V(cx, cy, Math.max(a.z, b.z));
    p.halfH = w / 2;
  } else if (!vertical && dz > EPS) {
    // sloped horizontal segment: the viewer draws a flat box at the midpoint height
    const zc = (a.z + b.z) / 2;
    p.a = V(a.x, a.y, zc);
    p.b = V(b.x, b.y, zc);
    p.halfH = h / 2;
  } else {
    p.a = V(a.x, a.y, a.z);
    p.b = V(b.x, b.y, b.z);
    p.halfH = vertical ? w / 2 : h / 2;
  }
  return p;
}

const trayLayer = (tier: string): LayerId => (tier === 'T3' ? 'tray-t3' : tier === 'T2' ? 'tray-t2' : 'tray-t1');

/** Tray segment prims (deck −0.006 … +0.09 m, width + rails) of one polyline; vertical segments become drops. */
function trayPrims(out: Prim[], id: string, points: readonly Vec3[], widthM: number, kind: CableTray['kind'] | 'cross', tier: string, system: SystemId, refId: string | undefined, extra: Partial<Prim> = {}) {
  const multi = points.length > 2;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vertical = Math.abs(b.z - a.z) > 1e-4 && Math.abs(b.x - a.x) < 1e-4 && Math.abs(b.y - a.y) < 1e-4;
    const sid = multi ? `${id}/s${i + 1}` : id;
    if (vertical) {
      const w = Math.min(widthM, 0.3);
      out.push({ id: `drop:${sid}`, emitter: 'drop', cls: 'IN-overhead', shape: 'bar', a: V(a.x, a.y, Math.min(a.z, b.z)), b: V(a.x, a.y, Math.max(a.z, b.z)), halfW: w / 2, halfH: w / 2, layer: 'drops', system, tier, ...(refId ? { refId } : {}), ...extra, meta: { kind, widthM } });
      continue;
    }
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
    const w = kind === 'drop' ? Math.min(widthM, 0.3) : widthM;
    const z0 = Math.min(a.z, b.z) - TRAY_Z_BELOW_M;
    const z1 = Math.max(a.z, b.z) + TRAY_Z_ABOVE_M;
    const zc = (z0 + z1) / 2;
    out.push({ id: `tray:${sid}`, emitter: 'tray', cls: 'IN-overhead', shape: 'bar', a: V(a.x, a.y, zc), b: V(b.x, b.y, zc), halfW: r6((w + TRAY_RAIL_M) / 2), halfH: r6((z1 - z0) / 2), layer: trayLayer(tier), system, tier, ...(refId ? { refId } : {}), ...extra, meta: { kind, widthM, deckZ: r6(Math.min(a.z, b.z)) } });
  }
}

interface RowInfo {
  row: RowGroup;
  members: EquipmentInstance[];
  rackH: number;
  liquid: boolean;
}

function rowInfos(rows: readonly RowGroup[], byId: Map<string, EquipmentInstance>): RowInfo[] {
  return rows.map((row) => {
    let rackH = 0;
    let liquid = false;
    const members: EquipmentInstance[] = [];
    for (const id of row.memberIds) {
      const e = byId.get(id);
      const it = e && findCatalogItem(e.catalogId);
      if (!e || !it) continue;
      members.push(e);
      if (RACK_CATEGORIES_FOR_ROWS.has(it.category)) rackH = Math.max(rackH, it.dims.h);
      if (it.category === 'gpu-rack' && (it.cooling?.liquidFraction ?? 0) > 0.5) liquid = true;
    }
    return { row, members, rackH: rackH || 2.3, liquid };
  });
}

/** G4 fallback trays: one rule for sheets and 3D (row tray T1; cross trays at the row ends, FE +0.6 and OOB +1.0; x and y rows). */
export function fallbackTrays(hall: Hall, rows: readonly RowGroup[]): { id: string; points: Vec3[]; widthM: number; kind: CableTray['kind'] | 'cross'; tier: string; system: SystemId; rowId?: string }[] {
  const out: { id: string; points: Vec3[]; widthM: number; kind: CableTray['kind'] | 'cross'; tier: string; system: SystemId; rowId?: string }[] = [];
  const zt = hall.trayHeight > 0 ? hall.trayHeight : 2.9;
  const zc = zt + 0.35;
  const rect: Rect = { x: 0.05, y: 0.05, w: Math.max(0, hall.width - 0.1), d: Math.max(0, hall.depth - 0.1) };
  const blockers = blockingKeepouts(hall.keepouts);
  const emit = (id: string, pts: Vec3[], widthM: number, kind: CableTray['kind'] | 'cross', tier: string, system: SystemId, rowId?: string) => {
    const parts = clipPolyline(pts, rect, blockers);
    parts.forEach((p, i) => out.push({ id: parts.length > 1 ? `${id}-${i + 1}` : id, points: p, widthM, kind, tier, system, ...(rowId ? { rowId } : {}) }));
  };
  for (const axis of ['x', 'y'] as const) {
    const ax = rows.filter((r) => r.axis === axis);
    for (const r of ax) {
      if (r.a1 - r.a0 <= 0) continue;
      const c = r.center + r.frontSign * 0.3;
      emit(`tray-${r.id}`, [P(axis, r.a0, c, zt), P(axis, r.a1, c, zt)], 0.3, 'row', 'T1', 'trays', r.id);
    }
    if (ax.length > 1) {
      const L = axis === 'x' ? hall.width : hall.depth;
      const ac = Math.min(Math.max(...ax.map((r) => r.a1)) + 0.45, L - 0.35);
      const cs = ax.map((r) => r.center + r.frontSign * 0.3);
      const c0 = Math.min(...cs) - 0.15;
      const c1 = Math.max(...cs) + 0.15;
      const cross = (a: number, c: number) => (axis === 'x' ? V(a, c, zc) : V(c, a, zc));
      emit(`tray-cross-${axis}`, [cross(ac, c0), cross(ac, c1)], 0.45, 'cross', 'T2', 'trays');
      emit(`tray-cross-${axis}-fe`, [cross(ac + 0.6, c0), cross(ac + 0.6, c1)], 0.3, 'cross', 'T2', 'frontend');
      emit(`tray-cross-${axis}-oob`, [cross(ac + 1.0, c0), cross(ac + 1.0, c1)], 0.2, 'cross', 'T2', 'oob');
      for (const r of ax) {
        const c = r.center + r.frontSign * 0.3;
        if (ac - 0.22 - r.a1 > 1e-3) emit(`tray-${r.id}-link`, [P(axis, r.a1, c, zt), P(axis, ac - 0.22, c, zt)], 0.3, 'row', 'T1', 'trays', r.id);
      }
    }
  }
  return out;
}

/** Prims of a derived pipe network (layout/pipes.ts buildPipes): one tube per run segment (r = DN / 2 + 5 mm), one point per fitting. */
export function pipePrimsFromNetwork(net: PipeNetwork): Prim[] {
  const out: Prim[] = [];
  const systemOfRun = new Map(net.runs.map((r) => [r.id, r.system]));
  for (const run of net.runs) {
    const r = Math.max(0.02, run.dnMM / 2000 + 0.005);
    for (let i = 0; i < run.points.length - 1; i++) {
      const a = run.points[i];
      const b = run.points[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-6) continue;
      out.push({
        id: `pipe:${run.id}${run.points.length > 2 ? `/s${i + 1}` : ''}`,
        emitter: 'pipe',
        cls: 'IN-overhead',
        shape: 'tube',
        a: V(a.x, a.y, a.z),
        b: V(b.x, b.y, b.z),
        halfW: r6(r),
        halfH: r6(r),
        layer: 'pipes',
        system: run.system === 'tcs-supply' ? 'cdu-supply' : 'cdu-return',
        ...(run.rowId ? { rowId: run.rowId } : {}),
        ...(run.podId ? { podId: run.podId } : {}),
        tag: run.system === 'tcs-supply' ? 'TCS-S' : 'TCS-R',
        meta: {
          kind: run.kind,
          ...(run.part ? { part: run.part } : {}),
          runId: run.id,
          dnMM: run.dnMM,
          odM: r6(2 * r),
          ...(run.flowLpm !== undefined ? { flowLpm: run.flowLpm } : {}),
          source: 'estimate',
          ...(run.loopId ? { loopId: run.loopId } : {}),
        },
      });
    }
  }
  for (const f of net.fittings) {
    const sys = f.runId ? systemOfRun.get(f.runId) : undefined;
    out.push({ id: `fitting:${f.id}`, emitter: 'fitting', cls: 'IN-overhead', shape: 'point', a: V(f.at.x, f.at.y, f.at.z), b: V(f.at.x, f.at.y, f.at.z), halfW: 0.06, halfH: 0.06, layer: 'pipe-fittings', system: sys === 'tcs-return' ? 'cdu-return' : 'cdu-supply', ...(f.equipmentId ? { refId: f.equipmentId } : {}), meta: { kind: f.kind, ...(f.runId ? { runId: f.runId } : {}), source: 'estimate' } });
  }
  return out;
}

const alongOf = (axis: 'x' | 'y', p: { x: number; y: number }) => (axis === 'x' ? p.x : p.y);

export function buildHallPrims(project: Project, analysis: ProjectAnalysis | null, opts: BuildHallPrimsOptions): HallPrims {
  const detail = opts.detail ?? 'hall';
  const hall = project.halls.find((h) => h.id === opts.hallId);
  if (!hall) return emptyHallPrims(opts.hallId, detail);
  const pod = detail === 'pod';
  const prims: Prim[] = [];
  const eq = project.equipment.filter((e) => e.hallId === hall.id);
  const byId = new Map(eq.map((e) => [e.id, e]));
  const rows = rowGroupsFromEquipment(hall.id, eq);
  const infos = rowInfos(rows, byId);
  const rowOf = new Map<string, RowGroup>();
  for (const r of rows) for (const id of r.memberIds) rowOf.set(id, r);

  // ── equipment ──
  const tagCount = new Map<string, number>();
  for (const e of eq) tagCount.set(e.tag, (tagCount.get(e.tag) ?? 0) + 1);
  const position = new Map<string, number>();
  for (const info of infos) {
    const racks = info.members.filter((e) => RACK_CATEGORIES_FOR_ROWS.has(findCatalogItem(e.catalogId)!.category));
    racks.sort((p, q) => alongOf(info.row.axis, p.position) - alongOf(info.row.axis, q.position) || p.id.localeCompare(q.id)).forEach((e, i) => position.set(e.id, i + 1));
  }
  for (const e of eq) {
    const it = findCatalogItem(e.catalogId);
    if (!it || it.category === 'switch' || it.category === 'nic') continue;
    const f = footprintRect(it.dims, e.position, e.rotationDeg);
    const z0 = e.elevation ?? 0;
    const isRack = RACK_CATEGORIES_FOR_ROWS.has(it.category);
    const row = rowOf.get(e.id);
    const emitter = isRack ? 'rack' : 'unit';
    const key = e.tag && tagCount.get(e.tag) === 1 ? e.tag : e.id;
    const meta: Record<string, string | number | boolean> = {};
    for (const [k, val] of Object.entries(e.meta ?? {})) if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') meta[k] = val;
    meta.category = it.category;
    meta.catalogId = it.id;
    meta.rotationDeg = e.rotationDeg;
    if (z0) meta.elevation = z0;
    if (row) meta.frontSign = row.frontSign;
    const pos = position.get(e.id);
    if (pos !== undefined) meta.position = pos;
    if (it.category === 'gpu-rack') meta.liquid = (it.cooling?.liquidFraction ?? 0) > 0.5;
    const system: Prim['system'] = isRack ? (it.category === 'network-rack' ? networkRoleSystem(e.networkRole) : 'it') : it.category === 'cdu' ? 'cdu-supply' : COOLING_UNITS.has(it.category) ? 'supply-air' : 'arch';
    prims.push({
      id: `${emitter}:${key}`,
      emitter,
      cls: 'IN-floor',
      shape: 'box',
      a: V(f.x, f.y, z0),
      b: V(f.x + f.w, f.y + f.d, z0 + it.dims.h),
      halfW: 0,
      halfH: 0,
      layer: isRack ? 'racks' : COOLING_UNITS.has(it.category) ? 'cdu-crah' : 'racks',
      refId: e.id,
      system,
      ...(e.podId ? { podId: e.podId } : {}),
      ...(row ? { rowId: row.id } : {}),
      ...(e.tag ? { tag: e.tag } : {}),
      meta,
    });
  }

  // ── trays (stored, else the G4 fallback) ──
  const stored = (project.trays ?? []).filter((t) => t.hallId === hall.id && t.points.length >= 2);
  const trayRowOf = new Map<string, string>();
  for (const r of rows) trayRowOf.set(`tray-${r.id}`, r.id);
  if (stored.length) {
    for (const t of stored) {
      const tier = t.kind === 'main' ? 'T2' : 'T1';
      const rowId = trayRowOf.get(t.id) ?? (/^drop-(.+)-main$/.exec(t.id)?.[1] ?? undefined);
      trayPrims(prims, t.id, t.points, t.widthM > 0 ? t.widthM : 0.3, t.kind, tier, 'trays', t.id, rowId && rows.some((r) => r.id === rowId) ? { rowId, podId: rows.find((r) => r.id === rowId)!.podId } : {});
    }
  } else {
    for (const t of fallbackTrays(hall, rows)) {
      const row = t.rowId ? rows.find((r) => r.id === t.rowId) : undefined;
      trayPrims(prims, t.id, t.points, t.widthM, t.kind, t.tier, t.system, undefined, row ? { rowId: row.id, ...(row.podId ? { podId: row.podId } : {}) } : {});
    }
  }

  // ── busways + tap-off boxes ──
  const busways: Busway[] = resolveBusways(project).filter((b) => b.hallId === hall.id && b.points.length >= 2);
  const tapSeen = new Set<string>();
  for (const b of busways) {
    const side = b.path;
    const system: SystemId = side === 'A' ? 'busway-a' : 'busway-b';
    const layer: LayerId = side === 'A' ? 'busway-a' : 'busway-b';
    const firstTap = b.tapoffs.map((t) => rowOf.get(t.equipmentId)).find(Boolean);
    const row = firstTap ?? rows.find((r) => b.id.endsWith(r.id) || b.id.includes(`-${r.id}`));
    const rowExtra = row ? { rowId: row.id, ...(row.podId ? { podId: row.podId } : {}) } : {};
    const multi = b.points.length > 2;
    for (let i = 0; i < b.points.length - 1; i++) {
      const p = b.points[i];
      const q = b.points[i + 1];
      if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-6) continue;
      prims.push({ id: `busway:${b.id}${multi ? `/s${i + 1}` : ''}`, emitter: 'busway', cls: 'IN-overhead', shape: 'bar', a: V(p.x, p.y, p.z), b: V(q.x, q.y, q.z), halfW: BUSWAY_W_M / 2, halfH: BUSWAY_H_M / 2, layer, refId: b.id, system, tag: `BW-${side}`, ...rowExtra, meta: { side, ampacityA: b.ampacityA, source: 'estimate' } });
    }
    if (!pod) continue;
    // tap-off boxes on the busway line at each rack, below the bar (both sides)
    const bAxis: 'x' | 'y' = Math.abs(b.points[b.points.length - 1].x - b.points[0].x) >= Math.abs(b.points[b.points.length - 1].y - b.points[0].y) ? 'x' : 'y';
    const aVals = b.points.map((pt) => alongOf(bAxis, pt));
    const aMin = Math.min(...aVals);
    const aMax = Math.max(...aVals);
    const c = bAxis === 'x' ? b.points[0].y : b.points[0].x;
    const z = b.points[0].z;
    for (const t of b.tapoffs) {
      const at = alongOf(bAxis, t);
      if (at < aMin - 0.05 || at > aMax + 0.05) continue;
      const key = `${side}|${t.equipmentId}`;
      if (tapSeen.has(key)) continue;
      tapSeen.add(key);
      const h = TAPOFF_BOX_M / 2;
      const e = byId.get(t.equipmentId);
      const tag = e?.tag;
      prims.push({
        id: `tapoff:${b.id}@${tag && tagCount.get(tag) === 1 ? tag : t.equipmentId}`,
        emitter: 'tapoff',
        cls: 'IN-overhead',
        shape: 'box',
        a: P(bAxis, at - h, c - h, z - 0.16 - h),
        b: P(bAxis, at + h, c + h, z - 0.16 + h),
        halfW: 0,
        halfH: 0,
        layer: 'tapoffs',
        refId: b.id,
        system,
        ...(rowOf.get(t.equipmentId) ? { rowId: rowOf.get(t.equipmentId)!.id } : {}),
        ...(e?.podId ? { podId: e.podId } : {}),
        ...(tag ? { tag: `TO-${tag}-${side}` } : {}),
        meta: { side, equipmentId: t.equipmentId },
      });
    }
  }

  // ── power plane: circuits, feeders, tap-off drops, rooms; sleeves ──
  let paths: PowerPath[] | undefined = analysis?.power.paths?.length ? analysis.power.paths : undefined;
  let rooms: PowerRoom[] | undefined = analysis?.power.rooms;
  let pens: WallPenetration[] = analysis ? [...(analysis.power.penetrations ?? []), ...(analysis.network.penetrations ?? [])] : [];
  if (!paths) {
    const plane = buildPowerPlane(project, analysis);
    paths = plane.paths;
    rooms = rooms ?? plane.rooms;
    if (!analysis) pens = plane.penetrations;
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));
  for (const p of paths) {
    if (p.hallId !== hall.id) continue;
    if (p.kind === 'tapoff' && !pod) continue;
    const side = p.side ?? 'A';
    const system: SystemId = side === 'A' ? 'busway-a' : 'busway-b';
    const row = p.rowId ? rowById.get(p.rowId) : undefined;
    const emitter = p.kind === 'busway' ? 'circuit' : p.kind === 'feeder' ? 'feeder' : 'tapoff';
    const layer: LayerId = emitter === 'circuit' ? 'circuits' : emitter === 'feeder' ? 'feeders' : 'tapoffs';
    const cls: Prim['cls'] = emitter === 'feeder' ? 'PEN' : 'IN-overhead';
    const w = emitter === 'circuit' ? CIRCUIT_W_M : emitter === 'feeder' ? FEEDER_W_M : TAPOFF_BAR_W_M;
    const h = emitter === 'circuit' ? CIRCUIT_H_M : w;
    const tag = p.circuit ? `${p.buswayId ?? ''}/c${p.circuit}` : undefined;
    const multi = p.points.length > 2;
    for (let i = 0; i < p.points.length - 1; i++) {
      const a = p.points[i];
      const b = p.points[i + 1];
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-6) continue;
      const prim = segPrim({ id: multi ? `${emitter}:${p.id}/s${i + 1}` : `${emitter}:${p.id}`, emitter, cls, layer, refId: p.id, system }, a, b, w, h);
      if (row) {
        prim.rowId = row.id;
        if (row.podId) prim.podId = row.podId;
      }
      if (tag) prim.tag = tag;
      const meta: Record<string, string | number | boolean> = { side };
      if (p.buswayId) meta.buswayId = p.buswayId;
      if (p.circuit) meta.circuit = p.circuit;
      meta.fromId = p.fromId;
      meta.toId = p.toId;
      prim.meta = meta;
      prims.push(prim);
    }
  }
  const roomH = Math.min(hall.clearHeight, ROOM_MAX_H_M);
  for (const r of rooms ?? []) {
    if (r.hallId !== hall.id) continue;
    prims.push({ id: `room:${r.id}`, emitter: 'room', cls: 'EXEMPT', shape: 'box', a: V(r.rect.x, r.rect.y, 0), b: V(r.rect.x + r.rect.w, r.rect.y + r.rect.d, roomH), halfW: 0, halfH: 0, layer: 'electrical-rooms', refId: r.id, system: r.side === 'A' ? 'busway-a' : 'busway-b', tag: `SWBD ${r.side}`, meta: { kind: 'electrical-room', side: r.side, switchboardId: r.switchboardId, ...(r.wall ? { wall: r.wall } : {}) } });
  }
  const penSeen = new Set<string>();
  for (const p of pens) {
    if (p.hallId !== hall.id || penSeen.has(p.id)) continue;
    penSeen.add(p.id);
    const ac = (p.along[0] + p.along[1]) / 2;
    const la = Math.max(0.05, p.along[1] - p.along[0]);
    const z0 = p.z[0];
    const z1 = Math.max(p.z[0] + 0.05, p.z[1]);
    let a: Vec3;
    let b: Vec3;
    const slab = 0.36;
    if (p.wall === 'partition') {
      if (p.plane === undefined || !p.planeAxis) continue;
      a = p.planeAxis === 'x' ? V(ac - la / 2, p.plane - 0.13, z0) : V(p.plane - 0.13, ac - la / 2, z0);
      b = p.planeAxis === 'x' ? V(ac + la / 2, p.plane + 0.13, z1) : V(p.plane + 0.13, ac + la / 2, z1);
    } else if (p.wall === 'W' || p.wall === 'E') {
      const xc = p.wall === 'W' ? -0.15 : hall.width + 0.15;
      a = V(xc - slab / 2, ac - la / 2, z0);
      b = V(xc + slab / 2, ac + la / 2, z1);
    } else {
      const yc = p.wall === 'S' ? -0.15 : hall.depth + 0.15;
      a = V(ac - la / 2, yc - slab / 2, z0);
      b = V(ac + la / 2, yc + slab / 2, z1);
    }
    prims.push({ id: `sleeve:${p.id}`, emitter: 'sleeve', cls: 'PEN', shape: 'box', a, b, halfW: 0, halfH: 0, layer: 'sleeves', refId: p.id, system: p.kind === 'feeder-sleeve' ? 'busway-a' : 'arch', meta: { kind: p.kind, wall: p.wall, targetId: p.targetId, ...(p.runs !== undefined ? { runs: p.runs } : {}) } });
  }

  // ── pipes: layout/pipes.ts derived network (G2; integration r4 — the viewer, plans, sections and 411 read this one derivation) ──
  const pipes = buildHallPipes(project, hall, rows);
  prims.push(...pipePrimsFromNetwork(pod ? pipes : { ...pipes, runs: pipes.runs.filter((r) => r.kind !== 'branch'), fittings: [] }));

  // ── per-rack cable drops (pod detail, G5): row tray → rack top ──
  if (pod) {
    const zt = hall.trayHeight;
    for (const info of infos) {
      const r = info.row;
      const trayC = r.center + r.frontSign * 0.3;
      for (const e of info.members) {
        const it = findCatalogItem(e.catalogId);
        if (!it || !RACK_CATEGORIES_FOR_ROWS.has(it.category)) continue;
        const top = (e.elevation ?? 0) + it.dims.h;
        if (zt - top < 0.05) continue;
        const a = alongOf(r.axis, e.position);
        const key = e.tag && tagCount.get(e.tag) === 1 ? e.tag : e.id;
        prims.push({ id: `drop:rack@${key}`, emitter: 'drop', cls: 'IN-overhead', shape: 'bar', a: P(r.axis, a, trayC, top), b: P(r.axis, a, trayC, zt), halfW: RACK_DROP_M / 2, halfH: RACK_DROP_M / 2, layer: 'drops', refId: e.id, system: 'trays', tier: 'T1', rowId: r.id, ...(r.podId ? { podId: r.podId } : {}), meta: { kind: 'rack-drop' } });
      }
    }
  }

  // ── shell ──
  prims.push(...shellPrims(hall, project));

  // unique ids (deterministic suffix on a collision)
  const seen = new Map<string, number>();
  for (const p of prims) {
    const n = seen.get(p.id);
    if (n === undefined) seen.set(p.id, 1);
    else {
      seen.set(p.id, n + 1);
      p.id = `${p.id}~${n + 1}`;
    }
  }
  const datums = hallDatums(hall, prims, hall.verticals);
  return { hallId: hall.id, detail, prims, index: GridIndex.build(prims), datums, rows, hash: primsHash(prims), pipes };
}
