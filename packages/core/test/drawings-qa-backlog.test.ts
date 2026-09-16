// QA backlog drawings (docs/research/qa-backlog-drawings.md): split 101 / 121 parts keep their annotations inside the window and place the
// match-line label clear of other texts; KO rack-elevation source notes carry no English sentences.
import { describe, expect, it } from 'vitest';
import { createNvidiaReferenceProject, openDrawingSet, R4_DRAWING_SHEETS, type Project } from '../src/index.ts';
import { textBox, type PaperBox } from '../src/drawings/annotate.ts';
import { deviceWords } from '../src/drawings/i18n.ts';
import { sheetProblems } from './drawings-r4-helpers.ts';

/** <text> boxes from sheet SVG (x, y, font-size, anchor, baseline, rotate) in paper mm. */
function textBoxes(svg: string): { box: PaperBox; s: string; match: boolean; layer: string }[] {
  const out: { box: PaperBox; s: string; match: boolean; layer: string }[] = [];
  let layer = '(frame)';
  const re = /<g data-layer="([^"]+)">|<text([^>]*)>([^<]*)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    if (m[1]) {
      layer = m[1];
      continue;
    }
    const a = m[2];
    const num = (k: string) => Number(new RegExp(`\\s${k}="(-?[\\d.]+)"`).exec(a)?.[1] ?? NaN);
    const anchor = (/text-anchor="(\w+)"/.exec(a)?.[1] ?? 'start') as 'start' | 'middle' | 'end';
    const baseline = /dominant-baseline="central"/.test(a) ? 'central' : 'auto';
    const rot = Number(/rotate\((-?[\d.]+)/.exec(a)?.[1] ?? 0);
    out.push({ box: textBox(num('x'), num('y'), m[3], num('font-size'), anchor, baseline, rot), s: m[3], match: /data-match-line=/.test(a), layer });
  }
  return out;
}
const hit = (a: PaperBox, b: PaperBox) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.3 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.3;

describe('QA backlog drawings: split plan parts', () => {
  // 40 DU in one hall: 21.6 × 340 m → 101-a… at 1:200 and 121-Services-a / -b / -c at 1:50
  const p: Project = createNvidiaReferenceProject({ pods: 40 }).project;
  const set = openDrawingSet(p, null, { locale: 'en', sheets: [...R4_DRAWING_SHEETS] });
  const parts = set.sheets.filter((m) => /^(101-[a-z]|121-(?:H\d+-)?Services-[a-z])$/.test(m.number));

  it('builds split parts of both kinds', () => {
    expect(parts.some((m) => m.number.startsWith('101-'))).toBe(true);
    expect(parts.some((m) => m.number.includes('Services-'))).toBe(true);
  });

  it('every split part keeps its layer content inside the content area (row chains and aisle labels cut to the window)', () => {
    for (const m of parts) {
      const s = set.build(m.id);
      expect(sheetProblems(s.svg, s.paper!), m.number).toEqual([]);
    }
  });

  it('match-line labels do not overlap any other sheet text', () => {
    for (const m of parts) {
      const t = textBoxes(set.build(m.id).svg);
      const labels = t.filter((x) => x.match);
      expect(labels.length, m.number).toBeGreaterThan(0);
      for (const l of labels) {
        const clash = t.filter((o) => !o.match && o.layer !== '(frame)' && hit(l.box, o.box)).map((o) => `[${o.layer}] ${o.s}`);
        expect(clash, `${m.number} ${l.s}`).toEqual([]);
      }
    }
  });
});

describe('QA backlog drawings: KO U-map source notes', () => {
  const notes = [
    'no switch placement analysis',
    'switches from the network placement analysis (top-down, role then model)',
    'U-map is a planning estimate',
    'U-map from the rack composer (explicit U positions)',
    'NVIDIA NVL72 rack composition (DGX GB user guide) — 18 compute trays, 9 NVLink switch trays, 8 power shelves; U order is an AIDC Studio layout',
    'planning estimate — generic HGX stack (no public rack map): 4 of 5 × 10U nodes of 8 × H200 in 48U',
    'planning estimate — generic MGX stack (no public rack map): 18 × 1U trays of 4 × GB200 in 42OU',
    'planning estimate — 4 × 10U 8-GPU nodes',
  ];
  it('translates every generated note on KO sheets (EN unchanged)', () => {
    for (const n of notes) {
      expect(deviceWords('en', n)).toBe(n);
      const ko = deviceWords('ko', n);
      expect(ko, n).not.toMatch(/\b(analysis|placement|estimate|composition|compute|trays?|shelves|nodes?|layout|explicit|generic|stack|public)\b/);
      expect(ko, n).toMatch(/[가-힣]/);
    }
    expect(deviceWords('ko', notes[4])).toContain('컴퓨트 트레이 18개');
    expect(deviceWords('ko', notes[5])).toContain('4/5 × 10U 노드 (8 × H200), 총 48U');
  });
});
