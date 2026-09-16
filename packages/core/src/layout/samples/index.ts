import type { Hall, Project } from '../../model/types.ts';
import { calibrateLayout, growHallToFit, servicesZoneRecordOf } from '../fit.ts';
import { CORRIDOR_DEFAULTS, generateHallLayout, type PodInfo } from '../generate.ts';
import type { ReferenceOptions } from '../reference.ts';
import { VENDOR_RACKSCALE_POD, VENDOR_SAMPLE_FABRICS, VENDOR_SAMPLE_FACILITY } from './platforms.ts';

// the four vendor platform lists are re-exported by layout/templates/index.ts (kept there for existing importers)
export { AIR_EIA_NPU_RACKS, AIR_UBB8_RACKS, DLC_UBB8_RACKS, VENDOR_RACKSCALE_POD, VENDOR_SAMPLE_FABRICS, VENDOR_SAMPLE_FACILITY, VENDOR_SAMPLE_SWITCHES, WIDE_RACK_SCALE } from './platforms.ts';

/**
 * Vendor sample projects (stream D / P4; OCP-DESIGN-PROPOSAL §7.2, DECISIONS-v2-2 §I DO-7 and "추가 지시").
 *
 * Vendor products are optional instances: the default for new projects is the vendor-neutral reference
 * (`createReferenceProject()`, layout/reference.ts). The rack-scale GB300 NVL72 hall stays available as the vendor sample
 * named exactly "NVIDIA reference". Its content equals the pre-P4 reference project except the name (golden:
 * test/__golden__/reference-nvidia-sample.json).
 */

export type VendorSampleId = 'nvidia-reference';

export const VENDOR_SAMPLE_IDS: readonly VendorSampleId[] = ['nvidia-reference'];

/** Display names of the vendor samples (the consultant's naming: "NVIDIA reference"). */
export const VENDOR_SAMPLE_NAMES: Record<VendorSampleId, string> = {
  'nvidia-reference': 'NVIDIA reference',
};

export function createVendorSampleProject(sample: VendorSampleId, opts: Omit<ReferenceOptions, 'sample'> = {}): { project: Project; pods: PodInfo[] } {
  switch (sample) {
    case 'nvidia-reference':
      return createNvidiaReferenceProject(opts);
  }
}

/**
 * Vendor sample: a GB300 NVL72 rack-scale AI factory hall built from AIDC Studio's own reference parameters.
 *   Hall A — 4 deployment units (96 × GB300 NVL72, 6,912 GPUs) + services row, HAC ducted to plenum.
 *   Hall B — empty white space reserved for phase 2 (shows 상면/수전 availability).
 */
export function createNvidiaReferenceProject(opts: Omit<ReferenceOptions, 'sample'> = {}): { project: Project; pods: PodInfo[] } {
  const pods = opts.pods ?? 4;
  const now = new Date().toISOString();
  const template = { ...VENDOR_RACKSCALE_POD, gpuRackCatalogId: opts.gpuRackCatalogId ?? VENDOR_RACKSCALE_POD.gpuRackCatalogId, racksPerRow: opts.racksPerRow ?? VENDOR_RACKSCALE_POD.racksPerRow };

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
  };

  const layoutOpts = {
    hall: hallA,
    pods,
    template,
    services: { spineRacks: 'auto' as const, storageRacks: 8, cpuRacks: 4, mgmtRacks: 2 },
    crahCatalogId: VENDOR_SAMPLE_FACILITY.crah,
    crahs: 'auto' as const,
    crahRedundancy: 'N+1',
    marginM: 1.0,
    podsPerWave: 2,
    columns: opts.columns ?? 1,
    spinePlacement: opts.spinePlacement ?? 'central-end',
    templateId: 'rack-scale-liquid-du',
    // the aux-fabric switches the sample stores in `network` (the generator default is now the generic class)
    fabrics: VENDOR_SAMPLE_FABRICS,
  };
  // first passes size the hall (grow until the layout fits — extra CRAH walls change the required size), then place
  let layout = growHallToFit(hallA, layoutOpts);
  hallA.keepouts = [
    { id: 'ko-a-door-w', kind: 'door', rect: { x: 0, y: hallA.depth / 2 - 1.2, w: 0.3, d: 2.4 }, label: 'Equipment door' },
    { id: 'ko-a-egress-e', kind: 'egress', rect: { x: hallA.width - 0.3, y: 1.0, w: 0.3, d: 1.2 }, label: 'Egress' },
  ];
  layout = generateHallLayout(layoutOpts);
  hallA.layoutPolicy = { templateId: 'rack-scale-liquid-du', orientation: 'x', grid: { columns: layout.grid.columns, rows: layout.grid.rows }, corridors: CORRIDOR_DEFAULTS, crahStrategy: 'perimeter', crahWalls: layout.crah.walls, objective: 'max-gpus' };

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

  const computePods = layout.pods.filter((p) => (p.kind ?? 'compute') === 'compute');
  const waves = [...new Set(computePods.map((p) => p.waveId))].sort();

  const project: Project = {
    schemaVersion: 1,
    id: 'ref-gb300-hall',
    name: opts.name ?? VENDOR_SAMPLE_NAMES['nvidia-reference'],
    description:
      'GB300 NVL72 AI factory reference design: 2 × 12-rack liquid-cooled deployment units, 0.6 m rack pitch, hot-aisle containment ducted to the ceiling plenum (AIDC Studio defaults, editable).',
    client: 'Sample Client',
    author: 'AIDC Studio',
    createdAt: now,
    updatedAt: now,
    site: {
      name: 'Sample AI Factory Campus',
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
      upsCatalogId: VENDOR_SAMPLE_FACILITY.ups,
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
      crahCatalogId: VENDOR_SAMPLE_FACILITY.crah,
      chillerCatalogId: 'chiller-ac-1500',
      heatRejection: 'hybrid',
      cduRedundancy: 'N+1',
      crahRedundancy: 'N+1',
      chillerRedundancy: 'N+1',
      economizer: true,
    },
    network: {
      scaleOut: {
        fabric: 'ib-xdr-800',
        topology: 'rail-optimized',
        tiers: 'auto',
        oversubscription: 1,
        switchCatalogId: VENDOR_SAMPLE_FACILITY.scaleOut,
        leafPlacement: 'end-of-row',
        spinePlacement: 'central-end',
      },
      frontend: { enabled: true, fabric: 'ethernet-400', switchCatalogId: VENDOR_SAMPLE_FABRICS.frontend.switchCatalogId, oversubscription: 2 },
      storage: { enabled: true, fabric: 'ethernet-400', switchCatalogId: VENDOR_SAMPLE_FABRICS.storage.switchCatalogId, oversubscription: 1 },
      oob: { enabled: true, fabric: 'ethernet-1g', switchCatalogId: VENDOR_SAMPLE_FABRICS.oob.switchCatalogId, oversubscription: 4 },
      cabling: { maxCopperM: 2.5, allowActiveCopper: true, slackPerEndM: 1.5, routeFactor: 1.25, preferSingleMode: false },
    },
    workloads: [
      {
        id: 'wl-pretrain-405b',
        name: 'LLM Pre-training — 405B dense',
        kind: 'llm-pretrain',
        gpuShare: 0.8,
        model: { name: 'Dense-405B', paramsB: 405, activeParamsB: 405, layers: 126, hiddenSize: 16384, seqLen: 8192 },
        training: {
          tokensB: 15000,
          globalBatchTokensM: 16,
          precision: 'fp8',
          tp: 8,
          pp: 4,
          ep: 1,
          checkpointEveryMin: 30,
          checkpointDurationS: 90,
          mtbfHoursPerGpu: 50000,
        },
        durationDays: 60,
      },
      {
        id: 'wl-infer-moe',
        name: 'MoE Inference — 671B (37B active)',
        kind: 'llm-inference',
        gpuShare: 0.2,
        model: { name: 'MoE-671B', paramsB: 671, activeParamsB: 37, layers: 61, hiddenSize: 7168, seqLen: 32768 },
        inference: { requestsPerSec: 400, inputTokens: 2000, outputTokens: 600, ttftSloMs: 1000, tpotSloMs: 40, disaggregated: true },
        durationDays: 30,
      },
    ],
    schedule: {
      projectStart: '2026-10-05',
      waves: waves.map((w, i) => ({
        id: w,
        name: `Wave ${i + 1}`,
        podIds: computePods.filter((p) => p.waveId === w).map((p) => p.id),
      })),
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
          '- 배치 단위(DU)는 AIDC Studio 기본값을 따른다: 2열 × 12랙(연속 배치), 랙 피치 0.6 m, 열 간격 3.42 m, DU 피치 7.3152 m.\n' +
          '- GB300 NVL72 전력/냉각 사양은 카탈로그 값을 사용한다(출처는 카탈로그 항목 참조): 명판 136 kW, 액체 116 kW / 공기 19.3 kW.\n' +
          '- 가격, 리드타임, 네트워크 스위치 전력은 추정치이며 견적 확정 시 갱신한다.',
      },
    ],
  };

  // third pass: adopt the cooling engine's CRAH count (switch + optics heat the generator only estimates)
  if (opts.calibrate !== false) {
    const cal = calibrateLayout(project, hallA, layoutOpts, { keepPods: true, rounds: 2, isolate: true, quick: true });
    if (cal.layout.crah.placed !== layout.crah.placed) {
      // extra walls / row-end units can need more room: grow the hall (never shrink) and place against the final size
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
