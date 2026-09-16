#!/usr/bin/env python3
"""Build every web asset of AIDC Studio and update manifest.json. No third-party content pack is read.

  - generated equipment models: generic_build.py (generic_spec.json → usd/Generic/*.usd → models/generic_*.glb: EIA-310, 21-inch OU
    and wide OU racks, CDU, CRAH / fan wall; it writes its own manifest / _models_report / CREDITS entries);
  - env/sky_1k.hdr: env_map.py downsamples the Poly Haven "Autumn Field (Pure Sky)" HDRI (CC0, pinned sha256);
  - catalog thumbnails: render_thumbs.py (headless Chromium + three.js + Pillow).

    python tools/asset-pipeline/build_all.py [--out apps/web/public/assets] [--skip-generic] [--skip-env]
                                             [--env-src <autumn_field_puresky_4k.hdr>] [--skip-thumbs] [--three <dir>]

Pillow is required for thumbnail cropping: install it into the pipeline venv with
`tools/asset-pipeline/.venv/bin/pip install -r tools/asset-pipeline/requirements.txt` and run this script with `.venv/bin/python`.
Pass --skip-thumbs on hosts without headless Chromium.

manifest.json only keeps redistributable model entries (`generated: true` + `license`); the web viewer, the catalog thumbnails
and the export zip ignore anything else (packages/core/src/catalog/assetManifest.ts).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def _redistributable(m) -> bool:
    return isinstance(m, dict) and m.get('generated') is True and isinstance(m.get('license'), str) and m['license'].strip() != ''


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(HERE / '../../apps/web/public/assets'))
    ap.add_argument('--skip-generic', action='store_true', help='skip the generic parametric models (generic_build.py)')
    ap.add_argument('--skip-env', action='store_true', help='skip env/sky_1k.hdr (env_map.py)')
    ap.add_argument('--env-src', default=None, help='local autumn_field_puresky_4k.hdr (default: download from Poly Haven, sha256-pinned)')
    ap.add_argument('--skip-thumbs', action='store_true', help='skip catalog thumbnails (render_thumbs.py: headless Chromium + three.js + Pillow)')
    ap.add_argument('--three', default=str(HERE / '../../node_modules/three'))
    args = ap.parse_args(argv)
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / 'manifest.json'
    report_path = out / 'models' / '_models_report.json'

    if not args.skip_generic and (HERE / 'generic_build.py').exists():
        import generic_build  # type: ignore[import-not-found]
        if generic_build.main(['--out', str(out)]) != 0:
            print('[build_all] generic_build failed (see above); continuing', file=sys.stderr)

    # the model builders update manifest.json / _models_report.json themselves → re-read before adding the other sections
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    if report_path.exists():
        manifest['models'] = json.loads(report_path.read_text())

    if not args.skip_env:
        import env_map
        manifest['env'] = env_map.main(['--out', str(out)] + (['--src', args.env_src] if args.env_src else []))

    if not args.skip_thumbs:
        # render_thumbs.py updates manifest.json's `thumbs` map itself → write the current manifest first, then re-read the map
        manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
        try:
            import render_thumbs
            render_thumbs.main(['--out', str(out), '--three', args.three])
            thumbs = json.loads(manifest_path.read_text()).get('thumbs')
            if thumbs is not None:
                manifest['thumbs'] = thumbs
        except ImportError as e:
            print(f'[build_all] render_thumbs skipped: {e} — install Pillow into tools/asset-pipeline/.venv (pip install -r requirements.txt)', file=sys.stderr)
        except Exception as e:  # noqa: BLE001 — missing Chromium / three.js must not lose the other assets
            print(f'[build_all] render_thumbs failed: {e} (use --skip-thumbs on hosts without headless Chromium)', file=sys.stderr)

    # allowlist: only redistributable generated models (and their thumbnails) stay listed
    models = [m for m in manifest.get('models', []) if _redistributable(m)]
    dropped = [m.get('name') for m in manifest.get('models', []) if not _redistributable(m)]
    if dropped:
        print(f'[build_all] dropped non-redistributable model entries: {dropped}', file=sys.stderr)
    manifest['models'] = models
    files = {m['file'] for m in models}
    if isinstance(manifest.get('thumbs'), dict):
        manifest['thumbs'] = {k: v for k, v in sorted(manifest['thumbs'].items()) if k in files}
    manifest.pop('cfd', None)
    manifest.pop('generatedSource', None)
    manifest['generatedAt'] = dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')
    manifest['source'] = 'AIDC Studio asset pipeline (tools/asset-pipeline): generated models + CC0 sky HDRI; see CREDITS.json'
    manifest['conventions'] = {
        'models': 'glTF Y-up, meters, footprint centered at origin (XZ), base y=0, width X, depth Z, front faces -Z',
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    print('[build_all] wrote', manifest_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
