// r4 contract (integrator-owned): the sheet registry types shared by drawings/index.ts and every sheet owner file.
// Each owner file exports one `list…(ctx): SheetEntry[]` (metadata + lazy build closure); drawings/index.ts only orders them.
import type { CableScheduleRow, DrawingSheet, DrawingSheetKind, DrawingViewport, Hall, Locale, Project, ProjectAnalysis, Rect, ThermalSnapshot } from '../model/types.ts';
import { buildHallPrims } from '../scene/build.ts';
import type { HallPrims } from '../scene/prims.ts';
import { fmtDate, tr } from './i18n.ts';
import { INK_SOFT } from './palette.ts';
import { buildHallScene, type HallScene } from './scene.ts';
import { A1, sheetFrame, type SheetMeta } from './sheet.ts';
import { svgDocument, text } from './svg.ts';

export interface DrawingOptions {
  locale?: Locale;
  hallId?: string;
  /** title-block fields */
  company?: string;
  client?: string;
  author?: string;
  date?: string;
  /**
   * subset of sheet keys to generate. Default DEFAULT_DRAWING_SHEETS ('plan', 'rack-elevation', 'iso-systems' — byte-identical to
   * the pre-r4 output). r4 kinds are opt-in: R4_DRAWING_SHEETS lists every key of this round; 'plan-upgrade' adds the r4 layers
   * to the 101 plans (and implies 'plan').
   */
  sheets?: DrawingSheetKey[];
  /** D2: CFD-lite snapshots for the inlet sensor badges (default project.thermalSnapshots) */
  thermal?: ThermalSnapshot[] | null;
  /** D2: cable-schedule rows for port / cable counts on the rack elevation sheets (default: none) */
  cableSchedule?: CableScheduleRow[];
  /** D2: per-DU rack row sheets (opt-in) — 'all', 'none' (default when omitted), or DU labels / row-group keys (DU01, SV, NC, XX …) */
  rackRows?: 'all' | 'none' | string[];
}

/** A sheet kind, or 'plan-upgrade' (the r4 layers on the existing 101 plans). */
export type DrawingSheetKey = DrawingSheetKind | 'plan-upgrade';

/** Default sheet keys (pre-r4 output, unchanged). */
export const DEFAULT_DRAWING_SHEETS: readonly DrawingSheetKey[] = ['plan', 'rack-elevation', 'iso-systems'];

/** Metadata of one sheet without its SVG (listDrawings). */
export interface DrawingSheetMeta {
  id: string;
  number: string;
  title: string;
  kind: DrawingSheetKind;
  /** '—' until built when the scale is picked at build time (fit-to-paper plans) */
  scale: string;
  paper: { w: number; h: number };
  hallId?: string;
  group?: DrawingSheet['group'];
  /** the sheet is richer with a ProjectAnalysis (it still builds with null) */
  needsAnalysis?: boolean;
}

export interface SheetBuildResult {
  svg: string;
  viewports?: DrawingViewport[];
}

/** One listed sheet: metadata + a lazy build closure. `build` may set `meta.scale` (read back after the call). */
export interface SheetEntry {
  id: string;
  number: string;
  title: string;
  kind: DrawingSheetKind;
  scale: string;
  build: (meta: SheetMeta) => string | SheetBuildResult;
  hallId?: string;
  zones: Rect[];
  discipline: string;
  /** default A1 portrait */
  paper?: { w: number; h: number };
  group?: DrawingSheet['group'];
  needsAnalysis?: boolean;
}

export interface SheetContext {
  project: Project;
  analysis: ProjectAnalysis | null;
  opts: DrawingOptions;
  locale: Locale;
  /** halls in scope (opts.hallId filter applied), project order */
  halls: Hall[];
  /** requested sheet keys */
  wanted: ReadonlySet<DrawingSheetKey>;
  date: string;
  wavesText: string;
  /** several halls hold equipment → sheet numbers carry a hall prefix */
  multiHall: boolean;
  /** cached drawings/scene.ts HallScene (any project hall) */
  scene(hallId: string): HallScene;
  /** cached scene/build.ts HallPrims */
  hallPrims(hallId: string, detail?: HallPrims['detail']): HallPrims;
  /** metadata of every sheet of this generation, in order (filled before any build closure runs) */
  sheetList: DrawingSheetMeta[];
}

export type SheetLister = (ctx: SheetContext) => SheetEntry[];

export function createSheetContext(project: Project, analysis: ProjectAnalysis | null, opts: DrawingOptions = {}): SheetContext {
  const locale: Locale = opts.locale ?? project.locale ?? 'en';
  const wanted = new Set<DrawingSheetKey>(opts.sheets ?? DEFAULT_DRAWING_SHEETS);
  const halls = opts.hallId ? project.halls.filter((h) => h.id === opts.hallId) : project.halls;
  const date = fmtDate(opts.date ?? project.updatedAt ?? project.createdAt, locale);
  const waves = project.schedule.waves;
  const wavesText = waves.length ? (waves.length === 1 ? waves[0].name : `${waves[0].name} – ${waves[waves.length - 1].name}`) : tr(locale, 'allWaves');
  const scenes = new Map<string, HallScene>();
  const prims = new Map<string, HallPrims>();
  const hallPrimsOf = (hallId: string, detail: HallPrims['detail'] = 'hall'): HallPrims => {
    const key = `${hallId}|${detail}`;
    let hp = prims.get(key);
    if (!hp) {
      hp = buildHallPrims(project, analysis, { hallId, detail });
      prims.set(key, hp);
    }
    return hp;
  };
  return {
    project,
    analysis,
    opts,
    locale,
    halls,
    wanted,
    date,
    wavesText,
    multiHall: new Set(project.equipment.map((e) => e.hallId)).size > 1,
    scene(hallId) {
      let s = scenes.get(hallId);
      if (!s) {
        const hall = project.halls.find((h) => h.id === hallId);
        if (!hall) throw new Error(`drawings: unknown hall '${hallId}'`);
        s = buildHallScene(project, hall, hallPrimsOf(hallId, 'hall'));
        scenes.set(hallId, s);
      }
      return s;
    },
    hallPrims: hallPrimsOf,
    sheetList: [],
  };
}

/** Title-block fields shared by every sheet of a generation. */
export function sheetBaseMeta(ctx: SheetContext): Omit<SheetMeta, 'number' | 'title' | 'scale' | 'discipline' | 'zones' | 'sheetIndex' | 'sheetCount' | 'hall'> {
  const { project, locale: L, opts } = ctx;
  return {
    project,
    locale: L,
    bandTitle: tr(L, 'systemsTitle'),
    phase: ctx.wavesText,
    date: ctx.date,
    company: opts.company ?? 'AIDC Studio',
    owner: opts.author ?? project.author ?? '—',
    client: opts.client ?? project.client ?? '—',
    drawnBy: 'AIDC Studio',
  };
}

/** 'H1', 'H2' … by position in project.halls (stable under the opts.hallId filter). */
export function hallCode(project: Project, hallId: string): string {
  return `H${project.halls.findIndex((h) => h.id === hallId) + 1}`;
}

export const pad2 = (v: number) => String(v).padStart(2, '0');

/** id-safe slug */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'x';

/** A valid, framed, empty sheet (stub builders). */
export function stubSheetSvg(meta: SheetMeta, note?: string): string {
  const frame = sheetFrame(meta);
  const c = frame.content;
  const paper = meta.paper ?? A1;
  const msg = note ?? (meta.locale === 'ko' ? '시트 내용 준비 중' : 'Sheet content pending');
  const body = [...frame.body, `<g data-layer="stub">${text(c.x + c.w / 2, c.y + c.h / 2, msg, { size: 5, anchor: 'middle', fill: INK_SOFT })}</g>`];
  return svgDocument(paper.w, paper.h, frame.defs, body, `${meta.number} ${meta.title}`);
}

/** World (plan x, y — or section u, z) → paper mm (DrawingViewport convention, model/types.ts). */
export function viewportWorldToPaper(vp: DrawingViewport, wx: number, wy: number): [number, number] {
  const w = vp.worldRect ?? { x: 0, y: 0, w: vp.paperRect.w / vp.mmPerM, d: vp.paperRect.h / vp.mmPerM };
  return [vp.paperRect.x + (wx - w.x) * vp.mmPerM, vp.paperRect.y + vp.paperRect.h - (wy - w.y) * vp.mmPerM];
}

/** Paper mm → world (inverse of viewportWorldToPaper). */
export function viewportPaperToWorld(vp: DrawingViewport, px: number, py: number): [number, number] {
  const w = vp.worldRect ?? { x: 0, y: 0, w: vp.paperRect.w / vp.mmPerM, d: vp.paperRect.h / vp.mmPerM };
  return [w.x + (px - vp.paperRect.x) / vp.mmPerM, w.y + (vp.paperRect.y + vp.paperRect.h - py) / vp.mmPerM];
}
