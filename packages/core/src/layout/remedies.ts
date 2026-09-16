// One-click remedies for validation issues (autosize v2 2차, DECISIONS-v2-2 §F "해결 가능한 경고는 원클릭 자동 해결 우선 제공").
//
// `issueRemedy(project, analysis, issue)` maps an issue to a deterministic remedy computed from the SAME engine results the validator used
// (cooling perPod / perHall counts, power perHall IT kW, utility MVA, network unplaced switches). `applyRemedy` is pure (returns a new
// project). `fixAllSafe` applies the safe remedies in priority rounds with a re-analysis between rounds. Issues without a remedy get a
// reason code (`noRemedyReason`) the UI explains.
//
// safe = adds cooling units / declares hall capacity only (never removes or moves IT racks, never changes a site contract or a plant
// temperature); every other remedy is offered per issue only.
import { catalogByCategory, findCatalogItem } from '../catalog/catalog.ts';
import { ELECTRICAL_ROOM_GAP_M } from '../engines/powerPaths.ts';
import { chooseLayoutGrid, rowEndWalls } from './grid.ts';
import { analyzeProject } from '../engines/index.ts';
import { chooseCable } from '../engines/network.ts';
import type { CoolingPlacementOptions, Hall, Issue, PowerRoom, Project, ProjectAnalysis } from '../model/types.ts';
import { coolingPlacementFor, regenerateCoolingReport } from './coolingPlacement.ts';
import { applyHallLayout, calibrateLayout, growHallToFit, layoutOptionsFromProject, notchKeepouts } from './fit.ts';
import { CORRIDOR_DEFAULTS } from './generate.ts';

export type RemedyKind = 'cooling-units' | 'hall-budget' | 'budget-utility' | 'utility-feeds' | 'regenerate-hall' | 'tcs-supply' | 'supply-air' | 'ups-auto' | 'single-mode' | 'shift-hall' | 'reshape-hall' | 'fan-wall';

/** Why an issue has no automatic remedy (the UI shows `autosize.noFix.<reason>`). */
export type NoRemedyReason = 'geometry' | 'design-choice' | 'site' | 'schedule' | 'workload' | 'manual-hall' | 'manual';

export interface IssueRemedy {
  issueId: string;
  kind: RemedyKind;
  /** included in "fix all" */
  safe: boolean;
  /** remedies sharing a key are applied once (e.g. every CDU / CRAH issue of one hall → one cooling regeneration) */
  key: string;
  hallId?: string;
  /** values for the UI label (`autosize.remedy.<kind>`) and for `applyRemedy` */
  params: Record<string, string | number>;
}

/** Utilisation above which validate.ts warns `power-hall-budget-hi` — raised IT budgets keep the design at or below it. */
export const BUDGET_HEADROOM = 0.9;
const roundUp = (v: number, step: number) => Math.round(Math.ceil(v / step - 1e-9) * step * 1e6) / 1e6;

/** Issue ids that count as "sizing" (the counts / capacities an auto-sized generation must satisfy). */
export const SIZING_ISSUE_RE = /^(cooling-(cdu-(none|under|redundancy)|crah-(under|redundancy|none)|airflow|liquid-budget|air-budget)|layout-(crah-count|crah-short|cdu-gallery-short|budget-limited)|network-(unplaced|unconnected|cluster-core-unplaced)|power-(hall-budget|ups-under|ups-block-headroom|rpp-overload|utility-(total|firm)))/;
const COOLING_UNIT_RE = /^(cooling-(cdu-(none|under|redundancy)|crah-(under|redundancy|none)|airflow)|layout-crah-count)-/;
const BUDGET_RE = /^(power-hall-budget(-hi)?|cooling-(liquid|air)-budget|layout-budget-limited)-/;

const hallOfPod = (project: Project, podId: string) => project.equipment.find((e) => e.podId === podId)?.hallId;

/** Halls whose switches the network engine could not place (pod → its hall; central → the hall named in the fabric label, else the only hall with network racks). */
export function unplacedSwitchHalls(project: Project, analysis: ProjectAnalysis): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const netHalls = [...new Set(project.equipment.filter((e) => findCatalogItem(e.catalogId)?.category === 'network-rack').map((e) => e.hallId))];
  for (const u of analysis.network.unplacedSwitches ?? []) {
    if (u.podId?.startsWith('inter-hall:')) continue;
    const byPod = u.podId ? hallOfPod(project, u.podId) : undefined;
    const byName = project.halls.find((h) => u.fabric.endsWith(`· ${h.name}`))?.id;
    const hallId = byPod ?? byName ?? (netHalls.length === 1 ? netHalls[0] : project.halls.length === 1 ? project.halls[0].id : undefined);
    if (!hallId) continue;
    const id = `network-unplaced-${u.catalogId}-${u.role}-${u.podId ?? 'central'}-${u.fabric}`;
    out.set(hallId, [...(out.get(hallId) ?? []), id]);
  }
  return out;
}

/** Hall an issue belongs to (id suffix, refs, pod id, equipment refs), or undefined for project-level issues. */
export function issueHallId(project: Project, issue: Issue): string | undefined {
  for (const h of project.halls) if (issue.id.endsWith(`-${h.id}`)) return h.id;
  for (const h of project.halls) if (issue.refs?.includes(h.id)) return h.id;
  const pod = /-(pod-[\w-]+)$/.exec(issue.id)?.[1];
  if (pod) {
    const h = hallOfPod(project, pod);
    if (h) return h;
  }
  const named = project.halls.find((h) => issue.id.startsWith('network-unplaced-') && issue.id.endsWith(`· ${h.name}`));
  if (named) return named.id;
  for (const r of issue.refs ?? []) {
    const h = project.equipment.find((e) => e.id === r)?.hallId;
    if (h) return h;
  }
  return undefined;
}

/** Hall budgets the design needs (never lower than today): IT at ≤ 90 % utilisation, liquid / air at the engine heat, 100 kW steps. */
export function hallBudgetTargets(project: Project, analysis: ProjectAnalysis, hallId: string): { it: number; liquid: number; air: number; itKW: number; liquidKW: number; airKW: number } | undefined {
  const hall = project.halls.find((h) => h.id === hallId);
  if (!hall) return undefined;
  const ph = analysis.power.perHall.find((h) => h.hallId === hallId);
  const ch = analysis.cooling.perHall?.find((h) => h.hallId === hallId);
  const itKW = ph?.itKW ?? 0;
  const liquidKW = ch?.liquidKW ?? 0;
  const airKW = ch?.airKW ?? 0;
  return {
    it: itKW > hall.itPowerBudgetKW * BUDGET_HEADROOM + 1e-6 ? roundUp(itKW / BUDGET_HEADROOM, 100) : hall.itPowerBudgetKW,
    liquid: liquidKW > hall.liquidCoolingBudgetKW + 1e-6 ? roundUp(liquidKW, 100) : hall.liquidCoolingBudgetKW,
    air: airKW > hall.airCoolingBudgetKW + 1e-6 ? roundUp(airKW, 100) : hall.airCoolingBudgetKW,
    itKW, liquidKW, airKW,
  };
}

/** Utility feed capacities (MVA, 0.5 steps, scaled together) that meet the required feed with the N-1 firm rule; undefined when it already holds. */
export function utilityTargets(project: Project, analysis: ProjectAnalysis): { requiredMVA: number; feeds: Record<string, number> } | undefined {
  const req = analysis.power.utilityRequiredMVA;
  const feeds = project.site.utility.map((f) => ({ id: f.id, sub: f.substation, mva: f.capacityMVA }));
  if (!feeds.length) return undefined;
  const firmOf = () => {
    const total = feeds.reduce((s, f) => s + f.mva, 0);
    const bySub = new Map<string, number>();
    for (const f of feeds) bySub.set(f.sub, (bySub.get(f.sub) ?? 0) + f.mva);
    return { total, firm: bySub.size >= 2 ? total - Math.max(...bySub.values()) : total };
  };
  if (firmOf().firm >= req - 1e-9) return undefined;
  for (let k = 0; k < 12; k++) {
    const { firm } = firmOf();
    if (firm >= req - 1e-9) break;
    const f = req / Math.max(1e-6, firm);
    for (const x of feeds) x.mva = Math.max(x.mva, roundUp(Math.max(x.mva, 0.5) * f, 0.5));
  }
  return { requiredMVA: req, feeds: Object.fromEntries(feeds.map((f) => [f.id, f.mva])) };
}

const hasGeneratedLayout = (project: Project, hallId: string) => !!project.halls.find((h) => h.id === hallId)?.layoutPolicy;
const hasComputeRows = (project: Project, hallId: string) => project.equipment.some((e) => e.hallId === hallId && !!e.rowId && findCatalogItem(e.catalogId)?.category === 'gpu-rack');

/** Deterministic remedy of one issue, or undefined (see `noRemedyReason`). */
export function issueRemedy(project: Project, analysis: ProjectAnalysis, issue: Issue): IssueRemedy | undefined {
  const id = issue.id;
  const hallId = issueHallId(project, issue);
  const hall = hallId ? project.halls.find((h) => h.id === hallId) : undefined;
  const base = { issueId: id, hallId };
  if (COOLING_UNIT_RE.test(id)) {
    if (!hall || !hasComputeRows(project, hall.id)) return undefined;
    const pods = new Set(project.equipment.filter((e) => e.hallId === hall.id && e.podId).map((e) => e.podId!));
    const cdu = (analysis.cooling.perPod ?? []).filter((p) => pods.has(p.podId)).reduce((s, p) => s + p.cdusRequired, 0);
    const crah = analysis.cooling.perHall?.find((h) => h.hallId === hall.id)?.crahsRequired ?? 0;
    return { ...base, kind: 'cooling-units', safe: true, key: `cooling|${hall.id}`, params: { hall: hall.name, cdu, crah } };
  }
  if (BUDGET_RE.test(id)) {
    if (!hall) return undefined;
    const t = hallBudgetTargets(project, analysis, hall.id);
    if (!t || (t.it === hall.itPowerBudgetKW && t.liquid === hall.liquidCoolingBudgetKW && t.air === hall.airCoolingBudgetKW)) return undefined;
    // qa-autosize v2 2차: a budget-limited issue that also carries the utility shortfall (validate.ts folds it in) raises the feeds too — not "safe"
    const u = id.startsWith('layout-budget-limited-') ? utilityTargets(project, analysis) : undefined;
    if (u) return { ...base, kind: 'budget-utility', safe: false, key: `budget|${hall.id}`, params: { hall: hall.name, it: t.it, liquid: t.liquid, air: t.air, mva: Math.round(u.requiredMVA * 10) / 10, feeds: Object.entries(u.feeds).map(([k, v]) => `${k}=${v}`).join(',') } };
    return { ...base, kind: 'hall-budget', safe: true, key: `budget|${hall.id}`, params: { hall: hall.name, it: t.it, liquid: t.liquid, air: t.air } };
  }
  if (id === 'power-utility-total' || id === 'power-utility-firm') {
    const u = utilityTargets(project, analysis);
    if (!u) return undefined;
    return { issueId: id, kind: 'utility-feeds', safe: false, key: 'utility', params: { mva: Math.round(u.requiredMVA * 10) / 10, feeds: Object.entries(u.feeds).map(([k, v]) => `${k}=${v}`).join(',') } };
  }
  if (id.startsWith('network-unplaced-') || id === 'network-unconnected') {
    const halls = unplacedSwitchHalls(project, analysis);
    const target = id === 'network-unconnected' ? (halls.size === 1 ? [...halls.keys()][0] : undefined) : [...halls].find(([, ids]) => ids.includes(id))?.[0];
    const h = target ? project.halls.find((x) => x.id === target) : undefined;
    if (!h || !hasGeneratedLayout(project, h.id)) return undefined;
    return { issueId: id, hallId: h.id, kind: 'regenerate-hall', safe: false, key: `regen|${h.id}`, params: { hall: h.name } };
  }
  if (id.startsWith('network-cluster-core-unplaced-')) {
    const c = (analysis.network.clusters ?? []).find((x) => id === `network-cluster-core-unplaced-${x.id}`);
    const h = project.halls.find((x) => x.id === c?.interHall?.zoneHallId);
    if (!h || !hasGeneratedLayout(project, h.id)) return undefined;
    return { issueId: id, hallId: h.id, kind: 'regenerate-hall', safe: false, key: `regen|${h.id}`, params: { hall: h.name } };
  }
  if (id.startsWith('layout-ihc-stale-')) {
    if (!hall || !hasGeneratedLayout(project, hall.id)) return undefined;
    return { ...base, kind: 'regenerate-hall', safe: false, key: `regen|${hall.id}`, params: { hall: hall.name } };
  }
  if (id.startsWith('cooling-tcs-temp-')) {
    const limits = project.equipment.map((e) => findCatalogItem(e.catalogId)).filter((it) => (it?.cooling?.liquidFraction ?? 0) > 0 && it?.cooling?.maxCoolantSupplyC !== undefined).map((it) => it!.cooling!.maxCoolantSupplyC!);
    const c = limits.length ? Math.min(...limits) : undefined;
    if (c === undefined || c >= project.cooling.tcsSupplyC) return undefined;
    return { issueId: id, kind: 'tcs-supply', safe: false, key: 'tcs-supply', params: { c, from: project.cooling.tcsSupplyC, fws: project.cooling.fwsSupplyC } };
  }
  if (id.startsWith('cooling-supply-air-')) {
    const limits = project.equipment.map((e) => findCatalogItem(e.catalogId)).filter((it) => it && it.category !== 'crah' && it.cooling?.maxInletC !== undefined).map((it) => it!.cooling!.maxInletC!);
    const c = limits.length ? Math.min(...limits) : undefined;
    if (c === undefined || c >= project.cooling.supplyAirC) return undefined;
    return { issueId: id, kind: 'supply-air', safe: false, key: 'supply-air', params: { c, from: project.cooling.supplyAirC } };
  }
  if ((id === 'power-ups-block-headroom' || id === 'power-ups-under') && project.power.upsBlocks) {
    return { issueId: id, kind: 'ups-auto', safe: false, key: 'ups-auto', params: { blocks: project.power.upsBlocks.activeBlocks, modules: project.power.upsBlocks.blockModules } };
  }
  if (id.startsWith('network-unreachable-') && !project.network.cabling.preferSingleMode && singleModeReaches(project, analysis, id)) {
    return { issueId: id, kind: 'single-mode', safe: false, key: 'single-mode', params: {} };
  }
  return undefined;
}

/**
 * qa-autosize v2 2차: the single-mode preference only removes multimode / AOC choices, so it helps a run only when the cable chooser WITH the
 * preference finds a type that reaches it (16-DU halls offered it for 100G front-end runs past every 100G type: nothing changed and the extra
 * optics power broke the fitted budgets).
 */
function singleModeReaches(project: Project, analysis: ProjectAnalysis, issueId: string): boolean {
  const run = analysis.network.unreachableRuns?.[Number(issueId.slice('network-unreachable-'.length))];
  const m = run ? / ([\d.]+) m @([\d.]+)G$/.exec(run) : null;
  if (!m) return false;
  const smf: Project = { ...project, network: { ...project.network, cabling: { ...project.network.cabling, preferSingleMode: true } } };
  return chooseCable(smf, Number(m[2]), Number(m[1])).ok;
}

// ───────────── backlog T1a: site shift, reshape and fan-wall remedies (never in "Fix all": not in PRIORITY, safe: false) ─────────────

/** access clearance kept between two facing electrical rooms of neighbouring halls (estimate, same order as the room end aisles) */
export const ROOM_ACCESS_M = 1.2;
/** reshape remedy: aspect ceiling (qa-autosize v2 2차 §3.4 option ii / DECISIONS-v2-2 §H "grid up to 3:1") */
export const RESHAPE_MAX_ASPECT = 3;

export interface HallShift {
  moveHallId: string;
  otherHallId: string;
  axis: 'x' | 'y';
  m: number;
}

const siteRect = (h: Hall) => ({ x: h.origin.x, y: h.origin.y, w: h.width, d: h.depth });
const roomSite = (h: Hall, r: PowerRoom) => ({ x: h.origin.x + r.rect.x, y: h.origin.y + r.rect.y, w: r.rect.w, d: r.rect.d });
const hit = (p: { x: number; y: number; w: number; d: number }, q: { x: number; y: number; w: number; d: number }) =>
  p.x < q.x + q.w - 0.01 && p.x + p.w > q.x + 0.01 && p.y < q.y + q.d - 0.01 && p.y + p.d > q.y + 0.01;

/**
 * Shift that clears two halls and their facing electrical rooms: the hall further along the separating axis moves away by the missing gap
 * (facing room depths + room gaps + ROOM_ACCESS_M − current gap), rounded up to 0.5 m. Undefined when nothing is missing.
 */
export function hallPairShift(project: Project, analysis: ProjectAnalysis, aId: string, bId: string): HallShift | undefined {
  const a = project.halls.find((h) => h.id === aId);
  const b = project.halls.find((h) => h.id === bId);
  if (!a || !b || a.id === b.id) return undefined;
  const ox = Math.min(a.origin.x + a.width, b.origin.x + b.width) - Math.max(a.origin.x, b.origin.x);
  const oy = Math.min(a.origin.y + a.depth, b.origin.y + b.depth) - Math.max(a.origin.y, b.origin.y);
  // side by side along x when their y extents overlap more than their x extents
  const axis: 'x' | 'y' = oy >= ox ? 'x' : 'y';
  const o = (h: Hall) => (axis === 'x' ? h.origin.x : h.origin.y);
  const size = (h: Hall) => (axis === 'x' ? h.width : h.depth);
  const [lo, hi] = o(a) <= o(b) ? [a, b] : [b, a];
  const rooms = analysis.power.rooms ?? [];
  const facing = (h: Hall, wall: string) => Math.max(0, ...rooms.filter((r) => r.hallId === h.id && r.wall === wall).map((r) => ELECTRICAL_ROOM_GAP_M + (axis === 'x' ? r.rect.w : r.rect.d)));
  const fl = facing(lo, axis === 'x' ? 'E' : 'N');
  const fh = facing(hi, axis === 'x' ? 'W' : 'S');
  const required = fl + fh + (fl + fh > 0 ? ROOM_ACCESS_M : 0.01);
  const gap = o(hi) - (o(lo) + size(lo));
  const need = required - gap;
  if (need <= 0.05) return undefined;
  return { moveHallId: hi.id, otherHallId: lo.id, axis, m: Math.ceil(need * 2 - 1e-9) / 2 };
}

/** The hall pair behind a site overlap / room-vs-hall issue. */
function issueHallPair(project: Project, analysis: ProjectAnalysis, issue: Issue): [string, string] | undefined {
  if (issue.id.startsWith('site-hall-overlap-') && issue.refs && issue.refs.length >= 2) return [issue.refs[0], issue.refs[1]];
  const m = /^power-elec-room-wall-(.+)$/.exec(issue.id);
  const room = m ? (analysis.power.rooms ?? []).find((r) => r.id === m[1]) : undefined;
  // QA backlog geometry: by geometry, whatever the recorded conflict — a room pushed onto a CRAH wall (conflict 'crah', 16 DU) reached the
  // neighbouring hall 20–27 m away and offered no shift
  if (!room) return undefined;
  const hall = project.halls.find((h) => h.id === room.hallId);
  if (!hall) return undefined;
  const rs = roomSite(hall, room);
  for (const h of project.halls) {
    if (h.id === hall.id) continue;
    if (hit(rs, siteRect(h)) || (analysis.power.rooms ?? []).some((r) => r.hallId === h.id && hit(rs, roomSite(h, r)))) return [hall.id, h.id];
  }
  return undefined;
}

/**
 * autoSizeHall (backlog T1a): the shift that clears a room of `hallId` blocked by a neighbouring hall / room, when the sized hall itself is
 * the one to move and no other hall lies beyond it on that axis (the hall addHall placed last). Undefined otherwise (the issue keeps its
 * 'shift-hall' remedy).
 */
export function roomConflictShift(project: Project, analysis: ProjectAnalysis, hallId: string): HallShift | undefined {
  const me = project.halls.find((h) => h.id === hallId);
  if (!me) return undefined;
  // QA backlog geometry (qa-backlog-geometry.md §2): every site conflict of the sized hall counts — its hall rectangle or rooms against another
  // hall or that hall's rooms, whatever the room's recorded conflict. Before, only the sized hall's own rooms flagged 'hall' / 'room' were
  // shifted: a room on a CRAH wall, a room of the previous hall reaching the hall addHall placed next to it, or a grown hall overlapping the
  // empty halls added before sizing all stayed on the site plan.
  const rooms = analysis.power.rooms ?? [];
  const footprint = (h: Hall) => [siteRect(h), ...rooms.filter((r) => r.hallId === h.id).map((r) => roomSite(h, r))];
  const empty = (h: Hall) => !project.equipment.some((e) => e.hallId === h.id);
  const mine = footprint(me);
  for (const other of project.halls) {
    if (other.id === hallId) continue;
    const theirs = footprint(other);
    if (!mine.some((p) => theirs.some((q) => hit(p, q)))) continue;
    const s = hallPairShift(project, analysis, hallId, other.id);
    if (!s) continue;
    const mover = project.halls.find((h) => h.id === s.moveHallId)!;
    const k = s.axis;
    // applyHallShift also moves every hall at or beyond the mover: only empty halls (no equipment) may move besides the sized hall itself
    const carried = project.halls.filter((h) => h.id !== s.otherHallId && h.id !== mover.id && h.origin[k] >= mover.origin[k] - 1e-6);
    if (!carried.every(empty) || (mover.id !== hallId && !empty(mover))) continue;
    return s;
  }
  return undefined;
}

/** Move `shift.moveHallId` and every hall at or beyond it on the axis by `shift.m` (equipment is hall-local, so only origins change). Pure. */
export function applyHallShift(project: Project, shift: HallShift): Project {
  const d = structuredClone(project);
  const mover = d.halls.find((h) => h.id === shift.moveHallId);
  if (!mover || shift.m <= 0) return project;
  const k = shift.axis === 'x' ? 'x' : 'y';
  const base = mover.origin[k];
  for (const h of d.halls) if (h.id !== shift.otherHallId && h.origin[k] >= base - 1e-6) h.origin[k] = Math.round((h.origin[k] + shift.m) * 1e6) / 1e6;
  return d;
}

interface ReshapePlan { orientation: 'x' | 'y'; columns: number; width: number; depth: number; areaPct: number; aspect: number }
const reshapeCache = new WeakMap<Project, Map<string, ReshapePlan | null>>();
/** Smallest in-reach grid up to RESHAPE_MAX_ASPECT that leaves a wall free for the electrical room (the grid chooser's probes). Cached per project. */
export function reshapeHallPlan(project: Project, hallId: string): ReshapePlan | null {
  let m = reshapeCache.get(project);
  if (!m) reshapeCache.set(project, (m = new Map()));
  if (m.has(hallId)) return m.get(hallId)!;
  let plan: ReshapePlan | null = null;
  const hall = project.halls.find((h) => h.id === hallId);
  try {
    if (hall?.layoutPolicy && hasGeneratedLayout(project, hallId)) {
      const o = layoutOptionsFromProject(project, hall);
      const choice = chooseLayoutGrid({ ...o, hall: { ...hall, width: 0, depth: 0, keepouts: [] } }, { mode: 'auto-size', targetAspect: RESHAPE_MAX_ASPECT });
      const c = choice.candidates.filter((x) => x.freeWalls >= 1 && x.reachOk && x.throwOk && x.aspect <= RESHAPE_MAX_ASPECT + 1e-9).sort((p, q) => p.areaM2 - q.areaM2)[0];
      const area0 = hall.width * hall.depth;
      if (c && area0 > 0) plan = { orientation: c.orientation, columns: c.columns, width: c.widthM, depth: c.depthM, areaPct: Math.round((c.areaM2 / area0 - 1) * 1000) / 10, aspect: Math.round(c.aspect * 100) / 100 };
    }
  } catch {
    plan = null;
  }
  m.set(hallId, plan);
  return plan;
}

interface FanWallPlan { fanId: string; units: number; crahs: number; kwFrom: number; kwTo: number; wallFrom: number; wallTo: number; capexDelta: number }
/** Fan walls instead of the hall's CRAHs: the catalog fan wall with the most cooling per wall metre (no fixed model), N+extra as the CRAH rule. */
export function fanWallPlan(project: Project, analysis: ProjectAnalysis, hallId: string): FanWallPlan | null {
  const hall = project.halls.find((h) => h.id === hallId);
  const ch = analysis.cooling.perHall?.find((h) => h.hallId === hallId);
  if (!hall || !ch || !(ch.airKW > 0) || hall.layoutPolicy?.crahStrategy === 'gallery-fan-wall') return null;
  const fan = catalogByCategory('fan-wall').filter((f) => (f.capacity?.coolingKW ?? 0) > 0 && f.dims.w > 0).sort((p, q) => q.capacity!.coolingKW! / q.dims.w - p.capacity!.coolingKW! / p.dims.w)[0];
  const units = project.equipment.filter((e) => e.hallId === hallId && findCatalogItem(e.catalogId)?.category === 'crah');
  const crah = units.length ? findCatalogItem(units[0].catalogId) : findCatalogItem(hall.coolingPlacement?.crahCatalogId ?? project.cooling.crahCatalogId);
  if (!fan || !crah || !(crah.capacity?.coolingKW ?? 0)) return null;
  const extra = Math.max(0, ch.crahsRequired - Math.ceil(ch.airKW / crah.capacity!.coolingKW! - 1e-9));
  const n = Math.ceil(ch.airKW / fan.capacity!.coolingKW! - 1e-9) + extra;
  // QA backlog geometry: the remedy exists to free a wall for the electrical rooms, so the fan walls must fit the two row-end walls (1 m wall
  // margin at each end, as the wall-unit placer). 16-DU halls needed more wall than that and the fan walls went back onto all four walls.
  const orientation = hall.layoutPolicy?.orientation ?? 'x';
  const rowEndLen = orientation === 'x' ? hall.depth : hall.width;
  if (n * fan.dims.w > 2 * Math.max(0, rowEndLen - 2) + 1e-6) return null;
  const c = units.length;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return { fanId: fan.id, units: n, crahs: c, kwFrom: Math.round(c * crah.capacity!.coolingKW!), kwTo: Math.round(n * fan.capacity!.coolingKW!), wallFrom: r1(c * crah.dims.w), wallTo: r1(n * fan.dims.w), capexDelta: Math.round((n * (fan.cost?.capexUSD ?? 0) - c * (crah.cost?.capexUSD ?? 0)) / 1000) * 1000 };
}

/**
 * Every remedy of an issue, the primary first (issueRemedy). Electrical-room issues (DECISIONS-v2-2 §H): a room blocked by another hall /
 * room → 'shift-hall'; a room blocked by cooling walls → 'reshape-hall' (grid up to 3:1, area change) and 'fan-wall' (cooling / CAPEX change).
 */
export function issueRemedies(project: Project, analysis: ProjectAnalysis, issue: Issue): IssueRemedy[] {
  const out: IssueRemedy[] = [];
  const primary = issueRemedy(project, analysis, issue);
  if (primary) out.push(primary);
  if (/^(power-elec-room-wall-|site-hall-overlap-)/.test(issue.id)) {
    const pair = issueHallPair(project, analysis, issue);
    const shift = pair ? hallPairShift(project, analysis, pair[0], pair[1]) : undefined;
    if (shift) {
      const move = project.halls.find((h) => h.id === shift.moveHallId)!;
      const other = project.halls.find((h) => h.id === shift.otherHallId)!;
      out.push({ issueId: issue.id, hallId: move.id, kind: 'shift-hall', safe: false, key: `shift|${move.id}|${other.id}`, params: { move: move.name, other: other.name, m: shift.m, axis: shift.axis, moveId: move.id, otherId: other.id } });
    }
    const m = /^power-elec-room-wall-(.+)$/.exec(issue.id);
    const room = m ? (analysis.power.rooms ?? []).find((r) => r.id === m[1]) : undefined;
    const hall = room ? project.halls.find((h) => h.id === room.hallId) : undefined;
    if (room && hall && (room.conflict === 'crah' || room.conflict === 'cdu-gallery')) {
      const rp = reshapeHallPlan(project, hall.id);
      if (rp) out.push({ issueId: issue.id, hallId: hall.id, kind: 'reshape-hall', safe: false, key: `reshape|${hall.id}`, params: { hall: hall.name, w: rp.width, d: rp.depth, aspect: rp.aspect, pct: `${rp.areaPct >= 0 ? '+' : ''}${rp.areaPct}`, orientation: rp.orientation, columns: rp.columns } });
      const fp = room.conflict === 'crah' ? fanWallPlan(project, analysis, hall.id) : null;
      if (fp) out.push({ issueId: issue.id, hallId: hall.id, kind: 'fan-wall', safe: false, key: `fanwall|${hall.id}`, params: { hall: hall.name, n: fp.units, crahs: fp.crahs, kwFrom: fp.kwFrom, kwTo: fp.kwTo, wallFrom: fp.wallFrom, wallTo: fp.wallTo, capex: `${fp.capexDelta >= 0 ? '+' : ''}${fp.capexDelta.toLocaleString('en-US')}`, fanId: fp.fanId } });
    }
  }
  return out;
}

/** Reason code for an issue without a remedy. */
export function noRemedyReason(project: Project, issue: Issue): NoRemedyReason {
  const id = issue.id;
  const hallId = issueHallId(project, issue);
  if ((COOLING_UNIT_RE.test(id) || id.startsWith('network-unplaced-') || id.startsWith('layout-ihc-stale-')) && hallId && !hasGeneratedLayout(project, hallId)) return 'manual-hall';
  if (issue.domain === 'space' || /^layout-(row|containment|tray|busway|services|cdu-gallery|crah-short|row-long|crah-pod-edge)/.test(id) || id.startsWith('site-hall-overlap') || id.startsWith('network-unreachable-')) return 'geometry';
  if (issue.domain === 'schedule') return 'schedule';
  if (issue.domain === 'workload') return 'workload';
  if (/^power-(utility-(single|none)|elec-room-(wall|shared-wall))/.test(id) || id.startsWith('network-cluster-reach')) return 'site';
  if (/^(network-(oversub|breakout|infeasible|extrapolated)|cooling-approach|power-rpp-overload|cost-zero)/.test(id)) return 'design-choice';
  return 'manual';
}

/** Every remedy of an analysis (one per issue that has one). */
export function remediesFor(project: Project, analysis: ProjectAnalysis): IssueRemedy[] {
  return analysis.issues.map((i) => issueRemedy(project, analysis, i)).filter((r): r is IssueRemedy => !!r);
}

/**
 * Regenerate a generated hall with its own options (template, platform, pods, services, fabric switch from the project), the cooling
 * engine's CRAH count and the engine CDU rule; grows the hall when needed (never shrinks). Pure.
 */
export function regenerateHall(project: Project, hallId: string): Project {
  const d = structuredClone(project);
  const hall = d.halls.find((h) => h.id === hallId);
  if (!hall?.layoutPolicy) return project;
  const o = layoutOptionsFromProject(d, hall);
  const cal = calibrateLayout(d, hall, o, { keepPods: true, rounds: 2, isolate: true, quick: true });
  const layout = growHallToFit(hall, cal.opts);
  notchKeepouts(layout, hall, (hall.layoutPolicy.corridors ?? CORRIDOR_DEFAULTS).egressM);
  applyHallLayout(d, hallId, layout, cal.opts, { policy: { ...hall.layoutPolicy, crahWalls: layout.crah.walls, grid: { columns: layout.grid.columns, rows: layout.grid.rows } } });
  return d;
}

/**
 * qa-autosize v2 2차 (perturbation suite): regenerating a hall re-sizes its network / services racks for the current project switch, so the
 * hall can draw more than before (Helios 4 DU after a switch change: layout-budget-limited appeared as a NEW error). When the hall budgets
 * fitted the design before (the auto-size default), they are raised to the regenerated design (never lowered); budgets that were already
 * binding stay as they are (the existing budget issue keeps the shortfall).
 */
function keepBudgetsFitted(before: Project, after: Project, hallId: string): Project {
  const h0 = before.halls.find((h) => h.id === hallId);
  const t0 = h0 ? hallBudgetTargets(before, analyzeProject(before), hallId) : undefined;
  if (!h0 || !t0 || t0.it !== h0.itPowerBudgetKW || t0.liquid !== h0.liquidCoolingBudgetKW || t0.air !== h0.airCoolingBudgetKW) return after;
  const h1 = after.halls.find((h) => h.id === hallId);
  const t1 = h1 ? hallBudgetTargets(after, analyzeProject(after), hallId) : undefined;
  if (!h1 || !t1) return after;
  h1.itPowerBudgetKW = Math.max(h1.itPowerBudgetKW, t1.it);
  h1.liquidCoolingBudgetKW = Math.max(h1.liquidCoolingBudgetKW, t1.liquid);
  h1.airCoolingBudgetKW = Math.max(h1.airCoolingBudgetKW, t1.air);
  return after;
}

const hallSizingIssues = (p: Project, a: ProjectAnalysis, hallId: string, re: RegExp) => a.issues.filter((i) => i.severity !== 'info' && re.test(i.id) && issueHallId(p, i) === hallId);
const hallProblemCount = (p: Project, a: ProjectAnalysis, hallId: string) => a.issues.filter((i) => i.severity !== 'info' && issueHallId(p, i) === hallId).length;

/** Apply one remedy (pure). Returns the input unchanged when the remedy no longer applies. */
export function applyRemedy(project: Project, remedy: IssueRemedy): Project {
  const d = structuredClone(project);
  const hall = remedy.hallId ? d.halls.find((h) => h.id === remedy.hallId) : undefined;
  switch (remedy.kind) {
    case 'cooling-units': {
      if (!hall) return project;
      // keep every rack where it is: re-place only the hall's CDUs / CRAHs at the engine counts; if that cannot place them cleanly, regenerate the hall
      const opts: CoolingPlacementOptions = { ...coolingPlacementFor(hall), cduPerPod: 'auto', crahCount: 'auto' };
      const before = hallProblemCount(project, analyzeProject(project), hall.id);
      const rep = regenerateCoolingReport(project, hall.id, opts);
      if (!rep.requiresRegenerate && !rep.issues.some((i) => i.severity === 'error')) {
        const a = analyzeProject(rep.project);
        if (!hallSizingIssues(rep.project, a, hall.id, COOLING_UNIT_RE).length && hallProblemCount(rep.project, a, hall.id) < before) return rep.project;
      }
      return hall.layoutPolicy ? regenerateHall(project, hall.id) : rep.project;
    }
    case 'regenerate-hall': {
      if (!hall) return project;
      const next = regenerateHall(project, hall.id);
      return next === project ? project : keepBudgetsFitted(project, next, hall.id);
    }
    case 'hall-budget': {
      if (!hall) return project;
      hall.itPowerBudgetKW = Math.max(hall.itPowerBudgetKW, Number(remedy.params.it));
      hall.liquidCoolingBudgetKW = Math.max(hall.liquidCoolingBudgetKW, Number(remedy.params.liquid));
      hall.airCoolingBudgetKW = Math.max(hall.airCoolingBudgetKW, Number(remedy.params.air));
      return d;
    }
    case 'budget-utility':
    case 'utility-feeds': {
      if (remedy.kind === 'budget-utility') {
        if (!hall) return project;
        hall.itPowerBudgetKW = Math.max(hall.itPowerBudgetKW, Number(remedy.params.it));
        hall.liquidCoolingBudgetKW = Math.max(hall.liquidCoolingBudgetKW, Number(remedy.params.liquid));
        hall.airCoolingBudgetKW = Math.max(hall.airCoolingBudgetKW, Number(remedy.params.air));
      }
      const map = new Map(String(remedy.params.feeds).split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
      for (const f of d.site.utility) if (map.has(f.id)) f.capacityMVA = Math.max(f.capacityMVA, Number(map.get(f.id)));
      return d;
    }
    case 'tcs-supply':
      d.cooling.tcsSupplyC = Number(remedy.params.c);
      return d;
    case 'supply-air':
      d.cooling.supplyAirC = Number(remedy.params.c);
      return d;
    case 'ups-auto':
      delete d.power.upsBlocks;
      return d;
    case 'single-mode':
      d.network.cabling.preferSingleMode = true;
      return d;
    case 'shift-hall':
      return applyHallShift(project, { moveHallId: String(remedy.params.moveId), otherHallId: String(remedy.params.otherId), axis: remedy.params.axis === 'y' ? 'y' : 'x', m: Number(remedy.params.m) });
    case 'reshape-hall': {
      if (!hall?.layoutPolicy) return project;
      const orientation = remedy.params.orientation === 'y' ? 'y' : 'x';
      hall.width = Number(remedy.params.w);
      hall.depth = Number(remedy.params.d);
      hall.layoutPolicy = { ...hall.layoutPolicy, orientation, grid: { ...(hall.layoutPolicy.grid ?? { rows: 1 }), columns: Number(remedy.params.columns) }, crahWalls: rowEndWalls(orientation) } as typeof hall.layoutPolicy;
      if (hall.coolingPlacement) hall.coolingPlacement = { ...hall.coolingPlacement, crahWalls: undefined, cduGalleryWall: undefined };
      const next = regenerateHall(d, hall.id);
      // QA backlog geometry: like 'regenerate-hall', fitted budgets follow the regenerated design (no new layout-budget-limited error)
      return next === d ? project : keepBudgetsFitted(project, next, hall.id);
    }
    case 'fan-wall': {
      if (!hall) return project;
      // QA backlog geometry: row-end walls first (the placer adds a wall only when they are full) — the hall's own crahWalls were all four
      // walls in the 16-DU halls this remedy is offered for, so the rooms never got a free wall
      const orientation = hall.layoutPolicy?.orientation ?? 'x';
      const opts: CoolingPlacementOptions = { ...coolingPlacementFor(hall), crahStrategy: 'gallery-fan-wall', crahCatalogId: String(remedy.params.fanId), crahCount: 'auto', crahWalls: rowEndWalls(orientation) };
      const rep = regenerateCoolingReport(project, hall.id, opts);
      return rep.requiresRegenerate ? project : keepBudgetsFitted(project, rep.project, hall.id);
    }
  }
}

const PRIORITY: RemedyKind[][] = [['cooling-units', 'regenerate-hall'], ['hall-budget', 'budget-utility', 'utility-feeds','tcs-supply', 'supply-air', 'ups-auto', 'single-mode']];

/**
 * Apply every safe remedy (or those passing `filter`), in priority rounds — cooling units / regeneration first, capacities after the loads
 * they change have been re-analysed. At most `maxRounds` analyses. Pure.
 */
export function fixAllRemedies(project: Project, opts: { filter?: (r: IssueRemedy) => boolean; analysis?: ProjectAnalysis; maxRounds?: number } = {}): { project: Project; applied: IssueRemedy[]; analysis: ProjectAnalysis } {
  const accept = opts.filter ?? ((r: IssueRemedy) => r.safe);
  let p = project;
  let a = opts.analysis ?? analyzeProject(p);
  const applied: IssueRemedy[] = [];
  for (let round = 0; round < (opts.maxRounds ?? 4); round++) {
    const rems = remediesFor(p, a).filter(accept);
    const group = PRIORITY.map((kinds) => rems.filter((r) => kinds.includes(r.kind))).find((g) => g.length);
    if (!group) break;
    const seen = new Set<string>();
    let changed = false;
    for (const r of group) {
      if (seen.has(r.key)) continue;
      seen.add(r.key);
      const next = applyRemedy(p, r);
      if (next !== p) {
        p = next;
        applied.push(r);
        changed = true;
      }
    }
    if (!changed) break;
    a = analyzeProject(p);
  }
  return { project: p, applied, analysis: a };
}
