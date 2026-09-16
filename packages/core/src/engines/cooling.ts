import { findCatalogItem, interpCurve } from '../catalog/catalog.ts';
import { canonicalConnector } from '../catalog/aliases.ts';
import type { CatalogItem, CoolingAnalysis, Hall, NetworkAnalysis, Project } from '../model/types.ts';
import { buildPowerPlane, type PowerPlane } from './powerPaths.ts'; // QA (standards): CL-09 reads the power plane's circuits
import { pipeVelocityMs, TCS_FLUIDS, tcsBandCapacityKW, tcsKWForFlow, tcsLpmPerKW } from '../layout/pipes.ts';
import type { CduClassKey, CduRatingBasis, ConnectorKey, FluidKey, IteCoolingClass } from '../standards/types.ts';
import { clamp, type Ctx, IT_LOAD_CATEGORIES, type Placed, podKey, unitsFor } from './context.ts';
import type { NetworkResult } from './network.ts';
import { RDHX_DOOR_META, rdhxDoorDuty, rdhxRoomUnits } from './coolingTopology.ts';
import { type CheckBasis, fmt, hallProfile, makeResult, num, type ResultInput, type StandardsCheckResult } from './standardsBasis.ts';

/**
 * Cooling heat balance and plant sizing.
 *
 *  IT heat (nameplate) → liquid share (catalog liquidFraction) to CDUs / TCS, remainder to room air (CRAHs).
 *  Switches + switch-side optics reject to air in the hall hosting the network rack.
 *  Liquid flow: Q[LPM] from the asset's requiredLiquidFlowRate curve at the TCS supply temperature,
 *    else Q = P / (cp·ΔT) with ΔT = 10 K.  Airflow from requiredAirFlowRate at the supply-air temperature.
 *  CRAH count = redundancy(max(ceil(air kW / unit kW), ceil(1.1·airflow / unit airflow))).
 *  Heat rejection: hybrid = liquid loop → adiabatic dry coolers (warm water), air loop → chillers w/ free cooling.
 *  Climate: dry-bulb ~ N(annualMean, σ) with σ = (designDB − mean)/2.65 (0.4 % design point);
 *    wet-bulb mean ≈ annualMean − 3 K.  Chillers: COP 3.3 (air-cooled) / 6.0 (water-cooled) at design,
 *    5.0 / 7.5 annual in mechanical hours, free cooling at 1/25 of load during economizer hours.
 *  Pumps: P = Q·ΔP/η with 25 m head (245 kPa), η = 0.72; CDU pumps at catalog typical power per active unit.
 *  Fans: EC fan affinity law P ∝ (flow ratio)³, all installed CRAHs sharing the load (min 30 % speed).
 */

const CP_WATER = 4.186; // kJ/kg·K
const RHO_AIR = 1.18;
const CP_AIR = 1.006;
const PUMP_KPA = 245;
const PUMP_ETA = 0.72;

export interface CoolingResult {
  analysis: CoolingAnalysis;
  /** IT heat at nameplate (racks + network) */
  itHeatKW: number;
  liquidKW: number;
  airKW: number;
  /** design-condition mechanical kW (pumps + fans + compressors + electrical-room cooling excluded) */
  mechDesignKW: number;
  mechAnnualKW: number;
  /** CDU pumps + CRAH fans (candidates for UPS backing) */
  criticalMechKW: number;
}

function normCdf(z: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Fraction of annual hours with dry-bulb ≤ t (°C). */
export function dryBulbFraction(project: Project, t: number): number {
  const c = project.site.climate;
  const sigma = Math.max(2, (c.designDryBulbC - c.annualMeanC) / 2.65);
  return normCdf((t - c.annualMeanC) / sigma);
}

export function wetBulbFraction(project: Project, t: number): number {
  const c = project.site.climate;
  const mean = c.annualMeanC - 3;
  const sigma = Math.max(2, (c.designWetBulbC - mean) / 2.65);
  return normCdf((t - mean) / sigma);
}

function airflowAt(item: CatalogItem, supplyC: number): number {
  return interpCurve(item.cooling?.airflowCurve, supplyC, item.cooling?.airflowM3s ?? 0);
}

/** `lpmPerKW` (stream C, CL-01): flow per liquid kW of a confirmed standards profile (fluid + ΔT); absent = water at ΔT 10 K as before */
function liquidFlowAt(item: CatalogItem, tcsC: number, lpmPerKW?: number): number {
  const lf = item.cooling?.liquidFraction ?? 0;
  if (lf <= 0) return 0;
  const liquidKW = (item.power?.nameplateKW ?? 0) * lf;
  const fallback = item.cooling?.liquidFlowLpm || (lpmPerKW !== undefined ? liquidKW * lpmPerKW : (liquidKW / (CP_WATER * 10)) * 60);
  return interpCurve(item.cooling?.liquidFlowCurve, tcsC, fallback);
}

export function analyzeCoolingCtx(ctx: Ctx, net: NetworkResult): CoolingResult {
  const { project } = ctx;
  const cd = project.cooling;
  const cduDesign = findCatalogItem(cd.cduCatalogId);
  const crahDesign = findCatalogItem(cd.crahCatalogId);
  const chiller = findCatalogItem(cd.chillerCatalogId);
  const dryCooler = findCatalogItem('drycooler-2000');

  // network heat per hall (switches + switch-side optics)
  const switchKWByHall = new Map<string, number>();
  const switchAirflowByHall = new Map<string, number>();
  const rackById = new Map(ctx.placed.map((p) => [p.e.id, p]));
  const rackLoadKW = new Map((net.analysis.rackLoads ?? []).map((rl) => [rl.rackId, rl.kw]));
  for (const rl of net.analysis.rackLoads ?? []) {
    const rack = rackById.get(rl.rackId);
    if (!rack) continue;
    switchKWByHall.set(rack.e.hallId, (switchKWByHall.get(rack.e.hallId) ?? 0) + rl.kw);
    const flow = rl.switches.reduce((s, sw) => s + (findCatalogItem(sw.catalogId)?.cooling?.airflowM3s ?? 0) * sw.count, 0);
    switchAirflowByHall.set(rack.e.hallId, (switchAirflowByHall.get(rack.e.hallId) ?? 0) + flow);
  }
  const totalSwitchKW = [...switchKWByHall.values()].reduce((s, v) => s + v, 0);
  const xcvrKW = net.analysis.transceiverKW;

  let liquidKW = 0;
  let airKW = 0;
  let tcsFlowLpm = 0;
  let requiredAirflow = 0;
  let placedAirflow = 0;
  let cduPumpKW = 0;
  const perHall: NonNullable<CoolingAnalysis['perHall']> = [];

  for (const hall of project.halls) {
    const items = ctx.byHall.get(hall.id) ?? [];
    let hLiquid = 0;
    let hAir = 0;
    let hFlow = 0;
    // polish v2 2차: rear doors (EquipmentInstance.meta.rdhxDoorKW) remove rack air heat before the room units
    let doors = 0;
    let doorDuty = 0;
    let maxDoorDuty = 0;
    const addDoor = (door: number, rackAirKW: number) => {
      if (!(door > 0)) return;
      const q = rdhxDoorDuty(door, rackAirKW);
      doors++;
      doorDuty += q;
      maxDoorDuty = Math.max(maxDoorDuty, q);
    };
    // stream C (CL-01): a confirmed standards profile sizes the fallback TCS flow from its fluid and ΔT (inferred / no profile: unchanged)
    const hallStd = hallProfile(project, hall);
    const lpmPerKW = hallStd && hallStd.inferred !== true ? tcsLpmPerKW(hallStd.liquid.fluid, cd.tcsDeltaTK ?? 10) : undefined;
    for (const p of items) {
      const cat = p.item.category;
      const kw = p.item.power?.nameplateKW ?? 0;
      const door = Number(p.e.meta?.[RDHX_DOOR_META] ?? 0);
      if (cat === 'network-rack' && door > 0) addDoor(door, rackLoadKW.get(p.e.id) ?? 0);
      if (IT_LOAD_CATEGORIES.has(cat)) {
        const lf = p.item.cooling?.liquidFraction ?? 0;
        hLiquid += kw * lf;
        hAir += kw * (1 - lf);
        if (kw * (1 - lf) > 0) addDoor(door, kw * (1 - lf));
        hFlow += airflowAt(p.item, cd.supplyAirC);
        tcsFlowLpm += liquidFlowAt(p.item, cd.tcsSupplyC, lpmPerKW);
      } else if (cat === 'cdu') {
        hAir += (p.item.power?.typicalKW ?? 0) * 0.1; // motor & drive losses to room
      }
    }
    const hSwitchKW = switchKWByHall.get(hall.id) ?? 0;
    hAir += hSwitchKW + (totalSwitchKW > 0 ? (xcvrKW * hSwitchKW) / totalSwitchKW : 0);
    hFlow += switchAirflowByHall.get(hall.id) ?? 0;

    const crahs = items.filter((p) => p.item.category === 'crah' || p.item.category === 'fan-wall');
    const crahItem = crahs[0]?.item ?? crahDesign;
    const unitKW = crahItem?.capacity?.coolingKW ?? 0;
    const unitFlow = crahItem?.capacity?.airflowM3s ?? 0;
    const nHeat = unitKW > 0 ? Math.ceil(hAir / unitKW - 1e-9) : 0;
    const nFlow = unitFlow > 0 ? Math.ceil((hFlow * 1.1) / unitFlow - 1e-9) : 0;
    let req = hAir > 0 ? unitsFor(Math.max(nHeat, nFlow), 1, cd.crahRedundancy).units : 0;
    if (doors > 0) req = rdhxRoomUnits(Math.max(0, hAir - doorDuty), doorDuty, maxDoorDuty, crahItem, cd.crahRedundancy).inst;
    const hPlacedFlow = crahs.reduce((s, p) => s + (p.item.capacity?.airflowM3s ?? 0), 0);
    perHall.push({
      hallId: hall.id,
      liquidKW: hLiquid,
      airKW: hAir,
      crahsPlaced: crahs.length,
      crahsRequired: req,
      crahCapacityKW: crahs.reduce((s, p) => s + (p.item.capacity?.coolingKW ?? 0), 0),
      airflowPlacedM3s: hPlacedFlow,
      airflowRequiredM3s: hFlow,
      ...(doors > 0 ? { rdhxDoors: doors, rdhxDutyKW: doorDuty } : {}),
    });
    liquidKW += hLiquid;
    airKW += hAir;
    requiredAirflow += hFlow;
    placedAirflow += hPlacedFlow;
  }

  // CDUs per pod (deployment unit)
  const perPod: NonNullable<CoolingAnalysis['perPod']> = [];
  let cduUnits = 0;
  for (const [pod, items] of ctx.byPod) {
    const podLiquid = items.reduce((s, p) => s + (IT_LOAD_CATEGORIES.has(p.item.category) ? (p.item.power?.nameplateKW ?? 0) * (p.item.cooling?.liquidFraction ?? 0) : 0), 0);
    const cdus = items.filter((p) => p.item.category === 'cdu');
    if (podLiquid <= 0 && cdus.length === 0) continue;
    const cduItem = cdus[0]?.item ?? cduDesign;
    const cap = cduItem?.capacity?.coolingKW ?? 0;
    const req = unitsFor(podLiquid, cap, cd.cduRedundancy);
    cduUnits += Math.max(req.units, cdus.length);
    const active = cdus.length > 0 ? Math.min(cdus.length, req.n) : req.n;
    cduPumpKW += active * (cduItem?.power?.typicalKW ?? 0);
    perPod.push({ podId: pod, liquidKW: podLiquid, cdusPlaced: cdus.length, cdusRequired: req.units, cduCapacityKW: cdus.reduce((s, p) => s + (p.item.capacity?.coolingKW ?? 0), 0) });
  }

  const crahRequired = perHall.reduce((s, h) => s + h.crahsRequired, 0);
  const crahInstalled = perHall.reduce((s, h) => s + Math.max(h.crahsPlaced, h.crahsRequired), 0);
  const crahUnitKW = crahDesign?.capacity?.coolingKW ?? 0;
  const crahUnitFlow = crahDesign?.capacity?.airflowM3s ?? 0;
  const installedFlow = Math.max(placedAirflow, crahInstalled * crahUnitFlow);
  const flowRatio = installedFlow > 0 ? clamp((requiredAirflow * 1.1) / installedFlow, 0.3, 1) : 0;
  const crahFanKW = crahInstalled * (crahDesign?.power?.nameplateKW ?? 0) * flowRatio ** 3;

  // heat rejection plant
  const liquidReject = liquidKW + cduPumpKW * 0.9;
  const airReject = airKW + crahFanKW;
  let chillerLoad = 0;
  let dryLoad = 0;
  switch (cd.heatRejection) {
    case 'hybrid':
      dryLoad = liquidReject;
      chillerLoad = airReject;
      break;
    case 'dry-cooler':
      dryLoad = liquidReject + airReject;
      break;
    default:
      chillerLoad = liquidReject + airReject;
  }
  const chillers = unitsFor(chillerLoad, chiller?.capacity?.coolingKW ?? 1500, cd.chillerRedundancy);
  const dry = unitsFor(dryLoad, dryCooler?.capacity?.coolingKW ?? 2000, cd.chillerRedundancy);

  const waterCooled = cd.heatRejection === 'water-cooled-chiller';
  const copDesign = waterCooled ? 6.0 : 3.3;
  const copAnnual = waterCooled ? 7.5 : 5.0;
  const econFrac = cd.economizer ? clamp(project.site.climate.economizerHours / 8760, 0, 1) : 0;
  const chillerCompressorKW = chillerLoad / copDesign + (waterCooled ? chillerLoad * 0.015 : 0);
  const chillerAnnualKW = chillerLoad * (econFrac / 25 + (1 - econFrac) / copAnnual) + (waterCooled ? chillerLoad * 0.012 : 0);

  const dryFanDesignKW = dryLoad * ((dryCooler?.power?.nameplateKW ?? 45) / (dryCooler?.capacity?.coolingKW ?? 2000));
  const dryFanAnnualKW = dryFanDesignKW * 0.55;

  const fwsDT = Math.max(2, cd.fwsReturnC - cd.fwsSupplyC);
  const fwsKgS = liquidReject / (CP_WATER * fwsDT);
  const chwKgS = airReject / (CP_WATER * 6);
  const plantPumpKW = ((fwsKgS + chwKgS) / 1000) * (PUMP_KPA / PUMP_ETA);
  const pumpKW = cduPumpKW + plantPumpKW;
  const fanKW = crahFanKW + dryFanDesignKW;

  // water: adiabatic assist when dry mode cannot hold FWS supply (approach 6 K dry)
  const dryModeFrac = dryBulbFraction(project, cd.fwsSupplyC - 6);
  const adiabaticLPerH = dryLoad * (1 - dryModeFrac) * 1.47 * 0.6;
  const towerLPerH = waterCooled ? chillerLoad * 1.8 * (1 - econFrac * 0.5) : 0;

  const itHeatKW = liquidKW + airKW - (ctx.byHall.size ? 0 : 0);
  const mechDesignKW = pumpKW + fanKW + chillerCompressorKW;
  const mechAnnualKW = pumpKW + crahFanKW * 0.85 + dryFanAnnualKW + chillerAnnualKW;
  const itForRatio = Math.max(1, liquidKW + airKW);

  const analysis: CoolingAnalysis = {
    liquidHeatKW: liquidKW,
    airHeatKW: airKW,
    cdus: { units: cduUnits, unitKW: cduDesign?.capacity?.coolingKW ?? 0, requiredKW: liquidKW, tcsFlowLpm },
    crahs: { units: Math.max(crahRequired, perHall.reduce((s, h) => s + h.crahsPlaced, 0)), unitKW: crahUnitKW, requiredKW: airKW, airflowM3s: installedFlow, requiredAirflowM3s: requiredAirflow },
    chillers: { units: chillers.units, unitKW: chiller?.capacity?.coolingKW ?? 0, requiredKW: chillerLoad },
    fwsFlowLpm: fwsKgS * 60,
    pumpKW,
    fanKW,
    chillerKW: chillerCompressorKW,
    partialPue: (itForRatio + mechAnnualKW) / itForRatio,
    wueLPerKWh: (adiabaticLPerH + towerLPerH) / itForRatio,
    dryCoolers: { units: dry.units, unitKW: dryCooler?.capacity?.coolingKW ?? 0, requiredKW: dryLoad },
    annualMechanicalKW: mechAnnualKW,
    perPod,
    perHall,
  };

  return {
    analysis,
    itHeatKW,
    liquidKW,
    airKW,
    mechDesignKW,
    mechAnnualKW,
    criticalMechKW: cduPumpKW + crahFanKW,
  };
}

/** Air temperature rise across equipment for a given heat (kW) and airflow (m³/s). */
export function airDeltaT(kw: number, m3s: number): number {
  return m3s > 0 ? kw / (RHO_AIR * CP_AIR * m3s) : 0;
}

export function podOf(p: Placed): string {
  return podKey(p.e);
}

// ───────────────────────────── stream C (P3): liquid-cooling parameter checks (proposal §5.3) ─────────────────────────────
//
// CL-01 flow per kW by fluid and ΔT (tcsLpmPerKW in layout/pipes.ts; used by the heat balance above for confirmed profiles)
// CL-02 CDU rating basis (units are compared only on the same rating convention) · CL-03 approach · CL-04 connector flow per mated pair
// CL-05 pressure envelope at the rack manifold · CL-06 fluid temperature window · CL-07 manifold velocity · CL-08 branch / loop DN bands
// CL-09 electrical ↔ cooling block alignment · CL-10 CDU available ΔP · CL-11 door heat exchangers · CL-12 filtration & commissioning
// CL-13 residual air by ITE cooling class · CL-14 heat-reuse band · CL-15 air-cooled accelerator module limit · CL-16 baseboard envelope
// Limits are parameters of the cited documents (registry ids), never document text. Results per catalog item are grouped per hall so a
// hall of 96 identical racks yields one finding that lists the racks.

export type LiquidConnector = Exclude<ConnectorKey, 'vendor' | 'none'>;

export interface ConnectorBasis {
  standardId: string;
  /** rated flow per mated pair, L/min */
  ratedLpm?: number;
  /** UQD / UQDB sizes: rated flow (L/min, converted from GPM) and minimum Cv */
  bySize?: Readonly<Record<string, { lpm: number; cv: number }>>;
  /** the connector serves one node (tray) or the whole rack */
  scope: 'node' | 'rack';
  maxWorkingPsig: number;
  /** connect / disconnect pressure limit (service action), psig */
  connectPsig?: number;
  maxFluidC: number;
  minFluidC?: number;
}

/** Connector ratings (UQD / UQDB Rev 1.0, ORv3 BMQC Rev 1.0, PBMC Rev 1.0, LQC V2.0.0 — values as recorded in the proposal §3.2, P0). */
export const CONNECTOR_BASIS: Readonly<Record<LiquidConnector, ConnectorBasis>> = {
  uqd: { standardId: 'uqd@1.0', bySize: { '02': { lpm: 2.1, cv: 0.25 }, '04': { lpm: 6.4, cv: 0.8 }, '06': { lpm: 11.4, cv: 1.6 }, '08': { lpm: 17.8, cv: 2.5 } }, scope: 'node', maxWorkingPsig: 100, maxFluidC: 65, minFluidC: 17 },
  uqdb: { standardId: 'uqdb@1.0', bySize: { '02': { lpm: 2.1, cv: 0.25 }, '04': { lpm: 6.4, cv: 0.8 }, '06': { lpm: 11.4, cv: 1.55 }, '08': { lpm: 17.8, cv: 2.4 } }, scope: 'node', maxWorkingPsig: 100, maxFluidC: 65, minFluidC: 17 },
  bmqc: { standardId: 'orv3-bmqc@1.0', ratedLpm: 9, scope: 'node', maxWorkingPsig: 50, maxFluidC: 60 },
  pbmc: { standardId: 'pbmc@1.0', ratedLpm: 36, scope: 'node', maxWorkingPsig: 75, maxFluidC: 60 },
  lqc: { standardId: 'lqc@2.0.0', ratedLpm: 100, scope: 'rack', maxWorkingPsig: 75, connectPsig: 50, maxFluidC: 60, minFluidC: -5 },
};

/** Rack manifold limits (ORv3 Blind Mate Manifold Rev 1.0; Rack Manifold white paper 2023). */
export const MANIFOLD_BASIS: Readonly<Record<'orv3-blindmate' | 'eia-vertical', { standardId: string; maxWorkingPsig?: number; maxFluidC: number; maxVelocityMs?: number; maxFlowSpreadPct?: number }>> = {
  'orv3-blindmate': { standardId: 'orv3-bm-manifold@1.0', maxWorkingPsig: 50, maxFluidC: 60, maxFlowSpreadPct: 5 },
  'eia-vertical': { standardId: 'rack-manifold-wp@2023', maxFluidC: 65, maxVelocityMs: 1.5 },
};

/**
 * CDU class basis: facility class = Deschutes v0.80.0 envelope (2000 kW at 3 K, IT-side available ΔP 80–90 psi, 0–130 psig, vendor rating
 * convention); row / in-rack classes = the L-LCDU white paper R1 convention (5 K approach, 1.5 LPM/kW, TCS head ≥ 40 psi in-row / ≥ 25 psi
 * in-rack, FWS ΔP ≤ 75 psi). `headPsi` is the pressure the class adds at the manifold (upper value of a range, conservative);
 * `availableDpPsi` the lower value used for CL-10.
 */
export const CDU_CLASS_BASIS: Readonly<Record<Exclude<CduClassKey, 'none'>, { standardId: string; convention: CduRatingBasis; approachK: number; lpmPerKW?: number; headPsi: number; availableDpPsi: number; maxPsig?: number; ratedKW?: number }>> = {
  'facility-2mw': { standardId: 'deschutes@0.80.0', convention: 'vendor', approachK: 3, headPsi: 90, availableDpPsi: 80, maxPsig: 130, ratedKW: 2000 },
  'row-l2l': { standardId: 'l-lcdu-wp@1.0', convention: 'l-lcdu-wp-r1', approachK: 5, lpmPerKW: 1.5, headPsi: 40, availableDpPsi: 40 },
  'in-rack-rpu': { standardId: 'l-lcdu-wp@1.0', convention: 'l-lcdu-wp-r1', approachK: 5, lpmPerKW: 1.5, headPsi: 25, availableDpPsi: 25 },
};
/** Approach reported by vendor units rated per Cold Plate Cooling Loop Requirements Rev 2 (K). */
export const LOOP_REQS_APPROACH_K = 4;
/** Static fill pressure at the rack manifold when the hall gives none (psig, planner estimate). */
export const TCS_STATIC_FILL_PSIG_ESTIMATE = 15;
export const PSI_TO_KPA = 6.894757;
const LPM_PER_GPM = 3.785411784;
/** OAI-OAM r2.0 v1.0: module power envelope, recommended air-cooled limit, cold-plate supply window. OAI-UBB r2.0 v1.0: board envelope. */
export const ACCEL_ENVELOPE = { oamModuleW: 1000, oamAirW: 600, oamSupplyC: [15, 50] as const, ubbBoardW: 12000, ubbExpW: 3200, oamStandardId: 'oam-base@2.0-1.0', ubbStandardId: 'ubb-base@2.0-1.0' } as const;
/** Liquid fraction by ITE cooling class (derived from the 65–75 / 75–85 / ~100 % bands of Cold Plate Cooling Loop Requirements Rev 2). */
export const ITE_CLASS_LIQUID_FRACTION: Readonly<Record<IteCoolingClass, number>> = { 'hybrid-basic': 0.7, 'hybrid-intermediate': 0.8, 'full-liquid': 0.97 };
/** ACS Door HX Requirements for Open Rack Rev 1.0 (facts only). */
export const DOOR_HX_BASIS = { standardId: 'door-hx-reqs@1.0', minSupplyC: 16, aisleOpenMm: 1200, maxCoolantDpKPa: 100 } as const;

const FLUID_KO: Record<FluidKey, string> = { pg25: 'PG25', 'treated-water': '처리수', 'dielectric-1p': '단상 유전 유체' };
const FLUID_EN: Record<FluidKey, string> = { pg25: 'PG25', 'treated-water': 'treated water', 'dielectric-1p': 'single-phase dielectric' };

/** Rated flow (and Cv) of one mated pair; UQD / UQDB need the size ('02' | '04' | '06' | '08'). */
export function connectorPairRating(connector: LiquidConnector, size?: string): { lpm: number; cv?: number } | undefined {
  const b = CONNECTOR_BASIS[connector];
  if (b.ratedLpm !== undefined) return { lpm: b.ratedLpm };
  const s = size !== undefined ? b.bySize?.[size.padStart(2, '0')] : undefined;
  return s ? { lpm: s.lpm, cv: s.cv } : undefined;
}

/** Heat one mated pair carries at its rated flow (kW), e.g. BMQC 9 L/min at ΔT 10 K PG25 ≈ 6.0 kW. */
export function connectorPairKW(connector: LiquidConnector, fluid: FluidKey, deltaTK: number, size?: string): number | undefined {
  const r = connectorPairRating(connector, size);
  return r ? tcsKWForFlow(fluid, r.lpm, deltaTK) : undefined;
}

/** Mated pairs needed for `liquidKW` (per node or per rack, per the connector scope). */
export function connectorPairsNeeded(liquidKW: number, connector: LiquidConnector, fluid: FluidKey, deltaTK: number, size?: string): number | undefined {
  const kw = connectorPairKW(connector, fluid, deltaTK, size);
  return kw && kw > 0 ? Math.max(1, Math.ceil(liquidKW / kw - 1e-9)) : undefined;
}

/** Pressure drop of one mated UQD / UQDB pair at `lpm`: ΔP [psi] = SG · (Q [GPM] / Cv)² → kPa (e.g. UQD04 at 6.4 L/min ≈ 31 kPa). */
export function uqdPairDpKPa(lpm: number, cv: number, fluid: FluidKey = 'treated-water'): number {
  const sg = TCS_FLUIDS[fluid]?.rhoKgL ?? 1;
  const gpm = lpm / LPM_PER_GPM;
  return sg * (gpm / cv) ** 2 * PSI_TO_KPA;
}

/**
 * CL-02: CDU units for `liquidKW` on ONE rating convention. Units rated on different conventions (L-LCDU 5 K vs Loop Reqs 4 K vs vendor)
 * are never summed or compared: the result is `{ ok: false }` with the conventions found.
 */
export function cduUnitsOnBasis(liquidKW: number, cdus: readonly { ratedKW: number; convention: CduRatingBasis }[], redundancy: Parameters<typeof unitsFor>[2]): { ok: true; convention: CduRatingBasis; n: number; units: number } | { ok: false; conventions: CduRatingBasis[] } {
  const conventions = [...new Set(cdus.map((c) => c.convention))];
  if (conventions.length !== 1) return { ok: false, conventions };
  const unitKW = Math.min(...cdus.map((c) => c.ratedKW));
  const r = unitsFor(liquidKW, unitKW, redundancy);
  return { ok: true, convention: conventions[0], ...r };
}

/** CDU class served by the hall: placed CDU items with a `cdu` block win over the profile. */
function hallCduClass(cdus: readonly Placed[], profileClass: CduClassKey): Exclude<CduClassKey, 'none'> | undefined {
  const declared = cdus.map((p) => p.item.cdu?.class).find((c) => !!c);
  const k = declared === 'facility' ? 'facility-2mw' : (declared ?? profileClass);
  return k === 'none' ? undefined : (k as Exclude<CduClassKey, 'none'>);
}

/** Pressure at the rack manifold (psig): the hall's design value, else static fill + CDU class head. */
export function manifoldPressurePsig(hall: Hall, cduClass: Exclude<CduClassKey, 'none'> | undefined, declaredHeadPsi?: number): { psig: number; basis: CheckBasis } {
  if (hall.facility?.tcsManifoldPsig !== undefined) return { psig: hall.facility.tcsManifoldPsig, basis: 'user' };
  const head = declaredHeadPsi ?? (cduClass ? CDU_CLASS_BASIS[cduClass].headPsi : 0);
  return { psig: (hall.facility?.tcsStaticFillPsig ?? TCS_STATIC_FILL_PSIG_ESTIMATE) + head, basis: 'estimate' };
}

const LIQUID_CONNECTORS = new Set<string>(Object.keys(CONNECTOR_BASIS));
const asConnector = (v: string | undefined): LiquidConnector | undefined => {
  const c = v === undefined ? undefined : canonicalConnector(v);
  return c && LIQUID_CONNECTORS.has(c) ? (c as LiquidConnector) : undefined;
};

/** Liquid-cooling parameter checks of every hall with a standards profile (see the block header). Pure. */
export function evaluateLiquidChecks(ctx: Ctx, inputs: { network?: NetworkAnalysis } = {}): StandardsCheckResult[] {
  const { project } = ctx;
  const cd = project.cooling;
  const dT = cd.tcsDeltaTK ?? 10;
  const out: StandardsCheckResult[] = [];
  let plane: PowerPlane | undefined;
  for (const hall of project.halls) {
    const profile = hallProfile(project, hall);
    if (!profile) continue;
    const L = profile.liquid;
    const fluid = L.fluid;
    const confirmed = profile.inferred !== true;
    const items = ctx.byHall.get(hall.id) ?? [];
    const liquidRacks = items.filter((p) => IT_LOAD_CATEGORIES.has(p.item.category) && (p.item.cooling?.liquidFraction ?? 0) > 0);
    const cdus = items.filter((p) => p.item.category === 'cdu');
    const cls = hallCduClass(cdus, L.cduClass);
    const lpmKW = tcsLpmPerKW(fluid, dT);
    const add = (r: Omit<ResultInput, 'hallId' | 'domain'> & { domain?: ResultInput['domain'] }) => out.push(makeResult(profile, { domain: 'cooling', hallId: hall.id, ...r }));
    const groups = new Map<string, Placed[]>();
    for (const p of liquidRacks) groups.set(p.item.id, [...(groups.get(p.item.id) ?? []), p]);
    const rackList = (g: Placed[]) => `${g.slice(0, 3).map((x) => x.e.tag).join(', ')}${g.length > 3 ? ` +${g.length - 3}` : ''}`;
    const refsOf = (g: Placed[]) => [hall.id, ...g.slice(0, 6).map((x) => x.e.id)];
    const hallLiquidKW = liquidRacks.reduce((s, p) => s + (p.item.power?.nameplateKW ?? 0) * (p.item.cooling?.liquidFraction ?? 0), 0);

    // ── per rack model: CL-04 connector flow, CL-06 module supply window, CL-07 / CL-08 branch, CL-10 ΔP, CL-13 class, CL-15 / CL-16 envelopes
    for (const [itemId, g] of groups) {
      const item = g[0].item;
      const rackKW = item.power?.nameplateKW ?? 0;
      const lf = item.cooling?.liquidFraction ?? 0;
      const rackLiquid = rackKW * lf;
      const nodes = Math.max(1, item.compute?.nodesPerRack ?? 1);
      const li = item.liquidInterface;
      const connector = asConnector(li?.connector ?? L.connector);
      const itemEstimate = item.source === 'estimate';
      const tag = `${item.name} (${rackList(g)})`;
      if (connector) {
        const b = CONNECTOR_BASIS[connector];
        const size = typeof item.meta?.uqdSize === 'string' || typeof item.meta?.uqdSize === 'number' ? String(item.meta.uqdSize) : undefined;
        const sized = connectorPairRating(connector, size);
        const rating = li?.ratedLpmPerPort !== undefined ? { lpm: li.ratedLpmPerPort, cv: sized?.cv } : sized;
        const scopeKW = b.scope === 'node' ? rackLiquid / nodes : rackLiquid;
        // mated pairs: declared pair count (meta.uqdPairs / meta.connectorPairs), else half of the declared ports (supply + return), else 1 (assumed)
        const declaredPairs = num(item.meta?.uqdPairs) ?? num(item.meta?.connectorPairs) ?? (li?.ports !== undefined && li.ports > 0 ? li.ports / 2 : undefined);
        const pairsDeclared = declaredPairs !== undefined && declaredPairs >= 1;
        const pairs = pairsDeclared ? Math.floor(declaredPairs!) : 1;
        if (!rating) {
          add({ id: `std-cl04-${hall.id}-${itemId}`, ruleId: 'CL-04', family: 'liquid', status: 'not-modelled', naturalSeverity: 'info', refs: refsOf(g), basis: 'standard', standardId: b.standardId, verification: 'unverified', ko: `${tag}: 커넥터 크기가 없어 쌍당 유량을 점검하지 않았습니다.`, en: `${tag}: connector size not declared; flow per pair not checked.` });
        } else {
          const flowPair = (scopeKW * lpmKW) / pairs;
          const pairKW = tcsKWForFlow(fluid, rating.lpm, dT);
          const need = pairKW > 0 ? Math.max(1, Math.ceil(scopeKW / pairKW - 1e-9)) : undefined;
          const scopeKo = b.scope === 'node' ? '노드' : '랙';
          const finding = flowPair > rating.lpm + 1e-9;
          add({
            id: `std-cl04-${hall.id}-${itemId}`, ruleId: 'CL-04', family: 'liquid', status: finding ? 'finding' : 'pass', naturalSeverity: 'error', refs: refsOf(g),
            designValue: Math.round(flowPair * 10) / 10, limit: rating.lpm, unit: 'L/min', basis: itemEstimate || !pairsDeclared ? 'estimate' : 'standard', standardId: b.standardId, verification: 'derived',
            ko: `${tag}: 쌍당 유량 ${fmt(flowPair)} L/min (${scopeKo} 액체 ${fmt(scopeKW)} kW, ${pairs}쌍${pairsDeclared ? '' : '(가정)'}, ΔT ${fmt(dT)} K ${FLUID_KO[fluid]}) / 정격 ${fmt(rating.lpm)} L/min. 1쌍은 ${fmt(pairKW)} kW를 담당하므로 ${need}쌍이 필요합니다.`,
            en: `${tag}: ${fmt(flowPair)} L/min per pair (${b.scope} liquid ${fmt(scopeKW)} kW, ${pairs} pair${pairs === 1 ? '' : 's'}${pairsDeclared ? '' : ' assumed'}, ΔT ${fmt(dT)} K ${FLUID_EN[fluid]}) vs rated ${fmt(rating.lpm)} L/min. One pair carries ${fmt(pairKW)} kW, so ${need} pair${need === 1 ? ' is' : 's are'} needed.`,
            ...(finding ? { suggestion: `커넥터 쌍을 ${need}개로 늘리거나, ΔT를 키우거나, 정격 유량이 큰 커넥터를 선택하세요.`, suggestionEn: `Use ${need} pairs, a larger ΔT or a connector with a higher rated flow.` } : {}),
          });
          // CL-10: connector ΔP (UQD / UQDB with Cv) + declared rack ΔP vs the CDU class available ΔP
          const rackDp = num(item.meta?.rackDpKPa);
          if (rating.cv && rackDp !== undefined && cls) {
            const total = rackDp + uqdPairDpKPa(flowPair, rating.cv, fluid);
            const avail = cdus.map((p) => p.item.cdu?.availableDpKPa).find((v) => v !== undefined) ?? CDU_CLASS_BASIS[cls].availableDpPsi * PSI_TO_KPA;
            const f = total > avail + 1e-9;
            add({ id: `std-cl10-${hall.id}-${itemId}`, ruleId: 'CL-10', family: 'liquid', status: f ? 'finding' : 'pass', naturalSeverity: 'warning', refs: refsOf(g), designValue: Math.round(total), limit: Math.round(avail), unit: 'kPa', basis: 'estimate', standardId: CDU_CLASS_BASIS[cls].standardId, verification: 'derived',
              ko: `${tag}: 랙 ΔP ${fmt(rackDp, 0)} kPa + 커넥터 쌍 ΔP ${fmt(total - rackDp, 0)} kPa = ${fmt(total, 0)} kPa / CDU 가용 ΔP ${fmt(avail, 0)} kPa.`,
              en: `${tag}: rack ΔP ${fmt(rackDp, 0)} kPa + connector pair ΔP ${fmt(total - rackDp, 0)} kPa = ${fmt(total, 0)} kPa vs CDU available ΔP ${fmt(avail, 0)} kPa.` });
          }
        }
      }
      // CL-07 manifold velocity (declared branch DN) · CL-08 branch DN band
      const dn = li?.branchDN;
      if (dn) {
        const vmax = li?.maxVelocityMs ?? (L.rackManifold === 'eia-vertical' ? MANIFOLD_BASIS['eia-vertical'].maxVelocityMs : undefined);
        if (vmax !== undefined) {
          const v = pipeVelocityMs(rackLiquid * lpmKW, dn);
          const f = v > vmax + 1e-9;
          add({ id: `std-cl07-${hall.id}-${itemId}`, ruleId: 'CL-07', family: 'liquid', status: f ? 'finding' : 'pass', naturalSeverity: 'warning', refs: refsOf(g), designValue: Math.round(v * 100) / 100, limit: vmax, unit: 'm/s', basis: 'standard', standardId: MANIFOLD_BASIS['eia-vertical'].standardId, verification: 'derived',
            ko: `${tag}: DN${dn} 매니폴드 유속 ${fmt(v, 2)} m/s / 권장 ${fmt(vmax, 2)} m/s 미만.`, en: `${tag}: DN${dn} manifold velocity ${fmt(v, 2)} m/s vs recommended below ${fmt(vmax, 2)} m/s.` });
        }
        const cap = tcsBandCapacityKW(dn, dT);
        const f = rackLiquid > cap + 1e-9;
        add({ id: `std-cl08-${hall.id}-${itemId}`, ruleId: 'CL-08', family: 'liquid', status: f ? 'finding' : 'pass', naturalSeverity: 'warning', refs: refsOf(g), designValue: Math.round(rackLiquid), limit: Math.round(cap), unit: 'kW', basis: 'standard', standardId: 'modular-tcs-wp@dlm1', verification: 'derived',
          ko: `${tag}: 랙 액체 ${fmt(rackLiquid, 0)} kW / DN${dn} 분기관 용량 ${fmt(cap, 0)} kW (ΔT ${fmt(dT)} K).`, en: `${tag}: rack liquid ${fmt(rackLiquid, 0)} kW vs DN${dn} branch capacity ${fmt(cap, 0)} kW (ΔT ${fmt(dT)} K).`,
          ...(f ? { suggestion: '분기관을 한 단계 키우거나 ΔT를 키우세요.', suggestionEn: 'Use the next branch size or a larger ΔT.' } : {}) });
      }
      // CL-06 (module part): OAM cold-plate supply window
      const am = item.accelModule;
      if (am?.standard === 'oam-2.0' && lf > 0) {
        const [lo, hi] = ACCEL_ENVELOPE.oamSupplyC;
        const s = cd.tcsSupplyC;
        const f = s < lo - 1e-9 || s > hi + 1e-9;
        add({ id: `std-cl06-oam-${hall.id}-${itemId}`, ruleId: 'CL-06', family: 'liquid', status: f ? 'finding' : 'pass', naturalSeverity: 'error', refs: refsOf(g), designValue: s, limit: s > hi ? hi : lo, unit: '°C', basis: 'standard', standardId: ACCEL_ENVELOPE.oamStandardId, verification: 'verified',
          ko: `${tag}: TCS 공급 ${fmt(s)} °C / 가속기 모듈 냉각판 공급 범위 ${lo}–${hi} °C.`, en: `${tag}: TCS supply ${fmt(s)} °C vs the accelerator module cold-plate supply window ${lo}–${hi} °C.` });
      }
      // CL-13 residual air by ITE cooling class
      if (L.iteCoolingClass && confirmed) {
        const cl = ITE_CLASS_LIQUID_FRACTION[L.iteCoolingClass];
        if (lf + 1e-9 < cl) add({ id: `std-cl13-${hall.id}-${itemId}`, ruleId: 'CL-13', family: 'liquid', status: 'finding', naturalSeverity: 'info', refs: refsOf(g), designValue: Math.round(lf * 100) / 100, limit: cl, basis: 'standard', standardId: 'cold-plate-loop-reqs@2', verification: 'derived',
          ko: `${tag}: 액체 비율 ${fmt(lf * 100, 0)} %가 ITE 냉각 등급 기본값 ${fmt(cl * 100, 0)} %보다 낮습니다. 랙당 잔여 공기 발열은 ${fmt(rackKW * (1 - lf))} kW입니다.`,
          en: `${tag}: liquid fraction ${fmt(lf * 100, 0)} % is below the ITE cooling class default of ${fmt(cl * 100, 0)} %; residual air heat ${fmt(rackKW * (1 - lf))} kW per rack.` });
      }
    }

    // ── per compute model (air and liquid): CL-15 air module limit, OAM envelope note, CL-16 baseboard envelope
    const computeGroups = new Map<string, Placed[]>();
    for (const p of items) if (p.item.accelModule) computeGroups.set(p.item.id, [...(computeGroups.get(p.item.id) ?? []), p]);
    for (const [itemId, g] of computeGroups) {
      const item = g[0].item;
      const am = item.accelModule!;
      const tag = `${item.name} (${rackList(g)})`;
      const air = am.cooling === 'air' || (item.cooling?.liquidFraction ?? 0) <= 0;
      if (am.standard === 'oam-2.0' && air && am.tdpW > ACCEL_ENVELOPE.oamAirW)
        add({ id: `std-cl15-${hall.id}-${itemId}`, ruleId: 'CL-15', family: 'compute', status: 'finding', naturalSeverity: 'info', domain: 'cooling', refs: refsOf(g), designValue: am.tdpW, limit: ACCEL_ENVELOPE.oamAirW, unit: 'W', basis: 'standard', standardId: ACCEL_ENVELOPE.oamStandardId, verification: 'verified',
          ko: `${tag}: 공랭 가속기 모듈 ${fmt(am.tdpW, 0)} W가 공랭 권장 한도 ${ACCEL_ENVELOPE.oamAirW} W를 넘습니다.`, en: `${tag}: air-cooled accelerator module ${fmt(am.tdpW, 0)} W is above the recommended air-cooled limit of ${ACCEL_ENVELOPE.oamAirW} W.` });
      if (am.standard === 'oam-2.0' && am.tdpW > ACCEL_ENVELOPE.oamModuleW)
        add({ id: `std-env-oam-${hall.id}-${itemId}`, ruleId: 'CL-16', family: 'compute', status: 'finding', naturalSeverity: 'info', domain: 'cooling', refs: refsOf(g), designValue: am.tdpW, limit: ACCEL_ENVELOPE.oamModuleW, unit: 'W', basis: 'standard', standardId: ACCEL_ENVELOPE.oamStandardId, verification: 'verified',
          ko: `${tag}: 모듈 전력 ${fmt(am.tdpW, 0)} W가 기본 사양의 모듈 전력 범위 ${ACCEL_ENVELOPE.oamModuleW} W를 넘습니다(허용되며 표시만 합니다).`, en: `${tag}: module power ${fmt(am.tdpW, 0)} W exceeds the base-specification module power envelope of ${ACCEL_ENVELOPE.oamModuleW} W (allowed; flagged only).` });
      const bb = item.baseboard;
      if (bb?.standard === 'ubb-2.0') {
        const board = bb.modules * am.tdpW + bb.modules * (bb.opt12VPerModuleW ?? 0) + ACCEL_ENVELOPE.ubbExpW;
        const lim = bb.maxBoardW ?? ACCEL_ENVELOPE.ubbBoardW;
        const f = board > lim + 1e-9;
        add({ id: `std-cl16-${hall.id}-${itemId}`, ruleId: 'CL-16', family: 'compute', status: f ? 'finding' : 'pass', naturalSeverity: 'warning', domain: 'cooling', refs: refsOf(g), designValue: board, limit: lim, unit: 'W', basis: 'standard', standardId: ACCEL_ENVELOPE.ubbStandardId, verification: 'derived',
          ko: `${tag}: 베이스보드 전력 ${bb.modules} × ${fmt(am.tdpW, 0)} W${bb.opt12VPerModuleW ? ` + ${bb.modules} × ${bb.opt12VPerModuleW} W(12 V)` : ''} + 확장 ${ACCEL_ENVELOPE.ubbExpW} W = ${fmt(board, 0)} W / 보드 범위 ${fmt(lim, 0)} W.`,
          en: `${tag}: baseboard power ${bb.modules} × ${fmt(am.tdpW, 0)} W${bb.opt12VPerModuleW ? ` + ${bb.modules} × ${bb.opt12VPerModuleW} W (12 V)` : ''} + expansion ${ACCEL_ENVELOPE.ubbExpW} W = ${fmt(board, 0)} W vs board envelope ${fmt(lim, 0)} W.` });
      }
    }

    // CL-11 door heat exchangers (racks carrying a rear door, door HX items, or a door-hx air side)
    const doorRacks = items.filter((p) => Number(p.e.meta?.[RDHX_DOOR_META] ?? 0) > 0);
    const doorItems = items.filter((p) => !!p.item.doorHx);
    if (doorRacks.length || doorItems.length || (profile.air === 'door-hx' && confirmed)) {
      const refs = [hall.id, ...[...doorRacks, ...doorItems].slice(0, 6).map((p) => p.e.id)];
      const s = cd.fwsSupplyC;
      const minC = Math.max(DOOR_HX_BASIS.minSupplyC, ...doorItems.map((p) => p.item.doorHx!.minSupplyC));
      add({ id: `std-cl11-supply-${hall.id}`, ruleId: 'CL-11', family: 'air', status: s + 1e-9 < minC ? 'finding' : 'pass', naturalSeverity: 'error', refs, designValue: s, limit: minC, unit: '°C', basis: 'standard', standardId: DOOR_HX_BASIS.standardId, verification: 'verified',
        ko: `${hall.name}: 도어 열교환기 공급수 ${fmt(s)} °C / 최저 ${fmt(minC)} °C (결로 방지).`, en: `${hall.name}: door heat exchanger water supply ${fmt(s)} °C vs minimum ${fmt(minC)} °C (condensation).` });
      const corridors = hall.layoutPolicy?.corridors;
      if (corridors) {
        const mm = Math.round(corridors.hotAisleM * 1000);
        const need = Math.max(DOOR_HX_BASIS.aisleOpenMm, ...doorItems.map((p) => p.item.doorHx!.aisleOpenMm));
        add({ id: `std-cl11-aisle-${hall.id}`, ruleId: 'CL-11', family: 'air', status: mm < need ? 'finding' : 'pass', naturalSeverity: 'warning', refs, designValue: mm, limit: need, unit: 'mm', basis: 'standard', standardId: DOOR_HX_BASIS.standardId, verification: 'verified',
          ko: `${hall.name}: 도어를 여는 열복도 폭 ${fmt(mm, 0)} mm / 필요 ${fmt(need, 0)} mm.`, en: `${hall.name}: hot aisle width for opening the doors ${fmt(mm, 0)} mm vs ${fmt(need, 0)} mm needed.` });
      }
      for (const p of doorItems) {
        const dp = p.item.doorHx!.coolantDpKPa;
        if (dp > DOOR_HX_BASIS.maxCoolantDpKPa + 1e-9) add({ id: `std-cl11-dp-${hall.id}-${p.item.id}`, ruleId: 'CL-11', family: 'air', status: 'finding', naturalSeverity: 'error', refs: [hall.id, p.e.id], designValue: dp, limit: DOOR_HX_BASIS.maxCoolantDpKPa, unit: 'kPa', basis: 'standard', standardId: DOOR_HX_BASIS.standardId, verification: 'verified',
          ko: `${p.item.name}: 냉각수 ΔP ${fmt(dp, 0)} kPa / 최대 ${DOOR_HX_BASIS.maxCoolantDpKPa} kPa.`, en: `${p.item.name}: coolant ΔP ${fmt(dp, 0)} kPa vs maximum ${DOOR_HX_BASIS.maxCoolantDpKPa} kPa.` });
      }
    }

    if (!liquidRacks.length) continue;

    // ── hall level: CL-02 rating basis, CL-03 approach, CL-05 pressure, CL-06 fluid window, CL-08 loop band, CL-09 alignment, CL-12, CL-14
    const cduBlocks = cdus.filter((p) => p.item.cdu);
    const conventions = [...new Set(cduBlocks.map((p) => p.item.cdu!.ratingBasis.convention))];
    if (conventions.length > 1)
      add({ id: `std-cl02-mixed-${hall.id}`, ruleId: 'CL-02', family: 'liquid', status: 'finding', naturalSeverity: 'warning', refs: [hall.id, ...cduBlocks.slice(0, 6).map((p) => p.e.id)], basis: 'standard', standardId: 'l-lcdu-wp@1.0', verification: 'verified',
        ko: `${hall.name}: CDU 정격 방식이 섞여 있습니다(${conventions.join(' / ')}). 서로 다른 방식의 정격 kW는 합산하거나 비교하지 않습니다.`, en: `${hall.name}: CDUs are rated on different conventions (${conventions.join(' / ')}); their kW ratings are not summed or compared.`,
        suggestion: '같은 정격 방식(접근 온도 · LPM/kW)의 CDU로 통일하거나 제조사 곡선으로 같은 조건의 용량을 확인하세요.', suggestionEn: 'Use CDUs rated on one convention (approach, LPM/kW) or confirm capacity at the same condition from the vendor curves.' });
    else if (conventions.length === 1 && L.cduRatingBasis && conventions[0] !== L.cduRatingBasis)
      add({ id: `std-cl02-basis-${hall.id}`, ruleId: 'CL-02', family: 'liquid', status: 'finding', naturalSeverity: 'warning', refs: [hall.id], basis: 'standard', standardId: 'l-lcdu-wp@1.0', verification: 'verified',
        ko: `${hall.name}: 배치된 CDU의 정격 방식(${conventions[0]})이 표준 프로필의 방식(${L.cduRatingBasis})과 다릅니다. 용량을 같은 조건으로 환산해 비교하세요.`, en: `${hall.name}: the placed CDUs are rated on ${conventions[0]}, the standards profile on ${L.cduRatingBasis}; convert capacities to one condition before comparing.` });

    if (cls) {
      const declaredApproach = cduBlocks.map((p) => p.item.cdu!.ratingBasis.approachK ?? p.item.cdu!.ratedApproachK).find((v) => v !== undefined);
      const approach = declaredApproach ?? (cduBlocks[0]?.item.cdu?.ratingBasis.convention === 'loop-reqs-4k' ? LOOP_REQS_APPROACH_K : CDU_CLASS_BASIS[cls].approachK);
      const gap = cd.tcsSupplyC - cd.fwsSupplyC;
      add({ id: `std-cl03-${hall.id}`, ruleId: 'CL-03', family: 'liquid', status: gap + 1e-9 < approach ? 'finding' : 'pass', naturalSeverity: 'warning', refs: [hall.id], designValue: Math.round(gap * 10) / 10, limit: approach, unit: 'K', basis: 'standard', standardId: CDU_CLASS_BASIS[cls].standardId, verification: declaredApproach !== undefined ? 'verified' : 'derived',
        ko: `${hall.name}: TCS 공급 − FWS 공급 = ${fmt(gap)} K / CDU 정격 접근 온도 ${fmt(approach)} K. 설계점에서 CDU 용량이 정격보다 작아집니다.`, en: `${hall.name}: TCS supply − FWS supply = ${fmt(gap)} K vs the CDU rated approach of ${fmt(approach)} K; capacity at the design point is below the rating.` });
    }

    // CL-05 pressure envelope + CL-06 fluid window, per connector in use
    const connectorsInUse = new Set<LiquidConnector>();
    for (const p of liquidRacks) {
      const c = asConnector(p.item.liquidInterface?.connector ?? L.connector);
      if (c) connectorsInUse.add(c);
    }
    const manifold = L.rackManifold === 'orv3-blindmate' || L.rackManifold === 'eia-vertical' ? MANIFOLD_BASIS[L.rackManifold] : undefined;
    const declaredHead = cduBlocks.map((p) => p.item.cdu!.ratingBasis.tcsHeadPsi).find((v) => v !== undefined);
    const pr = manifoldPressurePsig(hall, cls, declaredHead);
    for (const c of connectorsInUse) {
      const b = CONNECTOR_BASIS[c];
      const parts = [{ psig: b.maxWorkingPsig, id: b.standardId }, ...(manifold?.maxWorkingPsig !== undefined ? [{ psig: manifold.maxWorkingPsig, id: manifold.standardId }] : [])].sort((x, y) => x.psig - y.psig);
      const lim = parts[0];
      const f = pr.psig > lim.psig + 1e-9;
      const deschutes = cls === 'facility-2mw' && lim.psig <= 50;
      add({ id: `std-cl05-${hall.id}-${c}`, ruleId: 'CL-05', family: 'liquid', status: f ? 'finding' : 'pass', naturalSeverity: 'error', refs: [hall.id], designValue: pr.psig, limit: lim.psig, unit: 'psig', basis: pr.basis, standardId: lim.id, verification: pr.basis === 'user' ? 'verified' : 'estimate',
        ko: `${hall.name}: 랙 매니폴드 압력 ${fmt(pr.psig)} psig${pr.basis === 'estimate' ? ` (정압 ${fmt(hall.facility?.tcsStaticFillPsig ?? TCS_STATIC_FILL_PSIG_ESTIMATE)} + CDU 양정 ${fmt(declaredHead ?? (cls ? CDU_CLASS_BASIS[cls].headPsi : 0))} psi, 추정)` : ''} / 최대 사용 압력 ${fmt(lim.psig)} psig.${deschutes ? ' 시설 CDU(IT측 가용 차압 80–90 psi)는 50 psig 블라인드메이트 부품에 그대로 연결할 수 없습니다.' : ''}`,
        en: `${hall.name}: rack manifold pressure ${fmt(pr.psig)} psig${pr.basis === 'estimate' ? ` (static fill ${fmt(hall.facility?.tcsStaticFillPsig ?? TCS_STATIC_FILL_PSIG_ESTIMATE)} + CDU head ${fmt(declaredHead ?? (cls ? CDU_CLASS_BASIS[cls].headPsi : 0))} psi, estimate)` : ''} vs maximum working pressure ${fmt(lim.psig)} psig.${deschutes ? ' A facility CDU (80–90 psi available IT-side ΔP) cannot connect to 50 psig blind-mate parts as-is.' : ''}`,
        ...(f ? { suggestion: '행 단위 감압 장치를 두거나(홀 시설 입력의 매니폴드 설계 압력) 사용 압력이 높은 랙 인터페이스를 선택하세요.', suggestionEn: 'Add row pressure reduction (set the manifold design pressure in the hall facility inputs) or choose a rack interface with a higher working pressure.' } : {}) });
      if (b.connectPsig !== undefined && pr.psig > b.connectPsig + 1e-9 && !f)
        add({ id: `std-cl05-connect-${hall.id}-${c}`, ruleId: 'CL-05', family: 'liquid', status: 'finding', naturalSeverity: 'warning', refs: [hall.id], designValue: pr.psig, limit: b.connectPsig, unit: 'psig', basis: pr.basis, standardId: b.standardId, verification: pr.basis === 'user' ? 'verified' : 'estimate',
          ko: `${hall.name}: 운전 압력 ${fmt(pr.psig)} psig가 연결 · 분리 한도 ${b.connectPsig} psig를 넘습니다. 서비스 전에 격리하고 압력을 낮추세요.`, en: `${hall.name}: operating pressure ${fmt(pr.psig)} psig is above the ${b.connectPsig} psig connect / disconnect limit; isolate and depressurise before service.` });
      const ret = cd.tcsSupplyC + dT;
      const maxParts = [{ c: b.maxFluidC, id: b.standardId }, ...(manifold ? [{ c: manifold.maxFluidC, id: manifold.standardId }] : [])].sort((x, y) => x.c - y.c);
      const fluidMax = TCS_FLUIDS[fluid]?.maxC;
      const maxC = Math.min(maxParts[0].c, fluidMax ?? Infinity);
      add({ id: `std-cl06-${hall.id}-${c}`, ruleId: 'CL-06', family: 'liquid', status: ret > maxC + 1e-9 ? 'finding' : 'pass', naturalSeverity: 'error', refs: [hall.id], designValue: ret, limit: maxC, unit: '°C', basis: 'standard', standardId: maxParts[0].c <= (fluidMax ?? Infinity) ? maxParts[0].id : TCS_FLUIDS[fluid]?.standardId, verification: 'verified',
        ko: `${hall.name}: TCS 환수 ${fmt(ret)} °C (공급 ${fmt(cd.tcsSupplyC)} + ΔT ${fmt(dT)}) / 최고 유체 온도 ${fmt(maxC)} °C.`, en: `${hall.name}: TCS return ${fmt(ret)} °C (supply ${fmt(cd.tcsSupplyC)} + ΔT ${fmt(dT)}) vs maximum fluid temperature ${fmt(maxC)} °C.` });
      if (b.minFluidC !== undefined && cd.tcsSupplyC < b.minFluidC - 1e-9)
        add({ id: `std-cl06-min-${hall.id}-${c}`, ruleId: 'CL-06', family: 'liquid', status: 'finding', naturalSeverity: 'warning', refs: [hall.id], designValue: cd.tcsSupplyC, limit: b.minFluidC, unit: '°C', basis: 'standard', standardId: b.standardId, verification: 'verified',
          ko: `${hall.name}: TCS 공급 ${fmt(cd.tcsSupplyC)} °C가 커넥터 최저 온도 ${b.minFluidC} °C보다 낮습니다.`, en: `${hall.name}: TCS supply ${fmt(cd.tcsSupplyC)} °C is below the connector minimum of ${b.minFluidC} °C.` });
    }

    // CL-08 loop band (hall liquid above the largest band → split loops)
    const dn150 = tcsBandCapacityKW(150, dT);
    if (hallLiquidKW > dn150 + 1e-9 && confirmed)
      add({ id: `std-cl08-loop-${hall.id}`, ruleId: 'CL-08', family: 'liquid', status: 'finding', naturalSeverity: 'info', refs: [hall.id], designValue: Math.round(hallLiquidKW), limit: Math.round(dn150), unit: 'kW', basis: 'standard', standardId: 'modular-tcs-wp@dlm1', verification: 'derived',
        ko: `${hall.name}: 홀 액체 부하 ${fmt(hallLiquidKW, 0)} kW가 DN150 루프 용량 ${fmt(dn150, 0)} kW를 넘습니다. 루프를 ${Math.ceil(hallLiquidKW / dn150)}개 이상으로 나누세요.`, en: `${hall.name}: hall liquid load ${fmt(hallLiquidKW, 0)} kW exceeds the DN150 loop capacity of ${fmt(dn150, 0)} kW; split into at least ${Math.ceil(hallLiquidKW / dn150)} loops.` });

    // CL-09 electrical ↔ cooling block alignment (TCS sized to ~80 % of the electrical block). QA (standards) fix: the electrical block is
    // the power-plane CIRCUIT, not the whole row busway — engines/powerPaths.ts splits a row busway into contiguous circuits until each
    // stays within its continuous limit, so comparing a row's liquid load with one busway rating flagged rows the power plane had already
    // split (neutral reference: 12 × 42.4 kW = 509 kW vs 0.8 × 575 kW, while each of its 2 circuits carries 254 kW). Stored busways only.
    const liquidById = new Map(liquidRacks.map((p) => [p.e.id, (p.item.power?.nameplateKW ?? 0) * (p.item.cooling?.liquidFraction ?? 0)]));
    const storedBusways = new Set((project.busways ?? []).filter((b) => b.hallId === hall.id).map((b) => b.id));
    if (storedBusways.size && liquidById.size) {
      plane ??= buildPowerPlane(project, inputs.network ? { network: inputs.network } : undefined);
      const hallCircuits = plane.circuits.filter((c) => c.hallId === hall.id && storedBusways.has(c.buswayId));
      const sideA = hallCircuits.some((c) => c.side === 'A') ? hallCircuits.filter((c) => c.side === 'A') : hallCircuits;
      let worst: { id: string; busway: string; circuit: number; liquid: number; kw: number } | undefined;
      let checked = 0;
      for (const c of sideA) {
        const liquid = c.rackIds.reduce((s, id) => s + (liquidById.get(id) ?? 0), 0);
        if (!(liquid > 0 && c.ratedKW > 0)) continue;
        checked++;
        if (liquid > 0.8 * c.ratedKW + 1e-9 && (!worst || liquid / c.ratedKW > worst.liquid / worst.kw)) worst = { id: c.id, busway: c.buswayId, circuit: c.circuit, liquid, kw: c.ratedKW };
      }
      if (worst)
        add({ id: `std-cl09-${hall.id}`, ruleId: 'CL-09', family: 'liquid', status: 'finding', naturalSeverity: 'warning', refs: [hall.id], designValue: Math.round(worst.liquid), limit: Math.round(0.8 * worst.kw), unit: 'kW', basis: 'standard', standardId: 'modular-tcs-wp@dlm1', verification: 'derived',
          ko: `${hall.name}: 버스웨이 ${worst.busway} 회로 ${worst.circuit}에 연결된 랙의 액체 부하 ${fmt(worst.liquid, 0)} kW가 회로 전기 블록 ${fmt(worst.kw, 0)} kW의 80 %(${fmt(0.8 * worst.kw, 0)} kW)를 넘습니다. 냉각 블록과 전기 블록 크기가 맞지 않습니다.`,
          en: `${hall.name}: racks on busway ${worst.busway} circuit ${worst.circuit} carry ${fmt(worst.liquid, 0)} kW of liquid load, above 80 % of the ${fmt(worst.kw, 0)} kW circuit electrical block (${fmt(0.8 * worst.kw, 0)} kW); cooling and electrical blocks are misaligned.` });
      else if (checked)
        add({ id: `std-cl09-${hall.id}`, ruleId: 'CL-09', family: 'liquid', status: 'pass', naturalSeverity: 'warning', refs: [hall.id], unit: 'kW', basis: 'standard', standardId: 'modular-tcs-wp@dlm1', verification: 'derived',
          ko: `${hall.name}: 전원 회로 ${checked}개 모두 액체 부하가 회로 전기 블록의 80 % 이하입니다.`, en: `${hall.name}: liquid load of all ${checked} power circuits is within 80 % of their circuit electrical blocks.` });
    }

    if (confirmed) {
      const filtered = cduBlocks.some((p) => (p.item.cdu!.filtrationUm ?? Infinity) <= 50);
      if (!filtered)
        add({ id: `std-cl12-${hall.id}`, ruleId: 'CL-12', family: 'liquid', status: 'finding', naturalSeverity: 'info', refs: [hall.id], basis: 'standard', standardId: 'l-lcdu-wp@1.0', verification: 'verified',
          ko: `${hall.name}: 여과 · 시운전 품목을 BOM에 넣으세요 — CDU 스트레이너(1차 ≤ 200 µm, 2차 ≤ 50 µm), 측류 여과, 임시 플러싱 스키드, 루프백.`, en: `${hall.name}: add filtration and commissioning lines to the BOM — CDU strainers (primary ≤ 200 µm, secondary ≤ 50 µm), side-stream filtration, a temporary flushing skid and loop-backs.` });
      const r = cd.fwsReturnC;
      const band = r < 20 ? '< 20 °C' : r <= 45 ? '20–45 °C' : '> 45 °C';
      add({ id: `std-cl14-${hall.id}`, ruleId: 'CL-14', family: 'liquid', status: 'finding', naturalSeverity: 'info', refs: [hall.id], designValue: r, unit: '°C', basis: 'standard', standardId: 'heat-reuse-rd@1.0', verification: 'verified',
        ko: `${hall.name}: FWS 환수 ${fmt(r)} °C — 열 재사용 온도 대역 ${band}.`, en: `${hall.name}: FWS return ${fmt(r)} °C — heat-reuse temperature band ${band}.` });
    }
  }
  return out;
}
