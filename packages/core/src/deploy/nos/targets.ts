// Per-target NOS configuration renderers (stream T7). Every file is generated from AIDC Studio's own templates: object
// names, block structure and comments are ours; only the command syntax follows each vendor's public documentation (flag per
// line: V / A / U, see common.ts). Values come from the NOS model (IP plan + cable schedule, T2).
import type { GeneratedFile } from '../../model/types.ts';
import { CNP_TC, ConfigWriter, ROCE, cnpComment } from './common.ts';

/** ECN / WRED planning thresholds per NOS (AIDC Studio defaults in each platform's units — tune per switch buffer profile). */
const ECN = {
  eos: { minSeg: 2000, maxSeg: 10000, prob: 20 },
  nxos: { minKb: 950, maxKb: 3000, prob: 7 },
  dell: { minKb: 2048, maxKb: 12480, prob: 15 },
  junos: { fillMin: 45, fillMax: 90 },
};
/** Junos flowlet dynamic-load-balancing planning defaults and queue numbers of the lossless / CNP classes. */
const JUNOS_DLB = { inactivityMicros: 256, flowsetTable: 2048, probThreshold: 3, qualityDelta: 6 };
const JUNOS_LOSSLESS_QUEUE = 4;
const JUNOS_CNP_QUEUE = 3;
import { lanesPerCage, type NosInterface, type NosModel, type NosSwitch } from './model.ts';

const headerLines = (sw: NosSwitch, target: string, projectName: string) => [
  `AIDC Studio NOS configuration — ${target}`,
  `project: ${projectName} · switch: ${sw.hostname} (${sw.device.role}, ${sw.device.fabric ?? 'fabric ?'}) · device ${sw.device.id}${sw.device.tia ? ` · ${sw.device.tia}` : ''}`,
  `loopback ${sw.loopback ?? '-'} · ASN ${sw.asn ?? '-'} · model ${sw.device.model ?? sw.device.catalogId ?? '-'}`,
  'Lines preceded by a "verify" comment use syntax not checked against vendor documentation — check in a lab before use.',
  ...(sw.lossless ? [`RoCEv2 lossless: DSCP ${ROCE.dataDscp} → TC ${ROCE.dataTc}, PFC priority ${ROCE.pfcPriority}, ECN on the lossless queue (AIDC Studio default thresholds; tune per platform).`, cnpComment(target.split(' ')[0])] : ['No lossless RoCE profile on this switch (front-end / OOB traffic).']),
  'See README.txt in this directory for the assumptions and sources.',
];

const hosts = (sw: NosSwitch) => sw.interfaces.filter((i) => i.kind === 'host');
const fabricPorts = (sw: NosSwitch) => sw.interfaces.filter((i) => i.kind !== 'host');
const breakoutPorts = (sw: NosSwitch) => [...new Map(sw.interfaces.filter((i) => i.lanes > 1).map((i) => [i.port, i.lanes])).entries()];
const maxPaths = (sw: NosSwitch) => Math.min(128, Math.max(8, fabricPorts(sw).filter((i) => i.kind === 'uplink').length || fabricPorts(sw).length));
const desc = (i: NosInterface) => `${i.peer}${i.peerPort ? `:${i.peerPort}` : ''}`;
const laneSpeed = (sw: NosSwitch, i: NosInterface) => i.speedGbps ?? Math.round((sw.device.portGbps ?? 400) / i.lanes);

// ───────────────────────────── SONiC (community) ─────────────────────────────

export const sonicName = (sw: NosSwitch, i: NosInterface) => {
  const cage = lanesPerCage(sw.device.portGbps);
  return `Ethernet${(i.port - 1) * cage + (i.lane - 1) * Math.max(1, Math.floor(cage / i.lanes))}`;
};

export function renderSonic(sw: NosSwitch, m: NosModel, projectName: string): GeneratedFile[] {
  const cnp = CNP_TC.sonic;
  const dscp: Record<string, string> = {};
  for (let d = 0; d < 64; d++) dscp[String(d)] = d === ROCE.dataDscp ? String(ROCE.dataTc) : d === ROCE.cnpDscp ? String(cnp) : '0';
  const port: Record<string, Record<string, string>> = {};
  const intf: Record<string, Record<string, string>> = {};
  for (const i of sw.interfaces) {
    const n = sonicName(sw, i);
    port[n] = { speed: String(laneSpeed(sw, i) * 1000), mtu: String(ROCE.mtu), admin_status: 'up', description: desc(i) };
    if (i.kind === 'host' && i.ip) {
      intf[n] = {};
      intf[`${n}|${i.ip}`] = {};
    } else if (i.kind !== 'host') intf[n] = { ipv6_use_link_local_only: 'enable' };
  }
  const qosPorts = sw.interfaces.map((i) => sonicName(sw, i));
  const cfg: Record<string, unknown> = {
    DEVICE_METADATA: { localhost: { hostname: sw.hostname, bgp_asn: String(sw.asn ?? ''), docker_routing_config_mode: 'split', type: sw.device.role === 'leaf' ? 'LeafRouter' : 'SpineRouter' } },
    LOOPBACK_INTERFACE: sw.loopback ? { [`Loopback0|${sw.loopback}/32`]: {} } : {},
    PORT: port,
    INTERFACE: intf,
  };
  if (sw.lossless && qosPorts.length) {
    Object.assign(cfg, {
      DSCP_TO_TC_MAP: { ROCE: dscp },
      TC_TO_PRIORITY_GROUP_MAP: { ROCE: { '0': '0', '3': '3', [String(cnp)]: String(cnp) } },
      TC_TO_QUEUE_MAP: { ROCE: { '0': '0', '3': '3', [String(cnp)]: String(cnp) } },
      MAP_PFC_PRIORITY_TO_QUEUE: { ROCE: { '3': '3' } },
      WRED_PROFILE: { ROCE_LOSSLESS: { wred_green_enable: 'true', ecn: 'ecn_all', green_min_threshold: '1048576', green_max_threshold: '2097152', green_drop_probability: '5' } },
      PORT_QOS_MAP: { [qosPorts.join(',')]: { dscp_to_tc_map: '[DSCP_TO_TC_MAP|ROCE]', tc_to_pg_map: '[TC_TO_PRIORITY_GROUP_MAP|ROCE]', tc_to_queue_map: '[TC_TO_QUEUE_MAP|ROCE]', pfc_to_queue_map: '[MAP_PFC_PRIORITY_TO_QUEUE|ROCE]', pfc_enable: '3', pfcwd_sw_enable: '3' } },
      QUEUE: Object.fromEntries(qosPorts.map((p) => [`${p}|3`, { wred_profile: '[WRED_PROFILE|ROCE_LOSSLESS]' }])),
      BUFFER_PG: Object.fromEntries(sw.interfaces.map((i) => [`${sonicName(sw, i)}|3`, { profile: `[BUFFER_PROFILE|pg_lossless_${laneSpeed(sw, i) * 1000}_5m_profile]` }])),
    });
  }
  const notes = new ConfigWriter('#');
  notes.comment(headerLines(sw, 'sonic', projectName).join('\n')).blank();
  notes.comment('config_db.json cannot carry comments — the unverified parts of that file are listed here.');
  notes.line('BUFFER_PG profile names pg_lossless_<speed>_5m_profile', 'U', 'the buffer profile name is platform-specific');
  notes.line('DEVICE_METADATA type SpineRouter (spines)', 'U', 'only LeafRouter is described in the SONiC configuration documentation');
  notes.line('PORT entries omit lanes / alias / fec: merge into the platform config_db generated from the hwsku', 'U', 'Ethernet<N> numbering assumes 8 lanes per 800G cage / 4 per 400G cage');
  notes.line('INTERFACE "EthernetN|a.b.c.d/31": {} p2p key form', 'A', 'p2p key form per the SONiC configuration documentation; newer releases changed p2p key handling');
  notes.comment(`DSCP_TO_TC_MAP lists all 64 code points (26 → ${ROCE.dataTc}, 48 → ${cnp}, others → 0).`);

  const frr = new ConfigWriter('!');
  frr.comment(headerLines(sw, 'sonic (FRR split mode, /etc/sonic/frr/bgpd.conf)', projectName).join('\n'));
  frr.line(`router bgp ${sw.asn ?? '<ASN>'}`, sw.asn ? 'A' : 'U', sw.asn ? undefined : 'no ASN in the IP plan for this device');
  if (sw.loopback) frr.line(`bgp router-id ${sw.loopback}`, 'A', undefined, 1);
  frr.line('bgp bestpath as-path multipath-relax', 'A', undefined, 1);
  frr.line('neighbor FABRIC peer-group', 'U', 'peer-group creation is standard FRR but was not checked against the documentation', 1);
  frr.line('neighbor FABRIC remote-as external', 'A', undefined, 1);
  for (const i of fabricPorts(sw)) frr.line(`neighbor ${sonicName(sw, i)} interface peer-group FABRIC`, 'A', undefined, 1);
  frr.comment('');
  frr.line('address-family ipv4 unicast', 'A', undefined, 1);
  if (sw.loopback) frr.line(`network ${sw.loopback}/32`, 'U', '"network" lines are standard FRR but were not checked against the documentation', 2);
  if (sw.hostBlock) frr.line(`network ${sw.hostBlock}`, 'U', '"network" lines are standard FRR but were not checked against the documentation; RFC 7938 §5.2.3 — originate at the leaf only', 2);
  for (const s of sw.svis) frr.line(`network ${s.ip.replace(/\.\d+\/24$/, '.0/24')}`, 'U', 'access subnet origination', 2);
  frr.line(`maximum-paths ${maxPaths(sw)}`, 'A', undefined, 2);
  frr.line('exit-address-family', 'A', undefined, 1);

  const sh = new ConfigWriter('#');
  sh.line('#!/usr/bin/env bash', 'A');
  sh.comment(headerLines(sw, 'sonic (operations CLI)', projectName).join('\n'));
  sh.line('set -euo pipefail', 'A');
  for (const [p, lanes] of breakoutPorts(sw)) {
    const i = sw.interfaces.find((x) => x.port === p)!;
    sh.line(`sudo config interface breakout ${sonicName(sw, { ...i, lane: 1 })} ${lanes}x${laneSpeed(sw, i)}G -f -l -v -y`, 'U', 'breakout mode strings come from the platform platform.json');
  }
  sh.line('sudo config load /etc/sonic/config_db.json -y', 'U', 'config load flags not checked against the documentation');
  if (sw.lossless) {
    sh.line('sudo config qos reload', 'V');
    sh.line('sudo config pfcwd start --action drop all 400 --restoration-time 400', 'V');
  }
  sh.line('sudo config save -y', 'V');
  sh.comment('verification');
  sh.line('show lldp table', 'V');
  if (sw.lossless) sh.lines(['show pfc counters', 'show queue counters'], 'V');
  if (breakoutPorts(sw).length) sh.line(`show interfaces breakout current-mode ${sonicName(sw, { ...sw.interfaces.find((x) => x.lanes > 1)!, lane: 1 })}`, 'V');
  notes.blank().comment(`${m.switches.length} switches in this bundle.`);
  return [
    { path: `${sw.hostname}/config_db.json`, content: JSON.stringify(cfg, null, 2) + '\n', mime: 'application/json' },
    { path: `${sw.hostname}/frr.conf`, content: frr.toString(), mime: 'text/plain' },
    { path: `${sw.hostname}/apply.sh`, content: sh.toString(), mime: 'text/x-shellscript' },
    { path: `${sw.hostname}/verify-notes.txt`, content: notes.toString(), mime: 'text/plain' },
  ];
}

// ───────────────────────────── NVIDIA Cumulus Linux 5.18 (NVUE) ─────────────────────────────

export const nvueName = (i: NosInterface) => (i.lanes > 1 ? `swp${i.port}s${i.lane - 1}` : `swp${i.port}`);

export function renderCumulus(sw: NosSwitch, _m: NosModel, projectName: string): GeneratedFile[] {
  const w = new ConfigWriter('#');
  w.line('#!/usr/bin/env bash', 'A');
  w.comment(headerLines(sw, 'cumulus-nvue (Cumulus Linux 5.18)', projectName).join('\n'));
  w.line('set -euo pipefail', 'A');
  w.line(`nv set system hostname ${sw.hostname}`, 'A');
  if (sw.loopback) w.line(`nv set interface lo ip address ${sw.loopback}/32`, 'A');
  for (const [p, lanes] of breakoutPorts(sw)) w.line(`nv set interface swp${p} link breakout ${lanes}x`, 'A');
  for (const i of sw.interfaces.filter((x) => x.lanes > 1)) w.line(`nv set interface ${nvueName(i)} link speed ${laneSpeed(sw, i)}G`, 'A');
  // integration v2 2차: peer description on every port (as SONiC / EOS / NX-OS / OS10 / Junos) so the NVUE file names its cabling
  for (const i of sw.interfaces) w.line(`nv set interface ${nvueName(i)} description "${desc(i)}"`, 'U', 'NVUE interface description syntax not checked against the documentation');
  for (const i of sw.interfaces) w.line(`nv set interface ${nvueName(i)} link mtu ${ROCE.mtu}`, 'A');
  for (const i of hosts(sw)) {
    if (i.ip) w.line(`nv set interface ${nvueName(i)} ip address ${i.ip}`, 'A');
    else if (i.vlan !== undefined) w.line(`nv set interface ${nvueName(i)} bridge domain br_default access ${i.vlan}`, 'U', 'access VLAN syntax not checked against the documentation');
  }
  for (const s of sw.svis) w.line(`nv set interface vlan${s.vlan} ip address ${s.ip}`, 'U', 'SVI syntax not checked against the documentation');
  if (sw.asn !== undefined) w.line(`nv set router bgp autonomous-system ${sw.asn}`, 'A');
  if (sw.loopback) w.line(`nv set router bgp router-id ${sw.loopback}`, 'A');
  for (const i of fabricPorts(sw)) w.line(`nv set vrf default router bgp neighbor ${nvueName(i)} remote-as external`, 'A');
  if (sw.loopback) w.line(`nv set vrf default router bgp address-family ipv4-unicast network ${sw.loopback}/32`, 'A');
  if (sw.hostBlock) w.line(`nv set vrf default router bgp address-family ipv4-unicast network ${sw.hostBlock}`, 'A');
  w.line('nv set vrf default router bgp path-selection multipath aspath-ignore enabled', 'A');
  if (sw.lossless) w.line('nv set qos roce', 'V');
  w.line('nv set system lldp state enabled', 'A');
  w.line('nv config apply', 'V');
  w.comment('verification: nv show qos roce · nv show system lldp · ptmctl (with /etc/ptm.d/topology.dot from the deployment bundle)');
  return [{ path: `${sw.hostname}.nvue.sh`, content: w.toString(), mime: 'text/x-shellscript' }];
}

// ───────────────────────────── Arista EOS ─────────────────────────────

export const eosName = (sw: NosSwitch, i: NosInterface) => `Ethernet${i.port}/${(i.lane - 1) * Math.max(1, Math.floor(lanesPerCage(sw.device.portGbps) / Math.max(1, i.lanes))) + 1}`;

export function renderEos(sw: NosSwitch, _m: NosModel, projectName: string): GeneratedFile[] {
  const w = new ConfigWriter('!', '   ');
  w.comment(headerLines(sw, 'arista-eos', projectName).join('\n'));
  w.line(`hostname ${sw.hostname}`, 'U', 'standard EOS, not checked against the documentation');
  w.line('ip routing', 'U');
  w.line('ip routing ipv6 interfaces', 'U', 'needed for IPv4 routes over IPv6 next hops');
  w.line('ipv6 unicast-routing', 'U');
  w.comment('');
  if (sw.lossless) {
    w.line(`qos map traffic-class ${ROCE.dataTc} to dscp ${ROCE.dataDscp}`, 'V');
    w.line(`qos map traffic-class ${CNP_TC['arista-eos']} to dscp ${ROCE.cnpDscp}`, 'V');
    w.comment('');
    w.line('qos profile AIDC-ROCE', 'A');
    w.lines(['qos trust dscp', 'priority-flow-control on', `priority-flow-control priority ${ROCE.pfcPriority} no-drop`], 'V', undefined, 1);
    w.comment('');
    w.line(`uc-tx-queue ${ROCE.dataTc}`, 'A', undefined, 1);
    w.lines([`random-detect ecn minimum-threshold ${ECN.eos.minSeg} segments maximum-threshold ${ECN.eos.maxSeg} segments max-mark-probability ${ECN.eos.prob} weight 0`, 'random-detect ecn count'], 'A', undefined, 2);
    w.comment('');
  }
  w.line('interface Loopback0', 'A');
  if (sw.loopback) w.line(`ip address ${sw.loopback}/32`, 'A', undefined, 1);
  for (const i of sw.interfaces) {
    w.comment('');
    w.line(`interface ${eosName(sw, i)}`, 'A');
    w.line(`description ${desc(i)}`, 'A', undefined, 1);
    w.line('load-interval 2', 'V', undefined, 1);
    w.line(`mtu ${ROCE.eosMtu}`, 'V', undefined, 1);
    if (i.lanes > 1) w.line(`speed ${laneSpeed(sw, i)}g-4`, 'U', 'by analogy to the verified "speed 200g-4"', 1);
    if (i.kind === 'host') {
      w.line('error-correction encoding reed-solomon', 'V', undefined, 1);
      if (i.ip) w.line(`ip address ${i.ip}`, 'A', undefined, 1);
      else if (i.vlan !== undefined) w.line(`switchport access vlan ${i.vlan}`, 'U', 'access VLAN syntax not checked against the documentation', 1);
    } else w.line('ipv6 enable', 'V', undefined, 1);
    if (sw.lossless) w.line('service-profile AIDC-ROCE', 'A', undefined, 1);
  }
  for (const s of sw.svis) {
    w.line(`interface Vlan${s.vlan}`, 'U', 'SVI syntax not checked against the documentation');
    w.line(`ip address ${s.ip}`, 'A', undefined, 1);
  }
  w.comment('');
  w.line(`router bgp ${sw.asn ?? '<ASN>'}`, sw.asn ? 'A' : 'U');
  if (sw.loopback) w.line(`router-id ${sw.loopback}`, 'V', undefined, 1);
  w.line(`maximum-paths ${maxPaths(sw)}`, 'A', undefined, 1);
  w.line('neighbor FABRIC peer group', 'U', undefined, 1);
  const peerAsn = sw.peerAsns.length === 1 ? String(sw.peerAsns[0]) : undefined;
  for (const i of fabricPorts(sw)) {
    if (peerAsn) w.line(`neighbor interface ${eosName(sw, i)} peer-group FABRIC remote-as ${peerAsn}`, 'A', undefined, 1);
    else w.line(`neighbor interface ${eosName(sw, i)} peer-group FABRIC peer-filter FABRIC_PEERS`, 'U', `${sw.peerAsns.length} peer ASNs — a single peer ASN uses "remote-as <asn>"; peer-filter form not verified`, 1);
  }
  w.comment('');
  w.line('address-family ipv4', 'A', undefined, 1);
  w.line('neighbor FABRIC activate', 'U', undefined, 2);
  w.line('neighbor FABRIC next-hop address-family ipv6 originate', 'A', undefined, 2);
  if (sw.loopback) w.line(`network ${sw.loopback}/32`, 'A', undefined, 2);
  if (sw.hostBlock) w.line(`network ${sw.hostBlock}`, 'A', undefined, 2);
  w.comment('LLDP is enabled by default on EOS (per-port "no lldp transmit" / "no lldp receive" exist).');
  return [{ path: `${sw.hostname}.eos.cfg`, content: w.toString(), mime: 'text/plain' }];
}

// ───────────────────────────── Cisco NX-OS 10.6(x) ─────────────────────────────

export const nxosName = (i: NosInterface) => (i.lanes > 1 ? `Ethernet1/${i.port}/${i.lane}` : `Ethernet1/${i.port}`);

export function renderNxos(sw: NosSwitch, _m: NosModel, projectName: string): GeneratedFile[] {
  const w = new ConfigWriter('!', '  ');
  w.comment(headerLines(sw, 'cisco-nxos (NX-OS 10.6(x))', projectName).join('\n'));
  w.line(`hostname ${sw.hostname}`, 'A');
  w.line('feature bgp', 'U', 'standard NX-OS, not checked against the documentation');
  w.line('feature lldp', 'U', 'standard NX-OS, not checked against the documentation');
  if (sw.svis.length) w.line('feature interface-vlan', 'U');
  const bo = breakoutPorts(sw);
  for (const [p, lanes] of bo) w.line(`interface breakout module 1 port ${p} map ${laneSpeed(sw, sw.interfaces.find((x) => x.port === p)!)}g-${lanes}x`, 'A');
  if (sw.lossless) {
    w.comment('');
    w.line('policy-map type network-qos AIDC-ROCE-NQ', 'A');
    w.line('class type network-qos c-8q-nq3', 'V', undefined, 1);
    w.lines([`mtu ${ROCE.mtu}`, `pause pfc-cos ${ROCE.pfcPriority}`], 'V', undefined, 2);
    w.line('class type network-qos c-8q-nq-default', 'V', undefined, 1);
    w.line(`mtu ${ROCE.mtu}`, 'V', undefined, 2);
    w.line('class-map type qos match-any CNP', 'V');
    w.line(`match dscp ${ROCE.cnpDscp}`, 'V', undefined, 1);
    w.line('class-map type qos match-any ROCEv2', 'V');
    w.line(`match dscp ${ROCE.dataDscp}`, 'V', undefined, 1);
    w.line('policy-map type qos AIDC-ROCE-CLASSIFY', 'A');
    w.line('class ROCEv2', 'V', undefined, 1);
    w.line(`set qos-group ${ROCE.dataTc}`, 'V', undefined, 2);
    w.line('class CNP', 'V', undefined, 1);
    w.line(`set qos-group ${CNP_TC['cisco-nxos']}`, 'V', undefined, 2);
    w.line('class class-default', 'V', undefined, 1);
    w.line('set qos-group 0', 'V', undefined, 2);
    w.line('policy-map type queuing AIDC-ROCE-EGRESS', 'A');
    for (const q of [6, 5, 4, 2, 1]) {
      w.line(`class type queuing c-out-8q-q${q}`, 'A', undefined, 1);
      w.line('bandwidth remaining percent 0', 'A', undefined, 2);
    }
    w.line('class type queuing c-out-8q-q3', 'V', undefined, 1);
    w.lines(['bandwidth remaining percent 50', `random-detect minimum-threshold ${ECN.nxos.minKb} kbytes maximum-threshold ${ECN.nxos.maxKb} kbytes drop-probability ${ECN.nxos.prob} weight 0 ecn`], 'A', undefined, 2);
    w.line('class type queuing c-out-8q-q-default', 'V', undefined, 1);
    w.line('bandwidth remaining percent 50', 'V', undefined, 2);
    w.line('class type queuing c-out-8q-q7', 'V', undefined, 1);
    w.line('priority level 1', 'V', undefined, 2);
    w.line('system qos', 'V');
    w.lines(['service-policy type network-qos AIDC-ROCE-NQ', 'service-policy type queuing output AIDC-ROCE-EGRESS'], 'A', undefined, 1);
  }
  w.comment('');
  w.line('interface loopback0', 'A');
  if (sw.loopback) w.line(`ip address ${sw.loopback}/32`, 'A', undefined, 1);
  for (const i of sw.interfaces) {
    w.line(`interface ${nxosName(i)}`, 'A');
    w.line(`description ${desc(i)}`, 'U', 'description is standard NX-OS, not checked against the documentation', 1);
    w.line(`mtu ${ROCE.mtu}`, 'V', undefined, 1);
    if (sw.lossless) {
      w.line('priority-flow-control mode on', 'V', undefined, 1);
      if (i.kind === 'host') w.line('priority-flow-control watch-dog-interval on', 'V', undefined, 1);
      w.line('service-policy type qos input AIDC-ROCE-CLASSIFY', 'A', undefined, 1);
    }
    if (i.kind === 'host') {
      if (i.ip) w.line(`ip address ${i.ip}`, 'A', undefined, 1);
      else if (i.vlan !== undefined) w.lines(['switchport', `switchport access vlan ${i.vlan}`], 'U', 'access VLAN syntax not checked against the documentation', 1);
    } else {
      w.lines(['ipv6 address use-link-local-only', 'ipv6 link-local use-bia', 'ip forward'], 'V', undefined, 1);
    }
    w.line('no shutdown', 'V', undefined, 1);
  }
  for (const s of sw.svis) {
    w.line(`interface Vlan${s.vlan}`, 'U');
    w.line(`ip address ${s.ip}`, 'A', undefined, 1);
  }
  w.line(`router bgp ${sw.asn ?? '<ASN>'}`, 'U', '4-byte asplain notation not confirmed for NX-OS 10.6');
  if (sw.loopback) w.line(`router-id ${sw.loopback}`, 'A', undefined, 1);
  w.line('address-family ipv4 unicast', 'A', undefined, 1);
  if (sw.loopback) w.line(`network ${sw.loopback}/32`, 'A', undefined, 2);
  if (sw.hostBlock) w.line(`network ${sw.hostBlock}`, 'A', undefined, 2);
  w.line(`maximum-paths ${maxPaths(sw)}`, 'A', undefined, 2);
  w.line('bestpath as-path multipath-relax', 'A', undefined, 1);
  for (const i of fabricPorts(sw)) {
    w.line(`neighbor ${nxosName(i)}`, 'A', undefined, 1);
    const peer = sw.peerAsns.length === 1 ? sw.peerAsns[0] : undefined;
    w.line(`remote-as ${peer ?? 'external'}`, peer ? 'A' : 'U', peer ? undefined : 'remote-as external keyword not confirmed for NX-OS', 2);
    w.line('address-family ipv4 unicast', 'A', undefined, 2);
  }
  return [{ path: `${sw.hostname}.nxos.cfg`, content: w.toString(), mime: 'text/plain' }];
}

// ───────────────────────────── Dell Enterprise SONiC (sonic-cli) / OS10 ─────────────────────────────

export const dellName = (i: NosInterface) => (i.lanes > 1 ? `Eth1/${i.port}/${i.lane}` : `Eth1/${i.port}`);

export function renderDell(sw: NosSwitch, _m: NosModel, projectName: string): GeneratedFile[] {
  const w = new ConfigWriter('!');
  w.comment(headerLines(sw, 'dell-os10 → Dell Enterprise SONiC sonic-cli (Z9664F-class RoCE template)', projectName).join('\n'));
  w.comment('This file targets Enterprise SONiC; SmartFabric OS10 syntax was not checked (its manuals require a login).');
  w.line('interface-naming standard extended', 'V');
  if (sw.lossless) {
    w.line('roce enable', 'V');
    w.comment('roce enable creates most of the QoS objects below and may ask for a reboot; the explicit lines keep the plan values visible.');
    w.lines(['qos wred-policy ROCE', `green minimum-threshold ${ECN.dell.minKb} maximum-threshold ${ECN.dell.maxKb} drop-probability ${ECN.dell.prob}`, 'ecn green'], 'A');
    w.lines(['qos map dscp-tc ROCE', 'dscp 0-3,5-23,25,27-47,49-63 traffic-class 0', 'dscp 24,26 traffic-class 3', 'dscp 4 traffic-class 4', `dscp ${ROCE.cnpDscp} traffic-class ${CNP_TC['dell-os10']}`], 'V');
    w.lines(['qos map tc-pg ROCE', 'traffic-class 3 priority-group 3', 'traffic-class 4 priority-group 4', 'traffic-class 0-2,5-7 priority-group 7'], 'V');
    w.line('qos scheduler-policy ROCE', 'U', 'scheduler syntax not checked against the documentation (DWRR 50 for queues 0/3/4, strict for queue 6)');
    w.line('queue 0 type dwrr weight 50', 'U');
    w.line('queue 3 type dwrr weight 50', 'U');
    w.line('queue 4 type dwrr weight 50', 'U');
    w.line('queue 6 type strict', 'U');
  }
  w.comment('');
  w.line('interface Loopback 0', 'A');
  if (sw.loopback) w.line(`ip address ${sw.loopback}/32`, 'A');
  for (const i of sw.interfaces) {
    w.comment('');
    w.line(`interface ${dellName(i)}`, 'A');
    w.lines([`description ${desc(i)}`, `mtu ${ROCE.mtu}`, `speed ${laneSpeed(sw, i) * 1000}`, 'fec RS', 'unreliable-los auto', 'no shutdown'], 'A');
    if (i.kind === 'host' && i.ip) w.line(`ip address ${i.ip}`, 'A');
    else if (i.kind === 'host' && i.vlan !== undefined) w.line(`switchport access Vlan ${i.vlan}`, 'U', 'access VLAN syntax not checked against the documentation');
    else w.line('ipv6 enable', 'V');
    if (sw.lossless) {
      w.lines(['queue 3 wred-policy ROCE', 'scheduler-policy ROCE', 'qos-map dscp-tc ROCE', 'qos-map tc-queue ROCE', 'qos-map tc-pg ROCE', 'qos-map pfc-priority-queue ROCE', 'qos-map pfc-priority-pg ROCE', `priority-flow-control priority ${ROCE.pfcPriority}`, 'priority-flow-control watchdog action drop', 'priority-flow-control watchdog on detect-time 200', 'priority-flow-control watchdog restore-time 400'], 'V');
    }
  }
  for (const s of sw.svis) {
    w.line(`interface Vlan${s.vlan}`, 'U');
    w.line(`ip address ${s.ip}`, 'A');
  }
  w.comment('');
  w.comment('BGP unnumbered for Dell Enterprise SONiC — every line below is unverified.');
  w.line(`router bgp ${sw.asn ?? '<ASN>'}`, 'U');
  if (sw.loopback) w.line(`router-id ${sw.loopback}`, 'U', undefined, 1);
  w.line('bestpath as-path multipath-relax', 'U', undefined, 1);
  w.line('address-family ipv4 unicast', 'U', undefined, 1);
  w.line(`maximum-paths ${maxPaths(sw)}`, 'U', undefined, 2);
  for (const i of fabricPorts(sw)) {
    w.line(`neighbor interface ${dellName(i)}`, 'U', undefined, 1);
    w.line('remote-as external', 'U', undefined, 2);
    w.line('address-family ipv4 unicast', 'U', undefined, 2);
    w.line('activate', 'U', undefined, 3);
  }
  w.line('write memory', 'V');
  return [{ path: `${sw.hostname}.sonic-cli.cfg`, content: w.toString(), mime: 'text/plain' }];
}

// ───────────────────────────── Juniper QFX5240 (Junos OS Evolved) ─────────────────────────────

export const junosName = (i: NosInterface) => (i.lanes > 1 ? `et-0/0/${i.port - 1}:${i.lane - 1}` : `et-0/0/${i.port - 1}`);

export function renderJunos(sw: NosSwitch, _m: NosModel, projectName: string): GeneratedFile[] {
  const s = new ConfigWriter('#');
  s.comment(headerLines(sw, 'juniper-junos (set format; load set, then show | compare, commit)', projectName).join('\n'));
  s.line(`set system host-name ${sw.hostname}`, 'U');
  if (sw.loopback) s.line(`set interfaces lo0 unit 0 family inet address ${sw.loopback}/32`, 'A');
  for (const [p, lanes] of breakoutPorts(sw)) {
    s.line(`set interfaces et-0/0/${p - 1} number-of-sub-ports ${lanes}`, 'A');
    s.line(`set interfaces et-0/0/${p - 1} speed ${laneSpeed(sw, sw.interfaces.find((x) => x.port === p)!)}g`, 'A');
  }
  for (const i of sw.interfaces) {
    s.line(`set interfaces ${junosName(i)} mtu ${ROCE.mtu}`, 'A');
    s.line(`set interfaces ${junosName(i)} description "${desc(i)}"`, 'U', 'description statement not checked against the documentation');
    if (i.kind === 'host' && i.ip) s.line(`set interfaces ${junosName(i)} unit 0 family inet address ${i.ip}`, 'A');
    else if (i.kind === 'host' && i.vlan !== undefined) s.line(`set interfaces ${junosName(i)} unit 0 family ethernet-switching vlan members ${i.vlan}`, 'A');
  }
  const up = fabricPorts(sw);
  for (const i of up) s.line(`set interfaces interface-range fabric-links member ${junosName(i)}`, 'A');
  if (up.length) s.line('set interfaces interface-range fabric-links unit 0 family inet6', 'A');
  s.lines(['set policy-options policy-statement DIRECT-RTS from protocol direct', 'set policy-options policy-statement DIRECT-RTS then accept', 'set policy-options policy-statement lb then load-balance per-packet'], 'A');
  if (sw.peerAsns.length) s.line(`set policy-options as-list fabric-peers members [ ${sw.peerAsns.join(' ')} ]`, 'U', '4-byte values in as-list not confirmed');
  if (sw.asn !== undefined) s.line(`set routing-options autonomous-system ${sw.asn}`, 'A');
  s.lines(['set routing-options forwarding-table export lb', 'set routing-options forwarding-table ecmp-fast-reroute'], 'A');
  if (up.length) {
    s.line('set protocols router-advertisement interface fabric-links', 'A');
    s.lines([
      'set protocols bgp group underlay family inet unicast extended-nexthop',
      'set protocols bgp group underlay family inet6 unicast',
      'set protocols bgp group underlay export DIRECT-RTS',
      'set protocols bgp group underlay multipath multiple-as',
      'set protocols bgp group underlay dynamic-neighbor fabric peer-auto-discovery family inet6 ipv6-nd',
      'set protocols bgp group underlay dynamic-neighbor fabric peer-auto-discovery interface fabric-links',
      'set protocols bgp group underlay peer-as-list fabric-peers',
    ], 'A');
  }
  s.comment('Production: restrict DIRECT-RTS to lo0 and the host /31 block with a prefix-list.');
  s.line('set protocols lldp interface all', 'U');

  const c = new ConfigWriter('#', '    ');
  c.comment(headerLines(sw, 'juniper-junos (curly format; load merge, then show | compare, commit)', projectName).join('\n'));
  const bits6 = (d: number) => d.toString(2).padStart(6, '0');
  const ecmp = Math.min(128, maxPaths(sw) * 2);
  c.comment('ECMP width and per-packet load balancing for the fabric (AIDC Studio template).');
  c.lines(['chassis {', `    maximum-ecmp ${ecmp};`, '}', 'routing-options {', `    maximum-ecmp ${ecmp};`, '    forwarding-table {', '        export ECMP-PER-PACKET;', '        ecmp-fast-reroute;', '    }', '}'], 'A');
  c.lines(['policy-options {', '    policy-statement ECMP-PER-PACKET {', '        then load-balance per-packet;', '    }', '}'], 'A');
  c.comment(`Dynamic load balancing in flowlet mode: inactivity ${JUNOS_DLB.inactivityMicros} us, flowset table ${JUNOS_DLB.flowsetTable}, reassignment when the quality delta is at least ${JUNOS_DLB.qualityDelta} (planning defaults — tune per platform).`);
  c.lines(['forwarding-options {', '    enhanced-hash-key {', '        ecmp-dlb {', '            flowlet {', `                inactivity-interval ${JUNOS_DLB.inactivityMicros};`, `                flowset-table-size ${JUNOS_DLB.flowsetTable};`, '                reassignment {', `                    prob-threshold ${JUNOS_DLB.probThreshold};`, `                    quality-delta ${JUNOS_DLB.qualityDelta};`, '                }', '            }', '        }', '    }', '}'], 'A');
  if (sw.lossless) {
    const lossQ = JUNOS_LOSSLESS_QUEUE;
    c.comment(`RoCEv2 lossless class: DSCP ${ROCE.dataDscp} → forwarding class ROCE-LOSSLESS (queue ${lossQ}, PFC priority ${ROCE.pfcPriority}); CNP DSCP ${ROCE.cnpDscp} → class ROCE-CNP (strict priority).`);
    c.line('class-of-service {', 'U', 'the class-of-service hierarchy below is an AIDC Studio template; statement placement not checked against vendor documentation');
    c.lines([
      '    forwarding-classes {',
      `        class ROCE-CNP queue-num ${JUNOS_CNP_QUEUE};`,
      `        class ROCE-LOSSLESS queue-num ${lossQ} no-loss pfc-priority ${ROCE.pfcPriority};`,
      '    }',
      '    classifiers {',
      '        dscp ROCE-DSCP {',
      `            forwarding-class ROCE-LOSSLESS { loss-priority low code-points ${bits6(ROCE.dataDscp)}; }`,
      `            forwarding-class ROCE-CNP { loss-priority low code-points ${bits6(ROCE.cnpDscp)}; }`,
      '        }',
      '    }',
      '    drop-profiles {',
      `        ROCE-ECN { interpolate { fill-level [ ${ECN.junos.fillMin} ${ECN.junos.fillMax} ]; drop-probability [ 0 100 ]; } }`,
      '    }',
      '    congestion-notification-profile {',
      '        ROCE-PFC {',
      `            input { dscp { code-point ${bits6(ROCE.dataDscp)} { pfc; } } }`,
      `            output { ieee-802.1 { code-point ${ROCE.pfcPriority.toString(2).padStart(3, '0')} { flow-control-queue ${lossQ}; } } }`,
      '        }',
      '    }',
      '    schedulers {',
      '        ROCE-LOSSLESS-SCHED { drop-profile-map loss-priority any protocol any drop-profile ROCE-ECN; explicit-congestion-notification; }',
      '        ROCE-CNP-SCHED { transmit-rate percent 5; priority strict-high; }',
      '    }',
      '    scheduler-maps {',
      '        ROCE-MAP { forwarding-class ROCE-LOSSLESS scheduler ROCE-LOSSLESS-SCHED; forwarding-class ROCE-CNP scheduler ROCE-CNP-SCHED; }',
      '    }',
      '    interfaces {',
      '        et-* { congestion-notification-profile ROCE-PFC; scheduler-map ROCE-MAP; unit * { classifiers { dscp ROCE-DSCP; } } }',
      '    }',
    ], 'A');
    c.line('}', 'A');
    c.comment(`The lossless class uses queue ${lossQ} while the PFC priority is ${ROCE.pfcPriority}; keep the NIC and switch mappings consistent.`);
  }
  return [
    { path: `${sw.hostname}.set`, content: s.toString(), mime: 'text/plain' },
    { path: `${sw.hostname}.conf`, content: c.toString(), mime: 'text/plain' },
  ];
}
