// T6 (v2 2차, DECISIONS-v2-2 F9): GPU shares, model presets, benchmark calibration.
import { describe, expect, it } from 'vitest';
import {
  MLPERF_NOTICE,
  acceleratorPeakSource, analyzeProject, applyModelPreset, BENCHMARKS, calibrateFromBenchmark, calibrationRecord, createNvidiaReferenceProject, fillRemainder,
  findBenchmark, findCatalogItem, findModelPreset, gpuShareTotal, inferenceMemoryEstimate, MODEL_PRESETS, normalizeShares, peakFlopsFor, presetModelFields,
  modelParallelGroupGpus, presetModifiedFields, scaleWarning, shareIssues, shareState, takeShare, takeShareDetailed, trainingFlopsPerToken,
  type WorkloadBlueprint,
} from '../src/index.ts';

const bp = (id: string, gpuShare: number, tp = 8, pp = 1): WorkloadBlueprint => ({
  id, name: id, kind: 'llm-pretrain', gpuShare, durationDays: 1,
  model: { name: id, paramsB: 70, activeParamsB: 70, layers: 80, hiddenSize: 8192, seqLen: 8192 },
  training: { tokensB: 1, globalBatchTokensM: 4, precision: 'bf16', tp, pp, ep: 1, checkpointEveryMin: 30, checkpointDurationS: 60, mtbfHoursPerGpu: 50000 },
});
const shares = (ws: WorkloadBlueprint[]) => ws.map((w) => Number(w.gpuShare.toFixed(3)));

describe('inference memory-first TP sizing', () => {
  const inference = (weightPrecision: 'fp8' | 'bf16'): WorkloadBlueprint => ({
    id: 'mem', name: '70B serving', kind: 'llm-inference', gpuShare: 1, durationDays: 1,
    model: { name: '70B', paramsB: 70, activeParamsB: 70, layers: 80, hiddenSize: 8192, seqLen: 8192, numHeads: 64, kvHeads: 8, headDim: 128 },
    inference: { requestsPerSec: 100, inputTokens: 4096, outputTokens: 512, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: false, weightPrecision, kvPrecision: 'fp8', parallelism: { tp: 1, pp: 1, ep: 1, cp: 1 } },
  });

  it('derives the minimum TP from weight + one-sequence KV memory, independent of RPS', () => {
    const fp8 = inference('fp8');
    const plan = inferenceMemoryEstimate(fp8, 'aggregated', fp8.inference!.parallelism!, 80, 8)!;
    expect(plan).toMatchObject({ fits: false, minimumTp: 2, crossesScaleUp: false, weightPrecision: 'fp8', gpuMemoryGB: 80, hbmUtilization: 0.9, usableHbmGB: 72 });
    const fitted = inferenceMemoryEstimate(fp8, 'aggregated', { tp: 2, pp: 1, ep: 1, cp: 1 }, 80, 8)!;
    expect(fitted.fits).toBe(true);
    fp8.inference!.requestsPerSec = 100_000;
    expect(inferenceMemoryEstimate(fp8, 'aggregated', fp8.inference!.parallelism!, 80, 8)!.minimumTp).toBe(2);
    expect(inferenceMemoryEstimate(inference('bf16'), 'aggregated', { tp: 1, pp: 1, ep: 1, cp: 1 }, 80, 8)!.minimumTp).toBe(4);
  });

  it('flags a memory minimum that crosses the scale-up domain instead of hiding the network cost', () => {
    const w = inference('bf16');
    w.model.paramsB = 405;
    w.model.activeParamsB = 405;
    w.model.numHeads = 128;
    w.model.kvHeads = 8;
    expect(inferenceMemoryEstimate(w, 'aggregated', { tp: 1, pp: 1, ep: 1, cp: 1 }, 80, 8)).toMatchObject({ minimumTp: 16, crossesScaleUp: true });
  });

  it('reports the true head-compatible capacity floor rather than forcing a power-of-two TP', () => {
    const w = inference('bf16');
    w.model.paramsB = 145;
    w.model.activeParamsB = 145;
    w.model.numHeads = 40;
    w.model.kvHeads = 8;
    expect(inferenceMemoryEstimate(w, 'aggregated', { tp: 1, pp: 1, ep: 1, cp: 1 }, 80, 8)).toMatchObject({ minimumTp: 5 });
  });
});

describe('GPU shares (r2-models.md §5)', () => {
  it('total, state and proportional normalisation', () => {
    const ws = [bp('a', 0.6), bp('b', 0.4), bp('c', 0.2)];
    expect(gpuShareTotal(ws)).toBeCloseTo(1.2, 12);
    expect(shareState(ws)).toMatchObject({ state: 'over', idle: 0 });
    const n = normalizeShares(ws);
    expect(shares(n)).toEqual([0.5, 0.333, 0.167]);
    expect(gpuShareTotal(n)).toBeCloseTo(1, 12);
    expect(ws[0].gpuShare).toBe(0.6); // input untouched
    const under = [bp('a', 0.5), bp('b', 0.2)];
    expect(normalizeShares(under)).toBe(under); // S ≤ 1: nothing to normalise
    expect(shareState(under)).toMatchObject({ state: 'unallocated' });
    expect(shareState(under).idle).toBeCloseTo(0.3, 12);
    expect(shareState([bp('a', 0.7), bp('b', 0.3)]).state).toBe('ok');
  });

  it('take-from-others: proportional donors (worked example)', () => {
    const ws = [bp('a', 0.5), bp('b', 0.3), bp('c', 0.2)];
    const r = takeShareDetailed(ws, 'b', 0.6);
    expect(shares(r.workloads)).toEqual([0.286, 0.6, 0.114]);
    expect(r.capped).toBe(false);
    expect(gpuShareTotal(r.workloads)).toBeCloseTo(1, 12);
  });

  it('take-from-others: idle GPUs first, donors clamped at one model-parallel group, capped warning', () => {
    // idle 0.2 covers the request without touching the donors
    const idle = [bp('a', 0.5), bp('b', 0.3)];
    expect(shares(takeShare(idle, 'b', 0.5))).toEqual([0.5, 0.5]);
    // TP8 on an 80-GPU cluster → minimum share 0.1 per donor
    const ws = [bp('a', 0.5), bp('b', 0.3), bp('c', 0.2)];
    const r = takeShareDetailed(ws, 'b', 0.9, { clusterGpus: 80 });
    expect(shares(r.workloads)).toEqual([0.1, 0.8, 0.1]);
    expect(r.capped).toBe(true);
    expect(r.shortfall).toBeCloseTo(0.1, 9);
  });

  it('fill remainder = 1 − others', () => {
    const ws = [bp('a', 0.5), bp('b', 0.1), bp('c', 0.2)];
    expect(shares(fillRemainder(ws, 'b'))).toEqual([0.5, 0.3, 0.2]);
  });

  it('over-allocation: analysis scales shares proportionally and raises workload-share-over', () => {
    // the reference stores 0.8 / 0.2 since v2 2차 integration; over-allocate it explicitly (pretrain 1.0 + inference 0.25)
    const ref = createNvidiaReferenceProject().project;
    expect(gpuShareTotal(ref.workloads)).toBeCloseTo(1, 12);
    const project = { ...ref, workloads: ref.workloads.map((w) => ({ ...w, gpuShare: w.id === 'wl-pretrain-405b' ? 1 : 0.25 })) };
    expect(gpuShareTotal(project.workloads)).toBeCloseTo(1.25, 12);
    expect(shareIssues(project.workloads).map((i) => i.id)).toEqual(['workload-share-over']);
    const a = analyzeProject(project);
    expect(a.issues.find((i) => i.id === 'workload-share-over')?.severity).toBe('warning');
    const gpus = a.summary.gpus;
    const train = a.workloads.find((w) => w.workloadId === 'wl-pretrain-405b')!;
    const tpp = 8 * 4;
    expect(train.gpus).toBe(Math.floor((gpus * (1 / 1.25)) / tpp) * tpp);
    // the Network panel is a concurrent aggregate, while the workload keeps a private report on the same scaled share
    expect(a.network.traffic).toMatchObject({ mode: 'aggregate', basis: 'aggregate-second' });
    expect(train.details?.stepModel).toBe('traffic-v2');
    const infer = a.workloads.find((w) => w.workloadId === 'wl-infer-moe')!;
    expect(infer.gpus).toBe(Math.floor(gpus * (0.25 / 1.25)));
    expect(train.notesEn?.[0]).toMatch(/scaled 80\.0 %/);
    // normalised project: no warning, same GPUs
    const b = analyzeProject({ ...project, workloads: normalizeShares(project.workloads) });
    expect(b.issues.some((i) => i.id === 'workload-share-over')).toBe(false);
    expect(b.workloads.find((w) => w.workloadId === 'wl-pretrain-405b')!.gpus).toBe(train.gpus);
  });
});

describe('model presets (self-contained dataset, citations re-sourced in N2b)', () => {
  it('presets and benchmarks carry public citations only (no mirrors, no private notes) and MLPerf® attribution', () => {
    expect(MODEL_PRESETS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(MODEL_PRESETS.map((p) => p.id)).size).toBe(MODEL_PRESETS.length);
    expect(new Set(BENCHMARKS.map((b) => b.id)).size).toBe(BENCHMARKS.length);
    for (const p of MODEL_PRESETS) {
      for (const u of [p.sourceUrl, p.cardUrl, p.archSourceUrl].filter(Boolean) as string[]) {
        expect(u, p.id).toMatch(/^https:\/\//);
        expect(u, p.id).not.toMatch(/unsloth|docs\/research/);
      }
    }
    for (const id of ['llama4-maverick', 'llama4-scout']) expect(findModelPreset(id)!.archSourceUrl, id).toMatch(/^https:\/\/huggingface\.co\/meta-llama\//);
    for (const b of BENCHMARKS) {
      expect(b.sourceUrl, b.id).toMatch(/^https:\/\//);
      if (/MLPerf/.test(b.suite)) {
        expect(b.suite, b.id).toContain('MLPerf®');
        expect(b.retrieved, b.id).toBe('2026-09-15');
        expect(b.notes ?? '', b.id).toContain('not verified by MLCommons Association');
      }
    }
    expect(findBenchmark('mlperf-t60-llama405b-gb300-512-eth')!.resultId).toBe('6.0-0013');
    expect(findBenchmark('mlperf-t60-dsv3-gb300-512')!.resultId).toBe('6.0-0102');
    expect(MLPERF_NOTICE.trademark).toContain('registered trademark of MLCommons Association');
  });

  it('preset → blueprint fields carry head_dim and the attention pattern', () => {
    expect(presetModelFields(findModelPreset('qwen3-235b-a22b')!)).toMatchObject({ headDim: 128, numHeads: 64, kvHeads: 4, moe: { experts: 128, topK: 8 } });
    expect(presetModelFields(findModelPreset('gpt-oss-120b')!)).toMatchObject({ headDim: 64, attentionWindow: 128, globalLayerInterval: 2 });
    expect(presetModelFields(findModelPreset('gemma-3-27b')!)).toMatchObject({ headDim: 128, attentionWindow: 1024, globalLayerInterval: 6 });
    expect(presetModelFields(findModelPreset('llama4-maverick')!)).toMatchObject({ attentionWindow: 8192, globalLayerInterval: 4, moe: { experts: 128, topK: 1, shared: 1, moeLayerInterval: 2 } });
    expect(presetModelFields(findModelPreset('glm-4.5')!)).toMatchObject({ headDim: 128, moe: { shared: 1, denseLayers: 3 } });
    expect(presetModelFields(findModelPreset('deepseek-v3')!)).toMatchObject({ mla: { dLatent: 512, dRope: 64 }, moe: { nodeLimit: 4, denseLayers: 3 } });
    expect(presetModelFields(findModelPreset('deepseek-v4-pro')!)).toMatchObject({ headDim: 512, kvHeads: 1, moe: { experts: 384, topK: 6 } });
    expect(presetModelFields(findModelPreset('deepseek-v4-pro')!).moe?.nodeLimit).toBeUndefined();
    expect(presetModelFields(findModelPreset('kimi-k3')!)).toMatchObject({ kvCacheLayerFraction: 24 / 93, mla: { dLatent: 512, dRope: 64 }, moe: { experts: 896, topK: 16, shared: 2 } });
    expect(presetModelFields(findModelPreset('qwen3.5-122b-a10b')!)).toMatchObject({ kvCacheLayerFraction: 0.25, headDim: 256, moe: { experts: 256, topK: 8, shared: 1 } });
    expect(presetModelFields(findModelPreset('llama3.1-405b')!).moe).toBeUndefined();
  });

  it('editing a filled field marks the preset as modified', () => {
    const p = findModelPreset('qwen3-235b-a22b')!;
    const w = { ...bp('q', 1), presetId: p.id };
    w.model = applyModelPreset({ ...w.model, seqLen: 4096 }, p);
    expect(w.model.seqLen).toBe(4096);
    expect(presetModifiedFields(w)).toEqual([]);
    expect(presetModifiedFields({ ...w, model: { ...w.model, kvHeads: 8 } })).toEqual(['kvHeads']);
    expect(presetModifiedFields({ ...w, model: { ...w.model, moe: { ...w.model.moe!, topK: 2 } } })).toEqual(['moe.topK']);
  });
});

describe('benchmark calibration', () => {
  const gb300 = findCatalogItem('nvidia-gb300-nvl72')!;
  const llama = findModelPreset('llama3.1-405b')!;
  const ds = findModelPreset('deepseek-v3')!;
  const trainBp = (preset = llama, precision: 'fp4' | 'fp8' = 'fp4'): WorkloadBlueprint => ({
    ...bp('cal', 512 / 6912, 2, 8),
    presetId: preset.id,
    model: applyModelPreset({ name: '', paramsB: 0, activeParamsB: 0, layers: 0, hiddenSize: 0, seqLen: 8192 }, preset),
    training: { ...bp('x', 1).training!, precision, tp: 2, pp: 8, cp: 2, globalBatchTokensM: (896 * 8192) / 1e6 },
  });

  it('MLPerf Training v6.0 GB300 512 GPUs, Llama 3.1 405B NVFP4 — hand-computed', () => {
    const row = findBenchmark('mlperf-t60-llama405b-gb300-512-eth')!;
    // hand: olympic (middle) run 3,500.147 s; tokens 2,620,391,424; F_tok = 6·405e9 + 12·126·16,384·8,192 = 2,632,937,204,736
    const tokensPerSec = 2_620_391_424 / 3500.147;
    const F = 6 * 405e9 + 12 * 126 * 16384 * 8192;
    expect(F).toBe(2_632_937_204_736);
    expect(trainingFlopsPerToken(llama, 8192)).toBe(F);
    const tflops = (tokensPerSec * F) / 512;
    expect(tflops / 1e12).toBeCloseTo(3849.9, 0); // research note value
    const r = calibrateFromBenchmark(trainBp(), row, gb300);
    expect(r.mode).toBe('training');
    expect(r.tflopsPerGpu!).toBeCloseTo(tflops, -6);
    expect(r.sourcePrecision).toBe('fp4');
    expect(r.mfu!).toBeCloseTo(tflops / peakFlopsFor(gb300.compute!, 'fp4'), 12);
    expect(r.transferFactor).toBeCloseTo(1, 12);
    expect(r.warnings.map((w) => w.code)).toContain('lower-bound'); // evaluation time not subtracted
    expect(r.source).toContain('measured-paper → derived');
  });

  it('forward model reproduces the benchmark tokens/s within 1 % after applying the back-solved MFU', () => {
    const row = findBenchmark('mlperf-t60-llama405b-gb300-512-eth')!;
    const { project } = createNvidiaReferenceProject();
    const w = trainBp();
    const r = calibrateFromBenchmark(w, row, gb300);
    if (r.blocked) return; // peak table inconsistent at this precision (catalog-owned); the warning itself is asserted elsewhere
    w.training!.mfuAssumed = r.mfu;
    w.calibration = calibrationRecord(r, row);
    const a = analyzeProject({ ...project, workloads: [w] });
    const tr = a.network.traffic!;
    expect(a.workloads[0].gpus).toBe(512);
    const tokens = (w.training!.globalBatchTokensM * 1e6) / tr.computeTimeS!;
    expect(Math.abs(tokens / r.sourceTokensPerSec! - 1)).toBeLessThan(0.01);
  });

  it('MoE efficiency evidence: DeepSeek-V3 vs Llama 3.1 405B on GB300 512 GPUs ≈ 0.37', () => {
    const dense = calibrateFromBenchmark(trainBp(), findBenchmark('mlperf-t60-llama405b-gb300-512-eth')!, gb300);
    const moeBp = trainBp(ds, 'fp8');
    moeBp.model.seqLen = 4096;
    moeBp.training = { ...moeBp.training!, tp: 1, pp: 4, cp: 1, ep: 32, globalBatchTokensM: (15360 * 4096) / 1e6 };
    const moe = calibrateFromBenchmark(moeBp, findBenchmark('mlperf-t60-dsv3-gb300-512')!, gb300);
    // hand: 3,145,728,000 tokens / 1,051.018 s × (6·37e9 + 12·61·7,168·4,096 = 243,491,613,696) / 512
    expect(moe.tflopsPerGpu! / 1e12).toBeCloseTo((3_145_728_000 / 1051.018) * 243_491_613_696 / 512 / 1e12, 3);
    expect(moe.tflopsPerGpu! / dense.tflopsPerGpu!).toBeCloseTo(0.37, 2);
    expect(moe.blocked).toBe(false);
    expect(moe.mfu!).toBeCloseTo(moe.tflopsPerGpu! / peakFlopsFor(gb300.compute!, 'fp8'), 12);
  });

  it('transfer rules: dense → MoE blocked, 2× batch and scale warnings, peak-inconsistent is not clamped', () => {
    const row = findBenchmark('mlperf-t60-llama405b-gb300-512-eth')!;
    const moeBp = trainBp(ds, 'fp4');
    const blocked = calibrateFromBenchmark(moeBp, row, gb300);
    expect(blocked.blocked).toBe(true);
    expect(blocked.warnings.find((w) => w.code === 'kind-mismatch')?.en).toMatch(/3,850 vs DeepSeek-V3 1,423/);
    const big = trainBp();
    big.training!.globalBatchTokensM *= 3;
    expect(calibrateFromBenchmark(big, row, gb300).warnings.map((w) => w.code)).toContain('batch-mismatch');
    expect(scaleWarning(512, 1024)).toBeUndefined();
    expect(scaleWarning(512, 4096)?.code).toBe('scale-mismatch');
    // H100 FP8 row on GB300 at FP8: accelerator + precision transfer is an estimate (warned)
    const h100 = calibrateFromBenchmark(trainBp(llama, 'fp8'), findBenchmark('mlperf-t50-llama405b-h100-8192')!, gb300);
    expect(h100.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['accelerator-mismatch']));
    expect(h100.mfu!).toBeCloseTo(h100.tflopsPerGpu! / peakFlopsFor(acceleratorPeakSource('hgx-h100-node')!, 'fp8'), 12);
    // a peak table far below the measurement → MFU > 1 is reported and blocks, never clamped
    const tiny = { ...gb300, id: 'tiny', compute: { ...gb300.compute!, peakTflops: { fp4: 1000 } } };
    const r = calibrateFromBenchmark(trainBp(), { tokensPerSec: 748_652, gpus: 512, acceleratorCatalogId: 'nonexistent', precision: 'fp4' }, tiny);
    expect(r.mfu!).toBeGreaterThan(1);
    expect(r.warnings.map((w) => w.code)).toContain('peak-inconsistent');
    expect(r.blocked).toBe(true);
  });

  it('inference calibration overrides the decode-capacity sizing', () => {
    const { project } = createNvidiaReferenceProject();
    const inf = structuredClone(project.workloads.find((w) => w.kind === 'llm-inference')!);
    const preset = findModelPreset('deepseek-r1')!;
    inf.model = applyModelPreset(inf.model, preset);
    inf.presetId = preset.id;
    inf.inference!.tpotSloMs = 15; // 66.7 tok/s per user = MLPerf Interactive floor
    const row = findBenchmark('mlperf-i60-dsr1-interactive-gb300-72')!;
    const r = calibrateFromBenchmark(inf, row, gb300);
    expect(r.mode).toBe('inference');
    expect(r.blocked).toBe(false);
    expect(r.tokensPerSecPerGpu).toBeCloseTo(3481, 6);
    expect(r.warnings.some((w) => w.code === 'interactivity')).toBe(false);
    inf.calibration = calibrationRecord(r, row);
    const a = analyzeProject({ ...project, workloads: [project.workloads[0], inf] });
    const res = a.workloads.find((w) => w.workloadId === inf.id)!;
    const decodeGpus = res.details!.decodeInstanceGpus as number;
    const prefillGpus = res.details!.prefillInstanceGpus as number;
    const prefillReplicas = res.details!.prefillReplicas as number;
    const demand = inf.inference!.requestsPerSec * inf.inference!.outputTokens;
    expect(res.gpusRequired).toBe(prefillReplicas * prefillGpus + Math.max(1, Math.ceil(demand / (3481 * decodeGpus))) * decodeGpus);
    // interactivity above the row's floor is warned
    const strict = structuredClone(inf);
    strict.inference!.tpotSloMs = 10;
    expect(calibrateFromBenchmark(strict, row, gb300).warnings.map((w) => w.code)).toContain('interactivity');
  });
});

describe('inference parallelism and P/D disaggregation', () => {
  it('uses independent prefill/decode topologies and reserves one complete P/D serving unit', () => {
    const { project } = createNvidiaReferenceProject();
    const inf = structuredClone(project.workloads.find((w) => w.kind === 'llm-inference')!);
    inf.model = applyModelPreset(inf.model, findModelPreset('deepseek-r1')!);
    inf.gpuShare = 1;
    inf.inference = {
      ...inf.inference!,
      disaggregated: true,
      parallelism: { tp: 2, pp: 1, ep: 1, cp: 1 },
      prefillParallelism: { tp: 2, pp: 1, ep: 2, cp: 2 },
      decodeParallelism: { tp: 4, pp: 1, ep: 2, cp: 1 },
    };
    expect(modelParallelGroupGpus(inf)).toBe(16); // 8-GPU prefill + 8-GPU decode
    const a = analyzeProject({ ...project, workloads: [inf] });
    const r = a.workloads[0];
    expect(r.details).toMatchObject({
      prefillInstanceGpus: 8,
      decodeInstanceGpus: 8,
      prefillTp: 2,
      prefillEp: 2,
      prefillCp: 2,
      decodeTp: 4,
      decodeEp: 2,
      decodeCp: 1,
    });
    expect(r.gpusRequired).toBe((r.details!.prefillReplicas as number) * 8 + (r.details!.decodeReplicas as number) * 8);
    expect(r.notesEn?.some((n) => n.includes('P/D topology'))).toBe(true);
  });

  it('rejects a topology whose weight shard cannot fit in HBM', () => {
    const { project } = createNvidiaReferenceProject();
    const inf = structuredClone(project.workloads.find((w) => w.kind === 'llm-inference')!);
    inf.gpuShare = 1;
    inf.inference = { ...inf.inference!, disaggregated: false, parallelism: { tp: 1, pp: 1, ep: 1, cp: 1 } };
    const r = analyzeProject({ ...project, workloads: [inf] }).workloads[0];
    expect(r.gpus).toBe(0);
    expect(r.notesEn?.[0]).toMatch(/usable HBM/);
  });
});
