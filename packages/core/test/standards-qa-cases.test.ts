// QA (standards / engines / compat): hand-computed rule cases that differ from the stream suites, the DO-3 severity-cap property over
// every produced result, draft-document caps under `gate`, and CL-09 on power-plane circuits (docs/research/ocp/qa-standards.md).
import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  createNvidiaReferenceProject,
  createReferenceProject,
  evaluateStandardsChecks,
  findCatalogItem,
  findStandard,
  isDraftStatus,
  standardsCheckReport,
  standardsPreset,
  type CatalogItem,
  type Ctx,
  type EquipmentInstance,
  type Placed,
  type Project,
  type Severity,
  type StandardsCheckResult,
  type StandardsPresetId,
  type StandardsProfile,
} from '../src/index.ts';

const BASE = createNvidiaReferenceProject().project;
const mkItem = (o: Partial<CatalogItem> & { id: string }): CatalogItem =>
  ({ category: 'gpu-rack', vendor: 'Generic', model: o.id, name: o.id, description: '', dims: { w: 0.6, d: 1.068, h: 2.286 }, weightKg: 600, clearance: { front: 1, rear: 1, sides: 0 }, cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 }, source: 'public-spec', ...o }) as CatalogItem;
function mkProject(preset: StandardsPresetId | undefined, patch: Partial<StandardsProfile> = {}, edit: (p: Project) => void = () => {}): Project {
  const p = structuredClone(BASE);
  p.halls = [p.halls[0]];
  if (preset) p.standards = { ...standardsPreset(preset), ...patch };
  else delete p.standards;
  p.busways = [];
  p.containments = [];
  p.power.distributionVoltageV = 415;
  p.power.deratingFactor = 1;
  p.power.mechanicalOnUps = true;
  edit(p);
  return p;
}
function mkCtx(project: Project, racks: { item: CatalogItem; meta?: EquipmentInstance['meta']; n?: number }[]): Ctx {
  const hall = project.halls[0];
  const placed: Placed[] = [];
  racks.forEach((x, k) => {
    for (let i = 0; i < (x.n ?? 1); i++) placed.push({ e: { id: `eq-${k}-${i}`, catalogId: x.item.id, hallId: hall.id, tag: `R${k}-${i}`, position: { x: 1, y: 1 }, rotationDeg: 0, ...(x.meta ? { meta: x.meta } : {}) }, item: x.item, hall });
  });
  return { project, placed, unknown: [], halls: new Map([[hall.id, hall]]), byHall: new Map([[hall.id, placed]]), byPod: new Map(), gpus: 0, gpuRack: undefined, acceleratorChips: 0 } as Ctx;
}
const pw = (kw: number) => ({ nameplateKW: kw, typicalKW: kw, idleKW: 0, peakKW: kw, feeds: 2, voltageV: 415 }) as CatalogItem['power'];
const META = { rack: 'orv3-hpr' as const, unitPitchMm: 48 as const, heightUnits: 44, usableUnits: 44, implementation: 'orv3-frame-meta@1.3', payloadKg: 1400, payloadExcludesFrame: true, crossBraceAboveKg: 800, itShelfKgPerSet: 80 };
const hpr = (kw: number, o: Partial<CatalogItem> = {}) => mkItem({ id: `hpr-${kw}`, power: pw(kw), formFactor: { ...META }, rackPower: { interface: 'dc-busbar', nominalV: 50, rangeV: [46, 52] }, ...o });
const orv3 = (kw: number) => mkItem({ id: `orv3-${kw}`, power: pw(kw), formFactor: { ...META, rack: 'orv3' }, rackPower: { interface: 'dc-busbar', nominalV: 51, rangeV: [46, 52] } });
const withFacility = (f: NonNullable<Project['halls'][number]['facility']>) => (p: Project) => { p.halls[0].facility = { ...(p.halls[0].facility ?? {}), ...f }; };

const produced: { strictness: string; r: StandardsCheckResult }[] = [];
const run = (project: Project, racks: Parameters<typeof mkCtx>[1]) => {
  const res = evaluateStandardsChecks(mkCtx(project, racks)).results;
  for (const r of res) produced.push({ strictness: project.standards?.inferred ? 'inferred' : project.standards?.strictness ?? 'none', r });
  return res;
};
const one = (res: StandardsCheckResult[], ruleId: string, idPart = '') => {
  const r = res.filter((x) => x.ruleId === ruleId && x.id.includes(idPart));
  expect(r.length, `${ruleId} ${idPart}: ${res.map((x) => x.id).join(', ')}`).toBe(1);
  return r[0];
};

describe.each(['advisory', 'gate'] as const)('hand-computed rule cases (%s)', (strict) => {
  const S = { strictness: strict } as Partial<StandardsProfile>;
  const gateError: Severity = strict === 'gate' ? 'error' : 'warning';

  it('PW-01 HPR v1 with 2 declared shelves: N+1 2 × 27.5 = 55 kW, maximum 2 × 33 = 66 kW (no 93.5 kW cap below 3 sets); draft basis caps at warning', () => {
    const p = mkProject('orv3-hpr-liquid', S);
    expect(one(run(p, [{ item: hpr(55), meta: { powerShelves: 2 } }]), 'PW-01').status).toBe('pass');
    expect(one(run(p, [{ item: hpr(60), meta: { powerShelves: 2 } }]), 'PW-01')).toMatchObject({ status: 'finding', naturalSeverity: 'warning', severity: 'warning', limit: 55 });
    expect(one(run(p, [{ item: hpr(70), meta: { powerShelves: 2 } }]), 'PW-01')).toMatchObject({ status: 'finding', naturalSeverity: 'error', severity: 'warning', limit: 66 });
  });

  it('PW-01 ORv3 v1 with 3 declared shelves: N+1 45 kW, maximum 54 kW; accepted basis keeps the error under gate', () => {
    const p = mkProject('orv3-air-dhx', S);
    expect(one(run(p, [{ item: orv3(44), meta: { powerShelves: 3 } }]), 'PW-01').status).toBe('pass');
    expect(one(run(p, [{ item: orv3(46), meta: { powerShelves: 3 } }]), 'PW-01')).toMatchObject({ severity: 'warning', limit: 45 });
    expect(one(run(p, [{ item: orv3(55), meta: { powerShelves: 3 } }]), 'PW-01')).toMatchObject({ naturalSeverity: 'error', severity: gateError, limit: 54 });
  });

  it('PW-06 HPR v1 class curve 5+0 (finish): 25 kW per shelf → 240 + 5 × (90 − 240) / 7.5 = 140 s; 130 s + 10 s passes, 131 s + 10 s is a draft-capped finding', () => {
    expect(one(run(mkProject('orv3-hpr-liquid', S, withFacility({ generatorAcceptanceS: 130 })), [{ item: hpr(75) }]), 'PW-06')).toMatchObject({ status: 'pass', designValue: 140, limit: 140 });
    expect(one(run(mkProject('orv3-hpr-liquid', S, withFacility({ generatorAcceptanceS: 131 })), [{ item: hpr(75) }]), 'PW-06')).toMatchObject({ status: 'finding', severity: 'warning', designValue: 140, limit: 141 });
  });

  it('PW-06 HPR v1 class curve 5+0 (finish): 30 kW per shelf is beyond the 27.5 kW N+1 point → 0 s (the 6+0 curve would have given 140 s)', () => {
    expect(one(run(mkProject('orv3-hpr-liquid', S, withFacility({ generatorAcceptanceS: 30 })), [{ item: hpr(90) }]), 'PW-06')).toMatchObject({ status: 'finding', severity: 'warning', designValue: 0, limit: 40 });
  });

  it('shelf count (finish): a numeric item-level meta.powerShelves is read like the instance value — 2 shelves → PW-01 N+1 55 kW', () => {
    const p = mkProject('orv3-hpr-liquid', S);
    expect(one(run(p, [{ item: hpr(55, { id: 'hpr-item2-55', meta: { powerShelves: 2 } }) }]), 'PW-01')).toMatchObject({ status: 'pass', limit: 55 });
    expect(one(run(p, [{ item: hpr(60, { id: 'hpr-item2-60', meta: { powerShelves: 2 } }) }]), 'PW-01')).toMatchObject({ status: 'finding', limit: 55 });
    expect(one(run(p, [{ item: hpr(60, { id: 'hpr-item2-inst3', meta: { powerShelves: 2 } }), meta: { powerShelves: 3 } }]), 'PW-01')).toMatchObject({ status: 'pass', limit: 82.5 });
  });

  it('PW-06 ORv3 v1 end-of-life 90 s: 80 s + 10 s passes; 81 s + 10 s is a finding (error under gate, accepted BBU module 1.4)', () => {
    expect(one(run(mkProject('orv3-air-dhx', S, withFacility({ generatorAcceptanceS: 80 })), [{ item: orv3(28) }]), 'PW-06')).toMatchObject({ status: 'pass', designValue: 90, limit: 90 });
    expect(one(run(mkProject('orv3-air-dhx', S, withFacility({ generatorAcceptanceS: 81 })), [{ item: orv3(28) }]), 'PW-06')).toMatchObject({ status: 'finding', severity: gateError, limit: 91 });
  });

  it('PW-02 ORv3 v1 18 kW / 47.5 V = 378.9 A: 250 LFM keeps the 360 A still-air rating (finding), 300 LFM uses 500 A', () => {
    expect(one(run(mkProject('orv3-air-dhx', S, withFacility({ shelfAirflowLFM: 250 })), [{ item: orv3(28) }]), 'PW-02')).toMatchObject({ status: 'finding', designValue: 378.9, limit: 360 });
    expect(one(run(mkProject('orv3-air-dhx', S, withFacility({ shelfAirflowLFM: 300 })), [{ item: orv3(28) }]), 'PW-02')).toMatchObject({ status: 'pass', limit: 500 });
  });

  it('RK-02 frame 1.3 without frame mass: 1100 kg unbraced → brace warning (800 kg); braced passes; 1450 kg > 1400 kg → error under gate', () => {
    const p = mkProject('orv3-hpr-liquid', S);
    expect(one(run(p, [{ item: hpr(40, { id: 'm1100', weightKg: 1100 }) }]), 'RK-02')).toMatchObject({ status: 'finding', severity: 'warning', limit: 800 });
    expect(one(run(p, [{ item: hpr(40, { id: 'm1100b', weightKg: 1100 }), meta: { crossBrace: true } }]), 'RK-02').status).toBe('pass');
    expect(one(run(p, [{ item: hpr(40, { id: 'm1450', weightKg: 1450 }), meta: { crossBrace: true } }]), 'RK-02')).toMatchObject({ naturalSeverity: 'error', severity: gateError, limit: 1400 });
  });

  it('wide rack: RK-03 130 kg node on 125 kg per set → warning, 2 sets → 65 kg pass; RK-01 5 × 7 + 3 = 38 OU passes, 6 × 7 + 3 = 45 OU draft-capped', () => {
    const p = mkProject('orw-liquid-sidecar', S);
    const wide = (id: string, o: { meta?: Record<string, unknown>; nodes?: number } = {}) =>
      mkItem({ id, power: pw(60), weightKg: 900, formFactor: { rack: 'orw', unitPitchMm: 48, heightUnits: 44, usableUnits: 44, implementation: 'orw-meta-design@1.0.0', payloadKg: 4700, payloadExcludesFrame: true, itShelfKgPerSet: 125, ...(o.nodes ? { nodeHeightUnits: 7 } : {}) }, rackPower: { interface: 'dc-busbar', nominalV: 50, rangeV: [46, 52] }, ...(o.nodes ? { compute: { nodesPerRack: o.nodes, gpusPerNode: 8 } as unknown as CatalogItem['compute'] } : {}), meta: o.meta ?? {} });
    expect(one(run(p, [{ item: wide('w130', { meta: { nodeMassKg: 130 } }) }]), 'RK-03')).toMatchObject({ status: 'finding', severity: 'warning', limit: 125 });
    expect(one(run(p, [{ item: wide('w130x2', { meta: { nodeMassKg: 130, supportShelfSetsPerNode: 2 } }) }]), 'RK-03')).toMatchObject({ status: 'pass', designValue: 65 });
    expect(one(run(p, [{ item: wide('w5', { nodes: 5 }) }]), 'RK-01')).toMatchObject({ status: 'pass', designValue: 38, limit: 44 });
    expect(one(run(p, [{ item: wide('w6', { nodes: 6 }) }]), 'RK-01')).toMatchObject({ status: 'finding', naturalSeverity: 'error', severity: 'warning', designValue: 45 });
  });

  it('PW-07 72 kW shelf: 277 V NEC 48 A vs 46.3 A passes; 240 V derived 12,000 / (240 × 0.936) = 53.4 A > 48 A; IEC 60 A passes', () => {
    const shelf = structuredClone(findCatalogItem('pshelf-hpr-v2-72kw')!.powerShelf);
    const v2 = mkItem({ id: 'v2rack', power: pw(100), formFactor: { ...META }, rackPower: { interface: 'dc-busbar', nominalV: 50, rangeV: [46, 52] }, powerShelf: shelf });
    const prof = { ...S, shelfClass: 'hpr-v2-72kw' as const, includeDraftSpecs: true };
    const at = (v: 415 | 480, derating: number) => mkProject('orv3-hpr-liquid', prof, (p) => { p.power.distributionVoltageV = v; p.power.deratingFactor = derating; });
    expect(one(run(at(480, 0.8), [{ item: v2, meta: { powerShelves: 2 } }]), 'PW-07')).toMatchObject({ status: 'pass', designValue: 46.3, limit: 48 });
    expect(one(run(at(415, 0.8), [{ item: v2, meta: { powerShelves: 2 } }]), 'PW-07')).toMatchObject({ status: 'finding', designValue: 53.4, limit: 48 });
    expect(one(run(at(415, 1), [{ item: v2, meta: { powerShelves: 2 } }]), 'PW-07')).toMatchObject({ status: 'pass', limit: 60 });
    const r = run(at(480, 0.8), [{ item: v2, meta: { powerShelves: 2 } }]);
    expect(one(r, 'PW-01')).toMatchObject({ status: 'pass', limit: 120 });
    expect(one(r, 'PW-02')).toMatchObject({ status: 'pass', designValue: 1469.4, limit: 2000 });
  });

  it('PW-08 2 × 600 kW sidecar-fed racks on one 1.1 MW power rack at 480 V: natural error, pre-1.0 draft → warning; PW-09 loss 3 % = 36 kW (info)', () => {
    const side = mkItem({ id: 'side600', power: pw(600), formFactor: { rack: 'orw', unitPitchMm: 48, heightUnits: 44 }, rackPower: { interface: 'hvdc-cable', nominalV: 400, rangeV: [400, 410] } });
    const prack = mkItem({ id: 'prack', category: 'rpp', power: undefined, powerRack: structuredClone(findCatalogItem('power-rack-pm400')!.powerRack) });
    const r = run(mkProject('orw-liquid-sidecar', { ...S, includeDraftSpecs: true }, (p) => { p.power.distributionVoltageV = 480; }), [{ item: side, n: 2 }, { item: prack }]);
    expect(one(r, 'PW-08')).toMatchObject({ status: 'finding', naturalSeverity: 'error', severity: 'warning', designValue: 1200, limit: 1100 });
    expect(one(r, 'PW-09')).toMatchObject({ severity: 'info', designValue: 36 });
  });

  it('CL-04 / CL-05 large connector (rack scope): 80 kW PG25 ΔT 10 K = 119.1 L/min on 1 assumed pair > 100 (estimate → warning), 4 ports 59.6 L/min; 80 psig > 75 psig → error under gate', () => {
    const rack = (id: string, ports?: number) => mkItem({ id, power: pw(80), cooling: { kind: 'dlc', liquidFraction: 1, airflowM3s: 0, liquidFlowLpm: 120, maxInletC: 35, maxCoolantSupplyC: 45 } as CatalogItem['cooling'], formFactor: { ...META, rack: 'orv3' }, liquidInterface: { connector: 'lqc', mawpKPa: 517, maxFluidC: 60, ...(ports ? { ports } : {}) } as CatalogItem['liquidInterface'] });
    const lqc = (psig: number) => mkProject('orv3-hpr-liquid', { ...S, liquid: { ...standardsPreset('orv3-hpr-liquid').liquid, connector: 'lqc', rackManifold: 'none' } }, withFacility({ tcsManifoldPsig: psig }));
    const r60 = run(lqc(60), [{ item: rack('lqc1') }]);
    expect(one(r60, 'CL-04')).toMatchObject({ status: 'finding', severity: 'warning', designValue: 119.1, limit: 100, basis: 'estimate' });
    expect(one(r60, 'CL-05', 'connect')).toMatchObject({ severity: 'warning', designValue: 60, limit: 50 });
    expect(one(run(lqc(60), [{ item: rack('lqc4', 4) }]), 'CL-04')).toMatchObject({ status: 'pass', designValue: 59.6 });
    expect(run(lqc(80), [{ item: rack('lqc80', 4) }]).find((x) => x.ruleId === 'CL-05' && !x.id.includes('connect'))).toMatchObject({ status: 'finding', severity: gateError, designValue: 80, limit: 75 });
  });

  it('CL-16 board 8 × (1050 + 50) + 3200 = 12,000 W passes; 8 × (1100 + 50) + 3200 = 12,400 W warns with the 1000 W module envelope note (info)', () => {
    const p = mkProject('orv3-hpr-liquid', S);
    const ubb = (w: number) => mkItem({ id: `ubb${w}`, power: pw(40), cooling: { kind: 'dlc', liquidFraction: 0.8, airflowM3s: 0.1, liquidFlowLpm: 40, maxInletC: 35, maxCoolantSupplyC: 45 } as CatalogItem['cooling'], formFactor: { ...META }, accelModule: { standard: 'oam-2.0', tdpW: w, cooling: 'liquid' }, baseboard: { standard: 'ubb-2.0', modules: 8, inputV: 54, opt12VPerModuleW: 50, maxBoardW: 12000 } as CatalogItem['baseboard'] });
    expect(one(run(p, [{ item: ubb(1050) }]), 'CL-16', 'cl16')).toMatchObject({ status: 'pass', designValue: 12000 });
    const r = run(p, [{ item: ubb(1100) }]);
    expect(one(r, 'CL-16', 'cl16')).toMatchObject({ status: 'finding', severity: 'warning', designValue: 12400 });
    expect(one(r, 'CL-16', 'env-oam')).toMatchObject({ severity: 'info', designValue: 1100, limit: 1000 });
  });

  it('NW-02 switched scale-up domain 1,100 > 1,024: external consortium specification is not a draft → error under gate', () => {
    const ual = mkItem({ id: 'ual', power: pw(40), compute: { nodesPerRack: 1, gpusPerNode: 8, scaleUp: { kind: 'ualink', domainSize: 1100, spansRacks: true }, railsPerNode: 8 } as unknown as CatalogItem['compute'] });
    expect(one(run(mkProject('orv3-hpr-liquid', S), [{ item: ual }]), 'NW-02', 'nw02-ual')).toMatchObject({ status: 'finding', severity: gateError, limit: 1024 });
  });
});

describe('DO-3 severity caps over every result produced above', () => {
  it('no profile / inferred → info; advisory → ≤ warning; gate → natural unless the document is draft / review / roadmap or the value is estimate / unverified', () => {
    const hpr100 = hpr(100, { id: 'hpr-inf', weightKg: 1500 });
    expect(run(mkProject(undefined), [{ item: hpr100 }])).toEqual([]);
    const inferred = run(mkProject('orv3-hpr-liquid', { strictness: 'gate', inferred: true } as Partial<StandardsProfile>), [{ item: hpr100 }]).filter((r) => r.status === 'finding');
    expect(inferred.length).toBeGreaterThan(0);
    expect(new Set(inferred.map((r) => r.severity))).toEqual(new Set(['info']));
    const rank: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
    const bad: string[] = [];
    let draftUnderGate = 0;
    for (const { strictness, r } of produced) {
      if (r.status !== 'finding') { if (r.severity !== 'info') bad.push(`${r.id} ${r.status}/${r.severity}`); continue; }
      const doc = r.standardId ? findStandard(r.standardId) : undefined;
      const draft = r.standardId ? (doc ? isDraftStatus(doc.status) : true) : false;
      const weak = draft || r.basis === 'estimate' || r.verification === 'estimate' || r.verification === 'unverified';
      const expected: Severity = strictness === 'inferred' || strictness === 'none' ? 'info' : strictness === 'advisory' || weak ? (rank[r.naturalSeverity] <= 1 ? r.naturalSeverity : 'warning') : r.naturalSeverity;
      if (r.severity !== expected) bad.push(`${r.id} (${strictness}) ${r.severity} ≠ ${expected}`);
      if (strictness === 'gate' && draft) { draftUnderGate++; if (r.severity === 'error') bad.push(`${r.id} draft ${r.standardId} error under gate`); }
    }
    expect(bad).toEqual([]);
    expect(draftUnderGate).toBeGreaterThan(5);
  });
});

describe('CL-09 on power-plane circuits (the electrical block the power engine sizes)', () => {
  it('neutral reference: every row busway is split into 2 circuits of 254 kW liquid ≤ 0.8 × 558 kW → pass, no warning', () => {
    const { project } = createReferenceProject();
    const r = standardsCheckReport(project).results.filter((x) => x.ruleId === 'CL-09');
    expect(r.map((x) => x.status)).toEqual(['pass']);
    const a = analyzeProject(project);
    expect(a.issues.filter((i) => i.severity !== 'info')).toEqual([]);
  });

  it('same hall at load factor 0.5: the plane sizes one circuit per row, so 12 × 42.4 kW = 509 kW liquid > 0.8 × 558 kW → warning', () => {
    const project = structuredClone(createReferenceProject().project);
    for (const e of project.equipment) if (findCatalogItem(e.catalogId)?.category === 'gpu-rack') e.loadFactor = 0.5;
    const i = analyzeProject(project).issues.find((x) => x.check?.ruleId === 'CL-09');
    expect(i).toMatchObject({ severity: 'warning', check: { designValue: 509, limit: 446 } });
    expect(i?.messageEn).toMatch(/circuit 1 carry 509 kW/);
  });
});
