// r4 stream C (spec §4.4 T10): pure modules of the in-app 2D view — hit grid vs brute force, LOD band hysteresis, screen label
// culling (no overlap, ≥ 7 px, forced labels, KO-safe widths), key-scope guards (CameraRig fly keys, viewport Digit1–5, 2D pane
// keys), dark palette lightness / ΔE, cut tool snapping / flip / labels, measure readouts, view transform, store slice.
// Lives here because the root vitest config collects apps/server/test (not apps/web); the modules import only core + each other.
import { describe, expect, it } from 'vitest';
import { buildHallPrims, createNvidiaReferenceProject, fmtLength, packDrawList, projectPlan, rowGroupsFromEquipment, type DrawingCut, type RowGroup } from '@aidc/core';
import * as corePalette from '../../../packages/core/src/drawings/palette.ts';
import { bruteQuery, HitGrid, pointInPolygon, segDist } from '../../web/src/view2d/hitGrid.ts';
import { LOD_HYSTERESIS, LOD_THRESHOLDS, lodBand, lodBandOf } from '../../web/src/view2d/lod.ts';
import { centredBox, cullScreenLabels, fitFontPx, ScreenOccupancy, type LabelCandidate } from '../../web/src/view2d/labels.ts';
import { flyKeyAllowed, hoverViewportKeyAction, keyScopeOf, pane2DKey, viewportKeyAction } from '../../web/src/view2d/keyscope.ts';
import { canvasStyle, DARK_MIN_L, deltaE, hexToLab, PAPER_TOKENS, styleIdentity, themeStroke } from '../../web/src/view2d/palette2d.ts';
import { aisleAt, crossSectionThroughRow, cutFromDrag, cutMatchesRow, cutPlanSpan, elevationTargets, flipCut, flipTarget, longSectionAlongAisle, longSectionThroughRow, nextCutLabel, nudgeCut, sectionScopeId, snapCutPosition } from '../../web/src/view2d/cutTool.ts';
import { chainLength, measureReadout, snapPoint } from '../../web/src/view2d/measure.ts';
import { fitRect, panBy, screenToWorld, visibleRect, worldToScreen, zoomAt } from '../../web/src/view2d/viewXform.ts';
import { createView2dSlice, DEFAULT_VIEW2D, parseView2dState, type View2DSlice } from '../../web/src/view2d/store.ts';
import { syntheticPlan } from '../../web/src/view2d/synthetic.ts';
import { cutSegment, niceLength } from '../../web/src/view2d/renderer/Canvas2DRenderer.ts';
import { equipmentTooltip } from '../../web/src/view2d/equipmentTooltip.ts';

/** deterministic LCG */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe('hitGrid (T10)', () => {
  it('query equals brute force for random boxes, windows and cell sizes', () => {
    const r = rng(7);
    const n = 2500;
    const boxes = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = r() * 400 - 20;
      const y = r() * 120 - 10;
      const big = r() < 0.01;
      const w = big ? r() * 300 : r() * 3;
      const d = big ? r() * 80 : r() * 3;
      boxes.set([x, y, x + w, y + d], i * 4);
    }
    boxes.set([NaN, NaN, NaN, NaN], 0); // an unhittable item
    for (const cell of [0.5, 1, 4, 16]) {
      const g = new HitGrid(boxes, cell);
      for (let k = 0; k < 150; k++) {
        const x = r() * 420 - 30;
        const y = r() * 140 - 20;
        const w = r() < 0.1 ? r() * 500 : r() * 10;
        const d = r() < 0.1 ? r() * 150 : r() * 10;
        expect(g.query(x, y, w, d)).toEqual(bruteQuery(boxes, x, y, w, d));
      }
    }
  });

  it('pick with tolerance equals brute force on the grown point and applies the exact test', () => {
    const r = rng(11);
    const n = 800;
    const boxes = new Float64Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = r() * 60;
      const y = r() * 30;
      boxes.set([x, y, x + 0.6, y + 1.2], i * 4);
    }
    const g = new HitGrid(boxes, 4);
    for (let k = 0; k < 300; k++) {
      const x = r() * 62;
      const y = r() * 32;
      const tol = r() * 0.3;
      expect(g.pick(x, y, tol)).toEqual(bruteQuery(boxes, x - tol, y - tol, 2 * tol, 2 * tol));
      expect(g.pick(x, y, tol, (i) => i % 2 === 0)).toEqual(bruteQuery(boxes, x - tol, y - tol, 2 * tol, 2 * tol).filter((i) => i % 2 === 0));
    }
  });

  it('segment distance and point-in-polygon', () => {
    expect(segDist(1, 1, 0, 0, 2, 0)).toBeCloseTo(1);
    expect(segDist(3, 0, 0, 0, 2, 0)).toBeCloseTo(1);
    const sq = [0, 0, 2, 0, 2, 2, 0, 2];
    expect(pointInPolygon(1, 1, sq)).toBe(true);
    expect(pointInPolygon(3, 1, sq)).toBe(false);
  });

  it('indexes a real packed plan (REF hall): every rack item is found at its centre', () => {
    const { project } = createNvidiaReferenceProject();
    const hall = project.halls[0];
    const hp = buildHallPrims(project, null, { hallId: hall.id, detail: 'pod' });
    const p = packDrawList(projectPlan(hp));
    const boxes = new Float64Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const a = p.ptsStart[i];
      if (p.kind[i] === 0) boxes.set([p.pts[a], p.pts[a + 1], p.pts[a] + p.pts[a + 2], p.pts[a + 1] + p.pts[a + 3]], i * 4);
      else boxes.set([NaN, NaN, NaN, NaN], i * 4);
    }
    const g = new HitGrid(boxes, 4);
    let racks = 0;
    for (let i = 0; i < p.count; i++) {
      const id = p.primId[i] >= 0 ? p.strings[p.primId[i]] : '';
      if (!id.startsWith('rack:') || p.kind[i] !== 0) continue;
      racks++;
      const cx = (boxes[i * 4] + boxes[i * 4 + 2]) / 2;
      const cy = (boxes[i * 4 + 1] + boxes[i * 4 + 3]) / 2;
      expect(g.pick(cx, cy, 0)).toContain(i);
    }
    expect(racks).toBeGreaterThan(20);
  });
});

describe('LOD bands (T10)', () => {
  it('plain bands at the spec thresholds', () => {
    expect(LOD_THRESHOLDS).toEqual([1.5, 12, 40]);
    expect([0.5, 1.49, 1.5, 11.9, 12, 39.9, 40, 400].map(lodBandOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('±15 % hysteresis: a band is kept until ppm moves 15 % past its threshold', () => {
    expect(LOD_HYSTERESIS).toBe(0.15);
    expect(lodBand(12.5, 1)).toBe(1); // < 12 × 1.15 = 13.8
    expect(lodBand(13.9, 1)).toBe(2);
    expect(lodBand(11, 2)).toBe(2); // ≥ 12 × 0.85 = 10.2
    expect(lodBand(10.1, 2)).toBe(1);
    expect(lodBand(45, 2)).toBe(2); // < 40 × 1.15 = 46
    expect(lodBand(47, 2)).toBe(3);
    expect(lodBand(35, 3)).toBe(3); // ≥ 34
    expect(lodBand(33, 3)).toBe(2);
    expect(lodBand(0.5, 3)).toBe(0); // jumps resolve in one call
    expect(lodBand(100, 0)).toBe(3);
    expect(lodBand(20, null)).toBe(2);
  });

  it('no flicker: oscillating ±10 % around a threshold never changes band', () => {
    let b = lodBand(12, null);
    const seen = new Set<number>();
    for (let k = 0; k < 50; k++) {
      b = lodBand(12 * (k % 2 ? 1.1 : 0.9), b);
      seen.add(b);
    }
    expect(seen.size).toBe(1);
  });
});

describe('screen label culling (T10)', () => {
  // KO-safe measure stand-in: Hangul full-width, Latin 0.6 em
  const measure = (s: string, px: number) => [...s].reduce((w, ch) => w + (/[가-힣]/.test(ch) ? 1 : 0.6), 0) * px;
  const overlap = (a: LabelCandidate['box'], b: LabelCandidate['box']) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

  it('keeps no two overlapping labels, drops < 7 px, keeps forced labels', () => {
    const r = rng(3);
    const cands: LabelCandidate[] = [];
    for (let i = 0; i < 400; i++) {
      const size = 4 + r() * 10;
      const text = r() < 0.5 ? 'DU03-A-07' : '컨테인먼트 상단';
      cands.push({ box: centredBox(r() * 1200, r() * 800, measure(text, size), size, r() < 0.3 ? -90 : 0), priority: Math.floor(r() * 5), size, force: i < 3 });
    }
    const kept = cullScreenLabels(cands, new ScreenOccupancy());
    for (const i of [0, 1, 2]) expect(kept).toContain(i);
    const free = kept.filter((i) => !cands[i].force);
    for (const i of free) expect(cands[i].size).toBeGreaterThanOrEqual(7);
    for (let a = 0; a < kept.length; a++)
      for (let b = a + 1; b < kept.length; b++) {
        const A = cands[kept[a]];
        const B = cands[kept[b]];
        if (A.force && B.force) continue;
        expect(overlap(A.box, B.box), `labels ${kept[a]} and ${kept[b]} overlap`).toBe(false);
      }
    expect(kept.length).toBeGreaterThan(20);
  });

  it('higher priority wins a conflict regardless of input order', () => {
    const low: LabelCandidate = { box: { x: 0, y: 0, w: 50, h: 10 }, priority: 10, size: 10 };
    const high: LabelCandidate = { box: { x: 20, y: 2, w: 50, h: 10 }, priority: 40, size: 10 };
    expect(cullScreenLabels([low, high])).toEqual([1]);
    expect(cullScreenLabels([high, low])).toEqual([0]);
  });

  it('fitFontPx uses measured widths: Hangul needs more room than Latin of the same length', () => {
    const latin = fitFontPx(measure, 'ABCDEFG', 60, 20);
    const hangul = fitFontPx(measure, '가나다라마바사', 60, 20);
    expect(latin).toBeGreaterThan(hangul);
    expect(fitFontPx(measure, 'DU03-A-07', 20, 20)).toBe(0); // cannot reach 7 px
    expect(fitFontPx(measure, 'A', 500, 500, 12)).toBe(12);
  });

  it('centredBox swaps extents for ±90° text', () => {
    expect(centredBox(10, 10, 40, 8, -90)).toEqual({ x: 6, y: -10, w: 8, h: 40 });
  });
});

describe('key scopes (T10)', () => {
  const el = (scope: string | null, tag = 'DIV', editable = false) => ({
    tagName: tag,
    isContentEditable: editable,
    closest: (sel: string) => (sel === '[data-keyscope]' && scope ? { getAttribute: (n: string) => (n === 'data-keyscope' ? scope : null) } : null),
  });

  it('CameraRig fly keys: ignored when consumed, typing, or inside a non-3D scope', () => {
    expect(flyKeyAllowed({ code: 'KeyW', target: el(null) })).toBe(true);
    expect(flyKeyAllowed({ code: 'KeyW', target: el('view3d') })).toBe(true);
    expect(flyKeyAllowed({ code: 'KeyW', target: el('view2d') })).toBe(false);
    expect(flyKeyAllowed({ code: 'ArrowUp', target: el('drawings') })).toBe(false);
    expect(flyKeyAllowed({ code: 'KeyW', target: el('view3d'), defaultPrevented: true })).toBe(false);
    expect(flyKeyAllowed({ code: 'KeyW', target: el(null, 'INPUT') })).toBe(false);
    expect(flyKeyAllowed({ code: 'KeyW', target: el(null, 'DIV', true) })).toBe(false);
    expect(keyScopeOf(null)).toBe(null);
  });

  it('viewport Digit1–5 only inside a viewport pane, never with modifiers or when consumed', () => {
    expect(viewportKeyAction({ code: 'Digit2', target: el('view2d') })).toEqual({ kind: 'mode', mode: 'plan' });
    expect(viewportKeyAction({ code: 'Digit1', target: el('view3d') })).toEqual({ kind: 'mode', mode: '3d' });
    expect(viewportKeyAction({ code: 'Digit5', target: el('view3d') })).toEqual({ kind: 'split' });
    expect(viewportKeyAction({ code: 'Digit3', target: el('drawings') })).toBe(null);
    expect(viewportKeyAction({ code: 'Digit2', target: el(null) })).toBe(null);
    expect(viewportKeyAction({ code: 'Digit2', target: el('view2d'), ctrlKey: true })).toBe(null);
    expect(viewportKeyAction({ code: 'Digit2', target: el('view2d'), defaultPrevented: true })).toBe(null);
    expect(viewportKeyAction({ code: 'Digit2', target: el('view2d', 'INPUT') })).toBe(null);
  });

  it('hovered viewport Digit1–5 (QA r4 view2d F3): only outside every key scope, never typing / modifiers / dialog-menu-tree', () => {
    const role = (r: string | null, tag = 'BUTTON') => ({
      tagName: tag,
      closest: (sel: string) => (sel === '[data-keyscope]' ? null : r && sel.includes(`[role="${r}"]`) ? {} : null),
    });
    expect(hoverViewportKeyAction({ code: 'Digit2', target: role(null) })).toEqual({ kind: 'mode', mode: 'plan' });
    expect(hoverViewportKeyAction({ code: 'Digit5', target: el(null) })).toEqual({ kind: 'split' });
    expect(hoverViewportKeyAction({ code: 'Digit2', target: el('drawings') })).toBe(null);
    expect(hoverViewportKeyAction({ code: 'Digit2', target: el('view2d') })).toBe(null);
    expect(hoverViewportKeyAction({ code: 'Digit2', target: role(null, 'INPUT') })).toBe(null);
    for (const r of ['dialog', 'menu', 'tree', 'listbox']) expect(hoverViewportKeyAction({ code: 'Digit2', target: role(r) }), r).toBe(null);
    expect(hoverViewportKeyAction({ code: 'Digit2', target: role(null), shiftKey: true })).toBe(null);
    expect(hoverViewportKeyAction({ code: 'Digit2', target: role(null), ctrlKey: true })).toBe(null);
    expect(hoverViewportKeyAction({ code: 'Digit2', target: role(null), defaultPrevented: true })).toBe(null);
    expect(hoverViewportKeyAction({ code: 'KeyW', target: role(null) })).toBe(null);
  });

  it('2D pane keys: never binds W A S D Q E, arrows, R, Delete; Backspace / Enter only during a measure chain', () => {
    const k = (code: string, o: { alt?: boolean; measuring?: boolean; scope?: string } = {}) => pane2DKey({ code, altKey: o.alt, target: el(o.scope ?? 'view2d') }, !!o.measuring);
    for (const code of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowLeft', 'KeyR', 'Delete', 'ShiftLeft']) expect(k(code), code).toBe(null);
    expect(k('Backspace')).toBe(null);
    expect(k('Backspace', { measuring: true })).toBe('measure-undo');
    expect(k('Enter', { measuring: true })).toBe('measure-end');
    expect(k('KeyM')).toBe('tool-measure');
    expect(k('KeyC')).toBe('tool-cut');
    expect(k('KeyX')).toBe('flip');
    expect(k('Comma')).toBe('nudge-');
    expect(k('Period', { alt: true })).toBe('nudge-fine+');
    expect(k('Digit0')).toBe('fit-hall');
    expect(k('KeyF')).toBe('fit-selection');
    expect(k('KeyM', { scope: 'view3d' })).toBe(null);
    expect(pane2DKey({ code: 'KeyM', ctrlKey: true, target: el('view2d') }, false)).toBe(null);
  });
});

describe('palette2d (T10)', () => {
  it('paper tokens equal the sheet palette', () => {
    expect(PAPER_TOKENS.ink).toBe(corePalette.INK);
    expect(PAPER_TOKENS.inkSoft).toBe(corePalette.INK_SOFT);
    expect(PAPER_TOKENS.lineLight).toBe(corePalette.LINE_LIGHT);
    expect(PAPER_TOKENS.ghostFill).toBe(corePalette.GHOST_FILL);
    expect(PAPER_TOKENS.ghostStroke).toBe(corePalette.GHOST_STROKE);
    expect(PAPER_TOKENS.grid).toBe(corePalette.GRID);
  });

  it('dark theme lifts busway-b and oob to L* ≥ 55 and keeps system pairs apart', () => {
    const C = corePalette.SYSTEM_COLOR;
    expect(hexToLab(C['busway-b'])![0]).toBeLessThan(DARK_MIN_L); // the reason for the rule
    for (const id of ['busway-b', 'oob', 'busway-a', 'cdu-supply', 'cdu-return', 'trays', 'frontend', 'storage'] as const) expect(hexToLab(themeStroke(C[id], 'dark'))![0], id).toBeGreaterThanOrEqual(DARK_MIN_L);
    const d = (a: keyof typeof C, b: keyof typeof C) => deltaE(themeStroke(C[a], 'dark'), themeStroke(C[b], 'dark'));
    expect(d('busway-a', 'busway-b')).toBeGreaterThan(20);
    expect(d('cdu-supply', 'cdu-return')).toBeGreaterThan(20);
    expect(d('busway-a', 'cdu-return')).toBeGreaterThan(20);
    expect(d('busway-b', 'cdu-supply')).toBeGreaterThan(10);
    expect(themeStroke(C['busway-a'], 'paper')).toBe(C['busway-a']);
  });

  it('role styles follow the sheet rules with screen weights', () => {
    const rack = canvasStyle({ style: 'rack', layer: 'racks', role: 'cut', primId: 'rack:A' }, { category: 'gpu-rack' }, 'paper', 'plan');
    expect(rack.fill).toBe(corePalette.CATEGORY_PLAN['gpu-rack']!.fill);
    expect(rack.lw).toBe(1.25);
    const over = canvasStyle({ style: 'busway', layer: 'busway-b', role: 'overhead', primId: 'busway:b' }, { system: 'busway-b' }, 'paper', 'plan');
    expect(over.fill).toBe(null);
    expect(over.dash?.length).toBe(2);
    expect(over.stroke).toBe(corePalette.SYSTEM_COLOR['busway-b']);
    const wallCut = canvasStyle({ style: 'wall', layer: 'walls', role: 'cut' }, undefined, 'dark', 'section');
    expect(wallCut.lw).toBe(2.5);
    expect(wallCut.hatch).toBe('wall');
    const ret = canvasStyle({ style: 'pipe', layer: 'pipes', role: 'cut', primId: 'pipe:row#R' }, undefined, 'paper', 'section');
    expect(ret.stroke).toBe(corePalette.SYSTEM_COLOR['cdu-return']);
    expect(styleIdentity({ style: 'pipe', layer: 'pipes', role: 'cut', primId: 'pipe:row#R' }, undefined)).not.toBe(styleIdentity({ style: 'pipe', layer: 'pipes', role: 'cut', primId: 'pipe:row#S' }, undefined));
  });
});

describe('cut tool (T10)', () => {
  const rows: RowGroup[] = [
    { id: 'pod-01-a', hallId: 'h', podId: 'pod-01', kind: 'compute', axis: 'x', a0: 2, a1: 14, center: 5, frontSign: -1, memberIds: [] },
    { id: 'pod-01-b', hallId: 'h', podId: 'pod-01', kind: 'compute', axis: 'x', a0: 2, a1: 14, center: 7.4, frontSign: 1, memberIds: [] },
  ];
  const ctx = { rows, rackRects: [{ x: 2, y: 4.4, w: 0.6, d: 1.2 }], containments: [{ rect: { x: 2, y: 5.6, w: 12, d: 1.2 } }], tileSize: 0.6, tol: 0.25 };

  it('labels A–A, B–B … skipping used letters', () => {
    expect(nextCutLabel([])).toEqual({ letter: 'A', label: 'A–A' });
    expect(nextCutLabel([{ label: 'A–A' }, { label: 'C–C' }]).label).toBe('B–B');
    expect(nextCutLabel(Array.from({ length: 26 }, (_, i) => ({ label: `${String.fromCharCode(65 + i)}–` }))).letter).toBe('AA');
  });

  it('snaps to row centre, aisle centre, rack face and grid in that preference', () => {
    expect(snapCutPosition(5.1, 'y', ctx)).toEqual({ value: 5, kind: 'row-centre' });
    const aisle = snapCutPosition(6.25, 'y', ctx);
    expect(aisle.kind).toBe('aisle-centre');
    expect(aisle.value).toBeCloseTo(6.2, 9);
    expect(snapCutPosition(4.45, 'y', ctx)).toEqual({ value: 4.4, kind: 'rack-face' });
    expect(snapCutPosition(9.05, 'y', ctx)).toEqual({ value: 9, kind: 'grid' });
    expect(snapCutPosition(5.1, 'y', ctx, [20, 30]).kind).not.toBe('row-centre'); // outside the row span
    expect(snapCutPosition(10.3, 'y', { ...ctx, tileSize: 0 })).toEqual({ value: 10.3, kind: null });
  });

  it('a drag is always 0° / 90°; Alt skips target snapping; the window follows the drag', () => {
    const h = cutFromDrag([3, 5.08], [12, 5.9], ctx);
    expect(h.axis).toBe('y');
    expect(h.at).toBe(5);
    expect(h.snap).toBe('row-centre');
    expect(cutPlanSpan({ axis: h.axis, look: h.look, window: h.window })).toEqual([3, 12]);
    const free = cutFromDrag([3, 5.08], [12, 5.9], ctx, { free: true });
    expect(free.at).toBe(5.08);
    const v = cutFromDrag([8.02, 1], [8.2, 12], ctx);
    expect(v.axis).toBe('x');
    expect(cutPlanSpan({ axis: v.axis, look: v.look, window: v.window })).toEqual([1, 12]);
  });

  it('flip mirrors u and keeps the plan extent; nudge moves the plane only', () => {
    const c: DrawingCut = { id: 'c', label: 'A–A', hallId: 'h', axis: 'y', at: 6.2, look: 1, depthM: 2.4, window: { u0: 3, u1: 12 } };
    const f = flipCut(c);
    expect(f.look).toBe(-1);
    expect(f.window).toEqual({ u0: -12, u1: -3 });
    expect(cutPlanSpan(f)).toEqual(cutPlanSpan(c));
    expect(flipCut(f)).toEqual(c);
    const x: DrawingCut = { ...c, axis: 'x' };
    expect(cutPlanSpan(flipCut(x))).toEqual(cutPlanSpan(x));
    expect(nudgeCut(c, 0.6).at).toBeCloseTo(6.8);
    expect(nudgeCut(c, -0.05).window).toEqual(c.window);
  });

  it('quick cuts: transverse ⟂ rows, every physical row centre, long section along the aisle, aisle lookup, targets', () => {
    const t = crossSectionThroughRow(rows[0], rows, 8, 5);
    expect(t.axis).toBe('x');
    expect(t.at).toBe(8);
    expect(cutPlanSpan(t as DrawingCut)).toEqual([2.5, 9.9]);
    const l = longSectionAlongAisle({ x: 2, y: 5.6, w: 12, d: 1.2 }, 'h');
    expect(l.axis).toBe('y');
    expect(l.at).toBeCloseTo(6.2);
    expect(cutPlanSpan(l as DrawingCut)).toEqual([1, 15]);
    const rowSections = rows.map((row) => longSectionThroughRow(row));
    expect(rowSections).toHaveLength(rows.length);
    expect(rowSections[0]).toMatchObject({ axis: 'y', at: 5, look: 1 });
    expect(cutPlanSpan(rowSections[0] as DrawingCut)).toEqual([1, 15]);
    expect(rowSections.every((cut, i) => cutMatchesRow(cut, rows[i]))).toBe(true);
    expect(cutMatchesRow({ ...rowSections[0], at: 5.2 }, rows[0])).toBe(false);
    expect(sectionScopeId('pod-services-04', 'x')).toBe('pod-04');
    const withSupport: RowGroup[] = [...rows, { ...rows[0], id: 'pod-services-01-a', podId: 'pod-services-01', center: 12 }];
    expect(cutPlanSpan(crossSectionThroughRow(rows[0], withSupport, 8, 5) as DrawingCut)).toEqual([2.5, 14.5]);
    const ai = aisleAt(rows, 1.2, 8, 6.2)!;
    expect([ai.x, ai.y, ai.w]).toEqual([2, 5.6, 12]);
    expect(ai.d).toBeCloseTo(1.2, 9);
    expect(aisleAt(rows, 1.2, 8, 3)).toBe(null);
    const tg = elevationTargets(rows, [{ id: 'hac-1', hallId: 'h' }, { id: 'other', hallId: 'x' }], 'h');
    expect(tg.map((x) => x.kind)).toEqual(['wall', 'wall', 'wall', 'wall', 'row-face', 'row-face', 'aisle-end']);
    expect(flipTarget({ kind: 'wall', wall: 'N' })).toEqual({ kind: 'wall', wall: 'S' });
    expect(flipTarget({ kind: 'aisle-end', containmentId: 'hac-1', end: 0 })).toEqual({ kind: 'aisle-end', containmentId: 'hac-1', end: 1 });
  });

  it('plan cut segments (renderer) match the window; nice scale-bar lengths', () => {
    const c: DrawingCut = { id: 'c', label: 'A–A', hallId: 'h', axis: 'y', at: 6, look: -1, depthM: 2, window: { u0: -12, u1: -3 } };
    expect(cutSegment(c, null)).toEqual([3, 6, 12, 6]);
    expect(cutSegment({ ...c, window: undefined }, { x: 0, y: 0, w: 20, d: 14 })).toEqual([0, 6, 20, 6]);
    expect([0.3, 1.4, 3, 7.5, 60, 240].map(niceLength)).toEqual([0.2, 1, 2, 5, 50, 200]);
  });
});

describe('measure (T10)', () => {
  it('chain length and readouts in m and ft-in', () => {
    const pts: [number, number][] = [[0, 0], [3, 4], [3, 6.7305]];
    expect(chainLength(pts)).toBeCloseTo(7.7305);
    const m = measureReadout(pts, 'plan', 'metric');
    expect(m.segments[0]).toEqual({ L: '5.00', d1: '3.00', d2: '4.00' });
    expect(m.axes).toEqual(['Δx', 'Δy']);
    const ft = measureReadout([[0, 0], [0, 2.7305]], 'section', 'imperial');
    expect(ft.segments[0].L).toBe(`8'-11 1/2"`);
    expect(ft.axes).toEqual(['Δu', 'Δz']);
    expect(ft.total).toBe(fmtLength(2.7305, 'imperial'));
  });

  it('snaps to the nearest candidate, then the grid, within tolerance', () => {
    expect(snapPoint([1.02, 1.01], [{ x: 1, y: 1 }, { x: 1.1, y: 1 }], 0.1)).toEqual({ pt: [1, 1], snapped: 'point' });
    expect(snapPoint([1.22, 0.59], [], 0.05, 0.6)).toEqual({ pt: [1.2, 0.6], snapped: 'grid' });
    expect(snapPoint([1.5, 0.3], [], 0.05, 0.6).snapped).toBe(null);
  });
});

describe('view transform (T10)', () => {
  it('round trips, zooms about the cursor and fits a rect', () => {
    const v = { cx: 10, cy: 5, ppm: 20 };
    const [sx, sy] = worldToScreen(v, 800, 600, 12.5, 3);
    expect(screenToWorld(v, 800, 600, sx, sy)).toEqual([12.5, 3]);
    const z = zoomAt(v, 800, 600, 100, 80, 2.5);
    const a = screenToWorld(v, 800, 600, 100, 80);
    const b = screenToWorld(z, 800, 600, 100, 80);
    expect(b[0]).toBeCloseTo(a[0]);
    expect(b[1]).toBeCloseTo(a[1]);
    const f = fitRect({ x: 0, y: 0, w: 406, d: 60 }, 1920, 1080, 0.04);
    const vis = visibleRect(f, 1920, 1080);
    expect(vis.x).toBeLessThanOrEqual(0);
    expect(vis.x + vis.w).toBeGreaterThanOrEqual(406);
    expect(panBy(v, 20, -20)).toEqual({ cx: 9, cy: 4, ppm: 20 });
  });
});

describe('view2d store slice (T10)', () => {
  function makeStore(hallId = 'hall-a') {
    const halls: string[] = [];
    const host = { hallId, setHall: (id: string) => { halls.push(id); host.hallId = id; }, view2d: null as unknown as View2DSlice };
    const set = (fn: (s: typeof host) => Partial<typeof host>) => Object.assign(host, fn(host));
    host.view2d = createView2dSlice(set as never, (() => host) as never);
    return { host, halls };
  }

  it('parses persisted state defensively', () => {
    expect(parseView2dState('{bad')).toEqual({});
    expect(parseView2dState(JSON.stringify({ mode: 'nope', theme: 'dark', layers: ['racks', 'bogus'], splitRatio: 9, depth: 'wall', cuts: [{ id: 'c', axis: 'q' }] }))).toEqual({ theme: 'dark', layers: ['racks'], depth: 'wall', cuts: [] });
    expect(DEFAULT_VIEW2D.layers).toContain('racks');
    expect(DEFAULT_VIEW2D.layers).not.toContain('keynotes');
  });

  it('adds labelled cuts, flips / nudges the active one, cycles, removes', () => {
    const { host } = makeStore();
    const a = host.view2d.addCut({ hallId: 'hall-a', axis: 'y', at: 5, look: 1, depthM: 2.4, window: { u0: 0, u1: 10 } });
    const b = host.view2d.addCut({ hallId: 'hall-a', axis: 'x', at: 3, look: 1, depthM: 2.4 });
    expect([a.label, b.label]).toEqual(['A–A', 'B–B']);
    expect(host.view2d.activeCutId).toBe(b.id);
    host.view2d.flipActive();
    expect(host.view2d.cuts.find((c) => c.id === b.id)!.look).toBe(-1);
    host.view2d.nudgeActive(0.6);
    expect(host.view2d.cuts.find((c) => c.id === b.id)!.at).toBeCloseTo(3.6);
    host.view2d.cycle(1);
    expect(host.view2d.activeCutId).toBe(a.id);
    host.view2d.removeCut(a.id);
    expect(host.view2d.cuts.map((c) => c.id)).toEqual([b.id]);
    expect(host.view2d.activeCutId).toBe(b.id);
  });

  it('adds a complete row-section set atomically with stable sequential labels', () => {
    const { host } = makeStore();
    const made = host.view2d.addCuts([
      { hallId: 'hall-a', axis: 'y', at: 5, look: 1, depthM: 2.4 },
      { hallId: 'hall-a', axis: 'y', at: 7.4, look: -1, depthM: 2.4 },
    ]);
    expect(made.map((c) => c.label)).toEqual(['A–A', 'B–B']);
    expect(host.view2d.cuts).toHaveLength(2);
    expect(host.view2d.activeCutId).toBe(made[0].id);
  });

  it('leaving Plan returns the Cut tool to Select; other tools are kept (QA r4 view2d F4)', () => {
    const { host } = makeStore();
    host.view2d.set({ tool: 'cut' } as never);
    host.view2d.setMode('plan');
    expect(host.view2d.tool).toBe('cut');
    host.view2d.setMode('section');
    expect(host.view2d.tool).toBe('select');
    host.view2d.set({ tool: 'measure' } as never);
    host.view2d.setMode('elevation');
    expect(host.view2d.tool).toBe('measure');
  });

  it('open() — the Drawings "Open in 2D" hand-off — switches hall, mode, cut and requests a frame', () => {
    const { host, halls } = makeStore();
    const cut: DrawingCut = { id: 'section-t-hall-b-pod-02', label: 'T02', hallId: 'hall-b', axis: 'x', at: 30, look: 1, depthM: 2.4, window: { u0: -20, u1: 0 } };
    host.view2d.open({ mode: 'section', hallId: 'hall-b', cut, frame: { x: -20, y: -0.3, w: 20, d: 5 } });
    expect(halls).toEqual(['hall-b']);
    expect(host.view2d.mode).toBe('section');
    expect(host.view2d.activeCutId).toBe(cut.id);
    expect(host.view2d.frameRequest).toMatchObject({ hallId: 'hall-b', space: 'section', rect: { x: -20, y: -0.3, w: 20, d: 5 } });
    const n = host.view2d.frameRequest!.nonce;
    host.view2d.open({ mode: 'elevation', elevation: { kind: 'aisle-end', containmentId: 'hac', end: 0 } });
    expect(host.view2d.elevation).toEqual({ kind: 'aisle-end', containmentId: 'hac', end: 0 });
    expect(host.view2d.frameRequest!.nonce).toBeGreaterThan(n);
    host.view2d.toggleSplit();
    expect(host.view2d.split).toBe(true);
    host.view2d.setMode('3d');
    expect(host.view2d.split).toBe(false);
    host.view2d.applyPreset('power');
    expect(host.view2d.layers).toContain('busway-b');
  });
});

describe('synthetic benchmark list + shared tooltip (T10)', () => {
  it('synthetic plan has 10 k racks + 5 k segments and packs', () => {
    const s = syntheticPlan();
    expect(s.list.items.filter((i) => i.layer === 'racks')).toHaveLength(10_000);
    expect(s.list.items).toHaveLength(15_000);
    expect(packDrawList(s.list).count).toBe(15_000);
  });

  it('equipment tooltip builder: title = tag, lines in the viewer order', () => {
    const { project } = createNvidiaReferenceProject();
    const e = project.equipment.find((x) => x.networkRole)!;
    const t = (k: string, p?: Record<string, string | number>) => `${k}${p ? JSON.stringify(p) : ''}`;
    const tip = equipmentTooltip(t, e, { name: 'Rack X', category: 'gpu-rack', power: { nameplateKW: 100 } } as never, { inletC: 27.25, roleLabel: (r) => `role:${r}` });
    expect(tip.title).toBe(e.tag);
    expect(tip.lines[0]).toBe('Rack X');
    expect(tip.lines.some((l) => l.startsWith('shell.viewer.tip.inletTemp'))).toBe(true);
    expect(tip.lines.some((l) => l.includes(`role:${e.networkRole}`))).toBe(true);
    expect(rowGroupsFromEquipment(project.halls[0].id, project.equipment).length).toBeGreaterThan(0);
  });
});
