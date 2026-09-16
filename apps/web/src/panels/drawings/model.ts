// r4 stream D — pure helpers of the two-column Drawings panel (no React, no DOM, no core runtime import, so the node
// vitest run can import them): series / hall / DU grouping with F·R pairing, Hangul-normalised search, fit-page math from
// sheet.paper, selection by id with nearest-sibling fallback, an LRU for built sheets and the panel-width breakpoints.
// Spec: docs/research/r4-2d-drawings-spec.md §3.1, docs/research/r4-ux-2d.md Part A.
import type { DrawingSheetMeta } from '@aidc/core';

/** 96 CSS px per inch */
export const PX_PER_MM = 96 / 25.4;
/** margin (px, both sides together) the fit modes leave around the sheet: spec `min((W−24)/w, (H−24)/h)` */
export const FIT_MARGIN_PX = 24;
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 8;
/** list row height (px) of the virtualised sheet list */
export const ROW_H = 28;
export const LIST_W = { min: 260, max: 520, default: 320 } as const;
export const RAIL_W = 56;
export const LRU_SIZE = 12;
/** selected sheet ± this many neighbours are pre-built */
export const PREBUILD_NEIGHBOURS = 2;

export type PanelLayout = 'two-col' | 'rail' | 'stacked';
/** ≥ 960 px two columns · 640–959 px number rail + flyout · < 640 px stacked */
export function layoutForWidth(px: number): PanelLayout {
  return px >= 960 ? 'two-col' : px >= 640 ? 'rail' : 'stacked';
}

export type ZoomMode = 'page' | 'width' | 'manual';

export interface Paper { w: number; h: number }
export const A1P: Paper = { w: 594, h: 841 };
export const A1L: Paper = { w: 841, h: 594 };
export const paperPx = (p: Paper) => ({ w: p.w * PX_PER_MM, h: p.h * PX_PER_MM });
/** 'A1P' / 'A1L' for the ISO A1 sizes, else '<w>×<h>' (mm) */
export function paperBadge(p: Paper | undefined): string {
  if (!p) return 'A1P';
  const near = (a: number, b: number) => Math.abs(a - b) < 1;
  if (near(p.w, 594) && near(p.h, 841)) return 'A1P';
  if (near(p.w, 841) && near(p.h, 594)) return 'A1L';
  return `${Math.round(p.w)}×${Math.round(p.h)}`;
}

export interface View { z: number; x: number; y: number }
const clampZ = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Fit the whole sheet into a W × H px viewport, centred. */
export function fitPage(paper: Paper, W: number, H: number): View {
  const px = paperPx(paper);
  const z = clampZ(Math.min((W - FIT_MARGIN_PX) / px.w, (H - FIT_MARGIN_PX) / px.h));
  return { z, x: (W - px.w * z) / 2, y: (H - px.h * z) / 2 };
}
/** Fit the sheet width, top of the sheet at half the margin (vertical centring when the sheet is shorter than the view). */
export function fitWidth(paper: Paper, W: number, H: number): View {
  const px = paperPx(paper);
  const z = clampZ((W - FIT_MARGIN_PX) / px.w);
  const h = px.h * z;
  return { z, x: (W - px.w * z) / 2, y: h <= H - FIT_MARGIN_PX ? (H - h) / 2 : FIT_MARGIN_PX / 2 };
}
/** Zoom to `nz` keeping the viewport point (mx, my) fixed on the sheet. */
export function zoomAt(v: View, nz: number, mx: number, my: number): View {
  const z = clampZ(nz);
  return { z, x: mx - ((mx - v.x) * z) / v.z, y: my - ((my - v.y) * z) / v.z };
}
/** Relative centre of the viewport on the sheet (0..1) — manual mode keeps it across sheets. */
export function relativeCentre(v: View, paper: Paper, W: number, H: number): { cx: number; cy: number } {
  const px = paperPx(paper);
  return { cx: (W / 2 - v.x) / (px.w * v.z), cy: (H / 2 - v.y) / (px.h * v.z) };
}
export function viewAtCentre(z: number, c: { cx: number; cy: number }, paper: Paper, W: number, H: number): View {
  const px = paperPx(paper);
  const zz = clampZ(z);
  return { z: zz, x: W / 2 - c.cx * px.w * zz, y: H / 2 - c.cy * px.h * zz };
}
/** the view for a mode (manual keeps `prev` zoom and relative centre, re-anchored on the new paper) */
export function viewForMode(mode: ZoomMode, paper: Paper, W: number, H: number, prev?: { view: View; paper: Paper; W: number; H: number }): View {
  if (mode === 'page') return fitPage(paper, W, H);
  if (mode === 'width') return fitWidth(paper, W, H);
  if (!prev) return fitPage(paper, W, H);
  return viewAtCentre(prev.view.z, relativeCentre(prev.view, prev.paper, prev.W, prev.H), paper, W, H);
}
/** screen scale readout: at zoom z a 1:N sheet shows 1:(N / z) */
export function screenScale(scale: string | undefined, z: number): string | null {
  const m = /^1:(\d+(?:\.\d+)?)$/.exec(scale ?? '');
  if (!m || !(z > 0)) return null;
  const den = Number(m[1]) / z;
  return `1:${den >= 100 ? Math.round(den / 10) * 10 : Math.round(den)}`;
}

// ───────────── series · hall · DU grouping ─────────────

export type SeriesId = '000' | '100' | '200' | '300' | '400' | '500' | '600' | '900';
export const SERIES_ORDER: SeriesId[] = ['000', '100', '200', '300', '400', '500', '600', '900'];
/** i18n key suffix per series (drawings.series.<id>) */
export function seriesOf(meta: Pick<DrawingSheetMeta, 'number'>): SeriesId {
  const c = meta.number.trim()[0];
  if (c === '0') return '000';
  if (c && '123456'.includes(c)) return `${c}00` as SeriesId;
  return '900';
}
/** hall of a sheet (listed hallId, else the rack-row group hall) */
export const hallOf = (m: DrawingSheetMeta): string | undefined => m.hallId ?? m.group?.hallId;
/** DU / row-group key: rack-row group key, else a 'DUnn' token in the sheet number (121-DU03, 411-H1-DU03) */
export function duOf(m: DrawingSheetMeta): string | undefined {
  if (m.group && m.group.zone !== 'type') return m.group.groupKey ?? m.group.podId;
  const tok = /(?:^|-)(DU\d+)(?:-|$)/.exec(m.number);
  return tok?.[1];
}
/** F / R face of a rack-row sheet */
export function faceOf(m: DrawingSheetMeta): 'F' | 'R' | undefined {
  if (m.group?.face === 'front') return 'F';
  if (m.group?.face === 'rear') return 'R';
  return undefined;
}
/** row id shared by the F and R sheet of one rack row segment ('2-DU01-A-F' → '2-DU01-A') */
export function pairKey(m: DrawingSheetMeta): string {
  const f = faceOf(m);
  return f ? m.number.replace(/-[FR](?=$|\.)/, '') : m.number;
}

export type FaceFilter = 'both' | 'F' | 'R';
export interface SheetFilters {
  series: SeriesId | 'all';
  hall: string | 'all';
  du: string | 'all';
  face: FaceFilter;
  q: string;
}
export const DEFAULT_FILTERS: SheetFilters = { series: 'all', hall: 'all', du: 'all', face: 'both', q: '' };

/** initial consonants (Hangul Compatibility Jamo code points, U+3131…U+314E) in syllable-block order */
const CHOSEONG_CP = [0x3131, 0x3132, 0x3134, 0x3137, 0x3138, 0x3139, 0x3141, 0x3142, 0x3143, 0x3145, 0x3146, 0x3147, 0x3148, 0x3149, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e];
/**
 * Search normalisation: Unicode NFKC (composes decomposed Hangul jamo from some IMEs / macOS paths, folds full-width
 * forms), lower case, separators and dashes removed ('2-du01-a' matches 'du01a'; spaces inside Korean titles are ignored).
 */
export function normalizeSearch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s\-_\u00b7\u2013\u2014.,:;()[\]/\\|'"`]+/g, '');
}
/** initial-consonant string of Hangul syllables (other characters kept) */
export function choseong(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7a3) out += String.fromCodePoint(CHOSEONG_CP[Math.floor((c - 0xac00) / 588)]);
    else out += ch;
  }
  return out;
}
/** compatibility-jamo consonants only (checked on the NFC query: NFKC would turn them into conjoining jamo) */
const ONLY_JAMO = /^[\u3131-\u314e]+$/;
/** true when the query matches the sheet number or title (case- and Hangul-normalised; a consonant-only query matches initials) */
export function matchSheet(m: Pick<DrawingSheetMeta, 'number' | 'title'>, q: string): boolean {
  const nq = normalizeSearch(q);
  if (!nq) return true;
  const hay = normalizeSearch(`${m.number} ${m.title}`);
  if (hay.includes(nq)) return true;
  const jq = q.normalize('NFC').replace(/\s+/g, '');
  return ONLY_JAMO.test(jq) && choseong(m.title).replace(/\s+/g, '').includes(jq);
}

/** filtered sheets in list order (face filter applies to rack-row sheets only) */
export function filterSheets(sheets: readonly DrawingSheetMeta[], f: SheetFilters): DrawingSheetMeta[] {
  return sheets.filter((m) => {
    if (f.series !== 'all' && seriesOf(m) !== f.series) return false;
    if (f.hall !== 'all' && hallOf(m) !== undefined && hallOf(m) !== f.hall) return false;
    if (f.du !== 'all' && duOf(m) !== f.du) return false;
    const face = faceOf(m);
    if (face && f.face !== 'both' && face !== f.face) return false;
    return matchSheet(m, f.q);
  });
}

export interface ListRowSheet {
  type: 'sheet';
  key: string;
  depth: number;
  /** the sheet a click selects (face filter default: F unless the filter is R) */
  primary: DrawingSheetMeta;
  /** F / R pills of a rack-row pair */
  faces?: { F?: DrawingSheetMeta; R?: DrawingSheetMeta };
  ids: string[];
}
export interface ListRowGroup {
  type: 'group';
  key: string;
  depth: number;
  level: 'series' | 'hall' | 'du';
  /** series id, hall id or DU key */
  value: string;
  count: number;
  expanded: boolean;
  ids: string[];
}
export type ListRow = ListRowSheet | ListRowGroup;

export interface TreeNode {
  key: string;
  level: 'series' | 'hall' | 'du';
  value: string;
  children: (TreeNode | ListRowSheet)[];
  ids: string[];
}

/** group key of a sheet (series / hall / DU path) — the "sibling" scope of the selection fallback */
export function groupPath(m: DrawingSheetMeta, multiHall: boolean): string {
  const s = seriesOf(m);
  const h = multiHall ? hallOf(m) ?? '' : '';
  return `${s}|${h}|${duOf(m) ?? ''}`;
}

function pairRows(sheets: DrawingSheetMeta[], depth: number, face: FaceFilter): ListRowSheet[] {
  const rows: ListRowSheet[] = [];
  const byPair = new Map<string, ListRowSheet>();
  for (const m of sheets) {
    const f = faceOf(m);
    if (!f) {
      rows.push({ type: 'sheet', key: `s:${m.id}`, depth, primary: m, ids: [m.id] });
      continue;
    }
    const pk = `${hallOf(m) ?? ''}|${pairKey(m)}`;
    let row = byPair.get(pk);
    if (!row) {
      row = { type: 'sheet', key: `p:${pk}`, depth, primary: m, faces: {}, ids: [] };
      byPair.set(pk, row);
      rows.push(row);
    }
    row.faces![f] = m;
    row.ids.push(m.id);
    row.primary = (face === 'R' ? row.faces!.R : row.faces!.F) ?? row.faces!.F ?? row.faces!.R ?? m;
  }
  return rows;
}

/**
 * Build the grouped tree: series → hall (only when the sheets span more than one hall) → DU (only when a DU bucket holds
 * at least two list rows). F / R sheets of one row segment share one list row.
 */
export function buildTree(sheets: readonly DrawingSheetMeta[], face: FaceFilter = 'both'): { nodes: TreeNode[]; multiHall: boolean } {
  const halls = new Set(sheets.map(hallOf).filter((h): h is string => !!h));
  const multiHall = halls.size > 1;
  const nodes: TreeNode[] = [];
  const bySeries = new Map<SeriesId, DrawingSheetMeta[]>();
  for (const m of sheets) {
    const s = seriesOf(m);
    if (!bySeries.has(s)) bySeries.set(s, []);
    bySeries.get(s)!.push(m);
  }
  const duLevel = (list: DrawingSheetMeta[], prefix: string, depth: number): (TreeNode | ListRowSheet)[] => {
    const out: (TreeNode | ListRowSheet)[] = [];
    const buckets = new Map<string, DrawingSheetMeta[]>();
    const order: (string | DrawingSheetMeta)[] = [];
    for (const m of list) {
      const du = duOf(m);
      if (!du) {
        order.push(m);
        continue;
      }
      if (!buckets.has(du)) {
        buckets.set(du, []);
        order.push(du);
      }
      buckets.get(du)!.push(m);
    }
    for (const o of order) {
      if (typeof o !== 'string') {
        out.push(...pairRows([o], depth, face));
        continue;
      }
      const bucket = buckets.get(o)!;
      const rows = pairRows(bucket, depth + 1, face);
      if (rows.length >= 2) out.push({ key: `${prefix}/du:${o}`, level: 'du', value: o, children: rows, ids: bucket.map((m) => m.id) });
      else out.push(...rows.map((r) => ({ ...r, depth })));
    }
    return out;
  };
  for (const s of SERIES_ORDER) {
    const list = bySeries.get(s);
    if (!list?.length) continue;
    const key = `series:${s}`;
    let children: (TreeNode | ListRowSheet)[];
    const hallsHere = new Set(list.map(hallOf).filter(Boolean));
    if (multiHall && hallsHere.size > 1) {
      children = [];
      const noHall = list.filter((m) => !hallOf(m));
      children.push(...pairRows(noHall, 1, face));
      const hallOrder: string[] = [];
      for (const m of list) {
        const h = hallOf(m);
        if (h && !hallOrder.includes(h)) hallOrder.push(h);
      }
      for (const h of hallOrder) {
        const hs = list.filter((m) => hallOf(m) === h);
        children.push({ key: `${key}/hall:${h}`, level: 'hall', value: h, children: duLevel(hs, `${key}/hall:${h}`, 2), ids: hs.map((m) => m.id) });
      }
    } else {
      children = duLevel(list, key, 1);
    }
    nodes.push({ key, level: 'series', value: s, children, ids: list.map((m) => m.id) });
  }
  return { nodes, multiHall };
}

/**
 * Flatten the tree into visible rows. `expanded` holds node keys the user toggled; `defaultOpen(node)` decides the rest.
 * With a search query every group is open.
 */
export function flattenTree(nodes: TreeNode[], isOpen: (key: string, level: TreeNode['level'], count: number) => boolean): ListRow[] {
  const rows: ListRow[] = [];
  const walk = (n: TreeNode, depth: number) => {
    const open = isOpen(n.key, n.level, n.ids.length);
    rows.push({ type: 'group', key: n.key, depth, level: n.level, value: n.value, count: n.ids.length, expanded: open, ids: n.ids });
    if (!open) return;
    for (const c of n.children) {
      if ('type' in c) rows.push(c);
      else walk(c, depth + 1);
    }
  };
  for (const n of nodes) walk(n, 0);
  return rows;
}

/** node keys on the path to a sheet id (to auto-expand the selection) */
export function pathTo(nodes: TreeNode[], id: string): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode): boolean => {
    if (!n.ids.includes(id)) return false;
    out.push(n.key);
    for (const c of n.children) if (!('type' in c)) walk(c);
    return true;
  };
  for (const n of nodes) if (walk(n)) break;
  return out;
}

/** default open state: series with ≤ 24 sheets, every hall node, DU nodes closed */
export function defaultOpen(level: 'series' | 'hall' | 'du', count: number): boolean {
  if (level === 'series') return count <= 24;
  return level === 'hall';
}

// ───────────── selection by id ─────────────

export interface SelectionResult {
  id: string | null;
  /** kept = same id · sibling = nearest sheet of the same group · series = nearest in the same series · first = first sheet */
  reason: 'kept' | 'sibling' | 'series' | 'first' | 'none';
}

/**
 * Keep the selection by sheet id. When the id disappears (a DU removed, a filter change), pick the nearest remaining sheet
 * of the same group (series · hall · DU), in previous-list distance order; then the nearest of the same series; then the
 * first sheet of `next`.
 */
export function resolveSelection(prev: readonly DrawingSheetMeta[], next: readonly DrawingSheetMeta[], selectedId: string | null): SelectionResult {
  if (!next.length) return { id: null, reason: 'none' };
  if (selectedId && next.some((m) => m.id === selectedId)) return { id: selectedId, reason: 'kept' };
  const pi = selectedId ? prev.findIndex((m) => m.id === selectedId) : -1;
  if (pi < 0) return { id: next[0].id, reason: selectedId ? 'first' : 'none' };
  const was = prev[pi];
  const multiHall = new Set([...prev, ...next].map(hallOf).filter(Boolean)).size > 1;
  const nextIds = new Map(next.map((m) => [m.id, m]));
  const gp = groupPath(was, multiHall);
  const series = seriesOf(was);
  const byDistance = (pred: (m: DrawingSheetMeta) => boolean): DrawingSheetMeta | undefined => {
    for (let d = 1; d < prev.length; d++) {
      for (const j of [pi - d, pi + d]) {
        const m = prev[j];
        if (m && nextIds.has(m.id) && pred(m)) return m;
      }
    }
    return undefined;
  };
  const sib = byDistance((m) => groupPath(m, multiHall) === gp) ?? next.find((m) => groupPath(m, multiHall) === gp);
  if (sib) return { id: sib.id, reason: 'sibling' };
  // same series and the same sort of sheet first (a removed DU's rack-row sheet → another DU's rack-row sheet, not the 201 type sheet)
  const like = (m: DrawingSheetMeta) => seriesOf(m) === series && m.kind === was.kind && !!duOf(m) === !!duOf(was) && !!faceOf(m) === !!faceOf(was);
  const kin = byDistance(like) ?? next.find(like);
  if (kin) return { id: kin.id, reason: 'series' };
  const ser = byDistance((m) => seriesOf(m) === series) ?? next.find((m) => seriesOf(m) === series);
  if (ser) return { id: ser.id, reason: 'series' };
  return { id: next[0].id, reason: 'first' };
}

/** neighbours to pre-build: selected first, then ±1, ±2 (within `order`, no wrap) */
export function prebuildOrder(order: readonly string[], id: string | null, n = PREBUILD_NEIGHBOURS): string[] {
  if (!id) return [];
  const i = order.indexOf(id);
  if (i < 0) return [id];
  const out = [id];
  for (let d = 1; d <= n; d++) {
    if (order[i + d]) out.push(order[i + d]);
    if (i - d >= 0) out.push(order[i - d]);
  }
  return out;
}

/** step through `order` (wraps) */
export function stepId(order: readonly string[], id: string | null, delta: number): string | null {
  if (!order.length) return null;
  const i = id ? order.indexOf(id) : -1;
  if (i < 0) return order[delta >= 0 ? 0 : order.length - 1];
  return order[(((i + delta) % order.length) + order.length) % order.length];
}

// ───────────── LRU ─────────────

export class Lru<V> {
  private map = new Map<string, V>();
  constructor(readonly size = LRU_SIZE) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  has(k: string) {
    return this.map.has(k);
  }
  set(k: string, v: V) {
    this.map.delete(k);
    this.map.set(k, v);
    while (this.map.size > this.size) this.map.delete(this.map.keys().next().value as string);
  }
  clear() {
    this.map.clear();
  }
  keys() {
    return [...this.map.keys()];
  }
}

// ───────────── remembered state (localStorage, try/catch) ─────────────

export const STORE_KEYS = {
  listW: 'aidc:drawings:listW',
  listCollapsed: 'aidc:drawings:listCollapsed',
  filters: 'aidc:drawings:filters',
  sel: 'aidc:drawings:sel',
  zoomMode: 'aidc:drawings:zoomMode',
} as const;

export function readLocal(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
export function writeLocal(key: string, value: string | null) {
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage blocked: defaults next time */
  }
}
/** parse remembered filters, dropping unknown / malformed fields */
export function parseFilters(raw: string | null): SheetFilters {
  if (!raw) return { ...DEFAULT_FILTERS };
  try {
    const o = JSON.parse(raw) as Partial<SheetFilters>;
    return {
      series: typeof o.series === 'string' && (o.series === 'all' || SERIES_ORDER.includes(o.series as SeriesId)) ? (o.series as SheetFilters['series']) : 'all',
      hall: typeof o.hall === 'string' ? o.hall : 'all',
      du: typeof o.du === 'string' ? o.du : 'all',
      face: o.face === 'F' || o.face === 'R' ? o.face : 'both',
      q: typeof o.q === 'string' ? o.q.slice(0, 80) : '',
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}
export function parseZoomMode(raw: string | null): ZoomMode {
  return raw === 'width' || raw === 'manual' ? raw : 'page';
}
export function parseListW(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(LIST_W.max, Math.max(LIST_W.min, Math.round(n))) : LIST_W.default;
}

/** the sheet kinds that have a model viewport and can open in the 2D view */
export const OPEN_IN_2D_KINDS = new Set(['plan', 'services-plan', 'enlarged-plan', 'section', 'elevation']);
