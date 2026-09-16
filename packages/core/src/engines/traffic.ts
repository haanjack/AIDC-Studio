import { resolveCatalog, withCatalog } from '../catalog/registry.ts';
import type { EvidenceSourceType, LoadBalancing, Project, SpecSource, TrafficReport, WorkloadBlueprint } from '../model/types.ts';
import { buildContext, clamp, type Ctx } from './context.ts';
import { ETA_HOST_SOURCE } from './eta.ts';
import { analyzeNetworkCtx, etaFor, type NetworkResult } from './network.ts';
import { l2l3Verdict } from './radix.ts';

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

export type Group = 'tp' | 'cp' | 'pp' | 'dp' | 'ep';
type Tier = 'scale-up' | 'leaf' | 'spine' | 'core';

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

interface GroupBytes {
  total: number;
  byTier: Record<Tier, number>;
  /** bandwidth-model time (s) before overlap (scale-up + NIC) */
  timeS: number;
  /** scale-out (NIC) part of timeS */
  nicS: number;
  exposedS: number;
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
  const recompute = !!t.activationRecompute;
  const flopsPerToken = recompute ? 8 * nActive + 16 * L * h * s : 6 * nActive + 12 * L * h * s;
  const flopsStep = tokensStep * flopsPerToken;
  const mfuDef = MFU_DEFAULT[t.precision] ?? MFU_DEFAULT.bf16;
  const mfu = t.mfuAssumed && t.mfuAssumed > 0 ? clamp(t.mfuAssumed, 0.05, 1) : mfuDef.value;
  const tComp = flopsStep / (gpus * gpu.peakFlops * mfu);
  const bubble = pp > 1 ? (pp - 1) / m : 0;

  // ── bytes per GPU per step ──
  const tpBytes = tp > 1 ? m * lStage * 8 * b * s * h * ((tp - 1) / tp) * B_ACT : 0;
  // long-context KV (r2-models.md §2): sliding-window layers hold at most `attentionWindow` tokens of KV; one layer in
  // `globalLayerInterval` attends globally (Gemma 3 5 local : 1 global → 6, gpt-oss alternating → 2). No window → every layer global.
  const kvSeq = kvSeqEffective(s, model.attentionWindow, model.globalLayerInterval);
  const cpBytes = cp > 1 ? 3 * m * lStage * 2 * b * kvSeq * nKv * dHead * B_ACT * ((cp - 1) / cp) : 0;
  const ppBytes = pp > 1 ? (2 * m * b * s * h * B_ACT) / tp : 0;
  const psi = nTotal / (tp * pp * (model.moe ? ep : 1));
  const stage = t.zeroStage ?? 1;
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
  const windowOf = (g: Group) => (g === 'dp' ? (recompute ? 0.75 : 2 / 3) * tComp : tComp);

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
    const windowS = windowOf(g);
    const exposedS = Math.max(0, nicS - Math.min(f * nicS, windowS));
    const crossesMultipath = (hasSpine && byTier.spine > 0) || (hasCore && byTier.core > 0);
    const gb: GroupBytes = { total, byTier, timeS: suS + nicS, nicS, exposedS, crossesMultipath, tier, f, windowS };
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

  // ── step time, MFU ──
  const G = Object.keys(groups) as Group[];
  const exposed = G.reduce((sum, g) => sum + groups[g].exposedS, 0);
  const commTime = G.reduce((sum, g) => sum + groups[g].timeS, 0);
  const nicCommTime = G.reduce((sum, g) => sum + groups[g].nicS, 0);
  const stepTime = tComp + exposed;
  const mfuEff = flopsStep / (gpus * gpu.peakFlops * stepTime);

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
    const im = spec.inference.model;
    const bKv = PRECISION_BYTES[inf.kvPrecision ?? 'fp8'] ?? 1;
    const iL = Math.max(1, im.layers);
    const iH = Math.max(1, im.hiddenSize);
    const iHeads = Math.max(1, Math.round(im.numHeads ?? iH / 128));
    const iKv = Math.max(1, Math.round(im.kvHeads ?? iHeads));
    const iHeadDim = im.headDim && im.headDim > 0 ? im.headDim : iH / iHeads;
    const mla = im.mla;
    // KV bytes/token: GQA/MHA 2·L·n_kv·d_head·B_kv; MLA L·(d_c + d_rope)·B_kv (DeepSeek-V2 §2.1; anchors: V3 70.3 KB, Llama 3.1 405B 516 KB at 2 B)
    // sliding-window layers cap the prompt's KV at the window (averaged per prompt token; MLA models have no window)
    const iKvSeq = kvSeqEffective(Math.max(1, inf.inputTokens), im.attentionWindow, im.globalLayerInterval);
    const kvBytesPerToken = mla ? iL * (mla.dLatent + mla.dRope) * bKv : (2 * iL * iKv * iHeadDim * bKv * iKvSeq) / Math.max(1, inf.inputTokens);
    // DistServe §3.3: R_KV = rps × prompt tokens × KV bytes/token
    const kvTransferGbps = (inf.requestsPerSec * inf.inputTokens * kvBytesPerToken * 8) / GB;
    // DeepSeek insights §2.3.2: (1 B + 2 B) × 32 tokens × k experts × h per layer, dispatch + combine, over the interconnect
    const iMoe = im.moe;
    const iTop = iMoe ? Math.max(1, iMoe.topK) : 0;
    const iEpInDomain = !iMoe || iMoe.experts <= U * 4; // ≈ 4 experts per GPU fit the scale-up domain (NVL72 holds 256 routed experts)
    const a2aBw = iEpInDomain ? suCap : nicCap;
    const epDecodeTokPerSPerUser = iMoe ? a2aBw / (Math.max(1, moeLayerCount(iL, iMoe)) * 2 * iTop * iH * 3) : Number.POSITIVE_INFINITY;
    inference = { kvBytesPerToken, kvTransferGbps, epDecodeTokPerSPerUser, attention: mla ? 'mla' : 'gqa' };
    notes.push(`Inference (${im.name}): KV ${(kvBytesPerToken / 1024).toFixed(1)} KB/token (${mla ? 'MLA' : `GQA, d_head ${iHeadDim}${im.attentionWindow ? `, window ${im.attentionWindow} with 1 global layer in ${im.globalLayerInterval ?? '∞'}` : ''}`}, ${inf.kvPrecision ?? 'fp8'}); P/D KV transfer ${kvTransferGbps.toFixed(1)} Gb/s aggregate at ${inf.requestsPerSec} req/s × ${inf.inputTokens} prompt tokens${iMoe ? `; EP all-to-all decode ceiling ≈ ${epDecodeTokPerSPerUser.toFixed(0)} tok/s/user on ${iEpInDomain ? 'the scale-up domain' : 'the NIC'} (DeepSeek: 67 tok/s on 400G IB vs ≈1,200 on NVL72)` : ''}.`);
  }

  // ── notes ──
  const overlapTxt = G.filter((g) => groups[g].nicS > 0).map((g) => `${g.toUpperCase()} f ${groups[g].f.toFixed(3)} (${spec.overlap?.[g] != null ? 'user' : odef[g].sourceType})`).join(' · ');
  notes.unshift(
    `Compute ${recompute ? '8·N_active + 16·L·h·s (activation recompute, Megatron 96-form)' : '6·N_active + 12·L·h·s (PaLM App. B)'} = ${(flopsStep / 1e18).toFixed(2)} EFLOP/step; MFU ${(mfu * 100).toFixed(0)} % (${t.mfuAssumed ? 'user' : `${mfuDef.source}: ${mfuDef.citation}`}) → T_comp ${tComp.toFixed(2)} s (end-to-end MFU anchor: scale-up collectives are inside it).`,
    `Parallelism TP${tp}·CP${cp}·PP${pp} = ${tpp} GPUs per replica, DP ${dp}${moe ? `, EP ${ep}` : ''}; micro-batches ${m} × ${b} seq; pipeline bubble (p−1)/m = ${(bubble * 100).toFixed(0)} % (inside the assumed MFU).`,
    `Group placement — TP: ${groups.tp.tier}, CP: ${groups.cp.tier}, PP: ${groups.pp.tier}, DP: ${groups.dp.tier} (members per NVLink domain ${mU}, per pod ${mL}, per spine domain ${mS})${moe ? `, EP: ${groups.ep.tier}` : ''}.`,
    `η_fabric = ${eta} on spine/core tiers (${fabric.eta.class}; ${fabric.eta.citation})${etaA2a !== eta ? `; η_A2A = ${etaA2a.toFixed(3)} for expert all-to-all (measured alltoall)` : ''}; η_host (NIC busbw) = ${nicBusbw}.${fabric.sharp ? ' SHARP in-network reduction halves DP bytes on the NIC tiers (IB).' : ''}`,
    `Overlap: exposed = T_nic − min(f·T_nic, W), framework mode ${mode}${overlapTxt ? ` — ${overlapTxt}` : ''}.`,
  );
  if (exposed > 0) notes.push(`Exposed communication ${exposed.toFixed(3)} s of ${stepTime.toFixed(2)} s per step (${((exposed / stepTime) * 100).toFixed(2)} %) — scale-out collective time before overlap ${nicCommTime.toFixed(3)} s.`);
  if (worst > 1) notes.push(`Tier over capacity in its burst window (×${worst.toFixed(2)}) — collectives are throttled; effective efficiency ×${congestion.toFixed(2)}.`);

  const overlap = Object.fromEntries(
    G.map((g) => [g, { f: groups[g].f, windowS: groups[g].windowS, nicCommS: groups[g].nicS, exposedS: groups[g].exposedS, sourceType: spec.overlap?.[g] != null ? 'user' : odef[g].sourceType, citation: spec.overlap?.[g] != null ? 'User-entered overlap fraction' : odef[g].citation, ...(odef[g].url ? { url: odef[g].url } : {}), ...(odef[g].measureIt ? { measureIt: true } : {}) }]),
  ) as NonNullable<TrafficReport['overlap']>;

  return {
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
    commTimeS: commTime,
    nicCommTimeS: nicCommTime,
    mfuEffective: mfuEff,
    groupTier: { tp: groups.tp.tier, cp: groups.cp.tier, pp: groups.pp.tier, dp: groups.dp.tier, ep: groups.ep.tier },
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
  const c = ctx.gpuRack?.compute;
  const t = w.training;
  if (!c || !t || ctx.gpus <= 0) return undefined;
  const plan = network.plans.find((p) => p.key === 'scale-out');
  if (!plan || plan.links <= 0) return undefined;
  const so = project.network.scaleOut;
  const tpp = Math.max(1, t.tp * Math.max(1, t.cp ?? 1) * t.pp);
  // a job never spans clusters: the GPU share is taken from the cluster that carries the primary scale-out plan
  const clusterGpus = plan.clusterGpus ?? ctx.gpus;
  const gpus = Math.floor((clamp(w.gpuShare, 0, 1) * clusterGpus) / tpp) * tpp;
  if (gpus < tpp) return undefined;
  const notes: string[] = [];
  if (plan.clusterGpus !== undefined && plan.clusterGpus < ctx.gpus) notes.push(`Training job sized inside cluster '${plan.clusterName ?? plan.clusterId}' (${plan.clusterGpus} of ${ctx.gpus} GPUs) — collectives never cross clusters.`);
  const portsPerGpu = Math.max(1, c.scaleOutPortsPerGpu);
  const lanes = Math.max(1, Math.round(c.scaleOutPortGbps / (plan.sw.switch?.portGbps ?? c.scaleOutPortGbps)));
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
    gpu: {
      peakFlops: peakFlopsFor(c, t.precision),
      scaleUpDomain: c.scaleUp.domainSize,
      scaleUpGBpsPerDir: c.scaleUp.gbpsPerGpu / 8 / 2,
      nicGbps,
      nicBusbw: eta.host,
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
    ...(Object.keys(overlap).length ? { overlap } : {}),
    ...(ov?.framework ? { overlapFramework: ov.framework } : {}),
  };
  return { spec, notes };
}

/** Build the traffic spec from the project / network result and run the model for a training blueprint. */
export function analyzeTraffic(input: TrafficInput): TrafficReport | undefined {
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
  return report;
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
