// r4 stream D — drawing sheet jobs shared by workers/drawings.worker.ts and the inline fallback (no module worker):
// list every registered sheet kind of this round once per project generation (`openDrawingSet`), build sheets by id,
// ZIP a filtered id set with progress. The worker owns its own core instance, so it activates the project catalog.
import JSZip from 'jszip';
import {
  buildCableSchedule, openDrawingSet, R4_DRAWING_SHEETS, rackElevationFileName, resolveCatalog, setActiveCatalog,
  type CatalogLibrary, type DrawingOptions, type DrawingSheet, type DrawingSheetMeta, type Project, type ProjectAnalysis,
} from '@aidc/core';

export interface SheetsOpenInput {
  /** generation stamp: a new key per (project, analysis) identity */
  key: string;
  project: Project;
  analysis: ProjectAnalysis | null;
  library?: CatalogLibrary | null;
}

export type DrawingsWorkerRequest =
  | ({ type: 'open' } & SheetsOpenInput)
  | { type: 'want'; key: string; ids: string[] }
  | { type: 'zip'; key: string; jobId: number; ids: string[]; projectId: string; projectName: string }
  | { type: 'cancel-zip'; jobId: number };

export type DrawingsWorkerResponse =
  | { type: 'list'; key: string; sheets: DrawingSheetMeta[]; ms: number }
  | { type: 'list-error'; key: string; message: string }
  | { type: 'sheet'; key: string; id: string; sheet: DrawingSheet; ms: number }
  | { type: 'sheet-error'; key: string; id: string; message: string }
  | { type: 'zip-progress'; jobId: number; done: number; total: number }
  | { type: 'zip'; jobId: number; blob: Blob; files: number }
  | { type: 'zip-error'; jobId: number; message: string };

/** every sheet kind of this round (new kinds fill in as their streams land); per-DU rack rows for all DUs — listing is metadata only */
export function drawingOptions(project: Project): DrawingOptions {
  return {
    locale: project.locale ?? 'en',
    sheets: [...R4_DRAWING_SHEETS],
    rackRows: 'all',
    thermal: project.thermalSnapshots ?? null,
  };
}

/** per-DU rack row sheets are the only consumer of the cable schedule (switch ports drawn filled when cabled, QA rack-elevations M4) */
const needsCableSchedule = (m: DrawingSheetMeta | undefined) => !!m && m.kind === 'rack-elevation' && !!m.group && m.group.zone !== 'type';

interface Session {
  key: string;
  project: Project;
  analysis: ProjectAnalysis | null;
  /** listed without the cable schedule (the schedule costs far more than the listing on large projects) */
  set: ReturnType<typeof openDrawingSet>;
  /** opened on the first rack-row build, with the cable schedule; same ids (checked, falls back to `set`) */
  cabled?: ReturnType<typeof openDrawingSet>;
}
let session: Session | null = null;

export function sessionKey(): string | null {
  return session?.key ?? null;
}

/** list the sheets of a new generation (replaces the previous session) */
export function openSheets(input: SheetsOpenInput, activateCatalog: boolean): { sheets: DrawingSheetMeta[]; ms: number } {
  const t0 = performance.now();
  if (activateCatalog) setActiveCatalog(resolveCatalog(input.project, input.library ?? null));
  const set = openDrawingSet(input.project, input.analysis, drawingOptions(input.project));
  session = { key: input.key, project: input.project, analysis: input.analysis, set };
  return { sheets: set.sheets, ms: performance.now() - t0 };
}

function build(s: Session, id: string): DrawingSheet {
  if (s.analysis && needsCableSchedule(s.set.sheets.find((m) => m.id === id))) {
    s.cabled ??= openDrawingSet(s.project, s.analysis, { ...drawingOptions(s.project), cableSchedule: buildCableSchedule(s.project, s.analysis) });
    if (s.cabled.sheets.some((m) => m.id === id)) return s.cabled.build(id);
  }
  return s.set.build(id);
}

export function buildSheet(key: string, id: string): { sheet: DrawingSheet; ms: number } {
  if (!session || session.key !== key) throw new Error('drawings: stale generation');
  const t0 = performance.now();
  const sheet = build(session, id);
  return { sheet, ms: performance.now() - t0 };
}

const cancelled = new Set<number>();
export function cancelZip(jobId: number) {
  cancelled.add(jobId);
}

/** ZIP the given sheets (current filter) in list order; yields between sheets so builds for the preview can interleave */
export async function zipSheets(key: string, jobId: number, ids: string[], projectId: string, projectName: string, onProgress: (done: number, total: number) => void): Promise<{ blob: Blob; files: number }> {
  if (!session || session.key !== key) throw new Error('drawings: stale generation');
  const s = session;
  const zip = new JSZip();
  const rootDir = `${projectId}-drawings`;
  const lines: string[] = [];
  const order = new Map(s.set.sheets.map((m, i) => [m.id, i]));
  const sorted = ids.filter((id) => order.has(id)).sort((a, b) => order.get(a)! - order.get(b)!);
  let last = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (cancelled.has(jobId)) {
      cancelled.delete(jobId);
      throw new Error('cancelled');
    }
    const sheet = build(s, sorted[i]);
    zip.file(`${rootDir}/${rackElevationFileName(sheet)}`, sheet.svg);
    lines.push(`- ${sheet.number} ${sheet.title} (${sheet.kind}${sheet.scale ? `, ${sheet.scale}` : ''}${sheet.paper ? `, ${sheet.paper.w}×${sheet.paper.h} mm` : ''})`);
    const now = performance.now();
    if (now - last > 60 || i === sorted.length - 1) {
      onProgress(i + 1, sorted.length);
      last = now;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  zip.file(`${rootDir}/README.md`, `# ${projectName} — drawing sheets\n\n${lines.join('\n')}\n\nGenerated by AIDC Studio. Open the SVGs in a browser / Inkscape / CAD viewer; print each sheet at its paper size (A1 portrait or landscape, no margins) for the stated scale.\n`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return { blob, files: sorted.length };
}
