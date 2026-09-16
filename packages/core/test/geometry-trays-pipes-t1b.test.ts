// T1b (docs/research/backlog-T1b.md): tray junctions and lead-ins, per-tier trays, the derived-pipe routing rule and its clearance
// audit, trunk bundles vs feeders and the feeder headroom report. Every case is built in memory (nothing under data/ is read or written).
import { describe, expect, it } from 'vitest';
import {
  addHall, analyzeProject, auditHallGeometry, autoSizeHall, buildHallPipes, buildTierTrays, buildTrays, createNvidiaReferenceProject, defaultSpinePlacement,
  defaultWaveStart, detectRowGroups, layoutOptionsFromProject, LEAD_IN_MAX_M, pipeOdM, resolveLayoutTemplate, TCS_BUSWAY_BAND_HALF_M, TCS_PIPE_CLEARANCE_M,
  type AutoSizeRequest, type Hall, type Project, type RowGroup,
} from '../src/index.ts';

const hall = (w = 30, d = 20): Hall => ({ id: 'h', name: 'h', origin: { x: 0, y: 0 }, width: w, depth: d, clearHeight: 6, trayHeight: 2.9, keepouts: [] } as unknown as Hall);
const row = (id: string, a0: number, a1: number, center: number, frontSign: 1 | -1 = -1, podId = id): RowGroup => ({ id, hallId: 'h', podId, kind: 'compute', axis: 'x', a0, a1, center, frontSign, memberIds: [] });
const refHallA = (): Project => {
  const p = structuredClone(createNvidiaReferenceProject().project);
  p.halls = p.halls.filter((h) => h.id === 'hall-a');
  return p;
};

/** the Layout panel's auto-size request for a new hall (as test/autosize.test.ts) */
function autoSized(templateId: string, gpu: string | undefined, pods: number, growth: 'phased' | 'single-build' = 'phased') {
  const base = structuredClone(createNvidiaReferenceProject().project);
  if (growth !== (base.growth ?? 'phased')) {
    base.growth = growth;
    base.network.scaleOut.spinePlacement = defaultSpinePlacement(growth);
    base.network.scaleOut.separateRoom = false;
  }
  const { project: p, hallId } = addHall(base, {});
  const h = p.halls.find((x) => x.id === hallId)!;
  const o = layoutOptionsFromProject(p, h);
  const tpl = resolveLayoutTemplate(templateId, { project: p })!;
  const req: AutoSizeRequest = {
    templateId,
    template: { ...tpl.pod, cduCatalogId: o.template.cduCatalogId, cduRedundancy: o.template.cduRedundancy, oversubscription: o.template.oversubscription, ...(gpu ? { gpuRackCatalogId: gpu } : {}), accelerators: [] },
    pods, services: { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 }, crahCatalogId: o.crahCatalogId, marginM: 1, podsPerWave: 2,
    waveStart: defaultWaveStart(p, hallId), autoSize: true, crahStrategy: tpl.defaults.crahStrategy, servicesZone: 'auto', grid: { auto: true, orientation: 'x', columns: 1 }, crahWalls: 'auto',
  };
  const r = autoSizeHall(p, hallId, req);
  if (!r.ok) throw new Error(`${templateId} did not fit`);
  return { p, hallId, a: r.analysis };
}

describe('T1b §1 tray junctions (hand-checked)', () => {
  it('a short row cluster gets a full-band main tray, a junction drop where it passes over a longer row, and a lead-in across the cross aisle', () => {
    // P1 (1..13) and P2 (15..27) are one pod line (tray at c 4.7); S (1..7) is a short services row (tray at c 8.7)
    const trays = buildTrays(hall(), [row('P1', 1, 13, 5), row('P2', 15, 27, 5), row('S', 1, 7, 9)], []);
    const byId = new Map(trays.map((t) => [t.id, t]));
    // clusters by row end: S (7) → main x1 at 7.45, P1 (13) → x2 at 13.45, P2 (27) → x3 at 27.45; every main spans c 4.55 … 8.85
    for (const id of ['tray-main-x1', 'tray-main-x2', 'tray-main-x3']) {
      const m = byId.get(id)!;
      expect([m.points[0].y, m.points[m.points.length - 1].y]).toEqual([4.55, 8.85]);
    }
    expect(byId.get('tray-main-x1')!.points.map((p) => p.y)).toEqual([4.55, 4.7, 8.7, 8.85]);
    // J2: x1 (a 7.45) passes over P1's row tray → junction drop with stubs (row tray side 7.30, main side c 4.85)
    expect(byId.get('drop-P1-x-x1')!.points).toEqual([{ x: 7.3, y: 4.7, z: 2.9 }, { x: 7.45, y: 4.7, z: 2.9 }, { x: 7.45, y: 4.7, z: 3.25 }, { x: 7.45, y: 4.85, z: 3.25 }]);
    // J3: P2 starts 1.55 m past x2 (≤ LEAD_IN_MAX_M) → lead-in from its start back to x2
    expect(15 - 13.45).toBeLessThanOrEqual(LEAD_IN_MAX_M);
    expect(byId.get('drop-P2-lead-x2')!.points).toEqual([{ x: 15, y: 4.7, z: 2.9 }, { x: 13.45, y: 4.7, z: 2.9 }, { x: 13.45, y: 4.7, z: 3.25 }, { x: 13.45, y: 4.85, z: 3.25 }]);
    // no junction where a main does not pass over a row (x2 at 13.45 is beyond S; x3 is beyond every row)
    expect(trays.filter((t) => /-x-x[23]$/.test(t.id))).toEqual([]);
    for (const t of trays) for (const p of t.points) expect(p.x > 0 && p.x < 30 && p.y > 0 && p.y < 20).toBe(true);
  });

  it('the GB200-class single-build hall routes every run on the trays under 100 m (autosize matrix had 109 m through the far end of the main tray)', () => {
    const { p, hallId, a } = autoSized('rack-scale-liquid-du', 'nvidia-gb200-nvl72', 16, 'single-build');
    const ids = new Set(p.equipment.filter((e) => e.hallId === hallId).map((e) => e.id));
    const runs = a.network.cableRuns.filter((r) => ids.has(r.fromId) && ids.has(r.toId));
    expect(runs.length).toBeGreaterThan(1000);
    expect(runs.filter((r) => r.lengthM > 100)).toEqual([]);
    expect(Math.max(...runs.map((r) => r.lengthM))).toBeLessThan(90); // 86.5 m after the junctions (2026-09-15)
  }, 120_000);
});

describe('T1b §2 per-tier trays', () => {
  it('T2 (front-end + storage) and T3 (OOB) stack over every T1 row tray, inside the walls, off the network route set', () => {
    const p = refHallA();
    const h = p.halls[0];
    const rows = detectRowGroups(p, h);
    const tiers = buildTierTrays(h, rows, p.equipment);
    const t1 = buildTrays(h, rows, p.equipment).filter((t) => t.kind === 'row');
    // every T1 row tray carries a T2 and a T3 run (a T2 run may be split where a main tray crosses its level, QA backlog geometry)
    for (const tier of ['T2', 'T3']) expect(new Set(tiers.filter((t) => t.tier === tier).map((t) => t.id.replace(/-t[23](-\d+)?$/, '')))).toEqual(new Set(t1.map((x) => x.id)));
    expect(tiers.filter((t) => t.tier === 'T3')).toHaveLength(t1.length);
    for (const t of tiers) {
      const base = t1.find((x) => t.id.replace(/-t[23](-\d+)?$/, '') === x.id)!;
      const row = rows.find((r) => base.id === `tray-${r.id}`)!;
      // same row line, busway-side edge on T1's edge: a wider tier grows toward the cold aisle (QA backlog geometry)
      const off = (row.frontSign * Math.max(0, t.widthM - base.widthM)) / 2;
      const perp = (q: { x: number; y: number }) => (row.axis === 'x' ? q.y : q.x);
      const along = (q: { x: number; y: number }) => (row.axis === 'x' ? q.x : q.y);
      for (const q of t.points) {
        expect(perp(q)).toBeCloseTo(perp(base.points[0]) + off, 6);
        expect(along(q)).toBeGreaterThanOrEqual(Math.min(...base.points.map(along)) - 1e-6);
        expect(along(q)).toBeLessThanOrEqual(Math.max(...base.points.map(along)) + 1e-6);
      }
      expect(t.points[0].z).toBeCloseTo(t.tier === 'T2' ? 3.25 : 3.6, 6);
      expect(t.carries).toEqual(t.tier === 'T2' ? ['frontend', 'storage'] : ['oob']);
      for (const q of t.points) expect(q.x >= 0.05 - 1e-9 && q.x <= h.width - 0.05 + 1e-9 && q.y >= 0.05 - 1e-9 && q.y <= h.depth - 0.05 + 1e-9).toBe(true);
    }
    expect((p.trays ?? []).some((t) => t.tier)).toBe(false);
  });

  it('explicit Hall.verticals tiers are honoured (a tier carrying only main trays emits nothing)', () => {
    const p = refHallA();
    const h = p.halls[0];
    h.verticals = { tiers: [
      { id: 'T1', kind: 'tray', carries: ['scale-out'], z: 3.0, heightM: 0.1 },
      { id: 'T2', kind: 'tray', carries: ['main'], z: 3.4, heightM: 0.1 },
      { id: 'T3', kind: 'tray', carries: ['storage'], z: 3.8, heightM: 0.1, widthM: 0.6 },
    ] };
    const tiers = buildTierTrays(h, detectRowGroups(p, h), p.equipment);
    expect(new Set(tiers.map((t) => t.tier))).toEqual(new Set(['T3']));
    expect(tiers.every((t) => t.points[0].z === 3.8 && t.widthM === 0.6)).toBe(true);
  });
});

describe('T1b §3 derived-pipe routing rule', () => {
  it('REF: headers in the rear lane beyond the busway band, cross headers beyond the containment end, return jump below T1 (hand-checked)', () => {
    const p = refHallA();
    const h = p.halls[0];
    const rows = detectRowGroups(p, h);
    const net = buildHallPipes(p, h, rows);
    const c01a = rows.find((r) => r.id === 'pod-01-a')!.center;
    const run = (id: string) => net.runs.find((r) => r.id === id)!;
    // pod-01-a: centre 4.295, frontSign −1 (rear +y); supply DN from the row flow
    const s = run('tcs-S:pod-01-a:row');
    const od = pipeOdM(s.dnMM);
    expect(s.points[0].y).toBeCloseTo(c01a + TCS_BUSWAY_BAND_HALF_M + TCS_PIPE_CLEARANCE_M.value + od / 2, 5);
    // the contiguous row starts at x 5.1 (in-row CDUs included) → cross headers at 5.1 − 0.45 / 5.1 − 0.25
    const cs = run('tcs-S:pod-01:cross');
    const cr = run('tcs-R:pod-01:cross');
    expect(cs.points[0].x).toBeCloseTo(4.65, 6);
    expect(cr.points[0].x).toBeCloseTo(4.85, 6);
    const zS = cs.points[0].z;
    expect(cr.points[0].z - zS).toBeGreaterThanOrEqual((pipeOdM(cs.dnMM) + pipeOdM(cr.dnMM)) / 2 + TCS_PIPE_CLEARANCE_M.value - 1e-6);
    // every link and riser stays at the pipe tier except the return link's rise inside the cross zone
    for (const r of net.runs.filter((x) => x.part === 'link' || x.kind === 'riser')) {
      const zs = r.points.map((q) => q.z);
      if (r.kind === 'riser') expect(Math.max(...zs)).toBeLessThanOrEqual(zS + 1e-6);
      else for (let i = 0; i < r.points.length - 1; i++) if (r.points[i].z > zS + 1e-6) expect(r.points[i].x).toBeCloseTo(4.75, 6);
    }
  });

  it('pipe clearance audit is clean for REF, Helios-class, RCU, 16-pod and rows-Y halls (was 52 / 52 / 50 / 208 clashes before the rule)', () => {
    const cases: [string, () => { p: Project; hallId: string; a?: ReturnType<typeof analyzeProject> }][] = [
      ['REF', () => ({ p: refHallA(), hallId: 'hall-a' })],
      ['Helios 4 DU', () => autoSized('std-orw-liquid-sidecar-du', 'amd-helios-mi455x', 4)],
      ['RCU 4 DU', () => autoSized('rcu-row', undefined, 4)],
      ['16 DU', () => autoSized('rack-scale-liquid-du', undefined, 16)],
    ];
    for (const [name, mk] of cases) {
      const { p, hallId, a } = mk();
      const rep = auditHallGeometry(p, a ?? analyzeProject(p), hallId);
      expect({ name, clash: rep.counts['pipe-clash'] ?? 0, outside: rep.counts['pipe-outside'] ?? 0, trunk: rep.counts['feeder-trunk-clash'] ?? 0 }).toEqual({ name, clash: 0, outside: 0, trunk: 0 });
    }
  }, 240_000);

  it('negative control: a busway moved into the rear pipe lane is reported as a pipe clash', () => {
    const p = refHallA();
    const a = analyzeProject(p);
    const bus = (p.busways ?? []).find((b) => b.id === 'bus-B-pod-01-a')!;
    bus.points = bus.points.map((q) => ({ ...q, y: q.y + 0.25, z: 2.52 }));
    const rep = auditHallGeometry(p, a, 'hall-a');
    expect(rep.violations.some((v) => v.check === 'pipe-clash' && v.other === 'busway:bus-B-pod-01-a')).toBe(true);
  });
});

describe('T1b §5 feeder headroom', () => {
  it('a low clear height reports the top feeder layer, its z and a remedy hint', () => {
    const p = refHallA();
    p.halls[0].clearHeight = 4.2;
    const rep = auditHallGeometry(p, analyzeProject(p), 'hall-a');
    const v = rep.violations.find((x) => x.check === 'feeder-headroom' || x.check === 'feeder-stack-high')!;
    expect(v).toBeDefined();
    expect(v.tier).toMatch(/^feeder layer \d+ of \d+ · z \d/);
    expect(['second-feeder-level', 'split-electrical-rooms']).toContain(v.hint);
    expect(v.depthM!).toBeGreaterThan(0);
  });

  it('the reference hall (6 m clear) has no headroom report', () => {
    const p = refHallA();
    const rep = auditHallGeometry(p, analyzeProject(p), 'hall-a');
    expect(rep.violations.filter((x) => x.check.startsWith('feeder-headroom') || x.check === 'feeder-stack-high')).toEqual([]);
  });
});
