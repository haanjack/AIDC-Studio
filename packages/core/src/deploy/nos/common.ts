// Shared pieces of the NOS configuration generators (stream T7, DECISIONS-v2 #9, DECISIONS-v2-2 §C).
//
// Every emitted line comes from AIDC Studio's own templates (no vendor example blocks are copied). Verification flags:
// V = fixed command whose syntax was checked against the vendor documentation listed in README SOURCES, A = the same with
// plan values substituted, U = syntax not checked against vendor documentation. Every U line is emitted with a comment line containing "verify"
// placed directly above it (CLI parsers do not accept trailing comments), so a lab check can grep for them.

export type Verify = 'V' | 'A' | 'U';

export const VERIFY_TAG = 'verify:';

/** Line-oriented config writer with a comment prefix and verify annotations. */
export class ConfigWriter {
  private readonly out: string[] = [];
  constructor(private readonly c: string, private readonly indentUnit = ' ') {}
  comment(text: string): this {
    for (const l of text.split('\n')) this.out.push(l ? `${this.c} ${l}` : this.c);
    return this;
  }
  blank(): this {
    this.out.push('');
    return this;
  }
  /** a config line; `U` lines get a `<c> verify: …` comment line above */
  line(text: string, v: Verify = 'A', why?: string, depth = 0): this {
    const pad = this.indentUnit.repeat(depth);
    if (v === 'U') this.out.push(`${pad}${this.c} ${VERIFY_TAG} unverified syntax${why ? ` — ${why}` : ' (not checked against vendor documentation)'}`);
    this.out.push(`${pad}${text}`);
    return this;
  }
  lines(texts: string[], v: Verify = 'A', why?: string, depth = 0): this {
    texts.forEach((t, i) => this.line(t, i === 0 || v !== 'U' ? v : 'A', why, depth));
    return this;
  }
  toString(): string {
    return this.out.join('\n') + '\n';
  }
}

/** RoCEv2 lossless profile defaults (DECISIONS-v2-2 §C). */
export const ROCE = {
  dataDscp: 26,
  dataTc: 3,
  pfcPriority: 3,
  cnpDscp: 48,
  /** switch MTU (Arista example uses 9214), host MTU 9000 */
  mtu: 9216,
  eosMtu: 9214,
  hostMtu: 9000,
  /** NCCL_IB_TC = DSCP 26 << 2 | ECT(0) (derived) */
  ncclIbTc: 106,
} as const;

/** CNP traffic class per NOS default (DECISIONS-v2-2 §C): NVIDIA Cumulus · SONiC · Dell SONiC 6, Arista · Cisco 7. */
export const CNP_TC: Record<string, number> = { sonic: 6, 'cumulus-nvue': 6, 'dell-os10': 6, 'arista-eos': 7, 'cisco-nxos': 7, 'juniper-junos': 3 };

export function cnpComment(target: string): string {
  const tc = CNP_TC[target];
  return target === 'juniper-junos'
    ? `CNP (DSCP 48) → forwarding class ROCE-CNP on queue 3, lossless class ROCE-LOSSLESS on queue 4 with PFC priority 3 (AIDC Studio Junos template). The CNP class must match the NIC firmware congestion-control profile.`
    : `CNP DSCP 48 → traffic class ${tc} (NOS default for this target). It must match the NIC firmware congestion-control profile (NVIDIA / SONiC / Dell use 6, Arista / Cisco examples use 7).`;
}

export const SOURCES: Record<string, { label: string; url: string }[]> = {
  common: [
    { label: 'RFC 7938 Use of BGP for Routing in Large-Scale Data Centers', url: 'https://www.rfc-editor.org/rfc/rfc7938.txt' },
    { label: 'RFC 6996 Autonomous System Reservation for Private Use', url: 'https://www.rfc-editor.org/rfc/rfc6996.txt' },
    { label: 'RFC 8950 IPv4 NLRI with an IPv6 Next Hop (BGP unnumbered)', url: 'https://www.rfc-editor.org/rfc/rfc8950.txt' },
    { label: 'AMD Instinct Cluster Networking Guide — RoCE network configuration', url: 'https://instinct.docs.amd.com/projects/gpu-cluster-networking/en/latest/how-to/roce-network-config.html' },
  ],
  sonic: [
    { label: 'SONiC Configuration wiki', url: 'https://github.com/sonic-net/SONiC/wiki/Configuration' },
    { label: 'sonic-utilities Command Reference', url: 'https://github.com/sonic-net/sonic-utilities/blob/master/doc/Command-Reference.md' },
    { label: 'sonic-buildimage qos_config.j2', url: 'https://github.com/sonic-net/sonic-buildimage/blob/master/files/build_templates/qos_config.j2' },
    { label: 'FRR BGP documentation', url: 'https://docs.frrouting.org/en/latest/bgp.html' },
  ],
  'cumulus-nvue': [
    { label: 'Cumulus Linux 5.18 — RDMA over Converged Ethernet (RoCE)', url: 'https://docs.nvidia.com/networking-ethernet-software/cumulus-linux/Layer-1-and-Switch-Ports/Quality-of-Service/RDMA-over-Converged-Ethernet-RoCE/' },
    { label: 'Cumulus Linux 5.18 User Guide (BGP, switch ports, LLDP, PTM)', url: 'https://docs.nvidia.com/networking-ethernet-software/cumulus-linux/' },
  ],
  'arista-eos': [
    { label: 'Arista AVD eos_cli_config_gen templates (router-bgp.j2, ethernet-interfaces.j2)', url: 'https://github.com/aristanetworks/avd/tree/devel/python-avd/pyavd/_eos_cli_config_gen/j2templates/eos' },
    { label: 'Arista EOS manual — BGP', url: 'https://www.arista.com/en/um-eos/eos-border-gateway-protocol-bgp' },
  ],
  'cisco-nxos': [
    { label: 'Cisco Nexus 9000 NX-OS 10.6(x) Unicast Routing — Configuring BGP', url: 'https://www.cisco.com/c/en/us/td/docs/dcn/nx-os/nexus9000/106x/configuration/unicast-routing-configuration/cisco-nexus-9000-series-nx-os-unicast-routing-configuration-guide/configuring-bgp.html' },
  ],
  'dell-os10': [
    { label: 'AMD guide — DCQCN on Dell Z9664F-O64 (Enterprise SONiC sonic-cli)', url: 'https://instinct.docs.amd.com/projects/gpu-cluster-networking/en/latest/how-to/roce-network-config.html' },
  ],
  'juniper-junos': [
    { label: 'Juniper — BGP Auto-Discovered Neighbors', url: 'https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/topic-map/bgp-auto-discovered-neighbors.html' },
  ],
  'ib-ufm': [
    { label: 'OpenSM partition-config.txt', url: 'https://github.com/linux-rdma/opensm/blob/master/doc/partition-config.txt' },
    { label: 'NVIDIA SHARP 3.16.0 installation', url: 'https://networking-docs.nvidia.com/sharpum/3.16.0/nvidia-sharp-installation' },
    { label: 'HPC-X 2.51 NCCL-RDMA-SHARP plugins', url: 'https://networking-docs.nvidia.com/hpcxum/2.51/nccl-rdma-sharp-plugins' },
    { label: 'NCCL environment variables', url: 'https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html' },
  ],
};

export const ipToInt = (s: string): number | undefined => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(s);
  return m ? (((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + +m[4]) : undefined;
};
export const intToIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Smallest aligned prefix containing every address (used to originate a leaf's host block). */
export function coveringPrefix(ips: number[]): string | undefined {
  if (!ips.length) return undefined;
  const lo = Math.min(...ips), hi = Math.max(...ips);
  for (let p = 32; p >= 0; p--) {
    const mask = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
    if (((lo & mask) >>> 0) === ((hi & mask) >>> 0)) return `${intToIp((lo & mask) >>> 0)}/${p}`;
  }
  return undefined;
}
