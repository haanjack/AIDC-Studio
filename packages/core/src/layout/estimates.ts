import { getCatalogItem } from '../catalog/catalog.ts';
import { breakoutFactor, railsForDomain, sizeFabricFromCounts } from '../engines/radix.ts';
import type { CatalogItem } from '../model/types.ts';

/**
 * Quick sizing estimates used by the layout generator to reserve floor positions.
 * The full engines (power / cooling / network) refine these numbers during analysis.
 */

/** Usable switches per network rack, limited by rack units and an air-cooled power envelope. */
export function switchesPerNetworkRack(sw: CatalogItem, rack: CatalogItem = getCatalogItem('network-rack-48u'), maxRackKW = 35): number {
  const ru = sw.switch?.rackUnits ?? 1;
  const byRu = Math.floor((rack.rackUnits ?? 42) / ru);
  const byPower = Math.floor(maxRackKW / Math.max(sw.power?.nameplateKW ?? 1, 0.05));
  return Math.max(1, Math.min(byRu, byPower));
}

/**
 * Leaf switches needed for N endpoint ports with a given downlink:uplink oversubscription.
 * Same math as the network engine (engines/radix.ts): optional `gpuRack` adds rail rounding and breakout so the
 * generator reserves the racks the engine will actually fill (identical to v0.1 for the GB300 + Q3400 reference).
 */
export function leafSwitchesFor(endpoints: number, sw: CatalogItem, oversubscription: number, gpuRack?: CatalogItem): { leaves: number; downPerLeaf: number; upPerLeaf: number } {
  const k = sw.switch?.ports ?? 64;
  const c = gpuRack?.compute;
  const rails = c ? (c.railsPerNode && c.railsPerNode > 0 ? c.railsPerNode : railsForDomain(c.scaleUp.domainSize)) : 1;
  const breakout = c ? breakoutFactor(c.scaleOutPortGbps, sw.switch?.portGbps ?? c.scaleOutPortGbps) : 1;
  const r = sizeFabricFromCounts({ portsPerPod: endpoints, pods: 1, rails, k, oversubscription, breakout });
  return { leaves: r.leaves, downPerLeaf: r.downPerLeaf, upPerLeaf: r.upPerLeaf };
}

/** Spine + core switches for `pods` pods of `endpointsPerPod` endpoint ports (auto tiers; engines/radix.ts). */
export function spineSwitchesFor(endpointsPerPod: number, pods: number, sw: CatalogItem, oversubscription: number, gpuRack?: CatalogItem, joined = false): { spines: number; cores: number; tiers: 1 | 2 | 3; leaves: number } {
  const k = sw.switch?.ports ?? 64;
  const c = gpuRack?.compute;
  const rails = c ? (c.railsPerNode && c.railsPerNode > 0 ? c.railsPerNode : railsForDomain(c.scaleUp.domainSize)) : 1;
  const breakout = c ? breakoutFactor(c.scaleOutPortGbps, sw.switch?.portGbps ?? c.scaleOutPortGbps) : 1;
  let r = sizeFabricFromCounts({ portsPerPod: endpointsPerPod, pods, rails, k, oversubscription, breakout });
  if (joined && r.tiers >= 2) {
    // joined cluster (DECISIONS-v2-2 F2): the hall's top tier keeps one uplink per downlink toward the inter-hall super-spines (1:1),
    // the same reserve engines/network.ts analyzeScope passes as radix extraSpinePorts (2-tier: L·u, 3-tier: spines·⌊k/2⌋)
    const reserve = r.tiers === 3 ? r.spines * Math.floor(k / 2) : r.leaves * r.upPerLeaf;
    r = sizeFabricFromCounts({ portsPerPod: endpointsPerPod, pods, rails, k, oversubscription, breakout, extraSpinePorts: reserve, tiers: r.tiers as 2 | 3 });
  }
  return { spines: r.spines, cores: r.cores, tiers: r.tiers, leaves: r.leaves };
}

/** Air-side heat (kW) a catalog item rejects into the room at nameplate. */
export function airHeatKW(item: CatalogItem): number {
  const p = item.power?.nameplateKW ?? 0;
  const lf = item.cooling?.liquidFraction ?? 0;
  if (item.category === 'cdu') return p * 0.15; // pump motor losses to room
  if (item.category === 'crah') return 0; // fan heat is netted into CRAH capacity
  return p * (1 - lf);
}

export function liquidHeatKW(item: CatalogItem): number {
  const p = item.power?.nameplateKW ?? 0;
  return p * (item.cooling?.liquidFraction ?? 0);
}

/**
 * Block-redundant (DR) UPS: blocks of s = ⌈n/4⌉ modules, K = ⌈n/s⌉ equal active blocks, plus one catcher block of the same size
 * (fix v2 2차, QA: the unit count said 4 × 3 + 3 while the one-line drew two half-N blocks).
 */
export function upsBlocks(n: number): { blockModules: number; activeBlocks: number } {
  const blockModules = Math.max(1, Math.ceil(n / 4));
  return { blockModules, activeBlocks: Math.max(1, Math.ceil(n / blockModules)) };
}

export function redundantCount(n: number, redundancy: string): number {
  if (n <= 0) return 0;
  switch (redundancy) {
    case 'N':
      return n;
    case 'N+1':
      return n + 1;
    case 'N+2':
      return n + 2;
    case '2N':
      return 2 * n;
    case '2N+1':
      return 2 * n + 1;
    case 'DR':
    case 'block-redundant': {
      const b = upsBlocks(n);
      return (b.activeBlocks + 1) * b.blockModules;
    }
    default:
      return n + 1;
  }
}
