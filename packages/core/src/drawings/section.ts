// r4 sheets 301-Hn-T<k> (transverse section through pod k) and 302-Hn-L<r> (longitudinal section along row r), 1:50 A1L — stream B2.
//   301  plane ⟂ the row axis through the rack nearest the pod centre, depth = 1 rack pitch, window = pod ± 1.6 m (to the wall when
//        closer than 3.5 m). Cut slab (hatch) / racks / containment / pipes (circles) / busways / trays / ceiling + deck, beyond in thin
//        line; datum column (hp.datums: FFL, top of rack, containment, pipe, busway, T1–T3, light, ceiling, deck); clearance pairs (red
//        on breach) from sectionClearances; horizontal chain over the cut racks and the aisle (annotate).
//   302  plane ⟂ the row normal at the row centre, looking at the rear (the contained aisle), depth = to the next row face (≤ 6 m);
//        window = wall to wall when it fits at 1:50, else the row ± 1.5 m with break lines; position tags + gap, CDUs at the ends,
//        busway circuits, drops, columns, end walls and feeder sleeves come from the prims.
// Shared by 311 (containmentElevation.ts): clipDrawList (from plan.ts), placeOrthoViewport, orthoRegions, the key plan (keyPlan.ts), panelSection, keynoteTable,
// renderOrthoSheet. Sheets annotate in project.locale; dimensions follow project.drawingUnits.
import { detectRowGroups } from '../layout/rows.ts';
import type { DrawingCut, DrawingViewport, ElevationTarget, Hall, Rect, RowGroup } from '../model/types.ts';
import { resolveVerticals, hallRackHeight } from '../scene/datums.ts';
import { drawListHash, type DrawItem2D, type DrawList2D } from '../scene/drawList.ts';
import { primAabb, type HallPrims, type Prim } from '../scene/prims.ts';
import { projectSection, sectionDepth } from '../scene/project/section.ts';
import { fixtureHeight } from '../scene/shell.ts';
import { annotate, ANN_TEXT, CALLOUT_INK, crossRefNotes, DASH_DOT, keynoteEllipse, LabelCuller, PAPER_LW, textBox, type Annotation2D, type NoteSystem, type PaperBox } from './annotate.ts';
import { hallCode, pad2, slug, stubSheetSvg, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { keynoteLabel, keynotesUsed } from './keynotes.ts';
import { CONTAINMENT_COLOR, INK, INK_SOFT, LINE_LIGHT, PAPER } from './palette.ts';
import type { ScenePod } from './scene.ts';
import { A1L, sheetFrame, type SheetMeta } from './sheet.ts';
import { fitText, line, n, polygon, polyline, rect, svgDocument, text, textWidth, type Pt } from './svg.ts';
import { drawListToSvg, fitViewport } from './toSvg.ts';
import { drawingUnitsOf, fmtLength } from './units.ts';
import { viewportWorldToPaper } from './context.ts';
import { keyPlanInset, type KeyPlanMark } from './keyPlan.ts';
import { clipDrawList as clipPlanDrawList } from './plan.ts';

const T_TITLE = { en: 'Transverse section', ko: '횡단면도' };
const L_TITLE = { en: 'Longitudinal section', ko: '종단면도' };

const S = {
  en: {
    keyPlan: 'KEY PLAN',
    keynotes: 'KEYNOTES',
    notes: 'NOTES',
    clearances: 'CLEARANCE CHECKS',
    ok: 'OK',
    breach: 'BREACH',
    req: 'req.',
    cutAt: (axis: string, at: string, look: string, depth: string) => `Cut ⟂ ${axis} at ${axis} = ${at}, looking ${look} · depth ${depth}`,
    slabNote: 'Levels from FFL ±0.00 (top of slab). Slab drawn 0.30 thick (graphic, estimate).',
    tierNote: 'Service tiers: pipe, busway, T1, T2 existing rules; T3 estimate (Hall.verticals).',
    pipeNote: 'TCS pipes from the derived network (risers, headers, branches, valves; sizes estimate). Schedule: MEP piping iso.',
    clearNote: 'Clearance pairs: red = breach of the rule in the table (sources in brackets).',
    scaleNote: (s: string) => `Scale reduced to ${s} to fit the sheet.`,
    breakNote: 'Window broken at the break lines; walls beyond.',
    noRacks: 'No racks in this section',
    rackServices: 'Rack top → lowest service',
    feederBand: 'Rack top → feeder',
    contServices: 'Containment top → lowest service',
    servicesCeiling: 'Top service → ceiling',
    light: 'FFL → light fixture',
    clash: 'no clash',
    rearLook: 'looking at the rear (contained aisle)',
    frontLook: 'looking at the front',
    detailHead: 'DETAIL — SERVICE STACK ABOVE THE RACKS',
  },
  ko: {
    keyPlan: '키 플랜',
    keynotes: '키노트',
    notes: '주기',
    clearances: '이격 검토',
    ok: '적합',
    breach: '위반',
    req: '기준',
    cutAt: (axis: string, at: string, look: string, depth: string) => `${axis} = ${at} 에서 ${axis} 축 직교 절단, ${look} 방향 · 깊이 ${depth}`,
    slabNote: '레벨 기준 FFL ±0.00 (슬래브 상단). 슬래브 두께 0.30 표현 (도식, 추정).',
    tierNote: '서비스 단: 배관·버스웨이·T1·T2 기존 규칙, T3 추정 (Hall.verticals).',
    pipeNote: 'TCS 배관은 파생 배관망 (라이저·헤더·분기·밸브, 관경 추정). 배관 일람: 기계 배관 등각도 참조.',
    clearNote: '이격 치수: 빨간색 = 표의 기준 위반 (괄호 안 출처).',
    scaleNote: (s: string) => `시트에 맞추기 위해 축척을 ${s}로 줄임.`,
    breakNote: '파단선에서 창을 끊음; 벽은 그 너머.',
    noRacks: '이 단면에 랙이 없음',
    rackServices: '랙 상단 → 최하단 서비스',
    feederBand: '랙 상단 → 피더',
    contServices: '컨테인먼트 상단 → 최하단 서비스',
    servicesCeiling: '최상단 서비스 → 천장',
    light: 'FFL → 조명',
    clash: '간섭 없음',
    rearLook: '후면(컨테인먼트 통로) 방향',
    frontLook: '전면 방향',
    detailHead: '상세 — 랙 상부 서비스 단',
  },
} as const;

const BREACH_INK = '#c62828';
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

// ───────────────────────────── lister ─────────────────────────────

export function listSections(ctx: SheetContext): SheetEntry[] {
  const L = ctx.locale;
  const out: SheetEntry[] = [];
  for (const h of ctx.halls) {
    const code = hallCode(ctx.project, h.id);
    ctx.scene(h.id).pods.forEach((pod, k) => {
      out.push({
        id: `section-t-${h.id}-${slug(pod.id)}`,
        number: `301-${code}-T${pad2(k + 1)}`,
        title: `${T_TITLE[L]} — ${pod.name}`,
        kind: 'section',
        scale: '1:50',
        hallId: h.id,
        zones: [pod.rect],
        discipline: tr(L, 'disciplineArch'),
        paper: A1L,
        group: { hallId: h.id, zone: 'du', groupKey: pod.name, podId: pod.id },
        build: (meta) => drawTransverseSection(ctx, h, pod, meta, k),
      });
    });
  }
  for (const h of ctx.halls) {
    const code = hallCode(ctx.project, h.id);
    const pods = ctx.scene(h.id).pods;
    detectRowGroups(ctx.project, h).forEach((row, r) => {
      const pod = pods.find((p) => p.id === row.podId);
      out.push({
        id: `section-l-${h.id}-${slug(row.id)}`,
        number: `302-${code}-L${pad2(r + 1)}`,
        title: `${L_TITLE[L]} — ${row.id}`,
        kind: 'section',
        scale: '1:50',
        hallId: h.id,
        zones: pod ? [pod.rect] : [],
        discipline: tr(L, 'disciplineArch'),
        paper: A1L,
        group: { hallId: h.id, zone: row.kind === 'compute' ? 'du' : row.kind === 'network-core' ? 'network-core' : 'services', ...(pod ? { groupKey: pod.name } : {}), ...(row.podId ? { podId: row.podId } : {}), rowId: row.id },
        build: (meta) => drawLongitudinalSection(ctx, h, row, meta, r),
      });
    });
  }
  return out;
}

// ───────────────────────────── shared helpers (301 / 302 / 311) ─────────────────────────────

/** Clip a section / elevation list to a (u, z) window: the one plan.ts implementation (backlog T2 #8) with circles kept by centre. */
export function clipDrawList(list: DrawList2D, w: Rect): DrawList2D {
  return clipPlanDrawList(list, w, { circles: 'centre' });
}

/** paper margins (mm) around a section window: datum chain left, datum texts right, chain + slab below */
export const ORTHO_MARGIN_MM = { left: 30, right: 84, bottom: 26, top: 14 } as const;
export const ORTHO_RIGHT_PANEL_W = 150;
export const SECTION_SCALES = [50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

export interface PaperRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Title strip, main drawing region and right panel inside the content area of an A1L sheet. */
export function orthoRegions(c: PaperRect, rightW = ORTHO_RIGHT_PANEL_W): { title: { x: number; y: number }; main: PaperRect; right: PaperRect } {
  const right = { x: c.x + c.w - rightW - 4, y: c.y + 4, w: rightW, h: c.h - 8 };
  const main = { x: c.x + 6, y: c.y + 20, w: right.x - 8 - (c.x + 6), h: c.h - 26 };
  return { title: { x: c.x + 6, y: c.y + 9 }, main, right };
}

/** Largest scale of `dens` at which the window + margins fits `main`; the viewport is placed at the top-left of `main`. */
export function placeOrthoViewport(win: Rect, main: PaperRect, o: { hallId: string; space: 'section' | 'elevation'; dens: readonly number[]; cut?: DrawingCut; elevation?: ElevationTarget; center?: boolean }): { viewport: DrawingViewport; scaleDen: number; scale: string; fits: boolean } {
  const M = ORTHO_MARGIN_MM;
  let den = o.dens[o.dens.length - 1];
  let fits = false;
  for (const d of o.dens) {
    const k = 1000 / d;
    if (win.w * k + M.left + M.right <= main.w + 1e-6 && win.d * k + M.top + M.bottom <= main.h + 1e-6) {
      den = d;
      fits = true;
      break;
    }
  }
  const k = 1000 / den;
  const pw = Math.min(main.w, win.w * k + M.left + M.right);
  const ph = Math.min(main.h, win.d * k + M.top + M.bottom);
  const world: Rect = { x: win.x - M.left / k, y: win.y - M.bottom / k, w: win.w + (M.left + M.right) / k, d: win.d + (M.top + M.bottom) / k };
  const r = fitViewport(world, { x: o.center ? main.x + (main.w - pw) / 2 : main.x, y: main.y, w: pw, h: ph }, { hallId: o.hallId, space: o.space, scaleDen: den, ...(o.cut ? { cut: o.cut } : {}), ...(o.elevation ? { elevation: o.elevation } : {}) });
  return { ...r, fits };
}

/** (z0, z1) of a section window: slab underside − 0.05 … max(deck, highest datum) + 0.25. */
export function orthoZRange(hall: Hall, hp: HallPrims): { z0: number; z1: number } {
  const rv = resolveVerticals(hall, hallRackHeight(hp.prims));
  const top = Math.max(hall.clearHeight + Math.max(0, hall.ceilingPlenumHeight), ...hp.datums.map((d) => d.z));
  return { z0: r6(-rv.slabThicknessM - 0.05), z1: r6(top + 0.25) };
}

/** Wrap text into lines no wider than maxW (mm). */
export function wrapText(s: string, size: number, maxW: number): string[] {
  const words = s.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w;
    if (!cur || textWidth(t, size) <= maxW) cur = t;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => fitText(l, size, maxW));
}

/** Boxed panel section: bold title + wrapped rows (clipped at maxY). */
export function panelSection(x: number, y: number, w: number, maxY: number, title: string, rows: readonly { text: string; fill?: string; weight?: 400 | 700 }[], layer: string, size = 2.2): { svg: string; h: number } {
  const els: string[] = [];
  let yy = y + 4.6;
  els.push(text(x + 2, yy, title, { size: 2.6, weight: 700, fill: INK }));
  yy += 1.2;
  outer: for (const r of rows) {
    for (const ln of wrapText(r.text, size, w - 4)) {
      if (yy + size + 1.3 > maxY - 1.5) break outer;
      yy += size + 1.3;
      els.push(text(x + 2, yy, ln, { size, fill: r.fill ?? INK, ...(r.weight ? { weight: r.weight } : {}) }));
    }
  }
  const h = Math.min(maxY - y, yy - y + 2.2);
  return { svg: `<g data-layer="${layer}">${rect(x, y, w, h, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin })}${els.join('')}</g>`, h };
}

/** Keynote table of the ids used on a sheet. */
export function keynoteTable(x: number, y: number, w: number, maxY: number, ids: Iterable<string | undefined>, locale: 'en' | 'ko'): { svg: string; h: number } {
  const used = keynotesUsed(ids);
  if (!used.length) return { svg: '', h: 0 };
  const els: string[] = [text(x + 2, y + 4.6, S[locale].keynotes, { size: 2.6, weight: 700, fill: INK })];
  let yy = y + 6.4;
  for (const k of used) {
    if (yy + 4.6 > maxY - 1.5) break;
    const e = keynoteEllipse(x + 5.5, yy + 2.2, k.id);
    els.push(e.svg, text(x + 11, yy + 2.9, fitText(keynoteLabel(k.id, locale), 2.2, w - 13), { size: 2.2, fill: INK }));
    yy += 4.6;
  }
  const h = yy - y + 1.4;
  return { svg: `<g data-layer="panel-keynotes">${rect(x, y, w, h, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin })}${els.join('')}</g>`, h };
}

export type { KeyPlanMark } from './keyPlan.ts';

/** Key plan of an ortho sheet: the shared inset (keyPlan.ts) framed, with the hall's rows (scene prims) and containment. */
function orthoKeyPlan(ctx: SheetContext, hall: Hall, box: PaperRect, mark: KeyPlanMark): string {
  const rows = ctx.scene(hall.id).pods.flatMap((pod) => pod.rows.map((row) => (row.axis === 'x' ? { x: row.min, y: row.center - row.depth / 2, w: row.max - row.min, d: row.depth } : { x: row.center - row.depth / 2, y: row.min, w: row.depth, d: row.max - row.min })));
  return keyPlanInset(hall, box, mark, { title: S[ctx.locale].keyPlan, rows, containments: ctx.project.containments.filter((q) => q.hallId === hall.id) });
}

// ───────────────────────────── clearance rules ─────────────────────────────

export interface ClearanceCheck {
  id: 'rack-services' | 'feeder-band' | 'containment-services' | 'services-ceiling' | 'light-height';
  label: string;
  fromZ: number;
  toZ: number;
  valueM: number;
  requiredM: number;
  ok: boolean;
  /** source tag of the rule */
  source: string;
  /** u of the pair on the drawing */
  u: number;
}

const SERVICE_EMITTERS = new Set(['pipe', 'busway', 'tray', 'circuit']);

/**
 * Vertical clearance rules of a section (r4-model-gap §4.4):
 *  rack-services         lowest overhead service underside − rack top ≥ 0 (no clash; wall-audit overlap rule, existing)
 *  feeder-band           feeder underside − rack top ≥ 0.30 (wall-audit 'feeder-over-rack' band, existing)
 *  containment-services  lowest service underside over the aisle − containment top ≥ 0 (no clash, existing)
 *  services-ceiling      ceiling − top of the highest service ≥ Hall.verticals.topClearanceM (0.30 TIA-942-B, verify)
 *  light-height          light fixture ≥ 2.60 (TIA-942-B §6.4.2.4, standard) — when light prims exist
 */
export function sectionClearances(hall: Hall, hp: HallPrims, list: DrawList2D, locale: 'en' | 'ko'): ClearanceCheck[] {
  const T = S[locale];
  const byId = new Map(hp.prims.map((p) => [p.id, p]));
  const ext = (it: DrawItem2D) => (it.kind === 'rect' ? { u0: it.pts[0], u1: it.pts[0] + it.pts[2], z0: it.pts[1], z1: it.pts[1] + it.pts[3] } : it.kind === 'circle' ? { u0: it.pts[0] - it.pts[2], u1: it.pts[0] + it.pts[2], z0: it.pts[1] - it.pts[2], z1: it.pts[1] + it.pts[2] } : null);
  let rackTop = -Infinity;
  let ru0 = Infinity;
  let ru1 = -Infinity;
  let contTop = -Infinity;
  let cu0 = Infinity;
  let cu1 = -Infinity;
  const services: { p: Prim; e: NonNullable<ReturnType<typeof ext>> }[] = [];
  for (const it of list.items) {
    const p = it.primId ? byId.get(it.primId) : undefined;
    const e = ext(it);
    if (!p || !e) continue;
    if (p.emitter === 'rack' && it.role === 'cut') {
      rackTop = Math.max(rackTop, e.z1);
      ru0 = Math.min(ru0, e.u0);
      ru1 = Math.max(ru1, e.u1);
    } else if (p.emitter === 'containment-panel' || p.emitter === 'door') {
      if (p.layer === 'containment' || p.layer === 'containment-doors') {
        contTop = Math.max(contTop, e.z1);
        cu0 = Math.min(cu0, e.u0);
        cu1 = Math.max(cu1, e.u1);
      }
    } else if (SERVICE_EMITTERS.has(p.emitter) || p.emitter === 'feeder') services.push({ p, e });
  }
  const out: ClearanceCheck[] = [];
  if (!Number.isFinite(rackTop)) return out;
  const rv = resolveVerticals(hall, hallRackHeight(hp.prims));
  const over = (u0: number, u1: number) => services.filter((s) => s.e.u1 > u0 + 1e-6 && s.e.u0 < u1 - 1e-6 && s.e.z1 > rackTop - 0.6);
  const baseU = ru1 + 0.3;
  const svc = over(ru0, ru1).filter((s) => s.p.emitter !== 'feeder' && s.e.z0 >= rackTop - 0.6);
  if (svc.length) {
    const low = Math.min(...svc.map((s) => s.e.z0));
    out.push({ id: 'rack-services', label: `${T.rackServices} (${T.clash})`, fromZ: rackTop, toZ: low, valueM: r6(low - rackTop), requiredM: 0, ok: low - rackTop >= -1e-6, source: 'existing', u: 0 });
  }
  const feeders = over(ru0, ru1).filter((s) => s.p.emitter === 'feeder');
  if (feeders.length) {
    const low = Math.min(...feeders.map((s) => s.e.z0));
    out.push({ id: 'feeder-band', label: T.feederBand, fromZ: rackTop, toZ: low, valueM: r6(low - rackTop), requiredM: 0.3, ok: low - rackTop >= 0.3 - 1e-6, source: 'existing', u: 0 });
  }
  if (Number.isFinite(contTop)) {
    const cs = services.filter((s) => s.p.emitter !== 'feeder' && s.e.u1 > cu0 && s.e.u0 < cu1 && s.e.z1 > contTop - 0.6);
    if (cs.length) {
      const low = Math.min(...cs.map((s) => s.e.z0));
      out.push({ id: 'containment-services', label: `${T.contServices} (${T.clash})`, fromZ: contTop, toZ: low, valueM: r6(low - contTop), requiredM: 0, ok: low - contTop >= -1e-6, source: 'existing', u: 0 });
    }
  }
  const all = services.filter((s) => s.p.emitter !== 'feeder');
  if (all.length) {
    const top = Math.max(...all.map((s) => s.e.z1));
    const ceil = hall.clearHeight;
    out.push({ id: 'services-ceiling', label: T.servicesCeiling, fromZ: top, toZ: ceil, valueM: r6(ceil - top), requiredM: rv.topClearanceM, ok: ceil - top >= rv.topClearanceM - 1e-6, source: rv.topClearanceSource === 'existing' ? 'existing' : 'standard, verify', u: 0 });
  }
  if (hp.prims.some((p) => p.emitter === 'light')) {
    const zl = fixtureHeight(hall);
    out.push({ id: 'light-height', label: T.light, fromZ: 0, toZ: zl, valueM: r6(zl), requiredM: 2.6, ok: zl >= 2.6 - 1e-6, source: 'standard', u: 0 });
  }
  out.forEach((c, i) => (c.u = r6(baseU + 0.42 * i)));
  return out;
}

function drawClearances(checks: readonly ClearanceCheck[], vp: DrawingViewport, win: Rect, culler: LabelCuller, units: ReturnType<typeof drawingUnitsOf>, den: number): string {
  const els: string[] = [];
  checks.forEach((c, i) => {
    const u = Math.min(c.u, win.x + win.w - 0.25 - 0.42 * (checks.length - 1 - i));
    const [x, y0] = viewportWorldToPaper(vp, u, c.fromZ);
    const [, y1] = viewportWorldToPaper(vp, u, c.toZ);
    const ink = c.ok ? INK_SOFT : BREACH_INK;
    const sw = c.ok ? PAPER_LW.hair : PAPER_LW.medium;
    const t = (yy: number) => line(x - 0.8, yy + 0.8, x + 0.8, yy - 0.8, { stroke: ink, sw });
    const txt = `${fmtLength(c.valueM, units, den)}${c.ok ? '' : ' !'}`;
    const ym = (y0 + y1) / 2;
    const box = textBox(x - 1.2, ym, txt, ANN_TEXT.dim, 'middle', 'auto', -90);
    const label = culler.tryPlace(box) ? text(x - 1.2, ym, txt, { size: ANN_TEXT.dim, anchor: 'middle', fill: ink, rotate: -90, weight: c.ok ? 400 : 700 }) : '';
    els.push(`<g data-rule="${c.id}" data-status="${c.ok ? 'ok' : 'breach'}">${line(x, y0, x, y1, { stroke: ink, sw })}${t(y0)}${t(y1)}${label}</g>`);
  });
  return els.length ? `<g data-layer="clearances">${els.join('')}</g>` : '';
}

/** Zig-zag break line at u from z0 to z1 (paper). */
export function breakLine(vp: DrawingViewport, u: number, z0: number, z1: number, side: 'left' | 'right'): string {
  const [x, ya] = viewportWorldToPaper(vp, u, z0);
  const [, yb] = viewportWorldToPaper(vp, u, z1);
  const ym = (ya + yb) / 2;
  const pts: Pt[] = [[x, ya], [x, ym + 3], [x - 2, ym + 1], [x + 2, ym - 1], [x, ym - 3], [x, yb]];
  return `<g data-layer="notes" data-break="${side}">${polyline(pts, { stroke: INK, sw: PAPER_LW.medium })}</g>`;
}

// ───────────────────────────── generic section / elevation sheet ─────────────────────────────

export interface OrthoOverlay {
  svg: string;
  keynotes?: string[];
}

export interface OrthoSheetInput {
  ctx: SheetContext;
  hall: Hall;
  meta: SheetMeta;
  hp: HallPrims;
  /** unclipped projection */
  list: DrawList2D;
  /** (u, z) window */
  window: Rect;
  space: 'section' | 'elevation';
  dens: readonly number[];
  cut: DrawingCut;
  elevation?: ElevationTarget;
  heading: string;
  subheading: (scale: string) => string;
  keyPlan: KeyPlanMark;
  /** extra annotations (world) — receive the viewport and scale denominator */
  extraAnn?: (vp: DrawingViewport, den: number, list: DrawList2D) => Annotation2D[];
  /** overlays drawn above the geometry; must reserve their label boxes in `culler` */
  overlays?: (vp: DrawingViewport, den: number, list: DrawList2D, culler: LabelCuller) => OrthoOverlay;
  clearances?: boolean;
  noteSystems: NoteSystem[];
  notes: string[];
  /** optional second viewport below the main one (same projection, tighter window, larger scale) */
  detail?: { window: Rect; dens: readonly number[]; heading: (scale: string) => string };
}

export function renderOrthoSheet(o: OrthoSheetInput): SheetBuildResult {
  const { ctx, hall, meta, hp } = o;
  const L = ctx.locale;
  const T = S[L];
  const units = drawingUnitsOf(ctx.project);
  const paper = meta.paper ?? A1L;
  const probe = sheetFrame(meta);
  const reg = orthoRegions(probe.content);
  const list = clipDrawList(o.list, o.window);
  const placed = placeOrthoViewport(o.window, reg.main, { hallId: hall.id, space: o.space, dens: o.dens, cut: o.cut, center: true, ...(o.elevation ? { elevation: o.elevation } : {}) });
  const { viewport: vp, scaleDen: den, scale } = placed;
  meta.scale = scale;
  const frame = sheetFrame(meta);
  const culler = new LabelCuller();
  culler.reserve({ x: reg.right.x - 2, y: reg.right.y, w: reg.right.w + 4, h: reg.right.h });
  const titleBox = textBox(reg.title.x, reg.title.y, o.heading, 4, 'start');
  culler.reserve({ x: titleBox.x, y: titleBox.y, w: Math.max(titleBox.w, 200), h: titleBox.h + 6 });

  // optional detail viewport below the main one
  let detail: { vp: DrawingViewport; den: number; list: DrawList2D; head: string; hx: number; hy: number } | null = null;
  if (o.detail) {
    const top = vp.paperRect.y + vp.paperRect.h + 12;
    const region = { x: reg.main.x, y: top, w: reg.main.w, h: reg.main.y + reg.main.h - top };
    if (region.h > 60) {
      const dp = placeOrthoViewport(o.detail.window, region, { hallId: hall.id, space: o.space, dens: o.detail.dens, cut: o.cut, center: true, ...(o.elevation ? { elevation: o.elevation } : {}) });
      if (dp.fits) {
        const head = o.detail.heading(dp.scale);
        const hx = dp.viewport.paperRect.x;
        const hy = dp.viewport.paperRect.y - 3;
        const hb = textBox(hx, hy, head, 3, 'start');
        culler.reserve({ x: hb.x, y: hb.y, w: hb.w, h: hb.h + 2 });
        detail = { vp: dp.viewport, den: dp.scaleDen, list: clipDrawList(o.list, o.detail.window), head, hx, hy };
      }
    }
  }

  const clear = o.clearances ? sectionClearances(hall, hp, list, L) : [];
  const clearSvg = clear.length ? drawClearances(clear, vp, o.window, culler, units, den) : '';
  const ov = o.overlays?.(vp, den, list, culler) ?? { svg: '' };
  const ann = [...annotate(ctx.project, hp, list, { locale: L, units, scaleDen: den }), ...(o.extraAnn?.(vp, den, list) ?? [])];
  const r = drawListToSvg(list, ann, vp, { idPrefix: 'v1-', hp, culler });
  let detailSvg = '';
  const detailDefs: string[] = [];
  if (detail && o.detail) {
    const w = o.detail.window;
    const inZ = (a: Annotation2D) => {
      for (let i = 1; i < a.pts.length; i += 2) if (a.pts[i] < w.y - 0.05 || a.pts[i] > w.y + w.d + 0.05) return false;
      return true;
    };
    const dAnn = annotate(ctx.project, hp, detail.list, { locale: L, units, scaleDen: detail.den }).filter((a) => inZ(a) && !(a.kind === 'dim-chain' && a.axis === 'v'));
    const dr = drawListToSvg(detail.list, dAnn, detail.vp, { idPrefix: 'v2-', hp, culler });
    detailDefs.push(...dr.defs);
    detailSvg = `<g data-layer="view-title">${text(detail.hx, detail.hy, fitText(detail.head, 3, reg.main.w), { size: 3, weight: 700, fill: INK })}${line(detail.hx, detail.hy + 1.2, detail.hx + Math.min(reg.main.w, textWidth(detail.head, 3)), detail.hy + 1.2, { stroke: INK, sw: PAPER_LW.thin })}</g>${dr.svg}`;
  }

  // view title
  const head = `<g data-layer="view-title">${text(reg.title.x, reg.title.y, fitText(o.heading, 4, reg.main.w), { size: 4, weight: 700, fill: INK })}${text(reg.title.x, reg.title.y + 5, fitText(o.subheading(scale), 2.4, reg.main.w), { size: 2.4, fill: INK_SOFT })}${line(reg.title.x, reg.title.y + 1.4, reg.title.x + Math.min(reg.main.w, textWidth(o.heading, 4)), reg.title.y + 1.4, { stroke: INK, sw: PAPER_LW.medium })}</g>`;

  // right panel
  const px = reg.right.x;
  const pw = reg.right.w;
  const maxY = reg.right.y + reg.right.h;
  const panel: string[] = [];
  let y = reg.right.y;
  panel.push(orthoKeyPlan(ctx, hall, { x: px, y, w: pw, h: 86 }, o.keyPlan));
  y += 90;
  const kt = keynoteTable(px, y, pw, maxY, [...ann.map((a) => a.keynoteId), ...(ov.keynotes ?? [])], L);
  panel.push(kt.svg);
  if (kt.h) y += kt.h + 4;
  if (clear.length) {
    const rows = clear.map((c) => ({ text: `${c.ok ? T.ok : T.breach} · ${c.label}: ${fmtLength(c.valueM, units, den)} (${T.req} ≥ ${fmtLength(c.requiredM, units, den)}; ${c.source})`, fill: c.ok ? INK : BREACH_INK, weight: (c.ok ? 400 : 700) as 400 | 700 }));
    const cs = panelSection(px, y, pw, maxY, T.clearances, rows, 'panel-clearances');
    panel.push(cs.svg);
    y += cs.h + 4;
  }
  const refs = crossRefNotes(ctx.sheetList, o.noteSystems, L, hall.id).map((q) => q.text);
  const notes = [...refs, ...o.notes, ...(placed.fits && den === o.dens[0] ? [] : [T.scaleNote(scale)])];
  if (notes.length && y < maxY - 12) panel.push(panelSection(px, y, pw, maxY, T.notes, notes.map((t, i) => ({ text: `${i + 1}. ${t}` })), 'panel-notes').svg);

  const svg = svgDocument(paper.w, paper.h, [...frame.defs, ...r.defs, ...detailDefs], [...frame.body, head, r.svg, clearSvg, ov.svg, detailSvg, ...panel], `${meta.number} ${meta.title}`);
  return { svg, viewports: detail ? [vp, detail.vp] : [vp] };
}

// ───────────────────────────── 301 transverse section ─────────────────────────────

const lenOf = (project: SheetContext['project'], m: number) => fmtLength(m, drawingUnitsOf(project));

/**
 * The 301 cut of a pod: plane ⟂ the row axis through the rack nearest the pod centre, look +1, depth = one rack pitch, u window =
 * pod ± 1.6 m (to the wall slab when the wall is closer than 3.5 m). Shared with the 121 section markers (integration r4).
 */
export function transverseSectionCut(hp: HallPrims, hall: Hall, pod: Pick<ScenePod, 'id' | 'rect' | 'rows'>, label: string): { cut: DrawingCut; w0: number; w1: number } | null {
  const racks = hp.prims.filter((p) => p.emitter === 'rack' && p.podId === pod.id);
  if (!racks.length) return null;
  const axis: 'x' | 'y' = pod.rows[0]?.axis ?? (pod.rect.w >= pod.rect.d ? 'x' : 'y');
  const podMid = axis === 'x' ? pod.rect.x + pod.rect.w / 2 : pod.rect.y + pod.rect.d / 2;
  let best = racks[0];
  let bestD = Infinity;
  for (const p of [...racks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const b = primAabb(p);
    const c = axis === 'x' ? (b.min.x + b.max.x) / 2 : (b.min.y + b.max.y) / 2;
    if (Math.abs(c - podMid) < bestD - 1e-9) {
      bestD = Math.abs(c - podMid);
      best = p;
    }
  }
  const bb = primAabb(best);
  const at = r6(axis === 'x' ? (bb.min.x + bb.max.x) / 2 : (bb.min.y + bb.max.y) / 2);
  const pitch = r6(axis === 'x' ? bb.max.x - bb.min.x : bb.max.y - bb.min.y);
  const span = axis === 'x' ? hall.depth : hall.width;
  const t0 = axis === 'x' ? pod.rect.y : pod.rect.x;
  const t1 = t0 + (axis === 'x' ? pod.rect.d : pod.rect.w);
  let w0 = t0 - 1.6;
  let w1 = t1 + 1.6;
  if (w0 < 3.5) w0 = -0.45;
  if (span - w1 < 3.5) w1 = span + 0.45;
  const look: 1 | -1 = 1;
  // plane ⟂ axis; u = −look·y (axis 'x') · look·x (axis 'y')
  const uw = axis === 'x' ? { u0: r6(-w1), u1: r6(-w0) } : { u0: r6(w0), u1: r6(w1) };
  return { cut: { id: `section-t-${pod.id}`, label, hallId: hall.id, kind: 'pod-transverse', refId: pod.id, ...(best.refId ? { anchorId: best.refId } : {}), axis, at, look, depthM: pitch, window: uw }, w0, w1 };
}

/** 302 look direction: toward the row rear (the contained aisle). Shared with the 121 section markers (integration r4). */
export function longitudinalSectionLook(row: Pick<RowGroup, 'frontSign'>): 1 | -1 {
  return row.frontSign > 0 ? -1 : 1;
}

export function drawTransverseSection(ctx: SheetContext, hall: Hall, pod: ScenePod, meta: SheetMeta, k = 0): string | SheetBuildResult {
  const L = ctx.locale;
  const T = S[L];
  const hp = ctx.hallPrims(hall.id, 'pod');
  const label = `T${k + 1}`;
  const tc = transverseSectionCut(hp, hall, pod, `${label}–${label}`);
  if (!tc) return stubSheetSvg(meta, T.noRacks);
  const { cut, w0, w1 } = tc;
  const { axis, at, look } = cut;
  const pitch = cut.depthM;
  const uw = cut.window!;
  const list = projectSection(hp, cut, { outlines: 'painter' });
  const zr = orthoZRange(hall, hp);
  const win: Rect = { x: uw.u0, y: zr.z0, w: uw.u1 - uw.u0, d: zr.z1 - zr.z0 };
  const present = presentSystems(list, hp);
  // 1:20 detail of the service stack over the cut racks
  const primById = new Map(hp.prims.map((p) => [p.id, p]));
  const cutRacks = list.items.filter((it) => it.role === 'cut' && it.kind === 'rect' && primById.get(it.primId ?? '')?.emitter === 'rack');
  let detail: OrthoSheetInput['detail'];
  if (cutRacks.length) {
    const du0 = Math.min(...cutRacks.map((it) => it.pts[0])) - 0.5;
    const du1 = Math.max(...cutRacks.map((it) => it.pts[0] + it.pts[2])) + 0.5;
    const top = Math.max(...cutRacks.map((it) => it.pts[1] + it.pts[3]));
    const tiers = resolveVerticals(hall, hallRackHeight(hp.prims)).tiers;
    const tierTop = Math.max(top, ...tiers.map((t) => t.z + t.heightM));
    detail = { window: { x: r6(du0), y: r6(top - 0.45), w: r6(du1 - du0), d: r6(tierTop + 0.45 - (top - 0.45)) }, dens: [20, 25, 50], heading: (scale) => `${T.detailHead} · ${scale}` };
  }
  return renderOrthoSheet({
    ctx,
    hall,
    meta,
    hp,
    list,
    window: win,
    space: 'section',
    dens: SECTION_SCALES,
    cut,
    ...(detail ? { detail } : {}),
    heading: `${label}–${label} ${T_TITLE[L]} — ${pod.name}`,
    subheading: (scale) => `${T.cutAt(axis, lenOf(ctx.project, at), `+${axis}`, lenOf(ctx.project, pitch))} · ${scale}`,
    keyPlan: { highlight: [pod.rect], cut: { axis, at, t0: w0, t1: w1, look } },
    clearances: true,
    noteSystems: present,
    notes: [T.slabNote, T.tierNote, T.pipeNote, T.clearNote],
  });
}

/** Note systems present in a projected list (S11 cross-reference notes). */
export function presentSystems(list: DrawList2D, hp: HallPrims): NoteSystem[] {
  const layers = new Set(list.items.map((i) => i.layer));
  const out: NoteSystem[] = [];
  if (layers.has('busway-a') || layers.has('busway-b') || layers.has('circuits') || layers.has('tapoffs')) out.push('busway');
  if (layers.has('tray-t1') || layers.has('tray-t2') || layers.has('tray-t3') || layers.has('drops')) out.push('trays');
  if (layers.has('pipes') || layers.has('pipe-fittings')) out.push('pipes');
  if (layers.has('containment') || layers.has('containment-roof') || layers.has('containment-doors')) out.push('containment');
  if (layers.has('racks')) out.push('racks');
  if (list.items.some((i) => i.layer === 'cdu-crah' && hp.prims.find((p) => p.id === i.primId)?.meta?.category === 'cdu')) out.push('cdu');
  return out;
}

// ───────────────────────────── 302 longitudinal section ─────────────────────────────

export function drawLongitudinalSection(ctx: SheetContext, hall: Hall, row: RowGroup, meta: SheetMeta, r = 0): string | SheetBuildResult {
  const L = ctx.locale;
  const T = S[L];
  const hp = ctx.hallPrims(hall.id, 'pod');
  const members = hp.prims.filter((p) => p.rowId === row.id && (p.emitter === 'rack' || p.emitter === 'unit'));
  if (!members.length) return stubSheetSvg(meta, T.noRacks);
  const cutAxis: 'x' | 'y' = row.axis === 'x' ? 'y' : 'x';
  const look = longitudinalSectionLook(row);
  const span = row.axis === 'x' ? hall.width : hall.depth;
  const zr = orthoZRange(hall, hp);
  const reg = orthoRegions(sheetFrame(meta).content);
  const M = ORTHO_MARGIN_MM;
  const fullFits = (span + 0.9) * 20 + M.left + M.right <= reg.main.w && (zr.z1 - zr.z0) * 20 + M.top + M.bottom <= reg.main.h;
  const a0 = fullFits ? -0.45 : Math.max(-0.45, row.a0 - 1.5);
  const a1 = fullFits ? span + 0.45 : Math.min(span + 0.45, row.a1 + 1.5);
  const uOf = (a: number) => (cutAxis === 'y' ? look * a : -look * a);
  const uw = { u0: r6(Math.min(uOf(a0), uOf(a1))), u1: r6(Math.max(uOf(a0), uOf(a1))) };
  const label = `L${r + 1}`;
  const cut0: DrawingCut = { id: `section-l-${row.id}`, label: `${label}–${label}`, hallId: hall.id, kind: 'row-longitudinal', refId: row.id, axis: cutAxis, at: r6(row.center), look, depthM: 0, window: uw };
  const depth = r6(sectionDepth(hp, cut0, 'next-row'));
  const cut: DrawingCut = { ...cut0, depthM: depth };
  const list = projectSection(hp, cut, { outlines: 'painter' });
  const win: Rect = { x: uw.u0, y: zr.z0, w: uw.u1 - uw.u0, d: zr.z1 - zr.z0 };
  const breaks: { u: number; side: 'left' | 'right' }[] = [];
  if (a0 > -0.45 + 1e-6) breaks.push({ u: uOf(a0), side: uOf(a0) <= uOf(a1) ? 'left' : 'right' });
  if (a1 < span + 0.45 - 1e-6) breaks.push({ u: uOf(a1), side: uOf(a1) >= uOf(a0) ? 'right' : 'left' });
  const pod = ctx.scene(hall.id).pods.find((p) => p.id === row.podId);
  const tIn = row.axis === 'x' ? { t0: a0, t1: a1 } : { t0: a0, t1: a1 };
  const present = presentSystems(list, hp);
  return renderOrthoSheet({
    ctx,
    hall,
    meta,
    hp,
    list,
    window: win,
    space: 'section',
    dens: SECTION_SCALES,
    cut,
    heading: `${label}–${label} ${L_TITLE[L]} — ${row.id}${pod ? ` (${pod.name})` : ''}`,
    subheading: (scale) => `${T.cutAt(cutAxis, lenOf(ctx.project, row.center), `${look > 0 ? '+' : '−'}${cutAxis}`, lenOf(ctx.project, depth))} · ${T.rearLook} · ${scale}`,
    keyPlan: { highlight: [row.axis === 'x' ? { x: row.a0, y: row.center - 0.6, w: row.a1 - row.a0, d: 1.2 } : { x: row.center - 0.6, y: row.a0, w: 1.2, d: row.a1 - row.a0 }], cut: { axis: cutAxis, at: row.center, ...tIn, look } },
    clearances: true,
    extraAnn: (_vp, _den, l) => {
      // busway circuit labels (one per circuit prim, above its drawn extent)
      const out: Annotation2D[] = [];
      const seen = new Set<string>();
      const byId = new Map(hp.prims.map((p) => [p.id, p]));
      for (const it of l.items) {
        const p = it.primId ? byId.get(it.primId) : undefined;
        if (!p || p.emitter !== 'circuit' || !p.tag || seen.has(p.tag) || it.kind !== 'rect') continue;
        seen.add(p.tag);
        out.push({ kind: 'tag', pts: [it.pts[0] + it.pts[2] / 2, it.pts[1] + it.pts[3] + 0.1], text: p.tag, priority: 9, layer: 'tags', lodMin: 2, size: ANN_TEXT.tag });
      }
      return out;
    },
    overlays: (vp) => ({ svg: breaks.map((b) => breakLine(vp, b.u, zr.z0, zr.z1, b.side)).join('') }),
    noteSystems: present,
    notes: [T.slabNote, T.tierNote, T.pipeNote, T.clearNote, ...(breaks.length ? [T.breakNote] : [])],
  });
}

export { n as sectionNum };
