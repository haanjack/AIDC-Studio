// r4 sheet 001 — sheet index, symbols & keynote legend, abbreviations, general notes (spec §1.1). Owner: stream B0.
// ctx.sheetList holds the metadata of every sheet of this generation when build runs (listDrawings order).
import type { Locale } from '../model/types.ts';
import { calloutBoundary, calloutBubble, CALLOUT_INK, dimChain, equipmentTag, keynoteEllipse, levelDatum, PAPER_LW, positionTag, sectionMarker } from './annotate.ts';
import { stubSheetSvg, type DrawingSheetMeta, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { KEYNOTES } from './keynotes.ts';
import { categoryPlanStyle, INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR } from './palette.ts';
import { A1, A1L, sheetFrame, type SheetMeta } from './sheet.ts';
import { circle, fitText, hatchDef, line, MONO, n, path, polygon, rect, svgDocument, text, textWidth } from './svg.ts';
import { drawingUnitsOf, unitsNote } from './units.ts';

const TITLE = { en: 'Sheet index, symbols & general notes', ko: '도면 목록 · 기호 · 일반 주기' };

export function listIndexSheets(ctx: SheetContext): SheetEntry[] {
  return [
    {
      id: 'index',
      number: '001',
      title: TITLE[ctx.locale],
      kind: 'index',
      scale: 'NTS',
      zones: [],
      discipline: tr(ctx.locale, 'disciplineArch'),
      paper: A1L,
      build: (meta) => drawIndexSheet(ctx, meta),
    },
  ];
}

// ───────────────────────────── vocabulary ─────────────────────────────

const T = {
  sheetList: { en: 'Sheet index', ko: '도면 목록' },
  colNo: { en: 'No.', ko: '번호' },
  colTitle: { en: 'Title', ko: '제목' },
  colScale: { en: 'Scale', ko: '축척' },
  colPaper: { en: 'Paper', ko: '용지' },
  sheets: { en: 'sheets', ko: '매' },
  more: { en: 'more sheets not listed — see the Drawings panel', ko: '매 추가 — 도면 패널에서 확인' },
  symbols: { en: 'Symbol legend', ko: '기호 범례' },
  keynotes: { en: 'Keynote legend (full vocabulary)', ko: '키노트 범례 (전체)' },
  abbreviations: { en: 'Abbreviations', ko: '약어' },
  notes: { en: 'General notes', ko: '일반 주기' },
  numbering: { en: 'AIDC numbering; NCS type digits where compatible', ko: 'AIDC 번호 체계, 호환되는 곳은 NCS 유형 번호 사용' },
} as const;

const SERIES: Record<string, { en: string; ko: string }> = {
  '0': { en: '000 General', ko: '000 일반' },
  '1': { en: '100 Plans', ko: '100 평면도' },
  '2': { en: '200 Rack elevations', ko: '200 랙 입면도' },
  '3': { en: '300 Sections & elevations', ko: '300 단면도 · 입면도' },
  '4': { en: '400 Isometrics', ko: '400 등각 투영도' },
  '5': { en: '500 Details', ko: '500 상세도' },
  '6': { en: '600 Diagrams', ko: '600 계통도' },
  '9': { en: '900 User views', ko: '900 사용자 뷰' },
};

const ABBREVIATIONS: { a: string; en: string; ko: string }[] = [
  { a: 'AFF', en: 'Above finished floor', ko: '마감 바닥면 위' },
  { a: 'FFL', en: 'Finished floor level', ko: '마감 바닥 레벨' },
  { a: 'BW', en: 'Busway (A / B path)', ko: '버스웨이 (A / B 경로)' },
  { a: 'TO', en: 'Tap-off box', ko: '탭오프 박스' },
  { a: 'T1 / T2 / T3', en: 'Cable ladder tiers: scale-out / front-end + storage / OOB + main', ko: '케이블 래더 단: 스케일아웃 / 프런트엔드 + 스토리지 / OOB + 메인' },
  { a: 'CDU', en: 'Coolant distribution unit', ko: '냉각수 분배 장치' },
  { a: 'TCS', en: 'Technology cooling system (secondary liquid loop)', ko: '기술 냉각 계통 (2차 냉각수 루프)' },
  { a: 'EPIV', en: 'Electronic pressure-independent valve', ko: '전자식 압력 독립 밸브' },
  { a: 'DN', en: 'Nominal pipe diameter (mm)', ko: '배관 호칭 지름 (mm)' },
  { a: 'LC', en: 'Liquid-cooled rack (liquid fraction > 50 %)', ko: '수랭 랙 (수랭 비율 > 50 %)' },
  { a: 'RCU', en: 'Rack enclosure group of 2 or 4 racks', ko: '랙 2대 또는 4대 인클로저 그룹' },
  { a: 'HAC / CAC', en: 'Hot / cold aisle containment', ko: '열복도 / 냉복도 컨테인먼트' },
  { a: 'CRAH', en: 'Computer room air handler', ko: '전산실 공조기' },
  { a: 'DU / SU', en: 'Deployment unit (pod) / scalable unit', ko: '배치 단위 (포드) / 확장 단위' },
  { a: 'NET / ACC', en: 'Network rack / accelerator-slot rack', ko: '네트워크 랙 / 가속기 슬롯 랙' },
  { a: 'FE / OOB', en: 'Front-end network / out-of-band management', ko: '프런트엔드 네트워크 / 대역 외 관리' },
  { a: 'EIA / ORv3', en: 'EIA-310 19" rack / Open Rack V3 (21-inch OU) rack form factor', ko: 'EIA-310 19" 랙 / Open Rack V3(21인치 OU) 랙 폼팩터' },
  { a: 'UPS / PDU', en: 'Uninterruptible power supply / power distribution unit', ko: '무정전 전원 장치 / 전력 분배 장치' },
  { a: 'RCP', en: 'Reflected ceiling plan (overhead services)', ko: '천장 반사 평면 (오버헤드 설비)' },
  { a: 'NTS / TYP.', en: 'Not to scale / typical', ko: '축척 없음 / 동일 반복' },
  { a: 'NCS', en: 'US National CAD Standard (sheet type digits)', ko: '미국 National CAD Standard (시트 유형 번호)' },
];

/** stream E (P5): abbreviations added when the project carries a standards profile (legacy index sheets unchanged). */
const STANDARDS_ABBREVIATIONS: { a: string; en: string; ko: string }[] = [
  { a: 'OU', en: 'Open rack unit, 48 mm pitch (21-inch and wide OU racks)', ko: '오픈 랙 단위, 48 mm 피치 (21인치 · 와이드 OU 랙)' },
  { a: 'HPR', en: 'High-power rack power zone (33 kW shelves + BBU shelves)', ko: '고전력 랙 전원 구역 (33 kW 셸프 + BBU 셸프)' },
  { a: 'BBU', en: 'Battery backup unit (in-rack shelf)', ko: '배터리 백업 유닛 (랙 내 셸프)' },
  { a: 'BMQC / UQD', en: 'Blind-mate quick connector / universal quick disconnect', ko: '블라인드메이트 퀵 커넥터 / 범용 퀵 디스커넥트' },
  { a: 'FWS', en: 'Facility water system (primary loop)', ko: '시설수 계통 (1차 루프)' },
];

function generalNotes(ctx: SheetContext): string[] {
  const L = ctx.locale;
  const u = drawingUnitsOf(ctx.project);
  if (L === 'ko') {
    return [
      unitsNote(u, 'ko'),
      'AIDC 번호 체계를 따르며, 호환되는 곳은 NCS 시트 유형 번호를 사용한다 (0 일반 · 1 평면도 · 3 단면도/입면도 · 6 계통도). 200 랙 입면도와 400 시스템 등각도는 AIDC 고유 시리즈로 NCS 유형 2/4와 무관하다.',
      '위치 태그 <열 문자><번호>는 바닥 순서대로 모든 랙 자리(컴퓨트 · 네트워크 · 가속기 · 예비)를 센다. 미점유 간격과 인클로저 분리 구간에는 번호를 붙이지 않는다.',
      '색상은 랙 역할을 나타낸다. 폼팩터(EIA / ORv3)는 폼팩터 레이어의 태그 접미사로만 표기하며 채움색으로 바꾸지 않는다.',
      '각 시트는 사용한 키노트만 표기한다. 이 시트는 전체 키노트 어휘를 수록한다.',
      '"추정"으로 표시된 값(배관 구경, T3 레벨, 슬래브 두께 등)은 계획용 가정이므로 시공 전 확인해야 한다.',
      `AIDC Studio가 프로젝트 모델 ${ctx.project.id}.json에서 생성한 설계 조정용 도면이며 시공 도면이 아니다.`,
      '축척이 "—"인 시트는 생성 시 용지에 맞추어 축척이 정해진다.',
    ];
  }
  return [
    unitsNote(u, 'en'),
    'Sheet numbers follow AIDC numbering with NCS type digits where compatible (0 general · 1 plans · 3 sections / elevations · 6 diagrams). The 200 rack-elevation and 400 systems-isometric series are AIDC series, not NCS types 2 / 4.',
    'Position tags <row letter><position> count every rack slot in floor order (compute, network, accelerator, reserve). Unoccupied spacing and enclosure breaks take no number.',
    'Colour shows the rack role. Form factor (EIA / ORv3) is a tag suffix on the form-factor layer, never a fill.',
    'Each sheet lists only the keynotes it uses; this sheet lists the full vocabulary.',
    'Values tagged "estimate" (pipe sizes, T3 level, slab thickness) are planning assumptions; verify before construction.',
    `Generated by AIDC Studio from project model ${ctx.project.id}.json for design coordination, not for construction.`,
    'Sheets whose scale reads "—" are fitted to the paper when the sheet is built.',
  ];
}

const paperLabel = (p: { w: number; h: number }) => (p.w === A1.w && p.h === A1.h ? 'A1' : p.w === A1L.w && p.h === A1L.h ? 'A1L' : `${n(p.w, 0)}×${n(p.h, 0)}`);

/** Word wrap (spaces; long tokens are split by characters) for the approximate text metrics. */
export function wrapText(s: string, size: number, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  const pushToken = (tok: string) => {
    const next = cur ? `${cur} ${tok}` : tok;
    if (textWidth(next, size) <= maxW) {
      cur = next;
      return;
    }
    if (cur) lines.push(cur);
    cur = '';
    if (textWidth(tok, size) <= maxW) {
      cur = tok;
      return;
    }
    let part = '';
    for (const ch of tok) {
      if (textWidth(part + ch, size) > maxW && part) {
        lines.push(part);
        part = ch;
      } else part += ch;
    }
    cur = part;
  };
  for (const tok of s.split(/\s+/).filter(Boolean)) pushToken(tok);
  if (cur) lines.push(cur);
  return lines;
}

// ───────────────────────────── symbol legend cells ─────────────────────────────

interface SymbolCell {
  label: { en: string; ko: string };
  /** draws the symbol inside (x, y, 26 × 10 mm) */
  draw: (x: number, y: number) => string;
}

const MAGENTA = '#b0006d';

function symbols(hatchId: string): SymbolCell[] {
  const bwA = SYSTEM_COLOR['busway-a'];
  return [
    { label: { en: 'Keynote (see keynote legend)', ko: '키노트 (키노트 범례 참조)' }, draw: (x, y) => keynoteEllipse(x + 13, y + 5, '12').svg },
    { label: { en: 'Enlarged-plan / detail callout: number over sheet', ko: '확대 평면 / 상세 호출: 번호 / 시트' }, draw: (x, y) => calloutBoundary({ x: x + 1, y: y + 1.5, w: 13, h: 7 }) + calloutBubble(x + 20.5, y + 5, '1', '121', { r: 4.4 }).svg },
    { label: { en: 'Section marker: arrow = look direction', ko: '단면 표시: 화살표 = 보는 방향' }, draw: (x, y) => sectionMarker([x + 7, y + 6.5], [x + 19, y + 6.5], [0, -1], 'A', undefined, { r: 2.4 }).svg },
    { label: { en: 'Level datum (relative to FFL)', ko: '레벨 표시 (FFL 기준)' }, draw: (x, y) => levelDatum(x + 4, y + 7, '+2.73', '').svg },
    { label: { en: 'Dimension chain', ko: '치수 체인' }, draw: (x, y) => dimChain([x + 1.5, x + 12, x + 24.5], ['0.60', '1.20'], { axis: 'h', at: y + 7, size: 1.8 }).svg },
    {
      label: { en: 'Position tags outside the rack front', ko: '랙 전면 바깥의 위치 태그' },
      draw: (x, y) => {
        const st = categoryPlanStyle('gpu-rack');
        let s = '';
        for (let i = 0; i < 3; i++) {
          s += rect(x + 2 + i * 7.5, y + 1, 7.5, 4, { fill: st.fill, stroke: st.stroke, sw: PAPER_LW.hair });
          s += positionTag(x + 5.75 + i * 7.5, y + 7.6, `A0${i + 1}`, { size: 1.8 }).svg;
        }
        return s + line(x + 2, y + 5, x + 24.5, y + 5, { stroke: INK, sw: PAPER_LW.medium });
      },
    },
    {
      label: { en: 'Rack with equipment tag; heavy edge = front', ko: '장비 태그가 있는 랙, 굵은 변 = 전면' },
      draw: (x, y) => {
        const st = categoryPlanStyle('gpu-rack');
        return rect(x + 2, y + 2, 22, 5, { fill: st.fill, stroke: st.stroke, sw: PAPER_LW.thin }) + line(x + 2, y + 7, x + 24, y + 7, { stroke: INK, sw: PAPER_LW.heavy }) + equipmentTag({ x: x + 2, y: y + 2, w: 22, h: 5 }, 'DU01-A-07').svg;
      },
    },
    { label: { en: 'Busway with tap-off box', ko: '탭오프 박스가 있는 버스웨이' }, draw: (x, y) => rect(x + 1, y + 4, 24, 1.7, { fill: bwA, fillOpacity: 0.35, stroke: bwA, sw: PAPER_LW.thin }) + rect(x + 10, y + 2.6, 3.2, 4.5, { fill: '#fde5c8', stroke: '#c96f00', sw: PAPER_LW.thin }) },
    {
      label: { en: 'Busway end feed (feeder from switchboard)', ko: '버스웨이 끝단 급전 (배전반 피더)' },
      draw: (x, y) => rect(x + 8, y + 4, 17, 1.7, { fill: bwA, fillOpacity: 0.35, stroke: bwA, sw: PAPER_LW.thin }) + rect(x + 4.5, y + 2.5, 3.5, 4.7, { fill: PAPER, stroke: '#c96f00', sw: PAPER_LW.medium }) + line(x + 0.5, y + 4.85, x + 4.5, y + 4.85, { stroke: '#c96f00', sw: PAPER_LW.medium }) + path(`M${n(x + 3.2)} ${n(y + 3.8)} L${n(x + 4.5)} ${n(y + 4.85)} L${n(x + 3.2)} ${n(y + 5.9)}`, { stroke: '#c96f00', sw: PAPER_LW.thin }),
    },
    { label: { en: 'CDU (coolant distribution unit)', ko: 'CDU (냉각수 분배 장치)' }, draw: (x, y) => rect(x + 4, y + 1.5, 18, 7, { fill: categoryPlanStyle('cdu').fill, stroke: categoryPlanStyle('cdu').stroke, sw: PAPER_LW.thin }) + text(x + 13, y + 5, 'CDU', { size: 2.2, anchor: 'middle', baseline: 'central', weight: 700, fill: INK }) },
    {
      label: { en: 'TCS supply / return with EPIV (valve)', ko: 'EPIV(밸브)가 있는 TCS 공급 / 환수' },
      draw: (x, y) => {
        const s = SYSTEM_COLOR['cdu-supply'];
        const r = SYSTEM_COLOR['cdu-return'];
        return line(x + 1, y + 3, x + 25, y + 3, { stroke: s, sw: PAPER_LW.medium }) + line(x + 1, y + 7.5, x + 9.5, y + 7.5, { stroke: r, sw: PAPER_LW.medium }) + line(x + 16.5, y + 7.5, x + 25, y + 7.5, { stroke: r, sw: PAPER_LW.medium }) + polygon([[x + 9.5, y + 5.7], [x + 13, y + 7.5], [x + 9.5, y + 9.3]], { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }) + polygon([[x + 16.5, y + 5.7], [x + 13, y + 7.5], [x + 16.5, y + 9.3]], { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }) + line(x + 13, y + 7.5, x + 13, y + 5, { stroke: INK, sw: PAPER_LW.thin }) + circle(x + 13, y + 4.6, 0.7, { fill: INK });
      },
    },
    {
      label: { en: 'Door, single leaf, swing', ko: '문, 외여닫이' },
      draw: (x, y) => line(x + 1, y + 8, x + 8, y + 8, { stroke: INK, sw: PAPER_LW.heavy }) + line(x + 18, y + 8, x + 25, y + 8, { stroke: INK, sw: PAPER_LW.heavy }) + line(x + 8, y + 8, x + 8, y + 0.5, { stroke: INK, sw: PAPER_LW.thin }) + path(`M${n(x + 8)} ${n(y + 0.5)} A7.5 7.5 0 0 1 ${n(x + 15.5)} ${n(y + 8)}`, { stroke: INK_SOFT, sw: PAPER_LW.hair, dash: '0.8 0.5' }),
    },
    {
      label: { en: 'Door, double leaf, swing', ko: '문, 양여닫이' },
      draw: (x, y) => line(x + 1, y + 8, x + 5, y + 8, { stroke: INK, sw: PAPER_LW.heavy }) + line(x + 21, y + 8, x + 25, y + 8, { stroke: INK, sw: PAPER_LW.heavy }) + line(x + 5, y + 8, x + 5, y + 0.5, { stroke: INK, sw: PAPER_LW.thin }) + line(x + 21, y + 8, x + 21, y + 0.5, { stroke: INK, sw: PAPER_LW.thin }) + path(`M${n(x + 5)} ${n(y + 0.5)} A7.5 7.5 0 0 1 ${n(x + 12.5)} ${n(y + 8)}`, { stroke: INK_SOFT, sw: PAPER_LW.hair, dash: '0.8 0.5' }) + path(`M${n(x + 21)} ${n(y + 0.5)} A7.5 7.5 0 0 0 ${n(x + 13.5)} ${n(y + 8)}`, { stroke: INK_SOFT, sw: PAPER_LW.hair, dash: '0.8 0.5' }),
    },
    {
      label: { en: 'Sliding door (containment)', ko: '미닫이문 (컨테인먼트)' },
      draw: (x, y) => line(x + 1, y + 6, x + 5, y + 6, { stroke: INK, sw: PAPER_LW.heavy }) + line(x + 21, y + 6, x + 25, y + 6, { stroke: INK, sw: PAPER_LW.heavy }) + rect(x + 5, y + 4.6, 9, 1.1, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }) + rect(x + 12, y + 6.3, 9, 1.1, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }) + path(`M${n(x + 6)} ${n(y + 2.6)} L${n(x + 11)} ${n(y + 2.6)} M${n(x + 9.8)} ${n(y + 1.8)} L${n(x + 11)} ${n(y + 2.6)} L${n(x + 9.8)} ${n(y + 3.4)}`, { stroke: INK, sw: PAPER_LW.hair }),
    },
    { label: { en: 'Column (cut)', ko: '기둥 (절단)' }, draw: (x, y) => rect(x + 9.5, y + 1.5, 7, 7, { fill: '#b8bdc2', stroke: INK, sw: PAPER_LW.heavy }) + rect(x + 9.5, y + 1.5, 7, 7, { fill: `url(#${hatchId})`, stroke: 'none' }) },
    { label: { en: 'Structural grid bubble', ko: '구조 그리드 버블' }, draw: (x, y) => circle(x + 6, y + 5, 2.8, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }) + text(x + 6, y + 5, 'B', { size: 2.2, anchor: 'middle', baseline: 'central', weight: 600, fill: INK }) + line(x + 8.8, y + 5, x + 25, y + 5, { stroke: LINE_LIGHT, sw: PAPER_LW.hair, dash: '4 1 0.8 1' }) },
    { label: { en: 'Overhead element (dashed) / cut element (heavy)', ko: '상부 요소 (점선) / 절단 요소 (굵은 선)' }, draw: (x, y) => rect(x + 1.5, y + 2, 10, 6, { fill: 'none', stroke: INK_SOFT, sw: PAPER_LW.thin, dash: '1.6 0.8' }) + rect(x + 14.5, y + 2, 10, 6, { fill: '#e6e8ea', stroke: INK, sw: PAPER_LW.heavy }) },
    { label: { en: 'Unoccupied spacing / enclosure (RCU) break', ko: '미점유 간격 / 인클로저(RCU) 분리' }, draw: (x, y) => line(x + 7, y + 0.5, x + 7, y + 9.5, { stroke: MAGENTA, sw: PAPER_LW.medium, dash: '1.2 0.7' }) + line(x + 18, y + 2, x + 18, y + 8, { stroke: INK, sw: PAPER_LW.thin }) + line(x + 19.2, y + 2, x + 19.2, y + 8, { stroke: INK, sw: PAPER_LW.thin }) },
    {
      label: { en: 'Group bracket (LC run, RCU, A/B circuit, leaf group)', ko: '그룹 괄호 (LC 구간, RCU, A/B 회로, 리프 그룹)' },
      draw: (x, y) => path(`M${n(x + 2)} ${n(y + 3)} L${n(x + 2)} ${n(y + 5)} L${n(x + 24)} ${n(y + 5)} L${n(x + 24)} ${n(y + 3)}`, { stroke: CALLOUT_INK, sw: PAPER_LW.thin }) + text(x + 13, y + 8.4, 'LC ×10', { size: 1.8, anchor: 'middle', fill: CALLOUT_INK, weight: 600 }),
    },
  ];
}

// ───────────────────────────── the sheet ─────────────────────────────

export function drawIndexSheet(ctx: SheetContext, meta: SheetMeta): string | SheetBuildResult {
  const L: Locale = ctx.locale;
  const paper = meta.paper ?? A1L;
  const frame = sheetFrame(meta);
  const c = frame.content;
  if (!(c.w > 200 && c.h > 200)) return stubSheetSvg(meta);
  const defs = [...frame.defs];
  const hatchId = 'idx-hatch-cut';
  defs.push(hatchDef(hatchId, INK, 0.8, 0.18));
  const body = [...frame.body];
  const x0 = c.x + 8;
  const y0 = c.y + 10;
  const list: DrawingSheetMeta[] = ctx.sheetList.length ? ctx.sheetList : [{ id: 'index', number: meta.number, title: meta.title, kind: 'index', scale: meta.scale, paper }];

  body.push(`<g data-layer="notes">${text(x0, y0, meta.title, { size: 4.2, weight: 700, fill: INK })}${text(x0, y0 + 5.5, fitText(`${list.length} ${T.sheets[L]} · ${ctx.project.name} · ${T.numbering[L]}`, 2.4, c.w - 20), { size: 2.4, fill: INK_SOFT })}</g>`);

  // ── sheet list (1–3 columns) ──
  const listTop = y0 + 14;
  const rowH = 3.7;
  const headH = 6;
  const bottom = c.y + c.h - 8;
  type Row = { kind: 'series'; label: string } | { kind: 'sheet'; m: DrawingSheetMeta };
  const rows: Row[] = [];
  let lastSeries = '';
  for (const m of list) {
    const s = m.number.charAt(0);
    if (s !== lastSeries) {
      rows.push({ kind: 'series', label: (SERIES[s] ?? { en: `${s}00`, ko: `${s}00` })[L] });
      lastSeries = s;
    }
    rows.push({ kind: 'sheet', m });
  }
  const perCol = Math.max(8, Math.floor((bottom - listTop - headH) / rowH));
  const cols = Math.min(3, Math.max(1, Math.ceil(rows.length / perCol)));
  const colW = cols <= 2 ? 165 : 138;
  const capacity = cols * perCol;
  const shown = rows.length > capacity ? rows.slice(0, capacity - 1) : rows;
  const hidden = list.length - shown.filter((r) => r.kind === 'sheet').length;
  const numW = 30;
  const scaleW = 17;
  const paperW = 11;
  const titleW = colW - numW - scaleW - paperW - 3;
  const lst: string[] = [text(x0, listTop - 3, T.sheetList[L], { size: 3.2, weight: 700, fill: INK })];
  for (let ci = 0; ci < cols; ci++) {
    const cx = x0 + ci * colW;
    lst.push(rect(cx, listTop, colW - 3, headH, { fill: '#eef0f2', stroke: INK, sw: PAPER_LW.thin }));
    lst.push(text(cx + 1.5, listTop + 4.2, T.colNo[L], { size: 2.1, weight: 600, fill: INK }));
    lst.push(text(cx + numW + 1, listTop + 4.2, T.colTitle[L], { size: 2.1, weight: 600, fill: INK }));
    lst.push(text(cx + numW + titleW + 1.5, listTop + 4.2, T.colScale[L], { size: 2.1, weight: 600, fill: INK }));
    lst.push(text(cx + numW + titleW + scaleW + 1.5, listTop + 4.2, T.colPaper[L], { size: 2.1, weight: 600, fill: INK }));
  }
  shown.forEach((r, i) => {
    const ci = Math.floor(i / perCol);
    const ri = i % perCol;
    const cx = x0 + ci * colW;
    const ry = listTop + headH + ri * rowH;
    if (r.kind === 'series') {
      lst.push(rect(cx, ry + 0.3, colW - 3, rowH - 0.6, { fill: '#f5f6f7', stroke: 'none' }));
      lst.push(text(cx + 1.5, ry + rowH - 1, r.label, { size: 2.1, weight: 700, fill: INK }));
      return;
    }
    const m = r.m;
    const self = m.number === meta.number;
    lst.push(text(cx + 1.5, ry + rowH - 1, fitText(m.number, 2.0, numW - 2), { size: 2.0, weight: self ? 700 : 600, fill: INK, family: MONO }));
    lst.push(text(cx + numW + 1, ry + rowH - 1, fitText(m.title, 2.0, titleW - 1), { size: 2.0, weight: self ? 700 : 400, fill: INK }));
    lst.push(text(cx + numW + titleW + 1.5, ry + rowH - 1, fitText(m.scale, 2.0, scaleW - 2), { size: 2.0, fill: INK_SOFT }));
    lst.push(text(cx + numW + titleW + scaleW + 1.5, ry + rowH - 1, paperLabel(m.paper), { size: 2.0, fill: INK_SOFT }));
    lst.push(line(cx, ry + rowH, cx + colW - 3, ry + rowH, { stroke: LINE_LIGHT, sw: PAPER_LW.hair }));
  });
  if (hidden > 0) {
    const i = shown.length;
    const ci = Math.min(cols - 1, Math.floor(i / perCol));
    const ry = listTop + headH + (i % perCol) * rowH;
    lst.push(text(x0 + ci * colW + 1.5, ry + rowH - 1, `+${hidden} ${T.more[L]}`, { size: 2.0, italic: true, fill: INK_SOFT }));
  }
  body.push(`<g data-layer="sheet-list">${lst.join('')}</g>`);

  // ── right region: symbols, keynotes, abbreviations, notes flow top-to-bottom through 1–3 sub-columns ──
  const rx = x0 + cols * colW + 8;
  const rw = c.x + c.w - 8 - rx;
  const subN = Math.max(1, Math.min(3, Math.floor(rw / 150)));
  const subW = rw / subN;
  const top = listTop - 3;
  const maxY = c.y + c.h - 4;
  let col = 0;
  let cy = top;
  let overflow = false;
  /** reserve `h` mm in the flow; returns the block's x / y or null when the region is full */
  const take = (h: number): { x: number; y: number } | null => {
    if (cy + h > maxY) {
      if (col + 1 >= subN) {
        overflow = true;
        return null;
      }
      col++;
      cy = top;
    }
    const at = { x: rx + col * subW, y: cy };
    cy += h;
    return at;
  };
  const w = subW - 6;
  /** start the next section in a fresh sub-column when one is free (balances the region instead of filling column 0 only) */
  const breakCol = () => {
    if (cy > top + 1 && col + 1 < subN) {
      col++;
      cy = top;
    }
  };
  const heading = (s: string, out: string[], newCol = false) => {
    if (newCol) breakCol();
    if (cy > top + 1) take(4);
    const at = take(5);
    if (at) out.push(text(at.x, at.y + 3.2, s, { size: 3.2, weight: 700, fill: INK }));
  };

  // symbols
  const sym: string[] = [];
  heading(T.symbols[L], sym);
  const cellH = 11;
  const labelSize = w < 120 ? 1.9 : 2.1;
  for (const cell of symbols(hatchId)) {
    const at = take(cellH);
    if (!at) break;
    sym.push(rect(at.x, at.y, w, cellH - 1, { fill: PAPER, stroke: LINE_LIGHT, sw: PAPER_LW.hair }));
    sym.push(cell.draw(at.x + 1, at.y));
    const lines = wrapText(cell.label[L], labelSize, w - 32).slice(0, 2);
    lines.forEach((l, j) => sym.push(text(at.x + 30, at.y + (lines.length > 1 ? 4.4 : 6) + j * 2.8, l, { size: labelSize, fill: INK })));
  }
  body.push(`<g data-layer="legend">${sym.join('')}</g>`);

  // keynotes
  const kn: string[] = [];
  heading(T.keynotes[L], kn, subN >= 2);
  for (const k of KEYNOTES) {
    const at = take(4.6);
    if (!at) break;
    kn.push(keynoteEllipse(at.x + 3.5, at.y + 2.3, k.id).svg);
    kn.push(text(at.x + 8, at.y + 3, fitText(k.label[L], 2.1, w - 9), { size: 2.1, fill: INK }));
  }
  body.push(`<g data-layer="keynotes">${kn.join('')}</g>`);

  // abbreviations
  const ab: string[] = [];
  heading(T.abbreviations[L], ab);
  for (const a of ctx.project.standards ? [...ABBREVIATIONS, ...STANDARDS_ABBREVIATIONS] : ABBREVIATIONS) {
    const lines = wrapText(L === 'ko' ? a.ko : a.en, 2.0, w - 24);
    const at = take(lines.length * 2.9 + 1.1);
    if (!at) break;
    ab.push(text(at.x, at.y + 2.6, a.a, { size: 2.0, weight: 700, fill: INK }));
    lines.forEach((l, j) => ab.push(text(at.x + 22, at.y + 2.6 + j * 2.9, l, { size: 2.0, fill: INK })));
  }
  body.push(`<g data-layer="abbreviations">${ab.join('')}</g>`);

  // general notes
  const nt: string[] = [];
  heading(T.notes[L], nt, subN >= 3);
  const noteSize = 2.1;
  const lineH = 3.0;
  generalNotes(ctx).forEach((note, i) => {
    const lines = wrapText(note, noteSize, w - 5);
    const at = take(lines.length * lineH + 1.4);
    if (!at) return;
    nt.push(text(at.x, at.y + 2.6, `${i + 1}.`, { size: noteSize, weight: 700, fill: INK }));
    lines.forEach((l, j) => nt.push(text(at.x + 5, at.y + 2.6 + j * lineH, l, { size: noteSize, fill: INK })));
  });
  if (overflow) nt.push(text(c.x + c.w - 8, maxY + 2, L === 'ko' ? '(일부 범례 생략 — 공간 부족)' : '(legend truncated — not enough room)', { size: 1.8, anchor: 'end', italic: true, fill: INK_SOFT }));
  body.push(`<g data-layer="notes">${nt.join('')}</g>`);

  return { svg: svgDocument(paper.w, paper.h, defs, body, `${meta.number} ${meta.title}`) };
}
