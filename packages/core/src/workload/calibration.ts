// Benchmark calibration of throughput / MFU (stream T6, DECISIONS-v2-2 F9 + §C "MFU 기준").
//
// Why: the architecture fields determine FLOPs, memory and communication BYTES deterministically, but not the achieved
// throughput (kernels per precision, routing skew, overlap, scale, framework). Evidence (derived by AIDC Studio from the public
// MLPerf® Training v6.0 logs of results 6.0-0013 and 6.0-0102, same GB300 NVL72 type, 512 GPUs, NeMo 26.04; not verified by
// MLCommons Association): Llama 3.1 405B 3,850 vs DeepSeek-V3 1,423 TFLOP/s per GPU (ratio 0.37).
// MLPerf® is a registered trademark of MLCommons Association in the United States and other countries.
//
// Training (a benchmark row or the user's measurement):
//   F_tok       = 6·N_active + 12·L·h·s              (PaLM App. B; no-recompute form, MFU excludes recompute)
//   tokens/s    = tokensToTarget / olympic run time   (MLPerf® time includes evaluation → LOWER BOUND, not subtracted)
//   TFLOP_eff   = tokens/s · F_tok / G                (stored: effective TFLOP/s per GPU, basis-free)
//   MFU         = TFLOP_eff / peakFlopsFor(benchmark accelerator catalog item, benchmark precision)
//   transfer    = the blueprint keeps the same MFU on its own accelerator/precision, i.e. throughput scales with the
//                 peak-FLOPs ratio peak(target, precision) / peak(benchmark accelerator, benchmark precision) (assumption).
//                 Same accelerator + precision → exactly TFLOP_eff / peak(target), the forward model reproduces the benchmark.
//   warnings    = dense ↔ MoE BLOCKED (ratio ≈ 0.37 above); > 2× scale or > 2× global batch from the benchmark; precision or
//                 accelerator differs (estimate); MoE top-k·h or EP differs; MFU > 1 → "peak table inconsistent" (not clamped).
// Inference:
//   tokens/s per GPU (output) at the row's interactivity; transfer to another accelerator scales with HBM bandwidth
//   (decode is memory-bandwidth bound, network-sim §6.2) — estimate; only valid for targets at ≤ the row's interactivity.
import { findCatalogItem } from '../catalog/catalog.ts';
import { findNodeSpec } from '../catalog/seeds/index.ts';
import { peakFlopsFor } from '../engines/traffic.ts';
import type { BenchmarkRow, CatalogItem, EvidenceSourceType, WorkloadBlueprint } from '../model/types.ts';
import { findModelPreset } from './presets.ts';
import { inferenceCalibrationSignature } from './inference.ts';

export type CalibrationPrecision = 'bf16' | 'fp8' | 'fp4';

/** Measurement the user enters instead of a benchmark row. */
export interface UserMeasurement {
  tokensPerSec: number;
  gpus: number;
  /** catalog id of the accelerator the measurement ran on (default: the blueprint's GPU rack) */
  acceleratorCatalogId?: string;
  precision?: CalibrationPrecision;
  /** inference only: interactivity the measurement holds at (tok/s per user) */
  interactivityTokPerSecPerUser?: number;
  label?: string;
}

export interface CalibrationWarning {
  code: 'kind-mismatch' | 'scale-mismatch' | 'batch-mismatch' | 'precision-mismatch' | 'accelerator-mismatch' | 'moe-shape-mismatch' | 'peak-inconsistent' | 'no-accelerator-item' | 'interactivity' | 'lower-bound' | 'no-throughput' | 'stale';
  severity: 'block' | 'warn' | 'info';
  en: string;
  ko: string;
}

export interface CalibrationResult {
  mfu?: number;
  tokensPerSecPerGpu?: number;
  source: string;
  mode?: 'training' | 'inference';
  /** effective TFLOP/s per GPU at the source (training) */
  tflopsPerGpu?: number;
  /** equivalent TFLOP/s per GPU on the blueprint's accelerator at the blueprint precision (training, same MFU) */
  targetTflopsPerGpu?: number;
  flopsPerToken?: number;
  sourceTokensPerSec?: number;
  sourceTokensPerSecPerGpu?: number;
  sourceGpus?: number;
  sourcePrecision?: CalibrationPrecision;
  sourcePeakFlops?: number;
  targetPeakFlops?: number;
  /** throughput transfer factor source accelerator → blueprint accelerator */
  transferFactor?: number;
  transferEn?: string;
  transferKo?: string;
  sourceAcceleratorCatalogId?: string;
  sourceType?: EvidenceSourceType | 'user';
  conditions?: string;
  interactivityTokPerSecPerUser?: number;
  warnings: CalibrationWarning[];
  /** true when a warning blocks applying (dense ↔ MoE, MFU > 1, no throughput) */
  blocked: boolean;
}

/** 'NVFP4 (…)' / 'MXFP8' / 'BF16' → engine precision key. */
export function parsePrecision(s: string | undefined): CalibrationPrecision | undefined {
  if (!s) return undefined;
  if (/fp4|int4/i.test(s)) return 'fp4';
  if (/fp8/i.test(s)) return 'fp8';
  if (/bf16|fp16|bfloat/i.test(s)) return 'bf16';
  return undefined;
}

/** Benchmark accelerator string → builtin catalog item id (GPU rack / node carrying the per-precision peak table). */
export function acceleratorCatalogId(accelerator: string): string | undefined {
  const a = accelerator.toLowerCase();
  if (/gb300/.test(a)) return 'nvidia-gb300-nvl72';
  if (/gb200/.test(a)) return 'nvidia-gb200-nvl72';
  if (/vera\s*rubin|vr[- ]?nvl/.test(a)) return 'nvidia-vr-nvl72';
  if (/\bb300\b/.test(a)) return 'hgx-b300-node';
  if (/\bb200\b/.test(a)) return 'hgx-b200-air-4x';
  if (/h200/.test(a)) return 'hgx-h200-node';
  if (/h100/.test(a)) return 'hgx-h100-node';
  if (/mi355x/.test(a)) return 'amd-mi355x-dlc-node';
  if (/mi350x/.test(a)) return 'amd-mi350x-node';
  if (/mi325x/.test(a)) return 'amd-mi325x-node';
  if (/mi300x/.test(a)) return 'amd-mi300x-node';
  return undefined;
}

/** Per-GPU peak table of an accelerator: a catalog rack's compute spec or a node spec's GPU (HGX / OAM nodes live in NODE_SPECS). */
export interface AcceleratorPeakSource {
  id: string;
  name: string;
  gpuModel: string;
  gpuFlopsPeak: number;
  peakTflops?: Partial<Record<string, number>>;
  memBandwidthGBps?: number;
}

export function acceleratorPeakSource(id: string | undefined): AcceleratorPeakSource | undefined {
  if (!id) return undefined;
  const item = findCatalogItem(id);
  if (item?.compute) return { id, name: item.name, gpuModel: item.compute.gpuModel, gpuFlopsPeak: item.compute.gpuFlopsPeak, peakTflops: item.compute.peakTflops, memBandwidthGBps: item.compute.memBandwidthGBps };
  const node = findNodeSpec(id);
  if (node?.gpu) return { id, name: node.name, gpuModel: node.gpu.model, gpuFlopsPeak: node.gpu.flopsPeak, peakTflops: node.gpu.peakTflops, memBandwidthGBps: node.gpu.memBandwidthGBps };
  return undefined;
}

/** Training compute per token, no-recompute PaLM form (used for MFU by definition). */
export function trainingFlopsPerToken(m: { activeParamsB: number; layers: number; hiddenSize: number }, seqLen: number): number {
  return 6 * m.activeParamsB * 1e9 + 12 * m.layers * m.hiddenSize * seqLen;
}

const isMoeBlueprint = (w: WorkloadBlueprint) => !!w.model.moe && w.model.moe.experts > 1;
const isTraining = (w: WorkloadBlueprint) => w.kind !== 'llm-inference' && w.kind !== 'hpc-simulation';
const benchmarkIsTraining = (b: BenchmarkRow) => /training|pretrain|paper|tflop/i.test(`${b.suite} ${b.task} ${b.metric}`) && !/inference/i.test(b.suite);

/** Global batch in sequences parsed from the row (MLPerf) or undefined. */
function rowGlobalBatchTokens(b: BenchmarkRow): number | undefined {
  if (b.globalBatchSeqs && b.seqLen) return b.globalBatchSeqs * b.seqLen;
  const m = /(\d+(?:\.\d+)?)\s*M tokens\/step/i.exec(b.parallelism ?? '');
  return m ? Number(m[1]) * 1e6 : undefined;
}

function parseDegree(par: string | undefined, key: 'TP' | 'PP' | 'EP' | 'CP'): number | undefined {
  const m = new RegExp(`\\b${key}(\\d+)`).exec(par ?? '');
  return m ? Number(m[1]) : undefined;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const fmt = (v: number, d = 0) => v.toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });

/** Tokens/s of a training benchmark row (olympic middle run when runs are listed), or undefined for per-GPU-only rows. */
export function benchmarkTokensPerSec(b: BenchmarkRow): number | undefined {
  const d = b.derived;
  if (d?.tokensToTarget && /time-to-train/i.test(b.metric)) {
    const t = b.runsSec?.length ? median(b.runsSec) : b.unit === 'min' ? b.value * 60 : b.value;
    if (t > 0) return d.tokensToTarget / t;
  }
  if (d?.tokensPerSec) return d.tokensPerSec;
  if (d?.tokensPerSecPerGpu && b.accelerators) return d.tokensPerSecPerGpu * b.accelerators;
  return undefined;
}

export function calibrateFromBenchmark(
  w: WorkloadBlueprint,
  b: BenchmarkRow | UserMeasurement,
  gpuRack: CatalogItem,
): CalibrationResult {
  const warnings: CalibrationWarning[] = [];
  const warn = (code: CalibrationWarning['code'], severity: CalibrationWarning['severity'], en: string, ko: string) => warnings.push({ code, severity, en, ko });
  const target = gpuRack.compute;
  const isRow = 'id' in b;
  const training = isTraining(w);
  const done = (r: Omit<CalibrationResult, 'warnings' | 'blocked'>): CalibrationResult => ({ ...r, warnings, blocked: warnings.some((x) => x.severity === 'block') });
  if (!target || target.gpus <= 0) {
    warn('no-accelerator-item', 'block', 'The blueprint has no GPU rack with a compute spec to transfer to.', '보정을 옮길 GPU 랙(연산 사양)이 없습니다.');
    return done({ source: '' });
  }

  // ── source description ──
  const srcAccId = isRow ? acceleratorCatalogId(b.accelerator) : b.acceleratorCatalogId ?? gpuRack.id;
  const srcItem = acceleratorPeakSource(srcAccId);
  const srcCompute: { gpuFlopsPeak: number; peakTflops?: Partial<Record<string, number>>; memBandwidthGBps?: number } | undefined = srcItem ?? (isRow ? undefined : target);
  const sourceType: EvidenceSourceType | 'user' = isRow ? b.sourceType : 'user';
  const conditions = isRow
    ? [b.suite, b.round, b.system, b.accelerators ? `${fmt(b.accelerators)} × ${b.accelerator}` : b.accelerator, b.precision, b.parallelism, b.globalBatchSeqs && b.seqLen ? `GBS ${fmt(b.globalBatchSeqs)} × ${fmt(b.seqLen)}` : undefined, b.interactivityTokPerSecPerUser ? `${b.interactivityTokPerSecPerUser} tok/s/user` : undefined].filter(Boolean).join(' · ')
    : `${b.label ?? 'user measurement'} · ${fmt(b.gpus)} GPU · ${srcItem?.name ?? srcAccId ?? gpuRack.name}${b.precision ? ` · ${b.precision.toUpperCase()}` : ''}`;
  const source = isRow ? `${b.suite} ${b.round} — ${b.id} (${b.sourceType} → derived) ${b.sourceUrl}` : `user measurement: ${fmt(b.tokensPerSec)} tok/s at ${fmt(b.gpus)} GPU on ${srcItem?.name ?? srcAccId ?? gpuRack.name} (user → derived)`;
  if (isRow && !srcItem) warn('no-accelerator-item', 'warn', `No catalog item for "${b.accelerator}" — the blueprint's rack (${gpuRack.name}) peak table is used as the source basis (estimate).`, `"${b.accelerator}"에 해당하는 카탈로그 항목이 없어 블루프린트 랙(${gpuRack.name})의 피크 표를 기준으로 사용합니다 (추정).`);
  const srcRackOrTarget = srcCompute ?? target;
  // same accelerator = same catalog id, or the same GPU model string (e.g. a GB300 rack vs a user item built on the same GPU)
  const sameAccelerator = (srcItem?.id ?? gpuRack.id) === gpuRack.id || (!!srcItem && srcItem.gpuModel === target.gpuModel);

  if (training) {
    const t = w.training;
    const rowIsTraining = isRow ? benchmarkIsTraining(b) : true;
    if (isRow && !rowIsTraining) warn('kind-mismatch', 'block', 'An inference benchmark cannot calibrate a training blueprint.', '추론 벤치마크로 학습 블루프린트를 보정할 수 없습니다.');
    const targetPrec: CalibrationPrecision = t?.precision ?? 'bf16';
    const srcPrec: CalibrationPrecision = (isRow ? parsePrecision(b.precision) : b.precision) ?? targetPrec;
    // model the source ran: preset of the row, else the blueprint (user measurement / paper rows on the same model)
    const preset = isRow ? findModelPreset(b.model) : undefined;
    const srcModel = preset ?? w.model;
    // fix v2 2차 (QA B1): never fall back to the preset's context length for F_tok — a row without seqLen used 131,072 and
    // back-solved the Llama 3 paper row to 927 TFLOP/s (93.7 % MFU) instead of the published 430.
    let tflops: number | undefined;
    let tokensPerSec: number | undefined;
    let flopsPerToken: number | undefined;
    const gpus = isRow ? b.accelerators ?? undefined : b.gpus;
    if (isRow) {
      tokensPerSec = benchmarkTokensPerSec(b);
      const d = b.derived;
      const rowFtok = d?.flopsPerToken ?? (preset && b.seqLen ? trainingFlopsPerToken(preset, b.seqLen) : undefined);
      if (d?.tflopsPerGpu && !d.tokensToTarget) {
        // row reports TFLOP/s per GPU directly (paper / vendor RA): use the published value
        tflops = d.tflopsPerGpu * 1e12;
        flopsPerToken = rowFtok;
      } else if (tokensPerSec !== undefined && gpus && rowFtok) {
        flopsPerToken = rowFtok;
        tflops = (tokensPerSec * flopsPerToken) / gpus;
        if (d?.tflopsPerGpu && Math.abs(tflops / (d.tflopsPerGpu * 1e12) - 1) > 0.05) {
          warn('peak-inconsistent', 'block', `Back-solved ${fmt(tflops / 1e12)} TFLOP/s per GPU differs by more than 5 % from the row's published ${fmt(d.tflopsPerGpu)} — check the row's sequence length, token count and GPU count.`, `역산한 GPU당 ${fmt(tflops / 1e12)} TFLOP/s가 행에 기재된 ${fmt(d.tflopsPerGpu)}와 5 % 넘게 다릅니다 — 행의 시퀀스 길이·토큰 수·GPU 수를 확인하세요.`);
        }
      } else if (d?.tflopsPerGpu) {
        tflops = d.tflopsPerGpu * 1e12;
        flopsPerToken = rowFtok;
      }
      if (/time-to-train/i.test(b.metric)) warn('lower-bound', 'info', 'MLPerf® time-to-train includes periodic evaluation; the tokens/s derived by AIDC Studio (not verified by MLCommons Association) is used as a lower bound (evaluation time is not subtracted).', 'MLPerf® 학습 시간에는 주기적 평가가 포함됩니다. AIDC Studio가 산출한 tokens/s(MLCommons Association 미검증)를 평가 시간을 빼지 않은 하한으로 사용합니다.');
    } else if (b.tokensPerSec > 0 && b.gpus > 0) {
      tokensPerSec = b.tokensPerSec;
      flopsPerToken = trainingFlopsPerToken(w.model, w.model.seqLen);
      tflops = (tokensPerSec * flopsPerToken) / b.gpus;
    }
    if (tflops === undefined || !(tflops > 0)) {
      warn('no-throughput', 'block', 'The source has no usable training throughput.', '학습 처리량을 산출할 수 없는 출처입니다.');
      return done({ source, mode: 'training', conditions, sourceType });
    }
    // transfer warnings (thresholds are estimates)
    if (isRow) {
      const rowMoe = preset ? preset.kind === 'moe' : /moe/i.test(b.task);
      if (rowMoe !== isMoeBlueprint(w)) warn('kind-mismatch', 'block', `Dense ↔ MoE transfer is blocked: on MLPerf® Training v6.0 GB300, 512 GPUs (results 6.0-0013 / 6.0-0102), AIDC Studio derives Llama 3.1 405B 3,850 vs DeepSeek-V3 1,423 TFLOP/s per GPU (ratio 0.37; not verified by MLCommons Association).`, `Dense ↔ MoE 간 보정 이전은 차단됩니다: MLPerf® Training v6.0 GB300 512 GPU(결과 6.0-0013 / 6.0-0102)에서 AIDC Studio가 산출한 값은 Llama 3.1 405B 3,850 vs DeepSeek-V3 1,423 TFLOP/s/GPU (비 0.37, MLCommons Association 미검증).`);
      if (preset && w.model.moe && preset.moe && (preset.moe.topK * preset.hiddenSize !== w.model.moe.topK * w.model.hiddenSize || (parseDegree(b.parallelism, 'EP') ?? t?.ep) !== t?.ep)) warn('moe-shape-mismatch', 'warn', `MoE shape differs from the benchmark (top-k·h ${fmt(preset.moe.topK * preset.hiddenSize)} vs ${fmt(w.model.moe.topK * w.model.hiddenSize)}, EP ${parseDegree(b.parallelism, 'EP') ?? '?'} vs ${t?.ep ?? '?'}) — all-to-all bytes scale with top-k·h.`, `MoE 형태가 벤치마크와 다릅니다 (top-k·h ${fmt(preset.moe.topK * preset.hiddenSize)} vs ${fmt(w.model.moe.topK * w.model.hiddenSize)}, EP ${parseDegree(b.parallelism, 'EP') ?? '?'} vs ${t?.ep ?? '?'}) — all-to-all 바이트는 top-k·h에 비례합니다.`);
      const gbTok = rowGlobalBatchTokens(b);
      if (gbTok && t && t.globalBatchTokensM > 0) {
        const r = (t.globalBatchTokensM * 1e6) / gbTok;
        if (r > 2 || r < 0.5) warn('batch-mismatch', 'warn', `Global batch differs by ${r.toFixed(2)}× from the benchmark (${fmt(gbTok / 1e6, 1)} M tokens) — per-GPU throughput depends on batch per GPU.`, `글로벌 배치가 벤치마크(${fmt(gbTok / 1e6, 1)} M 토큰)와 ${r.toFixed(2)}배 다릅니다 — GPU당 처리량은 GPU당 배치에 좌우됩니다.`);
      }
    }
    if (gpus && w.gpuShare > 0) {
      // compare with the blueprint's intended GPU count when known through `calibration.gpus`, else skip (panel passes it)
    }
    if (srcPrec !== targetPrec) warn('precision-mismatch', 'warn', `Benchmark precision ${srcPrec.toUpperCase()} ≠ blueprint ${targetPrec.toUpperCase()} — MFU is carried over on the peak table of each precision (estimate).`, `벤치마크 정밀도 ${srcPrec.toUpperCase()} ≠ 블루프린트 ${targetPrec.toUpperCase()} — 정밀도별 피크 표 기준으로 MFU를 옮깁니다 (추정).`);
    if (!sameAccelerator) warn('accelerator-mismatch', 'warn', `Benchmark accelerator (${srcItem?.name ?? (isRow ? b.accelerator : '?')}) ≠ blueprint rack (${gpuRack.name}) — same MFU assumed, throughput scaled by the peak-FLOPs ratio (estimate).`, `벤치마크 가속기(${srcItem?.name ?? (isRow ? b.accelerator : '?')}) ≠ 블루프린트 랙(${gpuRack.name}) — 같은 MFU를 가정하고 처리량은 피크 FLOPs 비율로 환산합니다 (추정).`);
    const srcPeak = peakFlopsFor(srcRackOrTarget, srcPrec);
    const tgtPeak = peakFlopsFor(target, targetPrec);
    const mfu = tflops / srcPeak;
    if (mfu > 1) warn('peak-inconsistent', 'block', `Back-solved MFU ${(mfu * 100).toFixed(0)} % > 100 %: the catalog peak table for ${srcItem?.name ?? gpuRack.name} at ${srcPrec.toUpperCase()} (${fmt(srcPeak / 1e12)} TFLOPS) is inconsistent with the measurement — fix the peak table instead of clamping.`, `역산 MFU ${(mfu * 100).toFixed(0)} % > 100 %: ${srcItem?.name ?? gpuRack.name}의 ${srcPrec.toUpperCase()} 피크 표(${fmt(srcPeak / 1e12)} TFLOPS)가 측정값과 맞지 않습니다 — 잘라내지 말고 피크 표를 고치세요.`);
    const factor = tgtPeak / srcPeak;
    const transferEn = sameAccelerator && srcPrec === targetPrec
      ? `Same accelerator and precision: MFU = ${fmt(tflops / 1e12)} TFLOP/s ÷ ${fmt(srcPeak / 1e12)} TFLOPS peak; the forward model reproduces the source throughput.`
      : `Same MFU assumed on ${gpuRack.name} ${targetPrec.toUpperCase()}: throughput × ${factor.toFixed(2)} (peak ${fmt(tgtPeak / 1e12)} ÷ ${fmt(srcPeak / 1e12)} TFLOPS) → ${fmt((mfu * tgtPeak) / 1e12)} TFLOP/s per GPU.`;
    const transferKo = sameAccelerator && srcPrec === targetPrec
      ? `같은 가속기·정밀도: MFU = ${fmt(tflops / 1e12)} TFLOP/s ÷ 피크 ${fmt(srcPeak / 1e12)} TFLOPS — 순방향 모델이 출처 처리량을 그대로 재현합니다.`
      : `${gpuRack.name} ${targetPrec.toUpperCase()}에서 같은 MFU를 가정: 처리량 × ${factor.toFixed(2)} (피크 ${fmt(tgtPeak / 1e12)} ÷ ${fmt(srcPeak / 1e12)} TFLOPS) → GPU당 ${fmt((mfu * tgtPeak) / 1e12)} TFLOP/s.`;
    return done({
      mode: 'training',
      mfu,
      source,
      tflopsPerGpu: tflops,
      targetTflopsPerGpu: mfu * tgtPeak,
      flopsPerToken,
      sourceTokensPerSec: tokensPerSec,
      sourceTokensPerSecPerGpu: tokensPerSec !== undefined && gpus ? tokensPerSec / gpus : isRow ? b.derived?.tokensPerSecPerGpu : undefined,
      sourceGpus: gpus,
      sourcePrecision: srcPrec,
      sourcePeakFlops: srcPeak,
      targetPeakFlops: tgtPeak,
      transferFactor: factor,
      transferEn,
      transferKo,
      sourceAcceleratorCatalogId: srcItem?.id,
      sourceType,
      conditions,
    });
  }

  // ── inference ──
  if (w.kind === 'hpc-simulation') {
    warn('kind-mismatch', 'block', 'HPC blueprints have no token throughput to calibrate.', 'HPC 블루프린트에는 보정할 토큰 처리량이 없습니다.');
    return done({ source, conditions, sourceType });
  }
  if (isRow && benchmarkIsTraining(b)) warn('kind-mismatch', 'block', 'A training benchmark cannot calibrate an inference blueprint.', '학습 벤치마크로 추론 블루프린트를 보정할 수 없습니다.');
  let perGpu: number | undefined;
  let interactivity: number | undefined;
  if (isRow) {
    perGpu = b.derived?.outputTokensPerSecPerGpu ?? b.derived?.tokensPerSecPerGpu ?? (b.accelerators ? b.value / b.accelerators : undefined);
    interactivity = b.interactivityTokPerSecPerUser ?? b.latencyConstraint?.minInteractivityTokPerSecPerUser;
    if (b.derived?.outputTokensPerSecPerGpu) warn('lower-bound', 'info', 'Output tokens/s per GPU is used for decode sizing (InferenceX total tokens/s also counts input tokens).', 'decode 산정에는 GPU당 출력 tokens/s를 사용합니다 (InferenceX 총 tokens/s는 입력 토큰도 셉니다).');
    if (b.suite.includes('InferenceX')) {
      const age = (Date.now() - Date.parse(b.round)) / 86400000;
      if (Number.isFinite(age) && age > 90) warn('stale', 'warn', `InferenceX row dated ${b.round} is older than 90 days (continuous benchmark — re-query).`, `InferenceX 행(${b.round})이 90일보다 오래되었습니다 (연속 벤치마크 — 다시 조회하세요).`);
    }
    const preset = findModelPreset(b.model);
    if (preset && (preset.kind === 'moe') !== isMoeBlueprint(w)) warn('kind-mismatch', 'block', 'Dense ↔ MoE transfer is blocked (per-GPU efficiency differs by architecture, not by a fixed factor).', 'Dense ↔ MoE 간 보정 이전은 차단됩니다 (GPU당 효율은 고정 계수로 옮길 수 없습니다).');
    else if (!preset || preset.paramsB !== w.model.paramsB || preset.activeParamsB !== w.model.activeParamsB) warn('moe-shape-mismatch', 'warn', `Benchmark model (${b.model}) differs from the blueprint model (${w.model.name}) — tokens/s per GPU transferred as is (estimate).`, `벤치마크 모델(${b.model})이 블루프린트 모델(${w.model.name})과 다릅니다 — GPU당 tokens/s를 그대로 옮깁니다 (추정).`);
    const srcPrec = parsePrecision(b.precision);
    const tgtPrec = parsePrecision(w.inference?.kvPrecision);
    if (srcPrec && tgtPrec && srcPrec !== tgtPrec && !(srcPrec === 'fp4' && tgtPrec === 'fp8')) warn('precision-mismatch', 'info', `Benchmark precision ${srcPrec.toUpperCase()}; blueprint KV cache ${tgtPrec.toUpperCase()}.`, `벤치마크 정밀도 ${srcPrec.toUpperCase()}, 블루프린트 KV 캐시 ${tgtPrec.toUpperCase()}.`);
  } else if (b.tokensPerSec > 0 && b.gpus > 0) {
    perGpu = b.tokensPerSec / b.gpus;
    interactivity = b.interactivityTokPerSecPerUser;
  }
  if (!perGpu || !(perGpu > 0)) {
    warn('no-throughput', 'block', 'The source has no usable tokens/s per GPU.', 'GPU당 tokens/s를 산출할 수 없는 출처입니다.');
    return done({ source, mode: 'inference', conditions, sourceType });
  }
  const targetIntv = w.inference && w.inference.tpotSloMs > 0 ? 1000 / w.inference.tpotSloMs : undefined;
  if (interactivity && targetIntv && targetIntv > interactivity * 1.001) warn('interactivity', 'warn', `Blueprint TPOT SLO ${w.inference!.tpotSloMs} ms needs ${targetIntv.toFixed(1)} tok/s per user, above the source's ${interactivity} — a single point is valid only at ≤ its interactivity (optimistic).`, `블루프린트 TPOT SLO ${w.inference!.tpotSloMs} ms는 사용자당 ${targetIntv.toFixed(1)} tok/s가 필요해 출처(${interactivity})보다 높습니다 — 단일 측정점은 그 인터랙티비티 이하에서만 유효합니다 (낙관적).`);
  const srcMbw = srcRackOrTarget.memBandwidthGBps;
  const tgtMbw = target.memBandwidthGBps;
  const factor = !sameAccelerator && srcMbw && tgtMbw ? tgtMbw / srcMbw : 1;
  if (!sameAccelerator) warn('accelerator-mismatch', 'warn', srcMbw && tgtMbw ? `Benchmark accelerator ≠ blueprint rack — decode throughput scaled by HBM bandwidth ${fmt(tgtMbw)} ÷ ${fmt(srcMbw)} GB/s (estimate).` : 'Benchmark accelerator ≠ blueprint rack and no HBM bandwidth to scale by — transferred unchanged (estimate).', srcMbw && tgtMbw ? `벤치마크 가속기 ≠ 블루프린트 랙 — decode 처리량을 HBM 대역폭 ${fmt(tgtMbw)} ÷ ${fmt(srcMbw)} GB/s로 환산합니다 (추정).` : '벤치마크 가속기 ≠ 블루프린트 랙이며 환산할 HBM 대역폭이 없어 그대로 옮깁니다 (추정).');
  const tok = perGpu * factor;
  return done({
    mode: 'inference',
    tokensPerSecPerGpu: tok,
    source,
    sourceTokensPerSecPerGpu: perGpu,
    sourceGpus: isRow ? b.accelerators ?? undefined : b.gpus,
    transferFactor: factor,
    transferEn: factor === 1 ? `${fmt(perGpu)} output tok/s per GPU used as is${interactivity ? ` at ≤ ${interactivity} tok/s per user` : ''}; GPUs = requests/s × output tokens ÷ tok/s per GPU.` : `${fmt(perGpu)} × ${factor.toFixed(2)} (HBM bandwidth ratio) = ${fmt(tok)} output tok/s per GPU; GPUs = requests/s × output tokens ÷ tok/s per GPU.`,
    transferKo: factor === 1 ? `GPU당 출력 ${fmt(perGpu)} tok/s를 그대로 사용${interactivity ? ` (사용자당 ≤ ${interactivity} tok/s)` : ''}; GPU = 요청률 × 출력 토큰 ÷ GPU당 tok/s.` : `${fmt(perGpu)} × ${factor.toFixed(2)} (HBM 대역폭 비) = GPU당 출력 ${fmt(tok)} tok/s; GPU = 요청률 × 출력 토큰 ÷ GPU당 tok/s.`,
    sourceAcceleratorCatalogId: srcItem?.id,
    sourceType,
    conditions,
    interactivityTokPerSecPerUser: interactivity,
  });
}

/** Scale-mismatch warning against the blueprint's GPU count (needs the cluster size, so the panel / tests call it). */
export function scaleWarning(sourceGpus: number | undefined, targetGpus: number): CalibrationWarning | undefined {
  if (!sourceGpus || !(targetGpus > 0)) return undefined;
  const r = targetGpus / sourceGpus;
  if (Math.abs(Math.log2(r)) <= 1) return undefined;
  return { code: 'scale-mismatch', severity: 'warn', en: `Blueprint GPUs (${fmt(targetGpus)}) differ by ${r.toFixed(2)}× from the source (${fmt(sourceGpus)}) — per-GPU throughput changes with scale (DeepSeek-V3 on GB200: 3,560 → 1,902 tok/s per GPU from 512 to 8,192 GPUs).`, ko: `블루프린트 GPU(${fmt(targetGpus)})가 출처(${fmt(sourceGpus)})와 ${r.toFixed(2)}배 다릅니다 — GPU당 처리량은 규모에 따라 변합니다 (GB200 DeepSeek-V3: 512 → 8,192 GPU에서 3,560 → 1,902 tok/s/GPU).` };
}

/** Blueprint calibration record (stored on WorkloadBlueprint.calibration) from a result. */
export function calibrationRecord(r: CalibrationResult, b: BenchmarkRow | UserMeasurement, extraWarnings: CalibrationWarning[] = [], locale: 'en' | 'ko' = 'en', workload?: WorkloadBlueprint): NonNullable<WorkloadBlueprint['calibration']> {
  const isRow = 'id' in b;
  const warns = [...r.warnings, ...extraWarnings].filter((x) => x.severity !== 'info').map((x) => (locale === 'ko' ? x.ko : x.en));
  return {
    benchmarkId: isRow ? b.id : undefined,
    measuredTokensPerSec: isRow ? r.sourceTokensPerSec : b.tokensPerSec,
    gpus: r.sourceGpus,
    mfu: r.mfu,
    source: r.source,
    mode: r.mode,
    tflopsPerGpu: r.tflopsPerGpu,
    tokensPerSecPerGpu: r.tokensPerSecPerGpu,
    interactivityTokPerSecPerUser: r.interactivityTokPerSecPerUser,
    precision: r.sourcePrecision ?? (isRow ? b.precision : b.precision),
    accelerator: isRow ? b.accelerator : undefined,
    acceleratorCatalogId: r.sourceAcceleratorCatalogId,
    sourceType: r.sourceType,
    conditions: r.conditions,
    workloadSignature: workload ? inferenceCalibrationSignature(workload) : undefined,
    transfer: locale === 'ko' ? r.transferKo : r.transferEn,
    warnings: warns.length ? warns : undefined,
  };
}
