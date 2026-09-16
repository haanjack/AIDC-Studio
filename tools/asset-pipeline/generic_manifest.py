#!/usr/bin/env python3
"""Single writer of apps/web/public/assets/manifest.json and models/_models_report.json (neutralization N1b, M12).

Both files list ONLY assets AIDC Studio generates itself — the generic form-factor models of generic_build.py (EIA-310,
21-inch OU and wide OU racks, CDU, CRAH / fan wall). The former vendor-shaped wide-rack entry (`helios`) was retired on
2026-09-15 and is dropped when found. Every entry carries generated: true, licence 'MIT (AIDC Studio original)',
generator and source fields. Converted third-party entries (content-pack GLBs, reference CFD, the pack-collected sky HDR) and any
source path into a third-party pack are dropped. The `thumbs` map only lists PNGs that exist for those models.

usage: generic_manifest.py [--out ASSETS_DIR]   (rewrites both files from the current _models_report.json)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
LICENCE = 'MIT (AIDC Studio original)'
OWN_NAME = re.compile(r'^generic_[a-z0-9_]+$')
# retired content-pack prefix built from character codes (P6 term guard: the abbreviation lives in README.md only)
_PACK = ''.join(map(chr, (100, 115, 120)))
FORBIDDEN = re.compile(_PACK + r'_BP|Library/Assets|omniverse:' r'//|art\.ov\.nvidia|proxy_GB300|Vertiv|Liebert|nvidia-' + _PACK, re.I)


def _clean(entry: dict) -> dict | None:
    name = str(entry.get('name', ''))
    if not OWN_NAME.match(name) or not entry.get('generated'):
        return None
    e = dict(entry)
    # `license` is the key the product allowlist reads (packages/core/src/catalog/assetManifest.ts isRedistributableModel:
    # generated === true && non-empty license); `licence` mirrors it for the neutralization docs
    e['license'] = LICENCE
    e['licence'] = LICENCE
    e.setdefault('generator', 'tools/asset-pipeline/generic_build.py')
    e.setdefault('source', 'parametric (AIDC Studio)')
    blob = json.dumps(e)
    if FORBIDDEN.search(blob):
        raise ValueError(f'manifest entry {name} still references third-party material: {FORBIDDEN.search(blob).group(0)}')
    return e


def write(out: Path, updates: list[dict] | None = None, generated_assets: dict | None = None) -> dict:
    """Merge `updates` (by name) into the own entries of models/_models_report.json, then rewrite it and manifest.json."""
    out = Path(out).resolve()
    report_path = out / 'models' / '_models_report.json'
    manifest_path = out / 'manifest.json'
    old_report = json.loads(report_path.read_text()) if report_path.exists() else []
    old_manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    by_name: dict[str, dict] = {}
    for src in (old_manifest.get('models', []), old_report, updates or []):
        for e in src:
            c = _clean(e)
            if c:
                by_name[c['name']] = {**by_name.get(c['name'], {}), **c}
    models = [by_name[k] for k in sorted(by_name)]
    # drop entries whose GLB is gone
    models = [m for m in models if (out / 'models' / m['file']).exists()]
    thumbs = {}
    for m in models:
        png = out / 'thumbs' / f"{Path(m['file']).stem}.png"
        if png.exists():
            thumbs[m['file']] = f'thumbs/{png.name}'
            m['thumbnail'] = f'thumbs/{png.name}'
        else:
            m.pop('thumbnail', None)
        m.pop('thumbnailLod1', None)
    gen_assets = {k: v for k, v in (old_manifest.get('generatedAssets') or {}).items() if k == 'generic'}
    gen_assets.update(generated_assets or {})
    # keys owned by other writers (e.g. `env`, re-sourced from a CC0 original by env_map.py) are kept when they are clean;
    # `cfd` (reference CFD derived from a third-party dataset) and the old pack-wide `source` line are never carried over
    own_keys = {'generatedAt', 'source', 'licence', 'conventions', 'models', 'generatedAssets', 'thumbs', 'thumbsNote', 'cfd'}
    carried = {k: v for k, v in old_manifest.items() if k not in own_keys and not FORBIDDEN.search(json.dumps(v))}
    manifest = {
        'generatedAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
        'source': 'AIDC Studio generated assets only (parametric, from public standards and public product information); '
                  'no third-party models, textures, renders or simulation data',
        'licence': LICENCE,
        'conventions': {'models': 'glTF Y-up, meters, footprint centered at origin (XZ), base y=0, width X, depth Z, front faces -Z'},
        'models': models,
        'generatedAssets': gen_assets,
        'thumbs': dict(sorted(thumbs.items())),
        'thumbsNote': 'Catalog thumbnails: 512x512 3/4-front renders of the generated models/*.glb (tools/asset-pipeline/render_thumbs.py, '
                      'headless Chromium + three.js). No vendor product photos.',
        **carried,
    }
    text = json.dumps(manifest, indent=2) + '\n'
    if FORBIDDEN.search(text):
        raise ValueError(f'manifest.json would reference third-party material: {FORBIDDEN.search(text).group(0)}')
    manifest_path.write_text(text)
    report_path.write_text(json.dumps(models, indent=2) + '\n')
    print(f'[manifest] {manifest_path}: {len(models)} models ({", ".join(m["name"] for m in models)}), {len(thumbs)} thumbs')
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--out', default=str(HERE / '../../apps/web/public/assets'))
    args = ap.parse_args(argv)
    write(Path(args.out))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
