import { catalogItems } from '../catalog/catalog.ts';
import { peakFlopsFor } from '../engines/traffic.ts';
import type { CatalogItem, InferenceParallelism, ModelPreset, WorkloadBlueprint } from '../model/types.ts';
import { inferenceReplicaGpus } from './inference.ts';
import { inferenceXHardwareKey, type InferenceXPublicRow } from './inferencex.ts';
import { findModelPreset } from './presets.ts';

export interface InferenceXRegressionDataset {
  presetId: string;
  rows: InferenceXPublicRow[];
}

export interface InferenceXRegressionValidation {
  dimension: 'model' | 'hardware';
  key: string;
  conditions: number;
  medianAbsolutePercentageError: number;
  p90AbsolutePercentageError: number;
}

export interface InferenceXRegressionModel {
  featureNames: string[];
  means: number[];
  scales: number[];
  coefficients: number[];
  targetMean: number;
  conditions: number;
  runs: number;
  variantConditions: number;
  additionalVariants: number;
  implementationMedianError?: number;
  implementationP90Error?: number;
  modelIds: string[];
  hardwareKeys: string[];
  validation: InferenceXRegressionValidation[];
  modelHoldoutMedianError?: number;
  modelHoldoutP90Error?: number;
  hardwareHoldoutMedianError?: number;
  hardwareHoldoutP90Error?: number;
}

export interface InferenceXRegressionTarget {
  workload: WorkloadBlueprint;
  gpuRack: CatalogItem;
  precision: 'fp4' | 'fp8' | 'bf16';
  servingMode: 'aggregated' | 'disaggregated';
  interactivityTokPerSecPerUser: number;
  prefill: InferenceParallelism;
  decode: InferenceParallelism;
  prefillGpus: number;
  decodeGpus: number;
  concurrency: number;
}

export interface InferenceXRegressionPrediction {
  outputTokensPerSecPerGpu: number;
  lowerOutputTokensPerSecPerGpu: number;
  upperOutputTokensPerSecPerGpu: number;
  relativeErrorBand: number;
  modelInTrainingSet: boolean;
  hardwareInTrainingSet: boolean;
  quality: 'cross-validated' | 'high-variance' | 'extrapolated';
}

interface TrainingSample {
  presetId: string;
  hardware: string;
  features: number[];
  /** Measured log throughput minus the physics-derived harmonic roofline. */
  targetResidualLog: number;
  baselineLog: number;
  runs: number;
  /** Capped effective-sample weight: agreeing implementations help, divergent implementations are down-weighted. */
  weight: number;
  implementationLogSigma?: number;
}

const FEATURE_NAMES = [
  'log_peak_tflops', 'log_hbm_gbps', 'log_hbm_gb', 'log_effective_fabric_gbps',
  'log_total_params_b', 'log_active_params_b', 'log_layers', 'log_hidden', 'log_kv_bytes_token_bf16',
  'active_fraction', 'log_experts', 'log_top_k', 'mla',
  'log_isl', 'log_osl', 'log_interactivity', 'log_tp', 'log_ep', 'log_pp', 'log_cp',
  'log_pool_gpus', 'log_concurrency_per_gpu', 'disaggregated', 'attention_dp', 'speculative', 'bytes_per_weight',
  'log_compute_roof_tok_s_gpu', 'log_hbm_roof_tok_s_gpu', 'log_harmonic_roof_tok_s_gpu',
] as const;

const log1 = (value: number) => Math.log(Math.max(1e-9, value));
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const metric = (row: InferenceXPublicRow, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = number(row.metrics?.[key]);
    if (value !== undefined) return value;
  }
  return undefined;
};
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
};

function precisionOf(value: string | undefined): 'fp4' | 'fp8' | 'bf16' | undefined {
  const text = value?.toLowerCase() ?? '';
  if (text.includes('fp4') || text.includes('nvfp4') || text.includes('mxfp4')) return 'fp4';
  if (text.includes('fp8')) return 'fp8';
  if (text.includes('bf16') || text.includes('fp16')) return 'bf16';
  return undefined;
}

function hardwareProfile(hardware: string, precision: 'fp4' | 'fp8' | 'bf16', preferred?: CatalogItem) {
  const key = inferenceXHardwareKey(hardware);
  const candidates = [preferred, ...catalogItems()].filter((item): item is CatalogItem => !!item?.compute
    && inferenceXHardwareKey(item.compute.gpuModel) === key);
  const item = candidates.sort((a, b) => Number(b.category === 'gpu-rack') - Number(a.category === 'gpu-rack'))[0];
  const compute = item?.compute;
  if (!key || !compute?.memBandwidthGBps || !compute.gpuMemoryGB) return undefined;
  return {
    key,
    peakTflops: peakFlopsFor(compute, precision) / 1e12,
    memBandwidthGBps: compute.memBandwidthGBps,
    memoryGB: compute.gpuMemoryGB,
    scaleUpGbps: compute.scaleUp.gbpsPerGpu,
    scaleUpDomain: compute.scaleUp.domainSize,
    scaleOutGbps: compute.scaleOutPortGbps * compute.scaleOutPortsPerGpu,
  };
}

function modelKvBytes(preset: ModelPreset): number {
  if (preset.derived?.kvBytesPerTokenBf16) return preset.derived.kvBytesPerTokenBf16;
  if (preset.mla) return preset.layers * (preset.mla.dLatent + preset.mla.dRope) * 2;
  const headDim = preset.headDim ?? preset.hiddenSize / Math.max(1, preset.numHeads);
  return 2 * preset.layers * preset.kvHeads * headDim * 2;
}

function features(input: {
  preset: ModelPreset;
  hardware: ReturnType<typeof hardwareProfile>;
  precision: 'fp4' | 'fp8' | 'bf16';
  isl: number;
  osl: number;
  interactivity: number;
  tp: number;
  ep: number;
  pp: number;
  cp: number;
  poolGpus: number;
  concurrency: number;
  disaggregated: boolean;
  attentionDp: boolean;
  speculative: boolean;
}): number[] | undefined {
  const h = input.hardware;
  if (!h) return undefined;
  const p = input.preset;
  const experts = p.moe?.experts ?? 1;
  const topK = p.moe?.topK ?? 1;
  const bytes = input.precision === 'fp4' ? 0.5 : input.precision === 'fp8' ? 1 : 2;
  const batchPerGpu = Math.max(1, input.concurrency / Math.max(1, input.poolGpus));
  const effectiveFabricGbps = input.poolGpus <= h.scaleUpDomain ? h.scaleUpGbps : h.scaleOutGbps;
  const computeRoof = (h.peakTflops * 1e12) / Math.max(1, 2 * p.activeParamsB * 1e9);
  const activeWeightGB = Math.min(p.paramsB * bytes, p.activeParamsB * bytes * (1 + 0.1 * Math.log2(1 + batchPerGpu)));
  const hbmRoof = batchPerGpu * h.memBandwidthGBps / Math.max(1e-9, activeWeightGB);
  const harmonicRoof = 1 / (1 / Math.max(1e-9, computeRoof) + 1 / Math.max(1e-9, hbmRoof));
  return [
    log1(h.peakTflops), log1(h.memBandwidthGBps), log1(h.memoryGB), log1(effectiveFabricGbps),
    log1(p.paramsB), log1(p.activeParamsB), log1(p.layers), log1(p.hiddenSize), log1(modelKvBytes(p)),
    p.activeParamsB / Math.max(1e-9, p.paramsB), log1(experts), log1(topK), p.mla ? 1 : 0,
    log1(input.isl), log1(input.osl), log1(input.interactivity), log1(input.tp), log1(input.ep), log1(input.pp), log1(input.cp),
    log1(input.poolGpus), log1(input.concurrency / Math.max(1, input.poolGpus)), input.disaggregated ? 1 : 0,
    input.attentionDp ? 1 : 0, input.speculative ? 1 : 0, bytes,
    log1(computeRoof), log1(hbmRoof), log1(harmonicRoof),
  ];
}

function samplesFrom(datasets: InferenceXRegressionDataset[]): TrainingSample[] {
  const groups = new Map<string, { presetId: string; hardware: string; featureRows: number[][]; targets: number[]; runs: number }>();
  for (const dataset of datasets) {
    const preset = findModelPreset(dataset.presetId);
    if (!preset) continue;
    for (const row of dataset.rows) {
      if (row.benchmark_type && !/single.?turn/i.test(row.benchmark_type)) continue;
      const precision = precisionOf(row.precision);
      const hardware = row.hardware ? hardwareProfile(row.hardware, precision ?? 'fp8') : undefined;
      const rawOutput = metric(row, 'output_tput_per_gpu', 'output_throughput_per_gpu');
      const medianTpot = metric(row, 'median_tpot');
      const interactivity = metric(row, 'median_intvty', 'median_interactivity') ?? (medianTpot && medianTpot > 0 ? 1 / medianTpot : undefined);
      const isl = number(row.isl);
      const osl = number(row.osl);
      if (!precision || !hardware || !rawOutput || !interactivity || !isl || !osl) continue;
      const pGpus = Math.max(0, number(row.num_prefill_gpu) ?? 0);
      const dGpus = Math.max(0, number(row.num_decode_gpu) ?? 0);
      const poolGpus = row.disagg ? pGpus + dGpus : Math.max(pGpus, dGpus);
      if (!(poolGpus > 0)) continue;
      const facilityOutput = row.disagg ? rawOutput * dGpus / poolGpus : rawOutput;
      if (!(facilityOutput > 0)) continue;
      const tp = Math.max(1, number(row.decode_tp ?? row.prefill_tp) ?? 1);
      const ep = Math.max(1, number(row.decode_ep ?? row.prefill_ep) ?? 1);
      const pp = Math.max(1, metric(row, 'pp', 'decode_pp', 'prefill_pp') ?? 1);
      const cp = Math.max(1, metric(row, 'dcp_size', 'pcp_size', 'cp') ?? 1);
      const concurrency = Math.max(1, number(row.conc) ?? facilityOutput * poolGpus / interactivity);
      const vector = features({
        preset, hardware, precision, isl, osl, interactivity, tp, ep, pp, cp, poolGpus, concurrency,
        disaggregated: !!row.disagg,
        attentionDp: !!row.prefill_dp_attention || !!row.decode_dp_attention,
        speculative: !!row.spec_method && row.spec_method.toLowerCase() !== 'none',
      });
      if (!vector) continue;
      // The selected workload has no runtime/container selector. Keep framework and image/recipe variations inside one
      // physical condition and use their spread as implementation uncertainty instead of pretending they add coverage.
      // Offload and worker layout do change the deployed condition and therefore remain in the key.
      const key = [dataset.presetId, hardware.key, precision, row.disagg ? 'pd' : 'agg',
        row.offload_mode ?? 'none', isl, osl, tp, ep, pp, cp, pGpus, dGpus,
        row.prefill_num_workers ?? 0, row.decode_num_workers ?? 0,
        concurrency, row.prefill_dp_attention ? 1 : 0, row.decode_dp_attention ? 1 : 0, row.spec_method ?? 'none'].join('|');
      const group = groups.get(key) ?? { presetId: dataset.presetId, hardware: hardware.key, featureRows: [], targets: [], runs: 0 };
      group.featureRows.push(vector);
      group.targets.push(Math.log(facilityOutput));
      group.runs++;
      groups.set(key, group);
    }
  }
  const summaries = [...groups.values()].map((group) => {
    const featureVector = FEATURE_NAMES.map((_, column) => median(group.featureRows.map((row) => row[column])));
    const targetLog = median(group.targets);
    const deviations = group.targets.map((value) => Math.abs(value - targetLog));
    const implementationLogSigma = group.runs > 1 ? 1.4826 * median(deviations) : undefined;
    return { ...group, featureVector, targetLog, implementationLogSigma };
  });
  const observedSigmas = summaries.flatMap((group) => group.implementationLogSigma != null && group.implementationLogSigma > 0
    ? [group.implementationLogSigma] : []);
  const typicalImplementationSigma = Math.max(0.02, observedSigmas.length ? median(observedSigmas) : 0.05);
  return summaries.map((group) => {
    const stability = group.implementationLogSigma == null
      ? 1
      : Math.min(1, typicalImplementationSigma / Math.max(typicalImplementationSigma, group.implementationLogSigma));
    return {
      presetId: group.presetId,
      hardware: group.hardware,
      features: group.featureVector,
      // The final feature is log(harmonic compute/HBM roofline). Learn only the measured efficiency/overhead
      // residual so an unseen model or accelerator retains a physically meaningful first-order baseline.
      baselineLog: group.featureVector[group.featureVector.length - 1],
      targetResidualLog: group.targetLog - group.featureVector[group.featureVector.length - 1],
      runs: group.runs,
      // Multiple independent implementations that agree are useful, but their influence is capped at 1.5× so a
      // popular benchmark shape cannot dominate the cross-model fit merely because more teams submitted it.
      weight: Math.sqrt(Math.min(2.25, group.runs)) * stability,
      implementationLogSigma: group.implementationLogSigma,
    };
  });
}

function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const augmented = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivot][col])) pivot = row;
    [augmented[col], augmented[pivot]] = [augmented[pivot], augmented[col]];
    const divisor = Math.abs(augmented[col][col]) < 1e-12 ? 1e-12 : augmented[col][col];
    for (let j = col; j <= n; j++) augmented[col][j] /= divisor;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = col; j <= n; j++) augmented[row][j] -= factor * augmented[col][j];
    }
  }
  return augmented.map((row) => row[n]);
}

function fit(samples: TrainingSample[], lambda = 8): Omit<InferenceXRegressionModel,
  'runs' | 'variantConditions' | 'additionalVariants' | 'implementationMedianError' | 'implementationP90Error'
  | 'modelIds' | 'hardwareKeys' | 'validation'> | undefined {
  if (samples.length < 8) return undefined;
  const dimensions = FEATURE_NAMES.length;
  const rawWeightTotal = samples.reduce((sum, sample) => sum + sample.weight, 0);
  const weights = samples.map((sample) => sample.weight * samples.length / Math.max(1e-9, rawWeightTotal));
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const means = Array.from({ length: dimensions }, (_, col) => samples.reduce((sum, sample, index) => sum + weights[index] * sample.features[col], 0) / weightTotal);
  const scales = Array.from({ length: dimensions }, (_, col) => {
    const variance = samples.reduce((sum, sample, index) => sum + weights[index] * (sample.features[col] - means[col]) ** 2, 0) / Math.max(1, weightTotal - 1);
    return Math.max(1e-6, Math.sqrt(variance));
  });
  const targetMean = samples.reduce((sum, sample, index) => sum + weights[index] * sample.targetResidualLog, 0) / weightTotal;
  const matrix = Array.from({ length: dimensions }, () => Array(dimensions).fill(0) as number[]);
  const rhs = Array(dimensions).fill(0) as number[];
  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
    const sample = samples[sampleIndex];
    const weight = weights[sampleIndex];
    const x = sample.features.map((value, col) => (value - means[col]) / scales[col]);
    const y = sample.targetResidualLog - targetMean;
    for (let i = 0; i < dimensions; i++) {
      rhs[i] += weight * x[i] * y;
      for (let j = 0; j < dimensions; j++) matrix[i][j] += weight * x[i] * x[j];
    }
  }
  for (let i = 0; i < dimensions; i++) matrix[i][i] += lambda;
  return { featureNames: [...FEATURE_NAMES], means, scales, coefficients: solve(matrix, rhs), targetMean, conditions: samples.length };
}

function predictResidualLog(model: Pick<InferenceXRegressionModel, 'means' | 'scales' | 'coefficients' | 'targetMean'>, vector: number[]): number {
  return model.targetMean + vector.reduce((sum, value, index) => sum + ((value - model.means[index]) / model.scales[index]) * model.coefficients[index], 0);
}

function validationFor(samples: TrainingSample[], dimension: 'model' | 'hardware'): InferenceXRegressionValidation[] {
  const keys = [...new Set(samples.map((sample) => dimension === 'model' ? sample.presetId : sample.hardware))];
  const out: InferenceXRegressionValidation[] = [];
  for (const key of keys) {
    const train = samples.filter((sample) => (dimension === 'model' ? sample.presetId : sample.hardware) !== key);
    const held = samples.filter((sample) => (dimension === 'model' ? sample.presetId : sample.hardware) === key);
    const model = fit(train);
    if (!model || !held.length) continue;
    const errors = held.map((sample) => {
      const predicted = Math.exp(sample.baselineLog + predictResidualLog(model, sample.features));
      const measured = Math.exp(sample.baselineLog + sample.targetResidualLog);
      return Math.abs(predicted - measured) / measured;
    });
    out.push({
      dimension, key, conditions: held.length,
      medianAbsolutePercentageError: median(errors),
      p90AbsolutePercentageError: quantile(errors, 0.9),
    });
  }
  return out;
}

/** Fit one cross-model, cross-accelerator roofline-residual ridge model and retain honest leave-one-domain-out errors. */
export function fitInferenceXRegression(datasets: InferenceXRegressionDataset[]): InferenceXRegressionModel | undefined {
  const samples = samplesFrom(datasets);
  const trained = fit(samples);
  if (!trained) return undefined;
  const validation = [...validationFor(samples, 'model'), ...validationFor(samples, 'hardware')];
  const modelErrors = validation.filter((item) => item.dimension === 'model').flatMap((item) => [item.medianAbsolutePercentageError]);
  const modelP90 = validation.filter((item) => item.dimension === 'model').flatMap((item) => [item.p90AbsolutePercentageError]);
  const hardwareErrors = validation.filter((item) => item.dimension === 'hardware').flatMap((item) => [item.medianAbsolutePercentageError]);
  const hardwareP90 = validation.filter((item) => item.dimension === 'hardware').flatMap((item) => [item.p90AbsolutePercentageError]);
  const implementationErrors = samples.flatMap((sample) => sample.implementationLogSigma == null ? [] : [Math.exp(sample.implementationLogSigma) - 1]);
  const runs = samples.reduce((sum, sample) => sum + sample.runs, 0);
  return {
    ...trained,
    runs,
    variantConditions: samples.filter((sample) => sample.runs > 1).length,
    additionalVariants: runs - samples.length,
    implementationMedianError: implementationErrors.length ? median(implementationErrors) : undefined,
    implementationP90Error: implementationErrors.length ? quantile(implementationErrors, 0.9) : undefined,
    modelIds: [...new Set(samples.map((sample) => sample.presetId))].sort(),
    hardwareKeys: [...new Set(samples.map((sample) => sample.hardware))].sort(),
    validation,
    modelHoldoutMedianError: modelErrors.length ? median(modelErrors) : undefined,
    modelHoldoutP90Error: modelP90.length ? median(modelP90) : undefined,
    hardwareHoldoutMedianError: hardwareErrors.length ? median(hardwareErrors) : undefined,
    hardwareHoldoutP90Error: hardwareP90.length ? median(hardwareP90) : undefined,
  };
}

export function predictInferenceXRegression(model: InferenceXRegressionModel, target: InferenceXRegressionTarget): InferenceXRegressionPrediction | undefined {
  const preset = target.workload.presetId ? findModelPreset(target.workload.presetId) : undefined;
  const hardware = hardwareProfile(target.gpuRack.compute?.gpuModel ?? '', target.precision, target.gpuRack);
  if (!preset || !hardware) return undefined;
  const pGpus = Math.max(0, target.prefillGpus);
  const dGpus = Math.max(1, target.decodeGpus);
  const poolGpus = target.servingMode === 'disaggregated' ? pGpus + dGpus : dGpus;
  const vector = features({
    preset, hardware, precision: target.precision,
    isl: target.workload.inference?.inputTokens ?? 1,
    osl: target.workload.inference?.outputTokens ?? 1,
    interactivity: target.interactivityTokPerSecPerUser,
    tp: target.decode.tp, ep: target.decode.ep, pp: target.decode.pp, cp: target.decode.cp,
    poolGpus, concurrency: Math.max(1, target.concurrency),
    disaggregated: target.servingMode === 'disaggregated',
    attentionDp: false, speculative: false,
  });
  if (!vector) return undefined;
  const baselineLog = vector[vector.length - 1];
  const predicted = Math.exp(baselineLog + predictResidualLog(model, vector));
  const modelInTrainingSet = model.modelIds.includes(preset.id);
  const hardwareInTrainingSet = model.hardwareKeys.includes(hardware.key);
  const errors = [model.modelHoldoutP90Error, model.implementationP90Error, hardwareInTrainingSet ? undefined : model.hardwareHoldoutP90Error]
    .filter((value): value is number => value != null && Number.isFinite(value));
  const relativeErrorBand = Math.max(0.25, ...errors);
  const quality = !modelInTrainingSet || !hardwareInTrainingSet ? 'extrapolated'
    : relativeErrorBand > 1 ? 'high-variance'
      : 'cross-validated';
  return {
    outputTokensPerSecPerGpu: predicted,
    lowerOutputTokensPerSecPerGpu: predicted / (1 + relativeErrorBand),
    upperOutputTokensPerSecPerGpu: predicted * (1 + relativeErrorBand),
    relativeErrorBand,
    modelInTrainingSet,
    hardwareInTrainingSet,
    quality,
  };
}
