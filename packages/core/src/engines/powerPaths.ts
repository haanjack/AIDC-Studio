// Power plane: physical power paths + contingency scenarios (stream T3, DECISIONS-v2-2 §B/§C, r2-platform.md §1).
//
// `analyzePowerPaths` is called by analyzeProject and attached to `analysis.power.paths` when non-empty.
// `evaluatePowerScenario` / `sweepPowerN1` are on demand (panel / 3D), never inside analyzeProject.
//
// Topology (r2-platform.md §1.2, all derived deterministically from the layout):
//   utility feeds → generators (standby bus) → UPS system A / B (/ C reserve, from the one-line) → hall switchboard A / B
//   (electrical room A / B, opposite hall sides — site-design.md §3 rule 1) → feeder → busway circuit (row side) → tap-off → rack.
//   One stored Busway polyline (project.busways, or derived per row like the viewer) is one row side; it carries
//   `n = ceil(Σ rack kW / limitKW)` parallel circuits so that either side alone carries 100 % of the row within the continuous
//   limit (the sizing rule of engines/power.ts). Racks are assigned to circuits contiguously along the row, balanced by kW.
//
// Loading rules (r2-platform.md §1.3/§1.4):
//   rating_kW = √3 · V_LL · I · PF;  limit_kW = rating_kW × profile factor;  loading = connected_kW / limit_kW.
//   NEC: continuous load ≤ 80 % of the OCPD rating (100 % for assemblies listed for 100 % operation; modelled as
//        project.power.deratingFactor ≥ 1) — `standard` (NFPA 70 210.20(A)/215.3 via IAEI / EEPower; text not re-read).
//   IEC: IB ≤ In → factor 1.0, warning at 0.9 — `standard` (IEC 60364-4-43 §433.1, not re-read). KR: IEC rules — `estimate`.
//   Protection checks use the allocation basis (catalog nameplate × equipment loadFactor, plus switch load in network racks);
//   upstream UPS checks use the design basis of engines/power.ts (IT racks × diversity + UPS-backed mechanical).
//
// Rack end states: normal / single-path / on-bypass / capped / dropped.
//   both sides alive → 0.5 / 0.5 (ideal current sharing, `estimate`);
//   one side alive   → full load if shelvesPerSide × shelfKW ≥ demand (single-path, warning);
//                      else capped at that capacity if the platform can cap and the capacity ≥ the rack's minimum (catalog idle);
//                      else dropped;
//   no side alive / single-corded rack on a dead side → dropped.
//   Overloaded runs are flagged, not tripped (no cascading).
import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect } from '../model/geometry.ts';
import { buildBusways, rowGroupsFromEquipment } from '../layout/rows.ts';
import type {
  Busway, CatalogItem, EquipmentInstance, EvidenceSourceType, Hall, OneLineNode, PowerAnalysis, PowerElementResult, PowerPath, PowerProfile, PowerRackOutcome,
  PowerRackState, PowerRoom, PowerScenario, PowerScenarioResult, PowerScenarioSummary, Project, ProjectAnalysis, Rect, UpsBlockSizing, Vec3,
  WallPenetration,
} from '../model/types.ts';
import { IT_LOAD_CATEGORIES } from './context.ts';
import { routeFeeders, type FeederLevels, type FeederRouteInput } from './powerGeometry.ts';

const SQRT3 = Math.sqrt(3);
/** engines/power.ts genset derate (estimate) */
const GEN_DERATE = 0.95;
/** engines/power.ts site power factor (estimate) */
const SITE_PF = 0.95;
/** NFPA 110 Type 10: standby source within 10 s (`standard`, not re-read) */
const TRANSFER_S = 10;
/** busway ampacity when the RPP catalog item has no currentA (layout/rows.ts default, estimate) */
const DEFAULT_AMPACITY_A = 800;
const EPS = 1e-9;

// ───────────────────────────── rules & sources ─────────────────────────────

export interface ContinuousLimitRule {
  profile: PowerProfile;
  /** continuous limit as a fraction of the rating */
  continuousLimit: number;
  /** warning threshold as a fraction of the rating */
  warnAt: number;
  rated100pct: boolean;
  rule: string;
  sourceType: EvidenceSourceType;
  citation: string;
}

export function continuousLimitRule(project: Project): ContinuousLimitRule {
  const profile: PowerProfile = project.site.powerProfile ?? 'iec';
  if (profile === 'nec') {
    const rated100pct = project.power.deratingFactor >= 1;
    const lim = rated100pct ? 1 : 0.8;
    return {
      profile, continuousLimit: lim, warnAt: 0.9 * lim, rated100pct,
      rule: rated100pct ? 'NEC: assembly listed for 100 % operation carries 100 % of its rating continuously' : 'NEC: continuous load ≤ 80 % of the OCPD rating (125 % sizing rule, 210.20(A) / 215.3)',
      sourceType: 'standard',
      citation: 'NFPA 70 via IAEI "100% vs 80%: choosing the right OCPD solution" (text not re-read); warning at 90 % of the limit is derived',
    };
  }
  return {
    profile, continuousLimit: 1, warnAt: 0.9, rated100pct: false,
    rule: 'IEC 60364-4-43 §433.1: IB ≤ In (1.0 × rating), warning at 0.9',
    sourceType: profile === 'kr' ? 'estimate' : 'standard',
    citation: profile === 'kr' ? 'KEC is IEC 60364-based; IEC rule used until a KR-specific rule is confirmed (estimate)' : 'IEC 60364-4-43 §433.1 (not re-read)',
  };
}

export interface RackCordModel {
  /** 2 = dual-corded (A + B), 1 = single-corded */
  sides: 1 | 2;
  /** cord side of a single-corded rack */
  side: 'A' | 'B';
  shelvesPerSide: number;
  shelvesRequired: number;
  shelfKW: number;
  /** platform can be power-capped (DPS / BMC power limit) instead of dropping */
  cappable: boolean;
  /** minimum operating power (catalog idle) — capped below this = dropped */
  minKW: number;
  /** shedding priority (higher = more important), meta.priority, default 1 */
  priority: number;
  source: string;
  sourceType: EvidenceSourceType;
}

/** Published rack power-shelf arrangements (site-design.md §1.1). */
export const RACK_SHELF_MODELS: Record<string, { redundant: { perSide: number; required: number }; nonRedundant?: { perSide: number; required: number }; shelfKW: number; source: string; sourceType: EvidenceSourceType }> = {
  'nvidia-gb300-nvl72': {
    redundant: { perSide: 4, required: 4 },
    nonRedundant: { perSide: 3, required: 6 },
    shelfKW: 33,
    source: 'Supermicro GB300 NVL72 datasheet "8x 1U 33kW … 4+4 rack power shelves"; Lenovo lp2357 non-redundant 6 × 33 kW',
    sourceType: 'vendor-claim',
  },
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function rackCordModel(e: EquipmentInstance, item: CatalogItem): RackCordModel {
  const meta = e.meta ?? {};
  const nameplate = item.power?.nameplateKW ?? 0;
  const known = RACK_SHELF_MODELS[item.id];
  const single = meta.singleCorded === true || (meta.singleCorded !== false && (item.power?.feeds ?? 2) < 2);
  const side: 'A' | 'B' = meta.cordSide === 'B' ? 'B' : 'A';
  let perSide = 1;
  let required = 1;
  let shelfKW = nameplate;
  let source = 'assumed N+N: each side carries the rack nameplate (no shelf data in the catalog)';
  let sourceType: EvidenceSourceType = 'estimate';
  if (known) {
    const arr = meta.powerShelves === 'non-redundant' && known.nonRedundant ? known.nonRedundant : known.redundant;
    perSide = arr.perSide;
    required = arr.required;
    shelfKW = known.shelfKW;
    source = known.source;
    sourceType = known.sourceType;
  }
  if (num(meta.shelvesPerSide) !== undefined || num(meta.shelfKW) !== undefined) {
    perSide = num(meta.shelvesPerSide) ?? perSide;
    required = num(meta.shelvesRequired) ?? required;
    shelfKW = num(meta.shelfKW) ?? shelfKW;
    source = 'equipment meta (user)';
    sourceType = 'estimate';
  }
  return {
    sides: single ? 1 : 2,
    side,
    shelvesPerSide: perSide,
    shelvesRequired: required,
    shelfKW,
    cappable: typeof meta.powerCapping === 'boolean' ? meta.powerCapping : item.category === 'gpu-rack',
    minKW: item.power?.idleKW ?? 0,
    priority: num(meta.priority) ?? 1,
    source,
    sourceType,
  };
}

// ───────────────────────────── plane model ─────────────────────────────

/** Hall-side electrical room: hall-local plan rectangle outside the hall wall (derived, not a keepout); switchboard node id inside. */
export type ElectricalRoom = PowerRoom;

export interface PowerPlaneCircuit {
  id: string;
  buswayId: string;
  hallId: string;
  side: 'A' | 'B';
  rowId?: string;
  circuit: number;
  ampacityA: number;
  ratedKW: number;
  limitKW: number;
  rackIds: string[];
  points: Vec3[];
  lengthM: number;
  roomId: string;
}

export interface PowerPlaneRack {
  id: string;
  hallId: string;
  kw: number;
  itLoad: boolean;
  gpus: number;
  waveId?: string;
  cord: RackCordModel;
  circuits: { A?: string; B?: string };
}

export interface PowerPlane {
  rule: ContinuousLimitRule;
  voltageV: number;
  pf: number;
  rooms: ElectricalRoom[];
  circuits: PowerPlaneCircuit[];
  racks: PowerPlaneRack[];
  /** busway id → circuit ids */
  buswayCircuits: Map<string, string[]>;
  paths: PowerPath[];
  /** finish v2 2차 (D1 / D5): feeder wall sleeves (one per room) and partition sleeves */
  penetrations: WallPenetration[];
  /** feeder approach / tray levels per hall */
  feederLevels: FeederLevels[];
}

/** Stored busways per hall, or derived from row membership (same builder as the layout engine) when a hall has none. */
export function resolveBusways(project: Project): Busway[] {
  const stored = project.busways ?? [];
  const ampacity = findCatalogItem(project.power.rppCatalogId)?.capacity?.currentA ?? DEFAULT_AMPACITY_A;
  const out: Busway[] = [];
  for (const hall of project.halls) {
    const own = stored.filter((b) => b.hallId === hall.id);
    if (own.length) {
      out.push(...own);
      continue;
    }
    const eq = project.equipment.filter((e) => e.hallId === hall.id);
    if (!eq.some((e) => e.rowId)) continue;
    out.push(...buildBusways(hall, rowGroupsFromEquipment(hall.id, eq), eq, ampacity));
  }
  return out;
}

const len3 = (pts: readonly Vec3[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y, p.z - pts[i].z), 0);
const axisOf = (b: Busway): 'x' | 'y' => {
  const p = b.points[0];
  const q = b.points[b.points.length - 1];
  return Math.abs(q.x - p.x) >= Math.abs(q.y - p.y) ? 'x' : 'y';
};

function distToPolyline(x: number, y: number, pts: readonly Vec3[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)));
  }
  return pts.length === 1 ? Math.hypot(x - pts[0].x, y - pts[0].y) : best;
}

type Wall = 'N' | 'S' | 'E' | 'W';

/**
 * Electrical room geometry (polish v2 2차, QA m5). The plane places each room outside a hall wall with a nominal depth; engines/power.ts
 * then sizes the depth from the UPS block count and the footprint table below (`sizeElectricalRooms`). Feeders end at the switchboard
 * lineup, which always sits against the hall-side wall of the room, so feeder lengths do not depend on the sized depth.
 */
export const ELECTRICAL_ROOM_DEPTH_M = 4.5;
export const ELECTRICAL_ROOM_GAP_M = 0.4;

/** Footprint table for room sizing (all `estimate` unless the UPS catalog item supplies its own dims / front clearance). */
export const ELECTRICAL_ROOM_FOOTPRINT = {
  /** fallback UPS module (Vertiv EXL S1 1200 catalog dims 3.2 × 1.0 m, front clearance 1.2 m — vendor-claim via catalog) */
  upsModule: { w: 3.2, d: 1.0, frontM: 1.2 },
  /** Li-ion battery cabinet 0.6 × 0.9 m, 40 kWh usable, 1.25 end-of-life / DoD margin (estimate, typical rack-format Li-ion UPS cabinets) */
  batteryCabinet: { w: 0.6, d: 0.9, usableKWh: 40, margin: 1.25 },
  /** LV switchboard section 0.8 × 1.2 m, 4 outgoing busway feeders per section + 2 incomer / tie sections (estimate) */
  switchboard: { sectionW: 0.8, d: 1.2, feedersPerSection: 4, incomerSections: 2 },
  /** working space in front of every lineup (IEC 60364-7-729 / NFPA 70 110.26 order of magnitude, not re-read → estimate) */
  frontClearanceM: 1.2,
  /** end-of-lineup access aisle on both ends, far-wall margin (estimate) */
  endAisleM: 1.0,
  farWallM: 0.6,
  sourceType: 'estimate' as EvidenceSourceType,
  citation: 'polish v2 2차 room footprint table (estimate): UPS module = catalog dims + front clearance; Li-ion cabinets 0.6 × 0.9 m / 40 kWh × 1.25; switchboard sections 0.8 × 1.2 m, 4 feeders each + 2 incomers; 1.2 m working space per lineup; 1.0 m end aisles; 0.6 m far-wall margin',
};
/** switchboard lineup centre offset from the hall-side room wall (half the section depth) */
const SWBD_FEED_OFFSET_M = ELECTRICAL_ROOM_FOOTPRINT.switchboard.d / 2;
/** cooling equipment whose footprint lies within this distance of a wall occupies that wall (estimate) */
const WALL_BAND_M = 2.5;

const wallNormal = (w: Wall): 'x' | 'y' => (w === 'W' || w === 'E' ? 'x' : 'y');

function roomRectOn(hall: Hall, wall: Wall, lo: number, hi: number, depth: number): Rect {
  const G = ELECTRICAL_ROOM_GAP_M;
  switch (wall) {
    case 'W': return { x: -G - depth, y: lo, w: depth, d: hi - lo };
    case 'E': return { x: hall.width + G, y: lo, w: depth, d: hi - lo };
    case 'S': return { x: lo, y: -G - depth, w: hi - lo, d: depth };
    default: return { x: lo, y: hall.depth + G, w: hi - lo, d: depth };
  }
}

/** Another hall's footprint overlaps this room (site coordinates). */
function overlapsOtherHall(project: Project, hall: Hall, rect: Rect): boolean {
  const ax = hall.origin.x + rect.x;
  const ay = hall.origin.y + rect.y;
  return project.halls.some((h) => h.id !== hall.id && ax < h.origin.x + h.width - 0.01 && ax + rect.w > h.origin.x + 0.01 && ay < h.origin.y + h.depth - 0.01 && ay + rect.d > h.origin.y + 0.01);
}

/** Walls taken by perimeter CRAHs / fan walls (placed units or the perimeter / gallery policy) and by the CDU gallery. */
export function occupiedHallWalls(project: Project, hall: Hall): Map<Wall, 'crah' | 'cdu-gallery'> {
  const occ = new Map<Wall, 'crah' | 'cdu-gallery'>();
  const cp = hall.coolingPlacement;
  const orientation = hall.layoutPolicy?.orientation ?? 'x';
  const rowEnds: Wall[] = orientation === 'x' ? ['W', 'E'] : ['S', 'N'];
  let airUnits = false;
  for (const e of project.equipment) {
    if (e.hallId !== hall.id) continue;
    const item = findCatalogItem(e.catalogId);
    if (!item) continue;
    const isAir = item.category === 'crah' || item.category === 'fan-wall';
    const isGalleryCdu = item.category === 'cdu' && cp?.cduPlacement === 'gallery';
    if (!isAir && !isGalleryCdu) continue;
    airUnits ||= isAir;
    const r = footprintRect(item.dims, e.position, e.rotationDeg);
    const tag = isAir ? 'crah' : 'cdu-gallery';
    // the unit's own wall only (a corner unit belongs to the wall it faces, not to both). autosize v2 2차: a wall unit (no row) is
    // attributed by its facing — generate.ts placeCrahs / placeWallUnits: W 270°, E 90°, S 0°, N 180° — because a unit on a pod-edge
    // cooling line can stand nearer a side wall than its own wall (a 1-DU hall blocked the free electrical-room wall that way)
    const dist: [Wall, number][] = [['W', r.x], ['E', hall.width - (r.x + r.w)], ['S', r.y], ['N', hall.depth - (r.y + r.d)]];
    const faced = !e.rowId ? ({ 0: 'S', 90: 'E', 180: 'N', 270: 'W' } as const)[e.rotationDeg] : undefined;
    const [w, d] = faced ? dist.find((x) => x[0] === faced)! : dist.reduce((a, b) => (b[1] < a[1] - 1e-9 ? b : a));
    if (d <= WALL_BAND_M && !occ.has(w)) occ.set(w, tag);
  }
  const strategy = hall.layoutPolicy?.crahStrategy;
  if (airUnits && (strategy === 'perimeter' || strategy === 'gallery-fan-wall')) for (const w of cp?.crahWalls ?? hall.layoutPolicy?.crahWalls ?? rowEnds) if (!occ.has(w)) occ.set(w, 'crah');
  if (cp?.cduPlacement === 'gallery') occ.set(cp.cduGalleryWall ?? rowEnds[0], 'cdu-gallery');
  return occ;
}

/** Gap between rooms A and B when both stand side by side on one wall parallel to the rows (a fire-rated separation plus an access way; estimate). */
export const SHARED_WALL_SEPARATION_M = 2;

/**
 * Hall rooms A / B. Preferred walls are the row-end walls (A at the low end, B at the high end — busways feed from their row ends,
 * site-design.md §3 rule 1: A and B on opposite hall sides). A wall taken by CRAHs / the CDU gallery / another hall moves that side's
 * room to the free wall parallel to the rows on the same half (A → S or W, B → N or E); when that wall is taken too the room stays on
 * the preferred wall and carries `conflict` (validate.ts raises an issue).
 */
function hallRooms(project: Project, hall: Hall, axis: 'x' | 'y', perp: number[], sized?: readonly PowerRoom[]): ElectricalRoom[] {
  const occ = occupiedHallWalls(project, hall);
  const pref: Record<'A' | 'B', Wall> = axis === 'x' ? { A: 'W', B: 'E' } : { A: 'S', B: 'N' };
  const alt: Record<'A' | 'B', Wall> = axis === 'x' ? { A: 'S', B: 'N' } : { A: 'W', B: 'E' };
  const parallelWalls: Wall[] = axis === 'x' ? ['S', 'N'] : ['W', 'E'];
  const extentOn = (wall: Wall): [number, number] => {
    const wallLen = wallNormal(wall) === 'x' ? hall.depth : hall.width;
    if (wallNormal(wall) !== axis) return [0, wallLen];
    let lo = perp.length ? Math.min(...perp) - 1.5 : wallLen * 0.25;
    let hi = perp.length ? Math.max(...perp) + 1.5 : wallLen * 0.75;
    lo = Math.max(0, lo);
    hi = Math.min(wallLen, hi);
    if (hi - lo < 3) {
      const c = (lo + hi) / 2;
      lo = Math.max(0, c - 1.5);
      hi = Math.min(wallLen, c + 1.5);
    }
    return [lo, hi];
  };
  const blocked = (wall: Wall): 'crah' | 'cdu-gallery' | 'hall' | undefined => {
    const hit = occ.get(wall);
    if (hit) return hit;
    const [lo, hi] = extentOn(wall);
    return overlapsOtherHall(project, hall, roomRectOn(hall, wall, lo, hi, ELECTRICAL_ROOM_DEPTH_M)) ? 'hall' : undefined;
  };
  const place = (side: 'A' | 'B'): { wall: Wall; conflict?: 'crah' | 'cdu-gallery' | 'hall'; relocatedFrom?: Wall } => {
    const wall = pref[side];
    const conflict = blocked(wall);
    if (conflict && !blocked(alt[side])) return { wall: alt[side], relocatedFrom: wall };
    return { wall, ...(conflict ? { conflict } : {}) };
  };
  const plan = { A: place('A'), B: place('B') };
  // qa-autosize v2 2차 (§3): a room with no free wall of its own takes a free wall PARALLEL to the rows — the other side's alternative, or
  // side by side with the other room on its wall (A on the low half, B on the high half, SHARED_WALL_SEPARATION_M apart). The rule's intent
  // holds: separate rooms (fire compartments), A feeders still leave from the low row ends and B from the high ends, so the two feeder
  // groups use different halves of the wall and never share a sleeve. A row-end wall is never shared (B feeders would cross the whole row).
  for (const side of ['A', 'B'] as const) {
    if (!plan[side].conflict) continue;
    const other = plan[side === 'A' ? 'B' : 'A'];
    const free = parallelWalls.filter((w) => !blocked(w));
    const w = free.find((x) => x !== other.wall) ?? free.find((x) => x === other.wall && !other.conflict);
    if (w) plan[side] = { wall: w, relocatedFrom: pref[side] };
  }
  const shared = plan.A.wall === plan.B.wall && !plan.A.conflict && !plan.B.conflict;
  const mk = (side: 'A' | 'B'): ElectricalRoom => {
    const id = `elec-${hall.id}-${side}`;
    const { wall, conflict, relocatedFrom } = plan[side];
    let [lo, hi] = extentOn(wall);
    if (shared) {
      const mid = (lo + hi) / 2;
      if (side === 'A') hi = Math.max(lo + 1, mid - SHARED_WALL_SEPARATION_M / 2);
      else lo = Math.min(hi - 1, mid + SHARED_WALL_SEPARATION_M / 2);
    }
    const prev = sized?.find((r) => r.id === id && r.wall === wall);
    return {
      ...(prev ?? {}),
      id, hallId: hall.id, side, wall,
      rect: prev?.rect ?? roomRectOn(hall, wall, lo, hi, ELECTRICAL_ROOM_DEPTH_M),
      switchboardId: `swbd-${hall.id}-${side}`,
      depthM: prev?.depthM ?? ELECTRICAL_ROOM_DEPTH_M,
      ...(conflict ? { conflict } : {}),
      ...(relocatedFrom ? { relocatedFrom } : {}),
    };
  };
  return [mk('A'), mk('B')];
}

const planeCache = new WeakMap<Project, WeakMap<object, PowerPlane>>();
const NO_ANALYSIS = {};

/** Build (and memoise per project/analysis object) the A/B power-plane model. */
/** Split `racks` (in row order) into `n` contiguous groups minimising the largest group kW (DP; ties → earlier split). */
function partitionMinMax(racks: readonly PowerPlaneRack[], n: number): PowerPlaneRack[][] {
  const m = racks.length;
  if (n <= 1 || m <= 1) return [racks.slice(), ...Array.from({ length: Math.max(0, n - 1) }, () => [] as PowerPlaneRack[])].slice(0, Math.max(1, n));
  const pre = [0];
  for (const r of racks) pre.push(pre[pre.length - 1] + r.kw);
  const k = Math.min(n, m);
  // best[j][i] = minimal max group kW splitting the first i racks into j groups; cut[j][i] = start of the last group
  const best: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(m + 1).fill(0));
  best[0][0] = 0;
  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= m; i++) {
      for (let s = j - 1; s < i; s++) {
        const v = Math.max(best[j - 1][s], pre[i] - pre[s]);
        if (v < best[j][i] - 1e-9) {
          best[j][i] = v;
          cut[j][i] = s;
        }
      }
    }
  }
  const out: PowerPlaneRack[][] = [];
  let i = m;
  for (let j = k; j >= 1; j--) {
    const s = cut[j][i];
    out.unshift(racks.slice(s, i));
    i = s;
  }
  while (out.length < n) out.push([]);
  return out;
}

/**
 * Inputs the plane reads from an analysis: network rack loads (switch kW in network racks) and, when present, the sized electrical
 * rooms. engines/power.ts builds the plane with `{ network }` before the analysis object exists; the cache is keyed by the network
 * analysis object, so analyzeProject, the scenario evaluator and the 3D overlay share that single build (polish v2 2차, QA m8).
 */
export interface PowerPlaneInput {
  network?: Pick<ProjectAnalysis['network'], 'rackLoads'>;
  power?: Pick<PowerAnalysis, 'rooms'>;
}

export function buildPowerPlane(project: Project, analysis?: PowerPlaneInput | null): PowerPlane {
  const key = analysis?.network ?? NO_ANALYSIS;
  let inner = planeCache.get(project);
  const hit = inner?.get(key);
  if (hit) return hit;
  const plane = buildPowerPlaneUncached(project, analysis ?? undefined);
  if (!inner) {
    inner = new WeakMap();
    planeCache.set(project, inner);
  }
  inner.set(key, plane);
  return plane;
}

function buildPowerPlaneUncached(project: Project, analysis?: PowerPlaneInput): PowerPlane {
  const rule = continuousLimitRule(project);
  const pd = project.power;
  const voltageV = pd.distributionVoltageV;
  const pf = pd.powerFactor;
  const switchKW = new Map((analysis?.network?.rackLoads ?? []).map((r) => [r.rackId, r.kw]));
  const eqById = new Map(project.equipment.map((e) => [e.id, e]));
  const busways = resolveBusways(project);

  const racks = new Map<string, PowerPlaneRack>();
  const rackOf = (id: string): PowerPlaneRack | undefined => {
    const hit = racks.get(id);
    if (hit) return hit;
    const e = eqById.get(id);
    const item = e && findCatalogItem(e.catalogId);
    if (!e || !item) return undefined;
    const r: PowerPlaneRack = {
      id,
      hallId: e.hallId,
      kw: (item.power?.nameplateKW ?? 0) * (e.loadFactor ?? 1) + (switchKW.get(id) ?? 0),
      itLoad: IT_LOAD_CATEGORIES.has(item.category),
      gpus: item.category === 'gpu-rack' ? item.compute?.gpus ?? 0 : 0,
      waveId: e.waveId,
      cord: rackCordModel(e, item),
      circuits: {},
    };
    // generic N+N assumption: each side carries the rack's full demand (incl. switch load in network racks)
    if (!RACK_SHELF_MODELS[item.id] && r.cord.source.startsWith('assumed')) r.cord = { ...r.cord, shelfKW: r.kw };
    racks.set(id, r);
    return r;
  };

  const rooms: ElectricalRoom[] = [];
  const circuits: PowerPlaneCircuit[] = [];
  const buswayCircuits = new Map<string, string[]>();
  const paths: PowerPath[] = [];
  const feeders: PowerPath[] = [];
  const routeInputs: FeederRouteInput[] = [];
  const taps: PowerPath[] = [];

  for (const hall of project.halls) {
    const hb = busways.filter((b) => b.hallId === hall.id && b.points.length >= 2);
    if (!hb.length) continue;
    const xCount = hb.filter((b) => axisOf(b) === 'x').length;
    const axis: 'x' | 'y' = xCount * 2 >= hb.length ? 'x' : 'y';
    const hallRoomList = hallRooms(project, hall, axis, hb.map((b) => (axis === 'x' ? b.points[0].y : b.points[0].x)), analysis?.power?.rooms);
    rooms.push(...hallRoomList);

    for (const side of ['A', 'B'] as const) {
      const sideBus = hb.filter((b) => b.path === side).sort((a, b) => a.id.localeCompare(b.id));
      // each rack is fed by the nearest busway of this side that lists it (clipped rows list the same taps on every part)
      const owner = new Map<string, { b: Busway; d: number }>();
      for (const b of sideBus) {
        for (const t of b.tapoffs) {
          const d = distToPolyline(t.x, t.y, b.points);
          const prev = owner.get(t.equipmentId);
          if (!prev || d < prev.d - EPS) owner.set(t.equipmentId, { b, d });
        }
      }
      const room = hallRoomList.find((r) => r.side === side)!;
      for (const b of sideBus) {
        const bAxis = axisOf(b);
        const alongOf = (p: { x: number; y: number }) => (bAxis === 'x' ? p.x : p.y);
        const taps0 = b.tapoffs.filter((t, i, arr) => owner.get(t.equipmentId)?.b === b && arr.findIndex((u) => u.equipmentId === t.equipmentId) === i);
        const members = taps0
          .map((t) => ({ t, r: rackOf(t.equipmentId) }))
          .filter((m): m is { t: typeof m.t; r: PowerPlaneRack } => !!m.r)
          .sort((m, n) => alongOf(m.t) - alongOf(n.t) || m.r.id.localeCompare(n.r.id));
        const ampacityA = b.ampacityA > 0 ? b.ampacityA : DEFAULT_AMPACITY_A;
        const ratedKW = (SQRT3 * voltageV * ampacityA * pf) / 1000;
        const limitKW = ratedKW * rule.continuousLimit;
        // sizing: either side carries 100 % of every rack on the row (single-corded racks counted on both sides → A/B symmetric)
        const sizingKW = members.reduce((s, m) => s + m.r.kw, 0);
        // fix v2 2차 (QA): contiguous min–max partition along the row; add a circuit while any group exceeds the continuous limit
        // (cumulative-kW midpoints let one NEC circuit reach 475 kW > 446 kW)
        let n = Math.max(1, Math.ceil(sizingKW / limitKW - 1e-9));
        let groups = partitionMinMax(members.map((m) => m.r), n);
        while (n < members.length && groups.some((g) => g.reduce((s, r) => s + r.kw, 0) > limitKW + EPS)) groups = partitionMinMax(members.map((m) => m.r), ++n);
        const aVals = b.points.map(alongOf);
        const aMin = Math.min(...aVals);
        const aMax = Math.max(...aVals);
        const c = bAxis === 'x' ? b.points[0].y : b.points[0].x;
        const z0 = b.points[0].z;
        const feedA = side === 'A' ? aMin : aMax;
        const pt = (a: number, zz: number): Vec3 => (bAxis === 'x' ? { x: a, y: c, z: zz } : { x: c, y: a, z: zz });
        const ids: string[] = [];
        const rowId = members.length ? eqById.get(members[0].r.id)?.rowId : undefined;
        groups.forEach((g, k) => {
          const id = `${b.id}/c${k + 1}`;
          ids.push(id);
          // fix v2 2차 (QA): stack circuits above the Trays busway box (centred on z0, 0.13 m high) — c1 was hidden inside it
          const z = z0 + 0.065 + 0.05 + k * 0.1;
          const rackA = g.map((r) => alongOf(eqById.get(r.id)!.position));
          const far = g.length ? (side === 'A' ? Math.min(aMax, Math.max(...rackA) + 0.35) : Math.max(aMin, Math.min(...rackA) - 0.35)) : side === 'A' ? aMax : aMin;
          const points = [pt(feedA, z), pt(far, z)];
          const circuit: PowerPlaneCircuit = { id, buswayId: b.id, hallId: hall.id, side, rowId, circuit: k + 1, ampacityA, ratedKW, limitKW, rackIds: g.map((r) => r.id), points, lengthM: len3(points), roomId: room.id };
          circuits.push(circuit);
          for (const r of g) r.circuits[side] = id;
          // feeder: circuit feed end → switchboard lineup against the hall-side wall of the room. Row-end wall: straight along the row
          // axis across the wall; wall parallel to the row (relocated room): straight across the hall to that wall (polish v2 2차)
          const wall = room.wall ?? (side === 'A' ? (axis === 'x' ? 'W' : 'S') : axis === 'x' ? 'E' : 'N');
          const off = ELECTRICAL_ROOM_GAP_M + SWBD_FEED_OFFSET_M;
          const wallC = wall === 'W' || wall === 'S' ? -off : (wall === 'E' ? hall.width : hall.depth) + off;
          // straight placeholder; replaced by the routed feeder (engines/powerGeometry.ts, finish v2 2차) once every circuit is known
          const fpts = wallNormal(wall) === bAxis ? [pt(feedA, z), pt(wallC, z)] : [pt(feedA, z), bAxis === 'x' ? { x: feedA, y: wallC, z } : { x: wallC, y: feedA, z }];
          feeders.push({ id: `feed-${id}`, kind: 'feeder', fromId: room.switchboardId, toId: id, points: fpts, lengthM: len3(fpts), hallId: hall.id, side, buswayId: b.id, rowId, circuit: k + 1, ratedKW, limitKW });
          routeInputs.push({ id: `feed-${id}`, hallId: hall.id, side, buswayId: b.id, rowKey: `${rowId ?? b.id}:${side}`, bAxis, c, feedA, aMin, aMax, z, k });
          for (const r of g) {
            const e = eqById.get(r.id)!;
            const top = findCatalogItem(e.catalogId)?.dims.h ?? 2.3;
            const tp = [pt(alongOf(e.position), z), pt(alongOf(e.position), top)];
            taps.push({ id: `tap-${side}-${r.id}`, kind: 'tapoff', fromId: id, toId: r.id, points: tp, lengthM: len3(tp), hallId: hall.id, side, buswayId: b.id, rowId: e.rowId, circuit: k + 1, equipmentIds: [r.id] });
          }
        });
        buswayCircuits.set(b.id, ids);
      }
    }
  }

  // single-corded racks whose cord side has no circuit use the side that exists
  for (const r of racks.values()) if (r.cord.sides === 1 && !r.circuits[r.cord.side]) r.cord = { ...r.cord, side: r.circuits.A ? 'A' : 'B' };

  // finish v2 2차 (D1 / D2 / D5): route every feeder through the end-aisle feeder tray to one sleeve per room
  const routing = routeFeeders(project, rooms, routeInputs, ELECTRICAL_ROOM_GAP_M + SWBD_FEED_OFFSET_M);
  for (const f of feeders) {
    const pts = routing.points.get(f.id);
    if (!pts) continue;
    f.points = pts;
    f.lengthM = len3(pts);
  }

  const rackList = [...racks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const plane: PowerPlane = { rule, voltageV, pf, rooms, circuits, racks: rackList, buswayCircuits, paths, penetrations: routing.penetrations, feederLevels: routing.levels };
  // normal-state loading on every path
  const normal = evalRacks(plane, { failed: new Set(), bypassSides: new Set(), shed: new Set(), loadFactor: 1 });
  for (const c of circuits) {
    const kw = normal.circuitKW.get(c.id) ?? 0;
    paths.push({ id: c.id, kind: 'busway', fromId: `feed-${c.id}`, toId: c.rackIds[c.rackIds.length - 1] ?? c.id, points: c.points, lengthM: c.lengthM, loading: kw / c.limitKW, hallId: c.hallId, side: c.side, buswayId: c.buswayId, rowId: c.rowId, circuit: c.circuit, connectedKW: kw, ratedKW: c.ratedKW, limitKW: c.limitKW, equipmentIds: c.rackIds });
  }
  const circuitById = new Map(circuits.map((c) => [c.id, c]));
  for (const f of feeders) {
    const c = circuitById.get(f.toId)!;
    const kw = normal.circuitKW.get(c.id) ?? 0;
    paths.push({ ...f, connectedKW: kw, loading: kw / c.limitKW });
  }
  const rackKW = new Map(normal.racks.map((o) => [o.id, o]));
  for (const t of taps) {
    const o = rackKW.get(t.toId);
    paths.push({ ...t, connectedKW: o ? (t.side === 'A' ? o.kwA : o.kwB) : 0 });
  }
  return plane;
}

export function analyzePowerPaths(project: Project, analysis?: ProjectAnalysis): PowerPath[] {
  return buildPowerPlane(project, analysis).paths;
}

// ───────────────────────────── scenario evaluation ─────────────────────────────

interface EvalInput {
  failed: Set<string>;
  /** UPS output sides running on static bypass (energized, unprotected) */
  bypassSides: Set<'A' | 'B'>;
  /** racks shed by the generator load-shedding rule */
  shed: Set<string>;
  loadFactor: number;
}

export interface EvalOutput {
  racks: PowerRackOutcome[];
  circuitKW: Map<string, number>;
}

/** End state of one rack under a failure set (r2-platform.md §1.3; see the header). */
function rackOutcome(r: PowerPlaneRack, inp: EvalInput): PowerRackOutcome {
  const P = r.kw * inp.loadFactor;
  const cA = r.circuits.A;
  const cB = r.circuits.B;
  const aliveA = !!cA && !inp.failed.has(cA);
  const aliveB = !!cB && !inp.failed.has(cB);
  let state: PowerRackState = 'normal';
  let kwA = 0;
  let kwB = 0;
  let reason: string | undefined;
  if (inp.shed.has(r.id)) {
    state = 'dropped';
    reason = 'shed (generator shortfall)';
  } else if (r.cord.sides === 1) {
    const alive = r.cord.side === 'A' ? aliveA : aliveB;
    if (alive) {
      if (r.cord.side === 'A') kwA = P;
      else kwB = P;
    } else {
      state = 'dropped';
      reason = 'single-corded rack on the failed side';
    }
  } else if (aliveA && aliveB) {
    kwA = P / 2;
    kwB = P / 2;
  } else if (aliveA || aliveB) {
    const cap = r.cord.shelvesPerSide * r.cord.shelfKW;
    let kw = P;
    if (P <= cap + EPS) {
      state = 'single-path';
    } else if (r.cord.cappable && cap >= r.cord.minKW - EPS && cap > 0) {
      state = 'capped';
      kw = cap;
      reason = `surviving shelves ${r.cord.shelvesPerSide} × ${r.cord.shelfKW} kW < ${round1(P)} kW`;
    } else {
      state = 'dropped';
      kw = 0;
      reason = cap < r.cord.minKW ? 'surviving shelf capacity below the rack minimum' : 'surviving shelf capacity below demand and no power capping';
    }
    if (aliveA) kwA = kw;
    else kwB = kw;
  } else {
    state = 'dropped';
    reason = 'both feeds lost';
  }
  if (state !== 'dropped' && inp.bypassSides.size) {
    const sides = [kwA > 0 ? 'A' : null, kwB > 0 ? 'B' : null].filter(Boolean) as ('A' | 'B')[];
    const onBypass = sides.filter((x) => inp.bypassSides.has(x));
    if (sides.length && onBypass.length === sides.length) {
      if (state === 'normal' || state === 'single-path') state = 'on-bypass';
      reason = 'fed only through a UPS on static bypass (unprotected)';
    } else if (onBypass.length && state === 'normal') {
      state = 'single-path';
      reason = 'one side on UPS bypass: protected through one UPS only';
    }
  }
  return { id: r.id, state, kwA, kwB, demandKW: P, reason };
}

function evalRacks(plane: PowerPlane, inp: EvalInput): EvalOutput {
  const circuitKW = new Map<string, number>();
  const add = (id: string | undefined, kw: number) => {
    if (id && kw > 0) circuitKW.set(id, (circuitKW.get(id) ?? 0) + kw);
  };
  const out: PowerRackOutcome[] = [];
  for (const r of plane.racks) {
    const o = rackOutcome(r, inp);
    add(r.circuits.A, o.kwA);
    add(r.circuits.B, o.kwB);
    out.push(o);
  }
  return { racks: out, circuitKW };
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function scoreOf(plane: PowerPlane, ev: EvalOutput, failed: Set<string>): [number, number] {
  let max = 0;
  for (const c of plane.circuits) if (!failed.has(c.id)) max = Math.max(max, (ev.circuitKW.get(c.id) ?? 0) / c.limitKW);
  let lost = 0;
  for (const r of ev.racks) if (r.state === 'dropped' || r.state === 'capped') lost += r.demandKW - r.kwA - r.kwB;
  return [max, lost];
}

/** Greedy worst-case selection: pick k groups, each maximising (max loading elsewhere, lost kW); ties → lowest id. */
function pickWorst(plane: PowerPlane, groups: Map<string, string[]>, k: number, loadFactor: number): string[] {
  const chosen: string[] = [];
  const ids = [...groups.keys()].sort();
  for (let i = 0; i < Math.min(k, ids.length); i++) {
    let best: string | null = null;
    let bestScore: [number, number] = [-1, -1];
    for (const id of ids) {
      if (chosen.includes(id)) continue;
      const failed = new Set([...chosen, id].flatMap((g) => groups.get(g) ?? []));
      const s = scoreOf(plane, evalRacks(plane, { failed, bypassSides: new Set(), shed: new Set(), loadFactor }), failed);
      if (s[0] > bestScore[0] + 1e-9 || (Math.abs(s[0] - bestScore[0]) <= 1e-9 && s[1] > bestScore[1] + 1e-9)) {
        best = id;
        bestScore = s;
      }
    }
    if (best) chosen.push(best);
  }
  return chosen;
}

export interface UpsSystem { id: string; side: 'A' | 'B' | 'C' | 'block'; modules: number; unitKVA: number }

export function upsSystems(analysis: ProjectAnalysis): UpsSystem[] {
  const unit = analysis.power.ups.unitKVA || 1;
  return analysis.power.oneLine.nodes
    .filter((n: OneLineNode) => n.kind === 'ups')
    .map((n) => ({ id: n.id, side: n.path ?? ('block' as const), modules: Math.round((n.ratingKVA ?? 0) / unit), unitKVA: unit }))
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/**
 * Block-redundant UPS: busway circuits → active blocks (fix v2 2차, QA). Circuits in descending normal load go to the least-loaded
 * block that feeds none of the opposite-side circuits of their racks, so a rack's A and B cords always sit on different blocks and
 * a failed row side spreads over several blocks. Deterministic (ties by block order, then circuit id).
 */
export function assignBlocks(plane: PowerPlane, diversity: number, blocks: readonly UpsSystem[], normalEv?: EvalOutput): Map<string, string> {
  const out = new Map<string, string>();
  if (!blocks.length) return out;
  const normal = normalEv ?? evalRacks(plane, { failed: new Set(), bypassSides: new Set(), shed: new Set(), loadFactor: 1 });
  const rackById = new Map(plane.racks.map((r) => [r.id, r]));
  const load = new Map<string, number>();
  for (const o of normal.racks) {
    const r = rackById.get(o.id);
    if (!r) continue;
    const f = r.itLoad ? diversity : 1;
    if (r.circuits.A) load.set(r.circuits.A, (load.get(r.circuits.A) ?? 0) + o.kwA * f);
    if (r.circuits.B) load.set(r.circuits.B, (load.get(r.circuits.B) ?? 0) + o.kwB * f);
  }
  const blockLoad = new Map(blocks.map((b) => [b.id, 0]));
  const order = [...plane.circuits].sort((a, b) => (load.get(b.id) ?? 0) - (load.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  for (const c of order) {
    const other = c.side === 'A' ? 'B' : 'A';
    const forbidden = new Set<string>();
    for (const rid of c.rackIds) {
      const oc = rackById.get(rid)?.circuits[other];
      const ob = oc ? out.get(oc) : undefined;
      if (ob) forbidden.add(ob);
    }
    let pick: UpsSystem | undefined;
    for (const b of blocks) if (!forbidden.has(b.id) && (!pick || blockLoad.get(b.id)! < blockLoad.get(pick.id)! - EPS)) pick = b;
    if (!pick) for (const b of blocks) if (!pick || blockLoad.get(b.id)! < blockLoad.get(pick.id)! - EPS) pick = b;
    out.set(c.id, pick!.id);
    blockLoad.set(pick!.id, blockLoad.get(pick!.id)! + (load.get(c.id) ?? 0));
  }
  return out;
}

export interface PowerScenarioReport extends PowerScenarioResult {
  failedIds: string[];
  racks: PowerRackOutcome[];
  elements: PowerElementResult[];
  summary: PowerScenarioSummary;
}

export function evaluatePowerScenario(project: Project, analysis: ProjectAnalysis, scenario: PowerScenario): PowerScenarioReport {
  const plane = buildPowerPlane(project, analysis);
  const pd = project.power;
  const pa = analysis.power;
  const rule = plane.rule;
  const lf = scenario.loadFactor ?? 1;
  const notes: string[] = [];
  const failed = new Set<string>();
  const failedIds: string[] = [];
  const bypassSides = new Set<'A' | 'B'>();
  const shed = new Set<string>();
  const upsState = new Map<string, { alive: number; state: PowerElementResult['state'] }>();
  let genFailed = 0;
  let onGenerators = false;
  let utilityLost: string[] = [];
  let ancillaryShedKW = 0;

  notes.push(`Continuous limit (${rule.profile.toUpperCase()}): ${rule.rule} — ${rule.sourceType}; ${rule.citation}.`);
  if (lf !== 1) notes.push(`IT load factor ${round1(lf * 100)} % applied to rack allocation (nameplate × loadFactor).`);

  const circuitIds = new Set(plane.circuits.map((c) => c.id));
  const circuitBusway = new Map(plane.circuits.map((c) => [c.id, c.buswayId]));

  if (scenario.kind === 'busway-failure' || scenario.kind === 'rpp-failure') {
    const byBusway = scenario.kind === 'rpp-failure';
    const groups = new Map<string, string[]>();
    if (byBusway) for (const [b, ids] of plane.buswayCircuits) groups.set(b, ids);
    else for (const c of plane.circuits) groups.set(c.id, [c.id]);
    let targets: string[];
    if (scenario.targetIds?.length) {
      targets = [...new Set(scenario.targetIds.map((id) => (byBusway ? (plane.buswayCircuits.has(id) ? id : circuitBusway.get(id)) : circuitIds.has(id) ? id : undefined)).filter((x): x is string => !!x))];
      const fromBusway = !byBusway ? scenario.targetIds.flatMap((id) => plane.buswayCircuits.get(id) ?? []) : [];
      targets = [...new Set([...targets, ...fromBusway])];
      notes.push(`Failed ${byBusway ? 'row-side distribution (RPP / busway feed)' : 'busway circuit'}(s) chosen by the user.`);
    } else {
      targets = pickWorst(plane, groups, Math.max(1, scenario.count ?? 1), lf);
      notes.push(`Worst case: greedy selection of ${targets.length} ${byBusway ? 'row-side distribution group' : 'busway circuit'}(s) maximising the highest loading elsewhere, ties by id.`);
    }
    for (const t of targets) for (const c of groups.get(t) ?? [t]) failed.add(c);
    failedIds.push(...targets);
    notes.push('Dual-corded racks move to the surviving side (N+N shelves → single-path; fewer shelves → capped at the surviving shelf capacity, dropped below the rack minimum); single-corded racks on the failed side drop. Overloaded runs are flagged, not tripped.');
  }

  const systems = upsSystems(analysis);
  const pfIT = pd.powerFactor;
  const criticalKW = pa.ups.requiredKVA * pfIT;
  const critMech = Math.max(0, criticalKW - pa.itDesignKW);
  const sideOfSystem = (s: UpsSystem): 'A' | 'B' | null => (s.side === 'A' || s.side === 'B' ? s.side : null);
  const blockOf = assignBlocks(plane, pd.diversityFactor, systems.filter((s) => s.side === 'block'));

  if (scenario.kind === 'ups-module-failure') {
    const k = Math.max(1, scenario.count ?? 1);
    const pre = evalRacks(plane, { failed, bypassSides, shed, loadFactor: lf });
    const load = upsLoads(plane, pre, pd.diversityFactor, critMech, systems, blockOf);
    const cands = systems.filter((s) => s.side !== 'C' && (!scenario.targetIds?.length || scenario.targetIds.includes(s.id)));
    // worst: highest loading after losing k modules, ties by id
    const target = [...cands].sort((a, b) => {
      const la = (load.get(a.id) ?? 0) / Math.max(EPS, (a.modules - k) * a.unitKVA * pfIT);
      const lb = (load.get(b.id) ?? 0) / Math.max(EPS, (b.modules - k) * b.unitKVA * pfIT);
      return lb - la || a.id.localeCompare(b.id);
    })[0];
    if (target) {
      failedIds.push(`${target.id}:module×${k}`);
      const alive = Math.max(0, target.modules - k);
      const cap = alive * target.unitKVA * pfIT;
      const L = load.get(target.id) ?? 0;
      const reserve = systems.find((s) => s.side === 'C');
      const reserveCap = reserve ? reserve.modules * reserve.unitKVA * pfIT : 0;
      if (L <= cap + EPS) {
        upsState.set(target.id, { alive, state: 'reduced-redundancy' });
        notes.push(`${target.id}: ${alive}/${target.modules} modules carry ${round1(L)} kW ≤ ${round1(cap)} kW — normal, redundancy reduced.`);
      } else if (reserve && L <= reserveCap + EPS) {
        upsState.set(target.id, { alive, state: 'transferred' });
        notes.push(`${target.id}: ${round1(L)} kW > ${round1(cap)} kW on ${alive} modules → load transferred to reserve block ${reserve.id} (${round1(reserveCap)} kW) through STS (block-redundant catcher rule).`);
      } else {
        upsState.set(target.id, { alive, state: 'on-bypass' });
        const s = sideOfSystem(target);
        if (s) bypassSides.add(s);
        notes.push(`${target.id}: ${round1(L)} kW > ${round1(cap)} kW on ${alive} modules${reserve ? ` and > reserve ${round1(reserveCap)} kW` : ''} → static bypass: side ${s ?? '?'} stays energized but unprotected; dual-corded loads do not shift away from an overloaded UPS.`);
      }
    }
  }

  // utility / generators
  const feeds = project.site.utility;
  // fix v2 2차 (QA): utility / generator checks use the scenario facility load F(lf) = (IT design + mechanical + losses) · lf + ancillary
  // (losses and mechanical track the IT load; ancillary lighting / BMS stays) — was the design facility kW at every load factor
  const ancillary = pa.ancillaryKW ?? 0;
  const facilityAtLf = (pa.itDesignKW + pa.mechanicalKW + pa.lossesKW - ancillary) * lf + ancillary;
  const requiredMVA = lf === 1 ? pa.utilityRequiredMVA : (pa.utilityRequiredMVA * facilityAtLf) / Math.max(EPS, pa.facilityKW);
  let facilityKW = facilityAtLf;
  if (scenario.kind === 'utility-loss' || scenario.kind === 'generator-failure') {
    if (scenario.kind === 'utility-loss') {
      const k = Math.max(1, scenario.count ?? 1);
      utilityLost = scenario.targetIds?.length
        ? scenario.targetIds.filter((id) => feeds.some((f) => f.id === id))
        : [...feeds].sort((a, b) => b.capacityMVA - a.capacityMVA || a.id.localeCompare(b.id)).slice(0, k).map((f) => f.id);
      failedIds.push(...utilityLost);
      const remaining = feeds.filter((f) => !utilityLost.includes(f.id)).reduce((s, f) => s + f.capacityMVA, 0);
      if (remaining + EPS >= requiredMVA && remaining > 0) {
        notes.push(`Utility: ${utilityLost.join(', ')} lost; remaining ${round1(remaining)} MVA carries the required ${round1(requiredMVA)} MVA (${round1((requiredMVA / remaining) * 100)} %). Generators stay on standby; the genset N+1 check below applies if the remaining feed also trips.`);
      } else {
        onGenerators = true;
        notes.push(`Utility: ${utilityLost.join(', ')} lost; remaining ${round1(remaining)} MVA < required ${round1(requiredMVA)} MVA → generators carry the facility.`);
      }
    } else {
      onGenerators = true;
      genFailed = Math.max(1, scenario.count ?? 1);
      failedIds.push(`gen×${genFailed}`);
      notes.push(`Generator failure: utility lost, ${genFailed} genset(s) fail to start.`);
    }
    const bridge = pd.batteryMinutes * 60;
    notes.push(bridge >= TRANSFER_S
      ? `UPS battery ${pd.batteryMinutes} min ≥ ${TRANSFER_S} s generator start + transfer (NFPA 110 Type 10, standard, not re-read).`
      : `UPS battery ${pd.batteryMinutes} min < ${TRANSFER_S} s generator start + transfer (NFPA 110 Type 10) — critical load is not bridged.`);
    const usable = Math.max(0, pa.generators.units - genFailed) * pa.generators.unitKW * GEN_DERATE;
    if (onGenerators && facilityKW > usable + EPS) {
      // shed: (1) ancillary loads, (2) GPU/IT racks lowest priority first, latest wave first, then id
      let short = facilityKW - usable;
      ancillaryShedKW = Math.min(short, pa.ancillaryKW ?? 0);
      short -= ancillaryShedKW;
      const pueDesign = pa.itDesignKW > 0 ? pa.facilityKW / pa.itDesignKW : 1;
      const order = [...plane.racks].filter((r) => r.kw > 0).sort((a, b) => a.cord.priority - b.cord.priority || (b.waveId ?? '').localeCompare(a.waveId ?? '') || b.id.localeCompare(a.id));
      let rackShedKW = 0;
      for (const r of order) {
        if (short <= EPS) break;
        shed.add(r.id);
        const kw = r.kw * lf * (r.itLoad ? pd.diversityFactor : 1) * pueDesign;
        short -= kw;
        rackShedKW += kw;
      }
      notes.push(`Generator shortfall ${round1(facilityKW - usable)} kW: shed ${round1(ancillaryShedKW)} kW ancillary, then ${shed.size} rack(s) (${round1(rackShedKW)} kW incl. their mechanical share at design PUE ${pueDesign.toFixed(2)}) by priority → wave → id (derate ${GEN_DERATE}, estimate).`);
      facilityKW -= ancillaryShedKW + rackShedKW;
    }
  }

  const ev = evalRacks(plane, { failed, bypassSides, shed, loadFactor: lf });

  // paths
  const warnFrac = rule.warnAt / rule.continuousLimit;
  const paths = plane.circuits.map((c) => {
    const kw = failed.has(c.id) ? 0 : ev.circuitKW.get(c.id) ?? 0;
    const loading = kw / c.limitKW;
    return { id: c.id, loadingPct: loading * 100, overloaded: loading > 1 + 1e-9, kw, warn: loading > warnFrac + 1e-9 };
  });

  // elements
  const elements: PowerElementResult[] = [];
  const hallName = new Map(project.halls.map((h) => [h.id, h.name]));
  for (const room of plane.rooms) {
    const kw = plane.circuits.filter((c) => c.roomId === room.id).reduce((s, c) => s + (failed.has(c.id) ? 0 : ev.circuitKW.get(c.id) ?? 0), 0);
    elements.push({ id: room.switchboardId, kind: 'switchboard', label: `${hallName.get(room.hallId) ?? room.hallId} · switchboard ${room.side}`, side: room.side, loadKW: kw, overloaded: false, state: 'normal' });
  }
  const loads = upsLoads(plane, ev, pd.diversityFactor, critMech, systems, blockOf);
  let upsMarginPct: number | undefined;
  for (const s of systems) {
    const st = upsState.get(s.id);
    const alive = st?.alive ?? s.modules;
    const cap = alive * s.unitKVA * pfIT;
    const transferred = st?.state === 'transferred';
    const L = s.side === 'C' ? [...upsState.entries()].filter(([, v]) => v.state === 'transferred').reduce((acc, [id]) => acc + (loads.get(id) ?? 0), 0) : transferred ? 0 : loads.get(s.id) ?? 0;
    const capC = s.modules * s.unitKVA * pfIT;
    const capacityKW = s.side === 'C' ? capC : cap;
    const loadingPct = capacityKW > 0 ? (L / capacityKW) * 100 : undefined;
    const overloaded = loadingPct !== undefined && loadingPct > 100 + 1e-9 && st?.state !== 'on-bypass';
    const state: PowerElementResult['state'] = st?.state ?? (s.side === 'C' && L === 0 ? 'standby' : 'normal');
    elements.push({ id: s.id, kind: 'ups', label: `${s.side === 'block' ? `UPS block ${s.id.replace(/^ups-/, '')}` : s.side === 'C' && systems.some((x) => x.side === 'block') ? 'Catcher UPS' : `UPS ${s.side}`} · ${alive}/${s.modules} × ${s.unitKVA} kVA`, side: s.side === 'block' ? undefined : s.side, loadKW: L, capacityKW, loadingPct, overloaded, state });
    if (s.side !== 'C' && capacityKW > 0 && L > 0) upsMarginPct = Math.min(upsMarginPct ?? Infinity, (capacityKW / L - 1) * 100);
  }
  // block-redundant design check (polish v2 2차): engines/power.ts sizes generated designs so every block survives the N-1 set;
  // a user-overridden arrangement (project.power.upsBlocks) that does not is reported here and by validate.ts (power-ups-block-headroom)
  const sizing = pa.upsSizing;
  if (scenario.kind === 'normal' && blockOf.size && sizing && !sizing.survives) {
    notes.push(`Design check: UPS blocks ${sizing.activeBlocks} × ${sizing.blockModules} modules (+ catcher) reach ${round1(sizing.worstPct)} % under ${sizing.worstContingency}${sizing.override ? ' (user arrangement)' : ''} — add modules per block or blocks.`);
  }
  const genCap = Math.max(0, pa.generators.units - genFailed) * pa.generators.unitKW * GEN_DERATE;
  const genLoad = onGenerators ? Math.min(facilityKW, genCap > 0 ? facilityKW : 0) : 0;
  const gensetMarginPct = scenario.kind === 'utility-loss' || scenario.kind === 'generator-failure' ? (genCap > 0 ? (genCap / facilityAtLf - 1) * 100 : -100) : undefined;
  elements.push({
    id: 'gen', kind: 'generator', label: `Generators · ${Math.max(0, pa.generators.units - genFailed)}/${pa.generators.units} × ${pa.generators.unitKW} kW`,
    loadKW: genLoad, capacityKW: genCap, loadingPct: genCap > 0 ? (genLoad / genCap) * 100 : undefined,
    overloaded: onGenerators && facilityAtLf > genCap + EPS, state: onGenerators ? (facilityAtLf > genCap + EPS ? 'shortfall' : 'carrying') : 'standby',
  });
  if (scenario.kind === 'utility-loss' || scenario.kind === 'generator-failure') {
    const nPlus1 = Math.max(0, pa.generators.units - genFailed - 1) * pa.generators.unitKW * GEN_DERATE;
    notes.push(`Gensets: ${round1(genCap)} kW usable (${Math.max(0, pa.generators.units - genFailed)} × ${pa.generators.unitKW} kW × ${GEN_DERATE}) vs facility ${round1(facilityAtLf)} kW${lf !== 1 ? ` at ${round1(lf * 100)} % IT load` : ''} → margin ${round1(gensetMarginPct ?? 0)} %; with one more unit out ${round1(nPlus1)} kW → N+1 ${nPlus1 + EPS >= facilityAtLf ? 'holds' : 'does not hold'}.`);
  }
  let utilityMarginPct: number | undefined;
  for (const f of feeds) {
    const lost = utilityLost.includes(f.id) || scenario.kind === 'generator-failure';
    const remaining = feeds.filter((g) => !(utilityLost.includes(g.id) || scenario.kind === 'generator-failure')).reduce((s, g) => s + g.capacityMVA, 0);
    const share = remaining > 0 && !lost ? (requiredMVA * f.capacityMVA) / remaining : 0;
    const capacityKW = f.capacityMVA * 1000 * SITE_PF;
    elements.push({ id: `util-${f.id}`, kind: 'utility', label: `${f.name} · ${f.capacityMVA} MVA`, loadKW: onGenerators ? 0 : share * 1000 * SITE_PF, capacityKW, loadingPct: onGenerators || lost ? (lost ? undefined : 0) : (share / f.capacityMVA) * 100, overloaded: false, state: lost ? 'lost' : onGenerators ? 'standby' : 'carrying' });
  }
  const remainingMVA = feeds.filter((g) => !(utilityLost.includes(g.id) || scenario.kind === 'generator-failure')).reduce((s, g) => s + g.capacityMVA, 0);
  if (remainingMVA > 0) utilityMarginPct = (remainingMVA / requiredMVA - 1) * 100;

  // summary
  const gpusById = new Map(plane.racks.map((r) => [r.id, r.gpus]));
  const nonNormal = ev.racks.filter((r) => r.state !== 'normal');
  const dropped = nonNormal.filter((r) => r.state === 'dropped');
  const capped = nonNormal.filter((r) => r.state === 'capped');
  let worst: (typeof paths)[number] | undefined;
  for (const p of paths) if (!failed.has(p.id) && (!worst || p.loadingPct > worst.loadingPct + 1e-9)) worst = p;
  const summary: PowerScenarioSummary = {
    profile: rule.profile,
    limitFactor: rule.continuousLimit,
    warnAt: rule.warnAt,
    worstPathId: worst?.id,
    worstLoadingPct: worst?.loadingPct ?? 0,
    overloadedPaths: paths.filter((p) => p.overloaded).length,
    warnPaths: paths.filter((p) => p.warn && !p.overloaded).length,
    droppedRacks: dropped.length,
    droppedGpus: dropped.reduce((s, r) => s + (gpusById.get(r.id) ?? 0), 0),
    droppedKW: dropped.reduce((s, r) => s + r.demandKW, 0),
    cappedRacks: capped.length,
    cappedKW: capped.reduce((s, r) => s + r.demandKW - r.kwA - r.kwB, 0),
    singlePathRacks: nonNormal.filter((r) => r.state === 'single-path').length,
    bypassRacks: nonNormal.filter((r) => r.state === 'on-bypass').length,
    gensetMarginPct,
    upsMarginPct: upsMarginPct === Infinity ? undefined : upsMarginPct,
    utilityMarginPct,
  };
  if (summary.overloadedPaths) notes.push(`${summary.overloadedPaths} busway circuit(s) above the continuous limit.`);
  if (capped.length) notes.push(`${capped.length} rack(s) capped (${round1(summary.cappedKW)} kW curtailed). Power capping is assumed for GPU racks (DPS / BMC power limit, estimate — verify the platform behaviour).`);

  return {
    scenario,
    paths,
    droppedEquipmentIds: dropped.map((r) => r.id),
    notes,
    failedIds,
    racks: nonNormal,
    elements,
    summary,
  };
}

/** UPS output load per system (design basis of engines/power.ts: IT racks × diversity + UPS-backed mechanical by share). */
function upsLoads(plane: PowerPlane, ev: EvalOutput, diversity: number, critMech: number, systems: UpsSystem[], blockOf?: Map<string, string>): Map<string, number> {
  const rackById = new Map(plane.racks.map((r) => [r.id, r]));
  const out = new Map<string, number>();
  const blocks = systems.filter((s) => s.side === 'block');
  if (blocks.length && blockOf) {
    // block-redundant: each cord's load lands on the block feeding its circuit; mechanical by IT share
    const it = new Map(blocks.map((b) => [b.id, 0]));
    for (const o of ev.racks) {
      const r = rackById.get(o.id);
      const f = r?.itLoad ? diversity : 1;
      const bA = (r?.circuits.A && blockOf.get(r.circuits.A)) || blocks[0].id;
      const bB = (r?.circuits.B && blockOf.get(r.circuits.B)) || blocks[0].id;
      it.set(bA, it.get(bA)! + o.kwA * f);
      it.set(bB, it.get(bB)! + o.kwB * f);
    }
    const tot = [...it.values()].reduce((s, v) => s + v, 0);
    for (const b of blocks) out.set(b.id, it.get(b.id)! + (tot > 0 ? (critMech * it.get(b.id)!) / tot : critMech / blocks.length));
    return out;
  }
  let a = 0;
  let b = 0;
  for (const o of ev.racks) {
    const f = rackById.get(o.id)?.itLoad ? diversity : 1;
    a += o.kwA * f;
    b += o.kwB * f;
  }
  const tot = a + b;
  const mA = tot > 0 ? critMech * (a / tot) : critMech / 2;
  const mB = critMech - mA;
  const hasB = systems.some((s) => s.side === 'B');
  for (const s of systems) {
    if (s.side === 'A') out.set(s.id, hasB ? a + mA : a + b + critMech);
    else if (s.side === 'B') out.set(s.id, b + mB);
  }
  return out;
}

// ───────────────────────────── UPS block sizing & electrical rooms (polish v2 2차) ─────────────────────────────

export interface UpsBlockSizingInput {
  /** N = ⌈required kVA ÷ module kVA⌉ */
  baseModules: number;
  moduleKVA: number;
  powerFactor: number;
  diversity: number;
  /** UPS-backed mechanical load (engines/power.ts criticalMech) */
  critMechKW: number;
  override?: { blockModules: number; activeBlocks: number };
}

/**
 * Block-redundant / DR UPS arrangement sized from the design's own N-1 set (r2-platform.md §1.3 block-redundant catcher rule and the
 * §1.3 DR survivability rule "L_b ≤ C", computed exactly from the actual cord → block assignment instead of an even-spread (K−1)/K):
 *
 *  contingencies = normal + every single busway circuit failure + every single row-side distribution (RPP / busway feed) failure,
 *                  evaluated with the plane's rack end states (dual-corded shift, capping) at load factor 1;
 *  block load    = Σ cord kW × diversity on the circuits assigned to the block + UPS-backed mechanical by IT share (upsLoads, the same
 *                  function the scenario evaluator uses) — the busway circuit counts and shifts follow the profile continuous limit;
 *  survives      ⇔ every active block ≤ 100 % of s · module kVA · PF in every contingency. A single module failure is then covered:
 *                  normal load ≤ s modules = the catcher block → reduced redundancy or transfer.
 *
 * Candidates (s modules per block, K active blocks): s from ⌈N/4⌉ (the base block rule of layout/estimates.ts upsBlocks) to N,
 * K from ⌈N/s⌉ to ⌈N/s⌉ + 2; ordered by installed modules (K + 1)·s, then fewer blocks, then smaller blocks. The first survivor is
 * chosen; when none survives (or the user fixed the arrangement) the base / user arrangement is kept with survives = false.
 */
export function sizeUpsBlocks(plane: PowerPlane, inp: UpsBlockSizingInput): UpsBlockSizing {
  const n = Math.max(1, inp.baseModules);
  const moduleKW = inp.moduleKVA * inp.powerFactor;
  const rule = 'UPS blocks sized so every active block stays ≤ 100 % in normal and every single busway circuit / row-side distribution failure; catcher block = block size (derived)';
  const none = { failed: new Set<string>(), bypassSides: new Set<'A' | 'B'>(), shed: new Set<string>(), loadFactor: 1 };
  const normal = evalRacks(plane, none);
  // incremental contingencies: only racks on the failed circuits change state, so each case stores the diversity-weighted cord-kW
  // deltas per circuit index (last slot = cords without a circuit → first block, as upsLoads does). Block sums are then exact and
  // O(changed cords) per case instead of a full plane evaluation (polish v2 2차: DU 40 × 36 racks/row stays fast).
  const cIndex = new Map(plane.circuits.map((c, i) => [c.id, i]));
  const NC = plane.circuits.length;
  const rackById = new Map(plane.racks.map((r) => [r.id, r]));
  const o0 = new Map(normal.racks.map((o) => [o.id, o]));
  const slot = (cid: string | undefined) => (cid !== undefined ? cIndex.get(cid) ?? NC : NC);
  const w0 = new Float64Array(NC + 1);
  for (const r of plane.racks) {
    const o = o0.get(r.id)!;
    const f = r.itLoad ? inp.diversity : 1;
    w0[slot(r.circuits.A)] += o.kwA * f;
    w0[slot(r.circuits.B)] += o.kwB * f;
  }
  const circuitById = new Map(plane.circuits.map((c) => [c.id, c]));
  const cases: { label: string; idx: number[]; delta: number[] }[] = [{ label: 'normal', idx: [], delta: [] }];
  const addCase = (label: string, ids: readonly string[]) => {
    const failed = new Set(ids);
    const idx: number[] = [];
    const delta: number[] = [];
    const seen = new Set<string>();
    for (const cid of ids) {
      for (const rid of circuitById.get(cid)?.rackIds ?? []) {
        if (seen.has(rid)) continue;
        seen.add(rid);
        const r = rackById.get(rid);
        const before = o0.get(rid);
        if (!r || !before) continue;
        const after = rackOutcome(r, { ...none, failed });
        const f = r.itLoad ? inp.diversity : 1;
        idx.push(slot(r.circuits.A), slot(r.circuits.B));
        delta.push((after.kwA - before.kwA) * f, (after.kwB - before.kwB) * f);
      }
    }
    cases.push({ label, idx, delta });
  };
  if (NC) {
    for (const c of plane.circuits) addCase(`busway ${c.id}`, [c.id]);
    for (const [b, ids] of [...plane.buswayCircuits].sort((x, y) => x[0].localeCompare(y[0]))) if (ids.length > 1) addCase(`row distribution ${b}`, ids);
  }
  // row-side cases first: they are the usual binding contingency, so failing candidates exit early
  const order = cases.map((_, i) => i).sort((a, b) => Number(cases[b].label.startsWith('row')) - Number(cases[a].label.startsWith('row')) || a - b);
  const evaluate = (sMod: number, K: number, stopAbove = Infinity): { pct: number; label: string } => {
    const blocks: UpsSystem[] = Array.from({ length: K }, (_, i) => ({ id: `ups-${i + 1}`, side: 'block' as const, modules: sMod, unitKVA: inp.moduleKVA }));
    const blockOf = assignBlocks(plane, inp.diversity, blocks, normal);
    const bIdx = new Int32Array(NC + 1);
    plane.circuits.forEach((c, i) => { bIdx[i] = Math.max(0, Number((blockOf.get(c.id) ?? 'ups-1').slice(4)) - 1); });
    const itN = new Float64Array(K);
    let totN = 0;
    for (let i = 0; i <= NC; i++) {
      itN[bIdx[i]] += w0[i];
      totN += w0[i];
    }
    let worst = { pct: 0, label: 'normal' };
    const cap = sMod * moduleKW;
    const it = new Float64Array(K);
    for (const ci of order) {
      it.set(itN);
      let tot = totN;
      const { idx, delta } = cases[ci];
      for (let j = 0; j < idx.length; j++) {
        it[bIdx[idx[j]]] += delta[j];
        tot += delta[j];
      }
      for (let b = 0; b < K; b++) {
        const load = it[b] + (tot > 0 ? (inp.critMechKW * it[b]) / tot : inp.critMechKW / K);
        const pct = cap > 0 ? (load / cap) * 100 : Infinity;
        if (pct > worst.pct + 1e-9) worst = { pct, label: cases[ci].label };
      }
      if (worst.pct > stopAbove) return worst;
    }
    return worst;
  };
  const report = (sMod: number, K: number, w: { pct: number; label: string }, override: boolean): UpsBlockSizing => ({
    baseModules: n, blockModules: sMod, activeBlocks: K, modules: (K + 1) * sMod, worstPct: w.pct, worstContingency: w.label,
    contingencies: cases.length, survives: w.pct <= 100 + 1e-9, override, rule,
  });
  if (inp.override && inp.override.blockModules >= 1 && inp.override.activeBlocks >= 1) {
    const sMod = Math.round(inp.override.blockModules);
    const K = Math.round(inp.override.activeBlocks);
    return report(sMod, K, evaluate(sMod, K), true);
  }
  const s0 = Math.max(1, Math.ceil(n / 4));
  const cands: { s: number; K: number }[] = [];
  for (let sMod = s0; sMod <= n; sMod++) {
    const k0 = Math.max(1, Math.ceil(n / sMod));
    for (let K = k0; K <= k0 + 2; K++) cands.push({ s: sMod, K });
  }
  cands.sort((a, b) => (a.K + 1) * a.s - (b.K + 1) * b.s || a.K - b.K || a.s - b.s);
  for (const c of cands) {
    const w = evaluate(c.s, c.K, 100 + 1e-9);
    if (w.pct <= 100 + 1e-9) return report(c.s, c.K, evaluate(c.s, c.K), false);
  }
  const base = { s: s0, K: Math.max(1, Math.ceil(n / s0)) };
  return report(base.s, base.K, evaluate(base.s, base.K), false);
}

export interface ElectricalRoomSizingInput {
  /** installed UPS modules on the A / B switchgear side (site total; each hall's rooms take the hall's IT share) */
  upsModulesBySide: { A: number; B: number };
  moduleKVA: number;
  powerFactor: number;
  batteryMinutes: number;
  /** hall id → share of the site IT design load (0..1) */
  hallShare: Map<string, number>;
  upsItem?: CatalogItem;
}

/**
 * Size every plane room from its equipment (polish v2 2차, QA m5) and write the sized rectangles back onto the cached plane rooms.
 *  equipment per room: UPS modules = ⌈side modules × hall share⌉, battery cabinets = ⌈modules × kVA·PF·min/60 × margin ÷ cabinet kWh⌉,
 *                      switchboard sections = ⌈room circuits ÷ feeders per section⌉ + incomers;
 *  lineups along the wall: usable length = room length − 2 end aisles; switchboard rows first (hall side), then UPS + battery rows
 *                      (one module kept with its cabinets);
 *  depth = Σ rows (lineup depth + front working space) + far-wall margin.
 * Conflicts with other halls are re-checked on the sized rectangle.
 */
export function sizeElectricalRooms(project: Project, plane: PowerPlane, inp: ElectricalRoomSizingInput): PowerRoom[] {
  const F = ELECTRICAL_ROOM_FOOTPRINT;
  const ups = { w: inp.upsItem?.dims.w ?? F.upsModule.w, d: inp.upsItem?.dims.d ?? F.upsModule.d, frontM: inp.upsItem?.clearance?.front ?? F.upsModule.frontM };
  const cabinetsPerModule = Math.max(1, Math.ceil((inp.moduleKVA * inp.powerFactor * (inp.batteryMinutes / 60) * F.batteryCabinet.margin) / F.batteryCabinet.usableKWh - 1e-9));
  const hallById = new Map(project.halls.map((h) => [h.id, h]));
  for (const room of plane.rooms) {
    const hall = hallById.get(room.hallId);
    if (!hall) continue;
    const wall: Wall = room.wall ?? 'W';
    const lengthM = wallNormal(wall) === 'x' ? room.rect.d : room.rect.w;
    const usable = Math.max(2, lengthM - 2 * F.endAisleM);
    const circuits = plane.circuits.filter((c) => c.roomId === room.id).length;
    const sections = Math.ceil(circuits / F.switchboard.feedersPerSection) + F.switchboard.incomerSections;
    const modules = Math.ceil(inp.upsModulesBySide[room.side] * (inp.hallShare.get(room.hallId) ?? 0) - 1e-9);
    const cabinets = modules * cabinetsPerModule;
    const swbdRows = Math.max(1, Math.ceil((sections * F.switchboard.sectionW) / usable - 1e-9));
    const moduleRunM = ups.w + cabinetsPerModule * F.batteryCabinet.w;
    const perRow = Math.max(1, Math.floor(usable / moduleRunM + 1e-9));
    const upsRows = modules > 0 ? Math.ceil(modules / perRow) : 0;
    const depth = swbdRows * (F.switchboard.d + F.frontClearanceM) + upsRows * (Math.max(ups.d, F.batteryCabinet.d) + Math.max(ups.frontM, F.frontClearanceM)) + F.farWallM;
    const lo = wallNormal(wall) === 'x' ? room.rect.y : room.rect.x;
    const rect = roomRectOn(hall, wall, lo, lo + lengthM, depth);
    const hallConflict = !room.conflict && overlapsOtherHall(project, hall, rect);
    Object.assign(room, {
      rect, depthM: depth, upsModules: modules, batteryCabinets: cabinets, switchboardSections: sections, lineups: swbdRows + upsRows,
      ...(hallConflict ? { conflict: 'hall' as const } : {}),
      basis: `${modules} UPS modules (${Math.round((inp.hallShare.get(room.hallId) ?? 0) * 100)} % hall share of side ${room.side}) × ${ups.w} m + ${cabinetsPerModule} battery cabinets each, ${sections} switchboard sections; ${swbdRows} switchboard + ${upsRows} UPS lineup rows along ${round1(lengthM)} m → ${round1(depth)} m deep (${F.sourceType})`,
    });
  }
  // finish v2 2차 (QA M7): rooms of different halls must not overlap on the site (halls joined N–S with a 12 m gap did, silently)
  const site = (r: PowerRoom) => {
    const h = hallById.get(r.hallId)!;
    return { x: h.origin.x + r.rect.x, y: h.origin.y + r.rect.y, w: r.rect.w, d: r.rect.d };
  };
  for (let i = 0; i < plane.rooms.length; i++) {
    for (let j = i + 1; j < plane.rooms.length; j++) {
      const a = plane.rooms[i];
      const b = plane.rooms[j];
      if (a.hallId === b.hallId || !hallById.has(a.hallId) || !hallById.has(b.hallId)) continue;
      const p = site(a);
      const q = site(b);
      if (p.x < q.x + q.w - 0.01 && p.x + p.w > q.x + 0.01 && p.y < q.y + q.d - 0.01 && p.y + p.d > q.y + 0.01) {
        if (!a.conflict) a.conflict = 'room';
        if (!b.conflict) b.conflict = 'room';
      }
    }
  }
  return plane.rooms.map((r) => ({ ...r, rect: { ...r.rect } }));
}

// ───────────────────────────── N-1 sweep ─────────────────────────────

export interface PowerN1Row {
  id: string;
  kind: 'busway' | 'ups' | 'generator' | 'utility';
  normalPct: number;
  worstPct: number;
  /** the single contingency that produced the worst loading */
  contingency: string;
  overloaded: boolean;
}

export interface PowerN1Sweep {
  contingencies: number;
  rows: PowerN1Row[];
  worst?: PowerN1Row;
  /** racks dropped by at least one single contingency */
  droppedRackIds: string[];
}

/** N-1 sweep (r2-platform.md §1.5): every single busway circuit, row-side distribution, UPS module, genset and utility feed. */
export function sweepPowerN1(project: Project, analysis: ProjectAnalysis, loadFactor = 1): PowerN1Sweep {
  const plane = buildPowerPlane(project, analysis);
  const base = evaluatePowerScenario(project, analysis, { kind: 'normal', loadFactor });
  const rows = new Map<string, PowerN1Row>();
  for (const p of base.paths) rows.set(p.id, { id: p.id, kind: 'busway', normalPct: p.loadingPct, worstPct: p.loadingPct, contingency: 'normal', overloaded: p.overloaded });
  for (const e of base.elements) {
    if (e.kind === 'switchboard' || e.loadingPct === undefined) continue;
    rows.set(e.id, { id: e.id, kind: e.kind === 'ups' ? 'ups' : e.kind === 'generator' ? 'generator' : 'utility', normalPct: e.loadingPct, worstPct: e.loadingPct, contingency: 'normal', overloaded: e.overloaded });
  }
  const scenarios: { label: string; s: PowerScenario }[] = [
    ...plane.circuits.map((c) => ({ label: `busway ${c.id}`, s: { kind: 'busway-failure', targetIds: [c.id], loadFactor } as PowerScenario })),
    ...[...plane.buswayCircuits.keys()].sort().map((b) => ({ label: `row distribution ${b}`, s: { kind: 'rpp-failure', targetIds: [b], loadFactor } as PowerScenario })),
    ...upsSystems(analysis).filter((u) => u.side !== 'C').map((u) => ({ label: `1 module of ${u.id}`, s: { kind: 'ups-module-failure', targetIds: [u.id], count: 1, loadFactor } as PowerScenario })),
    { label: '1 genset (utility lost)', s: { kind: 'generator-failure', count: 1, loadFactor } },
    ...project.site.utility.map((f) => ({ label: `utility ${f.id}`, s: { kind: 'utility-loss', targetIds: [f.id], loadFactor } as PowerScenario })),
  ];
  const dropped = new Set<string>();
  for (const { label, s } of scenarios) {
    const r = evaluatePowerScenario(project, analysis, s);
    const failed = new Set(r.failedIds);
    for (const p of r.paths) {
      if (failed.has(p.id) || (s.kind === 'rpp-failure' && s.targetIds?.some((b) => p.id.startsWith(`${b}/`)))) continue;
      const row = rows.get(p.id);
      if (row && p.loadingPct > row.worstPct + 1e-9) Object.assign(row, { worstPct: p.loadingPct, contingency: label, overloaded: p.overloaded });
    }
    for (const e of r.elements) {
      const row = rows.get(e.id);
      if (row && e.loadingPct !== undefined && e.loadingPct > row.worstPct + 1e-9) Object.assign(row, { worstPct: e.loadingPct, contingency: label, overloaded: e.overloaded });
    }
    r.droppedEquipmentIds.forEach((id) => dropped.add(id));
  }
  const list = [...rows.values()];
  let worst: PowerN1Row | undefined;
  for (const row of list) if (row.kind === 'busway' && (!worst || row.worstPct > worst.worstPct + 1e-9)) worst = row;
  return { contingencies: scenarios.length, rows: list, worst, droppedRackIds: [...dropped].sort() };
}
