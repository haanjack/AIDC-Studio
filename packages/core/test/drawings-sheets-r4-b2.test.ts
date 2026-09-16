// r4 sheets (spec §4.4 T5 / T7) — stream B2 cases: 301 / 302 sections, 311 aisle-end elevation, 411 MEP piping iso.
import { describe, expect, it } from 'vitest';
import {
  buildDrawing,
  buildHallPipes,
  buildHallPrims,
  datumLabel,
  detectRowGroups,
  findCatalogItem,
  fmtLength,
  frameBox,
  listDrawings,
  openDrawingSet,
  primAabb,
  svgStructure,
  viewportPaperToWorld,
  type DrawingOptions,
  type Project,
  type ProjectAnalysis,
} from '../src/index.ts';
import { analysisOf, emptyHallProject, podProject, rcuProject, refProject, rootPaper, sheetProblems } from './drawings-r4-helpers.ts';

const SHEETS: DrawingOptions['sheets'] = ['index', 'section', 'elevation', 'mep-iso'];
const B2 = new Set(['section', 'elevation', 'mep-iso']);
const NUMBER: Record<string, RegExp> = { section: /^30[12]-H\d+-[TL]\d{2}$/, elevation: /^311-H\d+-C\d+$/, 'mep-iso': /^411-(H\d+-)?[A-Z0-9-]+$/ };

const ref = refProject();
const pod = podProject();
const hall = ref.halls[0];
const layerTexts = (svg: string, layer: string) => [...svg.matchAll(new RegExp(`<g data-layer="${layer}">(.*?)</g>`, 'gs'))].flatMap((m) => [...m[1].matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((t) => t[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')));

describe('r4 B2 sheets 301 / 302 / 311 / 411 (T5)', () => {
  const cases: { name: string; project: Project; analysis: ProjectAnalysis | null; locales: ('en' | 'ko')[] }[] = [
    { name: 'ref', project: ref, analysis: null, locales: ['en', 'ko'] },
    { name: 'ref+analysis', project: ref, analysis: analysisOf(ref), locales: ['en'] },
    ...(pod ? [{ name: 'pod', project: pod, analysis: null, locales: ['en', 'ko'] as ('en' | 'ko')[] }] : []),
  ];
  for (const c of cases) {
    for (const locale of c.locales) {
      it(`${c.name} ${locale}: well-formed, text ≥ 1.8 mm, inside the content area, deterministic, paper = root size, numbering, viewports`, () => {
        const opts: DrawingOptions = { locale, sheets: SHEETS, date: '2026-09-15' };
        const mine = listDrawings(c.project, c.analysis, opts).filter((m) => B2.has(m.kind));
        for (const pre of ['301-', '302-', '311-', '411-']) expect(mine.some((m) => m.number.startsWith(pre)), pre).toBe(true);
        const a = openDrawingSet(c.project, c.analysis, opts);
        const b = openDrawingSet(c.project, c.analysis, opts);
        const firstOfKind = new Set<string>();
        for (const m of mine) {
          expect(m.number).toMatch(NUMBER[m.kind]);
          expect(m.paper).toEqual({ w: 841, h: 594 });
          const t0 = performance.now();
          const s = a.build(m.id);
          expect(performance.now() - t0, `${m.number} build time`).toBeLessThan(1000);
          expect(rootPaper(s.svg)).toEqual(s.paper);
          expect(sheetProblems(s.svg, s.paper!), `${c.name} ${locale} ${m.number}`).toEqual([]);
          expect(b.build(m.id).svg).toBe(s.svg);
          if (m.kind === 'mep-iso') {
            expect(s.scale).toBe('NTS');
            expect(s.viewports).toBeUndefined();
          } else {
            expect(s.scale).toBe(m.kind === 'section' ? '1:50' : '1:25');
            expect(s.viewports?.length).toBeGreaterThan(0);
            const vp = s.viewports![0];
            expect(vp.space).toBe(m.kind);
            expect(vp.mmPerM).toBe(m.kind === 'section' ? 20 : 40);
            expect(vp.cut).toBeDefined();
            if (m.kind === 'elevation') expect(vp.elevation?.kind).toBe('aisle-end');
          }
          if (!firstOfKind.has(m.number.slice(0, 3))) {
            firstOfKind.add(m.number.slice(0, 3));
            expect(buildDrawing(c.project, c.analysis, m.id, opts).svg).toBe(s.svg);
          }
        }
      });
    }
  }

  it('empty hall: no 301 / 302 / 311 / 411 are listed', () => {
    expect(listDrawings(emptyHallProject(), null, { sheets: ['section', 'elevation', 'mep-iso'] })).toEqual([]);
  });
});

describe('r4 B2 content (T7)', () => {
  const hp = buildHallPrims(ref, null, { hallId: hall.id, detail: 'pod' });

  it('301: datum column = hall datums; main 1:50 + service-stack detail; rack corners inverse-map to the prim within 1 mm', () => {
    const s = buildDrawing(ref, null, `section-t-${hall.id}-pod-01`, { sheets: ['section'] });
    const datums = svgStructure(s.svg).datums.join(' | ');
    for (const d of hp.datums) expect(datums, d.id).toContain(datumLabel(d.id, 'en', d.label));
    expect(s.viewports!.length).toBe(2);
    expect(s.viewports![1].mmPerM).toBeGreaterThanOrEqual(40);
    const vp = s.viewports![0];
    const cut = vp.cut!;
    expect(cut.axis).toBe('x');
    // first rack rect of the main viewport
    const m = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"[^>]*data-prim="(rack:[^"]+)"/.exec(s.svg)!;
    const [px, py, pw, ph] = [1, 2, 3, 4].map((i) => Number(m[i]));
    const prim = hp.prims.find((p) => p.id === m[5])!;
    const fb = frameBox(cut, primAabb(prim));
    const [u0, z0] = viewportPaperToWorld(vp, px, py + ph);
    const [u1, z1] = viewportPaperToWorld(vp, px + pw, py);
    expect(Math.abs(u0 - fb.u0)).toBeLessThan(1e-3);
    expect(Math.abs(u1 - fb.u1)).toBeLessThan(1e-3);
    expect(Math.abs(z0 - fb.z0)).toBeLessThan(1e-3);
    expect(Math.abs(z1 - fb.z1)).toBeLessThan(1e-3);
  });

  it('301: clearance pairs pass on REF and turn red on a breach (services → ceiling)', () => {
    const ok = buildDrawing(ref, null, `section-t-${hall.id}-pod-01`, { sheets: ['section'] }).svg;
    expect(ok).toContain('data-layer="clearances"');
    expect(ok).toMatch(/data-rule="services-ceiling" data-status="ok"/);
    expect(ok).not.toContain('data-status="breach"');
    const low = refProject();
    low.halls[0].clearHeight = 3.2; // top of the cut services 3.035 → 0.165 < 0.30
    const bad = buildDrawing(low, null, `section-t-${hall.id}-pod-01`, { sheets: ['section'] }).svg;
    expect(bad).toMatch(/data-rule="services-ceiling" data-status="breach"/);
    expect(bad).toContain('#c62828');
  });

  it('302: plane along the row centre looking at the rear, contiguous position tags; POD is windowed with break lines', () => {
    const row = detectRowGroups(ref, hall).find((r) => r.id === 'pod-01-a')!;
    const s = buildDrawing(ref, null, `section-l-${hall.id}-pod-01-a`, { sheets: ['section'] });
    const cut = s.viewports![0].cut!;
    expect(cut.axis).toBe('y');
    expect(cut.at).toBeCloseTo(row.center, 6);
    expect(cut.look).toBe(row.frontSign > 0 ? -1 : 1);
    const racks = ref.equipment.filter((e) => e.rowId === row.id && ['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack'].includes(findCatalogItem(e.catalogId)!.category)).sort((a, b) => a.position.x - b.position.x);
    const tags = svgStructure(s.svg).tags;
    racks.forEach((_, i) => expect(tags, `A${String(i + 1).padStart(2, '0')}`).toContain(`A${String(i + 1).padStart(2, '0')}`));
    let gap = 0;
    for (let i = 1; i < racks.length; i++) gap = Math.max(gap, racks[i].position.x - racks[i - 1].position.x - 0.6);
    expect(gap).toBeLessThan(1e-6);
    expect(s.svg).not.toContain('data-gap-after=');
    expect(s.svg).not.toContain('data-break=');
    if (pod) {
      const ps = buildDrawing(pod, null, `section-l-${pod.halls[0].id}-pod-ref-a`, { sheets: ['section'] }).svg;
      expect(ps).toContain('data-break="left"');
      expect(ps).toContain('data-break="right"');
    }
  });

  it('311: datums include containment height and every tier; cumulative heights from FFL; door symbol per doorType; open to beyond', () => {
    const s = buildDrawing(ref, null, `aisle-end-${hall.id}-1`, { sheets: ['elevation'] });
    const st = svgStructure(s.svg);
    const datums = st.datums.join(' | ');
    for (const id of ['containment', 'pipe', 'busway', 'T1', 'T2', 'T3']) expect(datums, id).toContain(datumLabel(id, 'en'));
    for (const z of [2.2, 2.3, 2.52, 2.68, 2.9, 3.25, 3.6]) expect(st.dimensions, String(z)).toContain(fmtLength(z, 'metric', 25));
    expect(s.svg).toContain('data-door-type="sliding"');
    expect(s.svg).toContain('data-open-beyond=');
    expect(s.svg).toContain('(OPEN');

    const swing = refProject();
    swing.containments = swing.containments.map((c, i) => (i === 0 ? { ...c, doorType: 'swing-double' as const } : c));
    const list = listDrawings(swing, null, { sheets: ['elevation'] });
    expect(list.map((m) => m.number)).toEqual(['311-H1-C1', '311-H1-C2']);
    const types = list.map((m) => /data-door-type="([^"]+)"/.exec(buildDrawing(swing, null, m.id, { sheets: ['elevation'] }).svg)![1]).sort();
    expect(types).toEqual(['sliding', 'swing-double']);
  });

  it('311 imperial (POD): every height from FFL in ft-in at ½", EN / KO labels', () => {
    if (!pod) return;
    const imp: Project = { ...pod, drawingUnits: 'imperial' };
    const s = buildDrawing(imp, null, `aisle-end-${pod.halls[0].id}-1`, { sheets: ['elevation'] });
    const dims = svgStructure(s.svg).dimensions;
    expect(dims.length).toBeGreaterThan(3);
    for (const d of dims) expect(d).toMatch(/^\d+'-\d+( \d\/\d)?"$/);
    expect(dims).toContain(`7'-6 1/2"`); // containment 2.30 m
    expect(svgStructure(s.svg).datums.some((d) => /^\+\d+'-/.test(d))).toBe(true);
    const ko = buildDrawing({ ...imp, locale: 'ko' }, null, `aisle-end-${pod.halls[0].id}-1`, { sheets: ['elevation'], locale: 'ko' }).svg;
    expect(ko).toContain(datumLabel('containment', 'ko'));
    expect(ko).toContain('(뒤쪽');
  });

  it('411: one EPIV symbol per liquid rack of the DU, every derived run drawn, (TYP.) leaders, sizes marked estimate; POD without CDU says so; RCU loops', () => {
    const net = buildHallPipes(ref, hall, hp.rows);
    const s = buildDrawing(ref, null, `mep-iso-${hall.id}-pod-01`, { sheets: ['mep-iso'] }).svg;
    const podRuns = net.runs.filter((r) => r.podId === 'pod-01' && r.kind !== 'riser');
    const cdus = new Set(podRuns.flatMap((r) => r.cduIds));
    const runs = [...podRuns, ...net.runs.filter((r) => r.kind === 'riser' && r.cduIds.some((id) => cdus.has(id)))];
    expect([...s.matchAll(/data-run="/g)].length).toBe(runs.length);
    const liquid = ref.equipment.filter((e) => e.podId === 'pod-01' && (findCatalogItem(e.catalogId)?.cooling?.liquidFraction ?? 0) > 0 && e.rowId);
    expect([...s.matchAll(/data-fitting="epiv"/g)].length).toBe(liquid.length);
    expect(s).toContain('(TYP.)');
    expect(s).toContain('(EST.)');
    expect(s).toContain('data-schedule-row=');
    expect(layerTexts(s, 'notes').some((t) => /DN\d+ \(EST\.\)/.test(t))).toBe(true);
    expect(buildDrawing(ref, null, `mep-iso-${hall.id}-pod-01`, { sheets: ['mep-iso'], locale: 'ko' }).svg).toContain('(추정)');
    if (pod) expect(buildDrawing(pod, null, `mep-iso-${pod.halls[0].id}-pod-ref`, { sheets: ['mep-iso'] }).svg).toContain('No CDU serves this DU');
    const rcu = rcuProject();
    expect(buildDrawing(rcu, null, `mep-iso-${rcu.halls[0].id}-pod-01`, { sheets: ['mep-iso'] }).svg).toContain('LOOP ISOLATION VALVE (TYP.)');
  });
});
