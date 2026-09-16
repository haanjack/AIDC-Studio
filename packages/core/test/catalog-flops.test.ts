import { describe, expect, it } from 'vitest';
import {
  ACCELERATOR_FLOPS, BENCHMARKS, CATALOG, MFU_PRECISIONS, acceleratorFlopsKey, findNodeSpec, getCatalogItem, mfuAgainstBasis, mfuBasisFor, peakFlopsFor, precisionOf,
  type CatalogItem,
} from '../src/index.ts';

const SOURCE_TYPES = ['measured-paper', 'vendor-claim', 'acceptance-threshold', 'standard', 'official-config', 'derived', 'estimate', 'unpublished'];

describe('MFU basis per precision (T5, DECISIONS-v2-2 §C)', () => {
  const gpuRacks = CATALOG.filter((c) => c.category === 'gpu-rack');

  it('every gpu-rack has a bf16 / fp8 / fp4 basis entry with a source type', () => {
    expect(gpuRacks.length).toBeGreaterThanOrEqual(19);
    for (const r of gpuRacks) {
      const b = mfuBasisFor(r);
      expect(b, r.id).toBeDefined();
      for (const p of MFU_PRECISIONS) {
        const e = b!.basis[p];
        expect(e, `${r.id} ${p}`).toBeDefined();
        expect(SOURCE_TYPES, `${r.id} ${p}`).toContain(e.sourceType);
        expect(e.citation.length, `${r.id} ${p}`).toBeGreaterThan(10);
        if (e.sourceType === 'unpublished') expect(e.value, `${r.id} ${p}`).toBeUndefined();
        else expect(e.value, `${r.id} ${p}`).toBeGreaterThan(0);
      }
    }
  });

  it('Blackwell / Rubin / AMD racks carry exactly the family table values, monotone bf16 ≤ fp8 ≤ fp4', () => {
    const keyed = gpuRacks.filter((r) => acceleratorFlopsKey(r));
    expect(keyed.map((r) => r.id)).toEqual(expect.arrayContaining([
      'nvidia-gb300-nvl72', 'nvidia-gb200-nvl72', 'nvidia-vr-nvl72', 'hgx-b200-air-4x', 'hgx-b300-air-4x', 'hgx-h100-air-4x', 'amd-helios-mi455x', 'amd-mi355x-dlc-4x', 'amd-mi300x-air-4x',
    ]));
    for (const r of keyed) {
      const fam = ACCELERATOR_FLOPS[acceleratorFlopsKey(r)!];
      for (const p of MFU_PRECISIONS) expect(r.compute!.peakTflops?.[p], `${r.id} ${p}`).toBe(fam.peakTflops[p]);
      const t = fam.peakTflops;
      if (t.bf16 && t.fp8) expect(t.bf16).toBeLessThanOrEqual(t.fp8);
      if (t.fp8 && t.fp4) expect(t.fp8).toBeLessThanOrEqual(t.fp4);
    }
    expect(acceleratorFlopsKey(getCatalogItem('nvidia-gb300-nvl72'))).toBe('b300');
    expect(acceleratorFlopsKey(getCatalogItem('nvidia-gb200-nvl72'))).toBe('b200');
    expect(acceleratorFlopsKey({ compute: { gpus: 8, gpuModel: findNodeSpec('hgx-b300-node')!.gpu!.model } as CatalogItem['compute'] })).toBe('b300');
  });

  it('GB300 NVL72 has an FP4 entry and GB200 NVL72 has peakTflops', () => {
    expect(getCatalogItem('nvidia-gb300-nvl72').compute!.peakTflops!.fp4).toBe(13500);
    expect(getCatalogItem('nvidia-gb200-nvl72').compute!.peakTflops).toEqual({ bf16: 2500, fp8: 5000, fp4: 10000 });
    expect(findNodeSpec('hgx-b300-node')!.gpu!.peakTflops!.fp4).toBe(getCatalogItem('nvidia-gb300-nvl72').compute!.peakTflops!.fp4);
  });

  it('no published benchmark shows MFU > 100 % against the catalog basis (engine peakFlopsFor agrees)', () => {
    let checked = 0;
    for (const b of BENCHMARKS) {
      const tf = b.derived?.tflopsPerGpu;
      const p = precisionOf(b.precision ?? '');
      if (!tf || !p) continue;
      const key = acceleratorFlopsKey({ compute: { gpus: 1, gpuModel: b.accelerator } as CatalogItem['compute'] });
      if (!key) continue;
      const rack = CATALOG.find((c) => c.category === 'gpu-rack' && acceleratorFlopsKey(c) === key)!;
      const m = mfuAgainstBasis(rack, p, tf);
      expect(m, b.id).toBeDefined();
      expect(m!.mfu, b.id).toBeGreaterThan(0);
      expect(m!.mfu, b.id).toBeLessThan(1);
      expect(peakFlopsFor(rack.compute!, p), b.id).toBeCloseTo(m!.peakTflops * 1e12, -6);
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(6);
    // r2-models.md example: MLPerf v6.0 GB300 405B NVFP4 3,849.9 TFLOP/s per GPU was 105 % against the old fallback
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    expect(3849.9e12 / peakFlopsFor(gb300.compute!, 'fp4')).toBeCloseTo(0.285, 3);
  });
});
