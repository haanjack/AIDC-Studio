// Frozen copy of engines/ipplan.ts before the any-number-of-halls change (IP map review v2 2차) — the dump-compare reference of
// ipmap-halls.test.ts: projects with ≤ 4 halls must keep byte-identical plans. Test helper only; do not edit.
// Deterministic IP / ASN plan (stream T2 data; T7 formats HTML + CSV and feeds NOS templates). DECISIONS-v2 #8, DECISIONS-v2-2 §C,
// docs/research/r2-ops.md §2.4 (all bases `derived`; standards quoted in r2-ops.md §2.1).
//
// Base 10.0.0.0/8 (the first octet is configurable), carved into fixed blocks:
//   10.0.0.0/14   loopbacks /32        offset = hall<<16 | role<<12 | index     (role codes below; 4,096 per role per hall)
//   10.4.0.0/16   cluster loopbacks    role<<12 | index                         (inter-hall super-spines of joined clusters)
//   10.16.0.0/12  OOB                  hall<<18 | oobSwitch<<8 | host (hosts from .10, .1 = OOB leaf SVI)
//   10.40.0.0/14  front-end · 10.44.0.0/14 storage · 10.48.0.0/14 in-band mgmt:  hall<<16 | accessLeaf<<8 | host (from .10, gw .1)
//   10.52.0.0/14  IPoIB (optional, InfiniBand only)
//   10.64.0.0/10  backend host-facing /31 per NIC lane:  hall<<20 | plane<<17 | leaf·leafBlock + 2·slot   (switch even, host odd)
//                 leafBlock = 2^ceil(log2(2 × host lanes per leaf))
//   10.128.0.0/10 backend fabric p2p (only when numbered; default BGP unnumbered, RFC 8950 — IPv6 link-local next hops)
//                 hall<<20 | tier<<19 | net<<16 | upper·upperBlock + 2·(port lane)
//   10.192.0.0/14 inter-hall super-spine trunks /31 (numbered mode)
//   10.200.0.0/13 reserved (services / VIPs / Kubernetes)
// Loopback role codes: 0 backend leaf · 1 backend spine · 2 backend hall-local core / super-spine · 3 FE leaf · 4 FE spine · 5 storage
//   leaf · 6 storage spine · 7 OOB leaf · 8 OOB aggregation · 9 in-band leaf · 10 border · 11 backend-leaf overflow.
// ASNs: 4-byte private (RFC 6996: 4200000000–4294967294), readable decimal 4_200_000_000 + site·10^7 + hall·10^6 + role·10^5 + i;
//   RFC 7938 §5.2.1 shape — every leaf (Tier 3) unique; one shared ASN per spine set (Tier 2, per hall & plane); one ASN for a hall's
//   core tier (Tier 1); inter-hall super-spines share one ASN per cluster (hall digit 0, i = 100 + cluster index).
// InfiniBand fabrics get no IP addresses and no BGP: LID/GUID from the subnet manager, PKeys for isolation (0x7fff default).
import type { IpPlan, Project, ProjectAnalysis } from '../src/model/types.ts';
import { resolveClusters } from '../src/engines/cluster.ts';
import { buildCableSchedule, buildSwitchUnits, type FabricKey, type SwitchUnit } from '../src/engines/links.ts';

export function emptyIpPlan(): IpPlan {
  return { blocks: [], loopbacks: [], asns: [], p2p: [], hosts: [], oob: [] };
}

export interface IpPlanOptions {
  /** first octet of the /8 base (default 10) */
  firstOctet?: number;
  /** number the fabric point-to-point links (/31) instead of BGP unnumbered (default false) */
  numberedFabric?: boolean;
  /** site digit of the ASN (0..8, default 0) */
  site?: number;
  /** polish v2 2차 (QA network m4): backend planes (1..8, default 1). With planes > 1 a scale-out leaf's plane is its rail mod planes
   *  (or its hall leaf index mod planes when leaves carry no rail) and leaf blocks are numbered per (hall, plane) — the same shape
   *  `ipPlanCapacity` checks (2^17 addresses per plane). Default 1 keeps every address unchanged. */
  planes?: number;
}

export const ipToString = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const ip = (o: number, b: number, c = 0, d = 0) => ((o << 24) >>> 0) + (b << 16) + (c << 8) + d;
const pow2 = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(1, x)));

export const ASN_BASE = 4_200_000_000;
export const asnOf = (site: number, hall: number, role: number, i: number) => ASN_BASE + site * 10_000_000 + hall * 1_000_000 + role * 100_000 + i;

/** Backend host-facing /31 (switch side even, host side odd) — r2-ops.md §2.4 formula; exported for the capacity test. */
export function backendP2p(o: { firstOctet?: number; hall: number; plane: number; leaf: number; hostLanesPerLeaf: number; slot: number }): { switchIp: number; hostIp: number; leafBase: number; leafBlock: number; overflow: boolean } {
  const leafBlock = pow2(2 * o.hostLanesPerLeaf);
  const leafBase = ip(o.firstOctet ?? 10, 64) + ((o.hall << 20) | (o.plane << 17)) + o.leaf * leafBlock;
  const overflow = (o.leaf + 1) * leafBlock > 2 ** 17 || o.hall > 3 || o.plane > 7 || 2 * o.slot + 1 >= leafBlock;
  return { switchIp: leafBase + 2 * o.slot, hostIp: leafBase + 2 * o.slot + 1, leafBase, leafBlock, overflow };
}

const ROLE_CODE = (u: SwitchUnit): number => {
  if (u.fabricKey === 'scale-out') return u.role === 'leaf' ? 0 : u.role === 'spine' ? 1 : 2;
  if (u.fabricKey === 'frontend') return u.role === 'leaf' ? 3 : 4;
  if (u.fabricKey === 'storage') return u.role === 'leaf' ? 5 : 6;
  return u.role === 'leaf' ? 7 : 8;
};
const NET_BITS: Record<FabricKey, number> = { 'scale-out': 0, frontend: 5, storage: 6, oob: 7 };

/** `H1.DU01-A-07-U33:P12/2` → { device: 'H1.DU01-A-07-U33', port: 12, lane: 2 } */
function parsePort(p: string): { device: string; port?: number; lane?: number; tail: string } {
  const i = p.lastIndexOf(':');
  const device = i >= 0 ? p.slice(0, i) : p;
  const tail = i >= 0 ? p.slice(i + 1) : '';
  const m = /^P(\d+)(?:\/(\d+))?$/.exec(tail);
  return { device, tail, ...(m ? { port: Number(m[1]), lane: m[2] ? Number(m[2]) : 1 } : {}) };
}

/** One allocated subnet of the plan (input of the IP map, engines/ipmap.ts). Ranges are unsigned 32-bit address numbers. */
export interface IpSubnetRecord {
  key: string;
  /** plan block name (`IpPlan.blocks[].name`) */
  block: string;
  label: string;
  start: number;
  /** addresses in the subnet (power of two) */
  size: number;
  /** addresses assigned (hosts, /31 halves, gateways / SVIs, loopbacks) */
  used: number;
  /** device / node / NIC / IP strings for lookup */
  members: string[];
  /** hall index (bit field) and id; absent = site-wide */
  hall?: number;
  hallId?: string;
  /** fabric / role prefix inside the hall (exact range) */
  group?: string;
  groupStart?: number;
  groupSize?: number;
  podId?: string;
  rackTag?: string;
  deviceId?: string;
}

export interface IpPlanDetailed {
  plan: IpPlan;
  subnets: IpSubnetRecord[];
}

/** Bit position of the hall field inside each hall-scoped block (hall prefix size = 2^shift). */
export const IP_HALL_SHIFT: Record<string, number> = { loopback: 16, oob: 18, frontend: 16, storage: 16, inband: 16, 'backend-host': 20, 'backend-fabric-p2p': 20 };

export const LOOPBACK_ROLE_NAMES = ['backend leaf', 'backend spine', 'backend core', 'FE leaf', 'FE spine', 'storage leaf', 'storage spine', 'OOB leaf', 'OOB aggregation', 'in-band leaf', 'border', 'backend leaf (overflow)'];

export function buildIpPlan(project: Project, analysis: ProjectAnalysis, opts: IpPlanOptions = {}): IpPlan {
  return buildIpPlanDetailed(project, analysis, opts).plan;
}

/** `buildIpPlan` plus the allocated subnet records (same addresses). */
export function buildIpPlanDetailed(project: Project, analysis: ProjectAnalysis, opts: IpPlanOptions = {}): IpPlanDetailed {
  const O = opts.firstOctet ?? 10;
  const subnets = new Map<string, IpSubnetRecord>();
  const memberSets = new Map<string, Set<string>>();
  const subnet = (key: string, init: () => Omit<IpSubnetRecord, 'key' | 'used' | 'members'>, initialUsed = 0): IpSubnetRecord => {
    let s = subnets.get(key);
    if (!s) {
      s = { key, ...init(), used: initialUsed, members: [] };
      subnets.set(key, s);
      memberSets.set(key, new Set());
    }
    return s;
  };
  const use = (s: IpSubnetRecord, n: number, ...members: (string | undefined)[]) => {
    s.used += n;
    const set = memberSets.get(s.key)!;
    for (const m of members) if (m) set.add(m);
  };
  const site = Math.max(0, Math.min(8, opts.site ?? 0));
  const numbered = !!opts.numberedFabric;
  const notes: string[] = [];
  const plan = emptyIpPlan();
  const isIb = project.network.scaleOut.fabric.startsWith('ib-');
  const isDdc = project.network.scaleOut.fabric === 'drivenets-fse';
  const hallIdx = new Map(project.halls.map((h, i) => [h.id, i]));
  if (project.halls.length > 4) notes.push(`${project.halls.length} halls: the plan reserves 2 bits for the hall (4 halls) — halls beyond H4 overlap; re-base per hall or widen the layout.`);

  plan.blocks = [
    { name: 'loopback', cidr: `${O}.0.0.0/14`, purpose: 'IPv4 loopbacks /32 (router-id): hall · role · index' },
    { name: 'cluster-loopback', cidr: `${O}.4.0.0/16`, purpose: 'Cluster-level loopbacks (inter-hall super-spines, border, DCI)' },
    { name: 'oob', cidr: `${O}.16.0.0/12`, purpose: 'OOB: BMC, PDU, switch mgmt0, facility controllers — /24 per OOB switch, .1 SVI, hosts from .10 (VLAN 10)' },
    { name: 'frontend', cidr: `${O}.40.0.0/14`, purpose: 'Front-end (north–south) — /24 per access leaf, gw .1 (VLAN 30)' },
    { name: 'storage', cidr: `${O}.44.0.0/14`, purpose: 'Storage fabric — /24 per access leaf, gw .1 (VLAN 40/41)' },
    { name: 'inband', cidr: `${O}.48.0.0/14`, purpose: 'In-band management / provisioning (PXE, OS) — /24 per front-end leaf (VLAN 20)' },
    ...(isIb ? [{ name: 'ipoib', cidr: `${O}.52.0.0/14`, purpose: 'IPoIB (optional; one /18 per PKey) — the InfiniBand fabric itself uses LID/GUID, not IP' }] : []),
    ...(!isIb ? [{ name: 'backend-host', cidr: `${O}.64.0.0/10`, purpose: 'Backend host-facing /31 per NIC lane (switch even, host odd) — hall · plane · leaf block' }] : []),
    ...(!isIb ? [{ name: 'backend-fabric-p2p', cidr: `${O}.128.0.0/10`, purpose: numbered ? 'Fabric point-to-point /31 (numbered mode)' : 'Reserved — fabric links are BGP unnumbered (RFC 8950, IPv6 link-local next hops)' }] : []),
    // QA halls-ipmap v2 2차: the IB scale-out has no IP, but numbered mode still numbers the Ethernet front-end / storage / OOB fabric links
    // from 10.128.0.0/10 (loop below) — declare the block so those /31s sit inside a plan block (the IP map no longer lists them as overflow)
    ...(isIb && numbered ? [{ name: 'backend-fabric-p2p', cidr: `${O}.128.0.0/10`, purpose: 'Fabric point-to-point /31 (numbered mode) — Ethernet front-end / storage / OOB fabrics; the InfiniBand scale-out has no IP' }] : []),
    { name: 'inter-hall', cidr: `${O}.192.0.0/14`, purpose: 'Inter-hall super-spine trunks /31 (numbered mode)' },
    { name: 'reserved', cidr: `${O}.200.0.0/13`, purpose: 'Reserved: services, VIPs, Kubernetes pod/service CIDRs' },
  ];
  if (isIb) notes.push('InfiniBand scale-out: no IP addresses or BGP on the fabric — the subnet manager (UFM / OpenSM) assigns LIDs; isolate tenants with PKeys (default partition 0x7fff; tenants from 0x0010, storage 0x0020, management 0x0030). IB switches are addressed on the OOB network only.');
  if (isDdc) notes.push('DriveNets FSE: NCPs and NCFs form one distributed router (DNOS cluster) — the per-box ASNs and loopbacks below are placeholders for the cluster controller design.');

  const units = buildSwitchUnits(project, analysis);
  const rows = buildCableSchedule(project, analysis);
  const unitByDevice = new Map(units.map((u) => [`H${(hallIdx.get(u.hallId) ?? 0) + 1}.${u.rackTag}-U${u.u}`, u]));
  const clusters = resolveClusters(project);
  const clusterIdx = new Map(clusters.map((c, i) => [c.id, i]));

  // ── loopbacks + ASNs (Ethernet / L3 switches; IB scale-out switches are skipped) ──
  const roleIdx = new Map<string, number>();
  const unitIdx = new Map<string, number>();
  let loOverflow = 0;
  const leafAsnIdx = new Map<string, number>();
  for (const u of units) {
    if (u.fabricKey === 'scale-out' && isIb) continue;
    const h = hallIdx.get(u.hallId) ?? 0;
    let role = ROLE_CODE(u);
    if (u.interHall) {
      const k = `cluster|${role}`;
      const i = roleIdx.get(k) ?? 0;
      roleIdx.set(k, i + 1);
      unitIdx.set(u.id, i);
      plan.loopbacks.push({ deviceId: u.id, ip: ipToString(ip(O, 4) + ((2 << 12) | i)) });
      use(subnet('clo|2', () => ({ block: 'cluster-loopback', label: 'inter-hall super-spine', start: ip(O, 4) + (2 << 12), size: 4096 })), 1, u.id, u.rackTag, ipToString(ip(O, 4) + ((2 << 12) | i)));
      plan.asns.push({ deviceId: u.id, asn: asnOf(site, 0, 1, 100 + (clusterIdx.get(u.clusterId ?? '') ?? 0)) });
      continue;
    }
    const k = `${h}|${role}`;
    let i = roleIdx.get(k) ?? 0;
    roleIdx.set(k, i + 1);
    unitIdx.set(u.id, i);
    if (i >= 4096 && role === 0) {
      role = 11;
      i -= 4096;
    }
    if (i >= 4096) loOverflow++;
    plan.loopbacks.push({ deviceId: u.id, ip: ipToString(ip(O, 0) + ((h << 16) | (role << 12) | (i & 0xfff))) });
    {
      const r = role;
      use(subnet(`lo|${h}|${r}`, () => ({ block: 'loopback', label: LOOPBACK_ROLE_NAMES[r] ?? `role ${r}`, start: ip(O, 0) + ((h << 16) | (r << 12)), size: 4096, hall: h, hallId: u.hallId })), 1, u.id, u.rackTag, ipToString(ip(O, 0) + ((h << 16) | (r << 12) | (i & 0xfff))));
    }
    let asn: number;
    if (u.fabricKey === 'scale-out') {
      if (u.role === 'leaf') {
        const li = leafAsnIdx.get(`${h}`) ?? 0;
        leafAsnIdx.set(`${h}`, li + 1);
        asn = asnOf(site, h, 3, li);
        if (li >= 10_000) loOverflow++;
      } else asn = u.role === 'spine' ? asnOf(site, h, 2, 0) : asnOf(site, h, 1, 0);
    } else if (u.fabricKey === 'frontend') asn = u.role === 'leaf' ? asnOf(site, h, 4, unitIdx.get(u.id)!) : asnOf(site, h, 5, 0);
    else if (u.fabricKey === 'storage') asn = u.role === 'leaf' ? asnOf(site, h, 6, unitIdx.get(u.id)!) : asnOf(site, h, 7, 0);
    else asn = asnOf(site, h, 8, unitIdx.get(u.id)!);
    plan.asns.push({ deviceId: u.id, asn });
  }
  if (loOverflow) notes.push(`${loOverflow} devices exceed the 4,096-per-role loopback index or 10,000-per-hall leaf ASN range — widen the layout.`);
  if (project.halls.length > 9) notes.push('More than 9 halls do not fit the one-digit hall field of the ASN plan.');

  // ── hosts: backend /31 per NIC lane (Ethernet), FE / storage / in-band /24 per access leaf; OOB ──
  const laneMax = new Map<string, number>();
  for (const r of rows) {
    if (r.tier !== 'endpoint-leaf') continue;
    const p = parsePort(r.toPort);
    if (p.lane) laneMax.set(p.device, Math.max(laneMax.get(p.device) ?? 1, p.lane));
  }
  // fix v2 2차 (QA M3): one host block size per hall (max downlinks × lanes over the hall's backend leaves) — a per-device block let
  // leaves with different lane counts overlap
  const hostLanesByHall = new Map<number, number>();
  for (const u of units) {
    if (u.fabricKey !== 'scale-out' || u.role !== 'leaf' || u.interHall) continue;
    const h = hallIdx.get(u.hallId) ?? 0;
    hostLanesByHall.set(h, Math.max(hostLanesByHall.get(h) ?? 1, u.downlinks * (laneMax.get(`H${h + 1}.${u.rackTag}-U${u.u}`) ?? 1)));
  }
  const accessHost = new Map<string, number>();
  const inbandHost = new Map<string, number>();
  const oobSw = new Map<string, number>();
  const oobSwPerHall = new Map<number, number>();
  const oobHost = new Map<string, number>();
  const inbandDone = new Set<string>();
  let backendOverflow = 0;
  let accessOverflow = 0;
  const planes = Math.max(1, Math.min(8, Math.floor(opts.planes ?? 1)));
  const planeOf = new Map<string, { plane: number; leaf: number }>();
  if (planes > 1) {
    const perPlane = new Map<string, number>();
    for (const u of units) {
      if (u.fabricKey !== 'scale-out' || u.role !== 'leaf' || u.interHall) continue;
      const h = hallIdx.get(u.hallId) ?? 0;
      const plane = (u.rail ?? unitIdx.get(u.id) ?? 0) % planes;
      const k = `${h}|${plane}`;
      const leaf = perPlane.get(k) ?? 0;
      perPlane.set(k, leaf + 1);
      planeOf.set(u.id, { plane, leaf });
    }
  }
  for (const r of rows) {
    if (r.tier !== 'endpoint-leaf') continue;
    const sw = parsePort(r.toPort);
    const unit = unitByDevice.get(sw.device);
    if (!unit) continue;
    const h = hallIdx.get(unit.hallId) ?? 0;
    const fromI = r.fromPort.lastIndexOf(':');
    const nodeId = fromI >= 0 ? r.fromPort.slice(0, fromI) : r.fromPort;
    const nic = fromI >= 0 ? r.fromPort.slice(fromI + 1) : '';
    const key = unit.fabricKey as FabricKey;
    if (key === 'scale-out') {
      if (isIb) continue;
      const lanes = laneMax.get(sw.device) ?? 1;
      const slot = ((sw.port ?? 1) - 1) * lanes + ((sw.lane ?? 1) - 1);
      const pl = planeOf.get(unit.id);
      const a = backendP2p({ firstOctet: O, hall: h, plane: pl?.plane ?? 0, leaf: pl?.leaf ?? unitIdx.get(unit.id) ?? 0, hostLanesPerLeaf: hostLanesByHall.get(h) ?? unit.downlinks * lanes, slot });
      if (a.overflow) backendOverflow++;
      plan.hosts.push({ nodeId, nic, ip: `${ipToString(a.hostIp)}/31`, gw: ipToString(a.switchIp) });
      const plane = pl?.plane ?? 0;
      use(subnet(`be|${a.leafBase}`, () => ({
        block: 'backend-host', label: sw.device, start: a.leafBase, size: a.leafBlock, hall: h, hallId: unit.hallId, group: `plane ${plane}`,
        groupStart: ip(O, 64) + ((h << 20) | (plane << 17)), groupSize: 2 ** 17, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id,
      })), 2, sw.device, nodeId, `${nodeId}:${nic}`, ipToString(a.hostIp));
    } else if (key === 'frontend' || key === 'storage') {
      const leaf = unitIdx.get(unit.id) ?? 0;
      const n = accessHost.get(unit.id) ?? 0;
      accessHost.set(unit.id, n + 1);
      const host = 10 + n;
      if (host > 254 || leaf > 255) accessOverflow++;
      const base = ip(O, key === 'frontend' ? 40 : 44) + ((h << 16) | (leaf << 8));
      plan.hosts.push({ nodeId, nic, ip: `${ipToString(base + (host & 255))}/24`, vlan: key === 'frontend' ? 30 : 40, gw: ipToString(base + 1) });
      use(subnet(`${key}|${base}`, () => ({ block: key, label: sw.device, start: base, size: 256, hall: h, hallId: unit.hallId, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id }), 1), 1, sw.device, nodeId, `${nodeId}:${nic}`, ipToString(base + (host & 255)));
      if (key === 'frontend' && !inbandDone.has(nodeId)) {
        inbandDone.add(nodeId);
        const m = inbandHost.get(unit.id) ?? 0;
        inbandHost.set(unit.id, m + 1);
        const ib = ip(O, 48) + ((h << 16) | (leaf << 8));
        if (10 + m > 254) accessOverflow++;
        plan.hosts.push({ nodeId, nic: 'mgmt', ip: `${ipToString(ib + ((10 + m) & 255))}/24`, vlan: 20, gw: ipToString(ib + 1) });
        use(subnet(`inband|${ib}`, () => ({ block: 'inband', label: sw.device, start: ib, size: 256, hall: h, hallId: unit.hallId, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id }), 1), 1, sw.device, nodeId, `${nodeId}:mgmt`, ipToString(ib + ((10 + m) & 255)));
      }
    } else {
      let s = oobSw.get(unit.id);
      if (s === undefined) {
        s = oobSwPerHall.get(h) ?? 0;
        oobSwPerHall.set(h, s + 1);
        oobSw.set(unit.id, s);
      }
      const n = oobHost.get(unit.id) ?? 0;
      oobHost.set(unit.id, n + 1);
      if (10 + n > 254 || s >= 1024) accessOverflow++;
      plan.oob.push({ deviceId: r.fromPort, ip: `${ipToString(ip(O, 16) + ((h << 18) | (s << 8) | ((10 + n) & 255)))}/24` });
      {
        const start = ip(O, 16) + ((h << 18) | (s << 8));
        use(subnet(`oob|${start}`, () => ({ block: 'oob', label: sw.device, start, size: 256, hall: h, hallId: unit.hallId, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id }), 1), 1, sw.device, r.fromPort, ipToString(start + ((10 + n) & 255)));
      }
    }
  }
  if (backendOverflow) notes.push(`${backendOverflow} backend host addresses fall outside their leaf block (more than 2^17 addresses per plane, or more than 4 halls).`);
  if (accessOverflow) notes.push(`${accessOverflow} front-end / storage / in-band / OOB hosts exceed a /24 per access switch (244 hosts from .10) — split the access switches' subnets.`);

  // ── fabric point-to-point links ──
  // lanes per upper-side switch (breakout ports P12/1 … P12/4) — one consistent slot map per device
  const upperLanes = new Map<string, number>();
  for (const r of rows) {
    if (r.tier === 'endpoint-leaf') continue;
    const pp = parsePort(r.toPort);
    if (pp.lane) upperLanes.set(pp.device, Math.max(upperLanes.get(pp.device) ?? 1, pp.lane));
  }
  // fix v2 2차 (QA M3): one /31 block size per (hall, tier, network) — max ports × lanes over the set's upper devices
  const blockBySet = new Map<string, number>();
  const setKey = (tier: string | undefined, upper: SwitchUnit) => `${hallIdx.get(upper.hallId) ?? 0}|${tier === 'spine-core' ? 1 : 0}|${upper.fabricKey}`;
  for (const r of rows) {
    if (r.tier === 'endpoint-leaf' || r.tier === 'inter-hall') continue;
    const upperP = parsePort(r.toPort);
    const upper = unitByDevice.get(upperP.device);
    if (!upper) continue;
    const k = setKey(r.tier, upper);
    blockBySet.set(k, Math.max(blockBySet.get(k) ?? 1, pow2(2 * upper.ports * (upperLanes.get(upperP.device) ?? 1))));
  }
  let trunkSeq = 0;
  let p2pOverflow = 0;
  for (const r of rows) {
    if (r.tier === 'endpoint-leaf') continue;
    if (r.fabricKey === 'scale-out' && isIb) continue;
    const upperP = parsePort(r.toPort);
    const upper = unitByDevice.get(upperP.device);
    let cidr: string | undefined;
    if (numbered && upper) {
      const h = hallIdx.get(upper.hallId) ?? 0;
      if (r.tier === 'inter-hall') {
        cidr = `${ipToString(ip(O, 192) + 2 * trunkSeq++)}/31`;
        const ih = subnet('ih', () => ({ block: 'inter-hall', label: 'super-spine trunks', start: ip(O, 192), size: 2 }));
        ih.size = pow2(2 * trunkSeq);
        use(ih, 2, r.cableId, r.fromPort, r.toPort);
      } else {
        const tierBit = r.tier === 'spine-core' ? 1 : 0;
        const lanes = upperLanes.get(upperP.device) ?? 1;
        const block = blockBySet.get(setKey(r.tier, upper)) ?? pow2(2 * upper.ports * lanes);
        const slot = ((upperP.port ?? 1) - 1) * lanes + ((upperP.lane ?? 1) - 1);
        const idx = unitIdx.get(upper.id) ?? 0;
        if (idx * block + 2 * slot >= 2 ** 16) p2pOverflow++;
        cidr = `${ipToString(ip(O, 128) + ((h << 20) | (tierBit << 19) | (NET_BITS[upper.fabricKey] << 16)) + idx * block + 2 * slot)}/31`;
        const gStart = ip(O, 128) + ((h << 20) | (tierBit << 19) | (NET_BITS[upper.fabricKey] << 16));
        use(subnet(`p2p|${gStart}|${idx}`, () => ({
          block: 'backend-fabric-p2p', label: upperP.device, start: gStart + idx * block, size: block, hall: h, hallId: upper.hallId,
          group: `${tierBit ? 'spine–core' : 'leaf–spine'} · ${upper.fabricKey}`, groupStart: gStart, groupSize: 2 ** 16, podId: upper.podId, rackTag: upper.rackTag, deviceId: upper.id,
        })), 2, upperP.device, r.cableId, r.fromPort, r.toPort);
      }
    }
    plan.p2p.push({ linkId: r.cableId, a: r.fromPort, b: r.toPort, ...(cidr ? { cidr } : {}), unnumbered: !numbered });
  }
  if (p2pOverflow) notes.push(`${p2pOverflow} numbered fabric links exceed the /16 per (hall, tier, network) — use unnumbered BGP.`);
  if (!numbered && !isIb) notes.push('Fabric links use BGP unnumbered (RFC 8950 IPv4 NLRI over IPv6 link-local next hops; FRR `neighbor <if> interface`); the numbered /31 block stays reserved.');
  plan.notes = notes;
  return { plan, subnets: [...subnets.values()].map((s) => ({ ...s, members: [...memberSets.get(s.key)!] })) };
}

export interface IpCapacityCheck {
  item: string;
  need: number;
  capacity: number;
  ok: boolean;
}

/**
 * Capacity of the fixed layout for a site (r2-ops.md §2.4 capacity table): backend host lanes per plane, leaves per hall, access /24s
 * and ASN digits. Pure arithmetic — used by the tests for 4 halls × 20,000 GPUs.
 */
export function ipPlanCapacity(o: { halls: number; gpusPerHall: number; lanesPerGpu: number; leafHostLanes: number; planes: number; accessLeavesPerHall: number; oobSwitchesPerHall: number }): IpCapacityCheck[] {
  const leavesPerPlane = Math.ceil((o.gpusPerHall * o.lanesPerGpu) / o.leafHostLanes);
  const block = pow2(2 * o.leafHostLanes);
  const checks: IpCapacityCheck[] = [
    { item: 'halls (2 bits)', need: o.halls, capacity: 4, ok: o.halls <= 4 },
    { item: 'planes (3 bits)', need: o.planes, capacity: 8, ok: o.planes <= 8 },
    { item: 'backend host /31 per plane (2^17 addresses)', need: leavesPerPlane * block, capacity: 2 ** 17, ok: leavesPerPlane * block <= 2 ** 17 },
    { item: 'backend leaf loopbacks per hall (4,096 + overflow role)', need: leavesPerPlane * o.planes, capacity: 8192, ok: leavesPerPlane * o.planes <= 8192 },
    { item: 'backend leaf ASNs per hall (plane·10,000 + leaf)', need: leavesPerPlane, capacity: 10_000, ok: leavesPerPlane < 10_000 },
    { item: 'access /24 per hall (8 bits)', need: o.accessLeavesPerHall, capacity: 256, ok: o.accessLeavesPerHall <= 256 },
    { item: 'OOB /24 per hall (10 bits)', need: o.oobSwitchesPerHall, capacity: 1024, ok: o.oobSwitchesPerHall <= 1024 },
  ];
  return checks;
}
