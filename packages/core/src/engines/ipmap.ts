// IP allocation map (v2 2차 follow-up "IP map"): the deterministic IP plan (engines/ipplan.ts) as a nested block hierarchy
//   site /8 → plan block → hall prefix → fabric / role prefix → pod (consecutive run) → allocated subnet
// with address counts and utilisation at every level, plus a device / NIC / IP lookup. Pure data — the web draws it as a nested block map.
import type { CableScheduleRow, IpPlan, Locale, Project, ProjectAnalysis } from '../model/types.ts';
import { ipPlanStrings } from './ipplanStrings.ts';
import { csvFile } from '../deploy/csv.ts';
import { buildIpPlanDetailed, IP_HALL_SHIFT, ipToString, resolveIpPlanSettings, type IpHallLayout, type IpPlanDetailed, type IpPlanOptions, type IpSubnetRecord } from './ipplan.ts';
import type { SwitchUnit } from './links.ts';

export type IpMapNodeKind = 'site' | 'block' | 'hall' | 'group' | 'pod' | 'subnet';

export interface IpMapNode {
  id: string;
  kind: IpMapNodeKind;
  label: string;
  /** exact prefix when the node is one (pods are address ranges of consecutive subnets and have none) */
  cidr?: string;
  /** first address (unsigned 32-bit) */
  start: number;
  /** addresses in the node's range */
  size: number;
  /** addresses assigned below this node (Σ children for inner nodes) */
  used: number;
  /** used ÷ size */
  utilisation: number;
  children: IpMapNode[];
  purpose?: string;
  hallId?: string;
  podId?: string;
  rackTag?: string;
  deviceId?: string;
  /** subnet lookup strings (devices, nodes, NICs, IPs) */
  members?: string[];
}

export interface IpMap {
  root: IpMapNode;
  plan: IpPlan;
  subnetCount: number;
  /** subnets that fall outside their block / hall prefix (plan overflow) — not drawn */
  outside: string[];
}

export const rangeLabel = (start: number, size: number): string => `${ipToString(start)} – ${ipToString(start + size - 1)}`;

/** exact CIDR when [start, start+size) is a prefix, else undefined */
export function prefixOf(start: number, size: number): string | undefined {
  const bits = Math.log2(size);
  if (!Number.isInteger(bits) || bits > 32 || start % size !== 0) return undefined;
  return `${ipToString(start)}/${32 - bits}`;
}

export function parseCidr(cidr: string): { start: number; size: number } | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/.exec(cidr.trim());
  if (!m) return undefined;
  const o = m.slice(1, 5).map(Number);
  if (o.some((x) => x > 255)) return undefined;
  const len = m[5] === undefined ? 32 : Number(m[5]);
  if (len > 32) return undefined;
  const size = 2 ** (32 - len);
  const addr = ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
  return { start: addr - (addr % size), size };
}

function node(kind: IpMapNodeKind, id: string, label: string, start: number, size: number, extra: Partial<IpMapNode> = {}): IpMapNode {
  return { id, kind, label, start, size, used: 0, utilisation: 0, children: [], cidr: prefixOf(start, size), ...extra };
}

const inside = (child: { start: number; size: number }, parent: { start: number; size: number }) => child.start >= parent.start && child.start + child.size <= parent.start + parent.size;

/** Build the map from a project (runs `buildIpPlanDetailed`). */
export function buildIpMap(project: Project, analysis: ProjectAnalysis, opts: IpPlanOptions = {}): IpMap {
  const { plan, subnets, layout } = buildIpPlanDetailed(project, analysis, opts);
  return buildIpMapFromPlan(project, plan, subnets, resolveIpPlanSettings(project, opts).firstOctet, layout);
}

/** `layout` (from `buildIpPlanDetailed`) sizes the hall prefixes; absent = the fixed 4-hall layout. */
export function buildIpMapFromPlan(project: Project, plan: IpPlan, subnets: IpSubnetRecord[], firstOctet = 10, layout?: IpHallLayout): IpMap {
  const root = node('site', 'site', project.site.name || project.name, ((firstOctet << 24) >>> 0), 2 ** 24, { purpose: project.name });
  const outside: string[] = [];
  const blocks = new Map<string, IpMapNode>();
  for (const b of plan.blocks) {
    const r = parseCidr(b.cidr);
    if (!r || !inside(r, root)) continue;
    const n = node('block', `block:${b.name}`, b.name, r.start, r.size, { purpose: b.purpose, cidr: b.cidr });
    blocks.set(b.name, n);
    root.children.push(n);
  }
  // hall and group nodes are keyed by their range; subnets are attached to the deepest container, then pods are formed per container
  const containers = new Map<string, IpMapNode>();
  const pending = new Map<IpMapNode, IpSubnetRecord[]>();
  const child = (parent: IpMapNode, kind: IpMapNodeKind, label: string, start: number, size: number, extra: Partial<IpMapNode> = {}) => {
    const id = `${parent.id}>${kind}:${start}/${size}`;
    let n = containers.get(id);
    if (!n) {
      n = node(kind, id, label, start, size, extra);
      containers.set(id, n);
      parent.children.push(n);
    }
    return n;
  };
  for (const s of subnets) {
    const block = blocks.get(s.block);
    if (!block || !inside(s, block)) {
      outside.push(s.key);
      continue;
    }
    let parent = block;
    const shift = layout?.shift[s.block] ?? IP_HALL_SHIFT[s.block];
    if (s.hall !== undefined && shift !== undefined) {
      const hs = 2 ** shift;
      const hStart = block.start + s.hall * hs;
      const hall = project.halls.find((h) => h.id === s.hallId);
      const hn = { start: hStart, size: hs };
      if (!inside(hn, block) || !inside(s, hn)) {
        outside.push(s.key);
        continue;
      }
      parent = child(block, 'hall', hall?.name ?? `H${s.hall + 1}`, hStart, hs, { hallId: s.hallId });
    }
    if (s.group && s.groupStart !== undefined && s.groupSize !== undefined) {
      const g = { start: s.groupStart, size: s.groupSize };
      if (!inside(g, parent) || !inside(s, g)) {
        outside.push(s.key);
        continue;
      }
      parent = child(parent, 'group', s.group, g.start, g.size);
    }
    if (!pending.has(parent)) pending.set(parent, []);
    pending.get(parent)!.push(s);
  }
  // pods: consecutive runs (by address) of subnets that share a pod id — runs never interleave, so pod ranges never overlap
  for (const [parent, list] of pending) {
    list.sort((a, b) => a.start - b.start);
    let i = 0;
    let podSeq = 0;
    while (i < list.length) {
      const pod = list[i].podId;
      let j = i;
      while (j + 1 < list.length && pod && list[j + 1].podId === pod) j++;
      const leaves = list.slice(i, j + 1).map((s) =>
        node('subnet', `${parent.id}>subnet:${s.key}`, s.label, s.start, s.size, { used: s.used, hallId: s.hallId, podId: s.podId, rackTag: s.rackTag, deviceId: s.deviceId, members: s.members }));
      if (pod && leaves.length > 1) {
        const start = leaves[0].start;
        const end = leaves[leaves.length - 1].start + leaves[leaves.length - 1].size;
        const pn = node('pod', `${parent.id}>pod:${pod}:${podSeq++}`, pod, start, end - start, { podId: pod });
        pn.children = leaves;
        parent.children.push(pn);
      } else parent.children.push(...leaves);
      i = j + 1;
    }
  }
  const finish = (n: IpMapNode) => {
    if (n.children.length) {
      n.children.sort((a, b) => a.start - b.start);
      n.children.forEach(finish);
      n.used = n.children.reduce((a, c) => a + c.used, 0);
    }
    n.utilisation = n.size ? n.used / n.size : 0;
  };
  finish(root);
  return { root, plan, subnetCount: subnets.length - outside.length, outside };
}

export interface IpMapMatch {
  /** root → matched node */
  path: IpMapNode[];
  /** the member string that matched (absent for IP / CIDR / label hits) */
  member?: string;
}

/**
 * How well `value` matches a lower-case query: 0 exact, 1 the query ends at a name boundary ("u1" in "…-U1:mgmt0"),
 * 2 the query continues inside a longer name ("u1" in "…-U11", "n10:be1" in "…:N10:be10"), -1 no match.
 */
export function ipMapMatchRank(value: string, needle: string): number {
  const v = value.toLowerCase();
  if (v === needle) return 0;
  let rank = -1;
  for (let i = v.indexOf(needle); i >= 0; i = v.indexOf(needle, i + 1)) {
    const next = v.charAt(i + needle.length);
    if (!next || !/[a-z0-9]/.test(next)) return 1;
    rank = 2;
  }
  return rank;
}

/**
 * Look up a device, node, NIC, IP address or CIDR. IPv4 queries return the deepest node containing the address; text queries match
 * subnet members (devices, node ids, "node:nic", IPs), labels and rack tags case-insensitively. Text matches are ranked — exact names
 * first, then names that continue with a separator (device → device:mgmt0), then longer names that contain the query (U1 → U11) —
 * and keep address order within a rank, so "node:be1" never selects the subnet of "node:be10".
 */
export function findInIpMap(map: IpMap, query: string, limit = 20): IpMapMatch[] {
  const q = query.trim();
  if (!q) return [];
  const ipq = parseCidr(q);
  if (ipq) {
    const path: IpMapNode[] = [];
    let cur: IpMapNode | undefined = map.root;
    while (cur && inside(ipq, cur)) {
      path.push(cur);
      cur = cur.children.find((c) => inside(ipq, c));
    }
    return path.length ? [{ path }] : [];
  }
  const needle = q.toLowerCase();
  const found: { m: IpMapMatch; rank: number }[] = [];
  let exact = 0;
  const walk = (n: IpMapNode, path: IpMapNode[]) => {
    if (exact >= limit) return; // enough exact matches in address order: nothing later can outrank them
    const p = [...path, n];
    if (n.kind === 'subnet') {
      let rank = -1;
      let member: string | undefined;
      for (const m of n.members ?? []) {
        const r = ipMapMatchRank(m, needle);
        if (r >= 0 && (rank < 0 || r < rank)) {
          rank = r;
          member = m;
          if (r === 0) break;
        }
      }
      for (const s of [n.label, n.rackTag, n.cidr]) {
        const r = s ? ipMapMatchRank(s, needle) : -1;
        if (r >= 0 && (rank < 0 || r < rank)) {
          rank = r;
          member = undefined;
        }
      }
      if (rank >= 0) {
        found.push({ m: member ? { path: p, member } : { path: p }, rank });
        if (rank === 0) exact++;
      }
      return;
    }
    n.children.forEach((c) => walk(c, p));
  };
  walk(map.root, []);
  // Array.prototype.sort is stable: address order is kept within a rank
  return found.sort((a, b) => a.rank - b.rank).slice(0, limit).map((f) => f.m);
}

/** Node by id (depth-first). */
export function findIpMapNode(root: IpMapNode, id: string): IpMapNode | undefined {
  if (root.id === id) return root;
  for (const c of root.children) {
    const f = findIpMapNode(c, id);
    if (f) return f;
  }
  return undefined;
}

/** Root → node path by id. */
export function ipMapPath(root: IpMapNode, id: string): IpMapNode[] {
  if (root.id === id) return [root];
  for (const c of root.children) {
    const p = ipMapPath(c, id);
    if (p.length) return [root, ...p];
  }
  return [];
}

// ───────────── review views (IP map review v2 2차, docs/research/ipmap-review-v2-2.md) ─────────────
// One flat list of every addressed item (host NIC, in-band mgmt, OOB port, switch loopback, fabric link, and InfiniBand NICs that carry
// no IP) joined with its location (hall → DU / pod → rack → device), its switch, rail and subnet — then grouped three ways:
//   groupIpPlanByLocation  hall → DU → rack → device → addresses
//   groupIpPlanByRail      network → [hall] → rail → leaf → NICs (+ leaf uplinks) · FE / storage / in-band / OOB → access switch →
//                          addresses, fabric links per tier · loopbacks / ASNs → tier → switches
//   groupIpPlanBySubnet    block → hall → subnet (members, free space) · no-IP InfiniBand NICs · unnumbered links
// Every entry appears exactly once in each view; group counters are sums over the entries below.

export type IpReviewNet = 'backend' | 'frontend' | 'storage' | 'inband' | 'oob';
export type IpReviewEntryKind = 'nic' | 'mgmt' | 'oob' | 'loopback' | 'link';
export type IpReviewDeviceType = 'node' | 'switch' | 'endpoint' | 'link';

export interface IpReviewEntry {
  /** unique id */
  key: string;
  kind: IpReviewEntryKind;
  net: IpReviewNet;
  deviceType: IpReviewDeviceType;
  /** node id / switch device name / OOB endpoint device; for a link the A-end (lower) device */
  device: string;
  /** NIC, OOB port, or the A-end port of a link */
  port?: string;
  ip?: string;
  prefix?: number;
  gw?: string;
  ipv6?: string;
  ipv6Prefix?: number;
  ipv6Gw?: string;
  /** /64 containing the IPv6 address, or /127 for a numbered point-to-point link. */
  ipv6Subnet?: string;
  vlan?: number;
  asn?: number;
  /** links */
  linkId?: string;
  a?: string;
  b?: string;
  cidr?: string;
  ipv6Cidr?: string;
  ipv6A?: string;
  ipv6B?: string;
  unnumbered?: boolean;
  /** cable tier of a link; loopback role label of a switch */
  role?: string;
  hallId?: string;
  /** DU / pod group id inside the hall */
  pod?: string;
  rackTag?: string;
  /** leaf / access switch serving the address (device name) */
  switchDevice?: string;
  plane?: number;
  rail?: number;
  subnetKey?: string;
  /** no IP: InfiniBand NIC (LID / GUID from the subnet manager) or an unresolved cable end */
  noIp?: boolean;
  /** endpoint whose cable-schedule switch end is unresolved (no free switch port): not addressed by the plan */
  unresolved?: boolean;
  /** lower-case search haystack */
  search: string;
}

export interface IpReviewFree {
  /** free addresses (network / broadcast of a gateway /24 excluded) */
  free: number;
  /** free ranges in address order (first 6) */
  ranges: string[];
  rangeCount: number;
}

export interface IpReview {
  plan: IpPlan;
  subnets: IpSubnetRecord[];
  subnetByKey: Map<string, IpSubnetRecord>;
  layout: IpHallLayout;
  map: IpMap;
  entries: IpReviewEntry[];
  halls: { id: string; name: string; index: number }[];
  pods: { hallId: string; id: string; label: string }[];
  racks: { hallId: string; pod: string; tag: string }[];
  rails: number[];
  /** switch device name → loopback / ASN / rail */
  switches: Map<string, { unitId: string; loopback?: string; ipv6Loopback?: string; asn?: number; rail?: number; role: string; net: IpReviewNet }>;
  freeBySubnet: Map<string, IpReviewFree>;
  multiHall: boolean;
  isIb: boolean;
  /** backlog T3 (3): language of group labels (plan text comes localized from buildIpPlanDetailed) */
  locale?: Locale;
}

const NET_OF: Record<string, IpReviewNet> = { 'scale-out': 'backend', frontend: 'frontend', storage: 'storage', oob: 'oob' };
const splitLast = (s: string): { device: string; port?: string } => {
  const i = s.lastIndexOf(':');
  return i > 0 && i < s.length - 1 ? { device: s.slice(0, i), port: s.slice(i + 1) } : { device: s };
};
const stripHall = (rack: string) => rack.replace(/^H\d+\./, '');
const ipNum = (s: string | undefined): number | undefined => {
  if (!s) return undefined;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : undefined;
};
const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

/** Canonical /64 containing an IPv6 address generated by the plan (also accepts arbitrary compressed IPv6 text). */
export function ipv6Prefix64(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const address = value.toLowerCase().split('/')[0];
  if (!address.includes(':') || address.includes('%') || address.includes('.')) return undefined;
  if ((address.match(/::/g) ?? []).length > 1) return undefined;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if (![...left, ...right].every((x) => /^[0-9a-f]{1,4}$/.test(x))) return undefined;
  const fill = new Array(Math.max(0, 8 - left.length - right.length)).fill('0');
  const words = [...left, ...fill, ...right];
  if (words.length !== 8) return undefined;
  return `${words.slice(0, 4).map((x) => Number.parseInt(x, 16).toString(16)).join(':')}::/64`;
}

export interface Ipv6Range { start: bigint; size: bigint; prefix: number }

/** Parse an IPv6 address or CIDR into a 128-bit range. Kept separate from the IPv4 treemap's number-based range. */
export function parseIpv6Cidr(value: string | undefined): Ipv6Range | undefined {
  if (!value) return undefined;
  const [address, prefixText, ...rest] = value.trim().toLowerCase().split('/');
  if (rest.length || !address || address.includes('%') || address.includes('.')) return undefined;
  const prefix = prefixText === undefined ? 128 : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128 || (address.match(/::/g) ?? []).length > 1) return undefined;
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  if (halves.length === 2 && left.length + right.length >= 8) return undefined;
  if (![...left, ...right].every((x) => /^[0-9a-f]{1,4}$/.test(x))) return undefined;
  const words = [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (words.length !== 8) return undefined;
  let n = 0n;
  for (const word of words) n = (n << 16n) | BigInt(Number.parseInt(word, 16));
  const hostBits = BigInt(128 - prefix);
  const size = 1n << hostBits;
  return { start: (n / size) * size, size, prefix };
}

/** Build the review model (runs `buildIpPlanDetailed` once; the IP map is included). */
export function buildIpReview(project: Project, analysis: ProjectAnalysis, opts: IpPlanOptions = {}): IpReview {
  return buildIpReviewFromDetailed(project, buildIpPlanDetailed(project, analysis, opts), resolveIpPlanSettings(project, opts).firstOctet, opts.locale);
}

export function buildIpReviewFromDetailed(project: Project, detailed: IpPlanDetailed, firstOctet = 10, locale?: Locale): IpReview {
  const { plan, subnets, layout, rows, units } = detailed;
  const map = buildIpMapFromPlan(project, plan, subnets, firstOctet, layout);
  const isIb = project.network.scaleOut.fabric.startsWith('ib-');
  const hallIdx = new Map(project.halls.map((h, i) => [h.id, i]));
  const hallName = new Map(project.halls.map((h) => [h.id, h.name]));
  const subnetByKey = new Map(subnets.map((s) => [s.key, s]));
  const memberKey = new Map<string, string>();
  for (const s of subnets) for (const m of s.members) memberKey.set(m, s.key);
  const unitByDevice = new Map<string, SwitchUnit>();
  const deviceOfUnit = new Map<string, string>();
  for (const u of units) {
    const d = `H${(hallIdx.get(u.hallId) ?? 0) + 1}.${u.rackTag}-U${u.u}`;
    unitByDevice.set(d, u);
    deviceOfUnit.set(u.id, d);
  }
  // DU / pod of a rack: equipment pod id, else row id; label = first segment of the pod's first rack tag ("DU01", "SVC")
  const eqByTag = new Map<string, { podId?: string; rowId?: string }>();
  for (const e of project.equipment) eqByTag.set(`${e.hallId}|${e.tag}`, e);
  const podLabel = new Map<string, string>();
  const podOf = (hallId: string | undefined, tag: string | undefined): string => {
    const eq = hallId && tag ? eqByTag.get(`${hallId}|${tag}`) : undefined;
    const id = eq?.podId ?? eq?.rowId ?? 'unassigned';
    const k = `${hallId}|${id}`;
    if (!podLabel.has(k)) podLabel.set(k, id === 'unassigned' ? 'unassigned' : `${(tag ?? id).split('-')[0]}`);
    return id;
  };
  const rowsByFrom = new Map<string, CableScheduleRow>();
  const rowsByCable = new Map<string, CableScheduleRow>();
  const feRowByNode = new Map<string, CableScheduleRow>();
  for (const r of rows) {
    rowsByCable.set(r.cableId, r);
    if (r.tier !== 'endpoint-leaf') continue;
    rowsByFrom.set(r.fromPort, r);
    if (r.fabricKey === 'frontend') {
      const node = splitLast(r.fromPort).device;
      if (!feRowByNode.has(node)) feRowByNode.set(node, r);
    }
  }
  const asnById = new Map(plan.asns.map((a) => [a.deviceId, a.asn]));
  const switches: IpReview['switches'] = new Map();
  for (const u of units) {
    const d = deviceOfUnit.get(u.id)!;
    switches.set(d, { unitId: u.id, asn: asnById.get(u.id), rail: u.fabricKey === 'scale-out' ? u.rail : undefined, role: `${u.fabricKey} ${u.role}`, net: NET_OF[u.fabricKey] ?? 'backend' });
  }
  const entries: IpReviewEntry[] = [];
  // keys stay unique even when the cable schedule repeats an endpoint name (e.g. several OOB rows from one `node:bmc` port): `#2`, `#3`, …
  const keySeen = new Map<string, number>();
  const typeOf = (device: string): IpReviewDeviceType => (unitByDevice.has(device) ? 'switch' : /:N\d+$/.test(device) ? 'node' : 'endpoint');
  const push = (e: Omit<IpReviewEntry, 'search'>) => {
    const hall = e.hallId ? hallName.get(e.hallId) : undefined;
    const pod = e.pod ? podLabel.get(`${e.hallId}|${e.pod}`) : undefined;
    const hay = [e.device, e.port ? `${e.device}:${e.port}` : '', e.ip, e.gw, e.cidr, e.ipv6, e.ipv6Gw, e.ipv6Subnet, e.ipv6Cidr, e.ipv6A, e.ipv6B, e.a, e.b, e.linkId, e.asn, e.rackTag, e.switchDevice, e.role, hall, pod, e.vlan !== undefined ? `vlan ${e.vlan}` : '']
      .filter((x) => x !== undefined && x !== '').join('\n').toLowerCase();
    const n = (keySeen.get(e.key) ?? 0) + 1;
    keySeen.set(e.key, n);
    entries.push({ ...e, key: n > 1 ? `${e.key}#${n}` : e.key, search: hay });
  };
  const locate = (r: CableScheduleRow | undefined, unit: SwitchUnit | undefined) => {
    const hallId = r?.fromHallId ?? unit?.hallId;
    const rackTag = r ? stripHall(r.fromRack) : unit?.rackTag;
    return { hallId, rackTag, pod: podOf(hallId, rackTag) };
  };
  // host NICs + in-band mgmt
  for (const h of plan.hosts) {
    const r = h.nic === 'mgmt' ? feRowByNode.get(h.nodeId) : rowsByFrom.get(`${h.nodeId}:${h.nic}`);
    const sw = r ? splitLast(r.toPort).device : undefined;
    const unit = sw ? unitByDevice.get(sw) : undefined;
    const [addr, pre] = h.ip.split('/');
    const [addr6, pre6] = h.ipv6?.split('/') ?? [];
    const net: IpReviewNet = h.nic === 'mgmt' ? 'inband' : h.vlan === 30 ? 'frontend' : h.vlan === 40 ? 'storage' : 'backend';
    push({
      key: `h:${h.nodeId}:${h.nic}`, kind: h.nic === 'mgmt' ? 'mgmt' : 'nic', net, deviceType: 'node', device: h.nodeId, port: h.nic, ip: addr, prefix: Number(pre), gw: h.gw,
      ...(addr6 ? { ipv6: addr6, ipv6Prefix: Number(pre6), ipv6Gw: h.ipv6Gw, ipv6Subnet: ipv6Prefix64(addr6) } : {}), vlan: h.vlan,
      ...locate(r, unit), switchDevice: sw, plane: h.plane, rail: net === 'backend' ? h.rail ?? unit?.rail : undefined, subnetKey: memberKey.get(addr),
    });
  }
  // InfiniBand backend NICs (no IP)
  if (isIb) {
    for (const r of rows) {
      if (r.tier !== 'endpoint-leaf' || r.fabricKey !== 'scale-out') continue;
      const sw = splitLast(r.toPort).device;
      const unit = unitByDevice.get(sw);
      if (!unit) continue;
      const { device, port } = splitLast(r.fromPort);
      push({ key: `ib:${r.fromPort}`, kind: 'nic', net: 'backend', deviceType: 'node', device, port, noIp: true, ...locate(r, unit), switchDevice: sw, rail: unit.rail });
    }
  }
  // endpoints whose cable ends on no placed switch (cable schedule `:?` — out of switch ports): listed so the review shows the gap
  for (const r of rows) {
    if (r.tier !== 'endpoint-leaf') continue;
    const sw = splitLast(r.toPort).device;
    if (unitByDevice.has(sw)) continue;
    const { device, port } = splitLast(r.fromPort);
    push({
      key: `u:${r.fromPort}`, kind: r.fabricKey === 'oob' ? 'oob' : 'nic', net: NET_OF[r.fabricKey ?? 'scale-out'] ?? 'backend', deviceType: typeOf(device), device, port, noIp: true, unresolved: true,
      ...locate(r, undefined), switchDevice: sw,
    });
  }
  // OOB ports (BMC, PDU, facility, switch mgmt0)
  for (const o of plan.oob) {
    const r = rowsByFrom.get(o.deviceId);
    const sw = r ? splitLast(r.toPort).device : undefined;
    const { device, port } = splitLast(o.deviceId);
    const [addr, pre] = o.ip.split('/');
    const [addr6, pre6] = o.ipv6?.split('/') ?? [];
    const subnetKey = memberKey.get(addr);
    const gwNum = subnetKey ? subnetByKey.get(subnetKey)!.start + 1 : undefined;
    push({
      key: `o:${o.deviceId}`, kind: 'oob', net: 'oob', deviceType: typeOf(device), device, port, ip: addr, prefix: Number(pre), gw: o.gw ?? (gwNum !== undefined ? ipToString(gwNum) : undefined),
      ...(addr6 ? { ipv6: addr6, ipv6Prefix: Number(pre6), ipv6Gw: o.ipv6Gw, ipv6Subnet: ipv6Prefix64(addr6) } : {}), vlan: 10,
      ...locate(r, sw ? unitByDevice.get(sw) : undefined), switchDevice: sw, subnetKey,
    });
  }
  // switch loopbacks / ASNs
  const unitById = new Map(units.map((u) => [u.id, u]));
  for (const l of plan.loopbacks) {
    const u = unitById.get(l.deviceId);
    const device = deviceOfUnit.get(l.deviceId) ?? l.deviceId;
    const subnetKey = memberKey.get(l.ip);
    const sw = switches.get(device);
    if (sw) {
      sw.loopback = l.ip;
      sw.ipv6Loopback = l.ipv6;
    }
    push({
      key: `lo:${l.deviceId}`, kind: 'loopback', net: NET_OF[u?.fabricKey ?? 'scale-out'] ?? 'backend', deviceType: 'switch', device, ip: l.ip, prefix: 32,
      ...(l.ipv6 ? { ipv6: l.ipv6, ipv6Prefix: 128, ipv6Subnet: ipv6Prefix64(l.ipv6) } : {}), asn: asnById.get(l.deviceId),
      role: subnetKey ? subnetByKey.get(subnetKey)!.label : u ? `${u.fabricKey} ${u.role}` : undefined,
      ...locate(undefined, u), rail: u?.fabricKey === 'scale-out' ? u.rail : undefined, subnetKey,
    });
  }
  // fabric links (A = lower device)
  for (const l of plan.p2p) {
    const r = rowsByCable.get(l.linkId);
    const { device, port } = splitLast(l.a);
    const unit = unitByDevice.get(device);
    const net = NET_OF[r?.fabricKey ?? 'scale-out'] ?? 'backend';
    push({
      key: `l:${l.linkId}`, kind: 'link', net, deviceType: 'link', device, port, linkId: l.linkId, a: l.a, b: l.b, cidr: l.cidr,
      ipv6Cidr: l.ipv6Cidr, ipv6A: l.ipv6A, ipv6B: l.ipv6B, ipv6Subnet: l.ipv6Cidr, unnumbered: l.unnumbered, role: r?.tier,
      ...locate(r, unit), switchDevice: device, rail: net === 'backend' ? unit?.rail : undefined, subnetKey: l.cidr ? memberKey.get(l.linkId) : undefined,
    });
  }
  // free space per subnet (from every entry, independent of filters)
  const usedBySubnet = new Map<string, number[]>();
  for (const e of entries) {
    if (!e.subnetKey) continue;
    const list = usedBySubnet.get(e.subnetKey) ?? [];
    usedBySubnet.set(e.subnetKey, list);
    const a = ipNum(e.ip);
    if (a !== undefined) list.push(a);
    const g = ipNum(e.gw);
    if (g !== undefined) list.push(g);
    if (e.cidr) {
      const c = parseCidr(e.cidr);
      if (c) for (let k = 0; k < c.size; k++) list.push(c.start + k);
    }
  }
  const freeBySubnet = new Map<string, IpReviewFree>();
  for (const s of subnets) {
    const used = new Set(usedBySubnet.get(s.key) ?? []);
    const gatewayNet = s.block === 'oob' || s.block === 'frontend' || s.block === 'storage' || s.block === 'inband';
    const lo = s.start + (gatewayNet && s.size >= 4 ? 1 : 0);
    const hi = s.start + s.size - (gatewayNet && s.size >= 4 ? 1 : 0); // exclusive
    const sorted = [...used].filter((a) => a >= lo && a < hi).sort((a, b) => a - b);
    const ranges: string[] = [];
    let free = 0;
    let rangeCount = 0;
    let cur = lo;
    for (const a of [...sorted, hi]) {
      if (a > cur) {
        free += a - cur;
        rangeCount++;
        if (ranges.length < 6) ranges.push(a - cur === 1 ? ipToString(cur) : rangeLabel(cur, a - cur));
      }
      cur = Math.max(cur, a + 1);
    }
    freeBySubnet.set(s.key, { free, ranges, rangeCount });
  }
  const halls = project.halls.map((h, i) => ({ id: h.id, name: h.name, index: i }));
  const podsSeen = new Map<string, { hallId: string; id: string; label: string }>();
  const racksSeen = new Map<string, { hallId: string; pod: string; tag: string }>();
  const railSet = new Set<number>();
  const hallSet = new Set<string>();
  for (const e of entries) {
    if (e.hallId) hallSet.add(e.hallId);
    if (e.hallId && e.pod && !podsSeen.has(`${e.hallId}|${e.pod}`)) podsSeen.set(`${e.hallId}|${e.pod}`, { hallId: e.hallId, id: e.pod, label: podLabel.get(`${e.hallId}|${e.pod}`) ?? e.pod });
    if (e.hallId && e.rackTag && !racksSeen.has(`${e.hallId}|${e.rackTag}`)) racksSeen.set(`${e.hallId}|${e.rackTag}`, { hallId: e.hallId, pod: e.pod ?? 'unassigned', tag: e.rackTag });
    if (e.rail !== undefined) railSet.add(e.rail);
  }
  const nat = (a: string, b: string) => COLLATOR.compare(a, b);
  return {
    plan, subnets, subnetByKey, layout, map, entries, halls,
    pods: [...podsSeen.values()].sort((a, b) => (hallIdx.get(a.hallId) ?? 0) - (hallIdx.get(b.hallId) ?? 0) || nat(a.label, b.label) || nat(a.id, b.id)),
    racks: [...racksSeen.values()].sort((a, b) => (hallIdx.get(a.hallId) ?? 0) - (hallIdx.get(b.hallId) ?? 0) || nat(a.tag, b.tag)),
    rails: [...railSet].sort((a, b) => a - b),
    switches, freeBySubnet, multiHall: hallSet.size > 1, isIb, ...(locale ? { locale } : {}),
  };
}

const COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ── filters / search ──

export interface IpReviewFilter {
  hallId?: string;
  pod?: string;
  rackTag?: string;
  net?: IpReviewNet;
  rail?: number;
  deviceType?: IpReviewDeviceType;
  /** IPv4 (exact; else the subnet holding it), CIDR (addresses inside), or text: device / NIC / host / rack / switch / link / ASN */
  query?: string;
}

const entryRange = (e: IpReviewEntry, review?: IpReview): { start: number; size: number } | undefined => {
  if (e.cidr) return parseCidr(e.cidr);
  const a = ipNum(e.ip);
  return a !== undefined ? { start: a, size: 1 } : undefined;
};
const overlaps = (a: { start: number; size: number }, b: { start: number; size: number }) => a.start < b.start + b.size && b.start < a.start + a.size;
const overlaps6 = (a: Ipv6Range, b: Ipv6Range) => a.start < b.start + b.size && b.start < a.start + a.size;
const entryRange6 = (e: IpReviewEntry): Ipv6Range | undefined => e.ipv6Cidr ? parseIpv6Cidr(e.ipv6Cidr) : e.ipv6 ? parseIpv6Cidr(`${e.ipv6}/${e.ipv6Prefix ?? 128}`) : undefined;

/** Entries passing the filters, in input order. */
export function filterIpReview(review: IpReview, f: IpReviewFilter, entries: IpReviewEntry[] = review.entries): IpReviewEntry[] {
  const base = entries.filter((e) => (!f.hallId || e.hallId === f.hallId) && (!f.pod || e.pod === f.pod) && (!f.rackTag || e.rackTag === f.rackTag)
    && (!f.net || e.net === f.net) && (f.rail === undefined || e.rail === f.rail) && (!f.deviceType || e.deviceType === f.deviceType));
  const q = (f.query ?? '').trim();
  if (!q) return base;
  const ipq = IPV4.test(q) || /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(q) ? parseCidr(q) : undefined;
  if (ipq) {
    if (q.includes('/')) return base.filter((e) => { const r = entryRange(e); return !!r && overlaps(r, ipq); });
    const exact = base.filter((e) => e.ip === q || e.gw === q || (e.cidr && overlaps(parseCidr(e.cidr)!, ipq)));
    if (exact.length) return exact;
    return base.filter((e) => { const s = e.subnetKey ? review.subnetByKey.get(e.subnetKey) : undefined; return !!s && overlaps(s, ipq); });
  }
  const ip6q = q.includes(':') ? parseIpv6Cidr(q) : undefined;
  if (ip6q) {
    if (q.includes('/')) return base.filter((e) => { const r = entryRange6(e); return !!r && overlaps6(r, ip6q); });
    const exact = base.filter((e) => {
      for (const value of [e.ipv6, e.ipv6Gw, e.ipv6A, e.ipv6B]) {
        const r = parseIpv6Cidr(value);
        if (r?.start === ip6q.start) return true;
      }
      const link = parseIpv6Cidr(e.ipv6Cidr);
      return !!link && overlaps6(link, ip6q);
    });
    if (exact.length) return exact;
    return base.filter((e) => { const s = parseIpv6Cidr(e.ipv6Subnet); return !!s && overlaps6(s, ip6q); });
  }
  const needle = q.toLowerCase();
  return base.filter((e) => e.search.includes(needle));
}

// ── grouping ──

export type IpReviewGroupKind = 'root' | 'hall' | 'pod' | 'rack' | 'device' | 'net' | 'rail' | 'switch' | 'links' | 'tier' | 'block' | 'subnet' | 'none';

export interface IpReviewGroup {
  id: string;
  kind: IpReviewGroupKind;
  /** English label (the web translates by `kind` + `code`) */
  label: string;
  /** stable code for translation: net name, 'rail', 'no-rail', 'uplinks', link tier, 'ib', 'unnumbered', … */
  code?: string;
  children: IpReviewGroup[];
  /** entries directly in this group (leaf groups) */
  entries: IpReviewEntry[];
  /** entries below (Σ own + children) */
  total: number;
  nics: number;
  links: number;
  loopbacks: number;
  /** entries carrying an IPv4 address or a numbered /31 */
  addresses: number;
  /** distinct devices below by type */
  nodes: number;
  switches: number;
  endpoints: number;
  /** distinct subnet keys below, in address order */
  subnetKeys: string[];
  gateways: string[];
  /** Distinct IPv6 /64s (or /127 link prefixes) below; IPv6 capacity is intentionally not reduced to a raw utilisation %. */
  ipv6Prefixes: string[];
  ipv6Gateways: string[];
  vlans: number[];
  /** Σ used / Σ size over the distinct subnets below (a block group: over the block) */
  used: number;
  size: number;
  utilisation: number;
  hallId?: string;
  pod?: string;
  rackTag?: string;
  rail?: number;
  device?: string;
  deviceType?: IpReviewDeviceType;
  loopback?: string;
  ipv6Loopback?: string;
  asn?: number;
  cidr?: string;
  purpose?: string;
  free?: IpReviewFree;
}

interface Level {
  id: string;
  kind: IpReviewGroupKind;
  label: string;
  code?: string;
  /** sort class among siblings (lower first), then `order` — e.g. link groups (1) after switches and rails (0) */
  rank?: number;
  order: number | string;
  extra?: Partial<IpReviewGroup>;
}

function emptyGroup(l: Omit<Level, 'order'>): IpReviewGroup {
  return {
    id: l.id, kind: l.kind, label: l.label, ...(l.code ? { code: l.code } : {}), children: [], entries: [], total: 0, nics: 0, links: 0, loopbacks: 0, addresses: 0,
    nodes: 0, switches: 0, endpoints: 0, subnetKeys: [], gateways: [], ipv6Prefixes: [], ipv6Gateways: [], vlans: [], used: 0, size: 0, utilisation: 0, ...(l.extra ?? {}),
  };
}

const entryAddr = (e: IpReviewEntry) => ipNum(e.ip) ?? (e.cidr ? ipNum(e.cidr) : undefined);
/** address order, then natural key order. `addr` holds each entry's parsed address: parsing inside the comparator cost ~0.5 s per
 *  grouping on a 224k-entry (6-hall Spectrum-X) project (QA ipmap review v2 2차). */
const entryOrder = (addr: Map<IpReviewEntry, number | undefined>) => (a: IpReviewEntry, b: IpReviewEntry) => {
  const x = addr.get(a);
  const y = addr.get(b);
  if (x !== undefined && y !== undefined && x !== y) return x - y;
  if (x !== undefined && y === undefined) return -1;
  if (x === undefined && y !== undefined) return 1;
  return COLLATOR.compare(a.key, b.key);
};

function buildTree(review: IpReview, rootLabel: string, entries: IpReviewEntry[], path: (e: IpReviewEntry) => Level[]): IpReviewGroup {
  const root = emptyGroup({ id: 'root', kind: 'root', label: rootLabel });
  const order = entryOrder(new Map(entries.map((e) => [e, entryAddr(e)])));
  const index = new Map<string, { g: IpReviewGroup; order: number | string; rank: number; kids: Map<string, { g: IpReviewGroup; order: number | string }> }>();
  const rootNode = { g: root, order: 0, kids: new Map() };
  for (const e of entries) {
    let cur: { g: IpReviewGroup; kids: Map<string, { g: IpReviewGroup; order: number | string }> } = rootNode;
    for (const l of path(e)) {
      let n = index.get(l.id);
      if (!n) {
        n = { g: emptyGroup(l), order: l.order, rank: l.rank ?? 0, kids: new Map() };
        index.set(l.id, n);
        cur.kids.set(l.id, n);
        cur.g.children.push(n.g);
      }
      cur = n;
    }
    cur.g.entries.push(e);
  }
  const orderOf = new Map<IpReviewGroup, number | string>([...index.values()].map((n) => [n.g, n.order]));
  const rankOf = new Map<IpReviewGroup, number>([...index.values()].map((n) => [n.g, n.rank]));
  const finish = (g: IpReviewGroup): IpReviewEntry[] => {
    g.children.sort((a, b) => {
      const ra = rankOf.get(a) ?? 0, rb = rankOf.get(b) ?? 0;
      if (ra !== rb) return ra - rb;
      const x = orderOf.get(a)!, y = orderOf.get(b)!;
      if (typeof x === 'number' && typeof y === 'number') return x - y || COLLATOR.compare(a.label, b.label);
      return COLLATOR.compare(String(x), String(y));
    });
    g.entries.sort(order);
    const all: IpReviewEntry[] = [...g.entries];
    for (const c of g.children) for (const e of finish(c)) all.push(e);
    const nodes = new Set<string>(), sws = new Set<string>(), eps = new Set<string>(), subnets = new Set<string>(), gws = new Set<string>(), v6s = new Set<string>(), v6gws = new Set<string>(), vlans = new Set<number>();
    for (const e of all) {
      if (e.kind === 'nic' || e.kind === 'mgmt' || e.kind === 'oob') g.nics++;
      else if (e.kind === 'link') g.links++;
      else g.loopbacks++;
      if (e.ip || (e.cidr && !e.unnumbered)) g.addresses++;
      if (e.deviceType === 'node') nodes.add(e.device);
      else if (e.deviceType === 'endpoint') eps.add(e.device);
      else sws.add(e.device);
      if (e.subnetKey) subnets.add(e.subnetKey);
      if (e.gw) gws.add(e.gw);
      if (e.ipv6Subnet) v6s.add(e.ipv6Subnet);
      if (e.ipv6Gw) v6gws.add(e.ipv6Gw);
      if (e.vlan !== undefined) vlans.add(e.vlan);
    }
    g.total = all.length;
    g.nodes = nodes.size;
    g.switches = sws.size;
    g.endpoints = eps.size;
    const recs = [...subnets].map((k) => review.subnetByKey.get(k)!).filter(Boolean).sort((a, b) => a.start - b.start);
    g.subnetKeys = recs.map((r) => r.key);
    g.gateways = [...gws].sort((a, b) => (ipNum(a) ?? 0) - (ipNum(b) ?? 0));
    g.ipv6Prefixes = [...v6s].sort(COLLATOR.compare);
    g.ipv6Gateways = [...v6gws].sort(COLLATOR.compare);
    g.vlans = [...vlans].sort((a, b) => a - b);
    if (g.kind === 'block' && g.size > 0) g.used = recs.reduce((a, r) => a + r.used, 0);
    else if (g.kind === 'subnet' && g.size > 0) { /* used / size preset from the record */ }
    else {
      g.used = recs.reduce((a, r) => a + r.used, 0);
      g.size = recs.reduce((a, r) => a + r.size, 0);
    }
    g.utilisation = g.size ? g.used / g.size : 0;
    return all;
  };
  finish(root);
  return root;
}

const hallLevel = (review: IpReview, e: IpReviewEntry, prefix: string): Level => {
  const h = review.halls.find((x) => x.id === e.hallId);
  return { id: `${prefix}h:${e.hallId ?? '-'}`, kind: 'hall', label: h?.name ?? e.hallId ?? '—', order: h?.index ?? 999, extra: { hallId: e.hallId } };
};
const shortDevice = (d: string) => d.replace(/^H\d+\./, '');
const TIER_ORDER: Record<string, number> = { 'endpoint-leaf': 0, 'leaf-spine': 1, 'spine-core': 2, uplink: 3, 'inter-hall': 4 };
export const IP_REVIEW_NETS: IpReviewNet[] = ['backend', 'frontend', 'storage', 'inband', 'oob'];

const deviceExtra = (review: IpReview, device: string, deviceType: IpReviewDeviceType): Partial<IpReviewGroup> => {
  const sw = review.switches.get(device);
  return { device, deviceType: sw ? 'switch' : deviceType === 'link' ? 'switch' : deviceType, ...(sw ? { loopback: sw.loopback, ipv6Loopback: sw.ipv6Loopback, asn: sw.asn, rail: sw.rail } : {}) };
};

/** hall → DU / pod → rack → device → addresses. */
export function groupIpPlanByLocation(review: IpReview, entries: IpReviewEntry[] = review.entries): IpReviewGroup {
  return buildTree(review, 'location', entries, (e) => {
    const pod = review.pods.find((p) => p.hallId === e.hallId && p.id === e.pod);
    return [
      hallLevel(review, e, ''),
      { id: `p:${e.hallId}|${e.pod}`, kind: 'pod', label: pod?.label ?? e.pod ?? '—', code: e.pod === 'unassigned' ? 'unassigned' : undefined, order: e.pod === 'unassigned' ? '￿' : `${pod?.label ?? ''}|${e.pod}`, extra: { hallId: e.hallId, pod: e.pod } },
      { id: `r:${e.hallId}|${e.rackTag}`, kind: 'rack', label: e.rackTag ?? '—', order: e.rackTag ?? '', extra: { hallId: e.hallId, pod: e.pod, rackTag: e.rackTag } },
      { id: `d:${e.hallId}|${e.device}`, kind: 'device', label: shortDevice(e.device), order: e.device, extra: { hallId: e.hallId, rackTag: e.rackTag, ...deviceExtra(review, e.device, e.deviceType) } },
    ];
  });
}

/** network → [hall] → rail → leaf → NICs · uplinks per rail · other fabrics → access switch → addresses · links per tier · loopbacks / ASNs per tier. */
export function groupIpPlanByRail(review: IpReview, entries: IpReviewEntry[] = review.entries): IpReviewGroup {
  const S = ipPlanStrings(review.locale);
  const tierLabel = (r: string | undefined) => S.tiers[r ?? ''] ?? r;
  return buildTree(review, 'rail', entries, (e) => {
    const section = e.kind === 'loopback' ? 'loopbacks' : e.net;
    const out: Level[] = [{ id: `n:${section}`, kind: 'net', label: S.nets[section], code: section, order: section === 'loopbacks' ? 9 : IP_REVIEW_NETS.indexOf(e.net) }];
    const hp = `n:${section}|`;
    if (review.multiHall) out.push(hallLevel(review, e, hp));
    const hk = `${hp}${e.hallId}`;
    const railed = e.net === 'backend' && review.rails.length > 0;
    if (e.kind === 'loopback') {
      out.push({ id: `${hk}|t:${e.role}`, kind: 'tier', label: e.role ?? '—', code: e.role, order: e.subnetKey ? review.subnetByKey.get(e.subnetKey)!.start : 1e12 });
      return out;
    }
    if (e.kind === 'link') {
      if (railed && e.rail !== undefined) {
        out.push({ id: `${hk}|rail:${e.rail}`, kind: 'rail', label: S.rail(e.rail), code: 'rail', order: e.rail, extra: { rail: e.rail } });
        out.push({ id: `${hk}|rail:${e.rail}|up:${e.role}`, kind: 'links', label: S.uplinks(tierLabel(e.role) ?? ''), code: e.role, rank: 1, order: TIER_ORDER[e.role ?? ''] ?? 9 });
      } else out.push({ id: `${hk}|links:${e.role}`, kind: 'links', label: S.fabricLinks(tierLabel(e.role) ?? ''), code: e.role, rank: 1, order: TIER_ORDER[e.role ?? ''] ?? 9 });
      return out;
    }
    if (railed) {
      out.push(e.rail !== undefined
        ? { id: `${hk}|rail:${e.rail}`, kind: 'rail', label: S.rail(e.rail), code: 'rail', order: e.rail, extra: { rail: e.rail } }
        : { id: `${hk}|rail:none`, kind: 'rail', label: S.noRail, code: 'no-rail', order: 1e6 });
    }
    const sw = e.switchDevice ?? '—';
    out.push({ id: `${hk}|${e.net}|sw:${sw}`, kind: 'switch', label: shortDevice(sw), order: sw, extra: { hallId: e.hallId, ...deviceExtra(review, sw, 'switch') } });
    return out;
  });
}

/** block → hall → subnet → members (free space on the subnet group) · InfiniBand NICs without IP · unnumbered links. */
export function groupIpPlanBySubnet(review: IpReview, entries: IpReviewEntry[] = review.entries): IpReviewGroup {
  const blockOf = new Map(review.map.root.children.map((b) => [b.label, b]));
  return buildTree(review, 'subnet', entries, (e) => {
    const s = e.subnetKey ? review.subnetByKey.get(e.subnetKey) : undefined;
    if (!s) {
      const code = e.unresolved ? 'unresolved' : e.noIp ? 'ib' : e.unnumbered ? 'unnumbered' : 'none';
      const label = ipPlanStrings(review.locale).unaddressed[code];
      return [
        { id: `x:${code}`, kind: 'none', label, code, order: 1e12 + ['unresolved', 'ib', 'unnumbered', 'none'].indexOf(code) },
        { id: `x:${code}|${e.net}`, kind: 'net', label: ipPlanStrings(review.locale).nets[e.net], code: e.net, order: IP_REVIEW_NETS.indexOf(e.net) },
      ];
    }
    const b = blockOf.get(s.block);
    const out: Level[] = [{ id: `b:${s.block}`, kind: 'block', label: s.block, code: s.block, order: b?.start ?? s.start, extra: { cidr: b?.cidr, purpose: b?.purpose, size: b?.size ?? 0 } }];
    if (s.hall !== undefined) {
      const hn = b?.children.find((c) => c.kind === 'hall' && c.hallId === s.hallId);
      out.push({ id: `b:${s.block}|h:${s.hall}`, kind: 'hall', label: review.halls.find((h) => h.id === s.hallId)?.name ?? `H${s.hall + 1}`, order: s.hall, extra: { hallId: s.hallId, cidr: hn?.cidr } });
    }
    out.push({
      id: `s:${s.key}`, kind: 'subnet', label: s.label, order: s.start,
      extra: { cidr: prefixOf(s.start, s.size) ?? rangeLabel(s.start, s.size), used: s.used, size: s.size, free: review.freeBySubnet.get(s.key), hallId: s.hallId, rackTag: s.rackTag, device: s.label },
    });
    return out;
  });
}

/** All entries below a group in tree order (own entries first, then children). */
export function ipReviewGroupEntries(g: IpReviewGroup, out: IpReviewEntry[] = []): IpReviewEntry[] {
  for (const e of g.entries) out.push(e);
  for (const c of g.children) ipReviewGroupEntries(c, out);
  return out;
}

export const IP_REVIEW_CSV_COLUMNS = ['hall', 'du', 'rack', 'device', 'device_type', 'port', 'network', 'kind', 'plane', 'rail', 'switch', 'ipv4', 'ipv4_prefix', 'ipv4_gateway', 'ipv4_cidr', 'ipv4_subnet', 'ipv6', 'ipv6_prefix', 'ipv6_gateway', 'ipv6_cidr', 'ipv6_subnet', 'vlan', 'asn', 'link_id', 'a', 'b', 'unnumbered', 'subnet_label', 'role'];

/** CSV (BOM + CRLF, fixed columns) of review entries in the given order. */
export function ipReviewCsv(review: IpReview, entries: IpReviewEntry[]): string {
  const hallName = new Map(review.halls.map((h) => [h.id, h.name]));
  const podLabel = new Map(review.pods.map((p) => [`${p.hallId}|${p.id}`, p.label]));
  return csvFile(entries.map((e) => {
    const s = e.subnetKey ? review.subnetByKey.get(e.subnetKey) : undefined;
    return {
      hall: e.hallId ? hallName.get(e.hallId) ?? e.hallId : '', du: podLabel.get(`${e.hallId}|${e.pod}`) ?? e.pod, rack: e.rackTag, device: e.device, device_type: e.deviceType, port: e.port, network: e.net, kind: e.kind,
      plane: e.plane,
      rail: e.rail, switch: e.switchDevice, ipv4: e.ip, ipv4_prefix: e.prefix, ipv4_gateway: e.gw, ipv4_cidr: e.cidr,
      ipv4_subnet: s ? prefixOf(s.start, s.size) ?? rangeLabel(s.start, s.size) : e.unresolved ? ipPlanStrings(review.locale).csvNotAddressed : e.noIp ? ipPlanStrings(review.locale).csvIb : '',
      ipv6: e.ipv6, ipv6_prefix: e.ipv6Prefix, ipv6_gateway: e.ipv6Gw, ipv6_cidr: e.ipv6Cidr, ipv6_subnet: e.ipv6Subnet,
      vlan: e.vlan, asn: e.asn, link_id: e.linkId, a: e.a, b: e.b,
      unnumbered: e.kind === 'link' ? e.unnumbered : undefined, subnet_label: s?.label, role: e.role,
    };
  }), IP_REVIEW_CSV_COLUMNS);
}
