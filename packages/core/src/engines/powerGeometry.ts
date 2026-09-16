// Feeder routing and wall / partition sleeves (finish v2 2차, DECISIONS-v2-2 §D1, D-defaults: "피더는 전기실당 벽 중앙 슬리브 1개,
// 끝 통로의 피더 트레이(메인 트레이 위)로 모아 옆으로 벌려 겹치지 않게, 덕트형 HAC 끝·트레이 끝 회피").
//
// Replaces the straight "row end → wall" feeder of the power plane (qa-geometry-v2-2 B1/B2/M1–M5): every feeder
//   1. leaves its circuit a few centimetres inside the feed end, jogs to the midline between the A and B busways and rises there
//      (clear of the busway, its tap-offs and the row tray),
//   2. runs out of the row at its approach level zA + k·0.1 (above the main tray, the cable tubes and every unit top + 0.3 m),
//      stepping sideways around a column that stands in the row line,
//   3. rises into a slot of the end-aisle feeder tray of its pod column (slots 0.1 m apart, layers 0.1 m apart; nearest joins lowest),
//   4. follows its track along a free lane (chimney-, column- and shaft-free) to the room's single sleeve and through the wall.
// Tracks are ordered so that no two feeders cross or coincide (nesting rules in the comment of `routeSide`).
//
// Canonical frame: a = along the rows, p = across; the side is mirrored so that its feed ends point to −a, and for a room on a wall
// parallel to the rows p is mirrored so that the wall sits at p = 0. "End" rooms sit on a = 0 (across the row axis), "parallel" rooms on p = 0.
import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect } from '../model/geometry.ts';
import type { Hall, PowerRoom, Project, Rect, Vec3, WallPenetration } from '../model/types.ts';
import { partitionWalls } from '../layout/geometry3d.ts';
import { blockingKeepouts } from '../layout/rows.ts';

/** feeder bar width drawn in 3D (PowerPath.tsx) */
export const FEEDER_BAR_M = 0.05;
/** centre spacing between feeders laterally and vertically (bar + 0.05 m air) */
export const FEEDER_PITCH_M = 0.1;
const HALF = FEEDER_BAR_M / 2;
const PITCH = FEEDER_PITCH_M;
/** clearance of the approach level above trays / cable tubes / circuits (plus the bar half-width) */
const LEVEL_CLEAR_M = 0.1 + HALF;
/** feeder levels clear every unit top by this much (qa-geometry M1 rule) */
export const FEEDER_UNIT_CLEAR_M = 0.3;
const EPS = 1e-6;

export interface FeederRouteInput {
  id: string;
  hallId: string;
  side: 'A' | 'B';
  buswayId: string;
  /** row-side grouping key (row id + side, else busway id) */
  rowKey: string;
  bAxis: 'x' | 'y';
  /** busway line (perpendicular coordinate) */
  c: number;
  /** along coordinate of the circuit feed end */
  feedA: number;
  aMin: number;
  aMax: number;
  /** circuit bar elevation */
  z: number;
  /** circuit index within the busway (0-based) */
  k: number;
}

export interface FeederLevels {
  hallId: string;
  /** lowest approach level */
  zApproach: number;
  /** first feeder-tray layer */
  zLayer0: number;
  /** highest feeder bar centre in the hall */
  zTop: number;
}

export interface FeederRouting {
  points: Map<string, Vec3[]>;
  penetrations: WallPenetration[];
  levels: FeederLevels[];
}

type Wall = 'N' | 'S' | 'E' | 'W';
interface ABRect { a0: number; a1: number; p0: number; p1: number }
const hit = (r: ABRect, list: readonly ABRect[]) => list.some((q) => r.a0 < q.a1 - EPS && r.a1 > q.a0 + EPS && r.p0 < q.p1 - EPS && r.p1 > q.p0 + EPS);

interface Frame {
  axis: 'x' | 'y';
  L: number;
  P: number;
  flipA: boolean;
  flipP: boolean;
}
const toC = (f: Frame, x: number, y: number): [number, number] => {
  const a = f.axis === 'x' ? x : y;
  const p = f.axis === 'x' ? y : x;
  return [f.flipA ? f.L - a : a, f.flipP ? f.P - p : p];
};
const fromC = (f: Frame, a: number, p: number, z: number): Vec3 => {
  const ra = f.flipA ? f.L - a : a;
  const rp = f.flipP ? f.P - p : p;
  return f.axis === 'x' ? { x: ra, y: rp, z } : { x: rp, y: ra, z };
};
const rectC = (f: Frame, r: Rect): ABRect => {
  const [a0, p0] = toC(f, r.x, r.y);
  const [a1, p1] = toC(f, r.x + r.w, r.y + r.d);
  return { a0: Math.min(a0, a1), a1: Math.max(a0, a1), p0: Math.min(p0, p1), p1: Math.max(p0, p1) };
};

interface Cluster { a0: number; a1: number }

/** Merge along-axis intervals that overlap (pod columns). */
function clustersOf(intervals: readonly [number, number][]): Cluster[] {
  const sorted = [...intervals].sort((p, q) => p[0] - q[0]);
  const out: Cluster[] = [];
  for (const [a0, a1] of sorted) {
    const last = out[out.length - 1];
    // parts of one row split by a column (gap < 1.5 m) stay one pod column: their feeders share the row-end feeder tray
    if (last && a0 < last.a1 + 1.5) last.a1 = Math.max(last.a1, a1);
    else out.push({ a0, a1 });
  }
  return out;
}

interface Placed {
  f: FeederRouteInput;
  /** approach level index (per row side, across split busway parts) */
  kRow: number;
  /** riser along coordinate (real), canonical riser along / row midline / join perpendicular (midline, or the dodge line around a column) */
  rReal: number;
  rA: number;
  midP: number;
  joinP: number;
  cluster: number;
  slot: number;
  layer: number;
}

interface SubBranch {
  cluster: number;
  sub: 'lo' | 'hi' | 'one';
  members: Placed[];
  M: number;
  layers: number;
}

/** Slots and layers within one sub-branch: groups sharing a join (one row side) take contiguous slots, higher approach → nearer slot. */
function allocate(sb: SubBranch, distance: (p: Placed) => number, mCap: number, layersWanted: number) {
  const groups = new Map<number, Placed[]>();
  for (const m of sb.members) {
    const key = Math.round(m.joinP * 1000);
    const g = groups.get(key) ?? [];
    g.push(m);
    groups.set(key, g);
  }
  const gl = [...groups.values()].map((g) => g.sort((x, y) => y.kRow - x.kRow || x.f.id.localeCompare(y.f.id)));
  gl.sort((x, y) => distance(x[0]) - distance(y[0]) || x[0].joinP - y[0].joinP);
  const gMax = Math.max(1, ...gl.map((g) => g.length));
  const M = Math.max(gMax, Math.min(Math.max(1, mCap), Math.ceil(sb.members.length / layersWanted)));
  let layer = 0;
  let slot = 0;
  for (const g of gl) {
    if (slot + g.length > M) {
      layer++;
      slot = 0;
    }
    g.forEach((m, i) => {
      m.slot = slot + i;
      m.layer = layer;
    });
    slot += g.length;
  }
  sb.M = M;
  sb.layers = sb.members.length ? layer + 1 : 0;
}

interface SideResult {
  points: Map<string, Vec3[]>;
  zTop: number;
  /** plan rectangles (real, grown) of the tray-level runs, to detect A / B plan conflicts */
  planRects: Rect[];
  crossings: { along: number; z: number }[];
  /** false when no obstacle-free lane was found and the ordered fallback was used */
  clear: boolean;
}

interface HallCtx {
  hall: Hall;
  axis: 'x' | 'y';
  zA: number;
  outside: number;
  blockersReal: Rect[];
  chimneysReal: Rect[];
  rowFootprintsReal: Rect[];
  clustersReal: Cluster[];
}

const wallNormal = (w: Wall): 'x' | 'y' => (w === 'W' || w === 'E' ? 'x' : 'y');
const LAYER_TRIES = [3, 5, 8, 12, 20];

/**
 * Route one side (one room) of a hall. Nesting rules (canonical frame, feed ends at −a):
 *  parallel room (wall p = 0, sleeve at a_s): each pod column's feeder tray descends to a lane near the wall; columns left of a_s turn +a,
 *   right of a_s turn −a; the column nearest a_s takes the tracks nearest the rows, farther columns pass below it; at a_s every track
 *   turns to the wall, nearer tracks closer to a_s (left: t = T0 + slot; right: t = T0 + M − 1 − slot).
 *  end room (wall a = 0, sleeve at p_s): rows below p_s descend to a lane near p = 0, rows above rise to a lane near p = P; both lanes run
 *   to a wall run in the end aisle, climb / drop to p_s and turn through the wall; the column nearest the wall takes the inner tracks
 *   (t = T0 + M − 1 − slot).
 *  Within a slot, nearer joins take lower layers, so a farther feeder always passes above a nearer feeder's riser.
 */
function routeSide(ctx: HallCtx, room: PowerRoom, feeders: readonly FeederRouteInput[], kRowOf: Map<string, number>, zL0: number): SideResult | null {
  const { hall, axis } = ctx;
  const wall = (room.wall ?? (room.side === 'A' ? (axis === 'x' ? 'W' : 'S') : axis === 'x' ? 'E' : 'N')) as Wall;
  const endRoom = wallNormal(wall) === axis;
  const L = axis === 'x' ? hall.width : hall.depth;
  const P = axis === 'x' ? hall.depth : hall.width;
  const fr: Frame = { axis, L, P, flipA: room.side === 'B', flipP: !endRoom && (wall === 'N' || wall === 'E') };
  const blockers = ctx.blockersReal.map((r) => rectC(fr, r));
  const chimneys = ctx.chimneysReal.map((r) => rectC(fr, r));
  const rowsC = ctx.rowFootprintsReal.map((r) => rectC(fr, r));
  const obstacles = [...blockers, ...chimneys];
  const clusters = ctx.clustersReal.map((c) => ({ a0: fr.flipA ? L - c.a1 : c.a0, a1: fr.flipA ? L - c.a0 : c.a1 })).sort((p, q) => p.a0 - q.a0);
  if (!clusters.length || !feeders.length) return null;
  const maxLayers = Math.max(1, Math.floor((hall.clearHeight - 0.1 - zL0) / PITCH + EPS) + 1);

  // a column / shaft right at a busway part's feed end (row split by a column): move that part's risers inward together until the
  // jog towards a dodge line clears it
  const riserShift = new Map<string, number>();
  for (const f of feeders) {
    if (riserShift.has(f.buswayId)) continue;
    const u = f.side === 'A' ? 1 : -1;
    const midReal = f.c + (f.side === 'A' ? 0.1 : -0.1);
    let shift = 0;
    for (let i = 0; i < 8; i++) {
      const r0 = f.feedA + u * (0.05 + shift);
      const [ra, pa] = toC(fr, f.bAxis === 'x' ? r0 : midReal, f.bAxis === 'x' ? midReal : r0);
      if (!hit({ a0: ra - HALF - 0.05, a1: ra + HALF + 0.05, p0: pa - 1.4, p1: pa + 1.4 }, blockers)) break;
      shift += PITCH;
    }
    riserShift.set(f.buswayId, shift);
  }
  const placed: Placed[] = feeders.map((f) => {
    const u = f.side === 'A' ? 1 : -1;
    const rReal = f.feedA + u * (0.05 + (riserShift.get(f.buswayId) ?? 0) + f.k * PITCH);
    const midReal = f.c + (f.side === 'A' ? 0.1 : -0.1);
    const [rA, midP] = toC(fr, f.bAxis === 'x' ? rReal : midReal, f.bAxis === 'x' ? midReal : rReal);
    const aLo = fr.flipA ? L - f.aMax : f.aMin;
    let ci = clusters.findIndex((c) => aLo >= c.a0 - 0.31 && aLo <= c.a1 + 0.31);
    if (ci < 0) ci = 0;
    return { f, kRow: kRowOf.get(f.id) ?? f.k, rReal, rA, midP, joinP: midP, cluster: ci, slot: 0, layer: 0 };
  });
  // approach dodge: a column / shaft in the row line between the riser and the feeder tray → step sideways at the approach level
  for (const m of placed) {
    const far = clusters[m.cluster].a0 - 1.2;
    const line = (p: number): ABRect => ({ a0: far, a1: m.rA + HALF, p0: p - HALF - 0.05, p1: p + HALF + 0.05 });
    if (!hit(line(m.midP), blockers)) continue;
    // A dodges to +p (real), B to −p, so the two sides of a split row never share a dodge line
    const sgn = (m.f.side === 'A' ? 1 : -1) * (fr.flipP ? -1 : 1);
    for (const d0 of [0.3, 0.45, 0.6, 0.8, 1.0, 1.3, -0.3, -0.45, -0.6, -0.8, -1.0, -1.3]) {
      const d = d0 * sgn;
      const jog: ABRect = { a0: m.rA - HALF - 0.05, a1: m.rA + HALF + 0.05, p0: Math.min(m.midP, m.midP + d) - HALF, p1: Math.max(m.midP, m.midP + d) + HALF };
      if (hit(line(m.midP + d), obstacles) || hit(jog, obstacles)) continue;
      m.joinP = m.midP + d;
      break;
    }
  }
  const rowMinP = rowsC.length ? Math.min(...rowsC.map((r) => r.p0)) : Math.min(...placed.map((m) => m.joinP)) - 1;
  const rowMaxP = rowsC.length ? Math.max(...rowsC.map((r) => r.p1)) : Math.max(...placed.map((m) => m.joinP)) + 1;
  const mCap = (ci: number) => {
    const avail = ci > 0 ? (clusters[ci].a0 - clusters[ci - 1].a1 - 0.3) / 2 - 0.1 : endRoom ? (clusters[ci].a0 - 0.3) * 0.5 : clusters[ci].a0 - 0.45;
    return Math.max(1, Math.floor(Math.max(0, avail) / PITCH) + 1);
  };
  // feeder-tray base per column: 0.15 m outside the row ends, pushed outward past any column / shaft over the branch height
  const bases: number[] = clusters.map((c) => c.a0 - 0.15);
  const fixBases = (subs: SubBranch[]) => {
    clusters.forEach((c, ci) => {
      const M = Math.max(1, ...subs.filter((s) => s.cluster === ci).map((s) => s.M));
      const own = placed.filter((m) => m.cluster === ci);
      if (!own.length) return;
      const p0 = endRoom ? Math.max(0.3, rowMinP - 1.0) : Math.max(0.3, rowMinP - 1.0);
      const p1 = endRoom ? Math.min(P - 0.3, rowMaxP + 1.0) : Math.max(...own.map((m) => m.joinP)) + 0.1;
      // pushed outward past columns, shafts and ducted chimneys (a column-split row must not branch across its own hot aisle)
      let b = c.a0 - 0.15;
      for (let i = 0; i < 80; i++) {
        const r: ABRect = { a0: b - (M - 1) * PITCH - HALF - 0.05, a1: b + HALF + 0.05, p0, p1 };
        const hits = obstacles.filter((q) => hit(r, [q]));
        if (!hits.length) break;
        b = Math.min(...hits.map((q) => q.a0)) - HALF - 0.05 - 0.01;
      }
      bases[ci] = b;
    });
  };
  const branchRange = (sb: SubBranch): [number, number] => [bases[sb.cluster] - (sb.M - 1) * PITCH - HALF, bases[sb.cluster] + HALF];
  const points = new Map<string, Vec3[]>();
  const planRects: Rect[] = [];
  const crossings: { along: number; z: number }[] = [];
  let zTop = zL0;

  const emit = (m: Placed, track: [number, number][], through: { along: number }) => {
    const f = m.f;
    const zL = zL0 + m.layer * PITCH;
    zTop = Math.max(zTop, zL);
    const zAk = ctx.zA + m.kRow * PITCH;
    const rReal = m.rReal;
    const midReal = f.c + (f.side === 'A' ? 0.1 : -0.1);
    const pt = (a: number, c: number, z: number): Vec3 => (f.bAxis === 'x' ? { x: a, y: c, z } : { x: c, y: a, z });
    // start on the edge of the circuit bar (0.035 m off its centre line, towards the midline) so the stub stays clear of the row tray
    const edge = f.c + (midReal > f.c ? 0.035 : -0.035);
    const aSlot = track[0][0];
    const pts: Vec3[] = [
      pt(rReal, edge, f.z), pt(rReal, midReal, f.z), pt(rReal, midReal, zAk),
      fromC(fr, m.rA, m.joinP, zAk), fromC(fr, aSlot, m.joinP, zAk), fromC(fr, aSlot, m.joinP, zL),
    ];
    for (const [a, p] of track) pts.push(fromC(fr, a, p, zL));
    const clean = pts.filter((q, i) => i === 0 || Math.hypot(q.x - pts[i - 1].x, q.y - pts[i - 1].y, q.z - pts[i - 1].z) > EPS);
    points.set(f.id, clean);
    crossings.push({ along: through.along, z: zL });
    for (let i = 0; i < clean.length - 1; i++) {
      const s = clean[i];
      const e = clean[i + 1];
      if (Math.abs(s.z - e.z) > EPS || s.z < zL0 - EPS) continue;
      planRects.push({ x: Math.min(s.x, e.x) - HALF - 0.05, y: Math.min(s.y, e.y) - HALF - 0.05, w: Math.abs(e.x - s.x) + FEEDER_BAR_M + 0.1, d: Math.abs(e.y - s.y) + FEEDER_BAR_M + 0.1 });
    }
  };
  const wallAlong = (a: number, p: number) => {
    const q = fromC(fr, a, p, 0);
    return wallNormal(wall) === 'x' ? q.y : q.x;
  };
  const off = ctx.outside;

  if (!endRoom) {
    // ── parallel room: one sub-branch per column, lane near p = 0, sleeve at a_s ──
    const subs: SubBranch[] = clusters.map((_, ci) => ({ cluster: ci, sub: 'one' as const, members: placed.filter((m) => m.cluster === ci), M: 1, layers: 0 })).filter((s) => s.members.length);
    const minJoin = Math.min(...placed.map((m) => m.joinP));
    const laneCeil = Math.min(rowMinP, minJoin) - 0.15 - HALF;
    // qa-autosize v2 2차 (§3): the sleeve stays within this room's span along the wall — two rooms side by side on one parallel wall
    // (A low half, B high half) each get their own sleeve; a room along the whole wall keeps the wall centre as before
    const [ra0] = toC(fr, room.rect.x, room.rect.y);
    const [ra1] = toC(fr, room.rect.x + room.rect.w, room.rect.y + room.rect.d);
    const rs0 = Math.max(0.5, Math.min(ra0, ra1));
    const rs1 = Math.min(L - 0.5, Math.max(ra0, ra1));
    const center = (rs0 + rs1) / 2;
    let best: { as: number; laneTop: number; left: SubBranch[]; right: SubBranch[] } | null = null;
    for (const lw of LAYER_TRIES) {
      for (const sb of subs) allocate(sb, (m) => m.joinP, mCap(sb.cluster), lw);
      if (subs.some((s) => s.layers > maxLayers) && lw !== LAYER_TRIES[0]) break;
      fixBases(subs);
      for (let i = 0; i <= Math.ceil(L / PITCH) && !best; i++) {
        const cand = center + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * PITCH;
        if (cand < rs0 || cand > rs1) continue;
        const left = subs.filter((s) => bases[s.cluster] < cand).sort((x, y) => bases[y.cluster] - bases[x.cluster]);
        const right = subs.filter((s) => bases[s.cluster] >= cand).sort((x, y) => bases[x.cluster] - bases[y.cluster]);
        const TL = left.reduce((s, b) => s + b.M, 0);
        const TR = right.reduce((s, b) => s + b.M, 0);
        const d0 = cand - (TL ? 0.05 + (TL - 1) * PITCH : 0) - HALF - 0.05;
        const d1 = cand + (TR ? 0.05 + (TR - 1) * PITCH : 0) + HALF + 0.05;
        if (d0 < 0.5 || d1 > L - 0.5) continue;
        if (subs.some((s) => {
          const [b0, b1] = branchRange(s);
          return d0 < b1 + 0.1 && d1 > b0 - 0.1;
        })) continue;
        const T = Math.max(TL, TR, 1);
        const allA0 = Math.min(d0, ...subs.map((s) => branchRange(s)[0])) - 0.05;
        const allA1 = Math.max(d1, ...subs.map((s) => branchRange(s)[1])) + 0.05;
        const descentFree = (lt: number) => !hit({ a0: d0, a1: d1, p0: 0, p1: lt }, obstacles);
        if (!descentFree(0.35 + (T - 1) * PITCH + HALF)) continue;
        for (let lt = 0.35 + (T - 1) * PITCH + HALF; lt <= laneCeil + EPS; lt += 0.05) {
          const lane: ABRect = { a0: allA0, a1: allA1, p0: lt - (T - 1) * PITCH - HALF - 0.05, p1: lt + HALF + 0.05 };
          if (hit(lane, obstacles) || !descentFree(lt)) continue;
          if (subs.some((s) => {
            const [b0, b1] = branchRange(s);
            return hit({ a0: b0 - 0.05, a1: b1 + 0.05, p0: lt, p1: Math.max(...s.members.map((m) => m.joinP)) }, obstacles);
          })) continue;
          best = { as: cand, laneTop: lt, left, right };
          break;
        }
      }
      if (best) break;
    }
    const clear = !!best;
    if (!best) {
      for (const sb of subs) allocate(sb, (m) => m.joinP, mCap(sb.cluster), LAYER_TRIES[0]);
      fixBases(subs);
      const left = subs.filter((s) => bases[s.cluster] < center).sort((x, y) => bases[y.cluster] - bases[x.cluster]);
      const right = subs.filter((s) => bases[s.cluster] >= center).sort((x, y) => bases[x.cluster] - bases[y.cluster]);
      const T = Math.max(1, left.reduce((s, b) => s + b.M, 0), right.reduce((s, b) => s + b.M, 0));
      best = { as: center, laneTop: Math.max(0.35 + (T - 1) * PITCH, Math.min(laneCeil, 1.2)), left, right };
    }
    const { as, laneTop } = best;
    let T0 = 0;
    for (const sb of best.left) {
      for (const m of sb.members) {
        const t = T0 + m.slot;
        const aSlot = bases[sb.cluster] - m.slot * PITCH;
        const pT = laneTop - t * PITCH;
        const aSl = as - 0.05 - t * PITCH;
        emit(m, [[aSlot, m.joinP], [aSlot, pT], [aSl, pT], [aSl, -off]], { along: wallAlong(aSl, 0) });
      }
      T0 += sb.M;
    }
    T0 = 0;
    for (const sb of best.right) {
      for (const m of sb.members) {
        const t = T0 + (sb.M - 1 - m.slot);
        const aSlot = bases[sb.cluster] - m.slot * PITCH;
        const pT = laneTop - t * PITCH;
        const aSl = as + 0.05 + t * PITCH;
        emit(m, [[aSlot, m.joinP], [aSlot, pT], [aSl, pT], [aSl, -off]], { along: wallAlong(aSl, 0) });
      }
      T0 += sb.M;
    }
    return { points, zTop, planRects, crossings, clear };
  }

  // ── end room: lanes near p = 0 (lo) and p = P (hi), wall run in the end aisle, sleeve at p_s ──
  const [, sp0] = toC(fr, room.rect.x, room.rect.y);
  const [, sp1] = toC(fr, room.rect.x + room.rect.w, room.rect.y + room.rect.d);
  const span0 = Math.max(0.5, Math.min(sp0, sp1));
  const span1 = Math.min(P - 0.5, Math.max(sp0, sp1));
  const minBranchA = (subs: SubBranch[]) => Math.min(...subs.map((s) => branchRange(s)[0]));
  const maxBranchA = (subs: SubBranch[]) => Math.max(...subs.map((s) => branchRange(s)[1]));
  const center = (span0 + span1) / 2;
  let plan: { ps: number; lo: SubBranch[]; hi: SubBranch[]; loTop: number; hiBot: number; aW: number } | null = null;
  const build = (ps: number, lw: number) => {
    const mk = (sub: 'lo' | 'hi') => clusters.map((_, ci) => ({ cluster: ci, sub, members: placed.filter((m) => m.cluster === ci && (sub === 'lo' ? m.joinP < ps : m.joinP >= ps)), M: 1, layers: 0 } as SubBranch)).filter((s) => s.members.length);
    const lo = mk('lo');
    const hi = mk('hi');
    for (const sb of lo) allocate(sb, (m) => m.joinP, mCap(sb.cluster), lw);
    for (const sb of hi) allocate(sb, (m) => P - m.joinP, mCap(sb.cluster), lw);
    fixBases([...lo, ...hi]);
    return { lo, hi };
  };
  for (const lw of LAYER_TRIES) {
    for (let i = 0; i <= Math.ceil((span1 - span0) / PITCH) + 1 && !plan; i++) {
      const ps = center + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * PITCH;
      if (ps < span0 || ps > span1) continue;
      if (placed.some((m) => Math.abs(m.joinP - ps) < 0.06)) continue;
      const { lo, hi } = build(ps, lw);
      if ([...lo, ...hi].some((s) => s.layers > maxLayers) && lw !== LAYER_TRIES[0]) continue;
      const Tlo = lo.reduce((s, b) => s + b.M, 0);
      const Thi = hi.reduce((s, b) => s + b.M, 0);
      const s0 = ps - (Tlo ? 0.05 + (Tlo - 1) * PITCH : 0) - HALF - 0.05;
      const s1 = ps + (Thi ? 0.05 + (Thi - 1) * PITCH : 0) + HALF + 0.05;
      if (s0 < span0 - 0.3 || s1 > span1 + 0.3 || s0 < 0.5 || s1 > P - 0.5) continue;
      const all = [...lo, ...hi];
      const T = Math.max(Tlo, Thi, 1);
      const branchLo = minBranchA(all);
      let loTop = NaN;
      if (Tlo) {
        const ceil = Math.min(rowMinP, ...lo.flatMap((s) => s.members.map((m) => m.joinP))) - 0.15 - HALF;
        for (let lt = 0.35 + (Tlo - 1) * PITCH + HALF; lt <= ceil + EPS; lt += 0.05) {
          const lane: ABRect = { a0: branchLo - T * PITCH - 0.6, a1: maxBranchA(lo) + 0.05, p0: lt - (Tlo - 1) * PITCH - HALF - 0.05, p1: lt + HALF + 0.05 };
          if (hit(lane, obstacles)) continue;
          if (lo.some((s) => hit({ a0: branchRange(s)[0] - 0.05, a1: branchRange(s)[1] + 0.05, p0: lt, p1: Math.max(...s.members.map((m) => m.joinP)) }, obstacles))) continue;
          loTop = lt;
          break;
        }
        if (Number.isNaN(loTop)) continue;
      }
      let hiBot = NaN;
      if (Thi) {
        const floor = Math.max(rowMaxP, ...hi.flatMap((s) => s.members.map((m) => m.joinP))) + 0.15 + HALF;
        for (let lb = P - 0.35 - (Thi - 1) * PITCH - HALF; lb >= floor - EPS; lb -= 0.05) {
          const lane: ABRect = { a0: branchLo - T * PITCH - 0.6, a1: maxBranchA(hi) + 0.05, p0: lb - HALF - 0.05, p1: lb + (Thi - 1) * PITCH + HALF + 0.05 };
          if (hit(lane, obstacles)) continue;
          if (hi.some((s) => hit({ a0: branchRange(s)[0] - 0.05, a1: branchRange(s)[1] + 0.05, p0: Math.min(...s.members.map((m) => m.joinP)), p1: lb }, obstacles))) continue;
          hiBot = lb;
          break;
        }
        if (Number.isNaN(hiBot)) continue;
      }
      const pRun0 = Tlo ? loTop - (Tlo - 1) * PITCH - HALF - 0.05 : s0;
      const pRun1 = Thi ? hiBot + (Thi - 1) * PITCH + HALF + 0.05 : s1;
      let aW = NaN;
      for (let aw = branchLo - 0.15; aw - (T - 1) * PITCH - HALF >= 0.3; aw -= 0.05) {
        const run: ABRect = { a0: aw - (T - 1) * PITCH - HALF - 0.05, a1: aw + HALF + 0.05, p0: pRun0, p1: pRun1 };
        const through: ABRect = { a0: -0.01, a1: aw, p0: s0, p1: s1 };
        if (hit(run, obstacles) || hit(through, obstacles)) continue;
        aW = aw;
        break;
      }
      if (Number.isNaN(aW)) continue;
      plan = { ps, lo, hi, loTop, hiBot, aW };
    }
    if (plan) break;
  }
  const clear = !!plan;
  if (!plan) {
    const ps = center;
    const { lo, hi } = build(ps, LAYER_TRIES[0]);
    const all = [...lo, ...hi];
    const Tlo = lo.reduce((s, b) => s + b.M, 0);
    const Thi = hi.reduce((s, b) => s + b.M, 0);
    plan = { ps, lo, hi, loTop: Math.max(0.35 + (Tlo - 1) * PITCH, rowMinP - 0.4), hiBot: Math.min(P - 0.35 - (Thi - 1) * PITCH, rowMaxP + 0.4), aW: Math.max(0.3 + (Math.max(Tlo, Thi, 1) - 1) * PITCH, minBranchA(all) - 0.3) };
  }
  const { ps, loTop, hiBot, aW } = plan;
  let T0 = 0;
  for (const sb of [...plan.lo].sort((x, y) => bases[x.cluster] - bases[y.cluster])) {
    for (const m of sb.members) {
      const t = T0 + (sb.M - 1 - m.slot);
      const aSlot = bases[sb.cluster] - m.slot * PITCH;
      const pT = loTop - t * PITCH;
      const aWr = aW - t * PITCH;
      const pSl = ps - 0.05 - t * PITCH;
      emit(m, [[aSlot, m.joinP], [aSlot, pT], [aWr, pT], [aWr, pSl], [-off, pSl]], { along: wallAlong(0, pSl) });
    }
    T0 += sb.M;
  }
  T0 = 0;
  for (const sb of [...plan.hi].sort((x, y) => bases[x.cluster] - bases[y.cluster])) {
    for (const m of sb.members) {
      const t = T0 + (sb.M - 1 - m.slot);
      const aSlot = bases[sb.cluster] - m.slot * PITCH;
      const pT = hiBot + t * PITCH;
      const aWr = aW - t * PITCH;
      const pSl = ps + 0.05 + t * PITCH;
      emit(m, [[aSlot, m.joinP], [aSlot, pT], [aWr, pT], [aWr, pSl], [-off, pSl]], { along: wallAlong(0, pSl) });
    }
    T0 += sb.M;
  }
  return { points, zTop, planRects, crossings, clear };
}

const rectsHit = (a: readonly Rect[], b: readonly Rect[]) => a.some((r) => b.some((q) => r.x < q.x + q.w - EPS && r.x + r.w > q.x + EPS && r.y < q.y + q.d - EPS && r.y + r.d > q.y + EPS));

/** Sleeve rectangles from crossing points (merged when closer than `gap` along the wall). */
export function sleevesFromCrossings(points: { along: number; z: number }[], gap = 0.5, margin = HALF + 0.05): { along: [number, number]; z: [number, number]; runs: number }[] {
  const sorted = [...points].sort((p, q) => p.along - q.along);
  const out: { along: [number, number]; z: [number, number]; runs: number }[] = [];
  for (const q of sorted) {
    const last = out[out.length - 1];
    if (last && q.along - last.along[1] <= gap) {
      last.along[1] = q.along;
      last.z = [Math.min(last.z[0], q.z), Math.max(last.z[1], q.z)];
      last.runs++;
    } else out.push({ along: [q.along, q.along], z: [q.z, q.z], runs: 1 });
  }
  return out.map((s) => ({ along: [round3(s.along[0] - margin), round3(s.along[1] + margin)], z: [round3(s.z[0] - margin), round3(s.z[1] + margin)], runs: s.runs }));
}
const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Feeder approach level for a hall: above the main tray and cable tubes, every unit top + 0.3 m and the circuits. */
export function feederApproachLevel(project: Project, hall: Hall, circuitTopZ: number): number {
  let unitTop = 0;
  for (const e of project.equipment) {
    if (e.hallId !== hall.id) continue;
    const item = findCatalogItem(e.catalogId);
    if (item) unitTop = Math.max(unitTop, (e.elevation ?? 0) + item.dims.h);
  }
  return Math.ceil((Math.max(hall.trayHeight + 0.6, unitTop + FEEDER_UNIT_CLEAR_M, circuitTopZ + 0.1) + LEVEL_CLEAR_M) / 0.005) * 0.005;
}

/**
 * Route every feeder of the project to its room through one sleeve per room and return the polylines, the wall sleeves and the
 * partition sleeves (feeders crossing a separate-room partition).
 */
export function routeFeeders(project: Project, rooms: readonly PowerRoom[], feeders: readonly FeederRouteInput[], outsideM: number): FeederRouting {
  const pointsAll = new Map<string, Vec3[]>();
  const penetrations: WallPenetration[] = [];
  const levels: FeederLevels[] = [];
  for (const hall of project.halls) {
    const hf = feeders.filter((f) => f.hallId === hall.id);
    if (!hf.length) continue;
    const xCount = hf.filter((f) => f.bAxis === 'x').length;
    const axis: 'x' | 'y' = xCount * 2 >= hf.length ? 'x' : 'y';
    const eq = project.equipment.filter((e) => e.hallId === hall.id);
    const rowFootprints: Rect[] = [];
    for (const e of eq) {
      const item = findCatalogItem(e.catalogId);
      if (item && e.rowId) rowFootprints.push(footprintRect(item.dims, e.position, e.rotationDeg));
    }
    const zA = feederApproachLevel(project, hall, Math.max(...hf.map((f) => f.z)) + 0.04);
    // approach level per row side: busway parts nearest the room first
    const kRowOf = new Map<string, number>();
    const byRow = new Map<string, FeederRouteInput[]>();
    for (const f of hf) {
      const g = byRow.get(f.rowKey) ?? [];
      g.push(f);
      byRow.set(f.rowKey, g);
    }
    let maxK = 0;
    for (const g of byRow.values()) {
      const parts = [...new Set(g.map((f) => f.buswayId))].map((id) => g.filter((f) => f.buswayId === id));
      parts.sort((p, q) => (p[0].side === 'A' ? p[0].aMin - q[0].aMin : q[0].aMax - p[0].aMax));
      let offset = 0;
      for (const part of parts) {
        const K = Math.max(...part.map((f) => f.k)) + 1;
        for (const f of part) kRowOf.set(f.id, offset + f.k);
        offset += K;
      }
      maxK = Math.max(maxK, offset);
    }
    const zL0 = round3(zA + Math.max(0, maxK - 1) * PITCH + 0.15);
    const ctx: HallCtx = {
      hall, axis, zA, outside: outsideM,
      blockersReal: blockingKeepouts(hall.keepouts, 0.05 + HALF),
      // drawn containment: door frames 0.025 m past the aisle ends, blanking panels 0.06 m beside it (Containment.tsx)
      chimneysReal: project.containments.filter((c) => c.hallId === hall.id && c.ductedToPlenum).map((c) => ({ x: c.rect.x - 0.06, y: c.rect.y - 0.06, w: c.rect.w + 0.12, d: c.rect.d + 0.12 })),
      rowFootprintsReal: rowFootprints,
      clustersReal: clustersOf(hf.map((f) => [f.aMin, f.aMax] as [number, number])),
    };
    const results: { room: PowerRoom; res: SideResult }[] = [];
    for (const side of ['A', 'B'] as const) {
      const room = rooms.find((r) => r.hallId === hall.id && r.side === side);
      const sf = hf.filter((f) => f.side === side);
      if (!room || !sf.length) continue;
      let res = routeSide(ctx, room, sf, kRowOf, zL0);
      // B is raised above A where their feeder trays share plan area
      if (res && results.length && results.some((o) => rectsHit(o.res.planRects, res!.planRects))) {
        res = routeSide(ctx, room, sf, kRowOf, round3(Math.max(...results.map((o) => o.res.zTop)) + 0.15));
      }
      if (res) results.push({ room, res });
    }
    let zTop = zL0;
    for (const { room, res } of results) {
      for (const [id, pts] of res.points) pointsAll.set(id, pts);
      zTop = Math.max(zTop, res.zTop);
      sleevesFromCrossings(res.crossings, 1e9).forEach((s, i) => penetrations.push({ id: `pen-${room.id}${i ? `-${i + 1}` : ''}`, hallId: hall.id, wall: room.wall ?? 'W', along: s.along, z: s.z, kind: 'feeder-sleeve', targetId: room.id, runs: s.runs }));
    }
    levels.push({ hallId: hall.id, zApproach: zA, zLayer0: zL0, zTop });
    // partition sleeves where feeders cross a separate-room partition
    for (const pw of partitionWalls(hall, project.reservations, eq)) {
      const cross: { along: number; z: number }[] = [];
      const cMid = (pw.c0 + pw.c1) / 2;
      for (const f of hf) {
        const pts = pointsAll.get(f.id) ?? [];
        for (let i = 0; i < pts.length - 1; i++) {
          const s = pts[i];
          const e = pts[i + 1];
          const ps = pw.axis === 'x' ? s.y : s.x;
          const pe = pw.axis === 'x' ? e.y : e.x;
          if ((ps - cMid) * (pe - cMid) > 0 || Math.abs(pe - ps) < EPS) continue;
          const t = (cMid - ps) / (pe - ps);
          const along = pw.axis === 'x' ? s.x + (e.x - s.x) * t : s.y + (e.y - s.y) * t;
          if (!pw.spans.some(([a0, a1]) => along > a0 - 0.05 && along < a1 + 0.05)) continue;
          cross.push({ along, z: s.z + (e.z - s.z) * t });
        }
      }
      sleevesFromCrossings(cross).forEach((s, i) => penetrations.push({ id: `pen-${pw.reservationId}-feeders-${i + 1}`, hallId: hall.id, wall: 'partition', reservationId: pw.reservationId, along: s.along, z: s.z, kind: 'partition-sleeve', targetId: 'feeders', runs: s.runs, plane: round3(cMid), planeAxis: pw.axis }));
    }
  }
  return { points: pointsAll, penetrations, levels };
}
