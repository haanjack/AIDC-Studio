# AIDC Studio — Unreal Engine 5 import

`aidc_import.py` rebuilds an AIDC Studio layout (`layout.json`, schema `aidc.layout/1`) inside the current
Unreal level. Target: **UE 5.4+** (tested against the UE 5 Python API reference; it cannot be executed in CI here).

## Requirements

- Plugins: **Python Editor Script Plugin**, **glTF Importer** (Interchange; enabled by default in 5.4+).
- Optional: **USD Importer** for the USD route below.

## Steps

1. Export from AIDC Studio: **Export ▸ Unreal** → unzip `aidc-unreal/` (contains `aidc_import.py`, `layout.json`, `models/*.glb`).
2. Open or create a level, then in **Output Log ▸ Cmd** run:

   ```
   py "D:/exports/aidc-unreal/aidc_import.py" --layout "D:/exports/aidc-unreal/layout.json"
   ```

   Options: `--models <dir>` (default: `models/` next to the layout), `--dest /Game/AIDC`, `--no-models` (boxes only).
3. Actors appear in the World Outliner under `AIDC/<Project>/<Hall>/<Pod>`; each actor is tagged with the
   equipment id and catalog id. The import is one undoable transaction.

## Coordinates

`layout.json` carries a ready-made `transform.unreal` for each item: location in **cm**, Z-up, left-handed
(`(100x, -100y, 100z)` from the Z-up right-handed plan) and `yawDeg = -rotationDeg`. Boxes are placed exactly.
For GLB models the script checks the imported mesh bounds against the catalog footprint and applies
`GLB_YAW_OFFSET_DEG` if the importer rotated the footprint; set `GLB_FRONT_FLIP = True` if racks face backwards.

## Alternatives

- **USD Stage**: Export ▸ USD, then in UE enable *USD Importer* and use *Window ▸ USD Stage* ▸ *Open* `stage.usda`
  (or File ▸ Import Into Level). The stage payloads the AIDC-generated USD models (`usd/…`) and exports every other
  item as a sized box carrying `aidc:*` attributes; UE converts Z-up meters automatically.
- **Datasmith / glTF**: import `models/*.glb` manually and place them using `layout.json`.
