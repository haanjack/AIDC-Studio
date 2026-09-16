#!/usr/bin/env python3
"""Occlusion gate for the generic equipment GLBs (generic_*.glb, generic_*_lod1.glb) — no see-through at LOD0 / LOD1.

Ray kernel in occlusion_rays.py. The checked face area is an explicit BODY range
instead of the whole bounding box, because CDU piping stubs stand above the cabinet roof (air above the roof is not a
hole in the cabinet). glTF frame: Y-up, metres, footprint centred, FRONT = -Z, rear = +Z.

1. Ray grid (default 96 x 192, >= 60 x 120) over the full width x body height [y0, y1], cast straight and at 3/4 angles
   (yaw +-35, pitch +-15) from the front plane and from the rear plane. Every ray must hit a triangle within
   --max-depth-mm (150 mm) of the face plane; every material must be OPAQUE.
2. --gl: orthographic unlit render in headless Chromium (three.js) on a magenta background; 0 magenta pixels inside
   the body rectangle, front and rear.

usage: generic_occlusion.py --files a.glb a_lod1.glb [--body a.glb=0,2.069 ...] [--gl] [--json OUT] [--maps DIR]
"""
from __future__ import annotations

import argparse
import http.server
import json
import math
import socket
import subprocess
import sys
import threading
import urllib.parse
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from occlusion_rays import load_triangles, parallel_first_hits, write_maps  # noqa: E402

ANGLES = [(0, 0), (35, 0), (-35, 0), (0, 15), (0, -15), (35, 15), (-35, -15)]


def ray_grid(path: Path, y0: float | None = None, y1: float | None = None, cols=96, rows=192, max_depth=0.150, maps: dict | None = None):
    tris, names, modes = load_triangles(path)
    lo = tris.reshape(-1, 3).min(0)
    hi = tris.reshape(-1, 3).max(0)
    y0 = float(lo[1]) if y0 is None else y0
    y1 = float(hi[1]) if y1 is None else y1
    inset = 0.0015
    xs = np.linspace(lo[0] + inset, hi[0] - inset, cols)
    ys = np.linspace(y0 + inset, y1 - inset, rows)
    gx, gy = np.meshgrid(xs, ys)
    out = {'file': path.name, 'grid': [cols, rows], 'bodyY': [round(y0, 4), round(y1, 4)], 'maxDepthMm': max_depth * 1000,
           'nonOpaqueMaterials': sorted(n for n, m in modes.items() if m != 'OPAQUE'), 'sides': {}}
    ok = not out['nonOpaqueMaterials']
    for side, z_plane, sign in (('front', lo[2], 1.0), ('rear', hi[2], -1.0)):
        res = []
        for yaw, pitch in ANGLES:
            d = np.array([math.sin(math.radians(yaw)) * math.cos(math.radians(pitch)), math.sin(math.radians(pitch)),
                          sign * math.cos(math.radians(yaw)) * math.cos(math.radians(pitch))])
            d /= np.linalg.norm(d)
            kpar, idx = parallel_first_hits(tris, xs, ys, z_plane, d)
            t, i = kpar.ravel(), idx.ravel()
            depth = np.where(np.isfinite(t), sign * t * d[2], np.inf)
            bad = ~(depth <= max_depth + 1e-6)
            if maps is not None and yaw == 0 and pitch == 0:
                maps[side] = (bad.reshape(len(ys), len(xs)), np.where(np.isfinite(depth), depth, np.nan).reshape(len(ys), len(xs)))
            pts = np.c_[gx.ravel(), gy.ravel()]
            worst = None
            if bad.any():
                kw = int(np.argmax(np.where(bad, np.nan_to_num(depth, posinf=99.0), -1)))
                worst = {'x': round(float(pts[kw, 0]), 4), 'y': round(float(pts[kw, 1]), 4),
                         'depthMm': None if not np.isfinite(depth[kw]) else round(float(depth[kw]) * 1000, 1), 'hit': None if i[kw] < 0 else str(names[i[kw]])}
            res.append({'yawDeg': yaw, 'pitchDeg': pitch, 'rays': int(len(pts)), 'fail': int(bad.sum()), 'misses': int((~np.isfinite(t)).sum()),
                        'maxDepthMm': round(float(np.nanmax(np.where(np.isfinite(depth), depth, np.nan))) * 1000, 1) if np.isfinite(depth).any() else None,
                        'worst': worst})
            ok &= not bad.any()
        out['sides'][side] = res
    out['ok'] = bool(ok)
    return out


GL_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#ff00ff;overflow:hidden}</style>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script></head><body>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const q = new URLSearchParams(location.search);
const S = Number(q.get('px') || 800);
new GLTFLoader().load(q.get('model'), (gltf) => {
  const obj = gltf.scene;
  const box = new THREE.Box3().setFromObject(obj);
  const W = Math.round((box.max.x - box.min.x) * S), H = Math.round((box.max.y - box.min.y) * S);
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(W, H); renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(1, 0, 1);
  obj.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: 0x202020, side: [o.material].flat()[0].side }); });
  scene.add(obj);
  const rear = q.get('side') === 'rear';
  const cx = (box.min.x + box.max.x) / 2, cy = (box.min.y + box.max.y) / 2;
  const cam = new THREE.OrthographicCamera(-(box.max.x - box.min.x) / 2, (box.max.x - box.min.x) / 2, (box.max.y - box.min.y) / 2, -(box.max.y - box.min.y) / 2, 0.01, 20);
  cam.position.set(cx, cy, rear ? box.max.z + 3 : box.min.z - 3); cam.lookAt(cx, cy, rear ? box.max.z - 1 : box.min.z + 1); cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  const gl = renderer.getContext();
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const y0 = Number(q.get('y0')), y1 = Number(q.get('y1'));
  const rowMin = Math.ceil((y0 - box.min.y) * S) + 2, rowMax = Math.floor((y1 - box.min.y) * S) - 2;
  let magenta = 0, total = 0; const sample = [];
  for (let r = rowMin; r < Math.min(H - 2, rowMax); r++) for (let c = 2; c < W - 2; c++) {
    const k = (r * W + c) * 4; total++;
    if (px[k] > 200 && px[k + 1] < 60 && px[k + 2] > 200) { magenta++; if (sample.length < 12) sample.push([c, H - 1 - r]); }
  }
  document.title = 'DONE ' + JSON.stringify({ W, H, total, magenta, sample });
}, undefined, (e) => { document.title = 'ERROR ' + e; });
</script></body></html>"""


def gl_check(models_dir: Path, files: list[str], bodies: dict, three_dir: Path):
    from render_thumbs import find_chrome

    class H(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            p = urllib.parse.urlparse(self.path).path
            body, ctype = None, 'text/plain'
            if p == '/occ.html':
                body, ctype = GL_HTML.encode(), 'text/html'
            elif p.startswith('/three/'):
                f = three_dir / p[len('/three/'):]
                body, ctype = (f.read_bytes() if f.is_file() else None), 'text/javascript'
            elif p.startswith('/models/'):
                f = models_dir / p[len('/models/'):]
                body, ctype = (f.read_bytes() if f.is_file() else None), 'model/gltf-binary'
            if body is None:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        port = s.getsockname()[1]
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    chrome = find_chrome()
    results = []
    try:
        for f in files:
            y0, y1 = bodies[f]
            for side in ('front', 'rear'):
                url = f'http://127.0.0.1:{port}/occ.html?model=/models/{f}&side={side}&px=800&y0={y0}&y1={y1}'
                cmd = [chrome, '--headless=new', '--no-sandbox', '--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist',
                       '--virtual-time-budget=20000', '--dump-dom', url]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
                title = r.stdout.split('<title>', 1)[1].split('</title>', 1)[0] if '<title>' in r.stdout else ''
                if title.startswith('DONE '):
                    d = json.loads(title[5:].replace('&quot;', '"'))
                    results.append({'file': f, 'side': side, **d, 'ok': d['magenta'] == 0 and d['total'] > 0})
                else:
                    results.append({'file': f, 'side': side, 'ok': False, 'error': title or r.stderr[-400:]})
    finally:
        srv.shutdown()
    return results


def run(models_dir: Path, files: list[str], bodies: dict | None = None, gl: bool = True, three: Path | None = None,
        maps_dir: Path | None = None, cols=96, rows=192, max_depth_mm=150.0) -> dict:
    bodies = dict(bodies or {})
    report = {'rays': [], 'gl': None}
    ok = True
    for f in files:
        y0, y1 = bodies.get(f, (None, None))
        maps = {} if maps_dir else None
        r = ray_grid(models_dir / f, y0, y1, cols, rows, max_depth_mm / 1000.0, maps=maps)
        bodies[f] = tuple(r['bodyY'])
        if maps:
            write_maps(maps, maps_dir, Path(f).stem, max_depth_mm / 1000.0)
        report['rays'].append(r)
        ok &= r['ok']
        for side, res in r['sides'].items():
            fails = sum(x['fail'] for x in res)
            print(f"[occlusion] {f:34s} {side:5s} rays={sum(x['rays'] for x in res)} fail={fails} max first-hit depth={max((x['maxDepthMm'] or 0) for x in res)} mm "
                  f"{'OK' if fails == 0 else 'FAIL ' + json.dumps([x['worst'] for x in res if x['worst']][:3])}")
        if r['nonOpaqueMaterials']:
            print(f"[occlusion] {f}: non-opaque materials {r['nonOpaqueMaterials']} FAIL")
    if gl:
        report['gl'] = gl_check(models_dir, files, bodies, (three or HERE / '../../node_modules/three').resolve())
        for g in report['gl']:
            print(f"[occlusion] GL ortho {g['file']:34s} {g['side']:5s} magenta px in body = {g.get('magenta')} of {g.get('total')} {'OK' if g['ok'] else 'FAIL ' + str(g.get('error', g.get('sample')))}")
            ok &= g['ok']
    report['ok'] = bool(ok)
    print('[occlusion]', 'PASS' if ok else 'FAIL')
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--models', default=str(HERE / '../../apps/web/public/assets/models'))
    ap.add_argument('--files', nargs='+', required=True)
    ap.add_argument('--body', nargs='*', default=[], help='file=y0,y1 body height range in metres (default: whole bbox)')
    ap.add_argument('--cols', type=int, default=96)
    ap.add_argument('--rows', type=int, default=192)
    ap.add_argument('--max-depth-mm', type=float, default=150.0)
    ap.add_argument('--gl', action='store_true')
    ap.add_argument('--three', default=str(HERE / '../../node_modules/three'))
    ap.add_argument('--json', default=None)
    ap.add_argument('--maps', default=None)
    args = ap.parse_args(argv)
    if args.cols < 60 or args.rows < 120:
        ap.error('grid must be at least 60 x 120')
    bodies = {}
    for b in args.body:
        f, rng = b.split('=', 1)
        y0, y1 = (float(v) for v in rng.split(','))
        bodies[f] = (y0, y1)
    rep = run(Path(args.models).resolve(), args.files, bodies, args.gl, Path(args.three), Path(args.maps) if args.maps else None, args.cols, args.rows, args.max_depth_mm)
    if args.json:
        Path(args.json).write_text(json.dumps(rep, indent=1))
    return 0 if rep['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
