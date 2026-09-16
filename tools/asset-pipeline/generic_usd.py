#!/usr/bin/env python3
"""Generic, vendor-neutral parametric equipment models as USD (neutralization stream N1b).

Everything comes from `generic_spec.json`: standard rack FORM FACTORS (EIA-310 19-inch 42 U / 48 U, 21-inch OU rack
44 OU, wide OU rack 44 OU), band LAYOUTS that dress a form factor by configuration (compute / switch tray bands, power shelves,
management, blanks, stiffeners, rear busbar + liquid manifold), and cabinet designs for a CDU and a perimeter CRAH /
fan-wall sized from catalog dims. No logos, lettering, card art, display screens or vendor trade dress; neutral greys
only (no yellow / cyan / aqua, no saturated red / blue pipes — those hues belong to the app's information layers).

Conventions — usd_to_glb.py converts the stages unchanged (front '+x'); mesh / look helpers live in usd_mesh.py:
    Z-up, metersPerUnit = 1, kind = component, footprint centred in XY, base at z = 0,
    DEPTH along X, WIDTH along Y, FRONT (service / cold-aisle side) toward +X.
    /<Root>/Geometry/...          opaque meshes, one prim per look per part group
    /<Root>/ConnectionPoints/spt_* purpose=guide markers (excluded from the GLB)
    /<Root>/Looks/<look>           UsdPreviewSurface (sRGB hex from the spec converted to linear)
    attributes: aidc:* only (generator, spec, licence, form factor, units, pitch, source tags)

lod 0 = full detail; lod 1 = explicit low detail (same opaque bodies and faceplates, proud details as front quads, tiny
details omitted). Never decimated. Occlusion is gated by generic_occlusion.py.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from pxr import Kind, Sdf, Usd, UsdGeom, Vt  # noqa: E402

from usd_mesh import Looks, MeshWriter, author_attr, box_geom, cyl_geom  # noqa: E402

LICENCE = 'MIT (AIDC Studio original)'
GENERATOR = 'tools/asset-pipeline/generic_usd.py'
SPEC_FILE = 'tools/asset-pipeline/generic_spec.json'


# ─────────────────────────── geometry helpers ───────────────────────────

def quad_n(axis: str, sign: int, plane: float, c1: float, c2: float, s1: float, s2: float):
    """Single quad facing `sign` along `axis` ('x' | 'y' | 'z') at `plane`; (c1, c2) centre and (s1, s2) size in the two
    remaining axes in order (x: y,z · y: x,z · z: x,y)."""
    h1, h2 = s1 / 2, s2 / 2
    if axis == 'x':
        p = [(plane, c1 - h1, c2 - h2), (plane, c1 + h1, c2 - h2), (plane, c1 + h1, c2 + h2), (plane, c1 - h1, c2 + h2)]
    elif axis == 'y':
        p = [(c1 - h1, plane, c2 - h2), (c1 + h1, plane, c2 - h2), (c1 + h1, plane, c2 + h2), (c1 - h1, plane, c2 + h2)]
    else:
        p = [(c1 - h1, c2 - h2, plane), (c1 + h1, c2 - h2, plane), (c1 + h1, c2 + h2, plane), (c1 - h1, c2 + h2, plane)]
    # counter-clockwise seen from +axis for sign > 0 (x: y,z · y: z,x reversed · z: x,y)
    idx = [0, 1, 2, 3] if (sign > 0) == (axis != 'y') else [0, 3, 2, 1]
    return p, [4], idx


def ring_geom(center, radius: float, tube: float, axis_x_sign: int = 1, segments=16, sides=6):
    """Thin torus-like ring in the plane x = const (fan guard wire): polyline tubes around a circle."""
    cx, cy, cz = center
    pts = [(cx, cy + radius * math.cos(2 * math.pi * k / segments), cz + radius * math.sin(2 * math.pi * k / segments)) for k in range(segments + 1)]
    return [cyl_geom(pts[k], pts[k + 1], tube, segments=sides, caps=False) for k in range(segments)]


class Builder:
    """Collects geoms per (group path, look) and writes one mesh prim per pair."""

    def __init__(self, stage: Usd.Stage, root: str, palette: dict):
        self.stage = stage
        self.root = root
        self.looks = Looks(stage, f'{root}/Looks', palette)
        self.mw = MeshWriter(stage)
        self.parts: dict[tuple[str, str], list] = defaultdict(list)
        UsdGeom.Scope.Define(stage, f'{root}/Geometry')

    def add(self, group: str, look: str, geom):
        if isinstance(geom, list):
            self.parts[(group, look)].extend(geom)
        else:
            self.parts[(group, look)].append(geom)

    def flush(self):
        for (group, look), geoms in self.parts.items():
            if geoms:
                self.mw.mesh(f'{self.root}/Geometry/{group}/{look}', geoms, self.looks.look(look))
        self.parts.clear()

    def points(self, entries: list[tuple[str, tuple, tuple, dict]]):
        cp = UsdGeom.Scope.Define(self.stage, f'{self.root}/ConnectionPoints')
        UsdGeom.Imageable(cp.GetPrim()).CreatePurposeAttr(UsdGeom.Tokens.guide)
        marker = self.looks.get('Marker', '#808080', roughness=1.0)
        for name, pos, size, extra in entries:
            m = self.mw.box(f'{self.root}/ConnectionPoints/{name}', pos, size, marker)
            m.CreatePurposeAttr(UsdGeom.Tokens.guide)
            p = m.GetPrim()
            for k, v in extra.items():
                t = Sdf.ValueTypeNames.String if isinstance(v, str) else Sdf.ValueTypeNames.Float
                author_attr(p, f'aidc:{k}', t, v if isinstance(v, str) else float(v), 'Connection point attribute')


def _new_stage(path: Path, root_name: str, comment: str):
    stage = Usd.Stage.CreateNew(str(path))
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)
    stage.SetMetadata('comment', comment)
    root = UsdGeom.Xform.Define(stage, f'/{root_name}')
    prim = root.GetPrim()
    Usd.ModelAPI(prim).SetKind(Kind.Tokens.component)
    stage.SetDefaultPrim(prim)
    return stage, prim


def _common_attrs(prim, spec: dict, model: dict, kind: str, dims: dict, lod: int):
    S = Sdf.ValueTypeNames
    author_attr(prim, 'aidc:assetClass', S.String, kind, 'Generic equipment class')
    author_attr(prim, 'aidc:manufacturer', S.String, 'generic', 'Not a model of any vendor product')
    author_attr(prim, 'aidc:modelName', S.String, model['name'], 'Generic model name (form factor / size keyed)')
    author_attr(prim, 'aidc:description', S.String, model.get('description', ''), 'Description')
    author_attr(prim, 'aidc:assetVersion', S.String, spec.get('version', '1.0.0'), 'Asset revision')
    author_attr(prim, 'aidc:licence', S.String, LICENCE, 'Licence of this generated asset')
    author_attr(prim, 'aidc:generator', S.String, GENERATOR, 'AIDC Studio generator')
    author_attr(prim, 'aidc:specFile', S.String, SPEC_FILE, 'Parameter source')
    author_attr(prim, 'aidc:dimsMm', S.Float3, (float(dims['w'] * 1000), float(dims['d'] * 1000), float(dims['h'] * 1000)), 'W x D x H in mm (catalog-sized body)')
    author_attr(prim, 'aidc:nativeFront', S.String, '+X', 'Front axis (usd_to_glb maps it to glTF -Z)')
    author_attr(prim, 'aidc:colorSpace', S.String, 'linear', 'diffuseColor / emissiveColor are linear (sRGB hex in generic_spec.json palette)')
    author_attr(prim, 'aidc:lod', S.Int, int(lod), '0 = full detail, 1 = explicit low detail')


# ─────────────────────────── racks ───────────────────────────

def build_rack_stage(spec: dict, model: dict, path: Path, lod: int = 0) -> tuple[Usd.Stage, dict]:
    layout = spec['layouts'][model['layout']]
    ff_id = layout['form_factor']
    ff = spec['form_factors'][ff_id]
    dims = model['dims_m']
    W, D, H = dims['w'], dims['d'], dims['h']
    pitch = ff['pitch_mm'] / 1000.0
    n_units = int(ff['units'])
    panel_w = ff['panel_width_mm'] / 1000.0
    plinth = ff['plinth_mm'] / 1000.0
    top = ff['top_mm'] / 1000.0
    recess = ff['front_recess_mm'] / 1000.0
    it_h = n_units * pitch
    slack = H - plinth - top - it_h
    if slack < -1e-6:
        raise ValueError(f"{model['name']}: {n_units} x {pitch * 1000} mm does not fit in {H} m with plinth {plinth} and top {top}")
    it_bot = plinth + slack / 2
    it_top = it_bot + it_h
    lod1 = lod >= 1

    root_name = 'GenericRack'
    stage, prim = _new_stage(path, root_name, f"Generic {ff['label']} — {layout['label']}. Parametric asset generated by AIDC Studio {GENERATOR} from {SPEC_FILE}. Not a model of any vendor product; no logos or lettering.")
    _common_attrs(prim, spec, model, 'Compute Rack', dims, lod)
    S = Sdf.ValueTypeNames
    author_attr(prim, 'aidc:formFactor', S.String, ff_id, ff['label'])
    author_attr(prim, 'aidc:layout', S.String, model['layout'], layout['label'])
    author_attr(prim, 'aidc:units', S.Int, n_units, f"Rack units ({ff['unit']}) [{ff.get('pitch_tag', '')}]")
    author_attr(prim, 'aidc:unitPitchMm', S.Float, float(ff['pitch_mm']), f"{ff['unit']} pitch in mm [{ff.get('pitch_tag', '')}]")
    author_attr(prim, 'aidc:panelWidthMm', S.Float, float(ff['panel_width_mm']), f"Equipment faceplate width [{ff.get('panel_tag', '')}]")
    author_attr(prim, 'aidc:sourceTag', S.String, f"form factor: {ff.get('pitch_tag', '')}; frame: {ff['frame_mm']['tag']}; layout: {layout.get('tag', 'estimate')}", 'Provenance summary')
    if ff.get('standards'):
        author_attr(prim, 'aidc:standards', S.String, '; '.join(ff['standards']), 'Pinned standard documents the form-factor values come from (see generic_spec.json sources)')
    bus_cfg = ff.get('busbar') or {}
    if bus_cfg.get('from_front_mm') is not None:
        author_attr(prim, 'aidc:busbarDatumMm', S.Float, float(bus_cfg['from_front_mm']), f"Datum to IT busbar depth [{bus_cfg.get('tag', '')}]")
    for key, attr, doc in (('payload_kg', 'aidc:payloadKg', 'payload_tag'), ('it_shelf_kg_per_set', 'aidc:itShelfKgPerSet', 'payload_tag'), ('hac_seal_plane_mm', 'aidc:hacSealPlaneMm', 'hac_tag')):
        if ff.get(key) is not None:
            author_attr(prim, attr, S.Float, float(ff[key]), ff.get(doc, ''))

    b = Builder(stage, f'/{root_name}', spec['palette'])
    front_x = D / 2
    rear_x = -D / 2
    side_w = (W - panel_w) / 2  # vertical rail / cable-manager member each side of the equipment opening
    body_lo, body_hi = plinth, H - top

    # ── enclosure
    b.add('Enclosure', 'Plinth', box_geom((0, 0, plinth / 2), (D, W, plinth)))
    pockets = (ff.get('base') or {}).get('forklift_pockets')
    if pockets:
        n_p = int(pockets['count'])
        p_w = pockets['width_mm'] / 1000.0
        p_h = min(pockets['height_mm'] / 1000.0, plinth * 0.8)
        p_pitch = pockets.get('pitch_mm', 0) / 1000.0
        p_z = 0.012 + p_h / 2
        for k in range(n_p):
            off = (k - (n_p - 1) / 2) * p_pitch
            e_t = 0.012  # lighter edge frame so the dark channel reads against the dark plinth
            for sgn in (1, -1):
                faces = [('x', D / 2)] + ([('y', W / 2)] if pockets.get('sides') else [])
                for axis, half in faces:
                    # both layers stay within 0.8 mm of the face (as proud as the other face details) so grazing gate rays still land on the plinth
                    b.add('Enclosure', 'Stiffener', quad_n(axis, sgn, sgn * (half + 0.0004), off, p_z, p_w + 2 * e_t, p_h + 2 * e_t))
                    b.add('Enclosure', 'VentDark', quad_n(axis, sgn, sgn * (half + 0.0008), off, p_z, p_w, p_h))
    b.add('Enclosure', 'RackTop', box_geom((0, 0, (body_hi + H) / 2), (D, W, H - body_hi)))
    for sy in (-1, 1):
        # side panels (full depth)
        b.add('Enclosure', 'RackSide', box_geom((0, sy * (W / 2 - 0.01), (body_lo + body_hi) / 2), (D, 0.02, body_hi - body_lo)))
        # front rail members: as deep as the recess plus a little, flush with the frame front
        b.add('Enclosure', 'RackRail', box_geom((front_x - (recess + 0.03) / 2, sy * (W / 2 - side_w / 2), (body_lo + body_hi) / 2), (recess + 0.03, side_w, body_hi - body_lo)))
        # rear posts
        b.add('Enclosure', 'RackFrame', box_geom((rear_x + 0.02, sy * (W / 2 - 0.03), (body_lo + body_hi) / 2), (0.04, 0.06, body_hi - body_lo)))
    # front header / sill close the strips above and below the IT opening over the recess depth
    if body_hi - it_top > 1e-4:
        b.add('Enclosure', 'RackFrame', box_geom((front_x - recess / 2, 0, (it_top + body_hi) / 2), (recess, panel_w, body_hi - it_top)))
    if it_bot - body_lo > 1e-4:
        b.add('Enclosure', 'RackFrame', box_geom((front_x - recess / 2, 0, (body_lo + it_bot) / 2), (recess, panel_w, it_bot - body_lo)))
    # rear top / bottom rails
    b.add('Enclosure', 'RackFrame', box_geom((rear_x + 0.02, 0, body_hi - 0.02), (0.04, W - 0.04, 0.04)))
    b.add('Enclosure', 'RackFrame', box_geom((rear_x + 0.02, 0, body_lo + 0.02), (0.04, W - 0.04, 0.04)))
    # opaque bulkheads: no line of sight through the rack at any LOD (generic_occlusion.py gates it)
    face_d = 0.015
    xf = front_x - recess  # faceplate front plane
    bh_t = 0.010
    b.add('Enclosure', 'Bulkhead', box_geom((xf - face_d - 0.002 - bh_t / 2, 0, (body_lo + body_hi) / 2), (bh_t, W - 0.03, body_hi - body_lo)))
    rear_zone = ff.get('rear_zone_mm', 150) / 1000.0
    rb_x = rear_x + rear_zone - 0.02 - bh_t / 2
    b.add('Enclosure', 'Bulkhead', box_geom((rb_x, 0, (body_lo + body_hi) / 2), (bh_t, W - 0.03, body_hi - body_lo)))

    # ── bands
    covered = [0] * (n_units + 1)
    bands = sorted(layout['bands'], key=lambda r: r[0])
    face_x = xf - face_d / 2
    gap = 0.0015

    def proud(t, off=0.0):
        return xf + off + t / 2

    def detail(group, look, center, size, keep_lod1=True):
        if not lod1:
            b.add(group, look, box_geom(center, size))
        elif keep_lod1:
            b.add(group, look, quad_n('x', 1, center[0] + size[0] / 2, center[1], center[2], size[1], size[2]))

    def face_compute(g, zc, h, yc=0.0, pw=panel_w):
        Y = (lambda v: v) if not yc else (lambda v: yc + v)
        b.add(g, 'TrayCompute', box_geom((face_x, Y(0), zc), (face_d, pw - 0.002, h)))
        detail(g, 'VentDark', (proud(0.002), Y(-0.07 * pw / 0.4826), zc), (0.002, pw * 0.42, h * 0.56))
        detail(g, 'PortCage', (proud(0.004), Y(pw * 0.24), zc), (0.004, pw * 0.2, h * 0.62))
        for k in range(4):
            detail(g, 'VentDark', (proud(0.002, 0.004), Y(pw * 0.24 + (k - 1.5) * pw * 0.045), zc), (0.002, pw * 0.03, h * 0.3), keep_lod1=False)
        for sy in (-1, 1):
            detail(g, 'Handle', (proud(0.012), Y(sy * (pw / 2 - 0.022)), zc), (0.012, 0.014, h * 0.62))
        detail(g, 'StatusLamp', (proud(0.002), Y(-pw / 2 + 0.05), zc + h * 0.18), (0.002, 0.006, 0.004), keep_lod1=False)

    def face_switch(g, zc, h, yc=0.0, pw=panel_w):
        Y = (lambda v: v) if not yc else (lambda v: yc + v)
        b.add(g, 'TraySwitch', box_geom((face_x, Y(0), zc), (face_d, pw - 0.002, h)))
        field_w = pw * 0.64
        detail(g, 'PortCage', (proud(0.004), Y(pw * 0.03), zc), (0.004, field_w, h * 0.64))
        cols = 12
        for r in (-1, 1):
            for c in range(cols):
                detail(g, 'VentDark', (proud(0.002, 0.004), Y(pw * 0.03 + (c - (cols - 1) / 2) * field_w / cols), zc + r * h * 0.15), (0.002, field_w / cols * 0.7, h * 0.22), keep_lod1=False)
        for sy in (-1, 1):
            detail(g, 'Handle', (proud(0.012), Y(sy * (pw / 2 - 0.022)), zc), (0.012, 0.014, h * 0.62))
        detail(g, 'StatusLamp', (proud(0.002), Y(-pw / 2 + 0.05), zc + h * 0.18), (0.002, 0.006, 0.004), keep_lod1=False)

    def face_power(g, zc, h, yc=0.0, pw=panel_w):
        Y = (lambda v: v) if not yc else (lambda v: yc + v)
        b.add(g, 'TrayPower', box_geom((face_x, Y(0), zc), (face_d, pw - 0.002, h)))
        mods = 6
        mw_ = (pw - 0.002) / mods
        for k in range(1, mods):
            detail(g, 'VentDark', (proud(0.001), Y(-pw / 2 + k * mw_), zc), (0.001, 0.003, h * 0.9))
        for k in range(mods):
            yk = -pw / 2 + (k + 0.5) * mw_
            detail(g, 'Handle', (proud(0.008), Y(yk), zc - h * 0.2), (0.008, mw_ * 0.45, 0.006))
            detail(g, 'StatusLamp', (proud(0.002), Y(yk + mw_ * 0.32), zc + h * 0.22), (0.002, 0.005, 0.004), keep_lod1=False)

    def face_mgmt(g, zc, h, yc=0.0, pw=panel_w):
        Y = (lambda v: v) if not yc else (lambda v: yc + v)
        b.add(g, 'TrayMgmt', box_geom((face_x, Y(0), zc), (face_d, pw - 0.002, h)))
        strip_w = pw * 0.6
        detail(g, 'PortCage', (proud(0.003), Y(-pw * 0.08), zc), (0.003, strip_w, h * 0.5))
        for k in range(24):
            detail(g, 'VentDark', (proud(0.002, 0.003), Y(-pw * 0.08 + (k - 11.5) * strip_w / 24), zc), (0.002, strip_w / 24 * 0.7, h * 0.3), keep_lod1=False)
        detail(g, 'StatusLamp', (proud(0.002), Y(pw / 2 - 0.04), zc), (0.002, 0.006, 0.004), keep_lod1=False)

    def face_blank(g, zc, h, yc=0.0, pw=panel_w):
        Y = (lambda v: v) if not yc else (lambda v: yc + v)
        b.add(g, 'TrayBlank', box_geom((face_x, Y(0), zc), (face_d, pw - 0.002, h)))

    def face_stiffener(g, zc, h, yc=0.0, pw=panel_w):
        Y = (lambda v: v) if not yc else (lambda v: yc + v)
        b.add(g, 'Stiffener', box_geom((face_x, Y(0), zc), (face_d, pw - 0.002, h)))
        detail(g, 'VentDark', (proud(0.001), Y(0), zc), (0.001, pw * 0.9, 0.004))

    FACES = {'compute': face_compute, 'switch': face_switch, 'power': face_power, 'mgmt': face_mgmt, 'blank': face_blank, 'stiffener': face_stiffener}
    PER_UNIT = {'compute', 'switch', 'power', 'mgmt'}
    # wide frames: `face_columns` half-width faceplate fields per tray with a thin divider (configuration, not a tray design)
    n_cols = int(ff.get('face_columns', 1))
    col_gap = ff.get('column_gap_mm', 6) / 1000.0 if n_cols > 1 else 0.0
    col_w = (panel_w - col_gap * (n_cols - 1)) / n_cols
    col_yc = [-panel_w / 2 + col_w / 2 + c * (col_w + col_gap) for c in range(n_cols)] if n_cols > 1 else [0.0]
    if n_cols > 1:
        for c in range(1, n_cols):
            y_gap = -panel_w / 2 + c * col_w + (c - 0.5) * col_gap
            b.add('Enclosure', 'RackRail', box_geom((face_x, y_gap, (it_bot + it_top) / 2), (face_d, col_gap, it_h)))

    def face(kind, g, zc, h):
        for yc in col_yc:
            FACES[kind](g, zc, h, yc, col_w)

    counts = defaultdict(int)
    qd_units = []  # (centre z, tray height) of every compute / switch tray
    trays_of = []  # (kind, first unit, units per tray)
    for band in bands:
        start, count, kind = int(band[0]), int(band[1]), band[2]
        span = int(band[3]) if len(band) > 3 else 1  # optional 4th element: units per tray (default 1)
        if span < 1 or count % span:
            raise ValueError(f"{model['layout']}: band at {start}: {count} units is not a multiple of {span} per tray")
        for u in range(start, start + count):
            if u < 1 or u > n_units or covered[u]:
                raise ValueError(f"{model['layout']}: unit {u} out of range or covered twice")
            covered[u] = 1
        if kind not in FACES:
            raise ValueError(f'unknown band kind {kind}')
        if kind in PER_UNIT:
            for u in range(start, start + count, span):
                z_bot = it_bot + (u - 1) * pitch
                counts[kind] += 1
                trays_of.append((kind, u, span))
                face(kind, f'Bands/{kind}_{u:02d}', z_bot + span * pitch / 2, span * pitch - gap)
                if kind in ('compute', 'switch'):
                    qd_units.append((z_bot + span * pitch / 2, span * pitch))
        else:
            z_bot = it_bot + (start - 1) * pitch
            face(kind, f'Bands/{kind}_{start:02d}', z_bot + count * pitch / 2, count * pitch - gap)
    if sum(covered) != n_units:
        missing = [u for u in range(1, n_units + 1) if not covered[u]]
        raise ValueError(f"{model['layout']}: units not covered {missing}")

    # ── rear: busbar (centre), liquid manifold (two neutral steel pipes), blind-mate couplers per compute / switch unit
    rear = layout.get('rear', {})
    pipe_y = ff['rear_manifold_y_mm'] / 1000.0 if ff.get('rear_manifold_y_mm') else min(0.17, panel_w * 0.36)
    bus_x = None
    if rear.get('busbar'):
        if bus_cfg.get('from_front_mm') is not None:
            # busbar mating plane at the standard datum depth, measured from the front vertical (faceplate) plane; it sits
            # inside the opaque bulkheads, so it is present in the USD but not visible in the viewer
            bus_d = bus_cfg.get('depth_mm', 30) / 1000.0
            bus_x = xf - bus_cfg['from_front_mm'] / 1000.0
            b.add('Rear', 'Busbar', box_geom((bus_x - bus_d / 2, 0, (it_bot + it_top) / 2), (bus_d, bus_cfg.get('width_mm', 90) / 1000.0, it_h)))
        else:
            b.add('Rear', 'Busbar', box_geom((rear_x + 0.085, 0, (it_bot + it_top) / 2), (0.03, 0.09, it_h)))
    if rear.get('manifold'):
        segs = 8 if lod1 else 16
        for sy in (-1, 1):
            b.add('Rear', 'ManifoldSteel', cyl_geom((rear_x + 0.07, sy * pipe_y, body_lo + 0.06), (rear_x + 0.07, sy * pipe_y, body_hi - 0.03), 0.026, segments=segs))
            # collar marks distinguish supply / return without colour: two collars on the supply (-Y), one on the return
            for k in range(2 if sy < 0 else 1):
                zc = body_hi - 0.12 - k * 0.05
                b.add('Rear', 'Coupler', cyl_geom((rear_x + 0.07, sy * pipe_y, zc - 0.012), (rear_x + 0.07, sy * pipe_y, zc + 0.012), 0.032, segments=segs))
        if lod1:
            # one coupler strip per contiguous run of QD units on each side
            runs = []
            for z, th in sorted(qd_units):
                if runs and abs(z - runs[-1][1] - (runs[-1][2] + th) / 2) < 1e-6:
                    runs[-1][1] = z
                    runs[-1][2] = th
                else:
                    runs.append([z, z, th])
            for z0, z1, th in runs:
                for sy in (-1, 1):
                    b.add('Rear', 'Coupler', box_geom((rear_x + 0.105, sy * (pipe_y - 0.045), (z0 + z1) / 2), (0.03, 0.05, z1 - z0 + th * 0.7)))
        else:
            for z, th in qd_units:
                for sy in (-1, 1):
                    b.add('Rear', 'Coupler', box_geom((rear_x + 0.105, sy * (pipe_y - 0.045), z), (0.03, 0.05, th * 0.7)))
    # power-shelf AC inputs at the rear of every power unit (neutral dark connectors)
    for kind, u, span in trays_of:
        if kind != 'power':
            continue
        zc = it_bot + (u - 0.5) * pitch if span == 1 else it_bot + (u - 1) * pitch + span * pitch / 2
        for sy in (-1, 1):
            b.add('Rear', 'Coupler', box_geom((rear_x + 0.11, sy * panel_w * 0.3, zc), (0.02, 0.06, pitch * 0.6)))
    b.flush()

    tray_w = panel_w
    b.points([
        ('spt_electrical_nominal_voltage_01', (rear_x + 0.09, -0.05, body_hi - 0.08), (0.04, 0.04, 0.04), {'connectionType': 'power', 'path': 'A', 'note': 'rack power feed A to the power shelves (rear top)'}),
        ('spt_electrical_nominal_voltage_02', (rear_x + 0.09, 0.05, body_hi - 0.08), (0.04, 0.04, 0.04), {'connectionType': 'power', 'path': 'B', 'note': 'rack power feed B'}),
        ('spt_liq_supply', (rear_x + 0.07, -pipe_y, body_lo + 0.08), (0.06, 0.06, 0.06), {'connectionType': 'liquid-supply', 'note': 'rear manifold supply (two collars)'}),
        ('spt_liq_return', (rear_x + 0.07, pipe_y, body_lo + 0.08), (0.06, 0.06, 0.06), {'connectionType': 'liquid-return', 'note': 'rear manifold return (one collar)'}),
        ('spt_airvent_intake', (front_x - 0.005, 0, (body_lo + body_hi) / 2), (0.01, tray_w, (body_hi - body_lo) * 0.8), {'connectionType': 'air-intake', 'note': 'residual air intake, front'}),
        ('spt_airvent_outflow', (rear_x + 0.005, 0, (body_lo + body_hi) / 2), (0.01, tray_w, (body_hi - body_lo) * 0.8), {'connectionType': 'air-outflow', 'note': 'residual air outflow, rear'}),
        ('spt_scaleout_fiber', (front_x - 0.01, 0, body_hi - 0.03), (0.02, tray_w * 0.5, 0.03), {'connectionType': 'network', 'note': 'front-end / scale-out fibre exit (front top)'}),
        *([('spt_busbar_it', (bus_x, 0, (it_bot + it_top) / 2), (0.01, 0.09, 0.06), {'connectionType': 'power', 'note': 'IT busbar mating plane at the datum depth', 'datumMm': float(bus_cfg['from_front_mm'])})] if bus_x is not None else []),
        *([('spt_hac_seal_plane', (front_x - ff['hac_seal_plane_mm'] / 1000.0, 0, H - 0.01), (0.01, W, 0.02), {'connectionType': 'containment', 'note': 'default hot-aisle containment seal plane, measured from the front face', 'fromFrontMm': float(ff['hac_seal_plane_mm'])})] if ff.get('hac_seal_plane_mm') else []),
    ])
    author_attr(prim, 'aidc:triangles', S.Int, int(b.mw.tris), 'Authored triangle count')
    info = {'kind': 'rack', 'formFactor': ff_id, 'layout': model['layout'], 'units': n_units, 'unit': ff['unit'], 'pitchMm': ff['pitch_mm'],
            'bandCounts': dict(counts), 'bodyZ': [0.0, H], 'bodyDims': {'w': W, 'd': D, 'h': H}}
    if n_cols > 1:
        info['faceColumns'] = n_cols
    if bus_x is not None:
        info['busbarDatumMm'] = float(bus_cfg['from_front_mm'])
    return stage, info


# ─────────────────────────── cabinets (CDU, CRAH / fan wall) ───────────────────────────

def _cabinet_shell(b: Builder, W, D, H, plinth, inset, lod1, rear_louvres=True):
    """Opaque cabinet body (inset from the footprint by `inset` on front and rear so proud details stay inside the catalog
    footprint) with a perimeter frame flush with the front / rear planes (stiles + rails) — no grazing ray can slip past."""
    front_x, rear_x = D / 2, -D / 2
    b.add('Cabinet', 'Plinth', box_geom((0, 0, plinth / 2), (D, W, plinth)))
    # body 2 mm narrower each side so the side seams (proud by 0.8 mm) stay inside the catalog footprint
    b.add('Cabinet', 'CabinetLight', box_geom((0, 0, (plinth + H) / 2), (D - 2 * inset, W - 0.004, H - plinth)))
    stile = 0.035
    for x_face, sgn in ((front_x, 1), (rear_x, -1)):
        xc = x_face - sgn * inset / 2
        for sy in (-1, 1):
            b.add('Cabinet', 'CabinetTrim', box_geom((xc, sy * (W / 2 - stile / 2), (plinth + H) / 2), (inset, stile, H - plinth)))
        b.add('Cabinet', 'CabinetTrim', box_geom((xc, 0, H - stile / 2), (inset, W - 2 * stile, stile)))
        b.add('Cabinet', 'CabinetTrim', box_geom((xc, 0, plinth + stile / 2), (inset, W - 2 * stile, stile)))
    return front_x, rear_x, stile


def _door_lines(b: Builder, group, x_plane, sgn, W, z0, z1, n_doors, stile, lod1):
    """Vertical service-door seams (dark lines) and one recessed handle per door on the face at x_plane (sgn = facing)."""
    inner = W - 2 * stile
    dw = inner / n_doors
    for k in range(1, n_doors):
        y = -inner / 2 + k * dw
        b.add(group, 'DoorLine', quad_n('x', sgn, x_plane + sgn * 0.0008, y, (z0 + z1) / 2, 0.004, z1 - z0) if lod1 else box_geom((x_plane + sgn * 0.0005, y, (z0 + z1) / 2), (0.001, 0.004, z1 - z0)))
    for k in range(n_doors):
        y = -inner / 2 + (k + 0.85) * dw if n_doors > 1 else inner / 2 - 0.12
        zc = z0 + (z1 - z0) * 0.55
        if lod1:
            b.add(group, 'Handle', quad_n('x', sgn, x_plane + sgn * 0.006, y, zc, 0.02, 0.16))
        else:
            b.add(group, 'Handle', box_geom((x_plane + sgn * 0.005, y, zc), (0.01, 0.02, 0.16)))
    # horizontal seams under the top rail and over the bottom rail
    for z in (z0 + 0.002, z1 - 0.002):
        b.add(group, 'DoorLine', quad_n('x', sgn, x_plane + sgn * 0.0008, 0, z, inner, 0.004) if lod1 else box_geom((x_plane + sgn * 0.0005, 0, z), (0.001, inner, 0.004)))


def _louvre_band(b: Builder, group, x_plane, sgn, yc, zc, w, h, lod1, slat_pitch=0.03):
    """Neutral louvre panel: dark backing quad with horizontal slats (LOD1: backing + a few slat quads)."""
    b.add(group, 'LouvreGap', quad_n('x', sgn, x_plane + sgn * 0.001, yc, zc, w, h))
    n = max(2, int(h / slat_pitch))
    step = h / n
    for k in range(n):
        z = zc - h / 2 + (k + 0.5) * step
        if lod1:
            if k % 2 == 0:
                b.add(group, 'Louvre', quad_n('x', sgn, x_plane + sgn * 0.004, yc, z, w * 0.98, step * 0.9))
        else:
            b.add(group, 'Louvre', box_geom((x_plane + sgn * 0.0045, yc, z), (0.007, w * 0.98, step * 0.55)))


def build_cdu_stage(spec: dict, model: dict, path: Path, lod: int = 0) -> tuple[Usd.Stage, dict]:
    cfg = spec['cdus']
    dims = model['dims_m']
    W, D, H = dims['w'], dims['d'], dims['h']
    plinth = cfg['plinth_mm'] / 1000.0
    lod1 = lod >= 1
    inset = 0.012
    root_name = 'GenericCDU'
    stage, prim = _new_stage(path, root_name, f"Generic in-row / row-end coolant distribution unit cabinet ({W * 1000:.0f} x {D * 1000:.0f} x {H * 1000:.0f} mm). Parametric asset generated by AIDC Studio {GENERATOR}. Not a model of any vendor product; no display, logo or lettering.")
    _common_attrs(prim, spec, model, 'Coolant Distribution Unit', dims, lod)
    author_attr(prim, 'aidc:sourceTag', Sdf.ValueTypeNames.String, 'body dims: catalog; doors, louvres, stubs: estimate (generic design)', 'Provenance summary')
    b = Builder(stage, f'/{root_name}', spec['palette'])
    front_x, rear_x, stile = _cabinet_shell(b, W, D, H, plinth, inset, lod1)
    z0, z1 = plinth + stile, H - stile
    n_doors = max(1, round((W - 2 * stile) / (cfg['door_pitch_mm'] / 1000.0)))
    fx = front_x - inset  # body front plane
    rx = rear_x + inset
    # front: doors with lower + upper louvre bands, a neutral status lamp (no display)
    _door_lines(b, 'Front', fx, 1, W, z0, z1, n_doors, stile, lod1)
    inner = W - 2 * stile
    dw = inner / n_doors
    for k in range(n_doors):
        yc = -inner / 2 + (k + 0.45) * dw
        lw = dw * 0.62
        _louvre_band(b, 'Front', fx, 1, yc, z0 + 0.12 + 0.2, lw, 0.4, lod1)
        _louvre_band(b, 'Front', fx, 1, yc, z1 - 0.12 - 0.15, lw, 0.3, lod1)
    lamp = (fx + 0.003, -inner / 2 + dw * 0.45, z1 - 0.62)
    if lod1:
        b.add('Front', 'StatusLamp', quad_n('x', 1, fx + 0.004, lamp[1], lamp[2], 0.05, 0.012))
    else:
        b.add('Front', 'StatusLamp', box_geom(lamp, (0.006, 0.05, 0.012)))
    # rear: service doors + one tall louvre band per door
    _door_lines(b, 'Rear', rx, -1, W, z0, z1, n_doors, stile, lod1)
    for k in range(n_doors):
        yc = -inner / 2 + (k + 0.45) * dw
        _louvre_band(b, 'Rear', rx, -1, yc, (z0 + z1) / 2, dw * 0.62, (z1 - z0) * 0.55, lod1)
    # sides: two horizontal panel seams each
    for sy in (-1, 1):
        for z in (plinth + (H - plinth) / 3, plinth + 2 * (H - plinth) / 3):
            b.add('Sides', 'DoorLine', quad_n('y', sy, sy * (W / 2 - 0.0012), 0, z, D - 2 * inset - 0.06, 0.004))
    # top: roof trim + piping stubs (primary and secondary supply / return), neutral steel with flanges
    stub_h = cfg['stub_height_mm'] / 1000.0
    r = min(cfg['stub_radius_mm'] / 1000.0, W / 18)
    segs = 10 if lod1 else 20
    xs = rear_x + inset + max(0.18, D * 0.2)
    stubs = []
    for name, y in (('primary_supply', -W * 0.32), ('primary_return', -W * 0.12), ('secondary_supply', W * 0.12), ('secondary_return', W * 0.32)):
        stubs.append((name, y))
        b.add('Top', 'PipeSteel', cyl_geom((xs, y, H), (xs, y, H + stub_h), r, segments=segs))
        b.add('Top', 'Flange', cyl_geom((xs, y, H + stub_h - 0.02), (xs, y, H + stub_h), r * 1.45, segments=segs))
        b.add('Top', 'Flange', cyl_geom((xs, y, H), (xs, y, H + 0.025), r * 1.3, segments=segs))
    b.add('Top', 'CabinetTrim', quad_n('z', 1, H + 0.0008, 0, 0, D - 2 * inset - 0.08, W - 0.08))
    b.flush()
    b.points([
        *[(f'spt_liq_{name}', (xs, y, H + stub_h), (0.05, 0.05, 0.05), {'connectionType': 'liquid-' + name.split('_')[1], 'loop': name.split('_')[0], 'note': f'{name.replace("_", " ")} stub (top)'}) for name, y in stubs],
        ('spt_electrical_nominal_voltage_01', (rear_x + 0.05, -W * 0.3, plinth + 0.2), (0.04, 0.04, 0.04), {'connectionType': 'power', 'path': 'A'}),
        ('spt_electrical_nominal_voltage_02', (rear_x + 0.05, W * 0.3, plinth + 0.2), (0.04, 0.04, 0.04), {'connectionType': 'power', 'path': 'B'}),
    ])
    author_attr(prim, 'aidc:triangles', Sdf.ValueTypeNames.Int, int(b.mw.tris), 'Authored triangle count')
    return stage, {'kind': 'cdu', 'doors': n_doors, 'bodyZ': [0.0, H], 'bodyDims': {'w': W, 'd': D, 'h': H}, 'overallH': H + stub_h}


def build_crah_stage(spec: dict, model: dict, path: Path, lod: int = 0) -> tuple[Usd.Stage, dict]:
    cfg = spec['crahs']
    dims = model['dims_m']
    W, D, H = dims['w'], dims['d'], dims['h']
    plinth = cfg['plinth_mm'] / 1000.0
    lod1 = lod >= 1
    inset = 0.014
    fan_rows = int(model.get('fan_rows', 1))
    root_name = 'GenericCRAH'
    kind_label = 'fan-wall unit' if fan_rows > 1 else 'perimeter CRAH'
    stage, prim = _new_stage(path, root_name, f"Generic chilled-water {kind_label} ({W * 1000:.0f} x {D * 1000:.0f} x {H * 1000:.0f} mm). Parametric asset generated by AIDC Studio {GENERATOR}. Not a model of any vendor product; no display, logo or lettering.")
    _common_attrs(prim, spec, model, 'Computer Room Air Handler' if fan_rows == 1 else 'Fan Wall', dims, lod)
    author_attr(prim, 'aidc:sourceTag', Sdf.ValueTypeNames.String, 'body dims: catalog; fan count / layout, doors, grille: estimate (generic design)', 'Provenance summary')
    b = Builder(stage, f'/{root_name}', spec['palette'])
    front_x, rear_x, stile = _cabinet_shell(b, W, D, H, plinth, inset, lod1)
    fx, rx = front_x - inset, rear_x + inset
    z0, z1 = plinth + stile, H - stile
    inner = W - 2 * stile
    # fan section (front, lower) — EC fan grilles in a row (or rows for a fan wall)
    fan_h = (z1 - z0) * (cfg['fan_section_frac'] if fan_rows == 1 else 0.72)
    n_fans = max(2, round(inner / (cfg['fan_pitch_mm'] / 1000.0)))
    pitch_y = inner / n_fans
    row_h = fan_h / fan_rows
    R = min(pitch_y * 0.42, row_h * 0.43)
    b.add('Front', 'FanGrille', quad_n('x', 1, fx + 0.001, 0, z0 + fan_h / 2, inner, fan_h))  # dark fan-section backing
    segs = 12 if lod1 else 28
    n_fan_total = 0
    for row in range(fan_rows):
        zc = z0 + row_h * (row + 0.5)
        for k in range(n_fans):
            yc = -inner / 2 + (k + 0.5) * pitch_y
            n_fan_total += 1
            g = 'Front/Fans'
            b.add(g, 'FanRing', cyl_geom((fx, yc, zc), (fx + 0.006, yc, zc), R * 1.06, segments=segs, phase=math.pi / segs))
            b.add(g, 'FanGrille', cyl_geom((fx + 0.006, yc, zc), (fx + 0.009, yc, zc), R, segments=segs))
            b.add(g, 'FanHub', cyl_geom((fx + 0.009, yc, zc), (fx + 0.016, yc, zc), R * 0.2, segments=max(8, segs // 2)))
            if lod1:
                for ang in (0.0, math.pi / 2):
                    b.add(g, 'FanRing', quad_n('x', 1, fx + 0.0125, yc, zc, R * 1.9 if ang == 0 else 0.008, 0.008 if ang == 0 else R * 1.9))
            else:
                for ang in (0.0, math.pi / 4, math.pi / 2, 3 * math.pi / 4):
                    a = (yc - math.cos(ang) * R * 0.95, zc - math.sin(ang) * R * 0.95)
                    c = (yc + math.cos(ang) * R * 0.95, zc + math.sin(ang) * R * 0.95)
                    b.add(g, 'FanRing', cyl_geom((fx + 0.012, a[0], a[1]), (fx + 0.012, c[0], c[1]), 0.003, segments=6, caps=False))
                for rr in (0.45, 0.75):
                    b.add(g, 'FanRing', ring_geom((fx + 0.012, yc, zc), R * rr, 0.0025, segments=20, sides=5))
    # filter / coil doors above the fans (front) with door seams, handles and a mesh window per door
    zd0 = z0 + fan_h + 0.01
    n_doors = max(2, round(inner / 0.9))
    b.add('Front', 'DoorLine', quad_n('x', 1, fx + 0.0009, 0, zd0 - 0.005, inner, 0.008))
    _door_lines(b, 'Front', fx, 1, W, zd0, z1, n_doors, stile, lod1)
    dw = inner / n_doors
    for k in range(n_doors):
        yc = -inner / 2 + (k + 0.45) * dw
        mh = (z1 - zd0) * 0.5
        b.add('Front', 'FilterMesh', quad_n('x', 1, fx + 0.0012, yc, zd0 + (z1 - zd0) * 0.5, dw * 0.66, mh))
        if not lod1:
            n = max(3, int(mh / 0.05))
            for j in range(n):
                z = zd0 + (z1 - zd0) * 0.5 - mh / 2 + (j + 0.5) * mh / n
                b.add('Front', 'LouvreGap', box_geom((fx + 0.002, yc, z), (0.002, dw * 0.66, 0.004)))
    # rear: plain service panels with seams and two chilled-water flanges low on the rear face
    _door_lines(b, 'Rear', rx, -1, W, z0, z1, n_doors, stile, lod1)
    for name, y in (('chw_supply', -inner * 0.38), ('chw_return', -inner * 0.26)):
        b.add('Rear', 'Flange', cyl_geom((rx, y, z0 + 0.2), (rx - 0.011, y, z0 + 0.2), 0.06, segments=10 if lod1 else 18))
    # sides: seams
    for sy in (-1, 1):
        b.add('Sides', 'DoorLine', quad_n('y', sy, sy * (W / 2 - 0.0012), 0, z0 + fan_h, D - 2 * inset - 0.06, 0.005))
    # top: return-air grille recessed into the roof (dark backing + slats across the width)
    gw, gd = W - 0.16, D - 2 * inset - 0.12
    b.add('Top', 'FanGrille', quad_n('z', 1, H + 0.001, 0, 0, gd, gw))
    n_sl = max(4, int(gw / (0.08 if lod1 else 0.04)))
    for k in range(n_sl):
        y = -gw / 2 + (k + 0.5) * gw / n_sl
        if lod1:
            b.add('Top', 'Louvre', quad_n('z', 1, H + 0.003, 0, y, gd, gw / n_sl * 0.4))
        else:
            b.add('Top', 'Louvre', box_geom((0, y, H + 0.004), (gd, gw / n_sl * 0.35, 0.006)))
    b.flush()
    b.points([
        ('spt_airvent_intake', (0, 0, H), (gd, gw, 0.01), {'connectionType': 'air-intake', 'note': 'return air, top grille'}),
        ('spt_airvent_outflow', (front_x - 0.005, 0, z0 + fan_h / 2), (0.01, inner, fan_h), {'connectionType': 'air-outflow', 'note': 'supply air, front fan section'}),
        ('spt_chw_supply', (rear_x, -inner * 0.38, z0 + 0.2), (0.05, 0.05, 0.05), {'connectionType': 'liquid-supply', 'loop': 'chilled-water'}),
        ('spt_chw_return', (rear_x, -inner * 0.26, z0 + 0.2), (0.05, 0.05, 0.05), {'connectionType': 'liquid-return', 'loop': 'chilled-water'}),
        ('spt_electrical_nominal_voltage_01', (rear_x + 0.05, inner * 0.35, z1 - 0.2), (0.04, 0.04, 0.04), {'connectionType': 'power', 'path': 'A'}),
    ])
    author_attr(prim, 'aidc:triangles', Sdf.ValueTypeNames.Int, int(b.mw.tris), 'Authored triangle count')
    return stage, {'kind': 'crah' if fan_rows == 1 else 'fan-wall', 'fans': n_fan_total, 'fanRows': fan_rows, 'doors': n_doors,
                   'bodyZ': [0.0, H + 0.007], 'bodyDims': {'w': W, 'd': D, 'h': H}}


# ─────────────────────────── entry points ───────────────────────────

def models(spec: dict) -> list[tuple[str, dict]]:
    """(builder kind, model entry) for every generic model in the spec."""
    out = [('rack', m) for m in spec.get('racks', [])]
    out += [('cdu', m) for m in spec.get('cdus', {}).get('units', [])]
    out += [('crah', m) for m in spec.get('crahs', {}).get('units', [])]
    return out


BUILDERS = {'rack': build_rack_stage, 'cdu': build_cdu_stage, 'crah': build_crah_stage}


def build(spec_path: Path, kind: str, model: dict, out_dir: Path, lod: int = 0, stem: str | None = None, usda: bool = True) -> dict:
    spec = json.loads(spec_path.read_text())
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = stem or model['name']
    usd_path = out_dir / f'{stem}.usd'
    if usd_path.exists():
        usd_path.unlink()
    stage, info = BUILDERS[kind](spec, model, usd_path, lod=lod)
    stage.GetRootLayer().Save()
    if usda:
        stage.GetRootLayer().Export(str(out_dir / f'{stem}.usda'))
    st = Usd.Stage.Open(str(usd_path))
    meshes = [p for p in st.Traverse() if p.IsA(UsdGeom.Mesh)]
    bbox = UsdGeom.BBoxCache(Usd.TimeCode.Default(), [UsdGeom.Tokens.default_, UsdGeom.Tokens.render]).ComputeWorldBound(st.GetDefaultPrim()).ComputeAlignedRange()
    lo, hi = bbox.GetMin(), bbox.GetMax()
    report = {
        'name': model['name'], 'usd': str(usd_path), 'lod': lod, 'meshes': len(meshes),
        'triangles': int(st.GetDefaultPrim().GetAttribute('aidc:triangles').Get()),
        'dims': [round(float(hi[i] - lo[i]), 4) for i in range(3)], 'info': info,
    }
    print('[generic-usd]', json.dumps({k: v for k, v in report.items() if k != 'info'}))
    return report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--spec', default=str(HERE / 'generic_spec.json'))
    ap.add_argument('--out', default=str(HERE / '../../apps/web/public/assets/usd/Generic'))
    ap.add_argument('--only', nargs='*', default=None)
    ap.add_argument('--lod', type=int, default=0)
    args = ap.parse_args(argv)
    spec = json.loads(Path(args.spec).read_text())
    for kind, m in models(spec):
        if args.only and m['name'] not in args.only:
            continue
        build(Path(args.spec), kind, m, Path(args.out).resolve(), lod=args.lod)
    return 0


if __name__ == '__main__':
    sys.exit(main())
