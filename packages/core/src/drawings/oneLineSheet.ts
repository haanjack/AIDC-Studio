// r4 sheet 611-Hn — power one-line per hall (spec §1.1, P1; DECISIONS-v2-2 §G). Owner: stream B1. NTS, A1L.
//   site one-line filtered to the hall (docs/svg/oneLine.ts filterOneLine): utility → transformers → LV switchgear A / B (+ generators)
//   → hall switchboards A / B (electrical rooms of the power plane) → UPS blocks (engines/powerPaths.ts upsSystems + assignBlocks;
//   2N by side, N on UPS A) → busway circuits folded by row ("DU01-A · A c1–c3 · 14 racks") with connected kW and loading %
//   → rack A / B cords (table per row). Ratings "<ampacity> A @ <V>"; breaker settings are not modelled.
// analysis = null: no site one-line and no UPS blocks (note); switchboards → circuits → cords still drawn from buildPowerPlane.
import { assignBlocks, buildPowerPlane, upsSystems, type PowerPlane, type UpsSystem } from '../engines/powerPaths.ts';
import { filterOneLine } from '../docs/svg/oneLine.ts';
import type { Hall, Locale, OneLineNode, Project, ProjectAnalysis } from '../model/types.ts';
import { crossRefNotes, PAPER_LW, rowLetter } from './annotate.ts';
import { hallCode, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR } from './palette.ts';
import { duName } from './plan.ts';
import { A1L, sheetFrame, type SheetMeta } from './sheet.ts';
import { esc, fitText, line, polyline, rect, svgDocument, text, type Pt } from './svg.ts';

const TITLE = { en: 'Power one-line diagram', ko: '전력 단선도' };

const S = {
  sub: { en: 'NTS · site one-line filtered to the hall → switchboards → UPS blocks → busway circuits (folded by {fold}) → rack cords', ko: 'NTS · 홀 기준 사이트 단선도 → 배전반 → UPS 블록 → 버스웨이 회로 ({fold} 단위 묶음) → 랙 코드' },
  foldRow: { en: 'row', ko: '열' },
  foldPod: { en: 'DU', ko: 'DU' },
  foldSide: { en: 'side', ko: '계통' },
  utility: { en: 'Utility', ko: '수전' },
  xfmr: { en: 'Transformers', ko: '변압기' },
  swgr: { en: 'LV switchgear', ko: '저압 배전반' },
  gen: { en: 'Generators', ko: '발전기' },
  swbd: { en: 'Hall switchboard', ko: '홀 배전반' },
  ups: { en: 'UPS block', ko: 'UPS 블록' },
  upsSide: { en: 'UPS', ko: 'UPS' },
  catcher: { en: 'Catcher UPS block', ko: '캐처 UPS 블록' },
  modules: { en: 'modules', ko: '모듈' },
  sections: { en: 'sections', ko: '섹션' },
  hallLoad: { en: 'hall load', ko: '홀 부하' },
  racks: { en: 'racks', ko: '랙' },
  unassigned: { en: 'Circuits (no UPS assignment)', ko: '회로 (UPS 배정 없음)' },
  more: { en: '+{n} more', ko: '+{n}개 더' },
  table: { en: 'Rack cords per row', ko: '열별 랙 전원 코드' },
  row: { en: 'Row', ko: '열' },
  dual: { en: 'A+B', ko: 'A+B' },
  onlyA: { en: 'A only', ko: 'A 단독' },
  onlyB: { en: 'B only', ko: 'B 단독' },
  circA: { en: 'A circ.', ko: 'A 회로' },
  circB: { en: 'B circ.', ko: 'B 회로' },
  worst: { en: 'Worst %', ko: '최대 %' },
  kw: { en: 'kW', ko: 'kW' },
  notes: { en: 'Notes', ko: '주기' },
  noteRating: { en: 'Ratings: busway {a} A @ {v} V; continuous limit {p} {l} % of rating.', ko: '정격: 버스웨이 {a} A @ {v} V; 연속 한도 {p} 정격의 {l} %.' },
  noteBreaker: { en: 'Breaker settings, selectivity, cable sizes and short-circuit ratings are not modelled.', ko: '차단기 설정, 선택 협조, 케이블 규격, 단락 정격은 모델링하지 않습니다.' },
  noteLoading: { en: 'Loading % = connected kW (normal state) ÷ continuous limit; red above 100 %.', ko: '부하율 % = 정상 상태 연결 kW ÷ 연속 한도; 100 % 초과는 빨간색.' },
  noteBlocks: { en: 'UPS blocks per circuit from assignBlocks: a rack\'s A and B cords sit on different blocks; the catcher block takes a failed block.', ko: 'UPS 블록 배정(assignBlocks): 한 랙의 A·B 코드는 서로 다른 블록; 캐처 블록이 고장 블록을 대체합니다.' },
  noteNoAnalysis: { en: 'No analysis cached: site one-line and UPS blocks omitted — run the analysis.', ko: '분석 결과 없음: 사이트 단선도와 UPS 블록 생략 — 분석을 실행하세요.' },
  noCircuits: { en: 'No busway circuits in this hall.', ko: '이 홀에는 버스웨이 회로가 없습니다.' },
};
const s = (L: Locale, k: keyof typeof S, vars: Record<string, string> = {}) => {
  let v: string = S[k][L === 'ko' ? 'ko' : 'en'];
  for (const [a, b] of Object.entries(vars)) v = v.replace(`{${a}}`, b);
  return v;
};

export function listOneLineSheets(ctx: SheetContext): SheetEntry[] {
  return ctx.halls
    .filter((h) => ctx.scene(h.id).racks.length > 0)
    .map((h) => ({
      id: `one-line-${h.id}`,
      number: `611-${hallCode(ctx.project, h.id)}`,
      title: `${TITLE[ctx.locale]} — ${h.name}`,
      kind: 'one-line' as const,
      scale: 'NTS',
      hallId: h.id,
      zones: [],
      discipline: tr(ctx.locale, 'disciplineMech'),
      paper: A1L,
      needsAnalysis: true,
      build: (meta: SheetMeta) => drawOneLineSheet(ctx, h, meta),
    }));
}

// ───────────────────────────── model (pure; tested) ─────────────────────────────

export interface OneLineBlock {
  id: string;
  side: UpsSystem['side'];
  modules: number;
  kva: number;
  /** connected kW of this hall's circuits assigned to the block */
  hallKW: number;
  /** switchgear sides feeding the block (one-line edges) */
  fedBy: ('A' | 'B')[];
}

export interface OneLineFold {
  key: string;
  /** UPS block id ('' = no assignment: analysis null, or no UPS on that side) */
  blockId: string;
  side: 'A' | 'B';
  label: string;
  circuitIds: string[];
  circuits: number[];
  racks: number;
  kw: number;
  limitKW: number;
  /** worst circuit loading in the fold (%) */
  worstPct: number;
  ampacityA: number;
}

export interface OneLineCordRow {
  rowId: string;
  label: string;
  racks: number;
  dual: number;
  singleA: number;
  singleB: number;
  circuitsA: number;
  circuitsB: number;
  kw: number;
  worstPct: number;
}

export interface HallOneLineModel {
  hallId: string;
  voltageV: number;
  profile: string;
  limitPct: number;
  redundancy: string;
  site: OneLineNode[];
  switchboards: { id: string; side: 'A' | 'B'; roomId: string; upsModules?: number; sections?: number }[];
  blocks: OneLineBlock[];
  folds: OneLineFold[];
  foldLevel: 'row' | 'pod' | 'side';
  rows: OneLineCordRow[];
}

const compact = (ks: number[]) => {
  const v = [...new Set(ks)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < v.length; ) {
    let j = i;
    while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++;
    parts.push(j - i >= 2 ? `c${v[i]}–c${v[j]}` : j > i ? `c${v[i]}, c${v[j]}` : `c${v[i]}`);
    i = j + 1;
  }
  return parts.join(', ');
};
export { compact as compactCircuits };

/** Circuit id → connected kW in the normal state: analysis busway paths when present, else the plane racks (dual cords split A / B). */
function circuitKW(plane: PowerPlane, analysis: ProjectAnalysis | null): Map<string, number> {
  const m = new Map<string, number>();
  const paths = analysis?.power.paths ?? [];
  for (const p of paths) if (p.kind === 'busway' && p.connectedKW !== undefined) m.set(p.id, p.connectedKW);
  if (m.size) return m;
  for (const r of plane.racks) {
    if (r.cord.sides === 2) {
      if (r.circuits.A) m.set(r.circuits.A, (m.get(r.circuits.A) ?? 0) + r.kw / 2);
      if (r.circuits.B) m.set(r.circuits.B, (m.get(r.circuits.B) ?? 0) + r.kw / 2);
    } else {
      const c = r.circuits[r.cord.side];
      if (c) m.set(c, (m.get(c) ?? 0) + r.kw);
    }
  }
  return m;
}

export function hallOneLineModel(project: Project, analysis: ProjectAnalysis | null, hall: Hall, opts: { maxFoldsPerColumn?: number } = {}): HallOneLineModel {
  const plane = buildPowerPlane(project, analysis);
  const pd = project.power;
  const eqById = new Map(project.equipment.map((e) => [e.id, e]));
  const circuits = plane.circuits.filter((c) => c.hallId === hall.id).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  const kwOf = circuitKW(plane, analysis);
  // UPS blocks
  let blocks: OneLineBlock[] = [];
  const blockOf = new Map<string, string>();
  let site: OneLineNode[] = [];
  if (analysis) {
    const hallEq = new Set(project.equipment.filter((e) => e.hallId === hall.id).map((e) => e.id));
    const hallBus = new Set(circuits.map((c) => c.buswayId));
    const f = filterOneLine(analysis.power.oneLine, { equipmentIds: hallEq, buswayIds: hallBus });
    site = f.nodes.filter((n) => n.kind === 'utility' || n.kind === 'transformer' || n.kind === 'switchgear' || n.kind === 'generator');
    const keptUps = new Set(f.nodes.filter((n) => n.kind === 'ups').map((n) => n.id));
    const systems = upsSystems(analysis).filter((u) => keptUps.has(u.id));
    const fedBy = (id: string) => (['A', 'B'] as const).filter((p) => analysis.power.oneLine.edges.some((e) => e.from === `swgr-${p}` && e.to === id));
    blocks = systems.map((u) => ({ id: u.id, side: u.side, modules: u.modules, kva: u.modules * u.unitKVA, hallKW: 0, fedBy: fedBy(u.id) }));
    const blockSys = systems.filter((u) => u.side === 'block');
    if (blockSys.length) {
      const all = assignBlocks(plane, pd.diversityFactor ?? 1, blockSys);
      for (const c of circuits) {
        const b = all.get(c.id);
        if (b) blockOf.set(c.id, b);
      }
    } else {
      const bySide = new Map(systems.filter((u) => u.side === 'A' || u.side === 'B').map((u) => [u.side, u.id]));
      for (const c of circuits) {
        const b = bySide.get(c.side) ?? (bySide.size === 1 && pd.upsRedundancy !== '2N' && pd.upsRedundancy !== '2N+1' ? [...bySide.values()][0] : undefined);
        if (b) blockOf.set(c.id, b);
      }
    }
    for (const c of circuits) {
      const b = blocks.find((x) => x.id === blockOf.get(c.id));
      if (b) b.hallKW += kwOf.get(c.id) ?? 0;
    }
  }
  const rooms = (analysis?.power.rooms ?? plane.rooms).filter((r) => r.hallId === hall.id);
  const switchboards = rooms
    .map((r) => ({ id: r.switchboardId, side: r.side, roomId: r.id, ...('upsModules' in r && r.upsModules !== undefined ? { upsModules: r.upsModules } : {}), ...('switchboardSections' in r && r.switchboardSections !== undefined ? { sections: r.switchboardSections } : {}) }))
    .sort((a, b) => a.side.localeCompare(b.side));

  // rows of the circuits' racks
  const rowOfCircuit = new Map<string, string>();
  const podOfRow = new Map<string, string | undefined>();
  for (const c of circuits) {
    const e = c.rackIds.map((id) => eqById.get(id)).find((x) => x?.rowId);
    const rowId = c.rowId ?? e?.rowId ?? c.buswayId;
    rowOfCircuit.set(c.id, rowId);
    podOfRow.set(rowId, e?.podId);
  }
  const rowLabel = (rowId: string) => `${duName(podOfRow.get(rowId)) || rowId}-${rowLetter(rowId)}`;
  const pct = (kw: number, lim: number) => (lim > 0 ? (kw / lim) * 100 : 0);
  const blockOrder = new Map(blocks.map((b, i) => [b.id, i]));
  const build = (level: HallOneLineModel['foldLevel']): OneLineFold[] => {
    const m = new Map<string, OneLineFold>();
    const rackSets = new Map<string, Set<string>>();
    for (const c of circuits) {
      const blockId = blockOf.get(c.id) ?? '';
      const rowId = rowOfCircuit.get(c.id)!;
      const grp = level === 'row' ? rowId : level === 'pod' ? podOfRow.get(rowId) ?? rowId : hall.id;
      const key = `${blockId}|${c.side}|${grp}`;
      let f = m.get(key);
      if (!f) {
        const label = level === 'row' ? rowLabel(rowId) : level === 'pod' ? duName(podOfRow.get(rowId)) || rowId : hall.name;
        f = { key, blockId, side: c.side, label, circuitIds: [], circuits: [], racks: 0, kw: 0, limitKW: 0, worstPct: 0, ampacityA: c.ampacityA };
        m.set(key, f);
        rackSets.set(key, new Set());
      }
      const kw = kwOf.get(c.id) ?? 0;
      f.circuitIds.push(c.id);
      f.circuits.push(c.circuit);
      f.kw += kw;
      f.limitKW += c.limitKW;
      f.worstPct = Math.max(f.worstPct, pct(kw, c.limitKW));
      for (const r of c.rackIds) rackSets.get(key)!.add(r);
    }
    for (const [k, f] of m) f.racks = rackSets.get(k)!.size;
    return [...m.values()].sort((a, b) => (blockOrder.get(a.blockId) ?? 99) - (blockOrder.get(b.blockId) ?? 99) || a.side.localeCompare(b.side) || a.label.localeCompare(b.label, 'en', { numeric: true }));
  };
  const maxPer = opts.maxFoldsPerColumn ?? 22;
  const colCount = (fs: OneLineFold[]) => {
    const n = new Map<string, number>();
    for (const f of fs) {
      const col = f.blockId || f.side;
      n.set(col, (n.get(col) ?? 0) + 1);
    }
    return Math.max(0, ...n.values());
  };
  let foldLevel: HallOneLineModel['foldLevel'] = 'row';
  let folds = build('row');
  if (colCount(folds) > maxPer) {
    foldLevel = 'pod';
    folds = build('pod');
    if (colCount(folds) > maxPer) {
      foldLevel = 'side';
      folds = build('side');
    }
  }

  // cords per row
  const rows = new Map<string, OneLineCordRow>();
  for (const r of plane.racks) {
    if (r.hallId !== hall.id || (!r.circuits.A && !r.circuits.B)) continue;
    const e = eqById.get(r.id);
    const rowId = (r.circuits.A ? rowOfCircuit.get(r.circuits.A) : undefined) ?? (r.circuits.B ? rowOfCircuit.get(r.circuits.B) : undefined) ?? e?.rowId ?? '—';
    if (!podOfRow.has(rowId)) podOfRow.set(rowId, e?.podId);
    let row = rows.get(rowId);
    if (!row) {
      row = { rowId, label: rowLabel(rowId), racks: 0, dual: 0, singleA: 0, singleB: 0, circuitsA: 0, circuitsB: 0, kw: 0, worstPct: 0 };
      rows.set(rowId, row);
    }
    row.racks++;
    row.kw += r.kw;
    if (r.cord.sides === 2) row.dual++;
    else if (r.cord.side === 'A') row.singleA++;
    else row.singleB++;
  }
  for (const c of circuits) {
    const row = rows.get(rowOfCircuit.get(c.id)!);
    if (!row) continue;
    if (c.side === 'A') row.circuitsA++;
    else row.circuitsB++;
    row.worstPct = Math.max(row.worstPct, pct(kwOf.get(c.id) ?? 0, c.limitKW));
  }
  return {
    hallId: hall.id,
    voltageV: plane.voltageV,
    profile: plane.rule.profile.toUpperCase(),
    limitPct: Math.round(plane.rule.continuousLimit * 100),
    redundancy: pd.upsRedundancy,
    site,
    switchboards,
    blocks,
    folds,
    foldLevel,
    rows: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })),
  };
}

// ───────────────────────────── drawing ─────────────────────────────

const SIDE_COL = { A: '#c46f00', B: SYSTEM_COLOR['busway-b'], C: INK_SOFT, block: INK } as const;
const fmt0 = (v: number) => Math.round(v).toLocaleString('en-US');

export function drawOneLineSheet(ctx: SheetContext, hall: Hall, meta: SheetMeta): SheetBuildResult {
  const L = ctx.locale;
  const { project, analysis } = ctx;
  const frame = sheetFrame(meta);
  const c = frame.content;
  const body = [...frame.body];
  const X0 = c.x + 8;
  const W = c.w - 16;
  const bottom = c.y + c.h - 4;

  // vertical budget: header 20 · site 3 ranks · switchboards · blocks · folds · table · notes
  const hasA = !!analysis;
  const yHead = c.y + 22;
  const rankH = 17;
  const ySite = yHead + 2;
  const ySwbd = hasA ? ySite + 3 * rankH : ySite;
  const yBlocks = ySwbd + rankH;
  const yFolds = (hasA ? yBlocks + rankH : ySwbd + rankH) + 4;
  const probeRows = hallOneLineModel(project, analysis, hall, { maxFoldsPerColumn: 999 }).rows.length;
  const tableRows = Math.min(probeRows, 24);
  const tableH = 8 + (tableRows + 1) * 4.2;
  const notesH = 5 + 5 * 3.6;
  const foldsH = bottom - notesH - tableH - 8 - yFolds;
  const pitch = 9.8;
  const model = hallOneLineModel(project, analysis, hall, { maxFoldsPerColumn: Math.max(3, Math.floor(foldsH / pitch)) });
  const foldLabel = model.foldLevel === 'row' ? s(L, 'foldRow') : model.foldLevel === 'pod' ? s(L, 'foldPod') : s(L, 'foldSide');

  body.push(`<g data-layer="notes">${text(c.x + 8, c.y + 9, `${TITLE[L]} — ${hall.name}`, { size: 4.2, weight: 700, fill: INK })}${text(c.x + 8, c.y + 15, `${s(L, 'sub', { fold: foldLabel })} · UPS ${model.redundancy}`, { size: 2.4, fill: INK_SOFT })}</g>`);

  const els: string[] = [];
  const BW = 74;
  const BH = 11;
  const box = (cx: number, y: number, w: number, lines: string[], color: string, attrs: string) => {
    const out = [rect(cx - w / 2, y, w, BH, { fill: PAPER, stroke: color, sw: PAPER_LW.medium }).replace('<rect ', `<rect ${attrs} `), rect(cx - w / 2, y, 1.6, BH, { fill: color, stroke: 'none' })];
    lines.slice(0, 2).forEach((l, i) => out.push(text(cx - w / 2 + 3, y + (i ? 8.6 : 4.4), fitText(l, i ? 1.8 : 2.1, w - 5), { size: i ? 1.8 : 2.1, weight: i ? undefined : 700, fill: i ? INK_SOFT : INK })));
    return out.join('');
  };
  const edge = (x1: number, y1: number, x2: number, y2: number, color: string, dash?: string) => {
    const my = y1 + (y2 - y1) / 2;
    const pts: Pt[] = Math.abs(x1 - x2) < 0.01 ? [[x1, y1], [x2, y2]] : [[x1, y1], [x1, my], [x2, my], [x2, y2]];
    return polyline(pts, { stroke: color, sw: PAPER_LW.thin, dash });
  };
  const sideX = (side: 'A' | 'B') => X0 + W * (side === 'A' ? 0.27 : 0.73);

  // site ranks
  const siteBottom: Record<'A' | 'B', number> = { A: 0, B: 0 };
  if (hasA) {
    const feeds = project.site.utility;
    for (const side of ['A', 'B'] as const) {
      const cx = sideX(side);
      const col = SIDE_COL[side];
      const utils = model.site.filter((n) => n.kind === 'utility' && n.path === side);
      const xf = model.site.find((n) => n.kind === 'transformer' && n.path === side);
      const sw = model.site.find((n) => n.kind === 'switchgear' && n.path === side);
      if (!sw) continue;
      utils.forEach((u, i) => {
        const feed = feeds.find((f) => `util-${f.id}` === u.id);
        const ux = cx + (i - (utils.length - 1) / 2) * (BW + 6);
        els.push(box(ux, ySite, BW, [`${s(L, 'utility')} ${side} · ${feed?.name ?? u.id}`, `${fmt0((u.ratingKVA ?? 0) / 1000)} MVA${feed ? ` · ${feed.voltageKV} kV` : ''}`], col, `data-node="${esc(u.id)}"`));
        els.push(edge(ux, ySite + BH, cx, ySite + rankH, col));
      });
      if (xf) {
        els.push(box(cx, ySite + rankH, BW, [`${s(L, 'xfmr')} ${side}`, `${fmt0(xf.ratingKVA ?? 0)} kVA`], col, `data-node="${esc(xf.id)}"`));
        els.push(edge(cx, ySite + rankH + BH, cx, ySite + 2 * rankH, col));
      }
      els.push(box(cx, ySite + 2 * rankH, BW, [`${s(L, 'swgr')} ${side}`, `${model.voltageV} V`], col, `data-node="${esc(sw.id)}"`));
      siteBottom[side] = ySite + 2 * rankH + BH;
    }
    const gen = model.site.find((n) => n.kind === 'generator');
    if (gen) {
      const gx = X0 + W / 2;
      const gy = ySite + rankH;
      els.push(box(gx, gy, BW, [`${s(L, 'gen')} (${project.power.generatorRedundancy})`, `${fmt0(gen.ratingKVA ?? 0)} kVA`], INK_SOFT, `data-node="${esc(gen.id)}"`));
      for (const side of ['A', 'B'] as const) if (siteBottom[side]) els.push(polyline([[gx, gy + BH], [gx, ySite + 2 * rankH + BH / 2], [sideX(side) + (side === 'A' ? BW / 2 : -BW / 2), ySite + 2 * rankH + BH / 2]], { stroke: INK_SOFT, sw: PAPER_LW.thin, dash: '1.6 0.8' }));
    }
  }

  // hall switchboards
  const swbdY = ySwbd;
  for (const sb of model.switchboards) {
    const cx = sideX(sb.side);
    const col = SIDE_COL[sb.side];
    if (siteBottom[sb.side]) els.push(edge(cx, siteBottom[sb.side], cx, swbdY, col));
    els.push(box(cx, swbdY, BW + 10, [`${s(L, 'swbd')} ${sb.side} · ${sb.id}`, [sb.upsModules !== undefined ? `${sb.upsModules} UPS ${s(L, 'modules')}` : '', sb.sections !== undefined ? `${sb.sections} ${s(L, 'sections')}` : ''].filter(Boolean).join(' · ') || sb.roomId], col, `data-node="${esc(sb.id)}" data-side="${sb.side}"`));
  }

  // columns: blocks (analysis) or sides (no analysis)
  type Col = { id: string; title: string[]; color: string; attrs: string; fedBy: ('A' | 'B')[]; dashed?: boolean };
  const cols: Col[] = [];
  if (hasA && model.blocks.length) {
    for (const b of model.blocks) {
      const isC = b.side === 'C';
      const title = isC ? s(L, 'catcher') : b.side === 'A' || b.side === 'B' ? `${s(L, 'upsSide')} ${b.side}` : `${s(L, 'ups')} ${b.id.replace(/^ups-/, '')}`;
      cols.push({ id: b.id, title: [`${title} · ${b.modules} × ${fmt0(b.kva / Math.max(1, b.modules))} kVA`, `${fmt0(b.kva)} kVA · ${s(L, 'hallLoad')} ${fmt0(b.hallKW)} kW`], color: isC ? INK_SOFT : b.side === 'A' || b.side === 'B' ? SIDE_COL[b.side] : INK, attrs: `data-block="${esc(b.id)}" data-block-kw="${Math.round(b.hallKW)}"`, fedBy: b.fedBy, dashed: isC });
    }
    if (model.folds.some((f) => !f.blockId)) cols.push({ id: '', title: [s(L, 'unassigned'), ''], color: INK_SOFT, attrs: 'data-block=""', fedBy: [] });
  } else {
    for (const side of ['A', 'B'] as const) if (model.folds.some((f) => f.side === side)) cols.push({ id: side, title: [], color: SIDE_COL[side], attrs: '', fedBy: [side] });
  }
  const colW = cols.length ? W / cols.length : W;
  const colX = (i: number) => X0 + colW * (i + 0.5);
  const swbdBottom = swbdY + BH;
  const foldEls: string[] = [];
  cols.forEach((col, i) => {
    const cx = colX(i);
    let busTop: number;
    if (hasA && model.blocks.length) {
      const w = Math.min(BW + 10, colW - 6);
      for (const side of col.fedBy) {
        const sb = model.switchboards.find((x) => x.side === side);
        if (sb) els.push(edge(sideX(side), swbdBottom, cx, yBlocks, SIDE_COL[side], col.dashed ? '1.6 0.8' : undefined));
      }
      if (col.title.length && col.title[0]) els.push(box(cx, yBlocks, w, col.title, col.color, col.attrs));
      busTop = yBlocks + BH;
    } else {
      const sb = model.switchboards.find((x) => x.side === col.id);
      busTop = sb ? swbdBottom : yFolds - 4;
      if (sb) void sb;
      busTop = model.switchboards.length ? swbdBottom : yFolds - 4;
      if (model.switchboards.length && Math.abs(sideX(col.id as 'A' | 'B') - cx) > 0.01) {
        els.push(edge(sideX(col.id as 'A' | 'B'), swbdBottom, cx, yFolds - 3, col.color));
        busTop = yFolds - 3;
      }
    }
    const fs = model.folds.filter((f) => (hasA && model.blocks.length ? f.blockId === col.id : f.side === col.id));
    const maxN = Math.max(1, Math.floor(foldsH / pitch));
    const shown = fs.slice(0, fs.length > maxN ? maxN - 1 : maxN);
    const fw = Math.min(118, colW - 8);
    const busX = cx - fw / 2 - 1.5;
    if (shown.length) foldEls.push(line(busX, busTop, busX, yFolds + (shown.length - 1) * pitch + 4.2, { stroke: col.color, sw: PAPER_LW.medium }), line(cx, busTop, busX, busTop, { stroke: col.color, sw: PAPER_LW.medium }));
    shown.forEach((f, k) => {
      const y = yFolds + k * pitch;
      const sc = SIDE_COL[f.side];
      const hot = f.worstPct > 100 + 1e-9;
      foldEls.push(line(busX, y + 4.2, busX + 1.5, y + 4.2, { stroke: sc, sw: PAPER_LW.thin }));
      foldEls.push(`<g data-fold="${esc(f.key)}" data-side="${f.side}" data-circuits="${esc(f.circuitIds.join(' '))}" data-racks="${f.racks}">${rect(cx - fw / 2, y, fw, 8.4, { fill: PAPER, stroke: sc, sw: PAPER_LW.thin })}${text(cx - fw / 2 + 1.5, y + 3.4, fitText(`${f.label} · ${f.side} ${compact(f.circuits)}`, 2.0, fw - 3), { size: 2.0, weight: 700, fill: sc })}${text(cx - fw / 2 + 1.5, y + 7.0, fitText(`${f.racks} ${s(L, 'racks')} · ${fmt0(f.kw)} kW · ${f.ampacityA} A`, 1.8, fw - 16), { size: 1.8, fill: INK_SOFT })}${text(cx + fw / 2 - 1.5, y + 7.0, `${Math.round(f.worstPct)} %`, { size: 1.8, anchor: 'end', weight: 700, fill: hot ? '#c62828' : INK })}</g>`);
    });
    if (fs.length > shown.length) foldEls.push(text(cx - fw / 2, yFolds + shown.length * pitch + 3.4, s(L, 'more', { n: String(fs.length - shown.length) }), { size: 2.0, fill: INK_SOFT, weight: 600 }));
  });
  if (!model.folds.length) foldEls.push(text(X0 + W / 2, yFolds + 6, s(L, 'noCircuits'), { size: 3, anchor: 'middle', fill: INK_SOFT }));
  body.push(`<g data-layer="electrical-rooms">${els.join('')}</g>`, `<g data-layer="circuits">${foldEls.join('')}</g>`);

  // cords table
  const ty = bottom - notesH - tableH;
  const heads = [s(L, 'row'), s(L, 'racks'), s(L, 'dual'), s(L, 'onlyA'), s(L, 'onlyB'), s(L, 'circA'), s(L, 'circB'), s(L, 'kw'), s(L, 'worst')];
  const cw = [34, 18, 16, 16, 16, 18, 18, 22, 20];
  const tw = cw.reduce((a, b) => a + b, 0);
  const tb: string[] = [text(X0, ty + 3, s(L, 'table'), { size: 2.6, weight: 700, fill: INK }), rect(X0, ty + 5, tw, (tableRows + 1) * 4.2 + 1.2, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin })];
  const cellX = (i: number) => X0 + cw.slice(0, i + 1).reduce((a, b) => a + b, 0) - 1.5;
  heads.forEach((h, i) => tb.push(text(i ? cellX(i) : X0 + 1.5, ty + 8.6, h, { size: 1.8, weight: 700, fill: INK, anchor: i ? 'end' : 'start' })));
  tb.push(line(X0, ty + 9.8, X0 + tw, ty + 9.8, { stroke: LINE_LIGHT, sw: PAPER_LW.hair }));
  model.rows.slice(0, tableRows).forEach((r, k) => {
    const y = ty + 13.4 + k * 4.2;
    const vals = [r.label, String(r.racks), String(r.dual), String(r.singleA), String(r.singleB), String(r.circuitsA), String(r.circuitsB), fmt0(r.kw), `${Math.round(r.worstPct)}`];
    tb.push(`<g data-cord-row="${esc(r.rowId)}">${vals.map((v, i) => text(i ? cellX(i) : X0 + 1.5, y, i ? v : fitText(v, 1.8, cw[0] - 2), { size: 1.8, anchor: i ? 'end' : 'start', fill: i === 8 && r.worstPct > 100 ? '#c62828' : INK })).join('')}</g>`);
  });
  if (model.rows.length > tableRows) tb.push(text(X0 + tw + 3, ty + 13.4 + (tableRows - 1) * 4.2, s(L, 'more', { n: String(model.rows.length - tableRows) }), { size: 1.8, fill: INK_SOFT }));

  // notes
  const amp = model.folds[0]?.ampacityA ?? 0;
  const notes = [s(L, 'noteRating', { a: String(amp), v: String(model.voltageV), p: model.profile, l: String(model.limitPct) }), s(L, 'noteLoading'), s(L, 'noteBreaker'), hasA ? s(L, 'noteBlocks') : s(L, 'noteNoAnalysis'), ...crossRefNotes(ctx.sheetList, ['busway'], L, hall.id).filter((x) => !x.ref.startsWith('611')).map((x) => x.text)];
  const ny = bottom - notesH + 4;
  tb.push(text(X0, ny, s(L, 'notes'), { size: 2.6, weight: 700, fill: INK }));
  notes.slice(0, 5).forEach((t, i) => tb.push(text(X0, ny + 4 + i * 3.6, fitText(`${i + 1}. ${t}`, 2.0, W), { size: 2.0, fill: INK })));
  body.push(`<g data-layer="notes">${tb.join('')}</g>`);
  return { svg: svgDocument(A1L.w, A1L.h, frame.defs, body, `${meta.number} ${meta.title}`) };
}
