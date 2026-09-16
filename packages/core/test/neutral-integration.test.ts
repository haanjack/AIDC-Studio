// Neutralization integration (2026-09-15): cross-stream consistency between the built-in catalog, the web asset manifest
// (allowlist), the files in apps/web/public/assets, the USD export orientation table and CREDITS.json.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowedModelFiles, allowedThumbnails, catalogItems, type AssetManifest } from '../src/index.ts';
import { isGeneratedUsdAssetPath, USD_ASSET_INFO } from '../src/export/usd.ts';

const ASSETS = join(__dirname, '../../../apps/web/public/assets');
const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')) as AssetManifest;
const credits = JSON.parse(readFileSync(join(ASSETS, 'CREDITS.json'), 'utf8')) as { assets: { path: string; license: string; sha256: string; bytes: number }[] };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
}

describe('neutralization integration: catalog ↔ manifest ↔ files ↔ credits', () => {
  it('every catalog asset.glb is an allowlisted generated model (LOD0 + LOD1) present on disk', () => {
    const lod0 = allowedModelFiles(manifest);
    const lod1 = allowedModelFiles(manifest, { lod1: true });
    const withGlb = catalogItems().filter((it) => it.asset?.glb);
    expect(withGlb.length).toBeGreaterThanOrEqual(10);
    for (const it of withGlb) {
      const glb = it.asset!.glb!;
      expect(lod0.has(glb), `${it.id} → ${glb} allowlisted`).toBe(true);
      expect(lod1.has(glb.replace(/\.glb$/, '_lod1.glb')), `${it.id} LOD1`).toBe(true);
      expect(existsSync(join(ASSETS, 'models', glb)), `${it.id} file`).toBe(true);
      expect(glb).toMatch(/^(helios|generic_[a-z0-9_]+)\.glb$/);
    }
  });

  it('catalog map from generic_spec.json is applied (ids unchanged)', () => {
    const spec = JSON.parse(readFileSync(join(__dirname, '../../../tools/asset-pipeline/generic_spec.json'), 'utf8')) as { catalogMap: Record<string, { glb: string } | string> };
    for (const [id, v] of Object.entries(spec.catalogMap)) {
      if (id.startsWith('$') || typeof v === 'string') continue;
      const it = catalogItems().find((x) => x.id === id);
      expect(it, id).toBeDefined();
      expect(it!.asset?.glb, id).toBe(v.glb);
    }
  });

  it('every catalog asset.usd is a generated usd/ path that exists and has an orientation entry', () => {
    for (const it of catalogItems().filter((x) => x.asset?.usd)) {
      const usd = it.asset!.usd!;
      expect(isGeneratedUsdAssetPath(usd), `${it.id}: ${usd}`).toBe(true);
      expect(existsSync(join(ASSETS, usd)), `${it.id}: ${usd}`).toBe(true);
      expect(USD_ASSET_INFO[usd], `${it.id}: ${usd}`).toBeDefined();
    }
  });

  it('thumbnails registered for every allowlisted model exist', () => {
    const thumbs = allowedThumbnails(manifest);
    expect(Object.keys(thumbs).length).toBe(manifest.models?.length ?? -1);
    for (const p of Object.values(thumbs)) expect(existsSync(join(ASSETS, p)), p).toBe(true);
  });

  it('CREDITS.json covers every shipped asset file with a matching sha256, and nothing else', () => {
    const shipped = walk(ASSETS).map((f) => relative(ASSETS, f)).filter((p) => !/^(manifest\.json|CREDITS\.json|models\/_models_report\.json)$/.test(p)).sort();
    const listed = credits.assets.map((a) => a.path).sort();
    expect(listed).toEqual(shipped);
    for (const a of credits.assets) {
      const buf = readFileSync(join(ASSETS, a.path));
      expect(createHash('sha256').update(buf).digest('hex'), a.path).toBe(a.sha256);
      expect(a.license, a.path).toMatch(/^(Apache-2\.0 \(AIDC Studio original\)|CC0-1\.0)$/);
    }
  });
});
