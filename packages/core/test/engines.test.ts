import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  compareFabrics,
  createNvidiaReferenceProject,
  generateDesignDocument,
  type Project,
  type ProjectAnalysis,
} from '../src/index.ts';

const ref = () => createNvidiaReferenceProject().project;
const project = ref();
analyzeProject(project); // warm-up (JIT)
// backlog T3 (10): best of n runs (perf-r4.test.ts approach) — at least 3 samples; while the best is still over the limit keep sampling
// (≤ 25 runs, ≤ 8 s) so a quiet moment can be found when the parallel suite loads the machine. The 200 ms limit is unchanged.
const ANALYZE_LIMIT_MS = 200;
let elapsedMs = Infinity;
let a!: ProjectAnalysis;
const tStart = performance.now();
for (let i = 0; i < 25 && (i < 3 || (elapsedMs >= ANALYZE_LIMIT_MS && performance.now() - tStart < 8000)); i++) {
  const t0 = performance.now();
  const r = analyzeProject(project);
  elapsedMs = Math.min(elapsedMs, performance.now() - t0);
  a = r;
}

const without = (x: ProjectAnalysis) => ({ ...x, generatedAt: '' });

describe('reference project — summary & performance', () => {
  it('places 6,912 GPUs in 96 GB300 racks', () => {
    expect(a.summary.gpus).toBe(6912);
    expect(a.summary.gpuRacks).toBe(96);
  });

  it('analyzes in under 200 ms', () => {
    expect(elapsedMs).toBeLessThan(ANALYZE_LIMIT_MS);
  });

  it('is deterministic apart from generatedAt', () => {
    expect(without(analyzeProject(ref()))).toEqual(without(a));
  });

  it('reports zero error issues', () => {
    const errors = a.issues.filter((i) => i.severity === 'error');
    expect(errors.map((e) => e.message)).toEqual([]);
  });
});

describe('power', () => {
  it('IT load ≈ 14 MW and plausible PUE', () => {
    expect(a.summary.itMW).toBeGreaterThan(12);
    expect(a.summary.itMW).toBeLessThan(16);
    expect(a.power.pue).toBeGreaterThanOrEqual(1.1);
    expect(a.power.pue).toBeLessThanOrEqual(1.4);
    expect(a.power.designPue!).toBeGreaterThanOrEqual(a.power.pue);
    expect(a.power.facilityKW).toBeGreaterThan(a.power.itDesignKW);
  });

  it('installed infrastructure covers required capacity', () => {
    expect(a.power.ups.installedKVA).toBeGreaterThanOrEqual(a.power.ups.requiredKVA);
    expect(a.power.generators.installedKW).toBeGreaterThanOrEqual(a.power.generators.requiredKW);
    expect(a.power.transformers.installedKVA).toBeGreaterThanOrEqual(a.power.transformers.requiredKVA);
    expect(a.power.utilityRequiredMVA).toBeLessThanOrEqual(a.power.utilityAvailableMVA);
    // polish v2 2차: circuits follow the plane's profile continuous limit (reference IEC → 1.0), so compare with that limit
    expect(a.power.rpps.maxLoading).toBeLessThanOrEqual(a.power.rpps.limitFactor ?? project.power.deratingFactor);
  });

  it('builds a connected one-line diagram', () => {
    const ids = new Set(a.power.oneLine.nodes.map((n) => n.id));
    for (const e of a.power.oneLine.edges) {
      expect(ids.has(e.from), e.from).toBe(true);
      expect(ids.has(e.to), e.to).toBe(true);
    }
    expect(a.power.oneLine.nodes.filter((n) => n.kind === 'load')).toHaveLength(5); // 4 DUs + services
  });

  it('flags single-substation supply and insufficient firm capacity', () => {
    const p = ref();
    p.site.utility = p.site.utility.map((f) => ({ ...f, substation: 'Only S/S', capacityMVA: 12 }));
    const r = analyzeProject(p);
    expect(r.issues.some((i) => i.id === 'power-utility-single')).toBe(true);
    expect(r.issues.some((i) => i.id === 'power-utility-total' && i.severity === 'error')).toBe(false);
    p.site.utility = [{ ...p.site.utility[0], capacityMVA: 10 }];
    expect(analyzeProject(p).issues.some((i) => i.id === 'power-utility-total')).toBe(true);
  });
});

describe('cooling', () => {
  it('splits heat by liquid fraction and sizes CDUs/CRAHs', () => {
    expect(a.cooling.liquidHeatKW).toBeGreaterThan(10_000);
    expect(a.cooling.airHeatKW).toBeGreaterThan(1_500);
    expect(a.cooling.cdus.units * a.cooling.cdus.unitKW).toBeGreaterThanOrEqual(a.cooling.liquidHeatKW);
    expect(a.cooling.crahs.units * a.cooling.crahs.unitKW).toBeGreaterThanOrEqual(a.cooling.airHeatKW);
    expect(a.cooling.crahs.airflowM3s).toBeGreaterThanOrEqual(a.cooling.crahs.requiredAirflowM3s);
    // 96 × 92.6 LPM at 35 °C TCS supply (GB300 aif:spec curve)
    expect(a.cooling.cdus.tcsFlowLpm).toBeCloseTo(96 * 92.6, 0);
    expect(a.cooling.partialPue).toBeGreaterThan(1);
  });

  it('detects undersized CDUs when one is removed from a pod', () => {
    const p = ref();
    const cdus = p.equipment.filter((e) => e.podId === 'pod-01' && e.catalogId === 'vertiv-xdu2300');
    p.equipment = p.equipment.filter((e) => e.id !== cdus[0].id && e.id !== cdus[1].id);
    const r = analyzeProject(p);
    expect(r.issues.some((i) => i.id === 'cooling-cdu-under-pod-01' && i.severity === 'error')).toBe(true);
  });
});

describe('network & cabling', () => {
  const so = a.network.fabrics.find((f) => f.name.startsWith('Scale-out'))!;

  it('scale-out port math is consistent', () => {
    const [leaf, spine] = so.tiers;
    expect(so.endpoints).toBe(6912);
    expect(leaf.switches * leaf.downlinks).toBeGreaterThanOrEqual(so.endpoints);
    expect(spine.switches * spine.portsPerSwitch).toBeGreaterThanOrEqual(leaf.switches * leaf.uplinks);
    expect(leaf.switches).toBe(96);
    expect(spine.switches).toBe(48);
    expect(so.maxHops).toBe(3);
    expect(so.bisectionGbps).toBe((6912 * 800) / 2);
  });

  it('every GPU rack has scale-out cable runs covering all its NICs', () => {
    const gpuRacks = project.equipment.filter((e) => e.catalogId === 'nvidia-gb300-nvl72');
    for (const r of gpuRacks) {
      const links = a.network.cableRuns.filter((c) => c.fromId === r.id && c.fabric === so.name.replace('Scale-out · ', '')).reduce((s, c) => s + c.count, 0);
      expect(links, r.tag).toBe(72);
    }
    expect(a.network.unplacedSwitches).toEqual([]);
    expect(a.network.unconnectedLinks).toBe(0);
    expect(a.network.commEfficiency).toBeCloseTo(1, 5);
  });

  it('cable lengths are within the selected type reach', () => {
    expect(a.network.unreachableRuns).toEqual([]);
    const total = a.network.cablesByType.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(a.network.cableRuns.reduce((s, r) => s + r.count, 0));
  });

  it('breaks out 800G NICs onto 400G switches and goes 3-tier when radix is exceeded', () => {
    const p = ref();
    p.network.scaleOut = { ...p.network.scaleOut, fabric: 'ib-ndr-400', switchCatalogId: 'nvidia-qm9700' };
    const f = analyzeProject(p).network.fabrics[0];
    expect(f.endpoints).toBe(6912 * 2);
    expect(f.tiers.map((t) => t.name)).toEqual(['Leaf', 'Spine', 'Core']);
  });

  it('forcing 2 tiers beyond radix is infeasible', () => {
    const p = ref();
    p.network.scaleOut = { ...p.network.scaleOut, fabric: 'ib-ndr-400', switchCatalogId: 'nvidia-qm9700', tiers: 2 };
    expect(analyzeProject(p).issues.some((i) => i.id.startsWith('network-infeasible'))).toBe(true);
  });

  it('reports unplaced leaves when a pod loses its network racks', () => {
    const p = ref();
    p.equipment = p.equipment.filter((e) => !(e.podId === 'pod-02' && e.catalogId === 'network-rack-48u'));
    const r = analyzeProject(p);
    expect(r.issues.some((i) => i.domain === 'network' && i.severity === 'error')).toBe(true);
  });
});

describe('space validation', () => {
  it('flags overlaps, out-of-hall and unknown catalog items', () => {
    const p = ref();
    const rack = p.equipment.find((e) => e.tag === 'DU01-A-01')!;
    p.equipment.push({ ...rack, id: 'dup', tag: 'DUP' });
    p.equipment.push({ ...rack, id: 'far', tag: 'FAR', position: { x: 500, y: 500 } });
    p.equipment.push({ ...rack, id: 'ghost', tag: 'GHOST', catalogId: 'does-not-exist', position: { x: 1, y: 1 } });
    const ids = analyzeProject(p).issues.map((i) => i.id);
    expect(ids.some((i) => i.startsWith('space-overlap-'))).toBe(true);
    expect(ids).toContain('space-outside-far');
    expect(ids).toContain('space-unknown-ghost');
  });

  it('reports hall space metrics', () => {
    const hallA = a.space.find((s) => s.hallId === 'hall-a')!;
    expect(hallA.gpuCount).toBe(6912);
    expect(hallA.maxFloorLoadKgPerM2).toBeLessThan(1500);
    expect(hallA.whiteSpaceUtilization).toBeGreaterThan(0.2);
    expect(hallA.whiteSpaceUtilization).toBeLessThan(1);
    expect(hallA.clearanceViolations).toBe(0);
  });

  it('handles an empty project', () => {
    const p: Project = { ...ref(), equipment: [], containments: [] };
    const r = analyzeProject(p);
    expect(r.summary.gpus).toBe(0);
    expect(r.workloads.every((w) => w.gpus === 0)).toBe(true);
    expect(Number.isFinite(r.cost.capexUSD)).toBe(true);
  });
});

describe('schedule', () => {
  it('respects utility availability and dependencies', () => {
    const latestFeed = project.site.utility.map((f) => f.availableFrom).sort().at(-1)!;
    expect(a.schedule.readyForServiceDate >= latestFeed).toBe(true);
    const end = new Map(a.schedule.tasks.map((t) => [t.id, t.end]));
    for (const t of a.schedule.tasks) for (const d of t.dependsOn) expect(t.start >= end.get(d)!, `${t.id} after ${d}`).toBe(true);
    for (const f of project.site.utility) expect(a.schedule.tasks.find((t) => t.id === `utility-${f.id}`)!.start >= f.availableFrom).toBe(true);
  });

  it('has a critical path ending at handover and a monotone capacity ramp', () => {
    const crit = a.schedule.tasks.filter((t) => t.critical);
    expect(crit.length).toBeGreaterThan(0);
    expect(crit.some((t) => t.end === a.schedule.readyForServiceDate)).toBe(true);
    const ramp = a.schedule.capacityRamp;
    expect(ramp.at(-1)!.gpus).toBe(6912);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i].gpus).toBeGreaterThanOrEqual(ramp[i - 1].gpus);
  });

  it('warns when a wave target date is missed', () => {
    const p = ref();
    p.schedule.waves[0].targetReadyDate = '2027-01-01';
    const issues = analyzeProject(p).issues;
    expect(issues.some((i) => i.id === 'schedule-late-wave-01')).toBe(true);
    expect(issues.some((i) => i.id.startsWith('schedule-utility-') && i.severity === 'error')).toBe(true);
  });
});

describe('workloads', () => {
  const train = a.workloads.find((w) => w.workloadId === 'wl-pretrain-405b')!;
  const infer = a.workloads.find((w) => w.workloadId === 'wl-infer-moe')!;

  it('405B × 15T tokens on 5,504 of 6,912 GB300 (0.8 share) takes weeks to a few months', () => {
    // v2 2차: reference shares 0.8 / 0.2 (Σ = 1, no workload-share-over) → ⌊0.8 · 6,912 ÷ 32⌋ · 32 = 5,504 GPUs
    expect(a.summary.gpus).toBe(6912);
    expect(train.gpus).toBe(5504);
    expect(a.issues.some((i) => i.id === 'workload-share-over')).toBe(false);
    expect(train.timeToTrainDays!).toBeGreaterThan(14);
    expect(train.timeToTrainDays!).toBeLessThan(180);
    expect(train.mfu!).toBeGreaterThan(0.25);
    expect(train.mfu!).toBeLessThan(0.7);
    expect(train.goodput!).toBeGreaterThan(0.7);
    expect(train.goodput!).toBeLessThan(1);
    expect(train.powerTrace).toHaveLength(600);
    expect(train.peakPowerKW).toBeGreaterThanOrEqual(train.avgPowerKW * 0.95);
  });

  it('inference reports GPUs required within the allocation', () => {
    expect(infer.gpusRequired!).toBeGreaterThan(0);
    expect(infer.gpusRequired!).toBeLessThanOrEqual(infer.gpus);
    expect(infer.maxRequestsPerSec!).toBeGreaterThan(300);
    expect(infer.tpotMs!).toBeLessThanOrEqual(40.1);
    // P/D pools are sized independently: 19 × 8-GPU prefill + 5 × 8-GPU decode = 192 GPUs.
    expect(infer.gpusRequired).toBe(192);
    expect(infer.details?.memBandwidthGBps).toBeCloseTo(8 * 8000 * 0.85, 6);
  });

  it('rack-level smoothing narrows power swings', () => {
    const p = ref();
    p.power.powerSmoothing = 'none';
    const raw = analyzeProject(p).workloads.find((w) => w.workloadId === 'wl-pretrain-405b')!;
    const swing = (tr: { powerKW: number }[]) => Math.max(...tr.map((x) => x.powerKW)) - Math.min(...tr.map((x) => x.powerKW));
    expect(swing(train.powerTrace)).toBeLessThan(swing(raw.powerTrace));
  });
});

describe('compareFabrics', () => {
  const rows = compareFabrics(project, ['ib-xdr-800', 'ib-ndr-400', 'spectrumx-800', 'spectrumx-400', 'roce-generic-400']);
  const by = Object.fromEntries(rows.map((r) => [r.fabric, r]));

  it('returns one row per fabric in order', () => {
    expect(rows.map((r) => r.fabric)).toEqual(['ib-xdr-800', 'ib-ndr-400', 'spectrumx-800', 'spectrumx-400', 'roce-generic-400']);
  });

  it('IB XDR is the most efficient and fastest to train; generic RoCE the least efficient', () => {
    const eff = rows.map((r) => r.commEfficiency);
    expect(by['ib-xdr-800'].commEfficiency).toBe(Math.max(...eff));
    expect(by['roce-generic-400'].commEfficiency).toBe(Math.min(...eff));
    expect(by['ib-xdr-800'].timeToTrainDays!).toBeLessThanOrEqual(Math.min(...rows.map((r) => r.timeToTrainDays!)));
    // v2: train days come from the single step-time model (traffic engine, step = T_comp + exposed communication); with the
    // reference blueprint every collective hides behind its overlap window on every fabric, so the days can tie — the
    // η-driven effective efficiency (adaptive 0.95 vs ECMP 0.6) is what separates the fabrics, never the other way round
    expect(by['roce-generic-400'].timeToTrainDays!).toBeGreaterThanOrEqual(by['ib-xdr-800'].timeToTrainDays!);
    expect(by['spectrumx-800'].timeToTrainDays!).toBeLessThanOrEqual(by['roce-generic-400'].timeToTrainDays!);
    expect(by['ib-xdr-800'].commEfficiencyEffective! / by['roce-generic-400'].commEfficiencyEffective!).toBeGreaterThan(1.2);
  });

  it('400G fabrics need more switch ports than 800G for 800G NICs', () => {
    expect(by['ib-ndr-400'].switches).toBeGreaterThan(by['ib-xdr-800'].switches);
    expect(by['spectrumx-400'].switches).toBeGreaterThan(by['spectrumx-800'].switches);
    for (const r of rows) expect(r.networkCapexUSD).toBeGreaterThan(0);
  });
});

describe('cost', () => {
  it('BOM sums to CAPEX and per-GPU cost is plausible', () => {
    const sum = a.cost.bom.reduce((s, l) => s + l.totalUSD, 0);
    expect(sum).toBeCloseTo(a.cost.capexUSD, 0);
    const byDomain = Object.values(a.cost.byDomain).reduce((s, v) => s + v, 0);
    expect(byDomain).toBeCloseTo(a.cost.capexUSD, 0);
    expect(a.cost.usdPerGpu).toBeGreaterThan(55_000);
    expect(a.cost.usdPerGpu).toBeLessThan(120_000);
    expect(a.cost.tcoUSD5y).toBeGreaterThan(a.cost.capexUSD);
  });

  it('applies price overrides', () => {
    const p = ref();
    p.pricing.itemOverrides['nvidia-gb300-nvl72'] = 1_000_000;
    const r = analyzeProject(p);
    expect(a.cost.byDomain.it - r.cost.byDomain.it).toBeCloseTo(96 * 2_900_000, -3);
  });
});

describe('design document', () => {
  // v2 (S4): locale-aware generator, English default; Korean chapter headings follow the AMD / NVIDIA reference-design chapter order (docs.test.ts covers both locales)
  const doc = generateDesignDocument(project, a, { locale: 'ko', thermal: { maxInletC: 26.8, rciHi: 100, rti: 95 } });

  it('contains all 11 sections', () => {
    for (const h of ['## 1. 개요·과제·목표', '## 2. 사이트 및 바닥 시스템', '## 3. 물리 배치 및 냉각 전략', '## 4. 네트워크 설계', '## 5. 중앙 집중 컨트롤 플레인', '## 6. 스토리지', '## 7. 전력 공급', '## 8. 전력 회복력', '## 9. BOM 및 전력 추정', '## 10. 배포 및 인수', '## 11. 가정 및 데이터 출처']) {
      expect(doc, h).toContain(h);
    }
  });

  it('includes mermaid one-line, topology and gantt plus project notes', () => {
    expect(doc).toContain('flowchart TB');
    expect(doc).toContain('flowchart BT');
    expect(doc).toContain('gantt');
    expect(doc).toContain(project.notes[0].title);
    expect(doc).toContain('기류·열 시뮬레이션 결과');
  });
});
