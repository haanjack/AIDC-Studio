// r4 stream B2 (spec S9, §2.4 "Derived pipes"; r4-model-gap §4.6 / §5.3): derived liquid-cooling (TCS) pipe network of one hall.
// Built at prim-build / sheet-build time and never stored. Pure and deterministic.
//
// Topology per pod (rows grouped by podId and row axis):
//   CDU riser (vertical, CDU top → network level)                       kind 'riser'   one per serving CDU and system
//   link      (riser top → cross header, Manhattan at network level)     kind 'header'  part 'link', one per (CDU, pod, system)
//   cross     (pod distribution header across the rows, at the CDU end)  kind 'header'  part 'cross'
//   row       (along each liquid row; split per RCU loop when racks carry meta.rcu)  kind 'header' part 'row'
//   branch    (row header → rack top, one supply + one return per liquid rack)                     kind 'branch'
//   fittings  EPIV on every supply branch at the rack inlet (AIDC Studio convention) · isolation valve on every branch below the header
// · isolation valve between consecutive RCU loop headers · strainer on every CDU supply riser
//
// Levels: supply network at the resolved 'pipe' tier z (Hall.verticals, default rackH + 0.22 existing); the return cross header,
// links and risers sit 0.25 m higher (estimate) so the two cross headers never meet the other system's row headers; the return row
// header drops back to the tier z at its start. Row headers keep the existing centre-line: row centre − frontSign·0.32 ∓ 0.1 m.
//
// Sizing (all `estimate` on sheets): rack liquid kW = kwByRack ?? nameplate kW × liquidFraction (catalog, existing);
// flow = 1.5 LPM/kW (derived, typical TCS design flow); DN = smallest nominal size (ASME B36.10 Sch 40 bore, typical) with v ≤ 2.4 m/s (typical),
// never below DN25 (typical). Flow is conserved: Σ riser = Σ links (per CDU); Σ links (pod) = cross = Σ first row-header segments;
// row segment k − row segment k+1 = Σ branches of loop k.
// Keepout-aware: every horizontal run is clipped to the hall (0.05 m inset) and cut at column / shaft keepouts grown by the pipe
// radius + 0.02 m (rows.ts clipPolyline), so no pipe enters a column (a cut run keeps its flow; parts get a `-k` suffix).
import { findCatalogItem } from '../catalog/catalog.ts';
import { round6 } from '../model/geometry.ts';
import type { Containment, EquipmentInstance, Hall, HallVerticals, PipeFitting, PipeNetwork, PipeRun, RowGroup, Vec3 } from '../model/types.ts';
import { resolveVerticals } from '../scene/datums.ts';
import { blockingKeepouts, clipPolyline, RACK_CATEGORIES_FOR_ROWS } from './rows.ts';

export interface PipeSourcedValue {
  value: number;
  source: 'existing' | 'observed' | 'standard' | 'typical' | 'estimate' | 'derived';
  citation: string;
}

/** Design TCS flow per liquid kW (L/min per kW). */
export const TCS_LPM_PER_KW: PipeSourcedValue = { value: 1.5, source: 'derived', citation: 'Typical warm-water DLC technology-cooling-system design flow: 1.5 LPM per kW of rack liquid load (derived estimate; confirm with the CDU / rack vendor)' };
/**
 * Stream C (P3, proposal CL-01): coolant properties for flow per kW. Q [L/min] = P [kW] · 60 / (ρ [kg/L] · cp [kJ/kg·K] · ΔT [K]).
 * Water ρ ≈ 0.997 kg/L, cp ≈ 4.18 kJ/kg·K (textbook, derived); PG25 ρ ≈ 1.02 kg/L, cp ≈ 3.95 kJ/kg·K (values used in the cooling research
 * notes, derived) — PG25 needs ≈ 3.5 % more flow than water at the same ΔT. Single-phase dielectric values are planner estimates.
 * The 1.5 LPM/kW constant above stays the documented fallback (the row-CDU rating white paper's recommended flow, ≈ ΔT 9.9 K with PG25).
 */
export const TCS_FLUIDS: Readonly<Record<'pg25' | 'treated-water' | 'dielectric-1p', { rhoKgL: number; cpKJkgK: number; maxC?: number; standardId?: string; source: PipeSourcedValue['source']; citation: string }>> = {
  'treated-water': { rhoKgL: 0.997, cpKJkgK: 4.18, source: 'derived', citation: 'water near 30 °C (textbook values)' },
  pg25: { rhoKgL: 1.02, cpKJkgK: 3.95, maxC: 66, standardId: 'pg25-guideline@2022', source: 'derived', citation: '25 % propylene glycol near 30 °C; 66 °C upper limit per the PG25 coolant guideline (2022)' },
  'dielectric-1p': { rhoKgL: 0.85, cpKJkgK: 2.1, source: 'estimate', citation: 'single-phase dielectric fluid (planner estimate; use the fluid datasheet)' },
};

/** TCS flow per kW of liquid heat at temperature rise `deltaTK` (L/min per kW). */
export function tcsLpmPerKW(fluid: keyof typeof TCS_FLUIDS, deltaTK: number): number {
  const f = TCS_FLUIDS[fluid] ?? TCS_FLUIDS['treated-water'];
  return deltaTK > 0 ? 60 / (f.rhoKgL * f.cpKJkgK * deltaTK) : TCS_LPM_PER_KW.value;
}

/** Heat (kW) carried by `lpm` L/min at `deltaTK` (inverse of tcsLpmPerKW). */
export function tcsKWForFlow(fluid: keyof typeof TCS_FLUIDS, lpm: number, deltaTK: number): number {
  const f = TCS_FLUIDS[fluid] ?? TCS_FLUIDS['treated-water'];
  return (lpm * f.rhoKgL * f.cpKJkgK * deltaTK) / 60;
}

/**
 * Stream C (P3, proposal CL-08): TCS pipe capacity bands at ΔT 10 K, PG25, ≈ 2.3 m/s (Modular TCS white paper, registry
 * `modular-tcs-wp@dlm1`): DN25 55–60 kW and DN50 215–220 kW per rack branch; DN100 840 kW and DN150 1872 kW per loop. The lower bound
 * of each band is used; capacity scales linearly with ΔT.
 */
export const TCS_BAND_KW_AT_10K: Readonly<Record<25 | 50 | 100 | 150, number>> = { 25: 55, 50: 215, 100: 840, 150: 1872 };
export function tcsBandCapacityKW(dn: 25 | 50 | 100 | 150, deltaTK: number): number {
  return (TCS_BAND_KW_AT_10K[dn] * Math.max(0, deltaTK)) / 10;
}

/** Maximum velocity used to pick the pipe size (m/s). */
export const TCS_MAX_VELOCITY_MS: PipeSourcedValue = { value: 2.4, source: 'typical', citation: 'common chilled / process water sizing practice' };
/** Smallest nominal size drawn (mm). */
export const TCS_MIN_DN_MM: PipeSourcedValue = { value: 25, source: 'typical', citation: 'rack branch minimum (typical)' };
/** Vertical offset of the return cross header / links / risers above the supply network (m). */
export const TCS_RETURN_RAISE_M: PipeSourcedValue = { value: 0.25, source: 'estimate', citation: 'r4 B2 routing convention' };
/** Offset of the header centre-line from the row centre toward the rear (m) and the S/R half spacing (m) — existing prim formula. */
export const TCS_HEADER_REAR_OFFSET_M = 0.32;
/** clearance of a pipe to the other services of the stack (m), T1b routing rule (estimate) */
export const TCS_PIPE_CLEARANCE_M: PipeSourcedValue = { value: 0.02, source: 'estimate', citation: 'T1b routing rule (backlog-T1b §3)' };
/** pipe outer diameter used by the routing rule and the scene tubes (m): DN + 10 mm (estimate, scene/build.ts pipePrimsFromNetwork) */
export const pipeOdM = (dnMM: number): number => dnMM / 1000 + 0.01;
export const TCS_HEADER_HALF_SPACING_M = 0.1;

/** Nominal size → inside diameter (mm), ASME B36.10 Sch 40 (typical). */
export const DN_BORE_MM: readonly (readonly [number, number])[] = [
  [15, 15.8], [20, 20.9], [25, 26.6], [32, 35.1], [40, 40.9], [50, 52.5], [65, 62.7], [80, 77.9], [100, 102.3], [125, 128.2],
  [150, 154.1], [200, 202.7], [250, 254.5], [300, 303.2], [350, 333.4], [400, 381.0], [450, 428.7], [500, 477.9], [600, 574.7],
];

/** DN → nominal pipe size in inches (for imperial annotations). */
export const DN_INCH: Readonly<Record<number, string>> = { 15: '1/2"', 20: '3/4"', 25: '1"', 32: '1 1/4"', 40: '1 1/2"', 50: '2"', 65: '2 1/2"', 80: '3"', 100: '4"', 125: '5"', 150: '6"', 200: '8"', 250: '10"', 300: '12"', 350: '14"', 400: '16"', 450: '18"', 500: '20"', 600: '24"' };

/** Velocity (m/s) of `flowLpm` in a pipe of nominal size `dn`. */
export function pipeVelocityMs(flowLpm: number, dn: number): number {
  const bore = (DN_BORE_MM.find((d) => d[0] === dn)?.[1] ?? dn) / 1000;
  return flowLpm / 60000 / ((Math.PI * bore * bore) / 4);
}

/** Smallest DN whose velocity at `flowLpm` stays ≤ TCS_MAX_VELOCITY_MS (never below TCS_MIN_DN_MM; the largest size when none fits). */
export function sizePipeDn(flowLpm: number, maxV = TCS_MAX_VELOCITY_MS.value, minDn = TCS_MIN_DN_MM.value): number {
  for (const [dn] of DN_BORE_MM) {
    if (dn < minDn) continue;
    if (pipeVelocityMs(flowLpm, dn) <= maxV + 1e-9) return dn;
  }
  return DN_BORE_MM[DN_BORE_MM.length - 1][0];
}

export interface BuildPipesOptions {
  /** equipment of the hall (rack members of `rows` are resolved from it); default: the CDUs only (no racks → empty network) */
  equipment?: readonly EquipmentInstance[];
  /** design liquid kW per rack id (flow sizing); absent = catalog nameplate kW × liquidFraction */
  kwByRack?: ReadonlyMap<string, number>;
  /** containments of the hall: the cross zone stays outside their along extent (T1b routing rule) */
  containments?: readonly Containment[];
  /** stream C (P3, CL-01): design flow per liquid kW (L/min per kW), e.g. `tcsLpmPerKW(fluid, ΔT)` of a confirmed standards profile; default TCS_LPM_PER_KW */
  lpmPerKW?: number;
}

interface LiquidRack {
  e: EquipmentInstance;
  a0: number;
  a1: number;
  a: number;
  top: number;
  kw: number;
  flow: number;
  loop?: string;
}

interface RowPlan {
  row: RowGroup;
  racks: LiquidRack[];
  cS: number;
  cR: number;
  /** return header stacked above the supply header (the rear lane is too narrow for both side by side) */
  stacked: boolean;
}

/** rear edge of the busway band incl. tap-off boxes, from the row centre line (m): busways at ±0.1 (+0.02 frontSign), tap-off half-width 0.1 */
export const TCS_BUSWAY_BAND_HALF_M = 0.18;

const V = (axis: 'x' | 'y', a: number, c: number, z: number): Vec3 => (axis === 'x' ? { x: round6(a), y: round6(c), z: round6(z) } : { x: round6(c), y: round6(a), z: round6(z) });
const safe = (s: string) => s.replace(/[^A-Za-z0-9_.:@+~-]+/g, '-');

function footAlong(e: EquipmentInstance, axis: 'x' | 'y'): [number, number] | null {
  const it = findCatalogItem(e.catalogId);
  if (!it) return null;
  const rot = ((Math.round(e.rotationDeg) % 360) + 360) % 360;
  const along = axis === 'x' ? (rot % 180 === 0 ? it.dims.w : it.dims.d) : rot % 180 === 0 ? it.dims.d : it.dims.w;
  const c = axis === 'x' ? e.position.x : e.position.y;
  return [c - along / 2, c + along / 2];
}

/** Derived TCS pipe network of `hall` (see the file header for topology, sizing and sources). */
export function buildPipes(hall: Hall, rows: readonly RowGroup[], cdus: readonly EquipmentInstance[], verticals: HallVerticals | undefined = hall.verticals, opts: BuildPipesOptions = {}): PipeNetwork {
  const runs: PipeRun[] = [];
  const fittings: PipeFitting[] = [];
  const eqById = new Map((opts.equipment ?? []).map((e) => [e.id, e]));
  const hallRect = { x: 0.05, y: 0.05, w: Math.max(0, hall.width - 0.1), d: Math.max(0, hall.depth - 0.1) };

  // liquid racks per row
  const plans: RowPlan[] = [];
  let rackH = 0;
  for (const row of [...rows].filter((r) => r.hallId === hall.id).sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))) {
    const racks: LiquidRack[] = [];
    for (const id of row.memberIds) {
      const e = eqById.get(id);
      if (!e) continue;
      const it = findCatalogItem(e.catalogId);
      if (!it || !RACK_CATEGORIES_FOR_ROWS.has(it.category)) continue;
      const lf = it.cooling?.liquidFraction ?? 0;
      if (!(lf > 0)) continue;
      const fa = footAlong(e, row.axis);
      if (!fa) continue;
      const kw = opts.kwByRack?.get(e.id) ?? (it.power?.nameplateKW ?? 0) * lf;
      const top = (e.elevation ?? 0) + it.dims.h;
      rackH = Math.max(rackH, top);
      racks.push({ e, a0: fa[0], a1: fa[1], a: (fa[0] + fa[1]) / 2, top, kw, flow: round6(kw * (opts.lpmPerKW ?? TCS_LPM_PER_KW.value)), ...(e.meta?.rcu !== undefined ? { loop: String(e.meta.rcu) } : {}) });
    }
    if (!racks.length) continue;
    racks.sort((p, q) => p.a - q.a || (p.e.id < q.e.id ? -1 : 1));
    // T1b routing rule: the headers sit in the rear lane between the busway / tap-off band and the rack rear (hot-aisle containment);
    // the supply nearest the busway, the return beside it, or stacked above it when the lane is too narrow
    const dnRow = sizePipeDn(racks.reduce((s, r) => s + r.flow, 0));
    const od = pipeOdM(dnRow);
    const clr = TCS_PIPE_CLEARANCE_M.value;
    const halfDepth = Math.max(...racks.map((r) => (findCatalogItem(r.e.catalogId)?.dims.d ?? 1.2) / 2));
    const edge = TCS_BUSWAY_BAND_HALF_M + clr;
    const stacked = edge + od + clr + od + clr > halfDepth;
    const rear = -row.frontSign;
    const cS = row.center + rear * (edge + od / 2);
    plans.push({ row, racks, cS, cR: stacked ? cS : row.center + rear * (edge + od + clr + od / 2), stacked });
  }
  if (!plans.length) return { hallId: hall.id, runs, fittings };

  const tiers = resolveVerticals(hall, rackH || undefined, verticals).tiers;
  const zS = round6(tiers.find((t) => t.kind === 'pipe')?.z ?? rackH + 0.22);
  // T1b routing rule (backlog-T1b §3): headers, links and risers of both systems run at the pipe tier; only the return cross header
  // jumps above the supply, and only in the cross zone beyond the rows' busways, tap-offs and containment; the jump stays under T1
  const trayTiers = tiers.filter((t) => t.kind === 'tray').sort((p, q) => p.z - q.z);
  const t1Bottom = trayTiers.length ? trayTiers[0].z - trayTiers[0].heightM / 2 : Infinity;
  const returnLevel = (odS: number, odR: number) => {
    const need = (odS + odR) / 2 + TCS_PIPE_CLEARANCE_M.value;
    const room = t1Bottom - TCS_PIPE_CLEARANCE_M.value - odR / 2 - zS;
    return round6(zS + Math.max(need, Math.min(TCS_RETURN_RAISE_M.value, room)));
  };
  const hallAlong = (axis: 'x' | 'y') => (axis === 'x' ? hall.width : hall.depth);
  // QA backlog geometry (qa-backlog-geometry.md §5): the along-row leg of a link from a CDU off the rows ran at the CDU's own cross coordinate.
  // A gallery CDU serving the second pod of a column ran it along the first pod's busway / tap-off band or through its hot-aisle containment
  // (stored reference project: 62 pipe clashes). The leg now takes the nearest lane clear of every rack row band and containment it passes.
  const clearLane = (axis: 'x' | 'y', c: number, from: number, to: number, half: number): number => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const clr = TCS_PIPE_CLEARANCE_M.value;
    const blocks: [number, number][] = [];
    for (const p of plans) {
      if (p.row.axis !== axis || p.row.a1 <= lo + 1e-6 || p.row.a0 >= hi - 1e-6) continue;
      const hd = Math.max(...p.racks.map((r) => (findCatalogItem(r.e.catalogId)?.dims.d ?? 1.2) / 2));
      blocks.push([p.row.center - hd - clr, p.row.center + hd + clr]);
    }
    for (const k of opts.containments ?? []) {
      if (k.hallId !== hall.id) continue;
      const [a0, a1, c0, c1] = axis === 'x' ? [k.rect.x, k.rect.x + k.rect.w, k.rect.y, k.rect.y + k.rect.d] : [k.rect.y, k.rect.y + k.rect.d, k.rect.x, k.rect.x + k.rect.w];
      if (a1 <= lo + 1e-6 || a0 >= hi - 1e-6) continue;
      blocks.push([c0 - clr, c1 + clr]);
    }
    const cross = axis === 'x' ? hall.depth : hall.width;
    blocks.sort((p, q) => p[0] - q[0]);
    const gaps: [number, number][] = [];
    let at = 0.05;
    for (const [b0, b1] of blocks) {
      if (b0 > at) gaps.push([at, b0]);
      at = Math.max(at, b1);
    }
    if (cross - 0.05 > at) gaps.push([at, cross - 0.05]);
    let best = c;
    let bestD = Infinity;
    for (const [g0, g1] of gaps) {
      if (g1 - g0 < 2 * half) continue;
      const v = Math.min(Math.max(c, g0 + half), g1 - half);
      if (Math.abs(v - c) < bestD) {
        bestD = Math.abs(v - c);
        best = v;
      }
    }
    return round6(best);
  };

  const push = (run: PipeRun) => {
    const r = run.dnMM / 2000 + 0.02;
    const horizontal = run.points.some((p, i) => i > 0 && (Math.abs(p.x - run.points[i - 1].x) > 1e-9 || Math.abs(p.y - run.points[i - 1].y) > 1e-9));
    if (!horizontal) {
      runs.push(run);
      return;
    }
    const parts = clipPolyline(run.points, hallRect, blockingKeepouts(hall.keepouts, r));
    if (parts.length === 1) runs.push({ ...run, points: parts[0] });
    else parts.forEach((pts, k) => runs.push({ ...run, id: `${run.id}#${k + 1}`, points: pts }));
  };

  // pods (podId + axis)
  const pods = new Map<string, RowPlan[]>();
  for (const p of plans) {
    const key = `${p.row.podId ?? p.row.id}|${p.row.axis}`;
    pods.set(key, [...(pods.get(key) ?? []), p]);
  }
  const hallCdus = cdus.filter((c) => c.hallId === hall.id);
  const riserFlow = new Map<string, number>();
  const riserPods = new Map<string, string[]>();
  const zRByPod = new Map<string, number>();

  for (const [key, prs] of [...pods.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const podId = prs[0].row.podId ?? prs[0].row.id;
    const axis = prs[0].row.axis;
    const pod = safe(podId);
    const serving = hallCdus.filter((c) => c.podId === podId || String(c.meta?.pods ?? '').split(',').includes(podId)).sort((a, b) => (a.id < b.id ? -1 : 1));
    const cduIds = serving.map((c) => c.id);
    const A0 = Math.min(...prs.flatMap((p) => p.racks.map((r) => r.a0)));
    const A1 = Math.max(...prs.flatMap((p) => p.racks.map((r) => r.a1)));
    const cduAlong = serving.map((c) => (axis === 'x' ? c.position.x : c.position.y));
    const far = cduAlong.length > 0 && cduAlong.reduce((s, v) => s + v, 0) / cduAlong.length > (A0 + A1) / 2;
    // cross zone: beyond the pod's rows (busway / tap-off extent, in-row CDUs included) and its containment, else the old liquid-rack end
    const conts = (opts.containments ?? []).filter((c) => c.hallId === hall.id && c.podId === podId);
    const Z0 = Math.min(A0, ...prs.map((p) => p.row.a0), ...conts.map((c) => (axis === 'x' ? c.rect.x : c.rect.y)));
    const Z1 = Math.max(A1, ...prs.map((p) => p.row.a1), ...conts.map((c) => (axis === 'x' ? c.rect.x + c.rect.w : c.rect.y + c.rect.d)));
    const zoneOk = far ? Z1 + 0.45 + 0.15 <= hallAlong(axis) - 0.05 : Z0 - 0.45 - 0.15 >= 0.05;
    const E0 = zoneOk ? Z0 : A0;
    const E1 = zoneOk ? Z1 : A1;
    const aS = far ? E1 + 0.45 : E0 - 0.45;
    const aR = far ? E1 + 0.25 : E0 - 0.25;
    const loopBase = podId + (pods.size > 1 && [...pods.keys()].filter((k) => k.startsWith(`${podId}|`)).length > 1 ? `/${axis}` : '');
    let podFlow = 0;
    const podFlowPre = prs.reduce((s, p) => s + p.racks.reduce((t, r) => t + r.flow, 0), 0);
    const zR = returnLevel(pipeOdM(sizePipeDn(podFlowPre)), pipeOdM(sizePipeDn(podFlowPre)));
    zRByPod.set(podId, zR);

    // row headers (split per RCU loop) + branches
    for (const p of prs) {
      const { row, racks } = p;
      const rid = safe(row.id);
      // loops in feed order (nearest the cross header first)
      const ordered = far ? [...racks].reverse() : racks;
      const groups: { loop?: string; racks: LiquidRack[] }[] = [];
      for (const r of ordered) {
        const g = groups[groups.length - 1];
        if (g && g.loop === r.loop) g.racks.push(r);
        else groups.push({ loop: r.loop, racks: [r] });
      }
      const rowFlow = racks.reduce((s, r) => s + r.flow, 0);
      podFlow += rowFlow;
      let remaining = rowFlow;
      let startS = aS;
      let startR = aR;
      groups.forEach((g, gi) => {
        const loopId = g.loop !== undefined ? `${loopBase}/${safe(g.loop)}` : loopBase;
        const gA0 = Math.min(...g.racks.map((r) => r.a0));
        const gA1 = Math.max(...g.racks.map((r) => r.a1));
        const last = gi === groups.length - 1;
        const next = groups[gi + 1];
        // segment end: the far end of the group, or the midpoint of the break to the next loop
        const endA = last ? (far ? gA0 + 0.05 : gA1 - 0.05) : far ? (gA0 + Math.max(...next.racks.map((r) => r.a1))) / 2 : (gA1 + Math.min(...next.racks.map((r) => r.a0))) / 2;
        const flow = round6(remaining);
        const dn = sizePipeDn(flow);
        const suffix = groups.length > 1 ? `:L${gi + 1}` : '';
        const base = { hallId: hall.id, cduIds, rowId: row.id, podId, loopId, flowLpm: flow, dnMM: dn, kind: 'header' as const, part: 'row' as const };
        const sPts = [V(axis, startS, p.cS, zS), V(axis, endA, p.cS, zS)];
        const zRow = p.stacked ? zR : zS;
        const rPts = gi === 0 && !p.stacked ? [V(axis, startR, p.cR, zR), V(axis, startR, p.cR, zS), V(axis, endA, p.cR, zS)] : [V(axis, startR, p.cR, zRow), V(axis, endA, p.cR, zRow)];
        push({ ...base, id: `tcs-S:${rid}:row${suffix}`, system: 'tcs-supply', points: sPts });
        push({ ...base, id: `tcs-R:${rid}:row${suffix}`, system: 'tcs-return', points: rPts });
        if (!last) {
          fittings.push({ id: `iv:${rid}:L${gi + 1}-${gi + 2}:S`, kind: 'isolation-valve', at: V(axis, endA, p.cS, zS), runId: `tcs-S:${rid}:row${suffix}` });
          fittings.push({ id: `iv:${rid}:L${gi + 1}-${gi + 2}:R`, kind: 'isolation-valve', at: V(axis, endA, p.cR, zRow), runId: `tcs-R:${rid}:row${suffix}` });
        }
        for (const r of g.racks) {
          const tag = safe(r.e.tag || r.e.id);
          const bdn = sizePipeDn(r.flow);
          const bb = { hallId: hall.id, cduIds, rowId: row.id, podId, loopId, flowLpm: r.flow, dnMM: bdn, kind: 'branch' as const };
          const zTop = r.top + 0.05;
          runs.push({ ...bb, id: `tcs-S:${tag}:branch`, system: 'tcs-supply', points: [V(axis, r.a, p.cS, zS), V(axis, r.a, p.cS, zTop)] });
          // stacked: the return branch drops beside the supply header (along the row), inside the rack footprint
          const aR = p.stacked ? Math.min(r.a1 - 0.03, r.a + (pipeOdM(dn) + pipeOdM(bdn)) / 2 + TCS_PIPE_CLEARANCE_M.value) : r.a;
          runs.push({ ...bb, id: `tcs-R:${tag}:branch`, system: 'tcs-return', points: [V(axis, aR, p.cR, zRow), V(axis, aR, p.cR, zTop)] });
          const zIv = Math.max(zTop + 0.02, zS - 0.15);
          fittings.push({ id: `iv:${tag}:S`, kind: 'isolation-valve', at: V(axis, r.a, p.cS, zIv), equipmentId: r.e.id, runId: `tcs-S:${tag}:branch` });
          fittings.push({ id: `iv:${tag}:R`, kind: 'isolation-valve', at: V(axis, aR, p.cR, zIv), equipmentId: r.e.id, runId: `tcs-R:${tag}:branch` });
          fittings.push({ id: `epiv:${tag}`, kind: 'epiv', at: V(axis, r.a, p.cS, Math.min(zTop + 0.01, zIv)), equipmentId: r.e.id, runId: `tcs-S:${tag}:branch` });
        }
        remaining -= g.racks.reduce((s, r) => s + r.flow, 0);
        startS = endA;
        startR = endA;
      });
    }
    podFlow = round6(podFlow);

    // cross headers (span every row header and every in-pod CDU)
    const inPod = serving.filter((c) => c.podId === podId);
    const cCdu = (c: EquipmentInstance) => (axis === 'x' ? c.position.y : c.position.x);
    const aCdu = (c: EquipmentInstance) => (axis === 'x' ? c.position.x : c.position.y);
    const csS = [...prs.map((p) => p.cS), ...inPod.map(cCdu)];
    const csR = [...prs.map((p) => p.cR), ...inPod.map(cCdu)];
    const podDn = sizePipeDn(podFlow);
    const cross = { hallId: hall.id, cduIds, podId, loopId: loopBase, flowLpm: podFlow, dnMM: podDn, kind: 'header' as const, part: 'cross' as const };
    const sMin = Math.min(...csS);
    const sMax = Math.max(...csS);
    const rMin = Math.min(...csR);
    const rMax = Math.max(...csR);
    // the return cross header rises at each row header start; its span is drawn at zR
    push({ ...cross, id: `tcs-S:${pod}${key.endsWith('|y') && loopBase !== podId ? '-y' : ''}:cross`, system: 'tcs-supply', points: sMax - sMin > 1e-6 ? [V(axis, aS, sMin, zS), V(axis, aS, sMax, zS)] : [V(axis, aS, sMin, zS), V(axis, aS, sMin, zS + 1e-3)] });
    push({ ...cross, id: `tcs-R:${pod}${key.endsWith('|y') && loopBase !== podId ? '-y' : ''}:cross`, system: 'tcs-return', points: rMax - rMin > 1e-6 ? [V(axis, aR, rMin, zR), V(axis, aR, rMax, zR)] : [V(axis, aR, rMin, zR), V(axis, aR, rMin, zR + 1e-3)] });

    // links (one per serving CDU and system; flow shared evenly between the pod's CDUs)
    const share = serving.length ? round6(podFlow / serving.length) : 0;
    for (const c of serving) {
      const t = safe(c.tag || c.id);
      riserFlow.set(c.id, (riserFlow.get(c.id) ?? 0) + share);
      riserPods.set(c.id, [...(riserPods.get(c.id) ?? []), podId]);
      const ca = aCdu(c);
      const cc = cCdu(c);
      const dn = sizePipeDn(share);
      const lb = { hallId: hall.id, cduIds: [c.id], podId, loopId: loopBase, flowLpm: share, dnMM: dn, kind: 'header' as const, part: 'link' as const };
      const half = (pipeOdM(dn) + TCS_PIPE_CLEARANCE_M.value * 2.5) / 2;
      for (const [sys, zEnd, aOff, aX, lo, hi, dc] of [['S', zS, -0.15, aS, sMin, sMax, -half], ['R', zR, 0.15, aR, rMin, rMax, half]] as const) {
        const lane = plans.find((q) => q.row.memberIds.includes(c.id));
        const c0 = lane ? (sys === 'S' ? lane.cS : lane.cR) : cc + dc;
        const zLink = lane?.stacked && sys === 'R' ? zR : zS;
        const cNear = Math.min(Math.max(c0, lo), hi);
        const pts = [V(axis, ca + aOff, c0, zLink)];
        // a CDU off the rows (gallery, perimeter) runs along the row axis to the cross zone first, so it never crosses a busway band — in
        // a lane clear of the row bands and containment it passes (QA backlog geometry)
        if (!lane) {
          const cL = clearLane(axis, c0, ca + aOff, aX, pipeOdM(dn) / 2);
          if (Math.abs(cL - c0) > 1e-6) pts.push(V(axis, ca + aOff, cL, zLink));
          if (Math.abs(cNear - cL) > 1e-6) pts.push(V(axis, aX, cL, zLink));
        } else if (Math.abs(cNear - c0) > 1e-6) pts.push(V(axis, ca + aOff, cNear, zLink));
        pts.push(V(axis, aX, cNear, zLink));
        if (zEnd - zLink > 1e-6) pts.push(V(axis, aX, cNear, zEnd));
        if (pts.length >= 2 && (Math.abs(pts[pts.length - 1].x - pts[0].x) > 1e-6 || Math.abs(pts[pts.length - 1].y - pts[0].y) > 1e-6)) push({ ...lb, id: `tcs-${sys}:${t}:link:${pod}`, system: sys === 'S' ? 'tcs-supply' : 'tcs-return', points: pts });
        else push({ ...lb, id: `tcs-${sys}:${t}:link:${pod}`, system: sys === 'S' ? 'tcs-supply' : 'tcs-return', points: [pts[0], V(axis, ca + aOff, c0, zEnd + 1e-3)] });
      }
    }
  }

  // risers (one per CDU and system)
  for (const c of hallCdus.filter((x) => riserFlow.has(x.id)).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const it = findCatalogItem(c.catalogId);
    const top = (c.elevation ?? 0) + (it?.dims.h ?? 2.4);
    const t = safe(c.tag || c.id);
    const flow = round6(riserFlow.get(c.id)!);
    const dn = sizePipeDn(flow);
    const axis = plans.find((p) => (riserPods.get(c.id) ?? []).includes(p.row.podId ?? p.row.id))?.row.axis ?? 'x';
    const ca = axis === 'x' ? c.position.x : c.position.y;
    const cc = axis === 'x' ? c.position.y : c.position.x;
    const base = { hallId: hall.id, cduIds: [c.id], flowLpm: flow, dnMM: dn, kind: 'riser' as const, ...(c.podId ? { podId: c.podId } : {}) };
    const share = round6(flow / Math.max(1, (riserPods.get(c.id) ?? []).length));
    const half = (pipeOdM(sizePipeDn(share)) + TCS_PIPE_CLEARANCE_M.value * 2.5) / 2;
    // an in-row CDU rises in its row's rear lanes (clear of the busway band above it), a CDU off the rows beside its centre
    const lane = plans.find((q) => q.row.memberIds.includes(c.id));
    const cSr = lane ? lane.cS : cc - half;
    const cRr = lane ? lane.cR : cc + half;
    const zTopS = Math.max(zS, top + 0.05);
    const zTopR = Math.max(lane?.stacked ? zRByPod.get(lane.row.podId ?? lane.row.id) ?? zS : zS, top + 0.05);
    runs.push({ ...base, id: `tcs-S:${t}:riser`, system: 'tcs-supply', points: [V(axis, ca - 0.15, cSr, top), V(axis, ca - 0.15, cSr, zTopS)] });
    runs.push({ ...base, id: `tcs-R:${t}:riser`, system: 'tcs-return', points: [V(axis, ca + 0.15, cRr, top), V(axis, ca + 0.15, cRr, zTopR)] });
    fittings.push({ id: `strainer:${t}`, kind: 'strainer', at: V(axis, ca - 0.15, cSr, (top + zTopS) / 2), equipmentId: c.id, runId: `tcs-S:${t}:riser` });
    fittings.push({ id: `iv:${t}:riser:S`, kind: 'isolation-valve', at: V(axis, ca - 0.15, cSr, top + 0.03), equipmentId: c.id, runId: `tcs-S:${t}:riser` });
    fittings.push({ id: `iv:${t}:riser:R`, kind: 'isolation-valve', at: V(axis, ca + 0.15, cRr, top + 0.03), equipmentId: c.id, runId: `tcs-R:${t}:riser` });
  }
  return { hallId: hall.id, runs, fittings };
}

/** buildPipes for a project hall: rows from rows.ts, CDUs + equipment of the hall. */
export function buildHallPipes(project: { equipment: readonly EquipmentInstance[]; containments?: readonly Containment[] }, hall: Hall, rows: readonly RowGroup[]): PipeNetwork {
  const eq = project.equipment.filter((e) => e.hallId === hall.id);
  const cdus = eq.filter((e) => findCatalogItem(e.catalogId)?.category === 'cdu');
  return buildPipes(hall, rows, cdus, hall.verticals, { equipment: eq, containments: project.containments ?? [] });
}
