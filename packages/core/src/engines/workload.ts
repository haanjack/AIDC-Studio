import type { CatalogItem, PowerAnalysis, TrafficReport, WorkloadAnalysis, WorkloadBlueprint, WorkloadTimePoint } from '../model/types.ts';
import { clamp, type Ctx, hash32, mulberry32 } from './context.ts';
import type { NetworkResult } from './network.ts';
import { peakFlopsFor } from './traffic.ts';
import { effectiveShare, effectiveShares, shareState } from '../workload/shares.ts';

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
  return {
    gpuRack: ctx.gpuRack,
    clusterGpus: jobClusterGpus(ctx, net),
    projectGpus: ctx.gpus,
    // v2: the workload-driven traffic engine (engines/traffic.ts) supplies the effective efficiency when a report exists;
    // the legacy fabric scalar is the fallback (projects without a training blueprint / GPU racks)
    commEfficiency: net.analysis.traffic?.commEfficiencyEffective ?? net.analysis.commEfficiency,
    traffic: net.analysis.traffic,
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
  if (gpus < tpp) return empty(w, `GPU ${Math.floor(w.gpuShare * env.clusterGpus)}개로는 TP×PP=${tpp} 모델 병렬 그룹을 구성할 수 없습니다.`, `${Math.floor(w.gpuShare * env.clusterGpus)} GPUs cannot form a TP×PP=${tpp} model-parallel group.`);
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
  };
}

export function simulateInference(w: WorkloadBlueprint, env: WorkloadEnv): WorkloadAnalysis {
  const rack = env.gpuRack;
  const c = rack?.compute;
  const inf = w.inference;
  if (!rack || !c || c.gpus <= 0) return empty(w, 'GPU 랙이 배치되지 않아 추론 시뮬레이션을 수행할 수 없습니다.', 'No GPU rack is placed — the inference simulation cannot run.');
  if (!inf) return empty(w, '추론 파라미터(inference)가 정의되지 않았습니다.', 'Inference parameters are not defined.');
  const notes: string[] = [];
  const notesEn: string[] = [];
  const note = (ko: string, en: string) => {
    notes.push(ko);
    notesEn.push(en);
  };
  const gpus = Math.floor(clamp(w.gpuShare, 0, 1) * env.clusterGpus);
  const nActive = w.model.activeParamsB * 1e9;
  const weightsGB = w.model.paramsB; // FP8: 1 byte / param
  const activeGB = w.model.activeParamsB;
  const usableMem = c.gpuMemoryGB * 0.9;
  const minGpus = Math.max(1, Math.ceil((weightsGB * 1.2) / usableMem));
  let g = 2 ** Math.ceil(Math.log2(Math.max(2, minGpus * 2)));
  g = Math.min(g, Math.max(minGpus, c.scaleUp.domainSize));
  if (gpus < g) return empty(w, `할당 GPU ${gpus}개가 모델 인스턴스 최소 크기(${g} GPU)보다 작습니다.`, `Allocated GPUs (${gpus}) are fewer than the minimum model instance (${g} GPUs).`);
  // HBM bandwidth per GPU from the catalog (memBandwidthGBps); FLOPS-scaled proxy only for legacy items without it
  const mbw = g * (c.memBandwidthGBps ?? (1300 * c.gpuFlopsPeak) / 2.3e15) * 0.85; // GB/s
  const kvPerTokenGB = (2 * w.model.layers * w.model.hiddenSize * 0.125) / 1e9;
  const kvSeqGB = kvPerTokenGB * (inf.inputTokens + inf.outputTokens / 2);
  const flopsEff = g * c.gpuFlopsPeak * 1.3;
  const kCompute = (2 * nActive) / (flopsEff * 0.5);
  const weightRead = (b: number) => Math.min(weightsGB, activeGB * (1 + 0.1 * Math.log2(1 + b)));
  const tpot = (b: number) => weightRead(b) / mbw + b * (kvSeqGB / mbw + kCompute);
  const bMem = Math.max(1, Math.floor((g * usableMem - weightsGB) / kvSeqGB));
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
  const prefillRate = (flopsEff * 0.55) / (2 * nActive + 2 * w.model.layers * inf.inputTokens * w.model.hiddenSize);
  const service = inf.inputTokens / prefillRate;
  const prefillDemand = inf.requestsPerSec * inf.inputTokens;
  const decodeDemand = inf.requestsPerSec * inf.outputTokens;
  const soGbps = c.scaleOutPortGbps * c.scaleOutPortsPerGpu * env.commEfficiency;

  let instances: number;
  let ttft: number;
  let tpotAct: number;
  if (inf.disaggregated) {
    const np = Math.max(1, Math.ceil(prefillDemand / (prefillRate * 0.7)));
    const nd = Math.max(1, Math.ceil(decodeDemand / decodeRate));
    const rho = prefillDemand / (np * prefillRate);
    const kvTransfer = soGbps > 0 ? (kvPerTokenGB * inf.inputTokens * 8) / (soGbps * Math.min(g, 8)) : 0;
    ttft = service / Math.max(0.05, 1 - rho) + kvTransfer;
    const bAct = Math.min(bStar, Math.max(1, (decodeDemand / nd) * tpot(bStar)));
    tpotAct = tpot(bAct);
    instances = np + nd;
    note(`분리형(disaggregated) 서빙: prefill ${np} × ${g} GPU, decode ${nd} × ${g} GPU 인스턴스.`, `Disaggregated serving: ${np} prefill × ${g} GPU and ${nd} decode × ${g} GPU instances.`);
  } else {
    let n = Math.max(1, Math.ceil(decodeDemand / decodeRate));
    let p = 0;
    for (let guard = 0; guard < 200000; guard++, n++) {
      p = (inf.requestsPerSec / n) * inf.inputTokens / prefillRate;
      if (p >= 0.6) continue;
      if (decodeDemand / n <= decodeRate * (1 - p) * 0.85) break;
    }
    instances = n;
    ttft = (service / Math.max(0.05, 1 - p)) * 1.3;
    tpotAct = tpot(bStar) / Math.max(0.05, 1 - p);
    note(`통합형 서빙: ${n} × ${g} GPU 인스턴스 (prefill 점유율 ${(p * 100).toFixed(0)}%).`, `Aggregated serving: ${n} × ${g} GPU instances (prefill share ${(p * 100).toFixed(0)} %).`);
  }
  // v2 2차 (T6, F9): a benchmark calibration (output tokens/s per GPU at the stated interactivity, workload/calibration.ts)
  // replaces the decode-capacity model for sizing: GPUs = requests/s × output tokens ÷ tok/s per GPU, whole instances
  const calTok = w.calibration?.mode === 'inference' && w.calibration.tokensPerSecPerGpu && w.calibration.tokensPerSecPerGpu > 0 ? w.calibration.tokensPerSecPerGpu : undefined;
  if (calTok) {
    const modelInstances = instances;
    instances = Math.max(1, Math.ceil(decodeDemand / (calTok * g)));
    note(`벤치마크 보정: GPU당 출력 ${Math.round(calTok).toLocaleString('en-US')} tok/s → ${instances} × ${g} GPU 인스턴스 (보정 전 모델 ${modelInstances}개; ${w.calibration!.source}).`, `Benchmark calibration: ${Math.round(calTok).toLocaleString('en-US')} output tok/s per GPU → ${instances} × ${g} GPU instances (uncalibrated model ${modelInstances}; ${w.calibration!.source}).`);
  }
  const gpusRequired = instances * g;
  const usable = Math.floor(gpus / g) * g;
  const maxRequestsPerSec = (inf.requestsPerSec * usable) / gpusRequired;
  if (gpusRequired > gpus) note(`목표 ${inf.requestsPerSec} req/s에는 GPU ${gpusRequired}개가 필요하지만 ${gpus}개만 할당되었습니다.`, `The target ${inf.requestsPerSec} req/s needs ${gpusRequired} GPUs but only ${gpus} are allocated.`);
  if (ttft * 1000 > inf.ttftSloMs) note(`예상 TTFT ${(ttft * 1000).toFixed(0)} ms가 SLO ${inf.ttftSloMs} ms를 초과합니다.`, `Predicted TTFT ${(ttft * 1000).toFixed(0)} ms exceeds the SLO ${inf.ttftSloMs} ms.`);

  // power
  const np = rack.power!;
  const racks = gpus / c.gpus;
  const u = clamp(gpusRequired / Math.max(1, gpus), 0, 1);
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

  return {
    workloadId: w.id,
    gpus,
    maxRequestsPerSec,
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
    details: { instanceGpus: g, maxBatch: bStar, decodeTokPerSecPerInstance: decodeRate, prefillTokPerSecPerInstance: prefillRate, memBandwidthGBps: mbw, kvPerSeqGB: kvSeqGB },
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

export function analyzeWorkloadsCtx(ctx: Ctx, net: NetworkResult, power: Pick<PowerAnalysis, 'pue'>): WorkloadAnalysis[] {
  const env = workloadEnv(ctx, net, power);
  // v2 2차 (T6, F9): Σ gpuShare > 1 → every blueprint is analysed at s_i / S (stored values unchanged; validate raises
  // 'workload-share-over' through workload/shares.ts shareIssues)
  const { total, state } = shareState(ctx.project.workloads);
  const eff = effectiveShares(ctx.project.workloads);
  return eff.map((w, i) => {
    const a = simulateWorkload(w, env);
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
