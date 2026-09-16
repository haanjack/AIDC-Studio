// r4 stream B1 sheets (spec §4.4 T5 / T7): 002 site key plan, 101 plan upgrade, 111 overhead services plan, 121 enlarged DU plan,
// 611 power one-line per hall. Own file (the B0 file stays B0's); helpers from drawings-r4-helpers.ts.
import { describe, expect, it } from 'vitest';
import { annotate, buildDrawing, buildPowerPlane, buildHallPrims, emptyDrawList, listDrawings, openDrawingSet, svgStructure, viewportPaperToWorld, viewportWorldToPaper, type DrawingSheet, type Project, type ProjectAnalysis } from '../src/index.ts';
import { filterOneLine, oneLineSvg } from '../src/docs/svg/oneLine.ts';
import { hallOneLineModel } from '../src/drawings/oneLineSheet.ts';
import { enlargedWindow, formFactorOf, primRowSlots, structuralAxes } from '../src/drawings/plan.ts';
import { unsleevedCrossings } from '../src/drawings/services.ts';
import { analysisOf, emptyHallProject, podProject, rcuProject, refProject, rootPaper, sheetProblems } from './drawings-r4-helpers.ts';

const B1_KINDS = new Set(['site', 'plan', 'services-plan', 'enlarged-plan', 'one-line']);
const SHEETS = ['site', 'plan-upgrade', 'services-plan', 'enlarged-plan', 'section', 'one-line'] as const;
const NUMBER: Record<string, RegExp> = { site: /^002$/, plan: /^10\d$/, 'services-plan': /^11\d$/, 'enlarged-plan': /^121-(H\d+-)?[A-Za-z0-9-]+$/, 'one-line': /^611-H\d+$/ };
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

const ref = refProject();
const refA = analysisOf(ref);
const pod = podProject();
const podA = pod ? analysisOf(pod) : null;
interface Case {
  name: string;
  project: Project;
  analysis: ProjectAnalysis | null;
}
const CASES: Case[] = [
  { name: 'ref', project: ref, analysis: refA },
  { name: 'ref-null', project: ref, analysis: null },
  ...(pod ? [{ name: 'pod', project: pod, analysis: podA }, { name: 'pod-null', project: pod, analysis: null }] : []),
];

/** Drop texts that are (truncated) user data — project / site / hall names — before the EN Hangul check. */
function stripUserText(svg: string, p: Project): string {
  const user = [p.name, p.name.toUpperCase(), p.site.name, p.site.location, p.description ?? '', ...p.halls.map((h) => h.name)].filter(Boolean);
  const unesc = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return svg.replace(/<text[^>]*>([^<]*)<\/text>/g, (m, t: string) => {
    const v = unesc(t).replace(/…$/, '');
    return v && user.some((u) => u.startsWith(v) || u.includes(v)) ? '' : m;
  });
}

const rects = (svg: string) => [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)].map((m) => m.slice(1, 5).map(Number));

describe('r4 B1 sheets 002 / 101+ / 111 / 121 / 611 (T5)', () => {
  for (const c of CASES) {
    for (const locale of ['en', 'ko'] as const) {
      it(`${c.name} ${locale}: well-formed, text ≥ 1.8 mm, inside the content area, deterministic, paper = root size, numbering, viewports`, () => {
        const opts = { locale, sheets: [...SHEETS], date: '2026-09-15' };
        const list = listDrawings(c.project, c.analysis, opts);
        const mine = list.filter((m) => B1_KINDS.has(m.kind));
        for (const k of B1_KINDS) expect(mine.some((m) => m.kind === k), k).toBe(true);
        const set = openDrawingSet(c.project, c.analysis, opts);
        const again = openDrawingSet(c.project, c.analysis, opts);
        for (const m of mine) {
          expect(m.number, m.kind).toMatch(NUMBER[m.kind]);
          const s = set.build(m.id);
          expect(rootPaper(s.svg)).toEqual(s.paper);
          expect(sheetProblems(s.svg, s.paper!), `${c.name} ${locale} ${m.number}`).toEqual([]);
          expect(again.build(m.id).svg, `deterministic ${m.number}`).toBe(s.svg);
          if (m.kind === 'plan' || m.kind === 'services-plan' || m.kind === 'enlarged-plan') {
            expect(s.viewports?.length, m.number).toBe(1);
            expect(s.viewports![0].hallId).toBe(m.hallId);
          }
          if (locale === 'en') expect(HANGUL.test(stripUserText(s.svg, c.project)), `no Hangul on EN ${m.number}`).toBe(false);
        }
        // buildDrawing = openDrawingSet.build (one of each kind)
        for (const k of B1_KINDS) {
          const m = mine.find((x) => x.kind === k)!;
          expect(buildDrawing(c.project, c.analysis, m.id, opts).svg).toBe(set.build(m.id).svg);
        }
      });
    }
  }

  it('empty hall: 111 and the 101 upgrade build; no 121 / 611 for it', () => {
    const p = emptyHallProject();
    const list = listDrawings(p, null, { sheets: [...SHEETS] });
    expect(list.filter((m) => m.kind === 'enlarged-plan' || m.kind === 'one-line')).toEqual([]);
    for (const m of list.filter((x) => x.kind === 'services-plan' || x.kind === 'plan' || x.kind === 'site')) {
      const s = buildDrawing(p, null, m.id, { sheets: [...SHEETS] });
      expect(sheetProblems(s.svg, s.paper!), m.number).toEqual([]);
    }
  });

  it('the default plan output carries a viewport; its svg is unchanged by the upgrade hook when not requested', () => {
    const def = openDrawingSet(ref, refA, {}).build(`plan-${ref.halls[0].id}`);
    const up = openDrawingSet(ref, refA, { sheets: ['plan-upgrade'] }).build(`plan-${ref.halls[0].id}`);
    expect(def.viewports?.length).toBe(1);
    expect(up.svg.length).toBeGreaterThan(def.svg.length);
    expect(up.viewports).toEqual(def.viewports);
  });
});

// ───────────────────────────── T7 content ─────────────────────────────

const refSet = openDrawingSet(ref, refA, { sheets: [...SHEETS], date: '2026-09-15' });
const hallA = ref.halls[0];
const hpHall = buildHallPrims(ref, refA, { hallId: hallA.id, detail: 'hall' });

describe('r4 B1 101 plan upgrade (T7)', () => {
  const s = refSet.build(`plan-${hallA.id}`);
  const vp = s.viewports![0];

  it('viewport inverse map: every rack footprint of the base plan maps back to its prim within 1 mm', () => {
    const rs = rects(s.svg);
    const racks = hpHall.prims.filter((p) => p.emitter === 'rack');
    for (const p of racks.slice(0, 40)) {
      const [x0, y1] = viewportWorldToPaper(vp, p.a.x, p.a.y);
      const [x1, y0] = viewportWorldToPaper(vp, p.b.x, p.b.y);
      const hit = rs.find((r) => Math.abs(r[0] - x0) < 0.01 && Math.abs(r[1] - y0) < 0.01 && Math.abs(r[2] - (x1 - x0)) < 0.01 && Math.abs(r[3] - (y1 - y0)) < 0.01);
      expect(hit, p.id).toBeTruthy();
      const [wx, wy] = viewportPaperToWorld(vp, hit![0], hit![1] + hit![3]);
      expect(Math.abs(wx - p.a.x)).toBeLessThan(0.001 * 1000 / vp.mmPerM);
      expect(Math.abs(wy - p.a.y)).toBeLessThan(0.001 * 1000 / vp.mmPerM);
    }
  });

  it('generated rows are contiguous (…A06 | A07) and row chains sum to the hall length', () => {
    const row = primRowSlots(hpHall).find((r) => r.rowId === 'pod-01-a')!;
    expect(row.slots.gaps.filter((g) => g.kind === 'gap')).toEqual([]);
    const a06 = row.slots.slots.find((x) => x.positionTag === 'A06')!;
    const a07 = row.slots.slots.find((x) => x.positionTag === 'A07')!;
    expect(a07.item.a0).toBeCloseTo(a06.item.a1, 6);
    expect(s.svg).not.toContain(`data-row="pod-01-a" data-gap-after=`);
    const st = svgStructure(s.svg);
    for (const t of ['A01', 'A06', 'A07', 'A14', 'B14']) expect(st.tags, t).toContain(t);
    const den = Number(s.scale!.split(':')[1]);
    const ann = annotate(ref, hpHall, emptyDrawList('plan', hallA.id, { x: 0, y: 0, w: hallA.width, d: hallA.depth }), { scaleDen: den, layers: ['dimensions'], window: { x: 0, y: 0, w: hallA.width, d: hallA.depth } });
    const chain = ann.find((a) => a.kind === 'dim-chain' && a.refId === 'pod-01-a')!;
    const xs = chain.pts.filter((_, i) => i % 2 === 0);
    expect(xs[0]).toBe(0);
    expect(xs[xs.length - 1]).toBeCloseTo(hallA.width, 6);
    const sum = chain.texts!.reduce((a, t) => a + Number(t), 0);
    expect(Math.abs(sum - hallA.width)).toBeLessThanOrEqual(0.011 * chain.texts!.length);
    for (const t of chain.texts!) expect(st.dimensions, t).toContain(t);
  });

  it('planning-grid caption without aligned columns; structural axes through the aligned columns of hall B', () => {
    expect(structuralAxes(hallA).source).toBe('none');
    expect(s.svg).toContain('data-grid="planning"');
    expect(s.svg).toContain('PLANNING GRID 0.60 m — NOT STRUCTURAL');
    const hallB = ref.halls[1];
    const ax = structuralAxes(hallB);
    expect(ax.source).toBe('derived');
    expect(ax.x.map((a) => a.at)).toEqual([10.5]);
    const sb = refSet.build(`plan-${hallB.id}`).svg;
    expect(sb).toContain('data-grid="structural"');
    expect(sb).toContain('data-axis="x" data-at="10.5"');
    expect(structuralAxes({ ...hallA, structuralGrid: { x: { at: [3, 9], labels: ['A', 'B'] } } })).toMatchObject({ source: 'model', x: [{ at: 3, label: 'A' }, { at: 9, label: 'B' }] });
  });

  it('door swings, containment doors per doorType, callouts to every 121 sheet', () => {
    expect(s.svg).toMatch(/data-door="door:ko-a-door-w" data-swing="in" data-leaves="2"/);
    const conts = ref.containments.filter((x) => x.hallId === hallA.id && x.endDoors).length;
    expect((s.svg.match(/data-door-type="sliding"/g) ?? []).length).toBe(conts * 2);
    const swing = structuredClone(ref);
    swing.containments[0].doorType = 'swing-double';
    const sw = openDrawingSet(swing, null, { sheets: ['plan-upgrade'] }).build(`plan-${hallA.id}`).svg;
    expect((sw.match(/data-door-type="swing-double"/g) ?? []).length).toBe(2);
    for (const m of refSet.sheets.filter((x) => x.kind === 'enlarged-plan' && x.hallId === hallA.id)) expect(s.svg, m.number).toContain(`>${m.number}<`);
    // form factor: none known for these catalog racks → no form-factor layer; a rack with meta.rackForm gets one
    expect(s.svg).not.toContain('data-layer="form-factor"');
    expect(formFactorOf({ ...hpHall.prims.find((p) => p.emitter === 'rack')!, meta: { rackForm: 'orv3-21' } })).toBe('ORv3');
  });
});

describe('r4 B1 111 overhead services plan (T7)', () => {
  const s = refSet.build(`services-${hallA.id}`);
  const hp = buildHallPrims(ref, refA, { hallId: hallA.id, detail: 'pod' });

  it('every tap-off box is drawn once and carries one tag', () => {
    const boxes = hp.prims.filter((p) => p.emitter === 'tapoff' && p.shape === 'box');
    expect(boxes.length).toBeGreaterThan(100);
    for (const b of boxes) {
      expect(s.svg, b.id).toContain(`data-prim="${b.id}"`);
      expect((s.svg.match(new RegExp(`data-tapoff="${b.id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}"`, 'g')) ?? []).length, b.id).toBe(1);
    }
  });

  it('tray tiers use distinct line types; busway tags name side, circuits and source switchboard; racks ghosted', () => {
    const dashOf = (layer: string) => {
      const g = [...s.svg.matchAll(new RegExp(`<g data-layer="${layer}">(.*?)</g>`, 'gs'))].map((m) => m[1]).join('');
      return new Set([...g.matchAll(/stroke-dasharray="([^"]+)"/g)].map((m) => m[1]).concat(/<rect(?![^>]*stroke-dasharray)[^>]*data-prim/.test(g) ? ['solid'] : []));
    };
    const t1 = dashOf('tray-t1');
    const t2 = dashOf('tray-t2');
    expect(t1.size).toBeGreaterThan(0);
    expect(t2.size).toBeGreaterThan(0);
    expect([...t1].some((d) => t2.has(d))).toBe(false);
    expect(s.svg).toMatch(/>BW-A-DU01-A · c1–c\d · SWBD A</);
    expect(s.svg).toMatch(/>BW-B-DU01-A · c1–c\d · SWBD B</);
    expect(s.svg).toContain('fill="#dfe2e5"'); // ghost fill
    expect(s.svg).toMatch(/data-circuit="bus-A-pod-01-a\/c1"/);
  });

  it('sleeves: REF feeders all pass declared sleeves; removing the sleeves flags every crossing', () => {
    expect(unsleevedCrossings(hp, hallA)).toEqual([]);
    expect(s.svg).toContain('Every feeder crossing of the hall wall lies inside a declared sleeve.');
    const bare = { ...hp, prims: hp.prims.filter((p) => p.emitter !== 'sleeve') };
    const u = unsleevedCrossings(bare, hallA);
    expect(u.length).toBeGreaterThan(0);
    expect(new Set(u.map((x) => x.wall))).toEqual(new Set(['S', 'N']));
  });
});

describe('r4 B1 121 enlarged DU plan (T7)', () => {
  const id = `enlarged-${hallA.id}-pod-01`;
  const s = refSet.build(id);
  const hp = buildHallPrims(ref, refA, { hallId: hallA.id, detail: 'pod' });

  it('window: pod + one aisle each side + row-end doors; only this pod tagged; racks map back within 1 mm; markers → 301 / 302', () => {
    const w = enlargedWindow(hp, hallA, 'pod-01')!;
    expect(w.x).toBeLessThanOrEqual(3.9 + 1e-9);
    expect(w.x + w.w).toBeGreaterThanOrEqual(17.1 - 1e-9);
    expect(w.y).toBeLessThanOrEqual(-0.3 + 1e-9); // the aisle reaches the south wall (3.7 m) → wall slab included
    expect(w.y + w.d).toBeGreaterThan(11.0104); // the facing DU02-A front edge
    expect(s.scale).toBe('1:50');
    const st = svgStructure(s.svg);
    expect(st.tags).toContain('DU01-A-01');
    expect(st.tags.some((t) => t.startsWith('DU02'))).toBe(false);
    expect(st.tags).toContain('DU01');
    const vp = s.viewports![0];
    for (const p of hp.prims.filter((x) => x.emitter === 'rack' && x.podId === 'pod-01')) {
      const m = new RegExp(`<rect x="([\\d.]+)" y="([\\d.]+)" width="([\\d.]+)" height="([\\d.]+)"[^>]*data-prim="${p.id}"`).exec(s.svg)!;
      expect(m, p.id).toBeTruthy();
      const [wx, wy] = viewportPaperToWorld(vp, Number(m[1]), Number(m[2]) + Number(m[4]));
      expect(Math.abs(wx - p.a.x)).toBeLessThan(0.001);
      expect(Math.abs(wy - p.a.y)).toBeLessThan(0.001);
    }
    const t = refSet.sheets.find((m) => m.id === `section-t-${hallA.id}-pod-01`);
    if (t) expect(s.svg).toContain(`>${t.number}<`);
    const l = refSet.sheets.find((m) => m.id === `section-l-${hallA.id}-pod-01-a`);
    if (l) expect(s.svg).toContain(`>${l.number}<`);
    expect(st.keynotes.length).toBeGreaterThan(5);
    expect(st.dimensions.filter((x) => x === '0.60').length).toBeGreaterThanOrEqual(24); // per-rack pitch at 1:50
    expect(s.svg).not.toContain('data-gap-after="06"');
  });

  it('RCU template: one outline per meta.rcu group of the pod, each of 2 or 4 racks', () => {
    const p = rcuProject();
    const hall = p.halls[0];
    const set = openDrawingSet(p, null, { sheets: ['enlarged-plan'] });
    const hpr = buildHallPrims(p, null, { hallId: hall.id, detail: 'pod' });
    const groups = new Map<string, number>();
    for (const r of hpr.prims) if (r.emitter === 'rack' && r.podId === 'pod-01' && typeof r.meta?.rcu === 'string') groups.set(r.meta.rcu, (groups.get(r.meta.rcu) ?? 0) + 1);
    expect(groups.size).toBeGreaterThan(0);
    const sv = set.build(`enlarged-${hall.id}-pod-01`);
    expect(sheetProblems(sv.svg, sv.paper!)).toEqual([]);
    const counts = [...sv.svg.matchAll(/data-rcu="([^"]+)" data-rcu-count="(\d+)"/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(new Map(counts)).toEqual(groups);
    for (const [, n] of counts) expect([2, 4]).toContain(n);
    expect(sv.svg).toContain('data-break-after=');
  });

  it('imperial: dimension texts in ft-in; per-rack pitch texts that do not fit (0.6 m = 12 mm at 1:50) are suppressed', () => {
    const imp = { ...ref, drawingUnits: 'imperial' as const };
    const sv = openDrawingSet(imp, null, { sheets: ['enlarged-plan'] }).build(id);
    expect(sheetProblems(sv.svg, sv.paper!)).toEqual([]);
    expect(svgStructure(sv.svg).dimensions).toContain(`3'-11"`);
    expect(svgStructure(sv.svg).dimensions).not.toContain('0.60');
  });
});

describe('r4 B1 002 site key plan (T7)', () => {
  it('hall outlines at their origins, IT MW per hall, electrical rooms, inter-hall gap, tiling note per locale', () => {
    const s = refSet.build('site-key');
    for (const h of ref.halls) expect(s.svg).toContain(`data-hall="${h.id}"`);
    expect(s.svg).toContain(`>IT ${(refA.power.perHall[0].itKW / 1000).toFixed(1)} MW<`);
    expect((s.svg.match(/data-room="/g) ?? []).length).toBe(refA.power.rooms!.length);
    const gap = ref.halls[1].origin.x - (ref.halls[0].origin.x + ref.halls[0].width);
    expect(s.svg).toContain(`>${gap.toFixed(2)} m<`);
    expect(s.svg).toContain('site mode (phase 3)');
    const ko = openDrawingSet(ref, refA, { sheets: ['site'], locale: 'ko' }).build('site-key').svg;
    expect(ko).toContain('사이트 모드 (3차)');
    expect(buildDrawing(ref, null, 'site-key', { sheets: ['site'] }).svg).toContain('catalog nameplate sum');
    expect(listDrawings(ref, null, { sheets: ['site'], hallId: hallA.id })).toEqual([]);
  });
});

describe('r4 B1 611 power one-line (T7)', () => {
  it('model: every hall circuit in exactly one fold; a rack\'s A and B circuits on different UPS blocks; site nodes filtered', () => {
    const m = hallOneLineModel(ref, refA, hallA);
    expect(m.foldLevel).toBe('row');
    const ids = m.folds.flatMap((f) => f.circuitIds);
    expect(new Set(ids).size).toBe(ids.length);
    const circuits = new Set(hp().prims.filter((p) => p.emitter === 'circuit').map((p) => p.refId));
    expect(new Set(ids)).toEqual(circuits);
    const blockOf = new Map(m.folds.flatMap((f) => f.circuitIds.map((c) => [c, f.blockId] as const)));
    expect(m.blocks.map((b) => b.id)).toEqual(['ups-1', 'ups-2', 'ups-C']);
    for (const f of m.folds) expect(f.blockId === 'ups-1' || f.blockId === 'ups-2').toBe(true);
    expect(m.site.map((n) => n.kind).sort()).toEqual(['generator', 'switchgear', 'switchgear', 'transformer', 'transformer', 'utility', 'utility']);
    expect(m.switchboards.map((x) => x.side)).toEqual(['A', 'B']);
    expect(m.rows.reduce((a, r) => a + r.racks, 0)).toBeGreaterThan(100);
    // A and B cords of one rack never share a block (assignBlocks invariant, as drawn)
    for (const r of buildPowerPlane(ref, refA).racks.filter((x) => x.hallId === hallA.id)) {
      if (r.circuits.A && r.circuits.B) expect(blockOf.get(r.circuits.A), r.id).not.toBe(blockOf.get(r.circuits.B));
    }
    // fold rows fold further when the column budget is small
    expect(hallOneLineModel(ref, refA, hallA, { maxFoldsPerColumn: 12 }).foldLevel).toBe('pod');
    expect(hallOneLineModel(ref, refA, hallA, { maxFoldsPerColumn: 2 }).foldLevel).toBe('side');
    const nul = hallOneLineModel(ref, null, hallA);
    expect(nul.blocks).toEqual([]);
    expect(nul.site).toEqual([]);
    expect(nul.folds.every((f) => f.blockId === '')).toBe(true);
  });

  it('sheet: blocks, folds with loading %, cords table, ratings and "breaker settings not modelled"; null analysis note', () => {
    const s = refSet.build(`one-line-${hallA.id}`).svg;
    expect(s).toContain('data-block="ups-1"');
    expect(s).toMatch(/data-fold="ups-1\|A\|pod-01-a"/);
    expect(s).toMatch(/>\d+ %</);
    expect(s).toContain('Breaker settings, selectivity, cable sizes and short-circuit ratings are not modelled.');
    expect(s).toMatch(/Ratings: busway \d+ A @ 415 V/);
    expect((s.match(/data-cord-row="/g) ?? []).length).toBe(hallOneLineModel(ref, refA, hallA).rows.length);
    const n = buildDrawing(ref, null, `one-line-${hallA.id}`, { sheets: ['one-line'] }).svg;
    expect(n).toContain('No analysis cached');
    expect(n).not.toContain('data-block="ups-');
  });

  it('filterOneLine keeps the hall loads and their ancestors; oneLineSvg default output is unchanged by the option', () => {
    const ol = refA.power.oneLine;
    const hallEq = new Set(ref.equipment.filter((e) => e.hallId === hallA.id).map((e) => e.id));
    const f = filterOneLine(ol, { equipmentIds: hallEq });
    expect(f.nodes.some((x) => x.kind === 'mech')).toBe(false);
    expect(f.nodes.filter((x) => x.kind === 'load').length).toBe(ol.nodes.filter((x) => x.kind === 'load').length);
    expect(f.nodes.some((x) => x.kind === 'ups')).toBe(true);
    expect(filterOneLine(ol, { equipmentIds: new Set() }).nodes).toEqual([]);
    expect(oneLineSvg(ol, { locale: 'en' })).toBe(oneLineSvg(ol, { locale: 'en', filter: undefined }));
  });
});

let hpPod: ReturnType<typeof buildHallPrims> | null = null;
function hp() {
  hpPod ??= buildHallPrims(ref, refA, { hallId: hallA.id, detail: 'pod' });
  return hpPod;
}
void (null as unknown as DrawingSheet);
