// Wall-piercing / clash audit of everything the 3D view draws above the floor (finish v2 2차, DECISIONS-v2-2 §D1,
// docs/research/r3-geometry-audit-plan.md §2 / §4.3). Pure: works on the project + analysis the viewer reads, with the same widths.
//
// Classes: IN (trays, busways, circuits, tap-offs, cable bundles, equipment) must stay inside the hall; PEN (power feeders, inter-hall
// trunks) may cross a wall only perpendicular and inside a declared WallPenetration of their kind; anything crossing a separate-room
// partition or the wall of a ducted hot-aisle chimney needs a partition sleeve. Feeders must also clear racks and units by 0.3 m, never
// enter containment, columns or shafts, never overlap one another and never clash with trays, busways or another busway's circuits.
import type { Hall, PowerRoom, Project, ProjectAnalysis, Vec3, WallPenetration } from '../model/types.ts';
import { buildHallPrims } from '../scene/build.ts';
import { resolveVerticals } from '../scene/datums.ts';
import { FEEDER_PITCH_M } from '../engines/powerGeometry.ts';
import { buildTierTrays, detectRowGroups } from './rows.ts';
import { primAabb, type HallPrims, type Prim } from '../scene/prims.ts';
import { cableRunPaths, type CableSkipReason } from './geometry3d.ts';

export interface WallAuditViolation {
  check: string;
  hallId: string;
  id: string;
  other?: string;
  at: Vec3;
  depthM?: number;
  /** T1b: the service tier / feeder layer the violation sits on (e.g. 'feeder layer 8 of 8 · z 5.10 m') */
  tier?: string;
  /** T1b: remedy hint id ('second-feeder-level' | 'split-electrical-rooms') */
  hint?: string;
}

export interface WallAuditReport {
  hallId: string;
  violations: WallAuditViolation[];
  counts: Record<string, number>;
  coverage: Partial<Record<CableSkipReason, number>>;
  feederSegments: number;
  wallCrossings: number;
  penetrations: number;
}

/** Checks that must be zero (the test sweep and the D1 acceptance rule). Reported-only checks: wall-clearance, hall-overlaps-hall, cable-through-keepout, budget / no-row coverage. */
export const WALL_AUDIT_FAIL_CHECKS: readonly string[] = [
  'outside', 'non-penetrating-crosses-wall', 'oblique-wall-crossing', 'unsleeved-wall-crossing', 'sleeve-below-tray-level', 'sleeve-near-corner',
  'feeder-over-rack', 'feeder-over-unit', 'feeder-through-containment', 'feeder-through-keepout', 'feeder-overlap', 'feeder-clash',
  'unsleeved-partition-crossing', 'unsleeved-chimney-crossing', 'room-overlaps-hall-unflagged', 'room-overlaps-room-unflagged',
  'coverage-mixed-axis', 'coverage-inter-hall-no-sleeve',
  // T1b (backlog-T1b §3–4): derived pipes clear of the other services, walls and columns; trunk bundles clear of feeders
  'pipe-outside', 'pipe-clash', 'feeder-trunk-clash',
  // QA backlog geometry: per-tier trays clear of the other trays, busways, tap-offs, containment and columns
  'tier-tray-clash',
];

/** T1b: feeders above this depth below the clear height sit in the sprinkler / lighting / access zone (m, estimate: NFPA 13 deflector clearance 0.46 m + fixtures) */
export const FEEDER_CEILING_ZONE_M = 1.0;
/** T1b: clearance a derived pipe keeps to every other service (m); boxes closer than this but not overlapping are not reported */
const PIPE_TOL_M = 1e-3;

export interface WallAuditOptions {
  /**
   * Scene prims of the hall (`buildHallPrims(project, analysis, { hallId, detail: 'pod' })`). The audit reads exactly the geometry the
   * 3D viewer, the 2D view and the sheets draw (r4 S1); pass them to reuse a build, otherwise they are built here.
   */
  prims?: HallPrims;
}

const TOL = 0.005;
type Kind = 'tray' | 'busway' | 'circuit' | 'tapoff' | 'feeder' | 'cable' | 'trunk' | 'pipe' | 'tier';
interface Box { min: Vec3; max: Vec3 }
interface Seg extends Box { kind: Kind; id: string; a: Vec3; b: Vec3; buswayId?: string; toId?: string }

const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
const overlap3 = (p: Box, q: Box) => ({ x: ov(p.min.x, p.max.x, q.min.x, q.max.x), y: ov(p.min.y, p.max.y, q.min.y, q.max.y), z: ov(p.min.z, p.max.z, q.min.z, q.max.z) });
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const P = (v: Vec3): Vec3 => ({ x: r3(v.x), y: r3(v.y), z: r3(v.z) });
const capsuleBox = (a: Vec3, b: Vec3, r: number): Box => ({ min: { x: Math.min(a.x, b.x) - r, y: Math.min(a.y, b.y) - r, z: Math.min(a.z, b.z) - r }, max: { x: Math.max(a.x, b.x) + r, y: Math.max(a.y, b.y) + r, z: Math.max(a.z, b.z) + r } });
/** column / shaft growth of the feeder and cable keepout checks (m), as layout/rows.ts blockingKeepouts(…, 0.05) */
const KEEPOUT_GROW_M = 0.05;

/** Audit segment of a prim: its AABB, and its centre line (bars / tubes) or its min → max diagonal (boxes). */
function primSeg(p: Prim, kind: Kind, extra: Partial<Seg> = {}): Seg {
  const box = primAabb(p);
  return { kind, id: p.refId ?? p.id, a: p.a, b: p.b, ...box, ...extra };
}

export function auditHallGeometry(project: Project, analysis: ProjectAnalysis, hallId: string, opts: WallAuditOptions = {}): WallAuditReport {
  const hall = project.halls.find((h) => h.id === hallId) as Hall;
  const W = hall.width;
  const D = hall.depth;
  const v: WallAuditViolation[] = [];
  const add = (check: string, id: string, at: Vec3, extra: Partial<WallAuditViolation> = {}) => v.push({ check, hallId, id, at: P(at), ...extra });
  const eq = project.equipment.filter((e) => e.hallId === hallId);
  const pens: WallPenetration[] = [...(analysis.power.penetrations ?? []), ...(analysis.network.penetrations ?? [])].filter((p) => p.hallId === hallId);
  const hp = opts.prims && opts.prims.hallId === hallId && opts.prims.detail === 'pod' ? opts.prims : buildHallPrims(project, analysis, { hallId, detail: 'pod' });

  // ── primitives: the scene prims (r4 S1) ──
  const racks: (Box & { id: string })[] = [];
  const units: (Box & { id: string })[] = [];
  const contBoxes = new Map<string, Box>();
  const blockers: Box[] = [];
  const segs: Seg[] = [];
  const partitions = new Map<string, { axis: 'x' | 'y'; c: number; spans: [number, number][]; z1: number }>();
  const chimneys: { id: string; axis: 'x' | 'y'; c: number; spans: [number, number][]; z0: number; z1: number }[] = [];
  let feederSegments = 0;
  const pipes: Seg[] = [];
  const contParts: (Box & { id: string })[] = [];
  for (const p of hp.prims) {
    switch (p.emitter) {
      case 'rack':
      case 'unit': {
        const b = primAabb(p);
        (p.emitter === 'rack' ? racks : units).push({ id: p.tag || p.refId || p.id, ...b });
        break;
      }
      case 'containment-panel':
      case 'containment-roof':
      case 'door': {
        if (p.emitter === 'door' && p.layer !== 'containment-doors') break;
        const b = primAabb(p);
        contParts.push({ id: p.refId ?? p.id, ...b });
        const key = p.refId ?? p.id;
        const u = contBoxes.get(key);
        contBoxes.set(key, u ? { min: { x: Math.min(u.min.x, b.min.x), y: Math.min(u.min.y, b.min.y), z: Math.min(u.min.z, b.min.z) }, max: { x: Math.max(u.max.x, b.max.x), y: Math.max(u.max.y, b.max.y), z: Math.max(u.max.z, b.max.z) } } : b);
        // backlog finish (qa-backlog-geometry.md open item 4): the end transoms above the doors close the ducted chimney too — a segment
        // through a transom needs a sleeve like one through a chimney side wall. A transom lies across the containment axis.
        if (p.emitter === 'containment-roof' && (p.meta?.part === 'chimney' || p.meta?.part === 'transom')) {
          const along: 'x' | 'y' = p.meta.axis === 'y' ? 'y' : 'x';
          const axis: 'x' | 'y' = p.meta.part === 'transom' ? (along === 'x' ? 'y' : 'x') : along;
          chimneys.push({ id: key, axis, c: axis === 'x' ? (b.min.y + b.max.y) / 2 : (b.min.x + b.max.x) / 2, spans: [axis === 'x' ? [b.min.x, b.max.x] : [b.min.y, b.max.y]], z0: b.min.z, z1: b.max.z });
        }
        break;
      }
      case 'column': {
        const b = primAabb(p);
        const g = KEEPOUT_GROW_M;
        blockers.push({ min: { x: b.min.x - g, y: b.min.y - g, z: 0 }, max: { x: b.max.x + g, y: b.max.y + g, z: 99 } });
        break;
      }
      case 'partition': {
        const b = primAabb(p);
        const axis: 'x' | 'y' = p.meta?.axis === 'y' ? 'y' : 'x';
        const key = p.refId ?? p.id;
        const w = partitions.get(key) ?? { axis, c: axis === 'x' ? (b.min.y + b.max.y) / 2 : (b.min.x + b.max.x) / 2, spans: [], z1: b.max.z };
        w.spans.push(axis === 'x' ? [b.min.x, b.max.x] : [b.min.y, b.max.y]);
        partitions.set(key, w);
        break;
      }
      case 'tray':
      case 'drop':
        segs.push(primSeg(p, 'tray'));
        break;
      case 'busway':
        segs.push(primSeg(p, 'busway', { buswayId: p.refId }));
        break;
      case 'circuit':
        segs.push(primSeg(p, 'circuit', { buswayId: p.meta?.buswayId as string | undefined, toId: p.meta?.toId as string | undefined }));
        break;
      case 'feeder':
        segs.push(primSeg(p, 'feeder', { buswayId: p.meta?.buswayId as string | undefined, toId: p.meta?.toId as string | undefined }));
        feederSegments++;
        break;
      case 'tapoff':
        segs.push(primSeg(p, 'tapoff', { buswayId: (p.meta?.buswayId as string | undefined) ?? p.refId }));
        break;
      case 'pipe':
        pipes.push(primSeg(p, 'pipe', { id: (p.meta?.runId as string | undefined) ?? p.id }));
        break;
    }
  }
  const conts = [...contBoxes.entries()].map(([id, box]) => ({ id, box }));
  // per-tier trays (T2 / T3, layout/rows.ts buildTierTrays), not yet scene prims: inside the hall (IN) and against pipes; feeders crossing
  // them are reported only ('tier-tray-feeder-clash'), because the feeder router does not read them yet (backlog-T1b §2)
  const hallTrays = (project.trays ?? []).filter((t) => t.hallId === hallId);
  for (const t of buildTierTrays(hall, detectRowGroups(project, hall), eq, hallTrays.length ? hallTrays : undefined)) {
    for (let i = 0; i < t.points.length - 1; i++) {
      const bx = capsuleBox(t.points[i], t.points[i + 1], 0);
      const hw = t.widthM / 2;
      const alongX = Math.abs(t.points[i + 1].x - t.points[i].x) > Math.abs(t.points[i + 1].y - t.points[i].y);
      segs.push({ kind: 'tier', id: t.id, a: t.points[i], b: t.points[i + 1], min: { x: bx.min.x - (alongX ? 0 : hw), y: bx.min.y - (alongX ? hw : 0), z: bx.min.z - 0.048 }, max: { x: bx.max.x + (alongX ? 0 : hw), y: bx.max.y + (alongX ? hw : 0), z: bx.max.z + 0.048 } });
    }
  }
  const cableGeo = cableRunPaths(hall, eq, analysis.network.cableRuns, project.trays, { allEquipment: project.equipment, trunkSleeves: pens, containments: project.containments });
  const hallOf = new Map(project.equipment.map((e) => [e.id, e.hallId]));
  const runById = new Map(analysis.network.cableRuns.map((r) => [r.id, r]));
  for (const c of cableGeo.paths) {
    const run = runById.get(c.runId);
    const trunk = !!run && (hallOf.get(run.fromId) !== hallId || hallOf.get(run.toId) !== hallId);
    for (let i = 0; i < c.points.length - 1; i++) segs.push({ kind: trunk ? 'trunk' : 'cable', id: c.runId, a: c.points[i], b: c.points[i + 1], ...capsuleBox(c.points[i], c.points[i + 1], c.radius) });
  }

  // ── 1. outside / wall clearance (IN) ──
  const depthOut = (b: Box): [string, number] => ([['W', -b.min.x], ['E', b.max.x - W], ['S', -b.min.y], ['N', b.max.y - D]] as [string, number][]).reduce((p, q) => (q[1] > p[1] ? q : p));
  for (const s of segs) {
    if (s.kind === 'feeder' || s.kind === 'trunk') continue;
    const [wall, d] = depthOut(s);
    if (d > TOL) add('outside', s.id, s.a, { other: wall, depthM: r3(d) });
    else if (-d < 0.1 - 1e-6) add('wall-clearance', s.id, s.a, { other: wall, depthM: r3(-d) });
  }
  for (const b of [...racks, ...units]) {
    const [wall, d] = depthOut(b);
    if (d > TOL) add('outside', b.id, b.min, { other: wall, depthM: r3(d) });
  }

  // ── 2. wall crossings ──
  const trayTop = Math.max(0, ...segs.filter((s) => s.kind === 'tray' || s.kind === 'busway' || s.kind === 'circuit').map((s) => s.max.z));
  let wallCrossings = 0;
  for (const s of segs) {
    for (const [wall, ax, c] of [['W', 'x', 0], ['E', 'x', W], ['S', 'y', 0], ['N', 'y', D]] as ['W' | 'E' | 'S' | 'N', 'x' | 'y', number][]) {
      const va = s.a[ax] - c;
      const vb = s.b[ax] - c;
      const inside = (q: number) => (wall === 'W' || wall === 'S' ? q > 1e-6 : q < -1e-6);
      if (inside(va) === inside(vb) || Math.abs(vb - va) < 1e-9) continue;
      if (!(va * vb <= 0)) continue;
      const t = (c - s.a[ax]) / (s.b[ax] - s.a[ax]);
      const q = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t, z: s.a.z + (s.b.z - s.a.z) * t };
      const along = ax === 'x' ? q.y : q.x;
      wallCrossings++;
      if (s.kind !== 'feeder' && s.kind !== 'trunk') {
        add('non-penetrating-crosses-wall', s.id, q, { other: wall });
        continue;
      }
      const perpendicular = ax === 'x' ? Math.abs(s.b.y - s.a.y) < 1e-6 && Math.abs(s.b.z - s.a.z) < 1e-6 : Math.abs(s.b.x - s.a.x) < 1e-6 && Math.abs(s.b.z - s.a.z) < 1e-6;
      if (!perpendicular) add('oblique-wall-crossing', s.id, q, { other: wall });
      const kind = s.kind === 'feeder' ? 'feeder-sleeve' : 'trunk-sleeve';
      const pen = pens.find((p) => p.kind === kind && p.wall === wall && along >= p.along[0] - TOL && along <= p.along[1] + TOL && q.z >= p.z[0] - TOL && q.z <= p.z[1] + TOL);
      if (!pen) {
        add('unsleeved-wall-crossing', s.id, q, { other: wall });
        continue;
      }
      if (pen.z[0] < trayTop - TOL) add('sleeve-below-tray-level', s.id, q, { other: pen.id, depthM: r3(trayTop - pen.z[0]) });
      const len = wall === 'W' || wall === 'E' ? D : W;
      if (Math.min(pen.along[0], len - pen.along[1]) < 0.5) add('sleeve-near-corner', s.id, q, { other: pen.id });
    }
  }

  // ── 3. feeder clashes (in-hall part) ──
  const clip = (b: Box): Box => ({ min: { x: Math.max(b.min.x, 0), y: Math.max(b.min.y, 0), z: b.min.z }, max: { x: Math.min(b.max.x, W), y: Math.min(b.max.y, D), z: b.max.z } });
  const feeders = segs.filter((s) => s.kind === 'feeder').map((s) => ({ s, box: clip(s) })).filter((f) => f.box.max.x > f.box.min.x - 1e-9 && f.box.max.y > f.box.min.y - 1e-9);
  const hitsBox = (a: Box, b: Box, eps = TOL) => {
    const o = overlap3(a, b);
    return o.x > eps && o.y > eps && o.z > 0;
  };
  for (const { s, box } of feeders) {
    for (const r of racks) if (hitsBox(box, { min: r.min, max: { ...r.max, z: r.max.z + 0.3 } })) add('feeder-over-rack', s.id, box.min, { other: r.id });
    for (const u of units) if (hitsBox(box, { min: u.min, max: { ...u.max, z: u.max.z + 0.3 } })) add('feeder-over-unit', s.id, box.min, { other: u.id });
    for (const c of conts) if (hitsBox(box, c.box, 1e-4)) add('feeder-through-containment', s.id, box.min, { other: c.id });
    for (const b of blockers) if (hitsBox(box, b)) add('feeder-through-keepout', s.id, box.min);
  }
  const sorted = [...feeders].sort((p, q) => p.box.min.x - q.box.min.x);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].box.min.x < sorted[i].box.max.x - 1e-4; j++) {
      if (sorted[i].s.id === sorted[j].s.id) continue;
      const o = overlap3(sorted[i].box, sorted[j].box);
      if (o.x > 1e-4 && o.y > 1e-4 && o.z > 1e-4) add('feeder-overlap', sorted[i].s.id, sorted[i].box.min, { other: sorted[j].s.id });
    }
  }
  const targets = segs.filter((s) => s.kind === 'tray' || s.kind === 'busway' || s.kind === 'circuit');
  for (const { s, box } of feeders) {
    for (const t of targets) {
      if (t.buswayId && t.buswayId === s.buswayId) continue;
      if (t.kind === 'circuit' && t.id === s.toId) continue;
      const o = overlap3(box, t);
      if (o.x > 1e-4 && o.y > 1e-4 && o.z > 1e-4) add('feeder-clash', s.id, box.min, { other: t.id });
    }
  }
  for (const s of segs.filter((x) => x.kind === 'cable')) for (const b of blockers) if (hitsBox(s, b)) add('cable-through-keepout', s.id, s.a);

  // ── 3b. derived pipes (T1b routing rule, layout/pipes.ts): inside the hall, clear of busways, tap-offs, trays, feeders, trunks, containment, columns ──
  const pipeTargets = segs.filter((s) => s.kind === 'tray' || s.kind === 'tier' || s.kind === 'busway' || s.kind === 'tapoff' || s.kind === 'feeder' || s.kind === 'trunk' || s.kind === 'circuit');
  for (const q of pipes) {
    const [wall, d] = depthOut(q);
    if (d > TOL) add('pipe-outside', q.id, q.a, { other: wall, depthM: r3(d) });
    const seen = new Set<string>();
    const hit = (other: string, box: Box, at: Vec3) => {
      if (seen.has(other)) return;
      const o = overlap3(q, box);
      if (o.x > PIPE_TOL_M && o.y > PIPE_TOL_M && o.z > PIPE_TOL_M) {
        seen.add(other);
        add('pipe-clash', q.id, at, { other, depthM: r3(Math.min(o.x, o.y, o.z)) });
      }
    };
    for (const t of pipeTargets) hit(`${t.kind}:${t.id}`, t, q.a);
    for (const c of contParts) hit(`containment:${c.id}`, c, q.a);
    for (const b of blockers) hit('column', b, q.a);
  }

  // ── 3c. inter-hall trunk bundles vs feeders (both leave the hall through sleeves; they must not share space) ──
  for (const { s, box } of feeders) {
    for (const t of segs) {
      if (t.kind !== 'trunk') continue;
      const o = overlap3(box, t);
      if (o.x > 1e-4 && o.y > 1e-4 && o.z > 1e-4) add('feeder-trunk-clash', s.id, box.min, { other: t.id });
    }
    for (const t of segs) {
      if (t.kind !== 'tier') continue;
      const o = overlap3(box, t);
      if (o.x > 1e-4 && o.y > 1e-4 && o.z > 1e-4) add('tier-tray-feeder-clash', s.id, box.min, { other: t.id });
    }
  }

  // ── 3c'. per-tier trays (QA backlog geometry): clear of the T1 / main / drop trays, busways, tap-off boxes, containment and columns ──
  const tierTargets = segs.filter((s) => s.kind === 'tray' || s.kind === 'busway' || s.kind === 'tapoff');
  for (const t of segs) {
    if (t.kind !== 'tier') continue;
    const seen = new Set<string>();
    const hitTier = (other: string, box: Box) => {
      if (seen.has(other)) return;
      const o = overlap3(t, box);
      if (o.x > PIPE_TOL_M && o.y > PIPE_TOL_M && o.z > PIPE_TOL_M) {
        seen.add(other);
        add('tier-tray-clash', t.id, t.a, { other, depthM: r3(Math.min(o.x, o.y, o.z)) });
      }
    };
    for (const s of tierTargets) hitTier(`${s.kind}:${s.id}`, s);
    for (const c of contParts) hitTier(`containment:${c.id}`, c);
    for (const b of blockers) hitTier('column', b);
  }

  // ── 3d. feeder headroom: the top feeder layer against the clear height (reported, with the tier and a remedy hint) ──
  const feederSegs = segs.filter((s) => s.kind === 'feeder');
  if (feederSegs.length) {
    const rv = resolveVerticals(hall);
    const levels = [...new Set(feederSegs.filter((s) => Math.abs(s.a.z - s.b.z) < 1e-6).map((s) => Math.round(s.a.z * 100) / 100))].sort((p, q) => p - q);
    const top = feederSegs.reduce((p, q) => (q.max.z > p.max.z ? q : p));
    const topZ = top.max.z;
    const level = (z: number) => Math.max(1, levels.filter((l) => l <= z + 1e-6).length);
    const hard = hall.clearHeight - rv.topClearanceM;
    const soft = hall.clearHeight - FEEDER_CEILING_ZONE_M;
    const check = topZ > hard + TOL ? 'feeder-headroom' : topZ > soft + TOL ? 'feeder-stack-high' : undefined;
    if (check) {
      const limit = check === 'feeder-headroom' ? hard : soft;
      const low = levels[0] ?? top.min.z;
      const fit = Math.max(1, Math.floor((limit - low) / FEEDER_PITCH_M + 1e-6) + 1);
      const over = levels.filter((l) => l > limit + 1e-6).length;
      const topLevel = level(Math.max(top.a.z, top.b.z));
      add(check, top.id, { x: top.a.x, y: top.a.y, z: topZ }, {
        other: `${over} of ${levels.length} feeder levels above ${r3(limit)} m`,
        depthM: r3(topZ - limit),
        tier: `feeder layer ${topLevel} of ${levels.length} · z ${r3(Math.max(top.a.z, top.b.z))} m`,
        hint: levels.length <= 2 * fit ? 'second-feeder-level' : 'split-electrical-rooms',
      });
    }
  }

  // ── 4. partitions and chimney walls ──
  const planes = [
    ...[...partitions.entries()].map(([id, pw]) => ({ id, check: 'unsleeved-partition-crossing', axis: pw.axis, c: pw.c, spans: pw.spans, z0: 0, z1: pw.z1, match: (p: WallPenetration) => p.reservationId === id })),
    ...chimneys.map((ch) => ({ id: ch.id, check: 'unsleeved-chimney-crossing', axis: ch.axis, c: ch.c, spans: ch.spans, z0: ch.z0, z1: ch.z1, match: (p: WallPenetration) => p.targetId === ch.id })),
  ];
  for (const pl of planes) {
    for (const s of segs) {
      if (s.kind === 'busway' || s.kind === 'circuit' || s.kind === 'tapoff') continue;
      const ps = pl.axis === 'x' ? s.a.y : s.a.x;
      const pe = pl.axis === 'x' ? s.b.y : s.b.x;
      if ((ps - pl.c) * (pe - pl.c) > 0 || Math.abs(pe - ps) < 1e-6) continue;
      const t = (pl.c - ps) / (pe - ps);
      const q = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t, z: s.a.z + (s.b.z - s.a.z) * t };
      const along = pl.axis === 'x' ? q.x : q.y;
      if (!pl.spans.some(([a0, a1]) => along > a0 + TOL && along < a1 - TOL) || q.z < pl.z0 || q.z > pl.z1) continue;
      if (!pens.some((p) => p.kind === 'partition-sleeve' && pl.match(p) && along >= p.along[0] - TOL && along <= p.along[1] + TOL && q.z >= p.z[0] - TOL && q.z <= p.z[1] + TOL)) add(pl.check, s.id, q, { other: pl.id });
    }
  }

  // ── 5. rooms and halls on the site ──
  const rooms: PowerRoom[] = analysis.power.rooms ?? [];
  const siteRect = (h: Hall, r: { x: number; y: number; w: number; d: number }) => ({ x: h.origin.x + r.x, y: h.origin.y + r.y, w: r.w, d: r.d });
  const rectOv = (a: { x: number; y: number; w: number; d: number }, b: { x: number; y: number; w: number; d: number }) => a.x < b.x + b.w - 0.01 && a.x + a.w > b.x + 0.01 && a.y < b.y + b.d - 0.01 && a.y + a.d > b.y + 0.01;
  const hallById = new Map(project.halls.map((h) => [h.id, h]));
  for (const room of rooms.filter((r) => r.hallId === hallId)) {
    const sr = siteRect(hall, room.rect);
    for (const h of project.halls) if (h.id !== hallId && rectOv(sr, { x: h.origin.x, y: h.origin.y, w: h.width, d: h.depth })) add(room.conflict ? 'room-overlaps-hall' : 'room-overlaps-hall-unflagged', room.id, { x: room.rect.x, y: room.rect.y, z: 0 }, { other: h.id });
    for (const o of rooms) {
      const oh = hallById.get(o.hallId);
      if (o.hallId === hallId || !oh) continue;
      if (rectOv(sr, siteRect(oh, o.rect))) add(room.conflict ? 'room-overlaps-room' : 'room-overlaps-room-unflagged', room.id, { x: room.rect.x, y: room.rect.y, z: 0 }, { other: o.id });
    }
  }
  for (const h of project.halls) if (h.id !== hallId && rectOv({ x: hall.origin.x, y: hall.origin.y, w: W, d: D }, { x: h.origin.x, y: h.origin.y, w: h.width, d: h.depth })) add('hall-overlaps-hall', hallId, { x: 0, y: 0, z: 0 }, { other: h.id });

  // ── 6. coverage ──
  if (cableGeo.skipped['mixed-axis']) add('coverage-mixed-axis', '*', { x: 0, y: 0, z: 0 }, { depthM: cableGeo.skipped['mixed-axis'] });
  if (cableGeo.skipped['inter-hall-no-sleeve']) add('coverage-inter-hall-no-sleeve', '*', { x: 0, y: 0, z: 0 }, { depthM: cableGeo.skipped['inter-hall-no-sleeve'] });

  const counts: Record<string, number> = {};
  for (const x of v) counts[x.check] = (counts[x.check] ?? 0) + 1;
  return { hallId, violations: v, counts, coverage: cableGeo.skipped, feederSegments, wallCrossings, penetrations: pens.length };
}

/** Audit every hall with equipment. */
export function auditProjectGeometry(project: Project, analysis: ProjectAnalysis): WallAuditReport[] {
  return project.halls.filter((h) => project.equipment.some((e) => e.hallId === h.id)).map((h) => auditHallGeometry(project, analysis, h.id));
}
