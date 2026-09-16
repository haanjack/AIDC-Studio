import { describe, expect, it } from 'vitest';
import { NOS_TARGETS, generateNosConfigs, type GeneratedFile, type NosTarget } from '../src/index.ts';
import { nosFixture } from './nos-fixtures.ts';

const fx = nosFixture();
const gen = (t: NosTarget) => generateNosConfigs(fx.project, fx.analysis, fx.plan, t, { cableSchedule: fx.rows });
const byTarget = Object.fromEntries(NOS_TARGETS.map((t) => [t, gen(t)])) as Record<NosTarget, GeneratedFile[]>;
const file = (t: NosTarget, re: RegExp) => {
  const f = byTarget[t].find((x) => re.test(x.path));
  if (!f) throw new Error(`${t}: no file matching ${re} in ${byTarget[t].map((x) => x.path).join(', ')}`);
  return f.content;
};
const LEAF = 'h1-be-lf001';
const SPINE = 'h1-be-sp001';

describe('NOS configs — common rules', () => {
  it('every target ships a README with assumptions, verification status and source links', () => {
    for (const t of NOS_TARGETS) {
      const readme = byTarget[t][0];
      expect(readme.path).toBe('README.txt');
      expect(readme.content).toContain('ASSUMPTIONS');
      expect(readme.content).toContain('VERIFICATION STATUS');
      expect(readme.content).toMatch(/SOURCES[\s\S]*https:\/\//);
    }
  });

  it('generates one file set per plan switch (2 leaves + 2 spines) for Ethernet targets', () => {
    for (const t of NOS_TARGETS.filter((x) => x !== 'ib-ufm')) {
      const hosts = new Set(byTarget[t].filter((f) => /h1-be-(lf|sp)\d{3}/.test(f.path)).map((f) => /h1-be-(lf|sp)\d{3}/.exec(f.path)![0]));
      expect([...hosts].sort(), t).toEqual(['h1-be-lf001', 'h1-be-lf002', 'h1-be-sp001', 'h1-be-sp002']);
      expect(byTarget[t].some((f) => f.path === 'switches.csv'), t).toBe(true);
    }
  });

  it('no undefined / NaN, and every "verify:" note is a comment line directly above a config line', () => {
    for (const t of NOS_TARGETS) {
      for (const f of byTarget[t]) {
        expect(f.content, `${t}/${f.path}`).not.toMatch(/undefined|NaN|\[object/);
        if (f.path === 'README.txt' || f.path.endsWith('verify-notes.txt') || f.path.endsWith('.json') || f.path.endsWith('.csv')) continue;
        const lines = f.content.split('\n');
        lines.forEach((l, i) => {
          if (!l.includes('verify:')) return;
          expect(l.trim(), `${t}/${f.path}:${i + 1}`).toMatch(/^(#|!|\/\/)/);
          const next = lines[i + 1] ?? '';
          expect(next.trim().length, `${t}/${f.path}:${i + 2}`).toBeGreaterThan(0);
          expect(next.trim(), `${t}/${f.path}:${i + 2}`).not.toMatch(/^(#|!|\/\/)/);
        });
      }
    }
  });

  it('CNP traffic class follows the NOS default with the NIC firmware note', () => {
    for (const [t, tc] of [['sonic', 6], ['cumulus-nvue', 6], ['dell-os10', 6], ['arista-eos', 7], ['cisco-nxos', 7]] as const) {
      const leaf = byTarget[t].find((f) => f.path.includes(LEAF) && !f.path.endsWith('.json'))!.content;
      expect(leaf, t).toContain(`CNP DSCP 48 → traffic class ${tc} (NOS default for this target). It must match the NIC firmware congestion-control profile`);
    }
  });

  it('is deterministic', () => {
    expect(gen('arista-eos')).toEqual(byTarget['arista-eos']);
  });
});

describe('NOS configs — required stanzas per target', () => {
  const lo = fx.plan.loopbacks[0].ip;
  const leafAsn = fx.plan.asns[0].asn;
  const gw = fx.plan.hosts[0].gw!;

  it('SONiC: config_db.json (metadata, loopback, RoCE DSCP/TC/PFC/ECN maps, /31 host ports, unnumbered fabric) + FRR + CLI', () => {
    const db = JSON.parse(file('sonic', new RegExp(`${LEAF}/config_db.json$`)));
    expect(db.DEVICE_METADATA.localhost).toMatchObject({ hostname: LEAF, bgp_asn: String(leafAsn), docker_routing_config_mode: 'split', type: 'LeafRouter' });
    expect(db.LOOPBACK_INTERFACE).toHaveProperty([`Loopback0|${lo}/32`]);
    expect(Object.keys(db.DSCP_TO_TC_MAP.ROCE)).toHaveLength(64);
    expect(db.DSCP_TO_TC_MAP.ROCE).toMatchObject({ '26': '3', '48': '6', '0': '0' });
    const qos = Object.values(db.PORT_QOS_MAP)[0] as Record<string, string>;
    expect(qos).toMatchObject({ pfc_enable: '3', pfcwd_sw_enable: '3' });
    expect(db.WRED_PROFILE.ROCE_LOSSLESS).toMatchObject({ ecn: 'ecn_all' });
    expect(Object.keys(db.INTERFACE)).toContain(`Ethernet0|${gw}/31`);
    expect(Object.values(db.INTERFACE)).toContainEqual({ ipv6_use_link_local_only: 'enable' });
    expect(Object.values(db.PORT).every((p) => (p as { mtu: string }).mtu === '9216')).toBe(true);
    const frr = file('sonic', new RegExp(`${LEAF}/frr.conf$`));
    expect(frr).toContain(`router bgp ${leafAsn}`);
    expect(frr).toContain(`bgp router-id ${lo}`);
    expect(frr).toMatch(/neighbor Ethernet\d+ interface peer-group FABRIC/);
    expect(frr).toMatch(/maximum-paths \d+/);
    const sh = file('sonic', new RegExp(`${LEAF}/apply.sh$`));
    expect(sh).toContain('sudo config pfcwd start --action drop all 400 --restoration-time 400');
    expect(sh).toContain('sudo config interface breakout Ethernet0 2x400G');
    expect(sh).toContain('show lldp table');
  });

  it('Cumulus NVUE: hostname, loopback, breakout, MTU, /31, BGP unnumbered, RoCE, LLDP, apply', () => {
    const c = file('cumulus-nvue', new RegExp(`${LEAF}.nvue.sh$`));
    for (const s of [`nv set system hostname ${LEAF}`, `nv set interface lo ip address ${lo}/32`, 'nv set interface swp1 link breakout 2x', 'nv set interface swp1s0 link speed 400G', 'link mtu 9216', `nv set interface swp1s0 ip address ${gw}/31`, `nv set router bgp autonomous-system ${leafAsn}`, 'nv set vrf default router bgp neighbor swp33 remote-as external', 'path-selection multipath aspath-ignore enabled', 'nv set qos roce', 'nv set system lldp state enabled', 'nv config apply']) expect(c).toContain(s);
  });

  it('Arista EOS: DCQCN QoS profile, CNP TC 7, MTU 9214, /31 host port, BGP unnumbered via IPv6 next hop', () => {
    const e = file('arista-eos', new RegExp(`${LEAF}.eos.cfg$`));
    for (const s of ['qos map traffic-class 3 to dscp 26', 'qos map traffic-class 7 to dscp 48', 'priority-flow-control priority 3 no-drop', 'random-detect ecn minimum-threshold 2000 segments maximum-threshold 10000 segments max-mark-probability 20 weight 0', 'mtu 9214', `ip address ${gw}/31`, 'service-profile AIDC-ROCE', 'ipv6 enable', `router bgp ${leafAsn}`, 'neighbor FABRIC next-hop address-family ipv6 originate']) expect(e).toContain(s);
    expect(e).toMatch(/neighbor interface Ethernet33\/1 peer-group FABRIC remote-as 4200200000/);
    expect(e).toContain('interface Ethernet1/5'); // lane 2 of the 800G cage
  });

  it('Cisco NX-OS: breakout, network-qos PFC cos 3, classification DSCP 26/48 → qos-group 3/7, ECN queuing, link-local BGP', () => {
    const n = file('cisco-nxos', new RegExp(`${LEAF}.nxos.cfg$`));
    for (const s of ['interface breakout module 1 port 1 map 400g-2x', 'pause pfc-cos 3', 'match dscp 26', 'match dscp 48', 'set qos-group 7', 'random-detect minimum-threshold 950 kbytes maximum-threshold 3000 kbytes drop-probability 7 weight 0 ecn', 'priority level 1', 'interface Ethernet1/1/1', `ip address ${gw}/31`, 'ipv6 address use-link-local-only', 'ipv6 link-local use-bia', 'ip forward', 'priority-flow-control mode on', 'neighbor Ethernet1/33']) expect(n).toContain(s);
  });

  it('Dell Enterprise SONiC: roce enable, WRED ECN green, DSCP maps with CNP TC 6, PFC watchdog; unverified BGP flagged', () => {
    const d = file('dell-os10', new RegExp(`${LEAF}.sonic-cli.cfg$`));
    for (const s of ['roce enable', 'ecn green', 'dscp 24,26 traffic-class 3', 'dscp 48 traffic-class 6', 'priority-flow-control priority 3', 'priority-flow-control watchdog on detect-time 200', 'interface Eth1/1/1', `ip address ${gw}/31`, 'mtu 9216']) expect(d).toContain(s);
    expect(d).toMatch(/verify:[^\n]*\n\s*router bgp /);
  });

  it('Juniper Junos: sub-ports, /31 host unit, BGP auto-discovered neighbours, CoS no-loss queue 4 / PFC 3', () => {
    const s = file('juniper-junos', new RegExp(`${LEAF}.set$`));
    for (const x of ['set interfaces et-0/0/0 number-of-sub-ports 2', `set interfaces et-0/0/0:0 unit 0 family inet address ${gw}/31`, `set routing-options autonomous-system ${leafAsn}`, 'peer-auto-discovery family inet6 ipv6-nd', 'set protocols bgp group underlay family inet unicast extended-nexthop', 'mtu 9216']) expect(s).toContain(x);
    const c = file('juniper-junos', new RegExp(`${LEAF}.conf$`));
    for (const x of ['class ROCE-LOSSLESS queue-num 4 no-loss pfc-priority 3', 'code-points 110000', 'code-points 011010', 'maximum-ecmp ', 'fill-level [ 45 90 ]', 'export ECMP-PER-PACKET']) expect(c).toContain(x);
  });

  it('spines peer with every leaf and carry no host block', () => {
    const frr = file('sonic', new RegExp(`${SPINE}/frr.conf$`));
    expect((frr.match(/neighbor Ethernet\d+ interface peer-group FABRIC/g) ?? []).length).toBe(2);
    expect(frr).not.toMatch(/network 10\.64\./);
  });

  it('InfiniBand: OpenSM partitions (default partition), SM options, SHARP notes', () => {
    expect(file('ib-ufm', /partitions.conf$/)).toContain('Default=0x7fff,ipoib:ALL=full;');
    expect(file('ib-ufm', /opensm-options.txt$/)).toContain('-Z both');
    expect(file('ib-ufm', /sharp-notes.txt$/)).toContain('sharp_enabled = true');
    expect(byTarget['ib-ufm'].some((f) => f.path === 'NOT-APPLICABLE.txt')).toBe(true); // fixture fabric is RoCE
  });
});

describe('NOS configs — scope', () => {
  it('an empty IP plan yields only README + inventory and says so', () => {
    const files = generateNosConfigs(fx.project, fx.analysis, { blocks: [], loopbacks: [], asns: [], p2p: [], hosts: [], oob: [] }, 'sonic', { cableSchedule: fx.rows });
    expect(files.map((f) => f.path)).toEqual(['README.txt', 'switches.csv']);
    expect(files[0].content).toContain('The IP plan is empty');
  });
});
