import { describe, expect, it } from 'vitest';
import {
  analyzeInferenceWorkloadPareto,
  analyzeProject,
  applyModelPreset,
  applyRemedy,
  applyWorkloadPatch,
  createNvidiaReferenceProject,
  findCatalogItem,
  findModelPreset,
  fixAllRemedies,
  gpuShareTotal,
  issueRemedy,
  paretoPointPatch,
  workloadPatchChanges,
  workloadPatchIsNoop,
  type InferenceWorkloadParetoPoint,
  type WorkloadBlueprint,
} from '../src/index.ts';

function deepSeekProject() {
  const { project } = createNvidiaReferenceProject();
  let gpuRacks = 0;
  project.equipment = project.equipment.filter((equipment) => {
    const item = findCatalogItem(equipment.catalogId);
    const isGpuRack = item?.category === 'gpu-rack' && typeof equipment.meta?.computeSlot !== 'string';
    if (!isGpuRack) return true;
    gpuRacks++;
    if (gpuRacks > 8) return false;
    equipment.catalogId = 'hgx-b200-air-4x';
    return true;
  });
  const workload = project.workloads.find((item) => item.inference)!;
  const preset = findModelPreset('deepseek-r1')!;
  workload.presetId = preset.id;
  workload.model = applyModelPreset(workload.model, preset);
  workload.gpuShare = 1;
  workload.inference = {
    requestsPerSec: 1000,
    inputTokens: 8192,
    outputTokens: 1024,
    ttftSloMs: 1000,
    tpotSloMs: 40,
    disaggregated: true,
    weightPrecision: 'fp4',
    kvPrecision: 'fp8',
    parallelism: { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared' },
    prefillParallelism: { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared' },
    decodeParallelism: { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared' },
  };
  delete workload.calibration;
  project.network.trafficWorkloadId = workload.id;
  return { project, workload };
}

/** A frontier point whose topology differs from the configured one, i.e. one worth applying. */
function firstDifferentPoint(points: InferenceWorkloadParetoPoint[]): InferenceWorkloadParetoPoint {
  const point = points.find((candidate) => !candidate.selectedTopology
    && (candidate.decode.tp !== 8 || candidate.decode.ep !== 8 || candidate.decode.pp !== 1 || candidate.decode.cp !== 1));
  expect(point, 'the sweep should surface at least one topology other than the configured one').toBeDefined();
  return point!;
}

describe('apply-back: analysis → configuration', () => {
  it('installs the topology of the point that was clicked', () => {
    const { project, workload } = deepSeekProject();
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const point = firstDifferentPoint(report.series.flatMap((series) => series.frontier));
    const patch = paretoPointPatch(report, point);

    const applied = applyWorkloadPatch(project.workloads, patch);
    const after = applied.find((w) => w.id === workload.id)!.inference!;
    expect(after.disaggregated).toBe(point.servingMode === 'disaggregated');
    const stage = point.servingMode === 'disaggregated' ? after.decodeParallelism! : after.parallelism!;
    expect({ tp: stage.tp, pp: stage.pp, ep: stage.ep, cp: stage.cp })
      .toEqual({ tp: point.decode.tp, pp: point.decode.pp, ep: point.decode.ep, cp: point.decode.cp });
  });

  it('clears a pinned DP instead of writing back the replica count the report displayed', () => {
    const { project, workload } = deepSeekProject();
    // A user who pinned DP by hand would otherwise keep that pool after adopting a point the sweep evaluated with
    // DP unset — the result would silently differ from the row they clicked.
    workload.inference!.decodeParallelism = { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared', dp: 3 };
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    // A pinned decode DP only applies to P/D serving, so adopt a P/D point: an aggregated point writes
    // `inference.parallelism` instead and would say nothing about the decode pool.
    const disaggregated = report.series.find((series) => series.servingMode === 'disaggregated')!;
    const point = firstDifferentPoint(disaggregated.points);
    const changes = workloadPatchChanges(project.workloads, paretoPointPatch(report, point));
    expect(changes.some((change) => change.field === 'decode.dp' && change.to === 'auto')).toBe(true);

    const applied = applyWorkloadPatch(project.workloads, paretoPointPatch(report, point));
    expect(applied.find((w) => w.id === workload.id)!.inference!.decodeParallelism!.dp).toBeUndefined();
  });

  it('re-running the sweep after an apply reproduces the point that was applied', () => {
    const { project, workload } = deepSeekProject();
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const point = firstDifferentPoint(report.series.flatMap((series) => series.frontier));

    // This is the invariant that makes an Apply button honest: what the user clicked is what they now have.
    // It fails on a sweep whose pool, SLO or DP differ from the configuration it writes back.
    const patch = paretoPointPatch(report, point, { applySlo: true });
    const next = { ...project, workloads: applyWorkloadPatch(project.workloads, patch) };
    const appliedWorkload = next.workloads.find((w) => w.id === workload.id)!;
    const after = analyzeInferenceWorkloadPareto(next, appliedWorkload)!;

    const selected = after.series.flatMap((series) => series.points).find((candidate) => candidate.selectedTopology);
    expect(selected, 'the applied configuration must appear as the selected point of the next sweep').toBeDefined();
    expect(selected!.servingMode).toBe(point.servingMode);
    expect({ tp: selected!.decode.tp, pp: selected!.decode.pp, ep: selected!.decode.ep, cp: selected!.decode.cp })
      .toEqual({ tp: point.decode.tp, pp: point.decode.pp, ep: point.decode.ep, cp: point.decode.cp });
    expect(selected!.analyticalOutputCapacityTokensPerSec).toBeCloseTo(point.analyticalOutputCapacityTokensPerSec, 6);
  });

  it('is pure and reports a no-op instead of rewriting the project', () => {
    const { project, workload } = deepSeekProject();
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const point = firstDifferentPoint(report.series.flatMap((series) => series.frontier));
    const before: WorkloadBlueprint[] = structuredClone(project.workloads);

    const applied = applyWorkloadPatch(project.workloads, paretoPointPatch(report, point));
    expect(project.workloads).toEqual(before); // input untouched
    expect(applied).not.toBe(project.workloads);

    // Applying the same patch twice changes nothing the second time, and the identical array is returned so a store
    // update can skip the edit entirely.
    const patchAgain = paretoPointPatch(report, point);
    expect(workloadPatchIsNoop(applied, patchAgain)).toBe(true);
    expect(applyWorkloadPatch(applied, patchAgain)).toBe(applied);
  });

  it('offers a workload-share remedy that "Fix all" can never apply', () => {
    const { project } = deepSeekProject();
    // The fixture leaves the reference project's 0.8-share training blueprint in place and sets this one to 1.0.
    expect(gpuShareTotal(project.workloads)).toBeCloseTo(1.8, 9);
    const analysis = analyzeProject(project);
    const issue = analysis.issues.find((item) => item.id === 'workload-share-over');
    expect(issue, 'an over-allocated project must raise workload-share-over').toBeDefined();

    const remedy = issueRemedy(project, analysis, issue!);
    expect(remedy).toMatchObject({ kind: 'workload-share', safe: false });

    const fixed = applyRemedy(project, remedy!);
    expect(gpuShareTotal(fixed.workloads)).toBeCloseTo(1, 9);
    expect(gpuShareTotal(project.workloads)).toBeCloseTo(1.8, 9); // pure: the input project is untouched

    // The guarantee the design rests on: GPU shares and parallelism are design decisions, so no workload remedy may
    // be swept up by a bulk fix. Enforced twice over — safe:false, and the kind is absent from PRIORITY.
    expect(fixAllRemedies(project).applied.some((r) => r.kind.startsWith('workload-'))).toBe(false);
  });

  it('never writes the calibration', () => {
    const { project, workload } = deepSeekProject();
    workload.calibration = { mode: 'inference', tokensPerSecPerGpu: 500, source: 'test measurement' };
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const point = firstDifferentPoint(report.series.flatMap((series) => series.frontier));
    const applied = applyWorkloadPatch(project.workloads, paretoPointPatch(report, point, { applySlo: true }));
    // Whether a stored calibration still applies is the engine's decision, made from the blueprint's own signature.
    // A patch that wrote it would launder an analysis result into evidence.
    expect(applied.find((w) => w.id === workload.id)!.calibration).toEqual(workload.calibration);
  });
});
