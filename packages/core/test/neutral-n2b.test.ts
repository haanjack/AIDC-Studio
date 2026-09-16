// Neutralization N2b (content re-sourcing and citations): guards that shipped catalog values, help / glossary text, the
// assistant corpus and generated exports stay vendor-neutral and cite public sources only.
import { describe, expect, it } from 'vitest';
import {
  ACCELERATOR_FLOPS, BENCHMARKS, builtinCorpus, catalogItems, createNvidiaReferenceProject, findCatalogItem, generateNosConfigs, GLOSSARY, HELP_PAGE_IDS,
  MODEL_PRESETS, NOS_TARGETS, pageHelpText,
} from '../src/index.ts';
import { testKitStrings } from '../src/deploy/tests/strings.ts';
import { nosFixture } from './nos-fixtures.ts';
import { termRe, TERM_LOWER } from './guard-terms.ts';

const PRIVATE_PATH = /docs\/(research|legal)\b/;

describe('N2b — catalog sources', () => {
  it('no builtin catalog item carries the legacy third-party asset tag; ids of stored projects still resolve', () => {
    for (const it of catalogItems()) expect(it.source, it.id).not.toBe(`nvidia-${TERM_LOWER}-asset`);
    for (const id of ['nvidia-gb300-nvl72', 'vertiv-xdu2300', 'vertiv-cw375', 'vertiv-xdu1350', 'vertiv-cw084', 'vertiv-cw181', 'vertiv-apm2-150']) {
      const item = findCatalogItem(id);
      expect(item, id).toBeDefined();
      expect(item!.notes ?? '', id).not.toBe('');
      expect(item!.notes ?? '', id).not.toMatch(termRe('aif:|SimReady|<T>'));
    }
  });

  it('values that drive stored-project totals are unchanged by the re-sourcing', () => {
    const gb = findCatalogItem('nvidia-gb300-nvl72')!;
    expect(gb.power).toMatchObject({ nameplateKW: 136, peakKW: 204 });
    expect(gb.cooling?.liquidFlowLpm).toBe(92.6);
    expect(findCatalogItem('vertiv-xdu2300')!.capacity?.coolingKW).toBe(2300);
    expect(findCatalogItem('vertiv-cw375')!.capacity).toMatchObject({ coolingKW: 375, airflowM3s: 27.14 });
  });

  it('links and citations are public URLs, never private notes', () => {
    for (const it of catalogItems()) for (const l of it.links ?? []) expect(l.url, it.id).toMatch(/^https:\/\//);
    for (const f of Object.values(ACCELERATOR_FLOPS)) for (const e of Object.values(f.basis)) {
      expect(e.citation, f.key).not.toMatch(/S81848|GTC 2026 \(|docs\/research/);
      if (e.url) expect(e.url, f.key).toMatch(/^https:\/\//);
    }
    for (const b of BENCHMARKS) expect(b.sourceUrl, b.id).not.toMatch(PRIVATE_PATH);
    for (const p of MODEL_PRESETS) expect(JSON.stringify(p), p.id).not.toMatch(/unsloth\/|docs\/research/);
  });
});

describe('N2b — help, glossary and assistant corpus', () => {
  it('the BM25 corpus indexes only glossary + page help (no research or legal notes)', () => {
    for (const locale of ['en', 'ko'] as const) {
      const docs = builtinCorpus(locale);
      expect(docs.every((d) => /^(term|help):/.test(d.id))).toBe(true);
      for (const d of docs) expect(`${d.title}\n${d.text}`, d.id).not.toMatch(PRIVATE_PATH);
    }
  });

  it('help and glossary describe concepts in neutral terms (vendor names only as nominative references)', () => {
    for (const page of HELP_PAGE_IDS) for (const l of ['en', 'ko'] as const) expect(pageHelpText(page, l), page).not.toMatch(termRe('<T>[- ]style|<T> 스타일|<T> RD'));
    for (const t of GLOSSARY) {
      const text = [t.term.en, t.term.ko, t.short.en, t.short.ko, t.long?.en ?? '', t.long?.ko ?? '', ...(t.sources ?? [])].join('\n');
      expect(text, t.id).not.toMatch(termRe('nvidia-<t>-asset|aif:|SimReady spec|<T> (example|default|places|plans|design point|simulations|examples)'));
    }
  });
});

describe('N2b — generated exports', () => {
  it('NOS bundles are generated from own templates: no "verbatim" wording and no private note references', () => {
    const fx = nosFixture();
    for (const t of NOS_TARGETS) {
      for (const f of generateNosConfigs(fx.project, fx.analysis, fx.plan, t, { cableSchedule: fx.rows })) {
        expect(f.content, `${t}/${f.path}`).not.toMatch(/verbatim|r2-ops|docs\/research|AMD guide\)|AMD QFX5240 example|mydscp|lb-perpacket/);
      }
    }
  });

  it('test-kit README sources are public URLs', () => {
    for (const l of ['en', 'ko'] as const) for (const [, url] of testKitStrings(l).sources) expect(url).toMatch(/^https:\/\//);
    expect(createNvidiaReferenceProject().project.halls.length).toBeGreaterThan(0);
  });
});
