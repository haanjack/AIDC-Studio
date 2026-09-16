import { describe, expect, it } from 'vitest';
import { DOC_CHAPTERS, analyzeProject, createNvidiaReferenceProject, docStrings, generateDesignDocument, type ProjectAnalysis } from '../src/index.ts';

const project = createNvidiaReferenceProject().project;
const a: ProjectAnalysis = analyzeProject(project);

describe('design document — locale-aware generator', () => {
  const en = generateDesignDocument(project, a, { thermal: { maxInletC: 26.8, rciHi: 100, rti: 95 } });
  const ko = generateDesignDocument(project, a, { locale: 'ko', thermal: { maxInletC: 26.8, rciHi: 100, rti: 95 } });

  it('defaults to English and renders all 11 chapters in reference-design order', () => {
    const S = docStrings('en');
    expect(en.startsWith('# ')).toBe(true);
    expect(en).toContain('— Technical Design Document');
    let last = -1;
    for (const ch of DOC_CHAPTERS) {
      const idx = en.indexOf(`## ${S.chapters[ch]}`);
      expect(idx, S.chapters[ch]).toBeGreaterThan(last);
      last = idx;
    }
    expect(en).toContain('## 1. Overview, challenges & goals');
    expect(en).toContain('## 11. Assumptions & data sources');
    expect(en).toContain('| Metric | Value |');
    // chapter headings are English even though project-authored text (description, notes, issues) may be Korean
    expect(en.split('\n').filter((l) => l.startsWith('## ')).join('')).not.toMatch(/[가-힣]/);
  });

  it('renders Korean when locale = ko (or project.locale = ko) with every chapter', () => {
    const S = docStrings('ko');
    for (const ch of DOC_CHAPTERS) expect(ko, S.chapters[ch]).toContain(`## ${S.chapters[ch]}`);
    expect(ko).toContain('기류·열 시뮬레이션 결과');
    const viaProject = generateDesignDocument({ ...project, locale: 'ko' }, a);
    expect(viaProject).toContain('## 1. 개요·과제·목표');
    const viaOptOverride = generateDesignDocument({ ...project, locale: 'ko' }, a, { locale: 'en' });
    expect(viaOptOverride).toContain('## 1. Overview, challenges & goals');
  });

  it('keeps every v0.1 section: mermaid one-line, topology, gantt, BOM detail, notes, issues, sources', () => {
    for (const doc of [en, ko]) {
      expect(doc).toContain('flowchart TB');
      expect(doc).toContain('flowchart BT');
      expect(doc).toContain('gantt');
      expect(doc).toContain(project.notes[0].title);
      expect(doc).toContain(project.name);
      expect(doc).toContain(a.summary.readyForService);
      expect(doc).toContain(project.site.utility[0].name);
      for (const l of a.cost.bom.slice(0, 5)) expect(doc).toContain(l.description);
      for (const w of project.workloads) expect(doc).toContain(w.name);
      for (const m of a.schedule.milestones) expect(doc).toContain(m.name);
    }
    const noBom = generateDesignDocument(project, a, { includeBom: false });
    expect(noBom).not.toContain('### 9.2 BOM detail');
    expect(en).toContain('### 9.2 BOM detail');
  });

  it('formats numbers per locale and explains oversubscription with the 1:1 / 3:1 examples', () => {
    expect(en).toContain('6,912');
    expect(ko).toContain('6,912');
    expect(en).toContain('32 server / 32 spine ports is 1:1');
    expect(ko).toContain('1:3 blocking');
    expect(en).toContain(`scale-out ${project.network.scaleOut.oversubscription}:1`);
  });

  it('is deterministic for the same inputs', () => {
    expect(generateDesignDocument(project, a)).toBe(generateDesignDocument(project, a));
    expect(generateDesignDocument(project, a, { locale: 'ko' })).toBe(generateDesignDocument(project, a, { locale: 'ko' }));
  });
});
