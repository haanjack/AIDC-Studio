// Analysis engines (space, network & cabling, cooling, power, cost/BOM, schedule, workload, validation).
import type {
  CoolingAnalysis,
  CostAnalysis,
  FabricTech,
  NetworkAnalysis,
  PowerAnalysis,
  Project,
  ProjectAnalysis,
  ScheduleAnalysis,
  SpaceAnalysis,
  WorkloadAnalysis,
  WorkloadBlueprint,
} from '../model/types.ts';
import { buildContext, cableUnitUSD, type Ctx, itemPriceUSD } from './context.ts';
import { analyzeCoolingCtx } from './cooling.ts';
import { analyzeCostCtx } from './cost.ts';
import { analyzeNetworkCtx, FABRIC_LABEL, FABRIC_SWITCH } from './network.ts';
import { analyzePowerCtx } from './power.ts';
import { analyzeScheduleCtx } from './schedule.ts';
import { analyzeSpaceCtx } from './space.ts';
import { validateProjectCtx } from './validate.ts';
import { analysedBlueprint, analyzeWorkloadsCtx, simulateWorkload, workloadEnv } from './workload.ts';
import { cableTypes } from '../catalog/catalog.ts';
import { resolveCatalog, withCatalog } from '../catalog/registry.ts';
import { analyzePlacement } from './placement.ts';
import { AGGREGATE_TRAFFIC_ID, analyzeAggregateTraffic, analyzeTraffic } from './traffic.ts';
import { analyzePowerPaths } from './powerPaths.ts';
import { interHallGeometry } from './interHall.ts';
import { analyzeMaxQ } from './maxq.ts';
import { compareCoolingTopologies } from './coolingTopology.ts';

export { buildContext, type Ctx, type Placed } from './context.ts';
export { FABRIC_LABEL, FABRIC_SWITCH, FABRIC_TECH_FACTOR, cableLengthM, chooseCable, commEfficiency, railsFor, sizeFabric, type FabricPlan, type FabricKey, type NetworkResult } from './network.ts';
// v2 (S2): placement / DDC / load-balancing helpers
export { DDC_MAX_NCF, DDC_MAX_NCP, DDC_TABLE, ETA_DEFAULT, FABRIC_LB_DEFAULT, FABRIC_SPINE_SWITCH, LB_LABEL, etaFor, isHgxType, mediumOf, normalizeLeafPlacement, normalizeSpinePlacement, resolveSwitchItem, sizeDdc, type DdcOptions, type DdcSizing } from './network.ts';
export { interHallLengthM, type EtaInUse } from './network.ts'; // v2 2차 (T2)
export { AGGREGATE_TRAFFIC_ID, MFU_DEFAULT, OVERLAP_DEFAULT, analyzeAggregateTraffic, computeInferenceTraffic, computeTraffic, peakFlopsFor, type AggregateTrafficInput, type InferenceTrafficSpec, type TrafficFabric, type TrafficGpu, type TrafficSpec } from './traffic.ts';
export { OVERLAP_FRAMEWORKS, buildTrafficSpec, etaSensitivity, overlapDefaults, projectEtaSensitivity, type EtaSensitivityPoint, type OverlapDefault, type OverlapFramework, type ProjectEtaSensitivity } from './traffic.ts'; // v2 2차 (T2)
export { PLACEMENT_LABEL, evaluatePlacementCandidate, type PlacementOptions } from './placement.ts';
export { clearanceZones, findClearanceIntrusions, floorLoadKgPerM2 } from './space.ts';
export { airDeltaT, dryBulbFraction, wetBulbFraction } from './cooling.ts';
export { simulateInference, simulateTraining, simulateWorkload, type WorkloadEnv } from './workload.ts';
export { analyzeInferenceWorkloadPareto, paretoPointPatch, type InferenceWorkloadParetoPoint, type InferenceWorkloadParetoReport, type InferenceWorkloadParetoSeries } from './inferencePareto.ts';
export { analyzeTrainingWorkloadTopologies, type TrainingTopologyCandidate, type TrainingTopologyReason, type TrainingTopologyReport } from './trainingTopology.ts';
// v2 contract exports
export * from './radix.ts';
export { analyzeInferenceTraffic, analyzeTraffic, type TrafficInput } from './traffic.ts';
export { analyzePlacement, type PlacementInput } from './placement.ts';
// v2 2차 contract exports (T2 cluster/eta/links/ipplan · T3 powerPaths/maxq · T4 coolingTopology)
export * from './cluster.ts';
export * from './eta.ts';
export * from './links.ts';
export * from './ipplan.ts';
export * from './powerPaths.ts';
export * from './maxq.ts';
export * from './coolingTopology.ts';
// stream C (P3): standards parameter checks (RK / PW / NW, CL in cooling.ts, FC in facilityPrecheck.ts)
import { evaluateStandardsChecks, type StandardsCheckReport } from './standardsChecks.ts';
export { BBU_TRANSFER_MARGIN_S, FRAME_BASIS, HPR_AIR_BUSBAR_ROOFLINE_KW, IT_INPUT_WINDOW_V, NW_BASIS, SHELF_BASIS, SIDECAR_BBU_S, SIDECAR_RATING_KW, evaluateNetworkChecks, evaluateRackPowerChecks, evaluateStandardsChecks, frameRatingOf, interpBackupS, nodeMassOf, rackFormOf, rackPowerOf, shelfBasisFor, shelfClassOf, shelvesInRack, standardsCheckIssues, twoTierSpinesFor, type ShelfBasis, type StandardsCheckReport } from './standardsChecks.ts';
export { capSeverity, isDraftBasis, resultsToIssues, type CheckStatus, type StandardsCheckResult } from './standardsBasis.ts';
export * from './facilityPrecheck.ts';
export { ACCEL_ENVELOPE, CDU_CLASS_BASIS, CONNECTOR_BASIS, DOOR_HX_BASIS, ITE_CLASS_LIQUID_FRACTION, LOOP_REQS_APPROACH_K, MANIFOLD_BASIS, PSI_TO_KPA, TCS_STATIC_FILL_PSIG_ESTIMATE, cduUnitsOnBasis, connectorPairKW, connectorPairRating, connectorPairsNeeded, evaluateLiquidChecks, manifoldPressurePsig, uqdPairDpKPa, type ConnectorBasis, type LiquidConnector } from './cooling.ts';

/** Run `fn` with the project's effective catalog (builtin ∪ library ∪ project.catalogExtensions) active. */
function withProjectCatalog<T>(project: Project, fn: () => T): T {
  return withCatalog(resolveCatalog(project), fn);
}

function pipeline(project: Project) {
  const ctx = buildContext(project);
  const space = analyzeSpaceCtx(ctx);
  const network = analyzeNetworkCtx(ctx);
  const cooling = analyzeCoolingCtx(ctx, network);
  const power = analyzePowerCtx(ctx, network, cooling);
  // Traffic runs before workload simulation so its measured/derived communication efficiency can feed the selected scenario.
  // The user may explicitly select a training or inference blueprint; otherwise retain the training-first default for old projects.
  const eligible = project.workloads.filter((w) => w.training || w.inference);
  const aggregateSelected = project.network.trafficWorkloadId === AGGREGATE_TRAFFIC_ID
    || (!project.network.trafficWorkloadId && eligible.length > 1);
  const selected = eligible.find((w) => w.id === project.network.trafficWorkloadId)
    ?? eligible.find((w) => w.training)
    ?? eligible.find((w) => w.inference);
  // Σ gpuShare > 1 → the traffic engine sees the same proportionally scaled share as workload.ts.
  const traffic = aggregateSelected
    ? analyzeAggregateTraffic({ project, workloads: eligible.map((w) => analysedBlueprint(project.workloads, w)), ctx, network })
    : selected ? analyzeTraffic({ project, workload: analysedBlueprint(project.workloads, selected), ctx, network }) : undefined;
  if (traffic) network.analysis.traffic = traffic;
  // The aggregate is a presentation/sizing view. Each workload still receives its own traffic report so step time,
  // inference capacity and communication efficiency never inherit an unrelated facility-average scalar.
  const trafficByWorkload = aggregateSelected
    ? new Map(eligible.map((w) => {
      const analysed = analysedBlueprint(project.workloads, w);
      return [w.id, analyzeTraffic({ project, workload: analysed, ctx, network })] as const;
    }).filter((pair): pair is readonly [string, NonNullable<(typeof pair)[1]>] => !!pair[1]))
    : undefined;
  const workloads = analyzeWorkloadsCtx(ctx, network, power, trafficByWorkload);
  const cost = analyzeCostCtx(ctx, { network, cooling, power });
  const schedule = analyzeScheduleCtx(ctx, { network, cooling, power });
  const placement = analyzePlacement({ project, ctx, network });
  if (placement) network.analysis.placement = placement;
  return { ctx, space, network, cooling, power, workloads, cost, schedule };
}

export function analyzeProject(project: Project): ProjectAnalysis {
  return withProjectCatalog(project, () => analyzeProjectInner(project));
}

function analyzeProjectInner(project: Project): ProjectAnalysis {
  const p = pipeline(project);
  const issues = validateProjectCtx(p.ctx, { space: p.space, network: p.network.analysis, cooling: p.cooling, power: p.power, schedule: p.schedule, cost: p.cost, workloads: p.workloads });
  const racks = p.space.reduce((s, h) => s + h.rackCount, 0);
  const analysis: ProjectAnalysis = {
    generatedAt: new Date().toISOString(),
    summary: {
      halls: project.halls.length,
      racks,
      gpuRacks: p.ctx.placed.filter((x) => x.item.category === 'gpu-rack').length,
      gpus: p.ctx.gpus,
      acceleratorChips: p.ctx.acceleratorChips,
      itMW: p.power.itDesignKW / 1000,
      facilityMW: p.power.facilityKW / 1000,
      pue: p.power.pue,
      capexUSD: p.cost.capexUSD,
      readyForService: p.schedule.readyForServiceDate,
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
    },
    space: p.space,
    power: p.power,
    cooling: p.cooling.analysis,
    network: p.network.analysis,
    cost: p.cost,
    schedule: p.schedule,
    workloads: p.workloads,
    issues,
  };
  // v2 2차 contract wiring: optional blocks are attached only when the engine returns something (stubs → unchanged output)
  const paths = analyzePowerPaths(project, analysis);
  if (paths.length) analysis.power.paths = paths;
  // finish v2 2차 (D1 / D5): trunk sleeves + site pathways between joined halls, partition sleeves for trays and cables
  const interHall = interHallGeometry(project, analysis);
  if (interHall.penetrations.length) analysis.network.penetrations = interHall.penetrations;
  if (interHall.pathways.length) analysis.network.interHallPathways = interHall.pathways;
  const maxq = analyzeMaxQ(project, analysis);
  if (maxq) analysis.power.maxq = maxq;
  const topology = compareCoolingTopologies(project, analysis);
  if (topology.length) analysis.cooling.topology = topology;
  return analysis;
}

// ───────────── per-domain entry points for UI reuse ─────────────

export function analyzeSpace(project: Project): SpaceAnalysis[] {
  return withProjectCatalog(project, () => analyzeSpaceCtx(buildContext(project)));
}

export function analyzeNetwork(project: Project): NetworkAnalysis {
  return withProjectCatalog(project, () => analyzeNetworkCtx(buildContext(project)).analysis);
}

export function analyzeCooling(project: Project): CoolingAnalysis {
  return withProjectCatalog(project, () => {
    const ctx = buildContext(project);
    return analyzeCoolingCtx(ctx, analyzeNetworkCtx(ctx)).analysis;
  });
}

export function analyzePower(project: Project): PowerAnalysis {
  return withProjectCatalog(project, () => {
    const ctx = buildContext(project);
    const net = analyzeNetworkCtx(ctx);
    return analyzePowerCtx(ctx, net, analyzeCoolingCtx(ctx, net));
  });
}

export function analyzeCost(project: Project): CostAnalysis {
  return withProjectCatalog(project, () => pipeline(project).cost);
}

export function analyzeSchedule(project: Project): ScheduleAnalysis {
  return withProjectCatalog(project, () => pipeline(project).schedule);
}

export function analyzeWorkloads(project: Project): WorkloadAnalysis[] {
  return withProjectCatalog(project, () => pipeline(project).workloads);
}

/** Simulate one blueprint (possibly not yet saved in the project) against the project's cluster. */
export function analyzeWorkload(project: Project, workload: WorkloadBlueprint): WorkloadAnalysis {
  return withProjectCatalog(project, () => {
    const ctx = buildContext(project);
    const net = analyzeNetworkCtx(ctx);
    const power = analyzePowerCtx(ctx, net, analyzeCoolingCtx(ctx, net));
    // v2 (S2): same effective efficiency the pipeline would use for this blueprint
    const traffic = workload.training ? analyzeTraffic({ project, workload, ctx, network: net }) : undefined;
    if (traffic) net.analysis.traffic = traffic;
    return simulateWorkload(workload, workloadEnv(ctx, net, power));
  });
}

/**
 * Stream C (P3): full standards check report of a project — findings, passes and not-modelled rows (RK / PW / CL / NW / FC) plus the
 * facility pre-check tables. The issue list of `analyzeProject` carries the findings only.
 */
export function standardsCheckReport(project: Project): StandardsCheckReport {
  return withProjectCatalog(project, () => {
    const p = pipeline(project);
    return evaluateStandardsChecks(p.ctx, { network: p.network.analysis });
  });
}

export function validateProject(project: Project) {
  return withProjectCatalog(project, () => {
    const p = pipeline(project);
    return validateProjectCtx(p.ctx, { space: p.space, network: p.network.analysis, cooling: p.cooling, power: p.power, schedule: p.schedule, cost: p.cost, workloads: p.workloads });
  });
}

// ───────────── IB vs RoCE consulting comparison ─────────────

export interface FabricComparison {
  fabric: FabricTech;
  label: string;
  switchCatalogId: string;
  switches: number;
  tiers: number;
  cables: number;
  transceivers: number;
  networkCapexUSD: number;
  networkPowerKW: number;
  commEfficiency: number;
  /** v2: workload-driven effective efficiency (engines/traffic.ts) used for tokensPerSec / timeToTrainDays */
  commEfficiencyEffective?: number;
  tokensPerSec?: number;
  timeToTrainDays?: number;
  /** scale-out capex per GPU */
  usdPerGpu: number;
  /** false when the fabric cannot be built as sized (DDC beyond the 2-tier FSE cap, forced tiers too small) */
  feasible?: boolean;
  /** DDC sized beyond the RA-validated base clusters — switch counts and train days are an extrapolation (estimate) */
  extrapolated?: boolean;
}

export function compareFabrics(project: Project, fabrics: FabricTech[]): FabricComparison[] {
  return withProjectCatalog(project, () => compareFabricsInner(project, fabrics));
}

function compareFabricsInner(project: Project, fabrics: FabricTech[]): FabricComparison[] {
  const cableById = new Map(cableTypes().map((c) => [c.id, c]));
  const baseCtx = buildContext(project);
  const baseNet = analyzeNetworkCtx(baseCtx);
  const pue = analyzePowerCtx(baseCtx, baseNet, analyzeCoolingCtx(baseCtx, baseNet)).pue;
  const training = project.workloads.find((w) => w.kind === 'llm-pretrain' || w.kind === 'llm-finetune');
  return fabrics.map((fabric) => {
    const variant: Project = {
      ...project,
      network: { ...project.network, scaleOut: { ...project.network.scaleOut, fabric, switchCatalogId: FABRIC_SWITCH[fabric] } },
    };
    const ctx = buildContext(variant);
    const net = analyzeNetworkCtx(ctx);
    const plan = net.plans.find((p) => p.key === 'scale-out');
    const soRuns = net.analysis.cableRuns.filter((r) => plan && r.fabric === plan.label && r.id.startsWith('cr-scale-out'));
    let cables = 0;
    let transceivers = 0;
    let cableUSD = 0;
    let xcvrW = 0;
    for (const r of soRuns) {
      const t = cableById.get(r.cableTypeId)!;
      cables += r.count;
      if (t.transceiverUSD > 0) transceivers += 2 * r.count;
      cableUSD += r.count * cableUnitUSD(variant, t, r.lengthM);
      xcvrW += r.count * (r.tier === 'endpoint-leaf' ? 1 : 2) * t.transceiverW;
    }
    const switches = plan ? plan.leaves + plan.spines + plan.cores : 0;
    const spineSw = plan?.spineSw ?? plan?.sw; // DDC fabrics price NCP leaves and NCF spines separately
    const networkCapexUSD = (plan ? plan.leaves * itemPriceUSD(variant, plan.sw) + (plan.spines + plan.cores) * itemPriceUSD(variant, spineSw!) : 0) + cableUSD;
    // v2 (S2): the same traffic report the main pipeline uses, so the table's train days match the workload panel
    const trainingEff = training ? analysedBlueprint(project.workloads, training) : undefined; // v2 2차 (T6): scaled share when Σ > 1
    const traffic = trainingEff ? analyzeTraffic({ project: variant, workload: trainingEff, ctx, network: net }) : undefined;
    if (traffic) net.analysis.traffic = traffic;
    const wl = trainingEff ? simulateWorkload(trainingEff, workloadEnv(ctx, net, { pue })) : undefined;
    return {
      fabric,
      label: FABRIC_LABEL[fabric],
      switchCatalogId: plan?.sw.id ?? FABRIC_SWITCH[fabric],
      switches,
      tiers: plan?.tiers ?? 0,
      cables,
      transceivers,
      networkCapexUSD,
      networkPowerKW: (plan ? plan.leaves * (plan.sw.power?.nameplateKW ?? 0) + (plan.spines + plan.cores) * (spineSw?.power?.nameplateKW ?? 0) : 0) + xcvrW / 1000,
      commEfficiency: net.analysis.commEfficiency,
      commEfficiencyEffective: traffic?.commEfficiencyEffective,
      tokensPerSec: wl?.tokensPerSec,
      timeToTrainDays: wl?.timeToTrainDays,
      usdPerGpu: ctx.gpus > 0 ? networkCapexUSD / ctx.gpus : 0,
      feasible: plan?.feasible ?? true,
      ...(plan?.extrapolated ? { extrapolated: true } : {}),
    };
  });
}
