import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, getCatalogItem, l2l3Verdict, leafSwitchesFor, podSizing, radixCapacity, sizeFabricFromCounts, REF_POD_TEMPLATE } from '../src/index.ts';

describe('radix.ts (v2 contract)', () => {
  it('reproduces the reference DU sizing (GB300 + Q3400, 4 DUs): 24 leaves/DU, 96 leaves, 48 spines, 2 tiers', () => {
    const r = sizeFabricFromCounts({ portsPerPod: 1728, pods: 4, rails: 4, k: 144, oversubscription: 1 });
    expect(r).toMatchObject({ downPerLeaf: 72, upPerLeaf: 72, leavesPerPod: 24, leaves: 96, spines: 48, cores: 0, tiers: 2, feasible: true });
    const a = analyzeProject(createNvidiaReferenceProject().project);
    const so = a.network.fabrics.find((f) => f.name.startsWith('Scale-out'))!;
    expect(so.tiers.map((t) => t.switches)).toEqual([r.leaves, r.spines]);
  });

  it('generator sizing (podSizing / leafSwitchesFor) agrees with the engine for the reference template', () => {
    const s = podSizing(REF_POD_TEMPLATE);
    expect(s.leaves).toBe(24);
    expect(leafSwitchesFor(1728, getCatalogItem('nvidia-q3400'), 1)).toEqual({ leaves: 24, downPerLeaf: 72, upPerLeaf: 72 });
  });

  it('switches to 3 tiers past the radix and applies breakout', () => {
    const r = sizeFabricFromCounts({ portsPerPod: 1728, pods: 7, rails: 4, k: 144, oversubscription: 1 });
    expect(r.tiers).toBe(3);
    expect(r.leaves).toBe(168);
    expect(r.spines).toBe(3 * 72);
    expect(r.cores).toBe(108);
    // 800G NICs on 400G switches: two links per port
    const b = sizeFabricFromCounts({ portsPerPod: 1728, pods: 1, rails: 4, k: 64, oversubscription: 1, breakout: 2 });
    expect(b.leaves).toBe(4 * Math.ceil((1728 * 2) / 4 / 32));
    const forced = sizeFabricFromCounts({ portsPerPod: 1728, pods: 7, rails: 4, k: 144, oversubscription: 1, tiers: 2 });
    expect(forced.feasible).toBe(false);
  });

  it('radix capacity and L2/L3 verdict', () => {
    expect(radixCapacity(144, 2)).toBe(10368);
    expect(radixCapacity(64, 3)).toBe(65536);
    expect(radixCapacity(64, 2, 4)).toBe(8192);
    expect(l2l3Verdict({ endpoints: 64, switches: 1, k: 64 }).recommendation).toBe('l2');
    const l3 = l2l3Verdict({ endpoints: 6912, switches: 96, k: 144 });
    expect(l3.recommendation).toBe('l3');
    expect(l3.reason).toMatch(/RFC 7938/);
    const big = l2l3Verdict({ endpoints: 20000, switches: 400, k: 144, multiTenant: true });
    expect(big.reason).toMatch(/3 tiers/);
    expect(big.reason).toMatch(/EVPN-VXLAN/);
  });
});
