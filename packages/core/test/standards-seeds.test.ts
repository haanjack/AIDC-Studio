// Stream B (P2): standards building-block seeds — OCP-DESIGN-PROPOSAL §3, §8.3 "standards-seeds.test.ts", P0 impacts box.
import { describe, expect, it } from 'vitest';
import {
  applyStandardsClassification,
  CATALOG,
  CATALOG_DATA_CHANGES,
  catalogDataChangesFor,
  COOLANT_DESCRIPTORS,
  createNvidiaReferenceProject,
  facilityAttributes,
  findCatalogItem,
  findRackModel,
  findStandard,
  itemSpecStatus,
  kwPerLpm,
  NETWORK_POD_ARCHETYPES,
  NEUTRAL_REFERENCE_BASIS,
  NO_STANDARD,
  NODE_SPECS,
  RACK_MODELS,
  SHELF_FEED_CLASSES,
  STD_COMPUTE_NETWORK_CATALOG,
  STD_COOLING_CATALOG,
  STD_NODE_SPECS,
  STD_RACK_POWER_CATALOG,
  TCS_PIPE_BANDS,
  VENDOR_CLASSIFICATION,
  weakestStatus,
  type CatalogItem,
} from '../src/index.ts';

const BLOCKS: CatalogItem[] = [...STD_RACK_POWER_CATALOG, ...STD_COOLING_CATALOG, ...STD_COMPUTE_NETWORK_CATALOG];
const get = (id: string) => {
  const it = findCatalogItem(id);
  expect(it, id).toBeDefined();
  return it!;
};

describe('standards seeds — every generic block', () => {
  it('is in the builtin catalog, vendor Generic, with standards[], specStatus and provenance for spec-derived fields', () => {
    expect(BLOCKS.length).toBeGreaterThanOrEqual(60);
    const ids = new Set(CATALOG.map((c) => c.id));
    for (const b of BLOCKS) {
      expect(ids.has(b.id), b.id).toBe(true);
      expect(b.vendor, b.id).toBe('Generic');
      expect(b.standards?.length, b.id).toBeGreaterThan(0);
      expect(b.specStatus, b.id).toBeTruthy();
      expect(b.specStatus, b.id).toBe(itemSpecStatus(b.standards));
      expect(Object.keys(b.paramSources ?? {}).length, b.id).toBeGreaterThan(0);
      for (const s of b.standards!) if (s.standardId !== NO_STANDARD) expect(findStandard(s.standardId), `${b.id} → ${s.standardId}`).toBeTruthy();
      for (const [path, p] of Object.entries(b.paramSources!)) {
        expect(['verified', 'derived', 'estimate', 'unverified'], `${b.id}.${path}`).toContain(p.verification);
        if (p.verification === 'verified') expect(findStandard(p.standardId ?? ''), `${b.id}.${path} cites a registry document`).toBeTruthy();
      }
      if (b.source === 'estimate') expect(b.notes ?? '', b.id).not.toBe('');
    }
  });

  it('ids, names and descriptions carry no organisation mark and no certification wording; no private paths', () => {
    for (const b of [...BLOCKS, ...STD_NODE_SPECS.map((n) => ({ id: n.id, name: n.name, description: n.description ?? '', model: n.model, notes: n.notes }))]) {
      const text = `${b.id}\n${b.name}\n${(b as CatalogItem).model ?? ''}`;
      expect(text, b.id).not.toMatch(/ocp|open compute/i);
      expect(`${b.description}\n${b.notes ?? ''}`, b.id).not.toMatch(/\bOCP\b|compliant|certified|accepted design|ready®?/i);
    }
    expect(JSON.stringify(BLOCKS)).not.toMatch(/docs\/(research|legal)|aidc-private|file:\/\//);
    // internal legacy level keys never appear in seeds
    expect(JSON.stringify(CATALOG)).not.toMatch(/"ocp-based"|"ocp-contributed-design"|"ocp-inspired-host"/);
  });

  it('non-floor blocks are marked (meta.blockKind, not placeable); drafts behind the toggle follow DO-4', () => {
    for (const b of BLOCKS.filter((x) => x.category === 'other')) {
      expect(b.meta?.placeable, b.id).toBe(false);
      expect(b.meta?.blockKind, b.id).toBeTruthy();
    }
    const behind = BLOCKS.filter((b) => b.meta?.behindDraftsToggle).map((b) => b.id).sort();
    expect(behind).toEqual(['busbar-pm400', 'power-rack-pm400', 'pshelf-hpr-v2-72kw']);
    expect(get('pshelf-hpr-v2-72kw').standards!.map((s) => s.standardId)).toContain(NEUTRAL_REFERENCE_BASIS.behindDraftsToggle[0]);
    // HPR v1 blocks visible with a draft chip; the wide rack is released (no draft chip)
    expect(get('pshelf-orv3-hpr-33kw').specStatus).toBe('draft');
    expect(get('pshelf-orv3-hpr-33kw').meta?.behindDraftsToggle).toBeUndefined();
    expect(get('rack-orw').specStatus).toBe('accepted');
    expect(get('rack-orv3').specStatus).toBe('contributed');
  });

  it('is never tagged for the cooling topology comparison (existing projects keep their comparison rows)', () => {
    for (const b of BLOCKS) expect(b.meta?.coolingTopology, b.id).toBeUndefined();
  });
});

describe('standards seeds — key numbers match the cited values', () => {
  it('rack enclosures: one frame implementation (P0), wide rack released values', () => {
    const F = NEUTRAL_REFERENCE_BASIS.frame;
    for (const id of ['rack-orv3', 'rack-orv3-hpr']) {
      const r = get(id);
      expect(r.formFactor).toMatchObject({ unitPitchMm: 48, heightUnits: 44, implementation: F.standardId, payloadKg: 1400, payloadExcludesFrame: true, crossBraceAboveKg: 800, itShelfKgPerSet: 80 });
      expect(r.dims.w * 1000).toBeCloseTo(F.widthMm, 6);
      expect(r.dims.d * 1000).toBeCloseTo(F.depthMm, 6);
      expect(r.rackPower).toMatchObject({ rangeV: [46, 52] });
    }
    expect(get('rack-orv3-hpr').meta).toMatchObject({ powerZoneUnits: 9, shelfSetsTotalKW: 93.5, shelfKWAtNplus1: 27.5, maxRackKWAtNplus1: 82.5 });
    const orw = get('rack-orw');
    expect(orw.formFactor).toMatchObject({ rack: 'orw', payloadKg: 4700, itShelfKgPerSet: 125, heightUnits: 44 });
    expect(orw.meta?.busbarDatumMm).toBe(802.59);
    expect([orw.dims.w, orw.dims.d, orw.dims.h]).toEqual([1.2, 1.219, 2.39]);
    expect(get('rack-eia310-48u').formFactor).toMatchObject({ rack: 'eia-310-19', unitPitchMm: 44.45, heightUnits: 48 });
  });

  it('power shelves, BBU and power rack', () => {
    expect(get('pshelf-orv3-hpr-33kw').powerShelf).toMatchObject({ shelfKW: 33, ratedKWAtRedundancy: 27.5, outputV: [50, 49], availableFaultKA: 25, parallelMax: 3, busbarInterface: 'hpr-v1-clip' });
    expect(get('pshelf-orv3-hpr-33kw').powerShelf!.outputConnector.stillAirA).toBe(700);
    expect(get('pshelf-orv3-18kw').powerShelf).toMatchObject({ shelfKW: 18, ratedKWAtRedundancy: 15 });
    expect(get('pshelf-orv3-18kw').powerShelf!.outputConnector).toMatchObject({ stillAirA: 360, airflowA: 500, airflowLFM: 300, ambientC: 45 });
    expect(get('pshelf-orv3-18kw').powerShelf!.acInputs.A).toBe(32);
    const v2 = get('pshelf-hpr-v2-72kw').powerShelf!;
    expect(v2).toMatchObject({ psuKW: 12, shelfKW: 72, ratedKWAtRedundancy: 60, availableFaultKA: 40, parallelMax: 10, busbarInterface: 'hprv3-power-rack-bolted' });
    expect(v2.outputConnector).toMatchObject({ stillAirA: 2000, airflowA: 2000, airflowLFM: 390, ambientC: 75 });
    expect(get('pshelf-hpr-v2-72kw').paramSources!['powerShelf.shelfKW'].verification).toBe('derived');
    expect(get('bbu-orv3-3kw').bbu).toMatchObject({ moduleKW: 3, modules: 6, eolBackupS: 90, bolBackupS: 240 });
    expect(get('bbu-orv3-3kw').bbu!.eolBackupS).toBe(NEUTRAL_REFERENCE_BASIS.bbu.eolBackupS);
    expect(get('bbu-shelf-hpr-33kw').bbu!.backupCurve).toEqual([{ kw: 20, seconds: 240 }, { kw: 27.5, seconds: 90 }]);
    const pr = get('power-rack-pm400').powerRack!;
    expect(pr.ratingKWByInputV).toEqual({ 480: 1100, 415: 1100, 400: 718 });
    expect(pr.inputs).toMatchObject({ count: 12, A: 200 });
    expect(pr.bbuSeconds).toEqual([45, 90]);
    expect(get('power-rack-pm400').specStatus).toBe('draft');
    expect(SHELF_FEED_CLASSES.find((f) => f.id === 'feed-60a-v2-nec')).toMatchObject({ A: 60, continuousA: 48, faultKA: 40 });
  });

  it('liquid connectors, manifolds and CDU rating conventions', () => {
    const bmqc = get('qd-bmqc');
    expect(bmqc.liquidInterface).toMatchObject({ connector: 'bmqc', ratedLpmPerPort: 9, maxFluidC: 60 });
    expect(bmqc.liquidInterface!.mawpKPa).toBeCloseTo(50 * 6.894757, 0);
    expect(bmqc.meta?.kwPerPairAt10K).toBeCloseTo(6.0, 1);
    expect(9 * kwPerLpm('treated-water', 10)).toBeCloseTo(6.3, 1);
    const lqc = get('qd-lqc-v2').liquidInterface!;
    expect(lqc.connector).toBe('lqc');
    expect(lqc.mawpKPa).toBeCloseTo(75 * 6.894757, 0);
    expect(lqc.connectMawpKPa).toBeCloseTo(50 * 6.894757, 0);
    expect(lqc.ratedLpmPerPort).toBe(100);
    expect(get('qd-lqc-v2').meta?.kwPerPairAt10K).toBeCloseTo(67, 0);
    expect(get('qd-pbmc-1').liquidInterface).toMatchObject({ connector: 'pbmc', ratedLpmPerPort: 36 });
    expect(get('qd-pbmc-1').meta?.kwPerPairAt10K).toBeCloseTo(24, 0);
    expect(get('qd-pbmc-1').meta?.autoEligibleForBlindMateManifold).toBe(false);
    expect(get('qd-uqd04').liquidInterface!.ratedLpmPerPort).toBeCloseTo(6.4, 1);
    expect(get('qd-uqd04').meta?.dpAtRatedKPa).toBeCloseTo(31, 0);
    expect(get('manifold-rack-orv3-bm').liquidInterface).toMatchObject({ portPitch: 'OU', maxFlowSpreadPct: 5 });
    for (const kw of [350, 700, 1400]) {
      const c = get(`cdu-row-l2l-${kw}`);
      expect(c.cdu!.ratingBasis).toMatchObject({ convention: 'l-lcdu-wp-r1', approachK: 5, lpmPerKW: 1.5, tcsHeadPsi: 40, fwsDpPsi: 75 });
      expect(c.capacity).toMatchObject({ coolingKW: kw, liquidFlowLpm: kw * 1.5 });
      expect((c.meta!.ratings as { coolingKW: number }[])[0].coolingKW).toBe(kw);
    }
    const fac = get('cdu-facility-2mw');
    expect(fac.capacity?.coolingKW).toBe(2000);
    expect(fac.cdu).toMatchObject({ class: 'facility', ratedApproachK: 3, parasiticKW: 74, filtrationUm: 0.2 });
    expect(fac.cdu!.ratingBasis.convention).toBe('vendor');
    expect(fac.weightKg).toBe(3134);
    expect(get('rdhx-door-orv3').doorHx).toMatchObject({ depthMm: 305, massKg: 150, minSupplyC: 16, coolantDpKPa: 100, aisleOpenMm: 1200 });
    expect(TCS_PIPE_BANDS.capacityKW(50, 10)).toBe(215);
    expect(TCS_PIPE_BANDS.capacityKW(100, 5)).toBe(420);
    expect(COOLANT_DESCRIPTORS.map((c) => c.id)).toEqual(['fluid-pg25', 'fluid-treated-water']);
  });

  it('compute and network: module / board / NIC envelopes, capped DLC node, neutral reference rack', () => {
    const dlc = STD_NODE_SPECS.find((n) => n.id === 'node-ubb8-oam-dlc')!;
    expect(dlc.accelModule!.tdpW).toBe(NEUTRAL_REFERENCE_BASIS.dlcNode.moduleCapW);
    expect(dlc.gpu!.wattsW).toBe(1000);
    expect(dlc.rackUnits).toBeLessThanOrEqual(NEUTRAL_REFERENCE_BASIS.dlcNode.maxHeightUnits);
    expect(dlc.formFactor).toMatchObject({ ownRails: true, unitPitchMm: 48 });
    expect(dlc.baseboard).toMatchObject({ standard: 'ubb-2.0', modules: 8, maxBoardW: 12000, outlineMm: [417, 655] });
    expect(dlc.paramSources!['power'].verification).toBe('derived');
    expect(STD_NODE_SPECS.find((n) => n.id === 'node-ubb8-oam-air')!.accelModule!.tdpW).toBe(600);
    // liquid heat per node fits two blind-mate pairs at 1.5 L/min per kW
    expect(dlc.power.nameplateKW * dlc.cooling.liquidFraction).toBeLessThanOrEqual(2 * 6);

    const ref = get('ubb8-oam-dlc-hpr-5x');
    expect(ref.compute).toMatchObject({ gpus: 40, nodesPerRack: 5, gpusPerNode: 8 });
    expect(ref.power!.nameplateKW).toBeLessThanOrEqual(82.5);
    expect(ref.formFactor).toMatchObject({ rack: 'orv3-hpr', nodeHeightUnits: 6, ownRails: true, implementation: 'orv3-frame-meta@1.3' });
    expect(ref.meta?.ruUsed).toBe(5 * 6 + 3 * 1 + 3 * 2);
    expect(ref.meta?.rackClass).toBe('accel-node-8x');
    expect(ref.weightKg - findRackModel('rack-orv3-hpr')!.weightKg).toBeLessThan(800);
    expect(get('rackscale-liquid-72').compute).toMatchObject({ gpus: 72, nodesPerRack: 18, gpusPerNode: 4 });
    expect(get('rackscale-liquid-72').meta?.rackClass).toBe('rack-scale-liquid');

    expect(get('nic3-sff').nic).toMatchObject({ formFactor: 'nic3-sff', wattsMax: 80, hostInterface: 'PCIe Gen5 x16' });
    expect(get('nic3-dsff').nic).toMatchObject({ formFactor: 'nic3-dsff', wattsMax: 160 });
    expect(get('nic3-lff').nic!.wattsMax).toBe(150);
    expect(get('nic3-lff').meta?.deprecated).toBe(true);
    expect(get('switch-eth-51t-64x800')).toMatchObject({ weightKg: 24 });
    expect(get('switch-eth-51t-64x800').power!.nameplateKW).toBe(3.2);
    expect(get('switch-eth-26t-32x800').switch).toMatchObject({ ports: 32, portGbps: 800 });
    const opg = NETWORK_POD_ARCHETYPES.find((a) => a.id === 'pod-opg-128')!;
    expect(opg).toMatchObject({ xpus: 128, nodes: 16, basis: 'document' });
    expect(NETWORK_POD_ARCHETYPES.find((a) => a.id === 'cluster-xoc-1k')!.xpus).toBe(1024);
    expect(NETWORK_POD_ARCHETYPES.filter((a) => a.basis === 'repository').every((a) => a.verification === 'unverified')).toBe(true);
    for (const n of STD_NODE_SPECS) expect(NODE_SPECS.some((x) => x.id === n.id), n.id).toBe(true);
  });

  it('facility assessment thresholds as data (both revisions)', () => {
    const v1 = facilityAttributes('facility-v1@1.5');
    const hs = facilityAttributes('facility-v2hs@1.15');
    expect(v1.find((a) => a.key === 'cold-aisle-width')).toMatchObject({ optimum: 1500, acceptable: 1200 });
    expect(hs.find((a) => a.key === 'cold-aisle-width')).toMatchObject({ optimum: 1400 });
    expect(v1.find((a) => a.key === 'generator-load-acceptance')).toMatchObject({ compare: 'max', optimum: 60, acceptable: 90 });
    expect(hs.find((a) => a.key === 'generator-load-acceptance')).toMatchObject({ optimum: 20, acceptable: 35 });
    expect(hs.find((a) => a.key === 'clear-height')).toMatchObject({ optimum: 4.5, acceptable: 3.65 });
    expect(facilityAttributes('off')).toEqual([]);
  });
});

describe('vendor classification (§3.4) and legacy ids', () => {
  it('every non-generic builtin item carries standards[]; claims from blogs / press releases are never verified', () => {
    for (const it of CATALOG) {
      if (it.vendor === 'Generic') continue;
      expect(it.standards?.length, it.id).toBeGreaterThan(0);
      for (const s of it.standards!) {
        if (s.evidence?.kind === 'vendor-blog' || s.evidence?.kind === 'press-release') expect(s.verification, `${it.id} ${s.standardId}`).toBe('unverified');
        if (s.level === 'proprietary') expect(s.standardId, it.id).toBe(NO_STANDARD);
      }
    }
    for (const id of Object.keys(VENDOR_CLASSIFICATION)) expect(findCatalogItem(id), id).toBeDefined();
  });

  it('levels per proposal §3.4', () => {
    const lv = (id: string) => get(id).standards!.map((s) => s.level);
    expect(lv('nvidia-gb300-nvl72')).toEqual(['contributed-design', 'proprietary']);
    expect(get('nvidia-gb300-nvl72').formFactor?.rack).toBe('orv3-mgx');
    expect(lv('nvidia-vr-nvl72')).toEqual(['proprietary']);
    expect(lv('hgx-h100-air-4x')).toContain('open-platform-host');
    expect(lv('amd-mi355x-dlc-4x')).toEqual(expect.arrayContaining(['eia', 'open-spec', 'proprietary']));
    expect(get('amd-mi355x-dlc-4x').standards!.find((s) => s.scope === 'module')!.note).toMatch(/above the module power envelope \(1000 W\)/);
    expect(get('amd-mi355x-dlc-4x').compute?.scaleUp).toMatchObject({ kind: 'vendor-proprietary', family: 'Infinity Fabric' });
    expect(get('amd-helios-mi455x').standards![0]).toMatchObject({ standardId: 'orw-base@1.0.0', level: 'open-spec', verification: 'unverified' });
    expect(get('amd-helios-mi455x').formFactor?.rack).toBe('orw');
    expect(lv('rebellions-rebel-quad-4x')).toContain('proprietary');
    expect(get('rebellions-rebel-quad-4x').name).not.toMatch(/OAM/);
    expect(get('rebellions-rebel-quad-4x').compute?.accelerator?.formFactor).toBe('pcie');
    expect(get('vertiv-xdu2300').cdu!.ratingBasis.convention).toBe('loop-reqs-4k');
    expect(get('vertiv-cw375').standards![0].classId).toBe('crah-generic-400');
    expect(get('network-rack-48u').name).toBe('Network Rack (48U frame, 42U for switches)');
    expect(get('network-rack-48u').rackUnits).toBe(42);
    expect(get('network-rack-48u').formFactor).toMatchObject({ heightUnits: 48, usableUnits: 42 });
    // specStatus ignores entries without a registry document
    expect(get('vertiv-xdu2300').specStatus).toBeUndefined();
    expect(weakestStatus([NO_STANDARD])).toBe('roadmap'); // why items carry a precomputed specStatus
  });

  it('classification is additive and idempotent', () => {
    const once = applyStandardsClassification(CATALOG);
    expect(once.map((c) => c.standards?.length)).toEqual(CATALOG.map((c) => c.standards?.length));
  });

  it('renamed rack / connector ids resolve through the alias table; vendor ids keep their own values', () => {
    expect(findCatalogItem('rack-orv3-44ou')?.id).toBe('rack-orv3');
    expect(findCatalogItem('rack-orw-44ou')?.id).toBe('rack-orw');
    expect(findCatalogItem('rack-42u-600x1200')?.id).toBe('rack-eia310-42u');
    expect(findCatalogItem('qd-lqc-dn25')?.id).toBe('qd-lqc-v2');
    expect(findRackModel('rack-48u-600x1200')?.id).toBe('rack-eia310-48u');
    expect(RACK_MODELS.map((r) => r.id)).toEqual(['rack-eia310-42u', 'rack-eia310-48u', 'rack-48u-800x1200', 'rack-orv3', 'rack-orv3-hpr', 'rack-orw']);
    // EIA chassis keep their planning values, so composed seed racks keep their totals
    expect(findRackModel('rack-eia310-48u')).toMatchObject({ weightKg: 170, rackUnits: 48, cost: { capexUSD: 4_500 } });
    expect(get('vertiv-xdu2300').capacity?.coolingKW).toBe(2300);
    expect(get('vertiv-cw375').capacity).toMatchObject({ coolingKW: 375, airflowM3s: 27.14 });
  });
});

describe('intentional catalog value change: XDU2300 datasheet values', () => {
  it('power and mass follow the public datasheet; the change is listed for a one-time notice', () => {
    const x = get('vertiv-xdu2300');
    expect(x.power).toMatchObject({ nameplateKW: 47.8, peakKW: 47.8 });
    expect(x.weightKg).toBe(1793);
    expect(x.source).toBe('vendor-datasheet');
    const ch = CATALOG_DATA_CHANGES.find((c) => c.catalogIds.includes('vertiv-xdu2300'))!;
    expect(ch.fields).toEqual([
      { path: 'power.nameplateKW', before: 32, after: 47.8, unit: 'kW' },
      { path: 'power.peakKW', before: 32, after: 47.8, unit: 'kW' },
      { path: 'weightKg', before: 1569, after: 1793, unit: 'kg' },
    ]);
    expect(ch.sourceUrl).toMatch(/^https:\/\//);
    expect(catalogDataChangesFor(createNvidiaReferenceProject().project).map((c) => c.id)).toContain(ch.id);
    expect(catalogDataChangesFor({ equipment: [], cooling: { ...createNvidiaReferenceProject().project.cooling, cduCatalogId: 'cdu-facility-2mw' } })).toEqual([]);
  });
});
