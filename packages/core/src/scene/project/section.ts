// r4 stream A0 (spec §2.3 projection rules, §3.2 depth presets): section through a hall.
//   cut      prims whose AABB intersects the plane → role 'cut' (rect of the cross-section; a tube along the view axis → circle),
//            style = emitter (sheets / 2D view map it to a hatch)
//   beyond   prims in (at, at + look·depth] → role 'beyond', depth = distance of the near face, emitted far → near with their exact
//            visible outline (rectangle minus the union of nearer rectangles, scene/project/occlude.ts): a closed rect when fully
//            visible, else polylines; fully hidden prims are omitted
//   depth    cut.depthM, or a preset: 'cut' (0) · 'next-row' (nearest rack / unit face beyond the plane, capped at 6 m) · 'wall' (to the
//            interior wall face) · a number (m)
// Coordinates: u along the plane (DrawingCut convention), z up. Floor marks (hall outline, egress, reserves) are never drawn.
import type { DrawingCut } from '../../model/types.ts';
import { drawListHash, type DrawList2D } from '../drawList.ts';
import type { LayerId } from '../layers.ts';
import { primAabb, type HallPrims } from '../prims.ts';
import { hallExtent, hallIndex } from './common.ts';
import { frameBox, frameQueryRect, projectOrtho, type OrthoFrame } from './ortho.ts';

export const SECTION_MAX_DEPTH_M = 6;

export type SectionDepthPreset = 'cut' | 'next-row' | 'wall' | number;

export interface ProjectSectionOptions {
  layers?: LayerId[];
  /** overrides cut.depthM */
  depth?: SectionDepthPreset;
  /** cap of the 'next-row' preset (default 6 m) */
  maxDepthM?: number;
  /** 'exact' visible-outline polylines (default) or 'painter' closed rects for opaque fills (see OrthoOptions) */
  outlines?: 'exact' | 'painter';
}

/** Distance from the plane to the interior wall face in the look direction. */
function wallDepth(hp: HallPrims, cut: Pick<DrawingCut, 'axis' | 'at' | 'look'>): number {
  const ext = hallExtent(hp);
  const lo = cut.axis === 'y' ? ext.y : ext.x;
  const hi = lo + (cut.axis === 'y' ? ext.d : ext.w);
  return Math.max(0, cut.look === 1 ? hi - cut.at : cut.at - lo);
}

/** Depth (m) of a preset for a cut. */
export function sectionDepth(hp: HallPrims, cut: Pick<DrawingCut, 'axis' | 'at' | 'look' | 'window'>, preset: SectionDepthPreset, maxDepthM = SECTION_MAX_DEPTH_M): number {
  if (typeof preset === 'number') return Math.max(0, preset);
  if (preset === 'cut') return 0;
  const toWall = wallDepth(hp, cut);
  if (preset === 'wall') return toWall;
  const f: OrthoFrame = { axis: cut.axis, at: cut.at, look: cut.look, depthM: toWall, ...(cut.window ? { window: cut.window } : {}) };
  let best = Infinity;
  for (const i of hallIndex(hp).query(frameQueryRect(f))) {
    const p = hp.prims[i];
    if (p.emitter !== 'rack' && p.emitter !== 'unit') continue;
    const m = frameBox(f, primAabb(p));
    if (cut.window && (m.u1 < cut.window.u0 || m.u0 > cut.window.u1)) continue;
    if (m.s0 > 1e-6) best = Math.min(best, m.s0);
  }
  return Math.min(Number.isFinite(best) ? best : toWall, maxDepthM);
}

export function projectSection(hp: HallPrims, cut: DrawingCut, o: ProjectSectionOptions = {}): DrawList2D {
  const depthM = o.depth === undefined ? cut.depthM : sectionDepth(hp, cut, o.depth, o.maxDepthM);
  const frame: OrthoFrame = { axis: cut.axis, at: cut.at, look: cut.look, depthM, ...(cut.window ? { window: cut.window } : {}) };
  const { items, bounds } = projectOrtho(hp, frame, { withCut: true, ...(o.layers ? { layers: o.layers } : {}), ...(o.outlines ? { outlines: o.outlines } : {}) });
  const list = { space: 'section' as const, hallId: hp.hallId, bounds, items, cut };
  return { ...list, hash: drawListHash(list) };
}
