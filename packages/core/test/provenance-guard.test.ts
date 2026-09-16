// P6 guard (OCP-DESIGN-PROPOSAL §8.1 P6 "provenance completeness guard", §2.3 provenance fields; rules: facts cited with public URLs and
// document / version / date, never spec text). Complements standards-seeds (generic blocks) and standards-registry (entry shape)
// with repository-wide completeness: every catalog item, every standards reference, every check finding and every notice record.
import { describe, expect, it } from 'vitest';
import {
  CATALOG_DATA_CHANGES, LAYOUT_TEMPLATES, MAXQ_SOURCES, NEUTRAL_REFERENCE_BASIS, NO_STANDARD, RACK_SHELF_MODELS, STANDARDS_PRESETS, STANDARDS_REGISTRY,
  analyzeProject, catalogItems, createNvidiaReferenceProject, createReferenceProject, findCatalogItem, findStandard, isSpecSource, itemSpecStatus,
} from '../src/index.ts';

const PRIVATE = /docs\/(research|legal)|aidc-private|\/home\/|file:\/\//;
const PUBLIC_URL = /^https:\/\/[^\s]+$/;
/** Facility plant has no rack, liquid or compute standard to declare; everything else generic must say which standard it follows. */
const PLANT_CATEGORIES = new Set(['chiller', 'dry-cooler', 'generator', 'transformer', 'rpp', 'battery', 'busway-tapoff', 'switchgear']);
const VERIFICATION = ['verified', 'derived', 'estimate', 'unverified'];

describe('P6 provenance guard — catalog', () => {
  const items = catalogItems();

  it('every item: a known source tag, public https links, and an estimate explains its basis', () => {
    const bad: string[] = [];
    for (const i of items) {
      if (!isSpecSource(i.source)) bad.push(`${i.id}: source ${String(i.source)}`);
      for (const l of i.links ?? []) if (!PUBLIC_URL.test(l.url) || PRIVATE.test(l.url)) bad.push(`${i.id}: link ${l.url}`);
      if (i.source === 'estimate' && !(i.notes ?? '').trim() && !Object.keys(i.paramSources ?? {}).length) bad.push(`${i.id}: estimate without notes or paramSources`);
      if (PRIVATE.test(`${i.notes ?? ''} ${i.description ?? ''}`)) bad.push(`${i.id}: private path in text`);
    }
    expect(bad).toEqual([]);
  });

  it('generic items declare standards[] unless they are facility plant', () => {
    const bad = items.filter((i) => i.vendor === 'Generic' && !PLANT_CATEGORIES.has(i.category) && !i.standards?.length).map((i) => `${i.id} (${i.category})`);
    expect(bad).toEqual([]);
  });

  it('standards references resolve, specStatus is derived from them, paramSources are well-formed', () => {
    const bad: string[] = [];
    for (const i of items) {
      if (i.standards?.length) {
        for (const s of i.standards) if (s.standardId !== NO_STANDARD && !findStandard(s.standardId)) bad.push(`${i.id}: standard ${s.standardId}`);
        if (i.specStatus !== itemSpecStatus(i.standards)) bad.push(`${i.id}: specStatus ${String(i.specStatus)} ≠ ${itemSpecStatus(i.standards)}`);
      }
      for (const [path, p] of Object.entries(i.paramSources ?? {})) {
        if (!VERIFICATION.includes(p.verification)) bad.push(`${i.id}.${path}: verification ${p.verification}`);
        if (p.verification === 'verified' && !p.standardId) bad.push(`${i.id}.${path}: verified without a registry document`);
        if (p.standardId && !findStandard(p.standardId)) bad.push(`${i.id}.${path}: ${p.standardId}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('P6 provenance guard — registry cross-references', () => {
  it('registry entries: public URL, version, date field, licence, status; supersedes resolves; no private paths', () => {
    const bad: string[] = [];
    for (const r of STANDARDS_REGISTRY) {
      if (!PUBLIC_URL.test(r.url) || PRIVATE.test(r.url)) bad.push(`${r.id}: url`);
      if (!r.title || !r.version || !r.licence || !r.status) bad.push(`${r.id}: missing field`);
      if (typeof r.date !== 'string' || (r.date && !/^\d{4}(-\d{2}){0,2}$/.test(r.date))) bad.push(`${r.id}: date ${r.date}`);
      if (r.supersedes && !findStandard(r.supersedes)) bad.push(`${r.id}: supersedes ${r.supersedes}`);
    }
    expect(bad).toEqual([]);
  });

  it('presets, template profiles and the neutral reference basis cite registry documents', () => {
    const bad: string[] = [];
    const pinnedOf = (label: string, pinned: Partial<Record<string, string[]>> | undefined) => {
      for (const ids of Object.values(pinned ?? {})) for (const id of ids ?? []) if (!findStandard(id)) bad.push(`${label}: ${id}`);
    };
    for (const [id, p] of Object.entries(STANDARDS_PRESETS)) pinnedOf(`preset ${id}`, p.pinned);
    for (const t of LAYOUT_TEMPLATES) pinnedOf(`template ${t.id}`, t.profile?.pinned);
    const basisIds = JSON.stringify(NEUTRAL_REFERENCE_BASIS).match(/[a-z0-9-]+@[0-9A-Za-z.-]+/g) ?? [];
    expect(basisIds.length).toBeGreaterThan(2);
    for (const id of basisIds) if (!findStandard(id)) bad.push(`basis: ${id}`);
    expect(bad).toEqual([]);
  });
});

describe('P6 provenance guard — findings, notices and evidence', () => {
  for (const [label, make] of [['neutral', () => createReferenceProject().project], ['nvidia-sample', () => createNvidiaReferenceProject().project]] as const) {
    it(`standards findings of the ${label} reference state their basis; standard-based ones cite a registry document`, () => {
      const p = make();
      const issues = analyzeProject(p).issues.filter((i) => i.check);
      const bad: string[] = [];
      for (const i of issues) {
        const c = i.check!;
        if (!['standard', 'estimate', 'user'].includes(c.basis)) bad.push(`${i.id}: basis ${c.basis}`);
        if (c.basis === 'standard' && (!c.standardId || !findStandard(c.standardId))) bad.push(`${i.id}: standard basis without registry id (${String(c.standardId)})`);
        if (c.standardId && !findStandard(c.standardId)) bad.push(`${i.id}: ${c.standardId}`);
        if (!VERIFICATION.includes(c.verification)) bad.push(`${i.id}: verification ${c.verification}`);
      }
      expect(bad).toEqual([]);
    }, 240_000);
  }

  it('catalog data-change notices name existing items and a public source', () => {
    for (const c of CATALOG_DATA_CHANGES) {
      expect(c.sourceUrl, c.id).toMatch(PUBLIC_URL);
      expect(c.basis.length, c.id).toBeGreaterThan(20);
      for (const id of c.catalogIds) expect(findCatalogItem(id), `${c.id} → ${id}`).toBeTruthy();
      for (const f of c.fields) expect(Number.isFinite(f.before) && Number.isFinite(f.after) && f.unit.length > 0, `${c.id}.${f.path}`).toBe(true);
    }
  });

  it('engine evidence tables carry a label or source text, an evidence type, and public URLs only', () => {
    for (const [k, s] of Object.entries(MAXQ_SOURCES)) {
      expect(s.label.length, k).toBeGreaterThan(20);
      expect(s.sourceType, k).toBeTruthy();
      if ('url' in s && s.url) expect(s.url, k).toMatch(PUBLIC_URL);
    }
    for (const [id, m] of Object.entries(RACK_SHELF_MODELS)) {
      expect(findCatalogItem(id), id).toBeTruthy();
      expect(m.source.length, id).toBeGreaterThan(20);
      expect(m.sourceType, id).toBeTruthy();
      expect(m.source, id).not.toMatch(PRIVATE);
    }
  });
});
