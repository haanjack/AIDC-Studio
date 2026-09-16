// r4 annotation grammar (spec §1.3), shared by sheets and the 2D view. Owner: stream B0 (hand-off B → C: annotate).
//
// Two layers:
//  1. Paper-space primitives (mm on the sheet, y down) that return SVG strings: dimChain, levelDatum, keynoteEllipse, positionTag,
//     equipmentTag, sectionMarker, calloutBubble / calloutBoundary / callout, crossRefNote, plus LabelCuller (greedy, no overlaps,
//     text ≥ MIN_TEXT_MM). Sheet owners (B1 / B2) call these directly.
//  2. World-space `annotate(project, hp, list, opts)` → Annotation2D[] (world metres in the draw list's space). toSvg.ts renders
//     them through a DrawingViewport; the web 2D view renders the same list on Canvas2D.
// Texts follow project.locale (opts.locale overrides) and project.drawingUnits (opts.units overrides). Pure and deterministic.
import type { DrawingCut, DrawingUnits, Locale, Project, Rect } from '../model/types.ts';
import type { DrawItem2D, DrawList2D } from '../scene/drawList.ts';
import type { LayerId } from '../scene/layers.ts';
import { primAabb, type DatumSource, type HallPrims, type Prim } from '../scene/prims.ts';
import { keynoteForPrim } from './keynotes.ts';
import { INK, INK_SOFT, PAPER } from './palette.ts';
import { circle, esc, line, MONO, MIN_TEXT_MM, n, path, polygon, text, textWidth, type Pt } from './svg.ts';
import { drawingUnitsOf, fmtLength, fmtLevel } from './units.ts';

// ───────────────────────────── shared constants ─────────────────────────────

/** Paper line weights (mm): hairline · thin · medium · heavy (spec §3.2 export weights 0.18 / 0.25 / 0.35 / 0.5). */
export const PAPER_LW = { hair: 0.18, thin: 0.25, medium: 0.35, heavy: 0.5 } as const;
/** Dash-dot pattern for callout boundaries and section cut lines (mm). */
export const DASH_DOT = '4 1 0.8 1';
/** Default annotation text sizes (mm on paper). */
export const ANN_TEXT = { tag: 1.8, position: 1.8, dim: 2.0, datum: 2.0, keynote: 1.8, bubble: 2.4, note: 2.2, duLabel: 2.6 } as const;
/** Clearance (mm) a dimension text needs on top of its width before the segment text is suppressed (spec §1.3). */
export const DIM_TEXT_CLEARANCE_MM = 2;
/** Colour of section markers / callout bubbles (distinct from every system colour and the rack role fills). */
export const CALLOUT_INK = '#0b6e99';

// ───────────────────────────── Annotation2D ─────────────────────────────

export type AnnotationKind = 'tag' | 'position-tag' | 'dim-chain' | 'datum' | 'keynote' | 'callout' | 'section-marker' | 'note' | 'grid-bubble' | 'du-label';

export interface Annotation2D {
  kind: AnnotationKind;
  /**
   * flat world points in the draw list's space:
   *  tag / du-label / note / grid-bubble [x, y] (text centre); position-tag [x, y] or [x, y, dx, dy] (dx, dy = outward unit vector);
   *  keynote [x, y] or [x, y, targetX, targetY] (leader to the target);
   *  datum [u, z] (apex of the ▽, text to `side`);
   *  dim-chain stops along `axis` at a fixed perpendicular coordinate: 'h' [x0,y, x1,y, …] · 'v' [x,y0, x,y1, …];
   *  section-marker [x0, y0, x1, y1] (cut line; look direction ⟂ the line, sign `look`);
   *  callout [x, y, w, h] (boundary rect, bubble at its top-right corner)
   */
  pts: number[];
  text?: string;
  /** label culling priority, higher wins: tag (10) < position tag (12) < DU label (20) < datum (30) < grid bubble (35) < keynote (40) < marker (50) */
  priority: number;
  layer: LayerId;
  lodMin: 0 | 1 | 2 | 3;
  /** text height (paper mm on sheets; the 2D view converts) */
  size?: number;
  /** text rotation (deg, CW on paper — SVG convention; −90 reads bottom-to-top) */
  rot?: number;
  primId?: string;
  refId?: string;
  keynoteId?: string;
  /** callout / section marker: target sheet number */
  target?: string;
  // ── B0 additions (all optional) ──
  /** dim-chain: text per segment (length = stops − 1; '' = no text) */
  texts?: string[];
  /** dim-chain: 'h' along x / u, 'v' along y / z */
  axis?: 'h' | 'v';
  /** section-marker: look direction sign ⟂ the marker line (world: 'h' line → (0, look), 'v' line → (look, 0)) */
  look?: 1 | -1;
  /** datum: text side of the ▽ (default 'right') */
  side?: 'left' | 'right';
  /** datum: source tag of the level (hover / tooltip only, never printed) */
  source?: DatumSource;
}

export interface AnnotateOptions {
  locale?: Locale;
  units?: DrawingUnits;
  /** scale denominator (50 for 1:50); drives dimension rounding, per-rack chain stops (≤ 50) */
  scaleDen?: number;
  lod?: 0 | 1 | 2 | 3;
  layers?: LayerId[];
  /** section markers on plans (default: project.drawingCuts of this hall, no target) */
  cuts?: { cut: DrawingCut; target?: string }[];
  /** enlarged-plan / detail callouts on plans */
  callouts?: { rect: Rect; label: string; target?: string }[];
  /** annotate only inside this world window (default list.bounds) */
  window?: Rect;
}

// ───────────────────────────── paper boxes + label culling ─────────────────────────────

export interface PaperBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Approximate paper box of a text (mm). `rot` ±90 swaps the extents. */
export function textBox(x: number, y: number, s: string, size: number, anchor: 'start' | 'middle' | 'end' = 'start', baseline: 'auto' | 'middle' | 'central' = 'auto', rot = 0): PaperBox {
  const sz = Math.max(MIN_TEXT_MM, size);
  const w = textWidth(s, sz);
  const h = sz;
  const along0 = anchor === 'middle' ? -w / 2 : anchor === 'end' ? -w : 0;
  const across0 = baseline === 'auto' ? -0.8 * h : -0.5 * h;
  if (Math.abs(Math.abs(rot % 180) - 90) < 1) {
    // rotated ±90: along the text runs in paper y
    const sgn = rot < 0 || rot > 180 ? -1 : 1;
    const y0 = sgn > 0 ? y + along0 : y - along0 - w;
    const x0 = sgn > 0 ? x - (across0 + h) : x + across0;
    return { x: x0, y: y0, w: h, h: w };
  }
  return { x: x + along0, y: y + across0, w, h };
}

function overlaps(a: PaperBox, b: PaperBox, pad: number): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Greedy label occupancy on paper (bucketed; fine for tens of thousands of labels). */
export class LabelCuller {
  readonly pad: number;
  readonly cell: number;
  private readonly buckets = new Map<string, PaperBox[]>();
  private placed = 0;

  constructor(pad = 0.3, cell = 8) {
    this.pad = pad;
    this.cell = cell;
  }

  private keys(b: PaperBox): string[] {
    const c = this.cell;
    const out: string[] = [];
    const x0 = Math.floor((b.x - this.pad) / c);
    const x1 = Math.floor((b.x + b.w + this.pad) / c);
    const y0 = Math.floor((b.y - this.pad) / c);
    const y1 = Math.floor((b.y + b.h + this.pad) / c);
    for (let i = x0; i <= x1; i++) for (let j = y0; j <= y1; j++) out.push(`${i},${j}`);
    return out;
  }

  fits(b: PaperBox): boolean {
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) return false;
    for (const k of this.keys(b)) for (const o of this.buckets.get(k) ?? []) if (overlaps(b, o, this.pad)) return false;
    return true;
  }

  /** Mark a box occupied without testing (structural texts that are always drawn). */
  reserve(b: PaperBox): void {
    if (![b.x, b.y, b.w, b.h].every(Number.isFinite)) return;
    for (const k of this.keys(b)) {
      const list = this.buckets.get(k);
      if (list) list.push(b);
      else this.buckets.set(k, [b]);
    }
    this.placed++;
  }

  tryPlace(b: PaperBox): boolean {
    if (!this.fits(b)) return false;
    this.reserve(b);
    return true;
  }

  get count(): number {
    return this.placed;
  }
}

/** Keep the labels that fit, greedy by priority (desc, stable). Labels below MIN_TEXT_MM are dropped. Returns kept ones in input order. */
export function cullLabels<T extends { box: PaperBox; priority: number; size?: number; svg?: string; fallbacks?: { box: PaperBox; svg: string }[] }>(labels: readonly T[], culler: LabelCuller = new LabelCuller()): T[] {
  const order = labels.map((_, i) => i).sort((a, b) => labels[b].priority - labels[a].priority || a - b);
  const keep = new Array<boolean>(labels.length).fill(false);
  for (const i of order) {
    const l = labels[i];
    if (l.size !== undefined && l.size < MIN_TEXT_MM - 1e-9) continue;
    keep[i] = culler.tryPlace(l.box);
    // backlog T2 #2: a label with fallback placements (position tags) moves to the first free one instead of being dropped
    if (!keep[i] && l.fallbacks) {
      for (const f of l.fallbacks) {
        if (!culler.tryPlace(f.box)) continue;
        l.box = f.box;
        l.svg = f.svg;
        keep[i] = true;
        break;
      }
    }
  }
  return labels.filter((_, i) => keep[i]);
}

// ───────────────────────────── paper primitives ─────────────────────────────

export interface DimChainOptions {
  /** 'h': stops are paper x, dimension line at paper y = `at` · 'v': stops are paper y, line at paper x = `at` */
  axis: 'h' | 'v';
  at: number;
  /** paper coordinate where the extension lines start (the measured object edge); default: short ticks only */
  from?: number;
  size?: number;
  stroke?: string;
  sw?: number;
  /** text side: −1 = above / left of the line (default), +1 = below / right */
  textSide?: -1 | 1;
  /** when given, texts are also culled against (and reserved in) this culler */
  culler?: LabelCuller;
}

/**
 * Horizontal or vertical dimension chain with 45° ticks. A segment whose text + DIM_TEXT_CLEARANCE_MM does not fit between its stops
 * is suppressed (text omitted, stops kept) and its index returned so the sheet can defer it to an enlarged sheet.
 */
export function dimChain(stops: readonly number[], texts: readonly string[], o: DimChainOptions): { svg: string; suppressed: number[]; boxes: PaperBox[] } {
  const s = stops.filter(Number.isFinite);
  const out: string[] = [];
  const suppressed: number[] = [];
  const boxes: PaperBox[] = [];
  if (s.length < 2) return { svg: '', suppressed, boxes };
  const stroke = o.stroke ?? INK;
  const sw = o.sw ?? PAPER_LW.hair;
  const size = Math.max(MIN_TEXT_MM, o.size ?? ANN_TEXT.dim);
  const side = o.textSide ?? -1;
  const lo = s[0];
  const hi = s[s.length - 1];
  const t = 0.9; // tick half length
  if (o.axis === 'h') {
    out.push(line(lo - 1.2, o.at, hi + 1.2, o.at, { stroke, sw }));
    for (const x of s) {
      if (o.from !== undefined) out.push(line(x, o.from + Math.sign(o.at - o.from) * 0.8, x, o.at + Math.sign(o.at - o.from || 1) * 1.2, { stroke, sw }));
      out.push(line(x - t, o.at + t, x + t, o.at - t, { stroke, sw: PAPER_LW.thin }));
    }
  } else {
    out.push(line(o.at, lo - 1.2, o.at, hi + 1.2, { stroke, sw }));
    for (const y of s) {
      if (o.from !== undefined) out.push(line(o.from + Math.sign(o.at - o.from) * 0.8, y, o.at + Math.sign(o.at - o.from || 1) * 1.2, y, { stroke, sw }));
      out.push(line(o.at - t, y + t, o.at + t, y - t, { stroke, sw: PAPER_LW.thin }));
    }
  }
  for (let i = 0; i + 1 < s.length; i++) {
    const label = texts[i] ?? '';
    if (!label) continue;
    const a = s[i];
    const b = s[i + 1];
    const len = Math.abs(b - a);
    const tw = textWidth(label, size);
    if (tw + DIM_TEXT_CLEARANCE_MM > len) {
      suppressed.push(i);
      continue;
    }
    const mid = (a + b) / 2;
    let svg: string;
    let box: PaperBox;
    if (o.axis === 'h') {
      const ty = side < 0 ? o.at - 0.8 : o.at + 0.8 + size * 0.8;
      box = textBox(mid, ty, label, size, 'middle');
      svg = text(mid, ty, label, { size, anchor: 'middle', fill: stroke });
    } else {
      const tx = side < 0 ? o.at - 0.8 : o.at + 0.8 + size * 0.8;
      box = textBox(tx, mid, label, size, 'middle', 'auto', -90);
      svg = text(tx, mid, label, { size, anchor: 'middle', fill: stroke, rotate: -90 });
    }
    if (o.culler && !o.culler.tryPlace(box)) {
      suppressed.push(i);
      continue;
    }
    boxes.push(box);
    out.push(svg);
  }
  return { svg: out.join(''), suppressed, boxes };
}

/**
 * Level datum `▽ +2.73 TOP OF CONTAINMENT`: apex of the ▽ on (x, y), optional thin level line from `lineFrom` to `lineTo` (paper x).
 * `textDy` staggers the text vertically (paper mm) with a dogleg leader, for levels closer than the text height.
 */
export function levelDatum(x: number, y: number, value: string, label: string, o: { side?: 'left' | 'right'; size?: number; lineFrom?: number; lineTo?: number; stroke?: string; textDy?: number } = {}): { svg: string; box: PaperBox } {
  const size = Math.max(MIN_TEXT_MM, o.size ?? ANN_TEXT.datum);
  const stroke = o.stroke ?? INK;
  const side = o.side ?? 'right';
  const dy = o.textDy ?? 0;
  const out: string[] = [];
  if (o.lineFrom !== undefined && o.lineTo !== undefined) out.push(line(o.lineFrom, y, o.lineTo, y, { stroke: INK_SOFT, sw: PAPER_LW.hair, dash: '3 1' }));
  out.push(polygon([[x - 1.2, y - 2], [x + 1.2, y - 2], [x, y]], { fill: PAPER, stroke, sw: PAPER_LW.thin }));
  out.push(line(x - 2.4, y, x + 2.4, y, { stroke, sw: PAPER_LW.thin }));
  const s = label ? `${value} ${label}` : value;
  const sgn = side === 'right' ? 1 : -1;
  const tx = x + sgn * (Math.abs(dy) > 1e-9 ? 5 : 3);
  const anchor = side === 'right' ? 'start' : 'end';
  if (Math.abs(dy) > 1e-9) out.push(path(`M${n(x + sgn * 2.4)} ${n(y)} L${n(x + sgn * 3.6)} ${n(y + dy)} L${n(tx - sgn * 0.4)} ${n(y + dy)}`, { stroke: INK_SOFT, sw: PAPER_LW.hair }));
  if (s) out.push(text(tx, y + dy - 0.6, s, { size, anchor, fill: stroke, weight: 500 }));
  return { svg: out.join(''), box: s ? textBox(tx, y + dy - 0.6, s, size, anchor) : { x, y, w: 0, h: 0 } };
}

/** Keynote ellipse with its 2-digit id; optional leader to a target point. */
export function keynoteEllipse(x: number, y: number, id: string, o: { leaderTo?: Pt; size?: number } = {}): { svg: string; box: PaperBox } {
  const size = Math.max(MIN_TEXT_MM, o.size ?? ANN_TEXT.keynote);
  const rx = Math.max(2.4, textWidth(id, size) / 2 + 1);
  const ry = size * 0.95;
  const out: string[] = [];
  if (o.leaderTo) {
    const [tx, ty] = o.leaderTo;
    const dx = tx - x;
    const dy = ty - y;
    const d = Math.hypot(dx, dy);
    if (d > rx + 0.5) {
      // leader starts on the ellipse boundary
      const k = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
      out.push(line(x + dx * k, y + dy * k, tx, ty, { stroke: INK, sw: PAPER_LW.hair }));
      out.push(circle(tx, ty, 0.35, { fill: INK }));
    }
  }
  out.push(`<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(rx)}" ry="${n(ry)}" fill="${PAPER}" stroke="${INK}" stroke-width="${n(PAPER_LW.thin)}"/>`);
  out.push(text(x, y, id, { size, anchor: 'middle', baseline: 'central', fill: INK, weight: 600 }));
  return { svg: out.join(''), box: { x: x - rx, y: y - ry, w: 2 * rx, h: 2 * ry } };
}

/** Position tag text (`A01`), monospace, ink (never a rack fill colour). */
export function positionTag(x: number, y: number, tag: string, o: { rot?: number; size?: number; anchor?: 'start' | 'middle' | 'end' } = {}): { svg: string; box: PaperBox } {
  const size = Math.max(MIN_TEXT_MM, o.size ?? ANN_TEXT.position);
  const anchor = o.anchor ?? 'middle';
  return {
    svg: text(x, y, tag, { size, anchor, baseline: 'central', fill: INK_SOFT, weight: 600, family: MONO, rotate: o.rot }),
    box: textBox(x, y, tag, size * 1.05, anchor, 'central', o.rot ?? 0),
  };
}

/** Equipment tag inside a paper footprint: along the long side, largest size ≤ `size` that fits; '' when it cannot reach MIN_TEXT_MM. */
export function equipmentTag(r: PaperBox, tag: string, o: { size?: number; pad?: number } = {}): { svg: string; box: PaperBox | null } {
  const pad = o.pad ?? 0.4;
  const vertical = r.h > r.w;
  const along = (vertical ? r.h : r.w) - 2 * pad;
  const across = (vertical ? r.w : r.h) - 2 * pad;
  const unit = textWidth(tag, 1);
  const size = Math.min(o.size ?? ANN_TEXT.tag, unit > 0 ? along / unit : Infinity, across);
  if (!(size >= MIN_TEXT_MM - 1e-9)) return { svg: '', box: null };
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const rot = vertical ? -90 : 0;
  return { svg: text(cx, cy, tag, { size, anchor: 'middle', baseline: 'central', fill: INK, rotate: rot || undefined }), box: textBox(cx, cy, tag, size, 'middle', 'central', rot) };
}

/** Circular bubble: label over target sheet number (split line) or the label alone. */
export function calloutBubble(x: number, y: number, label: string, target?: string, o: { r?: number; stroke?: string } = {}): { svg: string; box: PaperBox } {
  const stroke = o.stroke ?? CALLOUT_INK;
  const r = o.r ?? Math.max(4.2, (textWidth(target ?? '', MIN_TEXT_MM) + 1.6) / 2);
  const out = [circle(x, y, r, { fill: PAPER, stroke, sw: PAPER_LW.medium })];
  if (target) {
    out.push(line(x - r, y, x + r, y, { stroke, sw: PAPER_LW.thin }));
    const ls = Math.max(MIN_TEXT_MM, Math.min(ANN_TEXT.bubble, (2 * r - 1.6) / Math.max(0.1, textWidth(label, 1))));
    const ts = Math.max(MIN_TEXT_MM, Math.min(2.0, (2 * r - 1.2) / Math.max(0.1, textWidth(target, 1))));
    out.push(text(x, y - r * 0.38, label, { size: ls, anchor: 'middle', baseline: 'central', fill: stroke, weight: 700 }));
    out.push(text(x, y + r * 0.42, target, { size: ts, anchor: 'middle', baseline: 'central', fill: stroke, weight: 500 }));
  } else {
    out.push(text(x, y, label, { size: ANN_TEXT.bubble, anchor: 'middle', baseline: 'central', fill: stroke, weight: 700 }));
  }
  return { svg: out.join(''), box: { x: x - r, y: y - r, w: 2 * r, h: 2 * r } };
}

/** Rounded dash-dot callout boundary. */
export function calloutBoundary(r: PaperBox, o: { radius?: number; stroke?: string } = {}): string {
  const rad = Math.min(o.radius ?? 3, r.w / 2, r.h / 2);
  return `<rect x="${n(r.x)}" y="${n(r.y)}" width="${n(Math.max(0, r.w))}" height="${n(Math.max(0, r.h))}" rx="${n(rad)}" fill="none" stroke="${o.stroke ?? CALLOUT_INK}" stroke-width="${n(PAPER_LW.medium)}" stroke-dasharray="${DASH_DOT}"/>`;
}

/** Boundary + bubble outside its top-right corner + leader (enlarged-plan / detail callout). */
export function callout(r: PaperBox, label: string, target?: string, o: { bubbleAt?: Pt; r?: number } = {}): { svg: string; box: PaperBox } {
  const br = o.r ?? 4.2;
  const [bx, by] = o.bubbleAt ?? [r.x + r.w + br + 2.5, r.y - br - 2.5];
  const corner: Pt = [r.x + r.w, r.y];
  const d = Math.hypot(bx - corner[0], by - corner[1]);
  const lead = d > br ? line(corner[0], corner[1], bx - ((bx - corner[0]) / d) * br, by - ((by - corner[1]) / d) * br, { stroke: CALLOUT_INK, sw: PAPER_LW.thin }) : '';
  const b = calloutBubble(bx, by, label, target, { r: br });
  return { svg: calloutBoundary(r) + lead + b.svg, box: b.box };
}

/**
 * Section / elevation marker: heavy dash-dot cut line p0→p1 with a bubble at each end (label over target sheet) and a filled look
 * arrow beside each bubble pointing along `lookDir` (paper unit vector ⟂ the line).
 */
export function sectionMarker(p0: Pt, p1: Pt, lookDir: Pt, label: string, target?: string, o: { r?: number } = {}): { svg: string; boxes: PaperBox[] } {
  const r = o.r ?? 4.2;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const ll = Math.hypot(lookDir[0], lookDir[1]) || 1;
  const lx = lookDir[0] / ll;
  const ly = lookDir[1] / ll;
  const out: string[] = [line(p0[0], p0[1], p1[0], p1[1], { stroke: CALLOUT_INK, sw: PAPER_LW.heavy, dash: DASH_DOT })];
  const boxes: PaperBox[] = [];
  for (const [end, sgn] of [[p0, -1], [p1, 1]] as const) {
    const cx = end[0] + ux * sgn * (r + 1);
    const cy = end[1] + uy * sgn * (r + 1);
    // look arrow: triangle with its base on the bubble edge side, apex in the look direction
    const ax = cx + lx * (r + 3.2);
    const ay = cy + ly * (r + 3.2);
    const bx0 = cx + lx * r * 0.6 + ux * 2.2;
    const by0 = cy + ly * r * 0.6 + uy * 2.2;
    const bx1 = cx + lx * r * 0.6 - ux * 2.2;
    const by1 = cy + ly * r * 0.6 - uy * 2.2;
    out.push(path(`M${n(bx0)} ${n(by0)} L${n(ax)} ${n(ay)} L${n(bx1)} ${n(by1)} Z`, { fill: CALLOUT_INK }));
    const b = calloutBubble(cx, cy, label, target, { r });
    out.push(b.svg);
    boxes.push(b.box);
  }
  return { svg: out.join(''), boxes };
}

/** Cross-reference note (S11) with an optional leader to a point. */
export function crossRefNote(x: number, y: number, s: string, o: { size?: number; anchor?: 'start' | 'middle' | 'end'; leaderTo?: Pt } = {}): { svg: string; box: PaperBox } {
  const size = Math.max(MIN_TEXT_MM, o.size ?? ANN_TEXT.note);
  const anchor = o.anchor ?? 'start';
  const out: string[] = [];
  if (o.leaderTo) out.push(line(x, y - size * 0.3, o.leaderTo[0], o.leaderTo[1], { stroke: INK_SOFT, sw: PAPER_LW.hair }));
  out.push(text(x, y, s, { size, anchor, fill: INK, weight: 500 }));
  return { svg: out.join(''), box: textBox(x, y, s, size, anchor) };
}

// ───────────────────────────── S11 generated notes ─────────────────────────────

export type NoteSystem = 'busway' | 'trays' | 'pipes' | 'containment' | 'racks' | 'cdu' | 'network';

const NOTE_TEXT: Record<NoteSystem, { en: string; ko: string; kinds: string[] }> = {
  busway: { en: 'BUSWAY A/B', ko: '버스웨이 A/B', kinds: ['one-line', 'services-plan'] },
  trays: { en: 'CABLE LADDERS T1–T3', ko: '케이블 래더 T1–T3', kinds: ['services-plan', 'section'] },
  pipes: { en: 'TCS SUPPLY / RETURN PIPING', ko: 'TCS 공급 / 환수 배관', kinds: ['mep-iso', 'section'] },
  containment: { en: 'AISLE CONTAINMENT & DOORS', ko: '복도 컨테인먼트 및 문', kinds: ['elevation', 'enlarged-plan'] },
  racks: { en: 'RACK CONTENTS', ko: '랙 구성', kinds: ['rack-elevation'] },
  cdu: { en: 'CDU CONNECTIONS', ko: 'CDU 연결', kinds: ['mep-iso', 'services-plan'] },
  network: { en: 'ROW POSITIONS & LEAF GROUPS', ko: '열 위치 및 리프 그룹', kinds: ['row-schematic'] },
};

/**
 * Notes that refer elsewhere (S11): one per present system, pointing at the first sheet of the target kind (same hall preferred).
 * Systems whose target sheet is not in the set are omitted.
 */
export function crossRefNotes(sheets: readonly { number: string; kind: string; hallId?: string }[], present: readonly NoteSystem[], locale: Locale, hallId?: string): { system: NoteSystem; text: string; ref: string }[] {
  const out: { system: NoteSystem; text: string; ref: string }[] = [];
  for (const sys of present) {
    const def = NOTE_TEXT[sys];
    let ref: string | undefined;
    for (const kind of def.kinds) {
      const cands = sheets.filter((s) => s.kind === kind);
      const hit = cands.find((s) => hallId && s.hallId === hallId) ?? cands[0];
      if (hit) {
        ref = hit.number;
        break;
      }
    }
    if (!ref) continue;
    out.push({ system: sys, ref, text: locale === 'ko' ? `${def.ko} — ${ref} 참조` : `${def.en} — SEE ${ref}` });
  }
  return out;
}

// ───────────────────────────── datums ─────────────────────────────

const DATUM_LABELS: Record<string, { en: string; ko: string }> = {
  ffl: { en: 'FFL', ko: 'FFL' },
  slab: { en: 'TOP OF SLAB', ko: '슬래브 상단' },
  'raised-floor': { en: 'RAISED FLOOR', ko: '이중마루' },
  'rack-top': { en: 'TOP OF RACK', ko: '랙 상단' },
  containment: { en: 'TOP OF CONTAINMENT', ko: '컨테인먼트 상단' },
  chimney: { en: 'TOP OF CHIMNEY', ko: '침니 상단' },
  pipe: { en: 'TCS PIPE', ko: 'TCS 배관' },
  busway: { en: 'BUSWAY', ko: '버스웨이' },
  T1: { en: 'LADDER T1', ko: '래더 T1' },
  T2: { en: 'LADDER T2', ko: '래더 T2' },
  T3: { en: 'LADDER T3', ko: '래더 T3' },
  light: { en: 'LIGHT STRIP', ko: '조명 스트립' },
  ceiling: { en: 'CEILING', ko: '천장' },
  deck: { en: 'UNDERSIDE OF DECK', ko: '데크 하부' },
  door: { en: 'DOOR HEAD', ko: '문 상단' },
};

/** Localized datum label by datum id (FFL, rack-top, containment, pipe, busway, T1–T3, light, ceiling, deck); fallback = the datum's own label. */
export function datumLabel(id: string, locale: Locale, fallback?: string): string {
  const d = DATUM_LABELS[id] ?? DATUM_LABELS[id.replace(/^datum[:-]/, '')];
  if (d) return locale === 'ko' ? d.ko : d.en;
  return fallback ?? id;
}

// ───────────────────────────── row positions ─────────────────────────────

export interface RowSlotInput {
  id: string;
  /** extent along the row axis (m) */
  a0: number;
  a1: number;
  /** 'rack' takes a position number; 'unit' (CDU, CRAH, tap-off box …) does not */
  kind: 'rack' | 'unit';
  tag?: string;
}

export interface RowSlot<T extends RowSlotInput = RowSlotInput> {
  item: T;
  /** 1-based position (racks only) */
  position?: number;
  /** `<rowLetter><pos:02>` (racks only) */
  positionTag?: string;
}

export interface RowGap {
  /** index into `slots` of the slot before the gap */
  afterSlot: number;
  /** last position before the gap (undefined when no rack precedes it) */
  afterPosition?: number;
  a0: number;
  a1: number;
  width: number;
  /** 'gap' = unoccupied spacing (≥ MID_ROW_GAP_MIN_M) · 'break' = RCU / enclosure break */
  kind: 'gap' | 'break';
}

export interface RowSlotsResult<T extends RowSlotInput = RowSlotInput> {
  letter: string;
  slots: RowSlot<T>[];
  gaps: RowGap[];
  a0: number;
  a1: number;
  /** contiguous runs [a0, a1] between gaps */
  runs: { a0: number; a1: number; slots: number[] }[];
}

/** A neighbour gap wider than this (m) is a row gap (r4-gap §4.7). */
export const ROW_GAP_MIN_M = 0.05;
/** A row gap at least this wide (m) is unoccupied spacing; narrower ones are enclosure (RCU) breaks. */
export const MID_ROW_GAP_MIN_M = 0.3;

/** Row letter = rowId suffix ('pod-01-a' → 'A', 'row-B' → 'B'); falls back to the last 1–2 alphanumerics. */
export function rowLetter(rowId: string): string {
  const parts = rowId.split(/[-_#/:]/).filter(Boolean);
  const last = parts[parts.length - 1] ?? '';
  if (/^[a-z]{1,2}$/i.test(last)) return last.toUpperCase();
  const m = /([a-z]{1,2})\d*$/i.exec(rowId);
  if (m) return m[1].toUpperCase();
  return last.slice(-2).toUpperCase() || 'R';
}

/**
 * Floor-order slots of one row: racks numbered 01…n in ascending axis order (every rack slot counts — compute, NET, ACC, reserves
 * when passed in); units unnumbered; gaps (> ROW_GAP_MIN_M) take no number.
 */
export function rowSlots<T extends RowSlotInput>(rowId: string, items: readonly T[], opts: { letter?: string } = {}): RowSlotsResult<T> {
  const letter = opts.letter ?? rowLetter(rowId);
  const sorted = [...items].sort((p, q) => p.a0 - q.a0 || p.a1 - q.a1 || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const slots: RowSlot<T>[] = [];
  const gaps: RowGap[] = [];
  const runs: RowSlotsResult<T>['runs'] = [];
  let pos = 0;
  let reach = -Infinity;
  let lastPos: number | undefined;
  let run: { a0: number; a1: number; slots: number[] } | null = null;
  sorted.forEach((it, i) => {
    if (i > 0 && it.a0 - reach > ROW_GAP_MIN_M) {
      const width = it.a0 - reach;
      gaps.push({ afterSlot: i - 1, afterPosition: lastPos, a0: reach, a1: it.a0, width, kind: width >= MID_ROW_GAP_MIN_M - 1e-6 ? 'gap' : 'break' });
      if (run) runs.push(run);
      run = null;
    }
    const slot: RowSlot<T> = { item: it };
    if (it.kind === 'rack') {
      pos++;
      lastPos = pos;
      slot.position = pos;
      slot.positionTag = `${letter}${String(pos).padStart(2, '0')}`;
    }
    slots.push(slot);
    if (!run) run = { a0: it.a0, a1: it.a1, slots: [] };
    run.a1 = Math.max(run.a1, it.a1);
    run.slots.push(i);
    reach = Math.max(reach, it.a1);
  });
  if (run) runs.push(run);
  return { letter, slots, gaps, a0: sorted.length ? sorted[0].a0 : 0, a1: Number.isFinite(reach) ? reach : 0, runs };
}

// ───────────────────────────── annotate() ─────────────────────────────

interface PrimRow {
  rowId: string;
  axis: 'x' | 'y';
  center: number;
  depth: number;
  frontSign: 1 | -1;
  podId?: string;
  slots: RowSlotsResult<RowSlotInput & { prim: Prim }>;
}

function primRows(hp: HallPrims): PrimRow[] {
  const byRow = new Map<string, Prim[]>();
  for (const p of hp.prims) {
    if ((p.emitter !== 'rack' && p.emitter !== 'unit') || !p.rowId) continue;
    const list = byRow.get(p.rowId);
    if (list) list.push(p);
    else byRow.set(p.rowId, [p]);
  }
  const rows: PrimRow[] = [];
  for (const [rowId, prims] of [...byRow.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const g = hp.rows.find((r) => r.id === rowId);
    const boxes = prims.map((p) => primAabb(p));
    const x0 = Math.min(...boxes.map((b) => b.min.x));
    const x1 = Math.max(...boxes.map((b) => b.max.x));
    const y0 = Math.min(...boxes.map((b) => b.min.y));
    const y1 = Math.max(...boxes.map((b) => b.max.y));
    const axis: 'x' | 'y' = g?.axis ?? (x1 - x0 >= y1 - y0 ? 'x' : 'y');
    const racks = prims.filter((p) => p.emitter === 'rack');
    const depthBoxes = (racks.length ? racks : prims).map((p) => primAabb(p));
    const c0 = Math.min(...depthBoxes.map((b) => (axis === 'x' ? b.min.y : b.min.x)));
    const c1 = Math.max(...depthBoxes.map((b) => (axis === 'x' ? b.max.y : b.max.x)));
    const fsMeta = racks.find((p) => p.meta?.frontSign === 1 || p.meta?.frontSign === -1)?.meta?.frontSign as 1 | -1 | undefined;
    const items = prims.map((p, i) => ({
      id: p.id,
      a0: axis === 'x' ? boxes[i].min.x : boxes[i].min.y,
      a1: axis === 'x' ? boxes[i].max.x : boxes[i].max.y,
      kind: p.emitter === 'rack' ? ('rack' as const) : ('unit' as const),
      tag: p.tag,
      prim: p,
    }));
    rows.push({ rowId, axis, center: g?.center ?? (c0 + c1) / 2, depth: c1 - c0, frontSign: g?.frontSign ?? fsMeta ?? 1, podId: g?.podId ?? prims[0].podId, slots: rowSlots(rowId, items) });
  }
  return rows;
}

function rectsTouch(a: Rect, b: Rect): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.d && b.y <= a.y + a.d;
}

function itemExtent(it: DrawItem2D): Rect | null {
  const p = it.pts;
  if (it.kind === 'rect') return { x: Math.min(p[0], p[0] + p[2]), y: Math.min(p[1], p[1] + p[3]), w: Math.abs(p[2]), d: Math.abs(p[3]) };
  if (it.kind === 'circle') return { x: p[0] - p[2], y: p[1] - p[2], w: 2 * p[2], d: 2 * p[2] };
  if (p.length < 2) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < p.length; i += 2) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
}

function podLabel(podId: string): string {
  const m = /^pod-(\d+)$/.exec(podId);
  if (m) return `DU${m[1].padStart(2, '0')}`;
  return podId.toUpperCase();
}

const sortedIdOrder = (a: Prim, b: Prim) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Annotations for one draw list (world metres in its space).
 *  plan: equipment tags (lod 2), position tags outside each rack's front edge (lod 3), DU labels (lod 1), per-row x-chains
 *        wall → runs / gaps → wall (per-rack stops at ≤ 1:50), aisle widths between facing rows, keynotes (one per keynote id used,
 *        lod 3), section markers (opts.cuts / project.drawingCuts), callouts (opts.callouts), structural grid bubbles.
 *  section / elevation: level datums at the right edge (lod 1) + a vertical datum chain at the left edge, position / equipment tags
 *        on racks, a horizontal chain under the floor over the cut racks and aisles, keynotes.
 */
export function annotate(project: Project, hp: HallPrims, list: DrawList2D, opts: AnnotateOptions = {}): Annotation2D[] {
  const L: Locale = opts.locale ?? project.locale ?? 'en';
  const units = opts.units ?? drawingUnitsOf(project);
  const den = opts.scaleDen;
  const lod = opts.lod ?? 3;
  const layerOn = (l: LayerId) => !opts.layers || opts.layers.includes(l);
  const hall = project.halls.find((h) => h.id === hp.hallId);
  const out: Annotation2D[] = [];
  const bounds = list.bounds;
  const hasBounds = bounds.w > 0 && bounds.d > 0;
  const win = opts.window ?? (hasBounds ? bounds : null);
  const len = (m: number) => fmtLength(m, units, den);

  if (list.space === 'plan') {
    const inWin = (r: Rect) => !win || rectsTouch(r, win);
    const rows = primRows(hp);
    const hallW = hall?.width ?? (hasBounds ? bounds.x + bounds.w : 0);
    const hallD = hall?.depth ?? (hasBounds ? bounds.y + bounds.d : 0);
    const rowRectOf = (row: (typeof rows)[number]): Rect => (row.axis === 'x' ? { x: row.slots.a0, y: row.center - row.depth / 2, w: row.slots.a1 - row.slots.a0, d: row.depth } : { x: row.center - row.depth / 2, y: row.slots.a0, w: row.depth, d: row.slots.a1 - row.slots.a0 });
    // QA r4 sheets: rows on one chain line (pods in line along the row axis) share one wall → runs → wall chain; before, each row drew
    // its own full-length chain on the same line, so the segment texts of different rows interleaved on one dimension line
    const chainAt = (row: (typeof rows)[number]) => row.center + row.frontSign * (row.depth / 2 + 0.85);
    const chainKey = (row: (typeof rows)[number]) => `${row.axis}:${Math.round(chainAt(row) * 1000)}`;
    const chainGroups = new Map<string, (typeof rows)[number][]>();
    for (const r of rows) {
      if (!inWin(rowRectOf(r))) continue;
      const k = chainKey(r);
      const g = chainGroups.get(k);
      if (g) g.push(r);
      else chainGroups.set(k, [r]);
    }
    const chainDone = new Set<string>();
    for (const row of rows) {
      const { slots } = row;
      const rowRect: Rect = rowRectOf(row);
      if (!inWin(rowRect)) continue;
      const P = (a: number, c: number): [number, number] => (row.axis === 'x' ? [a, c] : [c, a]);
      // equipment + position tags
      for (const s of slots.slots) {
        const p = s.item.prim;
        const bb = primAabb(p);
        const r: Rect = { x: bb.min.x, y: bb.min.y, w: bb.max.x - bb.min.x, d: bb.max.y - bb.min.y };
        if (!inWin(r)) continue;
        if (p.tag) out.push({ kind: 'tag', pts: [r.x + r.w / 2, r.y + r.d / 2], text: p.tag, priority: 10, layer: 'tags', lodMin: 2, size: ANN_TEXT.tag, rot: r.d > r.w ? -90 : 0, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) });
        if (s.positionTag) {
          const mid = (s.item.a0 + s.item.a1) / 2;
          const off = row.center + row.frontSign * (row.depth / 2 + 0.3);
          // backlog T2 #2: pts[2..3] = world unit vector away from the rack (front side), so the sheet renderer can move a tag that a
          // DU label or another higher-priority text covers further out instead of dropping it
          const [ox, oy] = P(0, row.frontSign);
          out.push({ kind: 'position-tag', pts: [...P(mid, off), ox, oy], text: s.positionTag, priority: 12, layer: 'position-tags', lodMin: 3, size: ANN_TEXT.position, rot: row.axis === 'y' ? -90 : 0, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) });
        }
      }
      // x-chain along the row, on the front side beyond the position tags (keeps the contained aisle clear)
      const chainK = chainKey(row);
      const group = chainGroups.get(chainK) ?? [row];
      const hallLen = row.axis === 'x' ? hallW : hallD;
      const stops: number[] = [];
      const lo = win ? (row.axis === 'x' ? win.x : win.y) : -Infinity;
      const hi = win ? (row.axis === 'x' ? win.x + win.w : win.y + win.d) : Infinity;
      const gA0 = Math.min(...group.map((g) => g.slots.a0));
      const gA1 = Math.max(...group.map((g) => g.slots.a1));
      if (hallLen > 0 && 0 >= lo - 1e-6 && 0 <= hi + 1e-6 && gA0 > 1e-3) stops.push(0);
      for (const g of group)
        for (const run of g.slots.runs) {
          stops.push(run.a0);
          if (den !== undefined && den <= 50) for (const i of run.slots.slice(1)) stops.push(g.slots.slots[i].item.a0);
          stops.push(run.a1);
        }
      if (hallLen > 0 && hallLen >= lo - 1e-6 && hallLen <= hi + 1e-6 && hallLen - gA1 > 1e-3) stops.push(hallLen);
      const uniq = chainDone.has(chainK) ? [] : [...new Set(stops.map((v) => Math.round(v * 1e4) / 1e4))].sort((a, b) => a - b);
      chainDone.add(chainK);
      if (uniq.length >= 2) {
        const c = chainAt(row);
        const pts: number[] = [];
        for (const v of uniq) pts.push(...P(v, c));
        out.push({ kind: 'dim-chain', pts, texts: uniq.slice(1).map((v, i) => len(v - uniq[i])), axis: row.axis === 'x' ? 'h' : 'v', priority: 25, layer: 'dimensions', lodMin: 2, size: ANN_TEXT.dim, refId: row.rowId });
      }
    }
    // aisle widths between neighbouring parallel rows of the same pod
    for (const axis of ['x', 'y'] as const) {
      const rs = rows.filter((r) => r.axis === axis).sort((a, b) => a.center - b.center);
      for (let i = 0; i + 1 < rs.length; i++) {
        const a = rs[i];
        const b = rs[i + 1];
        if (a.podId !== b.podId) continue;
        const f0 = a.center + a.depth / 2;
        const f1 = b.center - b.depth / 2;
        const ov0 = Math.max(a.slots.a0, b.slots.a0);
        const ov1 = Math.min(a.slots.a1, b.slots.a1);
        if (!(f1 - f0 > 0.3 && f1 - f0 < 6 && ov1 > ov0)) continue;
        const at = ov0 + Math.min(0.9, (ov1 - ov0) / 2);
        const r: Rect = axis === 'x' ? { x: at, y: f0, w: 0, d: f1 - f0 } : { x: f0, y: at, w: f1 - f0, d: 0 };
        if (!inWin(r)) continue;
        const pts = axis === 'x' ? [at, f0, at, f1] : [f0, at, f1, at];
        out.push({ kind: 'dim-chain', pts, texts: [len(f1 - f0)], axis: axis === 'x' ? 'v' : 'h', priority: 26, layer: 'dimensions', lodMin: 2, size: ANN_TEXT.dim, refId: `${a.rowId}|${b.rowId}` });
      }
    }
    // DU labels
    const pods = new Map<string, Rect>();
    for (const p of hp.prims) {
      if (p.emitter !== 'rack' || !p.podId) continue;
      const bb = primAabb(p);
      const cur = pods.get(p.podId);
      const x0 = Math.min(bb.min.x, cur ? cur.x : Infinity);
      const y0 = Math.min(bb.min.y, cur ? cur.y : Infinity);
      const x1 = Math.max(bb.max.x, cur ? cur.x + cur.w : -Infinity);
      const y1 = Math.max(bb.max.y, cur ? cur.y + cur.d : -Infinity);
      pods.set(p.podId, { x: x0, y: y0, w: x1 - x0, d: y1 - y0 });
    }
    for (const [podId, r] of [...pods.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (!inWin(r)) continue;
      // beyond the front-side row chain of the top row (chain at row edge + 0.85 m)
      out.push({ kind: 'du-label', pts: [r.x + r.w / 2, r.y + r.d + 1.7], text: podLabel(podId), priority: 20, layer: 'tags', lodMin: 1, size: ANN_TEXT.duLabel, refId: podId });
    }
    // keynotes: one per id, at the lowest-id prim of that keynote inside the window
    const firstByKeynote = new Map<string, Prim>();
    for (const p of [...hp.prims].sort(sortedIdOrder)) {
      const k = keynoteForPrim(p);
      if (!k || firstByKeynote.has(k)) continue;
      const bb = primAabb(p);
      if (!inWin({ x: bb.min.x, y: bb.min.y, w: bb.max.x - bb.min.x, d: bb.max.y - bb.min.y })) continue;
      firstByKeynote.set(k, p);
    }
    for (const [k, p] of [...firstByKeynote.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const bb = primAabb(p);
      const cx = (bb.min.x + bb.max.x) / 2;
      const cy = (bb.min.y + bb.max.y) / 2;
      out.push({ kind: 'keynote', pts: [cx + 0.7, cy + 0.7, cx, cy], text: k, keynoteId: k, priority: 40, layer: 'keynotes', lodMin: 3, size: ANN_TEXT.keynote, primId: p.id });
    }
    // section markers
    const cuts = opts.cuts ?? (project.drawingCuts ?? []).filter((c) => c.hallId === hp.hallId).map((cut): { cut: DrawingCut; target?: string } => ({ cut }));
    for (const { cut, target } of cuts) {
      const letter = cut.label.split(/[–\-—\s]/).filter(Boolean)[0] ?? cut.label;
      const span = win ?? { x: 0, y: 0, w: hallW, d: hallD };
      if (cut.axis === 'y') {
        // plane ⟂ y at `at`; u = look·x → window in x
        const x0 = cut.window ? Math.min(cut.look * cut.window.u0, cut.look * cut.window.u1) : span.x - 0.5;
        const x1 = cut.window ? Math.max(cut.look * cut.window.u0, cut.look * cut.window.u1) : span.x + span.w + 0.5;
        out.push({ kind: 'section-marker', pts: [x0, cut.at, x1, cut.at], text: letter, look: cut.look, priority: 50, layer: 'notes', lodMin: 1, refId: cut.id, ...(target ? { target } : {}) });
      } else {
        const y0 = cut.window ? Math.min(-cut.look * cut.window.u0, -cut.look * cut.window.u1) : span.y - 0.5;
        const y1 = cut.window ? Math.max(-cut.look * cut.window.u0, -cut.look * cut.window.u1) : span.y + span.d + 0.5;
        out.push({ kind: 'section-marker', pts: [cut.at, y0, cut.at, y1], text: letter, look: cut.look, priority: 50, layer: 'notes', lodMin: 1, refId: cut.id, ...(target ? { target } : {}) });
      }
    }
    for (const c of opts.callouts ?? []) out.push({ kind: 'callout', pts: [c.rect.x, c.rect.y, c.rect.w, c.rect.d], text: c.label, priority: 45, layer: 'notes', lodMin: 1, ...(c.target ? { target: c.target } : {}) });
    // structural grid bubbles (only when the hall carries an explicit grid)
    const sg = hall?.structuralGrid;
    if (sg) {
      sg.x?.at.forEach((x, i) => out.push({ kind: 'grid-bubble', pts: [x, hallD + 1.2], text: sg.x?.labels?.[i] ?? String.fromCharCode(65 + (i % 26)), priority: 35, layer: 'structural-grid', lodMin: 1 }));
      sg.y?.at.forEach((y, i) => out.push({ kind: 'grid-bubble', pts: [-1.2, y], text: sg.y?.labels?.[i] ?? String(i + 1), priority: 35, layer: 'structural-grid', lodMin: 1 }));
    }
  } else {
    // section / elevation: (u, z)
    const uHi = hasBounds ? bounds.x + bounds.w : 0;
    const uLo = hasBounds ? bounds.x : 0;
    const datums = [...hp.datums].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
    for (const d of datums) {
      out.push({ kind: 'datum', pts: [uHi + 0.3, d.z], text: `${fmtLevel(d.z, units)} ${datumLabel(d.id, L, d.label)}`, priority: 30, layer: 'datums', lodMin: 1, size: ANN_TEXT.datum, side: 'right', source: d.source, refId: d.id });
    }
    const zs = [...new Set(datums.map((d) => Math.round(d.z * 1e4) / 1e4))].sort((a, b) => a - b);
    if (zs.length >= 2) {
      const pts: number[] = [];
      for (const z of zs) pts.push(uLo - 0.6, z);
      out.push({ kind: 'dim-chain', pts, texts: zs.slice(1).map((z, i) => len(z - zs[i])), axis: 'v', priority: 28, layer: 'dimensions', lodMin: 2, size: ANN_TEXT.dim });
    }
    const primById = new Map(hp.prims.map((p) => [p.id, p]));
    const posTag = new Map<string, string>();
    for (const row of primRows(hp)) for (const s of row.slots.slots) if (s.positionTag) posTag.set(s.item.prim.id, s.positionTag);
    const seenPrim = new Set<string>();
    const cutRackU: [number, number][] = [];
    const keyFirst = new Map<string, { r: Rect; primId: string }>();
    for (const it of list.items) {
      if (!it.primId) continue;
      const p = primById.get(it.primId);
      const r = itemExtent(it);
      if (!p || !r) continue;
      const k = keynoteForPrim(p);
      if (k && !keyFirst.has(k)) keyFirst.set(k, { r, primId: p.id });
      if (seenPrim.has(p.id) || (p.emitter !== 'rack' && p.emitter !== 'unit')) continue;
      if (list.space === 'section' && it.role !== 'cut' && p.emitter === 'rack' && it.role !== 'beyond') continue;
      seenPrim.add(p.id);
      const cu = r.x + r.w / 2;
      const pt = posTag.get(p.id);
      if (pt) out.push({ kind: 'position-tag', pts: [cu, r.y + r.d + 0.25], text: pt, priority: 12, layer: 'position-tags', lodMin: 3, size: ANN_TEXT.position, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) });
      if (p.tag) out.push({ kind: 'tag', pts: [cu, r.y + r.d / 2], text: p.tag, priority: 10, layer: 'tags', lodMin: 2, size: ANN_TEXT.tag, rot: r.d > r.w ? -90 : 0, primId: p.id, ...(p.refId ? { refId: p.refId } : {}) });
      if (p.emitter === 'rack' && it.role === 'cut') cutRackU.push([r.x, r.x + r.w]);
    }
    if (cutRackU.length) {
      cutRackU.sort((a, b) => a[0] - b[0]);
      const stops: number[] = [];
      for (const [a, b] of cutRackU) stops.push(a, b);
      const uniq = [...new Set(stops.map((v) => Math.round(v * 1e4) / 1e4))].sort((a, b) => a - b);
      if (uniq.length >= 2) {
        const pts: number[] = [];
        for (const u of uniq) pts.push(u, -0.6);
        out.push({ kind: 'dim-chain', pts, texts: uniq.slice(1).map((u, i) => len(u - uniq[i])), axis: 'h', priority: 27, layer: 'dimensions', lodMin: 2, size: ANN_TEXT.dim });
      }
    }
    for (const [k, { r, primId }] of [...keyFirst.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const cx = r.x + r.w / 2;
      const cz = r.y + r.d / 2;
      out.push({ kind: 'keynote', pts: [cx + 0.5, cz + 0.45, cx, cz], text: k, keynoteId: k, priority: 40, layer: 'keynotes', lodMin: 3, size: ANN_TEXT.keynote, primId });
    }
  }
  return out.filter((a) => a.lodMin <= lod && layerOn(a.layer));
}

/** Escape helper re-exported for sheet owners composing attribute values (data-* tags). */
export const escAttr = esc;
