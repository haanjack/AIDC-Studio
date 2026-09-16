import { beforeAll, describe, expect, it } from 'vitest';
import { createNvidiaReferenceProject, fanWallSeed, SEED_INROW_CRV050 } from '../../core/src/index.ts';
import { buildThermalCase, buildThermalVariant, runThermal, type ThermalOptions, type ThermalResult } from '../src/index.ts';

// Cooling-topology boundary conditions (T4, r2-platform.md §2.3) on the reference hall cropped to DU01 plus the two
// wall CRAHs next to it (0.4 m cells: ~2–4 s per run).
const { project } = createNvidiaReferenceProject();
const region = { x: 0, y: 0, w: 21.6, d: 9.6 };
const base: ThermalOptions = { hallId: 'hall-a', cellSize: 0.4, loadFactor: 1, maxSteps: 700, region };
const idOf = (tag: string) => project.equipment.find((e) => e.tag === tag)!.id;

describe('RDHx: heat removal at the rack exhaust face', () => {
  let none: ThermalResult;
  let full: ThermalResult;
  let partial: ThermalResult;
  beforeAll(async () => {
    none = await runThermal(project, base);
    full = await runThermal(project, { ...base, rdhx: { doorKW: 75 } });
    partial = await runThermal(project, { ...base, rdhx: { fraction: 0.5 } });
  }, 300_000);

  it('baseline crop converges with a closed energy balance and reports the hot-aisle mean', () => {
    expect(none.metrics.converged).toBe(true);
    expect(Math.abs(none.metrics.balanceError)).toBeLessThan(0.02);
    expect(none.metrics.doorRemovedKW).toBe(0);
    expect(none.metrics.hotAisleAvgC).toBeGreaterThan(none.metrics.avgInletC + 8);
  });

  it('lowers the hot-aisle temperature versus no doors', () => {
    expect(full.metrics.hotAisleAvgC!).toBeLessThan(none.metrics.hotAisleAvgC! - 5);
    expect(partial.metrics.hotAisleAvgC!).toBeLessThan(none.metrics.hotAisleAvgC! - 2);
    expect(partial.metrics.hotAisleAvgC!).toBeGreaterThan(full.metrics.hotAisleAvgC!);
  });

  it('keeps the energy balance: IT air heat = door removal + cooler removal (< 2 %)', () => {
    for (const r of [full, partial]) {
      expect(r.metrics.converged).toBe(true);
      const it = r.metrics.airHeatKW + r.metrics.doorRemovedKW!;
      expect(Math.abs(it - (r.metrics.removedKW + r.metrics.doorRemovedKW!)) / it).toBeLessThan(0.02);
      // doors never create heat: total heat equals the no-door case
      expect(Math.abs(it - none.metrics.airHeatKW) / none.metrics.airHeatKW).toBeLessThan(0.02);
    }
    // a fraction door removes at most half of the rack air heat — less when the exhaust approaches the 30 °C door water (fix v2 2차)
    const racks = partial.metrics.racks.filter((x) => x.airflowM3s > 0);
    for (const x of racks) {
      expect(x.doorKW ?? 0).toBeLessThanOrEqual(x.airKW * 0.5 + 1e-6);
      expect(x.exhaustC).toBeGreaterThanOrEqual(30 + 1 - 1e-6 - (x.doorKW ? 0 : 100));
    }
    expect(Math.abs(partial.metrics.balanceError)).toBeLessThan(0.02);
    // air-side balance also closes for rated (doorKW) doors, and the hot aisle never drops below the door water temperature
    expect(Math.abs(full.metrics.balanceError)).toBeLessThan(0.02);
    expect(full.metrics.hotAisleAvgC!).toBeGreaterThanOrEqual(30 - 0.5); // cell average incl. the aisle ends (per-rack exhaust ≥ 31 °C above)
  });
});

describe('in-row coolers: return from the hot aisle, supply into the cold aisle', () => {
  let result: ThermalResult;
  const variant = buildThermalVariant(project, base, 'in-row');
  beforeAll(async () => {
    result = await runThermal(variant.project, variant.options);
  }, 300_000);

  it('builds horizontal supply / return faces on opposite sides of each cabinet and drops the room CRAHs', () => {
    expect(variant.available).toBe(true);
    const c = buildThermalCase(variant.project, variant.options);
    const inRow = c.coolers.filter((q) => q.kind === 'in-row');
    expect(inRow.length).toBeGreaterThan(0);
    expect(c.coolers.every((q) => q.kind === 'in-row')).toBe(true);
    for (const q of inRow) {
      expect(q.supply.faces.length).toBeGreaterThan(0);
      expect(q.returnFaces!.faces.length).toBeGreaterThan(0);
      expect(q.supply.axis).toBe(q.returnFaces!.axis);
      expect(q.supply.axis).not.toBe(2);
      expect(q.supply.sign).toBe(-q.returnFaces!.sign as 1 | -1);
      expect(q.sinkCells.length).toBe(0);
    }
    expect(c.warnings).toEqual([]);
  });

  it('removes the rack heat with a closed energy balance (< 2 %) and keeps intakes cool', () => {
    const m = result.metrics;
    expect(m.converged).toBe(true);
    expect(Math.abs(m.balanceError)).toBeLessThan(0.02);
    expect(m.coolers.every((q) => q.kind === 'in-row' && q.loadKW <= SEED_INROW_CRV050.unitKW + 1e-6)).toBe(true);
    // fix v2 2차 (QA): units now sit inside the rows (sized per cold aisle), so the mid-row GPU racks no longer starve; the network racks
    // next to a replaced position may exceed the 27 °C recommended limit but stay within the ASHRAE A1 allowable 32 °C
    const it = m.racks.filter((r) => r.airflowM3s > 0 && !/NET/.test(r.tag));
    expect(Math.max(...it.map((r) => r.inletMaxC))).toBeLessThanOrEqual(27);
    expect(m.maxInletC).toBeLessThanOrEqual(32);
  });

  it('the in-row return air is hot-aisle air (return well above supply)', () => {
    for (const q of result.metrics.coolers) expect(q.returnC).toBeGreaterThan(q.supplyC + 8);
  });
});

describe('liquid-to-air sidecars: rack liquid heat rejected to room air', () => {
  const lf = 0.6;
  const b6: ThermalOptions = { ...base, loadFactor: lf };
  let none: ThermalResult;
  let side: ThermalResult;
  const coLocated = [idOf('DU01-A-01'), idOf('DU01-A-02')];
  const cabinetRack = idOf('DU01-B-12');
  const sc = {
    rackIds: [...coLocated, cabinetRack],
    airflowPerKW: 10_100 / 3600 / 70,
    fanKWPerKW: 0.035,
    units: [{ id: 'sc-1', tag: 'SC-1', rect: { x: 16.45, y: 7.1152, w: 0.6, d: 1.175 }, rotationDeg: 0 as const, rackIds: [cabinetRack] }],
  };
  beforeAll(async () => {
    none = await runThermal(project, b6);
    // the cabinet exhausts into the open end-door zone: converge tighter than the default 0.01 °C/step drift
    side = await runThermal(project, { ...b6, sidecars: sc, tolerance: 0.003, maxSteps: 1500 });
  }, 300_000);

  it('adds liquid heat + fan power at the rack exhaust (co-located) and at an explicit cabinet', () => {
    const c0 = buildThermalCase(project, b6);
    const c1 = buildThermalCase(project, { ...b6, sidecars: sc });
    const gb = c1.racks.find((r) => r.id === coLocated[0])!;
    const gb0 = c0.racks.find((r) => r.id === coLocated[0])!;
    expect(gb.extraAirflowM3s).toBeGreaterThan(0);
    const cab = c1.racks.find((r) => r.id === 'sc-1')!;
    expect(cab.aux).toBe(true);
    expect(c1.racks.find((r) => r.id === cabinetRack)!.airKW).toBeCloseTo(c0.racks.find((r) => r.id === cabinetRack)!.airKW, 9);
    const liquidPerRack = (gb.airKW - gb0.airKW) / 1.035;
    expect(cab.airKW).toBeCloseTo(liquidPerRack * 1.035, 6);
    const added = c1.racks.reduce((s, r) => s + r.airKW, 0) - c0.racks.reduce((s, r) => s + r.airKW, 0);
    expect(added).toBeCloseTo(3 * liquidPerRack * 1.035, 6);
    expect(c1.warnings).toEqual([]);
  });

  it('room air heat grows by the relocated heat and the balance stays closed (< 2 %)', () => {
    expect(side.metrics.converged).toBe(true);
    expect(Math.abs(side.metrics.balanceError)).toBeLessThan(0.02);
    const c0 = buildThermalCase(project, b6);
    const c1 = buildThermalCase(project, { ...b6, sidecars: sc });
    const expected = c1.racks.reduce((s, r) => s + r.airKW, 0) - c0.racks.reduce((s, r) => s + r.airKW, 0);
    expect(Math.abs(side.metrics.airHeatKW - none.metrics.airHeatKW - expected) / expected).toBeLessThan(0.05);
    expect(side.metrics.removedKW).toBeGreaterThan(none.metrics.removedKW);
  });
});

describe('topology variants', () => {
  it('current option is as designed; RDHx and sidecar variants set the new options; unimplemented strategies are flagged', () => {
    expect(buildThermalVariant(project, base, 'perimeter-crah')).toMatchObject({ available: true, project, options: base });
    expect(buildThermalVariant(project, base, 'rdhx').options.rdhx).toEqual({ doorKW: 75 });
    const side = buildThermalVariant(project, base, 'sidecar-l2a');
    expect(side.options.sidecars?.airflowPerKW).toBeGreaterThan(0);
    expect(side.project.equipment.some((e) => e.hallId === 'hall-a' && e.tag.includes('CDU'))).toBe(false);
    // polish v2 2차: no room-unit scaling — the room system is the row's fan-wall units placed as real units
    expect(side.options.roomCoolerScale).toBeUndefined();
    // stream C (P3): the fan-wall class unit is the neutral generic class (core fanWallSeed), no vendor instance id
    const sideRoom = side.project.equipment.filter((e) => e.hallId === 'hall-a' && e.catalogId === fanWallSeed().id);
    expect(sideRoom.length).toBeGreaterThan(10);
    expect(side.project.equipment.some((e) => e.hallId === 'hall-a' && e.catalogId === project.cooling.crahCatalogId)).toBe(false);
    // gallery variant: real fan-wall units (the comparison row's catalog item and count), no CRAH model
    const gallery = buildThermalVariant(project, base, 'gallery-fan-wall');
    expect(gallery.available).toBe(true);
    const fw = gallery.project.equipment.filter((e) => e.hallId === 'hall-a' && e.catalogId === fanWallSeed().id);
    expect(fw.length).toBe(gallery.notes[0].params!.units);
    expect(fw.length).toBeGreaterThan(0);
    expect(gallery.project.equipment.some((e) => e.hallId === 'hall-a' && e.catalogId === project.cooling.crahCatalogId)).toBe(false);
  });
});
