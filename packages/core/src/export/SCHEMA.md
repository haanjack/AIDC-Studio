# `aidc.layout/1` — engine-neutral scene schema

Produced by `exportLayoutJson(project, analysis?)` (`layout.json` in every export bundle). It is the
hand-off format for the Godot loader (`engines/godot`), the Unreal import script (`engines/unreal`) and
any external tool. All numbers are SI (m, kW, kg); angles in degrees.

## Coordinate conventions

| Key | Space | Mapping from plan |
|---|---|---|
| `plan` | hall-local, right-handed, **Z-up**; `rotationDeg` CCW about +Z; front faces **+Y** at 0° | — |
| `zUp` | site space = `hall.origin + plan`, Z-up RH meters (OpenUSD, metersPerUnit=1) | `(x, y, z)` |
| `yUp` | glTF / Godot / three.js, Y-up RH meters | `(x, z, -y)`, `rotationYDeg = rotationZDeg` |
| `unreal` | Unreal Engine, Z-up **left-handed**, centimeters | `(100x, -100y, 100z)`, `yawDeg = -rotationZDeg` |

Model files (`catalog[*].glb`, under `models/`) follow the glTF convention used by the web viewer:
front faces **-Z**, width along X, height along +Y, footprint centered at the origin, base at y = 0.
So a model placed with `yUp.position` and `rotationYDeg` needs no extra correction.

Boxes (`floor`, `keepouts`, `containments`) are axis-aligned: `center` + full `size` in each convention.

## Top level

```jsonc
{
  "schema": "aidc.layout/1",
  "generator": "AIDC Studio",
  "generatedAt": "2026-09-13T05:00:00.000Z",
  "project": { "id": "...", "name": "...", "description": "...", "client": "..." | null },
  "units": { "length": "m", "power": "kW", "mass": "kg" },
  "conventions": { "plan": "...", "zUp": "...", "yUp": "...", "unreal": "...", "boxes": "..." },
  "halls": [LayoutHall],
  "catalog": { "<catalogId>": LayoutCatalogEntry },
  "equipment": [LayoutEquipment],
  "containments": [LayoutContainment],
  "cableRuns": [LayoutCableRun],        // empty unless an analysis was supplied
  "summary": ProjectAnalysis.summary | null
}
```

### LayoutHall
`id, name, origin {x,y}, width, depth, clearHeight, ceilingPlenumHeight, raisedFloorHeight, trayHeight,
itPowerBudgetKW, floor: Box, keepouts: Box[]` (keepout `kind`: column | door | egress | ramp | shaft | other).

### LayoutCatalogEntry
`id, name, category, vendor, model, dims {w, d, h}, color (#rrggbb), glb (file name | null),
usd (AIDC-generated `usd/…` path | null), nameplateKW, weightKg`.

### LayoutEquipment
```jsonc
{
  "id": "eq-du01-a-01", "tag": "DU01-A-01", "catalogId": "nvidia-gb300-nvl72", "category": "gpu-rack",
  "hallId": "hall-a", "podId": "pod-01", "rowId": "pod-01-a", "waveId": "wave-01", "networkRole": null,
  "plan": { "x": 7.55, "y": 4.3, "elevation": 0, "rotationDeg": 180 },
  "transform": {
    "zUp":    { "position": [7.55, 4.3, 0],  "rotationZDeg": 180 },
    "yUp":    { "position": [7.55, 0, -4.3], "rotationYDeg": 180 },
    "unreal": { "location": [755, -430, 0],  "yawDeg": -180 }
  }
}
```
`position` is the footprint center at the equipment base.

### LayoutContainment (Box +)
`containment: hot-aisle | cold-aisle, roof, endDoors, ductedToPlenum, podId` — the box is the contained
aisle volume (plan rect × containment height).

### LayoutCableRun
`id, fabric, fromId, toId, lengthM, cableTypeId, count, fromZUp, toZUp` — endpoints are tray-level points
above the connected equipment (site Z-up meters); `count` identical cables share the bundle.
