// Per-rack contents for the per-DU rack elevation sheets and documents (area D2, DECISIONS-v2-2 §D, r3-rack-diagrams.md §4).
//
// `buildRackContents(project, analysis, opts)` → one RackContents per rack instance: U slots from the shared resolver
// (layout/rackContents.ts), switch positions from the network analysis (same order as engines/links.ts buildSwitchUnits),
// cable counts from the cable schedule (optional input), A/B circuits and rack capacity from the power plane, weight
// against the rack static load rating, wave, and inlet sensors from a CFD-lite snapshot (optional). Every number is a
// DESIGN value (catalog / engines) or a SIMULATED value (CFD-lite); AIDC has no measured data. Pure and deterministic.
import { findCatalogItem } from '../catalog/catalog.ts';
import { buildPowerPlane, type PowerPlane } from '../engines/powerPaths.ts';
import { hallLayoutHash, rackSlotMap, rackStaticLoadRating, type RackSlotCategory } from '../layout/rackContents.ts';
import type { CableScheduleRow, CatalogItem, EquipmentInstance, Hall, NetworkRackLoad, Project, ProjectAnalysis, SpecSource, ThermalSnapshot } from '../model/types.ts';
import { RACK_CATS, waveOf } from './bom.ts';

export type RackZone = 'du' | 'services' | 'network-core' | 'unassigned';
export type RackStatus = 'green' | 'amber' | 'red' | 'grey';

export interface RackUnitRow {
  uStart: number;
  uEnd: number;
  units: number;
  category: RackSlotCategory;
  label: string;
  model: string;
  /** design kW of this slot (apportioned from the rack PowerSpec for rack-scale / node racks — estimate) */
  kwDesign: number;
  kwPeak: number;
  weightKg?: number;
  ports?: number;
  portsUsed?: number;
  cableCount?: number;
  equipmentId: string;
  catalogId?: string;
  role?: string;
  fabric?: string;
  source: SpecSource;
  auto?: boolean;
  side?: 'A' | 'B';
}

export interface RackZeroU {
  kind: 'pdu-0u' | 'busbar' | 'manifold';
  side: 'A' | 'B' | 'center';
  label: string;
  source: SpecSource;
}

export interface RackSensor {
  position: 'bottom' | 'middle' | 'top';
  heightM: number;
  face: 'front' | 'rear';
  /** simulated value (CFD-lite), absent without a current snapshot */
  valueC?: number;
  /** ASHRAE recommended upper inlet limit (27 °C) */
  limitC: number;
  /** allowable inlet (catalog maxInletC, default 35 = ASHRAE A2) */
  maxC: number;
  state: 'simulated' | 'stale' | 'none';
  source: 'cfd-lite' | 'design-limit';
  status: RackStatus;
}

export interface RackContents {
  rack: {
    id: string; tag: string; catalogId: string; model: string; category: string; hallId: string; hallName: string; hallCode: string;
    podId?: string; rowId?: string; rowKey: string; row: string; zone: RackZone; du: string; groupKey: string;
    /** 1-based floor position along the row (min x / min y first, as rack-plan.csv) */
    position: number; rotationDeg: number; x: number; y: number; gpus: number; widthM: number; depthM: number;
  };
  side: 'front' | 'rear';
  unit: 'U' | 'OU';
  totalU: number;
  units: RackUnitRow[];
  zeroU: RackZeroU[];
  usedU: number;
  freeU: number;
  blankU: number;
  reservedU: number;
  kwDesign: number;
  kwTypical: number;
  kwPeak: number;
  /** rack power capacity = min(known limits) — undefined when none is modelled */
  circuitBudgetKw?: number;
  circuitBudgetSource: string;
  circuits: { A?: RackCircuitRef; B?: RackCircuitRef };
  cordSides: number;
  weightKg: number;
  ratedLoadKg?: number;
  ratedLoadSource?: string;
  floorLoadKgM2: number;
  floorRatingKgM2: number;
  wave: { id: string; name: string };
  sensors: RackSensor[];
  exhaustC?: number;
  thermal: { state: 'simulated' | 'stale' | 'none'; at?: string; snapshotId?: string };
  cables: Record<string, number>;
  portsUsed: number;
  portsTotal: number;
  status: { space: RackStatus; power: RackStatus; weight: RackStatus; thermal: RackStatus; overall: RackStatus };
  /** finish v2 2차 (QA rack-elevations M3): why the power / weight status is what it is (English, for CSV / tables) */
  statusNotes: string[];
  /** power flags for the sheet header (localised there) */
  powerFlags: { shelfMarginPct?: number; capping?: boolean; peakOverKw?: number };
  /** space status is not rated for factory-fixed rack-scale / catalog node U-maps */
  spaceRated: boolean;
  source: SpecSource;
  note: string;
}

export interface RackCircuitRef { id: string; label: string; limitKw: number; circuit: number; kw?: number; loadingPct?: number }

export interface RackContentsOptions {
  /** CFD-lite snapshots (default: project.thermalSnapshots); the newest per hall is used */
  thermal?: ThermalSnapshot[] | null;
  /** cable schedule rows (ports / cable counts per slot); absent = no cable counts */
  cableSchedule?: CableScheduleRow[];
  hallId?: string;
}

/** Sensor heights (m above floor) — same as the 3D viewer rackInletTemp sampling. */
export const SENSOR_HEIGHTS: { position: RackSensor['position']; heightM: number }[] = [
  { position: 'bottom', heightM: 0.5 },
  { position: 'middle', heightM: 1.2 },
  { position: 'top', heightM: 1.9 },
];
export const INLET_RECOMMENDED_C: [number, number] = [18, 27];
export const SPACE_THRESHOLDS = { amber: 0.8, red: 0.95 };
export const WEIGHT_THRESHOLDS = { amber: 0.9, red: 1.0 };

const IT_WEIGHT: Partial<Record<RackSlotCategory, number>> = { 'compute-tray': 1, 'gpu-node': 1, 'cpu-server': 1, 'storage-shelf': 1, 'mgmt-server': 1, 'scaleup-switch-tray': 0.12 };
const RANK: Record<RackStatus, number> = { grey: 0, green: 1, amber: 2, red: 3 };
export const worstStatus = (...s: RackStatus[]): RackStatus => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'grey' as RackStatus);
const ratioStatus = (r: number | undefined, amber: number, red: number): RackStatus => (r === undefined || !Number.isFinite(r) ? 'grey' : r > red ? 'red' : r >= amber ? 'amber' : 'green');
const r1 = (v: number) => Math.round(v * 10) / 10;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function inletStatus(valueC: number | undefined, maxC: number): RackStatus {
  if (valueC === undefined) return 'grey';
  if (valueC > maxC) return 'red';
  if (valueC > INLET_RECOMMENDED_C[1] || valueC < INLET_RECOMMENDED_C[0]) return 'amber';
  return 'green';
}

export function zoneOfPod(podId: string | undefined): RackZone {
  if (!podId) return 'unassigned';
  if (podId.startsWith('pod-services')) return 'services';
  if (podId.startsWith('pod-network-core')) return 'network-core';
  return 'du';
}

function duLabel(zone: RackZone, podId: string | undefined, tag: string): string {
  const num = podId ? /(\d+)$/.exec(podId)?.[1] : undefined;
  if (zone === 'du') return num ? `DU${pad2(Number(num))}` : (/^([A-Z]+\d+)-/.exec(tag)?.[1] ?? 'DU');
  if (zone === 'services') return num ? `SV${pad2(Number(num))}` : 'SV';
  if (zone === 'network-core') return num ? `NC${pad2(Number(num))}` : 'NC';
  return 'XX';
}

function rowLetter(e: EquipmentInstance, rowKey: string): string {
  if (e.rowId && e.podId && e.rowId.startsWith(`${e.podId}-`)) return e.rowId.slice(e.podId.length + 1).toUpperCase();
  const m = /-([a-z0-9]+(?:-c\d+)?)$/i.exec(rowKey);
  return (m ? m[1] : rowKey).toUpperCase();
}

// finish v2 2차 (QA rack-elevations m1): racks without a rowId bucket along the cross-row axis (x for 90° / 270° rows, y otherwise)
const rowKeyOf = (e: EquipmentInstance, tile: number) => {
  if (e.rowId) return e.rowId;
  const t = Math.max(0.1, tile);
  const vertical = e.rotationDeg % 180 !== 0;
  return vertical ? `x${(Math.round(e.position.x / t) * t).toFixed(1)}` : `y${(Math.round(e.position.y / t) * t).toFixed(1)}`;
};

/** Newest snapshot per hall. */
function latestSnapshots(list: ThermalSnapshot[] | null | undefined): Map<string, ThermalSnapshot> {
  const out = new Map<string, ThermalSnapshot>();
  for (const s of list ?? []) {
    const cur = out.get(s.hallId);
    if (!cur || s.at > cur.at) out.set(s.hallId, s);
  }
  return out;
}

export function buildRackContents(project: Project, analysis: ProjectAnalysis | null, opts: RackContentsOptions = {}): RackContents[] {
  const halls = new Map<string, Hall>(project.halls.map((h) => [h.id, h]));
  const hallIndex = new Map(project.halls.map((h, i) => [h.id, i]));
  const loads = new Map<string, NetworkRackLoad>((analysis?.network.rackLoads ?? []).map((l) => [l.rackId, l]));
  let plane: PowerPlane | undefined;
  try { plane = buildPowerPlane(project, analysis); } catch { plane = undefined; }
  const planeRacks = new Map((plane?.racks ?? []).map((r) => [r.id, r]));
  const circuits = new Map((plane?.circuits ?? []).map((c) => [c.id, c]));
  const rule = plane?.rule;
  const pathLoad = new Map((analysis?.power.paths ?? []).filter((p) => p.kind === 'busway').map((p) => [p.id, p]));
  const snaps = latestSnapshots(opts.thermal !== undefined ? opts.thermal : project.thermalSnapshots);
  const hashes = new Map<string, string>();
  const waveName = (id: string) => (id === 'common' ? 'Common' : project.schedule.waves.find((w) => w.id === id)?.name ?? id);

  const racks = project.equipment
    .filter((e) => (!opts.hallId || e.hallId === opts.hallId) && halls.has(e.hallId))
    .map((e) => ({ e, item: findCatalogItem(e.catalogId) }))
    .filter((x): x is { e: EquipmentInstance; item: CatalogItem } => !!x.item && RACK_CATS.has(x.item.category));

  // floor position within row (as rack-plan.csv)
  const byRow = new Map<string, EquipmentInstance[]>();
  for (const { e } of racks) {
    const k = `${e.hallId}|${rowKeyOf(e, halls.get(e.hallId)!.tileSize)}`;
    const arr = byRow.get(k) ?? [];
    arr.push(e);
    byRow.set(k, arr);
  }
  const posOf = new Map<string, number>();
  for (const arr of byRow.values()) {
    const vertical = arr.every((r) => r.rotationDeg === 90 || r.rotationDeg === 270);
    arr.sort((a, b) => (vertical ? a.position.y - b.position.y : a.position.x - b.position.x) || a.tag.localeCompare(b.tag));
    arr.forEach((r, i) => posOf.set(r.id, i + 1));
  }

  // cable ends per rack reference "<H#>.<tag>" → U list
  const cableEnds = new Map<string, { u?: number; fabric: string }[]>();
  for (const row of opts.cableSchedule ?? []) {
    for (const [rack, u] of [[row.fromRack, row.fromU], [row.toRack, row.toU]] as [string, number | undefined][]) {
      const arr = cableEnds.get(rack) ?? [];
      arr.push({ u, fabric: row.fabric });
      cableEnds.set(rack, arr);
    }
  }

  const out: RackContents[] = [];
  for (const { e, item } of racks) {
    const hall = halls.get(e.hallId)!;
    const hallCode = `H${(hallIndex.get(e.hallId) ?? 0) + 1}`;
    const load = loads.get(e.id);
    const map = rackSlotMap(item, load?.switches, findCatalogItem, { ruCapacity: load?.ruCapacity });
    const lf = e.loadFactor ?? 1;
    const pw = item.power;
    const switchKw = (s: { catalogId?: string }) => (s.catalogId ? findCatalogItem(s.catalogId)?.power?.nameplateKW ?? 0 : 0);
    const switchPeak = (s: { catalogId?: string }) => (s.catalogId ? findCatalogItem(s.catalogId)?.power?.peakKW ?? switchKw(s) : 0);
    const isNet = item.category === 'network-rack';
    const rackKw = isNet ? 0 : (pw?.nameplateKW ?? 0) * lf;
    const peakRatio = pw && pw.nameplateKW > 0 ? pw.peakKW / pw.nameplateKW : 1;
    const typRatio = pw && pw.nameplateKW > 0 ? pw.typicalKW / pw.nameplateKW : 1;
    const wsum = map.slots.reduce((s, sl) => s + (sl.kw != null ? 0 : IT_WEIGHT[sl.category] ?? 0), 0);
    const explicitKw = map.slots.reduce((s, sl) => s + (sl.kw ?? 0), 0);
    const ends = cableEnds.get(`${hallCode}.${e.tag}`) ?? [];
    const cables: Record<string, number> = {};
    for (const c of ends) cables[c.fabric] = (cables[c.fabric] ?? 0) + 1;

    const units: RackUnitRow[] = map.slots.map((sl) => {
      let kw = 0;
      let peak = 0;
      let weightKg: number | undefined;
      if (sl.category === 'switch') {
        kw = switchKw(sl);
        peak = switchPeak(sl);
        weightKg = sl.catalogId ? findCatalogItem(sl.catalogId)?.weightKg : undefined;
      } else if (sl.kw != null) {
        kw = sl.kw * lf;
        peak = kw * peakRatio;
      } else if (wsum > 0 && IT_WEIGHT[sl.category]) {
        kw = (Math.max(0, rackKw - explicitKw * lf) * IT_WEIGHT[sl.category]!) / wsum;
        peak = kw * peakRatio;
      }
      const cableCount = ends.filter((c) => c.u !== undefined && c.u >= sl.uStart && c.u <= sl.uEnd).length;
      return {
        uStart: sl.uStart, uEnd: sl.uEnd, units: sl.units, category: sl.category, label: sl.label, model: sl.model,
        kwDesign: r1(kw), kwPeak: r1(peak), ...(weightKg !== undefined ? { weightKg } : {}),
        ...(sl.ports ? { ports: sl.ports, portsUsed: Math.min(sl.ports, cableCount) } : {}),
        ...(cableCount ? { cableCount } : {}),
        equipmentId: e.id, ...(sl.catalogId ? { catalogId: sl.catalogId } : {}), ...(sl.role ? { role: sl.role } : {}), ...(sl.fabric ? { fabric: sl.fabric } : {}),
        source: sl.source, ...(sl.auto ? { auto: true } : {}), ...(sl.side ? { side: sl.side } : {}),
      };
    });
    const usedU = units.filter((u) => u.category !== 'blank' && u.category !== 'reserved').reduce((s, u) => s + u.units, 0);
    const blankU = units.filter((u) => u.category === 'blank').reduce((s, u) => s + u.units, 0);
    const reservedU = units.filter((u) => u.category === 'reserved').reduce((s, u) => s + u.units, 0);
    const swKw = units.filter((u) => u.category === 'switch').reduce((s, u) => s + u.kwDesign, 0);
    const kwDesign = isNet ? (load?.kw ?? swKw) : rackKw + swKw;
    const kwPeak = isNet ? units.reduce((s, u) => s + u.kwPeak, 0) : rackKw * peakRatio + units.filter((u) => u.category === 'switch').reduce((s, u) => s + u.kwPeak, 0);
    const kwTypical = isNet ? kwDesign : rackKw * typRatio + swKw;

    // rack power capacity = min(power shelves one side, cooling-class cap, network rack cap)
    const pr = planeRacks.get(e.id);
    const caps: { kw: number; src: string }[] = [];
    if (pr && !/^assumed/.test(pr.cord.source) && pr.cord.shelfKW > 0) caps.push({ kw: pr.cord.shelvesRequired * pr.cord.shelfKW, src: `power shelves ${pr.cord.shelvesRequired} × ${pr.cord.shelfKW} kW per side` });
    const composerCap = Number(item.meta?.kwCap ?? 0);
    if (composerCap > 0) caps.push({ kw: composerCap, src: 'composer cooling-class cap (estimate)' });
    if (isNet && load?.kwCapacity) caps.push({ kw: load.kwCapacity, src: 'network rack capacity (estimate)' });
    caps.sort((a, b) => a.kw - b.kw);
    const cap = caps[0];
    const circ = (id?: string) => {
      const c = id ? circuits.get(id) : undefined;
      const p = c ? pathLoad.get(c.id) : undefined;
      return c ? { id: c.id, label: `${c.buswayId}·C${c.circuit}`, limitKw: r1(c.limitKW), circuit: c.circuit, ...(p?.connectedKW !== undefined ? { kw: r1(p.connectedKW), loadingPct: Math.round((p.loading ?? 0) * 100) } : {}) } : undefined;
    };
    const cA = circ(pr?.circuits.A);
    const cB = circ(pr?.circuits.B);

    const weightKg = item.weightKg + units.reduce((s, u) => s + (u.category === 'switch' ? u.weightKg ?? 0 : 0), 0);
    const rating = rackStaticLoadRating(item);
    const footprint = Math.max(0.01, item.dims.w * item.dims.d);
    const floorLoad = weightKg / footprint;
    // floor load for the status: rack weight over footprint + half the front / rear clearance (engines/space.ts floorLoadKgPerM2 convention)
    const clr = item.clearance ?? { front: 0, rear: 0, sides: 0 };
    const floorLoadClr = weightKg / Math.max(0.01, (item.dims.w + (clr.sides ?? 0)) * (item.dims.d + ((clr.front ?? 0) + (clr.rear ?? 0)) / 2));

    // thermal
    let hash = hashes.get(e.hallId);
    if (!hash) { hash = hallLayoutHash(project, e.hallId); hashes.set(e.hallId, hash); }
    const snap = snaps.get(e.hallId);
    const tstate: RackContents['thermal']['state'] = !snap ? 'none' : snap.layoutHash === hash ? 'simulated' : 'stale';
    const rt = tstate === 'simulated' ? snap!.racks.find((r) => r.id === e.id) : undefined;
    const maxC = item.cooling?.maxInletC ?? 35;
    const sensors: RackSensor[] = SENSOR_HEIGHTS.map((h, i) => {
      const v = rt?.inletBandsC?.[i];
      const valueC = v !== undefined && Number.isFinite(v) ? r1(v) : undefined;
      return { position: h.position, heightM: h.heightM, face: 'front', ...(valueC !== undefined ? { valueC } : {}), limitC: INLET_RECOMMENDED_C[1], maxC, state: valueC !== undefined ? 'simulated' : tstate === 'stale' ? 'stale' : 'none', source: valueC !== undefined ? 'cfd-lite' : 'design-limit', status: inletStatus(valueC, maxC) };
    });

    const zeroU: RackZeroU[] = [];
    if (map.slots.some((s) => s.category === 'power-shelf')) zeroU.push({ kind: 'busbar', side: 'center', label: '48–54 V DC busbar', source: map.source });
    else if (item.category !== 'gpu-rack' || !map.slots.some((s) => s.category === 'compute-tray')) {
      const sides = pr?.cord.sides ?? (pw?.feeds ?? 2) >= 2 ? 2 : 1;
      zeroU.push({ kind: 'pdu-0u', side: 'A', label: 'PDU-A (0U)', source: 'estimate' });
      if (sides === 2) zeroU.push({ kind: 'pdu-0u', side: 'B', label: 'PDU-B (0U)', source: 'estimate' });
    }
    if ((item.cooling?.liquidFraction ?? 0) > 0) zeroU.push({ kind: 'manifold', side: 'center', label: 'TCS manifold (supply / return)', source: 'estimate' });

    const zone = zoneOfPod(e.podId);
    const rowKey = rowKeyOf(e, hall.tileSize);
    const row = rowLetter(e, rowKey);
    const du = duLabel(zone, e.podId, e.tag);
    const wid = waveOf(e, project);
    const ports = units.filter((u) => u.ports);
    const space = map.totalU > 0 ? usedU / map.totalU : undefined;
    // finish v2 2차 (QA rack-elevations M3): statuses that separate racks —
    //  space: rated only for composer / generic racks (a factory-integrated rack-scale system or a catalog node rack is full by design);
    //  power: red only when a circuit exceeds its continuous limit; the rack's own N+N shelf margin below demand is amber ("capping
    //         required") when the platform can cap, red when it cannot; peak above the shelf capacity is noted;
    //  weight: worst of rack weight vs the rack static rating and floor load vs the hall floor rating.
    const spaceRated = !(item.category === 'gpu-rack' && map.source !== 'user');
    const lim = rule?.continuousLimit ?? 1;
    const warn = (rule?.warnAt ?? 0.9) / lim;
    const statusNotes: string[] = [];
    const powerFlags: RackContents['powerFlags'] = {};
    const circLoads = [cA?.loadingPct, cB?.loadingPct].filter((v): v is number => v !== undefined);
    const circuitStatus: RackStatus = circLoads.length ? ratioStatus(Math.max(...circLoads) / 100, warn, 1) : 'grey';
    if (circLoads.length && Math.max(...circLoads) / 100 > 1) statusNotes.push(`circuit above its continuous limit (${Math.max(...circLoads)} %)`);
    let shelfStatus: RackStatus = 'grey';
    if (cap) {
      const demand = /^power shelves/.test(cap.src) ? rackKw : kwDesign;
      const ratio = demand / cap.kw;
      if (ratio > 1 + 1e-9) {
        const cappable = pr?.cord.cappable ?? false;
        shelfStatus = cappable ? 'amber' : 'red';
        powerFlags.shelfMarginPct = Math.round((cap.kw / demand - 1) * 100);
        powerFlags.capping = cappable;
        statusNotes.push(`N+N shelf margin ${powerFlags.shelfMarginPct} % (${r1(demand)} kW on ${r1(cap.kw)} kW)${cappable ? ', capping required' : ', platform cannot cap'}`);
      } else shelfStatus = ratioStatus(ratio, warn, 1);
      const peak = /^power shelves/.test(cap.src) ? rackKw * peakRatio : kwPeak;
      if (peak > cap.kw + 1e-9) {
        powerFlags.peakOverKw = r1(peak);
        statusNotes.push(`peak ${r1(peak)} kW above the ${r1(cap.kw)} kW capacity`);
      }
    }
    const weightRatio = Math.max(rating ? weightKg / rating.kg : 0, hall.floorLoadingKgPerM2 > 0 ? floorLoadClr / hall.floorLoadingKgPerM2 : 0);
    if (hall.floorLoadingKgPerM2 > 0 && floorLoadClr > WEIGHT_THRESHOLDS.amber * hall.floorLoadingKgPerM2) statusNotes.push(`floor load ${Math.round(floorLoadClr)} kg/m² vs hall rating ${hall.floorLoadingKgPerM2} kg/m²`);
    const status = {
      space: spaceRated ? ratioStatus(space, SPACE_THRESHOLDS.amber, SPACE_THRESHOLDS.red) : 'grey' as RackStatus,
      power: worstStatus(circuitStatus, shelfStatus),
      weight: rating || hall.floorLoadingKgPerM2 > 0 ? ratioStatus(weightRatio, WEIGHT_THRESHOLDS.amber, WEIGHT_THRESHOLDS.red) : 'grey' as RackStatus,
      thermal: worstStatus(...sensors.map((s) => s.status)),
      overall: 'grey' as RackStatus,
    };
    status.overall = worstStatus(status.space, status.power, status.weight, status.thermal);

    out.push({
      rack: {
        id: e.id, tag: e.tag, catalogId: item.id, model: item.name, category: item.category, hallId: hall.id, hallName: hall.name, hallCode,
        ...(e.podId ? { podId: e.podId } : {}), ...(e.rowId ? { rowId: e.rowId } : {}), rowKey, row, zone, du,
        groupKey: `${hall.id}|${zone}|${du}|${zone === 'unassigned' ? rowKey : row}`,
        position: posOf.get(e.id) ?? 0, rotationDeg: e.rotationDeg, x: r1(e.position.x * 10) / 10, y: r1(e.position.y * 10) / 10,
        gpus: pr?.gpus ?? item.compute?.gpus ?? 0, widthM: item.dims.w, depthM: item.dims.d,
      },
      side: 'front', unit: map.unit, totalU: map.totalU, units, zeroU,
      usedU, freeU: map.totalU - usedU, blankU, reservedU,
      kwDesign: r1(kwDesign), kwTypical: r1(kwTypical), kwPeak: r1(kwPeak),
      ...(cap ? { circuitBudgetKw: r1(cap.kw) } : {}), circuitBudgetSource: cap?.src ?? '—',
      circuits: { ...(cA ? { A: cA } : {}), ...(cB ? { B: cB } : {}) }, cordSides: pr?.cord.sides ?? (pw?.feeds ?? 2),
      weightKg: Math.round(weightKg), ...(rating ? { ratedLoadKg: rating.kg, ratedLoadSource: rating.label } : {}),
      floorLoadKgM2: Math.round(floorLoadClr), floorRatingKgM2: hall.floorLoadingKgPerM2,
      wave: { id: wid, name: waveName(wid) }, sensors,
      ...(rt && Number.isFinite(rt.exhaustC) ? { exhaustC: r1(rt.exhaustC) } : {}),
      thermal: { state: tstate, ...(snap ? { at: snap.at, snapshotId: snap.id } : {}) },
      cables, portsUsed: ports.reduce((s, u) => s + (u.portsUsed ?? 0), 0), portsTotal: ports.reduce((s, u) => s + (u.ports ?? 0), 0),
      status, statusNotes, powerFlags, spaceRated, source: map.source, note: map.note,
    });
  }
  return out;
}

/** Contents of one rack (see buildRackContents). */
export function rackContents(project: Project, analysis: ProjectAnalysis | null, rackId: string, opts: RackContentsOptions = {}): RackContents | undefined {
  const e = project.equipment.find((x) => x.id === rackId);
  if (!e) return undefined;
  return buildRackContents(project, analysis, { ...opts, hallId: e.hallId }).find((r) => r.rack.id === rackId);
}

export interface RackRowGroup {
  key: string;
  hallId: string;
  hallName: string;
  hallCode: string;
  zone: RackZone;
  du: string;
  row: string;
  podId?: string;
  /** racks in FRONT viewing order (viewer in the cold aisle, facing the rack fronts) */
  racks: RackContents[];
  /** dominant rotation of the row */
  rotationDeg: number;
  /** 'front faces +Y' etc. for the band caption */
  facing: '+Y' | '-Y' | '+X' | '-X';
}

const ZONE_ORDER: Record<RackZone, number> = { du: 0, services: 1, 'network-core': 2, unassigned: 3 };

/**
 * Row groups (hall → DU → row, then services, network core, unassigned). Front viewing order (r3 §4.1): front faces +Y
 * (0°) → decreasing x; −Y (180°) → increasing x; +X (90°) → increasing y; −X (270°) → decreasing y.
 */
export function rackRowGroups(contents: RackContents[], project: Project): RackRowGroup[] {
  const groups = new Map<string, RackContents[]>();
  for (const c of contents) {
    const arr = groups.get(c.rack.groupKey) ?? [];
    arr.push(c);
    groups.set(c.rack.groupKey, arr);
  }
  const hallIdx = new Map(project.halls.map((h, i) => [h.id, i]));
  const out: RackRowGroup[] = [];
  for (const [key, arr] of groups) {
    const rotCount = new Map<number, number>();
    for (const c of arr) rotCount.set(((c.rack.rotationDeg % 360) + 360) % 360, (rotCount.get(((c.rack.rotationDeg % 360) + 360) % 360) ?? 0) + 1);
    const rot = [...rotCount.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
    const facing = rot === 90 ? '+X' : rot === 180 ? '-Y' : rot === 270 ? '-X' : '+Y';
    const sorted = [...arr].sort((a, b) => {
      const d = facing === '+Y' ? b.rack.x - a.rack.x : facing === '-Y' ? a.rack.x - b.rack.x : facing === '+X' ? a.rack.y - b.rack.y : b.rack.y - a.rack.y;
      return d || a.rack.tag.localeCompare(b.rack.tag);
    });
    const f = arr[0].rack;
    out.push({ key, hallId: f.hallId, hallName: f.hallName, hallCode: f.hallCode, zone: f.zone, du: f.du, row: f.zone === 'unassigned' ? f.rowKey : f.row, ...(f.podId ? { podId: f.podId } : {}), racks: sorted, rotationDeg: rot, facing });
  }
  return out.sort((a, b) => (hallIdx.get(a.hallId) ?? 0) - (hallIdx.get(b.hallId) ?? 0) || ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone] || a.du.localeCompare(b.du, 'en', { numeric: true }) || a.row.localeCompare(b.row, 'en', { numeric: true }));
}
