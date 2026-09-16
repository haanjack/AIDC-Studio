// Cooling-topology comparison: gallery fan wall / perimeter CRAH / in-row / sidecar L2A / RDHx
// (stream T4, DECISIONS-v2-2 §B, r2-platform.md §2, site-design.md §2.5–2.6, r2-layout.md §3).
//
// Called by analyzeProject after the analysis object is built; attached to `analysis.cooling.topology` when non-empty.
// Deterministic and cheap (runs on every store update) — no CFD here (CFD-lite variants: packages/thermal/src/variants.ts).
//
// Formulas (r2-platform.md §2.2), per hall:
//   q_air,i  = P_i·(1 − f_i)                (A fan wall · B perimeter · C in-row: liquid goes to CDUs)
//   D L2A:     room heat = Σ P_i + sidecar fan kW (sidecars relocate heat, they do not remove it)
//   E RDHx:    q_room,i = max(0, q_air,i − Q_door)   (door removes heat at the exhaust face)
//   Q_req,g  = Σ q_air · (1 + fanHeat)      fanHeat = unit input kW ÷ unit kW
//   n_N,g    = max(ceil(Q_req,g / q_unit), ceil(1.1·V_req,g / V_unit))       (1.1 airflow margin = cooling engine)
//   n_inst,g = redundancy(n_N,g)            (project.cooling.crahRedundancy)
//   spare %  = (Q_inst − Q_req) / Q_req · 100      (RDHx: Q_inst = doors × rated door kW + room units; door duty in rackDutyKW)
//   largest single unit failed = (Q_inst,g − q_largest) / Q_req,g for the group served by the largest unit of the row (min over
//              those groups); the failed unit is named in worstFailureUnit (polish v2 2차: one definition for every row)
//   fan kW   = n_inst · P_rated · clamp(V_req / (n_inst·V_unit), 0.3, 1)³  (affinity law, 30 % floor as cooling.ts)
// Groups: A/B = hall, C = pod (contained aisle), D/E = rack. Every constant used by a row is listed in its coefficients.
// Gallery fan wall and the L2A room system use the placeable fan-wall catalog item (so "Place with this topology" puts the compared
// unit in the hall); the CWA CA80 seed is the fallback when the catalog carries no fan-wall item.
import { catalogItems, findCatalogItem, interpCurve } from '../catalog/catalog.ts';
import { redundantCount } from '../layout/estimates.ts';
import type {
  CatalogItem,
  CoolingPlacementOptions,
  CoolingTopologyCoefficient,
  CoolingTopologyOption,
  CoolingTopologyRow,
  EquipmentInstance,
  Hall,
  Project,
  ProjectAnalysis,
} from '../model/types.ts';
import { IT_LOAD_CATEGORIES } from './context.ts';

export const COOLING_TOPOLOGY_OPTIONS: CoolingTopologyOption[] = ['gallery-fan-wall', 'perimeter-crah', 'in-row', 'sidecar-l2a', 'rdhx'];

// ───────────────────────────── unit seeds (catalog-independent defaults) ─────────────────────────────

export interface CoolingUnitSeed {
  id: string;
  product: string;
  unitKW: number;
  /** rated (max) airflow per unit, m³/s — 0 = uses the rack airflow (active door) */
  airflowM3s: number;
  /** fan input power at rated airflow (kW) */
  inputKW: number;
  widthM: number;
  depthM: number;
  heightM: number;
  /** rack positions (at 600 mm pitch) taken per unit */
  positionsPerUnit: number;
  /** equipment price when a catalog price exists; undefined → placeholder at the CRAH $/kW (estimate) */
  capexUSD?: number;
  coefficients: CoolingTopologyCoefficient[];
}

const CWA_URL = 'https://www.vertiv.com/492f3d/globalassets/products/thermal-management/room-cooling/vertiv-liebert-cwa-chilled-water-thermal-wall-unit-from-200-to-500kw/vertiv-liebert-cwa-brochure---english---emea_mka4l0ukcwa---rev.-3-02.2023-id-374354.pdf';
const CRV_URL = 'https://www.vertiv.com/globalassets/products/thermal-management/in-row-cooling/liebert-crv-11-50-kw-brochure-english.pdf';
const CDU70_URL = 'https://www.vertiv.com/en-us/products-catalog/thermal-management/high-density-solutions/vertiv-coolchip-cdu/';
const DOOR_URL = 'https://media.distrelec.com/Web/Downloads/_t/ds/Motivair-Liquid-Cooled-Doors_eng_tds.pdf';

/** Input kW per kW cooled borrowed for units whose brochure publishes no fan power (Liebert CWA lower bound, r2-platform §2.1). */
export const FAN_INPUT_PER_KW_ESTIMATE = 0.035;

/** A — Vertiv Liebert CWA CA80 thermal wall (gallery). */
export const SEED_FAN_WALL_CWA80: CoolingUnitSeed = {
  id: 'seed-liebert-cwa-ca80',
  product: 'Vertiv Liebert CWA CA80 (thermal wall, gallery side)',
  unitKW: 500,
  airflowM3s: 150_000 / 3600,
  inputKW: 21.7,
  widthM: 3.96,
  depthM: 1.48,
  heightM: 3.67,
  positionsPerUnit: 0,
  coefficients: [
    { key: 'unitKW', label: 'net sensible capacity (RAT 36 °C, water 20–32 °C)', value: 500, unit: 'kW', sourceType: 'vendor-claim', source: 'Liebert CWA brochure, CA80', url: CWA_URL },
    { key: 'airflow', label: 'max airflow', value: 150_000, unit: 'm³/h', sourceType: 'vendor-claim', source: 'Liebert CWA brochure, CA80 (45,000–150,000 m³/h)', url: CWA_URL },
    { key: 'inputKW', label: 'unit input power', value: 21.7, unit: 'kW', sourceType: 'vendor-claim', source: 'Liebert CWA brochure, CA80', url: CWA_URL },
    { key: 'fanPerKW', label: 'fan input per kW cooled', value: 21.7 / 500, unit: 'kW/kW', sourceType: 'derived', source: '21.7 kW ÷ 500 kW (CWA range 0.035–0.043)' },
    { key: 'dims', label: 'footprint W × D', value: 3.96 * 1.48, unit: 'm²', sourceType: 'vendor-claim', source: '3,960 × 1,480 mm (CA80)', url: CWA_URL },
    { key: 'service', label: 'gallery service clearance', value: 1.2, unit: 'm', sourceType: 'estimate', source: 'TIA-942-B 1.2 m aisle rule used as proxy (AIDC Studio estimate)' },
    { key: 'throw', label: 'one-sided air throw', value: 18, unit: 'm', sourceType: 'derived', source: 'design estimate for a one-sided fan-wall throw (DECISIONS-v2-2 §C)' },
  ],
};

/** C — Vertiv Liebert CRV CR050 in-row (600 mm). */
export const SEED_INROW_CRV050: CoolingUnitSeed = {
  id: 'seed-liebert-crv-cr050',
  product: 'Vertiv Liebert CRV CR050 (in-row, 600 mm)',
  unitKW: 57.9,
  airflowM3s: 7410 / 3600,
  inputKW: FAN_INPUT_PER_KW_ESTIMATE * 57.9,
  widthM: 0.6,
  depthM: 1.175,
  heightM: 2.0,
  positionsPerUnit: 1,
  coefficients: [
    { key: 'unitKW', label: 'capacity (38 °C air inlet, 7/12 °C water)', value: 57.9, unit: 'kW', sourceType: 'vendor-claim', source: 'Liebert CRV brochure, CR050', url: CRV_URL },
    { key: 'airflow', label: 'airflow', value: 7410, unit: 'm³/h', sourceType: 'vendor-claim', source: 'Liebert CRV brochure, CR050 (ΔT ≈ 23.3 K derived)', url: CRV_URL },
    { key: 'fanPerKW', label: 'fan input per kW cooled', value: FAN_INPUT_PER_KW_ESTIMATE, unit: 'kW/kW', sourceType: 'estimate', source: 'brochure silent (EC fans); CWA lower bound borrowed' },
    { key: 'width', label: 'unit width (1 rack position; 300 mm variants = 0.5)', value: 0.6, unit: 'm', sourceType: 'vendor-claim', source: '2000 × 600 × 1175 mm', url: CRV_URL },
    { key: 'density', label: 'in-row guidance ceiling', value: 50, unit: 'kW/rack', sourceType: 'acceptance-threshold', source: 'Uptime Intelligence, "AI and cooling: methods and capacities"' },
  ],
};

/** D — Vertiv CoolChip CDU 70 liquid-to-air sidecar. */
export const SEED_L2A_CDU70: CoolingUnitSeed = {
  id: 'seed-vertiv-coolchip-cdu70',
  product: 'Vertiv CoolChip CDU 70 (liquid-to-air sidecar)',
  unitKW: 70,
  airflowM3s: 10_100 / 3600,
  inputKW: FAN_INPUT_PER_KW_ESTIMATE * 70,
  widthM: 0.6,
  depthM: 1.2,
  heightM: 2.3,
  positionsPerUnit: 1,
  coefficients: [
    { key: 'unitKW', label: 'capacity at 11 °C approach', value: 70, unit: 'kW', sourceType: 'vendor-claim', source: 'Vertiv CoolChip CDU product page', url: CDU70_URL },
    { key: 'airflow', label: 'airflow', value: 10_100, unit: 'm³/h', sourceType: 'vendor-claim', source: 'Vertiv CoolChip CDU 70 (5,945 CFM)', url: CDU70_URL },
    { key: 'fanPerKW', label: 'fan input per kW', value: FAN_INPUT_PER_KW_ESTIMATE, unit: 'kW/kW', sourceType: 'estimate', source: 'not on product page; CWA lower bound borrowed' },
    { key: 'width', label: 'footprint 2300 × 600 × 1200 mm', value: 0.6, unit: 'm', sourceType: 'vendor-claim', source: 'Vertiv CoolChip CDU 70', url: CDU70_URL },
  ],
};

/** D (large racks) — Supermicro L2A sidecar for GB300 NVL72, 200 kW per rack. */
export const SEED_L2A_SMC200: CoolingUnitSeed = {
  id: 'seed-supermicro-l2a-200',
  product: 'Supermicro L2A sidecar (200 kW, 1 rack position)',
  unitKW: 200,
  airflowM3s: 200 * (10_100 / 3600 / 70),
  inputKW: FAN_INPUT_PER_KW_ESTIMATE * 200,
  widthM: 0.6,
  depthM: 1.2,
  heightM: 2.3,
  positionsPerUnit: 1,
  coefficients: [
    { key: 'unitKW', label: 'capacity per rack, "no facility water required"', value: 200, unit: 'kW', sourceType: 'vendor-claim', source: 'Supermicro GB300 NVL72 datasheet' },
    { key: 'airflowPerKW', label: 'airflow per kW (CDU 70 ratio)', value: 10_100 / 70, unit: 'm³/h per kW', sourceType: 'estimate', source: 'airflow not published; CoolChip CDU 70 ratio applied' },
    { key: 'fanPerKW', label: 'fan input per kW', value: FAN_INPUT_PER_KW_ESTIMATE, unit: 'kW/kW', sourceType: 'estimate', source: 'not published; CWA lower bound borrowed' },
    { key: 'positions', label: 'rack positions per unit', value: 1, unit: 'pos', sourceType: 'vendor-claim', source: 'Supermicro: 200 kW / 1 rack, 500 kW / 2 racks' },
  ],
};

/** E — Motivair ChilledDoor active rear-door heat exchanger. */
export const SEED_RDHX_CHILLEDDOOR: CoolingUnitSeed = {
  id: 'seed-motivair-chilleddoor',
  product: 'Motivair ChilledDoor (active RDHx)',
  unitKW: 75,
  airflowM3s: 0,
  inputKW: FAN_INPUT_PER_KW_ESTIMATE * 75,
  widthM: 0.6,
  depthM: 0.2,
  heightM: 2.2,
  positionsPerUnit: 0,
  coefficients: [
    { key: 'unitKW', label: 'capacity per rack (30 °C inlet water, 23 GPM)', value: 75, unit: 'kW', sourceType: 'vendor-claim', source: 'Motivair ChilledDoor technical data (HPE QuickSpecs)', url: DOOR_URL },
    { key: 'fanPerKW', label: 'door fan input per kW', value: FAN_INPUT_PER_KW_ESTIMATE, unit: 'kW/kW', sourceType: 'estimate', source: 'wattage not in QuickSpecs; CWA lower bound borrowed' },
    { key: 'depth', label: 'added rack depth', value: 0.2, unit: 'm', sourceType: 'estimate', source: '+100–300 mm typical added depth (estimate)' },
    { key: 'waterJoints', label: 'water joints per door', value: 2, unit: 'ea', sourceType: 'derived', source: 'supply + return per door (derived)' },
    { key: 'residualDT', label: 'room ΔT for residual airflow', value: 12, unit: 'K', sourceType: 'estimate', source: 'design ΔT used by packages/thermal for unspecified airflow' },
  ],
};

export const AIRFLOW_MARGIN = 1.1;
/** EC fan minimum speed ratio used in the affinity-law fan power (same floor as engines/cooling.ts). */
export const FAN_SPEED_FLOOR = 0.3;
const RHO_CP_AIR = 1.207; // kJ/m³·K (ρ 1.2 × c_p 1.006)
/** Gallery service clearance in front of wall units (m). */
export const GALLERY_SERVICE_CLEARANCE_M = 1.2;
/** Room ΔT used to size the residual airflow of the RDHx room units (K). */
export const RDHX_RESIDUAL_DT_K = 12;

/** Row constants as sourced coefficients (polish v2 2차, QA m6: no constant is used without one). */
export const TOPOLOGY_CONSTANTS: Record<'margin' | 'fanFloor' | 'service' | 'residualDT' | 'meanRack', CoolingTopologyCoefficient> = {
  margin: { key: 'airflowMargin', label: 'airflow margin on the required airflow', value: AIRFLOW_MARGIN, unit: '×', sourceType: 'derived', source: 'engines/cooling.ts CRAH count rule (1.1 × IT airflow), kept identical so the perimeter row reproduces the engine count' },
  fanFloor: { key: 'fanFloor', label: 'EC fan minimum speed ratio (affinity law floor)', value: FAN_SPEED_FLOOR, unit: '×', sourceType: 'estimate', source: 'engines/cooling.ts fan model (30 % minimum speed, typical EC fan turndown)' },
  service: { key: 'service', label: 'gallery service clearance', value: GALLERY_SERVICE_CLEARANCE_M, unit: 'm', sourceType: 'estimate', source: 'TIA-942-B 1.2 m aisle rule used as proxy (AIDC Studio estimate)' },
  residualDT: { key: 'residualDT', label: 'room ΔT for residual airflow', value: RDHX_RESIDUAL_DT_K, unit: 'K', sourceType: 'estimate', source: 'design ΔT used by packages/thermal for unspecified airflow' },
  meanRack: { key: 'meanRackKW', label: 'IT kW per lost rack position (mean IT rack nameplate of the hall)', value: 0, unit: 'kW', sourceType: 'derived', source: 'Σ IT rack nameplate ÷ IT racks of the hall' },
};

/** CDU secondary-loop (TCS) equivalent-length budget (r2-layout.md §3.3, DECISIONS-v2-2 §C). */
export const TCS_BUDGET = {
  budgetM: 80,
  warnM: 60,
  coefficients: [
    { key: 'budget', label: 'TCS full-flow equivalent route budget (6" Sch10S, 2.3 MW, 1.5 LPM/kW)', value: 80, unit: 'm', sourceType: 'derived', source: 'AIDC Studio worked example (head 38 psi MCDU-70 proxy, rack 18.4 psi, misc 8 psi)' },
    { key: 'warn', label: 'warning threshold', value: 60, unit: 'm', sourceType: 'derived', source: 'AIDC Studio rule (derived-conservative)' },
    { key: 'header', label: 'distribution header counted at 1/3 of its length', value: 1 / 3, unit: '×', sourceType: 'derived', source: '∫(1−x)² dx = 1/3 for uniform take-offs' },
  ] as CoolingTopologyCoefficient[],
};

// ───────────────────────────── helpers ─────────────────────────────

/** Catalog item tagged for a topology option (`meta.coolingTopology === option`, e.g. added by the catalog stream). */
function catalogSeedFor(option: CoolingTopologyOption, fallback: CoolingUnitSeed): CoolingUnitSeed {
  const item = catalogItems().find((i) => i.meta?.coolingTopology === option && (i.capacity?.coolingKW ?? 0) > 0);
  if (!item) return fallback;
  const unitKW = item.capacity!.coolingKW!;
  const src = item.source === 'estimate' ? 'estimate' : 'vendor-claim';
  return {
    id: item.id,
    product: item.name,
    unitKW,
    airflowM3s: item.capacity?.airflowM3s ?? (fallback.airflowM3s * unitKW) / fallback.unitKW,
    inputKW: item.power?.nameplateKW ?? FAN_INPUT_PER_KW_ESTIMATE * unitKW,
    widthM: item.dims.w,
    depthM: item.dims.d,
    heightM: item.dims.h,
    positionsPerUnit: fallback.positionsPerUnit > 0 ? item.dims.w / 0.6 : 0,
    capexUSD: item.cost?.capexUSD || undefined,
    coefficients: [
      { key: 'unitKW', label: 'capacity (catalog)', value: unitKW, unit: 'kW', sourceType: src, source: `catalog ${item.id} (${item.source})` },
      ...(item.power?.nameplateKW ? [] : [{ key: 'fanPerKW', label: 'fan input per kW', value: FAN_INPUT_PER_KW_ESTIMATE, unit: 'kW/kW', sourceType: 'estimate' as const, source: 'catalog item has no power; CWA lower bound borrowed' }]),
    ],
  };
}

/**
 * Gallery fan-wall seed = the unit "Place with this topology" puts in the hall: a catalog item tagged
 * `meta.coolingTopology = 'gallery-fan-wall'`, else the catalog fan-wall class item (stream C: vendor 'Generic' first, capacity closest to
 * 600 kW, then catalog order — never a vendor id literal), else the CWA CA80 seed.
 */
export function fanWallSeed(): CoolingUnitSeed {
  const tagged = catalogSeedFor('gallery-fan-wall', SEED_FAN_WALL_CWA80);
  if (tagged !== SEED_FAN_WALL_CWA80) return { ...tagged, coefficients: [...tagged.coefficients, SEED_FAN_WALL_CWA80.coefficients.find((c) => c.key === 'throw')!] };
  const items = catalogItems().filter((i) => i.category === 'fan-wall' && (i.capacity?.coolingKW ?? 0) > 0);
  const item = neutralFanWallItem(items);
  if (!item) return SEED_FAN_WALL_CWA80;
  const unitKW = item.capacity!.coolingKW!;
  const st = item.source === 'estimate' ? 'estimate' : 'vendor-claim';
  const airflow = item.capacity?.airflowM3s ?? (SEED_FAN_WALL_CWA80.airflowM3s * unitKW) / SEED_FAN_WALL_CWA80.unitKW;
  const inputKW = item.power?.nameplateKW ?? FAN_INPUT_PER_KW_ESTIMATE * unitKW;
  return {
    id: item.id,
    product: item.name,
    unitKW,
    airflowM3s: airflow,
    inputKW,
    widthM: item.dims.w,
    depthM: item.dims.d,
    heightM: item.dims.h,
    positionsPerUnit: 0,
    capexUSD: item.cost?.capexUSD || undefined,
    coefficients: [
      { key: 'unitKW', label: 'capacity (catalog fan-wall item)', value: unitKW, unit: 'kW', sourceType: st, source: `catalog ${item.id} (${item.source}); Liebert CWA CA80 brochure: 500 kW`, url: CWA_URL },
      { key: 'airflow', label: 'max airflow (catalog)', value: airflow, unit: 'm³/s', sourceType: item.capacity?.airflowM3s ? st : 'derived', source: `catalog ${item.id}` },
      { key: 'inputKW', label: 'unit input power (catalog nameplate)', value: inputKW, unit: 'kW', sourceType: item.power?.nameplateKW ? st : 'estimate', source: `catalog ${item.id}` },
      { key: 'fanPerKW', label: 'fan input per kW cooled', value: inputKW / unitKW, unit: 'kW/kW', sourceType: 'derived', source: `${Number(inputKW.toFixed(2))} kW ÷ ${unitKW} kW (CWA brochure range 0.035–0.043)` },
      { key: 'dims', label: 'footprint W × D', value: item.dims.w * item.dims.d, unit: 'm²', sourceType: st, source: `catalog ${item.id}: ${item.dims.w} × ${item.dims.d} m` },
      TOPOLOGY_CONSTANTS.service,
      SEED_FAN_WALL_CWA80.coefficients.find((c) => c.key === 'throw')!,
    ],
  };
}

/** Catalog item of an in-row / sidecar unit that the placement engine could put into the rows (tagged `meta.coolingTopology`). */
export function topologyUnitCatalogId(option: CoolingTopologyOption): string | undefined {
  if (option === 'gallery-fan-wall') {
    const s = fanWallSeed();
    return s === SEED_FAN_WALL_CWA80 ? undefined : s.id;
  }
  if (option === 'in-row' || option === 'sidecar-l2a') return catalogItems().find((i) => i.meta?.coolingTopology === option && (i.capacity?.coolingKW ?? 0) > 0)?.id;
  return undefined;
}

/** Perimeter CRAH seed from the project's CRAH catalog item. */
function crahSeed(project: Project): CoolingUnitSeed | undefined {
  const item = findCatalogItem(project.cooling.crahCatalogId);
  if (!item || !(item.capacity?.coolingKW ?? 0)) return undefined;
  const unitKW = item.capacity!.coolingKW!;
  const st = item.source === 'estimate' ? 'estimate' : 'vendor-claim';
  return {
    id: item.id,
    product: item.name,
    unitKW,
    airflowM3s: item.capacity?.airflowM3s ?? 0,
    inputKW: item.power?.nameplateKW ?? FAN_INPUT_PER_KW_ESTIMATE * unitKW,
    widthM: item.dims.w,
    depthM: item.dims.d + (item.clearance?.front ?? 0),
    heightM: item.dims.h,
    positionsPerUnit: 0,
    capexUSD: item.cost?.capexUSD || undefined,
    coefficients: [
      { key: 'unitKW', label: 'capacity (catalog)', value: unitKW, unit: 'kW', sourceType: st, source: `catalog ${item.id} (${item.source})` },
      { key: 'airflow', label: 'airflow (catalog)', value: item.capacity?.airflowM3s ?? 0, unit: 'm³/s', sourceType: st, source: `catalog ${item.id}` },
      { key: 'inputKW', label: 'fan input (catalog nameplate)', value: item.power?.nameplateKW ?? 0, unit: 'kW', sourceType: st, source: `catalog ${item.id}` },
      { key: 'density', label: 'perimeter air guidance ceiling', value: 25, unit: 'kW/rack', sourceType: 'acceptance-threshold', source: 'Uptime Intelligence: perimeter 20–25 kW with optimised airflow' },
      { key: 'frontClearance', label: 'front service clearance counted in white-space area', value: item.clearance?.front ?? 0, unit: 'm', sourceType: st, source: `catalog ${item.id} clearance.front` },
    ],
  };
}

/**
 * Room units behind RDHx doors (shared by the RDHx row and engines/cooling.ts, so the table and the post-placement analysis agree):
 *   room load = (residual air kW + door fan kW) · (1 + unit fan heat); airflow = load / (ρc_p · 12 K) · 1.1;
 *   units = max(redundancy(max(heat count, airflow count)), ceil((room load + largest door duty) / unit kW))  (a failed door's heat)
 */
export function rdhxRoomUnits(residualKW: number, dutyKW: number, maxDutyKW: number, crah: CatalogItem | undefined, redundancy: string): { n: number; inst: number; roomReqKW: number; doorFanKW: number; airflowM3s: number } {
  const unitKW = crah?.capacity?.coolingKW ?? 0;
  const doorFanKW = SEED_RDHX_CHILLEDDOOR.inputKW * (dutyKW / SEED_RDHX_CHILLEDDOOR.unitKW);
  if (unitKW <= 0) return { n: 0, inst: 0, roomReqKW: 0, doorFanKW, airflowM3s: 0 };
  const inputKW = crah?.power?.nameplateKW ?? FAN_INPUT_PER_KW_ESTIMATE * unitKW;
  const roomReqKW = (residualKW + doorFanKW) * (1 + inputKW / unitKW);
  const airflowM3s = (roomReqKW / (RHO_CP_AIR * RDHX_RESIDUAL_DT_K)) * AIRFLOW_MARGIN;
  const flow = crah?.capacity?.airflowM3s ?? 0;
  if (roomReqKW <= 0 && maxDutyKW <= 0) return { n: 0, inst: 0, roomReqKW, doorFanKW, airflowM3s };
  const n = Math.max(ceil(roomReqKW / unitKW), flow > 0 ? ceil(airflowM3s / flow) : 0, 1);
  return { n, inst: Math.max(redundantCount(n, redundancy), ceil((roomReqKW + maxDutyKW) / unitKW)), roomReqKW, doorFanKW, airflowM3s };
}

/** Rear-door duty of one rack: min(rated door kW, rack air kW). */
export const rdhxDoorDuty = (doorKW: number, rackAirKW: number) => Math.max(0, Math.min(doorKW, rackAirKW));
/** Equipment meta key carrying the rated kW of a rear door attached to a rack. */
export const RDHX_DOOR_META = 'rdhxDoorKW';

/** Stream C (P3): the fan-wall class item — vendor 'Generic' first, capacity closest to 600 kW, then catalog order. */
function neutralFanWallItem(items: readonly CatalogItem[]): CatalogItem | undefined {
  return [...items].map((item, k) => ({ item, k })).sort((a, b) => (a.item.vendor === 'Generic' ? 0 : 1) - (b.item.vendor === 'Generic' ? 0 : 1) || Math.abs((a.item.capacity?.coolingKW ?? 0) - 600) - Math.abs((b.item.capacity?.coolingKW ?? 0) - 600) || a.k - b.k)[0]?.item;
}

/** Catalog $/kW of the fan-wall class item (estimate) — scales the CWA price. */
function fanWallCapex(seed: CoolingUnitSeed): number | undefined {
  if (seed.capexUSD) return seed.capexUSD;
  const fw = neutralFanWallItem(catalogItems().filter((i) => i.category === 'fan-wall' && (i.capacity?.coolingKW ?? 0) > 0));
  const kw = fw?.capacity?.coolingKW ?? 0;
  return fw?.cost?.capexUSD && kw > 0 ? (fw.cost.capexUSD / kw) * seed.unitKW : undefined;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const ceil = (v: number) => (v > 0 ? Math.ceil(v - 1e-9) : 0);

function fanKWFor(units: number, seed: CoolingUnitSeed, airflowReq: number): number {
  if (units <= 0) return 0;
  const ratio = seed.airflowM3s > 0 ? clamp(airflowReq / (units * seed.airflowM3s), FAN_SPEED_FLOOR, 1) : 1;
  return units * seed.inputKW * ratio ** 3;
}

function unitCount(heatKW: number, airflow: number, seed: CoolingUnitSeed, redundancy: string): { n: number; inst: number } {
  if (heatKW <= 0 && airflow <= 0) return { n: 0, inst: 0 };
  const n = Math.max(ceil(heatKW / seed.unitKW), seed.airflowM3s > 0 ? ceil(airflow / seed.airflowM3s) : 0, 1);
  return { n, inst: redundantCount(n, redundancy) };
}

interface RackIn {
  e: EquipmentInstance;
  item: CatalogItem;
  kw: number;
  liquidKW: number;
  airKW: number;
  airflow: number;
  group: string;
}

interface HallIn {
  hall: Hall;
  racks: RackIn[];
  airKW: number;
  liquidKW: number;
  airflow: number;
  residualAirKW: number;
  residualAirflow: number;
  meanRackKW: number;
}

function hallInputs(project: Project, analysis: ProjectAnalysis, hall: Hall): HallIn | undefined {
  const ph = analysis.cooling.perHall?.find((h) => h.hallId === hall.id);
  if (!ph || ph.airKW + ph.liquidKW <= 0) return undefined;
  const loads = new Map((analysis.network.rackLoads ?? []).map((r) => [r.rackId, r]));
  const supplyC = project.cooling.supplyAirC;
  const racks: RackIn[] = [];
  for (const e of project.equipment) {
    if (e.hallId !== hall.id) continue;
    const item = findCatalogItem(e.catalogId);
    if (!item) continue;
    const it = IT_LOAD_CATEGORIES.has(item.category);
    const rl = item.category === 'network-rack' ? loads.get(e.id) : undefined;
    if (!it && !rl) continue;
    const kw = it ? (item.power?.nameplateKW ?? 0) : rl!.kw;
    const lf = it ? (item.cooling?.liquidFraction ?? 0) : 0;
    const airflow = it
      ? interpCurve(item.cooling?.airflowCurve, supplyC, item.cooling?.airflowM3s ?? 0)
      : rl!.switches.reduce((s, sw) => s + (findCatalogItem(sw.catalogId)?.cooling?.airflowM3s ?? 0) * sw.count, 0);
    racks.push({ e, item, kw, liquidKW: kw * lf, airKW: kw * (1 - lf), airflow, group: e.podId ?? 'hall-shared' });
  }
  const sumAir = racks.reduce((s, r) => s + r.airKW, 0);
  const sumFlow = racks.reduce((s, r) => s + r.airflow, 0);
  const itRacks = racks.filter((r) => IT_LOAD_CATEGORIES.has(r.item.category) && r.kw > 0);
  return {
    hall,
    racks,
    airKW: ph.airKW,
    liquidKW: ph.liquidKW,
    airflow: ph.airflowRequiredM3s,
    residualAirKW: Math.max(0, ph.airKW - sumAir),
    residualAirflow: Math.max(0, ph.airflowRequiredM3s - sumFlow),
    meanRackKW: itRacks.length ? itRacks.reduce((s, r) => s + r.kw, 0) / itRacks.length : 0,
  };
}

/** The topology option matching the hall's current air-side strategy (placed catalog items tagged `meta.coolingTopology` win). */
export function currentCoolingTopology(project: Project, hall: Hall): CoolingTopologyOption {
  for (const e of project.equipment) {
    if (e.hallId !== hall.id) continue;
    if (Number(e.meta?.[RDHX_DOOR_META] ?? 0) > 0) return 'rdhx';
    const tag = findCatalogItem(e.catalogId)?.meta?.coolingTopology;
    if (typeof tag === 'string' && (COOLING_TOPOLOGY_OPTIONS as string[]).includes(tag)) return tag as CoolingTopologyOption;
  }
  const strategy = hall.coolingPlacement?.crahStrategy ?? hall.layoutPolicy?.crahStrategy ?? 'perimeter';
  if (strategy === 'gallery-fan-wall') return 'gallery-fan-wall';
  if (strategy === 'in-row' || strategy === 'per-pod') return 'in-row';
  const fanWalls = project.equipment.some((e) => e.hallId === hall.id && findCatalogItem(e.catalogId)?.category === 'fan-wall');
  return fanWalls ? 'gallery-fan-wall' : 'perimeter-crah';
}

/** Placement options plus the unit catalog id (CoolingPlacementOptions.crahCatalogId, added by the layout stream; typed locally so this
 *  file compiles with or without the field). */
export type TopologyPlacementOptions = CoolingPlacementOptions & { crahCatalogId?: string };

/**
 * regenerateCooling options that realise a topology (undefined = no layout strategy exists, e.g. RDHx doors).
 * With `row` (the comparison row) the unit count is the row's room-unit count, so the placed result matches the table.
 */
export function topologyPlacementOptions(option: CoolingTopologyOption, base: CoolingPlacementOptions, row?: Pick<CoolingTopologyRow, 'units' | 'rackUnits'>): TopologyPlacementOptions | undefined {
  const { crahCatalogId: _drop, ...b } = base as TopologyPlacementOptions;
  void _drop;
  const count = row ? { crahCount: row.units - (row.rackUnits ?? 0) } : {};
  const unit = (o: CoolingTopologyOption) => {
    const id = topologyUnitCatalogId(o);
    return id ? { crahCatalogId: id } : {};
  };
  switch (option) {
    case 'gallery-fan-wall':
      return { ...b, cduPlacement: 'gallery', crahStrategy: 'gallery-fan-wall', ...unit(option), ...count };
    case 'perimeter-crah':
      return { ...b, cduPlacement: b.cduPlacement === 'gallery' ? 'row-ends' : b.cduPlacement, crahStrategy: 'perimeter', ...count };
    case 'in-row':
      return { ...b, crahStrategy: 'in-row', ...unit(option), ...count };
    case 'sidecar-l2a':
      return { ...b, crahStrategy: 'per-pod', ...unit(option) };
    default:
      return undefined;
  }
}

/** Minimal shape of layout/coolingPlacement's report used here (injected to avoid an engines ↔ layout import cycle). */
export interface TopologyRegenReport {
  project: Project;
  issues: { severity: string; id: string }[];
  requiresRegenerate?: boolean;
}
export type TopologyRegen = (project: Project, hallId: string, opts: CoolingPlacementOptions) => TopologyRegenReport;

export interface TopologyPlacementPlan {
  option: CoolingTopologyOption;
  /** the button can place this topology */
  available: boolean;
  /** i18n key (cooling.* namespace): why placement is disabled, or what differs from the compared row */
  reason?: string;
  /** options for the placement draft (gallery / perimeter / in-row / sidecar) */
  opts?: TopologyPlacementOptions;
  /** the placed project (always for RDHx; for the others the cooling-only regeneration result) */
  project?: Project;
  /** the placed units are the compared units (catalog item and count) */
  matchesRow: boolean;
  placedUnits: number;
  placedKW: number;
  doors?: number;
}

const isRoomUnit = (cat?: string) => cat === 'crah' || cat === 'fan-wall';

/** Remove RDHx door meta from the racks of a hall (placing another topology). */
export function stripRdhxDoors(project: Project, hallId: string): Project {
  if (!project.equipment.some((e) => e.hallId === hallId && e.meta?.[RDHX_DOOR_META] !== undefined)) return project;
  return {
    ...project,
    equipment: project.equipment.map((e) => {
      if (e.hallId !== hallId || e.meta?.[RDHX_DOOR_META] === undefined) return e;
      const { [RDHX_DOOR_META]: _k, rdhxModel: _m, ...meta } = e.meta;
      void _k;
      void _m;
      return { ...e, meta };
    }),
  };
}

/**
 * What "Place with this topology" does for one comparison row (polish v2 2차, QA M4):
 *   gallery fan wall → gallery CDUs + `row.units` fan-wall units (crahCatalogId) when the layout engine honours the catalog id;
 *   perimeter CRAH   → `row.units` CRAHs of the project model;
 *   in-row / sidecar → only when a tagged unit exists AND the layout engine places every unit in the existing rows (no regeneration);
 *   RDHx             → rated doors in the rack meta (racks do not move) + the row's room CRAHs on the walls.
 * `regen` = layout/coolingPlacement.regenerateCoolingReport.
 */
export function planTopologyPlacement(project: Project, analysis: ProjectAnalysis, hallId: string, row: CoolingTopologyRow, base: CoolingPlacementOptions, regen: TopologyRegen): TopologyPlacementPlan {
  const hall = project.halls.find((h) => h.id === hallId);
  const none = (reason: string): TopologyPlacementPlan => ({ option: row.option, available: false, reason, matchesRow: false, placedUnits: 0, placedKW: 0 });
  if (!hall) return none('cooling.cfd.variant.noHall');
  const count = (p: Project, catalogId?: string) => {
    let n = 0;
    let kw = 0;
    for (const e of p.equipment) {
      if (e.hallId !== hallId) continue;
      const item = findCatalogItem(e.catalogId);
      if (!isRoomUnit(item?.category) || (catalogId && e.catalogId !== catalogId)) continue;
      n++;
      kw += item?.capacity?.coolingKW ?? 0;
    }
    return { n, kw };
  };
  if (row.option === 'rdhx') {
    const doorKW = row.rackUnitKW ?? SEED_RDHX_CHILLEDDOOR.unitKW;
    const roomUnits = row.units - (row.rackUnits ?? 0);
    const rep = regen(stripRdhxDoors(project, hallId), hallId, { ...(topologyPlacementOptions('perimeter-crah', base) as CoolingPlacementOptions), crahCount: roomUnits });
    if (rep.requiresRegenerate || rep.issues.some((i) => i.severity === 'error')) return { ...none('cooling.topo.place.regenErrors'), project: rep.project };
    const hin = hallInputs(project, analysis, hall);
    const racks = new Set((hin?.racks ?? []).filter((r) => r.airKW > 0).map((r) => r.e.id));
    const placed: Project = {
      ...rep.project,
      equipment: rep.project.equipment.map((e) => (racks.has(e.id) ? { ...e, meta: { ...(e.meta ?? {}), [RDHX_DOOR_META]: doorKW, rdhxModel: SEED_RDHX_CHILLEDDOOR.id } } : e)),
    };
    const c = count(placed);
    return { option: 'rdhx', available: true, project: placed, matchesRow: c.n === roomUnits && racks.size === (row.rackUnits ?? 0), placedUnits: c.n + racks.size, placedKW: c.kw + racks.size * doorKW, doors: racks.size };
  }
  const opts = topologyPlacementOptions(row.option, base, row);
  if (!opts) return none('cooling.topo.noStrategy');
  const rowUnit = opts.crahCatalogId;
  if ((row.option === 'in-row' || row.option === 'sidecar-l2a') && !rowUnit) return { ...none('cooling.topo.unitClassPending'), opts };
  let rep: TopologyRegenReport;
  try {
    rep = regen(stripRdhxDoors(project, hallId), hallId, opts);
  } catch {
    return { ...none('cooling.cfd.variant.regenFailed'), opts };
  }
  const want = row.units - (row.rackUnits ?? 0);
  const c = count(rep.project, rowUnit);
  const honoured = rep.project !== project && !rep.requiresRegenerate && c.n === want;
  if (row.option === 'in-row' || row.option === 'sidecar-l2a') {
    // enabled only when the layout engine extends the rows in place with the compared unit
    if (!honoured) return { ...none(rep.requiresRegenerate ? 'cooling.topo.inPlacePending' : 'cooling.topo.unitClassPending'), opts };
    return { option: row.option, available: true, opts, project: rep.project, matchesRow: true, placedUnits: c.n, placedKW: c.kw };
  }
  const all = count(rep.project);
  return {
    option: row.option,
    available: true,
    opts,
    project: rep.project,
    matchesRow: honoured,
    ...(honoured ? {} : { reason: row.option === 'gallery-fan-wall' ? 'cooling.topo.galleryCrahClass' : 'cooling.topo.place.countDiffers' }),
    placedUnits: all.n,
    placedKW: all.kw,
  };
}

/** Coefficient list plus the named row constants (deduplicated by key). */
function withConstants(list: CoolingTopologyCoefficient[], ...extra: (keyof typeof TOPOLOGY_CONSTANTS | CoolingTopologyCoefficient)[]): CoolingTopologyCoefficient[] {
  const out = [...list];
  for (const x of extra) {
    const c = typeof x === 'string' ? TOPOLOGY_CONSTANTS[x] : x;
    if (!out.some((o) => o.key === c.key)) out.push(c);
  }
  return out;
}

type Note = { en: string; key: string; params?: Record<string, string | number> };
const note = (key: string, en: string, params?: Record<string, string | number>): Note => ({ key, en, params });

function finishRow(
  hallId: string | undefined,
  option: CoolingTopologyOption,
  r: Omit<CoolingTopologyRow, 'option' | 'notes' | 'noteIds' | 'relativeCost' | 'hallId'> & { costUSD: number },
  notes: Note[],
): CoolingTopologyRow & { costUSD: number } {
  return {
    option,
    ...(hallId ? { hallId } : {}),
    ...r,
    relativeCost: 0,
    notes: notes.map((n) => n.en),
    noteIds: notes.map((n) => ({ key: n.key, ...(n.params ? { params: n.params } : {}) })),
  };
}

const pct = (inst: number, req: number) => (req > 0 ? ((inst - req) / req) * 100 : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;

// ───────────────────────────── per hall ─────────────────────────────

/** One row per topology option for a single hall (empty when the hall carries no IT heat). */
export function compareCoolingTopologiesForHall(project: Project, analysis: ProjectAnalysis, hallId: string): CoolingTopologyRow[] {
  const hall = project.halls.find((h) => h.id === hallId);
  if (!hall) return [];
  const hin = hallInputs(project, analysis, hall);
  if (!hin) return [];
  return hallRows(project, hin).map(({ costUSD, ...row }) => {
    void costUSD;
    return row;
  });
}

function hallRows(project: Project, h: HallIn): (CoolingTopologyRow & { costUSD: number })[] {
  const red = project.cooling.crahRedundancy;
  const current = currentCoolingTopology(project, h.hall);
  const crah = crahSeed(project);
  const crahPerKW = crah?.capexUSD ? crah.capexUSD / crah.unitKW : undefined;
  const placeholder = (seed: CoolingUnitSeed) => seed.capexUSD ?? (crahPerKW !== undefined ? crahPerKW * seed.unitKW : 0);
  const rows: (CoolingTopologyRow & { costUSD: number })[] = [];
  const orient = h.hall.layoutPolicy?.orientation ?? (h.hall.width >= h.hall.depth ? 'x' : 'y');
  const maxRackAir = h.racks.reduce((m, r) => Math.max(m, r.airKW), 0);

  // A — gallery fan wall (hall-level N+1)
  {
    const s = fanWallSeed();
    const fanHeat = s.inputKW / s.unitKW;
    const req = h.airKW * (1 + fanHeat);
    const V = h.airflow * AIRFLOW_MARGIN;
    const { n, inst } = unitCount(req, V, s, red);
    const throwLen = orient === 'x' ? h.hall.width : h.hall.depth;
    const wallLen = orient === 'x' ? h.hall.depth : h.hall.width;
    const walls = throwLen > 18 ? 2 : 1;
    const maxUnits = walls * Math.floor(wallLen / s.widthM);
    const price = fanWallCapex(s);
    const notes: Note[] = [note('cooling.topo.note.galleryHallN1', 'Hall-level shared N+1; units serviced from the gallery, chilled water stays out of the white space.')];
    if (walls === 2) notes.push(note('cooling.topo.note.throwBoth', `Row-axis length ${r1(throwLen)} m exceeds the 18 m throw — fan walls on both row-end walls.`, { len: r1(throwLen) }));
    if (inst > maxUnits) notes.push(note('cooling.topo.note.wallShort', `${inst} units need ${r1(inst * s.widthM)} m of wall; ${walls} row-end wall(s) offer ${r1(walls * wallLen)} m.`, { units: inst, need: r1(inst * s.widthM), have: r1(walls * wallLen) }));
    rows.push(finishRow(h.hall.id, 'gallery-fan-wall', {
      units: inst, unitsN: n, unitKW: s.unitKW, unitLabel: s.product, installedKW: inst * s.unitKW, requiredKW: req, sparePct: pct(inst * s.unitKW, req),
      worstFailureResidualPct: req > 0 ? (((inst - 1) * s.unitKW) / req) * 100 : 0, worstFailureUnit: s.product, positionsLost: 0, itKWDisplaced: 0,
      galleryM2: inst * s.widthM * (s.depthM + GALLERY_SERVICE_CLEARANCE_M), whiteSpaceM2: 0, fanKW: fanKWFor(inst, s, V), waterJoints: 0, facilityWaterInHall: false,
      redundancyGroup: 'hall', current: current === 'gallery-fan-wall', costUSD: inst * (price ?? 0), costBasis: price !== undefined && s.capexUSD ? 'catalog' : 'estimate',
      coefficients: withConstants(s.coefficients, 'margin', 'fanFloor', 'service'), source: `${s.product} — ${s === SEED_FAN_WALL_CWA80 ? 'vendor-claim seed' : 'placeable catalog fan-wall item'}; fan input per kW derived; price = catalog fan-wall class $/kW (${s.capexUSD ? 'catalog' : 'estimate'})`,
    }, notes));
  }

  // B — perimeter CRAH (hall-level)
  if (crah) {
    const s = crah;
    const fanHeat = s.inputKW / s.unitKW;
    const req = h.airKW * (1 + fanHeat);
    const V = h.airflow * AIRFLOW_MARGIN;
    const { n, inst } = unitCount(req, V, s, red);
    const notes: Note[] = [note('cooling.topo.note.perimeter', 'Units on the walls perpendicular to the rows (TIA-942-B Annex C); no rack positions, takes white-space floor area.')];
    if (maxRackAir > 25) notes.push(note('cooling.topo.note.perimeterDensity', `Max rack air load ${r1(maxRackAir)} kW exceeds the 20–25 kW perimeter guidance.`, { kw: r1(maxRackAir) }));
    rows.push(finishRow(h.hall.id, 'perimeter-crah', {
      units: inst, unitsN: n, unitKW: s.unitKW, unitLabel: s.product, installedKW: inst * s.unitKW, requiredKW: req, sparePct: pct(inst * s.unitKW, req),
      worstFailureResidualPct: req > 0 ? (((inst - 1) * s.unitKW) / req) * 100 : 0, worstFailureUnit: s.product, positionsLost: 0, itKWDisplaced: 0,
      galleryM2: 0, whiteSpaceM2: inst * s.widthM * s.depthM, fanKW: fanKWFor(inst, s, V), waterJoints: 0, facilityWaterInHall: false,
      redundancyGroup: 'hall', current: current === 'perimeter-crah', costUSD: inst * (s.capexUSD ?? 0), costBasis: s.capexUSD ? 'catalog' : 'estimate',
      coefficients: withConstants(s.coefficients, 'margin', 'fanFloor'), source: `${s.product} — project CRAH catalog item`,
    }, notes));
  }

  // C — in-row (per pod / contained aisle)
  {
    const s = catalogSeedFor('in-row', SEED_INROW_CRV050);
    const fanHeat = s.inputKW / s.unitKW;
    const groups = new Map<string, { air: number; flow: number }>();
    for (const r of h.racks) {
      const g = groups.get(r.group) ?? { air: 0, flow: 0 };
      g.air += r.airKW;
      g.flow += r.airflow;
      groups.set(r.group, g);
    }
    const sumAir = [...groups.values()].reduce((a, g) => a + g.air, 0);
    const sumFlow = [...groups.values()].reduce((a, g) => a + g.flow, 0);
    let inst = 0, n = 0, req = 0, fan = 0, worst = Infinity;
    for (const g of groups.values()) {
      const air = (g.air + (sumAir > 0 ? (h.residualAirKW * g.air) / sumAir : 0)) * (1 + fanHeat);
      const flow = (g.flow + (sumFlow > 0 ? (h.residualAirflow * g.flow) / sumFlow : 0)) * AIRFLOW_MARGIN;
      const u = unitCount(air, flow, s, red);
      inst += u.inst;
      n += u.n;
      req += air;
      fan += fanKWFor(u.inst, s, flow);
      if (air > 0) worst = Math.min(worst, (((u.inst - 1) * s.unitKW) / air) * 100);
    }
    const positions = inst * s.positionsPerUnit;
    const notes: Note[] = [
      note('cooling.topo.note.inrowPods', `Per-pod N+1 over ${groups.size} groups; units take row positions (${r1(positions)} at 600 mm pitch).`, { groups: groups.size, positions: r1(positions) }),
      note('cooling.topo.note.inrowWater', 'Chilled water piped to every row (2 joints per unit) — leak detection per row.'),
    ];
    if (maxRackAir > 50) notes.push(note('cooling.topo.note.inrowDensity', `Max rack air load ${r1(maxRackAir)} kW exceeds the 50 kW in-row guidance.`, { kw: r1(maxRackAir) }));
    rows.push(finishRow(h.hall.id, 'in-row', {
      units: inst, unitsN: n, unitKW: s.unitKW, unitLabel: s.product, installedKW: inst * s.unitKW, requiredKW: req, sparePct: pct(inst * s.unitKW, req),
      worstFailureResidualPct: Number.isFinite(worst) ? worst : 0, worstFailureUnit: s.product, positionsLost: positions, itKWDisplaced: positions * h.meanRackKW,
      galleryM2: 0, whiteSpaceM2: 0, fanKW: fan, waterJoints: 2 * inst, facilityWaterInHall: true,
      redundancyGroup: 'pod', current: current === 'in-row', costUSD: inst * placeholder(s), costBasis: s.capexUSD ? 'catalog' : 'estimate',
      coefficients: withConstants(s.coefficients, 'margin', 'fanFloor', { ...TOPOLOGY_CONSTANTS.meanRack, value: h.meanRackKW }), source: `${s.product} — vendor-claim capacity/airflow; fan input estimate; price placeholder at CRAH $/kW (estimate)`,
    }, notes));
  }

  // D — liquid-to-air sidecars (rack) + room fan wall for ALL heat
  {
    const small = catalogSeedFor('sidecar-l2a', SEED_L2A_CDU70);
    const large = SEED_L2A_SMC200;
    let rackUnits = 0, positions = 0, sideFan = 0, sideFlow = 0, sideCost = 0, worst = Infinity, liquidServed = 0;
    let bigUsed = false;
    for (const r of h.racks) {
      if (r.liquidKW <= 0) continue;
      const nS = ceil(r.liquidKW / small.unitKW);
      const nL = ceil(r.liquidKW / large.unitKW);
      const useLarge = nL * large.positionsPerUnit < nS * small.positionsPerUnit;
      const s = useLarge ? large : small;
      const k = useLarge ? nL : nS;
      bigUsed ||= useLarge;
      rackUnits += k;
      positions += k * s.positionsPerUnit;
      sideFan += k * s.inputKW * clamp(r.liquidKW / (k * s.unitKW), FAN_SPEED_FLOOR, 1) ** 3;
      sideFlow += (s.airflowM3s * r.liquidKW) / s.unitKW;
      sideCost += k * placeholder(s);
      liquidServed += r.liquidKW;
      worst = Math.min(worst, (((k - 1) * s.unitKW) / r.liquidKW) * 100);
    }
    const room = fanWallSeed();
    const req = (h.airKW + h.liquidKW + sideFan) * (1 + room.inputKW / room.unitKW);
    const V = (h.airflow + sideFlow) * AIRFLOW_MARGIN;
    const { n, inst } = unitCount(req, V, room, red);
    const roomPrice = fanWallCapex(room) ?? 0;
    const notes: Note[] = [
      note('cooling.topo.note.l2aRoom', `Sidecars relocate heat: the room air system must carry 100 % of rack heat (${r1(req / 1000)} MW) — ${inst} fan-wall units.`, { mw: r1(req / 1000), units: inst }),
      note('cooling.topo.note.l2aNoWater', 'No facility water to the racks; L2L CDUs are not needed (their cost is not credited here).'),
    ];
    if (worst <= 0) notes.push(note('cooling.topo.note.l2aNoRedundancy', 'One sidecar per rack: no rack-level redundancy unless dual pumps/fans.'));
    if (bigUsed) notes.push(note('cooling.topo.note.l2aLarge', 'Racks above 70 kW liquid use the 200 kW / 1-position class (CDU 70 would need several positions).'));
    // largest single unit = the room fan wall (≥ 200 kW sidecar); a failed sidecar is the per-rack note above
    const rackKW = bigUsed ? large.unitKW : small.unitKW;
    const largestIsRoom = room.unitKW >= rackKW || rackUnits === 0;
    rows.push(finishRow(h.hall.id, 'sidecar-l2a', {
      units: rackUnits + inst, unitsN: n, unitKW: room.unitKW, unitLabel: `${bigUsed ? large.product : small.product} + ${room.product}`,
      rackUnits, rackUnitKW: rackKW,
      installedKW: inst * room.unitKW, requiredKW: req, sparePct: pct(inst * room.unitKW, req),
      worstFailureResidualPct: largestIsRoom ? (req > 0 ? (((inst - 1) * room.unitKW) / req) * 100 : 0) : Number.isFinite(worst) ? Math.max(0, worst) : 0,
      worstFailureUnit: largestIsRoom ? room.product : bigUsed ? large.product : small.product,
      positionsLost: positions, itKWDisplaced: positions * h.meanRackKW,
      galleryM2: inst * room.widthM * (room.depthM + GALLERY_SERVICE_CLEARANCE_M), whiteSpaceM2: 0, fanKW: sideFan + fanKWFor(inst, room, V), waterJoints: 0, facilityWaterInHall: false,
      redundancyGroup: 'rack', current: current === 'sidecar-l2a', costUSD: sideCost + inst * roomPrice, costBasis: 'estimate',
      coefficients: withConstants([...(bigUsed ? large.coefficients : small.coefficients), ...room.coefficients.filter((c) => c.key !== 'throw')], 'margin', 'fanFloor', { ...TOPOLOGY_CONSTANTS.meanRack, value: h.meanRackKW }),
      source: `${small.product} / ${large.product} — vendor-claim capacity; airflow per kW and fan input estimate; room system = ${room.product}`,
    }, notes));
  }

  // E — RDHx doors (rack) + perimeter CRAHs for the residual
  if (crah) {
    const d = catalogSeedFor('rdhx', SEED_RDHX_CHILLEDDOOR);
    let doors = 0, doorKW = 0, maxDoor = 0, residual = h.residualAirKW, totalAir = h.residualAirKW;
    for (const r of h.racks) {
      totalAir += r.airKW;
      if (r.airKW <= 0) continue;
      const q = Math.min(d.unitKW, r.airKW);
      doors++;
      doorKW += q;
      maxDoor = Math.max(maxDoor, q);
      residual += r.airKW - q;
    }
    const s = crah;
    const ru = rdhxRoomUnits(residual, doorKW, maxDoor, findCatalogItem(project.cooling.crahCatalogId), red);
    const doorFan = ru.doorFanKW;
    const roomReq = ru.roomReqKW;
    const V = ru.airflowM3s;
    const u = { n: ru.n, inst: ru.inst };
    const inst = ru.inst;
    const req = totalAir + doorFan;
    // polish v2 2차 (QA m6): installed = rated door capacity + room units; the door duty (Σ min(door, rack air)) is reported separately
    const installed = doors * d.unitKW + inst * s.unitKW;
    const notes: Note[] = [
      note('cooling.topo.note.rdhxResidual', `Doors remove ${r1(doorKW / 1000)} MW at the exhaust; perimeter CRAHs carry the ${r1(roomReq)} kW residual and a failed door (${r1(maxDoor)} kW).`, { mw: r1(doorKW / 1000), kw: r1(roomReq), door: r1(maxDoor) }),
      note('cooling.topo.note.rdhxDepth', 'Door adds 100–300 mm rack depth (check hot-aisle width); 2 water joints per door; water ≥ dew point + 2 °C.'),
    ];
    if (h.racks.some((r) => r.item.id.includes('nvl72'))) notes.push(note('cooling.topo.note.rdhxNvl72', 'NVL72 racks already carry rear manifolds / QDs — per-rack RDHx is rarely chosen for NVL72 halls.'));
    rows.push(finishRow(h.hall.id, 'rdhx', {
      units: doors + inst, unitsN: u.n, unitKW: s.unitKW, unitLabel: `${d.product} + ${s.product}`, rackUnits: doors, rackUnitKW: d.unitKW, rackDutyKW: doorKW,
      installedKW: installed, requiredKW: req, sparePct: pct(installed, req),
      // largest single unit = a room CRAH (≥ a 75 kW door): remaining room capacity ÷ room load (a failed door is covered by the sizing rule)
      worstFailureResidualPct: s.unitKW >= d.unitKW ? (roomReq > 0 ? (((inst - 1) * s.unitKW) / roomReq) * 100 : 0) : roomReq + maxDoor > 0 ? ((inst * s.unitKW) / (roomReq + maxDoor)) * 100 : 0,
      worstFailureUnit: s.unitKW >= d.unitKW ? s.product : d.product,
      positionsLost: 0, itKWDisplaced: 0,
      galleryM2: 0, whiteSpaceM2: inst * s.widthM * s.depthM, fanKW: doorFan + fanKWFor(inst, s, V), waterJoints: 2 * doors, facilityWaterInHall: true,
      redundancyGroup: 'rack', current: current === 'rdhx', costUSD: doors * placeholder(d) + inst * (s.capexUSD ?? 0), costBasis: 'estimate',
      coefficients: withConstants([...d.coefficients.filter((c) => c.key !== 'residualDT'), ...s.coefficients.filter((c) => c.key === 'unitKW' || c.key === 'frontClearance')], 'margin', 'fanFloor', 'residualDT'),
      source: `${d.product} — vendor-claim capacity; fan input estimate; residual on ${s.product}; door price placeholder at CRAH $/kW (estimate)`,
    }, notes));
  }

  // relative cost index: gallery fan wall = 1.00 (lowest $/kW for large halls)
  const base = rows.find((r) => r.option === 'gallery-fan-wall')?.costUSD || Math.min(...rows.map((r) => r.costUSD).filter((c) => c > 0));
  for (const r of rows) r.relativeCost = base > 0 && Number.isFinite(base) ? r.costUSD / base : 0;
  return rows;
}

// ───────────────────────────── project aggregate ─────────────────────────────

export function compareCoolingTopologies(project: Project, analysis: ProjectAnalysis): CoolingTopologyRow[] {
  const perHall = project.halls.map((hall) => hallInputs(project, analysis, hall)).filter((h): h is HallIn => !!h).map((h) => hallRows(project, h));
  if (!perHall.length) return [];
  if (perHall.length === 1) return perHall[0].map(({ costUSD, hallId, ...row }) => { void costUSD; void hallId; return row; });
  const out: (CoolingTopologyRow & { costUSD: number })[] = [];
  for (const option of COOLING_TOPOLOGY_OPTIONS) {
    const rows = perHall.map((rs) => rs.find((r) => r.option === option)).filter((r): r is CoolingTopologyRow & { costUSD: number } => !!r);
    if (!rows.length) continue;
    const sum = (k: keyof CoolingTopologyRow) => rows.reduce((s, r) => s + ((r[k] as number | undefined) ?? 0), 0);
    const installedKW = sum('installedKW');
    const requiredKW = sum('requiredKW');
    const seen = new Set<string>();
    const notes: string[] = [];
    const noteIds: NonNullable<CoolingTopologyRow['noteIds']> = [];
    for (const r of rows)
      r.noteIds?.forEach((n, i) => {
        const id = n.key + JSON.stringify(n.params ?? {});
        if (seen.has(id)) return;
        seen.add(id);
        noteIds.push(n);
        notes.push(r.notes[i]);
      });
    out.push({
      ...rows[0],
      hallId: undefined,
      units: sum('units'),
      unitsN: sum('unitsN'),
      rackUnits: sum('rackUnits'),
      ...(rows.some((r) => r.rackDutyKW !== undefined) ? { rackDutyKW: sum('rackDutyKW') } : {}),
      installedKW,
      requiredKW,
      sparePct: pct(installedKW, requiredKW),
      worstFailureResidualPct: Math.min(...rows.map((r) => r.worstFailureResidualPct ?? 0)),
      positionsLost: sum('positionsLost'),
      itKWDisplaced: sum('itKWDisplaced'),
      galleryM2: sum('galleryM2'),
      whiteSpaceM2: sum('whiteSpaceM2'),
      fanKW: sum('fanKW'),
      waterJoints: sum('waterJoints'),
      current: rows.every((r) => r.current),
      costUSD: rows.reduce((s, r) => s + r.costUSD, 0),
      costBasis: rows.every((r) => r.costBasis === 'catalog') ? 'catalog' : 'estimate',
      notes,
      noteIds,
    });
  }
  const base = out.find((r) => r.option === 'gallery-fan-wall')?.costUSD ?? 0;
  return out.map(({ costUSD, hallId, ...row }) => {
    void hallId;
    return { ...row, relativeCost: base > 0 ? costUSD / base : 0 };
  });
}

// ───────────────────────────── CDU secondary loop (TCS) budget ─────────────────────────────

export interface TcsLoopEstimate {
  podId: string;
  /** full-flow equivalent route length: trunk + header/3 (m) */
  equivalentM: number;
  trunkM: number;
  headerM: number;
  status: 'ok' | 'warn' | 'over';
}

/**
 * Deterministic TCS route estimate per pod for a CDU placement (r2-layout.md §3.3).
 *   row-ends: each end CDU feeds half the row → header = L/2, trunk ≈ 0
 *   ends-center: header = L/4
 *   gallery: trunk = distance from the nearer row-end gallery wall to the pod, header = L (fed from one end)
 */
export function tcsLoopBudget(project: Project, hallId: string, placement: CoolingPlacementOptions['cduPlacement']): TcsLoopEstimate[] {
  const hall = project.halls.find((h) => h.id === hallId);
  if (!hall) return [];
  const orient = hall.layoutPolicy?.orientation ?? 'x';
  const boxes = new Map<string, { a0: number; a1: number }>();
  for (const e of project.equipment) {
    if (e.hallId !== hallId || !e.podId) continue;
    const item = findCatalogItem(e.catalogId);
    if (!item || !IT_LOAD_CATEGORIES.has(item.category) || (item.cooling?.liquidFraction ?? 0) <= 0) continue;
    const along = orient === 'x' ? e.position.x : e.position.y;
    const half = (e.rotationDeg === 90 || e.rotationDeg === 270 ? (orient === 'x' ? item.dims.d : item.dims.w) : orient === 'x' ? item.dims.w : item.dims.d) / 2;
    const b = boxes.get(e.podId) ?? { a0: Infinity, a1: -Infinity };
    b.a0 = Math.min(b.a0, along - half);
    b.a1 = Math.max(b.a1, along + half);
    boxes.set(e.podId, b);
  }
  const hallLen = orient === 'x' ? hall.width : hall.depth;
  const walls = hall.coolingPlacement?.crahWalls ?? hall.layoutPolicy?.crahWalls;
  const lowWall = orient === 'x' ? 'W' : 'S';
  const highWall = orient === 'x' ? 'E' : 'N';
  const useLow = !walls || walls.includes(lowWall) || !walls.includes(highWall);
  const useHigh = !walls || walls.includes(highWall) || !walls.includes(lowWall);
  return [...boxes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([podId, b]) => {
      const L = Math.max(0, b.a1 - b.a0);
      let trunkM = 0;
      let headerM = L / 2;
      if (placement === 'ends-center') headerM = L / 4;
      if (placement === 'gallery') {
        const dLow = useLow ? b.a0 : Infinity;
        const dHigh = useHigh ? hallLen - b.a1 : Infinity;
        trunkM = Math.max(0, Math.min(dLow, dHigh));
        headerM = L;
      }
      const equivalentM = trunkM + headerM / 3;
      return { podId, equivalentM, trunkM, headerM, status: equivalentM > TCS_BUDGET.budgetM ? 'over' : equivalentM > TCS_BUDGET.warnM ? 'warn' : 'ok' };
    });
}
