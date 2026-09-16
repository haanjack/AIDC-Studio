import { rackStandardLine } from '../docs/standardsBasis.ts';
import type { DrawingSheet, Project, ProjectAnalysis, Rect } from '../model/types.ts';
import { buildRackContents, rackRowGroups } from '../deploy/rackElevationsData.ts';
import { drawRowBand, drawRowFooter, drawRowKeyPlan, groupTitle, layoutRow, rackElevationStrings, rackSheetNumber, type RackFace } from './rackElevations.ts';
import { drawElevation, elevationGroups } from './elevation.ts';
import { tr } from './i18n.ts';
import { drawPlan, drawPlanUpgrade, planViewports } from './plan.ts';
import { A1, A1L, pickScale, sheetFrame, type SheetMeta } from './sheet.ts';
import { svgDocument, text } from './svg.ts';
import { drawSystems } from './systems.ts';
import { INK_SOFT } from './palette.ts';
import { createSheetContext, sheetBaseMeta, type DrawingOptions, type DrawingSheetKey, type DrawingSheetMeta, type SheetContext, type SheetEntry, type SheetLister } from './context.ts';
// r4 sheet owners (one lister per file; see docs/research/contract-r4.md)
import { listIndexSheets } from './indexSheet.ts';
import { listSiteKeySheets } from './siteKey.ts';
import { listServicesPlans } from './services.ts';
import { drawEnlargedPlan, listEnlargedPlans, partLetter, splitPlanWindow, windowedPlanArea } from './enlarged.ts';
import { listSections } from './section.ts';
import { listContainmentElevations } from './containmentElevation.ts';
import { listMepIsos } from './mepIso.ts';
import { listRowSchematics } from './schematic.ts';
import { listOneLineSheets } from './oneLineSheet.ts';

/**
 * Drawing sheets (stream S5, DECISIONS-v2 "도면"): printable A1 SVG sheets generated from the project model —
 *   100-series  floor & rack plan blueprint per hall (grid bubbles, rack tags, containment, CRAH / CDU, trays,
 *               busways, dimension chains, north arrow, scale bar, legend)
 *   200-series  rack elevations (U-maps) per rack type
 *   400-series  exploded-layer isometric systems sheet per hall (ceiling plenum / overhead / floor / underfloor)
 *               with the systems legend × construction-phase matrix and the BIM-style title-block column.
 * r4 (docs/research/r4-2d-drawings-spec.md) adds opt-in kinds through a registry: 001 index · 002 site key · 111 services ·
 * 121 enlarged DU · 301/302 sections · 311 aisle-end elevation · 411 MEP iso · 601 row schematics · 611 one-line, plus the
 * 101 'plan-upgrade' layers. `listDrawings` returns metadata only; `buildDrawing(id)` builds one sheet (lazy panel / worker).
 * Pure string generation — engine-neutral, deterministic (no Date.now(); the date comes from the options or
 * project.updatedAt). Text follows project.locale ('en' default / 'ko').
 */

export type { DrawingOptions, DrawingSheetKey, DrawingSheetMeta, SheetBuildResult, SheetContext, SheetEntry, SheetLister } from './context.ts';
export { DEFAULT_DRAWING_SHEETS, createSheetContext, hallCode, sheetBaseMeta, stubSheetSvg, viewportPaperToWorld, viewportWorldToPaper } from './context.ts';
// r4 hand-offs B → C (units, keynotes, annotation grammar, DrawList → SVG)
export * from './units.ts';
export * from './keynotes.ts';
export * from './annotate.ts';
export * from './toSvg.ts';

export type { HallScene } from './scene.ts';
export { buildHallScene } from './scene.ts';
export { phaseMatrix, type PhaseMatrix, type PhaseState } from './sheet.ts';
export { rackUMap, type UMap, type UBlock } from './elevation.ts';
export { isoPoint, IsoScene } from './iso.ts';
export { drawRowBand, drawRowFooter, drawRowKeyPlan, groupTitle, layoutRow, rackElevationStrings, rackSheetNumber, STATUS_COLOR, SLOT_COLOR, ELEV_SCALES, type RackFace, type BandLayout } from './rackElevations.ts';
export { SYSTEMS, SYSTEM_COLOR, type SystemId } from './palette.ts';

/** Every sheet key of the r4 round (the Drawings panel, ZIP and deploy bundle request these explicitly). */
export const R4_DRAWING_SHEETS: readonly DrawingSheetKey[] = ['index', 'site', 'plan', 'plan-upgrade', 'services-plan', 'enlarged-plan', 'rack-elevation', 'section', 'elevation', 'iso-systems', 'mep-iso', 'row-schematic', 'one-line'];

// ───────────── existing sheets (unchanged output) ─────────────

// 100 — plans
const listPlans: SheetLister = (ctx) => {
  const { project, locale: L } = ctx;
  return ctx.halls.map((h, i): SheetEntry => {
    const scene = ctx.scene(h.id);
    return {
      id: `plan-${h.id}`,
      number: String(101 + i),
      title: `${tr(L, 'planTitle')} — ${h.name}`,
      kind: 'plan',
      scale: '',
      hallId: h.id,
      zones: scene.pods.map((p) => p.rect),
      discipline: tr(L, 'disciplineArch'),
      ...(planPaper(ctx, h) === A1L ? { paper: A1L } : {}),
      build: (meta) => {
        const frame = sheetFrame(meta);
        const defs: string[] = [...frame.defs];
        const plan = drawPlan(project, scene, frame.content, L, defs);
        const paper = meta.paper ?? A1;
        meta.scale = plan.scale;
        const frame2 = sheetFrame(meta);
        const viewports = planViewports(scene, plan, frame.content);
        const body = [...frame2.body, plan.svg];
        if (ctx.wanted.has('plan-upgrade')) {
          const up = drawPlanUpgrade(ctx, scene, plan, frame.content, defs);
          body.push(up.svg);
          return { svg: svgDocument(paper.w, paper.h, defs, body, `${meta.number} ${meta.title}`), viewports: up.viewports ?? viewports };
        }
        return { svg: svgDocument(paper.w, paper.h, defs, body, `${meta.number} ${meta.title}`), viewports };
      },
    };
  }).flatMap((entry, i) => [entry, ...hallPlanParts(ctx, ctx.halls[i], entry.number)]);
};

/** plan paddings of drawPlan (left + right, top + bottom, mm) */
const PLAN_PAD = { w: 26 + 44, h: 16 + 66 };

/** Best 1:n of a hall plan on a paper (drawPlan's scale rule). */
function planScaleOn(ctx: SheetContext, hall: import('../model/types.ts').Hall, paper: { w: number; h: number }): number {
  const c = sheetFrame({ ...sheetBaseMeta(ctx), number: '101', title: '', scale: '', discipline: '', zones: [], sheetIndex: 1, sheetCount: 1, paper }).content;
  return pickScale(hall.width + 1, hall.depth + 1, c.w - PLAN_PAD.w, c.h - PLAN_PAD.h).ratio;
}

/**
 * backlog T2 #4: hall plans keep A1 portrait unless it would be coarser than 1:150 and A1 landscape gives a finer scale (a long hall was a
 * thin strip on portrait). Halls still coarser than 1:250 on the chosen paper also get split continuation sheets (hallPlanParts).
 */
export function planPaper(ctx: SheetContext, hall: import('../model/types.ts').Hall): { w: number; h: number } {
  const p = planScaleOn(ctx, hall, A1);
  if (p <= 150) return A1;
  return planScaleOn(ctx, hall, A1L) < p ? A1L : A1;
}

/** Continuation sheets <101>-a/-b/… of a hall plan coarser than 1:250: 1:200 windows along the long axis, joined by match lines. */
function hallPlanParts(ctx: SheetContext, hall: import('../model/types.ts').Hall | undefined, number: string): SheetEntry[] {
  if (!hall) return [];
  const scene = ctx.scene(hall.id);
  if (!scene.items.length || planScaleOn(ctx, hall, planPaper(ctx, hall)) <= 250) return [];
  const wins = splitPlanWindow({ x: -0.6, y: -0.6, w: hall.width + 1.2, d: hall.depth + 1.2 }, windowedPlanArea(ctx), 200);
  if (wins.length < 2) return [];
  const numbers = wins.map((_, k) => `${number}-${partLetter(k)}`);
  const L = ctx.locale;
  const all = { id: `hall-${hall.id}`, name: hall.name, rect: { x: 0, y: 0, w: hall.width, d: hall.depth }, rows: scene.rows, rackCount: scene.racks.length, gpuCount: scene.gpuCount };
  return wins.map((w, k) => ({
    id: `plan-${hall.id}-part-${partLetter(k)}`,
    number: numbers[k],
    title: `${tr(L, 'planTitle')} — ${hall.name} (${k + 1}/${wins.length})`,
    kind: 'plan' as const,
    scale: '1:200',
    hallId: hall.id,
    zones: [w],
    discipline: tr(L, 'disciplineArch'),
    paper: A1L,
    build: (meta: SheetMeta) => drawEnlargedPlan(ctx, hall, all, meta, { windows: wins, index: k, numbers, hallWide: true, title: `${tr(L, 'planTitle')} — ${hall.name} · ${numbers[k]} (${k + 1}/${wins.length})` }),
  }));
}

// 200 — rack elevations (all halls; grouped by rack type / switch signature)
const listRackTypeElevations: SheetLister = (ctx) => {
  const { project, analysis, locale: L } = ctx;
  const scenes = ctx.halls.map((h) => ctx.scene(h.id));
  const groups = elevationGroups(scenes, analysis, L, project.network.scaleOut.leafPlacement === 'tor');
  if (!groups.length) return [];
  // paginate into the content area
  const probe = sheetFrame({ ...sheetBaseMeta(ctx), number: '201', title: '', scale: '1:20', discipline: '', zones: [], sheetIndex: 1, sheetCount: 1 });
  const area = probe.content;
  const pages: (typeof groups)[] = [];
  let cur: typeof groups = [];
  let x = area.x + 6;
  let y = area.y + 10;
  let rowH = 0;
  for (const g of groups) {
    const cell = drawElevation(0, 0, g, L);
    if (x + cell.w > area.x + area.w - 4) {
      x = area.x + 6;
      y += rowH + 8;
      rowH = 0;
    }
    if (y + cell.h > area.y + area.h - 10) {
      pages.push(cur);
      cur = [];
      x = area.x + 6;
      y = area.y + 10;
      rowH = 0;
    }
    cur.push(g);
    x += cell.w + 6;
    rowH = Math.max(rowH, cell.h);
  }
  if (cur.length) pages.push(cur);
  return pages.map((page, pi) => ({
    id: `elev-${pi + 1}`,
    number: String(201 + pi),
    title: `${tr(L, 'elevationTitle')}${pages.length > 1 ? ` (${pi + 1}/${pages.length})` : ''}`,
    kind: 'rack-elevation',
    scale: '1:20',
    zones: [],
    discipline: tr(L, 'disciplineIt'),
    build: (meta) => {
      const frame = sheetFrame(meta);
      const out: string[] = [...frame.body];
      let cx = frame.content.x + 6;
      let cy = frame.content.y + 10;
      let rh = 0;
      for (const g of page) {
        const probeCell = drawElevation(0, 0, g, L);
        if (cx + probeCell.w > frame.content.x + frame.content.w - 4) {
          cx = frame.content.x + 6;
          cy += rh + 8;
          rh = 0;
        }
        const cell = drawElevation(cx, cy, g, L);
        out.push(cell.svg);
        cx += cell.w + 6;
        rh = Math.max(rh, cell.h);
      }
      out.push(text(frame.content.x + 6, frame.content.y + frame.content.h - 5, `${groups.length} ${tr(L, 'rackType')} · ${scenes.reduce((s, sc) => s + sc.racks.length, 0)} ${tr(L, 'racks')} · ${L === 'ko' ? 'U-map은 계획용 추정치 (카탈로그 · 네트워크 분석 기반)' : 'U-maps are planning estimates from the catalog and the network placement analysis'}`, { size: 2.2, fill: INK_SOFT }));
      return svgDocument(A1.w, A1.h, frame.defs, out, `${meta.number} ${meta.title}`);
    },
  }));
};

// 2-DUnn-<row>-F/R — per-DU rack row elevations (area D2): one A1-landscape sheet per row group, segment and face.
// The 201 per-rack-type sheet above stays as the rack-type catalogue ("2-TYP") reference sheet.
const listRackRowElevations: SheetLister = (ctx) => {
  const { project, analysis, opts, locale: L } = ctx;
  if (opts.rackRows === undefined || opts.rackRows === 'none') return [];
  const S = rackElevationStrings(L);
  const contents = buildRackContents(project, analysis, { hallId: opts.hallId, thermal: opts.thermal, cableSchedule: opts.cableSchedule });
  const filter = Array.isArray(opts.rackRows) ? new Set(opts.rackRows) : null;
  const groups = rackRowGroups(contents, project).filter((g) => !filter || filter.has(g.du) || filter.has(g.key));
  const multiHall = ctx.multiHall; // hall prefix only when several halls hold equipment
  const probe = sheetFrame({ ...sheetBaseMeta(ctx), number: '2-X', title: '', scale: '', discipline: '', zones: [], sheetIndex: 1, sheetCount: 1, paper: A1L });
  const area = probe.content;
  const out: SheetEntry[] = [];
  let seq = 0;
  for (const g of groups) {
    const lay = layoutRow(g, area.w - 16);
    const scene = ctx.halls.some((h) => h.id === g.hallId) ? ctx.scene(g.hallId) : undefined;
    const zones = ((scene?.pods ?? []) as { id?: string; rect: Rect }[]).filter((p) => g.podId && p.id === g.podId).map((p) => p.rect);
    lay.segments.forEach((seg, si) => {
      for (const face of ['front', 'rear'] as RackFace[]) {
        const k = seq++;
        const number = rackSheetNumber(g, face, si + 1, lay.segments.length, multiHall);
        out.push({
          id: `relev-${number.slice(2).toLowerCase()}`,
          number,
          title: `${S.title} — ${groupTitle(g, L)} (${face === 'front' ? S.front : S.rear})${lay.segments.length > 1 ? ` ${si + 1}/${lay.segments.length}` : ''}`,
          kind: 'rack-elevation',
          scale: `1:${lay.den}`,
          hallId: g.hallId,
          zones,
          discipline: tr(L, 'disciplineIt'),
          paper: A1L,
          group: { hallId: g.hallId, zone: g.zone, groupKey: g.key, ...(g.podId ? { podId: g.podId } : {}), rowId: g.racks[0]?.rack.rowId ?? g.racks[0]?.rack.rowKey, face },
          build: (meta) => {
            const frame = sheetFrame(meta);
            const c = frame.content;
            const body = [...frame.body];
            const defs = [...frame.defs];
            body.push(text(c.x + 8, c.y + 8, `${face === 'front' ? S.front : S.rear} — ${groupTitle(g, L)} · ${g.hallName}`, { size: 4.2, weight: 700 }));
            body.push(text(c.x + 8, c.y + 13.5, `${face === 'front' ? S.frontView : S.rearView} · 1:${lay.den} · ${seg.length} / ${g.racks.length}${lay.segments.length > 1 ? ` · ${S.segment} ${si + 1}/${lay.segments.length}` : ''}`, { size: 2.4, fill: INK_SOFT }));
            if (si < lay.segments.length - 1) body.push(text(c.x + 8, c.y + 18, `${S.continued} ${rackSheetNumber(g, face, si + 2, lay.segments.length, multiHall)}`, { size: 2.2, fill: INK_SOFT, italic: true }));
            // stream E (P5, proposal §6.3): "Rack standard: <title version> · pitch 48 mm OU" — only with a standards profile
            const stdLine = rackStandardLine(project, g.hallId, L);
            if (stdLine) body.push(text(c.x + 8, c.y + 22.5, stdLine, { size: 2.2, fill: INK_SOFT }));
            body.push(drawRowKeyPlan(project, g, face, c.x + c.w - 72, c.y + 2, 64, 40, L));
            const band = drawRowBand(seg, c.x + 8, c.y + 46, { idPrefix: `rb${k}`, locale: L, face, mmPerM: lay.mmPerM, pitch: lay.pitch });
            defs.push(...band.defs);
            body.push(band.svg);
            const fy = c.y + 46 + band.h + 8;
            body.push(drawRowFooter(seg, g, face, c.x + 8, fy, c.w - 16, c.y + c.h - fy - 4, L, `rb${k}-blank`));
            return svgDocument(A1L.w, A1L.h, defs, body, `${meta.number} ${meta.title}`);
          },
        });
      }
    });
  }
  return out;
};

// 400 — systems iso (halls with equipment)
const listIsoSystems: SheetLister = (ctx) => {
  const { project, locale: L } = ctx;
  const out: SheetEntry[] = [];
  let k = 0;
  for (const h of ctx.halls) {
    const scene = ctx.scene(h.id);
    if (!scene.items.length) continue;
    out.push({
      id: `iso-${h.id}`,
      number: String(401 + k++),
      title: `${tr(L, 'isoTitle')} — ${h.name}`,
      kind: 'iso-systems',
      scale: '',
      hallId: h.id,
      zones: scene.pods.map((p) => p.rect),
      discipline: tr(L, 'disciplineMech'),
      build: (meta) => {
        const frame = sheetFrame(meta);
        const sys = drawSystems(project, scene, frame.content, L);
        meta.scale = sys.scale;
        const frame2 = sheetFrame(meta);
        return svgDocument(A1.w, A1.h, frame2.defs, [...frame2.body, sys.svg], `${meta.number} ${meta.title}`);
      },
    });
  }
  return out;
};

// ───────────── registry (integrator-owned; sheet order = series order) ─────────────

export interface DrawingRegistryEntry {
  key: DrawingSheetKey;
  list: SheetLister;
}

export const DRAWING_REGISTRY: readonly DrawingRegistryEntry[] = [
  { key: 'index', list: listIndexSheets }, // 001 (B0)
  { key: 'site', list: listSiteKeySheets }, // 002 (B1)
  { key: 'plan', list: listPlans }, // 101+ (+ 'plan-upgrade' hook in plan.ts, B1)
  { key: 'services-plan', list: listServicesPlans }, // 111+ (B1)
  { key: 'enlarged-plan', list: listEnlargedPlans }, // 121-DUnn (B1)
  { key: 'rack-elevation', list: listRackTypeElevations }, // 201+
  { key: 'rack-elevation', list: listRackRowElevations }, // 2-DUnn-<row>-F/R
  { key: 'section', list: listSections }, // 301 / 302 (B2)
  { key: 'elevation', list: listContainmentElevations }, // 311 (B2)
  { key: 'iso-systems', list: listIsoSystems }, // 401+
  { key: 'mep-iso', list: listMepIsos }, // 411-DUnn (B2)
  { key: 'row-schematic', list: listRowSchematics }, // 601 (B0)
  { key: 'one-line', list: listOneLineSheets }, // 611 (B1)
];

function enumerateSheets(ctx: SheetContext): SheetEntry[] {
  const entries = DRAWING_REGISTRY.filter((r) => ctx.wanted.has(r.key) || (r.key === 'plan' && ctx.wanted.has('plan-upgrade'))).flatMap((r) => r.list(ctx));
  ctx.sheetList = entries.map((e) => ({
    id: e.id,
    number: e.number,
    title: e.title,
    kind: e.kind,
    scale: e.scale || '—',
    paper: e.paper ?? A1,
    ...(e.hallId ? { hallId: e.hallId } : {}),
    ...(e.group ? { group: e.group } : {}),
    ...(e.needsAnalysis ? { needsAnalysis: true } : {}),
  }));
  return entries;
}

function buildEntry(ctx: SheetContext, entries: readonly SheetEntry[], i: number): DrawingSheet {
  const p = entries[i];
  const meta: SheetMeta = {
    ...sheetBaseMeta(ctx),
    number: p.number,
    title: p.title,
    scale: p.scale || '—',
    discipline: p.discipline,
    hall: p.hallId ? ctx.project.halls.find((h) => h.id === p.hallId) : undefined,
    zones: p.zones,
    sheetIndex: i + 1,
    sheetCount: entries.length,
    ...(p.paper ? { paper: p.paper } : {}),
  };
  const built = p.build(meta);
  const svg = typeof built === 'string' ? built : built.svg;
  const viewports = typeof built === 'string' ? undefined : built.viewports;
  return {
    id: p.id,
    number: p.number,
    title: p.title,
    kind: p.kind,
    svg,
    scale: meta.scale,
    ...(p.group ? { group: p.group } : {}),
    paper: p.paper ?? A1,
    ...(viewports?.length ? { viewports } : {}),
  };
}

export function generateDrawings(project: Project, analysis: ProjectAnalysis | null, opts: DrawingOptions = {}): DrawingSheet[] {
  const ctx = createSheetContext(project, analysis, opts);
  const entries = enumerateSheets(ctx);
  return entries.map((_, i) => buildEntry(ctx, entries, i));
}

/** Sheet metadata without building any SVG (same ids and order as generateDrawings with the same options). */
export function listDrawings(project: Project, analysis: ProjectAnalysis | null, opts: DrawingOptions = {}): DrawingSheetMeta[] {
  const ctx = createSheetContext(project, analysis, opts);
  enumerateSheets(ctx);
  return ctx.sheetList;
}

/** Build one sheet by id (byte-identical to the same sheet in generateDrawings with the same options). Throws on an unknown id. */
export function buildDrawing(project: Project, analysis: ProjectAnalysis | null, id: string, opts: DrawingOptions = {}): DrawingSheet {
  return openDrawingSet(project, analysis, opts).build(id);
}

/** List once, build many (worker LRU): enumeration and scene caches are shared between builds. */
export function openDrawingSet(project: Project, analysis: ProjectAnalysis | null, opts: DrawingOptions = {}): { sheets: DrawingSheetMeta[]; build(id: string): DrawingSheet } {
  const ctx = createSheetContext(project, analysis, opts);
  const entries = enumerateSheets(ctx);
  return {
    sheets: ctx.sheetList,
    build(id: string) {
      const i = entries.findIndex((e) => e.id === id);
      if (i < 0) throw new Error(`drawings: no sheet '${id}'`);
      return buildEntry(ctx, entries, i);
    },
  };
}

/** file name for a sheet inside an export bundle */
export function sheetFileName(sheet: DrawingSheet): string {
  const slug = sheet.title
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
  return `${sheet.number}-${slug || sheet.kind}.svg`;
}

/** Folder-aware file name: per-DU rack row sheets go to 200-rack-elevations/<DU>/<number>.svg (multi-hall: <H#>/<DU>/). */
export function rackElevationFileName(sheet: DrawingSheet): string {
  // integration r4: 121 / 301 / 302 / 411 sheets carry a DU group too — only rack-row sheets go under 200-rack-elevations/<DU>/
  if (sheet.kind !== 'rack-elevation' || !sheet.group || sheet.group.zone === 'type') return sheetFileName(sheet);
  const parts = sheet.number.split('-');
  const folder = parts.slice(1, Math.max(2, parts.length - 2)).join('/');
  return `200-rack-elevations/${folder}/${sheet.number}.svg`;
}
