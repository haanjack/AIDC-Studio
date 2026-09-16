import { findCatalogItem } from '../catalog/catalog.ts';
import { round6 } from '../model/geometry.ts';
import type { EquipmentInstance, EvidenceSourceType } from '../model/types.ts';
import { growHallToFit } from './fit.ts';
import { CORRIDOR_DEFAULTS, generateHallLayout, type HallLayout, type HallLayoutOptions, type Wall } from './generate.ts';

/**
 * Row orientation + pod-grid columns (stream T1, DECISIONS-v2-2 F3a and §C, r2-layout.md §2.4).
 *
 * Auto-size hall: enumerate C = 1 … min(N, 8) columns × both orientations, generate each candidate (geometry-only probe),
 * keep the candidates whose hall aspect is ≤ the target (2:1), pick the minimum hall area; ties (area within 1 %) prefer
 * candidates that pass the air-throw and wall-length checks, then rows along the long side, then fewer empty grid slots,
 * then fewer columns, then a landscape hall. No candidate within the target → minimum aspect.
 * Fixed hall: among the candidates that fit, rows along the long side unless that option fails the air-throw (K1) or
 * wall-length (K2) check while a short-side option passes — the reason is recorded for the UI. K1 / K2 only steer halls
 * whose GPU racks are air-dominant: with liquid-dominant racks the orientation is unconstrained by air (r2-layout.md §0.3),
 * so the checks are reported as warnings only.
 *
 * The auto-size hall never shrinks (growHallToFit), so area and aspect are evaluated on the grown hall: an existing hall
 * keeps the orientation that needs no growth (the reference DU 4 hall stays 1 column, rows along X).
 */

export interface SourcedValue {
  value: number;
  sourceType: EvidenceSourceType;
  citation: string;
}

/** Hall aspect-ratio target (derived): reach penalty of a k:1 rectangle vs a square of equal area is (√k + 1/√k)/2 → +6 % at 2:1, +15 % at 3:1. */
export const TARGET_ASPECT: SourcedValue = { value: 2, sourceType: 'derived', citation: 'AIDC Studio derivation — Manhattan centre-to-corner reach vs a square of equal area: 1.06 at 2:1, 1.15 at 3:1, 1.25 at 4:1 (no primary source states a ratio)' };

/** One-sided air throw from the cooling wall to the farthest rack (r2-layout.md §2.1). */
export const AIR_THROW_MAX_M: Record<'gallery-fan-wall' | 'perimeter', SourcedValue> = {
  'gallery-fan-wall': { value: 18, sourceType: 'estimate', citation: 'Estimate: about 18 m one-sided air throw from a gallery fan wall to the farthest rack with a HAC chimney return (check limit; confirm with CFD for the actual hall, DECISIONS-v2-2 §C)' },
  perimeter: { value: 15, sourceType: 'estimate', citation: 'AIDC Studio throw table (raised-floor perimeter CRAH; no primary source gives a limit)' },
};

/** GPU-rack liquid share at or above which room air no longer sets the row orientation (r2-layout.md §0.3 "liquid-dominant"; no numeric source — estimate). */
export const LIQUID_DOMINANT_FRACTION: SourcedValue = { value: 0.5, sourceType: 'estimate', citation: 'AIDC Studio estimate — with in-row, RDHx or liquid-dominant cooling the orientation is unconstrained by air; 0.5 liquid share is an estimate' };

/** Longest pod-area side before OOB copper / 100G MMF runs exceed their reach. */
export const CABLE_REACH_M: SourcedValue = { value: 100, sourceType: 'standard', citation: 'IEEE 802.3ab 1000BASE-T 100 m channel (OOB) and IEEE 802.3bm 100GBASE-SR4 100 m on OM4' };

export interface GridCandidate {
  columns: number;
  orientation: 'x' | 'y';
  /** hall size this candidate results in (auto-size: grown hall; fixed: the hall) */
  widthM: number;
  depthM: number;
  /** auto-size: grown hall area; fixed: layout envelope area */
  areaM2: number;
  aspect: number;
  /** layout envelope along the rows (ℓ) and across the rows (m) */
  rowDirM: number;
  crossM: number;
  podAreaWM: number;
  podAreaDM: number;
  rowsAlongLongSide: boolean;
  throwM?: number;
  throwOk: boolean;
  /** false when the GPU racks are liquid-dominant: the air-throw (K1) and wall-length (K2) results are reported but do not steer the choice */
  airChecksApply: boolean;
  wallOk: boolean;
  /** qa-autosize v2 2차: hall walls without perimeter / gallery cooling units (4 − walls used). The electrical rooms A / B go on free walls
   *  (engines/powerPaths.ts hallRooms): 2 = opposite walls, 1 = side by side on one wall, 0 = no free wall (power-elec-room-wall) */
  freeWalls: number;
  reachOk: boolean;
  /** worst network-core → row-end run incl. tray drops (networkReachRunM) */
  reachRunM?: number;
  fits: boolean;
  emptySlots: number;
}

export type GridReasonCode = 'auto-min-area' | 'auto-free-wall' | 'auto-min-aspect' | 'fixed-long-side' | 'fixed-free-wall' | 'fixed-short-throw' | 'fixed-short-wall' | 'fixed-short-fit' | 'fixed-none-fit';

/**
 * Extra hall area the auto-size chooser accepts for a grid that leaves a hall wall free of perimeter cooling units, so the electrical rooms
 * are not on a CRAH wall (power-elec-room-wall). Within the aspect target and in reach only.
 */
export const FREE_WALL_AREA_TOLERANCE: SourcedValue = {
  value: 0.1,
  sourceType: 'estimate',
  citation: 'qa-autosize-v2-2.md §3 — 128 auto-sized 8 / 16-DU combos whose minimum-area grid put CRAHs on all four walls: a grid within 2:1 that frees a wall costs ≤ +7.9 % area in 110 of them; keeping every CRAH on the two row-end walls instead needs ×1.2–2.2 area within 2:1',
};

export interface GridWarning {
  code: 'throw' | 'wall' | 'reach' | 'aspect';
  params: Record<string, string | number>;
}

export interface GridChoice {
  mode: 'auto-size' | 'fixed';
  orientation: 'x' | 'y';
  columns: number;
  /** row-end walls for perimeter / gallery units in the hall frame (W+E for rows along X, S+N for rows along Y) */
  crahWalls: Wall[];
  reason: GridReasonCode;
  params: Record<string, string | number>;
  warnings: GridWarning[];
  chosen: GridCandidate;
  candidates: GridCandidate[];
  targetAspect: number;
  /** qa-autosize v2 2차: the next grids in the chooser's own order (distinct orientation × columns) — autoSizeHall tries them when the
   *  analysis of the generated hall still reports a run beyond reach (tray routes the geometric reach check cannot see) */
  alternatives: { orientation: 'x' | 'y'; columns: number }[];
}

export interface GridChoiceOptions {
  mode: 'auto-size' | 'fixed';
  targetAspect?: number;
  /** upper bound on columns (default 8, r2-layout.md §2.4) */
  maxColumns?: number;
  /** route model for the reach check (default: reference cabling, the hall's tray height) */
  cabling?: ReachCabling;
  /** the cooling engine's CRAH count for this hall (calibrateLayout adopts it after generation); the probes use it so free-wall predictions match (backlog T1a) */
  crahCount?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** Vertical tray drop at each end of a network run (rack top → tray and back, estimate). */
export const TRAY_DROP_M = 3;

/**
 * Worst network run of a pod grid (fix v2 2차, QA): Manhattan route from the network-core band to the farthest compute row end, plus
 * the tray drops. End band (beyond the last pod row): podW − segLen/2 + podD + band depth; centre band: podW − segLen/2 + podD/2.
 * segLen = one column's row length (the band sits at a column centre); a separate room adds its offset. Was max(podW, podD) ≤ 100 m,
 * which passed DU 21–40 grids that produced 100–143 m runs.
 */
export function networkReachRunM(g: { podW: number; podD: number; segLen: number; bandDepthM: number; centre: boolean; roomOffsetM?: number; farRowsDepthM?: number }): number {
  const along = Math.max(0, g.podW - g.segLen / 2);
  // centre band: the pod rows on the far side of the band (⌈R/2⌉ pitches for an odd row count) plus the band itself
  const across = g.centre ? (g.farRowsDepthM ?? g.podD / 2) + g.bandDepthM : g.podD + g.bandDepthM + (g.roomOffsetM ?? 0);
  return r2(along + across + 2 * TRAY_DROP_M);
}

/** Row-end walls (perpendicular to the rows) in the hall frame. */
export function rowEndWalls(orientation: 'x' | 'y'): Wall[] {
  return orientation === 'x' ? ['W', 'E'] : ['S', 'N'];
}

/**
 * Two-pass probe (polish v2 2차, QA F4 / F14): generate at a start size (x frame) and, for auto-size, grow + trim exactly as the panel's
 * growHallToFit does. The 0 × 0 probe alone carried row-end CRAH units / N-S walls that a grown hall no longer needs (or missed the
 * walls a narrower hall brings back), so predicted areas differed from the real hall by up to 8 %.
 */
function probeAt(opts: HallLayoutOptions, columns: number, startW: number, startD: number, grow: boolean, crahCount?: number): { L: HallLayout; w: number; d: number } | null {
  const cp = opts.hall.coolingPlacement;
  const hall = { ...opts.hall, width: startW, depth: startD, keepouts: [], coolingPlacement: cp ? { ...cp, crahWalls: undefined, cduGalleryWall: undefined, ...(crahCount !== undefined ? { crahCount } : {}) } : undefined };
  // backlog T1a (qa-autosize §6.3): probe with the calibrated CRAH count (never below the generator's own count) so the free-wall prediction
  // is the wall set the generated hall will use after calibrateLayout raises the count
  const o: HallLayoutOptions = { ...opts, hall, orientation: 'x', columns, crahWalls: ['W', 'E'], probe: true, ...(crahCount !== undefined ? { crahs: crahCount } : {}) };
  try {
    const L = grow ? growHallToFit(hall, o) : generateHallLayout(o);
    return { L, w: hall.width, d: hall.depth };
  } catch {
    return null;
  }
}

/** Cable-route model the network analysis uses without tray polylines (engines/network.ts cableLengthM): Manhattan × route factor + two tray drops + slack per end. */
export interface ReachCabling {
  routeFactor: number;
  slackPerEndM: number;
  trayHeightM?: number;
}
/** Reference project cabling (layout/reference.ts: routeFactor 1.25, 1.5 m slack per end, tray at 2.9 m). */
export const REACH_CABLING_DEFAULT: ReachCabling = { routeFactor: 1.25, slackPerEndM: 1.5, trayHeightM: 2.9 };

const isComputePodId = (podId?: string) => !!podId && !podId.startsWith('pod-services') && !podId.startsWith('pod-network-core');
const CORE_ROLES = new Set<EquipmentInstance['networkRole']>(['scale-out-spine', 'scale-out-core', 'inter-hall-core']);
/** aggregation racks whose links are reach-limited to 100 m (100G front-end / storage / OOB-aggregation MMF); scale-out spines use 800G optics with SMF options.
 *  qa-autosize v2 2차: the OOB aggregation rack was missing — Helios DU 16 pod leaves uplinked to C-SVC-OOB01 at 100G over 103.5 m */
const REACH_LIMITED_ROLES = new Set<EquipmentInstance['networkRole']>(['frontend', 'storage', 'oob']);

/**
 * Worst pod-leaf → aggregation run of a generated layout, measured on its rack positions with the analysis' route model (polish v2 2차, QA
 * F3): every in-pod network rack (scale-out / front-end leaves) against every network-core / services-zone network rack (spines, FE / storage
 * / OOB aggregation, band-end services leaves) and the distributed spine racks. Leaves are Clos-connected to every aggregation switch, so the
 * maximum pair is the run the cable schedule will contain. Was a closed-form band estimate without route factor or band-end racks, which
 * missed phased DU 16 and single-build DU 24 / DU 32 (analysis runs 100.5–117 m).
 */
export function layoutReachRunM(layout: Pick<HallLayout, 'equipment'>, cabling: ReachCabling = REACH_CABLING_DEFAULT): { runM: number; from?: string; to?: string } {
  const leaves: EquipmentInstance[] = [];
  const aggs: EquipmentInstance[] = [];
  for (const e of layout.equipment) {
    if (findCatalogItem(e.catalogId)?.category !== 'network-rack') continue;
    if (isComputePodId(e.podId) && !CORE_ROLES.has(e.networkRole)) {
      // front-end / storage leaves ride the pod's aux network racks; scale-out leaf racks uplink at 800G (SMF options). qa-autosize v2 2차: the
      // network engine now takes overflow leaves in the scale-out leaf rack NEAREST the aggregation zone (engines/network.ts nearAgg), so the
      // aux racks stay the measured leaf end; runs the positions cannot show (tray routes) are caught by autoSizeHall's analysis check
      if (e.networkRole !== 'scale-out-leaf') leaves.push(e);
    }
    else if (REACH_LIMITED_ROLES.has(e.networkRole)) aggs.push(e);
  }
  let best = 0;
  let from: string | undefined;
  let to: string | undefined;
  for (const a of leaves)
    for (const b of aggs) {
      const dm = Math.abs(a.position.x - b.position.x) + Math.abs(a.position.y - b.position.y);
      if (dm > best) {
        best = dm;
        from = a.tag;
        to = b.tag;
      }
    }
  if (!from) return { runM: 0 };
  const vertical = 2 * Math.max(0.5, (cabling.trayHeightM ?? 2.9) - 1.2);
  return { runM: Math.ceil((best * cabling.routeFactor + vertical + 2 * cabling.slackPerEndM) * 2) / 2, from, to };
}

export function chooseLayoutGrid(opts: HallLayoutOptions, cfg: GridChoiceOptions): GridChoice {
  const N = Math.max(1, Math.floor(opts.pods));
  const maxC = Math.max(1, Math.min(cfg.maxColumns ?? 8, N));
  const target = cfg.targetAspect ?? TARGET_ASPECT.value;
  const W0 = Math.max(0, opts.hall.width);
  const D0 = Math.max(0, opts.hall.depth);
  const strategy = opts.crahStrategy ?? 'perimeter';
  const airWall = strategy === 'perimeter' || strategy === 'gallery-fan-wall';
  const throwRef = strategy === 'gallery-fan-wall' ? AIR_THROW_MAX_M['gallery-fan-wall'] : AIR_THROW_MAX_M.perimeter;
  const gpuRack = findCatalogItem(opts.template.gpuRackCatalogId);
  const airChecksApply = (gpuRack?.cooling?.liquidFraction ?? 0) < LIQUID_DOMINANT_FRACTION.value;
  const transport = (opts.corridors ?? CORRIDOR_DEFAULTS).transportM;
  const cabling = cfg.cabling ?? { ...REACH_CABLING_DEFAULT, trayHeightM: opts.hall.trayHeight ?? REACH_CABLING_DEFAULT.trayHeightM };
  const auto = cfg.mode === 'auto-size';
  const candidates: GridCandidate[] = [];
  for (let C = 1; C <= maxC; C++) {
    const grown = new Map<string, { L: HallLayout; w: number; d: number } | null>();
    for (const orientation of ['x', 'y'] as const) {
      // auto-size: the candidate's hall is what growHallToFit makes of the current hall in this orientation (x frame start W0 × D0 / D0 × W0)
      // fixed (qa-autosize v2 2차): the layout generated IN the hall in this orientation. The 0 × 0 probe had no wall length for the
      // row-end CRAHs, so it added N / S walls and row-end units and a hall of exactly the auto-sized size reported "nothing fits"
      const sw = orientation === 'x' ? W0 : D0;
      const sd = orientation === 'x' ? D0 : W0;
      const key = `${sw}|${sd}`;
      if (!grown.has(key)) grown.set(key, probeAt(opts, C, sw, sd, auto, cfg.crahCount));
      const g = grown.get(key) ?? null;
      if (!g) continue;
      const L = g.L;
      const l = L.requiredWidth;
      const m = L.requiredDepth;
      const podW = C * L.grid.rowLengthM + (C - 1) * transport;
      const podD = L.grid.rows * L.grid.podPitchM;
      const sides = airWall ? L.crah.walls.filter((w) => w === 'W' || w === 'E').length : 0;
      const throwM = sides > 0 ? r2(podW / sides) : undefined;
      const freeWalls = airWall ? 4 - new Set(L.crah.walls).size : 4;
      const wallOk = !airWall || (L.crah.placed >= L.crah.required && !L.crah.walls.some((w) => w === 'N' || w === 'S') && !L.issues.some((i) => i.id.startsWith('layout-crah-row-end') || i.id.startsWith('layout-crah-short')));
      const reachRunM = layoutReachRunM(L, cabling).runM;
      const reachOk = reachRunM <= CABLE_REACH_M.value + 1e-9;
      const dx = orientation === 'x' ? l : m;
      const dy = orientation === 'x' ? m : l;
      // polish v2 2차 (QA F6): in a fixed hall larger than the layout the row-end units stand at the pod-area edge when the wall is too far
      // (generate.ts crahLine), so the throw is the pod-area estimate again
      const throwOkHere = throwM === undefined || throwM <= throwRef.value + 1e-9;
      const fits = dx <= W0 + 1e-6 && dy <= D0 + 1e-6;
      const w = !auto ? W0 : g ? (orientation === 'x' ? g.w : g.d) : Math.max(W0, dx);
      const d = !auto ? D0 : g ? (orientation === 'x' ? g.d : g.w) : Math.max(D0, dy);
      const area = !auto ? dx * dy : w * d;
      const aspect = !auto ? Math.max(dx, dy) / Math.max(1e-9, Math.min(dx, dy)) : Math.max(w, d) / Math.max(1e-9, Math.min(w, d));
      candidates.push({
        columns: C,
        orientation,
        widthM: round6(w),
        depthM: round6(d),
        areaM2: r2(area),
        aspect: r2(aspect),
        rowDirM: round6(l),
        crossM: round6(m),
        podAreaWM: round6(podW),
        podAreaDM: round6(podD),
        rowsAlongLongSide: orientation === 'x' ? w >= d - 1e-6 : d >= w - 1e-6,
        throwM,
        throwOk: throwOkHere,
        airChecksApply,
        wallOk,
        freeWalls,
        reachOk,
        reachRunM,
        fits,
        emptySlots: C * Math.ceil(N / C) - N,
      });
    }
  }
  if (!candidates.length) {
    const fallback: GridCandidate = { columns: 1, orientation: 'x', widthM: W0, depthM: D0, areaM2: W0 * D0, aspect: 1, rowDirM: 0, crossM: 0, podAreaWM: 0, podAreaDM: 0, rowsAlongLongSide: true, throwOk: true, airChecksApply, wallOk: true, freeWalls: 4, reachOk: true, fits: false, emptySlots: 0 };
    return { mode: cfg.mode, orientation: 'x', columns: 1, crahWalls: rowEndWalls('x'), reason: cfg.mode === 'fixed' ? 'fixed-none-fit' : 'auto-min-area', params: {}, warnings: [], chosen: fallback, candidates, targetAspect: target, alternatives: [] };
  }
  const passK = (c: GridCandidate) => (!c.airChecksApply || (c.throwOk && c.wallOk) ? 1 : 0);
  const landscape = (c: GridCandidate) => (c.widthM >= c.depthM - 1e-6 ? 1 : 0);
  let chosen: GridCandidate;
  let reason: GridReasonCode;
  let ranked: GridCandidate[] = [];
  let freeWallAreaPct = 0;
  // qa-autosize v2 2차: a run beyond reach is a validation error (network-unreachable), the area and the throw / wall checks are preferences —
  // when some candidate keeps every measured pod-leaf → aggregation run in reach, the chooser only picks among those
  const inReach = (list: GridCandidate[]) => (list.some((c) => c.reachOk) ? list.filter((c) => c.reachOk) : list);
  if (cfg.mode === 'auto-size') {
    const within = inReach(candidates.filter((c) => c.aspect <= target + 1e-6));
    let tied: GridCandidate[];
    if (within.length) {
      const minA = Math.min(...within.map((c) => c.areaM2));
      tied = within.filter((c) => c.areaM2 <= minA * 1.01 + 1e-6);
      reason = 'auto-min-area';
      // qa-autosize v2 2차 (§3): the minimum-area grid needs perimeter units on all four walls → both electrical rooms sit on a CRAH wall.
      // Take the smallest in-reach grid within the aspect target that leaves a wall free, when it costs ≤ FREE_WALL_AREA_TOLERANCE area.
      if (airWall && tied.every((c) => c.freeWalls === 0)) {
        const roomy = within.filter((c) => c.freeWalls >= 1 && c.areaM2 <= minA * (1 + FREE_WALL_AREA_TOLERANCE.value) + 1e-6);
        if (roomy.length) {
          const minR = Math.min(...roomy.map((c) => c.areaM2));
          tied = roomy.filter((c) => c.areaM2 <= minR * 1.01 + 1e-6).sort((p, q) => Number(q.freeWalls >= 2) - Number(p.freeWalls >= 2));
          reason = 'auto-free-wall';
          freeWallAreaPct = Math.round((minR / minA - 1) * 1000) / 10;
        }
      }
    } else {
      const pool = inReach(candidates);
      const minK = Math.min(...pool.map((c) => c.aspect));
      tied = pool.filter((c) => c.aspect <= minK + 1e-6);
      reason = 'auto-min-aspect';
    }
    const cmp = (p: GridCandidate, q: GridCandidate) => passK(q) - passK(p) || Number(q.reachOk) - Number(p.reachOk) || Number(q.rowsAlongLongSide) - Number(p.rowsAlongLongSide) || p.areaM2 - q.areaM2 || p.emptySlots - q.emptySlots || p.columns - q.columns || landscape(q) - landscape(p) || p.orientation.localeCompare(q.orientation);
    tied.sort((p, q) => (reason === 'auto-free-wall' ? Number(q.freeWalls >= 2) - Number(p.freeWalls >= 2) : 0) || cmp(p, q));
    chosen = tied[0];
    // alternatives: in-reach grids within the target by area, then the rest up to 3:1 (reach first)
    const rest = candidates.filter((c) => c !== chosen && c.aspect <= Math.max(target, 3) + 1e-6);
    ranked = [...rest].sort((p, q) => Number(q.reachOk) - Number(p.reachOk) || Number(q.aspect <= target + 1e-6) - Number(p.aspect <= target + 1e-6) || Number(q.freeWalls >= 1) - Number(p.freeWalls >= 1) || p.areaM2 - q.areaM2 || cmp(p, q));
  } else {
    const fitting = candidates.filter((c) => c.fits);
    if (!fitting.length) {
      // nothing fits: rows along the long side, fewest columns that minimise the overflow
      const over = (c: GridCandidate) => Math.max(0, (c.orientation === 'x' ? c.rowDirM : c.crossM) - W0) + Math.max(0, (c.orientation === 'x' ? c.crossM : c.rowDirM) - D0);
      chosen = [...candidates].sort((p, q) => Number(q.rowsAlongLongSide) - Number(p.rowsAlongLongSide) || over(p) - over(q) || p.columns - q.columns)[0];
      reason = 'fixed-none-fit';
    } else {
      // qa-autosize v2 2차 (§3): a grid that leaves a wall free for the electrical rooms comes right after reach (only perimeter / gallery units occupy walls)
      const roomOk = (c: GridCandidate) => (!airWall || c.freeWalls >= 1 ? 1 : 0);
      fitting.sort((p, q) => Number(q.reachOk) - Number(p.reachOk) || roomOk(q) - roomOk(p) || passK(q) - passK(p) || Number(q.rowsAlongLongSide) - Number(p.rowsAlongLongSide) || p.columns - q.columns || p.areaM2 - q.areaM2 || p.orientation.localeCompare(q.orientation));
      chosen = fitting[0];
      ranked = fitting.slice(1);
      if (!chosen.rowsAlongLongSide && fitting.some((c) => c.rowsAlongLongSide && c.reachOk === chosen.reachOk && !roomOk(c)) && roomOk(chosen)) reason = 'fixed-free-wall';
      else if (chosen.rowsAlongLongSide) reason = 'fixed-long-side';
      else {
        const long = fitting.filter((c) => c.rowsAlongLongSide);
        reason = long.length ? (long.some((c) => !c.throwOk && c.airChecksApply) ? 'fixed-short-throw' : long.some((c) => !c.wallOk && c.airChecksApply) ? 'fixed-short-wall' : 'fixed-short-fit') : 'fixed-short-fit';
      }
    }
  }
  const params: Record<string, string | number> = {
    columns: chosen.columns,
    rows: Math.ceil(N / chosen.columns),
    axis: chosen.orientation.toUpperCase(),
    width: r2(chosen.widthM),
    depth: r2(chosen.depthM),
    area: Math.round(chosen.areaM2),
    aspect: chosen.aspect,
    target,
  };
  if (reason === 'auto-free-wall') {
    params.freeWalls = chosen.freeWalls;
    params.areaPct = freeWallAreaPct;
  }
  if (reason === 'fixed-short-throw') {
    const long = candidates.filter((c) => c.fits && c.rowsAlongLongSide && !c.throwOk).sort((p, q) => (p.throwM ?? 0) - (q.throwM ?? 0))[0];
    params.throwM = long?.throwM ?? 0;
    params.throwMaxM = throwRef.value;
  }
  const warnings: GridWarning[] = [];
  if (!chosen.throwOk) warnings.push({ code: 'throw', params: { throwM: chosen.throwM ?? 0, throwMaxM: throwRef.value, sourceType: throwRef.sourceType, liquidDominant: chosen.airChecksApply ? 0 : 1 } });
  if (!chosen.wallOk) warnings.push({ code: 'wall', params: { liquidDominant: chosen.airChecksApply ? 0 : 1 } });
  if (!chosen.reachOk) {
    // suggest the centre band when only that passes (same grid, band between the middle pod rows)
    const centreRun = networkReachRunM({ podW: chosen.podAreaWM, podD: chosen.podAreaDM, segLen: 0, bandDepthM: 5, centre: true });
    warnings.push({ code: 'reach', params: { podW: r2(chosen.podAreaWM), podD: r2(chosen.podAreaDM), reachM: CABLE_REACH_M.value, runM: chosen.reachRunM ?? 0, centreRunM: centreRun, centreOk: centreRun <= CABLE_REACH_M.value ? 1 : 0 } });
  }
  if (chosen.aspect > target + 1e-6) warnings.push({ code: 'aspect', params: { aspect: chosen.aspect, target } });
  const alternatives: GridChoice['alternatives'] = [];
  for (const c of ranked) {
    if ((c.orientation === chosen.orientation && c.columns === chosen.columns) || alternatives.some((x) => x.orientation === c.orientation && x.columns === c.columns)) continue;
    alternatives.push({ orientation: c.orientation, columns: c.columns });
  }
  return { mode: cfg.mode, orientation: chosen.orientation, columns: chosen.columns, crahWalls: rowEndWalls(chosen.orientation), reason, params, warnings, chosen, candidates, targetAspect: target, alternatives };
}

/** English one-line reason (documents / tests; the UI formats the same code + params through i18n). */
export function gridReasonText(choice: GridChoice): string {
  const p = choice.params;
  const head = `${p.columns} column(s) × ${p.rows} pod row(s), rows along ${p.axis}, ${p.width} × ${p.depth} m (${p.aspect}:1)`;
  switch (choice.reason) {
    case 'auto-min-area':
      return `${head} — smallest hall with aspect ≤ ${p.target}:1`;
    case 'auto-free-wall':
      return `${head} — smallest hall within ${p.target}:1 that leaves ${p.freeWalls} wall(s) free of cooling units for the electrical rooms (+${p.areaPct} % area)`;
    case 'fixed-free-wall':
      return `${head} — rows across the hall: along the long side the cooling units would take every wall and leave none for the electrical rooms`;
    case 'auto-min-aspect':
      return `${head} — no grid reaches ${p.target}:1; smallest aspect ratio`;
    case 'fixed-long-side':
      return `${head} — rows follow the hall's long side`;
    case 'fixed-short-throw':
      return `${head} — rows across the hall: along the long side the air throw would be ${p.throwM} m > ${p.throwMaxM} m`;
    case 'fixed-short-wall':
      return `${head} — rows across the hall: along the long side the row-end walls cannot hold the cooling units`;
    case 'fixed-short-fit':
      return `${head} — rows across the hall: the long-side option does not fit`;
    default:
      return `${head} — no grid fits the hall; showing the long-side option`;
  }
}
