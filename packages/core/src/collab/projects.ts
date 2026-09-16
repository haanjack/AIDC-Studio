// Project management helpers (v2-2 project management): name rules shared by the server (create / rename / restore)
// and the web UI (inline validation), id slugs, "copy" / "restored" names and the empty-site template.
// Pure except createEmptyProject (which runs the reference generator once for its hall defaults).
import type { Project } from '../model/types.ts';
import { createReferenceProject, NEUTRAL_REFERENCE_NAME } from '../layout/reference.ts';
import { VENDOR_SAMPLE_NAMES } from '../layout/samples/index.ts';
import { DEFAULT_TEMPLATE_ID, LAYOUT_TEMPLATES, standardCorridors, standardTemplatesFor } from '../layout/templates/index.ts';
import { STANDARDS_PRESET_IDS, standardsPreset } from '../standards/registry.ts';
import type { StandardsPresetId } from '../standards/types.ts';

/** Maximum project name length (characters, after trimming). */
export const PROJECT_NAME_MAX = 120;

export type ProjectNameError = 'empty' | 'too-long' | 'taken';

/** Trim and drop control characters (names show in selects, file names of exports and window titles). */
export function cleanProjectName(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Case-insensitive comparison key (NFKC so full-width / composed Hangul variants collide too). */
export function projectNameKey(name: string): string {
  return cleanProjectName(name).normalize('NFKC').toLocaleLowerCase('en-US');
}

/**
 * Validation of a project name against the other projects.
 * `others` = every existing project (id + name); the entry with `selfId` (the project being renamed) is ignored.
 */
export function projectNameError(name: string, others: readonly { id: string; name: string }[], selfId?: string): ProjectNameError | null {
  const clean = cleanProjectName(name);
  if (!clean) return 'empty';
  if ([...clean].length > PROJECT_NAME_MAX) return 'too-long';
  const key = projectNameKey(clean);
  if (others.some((p) => p.id !== selfId && projectNameKey(p.name) === key)) return 'taken';
  return null;
}

/** ASCII slug of a name for ids ("Reference AI Factory — GB300" → "reference-ai-factory-gb300"); '' when nothing ASCII is left. */
export function projectSlug(name: string, max = 40): string {
  const s = cleanProjectName(name)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/g, '');
}

/** New project id: slug of the name + '-' + a short random suffix (callers retry when the id exists). */
export function projectIdFor(name: string, random: () => string = randomSuffix): string {
  return `${projectSlug(name) || 'project'}-${random()}`;
}

function randomSuffix(): string {
  const c = (globalThis as { crypto?: { getRandomValues?(a: Uint8Array): Uint8Array } }).crypto;
  const bytes = new Uint8Array(4);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 6);
}

/**
 * First free name: `base`, else `base (2)`, `base (3)`, … — trimmed to PROJECT_NAME_MAX with the suffix kept.
 * `taken` = existing names (compared case-insensitively).
 */
export function uniqueProjectName(base: string, taken: readonly string[]): string {
  const keys = new Set(taken.map(projectNameKey));
  const clean = cleanProjectName(base) || 'Project';
  const fit = (s: string, suffix: string) => {
    const room = PROJECT_NAME_MAX - [...suffix].length;
    return [...s].slice(0, room).join('').trimEnd() + suffix;
  };
  const first = fit(clean, '');
  if (!keys.has(projectNameKey(first))) return first;
  for (let i = 2; i < 10_000; i++) {
    const n = fit(clean, ` (${i})`);
    if (!keys.has(projectNameKey(n))) return n;
  }
  return fit(clean, ` (${Date.now().toString(36)})`);
}

/** Default "Save as new project" name: "<name> (copy)", made unique. `copyWord` is localised by the caller. */
export function copyProjectName(name: string, taken: readonly string[], copyWord = 'copy'): string {
  return uniqueProjectName(`${cleanProjectName(name) || 'Project'} (${copyWord})`, taken);
}

/**
 * Starting points of a new project (stream D / P4; DECISIONS-v2-2 §I DO-1, DO-7): `reference` = the vendor-neutral reference
 * (default), `empty` = one empty hall with a standards profile preset (DO-1 preselects `orv3-hpr-liquid`), `nvidia-reference` =
 * the vendor sample.
 */
export type ProjectTemplateId = 'reference' | 'empty' | 'nvidia-reference';

export const PROJECT_TEMPLATE_IDS: readonly ProjectTemplateId[] = ['reference', 'empty', 'nvidia-reference'];

/** Default names of the server templates (made unique by the server when the client sends no name). */
export const PROJECT_TEMPLATE_NAMES: Record<ProjectTemplateId, string> = {
  reference: NEUTRAL_REFERENCE_NAME,
  empty: 'New AI Factory site',
  'nvidia-reference': VENDOR_SAMPLE_NAMES['nvidia-reference'],
};

/** Preset preselected by the new-project wizard (DO-1). */
export const DEFAULT_NEW_PROJECT_PRESET: StandardsPresetId = 'orv3-hpr-liquid';

export const isStandardsPresetId = (v: unknown): v is StandardsPresetId => typeof v === 'string' && (STANDARDS_PRESET_IDS as readonly string[]).includes(v);

/** Standard template of a preset: the template built on that preset, else one with the same rack form, else the default. */
export function templateIdForPreset(preset: StandardsPresetId): string {
  const byPreset = LAYOUT_TEMPLATES.find((t) => t.group === 'standard' && t.profile?.id === preset);
  return byPreset?.id ?? standardTemplatesFor(standardsPreset(preset).rackForm)[0]?.id ?? DEFAULT_TEMPLATE_ID;
}

/**
 * Empty site: the reference project's site, power / cooling / network / pricing defaults and ONE empty data hall
 * with the reference hall defaults (size, heights, floor loading, budgets, layout policy, door + egress keep-outs).
 * No equipment, containments, trays, busways, clusters, schedule waves or thermal snapshots — generate a layout in
 * the Layout panel afterwards. `preset` sets the confirmed standards profile (default `orv3-hpr-liquid`, DO-1), the hall's
 * standard template and the aisle minimums of its facility pre-check basis.
 */
export function createEmptyProject(opts: { name?: string; gpuRackCatalogId?: string; preset?: StandardsPresetId } = {}): Project {
  const ref = createReferenceProject({ gpuRackCatalogId: opts.gpuRackCatalogId }).project;
  const hall = structuredClone(ref.halls[0]);
  const preset = opts.preset ?? DEFAULT_NEW_PROJECT_PRESET;
  const standards = standardsPreset(preset);
  if (hall.layoutPolicy) hall.layoutPolicy = { ...hall.layoutPolicy, templateId: templateIdForPreset(preset), corridors: standardCorridors(standards.facilityPrecheck) };
  const project: Project = {
    ...ref,
    id: 'new-site',
    name: cleanProjectName(opts.name) || PROJECT_TEMPLATE_NAMES.empty,
    description: 'Empty site with one data hall (reference hall defaults). Generate the white-space layout in the Layout panel.',
    standards,
    halls: [hall],
    equipment: [],
    containments: [],
    trays: [],
    busways: [],
    schedule: { ...ref.schedule, waves: [] },
    notes: [],
  };
  delete project.reservations;
  delete project.servicesZones;
  delete project.clusters;
  delete project.thermalSnapshots;
  delete project.drawingCuts;
  return project;
}
