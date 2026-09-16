// Small deterministic SVG helpers for the HTML design document diagrams (stream T7, DECISIONS-v2-2 F5).
// Units are CSS px in a viewBox; the figure scales with the page. Print palette = the validated dataviz reference
// categorical instance (light mode, checked with validate_palette.js: all checks pass; 3 slots < 3:1 contrast →
// every coloured mark carries a visible label / outline and the same data is in a table next to the figure).
import { fitText, textWidth } from '../../drawings/svg.ts';

export const PAPER = '#ffffff';
export const INK = '#16181b';
export const INK2 = '#4a4f57';
export const RULE = '#c9ced4';
export const BAND = '#eef1f4';
export const FONT = "'Noto Sans','Noto Sans KR','Segoe UI',system-ui,sans-serif";

/** Categorical slots in fixed order (never cycled past 8). */
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'] as const;

export function xml(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** fixed-precision coordinate (no trailing zeros, no -0) */
export function c(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10) / 10;
  return String(Object.is(r, -0) ? 0 : r);
}

/** text width in px for a px font size (drawings metric is size-relative) */
export const textW = (s: string, size: number) => textWidth(s, size);
export const fit = (s: string, size: number, maxW: number) => fitText(s, size, maxW);

/** greedy word wrap into at most `maxLines` lines (last line ellipsised) */
export function wrap(s: string, size: number, maxW: number, maxLines = 2): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textW(next, size) <= maxW || !cur) cur = next;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fit(`${kept[maxLines - 1]} ${lines.slice(maxLines).join(' ')}`, size, maxW);
    return kept;
  }
  return lines.map((l) => fit(l, size, maxW));
}

export interface TextOpt { size?: number; weight?: number | string; anchor?: 'start' | 'middle' | 'end'; fill?: string; mono?: boolean }

export function text(x: number, y: number, s: string, o: TextOpt = {}): string {
  const attrs = [
    `x="${c(x)}"`, `y="${c(y)}"`, `font-size="${o.size ?? 11}"`,
    o.weight ? `font-weight="${o.weight}"` : '', o.anchor && o.anchor !== 'start' ? `text-anchor="${o.anchor}"` : '',
    `fill="${o.fill ?? INK}"`, o.mono ? `font-family="DejaVu Sans Mono,Menlo,Consolas,monospace"` : '',
  ].filter(Boolean);
  return `<text ${attrs.join(' ')}>${xml(s)}</text>`;
}

export interface BoxOpt { fill?: string; stroke?: string; sw?: number; rx?: number; dash?: string; title?: string }

export function box(x: number, y: number, w: number, h: number, o: BoxOpt = {}): string {
  const attrs = [
    `x="${c(x)}"`, `y="${c(y)}"`, `width="${c(Math.max(0, w))}"`, `height="${c(Math.max(0, h))}"`,
    o.rx ? `rx="${o.rx}"` : '', `fill="${o.fill ?? 'none'}"`, o.stroke ? `stroke="${o.stroke}"` : '',
    o.stroke ? `stroke-width="${o.sw ?? 1}"` : '', o.dash ? `stroke-dasharray="${o.dash}"` : '',
  ].filter(Boolean);
  return o.title ? `<rect ${attrs.join(' ')}><title>${xml(o.title)}</title></rect>` : `<rect ${attrs.join(' ')}/>`;
}

export function line(x1: number, y1: number, x2: number, y2: number, stroke = RULE, sw = 1, dash?: string): string {
  return `<line x1="${c(x1)}" y1="${c(y1)}" x2="${c(x2)}" y2="${c(y2)}" stroke="${stroke}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

export function polyline(pts: [number, number][], stroke = INK2, sw = 1.5): string {
  return `<polyline points="${pts.map(([x, y]) => `${c(x)},${c(y)}`).join(' ')}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
}

/** Root <svg> element (inline-embeddable: no XML prolog, ids prefixed by the caller). */
export function svgRoot(w: number, h: number, title: string, body: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${c(w)} ${c(h)}" width="${c(w)}" height="${c(h)}" role="img" aria-label="${xml(title)}" font-family="${xml(FONT)}"><title>${xml(title)}</title>${box(0, 0, w, h, { fill: PAPER })}${body.join('')}</svg>`;
}

/** legend row: coloured swatch + ink label; returns [markup, width] */
export function legendItem(x: number, y: number, color: string, label: string, kind: 'rect' | 'outline' | 'diamond' = 'rect'): [string, number] {
  const sw = kind === 'outline'
    ? box(x, y - 8, 14, 9, { fill: BAND, stroke: INK, sw: 1.6, rx: 2 })
    : kind === 'diamond'
      ? `<path d="M${c(x + 6)} ${c(y - 10)} L${c(x + 12)} ${c(y - 4)} L${c(x + 6)} ${c(y + 2)} L${c(x)} ${c(y - 4)} Z" fill="${color}" stroke="${INK}" stroke-width="0.8"/>`
      : box(x, y - 8, 14, 9, { fill: color, rx: 2 });
  return [sw + text(x + 19, y, label, { size: 10, fill: INK2 }), 19 + textW(label, 10) + 16];
}
