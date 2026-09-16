// Port-level cable schedule (stream T2 data; T7 formats it as HTML + CSV). DECISIONS-v2-2 §B, F5; docs/research/r2-ops.md §1.
//
// One row per physical cable, expanded from the analysis cable runs (bundles) — Σ rows = Σ CableRun.count, always.
//
// Deterministic numbering (same project → same schedule):
//   switch units   every rack's switches (analysis.network.rackLoads) are stacked from the top of the rack in the order the rack-plan
//                  deliverable uses (deploy/rackplan.ts umapFor: role name, then catalog id); a unit's U is the lowest RU it occupies.
//   switch ports   downlinks P1…Pd first, uplinks P(d+1)…P(d+u) (tier counts from analysis.network.fabrics); when the link is slower
//                  than the switch port (breakout) lanes are numbered P12/1, P12/2. Units of one role in a rack fill in U order.
//   node NICs      endpoint racks are split into nodes (compute.nodesPerRack; NVL72 compute trays at their public-spec U positions,
//                  catalog meta.umap node entries for composed racks, top-down HGX servers otherwise); NIC names per network:
//                  be<i> scale-out, fe<i> front-end, st<i> storage, bmc / oob<i> management; network racks give each switch's mgmt0.
//   runs           processed in tier order (endpoint-leaf, leaf-spine, spine-core, uplink, inter-hall), then fabric, source tag,
//                  destination tag, cable type.
// Identifiers (r2-ops.md §1.3; "TIA-606 format reference" only — the standard text was not checked, no compliance is claimed):
//   rack  H<hall#>.<rack tag>          device  <rack>-U<u>          port  <device>:P<n>[/<lane>] | <device>:<nic>
//   cable <net>-H<hall#>-<seq6>        net = BE (IB for InfiniBand) · FE · ST · OOB · SS (inter-hall super-spine trunk)
//   seq   numbered per (net, hall) in (source rack, source U, source port) order; BSN = index of the (source rack, destination rack,
//         cable type, length) bundle in the same order (NVIDIA DU-10438 §5.2.3 / §6.4.2: labels carry source, destination, port,
//         cable type / length and the BSN; identical text at both ends, near end first).
import { rackSlotMap, rackTotalU, slotMapNodeU, type RackSlotMap } from '../layout/rackContents.ts';
import { cableTypes, findCatalogItem } from '../catalog/catalog.ts';
import type { CableRun, CableScheduleRow, CatalogItem, EquipmentInstance, FabricAnalysis, NetworkRackLoad, Project, ProjectAnalysis } from '../model/types.ts';

export type FabricKey = 'scale-out' | 'frontend' | 'storage' | 'oob';

/** A physical switch at a U position inside a rack (derived from rackLoads). */
export interface SwitchUnit {
  id: string;
  rackId: string;
  rackTag: string;
  hallId: string;
  fabric: string;
  fabricKey: FabricKey;
  role: 'leaf' | 'spine' | 'core';
  /** super-spine of a joined (multi-hall) cluster */
  interHall: boolean;
  catalogId: string;
  /** lowest RU occupied */
  u: number;
  ports: number;
  portGbps: number;
  downlinks: number;
  uplinks: number;
  podId?: string;
  clusterId?: string;
  /** index within (hall, fabricKey, role) in rack-tag / U order — the loopback / ASN / hostname index */
  index: number;
  /** rail-optimized scale-out leaf: rail served (leaf i of its pod in rack-tag / U order → i mod rails) */
  rail?: number;
  rails?: number;
}

const PREFIX_KEY: Record<string, FabricKey> = { 'Scale-out': 'scale-out', 'Front-end': 'frontend', Storage: 'storage', OOB: 'oob' };
const RUN_KEY = /^cr-(scale-out|frontend|storage|oob)-/;
const TIER_ORDER: Record<string, number> = { 'endpoint-leaf': 0, 'leaf-spine': 1, 'spine-core': 2, uplink: 3, 'inter-hall': 4 };

export const fabricKeyOfRun = (r: CableRun): FabricKey => ((r as CableRun & { fabricKey?: FabricKey }).fabricKey ?? (RUN_KEY.exec(r.id)?.[1] as FabricKey | undefined) ?? 'scale-out');

/** `Scale-out · <label>` → { key, label } */
export function splitFabricName(name: string): { key: FabricKey; label: string } {
  const i = name.indexOf(' · ');
  const prefix = i >= 0 ? name.slice(0, i) : name;
  return { key: PREFIX_KEY[prefix] ?? 'scale-out', label: i >= 0 ? name.slice(i + 3) : name };
}

function fabricFor(analysis: ProjectAnalysis, key: FabricKey, label: string): FabricAnalysis | undefined {
  return analysis.network.fabrics.find((f) => {
    const s = splitFabricName(f.name);
    return s.key === key && s.label === label;
  });
}

const hallCode = (project: Project, hallId: string) => `H${Math.max(0, project.halls.findIndex((h) => h.id === hallId)) + 1}`;

/** Every switch unit with its U position and port split, in rack-tag order. */
export function buildSwitchUnits(project: Project, analysis: ProjectAnalysis): SwitchUnit[] {
  const eq = new Map(project.equipment.map((e) => [e.id, e]));
  const loads = [...(analysis.network.rackLoads ?? [])].filter((l) => l.switches.length > 0 && eq.has(l.rackId));
  loads.sort((a, b) => eq.get(a.rackId)!.tag.localeCompare(eq.get(b.rackId)!.tag) || a.rackId.localeCompare(b.rackId));
  const units: SwitchUnit[] = [];
  const counters = new Map<string, number>();
  for (const load of loads) {
    const rack = eq.get(load.rackId)!;
    const rackItem = findCatalogItem(rack.catalogId);
    const isNetworkRack = rackItem?.category === 'network-rack';
    // same stacking order as deploy/rackplan.ts umapFor (network racks: role name, then catalog id; stable for ties)
    const sws = isNetworkRack ? [...load.switches].sort((a, b) => (a.role > b.role ? 1 : a.role < b.role ? -1 : a.catalogId.localeCompare(b.catalogId))) : load.switches;
    let top = rackTotalU(rackItem, load.ruCapacity);
    for (const sw of sws) {
      const item = findCatalogItem(sw.catalogId);
      const ru = item?.switch?.rackUnits ?? 1;
      const ext = sw as NetworkRackLoad['switches'][number] & { fabricKey?: FabricKey; interHall?: boolean; clusterId?: string };
      const key: FabricKey = ext.fabricKey ?? (analysis.network.fabrics.map((f) => splitFabricName(f.name)).find((s) => s.label === sw.fabric)?.key ?? 'scale-out');
      const fab = fabricFor(analysis, key, sw.fabric);
      const ports = item?.switch?.ports ?? fab?.tiers[0]?.portsPerSwitch ?? 64;
      let downlinks = ports;
      let uplinks = 0;
      const railsOf = sw.role === 'leaf' && key === 'scale-out' && fab?.rails && fab.rails > 1 && rackItem?.category !== 'gpu-rack' ? fab.rails : undefined;
      if (fab) {
        const leafT = fab.tiers[0];
        const upperT = fab.tiers.slice(1);
        if (sw.role === 'leaf' && leafT) {
          downlinks = leafT.downlinks;
          uplinks = leafT.uplinks;
        } else if (sw.role === 'spine' && upperT[0]) {
          downlinks = upperT[0].downlinks;
          uplinks = upperT[0].uplinks;
        } else if (sw.role === 'core') {
          const t = ext.interHall ? upperT.find((x) => /super/i.test(x.name)) : upperT.find((x) => /core/i.test(x.name));
          downlinks = t?.downlinks ?? ports;
          uplinks = t?.uplinks ?? 0;
        }
      }
      // fix v2 2차 (QA OOB): a management leaf's uplinks are its dedicated uplink ports (SN2201: 4 × 100G), not the tier's split
      if (key === 'oob' && sw.role === 'leaf') uplinks = item?.switch?.uplinkPorts ?? (uplinks > 0 ? uplinks : 4);
      for (let i = 0; i < sw.count; i++) {
        const u = Math.max(1, top - ru + 1);
        top = u - 1;
        const ck = `${rack.hallId}|${key}|${sw.role}|${ext.interHall ? 'ih' : ''}`;
        const index = counters.get(ck) ?? 0;
        counters.set(ck, index + 1);
        units.push({
          id: `${rack.id}-U${u}`,
          rackId: rack.id,
          rackTag: rack.tag,
          hallId: rack.hallId,
          fabric: sw.fabric,
          fabricKey: key,
          role: sw.role,
          interHall: !!ext.interHall,
          catalogId: sw.catalogId,
          u,
          ports,
          portGbps: item?.switch?.portGbps ?? 400,
          downlinks,
          uplinks,
          podId: sw.podId,
          clusterId: ext.clusterId,
          index,
          ...(railsOf ? { rails: railsOf } : {}),
        });
      }
    }
  }
  // rails: position of each rail-aligned leaf within its (hall, cluster, pod) in the order above — mirrors engines/network.ts
  const railPos = new Map<string, number>();
  for (const u of units) {
    if (!u.rails) continue;
    const k = `${u.hallId}|${u.clusterId ?? ''}|${u.fabric}|${u.podId ?? ''}`;
    const i = railPos.get(k) ?? 0;
    railPos.set(k, i + 1);
    u.rail = i % u.rails;
  }
  return units;
}

/** Lowest RU of node `i` in an endpoint rack (undefined when the rack model has no known elevation). Area D2: a view over the
 *  shared resolver layout/rackContents.ts rackSlotMap (NVL72 = vendor user-guide tray order), so drawings, rack plan and cable schedule agree. */
const nodeMapCache = new WeakMap<CatalogItem, RackSlotMap>();
export function nodeU(item: CatalogItem, i: number): number | undefined {
  if (item.category !== 'gpu-rack' && !Array.isArray(item.meta?.umap)) return undefined;
  if (!item.compute && !Array.isArray(item.meta?.umap)) return undefined;
  let map = nodeMapCache.get(item);
  if (!map) {
    map = rackSlotMap(item, undefined, findCatalogItem);
    nodeMapCache.set(item, map);
  }
  return slotMapNodeU(map, i);
}

interface PortCursor {
  down: number;
  up: number;
}

const portCap = (u: SwitchUnit, side: 'down' | 'up') => (side === 'down' ? u.downlinks : u.uplinks);

/** Build the per-cable schedule; rows are sorted by (net, hall, source rack, source U, source port). */
export function buildCableSchedule(project: Project, analysis: ProjectAnalysis): CableScheduleRow[] {
  const eq = new Map(project.equipment.map((e) => [e.id, e]));
  const units = buildSwitchUnits(project, analysis);
  const unitsByRack = new Map<string, SwitchUnit[]>();
  for (const u of units) {
    const arr = unitsByRack.get(u.rackId) ?? [];
    arr.push(u);
    unitsByRack.set(u.rackId, arr);
  }
  // fill order inside a rack: top unit first
  for (const arr of unitsByRack.values()) arr.sort((a, b) => b.u - a.u);
  const cursors = new Map<string, PortCursor>();
  const cursor = (u: SwitchUnit) => {
    let c = cursors.get(u.id);
    if (!c) cursors.set(u.id, (c = { down: 0, up: 0 }));
    return c;
  };
  // breakout port being filled per unit side (lanes of one link speed); a port is never shared by a whole-port link and breakout
  // lanes (integration v2 2차: FE spines carried FE leaf uplinks on P17… and OOB 4 × 100G uplink lanes on the same P17/1…)
  const openPort = new Map<string, { port: number; lanes: number; next: number }>();
  const cableName = new Map(cableTypes().map((t) => [t.id, t]));
  const isIb = project.network.scaleOut.fabric.startsWith('ib-');

  const pick = (rackId: string, key: FabricKey, roles: ('leaf' | 'spine' | 'core')[], interHall?: boolean) => {
    const list = unitsByRack.get(rackId) ?? [];
    for (const role of roles) {
      const hit = list.filter((u) => u.fabricKey === key && u.role === role && (interHall === undefined || u.interHall === interHall));
      if (hit.length) return hit;
    }
    return [];
  };

  const lanesFor = (u: SwitchUnit, linkGbps: number) => (linkGbps > 0 && linkGbps < u.portGbps ? Math.max(1, Math.round(u.portGbps / linkGbps)) : 1);
  /** true when `u` can take one more link on `side` (a partly filled breakout port of the same lane count, or a free port) */
  const hasRoom = (u: SwitchUnit, side: 'down' | 'up', linkGbps: number) => {
    const lanes = lanesFor(u, linkGbps);
    if (lanes > 1 && openPort.has(`${u.id}|${side}|${lanes}`)) return true;
    const c = cursor(u);
    return (side === 'down' ? c.down : c.up) < portCap(u, side);
  };
  /** next port of `u` on `side`; never numbers past the side's range (fix v2 2차, QA B3) — callers check hasRoom first */
  const takeOn = (u: SwitchUnit, side: 'down' | 'up', linkGbps: number): string => {
    const lanes = lanesFor(u, linkGbps);
    const c = cursor(u);
    const ok = `${u.id}|${side}|${lanes}`;
    const open = lanes > 1 ? openPort.get(ok) : undefined;
    let index: number;
    let lane = 1;
    if (open) {
      index = open.port;
      lane = open.next++;
      if (open.next > lanes) openPort.delete(ok);
    } else {
      index = side === 'down' ? c.down : c.up;
      if (side === 'down') c.down++;
      else c.up++;
      if (lanes > 1) openPort.set(ok, { port: index, lanes, next: 2 });
    }
    const p = index + 1 + (side === 'up' ? u.downlinks : 0);
    // management (OOB) switches carry dedicated uplink ports beyond the access radix (e.g. 48 × 1G + 4 × 100G) → UP1, UP2 …
    const name = side === 'up' && u.fabricKey === 'oob' && p > u.ports ? `UP${p - u.ports}` : `P${p}`;
    return lanes > 1 ? `${name}/${lane}` : name;
  };
  const end = (u: SwitchUnit | undefined, port: string) => ({ u: u?.u, port: u ? `U${u.u}:${port}` : '?' });

  // switch ↔ switch striping (fix v2 2차, QA B1): cable j of a run goes to lower unit F[j mod n_f] (skipping full units) and to the
  // upper unit with the fewest links from that lower unit so far (ties: fewest used ports, then rack order) — a Clos, not a fill
  const pairCount = new Map<string, number>();
  const stripe = (lower: SwitchUnit[], upper: SwitchUnit[], gbps: number, j: number): [{ u?: number; port: string }, { u?: number; port: string }] => {
    // lower: most free uplink ports first (a unit that took a rounding remainder in an earlier bundle yields to the others, so no
    // unit fills up before the last upper rack), ties in round-robin order from j
    let lo: SwitchUnit | undefined;
    let loRoom = -1;
    for (let t = 0; t < lower.length; t++) {
      const cand = lower[(j + t) % lower.length];
      if (!hasRoom(cand, 'up', gbps)) continue;
      const room = cand.uplinks - cursor(cand).up;
      if (room > loRoom) {
        lo = cand;
        loRoom = room;
      }
    }
    let hi: SwitchUnit | undefined;
    let best = Infinity;
    let bestUsed = Infinity;
    for (const cand of upper) {
      if (!hasRoom(cand, 'down', gbps)) continue;
      const pc = lo ? pairCount.get(`${lo.id}|${cand.id}`) ?? 0 : 0;
      const used = cursor(cand).down;
      if (pc < best || (pc === best && used < bestUsed)) {
        hi = cand;
        best = pc;
        bestUsed = used;
      }
    }
    if (lo && hi) pairCount.set(`${lo.id}|${hi.id}`, (pairCount.get(`${lo.id}|${hi.id}`) ?? 0) + 1);
    return [end(lo, lo ? takeOn(lo, 'up', gbps) : '?'), end(hi, hi ? takeOn(hi, 'down', gbps) : '?')];
  };

  interface NicLayout {
    nodes: number;
    perNode: number;
    lanes: number;
    nicsPerNode: number;
  }
  const nicLayout = (item: CatalogItem | undefined, key: FabricKey, linkGbps: number): NicLayout | undefined => {
    const c = item?.compute;
    if (!c) return undefined;
    const nodes = Math.max(1, c.nodesPerRack ?? (c.gpusPerNode ? Math.round(c.gpus / c.gpusPerNode) : 1));
    const nics = key === 'scale-out' ? c.gpus * c.scaleOutPortsPerGpu : key === 'frontend' ? c.frontendPorts : key === 'storage' ? c.storagePorts : (c.oobPorts ?? nodes);
    const nicGbps = key === 'scale-out' ? c.scaleOutPortGbps : key === 'frontend' ? c.frontendPortGbps : key === 'storage' ? c.storagePortGbps : 1;
    const nicsPerNode = Math.max(1, Math.round(nics / nodes));
    const lanes = linkGbps > 0 && nicGbps > linkGbps ? Math.max(1, Math.round(nicGbps / linkGbps)) : 1;
    return { nodes, perNode: nicsPerNode * lanes, lanes, nicsPerNode };
  };
  const nicAt = (rack: EquipmentInstance, item: CatalogItem, key: FabricKey, L: NicLayout, k: number): { u?: number; port: string; nic: number } => {
    const prefix0 = key === 'scale-out' ? 'be' : key === 'frontend' ? 'fe' : key === 'storage' ? 'st' : 'oob';
    // backlog T3 (2): ports beyond nodes × NICs per node (e.g. 26 OOB ports on 18 nodes → 1 BMC per node + 8 rack-level management
    // ports) were clamped onto the last node and reused its name (`N18:bmc` on 9 cables). They are rack-level ports with their own names.
    if (k >= L.nodes * L.perNode) {
      const x = k - L.nodes * L.perNode + 1;
      return { port: key === 'oob' ? `MGMT${x}` : `X${x}:${prefix0}`, nic: -1 };
    }
    const node = Math.floor(k / L.perNode);
    const within = k - node * L.perNode;
    const nic = Math.floor(within / L.lanes);
    const lane = (within % L.lanes) + 1;
    const prefix = key === 'scale-out' ? 'be' : key === 'frontend' ? 'fe' : key === 'storage' ? 'st' : 'oob';
    const nicName = key === 'oob' && L.nicsPerNode === 1 ? 'bmc' : `${prefix}${nic}`;
    return { u: nodeU(item, node), port: `N${String(node + 1).padStart(2, '0')}:${nicName}${L.lanes > 1 ? `/${lane}` : ''}`, nic };
  };

  const nicCursors = new Map<string, number>();
  const takeNic = (rack: EquipmentInstance, key: FabricKey, linkGbps: number): { u?: number; port: string } => {
    const item = findCatalogItem(rack.catalogId);
    const ck = `${rack.id}|${key}`;
    const k = nicCursors.get(ck) ?? 0;
    nicCursors.set(ck, k + 1);
    const L = nicLayout(item, key, linkGbps);
    if (!L || !item) {
      // network racks: management port of each switch unit (top-down); other endpoints: numbered mgmt ports
      const sws = unitsByRack.get(rack.id) ?? [];
      if (key === 'oob' && k < sws.length) return { u: sws[k].u, port: `U${sws[k].u}:mgmt0` };
      return { port: `MGMT${k + 1 - (key === 'oob' ? sws.length : 0)}` };
    }
    const n = nicAt(rack, item, key, L, k);
    return { u: n.u, port: n.port };
  };

  // rail-aligned NICs (fix v2 2차, QA B2): per endpoint rack, NIC slots queued by rail (NIC index mod rails)
  const railQueues = new Map<string, { q: number[][]; next: number[]; extra: number; L: NicLayout; item: CatalogItem }>();
  const takeRailed = (rack: EquipmentInstance, toRackId: string, gbps: number, wantRail?: number): [{ u?: number; port: string }, { u?: number; port: string }] | undefined => {
    const leaves = pick(toRackId, 'scale-out', ['leaf']);
    const R = leaves.find((u) => u.rails)?.rails;
    if (!R) return undefined;
    const item = findCatalogItem(rack.catalogId);
    const L = nicLayout(item, 'scale-out', gbps);
    if (!L || !item) return undefined;
    let st = railQueues.get(rack.id);
    if (!st) {
      const q = Array.from({ length: R }, () => [] as number[]);
      for (let k = 0; k < L.nodes * L.perNode; k++) q[Math.floor((k % L.perNode) / L.lanes) % R].push(k);
      st = { q, next: new Array<number>(R).fill(0), extra: L.nodes * L.perNode, L, item };
      railQueues.set(rack.id, st);
    }
    const podLeaves = leaves.filter((u) => u.podId === rack.podId);
    const cands = (podLeaves.length ? podLeaves : leaves).filter((u) => u.rail !== undefined && hasRoom(u, 'down', gbps));
    const left = (r: number) => st!.q[r].length - st!.next[r];
    let rail = -1;
    // the analysis fixes cables per rail for the bundle (CableRun.railCounts); otherwise the rail with the most NIC slots left
    if (wantRail !== undefined && wantRail < R && left(wantRail) > 0 && cands.some((u) => u.rail === wantRail)) rail = wantRail;
    else for (const u of cands) if (left(u.rail!) > 0 && (rail < 0 || left(u.rail!) > left(rail) || (left(u.rail!) === left(rail) && u.rail! < rail))) rail = u.rail!;
    let leaf: SwitchUnit | undefined;
    let k: number;
    if (rail >= 0) {
      leaf = cands.find((u) => u.rail === rail);
      k = st.q[rail][st.next[rail]++];
    } else {
      // no rail-matched slot: any leaf with room, next NIC of the fullest queue (flagged by the rail tests when it happens)
      leaf = cands[0] ?? (podLeaves.length ? podLeaves : leaves).find((u) => hasRoom(u, 'down', gbps));
      let r = -1;
      for (let x = 0; x < R; x++) if (left(x) > 0 && (r < 0 || left(x) > left(r))) r = x;
      k = r >= 0 ? st.q[r][st.next[r]++] : st.extra++;
    }
    const n = nicAt(rack, st.item, 'scale-out', st.L, k);
    return [{ u: n.u, port: n.port }, end(leaf, leaf ? takeOn(leaf, 'down', gbps) : '?')];
  };

  const runs = [...analysis.network.cableRuns].filter((r) => eq.has(r.fromId) && eq.has(r.toId));
  runs.sort((a, b) => {
    const ea = eq.get(a.fromId)!;
    const eb = eq.get(b.fromId)!;
    return (
      (TIER_ORDER[a.tier ?? 'endpoint-leaf'] ?? 9) - (TIER_ORDER[b.tier ?? 'endpoint-leaf'] ?? 9) ||
      fabricKeyOfRun(a).localeCompare(fabricKeyOfRun(b)) ||
      a.fabric.localeCompare(b.fabric) ||
      ea.tag.localeCompare(eb.tag) ||
      eq.get(a.toId)!.tag.localeCompare(eq.get(b.toId)!.tag) ||
      a.cableTypeId.localeCompare(b.cableTypeId) ||
      a.id.localeCompare(b.id)
    );
  });

  interface Draft extends CableScheduleRow {
    net: string;
    hallCode: string;
    sortKey: [string, number, string];
  }
  const drafts: Draft[] = [];
  // round-robin offset of the lower unit per (lower rack, fabric, tier) — continues across the bundles of one rack
  const lowerOffset = new Map<string, number>();
  for (const r of runs) {
    const from = eq.get(r.fromId)!;
    const to = eq.get(r.toId)!;
    const key = fabricKeyOfRun(r);
    const tier = r.tier ?? 'endpoint-leaf';
    const gbps = r.speedGbps ?? 0;
    const net = tier === 'inter-hall' ? 'SS' : key === 'scale-out' ? (isIb ? 'IB' : 'BE') : key === 'frontend' ? 'FE' : key === 'storage' ? 'ST' : 'OOB';
    let lower: SwitchUnit[] = [];
    let upper: SwitchUnit[] = [];
    if (tier === 'leaf-spine') {
      lower = pick(from.id, key, ['leaf']);
      upper = pick(to.id, key, ['spine']);
    } else if (tier === 'spine-core') {
      lower = pick(from.id, key, ['spine']);
      upper = pick(to.id, key, ['core'], false);
    } else if (tier === 'uplink') {
      lower = pick(from.id, key, ['leaf']);
      upper = pick(to.id, 'frontend', ['spine', 'leaf']);
    } else if (tier === 'inter-hall') {
      // inter-hall trunk: hall top tier (core when the hall fabric is 3-tier, else spine) → super-spine in the zone hall
      const cores = pick(from.id, key, ['core'], false);
      lower = cores.length ? cores : pick(from.id, key, ['spine']);
      upper = pick(to.id, key, ['core'], true);
    }
    const ok = `${from.id}|${key}|${tier}`;
    const railSeq = r.railCounts?.flatMap((c, rail) => new Array<number>(c).fill(rail));
    for (let i = 0; i < r.count; i++) {
      let a: { u?: number; port: string };
      let b: { u?: number; port: string };
      if (tier === 'endpoint-leaf') {
        const railed = key === 'scale-out' ? takeRailed(from, to.id, gbps, railSeq?.[i]) : undefined;
        if (railed) [a, b] = railed;
        else {
          a = takeNic(from, key, gbps);
          const leaves = pick(to.id, key, ['leaf']);
          const pod = leaves.filter((u) => u.podId !== undefined && u.podId === from.podId);
          const leaf = (pod.length ? pod : leaves).find((u) => hasRoom(u, 'down', gbps)) ?? leaves.find((u) => hasRoom(u, 'down', gbps));
          b = end(leaf, leaf ? takeOn(leaf, 'down', gbps) : '?');
        }
      } else {
        const j = lowerOffset.get(ok) ?? 0;
        lowerOffset.set(ok, j + 1);
        [a, b] = stripe(lower, upper, gbps, j);
      }
      const hc = hallCode(project, from.hallId);
      const tc = hallCode(project, to.hallId);
      const fromRack = `${hc}.${from.tag}`;
      const toRack = `${tc}.${to.tag}`;
      const fromPort = `${fromRack}${a.u !== undefined && !a.port.startsWith('U') ? `-U${a.u}` : ''}:${a.port}`.replace(':U', '-U');
      const toPort = `${toRack}${b.u !== undefined && !b.port.startsWith('U') ? `-U${b.u}` : ''}:${b.port}`.replace(':U', '-U');
      drafts.push({
        cableId: '',
        fabric: r.fabric,
        fromRack,
        ...(a.u !== undefined ? { fromU: a.u } : {}),
        fromPort,
        toRack,
        ...(b.u !== undefined ? { toU: b.u } : {}),
        toPort,
        cableTypeId: r.cableTypeId,
        lengthM: r.lengthM,
        labelA: '',
        labelB: '',
        ...(from.waveId ?? to.waveId ? { wave: from.waveId ?? to.waveId } : {}),
        tier,
        fabricKey: key,
        ...(r.speedGbps ? { speedGbps: r.speedGbps } : {}),
        fromHallId: from.hallId,
        toHallId: to.hallId,
        runId: r.id,
        net,
        hallCode: hc,
        sortKey: [from.tag, a.u ?? 0, a.port],
      });
    }
  }

  // cable ids per (net, hall) in (source rack, source U, source port) order; BSN per bundle in the same order
  const portNum = (p: string) => p.replace(/\d+/g, (d) => d.padStart(5, '0'));
  drafts.sort((x, y) => x.net.localeCompare(y.net) || x.hallCode.localeCompare(y.hallCode) || x.sortKey[0].localeCompare(y.sortKey[0]) || y.sortKey[1] - x.sortKey[1] || portNum(x.sortKey[2]).localeCompare(portNum(y.sortKey[2])) || x.toPort.localeCompare(y.toPort));
  const seq = new Map<string, number>();
  const bsnOf = new Map<string, number>();
  let bsnNext = 0;
  const rows: CableScheduleRow[] = drafts.map((d) => {
    const sk = `${d.net}|${d.hallCode}`;
    const n = (seq.get(sk) ?? 0) + 1;
    seq.set(sk, n);
    const bk = `${d.fromRack}|${d.toRack}|${d.cableTypeId}|${d.lengthM}`;
    if (!bsnOf.has(bk)) bsnOf.set(bk, ++bsnNext);
    const bsn = bsnOf.get(bk)!;
    const cableId = `${d.net}-${d.hallCode}-${String(n).padStart(6, '0')}`;
    const t = cableName.get(d.cableTypeId);
    const media = `${t?.name ?? d.cableTypeId} ${d.lengthM} m`;
    const bsnTxt = `BSN ${String(bsn).padStart(4, '0')}`;
    const { net: _n, hallCode: _h, sortKey: _s, ...row } = d;
    void _n;
    void _h;
    void _s;
    return {
      ...row,
      cableId,
      bsn,
      labelA: `${cableId} ${bsnTxt} | THIS ${d.fromPort} | FAR ${d.toPort} | ${media}`,
      labelB: `${cableId} ${bsnTxt} | THIS ${d.toPort} | FAR ${d.fromPort} | ${media}`,
    };
  });
  return rows;
}

export interface CableScheduleSummary {
  cables: number;
  bundles: number;
  byNet: { net: string; cables: number; lengthM: number }[];
  /** switch port ends outside their downlink / uplink range or used twice — should be 0 */
  overflowPorts: number;
  /** cable ends without a switch unit to land on ('?') */
  unresolvedEnds: number;
}

/** Totals for the panel / document header. */
export function summarizeCableSchedule(rows: CableScheduleRow[], units?: SwitchUnit[]): CableScheduleSummary {
  const byNet = new Map<string, { net: string; cables: number; lengthM: number }>();
  const bundles = new Set<number>();
  let unresolved = 0;
  for (const r of rows) {
    const net = r.cableId.split('-')[0];
    const agg = byNet.get(net) ?? { net, cables: 0, lengthM: 0 };
    agg.cables++;
    agg.lengthM += r.lengthM;
    byNet.set(net, agg);
    if (r.bsn !== undefined) bundles.add(r.bsn);
    if (r.fromPort.endsWith(':?')) unresolved++;
    if (r.toPort.endsWith(':?')) unresolved++;
  }
  let overflow = 0;
  if (units) {
    // fix v2 2차 (QA B3): a switch end is an overflow when it lies outside its side's range (downlinks P1…Pd, uplinks P(d+1)…P(d+u),
    // UP<n> = P(ports + n)) or when the same port end is used by more than one cable
    const byDevice = new Map(units.map((u) => [`${u.hallId}|${u.rackTag}-U${u.u}`, u]));
    const seen = new Set<string>();
    for (const r of rows) {
      const sides: [string, string | undefined, 'down' | 'up'][] = r.tier === 'endpoint-leaf' ? [[r.toPort, r.toHallId, 'down']] : [[r.fromPort, r.fromHallId, 'up'], [r.toPort, r.toHallId, 'down']];
      for (const [p, hallId, side] of sides) {
        const m = /^H\d+\.(.+-U\d+):(UP|P)(\d+)(?:\/\d+)?$/.exec(p);
        if (!m) continue;
        const u = byDevice.get(`${hallId}|${m[1]}`);
        if (!u) continue;
        const n = m[2] === 'UP' ? u.ports + Number(m[3]) : Number(m[3]);
        const inRange = side === 'down' ? n >= 1 && n <= u.downlinks : n > u.downlinks && n <= u.downlinks + u.uplinks;
        if (!inRange) overflow++;
        if (seen.has(p)) overflow++;
        seen.add(p);
      }
    }
  }
  return { cables: rows.length, bundles: bundles.size, byNet: [...byNet.values()].sort((a, b) => a.net.localeCompare(b.net)), overflowPorts: overflow, unresolvedEnds: unresolved };
}
