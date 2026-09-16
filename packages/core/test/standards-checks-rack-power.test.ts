// Stream C (P3) — RK / PW standards parameter checks with hand-computed cases (OCP-DESIGN-PROPOSAL §8.3, P0 cases).
import { describe, expect, it } from 'vitest';
import {
  createNvidiaReferenceProject,
  evaluateRackPowerChecks,
  evaluateStandardsChecks,
  interpBackupS,
  standardsPreset,
  type CatalogItem,
  type Ctx,
  type EquipmentInstance,
  type Placed,
  type Project,
  type StandardsCheckResult,
  type StandardsPresetId,
  type StandardsProfile,
} from '../src/index.ts';

const BASE = createNvidiaReferenceProject().project;

function mkItem(o: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    category: 'gpu-rack', vendor: 'Generic', model: o.id, name: o.id, description: '', dims: { w: 0.6, d: 1.068, h: 2.286 }, weightKg: 600,
    clearance: { front: 1, rear: 1, sides: 0 }, cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 }, source: 'public-spec', ...o,
  } as CatalogItem;
}

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
  return { project, placed, unknown: [], halls: new Map([[hall.id, hall]]), byHall: new Map([[hall.id, placed]]), byPod: new Map(), gpus: 0, gpuRack: undefined, acceleratorChips: 0 };
}

const one = (res: StandardsCheckResult[], ruleId: string, idPart = '') => {
  const r = res.filter((x) => x.ruleId === ruleId && x.id.includes(idPart));
  expect(r.length, `${ruleId} ${idPart}: ${res.map((x) => x.id).join(', ')}`).toBe(1);
  return r[0];
};

const power = (kw: number) => ({ nameplateKW: kw, typicalKW: kw, idleKW: 0, peakKW: kw, feeds: 2, voltageV: 415 }) as CatalogItem['power'];
const META_FRAME = { rack: 'orv3-hpr' as const, unitPitchMm: 48 as const, heightUnits: 44, usableUnits: 44, implementation: 'orv3-frame-meta@1.3', payloadKg: 1400, payloadExcludesFrame: true, crossBraceAboveKg: 800, itShelfKgPerSet: 80 };
const hprRack = (kw: number, o: Partial<CatalogItem> = {}) => mkItem({ id: `hpr-${kw}`, power: power(kw), formFactor: { ...META_FRAME }, rackPower: { interface: 'dc-busbar', nominalV: 50, rangeV: [46, 52] }, ...o });
const orv3Rack = (kw: number, o: Partial<CatalogItem> = {}) => mkItem({ id: `orv3-${kw}`, power: power(kw), formFactor: { ...META_FRAME, rack: 'orv3' }, rackPower: { interface: 'dc-busbar', nominalV: 51, rangeV: [46, 52] }, ...o });

describe('PW-01 shelf capacity (HPR v1: 27.5 kW N+1 per shelf, 93.5 kW for three sets)', () => {
  it('100 kW on 3 × 33 kW shelves exceeds the 93.5 kW three-set total: natural error, warning under the draft cap', () => {
    const ctx = mkCtx(mkProject('orv3-hpr-liquid'), [{ item: hprRack(100) }]);
    const r = one(evaluateRackPowerChecks(ctx), 'PW-01');
    expect(r).toMatchObject({ status: 'finding', naturalSeverity: 'error', severity: 'warning', designValue: 100, limit: 93.5, standardId: 'orv3-hpr-shelf-33kw@0.3' });
    expect(r.messageEn).toContain('HPR V2 72 kW shelves in an HPRv3 power rack');
    expect(r.messageEn).toMatch(/^Parameter check \(per ORv3 HPR 33 kW Power Shelf Rev 0\.3, PW-01\)/);
    // strictness 'gate' cannot raise a draft-basis check above warning
    const gate = mkCtx(mkProject('orv3-hpr-liquid', { strictness: 'gate' }), [{ item: hprRack(100) }]);
    expect(one(evaluateRackPowerChecks(gate), 'PW-01').severity).toBe('warning');
  });
  it('85 kW is above the N+1 limit 3 × 27.5 = 82.5 kW (warning); 69 kW passes', () => {
    const r85 = one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: hprRack(85) }])), 'PW-01');
    expect(r85).toMatchObject({ status: 'finding', naturalSeverity: 'warning', limit: 82.5 });
    expect(one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: hprRack(69) }])), 'PW-01').status).toBe('pass');
  });
  it('ORv3 v1: 2 shelves × 15 kW N+1 = 30 kW; 35 kW rack is a finding', () => {
    const r = one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-air-dhx'), [{ item: orv3Rack(35) }])), 'PW-01');
    expect(r).toMatchObject({ status: 'finding', limit: 30, naturalSeverity: 'warning' });
  });
});

describe('PW-02 output connector', () => {
  it('HPR v1: 33 kW / 49 V = 673.5 A ≤ 700 A clip', () => {
    const r = one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: hprRack(60) }])), 'PW-02');
    expect(r).toMatchObject({ status: 'pass', designValue: 673.5, limit: 700 });
  });
  it('ORv3 v1: 18 kW / 47.5 V = 378.9 A > 360 A in still air; passes with 300 LFM (500 A rating)', () => {
    const still = one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-air-dhx'), [{ item: orv3Rack(20) }])), 'PW-02');
    expect(still).toMatchObject({ status: 'finding', designValue: 378.9, limit: 360, standardId: 'orv3-output-connector@2.0' });
    const air = mkProject('orv3-air-dhx', {}, (p) => (p.halls[0].facility = { shelfAirflowLFM: 300 }));
    expect(one(evaluateRackPowerChecks(mkCtx(air, [{ item: orv3Rack(20) }])), 'PW-02')).toMatchObject({ status: 'pass', limit: 500 });
  });
  it('HPR V2: 72 kW / 49 V = 1469.4 A ≤ 2000 A; the V2 shelf on an HPR v1 IT busbar is flagged (PW-03)', () => {
    const ctx = mkCtx(mkProject('orv3-hpr-liquid', { shelfClass: 'hpr-v2-72kw' }), [{ item: hprRack(100) }]);
    const res = evaluateRackPowerChecks(ctx);
    expect(one(res, 'PW-02')).toMatchObject({ status: 'pass', designValue: 1469.4, limit: 2000 });
    expect(one(res, 'PW-03', 'gen')).toMatchObject({ status: 'finding', naturalSeverity: 'warning' });
  });
});

describe('RK-01 / RK-02 / RK-03 (Meta ORv3 frame 1.3)', () => {
  it('RK-01: 5 × 6 OU nodes + 9 OU HPR power zone = 39 ≤ 44 OU passes; 5 × 8 OU = 49 OU fails', () => {
    const node = (u: number) => hprRack(69, { id: `hpr-node-${u}`, compute: { nodesPerRack: 5 } as CatalogItem['compute'], formFactor: { ...META_FRAME, nodeHeightUnits: u } });
    expect(one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: node(6) }])), 'RK-01')).toMatchObject({ status: 'pass', designValue: 39, limit: 44 });
    expect(one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: node(8) }])), 'RK-01')).toMatchObject({ status: 'finding', designValue: 49, naturalSeverity: 'error' });
  });
  it('RK-02: 900 kg without a cross brace → warning (brace above 800 kg); braced passes; 1500 kg > 1400 kg payload → error (gate keeps error)', () => {
    const p = mkProject('orv3-hpr-liquid');
    const r900 = one(evaluateRackPowerChecks(mkCtx(p, [{ item: hprRack(69, { weightKg: 900 }) }])), 'RK-02');
    expect(r900).toMatchObject({ status: 'finding', naturalSeverity: 'warning', limit: 800, designValue: 900 });
    expect(one(evaluateRackPowerChecks(mkCtx(p, [{ item: hprRack(69, { weightKg: 900 }), meta: { crossBrace: true } }])), 'RK-02').status).toBe('pass');
    const r1500 = one(evaluateRackPowerChecks(mkCtx(p, [{ item: hprRack(69, { weightKg: 1500 }), meta: { crossBrace: true } }])), 'RK-02');
    expect(r1500).toMatchObject({ status: 'finding', naturalSeverity: 'error', severity: 'warning', limit: 1400 });
    const gate = mkProject('orv3-hpr-liquid', { strictness: 'gate' });
    expect(one(evaluateRackPowerChecks(mkCtx(gate, [{ item: hprRack(69, { weightKg: 1500 }), meta: { crossBrace: true } }])), 'RK-02').severity).toBe('error');
  });
  it('RK-03: a 100 kg node on an 80 kg IT support shelf set → warning; own rails → pass', () => {
    const p = mkProject('orv3-hpr-liquid');
    const heavy = hprRack(69, { meta: { nodeMassKg: 100 } });
    expect(one(evaluateRackPowerChecks(mkCtx(p, [{ item: heavy }])), 'RK-03')).toMatchObject({ status: 'finding', designValue: 100, limit: 80, naturalSeverity: 'warning' });
    const rails = hprRack(69, { meta: { nodeMassKg: 100 }, formFactor: { ...META_FRAME, ownRails: true } });
    expect(one(evaluateRackPowerChecks(mkCtx(p, [{ item: rails }])), 'RK-03').status).toBe('pass');
  });
});

describe('PW-06 BBU ride-through (ORv3 BBU end-of-life 90 s; generator acceptance + 10 s margin)', () => {
  it('90 s vs 60 s + 10 s = 70 s passes; vs 85 s + 10 s = 95 s is a finding; the beginning-of-life 240 s is shown as info', () => {
    const at = (gen: number) => mkProject('orv3-air-dhx', {}, (p) => (p.halls[0].facility = { generatorAcceptanceS: gen }));
    const ok = one(evaluateRackPowerChecks(mkCtx(at(60), [{ item: orv3Rack(20) }])), 'PW-06');
    expect(ok).toMatchObject({ status: 'pass', designValue: 90, limit: 70 });
    expect(ok.messageEn).toContain('beginning of life 240 s');
    expect(one(evaluateRackPowerChecks(mkCtx(at(85), [{ item: orv3Rack(20) }])), 'PW-06')).toMatchObject({ status: 'finding', limit: 95, naturalSeverity: 'error' });
  });
  it('HPR v1 BBU curve: 240 s at ≤ 24 kW per shelf, 90 s at 33 kW, linear between (28.5 kW → 165 s)', () => {
    const c = [{ kw: 24, s: 240 }, { kw: 33, s: 90 }];
    expect(interpBackupS(c, 20)).toBe(240);
    expect(interpBackupS(c, 28.5)).toBeCloseTo(165, 6);
    expect(interpBackupS(c, 33)).toBe(90);
    expect(interpBackupS(c, 34)).toBe(0);
  });
  it('no generator acceptance input → not modelled (no issue)', () => {
    const r = one(evaluateRackPowerChecks(mkCtx(mkProject('orv3-air-dhx'), [{ item: orv3Rack(20) }])), 'PW-06');
    expect(r.status).toBe('not-modelled');
  });
});

describe('PW-07 PSU input current vs whip (HPR V2 12 kW PSU: 55.7 A at 230 V, 46.3 A at 277 V)', () => {
  it('230 V phase on a NEC-derated 60 A circuit (48 A) is a finding; 277 V passes', () => {
    const v2 = (v: 400 | 480) => mkProject('orv3-hpr-liquid', { shelfClass: 'hpr-v2-72kw' }, (p) => { p.power.distributionVoltageV = v; p.power.deratingFactor = 0.8; });
    expect(one(evaluateRackPowerChecks(mkCtx(v2(400), [{ item: hprRack(100) }])), 'PW-07')).toMatchObject({ status: 'finding', designValue: 55.7, limit: 48, verification: 'verified' });
    expect(one(evaluateRackPowerChecks(mkCtx(v2(480), [{ item: hprRack(100) }])), 'PW-07')).toMatchObject({ status: 'pass', designValue: 46.3, limit: 48 });
  });
  it('HPR v1 5.5 kW PSU at 230 V ≈ 24.5 A ≤ 32 A IEC whip', () => {
    const p = mkProject('orv3-hpr-liquid', {}, (x) => (x.power.distributionVoltageV = 400));
    expect(one(evaluateRackPowerChecks(mkCtx(p, [{ item: hprRack(69) }])), 'PW-07')).toMatchObject({ status: 'pass', designValue: 24.5, limit: 32 });
  });
});

describe('PW-08 / PW-09 ±400 VDC power racks (draft basis)', () => {
  it('3 × 245 kW = 735 kW on one power rack at 400 V (718 kW) is a finding, capped at warning; loss 3.5 % → info', () => {
    const p = mkProject('orw-liquid-sidecar', {}, (x) => (x.power.distributionVoltageV = 400));
    const rack = mkItem({ id: 'orw-245', power: power(245), formFactor: { rack: 'orw', unitPitchMm: 48, heightUnits: 44, usableUnits: 44 }, rackPower: { interface: 'hvdc-cable', nominalV: 400, rangeV: [400, 410] } });
    const pm = mkItem({ id: 'pm400', category: 'rpp', powerRack: { inputs: { count: 12, A: 200, V: [480, 415, 400] }, ratingKWByInputV: { 480: 1100, 415: 1100, 400: 718 }, linkKW: 100, linkA: 125 } });
    const res = evaluateRackPowerChecks(mkCtx(p, [{ item: rack, n: 3 }, { item: pm }]));
    expect(one(res, 'PW-08')).toMatchObject({ status: 'finding', designValue: 735, limit: 718, naturalSeverity: 'error', severity: 'warning' });
    expect(one(res, 'PW-09')).toMatchObject({ designValue: Math.round(735 * 0.035), severity: 'info' });
  });
});

describe('DO-3 severity caps and legacy projects', () => {
  it('an inferred profile turns every finding into info; no profile → no results', () => {
    const inferred = mkCtx(mkProject('orv3-hpr-liquid', { inferred: true }), [{ item: hprRack(100, { weightKg: 1500 }) }]);
    const res = evaluateRackPowerChecks(inferred).filter((r) => r.status === 'finding');
    expect(res.length).toBeGreaterThan(0);
    expect(res.every((r) => r.severity === 'info')).toBe(true);
    const none = mkCtx(mkProject(undefined), [{ item: hprRack(100) }]);
    expect(evaluateStandardsChecks(none).results).toEqual([]);
  });
  it('vendor busbar racks (declared vendor rack-scale frame) skip the shelf checks', () => {
    const vendor = mkItem({ id: 'vendor-rackscale', power: power(136), formFactor: { rack: 'orv3-mgx', unitPitchMm: 44.45 } });
    const res = evaluateRackPowerChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: vendor }]));
    expect(res.filter((r) => r.ruleId.startsWith('PW-0') && r.ruleId !== 'PW-04')).toEqual([]);
  });
  it('messages never claim compliance or certification', () => {
    const res = evaluateStandardsChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: hprRack(100, { weightKg: 1500 }) }])).results;
    for (const r of res) expect(`${r.message} ${r.messageEn}`).not.toMatch(/complian|certified|passes OCP|OCP Accepted|OCP Inspired/i);
  });
});
