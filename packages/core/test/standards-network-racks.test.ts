// Stream C (P3) — NW rules, OU-aware rack contents, neutral fallbacks and the legacy-project posture (OCP-DESIGN-PROPOSAL §5.1, §5.5, §8.3).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  buildCableSchedule,
  coolingPlacementFor,
  createNvidiaReferenceProject,
  defaultCoolingItem,
  regenerateCoolingReport,
  evaluateNetworkChecks,
  FABRIC_SWITCH,
  findCatalogItem,
  rackSlotMap,
  rackTotalU,
  rackUnitLabel,
  standardsPreset,
  summarizeCableSchedule,
  twoTierSpinesFor,
  upgradeProject,
  type CatalogItem,
  type Ctx,
  type NetworkAnalysis,
  type Placed,
  type Project,
} from '../src/index.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const BASE = createNvidiaReferenceProject().project;

function mkItem(o: Partial<CatalogItem> & { id: string }): CatalogItem {
  return {
    category: 'gpu-rack', vendor: 'Generic', model: o.id, name: o.id, description: '', dims: { w: 0.6, d: 1.068, h: 2.286 }, weightKg: 600,
    clearance: { front: 1, rear: 1, sides: 0 }, cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 }, source: 'public-spec', ...o,
  } as CatalogItem;
}
function mkCtx(items: CatalogItem[], gpus = 0): Ctx {
  const project = structuredClone(BASE);
  project.halls = [project.halls[0]];
  project.standards = standardsPreset('orv3-hpr-liquid');
  const hall = project.halls[0];
  const placed: Placed[] = items.map((item, k) => ({ e: { id: `eq-${k}`, catalogId: item.id, hallId: hall.id, tag: `R${k}`, position: { x: 1, y: 1 }, rotationDeg: 0 }, item, hall }));
  return { project, placed, unknown: [], halls: new Map([[hall.id, hall]]), byHall: new Map([[hall.id, placed]]), byPod: new Map(), gpus, gpuRack: items[0], acceleratorChips: 0 };
}

describe('NW rules', () => {
  it('two-tier 51.2T non-blocking spines: 3,840 xPUs → 30 (even 30); 3,900 → 31 (even 32)', () => {
    expect(twoTierSpinesFor(3840)).toEqual({ min: 30, even: 30 });
    expect(twoTierSpinesFor(3900)).toEqual({ min: 31, even: 32 });
  });
  it('NW-01: 3,840 xPUs exceed the 1,024-xPU published cluster → info with the spine estimate', () => {
    const net = { fabrics: [{ name: 'Scale-out (generic)', fabric: 'roce-generic-400', endpoints: 3840, tiers: [{ name: 'leaf', switches: 120, portsPerSwitch: 64, downlinks: 32, uplinks: 32 }, { name: 'spine', switches: 30, portsPerSwitch: 128, downlinks: 128, uplinks: 0 }], switchCatalogId: 'x', totalSwitches: 150, bisectionGbps: 0, oversubscription: 1, maxHops: 3, powerKW: 0, racksNeeded: 0, topology: 'rail-optimized' }] } as unknown as NetworkAnalysis;
    const res = evaluateNetworkChecks(mkCtx([mkItem({ id: 'n', compute: { gpus: 40, railsPerNode: 8 } as CatalogItem['compute'] })], 3840), net);
    const r = res.find((x) => x.id === 'std-nw01-cluster')!;
    expect(r).toMatchObject({ status: 'finding', severity: 'info', designValue: 3840, limit: 1024 });
    expect(r.messageEn).toContain('at least 30 spines');
    expect(res.find((x) => x.id === 'std-nw01-pod')?.messageEn).toContain('4 × 26T rail leaves');
  });
  it('NW-02: a switched scale-up domain of 2,048 accelerators exceeds 1,024; NW-03 flags rails estimated from the domain', () => {
    const big = mkItem({ id: 'ual', compute: { gpus: 72, scaleUp: { kind: 'ualink', domainSize: 2048, gbpsPerGpu: 800, spansRacks: true } } as CatalogItem['compute'] });
    const res = evaluateNetworkChecks(mkCtx([big]));
    expect(res.find((x) => x.ruleId === 'NW-02' && x.id.startsWith('std-nw02-ual'))).toMatchObject({ naturalSeverity: 'error', severity: 'warning', limit: 1024 });
    expect(res.find((x) => x.ruleId === 'NW-02' && x.id.includes('span'))?.severity).toBe('info');
    expect(res.find((x) => x.ruleId === 'NW-03')?.basis).toBe('estimate');
  });
});

describe('OU-aware rack contents (RK-01 elevations)', () => {
  it('rack-standard defaults for GPU racks without a count: ORv3 HPR / ORW 44 OU, Google ORv3 implementation 39 OU, vendor rack-scale / EIA 48 U', () => {
    expect(rackTotalU(mkItem({ id: 'a', formFactor: { rack: 'orv3-hpr', unitPitchMm: 48 } }))).toBe(44);
    expect(rackTotalU(mkItem({ id: 'b', formFactor: { rack: 'orv3', unitPitchMm: 48, implementation: 'orv3-frame-google@0.2' } }))).toBe(39);
    expect(rackTotalU(mkItem({ id: 'c', formFactor: { rack: 'orv3-mgx', unitPitchMm: 44.45 } }))).toBe(48);
    expect(rackTotalU(mkItem({ id: 'd', meta: { rackForm: 'orw-double-wide' } }))).toBe(44);
    expect(rackUnitLabel(mkItem({ id: 'e', formFactor: { rack: 'orw', unitPitchMm: 48 } }))).toBe('OU');
    expect(rackUnitLabel(mkItem({ id: 'f', formFactor: { rack: 'orv3-mgx', unitPitchMm: 44.45 } }))).toBe('U');
    // stored vendor sample elevations keep their size (GB300 NVL72 class: 48 U)
    const gb = findCatalogItem('nvidia-gb300-nvl72');
    if (gb) expect(rackTotalU(gb)).toBe(48);
  });
  it('ORv3 HPR node archetype: 5 × 6 OU nodes, 9 OU power zone (3 × 1 OU PSU + 3 × 2 OU BBU), 2 ToR positions, blanks to 44 OU', () => {
    const item = mkItem({ id: 'hpr-dlc', formFactor: { rack: 'orv3-hpr', unitPitchMm: 48, heightUnits: 44, usableUnits: 44, nodeHeightUnits: 6 }, compute: { gpus: 40, gpusPerNode: 8, nodesPerRack: 5, gpuModel: 'OAM' } as CatalogItem['compute'] });
    const map = rackSlotMap(item, undefined, findCatalogItem);
    expect(map.unit).toBe('OU');
    expect(map.totalU).toBe(44);
    const units = (cat: string) => map.slots.filter((s) => s.category === cat).reduce((a, s) => a + s.units, 0);
    expect(map.slots.filter((s) => s.category === 'gpu-node')).toHaveLength(5);
    expect(units('gpu-node')).toBe(30);
    expect(units('power-shelf')).toBe(9);
    expect(units('reserved')).toBe(2);
    expect(map.slots.reduce((a, s) => a + s.units, 0)).toBe(44);
    const zone = map.slots.filter((s) => s.category === 'power-shelf').map((s) => s.uStart).sort((a, b) => a - b);
    expect(zone[0]).toBe(13);
  });
});

describe('vendor-neutral fallbacks (proposal P1)', () => {
  it('generic Ethernet fabrics default to generic switch classes; cooling fallbacks pick generic classes', () => {
    for (const f of ['ethernet-400', 'ethernet-200', 'ethernet-100', 'ethernet-1g'] as const) expect(findCatalogItem(FABRIC_SWITCH[f])?.vendor, f).toBe('Generic');
    expect(defaultCoolingItem('crah')?.vendor).toBe('Generic');
    expect(defaultCoolingItem('cdu')).toMatchObject({ vendor: 'Generic', cdu: { class: 'facility' } });
    expect(defaultCoolingItem('cdu', { cduClass: 'row-l2l' })).toMatchObject({ vendor: 'Generic', cdu: { class: 'row-l2l' } });
    expect(defaultCoolingItem('fan-wall')?.vendor).toBe('Generic');
  });
  it('stream C engine / layout files carry no vendor catalog id literal or id regex', () => {
    const files = ['engines/standardsChecks.ts', 'engines/standardsBasis.ts', 'engines/facilityPrecheck.ts', 'engines/cooling.ts', 'engines/coolingTopology.ts', 'layout/coolingPlacement.ts', 'layout/fit.ts', 'layout/rackContents.ts', 'layout/pipes.ts'];
    // catalog ids only: fabric technology keys (e.g. the scheduled-cell fabric key) are not catalog ids and stay allowed
    const vendorId = /['"`](?!drivenets-fse['"`])(nvidia|vertiv|liebert|amd|coolit|motivair|boyd|intel|dell|arista|cisco|juniper|broadcom|drivenets|hgx|groq|cerebras|rebellions|furiosa|sambanova|tenstorrent)-[a-z0-9]/i;
    for (const f of files) {
      const src = readFileSync(join(REPO, 'packages/core/src', f), 'utf8');
      expect(src.match(vendorId)?.[0], f).toBeUndefined();
      expect(/\/-nvl\\d\+\/|\/helios\/i/.test(src), `${f}: id regex`).toBe(false);
    }
  });
});

describe('backlog T1a item 7: in-row / per-pod refusal names the row extension', () => {
  it('a refused cooling-only regeneration reports the worst row, the needed extension, the free distance and the blocker', () => {
    const project = structuredClone(BASE);
    const hall = project.halls[0];
    const r = regenerateCoolingReport(project, hall.id, { ...coolingPlacementFor(hall), crahStrategy: 'in-row', crahCount: 400 });
    expect(r.requiresRegenerate).toBe(true);
    const ext = r.rowExtension!;
    expect(ext.units).toBeGreaterThan(0);
    expect(ext.unitsM).toBeGreaterThan(0);
    expect(['wall', 'equipment']).toContain(ext.blocker);
    expect(ext.freeM).toBeLessThan(ext.unitsM + ext.aisleM);
    const issue = r.issues.find((i) => i.id.startsWith('layout-crah-short'))!;
    expect(issue.messageEn).toContain(`Worst row ${ext.rowId}`);
    expect(issue.message).toContain(`가장 부족한 열 ${ext.rowId}`);
  });
});

describe('backlog #10: surplus OOB uplinks are reported', () => {
  it('uplinks beyond the free front-end spine / leaf lanes are counted, match the schedule\'s unresolved ends and raise a warning; the reference stays clean', () => {
    const ref = structuredClone(BASE);
    const a0 = analyzeProject(ref);
    expect(a0.network.oobUplinksUnterminated).toBeUndefined();
    expect(a0.issues.some((i) => i.id === 'network-oob-uplinks-unterminated')).toBe(false);
    const p = structuredClone(BASE);
    p.network.scaleOut = { ...p.network.scaleOut, fabric: 'roce-generic-400', switchCatalogId: FABRIC_SWITCH['roce-generic-400'] };
    p.network.frontend = { ...p.network.frontend, switchCatalogId: 'switch-eth-13t-32x400', oversubscription: 1 };
    const a = analyzeProject(p);
    const n = a.network.oobUplinksUnterminated ?? 0;
    expect(n).toBeGreaterThan(0);
    expect(summarizeCableSchedule(buildCableSchedule(p, a)).unresolvedEnds).toBe(n);
    expect(a.issues.find((i) => i.id === 'network-oob-uplinks-unterminated')).toMatchObject({ severity: 'warning', domain: 'network' });
  });
});

describe('legacy projects stay advisory (stored copies, read-only)', () => {
  const dir = join(REPO, 'data/projects');
  const stored: Project[] = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Project) : [];
  it.skipIf(stored.length === 0)('every standards finding of an upgraded inferred legacy project is info', () => {
    for (const raw of stored) {
      if (raw.standards) continue; // an explicit confirmed profile keeps its configured strictness
      const up = upgradeProject(raw);
      expect(up.standards?.inferred).toBe(true);
      const std = analyzeProject(up).issues.filter((i) => i.check);
      expect(std.every((i) => i.severity === 'info'), std.filter((i) => i.severity !== 'info').map((i) => i.id).join(', ')).toBe(true);
    }
  });
});
