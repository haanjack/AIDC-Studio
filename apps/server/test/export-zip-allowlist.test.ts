// N1a (neutralization, LICENSE-AUDIT H4 / R-1.2): export zips only package GLBs that the asset manifest lists as
// redistributable generated models (`generated: true` + `license`) — never arbitrary files found in models/.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNvidiaReferenceProject, findCatalogItem, referencedModels, type Project } from '../../../packages/core/src/index.ts';
import { buildExportZip, exportableModels } from '../src/export-zip.ts';

const HELIOS_ID = 'amd-helios-mi455x';
// the reference project (halls, containments, GPU racks, CDUs, CRAHs) with its first GPU rack switched to the Helios-class item,
// so the project references the generated model plus several models that are not allowlisted
const project: Project = (() => {
  const p = structuredClone(createNvidiaReferenceProject().project);
  const i = p.equipment.findIndex((e) => findCatalogItem(e.catalogId)?.category === 'gpu-rack');
  p.equipment[i] = { ...p.equipment[i], catalogId: HELIOS_ID };
  return p;
})();

let dir: string;
let assets: string;
let models: string;
let templates: string;
const heliosGlb = findCatalogItem(HELIOS_ID)?.asset?.glb ?? 'helios.glb';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aidc-zip-allowlist-'));
  assets = join(dir, 'assets');
  models = join(assets, 'models');
  templates = join(dir, 'engines');
  mkdirSync(models, { recursive: true });
  mkdirSync(join(templates, 'godot'), { recursive: true });
  mkdirSync(join(templates, 'unreal'), { recursive: true });
  // every referenced model is present on disk, plus an unreferenced rogue file
  for (const m of [...referencedModels(project), 'rogue.glb']) writeFileSync(join(models, m), Buffer.from(`glTF-fake-${m}`));
  writeFileSync(join(assets, 'manifest.json'), JSON.stringify({
    models: [
      { name: 'helios', file: heliosGlb, generated: true, license: 'MIT' },
      ...referencedModels(project).filter((m) => m !== heliosGlb).map((m) => ({ name: m, file: m, sourceUsd: 'third-party/converted.usd' })),
      { name: 'rogue', file: 'rogue.glb', generated: true },
    ],
  }));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('export zip model allowlist (N1a)', () => {
  it('fixture references more than the allowlisted model', () => {
    expect(referencedModels(project)).toContain(heliosGlb);
    expect(referencedModels(project).length).toBeGreaterThan(1);
  });

  it('exportableModels = referenced ∩ manifest-allowlisted ∩ present', async () => {
    expect(await exportableModels(project, models)).toEqual([heliosGlb]);
  });

  it('no manifest, unreadable manifest or empty allowlist → no models at all', async () => {
    expect(await exportableModels(project, models, join(dir, 'missing.json'))).toEqual([]);
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    expect(await exportableModels(project, models, join(dir, 'broken.json'))).toEqual([]);
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ models: [{ file: heliosGlb }] }));
    expect(await exportableModels(project, models, join(dir, 'empty.json'))).toEqual([]);
  });

  it('allowlisted but absent on disk → skipped', async () => {
    const other = join(dir, 'models-empty');
    mkdirSync(other, { recursive: true });
    expect(await exportableModels(project, other, join(assets, 'manifest.json'))).toEqual([]);
  });

  for (const format of ['godot', 'unreal', 'all'] as const) {
    it(`${format} zip packages only the allowlisted GLB`, async () => {
      const { buffer } = await buildExportZip(project, null, format, { templatesRoot: templates, modelsDir: models });
      const zip = await JSZip.loadAsync(buffer);
      const glbs = Object.keys(zip.files).filter((n) => n.toLowerCase().endsWith('.glb'));
      expect(glbs.length).toBe(format === 'all' ? 2 : 1);
      for (const n of glbs) expect(n.endsWith(`/models/${heliosGlb}`), n).toBe(true);
    });
  }
});
