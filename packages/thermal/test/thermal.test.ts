import { beforeAll, describe, expect, it } from 'vitest';
import { createNvidiaReferenceProject, getCatalogItem } from '../../core/src/index.ts';
import {
  buildThermalCase,
  handleThermalWorkerMessage,
  runThermal,
  zoneStats,
  type ThermalResult,
  type ThermalWorkerResponse,
} from '../src/index.ts';

const { project, pods } = createNvidiaReferenceProject();

describe('thermal case builder', () => {
  it('rasterizes GB300 racks, CRAH returns and the ducted HAC into one connected air volume', () => {
    const c = buildThermalCase(project, { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1 });
    const rack = c.racks.find((r) => r.tag === 'DU01-A-01');
    expect(rack).toBeDefined();
    // 0.6 m × 2.3 m face at 0.3 m cells → 2 × 8 faces
    expect(rack!.inlet.faces.length).toBe(16);
    expect(rack!.exhaust.faces.length).toBe(16);
    // row A faces −Y (rotation 180): inlet outward normal −Y, exhaust into the hot aisle +Y
    expect(rack!.inlet.axis).toBe(1);
    expect(rack!.inlet.sign).toBe(-1);
    expect(rack!.exhaust.sign).toBe(1);
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    expect(rack!.airKW).toBeCloseTo(gb300.power!.nameplateKW * (1 - gb300.cooling!.liquidFraction), 6);
    expect(c.coolers.length).toBeGreaterThan(0);
    expect(c.coolers.every((q) => !q.virtual && q.sinkCells.length > 0)).toBe(true);
    expect(c.ceilingK).toBeGreaterThan(0);
    expect(c.componentCount).toBe(1);
    expect(c.warnings).toEqual([]);
  });

  it('uses virtual boundary cooling when the region contains no CRAH', () => {
    const c = buildThermalCase(project, { hallId: 'hall-a', cellSize: 0.4, loadFactor: 1, region: { x: 4.5, y: 1, w: 13, d: 8 } });
    expect(c.coolers.some((q) => q.virtual)).toBe(true);
    expect(c.racks.length).toBeGreaterThan(0);
  });

  it('models direct room-top CRAH returns without a ceiling plenum', () => {
    const c = buildThermalCase(project, { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1, includePlenum: false, coolerReturn: 'top' });
    const realCoolers = c.coolers.filter((q) => !q.virtual);
    expect(c.ceilingK).toBe(-1);
    expect(realCoolers.length).toBeGreaterThan(0);
    expect(realCoolers.every((q) => q.sinkCells.length === 0 && (q.returnFaces?.faces.length ?? 0) > 0)).toBe(true);
    expect(c.warnings.some((w) => w.includes('without a ceiling plenum'))).toBe(true);
  });
});

describe('reference hall at 0.3 m (GB300 NVL72, HAC ducted to plenum)', () => {
  let designed: ThermalResult;
  let open: ThermalResult;

  beforeAll(async () => {
    designed = await runThermal(project, { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1 });
    open = await runThermal(project, { hallId: 'hall-a', cellSize: 0.3, loadFactor: 1, maxSteps: 400, overrides: { containment: 'none' } });
  }, 600_000);

  it('converges within maxSteps with a closed energy balance', () => {
    expect(designed.metrics.converged).toBe(true);
    expect(designed.metrics.step).toBeLessThanOrEqual(600);
    expect(Math.abs(designed.metrics.balanceError)).toBeLessThan(0.1);
    expect(designed.metrics.airHeatKW).toBeGreaterThan(2000);
  });

  it('keeps every IT intake within ASHRAE A1 allowable (≤ 32 °C) with hot-aisle containment', () => {
    expect(designed.metrics.maxInletC).toBeLessThanOrEqual(32);
    expect(designed.metrics.rciHi).toBeGreaterThan(85);
  });

  it('degrades inlet conditions when containment is removed', () => {
    expect(open.metrics.maxInletC).toBeGreaterThan(designed.metrics.maxInletC);
    expect(open.metrics.rciHi).toBeLessThan(designed.metrics.rciHi);
    expect(open.metrics.shi).toBeGreaterThan(designed.metrics.shi);
  });

  it('produces finite fields with a hot contained aisle, warm plenum and cool supply aisle', () => {
    for (const r of [designed, open]) {
      expect(r.temperature.every((t) => Number.isFinite(t))).toBe(true);
      expect(r.velocity.every((v) => Number.isFinite(v))).toBe(true);
    }
    const hall = project.halls[0];
    const du01 = pods.find((p) => p.id === 'pod-01')!;
    const hac = project.containments.find((c) => c.podId === 'pod-01')!;
    const hot = zoneStats(designed, { x0: hac.rect.x + 1.5, x1: hac.rect.x + hac.rect.w - 1.5, y0: hac.rect.y, y1: hac.rect.y + hac.rect.d, z0: 0.3, z1: 2.2 });
    const plenum = zoneStats(designed, { x0: 0, x1: hall.width, y0: 0, y1: hall.depth, z0: hall.clearHeight, z1: hall.clearHeight + hall.ceilingPlenumHeight });
    const cold = zoneStats(designed, { x0: du01.rect.x + 1.5, x1: du01.rect.x + du01.rect.w - 1.5, y0: du01.rect.y - 1.2, y1: du01.rect.y, z0: 0.3, z1: 2.0 });
    expect(hot.avgC).toBeGreaterThan(cold.avgC + 8);
    expect(plenum.avgC).toBeGreaterThan(cold.avgC + 5);
    expect(cold.avgC).toBeLessThan(27);
  });
});

describe('web worker protocol', () => {
  const region = { x: 4.5, y: 1, w: 13, d: 8 };

  it('streams progress and snapshots, then completes', async () => {
    const messages: ThermalWorkerResponse[] = [];
    const done = new Promise<ThermalWorkerResponse>((resolve) => {
      handleThermalWorkerMessage(
        { type: 'run', jobId: 'job-1', project, options: { hallId: 'hall-a', cellSize: 0.4, loadFactor: 0.8, maxSteps: 120, region }, snapshotEvery: 10 },
        (msg) => {
          messages.push(msg);
          if (msg.type !== 'progress') resolve(msg);
        },
      );
    });
    const final = await done;
    expect(final.type).toBe('done');
    if (final.type === 'done') {
      expect(final.result.temperature.length).toBe(final.result.grid.nx * final.result.grid.ny * final.result.grid.nz);
      expect(final.result.metrics.removedKW).toBeGreaterThan(0);
      expect(final.result.temperature.every((t) => Number.isFinite(t))).toBe(true);
    }
    expect(messages.some((m) => m.type === 'progress')).toBe(true);
  }, 120_000);

  it('honors cancel between chunks', async () => {
    const final = await new Promise<ThermalWorkerResponse>((resolve) => {
      let cancelled = false;
      handleThermalWorkerMessage(
        { type: 'run', jobId: 'job-2', project, options: { hallId: 'hall-a', cellSize: 0.4, loadFactor: 1, maxSteps: 100_000, tolerance: 0, region } },
        (msg) => {
          if (msg.type === 'progress' && !cancelled) {
            cancelled = true;
            handleThermalWorkerMessage({ type: 'cancel', jobId: 'job-2' }, () => {});
          }
          if (msg.type !== 'progress') resolve(msg);
        },
      );
    });
    expect(final.type).toBe('error');
    if (final.type === 'error') expect(final.message).toBe('cancelled');
  }, 60_000);
});
