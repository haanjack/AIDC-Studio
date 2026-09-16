#!/usr/bin/env python3
"""Convert Z-up OpenUSD equipment stages (authored by the AIDC asset pipeline, e.g. generic_usd.py) into web-ready GLB files
(with a low-poly LOD1).

GLB contract (consumed by the AIDC Studio three.js viewer):
    glTF Y-up, meters; footprint centered at the origin in XZ; base at y = 0;
    width along X, depth along Z; FRONT (cold-air intake / service side) faces -Z.

Pipeline per asset:
    USD stage (instance proxies, render/default purpose, visible) → world-space triangles
    → grouped per bound material → [exterior-shell culling of hidden internals]
    → weld → quadric decimation (pyfqmr) with vertex-clustering fallback when CAD shells stall
    → crease-angle normals → rotate so the native front becomes -Z → GLB (one primitive per material).
"""
from __future__ import annotations

import argparse
import io
import json
import math
import struct
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade

try:
    import fast_simplification
except ImportError:  # pragma: no cover
    fast_simplification = None

# name → conversion settings. `front` is the native USD axis the front faces.
# Per-asset conversion settings are passed in by the caller (e.g. generic_build.py _cfg(), or a JSON file via --config).
# Keys: usd (path relative to the source root), front ('+x' | '-x' | '+y' | '-y'), frontEvidence, tris, lod1, and optionally
# footprintFrom, cullInterior, crop_textures, lod1MinPart, snapNormalsDeg, snapNormalsLod1Deg.
# The converter only reads USD stages authored by the AIDC pipeline (or supplied by the user); it ships no third-party asset table.
ASSETS: dict[str, dict] = {}


def log(*a):
    print('[glb]', *a, flush=True)


# ─────────────────────────── USD extraction ───────────────────────────

@dataclass
class MatInfo:
    name: str
    base: tuple = (0.6, 0.6, 0.6)
    metallic: float = 0.0
    roughness: float = 0.5
    emissive: tuple = (0.0, 0.0, 0.0)
    texture: str | None = None


@dataclass
class Group:
    mat: MatInfo
    pos: list = field(default_factory=list)  # (n,3) world tris flattened per mesh
    uv: list = field(default_factory=list)  # (n,2) per corner or None
    textured: bool = False
    card: bool = False


def _inp(shader: UsdShade.Shader, *names):
    for n in names:
        i = shader.GetInput(n)
        if i:
            v = i.Get()
            if v is not None:
                return v
    return None


def read_material(mat: UsdShade.Material | None) -> MatInfo:
    if not mat:
        return MatInfo('default')
    info = MatInfo(mat.GetPrim().GetName())
    for prim in Usd.PrimRange(mat.GetPrim()):
        if not prim.IsA(UsdShade.Shader):
            continue
        sh = UsdShade.Shader(prim)
        sid = prim.GetAttribute('info:id').Get()
        mdl = prim.GetAttribute('info:mdl:sourceAsset').Get()
        if sid == 'UsdPreviewSurface':
            c = _inp(sh, 'diffuseColor')
            if c is not None:
                info.base = tuple(float(x) for x in c)
            m = _inp(sh, 'metallic')
            info.metallic = float(m) if m is not None else info.metallic
            r = _inp(sh, 'roughness')
            info.roughness = float(r) if r is not None else info.roughness
            e = _inp(sh, 'emissiveColor')
            if e is not None:
                info.emissive = tuple(float(x) for x in e)
        elif mdl is not None:
            c = _inp(sh, 'diffuse_color_constant')
            if c is not None:
                info.base = tuple(float(x) for x in c)
            t = _inp(sh, 'diffuse_texture')
            if isinstance(t, Sdf.AssetPath) and t.resolvedPath:
                info.texture = t.resolvedPath
            m = _inp(sh, 'metallic_constant')
            info.metallic = float(m) if m is not None else info.metallic
            r = _inp(sh, 'reflection_roughness_constant')
            info.roughness = float(r) if r is not None else info.roughness
            if _inp(sh, 'enable_emission'):
                e = _inp(sh, 'emissive_color')
                k = _inp(sh, 'emissive_intensity') or 0
                if e is not None and max(e) > 0 and k > 0:
                    info.emissive = tuple(min(1.0, float(x)) for x in e)
    return info


def extract(stage_path: Path, footprint_from: str | None):
    stage = Usd.Stage.Open(str(stage_path))
    mpu = UsdGeom.GetStageMetersPerUnit(stage) or 1.0
    up = UsdGeom.GetStageUpAxis(stage)
    xc = UsdGeom.XformCache()
    groups: dict[str, Group] = {}
    footprint = None
    it = iter(Usd.PrimRange.Stage(stage, Usd.TraverseInstanceProxies()))
    for prim in it:
        path = str(prim.GetPath())
        if 'ConnectionPoints' in prim.GetName():
            it.PruneChildren()
            continue
        if prim.IsA(UsdShade.Material):
            it.PruneChildren()
            continue
        if not prim.IsA(UsdGeom.Mesh):
            continue
        img = UsdGeom.Imageable(prim)
        mesh = UsdGeom.Mesh(prim)
        pts = mesh.GetPointsAttr().Get()
        counts = mesh.GetFaceVertexCountsAttr().Get()
        idx = mesh.GetFaceVertexIndicesAttr().Get()
        if not pts or not counts or not idx:
            continue
        m = np.array(xc.GetLocalToWorldTransform(prim), dtype=np.float64)
        P = np.asarray(pts, dtype=np.float64)
        P = (np.c_[P, np.ones(len(P))] @ m)[:, :3] * mpu
        if footprint_from and prim.GetName() == footprint_from:
            footprint = (P.min(0), P.max(0))
        if img.ComputeVisibility() == UsdGeom.Tokens.invisible:
            continue
        if img.ComputePurpose() in (UsdGeom.Tokens.guide, UsdGeom.Tokens.proxy):
            continue
        counts = np.asarray(counts, dtype=np.int64)
        idx = np.asarray(idx, dtype=np.int64)
        # fan triangulation over faceVertexIndices
        starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
        valid = counts >= 3
        ntri = counts[valid] - 2
        fstart = np.repeat(starts[valid], ntri)
        local = np.concatenate([np.arange(1, n + 1) for n in ntri]) if len(ntri) else np.zeros(0, dtype=np.int64)
        corners = np.stack([fstart, fstart + local, fstart + local + 1], 1)  # indices into faceVertexIndices
        left = mesh.GetOrientationAttr().Get() == UsdGeom.Tokens.leftHanded
        if left ^ (np.linalg.det(m[:3, :3]) < 0):
            corners = corners[:, [0, 2, 1]]
        tri_pos = P[idx[corners]]  # (t,3,3)
        mat, _ = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
        minfo = read_material(mat)
        key = minfo.name
        g = groups.get(key)
        if g is None:
            g = groups[key] = Group(minfo)
        uv = None
        if minfo.texture:
            pv = UsdGeom.PrimvarsAPI(prim).GetPrimvar('st')
            if pv and pv.HasValue():
                st = np.asarray(pv.ComputeFlattened(), dtype=np.float64)
                interp = pv.GetInterpolation()
                if interp == UsdGeom.Tokens.faceVarying:
                    uv = st[corners]
                elif interp in (UsdGeom.Tokens.vertex, UsdGeom.Tokens.varying):
                    uv = st[idx[corners]]
            if uv is not None:
                g.textured = True
        g.pos.append(tri_pos)
        g.uv.append(uv)
        if len(counts) <= 4:
            g.card = True
    return groups, footprint, up


# ─────────────────────────── geometry ops ───────────────────────────

def weld(tris: np.ndarray, tol=1e-5):
    flat = tris.reshape(-1, 3)
    q = np.round(flat / tol).astype(np.int64)
    uniq, inv = np.unique(q, axis=0, return_inverse=True)
    verts = np.zeros((len(uniq), 3))
    np.add.at(verts, inv.reshape(-1), flat)
    cnt = np.bincount(inv.reshape(-1), minlength=len(uniq))
    verts /= cnt[:, None]
    faces = inv.reshape(-1, 3)
    ok = (faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 0] != faces[:, 2])
    return verts, faces[ok]


def drop_small_parts(verts, faces, min_diag):
    """Remove connected components whose bounding-box diagonal is below min_diag (screws, perforations)."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    n = len(verts)
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]]])
    g = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n))
    ncomp, lab = connected_components(g, directed=False)
    lo = np.full((ncomp, 3), np.inf)
    hi = np.full((ncomp, 3), -np.inf)
    np.minimum.at(lo, lab, verts)
    np.maximum.at(hi, lab, verts)
    diag = np.linalg.norm(hi - lo, axis=1)
    keep_comp = diag >= min_diag
    keep = keep_comp[lab[faces[:, 0]]]
    return faces[keep]


def exterior_shell_masks(tri_sets: list, max_voxels=260):
    """Keep only triangles reachable from outside: voxelize all triangles, flood-fill exterior air from the
    bounding box, keep triangles with a sample inside a 2-voxel band around the exterior."""
    from scipy import ndimage

    allp = np.concatenate([t.reshape(-1, 3) for t in tri_sets])
    lo = allp.min(0)
    hi = allp.max(0)
    h = float((hi - lo).max()) / max_voxels
    dims = np.ceil((hi - lo) / h).astype(int) + 5
    occ = np.zeros(dims, dtype=bool)
    samples_per_set = []
    bary_cache = {}

    def bary(n):
        if n not in bary_cache:
            g = np.linspace(0, 1, n)
            u, v = np.meshgrid(g, g)
            m = (u + v) <= 1.0
            bary_cache[n] = np.stack([u[m], v[m]], 1)
        return bary_cache[n]

    for tris in tri_sets:
        edge = np.max(np.stack([np.linalg.norm(tris[:, 1] - tris[:, 0], axis=1), np.linalg.norm(tris[:, 2] - tris[:, 1], axis=1),
                                np.linalg.norm(tris[:, 0] - tris[:, 2], axis=1)], 1), axis=1)
        level = np.clip(np.ceil(edge / h).astype(int) + 1, 2, 24)
        idx_all = []
        tri_ids = []
        for n in np.unique(level):
            sel = np.where(level == n)[0]
            b = bary(int(n))
            p = tris[sel, 0][:, None, :] + b[None, :, 0:1] * (tris[sel, 1] - tris[sel, 0])[:, None, :] + b[None, :, 1:2] * (tris[sel, 2] - tris[sel, 0])[:, None, :]
            vi = np.floor((p - lo) / h).astype(int) + 2
            occ[vi[..., 0], vi[..., 1], vi[..., 2]] = True
            idx_all.append(vi.reshape(-1, 3))
            tri_ids.append(np.repeat(sel, b.shape[0]))
        samples_per_set.append((np.concatenate(idx_all), np.concatenate(tri_ids), len(tris)))
    solid = ndimage.binary_dilation(occ, iterations=1)
    free = ~solid
    lab, _ = ndimage.label(free)
    exterior = lab == lab[0, 0, 0]
    band = ndimage.binary_dilation(exterior, iterations=2)
    masks = []
    for vi, tid, n in samples_per_set:
        hit = band[vi[:, 0], vi[:, 1], vi[:, 2]]
        keep = np.zeros(n, dtype=bool)
        np.logical_or.at(keep, tid, hit)
        masks.append(keep)
    return masks, h


def vertex_cluster(verts, faces, cell):
    q = np.floor(verts / cell).astype(np.int64)
    uq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    nv = np.zeros((len(uq), 3))
    np.add.at(nv, inv, verts)
    nv /= np.bincount(inv, minlength=len(uq))[:, None]
    nf = inv[faces]
    ok = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    nf = nf[ok]
    _, first = np.unique(np.sort(nf, axis=1), axis=0, return_index=True)
    return nv, nf[np.sort(first)]


def decimate(verts, faces, target, min_part=0.0):
    """Quadric simplification first; CAD shells with many borders stall around 1/3, so fall back to
    vertex clustering with a bisected cell size until the triangle budget is met."""
    if min_part > 0 and len(faces) > target:
        faces = drop_small_parts(verts, faces, min_part)
    if len(faces) <= target:
        return verts, faces
    # quadric collapses with free borders can place vertices outside the part; clamp to the source bounds
    used = verts[np.unique(faces)]
    bb_lo, bb_hi = used.min(0), used.max(0)
    verts, faces = _decimate_inner(verts, faces, target)
    return np.clip(verts, bb_lo, bb_hi), faces


def _decimate_inner(verts, faces, target):
    try:
        import pyfqmr

        s = pyfqmr.Simplify()
        s.setMesh(verts.astype(np.float64), faces.astype(np.int32))
        s.simplify_mesh(target_count=int(target), aggressiveness=7, preserve_border=False, verbose=False)
        v, f, _ = s.getMesh()
        verts, faces = np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64)
    except ImportError:
        if fast_simplification is not None:
            red = 1.0 - target / len(faces)
            v, f = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int32), target_reduction=red, agg=7)
            verts, faces = v.astype(np.float64), f.astype(np.int64)
    if len(faces) <= target * 1.1:
        return verts, faces
    lo, hi = 1e-4, 0.3
    best = None
    for _ in range(16):
        cell = math.sqrt(lo * hi)
        nv, nf = vertex_cluster(verts, faces, cell)
        if len(nf) > target:
            lo = cell
        else:
            hi = cell
            best = (nv, nf)
        if best is not None and len(best[1]) > target * 0.85:
            break
    return best if best is not None else vertex_cluster(verts, faces, hi)


def snap_axis(n: np.ndarray, snap_deg: float) -> np.ndarray:
    """Snap unit vectors to the nearest principal axis when within snap_deg (cabinets are axis-aligned boxes;
    shiny metal panels otherwise show decimation ripples in reflections)."""
    if snap_deg <= 0:
        return n
    k = np.argmax(np.abs(n), axis=1)
    comp = np.abs(n[np.arange(len(n)), k])
    snap = comp >= math.cos(math.radians(snap_deg))
    out = n.copy()
    axis = np.zeros_like(n[snap])
    axis[np.arange(snap.sum()), k[snap]] = np.sign(n[snap, k[snap]])
    out[snap] = axis
    return out


def crease_normals(verts, faces, angle_deg=35.0, snap_deg=0.0):
    """Split vertices where the face normal deviates from the area-weighted vertex normal."""
    a, b, c = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    fn = np.cross(b - a, c - a)
    area = np.linalg.norm(fn, axis=1, keepdims=True)
    keep = area[:, 0] > 1e-14
    faces, fn, area = faces[keep], fn[keep], area[keep]
    fnu = fn / area
    vn = np.zeros_like(verts)
    for k in range(3):
        np.add.at(vn, faces[:, k], fn)
    vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-20)
    cos_t = math.cos(math.radians(angle_deg))
    corner_v = faces.reshape(-1)
    corner_fn = np.repeat(fnu, 3, axis=0)
    smooth = np.einsum('ij,ij->i', vn[corner_v], corner_fn) >= cos_t
    corner_n = snap_axis(np.where(smooth[:, None], vn[corner_v], corner_fn), snap_deg)
    key = np.c_[corner_v, np.round(corner_n * 64).astype(np.int64)]
    uniq, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    out_pos = verts[uniq[:, 0]]
    out_n = np.zeros((len(uniq), 3))
    np.add.at(out_n, inv, corner_n)
    out_n /= np.maximum(np.linalg.norm(out_n, axis=1, keepdims=True), 1e-20)
    return out_pos, out_n, inv.reshape(-1, 3)


def to_gltf_frame(P: np.ndarray, front: str, center: np.ndarray, zmin: float) -> np.ndarray:
    """USD Z-up world → centered, front rotated to +X, then (x,y,z)_gltf = (-y, z, -x)."""
    x, y, z = P[..., 0] - center[0], P[..., 1] - center[1], P[..., 2] - zmin
    if front == '-x':
        x, y = -x, -y
    elif front == '+y':
        x, y = y, -x
    elif front == '-y':
        x, y = -y, x
    return np.stack([-y, z, -x], axis=-1)


# ─────────────────────────── textures ───────────────────────────

def cropped_texture(path: str, uv: np.ndarray, max_h=1024):
    img = Image.open(path).convert('RGB')
    W, H = img.size
    u0, u1 = float(uv[..., 0].min()), float(uv[..., 0].max())
    v0, v1 = float(uv[..., 1].min()), float(uv[..., 1].max())
    box = (int(math.floor(u0 * W)), int(math.floor((1 - v1) * H)), int(math.ceil(u1 * W)), int(math.ceil((1 - v0) * H)))
    crop = img.crop(box)
    cw, ch = crop.size
    out_h = min(max_h, 1 << int(math.floor(math.log2(ch))))
    out_w = max(64, 1 << int(round(math.log2(max(1, cw * out_h / ch)))))
    crop = crop.resize((out_w, out_h), Image.LANCZOS)
    buf = io.BytesIO()
    crop.save(buf, 'JPEG', quality=88)
    # remap uv to the crop: gltf v = 0 at image top
    bu0, bv_top, bu1, bv_bot = box[0] / W, box[1] / H, box[2] / W, box[3] / H
    new_u = (uv[..., 0] - bu0) / (bu1 - bu0)
    img_v = 1.0 - uv[..., 1]
    new_v = (img_v - bv_top) / (bv_bot - bv_top)
    return buf.getvalue(), np.stack([new_u, new_v], -1), (out_w, out_h)


def full_texture(path: str, max_size=1024):
    img = Image.open(path).convert('RGB')
    img.thumbnail((max_size, max_size), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=88)
    return buf.getvalue(), img.size


# ─────────────────────────── GLB writer ───────────────────────────

class GlbBuilder:
    def __init__(self):
        self.bin = bytearray()
        self.buffer_views = []
        self.accessors = []
        self.images = []
        self.textures = []
        self.materials = []
        self.primitives = []

    def _view(self, data: bytes, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        bv = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            bv['target'] = target
        self.bin.extend(data)
        self.buffer_views.append(bv)
        return len(self.buffer_views) - 1

    def _accessor(self, arr: np.ndarray, kind: str, comp: int, target, minmax=False):
        view = self._view(arr.tobytes(), target)
        acc = {'bufferView': view, 'componentType': comp, 'count': int(arr.shape[0]), 'type': kind}
        if minmax:
            acc['min'] = [float(v) for v in arr.min(0)]
            acc['max'] = [float(v) for v in arr.max(0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_material(self, m: MatInfo, texture_bytes: bytes | None):
        mat = {
            'name': m.name,
            'pbrMetallicRoughness': {
                'baseColorFactor': [*(float(c) for c in m.base), 1.0],
                'metallicFactor': float(np.clip(m.metallic, 0, 1)),
                'roughnessFactor': float(np.clip(m.roughness, 0.02, 1)),
            },
            'doubleSided': True,
        }
        if any(c > 0 for c in m.emissive):
            mat['emissiveFactor'] = [float(c) for c in m.emissive]
        if texture_bytes:
            view = self._view(texture_bytes)
            self.images.append({'bufferView': view, 'mimeType': 'image/jpeg'})
            self.textures.append({'source': len(self.images) - 1, 'sampler': 0})
            mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': len(self.textures) - 1}
        self.materials.append(mat)
        return len(self.materials) - 1

    def add_primitive(self, pos, nrm, idx, mat_index, uv=None):
        pos = pos.astype(np.float32)
        nrm = nrm.astype(np.float32)
        attrs = {
            'POSITION': self._accessor(pos, 'VEC3', 5126, 34962, minmax=True),
            'NORMAL': self._accessor(nrm, 'VEC3', 5126, 34962),
        }
        if uv is not None:
            attrs['TEXCOORD_0'] = self._accessor(uv.astype(np.float32), 'VEC2', 5126, 34962)
        if len(pos) < 65536:
            ind = idx.astype(np.uint16).reshape(-1)
            comp = 5123
        else:
            ind = idx.astype(np.uint32).reshape(-1)
            comp = 5125
        view = self._view(ind.tobytes(), 34963)
        self.accessors.append({'bufferView': view, 'componentType': comp, 'count': int(ind.shape[0]), 'type': 'SCALAR'})
        self.primitives.append({'attributes': attrs, 'indices': len(self.accessors) - 1, 'material': mat_index, 'mode': 4})

    def write(self, path: Path, name: str, extras: dict):
        gltf = {
            'asset': {'version': '2.0', 'generator': 'aidc-studio asset-pipeline usd_to_glb.py', 'extras': extras},
            'scene': 0,
            'scenes': [{'nodes': [0]}],
            'nodes': [{'name': name, 'mesh': 0}],
            'meshes': [{'name': name, 'primitives': self.primitives}],
            'materials': self.materials,
            'accessors': self.accessors,
            'bufferViews': self.buffer_views,
            'buffers': [{'byteLength': 0}],
        }
        if self.images:
            gltf['images'] = self.images
            gltf['textures'] = self.textures
            gltf['samplers'] = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}]
        while len(self.bin) % 4:
            self.bin.append(0)
        gltf['buffers'][0]['byteLength'] = len(self.bin)
        js = json.dumps(gltf, separators=(',', ':')).encode()
        while len(js) % 4:
            js += b' '
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<III', 0x46546C67, 2, total))
            f.write(struct.pack('<II', len(js), 0x4E4F534A))
            f.write(js)
            f.write(struct.pack('<II', len(self.bin), 0x004E4942))
            f.write(self.bin)


# ─────────────────────────── conversion ───────────────────────────

def convert(name: str, cfg: dict, src_root: Path, out_dir: Path):
    src = src_root / cfg['usd']
    log(f'{name}: reading {src}')
    groups, footprint, up = extract(src, cfg.get('footprintFrom'))
    if up != 'Z':
        raise RuntimeError(f'{name}: expected Z-up stage, got {up}')
    all_pos = np.concatenate([np.concatenate(g.pos) for g in groups.values()])
    if footprint is None:
        lo, hi = all_pos.reshape(-1, 3).min(0), all_pos.reshape(-1, 3).max(0)
    else:
        lo, hi = footprint
    center = (lo + hi) / 2
    zmin = float(lo[2]) if footprint is not None else float(all_pos.reshape(-1, 3)[:, 2].min())
    raw_total = sum(sum(len(p) for p in g.pos) for g in groups.values())
    if cfg.get('cullInterior'):
        keys = [k for k, g in groups.items() if not g.textured]
        sets = [np.concatenate(groups[k].pos) for k in keys]
        masks, vox = exterior_shell_masks(sets)
        for k, tris, m in zip(keys, sets, masks):
            groups[k].pos = [tris[m]]
            groups[k].uv = [None]
        groups = {k: g for k, g in groups.items() if sum(len(p) for p in g.pos) > 0}
        kept = sum(sum(len(p) for p in g.pos) for g in groups.values())
        log(f'{name}: exterior-shell culling @ {vox*1000:.1f} mm voxels kept {kept:,}/{raw_total:,} tris')
    src_tris = {k: sum(len(p) for p in g.pos) for k, g in groups.items()}
    total_src = sum(src_tris.values())
    log(f'{name}: {total_src:,} source tris in {len(groups)} materials {src_tris}')

    reports = {}
    for lod, budget in (('lod0', cfg['tris']), ('lod1', cfg['lod1'])):
        b = GlbBuilder()
        # keep small groups intact, share the remaining budget proportionally
        small = {k for k, n in src_tris.items() if n <= max(300, 0.01 * total_src) or groups[k].textured}
        fixed = sum(src_tris[k] for k in small)
        big_total = max(1, total_src - fixed)
        remaining = max(budget - fixed, budget * 0.5)
        out_tris = 0
        for key, g in groups.items():
            tris = np.concatenate(g.pos)
            tex_bytes = None
            uv = None
            if g.textured and all(u is not None for u in g.uv):
                uv_src = np.concatenate(g.uv)
                if cfg.get('crop_textures'):
                    tex_bytes, uv, _ = cropped_texture(g.mat.texture, uv_src)
                else:
                    tex_bytes, _ = full_texture(g.mat.texture)
                    uv = np.stack([uv_src[..., 0], 1 - uv_src[..., 1]], -1)
            T = to_gltf_frame(tris, cfg['front'], center, zmin)
            mi = b.add_material(g.mat, tex_bytes)
            if uv is not None:
                # un-indexed textured cards: normal points away from the asset's vertical axis
                pos = T.reshape(-1, 3)
                fn = np.cross(T[:, 1] - T[:, 0], T[:, 2] - T[:, 0])
                fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-20)
                cen = T.mean(1)
                outward = np.einsum('ij,ij->i', fn, np.c_[cen[:, 0], np.zeros(len(cen)), cen[:, 2]]) >= 0
                fn[~outward] *= -1
                faces = np.arange(len(pos)).reshape(-1, 3)
                faces[~outward] = faces[~outward][:, [0, 2, 1]]
                nrm = np.repeat(fn, 3, axis=0)
                b.add_primitive(pos, nrm, faces, mi, uv.reshape(-1, 2))
                out_tris += len(faces)
                continue
            verts, faces = weld(T)
            if key not in small or lod == 'lod1':
                if key in small:
                    target = max(64, int(len(faces) * budget / max(budget, total_src) * 4))
                else:
                    target = int(remaining * src_tris[key] / big_total)
                min_part = 0.0 if lod == 'lod0' else cfg.get('lod1MinPart', 0.08)
                verts, faces = decimate(verts, faces, max(64, target), min_part=min_part)
            if len(faces) == 0:
                continue
            pos, nrm, idx = crease_normals(verts, faces, snap_deg=cfg.get('snapNormalsDeg', 12.0) if lod == 'lod0' else cfg.get('snapNormalsLod1Deg', 25.0))
            if len(idx) == 0:
                continue
            b.add_primitive(pos, nrm, idx, mi)
            out_tris += len(idx)
        allp = np.concatenate([np.frombuffer(bytes(b.bin[b.buffer_views[a['bufferView']]['byteOffset']:b.buffer_views[a['bufferView']]['byteOffset'] + b.buffer_views[a['bufferView']]['byteLength']]), dtype=np.float32).reshape(-1, 3) for a in (b.accessors[p['attributes']['POSITION']] for p in b.primitives)])
        dims = (allp.max(0) - allp.min(0)).tolist()
        fname = f'{name}.glb' if lod == 'lod0' else f'{name}_lod1.glb'
        extras = {
            'source': cfg['usd'], 'lod': lod, 'triangles': out_tris, 'front': '-Z', 'nativeFront': cfg['front'],
            'frontEvidence': cfg['frontEvidence'], 'dimsXYZ': [round(v, 4) for v in dims],
        }
        b.write(out_dir / fname, name, extras)
        size = (out_dir / fname).stat().st_size
        log(f'{name} {lod}: {out_tris:,} tris, dims(w,h,d)={np.round(dims, 3).tolist()}, {size/1024:.0f} KiB')
        reports[lod] = {'file': fname, 'triangles': out_tris, 'bytes': size, 'dims': {'w': round(dims[0], 3), 'h': round(dims[1], 3), 'd': round(dims[2], 3)}}
    return {
        'name': name,
        'file': reports['lod0']['file'],
        'lod1': reports['lod1']['file'],
        'triangles': reports['lod0']['triangles'],
        'lod1Triangles': reports['lod1']['triangles'],
        'bytes': reports['lod0']['bytes'],
        'lod1Bytes': reports['lod1']['bytes'],
        'measuredDims': reports['lod0']['dims'],
        'sourceUsd': cfg['usd'],
        'sourceTriangles': total_src,
        'nativeFront': cfg['front'],
        'frontDetection': cfg['frontEvidence'],
        'footprintFrom': cfg.get('footprintFrom', 'geometry bounds'),
    }


def main(argv=None):
    """Convert the assets described by a JSON config ({"<name>": {<cfg>}}) found under --root into <out>/models/."""
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', required=True, help='directory the cfg "usd" paths are relative to')
    ap.add_argument('--config', required=True, help='JSON file {"<name>": {"usd": ..., "front": ..., "tris": ..., "lod1": ...}}')
    ap.add_argument('--out', default=str(here / '../../apps/web/public/assets'))
    ap.add_argument('--only', nargs='*', default=None)
    args = ap.parse_args(argv)
    assets = json.loads(Path(args.config).read_text())
    out_dir = Path(args.out) / 'models'
    out_dir.mkdir(parents=True, exist_ok=True)
    reports = []
    for name, cfg in assets.items():
        if args.only and name not in args.only:
            continue
        reports.append(convert(name, cfg, Path(args.root), out_dir))
    return reports


if __name__ == '__main__':
    main()
