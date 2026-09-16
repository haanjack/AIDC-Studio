// r4 stream A0 (spec §2.4 Hall.verticals, r4-model-gap §4.4): level datums of a hall and the resolved vertical service stack.
// Defaults when Hall.verticals is absent (source tags per spec header):
//   slab 0.30 m (estimate, graphic only) · stack order 'pipe-busway-trays' (existing; 'trays-busway' = alternative order)
//   pipe      rackH + 0.22                          (existing)
//   busway    min(trayHeight − 0.22, rackH + 0.4)   (existing); 'trays-busway': T3 + 0.35 (estimate)
//   T1        trayHeight (scale-out)                (existing)
//   T2        T1 + 0.35 (front-end + storage + main) (existing TRAY_MAIN_RAISE_M)
//   T3        T1 + 0.70 (OOB)                       (estimate)
//   (backlog finish: `main` moved from T3 to T2 — layout/rows.ts builds the main / cross trays at T1 + TRAY_MAIN_RAISE_M, the T2 level)
//   top clearance 0.30 m above the highest service  (standard TIA-942-B, verify)
//   light     clamp(max(2.6, trayHeight), 2.6, clearHeight − 0.2) (standard) · ceiling clearHeight · deck + ceilingPlenumHeight (existing)
// Tray tier z is the deck (underside) level; pipe / busway z is the centre line. Labels are English; sheets translate by datum id.
// P0 reads the tiers only: prims stay at their model positions (per-tier tray emission is P1).
import type { Hall, HallVerticals, ServiceTier } from '../model/types.ts';
import type { Datum, DatumSource, Prim } from './prims.ts';
import { DEFAULT_SLAB_THICKNESS_M, fixtureHeight } from './shell.ts';

export const DEFAULT_TOP_CLEARANCE_M = 0.3;
export const DEFAULT_RACK_HEIGHT_M = 2.3;
export const TIER_STEP_M = 0.35;

/** datum ids in bottom-up order (custom tier ids from Hall.verticals.tiers sit between rack-top and top-clearance) */
export const DATUM_IDS = ['ffl', 'raised-floor', 'rack-top', 'containment', 'pipe', 'busway', 'T1', 'T2', 'T3', 'chimney', 'top-clearance', 'light', 'ceiling', 'deck'] as const;

export interface ResolvedTier extends ServiceTier {
  source: DatumSource;
}

export interface ResolvedVerticals {
  slabThicknessM: number;
  slabSource: DatumSource;
  stackOrder: NonNullable<HallVerticals['stackOrder']>;
  tiers: ResolvedTier[];
  /** true when Hall.verticals.tiers was given */
  explicitTiers: boolean;
  topClearanceM: number;
  topClearanceSource: DatumSource;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Tallest rack (dims height) among the rack prims; DEFAULT_RACK_HEIGHT_M when there is none. */
export function hallRackHeight(prims: readonly Prim[]): number {
  let h = 0;
  for (const p of prims) if (p.emitter === 'rack') h = Math.max(h, p.b.z - p.a.z);
  return h > 0 ? r6(h) : DEFAULT_RACK_HEIGHT_M;
}

/** Hall.verticals with every default filled in (spec §2.4). */
export function resolveVerticals(hall: Hall, rackH: number = DEFAULT_RACK_HEIGHT_M, verticals: HallVerticals | undefined = hall.verticals): ResolvedVerticals {
  const zt = hall.trayHeight > 0 ? hall.trayHeight : 2.9;
  const stackOrder = verticals?.stackOrder ?? 'pipe-busway-trays';
  const explicitTiers = !!verticals?.tiers?.length;
  let tiers: ResolvedTier[];
  if (explicitTiers) {
    tiers = verticals!.tiers!.map((t) => ({ ...t, carries: [...t.carries], z: r6(t.z), source: 'existing' as const }));
  } else {
    const pipe: ResolvedTier = { id: 'pipe', kind: 'pipe', carries: ['tcs'], z: r6(rackH + 0.22), heightM: 0.11, source: 'existing' };
    const T1: ResolvedTier = { id: 'T1', kind: 'tray', carries: ['scale-out'], z: r6(zt), heightM: 0.096, widthM: 0.3, source: 'existing' };
    const T2: ResolvedTier = { id: 'T2', kind: 'tray', carries: ['frontend', 'storage', 'main'], z: r6(zt + TIER_STEP_M), heightM: 0.096, widthM: 0.45, source: 'existing' };
    const T3: ResolvedTier = { id: 'T3', kind: 'tray', carries: ['oob'], z: r6(zt + 2 * TIER_STEP_M), heightM: 0.096, widthM: 0.3, source: 'estimate' };
    const busway: ResolvedTier =
      stackOrder === 'trays-busway'
        ? { id: 'busway', kind: 'busway', carries: ['power-a', 'power-b'], z: r6(zt + 3 * TIER_STEP_M), heightM: 0.13, widthM: 0.17, source: 'estimate' }
        : { id: 'busway', kind: 'busway', carries: ['power-a', 'power-b'], z: r6(Math.min(zt - 0.22, rackH + 0.4)), heightM: 0.13, widthM: 0.17, source: 'existing' };
    tiers = stackOrder === 'trays-busway' ? [pipe, T1, T2, T3, busway] : [pipe, busway, T1, T2, T3];
  }
  return {
    slabThicknessM: verticals?.slabThicknessM ?? DEFAULT_SLAB_THICKNESS_M,
    slabSource: verticals?.slabThicknessM !== undefined ? 'existing' : 'estimate',
    stackOrder,
    tiers,
    explicitTiers,
    topClearanceM: verticals?.topClearanceM ?? DEFAULT_TOP_CLEARANCE_M,
    topClearanceSource: verticals?.topClearanceM !== undefined ? 'existing' : 'standard',
  };
}

/** Resolved service tiers of a hall (rack height taken from the prims). */
export function hallTiers(hall: Hall, prims: readonly Prim[], verticals: HallVerticals | undefined = hall.verticals): ResolvedTier[] {
  return resolveVerticals(hall, hallRackHeight(prims), verticals).tiers;
}

const tierLabel = (t: ServiceTier) => (t.kind === 'pipe' ? 'TCS PIPE' : t.kind === 'busway' ? 'BUSWAY' : t.kind === 'light' ? `LIGHT ${t.id}` : `LADDER ${t.id}`);

/** FFL, top of rack, containment, pipe, busway, T1–T3, chimney, top clearance, light, ceiling, deck — sorted by z. */
export function hallDatums(hall: Hall, prims: readonly Prim[], verticals: HallVerticals | undefined = hall.verticals): Datum[] {
  const out: Datum[] = [];
  const push = (id: string, z: number, label: string, source: DatumSource) => out.push({ id, z: r6(z), label, source });
  let rackTop = -Infinity;
  let contTop = -Infinity;
  let chimneyTop = -Infinity;
  let hasPipe = false;
  let hasLight = false;
  for (const p of prims) {
    switch (p.emitter) {
      case 'rack':
        rackTop = Math.max(rackTop, p.b.z);
        break;
      case 'containment-panel':
        contTop = Math.max(contTop, p.b.z);
        break;
      case 'containment-roof':
        if (p.meta?.part === 'chimney') chimneyTop = Math.max(chimneyTop, p.b.z);
        else contTop = Math.max(contTop, p.a.z);
        break;
      case 'pipe':
        hasPipe = true;
        break;
      case 'light':
        hasLight = true;
        break;
    }
  }
  const rv = resolveVerticals(hall, hallRackHeight(prims), verticals);
  push('ffl', 0, 'FFL', 'existing');
  if (hall.raisedFloorHeight > 0) push('raised-floor', hall.raisedFloorHeight, 'TOP OF RAISED FLOOR', 'existing');
  if (Number.isFinite(rackTop)) push('rack-top', rackTop, 'TOP OF RACK', 'derived');
  if (Number.isFinite(contTop)) push('containment', contTop, 'TOP OF CONTAINMENT', 'existing');
  if (Number.isFinite(chimneyTop) && chimneyTop > contTop + 1e-6) push('chimney', chimneyTop, 'TOP OF CHIMNEY', 'existing');
  if (Number.isFinite(rackTop) || rv.explicitTiers) {
    let top = -Infinity;
    for (const t of rv.tiers) {
      if (t.kind === 'pipe' && !hasPipe && !rv.explicitTiers) continue;
      push(t.id, t.z, tierLabel(t), t.source);
      if (t.kind !== 'light') top = Math.max(top, t.z + (t.kind === 'tray' ? t.heightM : t.heightM / 2));
    }
    if (Number.isFinite(top)) push('top-clearance', top + rv.topClearanceM, 'MIN. HEADROOM ABOVE SERVICES', rv.topClearanceSource);
  }
  if (hasLight) push('light', fixtureHeight(hall), 'LIGHT FIXTURE', 'standard');
  push('ceiling', hall.clearHeight, 'CEILING', 'existing');
  if (hall.ceilingPlenumHeight > 0) push('deck', hall.clearHeight + hall.ceilingPlenumHeight, 'UNDERSIDE OF DECK', 'existing');
  return out.sort((a, b) => a.z - b.z || a.id.localeCompare(b.id));
}
