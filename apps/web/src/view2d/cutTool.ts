// r4 stream C (spec §3.2 Section and elevation): section-cut logic of the 2D view (pure).
// The core cut model (DrawingCut) is axis-parallel: a plane ⟂ `axis` at `at`, beyond = (at, at + look·depth], u along the plane
// (axis 'y' → u = look·x; axis 'x' → u = −look·y). A drag snaps to 0° / 90° always (Alt only disables target snapping, because a
// free-angle plane has no DrawingCut form), then `at` snaps to row centre · aisle centre · rack face · planning grid.
import type { Containment, DrawingCut, ElevationTarget, EquipmentInstance, Rect, RowGroup } from '@aidc/core';

export type CutSnapKind = 'row-centre' | 'aisle-centre' | 'rack-face' | 'grid';

export const NUDGE_TILE_M = 0.6;
export const NUDGE_FINE_M = 0.05;
export const DEFAULT_CUT_DEPTH_M = 2.4;

/** A–A, B–B, … Z–Z, AA–AA … (first free letter). */
export function nextCutLabel(cuts: readonly Pick<DrawingCut, 'label'>[]): { letter: string; label: string } {
  const used = new Set(cuts.map((c) => c.label.split(/[–-]/)[0]));
  for (let n = 0; n < 702; n++) {
    const letter = n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(64 + Math.floor(n / 26)) + String.fromCharCode(65 + (n % 26));
    if (!used.has(letter)) return { letter, label: `${letter}–${letter}` };
  }
  return { letter: '?', label: '?–?' };
}

export interface SnapContext {
  rows: readonly RowGroup[];
  /** plan rects of racks / units (faces) */
  rackRects?: readonly Rect[];
  containments?: readonly Pick<Containment, 'rect'>[];
  tileSize?: number;
  /** snap distance (m) */
  tol: number;
}

export interface SnapResult {
  value: number;
  kind: CutSnapKind | null;
}

const KIND_ORDER: Record<CutSnapKind, number> = { 'row-centre': 0, 'aisle-centre': 1, 'rack-face': 2, grid: 3 };

/**
 * Snap a plane position. `axis` is the cut axis: 'y' = a plane of constant y (candidates from x-rows), 'x' = constant x.
 * `span` limits candidates to objects overlapping the drag along the plane.
 */
export function snapCutPosition(value: number, axis: 'x' | 'y', ctx: SnapContext, span?: [number, number]): SnapResult {
  const cands: { v: number; kind: CutSnapKind }[] = [];
  const rowAxis = axis === 'y' ? 'x' : 'y';
  const overlaps = (a0: number, a1: number) => !span || (a1 >= Math.min(span[0], span[1]) - 1e-6 && a0 <= Math.max(span[0], span[1]) + 1e-6);
  const rows = ctx.rows.filter((r) => r.axis === rowAxis && overlaps(r.a0, r.a1));
  for (const r of rows) cands.push({ v: r.center, kind: 'row-centre' });
  // aisle centres: containment rects running along the rows, and midpoints of neighbouring parallel rows of a pod
  for (const c of ctx.containments ?? []) {
    const alongX = c.rect.w >= c.rect.d;
    if ((rowAxis === 'x') !== alongX) continue;
    const a0 = alongX ? c.rect.x : c.rect.y;
    const a1 = a0 + (alongX ? c.rect.w : c.rect.d);
    if (!overlaps(a0, a1)) continue;
    cands.push({ v: alongX ? c.rect.y + c.rect.d / 2 : c.rect.x + c.rect.w / 2, kind: 'aisle-centre' });
  }
  const byPod = new Map<string, RowGroup[]>();
  for (const r of rows) {
    const k = r.podId ?? '';
    const l = byPod.get(k);
    if (l) l.push(r);
    else byPod.set(k, [r]);
  }
  for (const list of byPod.values()) {
    const cs = list.map((r) => r.center).sort((a, b) => a - b);
    for (let i = 1; i < cs.length; i++) if (cs[i] - cs[i - 1] < 6) cands.push({ v: (cs[i] + cs[i - 1]) / 2, kind: 'aisle-centre' });
  }
  for (const r of ctx.rackRects ?? []) {
    const a0 = rowAxis === 'x' ? r.x : r.y;
    const a1 = a0 + (rowAxis === 'x' ? r.w : r.d);
    if (!overlaps(a0, a1)) continue;
    if (axis === 'y') cands.push({ v: r.y, kind: 'rack-face' }, { v: r.y + r.d, kind: 'rack-face' });
    else cands.push({ v: r.x, kind: 'rack-face' }, { v: r.x + r.w, kind: 'rack-face' });
  }
  const tile = ctx.tileSize && ctx.tileSize > 0 ? ctx.tileSize : 0;
  if (tile) cands.push({ v: Math.round(value / tile) * tile, kind: 'grid' });
  let best: { v: number; kind: CutSnapKind } | null = null;
  let bestD = Infinity;
  for (const c of cands) {
    const d = Math.abs(c.v - value);
    if (d > ctx.tol + 1e-9) continue;
    if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && best && KIND_ORDER[c.kind] < KIND_ORDER[best.kind])) {
      best = c;
      bestD = d;
    }
  }
  return best ? { value: best.v, kind: best.kind } : { value, kind: null };
}

export interface DragCut {
  axis: 'x' | 'y';
  at: number;
  look: 1 | -1;
  window: { u0: number; u1: number };
  snap: CutSnapKind | null;
  /** snapped plan segment (for the preview) */
  seg: [number, number, number, number];
}

/** Compute pod and its numbered support-HAC are one facilities scope (for example pod-04 + pod-services-04). */
export function sectionScopeId(podId: string | undefined, fallback: string): string {
  if (!podId) return fallback;
  const support = /^pod-services-(\d+)$/i.exec(podId);
  return support ? `pod-${support[1]}` : podId;
}

function sameSectionScope(a: string | undefined, b: string): boolean {
  return sectionScopeId(a, a ?? '') === b;
}

/** A cut from a plan drag (p0 → p1). Always 0° / 90°; `free` (Alt) skips target snapping. */
export function cutFromDrag(p0: [number, number], p1: [number, number], ctx: SnapContext, o: { free?: boolean; look?: 1 | -1 } = {}): DragCut {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const look = o.look ?? 1;
  if (Math.abs(dx) >= Math.abs(dy)) {
    // line along x → plane of constant y
    const raw = p0[1];
    const s = o.free ? { value: raw, kind: null } : snapCutPosition(raw, 'y', ctx, [p0[0], p1[0]]);
    const x0 = Math.min(p0[0], p1[0]);
    const x1 = Math.max(p0[0], p1[0]);
    const us = [look * x0, look * x1].sort((a, b) => a - b);
    return { axis: 'y', at: s.value, look, window: { u0: us[0], u1: us[1] }, snap: s.kind, seg: [x0, s.value, x1, s.value] };
  }
  const raw = p0[0];
  const s = o.free ? { value: raw, kind: null } : snapCutPosition(raw, 'x', ctx, [p0[1], p1[1]]);
  const y0 = Math.min(p0[1], p1[1]);
  const y1 = Math.max(p0[1], p1[1]);
  const us = [-look * y0, -look * y1].sort((a, b) => a - b);
  return { axis: 'x', at: s.value, look, window: { u0: us[0], u1: us[1] }, snap: s.kind, seg: [s.value, y0, s.value, y1] };
}

/** Flip the look direction; the window keeps the same plan extent (u mirrors). */
export function flipCut<T extends DrawingCut>(c: T): T {
  const look = (c.look === 1 ? -1 : 1) as 1 | -1;
  return { ...c, look, ...(c.window ? { window: { u0: -c.window.u1, u1: -c.window.u0 } } : {}) };
}

/** Move the plane by `delta` metres along its normal (window unchanged). */
export function nudgeCut<T extends DrawingCut>(c: T, delta: number): T {
  return { ...c, at: Math.round((c.at + delta) * 1000) / 1000 };
}

/** Plan extent [a0, a1] of a cut window along the plane (x for axis 'y', y for axis 'x'). */
export function cutPlanSpan(c: Pick<DrawingCut, 'axis' | 'look' | 'window'>): [number, number] | null {
  if (!c.window) return null;
  const a = c.axis === 'y' ? [c.look * c.window.u0, c.look * c.window.u1] : [-c.look * c.window.u0, -c.look * c.window.u1];
  return [Math.min(a[0], a[1]), Math.max(a[0], a[1])];
}

/** Quick cut: transverse section across the rows of a pod at a plan point (plane ⟂ the row axis). */
export function crossSectionThroughRow(row: RowGroup, rows: readonly RowGroup[], x: number, y: number, look: 1 | -1 = 1): Omit<DrawingCut, 'id' | 'label'> {
  const scopeId = sectionScopeId(row.podId, row.id);
  const pod = rows.filter((r) => r.axis === row.axis && sameSectionScope(r.podId, scopeId));
  const cs = pod.map((r) => r.center);
  const lo = Math.min(...cs) - 2.5;
  const hi = Math.max(...cs) + 2.5;
  if (row.axis === 'x') {
    const us = [-look * lo, -look * hi].sort((a, b) => a - b);
    return { hallId: row.hallId, kind: 'pod-transverse', refId: scopeId, axis: 'x', at: x, look, depthM: DEFAULT_CUT_DEPTH_M, window: { u0: us[0], u1: us[1] } };
  }
  const us = [look * lo, look * hi].sort((a, b) => a - b);
  return { hallId: row.hallId, kind: 'pod-transverse', refId: scopeId, axis: 'y', at: y, look, depthM: DEFAULT_CUT_DEPTH_M, window: { u0: us[0], u1: us[1] } };
}

/** Selected rack/unit → its exact bay station, spanning every row in the same DU/pod. */
export function crossSectionThroughEquipment(equipment: EquipmentInstance, rows: readonly RowGroup[], look: 1 | -1 = 1): Omit<DrawingCut, 'id' | 'label'> | null {
  const row = rows.find((r) => r.id === equipment.rowId && r.memberIds.includes(equipment.id));
  if (!row) return null;
  return { ...crossSectionThroughRow(row, rows, equipment.position.x, equipment.position.y, look), anchorId: equipment.id };
}

/**
 * Longitudinal section on a physical row centre-line. This is the interactive
 * counterpart of the printable 302 row section: it shows every member of one
 * row and looks toward the contained/rear aisle.
 */
export function longSectionThroughRow(row: RowGroup, marginM = 1): Omit<DrawingCut, 'id' | 'label'> {
  const look: 1 | -1 = row.frontSign > 0 ? -1 : 1;
  const a0 = row.a0 - marginM;
  const a1 = row.a1 + marginM;
  if (row.axis === 'x') {
    const us = [look * a0, look * a1].sort((a, b) => a - b);
    return { hallId: row.hallId, kind: 'row-longitudinal', refId: row.id, axis: 'y', at: row.center, look, depthM: DEFAULT_CUT_DEPTH_M, window: { u0: us[0], u1: us[1] } };
  }
  const us = [-look * a0, -look * a1].sort((a, b) => a - b);
  return { hallId: row.hallId, kind: 'row-longitudinal', refId: row.id, axis: 'x', at: row.center, look, depthM: DEFAULT_CUT_DEPTH_M, window: { u0: us[0], u1: us[1] } };
}

/** True when a cut is the longitudinal centre-line section of `row`. */
export function cutMatchesRow(cut: Pick<DrawingCut, 'hallId' | 'axis' | 'at'>, row: RowGroup, tolM = 0.01): boolean {
  return cut.hallId === row.hallId && cut.axis === (row.axis === 'x' ? 'y' : 'x') && Math.abs(cut.at - row.center) <= tolM;
}

/** Quick cut: longitudinal section along an aisle (plane ∥ the rows at the aisle centre, window = the row extent ± 1 m). */
export function longSectionAlongAisle(aisle: Rect, hallId: string, look: 1 | -1 = 1): Omit<DrawingCut, 'id' | 'label'> {
  const alongX = aisle.w >= aisle.d;
  if (alongX) {
    const us = [look * (aisle.x - 1), look * (aisle.x + aisle.w + 1)].sort((a, b) => a - b);
    return { hallId, kind: 'aisle-longitudinal', axis: 'y', at: aisle.y + aisle.d / 2, look, depthM: DEFAULT_CUT_DEPTH_M, window: { u0: us[0], u1: us[1] } };
  }
  const us = [-look * (aisle.y - 1), -look * (aisle.y + aisle.d + 1)].sort((a, b) => a - b);
  return { hallId, kind: 'aisle-longitudinal', axis: 'x', at: aisle.x + aisle.w / 2, look, depthM: DEFAULT_CUT_DEPTH_M, window: { u0: us[0], u1: us[1] } };
}

/** The aisle between two neighbouring rows of a pod containing the point, if any (rect between the facing rack faces). */
export function aisleAt(rows: readonly RowGroup[], rackDepth: number, x: number, y: number): Rect | null {
  for (const axis of ['x', 'y'] as const) {
    const list = rows.filter((r) => r.axis === axis).sort((a, b) => a.center - b.center);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1];
      const b = list[i];
      if ((a.podId ?? '') !== (b.podId ?? '')) continue;
      const lo = a.center + rackDepth / 2;
      const hi = b.center - rackDepth / 2;
      if (hi <= lo || hi - lo > 4) continue;
      const a0 = Math.max(a.a0, b.a0);
      const a1 = Math.min(a.a1, b.a1);
      const along = axis === 'x' ? x : y;
      const across = axis === 'x' ? y : x;
      if (across >= lo && across <= hi && along >= a0 && along <= a1) return axis === 'x' ? { x: a0, y: lo, w: a1 - a0, d: hi - lo } : { x: lo, y: a0, w: hi - lo, d: a1 - a0 };
    }
  }
  return null;
}

/** Elevation targets available in a hall (walls, row faces, aisle ends), in picker order. */
export function elevationTargets(rows: readonly RowGroup[], containments: readonly Pick<Containment, 'id' | 'hallId'>[], hallId: string): ElevationTarget[] {
  const out: ElevationTarget[] = (['N', 'E', 'S', 'W'] as const).map((wall) => ({ kind: 'wall', wall }));
  for (const r of rows) if (r.kind !== 'services' || r.memberIds.length) out.push({ kind: 'row-face', rowId: r.id, face: 'front' });
  for (const c of containments) if (c.hallId === hallId) out.push({ kind: 'aisle-end', containmentId: c.id, end: 0 });
  return out;
}

export function sameTargetRef(a: ElevationTarget | null, b: ElevationTarget | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'wall') return a.wall === (b as typeof a).wall;
  if (a.kind === 'row-face') return a.rowId === (b as typeof a).rowId;
  return a.containmentId === (b as typeof a).containmentId;
}

/** Flip an elevation target (row face front ↔ rear, aisle end 0 ↔ 1, wall N ↔ S / E ↔ W). */
export function flipTarget(t: ElevationTarget): ElevationTarget {
  if (t.kind === 'row-face') return { ...t, face: t.face === 'front' ? 'rear' : 'front' };
  if (t.kind === 'aisle-end') return { ...t, end: t.end === 0 ? 1 : 0 };
  const opp = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
  return { kind: 'wall', wall: opp[t.wall] };
}
