import { findCatalogItem, getCatalogItem } from '../catalog/catalog.ts';
import { VENDOR_RACKSCALE_POD } from './samples/platforms.ts';
import { breakoutFactor, leafPortSplit, sizeFabricFromPodPorts } from '../engines/radix.ts';
import { footprintRect, footprintSize, rectsOverlap, round6 } from '../model/geometry.ts';
import type { Busway, CableTray, CatalogItem, Containment, EquipmentInstance, Hall, Issue, LayoutPolicy, LayoutReservation, Rect, RowGroup, ServicesZoneMode, SpinePlacement } from '../model/types.ts';
import { airHeatKW, leafSwitchesFor, liquidHeatKW, redundantCount, spineSwitchesFor, switchesPerNetworkRack } from './estimates.ts';
import { buildBusways, buildTrays, RACK_CATEGORIES_FOR_ROWS } from './rows.ts';
import { DEFAULT_RACK_HEIGHT_M, resolveVerticals } from '../scene/datums.ts';

/**
 * Deployment-unit ("pod") generator — v2 (PROPOSAL-v2 §3.1 Phase A, §1.3).
 *
 * Default deployment unit (REF_POD_TEMPLATE — AIDC Studio reference parameters, editable per template):
 * two rows of contiguous rack-scale systems on a 0.6 m pitch, rows 3.42 m apart
 * (center-to-center) forming a contained hot aisle, pods repeated on a 7.3152 m (24 ft) pitch. Templates
 * (layout/templates) change the row composition (network racks mid-row, CDUs at both ends, service racks at
 * the row ends, single-row RCU rows, …).
 *
 * Plan layout produced (rows run along +X, pods stack along +Y, optionally in several columns separated by a
 * transport aisle; `orientation: 'y'` transposes the whole plan):
 *
 *   wall │ CRAH │ aisle │ [CDU…][GPU×6][gap][GPU×6][NET…] │ transport │ [next column…] │ aisle │ CRAH │ wall
 *
 * v2 changes versus v0.1:
 *   - central (spine / core / front-end / storage / OOB aggregation) racks are sized for every fabric with the
 *     radix math the network engine uses (engines/radix.ts) and wrapped into rows no longer than the pod area
 *     (RowGroup kind 'network-core'); storage / CPU / management racks form 'services' rows; both keep
 *     podId 'pod-services' for compatibility;
 *   - requiredWidth / requiredDepth include every row;
 *   - CRAHs: count from the cooling engine's rule, placed on the policy walls (default W+E) with N/S added
 *     automatically when the span cannot hold them (never silently dropped; a layout issue is raised when even
 *     four walls cannot hold the count), avoiding keepouts;
 *   - cable trays and A/B busways are generated here (layout/rows.ts) and clipped to the hall rectangle;
 *   - spine placement (`central-end` / `central-center` / `distributed` / `separate-room`) moves the network-core rows.
 */

export type Wall = 'N' | 'S' | 'E' | 'W';

export interface PodTemplate {
  gpuRackCatalogId: string;
  racksPerRow: number;
  /** rear-face to rear-face (HAC) or front-to-front (CAC) aisle inside the pod */
  innerAisleM: number;
  /** aisle between adjacent pods */
  outerAisleM: number;
  containment: 'hot-aisle' | 'cold-aisle' | 'none';
  cduCatalogId: string;
  cdusPerPod: number | 'auto';
  cduRedundancy: string;
  scaleOutSwitchCatalogId: string;
  oversubscription: number;
  networkRacksPerPod: number | 'auto';
  // ── v2 (optional; the defaults reproduce the v0.1 reference deployment unit) ──
  /** rows per pod (2 = facing rows around a contained aisle, 1 = single row e.g. an RCU row). Default 2. */
  rowsPerPod?: 1 | 2;
  /** where the pod's network (leaf) racks sit in the row. Default 'row-end' (reference DU); 'row-center' = single-row vendor sample (estimate). */
  networkPlacement?: 'row-end' | 'row-center';
  /** CDU slot positions. Default 'row-start' (reference DU); 'row-ends' / 'ends+center' = single-row vendor sample shapes (estimate). */
  cduPlacement?: 'row-start' | 'row-ends' | 'ends+center';
  /** service racks (management at the row start, storage at the row end) per row end — single-row vendor sample (estimate). Default 0. */
  endServiceRacks?: number;
  /** RCU rows: racks per containment enclosure (2 or 4 in the vendor RCU row shape; estimate). A 0.1 m break separates enclosures. */
  enclosureRacks?: number;
  /** template limit for the compute row length (racks); validate.ts raises `layout-row-long` beyond it. Default 40. */
  maxRacksPerRow?: number;
  networkRackCatalogId?: string;
  storageRackCatalogId?: string;
  cpuRackCatalogId?: string;
  mgmtRackCatalogId?: string;
  /** air-side heat of a populated network rack (switches + optics), kW. Default 45 (estimate). */
  networkRackAirKW?: number;
  /**
   * Accelerator compute-slot racks per DU (e.g. Groq 3 LPX beside Vera Rubin NVL72 or NPU racks in a custom heterogeneous DU).
   * Placed inside the DU rows next to the network racks (row-end templates: between the compute racks and the network racks;
   * row-centre templates: left of the centre network block), split over the pod rows like the network racks. Tagged `…-ACCnn`
   * with `meta.computeSlot`. Absent / empty = homogeneous DU.
   */
  accelerators?: PodAccelerator[];
  /** autosize v2 2차: `cdusPerPod` is an exact count (manual cooling placement / gallery) instead of a minimum raised to the engine rule */
  cdusExact?: boolean;
}

/** One accelerator compute slot of a DU (resolved from the template's `computeSlots`). */
export interface PodAccelerator {
  slotId: string;
  catalogId: string;
  /** racks per DU (0 = slot off) */
  racksPerDu: number;
}

export interface ServicesRow {
  /** network-core racks (spines / cores / aggregation for every fabric); 'auto' = radix sizing */
  spineRacks: number | 'auto';
  /** autosize v2 2차: extra (mixed-role) network-core racks added by the engine check when central switches stay unplaced (e.g. a rack notched by a column) */
  extraNetworkRacks?: number;
  storageRacks: number;
  cpuRacks: number;
  mgmtRacks: number;
}

/** Aux-fabric switches the network engine will size (defaults: generic Ethernet classes, see DEFAULT_FABRICS). */
export interface FabricOptions {
  frontend?: { enabled: boolean; switchCatalogId: string; oversubscription: number };
  storage?: { enabled: boolean; switchCatalogId: string; oversubscription: number };
  oob?: { enabled: boolean; switchCatalogId: string };
}

export interface HallLayoutOptions {
  hall: Hall;
  pods: number;
  podIndexStart?: number;
  template: PodTemplate;
  services?: ServicesRow;
  crahCatalogId: string;
  crahs: number | 'auto';
  crahRedundancy: string;
  marginM: number;
  /** pods per deployment wave (for scheduling) */
  podsPerWave: number;
  // ── v2 ──
  /** axis the rows run along (default 'x') */
  orientation?: 'x' | 'y';
  /** pod columns across the row axis (default 1) */
  columns?: number;
  /** where the network-core rows go (default 'central-end') */
  spinePlacement?: SpinePlacement;
  corridors?: LayoutPolicy['corridors'];
  /** perimeter walls that host CRAHs (default W + E; N / S are added automatically when needed) */
  crahWalls?: Wall[];
  /** 'perimeter' (default) places units on the walls; 'per-pod' / 'in-row' append units to the pod rows (no thermal model); 'gallery-fan-wall' = perimeter on N/S */
  crahStrategy?: LayoutPolicy['crahStrategy'];
  fabrics?: FabricOptions;
  /** maximum length of a network-core / services row (default = pod area width) */
  maxCentralRowLengthM?: number;
  /** template id recorded in the result (for hall.layoutPolicy) */
  templateId?: string;
  // ── v2 2차 (T1) ──
  /** where hall-shared services go (default 'end-band'; layoutOptionsFromProject passes the growth default) */
  servicesZone?: ServicesZoneMode;
  /** network racks reserved for an inter-hall core (cluster zone hall only, networkRole 'inter-hall-core'); default 0 */
  interHallCoreRacks?: number;
  /** the hall belongs to a joined multi-hall cluster: its scale-out top tier doubles (k/2 uplinks per switch toward the super-spines) */
  joinedCluster?: boolean;
  /** mechanical-gallery CDUs instead of in-row slots (set from hall.coolingPlacement by generateHallLayout) */
  galleryCdus?: { wall: Wall; perPod: number | 'auto'; redundancy: string };
  /** geometry only: skip tray / busway polylines (orientation / column probes) */
  probe?: boolean;
  /** keep wall units at the walls (no pod-edge cooling line) — growHallToFit's intermediate sizes, where slack is transient */
  noCrahLine?: boolean;
}

export interface PodInfo {
  id: string;
  name: string;
  hallId: string;
  rect: Rect;
  waveId: string;
  /** what the pod holds (default 'compute'; the services block is 'services', the spine/core block 'network-core') */
  kind?: 'compute' | 'services' | 'network-core';
}

export interface HallLayout {
  equipment: EquipmentInstance[];
  containments: Containment[];
  pods: PodInfo[];
  /** minimum hall size needed for this layout */
  requiredWidth: number;
  requiredDepth: number;
  // ── v2 ──
  rows: RowGroup[];
  trays: CableTray[];
  busways: Busway[];
  /** layout-domain issues raised while generating (e.g. CRAHs that do not fit on any wall) */
  issues: Issue[];
  crah: { required: number; placed: number; walls: Wall[]; airKW: number };
  central: { networkCoreRacks: number; servicesRacks: number; rows: number; placement: SpinePlacement };
  grid: { columns: number; rows: number; rowLengthM: number; podPitchM: number };
  // ── v2 2차 (T1) ──
  /** reserve / expansion positions of the services zone (+ a separate-room partition) */
  reservations?: LayoutReservation[];
  /** services zone summary (rect = band / room / support-HAC envelope) */
  zone?: { mode: ServicesZoneMode; rect?: Rect; rows: number; positionsPerRow: number; racks: number; reservePositions: number; interHallCoreRacks: number };
}

/** International corridor defaults (TIA-942 / NVIDIA SuperPOD; DECISIONS-v2 #3): cold aisle 1.2, rear service 0.8 × 1.2, transport 2.4, egress 1.2 m. */
export const CORRIDOR_DEFAULTS: LayoutPolicy['corridors'] = { coldAisleM: 1.2, hotAisleM: 0.8 * 1.2 + 0.24, transportM: 2.4, egressM: 1.2 };

/** Offset between the pod area and a separate network room strip (spinePlacement 'separate-room'). */
export const SEPARATE_ROOM_OFFSET_M = 3;

/**
 * @deprecated vendor-sample pod (the pre-P4 reference deployment unit). Standard templates use generic class ids
 * (layout/templates/index.ts); the vendor instances live in layout/samples/platforms.ts.
 */
export const REF_POD_TEMPLATE: PodTemplate = VENDOR_RACKSCALE_POD;

/**
 * Aux-fabric switches when the caller passes none (stream D / P4, proposal NW-04): generic Ethernet classes, the same defaults
 * as engines/network.ts FABRIC_SWITCH (ethernet-400 → 51.2T 128 × 400G class; ethernet-1g → 48 × 1G management class).
 * Callers that store vendor switches pass them (layoutOptionsFromProject reads `project.network`; the vendor sample passes its own).
 */
const DEFAULT_FABRICS: Required<FabricOptions> = {
  frontend: { enabled: true, switchCatalogId: 'generic-roce-400', oversubscription: 2 },
  storage: { enabled: true, switchCatalogId: 'generic-roce-400', oversubscription: 1 },
  oob: { enabled: true, switchCatalogId: 'switch-oob-1g-48' },
};

const NETWORK_RACK_KW_CAPACITY = 35; // engines/network.ts RACK_KW_CAPACITY
const XCVR_KW = 0.015; // 800G optics ≈ 15 W per end (estimate)
const RCU_BREAK_M = 0.1;
const CRAH_GAP_M = 0.3;
/** Air-throw datum for row-end wall units (= grid.ts AIR_THROW_MAX_M['gallery-fan-wall'], design estimate, DECISIONS-v2-2 §C). */
export const AIR_THROW_DATUM_M = 18;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

type TemplateN = Required<Pick<PodTemplate, 'rowsPerPod' | 'networkPlacement' | 'cduPlacement' | 'endServiceRacks' | 'maxRacksPerRow' | 'networkRackCatalogId' | 'storageRackCatalogId' | 'cpuRackCatalogId' | 'mgmtRackCatalogId' | 'networkRackAirKW'>> & PodTemplate;

/** Fill template defaults. */
export function normalizeTemplate(t: PodTemplate): TemplateN {
  return {
    ...t,
    rowsPerPod: t.rowsPerPod ?? 2,
    networkPlacement: t.networkPlacement ?? 'row-end',
    cduPlacement: t.cduPlacement ?? 'row-start',
    endServiceRacks: t.endServiceRacks ?? 0,
    maxRacksPerRow: t.maxRacksPerRow ?? 40,
    networkRackCatalogId: t.networkRackCatalogId ?? 'network-rack-48u',
    storageRackCatalogId: t.storageRackCatalogId ?? 'storage-rack-afa',
    cpuRackCatalogId: t.cpuRackCatalogId ?? 'cpu-rack-2s-20',
    mgmtRackCatalogId: t.mgmtRackCatalogId ?? 'mgmt-rack-42u',
    networkRackAirKW: t.networkRackAirKW ?? 45,
  };
}

function place(
  out: EquipmentInstance[],
  hall: Hall,
  item: CatalogItem,
  tag: string,
  x: number,
  y: number,
  rotationDeg: EquipmentInstance['rotationDeg'],
  extra: Partial<EquipmentInstance> = {},
): EquipmentInstance {
  const e: EquipmentInstance = {
    id: `eq-${tag.toLowerCase()}`,
    catalogId: item.id,
    hallId: hall.id,
    tag,
    position: { x: round6(x), y: round6(y) },
    rotationDeg,
    blanking: true,
    ...extra,
  };
  out.push(e);
  return e;
}

// ───────────────────────────── switch / rack helpers ─────────────────────────────

/** Network racks needed for `n` switches of `sw` (RU and power limited, as engines/network.ts hostFit). */
export function networkRacksFor(sw: CatalogItem, n: number, rack: CatalogItem): number {
  return Math.ceil(rackFraction(sw, n, rack) - 1e-9);
}

/** Rack fraction one switch model occupies (RU and power limited, as engines/network.ts hostFit). */
function rackFraction(sw: CatalogItem, n: number, rack: CatalogItem): number {
  if (n <= 0) return 0;
  const ru = (n * (sw.switch?.rackUnits ?? 1)) / (rack.rackUnits ?? 42);
  const kw = (n * (sw.power?.nameplateKW ?? 0)) / NETWORK_RACK_KW_CAPACITY;
  return Math.max(ru, kw);
}

/** Aux-fabric leaf count for a set of racks (front-end / storage ports with breakout on the fabric switch). */
function auxLeaves(racks: readonly { item: CatalogItem; n: number }[], key: 'frontend' | 'storage', sw: CatalogItem, oversubscription: number): { leaves: number; ports: number } {
  const swGbps = sw.switch?.portGbps ?? 400;
  let ports = 0;
  for (const { item, n } of racks) {
    const c = item.compute;
    if (!c) continue;
    const p = key === 'frontend' ? c.frontendPorts : c.storagePorts;
    const g = key === 'frontend' ? c.frontendPortGbps : c.storagePortGbps;
    if (p <= 0 || g <= 0) continue;
    ports += n * p * breakoutFactor(g, swGbps);
  }
  const { downPerLeaf } = leafPortSplit(sw.switch?.ports ?? 64, oversubscription);
  return { leaves: ports > 0 ? Math.ceil(ports / downPerLeaf - 1e-9) : 0, ports };
}

function oobPorts(item: CatalogItem): number {
  return item.compute?.oobPorts ?? (item.category === 'mgmt-rack' ? 8 : ['cdu', 'crah', 'fan-wall', 'rpp', 'ups', 'chiller', 'dry-cooler'].includes(item.category) ? 1 : 0);
}

// ───────────────────────────── pod sizing ─────────────────────────────

export interface PodSizing {
  gpu: CatalogItem;
  cdu: CatalogItem;
  sw: CatalogItem;
  netRack: CatalogItem;
  racks: number;
  liquidKW: number;
  cdus: number;
  endpoints: number;
  leaves: number;
  leafRacks: number;
  /** aux (front-end / storage / OOB) leaf switches per pod */
  auxLeaves: { frontend: number; storage: number; oob: number };
  netRacks: number;
  /** nameplate kW of the pod's leaf switches (scale-out + aux) and their optics — air heat the cooling engine will count (estimate) */
  switchKW: number;
  cduSlotsPerRow: number;
  /**
   * autosize v2 2차: front-to-front rows (cold-aisle pods) whose CDU front service clearance is deeper than the inner aisle — row A keeps
   * its CDUs at the row start, row B at the row end, so no CDU faces another across the aisle (validate.ts space-clearance). Each row
   * reserves both CDU groups (empty positions stay free), so the rows stay aligned.
   */
  cduStagger: boolean;
  netSlotsPerRow: number;
  rowLength: number;
  podDepth: number;
  rowsPerPod: 1 | 2;
  endServiceRacks: number;
  t: TemplateN;
  /** §E2 accelerator compute-slot racks per pod (resolved items; slots whose catalog id is missing are dropped) */
  accelerators: { slotId: string; item: CatalogItem; perPod: number }[];
}

/** Sizing that decides how many floor positions each pod reserves. */
export function podSizing(template: PodTemplate, fabrics: FabricOptions = {}): PodSizing {
  const t = normalizeTemplate(template);
  const gpu = getCatalogItem(t.gpuRackCatalogId);
  const cdu = getCatalogItem(t.cduCatalogId);
  const sw = getCatalogItem(t.scaleOutSwitchCatalogId);
  const netRack = getCatalogItem(t.networkRackCatalogId);
  const fe = fabrics.frontend ?? DEFAULT_FABRICS.frontend;
  const st = fabrics.storage ?? DEFAULT_FABRICS.storage;
  const oob = fabrics.oob ?? DEFAULT_FABRICS.oob;
  const racks = t.racksPerRow * t.rowsPerPod;
  // §E2 accelerator compute-slot racks (in the DU rows, split over the rows like the network racks)
  const accelerators = (t.accelerators ?? [])
    .map((a) => ({ slotId: a.slotId, item: findCatalogItem(a.catalogId), perPod: Math.max(0, Math.round(a.racksPerDu)) }))
    .filter((a): a is { slotId: string; item: CatalogItem; perPod: number } => !!a.item && a.perPod > 0);
  const accWidthPerRow = accelerators.reduce((w, a) => w + Math.ceil(a.perPod / t.rowsPerPod) * a.item.dims.w, 0);
  const liquidKW = racks * liquidHeatKW(gpu) + accelerators.reduce((k, a) => k + a.perPod * liquidHeatKW(a.item), 0);
  // autosize v2 2차 (DECISIONS-v2-2 F): CDU count = the cooling engine's per-pod rule (engines/context.ts unitsFor: ⌈pod liquid kW ÷ CDU kW⌉
  // + redundancy) for every template. A template's fixed count is a minimum (row-end pairs), never a cap: a liquid-cooled primary
  // (for example, a DLC platform selected in an air-oriented custom DU with cdusPerPod 0) or a longer RCU row used to get fewer CDUs than validate.ts requires. Only an
  // explicit count (hall.coolingPlacement manual count or a gallery strip, `cdusExact`) is taken as given.
  const cduCap = cdu.capacity?.coolingKW ?? 1000;
  const cduRule = liquidKW > 0 && cduCap > 0 ? redundantCount(Math.ceil(liquidKW / cduCap - 1e-9), t.cduRedundancy) : 0;
  const cdus = t.cdusPerPod === 'auto' ? cduRule : t.cdusExact ? t.cdusPerPod : Math.max(t.cdusPerPod, cduRule);
  const endpoints = racks * (gpu.compute?.gpus ?? 0) * (gpu.compute?.scaleOutPortsPerGpu ?? 0) + accelerators.reduce((n, a) => n + a.perPod * (a.item.compute?.gpus ?? 0) * (a.item.compute?.scaleOutPortsPerGpu ?? 0), 0);
  const { leaves } = leafSwitchesFor(endpoints, sw, t.oversubscription, gpu);
  // aux leaves the engine places inside the pod (front-end / storage of the GPU racks and the row-end service racks, OOB of everything in the pod)
  const feSw = findCatalogItem(fe.switchCatalogId) ?? getCatalogItem(DEFAULT_FABRICS.frontend.switchCatalogId);
  const stSw = findCatalogItem(st.switchCatalogId) ?? getCatalogItem(DEFAULT_FABRICS.storage.switchCatalogId);
  const oobSw = findCatalogItem(oob.switchCatalogId) ?? getCatalogItem(DEFAULT_FABRICS.oob.switchCatalogId);
  const mgmtRack = getCatalogItem(t.mgmtRackCatalogId);
  const storageRack = getCatalogItem(t.storageRackCatalogId);
  const endSvc = t.endServiceRacks * t.rowsPerPod;
  const podRacks = [{ item: gpu, n: racks }, { item: mgmtRack, n: endSvc }, { item: storageRack, n: endSvc }, ...accelerators.map((a) => ({ item: a.item, n: a.perPod }))];
  const feLeaves = fe.enabled ? auxLeaves(podRacks, 'frontend', feSw, fe.oversubscription).leaves : 0;
  const stLeaves = st.enabled ? auxLeaves(podRacks, 'storage', stSw, st.oversubscription).leaves : 0;
  const oobEndpoints = podRacks.reduce((s, r) => s + r.n * oobPorts(r.item), 0) + cdus + leaves + feLeaves + stLeaves;
  const oobLeaves = oob.enabled && oobEndpoints > 0 ? Math.ceil(oobEndpoints / (oobSw.switch?.ports ?? 48) - 1e-9) : 0;
  const leafRacks = endpoints > 0 ? Math.ceil(leaves / switchesPerNetworkRack(sw, netRack)) : 0;
  const auxFraction = rackFraction(feSw, feLeaves, netRack) + rackFraction(stSw, stLeaves, netRack) + rackFraction(oobSw, oobLeaves, netRack);
  const netRacksAuto = endpoints > 0 ? Math.ceil(rackFraction(sw, leaves, netRack) + auxFraction - 1e-9) : Math.ceil(auxFraction - 1e-9);
  const netRacks = t.networkRacksPerPod === 'auto' ? Math.max(netRacksAuto, leafRacks + (auxFraction > 0 ? 1 : 0)) : t.networkRacksPerPod;
  const kwOf = (x: CatalogItem) => x.power?.nameplateKW ?? 0;
  const auxPorts = fe.enabled ? auxLeaves(podRacks, 'frontend', feSw, fe.oversubscription).ports : 0;
  const stPorts = st.enabled ? auxLeaves(podRacks, 'storage', stSw, st.oversubscription).ports : 0;
  const switchKW = leaves * kwOf(sw) + feLeaves * kwOf(feSw) + stLeaves * kwOf(stSw) + oobLeaves * kwOf(oobSw) + (endpoints + auxPorts + stPorts) * 2 * XCVR_KW;
  const cduSlotsPerRow = Math.ceil(cdus / t.rowsPerPod);
  const cduStagger = t.rowsPerPod === 2 && t.containment === 'cold-aisle' && cdus > 0 && (cdu.clearance?.front ?? 0) > t.innerAisleM + 1e-9;
  const netSlotsPerRow = Math.ceil(netRacks / t.rowsPerPod);
  // backlog T1a: enclosure breaks per contiguous rack run (the runs on either side of centre equipment), see enclosureGroups
  const encBreaks = (n: number) => Math.max(0, enclosureGroups(n, t.enclosureRacks ?? 0).length - 1);
  const enclosures = t.enclosureRacks && t.enclosureRacks > 0 ? encBreaks(Math.floor(t.racksPerRow / 2)) + encBreaks(t.racksPerRow - Math.floor(t.racksPerRow / 2)) : 0;
  const rowLength =
    cduSlotsPerRow * cdu.dims.w * (cduStagger ? 2 : 1) +
    t.racksPerRow * gpu.dims.w +
    accWidthPerRow +
    netSlotsPerRow * netRack.dims.w +
    t.endServiceRacks * (mgmtRack.dims.w + storageRack.dims.w) +
    Math.max(0, enclosures) * RCU_BREAK_M;
  const podDepth = t.rowsPerPod === 2 ? gpu.dims.d * 2 + t.innerAisleM : gpu.dims.d;
  return { gpu, cdu, sw, netRack, racks, liquidKW, cdus, endpoints, leaves, leafRacks, auxLeaves: { frontend: feLeaves, storage: stLeaves, oob: oobLeaves }, netRacks, switchKW: round6(switchKW), cduSlotsPerRow, cduStagger, netSlotsPerRow, rowLength, podDepth, rowsPerPod: t.rowsPerPod, endServiceRacks: t.endServiceRacks, t, accelerators };
}

// ───────────────────────────── central rack plan ─────────────────────────────

interface PlannedRack {
  item: CatalogItem;
  prefix: string;
  role?: EquipmentInstance['networkRole'];
  group: 'network-core' | 'services';
}

export interface CentralPlan {
  networkCore: PlannedRack[];
  services: PlannedRack[];
  detail: { scaleOut: { spines: number; cores: number; tiers: number; racks: number }; frontend: { switches: number; racks: number }; storage: { switches: number; racks: number }; oob: { switches: number; racks: number }; /** nameplate kW of every central switch + optics (estimate) */ switchKW: number };
}

/**
 * Racks the network engine needs outside the pods: scale-out spines + cores, front-end spines/cores + the
 * services pod's front-end leaves, storage spines/cores + storage leaves, OOB leaves for everything that is not
 * inside a pod (CRAHs, services racks, central switches). Same radix functions as engines/network.ts.
 */
export function planCentralRacks(s: PodSizing, pods: number, services: ServicesRow, fabrics: FabricOptions = {}, crahCount = 0, joinedCluster = false): CentralPlan {
  const t = s.t;
  const fe = fabrics.frontend ?? DEFAULT_FABRICS.frontend;
  const st = fabrics.storage ?? DEFAULT_FABRICS.storage;
  const oob = fabrics.oob ?? DEFAULT_FABRICS.oob;
  const feSw = findCatalogItem(fe.switchCatalogId) ?? getCatalogItem(DEFAULT_FABRICS.frontend.switchCatalogId);
  const stSw = findCatalogItem(st.switchCatalogId) ?? getCatalogItem(DEFAULT_FABRICS.storage.switchCatalogId);
  const oobSw = findCatalogItem(oob.switchCatalogId) ?? getCatalogItem(DEFAULT_FABRICS.oob.switchCatalogId);
  const storage = getCatalogItem(t.storageRackCatalogId);
  const cpu = getCatalogItem(t.cpuRackCatalogId);
  const mgmt = getCatalogItem(t.mgmtRackCatalogId);
  const netRack = s.netRack;

  // scale-out spines / cores (auto tiers)
  const so = s.endpoints > 0 ? spineSwitchesFor(s.endpoints, pods, s.sw, t.oversubscription, s.gpu, joinedCluster) : { spines: 0, cores: 0, tiers: 1 as const, leaves: 0 };
  const soRacks = Math.ceil(rackFraction(s.sw, so.spines + so.cores, netRack) - 1e-9);

  const svcRacks = [{ item: storage, n: services.storageRacks }, { item: cpu, n: services.cpuRacks }, { item: mgmt, n: services.mgmtRacks }];
  const podRacks = [{ item: s.gpu, n: s.racks }, { item: mgmt, n: s.endServiceRacks * s.rowsPerPod }, { item: storage, n: s.endServiceRacks * s.rowsPerPod }, ...s.accelerators.map((a) => ({ item: a.item, n: a.perPod }))];

  // OOB endpoints (estimate of the engine's count: BMC ports + facility + one port per switch) → front-end extra spine ports
  const feSvc = fe.enabled ? auxLeaves(svcRacks, 'frontend', feSw, fe.oversubscription) : { leaves: 0, ports: 0 };
  const fePod = fe.enabled ? auxLeaves(podRacks, 'frontend', feSw, fe.oversubscription) : { leaves: 0, ports: 0 };
  const stSvc = st.enabled ? auxLeaves(svcRacks, 'storage', stSw, st.oversubscription) : { leaves: 0, ports: 0 };
  const stPod = st.enabled ? auxLeaves(podRacks, 'storage', stSw, st.oversubscription) : { leaves: 0, ports: 0 };
  const oobBase = pods * (podRacks.reduce((a, r) => a + r.n * oobPorts(r.item), 0) + s.cdus) + svcRacks.reduce((a, r) => a + r.n * oobPorts(r.item), 0) + crahCount;
  const switchesEst = so.leaves + so.spines + so.cores + pods * (fePod.leaves + stPod.leaves) + feSvc.leaves + stSvc.leaves + 8;
  const oobLeavesEst = oob.enabled ? Math.ceil((oobBase + switchesEst) / (oobSw.switch?.ports ?? 48)) : 0;
  const feGbps = feSw.switch?.portGbps ?? 400;
  const extraSpinePorts = Math.ceil((oobLeavesEst * 2 * 100) / feGbps);

  const upper = (sw: CatalogItem, portsByPod: number[], os: number, extra = 0) =>
    sizeFabricFromPodPorts({ switchPortsByPod: portsByPod, rails: 1, k: sw.switch?.ports ?? 64, oversubscription: os, extraSpinePorts: extra, tiers: 'auto' });
  const feUp = fe.enabled ? upper(feSw, [...Array.from({ length: pods }, () => fePod.ports), feSvc.ports], fe.oversubscription, extraSpinePorts) : { spines: 0, cores: 0 };
  const stUp = st.enabled ? upper(stSw, [...Array.from({ length: pods }, () => stPod.ports), stSvc.ports], st.oversubscription) : { spines: 0, cores: 0 };
  const feSwitches = feUp.spines + feUp.cores + feSvc.leaves;
  const stSwitches = stUp.spines + stUp.cores + stSvc.leaves;
  // OOB leaves outside the pods: services racks + CRAHs + every central switch
  const oobCentralEndpoints = svcRacks.reduce((a, r) => a + r.n * oobPorts(r.item), 0) + crahCount + so.spines + so.cores + feSwitches + stSwitches;
  const oobSwitches = oob.enabled && oobCentralEndpoints > 0 ? Math.ceil(oobCentralEndpoints / (oobSw.switch?.ports ?? 48) - 1e-9) + 1 : 0;
  const feRacks = Math.ceil(rackFraction(feSw, feSwitches, netRack) - 1e-9);
  const stRacks = Math.ceil(rackFraction(stSw, stSwitches, netRack) - 1e-9);
  const oobRacks = Math.ceil(rackFraction(oobSw, oobSwitches, netRack) - 1e-9);

  const networkCore: PlannedRack[] = [];
  const addNet = (n: number, prefix: string, role: EquipmentInstance['networkRole']) => {
    for (let i = 0; i < n; i++) networkCore.push({ item: netRack, prefix, role, group: 'network-core' });
  };
  if (services.spineRacks === 'auto') {
    // spines first (the engine fills spine/core-role racks first, biggest switches first), then aggregation racks
    const spineRacks = so.cores > 0 ? Math.ceil(rackFraction(s.sw, so.spines, netRack) - 1e-9) : soRacks;
    addNet(spineRacks, 'SPN', 'scale-out-spine');
    addNet(Math.max(0, soRacks - spineRacks), 'COR', 'scale-out-core');
    addNet(feRacks, 'FEN', 'frontend');
    addNet(stRacks, 'STN', 'storage');
    addNet(oobRacks, 'OOB', 'oob');
    addNet(Math.max(0, Math.round(services.extraNetworkRacks ?? 0)), 'NET', undefined);
  } else {
    addNet(services.spineRacks, 'SPN', 'scale-out-spine');
  }
  const servicesList: PlannedRack[] = [];
  for (let i = 0; i < services.storageRacks; i++) servicesList.push({ item: storage, prefix: 'STO', group: 'services' });
  for (let i = 0; i < services.cpuRacks; i++) servicesList.push({ item: cpu, prefix: 'CPU', group: 'services' });
  for (let i = 0; i < services.mgmtRacks; i++) servicesList.push({ item: mgmt, prefix: 'MGT', group: 'services' });
  return {
    networkCore,
    services: servicesList,
    detail: {
      scaleOut: { spines: so.spines, cores: so.cores, tiers: so.tiers, racks: soRacks },
      frontend: { switches: feSwitches, racks: feRacks },
      storage: { switches: stSwitches, racks: stRacks },
      oob: { switches: oobSwitches, racks: oobRacks },
      switchKW: round6((so.spines + so.cores) * (s.sw.power?.nameplateKW ?? 0) + feSwitches * (feSw.power?.nameplateKW ?? 0) + stSwitches * (stSw.power?.nameplateKW ?? 0) + oobSwitches * (oobSw.power?.nameplateKW ?? 0) + (so.spines + so.cores) * (s.sw.switch?.ports ?? 64) * XCVR_KW),
    },
  };
}

// ───────────────────────────── generation ─────────────────────────────

type Slot = { kind: 'cdu' | 'gpu' | 'acc' | 'net' | 'svc' | 'gap' | 'spine' | 'crah'; w: number; item?: CatalogItem; role?: EquipmentInstance['networkRole']; prefix?: string; slotId?: string; /** rack containment unit number within the row (enclosure templates) */ enc?: number };

/** Slot sequence of one pod row (left → right). */
function rowSlots(s: PodSizing, rowIndex: number, extras: { spineRacks: number; crahs: number; crahItem?: CatalogItem; crahMode: 'none' | 'row-end' | 'row-center' }): Slot[] {
  const t = s.t;
  const cdusHere = t.rowsPerPod === 2 ? (rowIndex === 0 ? Math.ceil(s.cdus / 2) : Math.floor(s.cdus / 2)) : s.cdus;
  const netHere = t.rowsPerPod === 2 ? (rowIndex === 0 ? Math.ceil(s.netRacks / 2) : Math.floor(s.netRacks / 2)) : s.netRacks;
  const cduSlot = (present: boolean): Slot => ({ kind: 'cdu', w: s.cdu.dims.w, item: present ? s.cdu : undefined });
  const gpuSlot = (): Slot => ({ kind: 'gpu', w: s.gpu.dims.w, item: s.gpu });
  const netSlot = (present: boolean, idx: number): Slot => ({ kind: 'net', w: s.netRack.dims.w, item: present ? s.netRack : undefined, role: idx < s.leafRacks ? 'scale-out-leaf' : 'frontend' });
  const mgmt = getCatalogItem(t.mgmtRackCatalogId);
  const storage = getCatalogItem(t.storageRackCatalogId);
  const slots: Slot[] = [];
  // CDU slots: split between the row ends when the template asks for it
  const cduSlots = s.cduSlotsPerRow;
  const stagger = s.cduStagger;
  const cduStart = stagger ? cduSlots : t.cduPlacement === 'row-start' ? cduSlots : t.cduPlacement === 'row-ends' ? Math.ceil(cduSlots / 2) : Math.ceil(cduSlots / 3);
  const cduCenter = !stagger && t.cduPlacement === 'ends+center' ? Math.ceil((cduSlots - cduStart) / 2) : 0;
  const cduEnd = stagger ? cduSlots : cduSlots - cduStart - cduCenter;
  let cduIdx = 0;
  let cduGroup = 0;
  const pushCdus = (n: number) => {
    // staggered cold-aisle pods: row A fills the first (row-start) group, row B the last (row-end) group
    const group = cduGroup++;
    const present = (k: number) => (stagger ? (rowIndex === 0 ? group === 0 : group === 2) && k < cdusHere : cduIdx++ < cdusHere);
    for (let c = 0; c < n; c++) slots.push(cduSlot(present(c)));
  };
  pushCdus(cduStart);
  for (let i = 0; i < t.endServiceRacks; i++) slots.push({ kind: 'svc', w: mgmt.dims.w, item: mgmt, prefix: 'MGT' });
  // network racks: at the row end (reference DU) or split around centre equipment (single-row vendor sample)
  const netIdxBase = t.rowsPerPod === 2 && rowIndex === 1 ? Math.ceil(s.netRacks / 2) : 0;
  let netIdx = 0;
  const pushNets = (n: number) => {
    for (let k = 0; k < n; k++) {
      const present = netIdx < netHere;
      slots.push(netSlot(present, netIdxBase + netIdx));
      netIdx++;
    }
  };
  const half = Math.floor(t.racksPerRow / 2);
  // §E2 accelerator compute-slot racks: ceil(n / rows) positions per row (row A takes the odd one), next to the network racks
  const accs = () => {
    for (const a of s.accelerators) {
      const positions = Math.ceil(a.perPod / t.rowsPerPod);
      const present = t.rowsPerPod === 2 ? (rowIndex === 0 ? Math.ceil(a.perPod / 2) : Math.floor(a.perPod / 2)) : a.perPod;
      for (let k = 0; k < positions; k++) slots.push({ kind: 'acc', w: a.item.dims.w, item: k < present ? a.item : undefined, slotId: a.slotId });
    }
  };
  // backlog T1a: enclosures are grouped per contiguous rack run (never across centre equipment), 2–enclosureRacks racks each
  // (enclosureGroups: 8 → 4 + 4, 10 → 4 + 4 + 2, 7 → 4 + 3, 5 → 3 + 2). The old modulo count ran across the network racks, so one RCU tag
  // spanned both sides and a remainder of 1 made a single-rack enclosure
  let encNo = 0;
  const gpus = (n: number, _offset: number) => {
    if (!(t.enclosureRacks && t.enclosureRacks > 0)) {
      for (let r = 0; r < n; r++) slots.push(gpuSlot());
      return;
    }
    enclosureGroups(n, t.enclosureRacks).forEach((size, gi) => {
      if (gi > 0) slots.push({ kind: 'gap', w: RCU_BREAK_M });
      encNo++;
      for (let r = 0; r < size; r++) slots.push({ ...gpuSlot(), enc: encNo });
    });
  };
  if (t.networkPlacement === 'row-center') {
    gpus(half, 0);
    accs();
    pushNets(Math.ceil(s.netSlotsPerRow / 2));
    if (extras.crahMode === 'row-center' && extras.crahItem) for (let k = 0; k < extras.crahs; k++) slots.push({ kind: 'crah', w: extras.crahItem.dims.w, item: extras.crahItem });
    pushCdus(cduCenter);
    pushNets(s.netSlotsPerRow - Math.ceil(s.netSlotsPerRow / 2));
    gpus(t.racksPerRow - half, half);
  } else {
    gpus(half, 0);
    if (extras.crahMode === 'row-center' && extras.crahItem) for (let k = 0; k < extras.crahs; k++) slots.push({ kind: 'crah', w: extras.crahItem.dims.w, item: extras.crahItem });
    pushCdus(cduCenter);
    gpus(t.racksPerRow - half, half);
    accs();
    pushNets(s.netSlotsPerRow);
  }
  for (let k = 0; k < extras.spineRacks; k++) slots.push({ kind: 'spine', w: s.netRack.dims.w, item: s.netRack, role: 'scale-out-spine' });
  for (let i = 0; i < t.endServiceRacks; i++) slots.push({ kind: 'svc', w: storage.dims.w, item: storage, prefix: 'STO' });
  pushCdus(cduEnd);
  if (extras.crahMode === 'row-end' && extras.crahItem) for (let k = 0; k < extras.crahs; k++) slots.push({ kind: 'crah', w: extras.crahItem.dims.w, item: extras.crahItem });
  return slots;
}

interface BlockRow {
  y: number;
  rot: EquipmentInstance['rotationDeg'];
  items: PlannedRack[];
}

/**
 * Wrap planned racks into rows no longer than `maxLen`. Rows alternate facing so every aisle is either front-to-front
 * (cold, `outerAisle`) or rear-to-rear (hot, `innerAisle`); `parity` 0 = the first row faces −Y (rot 180), which is what
 * must follow a pod whose last row faces +Y. `nextParity` continues the alternation into the next block.
 */
function wrapBlock(items: readonly PlannedRack[], maxLen: number, yStart: number, innerAisle: number, outerAisle: number, parity = 0): { rows: BlockRow[]; yEnd: number; depth: number; nextParity: 0 | 1; /** aisle width added after the last row (hot when it faces +Y with its rear, else cold) */ trailing: number } {
  const rows: PlannedRack[][] = [];
  let cur: PlannedRack[] = [];
  let len = 0;
  for (const it of items) {
    if (cur.length > 0 && len + it.item.dims.w > maxLen + 1e-9) {
      rows.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(it);
    len += it.item.dims.w;
  }
  if (cur.length) rows.push(cur);
  const out: BlockRow[] = [];
  let y = yStart;
  let trailing = outerAisle;
  for (let i = 0; i < rows.length; i++) {
    const d = Math.max(...rows[i].map((r) => r.item.dims.d));
    const facingMinus = (i + parity) % 2 === 0; // rot 180: front −Y, rear +Y
    out.push({ y: y + d / 2, rot: facingMinus ? 180 : 0, items: rows[i] });
    y += d;
    // after a rear-facing(+Y) row the next row's rear meets it → hot aisle; otherwise fronts meet → cold aisle
    trailing = facingMinus ? innerAisle : outerAisle;
    y += trailing;
  }
  return { rows: out, yEnd: y, depth: rows.length ? y - trailing - yStart : 0, nextParity: ((parity + rows.length) % 2) as 0 | 1, trailing };
}

function wallAxis(w: Wall): 'x' | 'y' {
  return w === 'W' || w === 'E' ? 'y' : 'x';
}

const WALL_T: Record<Wall, Wall> = { W: 'S', E: 'N', N: 'E', S: 'W' };

/**
 * Apply `hall.coolingPlacement` (DECISIONS-v2-2 F8) to the generator options: CDU count / placement / redundancy on the pod
 * template ('gallery' removes the in-row CDU slots and places the units in a gallery strip), CRAH count / strategy / walls.
 * Absent → the options are returned unchanged (templates keep their own CDU slots).
 */
export function resolveCoolingPlacementOptions(opts: HallLayoutOptions): HallLayoutOptions {
  const cp = opts.hall.coolingPlacement;
  if (!cp) return opts;
  const { coolingPlacement: _cp, ...hall } = opts.hall;
  void _cp;
  const rowEnd: Wall[] = (opts.orientation ?? 'x') === 'x' ? ['W', 'E'] : ['S', 'N'];
  const gallery = cp.cduPlacement === 'gallery';
  const crahWalls = (cp.crahWalls as Wall[] | undefined) ?? opts.crahWalls;
  const wall: Wall = (cp.cduGalleryWall as Wall | undefined) ?? (crahWalls ?? []).find((w) => rowEnd.includes(w)) ?? rowEnd[0];
  const redundancy = cp.cduRedundancy ?? opts.template.cduRedundancy;
  return {
    ...opts,
    hall,
    template: { ...opts.template, cdusPerPod: gallery ? 0 : cp.cduPerPod, cdusExact: gallery || cp.cduPerPod !== 'auto', cduPlacement: gallery ? opts.template.cduPlacement : cp.cduPlacement === 'ends-center' ? 'ends+center' : 'row-ends', cduRedundancy: redundancy },
    crahs: cp.crahCount,
    crahStrategy: cp.crahStrategy,
    crahWalls,
    crahRedundancy: cp.crahRedundancy ?? opts.crahRedundancy,
    galleryCdus: gallery ? { wall, perPod: cp.cduPerPod, redundancy } : undefined,
  };
}

export function generateHallLayout(input: HallLayoutOptions): HallLayout {
  const opts = resolveCoolingPlacementOptions(input);
  if ((opts.orientation ?? 'x') === 'y') {
    const h = opts.hall;
    const swapped: Hall = { ...h, width: h.depth, depth: h.width, keepouts: h.keepouts.map((k) => ({ ...k, rect: transposeRect(k.rect) })) };
    const out = transposeLayout(generateX({ ...opts, hall: swapped, orientation: 'x', crahWalls: opts.crahWalls?.map((w) => WALL_T[w]), galleryCdus: opts.galleryCdus ? { ...opts.galleryCdus, wall: WALL_T[opts.galleryCdus.wall] } : undefined }));
    out.crah.walls = out.crah.walls.map((w) => WALL_T[w]);
    return out;
  }
  return generateX(opts);
}

function generateX(opts: HallLayoutOptions): HallLayout {
  const { hall, marginM } = opts;
  const s = podSizing(opts.template, opts.fabrics);
  const crah = getCatalogItem(opts.crahCatalogId);
  const strategy = opts.crahStrategy ?? 'perimeter';
  // gallery fan walls and perimeter CRAHs sit on the row-end walls (W/E in the x frame): airflow parallel to the rows (TIA-942-B Annex C, r2-layout.md §2.1)
  const requested: Wall[] = [...(opts.crahWalls ?? ['W', 'E'])];
  let walls: Wall[] = requested.length ? requested : ['W', 'E'];
  let result = build(opts, s, crah, walls, 0);
  for (let i = 0; i < 2 && result.crah.placed < result.crah.required && strategy !== 'per-pod' && strategy !== 'in-row'; i++) {
    const next: Wall | undefined = (['N', 'S', 'W', 'E'] as Wall[]).find((w) => !walls.includes(w));
    if (!next) break;
    walls = [...walls, next];
    result = build(opts, s, crah, walls, 0);
  }
  // perimeter exhausted on all four walls: put the remaining units at the pod row ends (per-pod fallback) rather than dropping them
  const podRowCount = Math.max(0, Math.floor(opts.pods)) * s.rowsPerPod;
  if (result.crah.placed < result.crah.required && (strategy === 'perimeter' || strategy === 'gallery-fan-wall') && podRowCount > 0) {
    const extra = Math.ceil((result.crah.required - result.crah.placed) / podRowCount);
    const withRowEnd = build(opts, s, crah, walls, extra);
    if (withRowEnd.crah.placed > result.crah.placed) {
      result = withRowEnd;
      result.issues.push({
        id: `layout-crah-row-end-${hall.id}`,
        severity: 'info',
        domain: 'layout',
        message: `${hall.name}: 둘레 벽(${walls.join('/')})에 CRAH를 다 둘 수 없어 열 끝에 열당 ${extra}대를 추가 배치했습니다 (열 길이 +${(extra * crah.dims.w).toFixed(2)} m).`,
        messageEn: `${hall.name}: the perimeter walls (${walls.join('/')}) cannot hold every CRAH, so ${extra} unit(s) per row were added at the row ends (row length +${(extra * crah.dims.w).toFixed(2)} m).`,
        suggestion: '홀 폭·깊이를 늘리면 열 끝 유닛 없이 둘레 벽에 모두 배치됩니다.',
        suggestionEn: 'Enlarge the hall width / depth to place every unit on the perimeter walls without row-end units.',
        refs: [hall.id],
      });
    }
  }
  if (result.crah.placed < result.crah.required) {
    result.issues.push({
      id: `layout-crah-short-${hall.id}`,
      severity: 'error',
      domain: 'layout',
      message: `${hall.name}: 필요한 CRAH ${result.crah.required}대 중 ${result.crah.placed}대만 둘레 벽(${walls.join('/')})에 배치할 수 있습니다 (벽 길이 부족).`,
      refs: [hall.id],
      suggestion: '홀 폭·깊이를 늘리거나, 용량이 큰 CRAH 모델 또는 in-row / per-pod 냉각 전략을 선택하세요.',
      messageEn: `${hall.name}: only ${result.crah.placed} of the ${result.crah.required} required CRAH units fit on the perimeter walls (${walls.join('/')}) — the walls are too short.`,
      suggestionEn: 'Enlarge the hall width / depth, or choose a larger CRAH model or an in-row / per-pod cooling strategy.',
    });
  }
  // backlog T1a (qa-autosize v2 2차 §3.3): the written crahWalls must list every wall that holds a wall unit. A wall unit (no row) belongs to
  // the wall it faces (W 270°, E 90°, S 0°, N 180° — the rule engines/powerPaths.ts occupiedHallWalls reads), so policy walls and placed units agree
  if (strategy === 'perimeter' || strategy === 'gallery-fan-wall') {
    const faced: Record<number, Wall> = { 0: 'S', 90: 'E', 180: 'N', 270: 'W' };
    for (const e of result.equipment) {
      if (e.rowId) continue;
      const cat = findCatalogItem(e.catalogId)?.category;
      if (cat !== 'crah' && cat !== 'fan-wall') continue;
      const w = faced[e.rotationDeg];
      if (w && !result.crah.walls.includes(w)) result.crah.walls.push(w);
    }
  }
  if ((strategy === 'per-pod' || strategy === 'in-row') && result.crah.placed > 0) {
    const issue = rowUnitOverheadIssue(hall, crah, rackHeightOf(result.equipment), strategy);
    if (issue) result.issues.push(issue);
  }
  return result;
}

/** Tallest row rack (dims height) among `equipment`; DEFAULT_RACK_HEIGHT_M when there is none. */
export function rackHeightOf(equipment: readonly EquipmentInstance[]): number {
  let h = 0;
  for (const e of equipment) {
    const it = findCatalogItem(e.catalogId);
    if (it && RACK_CATEGORIES_FOR_ROWS.has(it.category)) h = Math.max(h, it.dims.h);
  }
  return h > 0 ? h : DEFAULT_RACK_HEIGHT_M;
}

/**
 * Backlog finish (qa-backlog-geometry.md open item 1): the catalog has no in-row air unit, so per-pod / in-row placement puts a room air
 * unit (≈ 3.4 m) into the rows, under the busway, the T1 row tray, the tier trays and the TCS pipes. Warning when the unit is taller than
 * the lowest overhead service of the hall's resolved verticals (busway bottom or tray deck). Placement is not refused: the unit class is a
 * catalog gap, recorded as open.
 */
export function rowUnitOverheadIssue(hall: Hall, unit: CatalogItem, rackH: number, strategy: 'per-pod' | 'in-row'): Issue | null {
  const lows = resolveVerticals(hall, rackH)
    .tiers.filter((t) => t.kind === 'busway' || t.kind === 'tray')
    .map((t) => (t.kind === 'tray' ? t.z : t.z - (t.heightM ?? 0) / 2));
  if (!lows.length) return null;
  const bottom = Math.min(...lows);
  if (unit.dims.h <= bottom + 1e-6) return null;
  return {
    id: `layout-row-unit-overhead-${hall.id}`,
    severity: 'warning',
    domain: 'layout',
    message: `${hall.name}: ${strategy} 배치의 공조 유닛 높이 ${unit.dims.h.toFixed(2)} m가 머리 위 설비의 가장 낮은 높이 ${bottom.toFixed(2)} m(버스웨이 하단 또는 케이블 트레이)보다 높아 열 안에서 버스웨이·트레이·배관과 간섭합니다. 카탈로그에 열 내 설치형(in-row) 공조 유닛이 없습니다.`,
    messageEn: `${hall.name}: the ${strategy} air unit is ${unit.dims.h.toFixed(2)} m tall, above the lowest overhead service at ${bottom.toFixed(2)} m (busway bottom or cable-tray deck), so inside the rows it clashes with the busway, trays and pipes. The catalog has no in-row air unit.`,
    refs: [hall.id],
    suggestion: '둘레 CRAH 또는 갤러리 팬월 배치를 쓰거나, 유닛 위로 지나가도록 홀의 머리 위 설비 높이를 올리세요.',
    suggestionEn: 'Use perimeter CRAHs or a gallery fan wall, or raise the hall\'s overhead service levels above the unit.',
  };
}

type Home = 'room' | 'center' | 'end' | 'pods' | 'su';

/** Service depth in front of in-hall mechanical-gallery CDUs (r2-layout.md §3.4: 1.2 m on the service side, TIA-942-B aisle proxy — estimate). */
export const GALLERY_SERVICE_M = 1.2;

/**
 * Rack containment unit sizes for one contiguous run of `n` racks (backlog T1a, rcu-row "2–4 racks per enclosure"): full enclosures of `max`,
 * the remainder as its own enclosure when it has at least 2 racks, otherwise the last full enclosure and the single rack are split into two
 * (4 + 1 → 3 + 2). Enclosures of 1 only when the run itself is 1 rack (or `max` < 3).
 */
export function enclosureGroups(n: number, max: number): number[] {
  const k = Math.max(1, Math.floor(max));
  const N = Math.max(0, Math.floor(n));
  if (N === 0) return [];
  if (N <= k) return [N];
  const q = Math.floor(N / k);
  const r = N % k;
  const full = (m: number) => Array.from({ length: m }, () => k);
  if (r === 0) return full(q);
  if (r >= 2 || k < 3) return [...full(q), r];
  const rest = k + r;
  return [...full(q - 1), Math.ceil(rest / 2), Math.floor(rest / 2)];
}

/** Row letters a, b, …, z, aa, ab, … (the first 26 match the v2 1차 ids). */
export function rowLetters(n: number): string {
  return n < 26 ? String.fromCharCode(97 + n) : rowLetters(Math.floor(n / 26) - 1) + String.fromCharCode(97 + (n % 26));
}

function build(opts: HallLayoutOptions, s: PodSizing, crah: CatalogItem, walls: Wall[], rowEndCrahs = 0): HallLayout {
  const { hall, marginM } = opts;
  const t = s.t;
  const corridors = opts.corridors ?? CORRIDOR_DEFAULTS;
  const placement: SpinePlacement = opts.spinePlacement ?? 'central-end';
  const strategy = opts.crahStrategy ?? 'perimeter';
  const perimeter = strategy === 'perimeter' || strategy === 'gallery-fan-wall';
  const equipment: EquipmentInstance[] = [];
  const containments: Containment[] = [];
  const pods: PodInfo[] = [];
  const rows: RowGroup[] = [];
  const issues: Issue[] = [];
  const reservations: LayoutReservation[] = [];
  const start = opts.podIndexStart ?? 1;
  const nPods = Math.max(0, Math.floor(opts.pods));
  if (s.rowsPerPod === 1 && t.containment !== 'none') {
    issues.push({
      id: `layout-containment-single-row-${hall.id}`,
      severity: 'warning',
      domain: 'layout',
      message: `${hall.name}: 단일 열 구성에는 ${t.containment} 컨테인먼트를 만들 맞은편 열이 없어 enclosure를 생성하지 않았습니다.`,
      messageEn: `${hall.name}: no ${t.containment} enclosure was generated because a single-row unit has no opposing rack row.`,
      suggestion: '컨테인먼트를 사용하려면 2열 구성을 선택하고, 단일 열을 유지하려면 컨테인먼트를 없음으로 설정하세요.',
      suggestionEn: 'Choose a two-row unit for aisle containment, or set containment to none for a single row.',
      refs: [hall.id],
    });
  }
  const C = Math.max(1, Math.floor(opts.columns ?? 1));
  const R = Math.ceil(nPods / C);
  const netRack = s.netRack;
  const ihc = Math.max(0, Math.floor(opts.interHallCoreRacks ?? 0));

  // ── services zone mode (DECISIONS-v2-2 F3b, r2-layout.md §1.3) ──
  let zoneMode: ServicesZoneMode = opts.servicesZone ?? 'end-band';
  if (zoneMode === 'support-hac' && (s.rowsPerPod !== 2 || t.containment === 'cold-aisle' || nPods === 0)) {
    if (opts.services && nPods > 0)
      issues.push({
        id: `layout-zone-support-fallback-${hall.id}`,
        severity: 'info',
        domain: 'layout',
        message: `${hall.name}: 서포트 HAC 구역은 2열 hot-aisle 포드에서만 만들 수 있어 서비스 랙을 끝 띠(end band)에 배치했습니다.`,
        messageEn: `${hall.name}: a support-HAC zone needs two-row hot-aisle pods; the services racks were placed in an end band instead.`,
        refs: [hall.id],
      });
    zoneMode = 'end-band';
  }

  // ── CRAH count (cooling engine rule: heat and airflow, redundancy) ──
  const services = opts.services;
  const plan0 = services ? planCentralRacks(s, nPods, services, opts.fabrics, 0, !!opts.joinedCluster) : { networkCore: [], services: [], detail: undefined };
  let airKW = 0;
  let airFlow = 0;
  const addAir = (item: CatalogItem, n: number) => {
    if (n <= 0) return;
    airKW += n * airHeatKW(item);
    airFlow += n * (item.cooling?.airflowM3s ?? 0);
  };
  const mgmt = getCatalogItem(t.mgmtRackCatalogId);
  const storage = getCatalogItem(t.storageRackCatalogId);
  addAir(s.gpu, nPods * s.racks);
  for (const a of s.accelerators) addAir(a.item, nPods * a.perPod);
  addAir(s.cdu, nPods * s.cdus);
  addAir(mgmt, nPods * s.endServiceRacks * s.rowsPerPod);
  addAir(storage, nPods * s.endServiceRacks * s.rowsPerPod);
  for (const r of plan0.services) addAir(r.item, 1);
  // network racks: the flat per-rack figure or the switch nameplate + optics the cooling engine will count, whichever is larger
  const netRackCount = nPods * s.netRacks + plan0.networkCore.length + ihc;
  const switchKW = nPods * s.switchKW + (plan0.detail?.switchKW ?? 0);
  airKW += Math.max(netRackCount * t.networkRackAirKW, switchKW);
  airFlow += netRackCount * 2.5; // ≈ 8 switches × 0.28 m³/s per rack (estimate)
  const unitKW = crah.capacity?.coolingKW ?? 100;
  const unitFlow = crah.capacity?.airflowM3s ?? 0;
  const nHeat = Math.ceil(airKW / unitKW - 1e-9);
  const nFlow = unitFlow > 0 ? Math.ceil((airFlow * 1.1) / unitFlow - 1e-9) : 0;
  const crahCount = opts.crahs === 'auto' ? (airKW > 0 ? redundantCount(Math.max(nHeat, nFlow), opts.crahRedundancy) : 0) : opts.crahs;
  const plan = services ? planCentralRacks(s, nPods, services, opts.fabrics, crahCount, !!opts.joinedCluster) : plan0;

  // ── zones ──
  const gallery = opts.galleryCdus;
  const gw = gallery?.wall;
  const gd = gw ? s.cdu.dims.d + GALLERY_SERVICE_M : 0;
  const crahZone = crah.dims.d + crah.clearance.front + 1.5;
  const xZone = perimeter && walls.some((w) => w === 'W' || w === 'E') ? crahZone : corridors.egressM;
  const yZone = perimeter && walls.some((w) => w === 'N' || w === 'S') ? crahZone : 0;
  // fix v2 2차 (QA): a hall wider than the layout used to pin the pod area to the W wall, so E-wall units stood tens of metres from the
  // racks — centre the pod area along the row axis (the slack is split between both row-end zones; required size unchanged)
  const areaW0 = C * (s.rowLength + (placement === 'distributed' && nPods * s.rowsPerPod > 0 && (plan.networkCore.length + ihc) > 0 ? Math.ceil(Math.ceil((plan.networkCore.length + ihc) / nPods) / s.rowsPerPod) * netRack.dims.w : 0) + (!perimeter && nPods * s.rowsPerPod > 0 ? Math.ceil(crahCount / (nPods * s.rowsPerPod)) : rowEndCrahs) * crah.dims.w) + (C - 1) * corridors.transportM;
  const needW0 = marginM + xZone + (gw === 'W' ? gd : 0) + areaW0 + xZone + marginM + (gw === 'E' ? gd : 0);
  const centreX = !opts.probe && hall.width > needW0 + 1e-6 ? round6((hall.width - needW0) / 2) : 0;
  const x0 = marginM + xZone + (gw === 'W' ? gd : 0) + centreX;

  const y0 = marginM + Math.max(yZone, t.outerAisleM) + (gw === 'S' ? gd : 0);

  // inter-hall core racks (cluster scope, DECISIONS-v2-2 F2) travel with the hall's network core
  const coreAll: PlannedRack[] = [...plan.networkCore, ...Array.from({ length: ihc }, (): PlannedRack => ({ item: netRack, prefix: 'IHC', role: 'inter-hall-core', group: 'network-core' }))];

  // distributed spines: network-core racks appended to the pod rows
  const podRows = nPods * s.rowsPerPod;
  const distributed = placement === 'distributed' && podRows > 0 && coreAll.length > 0;
  // spine racks are spread over the compute pods (every pod hosts ≥ 1 when there are enough racks, DECISIONS-v2 #1), then over
  // the pod's rows; the row length reserves the per-row maximum so every row keeps the same pitch
  // (the plan lists spines first, then cores / aggregation: dealing the racks round-robin gives every pod a spine before any
  // pod gets a second one or an aggregation rack)
  const podCore: PlannedRack[][] = Array.from({ length: nPods }, () => []);
  if (distributed) coreAll.forEach((r, i) => podCore[i % nPods].push(r));
  const podCoreIdx = new Array<number>(nPods).fill(0);
  const spinesOfRow = (p: number, ri: number) => {
    const n = podCore[p]?.length ?? 0;
    return Math.floor(n / s.rowsPerPod) + (ri < n % s.rowsPerPod ? 1 : 0);
  };
  const spinePerRow = distributed ? Math.ceil(Math.ceil(coreAll.length / nPods) / s.rowsPerPod) : 0;
  const crahPerRow = !perimeter && podRows > 0 ? Math.ceil(crahCount / podRows) : rowEndCrahs;
  const rowLengthEff = s.rowLength + spinePerRow * netRack.dims.w + crahPerRow * crah.dims.w;
  const colPitch = rowLengthEff + corridors.transportM;
  const areaW = C * rowLengthEff + (C - 1) * corridors.transportM;
  const hacOut = t.containment !== 'cold-aisle';

  // ── band geometry (r2-layout.md §1.4): full grid width, rows break at the grid's cross aisles, even row count ──
  const segLen = Math.min(rowLengthEff, opts.maxCentralRowLengthM ?? Infinity);
  const posW = netRack.dims.w;
  const posD = netRack.dims.d;
  const positionsPerSeg = Math.max(1, Math.floor(segLen / posW + 1e-9));
  const positionsPerRow = C * positionsPerSeg;
  const coreHome: Home = placement === 'distributed' ? (distributed ? 'pods' : 'end') : placement === 'separate-room' ? 'room' : placement === 'central-center' ? 'center' : 'end';
  const svcHome: Home = zoneMode === 'separate-room' ? 'room' : zoneMode === 'center-band' ? 'center' : zoneMode === 'support-hac' ? 'su' : 'end';

  // support HAC: services racks dealt round-robin over the user-defined deployment units;
  // what does not fit a unit's support pair goes to the end band (with the shared network core)
  const suD = Math.max(posD, ...plan.services.map((r) => r.item.dims.d));
  const suSvc: PlannedRack[][] = Array.from({ length: nPods }, () => []);
  const overflowSvc: PlannedRack[] = [];
  if (svcHome === 'su') {
    const used = new Array<number>(nPods).fill(0);
    plan.services.forEach((r, i) => {
      for (let k = 0; k < nPods; k++) {
        const p = (i + k) % nPods;
        if (used[p] + r.item.dims.w <= 2 * segLen + 1e-9) {
          suSvc[p].push(r);
          used[p] += r.item.dims.w;
          return;
        }
      }
      overflowSvc.push(r);
    });
  }
  const suStride = svcHome === 'su' ? 2 * suD + t.innerAisleM + t.outerAisleM : 0;
  const podPitch = s.podDepth + t.outerAisleM + suStride;

  // ── Y stacking order ──
  let y = y0;
  let letter = 0;
  const midRow = Math.floor(R / 2);
  /** facing parity of the next row: 0 → rot 180 (front −Y) — what must follow a row whose front faces +Y */
  const facing = { parity: 0 as 0 | 1, trailing: t.outerAisleM };
  interface BandRow { y: number; rot: EquipmentInstance['rotationDeg']; d: number; segs: PlannedRack[][] }
  interface Band { home: Home; rows: BandRow[]; top: number; bottom: number; core: number; svc: number }
  const bands: Band[] = [];
  /** greedy fill: rows → pod-column segments → racks (a segment never exceeds the pod row length) */
  const fillSegs = (list: readonly PlannedRack[]): PlannedRack[][][] => {
    const out: PlannedRack[][][] = [];
    let row: PlannedRack[][] = [[]];
    let len = 0;
    for (const it of list) {
      if (row[row.length - 1].length && len + it.item.dims.w > segLen + 1e-9) {
        if (row.length < C) row.push([]);
        else {
          out.push(row);
          row = [[]];
        }
        len = 0;
      }
      row[row.length - 1].push(it);
      len += it.item.dims.w;
    }
    if (row.some((sg) => sg.length)) out.push(row);
    // fix v2 2차 (QA F3b): a partial last row filled column 1 first, leaving the other columns' band segments empty (an island beside
    // one pod column). Re-deal it over the C segments by width, contiguous (group order kept), each segment ≤ segLen; the free
    // positions stay at every segment's outer end.
    const last = out[out.length - 1];
    if (C > 1 && last && last.length < C) {
      const items = last.flat();
      const total = items.reduce((a, r) => a + r.item.dims.w, 0);
      const target = total / C;
      const segs: PlannedRack[][] = Array.from({ length: C }, () => []);
      let k = 0;
      let l = 0;
      items.forEach((it, idx) => {
        const remainingSegs = C - k - 1;
        const remainingItems = items.length - idx;
        if (segs[k].length && k < C - 1 && (l + it.item.dims.w / 2 > target + 1e-9 || remainingItems <= remainingSegs)) {
          k++;
          l = 0;
        }
        segs[k].push(it);
        l += it.item.dims.w;
      });
      if (segs.every((sg) => sg.reduce((a, r) => a + r.item.dims.w, 0) <= segLen + 1e-9)) out[out.length - 1] = segs;
    }
    return out;
  };
  const layBand = (home: Home, groups: PlannedRack[][]): Band | null => {
    const items = groups.flat();
    if (!items.length) return null;
    // band rows = max(2, 2·ceil(n / (2·C·positionsPerRow))) — an even count (HAC pairs), at least one HAC
    const countRows = Math.max(2, 2 * Math.ceil(items.length / (2 * positionsPerRow)));
    const separate = groups.filter((g) => g.length).map(fillSegs);
    const sepRows = separate.reduce((a, g) => a + g.length, 0);
    // network core and services keep their own rows when that still fits the band depth, else one continuous fill
    const filled: PlannedRack[][][] = sepRows <= countRows ? separate.flat(1) : fillSegs(items);
    const nRows = Math.max(countRows, filled.length + (filled.length % 2));
    const top = y;
    const out: BandRow[] = [];
    for (let i = 0; i < nRows; i++) {
      const segs = filled[i] ?? [];
      const d = Math.max(posD, ...segs.flat().map((r) => r.item.dims.d));
      const facingMinus = (i + facing.parity) % 2 === 0; // rot 180: front −Y, rear +Y
      out.push({ y: y + d / 2, rot: facingMinus ? 180 : 0, d, segs });
      y += d;
      // after a rear-facing(+Y) row the next row's rear meets it → hot aisle; otherwise fronts meet → cold aisle
      facing.trailing = facingMinus ? t.innerAisleM : t.outerAisleM;
      y += facing.trailing;
    }
    facing.parity = ((facing.parity + nRows) % 2) as 0 | 1;
    const band: Band = { home, rows: out, top, bottom: y - facing.trailing, core: items.filter((r) => r.group === 'network-core').length, svc: items.filter((r) => r.group === 'services').length };
    bands.push(band);
    return band;
  };
  let centerLaid = false;
  const groupsFor = (home: Home): PlannedRack[][] => {
    const coreHere = coreHome === home || (home === 'end' && coreHome === 'center' && !centerLaid);
    const svcHere = svcHome === home || (home === 'end' && svcHome === 'center' && !centerLaid);
    return [coreHere ? coreAll : [], svcHere ? plan.services : [], home === 'end' ? overflowSvc : []];
  };

  // separate room: a strip outside the pod grid along the growth-origin wall, walled off, offset by SEPARATE_ROOM_OFFSET_M
  const roomGroups = groupsFor('room');
  if (roomGroups.some((g) => g.length)) {
    layBand('room', roomGroups);
    reservations.push({ id: 'rsv-room-partition', hallId: hall.id, kind: 'room-partition', rect: { x: round6(x0), y: round6(y + SEPARATE_ROOM_OFFSET_M / 2 - 0.1), w: round6(areaW), d: 0.2 }, positions: 0, axis: 'x', zone: 'separate-room', waveId: 'wave-01' });
    y += SEPARATE_ROOM_OFFSET_M; // partition corridor between the room strip and the pod area
  }

  const counters = new Map<string, number>();
  const nextNo = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return n;
  };
  let reservePositions = 0;
  const supportRects: Rect[] = [];
  let supportRacks = 0;
  const placeSupport = (p: number, podNo: number, podName: string, waveId: string, px: number, sy: number) => {
    const supId = `pod-services-${pad(podNo)}`;
    const list = suSvc[p];
    const defs = [
      { key: 'a', y: sy + suD / 2, rot: 180 as const },
      { key: 'b', y: sy + suD + t.innerAisleM + suD / 2, rot: 0 as const },
    ];
    let idx = 0;
    for (const rd of defs) {
      const rowId = `${supId}-${rd.key}`;
      let x = px;
      const memberIds: string[] = [];
      while (idx < list.length && x + list[idx].item.dims.w <= px + segLen + 1e-9) {
        const pr = list[idx++];
        const e = place(equipment, hall, pr.item, `${podName}-S${rd.key.toUpperCase()}-${pr.prefix}${pad(nextNo(pr.prefix))}`, x + pr.item.dims.w / 2, rd.y, rd.rot, { podId: supId, rowId, waveId, ...(pr.role ? { networkRole: pr.role } : {}) });
        memberIds.push(e.id);
        x += pr.item.dims.w;
      }
      supportRacks += memberIds.length;
      if (memberIds.length) rows.push({ id: rowId, hallId: hall.id, podId: supId, kind: 'services', axis: 'x', a0: round6(px), a1: round6(x), center: round6(rd.y), frontSign: rd.rot === 0 ? 1 : -1, memberIds });
      const free = Math.floor((px + segLen - x) / posW + 1e-9);
      if (free > 0) {
        reservations.push({ id: `rsv-${rowId}`, hallId: hall.id, kind: 'reserve', rect: { x: round6(x), y: round6(rd.y - suD / 2), w: round6(free * posW), d: round6(suD) }, positions: free, axis: 'x', zone: 'support-hac', rowId, waveId });
        reservePositions += free;
      }
    }
    overflowSvc.push(...list.slice(idx));
    const rect: Rect = { x: round6(px), y: round6(sy), w: round6(segLen), d: round6(2 * suD + t.innerAisleM) };
    supportRects.push(rect);
    if (t.containment !== 'none') {
      containments.push({
        id: `cont-${supId}`,
        hallId: hall.id,
        kind: t.containment,
        rect: { x: round6(px), y: round6(sy + suD), w: round6(segLen), d: round6(t.innerAisleM) },
        height: Math.max(netRack.dims.h, ...list.map((r) => r.item.dims.h)),
        roof: true,
        endDoors: true,
        ductedToPlenum: t.containment === 'hot-aisle' && hall.ceilingPlenumHeight > 0,
        podId: supId,
      });
    }
    pods.push({ id: supId, name: `${podName} support`, hallId: hall.id, rect, waveId, kind: 'services' });
  };

  let placedSpines = 0;
  const podRects: Rect[] = [];
  for (let p = 0; p < nPods; p++) {
    const col = p % C;
    const row = Math.floor(p / C);
    if (col === 0 && row === midRow && row > 0 && !centerLaid) {
      const g = groupsFor('center');
      if (g.some((x) => x.length)) {
        layBand('center', g);
        centerLaid = true;
        // an odd row count ends rear-facing (+Y) against the next pod's front: widen the gap by a hot-aisle width
        if (facing.parity === 1 && s.rowsPerPod === 2) y += t.outerAisleM; // mixed (rear-to-front) aisle: hot + cold width
        facing.parity = 0;
      }
    }
    const podNo = start + p;
    const podId = `pod-${pad(podNo)}`;
    const podName = `DU${pad(podNo)}`;
    const waveId = `wave-${pad(Math.floor(p / Math.max(1, opts.podsPerWave)) + 1)}`;
    const px = x0 + col * colPitch;
    const py = y;
    const singleFacingMinus = (row + facing.parity) % 2 === 0; // single-row pods alternate: rear-to-rear (hot) / front-to-front (cold) aisles
    const rowDefs: { key: 'A' | 'B'; y: number; rot: EquipmentInstance['rotationDeg'] }[] =
      s.rowsPerPod === 2
        ? [
            { key: 'A', y: py + s.gpu.dims.d / 2, rot: hacOut ? 180 : 0 },
            { key: 'B', y: py + s.gpu.dims.d + t.innerAisleM + s.gpu.dims.d / 2, rot: hacOut ? 0 : 180 },
          ]
        : [{ key: 'A', y: py + s.gpu.dims.d / 2, rot: singleFacingMinus ? 180 : 0 }];
    rowDefs.forEach((rd, ri) => {
      const rowId = `${podId}-${rd.key.toLowerCase()}`;
      const spinesHere = distributed ? spinesOfRow(p, ri) : 0;
      const slots = rowSlots(s, ri, { spineRacks: spinesHere, crahs: crahPerRow, crahItem: crah, crahMode: perimeter ? (crahPerRow > 0 ? 'row-end' : 'none') : strategy === 'in-row' ? 'row-center' : 'row-end' });
      let x = px;
      let gpuNo = 0;
      let cduNo = 0;
      let netNo = 0;
      let svcNo = 0;
      let crahNo = 0;
      let accNo = 0;
      const memberIds: string[] = [];
      for (const sl of slots) {
        const cx = x + sl.w / 2;
        if (sl.item) {
          let e: EquipmentInstance | undefined;
          if (sl.kind === 'gpu') {
            gpuNo++;
            const meta = t.enclosureRacks && t.enclosureRacks > 0 ? { rcu: `${podName}-${rd.key}-RCU${pad(sl.enc ?? Math.ceil(gpuNo / t.enclosureRacks))}` } : undefined;
            e = place(equipment, hall, sl.item, `${podName}-${rd.key}-${pad(gpuNo)}`, cx, rd.y, rd.rot, { podId, rowId, waveId, ...(meta ? { meta } : {}) });
          } else if (sl.kind === 'acc') e = place(equipment, hall, sl.item, `${podName}-${rd.key}-ACC${pad(++accNo)}`, cx, rd.y, rd.rot, { podId, rowId, waveId, meta: { computeSlot: sl.slotId ?? 'accelerator' } });
          else if (sl.kind === 'cdu') e = place(equipment, hall, sl.item, `${podName}-${rd.key}-CDU${++cduNo}`, cx, rd.y, rd.rot, { podId, rowId, waveId });
          else if (sl.kind === 'net') e = place(equipment, hall, sl.item, `${podName}-${rd.key}-NET${++netNo}`, cx, rd.y, rd.rot, { podId, rowId, waveId, networkRole: sl.role });
          else if (sl.kind === 'spine') {
            const pr = podCore[p][podCoreIdx[p]++];
            placedSpines++;
            e = place(equipment, hall, sl.item, `${podName}-${rd.key}-${pr.prefix}${pad(placedSpines)}`, cx, rd.y, rd.rot, { podId, rowId, waveId, networkRole: pr.role ?? 'scale-out-spine' });
          } else if (sl.kind === 'svc') e = place(equipment, hall, sl.item, `${podName}-${rd.key}-${sl.prefix}${++svcNo}`, cx, rd.y, rd.rot, { podId, rowId, waveId });
          else if (sl.kind === 'crah') e = place(equipment, hall, sl.item, `${podName}-${rd.key}-CRAH${++crahNo}`, cx, rd.y, rd.rot, { podId, rowId, waveId });
          if (e) memberIds.push(e.id);
        }
        x += sl.w;
      }
      rows.push({ id: rowId, hallId: hall.id, podId, kind: 'compute', axis: 'x', a0: round6(px), a1: round6(x), center: round6(rd.y), frontSign: rd.rot === 0 ? 1 : -1, memberIds });
    });
    const podRect: Rect = { x: px, y: py, w: rowLengthEff, d: s.podDepth };
    podRects.push(podRect);
    pods.push({ id: podId, name: podName, hallId: hall.id, rect: podRect, waveId, kind: 'compute' });
    if (t.containment !== 'none' && s.rowsPerPod === 2) {
      containments.push({
        id: `cont-${podId}`,
        hallId: hall.id,
        kind: t.containment,
        rect: { x: px, y: py + s.gpu.dims.d, w: rowLengthEff, d: t.innerAisleM },
        height: s.gpu.dims.h,
        roof: true,
        endDoors: true,
        ductedToPlenum: t.containment === 'hot-aisle' && hall.ceilingPlenumHeight > 0,
        podId,
      });
    }
    if (svcHome === 'su') placeSupport(p, podNo, podName, waveId, px, py + s.podDepth + t.outerAisleM);
    // the next pod row starts after the last column of this row (single-row pods: hot aisle after a rear-facing row)
    if (col === C - 1 || p === nPods - 1) {
      facing.trailing = s.rowsPerPod === 1 && singleFacingMinus ? t.innerAisleM : t.outerAisleM;
      y += s.podDepth + facing.trailing + suStride;
    }
  }
  // facing parity for the rows that follow the pods: two-row pods end with a +Y-facing front (HAC) or rear (CAC)
  facing.parity = s.rowsPerPod === 2 ? (hacOut ? 0 : 1) : (((R + facing.parity) % 2) as 0 | 1);
  layBand('end', groupsFor('end'));

  // ── place the bands ──
  const podIdsPushed = new Set<string>();
  let centralIdx = 0;
  let zoneBand: Band | undefined;
  for (const band of bands) {
    const zone: ServicesZoneMode = band.home === 'room' ? 'separate-room' : band.home === 'center' ? 'center-band' : svcHome === 'su' ? 'support-hac' : 'end-band';
    band.rows.forEach((br, ri) => {
      const L = rowLetters(letter++);
      for (let c = 0; c < C; c++) {
        const segX = x0 + c * colPitch;
        const rowId = c === 0 ? `pod-services-${L}` : `pod-services-${L}-c${c + 1}`;
        let x = segX;
        const memberIds: string[] = [];
        let core = 0;
        for (const pr of br.segs[c] ?? []) {
          const meta = band.home === 'room' ? { room: pr.group === 'network-core' ? 'network' : 'services' } : undefined;
          const e = place(equipment, hall, pr.item, `SVC-${pr.prefix}${pad(nextNo(pr.prefix))}`, x + pr.item.dims.w / 2, br.y, br.rot, {
            podId: 'pod-services',
            rowId,
            waveId: 'wave-01',
            ...(pr.role ? { networkRole: pr.role } : {}),
            ...(meta ? { meta } : {}),
          });
          memberIds.push(e.id);
          x += pr.item.dims.w;
          if (pr.group === 'network-core') core++;
        }
        if (memberIds.length) rows.push({ id: rowId, hallId: hall.id, podId: 'pod-services', kind: core * 2 >= memberIds.length ? 'network-core' : 'services', axis: 'x', a0: round6(segX), a1: round6(x), center: round6(br.y), frontSign: br.rot === 0 ? 1 : -1, memberIds });
        const free = Math.floor((segX + segLen - x) / posW + 1e-9);
        if (free > 0) {
          reservations.push({ id: `rsv-${rowId}`, hallId: hall.id, kind: 'reserve', rect: { x: round6(x), y: round6(br.y - br.d / 2), w: round6(free * posW), d: round6(br.d) }, positions: free, axis: 'x', zone, rowId, waveId: 'wave-01' });
          reservePositions += free;
        }
      }
      // band rows standing rear-to-rear get the pod containment (support HAC) over the full segment,
      // reserve positions included ("an aisle containment partition takes the place of the missing rack", H100 DC guide §2.1)
      const nb = band.rows[ri + 1];
      if (nb && t.containment !== 'none') {
        const pair = t.containment === 'hot-aisle' ? br.rot === 180 && nb.rot === 0 : br.rot === 0 && nb.rot === 180;
        if (pair) {
          const height = Math.max(0, ...[...br.segs.flat(), ...nb.segs.flat()].map((r) => r.item.dims.h)) || netRack.dims.h;
          for (let c = 0; c < C; c++) {
            containments.push({
              id: `cont-central-${rowLetters(centralIdx)}${c > 0 ? `-c${c + 1}` : ''}`,
              hallId: hall.id,
              kind: t.containment,
              rect: { x: round6(x0 + c * colPitch), y: round6(br.y + br.d / 2), w: round6(segLen), d: round6(nb.y - nb.d / 2 - (br.y + br.d / 2)) },
              height,
              roof: true,
              endDoors: true,
              ductedToPlenum: t.containment === 'hot-aisle' && hall.ceilingPlenumHeight > 0,
              podId: 'pod-services',
            });
          }
        }
      }
      centralIdx++;
    });
    const rect: Rect = { x: round6(x0), y: round6(band.top), w: round6(areaW), d: round6(band.bottom - band.top) };
    if (band.svc > 0 && !podIdsPushed.has('pod-services')) {
      pods.push({ id: 'pod-services', name: 'Services', hallId: hall.id, rect, waveId: 'wave-01', kind: 'services' });
      podIdsPushed.add('pod-services');
    }
    if (band.core > 0 && !podIdsPushed.has('pod-network-core')) {
      pods.push({ id: 'pod-network-core', name: 'Network core', hallId: hall.id, rect, waveId: 'wave-01', kind: 'network-core' });
      podIdsPushed.add('pod-network-core');
    }
    if (band.svc > 0 && !zoneBand) zoneBand = band;
  }
  if (distributed) pods.push({ id: 'pod-network-core', name: 'Network core (distributed)', hallId: hall.id, rect: { x: x0, y: y0, w: areaW, d: Math.max(0, y - y0 - t.outerAisleM) }, waveId: 'wave-01', kind: 'network-core' });

  // ── services zone record ──
  let zone: HallLayout['zone'];
  if (plan.services.length || coreAll.length) {
    const bandOf = zoneBand ?? (svcHome === 'su' ? undefined : bands.find((b) => b.home === svcHome) ?? bands[0]);
    let rect: Rect | undefined = bandOf ? { x: round6(x0), y: round6(bandOf.top), w: round6(areaW), d: round6(bandOf.bottom - bandOf.top) } : undefined;
    if (svcHome === 'su' && supportRects.length) {
      const xs = supportRects.map((r) => r.x);
      const ys = supportRects.map((r) => r.y);
      rect = { x: Math.min(...xs), y: Math.min(...ys), w: round6(Math.max(...supportRects.map((r) => r.x + r.w)) - Math.min(...xs)), d: round6(Math.max(...supportRects.map((r) => r.y + r.d)) - Math.min(...ys)) };
    }
    zone = {
      mode: zoneMode,
      rect,
      rows: svcHome === 'su' ? supportRects.length * 2 : (bandOf?.rows.length ?? 0),
      positionsPerRow: svcHome === 'su' ? positionsPerSeg : positionsPerRow,
      racks: svcHome === 'su' ? supportRacks + (bandOf ? bandOf.core + bandOf.svc : 0) : bandOf ? bandOf.core + bandOf.svc : 0,
      reservePositions,
      interHallCoreRacks: ihc,
    };
  }

  const contentBottom = y - facing.trailing;
  const requiredWidth = round6(x0 - centreX + areaW + xZone + marginM + (gw === 'E' ? gd : 0));
  const requiredDepth = round6(Math.max(contentBottom, y0) + Math.max(yZone, 1.5) + marginM + (gw === 'N' ? gd : 0));

  const width = Math.max(hall.width, requiredWidth);
  const depth = Math.max(hall.depth, requiredDepth);
  const keepoutRects = hall.keepouts.map((k) => keepoutBlockRect(k));

  // ── mechanical-gallery CDUs (hall.coolingPlacement.cduPlacement 'gallery'): a strip against the gallery wall ──
  const galleryRects: Rect[] = [];
  if (gallery && gw) {
    const computePods = pods.filter((pd) => pd.kind === 'compute');
    const cap = s.cdu.capacity?.coolingKW ?? 0;
    const groups: WallUnitGroup[] = [];
    // R-C2 (r2-layout.md §3.2): a gallery group serves ≤ 2 pods, N+1 per group (estimate)
    for (let g = 0; g < computePods.length; g += 2) {
      const members = computePods.slice(g, g + 2);
      const liquid = members.length * s.liquidKW;
      const count = gallery.perPod === 'auto' ? (liquid > 0 && cap > 0 ? redundantCount(Math.ceil(liquid / cap - 1e-9), gallery.redundancy) : 0) : Math.max(0, Math.round(gallery.perPod)) * members.length;
      const along = wallAxis(gw) === 'y' ? 'y' : 'x';
      const target = members.reduce((a, pd) => a + (along === 'y' ? pd.rect.y + pd.rect.d / 2 : pd.rect.x + pd.rect.w / 2), 0) / Math.max(1, members.length);
      groups.push({ count, target, extra: { waveId: members[0].waveId, meta: { gallery: true, group: `G${pad(g / 2 + 1)}`, pods: members.map((pd) => pd.id).join(',') } } });
    }
    const total = groups.reduce((a, g) => a + g.count, 0);
    const placed = placeWallUnits(equipment, hall, s.cdu, groups, gw, { width, depth, marginM, blockers: keepoutRects, tag: (k) => `CDU-G${gw}${pad(k)}` });
    const n = placed.reduce((a, g) => a + g.length, 0);
    for (const g of placed) for (const e of g) galleryRects.push(footprintRect(s.cdu.dims, e.position, e.rotationDeg));
    if (n < total)
      issues.push({
        id: `layout-cdu-gallery-short-${hall.id}`,
        severity: 'error',
        domain: 'layout',
        message: `${hall.name}: 기계 갤러리(${gw} 벽)에 CDU ${total}대 중 ${n}대만 들어갑니다 (벽 길이 부족).`,
        messageEn: `${hall.name}: only ${n} of ${total} CDUs fit the mechanical gallery on the ${gw} wall (wall too short).`,
        refs: [hall.id],
        suggestion: '열 끝 / 끝+중앙 CDU 배치를 선택하거나 홀 깊이를 늘리세요.',
        suggestionEn: 'Choose row-end or ends+centre CDU placement, or lengthen the gallery wall.',
      });
  }

  // ── perimeter CRAHs ──
  let placedCrah = equipment.filter((e) => e.catalogId === crah.id).length; // row-end / in-row units already placed
  const perimeterCount = Math.max(0, crahCount - placedCrah);
  if (perimeter && perimeterCount > 0) {
    // only a hall wider than the layout by more than a CRAH zone per side, and only the row-end walls; extent = every row member (racks, row CDUs, row-end units)
    const rowRects = equipment.filter((e) => e.rowId && findCatalogItem(e.catalogId)).map((e) => footprintRect(findCatalogItem(e.catalogId)!.dims, e.position, e.rotationDeg));
    const line = !opts.probe && !opts.noCrahLine && centreX > crahZone ? crahPodEdgeLine({ width, depth }, rowRects, crah, walls.filter((w) => w === 'W' || w === 'E'), marginM, gw ? { [gw]: gd } : {}) : null;
    const offset = { ...(gw ? { [gw]: gd } : {}), ...(line?.offset ?? {}) };
    placedCrah += placeCrahs(equipment, hall, crah, perimeterCount, walls, { width, depth, marginM, xZone, yZone, podRects: [...podRects, ...galleryRects], keepouts: hall.keepouts, wallOffset: Object.keys(offset).length ? offset : undefined, span: line?.span });
    if (line) issues.push(crahPodEdgeIssue(hall, line));
  }

  const hallForTrays: Hall = { ...hall, width, depth };
  const trays = opts.probe ? [] : buildTrays(hallForTrays, rows, equipment);
  const busways = opts.probe ? [] : buildBusways(hallForTrays, rows, equipment);

  return {
    equipment,
    containments,
    pods,
    requiredWidth,
    requiredDepth,
    rows,
    trays,
    busways,
    issues,
    crah: { required: crahCount, placed: placedCrah, walls: perimeter ? [...walls] : [], airKW: round6(airKW) },
    central: { networkCoreRacks: coreAll.length, servicesRacks: plan.services.length, rows: bands.reduce((a, b) => a + b.rows.length, 0), placement },
    grid: { columns: C, rows: R, rowLengthM: round6(rowLengthEff), podPitchM: round6(podPitch) },
    reservations,
    zone,
  };
}

export interface CrahEnv {
  width: number;
  depth: number;
  marginM: number;
  xZone: number;
  yZone: number;
  podRects: Rect[];
  keepouts: Hall['keepouts'];
  /** distance from the wall to the unit row per wall (e.g. behind a gallery CDU strip) */
  wallOffset?: Partial<Record<Wall, number>>;
  /** along-wall span per wall (crahPodEdgeLine: the wall segment facing the pod area) */
  span?: Partial<Record<Wall, [number, number]>>;
}

/** Clearance wall units (CRAH / fan wall / gallery CDU) keep from any keepout (estimate, unchanged from v2 1차). notchKeepouts uses the same
 *  rectangle for wall units, so a keepout notch never removes a unit that was placed clear of it. */
export const WALL_UNIT_KEEPOUT_CLEARANCE_M = 0.3;

export function keepoutBlockRect(k: Hall['keepouts'][number]): Rect {
  const g = WALL_UNIT_KEEPOUT_CLEARANCE_M;
  return { x: k.rect.x - g, y: k.rect.y - g, w: k.rect.w + 2 * g, d: k.rect.d + 2 * g };
}

export interface CrahPodEdgeLine {
  /** distance from the wall to the unit row (the pod-area edge line) per wall that moved */
  offset: Partial<Record<Wall, number>>;
  /** along-wall span the moved units keep (the pod area's extent ± 1.5 m) */
  span: Partial<Record<Wall, [number, number]>>;
  walls: { wall: Wall; throwWallM: number; throwLineM: number; gapWallM: number; gapLineM: number }[];
}

/**
 * Fixed halls larger than the layout (polish v2 2차, QA F6): a wall unit facing the pod area whose air throw from the wall to the middle of
 * the pod area exceeds the datum (18 m design estimate) stands on a cooling line at the pod-area edge instead — the CRAH zone (unit depth +
 * front clearance + 1.5 m) in front of the outermost racks — and keeps to the wall segment facing the pod area. Walls within the datum keep
 * their units at the wall (generated auto-size halls and the reference hall are unchanged). null when no wall moves.
 */
export function crahPodEdgeLine(hall: { width: number; depth: number }, racks: readonly Rect[], crah: CatalogItem, walls: readonly Wall[], marginM: number, wallOffset: Partial<Record<Wall, number>> = {}): CrahPodEdgeLine | null {
  if (!racks.length) return null;
  const minX = Math.min(...racks.map((r) => r.x));
  const maxX = Math.max(...racks.map((r) => r.x + r.w));
  const minY = Math.min(...racks.map((r) => r.y));
  const maxY = Math.max(...racks.map((r) => r.y + r.d));
  const zone = crah.dims.d + crah.clearance.front + 1.5;
  const out: CrahPodEdgeLine = { offset: {}, span: {}, walls: [] };
  for (const w of walls) {
    const off0 = wallOffset[w] ?? 0;
    const slack = w === 'W' ? minX - marginM - off0 - zone : w === 'E' ? hall.width - maxX - marginM - off0 - zone : w === 'S' ? minY - marginM - off0 - zone : hall.depth - maxY - marginM - off0 - zone;
    const half = (w === 'W' || w === 'E' ? maxX - minX : maxY - minY) / 2;
    const throwWallM = slack + zone + half;
    // at least one more CRAH zone of free floor behind the line: a tile-trimmed auto-size hall never moves its units
    if (slack <= zone || throwWallM <= AIR_THROW_DATUM_M + 1e-9) continue;
    out.offset[w] = round6(off0 + slack);
    out.span[w] = w === 'W' || w === 'E' ? [Math.max(marginM, minY - 1.5), Math.min(hall.depth - marginM, maxY + 1.5)] : [Math.max(marginM, minX - 1.5), Math.min(hall.width - marginM, maxX + 1.5)];
    out.walls.push({ wall: w, throwWallM: round6(throwWallM), throwLineM: round6(zone + half), gapWallM: round6(slack + zone - crah.dims.d), gapLineM: round6(zone - crah.dims.d) });
  }
  return out.walls.length ? out : null;
}

export function crahPodEdgeIssue(hall: Pick<Hall, 'id' | 'name'>, line: CrahPodEdgeLine): Issue {
  const ws = line.walls.map((x) => x.wall).join('/');
  const worst = line.walls.reduce((a, b) => (b.throwWallM > a.throwWallM ? b : a));
  const overLine = line.walls.some((x) => x.throwLineM > AIR_THROW_DATUM_M + 1e-9);
  return {
    id: `layout-crah-pod-edge-${hall.id}`,
    severity: overLine ? 'warning' : 'info',
    domain: 'layout',
    message: `${hall.name}: 홀이 배치보다 커서 ${ws} 벽 CRAH의 공기 도달거리가 포드 영역 중앙까지 ${worst.throwWallM.toFixed(1)} m(기준 ${AIR_THROW_DATUM_M} m)입니다 — 해당 유닛을 포드 영역 가장자리 냉각 라인에 두었습니다 (랙까지 간격 ${worst.gapWallM.toFixed(1)} → ${worst.gapLineM.toFixed(1)} m, 도달거리 ${worst.throwLineM.toFixed(1)} m${overLine ? ` — 여전히 ${AIR_THROW_DATUM_M} m 초과, 포드 영역 중간에 in-row / 열 끝 유닛을 추가하세요` : ''}).`,
    messageEn: `${hall.name}: the hall is larger than the layout — from the ${ws} wall(s) the air throw to the middle of the pod area would be ${worst.throwWallM.toFixed(1)} m (datum ${AIR_THROW_DATUM_M} m), so those units stand on a cooling line at the pod-area edge (gap to the racks ${worst.gapWallM.toFixed(1)} → ${worst.gapLineM.toFixed(1)} m, throw ${worst.throwLineM.toFixed(1)} m${overLine ? ` — still beyond ${AIR_THROW_DATUM_M} m: add in-row / row-end units inside the pod area` : ''}).`,
    refs: [hall.id],
    suggestion: '냉각 라인 뒤 벽 쪽 공간은 복도·증설 예비로 쓰거나, 홀 자동 크기로 홀을 줄이세요.',
    suggestionEn: 'Use the floor behind the cooling lines as circulation / expansion space, or turn auto-size on to shrink the hall.',
  };
}

/** Place `count` CRAHs on `walls` (fronts facing into the hall), avoiding keepouts. Returns the number placed. */
export function placeCrahs(out: EquipmentInstance[], hall: Hall, crah: CatalogItem, count: number, walls: Wall[], env: CrahEnv): number {
  const { width, depth, marginM } = env;
  const defs = walls.map((w) => {
    const rot: EquipmentInstance['rotationDeg'] = w === 'W' ? 270 : w === 'E' ? 90 : w === 'S' ? 0 : 180;
    const { sx, sy } = footprintSize(crah.dims, rot);
    const axis = wallAxis(w);
    const along = axis === 'y' ? sy : sx;
    const across = axis === 'y' ? sx : sy;
    const inset = axis === 'x' && walls.some((x) => x === 'W' || x === 'E') ? env.xZone : 0;
    const off = env.wallOffset?.[w] ?? 0;
    const lo = Math.max(marginM + inset, env.span?.[w]?.[0] ?? -Infinity);
    const hi = Math.min((axis === 'y' ? depth : width) - marginM - inset, env.span?.[w]?.[1] ?? Infinity);
    const span = Math.max(0, hi - lo);
    const capacity = Math.floor((span + CRAH_GAP_M) / (along + CRAH_GAP_M) + 1e-9);
    const fixed = w === 'W' ? marginM + off + across / 2 : w === 'E' ? width - marginM - off - across / 2 : w === 'S' ? marginM + off + across / 2 : depth - marginM - off - across / 2;
    return { w, rot, along, across, axis, lo, hi, span, capacity, fixed };
  });
  // quotas proportional to span, capped by capacity
  const totalSpan = defs.reduce((a, d) => a + d.span, 0);
  let quotas = defs.map((d) => (totalSpan > 0 ? Math.floor((count * d.span) / totalSpan) : 0));
  let left = count - quotas.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0 && i < defs.length * 4; i++) {
    const idx = i % defs.length;
    if (quotas[idx] < defs[idx].capacity) {
      quotas[idx]++;
      left--;
    }
  }
  quotas = quotas.map((q, i) => Math.min(q, defs[i].capacity));
  left = count - quotas.reduce((a, b) => a + b, 0);
  for (let pass = 0; left > 0 && pass < 4; pass++) {
    for (let i = 0; i < defs.length && left > 0; i++) {
      const spare = defs[i].capacity - quotas[i];
      const take = Math.min(spare, left);
      quotas[i] += take;
      left -= take;
    }
  }
  const own: Rect[] = [];
  const blocked = (r: Rect) => env.keepouts.some((k) => rectsOverlap(r, keepoutBlockRect(k))) || env.podRects.some((p) => rectsOverlap(r, p)) || own.some((p) => rectsOverlap(r, p));
  let placed = 0;
  defs.forEach((d, di) => {
    const n = quotas[di];
    if (n <= 0) return;
    const pitch = d.span / n;
    let prev = -Infinity;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const nominal = d.lo + pitch * (i + 0.5);
      let chosen: number | null = null;
      for (let step = 0; step <= 12 && chosen === null; step++) {
        for (const sgn of step === 0 ? [1] : [1, -1]) {
          const c = nominal + sgn * step * 0.3;
          if (c - d.along / 2 < d.lo - 1e-9 || c + d.along / 2 > d.hi + 1e-9) continue;
          if (c - prev < d.along + CRAH_GAP_M - 1e-9) continue;
          const rect: Rect = d.axis === 'y' ? { x: d.fixed - d.across / 2, y: c - d.along / 2, w: d.across, d: d.along } : { x: c - d.along / 2, y: d.fixed - d.across / 2, w: d.along, d: d.across };
          if (blocked(rect)) continue;
          chosen = c;
          break;
        }
      }
      if (chosen === null) continue;
      own.push(d.axis === 'y' ? { x: d.fixed - d.across / 2, y: chosen - d.along / 2, w: d.across, d: d.along } : { x: chosen - d.along / 2, y: d.fixed - d.across / 2, w: d.along, d: d.across });
      prev = chosen;
      k++;
      const cx = d.axis === 'y' ? d.fixed : chosen;
      const cy = d.axis === 'y' ? chosen : d.fixed;
      place(out, hall, crah, `CRAH-${d.w}${pad(k)}`, cx, cy, d.rot, { waveId: 'wave-01' });
      placed++;
    }
  });
  return placed;
}

export interface WallUnitGroup {
  count: number;
  /** desired centre of the group along the wall (m, hall-local) */
  target: number;
  extra?: Partial<EquipmentInstance>;
}

/**
 * Place groups of units against `wall` (fronts facing into the hall), each group centred on `target` along the wall and
 * shifted in 0.3 m steps around blockers. Returns the placed instances per group (units that find no free spot are skipped).
 */
export function placeWallUnits(
  out: EquipmentInstance[],
  hall: Hall,
  item: CatalogItem,
  groups: readonly WallUnitGroup[],
  wall: Wall,
  env: { width: number; depth: number; marginM: number; blockers: readonly Rect[]; offset?: number; gapM?: number; tag: (k: number) => string; idOf?: (tag: string) => string },
): EquipmentInstance[][] {
  const rot: EquipmentInstance['rotationDeg'] = wall === 'W' ? 270 : wall === 'E' ? 90 : wall === 'S' ? 0 : 180;
  const { sx, sy } = footprintSize(item.dims, rot);
  const axis = wallAxis(wall);
  const along = axis === 'y' ? sy : sx;
  const across = axis === 'y' ? sx : sy;
  const off = env.offset ?? 0;
  const fixed = wall === 'W' ? env.marginM + off + across / 2 : wall === 'E' ? env.width - env.marginM - off - across / 2 : wall === 'S' ? env.marginM + off + across / 2 : env.depth - env.marginM - off - across / 2;
  const lo = env.marginM;
  const hi = (axis === 'y' ? env.depth : env.width) - env.marginM;
  const gap = env.gapM ?? 0.1;
  const taken: Rect[] = [];
  const rectAt = (c: number): Rect => (axis === 'y' ? { x: fixed - across / 2, y: c - along / 2, w: across, d: along } : { x: c - along / 2, y: fixed - across / 2, w: along, d: across });
  const free = (c: number) => {
    const r = rectAt(c);
    const g: Rect = axis === 'y' ? { x: r.x, y: r.y - gap / 2, w: r.w, d: r.d + gap } : { x: r.x - gap / 2, y: r.y, w: r.w + gap, d: r.d };
    return !env.blockers.some((b) => rectsOverlap(r, b)) && !taken.some((b) => rectsOverlap(g, b));
  };
  const maxSteps = Math.ceil(Math.max(0, hi - lo) / 0.3) + 2;
  let k = 0;
  const result: EquipmentInstance[][] = [];
  for (const g of groups) {
    const placedG: EquipmentInstance[] = [];
    const block = g.count * along + Math.max(0, g.count - 1) * gap;
    let c = Math.min(Math.max(g.target - block / 2 + along / 2, lo + along / 2), hi - along / 2);
    for (let i = 0; i < g.count; i++) {
      let chosen: number | null = null;
      for (let step = 0; step <= maxSteps && chosen === null; step++) {
        for (const sgn of step === 0 ? [1] : [1, -1]) {
          const cc = c + sgn * step * 0.3;
          if (cc - along / 2 < lo - 1e-9 || cc + along / 2 > hi + 1e-9) continue;
          if (!free(cc)) continue;
          chosen = cc;
          break;
        }
      }
      if (chosen === null) continue;
      taken.push(rectAt(chosen));
      k++;
      const tag = env.tag(k);
      const e = place(out, hall, item, tag, axis === 'y' ? fixed : chosen, axis === 'y' ? chosen : fixed, rot, { waveId: 'wave-01', ...(g.extra ?? {}) });
      if (env.idOf) e.id = env.idOf(tag);
      placedG.push(e);
      c = chosen + along + gap;
    }
    result.push(placedG);
  }
  return result;
}

// ───────────────────────────── transpose (orientation 'y') ─────────────────────────────

/**
 * Pod columns for a grow-hall layout when the user has not fixed them: the column count that makes the pod area roughly square
 * (C = round(√(R · podPitch / rowLength))), raised until the pod-area depth stays under `maxDepthM` (default 100 m — the OOB / 1G copper and 100G MMF reach, beyond which the network
 * engine raises `network-unreachable`). Returns 1 for small halls (the reference DU 4 stays 1 × 4).
 */
export function autoColumns(template: PodTemplate, pods: number, opts: { fabrics?: FabricOptions; corridors?: LayoutPolicy['corridors']; maxDepthM?: number; maxColumns?: number } = {}): number {
  const n = Math.max(1, Math.floor(pods));
  const maxC = Math.max(1, Math.min(opts.maxColumns ?? 6, n));
  const corridors = opts.corridors ?? CORRIDOR_DEFAULTS;
  const maxDepth = opts.maxDepthM ?? 100;
  let s: PodSizing;
  try {
    s = podSizing(template, opts.fabrics);
  } catch {
    return 1;
  }
  const pitch = s.podDepth + s.t.outerAisleM;
  const rowLen = s.rowLength + corridors.transportM;
  // C ≈ √(pods · pitch / rowLength) makes the pod area square; then add columns until the depth clears the reach limit
  let c = Math.min(maxC, Math.max(1, Math.round(Math.sqrt((n * pitch) / Math.max(0.1, rowLen)))));
  while (c < maxC && Math.ceil(n / c) * pitch > maxDepth) c++;
  return c;
}

export function transposeRect(r: Rect): Rect {
  return { x: r.y, y: r.x, w: r.d, d: r.w };
}

const ROT_T: Record<0 | 90 | 180 | 270, EquipmentInstance['rotationDeg']> = { 0: 270, 90: 180, 180: 90, 270: 0 };

/**
 * Wall units carry the wall letter in their tag / id (CRAH-W01, CDU-GE02). The x-frame letter of a transposed layout names the wrong wall
 * (polish v2 2차, QA F7: CRAH-W01 stood on the S wall and regenerateCooling, which tags in the hall frame, kept 0 of 21 ids) → map it.
 */
function wallTagT(e: EquipmentInstance): EquipmentInstance {
  const m = /^(CRAH-|CDU-G)([NSEW])(\d+)$/.exec(e.tag);
  if (!m) return e;
  const tag = `${m[1]}${WALL_T[m[2] as Wall]}${m[3]}`;
  return { ...e, tag, id: e.id === `eq-${e.tag.toLowerCase()}` ? `eq-${tag.toLowerCase()}` : e.id };
}

function transposeLayout(l: HallLayout): HallLayout {
  const tp = <T extends { x: number; y: number }>(p: T): T => ({ ...p, x: p.y, y: p.x });
  const equipment = l.equipment.map(wallTagT);
  const renamed = new Map(l.equipment.map((e, i) => [e.id, equipment[i].id] as const).filter(([a, b]) => a !== b));
  return {
    ...l,
    equipment: equipment.map((e) => ({ ...e, position: tp(e.position), rotationDeg: ROT_T[e.rotationDeg] })),
    containments: l.containments.map((c) => ({ ...c, rect: transposeRect(c.rect) })),
    pods: l.pods.map((p) => ({ ...p, rect: transposeRect(p.rect) })),
    requiredWidth: l.requiredDepth,
    requiredDepth: l.requiredWidth,
    rows: l.rows.map((r) => ({ ...r, axis: r.axis === 'x' ? 'y' : 'x' })),
    trays: l.trays.map((t) => ({ ...t, points: t.points.map(tp) })),
    busways: l.busways.map((b) => ({ ...b, points: b.points.map(tp), tapoffs: b.tapoffs.map((t) => ({ ...tp(t), equipmentId: renamed.get(t.equipmentId) ?? t.equipmentId })) })),
    reservations: l.reservations?.map((r) => ({ ...r, rect: transposeRect(r.rect), axis: r.axis === 'x' ? 'y' : 'x' })),
    zone: l.zone ? { ...l.zone, rect: l.zone.rect ? transposeRect(l.zone.rect) : undefined } : undefined,
  };
}

/** Round a dimension up to the planning grid. */
export function roundUpToGrid(v: number, grid: number): number {
  return round6(Math.ceil(v / grid - 1e-9) * grid);
}

/** Shortfall of a hall against a layout's required size (0 when it fits). */
export function hallShortfall(hall: Pick<Hall, 'width' | 'depth'>, layout: Pick<HallLayout, 'requiredWidth' | 'requiredDepth'>): { width: number; depth: number } {
  return { width: round6(Math.max(0, layout.requiredWidth - hall.width)), depth: round6(Math.max(0, layout.requiredDepth - hall.depth)) };
}
