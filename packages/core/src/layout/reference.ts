import type { Hall, Project, SpinePlacement } from '../model/types.ts';
import { standardCitation, standardsPreset } from '../standards/registry.ts';
import { calibrateLayout, growHallToFit, servicesZoneRecordOf } from './fit.ts';
import { generateHallLayout, type FabricOptions, type PodInfo } from './generate.ts';
import { createVendorSampleProject, type VendorSampleId } from './samples/index.ts';
import { DEFAULT_TEMPLATE_ID, findLayoutTemplate, standardCorridors } from './templates/index.ts';

export interface ReferenceOptions {
  pods?: number;
  gpuRackCatalogId?: string;
  name?: string;
  /** GPU racks per row (default 12, reference deployment unit) */
  racksPerRow?: number;
  /** pod columns across the row axis (default 1) */
  columns?: number;
  /** network-core placement (default 'central-end') */
  spinePlacement?: SpinePlacement;
  /** adopt the cooling engine's CRAH count in a third generator pass (default true) */
  calibrate?: boolean;
  /** build a vendor sample instead of the vendor-neutral reference (layout/samples) */
  sample?: VendorSampleId;
}

/** Display name of the vendor-neutral reference (no vendor, no standards-body mark: proposal §7.1, P5). */
export const NEUTRAL_REFERENCE_NAME = 'Reference AI Hall — liquid-cooled 21-inch OU racks';
export const NEUTRAL_REFERENCE_ID = 'ref-neutral-hall';

/** Fabric switch classes of the neutral reference (generic merchant-silicon classes; NW-04). */
const NEUTRAL_FABRICS: Required<FabricOptions> = {
  frontend: { enabled: true, switchCatalogId: 'generic-roce-400', oversubscription: 2 },
  storage: { enabled: true, switchCatalogId: 'generic-roce-400', oversubscription: 1 },
  oob: { enabled: true, switchCatalogId: 'switch-oob-1g-48' },
};

/** Planner estimates of the neutral reference hall inputs (editable; listed in the standards-basis note). */
export const NEUTRAL_REFERENCE_FACILITY = {
  /** generator load acceptance, s — inside the v2 Hyperscale optimum band (PW-06 / FC-07 evaluate) */
  generatorAcceptanceS: 15,
  /** rack-manifold design pressure after a row pressure-reducing station, psig (≤ 50 psig blind-mate limit, CL-05) */
  tcsManifoldPsig: 45,
} as const;

/**
 * Reference project (stream D / P4; OCP-DESIGN-PROPOSAL §7.1; DECISIONS-v2-2 §I DO-1, DO-2, DO-6, DO-10): the default for new
 * projects. A vendor-neutral liquid-cooled AI hall built from standard profiles and generic class ids.
 *   Hall A — 4 × `std-orv3-hpr-liquid-du`: 96 high-power 21-inch OU racks × 5 generic 8-module DLC nodes (480 nodes,
 *            3,840 accelerators; ≈53 kW per rack, estimate), row CDUs on the L-LCDU rating basis, generic Ethernet fabrics.
 *   Hall B — empty white space reserved for phase 2.
 * Profile `orv3-hpr-liquid` (confirmed, advisory checks, drafts off; facility pre-check v2 for Hyperscale rev 1.15).
 * `opts.sample` builds a vendor sample instead ("NVIDIA reference", layout/samples).
 */
export function createReferenceProject(opts: ReferenceOptions = {}): { project: Project; pods: PodInfo[] } {
  if (opts.sample) {
    const { sample, ...rest } = opts;
    return createVendorSampleProject(sample, rest);
  }
  const pods = opts.pods ?? 4;
  const now = new Date().toISOString();
  const tpl = findLayoutTemplate(DEFAULT_TEMPLATE_ID)!;
  const template = { ...tpl.pod, gpuRackCatalogId: opts.gpuRackCatalogId ?? tpl.pod.gpuRackCatalogId, racksPerRow: opts.racksPerRow ?? tpl.pod.racksPerRow };
  const standards = standardsPreset('orv3-hpr-liquid');
  const corridors = standardCorridors(standards.facilityPrecheck);

  const hallA: Hall = {
    id: 'hall-a',
    name: 'Data Hall A',
    origin: { x: 0, y: 0 },
    width: 0,
    depth: 0,
    clearHeight: 6.0,
    raisedFloorHeight: 0,
    ceilingPlenumHeight: 2.38,
    floorLoadingKgPerM2: 1500,
    tileSize: 0.6,
    itPowerBudgetKW: 16_000,
    liquidCoolingBudgetKW: 14_000,
    airCoolingBudgetKW: 4_000,
    keepouts: [],
    trayHeight: 2.9,
    facility: { generatorAcceptanceS: NEUTRAL_REFERENCE_FACILITY.generatorAcceptanceS, tcsManifoldPsig: NEUTRAL_REFERENCE_FACILITY.tcsManifoldPsig, rackBbuAllowed: true, containment: 'hot-aisle' },
  };

  const layoutOpts = {
    hall: hallA,
    pods,
    template,
    services: { spineRacks: 'auto' as const, storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 },
    crahCatalogId: 'crah-generic-400',
    crahs: 'auto' as const,
    crahRedundancy: 'N+1',
    marginM: 1.0,
    podsPerWave: 2,
    columns: opts.columns ?? 1,
    spinePlacement: opts.spinePlacement ?? 'central-end',
    corridors,
    templateId: tpl.id,
    fabrics: NEUTRAL_FABRICS,
  };
  let layout = growHallToFit(hallA, layoutOpts);
  hallA.keepouts = [
    { id: 'ko-a-door-w', kind: 'door', rect: { x: 0, y: hallA.depth / 2 - 1.2, w: 0.3, d: 2.4 }, label: 'Equipment door' },
    { id: 'ko-a-egress-e', kind: 'egress', rect: { x: hallA.width - 0.3, y: 1.0, w: 0.3, d: 1.2 }, label: 'Egress' },
  ];
  layout = generateHallLayout(layoutOpts);
  hallA.layoutPolicy = { templateId: tpl.id, orientation: 'x', grid: { columns: layout.grid.columns, rows: layout.grid.rows }, corridors, crahStrategy: 'perimeter', crahWalls: layout.crah.walls, objective: 'max-gpus' };

  const hallB: Hall = {
    ...hallA,
    id: 'hall-b',
    name: 'Data Hall B (Phase 2)',
    origin: { x: hallA.width + 12, y: 0 },
    itPowerBudgetKW: 16_000,
    keepouts: [
      { id: 'ko-b-col-1', kind: 'column', rect: { x: hallA.width / 2 - 0.3, y: hallA.depth / 3 - 0.3, w: 0.6, d: 0.6 }, label: 'Column C-1' },
      { id: 'ko-b-col-2', kind: 'column', rect: { x: hallA.width / 2 - 0.3, y: (2 * hallA.depth) / 3 - 0.3, w: 0.6, d: 0.6 }, label: 'Column C-2' },
    ],
  };
  delete hallB.layoutPolicy;

  const computePods = layout.pods.filter((p) => (p.kind ?? 'compute') === 'compute');
  const waves = [...new Set(computePods.map((p) => p.waveId))].sort();
  const pinned = Object.values(standards.pinned).flat().filter((id): id is string => typeof id === 'string');

  const project: Project = {
    schemaVersion: 1,
    id: NEUTRAL_REFERENCE_ID,
    name: opts.name ?? NEUTRAL_REFERENCE_NAME,
    description:
      'Vendor-neutral AI hall reference: high-power 21-inch OU racks with 5 generic 8-module direct-liquid-cooled nodes each, 2 × 12-rack hot-aisle pods, row liquid-to-liquid CDUs, generic Ethernet fabrics. Built from standard profiles and generic classes (AIDC Studio defaults and estimates, editable).',
    client: 'Sample Client',
    author: 'AIDC Studio',
    createdAt: now,
    updatedAt: now,
    standards,
    site: {
      name: 'Sample AI Campus',
      location: 'Gyeonggi-do, KR',
      latitude: 37.0,
      longitude: 127.1,
      elevationM: 40,
      climate: { designDryBulbC: 33.5, designWetBulbC: 27.2, annualMeanC: 12.8, economizerHours: 5200 },
      utility: [
        { id: 'feed-a', name: '154 kV Feed A', voltageKV: 154, capacityMVA: 40, substation: 'North S/S', availableFrom: '2027-03-01' },
        { id: 'feed-b', name: '154 kV Feed B', voltageKV: 154, capacityMVA: 40, substation: 'South S/S', availableFrom: '2027-05-01' },
      ],
      electricityUSDPerKWh: 0.125,
      carbonKgPerKWh: 0.43,
      waterUSDPerM3: 1.1,
    },
    halls: [hallA, hallB],
    equipment: layout.equipment,
    containments: layout.containments,
    trays: layout.trays,
    busways: layout.busways,
    ...(layout.reservations?.length ? { reservations: layout.reservations } : {}),
    ...(servicesZoneRecordOf(hallA.id, layout) ? { servicesZones: [servicesZoneRecordOf(hallA.id, layout)!] } : {}),
    power: {
      distributionVoltageV: 415,
      distribution: 'busway',
      upsRedundancy: 'block-redundant',
      generatorRedundancy: 'N+1',
      transformerRedundancy: '2N',
      upsCatalogId: 'ups-generic-1200',
      generatorCatalogId: 'genset-2500',
      transformerCatalogId: 'xfmr-3000',
      rppCatalogId: 'rpp-800a',
      batteryMinutes: 5,
      powerFactor: 0.97,
      deratingFactor: 0.8,
      diversityFactor: 0.9,
      mechanicalOnUps: true,
      powerSmoothing: 'rack-level',
    },
    cooling: {
      fwsSupplyC: 30,
      fwsReturnC: 40,
      tcsSupplyC: 35,
      supplyAirC: 24,
      cduCatalogId: template.cduCatalogId,
      crahCatalogId: 'crah-generic-400',
      chillerCatalogId: 'chiller-ac-1500',
      heatRejection: 'hybrid',
      cduRedundancy: 'N+1',
      crahRedundancy: 'N+1',
      chillerRedundancy: 'N+1',
      economizer: true,
      tcsDeltaTK: 10,
    },
    network: {
      scaleOut: {
        fabric: 'roce-generic-400',
        topology: 'rail-optimized',
        tiers: 'auto',
        oversubscription: 1,
        switchCatalogId: template.scaleOutSwitchCatalogId,
        leafPlacement: 'end-of-row',
        spinePlacement: 'central-end',
      },
      frontend: { enabled: true, fabric: 'ethernet-400', switchCatalogId: NEUTRAL_FABRICS.frontend.switchCatalogId, oversubscription: 2 },
      storage: { enabled: true, fabric: 'ethernet-400', switchCatalogId: NEUTRAL_FABRICS.storage.switchCatalogId, oversubscription: 1 },
      oob: { enabled: true, fabric: 'ethernet-1g', switchCatalogId: NEUTRAL_FABRICS.oob.switchCatalogId, oversubscription: 4 },
      cabling: { maxCopperM: 2.5, allowActiveCopper: true, slackPerEndM: 1.5, routeFactor: 1.25, preferSingleMode: false },
    },
    workloads: [
      {
        id: 'wl-pretrain-405b',
        name: 'LLM Pre-training — 405B dense',
        kind: 'llm-pretrain',
        gpuShare: 0.8,
        model: { name: 'Dense-405B', paramsB: 405, activeParamsB: 405, layers: 126, hiddenSize: 16384, seqLen: 8192 },
        // pp 8: the generic module class carries 141 GB (estimate), so weights + optimizer of a 405B model need TP·PP = 64 to fit;
        // selective recompute: 1F1B keeps pp micro-batches in flight on the first stage, ≈ 76 GB of saved activations without it (workload/training.ts)
        training: { tokensB: 15000, globalBatchTokensM: 16, precision: 'fp8', tp: 8, pp: 8, ep: 1, activationRecompute: true, activationRecomputeMode: 'selective', checkpointEveryMin: 30, checkpointDurationS: 90, mtbfHoursPerGpu: 50000 },
        durationDays: 60,
      },
      {
        id: 'wl-infer-moe',
        name: 'MoE Inference — 671B (37B active)',
        kind: 'llm-inference',
        gpuShare: 0.2,
        model: { name: 'MoE-671B', paramsB: 671, activeParamsB: 37, layers: 61, hiddenSize: 7168, seqLen: 32768, numHeads: 128, kvHeads: 128, moe: { experts: 256, topK: 8, nodeLimit: 4, denseLayers: 3 }, mla: { dLatent: 512, dRope: 64 } },
        inference: {
          requestsPerSec: 300, inputTokens: 2000, outputTokens: 600, ttftSloMs: 1000, tpotSloMs: 40, disaggregated: true, weightPrecision: 'fp8', kvPrecision: 'fp8',
          parallelism: { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared' },
          prefillParallelism: { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared' },
          decodeParallelism: { tp: 8, pp: 1, ep: 8, cp: 1, expertMapping: 'shared' },
        },
        durationDays: 30,
      },
    ],
    schedule: {
      projectStart: '2026-10-05',
      waves: waves.map((w, i) => ({ id: w, name: `Wave ${i + 1}`, podIds: computePods.filter((p) => p.waveId === w).map((p) => p.id) })),
      workDaysPerWeek: 6,
      hoursPerDay: 10,
      crews: { electrical: 4, mechanical: 3, rackAndStack: 2, cabling: 4, commissioning: 2 },
      crewSize: 6,
    },
    pricing: {
      currency: 'USD',
      fxKRWPerUSD: 1380,
      itemOverrides: {},
      cableOverrides: {},
      laborUSDPerHour: 85,
      shellUSDPerM2: 4500,
      contingency: 0.08,
      depreciationYears: { it: 5, facility: 20 },
    },
    notes: [
      {
        id: 'note-design-basis',
        section: 'overview',
        title: '설계 기준',
        body:
          `- 배치 단위(DU)는 표준 템플릿 "${tpl.name}"을 따른다: 2열 × 12랙, 고온 통로 격리, 냉통로 ${corridors.coldAisleM} m · 고온 통로 ${corridors.hotAisleM} m(시설 사전점검 기준의 최소값), DU 피치는 랙 깊이 1068 mm와 통로 폭에서 계산.\n` +
          '- 랙: 고전력 21인치 OU 랙(프레임 구현 하나로 풋프린트·정격 통일: 600 × 1068 mm, 44 OU, 페이로드 1400 kg, IT 선반 세트당 80 kg) + 제네릭 8모듈 DLC 노드 5대(모듈 1000 W 상한, 노드 6 OU·자체 레일). 랙당 ≈53 kW(추정)로 33 kW 셸프 3대 N+1 한도 82.5 kW 이하.\n' +
          `- 냉각: 행 액체-액체 CDU(L-LCDU 정격 기준 5 K), 노드당 블라인드메이트 커넥터 2쌍, PG25, FWS 30 °C / TCS 35 °C. 랙 매니폴드 설계 압력 ${NEUTRAL_REFERENCE_FACILITY.tcsManifoldPsig} psig(행 감압 스테이션 가정, 추정).\n` +
          `- 전력: 415 V 버스웨이, 랙 내 BBU 셸프, 발전기 부하 인수 시간 ${NEUTRAL_REFERENCE_FACILITY.generatorAcceptanceS} s(추정 입력).\n` +
          '- 추정값: 노드 kW·질량·높이, 랙 질량, 행 형상, CDU 크기·가격, 스위치 전력·가격. 모두 편집 가능.\n' +
          `- 고정한 문서: ${pinned.map((id) => standardCitation(id)).join('; ')}.`,
      },
    ],
  };

  // third pass: adopt the cooling engine's CRAH count (switch + optics heat the generator only estimates)
  if (opts.calibrate !== false) {
    const cal = calibrateLayout(project, hallA, layoutOpts, { keepPods: true, rounds: 2, isolate: true, quick: true });
    if (cal.layout.crah.placed !== layout.crah.placed) {
      layout = growHallToFit(hallA, cal.opts);
      project.equipment = layout.equipment;
      project.containments = layout.containments;
      project.trays = layout.trays;
      project.busways = layout.busways;
      if (layout.reservations?.length) project.reservations = layout.reservations;
      const zr = servicesZoneRecordOf(hallA.id, layout);
      if (zr) project.servicesZones = [zr];
      hallA.layoutPolicy = { ...hallA.layoutPolicy!, crahWalls: layout.crah.walls };
    }
  }

  return { project, pods: layout.pods };
}
