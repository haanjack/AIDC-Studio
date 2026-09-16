import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { allowedModelFiles, buildExportFiles, referencedModels, slugify, withCatalog, type AssetManifest, type CatalogIndex, type ExportFormat, type Project, type ProjectAnalysis } from '../../../packages/core/src/index.ts';

export interface ZipConfig {
  templatesRoot: string; // repo engines/ directory
  modelsDir: string; // apps/web/public/assets/models
  /** asset manifest whose redistributable entries (`generated: true` + `license`) allowlist the GLBs; default `<modelsDir>/../manifest.json` */
  manifestPath?: string;
  /** effective catalog for the project (builtin ∪ library ∪ project extensions); builtin when omitted */
  catalog?: CatalogIndex;
}

// .gitignore is excluded: the template's ignores (layout.json, models) would hide the exported data.
const TEMPLATE_EXCLUDE = new Set(['.godot', 'layout.json', 'scene.tscn', 'models', '.import', '.gitignore']);

async function addTree(zip: JSZip, src: string, dest: string): Promise<void> {
  if (!existsSync(src)) return;
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (TEMPLATE_EXCLUDE.has(entry.name) || entry.name.endsWith('.import')) continue;
    const p = join(src, entry.name);
    if (entry.isDirectory()) await addTree(zip, p, `${dest}/${entry.name}`);
    else zip.file(`${dest}/${entry.name}`, await readFile(p));
  }
}

async function readManifest(path: string): Promise<AssetManifest | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AssetManifest;
  } catch {
    return null;
  }
}

/**
 * GLBs that may be handed to end users in an export zip (LICENSE-AUDIT H4 / R-1.2): referenced by the project, listed in the
 * asset manifest as a redistributable generated model (`generated: true` + `license`) and present on disk. Any other file in
 * `models/` is never packaged; the exported scene falls back to catalog boxes for those items.
 */
export async function exportableModels(project: Project, modelsDir: string, manifestPath = join(modelsDir, '..', 'manifest.json')): Promise<string[]> {
  if (!existsSync(modelsDir)) return [];
  const allowed = allowedModelFiles(await readManifest(manifestPath), { lod1: false });
  if (allowed.size === 0) return [];
  const present = new Set((await readdir(modelsDir)).filter((n) => n.toLowerCase().endsWith('.glb')));
  return referencedModels(project).filter((m) => allowed.has(m) && present.has(m));
}

async function addModels(zip: JSZip, dest: string, models: string[], modelsDir: string): Promise<void> {
  for (const m of models) zip.file(`${dest}/models/${m}`, await readFile(join(modelsDir, m)), { compression: 'STORE' });
}

/** Build a downloadable zip for an export format, merging engine templates and the allowlisted generated GLB models. */
export async function buildExportZip(project: Project, analysis: ProjectAnalysis | null, format: ExportFormat, cfg: ZipConfig): Promise<{ buffer: Buffer; filename: string }> {
  const zip = new JSZip();
  const pick = () => exportableModels(project, cfg.modelsDir, cfg.manifestPath);
  const models = await (cfg.catalog ? withCatalog(cfg.catalog, pick) : pick());
  // file generation is synchronous → run it under the project's effective catalog (v2 registry) when one is given
  const gen = () => buildExportFiles(project, analysis, format, { availableModels: models });
  const files = cfg.catalog ? withCatalog(cfg.catalog, gen) : gen();
  const root = `aidc-${format}`;

  const wantsGodot = format === 'godot' || format === 'all';
  const wantsUnreal = format === 'unreal' || format === 'all';
  if (wantsGodot) await addTree(zip, join(cfg.templatesRoot, 'godot'), format === 'all' ? `${root}/godot` : root);
  if (wantsUnreal) await addTree(zip, join(cfg.templatesRoot, 'unreal'), format === 'all' ? `${root}/unreal` : root);

  for (const [name, content] of Object.entries(files)) zip.file(`${root}/${name}`, content);

  if (format === 'godot' || format === 'unreal') await addModels(zip, root, models, cfg.modelsDir);
  if (format === 'all') {
    await addModels(zip, `${root}/godot`, models, cfg.modelsDir);
    await addModels(zip, `${root}/unreal`, models, cfg.modelsDir);
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const stamp = new Date().toISOString().slice(0, 10);
  return { buffer, filename: `${slugify(project.name)}-${format}-${stamp}.zip` };
}

export function relativeTo(from: string, to: string): string {
  return relative(from, to).replace(/\\/g, '/');
}
