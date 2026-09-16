// Stream T3 — power plane (paths, contingency scenarios, N-1 sweep) and Max-Q (r2-platform.md §1, DECISIONS-v2-2 §C).
import { describe, expect, it } from 'vitest';
import {
  analyzeMaxQ, analyzePowerPaths, analyzeProject, buildPowerPlane, continuousLimitRule, createNvidiaReferenceProject, evaluatePowerScenario,
  maxqModel, sweepPowerN1, type Project,
} from '../src/index.ts';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const { project } = createNvidiaReferenceProject();
const analysis = analyzeProject(project);

/** reference hall with every rack given oversized shelves (no capping), optional profile */
function uncappedProject(profile?: 'iec' | 'nec'): Project {
  const p = clone(project);
  if (profile) p.site.powerProfile = profile;
  for (const e of p.equipment) e.meta = { ...(e.meta ?? {}), shelvesPerSide: 8, shelfKW: 33 };
  return p;
}

describe('power plane paths (reference hall)', () => {
  const paths = analysis.power.paths ?? [];
  const busways = paths.filter((p) => p.kind === 'busway');
  const feeders = paths.filter((p) => p.kind === 'feeder');
  const taps = paths.filter((p) => p.kind === 'tapoff');
  const rackIds = new Set((project.busways ?? []).flatMap((b) => b.tapoffs.map((t) => t.equipmentId)));

  it('attaches paths in analyzeProject and matches the reference counts', () => {
    expect(project.busways).toHaveLength(20);
    expect(busways).toHaveLength(68);
    expect(feeders).toHaveLength(busways.length);
    // every rack on a busway gets one tap-off per side
    expect(taps).toHaveLength(rackIds.size * 2);
    expect(rackIds.size).toBe(135);
    expect(analyzePowerPaths(project, analysis)).toBe(paths);
  });

  it('circuit lengths stay within the contiguous row busway; the farthest circuit spans the full 10.8 m run; feeders reach the room outside the wall', () => {
    for (const b of busways) {
      expect(b.lengthM).toBeGreaterThan(0);
      expect(b.lengthM).toBeLessThanOrEqual(10.8 + 1e-6);
    }
    expect(Math.max(...busways.filter((b) => b.buswayId === 'bus-A-pod-01-a').map((b) => b.lengthM))).toBeCloseTo(10.8, 6);
    const plane = buildPowerPlane(project, analysis);
    const hall = project.halls[0];
    const roomA = plane.rooms.find((r) => r.id === 'elec-hall-a-A')!;
    const roomB = plane.rooms.find((r) => r.id === 'elec-hall-a-B')!;
    // polish v2 2차 (QA m5): the row-end walls W / E carry the perimeter CRAHs, so the rooms move to the free S / N walls
    expect([roomA.wall, roomA.relocatedFrom, roomA.conflict]).toEqual(['S', 'W', undefined]);
    expect([roomB.wall, roomB.relocatedFrom, roomB.conflict]).toEqual(['N', 'E', undefined]);
    expect(roomA.rect.y + roomA.rect.d).toBeLessThan(0);
    expect(roomB.rect.y).toBeGreaterThan(hall.depth);
    const fA = feeders.find((f) => f.toId === 'bus-A-pod-01-a/c1')!;
    // finish v2 2차 (D1 / D2): A leaves its circuit 0.05 m inside the west row end (x = 5.1), rises at the busway midline, runs out to the
    // end-aisle feeder tray above the main tray, along the lane to the single S-wall sleeve and ends at the switchboard lineup against the
    // hall-side wall of the S room (y = −0.4 gap − 0.6 half section depth); the length no longer depends on the sized room depth
    expect(fA.points[0].x).toBeCloseTo(5.15, 6);
    expect(fA.points[fA.points.length - 1].y).toBeCloseTo(-1.0, 6);
    expect(fA.lengthM).toBeCloseTo(fA.points.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - fA.points[i].x, p.y - fA.points[i].y, p.z - fA.points[i].z), 0), 6);
    expect(fA.fromId).toBe('swbd-hall-a-A');
    const pen = analysis.power.penetrations!.find((x) => x.targetId === 'elec-hall-a-A')!;
    const last = fA.points[fA.points.length - 2];
    expect(pen.wall).toBe('S');
    expect(pen.z[0]).toBeGreaterThan(hall.trayHeight + 0.35 + 0.09);
    expect(last.x).toBeGreaterThan(pen.along[0]);
    expect(last.x).toBeLessThan(pen.along[1]);
    expect(analysis.power.penetrations!.filter((x) => x.kind === 'feeder-sleeve')).toHaveLength(2);
  });

  it('loading = connected kW / (√3·V·I·PF × profile factor); IEC 1.0, NEC 0.8', () => {
    const rated = (Math.sqrt(3) * 415 * 800 * 0.97) / 1000;
    for (const b of busways) {
      expect(b.ratedKW).toBeCloseTo(rated, 6);
      expect(b.limitKW).toBeCloseTo(rated, 6);
      expect(b.loading).toBeCloseTo(b.connectedKW! / b.limitKW!, 12);
    }
    const nec = clone(project);
    nec.site.powerProfile = 'nec';
    expect(continuousLimitRule(nec).continuousLimit).toBe(0.8);
    expect(analyzePowerPaths(nec).find((p) => p.kind === 'busway')!.limitKW).toBeCloseTo(rated * 0.8, 6);
    nec.power.deratingFactor = 1;
    expect(continuousLimitRule(nec)).toMatchObject({ continuousLimit: 1, rated100pct: true });
    expect(continuousLimitRule({ ...project, site: { ...project.site, powerProfile: 'kr' } })).toMatchObject({ continuousLimit: 1, warnAt: 0.9, sourceType: 'estimate' });
  });

  it('A/B loading is symmetric and each circuit stays within its limit when one side carries the row', () => {
    const byId = new Map(busways.map((b) => [b.id, b]));
    for (const a of busways.filter((b) => b.side === 'A')) {
      const b = byId.get(a.id.replace('bus-A-', 'bus-B-'))!;
      expect(b).toBeDefined();
      expect(b.connectedKW).toBeCloseTo(a.connectedKW!, 9);
      expect(b.equipmentIds).toEqual(a.equipmentIds);
      expect(a.loading!).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });

  it('one-line busway / load nodes carry refs for 3D linking', () => {
    const busA = analysis.power.oneLine.nodes.find((n) => n.id === 'bus-A')!;
    expect(busA.refs).toHaveLength(10);
    expect(analysis.power.oneLine.nodes.filter((n) => n.kind === 'load').every((n) => (n.refs?.length ?? 0) > 0)).toBe(true);
  });
});

describe('power scenarios', () => {
  it('normal: no drops, worst loading ≤ 50 %', () => {
    const r = evaluatePowerScenario(project, analysis, { kind: 'normal' });
    expect(r.droppedEquipmentIds).toEqual([]);
    expect(r.racks).toEqual([]);
    expect(r.summary.worstLoadingPct).toBeLessThanOrEqual(50 + 1e-9);
    expect(r.notes[0]).toMatch(/IEC 60364-4-43/);
  });

  it('busway failure moves dual-corded load to the surviving side (GB300 4+4 × 33 kW → capped at 132 kW)', () => {
    const target = 'bus-A-pod-01-a/c1';
    const plane = buildPowerPlane(project, analysis);
    const circuit = plane.circuits.find((c) => c.id === target)!;
    const r = evaluatePowerScenario(project, analysis, { kind: 'busway-failure', targetIds: [target] });
    expect(r.failedIds).toEqual([target]);
    const failedPath = r.paths.find((p) => p.id === target)!;
    expect(failedPath.kw).toBe(0);
    const twin = r.paths.find((p) => p.id === 'bus-B-pod-01-a/c1')!;
    const expected = circuit.rackIds.reduce((s, id) => s + Math.min(plane.racks.find((x) => x.id === id)!.kw, 132), 0);
    expect(twin.kw).toBeCloseTo(expected, 9);
    for (const id of circuit.rackIds) expect(r.racks.find((x) => x.id === id)?.state).toBe('capped');
    expect(r.droppedEquipmentIds).toEqual([]);
    expect(r.summary.cappedKW).toBeCloseTo(circuit.rackIds.length * 4, 9);
  });

  it('busway failure flags overload when the surviving run exceeds its continuous limit (NEC, load factor 1.1)', () => {
    const p = uncappedProject('nec');
    const a = analyzeProject(p);
    const plane = buildPowerPlane(p, a);
    const fullKW = (ids: string[]) => ids.reduce((s, id) => s + plane.racks.find((r) => r.id === id)!.kw, 0);
    const heaviest = [...plane.circuits].filter((c) => c.side === 'A').sort((x, y) => fullKW(y.rackIds) - fullKW(x.rackIds) || x.id.localeCompare(y.id))[0];
    const twinId = heaviest.id.replace('bus-A-', 'bus-B-');
    // load factor that puts the full circuit load 5 % above the continuous limit (half of it in normal operation)
    const lf = (heaviest.limitKW / fullKW(heaviest.rackIds)) * 1.05;
    const normal = evaluatePowerScenario(p, a, { kind: 'normal', loadFactor: lf });
    expect(normal.paths.find((x) => x.id === twinId)!.overloaded).toBe(false);
    const r = evaluatePowerScenario(p, a, { kind: 'busway-failure', targetIds: [heaviest.id], loadFactor: lf });
    const twin = r.paths.find((x) => x.id === twinId)!;
    const limit = plane.circuits.find((c) => c.id === twinId)!.limitKW;
    expect(twin.loadingPct).toBeCloseTo((twin.kw! / limit) * 100, 9);
    expect(twin.overloaded).toBe(twin.kw! > limit);
    expect(twin.overloaded).toBe(true);
    expect(r.summary.overloadedPaths).toBeGreaterThanOrEqual(1);
    for (const id of heaviest.rackIds) expect(r.racks.find((x) => x.id === id)?.state).toBe('single-path');
  });

  it('single-corded rack on the failed side drops; on the surviving side it keeps running', () => {
    const p = uncappedProject();
    const rackId = 'eq-du01-a-01';
    p.equipment.find((e) => e.id === rackId)!.meta = { singleCorded: true, cordSide: 'A' };
    const a = analyzeProject(p);
    const plane = buildPowerPlane(p, a);
    const rack = plane.racks.find((r) => r.id === rackId)!;
    const rA = evaluatePowerScenario(p, a, { kind: 'busway-failure', targetIds: [rack.circuits.A!] });
    expect(rA.droppedEquipmentIds).toContain(rackId);
    expect(rA.racks.find((r) => r.id === rackId)?.reason).toMatch(/single-corded/);
    const rB = evaluatePowerScenario(p, a, { kind: 'busway-failure', targetIds: [rack.circuits.B!] });
    expect(rB.droppedEquipmentIds).not.toContain(rackId);
    // normal: the whole single-corded load sits on side A
    const normal = evaluatePowerScenario(p, a, { kind: 'normal' });
    expect(normal.paths.find((x) => x.id === rack.circuits.A)!.kw! - normal.paths.find((x) => x.id === rack.circuits.B)!.kw!).toBeCloseTo(rack.kw, 9);
  });

  it('non-redundant shelves: capped at the surviving shelf capacity, dropped without capping or below the rack minimum', () => {
    const p = clone(project);
    const rackId = 'eq-du01-a-01';
    const e = p.equipment.find((x) => x.id === rackId)!;
    e.meta = { powerShelves: 'non-redundant' };
    let a = analyzeProject(p);
    const circuitA = buildPowerPlane(p, a).racks.find((r) => r.id === rackId)!.circuits.A!;
    let r = evaluatePowerScenario(p, a, { kind: 'busway-failure', targetIds: [circuitA] });
    expect(r.racks.find((x) => x.id === rackId)).toMatchObject({ state: 'capped', kwB: 99 });
    e.meta = { powerShelves: 'non-redundant', powerCapping: false };
    a = analyzeProject(p);
    r = evaluatePowerScenario(p, a, { kind: 'busway-failure', targetIds: [circuitA] });
    expect(r.droppedEquipmentIds).toContain(rackId);
    e.meta = { shelvesPerSide: 1, shelfKW: 30 }; // below GB300 idle 40.8 kW
    a = analyzeProject(p);
    r = evaluatePowerScenario(p, a, { kind: 'busway-failure', targetIds: [circuitA] });
    expect(r.racks.find((x) => x.id === rackId)?.reason).toMatch(/below the rack minimum/);
  });

  it('worst-case selection is deterministic and rpp-failure fails every circuit of the row side', () => {
    const w1 = evaluatePowerScenario(project, analysis, { kind: 'busway-failure', count: 2 });
    const w2 = evaluatePowerScenario(project, analysis, { kind: 'busway-failure', count: 2 });
    expect(w1.failedIds).toHaveLength(2);
    expect(w1.failedIds).toEqual(w2.failedIds);
    const rpp = evaluatePowerScenario(project, analysis, { kind: 'rpp-failure', targetIds: ['bus-A-pod-01-a'] });
    const circuits = buildPowerPlane(project, analysis).buswayCircuits.get('bus-A-pod-01-a')!;
    for (const c of circuits) expect(rpp.paths.find((x) => x.id === c)!.kw).toBe(0);
    expect(rpp.summary.cappedRacks + rpp.summary.singlePathRacks).toBe(14);
  });

  it('utility loss: the surviving feed carries; single feed → generators carry with an N+1 check', () => {
    const r = evaluatePowerScenario(project, analysis, { kind: 'utility-loss' });
    expect(r.failedIds).toEqual(['feed-a']);
    expect(r.elements.find((e) => e.id === 'gen')!.state).toBe('standby');
    expect(r.summary.gensetMarginPct).toBeCloseTo(((analysis.power.generators.units * analysis.power.generators.unitKW * 0.95) / analysis.power.facilityKW - 1) * 100, 9);
    const both = evaluatePowerScenario(project, analysis, { kind: 'utility-loss', count: 2 });
    expect(both.elements.find((e) => e.id === 'gen')!.state).toBe('carrying');
    expect(both.notes.some((n) => /N\+1 holds/.test(n))).toBe(true);
  });

  it('generator failure sheds racks by priority when the gensets fall short', () => {
    const g = analysis.power.generators;
    const usable1 = (g.units - 1) * g.unitKW * 0.95;
    const r1 = evaluatePowerScenario(project, analysis, { kind: 'generator-failure', count: 1 });
    expect(r1.droppedEquipmentIds.length > 0).toBe(analysis.power.facilityKW > usable1);
    const r3 = evaluatePowerScenario(project, analysis, { kind: 'generator-failure', count: 3 });
    expect(r3.elements.find((e) => e.id === 'gen')!.state).toBe('shortfall');
    expect(r3.droppedEquipmentIds.length).toBeGreaterThan(0);
    expect(r3.summary.droppedGpus).toBeGreaterThan(0);
  });

  it('UPS module failure ends normal-with-reduced-redundancy, transferred, or on bypass (racks unprotected, never dropped)', () => {
    const upsId = analysis.power.oneLine.nodes.find((n) => n.kind === 'ups' && n.path !== 'C')!.id; // block model: ups-1 … (fix v2 2차)
    const r = evaluatePowerScenario(project, analysis, { kind: 'ups-module-failure', targetIds: [upsId] });
    const ups = r.elements.find((e) => e.id === upsId)!;
    expect(['reduced-redundancy', 'transferred', 'on-bypass']).toContain(ups.state);
    expect(r.droppedEquipmentIds).toEqual([]);
    if (ups.state === 'on-bypass') expect(r.summary.singlePathRacks).toBeGreaterThan(0);
    const twoN = clone(project);
    twoN.power.upsRedundancy = '2N';
    const a2 = analyzeProject(twoN);
    expect(evaluatePowerScenario(twoN, a2, { kind: 'ups-module-failure' }).elements.find((e) => e.kind === 'ups' && e.state !== 'normal')?.state).toBe('reduced-redundancy');
  });

  it('N-1 sweep covers every single element and reports the worst case per path', () => {
    const plane = buildPowerPlane(project, analysis);
    const s = sweepPowerN1(project, analysis);
    // UPS module contingencies: one per active system (block model: ups-1 … ups-K; the catcher is not a contingency)
    const upsSystems = analysis.power.oneLine.nodes.filter((n) => n.kind === 'ups' && n.path !== 'C').length;
    expect(s.contingencies).toBe(plane.circuits.length + plane.buswayCircuits.size + upsSystems + 1 + project.site.utility.length);
    expect(s.worst!.worstPct).toBeGreaterThan(s.worst!.normalPct);
    for (const row of s.rows) expect(row.worstPct).toBeGreaterThanOrEqual(row.normalPct - 1e-9);
  });
});

describe('polish v2 2차 — UPS block sizing, one circuit count, rooms, overlay reuse', () => {
  const singlePod = (): Project => {
    const { project: p } = createNvidiaReferenceProject({ pods: 1 });
    return p;
  };

  it('generated block-redundant designs survive their own N-1 set: 0 overloads in normal and every single contingency (IEC and NEC)', () => {
    for (const profile of ['iec', 'nec'] as const) {
      for (const make of [() => clone(project), singlePod]) {
        const p = make();
        p.site.powerProfile = profile;
        const a = analyzeProject(p);
        const sizing = a.power.upsSizing!;
        expect(sizing.survives, profile).toBe(true);
        expect(sizing.worstPct, profile).toBeLessThanOrEqual(100);
        expect(a.power.ups.units).toBe(sizing.modules);
        const sweep = sweepPowerN1(p, a);
        expect(sweep.rows.filter((r) => r.overloaded || r.worstPct > 100 + 1e-9).map((r) => `${r.id} ${r.contingency}`), profile).toEqual([]);
        expect(evaluatePowerScenario(p, a, { kind: 'normal' }).notes.some((n) => n.startsWith('Design check'))).toBe(false);
        expect(a.issues.some((i) => i.id === 'power-ups-block-headroom')).toBe(false);
      }
    }
  });

  it('reference IEC: the ⌈n/4⌉ base (4 × 3 + 3) failed a row-side failure at 102.4 %; the sizing picks 18 modules and the sweep peaks at 97.2 %', () => {
    const s = analysis.power.upsSizing!;
    expect([s.baseModules, s.blockModules, s.activeBlocks, s.modules]).toEqual([12, 6, 2, 18]);
    expect(s.worstPct).toBeCloseTo(97.2, 1);
    expect(s.worstContingency.startsWith('row distribution')).toBe(true);
  });

  it('a user-overridden arrangement that does not survive keeps the design-check note and raises an issue', () => {
    const p = clone(project);
    p.power.upsBlocks = { blockModules: 3, activeBlocks: 4 };
    const a = analyzeProject(p);
    expect(a.power.upsSizing).toMatchObject({ override: true, survives: false, modules: 15 });
    expect(a.power.upsSizing!.worstPct).toBeGreaterThan(100);
    expect(evaluatePowerScenario(p, a, { kind: 'normal' }).notes.some((n) => n.startsWith('Design check'))).toBe(true);
    expect(a.issues.some((i) => i.id === 'power-ups-block-headroom' && i.severity === 'warning')).toBe(true);
  });

  it('one-line, rpps and BOM busway counts equal the plane circuits with the profile limit (IEC 68, NEC 84)', () => {
    for (const [profile, count, limit] of [['iec', 68, 1], ['nec', 84, 0.8]] as const) {
      const p = clone(project);
      p.site.powerProfile = profile;
      const a = analyzeProject(p);
      const plane = buildPowerPlane(p, a);
      expect(plane.circuits).toHaveLength(count);
      expect(a.power.rpps.units, profile).toBe(count);
      expect(a.power.rpps.limitFactor).toBe(limit);
      expect(a.power.rpps.maxLoading).toBeLessThanOrEqual(limit + 1e-9);
      expect((a.power.rppPerPod ?? []).reduce((s, r) => s + r.runsPerPath * 2, 0)).toBe(count);
      expect(a.power.oneLine.nodes.find((n) => n.id === 'bus-A')!.label).toContain(`${count / 2} circuits`);
    }
  });

  it('electrical rooms: depth from the UPS modules and footprint table, relocated off the CRAH walls, reused by the analysis', () => {
    const rooms = analysis.power.rooms!;
    expect(rooms.map((r) => r.wall)).toEqual(['S', 'N']);
    const plane = buildPowerPlane(project, analysis);
    expect(plane.rooms.map((r) => r.rect)).toEqual(rooms.map((r) => r.rect));
    const A = rooms.find((r) => r.side === 'A')!;
    // 6 modules (1 active block of 6) × (3.2 m + 4 × 0.6 m cabinets) along 21.6 − 2 m → 3 per row → 2 UPS rows + 1 switchboard row
    expect([A.upsModules, A.batteryCabinets, A.lineups]).toEqual([6, 24, 3]);
    expect(A.depthM).toBeCloseTo(1 * (1.2 + 1.2) + 2 * (1.0 + 1.2) + 0.6, 9);
    expect(rooms.find((r) => r.side === 'B')!.upsModules).toBe(12);
    // with free row-end walls (no CRAH units) the rooms stay on W / E
    const noCrah = clone(project);
    noCrah.equipment = noCrah.equipment.filter((e) => !e.catalogId.startsWith('vertiv-cw'));
    noCrah.halls.forEach((h) => { if (h.layoutPolicy) h.layoutPolicy.crahStrategy = 'in-row'; });
    expect(analyzeProject(noCrah).power.rooms!.map((r) => r.wall)).toEqual(['W', 'E']);
  });
});

describe('Max-Q (worked example, MaxLPS)', () => {
  it('reproduces the worked example exactly: 5 × 130 kW, draws 105/95/109/87/79 → 175 kW stranded → +1 × 110 kW rack (585 ≤ 650 kW)', () => {
    const racks = [105, 95, 109, 87, 79].map((d) => ({ allocationKW: 130, drawKW: d, gpus: 72 }));
    const m = maxqModel(racks, { newRackDrawKW: 110 });
    expect(m.budgetKW).toBe(650);
    expect(m.drawKW).toBe(475);
    expect(m.strandedKW).toBe(175);
    expect(m.extraRacks).toBe(1);
    expect(m.dynamicDrawKW).toBe(585);
    expect(m.dynamicDrawKW).toBeLessThanOrEqual(650);
    expect(m.headroomKW).toBe(65);
    expect(m.capDepth).toBeCloseTo(1 - 650 / (6 * 130), 12);
    expect(m.gpusPerMWStatic).toBeCloseTo(360 / 0.65, 9);
    expect(m.gpusPerMWDynamic).toBeCloseTo(432 / 0.65, 9);
    // default new-rack draw = the largest existing draw (109 kW) also admits exactly one rack; a 5 % reserve admits none
    expect(maxqModel(racks).extraRacks).toBe(1);
    expect(maxqModel(racks, { newRackDrawKW: 110, reserveFraction: 0.2 }).extraRacks).toBe(0);
  });

  it('analyzeMaxQ: catalog Max-P basis, workload draw, stranded = budget − draw', () => {
    const q = analysis.power.maxq!;
    expect(q.racks).toBe(96);
    expect(q.budgetKW).toBe(96 * 136);
    expect(q.strandedKW).toBeCloseTo(q.budgetKW - q.drawKW, 9);
    expect(q.gpusPerMWDynamic).toBeGreaterThanOrEqual(q.gpusPerMWStatic);
    expect(q.source).toMatch(/worked example/);
    expect(analyzeMaxQ({ ...project, equipment: [] }, analysis)).toBeUndefined();
  });

  it('budget basis: Σ allocation by default, hall IT budget or custom kW on request; network share removed without clamping', () => {
    const q = analysis.power.maxq!;
    expect(q.budgetBasis).toBe('allocation');
    expect(q.budgetKW).toBe(q.allocatedKW);
    expect(q.utilization!).toBeGreaterThan(0);
    expect(q.utilization!).toBeLessThan(1);
    expect(q.networkShareKW!).toBeGreaterThan(0);
    expect(q.drawKW).toBeCloseTo(q.utilization! * q.allocatedKW!, 6);
    const hall = clone(project);
    hall.power.maxq = { budgetBasis: 'hall-budget' };
    const qa = analyzeProject(hall);
    const h = qa.power.maxq!;
    const gpuKW = 96 * 136 * hall.power.diversityFactor;
    const hallRow = qa.power.perHall.find((r) => r.itKW > 0)!;
    expect(h.budgetBasis).toBe('hall-budget');
    expect(h.budgetKW).toBeCloseTo(hallRow.budgetKW - (hallRow.itKW - gpuKW), 6);
    const custom = clone(project);
    custom.power.maxq = { budgetBasis: 'custom', budgetKW: 20_000 };
    expect(analyzeProject(custom).power.maxq!.budgetKW).toBe(20_000);
  });

  it('Vera Rubin allocation basis is selectable: MaxLPS docs 227 kW vs blog 136 kW (static Max-Q 101 kW)', () => {
    const vr = clone(project);
    for (const e of vr.equipment) if (e.catalogId === 'nvidia-gb300-nvl72') e.catalogId = 'nvidia-vr-nvl72';
    const docs = analyzeMaxQ(vr, analyzeProject(vr))!;
    expect(docs.allocationKWPerRack).toBe(227);
    expect(docs.sources?.some((s) => /^NVIDIA MaxLPS documentation, overview page/.test(s.label))).toBe(true);
    vr.power.maxq = { vrBasis: 'maxlps-blog' };
    const blog = analyzeMaxQ(vr, analyzeProject(vr))!;
    expect(blog.allocationKWPerRack).toBe(136);
    expect(blog.staticMaxQ).toMatchObject({ settingKW: 101, maxpKW: 136, racks: Math.floor((96 * 136) / 101) });
    expect(blog.staticMaxQ!.gainPct).toBeCloseTo((136 / 101 - 1) * 100, 9);
  });
});
