import {
  applyModelPreset, catalogItems, FABRIC_SWITCH, findCatalogItem, findModelPreset, footprintRect, instanceRect, rectContains, rectsOverlap,
  type CatalogItem, type EquipmentCategory, type FabricTech, type Project, type Rect, type Vec2, type WorkloadBlueprint,
} from '@aidc/core';
import type { ThermalMetrics } from '@aidc/thermal';

/** i18n key of an equipment category label (fix v2 2차: the Korean-only CATEGORY_LABEL map showed in the EN UI). */
export const categoryLabelKey = (c: EquipmentCategory | string) => `layout.cat.${c}`;

export const PLACEABLE: EquipmentCategory[] = ['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack', 'cdu', 'crah', 'rpp', 'ups', 'battery', 'transformer', 'generator', 'chiller', 'dry-cooler'];

/** Options from the EFFECTIVE catalog (builtin ∪ library ∪ project extensions published by the store). */
export const catalogOptions = (cats: EquipmentCategory[]) => catalogItems().filter((c) => cats.includes(c.category)).map((c) => ({ value: c.id, label: c.name }));

export const itemOf = (catalogId: string): CatalogItem | undefined => findCatalogItem(catalogId);

export function hallEquipment(p: Project, hallId: string) {
  return p.equipment.filter((e) => e.hallId === hallId);
}

/** Electrical load used for color coding (network racks: switch estimate). */
export function equipmentKW(catalogId: string, loadFactor = 1): number {
  const it = findCatalogItem(catalogId);
  if (!it) return 0;
  if (it.category === 'network-rack') return 25 * loadFactor;
  if (it.category === 'crah' || it.category === 'cdu') return (it.power?.typicalKW ?? 0) * loadFactor;
  return (it.power?.nameplateKW ?? 0) * loadFactor;
}

export function rackPowerValues(p: Project, hallId: string): { values: Record<string, number>; range: [number, number] } {
  const values: Record<string, number> = {};
  let max = 1;
  for (const e of hallEquipment(p, hallId)) {
    const kw = equipmentKW(e.catalogId, e.loadFactor ?? 1);
    values[e.id] = kw;
    max = Math.max(max, kw);
  }
  return { values, range: [0, Math.ceil(max / 10) * 10] };
}

export function inletValues(m: ThermalMetrics | null): { values: Record<string, number>; range: [number, number] } {
  const values: Record<string, number> = {};
  m?.racks.forEach((r) => (values[r.id] = r.inletMaxC));
  return { values, range: [18, 35] };
}

/**
 * Free position for a new item: outside every placed footprint *and* its service clearances (front / rear / sides), outside
 * containments (hot / cold aisles) and keepouts, with the new item's own clearances kept free as well. Candidates are ordered by
 * distance to the nearest existing row end (or the hall's services rows), not the hall centre, so added racks extend a row
 * instead of landing in a hot aisle.
 */
export function findFreeSpot(p: Project, hallId: string, item: CatalogItem, rotation: 0 | 90 | 180 | 270): Vec2 | null {
  const hall = p.halls.find((h) => h.id === hallId);
  if (!hall) return null;
  const eq = hallEquipment(p, hallId);
  const placed = eq.flatMap((e) => {
    const ci = findCatalogItem(e.catalogId);
    return ci ? [{ e, ci, rect: instanceRect(e, ci) }] : [];
  });
  // footprints + service clearances of what is already there
  const taken: Rect[] = placed.flatMap(({ e, ci, rect }) => [rect, ...clearanceRects(rect, ci, e.rotationDeg)]);
  p.containments.filter((c) => c.hallId === hallId).forEach((c) => taken.push(c.rect));
  hall.keepouts.forEach((k) => taken.push(k.rect));
  const bounds = { x: 0, y: 0, w: hall.width, d: hall.depth };
  const step = hall.tileSize || 0.6;
  // anchors: row ends of the existing rows (racks), else the hall centre
  const racks = placed.filter(({ ci }) => ['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack', 'cdu'].includes(ci.category));
  const anchors: Vec2[] = [];
  const byRow = new Map<string, typeof racks>();
  for (const r of racks) {
    const key = r.e.rowId ?? `y-${Math.round(r.e.position.y / 0.3)}`;
    const l = byRow.get(key) ?? [];
    l.push(r);
    byRow.set(key, l);
  }
  for (const list of byRow.values()) {
    const xs = list.map((r) => r.rect.x);
    const xe = list.map((r) => r.rect.x + r.rect.w);
    const y = list.reduce((a, r) => a + r.e.position.y, 0) / list.length;
    anchors.push({ x: Math.max(...xe) + item.dims.w / 2 + 0.05, y }, { x: Math.min(...xs) - item.dims.w / 2 - 0.05, y });
  }
  if (!anchors.length) anchors.push({ x: hall.width / 2, y: hall.depth / 2 });
  const candidates: Vec2[] = [];
  for (let y = step / 2; y < hall.depth; y += step) for (let x = step / 2; x < hall.width; x += step) candidates.push({ x, y });
  // exact row-end anchors first (snapped to nothing), then the tile grid by distance to the nearest anchor
  const dist = (c: Vec2) => Math.min(...anchors.map((a) => Math.hypot(a.x - c.x, a.y - c.y)));
  candidates.sort((a, b) => dist(a) - dist(b));
  for (const c of [...anchors, ...candidates]) {
    const r = footprintRect(item.dims, c, rotation);
    if (!rectContains(bounds, r)) continue;
    const own = [r, ...clearanceRects(r, item, rotation)];
    if (own.some((o) => taken.some((t) => rectsOverlap(o, t)))) continue;
    // the new item's clearances must not eat into existing footprints either
    if (own.slice(1).some((o) => placed.some((q) => rectsOverlap(o, q.rect)))) continue;
    return c;
  }
  return null;
}

/** Service-clearance rectangles (front / rear / sides) of a footprint for a rotation (0 = front faces +Y). */
function clearanceRects(r: Rect, item: CatalogItem, rot: 0 | 90 | 180 | 270): Rect[] {
  const cl = item.clearance;
  if (!cl) return [];
  const f = cl.front ?? 0;
  const b = cl.rear ?? 0;
  const sd = cl.sides ?? 0;
  const out: Rect[] = [];
  // frontVector(rot) = (−sin, cos): 0 → +Y, 90 → −X, 180 → −Y, 270 → +X
  const front = rot === 0 ? 'N' : rot === 180 ? 'S' : rot === 90 ? 'W' : 'E';
  const rear = rot === 0 ? 'S' : rot === 180 ? 'N' : rot === 90 ? 'E' : 'W';
  const side = (dir: 'N' | 'S' | 'E' | 'W', d: number): Rect | null => {
    if (d <= 0) return null;
    if (dir === 'N') return { x: r.x, y: r.y + r.d, w: r.w, d };
    if (dir === 'S') return { x: r.x, y: r.y - d, w: r.w, d };
    if (dir === 'E') return { x: r.x + r.w, y: r.y, w: d, d: r.d };
    return { x: r.x - d, y: r.y, w: d, d: r.d };
  };
  for (const z of [side(front, f), side(rear, b), ...(['N', 'S', 'E', 'W'] as const).filter((d) => d !== front && d !== rear).map((d) => side(d, sd))]) if (z) out.push(z);
  return out;
}

export const FABRIC_LABEL: Record<FabricTech, string> = {
  'ib-xdr-800': 'InfiniBand XDR 800G (Quantum-X800)',
  'ib-ndr-400': 'InfiniBand NDR 400G (Quantum-2)',
  'spectrumx-800': 'Spectrum-X 800GbE RoCE',
  'spectrumx-400': 'Spectrum-X 400GbE RoCE',
  'roce-generic-400': 'Generic RoCEv2 400GbE',
  'roce-generic-800': 'Generic RoCEv2 800GbE',
  'ethernet-400': 'Ethernet 400GbE',
  'ethernet-200': 'Ethernet 200GbE',
  'ethernet-100': 'Ethernet 100GbE',
  'ethernet-1g': 'Ethernet 1GbE',
  // v2 (S2)
  'drivenets-fse': 'DriveNets FSE DDC 800G (NCP/NCF)',
  'ese-uec-400': 'DriveNets ESE 400GbE + UEC NIC (TH5)',
};

/** Default switch per fabric: the core map (stream C, P3 — generic Ethernet fabrics use generic switch classes; no web-side copy). */
export { FABRIC_SWITCH };

export const SCALE_OUT_FABRICS: FabricTech[] = ['ib-xdr-800', 'ib-ndr-400', 'spectrumx-800', 'spectrumx-400', 'roce-generic-400', 'roce-generic-800', 'drivenets-fse', 'ese-uec-400'];
export const AUX_FABRICS: FabricTech[] = ['ethernet-400', 'ethernet-200', 'ethernet-100', 'spectrumx-400', 'ethernet-1g'];

export function switchOptionsFor(fabric: FabricTech) {
  const all = catalogItems();
  const compatible = all.filter((c) => c.category === 'switch' && (c.switch?.fabric === fabric || c.id === FABRIC_SWITCH[fabric]));
  const list = compatible.length ? compatible : all.filter((c) => c.category === 'switch');
  return list.map((c) => ({ value: c.id, label: c.name }));
}

const uid = (p: string) => `${p}-${Math.random().toString(36).slice(2, 8)}`;

// ── WORKLOAD_TEMPLATES (stream T6, v2 2차): the architecture comes from MODEL_PRESETS (official config.json / model card,
//    docs/research/r2-model-presets.json); the job parameters (tokens, batch, parallelism, SLOs) are editable examples.
//    `label` is English; the Workload panel shows t(labelKey). Throughput is never part of a template — calibrate it.
const presetModel = (presetId: string, seqLen: number): WorkloadBlueprint['model'] => {
  const p = findModelPreset(presetId);
  if (!p) throw new Error(`unknown model preset: ${presetId}`);
  return applyModelPreset({ name: p.name, paramsB: p.paramsB, activeParamsB: p.activeParamsB, layers: p.layers, hiddenSize: p.hiddenSize, seqLen }, p);
};

export const WORKLOAD_TEMPLATES: { key: string; label: string; labelKey: string; presetId: string; make: () => WorkloadBlueprint }[] = [
  {
    key: 'pretrain-llama3.1-405b', label: 'Pre-training — Llama 3.1 405B (dense)', labelKey: 'workload.tpl.pretrain405b', presetId: 'llama3.1-405b',
    make: () => ({
      id: uid('wl'), name: 'LLM Pre-training — Llama 3.1 405B', kind: 'llm-pretrain', gpuShare: 1, presetId: 'llama3.1-405b',
      model: presetModel('llama3.1-405b', 8192),
      // Llama 3 paper: 15T tokens, 16M tokens/step, TP8 · PP (here 4) — FP8 is this template's choice
      training: { tokensB: 15000, globalBatchTokensM: 16, precision: 'fp8', tp: 8, pp: 4, ep: 1, cp: 1, zeroStage: 3, microBatchSeqs: 1, checkpointEveryMin: 30, checkpointDurationS: 90, mtbfHoursPerGpu: 50000 },
      durationDays: 60,
    }),
  },
  {
    key: 'pretrain-deepseek-v3', label: 'Pre-training — DeepSeek-V3 671B (MoE)', labelKey: 'workload.tpl.pretrainDsv3', presetId: 'deepseek-v3',
    make: () => ({
      id: uid('wl'), name: 'MoE Pre-training — DeepSeek-V3 671B', kind: 'llm-pretrain', gpuShare: 1, presetId: 'deepseek-v3',
      model: presetModel('deepseek-v3', 4096),
      // DeepSeek-V3 technical report: 14.8T tokens, seq 4K, batch 15,360 sequences, FP8, 16-way PP, 64-way EP, ZeRO-1 DP
      training: { tokensB: 14800, globalBatchTokensM: (15360 * 4096) / 1e6, precision: 'fp8', tp: 1, pp: 16, ep: 64, cp: 1, zeroStage: 1, microBatchSeqs: 1, checkpointEveryMin: 30, checkpointDurationS: 120, mtbfHoursPerGpu: 50000 },
      durationDays: 90,
    }),
  },
  {
    key: 'finetune-llama3.1-70b', label: 'Fine-tuning — Llama 3.1 70B', labelKey: 'workload.tpl.finetune70b', presetId: 'llama3.1-70b',
    make: () => ({
      id: uid('wl'), name: 'Fine-tuning — Llama 3.1 70B', kind: 'llm-finetune', gpuShare: 0.1, presetId: 'llama3.1-70b',
      model: presetModel('llama3.1-70b', 8192),
      training: { tokensB: 50, globalBatchTokensM: 4, precision: 'bf16', tp: 8, pp: 1, ep: 1, cp: 1, zeroStage: 3, microBatchSeqs: 1, checkpointEveryMin: 60, checkpointDurationS: 40, mtbfHoursPerGpu: 50000 },
      durationDays: 7,
    }),
  },
  {
    key: 'inference-deepseek-r1', label: 'Inference — DeepSeek-R1 671B (MoE)', labelKey: 'workload.tpl.inferDsr1', presetId: 'deepseek-r1',
    make: () => ({
      id: uid('wl'), name: 'MoE Inference — DeepSeek-R1 671B', kind: 'llm-inference', gpuShare: 0.25, presetId: 'deepseek-r1',
      model: presetModel('deepseek-r1', 32768),
      inference: { requestsPerSec: 400, inputTokens: 2000, outputTokens: 600, ttftSloMs: 1000, tpotSloMs: 40, disaggregated: true, kvPrecision: 'fp8' },
      durationDays: 30,
    }),
  },
  {
    key: 'inference-gpt-oss-120b', label: 'Inference — gpt-oss-120b (MoE)', labelKey: 'workload.tpl.inferGptOss', presetId: 'gpt-oss-120b',
    make: () => ({
      id: uid('wl'), name: 'MoE Inference — gpt-oss-120b', kind: 'llm-inference', gpuShare: 0.1, presetId: 'gpt-oss-120b',
      model: presetModel('gpt-oss-120b', 8192),
      // SLOs = MLPerf Inference Server limits for gpt-oss-120b (TTFT 3,000 ms / TPOT 80 ms p99, loadgen/mlperf.conf)
      inference: { requestsPerSec: 500, inputTokens: 1000, outputTokens: 1000, ttftSloMs: 3000, tpotSloMs: 80, disaggregated: false, kvPrecision: 'fp8' },
      durationDays: 30,
    }),
  },
  {
    key: 'inference-qwen3-235b', label: 'Inference — Qwen3 235B-A22B (MoE)', labelKey: 'workload.tpl.inferQwen3', presetId: 'qwen3-235b-a22b',
    make: () => ({
      id: uid('wl'), name: 'MoE Inference — Qwen3 235B-A22B', kind: 'llm-inference', gpuShare: 0.1, presetId: 'qwen3-235b-a22b',
      model: presetModel('qwen3-235b-a22b', 32768),
      inference: { requestsPerSec: 300, inputTokens: 2000, outputTokens: 800, ttftSloMs: 1000, tpotSloMs: 50, disaggregated: true, kvPrecision: 'fp8' },
      durationDays: 30,
    }),
  },
  {
    key: 'inference-llama3.1-70b', label: 'Chat inference — Llama 3.1 70B (dense)', labelKey: 'workload.tpl.infer70b', presetId: 'llama3.1-70b',
    make: () => ({
      id: uid('wl'), name: 'Chat Inference — Llama 3.1 70B', kind: 'llm-inference', gpuShare: 0.1, presetId: 'llama3.1-70b',
      model: presetModel('llama3.1-70b', 16384),
      inference: { requestsPerSec: 1500, inputTokens: 1200, outputTokens: 400, ttftSloMs: 600, tpotSloMs: 30, disaggregated: false, kvPrecision: 'fp8' },
      durationDays: 30,
    }),
  },
];

