// N1a (neutralization, LICENSE-AUDIT H1–H3, M1, M12, IP-15/16/35): the product asset paths hold no files derived from the retired reference content pack, the asset
// pipeline never reads a third-party content pack, and procedural textures / colormaps carry no vendor wordmarks or pack data.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { termRe } from '../../../packages/core/test/guard-terms.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const ASSETS = join(REPO, 'apps/web/public/assets');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('neutral product assets (N1a)', () => {
  it('no pack-derived models, thumbnails or reference-CFD files under apps/web/public/assets', () => {
    const files = walk(ASSETS).map((p) => relative(ASSETS, p));
    const bad = files.filter((f) => /(^|\/)(gb300|xdu1350|xdu2300|cw084|cw181|cw375)(_lod1)?\.(glb|png)$/i.test(f) || /^cfd\//.test(f) || termRe('<t>_', 'i').test(f));
    expect(bad).toEqual([]);
  });

  it('asset pipeline and viewer asset code reference no content pack, Omniverse URL, vendor wordmark or vendor CFD colormap', () => {
    const pipeline = readdirSync(join(REPO, 'tools/asset-pipeline')).filter((n) => /\.(py|html|txt|md)$/.test(n)).map((n) => join(REPO, 'tools/asset-pipeline', n));
    const viewer = ['textures.ts', 'colormap.ts', 'models.ts', 'modelIndex.ts'].map((n) => join(REPO, 'apps/web/src/viewer', n));
    const other = [join(REPO, 'apps/server/src/export-zip.ts'), join(REPO, 'packages/core/src/catalog/images.ts'), join(REPO, 'packages/core/src/catalog/assetManifest.ts')];
    const PATTERN = termRe('<T>_BP|--<t>-root|omniverse:\\/\\/|art\\.ov\\.nvidia\\.com|VERTIV|Liebert|NVIDIA_CFD_COLORMAP|CFD_Layer\\.usda|\\.cgns\\b|#76b900|0x76b900');
    const hits: string[] = [];
    for (const f of [...pipeline, ...viewer, ...other]) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        // lines that *define* a forbidden-pattern guard (e.g. generic_manifest.py FORBIDDEN = re.compile(...)) are not leaks
        if (PATTERN.test(line) && !/FORBIDDEN|guard-allow/.test(line)) hits.push(`${relative(REPO, f)}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('sky HDRI is credited (CC0, Poly Haven) with a matching sha256; manifest env has no content-pack source path', () => {
    const credits = JSON.parse(readFileSync(join(ASSETS, 'CREDITS.json'), 'utf8')) as { assets: { path: string; license: string; sourceUrl: string; sha256: string }[] };
    const sky = credits.assets.find((a) => a.path === 'env/sky_1k.hdr');
    expect(sky).toBeDefined();
    expect(sky!.license).toBe('CC0-1.0');
    expect(sky!.sourceUrl).toMatch(/^https:\/\/dl\.polyhaven\.org\//);
    const file = join(ASSETS, sky!.path);
    if (existsSync(file)) expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(sky!.sha256);
    const manifest = JSON.parse(readFileSync(join(ASSETS, 'manifest.json'), 'utf8')) as { env?: unknown; cfd?: unknown };
    expect(JSON.stringify(manifest.env ?? {})).not.toMatch(termRe('nvidia|<T>|Library\\/Assets', 'i'));
    expect(manifest.cfd).toBeUndefined();
  });
});
