import { describe, expect, it } from 'vitest';
import {
  analyzeProject, applyHallLayout, chooseLayoutGrid, CORRIDOR_DEFAULTS, createNvidiaReferenceProject, findCatalogItem, fitToSpace, FREE_WALL_AREA_TOLERANCE, generateHallLayout, gridReasonText, interHallCoreFor, layoutOptionsFromProject,
  growHallToFit, notchKeepouts, resolveLayoutTemplate, rowEndWalls, servicesZoneRect, type FitOptions, type HallLayout, type HallLayoutOptions, type Project,
} from '../src/index.ts';

/**
 * Services zones, orientation / columns and per-hall scoping (stream T1, DECISIONS-v2-2 F3a / F3b / F2, r2-layout.md §1.4 / §2.4).
 */

function base(pods: number, extra: Partial<HallLayoutOptions> = {}): { project: Project; opts: HallLayoutOptions } {
  const { project } = createNvidiaReferenceProject({ pods: 1, calibrate: false });
  const hall = { ...project.halls[0], width: 0, depth: 0, keepouts: [] };
  const t = resolveLayoutTemplate('rack-scale-liquid-du')!;
  const opts: HallLayoutOptions = {
    hall,
    pods,
    template: t.pod,
    services: { spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 },
    crahCatalogId: 'vertiv-cw375',
    crahs: 'auto',
    crahRedundancy: 'N+1',
    marginM: 1,
    podsPerWave: 2,
    templateId: 'rack-scale-liquid-du',
    ...extra,
  };
  return { project, opts };
}

const gpuYs = (l: HallLayout) => l.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack').map((e) => e.position.y);
const servicesRacks = (l: HallLayout) => l.equipment.filter((e) => e.podId === 'pod-services');
const podAreaWidth = (l: HallLayout) => l.grid.columns * l.grid.rowLengthM + (l.grid.columns - 1) * CORRIDOR_DEFAULTS.transportM;

describe('services zone — a full-width band, never an island (F3b)', () => {
  it('8 SU phased → end band across every pod column, even rows, reserve positions', () => {
    const { opts } = base(8, { columns: 2, servicesZone: 'end-band', spinePlacement: 'central-end' });
    const l = generateHallLayout(opts);
    expect(l.zone?.mode).toBe('end-band');
    const z = l.zone!;
    expect(z.rect).toBeDefined();
    // spans the full pod-grid width (all columns), never longer
    expect(z.rect!.w).toBeCloseTo(podAreaWidth(l), 6);
    // below every pod row (end band)
    expect(z.rect!.y).toBeGreaterThan(Math.max(...gpuYs(l)));
    // depth rule: 2·ceil(n / (2·C·positionsPerRow)), min 2
    const n = servicesRacks(l).length;
    expect(z.rows).toBe(Math.max(2, 2 * Math.ceil(n / (2 * z.positionsPerRow))));
    expect(z.rows % 2).toBe(0);
    expect(z.reservePositions).toBe(z.rows * z.positionsPerRow - n);
    // every band row has something in the second column (racks or reserve) → no island after one column
    const col2Rows = new Set([...l.rows.filter((r) => r.id.endsWith('-c2')).map((r) => r.id), ...(l.reservations ?? []).filter((r) => r.rowId?.endsWith('-c2')).map((r) => r.rowId!)]);
    expect(col2Rows.size).toBe(z.rows);
    // racks never extend past their column segment
    const segEnd = (c: number) => opts.marginM + 0 + c * (l.grid.rowLengthM + CORRIDOR_DEFAULTS.transportM);
    void segEnd;
    for (const r of l.rows.filter((x) => x.podId === 'pod-services')) expect(r.a1 - r.a0).toBeLessThanOrEqual(l.grid.rowLengthM + 1e-6);
    // containment over each band pair, per column
    expect(l.containments.filter((c) => c.podId === 'pod-services').length).toBe((z.rows / 2) * 2);
  });

  it('8 SU single-build → centre band between the middle pod rows, same width', () => {
    const { opts } = base(8, { columns: 2, servicesZone: 'center-band', spinePlacement: 'central-center' });
    const l = generateHallLayout(opts);
    expect(l.zone?.mode).toBe('center-band');
    const z = l.zone!.rect!;
    expect(z.w).toBeCloseTo(podAreaWidth(l), 6);
    const ys = gpuYs(l);
    const above = ys.filter((y) => y < z.y).length;
    const below = ys.filter((y) => y > z.y + z.d).length;
    expect(above).toBe(below);
    expect(above + below).toBe(ys.length);
  });

  it('reference DU 4 keeps its rack positions: 2 band rows, core and services in their own rows, reserve recorded', () => {
    const { project } = createNvidiaReferenceProject();
    const z = project.servicesZones?.find((x) => x.hallId === 'hall-a');
    expect(z?.mode).toBe('end-band');
    expect(z?.rows).toBe(2);
    expect(servicesZoneRect(project, 'hall-a')).toEqual(z?.rect);
    const reserve = (project.reservations ?? []).filter((r) => r.kind === 'reserve').reduce((a, r) => a + r.positions, 0);
    expect(reserve).toBe(z!.reservePositions);
    const band = project.equipment.filter((e) => e.podId === 'pod-services');
    expect(new Set(band.map((e) => e.rowId)).size).toBe(2);
    // one row is network core, the other services
    const coreRow = band.filter((e) => e.networkRole === 'scale-out-spine' || e.networkRole === 'scale-out-core' || findCatalogItem(e.catalogId)?.category === 'network-rack').map((e) => e.rowId);
    expect(new Set(coreRow).size).toBe(1);
  });

  it('support-hac: one support HAC per scalable unit with its share of services, shared core in a small end band', () => {
    const { opts } = base(4, { columns: 1, servicesZone: 'support-hac', spinePlacement: 'central-end' });
    const l = generateHallLayout(opts);
    expect(l.zone?.mode).toBe('support-hac');
    const supportPods = [...new Set(l.equipment.map((e) => e.podId).filter((p) => /^pod-services-\d+$/.test(p ?? '')))];
    expect(supportPods.length).toBe(4);
    const storage = l.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'storage-rack');
    expect(storage.length).toBe(8);
    expect(storage.every((e) => /^pod-services-\d+$/.test(e.podId ?? ''))).toBe(true);
    // each support pair is contained and sits right after its compute pod
    expect(l.containments.filter((c) => /^cont-pod-services-\d+$/.test(c.id)).length).toBe(4);
    expect((l.reservations ?? []).some((r) => r.zone === 'support-hac')).toBe(true);
    // shared network core stays in the end band
    const core = l.equipment.filter((e) => e.networkRole === 'scale-out-spine');
    expect(core.length).toBeGreaterThan(0);
    expect(core.every((e) => e.podId === 'pod-services')).toBe(true);
  });

  it('separate-room: services strip before the pod grid behind a partition', () => {
    const { opts } = base(4, { columns: 1, servicesZone: 'separate-room', spinePlacement: 'separate-room' });
    const l = generateHallLayout(opts);
    const partition = (l.reservations ?? []).find((r) => r.kind === 'room-partition');
    expect(partition).toBeDefined();
    const svc = servicesRacks(l);
    expect(Math.max(...svc.map((e) => e.position.y))).toBeLessThan(partition!.rect.y);
    expect(Math.min(...gpuYs(l))).toBeGreaterThan(partition!.rect.y + partition!.rect.d);
    expect(svc.every((e) => e.meta?.room === 'network' || e.meta?.room === 'services')).toBe(true);
  });

  it('sweep-style check: zone modes generate analysable halls without space / layout errors', () => {
    for (const zone of ['end-band', 'center-band', 'support-hac', 'separate-room'] as const) {
      const { project } = createNvidiaReferenceProject({ pods: 4, calibrate: false });
      const hall = project.halls[0];
      hall.layoutPolicy = { ...hall.layoutPolicy!, servicesZone: zone };
      hall.itPowerBudgetKW = hall.liquidCoolingBudgetKW = hall.airCoolingBudgetKW = 1e9;
      const o = layoutOptionsFromProject(project, hall, { spinePlacement: zone === 'separate-room' ? 'separate-room' : zone === 'center-band' ? 'central-center' : 'central-end' });
      const probe = generateHallLayout({ ...o, hall: { ...hall, width: 0, depth: 0, keepouts: [] } });
      hall.width = Math.ceil(probe.requiredWidth / 0.6) * 0.6;
      hall.depth = Math.ceil(probe.requiredDepth / 0.6) * 0.6;
      hall.keepouts = [];
      const l = generateHallLayout({ ...o, hall });
      const draft = structuredClone(project);
      draft.site.utility.forEach((u) => (u.capacityMVA = 1e6));
      applyHallLayout(draft, hall.id, l, o);
      const a = analyzeProject({ ...draft, trays: undefined, busways: undefined });
      const errs = a.issues.filter((i) => i.severity === 'error' && (i.domain === 'space' || i.domain === 'layout'));
      expect(errs.map((e) => e.id), zone).toEqual([]);
      expect(a.summary.gpus).toBe(4 * 24 * 72);
    }
  });
});

describe('orientation and pod-grid columns (F3a)', () => {
  it.each([16, 40])('DU %i auto-size: hall aspect within 2:1 and selected-area policy', (du) => {
    const { opts } = base(du);
    const c = chooseLayoutGrid(opts, { mode: 'auto-size' });
    expect(c.chosen.aspect).toBeLessThanOrEqual(2 + 1e-6);
    expect(['auto-min-area', 'auto-free-wall']).toContain(c.reason);
    const within0 = c.candidates.filter((x) => x.aspect <= 2 + 1e-6);
    // qa-autosize v2 2차: minimum area among the in-reach grids when there are any (an unreachable run is a validation error)
    const within = within0.some((x) => x.reachOk) ? within0.filter((x) => x.reachOk) : within0;
    const tolerance = c.reason === 'auto-free-wall' ? 1 + FREE_WALL_AREA_TOLERANCE.value + 0.01 : 1.01;
    expect(c.chosen.areaM2).toBeLessThanOrEqual(Math.min(...within.map((x) => x.areaM2)) * tolerance + 1e-6);
    // the generated hall at the chosen grid has the same aspect
    const l = generateHallLayout({ ...opts, orientation: c.orientation, columns: c.columns, crahWalls: c.crahWalls });
    const k = Math.max(l.requiredWidth, l.requiredDepth) / Math.min(l.requiredWidth, l.requiredDepth);
    expect(k).toBeLessThanOrEqual(2 + 1e-3);
    expect(gridReasonText(c)).toMatch(/aspect|within 2:1/);
  });

  it('DU 8 auto grid in the reference hall: the keepout notch never removes wall CRAHs (door / egress clearance matches)', () => {
    const { project } = createNvidiaReferenceProject();
    const hall = project.halls[0];
    const base = layoutOptionsFromProject(project, hall, { pods: 8 });
    const c = chooseLayoutGrid(base, { mode: 'auto-size' });
    expect(c.columns).toBe(2);
    const l = growHallToFit(hall, { ...base, orientation: c.orientation, columns: c.columns, crahWalls: rowEndWalls(c.orientation) });
    const crahs = () => l.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'crah').length;
    const before = crahs();
    notchKeepouts(l, hall, CORRIDOR_DEFAULTS.egressM);
    expect(crahs()).toBe(before);
    expect(before).toBe(l.crah.required);
  });

  it('DU 4 into the existing reference hall keeps 1 column with rows along X (no growth)', () => {
    const { project } = createNvidiaReferenceProject();
    const hall = project.halls[0];
    const o = layoutOptionsFromProject(project, hall);
    const c = chooseLayoutGrid(o, { mode: 'auto-size' });
    expect(c.columns).toBe(1);
    expect(c.orientation).toBe('x');
    expect(c.chosen.widthM).toBeCloseTo(hall.width, 6);
    expect(c.chosen.depthM).toBeCloseTo(hall.depth, 6);
  });

  it('fixed 30 × 80 m hall → rows along Y (the long side)', () => {
    const { opts } = base(6);
    const c = chooseLayoutGrid({ ...opts, hall: { ...opts.hall, width: 30, depth: 80 } }, { mode: 'fixed' });
    expect(c.orientation).toBe('y');
    expect(c.chosen.fits).toBe(true);
    expect(c.chosen.rowsAlongLongSide).toBe(true);
    expect(c.reason).toBe('fixed-long-side');
    expect(c.crahWalls).toEqual(['S', 'N']);
  });

  it('fixed hall: the long-side option losing the air-throw check is reported', () => {
    // 1 column of 36-rack rows along a 30 m side vs a 26 m side: gallery throw limit 18 m one-sided → force a tight limit via 1 wall
    const { opts } = base(2, { template: { ...resolveLayoutTemplate('rack-scale-liquid-du')!.pod, racksPerRow: 36 }, crahStrategy: 'gallery-fan-wall' });
    const c = chooseLayoutGrid({ ...opts, hall: { ...opts.hall, width: 60, depth: 58 } }, { mode: 'fixed' });
    expect(['fixed-long-side', 'fixed-short-throw', 'fixed-short-wall']).toContain(c.reason);
    if (c.reason === 'fixed-short-throw') expect(Number(c.params.throwM)).toBeGreaterThan(Number(c.params.throwMaxM));
  });

  it('fit-to-space prefers rows along the long side on ties (30 × 80 m, equal GPU counts)', () => {
    const { project } = createNvidiaReferenceProject({ pods: 4 });
    const hall = project.halls[1];
    hall.width = 30;
    hall.depth = 80;
    hall.keepouts = [];
    hall.itPowerBudgetKW = 40_000;
    hall.liquidCoolingBudgetKW = 36_000;
    hall.airCoolingBudgetKW = 12_000;
    const policy: FitOptions['policy'] = { templateId: 'rack-scale-liquid-du', orientation: 'x', corridors: CORRIDOR_DEFAULTS, crahStrategy: 'perimeter', crahWalls: ['W', 'E'], objective: 'max-gpus' };
    const cands = fitToSpace(project, hall, { policy, top: 4, maxPods: 2, spinePlacements: ['central-end'] });
    expect(cands.length).toBeGreaterThan(0);
    const bestGpus = cands[0].gpus;
    const tied = cands.filter((c) => c.gpus === bestGpus && c.errors === 0);
    if (tied.some((c) => c.orientation === 'y')) expect(cands[0].orientation).toBe('y');
    expect(cands[0].rowsAlongLongSide).toBe(true);
  });
});

describe('per-hall scoping on the layout side (F2)', () => {
  function twoHalls(): Project {
    const { project } = createNvidiaReferenceProject({ pods: 4 });
    const hallB = project.halls[1];
    hallB.width = 48;
    hallB.depth = 60;
    hallB.keepouts = [];
    hallB.itPowerBudgetKW = 40_000;
    hallB.liquidCoolingBudgetKW = 36_000;
    hallB.airCoolingBudgetKW = 12_000;
    const policy: FitOptions['policy'] = { templateId: 'rack-scale-liquid-du', orientation: 'x', corridors: CORRIDOR_DEFAULTS, crahStrategy: 'perimeter', crahWalls: ['W', 'E'], objective: 'max-gpus' };
    const [c] = fitToSpace(project, hallB, { policy, top: 1, maxPods: 4, orientations: ['x'], spinePlacements: ['central-end'] });
    applyHallLayout(project, hallB.id, c.layout, c.options, { policy: c.policy });
    return project;
  }

  it('a second hall is self-contained: its own services zone, reservations and ids, no references into hall A', () => {
    const p = twoHalls();
    const idsA = new Set(p.equipment.filter((e) => e.hallId === 'hall-a').map((e) => e.id));
    const idsB = new Set(p.equipment.filter((e) => e.hallId === 'hall-b').map((e) => e.id));
    expect([...idsB].filter((id) => idsA.has(id))).toEqual([]);
    expect(p.equipment.some((e) => e.hallId === 'hall-b' && e.podId === 'pod-services-hall-b' || e.hallId === 'hall-b' && e.podId === 'pod-services')).toBe(true);
    expect(p.servicesZones?.map((z) => z.hallId).sort()).toEqual(['hall-a', 'hall-b']);
    const rsv = p.reservations ?? [];
    expect(new Set(rsv.map((r) => r.id)).size).toBe(rsv.length);
    const rowsA = new Set(p.equipment.filter((e) => e.hallId === 'hall-a').map((e) => e.rowId));
    for (const r of rsv.filter((x) => x.hallId === 'hall-b')) expect(rowsA.has(r.rowId)).toBe(false);
    // containments / trays / busways of hall B reference only hall B equipment
    for (const b of (p.busways ?? []).filter((x) => x.hallId === 'hall-b')) for (const t of b.tapoffs) expect(idsB.has(t.equipmentId)).toBe(true);
    for (const c of p.containments.filter((x) => x.hallId === 'hall-b')) expect(p.containments.filter((x) => x.id === c.id).length).toBe(1);
  });

  it('a cluster joining the halls reserves inter-hall core racks in the zone hall only', () => {
    const p = twoHalls();
    p.clusters = [{ id: 'cl-ab', name: 'A+B', hallIds: ['hall-a', 'hall-b'], interHallCore: { zoneHallId: 'hall-a' } }];
    const plan = interHallCoreFor(p, 'hall-a');
    expect(plan.superSpines).toBeGreaterThan(0);
    expect(plan.racks).toBeGreaterThan(0);
    // integration v2 2차: T2's rule ⌈Σ top · ⌊k/2⌋ ÷ k_ss⌉ with the joined (doubled) top tier
    expect(plan.source).toContain('engines/network.ts');
    const kHall = findCatalogItem(p.network.scaleOut.switchCatalogId)!.switch!.ports;
    const kss = findCatalogItem(plan.switchCatalogId)!.switch!.ports;
    expect(plan.superSpines).toBe(Math.ceil((Object.values(plan.topSwitchesByHall).reduce((s, n) => s + n, 0) * Math.floor(kHall / 2)) / kss - 1e-9));
    expect(interHallCoreFor(p, 'hall-b').racks).toBe(0);
    const hall = p.halls[0];
    const o = layoutOptionsFromProject(p, hall);
    expect(o.interHallCoreRacks).toBe(plan.racks);
    const l = generateHallLayout(o);
    const ihc = l.equipment.filter((e) => e.networkRole === 'inter-hall-core');
    expect(ihc.length).toBe(plan.racks);
    expect(ihc.every((e) => e.podId === 'pod-services')).toBe(true);
    expect(l.zone?.interHallCoreRacks).toBe(plan.racks);
  });
});
