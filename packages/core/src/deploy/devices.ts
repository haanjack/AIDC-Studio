// Switch device list shared by the switch inventory, topology.dot and the NOS generators (stream T7).
// T2 owns the data; this module only joins it:
//   engines/links.ts buildSwitchUnits (rack, U, role, fabric, port split; id = `<rack id>-U<u>` = IpPlan deviceId)
//   → analysis.network.switchInstances when a future engine fills it → devices that appear only in the IP plan.
// Hostnames are derived deterministically (RFC 1123 labels): h<hall#>-<net>-<role><index 3>,
// e.g. h1-be-lf001, h1-fe-sp002, h1-oob-lf010; inter-hall super-spines c<cluster#>-ss<index>.
import { findCatalogItem } from '../catalog/catalog.ts';
import { buildSwitchUnits, type FabricKey } from '../engines/links.ts';
import type { IpPlan, Project, ProjectAnalysis } from '../model/types.ts';

export type DeviceRole = 'leaf' | 'spine' | 'core' | 'super-spine' | 'mgmt' | 'unknown';

export interface PlanDevice {
  id: string;
  hostname: string;
  role: DeviceRole;
  fabric?: string;
  fabricKey?: FabricKey;
  catalogId?: string;
  model?: string;
  hallId?: string;
  rackId?: string;
  rackTag?: string;
  u?: number;
  podId?: string;
  /** TIA-606-style device id used by the cable schedule ports (`H1.DU01-B-NET2-U24`) */
  tia?: string;
  ports?: number;
  portGbps?: number;
  downlinks?: number;
  uplinks?: number;
  index?: number;
  interHall?: boolean;
  loopback?: string;
  asn?: number;
  mgmtIp?: string;
  source: 'switch-unit' | 'switch-instance' | 'ip-plan';
}

const ROLE_ORDER: Record<DeviceRole, number> = { 'super-spine': 0, core: 1, spine: 2, leaf: 3, mgmt: 4, unknown: 5 };
const NET_CODE: Record<FabricKey, string> = { 'scale-out': 'be', frontend: 'fe', storage: 'st', oob: 'oob' };
const ROLE_CODE: Record<'leaf' | 'spine' | 'core', string> = { leaf: 'lf', spine: 'sp', core: 'cr' };

/** Role digit of the readable 4-byte ASN scheme. Returns undefined outside 4,200,000,000–4,294,967,294. */
export function roleFromAsn(asn: number | undefined): DeviceRole | undefined {
  if (asn === undefined || !Number.isFinite(asn) || asn < 4_200_000_000 || asn > 4_294_967_294) return undefined;
  const r = Math.floor((asn - 4_200_000_000) / 100_000) % 10;
  return ({ 1: 'core', 2: 'spine', 3: 'leaf', 4: 'leaf', 5: 'spine', 6: 'leaf', 7: 'spine', 8: 'mgmt' } as Record<number, DeviceRole>)[r];
}

export function roleFromId(id: string): DeviceRole | undefined {
  const s = id.toLowerCase();
  if (/(^|[-_.:])(ss\d*|super-?spine)/.test(s)) return 'super-spine';
  if (/(^|[-_.:])(sp\d+|spine)/.test(s)) return 'spine';
  if (/(^|[-_.:])(lf\d+|leaf|tor)/.test(s)) return 'leaf';
  if (/(^|[-_.:])core/.test(s)) return 'core';
  if (/(^|[-_.:])(oob|mgmt)/.test(s)) return 'mgmt';
  return undefined;
}

/** RFC 1123 host label: lowercase letters, digits and hyphens, ≤ 63 characters. */
export function hostnameOf(id: string): string {
  const h = id.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/(^-|-$)/g, '').slice(0, 63);
  return h || 'switch';
}

/** "device:port" → parts (last colon; a bare device id has no port). */
export function splitEndpoint(s: string): { device: string; port?: string } {
  const i = s.lastIndexOf(':');
  return i > 0 && i < s.length - 1 ? { device: s.slice(0, i), port: s.slice(i + 1) } : { device: s };
}

export function planDevices(project: Project, analysis: ProjectAnalysis | null, plan?: IpPlan): PlanDevice[] {
  const hallNo = new Map(project.halls.map((h, i) => [h.id, i + 1]));
  const clusterNo = new Map((project.clusters ?? []).map((c, i) => [c.id, i + 1]));
  const devices = new Map<string, PlanDevice>();
  if (analysis) {
    let units: ReturnType<typeof buildSwitchUnits> = [];
    try {
      units = buildSwitchUnits(project, analysis);
    } catch {
      units = [];
    }
    for (const u of units) {
      const h = hallNo.get(u.hallId) ?? 1;
      const hostname = u.interHall
        ? `c${clusterNo.get(u.clusterId ?? '') ?? 1}-ss${String(u.index + 1).padStart(3, '0')}`
        : `h${h}-${NET_CODE[u.fabricKey]}-${ROLE_CODE[u.role]}${String(u.index + 1).padStart(3, '0')}`;
      devices.set(u.id, {
        id: u.id, hostname, role: u.interHall ? 'super-spine' : u.role, fabric: u.fabric, fabricKey: u.fabricKey, catalogId: u.catalogId, model: findCatalogItem(u.catalogId)?.model,
        hallId: u.hallId, rackId: u.rackId, rackTag: u.rackTag, u: u.u, podId: u.podId, tia: `H${h}.${u.rackTag}-U${u.u}`,
        ports: u.ports, portGbps: u.portGbps, downlinks: u.downlinks, uplinks: u.uplinks, index: u.index, interHall: u.interHall, source: 'switch-unit',
      });
    }
    if (!units.length) {
      const tags = new Map(project.equipment.map((e) => [e.id, e]));
      for (const s of analysis.network.switchInstances ?? []) {
        const rack = tags.get(s.rackId);
        const h = rack ? hallNo.get(rack.hallId) ?? 1 : 1;
        devices.set(s.id, {
          id: s.id, hostname: hostnameOf(s.id), role: s.role, fabric: s.fabric, catalogId: s.catalogId, model: findCatalogItem(s.catalogId)?.model,
          hallId: rack?.hallId, rackId: s.rackId, rackTag: rack?.tag, u: s.u, podId: s.podId, tia: rack ? `H${h}.${rack.tag}-U${s.u}` : undefined, source: 'switch-instance',
        });
      }
    }
  }
  if (plan) {
    const touch = (id: string): PlanDevice => {
      let d = devices.get(id);
      if (!d) {
        d = { id, hostname: hostnameOf(id), role: roleFromId(id) ?? 'unknown', source: 'ip-plan' };
        devices.set(id, d);
      }
      return d;
    };
    for (const l of plan.loopbacks) touch(l.deviceId).loopback = l.ip.replace(/\/32$/, '');
    for (const a of plan.asns) {
      const d = touch(a.deviceId);
      d.asn = a.asn;
      if (d.role === 'unknown') d.role = roleFromAsn(a.asn) ?? 'unknown';
    }
    // switch mgmt0 addresses: OOB entries whose device part is a switch's TIA id
    const byTia = new Map([...devices.values()].filter((d) => d.tia).map((d) => [d.tia!, d]));
    for (const o of plan.oob) {
      const d = devices.get(o.deviceId) ?? byTia.get(splitEndpoint(o.deviceId).device);
      if (d && !d.mgmtIp) d.mgmtIp = o.ip;
    }
  }
  return [...devices.values()].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || (a.fabricKey ?? '').localeCompare(b.fabricKey ?? '') || a.hostname.localeCompare(b.hostname, 'en', { numeric: true }));
}
