// Auto-sized hall generation (autosize v2 2차, DECISIONS-v2-2 §F "새 홀 생성 직후 모든 템플릿·플랫폼에서 부족 경고 0건").
//
// One entry point shared by the Layout panel ("Generate") and the QA sweep: `autoSizeHall(project, hallId, request)`.
//   1. options — template + compute slots + services + grid chooser (same as the panel preview, `autoSizeLayoutOptions`);
//      the project-wide scale-out switch is kept when another hall already holds compute racks (the fabric switch is one project
//      setting: switching it for a new hall used to strand the other halls' spines — `network-unplaced … · Data Hall A`);
//   2. geometry — grow the hall to fit, or explicitly right-size it in both directions; wall-anchored doors / egress zones follow
//      the resized envelope. Adopt the cooling engine's CRAH count (calibrateLayout), trim, then notch keepouts;
//   3. engine verification — analyze the written project with the full engines and correct what the validators would flag for this hall:
//      CRAH count (crahsRequired), CDUs per pod (cdusRequired), pod leaf racks for unplaced pod switches; regenerate, at most 3 rounds;
//   4. budgets — 'fit' (default with auto-size): hall IT (≤ 90 % utilisation) / liquid / air budgets and the utility feeds are raised to
//      what the design needs (never lowered; reported); 'hold': budgets stay binding and validate.ts raises ONE `layout-budget-limited-*`
//      issue with the exact shortfall (plus its one-click remedy).
import { findCatalogItem, getCatalogItem } from '../catalog/catalog.ts';
import { analyzeProject } from '../engines/index.ts';
import type { Issue, LayoutPolicy, Project, ProjectAnalysis, ServicesZoneMode } from '../model/types.ts';
import { applyHallLayout, calibrateLayout, growHallToFit, layoutOptionsFromProject, nextPodIndex, normalizePlacement, notchKeepouts, trimHallToLayout } from './fit.ts';
import { CORRIDOR_DEFAULTS, generateHallLayout, hallShortfall, podSizing, type HallLayout, type HallLayoutOptions, type PodTemplate, type ServicesRow, type Wall } from './generate.ts';
import { chooseLayoutGrid, rowEndWalls, type GridChoice } from './grid.ts';
import { switchesPerNetworkRack } from './estimates.ts';
import { defaultServicesZone } from './zones.ts';
import { applyHallShift, hallBudgetTargets, issueHallId, roomConflictShift, SIZING_ISSUE_RE, utilityTargets } from './remedies.ts';

export interface AutoSizeRequest {
  templateId: string;
  template: PodTemplate;
  pods: number;
  services?: ServicesRow;
  crahCatalogId: string;
  marginM: number;
  podsPerWave: number;
  waveStart?: number;
  /** grow the hall to fit (never shrink); false = fixed hall (a layout that does not fit is refused with the shortfall) */
  autoSize: boolean;
  /** with autoSize, allow the hall envelope to shrink to the smallest tile-rounded size that fits the generated layout */
  rightSize?: boolean;
  crahStrategy: LayoutPolicy['crahStrategy'];
  servicesZone: ServicesZoneMode | 'auto';
  /** auto = orientation + pod columns from chooseLayoutGrid (orientation / columns are the fallback) */
  grid: { auto: boolean; orientation: 'x' | 'y'; columns: number };
  /** 'auto' = the row-end walls of the chosen orientation */
  crahWalls: Wall[] | 'auto';
  /** 'fit' = raise hall / utility budgets to the design (default with autoSize); 'hold' = budgets are binding */
  budgets?: 'fit' | 'hold';
}

export interface BudgetLine {
  before: number;
  after: number;
  /** what the engine computed for the generated design */
  requiredKW: number;
}

export interface AutoSizeReport {
  pods: number;
  hall: { width: number; depth: number; beforeWidth: number; beforeDepth: number; mode: 'fixed' | 'grow' | 'right-size' };
  lost: number;
  cdus: { required: number; placed: number };
  crahs: { required: number; placed: number };
  networkRacks: number;
  /** engine verification rounds that changed the layout, and what they corrected ('crah' | 'cdu' | 'network' | 'reach' = another pod grid kept every cable run in reach) */
  corrections: string[];
  budgets: { mode: 'fit' | 'hold'; it: BudgetLine; liquid: BudgetLine; air: BudgetLine; utility?: { beforeMVA: number; afterMVA: number; requiredMVA: number } };
  /** the request asked for another scale-out switch, but other halls use the project's fabric switch */
  switchKept?: { requested: string; kept: string; halls: string[] };
  /** error / warning issues of this hall (and project-level sizing issues) right after generation */
  remaining: Issue[];
}

export type AutoSizeResult =
  | { ok: true; lost: number; report: AutoSizeReport; issues: Issue[]; analysis: ProjectAnalysis }
  | { ok: false; shortfall: { width: number; depth: number }; required: { width: number; depth: number } };

/** Scale-out switch a hall must be generated with: the project's when another hall already holds compute racks. */
export function fabricSwitchFor(project: Project, hallId: string, requested: string): { switchCatalogId: string; kept: boolean; halls: string[] } {
  const current = project.network.scaleOut.switchCatalogId;
  const halls = [...new Set(project.equipment.filter((e) => e.hallId !== hallId && findCatalogItem(e.catalogId)?.category === 'gpu-rack').map((e) => e.hallId))];
  const kept = halls.length > 0 && !!findCatalogItem(current) && requested !== current;
  return { switchCatalogId: kept ? current : requested, kept, halls };
}

const zoneOf = (project: Project, req: AutoSizeRequest): ServicesZoneMode => (req.servicesZone === 'auto' ? defaultServicesZone(project.growth) : req.servicesZone);

/** Options without the grid (template, services, cooling, zone) — the grid chooser probes these. */
export function autoSizeBaseOptions(project: Project, hall: Project['halls'][number], req: AutoSizeRequest): HallLayoutOptions {
  const sw = fabricSwitchFor(project, hall.id, req.template.scaleOutSwitchCatalogId);
  return layoutOptionsFromProject(project, hall, {
    template: { ...req.template, scaleOutSwitchCatalogId: sw.switchCatalogId },
    pods: req.pods,
    podIndexStart: nextPodIndex(project, hall.id),
    services: req.services,
    crahCatalogId: req.crahCatalogId,
    crahRedundancy: project.cooling.crahRedundancy,
    marginM: req.marginM,
    podsPerWave: req.podsPerWave,
    crahStrategy: req.crahStrategy,
    spinePlacement: normalizePlacement(project.network.scaleOut.spinePlacement),
    templateId: req.templateId,
    servicesZone: zoneOf(project, req),
  });
}

/**
 * backlog T1a (qa-autosize v2 2차 §6.3): the cooling engine's CRAH count for the hall, as calibrateLayout will adopt it after generation.
 * One isolated calibration of a single-column probe — the air heat does not depend on the grid — so every grid probe places the same count
 * the generated hall ends with. Undefined when the generator's own count already covers it (or the probe fails).
 */
function calibratedCrahCount(project: Project, hall: Project['halls'][number], base: HallLayoutOptions): { crahCount?: number } {
  const strategy = base.crahStrategy ?? 'perimeter';
  if (base.crahs !== 'auto' || (strategy !== 'perimeter' && strategy !== 'gallery-fan-wall')) return {};
  // stream D (P4, backlog #12): the calibration is a full isolated generate + analyse pass (~0.5–1.5 s). The Auto-size preview, Apply and
  // the remedy probes ask again with identical inputs, so the result is cached by the inputs the isolated calibration reads (options incl.
  // the hall, the project's cooling / power / network / site / standards settings and catalog extensions). Any edit changes the key.
  const key = calibrationKey(project, base);
  const hit = CALIBRATION_CACHE.get(key);
  if (hit) {
    CALIBRATION_CACHE.delete(key);
    CALIBRATION_CACHE.set(key, hit);
    return { ...hit };
  }
  let out: { crahCount?: number };
  try {
    const cal = calibrateLayout(project, hall, { ...base, orientation: 'x', columns: 1, probe: true }, { keepPods: true, rounds: 1, isolate: true, quick: true });
    out = typeof cal.opts.crahs === 'number' && cal.opts.crahs > 0 ? { crahCount: cal.opts.crahs } : {};
  } catch {
    out = {};
  }
  CALIBRATION_CACHE.set(key, out);
  while (CALIBRATION_CACHE.size > CALIBRATION_CACHE_MAX) CALIBRATION_CACHE.delete(CALIBRATION_CACHE.keys().next().value!);
  return { ...out };
}

const CALIBRATION_CACHE_MAX = 32;
const CALIBRATION_CACHE = new Map<string, { crahCount?: number }>();

/** Cache key of an isolated CRAH calibration: every project field the isolated analysis reads, plus the generator options. */
function calibrationKey(project: Project, base: HallLayoutOptions): string {
  const { site, power, cooling, network, standards, catalogExtensions, pricing, workloads } = project;
  return JSON.stringify([base, site, power, cooling, network, standards ?? null, catalogExtensions ?? null, pricing, workloads]);
}

/** Test hook: size of the calibration cache (and clear it). */
export function calibrationCacheSize(clear = false): number {
  const n = CALIBRATION_CACHE.size;
  if (clear) CALIBRATION_CACHE.clear();
  return n;
}

export function autoSizeGridChoice(project: Project, hall: Project['halls'][number], req: AutoSizeRequest): GridChoice | null {
  if (!req.grid.auto) return null;
  try {
    const base = autoSizeBaseOptions(project, hall, req);
    return chooseLayoutGrid(base, { mode: req.autoSize ? 'auto-size' : 'fixed', ...calibratedCrahCount(project, hall, base) });
  } catch {
    return null;
  }
}

export function autoSizeLayoutOptions(project: Project, hall: Project['halls'][number], req: AutoSizeRequest, choice: Pick<GridChoice, 'orientation' | 'columns'> | null = autoSizeGridChoice(project, hall, req)): HallLayoutOptions {
  const orientation = choice?.orientation ?? req.grid.orientation;
  return { ...autoSizeBaseOptions(project, hall, req), orientation, columns: choice?.columns ?? req.grid.columns, crahWalls: req.crahWalls === 'auto' ? rowEndWalls(orientation) : req.crahWalls };
}

const catOf = (id: string) => findCatalogItem(id)?.category;
const fits = (l: HallLayout, hall: { width: number; depth: number }) => l.requiredWidth <= hall.width + 1e-6 && l.requiredDepth <= hall.depth + 1e-6;

interface KeepoutAnchor {
  keepout: Project['halls'][number]['keepouts'][number];
  east: boolean;
  north: boolean;
}

/** Capture simple wall anchors before resizing. Interior columns stay absolute; E/N doors and egress zones follow their wall. */
function keepoutAnchors(hall: Project['halls'][number]): KeepoutAnchor[] {
  const eps = Math.max(0.35, (hall.tileSize || 0.6) / 2 + 1e-6);
  return hall.keepouts.map((k) => ({
    keepout: structuredClone(k),
    east: Math.abs(k.rect.x + k.rect.w - hall.width) <= eps && Math.abs(k.rect.x) > eps,
    north: Math.abs(k.rect.y + k.rect.d - hall.depth) <= eps && Math.abs(k.rect.y) > eps,
  }));
}

function keepoutMinimum(anchors: readonly KeepoutAnchor[], tile: number): { width: number; depth: number } {
  let width = tile;
  let depth = tile;
  for (const a of anchors) {
    if (!a.east) width = Math.max(width, a.keepout.rect.x + a.keepout.rect.w);
    else width = Math.max(width, a.keepout.rect.w);
    if (!a.north) depth = Math.max(depth, a.keepout.rect.y + a.keepout.rect.d);
    else depth = Math.max(depth, a.keepout.rect.d);
  }
  const roundUp = (v: number) => Math.ceil((v - 1e-9) / tile) * tile;
  return { width: roundUp(width), depth: roundUp(depth) };
}

function reflowKeepouts(hall: Project['halls'][number], anchors: readonly KeepoutAnchor[], fromWidth: number, fromDepth: number): void {
  hall.keepouts = anchors.map((a) => {
    const k = structuredClone(a.keepout);
    if (a.east) k.rect.x += hall.width - fromWidth;
    if (a.north) k.rect.y += hall.depth - fromDepth;
    k.rect.x = Math.max(0, Math.min(hall.width - k.rect.w, k.rect.x));
    k.rect.y = Math.max(0, Math.min(hall.depth - k.rect.d, k.rect.y));
    return k;
  });
}

/** What the validators would flag for this hall that the generator can correct by count, as new options (null = nothing to correct). */
function engineCorrections(project: Project, a: ProjectAnalysis, hallId: string, cur: HallLayoutOptions, layout: HallLayout): { opts: HallLayoutOptions; codes: string[] } | null {
  const hall = project.halls.find((h) => h.id === hallId)!;
  const cp = hall.coolingPlacement;
  const codes: string[] = [];
  let next = cur;
  const ch = a.cooling.perHall?.find((h) => h.hallId === hallId);
  const planned = typeof cur.crahs === 'number' ? cur.crahs : layout.crah.required;
  if (ch && ch.airKW > 0 && ch.crahsRequired > ch.crahsPlaced && ch.crahsRequired > planned && (!cp || cp.crahCount === 'auto')) {
    next = { ...next, crahs: ch.crahsRequired };
    codes.push('crah');
  }
  const pods = new Set(project.equipment.filter((e) => e.hallId === hallId && e.podId).map((e) => e.podId!));
  const short = (a.cooling.perPod ?? []).filter((p) => pods.has(p.podId) && p.cdusPlaced < p.cdusRequired);
  if (short.length && !cur.template.cdusExact && (!cp || (cp.cduPerPod === 'auto' && cp.cduPlacement !== 'gallery'))) {
    const need = Math.max(...short.map((p) => p.cdusRequired));
    let have = 0;
    try {
      have = podSizing(cur.template, cur.fabrics).cdus;
    } catch {
      have = 0;
    }
    // a CDU position notched by a keepout leaves the pod short even when the planned count is right: plan the deficit on top
    const deficit = Math.max(...short.map((p) => p.cdusRequired - p.cdusPlaced));
    const target = Math.max(need, have + deficit);
    if (target > have) {
      next = { ...next, template: { ...next.template, cdusPerPod: target } };
      codes.push('cdu');
    }
  }
  // central switches the engine could not host in this hall (network-core racks notched by a column, estimate drift): extra core racks
  const central = (a.network.unplacedSwitches ?? []).filter((u) => !u.podId && (u.fabric.endsWith(`· ${hall.name}`) || project.halls.length === 1));
  if (central.length) {
    try {
      const s = podSizing(next.template, next.fabrics);
      const extra = central.reduce((n, u) => n + Math.ceil(u.count / switchesPerNetworkRack(getCatalogItem(u.catalogId), s.netRack) - 1e-9), 0);
      const svc = next.services ?? { spineRacks: 'auto' as const, storageRacks: 0, cpuRacks: 0, mgmtRacks: 0 };
      next = { ...next, services: { ...svc, extraNetworkRacks: (svc.extraNetworkRacks ?? 0) + extra } };
      codes.push('network');
    } catch {
      /* unknown switch: reported as remaining */
    }
  }
  const leafShort = (a.network.unplacedSwitches ?? []).filter((u) => u.podId && pods.has(u.podId) && u.role === 'leaf');
  if (leafShort.length) {
    try {
      const s = podSizing(next.template, next.fabrics);
      const extra = Math.max(...leafShort.map((u) => Math.ceil(u.count / switchesPerNetworkRack(getCatalogItem(u.catalogId), s.netRack) - 1e-9)));
      next = { ...next, template: { ...next.template, networkRacksPerPod: s.netRacks + extra } };
      codes.push('network');
    } catch {
      /* unknown switch: reported as remaining */
    }
  }
  return codes.length ? { opts: next, codes } : null;
}

const count = (project: Project, hallId: string, cats: string[]) => project.equipment.filter((e) => e.hallId === hallId && cats.includes(catOf(e.catalogId) ?? '')).length;

/** Grids tried after the chosen one when the generated hall still has a run beyond reach (each try is one full generation). */
export const REACH_GRID_RETRIES = 3;

/** Cable runs of this hall the network analysis could not reach (either end in the hall). */
export function hallUnreachableRuns(project: Project, a: ProjectAnalysis, hallId: string): string[] {
  const tags = new Set(project.equipment.filter((e) => e.hallId === hallId).map((e) => e.tag));
  return (a.network.unreachableRuns ?? []).filter((u) => {
    const m = /^(.*)→(.*) [\d.]+ m @/.exec(u);
    return !!m && (tags.has(m[1]) || tags.has(m[2]));
  });
}

/**
 * Generate an auto-sized (or fixed-size) hall into `d` (mutated) — see the module comment. Returns the shortfall when a fixed hall is too
 * small, else the report and the analysis of the written project.
 *
 * qa-autosize v2 2차: the grid chooser measures reach on rack positions (Manhattan × route factor); the analysis routes cables along the
 * generated trays, which can be longer (single-build GB200 DU 16: services-row trays joined the pod trays only at the far end, 109 m).
 * When the written hall still has a run beyond reach, the chooser's next grids are generated on a copy of the untouched project and the
 * first without one (else the fewest) is kept — deterministic, at most REACH_GRID_RETRIES extra generations, only in that case.
 */
/**
 * backlog T1a (qa-autosize v2 2차 §3.3, 36 runs): after generation, electrical rooms sized deeper than the gap addHall left (rooms A / B side
 * by side on a wall facing the previous hall) are cleared by moving THIS hall away — only when it is the last hall on that axis, so no other
 * hall moves. Report correction 'room-gap'. Other conflicts keep their 'shift-hall' remedy.
 */
export function autoSizeHall(d: Project, hallId: string, req: AutoSizeRequest): AutoSizeResult {
  const r = autoSizeHallGrid(d, hallId, req);
  if (!r.ok) return r;
  // QA backlog geometry: one shift per conflicting neighbour (a hall can meet a room on one side and a grown hall on the other)
  for (let i = 0; i < d.halls.length + 1; i++) {
    const shift = roomConflictShift(d, r.analysis, hallId);
    if (!shift) break;
    d.halls = applyHallShift(d, shift).halls;
    r.analysis = analyzeProject(d);
    r.report.corrections.push('room-gap');
  }
  return r;
}

function autoSizeHallGrid(d: Project, hallId: string, req: AutoSizeRequest): AutoSizeResult {
  const hall = d.halls.find((h) => h.id === hallId);
  if (!hall || !req.grid.auto) return autoSizeHallOnce(d, hallId, req, null);
  const pristine = structuredClone(d);
  const choice = autoSizeGridChoice(d, hall, req);
  const first = autoSizeHallOnce(d, hallId, req, choice);
  if (!first.ok || !choice) return first;
  let bestN = hallUnreachableRuns(d, first.analysis, hallId).length;
  if (!bestN) return first;
  let best: { r: Extract<AutoSizeResult, { ok: true }>; project?: Project } = { r: first };
  for (const alt of choice.alternatives.slice(0, REACH_GRID_RETRIES)) {
    const q = structuredClone(pristine);
    const r = autoSizeHallOnce(q, hallId, req, alt);
    if (!r.ok) continue;
    const n = hallUnreachableRuns(q, r.analysis, hallId).length;
    if (n < bestN) {
      bestN = n;
      best = { r, project: q };
      if (!n) break;
    }
  }
  if (!best.project) return first;
  const target = d as unknown as Record<string, unknown>;
  for (const k of Object.keys(target)) if (!(k in best.project)) delete target[k];
  Object.assign(d, best.project);
  best.r.report.corrections.push('reach');
  return best.r;
}

function autoSizeHallOnce(d: Project, hallId: string, req: AutoSizeRequest, grid: Pick<GridChoice, 'orientation' | 'columns'> | null): AutoSizeResult {
  const hall = d.halls.find((h) => h.id === hallId);
  if (!hall) return { ok: false, shortfall: { width: 0, depth: 0 }, required: { width: 0, depth: 0 } };
  const sw = fabricSwitchFor(d, hallId, req.template.scaleOutSwitchCatalogId);
  const opts = autoSizeLayoutOptions(d, hall, req, grid);
  const W0 = hall.width;
  const D0 = hall.depth;
  const anchors = keepoutAnchors(hall);
  const minEnvelope = keepoutMinimum(anchors, hall.tileSize || 0.6);
  let layout = generateHallLayout(opts);
  if (req.autoSize) layout = growHallToFit(hall, opts); // establishes a valid envelope; right-size trims it after calibration
  else {
    const sf = hallShortfall(hall, layout);
    if (sf.width > 0 || sf.depth > 0) return { ok: false, shortfall: sf, required: { width: layout.requiredWidth, depth: layout.requiredDepth } };
  }
  // the cooling engine's CRAH count overrides the generator's estimate (pods stay as requested)
  const cal = calibrateLayout(d, hall, opts, { keepPods: true, rounds: 2, isolate: true, quick: true });
  let cur = cal.opts;
  layout = cal.layout;
  if (!fits(layout, hall)) {
    if (!req.autoSize) return { ok: false, shortfall: hallShortfall(hall, layout), required: { width: layout.requiredWidth, depth: layout.requiredDepth } };
    layout = growHallToFit(hall, cur);
  }
  if (req.autoSize && (req.rightSize || hall.width > W0 + 1e-6 || hall.depth > D0 + 1e-6)) {
    trimHallToLayout(hall, cur, req.rightSize ? minEnvelope.width : W0, req.rightSize ? minEnvelope.depth : D0);
    reflowKeepouts(hall, anchors, W0, D0);
    layout = generateHallLayout({ ...cur, hall });
  }
  const egress = (hall.layoutPolicy?.corridors ?? cur.corridors ?? CORRIDOR_DEFAULTS).egressM;
  let lost = 0;
  const write = () => {
    lost = notchKeepouts(layout, hall, egress);
    applyHallLayout(d, hallId, layout, cur, { waveStart: req.waveStart });
    const pol = hall.layoutPolicy!;
    if (req.servicesZone === 'auto') delete pol.servicesZone;
    else pol.servicesZone = req.servicesZone;
    pol.autoOrientation = req.grid.auto;
    d.cooling.cduCatalogId = cur.template.cduCatalogId;
    d.cooling.crahCatalogId = cur.crahCatalogId;
    d.network.scaleOut.switchCatalogId = sw.switchCatalogId;
    d.network.scaleOut.oversubscription = cur.template.oversubscription;
  };
  write();

  // engine verification: the same engines the validators read, corrected by count
  let a = analyzeProject(d);
  const corrections: string[] = [];
  for (let round = 0; round < 3; round++) {
    const fix = engineCorrections(d, a, hallId, cur, layout);
    if (!fix) break;
    corrections.push(...fix.codes);
    cur = fix.opts;
    layout = req.autoSize ? growHallToFit(hall, cur) : generateHallLayout({ ...cur, hall });
    if (req.autoSize) reflowKeepouts(hall, anchors, W0, D0);
    write();
    a = analyzeProject(d);
  }

  // budgets
  const mode = req.budgets ?? (req.autoSize ? 'fit' : 'hold');
  const before = { it: hall.itPowerBudgetKW, liquid: hall.liquidCoolingBudgetKW, air: hall.airCoolingBudgetKW, mva: d.site.utility.reduce((s, f) => s + f.capacityMVA, 0) };
  const t = hallBudgetTargets(d, a, hallId);
  let utility: AutoSizeReport['budgets']['utility'];
  if (mode === 'fit' && t) {
    const u = utilityTargets(d, a);
    const changed = t.it !== before.it || t.liquid !== before.liquid || t.air !== before.air || !!u;
    hall.itPowerBudgetKW = t.it;
    hall.liquidCoolingBudgetKW = t.liquid;
    hall.airCoolingBudgetKW = t.air;
    if (u) {
      for (const f of d.site.utility) if (u.feeds[f.id] !== undefined) f.capacityMVA = u.feeds[f.id];
      utility = { beforeMVA: before.mva, afterMVA: d.site.utility.reduce((s, f) => s + f.capacityMVA, 0), requiredMVA: u.requiredMVA };
    }
    if (changed) a = analyzeProject(d);
  }
  const perHall = a.cooling.perHall?.find((h) => h.hallId === hallId);
  const pods = new Set(d.equipment.filter((e) => e.hallId === hallId && e.podId).map((e) => e.podId!));
  const perPod = (a.cooling.perPod ?? []).filter((p) => pods.has(p.podId));
  const remaining = a.issues.filter((i) => i.severity !== 'info' && (issueHallId(d, i) === hallId || (!issueHallId(d, i) && SIZING_ISSUE_RE.test(i.id))));
  const report: AutoSizeReport = {
    pods: cur.pods,
    hall: { width: hall.width, depth: hall.depth, beforeWidth: W0, beforeDepth: D0, mode: !req.autoSize ? 'fixed' : req.rightSize ? 'right-size' : 'grow' },
    lost,
    cdus: { required: perPod.reduce((s, p) => s + p.cdusRequired, 0), placed: count(d, hallId, ['cdu']) },
    crahs: { required: perHall?.crahsRequired ?? 0, placed: count(d, hallId, ['crah', 'fan-wall']) },
    networkRacks: count(d, hallId, ['network-rack']),
    corrections,
    budgets: {
      mode,
      it: { before: before.it, after: hall.itPowerBudgetKW, requiredKW: Math.round(t?.itKW ?? 0) },
      liquid: { before: before.liquid, after: hall.liquidCoolingBudgetKW, requiredKW: Math.round(t?.liquidKW ?? 0) },
      air: { before: before.air, after: hall.airCoolingBudgetKW, requiredKW: Math.round(t?.airKW ?? 0) },
      ...(utility ? { utility } : {}),
    },
    ...(sw.kept ? { switchKept: { requested: req.template.scaleOutSwitchCatalogId, kept: sw.switchCatalogId, halls: sw.halls } } : {}),
    remaining,
  };
  return { ok: true, lost, report, issues: layout.issues, analysis: a };
}
