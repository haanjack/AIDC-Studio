import type { InferenceParallelism, WorkloadBlueprint } from '../model/types.ts';

export type InferenceStage = 'aggregated' | 'prefill' | 'decode';

export interface InferenceMemoryEstimate {
  stage: InferenceStage;
  topology: InferenceParallelism;
  /** Physical HBM declared by the selected accelerator platform. */
  gpuMemoryGB: number;
  /** Fraction of physical HBM made available to the model. */
  hbmUtilization: number;
  /** Usable HBM after the runtime reserve. */
  usableHbmGB: number;
  weightGBPerGpu: number;
  /** One sequence at the stage's configured maximum token residency. */
  kvGBPerGpu: number;
  totalGBPerGpu: number;
  fits: boolean;
  /** Smallest head-compatible TP that fits with the current PP/EP/CP. */
  minimumTp?: number;
  crossesScaleUp: boolean;
  weightPrecision: NonNullable<NonNullable<WorkloadBlueprint['inference']>['weightPrecision']>;
  kvPrecision: NonNullable<NonNullable<WorkloadBlueprint['inference']>['kvPrecision']>;
  tokenResidency: number;
}

const PRECISION_BYTES = { fp16: 2, bf16: 2, fp8: 1, fp4: 0.5 } as const;
const WEIGHT_RUNTIME_FACTOR = 1.2;
/** Conservative model-memory limit; the remainder covers backend workspace and fragmentation. */
export const INFERENCE_HBM_UTILIZATION = 0.9;

export const DEFAULT_INFERENCE_PARALLELISM: InferenceParallelism = { tp: 1, pp: 1, ep: 1, cp: 1, expertMapping: 'shared' };

/** Split the logical prompt from the portion that needs new prefill work. */
export function inferencePromptTokens(inference: NonNullable<WorkloadBlueprint['inference']>): {
  input: number;
  cached: number;
  gpuCached: number;
  remoteCached: number;
  uncached: number;
  transfer: number;
  hitRatio: number;
  mode: 'fixed-prefix' | 'trace';
} {
  const input = Math.max(0, inference.inputTokens);
  const trace = inference.prefixCacheTrace;
  if (trace) {
    const rate = (v: number | undefined) => Math.min(1, Math.max(0, Number.isFinite(v) ? v! : 0));
    const gpuHit = rate(trace.gpuHitRate);
    // AgentX backends can report CPU and external counters for the same host-side reuse path.
    // Treat the larger counter as the remote tier instead of double-counting both.
    const remoteHit = Math.min(1 - gpuHit, Math.max(rate(trace.cpuHitRate), rate(trace.externalHitRate)));
    const gpuCached = input * gpuHit;
    const remoteCached = input * remoteHit;
    const cached = gpuCached + remoteCached;
    const uncached = Math.max(0, input - cached);
    return {
      input,
      cached,
      gpuCached,
      remoteCached,
      uncached,
      transfer: remoteCached + (inference.disaggregated ? uncached : 0),
      hitRatio: input > 0 ? cached / input : 0,
      mode: 'trace',
    };
  }
  const cached = Math.min(input, Math.max(0, inference.cachedPrefixTokens ?? 0));
  const uncached = input - cached;
  return {
    input,
    cached,
    gpuCached: cached,
    remoteCached: 0,
    uncached,
    transfer: inference.disaggregated ? uncached : 0,
    hitRatio: input > 0 ? cached / input : 0,
    mode: 'fixed-prefix',
  };
}

/** Clamp user/imported values to a valid, deterministic integer topology. */
export function normalizeInferenceParallelism(value?: Partial<InferenceParallelism>, fallback: InferenceParallelism = DEFAULT_INFERENCE_PARALLELISM): InferenceParallelism {
  const degree = (v: number | undefined, d: number) => Math.max(1, Math.round(Number.isFinite(v) ? v! : d));
  const dp = value?.dp ?? fallback.dp;
  return {
    tp: degree(value?.tp, fallback.tp),
    pp: degree(value?.pp, fallback.pp),
    ep: degree(value?.ep, fallback.ep),
    cp: degree(value?.cp, fallback.cp),
    expertMapping: value?.expertMapping === 'orthogonal' || value?.expertMapping === 'shared'
      ? value.expertMapping
      : fallback.expertMapping ?? 'shared',
    ...(dp !== undefined ? { dp: degree(dp, 1) } : {}),
  };
}

/** Stable binding for an inference calibration. RPS and DP are excluded: they change replica count, not one-replica performance. */
export function inferenceCalibrationSignature(w: WorkloadBlueprint): string | undefined {
  const inf = w.inference;
  if (!inf) return undefined;
  const topology = (stage: InferenceStage) => {
    const p = inferenceParallelismFor(inf, stage);
    return `${p.tp}/${p.pp}/${p.ep}/${p.cp}/${p.expertMapping}`;
  };
  return [
    w.presetId ?? w.model.name, w.model.paramsB, w.model.activeParamsB, w.model.layers, w.model.hiddenSize,
    inf.disaggregated ? 'pd' : 'aggregated', inf.weightPrecision ?? 'fp8', inf.kvPrecision ?? 'fp8',
    inf.inputTokens, inf.outputTokens, inf.ttftSloMs, inf.tpotSloMs,
    inf.disaggregated ? topology('prefill') : topology('aggregated'), inf.disaggregated ? topology('decode') : '',
  ].join('|');
}

/** Effective topology for a serving stage. Stage overrides inherit the common topology. */
export function inferenceParallelismFor(
  inference: NonNullable<WorkloadBlueprint['inference']>,
  stage: InferenceStage,
  fallback: InferenceParallelism = DEFAULT_INFERENCE_PARALLELISM,
): InferenceParallelism {
  const common = normalizeInferenceParallelism(inference.parallelism, fallback);
  if (!inference.disaggregated || stage === 'aggregated') return common;
  return normalizeInferenceParallelism(stage === 'prefill' ? inference.prefillParallelism : inference.decodeParallelism, common);
}

/** Physical GPUs in the TP/EP worker group before PP/CP replication. */
export function inferenceModelParallelGroupGpus(p: InferenceParallelism): number {
  const n = normalizeInferenceParallelism(p);
  return n.expertMapping === 'orthogonal' ? n.tp * n.ep : Math.max(n.tp, n.ep);
}

/** GPUs participating in one EP collective. */
export function inferenceExpertCollectiveGpus(p: InferenceParallelism): number {
  const n = normalizeInferenceParallelism(p);
  return n.expertMapping === 'orthogonal' ? n.tp * n.ep : n.ep;
}

/** Physical GPUs in one replica. DP is represented by multiple replicas, not by this product. */
export function inferenceReplicaGpus(p: InferenceParallelism): number {
  const n = normalizeInferenceParallelism(p);
  return inferenceModelParallelGroupGpus(n) * n.pp * n.cp;
}

/** Smallest schedulable serving unit: one replica, or one prefill plus one decode replica for P/D disaggregation. */
export function inferenceDeploymentGpus(w: WorkloadBlueprint): number {
  const inf = w.inference;
  if (!inf) return 1;
  if (!inf.disaggregated) return inferenceReplicaGpus(inferenceParallelismFor(inf, 'aggregated'));
  return inferenceReplicaGpus(inferenceParallelismFor(inf, 'prefill')) + inferenceReplicaGpus(inferenceParallelismFor(inf, 'decode'));
}

function effectiveKvTokens(seq: number, window?: number, globalInterval?: number): number {
  if (!window || window <= 0 || window >= seq) return seq;
  const globalFraction = globalInterval && globalInterval > 0 ? 1 / globalInterval : 0;
  return globalFraction * seq + (1 - globalFraction) * window;
}

function memoryAtTp(w: WorkloadBlueprint, stage: InferenceStage, topology: InferenceParallelism, tp: number) {
  const inf = w.inference!;
  const p = { ...normalizeInferenceParallelism(topology), tp };
  const weightPrecision = inf.weightPrecision ?? 'fp8';
  const kvPrecision = inf.kvPrecision ?? 'fp8';
  const weightBytes = PRECISION_BYTES[weightPrecision];
  const kvBytes = PRECISION_BYTES[kvPrecision];
  const totalWeightsGB = w.model.paramsB * weightBytes;
  // activeParams is the best available neutral proxy for shared/dense parameters; remaining MoE weights are EP-sharded.
  const sharedWeightsGB = Math.min(totalWeightsGB, w.model.activeParamsB * weightBytes);
  const expertWeightsGB = Math.max(0, totalWeightsGB - sharedWeightsGB);
  const modelShard = Math.max(1, p.tp * p.pp);
  // The worker group collectively owns one copy of the expert weights. In shared mode TP/EP are two collective
  // views of the same max(TP, EP) workers; in orthogonal mode they form a TP × EP grid.
  const expertShard = w.model.moe ? Math.max(1, inferenceModelParallelGroupGpus(p) * p.pp) : modelShard;
  const weightGBPerGpu = WEIGHT_RUNTIME_FACTOR * (sharedWeightsGB / modelShard + expertWeightsGB / expertShard);

  const heads = Math.max(1, Math.round(w.model.numHeads ?? w.model.hiddenSize / 128));
  const kvHeads = Math.max(1, Math.round(w.model.kvHeads ?? heads));
  const headDim = w.model.headDim && w.model.headDim > 0 ? w.model.headDim : w.model.hiddenSize / heads;
  const kvLayerFraction = Math.min(1, Math.max(0, w.model.kvCacheLayerFraction ?? 1));
  const tokenResidencyRaw = stage === 'prefill' ? inf.inputTokens : inf.inputTokens + inf.outputTokens;
  const tokenResidency = w.model.mla
    ? tokenResidencyRaw
    : effectiveKvTokens(tokenResidencyRaw, w.model.attentionWindow, w.model.globalLayerInterval);
  const kvPerTokenGB = w.model.mla
    ? (w.model.layers * kvLayerFraction * (w.model.mla.dLatent + w.model.mla.dRope) * kvBytes) / 1e9
    : (2 * w.model.layers * kvLayerFraction * kvHeads * headDim * kvBytes) / 1e9;
  // PP owns a layer subset, CP owns a sequence subset, and TP can shard at most the available KV heads/latent state.
  const kvTp = w.model.mla ? p.tp : Math.max(1, Math.min(p.tp, kvHeads));
  const kvGBPerGpu = (kvPerTokenGB * tokenResidency) / Math.max(1, p.pp * p.cp * kvTp);
  const totalGBPerGpu = weightGBPerGpu + kvGBPerGpu;
  return { weightGBPerGpu, kvGBPerGpu, totalGBPerGpu, tokenResidency };
}

/**
 * Memory-first TP sizing. It finds the minimum head-compatible TP that fits one resident sequence while preserving the
 * user's PP/EP/CP. RPS changes replica count, not this minimum model-parallel shard count.
 */
export function inferenceMemoryEstimate(
  w: WorkloadBlueprint,
  stage: InferenceStage,
  topology: InferenceParallelism,
  gpuMemoryGB: number,
  scaleUpDomain: number,
): InferenceMemoryEstimate | undefined {
  const inf = w.inference;
  if (!inf || !(gpuMemoryGB > 0)) return undefined;
  const p = normalizeInferenceParallelism(topology);
  const usableHbmGB = gpuMemoryGB * INFERENCE_HBM_UTILIZATION;
  const current = memoryAtTp(w, stage, p, p.tp);
  const heads = Math.max(1, Math.round(w.model.numHeads ?? w.model.hiddenSize / 128));
  const candidates: number[] = [];
  // Memory fit is a feasibility floor, so consider every legal head divisor. Hardware-friendly powers of two remain a
  // performance choice above this floor rather than being silently imposed by the capacity model.
  for (let tp = 1; tp <= heads; tp++) if (heads % tp === 0) candidates.push(tp);
  if (!candidates.includes(p.tp) && heads % p.tp === 0) candidates.push(p.tp);
  candidates.sort((a, b) => a - b);
  const minimumTp = candidates.find((tp) => memoryAtTp(w, stage, p, tp).totalGBPerGpu <= usableHbmGB);
  return {
    stage,
    topology: p,
    gpuMemoryGB,
    hbmUtilization: INFERENCE_HBM_UTILIZATION,
    usableHbmGB,
    ...current,
    fits: current.totalGBPerGpu <= usableHbmGB,
    minimumTp,
    crossesScaleUp: minimumTp !== undefined && inferenceReplicaGpus({ ...p, tp: minimumTp }) > Math.max(1, scaleUpDomain),
    weightPrecision: inf.weightPrecision ?? 'fp8',
    kvPrecision: inf.kvPrecision ?? 'fp8',
  };
}
