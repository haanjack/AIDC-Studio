// Key plan inset shared by 121 (enlarged.ts, hatched window) and 301 / 302 / 311 (section.ts renderOrthoSheet, framed with rows, containment
// and the cut marker) — backlog T2 #8 merged the two copies (plan.ts / section.ts) into one function with one world → paper mapping.
import type { Containment, Hall, Rect } from '../model/types.ts';
import { CALLOUT_INK, DASH_DOT, PAPER_LW } from './annotate.ts';
import { CONTAINMENT_COLOR, INK, LINE_LIGHT, PAPER } from './palette.ts';
import { hallOutline } from './scene.ts';
import { line, polygon, rect, text, type Pt } from './svg.ts';

export interface KeyPlanBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface KeyPlanMark {
  highlight?: Rect[];
  /** section cut: plane ⟂ axis at `at`, drawn from t0 to t1 along the other axis; arrows toward `look` */
  cut?: { axis: 'x' | 'y'; at: number; t0: number; t1: number; look: 1 | -1 };
}

export interface KeyPlanOptions {
  /** framed inset with this title, the row footprints and the hall's containment (301 / 302 / 311); without it a bare outline with
   *  hatched highlights fills the box (121, the caller draws the frame) */
  title?: string;
  rows?: readonly Rect[];
  containments?: readonly Pick<Containment, 'rect' | 'kind'>[];
}

/** Small hall plan with the highlighted zones and the optional cut / view marker. */
export function keyPlanInset(hall: Hall, box: KeyPlanBox, mark: KeyPlanMark, o: KeyPlanOptions = {}): string {
  const framed = o.title !== undefined;
  if (!framed && !(hall.width > 0 && hall.depth > 0)) return '';
  const W = framed ? Math.max(hall.width, 1e-3) : hall.width;
  const D = framed ? Math.max(hall.depth, 1e-3) : hall.depth;
  // framed: title strip 8 mm, 4 mm side padding; bare: 1 mm all round
  const s = framed ? Math.min((box.w - 8) / W, (box.h - 12) / D) : Math.min((box.w - 2) / W, (box.h - 2) / D);
  const ox = box.x + (box.w - W * s) / 2;
  const oy = framed ? box.y + 8 + (box.h - 10 - D * s) / 2 : box.y + (box.h - D * s) / 2;
  const P = (x: number, y: number): Pt => [ox + x * s, oy + (D - y) * s];
  if (!framed) {
    const out = [polygon(hallOutline(hall).map((p) => P(p.x, p.y)), { fill: '#f7f8f9', stroke: INK, sw: PAPER_LW.thin })];
    for (const r of mark.highlight ?? []) {
      const a = P(Math.max(0, r.x), Math.min(hall.depth, r.y + r.d));
      const b = P(Math.min(hall.width, r.x + r.w), Math.max(0, r.y));
      out.push(rect(a[0], a[1], b[0] - a[0], b[1] - a[1], { fill: 'url(#tb-hatch)', stroke: CALLOUT_INK, sw: PAPER_LW.medium }));
    }
    return out.join('');
  }
  const R = (r: Rect) => {
    const [x0, y1] = P(r.x, r.y);
    const [x1, y0] = P(r.x + r.w, r.y + r.d);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  };
  const els: string[] = [rect(box.x, box.y, box.w, box.h, { fill: PAPER, stroke: INK, sw: PAPER_LW.thin }), text(box.x + 2, box.y + 4.6, o.title ?? '', { size: 2.6, weight: 700, fill: INK })];
  const hr = R({ x: 0, y: 0, w: W, d: D });
  els.push(rect(hr.x, hr.y, hr.w, hr.h, { fill: '#fafafa', stroke: INK, sw: PAPER_LW.medium }));
  for (const row of o.rows ?? []) {
    const rr = R(row);
    els.push(rect(rr.x, rr.y, rr.w, rr.h, { fill: '#d9dde2', stroke: LINE_LIGHT, sw: PAPER_LW.hair }));
  }
  for (const c of o.containments ?? []) {
    const cr = R(c.rect);
    els.push(rect(cr.x, cr.y, cr.w, cr.h, { fill: 'none', stroke: CONTAINMENT_COLOR[c.kind], sw: PAPER_LW.hair }));
  }
  for (const h of mark.highlight ?? []) {
    const r = R(h);
    els.push(rect(r.x, r.y, r.w, r.h, { fill: CALLOUT_INK, fillOpacity: 0.18, stroke: CALLOUT_INK, sw: PAPER_LW.thin }));
  }
  if (mark.cut) {
    const c = mark.cut;
    const a = c.axis === 'x' ? P(c.at, c.t0) : P(c.t0, c.at);
    const b = c.axis === 'x' ? P(c.at, c.t1) : P(c.t1, c.at);
    els.push(line(a[0], a[1], b[0], b[1], { stroke: CALLOUT_INK, sw: PAPER_LW.medium, dash: DASH_DOT }));
    // look arrows (paper y is flipped for world y)
    const d: Pt = c.axis === 'x' ? [c.look, 0] : [0, -c.look];
    for (const e of [a, b]) {
      const tip: Pt = [e[0] + d[0] * 3, e[1] + d[1] * 3];
      const nrm: Pt = [-d[1], d[0]];
      els.push(polygon([tip, [e[0] + nrm[0] * 1.2, e[1] + nrm[1] * 1.2], [e[0] - nrm[0] * 1.2, e[1] - nrm[1] * 1.2]], { fill: CALLOUT_INK }));
    }
  }
  return `<g data-layer="key-plan">${els.join('')}</g>`;
}
