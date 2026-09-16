import { findCatalogItem, getCatalogItem } from '../catalog/catalog.ts';
import { defaultCoolingItem } from './coolingPlacement.ts'; // stream C (P3): neutral fallback, never a vendor id
import { chipComputeTflops, computeCountsOf } from '../catalog/checks.ts';
import { leafPortSplit, sizeFabricFromCounts } from '../engines/radix.ts';
import { analyzeCooling, analyzePower, analyzeProject } from '../engines/index.ts';
import { footprintRect, rectsOverlap, round6 } from '../model/geometry.ts';
import type { EquipmentInstance, Hall, LayoutPolicy, Project, ProjectAnalysis, Rect, ServicesZoneRecord, SpinePlacement } from '../model/types.ts';
import { CORRIDOR_DEFAULTS, REF_POD_TEMPLATE, generateHallLayout, keepoutBlockRect, networkRacksFor, planCentralRacks, podSizing, type FabricOptions, type HallLayout, type HallLayoutOptions, type PodTemplate, type ServicesRow, type Wall } from './generate.ts';
import { servicesZoneMode } from './zones.ts';
import { DEFAULT_TEMPLATE_ID, findLayoutTemplate, fitPlatformsFor, isPlatformRegistered, LAYOUT_TEMPLATES, resolveLayoutTemplate } from './templates/index.ts';

/**
 * Fit-to-space optimizer + relayout hook (stream S1, PROPOSAL-v2 §3.1 / §3.2).
 *
 * `fitToSpace` enumerates template × orientation × pod grid (columns × rows that fit the hall with the corridor
 * widths) × spine placement × CRAH strategy, generates each candidate with `generateHallLayout`, notches racks that
 * collide with keepouts (lost positions), evaluates the candidate with the full engines (`analyzeProject` on a
 * scratch copy — without tray polylines so the evaluation uses the Manhattan cable model, ~ms per candidate) and
 * ranks by the policy objective. Deterministic: same inputs → same candidate order.
 *
 * `relayoutForPlacement` re-places the network-core rows of an existing hall for a spine placement; the network
 * placement comparator (engines/placement.ts, S2) calls it with exactly this signature.
 */

export interface FitCandidate {
  id: string;
  policy: LayoutPolicy;
  spinePlacement: SpinePlacement;
  layout: HallLayout;
  gpus: number;
  itKW: number;
  score: number;
  limitedBy: 'space' | 'power' | 'cooling' | 'none';
  // ── metrics (all from the engines; `estimate`) ──
  pods: number;
  columns: number;
  rows: number;
  racks: number;
  facilityKW: number;
  capexUSD: number;
  /** cabling CAPEX (network.costUSD) */
  cableUSD: number;
  /** total cable length (m) */
  cableM: number;
  /** peak cable count on a main tray → cross-section estimate (mm², 7 mm² per fibre cable, 50 % fill) */
  trayPeakCables: number;
  trayPeakMm2: number;
  /** rack positions removed because they collide with keepouts */
  lostPositions: number;
  /** stream T4 (#3): normalised compute = Σ primary chips × per-chip BF16 peak TFLOP/s (`chipComputeTflops`); accelerator-slot racks excluded */
  computeTflops?: number;
  /** accelerator family of the primary platform (flops family key or vendor/family) */
  computeFamily?: string;
  /** tokens/s of the first workload with a throughput figure, when present */
  tokensPerSec?: number;
  errors: number;
  notes: string[];
  /** rows run along the hall's long side (fit-to-space tie-break, DECISIONS-v2-2 F3a) */
  rowsAlongLongSide: boolean;
  templateId: string;
  /** primary compute platform of the candidate (a registered platform of `templateId`) */
  platformId: string;
  orientation: 'x' | 'y';
  crahStrategy: LayoutPolicy['crahStrategy'];
  crah: HallLayout['crah'];
  /** generator options that produced `layout` (apply with `applyHallLayout`) */
  options: HallLayoutOptions;
}

export interface FitOptions {
  policy: LayoutPolicy;
  /** maximum candidates to return (sorted by score, best first). Default 3. */
  top?: number;
  /** template ids to try (default: `[policy.templateId]`; `'all'` = every registered template) */
  templateIds?: string[] | 'all';
  /** DECISIONS-v2-2 §E5: primary platforms per template — 'selected' (default) = `template.gpuRackCatalogId` when registered for the template, else its default; 'all' = every registered platform. Unregistered platforms are never enumerated. */
  platforms?: 'selected' | 'all';
  /** row orientations to try (default: both) */
  orientations?: ('x' | 'y')[];
  /** spine placements to try (default: from `project.growth` — phased: central-end, separate-room; single-build: central-center, distributed) */
  spinePlacements?: SpinePlacement[];
  /** CRAH strategies to try (default: `[policy.crahStrategy]`) */
  crahStrategies?: LayoutPolicy['crahStrategy'][];
  /** overrides applied on top of the template pod (GPU rack, switch, oversubscription, CDU, …) */
  template?: Partial<PodTemplate>;
  services?: ServicesRow;
  crahCatalogId?: string;
  crahRedundancy?: string;
  marginM?: number;
  podsPerWave?: number;
  /** cap on the pod count (e.g. the number the user wants), default unlimited */
  maxPods?: number;
  /** upper bound on pod columns (default: as many as fit, at most 6) */
  maxColumns?: number;
  fabrics?: FabricOptions;
  onProgress?: (done: number, total: number) => void;
}

/** Spine placements a growth scenario suggests, best-first (DECISIONS-v2 #1). */
export function spinePlacementsForGrowth(growth: Project['growth']): SpinePlacement[] {
  return growth === 'single-build' ? ['central-center', 'distributed', 'central-end', 'separate-room'] : ['central-end', 'separate-room', 'central-center', 'distributed'];
}

/** Default spine placement for a growth scenario (phased → central-end, single-build → central-center). */
export function defaultSpinePlacement(growth: Project['growth']): SpinePlacement {
  return growth === 'single-build' ? 'central-center' : 'central-end';
}

const LEGACY_SPINE: Record<string, SpinePlacement> = { centralized: 'central-end', 'per-hall': 'distributed' };
export function normalizePlacement(p: string | undefined): SpinePlacement {
  if (!p) return 'central-end';
  return (LEGACY_SPINE[p] ?? p) as SpinePlacement;
}

const isComputePod = (podId?: string) => !!podId && !podId.startsWith('pod-services') && !podId.startsWith('pod-network-core');
const podNumber = (podId?: string) => Number(/^pod-(\d+)$/.exec(podId ?? '')?.[1] ?? NaN);

/**
 * First pod number a regenerated `hallId` should use so its `pod-NN` ids never collide with the other halls: the hall's own
 * lowest number when it already holds compute pods (ids stay stable across a relayout), else max over the other halls + 1.
 */
export function nextPodIndex(project: Project, hallId: string, count?: number): number {
  const own = project.equipment.filter((e) => e.hallId === hallId).map((e) => podNumber(e.podId)).filter((n) => Number.isFinite(n));
  const others = new Set(project.equipment.filter((e) => e.hallId !== hallId).map((e) => podNumber(e.podId)).filter((n) => Number.isFinite(n)));
  const after = others.size ? Math.max(...others) + 1 : 1;
  if (!own.length) return after;
  const min = Math.min(...own);
  // fix v2 2차 (QA): own numbering is reusable unless [min, min + count − 1] actually intersects another hall's numbers (was: any
  // higher number elsewhere, so hall A of a two-hall project was renumbered on every regenerate)
  const n = Math.max(1, count ?? new Set(own).size);
  for (let k = min; k < min + n; k++) if (others.has(k)) return after;
  return min;
}

/**
 * First wave number for a regenerated hall (fix v2 2차, QA): the hall's current first wave when it already holds compute pods, else
 * the other halls' last wave + 1 (a new hall is phased after the existing ones), else 1.
 */
export function defaultWaveStart(project: Project, hallId: string): number {
  const waveNo = (w?: string) => Number(/wave-(\d+)/.exec(w ?? '')?.[1] ?? NaN);
  const own = project.equipment.filter((e) => e.hallId === hallId && isComputePod(e.podId)).map((e) => waveNo(e.waveId)).filter((n) => Number.isFinite(n));
  if (own.length) return Math.min(...own);
  const others = project.equipment.filter((e) => e.hallId !== hallId && isComputePod(e.podId)).map((e) => waveNo(e.waveId)).filter((n) => Number.isFinite(n));
  return others.length ? Math.max(...others) + 1 : 1;
}

/**
 * Reconstruct generator options from what is in the hall now (template from `hall.layoutPolicy`, observed GPU rack /
 * racks per row / containment / services counts, project-level cooling & network choices). Used by the relayout
 * hook and by the layout panel so both regenerate the same thing.
 */
export function layoutOptionsFromProject(project: Project, hall: Hall, overrides: Partial<HallLayoutOptions> & { template?: Partial<PodTemplate> } = {}): HallLayoutOptions {
  const base = layoutOptionsBase(project, hall, overrides);
  // the inter-hall core racks of a multi-hall cluster live in the zone hall's services zone (unless the caller overrides the count)
  return overrides.interHallCoreRacks !== undefined ? base : { ...base, interHallCoreRacks: interHallCoreFor(project, hall.id).racks };
}

function layoutOptionsBase(project: Project, hall: Hall, overrides: Partial<HallLayoutOptions> & { template?: Partial<PodTemplate> } = {}): HallLayoutOptions {
  const eq = project.equipment.filter((e) => e.hallId === hall.id);
  const policy = hall.layoutPolicy;
  // finish v2 2차 (QA templates #2): the template being generated is the base — the hall's previous template must not leak its row shape
  // (rowsPerPod / networkPlacement / cduPlacement / endServiceRacks / enclosureRacks) into a different template
  const tplId = overrides.templateId ?? policy?.templateId;
  const tpl = tplId ? resolveLayoutTemplate(tplId) : undefined;
  const base: PodTemplate = tpl ? { ...tpl.pod } : { ...REF_POD_TEMPLATE };
  // §E2: accelerator compute-slot racks (meta.computeSlot) are not the primary platform
  const gpu = eq.find((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack' && typeof e.meta?.computeSlot !== 'string');
  const accEq = eq.filter((e) => isComputePod(e.podId) && typeof e.meta?.computeSlot === 'string' && !!findCatalogItem(e.catalogId));
  const podCount = Math.max(1, new Set(eq.filter((e) => isComputePod(e.podId)).map((e) => e.podId)).size);
  const accSlots = [...new Set(accEq.map((e) => e.meta!.computeSlot as string))];
  const accelerators = accEq.length ? accSlots.map((slotId) => { const list = accEq.filter((e) => e.meta!.computeSlot === slotId); return { slotId, catalogId: list[0].catalogId, racksPerDu: Math.round(list.length / podCount) }; }) : eq.length ? [] : (base.accelerators ?? []);
  const byRow = new Map<string, number>();
  for (const e of eq) {
    if (!e.rowId || !isComputePod(e.podId) || findCatalogItem(e.catalogId)?.category !== 'gpu-rack' || typeof e.meta?.computeSlot === 'string') continue;
    byRow.set(e.rowId, (byRow.get(e.rowId) ?? 0) + 1);
  }
  const racksPerRow = byRow.size ? Math.max(...byRow.values()) : base.racksPerRow;
  const cont = project.containments.find((c) => c.hallId === hall.id);
  const template: PodTemplate = {
    ...base,
    gpuRackCatalogId: gpu?.catalogId ?? base.gpuRackCatalogId,
    racksPerRow,
    containment: cont?.kind ?? (byRow.size ? 'none' : base.containment),
    cduCatalogId: findCatalogItem(project.cooling.cduCatalogId) ? project.cooling.cduCatalogId : base.cduCatalogId,
    cduRedundancy: project.cooling.cduRedundancy,
    scaleOutSwitchCatalogId: findCatalogItem(project.network.scaleOut.switchCatalogId) ? project.network.scaleOut.switchCatalogId : base.scaleOutSwitchCatalogId,
    oversubscription: project.network.scaleOut.oversubscription,
    accelerators,
    ...(overrides.template ?? {}),
  };
  const pods = new Set(eq.filter((e) => isComputePod(e.podId)).map((e) => e.podId)).size;
  const svc = eq.filter((e) => e.podId?.startsWith('pod-services') || e.podId?.startsWith('pod-network-core'));
  const count = (cat: string) => svc.filter((e) => findCatalogItem(e.catalogId)?.category === cat).length;
  const hasCentral = svc.length > 0;
  // fix v2 2차 (QA): pods per wave from the waves holding THIS hall's pods (the largest project-wide wave merged both halls' phases)
  const hallPods = new Set(eq.filter((e) => isComputePod(e.podId)).map((e) => e.podId!));
  const wavePods = project.schedule.waves.map((w) => w.podIds.filter((p) => isComputePod(p) && hallPods.has(p)).length).filter((n) => n > 0);
  const n = project.network;
  const fabrics: FabricOptions = {
    frontend: { enabled: n.frontend.enabled, switchCatalogId: n.frontend.switchCatalogId, oversubscription: n.frontend.oversubscription },
    storage: { enabled: n.storage.enabled, switchCatalogId: n.storage.switchCatalogId, oversubscription: n.storage.oversubscription },
    oob: { enabled: n.oob.enabled, switchCatalogId: n.oob.switchCatalogId },
  };
  const { template: _t, ...rest } = overrides;
  void _t;
  return {
    hall,
    pods: pods || 1,
    podIndexStart: nextPodIndex(project, hall.id),
    template,
    services: hasCentral || !eq.length ? { spineRacks: 'auto', storageRacks: count('storage-rack'), cpuRacks: count('cpu-rack'), mgmtRacks: count('mgmt-rack') } : undefined,
    crahCatalogId: findCatalogItem(project.cooling.crahCatalogId) ? project.cooling.crahCatalogId : (defaultCoolingItem('crah')?.id ?? project.cooling.crahCatalogId),
    crahs: 'auto',
    crahRedundancy: project.cooling.crahRedundancy,
    marginM: 1,
    podsPerWave: wavePods.length ? Math.max(...wavePods) : 2,
    orientation: policy?.orientation ?? 'x',
    columns: policy?.grid?.columns ?? 1,
    spinePlacement: normalizePlacement(n.scaleOut.spinePlacement),
    corridors: policy?.corridors ?? CORRIDOR_DEFAULTS,
    crahWalls: policy?.crahWalls as Wall[] | undefined,
    crahStrategy: policy?.crahStrategy ?? 'perimeter',
    fabrics,
    templateId: policy?.templateId ?? DEFAULT_TEMPLATE_ID,
    servicesZone: servicesZoneMode(project, hall.id),
    joinedCluster: isJoinedHall(project, hall.id),
    ...rest,
  };
}

export interface InterHallCorePlan {
  clusterId?: string;
  /** halls joined by the cluster (in cluster order) */
  hallIds: string[];
  /** top-tier scale-out switches of each joined hall (cores when 3-tier, else spines, else leaves) */
  topSwitchesByHall: Record<string, number>;
  superSpines: number;
  racks: number;
  switchCatalogId: string;
  source: string;
}

const NO_IHC: InterHallCorePlan = { hallIds: [], topSwitchesByHall: {}, superSpines: 0, racks: 0, switchCatalogId: '', source: '' };

/** true when `hallId` is part of an explicit multi-hall cluster that engines/network.ts joins (not DriveNets FSE / DDC). */
export function isJoinedHall(project: Project, hallId: string): boolean {
  if (project.network.scaleOut.fabric === 'drivenets-fse') return false;
  return (project.clusters ?? []).some((c) => c.hallIds.length > 1 && c.hallIds.includes(hallId));
}

/**
 * Inter-hall core racks reserved in `hallId` when a multi-hall cluster names it as its zone hall (ClusterDef.interHallCore.zoneHallId,
 * default: the first hall of the cluster). Sizing = engines/network.ts (T2): each joined hall's scale-out top tier is sized with the
 * joined reserve (the tier doubles at 1:1) and exposes ⌊k/2⌋ uplinks per switch; super-spines = ⌈Σ top · ⌊k/2⌋ ÷ k_ss⌉;
 * racks = RU / power fit of that many super-spine switches. T2 assigns the switches (networkRole 'inter-hall-core').
 */
export function interHallCoreFor(project: Project, hallId: string): InterHallCorePlan {
  if (project.network.scaleOut.fabric === 'drivenets-fse') return NO_IHC;
  const cl = (project.clusters ?? []).find((c) => c.hallIds.length > 1 && (c.interHallCore?.zoneHallId ?? c.hallIds[0]) === hallId);
  if (!cl) return NO_IHC;
  const ssw = findCatalogItem(cl.interHallCore?.spineCatalogId ?? '') ?? findCatalogItem(project.network.scaleOut.switchCatalogId);
  if (!ssw?.switch) return NO_IHC;
  const kss = ssw.switch.ports;
  const top: Record<string, number> = {};
  let trunks = 0;
  let hallsWithTop = 0;
  for (const hid of cl.hallIds) {
    const h = project.halls.find((x) => x.id === hid);
    if (!h || !project.equipment.some((e) => e.hallId === hid && isComputePod(e.podId))) {
      top[hid] = 0;
      continue;
    }
    try {
      const o = layoutOptionsBase(project, h);
      const s = podSizing(o.template, o.fabrics);
      const plan = planCentralRacks(s, o.pods, o.services ?? { spineRacks: 'auto', storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 }, o.fabrics, 0, true);
      const so = plan.detail.scaleOut;
      // T2 joins only halls whose scale-out has a spine tier (tiers ≥ 2); the top tier is the cores when 3-tier
      top[hid] = so.tiers >= 2 ? so.cores || so.spines : 0;
      if (top[hid] > 0) {
        trunks += top[hid] * Math.floor((s.sw.switch?.ports ?? 64) / 2);
        hallsWithTop++;
      }
    } catch {
      top[hid] = 0;
    }
  }
  if (hallsWithTop < 2) return { ...NO_IHC, clusterId: cl.id, hallIds: cl.hallIds, topSwitchesByHall: top };
  const superSpines = Math.ceil(trunks / kss - 1e-9);
  const zoneHall = project.halls.find((h) => h.id === hallId);
  const netRackId = (zoneHall && layoutOptionsBase(project, zoneHall).template.networkRackCatalogId) ?? 'network-rack-48u';
  const netRack = findCatalogItem(netRackId) ?? getCatalogItem('network-rack-48u');
  return {
    clusterId: cl.id,
    hallIds: cl.hallIds,
    topSwitchesByHall: top,
    superSpines,
    racks: networkRacksFor(ssw, superSpines, netRack),
    switchCatalogId: ssw.id,
    source: `derived (= engines/network.ts): ⌈Σ top-tier ${Object.values(top).join(' + ')} × ⌊k/2⌋ ÷ k_ss ${kss}⌉ = ${superSpines} × ${ssw.id} (top tier doubled for the joined reserve)`,
  };
}

/** Services-zone record of a generated layout (stored on project.servicesZones by applyHallLayout). */
export function servicesZoneRecordOf(hallId: string, layout: HallLayout): ServicesZoneRecord | undefined {
  const z = layout.zone;
  if (!z?.rect) return undefined;
  return { hallId, mode: z.mode, rect: z.rect, rows: z.rows, positionsPerRow: z.positionsPerRow, racks: z.racks, reservePositions: z.reservePositions, ...(z.interHallCoreRacks ? { interHallCoreRacks: z.interHallCoreRacks } : {}) };
}

export interface ApplyOptions {
  /** first wave number for the generated pods (default 1) */
  waveStart?: number;
  /** keep the existing wave names / target dates (default true) */
  keepWaves?: boolean;
  /** policy recorded on the hall (default: derived from the options) */
  policy?: LayoutPolicy;
}

/** Policy record for a generated layout. */
export function policyFromLayout(opts: HallLayoutOptions, layout: HallLayout): LayoutPolicy {
  return {
    templateId: opts.templateId ?? DEFAULT_TEMPLATE_ID,
    orientation: opts.orientation ?? 'x',
    grid: { columns: layout.grid.columns, rows: layout.grid.rows },
    corridors: opts.corridors ?? CORRIDOR_DEFAULTS,
    crahStrategy: opts.crahStrategy ?? 'perimeter',
    crahWalls: layout.crah.walls,
    objective: 'max-gpus',
    separateNetworkRoom: (opts.spinePlacement ?? 'central-end') === 'separate-room',
    ...(opts.servicesZone ? { servicesZone: opts.servicesZone } : {}),
  };
}

/**
 * Write a generated layout into a project draft (mutates and returns it): replaces the hall's equipment,
 * containments, trays and busways, de-duplicates ids / tags against other halls, renumbers waves and rebuilds the
 * schedule waves from the pods. Never changes hall dimensions.
 */
export function applyHallLayout(d: Project, hallId: string, layout: HallLayout, opts: HallLayoutOptions, apply: ApplyOptions = {}): Project {
  const hall = d.halls.find((h) => h.id === hallId);
  if (!hall) return d;
  const waveStart = apply.waveStart ?? defaultWaveStart(d, hallId);
  const others = d.equipment.filter((e) => e.hallId !== hallId);
  const taken = new Set(others.map((e) => e.id));
  // tag prefix from the hall id ('hall-b' → 'B'), never from the display name ("Data Hall B (Phase 2)" would give '2')
  const code = (hall.id.replace(/^hall-/i, '').replace(/[^A-Za-z0-9]/g, '') || hall.id).toUpperCase();
  const suffix = hall.id;
  // pod / row / containment / tray / busway ids of the other halls: anything the generator re-used gets a hall suffix
  const podsTaken = new Set(others.map((e) => e.podId).filter(Boolean) as string[]);
  const rowsTaken = new Set(others.map((e) => e.rowId).filter(Boolean) as string[]);
  const contTaken = new Set(d.containments.filter((c) => c.hallId !== hallId).map((c) => c.id));
  const trayTaken = new Set((d.trays ?? []).filter((t) => t.hallId !== hallId).map((t) => t.id));
  const busTaken = new Set((d.busways ?? []).filter((b) => b.hallId !== hallId).map((b) => b.id));
  const podMap = new Map<string, string>();
  const podOf = (podId?: string) => {
    if (!podId) return podId;
    let m = podMap.get(podId);
    if (m === undefined) {
      m = podsTaken.has(podId) ? `${podId}-${suffix}` : podId;
      podMap.set(podId, m);
    }
    return m;
  };
  const rowOf = (rowId: string | undefined, podId: string | undefined) => {
    if (!rowId) return rowId;
    const np = podOf(podId);
    if (podId && np !== podId && rowId.startsWith(`${podId}-`)) return `${np}${rowId.slice(podId.length)}`;
    return rowsTaken.has(rowId) ? `${rowId}-${suffix}` : rowId;
  };
  const reWave = (w?: string) => {
    const n = Number(/wave-(\d+)/.exec(w ?? '')?.[1] ?? 1);
    return `wave-${String(n + waveStart - 1).padStart(2, '0')}`;
  };
  const rowMap = new Map<string, string>();
  const equipment = layout.equipment.map((src) => {
    const e = { ...src };
    if (taken.has(e.id)) {
      e.id = `${e.id}-${suffix}`;
      e.tag = `${code}-${e.tag}`;
    }
    const rowId = rowOf(e.rowId, e.podId);
    if (e.rowId && rowId) rowMap.set(e.rowId, rowId);
    e.podId = podOf(e.podId);
    e.rowId = rowId;
    e.waveId = reWave(e.waveId);
    return e;
  });
  const idMap = new Map(layout.equipment.map((src, i) => [src.id, equipment[i].id]));
  const trayIdOf = (id: string) => {
    // row / drop trays carry the row or equipment id they belong to
    let out = id;
    for (const [from, to] of rowMap) if (from !== to && (out === `tray-${from}` || out.startsWith(`tray-${from}-`) || out === `drop-${from}-main` || out.startsWith(`drop-${from}-main-`))) out = out.replace(from, to);
    for (const [from, to] of idMap) if (from !== to && (out === `drop-${from}` || out.startsWith(`drop-${from}-`))) out = out.replace(from, to);
    return trayTaken.has(out) ? `${out}-${suffix}` : out;
  };
  const busIdOf = (id: string) => {
    let out = id;
    for (const [from, to] of rowMap) if (from !== to && out.includes(`-${from}`)) out = out.replace(`-${from}`, `-${to}`);
    return busTaken.has(out) ? `${out}-${suffix}` : out;
  };
  d.equipment = [...others, ...equipment];
  d.containments = [
    ...d.containments.filter((c) => c.hallId !== hallId),
    ...layout.containments.map((c) => {
      const podId = podOf(c.podId);
      let id = c.podId && podId !== c.podId && c.id.includes(c.podId) ? c.id.replace(c.podId, podId!) : c.id;
      if (contTaken.has(id)) id = `${id}-${suffix}`;
      return { ...c, id, podId };
    }),
  ];
  d.trays = [...(d.trays ?? []).filter((t) => t.hallId !== hallId), ...layout.trays.map((t) => ({ ...t, id: trayIdOf(t.id) }))];
  d.busways = [...(d.busways ?? []).filter((b) => b.hallId !== hallId), ...layout.busways.map((b) => ({ ...b, id: busIdOf(b.id), tapoffs: b.tapoffs.map((t) => ({ ...t, equipmentId: idMap.get(t.equipmentId) ?? t.equipmentId })) }))];
  // reserve positions / partitions and the services-zone record of this hall (ids de-duplicated against the other halls)
  const rsvTaken = new Set((d.reservations ?? []).filter((r) => r.hallId !== hallId).map((r) => r.id));
  const reservations = [
    ...(d.reservations ?? []).filter((r) => r.hallId !== hallId),
    ...(layout.reservations ?? []).map((r) => {
      const rowId = r.rowId ? (rowMap.get(r.rowId) ?? (rowsTaken.has(r.rowId) ? `${r.rowId}-${suffix}` : r.rowId)) : undefined;
      let id = r.rowId && rowId && rowId !== r.rowId ? r.id.replace(r.rowId, rowId) : r.id;
      if (rsvTaken.has(id)) id = `${id}-${suffix}`;
      return { ...r, id, hallId, ...(rowId ? { rowId } : {}), waveId: reWave(r.waveId) };
    }),
  ];
  // finish v2 2차 (D4): a separate-room partition closes against both hall walls (the generator only spans the pod area)
  for (const r of reservations) {
    if (r.hallId !== hallId || r.kind !== 'room-partition') continue;
    if (r.rect.w >= r.rect.d) r.rect = { ...r.rect, x: 0, w: hall.width };
    else r.rect = { ...r.rect, y: 0, d: hall.depth };
  }
  if (reservations.length) d.reservations = reservations;
  else delete d.reservations;
  const zoneRec = servicesZoneRecordOf(hallId, layout);
  const zones = [...(d.servicesZones ?? []).filter((z) => z.hallId !== hallId), ...(zoneRec ? [zoneRec] : [])];
  if (zones.length) d.servicesZones = zones;
  else delete d.servicesZones;
  hall.layoutPolicy = apply.policy ?? policyFromLayout(opts, layout);
  // rebuild waves from pods (keep names / target dates of surviving waves)
  const podWave = new Map<string, string>();
  d.equipment.forEach((e) => {
    if (isComputePod(e.podId) && e.waveId) podWave.set(e.podId!, e.waveId);
  });
  const waveIds = [...new Set([...podWave.values()])].sort();
  d.schedule.waves = waveIds.map((w, i) => {
    const prev = apply.keepWaves === false ? undefined : d.schedule.waves.find((x) => x.id === w);
    return { id: w, name: prev?.name ?? `Wave ${i + 1}`, targetReadyDate: prev?.targetReadyDate, podIds: [...podWave].filter(([, wv]) => wv === w).map(([p]) => p) };
  });
  return d;
}

export interface RelayoutOptions {
  /** also regenerate `project.trays` / `project.busways` for the hall (default false — the network engine's tray-graph
   *  router is O(n²) per link today, so the placement comparator evaluates variants with the Manhattan cable model) */
  trays?: boolean;
  /** grow the hall (never shrink) when the re-placed layout needs more room, e.g. 'separate-room' (default true) */
  growHall?: boolean;
}

/**
 * Re-place the network-core rows of `hallId` for `placement` and return a copy of the project. 'central-end' = beyond
 * the last pod row, 'central-center' = between the middle pod rows, 'distributed' = spine racks appended to each pod
 * row (rowId of that pod, networkRole 'scale-out-spine', podId of the pod), 'separate-room' = strip outside the pod
 * area along the wall nearest the growth origin, offset by 3 m. The hall grows to fit when needed (never shrinks).
 */
export function relayoutForPlacement(project: Project, hallId: string, placement: SpinePlacement, ro: RelayoutOptions = {}): Project {
  const hall = project.halls.find((h) => h.id === hallId);
  if (!hall) return project;
  const copy = structuredClone(project);
  const hallCopy = copy.halls.find((h) => h.id === hallId)!;
  const opts = layoutOptionsFromProject(copy, hallCopy, { spinePlacement: placement });
  const layout = ro.growHall !== false ? growHallToFit(hallCopy, opts) : generateHallLayout(opts);
  applyHallLayout(copy, hallId, layout, opts, { policy: { ...(hallCopy.layoutPolicy ?? policyFromLayout(opts, layout)), separateNetworkRoom: placement === 'separate-room' } });
  if (!ro.trays) {
    copy.trays = (project.trays ?? []).filter((t) => t.hallId !== hallId);
    copy.busways = (project.busways ?? []).filter((b) => b.hallId !== hallId);
    if (!copy.trays.length) delete copy.trays;
    if (!copy.busways.length) delete copy.busways;
  }
  copy.network.scaleOut.spinePlacement = placement;
  copy.network.scaleOut.separateRoom = placement === 'separate-room';
  return copy;
}

const roundUp = (v: number, grid: number) => round6(Math.ceil(v / Math.max(0.05, grid) - 1e-9) * Math.max(0.05, grid));
const fits = (l: HallLayout, hall: Hall) => l.requiredWidth <= hall.width + 1e-6 && l.requiredDepth <= hall.depth + 1e-6;

/**
 * Generate and grow `hall` (mutated; never shrunk, rounded to the tile grid) until the layout fits. A bigger hall
 * changes the perimeter CRAH capacity (fewer extra walls / row-end units → different required size), so this
 * iterates a few times instead of trusting a single probe.
 */
export function growHallToFit(hall: Hall, opts: HallLayoutOptions, maxIter = 4): HallLayout {
  // fix v2 2차 (QA): remember the caller's size — intermediate iterations can add row-end CRAH units or N/S walls while the hall is
  // too small, and those extra metres used to stay (DU 37 hall larger than DU 40). Never shrinks below the caller's size.
  const W0 = hall.width;
  const D0 = hall.depth;
  let layout = generateHallLayout({ ...opts, hall, noCrahLine: true });
  let grew = false;
  for (let i = 0; i < maxIter && !fits(layout, hall); i++) {
    hall.width = Math.max(hall.width, roundUp(layout.requiredWidth, hall.tileSize));
    hall.depth = Math.max(hall.depth, roundUp(layout.requiredDepth, hall.tileSize));
    layout = generateHallLayout({ ...opts, hall, noCrahLine: true });
    grew = true;
  }
  if (grew) trimHallToLayout(hall, opts, W0, D0);
  // final layout line-free as well: trim sized the hall for units at the walls
  return generateHallLayout({ ...opts, hall, noCrahLine: true });
}

/**
 * Shrink a grown hall back to what its final layout needs (never below `W0 × D0`), re-checking that the trimmed hall still fits —
 * a smaller hall can need a different cooling-wall arrangement, so at most a few trim rounds are tried and a trim that no longer
 * fits is undone.
 */
export function trimHallToLayout(hall: Hall, opts: HallLayoutOptions, W0: number, D0: number): void {
  // the requirement at the grown size is not the requirement at a smaller size (a narrower hall can bring row-end CRAH units back),
  // so search the smallest tile-rounded size that still fits: width first at the current depth, then depth at that width
  const tile = hall.tileSize > 0 ? hall.tileSize : 0.6;
  const fitsAt = (w: number, d: number) => {
    const prev = { width: hall.width, depth: hall.depth };
    hall.width = w;
    hall.depth = d;
    const ok = fits(generateHallLayout({ ...opts, hall, noCrahLine: true }), hall);
    hall.width = prev.width;
    hall.depth = prev.depth;
    return ok;
  };
  const cur = generateHallLayout({ ...opts, hall, noCrahLine: true });
  const search = (lo: number, hi: number, at: (v: number) => boolean) => {
    // smallest v in {lo, lo + tile, …, hi} with at(v) true (hi is known to fit); binary search over tile steps, assumes monotone fit
    let a = 0;
    let b = Math.max(0, Math.round((hi - lo) / tile));
    while (a < b) {
      const m = Math.floor((a + b) / 2);
      if (at(lo + m * tile)) b = m;
      else a = m + 1;
    }
    return Math.min(hi, lo + a * tile);
  };
  // a narrower hall can push cooling onto N/S walls (deeper) and vice versa: trim in both axis orders and keep the smaller area
  const W1 = hall.width;
  const D1 = hall.depth;
  const trim = (widthFirst: boolean) => {
    let w = W1;
    let d = D1;
    for (const axis of widthFirst ? (['w', 'd'] as const) : (['d', 'w'] as const)) {
      hall.width = w;
      hall.depth = d;
      const at = generateHallLayout({ ...opts, hall, noCrahLine: true });
      if (axis === 'w') {
        const lo = Math.max(W0, roundUp(at.requiredWidth, tile));
        if (lo < w - 1e-6) w = round6(search(lo, w, (v) => fitsAt(v, d)));
      } else {
        const lo = Math.max(D0, roundUp(at.requiredDepth, tile));
        if (lo < d - 1e-6) d = round6(search(lo, d, (v) => fitsAt(w, v)));
      }
    }
    hall.width = W1;
    hall.depth = D1;
    return { w, d };
  };
  void cur;
  const a = trim(true);
  const b = trim(false);
  const best = b.w * b.d < a.w * a.d - 1e-6 ? b : a;
  hall.width = best.w;
  hall.depth = best.d;
}

/**
 * Generate, then let the engines correct the generator's estimates: the CRAH count comes from the cooling engine
 * (`crahsRequired`) and the pod count is reduced until the hall's IT / liquid / air budgets hold. At most `rounds`
 * analyses. Returns the final layout, its analysis and what limited the pod count.
 */
export function calibrateLayout(project: Project, hall: Hall, opts: HallLayoutOptions, cal: { maxPods?: number; rounds?: number; isolate?: boolean; /** never reduce the pod count (only adopt the engine's CRAH count) */ keepPods?: boolean; /** run only the cooling (+ power) engines instead of the full analysis (no `analysis` in the result) */ quick?: boolean } = {}): { layout: HallLayout; analysis: ProjectAnalysis | null; pods: number; limitedBy: FitCandidate['limitedBy']; opts: HallLayoutOptions } {
  let pods = Math.max(0, Math.min(opts.pods, cal.maxPods ?? Infinity));
  let cur: HallLayoutOptions = { ...opts, pods };
  let layout = generateHallLayout(cur);
  let analysis: ProjectAnalysis | null = null;
  let limitedBy: FitCandidate['limitedBy'] = 'none';
  const rounds = cal.rounds ?? 3;
  for (let i = 0; i < rounds; i++) {
    const lite = cal.quick ? evaluateQuick(project, hall, layout, cur, cal.isolate !== false, !cal.keepPods) : null;
    if (!cal.quick) analysis = evaluate(project, hall, layout, cur, cal.isolate !== false);
    const ph = cal.quick ? lite?.power?.find((h) => h.hallId === hall.id) : analysis?.power.perHall.find((h) => h.hallId === hall.id);
    const ch = cal.quick ? lite?.cooling?.find((h) => h.hallId === hall.id) : analysis?.cooling.perHall?.find((h) => h.hallId === hall.id);
    if (!ph && !ch) break;
    let next = pods;
    let why: FitCandidate['limitedBy'] = limitedBy;
    if (ph && hall.itPowerBudgetKW > 0 && ph.itKW > hall.itPowerBudgetKW && pods > 0) {
      next = Math.min(next, Math.max(0, Math.floor((pods * hall.itPowerBudgetKW) / ph.itKW)));
      why = 'power';
    }
    if (ch && pods > 0) {
      if (hall.liquidCoolingBudgetKW > 0 && ch.liquidKW > hall.liquidCoolingBudgetKW) {
        const n = Math.max(0, Math.floor((pods * hall.liquidCoolingBudgetKW) / ch.liquidKW));
        if (n < next) why = 'cooling';
        next = Math.min(next, n);
      }
      if (hall.airCoolingBudgetKW > 0 && ch.airKW > hall.airCoolingBudgetKW) {
        const n = Math.max(0, Math.floor((pods * hall.airCoolingBudgetKW) / ch.airKW));
        if (n < next) why = 'cooling';
        next = Math.min(next, n);
      }
    }
    const crahs = ch && ch.airKW > 0 ? ch.crahsRequired : undefined;
    const crahChange = crahs !== undefined && cur.crahs !== crahs && crahs > layout.crah.placed;
    if ((next === pods || cal.keepPods) && !crahChange) break;
    if (next < pods && !cal.keepPods) {
      pods = next;
      limitedBy = why;
    } else if (next < pods) limitedBy = why;
    cur = { ...cur, pods, ...(crahs !== undefined && crahs > layout.crah.required ? { crahs } : {}) };
    layout = generateHallLayout(cur);
  }
  return { layout, analysis, pods, limitedBy, opts: cur };
}

function scratchProject(project: Project, hall: Hall, layout: HallLayout, opts: HallLayoutOptions, isolate: boolean): Project {
  const others = isolate ? [] : project.equipment.filter((e) => e.hallId !== hall.id);
  return {
    ...project,
    halls: isolate ? [hall] : project.halls,
    equipment: [...others, ...layout.equipment],
    containments: [...(isolate ? [] : project.containments.filter((c) => c.hallId !== hall.id)), ...layout.containments],
    trays: undefined,
    busways: undefined,
    network: { ...project.network, scaleOut: { ...project.network.scaleOut, spinePlacement: opts.spinePlacement ?? normalizePlacement(project.network.scaleOut.spinePlacement), separateRoom: opts.spinePlacement === 'separate-room', switchCatalogId: opts.template.scaleOutSwitchCatalogId, oversubscription: opts.template.oversubscription } },
    cooling: { ...project.cooling, cduCatalogId: opts.template.cduCatalogId, crahCatalogId: opts.crahCatalogId },
    schedule: { ...project.schedule, waves: [] },
  };
}

/** Cooling (+ power) engines only — enough to adopt the engine's CRAH count and check the hall budgets. */
function evaluateQuick(project: Project, hall: Hall, layout: HallLayout, opts: HallLayoutOptions, isolate: boolean, withPower: boolean): { cooling?: NonNullable<ProjectAnalysis['cooling']['perHall']>; power?: ProjectAnalysis['power']['perHall'] } | null {
  const scratch = scratchProject(project, hall, layout, opts, isolate);
  try {
    return { cooling: analyzeCooling(scratch).perHall, power: withPower ? analyzePower(scratch).perHall : undefined };
  } catch {
    return null;
  }
}

/** Analyse a layout on a scratch project (this hall only when `isolate`; never with tray polylines). */
function evaluate(project: Project, hall: Hall, layout: HallLayout, opts: HallLayoutOptions, isolate: boolean): ProjectAnalysis | null {
  try {
    return analyzeProject(scratchProject(project, hall, layout, opts, isolate));
  } catch {
    return null;
  }
}

// ───────────────────────────── fit-to-space ─────────────────────────────

/** Keepout rectangles that block rack positions (doors / egress / ramps grown by the egress clearance). */
function rackBlockers(hall: Hall, egressM: number): Rect[] {
  return hall.keepouts.map((k) => {
    const g = k.kind === 'column' || k.kind === 'shaft' ? 0.05 : k.kind === 'other' ? 0 : egressM;
    return { x: k.rect.x - g, y: k.rect.y - g, w: k.rect.w + 2 * g, d: k.rect.d + 2 * g };
  });
}

/** Remove equipment whose footprint collides with a keepout ("notched" positions). Returns the number removed. Exported so the
 *  grow-hall path (LayoutPanel) notches the same way fit-to-space does. */
export function notchKeepouts(layout: HallLayout, hall: Hall, egressM: number): number {
  const blockers = rackBlockers(hall, egressM);
  if (!blockers.length) return 0;
  // wall units (CRAH / fan wall / gallery CDU) were placed clear of the keepouts by WALL_UNIT_KEEPOUT_CLEARANCE_M: test them with that
  // rectangle so a notch never removes a correctly placed unit (T1 QA: CRAHs beside the equipment door disappeared → layout-crah-count)
  const wallBlockers = hall.keepouts.map((k) => keepoutBlockRect(k));
  const removed = new Set<string>();
  layout.equipment = layout.equipment.filter((e) => {
    const item = findCatalogItem(e.catalogId);
    if (!item) return true;
    const r = footprintRect(item.dims, e.position, e.rotationDeg);
    const wallUnit = !e.rowId && (item.category === 'crah' || item.category === 'fan-wall' || item.category === 'cdu');
    const hit = (wallUnit ? wallBlockers : blockers).some((b) => rectsOverlap(r, b));
    if (hit) removed.add(e.id);
    return !hit;
  });
  if (removed.size) {
    for (const row of layout.rows) row.memberIds = row.memberIds.filter((id) => !removed.has(id));
    layout.busways = layout.busways.map((b) => ({ ...b, tapoffs: b.tapoffs.filter((t) => !removed.has(t.equipmentId)) }));
    layout.trays = layout.trays.filter((t) => !(t.kind === 'drop' && [...removed].some((id) => t.id === `drop-${id}`)));
  }
  return removed.size;
}

/** Largest pod count (whole rows of `columns` pods) whose generated layout fits the hall. */
function maxPodsFor(opts: HallLayoutOptions, hall: Hall, columns: number, cap: number): number {
  const maxRows = Math.max(1, Math.ceil(cap / columns));
  const ok = (rows: number) => fits(generateHallLayout({ ...opts, pods: Math.min(cap, rows * columns), columns, probe: true }), hall);
  if (!ok(1)) return 0;
  // exponential search for a failing row count, then binary search between the last fit and the first failure
  let lo = 1;
  let hi = 2;
  while (hi <= maxRows && ok(hi)) {
    lo = hi;
    hi *= 2;
  }
  if (lo >= maxRows) return Math.min(cap, maxRows * columns);
  hi = Math.min(hi, maxRows + 1);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return Math.min(cap, lo * columns);
}

function scoreOf(objective: LayoutPolicy['objective'], c: Pick<FitCandidate, 'gpus' | 'cableUSD' | 'facilityKW' | 'tokensPerSec' | 'errors'>): number {
  const penalty = c.errors > 0 ? 0.5 : 1;
  if (c.gpus <= 0) return 0;
  switch (objective) {
    case 'min-cable':
      return penalty * (1e6 / Math.max(1, c.cableUSD / c.gpus));
    case 'tokens-per-mw':
      return penalty * ((c.tokensPerSec ?? c.gpus) / Math.max(0.001, c.facilityKW / 1000));
    default:
      return penalty * (c.gpus - Math.min(0.49, c.cableUSD / 1e9));
  }
}

export function fitToSpace(project: Project, hall: Hall, opts: FitOptions): FitCandidate[] {
  const policy = opts.policy;
  const templateIds = opts.templateIds === 'all' ? LAYOUT_TEMPLATES.map((t) => t.id) : (opts.templateIds ?? [policy.templateId]);
  const orientations = opts.orientations ?? ['x', 'y'];
  const spines = opts.spinePlacements ?? spinePlacementsForGrowth(project.growth).slice(0, 2);
  const strategies = opts.crahStrategies ?? [policy.crahStrategy];
  const corridors = policy.corridors ?? CORRIDOR_DEFAULTS;
  const base = layoutOptionsFromProject(project, hall);
  const ctx = { project };
  const combos: { templateId: string; platform: string; orientation: 'x' | 'y'; spine: SpinePlacement; strategy: LayoutPolicy['crahStrategy'] }[] = [];
  // template × registered platform (§E5) × orientation × spine placement × CRAH strategy
  for (const templateId of templateIds) for (const platform of fitPlatformsFor(templateId, opts.platforms ?? 'selected', opts.template?.gpuRackCatalogId, ctx)) for (const orientation of orientations) for (const spine of spines) for (const strategy of strategies) combos.push({ templateId, platform, orientation, spine, strategy });
  const total = combos.length;
  let done = 0;
  const out: FitCandidate[] = [];
  for (const combo of combos) {
    const tpl = resolveLayoutTemplate(combo.templateId, ctx) ?? findLayoutTemplate(DEFAULT_TEMPLATE_ID)!;
    const template: PodTemplate = {
      ...tpl.pod,
      cduCatalogId: base.template.cduCatalogId,
      cduRedundancy: base.template.cduRedundancy,
      scaleOutSwitchCatalogId: base.template.scaleOutSwitchCatalogId,
      oversubscription: base.template.oversubscription,
      ...(opts.template ?? {}),
      gpuRackCatalogId: combo.platform,
      // the form's accelerator slots belong to the policy template; other templates use their own defaults (registered only)
      accelerators: (combo.templateId === policy.templateId && opts.template?.accelerators ? opts.template.accelerators : (tpl.pod.accelerators ?? [])).filter((a) => isPlatformRegistered(tpl.id, a.slotId, a.catalogId, ctx)),
    };
    const gen: HallLayoutOptions = {
      ...base,
      template,
      services: opts.services ?? base.services,
      crahCatalogId: opts.crahCatalogId ?? base.crahCatalogId,
      crahRedundancy: opts.crahRedundancy ?? base.crahRedundancy,
      marginM: opts.marginM ?? base.marginM,
      podsPerWave: opts.podsPerWave ?? base.podsPerWave,
      orientation: combo.orientation,
      spinePlacement: combo.spine,
      corridors,
      crahStrategy: combo.strategy,
      crahWalls: policy.crahWalls as Wall[] | undefined,
      fabrics: opts.fabrics ?? base.fabrics,
      templateId: tpl.id,
    };
    let sizing: ReturnType<typeof podSizing>;
    try {
      sizing = podSizing(template, gen.fabrics);
    } catch {
      done++;
      continue;
    }
    void sizing;
    const capUser = opts.maxPods ?? Infinity;
    const maxCols = Math.max(1, Math.min(opts.maxColumns ?? 6, 6));
    for (let columns = 1; columns <= maxCols; columns++) {
      const probe = generateHallLayout({ ...gen, pods: columns, columns, probe: true });
      if (!fits(probe, hall)) break;
      const spacePods = maxPodsFor(gen, hall, columns, Number.isFinite(capUser) ? Math.max(capUser, columns) : 400);
      const wanted = Math.max(0, Math.min(spacePods, capUser));
      if (wanted <= 0) continue;
      const cal = calibrateLayout(project, hall, { ...gen, pods: wanted, columns }, { rounds: 3, isolate: true });
      const pods = cal.pods;
      if (pods <= 0) continue;
      const limitedBy: FitCandidate['limitedBy'] = cal.limitedBy !== 'none' ? cal.limitedBy : pods >= spacePods ? 'space' : 'none';
      const layout = cal.layout;
      const lost = notchKeepouts(layout, hall, corridors.egressM);
      const a = lost > 0 ? evaluate(project, hall, layout, cal.opts, true) : cal.analysis;
      const gpus = a?.summary.gpus ?? 0;
      const errors = (a?.issues ?? []).filter((i) => i.severity === 'error' && (i.domain === 'space' || i.domain === 'layout' || i.domain === 'network' || i.domain === 'power' || i.domain === 'cooling')).length + layout.issues.filter((i) => i.severity === 'error').length;
      const mains = layout.trays.filter((t) => t.kind === 'main');
      const trayPeakCables = mains.length ? Math.max(...mains.map((t) => t.cableCount ?? 0)) : 0;
      const wl = (a?.workloads ?? []).find((w) => (w.tokensPerSec ?? 0) > 0);
      const cableM = (a?.network.cablesByType ?? []).reduce((s, c) => s + c.totalLengthM, 0);
      const cand: FitCandidate = {
        id: `${tpl.id}|${combo.orientation}|${columns}x${layout.grid.rows}|${combo.spine}|${combo.strategy}|${combo.platform}`,
        policy: { templateId: tpl.id, orientation: combo.orientation, grid: { columns, rows: layout.grid.rows }, corridors, crahStrategy: combo.strategy, crahWalls: layout.crah.walls, objective: policy.objective, separateNetworkRoom: combo.spine === 'separate-room' },
        spinePlacement: combo.spine,
        layout,
        gpus,
        itKW: round6((a?.summary.itMW ?? 0) * 1000),
        score: 0,
        limitedBy,
        pods,
        columns,
        rows: layout.grid.rows,
        racks: a?.summary.racks ?? layout.equipment.length,
        facilityKW: round6((a?.summary.facilityMW ?? 0) * 1000),
        capexUSD: a?.summary.capexUSD ?? 0,
        cableUSD: a?.network.costUSD ?? 0,
        cableM: round6(cableM),
        trayPeakCables,
        trayPeakMm2: round6((trayPeakCables * 7) / 0.5),
        lostPositions: lost,
        tokensPerSec: wl?.tokensPerSec,
        ...candidateCompute(layout.equipment),
        errors,
        notes: [...layout.issues.map((i) => i.message), ...(lost ? [`keepout과 겹치는 랙 자리 ${lost}개를 제외했습니다.`] : [])],
        rowsAlongLongSide: combo.orientation === 'x' ? hall.width >= hall.depth : hall.depth >= hall.width,
        templateId: tpl.id,
        platformId: combo.platform,
        orientation: combo.orientation,
        crahStrategy: combo.strategy,
        crah: layout.crah,
        options: cal.opts,
      };
      cand.score = round6(scoreOf(policy.objective, cand));
      out.push(cand);
    }
    done++;
    opts.onProgress?.(done, total);
  }
  out.sort(fitCandidateOrder(policy.objective, out));
  return out.slice(0, opts.top ?? 3);
}

/**
 * Candidate order (deterministic): objective bucket first — max-gpus: GPUs (candidates with errors after every clean one);
 * min-cable / tokens-per-mw: score in 1 % buckets of the best score — then, on ties, rows along the hall's long side
 * (DECISIONS-v2-2 F3a / §C), fewer columns (fewer cross aisles), then score, GPUs, cabling $ and id.
 */
/** stream T4 (#3): normalised compute of a candidate's primary compute racks (accelerator-slot racks are not counted). */
export function candidateCompute(equipment: readonly Pick<EquipmentInstance, 'catalogId' | 'meta'>[]): { computeTflops: number; computeFamily: string } {
  let tflops = 0;
  const fams = new Map<string, number>();
  for (const e of equipment) {
    const item = findCatalogItem(e.catalogId);
    const c = computeCountsOf(e, item);
    if (!c.gpus) continue;
    const chip = chipComputeTflops(item);
    tflops += c.gpus * chip.tflops;
    fams.set(chip.family, (fams.get(chip.family) ?? 0) + c.gpus);
  }
  const family = [...fams.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'none';
  return { computeTflops: round6(tflops), computeFamily: family };
}

/** true when fit candidates carry more than one accelerator family (max-gpus then ranks by normalised compute). */
export function mixedComputeFamilies(all: readonly Pick<FitCandidate, 'computeFamily'>[]): boolean {
  return new Set(all.map((c) => c.computeFamily ?? 'none')).size > 1;
}

export function fitCandidateOrder(objective: LayoutPolicy['objective'], all: readonly FitCandidate[]): (p: FitCandidate, q: FitCandidate) => number {
  const best = Math.max(1e-9, ...all.map((c) => c.score));
  // stream T4 (#3): chip counts of different accelerator families are not comparable — mixed families rank by normalised compute (TFLOP/s)
  const mixed = objective === 'max-gpus' && mixedComputeFamilies(all);
  const errPenalty = mixed ? -1e18 : -1e12;
  const bucket = (c: FitCandidate) => (objective === 'max-gpus' ? (c.errors > 0 ? errPenalty : 0) + (mixed ? c.computeTflops ?? 0 : c.gpus) : Math.round(c.score / (best * 0.01)));
  return (p, q) => bucket(q) - bucket(p) || Number(q.rowsAlongLongSide) - Number(p.rowsAlongLongSide) || p.columns - q.columns || q.score - p.score || q.gpus - p.gpus || p.cableUSD - q.cableUSD || p.id.localeCompare(q.id);
}

