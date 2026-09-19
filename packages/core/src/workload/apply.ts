// Analysis → configuration write-back ("apply-back").
//
// Every analysis surface in the Workload panel already computes values the user would otherwise read off a chart and
// retype: the Pareto sweep's serving mode and per-stage TP/PP/EP/CP, the memory estimate's minimum TP, the engine's
// required replica count. Without a return edge the panel is a one-way line — the sweep answers the question and the
// user transcribes the answer back by hand, where a typo silently produces a different design.
//
// A patch is a PROPOSAL, not an authority. The project remains the only source of editable design data
// (docs/ARCHITECTURE.md), applying one is an ordinary user edit on the normal undo path, and a patch may only write
// fields the user could have typed in the panel. In particular it never touches `w.calibration`: whether a stored
// calibration still applies is decided by the engine from the blueprint's own signature, and a patch that wrote it
// would be laundering an analysis result into evidence.
//
// All functions here are pure: they return new objects and never mutate their input, matching workload/shares.ts.

import type { Id, InferenceParallelism, WorkloadBlueprint } from '../model/types.ts';
import { normalizeInferenceParallelism } from './inference.ts';

/** Where a proposed value came from, so the UI can badge an apply action with the product's evidence vocabulary. */
export interface WorkloadPatchProvenance {
  source: 'pareto-sweep' | 'memory-estimate' | 'engine-sizing' | 'inferencex-measured' | 'topology-sweep';
  /** evidence class of the proposal itself (not of the model it came from) */
  evidence: 'public-spec' | 'derived' | 'estimate';
  /** what the proposal was computed against, e.g. the accelerator and the allocated pool */
  basis: string;
}

/**
 * Adopt a serving topology. The sweep evaluates every candidate with DP unset so the engine fills the placed pool,
 * so applying one CLEARS any explicit DP rather than writing the replica count the report displayed — writing it
 * would pin a pool the sweep never assumed, and leaving a pre-existing DP in place would silently diverge from the
 * point the user picked.
 */
export interface InferenceTopologyPatch {
  kind: 'inference-topology';
  workloadId: Id;
  provenance: WorkloadPatchProvenance;
  disaggregated: boolean;
  /** replica topology for aggregated serving */
  aggregated?: InferenceParallelism;
  /** prefill / decode replica topologies for P/D disaggregated serving */
  prefill?: InferenceParallelism;
  decode?: InferenceParallelism;
  /** TPOT SLO the point was evaluated at; applied only when the caller opts in, since it restates the commitment */
  tpotSloMs?: number;
}

/** Adopt a training parallelism from the topology sweep. Writes tp / cp / pp / ep only — never mfuAssumed, never the calibration. */
export interface TrainingTopologyPatch {
  kind: 'training-topology';
  workloadId: Id;
  provenance: WorkloadPatchProvenance;
  tp: number;
  cp: number;
  pp: number;
  ep: number;
}

export type WorkloadPatch = InferenceTopologyPatch | TrainingTopologyPatch;

/** One field the patch would change, for the confirm diff the UI shows before writing anything. */
export interface WorkloadPatchChange {
  /** dotted path within the blueprint, e.g. 'decode.tp' */
  field: string;
  from: string;
  to: string;
}

const topology = (p: InferenceParallelism): InferenceParallelism => {
  const n = normalizeInferenceParallelism({ ...p, dp: undefined });
  delete n.dp;
  return n;
};

const label = (p: InferenceParallelism | undefined): string => (p
  ? `TP${p.tp}/PP${p.pp}/EP${p.ep}/CP${p.cp}${p.expertMapping === 'orthogonal' ? ' orthogonal' : ''}`
  : '–');

function stageChanges(stage: string, current: InferenceParallelism | undefined, next: InferenceParallelism | undefined): WorkloadPatchChange[] {
  if (!next) return [];
  const before = current ? topology(current) : undefined;
  const after = topology(next);
  const out: WorkloadPatchChange[] = [];
  for (const key of ['tp', 'pp', 'ep', 'cp'] as const) {
    if (before?.[key] !== after[key]) out.push({ field: `${stage}.${key}`, from: before ? String(before[key]) : '–', to: String(after[key]) });
  }
  const beforeMapping = before?.expertMapping ?? 'shared';
  const afterMapping = after.expertMapping ?? 'shared';
  if (beforeMapping !== afterMapping) out.push({ field: `${stage}.expertMapping`, from: beforeMapping, to: afterMapping });
  // An explicit DP that the patch clears is a real, user-visible change: the pool stops being pinned and the engine
  // re-derives it, which is what the swept point assumed.
  if (current?.dp !== undefined) out.push({ field: `${stage}.dp`, from: String(current.dp), to: 'auto' });
  return out;
}

/** Every field the patch would change on the target blueprint. Empty ⇒ applying it is a no-op. */
export function workloadPatchChanges(ws: readonly WorkloadBlueprint[], patch: WorkloadPatch): WorkloadPatchChange[] {
  if (patch.kind === 'training-topology') {
    const tr = ws.find((x) => x.id === patch.workloadId)?.training;
    if (!tr) return [];
    const cur = { tp: tr.tp, cp: tr.cp ?? 1, pp: tr.pp, ep: tr.ep };
    const out: WorkloadPatchChange[] = [];
    for (const key of ['tp', 'cp', 'pp', 'ep'] as const) if (cur[key] !== patch[key]) out.push({ field: `training.${key}`, from: String(cur[key]), to: String(patch[key]) });
    return out;
  }
  const w = ws.find((x) => x.id === patch.workloadId);
  const inf = w?.inference;
  if (!w || !inf) return [];
  const out: WorkloadPatchChange[] = [];
  if (inf.disaggregated !== patch.disaggregated) {
    out.push({ field: 'servingMode', from: inf.disaggregated ? 'disaggregated' : 'aggregated', to: patch.disaggregated ? 'disaggregated' : 'aggregated' });
  }
  if (patch.disaggregated) {
    out.push(...stageChanges('prefill', inf.prefillParallelism, patch.prefill));
    out.push(...stageChanges('decode', inf.decodeParallelism, patch.decode));
  } else {
    out.push(...stageChanges('aggregated', inf.parallelism, patch.aggregated));
  }
  if (patch.tpotSloMs !== undefined && patch.tpotSloMs !== inf.tpotSloMs) {
    out.push({ field: 'tpotSloMs', from: `${inf.tpotSloMs} ms`, to: `${patch.tpotSloMs} ms` });
  }
  return out;
}

/** Short human-readable summary of the topology a patch would install, for a button title or a toast. */
export function workloadPatchLabel(patch: WorkloadPatch): string {
  if (patch.kind === 'training-topology') return `TP${patch.tp}/CP${patch.cp}/PP${patch.pp}/EP${patch.ep}`;
  return patch.disaggregated
    ? `P ${label(patch.prefill)} · D ${label(patch.decode)}`
    : label(patch.aggregated);
}

export function workloadPatchIsNoop(ws: readonly WorkloadBlueprint[], patch: WorkloadPatch): boolean {
  return workloadPatchChanges(ws, patch).length === 0;
}

/**
 * Apply a patch, returning new blueprint objects. The input array and its members are never mutated, and the same
 * array is returned when nothing changes so a store update can skip a no-op edit.
 */
export function applyWorkloadPatch(ws: WorkloadBlueprint[], patch: WorkloadPatch): WorkloadBlueprint[] {
  if (patch.kind === 'training-topology') {
    if (workloadPatchIsNoop(ws, patch)) return ws;
    return ws.map((w) => (w.id !== patch.workloadId || !w.training ? w : { ...w, training: { ...w.training, tp: patch.tp, cp: patch.cp, pp: patch.pp, ep: patch.ep } }));
  }
  const target = ws.find((x) => x.id === patch.workloadId);
  if (!target?.inference || workloadPatchIsNoop(ws, patch)) return ws;
  return ws.map((w) => {
    if (w.id !== patch.workloadId || !w.inference) return w;
    const inference = { ...w.inference, disaggregated: patch.disaggregated };
    if (patch.disaggregated) {
      if (patch.prefill) inference.prefillParallelism = topology(patch.prefill);
      if (patch.decode) inference.decodeParallelism = topology(patch.decode);
    } else if (patch.aggregated) {
      inference.parallelism = topology(patch.aggregated);
    }
    if (patch.tpotSloMs !== undefined) inference.tpotSloMs = patch.tpotSloMs;
    return { ...w, inference };
  });
}
