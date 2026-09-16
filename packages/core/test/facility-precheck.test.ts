// Stream C (P3) — informational facility pre-check against both assessment revisions (OCP-DESIGN-PROPOSAL §5.4, §8.3).
import { describe, expect, it } from 'vitest';
import {
  CORRIDOR_DEFAULTS,
  createNvidiaReferenceProject,
  evaluateFacilityChecks,
  facilityAttributes,
  facilityLevel,
  facilityPrecheck,
  standardsPreset,
  type CatalogItem,
  type Ctx,
  type Hall,
  type Placed,
  type Project,
} from '../src/index.ts';

const BASE = createNvidiaReferenceProject().project;

function mkProject(edit: (p: Project, hall: Hall) => void = () => {}, profilePatch: Record<string, unknown> = {}): Project {
  const p = structuredClone(BASE);
  p.halls = [p.halls[0]];
  p.standards = { ...standardsPreset('orv3-hpr-liquid'), ...profilePatch };
  const hall = p.halls[0];
  hall.layoutPolicy = { ...(hall.layoutPolicy ?? {}), corridors: { ...CORRIDOR_DEFAULTS, coldAisleM: 1.2, hotAisleM: 1.2 } } as Hall['layoutPolicy'];
  edit(p, hall);
  return p;
}
const row = (p: Project, basis: 'facility-v1@1.5' | 'facility-v2hs@1.15', key: string) => facilityPrecheck(p, p.halls[0], basis).rows.find((r) => r.key === key)!;

describe('facility pre-check (informational)', () => {
  it('default 1.2 m cold aisle: v1 rev 1.5 acceptable, v2 for Hyperscale rev 1.15 exception', () => {
    const p = mkProject();
    expect(row(p, 'facility-v1@1.5', 'cold-aisle-width')).toMatchObject({ designValue: 1200, level: 'acceptable', ruleId: 'FC-01' });
    expect(row(p, 'facility-v2hs@1.15', 'cold-aisle-width')).toMatchObject({ designValue: 1200, level: 'exception' });
    expect(row(p, 'facility-v2hs@1.15', 'hot-aisle-width').level).toBe('optimum');
  });
  it('generator acceptance 30 s: v1 optimum (≤ 60 s), v2HS acceptable (≤ 35 s); 15 s optimum on both; absent → not modelled', () => {
    const at = (s?: number) => mkProject((_p, h) => (h.facility = s === undefined ? undefined : { generatorAcceptanceS: s }));
    expect(row(at(30), 'facility-v1@1.5', 'generator-load-acceptance').level).toBe('optimum');
    expect(row(at(30), 'facility-v2hs@1.15', 'generator-load-acceptance').level).toBe('acceptable');
    expect(row(at(15), 'facility-v2hs@1.15', 'generator-load-acceptance').level).toBe('optimum');
    expect(row(at(), 'facility-v1@1.5', 'generator-load-acceptance').level).toBe('not-modelled');
  });
  it('slab vs access floor: equal thresholds split optimum / acceptable by floor construction', () => {
    const a = facilityAttributes('facility-v2hs@1.15').find((x) => x.key === 'white-space-uniform-load')!;
    expect(facilityLevel(a, 1500, false).level).toBe('optimum');
    expect(facilityLevel(a, 1500, true).level).toBe('acceptable');
    expect(facilityLevel(a, 1000, false).level).toBe('exception');
    const v1 = facilityAttributes('facility-v1@1.5').find((x) => x.key === 'white-space-concentrated-load')!;
    expect(facilityLevel(v1, 500)).toEqual({ level: 'acceptable', withNotes: true });
  });
  it('lists the not-modelled areas explicitly and says it is not an assessment or certification', () => {
    const rep = facilityPrecheck(mkProject(), mkProject().halls[0], 'facility-v2hs@1.15');
    expect(rep.rows.filter((r) => r.ruleId === 'FC-10').length).toBe(7);
    expect(rep.counts['not-modelled']).toBeGreaterThanOrEqual(7);
    expect(rep.summaryEn).toContain('Informational pre-check, not an OCP assessment or certification.');
    expect(rep.summaryKo).toContain('OCP 평가나 인증이 아닙니다');
    expect(rep.summaryEn).not.toMatch(/complian|certified|OCP Ready(®|™)? (compliant|certified|approved)/i);
    const density = rep.rows.find((r) => r.key === 'rack-density');
    expect(density?.noteEn).toContain('not an indicator of fitness for liquid-cooled racks');
  });
  it('FC-05S: a 3,000 kg rack puts 750 kg on each of 4 load points (> 680 kg class) → warning; inferred profile → info; pre-check off → nothing', () => {
    const rack = { id: 'heavy', category: 'gpu-rack', vendor: 'Generic', model: 'heavy', name: 'heavy', description: '', dims: { w: 1.2, d: 1.2, h: 2.3 }, weightKg: 3000, clearance: { front: 1, rear: 1, sides: 0 }, cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 }, source: 'estimate', power: { nameplateKW: 100, typicalKW: 100, idleKW: 0, peakKW: 100, feeds: 2, voltageV: 415 } } as CatalogItem;
    const ctxFor = (p: Project): Ctx => {
      const hall = p.halls[0];
      const placed: Placed[] = [{ e: { id: 'eq-heavy', catalogId: 'heavy', hallId: hall.id, tag: 'H-01', position: { x: 1, y: 1 }, rotationDeg: 0 }, item: rack, hall }];
      return { project: p, placed, unknown: [], halls: new Map([[hall.id, hall]]), byHall: new Map([[hall.id, placed]]), byPod: new Map(), gpus: 0, gpuRack: undefined, acceleratorChips: 0 };
    };
    const adv = evaluateFacilityChecks(ctxFor(mkProject()));
    expect(adv.reports).toHaveLength(1);
    expect(adv.results.find((r) => r.ruleId === 'FC-05S')).toMatchObject({ severity: 'warning', designValue: 750, limit: 680 });
    expect(adv.results.find((r) => r.ruleId === 'FC-00')?.severity).toBe('info');
    const inferred = evaluateFacilityChecks(ctxFor(mkProject(() => {}, { inferred: true })));
    expect(inferred.results.every((r) => r.severity === 'info')).toBe(true);
    expect(evaluateFacilityChecks(ctxFor(mkProject(() => {}, { facilityPrecheck: 'off' }))).reports).toEqual([]);
  });
});
