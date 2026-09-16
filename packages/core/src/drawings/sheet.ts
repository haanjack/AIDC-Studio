import type { Hall, Locale, Project, Rect } from '../model/types.ts';
import { fmtDate, tr } from './i18n.ts';
import { INK, INK_SOFT, LINE_LIGHT, PAPER, STATE_STYLE, SYSTEMS, type SystemId } from './palette.ts';
import { hallOutline, systemFirstWave, type HallScene } from './scene.ts';
import { standardsBasisLine } from '../docs/standardsBasis.ts';
import { fitText, hatchDef, line, n, path, polygon, rect, text, textWidth, type Pt } from './svg.ts';

/** ISO A1 portrait (mm). */
export const A1 = { w: 594, h: 841 };
/** ISO A1 landscape (mm). */
export const A1L = { w: 841, h: 594 };
export const MARGIN = 10;
export const TITLE_BAND_H = 18;
export const TITLE_COL_W = 62;

export interface SheetMeta {
  project: Project;
  locale: Locale;
  number: string;
  title: string;
  /** sheet family title shown in the top band (e.g. 'Ventilation / Power / Network systems') */
  bandTitle: string;
  scale: string;
  discipline: string;
  phase: string;
  date: string;
  company: string;
  owner: string;
  client: string;
  drawnBy: string;
  /** hall this sheet documents (key plan hatches it); undefined = site */
  hall?: Hall;
  /** zones of intervention (hall-local rects, e.g. pods) */
  zones: Rect[];
  sheetIndex: number;
  sheetCount: number;
  /** paper size (mm); default A1 portrait. D2 rack elevations use A1 landscape (841 × 594). */
  paper?: { w: number; h: number };
}

export interface SheetFrame {
  content: { x: number; y: number; w: number; h: number };
  defs: string[];
  body: string[];
}

const cap = (x: number, y: number, s: string) => text(x, y, s, { size: 1.8, fill: INK_SOFT, weight: 500 });

function keyPlanSite(x: number, y: number, w: number, h: number, halls: Hall[], current: Hall | undefined, hatch: string): string {
  if (!halls.length) return '';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const hl of halls) {
    x0 = Math.min(x0, hl.origin.x);
    y0 = Math.min(y0, hl.origin.y);
    x1 = Math.max(x1, hl.origin.x + hl.width);
    y1 = Math.max(y1, hl.origin.y + hl.depth);
  }
  const sw = x1 - x0;
  const sd = y1 - y0;
  if (!(sw > 0) || !(sd > 0)) return '';
  const s = Math.min((w - 4) / sw, (h - 4) / sd);
  const ox = x + (w - sw * s) / 2;
  const oy = y + (h - sd * s) / 2;
  // plan y up → paper y down
  const P = (px: number, py: number): Pt => [ox + (px - x0) * s, oy + (y1 - py) * s];
  const out: string[] = [];
  for (const hl of halls) {
    const pts = hallOutline(hl).map((p) => P(hl.origin.x + p.x, hl.origin.y + p.y));
    const isCur = current?.id === hl.id;
    out.push(polygon(pts, { fill: isCur ? `url(#${hatch})` : '#f1f2f3', stroke: INK, sw: isCur ? 0.35 : 0.2 }));
    const c = P(hl.origin.x + hl.width / 2, hl.origin.y + hl.depth / 2);
    out.push(text(c[0], c[1], fitText(hl.name, 1.8, hl.width * s - 1), { size: 1.8, anchor: 'middle', baseline: 'middle', fill: INK, weight: isCur ? 700 : 400 }));
  }
  return out.join('');
}

function keyPlanZones(x: number, y: number, w: number, h: number, hall: Hall | undefined, zones: Rect[], hatch: string): string {
  if (!hall || !(hall.width > 0) || !(hall.depth > 0)) return '';
  const s = Math.min((w - 4) / hall.width, (h - 4) / hall.depth);
  const ox = x + (w - hall.width * s) / 2;
  const oy = y + (h - hall.depth * s) / 2;
  const P = (px: number, py: number): Pt => [ox + px * s, oy + (hall.depth - py) * s];
  const out: string[] = [polygon(hallOutline(hall).map((p) => P(p.x, p.y)), { fill: '#f7f8f9', stroke: INK, sw: 0.3 })];
  for (const z of zones) {
    const a = P(z.x, z.y + z.d);
    out.push(rect(a[0], a[1], z.w * s, z.d * s, { fill: `url(#${hatch})`, stroke: INK_SOFT, sw: 0.15 }));
  }
  return out.join('');
}

/**
 * Border, top title band and the right-hand title-block column (stacked boxes). Returns the content area
 * where the sheet body is drawn.
 */
export function sheetFrame(meta: SheetMeta): SheetFrame {
  const L = meta.locale;
  const defs: string[] = [hatchDef('tb-hatch', INK_SOFT, 1.0, 0.18)];
  const body: string[] = [];
  const x0 = MARGIN;
  const y0 = MARGIN;
  const paper = meta.paper ?? A1;
  const x1 = paper.w - MARGIN;
  const y1 = paper.h - MARGIN;
  body.push(rect(x0, y0, x1 - x0, y1 - y0, { fill: PAPER, stroke: INK, sw: 0.6 }));
  // top band
  body.push(line(x0, y0 + TITLE_BAND_H, x1, y0 + TITLE_BAND_H, { stroke: INK, sw: 0.4 }));
  body.push(text(x0 + 5, y0 + 8, fitText(meta.project.name.toUpperCase(), 6, 300), { size: 6, weight: 700, fill: INK, letterSpacing: 0.3 }));
  body.push(text(x0 + 5, y0 + 14.5, fitText(meta.bandTitle.toUpperCase(), 3.2, 340), { size: 3.2, weight: 500, fill: INK_SOFT, letterSpacing: 0.25 }));
  body.push(text(x1 - 5, y0 + 8, meta.number, { size: 7, weight: 700, anchor: 'end', fill: INK }));
  body.push(text(x1 - 5, y0 + 14.5, `${meta.sheetIndex} ${tr(L, 'sheetOf')} ${meta.sheetCount} · ${meta.date}`, { size: 2.4, anchor: 'end', fill: INK_SOFT }));

  // right column
  const cx = x1 - TITLE_COL_W;
  const cy = y0 + TITLE_BAND_H;
  body.push(line(cx, cy, cx, y1, { stroke: INK, sw: 0.4 }));
  const pad = 2;
  const cw = TITLE_COL_W;
  let y = cy;
  const box = (h: number, draw: (bx: number, by: number, bw: number, bh: number) => string[]) => {
    body.push(...draw(cx, y, cw, h));
    y += h;
    body.push(line(cx, y, x1, y, { stroke: INK, sw: 0.3 }));
  };
  const valueBox = (label: string, value: string, h = 10, size = 2.6) =>
    box(h, (bx, by, bw) => [cap(bx + pad, by + 3.2, label), text(bx + pad, by + h - 3, fitText(value, size, bw - 2 * pad), { size, weight: 600, fill: INK })]);

  box(22, (bx, by, bw) => [
    cap(bx + pad, by + 3.2, tr(L, 'company')),
    rect(bx + pad, by + 5, 7, 7, { fill: INK }),
    text(bx + pad + 3.5, by + 10.2, 'AI', { size: 3.4, weight: 800, anchor: 'middle', fill: PAPER }),
    text(bx + pad + 9, by + 10.6, meta.company, { size: 4.2, weight: 700, fill: INK }),
    text(bx + pad, by + 16, fitText(`${tr(L, 'owner')}: ${meta.owner}`, 2.1, bw - 2 * pad), { size: 2.1, fill: INK_SOFT }),
    text(bx + pad, by + 19.5, fitText(meta.project.site.name, 2.1, bw - 2 * pad), { size: 2.1, fill: INK_SOFT }),
  ]);
  box(18, (bx, by, bw) => [
    cap(bx + pad, by + 3.2, tr(L, 'client')),
    text(bx + pad, by + 8.5, fitText(meta.client, 3.2, bw - 2 * pad), { size: 3.2, weight: 700, fill: INK }),
    text(bx + pad, by + 12.5, fitText(meta.project.site.location, 2.1, bw - 2 * pad), { size: 2.1, fill: INK_SOFT }),
    // finish v2 2차 (QA rack-elevations m13): a Korean free-text description is not printed on EN sheets
    text(bx + pad, by + 15.8, fitText(L === 'en' && /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(meta.project.description ?? '') ? '' : meta.project.description ?? '', 2.0, bw - 2 * pad), { size: 2.0, fill: INK_SOFT }),
  ]);
  valueBox(tr(L, 'projectNo'), meta.project.id, 10, 2.8);
  box(40, (bx, by, bw, bh) => [cap(bx + pad, by + 3.2, tr(L, 'keyPlan')), keyPlanSite(bx + pad, by + 5, bw - 2 * pad, bh - 7, meta.project.halls, meta.hall, 'tb-hatch')]);
  valueBox(tr(L, 'projectName'), meta.project.name, 14, 3.2);
  box(14, (bx, by, bw) => [
    cap(bx + pad, by + 3.2, tr(L, 'projectAddress')),
    text(bx + pad, by + 7.5, fitText(meta.project.site.name, 2.6, bw - 2 * pad), { size: 2.6, weight: 600, fill: INK }),
    text(bx + pad, by + 11.5, fitText(meta.project.site.location, 2.3, bw - 2 * pad), { size: 2.3, fill: INK_SOFT }),
  ]);
  valueBox(tr(L, 'stage'), tr(L, 'stageValue'));
  box(45, (bx, by, bw, bh) => [
    cap(bx + pad, by + 3.2, tr(L, 'zoneKeyPlan')),
    keyPlanZones(bx + pad, by + 5, bw - 2 * pad, bh - 7, meta.hall, meta.zones, 'tb-hatch'),
    meta.hall ? text(bx + bw - pad, by + 3.2, fitText(meta.hall.name, 1.8, bw / 2), { size: 1.8, anchor: 'end', fill: INK_SOFT }) : '',
  ]);
  valueBox(tr(L, 'phase'), meta.phase);
  valueBox(tr(L, 'discipline'), meta.discipline, 10, 2.4);
  box(26, (bx, by, bw) => [cap(bx + pad, by + 3.2, tr(L, 'sheetNo')), text(bx + bw / 2, by + 21, meta.number, { size: Math.min(15, Math.max(5, (bw - 2 * pad) / Math.max(0.1, textWidth(meta.number, 1)))), weight: 700, anchor: 'middle', fill: INK })]);
  box(18, (bx, by, bw) => {
    const words = meta.title.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (textWidth(next, 2.8) > bw - 2 * pad && cur) {
        lines.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) lines.push(cur);
    return [cap(bx + pad, by + 3.2, tr(L, 'sheetTitle')), ...lines.slice(0, 3).map((l, i) => text(bx + pad, by + 8 + i * 3.6, fitText(l, 2.8, bw - 2 * pad), { size: 2.8, weight: 700, fill: INK }))];
  });
  valueBox(tr(L, 'modelFile'), `${meta.project.id}.json`, 10, 2.4);
  box(10, (bx, by, bw) => [
    cap(bx + pad, by + 3.2, tr(L, 'date')),
    text(bx + pad, by + 7.5, meta.date, { size: 2.6, weight: 600, fill: INK }),
    cap(bx + bw / 2, by + 3.2, tr(L, 'drawnBy')),
    text(bx + bw / 2, by + 7.5, fitText(meta.drawnBy, 2.6, bw / 2 - pad), { size: 2.6, weight: 600, fill: INK }),
  ]);
  valueBox(tr(L, 'scale'), meta.scale, 10, 3.2);
  // stream E (P5, proposal §6.3): standards basis row — only when the project carries a standards profile (legacy sheets unchanged)
  const basis = standardsBasisLine(meta.project, meta.hall, L);
  if (basis) {
    box(12, (bx, by, bw) => [
      cap(bx + pad, by + 3.2, tr(L, 'standardsBasis')),
      text(bx + pad, by + 7, fitText(basis.profile, 2.2, bw - 2 * pad), { size: 2.2, weight: 600, fill: INK }),
      text(bx + pad, by + 10.4, fitText(basis.citation, 1.9, bw - 2 * pad), { size: 1.9, fill: INK_SOFT }),
    ]);
  }
  // revisions fill the rest of the column
  const remaining = y1 - y;
  if (remaining > 12) {
    body.push(cap(cx + pad, y + 3.2, L === 'ko' ? '개정' : 'Revisions'));
    const rows = [
      ['A', meta.date, L === 'ko' ? 'AIDC Studio 자동 생성' : 'Generated by AIDC Studio'],
    ];
    rows.forEach((r, i) => {
      const ry = y + 7 + i * 4;
      body.push(text(cx + pad, ry, r[0], { size: 2, weight: 600, fill: INK }));
      body.push(text(cx + pad + 6, ry, r[1], { size: 2, fill: INK }));
      body.push(text(cx + pad + 22, ry, fitText(r[2], 2, cw - 24 - pad), { size: 2, fill: INK_SOFT }));
      body.push(line(cx, ry + 1.5, x1, ry + 1.5, { stroke: LINE_LIGHT, sw: 0.15 }));
    });
    body.push(text(cx + cw / 2, y1 - 3, 'AIDC Studio · aidc-studio', { size: 1.8, anchor: 'middle', fill: LINE_LIGHT }));
  }
  return { content: { x: x0, y: cy, w: cx - x0, h: y1 - cy }, defs, body };
}

/** Phase matrix cell state. */
export type PhaseState = 'operational' | 'stopped' | '';

export interface PhaseMatrix {
  systems: { id: SystemId; color: string; label: string }[];
  waves: { id: string; name: string }[];
  cells: PhaseState[][]; // [system][wave]
}

/**
 * Operating state of every present system during each construction wave: green = operational, yellow =
 * temporarily stopped for the tie-in of the new pods (shared trunk systems only), blank = not yet installed.
 */
export function phaseMatrix(scene: HallScene, project: Project, locale: Locale): PhaseMatrix {
  const first = systemFirstWave(scene, project);
  const waves = scene.waves.length ? scene.waves : [{ id: 'wave-all', name: tr(locale, 'allWaves'), index: 0, podIds: [] }];
  const installsPods = waves.map((w) => scene.racks.some((r) => scene.waveOf(r.e) === w.index));
  const systems = SYSTEMS.filter((s) => first[s.id] !== undefined);
  const cells = systems.map((s) =>
    waves.map((w): PhaseState => {
      const f = first[s.id]!;
      if (w.index < f) return '';
      if (w.index > f && s.shared && installsPods[w.index]) return 'stopped';
      return 'operational';
    }),
  );
  return { systems: systems.map((s) => ({ id: s.id, color: s.color, label: tr(locale, s.label) })), waves: waves.map((w) => ({ id: w.id, name: w.name })), cells };
}

export const STATE_FILL: Record<Exclude<PhaseState, ''>, string> = { operational: STATE_STYLE.operational.fill, stopped: STATE_STYLE.stopped.fill };
/** hatch pattern id the matrix uses for the 'stopped' state (the caller's <defs> must include `stateHatchDef()`) */
export const STATE_HATCH_ID = 'state-stopped-hatch';
export function stateHatchDef(): string {
  return hatchDef(STATE_HATCH_ID, STATE_STYLE.stopped.stroke, 1.2, 0.25);
}
/** one matrix cell / legend key with its pattern mark */
function stateCell(x: number, y: number, w: number, h: number, st: Exclude<PhaseState, ''>): string {
  const sty = STATE_STYLE[st];
  const out = [rect(x, y, w, h, { fill: sty.fill, stroke: sty.stroke, sw: 0.2 })];
  if (sty.mark === 'hatch') out.push(rect(x, y, w, h, { fill: `url(#${STATE_HATCH_ID})`, stroke: 'none' }));
  else {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const k = Math.min(w, h) * 0.32;
    out.push(path(`M${n(cx - k)} ${n(cy)} L${n(cx - k * 0.3)} ${n(cy + k * 0.7)} L${n(cx + k)} ${n(cy - k * 0.7)}`, { fill: 'none', stroke: sty.stroke, sw: 0.35 }));
  }
  return out.join('');
}

/** Legend table: systems (swatch + label) × waves, with the state legend below. Returns svg + height. */
export function drawPhaseMatrix(x: number, y: number, m: PhaseMatrix, locale: Locale, opts: { labelW?: number; colW?: number; rowH?: number } = {}): { svg: string; width: number; height: number } {
  const labelW = opts.labelW ?? 58;
  const colW = opts.colW ?? 13;
  const rowH = opts.rowH ?? 5;
  const swW = 8;
  const headH = 12;
  const w = swW + labelW + colW * m.waves.length;
  const out: string[] = [];
  out.push(text(x, y - 1.5, tr(locale, 'legendSystems'), { size: 2.6, weight: 700, fill: INK }));
  // header
  out.push(rect(x, y, w, headH, { fill: '#eef0f2', stroke: INK, sw: 0.3 }));
  out.push(text(x + swW + 1.5, y + headH - 2, tr(locale, 'legendSystem'), { size: 2.2, weight: 600, fill: INK }));
  m.waves.forEach((wv, i) => {
    const cx = x + swW + labelW + colW * i;
    out.push(line(cx, y, cx, y + headH, { stroke: INK, sw: 0.2 }));
    out.push(text(cx + colW / 2, y + headH - 2, fitText(wv.name, 2, colW - 1), { size: 2, weight: 600, anchor: 'middle', fill: INK }));
  });
  m.systems.forEach((s, ri) => {
    const ry = y + headH + ri * rowH;
    out.push(rect(x, ry, w, rowH, { fill: PAPER, stroke: INK, sw: 0.2 }));
    out.push(rect(x + 1, ry + 1, swW - 2, rowH - 2, { fill: s.color }));
    out.push(text(x + swW + 1.5, ry + rowH - 1.5, fitText(s.label, 2.2, labelW - 2), { size: 2.2, fill: INK }));
    m.waves.forEach((_, ci) => {
      const cx = x + swW + labelW + colW * ci;
      const st = m.cells[ri][ci];
      if (st) out.push(stateCell(cx + 0.6, ry + 0.6, colW - 1.2, rowH - 1.2, st));
      out.push(line(cx, ry, cx, ry + rowH, { stroke: INK, sw: 0.2 }));
    });
  });
  let ly = y + headH + m.systems.length * rowH + 4;
  const key = (fill: string, label: string, stroke = INK) => {
    out.push(rect(x, ly - 2.6, 6, 3.2, { fill, stroke, sw: 0.2 }));
    out.push(text(x + 8, ly, label, { size: 2.1, fill: INK }));
    ly += 4.2;
  };
  const keyState = (st: Exclude<PhaseState, ''>, label: string) => {
    out.push(stateCell(x, ly - 2.6, 6, 3.2, st));
    out.push(text(x + 8, ly, label, { size: 2.1, fill: INK }));
    ly += 4.2;
  };
  out.push(stateHatchDef());
  keyState('operational', tr(locale, 'operational'));
  keyState('stopped', tr(locale, 'stopped'));
  key(PAPER, tr(locale, 'na'));
  key('#c4c8cc', tr(locale, 'existing'));
  key(PAPER, tr(locale, 'newCommon'), INK_SOFT);
  return { svg: out.join(''), width: w, height: ly - y + 2 };
}

/** Simple swatch legend (colour box + label rows), two-column when many entries. */
export function drawLegend(x: number, y: number, title: string, entries: { color: string; label: string; stroke?: string; dash?: string; kind?: 'box' | 'line' }[], opts: { cols?: number; colW?: number } = {}): { svg: string; width: number; height: number } {
  const cols = opts.cols ?? 1;
  const colW = opts.colW ?? 62;
  const rowH = 4.4;
  const rows = Math.ceil(entries.length / cols);
  const w = cols * colW;
  const h = rows * rowH + 8;
  const out: string[] = [rect(x, y, w, h, { fill: PAPER, stroke: INK, sw: 0.3 }), text(x + 2, y + 4.2, title, { size: 2.6, weight: 700, fill: INK })];
  entries.forEach((e, i) => {
    const c = Math.floor(i / rows);
    const r = i % rows;
    const ex = x + 2 + c * colW;
    const ey = y + 7.5 + r * rowH;
    if ((e.kind ?? 'box') === 'line') out.push(line(ex, ey + 1.3, ex + 7, ey + 1.3, { stroke: e.color, sw: 0.7, dash: e.dash }));
    else out.push(rect(ex, ey, 7, 2.8, { fill: e.color, stroke: e.stroke ?? INK_SOFT, sw: 0.2, dash: e.dash }));
    out.push(text(ex + 9, ey + 2.4, fitText(e.label, 2.1, colW - 11), { size: 2.1, fill: INK }));
  });
  return { svg: out.join(''), width: w, height: h };
}

/** Pick a standard drawing scale so a (w × h) metre extent fits in (pw × ph) mm. Returns mm per metre. */
export function pickScale(wM: number, hM: number, pw: number, ph: number, candidates = [20, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000]): { ratio: number; mmPerM: number } {
  for (const r of candidates) {
    const s = 1000 / r;
    if (wM * s <= pw && hM * s <= ph) return { ratio: r, mmPerM: s };
  }
  const r = candidates[candidates.length - 1];
  return { ratio: r, mmPerM: 1000 / r };
}
