// NOS model: per-switch interfaces joined from the cable schedule and the IP plan (stream T7). Data from T2 only.
import { findCatalogItem } from '../../catalog/catalog.ts';
import type { CableScheduleRow, IpPlan, Project, ProjectAnalysis } from '../../model/types.ts';
import { planDevices, splitEndpoint, type PlanDevice } from '../devices.ts';
import { coveringPrefix, ipToInt } from './common.ts';

export interface NosInterface {
  /** front-panel port number (1-based) */
  port: number;
  /** breakout lane (1-based; 1 when not broken out) */
  lane: number;
  /** lanes the port is split into (1 = no breakout) */
  lanes: number;
  kind: 'host' | 'uplink' | 'downlink';
  peer: string;
  peerPort: string;
  speedGbps?: number;
  /** switch-side address with prefix length (host /31, or undefined for unnumbered / access ports) */
  ip?: string;
  /** access VLAN for /24 access hosts (front-end, storage, OOB) */
  vlan?: number;
  cableId: string;
}

export interface NosSwitch {
  device: PlanDevice;
  hostname: string;
  loopback?: string;
  asn?: number;
  interfaces: NosInterface[];
  /** host prefix the leaf originates (covering block of its host /31s) */
  hostBlock?: string;
  /** VLAN SVIs (gateway /24) for access hosts */
  svis: { vlan: number; ip: string }[];
  peerAsns: number[];
  /** lossless RoCE profile applies (Ethernet scale-out or storage) */
  lossless: boolean;
}

export interface NosModel {
  switches: NosSwitch[];
  /** InfiniBand scale-out switches (no IP / BGP) */
  ibSwitches: PlanDevice[];
  isIbScaleOut: boolean;
  isDdc: boolean;
  planEmpty: boolean;
  notes: string[];
}

type RowX = CableScheduleRow & { tier?: string; speedGbps?: number };

/**
 * Front-panel port of a schedule port name: `P12` / `P12/3` (breakout lane), or `UP2` / `UP2/1` — the dedicated uplink ports a
 * management switch carries beyond its access radix (links.ts names them UP1 … after `ports`, e.g. SN2201 48 × 1G + 4 × 100G →
 * UP1 = port 49). Integration v2 2차: UP ports were dropped, so OOB leaf configs had no uplinks.
 */
const parseP = (port?: string, accessPorts?: number, uplinkPorts?: number) => {
  const m = port ? /^(UP|P)(\d+)(?:\/(\d+))?$/.exec(port) : null;
  if (!m) return undefined;
  const n = Number(m[2]);
  // fix v2 2차 (QA OOB): UP<n> beyond the switch's dedicated uplink ports does not exist on the box (was swp73 on an SN2201)
  if (m[1] === 'UP' && uplinkPorts !== undefined && n > uplinkPorts) return undefined;
  return { port: m[1] === 'UP' ? (accessPorts ?? 48) + n : n, lane: m[3] ? Number(m[3]) : 1 };
};
const uplinkPortsOf = (d?: PlanDevice) => (d?.catalogId ? findCatalogItem(d.catalogId)?.switch?.uplinkPorts : undefined);

export function buildNosModel(project: Project, analysis: ProjectAnalysis, plan: IpPlan, rows: CableScheduleRow[]): NosModel {
  const isIbScaleOut = project.network.scaleOut.fabric.startsWith('ib-');
  const isDdc = project.network.scaleOut.fabric === 'drivenets-fse';
  const devices = planDevices(project, analysis, plan);
  const byTia = new Map(devices.filter((d) => d.tia).map((d) => [d.tia!, d]));
  const hostIp = new Map(plan.hosts.map((h) => [`${h.nodeId}:${h.nic}`, h]));
  const asnOf = new Map(plan.asns.map((a) => [a.deviceId, a.asn]));
  const ifaces = new Map<string, NosInterface[]>();
  const push = (d: PlanDevice, i: NosInterface) => ifaces.set(d.id, [...(ifaces.get(d.id) ?? []), i]);
  const peerAsns = new Map<string, Set<number>>();

  for (const r of rows as RowX[]) {
    const A = splitEndpoint(r.fromPort), B = splitEndpoint(r.toPort);
    const da = byTia.get(A.device), db = byTia.get(B.device);
    const pa = parseP(A.port, da?.ports, uplinkPortsOf(da)), pb = parseP(B.port, db?.ports, uplinkPortsOf(db));
    const hostRow = r.tier ? r.tier === 'endpoint-leaf' : !(da && db);
    if (hostRow) {
      const sw = db && pb ? { d: db, p: pb, host: r.fromPort } : da && pa ? { d: da, p: pa, host: r.toPort } : undefined;
      if (!sw) continue;
      const h = hostIp.get(sw.host);
      const isP2p = !!h?.ip.endsWith('/31');
      push(sw.d, { port: sw.p.port, lane: sw.p.lane, lanes: 1, kind: 'host', peer: splitEndpoint(sw.host).device, peerPort: splitEndpoint(sw.host).port ?? '', speedGbps: r.speedGbps, ip: isP2p && h?.gw ? `${h.gw}/31` : undefined, vlan: !isP2p ? h?.vlan : undefined, cableId: r.cableId });
      continue;
    }
    if (da && pa) push(da, { port: pa.port, lane: pa.lane, lanes: 1, kind: 'uplink', peer: db?.hostname ?? B.device, peerPort: B.port ?? '', speedGbps: r.speedGbps, cableId: r.cableId });
    if (db && pb) push(db, { port: pb.port, lane: pb.lane, lanes: 1, kind: 'downlink', peer: da?.hostname ?? A.device, peerPort: A.port ?? '', speedGbps: r.speedGbps, cableId: r.cableId });
    if (da && db) {
      const asA = asnOf.get(da.id), asB = asnOf.get(db.id);
      if (asB !== undefined) peerAsns.set(da.id, (peerAsns.get(da.id) ?? new Set()).add(asB));
      if (asA !== undefined) peerAsns.set(db.id, (peerAsns.get(db.id) ?? new Set()).add(asA));
    }
  }

  const switches: NosSwitch[] = [];
  const ibSwitches: PlanDevice[] = [];
  for (const d of devices) {
    if (d.fabricKey === 'scale-out' && isIbScaleOut) {
      ibSwitches.push(d);
      continue;
    }
    if (d.asn === undefined && d.loopback === undefined) continue;
    const list = (ifaces.get(d.id) ?? []).sort((a, b) => a.port - b.port || a.lane - b.lane);
    const maxLane = new Map<number, number>();
    for (const i of list) maxLane.set(i.port, Math.max(maxLane.get(i.port) ?? 1, i.lane));
    for (const i of list) i.lanes = maxLane.get(i.port) ?? 1;
    const hostInts = list.map((i) => (i.ip ? ipToInt(i.ip) : undefined)).filter((v): v is number => v !== undefined);
    const svis = new Map<number, string>();
    for (const i of list) {
      if (i.kind !== 'host' || i.vlan === undefined) continue;
      const h = plan.hosts.find((x) => x.vlan === i.vlan && x.gw && `${x.nodeId}:${x.nic}` === `${i.peer}:${i.peerPort}`);
      if (h?.gw && !svis.has(i.vlan)) svis.set(i.vlan, `${h.gw}/24`);
    }
    switches.push({
      device: d, hostname: d.hostname, loopback: d.loopback, asn: d.asn, interfaces: list,
      hostBlock: hostInts.length ? coveringPrefix([...hostInts, ...hostInts.map((x) => x + 1)]) : undefined,
      svis: [...svis.entries()].sort((a, b) => a[0] - b[0]).map(([vlan, ip]) => ({ vlan, ip })),
      peerAsns: [...(peerAsns.get(d.id) ?? [])].sort((a, b) => a - b),
      lossless: !isIbScaleOut && (d.fabricKey === 'scale-out' || d.fabricKey === 'storage') || (isIbScaleOut && d.fabricKey === 'storage'),
    });
  }
  const notes: string[] = [...((plan as IpPlan & { notes?: string[] }).notes ?? [])];
  return { switches, ibSwitches, isIbScaleOut, isDdc, planEmpty: plan.loopbacks.length === 0 && plan.asns.length === 0, notes };
}

/** Physical lanes per front-panel port (800G OSFP = 8, else 4) — derived; platform files are authoritative. */
export const lanesPerCage = (portGbps?: number) => ((portGbps ?? 400) >= 800 ? 8 : 4);
