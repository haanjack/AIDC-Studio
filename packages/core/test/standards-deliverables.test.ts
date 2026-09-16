// Stream E (P5): standards basis in deliverables — design document section, non-affiliation notice, BOM columns, drawing title
// blocks / legends, chip labels (OCP-DESIGN-PROPOSAL §6.2–6.3, P0 trademark additions). Legacy projects without a profile keep
// their sheets unchanged (drawings goldens cover that); projects with a profile gain the rows asserted here.
import { describe, expect, it } from 'vitest';
import {
  STANDARDS_LABELS, STANDARDS_NOTICE, analyzeProject, buildWaveBom, checkFindingsByFamily, createNvidiaReferenceProject, createReferenceProject, findCatalogItem,
  generateDesignDocument, generateDrawings, itemStandardsChips, itemStandardsFields, pinnedDocuments, profileRows, rackStandardLine, renderDesignDocumentHtml,
  standardsBasisLine, standardsDictionary, upgradeProject, waveBomCsv,
} from '../src/index.ts';

const neutral = createReferenceProject().project;
const neutralA = analyzeProject(neutral);
const sample = createNvidiaReferenceProject().project;
const sampleA = analyzeProject(sample);

/** Proposal §6.2 forbidden wording (the notice itself is exempt). */
const FORBIDDEN = /OCP Inspired|OCP (Accepted|Ready)(®|™)? (compliant|certified|approved)|OCP[- ]certified|OCP compliant|OCP mode|OCP Studio/i;
/** Internal keys that must never be printed in deliverables. */
const RAW_KEYS = /\b(open-spec|contributed-design|open-platform-host|ocp-based|ocp-contributed-design|ocp-inspired-host|orv3-hpr-liquid|dc-busbar-50v-hpr|facility-v2hs@1\.15|facility-v1@1\.5|orv3-blindmate|row-l2l)\b/;
const withoutNotice = (s: string) => s.split(STANDARDS_NOTICE.en).join('').split(STANDARDS_NOTICE.ko).join('');

describe('standards notice and labels', () => {
  it('uses the Trademark Usage Guidelines v1.7 notice wording (proposal §6.3) without a licensee sentence', () => {
    expect(STANDARDS_NOTICE.en).toBe('Parameters derived from Open Compute Project® publications as cited. OCP®, Open Compute®, Open Compute Project® and OCP Ready® are registered marks of the Open Compute Project Foundation. AIDC Studio and its outputs are not affiliated with, endorsed by or certified by the Open Compute Project Foundation.');
    for (const mark of ['OCP®', 'Open Compute®', 'Open Compute Project®', 'OCP Ready®']) expect(STANDARDS_NOTICE.ko).toContain(mark);
    for (const s of Object.values(STANDARDS_NOTICE)) expect(s).not.toMatch(/permission|Inspired/i);
  });

  it('labels and chips never carry the mark, forbidden wording or an internal key', () => {
    for (const [key, v] of Object.entries(STANDARDS_LABELS)) {
      for (const text of [v.en, v.ko]) {
        expect(text, key).not.toMatch(/\bOCP\b|Open Compute/);
        expect(text, key).not.toMatch(FORBIDDEN);
        expect(text.trim().length, key).toBeGreaterThan(0);
      }
    }
    expect(STANDARDS_LABELS['status.accepted'].en).toBe('Published');
    expect(Object.keys(standardsDictionary('ko'))).toEqual(Object.keys(standardsDictionary('en')));
  });

  it('item fields and chips render display text (released wide rack without a draft chip, HPR v1 shelf with one)', () => {
    const orw = findCatalogItem('rack-orw')!;
    expect(itemStandardsFields(orw, 'en')).toMatchObject({ standard: 'Open Rack Wide (ORW) Base Specification', standardVersion: 'V1.0.0', specStatus: 'Published', implementationLevel: 'Open standard-based' });
    expect(itemStandardsChips(orw, 'en').some((c) => c.kind === 'draft')).toBe(false);
    const hpr = findCatalogItem('pshelf-orv3-hpr-33kw')!;
    expect(itemStandardsChips(hpr, 'en').find((c) => c.kind === 'draft')?.text).toBe('Draft spec');
    expect(itemStandardsChips(hpr, 'ko').find((c) => c.kind === 'draft')?.text).toBe('초안 사양');
    for (const id of ['rack-orw', 'pshelf-orv3-hpr-33kw', 'ubb8-oam-dlc-hpr-5x']) {
      const item = findCatalogItem(id)!;
      for (const c of itemStandardsChips(item, 'en')) {
        expect(c.text).not.toMatch(RAW_KEYS);
        expect(c.text).not.toMatch(/\bOCP\b/);
      }
    }
  });
});

describe('design document — Standards basis section', () => {
  const en = generateDesignDocument(neutral, neutralA);
  const ko = generateDesignDocument(neutral, neutralA, { locale: 'ko' });

  it('neutral reference: profile, pinned documents with version / status / licence / URL, check summary, facility pre-check, notice', () => {
    const sec = en.slice(en.indexOf('### Standards basis'));
    expect(sec.length).toBeGreaterThan(100);
    expect(sec).toContain('| Profile | High-power 21-inch OU racks, liquid-cooled |');
    expect(sec).toContain('| Check strictness | Advisory |');
    expect(sec).toMatch(/\| Rack \| Open Rack V3 Base Specification \| Rev 1\.1 \| 2024-03-05 \| Published \|/);
    expect(sec).toMatch(/Meta Open Rack Frame V3 Specification \| Rev 1\.3/);
    expect(sec).toMatch(/ORv3 HPR 33 kW Power Shelf \| Rev 0\.3 \| 2024-04-29 \| Draft \|/);
    expect(sec).toContain('#### Parameter check summary');
    expect(sec).toMatch(/\| Liquid cooling \| 0 \| 0 \|/); // QA (standards): CL-09 now reads power-plane circuits — the reference's warning was a row-vs-one-busway artefact (qa-standards.md)
    expect(sec).toContain('#### Facility pre-check — ');
    expect(sec).toContain('not assessments, compliance statements or certifications');
    expect(sec).toContain(STANDARDS_NOTICE.en);
    expect(withoutNotice(sec)).not.toMatch(RAW_KEYS);
    expect(withoutNotice(en)).not.toMatch(FORBIDDEN);
    const kosec = ko.slice(ko.indexOf('### 표준 기반'));
    expect(kosec).toContain('| 점검 엄격도 | 정보용 |');
    expect(kosec).toContain(STANDARDS_NOTICE.ko);
    expect(withoutNotice(kosec)).not.toMatch(RAW_KEYS);
  });

  it('project without a profile: short statement and the notice; inferred profile: flagged as not confirmed', () => {
    const doc = generateDesignDocument(sample, sampleA);
    expect(doc).toContain('No standards profile is set for this project');
    expect(doc).toContain(STANDARDS_NOTICE.en);
    const up = upgradeProject(sample);
    expect(up.standards?.inferred).toBe(true);
    const inferred = generateDesignDocument(up, analyzeProject(up));
    expect(inferred).toContain('inferred from the placed equipment and has not been confirmed');
  });

  it('HTML deliverable carries the notice and no keyword meta or hidden text', () => {
    const html = renderDesignDocumentHtml(neutral, neutralA, { includeDrawings: false });
    expect(html).toContain('Open Compute Project® publications as cited');
    expect(html).not.toMatch(/<meta[^>]+name="keywords"/i);
    expect(html).not.toMatch(/display:\s*none[^>]*>[^<]*OCP/i);
    expect(withoutNotice(html.replace(/&reg;/g, '®'))).not.toMatch(FORBIDDEN);
  });

  it('profile rows and pinned documents are labels, never keys', () => {
    const rows = profileRows(neutral.standards!, 'en');
    expect(rows.flat().join(' ')).not.toMatch(RAW_KEYS);
    expect(pinnedDocuments(neutral.standards).map((d) => d.ref.id)).toContain('orv3-frame-meta@1.3');
    // QA (standards): 0 since CL-09 reads power-plane circuits (the reference's former warning was a row-vs-one-busway artefact); info findings remain
    expect(checkFindingsByFamily(neutralA.issues).find((f) => f.family === 'liquid')?.warnings ?? 0).toBe(0);
    expect(checkFindingsByFamily(neutralA.issues).find((f) => f.family === 'liquid')?.info).toBeGreaterThan(0);
  });
});

describe('BOM columns (standard, standardVersion, specStatus, implementationLevel, verification)', () => {
  it('neutral reference: rack lines carry display text; no internal level keys are exported', () => {
    const bom = buildWaveBom(neutral, neutralA, 'en');
    const csv = waveBomCsv(bom);
    expect(csv.split('\n')[0]).toBe('wave,waveName,group,itemId,description,lengthBin,qty,unit,totalLengthM,source,standard,standardVersion,specStatus,implementationLevel,verification');
    const rack = bom.lines.find((l) => l.itemId === 'ubb8-oam-dlc-hpr-5x')!;
    expect(rack.implementationLevel).toBe('Open standard-based');
    expect(rack.standard).toBeTruthy();
    expect(csv).not.toMatch(/\b(open-spec|contributed-design|open-platform-host|ocp-based|ocp-inspired-host)\b/);
    const ko = buildWaveBom(neutral, neutralA, 'ko');
    expect(ko.lines.find((l) => l.itemId === 'ubb8-oam-dlc-hpr-5x')!.implementationLevel).toBe('개방 표준 기반');
  });

  it('vendor sample: classified vendor racks export their level as chip text', () => {
    const bom = buildWaveBom(sample, sampleA, 'en');
    const levels = new Set(bom.lines.map((l) => l.implementationLevel).filter(Boolean));
    expect(levels.size).toBeGreaterThan(0);
    for (const l of levels) expect(['Open standard-based', 'Contributed design', 'Standard rack host', 'EIA-310', 'Proprietary']).toContain(l);
  });
});

describe('drawings — standards basis rows only with a profile', () => {
  it('title block and plan note name the profile and the rack document; rack-standard line with the OU pitch', () => {
    expect(standardsBasisLine(neutral, neutral.halls[0], 'en')).toEqual({ profile: 'High-power 21-inch OU racks, liquid-cooled', citation: 'per Open Rack V3 Base Specification Rev 1.1', inferred: false });
    expect(rackStandardLine(neutral, neutral.halls[0].id, 'en')).toBe('Rack standard: Open Rack V3 Base Specification Rev 1.1 · pitch 48 mm OU');
    expect(standardsBasisLine(sample, sample.halls[0], 'en')).toBeUndefined();
    const sheets = generateDrawings(neutral, neutralA, { locale: 'en', sheets: ['plan'] });
    const plan = sheets.find((s) => s.kind === 'plan')!;
    expect(plan.svg).toContain('Standards basis');
    expect(plan.svg).toContain('per Open Rack V3 Base Specification Rev 1.1');
    const legacy = generateDrawings(sample, sampleA, { locale: 'en', sheets: ['plan'] });
    expect(legacy.some((s) => s.svg.includes('Standards basis'))).toBe(false);
  });

  it('Korean title block', () => {
    expect(standardsBasisLine(neutral, neutral.halls[0], 'ko')?.profile).toBe('고전력 21인치 OU 랙, 액체냉각');
    expect(rackStandardLine(neutral, neutral.halls[0].id, 'ko')).toBe('랙 표준: Open Rack V3 Base Specification Rev 1.1 · 단위 피치 48 mm OU');
  });
});
