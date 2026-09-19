// Training memory model (training track, 2026-09-19) — per-GPU HBM decomposition for one training step.
//
// Pure and dependency-light on purpose (imports only model types): engines/traffic.ts, engines/workload.ts, the topology
// sweep, the validator and the panel all read ONE definition, so they cannot disagree the way the old inline copy in
// validate.ts (activations excluded, dense weights ÷ EP, ZeRO default 0 vs 1) disagreed with the engine.
//
// Static state — ZeRO mixed-precision Adam, 16 bytes/param: 2 (bf16 weights) + 2 (bf16 grads) + 12 (fp32 master + m + v)
//   [Rajbhandari et al. 2020 §3]. Stage 1 shards the optimizer, 2 adds gradients, 3 adds parameters (FSDP FULL_SHARD ≡ 3).
//   Dense parameters live once per TP·PP shard and their state is sharded over the dp·cp peers (Megatron-Core passes the
//   dp_cp group to the dense optimizer); routed-expert parameters live once per TP·PP·EP shard and their state is sharded
//   over the expert-data-parallel peers dp·cp/ep (parallel_state.py expert_data_parallel_size = world / (etp·ep·pp)). Summed
//   over the cluster both buckets give exactly 16·P. FP8 / FP4 training keeps fp32 master weights, gradients and moments
//   (DeepSeek-V3 §3.3; NVFP4 pre-training), so precision never reduces these terms.
// Activations — bf16 saved tensors per token per layer with FlashAttention (the 5·a·s²·b attention-matrix term of
//   Korthikanti et al. 2022 eq. (1) is never materialised: FlashAttention stores O and the softmax logsumexp only), sequence
//   parallelism (÷ tp, eq. (4)) and context parallelism (÷ cp):
//     none      12h + 4·h_kv + 6·f  (QKV in, Q, K, V, O, two norms, gated FFN in + gate + up + act)
//     selective  8h + 2·h_kv + 2·f + 4·heads  (torchtitan op-SAC saved set: wq, wv, w1, w2 outputs, SDPA out, fp32 lse)
//     full       2h                 (layer inputs only — eq. (5)/§5 "2sbhL", ÷ tp when sequence-parallel)
//   MoE layers add the dispatch copies topK·4h per token (permuted input + output, replicated across TP) and the router
//   6·E, with f_eff = topK·expertFfn + shared·expertFfn; balanced routing leaves T·topK expert rows per rank, so EP cancels.
//   Pipeline: the first stage keeps m = min(pp, nMicro) micro-batches in flight (1F1B, Korthikanti §4.3), the last stage one
//   plus the logits tail (bf16 logits + fp32 cross-entropy copy ≈ 8·V per token); the estimate takes the heavier stage.
// The FLOOR is schedule-independent by construction: one sequence, one micro-batch, full recompute, ZeRO-3 — if that does
//   not fit, no schedule will, and the engine hard-stops. Above the floor the plan is simulated and flagged.
// What the resident terms cannot see — backend workspace, allocator fragmentation, Float8 casts — is expressed as a
//   RESERVE BAND derived from TorchTitan's measured peaks (arXiv 2410.06511, H100 95 GiB): the resident model explains
//   75–87 % of the peak on FSDP-only rows ('validated') and only 48–71 % once TP + full recompute or PP are involved
//   ('extrapolated'). `fits` therefore compares resident + computable transients against HBM × (1 − band_hi).

import type { WorkloadBlueprint } from '../model/types.ts';

export type TrainingRecompute = 'none' | 'selective' | 'full';
export type TrainingMemoryConfidence = 'validated' | 'extrapolated';

export interface TrainingMemoryProposal {
  change: 'zeroStage' | 'activationRecompute' | 'microBatchSeqs' | 'tp' | 'pp' | 'cp';
  /** partial training patch that realises the proposal */
  patch: Partial<NonNullable<WorkloadBlueprint['training']>>;
  totalGBPerGpu: number;
  fits: boolean;
  crossesScaleUp: boolean;
  noteEn: string;
}

export interface TrainingMemoryEstimate {
  topology: { tp: number; cp: number; pp: number; ep: number; dp: number; expertDp: number };
  allocatedGpus: number;
  gpuMemoryGB: number;
  /** fraction of physical HBM the model treats as usable = 1 − reserveBand[1] */
  hbmUtilization: number;
  usableHbmGB: number;
  zeroStage: 0 | 1 | 2 | 3;
  recompute: TrainingRecompute;
  microBatchSeqs: number;
  inflightMicroBatches: number;
  weightsGBPerGpu: number;
  gradientsGBPerGpu: number;
  optimizerGBPerGpu: number;
  activationsGBPerGpu: number;
  logitsGBPerGpu: number;
  /** computable transients: live-layer backward, TP gathered norms, unsharded grads under PP */
  transientGBPerGpu: number;
  totalGBPerGpu: number;
  /** schedule-independent floor: one sequence, one micro-batch, full recompute, ZeRO-3 */
  floorGBPerGpu: number;
  fits: boolean;
  floorFits: boolean;
  headroomGB: number;
  minimumTp?: number;
  crossesScaleUp: boolean;
  confidence: TrainingMemoryConfidence;
  /** fraction of HBM the resident model could NOT explain in TorchTitan for this confidence class */
  reserveBand: [number, number];
  proposals: TrainingMemoryProposal[];
  notesEn: string[];
}

/** ZeRO/FSDP stage assumed when the blueprint does not say — shared with engines/traffic.ts so the two never disagree again. */
export const TRAINING_ZERO_STAGE_DEFAULT: 0 | 1 | 2 | 3 = 1;
/** Unexplained-peak fraction from TorchTitan (arXiv 2410.06511, reserved_bytes peak, H100 95 GiB): [lo, hi] per confidence class. 'derived'. */
export const TRAINING_RESERVE_BAND: Record<TrainingMemoryConfidence, [number, number]> = { validated: [0.13, 0.25], extrapolated: [0.29, 0.52] };
export const TRAINING_MEMORY_SOURCES = {
  bytesPerParam: { value: '2 + 2 + 12', sourceType: 'public-spec' as const, citation: 'Rajbhandari et al., ZeRO (arXiv 1910.02054) §3: bf16 weights + bf16 gradients + fp32 master, momentum, variance = 16 bytes/param' },
  expertDataParallel: { value: 'dp·cp/ep', sourceType: 'public-spec' as const, citation: 'Megatron-Core parallel_state.py: expert_data_parallel_size = world_size // (expert_tensor_parallel_size · expert_model_parallel_size · pipeline_model_parallel_size), order tp-cp-ep-dp-pp' },
  activations: { value: '12h + 4h_kv + 6f per token-layer, ÷tp ÷cp', sourceType: 'public-spec' as const, citation: 'Korthikanti et al. 2022 (arXiv 2205.05198) eq. (1)/(4) re-summed for GQA + gated FFN without the 5as²b term; FlashAttention (arXiv 2205.14135) §3.1 stores O and logsumexp only' },
  fullRecompute: { value: '2h per token-layer', sourceType: 'public-spec' as const, citation: 'Korthikanti et al. 2022 §5 / eq. (5): full recomputation keeps the layer inputs, 2sbhL (÷t under sequence parallelism)' },
  reserveBand: { value: 'validated 0.13–0.25 · extrapolated 0.29–0.52 of HBM', sourceType: 'derived' as const, citation: 'TorchTitan (arXiv 2410.06511v3) Tables 1–4 measured peak GiB minus the resident terms of this model' },
} as const;

/** Extra training FLOPs from activation recompute: full re-runs every layer's forward (4/3, Megatron 8N form); torchtitan op-SAC
 *  saves every matmul output and recomputes only cheap element-wise ops (~5 %, estimate); none = 1. Shared by traffic.ts and the panel. */
export function trainingRecomputeFlopFactor(t: Pick<NonNullable<WorkloadBlueprint['training']>, 'activationRecompute' | 'activationRecomputeMode'> | undefined): number {
  if (!t?.activationRecompute) return 1;
  return (t.activationRecomputeMode ?? 'full') === 'full' ? 4 / 3 : 1.05;
}

const B_W = 2;
const B_G = 2;
const B_O = 12;
const GB = 1e9;

type Training = NonNullable<WorkloadBlueprint['training']>;
export interface TrainingTopologyDegrees { tp: number; cp: number; pp: number; ep: number }

const deg = (v: number | undefined, d = 1) => Math.max(1, Math.round(Number.isFinite(v) ? (v as number) : d));

/** MoE layers of a model (same rule as engines/traffic.ts moeLayerCount; duplicated here to keep this module free of engine imports). */
function moeLayersOf(layers: number, moe: NonNullable<WorkloadBlueprint['model']['moe']>): number {
  if (moe.denseLayers && moe.denseLayers > 0) return Math.max(0, layers - moe.denseLayers);
  if (moe.moeLayerInterval && moe.moeLayerInterval > 1) return Math.floor(layers / moe.moeLayerInterval);
  return layers;
}

/** Data-parallel replicas the allocated pool forms: floor(N / (tp·cp·pp)) — the single training group definition. */
export function trainingDataParallel(allocatedGpus: number, d: Pick<TrainingTopologyDegrees, 'tp' | 'cp' | 'pp'>): number {
  return Math.max(1, Math.floor(Math.max(0, allocatedGpus) / (deg(d.tp) * deg(d.cp) * deg(d.pp))));
}

/** Dense FFN width: the blueprint's `ffnHidden` (preset-plumbed), else back-solved from the parameter count (gated FFN, 3·h·f per layer). */
export function trainingFfnHidden(model: WorkloadBlueprint['model']): { f: number; derived: boolean } {
  if (model.ffnHidden && model.ffnHidden > 0) return { f: model.ffnHidden, derived: false };
  const h = Math.max(1, model.hiddenSize);
  const L = Math.max(1, model.layers);
  const V = model.vocab ?? 128256;
  const heads = Math.max(1, Math.round(model.numHeads ?? h / 128));
  const kvHeads = Math.max(1, Math.round(model.kvHeads ?? heads));
  const headDim = model.headDim && model.headDim > 0 ? model.headDim : h / heads;
  const hKv = kvHeads * headDim;
  const dense = model.moe ? Math.min(model.paramsB, model.activeParamsB) * 1e9 : model.paramsB * 1e9;
  const attn = L * (2 * h * h + 2 * h * hKv);
  const f = (dense - V * h - attn) / (3 * L * h);
  return { f: Math.min(8 * h, Math.max(h, Number.isFinite(f) ? f : 4 * h)), derived: true };
}

interface Terms { weights: number; gradients: number; optimizer: number; activations: number; logits: number; transient: number; total: number; inflight: number }

function terms(w: WorkloadBlueprint, d: TrainingTopologyDegrees, dp: number, z: 0 | 1 | 2 | 3, mode: TrainingRecompute, b: number, nMicroIn: number, schedule: 'interleaved' | '1f1b' | 'dualpipe', v: number): Terms {
  const m = w.model;
  const tp = deg(d.tp); const cp = deg(d.cp); const pp = deg(d.pp); const ep = deg(d.ep);
  const h = Math.max(1, m.hiddenSize);
  const L = Math.max(1, m.layers);
  const s = Math.max(1, m.seqLen);
  const V = m.vocab ?? 128256;
  const heads = Math.max(1, Math.round(m.numHeads ?? h / 128));
  const kvHeads = Math.max(1, Math.round(m.kvHeads ?? heads));
  const headDim = m.headDim && m.headDim > 0 ? m.headDim : h / heads;
  const hKv = kvHeads * headDim;
  const moe = m.moe;
  const E = moe?.experts ?? 0;
  const topK = moe ? Math.max(1, moe.topK) : 0;
  const shared = moe?.shared ?? 0;
  const { f } = trainingFfnHidden(m);
  const fE = moe?.expertFfn && moe.expertFfn > 0 ? moe.expertFfn : f;
  const moeLayers = moe ? moeLayersOf(L, moe) : 0;

  // ── parameters: dense vs routed experts ──
  const pTotal = m.paramsB * 1e9;
  const pExpert = moe ? (moe.expertFfn && moe.expertFfn > 0 ? Math.min(pTotal, moeLayers * E * 3 * h * fE) : Math.max(0, pTotal - Math.min(pTotal, m.activeParamsB * 1e9))) : 0;
  const pDense = pTotal - pExpert;

  // ── static state, sharded (dense over dp·cp, experts over dp·cp/ep) ──
  const dpc = Math.max(1, dp * cp);
  const dpe = Math.max(1, Math.floor(dpc / ep));
  const shard = (peers: number) => ({ w: B_W / (z >= 3 ? peers : 1), g: B_G / (z >= 2 ? peers : 1), o: B_O / (z >= 1 ? peers : 1) });
  const sd = shard(dpc);
  const se = shard(dpe);
  const denseShard = pDense / (tp * pp);
  const expertShard = pExpert / (tp * pp * ep);
  const weights = denseShard * sd.w + expertShard * se.w;
  const gradients = denseShard * sd.g + expertShard * se.g;
  const optimizer = denseShard * sd.o + expertShard * se.o;

  // ── activations per token per layer (bytes), already divided by tp (sequence parallel) and cp ──
  const tc = tp * cp;
  const densePerTok = mode === 'full' ? (2 * h) / tc : mode === 'selective' ? (8 * h + 2 * hKv + 2 * f + 4 * heads) / tc : (12 * h + 4 * hKv + 6 * f) / tc;
  const fEff = topK * fE + shared * fE;
  const moePerTok = mode === 'full' ? (2 * h) / tc : ((12 * h + 4 * hKv + 2 * h) + 6 * fEff + 6 * E) / tc + (topK * 4 * h) / cp;
  const stageLayers = Math.ceil(L / pp);
  const moeInStage = moe ? Math.min(stageLayers, Math.ceil((moeLayers * stageLayers) / L)) : 0;
  const denseInStage = stageLayers - moeInStage;
  const tokens = s * b;
  const layerBytes = tokens * (denseInStage * densePerTok + moeInStage * moePerTok);
  // live layer under recompute: the layer being recomputed holds its full saved set once
  const liveLayer = mode === 'full' ? tokens * Math.max(moe ? ((12 * h + 4 * hKv + 2 * h) + 6 * fEff + 6 * E) / tc + (topK * 4 * h) / cp : 0, (12 * h + 4 * hKv + 6 * f) / tc) : 0;
  const nMicro = Math.max(1, nMicroIn);
  const inflightFirst = Math.min(pp, nMicro) * (schedule === 'interleaved' && pp > 1 && v > 1 ? 1 + (pp - 1) / (pp * v) : 1);
  const embed = (2 * tokens * h) / tc;
  const logits = (8 * tokens * V) / tc;
  const first = inflightFirst * layerBytes + embed;
  const last = 1 * layerBytes + logits + embed;
  const activations = Math.max(first, last) - (first >= last ? 0 : logits); // keep logits separate in the report
  const logitsGB = first >= last ? 0 : logits;
  const inflight = first >= last ? inflightFirst : 1;
  // computable transients: live recompute layer backward, TP-gathered norm outputs, unsharded bf16 grads under PP + ZeRO-3
  const transient = liveLayer + (tp > 1 ? (4 * tokens * h * (1 - 1 / tp)) / cp : 0) + (pp > 1 && z >= 3 ? (2 * pDense) / (tp * pp) : 0);
  const total = weights + gradients + optimizer + activations + logitsGB + transient;
  return { weights, gradients, optimizer, activations, logits: logitsGB, transient, total, inflight };
}

const divisorsUpTo = (n: number, limit: number) => { const out: number[] = []; for (let i = 1; i <= Math.min(n, limit); i++) if (n % i === 0) out.push(i); return out; };

/**
 * Per-GPU training memory for a blueprint on an accelerator. `allocatedGpus` is the analysed allocation (floor(share·cluster));
 * DP is derived from it with the single group definition. Pure; never throws; undefined when the model has no training block
 * or the accelerator declares no HBM.
 */
export function trainingMemoryEstimate(
  w: WorkloadBlueprint,
  topology: TrainingTopologyDegrees,
  gpuMemoryGB: number,
  scaleUpDomain: number,
  allocatedGpus: number,
  opts: { schedule?: 'interleaved' | '1f1b' | 'dualpipe'; virtualStages?: number; noProposals?: boolean } = {},
): TrainingMemoryEstimate | undefined {
  const t = w.training;
  if (!t || !(gpuMemoryGB > 0)) return undefined;
  const d: TrainingTopologyDegrees = { tp: deg(topology.tp), cp: deg(topology.cp), pp: deg(topology.pp), ep: deg(topology.ep) };
  const dp = trainingDataParallel(allocatedGpus, d);
  const z = (t.zeroStage ?? TRAINING_ZERO_STAGE_DEFAULT) as 0 | 1 | 2 | 3;
  const mode: TrainingRecompute = t.activationRecompute ? (t.activationRecomputeMode ?? 'full') : 'none';
  const b = deg(t.microBatchSeqs, 1);
  const s = Math.max(1, w.model.seqLen);
  const nMicro = Math.max(1, Math.round((t.globalBatchTokensM * 1e6) / s / (dp * b)));
  const schedule = opts.schedule ?? 'interleaved';
  const v = opts.virtualStages ?? Math.min(8, Math.max(1, Math.floor(w.model.layers / d.pp)));
  const confidence: TrainingMemoryConfidence = d.tp * d.pp === 1 && mode !== 'full' ? 'validated' : 'extrapolated';
  const band = TRAINING_RESERVE_BAND[confidence];
  const usable = gpuMemoryGB * (1 - band[1]);
  const cur = terms(w, d, dp, z, mode, b, nMicro, schedule, v);
  // floor: ZeRO-3, one sequence, one micro-batch, full recompute — no dependence on batch or schedule
  const floor = terms(w, d, dp, 3, 'full', 1, 1, '1f1b', 1);
  const notesEn: string[] = [];
  const { derived } = trainingFfnHidden(w.model);
  if (derived) notesEn.push('FFN width back-solved from the parameter count (no ffnHidden on the blueprint).');
  if (w.model.moe && !(w.model.moe.expertFfn && w.model.moe.expertFfn > 0)) notesEn.push('Expert parameters estimated from active-parameter proxy (no expertFfn).');
  notesEn.push('Gated FFN and sequence parallelism assumed; FlashAttention assumed (no attention-matrix activations).');
  if (confidence === 'extrapolated') notesEn.push('TP·PP > 1 or full recompute: the resident model explained only 48–71 % of measured peaks in this class, so the usable HBM is discounted accordingly.');

  const est: TrainingMemoryEstimate = {
    topology: { ...d, dp, expertDp: Math.max(1, Math.floor((dp * d.cp) / d.ep)) },
    allocatedGpus,
    gpuMemoryGB,
    hbmUtilization: 1 - band[1],
    usableHbmGB: usable,
    zeroStage: z,
    recompute: mode,
    microBatchSeqs: b,
    inflightMicroBatches: cur.inflight,
    weightsGBPerGpu: cur.weights / GB,
    gradientsGBPerGpu: cur.gradients / GB,
    optimizerGBPerGpu: cur.optimizer / GB,
    activationsGBPerGpu: cur.activations / GB,
    logitsGBPerGpu: cur.logits / GB,
    transientGBPerGpu: cur.transient / GB,
    totalGBPerGpu: cur.total / GB,
    floorGBPerGpu: floor.total / GB,
    fits: cur.total / GB <= usable,
    floorFits: floor.total / GB <= usable,
    headroomGB: usable - cur.total / GB,
    crossesScaleUp: d.tp * d.cp > Math.max(1, scaleUpDomain),
    confidence,
    reserveBand: band,
    proposals: [],
    notesEn,
  };
  if (opts.noProposals || est.fits) return est;

  // proposals: memory-only knobs first, topology last; each re-evaluated through this same function
  const sub = (patch: Partial<Training>, topo: TrainingTopologyDegrees) => trainingMemoryEstimate({ ...w, training: { ...t, ...patch } }, topo, gpuMemoryGB, scaleUpDomain, allocatedGpus, { ...opts, noProposals: true })!;
  const push = (change: TrainingMemoryProposal['change'], patch: Partial<Training>, topo: TrainingTopologyDegrees, noteEn: string) => {
    const e = sub(patch, topo);
    est.proposals.push({ change, patch, totalGBPerGpu: e.totalGBPerGpu, fits: e.fits, crossesScaleUp: e.crossesScaleUp, noteEn });
  };
  if (z < 3 && dp * d.cp > 1) push('zeroStage', { zeroStage: 3 }, d, 'Shard parameters, gradients and optimizer over the data-parallel peers (ZeRO-3 / FSDP).');
  if (mode === 'none') push('activationRecompute', { activationRecompute: true, activationRecomputeMode: 'selective' }, d, 'Selective (op-level) recompute: keep matmul outputs, recompute the cheap ops (~5 % more FLOPs).');
  if (mode !== 'full') push('activationRecompute', { activationRecompute: true, activationRecomputeMode: 'full' }, d, 'Full recompute: keep layer inputs only (~33 % more FLOPs).');
  if (b > 1) push('microBatchSeqs', { microBatchSeqs: 1 }, d, 'One sequence per micro-batch.');
  const heads = Math.max(1, Math.round(w.model.numHeads ?? w.model.hiddenSize / 128));
  for (const tp of divisorsUpTo(heads, 8)) {
    if (tp <= d.tp) continue;
    const e = sub({ tp }, { ...d, tp });
    if (e.fits) { est.minimumTp = tp; est.proposals.push({ change: 'tp', patch: { tp }, totalGBPerGpu: e.totalGBPerGpu, fits: true, crossesScaleUp: e.crossesScaleUp, noteEn: `Smallest head-compatible TP that fits: ${tp}.` }); break; }
  }
  const nextPp = divisorsUpTo(Math.max(1, w.model.layers), 64).find((p) => p > d.pp);
  if (nextPp) push('pp', { pp: nextPp }, { ...d, pp: nextPp }, `Next pipeline depth that divides the layers: ${nextPp}.`);
  const nextCp = [2, 4, 8, 16].find((c) => c > d.cp && s % c === 0);
  if (nextCp) push('cp', { cp: nextCp }, { ...d, cp: nextCp }, `Next context-parallel degree: ${nextCp}.`);
  return est;
}

/** Memory-only knobs (ZeRO stage, recompute, micro-batch) that make the estimate fit, in proposal order — undefined when only a topology change can. */
export function trainingMemoryFitPatch(est: TrainingMemoryEstimate | undefined): Partial<Training> | undefined {
  if (!est || est.fits) return undefined;
  const p = est.proposals.find((x) => x.fits && (x.change === 'zeroStage' || x.change === 'activationRecompute' || x.change === 'microBatchSeqs'));
  return p?.patch;
}
