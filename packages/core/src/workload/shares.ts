// GPU share bookkeeping across workload blueprints (stream T6, DECISIONS-v2-2 F9).
//
// Convention (YARN CapacityScheduler "sum of capacities … must be equal to 100", Kueue nominalQuota — standard):
//   each workload i has gpuShare s_i ∈ (0, 1] of the cluster GPUs, S = Σ s_i should be ≤ 1.
//   S < 1  → 1 − S of the cluster is idle (shown, not an error)
//   S > 1  → over-allocated: analysis uses s_i / S (effectiveShares) and raises 'workload-share-over' (shareIssues);
//            the stored values are left unchanged until the user normalises.
//   normalize        s_i ← s_i / S (only when S > 1)
//   take-from-others need = w − s_k − max(0, 1 − S) (idle GPUs first), taken from donors j ∝ s_j, each donor clamped at its
//                    minimum share m_j = one model-parallel group (TP·CP·PP)_j / G; the clamped remainder is redistributed over
//                    the unclamped donors; if every donor sits at its minimum, s_k is capped (warning).
// All arithmetic is deterministic; functions return new blueprint objects and never mutate their input.
import type { Issue, WorkloadBlueprint } from '../model/types.ts';

const EPS = 1e-9;

export function gpuShareTotal(ws: WorkloadBlueprint[]): number {
  return ws.reduce((s, w) => s + (Number.isFinite(w.gpuShare) ? w.gpuShare : 0), 0);
}

/** GPUs of one model-parallel group: training TP·CP·PP, otherwise 1 GPU (inference instance size is found by the simulator). */
export function modelParallelGroupGpus(w: WorkloadBlueprint): number {
  const t = w.training;
  if (!t || w.kind === 'llm-inference' || w.kind === 'hpc-simulation') return 1;
  return Math.max(1, Math.round(t.tp)) * Math.max(1, Math.round(t.cp ?? 1)) * Math.max(1, Math.round(t.pp));
}

/** Minimum share of a workload: one model-parallel group of the cluster (0 when the cluster size is unknown). */
export function minShare(w: WorkloadBlueprint, clusterGpus?: number): number {
  if (!clusterGpus || clusterGpus <= 0) return 0;
  return Math.min(1, modelParallelGroupGpus(w) / clusterGpus);
}

export type ShareState = 'ok' | 'unallocated' | 'over';

/** OK (S = 1 within 0.1 %), unallocated (S < 1: idle GPUs), over (S > 1). */
export function shareState(ws: WorkloadBlueprint[]): { total: number; state: ShareState; idle: number; scale: number } {
  const total = gpuShareTotal(ws);
  const state: ShareState = total > 1 + 1e-3 ? 'over' : total < 1 - 1e-3 ? 'unallocated' : 'ok';
  return { total, state, idle: Math.max(0, 1 - total), scale: total > 1 + 1e-3 ? 1 / total : 1 };
}

/** The share each blueprint is analysed with: s_i / S when S > 1, else s_i (clamped to [0, 1]). */
export function effectiveShare(ws: WorkloadBlueprint[], w: WorkloadBlueprint): number {
  const { scale } = shareState(ws);
  const s = Number.isFinite(w.gpuShare) ? w.gpuShare : 0;
  return Math.min(1, Math.max(0, s * scale));
}

/** Blueprints with the analysed shares (same object when unchanged, so S ≤ 1 costs nothing). */
export function effectiveShares(ws: WorkloadBlueprint[]): WorkloadBlueprint[] {
  const { scale } = shareState(ws);
  if (scale === 1) return ws;
  return ws.map((w) => ({ ...w, gpuShare: effectiveShare(ws, w) }));
}

/** Scale shares so they sum to ≤ 1 (returns new blueprint objects). S ≤ 1 → the same array (nothing to normalise). */
export function normalizeShares(ws: WorkloadBlueprint[], mode: 'proportional' = 'proportional'): WorkloadBlueprint[] {
  void mode; // proportional is the only mode
  const total = gpuShareTotal(ws);
  if (total <= 1 + EPS) return ws;
  return ws.map((w) => ({ ...w, gpuShare: (Number.isFinite(w.gpuShare) ? w.gpuShare : 0) / total }));
}

/** Set `targetId` to 1 − Σ others (at least its minimum share); returns the same array when nothing changes. */
export function fillRemainder(ws: WorkloadBlueprint[], targetId: string, opts: { clusterGpus?: number } = {}): WorkloadBlueprint[] {
  const target = ws.find((w) => w.id === targetId);
  if (!target) return ws;
  const others = gpuShareTotal(ws.filter((w) => w.id !== targetId));
  const next = Math.min(1, Math.max(minShare(target, opts.clusterGpus), 1 - others));
  if (Math.abs(next - target.gpuShare) < EPS) return ws;
  return ws.map((w) => (w.id === targetId ? { ...w, gpuShare: next } : w));
}

export interface TakeShareResult {
  workloads: WorkloadBlueprint[];
  /** share the target actually received */
  granted: number;
  /** share that could not be taken because every donor reached its minimum (0 = request met) */
  shortfall: number;
  capped: boolean;
  /** share taken from idle GPUs (1 − S before the change) */
  fromIdle: number;
  /** share taken per donor id */
  taken: Record<string, number>;
}

/**
 * Give `targetId` the share `share`: idle GPUs first, then proportionally from the other blueprints, each clamped at one
 * model-parallel group (needs `clusterGpus`; without it donors may go to 0).
 */
export function takeShareDetailed(ws: WorkloadBlueprint[], targetId: string, share: number, opts: { clusterGpus?: number } = {}): TakeShareResult {
  const target = ws.find((w) => w.id === targetId);
  const want = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0));
  if (!target) return { workloads: ws, granted: 0, shortfall: 0, capped: false, fromIdle: 0, taken: {} };
  const total = gpuShareTotal(ws);
  const idle = Math.max(0, 1 - total);
  const sK = Number.isFinite(target.gpuShare) ? target.gpuShare : 0;
  const need = want - sK - idle;
  if (need <= EPS) {
    const workloads = Math.abs(want - sK) < EPS ? ws : ws.map((w) => (w.id === targetId ? { ...w, gpuShare: want } : w));
    return { workloads, granted: want, shortfall: 0, capped: false, fromIdle: Math.max(0, want - sK), taken: {} };
  }
  const donors = ws.filter((w) => w.id !== targetId).map((w) => ({ id: w.id, s: Number.isFinite(w.gpuShare) ? w.gpuShare : 0, min: minShare(w, opts.clusterGpus) }));
  const next = new Map(donors.map((d) => [d.id, d.s]));
  let remaining = need;
  // iterate: distribute ∝ current share over donors still above their minimum; clamp; redistribute the remainder
  for (let guard = 0; guard < donors.length + 2 && remaining > EPS; guard++) {
    const active = donors.filter((d) => next.get(d.id)! - d.min > EPS);
    const base = active.reduce((s, d) => s + next.get(d.id)!, 0);
    if (!active.length || base <= EPS) break;
    let given = 0;
    for (const d of active) {
      const cur = next.get(d.id)!;
      const ask = (remaining * cur) / base;
      const give = Math.min(ask, cur - d.min);
      next.set(d.id, cur - give);
      given += give;
    }
    remaining -= given;
  }
  const shortfall = Math.max(0, remaining);
  const granted = want - shortfall;
  const taken: Record<string, number> = {};
  for (const d of donors) if (d.s - next.get(d.id)! > EPS) taken[d.id] = d.s - next.get(d.id)!;
  const workloads = ws.map((w) => (w.id === targetId ? { ...w, gpuShare: granted } : next.has(w.id) && Math.abs(next.get(w.id)! - w.gpuShare) > EPS ? { ...w, gpuShare: next.get(w.id)! } : w));
  return { workloads, granted, shortfall, capped: shortfall > 1e-6, fromIdle: idle, taken };
}

/** Give `targetId` the share `share`, taking the shortfall from the other blueprints (see takeShareDetailed). */
export function takeShare(ws: WorkloadBlueprint[], targetId: string, share: number, opts: { clusterGpus?: number } = {}): WorkloadBlueprint[] {
  return takeShareDetailed(ws, targetId, share, opts).workloads;
}

/** 'workload-share-over' validation issue (domain workload, owned by T6; validate.ts calls this). */
export function shareIssues(ws: WorkloadBlueprint[]): Issue[] {
  const { total, state } = shareState(ws);
  if (state !== 'over') return [];
  const pct = (v: number) => `${(v * 100).toFixed(0)}`;
  const list = ws.map((w) => `${w.name} ${pct(w.gpuShare)}→${pct(w.gpuShare / total)} %`).join(', ');
  return [{
    id: 'workload-share-over',
    severity: 'warning',
    domain: 'workload',
    message: `워크로드 GPU 비중 합계가 ${pct(total)} %로 100 %를 초과합니다. 분석은 비례 축소한 비중으로 수행했습니다 (${list}).`,
    suggestion: '워크로드 패널에서 "비례 정규화"로 비중을 저장하거나, 워크로드별 비중을 조정하세요.',
    messageEn: `Workload GPU shares add up to ${pct(total)} %, above 100 %. The analysis used proportionally scaled shares (${list}).`,
    suggestionEn: 'Use "Normalize proportionally" in the Workload panel to store the scaled shares, or adjust each share.',
    refs: [],
  }];
}
