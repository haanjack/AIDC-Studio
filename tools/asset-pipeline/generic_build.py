#!/usr/bin/env python3
"""Build the generic, vendor-neutral equipment models end-to-end (neutralization stream N1b):

    generic_spec.json ─▶ generic_usd.py (lod 0) ─▶ apps/web/public/assets/usd/Generic/<name>.usd (+ .usda)
                                               ─▶ usd_to_glb.convert(...) ─▶ models/<name>.glb
                      generic_usd.py (lod 1, temp) ─▶ usd_to_glb.convert(...) ─▶ models/<name>_lod1.glb (explicit, never decimated)
                      ─▶ checks: footprint = catalog dims, GLB ≤ 1 MB, LOD1 ≤ 300 KB
                      ─▶ generic_occlusion.py (ray grid front / rear, LOD0 + LOD1, + GL magenta ortho image) — fails the build
                      ─▶ render_thumbs.py --only <names> --no-manifest ─▶ thumbs/<name>.png
                      ─▶ generic_manifest.write(...) ─▶ manifest.json + models/_models_report.json (own entries only)
                      ─▶ CREDITS.json (append / replace the generic entries)

The GLB follows the viewer contract (glTF Y-up, metres, footprint centred, base y = 0, FRONT −Z); the USD is Z-up with
the front on +X, so usd_to_glb.py converts it unchanged (front '+x').

usage: generic_build.py [--out ASSETS] [--only NAME ...] [--no-gl-check] [--skip-thumbs] [--maps DIR]
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import generic_manifest  # noqa: E402
import generic_occlusion  # noqa: E402
import generic_usd  # noqa: E402
import usd_to_glb  # noqa: E402
import verify_glb  # noqa: E402
from gltf_extras import set_gltf_extras as _set_gltf_extras  # noqa: E402

LOD0_MAX_BYTES = 1_000_000
LOD1_MAX_BYTES = 300_000
LICENCE = generic_manifest.LICENCE
REPO = (HERE / '../..').resolve()


def _cfg(usd_rel: str, kind: str) -> dict:
    return {
        'usd': usd_rel,
        'front': '+x',
        'frontEvidence': f'authored by generic_usd.py: {"tray faceplates and spt_airvent_intake" if kind == "rack" else "service doors / fan section"} on USD +X; '
                         f'{"busbar, manifold and spt_liq_*" if kind == "rack" else "rear panels and connection stubs"} toward -X',
        # budgets far above the authored counts and lod1MinPart 0: the converter neither decimates nor drops parts
        'tris': 200000, 'lod1': 200000, 'lod1MinPart': 0.0, 'snapNormalsDeg': 12.0, 'snapNormalsLod1Deg': 12.0,
    }


def _credits(out: Path, entries: list[dict]):
    """Append / replace generic entries in assets/CREDITS.json without disturbing entries written by other streams."""
    path = out / 'CREDITS.json'
    data = json.loads(path.read_text()) if path.exists() else {}
    if isinstance(data, list):
        items, wrapper = data, None
    else:
        wrapper = data
        key = next((k for k in ('assets', 'entries', 'items', 'credits') if isinstance(data.get(k), list)), 'assets')
        items = data.setdefault(key, [])
    names = {e['path'] for e in entries}

    retired_generators = ('generic_build.py', 'helios_build.py', 'render_thumbs.py')

    def stale(e):
        """replaced by this build, or a generated file that no longer exists (superseded size, or the retired vendor-shaped
        wide-rack asset replaced by the generic wide OU rack on 2026-09-15)"""
        p = e.get('path') or e.get('file') or ''
        return p in names or (e.get('generated', True) and e.get('generator', '').endswith(retired_generators) and not (out / p).exists())

    items[:] = [e for e in items if not (isinstance(e, dict) and stale(e))] + entries
    if wrapper is not None:
        wrapper.setdefault('note', 'Provenance and licence of every file under apps/web/public/assets.')
    path.write_text(json.dumps(wrapper if wrapper is not None else items, indent=2) + '\n')
    print(f'[credits] {path}: {len(entries)} generic entries')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--spec', default=str(HERE / 'generic_spec.json'))
    ap.add_argument('--out', default=str(HERE / '../../apps/web/public/assets'))
    ap.add_argument('--only', nargs='*', default=None)
    ap.add_argument('--no-gl-check', action='store_true')
    ap.add_argument('--skip-thumbs', action='store_true')
    ap.add_argument('--maps', default=None, help='write straight-on see-through maps here')
    ap.add_argument('--json', default=None, help='write the build report (sizes, occlusion) here')
    args = ap.parse_args(argv)
    spec_path = Path(args.spec).resolve()
    spec = json.loads(spec_path.read_text())
    out = Path(args.out).resolve()
    models_dir = out / 'models'
    usd_dir = out / 'usd' / 'Generic'
    models_dir.mkdir(parents=True, exist_ok=True)

    todo = [(k, m) for k, m in generic_usd.models(spec) if not args.only or m['name'] in args.only]
    reports, bodies, failures = [], {}, []
    for kind, m in todo:
        name = m['name']
        u0 = generic_usd.build(spec_path, kind, m, usd_dir, lod=0)
        usd_rel = f'usd/Generic/{name}.usd'
        cfg = _cfg(usd_rel, kind)
        rep = usd_to_glb.convert(name, cfg, out, models_dir)
        with tempfile.TemporaryDirectory(prefix=f'{name}-lod1-') as tmp:
            tmp = Path(tmp)
            u1 = generic_usd.build(spec_path, kind, m, tmp, lod=1, stem=f'{name}_LOD1', usda=False)
            l1 = usd_to_glb.convert(name, {**cfg, 'usd': f'{name}_LOD1.usd'}, tmp, tmp)
            shutil.copyfile(tmp / f'{name}.glb', models_dir / rep['lod1'])
        extras = {'licence': LICENCE, 'generator': 'tools/asset-pipeline/generic_build.py', 'spec': 'tools/asset-pipeline/generic_spec.json'}
        _set_gltf_extras(models_dir / rep['file'], {**extras, 'lod': 'lod0'})
        _set_gltf_extras(models_dir / rep['lod1'], {**extras, 'lod': 'lod1', 'source': f'generic_usd.build(lod=1) of {usd_rel} (explicit low-detail stage, not decimated)'})
        rep['lod1Triangles'] = l1['triangles']
        rep['bytes'] = (models_dir / rep['file']).stat().st_size
        rep['lod1Bytes'] = (models_dir / rep['lod1']).stat().st_size
        info = u0['info']
        rep.update({
            'generated': True,
            'generator': 'tools/asset-pipeline/generic_build.py',
            'licence': LICENCE,
            'source': f'parametric: tools/asset-pipeline/generic_spec.json ({kind}); public standard facts listed in its "sources"',
            'sourceUsd': usd_rel,
            'kind': info['kind'],
            'description': m.get('description', ''),
            'usdMeshes': u0['meshes'],
            'lod1UsdMeshes': u1['meshes'],
            'lod1Generation': 'explicit: generic_usd.build(lod=1) — same opaque bodies and faceplates as LOD0; proud details as quads; no decimation',
            'catalogDims': m['dims_m'],
        })
        for k in ('formFactor', 'layout', 'units', 'unit', 'pitchMm', 'bandCounts', 'doors', 'fans', 'fanRows'):
            if k in info:
                rep[k] = info[k]
        # footprint and size checks
        for fname, lim in ((rep['file'], LOD0_MAX_BYTES), (rep['lod1'], LOD1_MAX_BYTES)):
            r = verify_glb.inspect(models_dir / fname)
            w, h, d = r['size_whd']
            dm = m['dims_m']
            exp_h = info.get('overallH', dm['h'])
            ok = abs(w - dm['w']) < 0.01 and abs(d - dm['d']) < 0.01 and abs(h - exp_h) < 0.02 and abs(r['min'][1]) < 1e-3
            ok_size = (models_dir / fname).stat().st_size <= lim
            print(f"[verify] {fname:34s} tris={r['tris']:6d} size(w,h,d)={r['size_whd']} expected=({dm['w']}, {exp_h:.3f}, {dm['d']}) {r['kib']} KiB "
                  f"{'dims-ok' if ok else 'DIMS-MISMATCH'} {'size-ok' if ok_size else 'OVER-BUDGET'}")
            if not ok:
                failures.append(f'{fname}: dims')
            if not ok_size:
                failures.append(f'{fname}: {(models_dir / fname).stat().st_size} bytes > {lim}')
        body_y = (0.0, float(m['dims_m']['h']))
        bodies[rep['file']] = body_y
        bodies[rep['lod1']] = body_y
        reports.append(rep)

    files = [f for r in reports for f in (r['file'], r['lod1'])]
    occ = generic_occlusion.run(models_dir, files, bodies, gl=not args.no_gl_check, maps_dir=Path(args.maps) if args.maps else None)
    for r in reports:
        r['occlusion'] = {
            'check': 'tools/asset-pipeline/generic_occlusion.py',
            'rays': {x['file']: {side: {'rays': sum(y['rays'] for y in res), 'fail': sum(y['fail'] for y in res), 'maxFirstHitDepthMm': max(y['maxDepthMm'] or 0 for y in res)}
                                 for side, res in x['sides'].items()} for x in occ['rays'] if x['file'] in (r['file'], r['lod1'])},
            'glMagentaPx': None if occ['gl'] is None else {f"{g['file']}:{g['side']}": g.get('magenta') for g in occ['gl'] if g['file'] in (r['file'], r['lod1'])},
        }
    if not occ['ok']:
        failures.append('occlusion')

    if not args.skip_thumbs:
        import render_thumbs
        res = render_thumbs.main(['--out', str(out), '--only', *[r['name'] for r in reports], '--no-manifest'])
        for n, ok in (res or {}).items():
            if not ok:
                failures.append(f'thumbnail {n}')

    if failures:
        print('[generic-build] FAILED:', failures, file=sys.stderr)
        if args.json:
            Path(args.json).write_text(json.dumps({'failures': failures, 'models': reports}, indent=1))
        return 1

    generic_manifest.write(out, reports, {'generic': {
        'usdDir': 'usd/Generic', 'spec': 'tools/asset-pipeline/generic_spec.json', 'generator': 'tools/asset-pipeline/generic_build.py',
        'notes': 'docs/research/neutral-N1b.md', 'builtAt': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'),
    }})
    credits = []
    for r in reports:
        for rel, kind in ((f"models/{r['file']}", 'model'), (f"models/{r['lod1']}", 'model-lod1'), (r['sourceUsd'], 'usd'), (r['sourceUsd'] + 'a', 'usda'),
                          (f"thumbs/{Path(r['file']).stem}.png", 'thumbnail')):
            p = out / rel
            if p.exists():
                credits.append({'path': rel, 'kind': kind, 'title': f"{r['name']} — {r.get('description', '')}".strip(' —'),
                                'authors': ['AIDC Studio'], 'license': LICENCE, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'bytes': p.stat().st_size,
                                'generator': 'tools/asset-pipeline/generic_build.py', 'source': 'tools/asset-pipeline/generic_spec.json (parametric; no third-party input)',
                                'generated': True, 'modified': False})
    _credits(out, credits)
    if args.json:
        Path(args.json).write_text(json.dumps({'failures': [], 'models': reports, 'occlusion': occ}, indent=1))
    print('[generic-build] OK:', ', '.join(r['name'] for r in reports))
    return 0


if __name__ == '__main__':
    sys.exit(main())
