// Cooling-equipment placement — "regenerate cooling only" (stream T1, DECISIONS-v2-2 F8, r2-layout.md §3).
//
// T4 (cooling panel) calls `regenerateCooling(project, hallId, opts)` through its contract signature; `regenerateCoolingReport`
// returns the same project plus the issues / counts / secondary-loop lengths behind it.
//
// Behaviour (hall `hallId` only; every other item keeps its id and position unless a centre slot needs rows to shift):
//   1. every CDU / CRAH / fan wall of the hall is removed;
//   2. CDUs per pod: `cduPerPod` 'auto' = ceil(pod liquid kW / CDU kW) + redundancy (the cooling engine's own rule,
//      engines/context.ts unitsFor) — manual = the number given;
//      'row-ends'    split per row, ⌈n/2⌉ before the first rack and the rest after the last rack of the row;
//      'ends-center' ⌈n/3⌉ at the start, the centre share between the two compute-rack halves, the rest at the end (single-row vendor sample,
//                    estimate). The engine opens a dedicated equipment slot by shifting every row of the same pod column; when that would
//                    overlap anything or narrow an aisle below min(transport aisle, what it was) the centre units go to the row
//                    ends instead and a `layout-cooling-center-nofit-*` issue explains the missing length;
//      'gallery'     a strip against `cduGalleryWall` (default: the first row-end wall), groups of ≤ 2 pods centred on their pods,
//                    N+redundancy per group (r2-layout.md R-C2, estimate); the secondary-loop route of every pod is reported
//                    against the hydraulic budget (80 m equivalent, warning above 60 m — r2-layout.md §3.3, derived);
//   3. CRAHs: `crahCount` 'auto' = the cooling engine's `crahsRequired` for the hall; perimeter / gallery-fan-wall on `crahWalls`
//      (default the row-end walls; N/S/W/E are added when the walls cannot hold the count, as the generator does); per-pod = row
//      ends; in-row = centre slots (same shift rule as above);
//   4. units that cannot be placed without regenerating racks are not placed and raise an error issue (never silent);
//   5. trays / busways of the hall are rebuilt from the rows when the hall had them; `hall.coolingPlacement = opts`.
// `project.cooling` (catalog ids, redundancy defaults) is not modified.
import { applyHallLayout, growHallToFit, layoutOptionsFromProject } from './fit.ts';
import { catalogItems, findCatalogItem, getCatalogItem } from '../catalog/catalog.ts';
import { effectiveStandardsProfile } from '../standards/profile.ts';
import { analyzeCooling } from '../engines/index.ts';
import { footprintRect, footprintSize, rectsOverlap, round6 } from '../model/geometry.ts';
import type { CatalogItem, CoolingPlacementOptions, EquipmentInstance, Hall, Issue, Project, Rect, RowGroup } from '../model/types.ts';
import { airHeatKW, liquidHeatKW, redundantCount } from './estimates.ts';
import { CORRIDOR_DEFAULTS, crahPodEdgeIssue, crahPodEdgeLine, GALLERY_SERVICE_M, keepoutBlockRect, placeCrahs, placeWallUnits, rackHeightOf, rowUnitOverheadIssue, type Wall, type WallUnitGroup } from './generate.ts';
import { rowEndWalls, type SourcedValue } from './grid.ts';
import { buildBusways, buildTrays, rowGroupsFromEquipment } from './rows.ts';

export const DEFAULT_COOLING_PLACEMENT: CoolingPlacementOptions = {
  cduPerPod: 'auto',
  cduPlacement: 'row-ends',
  crahCount: 'auto',
  crahStrategy: 'perimeter',
};

/** Secondary-loop (TCS) hydraulic budget: full-flow-equivalent route length. */
export const TCS_LOOP_BUDGET_M: SourcedValue = {
  value: 80,
  sourceType: 'derived',
  citation: 'AIDC Studio derivation — 2.3 MW gallery CDU, 6" Sch10S header, 1.5 LPM/kW (derived estimate), 38 psi head (Motivair MCDU-70 proxy) − 18.4 psi rack ΔP (Lenovo GB300 Table 27) − 8 psi misc (estimate) ≈ 80 m',
};
/** Warning threshold for the equivalent route (derived-conservative, r2-layout.md R-C5). */
export const TCS_LOOP_WARN_M: SourcedValue = { value: 60, sourceType: 'derived', citation: 'AIDC Studio rule (derived-conservative warning below the 80 m budget)' };
/** Pods served by one gallery CDU group (r2-layout.md R-C2; estimate). */
export const GALLERY_GROUP_PODS: SourcedValue = { value: 2, sourceType: 'estimate', citation: 'AIDC Studio rule — gallery group serving ≤ 2 pods (estimate)' };

/** Effective cooling-placement options of a hall (stored value, else defaults seeded from the layout policy). */
export function coolingPlacementFor(hall: Hall): CoolingPlacementOptions {
  if (hall.coolingPlacement) return hall.coolingPlacement;
  return {
    ...DEFAULT_COOLING_PLACEMENT,
    crahStrategy: hall.layoutPolicy?.crahStrategy ?? DEFAULT_COOLING_PLACEMENT.crahStrategy,
    ...(hall.layoutPolicy?.crahWalls ? { crahWalls: hall.layoutPolicy.crahWalls } : {}),
  };
}

export interface CoolingLoop {
  podId: string;
  cduIds: string[];
  /** CDU (group centre) → farthest row end of the pod, Manhattan (m) */
  trunkM: number;
  /** longest row of the pod (distribution header, counted at 1/3 for uniform take-offs) */
  headerM: number;
  equivalentM: number;
  status: 'ok' | 'warn' | 'over';
}

export interface CoolingPlacementReport {
  project: Project;
  issues: Issue[];
  cdu: { placement: CoolingPlacementOptions['cduPlacement']; required: number; placed: number; perPod: { podId: string; liquidKW: number; required: number; placed: number }[]; galleryWall?: Wall };
  crah: { strategy: CoolingPlacementOptions['crahStrategy']; required: number; placed: number; walls: Wall[] };
  loops: CoolingLoop[];
  /** row ids whose racks moved to open a centre slot */
  shiftedRows: string[];
  /** backlog T1a item 7 (stream C): the row that lacks the most row units when cooling-only regeneration is refused — the extension it needs, the
   *  free distance beyond its end and what blocks it (the hall wall, or equipment / keep-outs) */
  rowExtension?: { rowId: string; units: number; unitsM: number; aisleM: number; freeM: number; blocker: 'wall' | 'equipment' };
  /** fix v2 2차 (QA): the strategy cannot place the required units without regenerating racks — `project` is the unchanged input;
   *  regenerate the hall with this placement instead (regenerateHallWithCooling) */
  requiresRegenerate?: boolean;
}

const COOLING_CATS = new Set(['cdu', 'crah', 'fan-wall']);
const isComputePod = (podId?: string) => !!podId && !podId.startsWith('pod-services') && !podId.startsWith('pod-network-core');
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Secondary-loop routes of every pod of `hallId` from the CDUs that serve it (in-row: same pod; gallery: meta.pods). */
export function coolingLoopsFor(project: Project, hallId: string): CoolingLoop[] {
  const eq = project.equipment.filter((e) => e.hallId === hallId);
  const cdus = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'cdu');
  if (!cdus.length) return [];
  const rows = rowGroupsFromEquipment(hallId, eq.filter((e) => findCatalogItem(e.catalogId)?.category !== 'cdu')).filter((r) => isComputePod(r.podId));
  const byPod = new Map<string, RowGroup[]>();
  for (const r of rows) byPod.set(r.podId!, [...(byPod.get(r.podId!) ?? []), r]);
  const out: CoolingLoop[] = [];
  for (const [podId, prs] of [...byPod].sort((a, b) => a[0].localeCompare(b[0]))) {
    const serving = cdus.filter((c) => c.podId === podId || String(c.meta?.pods ?? '').split(',').includes(podId));
    if (!serving.length) continue;
    const gallery = serving.some((c) => c.meta?.gallery === true);
    const header = Math.max(...prs.map((r) => r.a1 - r.a0));
    let trunk = 0;
    if (gallery) {
      const cx = serving.reduce((a, c) => a + c.position.x, 0) / serving.length;
      const cy = serving.reduce((a, c) => a + c.position.y, 0) / serving.length;
      for (const r of prs) {
        const ends = [r.a0, r.a1].map((a) => (r.axis === 'x' ? { x: a, y: r.center } : { x: r.center, y: a }));
        trunk = Math.max(trunk, Math.min(...ends.map((p) => Math.abs(p.x - cx) + Math.abs(p.y - cy))));
      }
    }
    const equivalent = trunk + header / 3;
    out.push({ podId, cduIds: serving.map((c) => c.id), trunkM: round6(trunk), headerM: round6(header), equivalentM: round6(equivalent), status: equivalent > TCS_LOOP_BUDGET_M.value ? 'over' : equivalent > TCS_LOOP_WARN_M.value ? 'warn' : 'ok' });
  }
  return out;
}

/** Issues for secondary loops beyond the warning threshold / the budget (validate.ts and the report use the same rule). */
export function coolingLoopIssues(hall: Hall, loops: readonly CoolingLoop[]): Issue[] {
  return loops
    .filter((l) => l.status !== 'ok')
    .map((l) => ({
      id: `layout-cooling-loop-${l.podId}`,
      severity: l.status === 'over' ? ('error' as const) : ('warning' as const),
      domain: 'layout' as const,
      message: `${hall.name}: ${l.podId} 2차 냉각 루프 등가 경로 ${l.equivalentM.toFixed(1)} m (트렁크 ${l.trunkM.toFixed(1)} m + 헤더 ${l.headerM.toFixed(1)} m/3) — ${l.status === 'over' ? `수력 예산 ${TCS_LOOP_BUDGET_M.value} m 초과` : `경고 기준 ${TCS_LOOP_WARN_M.value} m 초과`} (유도값)`,
      messageEn: `${hall.name}: ${l.podId} secondary loop equivalent route ${l.equivalentM.toFixed(1)} m (trunk ${l.trunkM.toFixed(1)} m + header ${l.headerM.toFixed(1)} m / 3) — ${l.status === 'over' ? `beyond the ${TCS_LOOP_BUDGET_M.value} m hydraulic budget` : `above the ${TCS_LOOP_WARN_M.value} m warning`} (derived)`,
      refs: [hall.id, ...l.cduIds.slice(0, 3)],
      suggestion: 'CDU를 포드 가까이(열 끝 / 끝+중앙) 두거나 갤러리 그룹을 포드 옆 벽으로 옮기고, 헤더 관경·펌프 양정을 확인하세요.',
      suggestionEn: 'Move the CDUs closer to the pod (row ends / ends + centre) or the gallery group to the nearer wall, and check header size and pump head.',
    }));
}

interface Unit {
  item: CatalogItem;
  kind: 'cdu' | 'crah';
}

interface RowPlan {
  row: RowGroup;
  members: EquipmentInstance[];
  rot: EquipmentInstance['rotationDeg'];
  prefix: string;
  podId?: string;
  waveId?: string;
  start: Unit[];
  center: Unit[];
  end: Unit[];
}

/**
 * Regenerate the cooling units of one hall and report what happened. Pure: returns a new project (the input is never mutated).
 */
export function regenerateCoolingReport(project: Project, hallId: string, opts: CoolingPlacementOptions): CoolingPlacementReport {
  const empty: CoolingPlacementReport = { project, issues: [], cdu: { placement: opts.cduPlacement, required: 0, placed: 0, perPod: [] }, crah: { strategy: opts.crahStrategy, required: 0, placed: 0, walls: [] }, loops: [], shiftedRows: [] };
  if (!project.halls.some((h) => h.id === hallId)) return empty;
  const d: Project = structuredClone(project);
  const hall = d.halls.find((h) => h.id === hallId)!;
  const issues: Issue[] = [];
  const catOf = (e: EquipmentInstance) => findCatalogItem(e.catalogId)?.category ?? '';
  const hallEq = d.equipment.filter((e) => e.hallId === hallId);
  const removed = hallEq.filter((e) => COOLING_CATS.has(catOf(e)));
  const removedIds = new Set(removed.map((e) => e.id));
  const keep = hallEq.filter((e) => !removedIds.has(e.id));
  const others = d.equipment.filter((e) => e.hallId !== hallId);
  const oldIdByTag = new Map(removed.map((e) => [e.tag, e.id]));
  const taken = new Set([...others, ...keep].map((e) => e.id));
  const idFor = (tag: string) => {
    const old = oldIdByTag.get(tag);
    let id = old && !taken.has(old) ? old : `eq-${tag.toLowerCase()}`;
    if (taken.has(id)) id = `${id}-${hallId}`;
    for (let k = 2; taken.has(id); k++) id = `eq-${tag.toLowerCase()}-${hallId}-${k}`;
    taken.add(id);
    return id;
  };

  const cdu = findCatalogItem(d.cooling.cduCatalogId) ?? removed.map((e) => findCatalogItem(e.catalogId)).find((i) => i?.category === 'cdu') ?? defaultCoolingItem('cdu', { cduClass: effectiveStandardsProfile(d, hall)?.liquid.cduClass })!;
  // polish v2 2차: opts.crahCatalogId places the compared unit (fan wall vs CRAH); unknown / non-air-unit ids fall back to the project default
  const chosenCrah = opts.crahCatalogId ? findCatalogItem(opts.crahCatalogId) : undefined;
  const crah = (chosenCrah && (chosenCrah.category === 'crah' || chosenCrah.category === 'fan-wall') ? chosenCrah : undefined) ?? findCatalogItem(d.cooling.crahCatalogId) ?? removed.map((e) => findCatalogItem(e.catalogId)).find((i) => i?.category === 'crah' || i?.category === 'fan-wall') ?? defaultCoolingItem('crah')!;
  const corridors = hall.layoutPolicy?.corridors ?? CORRIDOR_DEFAULTS;
  const cduRed = opts.cduRedundancy ?? d.cooling.cduRedundancy;

  // ── rows, pods, dominant axis ──
  const rows = rowGroupsFromEquipment(hallId, keep);
  const rowsBefore = new Map(rowGroupsFromEquipment(hallId, hallEq).map((r) => [r.id, r]));
  const byId = new Map(keep.map((e) => [e.id, e]));
  const computeRows = rows.filter((r) => isComputePod(r.podId) && r.memberIds.some((id) => catOf(byId.get(id)!) === 'gpu-rack'));
  const podRows = new Map<string, RowGroup[]>();
  for (const r of computeRows) podRows.set(r.podId!, [...(podRows.get(r.podId!) ?? []), r]);
  const pods = [...podRows.keys()].sort();
  const axisCount = { x: 0, y: 0 };
  for (const r of rows) axisCount[r.axis] += r.memberIds.length;
  const axis: 'x' | 'y' = axisCount.x || axisCount.y ? (axisCount.x >= axisCount.y ? 'x' : 'y') : (hall.layoutPolicy?.orientation ?? 'x');
  const fpOf = (e: EquipmentInstance): Rect | null => {
    const it = findCatalogItem(e.catalogId);
    return it ? footprintRect(it.dims, e.position, e.rotationDeg) : null;
  };

  // margin: distance of the old wall units from their wall (generator default 1 m)
  const wallUnits = removed.filter((e) => !e.rowId && catOf(e) !== 'cdu');
  let margin = 1;
  if (wallUnits.length) {
    const dist = wallUnits.map((e) => {
      const r = fpOf(e)!;
      return Math.min(r.x, r.y, hall.width - (r.x + r.w), hall.depth - (r.y + r.d));
    });
    margin = Math.min(3, Math.max(0.3, Math.min(...dist)));
  }

  // ── CRAH requirement (cooling engine) ──
  const crahRequired = (() => {
    if (opts.crahCount !== 'auto') return Math.max(0, Math.round(opts.crahCount));
    const scratch: Project = { ...d, equipment: [...others, ...keep, ...removed.filter((e) => catOf(e) === 'cdu')], trays: undefined, busways: undefined, cooling: { ...d.cooling, crahCatalogId: crah.id, ...(opts.crahRedundancy ? { crahRedundancy: opts.crahRedundancy as Project['cooling']['crahRedundancy'] } : {}) } };
    try {
      const ch = analyzeCooling(scratch).perHall?.find((h) => h.hallId === hallId);
      if (ch) return ch.crahsRequired;
    } catch {
      /* fall through to the estimate */
    }
    const air = keep.reduce((a, e) => a + (findCatalogItem(e.catalogId) ? airHeatKW(findCatalogItem(e.catalogId)!) : 0), 0);
    return air > 0 ? redundantCount(Math.ceil(air / (crah.capacity?.coolingKW ?? 100) - 1e-9), opts.crahRedundancy ?? d.cooling.crahRedundancy) : 0;
  })();

  // ── per-row plans ──
  const plans: RowPlan[] = computeRows.map((row) => {
    const members = row.memberIds.map((id) => byId.get(id)!).filter(Boolean);
    const gpu = members.find((m) => catOf(m) === 'gpu-rack') ?? members[0];
    const tag = gpu.tag;
    return { row, members, rot: gpu.rotationDeg, prefix: tag.includes('-') ? tag.slice(0, tag.lastIndexOf('-')) : tag, podId: gpu.podId, waveId: gpu.waveId, start: [], center: [], end: [] };
  });
  const planOf = new Map(plans.map((p) => [p.row.id, p]));
  const perPod: CoolingPlacementReport['cdu']['perPod'] = [];
  const cap = cdu.capacity?.coolingKW ?? 0;
  const liquidOfRows = (prs: RowGroup[]) => prs.reduce((a, r) => a + r.memberIds.reduce((b, id) => b + liquidHeatKW(getCatalogItem(byId.get(id)!.catalogId)), 0), 0);
  const countFor = (liquid: number, podsN: number) => (opts.cduPerPod === 'auto' ? (liquid > 0 && cap > 0 ? redundantCount(Math.ceil(liquid / cap - 1e-9), cduRed) : 0) : Math.max(0, Math.round(opts.cduPerPod)) * podsN);
  if (opts.cduPlacement !== 'gallery') {
    for (const podId of pods) {
      const prs = [...podRows.get(podId)!].sort((a, b) => a.id.localeCompare(b.id));
      const liquid = liquidOfRows(prs);
      const n = countFor(liquid, 1);
      perPod.push({ podId, liquidKW: round6(liquid), required: n, placed: 0 });
      prs.forEach((r, ri) => {
        const nRow = Math.floor(n / prs.length) + (ri < n % prs.length ? 1 : 0);
        const p = planOf.get(r.id)!;
        const units = (k: number): Unit[] => Array.from({ length: k }, () => ({ item: cdu, kind: 'cdu' as const }));
        if (opts.cduPlacement === 'ends-center') {
          const s0 = Math.ceil(nRow / 3);
          const c0 = Math.ceil((nRow - s0) / 2);
          p.start.push(...units(s0));
          p.center.push(...units(c0));
          p.end.push(...units(nRow - s0 - c0));
        } else {
          const s0 = Math.ceil(nRow / 2);
          p.start.push(...units(s0));
          p.end.push(...units(nRow - s0));
        }
      });
    }
  }
  const rowCrahStrategy = opts.crahStrategy === 'per-pod' || opts.crahStrategy === 'in-row';
  if (rowCrahStrategy && crahRequired > 0 && plans.length) {
    const perRow = Math.ceil(crahRequired / plans.length);
    let left = crahRequired;
    for (const p of plans) {
      const k = Math.min(perRow, left);
      left -= k;
      (opts.crahStrategy === 'in-row' ? p.center : p.end).push(...Array.from({ length: k }, () => ({ item: crah, kind: 'crah' as const })));
    }
    // backlog finish: a room air unit in the rows reaches into the overhead services (warning; also raised by generateHallLayout)
    const overhead = rowUnitOverheadIssue(hall, crah, rackHeightOf(keep), opts.crahStrategy as 'per-pod' | 'in-row');
    if (overhead) issues.push(overhead);
  }

  // ── blockers ──
  const keepRects = new Map<string, Rect>();
  for (const e of keep) {
    const r = fpOf(e);
    if (r) keepRects.set(e.id, r);
  }
  const hallContainments = d.containments.filter((c) => c.hallId === hallId);
  const keepoutRects = hall.keepouts.map((k) => keepoutBlockRect(k));
  const partitionRects = (d.reservations ?? []).filter((r) => r.hallId === hallId && r.kind === 'room-partition').map((r) => r.rect);
  const placedRects: Rect[] = [];
  const along = (u: Unit, rot: number) => {
    const { sx, sy } = footprintSize(u.item.dims, rot);
    return axis === 'x' ? sx : sy;
  };
  const inside = (r: Rect) => r.x >= 0.05 - 1e-6 && r.y >= 0.05 - 1e-6 && r.x + r.w <= hall.width - 0.05 + 1e-6 && r.y + r.d <= hall.depth - 0.05 + 1e-6;
  const rowRect = (p: RowPlan, a0: number, a1: number): Rect => {
    const depth = Math.max(...p.members.map((m) => (keepRects.get(m.id) ? (axis === 'x' ? keepRects.get(m.id)!.d : keepRects.get(m.id)!.w) : 1.2)));
    return axis === 'x' ? { x: a0, y: p.row.center - depth / 2, w: a1 - a0, d: depth } : { x: p.row.center - depth / 2, y: a0, w: depth, d: a1 - a0 };
  };
  /** free distance from `from` along ±axis inside the row band to the nearest blocker not in `excl`, or to the hall wall */
  const clearInfo = (p: RowPlan, from: number, dir: 1 | -1, excl: Set<string>): { dist: number; wall: boolean } => {
    const band = rowRect(p, from - 0.001, from + 0.001);
    const wallDist = dir === 1 ? (axis === 'x' ? hall.width : hall.depth) - from : from;
    let best = wallDist;
    const consider = (r: Rect) => {
      const perpOverlap = axis === 'x' ? r.y < band.y + band.d - 1e-3 && r.y + r.d > band.y + 1e-3 : r.x < band.x + band.w - 1e-3 && r.x + r.w > band.x + 1e-3;
      if (!perpOverlap) return;
      const lo = axis === 'x' ? r.x : r.y;
      const hi = axis === 'x' ? r.x + r.w : r.y + r.d;
      if (dir === 1 && lo >= from - 1e-6) best = Math.min(best, lo - from);
      if (dir === -1 && hi <= from + 1e-6) best = Math.min(best, from - hi);
    };
    for (const [id, r] of keepRects) if (!excl.has(id)) consider(r);
    for (const r of [...keepoutRects, ...placedRects, ...partitionRects]) consider(r);
    return { dist: best, wall: best >= wallDist - 1e-6 };
  };
  const clearAlong = (p: RowPlan, from: number, dir: 1 | -1, excl: Set<string>) => clearInfo(p, from, dir, excl).dist;
  /** aisle to keep beyond a row end: the transport aisle between rows / columns, the egress aisle against the hall wall (DECISIONS-v2 #3), never more than what was there */
  const aisleReq = (p: RowPlan, from: number, dir: 1 | -1, excl: Set<string>) => {
    const c = clearInfo(p, from, dir, excl);
    return Math.min(c.wall ? corridors.egressM : corridors.transportM, c.dist);
  };
  const blockedRect = (r: Rect, excl: Set<string>) => {
    if (!inside(r)) return true;
    for (const [id, k] of keepRects) if (!excl.has(id) && rectsOverlap(r, k)) return true;
    return [...keepoutRects, ...placedRects, ...partitionRects].some((k) => rectsOverlap(r, k)) || hallContainments.some((c) => rectsOverlap(r, c.rect));
  };
  const extent = (p: RowPlan) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of p.members) {
      const r = keepRects.get(m.id);
      if (!r) continue;
      lo = Math.min(lo, axis === 'x' ? r.x : r.y);
      hi = Math.max(hi, axis === 'x' ? r.x + r.w : r.y + r.d);
    }
    return { lo, hi };
  };

  // ── centre slots: shift the second half of every row in a pod column by the same distance ──
  const shiftedRows: string[] = [];
  const clusters = new Map<string, RowPlan[]>();
  for (const p of plans) if (p.center.length) clusters.set(String(Math.round(extent(p).lo / 0.3)), [...(clusters.get(String(Math.round(extent(p).lo / 0.3))) ?? []), p]);
  const splitOf = new Map<string, { at: number; gapLo: number; gapHi: number; after: EquipmentInstance[] }>();
  for (const [key, cps] of [...clusters].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    let shift = 0;
    for (const p of cps) {
      const iv = p.members.map((m) => ({ m, r: keepRects.get(m.id)! })).filter((x) => x.r).map((x) => ({ m: x.m, lo: axis === 'x' ? x.r.x : x.r.y, hi: axis === 'x' ? x.r.x + x.r.w : x.r.y + x.r.d })).sort((a, b) => a.lo - b.lo);
      // The removed template-level centre gap must not determine this position. A centre CDU is explicit equipment, so split the
      // compute run itself. End network/service racks do not move the split away from GPU 06/07 in a 12-rack row.
      const compute = iv.filter((x) => catOf(x.m) === 'gpu-rack');
      const right = compute[Math.floor(compute.length / 2)];
      let bi = right ? iv.findIndex((x) => x.m.id === right.m.id) - 1 : Math.floor(iv.length / 2) - 1;
      if (bi < -1) bi = -1;
      const gapLo = bi >= 0 ? iv[bi].hi : extent(p).lo;
      const gapHi = iv[bi + 1]?.lo ?? gapLo;
      splitOf.set(p.row.id, { at: gapHi, gapLo, gapHi, after: iv.slice(bi + 1).map((x) => x.m) });
      const need = p.center.reduce((a, u) => a + along(u, p.rot), 0);
      shift = Math.max(shift, need - Math.max(0, gapHi - gapLo));
    }
    shift = round6(Math.max(0, shift));
    if (shift <= 1e-6) continue;
    // tentative shift: moved racks + end units must stay clear of everything else and keep the aisle beyond the row end
    const excl = new Set(cps.flatMap((p) => p.members.map((m) => m.id)));
    let ok = true;
    let limit = Infinity;
    for (const p of cps) {
      const sp = splitOf.get(p.row.id)!;
      for (const m of sp.after) {
        const r = keepRects.get(m.id)!;
        const moved = axis === 'x' ? { ...r, x: r.x + shift } : { ...r, y: r.y + shift };
        if (blockedRect(moved, excl)) ok = false;
      }
      const before = rowsBefore.get(p.row.id);
      const { hi } = extent(p);
      const endLen = p.end.reduce((a, u) => a + along(u, p.rot), 0);
      const origEnd = Math.max(hi, before?.a1 ?? hi);
      const required = aisleReq(p, origEnd, 1, excl);
      const avail = clearAlong(p, hi, 1, excl);
      limit = Math.min(limit, avail - endLen - required);
      if (hi + shift + endLen + required > hi + avail + 1e-6) ok = false;
    }
    if (!ok) {
      for (const p of cps) {
        p.end.push(...p.center.filter((_, i) => i % 2 === 1));
        p.start.push(...p.center.filter((_, i) => i % 2 === 0));
        p.center = [];
      }
      issues.push({
        id: `layout-cooling-center-nofit-${hallId}-${key}`,
        severity: 'warning',
        domain: 'layout',
        message: `${hall.name}: 열 중앙 냉각 슬롯에 ${shift.toFixed(2)} m가 필요하지만 랙을 다시 배치하지 않고는 통로(${Math.max(0, limit).toFixed(2)} m 여유)를 줄일 수 없어 해당 유닛을 열 끝에 두었습니다 (${cps.map((p) => p.row.id).join(', ')}).`,
        messageEn: `${hall.name}: a centre cooling slot needs ${shift.toFixed(2)} m, but the rows cannot grow without regenerating racks (${Math.max(0, limit).toFixed(2)} m to spare before the aisle beyond the row end); those units were placed at the row ends (${cps.map((p) => p.row.id).join(', ')}).`,
        refs: [hallId, ...cps.slice(0, 3).map((p) => p.row.id)],
        suggestion: '배치 패널에서 홀을 다시 생성하면 CDU 끝+중앙 슬롯이 열 길이에 포함됩니다.',
        suggestionEn: 'Regenerate the hall in the layout panel: the generator then includes the ends + centre slots in the row length.',
      });
      continue;
    }
    // apply the shift: racks after the split, the pods' containments, and the recorded row extents
    const podsShifted = new Set<string>();
    for (const p of cps) {
      const sp = splitOf.get(p.row.id)!;
      for (const m of sp.after) {
        if (axis === 'x') m.position.x = round6(m.position.x + shift);
        else m.position.y = round6(m.position.y + shift);
        keepRects.set(m.id, fpOf(m)!);
      }
      sp.gapHi += shift;
      if (p.podId) podsShifted.add(p.podId);
      shiftedRows.push(p.row.id);
    }
    for (const c of hallContainments) {
      if (!c.podId || !podsShifted.has(c.podId)) continue;
      if (axis === 'x') c.rect = { ...c.rect, w: round6(c.rect.w + shift) };
      else c.rect = { ...c.rect, d: round6(c.rect.d + shift) };
    }
  }

  // ── place row units ──
  const out: EquipmentInstance[] = [];
  const placeUnit = (p: RowPlan, u: Unit, a: number, tag: string): boolean => {
    const pos = axis === 'x' ? { x: round6(a), y: p.row.center } : { x: p.row.center, y: round6(a) };
    const rect = footprintRect(u.item.dims, pos, p.rot);
    if (blockedRect(rect, new Set())) return false;
    placedRects.push(rect);
    out.push({ id: idFor(tag), catalogId: u.item.id, hallId, tag, position: pos, rotationDeg: p.rot, podId: p.podId, rowId: p.row.id, waveId: p.waveId, blanking: true });
    return true;
  };
  let cduPlaced = 0;
  let rowCrahPlaced = 0;
  const unplaced: string[] = [];
  const rowShort = new Map<string, { plan: RowPlan; units: number; widthM: number }>();
  const podPlaced = new Map<string, number>();
  for (const p of plans) {
    const { lo, hi } = extent(p);
    const excl = new Set(p.members.map((m) => m.id));
    const origLo = Math.min(lo, rowsBefore.get(p.row.id)?.a0 ?? lo);
    const origHi = Math.max(hi, rowsBefore.get(p.row.id)?.a1 ?? hi);
    const startReq = aisleReq(p, origLo, -1, excl);
    const endReq = aisleReq(p, origHi, 1, excl);
    let cduNo = 0;
    let crahNo = 0;
    const tagOf = (u: Unit) => (u.kind === 'cdu' ? `${p.prefix}-CDU${++cduNo}` : `${p.prefix}-CRAH${++crahNo}`);
    const count = (u: Unit, ok: boolean) => {
      if (!ok) {
        unplaced.push(`${p.row.id}:${u.kind}`);
        if (u.kind !== 'cdu') {
          const sh = rowShort.get(p.row.id) ?? { plan: p, units: 0, widthM: 0 };
          sh.units++;
          sh.widthM += along(u, p.rot);
          rowShort.set(p.row.id, sh);
        }
        return;
      }
      if (u.kind === 'cdu') {
        cduPlaced++;
        if (p.podId) podPlaced.set(p.podId, (podPlaced.get(p.podId) ?? 0) + 1);
      } else rowCrahPlaced++;
    };
    // start side: outward from the first rack (the aisle before the row stays ≥ min(transport, what it was))
    let a = lo;
    const startUnits = [...p.start];
    const endUnits = [...p.end];
    const startLen = startUnits.reduce((s, u) => s + along(u, p.rot), 0);
    if (startLen > 0 && lo - startLen - startReq < lo - clearAlong(p, lo, -1, excl) - 1e-6) {
      // not enough room before the row: move what does not fit to the end
      while (startUnits.length && lo - startUnits.reduce((s, u) => s + along(u, p.rot), 0) - startReq < lo - clearAlong(p, lo, -1, excl) - 1e-6) endUnits.push(startUnits.pop()!);
    }
    for (const u of startUnits) {
      const w = along(u, p.rot);
      a -= w;
      count(u, placeUnit(p, u, a + w / 2, tagOf(u)));
    }
    // centre slot
    const sp = splitOf.get(p.row.id);
    if (p.center.length && sp) {
      const need = p.center.reduce((s, u) => s + along(u, p.rot), 0);
      let c = (sp.gapLo + sp.gapHi) / 2 - need / 2;
      for (const u of p.center) {
        const w = along(u, p.rot);
        count(u, placeUnit(p, u, c + w / 2, tagOf(u)));
        c += w;
      }
    }
    // end side
    const { hi: hi2 } = extent(p);
    a = hi2;
    for (const u of endUnits) {
      const w = along(u, p.rot);
      const room = clearAlong(p, a, 1, excl);
      const okRoom = w + endReq <= room + 1e-6 || room >= w + 1e-6 && endReq <= 1e-6;
      count(u, okRoom && placeUnit(p, u, a + w / 2, tagOf(u)));
      a += w;
    }
  }
  const cduRequiredRows = perPod.reduce((s, x) => s + x.required, 0);
  for (const x of perPod) x.placed = podPlaced.get(x.podId) ?? 0;

  // ── gallery CDUs ──
  let galleryWall: Wall | undefined;
  let galleryRequired = 0;
  const galleryRects: Rect[] = [];
  if (opts.cduPlacement === 'gallery' && pods.length) {
    const rowEnd = rowEndWalls(axis);
    galleryWall = (opts.cduGalleryWall as Wall | undefined) ?? ((opts.crahWalls ?? []) as Wall[]).find((w) => rowEnd.includes(w)) ?? rowEnd[0];
    const wallAxis: 'x' | 'y' = galleryWall === 'W' || galleryWall === 'E' ? 'y' : 'x';
    const podCentre = (podId: string) => {
      const prs = podRows.get(podId)!;
      const vals = prs.flatMap((r) => (wallAxis === (r.axis === 'x' ? 'y' : 'x') ? [r.center] : [(r.a0 + r.a1) / 2]));
      return vals.reduce((a, v) => a + v, 0) / vals.length;
    };
    const ordered = [...pods].sort((p, q) => podCentre(p) - podCentre(q) || p.localeCompare(q));
    const groups: WallUnitGroup[] = [];
    const per = GALLERY_GROUP_PODS.value;
    for (let g = 0; g < ordered.length; g += per) {
      const members = ordered.slice(g, g + per);
      const liquid = liquidOfRows(members.flatMap((m) => podRows.get(m)!));
      for (const m of members) perPod.push({ podId: m, liquidKW: round6(liquidOfRows(podRows.get(m)!)), required: 0, placed: 0 });
      const count = countFor(liquid, members.length);
      galleryRequired += count;
      const firstRow = podRows.get(members[0])![0];
      const wave = byId.get(firstRow.memberIds[0])?.waveId;
      groups.push({ count, target: members.reduce((a, m) => a + podCentre(m), 0) / members.length, extra: { waveId: wave ?? 'wave-01', meta: { gallery: true, group: `G${pad(g / per + 1)}`, pods: members.join(',') } } });
    }
    const strip: Rect = galleryWall === 'W' ? { x: 0, y: 0, w: margin + cdu.dims.d + 0.01, d: hall.depth } : galleryWall === 'E' ? { x: hall.width - margin - cdu.dims.d - 0.01, y: 0, w: margin + cdu.dims.d, d: hall.depth } : galleryWall === 'S' ? { x: 0, y: 0, w: hall.width, d: margin + cdu.dims.d + 0.01 } : { x: 0, y: hall.depth - margin - cdu.dims.d - 0.01, w: hall.width, d: margin + cdu.dims.d };
    const near = [...keepRects.values(), ...keepoutRects, ...placedRects, ...hallContainments.map((c) => c.rect)].filter((r) => rectsOverlap(r, strip));
    const placed = placeWallUnits(out, hall, cdu, groups, galleryWall, { width: hall.width, depth: hall.depth, marginM: margin, blockers: near, tag: (k) => `CDU-G${galleryWall}${pad(k)}`, idOf: idFor });
    const n = placed.reduce((a, g) => a + g.length, 0);
    cduPlaced += n;
    for (const g of placed) for (const e of g) galleryRects.push(footprintRect(cdu.dims, e.position, e.rotationDeg));
    if (n < galleryRequired)
      issues.push({
        id: `layout-cdu-gallery-short-${hallId}`,
        severity: 'error',
        domain: 'layout',
        message: `${hall.name}: 기계 갤러리(${galleryWall} 벽)에 CDU ${galleryRequired}대 중 ${n}대만 들어갑니다 — 벽을 따라 랙·컨테인먼트·keepout이 막고 있습니다.`,
        messageEn: `${hall.name}: only ${n} of ${galleryRequired} CDUs fit the mechanical gallery on the ${galleryWall} wall — racks, containment or keepouts block the strip.`,
        refs: [hallId],
        suggestion: '배치 패널에서 홀을 다시 생성하면 갤러리 폭(CDU 깊이 + 1.2 m)이 확보됩니다. 또는 열 끝 / 끝+중앙을 선택하세요.',
        suggestionEn: 'Regenerate the hall in the layout panel (the generator reserves a gallery strip of CDU depth + 1.2 m), or choose row ends / ends + centre.',
      });
  }
  const cduRequired = opts.cduPlacement === 'gallery' ? galleryRequired : cduRequiredRows;
  if (unplaced.some((u) => u.endsWith(':cdu')) && opts.cduPlacement !== 'gallery')
    issues.push({
      id: `layout-cdu-short-${hallId}`,
      severity: 'error',
      domain: 'layout',
      message: `${hall.name}: CDU ${cduRequired}대 중 ${cduRequired - (cduPlaced)}대를 열 끝에 둘 공간이 없습니다 (${[...new Set(unplaced.filter((u) => u.endsWith(':cdu')).map((u) => u.split(':')[0]))].slice(0, 4).join(', ')}).`,
      messageEn: `${hall.name}: no room at the row ends for ${cduRequired - cduPlaced} of ${cduRequired} CDUs (${[...new Set(unplaced.filter((u) => u.endsWith(':cdu')).map((u) => u.split(':')[0]))].slice(0, 4).join(', ')}).`,
      refs: [hallId],
      suggestion: '홀을 다시 생성해 CDU 슬롯을 열 길이에 포함하거나, 기계 갤러리 배치를 선택하세요.',
      suggestionEn: 'Regenerate the hall so the CDU slots are part of the row length, or choose the mechanical gallery.',
    });

  // ── wall CRAHs ──
  let crahPlaced = rowCrahPlaced;
  let walls: Wall[] = [];
  if (!rowCrahStrategy && crahRequired > 0) {
    const requested = ((opts.crahWalls as Wall[] | undefined)?.length ? (opts.crahWalls as Wall[]) : rowEndWalls(axis)).slice();
    const rackRects = [...keepRects.values()];
    const minX = rackRects.length ? Math.min(...rackRects.map((r) => r.x)) : margin;
    const xZone = Math.max(0, minX - margin - 0.3);
    const blockers = [...rackRects, ...hallContainments.map((c) => c.rect), ...galleryRects, ...placedRects, ...partitionRects];
    const offset0 = galleryWall ? { [galleryWall]: cdu.dims.d + GALLERY_SERVICE_M } : {};
    // polish v2 2차: same pod-edge cooling line as the generator (fixed halls larger than the layout), so a cooling-only regeneration keeps positions
    const gpuRects = [...keep.filter((e) => e.rowId).map((e) => keepRects.get(e.id)), ...out.filter((e) => e.rowId).map((e) => fpOf(e) ?? undefined)].filter((r): r is Rect => !!r);
    const rowEnds = rowEndWalls(axis);
    let line: ReturnType<typeof crahPodEdgeLine> = null;
    const attempt = (ws: Wall[]) => {
      const tmp: EquipmentInstance[] = [];
      line = crahPodEdgeLine(hall, gpuRects, crah, ws.filter((w) => rowEnds.includes(w)), margin, offset0);
      const offset = { ...offset0, ...(line?.offset ?? {}) };
      const n = placeCrahs(tmp, hall, crah, crahRequired, ws, { width: hall.width, depth: hall.depth, marginM: margin, xZone, yZone: 0, podRects: blockers, keepouts: hall.keepouts, wallOffset: Object.keys(offset).length ? offset : undefined, span: line?.span });
      return { tmp, n };
    };
    walls = requested;
    let res = attempt(walls);
    for (let i = 0; i < 2 && res.n < crahRequired; i++) {
      const next = (['N', 'S', 'W', 'E'] as Wall[]).find((w) => !walls.includes(w));
      if (!next) break;
      walls = [...walls, next];
      res = attempt(walls);
    }
    for (const e of res.tmp) {
      const id = idFor(e.tag);
      out.push({ ...e, id });
    }
    crahPlaced += res.n;
    if (line) issues.push(crahPodEdgeIssue(hall, line));
    if (res.n < crahRequired)
      issues.push({
        id: `layout-crah-short-${hallId}`,
        severity: 'error',
        domain: 'layout',
        message: `${hall.name}: 필요한 CRAH ${crahRequired}대 중 ${res.n}대만 벽(${walls.join('/')})에 배치할 수 있습니다.`,
        messageEn: `${hall.name}: only ${res.n} of the ${crahRequired} required CRAH units fit on the walls (${walls.join('/')}).`,
        refs: [hallId],
        suggestion: '벽을 추가하거나 in-row / per-pod 전략, 또는 용량이 큰 CRAH 모델을 선택하세요.',
        suggestionEn: 'Add walls, or choose an in-row / per-pod strategy or a larger CRAH model.',
      });
  } else if (rowCrahStrategy && rowCrahPlaced < crahRequired) {
    // backlog T1a item 7: name the worst row, the extension it needs (units × width + the aisle kept beyond the end), the free distance and the blocker
    const worst = [...rowShort.values()].sort((x, y) => y.units - x.units || y.widthM - x.widthM || x.plan.row.id.localeCompare(y.plan.row.id))[0];
    let ext: CoolingPlacementReport['rowExtension'];
    if (worst) {
      const excl = new Set(worst.plan.members.map((m) => m.id));
      const end = extent(worst.plan).hi;
      const c = clearInfo(worst.plan, end, 1, excl);
      ext = { rowId: worst.plan.row.id, units: worst.units, unitsM: round6(worst.widthM), aisleM: c.wall ? corridors.egressM : corridors.transportM, freeM: round6(Math.max(0, c.dist)), blocker: c.wall ? 'wall' : 'equipment' };
    }
    const extKo = ext ? ` 가장 부족한 열 ${ext.rowId}: 유닛 ${ext.units}대(${ext.unitsM.toFixed(2)} m)와 통로 ${ext.aisleM.toFixed(2)} m가 더 필요하지만 열 끝에서 ${ext.blocker === 'wall' ? '홀 벽' : '인접 장비 · 금지 구역'}까지 ${ext.freeM.toFixed(2)} m만 비어 있습니다.` : '';
    const extEn = ext ? ` Worst row ${ext.rowId}: ${ext.units} more unit${ext.units === 1 ? '' : 's'} (${ext.unitsM.toFixed(2)} m) plus a ${ext.aisleM.toFixed(2)} m aisle are needed, but only ${ext.freeM.toFixed(2)} m is free beyond the row end up to the ${ext.blocker === 'wall' ? 'hall wall' : 'neighbouring equipment / keep-out'}.` : '';
    issues.push({
      id: `layout-crah-short-${hallId}`,
      severity: 'error',
      domain: 'layout',
      message: `${hall.name}: 열에 CRAH ${crahRequired}대 중 ${rowCrahPlaced}대만 배치할 수 있습니다 — 랙을 다시 배치해야 합니다 (냉각 설비만 재배치하지 않음).${extKo}`,
      messageEn: `${hall.name}: only ${rowCrahPlaced} of ${crahRequired} CRAH units fit in the existing rows — the racks must be regenerated (cooling-only regeneration not applied).${extEn}`,
      refs: [hallId],
      suggestion: '"이 배치로 홀 다시 생성"을 사용하면 생성기가 열 길이에 CRAH 슬롯을 포함합니다.',
      suggestionEn: 'Use "Regenerate hall with this placement": the generator then includes the CRAH slots in the row length.',
    });
    // fix v2 2차 (QA): per-pod / in-row placed 2 of 10–40 units on every generated hall and the panel applied it anyway — return the
    // unchanged input so a valid hall never turns invalid with one click
    return {
      project,
      issues,
      cdu: { placement: opts.cduPlacement, required: cduRequired, placed: cduPlaced, perPod, ...(galleryWall ? { galleryWall } : {}) },
      crah: { strategy: opts.crahStrategy, required: crahRequired, placed: rowCrahPlaced, walls },
      loops: coolingLoopsFor(project, hallId),
      shiftedRows: [],
      requiresRegenerate: true,
      ...(ext ? { rowExtension: ext } : {}),
    };
  }

  // ── write back ──
  d.equipment = [...others, ...keep, ...out];
  hall.coolingPlacement = structuredClone(opts);
  if ((d.trays ?? []).some((t) => t.hallId === hallId) || (d.busways ?? []).some((b) => b.hallId === hallId)) {
    const hallItems = d.equipment.filter((e) => e.hallId === hallId);
    const rows2 = rowGroupsFromEquipment(hallId, hallItems);
    if ((d.trays ?? []).some((t) => t.hallId === hallId)) d.trays = [...(d.trays ?? []).filter((t) => t.hallId !== hallId), ...buildTrays(hall, rows2, hallItems)];
    if ((d.busways ?? []).some((b) => b.hallId === hallId)) {
      const rpp = findCatalogItem(d.power.rppCatalogId);
      d.busways = [...(d.busways ?? []).filter((b) => b.hallId !== hallId), ...buildBusways(hall, rows2, hallItems, rpp?.capacity?.currentA ?? 800)];
    }
  }
  const loops = coolingLoopsFor(d, hallId);
  issues.push(...coolingLoopIssues(hall, loops));
  return {
    project: d,
    issues,
    cdu: { placement: opts.cduPlacement, required: cduRequired, placed: cduPlaced, perPod, ...(galleryWall ? { galleryWall } : {}) },
    crah: { strategy: opts.crahStrategy, required: crahRequired, placed: crahPlaced, walls },
    loops,
    shiftedRows,
  };
}

/**
 * Stream C (P3, proposal P1 "vendor-neutral core"): the cooling unit used when a project's catalog id does not resolve. Never a vendor id
 * literal. Ranking: units of the profile's CDU class (`item.cdu.class`) → vendor 'Generic' → capacity closest to the class target
 * (facility CDU 2000 kW, row CDU 1400 kW, room CRAH 400 kW, fan wall 600 kW) → catalog order. Returns undefined when the catalog has no unit
 * of that category.
 */
export const DEFAULT_COOLING_TARGET_KW = { 'cdu-facility': 2000, 'cdu-row': 1400, crah: 400, 'fan-wall': 600 } as const;
export function defaultCoolingItem(category: 'cdu' | 'crah' | 'fan-wall', opts: { cduClass?: 'facility-2mw' | 'row-l2l' | 'in-rack-rpu' | 'none'; targetKW?: number } = {}): CatalogItem | undefined {
  const want = opts.cduClass === 'row-l2l' || opts.cduClass === 'in-rack-rpu' ? 'row-l2l' : 'facility';
  const target = opts.targetKW ?? (category === 'cdu' ? (want === 'row-l2l' ? DEFAULT_COOLING_TARGET_KW['cdu-row'] : DEFAULT_COOLING_TARGET_KW['cdu-facility']) : category === 'crah' ? DEFAULT_COOLING_TARGET_KW.crah : DEFAULT_COOLING_TARGET_KW['fan-wall']);
  const pool = catalogItems().filter((i) => i.category === category && (i.capacity?.coolingKW ?? 0) > 0 && !i.id.startsWith('crah-inrow'));
  let best: { item: CatalogItem; score: number[] } | undefined;
  const better = (a: number[], b: number[]) => {
    for (let j = 0; j < a.length; j++) if (a[j] !== b[j]) return a[j] < b[j];
    return false;
  };
  pool.forEach((item, k) => {
    const score = [category === 'cdu' && item.cdu?.class !== want ? 1 : 0, item.vendor === 'Generic' ? 0 : 1, Math.abs((item.capacity?.coolingKW ?? 0) - target), k];
    if (!best || better(score, best.score)) best = { item, score };
  });
  return best?.item;
}

/**
 * Remove and re-place CDUs / CRAHs / fan walls of one hall according to `opts`, keeping every other item.
 * Returns a NEW project (never mutates the input); stores `opts` on `hall.coolingPlacement`. Unknown hall → the input.
 */
export function regenerateCooling(project: Project, hallId: string, opts: CoolingPlacementOptions): Project {
  return regenerateCoolingReport(project, hallId, opts).project;
}

/**
 * Regenerate the whole hall with `opts` as its cooling placement (fix v2 2차, QA): the generator honours hall.coolingPlacement and the
 * CRAH strategy in the row length (row-end / row-centre slots), keeps the hall's pod count and tag-derived ids, and grows the hall
 * when needed (never shrinks below its size). Returns a new project.
 */
export function regenerateHallWithCooling(project: Project, hallId: string, opts: CoolingPlacementOptions): Project {
  const d = structuredClone(project);
  const hall = d.halls.find((h) => h.id === hallId);
  if (!hall) return project;
  hall.coolingPlacement = structuredClone(opts);
  const o = layoutOptionsFromProject(d, hall, { crahStrategy: opts.crahStrategy, ...(opts.crahWalls ? { crahWalls: opts.crahWalls } : {}) });
  const layout = growHallToFit(hall, o);
  applyHallLayout(d, hallId, layout, o, { policy: { ...(hall.layoutPolicy ?? {}), crahStrategy: opts.crahStrategy, ...(opts.crahWalls ? { crahWalls: opts.crahWalls } : {}) } as NonNullable<typeof hall.layoutPolicy> });
  if (opts.cduRedundancy) d.cooling.cduRedundancy = opts.cduRedundancy as typeof d.cooling.cduRedundancy;
  if (opts.crahRedundancy) d.cooling.crahRedundancy = opts.crahRedundancy as typeof d.cooling.crahRedundancy;
  return d;
}
