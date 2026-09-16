// r4 stream B1 structural goldens (spec §4.4 T6): number, kind, paper, scale, element count per data-layer, sorted tags, dimension
// texts, keynote ids and the B1 data attributes of sheets 002 / 101 (upgrade) / 111 / 121 / 611. Not bytes. Model cases carry the input
// digest: when another workflow changed the reference model the compare is skipped with a warning.
// Regenerate: UPDATE_GOLDEN=1 npx vitest run packages/core/test/drawings-golden-b1.test.ts — then review the JSON diff.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openDrawingSet, svgStructure, type Project, type ProjectAnalysis } from '../src/index.ts';
import { analysisOf, inputDigest, podProject, rcuProject, refProject } from './drawings-r4-helpers.ts';

const DIR = fileURLToPath(new URL('./__golden__/drawings-b1/', import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const SHEETS = ['site', 'plan-upgrade', 'services-plan', 'enlarged-plan', 'one-line'] as const;

function digestOf(svg: string) {
  const st = svgStructure(svg);
  const count = (re: RegExp) => (svg.match(re) ?? []).length;
  return {
    layers: st.layers,
    tags: st.tags,
    dimensions: st.dimensions,
    keynotes: st.keynotes,
    minTextMm: st.minTextMm,
    attrs: { tapoff: count(/data-tapoff="/g), rcu: count(/data-rcu-count="/g), gapAfter: count(/data-gap-after="/g), door: count(/data-door="/g), fold: count(/data-fold="/g), block: count(/data-block="ups/g), hall: count(/data-hall="/g), unsleeved: count(/data-unsleeved="/g) },
  };
}

interface GCase {
  name: string;
  project: () => Project | null;
  analysis: boolean;
  locale: 'en' | 'ko';
  id: (p: Project) => string;
}
const ref = refProject();
const refA = analysisOf(ref);
const CASES: GCase[] = [
  { name: 'ref-en-002', project: () => ref, analysis: true, locale: 'en', id: () => 'site-key' },
  { name: 'ref-en-101-upgrade', project: () => ref, analysis: true, locale: 'en', id: (p) => `plan-${p.halls[0].id}` },
  { name: 'ref-ko-102-upgrade', project: () => ref, analysis: true, locale: 'ko', id: (p) => `plan-${p.halls[1].id}` },
  { name: 'ref-en-111', project: () => ref, analysis: true, locale: 'en', id: (p) => `services-${p.halls[0].id}` },
  { name: 'ref-ko-121-du01', project: () => ref, analysis: true, locale: 'ko', id: (p) => `enlarged-${p.halls[0].id}-pod-01` },
  { name: 'ref-en-611', project: () => ref, analysis: true, locale: 'en', id: (p) => `one-line-${p.halls[0].id}` },
  { name: 'ref-en-611-null', project: () => ref, analysis: false, locale: 'en', id: (p) => `one-line-${p.halls[0].id}` },
  { name: 'pod-en-111', project: podProject, analysis: true, locale: 'en', id: (p) => `services-${p.halls[0].id}` },
  { name: 'rcu-en-121-du01', project: rcuProject, analysis: false, locale: 'en', id: (p) => `enlarged-${p.halls[0].id}-pod-01` },
];

describe('r4 B1 structural goldens (T6)', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const p = c.project();
      if (!p) return;
      const a: ProjectAnalysis | null = c.analysis ? (p === ref ? refA : analysisOf(p)) : null;
      const set = openDrawingSet(p, a, { locale: c.locale, sheets: [...SHEETS], date: '2026-09-15' });
      const s = set.build(c.id(p));
      const got = { input: inputDigest(p, a), number: s.number, kind: s.kind, paper: s.paper, scale: s.scale, viewports: s.viewports?.length ?? 0, ...digestOf(s.svg) };
      const file = `${DIR}${c.name}.json`;
      if (UPDATE || !existsSync(file)) {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(file, `${JSON.stringify(got, null, 1)}\n`);
        return;
      }
      const want = JSON.parse(readFileSync(file, 'utf8'));
      if (want.input !== got.input) {
        console.warn(`[drawings-golden-b1] ${c.name}: model input changed, structure compare skipped (regenerate with UPDATE_GOLDEN=1 after review)`);
        expect(got.number).toBe(want.number);
        return;
      }
      expect(got).toEqual(want);
    });
  }
});
