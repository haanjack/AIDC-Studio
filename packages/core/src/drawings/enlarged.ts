// r4 sheet 121-DUnn — enlarged DU plan at 1:50 (spec §1.1). Owner: stream B1.
// Window = pod racks + units + containment, one aisle each side and the row-end doors (plan.ts enlargedWindow). buildHallPrims('pod')
// → projectPlan(window, floor cut 1.20 m) → clipped to the window → annotate (tags, position tags, per-rack chains, aisle widths,
// keynotes, section markers → 301 / 302) → drawListToSvg, plus RCU enclosures + gaps, containment / room doors, tap-off tags,
// form-factor suffixes. Right panel: key plan, legend, keynote table, S11 notes.
import type { DrawingCut, Hall, Locale, Rect } from '../model/types.ts';
import type { LayerId } from '../scene/layers.ts';
import { projectPlan } from '../scene/project/plan.ts';
import { crossRefNotes, keynoteEllipse, LabelCuller, PAPER_LW, CALLOUT_INK, DASH_DOT, annotate, textBox, type Annotation2D } from './annotate.ts';
import { keynotesUsed } from './keynotes.ts';
import { hallCode, sheetBaseMeta, slug, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { CONTAINMENT_COLOR, INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR, categoryPlanStyle } from './palette.ts';
import { b1t, clipDrawList, containmentDoorSymbols, enlargedWindow, formFactorGroup, gapMarks, GAP_INK, keyPlanInset, legendBox, lenU, northArrow, podFootprint, primRowSlots, rcuOutlines, roomDoorSymbols, scaleBar, slugId, sym, tapoffTags, vpBox, type LegendEntry } from './plan.ts';
import type { ScenePod } from './scene.ts';
import { longitudinalSectionLook, transverseSectionCut } from './section.ts';
import { A1L, pickScale, sheetFrame, type SheetMeta } from './sheet.ts';
import { circle, fitText, line, rect, svgDocument, text, textWidth as textW } from './svg.ts';
import { drawListToSvg, fitViewport, mixOnPaper, PAPER_STYLES } from './toSvg.ts';
import { drawingUnitsOf } from './units.ts';

const TITLE = { en: 'Enlarged DU plan', ko: 'DU 확대 평면도' };

const S = {
  sub: { en: '{scale} · floor cut +1.20 · overhead services dashed · window {w} × {d}', ko: '{scale} · 바닥 절단 +1.20 · 상부 설비 점선 · 범위 {w} × {d}' },
  racks: { en: 'racks', ko: '랙' },
  cdus: { en: 'CDUs', ko: 'CDU' },
  legend: { en: 'Legend', ko: '범례' },
  keynotes: { en: 'Keynotes', ko: '키노트' },
  notes: { en: 'Notes', ko: '주기' },
  rack: { en: 'Rack (role colour, front tick)', ko: '랙 (역할 색, 전면 표시)' },
  cdu: { en: 'CDU', ko: 'CDU' },
  containment: { en: 'Containment panel / door', ko: '컨테인먼트 패널 / 문' },
  rcu: { en: 'RCU enclosure (2 / 4 racks)', ko: 'RCU 인클로저 (랙 2 / 4대)' },
  gap: { en: 'Unoccupied spacing · enclosure break', ko: '미점유 간격 · 인클로저 구분' },
  bwA: { en: 'Busway A (overhead)', ko: '버스웨이 A (상부)' },
  bwB: { en: 'Busway B (overhead)', ko: '버스웨이 B (상부)' },
  tapoff: { en: 'Tap-off box + tag <position>-<side>', ko: '탭오프 박스 + 태그 <위치>-<계통>' },
  tray: { en: 'Cable ladder T1 / T2 (overhead)', ko: '케이블 래더 T1 / T2 (상부)' },
  pipe: { en: 'TCS supply / return (overhead, estimate)', ko: 'TCS 공급 / 환수 (상부, 추정)' },
  column: { en: 'Column / wall (cut)', ko: '기둥 / 벽 (절단)' },
  marker: { en: 'Section marker → 301 / 302', ko: '단면 표시 → 301 / 302' },
  position: { en: 'Position tag (gaps unnumbered)', ko: '위치 태그 (갭은 번호 없음)' },
  formNote: { en: 'Form factor (EIA / ORv3) not in the catalog for these racks — no suffix drawn.', ko: '이 랙들의 폼팩터(EIA / ORv3)는 카탈로그에 없어 표시하지 않습니다.' },
  formShown: { en: 'Rack tags carry the catalog form factor (EIA / ORv3) on the form-factor layer.', ko: '랙에 카탈로그 폼팩터(EIA / ORv3)를 폼팩터 레이어로 표시합니다.' },
  noteWindow: { en: 'Window: pod racks, units and containment, one aisle each side and the row-end doors; content beyond is cut at the frame.', ko: '범위: POD 랙·장비·컨테인먼트, 양측 통로 1개와 열 끝 문; 범위 밖은 테두리에서 잘립니다.' },
  matchLine: { en: 'MATCH LINE — SEE {n}', ko: '연결선 — {n} 참조' },
  noteEstimate: { en: 'Pipe routes and sizes, door types and tray tiers without model data are estimates (derived).', ko: '모델 데이터가 없는 배관 경로·규격, 문 형식, 트레이 단은 추정값(파생)입니다.' },
  noteDims: { en: 'Dimensions in metres (two decimals); chains: wall → rack runs / gaps → wall, per-rack pitch at 1:50.', ko: '치수 단위 m (소수 둘째 자리); 치수선: 벽 → 랙 열 / 갭 → 벽, 1:50에서 랙 피치 포함.' },
  noteDimsImp: { en: 'Dimensions in feet-inches; chains: wall → rack runs / gaps → wall, per-rack pitch at 1:50.', ko: '치수 단위 ft-in; 치수선: 벽 → 랙 열 / 갭 → 벽, 1:50에서 랙 피치 포함.' },
};
const s = (L: Locale, k: keyof typeof S, vars: Record<string, string> = {}) => {
  let v: string = S[k][L === 'ko' ? 'ko' : 'en'];
  for (const [a, b] of Object.entries(vars)) v = v.replace(`{${a}}`, b);
  return v;
};

export function listEnlargedPlans(ctx: SheetContext): SheetEntry[] {
  const out: SheetEntry[] = [];
  for (const h of ctx.halls) {
    const code = hallCode(ctx.project, h.id);
    for (const pod of ctx.scene(h.id).pods) {
      // backlog T2 #3: a window that does not fit the drawing region at 1:50 (the services zone of a large hall fell back to 1:100–1:150)
      // is split along its long axis into 1:50 windows 121-…-a / -b / …, joined by match lines. The first keeps the unsplit id.
      const wins = enlargedWindows(ctx, h, pod.id);
      const n = wins.length > 1 ? wins.length : 1;
      const base = `121-${ctx.multiHall ? `${code}-` : ''}${pod.name}`;
      const numbers = Array.from({ length: n }, (_, k) => (n > 1 ? `${base}-${partLetter(k)}` : base));
      for (let k = 0; k < n; k++) {
        out.push({
          id: `enlarged-${h.id}-${slug(pod.id)}${k > 0 ? `-${partLetter(k)}` : ''}`,
          number: numbers[k],
          title: `${TITLE[ctx.locale]} — ${pod.name}${n > 1 ? ` (${k + 1}/${n})` : ''}`,
          kind: 'enlarged-plan',
          scale: '1:50',
          hallId: h.id,
          zones: n > 1 ? [wins[k]] : [pod.rect],
          discipline: tr(ctx.locale, 'disciplineArch'),
          paper: A1L,
          group: { hallId: h.id, zone: 'du', groupKey: pod.name, podId: pod.id },
          build: (meta) => drawEnlargedPlan(ctx, h, pod, meta, n > 1 ? { windows: wins, index: k, numbers } : undefined),
        });
      }
    }
  }
  return out;
}

/** a, b, …, z, aa, ab, … */
export function partLetter(k: number): string {
  return k < 26 ? String.fromCharCode(97 + k) : `${partLetter(Math.floor(k / 26) - 1)}${String.fromCharCode(97 + (k % 26))}`;
}

/** Drawing region of a windowed plan sheet (A1 landscape, right panel 232 mm) less the 44 mm annotation margin (paper mm). */
export function windowedPlanArea(ctx: SheetContext): { w: number; h: number } {
  const probe = sheetFrame({ ...sheetBaseMeta(ctx), number: '121', title: '', scale: '', discipline: '', zones: [], sheetIndex: 1, sheetCount: 1, paper: A1L });
  const c = probe.content;
  return { w: c.w - ENLARGED_PANEL_W - 26 - ENLARGED_MARGIN_MM, h: c.h - 26 - 32 - ENLARGED_MARGIN_MM };
}

/**
 * Split a window along the axis that overflows the area at 1:`den` into equal parts that fit (edges on a 0.05 m grid). A window that fits,
 * or whose overflow is only across the split axis, is returned whole.
 */
export function splitPlanWindow(win: Rect, area: { w: number; h: number }, den: number): Rect[] {
  const mm = 1000 / den;
  const overX = (win.w * mm) / area.w;
  const overY = (win.d * mm) / area.h;
  if (overX <= 1 + 1e-9 && overY <= 1 + 1e-9) return [win];
  const alongX = overX >= overY;
  const lo = alongX ? win.x : win.y;
  const len = alongX ? win.w : win.d;
  const cap = (alongX ? area.w : area.h) / mm - 0.1;
  const k = Math.ceil(len / cap - 1e-9);
  if (k <= 1) return [win];
  const edges = Array.from({ length: k + 1 }, (_, i) => (i === 0 ? lo : i === k ? lo + len : Math.round((lo + (len * i) / k) * 20) / 20));
  return edges.slice(0, k).map((e0, i) => {
    const e1 = edges[i + 1];
    return alongX ? { x: e0, y: win.y, w: e1 - e0, d: win.d } : { x: win.x, y: e0, w: win.w, d: e1 - e0 };
  });
}

/** 1:50 windows of a pod's enlarged plan (one when the window fits). Row / rack prims exist at hall detail, so listing stays cheap. */
export function enlargedWindows(ctx: SheetContext, hall: Hall, podId: string): Rect[] {
  const hp = ctx.hallPrims(hall.id, 'hall');
  const pod = ctx.scene(hall.id).pods.find((p) => p.id === podId);
  const win = enlargedWindow(hp, hall, podId) ?? (pod ? { x: pod.rect.x - 1, y: pod.rect.y - 1, w: pod.rect.w + 2, d: pod.rect.d + 2 } : null);
  return win ? splitPlanWindow(win, windowedPlanArea(ctx), 50) : [];
}

const ENLARGED_PANEL_W = 232;
const ENLARGED_MARGIN_MM = 44;

/** One part of a split windowed plan: all windows, this index and the sheet numbers (match-line references). */
export interface PlanPart {
  windows: readonly Rect[];
  index: number;
  numbers: readonly string[];
  /** hall-plan continuation (101 parts): every row in the window is tagged and dimensioned, not only the pod's */
  hallWide?: boolean;
  title?: string;
}

/** Layers on 121 (no slab / ceiling / lights / floor marks / feeders / circuit bars). */
export const ENLARGED_LAYERS: readonly LayerId[] = ['walls', 'columns', 'doors', 'partitions', 'sleeves', 'racks', 'cdu-crah', 'containment', 'containment-roof', 'containment-doors', 'busway-a', 'busway-b', 'tapoffs', 'tray-t1', 'tray-t2', 'tray-t3', 'drops', 'pipes', 'pipe-fittings'];

/**
 * Section cuts marked on the enlarged plan: 301 transverse through the pod centre (plane ⟂ the row axis) and 302 longitudinal along
 * each row of the pod (plane ⟂ the row normal at the row centre). Targets are the listed 301 / 302 sheet numbers when present.
 */
export function enlargedPlanCuts(ctx: SheetContext, hall: Hall, podId: string): { cut: DrawingCut; target?: string }[] {
  const hp = ctx.hallPrims(hall.id, 'pod');
  const rows = hp.rows.filter((r) => r.podId === podId).sort((a, b) => a.center - b.center);
  const fp = podFootprint(hp, podId);
  if (!rows.length || !fp) return [];
  const axis = rows[0].axis;
  const find = (id: string) => ctx.sheetList.find((m) => m.id === id)?.number;
  const out: { cut: DrawingCut; target?: string }[] = [];
  const along = axis === 'x' ? fp.x + fp.w / 2 : fp.y + fp.d / 2;
  const t = find(`section-t-${hall.id}-${slug(podId)}`);
  // integration r4: the markers use the 301 / 302 sheets' own cut rules (position, axis, look, depth), so marker and section agree;
  // the marker line keeps its plan extent (no u window)
  const scenePod = ctx.scene(hall.id).pods.find((p) => p.id === podId);
  const tc = scenePod ? transverseSectionCut(hp, hall, scenePod, 'A–A') : null;
  const tCut: DrawingCut = tc
    ? { id: `cut-t-${podId}`, label: 'A–A', hallId: hall.id, kind: tc.cut.kind, refId: tc.cut.refId, anchorId: tc.cut.anchorId, axis: tc.cut.axis, at: tc.cut.at, look: tc.cut.look, depthM: tc.cut.depthM }
    : { id: `cut-t-${podId}`, label: 'A–A', hallId: hall.id, kind: 'pod-transverse', refId: podId, axis, at: Math.round(along * 1000) / 1000, look: 1, depthM: 0.6 };
  out.push({ cut: tCut, ...(t ? { target: t } : {}) });
  // QA r4 sheets: rows split at columns (pod-services-a, -a-c2, -a-c3) share one centre line; one marker per line (the first row's
  // 302), else the B / C / D bubbles and their sheet numbers were drawn on top of each other
  const seenLine = new Set<string>();
  rows.filter((r) => {
    const k = `${r.axis}:${Math.round(r.center * 1000)}:${longitudinalSectionLook(r)}`;
    if (seenLine.has(k)) return false;
    seenLine.add(k);
    return true;
  }).forEach((r, i) => {
    const target = find(`section-l-${hall.id}-${slug(r.id)}`);
    const letter = String.fromCharCode(66 + (i % 25));
    out.push({ cut: { id: `cut-l-${r.id}`, label: `${letter}–${letter}`, hallId: hall.id, kind: 'row-longitudinal', refId: r.id, axis: axis === 'x' ? 'y' : 'x', at: Math.round(r.center * 1000) / 1000, look: longitudinalSectionLook(r), depthM: 1.2 }, ...(target ? { target } : {}) });
  });
  return out;
}

export function drawEnlargedPlan(ctx: SheetContext, hall: Hall, pod: ScenePod, meta: SheetMeta, part?: PlanPart): SheetBuildResult {
  const L = ctx.locale;
  const project = ctx.project;
  const units = drawingUnitsOf(project);
  const hp = ctx.hallPrims(hall.id, 'pod');
  const win: Rect = part ? part.windows[part.index] : enlargedWindow(hp, hall, pod.id) ?? { x: pod.rect.x - 1, y: pod.rect.y - 1, w: pod.rect.w + 2, d: pod.rect.d + 2 };
  const hallWide = !!part?.hallWide;
  const probe = sheetFrame(meta);
  const c = probe.content;
  const panelW = ENLARGED_PANEL_W;
  const region = { x: c.x + 14, y: c.y + 26, w: c.w - panelW - 26, h: c.h - 26 - 32 };
  const margin = ENLARGED_MARGIN_MM;
  let den = 50;
  if (win.w * 20 > region.w - margin || win.d * 20 > region.h - margin) den = pickScale(win.w, win.d, region.w - margin, region.h - margin, [50, 75, 100, 150, 200, 250, 300, 400, 500]).ratio;
  const mm = 1000 / den;
  const paperRect = { x: region.x + (region.w - win.w * mm) / 2, y: region.y + (region.h - win.d * mm) / 2, w: win.w * mm, h: win.d * mm };
  const { viewport: vp, scale } = fitViewport(win, paperRect, { hallId: hall.id, space: 'plan', scaleDen: den, pad: 0 });
  meta.scale = scale;
  const frame = sheetFrame(meta);
  const defs = [...frame.defs];
  const body = [...frame.body];
  const prefix = `en-${slugId(hall.id)}-${slugId(pod.id)}-`;
  const culler = new LabelCuller();

  // header
  const inWin = (p: { a: { x: number; y: number }; b: { x: number; y: number } }) => (p.a.x + p.b.x) / 2 >= win.x && (p.a.x + p.b.x) / 2 <= win.x + win.w && (p.a.y + p.b.y) / 2 >= win.y && (p.a.y + p.b.y) / 2 <= win.y + win.d;
  const podRacks = hp.prims.filter((p) => p.emitter === 'rack' && (hallWide ? inWin(p) : p.podId === pod.id)).length;
  const podRows = new Set(hp.rows.filter((r) => hallWide || r.podId === pod.id).map((r) => r.id));
  const cdus = hp.prims.filter((p) => p.emitter === 'unit' && p.meta?.category === 'cdu' && (p.podId === pod.id || (p.rowId && podRows.has(p.rowId)))).length;
  body.push(`<g data-layer="notes">${text(c.x + 8, c.y + 9, part?.title ?? `${TITLE[L]} — ${pod.name}${part ? ` (${part.index + 1}/${part.windows.length})` : ''} · ${hall.name}`, { size: 4.2, weight: 700, fill: INK })}${text(c.x + 8, c.y + 15, `${s(L, 'sub', { scale, w: lenU(win.w, units, den), d: lenU(win.d, units, den) })} · ${podRacks} ${s(L, 'racks')} · ${cdus} ${s(L, 'cdus')}`, { size: 2.4, fill: INK_SOFT })}</g>`);

  // geometry + annotations
  const raw = projectPlan(hp, { window: win, mode: 'floor', layers: [...ENLARGED_LAYERS] });
  const list = clipDrawList(raw, win);
  const cuts = hallWide ? [] : enlargedPlanCuts(ctx, hall, pod.id);
  const primById = new Map(hp.prims.map((p) => [p.id, p]));
  const inPod = (id?: string) => {
    const p = id ? primById.get(id) : undefined;
    return hallWide || !p || p.podId === pod.id || (!!p.rowId && podRows.has(p.rowId));
  };
  // only this pod's rows are tagged and dimensioned (the facing rows beyond the aisles are context)
  const annAll = annotate(project, hp, list, { locale: L, units, scaleDen: den, window: win, lod: 3, cuts, layers: ['tags', 'position-tags', 'dimensions', 'keynotes', 'notes'] }).filter((a) => {
    if (a.kind === 'dim-chain') return !a.refId || a.refId.split('|').every((id) => podRows.has(id));
    if (a.kind === 'du-label') return hallWide || a.refId === pod.id;
    if (a.kind === 'tag' || a.kind === 'position-tag') return inPod(a.primId);
    return true;
  });
  // QA backlog drawings: on a split part a row chain along the split axis kept every stop of the whole row, so its line, ticks and texts ran
  // past the window (and off the sheet); keep only the segments inside this part's window
  const ann = part && part.windows.length > 1 ? annAll.flatMap((a) => (a.kind === 'dim-chain' ? clipChainToWindow(a, win) : [a])) : annAll;
  const rows = primRowSlots(hp);
  // RCU outlines / gaps / doors first (their labels reserve space), then the draw list with its annotations, then tap-off tags
  const rcu = rcuOutlines(hp, vp, culler, L, win);
  const gaps = gapMarks(rows, vp, L, units, den, win);
  const r = drawListToSvg(list, ann, vp, { idPrefix: prefix, hp, culler });
  defs.push(...r.defs);
  body.push(r.svg);
  // aisle labels (containment of this pod)
  const aisle: string[] = [];
  for (const cid of new Set(hp.prims.filter((p) => p.layer === 'containment' && (hallWide ? inWin(p) : p.podId === pod.id) && p.refId).map((p) => p.refId!))) {
    const cont = project.containments.find((x) => x.id === cid);
    if (!cont) continue;
    // QA backlog drawings: a containment that continues on the next part is labelled at the centre of its piece inside this window (the
    // label sat at the full aisle's centre, off the sheet, so the visible aisle had none)
    const shown = part && part.windows.length > 1 ? rectIntersect(cont.rect, win) : cont.rect;
    if (!shown) continue;
    const b = vpBox(vp, shown);
    const label = `${(cont.kind === 'hot-aisle' ? tr(L, 'hotAisle') : tr(L, 'coldAisle')).toUpperCase()} ${lenU(Math.min(cont.rect.w, cont.rect.d), units, den)}`;
    const col = CONTAINMENT_COLOR[cont.kind === 'hot-aisle' ? 'hot-aisle' : 'cold-aisle'];
    const rot = cont.rect.d > cont.rect.w ? -90 : 0;
    const bx = textBox(b.x + b.w / 2, b.y + b.h / 2, label, 2.6, 'middle', 'central', rot);
    if (culler.tryPlace(bx)) aisle.push(text(b.x + b.w / 2, b.y + b.h / 2, label, { size: 2.6, anchor: 'middle', baseline: 'central', weight: 700, fill: col, letterSpacing: 0.3, rotate: rot || undefined }).replace('<text ', `<text data-containment="${cont.id}" `));
  }
  if (aisle.length) body.push(`<g data-layer="containment">${aisle.join('')}</g>`);
  const doors = roomDoorSymbols(hp, hall, vp, win);
  const cdoors = containmentDoorSymbols(hp, vp, win);
  if (doors.length) body.push(`<g data-layer="doors">${doors.join('')}</g>`);
  if (cdoors.length) body.push(`<g data-layer="containment-doors">${cdoors.join('')}</g>`);
  if (rcu.length || gaps.length) body.push(`<g data-layer="rcu-enclosures">${[...rcu, ...gaps].join('')}</g>`);
  const ff = formFactorGroup(hp, vp, defs, 'suffix', culler, prefix, win);
  if (ff) body.push(ff);
  const taps = tapoffTags(hp, vp, rows, culler, win, { force: den <= 50 });
  if (taps.svg.length) body.push(`<g data-layer="tapoffs">${taps.svg.join('')}</g>`);
  // window frame; match lines where a split window continues on the neighbouring part (backlog T2 #3 / #4)
  body.push(`<g data-layer="notes">${rect(paperRect.x, paperRect.y, paperRect.w, paperRect.h, { fill: 'none', stroke: LINE_LIGHT, sw: PAPER_LW.thin })}</g>`);
  if (part && part.windows.length > 1) body.push(`<g data-layer="notes">${matchLines(part, vp, L, culler).join('')}</g>`);
  const sb = scaleBar(region.x, region.y + region.h + 10, vp.mmPerM, den, units);
  body.push(`<g data-layer="notes">${sb.svg}${northArrow(region.x + region.w - 8, region.y + region.h + 12, L, 4.5)}</g>`);

  // right panel: key plan · legend · keynotes · notes
  const px = c.x + c.w - panelW - 6;
  let py = c.y + 24;
  const panel: string[] = [];
  panel.push(rect(px, py, panelW, 58, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }), text(px + 2, py + 4.4, b1t(L, 'keyPlan'), { size: 2.6, weight: 700, fill: INK }), keyPlanInset(hall, { x: px + 4, y: py + 7, w: panelW - 8, h: 49 }, { highlight: [win] }));
  py += 62;
  const st = PAPER_STYLES;
  const gpu = categoryPlanStyle('gpu-rack');
  const entries: LegendEntry[] = [
    { draw: sym.box(gpu.fill, gpu.stroke), label: s(L, 'rack') },
    { draw: sym.box(categoryPlanStyle('cdu').fill, categoryPlanStyle('cdu').stroke), label: s(L, 'cdu') },
    { draw: sym.box(mixOnPaper(CONTAINMENT_COLOR['hot-aisle'], 0.25), CONTAINMENT_COLOR['hot-aisle']), label: s(L, 'containment') },
    ...(rcu.length ? [{ draw: sym.box('none', CALLOUT_INK, '2 0.8'), label: s(L, 'rcu') }] : []),
    ...(gaps.length ? [{ draw: (x: number, y: number) => line(x + 4.5, y, x + 4.5, y + 3.4, { stroke: GAP_INK, sw: PAPER_LW.medium, dash: '1.2 0.7' }), label: s(L, 'gap') }] : []),
    { draw: sym.box('none', SYSTEM_COLOR['busway-a'], '1.6 0.8'), label: s(L, 'bwA') },
    { draw: sym.box('none', SYSTEM_COLOR['busway-b'], '1.6 0.8'), label: s(L, 'bwB') },
    { draw: sym.small(st.tapoff.fill, st.tapoff.stroke), label: s(L, 'tapoff') },
    { draw: sym.line(SYSTEM_COLOR.trays, PAPER_LW.thin, '1.6 0.8'), label: s(L, 'tray') },
    { draw: (x, y) => line(x, y + 1.0, x + 9, y + 1.0, { stroke: SYSTEM_COLOR['cdu-supply'], sw: PAPER_LW.thin, dash: '1.6 0.8' }) + line(x, y + 2.6, x + 9, y + 2.6, { stroke: SYSTEM_COLOR['cdu-return'], sw: PAPER_LW.thin, dash: '1.6 0.8' }), label: s(L, 'pipe') },
    { draw: sym.box(st.column.fill, INK), label: s(L, 'column') },
    { draw: sym.text('A01', INK_SOFT), label: s(L, 'position') },
    { draw: (x, y) => line(x, y + 1.7, x + 6, y + 1.7, { stroke: CALLOUT_INK, sw: PAPER_LW.heavy, dash: DASH_DOT }) + circle(x + 8, y + 1.7, 1.5, { fill: PAPER, stroke: CALLOUT_INK, sw: PAPER_LW.thin }), label: s(L, 'marker') },
  ];
  const lg = legendBox(px, py, panelW, s(L, 'legend'), entries, 2);
  panel.push(lg.svg);
  py += lg.h + 4;
  const used = keynotesUsed(ann.map((a) => a.keynoteId));
  if (used.length) {
    const rowsN = Math.ceil(used.length / 2);
    const kh = rowsN * 5 + 8;
    panel.push(rect(px, py, panelW, kh, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }), text(px + 2, py + 4.4, s(L, 'keynotes'), { size: 2.6, weight: 700, fill: INK }));
    used.forEach((k, i) => {
      const col = Math.floor(i / rowsN);
      const row = i % rowsN;
      const kx = px + 6 + col * (panelW / 2);
      const ky = py + 10 + row * 5;
      panel.push(keynoteEllipse(kx, ky, k.id).svg, text(kx + 4.4, ky + 0.7, fitText(k.label[L === 'ko' ? 'ko' : 'en'], 2.0, panelW / 2 - 12), { size: 2.0, fill: INK }));
    });
    py += kh + 4;
  }
  const notes = crossRefNotes(ctx.sheetList, ['racks', 'busway', 'trays', 'pipes', 'containment', 'network'], L, hall.id).map((x) => x.text);
  notes.push(s(L, 'noteWindow'), s(L, units === 'imperial' ? 'noteDimsImp' : 'noteDims'), s(L, 'noteEstimate'), s(L, ff ? 'formShown' : 'formNote'));
  panel.push(text(px + 2, py + 4, s(L, 'notes'), { size: 2.6, weight: 700, fill: INK }));
  let ny = py + 8.5;
  notes.forEach((t, i) => {
    for (const ln of wrapWords(`${i + 1}. ${t}`, 2.0, panelW - 4)) {
      if (ny > c.y + c.h - 3) return;
      panel.push(text(px + 2, ny, ln, { size: 2.0, fill: INK }));
      ny += 3.2;
    }
  });
  body.push(`<g data-layer="keynotes">${panel.join('')}</g>`);
  return { svg: svgDocument(A1L.w, A1L.h, defs, body, `${meta.number} ${meta.title}`), viewports: [vp] };
}

/** Greedy word wrap by the svg.ts text metrics (Hangul full width). */
/** Match lines of a split window part: dash-dot across the window at each shared edge, "MATCH LINE — SEE <number>" beside it. */
function matchLines(part: PlanPart, vp: ReturnType<typeof fitViewport>['viewport'], L: Locale, culler?: LabelCuller): string[] {
  const out: string[] = [];
  const w = part.windows[part.index];
  const edge = (other: Rect, k: number) => {
    const alongX = Math.abs(other.y - w.y) < 1e-6 && Math.abs(other.d - w.d) < 1e-6;
    const at = alongX ? (other.x > w.x ? w.x + w.w : w.x) : other.y > w.y ? w.y + w.d : w.y;
    const a = alongX ? vpBox(vp, { x: at, y: w.y, w: 0, d: w.d }) : vpBox(vp, { x: w.x, y: at, w: w.w, d: 0 });
    const label = s(L, 'matchLine', { n: part.numbers[k] ?? '' });
    const x0 = a.x;
    const y0 = a.y;
    const x1 = alongX ? a.x : a.x + a.w;
    const y1 = alongX ? a.y + a.h : a.y;
    out.push(line(x0, y0, x1, y1, { stroke: CALLOUT_INK, sw: PAPER_LW.heavy, dash: DASH_DOT }));
    const inward = alongX ? (other.x > w.x ? -1 : 1) : other.y > w.y ? 1 : -1;
    // QA backlog drawings: the label sat at the middle of the edge whatever was there (position tags, tap-off tags, keynotes, aisle labels
    // of the rows crossing the match line). It now takes the first free spot along the edge (middle first), inside then just outside the
    // window, after every other label of the part; the middle is the fallback.
    const len = alongX ? y1 - y0 : x1 - x0;
    const rot = alongX ? -90 : 0;
    const spot = (t: number, off: number): [number, number] => (alongX ? [x0 + off, y0 + t * len] : [x0 + t * len, y0 + off]);
    let pos = spot(0.5, inward * 2.4);
    if (culler) {
      const ts = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];
      // Dense service rows can put a full run of vertical rack tags beside the split. Search farther on both sides of the line
      // before accepting the middle fallback; the drawing region has enough margin for these offsets.
      const offs = [inward * 2.4, inward * 5.2, -inward * 2.4, inward * 8, -inward * 5.2, inward * 11, -inward * 8];
      const free = offs.flatMap((off) => ts.map((t) => spot(t, off))).find(([px, py]) => culler.fits(textBox(px, py, label, 2.4, 'middle', 'central', rot)));
      if (free) pos = free;
      culler.reserve(textBox(pos[0], pos[1], label, 2.4, 'middle', 'central', rot));
    }
    out.push(text(pos[0], pos[1], label, { size: 2.4, anchor: 'middle', baseline: 'central', weight: 700, fill: CALLOUT_INK, rotate: rot || undefined }).replace('<text ', `<text data-match-line="${part.numbers[k] ?? ''}" `));
  };
  if (part.index > 0) edge(part.windows[part.index - 1], part.index - 1);
  if (part.index < part.windows.length - 1) edge(part.windows[part.index + 1], part.index + 1);
  return out;
}

function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.d, b.y + b.d);
  return x1 > x0 + 1e-6 && y1 > y0 + 1e-6 ? { x: x0, y: y0, w: x1 - x0, d: y1 - y0 } : null;
}

/** A dimension chain cut to a window along its axis: stops outside are dropped with the segments that touch them (texts follow). */
function clipChainToWindow(a: Annotation2D, win: Rect): Annotation2D[] {
  if (a.pts.length < 4) return [a];
  const axis = a.axis ?? (Math.abs(a.pts[a.pts.length - 1] - a.pts[1]) < 1e-9 ? 'h' : 'v');
  const lo = axis === 'h' ? win.x : win.y;
  const hi = axis === 'h' ? win.x + win.w : win.y + win.d;
  const n = a.pts.length / 2;
  const keep: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = a.pts[2 * i + (axis === 'h' ? 0 : 1)];
    if (v >= lo - 1e-6 && v <= hi + 1e-6) keep.push(i);
  }
  if (keep.length === n) return [a];
  // the kept stops are one contiguous run (stops are sorted along the axis)
  if (keep.length < 2) return [];
  const pts = keep.flatMap((i) => [a.pts[2 * i], a.pts[2 * i + 1]]);
  const texts = a.texts ? keep.slice(1).map((i) => a.texts![i - 1] ?? '') : undefined;
  return [{ ...a, pts, ...(texts ? { texts } : {}) }];
}

export function wrapWords(str: string, size: number, maxW: number): string[] {
  const words = str.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textW(next, size) > maxW) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out.map((l) => fitText(l, size, maxW));
}
