// r4 stream A0 (spec §2.1 G8–G10): architectural shell prims of one hall. Pure and deterministic.
//   walls        0.30 m slabs outside the hall rectangle (existing viewer / USD convention), height clearHeight + ceilingPlenumHeight,
//                split around room doors (a header box above each door)
//   slab         graphic slab under hall + walls, thickness Hall.verticals.slabThicknessM ?? 0.30 (estimate)
//   ceiling      plane at clearHeight (existing); deck plane at clearHeight + ceilingPlenumHeight when a plenum exists
//   columns      column / shaft keepouts, floor to deck
//   doors        'door' keepouts as openings through the nearest wall; Keepout.door defaults: leaves 2 if opening ≥ 1.2 m else 1,
//                swing 'in', clear height 2.4 m (estimate; 2.4 existing in export/layout.ts)
//   partitions   separate-room partitions to the clear height, closed to both walls (layout/geometry3d.ts partitionWalls, D4)
//   containment  side blanking panels, roof or ducted chimney (top = max(h + 0.3, clearHeight), existing viewer rule), end doors
//                per Containment.doorType (default 'sliding', existing viewer)
//   lights       continuous fixture strips over open aisles at clamp(max(2.6, trayHeight), 2.6, clearHeight − 0.2) (TIA-942-B)
//   floor marks  hall outline, egress / ramp / other keepouts, reserve positions (planes at z = 0)
import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect } from '../model/geometry.ts';
import type { Containment, EquipmentInstance, Hall, Keepout, KeepoutDoor, Project } from '../model/types.ts';
import { partitionWalls } from '../layout/geometry3d.ts';
import { blockingKeepouts, rowGroupsFromEquipment } from '../layout/rows.ts';
import type { Prim } from './prims.ts';

/** wall slab thickness (m), existing viewer / USD convention */
export const WALL_THICKNESS_M = 0.3;
/** default graphic slab thickness (m), estimate */
export const DEFAULT_SLAB_THICKNESS_M = 0.3;
/** default room door clear height (m), existing (export/layout.ts) */
export const DEFAULT_DOOR_CLEAR_HEIGHT_M = 2.4;
/** containment frame section (m), existing viewer */
export const CONTAINMENT_FRAME_M = 0.05;

const v = (x: number, y: number, z: number) => ({ x, y, z });
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Resolved door data of a 'door' keepout (defaults tagged estimate). */
export function keepoutDoor(k: Keepout): KeepoutDoor & { clearHeightM: number; source: 'existing' | 'estimate' } {
  const opening = Math.max(k.rect.w, k.rect.d);
  if (k.door) return { leaves: k.door.leaves, swing: k.door.swing, clearHeightM: k.door.clearHeightM ?? DEFAULT_DOOR_CLEAR_HEIGHT_M, source: 'existing' };
  return { leaves: opening >= 1.2 ? 2 : 1, swing: 'in', clearHeightM: DEFAULT_DOOR_CLEAR_HEIGHT_M, source: 'estimate' };
}

/** Wall a keepout rectangle sits against (nearest wall of the hall rectangle). */
export function keepoutWall(hall: Hall, k: Keepout): 'N' | 'S' | 'E' | 'W' {
  const { x, y, w, d } = k.rect;
  const cand: ['N' | 'S' | 'E' | 'W', number][] = [
    ['W', x],
    ['E', hall.width - (x + w)],
    ['S', y],
    ['N', hall.depth - (y + d)],
  ];
  return cand.reduce((p, q) => (q[1] < p[1] - 1e-9 ? q : p))[0];
}

/** V2 mounting height of the fixture strips (existing viewer rule, TIA-942-B §6.4.2.4). */
export function fixtureHeight(hall: Hall): number {
  return Math.min(Math.max(2.6, hall.trayHeight), Math.max(2.6, hall.clearHeight - 0.2));
}

const RACK_CATS = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);

/** Dominant row axis from the rack rotations (0/180 → rows along X); falls back to the layout policy, then the long side. */
export function dominantRowAxis(hall: Hall, items: readonly EquipmentInstance[]): 'x' | 'y' {
  let x = 0;
  let y = 0;
  for (const e of items) {
    const it = findCatalogItem(e.catalogId);
    if (!it || !RACK_CATS.has(it.category)) continue;
    if (e.rotationDeg % 180 === 0) x++;
    else y++;
  }
  if (x || y) return x >= y ? 'x' : 'y';
  return hall.layoutPolicy?.orientation ?? (hall.width >= hall.depth ? 'x' : 'y');
}

export interface AisleStrip {
  axis: 'x' | 'y';
  a0: number;
  a1: number;
  c: number;
  kind: 'aisle' | 'perimeter' | 'cross';
}

const INSET_M = 0.3;

/**
 * Continuous fixture strips over the open aisles (V1). Moved from apps/web/src/viewer/Hall.tsx (identical rule) so the viewer and the
 * 2D projections read one list.
 */
export function aisleStrips(hall: Hall, items: readonly EquipmentInstance[], containments: readonly Containment[] = []): AisleStrip[] {
  const axis = dominantRowAxis(hall, items);
  const other: 'x' | 'y' = axis === 'x' ? 'y' : 'x';
  const along = axis === 'x' ? hall.width : hall.depth;
  const across = axis === 'x' ? hall.depth : hall.width;
  const byId = new Map(items.map((e) => [e.id, e]));
  const rows = rowGroupsFromEquipment(hall.id, items).filter((r) => r.axis === axis);
  const out: AisleStrip[] = [];
  if (!rows.length) {
    const la = hall.width >= hall.depth ? 'x' : 'y';
    const L = la === 'x' ? hall.width : hall.depth;
    const M = la === 'x' ? hall.depth : hall.width;
    for (let c = 1.2; c < M - 0.6; c += 2.4) out.push({ axis: la, a0: 0.6, a1: L - 0.6, c, kind: 'aisle' });
    return out;
  }
  const bands = rows
    .map((r) => {
      let c0 = Infinity;
      let c1 = -Infinity;
      for (const id of r.memberIds) {
        const e = byId.get(id);
        const it = e && findCatalogItem(e.catalogId);
        if (!e || !it) continue;
        const f = footprintRect(it.dims, e.position, e.rotationDeg);
        c0 = Math.min(c0, axis === 'x' ? f.y : f.x);
        c1 = Math.max(c1, axis === 'x' ? f.y + f.d : f.x + f.w);
      }
      return { a0: r.a0, a1: r.a1, c0, c1 };
    })
    .filter((b) => Number.isFinite(b.c0))
    .sort((p, q) => p.a0 - q.a0 || p.c0 - q.c0);
  const cols: { a0: number; a1: number; rows: typeof bands }[] = [];
  for (const b of bands) {
    const col = cols.find((c) => b.a0 < c.a1 - INSET_M && b.a1 > c.a0 + INSET_M);
    if (col) {
      col.rows.push(b);
      col.a0 = Math.min(col.a0, b.a0);
      col.a1 = Math.max(col.a1, b.a1);
    } else cols.push({ a0: b.a0, a1: b.a1, rows: [b] });
  }
  const contained = (a: number, c: number) =>
    containments.some((ct) => ct.hallId === hall.id && (axis === 'x' ? a > ct.rect.x && a < ct.rect.x + ct.rect.w && c > ct.rect.y && c < ct.rect.y + ct.rect.d : a > ct.rect.y && a < ct.rect.y + ct.rect.d && c > ct.rect.x && c < ct.rect.x + ct.rect.w));
  for (const col of cols) {
    const rs = [...col.rows].sort((p, q) => p.c0 - q.c0);
    const merged: { c0: number; c1: number }[] = [];
    for (const r of rs) {
      const last = merged[merged.length - 1];
      if (last && r.c0 < last.c1 - 0.05) last.c1 = Math.max(last.c1, r.c1);
      else merged.push({ c0: r.c0, c1: r.c1 });
    }
    const a0 = col.a0 + INSET_M;
    const a1 = col.a1 - INSET_M;
    const mid = (col.a0 + col.a1) / 2;
    if (a1 <= a0) continue;
    for (let i = 0; i + 1 < merged.length; i++) {
      const gap = merged[i + 1].c0 - merged[i].c1;
      const c = (merged[i].c1 + merged[i + 1].c0) / 2;
      if (gap >= 0.9 && !contained(mid, c)) out.push({ axis, a0, a1, c, kind: 'aisle' });
    }
    const first = merged[0];
    const last = merged[merged.length - 1];
    if (first.c0 >= 1.4 && !contained(mid, first.c0 - 0.5)) out.push({ axis, a0, a1, c: first.c0 - Math.min(first.c0 / 2, 0.9), kind: 'perimeter' });
    if (across - last.c1 >= 1.4 && !contained(mid, last.c1 + 0.5)) out.push({ axis, a0, a1, c: last.c1 + Math.min((across - last.c1) / 2, 0.9), kind: 'perimeter' });
  }
  const sorted = [...cols].sort((p, q) => p.a0 - q.a0);
  const cMin = Math.min(...bands.map((b) => b.c0)) + INSET_M;
  const cMax = Math.max(...bands.map((b) => b.c1)) - INSET_M;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const gap = sorted[i + 1].a0 - sorted[i].a1;
    if (gap >= 1.5 && cMax > cMin) out.push({ axis: other, a0: cMin, a1: cMax, c: sorted[i].a1 + Math.max(gap / 2, 0.95), kind: 'cross' });
  }
  const lastCol = sorted[sorted.length - 1];
  if (lastCol && along - lastCol.a1 >= 2.5 && cMax > cMin) out.push({ axis: other, a0: cMin, a1: cMax, c: lastCol.a1 + Math.min((along - lastCol.a1) / 2, 1.5), kind: 'cross' });
  if (sorted[0] && sorted[0].a0 >= 2.5 && cMax > cMin) out.push({ axis: other, a0: cMin, a1: cMax, c: sorted[0].a0 - Math.min(sorted[0].a0 / 2, 1.5), kind: 'cross' });
  const blockers = blockingKeepouts(hall.keepouts, 0.1);
  const cut: AisleStrip[] = [];
  for (const st of out) {
    const hits = blockers
      .filter((b) => (st.axis === 'x' ? b.y < st.c + 0.04 && b.y + b.d > st.c - 0.04 : b.x < st.c + 0.04 && b.x + b.w > st.c - 0.04))
      .map((b) => (st.axis === 'x' ? [b.x, b.x + b.w] : [b.y, b.y + b.d]) as [number, number])
      .sort((p, q) => p[0] - q[0]);
    let a = st.a0;
    for (const [b0, b1] of hits) {
      if (b1 <= a || b0 >= st.a1) continue;
      if (b0 - a > 0.3) cut.push({ ...st, a0: a, a1: b0 });
      a = Math.max(a, b1);
    }
    if (st.a1 - a > 0.3) cut.push({ ...st, a0: a, a1: st.a1 });
  }
  return cut;
}

/** Containment prims (G8): side blanking, roof or chimney + transoms, end doors per doorType. */
export function containmentPrims(c: Containment, hall: Hall): Prim[] {
  const out: Prim[] = [];
  const { x, y, w, d } = c.rect;
  const h = c.height;
  const top = c.ductedToPlenum ? Math.max(h + 0.3, hall.clearHeight) : h;
  const axis: 'x' | 'y' = w >= d ? 'x' : 'y';
  const a0 = axis === 'x' ? x : y;
  const a1 = a0 + (axis === 'x' ? w : d);
  const p0 = axis === 'x' ? y : x;
  const p1 = p0 + (axis === 'x' ? d : w);
  // along a, across p → plan box
  const box = (aa0: number, aa1: number, pp0: number, pp1: number, z0: number, z1: number) =>
    axis === 'x' ? { a: v(r6(aa0), r6(pp0), r6(z0)), b: v(r6(aa1), r6(pp1), r6(z1)) } : { a: v(r6(pp0), r6(aa0), r6(z0)), b: v(r6(pp1), r6(aa1), r6(z1)) };
  const base = { cls: 'IN-floor' as const, halfW: 0, halfH: 0, refId: c.id, system: 'arch' as const, ...(c.podId ? { podId: c.podId } : {}) };
  const meta = { kind: c.kind, axis, ducted: c.ductedToPlenum, height: h, top };
  // blanking / side panels behind the rack line on both long edges (viewer: 0.02 m at ±0.05 m outside the aisle rect)
  out.push({ ...base, id: `containment-panel:${c.id}#side0`, emitter: 'containment-panel', shape: 'box', ...box(a0, a1, p0 - 0.06, p0 - 0.04, 0, h), layer: 'containment', meta });
  out.push({ ...base, id: `containment-panel:${c.id}#side1`, emitter: 'containment-panel', shape: 'box', ...box(a0, a1, p1 + 0.04, p1 + 0.06, 0, h), layer: 'containment', meta });
  if (c.ductedToPlenum && top > h + 1e-6) {
    out.push({ ...base, cls: 'IN-overhead', id: `containment-roof:${c.id}#chimney0`, emitter: 'containment-roof', shape: 'box', ...box(a0, a1, p0 - 0.025, p0 + 0.025, h, top), layer: 'containment-roof', meta: { ...meta, part: 'chimney' } });
    out.push({ ...base, cls: 'IN-overhead', id: `containment-roof:${c.id}#chimney1`, emitter: 'containment-roof', shape: 'box', ...box(a0, a1, p1 - 0.025, p1 + 0.025, h, top), layer: 'containment-roof', meta: { ...meta, part: 'chimney' } });
    if (c.endDoors) {
      out.push({ ...base, cls: 'IN-overhead', id: `containment-roof:${c.id}#transom0`, emitter: 'containment-roof', shape: 'box', ...box(a0 - 0.025, a0 + 0.025, p0, p1, h, top), layer: 'containment-roof', meta: { ...meta, part: 'transom' } });
      out.push({ ...base, cls: 'IN-overhead', id: `containment-roof:${c.id}#transom1`, emitter: 'containment-roof', shape: 'box', ...box(a1 - 0.025, a1 + 0.025, p0, p1, h, top), layer: 'containment-roof', meta: { ...meta, part: 'transom' } });
    }
  } else if (c.roof) {
    out.push({ ...base, cls: 'IN-overhead', id: `containment-roof:${c.id}`, emitter: 'containment-roof', shape: 'box', ...box(a0, a1, p0, p1, h, h + 0.04), layer: 'containment-roof', meta: { ...meta, part: 'roof' } });
  }
  if (c.endDoors) {
    const doorType = c.doorType ?? 'sliding';
    ([[0, a0], [1, a1]] as const).forEach(([end, ae]) => {
      out.push({
        ...base,
        id: `door:${c.id}#end${end}`,
        emitter: 'door',
        shape: 'box',
        ...box(ae - CONTAINMENT_FRAME_M / 2, ae + CONTAINMENT_FRAME_M / 2, p0, p1, 0, h),
        layer: 'containment-doors',
        meta: { doorType, end, leaves: 2, axis, headZ: r6(h - 0.1), source: c.doorType ? 'existing' : 'estimate' },
      });
    });
  }
  return out;
}

/** Shell prims of one hall (walls, slab, ceiling, columns, doors, partitions, containment, lights, floor marks). */
export function shellPrims(hall: Hall, project: Project): Prim[] {
  const out: Prim[] = [];
  const W = hall.width;
  const D = hall.depth;
  const T = WALL_THICKNESS_M;
  const Hc = hall.clearHeight;
  const Ht = hall.clearHeight + Math.max(0, hall.ceilingPlenumHeight);
  const slabT = hall.verticals?.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M;
  const arch = { system: 'arch' as const, halfW: 0, halfH: 0 };
  const hid = hall.id;
  if (!(W > 0 && D > 0)) return out;

  // floor marks + slab + ceiling
  out.push({ ...arch, id: `room:${hid}#outline`, emitter: 'room', cls: 'EXEMPT', shape: 'plane', a: v(0, 0, 0), b: v(W, D, 0), layer: 'hall-outline', meta: { kind: 'hall' } });
  out.push({ ...arch, id: `slab:${hid}`, emitter: 'slab', cls: 'EXEMPT', shape: 'box', a: v(-T, -T, r6(-slabT)), b: v(r6(W + T), r6(D + T), 0), layer: 'slab', meta: { thicknessM: slabT, source: hall.verticals?.slabThicknessM !== undefined ? 'existing' : 'estimate' } });
  if (hall.raisedFloorHeight > 0) out.push({ ...arch, id: `slab:${hid}#raised-floor`, emitter: 'slab', cls: 'EXEMPT', shape: 'plane', a: v(0, 0, hall.raisedFloorHeight), b: v(W, D, hall.raisedFloorHeight), layer: 'slab', meta: { kind: 'raised-floor' } });
  out.push({ ...arch, id: `ceiling:${hid}`, emitter: 'ceiling', cls: 'EXEMPT', shape: 'plane', a: v(0, 0, Hc), b: v(W, D, Hc), layer: 'ceiling', meta: { kind: 'ceiling' } });
  if (hall.ceilingPlenumHeight > 0) out.push({ ...arch, id: `ceiling:${hid}#deck`, emitter: 'ceiling', cls: 'EXEMPT', shape: 'plane', a: v(0, 0, Ht), b: v(W, D, Ht), layer: 'ceiling', meta: { kind: 'deck' } });

  // doors (room doors in the wall slab) and walls split around them
  const doorsByWall: Record<'N' | 'S' | 'E' | 'W', { k: Keepout; s0: number; s1: number; zh: number }[]> = { N: [], S: [], E: [], W: [] };
  for (const k of hall.keepouts) {
    if (k.kind !== 'door') continue;
    const wall = keepoutWall(hall, k);
    const dd = keepoutDoor(k);
    const alongY = wall === 'W' || wall === 'E';
    const s0 = Math.max(0, alongY ? k.rect.y : k.rect.x);
    const s1 = Math.min(alongY ? D : W, alongY ? k.rect.y + k.rect.d : k.rect.x + k.rect.w);
    if (s1 - s0 < 0.05) continue;
    const zh = Math.min(dd.clearHeightM, Ht);
    doorsByWall[wall].push({ k, s0, s1, zh });
    const [x0, x1] = wall === 'W' ? [-T, 0] : wall === 'E' ? [W, W + T] : [s0, s1];
    const [y0, y1] = wall === 'S' ? [-T, 0] : wall === 'N' ? [D, D + T] : [s0, s1];
    out.push({
      ...arch,
      id: `door:${k.id}`,
      emitter: 'door',
      cls: 'PEN',
      shape: 'box',
      a: v(r6(x0), r6(y0), 0),
      b: v(r6(x1), r6(y1), r6(zh)),
      layer: 'doors',
      refId: k.id,
      ...(k.label ? { tag: k.label } : {}),
      meta: { wall, leaves: dd.leaves, swing: dd.swing, clearHeightM: dd.clearHeightM, widthM: r6(s1 - s0), source: dd.source },
    });
  }
  const walls: ['S' | 'N' | 'W' | 'E', number, number][] = [
    ['S', -T, W + T],
    ['N', -T, W + T],
    ['W', 0, D],
    ['E', 0, D],
  ];
  for (const [side, s0, s1] of walls) {
    const openings = doorsByWall[side].sort((p, q) => p.s0 - q.s0);
    const rect = (a0: number, a1: number): [number, number, number, number] =>
      side === 'S' ? [a0, -T, a1, 0] : side === 'N' ? [a0, D, a1, D + T] : side === 'W' ? [-T, a0, 0, a1] : [W, a0, W + T, a1];
    const spans: [number, number][] = [];
    let cur = s0;
    for (const o of openings) {
      if (o.s0 > cur + 1e-6) spans.push([cur, o.s0]);
      cur = Math.max(cur, o.s1);
    }
    if (s1 > cur + 1e-6) spans.push([cur, s1]);
    spans.forEach(([a0, a1], i) => {
      const [x0, y0, x1, y1] = rect(a0, a1);
      out.push({ ...arch, id: spans.length === 1 && !openings.length ? `wall:${hid}#${side}` : `wall:${hid}#${side}${i + 1}`, emitter: 'wall', cls: 'EXEMPT', shape: 'box', a: v(r6(x0), r6(y0), 0), b: v(r6(x1), r6(y1), r6(Ht)), layer: 'walls', tag: side, meta: { wall: side, thicknessM: T } });
    });
    for (const o of openings) {
      if (o.zh >= Ht - 1e-6) continue;
      const [x0, y0, x1, y1] = rect(o.s0, o.s1);
      out.push({ ...arch, id: `wall:${hid}#${side}-head-${o.k.id}`, emitter: 'wall', cls: 'EXEMPT', shape: 'box', a: v(r6(x0), r6(y0), r6(o.zh)), b: v(r6(x1), r6(y1), r6(Ht)), layer: 'walls', tag: side, meta: { wall: side, thicknessM: T, head: o.k.id } });
    }
  }

  // columns / shafts, egress and other floor keepouts
  for (const k of hall.keepouts) {
    const { x, y, w, d } = k.rect;
    if (k.kind === 'column' || k.kind === 'shaft') {
      out.push({ ...arch, id: `column:${k.id}`, emitter: 'column', cls: 'IN-floor', shape: 'box', a: v(r6(x), r6(y), 0), b: v(r6(x + w), r6(y + d), r6(Ht)), layer: 'columns', refId: k.id, ...(k.label ? { tag: k.label } : {}), meta: { kind: k.kind } });
    } else if (k.kind !== 'door') {
      out.push({ ...arch, id: `room:${k.id}`, emitter: 'room', cls: 'EXEMPT', shape: 'plane', a: v(r6(Math.max(0, x)), r6(Math.max(0, y)), 0), b: v(r6(Math.min(W, x + w)), r6(Math.min(D, y + d)), 0), layer: 'egress', refId: k.id, ...(k.label ? { tag: k.label } : {}), meta: { kind: k.kind } });
    }
  }

  const eq = project.equipment.filter((e) => e.hallId === hid);
  // separate-room partitions (to the clear height, closed against both walls)
  for (const pw of partitionWalls(hall, project.reservations, eq)) {
    pw.spans.forEach(([a0, a1], i) => {
      const a = pw.axis === 'x' ? v(r6(a0), r6(pw.c0), 0) : v(r6(pw.c0), r6(a0), 0);
      const b = pw.axis === 'x' ? v(r6(a1), r6(pw.c1), r6(pw.height)) : v(r6(pw.c1), r6(a1), r6(pw.height));
      out.push({ ...arch, id: `partition:${pw.id}#${i + 1}`, emitter: 'partition', cls: 'EXEMPT', shape: 'box', a, b, layer: 'partitions', refId: pw.reservationId, meta: { axis: pw.axis } });
    });
  }
  // reserve positions (floor marks)
  for (const r of project.reservations ?? []) {
    if (r.hallId !== hid || r.kind !== 'reserve') continue;
    out.push({ ...arch, id: `room:${r.id}`, emitter: 'room', cls: 'EXEMPT', shape: 'plane', a: v(r6(r.rect.x), r6(r.rect.y), 0), b: v(r6(r.rect.x + r.rect.w), r6(r.rect.y + r.rect.d), 0), layer: 'reserves', refId: r.id, meta: { kind: 'reserve', positions: r.positions, axis: r.axis } });
  }

  // containment
  const conts = project.containments.filter((c) => c.hallId === hid);
  for (const c of conts) out.push(...containmentPrims(c, hall));

  // light strips
  const zl = fixtureHeight(hall);
  aisleStrips(hall, eq, conts).forEach((s, i) => {
    const a = s.axis === 'x' ? v(r6(s.a0), r6(s.c), r6(zl)) : v(r6(s.c), r6(s.a0), r6(zl));
    const b = s.axis === 'x' ? v(r6(s.a1), r6(s.c), r6(zl)) : v(r6(s.c), r6(s.a1), r6(zl));
    out.push({ ...arch, id: `light:${hid}#${i + 1}`, emitter: 'light', cls: 'IN-overhead', shape: 'bar', a, b, halfW: 0.04, halfH: 0.025, layer: 'lights', meta: { kind: s.kind, source: 'standard' } });
  });
  return out;
}
