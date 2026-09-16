// r4 DrawList2D + annotations → SVG fragment on a sheet (spec §2.2). Owner: stream B0.
// `mapper` is the sheet viewport (DrawingViewport convention in model/types.ts; helpers in drawings/context.ts). Paper mm, y down.
//
// Output: `<g data-layer="…">` groups — geometry (clipped to mapper.paperRect) in LAYERS order (plan) or painter order (section /
// elevation: far → near, beyond before cut), then annotation groups (unclipped, label-culled: no overlaps, text ≥ MIN_TEXT_MM).
// Line weights 0.18 / 0.25 / 0.35 / 0.5 mm; hatches for cut slab / walls / columns and cut racks (section / elevation only).
import type { DrawingCut, DrawingSpace, DrawingViewport, ElevationTarget, Rect } from '../model/types.ts';
import type { DrawItem2D, DrawList2D, DrawRole2D } from '../scene/drawList.ts';
import { LAYERS, type LayerId } from '../scene/layers.ts';
import type { HallPrims, Prim } from '../scene/prims.ts';
import { ANN_TEXT, callout, calloutBubble, crossRefNote, cullLabels, dimChain, equipmentTag, keynoteEllipse, LabelCuller, levelDatum, PAPER_LW, positionTag, sectionMarker, textBox, type Annotation2D, type PaperBox } from './annotate.ts';
import { viewportPaperToWorld, viewportWorldToPaper } from './context.ts';
import { CATEGORY_PLAN, CONTAINMENT_COLOR, GHOST_FILL, GHOST_STROKE, INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR } from './palette.ts';
import { pickScale } from './sheet.ts';
import { esc, hatchDef, n, text, type Pt, type Style } from './svg.ts';

export { PAPER_LW } from './annotate.ts';

// ───────────────────────────── paper styles ─────────────────────────────

export type HatchKind = 'slab' | 'wall' | 'rack-cut';

export interface PaperStyle {
  fill: string;
  stroke: string;
  weight: keyof typeof PAPER_LW;
  /** 0..1, blended onto paper (fills stay opaque for painter order) */
  fillOpacity?: number;
  dash?: string;
  hatch?: HatchKind;
}

const S = (fill: string, stroke: string, weight: PaperStyle['weight'] = 'thin', extra: Partial<PaperStyle> = {}): PaperStyle => ({ fill, stroke, weight, ...extra });

/**
 * Style table keyed by style id. `DrawItem2D.style` may be any of: an equipment category ('gpu-rack', 'cdu' …), a SystemId
 * ('busway-a', 'cdu-supply', 'trays' …), an emitter / arch id below, or a compound id ('rack:gpu-rack', 'pipe#supply') whose tokens
 * are tried from the last (most specific) to the first. Unknown ids fall back to the item's layer, then to a neutral outline.
 */
export const PAPER_STYLES: Readonly<Record<string, PaperStyle>> = {
  ...Object.fromEntries(Object.entries(CATEGORY_PLAN).map(([k, v]) => [k, S(v!.fill, v!.stroke, 'thin', k.endsWith('-rack') ? { hatch: 'rack-cut' } : {})])),
  ...Object.fromEntries(Object.entries(SYSTEM_COLOR).map(([k, c]) => [k, S(c, c, 'thin', { fillOpacity: 0.35 })])),
  rack: S('#e6e8ea', '#5f6569', 'thin', { hatch: 'rack-cut' }),
  unit: S('#ececec', '#6b7075'),
  reserve: S(PAPER, INK_SOFT, 'thin', { dash: '1.2 0.7' }),
  'hot-aisle': S(CONTAINMENT_COLOR['hot-aisle'], CONTAINMENT_COLOR['hot-aisle'], 'medium', { fillOpacity: 0.07, dash: '1.6 0.8' }),
  'cold-aisle': S(CONTAINMENT_COLOR['cold-aisle'], CONTAINMENT_COLOR['cold-aisle'], 'medium', { fillOpacity: 0.07, dash: '1.6 0.8' }),
  containment: S(CONTAINMENT_COLOR['hot-aisle'], CONTAINMENT_COLOR['hot-aisle'], 'thin', { fillOpacity: 0.12 }),
  'containment-panel': S(CONTAINMENT_COLOR['hot-aisle'], CONTAINMENT_COLOR['hot-aisle'], 'thin', { fillOpacity: 0.25 }),
  'containment-roof': S(CONTAINMENT_COLOR['hot-aisle'], CONTAINMENT_COLOR['hot-aisle'], 'thin', { fillOpacity: 0.07 }),
  'containment-door': S(PAPER, CONTAINMENT_COLOR['hot-aisle'], 'thin'),
  wall: S('#c4c8cc', INK, 'heavy', { hatch: 'wall' }),
  column: S('#b8bdc2', INK, 'heavy', { hatch: 'wall' }),
  partition: S('#dfe2e5', INK_SOFT, 'medium'),
  slab: S('#eceef0', INK, 'heavy', { hatch: 'slab' }),
  ceiling: S('none', LINE_LIGHT, 'hair', { dash: '3 1.2' }),
  door: S(PAPER, INK, 'thin'),
  room: S('none', INK_SOFT, 'thin', { dash: '2 1' }),
  sleeve: S('#fbe3e3', '#c62828', 'thin'),
  light: S('#fff6c2', '#b38f00', 'hair'),
  busway: S(SYSTEM_COLOR['busway-a'], SYSTEM_COLOR['busway-a'], 'thin', { fillOpacity: 0.35 }),
  tapoff: S('#fde5c8', '#c96f00', 'hair'),
  circuit: S('none', '#c96f00', 'hair', { dash: '1 0.6' }),
  feeder: S('none', '#c96f00', 'medium'),
  tray: S(SYSTEM_COLOR.trays, SYSTEM_COLOR.trays, 'thin', { fillOpacity: 0.3 }),
  'tray-t1': S(SYSTEM_COLOR.trays, SYSTEM_COLOR.trays, 'thin', { fillOpacity: 0.3 }),
  'tray-t2': S(SYSTEM_COLOR.frontend, SYSTEM_COLOR.frontend, 'thin', { fillOpacity: 0.3, dash: '2.4 0.8' }),
  'tray-t3': S(SYSTEM_COLOR.oob, SYSTEM_COLOR.oob, 'thin', { fillOpacity: 0.3, dash: '0.8 0.6' }),
  drop: S(SYSTEM_COLOR.trays, INK_SOFT, 'thin', { fillOpacity: 0.5 }),
  pipe: S(SYSTEM_COLOR['cdu-supply'], SYSTEM_COLOR['cdu-supply'], 'thin', { fillOpacity: 0.5 }),
  supply: S(SYSTEM_COLOR['cdu-supply'], SYSTEM_COLOR['cdu-supply'], 'thin', { fillOpacity: 0.5 }),
  return: S(SYSTEM_COLOR['cdu-return'], SYSTEM_COLOR['cdu-return'], 'thin', { fillOpacity: 0.5 }),
  fitting: S(PAPER, INK, 'thin'),
  grid: S('none', LINE_LIGHT, 'hair', { dash: '4 1 0.8 1' }),
  'hall-outline': S('none', INK, 'heavy'),
  text: S(INK, 'none', 'hair'),
  ghost: S(GHOST_FILL, GHOST_STROKE, 'hair'),
};

const LAYER_STYLE: Partial<Record<LayerId, string>> = {
  'hall-outline': 'hall-outline', walls: 'wall', 'structural-grid': 'grid', 'planning-grid': 'grid', columns: 'column', doors: 'door', egress: 'room', partitions: 'partition',
  rooms: 'room', sleeves: 'sleeve', slab: 'slab', ceiling: 'ceiling', lights: 'light', racks: 'rack', 'form-factor': 'rack', 'front-tick': 'text', 'rcu-enclosures': 'room',
  reserves: 'reserve', containment: 'containment', 'containment-roof': 'containment-roof', 'containment-doors': 'containment-door', 'busway-a': 'busway-a', 'busway-b': 'busway-b',
  tapoffs: 'tapoff', circuits: 'circuit', feeders: 'feeder', 'electrical-rooms': 'room', 'tray-t1': 'tray-t1', 'tray-t2': 'tray-t2', 'tray-t3': 'tray-t3', drops: 'drop',
  'network-cables': 'frontend', 'cdu-crah': 'cdu', pipes: 'pipe', 'pipe-fittings': 'fitting',
};

const DEFAULT_STYLE: PaperStyle = S('#f1f2f3', INK_SOFT, 'thin');

/** Base paper style of a style id (+ layer fallback). */
export function paperStyleOf(style: string, layer?: LayerId): PaperStyle {
  const direct = PAPER_STYLES[style];
  if (direct) return direct;
  const toks = style.split(/[:#./|\s]+/).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i--) if (PAPER_STYLES[toks[i]]) return PAPER_STYLES[toks[i]];
  const ls = layer ? LAYER_STYLE[layer] : undefined;
  return (ls && PAPER_STYLES[ls]) || DEFAULT_STYLE;
}

/** Generic emitter style ids that the item's more specific layer (busway-b, tray-t2, cdu-crah …) overrides. */
const GENERIC_STYLES = new Set(['busway', 'tray', 'unit', 'pipe', 'containment']);

/**
 * Paper style of a draw item. With the prim at hand (drawListToSvg `hp` option) the prim's equipment category (role colour) and
 * system (supply / return, busway side, tray fabric) win over a generic emitter style; otherwise a specific layer does.
 */
export function itemPaperStyle(it: Pick<DrawItem2D, 'style' | 'layer' | 'primId'>, prim?: Prim): PaperStyle {
  const cat = typeof prim?.meta?.category === 'string' ? prim.meta.category : undefined;
  if (cat && PAPER_STYLES[cat]) return PAPER_STYLES[cat];
  const generic = GENERIC_STYLES.has(it.style) || it.style === 'rack';
  if (generic && prim?.system && prim.system !== 'it' && prim.system !== 'arch' && PAPER_STYLES[prim.system]) {
    // trays keep their tier line type; the system picks the colour
    if (it.style === 'tray' && PAPER_STYLES[it.layer]) return { ...PAPER_STYLES[it.layer], fill: PAPER_STYLES[prim.system].fill, stroke: PAPER_STYLES[prim.system].stroke };
    return PAPER_STYLES[prim.system];
  }
  if (it.style === 'pipe' && it.primId && /#R\b|return|tcs-R:/i.test(it.primId)) return PAPER_STYLES.return;
  if (generic && PAPER_STYLES[it.layer]) return PAPER_STYLES[it.layer];
  return paperStyleOf(it.style, it.layer);
}

/** '#rrggbb' blended onto white at `opacity` (opaque paper fills). */
export function mixOnPaper(hex: string, opacity = 1): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || opacity >= 1) return hex;
  const v = parseInt(m[1], 16);
  const ch = (s: number) => Math.round(((v >> s) & 255) * opacity + 255 * (1 - opacity));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/** Final SVG style of an item for its role (cut / beyond / below / overhead / ghost) and the hatch it needs, if any. */
export function roleStyle(base: PaperStyle, role: DrawRole2D, space: DrawingSpace): { st: Style; hatch?: HatchKind } {
  const fill = base.fill === 'none' ? 'none' : mixOnPaper(base.fill, base.fillOpacity ?? 1);
  switch (role) {
    case 'cut': {
      const sw = base.weight === 'heavy' ? PAPER_LW.heavy : base.weight === 'hair' ? PAPER_LW.thin : PAPER_LW.medium;
      const hatch = base.hatch === 'rack-cut' && space === 'plan' ? undefined : base.hatch;
      return { st: { fill, stroke: base.stroke === 'none' ? undefined : base.stroke, sw, dash: base.dash }, ...(hatch ? { hatch } : {}) };
    }
    case 'beyond':
      return { st: { fill, stroke: base.stroke === 'none' ? undefined : INK_SOFT, sw: PAPER_LW.hair, dash: base.dash } };
    case 'below':
      return { st: { fill: fill === 'none' ? 'none' : mixOnPaper(base.fill, (base.fillOpacity ?? 1) * 0.5), stroke: LINE_LIGHT, sw: PAPER_LW.hair, dash: base.dash } };
    case 'overhead':
      return { st: { fill: 'none', stroke: base.stroke === 'none' ? INK_SOFT : base.stroke, sw: PAPER_LW.thin, dash: '1.6 0.8' } };
    case 'ghost':
    default:
      return { st: { fill: fill === 'none' ? 'none' : GHOST_FILL, stroke: GHOST_STROKE, sw: PAPER_LW.hair, dash: base.dash } };
  }
}

function hatchDefs(prefix: string, kind: HatchKind): string {
  switch (kind) {
    case 'slab':
      // diagonal lines + aggregate dots
      return `<pattern id="${prefix}hatch-slab" patternUnits="userSpaceOnUse" width="2.4" height="2.4" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="2.4" stroke="${INK_SOFT}" stroke-width="0.18"/><circle cx="1.2" cy="1.2" r="0.18" fill="${INK_SOFT}"/></pattern>`;
    case 'wall':
      return hatchDef(`${prefix}hatch-wall`, INK, 0.8, 0.18);
    case 'rack-cut':
    default:
      return hatchDef(`${prefix}hatch-rack-cut`, INK_SOFT, 1.6, 0.15);
  }
}

// ───────────────────────────── viewports ─────────────────────────────

export interface FitViewportOptions {
  hallId: string;
  space: DrawingSpace;
  /** fixed scale (denominator); default: the largest standard scale that fits */
  scaleDen?: number;
  candidates?: number[];
  /** paper margin inside paperRect kept free when picking the scale (mm, default 4) */
  pad?: number;
  cut?: DrawingCut;
  cutId?: string;
  elevation?: ElevationTarget;
}

/**
 * A DrawingViewport that centres `world` (plan {x,y,w,d} or section {u0,z0,Δu,Δz}) in `paperRect`. `worldRect` covers the whole
 * paperRect at the chosen scale, so sheets record the exact paper ↔ world transform (viewportWorldToPaper / viewportPaperToWorld).
 */
export function fitViewport(world: Rect, paperRect: { x: number; y: number; w: number; h: number }, o: FitViewportOptions): { viewport: DrawingViewport; scaleDen: number; scale: string } {
  const pad = o.pad ?? 4;
  const ww = Math.max(world.w, 1e-6);
  const wd = Math.max(world.d, 1e-6);
  const den = o.scaleDen ?? pickScale(ww, wd, Math.max(1, paperRect.w - 2 * pad), Math.max(1, paperRect.h - 2 * pad), o.candidates).ratio;
  const mmPerM = 1000 / den;
  const spanW = paperRect.w / mmPerM;
  const spanH = paperRect.h / mmPerM;
  const worldRect: Rect = { x: world.x + world.w / 2 - spanW / 2, y: world.y + world.d / 2 - spanH / 2, w: spanW, d: spanH };
  const viewport: DrawingViewport = {
    paperRect: { ...paperRect },
    hallId: o.hallId,
    space: o.space,
    worldRect,
    mmPerM,
    ...(o.cutId ? { cutId: o.cutId } : o.cut ? { cutId: o.cut.id } : {}),
    ...(o.cut ? { cut: o.cut } : {}),
    ...(o.elevation ? { elevation: o.elevation } : {}),
  };
  return { viewport, scaleDen: den, scale: `1:${den}` };
}

/** World point → paper mm through a viewport. */
export function worldToPaper(vp: DrawingViewport, x: number, y: number): Pt {
  return viewportWorldToPaper(vp, x, y);
}

/** Paper mm → world through a viewport. */
export function paperToWorld(vp: DrawingViewport, px: number, py: number): Pt {
  return viewportPaperToWorld(vp, px, py);
}

/** Paper box of a world rect (y-up world → y-down paper). */
export function paperBoxOf(vp: DrawingViewport, r: Rect): PaperBox {
  const [x0, y1] = viewportWorldToPaper(vp, r.x, r.y);
  const [x1, y0] = viewportWorldToPaper(vp, r.x + r.w, r.y + r.d);
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

// ───────────────────────────── drawListToSvg ─────────────────────────────

export interface DrawListSvgOptions {
  /** prefix for generated ids (hatch patterns, clip paths) so several viewports can share one sheet */
  idPrefix?: string;
  layers?: LayerId[];
  /** clip to mapper.paperRect (default true) */
  clip?: boolean;
  /** detail band filter (items / annotations with lodMin > lod are skipped; default 3 = everything) */
  lod?: 0 | 1 | 2 | 3;
  /** share one culler between several viewports of a sheet (and with the sheet's own labels) */
  culler?: LabelCuller;
  /** annotations whose anchor lies farther than this outside paperRect are dropped (mm, default 30) */
  annotationMarginMm?: number;
  /** `data-prim` on geometry elements that carry a primId (default true) */
  dataIds?: boolean;
  /** the prims the list was projected from: role colours by equipment category, supply / return and busway side by system */
  hp?: HallPrims;
}

export interface DrawListSvgResult {
  svg: string;
  defs: string[];
  /** labels dropped by culling */
  culled: number;
  /** dimension segments whose text did not fit (defer to an enlarged sheet) */
  suppressed: number;
  /** element count per data-layer (geometry + annotations) */
  layerCounts: Record<string, number>;
}

const LAYER_INDEX = new Map(LAYERS.map((l, i) => [l.id, i]));
const ROLE_RANK: Record<DrawRole2D, number> = { ghost: 0, below: 1, beyond: 2, cut: 3, overhead: 4 };

interface Label {
  /** keynotes: mirrored placements around the leader point, used when the first one covers a position tag (QA r4 sheets) */
  alts?: { box: PaperBox; svg: string }[];
  /** position tags: placements tried by the culler when the first box is taken (backlog T2 #2) */
  fallbacks?: { box: PaperBox; svg: string }[];
  box: PaperBox;
  priority: number;
  size?: number;
  svg: string;
  layer: LayerId;
}

/** Returns the `<g data-layer="…">` groups and the `<defs>` entries they need. */
export function drawListToSvg(list: DrawList2D, ann: readonly Annotation2D[], mapper: DrawingViewport, opts: DrawListSvgOptions = {}): DrawListSvgResult {
  const prefix = opts.idPrefix ?? 'dl-';
  const lod = opts.lod ?? 3;
  const layerOn = (l: LayerId) => !opts.layers || opts.layers.includes(l);
  const dataIds = opts.dataIds ?? true;
  const vp = mapper;
  const P = (x: number, y: number): Pt => viewportWorldToPaper(vp, x, y);
  const k = vp.mmPerM;
  const defs: string[] = [];
  const usedHatch = new Set<HatchKind>();
  const layerCounts: Record<string, number> = {};
  const count = (layer: string, c = 1) => (layerCounts[layer] = (layerCounts[layer] ?? 0) + c);
  const culler = opts.culler ?? new LabelCuller();

  // ── geometry ──
  const items = list.items.filter((it) => it.lodMin <= lod && layerOn(it.layer));
  const order = items.map((_, i) => i);
  if (list.space === 'plan') {
    order.sort((a, b) => (LAYER_INDEX.get(items[a].layer) ?? 999) - (LAYER_INDEX.get(items[b].layer) ?? 999) || ROLE_RANK[items[a].role] - ROLE_RANK[items[b].role] || a - b);
  } else {
    order.sort((a, b) => (items[b].depth ?? 0) - (items[a].depth ?? 0) || ROLE_RANK[items[a].role] - ROLE_RANK[items[b].role] || (LAYER_INDEX.get(items[a].layer) ?? 999) - (LAYER_INDEX.get(items[b].layer) ?? 999) || a - b);
  }
  const rackPaper = new Map<string, PaperBox>();
  const textLabels: Label[] = [];
  const groups: { layer: LayerId; els: string[] }[] = [];
  const push = (layer: LayerId, el: string) => {
    const g = groups[groups.length - 1];
    if (g && g.layer === layer) g.els.push(el);
    else groups.push({ layer, els: [el] });
    count(layer);
  };
  const primById = opts.hp ? new Map(opts.hp.prims.map((p) => [p.id, p])) : null;
  for (const i of order) {
    const it = items[i];
    const base = itemPaperStyle(it, it.primId && primById ? primById.get(it.primId) : undefined);
    if (it.kind === 'text') {
      if (!it.text || it.pts.length < 2) continue;
      const [x, y] = P(it.pts[0], it.pts[1]);
      const size = it.size ?? 2;
      const rot = it.rot ?? 0;
      textLabels.push({ box: textBox(x, y, it.text, size, 'middle', 'central', rot), priority: 15, size, layer: it.layer, svg: text(x, y, it.text, { size, anchor: 'middle', baseline: 'central', fill: base.fill === 'none' ? INK : base.fill, rotate: rot || undefined }) });
      continue;
    }
    const { st, hatch } = roleStyle(base, it.role, list.space);
    const id = dataIds && it.primId ? ` data-prim="${esc(it.primId)}"` : '';
    const attrs = (s: Style) => styleString(s) + id;
    const p = it.pts;
    let el = '';
    let hatchEl = '';
    if (it.kind === 'rect' && p.length >= 4) {
      const b = paperBoxOf(vp, { x: Math.min(p[0], p[0] + p[2]), y: Math.min(p[1], p[1] + p[3]), w: Math.abs(p[2]), d: Math.abs(p[3]) });
      el = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" ${attrs(st)}/>`;
      if (hatch) hatchEl = `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" fill="url(#${prefix}hatch-${hatch})" stroke="none"/>`;
      if (it.primId) rackPaper.set(it.primId, b);
    } else if ((it.kind === 'polygon' || it.kind === 'polyline') && p.length >= 4) {
      const pts: string[] = [];
      for (let j = 0; j + 1 < p.length; j += 2) {
        const [x, y] = P(p[j], p[j + 1]);
        pts.push(`${n(x)},${n(y)}`);
      }
      if (it.kind === 'polygon') {
        el = `<polygon points="${pts.join(' ')}" ${attrs(st)}/>`;
        if (hatch) hatchEl = `<polygon points="${pts.join(' ')}" fill="url(#${prefix}hatch-${hatch})" stroke="none"/>`;
      } else el = `<polyline points="${pts.join(' ')}" ${attrs({ ...st, fill: 'none', stroke: st.stroke ?? (base.stroke === 'none' ? INK : base.stroke) })}/>`;
    } else if (it.kind === 'circle' && p.length >= 3) {
      const [x, y] = P(p[0], p[1]);
      el = `<circle cx="${n(x)}" cy="${n(y)}" r="${n(Math.max(0, p[2] * k))}" ${attrs(st)}/>`;
    }
    if (!el) continue;
    push(it.layer, el);
    if (hatchEl) {
      usedHatch.add(hatch!);
      const g = groups[groups.length - 1];
      g.els.push(hatchEl);
    }
  }
  for (const h of [...usedHatch].sort()) defs.push(hatchDefs(prefix, h));
  const clip = opts.clip ?? true;
  const pr = vp.paperRect;
  let geom = groups.map((g) => `<g data-layer="${g.layer}">${g.els.join('')}</g>`).join('');
  if (clip && geom) {
    defs.push(`<clipPath id="${prefix}clip"><rect x="${n(pr.x)}" y="${n(pr.y)}" width="${n(pr.w)}" height="${n(pr.h)}"/></clipPath>`);
    geom = `<g clip-path="url(#${prefix}clip)">${geom}</g>`;
  }

  // ── annotations ──
  const margin = opts.annotationMarginMm ?? 30;
  const inPaper = (x: number, y: number) => x >= pr.x - margin && x <= pr.x + pr.w + margin && y >= pr.y - margin && y <= pr.y + pr.h + margin;
  const structural: { layer: LayerId; svg: string; priority: number }[] = [];
  const labels: Label[] = [...textLabels];
  let suppressed = 0;
  const anns = ann.filter((a) => a.lodMin <= lod && layerOn(a.layer));
  // structural first (reserved in the culler), highest priority first
  const structuralKinds = new Set(['section-marker', 'callout', 'datum', 'dim-chain']);
  const sortedAnn = anns.map((a, i) => ({ a, i })).sort((p, q) => Number(structuralKinds.has(q.a.kind)) - Number(structuralKinds.has(p.a.kind)) || q.a.priority - p.a.priority || p.i - q.i);
  for (const { a } of sortedAnn) {
    const t = a.text ?? '';
    switch (a.kind) {
      case 'section-marker': {
        if (a.pts.length < 4) break;
        const p0 = P(a.pts[0], a.pts[1]);
        const p1 = P(a.pts[2], a.pts[3]);
        if (!inPaper(p0[0], p0[1]) && !inPaper(p1[0], p1[1])) break;
        const horizontal = Math.abs(a.pts[3] - a.pts[1]) <= Math.abs(a.pts[2] - a.pts[0]);
        const look = a.look ?? 1;
        const dir: Pt = horizontal ? [0, -look] : [look, 0];
        const m = sectionMarker(p0, p1, dir, t, a.target);
        m.boxes.forEach((b) => culler.reserve(b));
        structural.push({ layer: a.layer, svg: m.svg, priority: a.priority });
        break;
      }
      case 'callout': {
        if (a.pts.length < 4) break;
        const b = paperBoxOf(vp, { x: a.pts[0], y: a.pts[1], w: a.pts[2], d: a.pts[3] });
        if (!inPaper(b.x, b.y) && !inPaper(b.x + b.w, b.y + b.h)) break;
        const c = callout(b, t, a.target);
        culler.reserve(c.box);
        structural.push({ layer: a.layer, svg: c.svg, priority: a.priority });
        break;
      }
      case 'datum': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y)) break;
        const sp = t.indexOf(' ');
        const value = sp > 0 ? t.slice(0, sp) : t;
        const label = sp > 0 ? t.slice(sp + 1) : '';
        // levels closer than the text height: stagger the text (dogleg leader) before giving up on it
        let placed = false;
        for (const dy of DATUM_STAGGER_MM) {
          const d = levelDatum(x, y, value, label, { side: a.side, size: a.size, lineFrom: pr.x, lineTo: x - 2.4, textDy: dy });
          if (!culler.tryPlace(d.box)) continue;
          structural.push({ layer: a.layer, svg: d.svg, priority: a.priority });
          placed = true;
          break;
        }
        if (!placed) {
          // keep the ▽ and the level line, drop the text
          structural.push({ layer: a.layer, svg: levelDatum(x, y, '', '', { side: a.side, lineFrom: pr.x, lineTo: x - 2.4 }).svg, priority: a.priority });
          suppressed++;
        }
        break;
      }
      case 'dim-chain': {
        if (a.pts.length < 4) break;
        const axis = a.axis ?? (Math.abs(a.pts[a.pts.length - 1] - a.pts[1]) < 1e-9 ? 'h' : 'v');
        const stops: { v: number; i: number }[] = [];
        let at = 0;
        for (let j = 0; j + 1 < a.pts.length; j += 2) {
          const [x, y] = P(a.pts[j], a.pts[j + 1]);
          stops.push({ v: axis === 'h' ? x : y, i: j / 2 });
          at = axis === 'h' ? y : x;
        }
        if (!stops.some((s) => inPaper(axis === 'h' ? s.v : at, axis === 'h' ? at : s.v))) break;
        const texts = a.texts ?? [];
        const ascending = stops.length < 2 || stops[stops.length - 1].v >= stops[0].v;
        const vs = stops.map((s) => s.v);
        const ts = ascending ? texts : [...texts].reverse();
        if (!ascending) vs.reverse();
        const dc = dimChain(vs, ts, { axis, at, size: a.size, culler });
        suppressed += dc.suppressed.length;
        structural.push({ layer: a.layer, svg: dc.svg, priority: a.priority });
        break;
      }
      case 'keynote': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y)) break;
        const leader = a.pts.length >= 4 ? P(a.pts[2], a.pts[3]) : undefined;
        const kn = keynoteEllipse(x, y, a.keynoteId ?? t, { leaderTo: leader, size: a.size });
        const alts = leader
          ? ([[-1, 1], [1, -1], [-1, -1], [2, 2], [-2, 2], [2, -2], [-2, -2]] as const).map(([sx, sy]) => keynoteEllipse(leader[0] + (x - leader[0]) * sx, leader[1] + (y - leader[1]) * sy, a.keynoteId ?? t, { leaderTo: leader, size: a.size }))
          : [];
        labels.push({ box: kn.box, priority: a.priority, size: a.size, svg: kn.svg, layer: a.layer, alts });
        break;
      }
      case 'position-tag': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y) || !t) break;
        const pt = positionTag(x, y, t, { rot: a.rot || undefined, size: a.size });
        // backlog T2 #2: when the tag spot is taken (a DU label or pod text on hall plans), try further out, one step in, then along the row
        let fallbacks: { box: PaperBox; svg: string }[] | undefined;
        if (a.pts.length >= 4) {
          const [qx, qy] = P(a.pts[0] + a.pts[2], a.pts[1] + a.pts[3]);
          const len = Math.hypot(qx - x, qy - y);
          if (len > 1e-9) {
            const dx = (qx - x) / len;
            const dy = (qy - y) / len;
            const out = Math.abs(dx) * pt.box.w + Math.abs(dy) * pt.box.h + 0.4;
            const along = Math.abs(dy) * pt.box.w + Math.abs(dx) * pt.box.h + 0.4;
            const shifts: [number, number][] = [[dx * out, dy * out], [dx * 2 * out, dy * 2 * out], [-dx * out, -dy * out], [dy * along * 0.6, -dx * along * 0.6], [-dy * along * 0.6, dx * along * 0.6]];
            fallbacks = shifts.map(([sx, sy]) => positionTag(x + sx, y + sy, t, { rot: a.rot || undefined, size: a.size }));
          }
        }
        labels.push({ box: pt.box, priority: a.priority, size: a.size, svg: pt.svg, layer: a.layer, ...(fallbacks ? { fallbacks } : {}) });
        break;
      }
      case 'tag': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y) || !t) break;
        const fp = a.primId ? rackPaper.get(a.primId) : undefined;
        if (fp) {
          const et = equipmentTag(fp, t, { size: a.size });
          if (et.box) labels.push({ box: et.box, priority: a.priority, size: MIN_OK, svg: et.svg, layer: a.layer });
        } else {
          const size = a.size ?? ANN_TEXT.tag;
          labels.push({ box: textBox(x, y, t, size, 'middle', 'central', a.rot ?? 0), priority: a.priority, size, layer: a.layer, svg: text(x, y, t, { size, anchor: 'middle', baseline: 'central', fill: INK, rotate: a.rot || undefined }) });
        }
        break;
      }
      case 'du-label': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y) || !t) break;
        const size = a.size ?? ANN_TEXT.duLabel;
        labels.push({ box: textBox(x, y, t, size, 'middle'), priority: a.priority, size, layer: a.layer, svg: text(x, y, t, { size, anchor: 'middle', weight: 700, fill: INK }) });
        break;
      }
      case 'grid-bubble': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y) || !t) break;
        const b = calloutBubble(x, y, t, undefined, { r: 2.6, stroke: INK });
        labels.push({ box: b.box, priority: a.priority, svg: b.svg, layer: a.layer });
        break;
      }
      case 'note': {
        const [x, y] = P(a.pts[0], a.pts[1]);
        if (!inPaper(x, y) || !t) break;
        const nt = crossRefNote(x, y, t, { size: a.size });
        labels.push({ box: nt.box, priority: a.priority, size: a.size, svg: nt.svg, layer: a.layer });
        break;
      }
    }
  }
  // QA r4 sheets: keynotes outrank position tags in the culler, so a keynote on its fixed offset removed a position tag (RCU 121 A02);
  // move such a keynote to the first mirrored placement that covers no position tag (unchanged when the first placement is clear)
  const posBoxes = labels.filter((l) => l.layer === 'position-tags').map((l) => l.box);
  const hitsPos = (b: PaperBox) => posBoxes.some((q) => b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h);
  for (const l of labels) {
    if (!l.alts?.length || !posBoxes.length || !hitsPos(l.box)) continue;
    const alt = l.alts.find((c) => !hitsPos(c.box));
    if (alt) {
      l.box = alt.box;
      l.svg = alt.svg;
    }
  }
  const kept = cullLabels(labels, culler);
  const culled = labels.length - kept.length;
  const annByLayer = new Map<LayerId, string[]>();
  for (const s of structural) {
    const l = annByLayer.get(s.layer);
    if (l) l.push(s.svg);
    else annByLayer.set(s.layer, [s.svg]);
  }
  for (const l of kept) {
    const g = annByLayer.get(l.layer);
    if (g) g.push(l.svg);
    else annByLayer.set(l.layer, [l.svg]);
  }
  const annLayers = [...annByLayer.keys()].sort((a, b) => (LAYER_INDEX.get(a) ?? 999) - (LAYER_INDEX.get(b) ?? 999));
  const annSvg = annLayers
    .map((l) => {
      const els = annByLayer.get(l)!;
      count(l, els.length);
      return `<g data-layer="${l}">${els.join('')}</g>`;
    })
    .join('');
  return { svg: geom + annSvg, defs, culled, suppressed, layerCounts };
}

/** equipmentTag already enforces MIN_TEXT_MM; its labels skip the size filter in cullLabels */
const MIN_OK = 99;
/** datum text offsets tried in order (paper mm; negative = up) */
const DATUM_STAGGER_MM = [0, -2.6, 2.6, -5.2, 5.2, -7.8, 7.8];

function styleString(st: Style): string {
  const a: string[] = [`fill="${st.fill ?? 'none'}"`];
  if (st.stroke) a.push(`stroke="${st.stroke}"`);
  if (st.sw !== undefined) a.push(`stroke-width="${n(st.sw)}"`);
  if (st.dash) a.push(`stroke-dasharray="${st.dash}"`);
  if (st.fillOpacity !== undefined) a.push(`fill-opacity="${n(st.fillOpacity)}"`);
  return a.join(' ');
}

// ───────────────────────────── structure digest (goldens / QA) ─────────────────────────────

export interface SvgStructure {
  /** element count per data-layer (direct and nested elements, all groups of that layer summed) */
  layers: Record<string, number>;
  /** sorted unique texts inside tags / position-tags / du-label layers */
  tags: string[];
  /** texts inside dimensions layers, document order */
  dimensions: string[];
  /** texts inside datums layers, document order */
  datums: string[];
  /** texts inside keynotes layers, sorted unique */
  keynotes: string[];
  /** smallest font-size in the document (mm) */
  minTextMm: number;
}

/** Structural digest of a sheet / fragment SVG (spec T6: not bytes). */
export function svgStructure(svg: string): SvgStructure {
  const layers: Record<string, number> = {};
  const buckets: Record<string, string[]> = {};
  const stack: (string | null)[] = [];
  const re = /<(\/?)([A-Za-z][\w:-]*)([^<>]*?)(\/?)>([^<]*)/g;
  let m: RegExpExecArray | null;
  let minText = Infinity;
  let textLayer: string | null = null;
  while ((m = re.exec(svg))) {
    const [, close, name, attrs, selfClose, after] = m;
    if (close) {
      if (name === 'g') stack.pop();
      if (name === 'text') textLayer = null;
      continue;
    }
    const cur = [...stack].reverse().find((s) => s) ?? null;
    if (name === 'g') {
      const dl = /data-layer="([^"]+)"/.exec(attrs);
      if (!selfClose) stack.push(dl ? dl[1] : null);
      continue;
    }
    if (cur) layers[cur] = (layers[cur] ?? 0) + 1;
    if (name === 'text') {
      const fs = /font-size="([\d.]+)"/.exec(attrs);
      if (fs) minText = Math.min(minText, Number(fs[1]));
      textLayer = cur;
      if (cur && after) (buckets[cur] ??= []).push(unescape(after));
    }
    void textLayer;
  }
  const pick = (ls: string[]) => ls.flatMap((l) => buckets[l] ?? []);
  return {
    layers,
    tags: [...new Set(pick(['tags', 'position-tags']))].sort(),
    dimensions: pick(['dimensions']),
    datums: pick(['datums']),
    keynotes: [...new Set(pick(['keynotes']))].sort(),
    minTextMm: Number.isFinite(minText) ? minText : 0,
  };
}

function unescape(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
