import { describe, expect, it } from 'vitest';
import {
  CABLE_TYPES,
  CATALOG,
  EXTRA_CABLE_TYPES,
  EXTRA_CATALOG,
  NODE_SPECS,
  RACK_MODELS,
  findCatalogItem,
  findCableType,
  type CatalogItem,
  type SpecSource,
} from '../src/index.ts';

const SOURCES: SpecSource[] = ['open-standard', 'vendor-datasheet', 'public-spec', 'estimate', 'announced', 'user'];
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

describe('catalog seeds (S3)', () => {
  it('every seed item has the required fields and a valid source tag', () => {
    expect(EXTRA_CATALOG.length).toBeGreaterThanOrEqual(40);
    for (const it of EXTRA_CATALOG) {
      const where = it.id;
      expect(it.id, where).toMatch(/^[a-z0-9][a-z0-9_.-]*$/);
      expect(it.category, where).toBeTruthy();
      expect(it.vendor, where).toBeTruthy();
      expect(it.model, where).toBeTruthy();
      expect(it.name, where).toBeTruthy();
      expect(typeof it.description, where).toBe('string');
      expect(isNum(it.dims.w) && it.dims.w > 0, where).toBe(true);
      expect(isNum(it.dims.d) && it.dims.d > 0, where).toBe(true);
      expect(isNum(it.dims.h) && it.dims.h > 0, where).toBe(true);
      expect(isNum(it.weightKg) && it.weightKg >= 0, where).toBe(true);
      expect(it.clearance && isNum(it.clearance.front) && isNum(it.clearance.rear) && isNum(it.clearance.sides), where).toBe(true);
      expect(isNum(it.cost.capexUSD) && isNum(it.cost.installHours) && isNum(it.cost.leadTimeWeeks), where).toBe(true);
      expect(SOURCES, where).toContain(it.source);
      // anything not from a datasheet must say so in notes
      if (it.source === 'estimate' || it.source === 'announced') expect(it.notes ?? '', where).not.toBe('');
      if (it.power) {
        expect(it.power.idleKW, where).toBeLessThanOrEqual(it.power.nameplateKW + 1e-9);
        expect(it.power.typicalKW, where).toBeLessThanOrEqual(it.power.peakKW + 1e-9);
        expect(isNum(it.power.feeds) && isNum(it.power.voltageV), where).toBe(true);
      }
      if (it.cooling) {
        expect(it.cooling.liquidFraction, where).toBeGreaterThanOrEqual(0);
        expect(it.cooling.liquidFraction, where).toBeLessThanOrEqual(1);
        expect(isNum(it.cooling.airflowM3s) && isNum(it.cooling.liquidFlowLpm) && isNum(it.cooling.maxInletC), where).toBe(true);
      }
      if (it.category === 'switch') {
        expect(it.switch, where).toBeDefined();
        expect(it.switch!.ports, where).toBeGreaterThan(0);
        expect(it.switch!.portGbps, where).toBeGreaterThan(0);
        expect(it.switch!.rackUnits, where).toBeGreaterThan(0);
      }
      if (it.category === 'nic') {
        expect(it.nic, where).toBeDefined();
        expect(it.nic!.totalGbps, where).toBeGreaterThan(0);
        expect(it.nic!.wattsMax, where).toBeGreaterThanOrEqual(it.nic!.wattsTypical);
      }
      if (it.category === 'cdu') {
        expect(it.capacity?.coolingKW, where).toBeGreaterThan(0);
        const ratings = (it.meta?.ratings as { coolingKW: number; atdC: number }[] | undefined) ?? [];
        expect(ratings.length, where).toBeGreaterThan(0);
        expect(ratings[0].coolingKW, where).toBe(it.capacity!.coolingKW);
      }
    }
  });

  it('GPU racks carry the v2 accelerator fields (peakTflops, memBandwidthGBps, scaleUp, rails, nodes, gpusPerNode)', () => {
    const gpuRacks = EXTRA_CATALOG.filter((c) => c.category === 'gpu-rack');
    expect(gpuRacks.length).toBeGreaterThanOrEqual(15);
    for (const r of gpuRacks) {
      const c = r.compute!;
      const where = r.id;
      expect(c, where).toBeDefined();
      expect(c.gpus, where).toBeGreaterThan(0);
      expect(c.memBandwidthGBps, where).toBeGreaterThan(0);
      expect(c.peakTflops && Object.keys(c.peakTflops).length, where).toBeTruthy();
      expect(c.scaleUp, where).toBeDefined();
      expect(c.accelerator, where).toBeDefined();
      expect(c.nodesPerRack, where).toBeGreaterThan(0);
      expect(c.gpusPerNode, where).toBeGreaterThan(0);
      expect(c.nodesPerRack! * c.gpusPerNode!, where).toBe(c.gpus);
      expect(r.power, where).toBeDefined();
      expect(r.cooling, where).toBeDefined();
    }
  });

  it('ids are unique across the builtin catalog and the seeds are reachable through the registry', () => {
    const ids = new Set<string>();
    for (const c of CATALOG) {
      expect(ids.has(c.id), c.id).toBe(false);
      ids.add(c.id);
    }
    const cids = new Set<string>();
    for (const c of CABLE_TYPES) {
      expect(cids.has(c.id), c.id).toBe(false);
      cids.add(c.id);
    }
    for (const id of ['hgx-h100-air-4x', 'hgx-h200-air-4x', 'hgx-b300-air-4x', 'nvidia-vr-nvl72', 'nvidia-sn6600', 'nvidia-sn6800', 'amd-mi300x-air-4x', 'amd-mi325x-air-3x', 'amd-mi350x-air-3x', 'amd-mi355x-dlc-4x', 'amd-mi355x-air-2x', 'intel-gaudi3-air-4x', 'cerebras-cs3-2x', 'groq-groqrack', 'sambanova-sn40l-16', 'rebellions-atom-max-8x', 'rebellions-rebel-quad-4x', 'furiosa-rngd-10x', 'hyperaccel-orion-8x', 'hyperaccel-bertha500-8x', 'tenstorrent-galaxy-4x', 'broadcom-th5-64x800', 'broadcom-th6-128x800', 'drivenets-2500s', 'drivenets-5300r', 'drivenets-9300f', 'arista-7060x6-64pe', 'arista-7700r4c-38pe', 'arista-7720r4-128pe', 'cisco-n9364e-sg2', 'dell-z9864f-on', 'juniper-qfx5240-64od', 'nvidia-cx7-400', 'nvidia-cx8-800', 'nvidia-cx9-1600', 'amd-pollara-400', 'broadcom-thor2-400', 'liebert-cwa-fanwall-600', 'vertiv-coolchip-cdu-2300', 'coolit-chx2000', 'motivair-mcdu-70', 'boyd-rol4000']) {
      expect(findCatalogItem(id)?.origin, id).toBe('builtin');
    }
    // legacy ids keep working
    for (const id of ['nvidia-gb300-nvl72', 'hgx-b200-air-4x', 'vertiv-xdu2300', 'nvidia-q3400']) expect(findCatalogItem(id), id).toBeDefined();
    for (const id of ['dac-800', 'aec-800', 'mmf-800-sr8', 'smf-800-dr8', 'cat6a-1g']) expect(findCableType(id), id).toBeDefined();
  });

  it('cable seeds carry medium / wattsPerEnd / price fields consistent with the engine fields', () => {
    expect(EXTRA_CABLE_TYPES.length).toBeGreaterThanOrEqual(6);
    for (const c of EXTRA_CABLE_TYPES) {
      expect(SOURCES, c.id).toContain(c.source);
      expect(c.medium, c.id).toBeDefined();
      expect(c.wattsPerEnd, c.id).toBe(c.transceiverW);
      expect(c.priceFixedUSD, c.id).toBe(c.cableUSD);
      expect(c.pricePerMUSD, c.id).toBe(c.cableUSDPerM);
      expect(c.minReachM, c.id).toBeLessThanOrEqual(c.maxReachM);
    }
    expect(findCableType('acc-800')?.maxReachM).toBe(5);
    expect(findCableType('smf-800-fr8')?.maxReachM).toBe(2000);
    expect(findCableType('smf-800-dr8-ns')?.maxReachM).toBe(100);
  });

  it('specific announced / datasheet numbers', () => {
    const arista = findCatalogItem('arista-7060x6-64pe')!;
    expect(arista.source).toBe('public-spec');
    expect(arista.switch).toMatchObject({ fabric: 'roce-generic-800', ports: 64, portGbps: 800 });
    const vr = findCatalogItem('nvidia-vr-nvl72')!;
    expect(vr.source).toBe('announced');
    expect(vr.power?.nameplateKW).toBe(227);
    expect(vr.compute?.gpus).toBe(72);
    expect(vr.compute?.cpus).toBe(36);
    // T5 MFU basis (catalog/flops.ts): 3.6 EF NVFP4 rack headline is sparse → ÷ 72 ÷ 2 = 25,000 dense TFLOPS per GPU
    expect(vr.compute?.peakTflops?.fp4).toBe(25000);
    expect(vr.compute?.gpuMemoryGB).toBe(288); // 20.7 TB / 72
    expect(vr.compute?.scaleUp.gbpsPerGpu).toBe(28900); // 260 TB/s / 72
    const mi355 = findCatalogItem('amd-mi355x-dlc-4x')!;
    expect(mi355.compute?.gpus).toBe(32);
    expect(mi355.compute?.gpuMemoryGB).toBe(288);
    expect(mi355.compute?.memBandwidthGBps).toBe(8000);
    expect(mi355.compute?.peakTflops?.bf16).toBeCloseTo(2516.6, 1);
    expect(mi355.compute?.scaleUp).toMatchObject({ kind: 'vendor-proprietary', family: 'Infinity Fabric' }); // stream B: legacy key replaced
    expect(mi355.compute?.scaleUp?.gbpsPerGpu).toBe(Math.round(153.6 * 7 * 8));
    expect(mi355.cooling?.maxCoolantSupplyC).toBe(43);
    expect(mi355.cooling?.liquidFraction).toBeGreaterThan(0.8);
    expect(mi355.power?.typicalKW).toBeCloseTo(56, 6); // 4 × 14 kW (AMD design assumption)
    const ncp = findCatalogItem('drivenets-5300r')!;
    expect(ncp.switch?.netPorts).toBe(18);
    expect(ncp.switch?.fabricPorts).toBe(20);
    expect(ncp.weightKg).toBe(21);
    expect(ncp.power?.typicalKW).toBeCloseTo(0.782, 6);
    const ncf = findCatalogItem('drivenets-9300f')!;
    expect(ncf.switch?.ports).toBe(128);
    expect(ncf.switch?.rackUnits).toBe(6);
    expect(ncf.weightKg).toBe(63);
    const gaudi = findCatalogItem('intel-gaudi3-air-4x')!;
    expect(gaudi.compute?.gpus).toBe(32);
    const cdu = findCatalogItem('vertiv-coolchip-cdu-2300')!;
    expect(cdu.weightKg).toBe(1793);
    expect((cdu.meta?.ratings as { atdC: number }[])[0].atdC).toBe(4);
    const tpu = findCatalogItem('google-tpu7x-cloud')!;
    expect(tpu.category).toBe('other');
    expect(tpu.compute?.gpus).toBe(0);
    expect(tpu.meta?.cloudOnly).toBe(true);
  });

  it('node specs and rack models are consistent', () => {
    expect(NODE_SPECS.length).toBeGreaterThanOrEqual(20);
    const ids = new Set<string>();
    for (const n of NODE_SPECS) {
      expect(ids.has(n.id), n.id).toBe(false);
      ids.add(n.id);
      expect(n.rackUnits, n.id).toBeGreaterThan(0);
      expect(n.power.nameplateKW, n.id).toBeGreaterThan(0);
      expect(SOURCES, n.id).toContain(n.source);
      if (n.role === 'gpu') expect(n.gpu, n.id).toBeDefined();
    }
    for (const r of RACK_MODELS) expect(r.rackUnits, r.id).toBeGreaterThan(0);
    const nics = EXTRA_CATALOG.filter((c) => c.category === 'nic').map((c) => c.id);
    for (const n of NODE_SPECS) for (const nic of n.nics) if (nic.catalogId) expect(nics, `${n.id} → ${nic.catalogId}`).toContain(nic.catalogId);
  });

  it('nic items are not floor equipment (tiny footprint, no compute)', () => {
    const nics: CatalogItem[] = EXTRA_CATALOG.filter((c) => c.category === 'nic');
    expect(nics.length).toBe(10); // 5 vendor adapters + 5 NIC form-factor blocks (stream B)
    for (const n of nics) {
      expect(n.compute).toBeUndefined();
      expect(n.dims.h).toBeLessThan(0.1);
    }
  });
});
