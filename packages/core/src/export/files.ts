import { findCatalogItem } from '../catalog/catalog.ts';
import type { Project, ProjectAnalysis } from '../model/types.ts';
import { exportGodotScene } from './godot.ts';
import { exportLayoutJson } from './layout.ts';
import { exportUsda } from './usd.ts';
import { generateDrawings, openDrawingSet, rackElevationFileName, type DrawingSheetKey } from '../drawings/index.ts';
import { buildCableSchedule } from '../engines/links.ts';
import { buildDeployBundle, networkDeliverableData } from '../deploy/index.ts';
import { escapeHtml, htmlPage } from '../deploy/html.ts';
import { NOS_TARGETS, generateNosConfigs } from '../deploy/nos/index.ts';
import { generateTestPlan } from '../deploy/tests/index.ts';
import { renderDesignDocumentHtml } from '../docs/html.ts';

export type ExportFormat = 'usd' | 'godot' | 'unreal' | 'json' | 'docs' | 'drawings' | 'deploy' | 'all';
export const EXPORT_FORMATS: ExportFormat[] = ['usd', 'godot', 'unreal', 'json', 'docs', 'drawings', 'deploy', 'all'];
export type ExportFileMap = Record<string, string | Uint8Array>;

export interface ExportFileOptions {
  hallId?: string;
  /** GLB files that the packager will ship (enables model instancing in Godot scenes) */
  availableModels?: string[];
}

/** GLB model files referenced by the project's equipment. */
export function referencedModels(project: Project): string[] {
  const set = new Set<string>();
  for (const e of project.equipment) {
    const glb = findCatalogItem(e.catalogId)?.asset?.glb;
    if (glb) set.add(glb);
  }
  return [...set].sort();
}

/** Printable HTML design document (DECISIONS-v2-2 F5). Without an analysis a short placeholder page explains why. */
function designDocumentHtml(project: Project, analysis: ProjectAnalysis | null): string {
  const locale = project.locale ?? 'en';
  if (analysis) return renderDesignDocumentHtml(project, analysis, { locale });
  const msg = locale === 'ko' ? '분석 결과가 없어 설계서를 생성할 수 없습니다. 프로젝트를 분석한 뒤 다시 내보내세요.' : 'No analysis is available for this project, so the design document cannot be generated. Analyse the project and export again.';
  return htmlPage(project.name, `<p class="note">${escapeHtml(msg)}</p>`, locale);
}

function usdReadme(): string {
  return `# AIDC Studio — USD export

\`stage.usda\` is a Z-up, metersPerUnit=1 OpenUSD stage. Equipment with an AIDC-generated USD asset (\`usd/…\`) is
**payloaded** from \`../apps/web/public/assets\`; everything else is a sized \`Cube\` with a display color. No third-party
asset library is referenced.

- Hierarchy: \`/World/Site/<Hall>/{Shell, Keepouts, Containment, Equipment/<Pod>/<Tag>}\`
- Attributes use AIDC Studio's own \`aidc:\` namespace: equipment Xforms carry \`aidc:id\`, \`aidc:tag\`, \`aidc:catalogId\`,
  \`aidc:category\`, \`aidc:nameplateKW\`, \`aidc:podId\`, \`aidc:rowId\`, \`aidc:waveId\`, \`aidc:networkRole\`; halls carry
  \`aidc:hallId\` and \`aidc:itPowerBudgetKW\`; containment Xforms carry \`aidc:kind\` and \`aidc:podId\`.
- Interop: to attach this layout to a third-party asset library, add your own payload under each equipment Xform and
  map the \`aidc:*\` attributes to that library's property names in your pipeline (keyed by \`aidc:catalogId\`).
- Native-front corrections for generated assets live on the \`Asset\` child Xform (\`xformOp:rotateZ:nativeFront\`).
- Walls and ceiling are authored \`invisible\`; make them visible in the stage tree if needed.

Open with any OpenUSD viewer: \`usdview stage.usda\`, Blender 4.x (File ▸ Import ▸ USD), Unreal Engine's USD Stage plugin,
or another USD-capable application.
`;
}

/**
 * Deployment export: BOM · rack plan · cable schedule · IP plan · switch inventory (CSV + HTML), topology.dot,
 * nos/<target>/ for every NOS target and tests/ (acceptance kit). The cable schedule and IP plan are computed once.
 */
/**
 * r4 sheet kinds the deploy bundle carries under drawings/ (spec §4.2 item 2: requested explicitly, so the 'drawings' export keeps its
 * default set and file count). 001 lists exactly this set; rack rows (2xx) and the systems iso (401) stay in the 'drawings' export.
 */
export const DEPLOY_DRAWING_SHEETS: readonly DrawingSheetKey[] = ['index', 'site', 'plan-upgrade', 'services-plan', 'enlarged-plan', 'section', 'elevation', 'mep-iso', 'row-schematic', 'one-line'];

export function deployExportFiles(project: Project, analysis: ProjectAnalysis | null): ExportFileMap {
  const locale = project.locale ?? 'en';
  const files: ExportFileMap = {};
  const data = networkDeliverableData(project, analysis);
  for (const f of buildDeployBundle(project, analysis, { locale, ...data })) files[f.path] = f.content;
  // r4 drawing sheets (001 · 002 · 101 upgrade · 111 · 121 · 301/302 · 311 · 411 · 601 · 611), text in project.locale
  const drawings = openDrawingSet(project, analysis, { locale, sheets: [...DEPLOY_DRAWING_SHEETS] });
  for (const m of drawings.sheets) {
    const sheet = drawings.build(m.id);
    files[`drawings/${rackElevationFileName(sheet)}`] = sheet.svg;
  }
  if (analysis) {
    for (const target of NOS_TARGETS) {
      for (const f of generateNosConfigs(project, analysis, data.ipPlan, target, { cableSchedule: data.cableSchedule })) files[`nos/${target}/${f.path}`] = f.content;
    }
    for (const f of generateTestPlan(project, analysis, { locale, cableSchedule: data.cableSchedule, ipPlan: data.ipPlan })) files[`tests/${f.path}`] = f.content;
  }
  return files;
}

export function buildExportFiles(project: Project, analysis: ProjectAnalysis | null, format: ExportFormat, opts: ExportFileOptions = {}): ExportFileMap {
  const layout = () => exportLayoutJson(project, analysis, { hallId: opts.hallId });
  switch (format) {
    case 'usd':
      return {
        'stage.usda': exportUsda(project, { hallId: opts.hallId }),
        'layout.json': layout(),
        'README.md': usdReadme(),
      };
    case 'godot':
      return {
        'layout.json': layout(),
        ...exportGodotScene(project, { hallId: opts.hallId, availableModels: opts.availableModels }, analysis),
      };
    case 'unreal':
      return { 'layout.json': layout() };
    case 'json': {
      const files: ExportFileMap = { 'layout.json': layout(), 'project.json': JSON.stringify(project, null, 2) };
      if (analysis) files['analysis.json'] = JSON.stringify(analysis, null, 2);
      return files;
    }
    case 'docs':
      // T7 (F5): printable single-file HTML with inline SVG diagrams; language = project.locale (default 'en')
      return { 'design-document.html': designDocumentHtml(project, analysis) };
    case 'drawings': {
      // S5: printable A1 SVG sheets (plans 1xx · rack elevations 2xx · systems iso 4xx); text follows project.locale
      const files: ExportFileMap = {};
      // finish v2 2차 (QA rack-elevations M4): the cable schedule marks cabled switch ports (without it every port glyph was drawn hollow)
      const cableSchedule = analysis ? buildCableSchedule(project, analysis) : undefined;
      for (const sheet of generateDrawings(project, analysis, { hallId: opts.hallId, rackRows: 'all', cableSchedule })) files[rackElevationFileName(sheet)] = sheet.svg; // D2: per-DU rack row sheets under 200-rack-elevations/<DU>/
      return files;
    }
    case 'deploy':
      return deployExportFiles(project, analysis);
    case 'all': {
      const out: ExportFileMap = {};
      for (const f of ['usd', 'godot', 'unreal', 'json', 'docs', 'deploy', 'drawings'] as const) {
        for (const [k, v] of Object.entries(buildExportFiles(project, analysis, f, opts))) out[`${f}/${k}`] = v;
      }
      return out;
    }
    default:
      throw new Error(`Unknown export format: ${format as string}`);
  }
}
