#!/usr/bin/env python3
"""Ray kernel of the occlusion gate (generic_occlusion.py): GLB triangle loading, parallel-ray first hits on a lattice and
see-through map images. glTF frame: Y-up, metres, footprint centred, FRONT = -Z, rear = +Z.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from pygltflib import GLTF2

HERE = Path(__file__).resolve().parent
COMP_DTYPE = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def load_triangles(path: Path):
    """World-space triangles (t,3,3) plus per-triangle material names and the material alpha modes."""
    g = GLTF2().load(str(path))
    blob = g.binary_blob()

    def acc(i):
        a = g.accessors[i]
        bv = g.bufferViews[a.bufferView]
        n = NCOMP[a.type]
        arr = np.frombuffer(blob, dtype=COMP_DTYPE[a.componentType], count=a.count * n, offset=bv.byteOffset + (a.byteOffset or 0))
        return arr.reshape(-1, n) if n > 1 else arr

    tris, names = [], []
    for node in g.nodes:  # the pipeline writes one node without transforms
        if node.mesh is None:
            continue
        if node.matrix or node.rotation or node.translation or node.scale:
            raise RuntimeError(f'{path.name}: node transforms are not expected in pipeline GLBs')
        for p in g.meshes[node.mesh].primitives:
            pos = acc(p.attributes.POSITION).astype(np.float64)
            idx = acc(p.indices).astype(np.int64).reshape(-1, 3)
            tris.append(pos[idx])
            names += [g.materials[p.material].name] * len(idx)
    modes = {m.name: (m.alphaMode or 'OPAQUE') for m in g.materials}
    return np.concatenate(tris), np.array(names), modes


def parallel_first_hits(tris: np.ndarray, xs: np.ndarray, ys: np.ndarray, z_plane: float, d: np.ndarray):
    """Parallel rays through the regular lattice (xs × ys) on the plane z = z_plane, all with direction d.

    Every triangle is projected along d onto that plane (an affine map, so barycentrics are preserved), binned into
    the lattice by its 2-D bounding box and tested with 2-D barycentrics; the hit's z comes from the same
    barycentrics. Returns per lattice point (rows = ys, cols = xs): z of the nearest hit along d (nan = miss) and the
    triangle index (-1 = miss)."""
    k = (tris[..., 2] - z_plane) / d[2]  # ray parameter from the plane to each vertex
    fx = tris[..., 0] - k * d[0]
    fy = tris[..., 1] - k * d[1]
    area = (fx[:, 1] - fx[:, 0]) * (fy[:, 2] - fy[:, 0]) - (fx[:, 2] - fx[:, 0]) * (fy[:, 1] - fy[:, 0])
    live = np.abs(area) > 1e-12
    i0 = np.searchsorted(xs, fx.min(1) - 1e-9, 'left')
    i1 = np.searchsorted(xs, fx.max(1) + 1e-9, 'right')
    j0 = np.searchsorted(ys, fy.min(1) - 1e-9, 'left')
    j1 = np.searchsorted(ys, fy.max(1) + 1e-9, 'right')
    ni = np.where(live, np.maximum(i1 - i0, 0), 0)
    nj = np.where(live, np.maximum(j1 - j0, 0), 0)
    cnt = ni * nj
    nx = len(xs)
    best_k = np.full(len(xs) * len(ys), np.inf)
    best_t = np.full(len(xs) * len(ys), -1)
    tri_ids = np.nonzero(cnt)[0]
    # process in batches of candidate pairs to bound memory
    csum = np.cumsum(cnt[tri_ids])
    start = 0
    limit = 1 << 23
    while start < len(tri_ids):
        base = csum[start - 1] if start else 0
        stop = int(np.searchsorted(csum, base + limit, 'right'))
        stop = max(stop, start + 1)
        sel = tri_ids[start:stop]
        c = cnt[sel]
        t = np.repeat(sel, c)
        off = np.arange(len(t)) - np.repeat(np.cumsum(c) - c, c)
        ii = i0[t] + off % ni[t]
        jj = j0[t] + off // ni[t]
        px, py = xs[ii], ys[jj]
        ax, ay = fx[t, 0], fy[t, 0]
        w1 = ((px - ax) * (fy[t, 2] - ay) - (fx[t, 2] - ax) * (py - ay)) / area[t]
        w2 = ((fx[t, 1] - ax) * (py - ay) - (px - ax) * (fy[t, 1] - ay)) / area[t]
        w0 = 1 - w1 - w2
        eps = 1e-7
        inside = (w0 >= -eps) & (w1 >= -eps) & (w2 >= -eps)
        kk = w0 * k[t, 0] + w1 * k[t, 1] + w2 * k[t, 2]
        inside &= kk > -1.0  # hits behind the plane by more than 1 m cannot happen for an outside start; keep all in front
        lin = (jj * nx + ii)[inside]
        kk = kk[inside]
        t = t[inside]
        order = np.lexsort((kk, lin))
        lin, kk, t = lin[order], kk[order], t[order]
        first = np.r_[True, lin[1:] != lin[:-1]]
        lin, kk, t = lin[first], kk[first], t[first]
        better = kk < best_k[lin]
        best_k[lin[better]] = kk[better]
        best_t[lin[better]] = t[better]
        start = stop
    return best_k.reshape(len(ys), len(xs)), best_t.reshape(len(ys), len(xs))


def write_maps(maps: dict, out: Path, stem: str, max_depth: float):
    from PIL import Image

    out.mkdir(parents=True, exist_ok=True)
    for side, (bad, depth) in maps.items():
        g = np.clip(1.0 - np.nan_to_num(depth, nan=max_depth) / max_depth, 0, 1) * 200 + 30
        rgb = np.stack([g, g, g], -1)
        rgb[bad] = (255, 0, 255)
        img = rgb[::-1].astype(np.uint8)  # image top = rack top
        if side == 'rear':
            img = img[:, ::-1]  # seen from behind
        Image.fromarray(img).resize((img.shape[1] * 4, img.shape[0] * 4), Image.NEAREST).save(out / f'{stem}-{side}-seethrough.png')
