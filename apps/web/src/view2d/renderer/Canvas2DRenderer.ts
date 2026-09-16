// r4 stream C (spec §3.4 Renderer): Canvas2D renderer of a packed DrawList2D.
//   · base canvas + overlay canvas at device pixel ratio; world y-up drawn through setTransform
//   · Path2D cache per (style batch × LOD band × 24 m tile); plan batches = layer × role × style identity, ordered by role then first
//     occurrence (sections / elevations keep painter order as run-length batches)
//   · uniform hit grid (4 m cells) for culling and picking; racks merge into row bars below 6 ppm
//   · labels: greedy screen-space culling by priority (measureText widths, ≥ 7 px, selected / hovered always drawn)
//   · gestures: `blit(view)` transforms the last full frame; the pane throttles full redraws to ≤ 1 per 100 ms
import { fmtLength, type Annotation2D, type DrawingCut, type DrawingUnits, type DrawItem2D, type LayerId, type PackedDrawList, type Rect, type Space2D } from '@aidc/core';
import { HitGrid, pointInPolygon, segDist } from '../hitGrid.ts';
import { centredBox, cullScreenLabels, fitFontPx, ScreenOccupancy, type LabelCandidate } from '../labels.ts';
import { lodBand, MIN_LABEL_PX, ROW_BAR_PPM, type LodBand } from '../lod.ts';
import { ACCENT, CLEARANCE_RED, canvasStyle, styleIdentity, tokens, type CanvasStyle, type Theme2D } from '../palette2d.ts';
import type { ClearanceMark, PrimInfo } from '../scene.ts';
import { screenToWorld, visibleRect, worldToScreen, type View2DFrame } from '../viewXform.ts';

const KINDS = ['rect', 'polyline', 'polygon', 'circle', 'text'] as const;
const ROLES = ['cut', 'beyond', 'below', 'overhead', 'ghost'] as const;
const ROLE_RANK: Record<string, number> = { ghost: 0, below: 1, beyond: 2, cut: 3, overhead: 4 };
const TILE_M = 24;
export const DEFAULT_FONT = 'Inter, "Pretendard", "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';

/** pick priority: lower wins (equipment first, envelopes last) */
const PICK_RANK: Record<string, number> = {
  rack: 0, unit: 0, tapoff: 1, fitting: 1, busway: 2, circuit: 3, pipe: 4, drop: 5, tray: 6, door: 7, sleeve: 8, 'containment-panel': 9, 'containment-roof': 10,
  column: 11, feeder: 12, room: 13, partition: 14, light: 15, wall: 16, ceiling: 17, slab: 18,
};

export interface SceneInput {
  space: Space2D;
  packed: PackedDrawList;
  ann: readonly Annotation2D[];
  prims: Readonly<Record<string, PrimInfo>>;
  clearance?: readonly ClearanceMark[];
}

export interface RenderOptions {
  theme: Theme2D;
  /** visible layers (null = all) */
  layers: ReadonlySet<string> | null;
  annotations: boolean;
  units: DrawingUnits;
  font?: string;
  /** equipment / prim ids whose labels are always drawn */
  forceLabelIds?: ReadonlySet<string>;
  /** gesture quality: no dashes, hatches or labels (the pane sets it while panning / zooming; full quality on gesture end) */
  lite?: boolean;
}

export interface CutMarker {
  cut: DrawingCut;
  depthM?: number;
  active?: boolean;
  preview?: boolean;
}

export interface OverlayState {
  selected: readonly number[];
  hovered: number | null;
  /** 2D-local selection (non-equipment) */
  local?: number | null;
  marquee?: { x0: number; y0: number; x1: number; y1: number } | null;
  measure?: { pts: readonly [number, number][]; cursor?: [number, number] | null; closed?: boolean } | null;
  snap?: { x: number; y: number; label?: string } | null;
  cuts?: readonly CutMarker[];
  /** plan: the 3D camera footprint (position + yaw, deg CCW from +x) */
  camera?: { x: number; y: number; yaw: number; fovDeg: number } | null;
  /** elevation / section: plan north label etc. */
  northLabel?: string;
  showScale?: boolean;
  space: Space2D;
  hallRect?: Rect | null;
}

interface Batch {
  layer: string;
  lodMin: number;
  rank: number;
  first: number;
  styleId: string;
  sample: number;
  rack: boolean;
  items: number[];
  tiles: Map<number, { items: number[]; x0: number; y0: number; x1: number; y1: number }>;
  paths: Map<string, { area: Path2D | null; lines: Path2D | null }>;
}

export interface FrameStats {
  ms: number;
  band: LodBand;
  batches: number;
  tiles: number;
  labels: number;
  culled: number;
}

export class Canvas2DRenderer {
  private base: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private octx: CanvasRenderingContext2D;
  private snap: HTMLCanvasElement | OffscreenCanvas | null = null;
  private snapView: View2DFrame | null = null;
  w = 1;
  h = 1;
  dpr = 1;
  view: View2DFrame = { cx: 0, cy: 0, ppm: 10 };
  band: LodBand = 1;
  private scene: SceneInput | null = null;
  private n = 0;
  boxes = new Float64Array(0);
  private grid: HitGrid | null = null;
  private layerOf: string[] = [];
  private batches: Batch[] = [];
  private primItem = new Map<string, number>();
  private refItems = new Map<string, number[]>();
  private styleCache = new Map<string, CanvasStyle>();
  private measureCache = new Map<string, number>();
  private opts: RenderOptions = { theme: 'paper', layers: null, annotations: true, units: 'metric' };
  private patterns = new Map<string, CanvasPattern | null>();
  lastStats: FrameStats | null = null;
  /** screen boxes of the labels kept by the last full frame (QA: overlap / min-size checks) */
  lastLabels: { x: number; y: number; w: number; h: number; size: number; force: boolean }[] = [];

  constructor(base: HTMLCanvasElement, overlay: HTMLCanvasElement) {
    this.base = base;
    this.overlay = overlay;
    this.ctx = base.getContext('2d', { alpha: false })!;
    this.octx = overlay.getContext('2d')!;
  }

  // ───────────── setup ─────────────

  resize(w: number, h: number, dpr: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = dpr;
    for (const c of [this.base, this.overlay]) {
      c.width = Math.round(this.w * dpr);
      c.height = Math.round(this.h * dpr);
    }
    this.snap = null;
    this.snapView = null;
  }

  setOptions(o: Partial<RenderOptions>) {
    if (o.theme && o.theme !== this.opts.theme) {
      this.styleCache.clear();
      this.patterns.clear();
    }
    this.opts = { ...this.opts, ...o };
  }

  get options(): RenderOptions {
    return this.opts;
  }

  setView(v: View2DFrame) {
    this.view = v;
    this.band = lodBand(v.ppm, this.band);
  }

  get sceneInput(): SceneInput | null {
    return this.scene;
  }

  get itemCount(): number {
    return this.n;
  }

  /** Replace only the clearance findings of the current scene (the wall audit arrives after the first paint, backlog T2 #6). */
  setClearance(marks: SceneInput['clearance']) {
    if (!this.scene) return;
    this.scene = { ...this.scene, clearance: marks };
  }

  setScene(s: SceneInput | null) {
    this.scene = s;
    this.batches = [];
    this.primItem.clear();
    this.refItems.clear();
    this.styleCache.clear();
    this.snap = null;
    if (!s) {
      this.n = 0;
      this.boxes = new Float64Array(0);
      this.grid = null;
      return;
    }
    const p = s.packed;
    const n = (this.n = p.count);
    const boxes = (this.boxes = new Float64Array(n * 4));
    this.layerOf = new Array(n);
    for (let i = 0; i < n; i++) {
      this.layerOf[i] = p.strings[p.layer[i]] ?? '';
      const a = p.ptsStart[i];
      const b = p.ptsStart[i + 1];
      const pts = p.pts;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      const kind = KINDS[p.kind[i]];
      if (kind === 'rect' && b - a >= 4) {
        const rx = pts[a];
        const ry = pts[a + 1];
        const rw = pts[a + 2];
        const rh = pts[a + 3];
        x0 = Math.min(rx, rx + rw);
        x1 = Math.max(rx, rx + rw);
        y0 = Math.min(ry, ry + rh);
        y1 = Math.max(ry, ry + rh);
      } else if (kind === 'circle' && b - a >= 3) {
        x0 = pts[a] - pts[a + 2];
        x1 = pts[a] + pts[a + 2];
        y0 = pts[a + 1] - pts[a + 2];
        y1 = pts[a + 1] + pts[a + 2];
      } else {
        for (let j = a; j + 1 < b; j += 2) {
          if (pts[j] < x0) x0 = pts[j];
          if (pts[j] > x1) x1 = pts[j];
          if (pts[j + 1] < y0) y0 = pts[j + 1];
          if (pts[j + 1] > y1) y1 = pts[j + 1];
        }
      }
      boxes[i * 4] = x0;
      boxes[i * 4 + 1] = y0;
      boxes[i * 4 + 2] = x1;
      boxes[i * 4 + 3] = y1;
      const pid = p.primId[i] >= 0 ? p.strings[p.primId[i]] : undefined;
      if (pid !== undefined && !this.primItem.has(pid)) this.primItem.set(pid, i);
      const rid = p.refId[i] >= 0 ? p.strings[p.refId[i]] : undefined;
      if (rid !== undefined) {
        const l = this.refItems.get(rid);
        if (l) l.push(i);
        else this.refItems.set(rid, [i]);
      }
    }
    this.grid = new HitGrid(boxes, s.space === 'plan' ? 4 : 1);
    this.buildBatches();
  }

  private item(i: number): Pick<DrawItem2D, 'style' | 'layer' | 'primId' | 'role' | 'kind' | 'lodMin'> {
    const p = this.scene!.packed;
    return {
      style: p.strings[p.style[i]] ?? '',
      layer: this.layerOf[i] as LayerId,
      role: ROLES[p.role[i]],
      kind: KINDS[p.kind[i]],
      lodMin: p.lodMin[i] as DrawItem2D['lodMin'],
      ...(p.primId[i] >= 0 ? { primId: p.strings[p.primId[i]] } : {}),
    };
  }

  primIdOf(i: number): string | undefined {
    const p = this.scene?.packed;
    return p && p.primId[i] >= 0 ? p.strings[p.primId[i]] : undefined;
  }

  refIdOf(i: number): string | undefined {
    const p = this.scene?.packed;
    return p && p.refId[i] >= 0 ? p.strings[p.refId[i]] : undefined;
  }

  primOf(i: number): PrimInfo | undefined {
    const id = this.primIdOf(i);
    return id ? this.scene?.prims[id] : undefined;
  }

  kindOf(i: number) {
    return KINDS[this.scene!.packed.kind[i]];
  }

  layerOfItem(i: number): string {
    return this.layerOf[i];
  }

  itemsOfRef(refId: string): readonly number[] {
    return this.refItems.get(refId) ?? [];
  }

  itemOfPrim(primId: string): number | undefined {
    return this.primItem.get(primId);
  }

  itemRect(i: number): Rect {
    const b = this.boxes;
    return { x: b[i * 4], y: b[i * 4 + 1], w: b[i * 4 + 2] - b[i * 4], d: b[i * 4 + 3] - b[i * 4 + 1] };
  }

  private buildBatches() {
    const s = this.scene!;
    const p = s.packed;
    const n = this.n;
    const plan = s.space === 'plan';
    const batches: Batch[] = [];
    const byKey = new Map<string, Batch>();
    let order: number[];
    if (plan) order = Array.from({ length: n }, (_, i) => i);
    else {
      // painter order: far → near, beyond before cut (drawings/toSvg.ts)
      order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (Number.isNaN(p.depth[b]) ? 0 : p.depth[b]) - (Number.isNaN(p.depth[a]) ? 0 : p.depth[a]) || ROLE_RANK[ROLES[p.role[a]]] - ROLE_RANK[ROLES[p.role[b]]] || a - b);
    }
    let prev: Batch | null = null;
    for (const i of order) {
      if (KINDS[p.kind[i]] === 'text') continue;
      const it = this.item(i);
      const prim = it.primId ? s.prims[it.primId] : undefined;
      const sid = styleIdentity(it, prim);
      const key = `${it.lodMin}|${sid}`;
      let b: Batch | undefined;
      if (plan) b = byKey.get(key);
      else b = prev && prev.styleId === sid && prev.lodMin === it.lodMin ? prev : undefined;
      if (!b) {
        b = { layer: it.layer, lodMin: it.lodMin, rank: ROLE_RANK[it.role], first: i, styleId: sid, sample: i, rack: prim?.emitter === 'rack', items: [], tiles: new Map(), paths: new Map() };
        batches.push(b);
        if (plan) byKey.set(key, b);
      }
      b.items.push(i);
      prev = b;
    }
    if (plan) batches.sort((a, b) => a.rank - b.rank || a.first - b.first);
    const bx = this.boxes;
    for (const b of batches) {
      for (const i of b.items) {
        const cx = (bx[i * 4] + bx[i * 4 + 2]) / 2;
        const cy = (bx[i * 4 + 1] + bx[i * 4 + 3]) / 2;
        const k = plan && Number.isFinite(cx + cy) ? (Math.floor(cx / TILE_M) + 32768) * 65536 + (Math.floor(cy / TILE_M) + 32768) : 0;
        let t = b.tiles.get(k);
        if (!t) b.tiles.set(k, (t = { items: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }));
        t.items.push(i);
        t.x0 = Math.min(t.x0, bx[i * 4]);
        t.y0 = Math.min(t.y0, bx[i * 4 + 1]);
        t.x1 = Math.max(t.x1, bx[i * 4 + 2]);
        t.y1 = Math.max(t.y1, bx[i * 4 + 3]);
      }
    }
    this.batches = batches;
  }

  private styleOf(b: Batch): CanvasStyle {
    let st = this.styleCache.get(b.styleId);
    if (!st) {
      const it = this.item(b.sample);
      st = canvasStyle(it, it.primId ? this.scene!.prims[it.primId] : undefined, this.opts.theme, this.scene!.space);
      this.styleCache.set(b.styleId, st);
    }
    return st;
  }

  /** Style of one item (overlay, legend). */
  itemStyle(i: number): CanvasStyle {
    const it = this.item(i);
    return canvasStyle(it, it.primId ? this.scene!.prims[it.primId] : undefined, this.opts.theme, this.scene!.space);
  }

  private tracePath(path: Path2D, lines: Path2D, i: number): 'area' | 'line' | null {
    const p = this.scene!.packed;
    const a = p.ptsStart[i];
    const b = p.ptsStart[i + 1];
    const pts = p.pts;
    switch (KINDS[p.kind[i]]) {
      case 'rect':
        if (b - a < 4) return null;
        path.rect(pts[a], pts[a + 1], pts[a + 2], pts[a + 3]);
        return 'area';
      case 'circle':
        if (b - a < 3) return null;
        path.moveTo(pts[a] + pts[a + 2], pts[a + 1]);
        path.arc(pts[a], pts[a + 1], pts[a + 2], 0, Math.PI * 2);
        return 'area';
      case 'polygon':
        if (b - a < 6) return null;
        path.moveTo(pts[a], pts[a + 1]);
        for (let j = a + 2; j + 1 < b; j += 2) path.lineTo(pts[j], pts[j + 1]);
        path.closePath();
        return 'area';
      case 'polyline':
        if (b - a < 4) return null;
        lines.moveTo(pts[a], pts[a + 1]);
        for (let j = a + 2; j + 1 < b; j += 2) lines.lineTo(pts[j], pts[j + 1]);
        return 'line';
      default:
        return null;
    }
  }

  private tilePaths(b: Batch, key: number, bars: boolean): { area: Path2D | null; lines: Path2D | null } {
    const ck = `${key}|${bars ? 1 : 0}`;
    let c = b.paths.get(ck);
    if (c) return c;
    const t = b.tiles.get(key)!;
    const area = new Path2D();
    const lines = new Path2D();
    let na = 0;
    let nl = 0;
    if (bars) {
      // merge racks of one row into bars (touching rects with the same cross extent)
      const bx = this.boxes;
      const byRow = new Map<string, number[]>();
      for (const i of t.items) {
        const r = this.primOf(i)?.rowId ?? '';
        const l = byRow.get(r);
        if (l) l.push(i);
        else byRow.set(r, [i]);
      }
      for (const ids of byRow.values()) {
        const wide = ids.length > 1 && bx[ids[ids.length - 1] * 4] - bx[ids[0] * 4] > bx[ids[ids.length - 1] * 4 + 1] - bx[ids[0] * 4 + 1] ? 0 : 1;
        const ax = wide === 0 ? 0 : 1;
        ids.sort((p, q) => bx[p * 4 + ax] - bx[q * 4 + ax]);
        let cur: [number, number, number, number] | null = null;
        const flush = () => {
          if (cur) {
            area.rect(cur[0], cur[1], cur[2] - cur[0], cur[3] - cur[1]);
            na++;
          }
        };
        for (const i of ids) {
          const r: [number, number, number, number] = [bx[i * 4], bx[i * 4 + 1], bx[i * 4 + 2], bx[i * 4 + 3]];
          if (cur && Math.abs(r[1 - ax] - cur[1 - ax]) < 0.05 && Math.abs(r[3 - ax] - cur[3 - ax]) < 0.05 && r[ax] - cur[2 + ax] < 0.05) {
            cur[2 + ax] = Math.max(cur[2 + ax], r[2 + ax]);
          } else {
            flush();
            cur = r;
          }
        }
        flush();
      }
    } else {
      for (const i of t.items) {
        const k = this.tracePath(area, lines, i);
        if (k === 'area') na++;
        else if (k === 'line') nl++;
      }
    }
    c = { area: na ? area : null, lines: nl ? lines : null };
    b.paths.set(ck, c);
    return c;
  }

  private pattern(ctx: CanvasRenderingContext2D, kind: string): CanvasPattern | null {
    const k = `${kind}|${this.opts.theme}`;
    if (this.patterns.has(k)) return this.patterns.get(k)!;
    const T = tokens(this.opts.theme);
    const size = kind === 'rack-cut' ? 10 : 7;
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    let pat: CanvasPattern | null = null;
    if (g) {
      g.strokeStyle = kind === 'wall' ? T.ink : T.inkSoft;
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(0, size);
      g.lineTo(size, 0);
      g.moveTo(-1, 1);
      g.lineTo(1, -1);
      g.moveTo(size - 1, size + 1);
      g.lineTo(size + 1, size - 1);
      g.stroke();
      pat = ctx.createPattern(c as CanvasImageSource, 'repeat');
    }
    this.patterns.set(k, pat);
    return pat;
  }

  private layerOn(l: string): boolean {
    return !this.opts.layers || this.opts.layers.has(l);
  }

  /** Is item i drawn at the current band / layers (pick + marquee use this). */
  visibleItem(i: number): boolean {
    const p = this.scene?.packed;
    if (!p) return false;
    return p.lodMin[i] <= Math.max(this.band, 1) && this.layerOn(this.layerOf[i]) && KINDS[p.kind[i]] !== 'text';
  }

  // ───────────── base frame ─────────────

  /** Full redraw of the base canvas; keeps a snapshot for gesture blits. */
  drawBase(): FrameStats {
    const t0 = performance.now();
    const stats = this.render(this.ctx, this.w, this.h, this.dpr, this.view);
    this.snapshot();
    stats.ms = performance.now() - t0;
    this.lastStats = stats;
    return stats;
  }

  private snapshot() {
    const W = this.base.width;
    const H = this.base.height;
    if (!this.snap || this.snap.width !== W || this.snap.height !== H) {
      this.snap = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
    }
    const g = this.snap.getContext('2d') as CanvasRenderingContext2D | null;
    if (!g) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.base, 0, 0);
    this.snapView = { ...this.view };
  }

  /** Gesture frame: the last full frame transformed to `v` (no geometry work). Returns false when no snapshot exists. */
  blit(v: View2DFrame): boolean {
    this.view = v;
    if (!this.snap || !this.snapView) return false;
    const ctx = this.ctx;
    const s0 = this.snapView;
    const k = v.ppm / s0.ppm;
    const [wx, wy] = screenToWorld(s0, this.w, this.h, 0, 0);
    const [sx, sy] = worldToScreen(v, this.w, this.h, wx, wy);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = tokens(this.opts.theme).ground;
    ctx.fillRect(0, 0, this.base.width, this.base.height);
    ctx.drawImage(this.snap as CanvasImageSource, sx * this.dpr, sy * this.dpr, this.base.width * k, this.base.height * k);
    return true;
  }

  /** Render the scene into any 2D context (base canvas, PNG export). */
  render(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, v: View2DFrame): FrameStats {
    const T = tokens(this.opts.theme);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = T.ground;
    ctx.fillRect(0, 0, w * dpr, h * dpr);
    const stats: FrameStats = { ms: 0, band: this.band, batches: 0, tiles: 0, labels: 0, culled: 0 };
    const s = this.scene;
    if (!s) return stats;
    const band = s.space === 'plan' ? this.band : 3;
    const ppm = v.ppm;
    const k = ppm * dpr;
    const vis = visibleRect(v, w, h);
    const vx1 = vis.x + vis.w;
    const vy1 = vis.y + vis.d;
    ctx.setTransform(k, 0, 0, -k, dpr * (w / 2 - v.cx * ppm), dpr * (h / 2 + v.cy * ppm));
    ctx.lineJoin = 'miter';
    const bars = s.space === 'plan' && ppm < ROW_BAR_PPM;
    const lite = !!this.opts.lite;
    for (const b of this.batches) {
      if (b.lodMin > Math.max(band, 1) || !this.layerOn(b.layer)) continue;
      const st = this.styleOf(b);
      const useBars = bars && b.rack;
      let drew = false;
      for (const [key, t] of b.tiles) {
        if (t.x0 > vx1 || t.x1 < vis.x || t.y0 > vy1 || t.y1 < vis.y) continue;
        const paths = this.tilePaths(b, key, useBars);
        stats.tiles++;
        drew = true;
        if (paths.area) {
          if (st.fill) {
            ctx.fillStyle = st.fill;
            ctx.fill(paths.area);
            if (st.hatch && !useBars && !lite) {
              const pat = this.pattern(ctx, st.hatch);
              if (pat) {
                pat.setTransform?.(new DOMMatrix([1 / k, 0, 0, -1 / k, 0, 0]));
                ctx.fillStyle = pat;
                ctx.fill(paths.area);
              }
            }
          }
          if (st.stroke && !(useBars && ppm < 3)) {
            ctx.strokeStyle = st.stroke;
            ctx.lineWidth = st.lw / ppm;
            ctx.setLineDash(st.dash && !lite ? st.dash.map((d) => d / ppm) : []);
            ctx.stroke(paths.area);
          }
        }
        if (paths.lines) {
          ctx.strokeStyle = st.stroke ?? st.fill ?? T.ink;
          ctx.lineWidth = Math.max(st.lw, 1.25) / ppm;
          ctx.setLineDash(st.dash && !lite ? st.dash.map((d) => d / ppm) : []);
          ctx.stroke(paths.lines);
        }
      }
      if (drew) stats.batches++;
    }
    ctx.setLineDash([]);
    // clearance findings (red rings)
    if (s.clearance?.length) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = CLEARANCE_RED;
      ctx.lineWidth = 2;
      for (const c of s.clearance) {
        const [px, py] = worldToScreen(v, w, h, c.x, s.space === 'plan' ? c.y : c.z);
        if (px < -10 || py < -10 || px > w + 10 || py > h + 10) continue;
        ctx.beginPath();
        ctx.arc(px, py, 7, 0, Math.PI * 2);
        ctx.moveTo(px - 4, py - 4);
        ctx.lineTo(px + 4, py + 4);
        ctx.stroke();
      }
    }
    if (this.opts.annotations && !lite) this.drawAnnotations(ctx, w, h, dpr, v, band, stats);
    return stats;
  }

  // ───────────── annotations ─────────────

  measure(ctx: CanvasRenderingContext2D, s: string, px: number, weight = ''): number {
    const key = `${weight}|${s}`;
    let w1 = this.measureCache.get(key);
    if (w1 === undefined) {
      ctx.save();
      ctx.font = `${weight ? weight + ' ' : ''}64px ${this.opts.font ?? DEFAULT_FONT}`;
      w1 = ctx.measureText(s).width / 64;
      ctx.restore();
      this.measureCache.set(key, w1);
      if (this.measureCache.size > 50_000) this.measureCache.clear();
    }
    return w1 * px;
  }

  private drawAnnotations(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, v: View2DFrame, band: LodBand, stats: FrameStats) {
    const s = this.scene!;
    const T = tokens(this.opts.theme);
    const font = this.opts.font ?? DEFAULT_FONT;
    const force = this.opts.forceLabelIds;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vis = visibleRect(v, w, h);
    const margin = 60 / v.ppm;
    const S = (x: number, y: number) => worldToScreen(v, w, h, x, y);
    const cands: LabelCandidate[] = [];
    const draws: (() => void)[] = [];
    const occ = new ScreenOccupancy(16, 1);
    const bgFor = T.ground;
    const text = (x: number, y: number, str: string, px: number, color: string, o: { rot?: number; weight?: string; align?: CanvasTextAlign; bg?: string } = {}) => {
      ctx.save();
      ctx.translate(x, y);
      if (o.rot) ctx.rotate((o.rot * Math.PI) / 180);
      ctx.font = `${o.weight ? o.weight + ' ' : ''}${px}px ${font}`;
      ctx.textAlign = o.align ?? 'center';
      ctx.textBaseline = 'middle';
      if (o.bg) {
        const tw = this.measure(ctx, str, px, o.weight);
        ctx.fillStyle = o.bg;
        const ox = o.align === 'left' ? 0 : o.align === 'right' ? -tw : -tw / 2;
        ctx.fillRect(ox - 2, -px * 0.62, tw + 4, px * 1.24);
      }
      else {
        // ground-coloured halo: labels stay legible over dashed overhead services
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.strokeStyle = bgFor;
        ctx.strokeText(str, 0, 0);
      }
      ctx.fillStyle = color;
      ctx.fillText(str, 0, 0);
      ctx.restore();
    };
    const push = (box: { x: number; y: number; w: number; h: number }, priority: number, size: number, draw: () => void, forced = false) => {
      cands.push({ box, priority, size, force: forced });
      draws.push(draw);
    };
    for (const a of s.ann) {
      if (a.lodMin > Math.max(band, 1) || !this.layerOn(a.layer)) continue;
      const p = a.pts;
      if (p.length < 2) continue;
      if (a.kind !== 'dim-chain' && a.kind !== 'section-marker' && a.kind !== 'callout') {
        if (p[0] < vis.x - margin || p[0] > vis.x + vis.w + margin || p[1] < vis.y - margin || p[1] > vis.y + vis.d + margin) continue;
      }
      const forced = !!(force && ((a.primId && force.has(a.primId)) || (a.refId && force.has(a.refId))));
      switch (a.kind) {
        case 'tag': {
          if (!a.text) break;
          const ii = a.primId ? this.primItem.get(a.primId) : undefined;
          const r = ii !== undefined ? this.itemRect(ii) : { x: p[0] - 0.3, y: p[1] - 0.3, w: 0.6, d: 0.6 };
          const vertical = Math.abs(a.rot ?? 0) === 90;
          const longPx = (vertical ? r.d : r.w) * v.ppm;
          const shortPx = (vertical ? r.w : r.d) * v.ppm;
          let px = fitFontPx((str, q) => this.measure(ctx, str, q), a.text, longPx, shortPx, 12);
          if (!px && forced) px = MIN_LABEL_PX + 1;
          if (!px) break;
          const [x, y] = S(p[0], p[1]);
          const tw = this.measure(ctx, a.text, px);
          const str = a.text;
          push(centredBox(x, y, tw, px, a.rot ?? 0), a.priority, px, () => text(x, y, str, px, forced ? ACCENT : T.ink, { rot: a.rot, weight: forced ? '600' : '' }), forced);
          break;
        }
        case 'position-tag':
        case 'du-label':
        case 'note': {
          if (!a.text) break;
          const px = a.kind === 'du-label' ? 13 : a.kind === 'note' ? 11 : 9;
          const [x, y] = S(p[0], p[1]);
          const tw = this.measure(ctx, a.text, px, a.kind === 'du-label' ? '600' : '');
          const str = a.text;
          const color = a.kind === 'position-tag' ? T.inkSoft : T.ink;
          push(centredBox(x, y, tw, px, a.rot ?? 0), a.priority, px, () => text(x, y, str, px, color, { rot: a.rot, weight: a.kind === 'du-label' ? '600' : '' }), forced);
          break;
        }
        case 'grid-bubble': {
          const [x, y] = S(p[0], p[1]);
          const str = a.text ?? '';
          push({ x: x - 10, y: y - 10, w: 20, h: 20 }, a.priority, 11, () => {
            ctx.beginPath();
            ctx.arc(x, y, 9, 0, Math.PI * 2);
            ctx.fillStyle = bgFor;
            ctx.fill();
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 1;
            ctx.stroke();
            text(x, y, str, 10, T.ink);
          });
          break;
        }
        case 'keynote': {
          const [x, y] = S(p[0], p[1]);
          const str = a.text ?? a.keynoteId ?? '';
          const tx = p.length >= 4 ? S(p[2], p[3]) : null;
          push({ x: x - 12, y: y - 8, w: 24, h: 16 }, a.priority, 10, () => {
            if (tx) {
              ctx.beginPath();
              ctx.moveTo(x, y);
              ctx.lineTo(tx[0], tx[1]);
              ctx.strokeStyle = T.inkSoft;
              ctx.lineWidth = 1;
              ctx.stroke();
              ctx.beginPath();
              ctx.arc(tx[0], tx[1], 1.8, 0, Math.PI * 2);
              ctx.fillStyle = T.inkSoft;
              ctx.fill();
            }
            ctx.beginPath();
            ctx.ellipse(x, y, 11, 7.5, 0, 0, Math.PI * 2);
            ctx.fillStyle = bgFor;
            ctx.fill();
            ctx.strokeStyle = T.ink;
            ctx.lineWidth = 1;
            ctx.stroke();
            text(x, y, str, 9.5, T.ink);
          });
          break;
        }
        case 'datum': {
          const [x, y] = S(p[0], p[1]);
          const str = a.text ?? '';
          const px = 10.5;
          const tw = this.measure(ctx, str, px);
          const left = a.side === 'left';
          // level line + ▽ always drawn; the text is culled
          ctx.strokeStyle = T.lineLight;
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          const [lx0] = S(vis.x, p[1]);
          ctx.moveTo(Math.max(0, lx0), y);
          ctx.lineTo(x, y);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 5, y - 8);
          ctx.lineTo(x + 5, y - 8);
          ctx.closePath();
          ctx.fillStyle = bgFor;
          ctx.fill();
          ctx.strokeStyle = T.ink;
          ctx.stroke();
          const bx = left ? x - 8 - tw : x + 8;
          push({ x: bx, y: y - 8 - px * 0.6, w: tw, h: px * 1.2 }, a.priority, px, () => text(bx, y - 8, str, px, T.ink, { align: 'left' }));
          break;
        }
        case 'dim-chain': {
          const horiz = a.axis !== 'v';
          const stops: [number, number][] = [];
          for (let j = 0; j + 1 < p.length; j += 2) stops.push(S(p[j], p[j + 1]));
          if (stops.length < 2) break;
          const offscreen = stops.every(([x, y]) => x < -20 || y < -20 || x > w + 20 || y > h + 20) && !(horiz ? stops[0][0] < 0 && stops[stops.length - 1][0] > w : stops[0][1] > h && stops[stops.length - 1][1] < 0);
          if (offscreen) break;
          ctx.strokeStyle = T.inkSoft;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(stops[0][0], stops[0][1]);
          ctx.lineTo(stops[stops.length - 1][0], stops[stops.length - 1][1]);
          for (const [x, y] of stops) {
            ctx.moveTo(x - 3.5, y + 3.5);
            ctx.lineTo(x + 3.5, y - 3.5);
          }
          ctx.stroke();
          const px = 10;
          stops.slice(1).forEach(([x1, y1], j) => {
            const str = a.texts?.[j] ?? '';
            if (!str) return;
            const [x0, y0] = stops[j];
            const segPx = Math.hypot(x1 - x0, y1 - y0);
            const tw = this.measure(ctx, str, px);
            if (tw + 6 > segPx) return;
            const mx = (x0 + x1) / 2;
            const my = (y0 + y1) / 2;
            const rot = horiz ? 0 : -90;
            const tx = horiz ? mx : mx - px * 0.75;
            const ty = horiz ? my - px * 0.75 : my;
            push(centredBox(tx, ty, tw, px, rot), a.priority, px, () => text(tx, ty, str, px, T.ink, { rot }));
          });
          break;
        }
        case 'section-marker': {
          const [x0, y0] = S(p[0], p[1]);
          const [x1, y1] = S(p[2], p[3]);
          this.drawMarkerLine(ctx, x0, y0, x1, y1, a.text ?? '', a.look ?? 1, T.ink, false);
          break;
        }
        case 'callout': {
          const [x0, y0] = S(p[0], p[1] + p[3]);
          const [x1, y1] = S(p[0] + p[2], p[1]);
          ctx.strokeStyle = '#0b6e99';
          ctx.lineWidth = 1.25;
          ctx.setLineDash([10, 3, 2, 3]);
          ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
          ctx.setLineDash([]);
          const str = a.target ? `${a.text ?? ''}/${a.target}` : a.text ?? '';
          push({ x: x1, y: y0 - 22, w: 40, h: 20 }, a.priority, 10, () => text(x1 + 20, y0 - 12, str, 10, '#0b6e99', { bg: bgFor }));
          break;
        }
      }
    }
    const kept = cullScreenLabels(cands, occ);
    for (const i of kept) draws[i]();
    this.lastLabels = kept.map((i) => ({ ...cands[i].box, size: cands[i].size, force: !!cands[i].force }));
    stats.labels = kept.length;
    stats.culled = cands.length - kept.length;
  }

  /** Dash-dot cut line with a label bubble past each end and look arrows (screen px). */
  drawMarkerLine(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, label: string, look: number, color: string, active: boolean) {
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    // look direction in screen space: world look ⟂ the line; world y-up → screen y-down flips the sign for horizontal lines
    const horizontal = Math.abs(uy) < Math.abs(ux);
    const lx = horizontal ? 0 : look;
    const ly = horizontal ? -look : 0;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = active ? 2.5 : 1.75;
    ctx.setLineDash([14, 4, 3, 4]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [ex, ey, sgn] of [[x0, y0, -1], [x1, y1, 1]] as const) {
      const bx = ex + ux * sgn * 16;
      const by = ey + uy * sgn * 16;
      ctx.beginPath();
      ctx.arc(bx, by, 10, 0, Math.PI * 2);
      ctx.fillStyle = tokens(this.opts.theme).ground;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.font = `600 11px ${this.opts.font ?? DEFAULT_FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, by);
      // arrow
      const ax = ex + lx * 4;
      const ay = ey + ly * 4;
      ctx.beginPath();
      ctx.moveTo(ax + lx * 12, ay + ly * 12);
      ctx.lineTo(ax - ux * 6, ay - uy * 6);
      ctx.lineTo(ax + ux * 6, ay + uy * 6);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ───────────── overlay ─────────────

  traceItemScreen(ctx: CanvasRenderingContext2D, i: number, v: View2DFrame = this.view) {
    const p = this.scene!.packed;
    const a = p.ptsStart[i];
    const b = p.ptsStart[i + 1];
    const pts = p.pts;
    const S = (x: number, y: number) => worldToScreen(v, this.w, this.h, x, y);
    switch (KINDS[p.kind[i]]) {
      case 'rect': {
        const [x0, y0] = S(pts[a], pts[a + 1] + pts[a + 3]);
        const [x1, y1] = S(pts[a] + pts[a + 2], pts[a + 1]);
        ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.max(1, Math.abs(x1 - x0)), Math.max(1, Math.abs(y1 - y0)));
        break;
      }
      case 'circle': {
        const [x, y] = S(pts[a], pts[a + 1]);
        ctx.moveTo(x + Math.max(2, pts[a + 2] * v.ppm), y);
        ctx.arc(x, y, Math.max(2, pts[a + 2] * v.ppm), 0, Math.PI * 2);
        break;
      }
      case 'polygon':
      case 'polyline': {
        for (let j = a; j + 1 < b; j += 2) {
          const [x, y] = S(pts[j], pts[j + 1]);
          if (j === a) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (KINDS[p.kind[i]] === 'polygon') ctx.closePath();
        break;
      }
    }
  }

  drawOverlay(o: OverlayState, labels: { scale?: (m: number) => string } = {}) {
    const ctx = this.octx;
    const dpr = this.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.scene) return;
    const T = tokens(this.opts.theme);
    const v = this.view;
    const S = (x: number, y: number) => worldToScreen(v, this.w, this.h, x, y);
    // selection: 2 px accent + 20 % halo
    if (o.selected.length) {
      ctx.beginPath();
      for (const i of o.selected) if (i < this.n) this.traceItemScreen(ctx, i);
      ctx.strokeStyle = 'rgba(57,135,229,0.25)';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (o.local !== null && o.local !== undefined && o.local < this.n) {
      ctx.beginPath();
      this.traceItemScreen(ctx, o.local);
      ctx.strokeStyle = 'rgba(57,135,229,0.25)';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (o.hovered !== null && o.hovered < this.n) {
      ctx.beginPath();
      this.traceItemScreen(ctx, o.hovered);
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      // the hovered object's tag is always drawn (spec §3.2 label culling), above its footprint
      const tag = this.primOf(o.hovered)?.tag;
      if (tag && this.opts.annotations) {
        const r = this.itemRect(o.hovered);
        const [x, y] = S(r.x + r.w / 2, r.y + r.d);
        ctx.font = `600 11px ${this.opts.font ?? DEFAULT_FONT}`;
        const tw = ctx.measureText(tag).width;
        ctx.fillStyle = T.ground;
        ctx.fillRect(x - tw / 2 - 3, y - 17, tw + 6, 14);
        ctx.fillStyle = ACCENT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tag, x, y - 10);
      }
    }
    // cuts on the plan
    if (o.space === 'plan' && o.cuts?.length) {
      for (const c of o.cuts) {
        const seg = cutSegment(c.cut, o.hallRect ?? null);
        if (!seg) continue;
        const [x0, y0] = S(seg[0], seg[1]);
        const [x1, y1] = S(seg[2], seg[3]);
        const color = c.preview ? ACCENT : c.active ? '#0b6e99' : T.inkSoft;
        const look = c.cut.look;
        // depth window
        if (c.depthM !== undefined && c.depthM > 0) {
          const dx = c.cut.axis === 'x' ? look * c.depthM : 0;
          const dy = c.cut.axis === 'y' ? look * c.depthM : 0;
          const [a0, b0] = S(seg[0] + dx, seg[1] + dy);
          const [a1, b1] = S(seg[2] + dx, seg[3] + dy);
          ctx.fillStyle = 'rgba(11,110,153,0.07)';
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
          ctx.lineTo(a1, b1);
          ctx.lineTo(a0, b0);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.setLineDash([5, 4]);
          ctx.beginPath();
          ctx.moveTo(a0, b0);
          ctx.lineTo(a1, b1);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        this.drawMarkerLine(ctx, x0, y0, x1, y1, c.cut.label.split(/[–-]/)[0] || c.cut.label, look, color, !!c.active || !!c.preview);
      }
    }
    if (o.camera && o.space === 'plan') {
      const [x, y] = S(o.camera.x, o.camera.y);
      const yaw = (o.camera.yaw * Math.PI) / 180;
      const half = ((o.camera.fovDeg / 2) * Math.PI) / 180;
      const r = 60;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.arc(x, y, r, -(yaw + half), -(yaw - half));
      ctx.closePath();
      ctx.fillStyle = 'rgba(57,135,229,0.16)';
      ctx.fill();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = ACCENT;
      ctx.fill();
    }
    if (o.marquee) {
      const m = o.marquee;
      ctx.fillStyle = 'rgba(57,135,229,0.10)';
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.fillRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
      ctx.setLineDash([]);
    }
    if (o.measure && (o.measure.pts.length || o.measure.cursor)) {
      const pts = [...o.measure.pts, ...(o.measure.cursor && !o.measure.closed ? [o.measure.cursor] : [])];
      ctx.strokeStyle = '#e5484d';
      ctx.fillStyle = '#e5484d';
      ctx.lineWidth = 1.75;
      ctx.beginPath();
      pts.forEach(([x, y], j) => {
        const [sx, sy] = S(x, y);
        if (j === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      });
      ctx.stroke();
      for (const [x, y] of pts) {
        const [sx, sy] = S(x, y);
        ctx.beginPath();
        ctx.arc(sx, sy, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      const fmt = labels.scale ?? ((m: number) => fmtLength(m, this.opts.units));
      for (let j = 1; j < pts.length; j++) {
        const [ax, ay] = S(pts[j - 1][0], pts[j - 1][1]);
        const [bx, by] = S(pts[j][0], pts[j][1]);
        const L = Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
        const str = fmt(L);
        ctx.font = `600 11px ${this.opts.font ?? DEFAULT_FONT}`;
        const tw = ctx.measureText(str).width;
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2 - 10;
        ctx.fillStyle = T.ground;
        ctx.fillRect(mx - tw / 2 - 3, my - 8, tw + 6, 16);
        ctx.fillStyle = '#e5484d';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(str, mx, my);
      }
    }
    if (o.snap) {
      const [x, y] = S(o.snap.x, o.snap.y);
      ctx.strokeStyle = '#f5a524';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 5, y - 5, 10, 10);
      if (o.snap.label) {
        ctx.font = `10px ${this.opts.font ?? DEFAULT_FONT}`;
        ctx.fillStyle = '#f5a524';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(o.snap.label, x + 9, y - 9);
      }
    }
    if (o.showScale !== false) this.drawScaleBar(ctx, this.w, this.h, v, o.space === 'plan' ? o.northLabel : undefined);
  }

  /** Scale bar (bottom-left) and, on plans, the north arrow above it. */
  drawScaleBar(ctx: CanvasRenderingContext2D, w: number, h: number, v: View2DFrame, northLabel?: string) {
    const T = tokens(this.opts.theme);
    const L = niceLength(110 / v.ppm);
    const px = L * v.ppm;
    const x0 = 16;
    const y0 = h - 34;
    ctx.save();
    ctx.fillStyle = this.opts.theme === 'dark' ? 'rgba(17,20,24,0.78)' : 'rgba(255,255,255,0.85)';
    ctx.fillRect(x0 - 8, y0 - (northLabel ? 58 : 14), Math.max(px, 60) + 70, northLabel ? 84 : 40);
    for (let k = 0; k < 4; k++) {
      ctx.fillStyle = k % 2 ? T.ground : T.ink;
      ctx.fillRect(x0 + (px * k) / 4, y0, px / 4, 5);
    }
    ctx.strokeStyle = T.ink;
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, px, 5);
    ctx.fillStyle = T.ink;
    ctx.font = `10.5px ${this.opts.font ?? DEFAULT_FONT}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('0', x0 - 3, y0 + 8);
    ctx.textAlign = 'center';
    ctx.fillText(fmtLength(L, this.opts.units), x0 + px, y0 + 8);
    if (northLabel) {
      const nx = x0 + 10;
      const ny = y0 - 22;
      ctx.beginPath();
      ctx.moveTo(nx, ny - 26);
      ctx.lineTo(nx + 7, ny);
      ctx.lineTo(nx, ny - 6);
      ctx.lineTo(nx - 7, ny);
      ctx.closePath();
      ctx.fillStyle = T.ink;
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = `600 10.5px ${this.opts.font ?? DEFAULT_FONT}`;
      ctx.fillText(northLabel, nx + 14, ny - 14);
    }
    ctx.restore();
  }

  // ───────────── picking ─────────────

  /** Topmost pickable item at a screen point (pick rank first, then draw order), or null. */
  pick(sx: number, sy: number, tolPx = 4): number | null {
    if (!this.grid || !this.scene) return null;
    const [x, y] = screenToWorld(this.view, this.w, this.h, sx, sy);
    const tol = tolPx / this.view.ppm;
    const p = this.scene.packed;
    const hits = this.grid.pick(x, y, tol, (i) => this.visibleItem(i) && this.exactHit(i, x, y, tol));
    let best: number | null = null;
    let bestRank = Infinity;
    for (const i of hits) {
      const prim = this.primOf(i);
      const rank = prim ? PICK_RANK[prim.emitter] ?? 20 : 20;
      if (p.role[i] === ROLES.indexOf('ghost')) continue;
      if (rank < bestRank || (rank === bestRank && best !== null && i > best)) {
        best = i;
        bestRank = rank;
      }
    }
    return best;
  }

  exactHit(i: number, x: number, y: number, tol: number): boolean {
    const p = this.scene!.packed;
    const a = p.ptsStart[i];
    const b = p.ptsStart[i + 1];
    const pts = p.pts;
    switch (KINDS[p.kind[i]]) {
      case 'rect': {
        const x0 = Math.min(pts[a], pts[a] + pts[a + 2]);
        const x1 = Math.max(pts[a], pts[a] + pts[a + 2]);
        const y0 = Math.min(pts[a + 1], pts[a + 1] + pts[a + 3]);
        const y1 = Math.max(pts[a + 1], pts[a + 1] + pts[a + 3]);
        const fill = this.itemStyle(i).fill !== null;
        const inside = x >= x0 - tol && x <= x1 + tol && y >= y0 - tol && y <= y1 + tol;
        if (!inside) return false;
        if (fill) return true;
        // outline-only: near an edge
        return Math.min(Math.abs(x - x0), Math.abs(x - x1), Math.abs(y - y0), Math.abs(y - y1)) <= tol || (x1 - x0) * this.view.ppm < 10 || (y1 - y0) * this.view.ppm < 10;
      }
      case 'circle':
        return Math.hypot(x - pts[a], y - pts[a + 1]) <= pts[a + 2] + tol;
      case 'polygon':
        if (pointInPolygon(x, y, pts, a, b)) return true;
      // falls through: edge distance
      case 'polyline':
        for (let j = a + 2; j + 1 < b; j += 2) if (segDist(x, y, pts[j - 2], pts[j - 1], pts[j], pts[j + 1]) <= tol) return true;
        return false;
      default:
        return false;
    }
  }

  /** Visible items whose box touches the world rect. */
  queryRect(r: Rect): number[] {
    if (!this.grid) return [];
    return this.grid.query(r.x, r.y, r.w, r.d).filter((i) => this.visibleItem(i));
  }

  /** Rect items near a world point (snapping): corners and edge midpoints within `tol`. */
  snapPoints(x: number, y: number, tol: number): { x: number; y: number; kind: 'corner' | 'mid' }[] {
    if (!this.grid || !this.scene) return [];
    const out: { x: number; y: number; kind: 'corner' | 'mid' }[] = [];
    for (const i of this.grid.pick(x, y, tol)) {
      if (!this.visibleItem(i) || this.kindOf(i) !== 'rect') continue;
      const r = this.itemRect(i);
      if (r.w * this.view.ppm < 3 && r.d * this.view.ppm < 3) continue;
      const xs = [r.x, r.x + r.w];
      const ys = [r.y, r.y + r.d];
      for (const cx of xs) for (const cy of ys) out.push({ x: cx, y: cy, kind: 'corner' });
      out.push({ x: r.x + r.w / 2, y: r.y, kind: 'mid' }, { x: r.x + r.w / 2, y: r.y + r.d, kind: 'mid' }, { x: r.x, y: r.y + r.d / 2, kind: 'mid' }, { x: r.x + r.w, y: r.y + r.d / 2, kind: 'mid' });
    }
    return out.filter((q) => Math.abs(q.x - x) <= tol && Math.abs(q.y - y) <= tol);
  }
}

/** 1 · 2 · 5 × 10ⁿ length nearest below `m`. */
export function niceLength(m: number): number {
  if (!(m > 0)) return 1;
  const e = Math.floor(Math.log10(m));
  const b = 10 ** e;
  const f = m / b;
  return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * b;
}

/** Plan segment [x0, y0, x1, y1] of a cut's line (its window, else the hall span). */
export function cutSegment(cut: DrawingCut, hall: Rect | null): [number, number, number, number] | null {
  const look = cut.look;
  if (cut.axis === 'y') {
    const xs = cut.window ? [cut.window.u0 * look, cut.window.u1 * look].sort((a, b) => a - b) : hall ? [hall.x, hall.x + hall.w] : null;
    return xs ? [xs[0], cut.at, xs[1], cut.at] : null;
  }
  const ys = cut.window ? [-cut.window.u0 * look, -cut.window.u1 * look].sort((a, b) => a - b) : hall ? [hall.y, hall.y + hall.d] : null;
  return ys ? [cut.at, ys[0], cut.at, ys[1]] : null;
}
