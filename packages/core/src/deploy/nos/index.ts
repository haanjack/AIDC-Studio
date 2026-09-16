// NOS configuration templates (stream T7, DECISIONS-v2 #9, DECISIONS-v2-2 §B/§C):
// SONiC · Cumulus/NVUE · Arista EOS · Cisco NX-OS · Dell (Enterprise SONiC sonic-cli; OS10 unverified) · Juniper Junos;
// InfiniBand = OpenSM partitions / UFM SHARP notes (no IP).
// Per-switch files come from the IP plan + cable schedule (T2) through the NOS model; every target also returns a
// README.txt (assumptions, verification status, sources) and switches.csv. Paths are relative to nos/<target>/.
import { buildCableSchedule } from '../../engines/links.ts';
import type { CableScheduleRow, GeneratedFile, IpPlan, NosTarget, Project, ProjectAnalysis } from '../../model/types.ts';
import { csvFile } from '../csv.ts';
import { CNP_TC, ConfigWriter, ROCE, SOURCES, VERIFY_TAG, cnpComment } from './common.ts';
import { buildNosModel, type NosModel, type NosSwitch } from './model.ts';
import { renderCumulus, renderDell, renderEos, renderJunos, renderNxos, renderSonic } from './targets.ts';

export const NOS_TARGETS: NosTarget[] = ['sonic', 'cumulus-nvue', 'arista-eos', 'cisco-nxos', 'dell-os10', 'juniper-junos', 'ib-ufm'];

export const NOS_TARGET_LABEL: Record<NosTarget, string> = {
  sonic: 'SONiC (config_db.json + FRR)',
  'cumulus-nvue': 'NVIDIA Cumulus Linux (NVUE)',
  'arista-eos': 'Arista EOS',
  'cisco-nxos': 'Cisco NX-OS',
  'dell-os10': 'Dell Enterprise SONiC / OS10',
  'juniper-junos': 'Juniper Junos',
  'ib-ufm': 'InfiniBand (OpenSM / UFM)',
};

export { VERIFY_TAG, CNP_TC, ROCE } from './common.ts';
export { buildNosModel, type NosModel, type NosSwitch, type NosInterface } from './model.ts';

export interface NosOptions {
  /** injected cable schedule (default: T2 buildCableSchedule) */
  cableSchedule?: CableScheduleRow[];
}

const RENDER: Record<Exclude<NosTarget, 'ib-ufm'>, (sw: NosSwitch, m: NosModel, projectName: string) => GeneratedFile[]> = {
  sonic: renderSonic, 'cumulus-nvue': renderCumulus, 'arista-eos': renderEos, 'cisco-nxos': renderNxos, 'dell-os10': renderDell, 'juniper-junos': renderJunos,
};

function switchesCsv(m: NosModel): string {
  return csvFile(m.switches.map((s) => ({
    hostname: s.hostname, role: s.device.role, fabric: s.device.fabric, model: s.device.model, rack_tag: s.device.rackTag, u: s.device.u, loopback: s.loopback, asn: s.asn,
    interfaces: s.interfaces.length, host_ports: s.interfaces.filter((i) => i.kind === 'host').length, fabric_ports: s.interfaces.filter((i) => i.kind !== 'host').length, lossless: s.lossless, host_block: s.hostBlock,
  })), ['hostname', 'role', 'fabric', 'model', 'rack_tag', 'u', 'loopback', 'asn', 'interfaces', 'host_ports', 'fabric_ports', 'lossless', 'host_block']);
}

function readme(project: Project, target: NosTarget, m: NosModel, fileCount: number, verifyCount: number): string {
  const src = [...SOURCES.common, ...(SOURCES[target] ?? [])];
  const L: string[] = [
    `AIDC Studio — NOS configuration bundle: ${NOS_TARGET_LABEL[target]}`,
    `Project: ${project.name} (${project.id})`,
    '',
    'SCOPE',
    target === 'ib-ufm'
      ? `  ${m.ibSwitches.length} InfiniBand scale-out switches. InfiniBand has no IP addressing or BGP: the subnet manager assigns LIDs, PKeys isolate tenants.`
      : `  ${m.switches.length} Ethernet switches with a loopback / ASN in the IP plan (${fileCount} files).${m.isIbScaleOut ? ' The scale-out fabric is InfiniBand — its switches are in the ib-ufm bundle; this bundle covers the front-end, storage and OOB switches.' : ''}`,
    ...(m.planEmpty ? ['  The IP plan is empty for this project state, so no per-switch files were generated.'] : []),
    ...(m.isDdc ? ['  DriveNets FSE: NCP/NCF boxes form one distributed router — per-box configs are placeholders for the DNOS cluster design.'] : []),
    '',
    'ASSUMPTIONS (defaults of DECISIONS-v2-2 §C; all editable in the project)',
    '  - Addressing and ASNs come from the IP plan (ip-plan.csv): base 10.0.0.0/8 (configurable), /31 per host NIC, 4-byte private ASNs (RFC 6996),',
    '    one shared ASN per spine set and a unique ASN per leaf (RFC 7938 §5.2.1).',
    '  - Fabric links: eBGP unnumbered over IPv6 link-local next hops (RFC 8950); leaves originate their loopback and host block only.',
    ...(target === 'ib-ufm'
      ? ['  - InfiniBand: credit-based lossless link layer — no DSCP / PFC / ECN switch QoS to configure; congestion control and adaptive routing follow the subnet manager / UFM profile.']
      : [
          `  - RoCEv2 lossless profile on Ethernet scale-out and storage switches: DSCP ${ROCE.dataDscp} → TC ${ROCE.dataTc}, PFC on priority ${ROCE.pfcPriority}, ECN/WRED on the lossless queue with each vendor's published example thresholds, PFC watchdog on.`,
          `  - ${cnpComment(target)}`,
        ]),
    `  - MTU ${ROCE.mtu} on switches (EOS ${ROCE.eosMtu}), host MTU ${ROCE.hostMtu}; host NCCL_IB_TC=${ROCE.ncclIbTc} (DSCP 26 << 2 | ECT(0), derived) must match this QoS.`,
    '  - Breakouts follow the cable schedule (e.g. 800G OSFP → 2 × 400G lanes P12/1, P12/2); port numbering assumes 8 lanes per 800G cage, 4 per 400G cage — platform files are authoritative.',
    '  - LLDP on (default or explicit) so the cabling can be verified against topology.dot / cable-schedule.csv.',
    '',
    'VERIFICATION STATUS',
    `  ${verifyCount} lines are preceded by a "${VERIFY_TAG}" comment: their syntax was not checked against the vendor documentation listed below.`,
    '  Every line is generated from AIDC Studio templates with plan values substituted; lines without a verify comment use command syntax checked against the vendor documentation below. Lab-check every file (verify lines first) before use.',
    '',
    'SOURCES',
    ...src.map((s) => `  - ${s.label}: ${s.url}`),
    '',
    ...(m.notes.length ? ['IP PLAN NOTES', ...m.notes.map((n) => `  - ${n}`), ''] : []),
  ];
  return L.join('\n');
}

function renderIb(project: Project, m: NosModel): GeneratedFile[] {
  const p = new ConfigWriter('#');
  p.comment('OpenSM partitions.conf (default path $(OPENSM_CONFIG_DIR)/partitions.conf, or opensm -P <file>).');
  p.comment('Grammar: [PartitionName][=PKey][,indx0][,ipoib_bc_flags][,defmember=full|limited|both] : <PortGUID>[=[full|limited|both]], … ;');
  p.comment('Syntax reference: linux-rdma/opensm doc/partition-config.txt (https://github.com/linux-rdma/opensm).');
  p.line('Default=0x7fff,ipoib:ALL=full;', 'V');
  p.comment('Tenant / storage / management partitions (PKey plan: tenants from 0x0010, storage 0x0020, management 0x0030 — derived).');
  p.comment('Fill in the port GUIDs from ibnetdiscover / UFM inventory, then uncomment:');
  p.comment('Tenant01=0x0010, defmember=full : <PortGUID>, <PortGUID> ;');
  p.comment('Storage=0x0020, defmember=full : <PortGUID>, <PortGUID> ;');
  p.comment('Management=0x0030, defmember=full : <PortGUID>, <PortGUID> ;');

  const o = new ConfigWriter('#');
  o.comment('OpenSM options (man opensm.8, verified option names). Master SM and standby SM on separate hosts.');
  o.line('opensm -P /etc/opensm/partitions.conf -Z both -p 15', 'A');
  o.line('opensm -P /etc/opensm/partitions.conf -Z both -p 14', 'A');
  o.comment('-Z/--part_enforce [both|in|out|off], -W/--allow_both_pkeys, -p/--priority (higher wins mastership).');

  const s = new ConfigWriter('#');
  s.comment('UFM SHARP: the SHARP aggregation manager (sharp_am) runs inside UFM and is enabled by default from UFM 6.23 (NVIDIA SHARP documentation).');
  s.comment('After an upgrade verify conf/gv.cfg contains:');
  s.line('[sharp]', 'V');
  s.line('sharp_enabled = true', 'V');
  s.comment('Appliance equivalent: lib sharp enable');
  s.comment('Tests: sharp_hello (client ↔ sharp_am), sharp_coll_test (HCA ↔ switch bandwidth + SHARP data transfer).');
  s.comment('NCCL with SHARP (HPC-X 2.51 plugins): NCCL_COLLNET_ENABLE=1 SHARP_COLLNET_OVERLAP_AG=1 ; NCCL_IBEXT_DISABLE=1 disables the plugin.');
  s.comment('Streaming aggregation needs leaf switches connected to the same HCA rail from every server (rail-optimized cabling).');
  s.line('curl -k -u <user>:<password> https://<ufm-host>/ufmRest/resources/pkeys', 'U', 'UFM REST PKey API was not retrieved');

  const sw = csvFile(m.ibSwitches.map((d) => ({ hostname: d.hostname, role: d.role, fabric: d.fabric, model: d.model, rack_tag: d.rackTag, u: d.u, ports: d.ports, port_gbps: d.portGbps, node_guid: '', mgmt_ip: d.mgmtIp })), ['hostname', 'role', 'fabric', 'model', 'rack_tag', 'u', 'ports', 'port_gbps', 'node_guid', 'mgmt_ip']);
  const files: GeneratedFile[] = [
    { path: 'opensm/partitions.conf', content: p.toString(), mime: 'text/plain' },
    { path: 'opensm/opensm-options.txt', content: o.toString(), mime: 'text/plain' },
    { path: 'ufm/sharp-notes.txt', content: s.toString(), mime: 'text/plain' },
    { path: 'switches.csv', content: sw, mime: 'text/csv' },
  ];
  if (!m.isIbScaleOut) files.unshift({ path: 'NOT-APPLICABLE.txt', content: `The scale-out fabric of ${project.name} is ${project.network.scaleOut.fabric} (Ethernet); InfiniBand partition / UFM notes are templates only.\n` });
  return files;
}

export function generateNosConfigs(project: Project, analysis: ProjectAnalysis, plan: IpPlan, target: NosTarget, opts: NosOptions = {}): GeneratedFile[] {
  let rows = opts.cableSchedule;
  if (!rows) {
    try { rows = buildCableSchedule(project, analysis); } catch { rows = []; }
  }
  const m = buildNosModel(project, analysis, plan, rows);
  const files: GeneratedFile[] = [];
  if (target === 'ib-ufm') files.push(...renderIb(project, m));
  else {
    for (const sw of m.switches) files.push(...RENDER[target](sw, m, project.name));
    files.push({ path: 'switches.csv', content: switchesCsv(m), mime: 'text/csv' });
  }
  const verifyCount = files.reduce((n, f) => n + (f.content.match(new RegExp(VERIFY_TAG, 'g'))?.length ?? 0), 0);
  files.unshift({ path: 'README.txt', content: readme(project, target, m, files.length, verifyCount), mime: 'text/plain' });
  return files;
}
