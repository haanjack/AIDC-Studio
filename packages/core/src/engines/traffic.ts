import { resolveCatalog, withCatalog } from '../catalog/registry.ts';
import type { ComputeSpec, EvidenceSourceType, LoadBalancing, NetworkTrafficTimePoint, Project, SpecSource, TrafficPhysicalEnvelope, TrafficReport, WorkloadBlueprint } from '../model/types.ts';
import { buildContext, clamp, type Ctx } from './context.ts';
import { ETA_HOST_SOURCE } from './eta.ts';
import { analyzeNetworkCtx, etaFor, type NetworkResult } from './network.ts';
import { l2l3Verdict } from './radix.ts';
import { inferenceExpertCollectiveGpus, inferenceParallelismFor, inferencePromptTokens, inferenceReplicaGpus } from '../workload/inference.ts';
import { TRAINING_ZERO_STAGE_DEFAULT, trainingRecomputeFlopFactor } from '../workload/training.ts';

/**
 * Deterministic workload → network traffic engine (stream S2, PROPOSAL-v2 §3.3, docs/research/network-sim.md §2–§3 + review C1/C2/C6/C7;
 * v2 2차 T2: sourced η_host / η_fabric and the overlap fix from docs/research/r2-eta.md §1, §5).
 *
 * Bytes per GPU per training step (b = sequences per micro-batch, s = seq, h = hidden, L = layers, m = micro-batches per
 * pipeline per step, l_stage = L/p, Ψ_gpu = N_total/(t·p·e) parameters held by one (TP,PP,EP) slice):
 *   TP  = m · l_stage · 8·b·s·h·(t−1)/t · B_a           (Megatron SC'21 §3.1: 2 all-reduces fwd + 2 bwd per layer, ring 2(n−1)/n folded in)
 *   PP  = 2 · m · b·s·h · B_a / t                        (Megatron: b·s·h per boundary per micro-batch each way; scatter/gather splits it over the t NICs)
 *   CP  = 3 · m · l_stage · 2·b·s·n_kv·d_head · B_a · (c−1)/c   (Llama 3 §3.3.2 all-gather K,V fwd + bwd re-gather + RS dK,dV;
 *         d_head = model.headDim when present — Qwen3 / gpt-oss / GLM-4.5 / Gemma 3 differ from h/n_heads)
 *   DP  = 2·B_g·Ψ·(d−1)/d  (ZeRO-0/1/2 = 2Ψ elements: RS + AG, ZeRO §7.1–7.2.1)
 *         (2·B_w + B_g)·Ψ·(d−1)/d  (ZeRO-3 / FSDP = 3Ψ elements, ZeRO §7.2.2; Llama 3 no-reshard + FP32 RS gives the same 6Ψ bytes)
 *   EP  = tokens_per_GPU · l_stage · k_top·h·(1 B dispatch + 2 B combine) · (e−1)/e   (DeepSeek-V3 §3.2.2); on the NIC the node-limited
 *         routing (M ≤ 4 nodes per token) caps the per-token bytes at min(k_top, M)·h·3 B
 *   Compute per token = 6·N_active + 12·L·h·s (PaLM App. B) — or 8·N_active + 16·L·h·s with activation recomputation
 *         (Megatron 96·B·s·l·h² form = 4/3 of the 72 form, review C1) — never mixed with a PaLM-style MFU.
 * Group placement follows [TP, CP, PP, DP] (Llama 3 §3.3.2): TP/CP/PP stay in the scale-up domain when the cumulative product fits,
 *   EP stays in the scale-up domain when e·t ≤ U (NVL72 fits EP64), DP is outermost and rides the rail (one hop inside a pod) —
 *   only the ring edges that leave a pod hit the spine: fraction m_U/m_L for the 2-level (hierarchical) algorithm, where m_X is the
 *   number of group members inside domain X; hierarchical NIC bytes = 2·(S/m_U)·(1 − m_U/d) (rail-only paper §III-B, NCCLX).
 * Capacities: scale-up busbw 0.8 (Calculon); NIC busbw = η_host (default 0.95, engines/eta.ts ETA_HOST_SOURCE — replaces Calculon's 0.9);
 *   spine/core tiers additionally × η_fabric (engines/network.ts etaFor: user-measured calibration > override > sourced class default >
 *   nominal). Expert-parallel all-to-all uses the alltoall calibration when one is stored (η_A2A), else the same η.
 * Tier load: U_T = bytes_T × oversubscription ÷ (capacity × η × window). Burst windows: DP = 0.5·T_comp, others = T_comp.
 * Step time and overlap (r2-eta.md §5.2): step = T_comp + Σ_g exposed_g with
 *   exposed_g = T_nic,g − min(f_g · T_nic,g , W_g)
 *   f_g = fraction of the group's collective time that can run concurrently with compute (framework-mode defaults below, editable per
 *   blueprint via training.overlap; measured with HTA get_comm_comp_overlap() or a step-time A/B test);
 *   W_g = compute time available to hide it: DP backward ≈ 2/3 T_comp (3/4 with full recompute), PP / TP / CP / EP ≈ T_comp.
 *   T_comp = FLOP/step ÷ (GPUs · peak · assumed MFU). The MFU anchors (Llama 3 Table 4 etc.) are end-to-end measurements on NVLink
 *   systems, so scale-up (NVLink / xGMI) collective time is already inside T_comp; only the scale-out (NIC) part is added on top —
 *   (1 − f)·ΔT_nic always reaches the step, so fabric differences scale proportionally (the old max(0, T_comm − f·T_comp) clamped
 *   large-batch plans to zero and produced the IB-vs-RoCE tie).
 * A ring collective finishes at its slowest edge, so the effective efficiency of any collective that crosses a multipath tier is η
 *   (not the byte-weighted fraction); commEfficiencyEffective = time-weighted Σ over groups × congestion × link-speed × hop factor.
 * Anchors (unit tests, GPU specs inline): Llama 3 405B on 8,192 H100 (TP8/PP16/DP64, s 8,192, 16 M tokens, 43 % MFU, Tab. 4) →
 *   step ≈ 12.5 s, TP ≈ 473 GB / GPU / step, FSDP ≈ 19 GB, PP ≈ 2.1 GB (network-sim.md §2.4 worked example).
 */

export interface TrafficInput {
  project: Project;
  workload: WorkloadBlueprint;
  ctx: Ctx;
  network: NetworkResult;
}

export interface TrafficGpu {
  /** peak dense FLOPS at the training precision */
  peakFlops: number;
  /** GPUs per scale-up (NVLink / xGMI) domain */
  scaleUpDomain: number;
  /** scale-up bandwidth per GPU per direction (GB/s) */
  scaleUpGBpsPerDir: number;
  /** scale-out NIC bandwidth per GPU (Gb/s, all ports) */
  nicGbps: number;
  /** achieved bus bandwidth fractions (NVLink 0.8 Calculon; NIC = η_host, default 0.95 sourced in engines/eta.ts) */
  scaleUpBusbw?: number;
  nicBusbw?: number;
  /** Optional catalog identity/provenance for the physical envelope shown with the result. */
  platformId?: string;
  platformName?: string;
  acceleratorName?: string;
  scaleUpKind?: ComputeSpec['scaleUp']['kind'];
  scaleUpName?: string;
  scaleOutFabric?: Project['network']['scaleOut']['fabric'];
  /** Physical NIC/switch port accounting used to make endpoint and switch capacity explicit in the UI. */
  scaleOutNicPortsPerGpu?: number;
  scaleOutNicPortGbps?: number;
  scaleOutSwitchName?: string;
  scaleOutSwitchPortGbps?: number;
  scaleOutSwitchPortsPerGpu?: number;
}

export interface TrafficFabric {
  kind: 'clos' | 'ddc';
  tiers: 1 | 2 | 3;
  /** switch radix (ports per switch) */
  k: number;
  /** leaf downlink:uplink oversubscription (N:1) */
  oversubscription: number;
  /** GPUs served by one leaf group (rail-optimized pod / SU); one rack's GPUs for ToR leaf-spine designs */
  gpusPerLeafDomain: number;
  /** GPUs reachable without crossing the core tier (2-tier: whole fabric) */
  gpusPerSpineDomain: number;
  /** leaf switches (for the L2/L3 verdict) */
  leaves: number;
  eta: { value: number; class: LoadBalancing; source: SpecSource; citation: string; overridden: boolean };
  /** η for expert-parallel all-to-all (alltoall calibration); absent = eta.value */
  etaA2a?: number;
  /** in-network reduction (SHARP) halves all-reduce bytes on the NIC tiers */
  sharp?: boolean;
  /** negotiated link speed × lanes vs NIC speed (breakout) */
  speedFactor?: number;
  multiTenant?: boolean;
  planes?: number;
}

export interface TrafficSpec {
  model: WorkloadBlueprint['model'] & { headDim?: number };
  training: NonNullable<WorkloadBlueprint['training']>;
  /** inference blueprint (its own model geometry) for the KV / P-D / EP-decode block */
  inference?: { params: NonNullable<WorkloadBlueprint['inference']>; model: WorkloadBlueprint['model'] & { headDim?: number } };
  /** GPUs allocated to the training job */
  gpus: number;
  gpu: TrafficGpu;
  fabric: TrafficFabric;
  /** overlap fractions per group (user values win over the framework-mode defaults) */
  overlap?: Partial<Record<Group, number>>;
  /** framework mode that sets the overlap defaults (default 'fsdp-prefetch') */
  overlapFramework?: OverlapFramework;
}

/** Steady-state serving demand evaluated against the physical rack/NIC envelope. */
export interface InferenceTrafficSpec {
  model: WorkloadBlueprint['model'] & { headDim?: number };
  inference: NonNullable<WorkloadBlueprint['inference']>;
  /** GPUs allocated from the layout's placed GPU racks. */
  gpus: number;
  gpu: TrafficGpu;
  fabric: TrafficFabric;
}

export type Group = 'tp' | 'cp' | 'pp' | 'dp' | 'ep';
type Tier = 'scale-up' | 'leaf' | 'spine' | 'core';

/** Stored in NetworkDesign.trafficWorkloadId when every eligible workload is evaluated concurrently. */
export const AGGREGATE_TRAFFIC_ID = '__all-concurrent-workloads__';
// Match workload power traces so bandwidth and power can be inspected over the same ten-minute window.
const TRAFFIC_TRACE_SECONDS = 600;
const TRACE_SUBSAMPLES = 10;
const TIERS: readonly Tier[] = ['scale-up', 'leaf', 'spine', 'core'];

/** Precision → bytes and default MFU (compute-path MFU incl. pipeline bubble; Llama 3 Tab. 4 for BF16, estimates for FP8/FP4). */
const PRECISION_BYTES: Record<string, number> = { bf16: 2, fp8: 1, fp4: 0.5 };
export const MFU_DEFAULT: Record<string, { value: number; source: SpecSource; citation: string }> = {
  bf16: { value: 0.43, source: 'public-spec', citation: 'Llama 3 405B Table 4: 430 TFLOP/s per H100, 43 % MFU (BF16)' },
  fp8: { value: 0.3, source: 'estimate', citation: 'Estimate — DeepSeek-V3 ≈ 20 % of FP8-dense peak with EP64 over 8 nodes; dense FP8 recipes 30–35 %' },
  fp4: { value: 0.25, source: 'estimate', citation: 'Estimate — no public FP4 pre-training MFU' },
};

// ───────────── overlap defaults (r2-eta.md §5.3) ─────────────

/** Framework modes that set the overlap defaults. */
export type OverlapFramework = 'megatron-no-overlap' | 'fsdp-prefetch' | 'megascale-overlap' | 'dualpipe';
export const OVERLAP_FRAMEWORKS: OverlapFramework[] = ['megatron-no-overlap', 'fsdp-prefetch', 'megascale-overlap', 'dualpipe'];

export interface OverlapDefault {
  f: number;
  sourceType: EvidenceSourceType;
  citation: string;
  url?: string;
  /** true when no published f exists for this group/mode (UI: "measure it") */
  measureIt?: boolean;
}

const FSDP_URL = 'https://arxiv.org/abs/2304.11277';
const DDP_URL = 'https://arxiv.org/abs/2006.15704';
const MEGASCALE_URL = 'https://arxiv.org/html/2402.15627v1';
const LLAMA3_URL = 'https://arxiv.org/pdf/2407.21783';
const SP_URL = 'https://arxiv.org/pdf/2205.05198';
const DSV3_URL = 'https://arxiv.org/pdf/2412.19437';

/**
 * Per-group overlap fraction f for a framework mode (r2-eta.md §5.3). `p` pipeline stages, `m` micro-batches per pipeline, `layers`
 * ≈ number of FSDP units / DDP buckets.
 */
export function overlapDefaults(mode: OverlapFramework, g: { pp: number; m: number; layers: number }): Record<Group, OverlapDefault> {
  const ppF = g.pp > 1 ? clamp(1 - (g.pp - 1) / Math.max(1, g.m), 0, 1) : 0;
  const bucketF = clamp(1 - 1 / Math.max(1, g.layers), 0, 1);
  const tp: OverlapDefault =
    mode === 'megascale-overlap'
      ? { f: 0, sourceType: 'measured-paper', citation: 'MegaScale (NSDI\'24) Table 3 reports +2.2 MFU pts from fused TP comm–GEMM overlap but no fraction f — kept at 0 until measured (HTA get_comm_comp_overlap)', url: MEGASCALE_URL, measureIt: true }
      : { f: 0, sourceType: 'measured-paper', citation: 'TP / SP collectives sit on the critical path (PyTorch FSDP VLDB\'23 §2; MegaScale §3.2 "the two communication operators are in the critical path")', url: FSDP_URL };
  return {
    tp,
    cp: { f: 0, sourceType: 'measured-paper', citation: 'Llama 3 §3.3.2: the context-parallel all-gather "is exposed in the critical path"', url: LLAMA3_URL },
    pp: { f: ppF, sourceType: 'derived', citation: `1 − (p−1)/m = 1 − ${g.pp - 1}/${g.m} (interleaved 1F1B with async send/recv: steady phase overlappable, warm-up/cool-down partly — MegaScale §3.2; Megatron bubble term)`, url: MEGASCALE_URL },
    dp:
      mode === 'megatron-no-overlap'
        ? { f: 0, sourceType: 'measured-paper', citation: 'Gradient all-reduce at the pipeline flush without overlap (Korthikanti et al. 2022: "We do not use any overlapping of gradient all-reduces")', url: SP_URL }
        : { f: bucketF, sourceType: 'derived', citation: `1 − 1/N_buckets with N ≈ ${g.layers} FSDP units / buckets (DDP VLDB'20 §3.2.3: the last-ready bucket cannot overlap; FSDP §3.3.2 backward prefetch)`, url: mode === 'fsdp-prefetch' ? FSDP_URL : DDP_URL },
    ep:
      mode === 'dualpipe'
        ? { f: 1, sourceType: 'measured-paper', citation: 'DeepSeek-V3 §3.2 DualPipe: "both all-to-all and PP communication can be fully hidden" (≈ 15 % of streaming multiprocessors reserved)', url: DSV3_URL }
        : { f: 0, sourceType: 'derived', citation: 'All-to-all dispatch / combine sits between dependent computations without micro-batch overlap (FSDP §2 activation-communication case)', url: FSDP_URL },
  };
}

/** Kept for API compatibility: the fsdp-prefetch defaults for a 126-layer, p = 16 / m = 64 plan (use overlapDefaults for a real plan). */
export const OVERLAP_DEFAULT: Record<Group, number> = Object.fromEntries(Object.entries(overlapDefaults('fsdp-prefetch', { pp: 16, m: 64, layers: 126 })).map(([k, v]) => [k, v.f])) as Record<Group, number>;

const SCALE_UP_BUSBW = 0.8;
const NIC_BUSBW = ETA_HOST_SOURCE.value;
const B_ACT = 2; // activations are exchanged in BF16 even on FP8 GEMM recipes
const B_W = 2; // BF16 parameter shards (all-gather)
const B_G = 2; // BF16 gradient reduce-scatter
const MAX_OVERSUB = 8;

const GB = 1e9;

const SCALE_UP_NAMES: Record<ComputeSpec['scaleUp']['kind'], string> = {
  nvlink: 'NVLink',
  ualink: 'UALink',
  'esun-ethernet': 'ESUN Ethernet',
  'vendor-proprietary': 'Vendor-proprietary scale-up',
  pcie: 'PCIe',
  none: 'No native scale-up',
};

function physicalEnvelope(gpu: TrafficGpu, suCap: number, nicCap: number): TrafficPhysicalEnvelope {
  const scaleUpKind = gpu.scaleUpKind ?? 'none';
  const nicPorts = Math.max(1, gpu.scaleOutNicPortsPerGpu ?? 1);
  const nicPortGbps = Math.max(0, gpu.scaleOutNicPortGbps ?? gpu.nicGbps / nicPorts);
  const switchPortGbps = Math.max(0, gpu.scaleOutSwitchPortGbps ?? nicPortGbps);
  const switchPortsPerGpu = Math.max(0, gpu.scaleOutSwitchPortsPerGpu ?? (switchPortGbps > 0 ? (nicPorts * nicPortGbps) / switchPortGbps : nicPorts));
  return {
    ...(gpu.platformId ? { platformId: gpu.platformId } : {}),
    ...(gpu.platformName ? { platformName: gpu.platformName } : {}),
    ...(gpu.acceleratorName ? { acceleratorName: gpu.acceleratorName } : {}),
    scaleUpKind,
    scaleUpName: gpu.scaleUpName ?? SCALE_UP_NAMES[scaleUpKind],
    scaleUpDomain: Math.max(1, gpu.scaleUpDomain),
    scaleUpRawBidirectionalGBpsPerGpu: gpu.scaleUpGBpsPerDir * 2,
    scaleUpEffectiveGBpsPerGpu: suCap / GB,
    scaleUpBusbwFactor: gpu.scaleUpBusbw ?? SCALE_UP_BUSBW,
    scaleOutEffectiveGBpsPerGpu: nicCap / GB,
    scaleOutNicPortsPerGpu: nicPorts,
    scaleOutNicPortGbps: nicPortGbps,
    scaleOutRawGBpsPerGpu: (nicPorts * nicPortGbps) / 8,
    ...(gpu.scaleOutSwitchName ? { scaleOutSwitchName: gpu.scaleOutSwitchName } : {}),
    scaleOutSwitchPortGbps: switchPortGbps,
    scaleOutSwitchRawGBps: switchPortGbps / 8,
    scaleOutSwitchPortsPerGpu: switchPortsPerGpu,
    ...(gpu.scaleOutFabric ? { scaleOutFabric: gpu.scaleOutFabric } : {}),
  };
}

// ───────────── compute-path efficiency (training-roofline-model, 2026-09-19) ─────────────
//
// The compute term used to divide by MFU_DEFAULT — an END-TO-END MFU (Llama 3 Tab. 4's 43 %) that already contains
// exposed communication and the pipeline bubble — and then add exposed scale-out communication on top: a double count,
// and a divisor with no place for the parallel topology. No compute-only MFU exists publicly (a 118-row survey of
// MLPerf / NVIDIA / frontier-lab / operator evidence found none), so η_k is a compute-path efficiency BACK-SOLVED through
// this model: fitted on the only fixed-model / fixed-scale TP×PP sweep with step times (Hagemann et al., arXiv 2311.05610,
// A100; hold-out RMS 3.8 %) and inverted from Llama 3 Table 4 for H100 after removing the model's own bubble, shard
// factor and exposed TP all-reduce. Provenance is therefore 'derived' or 'estimate' — never 'public-spec'.
export interface ComputeEfficiency { value: number; lo: number; hi: number; sourceType: EvidenceSourceType; citation: string }
export type AcceleratorClass = 'a100' | 'h100' | 'b200' | 'b300' | 'cdna' | 'unknown';
export const COMPUTE_EFFICIENCY_BF16: Record<AcceleratorClass, ComputeEfficiency> = {
  a100: { value: 0.63, lo: 0.57, hi: 0.70, sourceType: 'derived', citation: 'Fitted on Hagemann et al. (arXiv 2311.05610) Llama 13B / 30B / 65B TP×PP sweeps, A100 312 TFLOP/s dense; 65B hold-out RMS 3.8 %' },
  h100: { value: 0.58, lo: 0.53, hi: 0.68, sourceType: 'derived', citation: 'Back-solved from Llama 3 405B Table 4 (430 TFLOP/s, TP8 / PP16 / DP64, interleaved v ≈ 8) after removing the modelled bubble, κ_tp(8) and exposed TP all-reduce; Nemotron-4 340B gives 0.55–0.62' },
  b200: { value: 0.48, lo: 0.44, hi: 0.52, sourceType: 'derived', citation: 'NVIDIA NVFP4 pre-training blog Table 2: Llama 3 8B BF16 1,165 TFLOP/s on GB200 = 47.6 % of 2,450 dense, communication-light single node' },
  b300: { value: 0.48, lo: 0.38, hi: 0.58, sourceType: 'estimate', citation: 'No public compute-path anchor — the B200 value with a ±0.10 band' },
  cdna: { value: 0.50, lo: 0.35, hi: 0.65, sourceType: 'estimate', citation: 'No public LLM pre-training step data for CDNA in the survey — ±0.15 band ("no anchor")' },
  unknown: { value: 0.50, lo: 0.35, hi: 0.65, sourceType: 'estimate', citation: 'Unrecognised accelerator — band centre only' },
};
/** Accelerator class from the declared name. Vendor-neutral: the class only selects a fitted band, no engine rule keys on it. */
export function acceleratorClassOf(name?: string): AcceleratorClass {
  const n = (name ?? '').toLowerCase();
  if (/\bmi[3-4]\d\d/.test(n) || n.includes('instinct') || n.includes('cdna')) return 'cdna';
  if (n.includes('b300') || n.includes('gb300')) return 'b300';
  if (n.includes('b200') || n.includes('gb200')) return 'b200';
  if (/h100|h200|h800/.test(n)) return 'h100';
  if (n.includes('a100')) return 'a100';
  return 'unknown';
}
/** GEMM share of step FLOPs for the precision split: ≈ 0.48 at 8B (NVIDIA precision ladder), ≈ 0.9 at 405B (Azure step profile); log-interpolated (estimate). */
export function gemmShareFor(nActive: number): number {
  const x = Math.log10(Math.max(1e9, nActive) / 8e9) / Math.log10(405 / 8);
  return clamp(0.48 + 0.42 * x, 0.4, 0.95);
}
/**
 * Amdahl factor for a non-BF16 precision, against T_ideal at the TRAINING precision: only the GEMM share g runs at the
 * precision peak; attention softmax, norms and memory-bound ops stay at BF16 speed → factor = g + (1 − g) · peak_p / peak_bf16.
 * The peak ratio defaults to the standard 2× (FP8) / 4× (FP4) dense ratios when the envelope does not supply one.
 */
export function precisionAmdahlFactor(precision: string, nActive: number, peakRatio?: number): number {
  const r = peakRatio ?? (precision === 'fp8' ? 2 : precision === 'fp4' ? 4 : 1);
  const g = gemmShareFor(nActive);
  return g + (1 - g) * r;
}
/** κ_tp = 1 + a · log2(t) · clamp(t · 2048 / h, 0.25, 4); a = 0.045 [0.02, 0.07] derived (Hagemann 65B PP4 TP2→4→8 +9 % / +29 %; Meta ISCA'25 TP8→4 ≈ 10 %). No public support for t > 8 or t crossing the node — flagged extrapolation. */
export const TP_SHARD_SLOPE = { value: 0.045, lo: 0.02, hi: 0.07 };
export function tpShardFactor(tp: number, hidden: number): number {
  if (tp <= 1) return 1;
  return 1 + TP_SHARD_SLOPE.value * Math.log2(tp) * clamp((tp * 2048) / Math.max(1, hidden), 0.25, 4);
}
/** β by schedule: 1F1B (p−1)/m + 0.02 residual (ZB Tab. 5 after the model's own p2p); interleaved (p−1)/(v·m); DualPipe ≈ 0. Validated: ISCA 5 % at batch = 2p / 12 % at batch = p with v = 8. */
export function pipelineBubble(pp: number, m: number, schedule: '1f1b' | 'interleaved' | 'dualpipe', v: number): number {
  if (pp <= 1 || schedule === 'dualpipe') return 0;
  const vv = schedule === 'interleaved' ? Math.max(1, v) : 1;
  return clamp((pp - 1) / (vv * Math.max(1, m)) + (schedule === '1f1b' ? 0.02 : 0), 0, 0.95);
}

interface GroupBytes {
  total: number;
  byTier: Record<Tier, number>;
  /** bandwidth-model time (s) before overlap (scale-up + NIC) */
  timeS: number;
  /** scale-out (NIC) part of timeS */
  nicS: number;
  /** scale-up part of timeS — exposable now that the compute divisor holds no communication */
  suS: number;
  exposedS: number;
  hiddenS: number;
  state: 'hidden' | 'overlap-limited' | 'comm-bound' | 'critical-path';
  crossesMultipath: boolean;
  tier: string;
  f: number;
  windowS: number;
}

/** Pure traffic model — everything the panel shows comes from here. */
export function computeTraffic(spec: TrafficSpec): TrafficReport {
  const { model, training: t, gpu, fabric } = spec;
  const notes: string[] = [];
  const tp = Math.max(1, Math.round(t.tp));
  const pp = Math.max(1, Math.round(t.pp));
  const cp = Math.max(1, Math.round(t.cp ?? 1));
  const ep = Math.max(1, Math.round(t.ep));
  const tpp = tp * cp * pp;
  const gpus = Math.max(tpp, Math.floor(spec.gpus / tpp) * tpp);
  const dp = Math.max(1, Math.floor(gpus / tpp));
  const U = Math.max(1, gpu.scaleUpDomain);
  const L = Math.max(1, model.layers);
  const h = Math.max(1, model.hiddenSize);
  const s = Math.max(1, model.seqLen);
  const b = Math.max(1, Math.round(t.microBatchSeqs ?? 1));
  const nHeads = Math.max(1, Math.round(model.numHeads ?? h / 128));
  const nKv = Math.max(1, Math.round(model.kvHeads ?? nHeads));
  const dHead = model.headDim && model.headDim > 0 ? model.headDim : h / nHeads;
  const nActive = model.activeParamsB * 1e9;
  const nTotal = model.paramsB * 1e9;
  const tokensStep = t.globalBatchTokensM * 1e6;
  const tokensPerReplica = tokensStep / dp;
  const m = Math.max(1, Math.round(tokensPerReplica / (b * s)));
  const lStage = L / pp;
  // recompute: full re-runs the forward (8N + 16Lhs, Megatron form); selective (op-SAC) adds ~5 % — one factor shared with the memory model
  const recomputeFactor = trainingRecomputeFlopFactor(t);
  const recompute = recomputeFactor > 1.2; // full recompute (lengthens the backward window DP can hide behind)
  const flopsPerToken = (6 * nActive + 12 * L * h * s) * recomputeFactor;
  const flopsStep = tokensStep * flopsPerToken;
  // ── compute path: T_comp = T_ideal · amdahl(precision) / η_k · κ_tp(t) · (1 + β) — see COMPUTE_EFFICIENCY_BF16 ──
  const tIdealS = flopsStep / (gpus * gpu.peakFlops);
  const accClass = acceleratorClassOf(gpu.acceleratorName ?? gpu.platformName);
  const etaTable = COMPUTE_EFFICIENCY_BF16[accClass];
  const amdahl = precisionAmdahlFactor(t.precision, nActive);
  const kappaTp = tpShardFactor(tp, h);
  // schedule from the framework mode the blueprint already carries; v defaults to a vendor-recipe interleave depth
  const frameworkMode = spec.overlapFramework ?? 'fsdp-prefetch';
  const schedule: '1f1b' | 'interleaved' | 'dualpipe' = frameworkMode === 'dualpipe' ? 'dualpipe' : frameworkMode === 'megatron-no-overlap' ? '1f1b' : 'interleaved';
  const vStages = schedule === 'interleaved' ? clamp(Math.floor(lStage), 1, 8) : 1; // ≈ one layer per virtual stage, max 8 — reproduces ISCA 5 %/12 % (v = 8) and is the depth η_k(H100) was fitted at
  const bubble = pipelineBubble(pp, m, schedule, vStages);
  const compFor = (eta: number) => ((tIdealS * amdahl) / Math.max(0.05, eta)) * kappaTp;
  let etaK = etaTable.value;
  let tComp = compFor(etaK) * (1 + bubble); // provisional; re-evaluated (and η_k inverted) once every group exists

  // ── bytes per GPU per step ──
  // per-GPU activations are b·s/c tokens under context parallelism, so TP and PP bytes divide by c; CP's K/V gather divides by t (KV heads are TP-sharded)
  const tpBytes = tp > 1 ? (m * lStage * 8 * b * s * h * ((tp - 1) / tp) * B_ACT) / cp : 0;
  // long-context KV (r2-models.md §2): sliding-window layers hold at most `attentionWindow` tokens of KV; one layer in
  // `globalLayerInterval` attends globally (Gemma 3 5 local : 1 global → 6, gpt-oss alternating → 2). No window → every layer global.
  const kvSeq = kvSeqEffective(s, model.attentionWindow, model.globalLayerInterval);
  const cpBytes = cp > 1 ? (3 * m * lStage * 2 * b * kvSeq * nKv * dHead * B_ACT * ((cp - 1) / cp)) / tp : 0;
  const ppBytes = pp > 1 ? (2 * m * b * s * h * B_ACT) / (tp * cp) : 0;
  const psi = nTotal / (tp * pp * (model.moe ? ep : 1));
  const stage = t.zeroStage ?? TRAINING_ZERO_STAGE_DEFAULT; // one default, shared with the memory model (was 1 here vs 0 in the validator)
  const dpBytes = dp > 1 ? (stage >= 3 ? (2 * B_W + B_G) * psi : 2 * B_G * psi) * ((dp - 1) / dp) : 0;
  const moe = model.moe;
  const tokensPerGpu = tokensStep / dp;
  const kTop = moe ? Math.max(1, moe.topK) : 0;
  const M = Math.max(1, moe?.nodeLimit ?? 4);
  const epInDomain = ep * tp <= U;
  // expert all-to-all runs only on MoE layers: (L − denseLayers) / moeLayerInterval (DeepSeek-V3 3 dense of 61; Llama 4 Maverick every 2nd)
  const moeLayersStage = moe ? moeLayerCount(L, moe) / pp : 0;
  const epBytesFull = moe && ep > 1 ? tokensPerGpu * moeLayersStage * kTop * h * 3 * ((ep - 1) / ep) : 0;
  const epBytesNic = moe && ep > 1 ? tokensPerGpu * moeLayersStage * Math.min(kTop, M) * h * 3 * ((ep - 1) / ep) : 0;
  if (ep > 1 && !moe) notes.push(`EP=${ep} is set but the model has no MoE block (model.moe) — expert all-to-all bytes are not counted.`);

  // ── placement onto tiers ──
  const gLeaf = Math.max(U, fabric.gpusPerLeafDomain);
  const gSpine = Math.max(gLeaf, fabric.gpusPerSpineDomain);
  const members = (domain: number) => Math.max(1, Math.min(dp, Math.floor(domain / tpp)));
  const mU = members(U);
  const mL = members(gLeaf);
  const mS = members(gSpine);
  const zero = (): Record<Tier, number> => ({ 'scale-up': 0, leaf: 0, spine: 0, core: 0 });
  const suCap = gpu.scaleUpGBpsPerDir * GB * (gpu.scaleUpBusbw ?? SCALE_UP_BUSBW); // B/s per GPU
  const nicBusbw = gpu.nicBusbw ?? NIC_BUSBW;
  const nicCap = (gpu.nicGbps / 8) * GB * nicBusbw; // B/s per GPU
  const os = fabric.kind === 'ddc' ? 1 : Math.max(1, fabric.oversubscription);
  const eta = fabric.eta.value;
  const etaA2a = fabric.etaA2a && fabric.etaA2a > 0 ? fabric.etaA2a : eta;
  const etaOf = (g: Group) => (g === 'ep' ? etaA2a : eta);
  const hasSpine = fabric.tiers >= 2;
  const hasCore = fabric.tiers >= 3 && fabric.kind !== 'ddc';

  // overlap fractions: user values (training.overlap / spec.overlap) over the framework-mode defaults
  const mode = spec.overlapFramework ?? 'fsdp-prefetch';
  const odef = overlapDefaults(mode, { pp, m, layers: L });
  const fOf = (g: Group) => {
    const user = spec.overlap?.[g];
    return user != null && Number.isFinite(user) ? clamp(user, 0, 1) : odef[g].f;
  };
  // window as a share of the compute path (DP hides behind the backward pass only); applied in evaluate() below
  const windowShare = (g: Group) => (g === 'dp' ? (recompute ? 0.75 : 2 / 3) : 1);

  const nicTime = (byTier: Record<Tier, number>, etaG: number, ring: boolean): number => {
    // slowest tier wins: leaf link at busbw; spine/core links see the oversubscription and the load-balancing efficiency
    const leafT = byTier.leaf / nicCap;
    if (ring) {
      // fix v2 2차 (QA M2): in a ring every edge carries the same bytes, so the slowest (spine- / core-crossing) edge paces the whole
      // collective — the leaf bytes at the multipath capacity nicCap·min(1, η/os) (r2-eta.md §5.6 applies η to the whole FSDP time)
      const crossT = byTier.leaf / (nicCap * Math.min(1, etaG / os));
      const spineT = hasSpine && byTier.spine > 0 ? crossT : 0;
      const coreT = hasCore && byTier.core > 0 ? crossT : 0;
      return Math.max(leafT, spineT, coreT);
    }
    // alltoall (EP): only the crossing share of the bytes rides the spine / core
    const spineT = hasSpine ? (byTier.spine * os) / (nicCap * etaG) : 0;
    const coreT = hasCore ? (byTier.core * os) / (nicCap * etaG) : 0;
    return Math.max(leafT, spineT, coreT);
  };
  const groups: Record<Group, GroupBytes> = {} as Record<Group, GroupBytes>;
  const mk = (g: Group, total: number, byTier: Record<Tier, number>, tier: string): GroupBytes => {
    const suS = byTier['scale-up'] / suCap;
    const nicS = nicTime(byTier, etaOf(g), g !== 'ep');
    const f = fOf(g);
    const crossesMultipath = (hasSpine && byTier.spine > 0) || (hasCore && byTier.core > 0);
    // exposure is evaluated once every group exists (shared overlap budget) — see evaluate() in the step section
    const gb: GroupBytes = { total, byTier, timeS: suS + nicS, suS, nicS, exposedS: 0, hiddenS: 0, state: 'hidden', crossesMultipath, tier, f, windowS: 0 };
    groups[g] = gb;
    return gb;
  };
  // fraction of a contiguous group's boundaries that leave a domain of `domain` GPUs
  const spanFrac = (groupGpus: number, domain: number, hops: number) => (hops <= 0 ? 0 : clamp((Math.ceil(groupGpus / domain) - 1) / hops, 0, 1));
  // TP
  {
    const bt = zero();
    if (tp <= U) bt['scale-up'] = tpBytes;
    else {
      bt.leaf = tpBytes;
      bt.spine = hasSpine ? tpBytes * spanFrac(tp, gLeaf, tp - 1) : 0;
      bt.core = hasCore ? tpBytes * spanFrac(tp, gSpine, tp - 1) : 0;
      if (tpBytes > 0) notes.push(`TP=${tp} exceeds the scale-up domain (${U}) — tensor-parallel all-reduces leave NVLink (Megatron: keep TP inside the server).`);
    }
    mk('tp', tpBytes, bt, tp <= U ? 'scale-up' : 'leaf');
  }
  // CP
  {
    const bt = zero();
    if (tp * cp <= U) bt['scale-up'] = cpBytes;
    else {
      bt.leaf = cpBytes;
      bt.spine = hasSpine ? cpBytes * spanFrac(tp * cp, gLeaf, cp - 1) : 0;
      bt.core = hasCore ? cpBytes * spanFrac(tp * cp, gSpine, cp - 1) : 0;
    }
    mk('cp', cpBytes, bt, tp * cp <= U ? 'scale-up' : 'leaf');
  }
  // PP
  {
    const bt = zero();
    if (tpp <= U) bt['scale-up'] = ppBytes;
    else {
      const nicFrac = spanFrac(tpp, U, pp - 1);
      bt['scale-up'] = ppBytes * (1 - nicFrac);
      bt.leaf = ppBytes * nicFrac;
      bt.spine = hasSpine ? ppBytes * spanFrac(tpp, gLeaf, pp - 1) : 0;
      bt.core = hasCore ? ppBytes * spanFrac(tpp, gSpine, pp - 1) : 0;
    }
    mk('pp', ppBytes, bt, tpp <= U ? 'scale-up' : bt.spine > 0 ? 'leaf+spine' : 'leaf');
  }
  // DP (hierarchical 2-level: in-domain RS/AG on NVLink, cross-domain ring among domain leaders on the NIC)
  {
    const bt = zero();
    if (dpBytes > 0) {
      if (mU >= dp) bt['scale-up'] = dpBytes;
      else {
        const nic = (dpBytes / mU) * (1 - mU / dp) * (fabric.sharp ? 0.5 : 1);
        bt['scale-up'] = dpBytes * (1 - 1 / mU);
        bt.leaf = nic;
        bt.spine = hasSpine && mL < dp ? nic * (mU / mL) : 0;
        bt.core = hasCore && mS < dp ? nic * (mU / mS) : 0;
      }
    }
    mk('dp', dpBytes, bt, mU >= dp ? 'scale-up' : bt.core > 0 ? 'leaf+spine+core' : bt.spine > 0 ? 'leaf+spine' : 'leaf');
  }
  // EP
  {
    const bt = zero();
    if (epBytesFull > 0) {
      if (epInDomain) bt['scale-up'] = epBytesFull;
      else {
        const nodes = Math.ceil((ep * tp) / U);
        const crossFrac = clamp((nodes - 1) / nodes, 0, 1);
        bt['scale-up'] = epBytesFull * (1 - crossFrac);
        bt.leaf = epBytesNic * crossFrac;
        const podsSpanned = Math.ceil((ep * tp) / gLeaf);
        bt.spine = hasSpine && podsSpanned > 1 ? bt.leaf * clamp((podsSpanned - 1) / Math.max(1, nodes - 1), 0, 1) : 0;
        const spinesSpanned = Math.ceil((ep * tp) / gSpine);
        bt.core = hasCore && spinesSpanned > 1 ? bt.leaf * clamp((spinesSpanned - 1) / Math.max(1, nodes - 1), 0, 1) : 0;
        notes.push(`EP=${ep} spans ${nodes} scale-up domains — node-limited routing (M ≤ ${M}) caps NIC bytes at min(k_top, M)·h·3 B per token per layer (DeepSeek-V3 §3.2.2).`);
      }
    }
    mk('ep', epBytesFull, bt, epBytesFull === 0 ? '-' : epInDomain ? 'scale-up' : bt.spine > 0 ? 'leaf+spine' : 'leaf');
  }

  // ── step time: shared overlap budget, then the optional inversion of an end-to-end calibration ──
  const G = Object.keys(groups) as Group[];
  // Scale-up AND scale-out time of every group is exposable now that the divisor holds no communication. A group hides
  // at most f_g·T_g inside its own window, and all groups share ONE compute window (DP its 2/3 slice):
  // exposed = Σ (T_g − hidden_g) + max(0, Σ hidden_g − W_shared). The bubble also idles the per-micro-batch TP / CP
  // collectives, so (1 + β) multiplies compute plus those two exposures; DP / PP / EP exposure sits outside the pipeline.
  const evaluate = (eta: number) => {
    const comp = compFor(eta);
    const hidden: Partial<Record<Group, number>> = {};
    let requested = 0;
    for (const g of G) {
      const hid = Math.min(groups[g].f * groups[g].timeS, windowShare(g) * comp);
      hidden[g] = hid;
      requested += hid;
    }
    const scale = requested > comp ? comp / requested : 1;
    const exposedBy: Partial<Record<Group, number>> = {};
    let inPipe = 0;
    let outside = 0;
    for (const g of G) {
      const e = Math.max(0, groups[g].timeS - (hidden[g] ?? 0) * scale);
      exposedBy[g] = e;
      if (g === 'tp' || g === 'cp') inPipe += e; else outside += e;
    }
    return { comp, hidden, scale, exposedBy, exposed: inPipe + outside, step: (comp + inPipe) * (1 + bubble) + outside };
  };
  // training.mfuAssumed is an END-TO-END target (paper / MLPerf MFUs are wall clock): invert for η_k with the very model
  // that will predict the exposure, so calibration and prediction can never disagree by the communication terms.
  let calibrated = false;
  if (t.mfuAssumed && t.mfuAssumed > 0) {
    const target = clamp(t.mfuAssumed, 0.02, 0.99);
    let lo = 0.05;
    let hi = 1;
    for (let i = 0; i < 48; i++) {
      const mid = (lo + hi) / 2;
      if (tIdealS / evaluate(mid).step < target) lo = mid; else hi = mid;
    }
    etaK = (lo + hi) / 2;
    calibrated = true;
  }
  const ev = evaluate(etaK);
  tComp = ev.comp * (1 + bubble);
  for (const g of G) {
    const gb = groups[g];
    gb.windowS = windowShare(g) * ev.comp;
    gb.hiddenS = (ev.hidden[g] ?? 0) * ev.scale;
    gb.exposedS = ev.exposedBy[g] ?? 0;
    const rho = gb.windowS > 0 ? gb.timeS / gb.windowS : Number.POSITIVE_INFINITY;
    gb.state = gb.timeS <= 0 ? 'hidden' : gb.f <= 0 ? 'critical-path' : gb.f * rho > 1 ? 'comm-bound' : gb.exposedS / Math.max(1e-9, ev.step) < 0.01 ? 'hidden' : 'overlap-limited';
  }
  const exposed = ev.exposed;
  const commTime = G.reduce((sum, g) => sum + groups[g].timeS, 0);
  const nicCommTime = G.reduce((sum, g) => sum + groups[g].nicS, 0);
  const suCommTime = G.reduce((sum, g) => sum + groups[g].suS, 0);
  const stepTime = ev.step;
  const mfuEff = tIdealS / stepTime;
  const bindingGroup = G.filter((g) => groups[g].exposedS > 0).sort((a, b2) => groups[b2].exposedS - groups[a].exposedS)[0];

  // ── per-tier utilization (burst window) and headroom ──
  const tierBytes = zero();
  const tierBurst = zero();
  const tierAvg = zero();
  for (const g of G) {
    const gb = groups[g];
    const window = g === 'dp' ? 0.5 * tComp : tComp;
    for (const tier of ['scale-up', 'leaf', 'spine', 'core'] as Tier[]) {
      const bytes = gb.byTier[tier];
      if (bytes <= 0) continue;
      tierBytes[tier] += bytes;
      const cap = tier === 'scale-up' ? suCap : nicCap;
      const lb = tier === 'spine' || tier === 'core' ? etaOf(g) : 1;
      const osT = tier === 'spine' || tier === 'core' ? os : 1;
      tierBurst[tier] += (bytes * osT) / (cap * lb * window);
      tierAvg[tier] += (bytes * osT) / (cap * lb * stepTime);
    }
  }
  const tiers: Tier[] = ['scale-up', 'leaf', ...(hasSpine ? (['spine'] as Tier[]) : []), ...(hasCore ? (['core'] as Tier[]) : [])];
  const perTier: TrafficReport['perTier'] = tiers.map((tier) => {
    const u = tierBurst[tier];
    return {
      tier,
      bytesPerStepGB: tierBytes[tier] / GB,
      utilization: u,
      headroom: u > 0 ? 1 / u - 1 : Number.POSITIVE_INFINITY,
      utilizationAvg: tierAvg[tier],
      capacityGBps: (tier === 'scale-up' ? suCap : nicCap) / GB,
    };
  });

  // ── min oversubscription (largest N:1 that keeps spine/core headroom ≥ 0) ──
  let minOs = MAX_OVERSUB;
  for (const tier of ['spine', 'core'] as Tier[]) {
    if (!tiers.includes(tier)) continue;
    const at1 = tierBurst[tier] / os;
    if (at1 > 0) minOs = Math.min(minOs, Math.floor((1 / at1) * 2) / 2);
  }
  minOs = fabric.kind === 'ddc' ? 1 : clamp(minOs, 1, MAX_OVERSUB);
  if (hasSpine && tierBytes.spine <= 0) notes.push('No collective crosses the spine tier for this parallelism — leaf oversubscription is not exercised by this workload.');

  // ── effective communication efficiency (time-weighted over groups, slowest-edge rule for multipath tiers) ──
  const worst = Math.max(...tiers.map((tier) => tierBurst[tier]), 0);
  const congestion = worst > 1 ? 1 / worst : 1;
  let tIdeal = 0;
  let tActual = 0;
  for (const g of G) {
    const gb = groups[g];
    const nicBytes = gb.byTier.leaf;
    if (nicBytes <= 0) continue;
    const ideal = nicBytes / nicCap;
    tIdeal += ideal;
    tActual += ideal / (gb.crossesMultipath ? etaOf(g) : 1);
  }
  const lbEff = tIdeal > 0 ? tIdeal / tActual : 1;
  const hopF = hasCore ? 0.98 : 1;
  const commEff = clamp(lbEff * congestion * (fabric.speedFactor ?? 1) * hopF, 0.05, 1);

  // ── L2/L3 ──
  const l2l3 = l2l3Verdict({ endpoints: gpus, switches: fabric.leaves, k: fabric.k, multiTenant: fabric.multiTenant, planes: fabric.planes });

  // ── inference block (KV bytes/token, P/D transfer, EP decode ceiling) ──
  let inference: TrafficReport['inference'];
  if (spec.inference) {
    const inf = spec.inference.params;
    const prompt = inferencePromptTokens(inf);
    const im = spec.inference.model;
    const bKv = PRECISION_BYTES[inf.kvPrecision ?? 'fp8'] ?? 1;
    const iL = Math.max(1, im.layers);
    const iH = Math.max(1, im.hiddenSize);
    const iHeads = Math.max(1, Math.round(im.numHeads ?? iH / 128));
    const iKv = Math.max(1, Math.round(im.kvHeads ?? iHeads));
    const iHeadDim = im.headDim && im.headDim > 0 ? im.headDim : iH / iHeads;
    const mla = im.mla;
    const iKvLayerFraction = clamp(im.kvCacheLayerFraction ?? 1, 0, 1);
    // KV bytes/token: GQA/MHA 2·L·n_kv·d_head·B_kv; MLA L·(d_c + d_rope)·B_kv (DeepSeek-V2 §2.1; anchors: V3 70.3 KB, Llama 3.1 405B 516 KB at 2 B)
    // sliding-window layers cap the prompt's KV at the window (averaged per prompt token; MLA models have no window)
    const iKvSeq = kvSeqEffective(Math.max(1, inf.inputTokens), im.attentionWindow, im.globalLayerInterval);
    const kvBytesPerToken = mla ? iL * iKvLayerFraction * (mla.dLatent + mla.dRope) * bKv : (2 * iL * iKvLayerFraction * iKv * iHeadDim * bKv * iKvSeq) / Math.max(1, inf.inputTokens);
    // DistServe §3.3: R_KV = rps × prompt tokens × KV bytes/token
    const kvTransferGbps = (inf.requestsPerSec * prompt.transfer * kvBytesPerToken * 8) / GB;
    // DeepSeek insights §2.3.2: (1 B + 2 B) × 32 tokens × k experts × h per layer, dispatch + combine, over the interconnect
    const iMoe = im.moe;
    const iTop = iMoe ? Math.max(1, iMoe.topK) : 0;
    const iPrefill = inferenceParallelismFor(inf, 'prefill');
    const iDecode = inferenceParallelismFor(inf, 'decode');
    const iPrefillGpus = inferenceReplicaGpus(iPrefill);
    const iDecodeGpus = inferenceReplicaGpus(iDecode);
    const iEpInDomain = inferenceExpertCollectiveGpus(iDecode) <= U;
    const a2aBw = iEpInDomain ? suCap : nicCap;
    const epDecodeTokPerSPerUser = iMoe && iDecode.ep > 1 ? a2aBw / (Math.max(1, moeLayerCount(iL, iMoe)) * 2 * iTop * iH * 3 * ((iDecode.ep - 1) / iDecode.ep)) : Number.POSITIVE_INFINITY;
    const pdGbps = kvTransferGbps;
    inference = {
      kvBytesPerToken,
      kvTransferGbps: pdGbps,
      remoteCacheTransferGbps: (inf.requestsPerSec * prompt.remoteCached * kvBytesPerToken * 8) / GB,
      gpuCacheHitRate: prompt.input > 0 ? prompt.gpuCached / prompt.input : 0,
      remoteCacheHitRate: prompt.input > 0 ? prompt.remoteCached / prompt.input : 0,
      epDecodeTokPerSPerUser,
      attention: mla ? 'mla' : 'gqa',
      disaggregated: inf.disaggregated,
      prefillParallelism: iPrefill,
      decodeParallelism: iDecode,
      prefillInstanceGpus: iPrefillGpus,
      decodeInstanceGpus: iDecodeGpus,
    };
    notes.push(`Inference (${im.name}): prefill TP${iPrefill.tp}·PP${iPrefill.pp}·EP${iPrefill.ep}·CP${iPrefill.cp} (${iPrefillGpus} GPUs), decode TP${iDecode.tp}·PP${iDecode.pp}·EP${iDecode.ep}·CP${iDecode.cp} (${iDecodeGpus} GPUs); KV ${(kvBytesPerToken / 1024).toFixed(1)} KB/token (${mla ? 'MLA' : `GQA, d_head ${iHeadDim}${im.attentionWindow ? `, window ${im.attentionWindow} with 1 global layer in ${im.globalLayerInterval ?? '∞'}` : ''}`}, ${inf.kvPrecision ?? 'fp8'}); ${prompt.cached > 0 ? `${prompt.mode === 'trace' ? 'trace-calibrated cache' : 'warm prefix'} ${prompt.cached.toFixed(0)}/${prompt.input} tokens; ` : ''}${prompt.transfer > 0 ? `KV movement ${pdGbps.toFixed(1)} Gb/s aggregate (${prompt.remoteCached.toFixed(0)} remote-cache${inf.disaggregated ? ` + ${prompt.uncached.toFixed(0)} P/D` : ''} tokens/request)` : 'no remote/P-D KV movement'}${iMoe && iDecode.ep > 1 ? `; EP${iDecode.ep} all-to-all decode ceiling ≈ ${epDecodeTokPerSPerUser.toFixed(0)} tok/s/user on ${iEpInDomain ? 'the scale-up domain' : 'the NIC'}` : ''}.`);
  }

  // ── notes ──
  const overlapTxt = G.filter((g) => groups[g].timeS > 0).map((g) => `${g.toUpperCase()} f ${groups[g].f.toFixed(3)} (${spec.overlap?.[g] != null ? 'user' : odef[g].sourceType}, ${groups[g].state})`).join(' · ');
  notes.unshift(
    `Compute ${recompute ? '8·N_active + 16·L·h·s (full activation recompute, Megatron 96-form)' : recomputeFactor > 1 ? '(6·N_active + 12·L·h·s) × 1.05 (selective op-SAC recompute, estimate)' : '6·N_active + 12·L·h·s (PaLM App. B)'} = ${(flopsStep / 1e18).toFixed(2)} EFLOP/step; T_ideal ${tIdealS.toFixed(2)} s → T_comp ${tComp.toFixed(2)} s = T_ideal × amdahl ${amdahl.toFixed(2)} ÷ η_k ${etaK.toFixed(3)} (${calibrated ? 'inverted from the end-to-end calibration' : `${accClass} ${etaTable.sourceType}, band ${etaTable.lo}–${etaTable.hi}`}) × κ_tp ${kappaTp.toFixed(3)} × (1 + β ${(bubble * 100).toFixed(1)} %). Predicted end-to-end MFU ${(mfuEff * 100).toFixed(1)} %.`,
    `Parallelism TP${tp}·CP${cp}·PP${pp} = ${tpp} GPUs per replica, DP ${dp}${moe ? `, EP ${ep}` : ''}; micro-batches ${m} × ${b} seq; schedule ${schedule}${schedule === 'interleaved' ? ` (v = ${vStages})` : ''} → bubble ${(bubble * 100).toFixed(1)} % applied to the step${bindingGroup ? `; binding group ${bindingGroup.toUpperCase()} (${groups[bindingGroup].state})` : ''}.`,
    `Group placement — TP: ${groups.tp.tier}, CP: ${groups.cp.tier}, PP: ${groups.pp.tier}, DP: ${groups.dp.tier} (members per NVLink domain ${mU}, per pod ${mL}, per spine domain ${mS})${moe ? `, EP: ${groups.ep.tier}` : ''}.`,
    `η_fabric = ${eta} on spine/core tiers (${fabric.eta.class}; ${fabric.eta.citation})${etaA2a !== eta ? `; η_A2A = ${etaA2a.toFixed(3)} for expert all-to-all (measured alltoall)` : ''}; η_host (NIC busbw) = ${nicBusbw}.${fabric.sharp ? ' SHARP in-network reduction halves DP bytes on the NIC tiers (IB).' : ''}`,
    `Overlap: exposed = Σ_g (T_g − min(f_g·T_g, W_g)) + max(0, Σ hidden − W_shared), scale-up and scale-out both exposable; framework mode ${mode}${overlapTxt ? ` — ${overlapTxt}` : ''}.`,
  );
  if (exposed > 0) notes.push(`Exposed communication ${exposed.toFixed(3)} s of ${stepTime.toFixed(2)} s per step (${((exposed / stepTime) * 100).toFixed(2)} %) — scale-out collective time before overlap ${nicCommTime.toFixed(3)} s.`);
  if (worst > 1) notes.push(`Tier over capacity in its burst window (×${worst.toFixed(2)}) — collectives are throttled; effective efficiency ×${congestion.toFixed(2)}.`);

  const overlap = Object.fromEntries(
    G.map((g) => [g, { f: groups[g].f, windowS: groups[g].windowS, nicCommS: groups[g].nicS, exposedS: groups[g].exposedS, suCommS: groups[g].suS, commS: groups[g].timeS, hiddenS: groups[g].hiddenS, state: groups[g].state, sourceType: spec.overlap?.[g] != null ? 'user' : odef[g].sourceType, citation: spec.overlap?.[g] != null ? 'User-entered overlap fraction' : odef[g].citation, ...(odef[g].url ? { url: odef[g].url } : {}), ...(odef[g].measureIt ? { measureIt: true } : {}) }]),
  ) as NonNullable<TrafficReport['overlap']>;

  return {
    mode: 'training',
    basis: 'training-step',
    perTier,
    bytesPerStepByGroup: { tp: groups.tp.total / GB, pp: groups.pp.total / GB, dp: groups.dp.total / GB, ep: groups.ep.total / GB, cp: groups.cp.total / GB },
    minOversubscription: minOs,
    l2l3,
    commEfficiencyEffective: commEff,
    stepTimeS: stepTime,
    notes,
    eta: fabric.eta,
    computeTimeS: tComp,
    exposedCommS: exposed,
    computeIdealS: tIdealS,
    computeEfficiency: {
      value: etaK,
      lo: calibrated ? etaK : etaTable.lo,
      hi: calibrated ? etaK : etaTable.hi,
      accelerator: accClass,
      sourceType: calibrated ? 'user-measured' : etaTable.sourceType,
      citation: calibrated ? `Inverted from training.mfuAssumed ${t.mfuAssumed} (an end-to-end figure) through this model, so its exposed communication is removed by the same terms that predict it` : etaTable.citation,
      calibrated,
    },
    pipelineBubble: bubble,
    tpShardFactor: kappaTp,
    suCommTimeS: suCommTime,
    ...(bindingGroup ? { bindingGroup } : {}),
    commTimeS: commTime,
    nicCommTimeS: nicCommTime,
    mfuEffective: mfuEff,
    groupTier: { tp: groups.tp.tier, cp: groups.cp.tier, pp: groups.pp.tier, dp: groups.dp.tier, ep: groups.ep.tier },
    physical: physicalEnvelope(gpu, suCap, nicCap),
    inference,
    overlap,
    overlapFramework: mode,
    etaHost: nicBusbw,
    ...(etaA2a !== eta ? { etaA2a } : {}),
  };
}

/** MoE layers of a model: (layers − denseLayers) / moeLayerInterval (at least 1 when the model has an MoE block). */
export function moeLayerCount(layers: number, moe: { denseLayers?: number; moeLayerInterval?: number }): number {
  const dense = Math.max(0, Math.min(layers, moe.denseLayers ?? 0));
  return Math.max(1, (layers - dense) / Math.max(1, moe.moeLayerInterval ?? 1));
}

/**
 * Effective KV sequence per layer (averaged over layers) for a sequence of `seq` tokens: global layers keep `seq`, sliding-window
 * layers keep min(seq, window). `globalInterval` n → 1 global layer in n (undefined with a window → all windowed).
 */
export function kvSeqEffective(seq: number, window?: number, globalInterval?: number): number {
  if (!window || window <= 0 || window >= seq) return seq;
  const g = globalInterval && globalInterval > 0 ? 1 / globalInterval : 0;
  return g * seq + (1 - g) * window;
}

/** Peak FLOPS at a training precision from the catalog (peakTflops by precision, else gpuFlopsPeak × multiplier as workload.ts does). */
export function peakFlopsFor(c: { gpuFlopsPeak: number; peakTflops?: Partial<Record<string, number>> }, precision: string): number {
  const p = c.peakTflops?.[precision];
  if (p && p > 0) return p * 1e12;
  const mult: Record<string, number> = { bf16: 1, fp8: 1.3, fp4: 1.6 };
  return c.gpuFlopsPeak * (mult[precision] ?? 1);
}

/** Build the traffic spec from the project / network result for a training blueprint (undefined when it cannot run). */
export function buildTrafficSpec(input: TrafficInput): { spec: TrafficSpec; notes: string[] } | undefined {
  const { project, workload: w, ctx, network } = input;
  const t = w.training;
  if (!t) return undefined;
  const tpp = Math.max(1, t.tp * Math.max(1, t.cp ?? 1) * t.pp);
  const built = buildTrafficEnvelope(input, tpp, t.precision, 'Training job');
  if (!built) return undefined;
  const { gpu, fabric, gpus, notes } = built;
  const inference = project.workloads.find((x) => x.kind === 'llm-inference');
  const ov = t.overlap as (NonNullable<typeof t.overlap> & { ep?: number; cp?: number; framework?: OverlapFramework }) | undefined;
  const overlap: Partial<Record<Group, number>> = {};
  for (const g of ['tp', 'cp', 'pp', 'dp', 'ep'] as Group[]) {
    const v = ov?.[g];
    if (typeof v === 'number' && Number.isFinite(v)) overlap[g] = v;
  }
  const spec: TrafficSpec = {
    model: w.model,
    training: t,
    inference: inference?.inference ? { params: inference.inference, model: inference.model } : undefined,
    gpus,
    gpu,
    fabric,
    ...(Object.keys(overlap).length ? { overlap } : {}),
    ...(ov?.framework ? { overlapFramework: ov.framework } : {}),
  };
  return { spec, notes };
}

interface TrafficEnvelope {
  gpus: number;
  gpu: TrafficGpu;
  fabric: TrafficFabric;
  plan: NetworkResult['plans'][number];
  notes: string[];
}

/** Build the physical traffic envelope from GPU racks that are actually placed in the layout and the calculated scale-out plan. */
function buildTrafficEnvelope(input: TrafficInput, allocationMultiple: number, precision: string, jobLabel: string): TrafficEnvelope | undefined {
  const { project, workload: w, ctx, network } = input;
  const gpuRack = ctx.gpuRack;
  const c = gpuRack?.compute;
  if (!c || ctx.gpus <= 0) return undefined;
  const plan = network.plans.find((p) => p.key === 'scale-out');
  if (!plan || plan.links <= 0) return undefined;
  const so = project.network.scaleOut;
  // a job never spans clusters: the GPU share is taken from the cluster that carries the primary scale-out plan
  const clusterGpus = plan.clusterGpus ?? ctx.gpus;
  const unit = Math.max(1, Math.round(allocationMultiple));
  const gpus = Math.floor((clamp(w.gpuShare, 0, 1) * clusterGpus) / unit) * unit;
  if (gpus < unit) return undefined;
  const notes: string[] = [];
  if (plan.clusterGpus !== undefined && plan.clusterGpus < ctx.gpus) notes.push(`${jobLabel} sized inside cluster '${plan.clusterName ?? plan.clusterId}' (${plan.clusterGpus} of ${ctx.gpus} GPUs) — ${jobLabel === 'Training job' ? 'collectives' : 'traffic'} never cross clusters.`);
  const portsPerGpu = Math.max(1, c.scaleOutPortsPerGpu);
  const switchPortGbps = plan.sw.switch?.portGbps ?? c.scaleOutPortGbps;
  const lanes = Math.max(1, Math.round(c.scaleOutPortGbps / switchPortGbps));
  // GPUs per leaf domain = average GPUs of the pods that carry scale-out endpoints
  let podGpus = 0;
  let pods = 0;
  for (const [pod, eps] of plan.endpointsByPod) {
    if (!eps.length) continue;
    pods++;
    podGpus += (ctx.byPod.get(pod) ?? []).reduce((s, p) => s + (p.item.category === 'gpu-rack' ? p.item.compute?.gpus ?? 0 : 0), 0);
  }
  const gpusPerLeafDomain = pods > 0 ? podGpus / pods : clusterGpus;
  const k = plan.sw.switch?.ports ?? 64;
  const gpusPerSpineDomain = plan.gpusPerSpineDomain ?? (plan.tiers >= 3 && plan.kind !== 'ddc' ? Math.max(gpusPerLeafDomain, (Math.floor(k / 2) * plan.downPerLeaf) / (portsPerGpu * lanes)) : clusterGpus);
  const isIb = so.fabric.startsWith('ib-');
  const eta = etaFor(so);
  const nicGbps = c.scaleOutPortGbps * portsPerGpu;
  const speedFactor = nicGbps > 0 ? Math.min(1, (plan.linkGbps * lanes) / c.scaleOutPortGbps) : 1;
  return {
    gpus,
    plan,
    notes,
    gpu: {
      peakFlops: peakFlopsFor(c, precision),
      scaleUpDomain: c.scaleUp.domainSize,
      scaleUpGBpsPerDir: c.scaleUp.gbpsPerGpu / 8 / 2,
      nicGbps,
      nicBusbw: eta.host,
      platformId: gpuRack.id,
      platformName: gpuRack.name,
      acceleratorName: c.gpuModel,
      scaleUpKind: c.scaleUp.kind,
      scaleUpName: c.scaleUp.family ?? SCALE_UP_NAMES[c.scaleUp.kind],
      scaleOutFabric: so.fabric,
      scaleOutNicPortsPerGpu: portsPerGpu,
      scaleOutNicPortGbps: c.scaleOutPortGbps,
      scaleOutSwitchName: plan.sw.name,
      scaleOutSwitchPortGbps: switchPortGbps,
      scaleOutSwitchPortsPerGpu: (portsPerGpu * c.scaleOutPortGbps) / Math.max(1, switchPortGbps),
    },
    fabric: {
      kind: plan.kind,
      tiers: plan.tiers,
      k,
      oversubscription: plan.oversubscription,
      gpusPerLeafDomain,
      gpusPerSpineDomain,
      leaves: plan.leaves,
      eta: { value: eta.value, class: eta.class, source: eta.source, citation: eta.citation, overridden: eta.overridden },
      ...(eta.a2a !== undefined ? { etaA2a: eta.a2a } : {}),
      sharp: isIb,
      speedFactor,
    },
  };
}

type ServingGroup = Group | 'pd';

/**
 * Inference traffic is a steady-state rate model, not a synthetic training step. Values stored in the legacy
 * `bytesPerStep*` fields are GB/s when `basis === 'inference-second'`.
 */
export function computeInferenceTraffic(spec: InferenceTrafficSpec): TrafficReport {
  const { model, inference: inf, gpu, fabric } = spec;
  const notes: string[] = [];
  const U = Math.max(1, gpu.scaleUpDomain);
  const gLeaf = Math.max(U, fabric.gpusPerLeafDomain);
  const gSpine = Math.max(gLeaf, fabric.gpusPerSpineDomain);
  const hasSpine = fabric.tiers >= 2;
  const hasCore = fabric.tiers >= 3 && fabric.kind !== 'ddc';
  const os = fabric.kind === 'ddc' ? 1 : Math.max(1, fabric.oversubscription);
  const eta = fabric.eta.value;
  const etaA2a = fabric.etaA2a && fabric.etaA2a > 0 ? fabric.etaA2a : eta;
  const nicBusbw = gpu.nicBusbw ?? NIC_BUSBW;
  const suCap = gpu.scaleUpGBpsPerDir * GB * (gpu.scaleUpBusbw ?? SCALE_UP_BUSBW);
  const nicCap = (gpu.nicGbps / 8) * GB * nicBusbw;
  const prefill = inferenceParallelismFor(inf, 'prefill');
  const decode = inferenceParallelismFor(inf, 'decode');
  const prefillGpus = inferenceReplicaGpus(prefill);
  const decodeGpus = inferenceReplicaGpus(decode);
  const deploymentGpus = inf.disaggregated ? prefillGpus + decodeGpus : prefillGpus;
  const requestedPrefillGpus = (prefill.dp ?? 0) * prefillGpus;
  const requestedDecodeGpus = (decode.dp ?? 0) * decodeGpus;
  const requestedDeploymentGpus = inf.disaggregated ? requestedPrefillGpus + requestedDecodeGpus : requestedPrefillGpus;
  const fixedDeploymentFits = requestedDeploymentGpus > 0 && requestedDeploymentGpus <= spec.gpus
    && (!inf.disaggregated || (!!prefill.dp && !!decode.dp));
  const pairedAllocatedGpus = Math.max(deploymentGpus, Math.floor(spec.gpus / deploymentGpus) * deploymentGpus);
  const replicas = Math.max(1, Math.floor(pairedAllocatedGpus / deploymentGpus));
  let prefillReplicas = fixedDeploymentFits ? prefill.dp! : replicas;
  let decodeReplicas = fixedDeploymentFits ? (inf.disaggregated ? decode.dp! : prefill.dp!) : replicas;
  if (inf.disaggregated && !fixedDeploymentFits) {
    // A stage-specific DP remains meaningful even when the other stage is automatic. Fill the remainder with
    // whole replicas for the automatic stage so the traffic view and workload result describe the same pools.
    if (prefill.dp && prefill.dp * prefillGpus + decodeGpus <= spec.gpus && !decode.dp) {
      prefillReplicas = prefill.dp;
      decodeReplicas = Math.max(1, Math.floor((spec.gpus - prefillReplicas * prefillGpus) / decodeGpus));
    } else if (decode.dp && decode.dp * decodeGpus + prefillGpus <= spec.gpus && !prefill.dp) {
      decodeReplicas = decode.dp;
      prefillReplicas = Math.max(1, Math.floor((spec.gpus - decodeReplicas * decodeGpus) / prefillGpus));
    }
  }
  const allocatedGpus = inf.disaggregated
    ? prefillReplicas * prefillGpus + decodeReplicas * decodeGpus
    : prefillReplicas * prefillGpus;
  const L = Math.max(1, model.layers);
  const h = Math.max(1, model.hiddenSize);
  const nHeads = Math.max(1, Math.round(model.numHeads ?? h / 128));
  const nKv = Math.max(1, Math.round(model.kvHeads ?? nHeads));
  const dHead = model.headDim && model.headDim > 0 ? model.headDim : h / nHeads;
  const kvB = PRECISION_BYTES[inf.kvPrecision ?? 'fp8'] ?? 1;
  const moe = model.moe;
  const kTop = moe ? Math.max(1, moe.topK) : 0;
  const tierBytes: Record<Tier, number> = { 'scale-up': 0, leaf: 0, spine: 0, core: 0 };
  const tierUtil: Record<Tier, number> = { 'scale-up': 0, leaf: 0, spine: 0, core: 0 };
  const groupBytes: Record<ServingGroup, number> = { tp: 0, cp: 0, pp: 0, dp: 0, ep: 0, pd: 0 };
  const groupByTier = Object.fromEntries((['tp', 'cp', 'pp', 'ep', 'pd'] as ServingGroup[]).map((g) => [g, { 'scale-up': 0, leaf: 0, spine: 0, core: 0 }])) as Record<ServingGroup, Record<Tier, number>>;
  const groupRoute: Record<ServingGroup, string> = { tp: '-', cp: '-', pp: '-', dp: '-', ep: '-', pd: '-' };
  const spanFrac = (groupGpus: number, domain: number, hops: number) => (hops <= 0 ? 0 : clamp((Math.ceil(groupGpus / domain) - 1) / hops, 0, 1));
  const routeOf = (bt: Record<Tier, number>) => bt.core > 0 ? 'leaf+spine+core' : bt.spine > 0 ? 'leaf+spine' : bt.leaf > 0 ? 'leaf' : bt['scale-up'] > 0 ? 'scale-up' : '-';
  const routeRank = (route: string) => route === 'leaf+spine+core' ? 4 : route === 'leaf+spine' ? 3 : route === 'leaf' ? 2 : route === 'scale-up' ? 1 : 0;
  const add = (group: ServingGroup, bytesPerSecond: number, bt: Record<Tier, number>) => {
    if (!(bytesPerSecond > 0)) return;
    groupBytes[group] += bytesPerSecond;
    for (const tier of ['scale-up', 'leaf', 'spine', 'core'] as Tier[]) groupByTier[group][tier] += bt[tier];
    const route = routeOf(bt);
    if (routeRank(route) > routeRank(groupRoute[group])) groupRoute[group] = route;
  };
  const routeCollective = (group: Exclude<ServingGroup, 'dp' | 'pd'>, bytesPerSecond: number, p: ReturnType<typeof inferenceParallelismFor>) => {
    if (!(bytesPerSecond > 0)) return;
    const bt: Record<Tier, number> = { 'scale-up': 0, leaf: 0, spine: 0, core: 0 };
    const groupGpus = group === 'tp' ? p.tp : group === 'cp' ? p.tp * p.cp : group === 'pp' ? inferenceReplicaGpus({ ...p, pp: p.pp, ep: 1 }) : inferenceExpertCollectiveGpus(p);
    if (groupGpus <= U) bt['scale-up'] = bytesPerSecond;
    else if (group === 'ep') {
      const domains = Math.ceil(groupGpus / U);
      const cross = clamp((domains - 1) / domains, 0, 1);
      bt['scale-up'] = bytesPerSecond * (1 - cross);
      bt.leaf = bytesPerSecond * cross;
      bt.spine = hasSpine ? bt.leaf * spanFrac(groupGpus, gLeaf, Math.max(1, domains - 1)) : 0;
      bt.core = hasCore ? bt.leaf * spanFrac(groupGpus, gSpine, Math.max(1, domains - 1)) : 0;
    } else {
      bt.leaf = bytesPerSecond;
      bt.spine = hasSpine ? bytesPerSecond * spanFrac(groupGpus, gLeaf, Math.max(1, groupGpus - 1)) : 0;
      bt.core = hasCore ? bytesPerSecond * spanFrac(groupGpus, gSpine, Math.max(1, groupGpus - 1)) : 0;
    }
    add(group, bytesPerSecond, bt);
  };
  const addStage = (name: 'prefill' | 'decode', p: ReturnType<typeof inferenceParallelismFor>, tokensPerSecond: number, stageReplicas: number) => {
    const rate = tokensPerSecond / Math.max(1, stageReplicas);
    const lStage = L / p.pp;
    const tpBps = p.tp > 1 ? rate * lStage * 4 * h * B_ACT * ((p.tp - 1) / p.tp) : 0;
    const cpBps = p.cp > 1 ? rate * lStage * 2 * nKv * dHead * kvB * ((p.cp - 1) / p.cp) : 0;
    const ppBps = p.pp > 1 ? rate * h * B_ACT / p.tp * ((p.pp - 1) / p.pp) : 0;
    const epBps = moe && p.ep > 1 ? rate * (moeLayerCount(L, moe) / p.pp) * kTop * h * 3 * ((p.ep - 1) / p.ep) : 0;
    routeCollective('tp', tpBps, p);
    routeCollective('cp', cpBps, p);
    routeCollective('pp', ppBps, p);
    routeCollective('ep', epBps, p);
    if (p.tp > U) notes.push(`${name} TP${p.tp} exceeds the scale-up domain (${U}); its latency-sensitive all-reduce reaches the scale-out fabric.`);
  };

  const prompt = inferencePromptTokens(inf);
  const prefillTokensPerSec = inf.requestsPerSec * prompt.uncached;
  const decodeTokensPerSec = inf.requestsPerSec * inf.outputTokens;
  addStage('prefill', prefill, prefillTokensPerSec, prefillReplicas);
  addStage('decode', decode, decodeTokensPerSec, decodeReplicas);

  const kvSeq = kvSeqEffective(Math.max(1, inf.inputTokens), model.attentionWindow, model.globalLayerInterval);
  const kvLayerFraction = clamp(model.kvCacheLayerFraction ?? 1, 0, 1);
  const kvBytesPerToken = model.mla
    ? L * kvLayerFraction * (model.mla.dLatent + model.mla.dRope) * kvB
    : (2 * L * kvLayerFraction * nKv * dHead * kvB * kvSeq) / Math.max(1, inf.inputTokens);
  const kvTransferBps = inf.requestsPerSec * prompt.transfer * kvBytesPerToken;
  if (kvTransferBps > 0) {
    const prefillPoolGpus = prefillReplicas * prefillGpus;
    const decodePoolGpus = decodeReplicas * decodeGpus;
    const perEndpointBps = kvTransferBps / Math.max(1, Math.min(prefillPoolGpus, decodePoolGpus));
    const bt: Record<Tier, number> = { 'scale-up': 0, leaf: perEndpointBps, spine: 0, core: 0 };
    const endpointSpan = Math.max(prefillPoolGpus, decodePoolGpus);
    bt.spine = hasSpine ? perEndpointBps * clamp(1 - gLeaf / Math.max(gLeaf, endpointSpan), 0, 1) : 0;
    bt.core = hasCore ? perEndpointBps * clamp(1 - gSpine / Math.max(gSpine, endpointSpan), 0, 1) : 0;
    add('pd', perEndpointBps, bt);
  }

  for (const group of ['tp', 'cp', 'pp', 'ep', 'pd'] as ServingGroup[]) {
    const etaG = group === 'ep' ? etaA2a : eta;
    for (const tier of ['scale-up', 'leaf', 'spine', 'core'] as Tier[]) {
      const bytes = groupByTier[group][tier];
      tierBytes[tier] += bytes;
      const cap = tier === 'scale-up' ? suCap : nicCap;
      const factor = tier === 'spine' || tier === 'core' ? os / etaG : 1;
      tierUtil[tier] += bytes * factor / cap;
    }
  }
  const tiers: Tier[] = ['scale-up', 'leaf', ...(hasSpine ? (['spine'] as Tier[]) : []), ...(hasCore ? (['core'] as Tier[]) : [])];
  const perTier: TrafficReport['perTier'] = tiers.map((tier) => ({
    tier,
    bytesPerStepGB: tierBytes[tier] / GB,
    utilization: tierUtil[tier],
    utilizationAvg: tierUtil[tier],
    headroom: tierUtil[tier] > 0 ? 1 / tierUtil[tier] - 1 : Number.POSITIVE_INFINITY,
    capacityGBps: (tier === 'scale-up' ? suCap : nicCap) / GB,
  }));
  let minOs = MAX_OVERSUB;
  for (const tier of ['spine', 'core'] as Tier[]) {
    if (!tiers.includes(tier)) continue;
    const at1 = tierUtil[tier] / os;
    if (at1 > 0) minOs = Math.min(minOs, Math.floor((1 / at1) * 2) / 2);
  }
  minOs = fabric.kind === 'ddc' ? 1 : clamp(minOs, 1, MAX_OVERSUB);
  const worst = Math.max(...tiers.map((tier) => tierUtil[tier]), 0);
  const congestion = worst > 1 ? 1 / worst : 1;
  let idealS = 0;
  let actualS = 0;
  for (const group of ['tp', 'cp', 'pp', 'ep', 'pd'] as ServingGroup[]) {
    const leafBytes = groupByTier[group].leaf;
    if (leafBytes <= 0) continue;
    const ideal = leafBytes / nicCap;
    const crossesMultipath = groupByTier[group].spine > 0 || groupByTier[group].core > 0;
    idealS += ideal;
    actualS += ideal / (crossesMultipath ? (group === 'ep' ? etaA2a : eta) : 1);
  }
  const lbEff = idealS > 0 ? idealS / actualS : 1;
  const commEfficiencyEffective = clamp(lbEff * congestion * (fabric.speedFactor ?? 1) * (hasCore ? 0.98 : 1), 0.05, 1);
  const l2l3 = l2l3Verdict({ endpoints: allocatedGpus, switches: fabric.leaves, k: fabric.k, multiTenant: fabric.multiTenant, planes: fabric.planes });
  const iEpInDomain = inferenceExpertCollectiveGpus(decode) <= U;
  const a2aBw = iEpInDomain ? suCap : nicCap;
  const epDecodeTokPerSPerUser = moe && decode.ep > 1 ? a2aBw / (Math.max(1, moeLayerCount(L, moe)) * 2 * kTop * h * 3 * ((decode.ep - 1) / decode.ep)) : Number.POSITIVE_INFINITY;
  notes.unshift(
    `Inference demand window: ${inf.requestsPerSec} req/s × (${prompt.uncached} uncached prefill of ${inf.inputTokens} input + ${inf.outputTokens} decode tokens), spread across prefill DP${prefillReplicas}${inf.disaggregated ? ` and decode DP${decodeReplicas}` : ''} on ${allocatedGpus} layout GPUs.`,
    `Topology: prefill TP${prefill.tp}·PP${prefill.pp}·EP${prefill.ep}·CP${prefill.cp} (${prefillGpus} GPUs/instance); decode TP${decode.tp}·PP${decode.pp}·EP${decode.ep}·CP${decode.cp} (${decodeGpus} GPUs/instance).`,
    `The physical envelope comes from the GPU racks placed in Layout: scale-up domain ${U}, ${gpu.nicGbps} Gb/s scale-out per GPU, η_host ${nicBusbw.toFixed(3)}, η_fabric ${eta.toFixed(3)}.`,
  );
  if (kvTransferBps > 0) notes.push(`KV movement ${(kvTransferBps * 8 / GB).toFixed(1)} Gb/s aggregate (${prompt.remoteCached.toFixed(0)} remote-cache${inf.disaggregated ? ` + ${prompt.uncached.toFixed(0)} P/D` : ''} tokens/request); the tier load uses the busiest sharded endpoint.`);
  if (worst > 1) notes.push(`The requested inference rate exceeds the busiest tier by ×${worst.toFixed(2)}; latency SLOs require more replicas, more NIC bandwidth, or a topology change.`);

  return {
    mode: 'inference',
    basis: 'inference-second',
    perTier,
    bytesPerStepByGroup: { tp: groupBytes.tp / GB, cp: groupBytes.cp / GB, pp: groupBytes.pp / GB, dp: 0, ep: groupBytes.ep / GB, pd: groupBytes.pd / GB },
    minOversubscription: minOs,
    l2l3,
    commEfficiencyEffective,
    stepTimeS: 1,
    notes,
    eta: fabric.eta,
    etaHost: nicBusbw,
    ...(etaA2a !== eta ? { etaA2a } : {}),
    groupTier: { tp: groupRoute.tp, cp: groupRoute.cp, pp: groupRoute.pp, dp: '-', ep: groupRoute.ep, pd: groupRoute.pd },
    physical: physicalEnvelope(gpu, suCap, nicCap),
    inference: {
      kvBytesPerToken,
      kvTransferGbps: kvTransferBps * 8 / GB,
      remoteCacheTransferGbps: inf.requestsPerSec * prompt.remoteCached * kvBytesPerToken * 8 / GB,
      gpuCacheHitRate: prompt.input > 0 ? prompt.gpuCached / prompt.input : 0,
      remoteCacheHitRate: prompt.input > 0 ? prompt.remoteCached / prompt.input : 0,
      epDecodeTokPerSPerUser,
      attention: model.mla ? 'mla' : 'gqa',
      requestsPerSec: inf.requestsPerSec,
      prefillTokensPerSec,
      decodeTokensPerSec,
      allocatedGpus,
      replicas,
      prefillReplicas,
      decodeReplicas,
      disaggregated: inf.disaggregated,
      prefillParallelism: prefill,
      decodeParallelism: decode,
      prefillInstanceGpus: prefillGpus,
      decodeInstanceGpus: decodeGpus,
    },
  };
}

function workloadCalibrationMatches(w: WorkloadBlueprint): boolean {
  const calibration = w.calibration;
  if (w.inference) {
    return calibration?.mode === 'inference'
      && ((calibration.tokensPerSecPerGpu ?? 0) > 0 || (calibration.measuredTokensPerSec ?? 0) > 0);
  }
  return calibration?.mode === 'training'
    && ((calibration.tflopsPerGpu ?? 0) > 0 || (calibration.mfu ?? 0) > 0 || (calibration.measuredTokensPerSec ?? 0) > 0);
}

function trafficQuality(workloads: readonly WorkloadBlueprint[]): NonNullable<TrafficReport['quality']> {
  const calibratedWorkloads = workloads.filter(workloadCalibrationMatches).length;
  const offeredDemandWorkloads = workloads
    .filter((w) => w.inference && !workloadCalibrationMatches(w))
    .map((w) => w.id);
  const workloadCount = workloads.length;
  return {
    level: calibratedWorkloads === workloadCount && workloadCount > 0 ? 'calibrated' : calibratedWorkloads > 0 ? 'mixed' : 'estimate',
    workloadCount,
    calibratedWorkloads,
    offeredDemandWorkloads,
    assumptions: [
      'Training bursts are reconstructed from the modeled step time and peak/mean tier utilization.',
      'Inference stays flat at configured offered demand unless an arrival-rate trace is available.',
      'Rail and ECMP load are analytical balanced-flow estimates, not switch-port telemetry.',
    ],
  };
}

const tierRateKey: Record<Tier, keyof NetworkTrafficTimePoint> = {
  'scale-up': 'scaleUpGBps', leaf: 'leafGBps', spine: 'spineGBps', core: 'coreGBps',
};
const tierUtilKey: Record<Tier, keyof NetworkTrafficTimePoint> = {
  'scale-up': 'scaleUpUtilization', leaf: 'leafUtilization', spine: 'spineUtilization', core: 'coreUtilization',
};

/** Fraction of one display-second covered by a periodic burst. Sub-sampling avoids aliasing for sub-second steps. */
function burstFraction(second: number, periodS: number, duty: number): number {
  if (duty <= 0) return 0;
  if (duty >= 1) return 1;
  const period = Math.max(0.001, periodS);
  let active = 0;
  for (let i = 0; i < TRACE_SUBSAMPLES; i++) {
    const at = second + (i + 0.5) / TRACE_SUBSAMPLES;
    if ((at % period) / period < duty) active++;
  }
  return active / TRACE_SUBSAMPLES;
}

/** Representative trace. It is deliberately deterministic and never invents an inference arrival pattern. */
function trafficTrace(report: TrafficReport): NetworkTrafficTimePoint[] {
  const byTier = new Map(report.perTier.map((tier) => [tier.tier, tier]));
  return Array.from({ length: TRAFFIC_TRACE_SECONDS }, (_, t) => {
    const point: NetworkTrafficTimePoint = {
      t,
      scaleUpGBps: 0, leafGBps: 0, spineGBps: 0, coreGBps: 0,
      scaleUpUtilization: 0, leafUtilization: 0, spineUtilization: 0, coreUtilization: 0,
    };
    for (const tier of TIERS) {
      const value = byTier.get(tier);
      if (!value) continue;
      if (report.mode === 'training') {
        const peakUtil = Math.max(0, value.utilization);
        const meanUtil = Math.max(0, value.utilizationAvg ?? peakUtil);
        const duty = peakUtil > 0 ? clamp(meanUtil / peakUtil, 0, 1) : 0;
        const pulse = burstFraction(t, Math.max(0.001, report.stepTimeS), duty);
        const meanRate = value.bytesPerStepGB / Math.max(0.001, report.stepTimeS);
        point[tierRateKey[tier]] = duty > 0 ? (meanRate / duty) * pulse : 0;
        point[tierUtilKey[tier]] = peakUtil * pulse;
      } else {
        point[tierRateKey[tier]] = value.bytesPerStepGB;
        point[tierUtilKey[tier]] = value.utilization;
      }
    }
    return point;
  });
}

function finalizeSingleTraffic(report: TrafficReport, workload: WorkloadBlueprint, allocatedGpus: number): TrafficReport {
  report.scope = 'single';
  report.workloadIds = [workload.id];
  report.allocatedGpus = allocatedGpus;
  report.quality = trafficQuality([workload]);
  report.trafficTrace = trafficTrace(report);
  if (report.quality.offeredDemandWorkloads.length) {
    report.notes.push('Inference network values are a configured offered-demand envelope. They are not an achieved-throughput or latency-SLO prediction until a matching inference benchmark is attached.');
  }
  return report;
}

/** Build and run a selected inference scenario against the layout-derived GPU and fabric envelope. */
export function analyzeInferenceTraffic(input: TrafficInput): TrafficReport | undefined {
  const inf = input.workload.inference;
  if (!inf) return undefined;
  const prefill = inferenceParallelismFor(inf, 'prefill');
  const decode = inferenceParallelismFor(inf, 'decode');
  const unit = inf.disaggregated ? inferenceReplicaGpus(prefill) + inferenceReplicaGpus(decode) : inferenceReplicaGpus(prefill);
  const built = buildTrafficEnvelope(input, unit, 'bf16', 'Inference service');
  if (!built) return undefined;
  const report = computeInferenceTraffic({ model: input.workload.model, inference: inf, gpus: built.gpus, gpu: built.gpu, fabric: built.fabric });
  const etaInUse = etaFor(input.project.network.scaleOut);
  report.eta = { ...report.eta!, sourceType: etaInUse.sourceType, ...(etaInUse.url ? { url: etaInUse.url } : {}), ...(etaInUse.conditions ? { conditions: etaInUse.conditions } : {}), ...(etaInUse.nominalValue !== undefined ? { nominalValue: etaInUse.nominalValue } : {}), ...(etaInUse.measuredAt ? { measuredAt: etaInUse.measuredAt } : {}), hostSourceType: etaInUse.hostSourceType, hostCitation: etaInUse.hostCitation };
  report.notes.push(...built.notes);
  if (built.plan.kind === 'ddc' && built.plan.notes.length) report.notes.push(...built.plan.notes);
  if (input.network.notes.length) report.notes.push(...input.network.notes);
  report.workloadId = input.workload.id;
  return finalizeSingleTraffic(report, input.workload, report.inference?.allocatedGpus ?? built.gpus);
}

/** Build the traffic spec from the project / network result and run the model for a training blueprint. */
export function analyzeTraffic(input: TrafficInput): TrafficReport | undefined {
  if (input.workload.inference) return analyzeInferenceTraffic(input);
  const built = buildTrafficSpec(input);
  if (!built) return undefined;
  const { project, network, workload: w } = input;
  const plan = network.plans.find((p) => p.key === 'scale-out')!;
  const report = computeTraffic(built.spec);
  const eta = etaFor(project.network.scaleOut);
  // the full η provenance (source type, URL, conditions, nominal value, host factor) for the panel badge
  report.eta = { ...report.eta!, sourceType: eta.sourceType, ...(eta.url ? { url: eta.url } : {}), ...(eta.conditions ? { conditions: eta.conditions } : {}), ...(eta.nominalValue !== undefined ? { nominalValue: eta.nominalValue } : {}), ...(eta.measuredAt ? { measuredAt: eta.measuredAt } : {}), hostSourceType: eta.hostSourceType, hostCitation: eta.hostCitation };
  report.notes.push(...built.notes);
  if (plan.kind === 'ddc' && plan.notes.length) report.notes.push(...plan.notes);
  if (network.notes.length) report.notes.push(...network.notes);
  report.workloadId = w.id;
  return finalizeSingleTraffic(report, w, built.spec.gpus);
}

export interface AggregateTrafficInput {
  project: Project;
  workloads: WorkloadBlueprint[];
  ctx: Ctx;
  network: NetworkResult;
}

const routeRank = (route: string) => route === 'leaf+spine+core' ? 4 : route === 'leaf+spine' ? 3 : route === 'leaf' ? 2 : route === 'scale-up' ? 1 : 0;

/**
 * Combine every eligible workload as a concurrent facility demand. Workload shares are expected to be normalized with
 * `analysedBlueprint` before this function is called, so the aggregate does not silently allocate more GPUs than the layout.
 */
export function analyzeAggregateTraffic(input: AggregateTrafficInput): TrafficReport | undefined {
  const pairs = input.workloads
    .map((workload) => ({ workload, report: analyzeTraffic({ ...input, workload }) }))
    .filter((pair): pair is { workload: WorkloadBlueprint; report: TrafficReport } => !!pair.report);
  if (!pairs.length) return undefined;

  const totalGpus = pairs.reduce((sum, pair) => sum + Math.max(0, pair.report.allocatedGpus ?? 0), 0);
  if (!(totalGpus > 0)) return undefined;
  const presentTiers = TIERS.filter((tier) => pairs.some((pair) => pair.report.perTier.some((row) => row.tier === tier)));
  const aggregateTrace: NetworkTrafficTimePoint[] = Array.from({ length: TRAFFIC_TRACE_SECONDS }, (_, t) => {
    const point: NetworkTrafficTimePoint = {
      t,
      scaleUpGBps: 0, leafGBps: 0, spineGBps: 0, coreGBps: 0,
      scaleUpUtilization: 0, leafUtilization: 0, spineUtilization: 0, coreUtilization: 0,
    };
    for (const { report } of pairs) {
      const gpus = Math.max(0, report.allocatedGpus ?? 0);
      const sample = report.trafficTrace?.[t];
      if (!sample || gpus <= 0) continue;
      for (const tier of TIERS) {
        point[tierRateKey[tier]] += Number(sample[tierRateKey[tier]]) * gpus;
        point[tierUtilKey[tier]] += Number(sample[tierUtilKey[tier]]) * gpus / totalGpus;
      }
    }
    return point;
  });

  const perTier: TrafficReport['perTier'] = presentTiers.map((tier) => {
    const rates = aggregateTrace.map((point) => Number(point[tierRateKey[tier]]));
    const utilizations = aggregateTrace.map((point) => Number(point[tierUtilKey[tier]]));
    const meanRate = rates.reduce((sum, value) => sum + value, 0) / Math.max(1, rates.length);
    const utilization = Math.max(0, ...utilizations);
    const utilizationAvg = utilizations.reduce((sum, value) => sum + value, 0) / Math.max(1, utilizations.length);
    const capacityPerGpu = pairs.find((pair) => pair.report.perTier.some((row) => row.tier === tier))
      ?.report.perTier.find((row) => row.tier === tier)?.capacityGBps ?? 0;
    return {
      tier,
      bytesPerStepGB: meanRate,
      utilization,
      utilizationAvg,
      headroom: utilization > 0 ? 1 / utilization - 1 : Number.POSITIVE_INFINITY,
      capacityGBps: capacityPerGpu * totalGpus,
    };
  });

  const groupKeys = ['tp', 'cp', 'pp', 'dp', 'ep', 'pd'] as const;
  const groups = Object.fromEntries(groupKeys.map((group) => [group, pairs.reduce((sum, { report }) => {
    const perGpu = report.bytesPerStepByGroup[group] ?? 0;
    const rate = report.mode === 'training' ? perGpu / Math.max(0.001, report.stepTimeS) : perGpu;
    return sum + rate * Math.max(0, report.allocatedGpus ?? 0);
  }, 0)])) as TrafficReport['bytesPerStepByGroup'];

  const groupTier = Object.fromEntries(groupKeys.map((group) => {
    const routes = pairs.map(({ report }) => report.groupTier?.[group] ?? '-');
    return [group, routes.reduce((worst, route) => routeRank(route) > routeRank(worst) ? route : worst, '-')];
  })) as NonNullable<TrafficReport['groupTier']>;
  const weighted = (value: (report: TrafficReport) => number) => pairs.reduce((sum, { report }) => sum + value(report) * Math.max(0, report.allocatedGpus ?? 0), 0) / totalGpus;
  const l3 = pairs.find(({ report }) => report.l2l3.recommendation === 'l3');
  const quality = trafficQuality(pairs.map((pair) => pair.workload));
  quality.assumptions.unshift('All listed workloads are modeled as concurrent; no scheduler start offsets or measured arrival trace are available.');
  quality.assumptions.push('Workloads are assumed to be uniformly distributed across their allocated GPU endpoints; per-port hotspots require telemetry or an explicit placement map.');
  const detailedNotes = pairs.flatMap(({ workload, report }) => report.notes.map((note) => `[${workload.name}] ${note}`));

  return {
    mode: 'aggregate',
    basis: 'aggregate-second',
    scope: 'aggregate',
    workloadIds: pairs.map((pair) => pair.workload.id),
    allocatedGpus: totalGpus,
    perTier,
    bytesPerStepByGroup: groups,
    minOversubscription: Math.min(...pairs.map((pair) => pair.report.minOversubscription)),
    l2l3: l3?.report.l2l3 ?? pairs[0].report.l2l3,
    commEfficiencyEffective: weighted((report) => report.commEfficiencyEffective),
    stepTimeS: 1,
    notes: [
      `Concurrent aggregate of ${pairs.length} workloads on ${totalGpus} allocated GPUs. Training is converted from GB/step to GB/s and inference remains configured offered demand.`,
      ...quality.assumptions,
      ...(quality.offeredDemandWorkloads.length ? [`${quality.offeredDemandWorkloads.length} inference workload(s) have no matching throughput calibration; their contribution is demand, not verified achieved traffic.`] : []),
      ...detailedNotes,
    ],
    eta: pairs[0].report.eta,
    etaHost: weighted((report) => report.etaHost ?? 1),
    ...(pairs.some((pair) => pair.report.etaA2a !== undefined) ? { etaA2a: weighted((report) => report.etaA2a ?? report.eta?.value ?? 1) } : {}),
    groupTier,
    trafficTrace: aggregateTrace,
    quality,
    physical: pairs[0].report.physical,
  };
}

export interface EtaSensitivityPoint {
  eta: number;
  stepTimeS: number;
  exposedCommS: number;
}

/** Step time vs η_fabric for a spec (the alltoall η follows the same value) — pure, deterministic. */
export function etaSensitivity(spec: TrafficSpec, etas: readonly number[]): EtaSensitivityPoint[] {
  return etas.map((e) => {
    const r = computeTraffic({ ...spec, fabric: { ...spec.fabric, eta: { ...spec.fabric.eta, value: e }, etaA2a: undefined } });
    return { eta: e, stepTimeS: r.stepTimeS, exposedCommS: r.exposedCommS ?? 0 };
  });
}

export interface ProjectEtaSensitivity {
  points: EtaSensitivityPoint[];
  /** η in use and its step time (the chart marker) */
  current: { eta: number; stepTimeS: number };
  /** relative step-time change between η = 0.5 and η = 1.0 */
  spread: number;
  /** the same spread with every overlap fraction at 0 */
  spreadNoOverlap: number;
  /** spread < 1 % while it is ≥ 1 % without overlap — compute/communication overlap hides the fabric difference */
  hiddenByOverlap: boolean;
  /** false when η changes the step time by < 1 % even without overlap (the plan's traffic does not bind on the multipath tiers) */
  etaBinds: boolean;
}

/**
 * Step time vs η for the project's first training blueprint (η from `from` to 1.0). Train days scale with step time at constant
 * goodput: days(η) = days_current × step(η) ÷ step_current.
 */
export function projectEtaSensitivity(project: Project, opts: { from?: number; step?: number } = {}): ProjectEtaSensitivity | undefined {
  return withCatalog(resolveCatalog(project), () => {
    const training = project.workloads.find((w) => w.kind === 'llm-pretrain' || w.kind === 'llm-finetune');
    if (!training) return undefined;
    const ctx = buildContext(project);
    const network = analyzeNetworkCtx(ctx);
    const built = buildTrafficSpec({ project, workload: training, ctx, network });
    if (!built) return undefined;
    const from = opts.from ?? 0.5;
    const step = opts.step ?? 0.025;
    const etas: number[] = [];
    for (let e = from; e <= 1 + 1e-9; e += step) etas.push(Math.round(e * 1000) / 1000);
    const points = etaSensitivity(built.spec, etas);
    const cur = computeTraffic(built.spec);
    const lo = points[0]?.stepTimeS ?? 0;
    const hi = points[points.length - 1]?.stepTimeS ?? 0;
    const spread = hi > 0 ? (lo - hi) / hi : 0;
    const noOv = etaSensitivity({ ...built.spec, overlap: { tp: 0, cp: 0, pp: 0, dp: 0, ep: 0 } }, [etas[0], 1]);
    const spreadNoOverlap = noOv[1].stepTimeS > 0 ? (noOv[0].stepTimeS - noOv[1].stepTimeS) / noOv[1].stepTimeS : 0;
    return { points, current: { eta: built.spec.fabric.eta.value, stepTimeS: cur.stepTimeS }, spread, spreadNoOverlap, hiddenByOverlap: spread < 0.01 && spreadNoOverlap >= 0.01, etaBinds: spreadNoOverlap >= 0.01 };
  });
}
