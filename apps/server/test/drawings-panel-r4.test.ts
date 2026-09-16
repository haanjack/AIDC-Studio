// r4 stream D (spec §4.4 T10): pure helpers of the two-column Drawings panel — fitPage math for A1 portrait / landscape,
// selection by id with the nearest-sibling fallback, series → hall → DU grouping with F · R pairing, Hangul-normalised search.
// Lives here because the root vitest config collects apps/server/test (not apps/web); the module imports only types from core.
import { describe, expect, it } from 'vitest';
import { analyzeProject, createNvidiaReferenceProject, listDrawings, R4_DRAWING_SHEETS, rackElevationFileName, type DrawingSheet, type DrawingSheetMeta } from '@aidc/core';
import { drawingOptions } from '../../web/src/panels/drawings/sheetJobs.ts';
import {
  A1L, A1P, FIT_MARGIN_PX, Lru, PX_PER_MM, buildTree, filterSheets, fitPage, fitWidth, flattenTree, layoutForWidth, matchSheet,
  paperBadge, parseFilters, parseListW, prebuildOrder, relativeCentre, resolveSelection, screenScale, seriesOf, stepId,
  viewForMode, zoomAt, DEFAULT_FILTERS,
} from '../../web/src/panels/drawings/model.ts';

const plan = (id: string, number: string, hallId = 'hall-a'): DrawingSheetMeta => ({ id, number, title: `Plan ${number}`, kind: 'plan', scale: '1:100', paper: A1P, hallId });
const rackRow = (du: string, row: string, face: 'front' | 'rear', hallId = 'hall-a'): DrawingSheetMeta => ({
  id: `relev-${du}-${row}-${face[0]}`.toLowerCase(),
  number: `2-${du}-${row}-${face === 'front' ? 'F' : 'R'}`,
  title: `Rack row elevation — ${du} ${row}`,
  kind: 'rack-elevation',
  scale: '1:30',
  paper: A1L,
  hallId,
  group: { hallId, zone: 'du', groupKey: du, face },
});

/** a reference-like list: 001, 101, 201, rack rows DU01..DU04 × A/B × F/R, 301, 401 */
function refList(): DrawingSheetMeta[] {
  const out: DrawingSheetMeta[] = [
    { id: 'index', number: '001', title: 'Sheet index', kind: 'index', scale: 'NTS', paper: A1L },
    plan('plan-hall-a', '101'),
    { id: 'elev-1', number: '201', title: 'Rack elevations', kind: 'rack-elevation', scale: '1:20', paper: A1P, group: undefined },
  ];
  for (const du of ['DU01', 'DU02', 'DU03', 'DU04']) for (const row of ['A', 'B']) for (const f of ['front', 'rear'] as const) out.push(rackRow(du, row, f));
  out.push({ id: 'section-t-hall-a-pod-01', number: '301-H1-T01', title: 'Transverse section — Pod 01', kind: 'section', scale: '1:50', paper: A1L, hallId: 'hall-a' });
  out.push({ id: 'iso-hall-a', number: '401', title: 'Systems isometric', kind: 'iso-systems', scale: '—', paper: A1P, hallId: 'hall-a' });
  return out;
}

describe('fitPage / zoom math (sheet.paper)', () => {
  const px = (mm: number) => mm * PX_PER_MM;
  for (const [name, paper, W, H] of [['A1P 1920×1080 wide', A1P, 1850, 960], ['A1L 1920×1080 wide', A1L, 1530, 960], ['A1P 1440×900', A1P, 1050, 780], ['A1L narrow 500', A1L, 480, 700]] as const) {
    it(`${name}: whole sheet visible, ≥ 12 px margin, limiting side exactly 12 px`, () => {
      const v = fitPage(paper, W, H);
      const w = px(paper.w) * v.z;
      const h = px(paper.h) * v.z;
      expect(v.z).toBeCloseTo(Math.min((W - FIT_MARGIN_PX) / px(paper.w), (H - FIT_MARGIN_PX) / px(paper.h)), 12);
      expect(v.x).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(v.y).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(W - (v.x + w)).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(H - (v.y + h)).toBeGreaterThanOrEqual(12 - 1e-9);
      expect(Math.min(v.x, v.y)).toBeCloseTo(12, 9);
      // aspect of the drawn box = paper aspect (Q2: 841/594 for A1L)
      expect(w / h).toBeCloseTo(paper.w / paper.h, 9);
    });
  }
  it('A1P fit at 1850×960 ≈ 29 %, A1L ≈ 42 % (r4-ux A-1 notes)', () => {
    expect(fitPage(A1P, 1850, 960).z).toBeCloseTo(936 / px(841), 9);
    expect(Math.round(fitPage(A1P, 1850, 960).z * 100)).toBe(29);
    expect(Math.round(fitPage(A1L, 1530, 960).z * 100)).toBe(42);
  });
  it('fit width fills the width; zoomAt keeps the cursor point; manual keeps the relative centre across papers', () => {
    const fw = fitWidth(A1P, 1000, 700);
    expect(px(594) * fw.z).toBeCloseTo(1000 - FIT_MARGIN_PX, 9);
    expect(fw.y).toBe(FIT_MARGIN_PX / 2);
    const v = { z: 0.4, x: 30, y: 50 };
    const z2 = zoomAt(v, 1, 300, 200);
    expect((300 - z2.x) / z2.z).toBeCloseTo((300 - v.x) / v.z, 9);
    expect((200 - z2.y) / z2.z).toBeCloseTo((200 - v.y) / v.z, 9);
    const manual = viewForMode('manual', A1L, 900, 600, { view: z2, paper: A1P, W: 900, H: 600 });
    const a = relativeCentre(z2, A1P, 900, 600);
    const b = relativeCentre(manual, A1L, 900, 600);
    expect(manual.z).toBe(1);
    expect(b.cx).toBeCloseTo(a.cx, 9);
    expect(b.cy).toBeCloseTo(a.cy, 9);
  });
  it('paper badge, screen scale, breakpoints', () => {
    expect(paperBadge(A1P)).toBe('A1P');
    expect(paperBadge(A1L)).toBe('A1L');
    expect(paperBadge({ w: 420, h: 297 })).toBe('420×297');
    expect(screenScale('1:50', 0.25)).toBe('1:200');
    expect(screenScale('NTS', 1)).toBeNull();
    expect(layoutForWidth(1850)).toBe('two-col');
    expect(layoutForWidth(960)).toBe('two-col');
    expect(layoutForWidth(959)).toBe('rail');
    expect(layoutForWidth(640)).toBe('rail');
    expect(layoutForWidth(639)).toBe('stacked');
  });
});

describe('selection by id', () => {
  it('keeps the id when it survives', () => {
    const l = refList();
    expect(resolveSelection(l, l.slice().reverse(), 'plan-hall-a')).toEqual({ id: 'plan-hall-a', reason: 'kept' });
  });
  it('a vanished rack-row face falls back to the nearest sheet of the same DU group', () => {
    const prev = refList();
    const next = prev.filter((m) => m.number !== '2-DU03-A-F');
    const r = resolveSelection(prev, next, 'relev-du03-a-f');
    expect(r.reason).toBe('sibling');
    expect(r.id).toBe('relev-du03-a-r');
  });
  it('a removed DU falls back to the nearest sheet of the same series (DU02 before DU04), never an unrelated series', () => {
    const prev = refList();
    const next = prev.filter((m) => !m.number.includes('DU03'));
    const r = resolveSelection(prev, next, 'relev-du03-a-f');
    expect(r.reason).toBe('series');
    expect(r.id).toBe('relev-du02-b-r');
    expect(seriesOf(next.find((m) => m.id === r.id)!)).toBe('200');
  });
  it('removing the first DU prefers another DU rack-row sheet over the adjacent 201 type sheet (QA Q2 case)', () => {
    const prev = refList();
    const next = prev.filter((m) => !m.number.includes('DU01'));
    const r = resolveSelection(prev, next, 'relev-du01-a-f');
    expect(r).toEqual({ id: 'relev-du02-a-f', reason: 'series' });
  });
  it('unknown id → first; empty list → none; wraps for [ / ]; prebuild order = selected, ±1, ±2', () => {
    const l = refList();
    expect(resolveSelection([], l, 'gone')).toEqual({ id: 'index', reason: 'first' });
    expect(resolveSelection(l, [], 'index')).toEqual({ id: null, reason: 'none' });
    const ids = l.map((m) => m.id);
    expect(stepId(ids, ids[0], -1)).toBe(ids[ids.length - 1]);
    expect(stepId(ids, ids[ids.length - 1], 1)).toBe(ids[0]);
    expect(prebuildOrder(ids, ids[3])).toEqual([ids[3], ids[4], ids[2], ids[5], ids[1]]);
    expect(prebuildOrder(ids, ids[0])).toEqual([ids[0], ids[1], ids[2]]);
  });
  it('LRU of 12 evicts the least recently used', () => {
    const c = new Lru<number>(12);
    for (let i = 0; i < 12; i++) c.set(`s${i}`, i);
    c.get('s0');
    c.set('s12', 12);
    expect(c.has('s0')).toBe(true);
    expect(c.has('s1')).toBe(false);
    expect(c.keys().length).toBe(12);
  });
});

describe('list grouping', () => {
  it('series → DU with F · R pairs on one row; DU node only for ≥ 2 rows; single hall = no hall level', () => {
    const { nodes, multiHall } = buildTree(refList());
    expect(multiHall).toBe(false);
    expect(nodes.map((n) => n.value)).toEqual(['000', '100', '200', '300', '400']);
    const s200 = nodes.find((n) => n.value === '200')!;
    const rows = flattenTree([s200], () => true);
    const du = rows.filter((r) => r.type === 'group' && r.level === 'du');
    expect(du.map((r) => r.type === 'group' && r.value)).toEqual(['DU01', 'DU02', 'DU03', 'DU04']);
    const pairs = rows.filter((r) => r.type === 'sheet' && r.faces);
    expect(pairs.length).toBe(8); // 4 DU × A/B, F and R share a row
    for (const p of pairs) if (p.type === 'sheet') expect(Object.keys(p.faces!).sort()).toEqual(['F', 'R']);
    // 201 (rack types) is not in a DU node
    expect(rows.some((r) => r.type === 'sheet' && r.primary.number === '201' && r.depth === 1)).toBe(true);
    // 301-H1-T01 alone: no DU node
    const s300 = flattenTree([nodes.find((n) => n.value === '300')!], () => true);
    expect(s300.filter((r) => r.type === 'group').length).toBe(1);
  });
  it('the face filter picks the default pill; counts cover every sheet', () => {
    const { nodes } = buildTree(refList(), 'R');
    const rows = flattenTree(nodes, () => true);
    const pair = rows.find((r) => r.type === 'sheet' && r.faces);
    expect(pair && pair.type === 'sheet' && pair.primary.number.endsWith('-R')).toBe(true);
    expect(nodes.reduce((n, s) => n + s.ids.length, 0)).toBe(refList().length);
  });
  it('multi-hall adds a hall level where a series spans halls; collapsed groups hide rows', () => {
    const l = [...refList(), plan('plan-hall-b', '102', 'hall-b'), rackRow('DU01', 'A', 'front', 'hall-b'), rackRow('DU01', 'A', 'rear', 'hall-b')];
    const { nodes, multiHall } = buildTree(l);
    expect(multiHall).toBe(true);
    const s100 = flattenTree([nodes.find((n) => n.value === '100')!], () => true);
    expect(s100.filter((r) => r.type === 'group' && r.level === 'hall').map((r) => r.type === 'group' && r.value)).toEqual(['hall-a', 'hall-b']);
    const closed = flattenTree(nodes, (_k, level) => level !== 'series');
    expect(closed.every((r) => r.type === 'group' && r.level === 'series')).toBe(true);
  });
  it('filters: series / DU / face / search (case-, separator- and Hangul-normalised)', () => {
    const l = refList();
    expect(filterSheets(l, { ...DEFAULT_FILTERS, series: '200', face: 'F' }).every((m) => m.number === '201' || m.number.endsWith('-F'))).toBe(true);
    expect(filterSheets(l, { ...DEFAULT_FILTERS, du: 'DU02' }).map((m) => m.number)).toEqual(['2-DU02-A-F', '2-DU02-A-R', '2-DU02-B-F', '2-DU02-B-R']);
    expect(filterSheets(l, { ...DEFAULT_FILTERS, q: 'du03a' }).map((m) => m.number)).toEqual(['2-DU03-A-F', '2-DU03-A-R']);
    expect(filterSheets(l, { ...DEFAULT_FILTERS, q: '  TRANSVERSE ' }).map((m) => m.number)).toEqual(['301-H1-T01']);
    const ko = { number: '2-DU01-A-F', title: '랙 행 입면도 — DU01 A (전면)' };
    expect(matchSheet(ko, '행입면')).toBe(true);
    expect(matchSheet(ko, '입면'.normalize('NFD'))).toBe(true); // decomposed jamo (macOS / some IMEs)
    expect(matchSheet(ko, 'ㄹㅎㅇㅁ')).toBe(true); // initial consonants
    expect(matchSheet(ko, 'ㅂㅂ')).toBe(false);
    expect(matchSheet(ko, 'ｄｕ０１')).toBe(true); // full-width folded
  });
  it('remembered state parses defensively', () => {
    expect(parseFilters('{bad')).toEqual(DEFAULT_FILTERS);
    expect(parseFilters(JSON.stringify({ series: '999', face: 'X', q: 5, hall: 'hall-a' }))).toEqual({ ...DEFAULT_FILTERS, hall: 'hall-a' });
    expect(parseListW('9999')).toBe(520);
    expect(parseListW('abc')).toBe(320);
    expect(parseListW('100')).toBe(260);
  });
});

describe('integration r4: the panel list / ZIP / print cover every sheet kind of the round', () => {
  it('drawingOptions requests every r4 key; the REF list has every kind; ZIP names are unique; only rack rows go under 200-rack-elevations/', () => {
    const ref = createNvidiaReferenceProject().project;
    const opts = drawingOptions(ref);
    expect([...(opts.sheets ?? [])].sort()).toEqual([...R4_DRAWING_SHEETS].sort());
    const metas = listDrawings(ref, analyzeProject(ref), opts);
    const kinds = new Set(metas.map((m) => m.kind));
    for (const k of ['index', 'site', 'plan', 'services-plan', 'enlarged-plan', 'rack-elevation', 'section', 'elevation', 'iso-systems', 'mep-iso', 'row-schematic', 'one-line']) expect(kinds.has(k as DrawingSheetMeta['kind']), k).toBe(true);
    // the ZIP (sheetJobs.zipSheets) and the SVG download name every sheet with rackElevationFileName
    const names = metas.map((m) => rackElevationFileName(m as unknown as DrawingSheet));
    expect(new Set(names).size).toBe(names.length);
    for (const m of metas) {
      const rackRow = m.kind === 'rack-elevation' && !!m.group && m.group.zone !== 'type';
      expect(rackElevationFileName(m as unknown as DrawingSheet).startsWith('200-rack-elevations/'), m.number).toBe(rackRow);
      expect(seriesOf(m), m.number).not.toBe('900');
    }
  }, 60_000);
});
