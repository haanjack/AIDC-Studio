// r4 contract fixture (docs/research/contract-r4.md): a small hand-built HallPrims so streams B0 (annotate / toSvg / sheets) and
// C (2D view renderer, hit grid, LOD) can develop before stream A's buildHallPrims lands. Not a test file (no .test suffix).
//
// Hall 'hall-fx' 20 × 14 m, clear height 4.2 m, tray height 2.9 m. Z-up, hall-local metres.
//   Row A (compute, along x, centre y 4.0, fronts −y) and row B (centre y 6.4, fronts +y) around a 1.2 m hot aisle (y 4.6–5.8).
//   Each row: CDU at x 3.1–3.7 (the CDU pair), racks 0.6 × 1.2 × 2.3 m at x 4.0–5.8 and 7.0–8.8 (mid-row gap 5.8–7.0 after
//   position 03), hot-aisle containment (roof + two end doors), busways A/B with one tap-off per rack per side, three tray tiers
//   T1/T2/T3, supply/return pipe pairs, one drop, a column, a door on the south wall, walls, slab and ceiling.
import { GridIndex, primsHash, type Datum, type Hall, type HallPrims, type Prim, type RowGroup } from '../../src/index.ts';

export const R4_FX_HALL_ID = 'hall-fx';

export const R4_FX_HALL: Hall = {
  id: R4_FX_HALL_ID,
  name: 'Fixture hall',
  origin: { x: 0, y: 0 },
  width: 20,
  depth: 14,
  clearHeight: 4.2,
  raisedFloorHeight: 0,
  ceilingPlenumHeight: 0.8,
  floorLoadingKgPerM2: 2500,
  tileSize: 0.6,
  itPowerBudgetKW: 2000,
  liquidCoolingBudgetKW: 1800,
  airCoolingBudgetKW: 400,
  keepouts: [
    { id: 'col-1', kind: 'column', rect: { x: 12, y: 6, w: 0.5, d: 0.5 }, label: 'C1' },
    { id: 'door-1', kind: 'door', rect: { x: 16, y: 0, w: 1.8, d: 0.3 }, label: 'D1', door: { leaves: 2, swing: 'in', clearHeightM: 2.4 } },
  ],
  trayHeight: 2.9,
};

const RACK = { w: 0.6, d: 1.2, h: 2.3 };
const RACK_X0 = [4.0, 4.6, 5.2, 7.0, 7.6, 8.2]; // min x of positions 01–03 | gap | 04–06
const ROWS = [
  { letter: 'A', center: 4.0, frontSign: -1 as const },
  { letter: 'B', center: 6.4, frontSign: 1 as const },
];
const Z = { pipe: RACK.h + 0.22, busway: Math.min(2.9 - 0.22, RACK.h + 0.4), T1: 2.9, T2: 2.9 + 0.35, T3: 2.9 + 0.7, containment: 2.4, ceiling: 4.2 };

const v = (x: number, y: number, z: number) => ({ x, y, z });

function buildPrims(): { prims: Prim[]; rows: RowGroup[] } {
  const prims: Prim[] = [];
  const rows: RowGroup[] = [];
  const W = R4_FX_HALL.width;
  const D = R4_FX_HALL.depth;
  // shell: slab, ceiling, walls (0.30 m outside the outline), column, door
  prims.push({ id: 'slab:hall-fx', emitter: 'slab', cls: 'EXEMPT', shape: 'box', a: v(0, 0, -0.3), b: v(W, D, 0), halfW: 0, halfH: 0, layer: 'slab', system: 'arch' });
  prims.push({ id: 'ceiling:hall-fx', emitter: 'ceiling', cls: 'EXEMPT', shape: 'plane', a: v(0, 0, Z.ceiling), b: v(W, D, Z.ceiling), halfW: 0, halfH: 0, layer: 'ceiling', system: 'arch' });
  const walls: [string, number, number, number, number][] = [
    ['S', -0.3, -0.3, W + 0.3, 0],
    ['N', -0.3, D, W + 0.3, D + 0.3],
    ['W', -0.3, 0, 0, D],
    ['E', W, 0, W + 0.3, D],
  ];
  for (const [side, x0, y0, x1, y1] of walls) prims.push({ id: `wall:hall-fx#${side}`, emitter: 'wall', cls: 'EXEMPT', shape: 'box', a: v(x0, y0, 0), b: v(x1, y1, Z.ceiling + 0.8), halfW: 0, halfH: 0, layer: 'walls', system: 'arch', tag: side });
  prims.push({ id: 'column:col-1', emitter: 'column', cls: 'IN-floor', shape: 'box', a: v(12, 6, 0), b: v(12.5, 6.5, Z.ceiling + 0.8), halfW: 0, halfH: 0, layer: 'columns', refId: 'col-1', system: 'arch', tag: 'C1' });
  prims.push({ id: 'door:door-1', emitter: 'door', cls: 'PEN', shape: 'box', a: v(16, -0.3, 0), b: v(17.8, 0, 2.4), halfW: 0, halfH: 0, layer: 'doors', refId: 'door-1', system: 'arch', tag: 'D1', meta: { leaves: 2, swing: 'in' } });

  for (const r of ROWS) {
    const rowId = `row-${r.letter}`;
    const y0 = r.center - RACK.d / 2;
    const y1 = r.center + RACK.d / 2;
    const memberIds: string[] = [];
    // CDU (one per row → the CDU pair)
    const cduId = `cdu-${r.letter}`;
    memberIds.push(cduId);
    prims.push({ id: `unit:${cduId}`, emitter: 'unit', cls: 'IN-floor', shape: 'box', a: v(3.1, y0, 0), b: v(3.7, y1, RACK.h), halfW: 0, halfH: 0, layer: 'cdu-crah', refId: cduId, system: 'cdu-supply', podId: 'DU01', rowId, tag: `CDU-${r.letter}`, meta: { category: 'cdu' } });
    RACK_X0.forEach((x, k) => {
      const tag = `DU01-${r.letter}-${String(k + 1).padStart(2, '0')}`;
      const eqId = `eq-${tag.toLowerCase()}`;
      memberIds.push(eqId);
      prims.push({ id: `rack:${tag}`, emitter: 'rack', cls: 'IN-floor', shape: 'box', a: v(x, y0, 0), b: v(x + RACK.w, y1, RACK.h), halfW: 0, halfH: 0, layer: 'racks', refId: eqId, system: 'it', podId: 'DU01', rowId, tag, meta: { category: 'gpu-rack', position: k + 1, frontSign: r.frontSign, rcu: `RCU-${r.letter}${k < 3 ? 1 : 2}` } });
      for (const side of ['A', 'B'] as const) {
        const by = r.center + (side === 'A' ? -0.1 : 0.1);
        prims.push({ id: `tapoff:${tag}#${side}`, emitter: 'tapoff', cls: 'IN-overhead', shape: 'box', a: v(x + 0.15, by - 0.1, Z.busway - 0.35), b: v(x + 0.45, by + 0.1, Z.busway - 0.1), halfW: 0, halfH: 0, layer: 'tapoffs', refId: `bw-${side}-${rowId}`, system: side === 'A' ? 'busway-a' : 'busway-b', podId: 'DU01', rowId, tag: `TO-${tag}-${side}` });
      }
    });
    rows.push({ id: rowId, hallId: R4_FX_HALL_ID, podId: 'DU01', kind: 'compute', axis: 'x', a0: 3.1, a1: 8.8, center: r.center, frontSign: r.frontSign, memberIds });
    // busways A/B along the row
    for (const side of ['A', 'B'] as const) {
      const by = r.center + (side === 'A' ? -0.1 : 0.1);
      prims.push({ id: `busway:bw-${side}-${rowId}`, emitter: 'busway', cls: 'IN-overhead', shape: 'bar', a: v(3.1, by, Z.busway), b: v(8.8, by, Z.busway), halfW: 0.085, halfH: 0.1, layer: side === 'A' ? 'busway-a' : 'busway-b', refId: `bw-${side}-${rowId}`, system: side === 'A' ? 'busway-a' : 'busway-b', podId: 'DU01', rowId, tag: `BW-${side}-${r.letter}/c1` });
    }
    // tray tiers T1 / T2 / T3
    for (const tier of ['T1', 'T2', 'T3'] as const) {
      prims.push({ id: `tray:tray-${rowId}#${tier}`, emitter: 'tray', cls: 'IN-overhead', shape: 'bar', a: v(3.1, r.center, Z[tier]), b: v(8.8, r.center, Z[tier]), halfW: 0.3, halfH: 0.05, layer: tier === 'T1' ? 'tray-t1' : tier === 'T2' ? 'tray-t2' : 'tray-t3', refId: `tray-${rowId}`, system: tier === 'T1' ? 'trays' : tier === 'T2' ? 'frontend' : 'oob', tier, podId: 'DU01', rowId });
    }
    // supply / return pipe pair (outside the busway band)
    for (const [s, dy] of [['S', -0.35], ['R', 0.35]] as const) {
      prims.push({ id: `pipe:DU01-${r.letter}#${s}`, emitter: 'pipe', cls: 'IN-overhead', shape: 'tube', a: v(3.4, r.center + dy, Z.pipe), b: v(8.8, r.center + dy, Z.pipe), halfW: 0.08, halfH: 0.08, layer: 'pipes', system: s === 'S' ? 'cdu-supply' : 'cdu-return', podId: 'DU01', rowId, tag: s === 'S' ? 'TCS-S' : 'TCS-R', meta: { dnMM: 150, source: 'estimate' } });
    }
  }
  // one cable drop from T1 into rack A01
  prims.push({ id: 'drop:tray-row-A#T1@DU01-A-01', emitter: 'drop', cls: 'IN-overhead', shape: 'bar', a: v(4.3, 4.0, RACK.h), b: v(4.3, 4.0, Z.T1), halfW: 0.15, halfH: 0.05, layer: 'drops', refId: 'tray-row-A', system: 'trays', tier: 'T1', podId: 'DU01', rowId: 'row-A' });
  // hot-aisle containment between the rows: roof, end doors
  const ay0 = 4.6;
  const ay1 = 5.8;
  prims.push({ id: 'containment-roof:hac-du01', emitter: 'containment-roof', cls: 'IN-overhead', shape: 'plane', a: v(3.1, ay0, Z.containment), b: v(8.8, ay1, Z.containment), halfW: 0, halfH: 0, layer: 'containment-roof', refId: 'hac-du01', system: 'arch', podId: 'DU01' });
  for (const [end, x] of [[0, 3.1], [1, 8.8]] as const) {
    prims.push({ id: `containment-panel:hac-du01#end${end}`, emitter: 'containment-panel', cls: 'IN-floor', shape: 'box', a: v(x - 0.025, ay0, 2.1), b: v(x + 0.025, ay1, Z.containment), halfW: 0, halfH: 0, layer: 'containment', refId: 'hac-du01', system: 'arch', podId: 'DU01' });
    prims.push({ id: `door:hac-du01#end${end}`, emitter: 'door', cls: 'IN-floor', shape: 'box', a: v(x - 0.025, ay0, 0), b: v(x + 0.025, ay1, 2.1), halfW: 0, halfH: 0, layer: 'containment-doors', refId: 'hac-du01', system: 'arch', podId: 'DU01', meta: { doorType: 'sliding', end } });
  }
  return { prims, rows };
}

export const R4_FX_DATUMS: readonly Datum[] = [
  { id: 'ffl', z: 0, label: 'FFL', source: 'existing' },
  { id: 'rack-top', z: RACK.h, label: 'TOP OF RACK', source: 'derived' },
  { id: 'containment', z: Z.containment, label: 'TOP OF CONTAINMENT', source: 'existing' },
  { id: 'pipe', z: Z.pipe, label: 'TCS PIPE', source: 'existing' },
  { id: 'busway', z: Z.busway, label: 'BUSWAY', source: 'existing' },
  { id: 'T1', z: Z.T1, label: 'LADDER T1', source: 'existing' },
  { id: 'T2', z: Z.T2, label: 'LADDER T2', source: 'existing' },
  { id: 'T3', z: Z.T3, label: 'LADDER T3', source: 'estimate' },
  { id: 'ceiling', z: Z.ceiling, label: 'CEILING', source: 'existing' },
];

/** A fresh fixture HallPrims (new objects on every call). */
export function r4FixtureHallPrims(detail: HallPrims['detail'] = 'pod'): HallPrims {
  const { prims, rows } = buildPrims();
  return { hallId: R4_FX_HALL_ID, detail, prims, index: GridIndex.build(prims), datums: R4_FX_DATUMS.map((d) => ({ ...d })), rows, hash: primsHash(prims) };
}
