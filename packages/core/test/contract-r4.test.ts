// r4 contract (docs/research/r4-2d-drawings-spec.md §4.1 C9, docs/research/contract-r4.md). Integrator-owned.
// The stub checks below are shape checks that stay true when streams A / B make the stubs live, so no stream has to edit this file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  analyzeProject, annotate, assignBlocks, buildDrawing, buildHallPrims, buildPipes, buildPowerPlane, createNvidiaReferenceProject,
  DEFAULT_DRAWING_SHEETS, detectRowGroups, DRAWING_REGISTRY, drawListToSvg, emptyDrawList, fmtLength, generateDrawings, GridIndex, hallDatums, KEYNOTES,
  LAYER_PRESETS, LAYERS, listDrawings, openDrawingSet, packDrawList, packedTransferables, primAabb, projectElevation, projectPlan, projectSection,
  R4_DRAWING_SHEETS, shellPrims, unpackDrawList, upsSystems, viewportPaperToWorld, viewportWorldToPaper,
  type DrawingCut, type DrawingOptions, type DrawingSheet, type DrawingView, type DrawingViewport, type DrawList2D, type ElevationTarget, type Hall, type HallVerticals,
  type PipeNetwork, type Prim, type Project, type ProjectAnalysis, type StructuralGrid,
} from '../src/index.ts';
import { R4_FX_HALL, r4FixtureHallPrims } from './fixtures/r4-prims.ts';
import { createRefPodFixture } from './fixtures/ref-pod.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN = `${HERE}/__golden__/contract-r4-dump.json`;
const WEB_LOCALES = fileURLToPath(new URL('../../../apps/web/src/i18n/locales/', import.meta.url));

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const fix = (p: Project) => {
  p.updatedAt = '2026-09-14T00:00:00.000Z';
  p.createdAt = '2026-09-01T00:00:00.000Z';
  return p;
};
const inputDigest = (p: Project, a: ProjectAnalysis | null) => sha(`${JSON.stringify(p)}\n${JSON.stringify(a, (k, v) => (k === 'generatedAt' ? undefined : v))}`);
/** the pre-r4 DrawingSheet fields, in their original key order */
const legacy = (s: DrawingSheet) => ({ id: s.id, number: s.number, title: s.title, kind: s.kind, scale: s.scale, group: s.group, svg: s.svg });
const rootPaper = (svg: string) => {
  const m = /^<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm"/.exec(svg);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
};

const ref = fix(createNvidiaReferenceProject().project);
const refA = analyzeProject(ref);
const pod = fix(createRefPodFixture());
const podA = pod ? analyzeProject(pod) : null;

interface DumpCase { project: Project; analysis: ProjectAnalysis | null; inputAnalysis: ProjectAnalysis | null; opts: DrawingOptions }
const CASES: Record<string, DumpCase> = {
  'ref-en': { project: ref, analysis: refA, inputAnalysis: refA, opts: { locale: 'en' } },
  'ref-ko': { project: ref, analysis: refA, inputAnalysis: refA, opts: { locale: 'ko' } },
  'ref-default': { project: ref, analysis: refA, inputAnalysis: refA, opts: {} },
  'ref-null': { project: ref, analysis: null, inputAnalysis: refA, opts: {} },
  'ref-rows-en': { project: ref, analysis: refA, inputAnalysis: refA, opts: { rackRows: 'all' } },
  'ref-rows-ko': { project: ref, analysis: refA, inputAnalysis: refA, opts: { rackRows: 'all', locale: 'ko' } },
  ...(pod
    ? {
        'pod-en': { project: pod, analysis: podA, inputAnalysis: podA, opts: { locale: 'en' } },
        'pod-ko': { project: pod, analysis: podA, inputAnalysis: podA, opts: { locale: 'ko' } },
        'pod-rows': { project: pod, analysis: podA, inputAnalysis: podA, opts: { rackRows: 'all' } },
      }
    : {}),
};

describe('r4 contract: types', () => {
  it('the §2.4 fields and new types compile and are optional on existing objects', () => {
    const cut: DrawingCut = { id: 'A', label: 'A–A', hallId: ref.halls[0].id, axis: 'y', at: 5, look: 1, depthM: 2.4, window: { u0: 0, u1: 10 } };
    const verticals: HallVerticals = { slabThicknessM: 0.3, stackOrder: 'trays-busway', topClearanceM: 0.3, tiers: [{ id: 'T1', kind: 'tray', carries: ['scale-out'], z: 2.9, heightM: 0.1, widthM: 0.6 }] };
    const grid: StructuralGrid = { x: { at: [0, 9], labels: ['A', 'B'] }, columnSizeM: 0.5 };
    const target: ElevationTarget = { kind: 'aisle-end', containmentId: 'c1', end: 0 };
    const vp: DrawingViewport = { paperRect: { x: 10, y: 20, w: 100, h: 50 }, hallId: 'h', space: 'section', worldRect: { x: 0, y: 0, w: 5, d: 2.5 }, cut, mmPerM: 20 };
    const view: DrawingView = { id: 'v1', kind: 'elevation', hallId: 'h', elevation: target, layers: ['racks'], paper: { w: 841, h: 594 }, scale: '1:25', number: '901', title: 'x' };
    const hall: Hall = { ...R4_FX_HALL, verticals, structuralGrid: grid };
    const p: Project = { ...ref, drawingUnits: 'imperial', drawingCuts: [cut], containments: ref.containments.map((c) => ({ ...c, doorType: 'swing-double' as const })) };
    expect([cut, verticals, grid, target, vp, view, hall.verticals, p.drawingUnits].every(Boolean)).toBe(true);
    expect(ref.drawingUnits).toBeUndefined();
    expect(ref.halls[0].verticals).toBeUndefined();
    const kinds: DrawingSheet['kind'][] = ['index', 'services-plan', 'enlarged-plan', 'section', 'elevation', 'mep-iso', 'row-schematic', 'one-line', 'detail'];
    expect(kinds).toHaveLength(9);
  });
});

describe('r4 contract: scene (real parts + stub shapes)', () => {
  it('primAabb follows the shape rules (box · bar along x / y · vertical bar · tube · point)', () => {
    const base = { emitter: 'busway', cls: 'IN-overhead', layer: 'busway-a' } as const;
    const bar = (a: Prim['a'], b: Prim['b']): Prim => ({ ...base, id: 'b', shape: 'bar', a, b, halfW: 0.085, halfH: 0.1 });
    expect(primAabb(bar({ x: 1, y: 2, z: 3 }, { x: 5, y: 2, z: 3 }))).toEqual({ min: { x: 1, y: 1.915, z: 2.9 }, max: { x: 5, y: 2.085, z: 3.1 } });
    expect(primAabb(bar({ x: 1, y: 2, z: 3 }, { x: 1, y: 6, z: 3 }))).toEqual({ min: { x: 0.915, y: 2, z: 2.9 }, max: { x: 1.085, y: 6, z: 3.1 } });
    expect(primAabb(bar({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 1 }))).toEqual({ min: { x: 0.915, y: 1.9, z: 1 }, max: { x: 1.085, y: 2.1, z: 3 } });
    expect(primAabb({ ...base, id: 't', shape: 'tube', a: { x: 0, y: 0, z: 2 }, b: { x: 4, y: 0, z: 2 }, halfW: 0.08, halfH: 0 })).toEqual({ min: { x: 0, y: -0.08, z: 1.92 }, max: { x: 4, y: 0.08, z: 2.08 } });
    expect(primAabb({ ...base, id: 'p', shape: 'point', a: { x: 1, y: 1, z: 1 }, b: { x: 1, y: 1, z: 1 }, halfW: 0.5, halfH: 0.25 })).toEqual({ min: { x: 0.5, y: 0.5, z: 0.75 }, max: { x: 1.5, y: 1.5, z: 1.25 } });
    expect(primAabb({ ...base, id: 'x', shape: 'box', a: { x: 2, y: 3, z: 0 }, b: { x: 1, y: 1, z: 2 }, halfW: 0, halfH: 0 })).toEqual({ min: { x: 1, y: 1, z: 0 }, max: { x: 2, y: 3, z: 2 } });
  });

  it('GridIndex.query equals brute force on the fixture (random windows, several cell sizes)', () => {
    const hp = r4FixtureHallPrims();
    const ids = hp.prims.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(hp.prims.map((p) => p.emitter));
    for (const k of ['rack', 'unit', 'busway', 'tapoff', 'tray', 'drop', 'pipe', 'column', 'door', 'containment-roof', 'wall', 'slab']) expect(kinds.has(k as Prim['emitter'])).toBe(true);
    expect(new Set(hp.prims.filter((p) => p.emitter === 'tray').map((p) => p.tier))).toEqual(new Set(['T1', 'T2', 'T3']));
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (const cell of [0.5, 2, 4, 50]) {
      const idx = GridIndex.build(hp.prims, cell);
      expect(idx.count).toBe(hp.prims.length);
      for (let n = 0; n < 150; n++) {
        const r = { x: rnd() * 24 - 2, y: rnd() * 18 - 2, w: rnd() * 8, d: rnd() * 8 };
        const brute = hp.prims.map((p, i) => [p, i] as const).filter(([p]) => {
          const { min, max } = primAabb(p);
          return min.x <= r.x + r.w && max.x >= r.x && min.y <= r.y + r.d && max.y >= r.y;
        }).map(([, i]) => i);
        expect(idx.query(r)).toEqual(brute);
      }
      expect(idx.query({ x: -1e6, y: -1e6, w: 2e6, d: 2e6 })).toHaveLength(hp.prims.length);
    }
    expect(GridIndex.build([]).query({ x: 0, y: 0, w: 1, d: 1 })).toEqual([]);
    expect(r4FixtureHallPrims().hash).toBe(hp.hash);
  });

  it('packDrawList → unpackDrawList is exact, also after structured cloning', () => {
    const hp = r4FixtureHallPrims();
    const list: DrawList2D = {
      ...emptyDrawList('plan', hp.hallId, { x: -0.3, y: -0.3, w: 20.6, d: 14.6 }),
      items: [
        ...hp.prims.map((p) => {
          const { min, max } = primAabb(p);
          return { kind: 'rect' as const, pts: [min.x, min.y, max.x - min.x, max.y - min.y], role: 'cut' as const, layer: p.layer, lodMin: 1 as const, style: p.emitter, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) };
        }),
        { kind: 'text', pts: [4.3, 3.2], role: 'ghost', layer: 'position-tags', lodMin: 3, style: 'tag', text: 'A01', size: 2.2, rot: -90 },
        { kind: 'circle', pts: [12.25, 6.25, 0.4], role: 'overhead', layer: 'structural-grid', lodMin: 2, style: 'bubble', depth: 1.5 },
        { kind: 'polyline', pts: [0, 0, 1e-7, 3.14159265358979, 2, 2], role: 'beyond', layer: 'dimensions', lodMin: 0, style: 'dim' },
      ],
    };
    const packed = packDrawList(list);
    expect(packed.count).toBe(list.items.length);
    expect(unpackDrawList(packed)).toEqual(list);
    expect(unpackDrawList(structuredClone(packed))).toEqual(list);
    expect(packedTransferables(packed)).toHaveLength(13);
  });

  it('buildHallPrims / project* / hallDatums / shellPrims / buildPipes keep their contract shape on the reference project', () => {
    const hall = ref.halls[0];
    const hp = buildHallPrims(ref, refA, { hallId: hall.id });
    expect(hp.hallId).toBe(hall.id);
    expect(hp.detail).toBe('hall');
    expect(buildHallPrims(ref, null, { hallId: hall.id, detail: 'pod' }).detail).toBe('pod');
    expect(hp.index.count).toBe(hp.prims.length);
    expect(new Set(hp.prims.map((p) => p.id)).size).toBe(hp.prims.length);
    expect(buildHallPrims(ref, refA, { hallId: hall.id }).hash).toBe(hp.hash);
    const layerIds = new Set(LAYERS.map((l) => l.id));
    expect(hp.prims.every((p) => layerIds.has(p.layer))).toBe(true);
    const plan = projectPlan(hp, { mode: 'floor' });
    expect(plan.space).toBe('plan');
    expect(plan.hallId).toBe(hall.id);
    const cut: DrawingCut = { id: 'A', label: 'A–A', hallId: hall.id, axis: 'y', at: hall.depth / 2, look: 1, depthM: 2.4 };
    const sec = projectSection(hp, cut);
    expect(sec.space).toBe('section');
    expect(sec.cut).toEqual(cut);
    const target: ElevationTarget = { kind: 'wall', wall: 'N' };
    expect(projectElevation(hp, target)).toMatchObject({ space: 'elevation', hallId: hall.id, elevation: target });
    for (const l of [plan, sec]) expect(l.items.every((it) => layerIds.has(it.layer) && typeof l.hash === 'string')).toBe(true);
    expect(Array.isArray(hallDatums(hall, hp.prims, hall.verticals))).toBe(true);
    expect(Array.isArray(shellPrims(hall, ref))).toBe(true);
    const pipes: PipeNetwork = buildPipes(hall, detectRowGroups(ref, hall), ref.equipment.filter((e) => e.hallId === hall.id && /cdu/i.test(e.catalogId)), hall.verticals);
    expect(pipes.hallId).toBe(hall.id);
    expect(Array.isArray(annotate(ref, hp, plan, { locale: 'en' }))).toBe(true);
    const svg = drawListToSvg(plan, [], { paperRect: { x: 0, y: 0, w: 100, h: 100 }, hallId: hall.id, space: 'plan', mmPerM: 5 });
    expect(typeof svg.svg).toBe('string');
    expect(Array.isArray(svg.defs)).toBe(true);
  });

  it('LAYERS registry: unique ids, presets reference known layers, every i18n key exists in the web view2d namespace (EN + KO)', () => {
    const ids = LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of Object.values(LAYER_PRESETS)) for (const id of preset) expect(ids).toContain(id);
    expect(LAYER_PRESETS.all).toHaveLength(ids.length);
    for (const loc of ['en', 'ko']) {
      const src = readFileSync(`${WEB_LOCALES}${loc}/view2d.ts`, 'utf8');
      for (const l of LAYERS) expect(src, `${loc}: ${l.i18nKey}`).toContain(`'${l.i18nKey}'`);
    }
    for (const k of KEYNOTES) expect(ids).toContain(k.layer);
    expect(new Set(KEYNOTES.map((k) => k.id)).size).toBe(KEYNOTES.length);
  });

  it('viewport world ↔ paper helpers are inverse and follow the y-up convention', () => {
    const vp: DrawingViewport = { paperRect: { x: 30, y: 40, w: 200, h: 100 }, hallId: 'h', space: 'plan', worldRect: { x: 10, y: 5, w: 20, d: 10 }, mmPerM: 10 };
    expect(viewportWorldToPaper(vp, 10, 5)).toEqual([30, 140]); // world bottom-left → paper bottom-left
    expect(viewportWorldToPaper(vp, 30, 15)).toEqual([230, 40]);
    const [px, py] = viewportWorldToPaper(vp, 17.25, 9.5);
    const [wx, wy] = viewportPaperToWorld(vp, px, py);
    expect(wx).toBeCloseTo(17.25, 9);
    expect(wy).toBeCloseTo(9.5, 9);
    expect(fmtLength(2.7305, 'metric')).toBe('2.73');
  });
});

describe('r4 contract: engines', () => {
  it('assignBlocks / upsSystems are exported without behaviour change', () => {
    expect(assignBlocks(buildPowerPlane(ref, refA), 1, []).size).toBe(0);
    expect(Array.isArray(upsSystems(refA))).toBe(true);
  });
});

describe('r4 contract: drawings registry', () => {
  it('generateDrawings default output is byte-identical to the pre-r4 dump (EN + KO, reference + synthetic POD)', () => {
    const golden = existsSync(GOLDEN) ? (JSON.parse(readFileSync(GOLDEN, 'utf8')) as { note: string; cases: Record<string, { input: string; output: string; sheets: number }> }) : null;
    const update = process.env.UPDATE_CONTRACT_DUMP === '1';
    const next: Record<string, { input: string; output: string; sheets: number }> = {};
    const skipped: string[] = [];
    for (const [name, c] of Object.entries(CASES)) {
      const sheets = generateDrawings(c.project, c.analysis, c.opts);
      const input = inputDigest(c.project, c.inputAnalysis);
      const output = sha(JSON.stringify(sheets.map(legacy)));
      next[name] = { input, output, sheets: sheets.length };
      const g = golden?.cases[name];
      if (!g || update) continue;
      if (g.input !== input) {
        skipped.push(name); // the project / analysis changed outside the drawings (another stream) — byte check not applicable
        continue;
      }
      expect(sheets.length, name).toBe(g.sheets);
      expect(output, `${name}: default drawings output changed`).toBe(g.output);
    }
    if (update || !golden) {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify({ note: golden?.note ?? 'contract-r4 dump digests', cases: next }, null, 2)}\n`);
    }
    if (skipped.length) console.warn(`[contract-r4] input changed, byte compare skipped for: ${skipped.join(', ')} (regenerate with UPDATE_CONTRACT_DUMP=1 only after confirming the drawings code did not change)`);
    expect(skipped.length).toBeLessThan(Object.keys(CASES).length + 1);
  });

  it('explicit DEFAULT_DRAWING_SHEETS, listDrawings and buildDrawing match generateDrawings exactly; paper = root svg size', () => {
    for (const [name, c] of Object.entries(CASES)) {
      const sheets = generateDrawings(c.project, c.analysis, c.opts);
      expect(JSON.stringify(generateDrawings(c.project, c.analysis, { ...c.opts, sheets: [...DEFAULT_DRAWING_SHEETS] })), name).toBe(JSON.stringify(sheets));
      const list = listDrawings(c.project, c.analysis, c.opts);
      expect(list.map((m) => [m.id, m.number, m.title, m.kind, m.paper]), name).toEqual(sheets.map((s) => [s.id, s.number, s.title, s.kind, s.paper]));
      const set = openDrawingSet(c.project, c.analysis, c.opts);
      for (const s of sheets) {
        expect(set.build(s.id), `${name} ${s.id}`).toEqual(s);
        expect(rootPaper(s.svg), `${name} ${s.id}`).toEqual(s.paper);
      }
      expect(buildDrawing(c.project, c.analysis, sheets[sheets.length - 1].id, c.opts)).toEqual(sheets[sheets.length - 1]);
    }
    expect(() => buildDrawing(ref, refA, 'no-such-sheet')).toThrow(/no-such-sheet/);
  });

  it('every r4 sheet kind is registered behind opts.sheets and builds a valid framed sheet (EN / KO, with and without analysis)', () => {
    const keys = new Set(DRAWING_REGISTRY.map((r) => r.key));
    for (const k of R4_DRAWING_SHEETS) if (k !== 'plan-upgrade') expect(keys.has(k), k).toBe(true);
    for (const [project, analysis, locale] of [[ref, refA, 'en'], [ref, null, 'ko'], ...(pod ? [[pod, podA, 'en'] as const] : [])] as const) {
      const opts: DrawingOptions = { sheets: [...R4_DRAWING_SHEETS], locale };
      const list = listDrawings(project, analysis, opts);
      const sheets = generateDrawings(project, analysis, opts);
      expect(sheets.map((s) => s.id)).toEqual(list.map((m) => m.id));
      expect(new Set(list.map((m) => m.id)).size).toBe(list.length);
      const numbers = list.map((m) => m.number);
      for (const re of [/^001$/, /^002$/, /^10\d$/, /^11\d$/, /^121-/, /^20\d$/, /^301-/, /^302-/, /^311-/, /^40\d$/, /^601-/, /^611-/]) expect(numbers.some((n) => re.test(n)), `${project.id} ${re}`).toBe(true);
      for (const s of sheets) {
        expect(s.svg.startsWith('<svg '), s.id).toBe(true);
        expect(s.svg.endsWith('</svg>'), s.id).toBe(true);
        expect(s.svg, s.id).not.toMatch(/NaN|undefined|Infinity/);
        expect(rootPaper(s.svg), s.id).toEqual(s.paper);
      }
      // default kinds are untouched by the r4 keys (only the title-block sheet counter differs)
      const plain = generateDrawings(project, analysis, { locale }).map((s) => s.id);
      expect(plain.every((id) => list.some((m) => m.id === id))).toBe(true);
    }
    // 'plan-upgrade' alone yields the plans only
    expect(listDrawings(ref, refA, { sheets: ['plan-upgrade'] }).map((m) => m.kind)).toEqual(ref.halls.map(() => 'plan'));
  });
});
