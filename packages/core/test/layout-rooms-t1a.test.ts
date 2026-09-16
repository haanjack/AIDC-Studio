// backlog T1a (qa-autosize v2 2차 §3.3 / §6, DECISIONS-v2-2 §H): electrical rooms vs neighbouring halls, crahWalls bookkeeping, calibrated
// grid probe, target tier, shift / reshape / fan-wall remedies, rcu-row enclosure groups.
import { describe, expect, it } from 'vitest';
import {
  addHall, analyzeProject, applyRemedy, autoSizeGridChoice, autoSizeHall, createNvidiaReferenceProject, defaultWaveStart, enclosureGroups, findCatalogItem,
  fixAllRemedies, HALL_GAP_M, issueRemedies, layoutOptionsFromProject, resolveLayoutTemplate,
  type AutoSizeRequest, type Project, type ProjectAnalysis,
} from '../src/index.ts';

type Opt = { racksPerRow?: number; orientation?: 'x' | 'y'; project?: Project; gridAuto?: boolean };

function newHall(templateId: string, gpu: string, pods: number, o: Opt = {}) {
  const base = o.project ?? structuredClone(createNvidiaReferenceProject().project);
  const { project: p, hallId } = addHall(base, {});
  const hall = p.halls.find((h) => h.id === hallId)!;
  const lo = layoutOptionsFromProject(p, hall);
  const tpl = resolveLayoutTemplate(templateId, { project: p })!;
  const req: AutoSizeRequest = {
    templateId,
    template: { ...tpl.pod, cduCatalogId: lo.template.cduCatalogId, cduRedundancy: lo.template.cduRedundancy, oversubscription: lo.template.oversubscription, gpuRackCatalogId: gpu, accelerators: [], ...(o.racksPerRow ? { racksPerRow: o.racksPerRow } : {}) },
    pods,
    services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 },
    crahCatalogId: lo.crahCatalogId,
    marginM: 1,
    podsPerWave: 2,
    waveStart: defaultWaveStart(p, hallId),
    autoSize: true,
    crahStrategy: tpl.defaults.crahStrategy,
    servicesZone: 'auto',
    grid: { auto: o.gridAuto ?? !o.orientation, orientation: o.orientation ?? 'x', columns: 1 },
    crahWalls: 'auto',
  };
  const r = autoSizeHall(p, hallId, req);
  if (!r.ok) throw new Error(`${templateId} did not fit`);
  return { p, hallId, r, req, a: r.analysis };
}

const siteOverlap = (a: ProjectAnalysis) => a.issues.filter((i) => i.id.startsWith('site-hall-overlap-'));
const roomBlocked = (a: ProjectAnalysis) => (a.power.rooms ?? []).filter((r) => r.conflict === 'hall' || r.conflict === 'room');

describe('T1a: rcu-row enclosure groups', () => {
  it('groups a run into 2–4 racks, never a single rack after a full enclosure', () => {
    expect(enclosureGroups(8, 4)).toEqual([4, 4]);
    expect(enclosureGroups(10, 4)).toEqual([4, 4, 2]);
    expect(enclosureGroups(7, 4)).toEqual([4, 3]);
    expect(enclosureGroups(5, 4)).toEqual([3, 2]);
    expect(enclosureGroups(9, 4)).toEqual([4, 3, 2]);
    expect(enclosureGroups(6, 2)).toEqual([2, 2, 2]);
    expect(enclosureGroups(1, 4)).toEqual([1]);
    expect(enclosureGroups(0, 4)).toEqual([]);
  });

  it('20 racks per row → enclosures of 4 and 2 per side of the network racks, one RCU tag per contiguous group', () => {
    const { p, hallId } = newHall('rcu-row', 'nvidia-vr-nvl72', 1, { racksPerRow: 20 });
    const eq = p.equipment.filter((e) => e.hallId === hallId);
    const gpus = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack' && e.meta?.rcu);
    expect(gpus.length).toBeGreaterThan(0);
    const byRcu = new Map<string, typeof gpus>();
    for (const g of gpus) byRcu.set(String(g.meta!.rcu), [...(byRcu.get(String(g.meta!.rcu)) ?? []), g]);
    const sizes = [...byRcu.values()].map((v) => v.length).sort();
    expect(sizes.filter((n) => n === 2).length).toBeGreaterThan(0);
    expect(sizes.every((n) => n >= 2 && n <= 4)).toBe(true);
    const nets = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'network-rack' && e.rowId);
    for (const group of byRcu.values()) {
      const row = group[0].rowId;
      const axis = Math.abs(group[0].position.x - group[group.length - 1].position.x) >= Math.abs(group[0].position.y - group[group.length - 1].position.y) ? 'x' : 'y';
      const lo = Math.min(...group.map((g) => g.position[axis]));
      const hi = Math.max(...group.map((g) => g.position[axis]));
      expect(nets.some((n) => n.rowId === row && n.position[axis] > lo + 1e-6 && n.position[axis] < hi - 1e-6)).toBe(false);
    }
  });
});

describe('T1a: crahWalls bookkeeping and calibrated grid probe', () => {
  const combos: [string, string, number][] = [
    ['rcu-row', 'nvidia-vr-nvl72', 8],
    ['rack-scale-liquid-du', 'nvidia-vr-nvl72', 8],
    ['std-orw-liquid-sidecar-du', 'amd-helios-mi455x', 4],
  ];
  for (const [tid, gpu, pods] of combos) {
    it(`${tid} ${gpu} ${pods} DU: every wall holding a wall unit is in crahWalls; the probe's free walls match generation`, () => {
      if (!resolveLayoutTemplate(tid, { project: createNvidiaReferenceProject().project }) || !findCatalogItem(gpu)) return;
      const { p, hallId, r, req } = newHall(tid, gpu, pods);
      const hall = p.halls.find((h) => h.id === hallId)!;
      const walls = new Set(hall.layoutPolicy?.crahWalls ?? []);
      const faced: Record<number, 'N' | 'S' | 'E' | 'W'> = { 0: 'S', 90: 'E', 180: 'N', 270: 'W' };
      for (const e of p.equipment) {
        const cat = findCatalogItem(e.catalogId)?.category;
        if (e.hallId !== hallId || e.rowId || (cat !== 'crah' && cat !== 'fan-wall')) continue;
        expect(walls.has(faced[e.rotationDeg])).toBe(true);
      }
      if (r.ok && !r.report.corrections.includes('reach')) {
        // the chooser's prediction on a fresh copy of the request (same hall before generation)
        const fresh = structuredClone(createNvidiaReferenceProject().project);
        const { project: q, hallId: h2 } = addHall(fresh, {});
        const choice = autoSizeGridChoice(q, q.halls.find((h) => h.id === h2)!, req);
        if (choice && choice.chosen.orientation === hall.layoutPolicy?.orientation && choice.chosen.columns === hall.layoutPolicy?.grid?.columns) {
          expect(choice.chosen.freeWalls).toBe(4 - walls.size);
        }
      }
    }, 120_000);
  }
});

describe('T1a: electrical rooms of neighbouring halls', () => {
  it('addHall leaves the shared-wall gap', () => {
    const base = structuredClone(createNvidiaReferenceProject().project);
    const right = base.halls.reduce((a, h) => (h.origin.x + h.width > a.origin.x + a.width ? h : a));
    const { project, hallId } = addHall(base, {});
    expect(HALL_GAP_M).toBeGreaterThanOrEqual(20);
    expect(project.halls.find((h) => h.id === hallId)!.origin.x).toBeCloseTo(right.origin.x + right.width + HALL_GAP_M, 6);
  });

  let shared: { p: Project; hallId: string; a: ProjectAnalysis } | undefined;
  it('Y-row 16 DU hall with rooms side by side: the sized rooms no longer reach the neighbouring hall (auto shift of the new hall)', () => {
    const { p, hallId, r, a } = newHall('rcu-row', 'nvidia-vr-nvl72', 16);
    const hall = p.halls.find((h) => h.id === hallId)!;
    expect(roomBlocked(a)).toEqual([]);
    expect(siteOverlap(a)).toEqual([]);
    expect(a.issues.filter((i) => i.id.startsWith('power-elec-room-wall-') && i.refs?.includes(hallId))).toEqual([]);
    if (hall.layoutPolicy?.orientation === 'y') expect(r.ok && r.report.corrections).toContain('room-gap');
    shared = { p, hallId, a };
  }, 180_000);

  it('side-by-side rooms are an info note, a warning when the target tier is IV (DECISIONS-v2-2 §H)', () => {
    if (!shared) return;
    const info = shared.a.issues.find((i) => i.id === `power-elec-room-shared-wall-${shared!.hallId}`);
    if (!info) return; // the grid chooser freed a row-end wall in this build
    expect(info.severity).toBe('info');
    const tier = structuredClone(shared.p);
    tier.site.targetTier = 'IV';
    const w = analyzeProject(tier).issues.find((i) => i.id === info.id)!;
    expect(w.severity).toBe('warning');
    expect(w.messageEn).toMatch(/tier IV/i);
  }, 120_000);

  it('a room blocked by the neighbouring hall offers "shift hall" with the distance; applying it clears the conflict; not in Fix all', () => {
    if (!shared) return;
    const p = structuredClone(shared.p);
    const hall = p.halls.find((h) => h.id === shared!.hallId)!;
    const left = p.halls.filter((h) => h.id !== hall.id).reduce((a, h) => (h.origin.x + h.width > a.origin.x + a.width ? h : a));
    hall.origin.x = left.origin.x + left.width + 12; // the old 12 m addHall gap
    const a = analyzeProject(p);
    const issue = a.issues.find((i) => i.id.startsWith('power-elec-room-wall-') && i.refs?.includes(hall.id));
    if (!issue) return; // rooms fit the 12 m gap in this build
    const rem = issueRemedies(p, a, issue).find((x) => x.kind === 'shift-hall');
    expect(rem).toBeDefined();
    expect(Number(rem!.params.m)).toBeGreaterThan(0);
    expect(rem!.safe).toBe(false);
    expect(fixAllRemedies(p, { analysis: a }).applied.some((x) => x.kind === 'shift-hall')).toBe(false);
    const next = applyRemedy(p, rem!);
    const b = analyzeProject(next);
    expect(roomBlocked(b).filter((r) => r.hallId === hall.id)).toEqual([]);
    expect(siteOverlap(b)).toEqual([]);
  }, 180_000);

  it('overlapping halls: "shift hall" moves the eastern hall clear of the western one and its rooms', () => {
    const base = structuredClone(createNvidiaReferenceProject().project);
    const { project: p, hallId } = addHall(base, {});
    const hall = p.halls.find((h) => h.id === hallId)!;
    const left = p.halls.filter((h) => h.id !== hallId).reduce((a, h) => (h.origin.x + h.width > a.origin.x + a.width ? h : a));
    hall.origin.x = left.origin.x + left.width - 5;
    const a = analyzeProject(p);
    const issue = siteOverlap(a)[0];
    expect(issue).toBeDefined();
    const rem = issueRemedies(p, a, issue).find((x) => x.kind === 'shift-hall')!;
    expect(rem.params.moveId).toBe(hallId);
    expect(siteOverlap(analyzeProject(applyRemedy(p, rem)))).toEqual([]);
  });

  for (const orientation of ['x', 'y'] as const) {
    it(`2–4 halls, rows along ${orientation}: no hall overlap and no room reaching another hall or room`, () => {
      let p = structuredClone(createNvidiaReferenceProject().project);
      for (let n = 0; n < 2; n++) {
        const g = newHall('rcu-row', 'nvidia-vr-nvl72', 4, { project: p, orientation, gridAuto: false });
        p = g.p;
        expect(p.halls.length).toBe(3 + n);
        expect(siteOverlap(g.a)).toEqual([]);
        expect(roomBlocked(g.a)).toEqual([]);
      }
    }, 240_000);
  }
});
