import type { CatalogItem, InferenceParallelism, PowerAnalysis, TrafficReport, WorkloadAnalysis, WorkloadBlueprint, WorkloadTimePoint } from '../model/types.ts';
import { clamp, type Ctx, hash32, mulberry32 } from './context.ts';
import type { NetworkResult } from './network.ts';
import { kvSeqEffective, moeLayerCount, peakFlopsFor } from './traffic.ts';
import { effectiveShare, effectiveShares, shareState } from '../workload/shares.ts';
import { inferenceCalibrationSignature, inferenceMemoryEstimate, inferenceParallelismFor, inferencePromptTokens, inferenceReplicaGpus } from '../workload/inference.ts';
import { trainingMemoryEstimate } from '../workload/training.ts';
import { findBenchmark } from '../workload/presets.ts';

/**
 * Workload blueprint simulation (analytical).
 *
 * Training
 *  v2 (S2 + QA fix): when the traffic engine produced a report for this blueprint (engines/traffic.ts, `traffic.workloadId`),
 *  step = T_comp + exposed communication and MFU = FLOP/step ÷ (GPUs · peak · step) come from that report — one step-time model
 *  for the Traffic tab, the Workload panel and the IB-vs-RoCE table. The v1 model below is the fallback without a report:
 *  compute/step  = 6·N_active·tokens_step / (GPUs · FLOPS_peak · precision · 0.55 kernel efficiency) / (1 − PP bubble)
 *  PP bubble     = (pp − 1)/(m + pp − 1), m = micro-batches per replica
 *  TP comm       = 4 all-reduces/layer of BF16 activations over NVLink (if tp ≤ NVLink domain) — ring 2(n−1)/n
 *  PP comm       = activations p2p between stages (NVLink when tp·pp ≤ domain, else scale-out)
 *  DP comm       = ring all-reduce of BF16 gradients (params/(tp·pp)) over scale-out bandwidth = NIC Gbps × commEfficiency,
 *                  60 % overlapped with backward; EP all-to-all for MoE when ep > 1
 *                  commEfficiency = TrafficReport.commEfficiencyEffective (η · congestion · link speed, engines/traffic.ts) when the
 *                  traffic engine ran, else the legacy fabric scalar from engines/network.ts
 *  scale jitter  = 1 − 0.015·log2(dp/8);  congestion tail = 1 + (1 − commEfficiency)·0.15·log2(dp/8)
 *  goodput       = 1 − δ/τ − (τ/2 + δ + R)/MTBF_cluster, MTBF_cluster = MTBF_gpu / GPUs, R = 15 min restart
 *                  (Young/Daly optimum τ* = √(2·δ·MTBF) reported in notes)
 *  power trace   = 1 s samples over 10 min: compute ≈ 97 % nameplate, comm ≈ 55 %, checkpoint → idle,
 *                  ramp-limited by rack ramp rates; rack-level smoothing floors at 90 % nameplate
 *                  (aif:spec:idlePowerSmoothing90Pct); BESS smoothing shows the 30 s rolling grid draw.
 * Inference
 *  decode  (memory-bandwidth bound): TPOT(B) = W_read(B)/MBW + B·(KV_seq/MBW + 2·N_active/(g·FLOPS·1.3·0.5))
 *  prefill (compute bound): tokens/s = g·FLOPS·1.3·0.55 / (2·N_active + 2·L·S_in·H)
 *  disaggregated: prefill pool at ρ = 0.7, TTFT = service/(1−ρ) + KV transfer over scale-out; decode pool at max B under SLO
 *  aggregated: prefill share p of each instance, decode capacity × (1 − p) × 0.85, TPOT / (1 − p)
 *  Memory bandwidth per GPU = catalog `memBandwidthGBps` (GB300/GB200/B200: 8,000 GB/s) × 0.85 achievable;
 *  legacy fallback 1300 GB/s × FLOPS/2.3e15 when the field is absent. FP8 weights, FP8 KV with 8:1 GQA.
 */

const PRECISION: Record<string, number> = { bf16: 1, fp8: 1.3, fp4: 1.6 };
const WINDOW_S = 600;

export interface WorkloadEnv {
  gpuRack: CatalogItem | undefined;
  /** GPUs of the cluster the job runs in (the cluster of the primary scale-out plan — collectives never cross clusters, as in
   *  engines/traffic.ts buildTrafficSpec); equals the project GPUs for single-cluster projects */
  clusterGpus: number;
  /** project-wide GPUs (network power is shared out over these) */
  projectGpus: number;
  commEfficiency: number;
  /** v2: the traffic report (engines/traffic.ts) — step time, compute / exposed communication and MFU come from it for the
   *  blueprint it was computed for (`traffic.workloadId`), so the Traffic tab, the Workload panel and the IB-vs-RoCE table agree */
  traffic?: TrafficReport;
  networkKW: number;
  pue: number;
  electricityUSDPerKWh: number;
  powerSmoothing: 'none' | 'rack-level' | 'bess';
}

export function workloadEnv(ctx: Ctx, net: NetworkResult, power: Pick<PowerAnalysis, 'pue'>): WorkloadEnv {
  const traffic = net.analysis.traffic?.scope === 'aggregate' ? undefined : net.analysis.traffic;
  return {
    gpuRack: ctx.gpuRack,
    clusterGpus: jobClusterGpus(ctx, net),
    projectGpus: ctx.gpus,
    // Inference sizing must not feed offered-demand congestion back into per-replica throughput: doing so creates a
    // runaway loop (overload → lower η → more required replicas → apparent overload). Use the uncongested fabric/host
    // efficiency here and leave the traffic engine responsible for reporting/capping the physical network envelope.
    // Training keeps the end-to-end effective value because its step model explicitly represents collective congestion.
    commEfficiency: traffic?.mode === 'inference'
      ? clamp((traffic.eta?.value ?? net.analysis.commEfficiency) * (traffic.etaHost ?? 1), 0.05, 1)
      : traffic?.commEfficiencyEffective ?? net.analysis.commEfficiency,
    traffic,
    networkKW: net.switchKW + net.analysis.transceiverKW,
    pue: power.pue || 1.2,
    electricityUSDPerKWh: ctx.project.site.electricityUSDPerKWh,
    powerSmoothing: ctx.project.power.powerSmoothing,
  };
}

/** GPUs of the cluster a job runs in: the primary scale-out plan's cluster (largest cluster first), else the project GPUs. */
export function jobClusterGpus(ctx: Pick<Ctx, 'gpus'>, net: Pick<NetworkResult, 'plans'>): number {
  const plan = net.plans.find((p) => p.key === 'scale-out');
  return plan?.clusterGpus !== undefined && plan.clusterGpus > 0 ? Math.min(plan.clusterGpus, ctx.gpus) : ctx.gpus;
}

function empty(w: WorkloadBlueprint, note: string, noteEn: string): WorkloadAnalysis {
  return { workloadId: w.id, gpus: 0, avgPowerKW: 0, peakPowerKW: 0, energyMWh: 0, energyCostUSD: 0, powerTrace: [], notes: [note], notesEn: [noteEn] };
}

/** Apply ramp limits and smoothing to a raw per-second fleet power target. */
function shapeTrace(target: number[], rampKWps: number, floorKW: number, mode: WorkloadEnv['powerSmoothing'], util: (i: number) => number): WorkloadTimePoint[] {
  const out: WorkloadTimePoint[] = [];
  let p = target[0];
  const shaped: number[] = [];
  for (let i = 0; i < target.length; i++) {
    let t = target[i];
    if (mode === 'rack-level') t = Math.max(t, floorKW);
    const delta = clamp(t - p, -rampKWps, rampKWps);
    p = i === 0 ? t : p + delta;
    shaped.push(p);
  }
  for (let i = 0; i < shaped.length; i++) {
    let v = shaped[i];
    if (mode === 'bess') {
      const lo = Math.max(0, i - 29);
      let s = 0;
      for (let k = lo; k <= i; k++) s += shaped[k];
      v = s / (i - lo + 1);
    }
    out.push({ t: i, powerKW: v, utilization: util(i) });
  }
  return out;
}

export function simulateTraining(w: WorkloadBlueprint, env: WorkloadEnv): WorkloadAnalysis {
  const rack = env.gpuRack;
  const c = rack?.compute;
  const t = w.training;
  if (!rack || !c || c.gpus <= 0) return empty(w, 'GPU 랙이 배치되지 않아 학습 시뮬레이션을 수행할 수 없습니다.', 'No GPU rack is placed — the training simulation cannot run.');
  if (!t) return empty(w, '학습 파라미터(training)가 정의되지 않았습니다.', 'Training parameters are not defined.');
  // training memory (workload/training.ts) is estimated BEFORE any early return so the validator and the panel always see it;
  // a floor that does not fit (one sequence, full recompute, ZeRO-3) is a hard stop — no schedule can rescue it
  const allocatedRaw = Math.floor(clamp(w.gpuShare, 0, 1) * env.clusterGpus);
  const memory = trainingMemoryEstimate(w, { tp: t.tp, cp: t.cp ?? 1, pp: t.pp, ep: t.ep }, c.gpuMemoryGB ?? 0, c.scaleUp.domainSize, allocatedRaw);
  const memFields = memory ? { memory, allocatedGpus: allocatedRaw } : { allocatedGpus: allocatedRaw };
  if (memory && !memory.floorFits) return { ...empty(w, `GPU당 최소 메모리 ${memory.floorGBPerGpu.toFixed(0)} GB(시퀀스 1개 · 전체 재계산 · ZeRO-3)가 가용 HBM ${memory.usableHbmGB.toFixed(0)} GB를 넘습니다 — TP/PP/CP를 늘리세요.`, `Per-GPU memory floor ${memory.floorGBPerGpu.toFixed(0)} GB (one sequence · full recompute · ZeRO-3) exceeds the usable ${memory.usableHbmGB.toFixed(0)} GB HBM — raise TP/PP/CP.`), ...memFields, memoryInfeasible: true };
  const notes: string[] = [];
  const notesEn: string[] = [];
  const note = (ko: string, en: string) => {
    notes.push(ko);
    notesEn.push(en);
  };
  // v2: the traffic engine's report for this blueprint is the single step-time model (compute, exposed communication, MFU)
  const tr = env.traffic && env.traffic.workloadId === w.id && env.traffic.computeTimeS !== undefined ? env.traffic : undefined;
  const cpDeg = Math.max(1, Math.round(t.cp ?? 1));
  const tpp = Math.max(1, t.tp * t.pp * (tr ? cpDeg : 1));
  const gpus = Math.floor((clamp(w.gpuShare, 0, 1) * env.clusterGpus) / tpp) * tpp;
  if (gpus < tpp) return { ...empty(w, `GPU ${Math.floor(w.gpuShare * env.clusterGpus)}개로는 TP×PP=${tpp} 모델 병렬 그룹을 구성할 수 없습니다.`, `${Math.floor(w.gpuShare * env.clusterGpus)} GPUs cannot form a TP×PP=${tpp} model-parallel group.`), ...memFields };
  const dp = gpus / tpp;
  const prec = PRECISION[t.precision] ?? 1;
  const nActive = w.model.activeParamsB * 1e9;
  const nTotal = w.model.paramsB * 1e9;
  const tokensStep = t.globalBatchTokensM * 1e6;
  const scaleUpBps = (c.scaleUp.gbpsPerGpu / 2) * 1e9;
  const soBps = c.scaleOutPortGbps * c.scaleOutPortsPerGpu * env.commEfficiency * 1e9;

  // v2 2차 (T6): an assumed / calibrated MFU (compute-path incl. bubble, same convention as traffic.ts) replaces the v1 kernel factor
  const mfuIn = t.mfuAssumed && t.mfuAssumed > 0 ? clamp(t.mfuAssumed, 0.05, 1) : undefined;
  const compute = mfuIn ? (6 * nActive * tokensStep) / (gpus * peakFlopsFor(c, t.precision) * mfuIn) : (6 * nActive * tokensStep) / (gpus * c.gpuFlopsPeak * prec * 0.55);
  const tokensPerReplica = tokensStep / dp;
  const micro = Math.max(1, Math.round(tokensPerReplica / w.model.seqLen));
  const bubble = t.pp > 1 ? (t.pp - 1) / (micro + t.pp - 1) : 0;
  const computeTime = mfuIn ? compute : compute / (1 - bubble);
  if (w.calibration?.mode === 'training' && w.calibration.tflopsPerGpu) note(`벤치마크 보정: 유효 ${Math.round(w.calibration.tflopsPerGpu / 1e12).toLocaleString('en-US')} TFLOP/s/GPU → MFU ${((t.mfuAssumed ?? 0) * 100).toFixed(1)} % (${w.calibration.source}).`, `Benchmark calibration: effective ${Math.round(w.calibration.tflopsPerGpu / 1e12).toLocaleString('en-US')} TFLOP/s per GPU → MFU ${((t.mfuAssumed ?? 0) * 100).toFixed(1)} % (${w.calibration.source}).`);
  const layersPerStage = w.model.layers / t.pp;
  const tpBps = t.tp <= c.scaleUp.domainSize ? scaleUpBps : soBps;
  const tpTime = t.tp > 1 ? (4 * layersPerStage * w.model.hiddenSize * 16 * tokensPerReplica * (2 * (t.tp - 1)) / t.tp) / tpBps : 0;
  const ppBps = tpp <= c.scaleUp.domainSize ? scaleUpBps : soBps;
  const ppTime = t.pp > 1 ? ((t.pp - 1) * 2 * micro * w.model.seqLen * w.model.hiddenSize * 16) / t.tp / ppBps : 0;
  const dpRaw = dp > 1 && soBps > 0 ? ((2 * (dp - 1)) / dp) * ((nTotal / tpp) * 16) / soBps : 0;
  const dpTime = dpRaw * 0.4;
  const epTime = t.ep > 1 && soBps > 0 ? (4 * layersPerStage * w.model.hiddenSize * 16 * tokensPerReplica * ((t.ep - 1) / t.ep) * 0.5) / soBps : 0;
  const commTimeV1 = tpTime + ppTime + dpTime + epTime;
  const scaleLog = Math.log2(Math.max(1, dp / 8));
  const jitter = clamp(1 - 0.015 * scaleLog, 0.7, 1);
  // collectives finish with the slowest flow: tail latency grows with scale on less efficient fabrics
  const congestionV1 = 1 + (1 - env.commEfficiency) * 0.15 * scaleLog;
  const stepTimeV1 = ((computeTime + commTimeV1) / jitter) * congestionV1;
  // ── one step-time convention (QA-network-v2 #3): with a traffic report, compute time = FLOP/step ÷ (GPUs · peak · assumed MFU),
  //    communication = exposed (non-overlapped) time from the bytes-per-tier model, step = compute + exposed, MFU = derived
  //    (FLOP/step ÷ (GPUs · peak · step)); the v1 kernel-efficiency model is the fallback without a report
  const computeTimeEff = tr ? tr.computeTimeS! : computeTime;
  const commTime = tr ? (tr.exposedCommS ?? Math.max(0, tr.stepTimeS - tr.computeTimeS!)) : commTimeV1;
  const commTotal = tr ? (tr.commTimeS ?? commTime) : commTimeV1;
  const stepTime = tr ? tr.stepTimeS : stepTimeV1;
  const congestion = tr ? 1 : congestionV1;
  const tokensPerSec = tokensStep / stepTime;
  const mfu = tr && tr.mfuEffective !== undefined ? tr.mfuEffective : (6 * nActive * tokensPerSec) / (gpus * c.gpuFlopsPeak);
  if (tr) note(`스텝 시간 ${stepTime.toFixed(2)} s = 연산 ${computeTimeEff.toFixed(2)} s + 노출 통신 ${commTime.toFixed(2)} s (트래픽 엔진, 통신 총 ${commTotal.toFixed(2)} s 중 겹침 제외) · MFU ${(mfu * 100).toFixed(1)} % (유도값).`, `Step time ${stepTime.toFixed(2)} s = compute ${computeTimeEff.toFixed(2)} s + exposed communication ${commTime.toFixed(2)} s (traffic engine; ${commTotal.toFixed(2)} s total communication before overlap) · MFU ${(mfu * 100).toFixed(1)} % (derived).`);
  if (memory && !memory.fits) note(`GPU당 메모리 ${memory.totalGBPerGpu.toFixed(0)} GB가 가용 HBM ${memory.usableHbmGB.toFixed(0)} GB(물리 ${memory.gpuMemoryGB} GB, 예비 ${Math.round(memory.reserveBand[1] * 100)} %)를 넘습니다 — 스텝 모델은 계산했지만 이 구성은 그대로 실행되지 않습니다.`, `Per-GPU memory ${memory.totalGBPerGpu.toFixed(0)} GB exceeds the usable ${memory.usableHbmGB.toFixed(0)} GB HBM (${memory.gpuMemoryGB} GB physical, ${Math.round(memory.reserveBand[1] * 100)} % reserve) — the step model is computed, but this configuration will not run as is.`);
  if (t.tp > c.scaleUp.domainSize) note(`TP=${t.tp}가 scale-up 도메인(${c.scaleUp.domainSize})을 초과해 텐서 병렬 통신이 scale-out 네트워크로 흐릅니다.`, `TP=${t.tp} exceeds the scale-up domain (${c.scaleUp.domainSize}) — tensor-parallel traffic uses the scale-out network.`);
  if (tpp > c.scaleUp.domainSize) note(`TP×PP=${tpp}가 scale-up 도메인을 넘어 파이프라인 통신이 scale-out을 사용합니다.`, `TP×PP=${tpp} exceeds the scale-up domain — pipeline traffic uses the scale-out network.`);

  // reliability
  const mtbfS = (t.mtbfHoursPerGpu / gpus) * 3600;
  const tau = Math.max(60, t.checkpointEveryMin * 60);
  const delta = t.checkpointDurationS;
  const restart = 900;
  const ckptFrac = delta / tau;
  const failFrac = (tau / 2 + delta + restart) / mtbfS;
  const goodput = clamp(1 - ckptFrac - failFrac, 0.05, 1);
  const daly = Math.sqrt(2 * delta * mtbfS);
  note(`클러스터 MTBF ≈ ${(mtbfS / 3600).toFixed(1)} h, 체크포인트 ${Math.round(tau / 60)}분 주기 (Young/Daly 최적 ≈ ${Math.round(daly / 60)}분).`, `Cluster MTBF ≈ ${(mtbfS / 3600).toFixed(1)} h, checkpoint every ${Math.round(tau / 60)} min (Young/Daly optimum ≈ ${Math.round(daly / 60)} min).`);
  const timeToTrainDays = (t.tokensB * 1e9) / (tokensPerSec * goodput) / 86400;

  // power trace
  const np = rack.power!;
  const racks = gpus / c.gpus;
  const netShare = env.networkKW * (gpus / Math.max(1, env.projectGpus ?? env.clusterGpus));
  const hi = np.nameplateKW * 0.97;
  const lo = np.nameplateKW * 0.55;
  const idle = np.idleKW;
  const computeFrac = computeTimeEff / Math.max(1e-9, computeTimeEff + commTime);
  const ckptStart = 240;
  const target: number[] = [];
  const utilArr: number[] = [];
  for (let s = 0; s < WINDOW_S; s++) {
    if (s >= ckptStart && s < ckptStart + delta) {
      target.push(racks * idle + netShare);
      utilArr.push(0.05);
      continue;
    }
    let inCompute = 0;
    for (let k = 0; k < 10; k++) {
      const phase = (((s + k / 10) % stepTime) + stepTime) % stepTime;
      if (phase < computeFrac * stepTime) inCompute++;
    }
    const f = inCompute / 10;
    target.push(racks * (lo + (hi - lo) * f) + netShare);
    utilArr.push(0.35 + 0.65 * f);
  }
  const ramp = (np.rampUpKWps ?? np.nameplateKW) * racks;
  const trace = shapeTrace(target, ramp, racks * np.nameplateKW * 0.9 + netShare, env.powerSmoothing, (i) => utilArr[i]);
  const steady = racks * (lo + (hi - lo) * computeFrac) + netShare;
  const floorKW = racks * np.nameplateKW * 0.9 + netShare;
  const steadyEff = env.powerSmoothing === 'rack-level' ? Math.max(steady, floorKW) : steady;
  const idleEff = env.powerSmoothing === 'rack-level' ? floorKW : racks * idle + netShare;
  const downFrac = restart / mtbfS;
  const avgPowerKW = steadyEff * (1 - ckptFrac - downFrac) + idleEff * (ckptFrac + downFrac);
  const peakPowerKW = Math.max(...trace.map((p) => p.powerKW));
  const hours = 24 * w.durationDays;
  const energyMWh = (avgPowerKW * env.pue * hours) / 1000;
  if (env.powerSmoothing === 'none') note('전력 평활화 미적용: 스텝 단위 전력 스윙이 수 MW 규모로 계통에 전달됩니다.', 'No power smoothing: step-level power swings of several MW reach the grid.');

  return {
    workloadId: w.id,
    gpus,
    stepTimeS: stepTime,
    computeTimeS: computeTimeEff,
    commTimeS: commTime,
    tokensPerSec,
    mfu,
    timeToTrainDays,
    goodput,
    avgPowerKW,
    peakPowerKW,
    energyMWh,
    energyCostUSD: energyMWh * 1000 * env.electricityUSDPerKWh,
    tokensPerKWh: (tokensPerSec * goodput * 3600) / (avgPowerKW * env.pue),
    powerTrace: trace,
    notes,
    notesEn,
    details: { dp, microBatches: micro, bubble, tpCommS: tpTime, ppCommS: ppTime, dpCommS: dpTime, epCommS: epTime, congestionFactor: congestion, clusterMtbfH: mtbfS / 3600, dalyOptimalMin: daly / 60, racks, commTotalS: commTotal, stepModel: tr ? 'traffic-v2' : 'v1' },
    ...memFields,
    ...(memory ? { memoryOverBudget: !memory.fits } : {}),
  };
}

export function simulateInference(w: WorkloadBlueprint, env: WorkloadEnv): WorkloadAnalysis {
  const rack = env.gpuRack;
  const c = rack?.compute;
  const inf = w.inference;
  if (!rack || !c || c.gpus <= 0) return empty(w, 'GPU 랙이 배치되지 않아 추론 시뮬레이션을 수행할 수 없습니다.', 'No GPU rack is placed — the inference simulation cannot run.');
  if (!inf) return empty(w, '추론 파라미터(inference)가 정의되지 않았습니다.', 'Inference parameters are not defined.');
  const prompt = inferencePromptTokens(inf);
  const notes: string[] = [];
  const notesEn: string[] = [];
  const note = (ko: string, en: string) => {
    notes.push(ko);
    notesEn.push(en);
  };
  const gpus = Math.floor(clamp(w.gpuShare, 0, 1) * env.clusterGpus);
  const nActive = w.model.activeParamsB * 1e9;
  const weightBytes = inf.weightPrecision === 'fp16' || inf.weightPrecision === 'bf16' ? 2 : inf.weightPrecision === 'fp4' ? 0.5 : 1;
  const weightsGB = w.model.paramsB * weightBytes;
  const activeGB = w.model.activeParamsB * weightBytes;
  const baseTopology: InferenceParallelism = { tp: 1, pp: 1, ep: 1, cp: 1 };
  const autoTp = inferenceMemoryEstimate(w, 'aggregated', baseTopology, c.gpuMemoryGB, c.scaleUp.domainSize)?.minimumTp ?? Math.max(1, c.scaleUp.domainSize);
  const fallback: InferenceParallelism = { ...baseTopology, tp: autoTp };
  const aggregated = inferenceParallelismFor(inf, 'aggregated', fallback);
  const prefill = inferenceParallelismFor(inf, 'prefill', fallback);
  const decode = inferenceParallelismFor(inf, 'decode', fallback);
  const prefillGpus = inferenceReplicaGpus(prefill);
  const decodeGpus = inferenceReplicaGpus(decode);
  const minDeploymentGpus = inf.disaggregated ? prefillGpus + decodeGpus : decodeGpus;
  const topo = (p: InferenceParallelism) => `TP${p.tp}·PP${p.pp}·EP${p.ep}·CP${p.cp}`;
  const stagePlans: ['aggregated' | 'prefill' | 'decode', InferenceParallelism][] = inf.disaggregated
    ? [['prefill', prefill], ['decode', decode]]
    : [['aggregated', aggregated]];
  const memoryPlans = stagePlans.map(([stage, p]) => inferenceMemoryEstimate(w, stage, p, c.gpuMemoryGB, c.scaleUp.domainSize)!);
  const badMemory = memoryPlans.find((plan) => !plan.fits);
  if (badMemory) {
    const stage = badMemory.stage;
    const p = badMemory.topology;
    const minimum = badMemory.minimumTp ? ` 최소 TP${badMemory.minimumTp}` : ' 현재 PP/EP/CP 조합으로 산정 범위 내 해 없음';
    return empty(
      w,
      `${stage} ${topo(p)}의 GPU당 메모리 추정치(가중치 ${badMemory.weightGBPerGpu.toFixed(1)} + 1개 시퀀스 KV ${badMemory.kvGBPerGpu.toFixed(1)} GB)가 가용 HBM ${badMemory.usableHbmGB.toFixed(1)} GB를 넘습니다.${minimum}; 필요하면 PP${w.model.moe ? '/EP' : ''} 또는 정밀도를 조정하세요.`,
      `Estimated per-GPU memory for ${stage} ${topo(p)} (weights ${badMemory.weightGBPerGpu.toFixed(1)} + one-sequence KV ${badMemory.kvGBPerGpu.toFixed(1)} GB) exceeds ${badMemory.usableHbmGB.toFixed(1)} GB usable HBM.${badMemory.minimumTp ? ` Minimum TP${badMemory.minimumTp}` : ' No fit was found in the sizing range with the current PP/EP/CP'}; adjust PP${w.model.moe ? '/EP' : ''} or precision if needed.`,
    );
  }
  if (gpus < minDeploymentGpus) return empty(w, `할당 GPU ${gpus}개가 최소 서빙 단위(${minDeploymentGpus} GPU)보다 작습니다.`, `Allocated GPUs (${gpus}) are fewer than the minimum serving unit (${minDeploymentGpus} GPUs).`);
  if (!w.model.moe && (prefill.ep > 1 || decode.ep > 1)) note('Dense 모델에서 EP는 모델을 샤딩하지 않으므로 GPU만 추가하고 처리량 이점은 반영하지 않습니다.', 'EP does not shard a dense model; it only adds GPUs and no throughput benefit is credited.');
  if (Math.max(prefillGpus, decodeGpus) > c.scaleUp.domainSize) note(`인스턴스가 scale-up 도메인(${c.scaleUp.domainSize} GPU)을 넘어 TP/PP/EP/CP 통신 일부가 scale-out으로 흐릅니다.`, `A replica exceeds the ${c.scaleUp.domainSize}-GPU scale-up domain; some TP/PP/EP/CP traffic uses scale-out.`);
  note(
    inf.disaggregated
      ? `P/D 토폴로지: prefill ${topo(prefill)} = ${prefillGpus} GPU, decode ${topo(decode)} = ${decodeGpus} GPU.`
      : `통합형 토폴로지: ${topo(aggregated)} = ${decodeGpus} GPU/인스턴스.`,
    inf.disaggregated
      ? `P/D topology: prefill ${topo(prefill)} = ${prefillGpus} GPUs, decode ${topo(decode)} = ${decodeGpus} GPUs.`
      : `Aggregated topology: ${topo(aggregated)} = ${decodeGpus} GPUs per instance.`,
  );
  if (prompt.cached > 0) note(
    prompt.mode === 'trace'
      ? `AgentX trace cache 보정: 입력 ${Math.round(prompt.input).toLocaleString('en-US')} 토큰 중 GPU KV ${Math.round(prompt.gpuCached).toLocaleString('en-US')} + 원격 KV ${Math.round(prompt.remoteCached).toLocaleString('en-US')}를 재사용하고 ${Math.round(prompt.uncached).toLocaleString('en-US')} 토큰만 새로 prefill합니다. CPU/external hit는 중복 합산하지 않고 큰 값을 사용했습니다. KV HBM 산정은 전체 컨텍스트를 유지합니다.`
      : `Prefix cache: 입력 ${Math.round(prompt.input).toLocaleString('en-US')} 토큰 중 ${Math.round(prompt.cached).toLocaleString('en-US')}(${(prompt.hitRatio * 100).toFixed(1)}%)은 warm KV로 재사용하고 ${Math.round(prompt.uncached).toLocaleString('en-US')} 토큰만 새로 prefill합니다. KV HBM은 전체 컨텍스트를 유지합니다.`,
    prompt.mode === 'trace'
      ? `AgentX trace cache calibration: ${Math.round(prompt.gpuCached).toLocaleString('en-US')} GPU-KV plus ${Math.round(prompt.remoteCached).toLocaleString('en-US')} remote-KV tokens are reused from ${Math.round(prompt.input).toLocaleString('en-US')} input tokens; only ${Math.round(prompt.uncached).toLocaleString('en-US')} tokens run new prefill. CPU/external hits are not added because they can overlap; the larger rate is used. Full-context KV remains in memory sizing.`
      : `Prefix cache: ${Math.round(prompt.cached).toLocaleString('en-US')} of ${Math.round(prompt.input).toLocaleString('en-US')} input tokens (${(prompt.hitRatio * 100).toFixed(1)}%) reuse warm KV; only ${Math.round(prompt.uncached).toLocaleString('en-US')} tokens run new prefill. KV HBM still retains the full context.`,
  );
  // HBM bandwidth per GPU from the catalog (memBandwidthGBps); FLOPS-scaled proxy only for legacy items without it
  const perGpuMbw = c.memBandwidthGBps ?? (1300 * c.gpuFlopsPeak) / 2.3e15;
  const effectiveStageGpus = (p: InferenceParallelism) => inferenceReplicaGpus(
    w.model.moe ? p : { ...p, ep: 1 },
  );
  const prefillEffectiveGpus = effectiveStageGpus(prefill);
  const decodeEffectiveGpus = effectiveStageGpus(decode);
  const decodeMbw = decodeEffectiveGpus * perGpuMbw * 0.85; // GB/s
  const kvBytes = inf.kvPrecision === 'fp16' || inf.kvPrecision === 'bf16' ? 2 : inf.kvPrecision === 'fp4' ? 0.5 : 1;
  const heads = Math.max(1, w.model.numHeads ?? Math.round(w.model.hiddenSize / 128));
  const kvHeads = Math.max(1, w.model.kvHeads ?? heads);
  const headDim = w.model.headDim && w.model.headDim > 0 ? w.model.headDim : w.model.hiddenSize / heads;
  const kvLayerFraction = Math.min(1, Math.max(0, w.model.kvCacheLayerFraction ?? 1));
  const kvPerTokenGB = w.model.mla
    ? (w.model.layers * kvLayerFraction * (w.model.mla.dLatent + w.model.mla.dRope) * kvBytes) / 1e9
    : (2 * w.model.layers * kvLayerFraction * kvHeads * headDim * kvBytes) / 1e9;
  const kvTokens = w.model.mla ? inf.inputTokens + inf.outputTokens / 2 : kvSeqEffective(inf.inputTokens + inf.outputTokens / 2, w.model.attentionWindow, w.model.globalLayerInterval);
  const kvSeqGB = kvPerTokenGB * kvTokens;
  const prefillFlopsEff = prefillEffectiveGpus * c.gpuFlopsPeak * 1.3;
  const decodeFlopsEff = decodeEffectiveGpus * c.gpuFlopsPeak * 1.3;
  const soGbps = c.scaleOutPortGbps * c.scaleOutPortsPerGpu * env.commEfficiency;
  const scaleUpBps = (c.scaleUp.gbpsPerGpu / 8 / 2) * 1e9 * 0.8;
  const scaleOutBps = (soGbps / 8) * 1e9;
  // Forward-pass communication estimate per generated/input token. Latency and kernel scheduling still require a benchmark calibration.
  const stageCommS = (p: InferenceParallelism) => {
    const L = Math.max(1, w.model.layers);
    const h = Math.max(1, w.model.hiddenSize);
    const tpBytes = p.tp > 1 ? 4 * L * h * 2 * ((p.tp - 1) / p.tp) : 0;
    const cpBytes = p.cp > 1 ? 2 * L * h * kvBytes * ((p.cp - 1) / p.cp) : 0;
    const ppBytes = p.pp > 1 ? (p.pp - 1) * h * 2 : 0;
    const epBytes = w.model.moe && p.ep > 1 ? moeLayerCount(L, w.model.moe) * Math.max(1, w.model.moe.topK) * h * 3 * ((p.ep - 1) / p.ep) : 0;
    const bytes = tpBytes + cpBytes + ppBytes + epBytes;
    const inDomain = inferenceReplicaGpus(w.model.moe ? p : { ...p, ep: 1 }) <= c.scaleUp.domainSize;
    const bw = inDomain ? scaleUpBps : scaleOutBps;
    return bw > 0 ? bytes / bw : bytes > 0 ? Number.POSITIVE_INFINITY : 0;
  };
  const prefillCommSPerToken = stageCommS(prefill);
  const decodeCommSPerToken = stageCommS(decode);
  if (prefillCommSPerToken > 0 || decodeCommSPerToken > 0) note(
    `병렬 통신 추정: prefill ${(prefillCommSPerToken * 1e6).toFixed(1)} µs/token, decode ${(decodeCommSPerToken * 1e6).toFixed(1)} µs/token (TP/PP/EP/CP 바이트와 ${Math.max(prefillGpus, decodeGpus) <= c.scaleUp.domainSize ? 'scale-up' : 'scale-out'} 유효 대역폭 기준).`,
    `Estimated parallel communication: prefill ${(prefillCommSPerToken * 1e6).toFixed(1)} µs/token, decode ${(decodeCommSPerToken * 1e6).toFixed(1)} µs/token (TP/PP/EP/CP bytes and effective ${Math.max(prefillGpus, decodeGpus) <= c.scaleUp.domainSize ? 'scale-up' : 'scale-out'} bandwidth).`,
  );
  const kCompute = (2 * nActive) / (decodeFlopsEff * 0.5);
  const weightRead = (b: number) => Math.min(weightsGB, activeGB * (1 + 0.1 * Math.log2(1 + b)));
  const tpot = (b: number) => weightRead(b) / decodeMbw + b * (kvSeqGB / decodeMbw + kCompute + decodeCommSPerToken);
  const decodeMemory = memoryPlans.find((plan) => plan.stage === 'decode' || plan.stage === 'aggregated')!;
  const decodeFreeGBPerGpu = Math.max(0, decodeMemory.usableHbmGB - decodeMemory.weightGBPerGpu);
  const bMem = Math.max(1, Math.floor(decodeFreeGBPerGpu / Math.max(1e-9, decodeMemory.kvGBPerGpu)));
  const slo = inf.tpotSloMs / 1000;
  let lo = 1;
  let hi = bMem;
  if (tpot(1) > slo) {
    hi = 1;
    note(`단일 시퀀스 TPOT(${(tpot(1) * 1000).toFixed(1)} ms)가 SLO ${inf.tpotSloMs} ms를 초과합니다.`, `Single-sequence TPOT (${(tpot(1) * 1000).toFixed(1)} ms) exceeds the SLO ${inf.tpotSloMs} ms.`);
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tpot(mid) <= slo) lo = mid;
    else hi = mid - 1;
  }
  const bStar = lo;
  const decodeRate = bStar / tpot(bStar);
  const prefillComputeRate = (prefillFlopsEff * 0.55) / (2 * nActive + 2 * w.model.layers * Math.max(1, prompt.uncached) * w.model.hiddenSize);
  const prefillRate = 1 / (1 / prefillComputeRate + prefillCommSPerToken);
  const service = prompt.uncached / prefillRate;
  const prefillDemand = inf.requestsPerSec * prompt.uncached;
  const decodeDemand = inf.requestsPerSec * inf.outputTokens;
  let prefillInstances = 0;
  let decodeInstances = 0;
  let aggregatedInstances = 0;
  let ttft: number;
  let tpotAct: number;
  const cacheTransferGbps = soGbps * Math.max(1, Math.min(prefillGpus, decodeGpus));
  const kvTransfer = cacheTransferGbps > 0 ? (kvPerTokenGB * prompt.transfer * 8) / cacheTransferGbps : 0;
  if (inf.disaggregated) {
    prefillInstances = Math.max(1, Math.ceil(prefillDemand / (prefillRate * 0.7)));
    decodeInstances = Math.max(1, Math.ceil(decodeDemand / decodeRate));
    const rho = prefillDemand / (prefillInstances * prefillRate);
    ttft = service / Math.max(0.05, 1 - rho) + kvTransfer;
    const bAct = Math.min(bStar, Math.max(1, (decodeDemand / decodeInstances) * tpot(bStar)));
    tpotAct = tpot(bAct);
    note(`목표 수요 역산(배치 풀 제한 전): prefill DP${prefillInstances} × ${prefillGpus} GPU, decode DP${decodeInstances} × ${decodeGpus} GPU.`, `Target-demand sizing before the placed-pool limit: prefill DP${prefillInstances} × ${prefillGpus} GPUs and decode DP${decodeInstances} × ${decodeGpus} GPUs.`);
  } else {
    // Closed-form instance count. This used to be an incremental search that gave up at a 200,000-iteration guard,
    // so a high offered rate exited on the loop constant instead of on the model: the instance count — and the pool
    // capacity that divides by it — became a function of how many iterations were allowed rather than of the
    // hardware, and the reported capacity scaled with whatever request rate happened to be configured.
    // Both gates are monotone in n, so the answer is the largest of their thresholds:
    //   prefill share   p(n) = A / n < 0.6,   A = rps · uncached / prefillRate
    //   decode headroom decodeDemand / n ≤ decodeRate · (1 − p(n)) · 0.85
    //                 ⇒ n ≥ decodeDemand / (0.85 · decodeRate) + A
    // Where the old search converged it returned exactly this smallest n, so converged cases are unchanged.
    const prefillLoad = (inf.requestsPerSec * prompt.uncached) / Math.max(1e-9, prefillRate);
    const nDecodeOnly = Math.max(1, Math.ceil(decodeDemand / Math.max(1e-9, decodeRate)));
    const nPrefillShare = Math.floor(prefillLoad / 0.6) + 1; // strict: p < 0.6
    const nDecodeHeadroom = Math.ceil(decodeDemand / Math.max(1e-9, 0.85 * decodeRate) + prefillLoad);
    const solved = Math.max(nDecodeOnly, nPrefillShare, nDecodeHeadroom);
    const n = Number.isFinite(solved) ? solved : nDecodeOnly;
    const p = prefillLoad / n;
    aggregatedInstances = n;
    ttft = (service / Math.max(0.05, 1 - p)) * 1.3 + kvTransfer;
    tpotAct = tpot(bStar) / Math.max(0.05, 1 - p);
    note(`통합형 서빙: ${n} × ${decodeGpus} GPU 인스턴스 (prefill 점유율 ${(p * 100).toFixed(0)}%).`, `Aggregated serving: ${n} × ${decodeGpus} GPU instances (prefill share ${(p * 100).toFixed(0)} %).`);
  }
  // v2 2차 (T6, F9): a benchmark calibration (output tokens/s per GPU at the stated interactivity, workload/calibration.ts)
  // replaces the decode-capacity model for sizing: GPUs = requests/s × output tokens ÷ tok/s per GPU, whole instances
  const storedCalibration = w.calibration;
  const storedBenchmark = storedCalibration?.benchmarkId ? findBenchmark(storedCalibration.benchmarkId) : undefined;
  const signatureMatches = !storedCalibration?.workloadSignature || storedCalibration.workloadSignature === inferenceCalibrationSignature(w);
  const staticModelMatches = !storedBenchmark || !w.presetId || storedBenchmark.model === w.presetId;
  // Live InferenceX rows saved before workload signatures existed cannot be proven to match after a preset or
  // topology change. Static bundled rows still have a model identity, while an unbound user measurement remains
  // the user's explicit local evidence.
  const legacyUnboundInferenceX = !!storedCalibration?.benchmarkId?.startsWith('ix-') && !storedCalibration.workloadSignature;
  const calibrationMatches = signatureMatches && staticModelMatches && !legacyUnboundInferenceX;
  const calTok = calibrationMatches && storedCalibration?.mode === 'inference' && storedCalibration.tokensPerSecPerGpu && storedCalibration.tokensPerSecPerGpu > 0
    ? storedCalibration.tokensPerSecPerGpu
    : undefined;
  if (storedCalibration?.mode === 'inference' && !calibrationMatches) note(
    '현재 모델·요청 길이·정밀도·서빙 토폴로지와 맞지 않는 이전 추론 보정은 계산에서 제외했습니다. 현재 조건으로 InferenceX 또는 사용자 측정을 다시 적용하세요.',
    'A previous inference calibration does not match the current model, request shape, precision, or serving topology and was excluded. Re-apply an InferenceX or user measurement for the current conditions.',
  );
  if (calTok) {
    const modelInstances = inf.disaggregated ? decodeInstances : aggregatedInstances;
    const calibratedInstances = Math.max(1, Math.ceil(decodeDemand / (calTok * decodeGpus)));
    if (inf.disaggregated) decodeInstances = calibratedInstances;
    else aggregatedInstances = calibratedInstances;
    note(`벤치마크 보정: GPU당 출력 ${Math.round(calTok).toLocaleString('en-US')} tok/s → decode ${calibratedInstances} × ${decodeGpus} GPU (보정 전 모델 ${modelInstances}개; ${w.calibration!.source}).`, `Benchmark calibration: ${Math.round(calTok).toLocaleString('en-US')} output tok/s per GPU → ${calibratedInstances} decode × ${decodeGpus} GPUs (uncalibrated model ${modelInstances}; ${w.calibration!.source}).`);
  }
  const prefillRequiredInstances = prefillInstances;
  const decodeRequiredInstances = inf.disaggregated ? decodeInstances : aggregatedInstances;
  const gpusRequired = inf.disaggregated
    ? prefillRequiredInstances * prefillGpus + decodeRequiredInstances * decodeGpus
    : aggregatedInstances * decodeGpus;
  let deployedPrefillInstances = 0;
  let deployedDecodeInstances = 0;
  let poolCapacityRps = 0;
  if (inf.disaggregated) {
    const prefillCapacityRps = prompt.uncached > 0 ? (prefillRate * 0.7) / prompt.uncached : Number.POSITIVE_INFINITY;
    const decodeCapacityRps = inf.outputTokens > 0 ? ((calTok ? calTok * decodeGpus : decodeRate) / inf.outputTokens) : Number.POSITIVE_INFINITY;
    const requestedPrefillDp = prefill.dp;
    const requestedDecodeDp = decode.dp;
    const requestedPoolGpus = (requestedPrefillDp ?? 0) * prefillGpus + (requestedDecodeDp ?? 0) * decodeGpus;
    if (requestedPrefillDp && requestedDecodeDp && requestedPoolGpus <= gpus) {
      deployedPrefillInstances = requestedPrefillDp;
      deployedDecodeInstances = requestedDecodeDp;
    } else {
      // Allocate whole replicas on the placed GPU pool. An explicit DP is fixed when it fits; otherwise it is a cap and
      // the best balanced feasible P/D pair is selected, making an over-sized request visible without fractional replicas.
      const maxPrefill = Math.max(1, Math.min(requestedPrefillDp ?? prefillRequiredInstances, Math.floor((gpus - decodeGpus) / prefillGpus)));
      const maxDecode = Math.max(1, Math.min(requestedDecodeDp ?? decodeRequiredInstances, Math.floor((gpus - prefillGpus) / decodeGpus)));
      let bestCapacity = -1;
      let bestGpus = Number.POSITIVE_INFINITY;
      for (let p = requestedPrefillDp && requestedPoolGpus <= gpus ? requestedPrefillDp : 1; p <= maxPrefill; p++) {
        const remaining = gpus - p * prefillGpus;
        if (remaining < decodeGpus) continue;
        const d = requestedDecodeDp && p * prefillGpus + requestedDecodeDp * decodeGpus <= gpus
          ? requestedDecodeDp
          : Math.max(1, Math.min(maxDecode, Math.floor(remaining / decodeGpus)));
        const capacity = Math.min(p * prefillCapacityRps, d * decodeCapacityRps);
        const used = p * prefillGpus + d * decodeGpus;
        if (capacity > bestCapacity + 1e-9 || (Math.abs(capacity - bestCapacity) <= 1e-9 && used < bestGpus)) {
          bestCapacity = capacity;
          bestGpus = used;
          deployedPrefillInstances = p;
          deployedDecodeInstances = d;
        }
      }
    }
    poolCapacityRps = Math.min(deployedPrefillInstances * prefillCapacityRps, deployedDecodeInstances * decodeCapacityRps);
    const achievedForLatency = Math.min(inf.requestsPerSec, poolCapacityRps);
    const achievedPrefillDemand = achievedForLatency * prompt.uncached;
    const rho = achievedPrefillDemand / Math.max(1e-9, deployedPrefillInstances * prefillRate);
    ttft = service / Math.max(0.05, 1 - rho) + kvTransfer;
    const achievedDecodeDemand = achievedForLatency * inf.outputTokens;
    const bAct = Math.min(bStar, Math.max(1, (achievedDecodeDemand / Math.max(1, deployedDecodeInstances)) * tpot(bStar)));
    tpotAct = tpot(bAct);
    note(
      `배치 풀: prefill DP${deployedPrefillInstances} × ${prefillGpus} GPU, decode DP${deployedDecodeInstances} × ${decodeGpus} GPU${prefill.dp || decode.dp ? ' (사용자 DP 반영)' : ' (배치 GPU에서 자동 할당)'}.`,
      `Placed pools: prefill DP${deployedPrefillInstances} × ${prefillGpus} GPUs and decode DP${deployedDecodeInstances} × ${decodeGpus} GPUs${prefill.dp || decode.dp ? ' (user DP applied)' : ' (auto-allocated on placed GPUs)'}.`,
    );
    if (requestedPoolGpus > gpus) note(
      `지정한 P/D DP 풀은 ${requestedPoolGpus} GPU가 필요해 할당 ${gpus} GPU에 들어가지 않습니다. 위 결과는 그 DP를 상한으로 사용한 최적의 정수 복제본 배치입니다.`,
      `The requested P/D DP pools need ${requestedPoolGpus} GPUs and do not fit in the ${gpus} allocated GPUs. The result uses the best whole-replica placement with those DP values as caps.`,
    );
  } else {
    const requestedDp = aggregated.dp;
    deployedDecodeInstances = Math.max(1, Math.min(requestedDp ?? aggregatedInstances, Math.floor(gpus / decodeGpus)));
    poolCapacityRps = calTok
      ? (deployedDecodeInstances * decodeGpus * calTok) / Math.max(1, inf.outputTokens)
      : (inf.requestsPerSec * deployedDecodeInstances) / Math.max(1, aggregatedInstances);
    const achievedForLatency = Math.min(inf.requestsPerSec, poolCapacityRps);
    const p = (achievedForLatency / Math.max(1, deployedDecodeInstances)) * prompt.uncached / prefillRate;
    ttft = (service / Math.max(0.05, 1 - p)) * 1.3 + kvTransfer;
    tpotAct = tpot(bStar) / Math.max(0.05, 1 - p);
    if (requestedDp) note(`배치 풀: 통합형 DP${deployedDecodeInstances} × ${decodeGpus} GPU (사용자 DP 반영).`, `Placed pool: aggregated DP${deployedDecodeInstances} × ${decodeGpus} GPUs (user DP applied).`);
  }
  const worstNetworkUtilization = env.traffic?.mode === 'inference' ? Math.max(0, ...env.traffic.perTier.map((tier) => tier.utilization)) : 0;
  // Utilisation is measured at the configured offered rate, so RPS/utilisation is the fabric's linearised capacity.
  // Do not clamp sub-100% utilisation to 1: that would rename current demand as the maximum achievable rate.
  const networkCapacityRps = worstNetworkUtilization > 0 ? inf.requestsPerSec / worstNetworkUtilization : poolCapacityRps;
  const maxRequestsPerSec = Math.min(poolCapacityRps, networkCapacityRps);
  if (worstNetworkUtilization > 1.001) note(
    `현재 패브릭의 제시 수요 병목(최대 ${worstNetworkUtilization.toFixed(1)}×)을 반영해 달성 요청률을 ${maxRequestsPerSec.toFixed(2)} req/s 이하로 제한했습니다. GPU 증설만으로는 이 한계가 해소되지 않습니다.`,
    `The offered-demand fabric bottleneck (up to ${worstNetworkUtilization.toFixed(1)}×) caps achievable rate at ${maxRequestsPerSec.toFixed(2)} req/s. Adding GPUs alone does not remove this limit.`,
  );
  if (gpusRequired > gpus) note(`목표 ${inf.requestsPerSec} req/s에는 GPU ${gpusRequired}개가 필요하지만 ${gpus}개만 할당되었습니다.`, `The target ${inf.requestsPerSec} req/s needs ${gpusRequired} GPUs but only ${gpus} are allocated.`);
  if (ttft * 1000 > inf.ttftSloMs) note(`예상 TTFT ${(ttft * 1000).toFixed(0)} ms가 SLO ${inf.ttftSloMs} ms를 초과합니다.`, `Predicted TTFT ${(ttft * 1000).toFixed(0)} ms exceeds the SLO ${inf.ttftSloMs} ms.`);

  // power
  const np = rack.power!;
  const racks = gpus / c.gpus;
  const u = clamp(inf.requestsPerSec / Math.max(1e-9, poolCapacityRps), 0, 1);
  const netShare = env.networkKW * (gpus / Math.max(1, env.projectGpus ?? env.clusterGpus));
  const rng = mulberry32(hash32(w.id));
  const target: number[] = [];
  const utilArr: number[] = [];
  for (let s = 0; s < WINDOW_S; s++) {
    const ut = clamp(u * (1 + 0.12 * Math.sin((2 * Math.PI * s) / 180) + 0.08 * (rng() - 0.5)), 0, 1);
    utilArr.push(ut);
    target.push(racks * (np.idleKW + (np.typicalKW - np.idleKW) * (0.25 + 0.75 * ut)) + netShare);
  }
  const trace = shapeTrace(target, (np.rampUpKWps ?? np.nameplateKW) * racks, racks * np.nameplateKW * 0.9 + netShare, env.powerSmoothing === 'rack-level' ? 'none' : env.powerSmoothing, (i) => utilArr[i]);
  const avgPowerKW = trace.reduce((a, p) => a + p.powerKW, 0) / trace.length;
  const peakPowerKW = Math.max(...trace.map((p) => p.powerKW));
  const energyMWh = (avgPowerKW * env.pue * 24 * w.durationDays) / 1000;
  const servedRps = Math.min(inf.requestsPerSec, maxRequestsPerSec);
  const requestedOutputTokensPerSec = inf.requestsPerSec * inf.outputTokens;
  const outputTokensPerSec = servedRps * inf.outputTokens;
  const totalTokensPerSec = servedRps * (inf.inputTokens + inf.outputTokens);
  const computedTokensPerSec = servedRps * (prompt.uncached + inf.outputTokens);
  const outputCapacityTokensPerSec = maxRequestsPerSec * inf.outputTokens;
  const modeledOutputTokensPerSecPerGpu = decodeRate / Math.max(1, decodeGpus);
  const designDecodeGpus = decodeRequiredInstances * decodeGpus;
  const placedDecodeGpus = deployedDecodeInstances * decodeGpus;
  const designOutputTokensPerSecPerGpu = requestedOutputTokensPerSec / Math.max(1, designDecodeGpus);
  const allocatedOutputTokensPerSecPerGpu = outputTokensPerSec / Math.max(1, placedDecodeGpus);

  return {
    workloadId: w.id,
    gpus,
    maxRequestsPerSec,
    servedRequestsPerSec: servedRps,
    requestedOutputTokensPerSec,
    outputTokensPerSec,
    totalTokensPerSec,
    computedTokensPerSec,
    outputCapacityTokensPerSec,
    ttftMs: ttft * 1000,
    tpotMs: tpotAct * 1000,
    gpusRequired,
    avgPowerKW,
    peakPowerKW,
    energyMWh,
    energyCostUSD: energyMWh * 1000 * env.electricityUSDPerKWh,
    tokensPerKWh: (servedRps * (inf.inputTokens + inf.outputTokens) * 3600) / (avgPowerKW * env.pue),
    powerTrace: trace,
    notes,
    notesEn,
    details: {
      instanceGpus: decodeGpus,
      prefillInstanceGpus: prefillGpus,
      decodeInstanceGpus: decodeGpus,
      prefillReplicas: inf.disaggregated ? deployedPrefillInstances : 0,
      decodeReplicas: deployedDecodeInstances,
      prefillRequiredReplicas: inf.disaggregated ? prefillRequiredInstances : 0,
      decodeRequiredReplicas: decodeRequiredInstances,
      configuredPrefillDp: prefill.dp ?? 0,
      configuredDecodeDp: (inf.disaggregated ? decode.dp : aggregated.dp) ?? 0,
      placedPoolGpus: inf.disaggregated ? deployedPrefillInstances * prefillGpus + deployedDecodeInstances * decodeGpus : deployedDecodeInstances * decodeGpus,
      computeCapacityRequestsPerSec: poolCapacityRps,
      networkCapacityRequestsPerSec: networkCapacityRps,
      calibrationApplied: calTok ? 1 : 0,
      topologyOutsideScaleUp: Math.max(prefillGpus, decodeGpus) > c.scaleUp.domainSize ? 1 : 0,
      prefillTp: prefill.tp, prefillPp: prefill.pp, prefillEp: prefill.ep, prefillCp: prefill.cp,
      prefillExpertMapping: prefill.expertMapping ?? 'shared',
      decodeTp: decode.tp, decodePp: decode.pp, decodeEp: decode.ep, decodeCp: decode.cp,
      decodeExpertMapping: decode.expertMapping ?? 'shared',
      maxBatch: bStar,
      decodeTokPerSecPerInstance: decodeRate,
      modeledOutputTokensPerSecPerGpu,
      designOutputTokensPerSecPerGpu,
      allocatedOutputTokensPerSecPerGpu,
      ...(calTok ? { calibratedOutputTokensPerSecPerGpu: calTok } : {}),
      prefillTokPerSecPerInstance: prefillRate,
      cachedPrefixTokens: prompt.cached,
      gpuCachedPrefixTokens: prompt.gpuCached,
      remoteCachedPrefixTokens: prompt.remoteCached,
      uncachedInputTokens: prompt.uncached,
      cacheTransferTokens: prompt.transfer,
      cacheMode: prompt.mode,
      prefillCommUsPerToken: prefillCommSPerToken * 1e6,
      decodeCommUsPerToken: decodeCommSPerToken * 1e6,
      memBandwidthGBps: decodeMbw,
      kvPerSeqGB: kvSeqGB,
      weightGBPerGpu: decodeMemory.weightGBPerGpu,
      kvGBPerGpuPerSequence: decodeMemory.kvGBPerGpu,
      usableHbmGB: decodeMemory.usableHbmGB,
      minimumTp: decodeMemory.minimumTp ?? 0,
    },
  };
}

export function simulateHpc(w: WorkloadBlueprint, env: WorkloadEnv): WorkloadAnalysis {
  const rack = env.gpuRack;
  if (!rack?.compute || !rack.power) return empty(w, 'GPU 랙이 배치되지 않았습니다.', 'No GPU rack is placed.');
  const gpus = Math.floor(clamp(w.gpuShare, 0, 1) * env.clusterGpus);
  const racks = gpus / rack.compute.gpus;
  const netShare = env.networkKW * (gpus / Math.max(1, env.projectGpus ?? env.clusterGpus));
  const rng = mulberry32(hash32(w.id));
  const target = Array.from({ length: WINDOW_S }, () => racks * rack.power!.typicalKW * (0.95 + 0.1 * rng()) + netShare);
  const trace = shapeTrace(target, (rack.power.rampUpKWps ?? rack.power.nameplateKW) * racks, 0, env.powerSmoothing === 'bess' ? 'bess' : 'none', () => 0.85);
  const avgPowerKW = trace.reduce((a, p) => a + p.powerKW, 0) / trace.length;
  const energyMWh = (avgPowerKW * env.pue * 24 * w.durationDays) / 1000;
  return {
    workloadId: w.id,
    gpus,
    avgPowerKW,
    peakPowerKW: Math.max(...trace.map((p) => p.powerKW)),
    energyMWh,
    energyCostUSD: energyMWh * 1000 * env.electricityUSDPerKWh,
    powerTrace: trace,
    notes: ['HPC 시뮬레이션은 전형적(typical) 전력의 ±5% 부하 프로파일로 근사합니다.'],
    notesEn: ['The HPC simulation approximates a ±5 % load profile around typical power.'],
  };
}

export function simulateWorkload(w: WorkloadBlueprint, env: WorkloadEnv): WorkloadAnalysis {
  switch (w.kind) {
    case 'llm-pretrain':
    case 'llm-finetune':
      return simulateTraining(w, env);
    case 'llm-inference':
      return simulateInference(w, env);
    default:
      return simulateHpc(w, env);
  }
}

export function analyzeWorkloadsCtx(ctx: Ctx, net: NetworkResult, power: Pick<PowerAnalysis, 'pue'>, trafficByWorkload?: ReadonlyMap<string, TrafficReport>): WorkloadAnalysis[] {
  const env = workloadEnv(ctx, net, power);
  // v2 2차 (T6, F9): Σ gpuShare > 1 → every blueprint is analysed at s_i / S (stored values unchanged; validate raises
  // 'workload-share-over' through workload/shares.ts shareIssues)
  const { total, state } = shareState(ctx.project.workloads);
  const eff = effectiveShares(ctx.project.workloads);
  return eff.map((w, i) => {
    const workloadTraffic = trafficByWorkload?.get(w.id);
    const workloadEnv = workloadTraffic
      ? { ...env, traffic: workloadTraffic, commEfficiency: workloadTraffic.commEfficiencyEffective }
      : env;
    const a = simulateWorkload(w, workloadEnv);
    if (state === 'over') {
      const s0 = ctx.project.workloads[i].gpuShare;
      a.notes.unshift(`GPU 비중 합계 ${(total * 100).toFixed(0)} % > 100 % — 이 워크로드는 ${(s0 * 100).toFixed(0)} % 대신 비례 축소한 ${(w.gpuShare * 100).toFixed(1)} %로 분석했습니다.`);
      (a.notesEn ??= []).unshift(`GPU shares add up to ${(total * 100).toFixed(0)} % > 100 % — this workload was analysed at the proportionally scaled ${(w.gpuShare * 100).toFixed(1)} % instead of ${(s0 * 100).toFixed(0)} %.`);
    }
    return a;
  });
}

/** The blueprint as analysed (share scaled when Σ gpuShare > 1) — engines/index.ts passes it to the traffic engine so the
 *  traffic report and the workload simulation use the same GPU count. */
export function analysedBlueprint(ws: WorkloadBlueprint[], w: WorkloadBlueprint): WorkloadBlueprint {
  const s = effectiveShare(ws, w);
  return s === w.gpuShare ? w : { ...w, gpuShare: s };
}
