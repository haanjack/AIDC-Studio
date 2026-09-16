import type { CatalogItem, EvidenceSourceType } from '../model/types.ts';

/**
 * Per-precision MFU basis (stream T5, DECISIONS-v2-2 §C "MFU 기준"); citations are public vendor pages (retrieved 2026-09-15).
 *
 * One denominator convention for every accelerator: **dense tensor-core peak FLOPS per GPU at that precision**
 * (the vendor "dense" figure; where a vendor only publishes the *sparse* headline — NVIDIA rack exaFLOPS numbers —
 * dense = sparse ÷ 2, the ratio NVIDIA itself prints on the GB200 NVL72 / DGX B300 pages). MFU is then
 * `effective TFLOP/s per GPU ÷ peakTflops[precision]` and is displayed with this basis label.
 *
 * Values are TFLOPS (1e12 FLOPS) per GPU. `sourceType: 'unpublished'` means no credible figure exists: the engines
 * fall back to `gpuFlopsPeak × multiplier` (engines/traffic.ts peakFlopsFor) and the UI says so.
 * Accelerator families share one entry so the GB300 rack and the HGX B300 node can never disagree.
 */

export type FlopsPrecision = 'bf16' | 'fp8' | 'fp4';
export const MFU_PRECISIONS: FlopsPrecision[] = ['bf16', 'fp8', 'fp4'];

export interface PeakFlopsEvidence {
  /** dense TFLOPS per GPU (absent when unpublished) */
  value?: number;
  sourceType: EvidenceSourceType | 'unpublished';
  citation: string;
  url?: string;
}

export interface AcceleratorFlops {
  key: string;
  label: string;
  peakTflops: Partial<Record<FlopsPrecision, number>>;
  basis: Record<FlopsPrecision, PeakFlopsEvidence>;
}

export const MFU_BASIS: Record<FlopsPrecision, { label: string; definition: string }> = {
  bf16: { label: 'BF16 dense peak', definition: 'Dense BF16/FP16 tensor-core peak FLOPS per GPU (Llama 3 / PaLM MFU convention).' },
  fp8: { label: 'FP8 dense peak', definition: 'Dense FP8 tensor-core peak FLOPS per GPU (FP8 / MXFP8 recipes).' },
  fp4: { label: 'FP4 dense peak', definition: 'Dense FP4 tensor-core peak FLOPS per GPU (NVFP4 / MXFP4 recipes).' },
};

const NV_GB200 = 'https://www.nvidia.com/en-us/data-center/gb200-nvl72/';
const NV_B300 = 'https://www.nvidia.com/en-us/data-center/dgx-b300/';
const NV_H100 = 'https://www.nvidia.com/en-us/data-center/h100/';
const NV_VR = 'https://www.nvidia.com/en-us/data-center/vera-rubin-nvl72/';
const AMD_MI455 = 'https://www.amd.com/en/products/accelerators/instinct/mi400/mi455x.html';
const AMD_MI3 = 'https://www.amd.com/en/products/accelerators/instinct/mi300.html';

const unpublished = (why: string): PeakFlopsEvidence => ({ sourceType: 'unpublished', citation: why });

function entry(key: string, label: string, basis: Record<FlopsPrecision, PeakFlopsEvidence>): AcceleratorFlops {
  const peakTflops: Partial<Record<FlopsPrecision, number>> = {};
  for (const p of MFU_PRECISIONS) if (basis[p].value != null) peakTflops[p] = basis[p].value;
  return { key, label, peakTflops, basis };
}

export const ACCELERATOR_FLOPS: Record<string, AcceleratorFlops> = {
  h100: entry('h100', 'NVIDIA H100 / H200 (Hopper)', {
    bf16: { value: 989, sourceType: 'vendor-claim', citation: 'NVIDIA H100 product spec: FP16/BF16 tensor core ≈ 989 TFLOPS per GPU (catalog seed hgx-h100-node).', url: NV_H100 },
    fp8: { value: 1979, sourceType: 'vendor-claim', citation: 'NVIDIA H100 product spec: FP8 tensor core ≈ 1,979 TFLOPS per GPU.', url: NV_H100 },
    fp4: unpublished('Hopper has no FP4 tensor core; no FP4 peak is published.'),
  }),
  b200: entry('b200', 'NVIDIA B200 / GB200 (Blackwell)', {
    bf16: { value: 2500, sourceType: 'derived', citation: 'GB200 NVL72 page: FP16/BF16 tensor core 360 PFLOPS per rack (sparse headline) → ÷ 72 GPUs ÷ 2 (dense) = 2,500 TFLOPS.', url: NV_GB200 },
    fp8: { value: 5000, sourceType: 'derived', citation: 'GB200 NVL72 page: FP8/FP6 tensor core 720 PFLOPS per rack (sparse headline) → ÷ 72 ÷ 2 (dense) = 5,000 TFLOPS.', url: NV_GB200 },
    fp4: { value: 10000, sourceType: 'vendor-claim', citation: 'GB200 NVL72 page: NVFP4 tensor core "1,440 | 720 PFLOPS" (sparse | dense) → dense 720 PF ÷ 72 = 10,000 TFLOPS. (DGX B300 page "1.5× dense FP4 over DGX B200" implies 9,000 — within 10 %.)', url: NV_GB200 },
  }),
  b300: entry('b300', 'NVIDIA B300 / GB300 (Blackwell Ultra)', {
    bf16: { value: 2250, sourceType: 'estimate', citation: 'Not published for B300; FP8 dense ÷ 2 (same ratio as the GB200 NVL72 page BF16 : FP8).', url: NV_B300 },
    fp8: { value: 4500, sourceType: 'derived', citation: 'DGX B300 page: FP8 72 PFLOPS for 8 GPUs (sparse; dense is half) → 36 PF ÷ 8 = 4,500 TFLOPS.', url: NV_B300 },
    fp4: { value: 13500, sourceType: 'vendor-claim', citation: 'DGX B300 page: FP4 "144 PFLOPS | 108 PFLOPS" (sparse | dense) → 108 PF ÷ 8 = 13,500 TFLOPS. GB300 NVL72 uses the same B300 GPU.', url: NV_B300 },
  }),
  rubin: entry('rubin', 'NVIDIA Rubin (Vera Rubin NVL72)', {
    bf16: { value: 4375, sourceType: 'estimate', citation: 'Not published; FP8 dense ÷ 2.' },
    fp8: { value: 8750, sourceType: 'derived', citation: 'NVIDIA Vera Rubin NVL72 page (retrieved 2026-09-15): FP8/FP6 training 1,260 PFLOPS per rack — NVIDIA rack headline, sparse convention like GB200 → ÷ 72 ÷ 2 = 8,750 TFLOPS dense.', url: NV_VR },
    fp4: { value: 25000, sourceType: 'derived', citation: 'NVIDIA Vera Rubin NVL72 page (retrieved 2026-09-15): NVFP4 inference 3,600 PFLOPS per rack (sparse headline) → ÷ 72 ÷ 2 = 25,000 TFLOPS dense.', url: NV_VR },
  }),
  mi300x: entry('mi300x', 'AMD Instinct MI300X / MI325X (CDNA 3)', {
    bf16: { value: 1307.4, sourceType: 'vendor-claim', citation: 'AMD MI300X/MI325X product page: dense BF16 matrix 1,307.4 TFLOPS.', url: AMD_MI3 },
    fp8: { value: 2614.9, sourceType: 'vendor-claim', citation: 'AMD MI300X/MI325X product page: dense FP8 matrix 2,614.9 TFLOPS.', url: AMD_MI3 },
    fp4: unpublished('AMD publishes no FP4 figure for CDNA 3 (MI300X / MI325X).'),
  }),
  mi350x: entry('mi350x', 'AMD Instinct MI350X (CDNA 4)', {
    bf16: { value: 2300, sourceType: 'vendor-claim', citation: 'AMD MI350X brochure: dense BF16 2.3 PF.' },
    fp8: { value: 4600, sourceType: 'vendor-claim', citation: 'AMD MI350X brochure: dense FP8 4.6 PF.' },
    fp4: { value: 9200, sourceType: 'vendor-claim', citation: 'AMD MI350X brochure: dense FP4 9.2 PF.' },
  }),
  mi355x: entry('mi355x', 'AMD Instinct MI355X (CDNA 4)', {
    bf16: { value: 2516.6, sourceType: 'vendor-claim', citation: 'AMD Instinct + DriveNets reference architecture RF-72513 v1.0 (vendor document) Table 1: dense BF16 2.5166 PF.' },
    fp8: { value: 5033.2, sourceType: 'vendor-claim', citation: 'AMD Instinct + DriveNets reference architecture RF-72513 v1.0 (vendor document) Table 1: dense FP8 5.0332 PF.' },
    fp4: { value: 10066.3, sourceType: 'vendor-claim', citation: 'AMD Instinct + DriveNets reference architecture RF-72513 v1.0 (vendor document) Table 1: dense MXFP4 10.07 PF.' },
  }),
  mi455x: entry('mi455x', 'AMD Instinct MI455X (Helios)', {
    bf16: { value: 5000, sourceType: 'vendor-claim', citation: 'AMD MI455X product page: dense FP16/BF16 matrix 5 PF.', url: AMD_MI455 },
    fp8: { value: 20100, sourceType: 'vendor-claim', citation: 'AMD MI455X product page: dense FP8 20.1 PF (rack 1.4 EF = 72 × 20.1 PF, dense convention).', url: AMD_MI455 },
    fp4: { value: 40300, sourceType: 'vendor-claim', citation: 'AMD MI455X product page: dense FP4 40.3 PF (rack 2.9 EF = 72 × 40.3 PF).', url: AMD_MI455 },
  }),
};

/** Ordered: more specific patterns first (GB300 / B300 before B200). */
const FAMILY_PATTERNS: [RegExp, string][] = [
  [/GB300|B300|Blackwell Ultra/i, 'b300'],
  [/GB200|B200/i, 'b200'],
  [/Rubin/i, 'rubin'],
  [/H100|H200/i, 'h100'],
  [/MI455X/i, 'mi455x'],
  [/MI355X/i, 'mi355x'],
  [/MI350X/i, 'mi350x'],
  [/MI300X|MI325X/i, 'mi300x'],
];

/** Accelerator family key for a GPU-bearing catalog item (explicit `meta.flopsKey` wins), or undefined. */
export function acceleratorFlopsKey(item: Pick<CatalogItem, 'compute' | 'meta'>): string | undefined {
  const explicit = item.meta?.flopsKey;
  if (typeof explicit === 'string' && ACCELERATOR_FLOPS[explicit]) return explicit;
  const c = item.compute;
  if (!c || !(c.gpus > 0)) return undefined;
  const hay = `${c.gpuModel} ${c.accelerator?.family ?? ''}`;
  return FAMILY_PATTERNS.find(([re]) => re.test(hay))?.[1];
}

const SPEC_TO_EVIDENCE: Record<CatalogItem['source'], EvidenceSourceType> = {
  'open-standard': 'vendor-claim', 'vendor-datasheet': 'vendor-claim', 'public-spec': 'vendor-claim', announced: 'vendor-claim', estimate: 'estimate', user: 'estimate',
};

/**
 * MFU basis for every GPU-bearing item: the family table when the accelerator is known, otherwise the item's own
 * `compute.peakTflops` tagged with the item's source (precisions it lacks are 'unpublished'). Undefined for items without GPUs.
 */
export function mfuBasisFor(item: Pick<CatalogItem, 'compute' | 'meta' | 'source'>): { key?: string; basis: Record<FlopsPrecision, PeakFlopsEvidence> } | undefined {
  const key = acceleratorFlopsKey(item);
  if (key) return { key, basis: ACCELERATOR_FLOPS[key].basis };
  const c = item.compute;
  if (!c || !(c.gpus > 0)) return undefined;
  const basis = {} as Record<FlopsPrecision, PeakFlopsEvidence>;
  for (const p of MFU_PRECISIONS) {
    const v = c.peakTflops?.[p];
    basis[p] = v && v > 0
      ? { value: v, sourceType: SPEC_TO_EVIDENCE[item.source] ?? 'estimate', citation: `catalog item peakTflops.${p} (item source: ${item.source})` }
      : unpublished(`no ${p.toUpperCase()} peak published for ${c.gpuModel}; engines fall back to gpuFlopsPeak × multiplier`);
  }
  return { basis };
}

/** MFU of an effective TFLOP/s-per-GPU figure against the item's basis at `precision` (undefined if unpublished). */
export function mfuAgainstBasis(item: Pick<CatalogItem, 'compute' | 'meta' | 'source'>, precision: FlopsPrecision, tflopsPerGpu: number): { mfu: number; peakTflops: number; label: string } | undefined {
  const b = mfuBasisFor(item)?.basis[precision];
  if (!b?.value) return undefined;
  return { mfu: tflopsPerGpu / b.value, peakTflops: b.value, label: MFU_BASIS[precision].label };
}

/** Map a free-text precision ("NVFP4 (…)", "MXFP8", "BF16") to a basis precision. */
export function precisionOf(text: string): FlopsPrecision | undefined {
  if (/fp4/i.test(text)) return 'fp4';
  if (/fp8/i.test(text)) return 'fp8';
  if (/bf16|fp16/i.test(text)) return 'bf16';
  return undefined;
}
