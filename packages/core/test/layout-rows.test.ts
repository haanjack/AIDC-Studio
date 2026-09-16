import { describe, expect, it } from 'vitest';
import { blockingKeepouts, cableLengthM, buildContext, clipPolyline, createNvidiaReferenceProject, detectRowGroups, generateBusways, generateTrays, polylineInside, type Rect, type Vec3 } from '../src/index.ts';

/** Row groups, tray / busway builders and the polyline clipper (PROPOSAL-v2 §1.3, stream S1). */

const P = (x: number, y: number, z = 2.9): Vec3 => ({ x, y, z });
const rect: Rect = { x: 0, y: 0, w: 20, d: 30 };

describe('clipPolyline', () => {
  it('keeps a polyline inside the rectangle unchanged', () => {
    expect(clipPolyline([P(1, 1), P(10, 1), P(10, 5)], rect)).toEqual([[P(1, 1), P(10, 1), P(10, 5)]]);
  });
  it('clips a run that leaves the hall at the wall', () => {
    const out = clipPolyline([P(5, 5), P(35, 5)], rect);
    expect(out).toEqual([[P(5, 5), P(20, 5)]]);
  });
  it('drops a run entirely outside and splits around a blocker', () => {
    expect(clipPolyline([P(25, 5), P(30, 5)], rect)).toEqual([]);
    const parts = clipPolyline([P(0, 10), P(20, 10)], rect, [{ x: 9, y: 9, w: 2, d: 2 }]);
    expect(parts.length).toBe(2);
    expect(parts[0][parts[0].length - 1].x).toBeCloseTo(9, 6);
    expect(parts[1][0].x).toBeCloseTo(11, 6);
  });
  it('keeps vertical rises', () => {
    expect(clipPolyline([P(5, 5, 2.9), P(5, 5, 3.25)], rect)).toEqual([[P(5, 5, 2.9), P(5, 5, 3.25)]]);
  });
  it('blockingKeepouts: only columns and shafts block overhead runs', () => {
    const b = blockingKeepouts([
      { id: 'c', kind: 'column', rect: { x: 1, y: 1, w: 0.6, d: 0.6 } },
      { id: 'd', kind: 'door', rect: { x: 0, y: 5, w: 0.3, d: 2 } },
      { id: 's', kind: 'shaft', rect: { x: 3, y: 3, w: 1, d: 1 } },
    ]);
    expect(b.length).toBe(2);
  });
});

describe('rows, trays and busways of the reference hall', () => {
  const { project } = createNvidiaReferenceProject();
  const hall = project.halls[0];
  const rows = detectRowGroups(project, hall);

  it('detects 8 pod rows + wrapped services / network-core rows with kinds', () => {
    const compute = rows.filter((r) => r.kind === 'compute');
    expect(compute.length).toBe(8);
    expect(rows.some((r) => r.kind === 'network-core')).toBe(true);
    expect(rows.some((r) => r.kind === 'services')).toBe(true);
    for (const r of rows) {
      expect(r.a1).toBeGreaterThan(r.a0);
      expect(r.memberIds.length).toBeGreaterThan(0);
      expect([1, -1]).toContain(r.frontSign);
    }
  });

  it('generateTrays: one row tray per row, a main tray with a vertex per row junction, all inside the hall', () => {
    const trays = generateTrays(project, hall, rows);
    const rowTrays = trays.filter((t) => t.kind === 'row');
    expect(rowTrays.length).toBe(rows.length);
    const main = trays.filter((t) => t.kind === 'main');
    expect(main.length).toBeGreaterThan(0);
    const longest = main.reduce((a, b) => (b.points.length > a.points.length ? b : a));
    expect(longest.points.length).toBeGreaterThan(2);
    expect(trays.every((t) => polylineInside(t.points, hall))).toBe(true);
    // row → main drops, one per row (rack drops are drawn by the viewer); T1b junction drops / lead-ins join main trays to the rows they pass over
    expect(trays.filter((t) => t.kind === 'drop' && t.id.endsWith('-main')).length).toBe(rows.length);
    expect(trays.filter((t) => t.kind === 'drop' && !t.id.endsWith('-main')).every((t) => /-(x|lead)-[xy]\d+$/.test(t.id))).toBe(true);
    // identical to what the generator stored on the project
    expect(project.trays!.map((t) => t.id)).toEqual(trays.map((t) => t.id));
  });

  it('generateBusways: A/B per row with one tap-off per rack, ampacity from the project RPP', () => {
    const bus = generateBusways(project, hall, rows);
    expect(bus.length).toBe(rows.length * 2);
    const a = bus.find((b) => b.path === 'A' && b.id.includes('pod-01-a'))!;
    expect(a.tapoffs.length).toBe(rows.find((r) => r.id === 'pod-01-a')!.memberIds.filter((id) => !id.includes('cdu')).length);
    expect(a.ampacityA).toBeGreaterThan(0);
    expect(bus.every((b) => polylineInside(b.points, hall))).toBe(true);
  });

  it('tray-graph cable lengths stay close to the Manhattan model for same-pod links (no detour along the main tray)', () => {
    const ctx = buildContext(project);
    const find = (tag: string) => ctx.placed.find((p) => p.e.tag === tag)!;
    const a = find('DU02-A-01');
    const b = find('DU02-B-NET1');
    const viaTrays = cableLengthM(project, a, b);
    const manhattan = cableLengthM({ ...project, trays: undefined }, a, b);
    expect(viaTrays).toBeLessThan(manhattan * 1.5 + 5);
  });
});
