// Switch inventory CSV (stream T7): one row per switch from the joined device list (deploy/devices.ts).
import type { IpPlan, Project, ProjectAnalysis } from '../model/types.ts';
import { csvFile } from './csv.ts';
import { planDevices, type PlanDevice } from './devices.ts';

export const SWITCH_INVENTORY_COLUMNS = ['hostname', 'device_id', 'tia_id', 'role', 'fabric', 'model', 'catalog_id', 'ports', 'port_gbps', 'downlinks', 'uplinks', 'rack_tag', 'u', 'pod', 'loopback', 'asn', 'mgmt_ip', 'source'];

export function switchInventoryCsv(devices: PlanDevice[]): string {
  return csvFile(devices.map((d) => ({
    hostname: d.hostname, device_id: d.id, tia_id: d.tia, role: d.role, fabric: d.fabric, model: d.model, catalog_id: d.catalogId, ports: d.ports, port_gbps: d.portGbps,
    downlinks: d.downlinks, uplinks: d.uplinks, rack_tag: d.rackTag, u: d.u, pod: d.podId, loopback: d.loopback, asn: d.asn, mgmt_ip: d.mgmtIp, source: d.source,
  })), SWITCH_INVENTORY_COLUMNS);
}

export function buildSwitchInventoryCsv(project: Project, analysis: ProjectAnalysis | null, plan?: IpPlan): string {
  return switchInventoryCsv(planDevices(project, analysis, plan));
}
