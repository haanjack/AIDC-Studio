// r4 sheets (spec §4.4 T5 / T7) — stream B0 cases: units, annotation grammar, DrawList → SVG, sheets 001 and 601.
// B1 / B2 add their own describe blocks for their kinds (helpers in drawings-r4-helpers.ts).
import { describe, expect, it } from 'vitest';
import {
  annotate,
  buildDrawing,
  crossRefNotes,
  cullLabels,
  datumLabel,
  dimChain,
  drawListToSvg,
  emptyDrawList,
  feetInches,
  findCatalogItem,
  fitViewport,
  fmtLength,
  fmtLevel,
  imperialStepIn,
  keynoteForPrim,
  KEYNOTES,
  keynotesUsed,
  LabelCuller,
  listDrawings,
  openDrawingSet,
  paperStyleOf,
  rowLetter,
  rowSlots,
  svgStructure,
  textBox,
  viewportPaperToWorld,
  viewportWorldToPaper,
  type Annotation2D,
  type DrawingCut,
  type PaperBox,
  type Project,
  type ProjectAnalysis,
} from '../src/index.ts';
import { schematicRows } from '../src/drawings/schematic.ts';
import { R4_FX_HALL, r4FixtureHallPrims } from './fixtures/r4-prims.ts';
import { analysisOf, emptyHallProject, fixturePlanList, fixtureProject as fxProject, fixtureSectionList, podProject, rcuProject, refProject, rootPaper, sheetProblems } from './drawings-r4-helpers.ts';

function boxesOverlap(a: PaperBox, b: PaperBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// ───────────────────────────── T7: units ─────────────────────────────

describe('r4 B0 units (T7)', () => {
  it('imperial ft-in: ½" at 1:50 and larger, 1" on plans; the containment-end heights', () => {
    expect(fmtLength(2.7305, 'imperial')).toBe(`8'-11 1/2"`);
    expect(fmtLength(3.0734, 'imperial')).toBe(`10'-1"`);
    expect(fmtLength(3.4163, 'imperial')).toBe(`11'-2 1/2"`);
    expect(fmtLength(2.7305, 'imperial', 50)).toBe(`8'-11 1/2"`);
    expect(fmtLength(2.7305, 'imperial', 100)).toBe(`9'-0"`);
    expect(imperialStepIn()).toBe(0.5);
    expect(imperialStepIn(25)).toBe(0.5);
    expect(imperialStepIn(200)).toBe(1);
    expect(feetInches(0.3048 * 12 - 0.001, 0.5)).toBe(`12'-0"`); // 11'-11.96" rounds up into the next foot
    expect(feetInches(-0.001)).toBe(`0'-0"`);
  });

  it('metric default: two decimals, no suffix; levels signed', () => {
    expect(fmtLength(2.7305)).toBe('2.73');
    expect(fmtLength(-0.001)).toBe('0.00');
    expect(fmtLength(Number.NaN)).toBe('—');
    expect(fmtLevel(0)).toBe('±0.00');
    expect(fmtLevel(2.4)).toBe('+2.40');
    expect(fmtLevel(-0.3)).toBe('-0.30');
    expect(fmtLevel(0.001, 'imperial')).toBe(`±0'-0"`);
    expect(fmtLevel(2.7305, 'imperial')).toBe(`+8'-11 1/2"`);
    expect(fmtLevel(-0.3048, 'imperial')).toBe(`-1'-0"`);
  });
});

// ───────────────────────────── T7: position tags, keynotes, notes ─────────────────────────────

describe('r4 B0 annotation grammar (T7)', () => {
  it('rowSlots: racks numbered in floor order, units unnumbered, gaps take no number (…A03, gap, A04)', () => {
    const items = [
      { id: 'r5', a0: 7.6, a1: 8.2, kind: 'rack' as const },
      { id: 'cdu', a0: 3.1, a1: 3.7, kind: 'unit' as const },
      { id: 'r1', a0: 4.0, a1: 4.6, kind: 'rack' as const },
      { id: 'r2', a0: 4.6, a1: 5.2, kind: 'rack' as const },
      { id: 'r3', a0: 5.2, a1: 5.8, kind: 'rack' as const },
      { id: 'r4', a0: 7.0, a1: 7.6, kind: 'rack' as const },
      { id: 'r6', a0: 8.3, a1: 8.9, kind: 'rack' as const }, // 0.1 m enclosure break
    ];
    const r = rowSlots('pod-01-a', items);
    expect(r.letter).toBe('A');
    expect(r.slots.map((s) => s.item.id)).toEqual(['cdu', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(r.slots.map((s) => s.positionTag ?? '-')).toEqual(['-', 'A01', 'A02', 'A03', 'A04', 'A05', 'A06']);
    expect(r.gaps.map((g) => [g.kind, g.afterPosition, +g.width.toFixed(2)])).toEqual([
      ['gap', undefined, 0.3],
      ['gap', 3, 1.2],
      ['break', 5, 0.1],
    ]);
    expect(r.runs).toHaveLength(4);
    expect(rowLetter('row-B')).toBe('B');
    expect(rowLetter('pod-ref-b')).toBe('B');
  });

  it('fixture plan: position tags skip the mid-row gap, chains sum to the hall width, one keynote per id', () => {
    const hp = r4FixtureHallPrims();
    const list = fixturePlanList(hp);
    const ann = annotate(fxProject(), hp, list, { locale: 'en', scaleDen: 100 });
    const pos = ann.filter((a) => a.kind === 'position-tag');
    expect(pos.map((a) => a.text).sort()).toEqual(['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'B01', 'B02', 'B03', 'B04', 'B05', 'B06']);
    // A03 sits left of the gap, A04 right of it (gap 5.8–7.0 m)
    const at = (t: string) => pos.find((a) => a.text === t)!.pts[0];
    expect(at('A03')).toBeLessThan(5.8);
    expect(at('A04')).toBeGreaterThan(7.0);
    // tags sit outside the front edge: row A fronts −y (centre 4.0, depth 1.2)
    expect(pos.find((a) => a.text === 'A01')!.pts[1]).toBeLessThan(3.4);
    expect(pos.find((a) => a.text === 'B01')!.pts[1]).toBeGreaterThan(7.0);
    const chains = ann.filter((a) => a.kind === 'dim-chain' && a.refId?.startsWith('row-') && !a.refId.includes('|'));
    expect(chains).toHaveLength(2);
    for (const ch of chains) {
      const xs = ch.pts.filter((_, i) => i % 2 === 0);
      expect(xs[0]).toBe(0);
      expect(xs[xs.length - 1]).toBe(R4_FX_HALL.width);
      const sum = ch.texts!.reduce((s, t) => s + Number(t), 0);
      expect(Math.abs(sum - R4_FX_HALL.width)).toBeLessThanOrEqual(0.011 * ch.texts!.length); // two-decimal texts
      expect(ch.texts).toContain('1.20'); // the mid-row gap
    }
    const aisle = ann.find((a) => a.kind === 'dim-chain' && a.refId === 'row-A|row-B');
    expect(aisle?.texts).toEqual(['1.20']);
    const kn = ann.filter((a) => a.kind === 'keynote').map((a) => a.keynoteId);
    expect(new Set(kn).size).toBe(kn.length);
    expect(kn).toEqual(expect.arrayContaining(['01', '05', '10', '11', '12', '20', '21', '22', '23', '30', '31', '32', '40', '41', '42']));
    // 1:50 adds per-rack stops
    const fine = annotate(fxProject(), hp, list, { locale: 'en', scaleDen: 50 }).filter((a) => a.kind === 'dim-chain' && a.refId === 'row-A');
    expect(fine[0].texts!.filter((t) => t === '0.60').length).toBeGreaterThanOrEqual(5);
    // layers / lod filters
    expect(annotate(fxProject(), hp, list, { lod: 1 }).every((a) => a.lodMin <= 1)).toBe(true);
    expect(annotate(fxProject(), hp, list, { layers: ['tags'] }).every((a) => a.layer === 'tags')).toBe(true);
  });

  it('section: localized datums with source tags, vertical datum chain, section markers from cuts', () => {
    const hp = r4FixtureHallPrims();
    const sec = fixtureSectionList(4.0, hp);
    const en = annotate(fxProject(), hp, sec, { locale: 'en' });
    const ko = annotate(fxProject(), hp, sec, { locale: 'ko', units: 'imperial' });
    const dEn = en.filter((a) => a.kind === 'datum');
    expect(dEn.map((a) => a.text)).toContain('+2.40 TOP OF CONTAINMENT');
    expect(dEn.map((a) => a.text)).toContain('±0.00 FFL');
    expect(dEn.find((a) => a.refId === 'T3')?.source).toBe('estimate');
    expect(ko.filter((a) => a.kind === 'datum').map((a) => a.text)).toContain(`+7'-10 1/2" 컨테인먼트 상단`);
    const chain = en.find((a) => a.kind === 'dim-chain' && a.axis === 'v')!;
    expect(chain.texts!.length).toBe(hp.datums.length - 1);
    expect(en.some((a) => a.kind === 'position-tag' && a.text === 'A01')).toBe(true);
    expect(datumLabel('rack-top', 'ko')).toBe('랙 상단');
    expect(datumLabel('mystery', 'en', 'X')).toBe('X');
    const plan = fixturePlanList(hp);
    const cut: DrawingCut = { id: 'c1', label: 'A–A', hallId: hp.hallId, axis: 'y', at: 4, look: -1, depthM: 2 };
    const marker = annotate(fxProject(), hp, plan, { cuts: [{ cut, target: '301-H1-T01' }] }).find((a) => a.kind === 'section-marker')!;
    expect(marker).toMatchObject({ text: 'A', look: -1, target: '301-H1-T01' });
    expect(marker.pts[1]).toBe(4);
  });

  it('keynotes: prim mapping and per-sheet used sets in vocabulary order', () => {
    expect(keynoteForPrim({ emitter: 'door', layer: 'containment-doors' })).toBe('05');
    expect(keynoteForPrim({ emitter: 'door', layer: 'doors' })).toBe('42');
    expect(keynoteForPrim({ emitter: 'tray', layer: 'tray-t3', tier: 'T3' })).toBe('22');
    expect(keynoteForPrim({ emitter: 'pipe', layer: 'pipes', system: 'cdu-return' })).toBe('31');
    expect(keynoteForPrim({ emitter: 'room', layer: 'rooms' })).toBeUndefined();
    expect(keynotesUsed(['32', '01', 'tapoff', undefined, '01']).map((k) => k.id)).toEqual(['01', '12', '32']);
    expect(KEYNOTES).toHaveLength(22);
  });

  it('S11 cross-reference notes point at our sheet numbers (same hall first) and skip absent targets', () => {
    const sheets = [
      { number: '611-H2', kind: 'one-line', hallId: 'h2' },
      { number: '611-H1', kind: 'one-line', hallId: 'h1' },
      { number: '311-H1-C1', kind: 'elevation', hallId: 'h1' },
    ];
    const notes = crossRefNotes(sheets, ['busway', 'containment', 'pipes'], 'en', 'h1');
    expect(notes.map((x) => x.text)).toEqual(['BUSWAY A/B — SEE 611-H1', 'AISLE CONTAINMENT & DOORS — SEE 311-H1-C1']);
    expect(crossRefNotes(sheets, ['busway'], 'ko', 'h1')[0].text).toBe('버스웨이 A/B — 611-H1 참조');
  });

  it('dimChain suppresses a segment whose text + 2 mm does not fit', () => {
    const r = dimChain([10, 14, 40], ['0.60', '2.60'], { axis: 'h', at: 50 });
    expect(r.suppressed).toEqual([0]);
    expect(r.svg).toContain('>2.60<');
    expect(r.svg).not.toContain('>0.60<');
  });

  it('label culling: greedy by priority, no overlaps, text below 1.8 mm dropped', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const labels = Array.from({ length: 400 }, (_, i) => ({ box: textBox(rnd() * 200, rnd() * 120, `L${i}`, 2), priority: Math.floor(rnd() * 5), id: i, ...(i % 50 === 0 ? { size: 1.5 } : {}) }));
    const kept = cullLabels(labels, new LabelCuller(0));
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.some((k) => k.size === 1.5)).toBe(false);
    for (let i = 0; i < kept.length; i++) for (let j = i + 1; j < kept.length; j++) expect(boxesOverlap(kept[i].box, kept[j].box)).toBe(false);
    // the highest priority label of an overlapping pair survives
    const pair = cullLabels([{ box: { x: 0, y: 0, w: 10, h: 2 }, priority: 1, id: 'lo' }, { box: { x: 5, y: 0, w: 10, h: 2 }, priority: 9, id: 'hi' }]);
    expect(pair.map((p) => p.id)).toEqual(['hi']);
  });
});

// ───────────────────────────── toSvg ─────────────────────────────

describe('r4 B0 drawListToSvg', () => {
  it('plan: data-layer groups in LAYERS order, clip path, paper line weights, culled labels never overlap, viewport inverse map', () => {
    const hp = r4FixtureHallPrims();
    const list = fixturePlanList(hp);
    const ann = annotate(fxProject(), hp, list, { locale: 'en', scaleDen: 50 });
    const { viewport, scale } = fitViewport(list.bounds, { x: 30, y: 40, w: 500, h: 400 }, { hallId: hp.hallId, space: 'plan' });
    expect(scale).toBe('1:50');
    const r = drawListToSvg(list, ann, viewport, { idPrefix: 'fx-' });
    expect(r.defs.some((d) => d.includes('id="fx-clip"'))).toBe(true);
    expect(r.svg.startsWith('<g clip-path="url(#fx-clip)">')).toBe(true);
    const st = svgStructure(r.svg);
    expect(st.layers.racks).toBe(12);
    expect(st.layers['cdu-crah']).toBe(2);
    expect(st.tags).toEqual(expect.arrayContaining(['A01', 'B06', 'DU01-A-01']));
    expect(st.minTextMm).toBeGreaterThanOrEqual(1.8);
    const widths = new Set([...r.svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1])));
    for (const w of widths) expect([0.15, 0.18, 0.25, 0.35, 0.5]).toContain(w);
    const order = [...r.svg.matchAll(/data-layer="([^"]+)"/g)].map((m) => m[1]);
    expect(order.indexOf('walls')).toBeLessThan(order.indexOf('racks'));
    expect(order.indexOf('racks')).toBeLessThan(order.indexOf('busway-a'));
    // a rack rect maps back to its prim AABB within 1 mm (T3c convention)
    const rack = hp.prims.find((p) => p.id === 'rack:DU01-A-01')!;
    const m = new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"[^>]*data-prim="rack:DU01-A-01"`).exec(r.svg)!;
    const [wx, wy] = viewportPaperToWorld(viewport, Number(m[1]), Number(m[2]) + Number(m[4]));
    expect(Math.abs(wx - rack.a.x)).toBeLessThan(0.001);
    expect(Math.abs(wy - rack.a.y)).toBeLessThan(0.001);
    const [px, py] = viewportWorldToPaper(viewport, rack.b.x, rack.b.y);
    expect(Math.abs(px - (Number(m[1]) + Number(m[3])))).toBeLessThan(0.01);
    expect(Math.abs(py - Number(m[2]))).toBeLessThan(0.01);
    // determinism
    expect(drawListToSvg(list, ann, viewport, { idPrefix: 'fx-' }).svg).toBe(r.svg);
    // layers filter
    expect(svgStructure(drawListToSvg(list, ann, viewport, { layers: ['racks'] }).svg).layers).toEqual({ racks: 12 });
  });

  it('section: slab / wall hatches, cut racks hatched, painter order far → near, datums drawn', () => {
    const hp = r4FixtureHallPrims();
    const list = fixtureSectionList(4.0, hp);
    const ann = annotate(fxProject(), hp, list, { locale: 'en', scaleDen: 50 });
    const { viewport } = fitViewport(list.bounds, { x: 20, y: 30, w: 600, h: 300 }, { hallId: hp.hallId, space: 'section', scaleDen: 50, cut: list.cut });
    expect(viewport.cutId).toBe('A');
    const r = drawListToSvg(list, ann, viewport, { idPrefix: 's-' });
    const defs = r.defs.join('');
    expect(defs).toContain('id="s-hatch-slab"');
    expect(defs).toContain('id="s-hatch-rack-cut"');
    expect(defs).toContain('id="s-hatch-wall"');
    expect(r.svg).toContain('fill="url(#s-hatch-rack-cut)"');
    const st = svgStructure(r.svg);
    expect(st.datums.join(' ')).toContain('+2.40 TOP OF CONTAINMENT');
    // beyond items (the containment roof over the aisle, depth > 0) come before the cut racks
    const firstBeyond = r.svg.indexOf('data-prim="containment-roof:hac-du01"');
    const firstCut = r.svg.indexOf('data-prim="rack:DU01-A-01"');
    expect(firstBeyond).toBeGreaterThan(-1);
    expect(firstBeyond).toBeLessThan(firstCut);
    expect(r.suppressed).toBeGreaterThanOrEqual(0);
  });

  it('style resolution: category, system, compound and layer fallbacks', () => {
    expect(paperStyleOf('gpu-rack').hatch).toBe('rack-cut');
    expect(paperStyleOf('busway-b').stroke).toBe('#1e3a8a');
    expect(paperStyleOf('rack:cdu').fill).toBe(paperStyleOf('cdu').fill);
    expect(paperStyleOf('whatever', 'slab').hatch).toBe('slab');
  });

  it('annotations only: callout + section marker render with bubbles and reserve their space', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 20, d: 14 }, { x: 0, y: 0, w: 400, h: 280 }, { hallId: 'h', space: 'plan', scaleDen: 50 }).viewport;
    const ann: Annotation2D[] = [
      { kind: 'callout', pts: [2, 2, 6, 4], text: '1', target: '121-DU01', priority: 45, layer: 'notes', lodMin: 1 },
      { kind: 'section-marker', pts: [1, 10, 19, 10], text: 'A', look: 1, target: '301', priority: 50, layer: 'notes', lodMin: 1 },
      { kind: 'tag', pts: [0.75, 10], text: 'COLLIDES', priority: 10, layer: 'tags', lodMin: 2 }, // on the left marker bubble
    ];
    const r = drawListToSvg(emptyDrawList('plan', 'h', { x: 0, y: 0, w: 20, d: 14 }), ann, vp);
    expect(r.svg).toContain('>121-DU01<');
    expect(r.svg).toContain('stroke-dasharray="4 1 0.8 1"');
    expect((r.svg.match(/>A</g) ?? []).length).toBe(2);
    expect(r.culled).toBe(1);
  });
});

// ───────────────────────────── T5 / T7: sheets 001 and 601 ─────────────────────────────

const SHEETS = ['index', 'plan', 'rack-elevation', 'row-schematic'] as const;

interface Case {
  name: string;
  project: Project;
  analysis: ProjectAnalysis | null;
}

const ref = refProject();
const refA = analysisOf(ref);
const pod = podProject();
const podA = pod ? analysisOf(pod) : null;
const CASES: Case[] = [
  { name: 'ref', project: ref, analysis: refA },
  { name: 'ref-null', project: ref, analysis: null },
  ...(pod ? [{ name: 'pod', project: pod, analysis: podA }] : []),
];

describe('r4 B0 sheets 001 / 601 (T5)', () => {
  for (const c of CASES) {
    for (const locale of ['en', 'ko'] as const) {
      it(`${c.name} ${locale}: well-formed, text ≥ 1.8 mm, inside the content area, deterministic, paper = root size, numbering`, () => {
        const opts = { locale, sheets: [...SHEETS], date: '2026-09-15' };
        const list = listDrawings(c.project, c.analysis, opts);
        const mine = list.filter((m) => m.kind === 'index' || m.kind === 'row-schematic');
        expect(mine.filter((m) => m.kind === 'index').map((m) => m.number)).toEqual(['001']);
        expect(mine.some((m) => m.kind === 'row-schematic')).toBe(true);
        const set = openDrawingSet(c.project, c.analysis, opts);
        for (const m of mine) {
          expect(m.number).toMatch(m.kind === 'index' ? /^001$/ : /^601-H\d+(-\d{2})?$/);
          expect(m.paper).toEqual({ w: 841, h: 594 });
          expect(m.scale).toBe('NTS');
          const s = set.build(m.id);
          expect(rootPaper(s.svg)).toEqual(s.paper);
          expect(sheetProblems(s.svg, s.paper!), `${c.name} ${locale} ${m.number}`).toEqual([]);
          expect(buildDrawing(c.project, c.analysis, m.id, opts).svg).toBe(s.svg);
        }
      });
    }
  }

  it('empty hall: no 601 is listed; 001 still builds', () => {
    const p = emptyHallProject();
    const list = listDrawings(p, null, { sheets: ['index', 'row-schematic'] });
    expect(list.map((m) => m.number)).toEqual(['001']);
    const s = buildDrawing(p, null, 'index', { sheets: ['index', 'row-schematic'] });
    expect(sheetProblems(s.svg, s.paper!)).toEqual([]);
  });

  it('001 lists every sheet of the set, the full keynote vocabulary, units note per drawingUnits', () => {
    const opts = { sheets: [...SHEETS], rackRows: 'all' as const };
    const list = listDrawings(ref, refA, opts);
    const svg = buildDrawing(ref, refA, 'index', opts).svg;
    for (const m of list) expect(svg, m.number).toContain(`>${m.number}<`);
    for (const k of KEYNOTES) expect(svg).toContain(`>${k.id}<`);
    expect(svg).toContain('Dimensions in metres');
    const imp = { ...ref, drawingUnits: 'imperial' as const };
    expect(buildDrawing(imp, null, 'index', { sheets: ['index'] }).svg).toContain('Dimensions in feet-inches');
    const ko = buildDrawing(ref, refA, 'index', { ...opts, locale: 'ko' }).svg;
    expect(ko).toContain('도면 목록');
    expect(ko).toContain('컨테인먼트 문');
  });

  it('601: position order = floor order, LC runs = liquidFraction > 0.5 runs, gap index, circuits A/B, leaf groups only with analysis', () => {
    const hall = ref.halls[0];
    const rows = schematicRows(ref, refA, hall);
    expect(rows.length).toBeGreaterThan(0);
    const eqById = new Map(ref.equipment.map((e) => [e.id, e]));
    for (const r of rows) {
      const racks = r.slots.slots.filter((s) => s.position !== undefined);
      const coord = (id: string) => (r.row.axis === 'x' ? eqById.get(id)!.position.x : eqById.get(id)!.position.y);
      const floor = [...racks].sort((a, b) => coord(a.item.id) - coord(b.item.id)).map((s) => s.item.id);
      expect(racks.map((s) => s.item.id)).toEqual(floor);
      expect(racks.map((s) => s.position)).toEqual(racks.map((_, i) => i + 1));
      // independent LC-run computation
      const ss = r.slots.slots;
      const gapAfter = new Set(r.slots.gaps.map((g) => g.afterSlot));
      const expected: [number, number][] = [];
      let start = -1;
      ss.forEach((s, i) => {
        const lc = s.item.kind === 'rack' && (findCatalogItem(s.item.eq.catalogId)?.cooling?.liquidFraction ?? 0) > 0.5;
        if (lc && start < 0) start = i;
        if (start >= 0 && (!lc || gapAfter.has(i))) {
          expected.push([start, lc ? i : i - 1]);
          start = lc ? -1 : -1;
          if (!lc) start = -1;
        }
      });
      if (start >= 0) expected.push([start, ss.length - 1]);
      expect(r.lcRuns).toEqual(expected);
    }
    // REF compute rows: 12 contiguous GPU racks; anonymous template gaps are not generated
    const a = rows.find((r) => r.row.id === 'pod-01-a')!;
    expect(a.slots.gaps.filter((g) => g.kind === 'gap')).toEqual([]);
    expect(a.circuits.filter((q) => q.side === 'A').length).toBeGreaterThan(0);
    expect(a.circuits.filter((q) => q.side === 'B').length).toBeGreaterThan(0);
    expect(a.leafGroups.length).toBeGreaterThan(0);
    expect(schematicRows(ref, null, hall).every((r) => r.leafGroups.length === 0)).toBe(true);

    const svg = buildDrawing(ref, refA, `schematic-${hall.id}`, { sheets: ['row-schematic'] }).svg;
    const band = /<g data-row="pod-01-a">(.*?)<\/g>/s.exec(svg)![1];
    expect([...band.matchAll(/data-pos="([A-Z]+\d+)"/g)].map((m) => m[1])).toEqual(Array.from({ length: 14 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`));
    expect(band).not.toContain('data-gap-after=');
    expect(band).toContain('data-lc-run="01-12"');
    expect(band).not.toContain('data-lc-run="01-06"');
    expect(band).not.toContain('data-lc-run="07-12"');
    expect(band).toMatch(/data-leaf-group="1"/);
    const nullSvg = buildDrawing(ref, null, `schematic-${hall.id}`, { sheets: ['row-schematic'] }).svg;
    expect(nullSvg).not.toContain('data-leaf-group');
    expect(nullSvg).toContain('Leaf-group brackets omitted');
  });

  it('601 RCU template: enclosure brackets of 2 or 4, one per meta.rcu group; breaks between enclosures', () => {
    const p = rcuProject();
    const hall = p.halls[0];
    const rows = schematicRows(p, null, hall);
    const withRcu = rows.filter((r) => r.rcu.length);
    expect(withRcu.length).toBeGreaterThan(0);
    for (const r of withRcu) {
      const groups = new Set(r.slots.slots.map((s) => s.item.rcu).filter(Boolean));
      expect(r.rcu.length).toBe(groups.size);
      for (const g of r.rcu) expect([2, 4]).toContain(g.count);
      expect(r.slots.gaps.some((g) => g.kind === 'break')).toBe(true);
    }
    const s = buildDrawing(p, null, `schematic-${hall.id}`, { sheets: ['row-schematic'] });
    expect(sheetProblems(s.svg, s.paper!)).toEqual([]);
    const counts = [...s.svg.matchAll(/data-rcu-count="(\d+)"/g)].map((m) => Number(m[1]));
    expect(counts.length).toBe(withRcu.reduce((n, r) => n + r.rcu.length, 0));
    expect(s.svg).toContain('data-break-after=');
  });
});
