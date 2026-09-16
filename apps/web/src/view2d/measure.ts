// r4 stream C (spec §3.2, P1 measure tool): chain readouts (pure). Plan shows Δx / Δy, section and elevation show Δu / Δz.
import { fmtLength, type DrawingUnits, type Space2D } from '@aidc/core';

export type Pt2 = [number, number];

export interface MeasureReadout {
  /** per segment: length, Δ first axis, Δ second axis (formatted) */
  segments: { L: string; d1: string; d2: string }[];
  total: string;
  totalM: number;
  /** axis names for the readout */
  axes: [string, string];
}

export function chainLength(pts: readonly Pt2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

export function measureReadout(pts: readonly Pt2[], space: Space2D, units: DrawingUnits): MeasureReadout {
  const f = (m: number) => fmtLength(Math.abs(m), units);
  const segments = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    segments.push({ L: f(Math.hypot(dx, dy)), d1: f(dx), d2: f(dy) });
  }
  const totalM = chainLength(pts);
  return { segments, total: f(totalM), totalM, axes: space === 'plan' ? ['Δx', 'Δy'] : ['Δu', 'Δz'] };
}

/** Nearest snap point within `tol`, else the raw point. */
export function snapPoint(p: Pt2, cands: readonly { x: number; y: number }[], tol: number, grid?: number): { pt: Pt2; snapped: 'point' | 'grid' | null } {
  let best: Pt2 | null = null;
  let bd = Infinity;
  for (const c of cands) {
    const d = Math.hypot(c.x - p[0], c.y - p[1]);
    if (d <= tol && d < bd) {
      bd = d;
      best = [c.x, c.y];
    }
  }
  if (best) return { pt: best, snapped: 'point' };
  if (grid && grid > 0) {
    const g: Pt2 = [Math.round(p[0] / grid) * grid, Math.round(p[1] / grid) * grid];
    if (Math.hypot(g[0] - p[0], g[1] - p[1]) <= tol) return { pt: g, snapped: 'grid' };
  }
  return { pt: p, snapped: null };
}
