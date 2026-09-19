// Training topology sweep (AREA 2 of the training track): rank TP / CP / PP / EP for one training blueprint on the
// cluster that is actually placed, by running the real pipeline per candidate (analyzeTraffic → simulateTraining).
//
// This exists only because the step model is topology-sensitive now (engines/traffic.ts compute path: η_k · κ_tp · (1+β),
// scale-up time exposable). Before that change the best of 328 candidates beat the configured one by 1.0002×, so any
// ranking was noise — the sweep-guard test in training-topology.test.ts fails if that ever comes back.
//
// Rules carried over from the inference-sweep audit: the pool is sized from the analysed share (Σ gpuShare > 1 scales it,
// exactly as the simulation result the user sees), NOTHING is truncated (enumerated = ranked + rejected, every rejection
// carries a reason), the user's own configuration is always present and marked, and TP above 8 is flagged as
// extrapolation because κ_tp has no public support there. There is no training memory model yet, so feasibility is NOT
// checked — `memoryChecked: false` says so rather than implying it.

import type { Project, WorkloadBlueprint } from '../model/types.ts';
import { analyzeCoolingCtx } from './cooling.ts';
import { buildContext } from './context.ts';
import { analyzeNetworkCtx } from './network.ts';
import { analyzePowerCtx } from './power.ts';
import { analyzeTraffic } from './traffic.ts';
import { analysedBlueprint, jobClusterGpus, simulateTraining, workloadEnv } from './workload.ts';
import type { TrainingTopologyPatch } from '../workload/apply.ts';

export type TrainingTopologyReason = 'heads' | 'experts' | 'expert-placement' | 'pool' | 'engine';

export interface TrainingTopologyCandidate {
  id: string;
  tp: number;
  cp: number;
  pp: number;
  ep: number;
  /** data-parallel replicas the engine actually formed: floor(allocated / (tp·cp·pp)) */
  dp: number;
  usedGpus: number;
  strandedGpus: number;
  status: 'ok' | 'rejected';
  reason?: TrainingTopologyReason;
  /** this is the blueprint's configured topology */
  selected: boolean;
  /** tp > 8: no public measurement supports κ_tp there — direction only */
  extrapolated: boolean;
  /** tp exceeds the scale-up domain: the all-reduce rides the NIC (modelled, but no public anchor for the penalty) */
  crossesScaleUp: boolean;
  /** layers % pp ≠ 0 — legal (Llama 3 runs 126 layers on PP16), but the stage-imbalance cost is not modelled yet */
  unevenStages: boolean;
  timeToTrainDays?: number;
  stepTimeS?: number;
  mfu?: number;
  exposedCommS?: number;
  pipelineBubble?: number;
  bindingGroup?: string;
  stepModel: 'traffic-v2' | 'v1' | 'none';
  /** selected.timeToTrainDays ÷ this candidate's — > 1 means faster than the configuration */
  speedupVsSelected?: number;
}

export interface TrainingTopologyReport {
  workloadId: string;
  workloadName: string;
  accelerator: string;
  allocatedGpus: number;
  scaleUpDomain: number;
  enumerated: number;
  evaluated: number;
  feasible: number;
  rejected: number;
  /** no training memory model exists yet — candidates are NOT checked for HBM fit */
  memoryChecked: false;
  /** status 'ok', ascending time-to-train; ties → fewer stranded GPUs, then smaller tp, cp, pp, ep */
  ranked: TrainingTopologyCandidate[];
  rejectedList: TrainingTopologyCandidate[];
  selected?: TrainingTopologyCandidate;
  /** worst ÷ best time-to-train among ranked candidates — the signal the sweep-guard test protects */
  spread: number;
  notes: string[];
}

const POW2 = [1, 2, 4, 8, 16, 32, 64];
const axis = (limit: number, configured: number, extra: number[] = []) => [...new Set([...POW2, ...extra, configured]
  .map((v) => Math.max(1, Math.round(v)))
  .filter((v) => v <= Math.max(1, limit)))]
  .sort((a, b) => a - b);

/**
 * Sweep TP / CP / PP / EP for a training blueprint on the placed cluster. Pure: the same project and blueprint give the
 * same report. Undefined when the blueprint has no training block or no GPU rack is placed.
 */
export function analyzeTrainingWorkloadTopologies(project: Project, workload: WorkloadBlueprint): TrainingTopologyReport | undefined {
  const t = workload.training;
  if (!t) return undefined;
  const ctx = buildContext(project);
  const network = analyzeNetworkCtx(ctx);
  const cooling = analyzeCoolingCtx(ctx, network);
  const power = analyzePowerCtx(ctx, network, cooling);
  const rack = ctx.gpuRack;
  const compute = rack?.compute;
  if (!rack || !compute || compute.gpus <= 0) return undefined;

  // The share the rest of the pipeline analyses with — never the raw gpuShare (inference-sweep audit finding).
  const analysed = analysedBlueprint(project.workloads, workload);
  const clusterGpus = jobClusterGpus(ctx, network);
  const allocated = Math.floor(Math.max(0, Math.min(1, analysed.gpuShare)) * clusterGpus);
  if (allocated < 1) return undefined;

  const model = workload.model;
  const heads = Math.max(1, Math.round(model.numHeads ?? model.hiddenSize / 128));
  const layers = Math.max(1, Math.round(model.layers));
  const experts = model.moe?.experts ?? 0;
  const U = Math.max(1, compute.scaleUp.domainSize);
  const cfg = { tp: Math.max(1, Math.round(t.tp)), cp: Math.max(1, Math.round(t.cp ?? 1)), pp: Math.max(1, Math.round(t.pp)), ep: Math.max(1, Math.round(t.ep)) };

  // TP is capped at the practitioner-standard 8 (κ_tp has no public support above it); the configured value is always kept.
  const tpValues = axis(Math.min(8, heads, allocated), cfg.tp);
  const cpValues = axis(Math.min(8, allocated), cfg.cp);
  const ppValues = axis(Math.min(32, layers, allocated), cfg.pp);
  const epValues = experts > 0 ? axis(Math.min(64, experts, allocated), cfg.ep) : [1];

  const candidates: TrainingTopologyCandidate[] = [];
  let enumerated = 0;
  for (const tp of tpValues) for (const cp of cpValues) for (const pp of ppValues) for (const ep of epValues) {
    enumerated++;
    const group = tp * cp * pp;
    const dp = Math.floor(allocated / group);
    const usedGpus = dp * group;
    const base: TrainingTopologyCandidate = {
      id: `tp${tp}-cp${cp}-pp${pp}-ep${ep}`,
      tp, cp, pp, ep, dp, usedGpus, strandedGpus: allocated - usedGpus,
      status: 'ok',
      selected: tp === cfg.tp && cp === cfg.cp && pp === cfg.pp && ep === cfg.ep,
      extrapolated: tp > 8,
      crossesScaleUp: tp > U,
      unevenStages: layers % pp !== 0,
      stepModel: 'none',
    };
    // legality — every rejection is kept and explained, nothing is silently dropped
    let reason: TrainingTopologyReason | undefined;
    // uneven pipeline stages are legal and stay in the sweep (flagged); heads and experts must divide — framework requirements
    if (heads % tp !== 0) reason = 'heads';
    else if (experts > 0 && experts % ep !== 0) reason = 'experts';
    // expert parallelism is carved out of the DP·CP ranks (Megatron-Core / DeepSeek-V3), so it cannot exceed them
    else if (experts > 0 && ep > Math.max(1, dp) * cp) reason = 'expert-placement';
    else if (dp < 1) reason = 'pool';
    if (reason) {
      candidates.push({ ...base, status: 'rejected', reason });
      continue;
    }
    // the real pipeline, exactly as the Workload panel's result card runs it
    const candidate: WorkloadBlueprint = { ...analysed, training: { ...t, tp, cp, pp, ep } };
    const traffic = analyzeTraffic({ project, workload: candidate, ctx, network });
    const candidateNetwork = traffic ? { ...network, analysis: { ...network.analysis, traffic } } : network;
    const a = simulateTraining(candidate, workloadEnv(ctx, candidateNetwork, power));
    if (!(a.gpus > 0) || a.timeToTrainDays == null || !Number.isFinite(a.timeToTrainDays)) {
      candidates.push({ ...base, status: 'rejected', reason: a.gpus > 0 ? 'engine' : 'pool' });
      continue;
    }
    const stepModel = String(a.details?.stepModel ?? (traffic ? 'traffic-v2' : 'v1')) as TrainingTopologyCandidate['stepModel'];
    candidates.push({
      ...base,
      usedGpus: a.gpus,
      strandedGpus: allocated - a.gpus,
      timeToTrainDays: a.timeToTrainDays,
      stepTimeS: a.stepTimeS,
      mfu: a.mfu,
      exposedCommS: a.commTimeS,
      pipelineBubble: traffic?.pipelineBubble,
      bindingGroup: traffic?.bindingGroup,
      stepModel,
    });
  }

  const ranked = candidates.filter((c) => c.status === 'ok').sort((a, b) => (a.timeToTrainDays! - b.timeToTrainDays!)
    || (a.strandedGpus - b.strandedGpus) || (a.tp - b.tp) || (a.cp - b.cp) || (a.pp - b.pp) || (a.ep - b.ep));
  const rejectedList = candidates.filter((c) => c.status === 'rejected');
  const selected = candidates.find((c) => c.selected);
  if (selected?.timeToTrainDays) for (const c of ranked) c.speedupVsSelected = selected.timeToTrainDays / c.timeToTrainDays!;
  const spread = ranked.length > 1 ? ranked[ranked.length - 1].timeToTrainDays! / ranked[0].timeToTrainDays! : 1;

  const notes: string[] = [
    `Ranked by time-to-train on the placed ${compute.gpuModel} cluster (${allocated} GPUs allocated of ${clusterGpus}); every candidate ran analyzeTraffic + simulateTraining. Nothing was truncated: ${enumerated} enumerated = ${ranked.length} ranked + ${rejectedList.length} rejected.`,
    'HBM fit is NOT checked — there is no training memory model yet, so a fast candidate may not load. Treat the ranking as a step-time ordering, not a feasibility verdict.',
    `Evidence basis: the TP axis (1–8) is calibrated on Hagemann et al. (A100 TP×PP sweeps) and Meta ISCA'25; PP × micro-batch on ISCA and Zero Bubble bubble ratios; CP and EP rest on single published points (ISCA CP16 exposure, MoE Parallel Folding). TP above 8 and TP across the scale-up domain (${U}) are direction-only.`,
  ];
  if (selected && selected.status === 'rejected') notes.push(`The configured topology tp${cfg.tp}/cp${cfg.cp}/pp${cfg.pp}/ep${cfg.ep} is not legal on this cluster (${selected.reason}).`);
  if (ranked.some((c) => c.unevenStages)) notes.push(`${layers} layers do not divide evenly across every pipeline depth swept; uneven stages are legal, but their imbalance cost (edge stages carry the embedding and LM head — ISCA'25 +6.5 %) is not modelled yet, so candidates flagged unevenStages are slightly optimistic.`);

  return {
    workloadId: workload.id,
    workloadName: workload.name,
    accelerator: compute.gpuModel,
    allocatedGpus: allocated,
    scaleUpDomain: U,
    enumerated,
    evaluated: candidates.length - rejectedList.filter((c) => c.reason !== 'engine' && c.reason !== 'pool').length,
    feasible: ranked.length,
    rejected: rejectedList.length,
    memoryChecked: false,
    ranked,
    rejectedList,
    selected,
    spread,
    notes,
  };
}

/** The patch that adopts a swept training topology with one click. Extrapolated or scale-up-crossing points are badged 'estimate'. */
export function trainingCandidatePatch(report: TrainingTopologyReport, c: TrainingTopologyCandidate): TrainingTopologyPatch {
  return {
    kind: 'training-topology',
    workloadId: report.workloadId,
    provenance: {
      source: 'topology-sweep',
      evidence: c.extrapolated || c.crossesScaleUp ? 'estimate' : 'derived',
      basis: `${report.accelerator} · ${report.allocatedGpus} GPU · ${c.stepModel}${report.memoryChecked ? '' : ' · HBM fit not checked'}`,
    },
    tp: c.tp,
    cp: c.cp,
    pp: c.pp,
    ep: c.ep,
  };
}
