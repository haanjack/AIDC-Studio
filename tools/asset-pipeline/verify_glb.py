#!/usr/bin/env python3
"""Reload every GLB with pygltflib and print triangle counts, primitives, materials and bounding boxes."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
from pygltflib import GLTF2

COUNT = {5121: 1, 5123: 2, 5125: 4, 5126: 4}


def inspect(path: Path):
    g = GLTF2().load(str(path))
    blob = g.binary_blob()
    tris = 0
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    textures = len(g.images or [])
    for mesh in g.meshes:
        for p in mesh.primitives:
            acc = g.accessors[p.indices]
            tris += acc.count // 3
            pa = g.accessors[p.attributes.POSITION]
            bv = g.bufferViews[pa.bufferView]
            pos = np.frombuffer(blob, dtype=np.float32, count=pa.count * 3, offset=bv.byteOffset + (pa.byteOffset or 0)).reshape(-1, 3)
            if not np.allclose(pos.min(0), pa.min, atol=1e-4) or not np.allclose(pos.max(0), pa.max, atol=1e-4):
                raise RuntimeError(f'{path.name}: accessor min/max mismatch')
            lo = np.minimum(lo, pos.min(0))
            hi = np.maximum(hi, pos.max(0))
    prims = sum(len(m.primitives) for m in g.meshes)
    return {'file': path.name, 'tris': tris, 'primitives': prims, 'materials': len(g.materials or []), 'textures': textures,
            'min': np.round(lo, 3).tolist(), 'max': np.round(hi, 3).tolist(), 'size_whd': np.round(hi - lo, 3).tolist(),
            'kib': path.stat().st_size // 1024}


def main(argv=None):
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default=str(here / '../../apps/web/public/assets'))
    args = ap.parse_args(argv)
    ok = True
    for p in sorted((Path(args.out) / 'models').glob('*.glb')):
        try:
            r = inspect(p)
            centered = abs(r['min'][0] + r['max'][0]) < 0.25 and abs(r['min'][2] + r['max'][2]) < 0.35 and abs(r['min'][1]) < 0.05
            print(f"{r['file']:20s} tris={r['tris']:7d} prims={r['primitives']} mats={r['materials']} tex={r['textures']} "
                  f"size(w,h,d)={r['size_whd']} min={r['min']} max={r['max']} {r['kib']} KiB {'centered' if centered else 'NOT-CENTERED'}")
        except Exception as e:  # noqa: BLE001
            ok = False
            print(f'{p.name}: ERROR {e}')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
