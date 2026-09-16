import { describe, expect, it } from 'vitest';
import { analyzeProject, applyHallLayout, CORRIDOR_DEFAULTS, createNvidiaReferenceProject, findCatalogItem, fitToSpace, layoutOptionsFromProject, polylineInside, relayoutForPlacement, type FitOptions, type Project } from '../src/index.ts';

/** Fit-to-space and the spine-placement relayout hook (PROPOSAL-v2 §3.1 / §3.2, stream S1). */

function whiteSpace(width = 48, depth = 60): { project: Project; hallId: string } {
  const { project } = createNvidiaReferenceProject({ pods: 4 });
  const hall = project.halls[1]; // empty phase-2 hall
  hall.width = width;
  hall.depth = depth;
  hall.itPowerBudgetKW = 40_000;
  hall.liquidCoolingBudgetKW = 36_000;
  hall.airCoolingBudgetKW = 12_000;
  project.site.utility.forEach((u) => (u.capacityMVA = 1e6));
  return { project, hallId: hall.id };
}

const POLICY: FitOptions['policy'] = { templateId: 'rack-scale-liquid-du', orientation: 'x', corridors: CORRIDOR_DEFAULTS, crahStrategy: 'perimeter', crahWalls: ['W', 'E'], objective: 'max-gpus' };

describe('fitToSpace', () => {
  const { project, hallId } = whiteSpace();
  const hall = project.halls.find((h) => h.id === hallId)!;
  const cands = fitToSpace(project, hall, { policy: POLICY, top: 3 });

  it('returns at most 3 candidates, best score first, every one inside the hall', () => {
    expect(cands.length).toBeGreaterThan(0);
    expect(cands.length).toBeLessThanOrEqual(3);
    // objective bucket first (max-gpus: GPU count, clean candidates before ones with errors); ties → rows along the long side (T1)
    for (let i = 1; i < cands.length; i++) {
      const [p, q] = [cands[i - 1], cands[i]];
      const bp = (p.errors > 0 ? -1e12 : 0) + p.gpus;
      const bq = (q.errors > 0 ? -1e12 : 0) + q.gpus;
      expect(bp).toBeGreaterThanOrEqual(bq);
      if (bp === bq) expect(Number(p.rowsAlongLongSide)).toBeGreaterThanOrEqual(Number(q.rowsAlongLongSide));
    }
    for (const c of cands) {
      expect(c.layout.requiredWidth).toBeLessThanOrEqual(hall.width + 1e-6);
      expect(c.layout.requiredDepth).toBeLessThanOrEqual(hall.depth + 1e-6);
      expect(c.layout.trays.every((t) => polylineInside(t.points, hall))).toBe(true);
      expect(c.layout.busways.every((b) => polylineInside(b.points, hall))).toBe(true);
      expect(c.gpus).toBeGreaterThan(0);
      expect(c.pods).toBeGreaterThan(0);
      expect(c.columns * c.rows).toBeGreaterThanOrEqual(c.pods);
      expect(['space', 'power', 'cooling', 'none']).toContain(c.limitedBy);
      expect(c.crah.placed).toBeGreaterThanOrEqual(c.crah.required);
      expect(c.policy.grid).toEqual({ columns: c.columns, rows: c.rows });
    }
  });

  it('uses several pod columns in a wide hall and respects the hall budgets', () => {
    const best = cands[0];
    expect(best.columns).toBeGreaterThan(1);
    expect(best.itKW).toBeLessThanOrEqual(hall.itPowerBudgetKW + 1);
    expect(best.errors).toBe(0);
  });

  it('is deterministic', () => {
    const again = fitToSpace(project, hall, { policy: POLICY, top: 3 });
    expect(again.map((c) => [c.id, c.gpus, c.score])).toEqual(cands.map((c) => [c.id, c.gpus, c.score]));
  });

  it('honours maxPods and reports the limiting factor', () => {
    const limited = fitToSpace(project, hall, { policy: POLICY, top: 1, maxPods: 2, orientations: ['x'], spinePlacements: ['central-end'] });
    expect(limited[0].pods).toBe(2);
    const tight = { ...hall, itPowerBudgetKW: 3_500 };
    const byPower = fitToSpace(project, tight, { policy: POLICY, top: 1, orientations: ['x'], spinePlacements: ['central-end'] });
    expect(byPower[0].pods).toBe(1);
    expect(byPower[0].limitedBy).toBe('power');
  });

  it('applies a candidate into the project (hall unchanged, policy recorded, trays/busways stored)', () => {
    const c = cands[0];
    const draft = structuredClone(project);
    applyHallLayout(draft, hallId, c.layout, c.options, { policy: c.policy });
    const h = draft.halls.find((x) => x.id === hallId)!;
    expect([h.width, h.depth]).toEqual([hall.width, hall.depth]);
    expect(h.layoutPolicy).toEqual(c.policy);
    expect(draft.trays!.filter((t) => t.hallId === hallId).length).toBe(c.layout.trays.length);
    expect(draft.equipment.filter((e) => e.hallId === 'hall-a').length).toBe(project.equipment.length);
    // ids of the second hall never collide with hall A
    expect(new Set(draft.equipment.map((e) => e.id)).size).toBe(draft.equipment.length);
    // … nor do pod / row / containment / tray / busway ids (QA-layout-v2 F1): hall B numbers its pods after hall A
    const podsA = new Set(draft.equipment.filter((e) => e.hallId === 'hall-a' && e.podId).map((e) => e.podId));
    const podsB = new Set(draft.equipment.filter((e) => e.hallId === hallId && e.podId).map((e) => e.podId));
    expect([...podsB].filter((p) => podsA.has(p))).toEqual([]);
    expect([...podsB].filter((p) => /^pod-\d+$/.test(p ?? '')).every((p) => Number(p!.slice(4)) >= 5)).toBe(true);
    const rowsA = new Set(draft.equipment.filter((e) => e.hallId === 'hall-a' && e.rowId).map((e) => e.rowId));
    expect(draft.equipment.filter((e) => e.hallId === hallId && e.rowId).some((e) => rowsA.has(e.rowId))).toBe(false);
    expect(new Set(draft.containments.map((x) => x.id)).size).toBe(draft.containments.length);
    expect(new Set(draft.trays!.map((x) => x.id)).size).toBe(draft.trays!.length);
    expect(new Set(draft.busways!.map((x) => x.id)).size).toBe(draft.busways!.length);
    // tags are the generator's own (DU05-…), not prefixed from the hall name
    expect(draft.equipment.filter((e) => e.hallId === hallId).every((e) => !/^2-/.test(e.tag))).toBe(true);
    const a = analyzeProject({ ...draft, trays: undefined, busways: undefined });
    expect(a.summary.gpus).toBe(6912 + c.gpus);
    // waves: hall A's pods stay in their waves, hall B's pods never merge into them
    for (const w of draft.schedule.waves) expect(new Set(w.podIds).size).toBe(w.podIds.length);
  });

  it('notches rack positions that collide with a column keepout and reports them', () => {
    const { project: p2, hallId: h2 } = whiteSpace(30, 40);
    const hall2 = p2.halls.find((h) => h.id === h2)!;
    // put the column on a GPU rack of the column-free layout (the pod area is centred in a hall wider than the layout, fix v2 2차)
    const free = fitToSpace(p2, hall2, { policy: POLICY, top: 1, orientations: ['x'], spinePlacements: ['central-end'] });
    const target = free[0].layout.equipment.find((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack')!;
    const cx = target.position.x;
    const cy = target.position.y;
    hall2.keepouts = [{ id: 'col', kind: 'column', rect: { x: cx - 0.3, y: cy - 0.3, w: 0.6, d: 0.6 }, label: 'C1' }];
    const r = fitToSpace(p2, hall2, { policy: POLICY, top: 1, orientations: ['x'], spinePlacements: ['central-end'] });
    expect(r.length).toBe(1);
    expect(r[0].lostPositions).toBeGreaterThan(0);
    for (const e of r[0].layout.equipment) {
      const item = findCatalogItem(e.catalogId)!;
      const overlaps = Math.abs(e.position.x - cx) < item.dims.w / 2 + 0.3 && Math.abs(e.position.y - cy) < item.dims.d / 2 + 0.3;
      expect(overlaps, e.tag).toBe(false);
    }
  });

  it('objective min-cable prefers cheaper cabling per GPU', () => {
    const cheap = fitToSpace(project, hall, { policy: { ...POLICY, objective: 'min-cable' }, top: 3 });
    expect(cheap.length).toBeGreaterThan(0);
    // 1 % score buckets: within a bucket the long-side / fewer-columns tie-break may reorder by at most ~1 %
    for (let i = 1; i < cheap.length; i++) expect(cheap[i - 1].cableUSD / cheap[i - 1].gpus).toBeLessThanOrEqual((cheap[i].cableUSD / cheap[i].gpus) * 1.02 + 1e-6);
  });
});

describe('relayoutForPlacement (contract for the S2 placement comparator)', () => {
  const { project } = createNvidiaReferenceProject({ pods: 4 });
  const podYsOf = (p: Project) => p.equipment.filter((e) => e.podId?.startsWith('pod-0') && findCatalogItem(e.catalogId)?.category === 'gpu-rack').map((e) => e.position.y);
  const podYs = podYsOf(project);
  const core = (p: Project) => p.equipment.filter((e) => e.hallId === 'hall-a' && (e.networkRole === 'scale-out-spine' || e.networkRole === 'scale-out-core'));

  it('keeps the signature (project, hallId, placement) and never mutates the input', () => {
    const before = JSON.stringify(project);
    const out = relayoutForPlacement(project, 'hall-a', 'central-center');
    expect(JSON.stringify(project)).toBe(before);
    expect(out).not.toBe(project);
    expect(out.network.scaleOut.spinePlacement).toBe('central-center');
  });

  it('central-end: core rows beyond the last pod row', () => {
    const out = relayoutForPlacement(project, 'hall-a', 'central-end');
    expect(core(out).every((e) => e.position.y > Math.max(...podYs))).toBe(true);
    expect(core(out).every((e) => e.podId === 'pod-services')).toBe(true);
  });

  it('central-center: core rows between the middle pod rows', () => {
    const out = relayoutForPlacement(project, 'hall-a', 'central-center');
    const ys = core(out).map((e) => e.position.y);
    const py = podYsOf(out);
    expect(Math.min(...ys)).toBeGreaterThan(Math.min(...py));
    expect(Math.max(...ys)).toBeLessThan(Math.max(...py));
    // two pod rows above, two below
    expect(py.filter((y) => y < Math.min(...ys)).length).toBe(py.filter((y) => y > Math.max(...ys)).length);
  });

  it('distributed: spine racks appended to each pod row with the pod\'s rowId / podId', () => {
    const out = relayoutForPlacement(project, 'hall-a', 'distributed');
    const spines = core(out);
    expect(spines.length).toBeGreaterThan(0);
    for (const s of spines) {
      expect(s.podId).toMatch(/^pod-\d+$/);
      expect(s.rowId).toBe(`${s.podId}-${/-([ab])-/i.exec(s.tag)![1].toLowerCase()}`);
      expect(s.networkRole).toBe('scale-out-spine');
    }
    // every compute pod hosts at least one spine rack (QA-network-v2 #4): dealt round-robin over the pods
    const computePods = [...new Set(out.equipment.filter((e) => e.hallId === 'hall-a' && /^pod-\d+$/.test(e.podId ?? '')).map((e) => e.podId!))];
    const spinePods = new Set(spines.map((s) => s.podId));
    for (const p of computePods) expect(spinePods.has(p), `${p} hosts a spine rack`).toBe(true);
    const counts = computePods.map((p) => spines.filter((s) => s.podId === p).length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    const a = analyzeProject({ ...out, trays: undefined, busways: undefined });
    expect(a.issues.filter((i) => i.id.startsWith('network-unplaced'))).toEqual([]);
    // per-pod leaf→spine uplink lengths are balanced (no pod is left without a nearby spine)
    const meanByPod = computePods.map((p) => {
      const runs = a.network.cableRuns.filter((r) => r.tier === 'leaf-spine' && out.equipment.find((e) => e.id === r.fromId)?.podId === p);
      return runs.length ? runs.reduce((s, r) => s + r.lengthM * r.count, 0) / runs.reduce((s, r) => s + r.count, 0) : 0;
    });
    expect(Math.max(...meanByPod) / Math.max(1e-9, Math.min(...meanByPod))).toBeLessThan(2);
  });

  it('separate-room: a strip outside the pod area, offset by 3 m from the first pod row', () => {
    const out = relayoutForPlacement(project, 'hall-a', 'separate-room');
    const ys = core(out).map((e) => e.position.y);
    expect(Math.max(...ys)).toBeLessThan(Math.min(...podYsOf(out)));
    const first = Math.min(...out.equipment.filter((e) => e.podId === 'pod-01').map((e) => e.position.y));
    expect(first - Math.max(...ys)).toBeGreaterThanOrEqual(3);
    expect(out.network.scaleOut.separateRoom).toBe(true);
    expect(out.halls[0].depth).toBeGreaterThanOrEqual(project.halls[0].depth); // never shrinks
  });

  it('layoutOptionsFromProject reproduces the reference layout', () => {
    const hall = project.halls[0];
    const o = layoutOptionsFromProject(project, hall);
    expect(o.pods).toBe(4);
    expect(o.template.racksPerRow).toBe(12);
    expect(o.template.gpuRackCatalogId).toBe('nvidia-gb300-nvl72');
    expect(o.services).toEqual({ spineRacks: 'auto', storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 });
    expect(o.templateId).toBe('rack-scale-liquid-du');
  });
});
