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
//
// Any number of halls (IP map review v2 2차, docs/research/ipmap-review-v2-2.md): up to 4 halls use the fixed layout above (addresses
// unchanged). With 5+ halls every hall-scoped block keeps its CIDR and splits into 2^ceil(log2 halls) equal hall prefixes; the fixed
// fields (loopback role 4 bits, fabric tier 1 bit, backend plane ceil(log2 planes) bits, host byte of a /24) keep their width, the
// numbered-fabric network field packs the four fabrics into 2 bits (codes 0–3; the fixed layout keeps its 3-bit codes 0 / 5 / 6 / 7),
// and the variable index field (loopback index, access / OOB /24 count, backend addresses per plane, numbered /31 set) gets the
// rest — `ipHallLayout`. So 5–8 halls keep the /16 per numbered (tier, network) set of the fixed layout (QA ipmap review v2 2차). ASNs: with more than 10 halls the hall field widens to d = ceil(log10 halls) decimal digits and the per-role
// index shrinks to 6 − d digits (still inside the RFC 6996 4-byte private range).
import { ipNumberTag, ipPlanStrings } from './ipplanStrings.ts';
import type { CableScheduleRow, IpPlan, Locale, Project, ProjectAnalysis } from '../model/types.ts';
import { resolveClusters } from './cluster.ts';
import { buildCableSchedule, buildSwitchUnits, type FabricKey, type SwitchUnit } from './links.ts';

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
  /** override the project's address-family mode (default: project setting, else dual-stack) */
  includeIpv6?: boolean;
  /** override the project's IPv6 /48 (invalid values fall back to the stable project ULA) */
  ipv6Prefix?: string;
  /** backlog T3 (3): language of block purposes, notes and subnet labels (default 'en'); addresses are identical */
  locale?: Locale;
}

/** Canonicalise an IPv6 /48. IPv4-embedded and zone-index forms are intentionally not accepted as site prefixes. */
export function normalizeIpv6Prefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [address, prefixText, ...rest] = value.trim().toLowerCase().split('/');
  if (rest.length || prefixText !== '48' || !address || address.includes('%') || address.includes('.')) return undefined;
  if ((address.match(/::/g) ?? []).length > 1) return undefined;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  const valid = (x: string) => /^[0-9a-f]{1,4}$/.test(x);
  if (![...left, ...right].every(valid)) return undefined;
  const fill = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const words = [...left, ...fill, ...right].map((x) => Number.parseInt(x, 16));
  if (words.length !== 8 || words.some((x) => !Number.isFinite(x))) return undefined;
  return `${words.slice(0, 3).map((x) => x.toString(16)).join(':')}::/48`;
}

/** Stable RFC-4193-shaped ULA /48 for a project. It is a planning default, not a replacement for an organisation-assigned prefix. */
export function projectUlaPrefix(projectId: string): string {
  const hash = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < projectId.length; i++) {
      h ^= projectId.charCodeAt(i);
      h = Math.imul(h, 16_777_619) >>> 0;
    }
    return h;
  };
  const a = hash(2_166_136_261);
  const b = hash(2_166_136_261 ^ 0x9e3779b9);
  const octet = (n: number) => n.toString(16).padStart(2, '0');
  const bytes = [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b >>> 24];
  return `fd${octet(bytes[0])}:${octet(bytes[1])}${octet(bytes[2])}:${octet(bytes[3])}${octet(bytes[4])}::/48`;
}

export interface ResolvedIpPlanSettings {
  firstOctet: number;
  numberedFabric: boolean;
  planes: number;
  includeIpv6: boolean;
  ipv6Prefix: string;
  invalidIpv6Prefix?: string;
}

/** One resolver is shared by the generator, UI and deploy output so previews and exported documents cannot drift. */
export function resolveIpPlanSettings(project: Project, opts: IpPlanOptions = {}): ResolvedIpPlanSettings {
  const a = project.network.addressing;
  const requested = opts.ipv6Prefix ?? a?.ipv6Prefix;
  const canonical = normalizeIpv6Prefix(requested);
  return {
    firstOctet: Math.max(1, Math.min(223, Math.floor(opts.firstOctet ?? a?.ipv4FirstOctet ?? 10))),
    numberedFabric: opts.numberedFabric ?? (a?.fabricLinks === 'numbered'),
    planes: Math.max(1, Math.min(8, Math.floor(opts.planes ?? a?.planes ?? 1))),
    includeIpv6: opts.includeIpv6 ?? (a?.mode !== 'ipv4'),
    ipv6Prefix: canonical ?? projectUlaPrefix(project.id),
    ...(requested && !canonical ? { invalidIpv6Prefix: requested } : {}),
  };
}

export const ipToString = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const ip = (o: number, b: number, c = 0, d = 0) => ((o << 24) >>> 0) + (b << 16) + (c << 8) + d;
const pow2 = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(1, x)));

export const ASN_BASE = 4_200_000_000;
/** Readable 4-byte private ASN: base + site·10^7 + hall·10^(7−d) + role·10^(6−d) + i, d = hall digits (1 = the original scheme). */
export const asnOf = (site: number, hall: number, role: number, i: number, hallDigits = 1) =>
  ASN_BASE + site * 10_000_000 + hall * 10 ** (7 - hallDigits) + role * 10 ** (6 - hallDigits) + i;

/** CIDR size in bits of each hall-scoped plan block (10.0.0.0/14 → 18 bits, …). */
export const IP_BLOCK_BITS: Record<string, number> = { loopback: 18, oob: 20, frontend: 18, storage: 18, inband: 18, 'backend-host': 22, 'backend-fabric-p2p': 22 };

/** Field widths of the hall-scoped blocks for a hall count (see the header comment). */
export interface IpHallLayout {
  halls: number;
  /** false = the fixed 4-hall layout (≤ 4 halls, original addresses) */
  scaled: boolean;
  /** bits of the hall field (2 for the fixed layout) */
  hallBits: number;
  /** hall prefix bits per hall-scoped block: one hall owns 2^shift addresses of the block */
  shift: Record<string, number>;
  /** loopback index bits per (hall, role) */
  loIndexBits: number;
  /** /24 count bits per hall: OOB switches, access (front-end / storage / in-band) leaves */
  oobSwitchBits: number;
  accessLeafBits: number;
  /** backend-host plane field: plane · 2^planeShift, planeBits wide */
  planeBits: number;
  planeShift: number;
  /** numbered fabric: one (tier, network) set owns 2^p2pSetShift addresses (tier bit at p2pSetShift + p2pNetBits, network field at p2pSetShift) */
  p2pSetShift: number;
  /** width of the numbered-fabric network field: 3 in the fixed layout (codes 0 / 5 / 6 / 7), 2 when scaled (codes 0–3) */
  p2pNetBits: number;
  /** decimal digits of the ASN hall field */
  asnHallDigits: number;
}

export function ipHallLayout(halls: number, planes = 1): IpHallLayout {
  const n = Math.max(1, Math.floor(halls));
  const asnHallDigits = Math.max(1, Math.ceil(Math.log10(n)));
  if (n <= 4) {
    return {
      halls: n, scaled: false, hallBits: 2, shift: { ...IP_HALL_SHIFT }, loIndexBits: 12, oobSwitchBits: 10, accessLeafBits: 8, planeBits: 3, planeShift: 17, p2pSetShift: 16, p2pNetBits: 3, asnHallDigits,
    };
  }
  const hallBits = Math.ceil(Math.log2(n));
  const shift = Object.fromEntries(Object.entries(IP_BLOCK_BITS).map(([k, b]) => [k, Math.max(0, b - hallBits)]));
  const planeBits = Math.ceil(Math.log2(Math.max(1, Math.min(8, Math.floor(planes)))));
  return {
    halls: n, scaled: true, hallBits, shift,
    loIndexBits: Math.max(0, shift.loopback - 4),
    oobSwitchBits: Math.max(0, shift.oob - 8),
    accessLeafBits: Math.max(0, shift.frontend - 8),
    planeBits,
    planeShift: Math.max(0, shift['backend-host'] - planeBits),
    // tier 1 bit + network 2 bits (NET_CODE_SCALED)
    p2pSetShift: Math.max(0, shift['backend-fabric-p2p'] - 3),
    p2pNetBits: 2,
    asnHallDigits,
  };
}

/** Backend host-facing /31 (switch side even, host side odd) — r2-ops.md §2.4 formula; exported for the capacity test.
 *  `hallShift` / `planeShift` / `planeBits` default to the fixed 4-hall layout (20 / 17 / 3). */
export function backendP2p(o: { firstOctet?: number; hall: number; plane: number; leaf: number; hostLanesPerLeaf: number; slot: number; hallShift?: number; planeShift?: number; planeBits?: number }): { switchIp: number; hostIp: number; leafBase: number; leafBlock: number; overflow: boolean } {
  const hallShift = o.hallShift ?? 20;
  const planeShift = o.planeShift ?? 17;
  const planeBits = o.planeBits ?? 3;
  const leafBlock = pow2(2 * o.hostLanesPerLeaf);
  const leafBase = ip(o.firstOctet ?? 10, 64) + o.hall * 2 ** hallShift + o.plane * 2 ** planeShift + o.leaf * leafBlock;
  const overflow = (o.leaf + 1) * leafBlock > 2 ** planeShift || o.hall >= 2 ** (22 - hallShift) || o.plane >= 2 ** planeBits || 2 * o.slot + 1 >= leafBlock;
  return { switchIp: leafBase + 2 * o.slot, hostIp: leafBase + 2 * o.slot + 1, leafBase, leafBlock, overflow };
}

const ROLE_CODE = (u: SwitchUnit): number => {
  if (u.fabricKey === 'scale-out') return u.role === 'leaf' ? 0 : u.role === 'spine' ? 1 : 2;
  if (u.fabricKey === 'frontend') return u.role === 'leaf' ? 3 : 4;
  if (u.fabricKey === 'storage') return u.role === 'leaf' ? 5 : 6;
  return u.role === 'leaf' ? 7 : 8;
};
const NET_BITS: Record<FabricKey, number> = { 'scale-out': 0, frontend: 5, storage: 6, oob: 7 };
/** scaled layout (5+ halls): the four fabrics in a 2-bit network field */
const NET_CODE_SCALED: Record<FabricKey, number> = { 'scale-out': 0, frontend: 1, storage: 2, oob: 3 };

/** `H1.DU01-A-07-U33:P12/2` → { device: 'H1.DU01-A-07-U33', port: 12, lane: 2 } */
function parsePort(p: string): { device: string; port?: number; lane?: number; tail: string } {
  const i = p.lastIndexOf(':');
  const device = i >= 0 ? p.slice(0, i) : p;
  const tail = i >= 0 ? p.slice(i + 1) : '';
  const m = /^P(\d+)(?:\/(\d+))?$/.exec(tail);
  return { device, tail, ...(m ? { port: Number(m[1]), lane: m[2] ? Number(m[2]) : 1 } : {}) };
}

const ipv6Base = (prefix: string) => prefix.slice(0, prefix.indexOf('::'));
const ipv6At = (prefix: string, subnet: number, host: number): string => {
  const head = `${ipv6Base(prefix)}:${subnet.toString(16)}::`;
  if (!host) return head;
  const words: string[] = [];
  let n = Math.max(0, Math.floor(host));
  do {
    words.unshift((n % 65_536).toString(16));
    n = Math.floor(n / 65_536);
  } while (n > 0);
  return `${head}${words.join(':')}`;
};

/** Add location metadata and the parallel IPv6 plan after the unchanged IPv4 allocator has produced its rows. */
function decorateIpPlan(
  project: Project,
  plan: IpPlan,
  rows: CableScheduleRow[],
  units: SwitchUnit[],
  hallIdx: Map<string, number>,
  unitByDevice: Map<string, SwitchUnit>,
  planeOf: Map<string, { plane: number; leaf: number }>,
  settings: ResolvedIpPlanSettings,
  locale?: Locale,
): number {
  const S = ipPlanStrings(locale);
  plan.addressFamilies = settings.includeIpv6 ? ['ipv4', 'ipv6'] : ['ipv4'];
  plan.ipv4Prefix = `${settings.firstOctet}.0.0.0/8`;
  plan.fabricLinks = settings.numberedFabric ? 'numbered' : 'unnumbered';
  if (settings.includeIpv6) plan.ipv6Prefix = settings.ipv6Prefix;

  const rowsByFrom = new Map<string, CableScheduleRow>();
  const rowsByCable = new Map<string, CableScheduleRow>();
  const feRowByNode = new Map<string, CableScheduleRow>();
  for (const r of rows) {
    rowsByCable.set(r.cableId, r);
    if (r.tier !== 'endpoint-leaf') continue;
    if (!rowsByFrom.has(r.fromPort)) rowsByFrom.set(r.fromPort, r);
    if (r.fabricKey === 'frontend') {
      const node = parsePort(r.fromPort).device;
      if (!feRowByNode.has(node)) feRowByNode.set(node, r);
    }
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const networkOf = (fabric: string | undefined, nic?: string, vlan?: number) =>
    nic === 'mgmt' ? 'inband' : vlan === 30 ? 'frontend' : vlan === 40 ? 'storage' : fabric === 'oob' ? 'oob' : fabric === 'frontend' ? 'frontend' : fabric === 'storage' ? 'storage' : 'backend';

  // Each role owns one /52 and gets deterministic /64s in discovery order. This avoids pretending that a /64's raw free-address
  // count is a useful utilisation metric while keeping every prefix visually recognisable.
  const subnetByKey = new Map<string, number>();
  const nextSubnet = new Map<number, number>();
  let ipv6Overflow = 0;
  const subnet = (role: number, key: string): number | undefined => {
    const full = `${role}|${key}`;
    const found = subnetByKey.get(full);
    if (found !== undefined) return found < 0 ? undefined : found;
    const n = nextSubnet.get(role) ?? 0;
    nextSubnet.set(role, n + 1);
    if (n >= 0x1000) {
      subnetByKey.set(full, -1);
      ipv6Overflow++;
      return undefined;
    }
    const id = role * 0x1000 + n;
    subnetByKey.set(full, id);
    return id;
  };
  const hostSeq = new Map<string, number>();
  const take = (key: string, start: number, step = 1) => {
    const n = hostSeq.get(key) ?? start;
    hostSeq.set(key, n + step);
    return n;
  };

  for (const h of plan.hosts) {
    const r = h.nic === 'mgmt' ? feRowByNode.get(h.nodeId) : rowsByFrom.get(`${h.nodeId}:${h.nic}`);
    const switchDevice = r ? parsePort(r.toPort).device : undefined;
    const u = switchDevice ? unitByDevice.get(switchDevice) : undefined;
    const network = networkOf(u?.fabricKey, h.nic, h.vlan);
    const plane = u ? planeOf.get(u.id)?.plane ?? 0 : undefined;
    Object.assign(h, {
      ...(u ? { hallId: u.hallId } : {}),
      ...(switchDevice ? { switchDevice } : {}),
      network,
      ...(network === 'backend' && plane !== undefined ? { plane, rail: u?.rail ?? plane } : {}),
    });
    if (!settings.includeIpv6 || !u) continue;
    const hall = hallIdx.get(u.hallId) ?? 0;
    if (network === 'backend') {
      const rail = u.rail ?? plane ?? 0;
      const key = `backend|${hall}|${plane ?? 0}|${rail}`;
      const sid = subnet(1, key);
      if (sid === undefined) continue;
      const even = take(key, 16, 2);
      h.ipv6Gw = ipv6At(settings.ipv6Prefix, sid, even);
      h.ipv6 = `${ipv6At(settings.ipv6Prefix, sid, even + 1)}/127`;
    } else {
      const role = network === 'frontend' ? 2 : network === 'storage' ? 3 : 4;
      const key = `${network}|${u.id}`;
      const sid = subnet(role, key);
      if (sid === undefined) continue;
      h.ipv6Gw = ipv6At(settings.ipv6Prefix, sid, 1);
      h.ipv6 = `${ipv6At(settings.ipv6Prefix, sid, take(key, 0x10))}/64`;
    }
  }

  for (const o of plan.oob) {
    const r = rowsByFrom.get(o.deviceId);
    const switchDevice = r ? parsePort(r.toPort).device : undefined;
    const u = switchDevice ? unitByDevice.get(switchDevice) : undefined;
    if (u) o.hallId = u.hallId;
    if (switchDevice) o.switchDevice = switchDevice;
    const v4 = o.ip.split('/')[0].split('.');
    if (v4.length === 4) o.gw = `${v4[0]}.${v4[1]}.${v4[2]}.1`;
    if (!settings.includeIpv6 || !u) continue;
    const key = `oob|${u.id}`;
    const sid = subnet(5, key);
    if (sid === undefined) continue;
    o.ipv6Gw = ipv6At(settings.ipv6Prefix, sid, 1);
    o.ipv6 = `${ipv6At(settings.ipv6Prefix, sid, take(key, 0x10))}/64`;
  }

  if (settings.includeIpv6) {
    for (const l of plan.loopbacks) {
      const u = unitById.get(l.deviceId);
      if (!u) continue;
      const hall = u.interHall ? 'cluster' : String(hallIdx.get(u.hallId) ?? 0);
      const role = u.interHall ? 2 : ROLE_CODE(u);
      const key = `loopback|${hall}|${role}`;
      const sid = subnet(0, key);
      if (sid === undefined) continue;
      l.ipv6 = ipv6At(settings.ipv6Prefix, sid, take(key, 1));
    }
  }

  for (const l of plan.p2p) {
    const r = rowsByCable.get(l.linkId);
    const lower = unitByDevice.get(parsePort(l.a).device);
    const upper = unitByDevice.get(parsePort(l.b).device);
    const u = upper ?? lower;
    if (u) l.hallId = u.hallId;
    if (r?.fabricKey) l.network = r.fabricKey;
    const railUnit = r?.fabricKey === 'scale-out' ? lower ?? upper : undefined;
    if (railUnit?.rail !== undefined) l.rail = railUnit.rail;
    if (!settings.includeIpv6 || !settings.numberedFabric || !u) continue;
    const hall = hallIdx.get(u.hallId) ?? 0;
    const role = r?.tier === 'inter-hall' ? 7 : 6;
    const key = `fabric|${hall}|${r?.tier ?? 'link'}|${r?.fabricKey ?? 'scale-out'}`;
    const sid = subnet(role, key);
    if (sid === undefined) continue;
    const even = take(key, 0, 2);
    l.ipv6A = ipv6At(settings.ipv6Prefix, sid, even);
    l.ipv6B = ipv6At(settings.ipv6Prefix, sid, even + 1);
    l.ipv6Cidr = `${l.ipv6A}/127`;
  }

  if (!settings.includeIpv6) return ipv6Overflow;
  const block = (role: number, name: keyof typeof S.purposeV6) => ({
    name,
    cidr: `${ipv6Base(settings.ipv6Prefix)}:${role.toString(16)}000::/52`,
    purpose: S.purposeV6[name],
  });
  plan.ipv6Blocks = [
    block(0, 'loopback'),
    ...(!project.network.scaleOut.fabric.startsWith('ib-') ? [block(1, 'backend-host')] : []),
    block(2, 'frontend'), block(3, 'storage'), block(4, 'inband'), block(5, 'oob'),
    block(6, 'fabric-p2p'), block(7, 'inter-hall'), block(15, 'reserved'),
  ];
  return ipv6Overflow;
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
  /** hall field layout used for this plan */
  layout: IpHallLayout;
  /** cable schedule and switch units the plan was built from (shared with the IP map review) */
  rows: CableScheduleRow[];
  units: SwitchUnit[];
}

/** Bit position of the hall field inside each hall-scoped block (hall prefix size = 2^shift). */
export const IP_HALL_SHIFT: Record<string, number> = { loopback: 16, oob: 18, frontend: 16, storage: 16, inband: 16, 'backend-host': 20, 'backend-fabric-p2p': 20 };

export const LOOPBACK_ROLE_NAMES = ['backend leaf', 'backend spine', 'backend core', 'FE leaf', 'FE spine', 'storage leaf', 'storage spine', 'OOB leaf', 'OOB aggregation', 'in-band leaf', 'border', 'backend leaf (overflow)'];

export function buildIpPlan(project: Project, analysis: ProjectAnalysis, opts: IpPlanOptions = {}): IpPlan {
  return buildIpPlanDetailed(project, analysis, opts).plan;
}

/** `buildIpPlan` plus the allocated subnet records (same addresses). */
export function buildIpPlanDetailed(project: Project, analysis: ProjectAnalysis, opts: IpPlanOptions = {}): IpPlanDetailed {
  const settings = resolveIpPlanSettings(project, opts);
  const O = settings.firstOctet;
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
  const numbered = settings.numberedFabric;
  const notes: string[] = [];
  const S = ipPlanStrings(opts.locale);
  const nf = (v: number) => v.toLocaleString(ipNumberTag(opts.locale));
  const plan = emptyIpPlan();
  const isIb = project.network.scaleOut.fabric.startsWith('ib-');
  const isDdc = project.network.scaleOut.fabric === 'drivenets-fse';
  const hallIdx = new Map(project.halls.map((h, i) => [h.id, i]));
  const L = ipHallLayout(project.halls.length, settings.planes);
  const loCap = 2 ** L.loIndexBits;
  const asnIdxCap = 10 ** (6 - L.asnHallDigits);
  const asn = (h: number, role: number, i: number) => asnOf(site, h, role, i, L.asnHallDigits);
  if (L.scaled) {
    notes.push(S.notes.scaled({ halls: project.halls.length, hallBits: L.hallBits, hallPrefixes: 2 ** L.hallBits, loCap, access24: 2 ** L.accessLeafBits, oob24: 2 ** L.oobSwitchBits, planeShift: L.planeShift, p2pPrefix: 32 - L.p2pSetShift, asnDigits: L.asnHallDigits }, nf));
  }

  plan.blocks = [
    { name: 'loopback', cidr: `${O}.0.0.0/14`, purpose: S.purpose['loopback'] },
    { name: 'cluster-loopback', cidr: `${O}.4.0.0/16`, purpose: S.purpose['cluster-loopback'] },
    { name: 'oob', cidr: `${O}.16.0.0/12`, purpose: S.purpose['oob'] },
    { name: 'frontend', cidr: `${O}.40.0.0/14`, purpose: S.purpose['frontend'] },
    { name: 'storage', cidr: `${O}.44.0.0/14`, purpose: S.purpose['storage'] },
    { name: 'inband', cidr: `${O}.48.0.0/14`, purpose: S.purpose['inband'] },
    ...(isIb ? [{ name: 'ipoib', cidr: `${O}.52.0.0/14`, purpose: S.purpose.ipoib }] : []),
    ...(!isIb ? [{ name: 'backend-host', cidr: `${O}.64.0.0/10`, purpose: S.purpose['backend-host'] }] : []),
    ...(!isIb ? [{ name: 'backend-fabric-p2p', cidr: `${O}.128.0.0/10`, purpose: numbered ? S.purpose.p2pNumbered : S.purpose.p2pReserved }] : []),
    // QA halls-ipmap v2 2차: the IB scale-out has no IP, but numbered mode still numbers the Ethernet front-end / storage / OOB fabric links
    // from 10.128.0.0/10 (loop below) — declare the block so those /31s sit inside a plan block (the IP map no longer lists them as overflow)
    ...(isIb && numbered ? [{ name: 'backend-fabric-p2p', cidr: `${O}.128.0.0/10`, purpose: S.purpose.p2pIbNumbered }] : []),
    { name: 'inter-hall', cidr: `${O}.192.0.0/14`, purpose: S.purpose['inter-hall'] },
    { name: 'reserved', cidr: `${O}.200.0.0/13`, purpose: S.purpose['reserved'] },
  ];
  if (isIb) notes.push(S.notes.ib);
  if (isDdc) notes.push(S.notes.ddc);

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
      use(subnet('clo|2', () => ({ block: 'cluster-loopback', label: S.superSpine, start: ip(O, 4) + (2 << 12), size: 4096 })), 1, u.id, u.rackTag, ipToString(ip(O, 4) + ((2 << 12) | i)));
      plan.asns.push({ deviceId: u.id, asn: asn(0, 1, 100 + (clusterIdx.get(u.clusterId ?? '') ?? 0)) });
      continue;
    }
    const k = `${h}|${role}`;
    let i = roleIdx.get(k) ?? 0;
    roleIdx.set(k, i + 1);
    unitIdx.set(u.id, i);
    if (i >= loCap && role === 0) {
      role = 11;
      i -= loCap;
    }
    if (i >= loCap) loOverflow++;
    const loHallStart = ip(O, 0) + h * 2 ** L.shift.loopback;
    plan.loopbacks.push({ deviceId: u.id, ip: ipToString(loHallStart + role * loCap + (i & (loCap - 1))) });
    {
      const r = role;
      use(subnet(`lo|${h}|${r}`, () => ({ block: 'loopback', label: S.loopbackRoles[r] ?? S.roleN(r), start: loHallStart + r * loCap, size: loCap, hall: h, hallId: u.hallId })), 1, u.id, u.rackTag, ipToString(loHallStart + r * loCap + (i & (loCap - 1))));
    }
    let as: number;
    if (u.fabricKey === 'scale-out') {
      if (u.role === 'leaf') {
        const li = leafAsnIdx.get(`${h}`) ?? 0;
        leafAsnIdx.set(`${h}`, li + 1);
        as = asn(h, 3, li);
        if (li >= Math.min(10_000, asnIdxCap)) loOverflow++;
      } else as = u.role === 'spine' ? asn(h, 2, 0) : asn(h, 1, 0);
    } else if (u.fabricKey === 'frontend') as = u.role === 'leaf' ? asn(h, 4, unitIdx.get(u.id)!) : asn(h, 5, 0);
    else if (u.fabricKey === 'storage') as = u.role === 'leaf' ? asn(h, 6, unitIdx.get(u.id)!) : asn(h, 7, 0);
    else as = asn(h, 8, unitIdx.get(u.id)!);
    if (L.scaled && u.role === 'leaf' && u.fabricKey !== 'scale-out' && unitIdx.get(u.id)! >= asnIdxCap) loOverflow++;
    plan.asns.push({ deviceId: u.id, asn: as });
  }
  if (loOverflow) {
    notes.push(L.scaled
      ? S.notes.loOverflowScaled(loOverflow, nf(loCap), nf(Math.min(10_000, asnIdxCap)))
      : S.notes.loOverflow(loOverflow));
  }

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
  const planes = settings.planes;
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
      const a = backendP2p({ firstOctet: O, hall: h, plane: pl?.plane ?? 0, leaf: pl?.leaf ?? unitIdx.get(unit.id) ?? 0, hostLanesPerLeaf: hostLanesByHall.get(h) ?? unit.downlinks * lanes, slot, hallShift: L.shift['backend-host'], planeShift: L.planeShift, planeBits: L.planeBits });
      if (a.overflow) backendOverflow++;
      plan.hosts.push({ nodeId, nic, ip: `${ipToString(a.hostIp)}/31`, gw: ipToString(a.switchIp) });
      const plane = pl?.plane ?? 0;
      use(subnet(`be|${a.leafBase}`, () => ({
        block: 'backend-host', label: sw.device, start: a.leafBase, size: a.leafBlock, hall: h, hallId: unit.hallId, group: `plane ${plane}`,
        groupStart: ip(O, 64) + h * 2 ** L.shift['backend-host'] + plane * 2 ** L.planeShift, groupSize: 2 ** L.planeShift, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id,
      })), 2, sw.device, nodeId, `${nodeId}:${nic}`, ipToString(a.hostIp));
    } else if (key === 'frontend' || key === 'storage') {
      const leaf = unitIdx.get(unit.id) ?? 0;
      const n = accessHost.get(unit.id) ?? 0;
      accessHost.set(unit.id, n + 1);
      const host = 10 + n;
      if (host > 254 || leaf >= 2 ** L.accessLeafBits) accessOverflow++;
      const base = ip(O, key === 'frontend' ? 40 : 44) + h * 2 ** L.shift[key] + leaf * 256;
      plan.hosts.push({ nodeId, nic, ip: `${ipToString(base + (host & 255))}/24`, vlan: key === 'frontend' ? 30 : 40, gw: ipToString(base + 1) });
      use(subnet(`${key}|${base}`, () => ({ block: key, label: sw.device, start: base, size: 256, hall: h, hallId: unit.hallId, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id }), 1), 1, sw.device, nodeId, `${nodeId}:${nic}`, ipToString(base + (host & 255)));
      if (key === 'frontend' && !inbandDone.has(nodeId)) {
        inbandDone.add(nodeId);
        const m = inbandHost.get(unit.id) ?? 0;
        inbandHost.set(unit.id, m + 1);
        const ib = ip(O, 48) + h * 2 ** L.shift.inband + leaf * 256;
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
      if (10 + n > 254 || s >= 2 ** L.oobSwitchBits) accessOverflow++;
      const start = ip(O, 16) + h * 2 ** L.shift.oob + s * 256;
      plan.oob.push({ deviceId: r.fromPort, ip: `${ipToString(start + ((10 + n) & 255))}/24` });
      {
        use(subnet(`oob|${start}`, () => ({ block: 'oob', label: sw.device, start, size: 256, hall: h, hallId: unit.hallId, podId: unit.podId, rackTag: unit.rackTag, deviceId: unit.id }), 1), 1, sw.device, r.fromPort, ipToString(start + ((10 + n) & 255)));
      }
    }
  }
  if (backendOverflow) {
    notes.push(L.scaled
      ? S.notes.backendOverflowScaled(backendOverflow, L.planeShift, project.halls.length)
      : S.notes.backendOverflow(backendOverflow));
  }
  if (accessOverflow) notes.push(S.notes.accessOverflow(accessOverflow));

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
        const ih = subnet('ih', () => ({ block: 'inter-hall', label: S.superSpineTrunks, start: ip(O, 192), size: 2 }));
        ih.size = pow2(2 * trunkSeq);
        use(ih, 2, r.cableId, r.fromPort, r.toPort);
      } else {
        const tierBit = r.tier === 'spine-core' ? 1 : 0;
        const lanes = upperLanes.get(upperP.device) ?? 1;
        const block = blockBySet.get(setKey(r.tier, upper)) ?? pow2(2 * upper.ports * lanes);
        const slot = ((upperP.port ?? 1) - 1) * lanes + ((upperP.lane ?? 1) - 1);
        const idx = unitIdx.get(upper.id) ?? 0;
        if (idx * block + 2 * slot >= 2 ** L.p2pSetShift) p2pOverflow++;
        const netCode = (L.scaled ? NET_CODE_SCALED : NET_BITS)[upper.fabricKey];
        const gStart = ip(O, 128) + h * 2 ** L.shift['backend-fabric-p2p'] + tierBit * 2 ** (L.p2pSetShift + L.p2pNetBits) + netCode * 2 ** L.p2pSetShift;
        cidr = `${ipToString(gStart + idx * block + 2 * slot)}/31`;
        use(subnet(`p2p|${gStart}|${idx}`, () => ({
          block: 'backend-fabric-p2p', label: upperP.device, start: gStart + idx * block, size: block, hall: h, hallId: upper.hallId,
          group: `${tierBit ? 'spine–core' : 'leaf–spine'} · ${upper.fabricKey}`, groupStart: gStart, groupSize: 2 ** L.p2pSetShift, podId: upper.podId, rackTag: upper.rackTag, deviceId: upper.id,
        })), 2, upperP.device, r.cableId, r.fromPort, r.toPort);
      }
    }
    plan.p2p.push({ linkId: r.cableId, a: r.fromPort, b: r.toPort, ...(cidr ? { cidr } : {}), unnumbered: !numbered });
  }
  if (p2pOverflow) notes.push(S.notes.p2pOverflow(p2pOverflow, 32 - L.p2pSetShift));
  if (!numbered && !isIb) notes.push(S.notes.unnumbered);
  const ipv6Overflow = decorateIpPlan(project, plan, rows, units, hallIdx, unitByDevice, planeOf, settings, opts.locale);
  if (settings.includeIpv6) {
    if (settings.invalidIpv6Prefix) notes.push(S.notes.invalidIpv6Prefix(settings.invalidIpv6Prefix, settings.ipv6Prefix));
    else if (!(opts.ipv6Prefix ?? project.network.addressing?.ipv6Prefix)) notes.push(S.notes.ipv6Default(settings.ipv6Prefix));
    if (ipv6Overflow) notes.push(S.notes.ipv6SubnetOverflow(ipv6Overflow));
  }
  plan.notes = notes;
  return { plan, subnets: [...subnets.values()].map((s) => ({ ...s, members: [...memberSets.get(s.key)!] })), layout: L, rows, units };
}

export interface IpCapacityCheck {
  item: string;
  need: number;
  capacity: number;
  ok: boolean;
}

/**
 * Capacity of the IP layout for a site (r2-ops.md §2.4 capacity table): backend host lanes per plane, leaves per hall, access /24s
 * and ASN digits. Backlog T3 (4): the field widths come from `ipHallLayout(halls, planes)` — the fixed 4-hall layout for ≤ 4 halls
 * (unchanged items and limits), the scaled layout for 5+ halls (per-hall capacity shrinks as the hall field widens). Pure arithmetic.
 */
export function ipPlanCapacity(o: { halls: number; gpusPerHall: number; lanesPerGpu: number; leafHostLanes: number; planes: number; accessLeavesPerHall: number; oobSwitchesPerHall: number }): IpCapacityCheck[] {
  const L = ipHallLayout(o.halls, o.planes);
  const n = (v: number) => v.toLocaleString('en-US');
  const leavesPerPlane = Math.ceil((o.gpusPerHall * o.lanesPerGpu) / o.leafHostLanes);
  const block = pow2(2 * o.leafHostLanes);
  const halls = 2 ** L.hallBits;
  const planes = 2 ** L.planeBits;
  const hostCap = 2 ** L.planeShift;
  const loCap = 2 ** L.loIndexBits;
  const asnCap = Math.min(10_000, 10 ** (6 - L.asnHallDigits));
  const access = 2 ** L.accessLeafBits;
  const oob = 2 ** L.oobSwitchBits;
  const checks: IpCapacityCheck[] = [
    { item: `halls (${L.hallBits} bits)`, need: o.halls, capacity: halls, ok: o.halls <= halls },
    { item: `planes (${L.planeBits} bits)`, need: o.planes, capacity: planes, ok: o.planes <= planes },
    { item: `backend host /31 per plane (2^${L.planeShift} addresses)`, need: leavesPerPlane * block, capacity: hostCap, ok: leavesPerPlane * block <= hostCap },
    { item: `backend leaf loopbacks per hall (${n(loCap)} + overflow role)`, need: leavesPerPlane * o.planes, capacity: 2 * loCap, ok: leavesPerPlane * o.planes <= 2 * loCap },
    { item: `backend leaf ASNs per hall (plane·${n(asnCap)} + leaf)`, need: leavesPerPlane, capacity: asnCap, ok: leavesPerPlane < asnCap },
    { item: `access /24 per hall (${L.accessLeafBits} bits)`, need: o.accessLeavesPerHall, capacity: access, ok: o.accessLeavesPerHall <= access },
    { item: `OOB /24 per hall (${L.oobSwitchBits} bits)`, need: o.oobSwitchesPerHall, capacity: oob, ok: o.oobSwitchesPerHall <= oob },
  ];
  return checks;
}
