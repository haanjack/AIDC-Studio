// Finish v2 2차 (DECISIONS-v2-2 §D1): wall-piercing audit sweep. Every case is generated in memory (nothing under data/ is read or
// written) and must have zero violations of the fail classes: no unsleeved / oblique wall crossing, sleeves above the tray level,
// feeders clear of racks, units, containment, columns, trays and each other, partitions and chimney walls crossed only through sleeves,
// cable bundles drawn for rows along X and Y, inter-hall trunks through trunk sleeves.
import { describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, auditProjectGeometry, chooseLayoutGrid, CORRIDOR_DEFAULTS, createNvidiaReferenceProject,
  defaultServicesZone, generateHallLayout, growHallToFit, joinHalls, layoutOptionsFromProject, nextPodIndex, normalizePlacement, notchKeepouts,
  rowEndWalls, WALL_AUDIT_FAIL_CHECKS, type CoolingPlacementOptions, type EquipmentInstance, type Keepout, type Project, type ServicesZoneMode,
} from '../src/index.ts';
import { createRefPodFixture } from './fixtures/ref-pod.ts';

const clone = <T>(v: T): T => structuredClone(v);

interface Cfg {
  pods: number;
  zone?: ServicesZoneMode;
  force?: { orientation: 'x' | 'y'; columns: number };
  width?: number;
  depth?: number;
  keepouts?: Keepout[];
  coolingPlacement?: CoolingPlacementOptions;
}

/** LayoutPanel-like generation of hall A (auto grid, grow or fixed), other halls removed. */
function gen(src: Project, cfg: Cfg): Project {
  const d = clone(src);
  d.halls = d.halls.filter((h) => h.id === 'hall-a');
  for (const h of d.halls) {
    h.itPowerBudgetKW = 1e9;
    h.liquidCoolingBudgetKW = 1e9;
    h.airCoolingBudgetKW = 1e9;
  }
  const hall = d.halls[0];
  const fixed = cfg.width !== undefined;
  if (fixed) {
    hall.width = cfg.width!;
    hall.depth = cfg.depth!;
    hall.keepouts = cfg.keepouts ?? [];
  }
  if (cfg.coolingPlacement) hall.coolingPlacement = cfg.coolingPlacement;
  const base = layoutOptionsFromProject(d, hall, {
    pods: cfg.pods,
    podIndexStart: nextPodIndex(d, hall.id),
    services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 },
    spinePlacement: normalizePlacement(d.network.scaleOut.spinePlacement),
    servicesZone: cfg.zone ?? defaultServicesZone(d.growth),
  });
  const choice = chooseLayoutGrid(base, { mode: fixed ? 'fixed' : 'auto-size' });
  const orientation = cfg.force?.orientation ?? choice.orientation;
  const o = { ...base, orientation, columns: cfg.force?.columns ?? choice.columns, crahWalls: rowEndWalls(orientation) };
  const layout = fixed ? generateHallLayout(o) : growHallToFit(hall, o);
  notchKeepouts(layout, hall, CORRIDOR_DEFAULTS.egressM);
  applyHallLayout(d, hall.id, layout, o, { waveStart: 1 });
  return d;
}

/** perimeter columns every 6 m (0.3 m off the walls) plus end-aisle columns 2.0 m from the row-end walls (qa-geometry fixed halls) */
function wallColumns(W: number, D: number, endAisle: 'x' | 'y'): Keepout[] {
  const k: Keepout[] = [];
  const col = (x: number, y: number) => k.push({ id: `ko-col-${k.length + 1}`, kind: 'column', rect: { x, y, w: 0.6, d: 0.6 }, label: 'column' });
  for (let a = 3; a < W - 3; a += 6) { col(a, 0.3); col(a, D - 0.9); }
  for (let a = 3; a < D - 3; a += 6) { col(0.3, a); col(W - 0.9, a); }
  if (endAisle === 'x') for (let a = 4.5; a < D - 3; a += 6) { col(2.0, a); col(W - 2.6, a); }
  else for (let a = 4.5; a < W - 3; a += 6) { col(a, 2.0); col(a, D - 2.6); }
  return k;
}

function joined(dir: 'ew' | 'ns'): Project {
  const d = clone(createNvidiaReferenceProject().project);
  d.clusters = joinHalls(d, ['hall-a', 'hall-b']);
  for (const [hallId, svc] of [['hall-b', { storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 }], ['hall-a', { storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 }]] as const) {
    const hall = d.halls.find((h) => h.id === hallId)!;
    const o = layoutOptionsFromProject(d, hall, { pods: 2, podIndexStart: nextPodIndex(d, hallId), services: { spineRacks: 'auto', ...svc } });
    applyHallLayout(d, hallId, growHallToFit(hall, o), o);
  }
  const A = d.halls.find((h) => h.id === 'hall-a')!;
  const B = d.halls.find((h) => h.id === 'hall-b')!;
  B.origin = dir === 'ew' ? { x: A.origin.x + A.width + 12, y: A.origin.y } : { x: A.origin.x, y: A.origin.y + A.depth + 12 };
  return d;
}

/** F9: one hand-placed row with a column standing in the row line (no stored trays / busways → derived busways split at the column) */
function columnInRow(): Project {
  const d = clone(createNvidiaReferenceProject().project);
  const hall = d.halls.find((h) => h.id === 'hall-a')!;
  d.halls = [hall];
  hall.keepouts = [{ id: 'ko-f9', kind: 'column', rect: { x: 8.0, y: 4.6, w: 0.6, d: 0.6 }, label: 'column in row' }];
  hall.layoutPolicy = { ...(hall.layoutPolicy ?? {}), crahStrategy: 'in-row' } as typeof hall.layoutPolicy;
  const racks: EquipmentInstance[] = [];
  for (let i = 0; i < 13; i++) {
    const x = 2.3 + 0.6 * i;
    if (x > 7.9 && x < 8.7) continue;
    racks.push({ id: `f9-${i}`, catalogId: 'nvidia-gb300-nvl72', hallId: hall.id, tag: `F9-${i}`, position: { x, y: 5 }, rotationDeg: 180, podId: 'pod-f9', rowId: 'r1', waveId: 'wave-01' });
  }
  d.equipment = racks;
  d.containments = [];
  delete d.trays;
  delete d.busways;
  delete d.reservations;
  delete d.servicesZones;
  return d;
}

function failures(p: Project) {
  const a = analyzeProject(p);
  const reports = auditProjectGeometry(p, a);
  const fail = reports.flatMap((r) => r.violations.filter((v) => WALL_AUDIT_FAIL_CHECKS.includes(v.check)));
  const byCheck: Record<string, number> = {};
  for (const f of fail) byCheck[`${f.hallId}:${f.check}`] = (byCheck[`${f.hallId}:${f.check}`] ?? 0) + 1;
  return { a, reports, fail, byCheck, example: fail.slice(0, 3) };
}

const ref = () => createNvidiaReferenceProject().project;
const cases: [string, () => Project][] = [
  ['reference (rows X, CRAH on W / E → rooms S / N)', () => ({ ...clone(ref()), halls: clone(ref()).halls.filter((h) => h.id === 'hall-a') })],
  ['rows Y, 4 DU', () => gen(ref(), { pods: 4, force: { orientation: 'y', columns: 1 } })],
  ['12 DU auto (3 pod columns)', () => gen(ref(), { pods: 12 })],
  ['NEC profile, 6 DU (more circuits → deeper approach stack)', () => { const p = gen(ref(), { pods: 6 }); p.site.powerProfile = 'nec'; return p; }],
  ['separate room, rows X', () => { const s = clone(ref()); s.network.scaleOut.spinePlacement = 'separate-room'; return gen(s, { pods: 4, zone: 'separate-room', force: { orientation: 'x', columns: 1 } }); }],
  ['separate room, rows Y', () => { const s = clone(ref()); s.network.scaleOut.spinePlacement = 'separate-room'; return gen(s, { pods: 4, zone: 'separate-room', force: { orientation: 'y', columns: 1 } }); }],
  ['fixed 90 × 40 m with perimeter and end-aisle columns', () => gen(ref(), { pods: 8, width: 90, depth: 40, keepouts: wallColumns(90, 40, 'x') })],
  ['fixed 30 × 100 m with perimeter and end-aisle columns', () => gen(ref(), { pods: 8, width: 30, depth: 100, keepouts: wallColumns(30, 100, 'y') })],
  ['CDU gallery on the S wall', () => gen(ref(), { pods: 4, coolingPlacement: { cduPerPod: 'auto', cduPlacement: 'gallery', crahCount: 'auto', crahStrategy: 'perimeter', cduGalleryWall: 'S' } })],
  ['joined halls east–west (trunk sleeves on E / W)', () => joined('ew')],
  ['joined halls north–south (trunk sleeves on N / S, facing rooms flagged)', () => joined('ns')],
  ['column standing in a hand-placed row (split busways, approach dodge)', () => columnInRow()],
];

describe('geometry wall audit sweep (D1)', () => {
  for (const [name, build] of cases) {
    it(name, () => {
      const p = build();
      const r = failures(p);
      expect(r.byCheck, JSON.stringify(r.example)).toEqual({});
      // feeders cross walls only through their sleeves, and there is one feeder sleeve per room
      const feederSleeves = (r.a.power.penetrations ?? []).filter((x) => x.kind === 'feeder-sleeve');
      expect(feederSleeves.length).toBe((r.a.power.rooms ?? []).length);
      expect(r.reports.reduce((s, x) => s + x.feederSegments, 0)).toBeGreaterThan(0);
    }, 60_000);
  }

  it('rows along Y draw their cable bundles (F8) and the joined halls draw their trunks', () => {
    const y = gen(ref(), { pods: 2, force: { orientation: 'y', columns: 1 } });
    const ry = failures(y).reports[0];
    expect(ry.coverage['mixed-axis'] ?? 0).toBe(0);
    const j = joined('ew');
    const rj = failures(j);
    expect(rj.reports.every((x) => (x.coverage['inter-hall-no-sleeve'] ?? 0) === 0)).toBe(true);
    expect((rj.a.network.penetrations ?? []).filter((x) => x.kind === 'trunk-sleeve')).toHaveLength(2);
    expect(rj.a.network.interHallPathways?.[0].lengthM).toBeGreaterThan(12);
  }, 60_000);

  it('separate-room partitions close against both hall walls and are crossed only through partition sleeves', () => {
    const s = clone(ref());
    s.network.scaleOut.spinePlacement = 'separate-room';
    const p = gen(s, { pods: 4, zone: 'separate-room', force: { orientation: 'x', columns: 1 } });
    const part = p.reservations!.find((x) => x.kind === 'room-partition')!;
    expect(part.rect.x).toBe(0);
    expect(part.rect.w).toBe(p.halls[0].width);
    const a = analyzeProject(p);
    expect([...(a.power.penetrations ?? []), ...(a.network.penetrations ?? [])].filter((x) => x.wall === 'partition' && x.reservationId === part.id).length).toBeGreaterThan(0);
  }, 60_000);

  it('the audit fails an unsleeved wall crossing (feeder sleeve removed)', () => {
    const p = { ...clone(ref()), halls: clone(ref()).halls.filter((h) => h.id === 'hall-a') };
    const a = analyzeProject(p);
    a.power.penetrations = [];
    const r = auditProjectGeometry(p, a)[0];
    expect(r.counts['unsleeved-wall-crossing']).toBe(68);
  });

  it('halls that overlap on the site raise an error', () => {
    const p = clone(ref());
    p.halls[1].origin = { x: 10, y: 0 };
    p.equipment.push({ ...p.equipment[0], id: 'probe-b', hallId: p.halls[1].id, tag: 'B-PROBE' });
    const a = analyzeProject(p);
    expect(a.issues.some((i) => i.id === `site-hall-overlap-${p.halls[0].id}-${p.halls[1].id}` && i.severity === 'error')).toBe(true);
  });

  it('synthetic reference POD (geometry-only project): no orphan trays / busways, feeders sleeved', () => {
    const p = createRefPodFixture();
    expect(p.trays ?? []).toEqual([]);
    expect(p.busways ?? []).toEqual([]);
    const r = failures(p);
    expect(r.byCheck, JSON.stringify(r.example)).toEqual({});
    expect(r.a.issues.find((i) => i.id === 'reference-cfd-scope')!.messageEn).toMatch(/all \d+ sized switches \(\d+ groups\) are unplaced/);
  }, 60_000);
});
