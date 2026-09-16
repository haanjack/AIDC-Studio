// Backlog T2 (docs/research/backlog-T2.md): feeder bundles (#5), split 1:50 / 1:200 windows with match lines (#3 / #4), hall-plan paper
// orientation (#4), one clipDrawList / keyPlanInset (#8), prim-backed drawings scene (#1), position-tag fallbacks (#2), KO device words (#12).
import { describe, expect, it } from 'vitest';
import { bundleFeederItems, feederBundleLabel, feederBundles, type DrawItem2D, type DrawList2D } from '../src/index.ts';
import { createSheetContext } from '../src/drawings/context.ts';
import { splitPlanWindow, windowedPlanArea } from '../src/drawings/enlarged.ts';
import { deviceWords } from '../src/drawings/i18n.ts';
import { listDrawings, buildDrawing, planPaper } from '../src/drawings/index.ts';
import { keyPlanInset } from '../src/drawings/keyPlan.ts';
import { clipDrawList } from '../src/drawings/plan.ts';
import { clipDrawList as clipSection } from '../src/drawings/section.ts';
import { buildHallScene } from '../src/drawings/scene.ts';
import { A1, A1L } from '../src/drawings/sheet.ts';
import { buildHallPrims } from '../src/scene/build.ts';
import { analysisOf, refProject } from './drawings-r4-helpers.ts';

const feeder = (x: number, y: number, w: number, d: number, ref: string): DrawItem2D => ({ kind: 'rect', pts: [x, y, w, d], role: 'overhead', layer: 'feeders', lodMin: 2, style: 'feeder', primId: `feeder:${ref}`, refId: ref });
const list = (items: DrawItem2D[]): DrawList2D => ({ space: 'plan', hallId: 'h', bounds: { x: 0, y: 0, w: 60, d: 30 }, items, hash: '' });

describe('backlog T2 #5 feeder bundles', () => {
  it('parallel feeders of one route form one bundle; a far lane and a single feeder stay apart', () => {
    const items = [feeder(0, 10.0, 40, 0.05, 'f1'), feeder(2, 10.08, 38, 0.05, 'f2'), feeder(0, 10.16, 35, 0.05, 'f3'), feeder(0, 20, 30, 0.05, 'f4'), feeder(50, 1, 0.05, 20, 'f5'), feeder(50.1, 3, 0.05, 15, 'f6')];
    const b = feederBundles(items);
    expect(b.map((q) => [q.axis, q.count])).toEqual([['h', 3], ['h', 1], ['v', 2]]);
    expect(b[0].a0).toBe(0);
    expect(b[0].a1).toBe(40);
    expect(feederBundleLabel('en', 3)).toBe('3 circuits');
    expect(feederBundleLabel('ko', 3)).toBe('회로 3개');
  });

  it('bundleFeederItems: one centre line per bundle at LOD 1, members move to the detail band, singles untouched', () => {
    const src = list([feeder(0, 10, 40, 0.05, 'f1'), feeder(0, 10.1, 40, 0.05, 'f2'), feeder(0, 25, 10, 0.05, 'solo')]);
    const r = bundleFeederItems(src);
    expect(r.bundles).toHaveLength(1);
    expect(r.list.items.slice(0, 2).map((i) => i.lodMin)).toEqual([3, 3]);
    expect(r.list.items[2].lodMin).toBe(2);
    const line = r.list.items[3];
    expect(line).toMatchObject({ kind: 'polyline', layer: 'feeders', lodMin: 1, style: 'feeder' });
    expect(line.pts[1]).toBeCloseTo(10.075, 6);
    expect(r.list.hash).not.toBe('');
    expect(src.items[0].lodMin).toBe(2); // input not mutated
  });

  it('sheet 111 of the reference hall draws bundles with circuit-count labels', () => {
    const p = refProject();
    const a = analysisOf(p);
    const id = listDrawings(p, a, { sheets: ['services-plan'] })[0].id;
    const svg = buildDrawing(p, a, id, { sheets: ['services-plan'] }).svg;
    const counts = [...svg.matchAll(/data-feeder-bundle="(\d+)"/g)].map((m) => Number(m[1]));
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n >= 2)).toBe(true);
  });
});

describe('backlog T2 #3 / #4 split windows and hall-plan paper', () => {
  it('splitPlanWindow: a fitting window stays whole; an overflowing one splits along its long axis into parts that fit', () => {
    const area = { w: 500, h: 400 };
    expect(splitPlanWindow({ x: 0, y: 0, w: 20, d: 15 }, area, 50)).toHaveLength(1);
    const parts = splitPlanWindow({ x: 1, y: 2, w: 61.3, d: 12 }, area, 50);
    expect(parts.length).toBe(Math.ceil(61.3 / (500 / 20 - 0.1)));
    expect(parts[0].x).toBe(1);
    expect(parts[parts.length - 1].x + parts[parts.length - 1].w).toBeCloseTo(62.3, 9);
    for (const q of parts) {
      expect(q.w * 20).toBeLessThanOrEqual(500 + 1e-6);
      expect(q.y).toBe(2);
      expect(q.d).toBe(12);
    }
    for (let i = 1; i < parts.length; i++) expect(parts[i].x).toBeCloseTo(parts[i - 1].x + parts[i - 1].w, 9);
  });

  it('hall plans: A1 portrait for the reference hall, landscape + 1:200 parts with match lines for a 340 m long hall', () => {
    const p = refProject();
    const ctx = createSheetContext(p, null);
    expect(planPaper(ctx, p.halls[0])).toBe(A1);
    // the QA strip case: 340 m along x × 21.6 m (a hall long along y already reads on portrait and keeps it)
    const tall = structuredClone(p);
    tall.halls[0].width = 21.6;
    tall.halls[0].depth = 340;
    delete tall.halls[0].outline;
    expect(planPaper(createSheetContext(tall, null), tall.halls[0])).toBe(A1);
    const long = structuredClone(p);
    long.halls[0].width = 340;
    long.halls[0].depth = 21.6;
    delete long.halls[0].outline;
    expect(planPaper(createSheetContext(long, null), long.halls[0])).toBe(A1L);
    const sheets = listDrawings(long, null, { sheets: ['plan'] });
    const parts = sheets.filter((m) => m.id.startsWith(`plan-${long.halls[0].id}-part-`));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((m) => m.number)).toEqual(parts.map((_, k) => `101-${String.fromCharCode(97 + k)}`));
    const b = buildDrawing(long, null, parts[1].id, { sheets: ['plan'] });
    expect(b.svg).toContain(`data-match-line="${parts[0].number}"`);
    expect(b.svg).toContain(`data-match-line="${parts[2]?.number ?? parts[0].number}"`);
    expect(windowedPlanArea(ctx).w).toBeGreaterThan(300);
  });
});

describe('backlog T2 #8 one clipDrawList / keyPlanInset', () => {
  const circleList = list([{ kind: 'circle', pts: [9.95, 5, 0.1], role: 'cut', layer: 'pipes', lodMin: 1, style: 'pipe' }]);
  it('plan clip drops a circle crossing the window edge; the section clip keeps it by centre; both rehash', () => {
    const w = { x: 0, y: 0, w: 10, d: 10 };
    const a = clipDrawList(circleList, w);
    const b = clipSection(circleList, w);
    expect(a.items).toHaveLength(0);
    expect(b.items).toHaveLength(1);
    expect(a.hash).not.toBe(b.hash);
    expect(b.bounds).toEqual(w);
  });
  it('keyPlanInset: bare hatched inset (121) and framed inset with title and cut arrows (301 / 302 / 311)', () => {
    const hall = refProject().halls[0];
    const bare = keyPlanInset(hall, { x: 0, y: 0, w: 50, h: 40 }, { highlight: [{ x: 1, y: 1, w: 5, d: 5 }] });
    expect(bare).toContain('url(#tb-hatch)');
    expect(bare).not.toContain('data-layer="key-plan"');
    const framed = keyPlanInset(hall, { x: 0, y: 0, w: 80, h: 86 }, { cut: { axis: 'x', at: 5, t0: 0, t1: 10, look: 1 } }, { title: '키 플랜', rows: [{ x: 1, y: 1, w: 8, d: 1.2 }] });
    expect(framed).toContain('data-layer="key-plan"');
    expect(framed).toContain('키 플랜');
    expect((framed.match(/<polygon/g) ?? []).length).toBe(2);
  });
});

describe('backlog T2 #1 drawings scene on prims', () => {
  it('rows are the prim row groups and runs are the tray / busway / pipe prims of the hall', () => {
    const p = refProject();
    const hall = p.halls[0];
    const hp = buildHallPrims(p, null, { hallId: hall.id, detail: 'hall' });
    const scene = buildHallScene(p, hall, hp);
    expect(scene.rows.map((r) => r.id).sort()).toEqual(hp.rows.filter((g) => g.memberIds.some((id) => scene.items.some((s) => s.e.id === id))).map((g) => g.id).sort());
    const segs = hp.prims.filter((q) => (q.emitter === 'busway' || q.emitter === 'pipe' || (q.emitter === 'tray' && q.meta?.kind !== 'drop')) && (q.shape === 'bar' || q.shape === 'tube'));
    expect(scene.runs).toHaveLength(segs.length);
    expect(scene.runs.filter((r) => r.kind === 'busway').length).toBe(hp.prims.filter((q) => q.emitter === 'busway').length);
  });
});

describe('backlog T2 #12 KO device vocabulary', () => {
  it('translates generated slot models and switch roles, keeps codes and product names', () => {
    expect(deviceWords('ko', 'Power shelf')).toBe('파워 셸프');
    expect(deviceWords('ko', 'Compute tray')).toBe('컴퓨트 트레이');
    expect(deviceWords('ko', 'NVLink switch tray')).toBe('NVLink 스위치 트레이');
    expect(deviceWords('ko', 'QM9790 · leaf · scale-out')).toBe('QM9790 · 리프 · 스케일아웃');
    expect(deviceWords('en', 'Power shelf')).toBe('Power shelf');
  });
  it('KO rack elevation sheets carry no English slot model words', () => {
    const p = { ...refProject(), locale: 'ko' as const };
    const a = analysisOf(p);
    const sheets = listDrawings(p, a, { locale: 'ko' }).filter((m) => m.number.startsWith('2')).slice(0, 3);
    expect(sheets.length).toBeGreaterThan(0);
    for (const m of sheets) {
      const svg = buildDrawing(p, a, m.id, { locale: 'ko' }).svg;
      expect(svg, m.number).not.toMatch(/>[^<]*\b(Power shelf|Compute tray|NVLink switch tray|Rack stiffener)\b/);
    }
  });
});
