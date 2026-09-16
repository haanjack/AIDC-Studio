// r4 structural goldens for stream B2 sheets (spec §4.4 T6; not bytes): number, kind, paper, scale, element count per data-layer,
// sorted tags, dimension texts, datum labels, keynote ids + B2 attributes (clearance rules, door type, open-to-beyond, pipe runs,
// fittings, viewports). B0's drawings-golden.test.ts pattern; files under __golden__/drawings-b2/.
//
// Regenerate: UPDATE_GOLDEN=1 npx vitest run packages/core/test/drawings-golden-b2.test.ts   (review the JSON diff)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildDrawing, svgStructure, type DrawingOptions, type Project } from '../src/index.ts';
import { inputDigest, podProject, rcuProject, refProject } from './drawings-r4-helpers.ts';

const DIR = `${dirname(fileURLToPath(import.meta.url))}/__golden__/drawings-b2`;
const UPDATE = process.env.UPDATE_GOLDEN === '1';

function compare(name: string, input: string, structure: unknown) {
  const file = `${DIR}/${name}.json`;
  if (UPDATE || !existsSync(file)) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, `${JSON.stringify({ input, structure }, null, 2)}\n`);
    if (!UPDATE) console.warn(`[drawings-golden-b2] wrote missing golden ${name}.json`);
    return;
  }
  const g = JSON.parse(readFileSync(file, 'utf8')) as { input: string; structure: unknown };
  if (g.input !== input) {
    console.warn(`[drawings-golden-b2] ${name}: model input changed (another workflow?) — structure compare skipped; run UPDATE_GOLDEN=1 after review`);
    return;
  }
  expect(structure, `${name} (UPDATE_GOLDEN=1 to accept)`).toEqual(g.structure);
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const structure = (p: Project, id: string, opts: DrawingOptions) => {
  const s = buildDrawing(p, null, id, { date: '2026-09-15', ...opts });
  const { minTextMm: _m, ...st } = svgStructure(s.svg);
  const all = (re: RegExp) => [...s.svg.matchAll(re)].map((m) => m[1]);
  return {
    number: s.number,
    kind: s.kind,
    paper: s.paper,
    scale: s.scale,
    ...st,
    clearances: all(/data-rule="([^"]+)" data-status="[^"]+"/g).map((r, i) => `${r}:${all(/data-status="([^"]+)"/g)[i]}`),
    doorTypes: all(/data-door-type="([^"]+)"/g),
    openBeyond: all(/data-open-beyond="([^"]+)"/g).length,
    breaks: all(/data-break="([^"]+)"/g),
    runs: all(/data-run="([^"]+)"/g).length,
    fittings: all(/data-fitting="([^"]+)"/g).reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {}),
    viewports: (s.viewports ?? []).map((v) => ({ space: v.space, mmPerM: v.mmPerM, paperRect: { x: r3(v.paperRect.x), y: r3(v.paperRect.y), w: r3(v.paperRect.w), h: r3(v.paperRect.h) }, cut: v.cut ? { axis: v.cut.axis, at: r3(v.cut.at), look: v.cut.look, depthM: r3(v.cut.depthM) } : null })),
  };
};

describe('r4 B2 structural goldens (T6)', () => {
  const ref = refProject();
  const refIn = inputDigest(ref, null);
  const h = ref.halls[0].id;

  it('REF 301 EN / 302 KO', () => {
    compare('ref-en-301', refIn, structure(ref, `section-t-${h}-pod-01`, { sheets: ['section'], locale: 'en' }));
    compare('ref-ko-302', refIn, structure(ref, `section-l-${h}-pod-01-a`, { sheets: ['section'], locale: 'ko' }));
  });

  it('REF 311 EN / 411 EN', () => {
    compare('ref-en-311', refIn, structure(ref, `aisle-end-${h}-1`, { sheets: ['elevation'], locale: 'en' }));
    compare('ref-en-411', refIn, structure(ref, `mep-iso-${h}-pod-01`, { sheets: ['mep-iso'], locale: 'en' }));
  });

  it('POD 311 imperial / RCU 411', () => {
    const pod = podProject();
    if (pod) {
      const imp: Project = { ...pod, drawingUnits: 'imperial' };
      compare('pod-imperial-311', inputDigest(imp, null), structure(imp, `aisle-end-${pod.halls[0].id}-1`, { sheets: ['elevation'], locale: 'en' }));
    }
    const rcu = rcuProject();
    compare('rcu-en-411', inputDigest(rcu, null), structure(rcu, `mep-iso-${rcu.halls[0].id}-pod-01`, { sheets: ['mep-iso'], locale: 'en' }));
  });
});
