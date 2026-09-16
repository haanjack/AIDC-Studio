import { describe, expect, it } from 'vitest';
import { DOC_CHAPTERS, analyzeProject, createNvidiaReferenceProject, docStrings, generateDesignDocument, htmlPage, htmlTable, inlineMarkup, renderDesignDocumentHtml, type ProjectAnalysis } from '../src/index.ts';
import { oneLineSvg } from '../src/docs/svg/oneLine.ts';
import { fabricTopologySvg } from '../src/docs/svg/topology.ts';
import { scheduleGanttSvg } from '../src/docs/svg/gantt.ts';
import { tagBalance, withoutDataUris } from './docs-helpers.ts';

const project = createNvidiaReferenceProject().project;
const a: ProjectAnalysis = analyzeProject(project);

describe('HTML design document (F5)', () => {
  const en = renderDesignDocumentHtml(project, a, { locale: 'en', thermal: { maxInletC: 26.8, rciHi: 100, rti: 95 } });
  const ko = renderDesignDocumentHtml(project, a, { locale: 'ko' });

  it('is a self-contained, well-formed single file in both locales', () => {
    for (const [doc, lang] of [[en, 'en'], [ko, 'ko']] as const) {
      expect(doc.startsWith('<!doctype html>\n<html lang="' + lang + '">')).toBe(true);
      expect(tagBalance(doc)).toBe('');
      const text = withoutDataUris(doc);
      expect(text).not.toMatch(/undefined|NaN|\[object Object\]/);
      expect(text).not.toMatch(/<script|<link |https?:\/\/[^"<\s]*\.(css|js)\b/);
      expect(text).not.toContain('mermaid');
      expect(text).toContain('@page{size:A4');
      expect(text).toContain('section.chapter{break-before:page;}');
    }
  });

  it('renders every chapter in the reference-design chapter order with a table of contents', () => {
    for (const [doc, locale] of [[en, 'en'], [ko, 'ko']] as const) {
      const S = docStrings(locale);
      let last = -1;
      for (const ch of DOC_CHAPTERS) {
        const idx = doc.indexOf(`<h2 id="ch-${ch}">${S.chapters[ch].replace(/&/g, '&amp;')}</h2>`);
        expect(idx, `${locale} ${ch}`).toBeGreaterThan(last);
        last = idx;
        expect(doc).toContain(`href="#ch-${ch}"`);
      }
      expect((doc.match(/<section class="chapter"/g) ?? []).length).toBe(DOC_CHAPTERS.length);
      expect(doc).toContain(`<nav class="toc"><h2>${locale === 'ko' ? '목차' : 'Contents'}</h2>`);
    }
    expect(en).toContain('3.5 Airflow &amp; thermal simulation results'); // thermal option given for EN only
    expect(ko).not.toContain('기류·열 시뮬레이션 결과');
  });

  it('embeds core SVG diagrams and the 101 / 201 drawing sheets', () => {
    expect((en.match(/<figure id="fig-(topology|one-line|gantt)"><svg xmlns="http:\/\/www.w3.org\/2000\/svg"/g) ?? []).length).toBe(3);
    expect((en.match(/<img alt="[^"]*" src="data:image\/svg\+xml;charset=utf-8,/g) ?? []).length).toBe(2);
    expect(en).toContain('Sheet 101');
    expect(en).toContain('Sheet 201');
    const noDrawings = renderDesignDocumentHtml(project, a, { locale: 'en', includeDrawings: false });
    expect(noDrawings).not.toContain('data:image/svg+xml');
  });

  it('carries the same content as the internal Markdown generator', () => {
    const md = generateDesignDocument(project, a, { locale: 'en' });
    for (const l of a.cost.bom.slice(0, 5)) expect(en).toContain(l.description.replace(/&/g, '&amp;'));
    for (const m of a.schedule.milestones) expect(en).toContain(m.name.replace(/&/g, '&amp;'));
    expect(en).toContain(project.notes[0].title.replace(/&/g, '&amp;'));
    expect(md).toContain('flowchart TB'); // Markdown keeps mermaid for internal consumers
    expect(en).toContain('<strong>');
  });

  it('is deterministic', () => {
    expect(renderDesignDocumentHtml(project, a, { locale: 'ko' })).toBe(ko);
  });
});

describe('SVG generators', () => {
  it('one-line: layered boxes for every node, folds wide ranks, handles empty input', () => {
    const svg = oneLineSvg(a.power.oneLine, { locale: 'en' });
    expect(tagBalance(svg)).toBe('');
    for (const n of a.power.oneLine.nodes.slice(0, 5)) expect(svg).toContain('<title>' + n.label.replace(/&/g, '&amp;'));
    const wide = { nodes: [{ id: 'u', kind: 'utility' as const, label: 'U', path: 'A' as const }, ...Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, kind: 'rpp' as const, label: `RPP ${i}`, path: 'A' as const, loadKW: 100 }))], edges: Array.from({ length: 30 }, (_, i) => ({ from: 'u', to: `r${i}` })) };
    const folded = oneLineSvg(wide, { maxPerRank: 10 });
    expect(folded).toContain('RPP × 30 (A)');
    expect(oneLineSvg({ nodes: [], edges: [] })).toContain('No one-line data');
  });

  it('topology: one panel per fabric with tier counts; gantt: phases, critical outline, milestones', () => {
    const topo = fabricTopologySvg(a.network.fabrics, { locale: 'ko' });
    expect(tagBalance(topo)).toBe('');
    for (const f of a.network.fabrics) for (const t of f.tiers) expect(topo).toContain(`${t.name} × ${t.switches.toLocaleString('en-US')}`);
    expect(fabricTopologySvg([])).toContain('No fabrics');
    const g = scheduleGanttSvg(a.schedule, { locale: 'en' });
    expect(tagBalance(g)).toBe('');
    expect((g.match(/<rect [^>]*><title>/g) ?? []).length).toBe(a.schedule.tasks.length);
    expect(g).toContain('critical path');
    expect(g).toContain('Milestones');
    expect(scheduleGanttSvg({ ...a.schedule, tasks: [] })).toContain('No schedule data');
  });
});

describe('HTML helpers', () => {
  it('escape text cells, pass raw cells, render inline markup and page options', () => {
    expect(htmlTable(['a'], [['<b>']])).toContain('<td>&lt;b&gt;</td>');
    expect(htmlTable(['a'], [['<b>x</b>']], { rawCols: [0], monoCols: [0] })).toContain('<td class="mono"><b>x</b></td>');
    expect(inlineMarkup('**bold** _it_ `code` <x>')).toBe('<strong>bold</strong> <em>it</em> <code>code</code> &lt;x&gt;');
    const page = htmlPage('T', '<p>x</p>', 'en', { toc: [{ id: 'a', label: 'A', level: 1 }], landscape: true, footer: 'F' });
    expect(page).toContain('@page{size:A4 landscape');
    expect(page).toContain('<a href="#a">A</a>');
    expect(tagBalance(page)).toBe('');
  });
});
