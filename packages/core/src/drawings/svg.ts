/**
 * Minimal SVG string helpers for the drawing generators (stream S5).
 * Units are millimetres on paper; every number is rounded and NaN/Infinity is mapped to 0 so a sheet never
 * contains 'NaN'.
 */

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** finite number → fixed decimals (no trailing zeros); non-finite → 0 */
export function n(v: number, d = 3): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return String(Object.is(r, -0) ? 0 : r);
}

export interface Style {
  fill?: string;
  stroke?: string;
  /** stroke width (mm) */
  sw?: number;
  /** dash array (mm) */
  dash?: string;
  opacity?: number;
  fillOpacity?: number;
  strokeOpacity?: number;
  linecap?: 'butt' | 'round' | 'square';
  linejoin?: 'miter' | 'round' | 'bevel';
  /** raw extra attributes */
  extra?: string;
}

export function styleAttrs(st: Style): string {
  const a: string[] = [];
  a.push(`fill="${st.fill ?? 'none'}"`);
  if (st.stroke) a.push(`stroke="${st.stroke}"`);
  if (st.sw !== undefined) a.push(`stroke-width="${n(st.sw)}"`);
  if (st.dash) a.push(`stroke-dasharray="${st.dash}"`);
  if (st.opacity !== undefined) a.push(`opacity="${n(st.opacity)}"`);
  if (st.fillOpacity !== undefined) a.push(`fill-opacity="${n(st.fillOpacity)}"`);
  if (st.strokeOpacity !== undefined) a.push(`stroke-opacity="${n(st.strokeOpacity)}"`);
  if (st.linecap) a.push(`stroke-linecap="${st.linecap}"`);
  if (st.linejoin) a.push(`stroke-linejoin="${st.linejoin}"`);
  if (st.extra) a.push(st.extra);
  return a.join(' ');
}

export function rect(x: number, y: number, w: number, h: number, st: Style, rx = 0): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}"${rx ? ` rx="${n(rx)}"` : ''} ${styleAttrs(st)}/>`;
}

export function line(x1: number, y1: number, x2: number, y2: number, st: Style): string {
  return `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" ${styleAttrs(st)}/>`;
}

export function circle(cx: number, cy: number, r: number, st: Style): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(Math.max(0, r))}" ${styleAttrs(st)}/>`;
}

export function path(d: string, st: Style): string {
  return `<path d="${d}" ${styleAttrs(st)}/>`;
}

export type Pt = [number, number];

export function pointsAttr(pts: Pt[]): string {
  return pts.map((p) => `${n(p[0])},${n(p[1])}`).join(' ');
}

export function polygon(pts: Pt[], st: Style): string {
  return `<polygon points="${pointsAttr(pts)}" ${styleAttrs(st)}/>`;
}

export function polyline(pts: Pt[], st: Style): string {
  return `<polyline points="${pointsAttr(pts)}" ${styleAttrs(st)}/>`;
}

export interface TextOpts {
  /** font size (mm) */
  size?: number;
  anchor?: 'start' | 'middle' | 'end';
  weight?: 400 | 500 | 600 | 700 | 800;
  fill?: string;
  /** rotation (deg, CW on paper) about (x, y) */
  rotate?: number;
  baseline?: 'auto' | 'middle' | 'hanging' | 'central';
  family?: string;
  letterSpacing?: number;
  italic?: boolean;
  opacity?: number;
}

export const FONT = "'Helvetica Neue', Helvetica, Arial, 'Noto Sans', 'Noto Sans KR', 'Malgun Gothic', sans-serif";
export const MONO = "'DejaVu Sans Mono', Menlo, Consolas, monospace";

/** Smallest body text on a sheet (mm) — ISO 3098 minimum for A1 (2.5 mm preferred); `text()` never renders below it. */
export const MIN_TEXT_MM = 1.8;

export function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const attrs: string[] = [`x="${n(x)}"`, `y="${n(y)}"`, `font-size="${n(Math.max(MIN_TEXT_MM, o.size ?? 2.5))}"`, `font-family="${o.family ?? FONT}"`];
  if (o.anchor) attrs.push(`text-anchor="${o.anchor}"`);
  if (o.weight) attrs.push(`font-weight="${o.weight}"`);
  attrs.push(`fill="${o.fill ?? '#1a1a1a'}"`);
  if (o.baseline) attrs.push(`dominant-baseline="${o.baseline}"`);
  if (o.rotate) attrs.push(`transform="rotate(${n(o.rotate)} ${n(x)} ${n(y)})"`);
  if (o.letterSpacing) attrs.push(`letter-spacing="${n(o.letterSpacing)}"`);
  if (o.italic) attrs.push('font-style="italic"');
  if (o.opacity !== undefined) attrs.push(`opacity="${n(o.opacity)}"`);
  return `<text ${attrs.join(' ')}>${esc(s)}</text>`;
}

/** Multi-line text block (one <text> per line). */
export function textLines(x: number, y: number, lines: string[], lineH: number, o: TextOpts = {}): string {
  return lines.map((l, i) => text(x, y + i * lineH, l, o)).join('');
}

export function group(attrs: string, children: string[] | string): string {
  const inner = Array.isArray(children) ? children.join('') : children;
  return `<g${attrs ? ` ${attrs}` : ''}>${inner}</g>`;
}

/** approximate rendered text width (mm) for layout decisions; Helvetica-like metrics */
export function textWidth(s: string, size: number): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c > 0x2e7f) w += 1.0; // CJK full-width
    else if (/[A-Z0-9]/.test(ch)) w += 0.66;
    else if (/[ijl.,:'|!]/.test(ch)) w += 0.28;
    else if (/[mw]/.test(ch)) w += 0.85;
    else if (ch === ' ') w += 0.3;
    else w += 0.55;
  }
  return w * size;
}

/** truncate to fit a width (adds an ellipsis) */
export function fitText(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s;
  let out = s;
  while (out.length > 1 && textWidth(`${out}…`, size) > maxW) out = out.slice(0, -1);
  return `${out}…`;
}

export function hatchDef(id: string, color: string, spacing = 1.2, sw = 0.18): string {
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(spacing)}" height="${n(spacing)}" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="${n(spacing)}" stroke="${color}" stroke-width="${n(sw)}"/></pattern>`;
}

export function crossHatchDef(id: string, color: string, spacing = 1.5, sw = 0.15): string {
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${n(spacing)}" height="${n(spacing)}"><path d="M0 0 L${n(spacing)} ${n(spacing)} M${n(spacing)} 0 L0 ${n(spacing)}" stroke="${color}" stroke-width="${n(sw)}"/></pattern>`;
}

/** SVG root for a paper sheet (mm user units). */
export function svgDocument(widthMm: number, heightMm: number, defs: string[], body: string[], title: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(widthMm)}mm" height="${n(heightMm)}mm" viewBox="0 0 ${n(widthMm)} ${n(heightMm)}" font-family="${FONT}">`,
    `<title>${esc(title)}</title>`,
    `<defs>${defs.join('')}</defs>`,
    rect(0, 0, widthMm, heightMm, { fill: '#ffffff' }),
    ...body,
    '</svg>',
  ].join('\n');
}
