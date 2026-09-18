import { describe, expect, it } from 'vitest';
import { applyModelPreset, findCatalogItem, findModelPreset, fitInferenceXRegression, inferenceXApiUrl, inferenceXHardwareKey, inferenceXModelName, inferenceXPerformanceCurves, inferenceXPredictionBenchmark, inferenceXRowsFromMcp, predictInferenceXPerformance, predictInferenceXRegression, rankInferenceXBenchmarks, rankInferenceXCacheBenchmarks, type InferenceXPublicRow, type WorkloadBlueprint } from '../src/index.ts';

const workload: WorkloadBlueprint = {
  id: 'ix', name: 'Kimi serving', kind: 'llm-inference', gpuShare: 1, durationDays: 1, presetId: 'kimi-k2.5',
  model: { name: 'Kimi K2.5', paramsB: 1000, activeParamsB: 32, layers: 61, hiddenSize: 7168, seqLen: 262144 },
  inference: {
    requestsPerSec: 100, inputTokens: 8192, outputTokens: 1024, ttftSloMs: 1500, tpotSloMs: 40,
    disaggregated: false, weightPrecision: 'fp4', kvPrecision: 'fp8', parallelism: { tp: 4, pp: 1, ep: 4, cp: 1 },
  },
};

const row = (id: string, output: number, p99Tpot: number, overrides: Partial<InferenceXPublicRow> = {}): InferenceXPublicRow => ({
  id, hardware: 'mi355x', framework: 'vllm', model: 'kimik2.5', precision: 'int4', disagg: false,
  prefill_tp: 4, prefill_ep: 4, decode_tp: 4, decode_ep: 4, num_prefill_gpu: 16, num_decode_gpu: 16,
  benchmark_type: 'single_turn', isl: 8192, osl: 1024, conc: 32, date: '2026-08-07', run_url: `https://example.test/${id}`,
  metrics: { output_tput_per_gpu: output, tput_per_gpu: output * 4, median_tpot: p99Tpot / 2, p99_tpot: p99Tpot, median_ttft: 0.2, p99_ttft: 0.8, median_intvty: 50 },
  ...overrides,
});

describe('InferenceX public API adapter', () => {
  it('maps only exact local model generations and known accelerator names', () => {
    expect(inferenceXModelName('kimi-k2.5')).toBe('Kimi-K2.5');
    expect(inferenceXModelName('kimi-k2')).toBeUndefined();
    expect(inferenceXHardwareKey('Instinct MI355X')).toBe('mi355x');
    expect(inferenceXHardwareKey('HGX B200 8-GPU')).toBe('b200');
    expect(inferenceXHardwareKey('B300 (Blackwell Ultra)')).toBe('b300');
    expect(inferenceXHardwareKey('Blackwell (GB300)')).toBe('gb300');
    expect(inferenceXApiUrl('GLM-5.2', 'agentic-traces')).toContain('view=calculator&sequence=agentic-traces');
  });

  it('normalises flattened MCP results and restores filtered fields', () => {
    const rows = inferenceXRowsFromMcp({
      filters: { hardware: 'mi355x', model: 'kimik2.5', precision: 'int4', disagg: false },
      rows: [{ framework: 'vllm', isl: 8192, osl: 1024, conc: 32, decode_tp: 4, decode_ep: 4, num_decode_gpu: 16, output_tput_per_gpu: 912.5, median_tpot: 0.02, date: '2026-08-01' }],
    }, 'Kimi-K2.5');
    expect(rows[0]).toMatchObject({ hardware: 'mi355x', model: 'Kimi-K2.5', precision: 'int4', decode_tp: 4, decode_ep: 4 });
    expect(rows[0].metrics).toMatchObject({ output_tput_per_gpu: 912.5, median_tpot: 0.02 });
  });

  it('ranks SLO-compatible matched rows ahead of a larger but incompatible throughput point', () => {
    const rack = findCatalogItem('amd-mi355x-dlc-4x')!;
    const rows = rankInferenceXBenchmarks([row('too-slow', 5000, 0.1), row('fit', 900, 0.02), row('other-hw', 1200, 0.02, { hardware: 'b300' })], {
      presetId: workload.presetId, gpuRack: rack, inference: workload.inference!,
    });
    expect(rows.map((x) => x.id)).toEqual(['ix-live-fit', 'ix-live-other-hw', 'ix-live-too-slow']);
    expect(rows[0]).toMatchObject({ accelerators: 16, accelerator: 'AMD Instinct MI355X', model: 'kimi-k2.5', precision: 'INT4' });
    expect(rows[0].derived?.outputTokensPerSecPerGpu).toBe(900);
  });

  it('keeps AgentX cache tiers and concurrency as a separate trace calibration', () => {
    const rack = findCatalogItem('amd-mi355x-dlc-4x')!;
    const agentic: InferenceXPublicRow = {
      id: 441517, hardware: 'mi355x', framework: 'sglang', model: 'Kimi-K2.5', precision: 'fp4',
      disagg: false, benchmark_type: 'agentic_traces', conc: 32, date: '2026-08-08', offload_mode: 'on',
      metrics: {
        server_gpu_cache_hit_rate: 0.28635,
        server_cpu_cache_hit_rate: 0.66811,
        server_external_cache_hit_rate: 0.65764,
        theoretical_cache_hit_rate: 0.97982,
        output_tput_per_gpu: 17.31,
      },
    };
    const traces = rankInferenceXCacheBenchmarks([row('single', 100, 0.02), agentic], { presetId: workload.presetId, gpuRack: rack, inference: workload.inference! });
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ benchmarkId: 'ix-agentx-441517', concurrency: 32, gpuHitRate: 0.28635, cpuHitRate: 0.66811, externalHitRate: 0.65764, offloadMode: 'on' });
  });

  it('predicts each GPU only from comparable measured conditions and validates by held-out condition', () => {
    const rack = findCatalogItem('amd-mi355x-dlc-4x')!;
    const measured = (id: string, hardware: string, isl: number, output: number, overrides: Partial<InferenceXPublicRow> = {}): InferenceXPublicRow => row(id, output, 0.04, {
      model: 'Kimi-K2.5', hardware, isl, framework: id.startsWith('sg') ? 'sglang' : 'vllm',
      metrics: { output_tput_per_gpu: output, median_tpot: 0.04, median_ttft: 0.2, p99_tpot: 0.04, p99_ttft: 0.8 },
      ...overrides,
    });
    const report = predictInferenceXPerformance([
      measured('mi-a', 'mi355x', 4096, 1000),
      measured('mi-a-repeat', 'mi355x', 4096, 1100), // same condition: one validation group
      measured('sg-mi-b', 'mi355x', 8192, 900, { conc: 64 }),
      measured('mi-c', 'mi355x', 16384, 700, { conc: 96 }),
      measured('b-a', 'b300', 4096, 1400),
      measured('sg-b-b', 'b300', 8192, 1200, { conc: 64 }),
      measured('b-c', 'b300', 16384, 950, { conc: 96 }),
      measured('wrong-precision', 'h200', 8192, 800, { precision: 'fp8' }),
      measured('wrong-mode', 'mi355x', 8192, 5000, { disagg: true, conc: 128 }),
    ], { presetId: workload.presetId, gpuRack: rack, inference: workload.inference! })!;

    expect(report.model).toBe('Kimi-K2.5');
    expect(report.predictions[0].hardware).toBe('mi355x');
    expect(report.predictions[0].conditionGroups).toBe(3);
    expect(report.predictions[0].measuredRows).toBe(4);
    expect(report.predictions[0].validationCases).toBe(3);
    expect(report.predictions[0].predictedOutputTokensPerSecPerGpu).toBeGreaterThan(700);
    expect(report.predictions[0].predictedOutputTokensPerSecPerGpu).toBeLessThan(1100);
    expect(report.predictions.find((x) => x.hardware === 'b300')?.validationCases).toBe(3);
    expect(report.predictions.find((x) => x.hardware === 'h200')).toMatchObject({ quality: 'unavailable', conditionGroups: 0 });
  });

  it('turns a validated placed-GPU estimate into an explicitly derived calibration row', () => {
    const rack = findCatalogItem('amd-mi355x-dlc-4x')!;
    const rows = [4096, 8192, 16384].map((isl, index): InferenceXPublicRow => row(`p${index}`, 1200 - index * 150, 0.04, {
      model: 'Kimi-K2.5', isl, conc: 16 * (index + 1),
      metrics: { output_tput_per_gpu: 1200 - index * 150, median_tpot: 0.04, p99_tpot: 0.04, median_ttft: 0.2, p99_ttft: 0.8 },
    }));
    const report = predictInferenceXPerformance(rows, { presetId: workload.presetId, gpuRack: rack, inference: workload.inference! })!;
    const prediction = report.predictions.find((x) => x.placedHardware)!;
    const benchmark = inferenceXPredictionBenchmark(report, prediction, workload.presetId!)!;
    expect(benchmark).toMatchObject({ sourceType: 'derived', accelerator: 'AMD Instinct MI355X', unit: 'output tokens/s/GPU' });
    expect(benchmark.notes).toContain('SemiAnalysis InferenceX');
    expect(benchmark.derived?.outputTokensPerSecPerGpu).toBe(prediction.predictedOutputTokensPerSecPerGpu);
  });

  it('builds separate measured aggregated and P/D Pareto envelopes', () => {
    const rack = findCatalogItem('amd-mi355x-dlc-4x')!;
    const point = (id: string, interactivity: number, output: number, power: number, overrides: Partial<InferenceXPublicRow> = {}): InferenceXPublicRow => row(id, output, 1 / interactivity, {
      model: 'Kimi-K2.5',
      conc: interactivity,
      metrics: { output_tput_per_gpu: output, median_intvty: interactivity, avg_power_w: power, power_valid: 1 },
      ...overrides,
    });
    const report = inferenceXPerformanceCurves([
      point('agg-balanced', 10, 1000, 1000),
      point('agg-efficient', 20, 800, 400),
      point('agg-dominated', 15, 700, 500),
      point('agg-no-valid-power', 30, 500, 500, { metrics: { output_tput_per_gpu: 500, median_intvty: 30, avg_power_w: 500, power_valid: 0 } }),
      point('pd-throughput', 12, 1200, 800, { disagg: true, num_prefill_gpu: 8, num_decode_gpu: 16 }),
      point('pd-other-prefill-topology', 12, 1100, 800, { disagg: true, prefill_tp: 8, num_prefill_gpu: 8, num_decode_gpu: 16 }),
      point('pd-fast', 25, 750, 375, { disagg: true, num_prefill_gpu: 8, num_decode_gpu: 8 }),
      point('wrong-precision', 40, 5000, 100, { precision: 'fp8' }),
      point('wrong-hardware', 40, 5000, 100, { hardware: 'b300' }),
    ], { presetId: workload.presetId, gpuRack: rack, inference: workload.inference!, targetAccelerators: 64 })!;

    expect(report).toMatchObject({ model: 'Kimi-K2.5', hardware: 'mi355x', precision: 'fp4', targetAccelerators: 64, directlyComparable: true });
    const aggregated = report.curves.find((curve) => curve.servingMode === 'aggregated')!;
    const disaggregated = report.curves.find((curve) => curve.servingMode === 'disaggregated')!;
    expect(aggregated.measuredPoints).toHaveLength(4);
    expect(aggregated.throughputFrontier.map((point) => point.outputTokensPerSecPerGpu)).toEqual([1000, 800, 500]);
    expect(aggregated.efficiencyFrontier).toHaveLength(1);
    expect(aggregated.efficiencyFrontier[0].outputTokensPerSecPerMW).toBe(2_000_000);
    expect(disaggregated.measuredPoints).toHaveLength(3);
    expect(disaggregated.throughputFrontier).toHaveLength(2);
    expect(disaggregated.clusterFrontier).toHaveLength(2);
    expect(disaggregated.measuredPoints[0]).toMatchObject({
      servingMode: 'disaggregated', prefillGpus: 8, decodeGpus: 16, deploymentGpus: 24,
      deploymentCopies: 2, placedGpus: 48, idleGpus: 16,
      decodeOutputTokensPerSecPerGpu: 1200, measuredOutputTokensPerSec: 19200,
      outputTokensPerSecPerGpu: 800, projectedClusterOutputTokensPerSec: 38400,
    });
    expect(report.sweepAxes).toMatchObject({
      prefillTp: [4, 8], prefillEp: [4], prefillDpAttention: [false], prefillGpuCounts: [8, 16],
      decodeTp: [4], decodeEp: [4], decodeDpAttention: [false], decodeGpuCounts: [8, 16], specMethods: ['none'],
    });
  });

  it('fits a cross-model/cross-accelerator regression and reports domain holdout errors', () => {
    const models = [
      { presetId: 'deepseek-r1', api: 'DeepSeek-R1-0528', scale: 0.8 },
      { presetId: 'gpt-oss-120b', api: 'gptoss120b', scale: 1.5 },
      { presetId: 'kimi-k2.5', api: 'kimik2.5', scale: 1.0 },
    ];
    const hardware = [
      { key: 'mi355x', scale: 1.0 },
      { key: 'b200', scale: 0.9 },
      { key: 'b300', scale: 1.2 },
    ];
    const datasets = models.map((model) => ({
      presetId: model.presetId,
      rows: hardware.flatMap((gpu) => [16, 32, 64].map((conc, index): InferenceXPublicRow => row(`${model.presetId}-${gpu.key}-${conc}`, model.scale * gpu.scale * (800 + conc * 4), 0.04, {
        model: model.api, hardware: gpu.key, precision: 'fp4', conc, isl: 4096 * (index + 1),
        metrics: { output_tput_per_gpu: model.scale * gpu.scale * (800 + conc * 4), median_tpot: 0.04, median_intvty: 25 + index * 10 },
      }))),
    }));
    // Same physical condition, different runtime/container implementation: stabilise the target and measure its
    // implementation spread, but do not count it as new model/topology coverage.
    datasets[0].rows.push(row('deepseek-r1-mi355x-16-runtime-variant', 760, 0.04, {
      model: 'DeepSeek-R1-0528', hardware: 'mi355x', precision: 'fp4', conc: 16, isl: 4096,
      framework: 'sglang', image: 'example/sglang:variant',
      metrics: { output_tput_per_gpu: 760, median_tpot: 0.04, median_intvty: 25 },
    }));
    const regression = fitInferenceXRegression(datasets)!;
    expect(regression).toMatchObject({
      conditions: 27, runs: 28, variantConditions: 1, additionalVariants: 1,
      modelIds: ['deepseek-r1', 'gpt-oss-120b', 'kimi-k2.5'], hardwareKeys: ['b200', 'b300', 'mi355x'],
    });
    expect(regression.implementationMedianError).toBeGreaterThan(0);
    expect(regression.implementationP90Error).toBeGreaterThan(0);
    expect(regression.validation.filter((item) => item.dimension === 'model')).toHaveLength(3);
    expect(regression.validation.filter((item) => item.dimension === 'hardware')).toHaveLength(3);
    const prediction = predictInferenceXRegression(regression, {
      workload,
      gpuRack: findCatalogItem('amd-mi355x-dlc-4x')!,
      precision: 'fp4',
      servingMode: 'aggregated',
      interactivityTokPerSecPerUser: 25,
      prefill: workload.inference!.parallelism!, decode: workload.inference!.parallelism!,
      prefillGpus: 0, decodeGpus: 16, concurrency: 32,
    })!;
    expect(prediction.outputTokensPerSecPerGpu).toBeGreaterThan(0);
    expect(prediction.lowerOutputTokensPerSecPerGpu).toBeLessThan(prediction.outputTokensPerSecPerGpu);
    expect(prediction.upperOutputTokensPerSecPerGpu).toBeGreaterThan(prediction.outputTokensPerSecPerGpu);
    expect(prediction).toMatchObject({ modelInTrainingSet: true, hardwareInTrainingSet: true });

    const unseenPreset = findModelPreset('kimi-k2')!;
    const unseenWorkload: WorkloadBlueprint = {
      ...workload,
      presetId: unseenPreset.id,
      model: applyModelPreset(workload.model, unseenPreset),
    };
    const extrapolated = predictInferenceXRegression(regression, {
      workload: unseenWorkload,
      gpuRack: findCatalogItem('amd-mi355x-dlc-4x')!,
      precision: 'fp4',
      servingMode: 'aggregated',
      interactivityTokPerSecPerUser: 25,
      prefill: workload.inference!.parallelism!, decode: workload.inference!.parallelism!,
      prefillGpus: 0, decodeGpus: 16, concurrency: 32,
    })!;
    expect(extrapolated.outputTokensPerSecPerGpu).toBeGreaterThan(0);
    expect(extrapolated).toMatchObject({ modelInTrainingSet: false, hardwareInTrainingSet: true, quality: 'extrapolated' });
  });
});
