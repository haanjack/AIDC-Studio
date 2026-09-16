import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calibrateEta, ETA_HOST_SOURCE, ETA_SOURCES, etaFromMeasurement, etaSourceFor, nominalBusbwGBps, parseCollectiveLog, type CollectiveMeasurement } from '../src/index.ts';

const SAMPLE_FILE = readFileSync(new URL('./fixtures/collective-logs.synthetic.txt', import.meta.url), 'utf8');

interface Sample {
  id: string;
  body: string;
  expect: { nrows: number; max_size: number; oop_busbw_at_max: number; top3_sizes: number[]; top3_oop_mean: number; top3_oop_min: number; footer_avg: number | null; max_rank_plus1: number | null; hosts_listed: number };
}

/** Split the companion file into its verbatim samples and their `@@expect` lines. */
function samples(): Sample[] {
  return SAMPLE_FILE.split('=====BEGIN SAMPLE').slice(1).map((chunk) => {
    const id = /id=(\S+)/.exec(chunk)![1];
    const exp = /@@expect:\s*(.+)/.exec(chunk)![1];
    const obj: Record<string, unknown> = {};
    for (const part of exp.split(/;\s*/)) {
      const [k, v] = part.split('=');
      obj[k.trim()] = v.trim() === 'None' ? null : JSON.parse(v.trim());
    }
    const body = chunk.split('-----8<-----')[1].split('=====END SAMPLE=====')[0];
    return { id, body, expect: obj as Sample['expect'] };
  });
}

describe('eta.ts — sourced defaults (r2-eta.md §3, DECISIONS-v2-2 §C)', () => {
  it('every default carries value, source type, citation and conditions; classes match the research table', () => {
    for (const s of ETA_SOURCES) {
      expect(s.citation.length, s.id).toBeGreaterThan(20);
      expect(s.conditions.length, s.id).toBeGreaterThan(10);
      expect(s.value).toBeGreaterThan(0);
      expect(s.value).toBeLessThanOrEqual(1);
    }
    expect(etaSourceFor('ecmp')).toMatchObject({ value: 0.6, sourceType: 'vendor-claim' }); // fix v2 2차 (QA M5): NVIDIA's 60 %, HPN corroborates
    expect(etaSourceFor('qp-scaling')).toMatchObject({ value: 0.7, sourceType: 'derived' }); // fix v2 2차 (QA M5): flow-level simulation
    expect(etaSourceFor('te')).toMatchObject({ value: 0.8, sourceType: 'measured-paper' });
    expect(etaSourceFor('adaptive', 'spectrumx-800')).toMatchObject({ id: 'adaptive-spectrumx', value: 0.95, sourceType: 'vendor-claim' });
    expect(etaSourceFor('adaptive', 'ib-xdr-800')).toMatchObject({ id: 'adaptive-ib-proxy', value: 0.95, sourceType: 'vendor-claim' });
    expect(etaSourceFor('ddc')).toMatchObject({ value: 1, sourceType: 'nominal' });
    expect(ETA_HOST_SOURCE.value).toBe(0.95);
  });

  it('nominal busbw: ring r·L/8; alltoall (r/g)·(L/8)·(n−1)/(n−g) (r2-eta.md §1.1 worked examples)', () => {
    expect(nominalBusbwGBps({ collective: 'all_reduce', nicGbps: 400, nicsPerNode: 8 })).toBe(400);
    expect(nominalBusbwGBps({ collective: 'alltoall', nicGbps: 400, nicsPerNode: 8, ranksPerNode: 8, ranks: 64 })).toBeCloseTo(56.25, 9);
    expect(nominalBusbwGBps({ collective: 'alltoall', nicGbps: 400, nicsPerNode: 8, ranksPerNode: 8, ranks: 128 })).toBeCloseTo(52.9167, 3);
    expect(nominalBusbwGBps({ collective: 'alltoall', nicGbps: 400, nicsPerNode: 8, ranksPerNode: 8, ranks: 72 })).toBeCloseTo(55.47, 2); // AMD–DriveNets RA
  });
});

describe('eta.ts — parseCollectiveLog against test/fixtures/collective-logs.synthetic.txt (synthetic logs)', () => {
  for (const s of samples()) {
    it(`${s.id}: rows, largest size, plateau busbw, footer, ranks`, () => {
      const ms = parseCollectiveLog(s.body);
      expect(ms).toHaveLength(1);
      const m = ms[0];
      const oop = m.rows.filter((r) => !r.inPlace);
      expect(oop).toHaveLength(s.expect.nrows);
      const last = oop[oop.length - 1];
      expect(last.sizeB).toBe(s.expect.max_size);
      expect(last.busbwGBps).toBe(s.expect.oop_busbw_at_max);
      const cal = etaFromMeasurement(m, 100);
      expect(cal.sizesB).toEqual(s.expect.top3_sizes);
      expect(cal.busbwLargeGBps!).toBeCloseTo(s.expect.top3_oop_mean, 2);
      expect(cal.busbwMinGBps!).toBeCloseTo(s.expect.top3_oop_min, 6);
      if (s.expect.footer_avg == null) expect(m.avgBusbwGBps).toBeUndefined();
      else expect(m.avgBusbwGBps).toBe(s.expect.footer_avg);
      if (s.expect.max_rank_plus1 == null) expect(m.ranks).toBeUndefined();
      else expect(m.ranks).toBe(s.expect.max_rank_plus1);
    });
  }

  it('tool, collective, ranks per node and nodes; in-place rows are kept separately', () => {
    const [s1, s2, s3, , s5] = samples();
    const m1 = parseCollectiveLog(s1.body)[0];
    expect(m1).toMatchObject({ tool: 'nccl-tests', collective: 'all_reduce', ranks: 16, ranksPerNode: 8, nodes: 2 });
    expect(m1.rows.filter((r) => r.inPlace)).toHaveLength(32);
    expect(parseCollectiveLog(s2.body)[0]).toMatchObject({ collective: 'alltoall', ranks: 4, nodes: 1 });
    // truncated rank list ('......'): nodes from the device index, list flagged
    expect(parseCollectiveLog(s3.body)[0]).toMatchObject({ ranks: 64, ranksPerNode: 8, nodes: 8, rankListTruncated: true });
    expect(parseCollectiveLog(s5.body)[0].tool).toBe('rccl-tests');
  });

  it('several runs in one paste return one measurement each', () => {
    const all = parseCollectiveLog(SAMPLE_FILE);
    expect(all.map((m) => m.rows.filter((r) => !r.inPlace).length)).toEqual([32, 25, 12, 12, 17, 17]);
  });

  it('garbage in → nothing out', () => {
    expect(parseCollectiveLog('# nccl-tests')).toEqual([]);
    expect(parseCollectiveLog('')).toEqual([]);
  });
});

describe('eta.ts — η from measurements (r2-eta.md §4.7 worked examples)', () => {
  const [s1, , s3, s4] = samples();

  it('nccl #1531 8-node RoCE alltoall: η_total = 52.09 / 56.25 = 0.926, no flags', () => {
    const m = parseCollectiveLog(s3.body)[0];
    const nominal = nominalBusbwGBps({ collective: 'alltoall', nicGbps: 400, nicsPerNode: 8, ranksPerNode: m.ranksPerNode, ranks: m.ranks });
    const cal = etaFromMeasurement(m, nominal);
    expect(cal.eta).toBeCloseTo(0.926, 3);
    expect(cal.flags).toEqual([]);
    expect(cal.basis).toMatch(/4 GiB, 8 GiB, 16 GiB/);
  });

  it('16-node run is flagged unstable (dip at 1–2 GiB); the 2-node IB run is rejected as not network-bound (1.17)', () => {
    const m4 = parseCollectiveLog(s4.body)[0];
    const c4 = etaFromMeasurement(m4, nominalBusbwGBps({ collective: 'alltoall', nicGbps: 400, nicsPerNode: 8, ranksPerNode: 8, ranks: 128 }));
    expect(c4.eta).toBeCloseTo(0.904, 3);
    expect(c4.flags).toContain('unstable');
    const c1 = etaFromMeasurement(parseCollectiveLog(s1.body)[0], 400);
    expect(c1.eta).toBeCloseTo(1.17, 2);
    expect(c1.flags).toContain('not-network-bound');
    expect(c1.basis).toMatch(/footer average 139.56 GB\/s ignored/);
  });

  it('below-plateau and not-plateaued flags; empty measurement', () => {
    const m: CollectiveMeasurement = { tool: 'nccl-tests', collective: 'all_reduce', rows: [{ sizeB: 2 ** 28, algbwGBps: 1, busbwGBps: 300 }, { sizeB: 2 ** 30, algbwGBps: 1, busbwGBps: 380 }] };
    const c = etaFromMeasurement(m, 400);
    expect(c.flags).toContain('below-plateau');
    expect(c.eta).toBeCloseTo(0.95, 9);
    const noisy: CollectiveMeasurement = { ...m, rows: [30, 31, 32].map((e, i) => ({ sizeB: 2 ** e, algbwGBps: 1, busbwGBps: [300, 380, 390][i] })) };
    expect(etaFromMeasurement(noisy, 400).flags).toContain('not-plateaued');
    expect(etaFromMeasurement({ ...m, rows: [] }, 400)).toMatchObject({ eta: 0, flags: ['no-rows'] });
  });

  it('calibrateEta: spread ÷ packed gives η_fabric and η_host; without a packed log η_host defaults to 0.95', () => {
    const rows = (bus: number) => [30, 31, 32, 33].map((e) => ({ sizeB: 2 ** e, algbwGBps: bus / 2, busbwGBps: bus }));
    const packed: CollectiveMeasurement = { tool: 'rccl-tests', collective: 'all_reduce', rows: rows(383.27) }; // AMD–DriveNets RA single SU
    const spread: CollectiveMeasurement = { tool: 'rccl-tests', collective: 'all_reduce', rows: rows(300) };
    const both = calibrateEta({ spread, packed, nominalGBps: 400, measuredAt: '2026-09-15' });
    expect(both.etaHost).toBeCloseTo(0.958, 3);
    expect(both.etaFabric).toBeCloseTo(300 / 383.27, 9);
    expect(both.eta).toBe(both.etaFabric);
    expect(both.source).toBe('user-measured');
    const alone = calibrateEta({ spread, nominalGBps: 400 });
    expect(alone.etaHost).toBe(0.95);
    expect(alone.etaFabric).toBeCloseTo(0.75 / 0.95, 9);
    // faster than the packed run → capped at 1
    expect(calibrateEta({ spread: packed, packed: spread, nominalGBps: 400 }).etaFabric).toBe(1);
  });
});
