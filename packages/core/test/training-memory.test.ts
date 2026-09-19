import { describe, expect, it } from 'vitest';
import { applyModelPreset, findModelPreset, presetModelFields, trainingDataParallel, trainingMemoryEstimate, trainingMemoryFitPatch, TRAINING_RESERVE_BAND, type WorkloadBlueprint } from '../src/index.ts';

const GiB = 2 ** 30 / 1e9; // TorchTitan reports GiB; the estimate reports GB (1e9)

/** Llama 3.1 shapes from the paper (the TorchTitan validation rows use these). */
const llama = (paramsB: number, layers: number, hidden: number, heads: number, ffn: number, seqLen = 8192): WorkloadBlueprint => ({
  id: `l${paramsB}`, name: `Llama ${paramsB}B`, kind: 'llm-pretrain', gpuShare: 1, durationDays: 1,
  model: { name: `Llama ${paramsB}B`, paramsB, activeParamsB: paramsB, layers, hiddenSize: hidden, seqLen, numHeads: heads, kvHeads: 8, vocab: 128256, ffnHidden: ffn },
  training: { tokensB: 1, globalBatchTokensM: 1, precision: 'bf16', tp: 1, pp: 1, ep: 1, cp: 1, zeroStage: 3, microBatchSeqs: 1, checkpointEveryMin: 30, checkpointDurationS: 60, mtbfHoursPerGpu: 50000 },
});
const withTraining = (w: WorkloadBlueprint, patch: Partial<NonNullable<WorkloadBlueprint['training']>>, tokensPerStep?: number): WorkloadBlueprint =>
  ({ ...w, training: { ...w.training!, ...patch, ...(tokensPerStep ? { globalBatchTokensM: tokensPerStep / 1e6 } : {}) } });

describe('training memory model (workload/training.ts)', () => {
  it('static state sums to 16 bytes per parameter over the cluster, dense and MoE alike', () => {
    const w = llama(8, 32, 4096, 32, 14336);
    // fully sharded (ZeRO-3): the cluster holds exactly 16·P; lower stages replicate the unsharded buckets over dp
    const e3 = trainingMemoryEstimate(withTraining(w, { zeroStage: 3, tp: 2, pp: 2 }), { tp: 2, cp: 1, pp: 2, ep: 1 }, 80, 8, 64)!;
    expect((e3.weightsGBPerGpu + e3.gradientsGBPerGpu + e3.optimizerGBPerGpu) * 64).toBeCloseTo(16 * 8, 6);
    const e0 = trainingMemoryEstimate(withTraining(w, { zeroStage: 0, tp: 2, pp: 2 }), { tp: 2, cp: 1, pp: 2, ep: 1 }, 80, 8, 64)!;
    expect(e0.weightsGBPerGpu + e0.gradientsGBPerGpu + e0.optimizerGBPerGpu).toBeCloseTo(16 * 8 / 4, 6); // P/(tp·pp) · 16 B, no dp sharding
    const ds = { ...w, model: applyModelPreset(w.model, findModelPreset('deepseek-v3')!) };
    const e = trainingMemoryEstimate(withTraining(ds, { zeroStage: 3, tp: 1, pp: 16, ep: 64 }), { tp: 1, cp: 1, pp: 16, ep: 64 }, 141, 8, 2048)!;
    expect((e.weightsGBPerGpu + e.gradientsGBPerGpu + e.optimizerGBPerGpu) * 2048).toBeCloseTo(16 * ds.model.paramsB, 3);
    expect(e.topology.expertDp).toBe(2); // dp·cp/ep = 128/64
  });

  it('the floor is schedule-independent and precision never reduces static state', () => {
    const w = withTraining(llama(405, 126, 16384, 128, 53248), { tp: 8, pp: 1, zeroStage: 1 });
    const a = trainingMemoryEstimate(w, { tp: 8, cp: 1, pp: 1, ep: 1 }, 141, 8, 64)!;
    const b = trainingMemoryEstimate(withTraining(w, { microBatchSeqs: 8 }, 10 * 8192 * 64), { tp: 8, cp: 1, pp: 1, ep: 1 }, 141, 8, 64)!;
    expect(b.floorGBPerGpu).toBeCloseTo(a.floorGBPerGpu, 9);
    expect(b.activationsGBPerGpu).toBeGreaterThan(a.activationsGBPerGpu);
    for (const precision of ['fp8', 'fp4'] as const) {
      const p = trainingMemoryEstimate(withTraining(w, { precision }), { tp: 8, cp: 1, pp: 1, ep: 1 }, 141, 8, 64)!;
      expect(p.weightsGBPerGpu + p.gradientsGBPerGpu + p.optimizerGBPerGpu).toBeCloseTo(a.weightsGBPerGpu + a.gradientsGBPerGpu + a.optimizerGBPerGpu, 9);
    }
    // ZeRO stages shard monotonically
    const stat = ([0, 1, 2, 3] as const).map((z) => { const e = trainingMemoryEstimate(withTraining(w, { zeroStage: z }), { tp: 8, cp: 1, pp: 1, ep: 1 }, 141, 8, 64)!; return e.weightsGBPerGpu + e.gradientsGBPerGpu + e.optimizerGBPerGpu; });
    for (let i = 1; i < stat.length; i++) expect(stat[i]).toBeLessThan(stat[i - 1]);
  });

  it('resident terms never exceed TorchTitan measured peaks, and land within the validated band on FSDP-only rows', () => {
    // Table 1: Llama 3.1 8B, 8 × H100 95 GiB, FSDP, local batch 2, selective AC → peak 81.9 / 77.0 / 76.8 GiB
    const w8 = withTraining(llama(8, 32, 4096, 32, 14336), { zeroStage: 3, microBatchSeqs: 2, activationRecompute: true, activationRecomputeMode: 'selective' }, 2 * 8192 * 8);
    const e8 = trainingMemoryEstimate(w8, { tp: 1, cp: 1, pp: 1, ep: 1 }, 95 * GiB, 8, 8)!;
    expect(e8.confidence).toBe('validated');
    expect(e8.recompute).toBe('selective');
    expect(e8.totalGBPerGpu).toBeLessThanOrEqual(76.8 * GiB);
    expect(e8.totalGBPerGpu / (76.8 * GiB)).toBeGreaterThan(1 - TRAINING_RESERVE_BAND.validated[1]);
    // Table 4: Llama 3.1 405B, 512 GPUs, FSDP 4 × TP 8 × PP 16, full AC, local batch 32 → peak 78.0 GiB
    const w405 = withTraining(llama(405, 126, 16384, 128, 53248), { zeroStage: 3, tp: 8, pp: 16, activationRecompute: true, microBatchSeqs: 2 }, 32 * 8192 * 4);
    const e405 = trainingMemoryEstimate(w405, { tp: 8, cp: 1, pp: 16, ep: 1 }, 95 * GiB, 8, 512)!;
    expect(e405.confidence).toBe('extrapolated');
    expect(e405.totalGBPerGpu).toBeLessThanOrEqual(78 * GiB);
    expect(e405.floorFits).toBe(true);
  });

  it('proposals are ordered memory-only knobs first and each one is a pure re-evaluation', () => {
    const w = withTraining(llama(405, 126, 16384, 128, 53248), { tp: 1, pp: 1, zeroStage: 1 });
    const e = trainingMemoryEstimate(w, { tp: 1, cp: 1, pp: 1, ep: 1 }, 288, 72, 64)!;
    expect(e.fits).toBe(false);
    const order = ['zeroStage', 'activationRecompute', 'microBatchSeqs', 'tp', 'pp', 'cp'];
    const idx = e.proposals.map((p) => order.indexOf(p.change));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1]);
    for (const p of e.proposals) {
      const re = trainingMemoryEstimate({ ...w, training: { ...w.training!, ...p.patch } }, { tp: p.patch.tp ?? 1, cp: p.patch.cp ?? 1, pp: p.patch.pp ?? 1, ep: 1 }, 288, 72, 64)!;
      expect(re.totalGBPerGpu).toBeCloseTo(p.totalGBPerGpu, 9);
    }
    expect(trainingMemoryEstimate(w, { tp: 1, cp: 1, pp: 1, ep: 1 }, 288, 72, 64)).toEqual(e); // deterministic
    expect(trainingMemoryFitPatch(e)).toBeUndefined(); // 405B on one GPU: no memory-only knob can rescue it
    // the neutral reference shape (TP8 · PP8 · ZeRO-1, 141 GB, 3072 GPUs, 16M-token batches) without recompute: selective recompute is the lightest knob that fits
    const ref = withTraining(llama(405, 126, 16384, 128, 53248), { tp: 8, pp: 8, zeroStage: 1, activationRecompute: false, globalBatchTokensM: 16 });
    const r = trainingMemoryEstimate(ref, { tp: 8, cp: 1, pp: 8, ep: 1 }, 141, 72, 3072)!;
    expect(r.fits).toBe(false);
    expect(trainingMemoryFitPatch(r)).toEqual({ activationRecompute: true, activationRecomputeMode: 'selective' });
  });

  it('presets plumb the FFN widths the activation term needs', () => {
    expect(presetModelFields(findModelPreset('llama3.1-405b')!).ffnHidden).toBe(53248);
    const ds = presetModelFields(findModelPreset('deepseek-v3')!);
    expect(ds.moe?.expertFfn).toBe(2048);
    expect(trainingDataParallel(6912, { tp: 8, cp: 1, pp: 4 })).toBe(216);
  });
});
