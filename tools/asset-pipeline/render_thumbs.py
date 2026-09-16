#!/usr/bin/env python3
"""Render catalog thumbnails (3/4 front view, 512 x 512, neutral background) of every GLB with headless Chromium + three.js.

Stream T5 (DECISIONS-v2-2 F6). Outputs `apps/web/public/assets/thumbs/<model>.png` for each `models/<model>.glb`
(LOD1 files are skipped) and writes the `thumbs` map `{ "<model>.glb": "thumbs/<model>.png" }` into
`apps/web/public/assets/manifest.json`. The web catalog (packages/core/src/catalog/images.ts) shows these for
items whose `asset.glb` matches; items without a model get a generated front schematic instead.

three.js is taken from --three (a directory containing build/ and examples/), defaulting to the workspace
node_modules/three. A static server on port 5190 exposes the GLBs, the harness page and three.

GPU flags: `--use-gl=angle --use-angle=gl-egl` is the combination that renders WebGL headless on the dev box;
pass `--swiftshader` to fall back to the software rasteriser.
"""
from __future__ import annotations

import argparse
import glob
import http.server
import json
import os
import subprocess
import threading
import urllib.parse
from pathlib import Path

PORT = 5190
SIZE = 512


def find_chrome() -> str:
    env = os.environ.get('CHROME')
    if env and os.path.exists(env):
        return env
    home = os.path.expanduser('~/.cache/ms-playwright')
    full = sorted(glob.glob(f'{home}/chromium-*/chrome-linux64/chrome')) + sorted(glob.glob(f'{home}/chromium-*/chrome-linux/chrome'))
    shell = sorted(glob.glob(f'{home}/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell'))
    for c in [*reversed(full), *reversed(shell), '/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome']:
        if os.path.exists(c):
            return c
    raise RuntimeError('no chromium found (set CHROME=...)')


class Handler(http.server.SimpleHTTPRequestHandler):
    routes: dict[str, Path] = {}

    def translate_path(self, path):
        p = urllib.parse.urlparse(path).path
        for prefix, root in self.routes.items():
            if p.startswith(prefix):
                return str(root / p[len(prefix):].lstrip('/'))
        return str(Path(__file__).resolve().parent / p.lstrip('/'))

    def log_message(self, *a):
        pass


def main(argv=None):
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(here / '../../apps/web/public/assets'))
    ap.add_argument('--three', default=str(here / '../../node_modules/three'))
    ap.add_argument('--only', nargs='*', default=None, help='model stems to render (default: all non-LOD GLBs)')
    ap.add_argument('--swiftshader', action='store_true', help='software GL instead of ANGLE/EGL')
    ap.add_argument('--no-manifest', action='store_true')
    args = ap.parse_args(argv)
    assets = Path(args.out).resolve()
    models = assets / 'models'
    thumbs = assets / 'thumbs'
    thumbs.mkdir(parents=True, exist_ok=True)
    Handler.routes = {'/three/': Path(args.three).resolve(), '/models/': models}
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    chrome = find_chrome()
    gl = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] if args.swiftshader else ['--use-gl=angle', '--use-angle=gl-egl']
    results: dict[str, bool] = {}
    try:
        for glb in sorted(models.glob('*.glb')):
            if glb.stem.endswith('_lod1'):
                continue
            if args.only and glb.stem not in args.only:
                continue
            png = thumbs / f'{glb.stem}.png'
            if png.exists():
                png.unlink()
            url = f'http://127.0.0.1:{PORT}/thumbs.html?model=/models/{glb.name}&size={SIZE}'
            # headless=new reserves ~90 px of the window for browser chrome, so render into a taller window and crop
            cmd = [chrome, '--headless=new', '--no-sandbox', *gl, '--ignore-gpu-blocklist', '--hide-scrollbars',
                   f'--window-size={SIZE},{SIZE + 200}', '--virtual-time-budget=25000', '--default-background-color=00000000', f'--screenshot={png}', url]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
            if png.exists():
                try:
                    from PIL import Image  # pillow is in tools/asset-pipeline/.venv
                    with Image.open(png) as im:
                        im.crop((0, 0, SIZE, SIZE)).save(png, optimize=True)
                except ImportError:
                    print('[thumb] pillow missing — PNG left uncropped')
            ok = png.exists() and png.stat().st_size > 2000
            results[glb.name] = ok
            print(f'[thumb] {glb.name} -> thumbs/{png.name} {"ok" if ok else "FAILED"}', (r.stderr or '')[-300:] if not ok else '')
    finally:
        srv.shutdown()
    if not args.no_manifest:
        mpath = assets / 'manifest.json'
        manifest = json.loads(mpath.read_text()) if mpath.exists() else {}
        existing = manifest.get('thumbs', {}) if isinstance(manifest.get('thumbs'), dict) else {}
        for name, ok in results.items():
            if ok:
                existing[name] = f'thumbs/{Path(name).stem}.png'
        manifest['thumbs'] = dict(sorted(existing.items()))
        manifest['thumbsNote'] = ('Catalog thumbnails: 512x512 3/4-front renders of models/*.glb (tools/asset-pipeline/render_thumbs.py, '
                                  'headless Chromium + three.js). Rendered from the converted GLBs; no vendor product photos.')
        mpath.write_text(json.dumps(manifest, indent=2) + '\n')
        print(f'[thumb] manifest.json thumbs: {len(existing)} entries')
    return results


if __name__ == '__main__':
    main()
