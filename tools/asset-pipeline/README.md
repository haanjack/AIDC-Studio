# Asset pipeline — generated web assets for AIDC Studio

Builds the web viewer's assets from sources the project owns or that are openly licensed. **No third-party content pack is read**
(the former conversion steps for the NVIDIA reference blueprint content pack — USD model table, CGNS CFD resampling, bundled HDR — were removed on 2026-09-15; see
`docs/research/neutral-N1a.md`). Every shipped file is listed with its licence in `apps/web/public/assets/CREDITS.json`.

## Setup

```bash
cd tools/asset-pipeline
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

**Catalog thumbnails.** `build_all.py` runs `render_thumbs.py` by default: headless Chromium from `~/.cache/ms-playwright` renders
each GLB with three.js, and **Pillow** crops the 512 × 512 PNGs into `thumbs/` and writes the `thumbs` map of `manifest.json`.
Use `--skip-thumbs` on hosts without headless Chromium.

## Build

```bash
# everything
.venv/bin/python build_all.py
# options
.venv/bin/python build_all.py --out ../../apps/web/public/assets \
    [--skip-generic] [--skip-env] [--env-src <autumn_field_puresky_4k.hdr>] [--skip-thumbs] [--three ../../node_modules/three]
# individual steps
.venv/bin/python env_map.py [--src <local 4k .hdr>]            # sky HDRI (downloads from Poly Haven when --src is omitted)
.venv/bin/python render_thumbs.py --three <dir with three.js build/ and examples/>
.venv/bin/python verify_glb.py                                   # reload GLBs, print tris/bbox/centering
.venv/bin/python usd_to_glb.py --root <dir> --config assets.json # generic Z-up USD → GLB converter (settings per asset in JSON)
# generated models (racks by form factor: EIA-310 19-inch, 21-inch OU, wide OU; CDU; CRAH / fan wall): generic_spec.json →
#   generic_usd.py → usd/Generic/<name>.usd(a) → usd_to_glb → models/<name>.glb + <name>_lod1.glb (explicit LOD1, never
#   decimated); catalog dims, size budgets (1 MB / 300 KB) and the occlusion gate (generic_occlusion.py) must pass or the build fails
.venv/bin/python generic_build.py [--out ../../apps/web/public/assets] [--only NAME ...] [--no-gl-check] [--skip-thumbs] [--maps DIR]
.venv/bin/python generic_occlusion.py --files a.glb a_lod1.glb [--gl] [--json OUT] [--maps DIR]
```

`build_all.py` runs `generic_build.py` for every generated model. Shared helpers: `usd_mesh.py` (USD meshes and looks), `occlusion_rays.py` (ray kernel of the gate), `gltf_extras.py` (GLB `asset.extras`).
The scripts import each other by module name; each entry point inserts its own directory into `sys.path`, and the repo-root
`pyrightconfig.json` declares `tools/asset-pipeline` as an execution root with the `.venv`.

## Redistribution allowlist

`manifest.json` `models[]` entries are loaded by the viewer, rendered as catalog thumbnails and packaged into Godot / Unreal export
zips **only** when they carry `"generated": true` and a non-empty `"license"` (`packages/core/src/catalog/assetManifest.ts`,
`apps/web/src/viewer/modelIndex.ts`, `apps/server/src/export-zip.ts`). A GLB dropped into `models/` without such an entry is ignored,
and the catalog item keeps its procedural model / schematic image. `build_all.py` drops non-qualifying entries when it rewrites the
manifest.

## Outputs (`apps/web/public/assets/`)

| file | content | licence / provenance |
|---|---|---|
| `models/generic_*.glb`, `models/generic_*_lod1.glb` | generic parametric models from `generic_spec.json`: racks keyed by form factor + band layout, CDU, CRAH / fan wall | AIDC-authored (project licence) |
| `usd/Generic/<name>.usd`, `.usda` | parametric source USD (Z-up, front +X, `aidc:*` provenance: form-factor tags, pinned standard ids) | AIDC-authored |
| `thumbs/<model>.png` | 512 × 512 3/4-front renders of the generated GLBs | AIDC-rendered |
| `env/sky_1k.hdr` | 1024 × 512 equirect sky | derived from Poly Haven "Autumn Field (Pure Sky)", **CC0-1.0** (below) |
| `manifest.json` | index of the above | — |
| `CREDITS.json` | machine-readable credits: path, source URL, licence, sha256 per asset | — |

### Sky HDRI credit

- Title: **Autumn Field (Pure Sky)** — authors Sergej Majboroda (original), Jarod Guest (sky edits)
- Page: <https://polyhaven.com/a/autumn_field_puresky> · file: <https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/autumn_field_puresky_4k.hdr>
- Licence: **CC0 1.0** (<https://polyhaven.com/license>) — no attribution required; credited anyway
- Source file sha256 `52e13951317a14f74d9c04d687368d702f1c0648b48265f17831310a95eba2e9` (16,984,221 bytes, retrieved 2026-09-15; pinned in `env_map.py`)
- Output `env/sky_1k.hdr` sha256 `17a4d48afa22c6a903f1c33223bfe09d15931198243131637a7e212625b06a21` (1,113,306 bytes)

## Conventions

- **GLB**: glTF Y-up, meters, footprint centered at origin in XZ, base at y=0, width along X, depth along Z, **front faces −Z**.
  USD sources are Z-up with the front on USD +X; mapping is `(x, y, z)_gltf = (−y, z, −x)_usd` after centering.

## Wide OU rack (`generic_rack_orw_44ou_dlc`)

Built by the same generator as the other racks; only data differs. Form factor `orw-wide-44ou` in `generic_spec.json`
carries the frame values of the released wide-rack base and design specifications V1.0.0 (2026-04-28, links in `sources.ORW`):
2390 × 1200 × 1219 mm, 48 mm OpenU, 44 OU, 1094.44 mm opening, 150 mm forklift base (no casters), busbar at 802.59 mm
from the datum, 1068 mm containment seal plane, 4700 kg braced payload, 125 kg per shelf set. Every value has a tag
(`standard` / `derived` / `estimate`), and the tags are written into the USD as `aidc:*` attributes. The tray layout
(`rackscale-dlc-orw-44ou`: 18 compute, 9 switch, 8 power, 2 management trays) is a generic configuration, not a vendor
tray arrangement. The finish uses the shared neutral palette. The busbar sits at its datum depth inside the opaque
bulkheads, so it exists in the USD but is not visible in the viewer. The former vendor-shaped wide-rack model and its
spec were retired on 2026-09-15. Its catalog item now maps to this model through `catalogMap`, and its id is unchanged.
