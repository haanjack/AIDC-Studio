// r4 sheet 601-Hn — row schematics (several rows per sheet): positions in floor order, role fill, LC group brackets, unoccupied spacing,
// RCU enclosure brackets (2/4), CDU slots, A/B circuit brackets, leaf-group brackets when analysis.network is cached (spec §1.1,
// r4-gap §4.7). Owner: stream B0. NTS; no viewports. The only r4 sheet that reads analysis.network.
import { findCatalogItem } from '../catalog/catalog.ts';
import { buildPowerPlane } from '../engines/powerPaths.ts';
import { detectRowGroups } from '../layout/rows.ts';
import type { CatalogItem, EquipmentInstance, Hall, Locale, Project, ProjectAnalysis, RowGroup } from '../model/types.ts';
import { CALLOUT_INK, PAPER_LW, rowLetter, rowSlots, type RowSlotInput } from './annotate.ts';
import { hallCode, stubSheetSvg, type SheetBuildResult, type SheetContext, type SheetEntry } from './context.ts';
import { tr } from './i18n.ts';
import { categoryPlanStyle, INK, INK_SOFT, LINE_LIGHT, PAPER, RACK_CATEGORIES, SYSTEM_COLOR, networkRoleSystem } from './palette.ts';
import { A1L, sheetFrame, type SheetMeta } from './sheet.ts';
import { esc, fitText, line, MONO, n, path, rect, svgDocument, text, textWidth } from './svg.ts';
import { fmtLength, drawingUnitsOf } from './units.ts';

const TITLE = { en: 'Row schematics', ko: '열 계통도' };

// ───────────────────────────── row model (pure; tested) ─────────────────────────────

export interface SchematicSlot extends RowSlotInput {
  eq: EquipmentInstance;
  item: CatalogItem | undefined;
  category: string;
  /** cooling.liquidFraction > 0.5 */
  liquid: boolean;
  /** short role code shown in the cell */
  role: string;
  fill: string;
  stroke: string;
  rcu?: string;
}

export interface SchematicRow {
  row: RowGroup;
  letter: string;
  du: string;
  slots: ReturnType<typeof rowSlots<SchematicSlot>>;
  /** [first, last] slot indices of contiguous LC racks */
  lcRuns: [number, number][];
  /** RCU enclosure groups: label + slot index range + rack count */
  rcu: { id: string; label: string; from: number; to: number; count: number }[];
  circuits: { side: 'A' | 'B'; circuit: number; from: number; to: number; racks: number; id: string }[];
  /** leaf groups (only with cached analysis.network) */
  leafGroups: { from: number; to: number; leaves: string[] }[];
  cdus: number;
}

const ROLE_CODE: Record<string, string> = { 'gpu-rack': 'GPU', 'cpu-rack': 'CPU', 'storage-rack': 'STO', 'mgmt-rack': 'MGT', cdu: 'CDU', crah: 'CRAH', 'fan-wall': 'FAN', rpp: 'RPP', ups: 'UPS', battery: 'BAT' };
const NET_CODE: Record<string, string> = { 'scale-out-leaf': 'LF', 'scale-out-spine': 'SP', 'scale-out-core': 'CR', frontend: 'FE', storage: 'SN', oob: 'OOB', mixed: 'NET', 'inter-hall-core': 'IHC' };

function duLabel(podId: string | undefined, fallback: string): string {
  if (!podId) return fallback;
  const m = /^pod-(\d+)$/.exec(podId);
  if (m) return `DU${m[1].padStart(2, '0')}`;
  if (podId.startsWith('pod-services')) return 'SV';
  return podId.replace(/^pod-/, '').toUpperCase();
}

function slotOf(e: EquipmentInstance): SchematicSlot {
  const item = findCatalogItem(e.catalogId);
  const category = item?.category ?? 'unknown';
  const isRack = RACK_CATEGORIES.has(category as never);
  const dims = item?.dims ?? { w: 0.6, d: 1.2, h: 2.3 };
  const along = e.rotationDeg % 180 === 0 ? dims.w : dims.d;
  let role = ROLE_CODE[category] ?? category.slice(0, 3).toUpperCase();
  let st = categoryPlanStyle(category as never);
  if (category === 'network-rack') {
    role = NET_CODE[e.networkRole ?? ''] ?? 'NET';
    const c = SYSTEM_COLOR[networkRoleSystem(e.networkRole)];
    st = { fill: blend(c, 0.35), stroke: INK };
  }
  if (e.meta?.computeSlot !== undefined) role = 'ACC';
  return {
    id: e.id,
    a0: 0,
    a1: along,
    kind: isRack ? 'rack' : 'unit',
    tag: e.tag,
    eq: e,
    item,
    category,
    liquid: (item?.cooling?.liquidFraction ?? 0) > 0.5,
    role,
    fill: st.fill,
    stroke: st.stroke,
    ...(typeof e.meta?.rcu === 'string' ? { rcu: e.meta.rcu } : {}),
  };
}

function blend(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return `#${[16, 8, 0].map((s) => Math.round(((v >> s) & 255) * a + 255 * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}

/** Leaf racks per compute rack from the cached endpoint → leaf cable runs (equipment ids or switch instances → their rack). */
function leafRacksByRack(project: Project, analysis: ProjectAnalysis | null): Map<string, Set<string>> | null {
  const net = analysis?.network;
  if (!net || !net.cableRuns?.length) return null;
  const eqIds = new Set(project.equipment.map((e) => e.id));
  const swRack = new Map((net.switchInstances ?? []).map((s) => [s.id, s.rackId]));
  const resolve = (id: string) => (eqIds.has(id) ? id : swRack.get(id));
  const out = new Map<string, Set<string>>();
  for (const r of net.cableRuns) {
    if (r.tier !== 'endpoint-leaf') continue;
    const from = resolve(r.fromId);
    const to = resolve(r.toId);
    if (!from || !to || from === to) continue;
    const set = out.get(from) ?? new Set<string>();
    set.add(to);
    out.set(from, set);
  }
  return out.size ? out : null;
}

/** Rows of a hall with their schematic slots, LC runs, RCU groups, circuits and (optional) leaf groups. */
export function schematicRows(project: Project, analysis: ProjectAnalysis | null, hall: Hall, opts: { powerPlane?: ReturnType<typeof buildPowerPlane> | null } = {}): SchematicRow[] {
  const eqById = new Map(project.equipment.map((e) => [e.id, e]));
  const rows = detectRowGroups(project, hall);
  const plane = opts.powerPlane === undefined ? buildPowerPlane(project, analysis) : opts.powerPlane;
  const leafMap = leafRacksByRack(project, analysis);
  const out: SchematicRow[] = [];
  for (const row of rows) {
    const members = row.memberIds.map((id) => eqById.get(id)).filter((e): e is EquipmentInstance => !!e);
    const items: SchematicSlot[] = members.map((e) => {
      const s = slotOf(e);
      const half = (s.a1 - s.a0) / 2;
      const c = row.axis === 'x' ? e.position.x : e.position.y;
      return { ...s, a0: c - half, a1: c + half };
    });
    if (!items.some((s) => s.kind === 'rack')) continue;
    const slots = rowSlots(row.id, items);
    const ss = slots.slots;
    // LC runs: contiguous liquid racks (a gap / break or a non-LC slot ends a run)
    const gapAfter = new Set(slots.gaps.map((g) => g.afterSlot));
    const lcRuns: [number, number][] = [];
    let start = -1;
    ss.forEach((s, i) => {
      const lc = s.item.kind === 'rack' && s.item.liquid;
      if (!lc) {
        if (start >= 0) lcRuns.push([start, i - 1]);
        start = -1;
        return;
      }
      if (start < 0) start = i;
      if (gapAfter.has(i) || i === ss.length - 1) {
        lcRuns.push([start, i]);
        start = -1;
      }
    });
    // RCU groups
    const rcuMap = new Map<string, number[]>();
    ss.forEach((s, i) => {
      if (!s.item.rcu) return;
      const l = rcuMap.get(s.item.rcu) ?? [];
      l.push(i);
      rcuMap.set(s.item.rcu, l);
    });
    const rcu = [...rcuMap.entries()].map(([id, idx]) => ({ id, label: id.split('-').pop() ?? id, from: Math.min(...idx), to: Math.max(...idx), count: idx.length })).sort((a, b) => a.from - b.from);
    // circuits
    const idxById = new Map(ss.map((s, i) => [s.item.id, i]));
    const circuits: SchematicRow['circuits'] = [];
    for (const c of plane?.circuits ?? []) {
      if (c.hallId !== hall.id) continue;
      const idx = c.rackIds.map((id) => idxById.get(id)).filter((v): v is number => v !== undefined);
      if (!idx.length || (c.rowId && c.rowId !== row.id)) continue;
      circuits.push({ side: c.side, circuit: c.circuit, from: Math.min(...idx), to: Math.max(...idx), racks: idx.length, id: c.id });
    }
    circuits.sort((a, b) => (a.side < b.side ? -1 : a.side > b.side ? 1 : a.from - b.from || a.circuit - b.circuit));
    // leaf groups: contiguous compute racks sharing the same leaf rack set
    const leafGroups: SchematicRow['leafGroups'] = [];
    if (leafMap) {
      let cur: { from: number; to: number; key: string; leaves: string[] } | null = null;
      ss.forEach((s, i) => {
        const set = s.item.kind === 'rack' ? leafMap.get(s.item.id) : undefined;
        const leaves = set ? [...set].map((id) => eqById.get(id)?.tag ?? id).sort() : [];
        const key = leaves.join('|');
        if (!key) {
          if (cur) leafGroups.push({ from: cur.from, to: cur.to, leaves: cur.leaves });
          cur = null;
          return;
        }
        if (cur && cur.key === key) cur.to = i;
        else {
          if (cur) leafGroups.push({ from: cur.from, to: cur.to, leaves: cur.leaves });
          cur = { from: i, to: i, key, leaves };
        }
      });
      if (cur) leafGroups.push({ from: (cur as { from: number }).from, to: (cur as { to: number }).to, leaves: (cur as { leaves: string[] }).leaves });
    }
    out.push({ row, letter: slots.letter, du: duLabel(row.podId ?? members[0]?.podId, row.kind === 'services' ? 'SV' : 'XX'), slots, lcRuns, rcu, circuits, leafGroups, cdus: ss.filter((s) => s.item.category === 'cdu').length });
  }
  return out;
}

// ───────────────────────────── layout ─────────────────────────────

const S = {
  row: { en: 'Row', ko: '열' },
  positions: { en: 'positions', ko: '자리' },
  fronts: { en: 'fronts', ko: '전면' },
  gap: { en: 'GAP', ko: '간격' },
  lc: { en: 'LC', ko: 'LC' },
  legend: { en: 'Legend', ko: '범례' },
  floorOrder: { en: 'Positions in floor order along the row axis (low → high coordinate); gaps and enclosure breaks take no number.', ko: '위치는 열 축을 따라 바닥 순서(좌표 낮은 쪽 → 높은 쪽)로 번호를 매기며 간격과 인클로저 분리 구간에는 번호가 없다.' },
  noLeaf: { en: 'Leaf-group brackets omitted: no cached network analysis.', ko: '리프 그룹 괄호 생략: 캐시된 네트워크 분석 없음.' },
  shuffle: { en: 'Shuffle boxes are not modelled.', ko: '셔플 박스는 모델링되지 않음.' },
  lcRun: { en: 'Liquid-cooled run (LC)', ko: '수랭 구간 (LC)' },
  rcu: { en: 'RCU enclosure (2 or 4 racks)', ko: 'RCU 인클로저 (랙 2 / 4대)' },
  circA: { en: 'Busway A circuit', ko: '버스웨이 A 회로' },
  circB: { en: 'Busway B circuit', ko: '버스웨이 B 회로' },
  leaf: { en: 'Leaf group (racks cabled to the same leaves)', ko: '리프 그룹 (같은 리프에 연결된 랙)' },
  midGap: { en: 'Unoccupied spacing', ko: '미점유 간격' },
  brk: { en: 'Enclosure break', ko: '인클로저 분리' },
  empty: { en: 'No rack rows in this hall.', ko: '이 홀에는 랙 열이 없습니다.' },
} as const;

const MAGENTA = '#b0006d';
const LEAF_INK = '#6a3fb0';
const LABEL_COL_W = 50;

function bandHeight(r: SchematicRow): number {
  let h = 7 /* title */ + 4.5 /* position numbers */ + 5 /* LC */ + 11 /* cells */;
  if (r.rcu.length) h += 5.5;
  if (r.circuits.some((c) => c.side === 'A')) h += 5.5;
  if (r.circuits.some((c) => c.side === 'B')) h += 5.5;
  if (r.leafGroups.length) h += 5.5;
  return h + 6;
}

/** width units of a slot: racks 1; units by footprint (0.6 m = 1); gaps 1 (mid-row) / 0.35 (break) */
function slotUnits(s: SchematicSlot): number {
  if (s.kind === 'rack') return 1;
  return Math.max(1, Math.round((s.a1 - s.a0) / 0.6));
}

function rowUnits(r: SchematicRow): number {
  let u = 0;
  for (const s of r.slots.slots) u += slotUnits(s.item);
  for (const g of r.slots.gaps) u += g.kind === 'gap' ? 1 : 0.35;
  return u;
}

interface Page {
  rows: SchematicRow[];
}

function paginate(rows: SchematicRow[], avail: number): Page[] {
  const pages: Page[] = [];
  let cur: SchematicRow[] = [];
  let h = 0;
  for (const r of rows) {
    const bh = bandHeight(r);
    if (cur.length && h + bh > avail) {
      pages.push({ rows: cur });
      cur = [];
      h = 0;
    }
    cur.push(r);
    h += bh;
  }
  if (cur.length) pages.push({ rows: cur });
  return pages;
}

const LEGEND_H = 36;
const HEADER_H = 16;

function contentAvail(ctx: SheetContext): number {
  // content area of an A1L frame: paper h − 2·margin − title band
  const probe = sheetFrame({ project: ctx.project, locale: ctx.locale, number: '601', title: '', bandTitle: '', scale: 'NTS', discipline: '', phase: '', date: '', company: '', owner: '', client: '', drawnBy: '', zones: [], sheetIndex: 1, sheetCount: 1, paper: A1L });
  return probe.content.h - HEADER_H - LEGEND_H - 8;
}

/** Row model + pages of one hall, computed once per generation (the lister and every page build share it). */
function hallSchematic(ctx: SheetContext, hall: Hall): { rows: SchematicRow[]; pages: Page[] } {
  const cache = SCHEMATIC_CACHE.get(ctx) ?? new Map<string, { rows: SchematicRow[]; pages: Page[] }>();
  SCHEMATIC_CACHE.set(ctx, cache);
  let hit = cache.get(hall.id);
  if (!hit) {
    const rows = schematicRows(ctx.project, ctx.analysis, hall);
    hit = { rows, pages: paginate(rows, contentAvail(ctx)) };
    cache.set(hall.id, hit);
  }
  return hit;
}

const SCHEMATIC_CACHE = new WeakMap<SheetContext, Map<string, { rows: SchematicRow[]; pages: Page[] }>>();

export function listRowSchematics(ctx: SheetContext): SheetEntry[] {
  const out: SheetEntry[] = [];
  for (const h of ctx.halls) {
    if (ctx.scene(h.id).racks.length === 0) continue;
    const { pages } = hallSchematic(ctx, h);
    const pageCount = Math.max(1, pages.length);
    const code = hallCode(ctx.project, h.id);
    for (let p = 0; p < pageCount; p++) {
      out.push({
        id: p === 0 ? `schematic-${h.id}` : `schematic-${h.id}-p${p + 1}`,
        number: p === 0 ? `601-${code}` : `601-${code}-${String(p + 1).padStart(2, '0')}`,
        title: `${TITLE[ctx.locale]} — ${h.name}${pageCount > 1 ? ` (${p + 1}/${pageCount})` : ''}`,
        kind: 'row-schematic' as const,
        scale: 'NTS',
        hallId: h.id,
        zones: ctx.scene(h.id).pods.map((pd) => pd.rect),
        discipline: tr(ctx.locale, 'disciplineIt'),
        paper: A1L,
        build: (meta: SheetMeta) => drawRowSchematics(ctx, h, meta, p),
      });
    }
  }
  return out;
}

function bracket(x0: number, x1: number, y: number, label: string, color: string, extra: string, size = 1.8, down = false): string {
  const t = down ? -1.6 : 1.6;
  const out = [path(`M${n(x0)} ${n(y - t)} L${n(x0)} ${n(y)} L${n(x1)} ${n(y)} L${n(x1)} ${n(y - t)}`, { stroke: color, sw: PAPER_LW.thin, extra })];
  const w = x1 - x0;
  const lbl = fitText(label, size, Math.max(w - 1, 8));
  if (textWidth(lbl, size) <= Math.max(w + 6, 10)) out.push(text((x0 + x1) / 2, y + (down ? -0.9 : 2.4), lbl, { size, anchor: 'middle', fill: color, weight: 600 }));
  return out.join('');
}

export function drawRowSchematics(ctx: SheetContext, hall: Hall, meta: SheetMeta, page = 0): string | SheetBuildResult {
  const L: Locale = ctx.locale;
  const paper = meta.paper ?? A1L;
  const frame = sheetFrame(meta);
  const c = frame.content;
  const units = drawingUnitsOf(ctx.project);
  const { rows, pages } = hallSchematic(ctx, hall);
  if (!rows.length || !pages.length) return stubSheetSvg(meta, S.empty[L]);
  const pg = pages[Math.min(page, pages.length - 1)];
  const body = [...frame.body];
  const x0 = c.x + 8;
  const cellX0 = x0 + LABEL_COL_W;
  const cellW = c.w - 16 - LABEL_COL_W;
  const maxUnits = Math.max(...pg.rows.map(rowUnits), 8);
  const u = Math.min(18, cellW / maxUnits);
  const hasLeafData = !!ctx.analysis?.network?.cableRuns?.length;

  body.push(`<g data-layer="notes">${text(x0, c.y + 9, meta.title, { size: 4.2, weight: 700, fill: INK })}${text(x0, c.y + 14.5, fitText(`${hall.name} · ${rows.length} ${L === 'ko' ? '열' : 'rows'} · NTS · ${S.floorOrder[L]}`, 2.3, c.w - 20), { size: 2.3, fill: INK_SOFT })}</g>`);

  let y = c.y + HEADER_H + 4;
  const bands: string[] = [];
  for (const r of pg.rows) {
    const ss = r.slots.slots;
    const g: string[] = [];
    // x positions per slot (and gap)
    const xs: { x0: number; x1: number }[] = [];
    let cx = cellX0;
    const gapAfter = new Map(r.slots.gaps.map((gp) => [gp.afterSlot, gp]));
    const gapX: { x: number; w: number; gap: (typeof r.slots.gaps)[number] }[] = [];
    ss.forEach((s, i) => {
      const w = slotUnits(s.item) * u;
      xs.push({ x0: cx, x1: cx + w });
      cx += w;
      const gp = gapAfter.get(i);
      if (gp) {
        const gw = (gp.kind === 'gap' ? 1 : 0.35) * u;
        gapX.push({ x: cx, w: gw, gap: gp });
        cx += gw;
      }
    });
    // title
    const positions = ss.filter((s) => s.position !== undefined).length;
    const fronts = r.row.axis === 'x' ? (r.row.frontSign > 0 ? 'N' : 'S') : r.row.frontSign > 0 ? 'E' : 'W';
    g.push(text(x0, y + 4.5, `${r.du} · ${S.row[L]} ${r.letter}`, { size: 3.2, weight: 700, fill: INK }));
    g.push(text(x0, y + 9, fitText(`${positions} ${S.positions[L]} · ${r.cdus} CDU · ${S.fronts[L]} ${fronts}`, 2.0, LABEL_COL_W - 3), { size: 2.0, fill: INK_SOFT }));
    g.push(text(x0, y + 12.6, fitText(r.row.id, 1.8, LABEL_COL_W - 3), { size: 1.8, fill: INK_SOFT, family: MONO }));
    let ly = y + 7;
    // position numbers
    const numY = ly + 3.3;
    ss.forEach((s, i) => {
      if (s.position === undefined) return;
      const label = String(s.position).padStart(2, '0');
      const w = xs[i].x1 - xs[i].x0;
      const size = Math.max(1.8, Math.min(2.2, (w - 0.4) / Math.max(0.1, textWidth(label, 1))));
      if (textWidth(label, size) > w + 0.2 && s.position % 2 === 0) return; // very narrow cells: every other number
      g.push(text((xs[i].x0 + xs[i].x1) / 2, numY, label, { size, anchor: 'middle', fill: '#b3261e', weight: 700 }));
    });
    ly += 4.5;
    // LC markers + run brackets
    for (const [a, b] of r.lcRuns) {
      const p0 = ss[a].position;
      const p1 = ss[b].position;
      const tagRun = `${String(p0 ?? 0).padStart(2, '0')}-${String(p1 ?? 0).padStart(2, '0')}`;
      const count = ss.slice(a, b + 1).filter((s) => s.item.kind === 'rack').length;
      const perCell = u >= textWidth('LC', 1.8) + 0.8;
      if (perCell) for (let i = a; i <= b; i++) g.push(text((xs[i].x0 + xs[i].x1) / 2, ly + 1.8, 'LC', { size: 1.8, anchor: 'middle', fill: '#2563d9', weight: 700 }));
      g.push(path(`M${n(xs[a].x0 + 0.3)} ${n(ly + 2.8)} L${n(xs[a].x0 + 0.3)} ${n(ly + 4)} L${n(xs[b].x1 - 0.3)} ${n(ly + 4)} L${n(xs[b].x1 - 0.3)} ${n(ly + 2.8)}`, { stroke: '#2563d9', sw: PAPER_LW.thin, extra: `data-lc-run="${tagRun}" data-lc-count="${count}"` }));
      if (!perCell) g.push(text((xs[a].x0 + xs[b].x1) / 2, ly + 2.2, `LC ×${count}`, { size: 1.8, anchor: 'middle', fill: '#2563d9', weight: 700 }));
    }
    ly += 5;
    // cells
    const cellH = 10;
    ss.forEach((s, i) => {
      const it = s.item;
      const { x0: a, x1: b } = xs[i];
      const w = b - a;
      const isCdu = it.category === 'cdu';
      const fill = isCdu ? '#9fbfc4' : it.fill;
      const stroke = isCdu ? '#2f6f78' : INK;
      const attrs = `data-slot="${i}" data-eq="${esc(it.id)}" data-role="${esc(it.role)}"${s.positionTag ? ` data-pos="${s.positionTag}"` : ''}${it.liquid ? ' data-lc="1"' : ''}`;
      g.push(rect(a, ly + (isCdu ? 1 : 0), w, cellH - (isCdu ? 2 : 0), { fill, stroke, sw: isCdu ? PAPER_LW.medium : PAPER_LW.thin, extra: attrs }));
      const size = Math.min(2.2, (w - 0.6) / Math.max(0.1, textWidth(it.role, 1)));
      if (size >= 1.8) g.push(text((a + b) / 2, ly + (s.positionTag && w >= 9 ? 4.2 : cellH / 2), it.role, { size, anchor: 'middle', baseline: 'central', fill: INK, weight: 700 }));
      if (s.positionTag && w >= 9) {
        const ts = Math.min(1.9, (w - 0.6) / Math.max(0.1, textWidth(s.positionTag, 1)));
        if (ts >= 1.8) g.push(text((a + b) / 2, ly + 7.6, s.positionTag, { size: ts, anchor: 'middle', baseline: 'central', fill: INK_SOFT, family: MONO }));
      }
    });
    // gaps
    for (const gx of gapX) {
      const after = gx.gap.afterPosition !== undefined ? String(gx.gap.afterPosition).padStart(2, '0') : '00';
      if (gx.gap.kind === 'gap') {
        const mx = gx.x + gx.w / 2;
        g.push(line(mx, ly - 6, mx, ly + cellH + 1.5, { stroke: MAGENTA, sw: PAPER_LW.medium, dash: '1.2 0.7', extra: `data-gap-after="${after}" data-gap-m="${n(gx.gap.width, 3)}"` }));
        const lbl = `${S.gap[L]} ${fmtLength(gx.gap.width, units)}`;
        if (textWidth(lbl, 1.8) <= Math.max(gx.w * 2.2, 10)) g.push(text(mx, ly + cellH + 3.6, lbl, { size: 1.8, anchor: 'middle', fill: MAGENTA, weight: 600 }));
      } else {
        g.push(line(gx.x + gx.w * 0.3, ly + 1, gx.x + gx.w * 0.3, ly + cellH - 1, { stroke: INK, sw: PAPER_LW.thin, extra: `data-break-after="${after}"` }));
        g.push(line(gx.x + gx.w * 0.7, ly + 1, gx.x + gx.w * 0.7, ly + cellH - 1, { stroke: INK, sw: PAPER_LW.thin }));
      }
    }
    ly += cellH + 1 + (gapX.some((gx) => gx.gap.kind === 'gap') ? 3.5 : 0);
    // RCU brackets
    if (r.rcu.length) {
      for (const e of r.rcu) {
        const ok = e.count === 2 || e.count === 4;
        g.push(bracket(xs[e.from].x0 + 0.3, xs[e.to].x1 - 0.3, ly + 1.4, `${e.label} ×${e.count}`, ok ? CALLOUT_INK : '#c62828', `data-rcu="${esc(e.id)}" data-rcu-count="${e.count}"`));
      }
      ly += 5.5;
    }
    // A / B circuits
    for (const side of ['A', 'B'] as const) {
      const cs = r.circuits.filter((q) => q.side === side);
      if (!cs.length) continue;
      const color = side === 'A' ? SYSTEM_COLOR['busway-a'] : SYSTEM_COLOR['busway-b'];
      g.push(text(cellX0 - 1.5, ly + 2.6, side, { size: 2.0, anchor: 'end', weight: 700, fill: color }));
      for (const q of cs) g.push(bracket(xs[q.from].x0 + 0.5, xs[q.to].x1 - 0.5, ly + 1.4, `${side} c${q.circuit} · ${q.racks}`, color, `data-circuit="${esc(q.id)}" data-side="${side}"`));
      ly += 5.5;
    }
    // leaf groups
    if (r.leafGroups.length) {
      r.leafGroups.forEach((lg, k) => {
        const short = lg.leaves.map((t) => t.replace(/^DU\d+-/, '')).join(', ');
        g.push(bracket(xs[lg.from].x0 + 0.5, xs[lg.to].x1 - 0.5, ly + 1.4, `LG${k + 1} → ${short}`, LEAF_INK, `data-leaf-group="${k + 1}"`));
      });
      ly += 5.5;
    }
    bands.push(`<g data-row="${esc(r.row.id)}">${g.join('')}</g>`);
    y += bandHeight(r);
  }
  body.push(`<g data-layer="racks">${bands.join('')}</g>`);

  // legend
  const ly0 = c.y + c.h - LEGEND_H;
  const lg: string[] = [line(c.x, ly0 - 3, c.x + c.w, ly0 - 3, { stroke: LINE_LIGHT, sw: PAPER_LW.hair }), text(x0, ly0 + 2, S.legend[L], { size: 3.0, weight: 700, fill: INK })];
  const swatches: [string, string, string][] = [
    ['GPU', categoryPlanStyle('gpu-rack').fill, tr(L, 'gpuRack')],
    ['CPU', categoryPlanStyle('cpu-rack').fill, tr(L, 'cpuRack')],
    ['STO', categoryPlanStyle('storage-rack').fill, tr(L, 'storageRack')],
    ['MGT', categoryPlanStyle('mgmt-rack').fill, tr(L, 'mgmtRack')],
    ['LF / SP', blend(SYSTEM_COLOR.trays, 0.35), `${tr(L, 'leaf')} / ${tr(L, 'spine')}`],
    ['FE', blend(SYSTEM_COLOR.frontend, 0.35), tr(L, 'frontend')],
    ['SN', blend(SYSTEM_COLOR.storage, 0.35), tr(L, 'storageNet')],
    ['OOB', blend(SYSTEM_COLOR.oob, 0.35), tr(L, 'oob')],
    ['CDU', '#9fbfc4', tr(L, 'cdu')],
  ];
  const colW = 84;
  swatches.forEach(([code, fill, label], i) => {
    const col = i % 5;
    const row = Math.floor(i / 5);
    const sx = x0 + col * colW;
    const sy = ly0 + 5 + row * 6;
    lg.push(rect(sx, sy, 10, 4.2, { fill, stroke: INK, sw: PAPER_LW.hair }));
    lg.push(text(sx + 5, sy + 2.1, code, { size: 1.8, anchor: 'middle', baseline: 'central', weight: 700, fill: INK }));
    lg.push(text(sx + 12, sy + 3.1, fitText(label, 2.0, colW - 14), { size: 2.0, fill: INK }));
  });
  const marks: [string, string][] = [
    ['#2563d9', S.lcRun[L]],
    [CALLOUT_INK, S.rcu[L]],
    [SYSTEM_COLOR['busway-a'], S.circA[L]],
    [SYSTEM_COLOR['busway-b'], S.circB[L]],
    [LEAF_INK, S.leaf[L]],
    [MAGENTA, S.midGap[L]],
  ];
  marks.forEach(([color, label], i) => {
    const sx = x0 + (i % 3) * 140;
    const sy = ly0 + 19 + Math.floor(i / 3) * 5;
    if (color === MAGENTA) lg.push(line(sx + 5, sy - 1, sx + 5, sy + 3, { stroke: MAGENTA, sw: PAPER_LW.medium, dash: '1.2 0.7' }));
    else lg.push(path(`M${n(sx)} ${n(sy)} L${n(sx)} ${n(sy + 1.6)} L${n(sx + 10)} ${n(sy + 1.6)} L${n(sx + 10)} ${n(sy)}`, { stroke: color, sw: PAPER_LW.thin }));
    lg.push(text(sx + 12, sy + 2, fitText(label, 2.0, 124), { size: 2.0, fill: INK }));
  });
  const notes = [S.shuffle[L], ...(hasLeafData ? [] : [S.noLeaf[L]])];
  notes.forEach((t, i) => lg.push(text(x0 + 430, ly0 + 7 + i * 4, fitText(t, 2.0, c.w - 450), { size: 2.0, italic: true, fill: INK_SOFT })));
  body.push(`<g data-layer="notes">${lg.join('')}</g>`);
  return { svg: svgDocument(paper.w, paper.h, frame.defs, body, `${meta.number} ${meta.title}`) };
}
