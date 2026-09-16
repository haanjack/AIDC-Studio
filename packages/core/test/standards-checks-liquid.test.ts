// Stream C (P3) — CL liquid-cooling parameter checks with hand-computed cases (OCP-DESIGN-PROPOSAL §8.3, P0 cases).
import { describe, expect, it } from 'vitest';
import {
  cduUnitsOnBasis,
  connectorPairKW,
  connectorPairRating,
  connectorPairsNeeded,
  createNvidiaReferenceProject,
  evaluateLiquidChecks,
  manifoldPressurePsig,
  standardsPreset,
  uqdPairDpKPa,
  type CatalogItem,
  type Ctx,
  type EquipmentInstance,
  type Placed,
  type Project,
  type StandardsCheckResult,
  type StandardsPresetId,
  type StandardsProfile,
} from '../src/index.ts';
import { tcsBandCapacityKW, tcsKWForFlow, tcsLpmPerKW } from '../src/layout/pipes.ts';

const BASE = createNvidiaReferenceProject().project;

function mkItem(o: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    category: 'gpu-rack', vendor: 'Generic', model: o.id, name: o.id, description: '', dims: { w: 0.6, d: 1.068, h: 2.286 }, weightKg: 600,
    clearance: { front: 1, rear: 1, sides: 0 }, cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 }, source: 'public-spec', ...o,
  } as CatalogItem;
}
function mkProject(preset: StandardsPresetId, patch: Partial<StandardsProfile> = {}, edit: (p: Project) => void = () => {}): Project {
  const p = structuredClone(BASE);
  p.halls = [p.halls[0]];
  p.standards = { ...standardsPreset(preset), ...patch };
  p.busways = [];
  p.containments = [];
  Object.assign(p.cooling, { tcsSupplyC: 35, fwsSupplyC: 30, fwsReturnC: 40, tcsDeltaTK: 10 });
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
/** 4 nodes × 12 kW liquid: 60 kW rack at liquid fraction 0.8 */
const dlcRack = (o: Partial<CatalogItem> = {}) =>
  mkItem({ id: 'dlc-rack', power: power(60), cooling: { liquidFraction: 0.8, airflowM3s: 0.2, liquidFlowLpm: 0, maxInletC: 35 }, compute: { nodesPerRack: 4 } as CatalogItem['compute'], liquidInterface: { connector: 'bmqc', mawpKPa: 345, maxFluidC: 60 }, ...o });

describe('CL-01 flow per kW by fluid (Q = P · 60 / (ρ · cp · ΔT))', () => {
  it('water 1.440 L/min per kW, PG25 1.489 L/min per kW at ΔT 10 K; PG25 needs ≈ 3.4 % more flow', () => {
    expect(tcsLpmPerKW('treated-water', 10)).toBeCloseTo(60 / (0.997 * 4.18 * 10), 9);
    expect(tcsLpmPerKW('treated-water', 10)).toBeCloseTo(1.43975, 4);
    expect(tcsLpmPerKW('pg25', 10)).toBeCloseTo(1.48920, 4);
    expect(tcsLpmPerKW('pg25', 10) / tcsLpmPerKW('treated-water', 10)).toBeCloseTo(1.0343, 3);
    // the 1.5 L/min per kW white-paper recommendation ≈ ΔT 9.9 K with PG25
    expect(60 / (1.02 * 3.95 * 1.5)).toBeCloseTo(9.93, 2);
  });
});

describe('CL-04 connector flow per mated pair', () => {
  it('BMQC 9 L/min ≈ 6.0 kW, PBMC 36 L/min ≈ 24 kW, LQC V2 100 L/min ≈ 67 kW per pair at ΔT 10 K PG25', () => {
    expect(connectorPairKW('bmqc', 'pg25', 10)).toBeCloseTo((9 * 1.02 * 3.95 * 10) / 60, 9);
    expect(connectorPairKW('bmqc', 'pg25', 10)).toBeCloseTo(6.04, 2);
    expect(connectorPairKW('pbmc', 'pg25', 10)).toBeCloseTo(24.17, 2);
    expect(connectorPairKW('lqc', 'pg25', 10)).toBeCloseTo(67.15, 2);
    expect(connectorPairsNeeded(12, 'bmqc', 'pg25', 10)).toBe(2);
    expect(connectorPairsNeeded(13, 'bmqc', 'pg25', 10)).toBe(3);
  });
  it('UQD04 rated 6.4 L/min, Cv 0.80 → ΔP per pair at rating ≈ 31 kPa (SG 0.997: 1.691 GPM / 0.8 = 2.113; 2.113² × 0.997 = 4.453 psi = 30.7 kPa)', () => {
    expect(connectorPairRating('uqd', '04')).toEqual({ lpm: 6.4, cv: 0.8 });
    expect(uqdPairDpKPa(6.4, 0.8)).toBeCloseTo(30.7, 1);
    expect(uqdPairDpKPa(6.4, 0.8, 'pg25')).toBeCloseTo(31.41, 1);
  });
  it('12 kW of liquid per node on one BMQC pair (17.9 L/min) is a finding asking for 2 pairs; 4 declared ports (2 pairs, 8.9 L/min) pass', () => {
    const p = mkProject('orv3-hpr-liquid');
    const r1 = one(evaluateLiquidChecks(mkCtx(p, [{ item: dlcRack() }])), 'CL-04');
    expect(r1).toMatchObject({ status: 'finding', limit: 9, naturalSeverity: 'error', severity: 'warning', basis: 'estimate', standardId: 'orv3-bmqc@1.0' });
    expect(r1.designValue).toBeCloseTo(17.9, 1);
    expect(r1.messageEn).toContain('2 pairs are needed');
    const r2 = one(evaluateLiquidChecks(mkCtx(p, [{ item: dlcRack({ liquidInterface: { connector: 'bmqc', ports: 4, mawpKPa: 345, maxFluidC: 60 } }) }])), 'CL-04');
    expect(r2.status).toBe('pass');
    expect(r2.designValue).toBeCloseTo(8.9, 1);
  });
});

describe('CL-05 pressure envelope at the rack manifold', () => {
  it('row CDU head ≥ 40 psi + 15 psig static fill = 55 psig > 50 psig BMQC / blind-mate manifold (estimate basis → warning)', () => {
    const r = one(evaluateLiquidChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: dlcRack() }])), 'CL-05', 'bmqc');
    expect(r).toMatchObject({ status: 'finding', designValue: 55, limit: 50, naturalSeverity: 'error', severity: 'warning', basis: 'estimate' });
    expect(manifoldPressurePsig(mkProject('orv3-hpr-liquid').halls[0], 'facility-2mw')).toEqual({ psig: 105, basis: 'estimate' });
  });
  it('LQC V2: 60 psig operating ≤ 75 psig passes but is above the 50 psig connect / disconnect limit; 80 psig is an error under gate', () => {
    const lqc = (psig: number, strictness: 'advisory' | 'gate' = 'advisory') =>
      mkProject('orv3-hpr-liquid', { strictness, liquid: { ...standardsPreset('orv3-hpr-liquid').liquid, connector: 'lqc', rackManifold: 'none' } }, (p) => (p.halls[0].facility = { tcsManifoldPsig: psig }));
    const rack = dlcRack({ liquidInterface: { connector: 'lqc', ports: 2, mawpKPa: 517, maxFluidC: 60 } });
    const res60 = evaluateLiquidChecks(mkCtx(lqc(60), [{ item: rack }]));
    const operating = (res: StandardsCheckResult[]) => res.filter((x) => x.ruleId === 'CL-05' && !x.id.includes('connect'));
    expect(operating(res60)).toHaveLength(1);
    expect(operating(res60)[0]).toMatchObject({ status: 'pass', limit: 75 });
    expect(one(res60, 'CL-05', 'connect')).toMatchObject({ status: 'finding', limit: 50, naturalSeverity: 'warning' });
    expect(operating(evaluateLiquidChecks(mkCtx(lqc(80, 'gate'), [{ item: rack }])))[0]).toMatchObject({ status: 'finding', severity: 'error', basis: 'user' });
  });
});

describe('CL-06 fluid temperature window', () => {
  it('return 55 + 10 = 65 °C > 60 °C BMQC maximum; OAM cold-plate supply window 15–50 °C', () => {
    const hot = mkProject('orv3-hpr-liquid', {}, (p) => (p.cooling.tcsSupplyC = 55));
    expect(one(evaluateLiquidChecks(mkCtx(hot, [{ item: dlcRack() }])), 'CL-06', 'bmqc')).toMatchObject({ status: 'finding', designValue: 65, limit: 60 });
    const oam = dlcRack({ accelModule: { standard: 'oam-2.0', tdpW: 1000, cooling: 'liquid' } });
    const s52 = mkProject('orv3-hpr-liquid', {}, (p) => (p.cooling.tcsSupplyC = 52));
    expect(one(evaluateLiquidChecks(mkCtx(s52, [{ item: oam }])), 'CL-06', 'oam')).toMatchObject({ status: 'finding', designValue: 52, limit: 50, naturalSeverity: 'error' });
    expect(one(evaluateLiquidChecks(mkCtx(mkProject('orv3-hpr-liquid', {}, (p) => (p.cooling.tcsSupplyC = 33)), [{ item: oam }])), 'CL-06', 'oam').status).toBe('pass');
  });
});

describe('CL-02 / CL-03 CDU rating basis and approach', () => {
  it('never mixes L-LCDU 5 K and Loop Reqs 4 K ratings', () => {
    expect(cduUnitsOnBasis(3000, [{ ratedKW: 1400, convention: 'l-lcdu-wp-r1' }, { ratedKW: 1350, convention: 'loop-reqs-4k' }], 'N+1')).toEqual({ ok: false, conventions: ['l-lcdu-wp-r1', 'loop-reqs-4k'] });
    expect(cduUnitsOnBasis(3000, [{ ratedKW: 1400, convention: 'l-lcdu-wp-r1' }], 'N+1')).toEqual({ ok: true, convention: 'l-lcdu-wp-r1', n: 3, units: 4 });
  });
  it('row CDU class approach 5 K: TCS 33 °C − FWS 30 °C = 3 K is a finding', () => {
    const p = mkProject('orv3-hpr-liquid', {}, (x) => (x.cooling.tcsSupplyC = 33));
    expect(one(evaluateLiquidChecks(mkCtx(p, [{ item: dlcRack() }])), 'CL-03')).toMatchObject({ status: 'finding', designValue: 3, limit: 5 });
  });
});

describe('CL-08 branch bands · CL-11 door HX · CL-15 / CL-16 envelopes', () => {
  it('DN50 band 215 kW at 10 K scales to 107.5 kW at 5 K; a 120 kW rack on a DN25 branch (55 kW) is a finding', () => {
    expect(tcsBandCapacityKW(50, 5)).toBe(107.5);
    expect(tcsKWForFlow('pg25', tcsLpmPerKW('pg25', 7) * 100, 7)).toBeCloseTo(100, 9);
    const big = dlcRack({ power: power(150), liquidInterface: { connector: 'bmqc', ports: 8, branchDN: 25, mawpKPa: 345, maxFluidC: 60 } });
    expect(one(evaluateLiquidChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: big }])), 'CL-08')).toMatchObject({ status: 'finding', designValue: 120, limit: 55 });
  });
  it('door HX water supply 14 °C < 16 °C is a finding; 16 °C passes', () => {
    const door = (c: number) => mkProject('orv3-air-dhx', { inferred: false }, (p) => (p.cooling.fwsSupplyC = c));
    const rack = mkItem({ id: 'air-rack', power: power(30), cooling: { liquidFraction: 0, airflowM3s: 2, liquidFlowLpm: 0, maxInletC: 35 } });
    expect(one(evaluateLiquidChecks(mkCtx(door(14), [{ item: rack, meta: { rdhxDoorKW: 30 } }])), 'CL-11', 'supply')).toMatchObject({ status: 'finding', limit: 16, naturalSeverity: 'error' });
    expect(one(evaluateLiquidChecks(mkCtx(door(16), [{ item: rack, meta: { rdhxDoorKW: 30 } }])), 'CL-11', 'supply').status).toBe('pass');
  });
  it('CL-15: an air-cooled 700 W accelerator module → info; CL-16: 8 × 1400 W + 3200 W = 14,400 W > 12,000 W baseboard → warning', () => {
    const p = mkProject('eia-air');
    const air = mkItem({ id: 'oam-air', power: power(40), cooling: { liquidFraction: 0, airflowM3s: 2, liquidFlowLpm: 0, maxInletC: 35 }, accelModule: { standard: 'oam-2.0', tdpW: 700, cooling: 'air' } });
    expect(one(evaluateLiquidChecks(mkCtx(p, [{ item: air }])), 'CL-15')).toMatchObject({ status: 'finding', severity: 'info', designValue: 700, limit: 600 });
    const hot = dlcRack({ id: 'ubb-hot', accelModule: { standard: 'oam-2.0', tdpW: 1400, cooling: 'liquid' }, baseboard: { standard: 'ubb-2.0', modules: 8, inputV: 54 } });
    const res = evaluateLiquidChecks(mkCtx(mkProject('orv3-hpr-liquid'), [{ item: hot }]));
    expect(one(res, 'CL-16', 'std-cl16')).toMatchObject({ status: 'finding', designValue: 14400, limit: 12000, naturalSeverity: 'warning' });
    expect(one(res, 'CL-16', 'env-oam')).toMatchObject({ severity: 'info', designValue: 1400, limit: 1000 });
  });
});
