import { describe, expect, it } from 'vitest';
import {
  RACK_KW_CAP,
  RACK_MODELS,
  asComposeSwitch,
  composeRack,
  findNodeSpec,
  findRackModel,
  getCatalogItem,
  maxNodesPerRack,
  weakestSource,
  type NodeSpec,
  type UMapEntry,
} from '../src/index.ts';

const mi355 = () => findNodeSpec('amd-mi355x-dlc-node')!;
const head = () => findNodeSpec('node-head-2s')!;

describe('node → rack composer', () => {
  it('derives kW, dims, weight, cooling and compute totals from n × node', () => {
    const node = mi355();
    const rack = findRackModel('rack-48u-600x1200')!;
    const r = composeRack({ node, nodesPerRack: 4, rackModel: rack, id: 'test-mi355x-4x' });
    expect(r.id).toBe('test-mi355x-4x');
    expect(r.category).toBe('gpu-rack');
    expect(r.dims).toEqual(rack.dims);
    expect(r.rackUnits).toBe(48);
    expect(r.power?.nameplateKW).toBeCloseTo(4 * node.power.nameplateKW, 6);
    expect(r.power?.typicalKW).toBeCloseTo(4 * node.power.typicalKW, 6);
    expect(r.power?.idleKW).toBeCloseTo(4 * node.power.idleKW, 6);
    expect(r.power?.peakKW).toBeCloseTo(4 * node.power.peakKW, 6);
    expect(r.weightKg).toBeCloseTo(rack.weightKg + 4 * node.weightKg, 6);
    expect(r.cooling?.liquidFraction).toBeCloseTo(node.cooling.liquidFraction, 4);
    expect(r.cooling?.liquidFlowLpm).toBeCloseTo(4 * node.cooling.liquidFlowLpm, 6);
    expect(r.cooling?.airflowM3s).toBeCloseTo(4 * node.cooling.airflowM3s, 6);
    expect(r.cooling?.maxCoolantSupplyC).toBe(43);
    const c = r.compute!;
    expect(c.gpus).toBe(32);
    expect(c.cpus).toBe(8);
    expect(c.gpusPerNode).toBe(8);
    expect(c.nodesPerRack).toBe(4);
    expect(c.railsPerNode).toBe(8);
    expect(c.scaleOutPortsPerGpu).toBe(1);
    expect(c.scaleOutPortGbps).toBe(400);
    expect(c.frontendPorts).toBe(4 * 2);
    expect(c.storagePorts).toBe(4 * 2);
    expect(c.oobPorts).toBe(4);
    expect(c.scaleUp).toMatchObject({ kind: 'vendor-proprietary', family: 'Infinity Fabric', domainSize: 8 });
    expect(c.memBandwidthGBps).toBe(8000);
    expect(c.peakTflops?.fp8).toBeCloseTo(5033.2, 1);
    expect(r.cost.capexUSD).toBe(rack.cost.capexUSD + 4 * node.cost.capexUSD);
    expect(r.cost.leadTimeWeeks).toBe(Math.max(rack.cost.leadTimeWeeks, node.cost.leadTimeWeeks));
    const umap = r.meta?.umap as UMapEntry[];
    expect(umap.filter((u) => u.kind === 'node').length).toBe(4);
    expect(umap.filter((u) => u.kind === 'node').map((u) => u.u)).toEqual([1, 5, 9, 13]);
    expect(r.meta?.ruUsed).toBe(16);
    expect(r.meta?.kwCap).toBe(RACK_KW_CAP.dlc);
    expect(r.source).toBe(weakestSource(node.source, rack.source));
  });

  it('adds in-rack switches (RU, kW, weight, cost, oob ports, U-map at the top)', () => {
    const node = mi355();
    const tor = getCatalogItem('drivenets-5300r');
    const r = composeRack({ node, nodesPerRack: 4, rackModel: 'rack-42u-600x1200', switches: [asComposeSwitch(tor, 1)], id: 'test-mi355x-tor' });
    expect(r.power?.nameplateKW).toBeCloseTo(4 * node.power.nameplateKW + tor.power!.nameplateKW, 6);
    expect(r.weightKg).toBeCloseTo(findRackModel('rack-42u-600x1200')!.weightKg + 4 * node.weightKg + tor.weightKg, 6);
    expect(r.cost.capexUSD).toBe(findRackModel('rack-42u-600x1200')!.cost.capexUSD + 4 * node.cost.capexUSD + tor.cost.capexUSD);
    expect(r.compute?.oobPorts).toBe(5);
    const umap = r.meta?.umap as UMapEntry[];
    const sw = umap.find((u) => u.kind === 'switch')!;
    // T5 auto-placement: switches centred in the rack ((42 − 2) / 2 + 1)
    expect(sw.u).toBe(21);
    expect(sw.units).toBe(2);
    expect(r.meta?.ruUsed).toBe(18);
    expect(r.source).toBe('estimate'); // rack model is an estimate → weakest
    expect(() => asComposeSwitch(getCatalogItem('nvidia-gb300-nvl72'))).toThrow();
  });

  it('service nodes compose into non-GPU racks with storage totals', () => {
    const st = findNodeSpec('node-storage-nvme-24')!;
    const r = composeRack({ node: st, nodesPerRack: 8, rackModel: 'rack-42u-600x1200' });
    expect(r.category).toBe('storage-rack');
    expect(r.compute?.gpus).toBe(0);
    expect(r.storage?.rawTB).toBeCloseTo(8 * 737, 6);
    expect(r.compute?.storagePorts).toBe(16);
    const h = composeRack({ node: head(), nodesPerRack: 2 });
    expect(h.category).toBe('cpu-rack');
    expect(h.id).toBe('node-head-2s-2x');
  });

  it('rejects rack-unit overflow and notes kW above the cooling cap', () => {
    const node = findNodeSpec('hgx-b300-node')!; // 10U, 14.3 kW air
    expect(() => composeRack({ node, nodesPerRack: 5, rackModel: 'rack-42u-600x1200' })).toThrow(/U required/);
    const fit = maxNodesPerRack(node, findRackModel('rack-48u-600x1200')!, 2);
    expect(fit.byRU).toBe(4);
    expect(fit.byKW).toBe(Math.floor(RACK_KW_CAP.air / node.power.nameplateKW));
    const r = composeRack({ node, nodesPerRack: 4 });
    expect(r.power?.nameplateKW).toBeCloseTo(57.2, 6);
    expect(r.notes).toContain('48U');
    // a hot air rack → note
    const hot: NodeSpec = { ...node, id: 'hot', power: { ...node.power, nameplateKW: 20 } };
    const hr = composeRack({ node: hot, nodesPerRack: 4 });
    expect(hr.notes).toMatch(/exceeds the air cap/);
  });

  it('rack models resolve by id and unknown ids throw', () => {
    expect(RACK_MODELS.map((r) => r.id)).toContain('rack-orw'); // stream B: renamed; the legacy id resolves via findRackModel
    expect(findRackModel('rack-orw-44ou')?.id).toBe('rack-orw');
    expect(() => composeRack({ node: head(), nodesPerRack: 1, rackModel: 'nope' })).toThrow(/Unknown rack model/);
  });
});
