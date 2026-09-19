import { describe, expect, it } from 'vitest';
import { analyzeTrainingWorkloadTopologies, createNvidiaReferenceProject } from '../src/index.ts';

/**
 * Sweep guard. Before the compute path became topology-sensitive (engines/traffic.ts: η_k · κ_tp · (1 + β), scale-up
 * time exposable) the best of 328 candidates beat the configured one by 1.0002× — a ranking ordered by floating-point
 * noise. These tests fail loudly if that ever comes back, so a no-signal ranking can never ship again.
 */
const SPREAD_FLOOR = 1.02;

function trainingCase() {
  const { project } = createNvidiaReferenceProject();
  const workload = project.workloads.find((w) => w.training)!;
  return { project, workload };
}

describe('training topology sweep on the placed cluster', () => {
  it('ranks with real signal, keeps the configured topology, and truncates nothing', () => {
    const { project, workload } = trainingCase();
    const report = analyzeTrainingWorkloadTopologies(project, workload)!;
    expect(report).toBeDefined();
    expect(report.memoryChecked).toBe(true);
    expect(report.ranked.length).toBeGreaterThan(3);
    expect(report.enumerated).toBe(report.ranked.length + report.rejectedList.length);
    for (const c of report.rejectedList) expect(c.reason).toBeTruthy();

    // the user's own configuration is always present — the dead-end the inference sweep audit found
    expect(report.selected, 'configured topology must be a candidate').toBeDefined();
    expect(report.ranked.some((c) => c.selected) || report.selected!.status === 'rejected').toBe(true);

    // SWEEP GUARD: a fixed-pool sweep must separate its candidates
    expect(report.spread).toBeGreaterThan(SPREAD_FLOOR);

    // monotone ranking, every ranked point on the traffic step model
    for (let i = 1; i < report.ranked.length; i++) {
      expect(report.ranked[i].timeToTrainDays!).toBeGreaterThanOrEqual(report.ranked[i - 1].timeToTrainDays!);
    }
    expect(report.ranked.every((c) => c.stepModel === 'traffic-v2')).toBe(true);
    // pool accounting: used + stranded = allocated, always
    for (const c of report.ranked) expect(c.usedGpus + c.strandedGpus).toBe(report.allocatedGpus);
  });

  it('explores real alternatives to the configured tensor-parallel degree', () => {
    const { project, workload } = trainingCase();
    const report = analyzeTrainingWorkloadTopologies(project, workload)!;
    const sel = report.selected!;
    // At least one smaller-TP candidate is ranked and lands within a plausible band of the configuration: the sweep
    // must actually compare the shard-efficiency / bubble / exposed-all-reduce trade-off rather than pin TP.
    const smaller = report.ranked.filter((c) => c.tp < sel.tp && c.pp === sel.pp && c.cp === sel.cp && c.ep === sel.ep);
    expect(smaller.length).toBeGreaterThan(0);
    for (const c of smaller) expect(c.speedupVsSelected!).toBeGreaterThan(0.5);
    // TP above 8 is never silently trusted
    for (const c of report.ranked) if (c.tp > 8) expect(c.extrapolated).toBe(true);
  });

  it('is deterministic', () => {
    const { project, workload } = trainingCase();
    expect(analyzeTrainingWorkloadTopologies(project, workload)).toEqual(analyzeTrainingWorkloadTopologies(project, workload));
  });
});
