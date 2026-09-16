// r4 stream A0 — T2 (spec §4.4): buildHallPrims / shellPrims / hallDatums on the reference project, the synthetic POD fixture and a y-oriented copy.
import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, type EquipmentInstance, type Hall, type Prim, type Project } from '../src/index.ts';
import { findCatalogItem } from '../src/catalog/catalog.ts';
import { footprintRect } from '../src/model/geometry.ts';
import { resolveBusways } from '../src/engines/powerPaths.ts';
import { rowGroupsFromEquipment } from '../src/layout/rows.ts';
import { buildHallPrims, BUSWAY_W_M, PIPE_RADIUS_M } from '../src/scene/build.ts';
import { DEFAULT_TOP_CLEARANCE_M, hallDatums, resolveVerticals } from '../src/scene/datums.ts';
import { LAYERS } from '../src/scene/layers.ts';
import { primAabb } from '../src/scene/prims.ts';
import { fixtureHeight, WALL_THICKNESS_M } from '../src/scene/shell.ts';
import { createRefPodFixture } from './fixtures/ref-pod.ts';

const clone = <T,>(v: T): T => structuredClone(v);
const near = (a: number, b: number, tol = 1e-3) => Math.abs(a - b) <= tol;
const strictOverlap = (p: Prim, r: { x: number; y: number; w: number; d: number }) => {
  const b = primAabb(p);
  return b.min.x < r.x + r.w - 1e-6 && b.max.x > r.x + 1e-6 && b.min.y < r.y + r.d - 1e-6 && b.max.y > r.y + 1e-6;
};

const ref = createNvidiaReferenceProject().project;
const refA = analyzeProject(ref);
const pod = createRefPodFixture();

/** mirror the reference hall across x = y so every row runs along Y (stored trays / busways dropped → derived geometry) */
function yOriented(p: Project): Project {
  const q = clone(p);
  const rot = (r: EquipmentInstance['rotationDeg']) => ((270 - r + 360) % 360) as EquipmentInstance['rotationDeg'];
  const sw = (r: { x: number; y: number; w: number; d: number }) => ({ x: r.y, y: r.x, w: r.d, d: r.w });
  for (const h of q.halls) {
    [h.width, h.depth] = [h.depth, h.width];
    h.keepouts = h.keepouts.map((k) => ({ ...k, rect: sw(k.rect) }));
    if (h.layoutPolicy) h.layoutPolicy = { ...h.layoutPolicy, orientation: 'y' };
  }
  q.equipment = q.equipment.map((e) => ({ ...e, position: { x: e.position.y, y: e.position.x }, rotationDeg: rot(e.rotationDeg) }));
  q.containments = q.containments.map((c) => ({ ...c, rect: sw(c.rect) }));
  q.trays = undefined;
  q.busways = undefined;
  q.reservations = [];
  return q;
}

function checkEquipment(project: Project, hall: Hall, prims: Prim[]) {
  let n = 0;
  for (const e of project.equipment.filter((x) => x.hallId === hall.id)) {
    const it = findCatalogItem(e.catalogId);
    if (!it || it.category === 'switch' || it.category === 'nic') continue;
    const own = prims.filter((p) => p.refId === e.id && (p.emitter === 'rack' || p.emitter === 'unit'));
    expect(own, e.id).toHaveLength(1);
    const f = footprintRect(it.dims, e.position, e.rotationDeg);
    const b = primAabb(own[0]);
    const z0 = e.elevation ?? 0;
    for (const [got, want] of [[b.min.x, f.x], [b.min.y, f.y], [b.max.x, f.x + f.w], [b.max.y, f.y + f.d], [b.min.z, z0], [b.max.z, z0 + it.dims.h]] as const) expect(near(got, want), `${e.id} ${got} vs ${want}`).toBe(true);
    n++;
  }
  return n;
}

describe('scene prims (T2): equipment, one row detector, ids', () => {
  it('every EquipmentInstance → exactly one rack / unit prim = catalog footprint at position + elevation (±1 mm), reference + synthetic POD', () => {
    const p = clone(ref);
    const lifted = p.equipment.find((e) => e.hallId === 'hall-a' && e.rowId)!;
    lifted.elevation = 0.45; // G11: elevation honoured
    for (const detail of ['hall', 'pod'] as const) {
      const hp = buildHallPrims(p, refA, { hallId: 'hall-a', detail });
      expect(checkEquipment(p, p.halls[0], hp.prims)).toBeGreaterThan(100);
      expect(primAabb(hp.prims.find((x) => x.refId === lifted.id)!).min.z).toBe(0.45);
    }
    if (pod) {
      const hp = buildHallPrims(pod, null, { hallId: pod.halls[0].id, detail: 'pod' });
      expect(checkEquipment(pod, pod.halls[0], hp.prims)).toBe(pod.equipment.filter((e) => e.hallId === pod.halls[0].id).length);
    }
  });

  it('prim rowId comes from rows.ts rowGroupsFromEquipment only; HallPrims.rows equals it', () => {
    for (const project of [ref, yOriented(ref)]) {
      const hall = project.halls[0];
      const hp = buildHallPrims(project, null, { hallId: hall.id, detail: 'pod' });
      const rows = rowGroupsFromEquipment(hall.id, project.equipment.filter((e) => e.hallId === hall.id));
      expect(hp.rows).toEqual(rows);
      const rowOf = new Map<string, string>();
      for (const r of rows) for (const id of r.memberIds) rowOf.set(id, r.id);
      for (const pr of hp.prims.filter((x) => x.emitter === 'rack' || x.emitter === 'unit')) expect(pr.rowId, pr.id).toBe(rowOf.get(pr.refId!));
      // rack positions count racks along the row
      for (const r of rows) {
        const pos = hp.prims.filter((x) => x.rowId === r.id && x.emitter === 'rack').map((x) => x.meta!.position as number).sort((a, b) => a - b);
        expect(pos).toEqual(pos.map((_, i) => i + 1));
      }
    }
  });

  it('ids are unique and stable across builds, layers registered, pod detail ⊇ hall detail, null analysis works', () => {
    const layers = new Set(LAYERS.map((l) => l.id));
    const a = buildHallPrims(ref, refA, { hallId: 'hall-a' });
    const b = buildHallPrims(clone(ref), refA, { hallId: 'hall-a' });
    expect(a.hash).toBe(b.hash);
    expect(a.prims.map((p) => p.id)).toEqual(b.prims.map((p) => p.id));
    expect(new Set(a.prims.map((p) => p.id)).size).toBe(a.prims.length);
    expect(a.prims.every((p) => layers.has(p.layer))).toBe(true);
    const podDetail = buildHallPrims(ref, refA, { hallId: 'hall-a', detail: 'pod' });
    const podIds = new Set(podDetail.prims.map((p) => p.id));
    expect(a.prims.every((p) => podIds.has(p.id))).toBe(true);
    expect(podDetail.prims.some((p) => p.emitter === 'tapoff') && !a.prims.some((p) => p.emitter === 'tapoff')).toBe(true);
    const bare = buildHallPrims(ref, null, { hallId: 'hall-a' });
    for (const k of ['circuit', 'feeder', 'room', 'sleeve'] as const) expect(bare.prims.some((p) => p.emitter === k), k).toBe(true);
    expect(bare.prims.filter((p) => p.emitter === 'feeder').every((p) => p.cls === 'PEN')).toBe(true);
    expect(buildHallPrims(ref, null, { hallId: 'no-such-hall' }).prims).toEqual([]);
    const allFinite = (p: Prim) => [p.a.x, p.a.y, p.a.z, p.b.x, p.b.y, p.b.z, p.halfW, p.halfH].every(Number.isFinite);
    expect(podDetail.prims.every(allFinite)).toBe(true);
  });
});

describe('scene prims (T2): services', () => {
  it('every stored tray / busway / tap-off / containment has prims with its refId; busway halfW = BUSWAY_W_M / 2 (G3)', () => {
    const hall = ref.halls[0];
    const hp = buildHallPrims(ref, refA, { hallId: hall.id, detail: 'pod' });
    for (const t of (ref.trays ?? []).filter((x) => x.hallId === hall.id)) expect(hp.prims.some((p) => p.refId === t.id && (p.emitter === 'tray' || p.emitter === 'drop')), t.id).toBe(true);
    const bws = resolveBusways(ref).filter((b) => b.hallId === hall.id);
    expect(bws.length).toBeGreaterThan(0);
    for (const b of bws) {
      const bars = hp.prims.filter((p) => p.emitter === 'busway' && p.refId === b.id);
      expect(bars.length, b.id).toBeGreaterThan(0);
      for (const bar of bars) expect(bar.halfW).toBe(BUSWAY_W_M / 2);
      const system = b.path === 'A' ? 'busway-a' : 'busway-b';
      for (const t of b.tapoffs) expect(hp.prims.some((p) => p.emitter === 'tapoff' && p.meta?.equipmentId === t.equipmentId && p.system === system && p.shape === 'box'), `${b.id} ${t.equipmentId}`).toBe(true);
    }
    for (const c of ref.containments.filter((x) => x.hallId === hall.id)) {
      const parts = hp.prims.filter((p) => p.refId === c.id);
      expect(parts.some((p) => p.emitter === 'containment-panel'), c.id).toBe(true);
      if (c.endDoors) expect(parts.filter((p) => p.emitter === 'door')).toHaveLength(2);
    }
    // tier tags: row trays T1, main trays T2
    for (const p of hp.prims.filter((x) => x.emitter === 'tray')) expect(['T1', 'T2']).toContain(p.tier);
    expect(hp.prims.some((p) => p.emitter === 'tray' && p.tier === 'T2' && p.layer === 'tray-t2')).toBe(true);
  });

  it('G4 fallback trays: row trays T1 + cross trays (0.45 m, FE at +0.6, OOB at +1.0) for x rows and for y rows', () => {
    for (const [project, axis] of [[{ ...clone(ref), trays: undefined }, 'x'], [yOriented(ref), 'y']] as const) {
      const hall = project.halls[0];
      const hp = buildHallPrims(project, null, { hallId: hall.id });
      const trays = hp.prims.filter((p) => p.emitter === 'tray');
      const cross = trays.filter((p) => p.id.startsWith(`tray:tray-cross-${axis}`));
      const main = cross.find((p) => p.system === 'trays')!;
      const fe = cross.find((p) => p.system === 'frontend')!;
      const oob = cross.find((p) => p.system === 'oob')!;
      expect(main && fe && oob, `${axis}`).toBeTruthy();
      const along = (p: Prim) => (axis === 'x' ? p.a.x : p.a.y);
      expect(along(fe) - along(main)).toBeCloseTo(0.6, 6);
      expect(along(oob) - along(main)).toBeCloseTo(1.0, 6);
      // cross trays run across the rows
      for (const p of [main, fe, oob]) expect(axis === 'x' ? p.a.x === p.b.x : p.a.y === p.b.y).toBe(true);
      expect(trays.filter((p) => p.tier === 'T1').length).toBeGreaterThanOrEqual(hp.rows.length);
      // every rack footprint sits inside the hall in the mirrored copy too
      expect(checkEquipment(project, hall, hp.prims)).toBeGreaterThan(100);
    }
  });

  it('pipes: layout/pipes.ts network (row header at rackH + 0.22, r = DN / 2 + 5 mm), keepout-aware (no pipe AABB inside a column)', () => {
    // derived trays / busways (stored ones are only re-clipped by regeneration, which the layout validators require after a hall edit)
    const p: Project = { ...clone(ref), trays: undefined, busways: undefined };
    const hall = p.halls[0];
    const hp0 = buildHallPrims(p, null, { hallId: hall.id });
    // integration r4: the prims come from the derived network (HallPrims.pipes); 'hall' detail drops the branches and fittings only
    expect(hp0.pipes?.runs.length).toBeGreaterThan(0);
    expect(hp0.prims.some((x) => x.emitter === 'pipe' && x.meta?.kind === 'branch')).toBe(false);
    expect(hp0.prims.some((x) => x.emitter === 'fitting')).toBe(false);
    const hpPod = buildHallPrims(p, null, { hallId: hall.id, detail: 'pod' });
    expect(hpPod.prims.filter((x) => x.emitter === 'fitting').length).toBe(hpPod.pipes!.fittings.length);
    expect(hpPod.pipes).toEqual(hp0.pipes);
    const pipe = hp0.prims.find((x) => x.emitter === 'pipe' && x.meta?.part === 'row' && x.system === 'cdu-supply' && Math.abs(x.a.z - x.b.z) < 1e-9)!;
    const row = hp0.rows.find((r) => r.id === pipe.rowId)!;
    expect(pipe.a.z).toBeCloseTo(2.3 + 0.22, 6);
    expect(pipe.halfW).toBeCloseTo(Number(pipe.meta!.dnMM) / 2000 + 0.005, 9);
    expect(pipe.halfW).toBeGreaterThan(PIPE_RADIUS_M); // DN150 row header (OD ≈ 0.16 m) — the old fixed OD 0.11 m is gone
    const mid = (row.a0 + row.a1) / 2;
    const col = { x: mid - 0.3, y: pipe.a.y - 0.3, w: 0.6, d: 0.6 };
    hall.keepouts.push({ id: 'col-test', kind: 'column', rect: col });
    const hp = buildHallPrims(p, null, { hallId: hall.id });
    const pipes = hp.prims.filter((x) => x.emitter === 'pipe');
    expect(pipes.some((x) => String(x.meta?.runId).startsWith(`${pipe.meta!.runId}#`))).toBe(true); // split around the column
    for (const x of pipes) expect(strictOverlap(x, col), x.id).toBe(false);
    for (const x of hp.prims.filter((q) => q.emitter === 'busway' || q.emitter === 'tray')) expect(strictOverlap(x, col), x.id).toBe(false);
  });
});

describe('scene prims (T2): shell', () => {
  it('walls 0.30 m outside the outline, split around the room door; door defaults; columns to the deck; lights at fixtureHeight', () => {
    const hall = ref.halls[0];
    const hp = buildHallPrims(ref, refA, { hallId: hall.id });
    const Ht = hall.clearHeight + hall.ceilingPlenumHeight;
    const walls = hp.prims.filter((p) => p.emitter === 'wall');
    const bx = walls.map(primAabb);
    expect(Math.min(...bx.map((b) => b.min.x))).toBeCloseTo(-WALL_THICKNESS_M, 9);
    expect(Math.max(...bx.map((b) => b.max.x))).toBeCloseTo(hall.width + WALL_THICKNESS_M, 9);
    expect(Math.min(...bx.map((b) => b.min.y))).toBeCloseTo(-WALL_THICKNESS_M, 9);
    expect(Math.max(...bx.map((b) => b.max.y))).toBeCloseTo(hall.depth + WALL_THICKNESS_M, 9);
    const doorK = hall.keepouts.find((k) => k.kind === 'door')!;
    const door = hp.prims.find((p) => p.id === `door:${doorK.id}`)!;
    expect(door.meta).toMatchObject({ wall: 'W', leaves: 2, swing: 'in', clearHeightM: 2.4, source: 'estimate' });
    const db = primAabb(door);
    for (const [got, want] of [[db.min.x, -0.3], [db.min.y, doorK.rect.y], [db.min.z, 0], [db.max.x, 0], [db.max.y, doorK.rect.y + doorK.rect.d], [db.max.z, 2.4]]) expect(got).toBeCloseTo(want, 6);
    const west = walls.filter((p) => p.meta?.wall === 'W');
    expect(west.length).toBe(3); // two spans + header above the door
    const head = west.find((p) => p.meta?.head === doorK.id)!;
    expect(primAabb(head).min.z).toBe(2.4);
    expect(primAabb(head).max.z).toBeCloseTo(Ht, 9);
    // explicit Keepout.door wins; a narrow door gets one leaf
    const p = clone(ref);
    p.halls[0].keepouts = [...p.halls[0].keepouts.filter((k) => k.kind !== 'door'), { ...doorK, door: { leaves: 1, swing: 'sliding', clearHeightM: 2.7 } }, { id: 'door-narrow', kind: 'door', rect: { x: 5, y: 0, w: 0.9, d: 0.3 } }];
    const hp2 = buildHallPrims(p, null, { hallId: hall.id });
    expect(hp2.prims.find((x) => x.id === `door:${doorK.id}`)!.meta).toMatchObject({ leaves: 1, swing: 'sliding', clearHeightM: 2.7, source: 'existing' });
    expect(hp2.prims.find((x) => x.id === 'door:door-narrow')!.meta).toMatchObject({ wall: 'S', leaves: 1 });
    // columns (hall B) to the deck, lights at the fixture height
    const hb = buildHallPrims(ref, null, { hallId: 'hall-b' });
    const cols = hb.prims.filter((x) => x.emitter === 'column');
    expect(cols).toHaveLength(2);
    for (const c of cols) expect(primAabb(c).max.z).toBeCloseTo(ref.halls[1].clearHeight + ref.halls[1].ceilingPlenumHeight, 9);
    for (const l of hp.prims.filter((x) => x.emitter === 'light')) expect(l.a.z).toBeCloseTo(fixtureHeight(hall), 9);
    expect(hp.prims.some((x) => x.emitter === 'slab') && hp.prims.some((x) => x.emitter === 'ceiling')).toBe(true);
  });

  it('containment (G8): ducted chimney top = max(h + 0.3, clearHeight); roof otherwise; doors per doorType; axis-aware ends', () => {
    const hall = ref.halls[0];
    const c = ref.containments.find((x) => x.hallId === hall.id)!;
    const hp = buildHallPrims(ref, null, { hallId: hall.id });
    const chim = hp.prims.filter((p) => p.refId === c.id && p.meta?.part === 'chimney');
    expect(chim).toHaveLength(2);
    for (const x of chim) expect(primAabb(x).max.z).toBeCloseTo(Math.max(c.height + 0.3, hall.clearHeight), 9);
    const doors = hp.prims.filter((p) => p.refId === c.id && p.emitter === 'door');
    expect(doors.map((d) => d.meta?.doorType)).toEqual(['sliding', 'sliding']);
    expect(doors.map((d) => d.meta?.source)).toEqual(['estimate', 'estimate']);
    const p = clone(ref);
    Object.assign(p.containments.find((x) => x.id === c.id)!, { ductedToPlenum: false, doorType: 'swing-double' });
    const hp2 = buildHallPrims(p, null, { hallId: hall.id });
    const roof = hp2.prims.find((x) => x.id === `containment-roof:${c.id}`)!;
    expect(primAabb(roof).min.z).toBeCloseTo(c.height, 9);
    expect(hp2.prims.some((x) => x.refId === c.id && x.meta?.part === 'chimney')).toBe(false);
    expect(hp2.prims.filter((x) => x.refId === c.id && x.emitter === 'door').every((d) => d.meta?.doorType === 'swing-double' && d.meta?.source === 'existing')).toBe(true);
    // y-oriented hall: the doors close the aisle ends along y
    const y = yOriented(ref);
    const cy = y.containments.find((x) => x.id === c.id)!;
    const dy = buildHallPrims(y, null, { hallId: y.halls[0].id }).prims.filter((x) => x.refId === c.id && x.emitter === 'door').map(primAabb);
    expect(dy).toHaveLength(2);
    for (const b of dy) expect(b.max.y - b.min.y).toBeCloseTo(0.05, 9);
    expect(dy.map((b) => (b.min.y + b.max.y) / 2)).toEqual([cy.rect.y, cy.rect.y + cy.rect.d].map((v) => expect.closeTo(v, 9)));
  });

  it('separate-room partitions go to the clear height and close against both walls', () => {
    const p = clone(ref);
    const hall = p.halls[0];
    p.reservations = [...(p.reservations ?? []), { id: 'res-part', hallId: hall.id, kind: 'room-partition', rect: { x: 2, y: 38.5, w: 10, d: 0.2 }, positions: 0, axis: 'x', zone: 'separate-room' }];
    const parts = buildHallPrims(p, null, { hallId: hall.id }).prims.filter((x) => x.emitter === 'partition' && x.refId === 'res-part').map(primAabb);
    expect(parts.length).toBeGreaterThan(0);
    for (const b of parts) expect(b.max.z).toBe(hall.clearHeight);
    expect(Math.min(...parts.map((b) => b.min.x))).toBeCloseTo(0, 9);
    expect(Math.max(...parts.map((b) => b.max.x))).toBeCloseTo(hall.width, 9);
  });
});

describe('scene datums (§2.4 Hall.verticals)', () => {
  it('defaults from the existing constants with source tags; stack order and explicit tiers override', () => {
    const hall = ref.halls[0];
    const hp = buildHallPrims(ref, refA, { hallId: hall.id });
    const d = Object.fromEntries(hp.datums.map((x) => [x.id, x]));
    const rackH = 2.3;
    expect(d.ffl).toMatchObject({ z: 0, source: 'existing' });
    expect(d['rack-top']).toMatchObject({ z: rackH, source: 'derived' });
    expect(d.containment.z).toBeCloseTo(ref.containments[0].height, 9);
    expect(d.pipe).toMatchObject({ z: rackH + 0.22, source: 'existing' });
    expect(d.busway.z).toBeCloseTo(Math.min(hall.trayHeight - 0.22, rackH + 0.4), 9);
    expect(d.T1).toMatchObject({ z: hall.trayHeight, source: 'existing' });
    expect(d.T2.z).toBeCloseTo(hall.trayHeight + 0.35, 9);
    expect(d.T3).toMatchObject({ source: 'estimate' });
    expect(d.T3.z).toBeCloseTo(hall.trayHeight + 0.7, 9);
    expect(d['top-clearance']).toMatchObject({ source: 'standard' });
    expect(d['top-clearance'].z).toBeCloseTo(hall.trayHeight + 0.7 + 0.096 + DEFAULT_TOP_CLEARANCE_M, 9);
    expect(d.light.z).toBeCloseTo(fixtureHeight(hall), 9);
    expect(d.ceiling.z).toBe(hall.clearHeight);
    expect(d.deck.z).toBeCloseTo(hall.clearHeight + hall.ceilingPlenumHeight, 9);
    expect(hp.datums.map((x) => x.z)).toEqual([...hp.datums.map((x) => x.z)].sort((a, b) => a - b));
    expect(hallDatums(hall, hp.prims)).toEqual(hp.datums);
    // 'trays-busway' order: busway above the trays
    const p13 = hallDatums(hall, hp.prims, { stackOrder: 'trays-busway', topClearanceM: 0.5, slabThicknessM: 0.25 });
    const q = Object.fromEntries(p13.map((x) => [x.id, x]));
    expect(q.busway.z).toBeGreaterThan(q.T3.z);
    expect(q['top-clearance']).toMatchObject({ source: 'existing' });
    expect(resolveVerticals(hall, rackH, { slabThicknessM: 0.25 })).toMatchObject({ slabThicknessM: 0.25, slabSource: 'existing', stackOrder: 'pipe-busway-trays' });
    const explicit = hallDatums(hall, hp.prims, { tiers: [{ id: 'L1', kind: 'tray', carries: ['scale-out'], z: 3.1, heightM: 0.1 }] });
    expect(explicit.find((x) => x.id === 'L1')).toMatchObject({ z: 3.1, label: 'LADDER L1', source: 'existing' });
    expect(explicit.some((x) => x.id === 'T1')).toBe(false);
    // hall without racks: no service tiers
    const hb = buildHallPrims(ref, null, { hallId: 'hall-b' });
    expect(hb.datums.map((x) => x.id)).toEqual(['ffl', 'light', 'ceiling', 'deck']);
  });
});
