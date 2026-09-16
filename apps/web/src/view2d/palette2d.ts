// r4 stream C (spec §3.2 Themes): canvas styles of the 2D view (pure).
// Paper = the sheet palette (core `itemPaperStyle` + the same role rules as drawings/toSvg.ts `roleStyle`), with screen line weights
// (hairline 1 · normal 1.25 · heavy 2 · cut 2.5 px) instead of paper millimetres. Dark = the same styles with lightness-adjusted
// colours: every stroke is lifted to CIE L* ≥ 55 (busway-b #1e3a8a and oob #7d848b would not read on the dark ground otherwise),
// fills become the lifted stroke blended onto the ground.
import { itemPaperStyle, type DrawItem2D, type DrawRole2D, type Prim, type Space2D, type SystemId } from '@aidc/core';

export type Theme2D = 'paper' | 'dark';

/** Paper tokens (identical to packages/core/src/drawings/palette.ts; checked by the view2d test). */
export const PAPER_TOKENS = { ground: '#ffffff', ink: '#1a1a1a', inkSoft: '#4a4f55', lineLight: '#9aa0a6', ghostFill: '#dfe2e5', ghostStroke: '#8c9196', grid: '#c9cdd1' } as const;
/** Dark tokens (r4-ux §B.9). */
export const DARK_TOKENS = { ground: '#111418', ink: '#dfe2e5', inkSoft: '#9aa0a6', lineLight: '#6b7178', ghostFill: '#1c2127', ghostStroke: '#4f5760', grid: '#252a30' } as const;
export const ACCENT = '#3987e5';
export const CLEARANCE_RED = '#e5484d';
/** minimum CIE L* of a stroke on the dark ground */
export const DARK_MIN_L = 55;

export function tokens(theme: Theme2D) {
  return theme === 'dark' ? DARK_TOKENS : PAPER_TOKENS;
}

export interface CanvasStyle {
  fill: string | null;
  stroke: string | null;
  /** CSS px */
  lw: number;
  /** CSS px dash pattern, null = solid */
  dash: number[] | null;
  hatch?: 'slab' | 'wall' | 'rack-cut';
}

// ───────────── colour maths (sRGB ↔ CIE Lab, D65) ─────────────

const hex2rgb = (hex: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const rgb2hex = (r: number, g: number, b: number) => `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const fi = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
const WX = 0.95047;
const WZ = 1.08883;

export function hexToLab(hex: string): [number, number, number] | null {
  const rgb = hex2rgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => lin(c / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / WX;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / WZ;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const x = fi(fy + a / 500) * WX;
  const y = fi(fy);
  const z = fi(fy - b / 200) * WZ;
  const r = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const g = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const bl = 0.0557 * x - 0.204 * y + 1.057 * z;
  return [gam(r) * 255, gam(g) * 255, gam(bl) * 255];
}

export function labToHex(L: number, a: number, b: number): string {
  // reduce chroma until the colour is inside the sRGB gamut
  for (let k = 1; k >= 0; k -= 0.05) {
    const [r, g, bl] = labToRgb(L, a * k, b * k);
    if (r >= -0.5 && r <= 255.5 && g >= -0.5 && g <= 255.5 && bl >= -0.5 && bl <= 255.5) return rgb2hex(r, g, bl);
  }
  const [r, g, bl] = labToRgb(L, 0, 0);
  return rgb2hex(r, g, bl);
}

/** CIE76 ΔE between two hex colours. */
export function deltaE(h1: string, h2: string): number {
  const a = hexToLab(h1);
  const b = hexToLab(h2);
  if (!a || !b) return NaN;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Lift a colour to L* ≥ minL, keeping hue and chroma (gamut-clamped). */
export function liftLightness(hex: string, minL = DARK_MIN_L): string {
  const lab = hexToLab(hex);
  if (!lab || lab[0] >= minL) return hex;
  return labToHex(minL + 2, lab[1], lab[2]);
}

/** `hex` blended onto `ground` at `alpha`. */
export function blend(hex: string, ground: string, alpha: number): string {
  const c = hex2rgb(hex);
  const g = hex2rgb(ground);
  if (!c || !g) return hex;
  return rgb2hex(c[0] * alpha + g[0] * (1 - alpha), c[1] * alpha + g[1] * (1 - alpha), c[2] * alpha + g[2] * (1 - alpha));
}

// ───────────── style resolution ─────────────

/** The prim fields itemPaperStyle reads (category → role colour, system → supply / return, busway side, tray fabric). */
export interface PrimStyleInfo {
  category?: string;
  system?: string;
}

const LW = { hair: 1, thin: 1.25, medium: 1.6, heavy: 2 } as const;
const MM_PX = 96 / 25.4;
const dashPx = (d: string | undefined): number[] | null => (d ? d.split(/[\s,]+/).map(Number).filter((v) => v > 0).map((v) => Math.max(1, v * MM_PX)) : null);

/** Paper → theme colour map for the fixed ink tokens. */
function mapToken(hex: string, theme: Theme2D): string | null {
  if (theme === 'paper') return null;
  const k = hex.toLowerCase();
  const P = PAPER_TOKENS;
  const D = DARK_TOKENS;
  if (k === P.ink) return D.ink;
  if (k === P.inkSoft) return D.inkSoft;
  if (k === P.lineLight) return D.lineLight;
  if (k === P.ghostFill) return D.ghostFill;
  if (k === P.ghostStroke) return D.ghostStroke;
  if (k === P.ground) return D.ground;
  return null;
}

export function themeStroke(hex: string, theme: Theme2D): string {
  if (theme === 'paper') return hex;
  return mapToken(hex, theme) ?? liftLightness(hex, DARK_MIN_L + 5);
}

/** Opaque fill on the theme ground. `paired` is the style's stroke (dark fills take its hue, so pastel paper fills do not glare). */
export function themeFill(hex: string, opacity: number, theme: Theme2D, paired?: string): string {
  if (theme === 'paper') return blend(hex, PAPER_TOKENS.ground, opacity);
  const tok = mapToken(hex, theme);
  if (tok) return tok;
  const hue = paired && paired !== 'none' && !mapToken(paired, theme) ? paired : hex;
  const lifted = liftLightness(hue, DARK_MIN_L + 5);
  return blend(lifted, DARK_TOKENS.ground, opacity < 1 ? 0.18 + 0.35 * opacity : 0.26);
}

/**
 * Canvas style of a draw item for a theme. Same role rules as the sheets:
 * cut = normal weight (heavy styles 2.5 px in sections) · beyond = hairline soft ink · below = hairline light, half fill ·
 * overhead = dashed, no fill · ghost = ghost fill + stroke.
 */
export function canvasStyle(it: Pick<DrawItem2D, 'style' | 'layer' | 'primId' | 'role'>, prim: PrimStyleInfo | undefined, theme: Theme2D, space: Space2D): CanvasStyle {
  const fake = prim ? ({ meta: prim.category ? { category: prim.category } : undefined, system: prim.system as SystemId | undefined } as unknown as Prim) : undefined;
  const base = itemPaperStyle(it, fake);
  const T = tokens(theme);
  const op = base.fillOpacity ?? 1;
  const hasFill = base.fill !== 'none';
  const hasStroke = base.stroke !== 'none';
  const role: DrawRole2D = it.role;
  const stroke = hasStroke ? themeStroke(base.stroke, theme) : null;
  switch (role) {
    case 'cut': {
      const lw = space === 'plan' ? (base.weight === 'heavy' ? LW.heavy : LW.thin) : base.weight === 'heavy' ? 2.5 : 2;
      const hatch = base.hatch === 'rack-cut' && space === 'plan' ? undefined : base.hatch;
      return { fill: hasFill ? themeFill(base.fill, op, theme, base.stroke) : null, stroke, lw, dash: dashPx(base.dash), ...(hatch ? { hatch } : {}) };
    }
    case 'beyond':
      return { fill: hasFill ? themeFill(base.fill, op, theme, base.stroke) : null, stroke: hasStroke ? T.inkSoft : null, lw: LW.hair, dash: dashPx(base.dash) };
    case 'below':
      return { fill: hasFill ? themeFill(base.fill, op * 0.5, theme, base.stroke) : null, stroke: T.lineLight, lw: LW.hair, dash: dashPx(base.dash) };
    case 'overhead':
      return { fill: null, stroke: hasStroke ? stroke : T.inkSoft, lw: LW.thin, dash: dashPx('1.6 0.8') };
    case 'ghost':
    default:
      return { fill: hasFill ? T.ghostFill : null, stroke: T.ghostStroke, lw: LW.hair, dash: dashPx(base.dash) };
  }
}

/** Stable identity of an item's style inputs (theme-independent): the path-cache bucket key. */
export function styleIdentity(it: Pick<DrawItem2D, 'style' | 'layer' | 'primId' | 'role'>, prim: PrimStyleInfo | undefined): string {
  const ret = it.style === 'pipe' && it.primId && /#R\b|return/i.test(it.primId) ? 'R' : '';
  return `${it.style}|${it.layer}|${it.role}|${prim?.category ?? ''}|${prim?.system ?? ''}|${ret}`;
}
