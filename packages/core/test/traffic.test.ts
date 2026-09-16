import { describe, expect, it } from 'vitest';
import { AGGREGATE_TRAFFIC_ID, analyzeProject, computeInferenceTraffic, computeTraffic, createNvidiaReferenceProject, DDC_TABLE, ETA_DEFAULT, etaFor, findCatalogItem, radixCapacity, sizeDdc, type InferenceTrafficSpec, type TrafficSpec } from '../src/index.ts';

/**
 * Anchors from docs/research/network-sim.md §2.4 / §7.3 and review-domain-network-sim.md. GPU specs are inline (H100 SXM:
 * BF16 dense 989 TF, NVLink 900 GB/s bidirectional → 450 GB/s per direction, 8 × 400G NICs per 8-GPU node) — no catalog seeds.
 */
const llama3: TrafficSpec = {
  model: { name: 'Llama 3 405B', paramsB: 405, activeParamsB: 405, layers: 126, hiddenSize: 16384, seqLen: 8192, numHeads: 128, kvHeads: 8, vocab: 128256 },
  training: {
    tokensB: 15600,
    globalBatchTokensM: 16.777216, // 16 M tokens per batch (Table 4)
    precision: 'bf16',
    tp: 8,
    pp: 16,
    ep: 1,
    cp: 1,
    zeroStage: 3, // FSDP
    microBatchSeqs: 1,
    mfuAssumed: 0.43, // Table 4: 430 TFLOP/s per GPU
    checkpointEveryMin: 30,
    checkpointDurationS: 60,
    mtbfHoursPerGpu: 50000,
  },
  gpus: 8192,
  gpu: { peakFlops: 989e12, scaleUpDomain: 8, scaleUpGBpsPerDir: 450, nicGbps: 400 },
  fabric: {
    kind: 'clos',
    tiers: 3,
    k: 64,
    oversubscription: 1,
    gpusPerLeafDomain: 16, // Meta rack: 16 GPUs under one RTSW
    gpusPerSpineDomain: 3072, // pod with full bisection; 1:7 aggregation above it
    leaves: 1536,
    eta: { value: ETA_DEFAULT['qp-scaling'].value, class: 'qp-scaling', source: 'public-spec', citation: 'Meta SIGCOMM 24', overridden: false },
    sharp: false,
  },
};

describe('traffic.ts — Llama 3 405B on 8,192 H100 (TP8 / PP16 / DP64, 16 M-token batch, 43 % MFU)', () => {
  const r = computeTraffic(llama3);

  it('step time ≈ 12.5 s (±15 %) with ≤ 10 % exposed communication', () => {
    expect(r.stepTimeS).toBeGreaterThan(12.5 * 0.85);
    expect(r.stepTimeS).toBeLessThan(12.5 * 1.15);
    expect((r.exposedCommS ?? 0) / r.stepTimeS).toBeLessThanOrEqual(0.1);
    expect(r.mfuEffective!).toBeGreaterThan(0.39);
  });

  it('TP ≈ 473 GB, FSDP ≈ 19 GB, PP ≈ 2.1 GB per GPU per step (±10 %)', () => {
    expect(r.bytesPerStepByGroup.tp).toBeGreaterThan(473 * 0.9);
    expect(r.bytesPerStepByGroup.tp).toBeLessThan(473 * 1.1);
    expect(r.bytesPerStepByGroup.dp).toBeGreaterThan(19 * 0.9);
    expect(r.bytesPerStepByGroup.dp).toBeLessThan(19 * 1.1);
    expect(r.bytesPerStepByGroup.pp).toBeGreaterThan(2.1 * 0.9);
    expect(r.bytesPerStepByGroup.pp).toBeLessThan(2.1 * 1.1);
    expect(r.bytesPerStepByGroup.cp).toBe(0);
    expect(r.bytesPerStepByGroup.ep).toBe(0);
  });

  it('places TP on the scale-up tier and DP on the NIC tiers (review C2: DP spans pods → aggregation tier carries FSDP)', () => {
    expect(r.groupTier?.tp).toBe('scale-up');
    expect(r.groupTier?.dp).toMatch(/spine/);
    expect(r.groupTier?.dp).toMatch(/core/);
    const su = r.perTier.find((t) => t.tier === 'scale-up')!;
    const leaf = r.perTier.find((t) => t.tier === 'leaf')!;
    expect(su.bytesPerStepGB).toBeGreaterThan(leaf.bytesPerStepGB * 10); // TP dominates and never leaves the box
    for (const t of r.perTier) expect(t.headroom).toBeGreaterThanOrEqual(0);
  });

  it('effective efficiency follows the slowest-edge rule: every NIC collective crosses the multipath tier → η (qp-scaling 0.70, Meta SIGCOMM\'24) × 3-tier hop factor', () => {
    expect(ETA_DEFAULT['qp-scaling'].value).toBe(0.7);
    expect(r.commEfficiencyEffective).toBeCloseTo(0.7 * 0.98, 6);
    expect(r.l2l3.recommendation).toBe('l3');
    expect(r.minOversubscription).toBeGreaterThanOrEqual(1);
  });

  it('activation recompute switches to the Megatron 96-form (4/3 of the PaLM FLOPs)', () => {
    const rc = computeTraffic({ ...llama3, training: { ...llama3.training, activationRecompute: true } });
    expect(rc.computeTimeS! / r.computeTimeS!).toBeCloseTo(4 / 3, 6);
  });

  it('is deterministic', () => {
    expect(computeTraffic(llama3)).toEqual(r);
  });
});

describe('traffic.ts — MoE / EP, oversubscription and η', () => {
  const moe: TrafficSpec = {
    model: { name: 'DeepSeek-V3-like', paramsB: 671, activeParamsB: 37, layers: 61, hiddenSize: 7168, seqLen: 4096, numHeads: 128, kvHeads: 128, moe: { experts: 256, topK: 8, nodeLimit: 4 }, mla: { dLatent: 512, dRope: 64 } },
    training: { tokensB: 14800, globalBatchTokensM: 15.7, precision: 'fp8', tp: 1, pp: 16, ep: 64, cp: 1, zeroStage: 1, microBatchSeqs: 1, checkpointEveryMin: 30, checkpointDurationS: 60, mtbfHoursPerGpu: 50000 },
    gpus: 2048,
    gpu: { peakFlops: 1979e12, scaleUpDomain: 8, scaleUpGBpsPerDir: 200, nicGbps: 400 },
    fabric: { kind: 'clos', tiers: 2, k: 64, oversubscription: 1, gpusPerLeafDomain: 256, gpusPerSpineDomain: 2048, leaves: 64, eta: { value: 0.95, class: 'adaptive', source: 'vendor-datasheet', citation: 'IB AR', overridden: false }, sharp: true },
  };
  const r = computeTraffic(moe);

  it('EP over 8 nodes puts node-limited all-to-all bytes on the NIC (≤ M·h·3 B per token per layer)', () => {
    expect(r.bytesPerStepByGroup.ep).toBeGreaterThan(0);
    expect(r.groupTier?.ep).toMatch(/leaf/);
    expect(r.notes.some((n) => /node-limited/.test(n))).toBe(true);
    // per GPU per step NIC bytes ≤ tokens/GPU × layers/stage × M × h × 3 B
    const leaf = r.perTier.find((t) => t.tier === 'leaf')!;
    const tokensPerGpu = 15.7e6 / (2048 / 16);
    const cap = (tokensPerGpu * (61 / 16) * 4 * 7168 * 3) / 1e9;
    expect(leaf.bytesPerStepGB).toBeLessThanOrEqual(cap + r.bytesPerStepByGroup.dp + r.bytesPerStepByGroup.pp + 1e-6);
  });

  it('EP inside the scale-up domain (NVL72) keeps the all-to-all off the NIC', () => {
    const nvl = computeTraffic({ ...moe, gpu: { ...moe.gpu, scaleUpDomain: 72, scaleUpGBpsPerDir: 900 } });
    expect(nvl.groupTier?.ep).toBe('scale-up');
    const leaf = nvl.perTier.find((t) => t.tier === 'leaf')!;
    expect(leaf.bytesPerStepGB).toBeLessThan(r.perTier.find((t) => t.tier === 'leaf')!.bytesPerStepGB);
  });

  it('oversubscription raises spine utilization linearly and lowers the admissible minimum ratio', () => {
    const os3 = computeTraffic({ ...moe, fabric: { ...moe.fabric, oversubscription: 3 } });
    const s1 = r.perTier.find((t) => t.tier === 'spine')!;
    const s3 = os3.perTier.find((t) => t.tier === 'spine')!;
    expect(s3.utilization).toBeCloseTo(s1.utilization * 3, 6);
    expect(os3.minOversubscription).toBe(r.minOversubscription);
    expect(r.minOversubscription).toBeGreaterThanOrEqual(1);
    expect(r.minOversubscription).toBeLessThanOrEqual(8);
  });

  it('η override and class defaults carry their sources (v2 2차: sourced values only, r2-eta.md §3)', () => {
    expect(etaFor({ fabric: 'roce-generic-400' })).toMatchObject({ value: 0.6, class: 'ecmp', overridden: false, sourceType: 'vendor-claim', host: 0.95 }); // fix v2 2차 (QA M5)
    expect(etaFor({ fabric: 'ib-xdr-800' })).toMatchObject({ value: 0.95, class: 'adaptive', sourceType: 'vendor-claim' });
    expect(etaFor({ fabric: 'ib-xdr-800' }).conditions).toMatch(/IB-specific η unmeasured/);
    expect(etaFor({ fabric: 'spectrumx-800' }).conditions).not.toMatch(/IB-specific/);
    // DDC: nominal 1.0, computed and ranked at the 0.95 lower bound so a missing measurement never ranks first
    expect(etaFor({ fabric: 'drivenets-fse' })).toMatchObject({ value: 0.95, nominalValue: 1, class: 'ddc', source: 'estimate', sourceType: 'nominal' });
    expect(etaFor({ fabric: 'ethernet-400', loadBalancing: 'qp-scaling' })).toMatchObject({ value: 0.7, class: 'qp-scaling' });
    expect(etaFor({ fabric: 'ethernet-400', loadBalancing: 'te' })).toMatchObject({ value: 0.8, class: 'te', sourceType: 'measured-paper' });
    expect(etaFor({ fabric: 'ethernet-400', etaOverride: 0.7 })).toMatchObject({ value: 0.7, source: 'user', sourceType: 'user', overridden: true });
    // precedence: user-measured calibration > typed override > sourced default
    const cal = { nominalGBps: 400, eta: 0.82, etaFabric: 0.82, etaHost: 0.96, basis: 'test', measuredAt: '2026-09-15', measurement: { tool: 'nccl-tests' as const, collective: 'all_reduce' as const, rows: [] } };
    expect(etaFor({ fabric: 'ethernet-400', etaOverride: 0.7, etaCalibration: cal })).toMatchObject({ value: 0.82, sourceType: 'user-measured', host: 0.96, measuredAt: '2026-09-15' });
    expect(etaFor({ fabric: 'ethernet-400', etaCalibration: cal, etaCalibrationA2a: { ...cal, eta: 0.7, etaFabric: 0.7 } }).a2a).toBe(0.7);
    const ecmp = computeTraffic({ ...moe, fabric: { ...moe.fabric, eta: { value: 0.6, class: 'ecmp', source: 'vendor-datasheet', citation: 'x', overridden: false } } });
    expect(ecmp.commEfficiencyEffective).toBeLessThan(r.commEfficiencyEffective);
  });

  it('inference block: MLA KV bytes/token (DeepSeek-V3 70.272 KB at 2 B) and GQA (Llama 3.1 405B 516.096 KB at 2 B)', () => {
    const mla = computeTraffic({ ...moe, inference: { params: { requestsPerSec: 10, inputTokens: 4096, outputTokens: 512, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: true, kvPrecision: 'bf16', prefillParallelism: { tp: 2, pp: 1, ep: 4, cp: 2 }, decodeParallelism: { tp: 4, pp: 1, ep: 8, cp: 1 } }, model: moe.model } });
    expect(mla.inference?.attention).toBe('mla');
    expect(mla.inference?.kvBytesPerToken).toBe(61 * (512 + 64) * 2);
    expect(mla.inference?.epDecodeTokPerSPerUser).toBeGreaterThan(0);
    expect(mla.inference).toMatchObject({ disaggregated: true, prefillInstanceGpus: 16, decodeInstanceGpus: 32, prefillParallelism: { tp: 2, ep: 4, cp: 2 }, decodeParallelism: { tp: 4, ep: 8, cp: 1 } });
    const gqa = computeTraffic({ ...llama3, inference: { params: { requestsPerSec: 10, inputTokens: 4096, outputTokens: 512, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: true, kvPrecision: 'bf16' }, model: llama3.model } });
    expect(gqa.inference?.attention).toBe('gqa');
    expect(gqa.inference?.kvBytesPerToken).toBe(2 * 126 * 8 * 128 * 2);
    // DistServe: R_KV = rps × prompt × KV/token → 10 × 4096 × 516,096 B = 21.1 GB/s ≈ 169 Gb/s
    expect(gqa.inference?.kvTransferGbps).toBeCloseTo((10 * 4096 * 516096 * 8) / 1e9, 6);
    const aggregated = computeTraffic({ ...llama3, inference: { params: { requestsPerSec: 10, inputTokens: 4096, outputTokens: 512, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: false, kvPrecision: 'bf16', parallelism: { tp: 8, pp: 1, ep: 1, cp: 1 } }, model: llama3.model } });
    expect(aggregated.inference?.kvTransferGbps).toBe(0);
    expect(aggregated.inference?.decodeInstanceGpus).toBe(8);
    const hybrid = computeTraffic({ ...moe, inference: { params: { requestsPerSec: 10, inputTokens: 4096, outputTokens: 512, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: true, kvPrecision: 'bf16' }, model: { ...moe.model, layers: 93, kvCacheLayerFraction: 24 / 93 } } });
    expect(hybrid.inference?.kvBytesPerToken).toBe(24 * (512 + 64) * 2);
  });
});

describe('traffic.ts — inference as a first-class Network/Cabling scenario', () => {
  const serving: InferenceTrafficSpec = {
    model: { name: 'MoE serving', paramsB: 671, activeParamsB: 37, layers: 61, hiddenSize: 7168, seqLen: 4096, numHeads: 128, kvHeads: 128, moe: { experts: 256, topK: 8, nodeLimit: 4 }, mla: { dLatent: 512, dRope: 64 } },
    inference: {
      requestsPerSec: 120,
      inputTokens: 4096,
      outputTokens: 512,
      ttftSloMs: 1000,
      tpotSloMs: 50,
      disaggregated: true,
      kvPrecision: 'bf16',
      prefillParallelism: { tp: 4, pp: 1, ep: 2, cp: 2 },
      decodeParallelism: { tp: 4, pp: 1, ep: 8, cp: 1 },
    },
    gpus: 384,
    gpu: { peakFlops: 2e15, scaleUpDomain: 8, scaleUpGBpsPerDir: 200, nicGbps: 800 },
    fabric: { kind: 'clos', tiers: 3, k: 64, oversubscription: 2, gpusPerLeafDomain: 64, gpusPerSpineDomain: 256, leaves: 48, eta: { value: 0.8, class: 'te', source: 'public-spec', citation: 'test', overridden: false }, etaA2a: 0.7 },
  };

  it('models TP/CP/EP plus P/D KV transfer as GB/s on a one-second demand window', () => {
    const r = computeInferenceTraffic(serving);
    expect(r).toMatchObject({ mode: 'inference', basis: 'inference-second', stepTimeS: 1 });
    expect(r.bytesPerStepByGroup.tp).toBeGreaterThan(0);
    expect(r.bytesPerStepByGroup.cp).toBeGreaterThan(0);
    expect(r.bytesPerStepByGroup.ep).toBeGreaterThan(0);
    expect(r.bytesPerStepByGroup.pd).toBeGreaterThan(0);
    expect(r.groupTier?.pd).toMatch(/leaf/);
    expect(r.inference).toMatchObject({ requestsPerSec: 120, allocatedGpus: 384, replicas: 8, disaggregated: true, prefillInstanceGpus: 16, decodeInstanceGpus: 32 });
    expect(r.inference!.kvTransferGbps).toBeGreaterThan(0);
    expect(r.perTier.find((x) => x.tier === 'leaf')!.utilization).toBeGreaterThan(0);
  });

  it('runs from an inference-only project and honours the selected Traffic workload', () => {
    const project = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
    const inference = project.workloads.find((w) => w.inference)!;
    inference.inference = { ...inference.inference!, disaggregated: true, prefillParallelism: { tp: 2, pp: 1, ep: 1, cp: 1 }, decodeParallelism: { tp: 4, pp: 1, ep: 1, cp: 1 } };
    project.workloads = [inference];
    project.network.trafficWorkloadId = inference.id;
    const report = analyzeProject(project).network.traffic;
    expect(report).toBeDefined();
    expect(report).toMatchObject({ workloadId: inference.id, mode: 'inference', basis: 'inference-second' });
    expect(report!.inference?.allocatedGpus).toBeGreaterThan(0);
    expect(report!.notes.some((n) => n.includes('GPU racks placed in Layout'))).toBe(true);
  });

  it('switches between training and inference when both workloads exist', () => {
    const project = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
    const inference = project.workloads.find((w) => w.inference)!;
    const training = project.workloads.find((w) => w.training)!;
    project.network.trafficWorkloadId = inference.id;
    expect(analyzeProject(project).network.traffic).toMatchObject({ workloadId: inference.id, mode: 'inference' });
    project.network.trafficWorkloadId = training.id;
    expect(analyzeProject(project).network.traffic).toMatchObject({ workloadId: training.id, mode: 'training' });
  });

  it('keeps untraced inference demand flat over the representative 600-second window', () => {
    const project = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
    const inference = project.workloads.find((w) => w.inference)!;
    project.network.trafficWorkloadId = inference.id;
    const report = analyzeProject(project).network.traffic!;
    expect(report.trafficTrace).toHaveLength(600);
    expect(new Set(report.trafficTrace!.map((point) => point.leafGBps)).size).toBe(1);
    expect(report.quality).toMatchObject({ workloadCount: 1 });
    if (inference.calibration?.mode !== 'inference') expect(report.quality?.offeredDemandWorkloads).toContain(inference.id);
  });

  it('aggregates concurrent workloads as facility GB/s and preserves evidence boundaries', () => {
    const project = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
    project.network.trafficWorkloadId = AGGREGATE_TRAFFIC_ID;
    const report = analyzeProject(project).network.traffic!;
    expect(report).toMatchObject({ mode: 'aggregate', basis: 'aggregate-second', scope: 'aggregate' });
    expect(report.workloadIds).toHaveLength(project.workloads.filter((w) => w.training || w.inference).length);
    expect(report.allocatedGpus).toBeGreaterThan(0);
    expect(report.trafficTrace).toHaveLength(600);
    expect(report.bytesPerStepByGroup.tp).toBeGreaterThan(0);
    expect(report.perTier.every((tier) => (tier.capacityGBps ?? 0) > 0)).toBe(true);
    expect(report.notes.some((note) => /concurrent/i.test(note))).toBe(true);
    expect(report.quality?.assumptions.some((note) => /scheduler start offsets/i.test(note))).toBe(true);
  });

  it('uses the placed UBB8 or HGX scale-up envelope instead of a vendor-neutral fixed capacity', () => {
    const reportFor = (catalogId: string, aggregate = false) => {
      const project = structuredClone(createNvidiaReferenceProject({ pods: 1 }).project);
      const inference = project.workloads.find((w) => w.inference)!;
      project.network.trafficWorkloadId = aggregate ? AGGREGATE_TRAFFIC_ID : inference.id;
      for (const equipment of project.equipment) {
        if (findCatalogItem(equipment.catalogId)?.category === 'gpu-rack' && typeof equipment.meta?.computeSlot !== 'string') equipment.catalogId = catalogId;
      }
      return analyzeProject(project).network.traffic!;
    };

    const amd = reportFor('amd-mi355x-dlc-4x');
    const hgx = reportFor('hgx-b200-air-4x');
    const amdScaleUp = amd.perTier.find((tier) => tier.tier === 'scale-up')!;
    const hgxScaleUp = hgx.perTier.find((tier) => tier.tier === 'scale-up')!;
    expect(amd.physical).toMatchObject({ platformId: 'amd-mi355x-dlc-4x', scaleUpName: 'Infinity Fabric', scaleUpDomain: 8, scaleUpEffectiveGBpsPerGpu: 430.1, scaleUpBusbwFactor: 0.8, scaleOutFabric: 'ib-xdr-800' });
    expect(hgx.physical).toMatchObject({ platformId: 'hgx-b200-air-4x', scaleUpName: 'NVLink', scaleUpDomain: 8, scaleUpEffectiveGBpsPerGpu: 720, scaleUpBusbwFactor: 0.8, scaleOutFabric: 'ib-xdr-800' });
    expect(amdScaleUp.bytesPerStepGB).toBeCloseTo(hgxScaleUp.bytesPerStepGB, 9);
    expect(amdScaleUp.utilization).toBeGreaterThan(hgxScaleUp.utilization);
    expect(amdScaleUp.capacityGBps).toBeCloseTo(430.1, 6);
    expect(hgxScaleUp.capacityGBps).toBe(720);
    expect(430 / amdScaleUp.capacityGBps!).toBeGreaterThan(0.99); // effectively no operating headroom
    expect(430 / hgxScaleUp.capacityGBps!).toBeLessThan(0.6);

    const aggregateAmd = reportFor('amd-mi355x-dlc-4x', true);
    const aggregateHgx = reportFor('hgx-b200-air-4x', true);
    expect(aggregateAmd.physical?.scaleUpName).toBe('Infinity Fabric');
    expect(aggregateHgx.physical?.scaleUpName).toBe('NVLink');
    expect(aggregateAmd.perTier.find((tier) => tier.tier === 'scale-up')!.capacityGBps! / aggregateAmd.allocatedGpus!).toBeCloseTo(430.1, 6);
    expect(aggregateHgx.perTier.find((tier) => tier.tier === 'scale-up')!.capacityGBps! / aggregateHgx.allocatedGpus!).toBe(720);
  });
});

describe('radix table and DDC table anchors', () => {
  it('2-tier k²/2: 64 → 2,048 · 128 → 8,192 · 144 → 10,368 · 512 → 131,072', () => {
    expect(radixCapacity(64, 2)).toBe(2048);
    expect(radixCapacity(128, 2)).toBe(8192);
    expect(radixCapacity(144, 2)).toBe(10368);
    expect(radixCapacity(512, 2)).toBe(131072);
  });

  it('AMD–DriveNets RA Table 11: NCF 1/2/5/10/20/40 and NCP 6/12/32/64/128/256 from NCP = ceil(endpoints800/18)', () => {
    const expected = [
      ['AI-108-800', 108, 1, 6],
      ['AI-216-800', 216, 2, 12],
      ['AI-576-800', 576, 5, 32],
      ['AI-1152-800', 1152, 10, 64],
      ['AI-2304-800', 2304, 20, 128],
      ['AI-4608-800', 4608, 40, 256],
    ] as const;
    expect(DDC_TABLE.map((r) => [r.name, r.endpoints800, r.ncf, r.ncp])).toEqual(expected.map((e) => [...e]));
    for (const [name, ep, ncf, ncp] of expected) {
      const r = sizeDdc(ep);
      expect(r, name).toMatchObject({ ncp, ncf, base: name, withinRA: true });
    }
    // beyond the largest validated cluster: extrapolated NCF, flagged, and infeasible past the 2-tier FSE cap (256 NCP / 40 NCF)
    const big = sizeDdc(6912);
    expect(big.withinRA).toBe(false);
    expect(big.ncp).toBe(384);
    expect(big.ncf).toBe(Math.ceil((384 * 20) / 128));
    expect(big.feasible).toBe(false);
    for (const r of DDC_TABLE) expect(sizeDdc(r.endpoints800).feasible, r.name).toBe(true);
  });

  it('AMD–DriveNets RA Table 12 (400G endpoints): NCP = ceil(E400/32), minimum base AI-216-800, 36/NCP only rail-optimized', () => {
    // rows: 400G endpoints → base / NCF / NCP (RA p.37, TOR-aligned 32 × 400G per NCP, Fig 20 "32/36")
    const table12 = [
      [128, 'AI-216-800', 2, 4],
      [256, 'AI-216-800', 2, 8],
      [512, 'AI-576-800', 5, 16],
      [1024, 'AI-576-800', 5, 32],
      [2048, 'AI-1152-800', 10, 64],
      [4096, 'AI-2304-800', 20, 128],
      [8192, 'AI-4608-800', 40, 256],
    ] as const;
    for (const [e400, base, ncf, ncp] of table12) {
      const r = sizeDdc(e400 / 2, undefined, undefined, undefined, { endpointGbps: 400 });
      expect(r, `${e400} × 400G`).toMatchObject({ ncp, ncf, base, withinRA: true, feasible: true });
    }
    // the 9,216-endpoint row is the rail-optimized full population (36 × 400G per NCP → 256 NCP)
    expect(sizeDdc(9216 / 2, undefined, undefined, undefined, { endpointGbps: 400, railOptimized: true })).toMatchObject({ ncp: 256, ncf: 40, base: 'AI-4608-800' });
    // TOR-aligned at 9,216 exceeds the cap → flagged infeasible rather than silently 2-tier
    expect(sizeDdc(9216 / 2, undefined, undefined, undefined, { endpointGbps: 400 }).feasible).toBe(false);
  });
});
