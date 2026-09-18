import type { InferenceParallelism, Project, WorkloadAnalysis, WorkloadBlueprint } from '../model/types.ts';
import { inferenceMemoryEstimate, inferenceParallelismFor, inferenceReplicaGpus, normalizeInferenceParallelism } from '../workload/inference.ts';
import { predictInferenceXRegression, type InferenceXRegressionModel, type InferenceXRegressionPrediction } from '../workload/inferencexRegression.ts';
import { analyzeCoolingCtx } from './cooling.ts';
import { buildContext } from './context.ts';
import { analyzeNetworkCtx } from './network.ts';
import { analyzePowerCtx } from './power.ts';
import { analyzeTraffic } from './traffic.ts';
import { simulateInference, workloadEnv } from './workload.ts';

export interface InferenceWorkloadParetoPoint {
  id: string;
  servingMode: 'aggregated' | 'disaggregated';
  interactivityTokPerSecPerUser: number;
  outputCapacityTokensPerSec: number;
  lowerOutputCapacityTokensPerSec: number;
  upperOutputCapacityTokensPerSec: number;
  analyticalOutputCapacityTokensPerSec: number;
  maxRequestsPerSec: number;
  ttftMs: number;
  tpotMs: number;
  meetsCurrentSlo: boolean;
  selectedTopology: boolean;
  calibrated: boolean;
  regression?: InferenceXRegressionPrediction;
  networkLimited: boolean;
  usedGpus: number;
  allocatedGpus: number;
  prefillReplicas: number;
  decodeReplicas: number;
  prefill: InferenceParallelism;
  decode: InferenceParallelism;
}

export interface InferenceWorkloadParetoSeries {
  servingMode: 'aggregated' | 'disaggregated';
  evaluated: number;
  feasible: number;
  points: InferenceWorkloadParetoPoint[];
  frontier: InferenceWorkloadParetoPoint[];
}

export interface InferenceWorkloadParetoReport {
  workloadId: string;
  workloadName: string;
  accelerator: string;
  allocatedGpus: number;
  targetInteractivityTokPerSecPerUser: number;
  targetTtftMs: number;
  targetTpotMs: number;
  series: InferenceWorkloadParetoSeries[];
  evaluated: number;
  feasible: number;
  regression?: {
    conditions: number;
    runs: number;
    variantConditions: number;
    additionalVariants: number;
    implementationMedianError?: number;
    implementationP90Error?: number;
    models: number;
    hardware: number;
    modelHoldoutMedianError?: number;
    modelHoldoutP90Error?: number;
    hardwareHoldoutMedianError?: number;
    hardwareHoldoutP90Error?: number;
  };
}

const powers = (limit: number, configured: number) => [...new Set([1, 2, 4, 8, 16, 32, configured]
  .map((value) => Math.max(1, Math.round(value)))
  .filter((value) => value <= Math.max(1, limit)))]
  .sort((a, b) => a - b);

const topologyKey = (p: InferenceParallelism) => `${p.tp}/${p.pp}/${p.ep}/${p.cp}/${p.expertMapping ?? 'shared'}`;

function topologyCandidates(
  workload: WorkloadBlueprint,
  stage: 'aggregated' | 'prefill' | 'decode',
  base: InferenceParallelism,
  allocatedGpus: number,
  gpuMemoryGB: number,
  scaleUpDomain: number,
): InferenceParallelism[] {
  const normalized = normalizeInferenceParallelism({ ...base, dp: undefined });
  const heads = Math.max(1, Math.round(workload.model.numHeads ?? workload.model.hiddenSize / 128));
  const tpValues = powers(Math.min(32, allocatedGpus, heads), normalized.tp).filter((tp) => heads % tp === 0 || tp === normalized.tp);
  const epLimit = workload.model.moe ? Math.min(32, allocatedGpus, workload.model.moe.experts) : 1;
  const epValues = powers(epLimit, normalized.ep);
  const ppValues = powers(Math.min(8, allocatedGpus, workload.model.layers), normalized.pp).filter((pp) => workload.model.layers % pp === 0 || pp === normalized.pp);
  const cpValues = powers(Math.min(8, allocatedGpus), normalized.cp);
  const candidates = new Map<string, InferenceParallelism>();
  const add = (partial: Partial<InferenceParallelism>) => {
    const candidate = normalizeInferenceParallelism({ ...normalized, ...partial, dp: undefined });
    delete candidate.dp;
    if (inferenceReplicaGpus(candidate) > allocatedGpus) return;
    const memory = inferenceMemoryEstimate(workload, stage, candidate, gpuMemoryGB, scaleUpDomain);
    if (!memory?.fits) return;
    candidates.set(topologyKey(candidate), candidate);
  };

  add(normalized);
  for (const tp of tpValues) add({ tp });
  for (const ep of epValues) add({ ep });
  for (const pp of ppValues) add({ pp });
  for (const cp of cpValues) add({ cp });
  // TP and EP are the most consequential MoE serving axes. Include their joint combinations instead of only
  // one-factor-at-a-time changes; PP and CP remain independently swept to keep the P/D cross-product bounded.
  for (const tp of tpValues) for (const ep of epValues) add({ tp, ep });

  const baseKey = topologyKey(normalized);
  return [...candidates.values()]
    .sort((a, b) => Number(topologyKey(b) === baseKey) - Number(topologyKey(a) === baseKey)
      || inferenceReplicaGpus(a) - inferenceReplicaGpus(b)
      || a.tp - b.tp || a.ep - b.ep || a.pp - b.pp || a.cp - b.cp)
    .slice(0, 24);
}

function paretoFrontier(points: InferenceWorkloadParetoPoint[]): InferenceWorkloadParetoPoint[] {
  let bestThroughput = Number.NEGATIVE_INFINITY;
  const frontier: InferenceWorkloadParetoPoint[] = [];
  for (const point of [...points].sort((a, b) => b.interactivityTokPerSecPerUser - a.interactivityTokPerSecPerUser
    || b.outputCapacityTokensPerSec - a.outputCapacityTokensPerSec)) {
    if (point.outputCapacityTokensPerSec <= bestThroughput * (1 + 1e-9)) continue;
    frontier.push(point);
    bestThroughput = point.outputCapacityTokensPerSec;
  }
  return frontier.sort((a, b) => a.interactivityTokPerSecPerUser - b.interactivityTokPerSecPerUser);
}

function sameTopology(a: InferenceParallelism, b: InferenceParallelism): boolean {
  return topologyKey(normalizeInferenceParallelism({ ...a, dp: undefined })) === topologyKey(normalizeInferenceParallelism({ ...b, dp: undefined }));
}

/**
 * Sweep the selected workload itself on the placed cluster. Unlike the InferenceX evidence envelope, every point keeps
 * the current model, request shape, cache assumption and precision, then changes serving topology and TPOT target.
 */
export function analyzeInferenceWorkloadPareto(project: Project, workload: WorkloadBlueprint, regressionModel?: InferenceXRegressionModel): InferenceWorkloadParetoReport | undefined {
  if (!workload.inference) return undefined;
  const ctx = buildContext(project);
  const network = analyzeNetworkCtx(ctx);
  const cooling = analyzeCoolingCtx(ctx, network);
  const power = analyzePowerCtx(ctx, network, cooling);
  const baseEnv = workloadEnv(ctx, network, power);
  const rack = baseEnv.gpuRack;
  const compute = rack?.compute;
  if (!rack || !compute) return undefined;
  const allocatedGpus = Math.floor(Math.max(0, Math.min(1, workload.gpuShare)) * baseEnv.clusterGpus);
  if (allocatedGpus < 1) return undefined;

  const inf = workload.inference;
  const targetInteractivity = 1000 / Math.max(1, inf.tpotSloMs);
  const interactivityTargets = [...new Set([0.25, 0.5, 1, 2, 4]
    .map((factor) => Math.max(0.5, Math.min(1000, targetInteractivity * factor))))]
    .sort((a, b) => a - b);
  const common = inferenceParallelismFor(inf, 'aggregated');
  const configuredPrefill = inferenceParallelismFor(inf, 'prefill');
  const configuredDecode = inferenceParallelismFor(inf, 'decode');
  const aggregated = topologyCandidates(workload, 'aggregated', common, allocatedGpus, compute.gpuMemoryGB, compute.scaleUp.domainSize);
  const prefill = topologyCandidates(workload, 'prefill', configuredPrefill, allocatedGpus, compute.gpuMemoryGB, compute.scaleUp.domainSize);
  const decode = topologyCandidates(workload, 'decode', configuredDecode, allocatedGpus, compute.gpuMemoryGB, compute.scaleUp.domainSize);

  const run = (
    servingMode: 'aggregated' | 'disaggregated',
    p: InferenceParallelism,
    d: InferenceParallelism,
    interactivity: number,
    index: number,
  ): { analysis: WorkloadAnalysis; point?: InferenceWorkloadParetoPoint } => {
    const candidate: WorkloadBlueprint = {
      ...workload,
      model: { ...workload.model, moe: workload.model.moe ? { ...workload.model.moe } : undefined, mla: workload.model.mla ? { ...workload.model.mla } : undefined },
      inference: {
        ...inf,
        // A high offered rate lets the engine fill the placed pool. Network capacity is still derived by dividing
        // offered rate by calculated utilisation, so this does not claim that the demand is achieved.
        requestsPerSec: Math.max(inf.requestsPerSec, 1_000_000),
        tpotSloMs: 1000 / interactivity,
        disaggregated: servingMode === 'disaggregated',
        parallelism: { ...(servingMode === 'aggregated' ? d : common), dp: undefined },
        prefillParallelism: { ...p, dp: undefined },
        decodeParallelism: { ...d, dp: undefined },
      },
    };
    const traffic = analyzeTraffic({ project, workload: candidate, ctx, network });
    const candidateNetwork = traffic ? { ...network, analysis: { ...network.analysis, traffic } } : network;
    const analysis = simulateInference(candidate, workloadEnv(ctx, candidateNetwork, power));
    const analyticalCapacity = analysis.outputCapacityTokensPerSec;
    if (!(analyticalCapacity != null && analyticalCapacity > 0 && analysis.tpotMs != null && analysis.tpotMs > 0 && analysis.ttftMs != null)) return { analysis };
    const computeCapacityRps = Number(analysis.details?.computeCapacityRequestsPerSec ?? analysis.maxRequestsPerSec ?? 0);
    const networkCapacityRps = Number(analysis.details?.networkCapacityRequestsPerSec ?? analysis.maxRequestsPerSec ?? 0);
    const calibrated = Number(analysis.details?.calibrationApplied ?? 0) === 1;
    const usedGpus = Number(analysis.details?.placedPoolGpus ?? analysis.gpus);
    const placedPrefillGpus = servingMode === 'disaggregated'
      ? Number(analysis.details?.prefillReplicas ?? 0) * Number(analysis.details?.prefillInstanceGpus ?? inferenceReplicaGpus(p))
      : 0;
    const placedDecodeGpus = Number(analysis.details?.decodeReplicas ?? 0) * Number(analysis.details?.decodeInstanceGpus ?? inferenceReplicaGpus(d));
    const regression = !calibrated && regressionModel ? predictInferenceXRegression(regressionModel, {
      workload: candidate,
      gpuRack: rack,
      precision: candidate.inference!.weightPrecision === 'fp4' ? 'fp4' : candidate.inference!.weightPrecision === 'bf16' || candidate.inference!.weightPrecision === 'fp16' ? 'bf16' : 'fp8',
      servingMode,
      interactivityTokPerSecPerUser: 1000 / analysis.tpotMs,
      prefill: p,
      decode: d,
      prefillGpus: placedPrefillGpus,
      decodeGpus: placedDecodeGpus || usedGpus,
      concurrency: Math.max(1, analyticalCapacity / (1000 / analysis.tpotMs)),
    }) : undefined;
    const networkCapacity = networkCapacityRps * inf.outputTokens;
    const centralComputeCapacity = regression ? regression.outputTokensPerSecPerGpu * usedGpus : computeCapacityRps * inf.outputTokens;
    const lowerComputeCapacity = regression ? regression.lowerOutputTokensPerSecPerGpu * usedGpus : centralComputeCapacity;
    const upperComputeCapacity = regression ? regression.upperOutputTokensPerSecPerGpu * usedGpus : centralComputeCapacity;
    const capacity = Math.min(networkCapacity, centralComputeCapacity);
    const lowerCapacity = Math.min(networkCapacity, lowerComputeCapacity);
    const upperCapacity = Math.min(networkCapacity, upperComputeCapacity);
    const selectedTopology = servingMode === (inf.disaggregated ? 'disaggregated' : 'aggregated')
      && sameTopology(p, configuredPrefill)
      && sameTopology(d, servingMode === 'aggregated' ? common : configuredDecode)
      && Math.abs(interactivity - targetInteractivity) < 1e-9;
    return {
      analysis,
      point: {
        id: `${servingMode}-${index}`,
        servingMode,
        interactivityTokPerSecPerUser: 1000 / analysis.tpotMs,
        outputCapacityTokensPerSec: capacity,
        maxRequestsPerSec: analysis.maxRequestsPerSec ?? 0,
        ttftMs: analysis.ttftMs,
        tpotMs: analysis.tpotMs,
        meetsCurrentSlo: analysis.ttftMs <= inf.ttftSloMs && analysis.tpotMs <= inf.tpotSloMs,
        selectedTopology,
        calibrated,
        regression,
        networkLimited: networkCapacity + 1e-9 < centralComputeCapacity,
        usedGpus,
        allocatedGpus: analysis.gpus,
        prefillReplicas: Number(analysis.details?.prefillReplicas ?? 0),
        decodeReplicas: Number(analysis.details?.decodeReplicas ?? 0),
        prefill: { ...p },
        decode: { ...d },
        lowerOutputCapacityTokensPerSec: lowerCapacity,
        upperOutputCapacityTokensPerSec: upperCapacity,
        analyticalOutputCapacityTokensPerSec: analyticalCapacity,
      },
    };
  };

  const series: InferenceWorkloadParetoSeries[] = [];
  let sequence = 0;
  const aggregatedPoints: InferenceWorkloadParetoPoint[] = [];
  let aggregatedEvaluated = 0;
  for (const topology of aggregated) for (const interactivity of interactivityTargets) {
    aggregatedEvaluated++;
    const result = run('aggregated', topology, topology, interactivity, sequence++);
    if (result.point) aggregatedPoints.push(result.point);
  }
  series.push({
    servingMode: 'aggregated', evaluated: aggregatedEvaluated, feasible: aggregatedPoints.length,
    points: aggregatedPoints, frontier: paretoFrontier(aggregatedPoints),
  });

  const disaggregatedPoints: InferenceWorkloadParetoPoint[] = [];
  let disaggregatedEvaluated = 0;
  for (const p of prefill) for (const d of decode) {
    if (inferenceReplicaGpus(p) + inferenceReplicaGpus(d) > allocatedGpus) continue;
    for (const interactivity of interactivityTargets) {
      disaggregatedEvaluated++;
      const result = run('disaggregated', p, d, interactivity, sequence++);
      if (result.point) disaggregatedPoints.push(result.point);
    }
  }
  series.push({
    servingMode: 'disaggregated', evaluated: disaggregatedEvaluated, feasible: disaggregatedPoints.length,
    points: disaggregatedPoints, frontier: paretoFrontier(disaggregatedPoints),
  });

  return {
    workloadId: workload.id,
    workloadName: workload.name,
    accelerator: compute.gpuModel,
    allocatedGpus,
    targetInteractivityTokPerSecPerUser: targetInteractivity,
    targetTtftMs: inf.ttftSloMs,
    targetTpotMs: inf.tpotSloMs,
    series,
    evaluated: series.reduce((sum, item) => sum + item.evaluated, 0),
    feasible: series.reduce((sum, item) => sum + item.feasible, 0),
    regression: regressionModel ? {
      conditions: regressionModel.conditions,
      runs: regressionModel.runs,
      variantConditions: regressionModel.variantConditions,
      additionalVariants: regressionModel.additionalVariants,
      implementationMedianError: regressionModel.implementationMedianError,
      implementationP90Error: regressionModel.implementationP90Error,
      models: regressionModel.modelIds.length,
      hardware: regressionModel.hardwareKeys.length,
      modelHoldoutMedianError: regressionModel.modelHoldoutMedianError,
      modelHoldoutP90Error: regressionModel.modelHoldoutP90Error,
      hardwareHoldoutMedianError: regressionModel.hardwareHoldoutMedianError,
      hardwareHoldoutP90Error: regressionModel.hardwareHoldoutP90Error,
    } : undefined,
  };
}
