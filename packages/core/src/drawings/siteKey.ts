// r4 sheet 002 — site key plan (spec §1.1, S12; outline level only). Owner: stream B1.
// Hall outlines at halls[].origin with per-hall IT MW (analysis design load, else the catalog nameplate sum), GPU and rack counts, pod
// footprints, hall-side electrical rooms, inter-hall gaps, north arrow and scale. The 5 MW → 20 MW → 100 MW → 1 GW tiling overlay and
// hall replicas are site mode (3차) and not drawn.
import { findCatalogItem } from '../catalog/catalog.ts';
import { buildPowerPlane } from '../engines/powerPaths.ts';
import type { DrawingViewport, Locale, Rect } from '../model/types.ts';
import { dimChain, LabelCuller, PAPER_LW, textBox } from './annotate.ts';
import { viewportWorldToPaper, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { INK, INK_SOFT, PAPER, RACK_CATEGORIES, SYSTEM_COLOR } from './palette.ts';
import { lenU, northArrow, scaleBar } from './plan.ts';
import { hallOutline } from './scene.ts';
import { A1L, sheetFrame, type SheetMeta } from './sheet.ts';
import { esc, fitText, line, polygon, rect, svgDocument, text } from './svg.ts';
import { fitViewport } from './toSvg.ts';
import { drawingUnitsOf } from './units.ts';

const TITLE = { en: 'Site key plan', ko: '사이트 키 플랜' };

const S = {
  sub: { en: 'Hall outlines at their site origins · IT load per hall · electrical rooms · {scale}', ko: '사이트 원점 기준 홀 외곽 · 홀별 IT 부하 · 전기실 · {scale}' },
  table: { en: 'Halls', ko: '홀' },
  hall: { en: 'Hall', ko: '홀' },
  itMw: { en: 'IT MW', ko: 'IT MW' },
  gpus: { en: 'GPUs', ko: 'GPU' },
  racks: { en: 'Racks', ko: '랙' },
  area: { en: 'Area m²', ko: '면적 m²' },
  budget: { en: 'Budget MW', ko: '예산 MW' },
  total: { en: 'Site total', ko: '사이트 합계' },
  empty: { en: 'no IT equipment', ko: 'IT 장비 없음' },
  notes: { en: 'Notes', ko: '주기' },
  noteDesign: { en: 'IT MW = design IT load per hall from the project analysis.', ko: 'IT MW = 프로젝트 분석의 홀별 설계 IT 부하.' },
  noteNameplate: { en: 'IT MW = catalog nameplate sum of the IT racks (no analysis cached).', ko: 'IT MW = IT 랙의 카탈로그 정격 합계 (분석 결과 없음).' },
  noteRooms: { en: 'Electrical rooms (switchboard + UPS lineups) are sized from the UPS blocks — estimate.', ko: '전기실(배전반 + UPS 라인업)은 UPS 블록 기준으로 산정한 추정값입니다.' },
  noteTiling: { en: 'Campus tiling 5 MW → 20 MW → 100 MW → 1 GW and hall replicas: site mode (phase 3) — not drawn.', ko: '캠퍼스 타일링 5 MW → 20 MW → 100 MW → 1 GW 및 홀 복제: 사이트 모드 (3차) — 미표시.' },
  noteOrigin: { en: 'Hall origins and sizes from the model; the site boundary and roads are not modelled.', ko: '홀 원점·크기는 모델 값이며, 부지 경계와 도로는 모델에 없습니다.' },
  gap: { en: 'gap', ko: '간격' },
};
const s = (L: Locale, k: keyof typeof S, vars: Record<string, string> = {}) => {
  let v: string = S[k][L === 'ko' ? 'ko' : 'en'];
  for (const [a, b] of Object.entries(vars)) v = v.replace(`{${a}}`, b);
  return v;
};

export function listSiteKeySheets(ctx: SheetContext): SheetEntry[] {
  if (!ctx.project.halls.length || ctx.opts.hallId) return [];
  return [
    {
      id: 'site-key',
      number: '002',
      title: TITLE[ctx.locale],
      kind: 'site',
      scale: '',
      zones: [],
      discipline: tr(ctx.locale, 'disciplineArch'),
      paper: A1L,
      build: (meta) => drawSiteKeyPlan(ctx, meta),
    },
  ];
}

export interface SiteHallSummary {
  hallId: string;
  name: string;
  itKW: number;
  source: 'analysis' | 'nameplate';
  gpus: number;
  racks: number;
  areaM2: number;
  budgetKW: number;
}

/** Per-hall IT kW (analysis design load, else catalog nameplate of IT racks), GPU / rack counts, area and budget. */
export function siteHallSummaries(ctx: SheetContext): SiteHallSummary[] {
  const { project, analysis } = ctx;
  return project.halls.map((h) => {
    const scene = ctx.scene(h.id);
    const ph = analysis?.power.perHall.find((x) => x.hallId === h.id);
    const nameplate = project.equipment.filter((e) => e.hallId === h.id).reduce((sum, e) => {
      const it = findCatalogItem(e.catalogId);
      return sum + (it && RACK_CATEGORIES.has(it.category) ? it.power?.nameplateKW ?? 0 : 0);
    }, 0);
    return { hallId: h.id, name: h.name, itKW: ph ? ph.itKW : nameplate, source: ph ? 'analysis' : 'nameplate', gpus: scene.gpuCount, racks: scene.racks.length, areaM2: h.width * h.depth, budgetKW: h.itPowerBudgetKW };
  });
}

const mw = (kw: number) => (kw / 1000).toFixed(kw >= 10000 ? 1 : 2);

export function drawSiteKeyPlan(ctx: SheetContext, meta: SheetMeta): SheetBuildResult {
  const { project, analysis, locale: L } = ctx;
  const units = drawingUnitsOf(project);
  const halls = project.halls;
  const rooms = analysis?.power.rooms ?? buildPowerPlane(project, analysis).rooms;
  const probe = sheetFrame(meta);
  const c = probe.content;
  const panelW = 250;
  const region = { x: c.x + 14, y: c.y + 26, w: c.w - panelW - 30, h: c.h - 26 - 30 };
  const origin = new Map(halls.map((h) => [h.id, h.origin]));
  const worldRects: Rect[] = halls.map((h) => ({ x: h.origin.x - 0.3, y: h.origin.y - 0.3, w: h.width + 0.6, d: h.depth + 0.6 }));
  for (const r of rooms) {
    const o = origin.get(r.hallId);
    if (o) worldRects.push({ x: o.x + r.rect.x, y: o.y + r.rect.y, w: r.rect.w, d: r.rect.d });
  }
  const x0 = Math.min(...worldRects.map((r) => r.x));
  const y0 = Math.min(...worldRects.map((r) => r.y));
  const x1 = Math.max(...worldRects.map((r) => r.x + r.w));
  const y1 = Math.max(...worldRects.map((r) => r.y + r.d));
  const pad = Math.max(4, 0.06 * Math.max(x1 - x0, y1 - y0));
  const world: Rect = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, d: y1 - y0 + 2 * pad };
  const { viewport: vp, scaleDen: den, scale } = fitViewport(world, region, { hallId: halls[0].id, space: 'plan', candidates: [100, 200, 250, 500, 1000, 1500, 2000, 2500, 5000, 10000], pad: 0 });
  meta.scale = scale;
  const frame = sheetFrame(meta);
  const body = [...frame.body];
  const P = (x: number, y: number) => viewportWorldToPaper(vp, x, y);
  const culler = new LabelCuller();
  const sums = siteHallSummaries(ctx);

  body.push(`<g data-layer="notes">${text(c.x + 8, c.y + 9, TITLE[L], { size: 4.2, weight: 700, fill: INK })}${text(c.x + 8, c.y + 15, s(L, 'sub', { scale }), { size: 2.4, fill: INK_SOFT })}</g>`);

  const outl: string[] = [];
  const pods: string[] = [];
  const tags: string[] = [];
  for (const h of halls) {
    const pts = hallOutline(h).map((p) => P(h.origin.x + p.x, h.origin.y + p.y));
    const sm = sums.find((x) => x.hallId === h.id)!;
    outl.push(polygon(pts, { fill: sm.racks ? '#f1f3f5' : '#f8f9fa', stroke: INK, sw: PAPER_LW.heavy }).replace('<polygon ', `<polygon data-hall="${esc(h.id)}" `));
    for (const pod of ctx.scene(h.id).pods) {
      const [ax, ay] = P(h.origin.x + pod.rect.x, h.origin.y + pod.rect.y + pod.rect.d);
      const w = pod.rect.w * vp.mmPerM;
      const d = pod.rect.d * vp.mmPerM;
      pods.push(rect(ax, ay, w, d, { fill: '#dde2e7', stroke: INK_SOFT, sw: PAPER_LW.hair }));
    }
  }
  // electrical rooms
  const roomEls: string[] = [];
  for (const r of rooms) {
    const o = origin.get(r.hallId);
    if (!o) continue;
    const [ax, ay] = P(o.x + r.rect.x, o.y + r.rect.y + r.rect.d);
    const w = r.rect.w * vp.mmPerM;
    const d = r.rect.d * vp.mmPerM;
    const col = r.side === 'B' ? SYSTEM_COLOR['busway-b'] : '#8a4f00';
    roomEls.push(rect(ax, ay, w, d, { fill: 'none', stroke: col, sw: PAPER_LW.thin, dash: '2 1' }).replace('<rect ', `<rect data-room="${esc(r.id)}" `));
    const label = `SWBD ${r.side}`;
    const box = textBox(ax + w / 2, ay + d / 2, label, 1.8, 'middle', 'central');
    if (box.w < w - 1 && box.h < d && culler.tryPlace(box)) roomEls.push(text(ax + w / 2, ay + d / 2, label, { size: 1.8, anchor: 'middle', baseline: 'central', fill: col, weight: 600 }));
  }
  // hall labels (centre, else above the outline)
  for (const h of halls) {
    const sm = sums.find((x) => x.hallId === h.id)!;
    const lines = [h.name, sm.racks ? `IT ${mw(sm.itKW)} MW` : s(L, 'empty'), ...(sm.racks ? [`${sm.gpus.toLocaleString('en-US')} ${s(L, 'gpus')} · ${sm.racks} ${s(L, 'racks')}`] : [])];
    const [cx, cy] = P(h.origin.x + h.width / 2, h.origin.y + h.depth / 2);
    const sizes = [3.0, 2.6, 2.2];
    const hgt = lines.length * 4.2;
    const tryBlock = (bx: number, by: number) => {
      const boxes = lines.map((l, i) => textBox(bx, by - hgt / 2 + 3 + i * 4.2, l, sizes[i], 'middle', 'central'));
      if (!boxes.every((b) => culler.fits(b))) return false;
      boxes.forEach((b) => culler.reserve(b));
      lines.forEach((l, i) => tags.push(text(bx, by - hgt / 2 + 3 + i * 4.2, l, { size: sizes[i], anchor: 'middle', baseline: 'central', weight: i < 2 ? 700 : 500, fill: i === 1 && sm.racks ? SYSTEM_COLOR['busway-a'] : INK }).replace('<text ', `<text data-hall-label="${esc(h.id)}" `)));
      return true;
    };
    const [, topY] = P(0, h.origin.y + h.depth);
    if (!tryBlock(cx, cy)) tryBlock(cx, topY - hgt / 2 - 2);
  }
  // inter-hall gaps (neighbours along x with a y overlap, then along y with an x overlap)
  const dims: string[] = [];
  const byX = [...halls].sort((a, b) => a.origin.x - b.origin.x);
  for (let i = 0; i + 1 < byX.length; i++) {
    const a = byX[i];
    const b = byX.slice(i + 1).find((q) => q.origin.y < a.origin.y + a.depth && a.origin.y < q.origin.y + q.depth);
    if (!b) continue;
    const g = b.origin.x - (a.origin.x + a.width);
    if (g <= 0.05) continue;
    const top = Math.min(a.origin.y + a.depth, b.origin.y + b.depth);
    const [pa, py] = P(a.origin.x + a.width, top);
    const [pb] = P(b.origin.x, top);
    const dc = dimChain([pa, pb], [lenU(g, units, den)], { axis: 'h', at: py + 6, from: py, culler });
    dims.push(dc.svg);
  }
  const byY = [...halls].sort((a, b) => a.origin.y - b.origin.y);
  for (let i = 0; i + 1 < byY.length; i++) {
    const a = byY[i];
    const b = byY.slice(i + 1).find((q) => q.origin.x < a.origin.x + a.width && a.origin.x < q.origin.x + q.width);
    if (!b) continue;
    const g = b.origin.y - (a.origin.y + a.depth);
    if (g <= 0.05) continue;
    const left = Math.max(a.origin.x, b.origin.x);
    const [px, pa] = P(left, a.origin.y + a.depth);
    const [, pb] = P(left, b.origin.y);
    const dc = dimChain([pb, pa], [lenU(g, units, den)], { axis: 'v', at: px - 6, from: px, culler });
    dims.push(dc.svg);
  }
  body.push(`<g data-layer="hall-outline">${outl.join('')}</g>`, `<g data-layer="racks">${pods.join('')}</g>`, `<g data-layer="electrical-rooms">${roomEls.join('')}</g>`, `<g data-layer="dimensions">${dims.join('')}</g>`, `<g data-layer="tags">${tags.join('')}</g>`);
  const sb = scaleBar(region.x, region.y + region.h + 10, vp.mmPerM, den, units);
  body.push(`<g data-layer="notes">${sb.svg}${northArrow(region.x + region.w - 8, region.y + 10, L)}</g>`);

  // right panel: hall table + notes
  const px = c.x + c.w - panelW - 6;
  let py = c.y + 26;
  const cols = [0, 70, 108, 144, 176, 214];
  const heads = [s(L, 'hall'), s(L, 'itMw'), s(L, 'gpus'), s(L, 'racks'), s(L, 'area'), s(L, 'budget')];
  const rowH = 5;
  const tbl: string[] = [text(px, py, s(L, 'table'), { size: 3, weight: 700, fill: INK })];
  py += 4;
  const tH = (sums.length + 2) * rowH + 2;
  tbl.push(rect(px, py, panelW, tH, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }), line(px, py + rowH + 1, px + panelW, py + rowH + 1, { stroke: INK, sw: PAPER_LW.thin }));
  heads.forEach((hd, i) => tbl.push(text(px + cols[i] + (i ? cols[i + 1] !== undefined ? cols[i + 1] - cols[i] - 2 : panelW - cols[i] - 2 : 2), py + 4, hd, { size: 2.0, weight: 700, fill: INK, anchor: i ? 'end' : 'start' })));
  const cell = (i: number, y: number, v: string, weight?: 600 | 700) => text(px + cols[i] + (i ? (cols[i + 1] ?? panelW) - cols[i] - 2 : 2), y, i ? v : fitText(v, 2.0, cols[1] - 4), { size: 2.0, fill: INK, anchor: i ? 'end' : 'start', weight });
  sums.forEach((sm, k) => {
    const y = py + rowH * (k + 2) - 0.6;
    tbl.push(`<g data-hall-row="${esc(sm.hallId)}">${[cell(0, y, sm.name), cell(1, y, mw(sm.itKW)), cell(2, y, sm.gpus.toLocaleString('en-US')), cell(3, y, String(sm.racks)), cell(4, y, Math.round(sm.areaM2).toLocaleString('en-US')), cell(5, y, mw(sm.budgetKW))].join('')}</g>`);
  });
  const ty = py + rowH * (sums.length + 2) - 0.6;
  const tot = (f: (x: SiteHallSummary) => number) => sums.reduce((a, x) => a + f(x), 0);
  tbl.push(line(px, ty - rowH + 1.4, px + panelW, ty - rowH + 1.4, { stroke: INK_SOFT, sw: PAPER_LW.hair }), cell(0, ty, s(L, 'total'), 700), cell(1, ty, mw(tot((x) => x.itKW)), 700), cell(2, ty, tot((x) => x.gpus).toLocaleString('en-US'), 700), cell(3, ty, String(tot((x) => x.racks)), 700), cell(4, ty, Math.round(tot((x) => x.areaM2)).toLocaleString('en-US'), 700), cell(5, ty, mw(tot((x) => x.budgetKW)), 700));
  py += tH + 10;
  const notes = [s(L, sums.some((x) => x.source === 'analysis') ? 'noteDesign' : 'noteNameplate'), s(L, 'noteRooms'), s(L, 'noteOrigin'), s(L, 'noteTiling')];
  tbl.push(text(px, py, s(L, 'notes'), { size: 3, weight: 700, fill: INK }));
  notes.forEach((t, i) => tbl.push(text(px, py + 5 + i * 4, fitText(`${i + 1}. ${t}`, 2.0, panelW), { size: 2.0, fill: INK })));
  body.push(`<g data-layer="notes">${tbl.join('')}</g>`);
  void (null as unknown as DrawingViewport);
  void tr;
  return { svg: svgDocument(A1L.w, A1L.h, frame.defs, body, `${meta.number} ${meta.title}`) };
}
