// Measurable load-balancing efficiency η (stream T2, DECISIONS-v2-2 F1 + §C, docs/research/r2-eta.md).
//
// Definitions (r2-eta.md §1):
//   η_total  = busbw_large ÷ B_nom           busbw_large = mean out-of-place busbw over the 3 largest sizes ≥ 1 GiB (plateau)
//   η_host   = busbw(single leaf) ÷ B_nom     (the traffic engine's NIC busbw factor; default 0.95, ETA_HOST_SOURCE)
//   η_fabric = busbw(cross-spine) ÷ busbw(single leaf)   (the traffic engine's η on spine/core tiers; ETA_SOURCES per class)
//   B_nom    = r·L/8 per rank for ring all_reduce / all_gather / reduce_scatter (r = NICs per node, L = NIC line rate Gb/s)
//            = (r/g)·(L/8)·(n−1)/(n−g) for alltoall (g = ranks per node, n = ranks; only (n−g)/n of the bytes leave the node)
// The '# Avg bus bandwidth' footer averages every size and both placements — it is parsed but never used as η.
// η_total > 1.02 ⇒ the run was not network-bound (NVLS / Tree / SHARP) → rerun with NCCL_ALGO=Ring NCCL_NVLS_ENABLE=0 NCCL_COLLNET_ENABLE=0.
// Sample logs with expected parser results: packages/core/test/fixtures/collective-logs.synthetic.txt (synthetic).
import type { CollectiveMeasurement, EtaCalibration, EtaSource, EtaSourceType, LoadBalancing, SpecSource } from '../model/types.ts';

const SPX_WP = 'https://gzhls.at/blob/ldb/e/0/0/b/3ebe47fbbd87fe76a235d40ecedfd77c04a3.pdf';
const META_SIGCOMM = 'https://engineering.fb.com/wp-content/uploads/2024/08/sigcomm24-final246.pdf';

/**
 * Sourced η_fabric defaults per load-balancing class (r2-eta.md §2–§3). Only values with a citation are listed; a class without a
 * credible source resolves to 1.0 'nominal' (computed and ranked at NOMINAL_RANK_ETA so missing data never ranks first).
 */
export const ETA_SOURCES: EtaSource[] = [
  {
    id: 'ecmp-alibaba-hpn',
    lbClass: 'ecmp',
    value: 0.6,
    // fix v2 2차 (QA M5): 0.60 is NVIDIA's figure (vendor claim); HPN's measurement (0.61–0.67) corroborates it but is not this value
    sourceType: 'vendor-claim',
    citation: "NVIDIA Spectrum-X white paper Fig. 7: throughput \"reduced to 60 percent of max throughput with static load balancing\" (vendor claim). Corroborated by Alibaba HPN (SIGCOMM'24) App. A: removing hash polarization raised AllReduce busbw by 50.1–63.7 % → static ECMP ≈ 0.61–0.67 of the unpolarized fabric (measured, appendix not peer-reviewed)",
    url: SPX_WP,
    conditions: 'Vendor figure without stated test conditions. HPN corroboration: 32–256 GPUs split evenly across two segments (all traffic cross-segment), 2 × 200G NICs per GPU, NCCL AllReduce at 4 GB (https://qiankun11516.github.io/pdf/sigcomm24-HPN.pdf). Range 0.60 (vendor) – 0.67 (HPN upper bound).',
  },
  {
    id: 'qp-scaling-meta',
    lbClass: 'qp-scaling',
    value: 0.7,
    // fix v2 2차 (QA M5): §4.4.1 is a flow-level simulation — derived, not a measurement (r2-eta.md §2 row 6)
    sourceType: 'derived',
    citation: "Meta, \"RDMA over Ethernet for Distributed AI Training at Meta Scale\" (SIGCOMM'24) §4.4.1: E-ECMP with 4 QPs completes 40 % longer than roofline (1/1.4 ≈ 0.71); §4.4.2: E-ECMP link utilization 40–90 % (≈ 0.72)",
    url: META_SIGCOMM,
    conditions: 'Ratio derived from a flow-level simulation of production job placement (§4.4.1) and a 16-uplink NCCL benchmark (§4.4.2), 400G RoCE. Plausible range 0.52 (32 QPs, worst case) – 0.90.',
  },
  {
    id: 'te-meta',
    lbClass: 'te',
    value: 0.8,
    sourceType: 'measured-paper',
    citation: "Meta SIGCOMM'24 §4.4.2: \"TE uniformly utilizes 80% of max bandwidth\"",
    url: META_SIGCOMM,
    conditions: 'Controlled NCCL benchmark with 16 uplinks. When failures push link availability below 1:1, TE "can be outperformed by E-ECMP" (§4.3).',
  },
  {
    id: 'adaptive-spectrumx',
    lbClass: 'adaptive',
    value: 0.95,
    sourceType: 'vendor-claim',
    citation: 'NVIDIA Spectrum-X Network Platform Architecture white paper (July 2024) pp. 18–19: "up to 95 percent effective bandwidth across the hyperscale system at load, and at scale"',
    url: SPX_WP,
    conditions: 'No test conditions stated for the 95 % figure. Israel-1 Fig. 17 all-reduce ≈ 0.97 of peak at 16 GB (chart read-off ±5 %). Plausible range 0.90–0.98.',
  },
  {
    id: 'adaptive-ib-proxy',
    lbClass: 'adaptive',
    value: 0.95,
    sourceType: 'vendor-claim',
    citation: 'Class proxy: the Spectrum-X adaptive-routing claim (0.95) applied to InfiniBand adaptive routing — no public, independent at-scale η measurement for IB AR was found',
    url: SPX_WP,
    conditions: 'IB-specific η unmeasured — run the measurement kit. NCCL enables NCCL_IB_ADAPTIVE_ROUTING by default on IB networks.',
  },
  {
    id: 'ddc-nominal',
    lbClass: 'ddc',
    value: 1.0,
    sourceType: 'nominal',
    citation: 'Nominal · unmeasured: no published busbw for a credit-scheduled DDC (DriveNets FSE); every AMD–DriveNets RA measurement is ESE, not FSE',
    conditions: 'Computed and ranked at the adaptive-class lower bound 0.95 so a missing measurement never ranks first (AIDC Studio comparator policy). Paste a cross-spine log to replace it.',
  },
];

/** A nominal (unmeasured) η is computed and ranked at this lower bound (r2-eta.md §3: band [0.95, 1.0]). */
export const NOMINAL_RANK_ETA = 0.95;

/** Host factor η_host (single-leaf busbw ÷ nominal) — replaces Calculon's 0.9 (systems/a100_80g.json). r2-eta.md §2.1 / §3. */
export const ETA_HOST_SOURCE: { value: number; sourceType: EtaSourceType; citation: string; url: string; conditions: string } = {
  value: 0.95,
  sourceType: 'acceptance-threshold',
  citation: 'Azure HPC health checks (nd96isr_h100_v5): check_ib_bw_gdr 380 Gb/s on 400G NDR = 0.95 floor; AMD–DriveNets RA RCCL all_reduce 383.27 GB/s at 8 GiB on 8 × 400G = 0.958 (vendor-run)',
  url: 'https://github.com/Azure/azurehpc-health-checks',
  conditions: 'Single leaf / single rail SU (no multipath decision). The Azure value is an ib_write_bw GPUDirect per-HCA link floor (perftest), used here as a proxy for a busbw ratio; the busbw evidence (0.958) is vendor-run. Range 0.58–0.98: one host or NCCL misconfiguration dropped it to 0.58 in nccl #2409 — measure on site.',
};

/** Maximum η_total before a run is rejected as not network-bound (r2-eta.md §1.1). */
export const ETA_NOT_NETWORK_BOUND = 1.02;

const SPEC_SOURCE: Record<EtaSourceType, SpecSource> = {
  'measured-paper': 'public-spec',
  derived: 'estimate',
  'vendor-claim': 'vendor-datasheet',
  'acceptance-threshold': 'public-spec',
  nominal: 'estimate',
  'user-measured': 'user',
  user: 'user',
};
export const specSourceOfEta = (t: EtaSourceType): SpecSource => SPEC_SOURCE[t] ?? 'estimate';

/** The sourced default for a class (InfiniBand adaptive routing uses the proxy entry so the badge says it is unmeasured). */
export function etaSourceFor(cls: LoadBalancing, fabric?: string): EtaSource | undefined {
  if (cls === 'adaptive' && fabric?.startsWith('ib-')) return ETA_SOURCES.find((s) => s.id === 'adaptive-ib-proxy');
  return ETA_SOURCES.find((s) => s.lbClass === cls && s.id !== 'adaptive-ib-proxy');
}

// ───────────── nominal bus bandwidth ─────────────

export interface NominalInputs {
  collective: CollectiveMeasurement['collective'];
  /** NIC line rate L (Gb/s) */
  nicGbps: number;
  /** backend NICs per node r */
  nicsPerNode: number;
  /** ranks per node g (alltoall correction); default r */
  ranksPerNode?: number;
  /** total ranks n (alltoall correction) */
  ranks?: number;
}

/** Theoretical busbw per rank (decimal GB/s), r2-eta.md §1.1. */
export function nominalBusbwGBps(i: NominalInputs): number {
  const r = Math.max(1, i.nicsPerNode);
  const L = Math.max(0, i.nicGbps);
  if (i.collective === 'alltoall') {
    const g = Math.max(1, i.ranksPerNode ?? r);
    const n = i.ranks ?? 0;
    const corr = n > g ? (n - 1) / (n - g) : 1;
    return (r / g) * (L / 8) * corr;
  }
  return (r * L) / 8;
}

/**
 * Nominal-busbw inputs for a pasted measurement (Network panel η calibration box and tests share this):
 *  - AIDC kit logs ('# AIDC-KIT eta … split=MOD:g'): NCCL_TESTS_SPLIT="MOD g" runs one communicator per local GPU index, i.e. one
 *    rank and `nics_per_rank` NICs per node in each communicator → r = nics_per_rank, g = 1, n = nodes (B_nom = r·L/8, the kit's
 *    η_bus = plateau ÷ (L/8) in eta_calibrate.py);
 *  - other logs: one rank per GPU with the node's NICs shared by the ring (r = GPUs per node × ports per GPU, g = ranks per node).
 */
export function nominalInputsFor(
  m: CollectiveMeasurement | undefined,
  compute?: { scaleOutPortGbps?: number; gpusPerNode?: number; railsPerNode?: number; scaleOutPortsPerGpu?: number; scaleUpDomain?: number },
): { nicGbps: number; nicsPerNode: number; ranksPerNode: number; ranks?: number; split?: number; splitInferred?: boolean; domainGroup?: boolean } {
  const nicGbps = m?.kit?.nicGbps ?? compute?.scaleOutPortGbps ?? 400;
  if (m?.kit?.split) {
    const nodes = m.kit.nodes ?? m.nodes ?? (m.ranks ? Math.round(m.ranks / m.kit.split) : undefined);
    return { nicGbps, nicsPerNode: Math.max(1, m.kit.nicsPerRank ?? 1), ranksPerNode: 1, ...(nodes ? { ranks: nodes } : {}), split: m.kit.split };
  }
  const nicsPerNode = compute ? Math.max(1, (compute.gpusPerNode ?? compute.railsPerNode ?? 8) * Math.max(1, compute.scaleOutPortsPerGpu ?? 1)) : 8;
  // polish v2 2차 (QA network m2): a log with several communicator groups but no kit header was run with NCCL_TESTS_SPLIT — treat it
  // like the kit's MOD split (one rank per node per group, the node's NICs shared by the groups) and flag it so the UI warns
  if (m?.groups && m.groups > 1) {
    const g = m.groups;
    const nodes = m.nodes ?? (m.ranks ? Math.round(m.ranks / g) : undefined);
    return { nicGbps, nicsPerNode: Math.max(1, Math.round(nicsPerNode / g)), ranksPerNode: 1, ...(nodes ? { ranks: nodes } : {}), split: g, splitInferred: true };
  }
  // polish v2 2차 (QA network m3): alltoall on a multi-node NVLink domain (GB300 NVL72) — ranks inside one domain talk over NVLink, so
  // the correction group g is the domain, not the tray
  const domain = compute?.scaleUpDomain ?? 0;
  const gpn = compute?.gpusPerNode ?? m?.ranksPerNode ?? nicsPerNode;
  if (m?.collective === 'alltoall' && domain > gpn) {
    // r and g both describe the NVLink domain: its NICs (domain × ports per GPU) serve its ranks — (r/g)·(L/8)·(n−1)/(n−g)
    const domainNics = Math.max(1, domain * Math.max(1, compute?.scaleOutPortsPerGpu ?? 1));
    return { nicGbps, nicsPerNode: domainNics, ranksPerNode: domain, ...(m?.ranks ? { ranks: m.ranks } : {}), domainGroup: true };
  }
  return { nicGbps, nicsPerNode, ranksPerNode: m?.ranksPerNode ?? nicsPerNode, ...(m?.ranks ? { ranks: m.ranks } : {}) };
}

// ───────────── nccl-tests / rccl-tests parser ─────────────

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const COLLECTIVES: [RegExp, CollectiveMeasurement['collective']][] = [
  [/all_?reduce/i, 'all_reduce'],
  [/all_?gather/i, 'all_gather'],
  [/reduce_?scatter/i, 'reduce_scatter'],
  [/all_?to_?all/i, 'alltoall'],
  [/broadcast/i, 'broadcast'],
];

const collectiveOf = (name: string): CollectiveMeasurement['collective'] => COLLECTIVES.find(([re]) => re.test(name))?.[1] ?? 'other';

interface TableState {
  header: string[];
  /** busbw column index per placement → in-place? */
  placements: { alg: number; bus: number; inPlace: boolean }[];
  rows: CollectiveMeasurement['rows'];
  collective?: CollectiveMeasurement['collective'];
  ranks?: number;
  ranksPerNode?: number;
  nodes?: number;
  truncated?: boolean;
  avg?: number;
  kit?: CollectiveMeasurement['kit'];
  groups?: number;
}

/**
 * Parse nccl-tests / rccl-tests stdout (r2-eta.md §4.6): strips `srun --label` prefixes, detects every results header
 * (a '#' line containing `size` and `count`), maps the algbw / busbw columns per placement (out-of-place, in-place, or a single
 * block), reads data rows (first two tokens are integers), the '# Avg bus bandwidth' footer, the collective from
 * '# Collective test starting:' or a `<collective>_perf` command line, and ranks / ranks per node / nodes from the device list
 * ('#  Rank  N Group … on <host> device D'). Several runs in one paste return several measurements.
 */
export function parseCollectiveLog(text: string): CollectiveMeasurement[] {
  const tool: CollectiveMeasurement['tool'] = /rccl|RCCL|# Errors with asterisks|HIP_HOME|--use_rocm/.test(text) ? 'rccl-tests' : 'nccl-tests';
  const out: CollectiveMeasurement[] = [];
  let cur: TableState | null = null;
  let pending: CollectiveMeasurement['collective'] | undefined;
  let pendingKit: CollectiveMeasurement['kit'] | undefined;
  let rankMax = -1;
  let groupMax = -1;
  let rankLines = 0;
  let deviceMax = -1;
  const hosts = new Set<string>();
  let truncated = false;
  let prev = '';

  const flush = () => {
    if (cur && cur.rows.length) {
      out.push({
        tool,
        collective: cur.collective ?? 'other',
        ...(cur.ranks ? { ranks: cur.ranks } : {}),
        ...(cur.nodes ? { nodes: cur.nodes } : {}),
        ...(cur.ranksPerNode ? { ranksPerNode: cur.ranksPerNode } : {}),
        ...(cur.truncated ? { rankListTruncated: true } : {}),
        ...(cur.kit ? { kit: cur.kit } : {}),
        ...(cur.groups ? { groups: cur.groups } : {}),
        rows: cur.rows,
        ...(cur.avg !== undefined ? { avgBusbwGBps: cur.avg } : {}),
      });
    }
    cur = null;
  };

  for (const raw of text.split(/\r?\n/)) {
    // srun --label (`12: `) and Open MPI --tag-output (`[1,0]<stdout>: `) prefixes (fix v2 2차, QA m1)
    const line = raw.replace(/^\[\d+,\d+\]<std(?:out|err)>:\s?/, '').replace(/^\s*\d+:\s/, '');
    const trimmed = line.trim();
    if (!trimmed) {
      prev = line;
      continue;
    }
    // AIDC test kit header (deploy/tests/scripts.ts): '# AIDC-KIT eta scope=… collective=… split=MOD:4 nic_gbps=800 nics_per_rank=1 nodes=16'
    const kitHdr = /#\s*AIDC-KIT\s+eta\s+(.*)$/.exec(line);
    if (kitHdr) {
      flush();
      const kv = Object.fromEntries([...kitHdr[1].matchAll(/(\w+)=(\S+)/g)].map((x) => [x[1], x[2]]));
      const num = (v?: string) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined);
      const split = /^MOD:(\d+)$/i.exec(kv.split ?? '');
      pendingKit = {
        ...(kv.scope ? { scope: kv.scope } : {}),
        ...(kv.collective ? { collective: kv.collective } : {}),
        ...(split ? { split: Number(split[1]) } : {}),
        ...(num(kv.nic_gbps) !== undefined ? { nicGbps: num(kv.nic_gbps) } : {}),
        ...(num(kv.nics_per_rank) !== undefined ? { nicsPerRank: num(kv.nics_per_rank) } : {}),
        ...(num(kv.nodes) !== undefined ? { nodes: num(kv.nodes) } : {}),
      };
      if (kv.collective) pending = collectiveOf(kv.collective);
      prev = line;
      continue;
    }
    const starting = /#\s*Collective test starting:\s*(\S+)/.exec(line);
    if (starting) {
      flush();
      pending = collectiveOf(starting[1]);
      prev = line;
      continue;
    }
    const rankG = /#\s*Rank\s+(\d+)\s+Group\s+(\d+)\s+Pid\s+\d+\s+on\s+(\S+)\s+device\s+(\d+)/.exec(line);
    const rank = rankG ? [rankG[0], rankG[1], rankG[3], rankG[4]] : null;
    if (rank && rankG) {
      if (cur && (cur as TableState).rows.length) flush();
      groupMax = Math.max(groupMax, Number(rankG[2]));
      rankMax = Math.max(rankMax, Number(rank[1]));
      deviceMax = Math.max(deviceMax, Number(rank[3]));
      hosts.add(rank[2]);
      rankLines++;
      prev = line;
      continue;
    }
    if (/^\.{3,}$/.test(trimmed)) {
      truncated = true;
      prev = line;
      continue;
    }
    if (trimmed.startsWith('#')) {
      const tokens = trimmed.replace(/^#+/, '').trim().split(/\s+/);
      if (tokens.includes('size') && tokens.includes('count')) {
        flush();
        const placements: TableState['placements'] = [];
        const busIdx = tokens.flatMap((t, i) => (t === 'busbw' ? [i] : []));
        const onlyInPlace = /in-place/.test(prev) && !/out-of-place/.test(prev);
        busIdx.forEach((bus, k) => {
          let alg = bus - 1;
          while (alg >= 0 && tokens[alg] !== 'algbw') alg--;
          placements.push({ alg, bus, inPlace: onlyInPlace || k === 1 });
        });
        const complete = rankLines > 0 && rankLines === rankMax + 1;
        const ranks = rankMax >= 0 ? rankMax + 1 : undefined;
        const ranksPerNode = deviceMax >= 0 ? deviceMax + 1 : undefined;
        const nodes = complete ? hosts.size : ranks && ranksPerNode && ranks % ranksPerNode === 0 ? ranks / ranksPerNode : undefined;
        const groups = groupMax >= 1 ? groupMax + 1 : undefined;
        // MOD-split runs list ranks per group: a node count from ranks ÷ devices is per group, so derive nodes from ranks ÷ groups
        const nodesSplit = groups && ranks && ranks % groups === 0 ? ranks / groups : nodes;
        cur = { header: tokens, placements, rows: [], collective: pending, ranks, ranksPerNode, nodes: groups ? (complete ? hosts.size : nodesSplit) : nodes, truncated: truncated || (rankLines > 0 && !complete), ...(groups ? { groups } : {}), ...(pendingKit ? { kit: pendingKit } : {}) };
        pending = undefined;
        pendingKit = undefined;
        rankMax = -1;
        groupMax = -1;
        rankLines = 0;
        deviceMax = -1;
        hosts.clear();
        truncated = false;
        prev = line;
        continue;
      }
      const avg = /#\s*Avg bus bandwidth\s*:\s*([\d.]+)/.exec(line);
      if (avg && cur) {
        (cur as TableState).avg = Number(avg[1]);
        flush();
      }
      prev = line;
      continue;
    }
    // command lines name the collective (e.g. `./build/alltoall_perf -b 1M …`, `all_reduce_perf_mpi`)
    const cmd = /\b(all_?reduce|all_?gather|reduce_?scatter|all_?to_?all|broadcast|sendrecv|reduce|scatter|gather|hypercube)_perf\w*/i.exec(line);
    if (cmd && !cur) {
      pending = collectiveOf(cmd[1]);
      prev = line;
      continue;
    }
    const tokens = trimmed.split(/\s+/);
    if (cur && tokens.length >= 2 && /^\d+$/.test(tokens[0]) && /^\d+$/.test(tokens[1])) {
      const t = cur as TableState;
      const sizeB = Number(tokens[0]);
      // headers and rows align token-for-token; if a variant adds unnamed columns, fall back to the AICR regex positions
      const aligned = tokens.length >= t.header.length;
      t.placements.forEach((p, k) => {
        const alg = Number(aligned ? tokens[p.alg] : tokens[6 + 4 * k]);
        const bus = Number(aligned ? tokens[p.bus] : tokens[7 + 4 * k]);
        if (!Number.isFinite(bus)) return;
        t.rows.push({ sizeB, algbwGBps: Number.isFinite(alg) ? alg : 0, busbwGBps: bus, ...(p.inPlace ? { inPlace: true } : {}) });
      });
      if (!t.collective && tokens[3] && tokens[3] !== 'none' && t.rows.length === t.placements.length) {
        // a reduction op without a named collective: leave 'other' (all_reduce / reduce_scatter / reduce share it)
      }
    }
    prev = line;
  }
  flush();
  return out;
}

// ───────────── η from a measurement ─────────────

export type EtaFlag = 'below-plateau' | 'not-plateaued' | 'unstable' | 'in-place-differs' | 'not-network-bound' | 'no-rows';

/**
 * η_total from one measurement (r2-eta.md §4.7): out-of-place busbw of the 3 largest sizes ≥ 1 GiB (fewer → flag
 * 'below-plateau' and use what exists), mean ÷ nominal. Flags: 'not-plateaued' (max − min > 10 % of max), 'unstable' (a size
 * ≥ 256 MiB drops > 15 % below its predecessor), 'in-place-differs' (> 3 %), 'not-network-bound' (η_total > 1.02).
 * `eta` = η_total; use `calibrateEta` to split it into η_host × η_fabric for the traffic engine.
 */
export function etaFromMeasurement(m: CollectiveMeasurement, nominalGBps: number): EtaCalibration {
  const oop = m.rows.filter((r) => !r.inPlace).sort((a, b) => a.sizeB - b.sizeB);
  const flags: EtaFlag[] = [];
  if (!oop.length || !(nominalGBps > 0)) {
    return { nominalGBps, eta: 0, etaTotal: 0, flags: ['no-rows'], basis: 'no out-of-place rows or no nominal busbw', measurement: m };
  }
  const large = oop.filter((r) => r.sizeB >= GIB);
  if (large.length < 3) flags.push('below-plateau');
  const S = (large.length ? large : oop).slice(-3);
  const vals = S.map((r) => r.busbwGBps);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (max > 0 && (max - min) / max > 0.1) flags.push('not-plateaued');
  for (let i = 1; i < oop.length; i++) {
    if (oop[i].sizeB >= 256 * MIB && oop[i].busbwGBps < oop[i - 1].busbwGBps * 0.85) {
      flags.push('unstable');
      break;
    }
  }
  const ip = new Map(m.rows.filter((r) => r.inPlace).map((r) => [r.sizeB, r.busbwGBps]));
  if (S.some((r) => ip.has(r.sizeB) && r.busbwGBps > 0 && Math.abs(ip.get(r.sizeB)! - r.busbwGBps) / r.busbwGBps > 0.03)) flags.push('in-place-differs');
  const etaTotal = mean / nominalGBps;
  if (etaTotal > ETA_NOT_NETWORK_BOUND) flags.push('not-network-bound');
  const gib = (b: number) => (b / GIB >= 1 ? `${+(b / GIB).toFixed(2)} GiB` : `${+(b / MIB).toFixed(0)} MiB`);
  const basis = `η_total = mean out-of-place busbw at ${S.map((r) => gib(r.sizeB)).join(', ')} (${mean.toFixed(2)} GB/s, min ${min.toFixed(2)}) ÷ nominal ${nominalGBps.toFixed(2)} GB/s = ${etaTotal.toFixed(3)}${m.avgBusbwGBps !== undefined ? ` (footer average ${m.avgBusbwGBps} GB/s ignored)` : ''}`;
  return { nominalGBps, eta: etaTotal, etaTotal, busbwLargeGBps: mean, busbwMinGBps: min, sizesB: S.map((r) => r.sizeB), flags, basis, measurement: m };
}

/**
 * Traffic-engine calibration from a cross-spine ("spread") measurement and, optionally, a single-leaf ("packed") one
 * (r2-eta.md §1.2, §4.7 step 7; r2-ops.md §4.3):
 *   with packed:    η_host = busbw_large(packed) ÷ B_nom,  η_fabric = busbw_large(spread) ÷ busbw_large(packed)
 *   without packed: η_host = ETA_HOST_SOURCE (0.95),        η_fabric = η_total(spread) ÷ η_host
 * η_fabric is capped at 1 (a spread run faster than the packed one is noise, flagged in the basis).
 */
export function calibrateEta(o: { spread: CollectiveMeasurement; packed?: CollectiveMeasurement; nominalGBps: number; measuredAt?: string; hostDefault?: number }): EtaCalibration {
  const spread = etaFromMeasurement(o.spread, o.nominalGBps);
  const packed = o.packed ? etaFromMeasurement(o.packed, o.nominalGBps) : undefined;
  const hostDefault = o.hostDefault ?? ETA_HOST_SOURCE.value;
  const flags = [...new Set([...(spread.flags ?? []), ...(packed?.flags ?? [])])];
  let etaHost: number;
  let raw: number;
  let basis: string;
  if (packed && (packed.busbwLargeGBps ?? 0) > 0) {
    etaHost = packed.etaTotal ?? 0;
    raw = (spread.busbwLargeGBps ?? 0) / (packed.busbwLargeGBps ?? 1);
    basis = `η_fabric = spread ${spread.busbwLargeGBps!.toFixed(2)} ÷ packed ${packed.busbwLargeGBps!.toFixed(2)} GB/s = ${raw.toFixed(3)}; η_host = packed ÷ nominal ${o.nominalGBps.toFixed(2)} = ${etaHost.toFixed(3)}`;
  } else {
    etaHost = hostDefault;
    raw = (spread.etaTotal ?? 0) / hostDefault;
    basis = `η_fabric = η_total ${(spread.etaTotal ?? 0).toFixed(3)} ÷ η_host ${hostDefault} (default, no single-leaf log) = ${raw.toFixed(3)}`;
  }
  const etaFabric = Math.min(1, Math.max(0, raw));
  if (raw > 1) basis += ' → capped at 1.0';
  return {
    ...spread,
    measuredAt: o.measuredAt,
    eta: etaFabric,
    etaFabric,
    etaHost,
    flags,
    source: 'user-measured',
    basis: `${spread.basis}. ${basis}`,
    ...(packed ? { packed: packed.measurement } : {}),
  };
}
