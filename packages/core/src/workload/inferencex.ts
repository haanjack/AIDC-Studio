import type { BenchmarkRow, CatalogItem, InferencePrefixCacheTrace, WorkloadBlueprint } from '../model/types.ts';

/** Exact model-name bridge to the public InferenceX API. Deliberately omit look-alike model generations. */
export const INFERENCEX_MODELS: Readonly<Record<string, string>> = {
  'deepseek-r1': 'DeepSeek-R1-0528',
  'deepseek-v4-pro': 'DeepSeek-V4-Pro',
  'glm-5.2': 'GLM-5.2',
  'kimi-k2.5': 'Kimi-K2.5',
  'kimi-k3': 'Kimi-K3',
  'minimax-m3': 'MiniMax-M3',
  'gpt-oss-120b': 'gpt-oss-120b',
};

export function inferenceXModelName(presetId: string | undefined): string | undefined {
  return presetId ? INFERENCEX_MODELS[presetId] : undefined;
}

/** Public `/api/v1/benchmarks` row. Fields remain optional because the upstream schema evolves continuously. */
export interface InferenceXPublicRow {
  id?: string | number;
  hardware?: string;
  framework?: string;
  model?: string;
  precision?: string;
  spec_method?: string | null;
  disagg?: boolean;
  prefill_tp?: number;
  prefill_ep?: number;
  prefill_dp_attention?: boolean;
  prefill_num_workers?: number;
  decode_tp?: number;
  decode_ep?: number;
  decode_dp_attention?: boolean;
  decode_num_workers?: number;
  num_prefill_gpu?: number;
  num_decode_gpu?: number;
  benchmark_type?: string;
  isl?: number | null;
  osl?: number | null;
  conc?: number;
  offload_mode?: string | null;
  image?: string;
  recipe_fingerprint?: string;
  metrics?: Record<string, unknown>;
  power_invalid_reasons?: unknown;
  date?: string;
  run_url?: string;
}

/** JSON payload emitted by InferenceX-app MCP `get_latest_benchmarks` or `query_sql`. */
export interface InferenceXMcpPayload {
  filters?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
  count?: number;
  truncated?: boolean;
}

/**
 * Normalise the InferenceX-app MCP's flattened metric rows to the same shape as the public HTTP API.
 * `publicModel` is supplied by the exact local mapping because MCP filters use the database model key.
 */
export function inferenceXRowsFromMcp(payload: InferenceXMcpPayload, publicModel: string): InferenceXPublicRow[] {
  const filters = payload.filters ?? {};
  const metricName = /(?:tput|throughput|ttft|tpot|itl|e2el|intvty|interactivity|power|cache_hit|duration|qps)/i;
  return (payload.rows ?? []).map((source) => {
    const row = { ...filters, ...source };
    const metrics: Record<string, unknown> = row.metrics && typeof row.metrics === 'object' && !Array.isArray(row.metrics)
      ? { ...(row.metrics as Record<string, unknown>) }
      : {};
    for (const [key, value] of Object.entries(row)) if (metricName.test(key)) metrics[key] = value;
    return {
      id: row.id as string | number | undefined,
      hardware: typeof row.hardware === 'string' ? row.hardware : undefined,
      framework: typeof row.framework === 'string' ? row.framework : undefined,
      model: publicModel,
      precision: typeof row.precision === 'string' ? row.precision : undefined,
      spec_method: typeof row.spec_method === 'string' || row.spec_method === null ? row.spec_method : undefined,
      disagg: typeof row.disagg === 'boolean' ? row.disagg : undefined,
      prefill_tp: number(row.prefill_tp),
      prefill_ep: number(row.prefill_ep),
      prefill_dp_attention: typeof row.prefill_dp_attention === 'boolean' ? row.prefill_dp_attention : undefined,
      prefill_num_workers: number(row.prefill_num_workers),
      decode_tp: number(row.decode_tp),
      decode_ep: number(row.decode_ep),
      decode_dp_attention: typeof row.decode_dp_attention === 'boolean' ? row.decode_dp_attention : undefined,
      decode_num_workers: number(row.decode_num_workers),
      num_prefill_gpu: number(row.num_prefill_gpu),
      num_decode_gpu: number(row.num_decode_gpu),
      benchmark_type: typeof row.benchmark_type === 'string' ? row.benchmark_type : undefined,
      isl: number(row.isl),
      osl: number(row.osl),
      conc: number(row.conc),
      offload_mode: typeof row.offload_mode === 'string' || row.offload_mode === null ? row.offload_mode : undefined,
      image: typeof row.image === 'string' ? row.image : undefined,
      recipe_fingerprint: typeof row.recipe_fingerprint === 'string' ? row.recipe_fingerprint : undefined,
      metrics,
      power_invalid_reasons: row.power_invalid_reasons,
      date: typeof row.date === 'string' ? row.date : undefined,
      run_url: typeof row.run_url === 'string' ? row.run_url : undefined,
    };
  });
}

export interface InferenceXMatch {
  presetId?: string;
  gpuRack: CatalogItem;
  inference: NonNullable<WorkloadBlueprint['inference']>;
  /** Physical accelerators assigned to this workload; used to match measured scale when known. */
  targetAccelerators?: number;
}

const API = 'https://inferencex.semianalysis.com/api/v1/benchmarks';

export function inferenceXApiUrl(model: string, sequence?: 'agentic-traces'): string {
  const query = new URLSearchParams({ model });
  if (sequence === 'agentic-traces') {
    query.set('view', 'calculator');
    query.set('sequence', sequence);
  }
  return `${API}?${query.toString()}`;
}

export function inferenceXHardwareKey(gpuModel: string | undefined): string | undefined {
  const s = gpuModel?.toLowerCase() ?? '';
  if (/mi355x/.test(s)) return 'mi355x';
  if (/mi325x/.test(s)) return 'mi325x';
  if (/mi300x/.test(s)) return 'mi300x';
  if (/gb300/.test(s)) return 'gb300';
  if (/gb200/.test(s)) return 'gb200';
  if (/\bb300\b/.test(s)) return 'b300';
  if (/\bb200\b/.test(s)) return 'b200';
  if (/h200/.test(s)) return 'h200';
  if (/h100/.test(s)) return 'h100';
  return undefined;
}

const acceleratorName = (hardware: string) => {
  const h = hardware.toLowerCase();
  if (h === 'mi355x') return 'AMD Instinct MI355X';
  if (h === 'mi325x') return 'AMD Instinct MI325X';
  if (h === 'mi300x') return 'AMD Instinct MI300X';
  if (h === 'gb300') return 'NVIDIA GB300 NVL72';
  if (h === 'gb200') return 'NVIDIA GB200 NVL72';
  if (h === 'b300') return 'NVIDIA B300';
  if (h === 'b200') return 'NVIDIA B200';
  if (h === 'h200') return 'NVIDIA H200';
  if (h === 'h100') return 'NVIDIA H100';
  return hardware.toUpperCase();
};

const number = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

const metric = (row: InferenceXPublicRow, ...keys: string[]): number | undefined => {
  for (const key of keys) {
    const n = number(row.metrics?.[key]);
    if (n !== undefined) return n;
  }
  return undefined;
};

const apiPrecision = (p: string | undefined): 'fp4' | 'fp8' | 'bf16' | undefined => {
  if (!p) return undefined;
  if (/int4|fp4|nvfp4/i.test(p)) return 'fp4';
  if (/fp8/i.test(p)) return 'fp8';
  if (/bf16|fp16/i.test(p)) return 'bf16';
  return undefined;
};

function physicalGpuCount(row: InferenceXPublicRow): number | null {
  const p = Math.max(0, number(row.num_prefill_gpu) ?? 0);
  const d = Math.max(0, number(row.num_decode_gpu) ?? 0);
  // Aggregated runs expose the same pool in both columns; do not double count it.
  const n = row.disagg ? p + d : Math.max(p, d);
  return n > 0 ? n : null;
}

function parallelism(row: InferenceXPublicRow): string {
  const stage = (name: string, tp: unknown, ep: unknown, workers: unknown) =>
    `${name} TP${number(tp) ?? 1} EP${number(ep) ?? 1}${number(workers) ? ` W${number(workers)}` : ''}`;
  return row.disagg
    ? `${stage('P', row.prefill_tp, row.prefill_ep, row.prefill_num_workers)} · ${stage('D', row.decode_tp, row.decode_ep, row.decode_num_workers)}`
    : stage('aggregated', row.decode_tp ?? row.prefill_tp, row.decode_ep ?? row.prefill_ep, row.decode_num_workers ?? row.prefill_num_workers);
}

function toBenchmark(row: InferenceXPublicRow, presetId: string, publicModel: string): BenchmarkRow | undefined {
  const outputPerGpu = metric(row, 'output_tput_per_gpu', 'output_throughput_per_gpu');
  const totalPerGpu = metric(row, 'tput_per_gpu', 'total_tput_per_gpu');
  if (!(outputPerGpu && outputPerGpu > 0)) return undefined;
  const medianTpotS = metric(row, 'median_tpot');
  const p99TpotS = metric(row, 'p99_tpot');
  const medianTtftS = metric(row, 'median_ttft');
  const p99TtftS = metric(row, 'p99_ttft');
  const interactivity = metric(row, 'median_intvty', 'median_interactivity') ?? (medianTpotS && medianTpotS > 0 ? 1 / medianTpotS : undefined);
  const date = (row.date ?? '').slice(0, 10) || 'undated';
  const hardware = row.hardware ?? 'unknown';
  const apiUrl = inferenceXApiUrl(publicModel);
  const sourceUrl = row.run_url && /^https:\/\//.test(row.run_url) ? row.run_url : apiUrl;
  const gpus = physicalGpuCount(row);
  const medianLatency = [medianTtftS !== undefined ? `median TTFT ${(medianTtftS * 1000).toFixed(0)} ms` : '', medianTpotS !== undefined ? `median TPOT ${(medianTpotS * 1000).toFixed(1)} ms` : ''].filter(Boolean).join(', ');
  return {
    id: `ix-live-${row.id ?? row.recipe_fingerprint ?? `${hardware}-${date}-${row.isl}-${row.osl}-${row.conc}`}`,
    suite: 'SemiAnalysis InferenceX (live public API)',
    round: date,
    task: `${publicModel}, ISL ${row.isl ?? '?'} / OSL ${row.osl ?? '?'}, ${row.benchmark_type ?? 'unknown workload'}`,
    model: presetId,
    system: `${acceleratorName(hardware)}, ${row.framework ?? 'unknown framework'}, ${row.disagg ? 'P/D disaggregated' : 'aggregated'}${row.spec_method ? `, ${row.spec_method}` : ''}`,
    accelerator: acceleratorName(hardware),
    accelerators: gpus,
    metric: `${row.disagg ? 'output tokens/s/decode GPU' : 'output tokens/s/GPU'}${medianLatency ? ` at ${medianLatency}` : ''}`,
    value: outputPerGpu,
    unit: 'output tokens/s/GPU',
    derived: { tokensPerSecPerGpu: totalPerGpu ?? outputPerGpu, outputTokensPerSecPerGpu: outputPerGpu },
    sourceUrl,
    apiUrl,
    sourceType: 'measured-paper',
    precision: row.precision?.toUpperCase(),
    parallelism: `${parallelism(row)} · ISL${row.isl ?? '?'} OSL${row.osl ?? '?'} · conc ${row.conc ?? '?'}`,
    latencyConstraint: p99TtftS !== undefined && p99TpotS !== undefined ? {
      ttftP99Ms: p99TtftS * 1000,
      tpotP99Ms: p99TpotS * 1000,
      minInteractivityTokPerSecPerUser: interactivity ?? 0,
    } : undefined,
    interactivityTokPerSecPerUser: interactivity,
    concurrency: number(row.conc),
    framework: row.framework,
    retrieved: new Date().toISOString().slice(0, 10),
    notes: `Live InferenceX public API row. Output throughput is used for decode calibration; InferenceX divides it by decode GPUs for P/D and by the shared pool for aggregated serving. Physical GPUs ${gpus ?? 'not reported'} (${row.disagg ? 'prefill + decode pools' : 'one aggregated pool'}). Prefix-cache savings are modeled analytically by AIDC Studio and are not inferred from this single-turn row.`,
  };
}

function score(row: InferenceXPublicRow, match: InferenceXMatch): number {
  const inf = match.inference;
  const wantedHardware = inferenceXHardwareKey(match.gpuRack.compute?.gpuModel);
  const rowHardware = row.hardware?.toLowerCase();
  let s = wantedHardware && rowHardware === wantedHardware ? 0 : 120;
  if (!!row.disagg !== !!inf.disaggregated) s += 45;
  const wantedPrecision = apiPrecision(inf.weightPrecision);
  const rowPrecision = apiPrecision(row.precision);
  if (wantedPrecision && rowPrecision && wantedPrecision !== rowPrecision) s += 35;
  else if (!rowPrecision) s += 12;
  const ratioPenalty = (actual: number | undefined, wanted: number) => actual && wanted > 0 ? Math.abs(Math.log2(actual / wanted)) * 18 : 30;
  s += ratioPenalty(number(row.isl), inf.inputTokens);
  s += ratioPenalty(number(row.osl), inf.outputTokens);
  if (row.benchmark_type && !/single.?turn/i.test(row.benchmark_type)) s += 30;
  const ttftMs = (metric(row, 'p99_ttft') ?? metric(row, 'median_ttft') ?? 0) * 1000;
  const tpotMs = (metric(row, 'p99_tpot') ?? metric(row, 'median_tpot') ?? 0) * 1000;
  if (ttftMs > inf.ttftSloMs) s += 180 + 20 * Math.log2(ttftMs / Math.max(1, inf.ttftSloMs));
  if (tpotMs > inf.tpotSloMs) s += 180 + 20 * Math.log2(tpotMs / Math.max(1, inf.tpotSloMs));
  // Prefer newer rows only after topology, shape and SLO compatibility.
  const ageDays = row.date ? Math.max(0, (Date.now() - Date.parse(row.date)) / 86400000) : 3650;
  return s + Math.min(10, ageDays / 365);
}

/** Convert and rank current public rows. This never silently takes the maximum-throughput point. */
export function rankInferenceXBenchmarks(rows: InferenceXPublicRow[], match: InferenceXMatch, limit = 40): BenchmarkRow[] {
  const publicModel = inferenceXModelName(match.presetId);
  if (!publicModel || !match.presetId) return [];
  return rows
    .map((row) => ({ row, benchmark: toBenchmark(row, match.presetId!, publicModel), score: score(row, match) }))
    .filter((x): x is { row: InferenceXPublicRow; benchmark: BenchmarkRow; score: number } => !!x.benchmark)
    .sort((a, b) => a.score - b.score || b.benchmark.value - a.benchmark.value)
    .slice(0, limit)
    .map((x) => x.benchmark);
}

// ───────────── measured-neighbour performance model ─────────────

export type InferenceXPredictionQuality = 'measured-near' | 'interpolated' | 'extrapolated' | 'high-variance' | 'insufficient' | 'unavailable';

export interface InferenceXPredictionEvidence {
  conditionKey: string;
  accelerator: string;
  outputTokensPerSecPerGpu: number;
  distance: number;
  isl: number;
  osl: number;
  interactivityTokPerSecPerUser?: number;
  tp: number;
  ep: number;
  accelerators?: number;
  framework: string;
  repetitions: number;
  sourceUrl: string;
}

export interface InferenceXHoldoutCase {
  conditionKey: string;
  measuredOutputTokensPerSecPerGpu: number;
  predictedOutputTokensPerSecPerGpu: number;
  absolutePercentageError: number;
  isl: number;
  osl: number;
  interactivityTokPerSecPerUser?: number;
  framework: string;
}

export interface InferenceXHardwarePrediction {
  hardware: string;
  accelerator: string;
  placedHardware: boolean;
  quality: InferenceXPredictionQuality;
  predictedOutputTokensPerSecPerGpu?: number;
  lowerOutputTokensPerSecPerGpu?: number;
  upperOutputTokensPerSecPerGpu?: number;
  measuredRows: number;
  conditionGroups: number;
  nearestDistance?: number;
  sloCompatibleGroups: number;
  validationCases: number;
  validationMedianAbsolutePercentageError?: number;
  validationP90AbsolutePercentageError?: number;
  evidence: InferenceXPredictionEvidence[];
  holdout: InferenceXHoldoutCase[];
}

export interface InferenceXPredictionReport {
  model: string;
  precision: 'fp4' | 'fp8' | 'bf16' | 'unknown';
  servingMode: 'aggregated' | 'disaggregated';
  target: {
    isl: number;
    osl: number;
    interactivityTokPerSecPerUser: number;
    tp: number;
    ep: number;
    accelerators?: number;
  };
  predictions: InferenceXHardwarePrediction[];
  /** Public attribution text that must remain next to exported or displayed predictions. */
  credit: string;
  sourceUrl: string;
  methodology: string;
}

interface MeasuredCondition {
  key: string;
  hardware: string;
  accelerator: string;
  precision?: 'fp4' | 'fp8' | 'bf16';
  disaggregated: boolean;
  framework: string;
  isl: number;
  osl: number;
  interactivity?: number;
  tp: number;
  ep: number;
  accelerators?: number;
  output: number;
  repetitions: number;
  sourceUrl: string;
}

interface PredictionTarget {
  isl: number;
  osl: number;
  interactivity?: number;
  tp: number;
  ep: number;
  accelerators?: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const quantile = (values: number[], q: number): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.max(0, Math.min(sorted.length - 1, (sorted.length - 1) * q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
};

const logRatio = (actual: number | undefined, wanted: number | undefined, missing = 0.75): number => {
  if (!(actual && actual > 0) || !(wanted && wanted > 0)) return missing;
  return Math.log2(actual / wanted);
};

function targetFor(match: InferenceXMatch): PredictionTarget {
  const topology = match.inference.disaggregated
    ? match.inference.decodeParallelism ?? match.inference.parallelism
    : match.inference.parallelism;
  return {
    isl: Math.max(1, match.inference.inputTokens),
    osl: Math.max(1, match.inference.outputTokens),
    interactivity: match.inference.tpotSloMs > 0 ? 1000 / match.inference.tpotSloMs : undefined,
    tp: Math.max(1, topology?.tp ?? 1),
    ep: Math.max(1, topology?.ep ?? 1),
    accelerators: match.targetAccelerators && match.targetAccelerators > 0 ? match.targetAccelerators : undefined,
  };
}

function pointDistance(point: MeasuredCondition, target: PredictionTarget): number {
  // Log distances make a 2× miss equally important above or below the target. Interactivity has the
  // largest weight because output throughput without its latency operating point is not comparable.
  const terms = [
    0.80 * logRatio(point.isl, target.isl),
    0.90 * logRatio(point.osl, target.osl),
    1.30 * logRatio(point.interactivity, target.interactivity),
    0.45 * logRatio(point.tp, target.tp),
    0.35 * logRatio(point.ep, target.ep),
    0.35 * logRatio(point.accelerators, target.accelerators, 0.35),
  ];
  return Math.sqrt(terms.reduce((sum, value) => sum + value * value, 0));
}

function conditionKey(row: InferenceXPublicRow, precision: string | undefined, tp: number, ep: number): string {
  // Date, image and run id are intentionally omitted. Repeated runs of one condition are aggregated
  // before validation so leave-one-out cannot "predict" a run from its duplicate.
  return [
    row.hardware?.toLowerCase(), precision ?? 'unknown', row.disagg ? 'pd' : 'agg', row.framework?.toLowerCase() ?? 'unknown',
    row.spec_method ?? 'none', row.isl ?? '?', row.osl ?? '?', row.conc ?? '?', tp, ep,
    row.prefill_tp ?? '?', row.prefill_ep ?? '?', row.prefill_num_workers ?? '?',
    row.prefill_dp_attention ?? false,
    row.decode_tp ?? '?', row.decode_ep ?? '?', row.decode_num_workers ?? '?', row.decode_dp_attention ?? false,
    row.num_prefill_gpu ?? '?', row.num_decode_gpu ?? '?', row.offload_mode ?? 'none',
  ].join('|');
}

function rowsForPublicModel(rows: InferenceXPublicRow[], publicModel: string): InferenceXPublicRow[] {
  const modelKey = (value: string | undefined) => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const exactModelRows = rows.filter((row) => modelKey(row.model) === modelKey(publicModel));
  // The public endpoint is already queried by exact display model, but some DB keys (for example dsr1)
  // are not reversible from that display name. Only apply the defensive row filter when it finds matches.
  return exactModelRows.length ? exactModelRows : rows;
}

function measuredConditions(rows: InferenceXPublicRow[], publicModel: string): MeasuredCondition[] {
  const grouped = new Map<string, { rows: InferenceXPublicRow[]; outputs: number[]; interactivities: number[] }>();
  for (const row of rowsForPublicModel(rows, publicModel)) {
    if (row.benchmark_type && !/single.?turn/i.test(row.benchmark_type)) continue;
    const hardware = row.hardware?.toLowerCase();
    const isl = number(row.isl);
    const osl = number(row.osl);
    const output = metric(row, 'output_tput_per_gpu', 'output_throughput_per_gpu');
    if (!hardware || !(isl && isl > 0) || !(osl && osl > 0) || !(output && output > 0)) continue;
    const precision = apiPrecision(row.precision);
    const tp = Math.max(1, number(row.decode_tp ?? row.prefill_tp) ?? 1);
    const ep = Math.max(1, number(row.decode_ep ?? row.prefill_ep) ?? 1);
    const key = conditionKey(row, precision, tp, ep);
    const medianTpot = metric(row, 'median_tpot');
    const interactivity = metric(row, 'median_intvty', 'median_interactivity')
      ?? (medianTpot && medianTpot > 0 ? 1 / medianTpot : undefined);
    const group = grouped.get(key) ?? { rows: [], outputs: [], interactivities: [] };
    group.rows.push(row);
    group.outputs.push(output);
    if (interactivity && interactivity > 0) group.interactivities.push(interactivity);
    grouped.set(key, group);
  }
  return [...grouped.entries()].map(([key, group]) => {
    const representative = [...group.rows].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
    const hardware = representative.hardware!.toLowerCase();
    const precision = apiPrecision(representative.precision);
    const tp = Math.max(1, number(representative.decode_tp ?? representative.prefill_tp) ?? 1);
    const ep = Math.max(1, number(representative.decode_ep ?? representative.prefill_ep) ?? 1);
    const fallbackUrl = inferenceXApiUrl(publicModel);
    return {
      key,
      hardware,
      accelerator: acceleratorName(hardware),
      precision,
      disaggregated: !!representative.disagg,
      framework: representative.framework ?? 'unknown',
      isl: number(representative.isl)!,
      osl: number(representative.osl)!,
      interactivity: group.interactivities.length ? median(group.interactivities) : undefined,
      tp,
      ep,
      accelerators: physicalGpuCount(representative) ?? undefined,
      output: median(group.outputs),
      repetitions: group.rows.length,
      sourceUrl: representative.run_url && /^https:\/\//.test(representative.run_url) ? representative.run_url : fallbackUrl,
    };
  });
}

function localPrediction(points: MeasuredCondition[], target: PredictionTarget): {
  value: number; nearestDistance: number; neighbours: Array<{ point: MeasuredCondition; distance: number; weight: number }>;
} | undefined {
  if (!points.length) return undefined;
  const neighbours = points
    .map((point) => ({ point, distance: pointDistance(point, target), weight: 0 }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 12)
    .map((entry) => ({ ...entry, weight: 1 / Math.pow(0.20 + entry.distance, 2) }));
  const weightSum = neighbours.reduce((sum, entry) => sum + entry.weight, 0);
  const logValue = neighbours.reduce((sum, entry) => sum + entry.weight * Math.log(entry.point.output), 0) / weightSum;
  return { value: Math.exp(logValue), nearestDistance: neighbours[0].distance, neighbours };
}

function holdoutValidation(points: MeasuredCondition[]): InferenceXHoldoutCase[] {
  if (points.length < 3) return [];
  const cases: InferenceXHoldoutCase[] = [];
  for (const held of points) {
    const predicted = localPrediction(points.filter((point) => point.key !== held.key), {
      isl: held.isl, osl: held.osl, interactivity: held.interactivity, tp: held.tp, ep: held.ep, accelerators: held.accelerators,
    });
    if (!predicted) continue;
    cases.push({
      conditionKey: held.key,
      measuredOutputTokensPerSecPerGpu: held.output,
      predictedOutputTokensPerSecPerGpu: predicted.value,
      absolutePercentageError: Math.abs(predicted.value / held.output - 1),
      isl: held.isl,
      osl: held.osl,
      interactivityTokPerSecPerUser: held.interactivity,
      framework: held.framework,
    });
  }
  return cases;
}

/**
 * Estimate output throughput from nearby public InferenceX measurements and quantify the estimate with
 * condition-level leave-one-out validation. It never transfers a value across precision or aggregated/P/D mode.
 * Missing comparable measurements are reported as unavailable instead of being filled from another GPU.
 */
export function predictInferenceXPerformance(rows: InferenceXPublicRow[], match: InferenceXMatch): InferenceXPredictionReport | undefined {
  const publicModel = inferenceXModelName(match.presetId);
  if (!publicModel) return undefined;
  const target = targetFor(match);
  const wantedPrecision = apiPrecision(match.inference.weightPrecision ?? 'fp8');
  const wantedHardware = inferenceXHardwareKey(match.gpuRack.compute?.gpuModel);
  const all = measuredConditions(rows, publicModel);
  const hardwareKeys = new Set(all.map((point) => point.hardware));
  if (wantedHardware) hardwareKeys.add(wantedHardware);
  const predictions = [...hardwareKeys].sort((a, b) => Number(b === wantedHardware) - Number(a === wantedHardware) || a.localeCompare(b)).map((hardware): InferenceXHardwarePrediction => {
    const hardwareRows = all.filter((point) => point.hardware === hardware);
    const comparable = hardwareRows.filter((point) => point.disaggregated === !!match.inference.disaggregated
      && (!!wantedPrecision ? point.precision === wantedPrecision : true));
    const base = {
      hardware,
      accelerator: acceleratorName(hardware),
      placedHardware: hardware === wantedHardware,
      measuredRows: comparable.reduce((sum, point) => sum + point.repetitions, 0),
      conditionGroups: comparable.length,
      sloCompatibleGroups: comparable.filter((point) => !target.interactivity || !!point.interactivity && point.interactivity >= target.interactivity).length,
    };
    const predicted = localPrediction(comparable, target);
    if (!predicted) return { ...base, quality: 'unavailable', validationCases: 0, evidence: [], holdout: [] };
    const holdout = holdoutValidation(comparable);
    const errors = holdout.map((entry) => entry.absolutePercentageError);
    const medianError = quantile(errors, 0.5);
    const p90Error = quantile(errors, 0.9);
    const weightSum = predicted.neighbours.reduce((sum, entry) => sum + entry.weight, 0);
    const logMean = Math.log(predicted.value);
    const logVariance = predicted.neighbours.reduce((sum, entry) => sum + entry.weight * Math.pow(Math.log(entry.point.output) - logMean, 2), 0) / weightSum;
    // This is an empirical planning band, not a statistical confidence interval. It combines local
    // measured spread with the p90 held-out error and keeps a minimum band for run-to-run variance.
    const uncertaintyLog = Math.max(0.12, Math.sqrt(logVariance), Math.log1p(p90Error ?? (comparable.length < 3 ? 0.35 : 0.20)));
    const factor = Math.exp(Math.min(Math.log(4), uncertaintyLog));
    const coverageQuality: InferenceXPredictionQuality = comparable.length < 2
      ? 'insufficient'
      : predicted.nearestDistance <= 0.50
        ? 'measured-near'
        : comparable.length >= 3 && predicted.nearestDistance <= 1.50
          ? 'interpolated'
          : 'extrapolated';
    const quality: InferenceXPredictionQuality = p90Error !== undefined && p90Error > 0.50 && coverageQuality !== 'insufficient'
      ? 'high-variance'
      : coverageQuality;
    const evidence = predicted.neighbours.slice(0, 5).map(({ point, distance }): InferenceXPredictionEvidence => ({
      conditionKey: point.key,
      accelerator: point.accelerator,
      outputTokensPerSecPerGpu: point.output,
      distance,
      isl: point.isl,
      osl: point.osl,
      interactivityTokPerSecPerUser: point.interactivity,
      tp: point.tp,
      ep: point.ep,
      accelerators: point.accelerators,
      framework: point.framework,
      repetitions: point.repetitions,
      sourceUrl: point.sourceUrl,
    }));
    return {
      ...base,
      quality,
      predictedOutputTokensPerSecPerGpu: predicted.value,
      lowerOutputTokensPerSecPerGpu: predicted.value / factor,
      upperOutputTokensPerSecPerGpu: predicted.value * factor,
      nearestDistance: predicted.nearestDistance,
      validationCases: holdout.length,
      validationMedianAbsolutePercentageError: medianError,
      validationP90AbsolutePercentageError: p90Error,
      evidence,
      holdout: holdout.sort((a, b) => b.absolutePercentageError - a.absolutePercentageError),
    };
  });
  return {
    model: publicModel,
    precision: wantedPrecision ?? 'unknown',
    servingMode: match.inference.disaggregated ? 'disaggregated' : 'aggregated',
    target: {
      isl: target.isl,
      osl: target.osl,
      interactivityTokPerSecPerUser: target.interactivity ?? 0,
      tp: target.tp,
      ep: target.ep,
      accelerators: target.accelerators,
    },
    predictions,
    credit: 'Benchmark data and run provenance: SemiAnalysis InferenceX. Prediction, interpolation and validation: AIDC Studio (independent; not endorsed by SemiAnalysis).',
    sourceUrl: inferenceXApiUrl(publicModel),
    methodology: 'Weighted geometric nearest-neighbour estimate in log ISL, OSL, interactivity, TP, EP and measured cluster-scale space; repeated identical conditions are median-aggregated; error is condition-level leave-one-out absolute percentage error.',
  };
}

/** A derived row for explicitly applying the prediction to the placed accelerator. */
export function inferenceXPredictionBenchmark(report: InferenceXPredictionReport, prediction: InferenceXHardwarePrediction, presetId: string): BenchmarkRow | undefined {
  const value = prediction.predictedOutputTokensPerSecPerGpu;
  if (!(value && value > 0) || ['unavailable', 'insufficient', 'extrapolated', 'high-variance'].includes(prediction.quality)) return undefined;
  const error = prediction.validationP90AbsolutePercentageError;
  return {
    id: `ix-model-${presetId}-${prediction.hardware}-${report.servingMode}-${report.precision}`,
    suite: 'AIDC Studio measured-neighbour model · SemiAnalysis InferenceX data',
    round: new Date().toISOString().slice(0, 10),
    task: `${report.model}, ISL ${report.target.isl} / OSL ${report.target.osl}, ${report.servingMode}`,
    model: presetId,
    system: `${prediction.accelerator}, ${prediction.conditionGroups} measured condition groups, ${prediction.quality}`,
    accelerator: prediction.accelerator,
    accelerators: null,
    metric: 'predicted output tokens/s/GPU',
    value,
    unit: 'output tokens/s/GPU',
    derived: { tokensPerSecPerGpu: value, outputTokensPerSecPerGpu: value },
    sourceUrl: report.sourceUrl,
    apiUrl: report.sourceUrl,
    sourceType: 'derived',
    precision: report.precision.toUpperCase(),
    parallelism: `TP${report.target.tp} EP${report.target.ep} · ISL${report.target.isl} OSL${report.target.osl}`,
    interactivityTokPerSecPerUser: report.target.interactivityTokPerSecPerUser || undefined,
    retrieved: new Date().toISOString().slice(0, 10),
    notes: `${report.credit} ${report.methodology} Empirical planning band ${prediction.lowerOutputTokensPerSecPerGpu?.toFixed(1)}–${prediction.upperOutputTokensPerSecPerGpu?.toFixed(1)} output tok/s/GPU${error === undefined ? '' : `; held-out p90 absolute error ${(error * 100).toFixed(1)}%`}.`,
  };
}

// ───────────── measured interactivity / throughput envelopes ─────────────

export interface InferenceXPerformanceCurvePoint {
  id: string;
  servingMode: 'aggregated' | 'disaggregated';
  interactivityTokPerSecPerUser: number;
  /** Facility-normalised output: measured total output divided by every GPU in the serving unit. */
  outputTokensPerSecPerGpu: number;
  /** Upstream metric. In P/D runs its denominator is decode GPUs only. */
  decodeOutputTokensPerSecPerGpu: number;
  measuredOutputTokensPerSec: number;
  projectedClusterOutputTokensPerSec: number;
  outputTokensPerSecPerMW?: number;
  powerWPerGpu?: number;
  framework: string;
  precision: string;
  specMethod?: string;
  isl: number;
  osl: number;
  concurrency?: number;
  prefillTp: number;
  prefillEp: number;
  prefillDpAttention: boolean;
  prefillWorkers: number;
  decodeTp: number;
  decodeEp: number;
  decodeDpAttention: boolean;
  decodeWorkers: number;
  prefillGpus: number;
  decodeGpus: number;
  deploymentGpus: number;
  deploymentCopies: number;
  placedGpus: number;
  idleGpus: number;
  fitsPlacedCluster: boolean;
  repetitions: number;
  measuredAt?: string;
  sourceUrl: string;
}

export interface InferenceXPerformanceCurve {
  servingMode: 'aggregated' | 'disaggregated';
  isl: number;
  osl: number;
  exactTargetShape: boolean;
  measuredPoints: InferenceXPerformanceCurvePoint[];
  throughputFrontier: InferenceXPerformanceCurvePoint[];
  clusterFrontier: InferenceXPerformanceCurvePoint[];
  efficiencyFrontier: InferenceXPerformanceCurvePoint[];
}

export interface InferenceXPerformanceCurveReport {
  model: string;
  hardware: string;
  accelerator: string;
  precision: 'fp4' | 'fp8' | 'bf16';
  targetIsl: number;
  targetOsl: number;
  targetAccelerators?: number;
  directlyComparable: boolean;
  sweepAxes: {
    prefillTp: number[];
    prefillEp: number[];
    prefillDpAttention: boolean[];
    prefillWorkers: number[];
    prefillGpuCounts: number[];
    decodeTp: number[];
    decodeEp: number[];
    decodeDpAttention: boolean[];
    decodeWorkers: number[];
    decodeGpuCounts: number[];
    concurrency: number[];
    specMethods: string[];
  };
  curves: InferenceXPerformanceCurve[];
  credit: string;
}

function paretoFrontier(points: InferenceXPerformanceCurvePoint[], y: (point: InferenceXPerformanceCurvePoint) => number | undefined): InferenceXPerformanceCurvePoint[] {
  // Both axes are beneficial. Scan from the fastest-user end and retain only points that improve
  // throughput, then return them left-to-right for drawing the familiar descending envelope.
  let bestY = Number.NEGATIVE_INFINITY;
  const frontier: InferenceXPerformanceCurvePoint[] = [];
  const ordered = [...points].filter((point) => {
    const value = y(point);
    return value !== undefined && Number.isFinite(value) && value > 0;
  }).sort((a, b) => b.interactivityTokPerSecPerUser - a.interactivityTokPerSecPerUser || (y(b)! - y(a)!));
  for (const point of ordered) {
    const value = y(point)!;
    if (value > bestY * (1 + 1e-9)) {
      frontier.push(point);
      bestY = value;
    }
  }
  return frontier.reverse();
}

function powerIsValid(row: InferenceXPublicRow): boolean {
  if (metric(row, 'power_valid') === 0) return false;
  const reasons = row.power_invalid_reasons;
  if (Array.isArray(reasons) && reasons.length > 0) return false;
  if (typeof reasons === 'string' && reasons.trim() && reasons.trim() !== '[]') return false;
  return true;
}

function shapeDistance(isl: number, osl: number, target: PredictionTarget): number {
  const i = logRatio(isl, target.isl);
  const o = logRatio(osl, target.osl);
  return Math.sqrt(i * i + o * o);
}

/** Build measured aggregated and P/D Pareto envelopes for the placed GPU and closest available request shape. */
export function inferenceXPerformanceCurves(rows: InferenceXPublicRow[], match: InferenceXMatch): InferenceXPerformanceCurveReport | undefined {
  const publicModel = inferenceXModelName(match.presetId);
  const hardware = inferenceXHardwareKey(match.gpuRack.compute?.gpuModel);
  const precision = apiPrecision(match.inference.weightPrecision ?? 'fp8');
  if (!publicModel || !hardware || !precision) return undefined;
  const target = targetFor(match);
  const base = rowsForPublicModel(rows, publicModel).filter((row) => {
    const output = metric(row, 'output_tput_per_gpu', 'output_throughput_per_gpu');
    const medianTpot = metric(row, 'median_tpot');
    const interactivity = metric(row, 'median_intvty', 'median_interactivity') ?? (medianTpot && medianTpot > 0 ? 1 / medianTpot : undefined);
    return row.hardware?.toLowerCase() === hardware
      && apiPrecision(row.precision) === precision
      && (!row.benchmark_type || /single.?turn/i.test(row.benchmark_type))
      && !!number(row.isl) && !!number(row.osl) && !!output && output > 0 && !!interactivity && interactivity > 0;
  });
  const curves: InferenceXPerformanceCurve[] = [];
  for (const disaggregated of [false, true]) {
    const modeRows = base.filter((row) => !!row.disagg === disaggregated);
    if (!modeRows.length) continue;
    const shapes = new Map<string, { isl: number; osl: number }>();
    for (const row of modeRows) {
      const isl = number(row.isl)!;
      const osl = number(row.osl)!;
      shapes.set(`${isl}|${osl}`, { isl, osl });
    }
    const shape = [...shapes.values()].sort((a, b) => shapeDistance(a.isl, a.osl, target) - shapeDistance(b.isl, b.osl, target))[0];
    const selected = modeRows.filter((row) => number(row.isl) === shape.isl && number(row.osl) === shape.osl);
    const groups = new Map<string, InferenceXPublicRow[]>();
    for (const row of selected) {
      const tp = Math.max(1, number(row.decode_tp ?? row.prefill_tp) ?? 1);
      const ep = Math.max(1, number(row.decode_ep ?? row.prefill_ep) ?? 1);
      const key = conditionKey(row, apiPrecision(row.precision), tp, ep);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const measuredPoints = [...groups.entries()].map(([key, group]): InferenceXPerformanceCurvePoint => {
      const representative = [...group].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
      const outputs = group.map((row) => metric(row, 'output_tput_per_gpu', 'output_throughput_per_gpu')!).filter((value) => value > 0);
      const interactivities = group.map((row) => {
        const medianTpot = metric(row, 'median_tpot');
        return metric(row, 'median_intvty', 'median_interactivity') ?? (medianTpot && medianTpot > 0 ? 1 / medianTpot : undefined);
      }).filter((value): value is number => !!value && value > 0);
      const rawDecodeOutput = median(outputs);
      const prefillTp = Math.max(1, number(representative.prefill_tp) ?? 1);
      const prefillEp = Math.max(1, number(representative.prefill_ep) ?? 1);
      const decodeTp = Math.max(1, number(representative.decode_tp ?? representative.prefill_tp) ?? 1);
      const decodeEp = Math.max(1, number(representative.decode_ep ?? representative.prefill_ep) ?? 1);
      const prefillGpus = Math.max(0, number(representative.num_prefill_gpu) ?? 0);
      const decodeGpus = Math.max(0, number(representative.num_decode_gpu) ?? 0);
      const deploymentGpus = disaggregated ? prefillGpus + decodeGpus : Math.max(prefillGpus, decodeGpus);
      const measuredOutput = rawDecodeOutput * (disaggregated ? decodeGpus : deploymentGpus);
      const facilityOutputPerGpu = deploymentGpus > 0 ? measuredOutput / deploymentGpus : rawDecodeOutput;
      const targetAccelerators = match.targetAccelerators && match.targetAccelerators > 0 ? Math.floor(match.targetAccelerators) : deploymentGpus;
      const deploymentCopies = deploymentGpus > 0 ? Math.floor(targetAccelerators / deploymentGpus) : 0;
      const placedGpus = deploymentCopies * deploymentGpus;
      const validPowerRows = group.filter(powerIsValid);
      const totalPowers = validPowerRows.map((row) => {
        const pGpus = Math.max(0, number(row.num_prefill_gpu) ?? 0);
        const dGpus = Math.max(0, number(row.num_decode_gpu) ?? 0);
        const totalGpus = row.disagg ? pGpus + dGpus : Math.max(pGpus, dGpus);
        const avg = metric(row, 'avg_power_w');
        const pPower = metric(row, 'prefill_avg_power_w');
        const dPower = metric(row, 'decode_avg_power_w');
        if (row.disagg && pPower && dPower && pGpus > 0 && dGpus > 0) return pPower * pGpus + dPower * dGpus;
        return avg && totalGpus > 0 ? avg * totalGpus : undefined;
      }).filter((value): value is number => !!value && value > 0);
      const totalPowerW = totalPowers.length ? median(totalPowers) : undefined;
      const powerW = totalPowerW && deploymentGpus > 0 ? totalPowerW / deploymentGpus : undefined;
      return {
        id: key,
        servingMode: disaggregated ? 'disaggregated' : 'aggregated',
        interactivityTokPerSecPerUser: median(interactivities),
        outputTokensPerSecPerGpu: facilityOutputPerGpu,
        decodeOutputTokensPerSecPerGpu: rawDecodeOutput,
        measuredOutputTokensPerSec: measuredOutput,
        projectedClusterOutputTokensPerSec: measuredOutput * deploymentCopies,
        outputTokensPerSecPerMW: totalPowerW ? measuredOutput / totalPowerW * 1_000_000 : undefined,
        powerWPerGpu: powerW,
        framework: representative.framework ?? 'unknown',
        precision: representative.precision ?? precision,
        specMethod: representative.spec_method ?? undefined,
        isl: shape.isl,
        osl: shape.osl,
        concurrency: number(representative.conc),
        prefillTp,
        prefillEp,
        prefillDpAttention: !!representative.prefill_dp_attention,
        prefillWorkers: Math.max(disaggregated ? 1 : 0, number(representative.prefill_num_workers) ?? 0),
        decodeTp,
        decodeEp,
        decodeDpAttention: !!representative.decode_dp_attention,
        decodeWorkers: Math.max(disaggregated ? 1 : 0, number(representative.decode_num_workers) ?? 0),
        prefillGpus,
        decodeGpus,
        deploymentGpus,
        deploymentCopies,
        placedGpus,
        idleGpus: Math.max(0, targetAccelerators - placedGpus),
        fitsPlacedCluster: deploymentCopies > 0,
        repetitions: group.length,
        measuredAt: representative.date?.slice(0, 10),
        sourceUrl: representative.run_url && /^https:\/\//.test(representative.run_url) ? representative.run_url : inferenceXApiUrl(publicModel),
      };
    }).sort((a, b) => a.interactivityTokPerSecPerUser - b.interactivityTokPerSecPerUser);
    curves.push({
      servingMode: disaggregated ? 'disaggregated' : 'aggregated',
      isl: shape.isl,
      osl: shape.osl,
      exactTargetShape: shape.isl === target.isl && shape.osl === target.osl,
      measuredPoints,
      throughputFrontier: paretoFrontier(measuredPoints, (point) => point.outputTokensPerSecPerGpu),
      clusterFrontier: paretoFrontier(measuredPoints.filter((point) => point.fitsPlacedCluster), (point) => point.projectedClusterOutputTokensPerSec),
      efficiencyFrontier: paretoFrontier(measuredPoints, (point) => point.outputTokensPerSecPerMW),
    });
  }
  if (!curves.length) return undefined;
  return {
    model: publicModel,
    hardware,
    accelerator: acceleratorName(hardware),
    precision,
    targetIsl: target.isl,
    targetOsl: target.osl,
    targetAccelerators: match.targetAccelerators,
    directlyComparable: curves.length > 1 && curves.every((curve) => curve.isl === curves[0].isl && curve.osl === curves[0].osl),
    sweepAxes: {
      prefillTp: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.prefillTp)))].sort((a, b) => a - b),
      prefillEp: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.prefillEp)))].sort((a, b) => a - b),
      prefillDpAttention: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.prefillDpAttention)))].sort(),
      prefillWorkers: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.prefillWorkers)).filter((value) => value > 0))].sort((a, b) => a - b),
      prefillGpuCounts: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.prefillGpus)).filter((value) => value > 0))].sort((a, b) => a - b),
      decodeTp: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.decodeTp)))].sort((a, b) => a - b),
      decodeEp: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.decodeEp)))].sort((a, b) => a - b),
      decodeDpAttention: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.decodeDpAttention)))].sort(),
      decodeWorkers: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.decodeWorkers)).filter((value) => value > 0))].sort((a, b) => a - b),
      decodeGpuCounts: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.decodeGpus)).filter((value) => value > 0))].sort((a, b) => a - b),
      concurrency: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.concurrency).filter((value): value is number => !!value && value > 0)))].sort((a, b) => a - b),
      specMethods: [...new Set(curves.flatMap((curve) => curve.measuredPoints.map((point) => point.specMethod ?? 'none')))].sort(),
    },
    curves,
    credit: 'Measured points and run provenance: SemiAnalysis InferenceX. Pareto filtering and visualisation: AIDC Studio (independent; not endorsed by SemiAnalysis or NVIDIA).',
  };
}

export interface InferenceXCacheBenchmark extends InferencePrefixCacheTrace {
  model: string;
  hardware: string;
  disaggregated: boolean;
  totalTokensPerSecPerGpu?: number;
  inputTokensPerSecPerGpu?: number;
  medianE2eMs?: number;
  medianItlMs?: number;
  medianInteractivity?: number;
}

function toCacheBenchmark(row: InferenceXPublicRow, publicModel: string): InferenceXCacheBenchmark | undefined {
  if (!/agentic.?traces/i.test(row.benchmark_type ?? '')) return undefined;
  const gpuHitRate = metric(row, 'server_gpu_cache_hit_rate');
  if (gpuHitRate === undefined) return undefined;
  const hardware = row.hardware ?? 'unknown';
  const date = (row.date ?? '').slice(0, 10) || undefined;
  const apiUrl = inferenceXApiUrl(publicModel, 'agentic-traces');
  const sourceUrl = row.run_url && /^https:\/\//.test(row.run_url) ? row.run_url : apiUrl;
  return {
    benchmarkId: `ix-agentx-${row.id ?? row.recipe_fingerprint ?? `${hardware}-${date ?? 'undated'}-${row.conc ?? 'unknown'}`}`,
    source: `SemiAnalysis InferenceX AgentX (${publicModel}${date ? `, ${date}` : ''})`,
    sourceUrl,
    model: publicModel,
    hardware,
    accelerator: acceleratorName(hardware),
    framework: row.framework,
    precision: row.precision,
    concurrency: number(row.conc),
    offloadMode: row.offload_mode ?? undefined,
    gpuHitRate,
    cpuHitRate: metric(row, 'server_cpu_cache_hit_rate'),
    externalHitRate: metric(row, 'server_external_cache_hit_rate'),
    theoreticalHitRate: metric(row, 'theoretical_cache_hit_rate'),
    outputTokensPerSecPerGpu: metric(row, 'output_tput_per_gpu', 'output_throughput_per_gpu'),
    totalTokensPerSecPerGpu: metric(row, 'tput_per_gpu', 'total_tput_per_gpu'),
    inputTokensPerSecPerGpu: metric(row, 'input_tput_per_gpu', 'input_throughput_per_gpu'),
    medianE2eMs: (() => { const v = metric(row, 'median_e2e'); return v === undefined ? undefined : v * 1000; })(),
    medianItlMs: (() => { const v = metric(row, 'median_itl'); return v === undefined ? undefined : v * 1000; })(),
    medianInteractivity: metric(row, 'median_intvty', 'median_interactivity'),
    disaggregated: !!row.disagg,
    measuredAt: date,
  };
}

function cacheScore(row: InferenceXPublicRow, match: InferenceXMatch): number {
  const wantedHardware = inferenceXHardwareKey(match.gpuRack.compute?.gpuModel);
  let score = wantedHardware && row.hardware?.toLowerCase() === wantedHardware ? 0 : 120;
  if (!!row.disagg !== !!match.inference.disaggregated) score += 45;
  const wantedPrecision = apiPrecision(match.inference.weightPrecision);
  const rowPrecision = apiPrecision(row.precision);
  if (wantedPrecision && rowPrecision && wantedPrecision !== rowPrecision) score += 35;
  else if (!rowPrecision) score += 12;
  const ageDays = row.date ? Math.max(0, (Date.now() - Date.parse(row.date)) / 86400000) : 3650;
  return score + Math.min(10, ageDays / 365);
}

/** Rank AgentX trace points by platform compatibility; concurrency remains visible for explicit user selection. */
export function rankInferenceXCacheBenchmarks(rows: InferenceXPublicRow[], match: InferenceXMatch, limit = 80): InferenceXCacheBenchmark[] {
  const publicModel = inferenceXModelName(match.presetId);
  if (!publicModel) return [];
  return rows
    .map((row) => ({ row, trace: toCacheBenchmark(row, publicModel), score: cacheScore(row, match) }))
    .filter((x): x is { row: InferenceXPublicRow; trace: InferenceXCacheBenchmark; score: number } => !!x.trace)
    .sort((a, b) => a.score - b.score
      || (a.trace.concurrency ?? Number.POSITIVE_INFINITY) - (b.trace.concurrency ?? Number.POSITIVE_INFINITY)
      || (b.trace.measuredAt ?? '').localeCompare(a.trace.measuredAt ?? ''))
    .slice(0, limit)
    .map((x) => x.trace);
}
