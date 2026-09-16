/**
 * Radix / fabric sizing math shared by the network engine (engines/network.ts) and the layout generator
 * (layout/estimates.ts, layout/generate.ts) so both agree on leaf / spine / core counts.
 *
 * Per fabric with switch radix k and leaf oversubscription o (= down:up):
 *   leaf downlinks d = floor(k·o/(o+1)), uplinks u = k − d              (mgmt switches: d = k, u = 0)
 *   leaves per pod   = rails · ceil(ports / rails / d)                   (rails > 1: rail-optimized)
 *                    = ceil(ports / d)                                   (rails = 1)
 *   2-tier feasible  ⇔ L ≤ k;  spines S = ceil((L·u + extraSpinePorts) / k)
 *   3-tier fat tree: P = floor(k/2) leaves per network pod, spines = netPods · u, cores = ceil((spines·P + extra) / k)
 *   breakout: endpoint ports faster than the switch port become `breakout` links each (800G NIC → 2 × 400G);
 *             slower endpoints consume `breakout` (< 1) switch ports each.
 *
 * Radix capacity (endpoints reachable at o = 1): 2-tier k²/2, 3-tier k³/4 (Al-Fares et al.), × planes for multi-plane.
 * L2/L3 verdict follows RFC 7938 (BGP in large-scale DCs) and RFC 5549 (unnumbered eBGP).
 */

export interface FabricCounts {
  downPerLeaf: number;
  upPerLeaf: number;
  /** leaves per pod for the uniform case (0 when pods differ) */
  leavesPerPod: number;
  leaves: number;
  spines: number;
  cores: number;
  tiers: 1 | 2 | 3;
  /** false when a forced tier count cannot reach every leaf */
  feasible: boolean;
}

export interface FabricCountOpts {
  /** endpoint ports per pod (before breakout) */
  portsPerPod: number;
  pods: number;
  /** rails per node group (1 = not rail-optimized) */
  rails: number;
  /** switch radix (ports per switch at the switch port speed) */
  k: number;
  oversubscription: number;
  /** switch ports consumed per endpoint port (2 for 800G NIC on 400G switch, 0.5 for 400G NIC on 800G switch). Default 1. */
  breakout?: number;
  /** extra ports required on the spine tier (e.g. OOB aggregation uplinks) */
  extraSpinePorts?: number;
  /** forced tier count; 'auto' picks the minimum that reaches every leaf */
  tiers?: 'auto' | 2 | 3;
  /** management fabric: every port is a downlink, single tier */
  mgmt?: boolean;
}

/** Leaf port split for radix k and oversubscription o. */
export function leafPortSplit(k: number, oversubscription: number, mgmt = false): { downPerLeaf: number; upPerLeaf: number } {
  const os = Math.max(1, oversubscription);
  const d = mgmt ? k : Math.floor((k * os) / (os + 1));
  return { downPerLeaf: d, upPerLeaf: mgmt ? 0 : k - d };
}

/** Leaves needed for `switchPorts` endpoint switch-ports at `downPerLeaf` downlinks, rounded up to whole rail groups. */
export function leavesForPorts(switchPorts: number, downPerLeaf: number, rails = 1): number {
  if (switchPorts <= 0 || downPerLeaf <= 0) return 0;
  const r = rails > 1 ? rails : 1;
  return r > 1 ? r * Math.ceil(switchPorts / r / downPerLeaf - 1e-9) : Math.ceil(switchPorts / downPerLeaf - 1e-9);
}

/** Spine / core counts for L leaves with u uplinks each on radix k. */
export function upperTiers(L: number, upPerLeaf: number, k: number, tiers: 'auto' | 1 | 2 | 3, extraSpinePorts = 0): Pick<FabricCounts, 'spines' | 'cores' | 'tiers' | 'feasible'> {
  let t: 1 | 2 | 3;
  let feasible = true;
  if (tiers === 1 || L <= 1) t = 1;
  else if (tiers === 'auto') t = L <= k ? 2 : 3;
  else {
    t = tiers;
    if (t === 2 && L > k) feasible = false;
  }
  let spines = 0;
  let cores = 0;
  const P = Math.floor(k / 2);
  if (t === 2) spines = Math.ceil((L * upPerLeaf + extraSpinePorts) / k - 1e-9);
  if (t === 3) {
    const netPods = Math.ceil(L / P);
    spines = netPods * upPerLeaf;
    cores = Math.ceil((spines * P + extraSpinePorts) / k - 1e-9);
    if (netPods > k) feasible = false;
  }
  return { spines, cores, tiers: t, feasible };
}

/**
 * General sizing from per-pod switch-port counts (already multiplied by breakout).
 * Used by engines/network.ts where pods carry different endpoint counts.
 */
export function sizeFabricFromPodPorts(o: { switchPortsByPod: readonly number[]; rails: number; k: number; oversubscription: number; extraSpinePorts?: number; tiers?: 'auto' | 2 | 3; mgmt?: boolean }): FabricCounts & { leavesByPod: number[] } {
  const { downPerLeaf, upPerLeaf } = leafPortSplit(o.k, o.oversubscription, o.mgmt);
  const leavesByPod = o.switchPortsByPod.map((ports) => leavesForPorts(ports, downPerLeaf, o.rails));
  const leaves = leavesByPod.reduce((s, v) => s + v, 0);
  const upper = upperTiers(leaves, upPerLeaf, o.k, o.mgmt ? 1 : (o.tiers ?? 'auto'), o.extraSpinePorts ?? 0);
  const uniform = leavesByPod.length > 0 && leavesByPod.every((v) => v === leavesByPod[0]);
  return { downPerLeaf, upPerLeaf, leavesPerPod: uniform ? leavesByPod[0] : 0, leaves, leavesByPod, ...upper };
}

/** Uniform-pod sizing used by the layout generator (podSizing / services-row spine estimate). */
export function sizeFabricFromCounts(o: FabricCountOpts): FabricCounts {
  const breakout = o.breakout ?? 1;
  const perPod = o.portsPerPod * breakout;
  const r = sizeFabricFromPodPorts({
    switchPortsByPod: Array.from({ length: Math.max(0, Math.floor(o.pods)) }, () => perPod),
    rails: o.rails,
    k: o.k,
    oversubscription: o.oversubscription,
    extraSpinePorts: o.extraSpinePorts,
    tiers: o.tiers,
    mgmt: o.mgmt,
  });
  const { leavesByPod: _byPod, ...counts } = r;
  return { ...counts, leavesPerPod: o.pods > 0 ? leavesForPorts(perPod, counts.downPerLeaf, o.rails) : 0 };
}

/** Switch-ports consumed per endpoint port (breakout factor) for an endpoint speed on a switch port speed. */
export function breakoutFactor(endpointGbps: number, switchGbps: number): number {
  if (endpointGbps <= 0 || switchGbps <= 0) return 1;
  if (endpointGbps >= switchGbps) return Math.max(1, Math.round(endpointGbps / switchGbps));
  return endpointGbps / switchGbps;
}

/** Scale-out rails for a scale-up domain size (4 GPUs per NVL72 compute tray; 8 for HGX; 1 when unknown). */
export function railsForDomain(scaleUpDomain: number): number {
  if (scaleUpDomain >= 36) return 4;
  return Math.max(1, scaleUpDomain);
}

/** Maximum non-blocking endpoints for radix k: 2-tier k²/2, 3-tier k³/4, × planes for multi-plane fabrics. */
export function radixCapacity(k: number, tiers: 2 | 3, planes = 1): number {
  const base = tiers === 2 ? (k * k) / 2 : (k * k * k) / 4;
  return Math.floor(base * Math.max(1, planes));
}

export interface L2L3Input {
  endpoints: number;
  /** leaf switches in the fabric */
  switches: number;
  k: number;
  multiTenant?: boolean;
  planes?: number;
}

/**
 * L2 vs L3 recommendation (PROPOSAL-v2 §3.3):
 *   - one leaf (≈ 32–64 nodes) → L2 possible
 *   - more than one leaf → L3: eBGP + ECMP (RFC 7938; unnumbered per RFC 5549); MAC/ARP tables and broadcast domain
 *     become a concern from 2 switches
 *   - endpoints > k²/2 → 3-tier or multi-plane
 *   - multi-tenant → EVPN-VXLAN overlay on the L3 underlay
 */
export function l2l3Verdict(i: L2L3Input): { recommendation: 'l2' | 'l3'; reason: string } {
  const notes: string[] = [];
  let rec: 'l2' | 'l3';
  if (i.switches <= 1) {
    rec = 'l2';
    notes.push(`single leaf (${i.endpoints} endpoints) — a flat L2 domain is sufficient`);
  } else {
    rec = 'l3';
    notes.push(`${i.switches} leaves — route with eBGP + ECMP (RFC 7938; unnumbered links per RFC 5549); MAC/ARP tables and the broadcast domain no longer scale`);
  }
  const cap2 = radixCapacity(i.k, 2, i.planes ?? 1);
  if (i.endpoints > cap2) notes.push(`${i.endpoints} endpoints exceed the 2-tier radix limit k²/2 = ${cap2} — use 3 tiers or ${Math.ceil(i.endpoints / cap2)} planes`);
  if (i.multiTenant) {
    rec = 'l3';
    notes.push('multi-tenant — EVPN-VXLAN overlay on the L3 underlay for tenant isolation');
  }
  return { recommendation: rec, reason: notes.join('; ') };
}
