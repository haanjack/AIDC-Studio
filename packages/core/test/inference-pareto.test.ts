import { describe, expect, it } from 'vitest';
import {
  analyzeInferenceWorkloadPareto,
  analyzeProject,
  applyModelPreset,
  createNvidiaReferenceProject,
  findCatalogItem,
  findModelPreset,
  inferenceCalibrationSignature,
} from '../src/index.ts';

function deepSeekProject(rackId: string, tpotSloMs = 40, opts: { disaggregated?: boolean; requestsPerSec?: number } = {}) {
  const { project } = createNvidiaReferenceProject();
  let gpuRacks = 0;
  project.equipment = project.equipment.filter((equipment) => {
    const item = findCatalogItem(equipment.catalogId);
    const isGpuRack = item?.category === 'gpu-rack' && typeof equipment.meta?.computeSlot !== 'string';
    if (!isGpuRack) return true;
    gpuRacks++;
    if (gpuRacks > 8) return false;
    equipment.catalogId = rackId;
    return true;
  });
  const workload = project.workloads.find((item) => item.inference)!;
  const preset = findModelPreset('deepseek-r1')!;
  workload.name = 'DeepSeek-R1 validation';
  workload.presetId = preset.id;
  workload.model = applyModelPreset(workload.model, preset);
  workload.gpuShare = 1;
  workload.inference = {
    requestsPerSec: opts.requestsPerSec ?? 1000,
    inputTokens: 8192,
    outputTokens: 1024,
    ttftSloMs: 1000,
    tpotSloMs,
    disaggregated: opts.disaggregated ?? true,
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

describe('configured-workload inference Pareto sweep', () => {
  for (const [rackId, accelerator] of [
    ['amd-mi355x-dlc-4x', 'Instinct MI355X'],
    ['hgx-b200-air-4x', 'B200'],
    ['hgx-b300-air-4x', 'B300 (Blackwell Ultra)'],
  ] as const) {
    it(`evaluates DeepSeek-R1 on ${accelerator} without mixing benchmark models`, () => {
      const { project, workload } = deepSeekProject(rackId);
      const report = analyzeInferenceWorkloadPareto(project, workload)!;
      // 142, not 256: the sweep now sizes its pool from the analysed share. This fixture leaves the reference
      // project's 0.8-share training blueprint in place and sets this one to 1.0, so Σ gpuShare = 1.8 and every
      // other engine path scales it by 1 / 1.8. Sweeping the raw share made the card claim 256 GPUs while the
      // simulation result printed directly above it used 142.
      expect(report).toMatchObject({ workloadId: workload.id, accelerator, allocatedGpus: 142 });
      expect(report.series.map((series) => series.servingMode)).toEqual(['aggregated', 'disaggregated']);
      for (const series of report.series) {
        expect(series.evaluated).toBeGreaterThan(0);
        expect(series.feasible).toBeGreaterThan(0);
        expect(series.frontier.length).toBeGreaterThan(1);
        for (let index = 1; index < series.frontier.length; index++) {
          expect(series.frontier[index].interactivityTokPerSecPerUser).toBeGreaterThanOrEqual(series.frontier[index - 1].interactivityTokPerSecPerUser);
          expect(series.frontier[index].outputCapacityTokensPerSec).toBeLessThanOrEqual(series.frontier[index - 1].outputCapacityTokensPerSec * (1 + 1e-9));
        }
      }
    });
  }

  it('sizes its pool from the same share the simulation uses', () => {
    const { project, workload } = deepSeekProject('hgx-b200-air-4x');
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const simulated = analyzeProject(project).workloads.find((item) => item.workloadId === workload.id)!;
    // The card renders directly below the simulation result; two different GPU counts for one workload is a
    // contradiction the user cannot resolve from the UI.
    expect(report.allocatedGpus).toBe(simulated.gpus);
  });

  it('keeps an applied calibration on the selected point at an SLO that does not round-trip', () => {
    // 1000 / (1000 / 30) === 29.999999999999996, and inferenceCalibrationSignature pins tpotSloMs by exact
    // equality — so sweeping in interactivity space dropped the calibration on the point representing the user's
    // own configuration, which is the point they are most likely to read off the card.
    expect(1000 / (1000 / 30)).not.toBe(30);
    const { project, workload } = deepSeekProject('hgx-b200-air-4x', 30);
    workload.calibration = {
      mode: 'inference',
      tokensPerSecPerGpu: 500,
      interactivityTokPerSecPerUser: 1000 / 30,
      source: 'test measurement',
      workloadSignature: inferenceCalibrationSignature(workload),
    };
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const selected = report.series.flatMap((series) => series.points).filter((point) => point.selectedTopology);
    expect(selected.length).toBeGreaterThan(0);
    for (const point of selected) expect(point.calibrated).toBe(true);
  });

  it('reports the offered rate its plotted capacity was measured at', () => {
    const { project, workload } = deepSeekProject('hgx-b200-air-4x');
    const report = analyzeInferenceWorkloadPareto(project, workload)!;
    const points = report.series.flatMap((series) => series.points);
    expect(points.length).toBeGreaterThan(0);
    for (const point of points) {
      // The sweep saturates the offered rate to fill the placed pool. The card has to be able to say so rather
      // than implying the plotted capacity is what the configured rate achieves.
      expect(point.configuredRequestsPerSec).toBe(1000);
      expect(point.poolFillRequestsPerSec).toBe(1_000_000);
    }
  });

  it('aggregated capacity does not move with the configured request rate', () => {
    // The sweep saturates the offered rate to fill the placed pool. The aggregated instance search used to give up
    // at a 200,000-iteration guard, so the count the capacity is divided by was set by the loop constant rather
    // than by the hardware — and the plotted capacity then scaled with whatever rate the user had typed. Measured
    // before the fix on this exact fixture: ×2.357 between 1,000 and 3,000,000 req/s, on identical hardware and an
    // identical topology, while the disaggregated frontier was byte-identical.
    const peak = (requestsPerSec: number) => {
      const { project, workload } = deepSeekProject('hgx-b200-air-4x', 40, { disaggregated: false, requestsPerSec });
      const report = analyzeInferenceWorkloadPareto(project, workload)!;
      const series = report.series.find((item) => item.servingMode === 'aggregated')!;
      return Math.max(0, ...series.points.map((point) => point.outputCapacityTokensPerSec));
    };
    const low = peak(1_000);
    const high = peak(3_000_000);
    expect(low).toBeGreaterThan(0);
    // Integer replica counts leave a little discretisation, but the rate must cancel out of the capacity.
    expect(Math.abs(high - low) / low).toBeLessThan(0.001);
  });
});
