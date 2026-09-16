"""AIDC Studio → Unreal Engine 5 layout importer.

Run inside the Unreal Editor (Python Editor Script Plugin enabled):

    Output Log ▸ Cmd:  py "C:/path/aidc-unreal/aidc_import.py" --layout "C:/path/aidc-unreal/layout.json"

or Tools ▸ Execute Python Script (then the defaults below are used: layout.json next to this file).

What it does
  1. Imports every GLB referenced by the layout (models/<file>.glb next to layout.json) into /Game/AIDC/Models/<name>/
     using AssetImportTask (the glTF Interchange importer in UE 5.4+).
  2. Spawns one actor per equipment item into the current level, using `transform.unreal`
     (cm, Z-up, left-handed; yaw = -rotationDeg), organized in World Outliner folders AIDC/<Hall>/<Pod>.
  3. Items without a model get /Engine/BasicShapes/Cube scaled to the catalog dimensions and tinted by category.
  4. Contained aisles become translucent boxes; hall floors become flat cubes.

Orientation of imported GLB models
  AIDC GLBs are authored front = -Z (glTF), width along X. UE's glTF importer converts glTF (Y-up, RH) to UE (Z-up, LH),
  which usually maps glTF -Z to UE +X. The script compares the imported mesh bounds with the catalog footprint and
  applies GLB_YAW_OFFSET_DEG when the footprint comes in rotated. If racks end up facing backwards in your engine
  version, set GLB_FRONT_FLIP = True (adds 180°).
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import unreal

# ─────────────────────────── configuration ───────────────────────────
DEST_ROOT = "/Game/AIDC"
GLB_YAW_OFFSET_DEG = -90.0  # applied when imported mesh depth lies along UE X (typical glTF import)
GLB_FRONT_FLIP = False
SPAWN_MODELS = True
REIMPORT_EXISTING = False
CUBE_PATH = "/Engine/BasicShapes/Cube.Cube"  # 100 cm cube, pivot at center
BASIC_MATERIAL_PATH = "/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"


def _log(msg: str) -> None:
    unreal.log(f"[AIDC] {msg}")


def _warn(msg: str) -> None:
    unreal.log_warning(f"[AIDC] {msg}")


def _parse_args() -> argparse.Namespace:
    here = os.path.dirname(os.path.abspath(__file__))
    parser = argparse.ArgumentParser(description="Import an AIDC Studio layout into the current level")
    parser.add_argument("--layout", default=os.path.join(here, "layout.json"))
    parser.add_argument("--models", default=None, help="directory with GLB files (default: <layout dir>/models)")
    parser.add_argument("--dest", default=DEST_ROOT)
    parser.add_argument("--no-models", action="store_true", help="use boxes for everything")
    # UE passes the script path as argv[0]; ignore unknown extras
    args, _ = parser.parse_known_args(sys.argv[1:])
    return args


def _safe(name: str) -> str:
    return "".join(c if c.isalnum() or c == "_" else "_" for c in name) or "_"


# ─────────────────────────── asset helpers ───────────────────────────
def import_glb(glb_path: str, dest_folder: str) -> list:
    """Import a GLB and return the StaticMesh assets created under dest_folder."""
    eal = unreal.EditorAssetLibrary
    if eal.does_directory_exist(dest_folder) and not REIMPORT_EXISTING:
        meshes = _static_meshes_in(dest_folder)
        if meshes:
            return meshes
    task = unreal.AssetImportTask()
    task.set_editor_property("filename", glb_path)
    task.set_editor_property("destination_path", dest_folder)
    task.set_editor_property("automated", True)
    task.set_editor_property("save", True)
    task.set_editor_property("replace_existing", True)
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    meshes = _static_meshes_in(dest_folder)
    if not meshes:
        _warn(f"no StaticMesh produced by importing {glb_path}")
    return meshes


def _static_meshes_in(folder: str) -> list:
    out = []
    for path in unreal.EditorAssetLibrary.list_assets(folder, recursive=True, include_folder=False):
        asset = unreal.EditorAssetLibrary.load_asset(path)
        if isinstance(asset, unreal.StaticMesh):
            out.append(asset)
    return out


def _mesh_yaw_offset(meshes: list, dims: dict) -> float:
    """Compare imported bounds with the catalog footprint to decide whether the footprint arrived rotated."""
    if not meshes:
        return 0.0
    try:
        mins = [None, None]
        maxs = [None, None]
        for m in meshes:
            box = m.get_bounding_box()
            for i, axis in enumerate(("x", "y")):
                lo = getattr(box.min, axis)
                hi = getattr(box.max, axis)
                mins[i] = lo if mins[i] is None else min(mins[i], lo)
                maxs[i] = hi if maxs[i] is None else max(maxs[i], hi)
        ext_x = (maxs[0] - mins[0]) / 100.0
        ext_y = (maxs[1] - mins[1]) / 100.0
        w, d = float(dims["w"]), float(dims["d"])
        rotated = abs(ext_x - d) + abs(ext_y - w) < abs(ext_x - w) + abs(ext_y - d)
        offset = GLB_YAW_OFFSET_DEG if rotated else 0.0
    except Exception as exc:  # bounds API differences between engine versions
        _warn(f"could not inspect mesh bounds ({exc}); using GLB_YAW_OFFSET_DEG")
        offset = GLB_YAW_OFFSET_DEG
    return offset + (180.0 if GLB_FRONT_FLIP else 0.0)


_material_cache: dict = {}


def color_material(key: str, hex_color: str, dest: str, translucent: bool = False):
    """MaterialInstanceConstant of BasicShapeMaterial tinted with hex_color (persistent asset)."""
    cache_key = (key, translucent)
    if cache_key in _material_cache:
        return _material_cache[cache_key]
    folder = f"{dest}/Materials"
    name = f"MI_{_safe(key)}"
    path = f"{folder}/{name}"
    eal = unreal.EditorAssetLibrary
    mi = eal.load_asset(path) if eal.does_asset_exist(path) else None
    try:
        if mi is None:
            tools = unreal.AssetToolsHelpers.get_asset_tools()
            mi = tools.create_asset(name, folder, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
            parent = _translucent_parent(dest) if translucent else eal.load_asset(BASIC_MATERIAL_PATH)
            unreal.MaterialEditingLibrary.set_material_instance_parent(mi, parent)
        h = hex_color.lstrip("#")
        rgb = [int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
        unreal.MaterialEditingLibrary.set_material_instance_vector_parameter_value(mi, "Color", unreal.LinearColor(rgb[0], rgb[1], rgb[2], 1.0))
        eal.save_loaded_asset(mi)
    except Exception as exc:
        _warn(f"material {name}: {exc}")
        mi = None
    _material_cache[cache_key] = mi
    return mi


def _translucent_parent(dest: str):
    """Translucent master material with a 'Color' vector and 'Opacity' scalar parameter."""
    path = f"{dest}/Materials/M_AIDC_Translucent"
    eal = unreal.EditorAssetLibrary
    if eal.does_asset_exist(path):
        return eal.load_asset(path)
    mel = unreal.MaterialEditingLibrary
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    mat = tools.create_asset("M_AIDC_Translucent", f"{dest}/Materials", unreal.Material, unreal.MaterialFactoryNew())
    mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    mat.set_editor_property("two_sided", True)
    color = mel.create_material_expression(mat, unreal.MaterialExpressionVectorParameter, -400, 0)
    color.set_editor_property("parameter_name", "Color")
    opacity = mel.create_material_expression(mat, unreal.MaterialExpressionScalarParameter, -400, 200)
    opacity.set_editor_property("parameter_name", "Opacity")
    opacity.set_editor_property("default_value", 0.25)
    mel.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(opacity, "", unreal.MaterialProperty.MP_OPACITY)
    mel.recompile_material(mat)
    eal.save_loaded_asset(mat)
    return mat


# ─────────────────────────── spawning ───────────────────────────
def _actor_subsystem():
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def spawn_mesh(mesh, location, yaw: float, label: str, folder: str, scale=None, material=None):
    actor = _actor_subsystem().spawn_actor_from_object(mesh, unreal.Vector(*location), unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw))
    if actor is None:
        return None
    actor.set_actor_label(label)
    actor.set_folder_path(folder)
    if scale is not None:
        actor.set_actor_scale3d(unreal.Vector(*scale))
    if material is not None:
        comp = actor.get_component_by_class(unreal.StaticMeshComponent)
        if comp:
            comp.set_material(0, material)
    return actor


def spawn_box(center_cm, size_cm, label: str, folder: str, material=None, yaw: float = 0.0):
    cube = unreal.EditorAssetLibrary.load_asset(CUBE_PATH)
    scale = (size_cm[0] / 100.0, size_cm[1] / 100.0, size_cm[2] / 100.0)
    return spawn_mesh(cube, center_cm, yaw, label, folder, scale=scale, material=material)


def run() -> None:
    args = _parse_args()
    layout_path = os.path.abspath(args.layout)
    if not os.path.isfile(layout_path):
        unreal.log_error(f"[AIDC] layout not found: {layout_path}")
        return
    with open(layout_path, "r", encoding="utf-8") as fh:
        layout = json.load(fh)
    if layout.get("schema") != "aidc.layout/1":
        unreal.log_error("[AIDC] not an aidc.layout/1 file")
        return

    dest = args.dest.rstrip("/")
    models_dir = args.models or os.path.join(os.path.dirname(layout_path), "models")
    catalog = layout.get("catalog", {})
    halls = {h["id"]: h for h in layout.get("halls", [])}
    equipment = layout.get("equipment", [])
    root_folder = f"AIDC/{_safe(layout['project']['name'])[:40]}"

    # 1) import models
    model_meshes: dict = {}
    if SPAWN_MODELS and not args.no_models:
        for cat_id, cat in catalog.items():
            glb = cat.get("glb")
            if not glb:
                continue
            glb_path = os.path.join(models_dir, glb)
            if not os.path.isfile(glb_path):
                continue
            meshes = import_glb(glb_path, f"{dest}/Models/{_safe(os.path.splitext(glb)[0])}")
            if meshes:
                model_meshes[cat_id] = (meshes, _mesh_yaw_offset(meshes, cat["dims"]))
                _log(f"model {glb}: {len(meshes)} mesh(es), yaw offset {model_meshes[cat_id][1]}")

    total = len(equipment) + len(layout.get("containments", [])) + len(halls)
    spawned = 0
    with unreal.ScopedEditorTransaction("AIDC layout import"):
        with unreal.ScopedSlowTask(total, "Importing AIDC layout") as slow:
            slow.make_dialog(True)
            for hall in halls.values():
                folder = f"{root_folder}/{_safe(hall['name'])}"
                floor = hall["floor"]["unreal"]
                spawn_box(floor["center"], floor["size"], f"{hall['name']} Floor", folder, color_material("floor", "#8e9296", dest))
                for ko in hall.get("keepouts", []):
                    b = ko["unreal"]
                    spawn_box(b["center"], b["size"], ko.get("label") or ko["id"], f"{folder}/Keepouts", color_material(f"keepout_{ko['kind']}", "#9a9a9a", dest))
                slow.enter_progress_frame(1)

            for e in equipment:
                if slow.should_cancel():
                    break
                hall = halls.get(e["hallId"])
                if hall is None:
                    continue
                cat = catalog.get(e["catalogId"], {})
                folder = f"{root_folder}/{_safe(hall['name'])}/{_safe(e.get('podId') or 'Room')}"
                t = e["transform"]["unreal"]
                loc = t["location"]
                yaw = float(t["yawDeg"])
                if e["catalogId"] in model_meshes:
                    meshes, offset = model_meshes[e["catalogId"]]
                    for i, mesh in enumerate(meshes):
                        label = e["tag"] if len(meshes) == 1 else f"{e['tag']}_{i}"
                        actor = spawn_mesh(mesh, loc, yaw + offset, label, folder)
                        if actor:
                            actor.tags = [unreal.Name(e["id"]), unreal.Name(e["catalogId"])]
                else:
                    dims = cat.get("dims", {"w": 0.6, "d": 1.2, "h": 2.3})
                    h_cm = float(dims["h"]) * 100.0
                    center = (loc[0], loc[1], loc[2] + h_cm / 2.0)
                    size = (float(dims["w"]) * 100.0, float(dims["d"]) * 100.0, h_cm)
                    mat = color_material(cat.get("category", "other"), cat.get("color", "#808080"), dest)
                    actor = spawn_box(center, size, e["tag"], folder, mat, yaw=yaw)
                    if actor:
                        actor.tags = [unreal.Name(e["id"]), unreal.Name(e["catalogId"])]
                spawned += 1
                slow.enter_progress_frame(1)

            for c in layout.get("containments", []):
                hall = halls.get(c["hallId"])
                folder = f"{root_folder}/{_safe(hall['name']) if hall else 'Hall'}/Containment"
                color = "#ff6a3d" if c.get("containment") == "hot-aisle" else "#3da5ff"
                b = c["unreal"]
                spawn_box(b["center"], b["size"], c["id"], folder, color_material(c.get("containment", "aisle"), color, dest, translucent=True))
                slow.enter_progress_frame(1)

    _log(f"spawned {spawned} equipment actors from {layout_path}")


if __name__ == "__main__":
    run()
