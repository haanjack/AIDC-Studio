// CFD-lite variants for the cooling-topology comparison (stream T4, r2-platform.md §2.3).
//
// `buildThermalVariant(project, base, option)` returns the project + solver options that represent one topology
// for the hall in `base.hallId`, without touching the stored project:
//   current option   → as designed (rear doors placed in the rack meta are simulated by the solver)
//   rdhx             → ChilledDoor-class doors (75 kW each) on every rack in the domain
//   sidecar-l2a      → hall CDUs and room CRAHs removed; rack liquid heat + sidecar fans rejected co-located at each rack exhaust;
//                      the room system is the comparison row's fan-wall units, placed on the walls as real units (polish v2 2차 —
//                      was: room CRAH capacity/airflow ×4.2 through the same supply faces)
//   in-row           → hall CRAHs / fan walls removed; CRV-class in-row coolers sized per cold aisle (both facing rows, N+1) and
//                      placed inside the rows at evenly spaced positions, each replacing one rack position (fix v2 2차)
//   gallery-fan-wall → the comparison row's fan-wall units (catalog fan-wall item, row count): the layout engine's placement when it
//                      honours CoolingPlacementOptions.crahCatalogId, else wall placement of the same units here (polish v2 2차 —
//                      was: the CRAH model re-placed)
//   perimeter-crah   → regenerateCooling() with the perimeter strategy and the row's CRAH count
import {
  analyzeProject,
  compareCoolingTopologiesForHall,
  coolingPlacementFor,
  currentCoolingTopology,
  FAN_INPUT_PER_KW_ESTIMATE,
  findCatalogItem,
  footprintRect,
  placeCrahs,
  redundantCount,
  regenerateCooling,
  SEED_INROW_CRV050,
  SEED_L2A_CDU70,
  SEED_RDHX_CHILLEDDOOR,
  stripRdhxDoors,
  topologyPlacementOptions,
  topologyUnitCatalogId,
} from '../../core/src/index.ts';
import type { CatalogItem, CoolingPlacementOptions, CoolingTopologyOption, EquipmentInstance, Hall, Project, Rect } from '../../core/src/index.ts';
import type { InRowCoolerSpec, ThermalOptions } from './types.ts';

export interface ThermalVariantNote {
  key: string;
  params?: Record<string, string | number>;
}

export interface ThermalVariant {
  option: CoolingTopologyOption;
  available: boolean;
  /** i18n key (cooling.* namespace) explaining why the variant cannot be simulated */
  reason?: string;
  project: Project;
  options: ThermalOptions;
  notes: ThermalVariantNote[];
}

const IT_RACKS = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);
const ROOM_UNITS = new Set(['crah', 'fan-wall']);
const TOL = 0.15;
type Wall = 'N' | 'S' | 'E' | 'W';

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - 1e-3 && b.x < a.x + a.w - 1e-3 && a.y < b.y + b.d - 1e-3 && b.y < a.y + a.d - 1e-3;

export function buildThermalVariant(project: Project, base: ThermalOptions, option: CoolingTopologyOption): ThermalVariant {
  const hallId = base.hallId;
  const hall = project.halls.find((h) => h.id === hallId);
  const out = (v: Partial<ThermalVariant>): ThermalVariant => ({ option, available: true, project, options: base, notes: [], ...v });
  if (!hall) return out({ available: false, reason: 'cooling.cfd.variant.noHall' });
  if (option === currentCoolingTopology(project, hall)) return out({ notes: [{ key: 'cooling.cfd.variant.asDesigned' }] });
  // doors placed in the rack meta belong to the RDHx topology only
  const bare = stripRdhxDoors(project, hallId);

  switch (option) {
    case 'rdhx':
      return out({
        options: { ...base, rdhx: { doorKW: SEED_RDHX_CHILLEDDOOR.unitKW } },
        notes: [{ key: 'cooling.cfd.variant.rdhx', params: { kw: SEED_RDHX_CHILLEDDOOR.unitKW } }],
      });
    case 'sidecar-l2a': {
      const row = rowFor(bare, hallId, option);
      const item = fanWallItem();
      if (!row || !item) return out({ available: false, reason: 'cooling.cfd.variant.noFanWall' });
      const want = row.units - (row.rackUnits ?? 0);
      const placed = wallUnitsVariant(bare, hall, item, want, true);
      const notes: ThermalVariantNote[] = [{ key: 'cooling.cfd.variant.sidecarUnits', params: { units: placed.placed, kw: item.capacity?.coolingKW ?? 0, velocity: faceVelocity(item) } }];
      if (placed.placed < want) notes.push({ key: 'cooling.cfd.variant.unitsShort', params: { missing: want - placed.placed } });
      return out({
        project: placed.project,
        options: { ...base, sidecars: { airflowPerKW: SEED_L2A_CDU70.airflowM3s / SEED_L2A_CDU70.unitKW, fanKWPerKW: FAN_INPUT_PER_KW_ESTIMATE } },
        notes,
      });
    }
    case 'in-row': {
      const v = inRowVariant(bare, base);
      return bare === project ? v : { ...v, ...(v.available ? {} : { project }) };
    }
    case 'gallery-fan-wall': {
      const row = rowFor(bare, hallId, option);
      const item = fanWallItem();
      if (!row || !item) return out({ available: false, reason: 'cooling.cfd.variant.noFanWall' });
      const want = row.units;
      // the layout engine's gallery placement first (what "Place with this topology" applies), when it places the compared units
      const opts = topologyPlacementOptions(option, coolingPlacementFor(hall), row);
      try {
        const next = opts ? regenerateCooling(bare, hallId, opts as CoolingPlacementOptions) : bare;
        const n = next.equipment.filter((e) => e.hallId === hallId && e.catalogId === item.id).length;
        const others = next.equipment.filter((e) => e.hallId === hallId && findCatalogItem(e.catalogId)?.category === 'crah').length;
        if (next !== bare && n === want && others === 0)
          return out({ project: next, notes: [{ key: 'cooling.cfd.variant.fanWall', params: { units: n, kw: item.capacity?.coolingKW ?? 0, velocity: faceVelocity(item) } }, { key: 'cooling.cfd.variant.regenerated' }] });
      } catch {
        /* fall back to the wall placement below */
      }
      const placed = wallUnitsVariant(bare, hall, item, want, false);
      const notes: ThermalVariantNote[] = [{ key: 'cooling.cfd.variant.fanWall', params: { units: placed.placed, kw: item.capacity?.coolingKW ?? 0, velocity: faceVelocity(item) } }, { key: 'cooling.cfd.variant.fanWallWalls', params: { walls: placed.walls.join('/') } }];
      if (placed.placed < want) notes.push({ key: 'cooling.cfd.variant.unitsShort', params: { missing: want - placed.placed } });
      return out({ project: placed.project, notes });
    }
    default: {
      const row = rowFor(bare, hallId, option);
      const opts = topologyPlacementOptions(option, coolingPlacementFor(hall), row);
      if (!opts) return out({ available: false, reason: 'cooling.cfd.variant.noStrategy' });
      let next: Project;
      try {
        next = regenerateCooling(bare, hallId, opts as CoolingPlacementOptions);
      } catch {
        return out({ available: false, reason: 'cooling.cfd.variant.regenFailed' });
      }
      if (next === bare) return out({ available: false, reason: 'cooling.cfd.variant.regenPending' });
      return out({ project: next, notes: [{ key: 'cooling.cfd.variant.regenerated' }] });
    }
  }
}

function rowFor(project: Project, hallId: string, option: CoolingTopologyOption) {
  try {
    return compareCoolingTopologiesForHall(project, analyzeProject(project), hallId).find((r) => r.option === option);
  } catch {
    return undefined;
  }
}

function fanWallItem(): CatalogItem | undefined {
  const id = topologyUnitCatalogId('gallery-fan-wall');
  return id ? findCatalogItem(id) : undefined;
}

/** Mean supply-face velocity of one unit in the solver (airflow ÷ unit width × 55 % of its height, case.ts SUPPLY_FRACTION), m/s. */
function faceVelocity(item: CatalogItem): number {
  const a = item.dims.w * item.dims.h * 0.55;
  return a > 0 ? Math.round(((item.capacity?.airflowM3s ?? 0) / a) * 10) / 10 : 0;
}

/**
 * Remove the hall's room units (and CDUs when `dropCdus`) and place `count` units of `item` against the hall walls, facing into the
 * hall: the row-end walls first, then the other walls while units are missing; every other item keeps its position.
 */
function wallUnitsVariant(project: Project, hall: Hall, item: CatalogItem, count: number, dropCdus: boolean): { project: Project; placed: number; walls: Wall[] } {
  const keep = project.equipment.filter((e) => {
    if (e.hallId !== hall.id) return true;
    const cat = findCatalogItem(e.catalogId)?.category ?? '';
    return !ROOM_UNITS.has(cat) && !(dropCdus && cat === 'cdu');
  });
  const blockers: Rect[] = [];
  let alongX = 0;
  for (const e of keep) {
    if (e.hallId !== hall.id) continue;
    const it = findCatalogItem(e.catalogId);
    if (!it) continue;
    blockers.push(footprintRect(it.dims, e.position, e.rotationDeg));
    if (e.rowId && IT_RACKS.has(it.category)) alongX += e.rotationDeg === 0 || e.rotationDeg === 180 ? 1 : -1;
  }
  for (const c of project.containments) if (c.hallId === hall.id) blockers.push(c.rect);
  const orient = hall.layoutPolicy?.orientation ?? (alongX !== 0 ? (alongX > 0 ? 'x' : 'y') : hall.width >= hall.depth ? 'x' : 'y');
  const order: Wall[] = orient === 'x' ? ['W', 'E', 'N', 'S'] : ['S', 'N', 'W', 'E'];
  let best: { units: EquipmentInstance[]; walls: Wall[] } = { units: [], walls: [] };
  for (let k = 2; k <= 4; k++) {
    const walls = order.slice(0, k);
    const tmp: EquipmentInstance[] = [];
    const n = placeCrahs(tmp, hall, item, count, walls, { width: hall.width, depth: hall.depth, marginM: 0.3, xZone: 0, yZone: 0, podRects: blockers, keepouts: hall.keepouts });
    if (n > best.units.length) best = { units: tmp, walls };
    if (n >= count) break;
  }
  const units = best.units.map((e, i) => ({ ...e, id: `cfd-fw-${hall.id}-${i + 1}`, tag: e.tag.replace(/^CRAH-/, 'FW-'), hallId: hall.id }));
  return { project: { ...project, equipment: [...keep, ...units] }, placed: units.length, walls: best.walls };
}

function inRowVariant(project: Project, base: ThermalOptions): ThermalVariant {
  // fix v2 2차 (QA): units were sized per hot-aisle containment and appended beyond the row ends, so mid-row racks starved (34 °C
  // inlets, 66 units vs 87 in the table). Now, like the comparison table: size per cold aisle (both rows that face it, N+1 per aisle),
  // and place the units INSIDE the rows at evenly spaced positions, each replacing one rack position (the table's positionsLost).
  const hallId = base.hallId;
  const hall = project.halls.find((h) => h.id === hallId)!;
  const seed = SEED_INROW_CRV050;
  const lfDefault = Math.max(0, base.loadFactor ?? 1);
  const coldAisleM = hall.layoutPolicy?.corridors?.coldAisleM ?? 1.2;
  const kept = project.equipment.filter((e) => {
    if (e.hallId !== hallId) return true;
    const cat = findCatalogItem(e.catalogId)?.category;
    return cat !== 'crah' && cat !== 'fan-wall';
  });
  const footprints = kept
    .filter((e) => e.hallId === hallId)
    .map((e) => {
      const item = findCatalogItem(e.catalogId);
      return item ? { e, item, r: footprintRect(item.dims, e.position, e.rotationDeg) } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  type Fp = (typeof footprints)[number];
  interface Row { racks: Fp[]; alongX: boolean; rear: 'low' | 'high'; containment: string; aisleKey: string }
  const rows: Row[] = [];
  for (const c of project.containments) {
    if (c.hallId !== hallId || c.kind !== 'hot-aisle') continue;
    const alongX = c.rect.w >= c.rect.d;
    const low: Fp[] = [];
    const high: Fp[] = [];
    for (const f of footprints) {
      if (!IT_RACKS.has(f.item.category)) continue;
      const r = f.r;
      if (alongX) {
        if (r.x + r.w <= c.rect.x + 1e-3 || r.x >= c.rect.x + c.rect.w - 1e-3) continue;
        if (Math.abs(r.y + r.d - c.rect.y) < TOL) low.push(f);
        else if (Math.abs(r.y - (c.rect.y + c.rect.d)) < TOL) high.push(f);
      } else {
        if (r.y + r.d <= c.rect.y + 1e-3 || r.y >= c.rect.y + c.rect.d - 1e-3) continue;
        if (Math.abs(r.x + r.w - c.rect.x) < TOL) low.push(f);
        else if (Math.abs(r.x - (c.rect.x + c.rect.w)) < TOL) high.push(f);
      }
    }
    // the row below the aisle (rear on its high edge) fronts the cold aisle below it, and vice versa; key = cold-aisle centre line
    const key = (racks: Fp[], rearHigh: boolean) => {
      const front = rearHigh ? Math.min(...racks.map((f) => (alongX ? f.r.y : f.r.x))) : Math.max(...racks.map((f) => (alongX ? f.r.y + f.r.d : f.r.x + f.r.w)));
      return `${alongX ? 'x' : 'y'}|${Math.round((front + (rearHigh ? -1 : 1) * coldAisleM / 2) / 0.3)}`;
    };
    const along = (f: Fp) => (alongX ? f.r.x : f.r.y);
    if (low.length) rows.push({ racks: low.sort((a, b) => along(a) - along(b)), alongX, rear: 'high', containment: c.id, aisleKey: key(low, true) });
    if (high.length) rows.push({ racks: high.sort((a, b) => along(a) - along(b)), alongX, rear: 'low', containment: c.id, aisleKey: key(high, false) });
  }
  const aisles = new Map<string, Row[]>();
  for (const r of rows) aisles.set(r.aisleKey, [...(aisles.get(r.aisleKey) ?? []), r]);

  const replaced = new Set<string>();
  const units: InRowCoolerSpec[] = [];
  let short = 0;
  for (const [aisle, group] of [...aisles].sort((a, b) => a[0].localeCompare(b[0]))) {
    let air = 0;
    let flow = 0;
    for (const { e, item } of group.flatMap((g) => g.racks)) {
      const lf = Math.max(0, e.loadFactor ?? lfDefault);
      const kw = item.category === 'network-rack' ? 25 : (item.power?.nameplateKW ?? 0) * lf * (1 - (item.cooling?.liquidFraction ?? 0));
      air += kw;
      flow += (item.cooling?.airflowM3s ?? (kw * 1000) / (1.19 * 1006 * 12)) * (item.category === 'network-rack' ? 1 : Math.max(0.4, lf));
    }
    const n = Math.max(Math.ceil((air * (1 + seed.inputKW / seed.unitKW)) / seed.unitKW - 1e-9), Math.ceil((1.1 * flow) / seed.airflowM3s - 1e-9), 1);
    const need = redundantCount(n, project.cooling.crahRedundancy);
    const total = group.reduce((a, g) => a + g.racks.length, 0);
    let left = need;
    group.forEach((row, gi) => {
      const u = gi === group.length - 1 ? left : Math.min(left, Math.round((need * row.racks.length) / Math.max(1, total)));
      left -= u;
      // slots every ⌈racks / u⌉ positions (centred); prefer IT racks over network racks at the chosen slot
      const m = row.racks.length;
      const picks: number[] = [];
      for (let j = 0; j < u && j < m; j++) {
        let idx = Math.min(m - 1, Math.floor(((j + 0.5) * m) / u));
        for (let d = 0; d < m && (picks.includes(idx) || row.racks[idx].item.category === 'network-rack'); d++) {
          const cand = [idx + d, idx - d].find((k) => k >= 0 && k < m && !picks.includes(k) && row.racks[k].item.category !== 'network-rack');
          if (cand !== undefined) {
            idx = cand;
            break;
          }
        }
        if (!picks.includes(idx)) picks.push(idx);
      }
      if (picks.length < u) short += u - picks.length;
      for (const idx of picks.sort((a, b) => a - b)) {
        const f = row.racks[idx];
        replaced.add(f.e.id);
        const depth = Math.min(seed.depthM, row.alongX ? f.r.d : f.r.w);
        const centre = row.alongX ? f.r.x + f.r.w / 2 : f.r.y + f.r.d / 2;
        const a0 = centre - seed.widthM / 2;
        // flush with the rack's rear (hot-aisle) edge so the return face opens into the contained aisle
        const rect: Rect = row.alongX
          ? { x: a0, y: row.rear === 'high' ? f.r.y + f.r.d - depth : f.r.y, w: seed.widthM, d: depth }
          : { x: row.rear === 'high' ? f.r.x + f.r.w - depth : f.r.x, y: a0, w: depth, d: seed.widthM };
        units.push({ id: `inrow-${row.containment}-${units.length + 1}`, tag: `IRC-${aisle.replace(/\W+/g, '')}-${units.length + 1}`, rect, rotationDeg: f.e.rotationDeg, heightM: seed.heightM, capacityKW: seed.unitKW, airflowM3s: seed.airflowM3s });
      }
    });
  }
  const equipment = kept.filter((e) => !replaced.has(e.id));
  const notes: ThermalVariantNote[] = [{ key: 'cooling.cfd.variant.inrow', params: { units: units.length, kw: seed.unitKW } }];
  if (replaced.size) notes.push({ key: 'cooling.cfd.variant.inrowReplaced', params: { racks: replaced.size } });
  if (short > 0) notes.push({ key: 'cooling.cfd.variant.inrowShort', params: { missing: short } });
  if (!units.length) return { option: 'in-row', available: false, reason: 'cooling.cfd.variant.inrowNoSpace', project, options: base, notes };
  return {
    option: 'in-row',
    available: true,
    project: { ...project, equipment },
    // integration (OCP round): in-row CDU cabinets now carry the datasheet pump/drive power (XDU2300 47.8 kW), and their exhaust
    // reaches the in-row returns slowly — the default 0.01 °C/step drift stops at a 3.1 % air-side imbalance. Converge tighter
    // (as the sidecar case does) so the comparison closes the balance (1.3 %).
    options: { ...base, tolerance: Math.min(base.tolerance ?? 0.01, 0.003), inRowCoolers: units },
    notes,
  };
}
