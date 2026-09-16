#!/usr/bin/env python3
"""Shared USD mesh / material helpers of the AIDC Studio asset pipeline (generic_usd.py).

Conventions of every generated stage: Z-up, metersPerUnit = 1, one UsdGeom.Mesh per (part group, look), opaque
UsdPreviewSurface looks whose `diffuseColor` / `emissiveColor` hold the LINEAR conversion of the sRGB hex values in the
parameter spec (the hex is kept as `aidc:srgbDiffuse`). No textures, no opacity inputs.
"""
from __future__ import annotations

import math

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade, Vt


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_rgb(h: str, linear: bool = True) -> Gf.Vec3f:
    """sRGB hex → Gf.Vec3f, linear by default (UsdPreviewSurface colour inputs and displayColor are linear)."""
    v = int(h.lstrip('#'), 16)
    rgb = [((v >> 16) & 255) / 255.0, ((v >> 8) & 255) / 255.0, (v & 255) / 255.0]
    if linear:
        rgb = [srgb_to_linear(c) for c in rgb]
    return Gf.Vec3f(*rgb)


# ─────────────────────────── materials ───────────────────────────

class Looks:
    def __init__(self, stage: Usd.Stage, root: str, table: dict | None = None):
        self.stage = stage
        self.root = root
        self.cache: dict[str, UsdShade.Material] = {}
        self.table = {k: v for k, v in (table or {}).items() if not k.startswith('$')}
        UsdGeom.Scope.Define(stage, root)

    def look(self, name: str) -> UsdShade.Material:
        t = self.table[name]
        return self.get(name, t['color'], metallic=t.get('metallic', 0.0), roughness=t.get('roughness', 0.6), emissive=t.get('emissive'))

    def get(self, name: str, color: str, metallic=0.0, roughness=0.6, emissive: str | None = None) -> UsdShade.Material:
        """Opaque UsdPreviewSurface (no opacity input is ever authored — the rack has no glass / door)."""
        if name in self.cache:
            return self.cache[name]
        path = f'{self.root}/{name}'
        mat = UsdShade.Material.Define(self.stage, path)
        sh = UsdShade.Shader.Define(self.stage, f'{path}/PreviewSurface')
        sh.CreateIdAttr('UsdPreviewSurface')
        sh.CreateInput('diffuseColor', Sdf.ValueTypeNames.Color3f).Set(hex_to_rgb(color))
        sh.CreateInput('metallic', Sdf.ValueTypeNames.Float).Set(float(metallic))
        sh.CreateInput('roughness', Sdf.ValueTypeNames.Float).Set(float(roughness))
        if emissive:
            sh.CreateInput('emissiveColor', Sdf.ValueTypeNames.Color3f).Set(hex_to_rgb(emissive))
        p = sh.GetPrim()
        a = p.CreateAttribute('aidc:srgbDiffuse', Sdf.ValueTypeNames.String, custom=True)
        a.Set(color)
        a.SetDocumentation('sRGB hex from the parameter spec; diffuseColor holds the linear conversion')
        if emissive:
            p.CreateAttribute('aidc:srgbEmissive', Sdf.ValueTypeNames.String, custom=True).Set(emissive)
        mat.CreateSurfaceOutput().ConnectToSource(sh.ConnectableAPI(), 'surface')
        self.cache[name] = mat
        return mat


# ─────────────────────────── mesh primitives ───────────────────────────

def box_geom(center, size):
    """Axis-aligned box → (points, counts, indices) with outward-facing quads (right-handed / CCW from outside)."""
    cx, cy, cz = center
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    p = [
        (cx - hx, cy - hy, cz - hz), (cx + hx, cy - hy, cz - hz), (cx + hx, cy + hy, cz - hz), (cx - hx, cy + hy, cz - hz),
        (cx - hx, cy - hy, cz + hz), (cx + hx, cy - hy, cz + hz), (cx + hx, cy + hy, cz + hz), (cx - hx, cy + hy, cz + hz),
    ]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
    return p, [4] * 6, [i for f in faces for i in f]


def quad_x(x, cy, cz, w, h):
    """Single quad in the plane x = const facing +X (the USD front) → (points, counts, indices)."""
    p = [(x, cy - w / 2, cz - h / 2), (x, cy + w / 2, cz - h / 2), (x, cy + w / 2, cz + h / 2), (x, cy - w / 2, cz + h / 2)]
    return p, [4], [0, 1, 2, 3]


def cyl_geom(p0, p1, radius: float, segments=12, caps=True, phase=0.0):
    """Cylinder from p0 to p1 (any axis) → (points, counts, indices). `phase` rotates the ring (π/8 on an octagon
    gives flat sides aligned with the frame axes — a cheap rounded square)."""
    a = Gf.Vec3d(*p0)
    b = Gf.Vec3d(*p1)
    axis = b - a
    length = axis.GetLength()
    if length <= 1e-9:
        raise ValueError('degenerate cylinder')
    axis = axis / length
    helper = Gf.Vec3d(0, 0, 1) if abs(axis[2]) < 0.9 else Gf.Vec3d(1, 0, 0)
    u = Gf.Cross(axis, helper).GetNormalized()
    v = Gf.Cross(axis, u).GetNormalized()
    pts = []
    for ring in (a, b):
        for k in range(segments):
            t = phase + 2 * math.pi * k / segments
            pts.append(tuple(ring + (u * math.cos(t) + v * math.sin(t)) * radius))
    counts, idx = [], []
    for k in range(segments):
        k2 = (k + 1) % segments
        idx += [k, k2, segments + k2, segments + k]
        counts.append(4)
    if caps:
        pts.append(tuple(a))
        pts.append(tuple(b))
        ca, cb = 2 * segments, 2 * segments + 1
        for k in range(segments):
            k2 = (k + 1) % segments
            idx += [ca, k2, k]
            counts.append(3)
            idx += [cb, segments + k, segments + k2]
            counts.append(3)
    return pts, counts, idx


def polyline_geom(points, radius: float, segments=6):
    """Open tube along a polyline (one uncapped cylinder per segment) → list of geoms."""
    return [cyl_geom(points[i], points[i + 1], radius, segments=segments, caps=False) for i in range(len(points) - 1)]


class MeshWriter:
    """Author UsdGeom.Mesh prims; `mesh` merges several box / cylinder geoms into one prim."""

    def __init__(self, stage: Usd.Stage):
        self.stage = stage
        self.tris = 0
        self.parts = 0

    def mesh(self, path: str, geoms, mat: UsdShade.Material, color: str | None = None) -> UsdGeom.Mesh:
        points, counts, indices = [], [], []
        for p, c, i in geoms:
            off = len(points)
            points += p
            counts += c
            indices += [j + off for j in i]
        m = UsdGeom.Mesh.Define(self.stage, path)
        m.CreatePointsAttr(Vt.Vec3fArray([Gf.Vec3f(*p) for p in points]))
        m.CreateFaceVertexCountsAttr(Vt.IntArray(counts))
        m.CreateFaceVertexIndicesAttr(Vt.IntArray(indices))
        m.CreateSubdivisionSchemeAttr('none')
        m.CreateOrientationAttr(UsdGeom.Tokens.rightHanded)
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        zs = [p[2] for p in points]
        m.CreateExtentAttr(Vt.Vec3fArray([Gf.Vec3f(min(xs), min(ys), min(zs)), Gf.Vec3f(max(xs), max(ys), max(zs))]))
        if color:
            m.CreateDisplayColorAttr(Vt.Vec3fArray([hex_to_rgb(color)]))
        UsdShade.MaterialBindingAPI.Apply(m.GetPrim()).Bind(mat)
        self.tris += sum(c - 2 for c in counts)
        self.parts += 1
        return m

    def box(self, path: str, center, size, mat: UsdShade.Material, color: str | None = None) -> UsdGeom.Mesh:
        return self.mesh(path, [box_geom(center, size)], mat, color)

    def cylinder(self, path: str, p0, p1, radius: float, mat: UsdShade.Material, segments=12, color: str | None = None) -> UsdGeom.Mesh:
        return self.mesh(path, [cyl_geom(p0, p1, radius, segments)], mat, color)


# ─────────────────────────── attributes ───────────────────────────

def author_attr(prim: Usd.Prim, name: str, type_name, value, doc: str):
    a = prim.CreateAttribute(name, type_name, custom=True)
    a.Set(value)
    a.SetDocumentation(doc)
