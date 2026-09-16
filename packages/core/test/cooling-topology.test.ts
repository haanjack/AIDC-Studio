import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  compareCoolingTopologies,
  compareCoolingTopologiesForHall,
  coolingPlacementFor,
  createNvidiaReferenceProject,
  currentCoolingTopology,
  fanWallSeed,
  planTopologyPlacement,
  regenerateCoolingReport,
  SEED_INROW_CRV050,
  tcsLoopBudget,
  TCS_BUDGET,
  topologyPlacementOptions,
} from '../src/index.ts';

const { project } = createNvidiaReferenceProject();
const analysis = analyzeProject(project);
const rows = compareCoolingTopologiesForHall(project, analysis, 'hall-a');
const row = (o: string) => rows.find((r) => r.option === o)!;

describe('cooling topology comparison (T4, r2-platform.md §2.2)', () => {
  it('returns the five options, deterministically, and attaches them to the analysis', () => {
    expect(rows.map((r) => r.option)).toEqual(['gallery-fan-wall', 'perimeter-crah', 'in-row', 'sidecar-l2a', 'rdhx']);
    expect(compareCoolingTopologiesForHall(project, analysis, 'hall-a')).toEqual(rows);
    // hall B carries no IT heat → single-hall aggregate equals the hall rows (minus hallId)
    expect(analysis.cooling.topology?.map((r) => r.installedKW)).toEqual(rows.map((r) => r.installedKW));
    expect(compareCoolingTopologies(project, analysis)).toEqual(analysis.cooling.topology);
    expect(compareCoolingTopologiesForHall(project, analysis, 'hall-b')).toEqual([]);
  });

  it('marks the reference hall (perimeter CW375) as current and reproduces the cooling engine CRAH count', () => {
    expect(currentCoolingTopology(project, project.halls[0])).toBe('perimeter-crah');
    const b = row('perimeter-crah');
    expect(b.current).toBe(true);
    expect(rows.filter((r) => r.current)).toHaveLength(1);
    expect(b.units).toBe(analysis.cooling.perHall!.find((h) => h.hallId === 'hall-a')!.crahsRequired);
    expect(b.unitKW).toBe(375);
    expect(b.positionsLost).toBe(0);
    expect(b.costBasis).toBe('catalog');
  });

  it('applies the formulas: capacity + airflow count, redundancy, spare and fan heat', () => {
    // polish v2 2차: the gallery row uses the placeable catalog fan-wall item — the unit that "Place with this topology" puts in the hall —
    // instead of the CWA CA80 seed (500 kW), so the table and the placed hall agree. Stream C (P3, vendor-neutral core): the item is the
    // generic 600 kW fan-wall class (vendor 'Generic' first, capacity closest to 600 kW), no longer the vendor instance id
    const a = row('gallery-fan-wall');
    const fw = fanWallSeed();
    expect(fw.id).toBe('fanwall-generic-600');
    const hall = analysis.cooling.perHall!.find((h) => h.hallId === 'hall-a')!;
    const req = hall.airKW * (1 + fw.inputKW / fw.unitKW);
    expect(a.requiredKW).toBeCloseTo(req, 6);
    const n = Math.max(Math.ceil(req / fw.unitKW), Math.ceil((hall.airflowRequiredM3s * 1.1) / fw.airflowM3s));
    expect(a.unitsN).toBe(n);
    expect(a.units).toBe(n + 1); // crahRedundancy N+1
    expect(a.sparePct).toBeCloseTo(((a.units * fw.unitKW - req) / req) * 100, 6);
    expect(a.galleryM2).toBeCloseTo(a.units * fw.widthM * (fw.depthM + 1.2), 6);
    expect(a.relativeCost).toBe(1);
    expect(a.noteIds?.some((x) => x.key === 'cooling.topo.note.throwBoth')).toBe(true); // 21.6 m > 18 m throw
  });

  it('in-row and sidecars take rack positions; fan wall / CRAH / RDHx do not', () => {
    const c = row('in-row');
    expect(c.redundancyGroup).toBe('pod');
    expect(c.positionsLost).toBe(c.units * SEED_INROW_CRV050.positionsPerUnit);
    expect(c.itKWDisplaced).toBeGreaterThan(0);
    expect(c.waterJoints).toBe(2 * c.units);
    const d = row('sidecar-l2a');
    expect(d.rackUnits).toBe(96); // one 200 kW L2A per GB300 NVL72 (liquid ≈ 117 kW > 70 kW CDU 70)
    expect(d.positionsLost).toBe(96);
    // sidecars relocate heat → room system carries liquid + air heat
    expect(d.requiredKW!).toBeGreaterThan(analysis.cooling.liquidHeatKW + analysis.cooling.airHeatKW);
    expect(d.facilityWaterInHall).toBe(false);
    const e = row('rdhx');
    expect(e.positionsLost).toBe(0);
    expect(e.rackUnits).toBeGreaterThan(0);
    expect(e.worstFailureResidualPct!).toBeGreaterThanOrEqual(100); // room covers the residual plus one failed door
    for (const r of rows) {
      expect(Number.isFinite(r.relativeCost)).toBe(true);
      expect(r.coefficients?.length).toBeGreaterThan(0);
      for (const k of r.coefficients!) expect(['measured-paper', 'vendor-claim', 'acceptance-threshold', 'standard', 'official-config', 'derived', 'estimate', 'user']).toContain(k.sourceType);
      expect(r.notes.length).toBe(r.noteIds!.length);
    }
  });

  it('is empty for a project without IT heat', () => {
    const empty = { ...project, equipment: [] };
    expect(compareCoolingTopologies(empty, analyzeProject(empty))).toEqual([]);
  });

  it('maps options to regenerateCooling placement options', () => {
    const base = coolingPlacementFor(project.halls[0]);
    expect(topologyPlacementOptions('gallery-fan-wall', base)).toMatchObject({ cduPlacement: 'gallery', crahStrategy: 'gallery-fan-wall' });
    expect(topologyPlacementOptions('perimeter-crah', { ...base, cduPlacement: 'gallery' })).toMatchObject({ cduPlacement: 'row-ends', crahStrategy: 'perimeter' });
    expect(topologyPlacementOptions('in-row', base)?.crahStrategy).toBe('in-row');
    expect(topologyPlacementOptions('rdhx', base)).toBeUndefined();
  });

  it('estimates the CDU secondary-loop route against the 80 m / 60 m budget', () => {
    expect(TCS_BUDGET.budgetM).toBe(80);
    expect(TCS_BUDGET.warnM).toBe(60);
    const ends = tcsLoopBudget(project, 'hall-a', 'row-ends');
    const gallery = tcsLoopBudget(project, 'hall-a', 'gallery');
    expect(ends.map((p) => p.podId)).toEqual(['pod-01', 'pod-02', 'pod-03', 'pod-04']);
    for (let i = 0; i < ends.length; i++) {
      expect(gallery[i].equivalentM).toBeGreaterThan(ends[i].equivalentM);
      expect(gallery[i].equivalentM).toBeCloseTo(gallery[i].trunkM + gallery[i].headerM / 3, 9);
      expect(ends[i].status).toBe('ok');
    }
    // a gallery 100 m away blows the budget
    const far = { ...project, halls: project.halls.map((h) => (h.id === 'hall-a' ? { ...h, width: 230, coolingPlacement: { ...coolingPlacementFor(h), crahWalls: ['E' as const] } } : h)) };
    expect(tcsLoopBudget(far, 'hall-a', 'gallery').every((p) => p.status === 'over')).toBe(true);
  });

  it('places the compared topology: row units and installed kW = the post-placement analysis (polish v2 2차, QA M4)', () => {
    const base = coolingPlacementFor(project.halls[0]);
    for (const option of ['gallery-fan-wall', 'perimeter-crah', 'rdhx'] as const) {
      const r = row(option);
      const plan = planTopologyPlacement(project, analysis, 'hall-a', r, base, regenerateCoolingReport);
      expect(plan.available, option).toBe(true);
      expect(plan.matchesRow, option).toBe(true);
      const placed = plan.project!;
      const after = analyzeProject(placed);
      const ph = after.cooling.perHall!.find((h) => h.hallId === 'hall-a')!;
      const doors = placed.equipment.filter((e) => e.hallId === 'hall-a' && Number(e.meta?.rdhxDoorKW ?? 0) > 0);
      const doorKW = doors.reduce((s, e) => s + Number(e.meta!.rdhxDoorKW), 0);
      expect(ph.crahsPlaced + doors.length, option).toBe(r.units);
      expect(ph.crahCapacityKW + doorKW, option).toBeCloseTo(r.installedKW, 6);
      expect(ph.crahsPlaced, option).toBe(ph.crahsRequired);
      expect(after.issues.filter((i) => i.severity === 'error' && i.domain === 'cooling').map((i) => i.id), option).toEqual([]);
      const post = compareCoolingTopologiesForHall(placed, after, 'hall-a').find((x) => x.option === option)!;
      expect(post.current, option).toBe(true);
      expect(post.units, option).toBe(r.units);
      expect(post.installedKW, option).toBeCloseTo(r.installedKW, 6);
      // racks never move
      for (const e of project.equipment.filter((x) => x.hallId === 'hall-a' && x.tag.startsWith('DU'))) {
        const q = placed.equipment.find((x) => x.id === e.id);
        if (q && !/CDU|CRAH/.test(e.tag)) expect(q.position, e.tag).toEqual(e.position);
      }
    }
    const gallery = planTopologyPlacement(project, analysis, 'hall-a', row('gallery-fan-wall'), base, regenerateCoolingReport).project!;
    expect(gallery.equipment.filter((e) => e.hallId === 'hall-a' && e.catalogId === fanWallSeed().id)).toHaveLength(row('gallery-fan-wall').units);
    // in-row / sidecar: placeable only when a catalog unit of that class exists and the rows extend in place
    for (const option of ['in-row', 'sidecar-l2a'] as const) {
      const plan = planTopologyPlacement(project, analysis, 'hall-a', row(option), base, regenerateCoolingReport);
      if (plan.available) expect(plan.matchesRow).toBe(true);
      else expect(plan.reason).toMatch(/^cooling\.topo\.(unitClassPending|inPlacePending)$/);
    }
  });

  it('row semantics: sourced constants, rated vs duty for doors, largest-unit failure named (polish v2 2차, QA m6)', () => {
    for (const r of rows) {
      const keys = r.coefficients!.map((c) => c.key);
      expect(keys, r.option).toContain('airflowMargin');
      expect(keys, r.option).toContain('fanFloor');
      expect(r.worstFailureUnit, r.option).toBeTruthy();
    }
    expect(row('sidecar-l2a').coefficients!.map((c) => c.key)).toContain('service');
    expect(row('perimeter-crah').coefficients!.map((c) => c.key)).toContain('frontClearance');
    const e = row('rdhx');
    expect(e.installedKW).toBeCloseTo(e.rackUnits! * 75 + (e.units - e.rackUnits!) * 375, 6);
    expect(e.rackDutyKW!).toBeLessThan(e.rackUnits! * 75);
    expect(e.worstFailureUnit).toBe(row('perimeter-crah').unitLabel);
    expect(row('sidecar-l2a').worstFailureUnit).toBe(fanWallSeed().product);
  });
});
