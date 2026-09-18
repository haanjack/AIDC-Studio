import { describe, expect, it } from 'vitest';
import {
  analyzeInferenceWorkloadPareto,
  applyModelPreset,
  createNvidiaReferenceProject,
  findCatalogItem,
  findModelPreset,
} from '../src/index.ts';

function deepSeekProject(rackId: string) {
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

describe('configured-workload inference Pareto sweep', () => {
  for (const [rackId, accelerator] of [
    ['amd-mi355x-dlc-4x', 'Instinct MI355X'],
    ['hgx-b200-air-4x', 'B200'],
    ['hgx-b300-air-4x', 'B300 (Blackwell Ultra)'],
  ] as const) {
    it(`evaluates DeepSeek-R1 on ${accelerator} without mixing benchmark models`, () => {
      const { project, workload } = deepSeekProject(rackId);
      const report = analyzeInferenceWorkloadPareto(project, workload)!;
      expect(report).toMatchObject({ workloadId: workload.id, accelerator, allocatedGpus: 256 });
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
});
