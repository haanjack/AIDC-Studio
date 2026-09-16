// r4 structural goldens (spec §4.4 T6) — not bytes: number, kind, paper, scale, element count per data-layer, sorted tag set,
// dimension texts, datum labels, keynote ids (+ 601 position sequence). Stream B0 owns this file and __golden__/drawings/**.
//
// Regenerate: UPDATE_GOLDEN=1 npx vitest run packages/core/test/drawings-golden.test.ts   (review the JSON diff in the PR)
// Model-based cases carry an input digest: when another workflow changed the reference project / analysis, the structure compare
// for that case is skipped with a warning instead of failing (fixture cases are always strict).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { annotate, buildDrawing, drawListToSvg, fitViewport, svgStructure, type DrawingOptions, type Project, type ProjectAnalysis } from '../src/index.ts';
import { r4FixtureHallPrims } from './fixtures/r4-prims.ts';
import { analysisOf, fixturePlanList, fixtureProject, fixtureSectionList, inputDigest, podProject, refProject } from './drawings-r4-helpers.ts';

const DIR = `${dirname(fileURLToPath(import.meta.url))}/__golden__/drawings`;
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface Golden {
  input: string | null;
  structure: unknown;
}

function compare(name: string, input: string | null, structure: unknown) {
  const file = `${DIR}/${name}.json`;
  if (UPDATE || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ input, structure } satisfies Golden, null, 2)}\n`);
    if (!UPDATE) console.warn(`[drawings-golden] wrote missing golden ${name}.json`);
    return;
  }
  const g = JSON.parse(readFileSync(file, 'utf8')) as Golden;
  if (input !== null && g.input !== input) {
    console.warn(`[drawings-golden] ${name}: model input changed (another workflow?) — structure compare skipped; run UPDATE_GOLDEN=1 after review`);
    return;
  }
  expect(structure, `${name} (UPDATE_GOLDEN=1 to accept)`).toEqual(g.structure);
}

const sheetStructure = (p: Project, a: ProjectAnalysis | null, id: string, opts: DrawingOptions) => {
  const s = buildDrawing(p, a, id, opts);
  const { minTextMm: _m, ...st } = svgStructure(s.svg);
  return {
    number: s.number,
    kind: s.kind,
    paper: s.paper,
    scale: s.scale,
    ...st,
    positions: [...s.svg.matchAll(/data-pos="([^"]+)"/g)].map((m) => m[1]),
    brackets: {
      lc: [...s.svg.matchAll(/data-lc-run="([^"]+)"/g)].map((m) => m[1]),
      rcu: [...s.svg.matchAll(/data-rcu-count="(\d+)"/g)].length,
      circuits: [...s.svg.matchAll(/data-circuit="/g)].length,
      leaf: [...s.svg.matchAll(/data-leaf-group="/g)].length,
      gaps: [...s.svg.matchAll(/data-gap-after="(\d+)"/g)].map((m) => m[1]),
    },
  };
};

describe('r4 drawings structural goldens (T6)', () => {
  it('fixture plan fragment (strict)', () => {
    const hp = r4FixtureHallPrims();
    const list = fixturePlanList(hp);
    const ann = annotate(fixtureProject(), hp, list, { locale: 'en', scaleDen: 50 });
    const { viewport } = fitViewport(list.bounds, { x: 30, y: 40, w: 500, h: 400 }, { hallId: hp.hallId, space: 'plan' });
    const r = drawListToSvg(list, ann, viewport, { idPrefix: 'fx-' });
    compare('fixture-plan', null, { ...svgStructure(r.svg), culled: r.culled, suppressed: r.suppressed, layerCounts: r.layerCounts });
  });

  it('fixture section fragment (strict)', () => {
    const hp = r4FixtureHallPrims();
    const list = fixtureSectionList(4.0, hp);
    const ann = annotate(fixtureProject(), hp, list, { locale: 'ko', scaleDen: 50 });
    const { viewport } = fitViewport(list.bounds, { x: 20, y: 30, w: 600, h: 300 }, { hallId: hp.hallId, space: 'section', scaleDen: 50, cut: list.cut });
    const r = drawListToSvg(list, ann, viewport, { idPrefix: 's-' });
    compare('fixture-section-ko', null, { ...svgStructure(r.svg), culled: r.culled, suppressed: r.suppressed, layerCounts: r.layerCounts });
  });

  const ref = refProject();
  const refA = analysisOf(ref);
  const refIn = inputDigest(ref, refA);
  const opts: DrawingOptions = { sheets: ['index', 'row-schematic'], date: '2026-09-15' };

  it('REF 001 EN / KO', () => {
    compare('ref-en-001', refIn, sheetStructure(ref, refA, 'index', { ...opts, locale: 'en' }));
    compare('ref-ko-001', refIn, sheetStructure(ref, refA, 'index', { ...opts, locale: 'ko' }));
  });

  it('REF 601 EN (with analysis) / KO (no analysis)', () => {
    compare('ref-en-601', refIn, sheetStructure(ref, refA, `schematic-${ref.halls[0].id}`, { ...opts, locale: 'en' }));
    compare('ref-ko-601-null', inputDigest(ref, null), sheetStructure(ref, null, `schematic-${ref.halls[0].id}`, { ...opts, locale: 'ko' }));
  });

  it('POD 601 EN', () => {
    const pod = podProject();
    if (!pod) return;
    const podA = analysisOf(pod);
    compare('pod-en-601', inputDigest(pod, podA), sheetStructure(pod, podA, `schematic-${pod.halls[0].id}`, { ...opts, locale: 'en' }));
  });
});
