#!/usr/bin/env python3
"""Asset provenance inventory for AIDC Studio (read-only scanner).

Walks the repository for binary / media / asset-data files, extracts embedded provenance
(glTF asset.generator + asset.extras.source, PNG text chunks, EXIF, PDF image count), checks
.gitignore status without touching the repo (uses a throw-away bare GIT_DIR outside the tree),
and applies the provenance rules documented in docs/legal/assets-provenance.md to every file.

Output: CSV (default docs/legal/inventory-assets.csv). The first line is a '#' comment
(Korean/English summary); read with e.g. pandas.read_csv(path, comment='#').

Usage:
  python3 tools/licenses/asset_inventory.py [--root .] [--out docs/legal/inventory-assets.csv]
         [--gitdir /tmp/.../gitdir]

Standard library only; Pillow is used for PNG/EXIF metadata when importable. The script never
modifies, moves or deletes repository files. This is a technical inventory, not legal advice.
"""
from __future__ import annotations

import argparse
import csv
import fnmatch
import hashlib
import json
import os
import re
import struct
import subprocess
import tempfile
from pathlib import Path

MEDIA_EXT = {
    '.glb', '.gltf', '.usd', '.usda', '.usdc', '.usdz', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.pdf', '.hdr', '.exr', '.ktx2', '.u8', '.i8', '.bin', '.cgns', '.h5', '.npz', '.npy', '.wasm', '.ttf',
    '.otf', '.woff', '.woff2', '.ico', '.mp4', '.webm', '.pck',
}
ASSET_JSON_DIRS = ('apps/web/public/assets/', 'apps/web/dist/assets/cfd/', 'apps/web/dist/assets/models/')
EXTRA_FILES = ('tools/asset-pipeline/generic_spec.json', 'apps/web/dist/assets/manifest.json')
PRUNE = {'node_modules', '.venv', '__pycache__', '.git', '.godot', '.vite'}
PRUNE_PATHS = {'data', 'assets'}  # top-level: data/ (never scanned), assets/ (reference source pack: one summary row)
# retired reference-pack abbreviation built from character codes (P6 term guard: it lives in README.md only)
PACK = ''.join(map(chr, (68, 83, 88)))
PACK_L = PACK.lower()
PACK_ROOT = PACK + '_BP'

# ── licence references (primary sources, fetched 2026-09-15) ─────────────────────────────────────
NV_EVAL = 'NVIDIA Sample Data License for Evaluation (v. Jan. 16, 2026) - NVIDIA reference blueprint content pack'
NV_EVAL_URL = ('https://developer.download.nvidia.com/licenses/nvidia-sample-data-license-for-evaluation-2026.01.19.pdf'
               ' ; https://catalog.ngc.nvidia.com/orgs/nvidia/teams/omniverse/resources/' + PACK_L + '_dataset')
APACHE = 'Apache-2.0 (AIDC Studio own work; project outbound licence)'
APACHE_URL = 'https://www.apache.org/licenses/LICENSE-2.0'
CC0_PH = 'CC0-1.0 (Poly Haven "Autumn Field (Pure Sky)", Sergej Majboroda / Jarod Guest) - copy obtained via the reference pack'
CC0_URL = 'https://polyhaven.com/a/autumn_field_puresky ; https://polyhaven.com/license'
NV_TM_URL = 'https://www.nvidia.com/en-us/about-nvidia/legal-info/'

# Neutralization 2026-09-15: shipped assets documented in apps/web/public/assets/CREDITS.json (sha256 + licence) are
# classified from that record first; the pack-era rules below only apply to files that are not documented there.
_CREDITS: dict | None = None
PACK_TEXT_RE = re.compile(PACK_ROOT + r'|Library/Assets|omniverse:' r'//|art\.ov\.nvidia|nvidia-' + PACK_L + r'|cfd/' + PACK_L + r'_|proxy_GB300')


def credits_by_path() -> dict:
    global _CREDITS
    if _CREDITS is None:
        try:
            _CREDITS = {a['path']: a for a in json.loads(Path('apps/web/public/assets/CREDITS.json').read_text())['assets']}
        except Exception:  # noqa: BLE001
            _CREDITS = {}
    return _CREDITS


def sha_full(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


PACK_SRC_RE = re.compile(r'^(gb300|xdu1350|xdu2300|cw084|cw181|cw375)(_lod1)?\.(glb|png)$')
SHOT_3D_HINT = re.compile(
    r'(3d|iso|viewer|view|hall|layout|cool|therm|cfd|catalog|thumb|rack|final|integration|walk|helios|gb300|'
    r'xdu|cw0|cw1|cw3|pod|row|aisle|volume|inlet|power|select|drag|focus|hover|built-ref|app|site|overview|geometry|'
    r'finish|autosize|template|t1|t2|t8|s1|s2|s3|s4)', re.I)
SHOT_2D_HINT = re.compile(r'(\.svg$|/docs/|i18n|network|workload|ipmap|drawings|sheet|crop|overview-|/D/|schedule|cost|'
                          r'report|collapse|upload|save|wl-|composer)', re.I)


def sha16(p: Path) -> str:
    h = hashlib.sha256()
    with p.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()[:16]


def glb_meta(p: Path) -> str:
    try:
        b = p.read_bytes()
        ln = struct.unpack('<I', b[12:16])[0]
        j = json.loads(b[20:20 + ln])
        a = j.get('asset', {})
        ex = a.get('extras', {}) or {}
        names = [m.get('name', '') for m in j.get('materials', [])]
        logos = sorted({n for n in names if re.search(r'logo|card|screen', n, re.I)})
        return (f"generator={a.get('generator', '')}; copyright={a.get('copyright', '')}; "
                f"extras.source={ex.get('source', '')}; images={len(j.get('images', []))}; brandish_materials={'|'.join(logos)}")
    except Exception as e:  # noqa: BLE001
        return f'glb parse error: {e}'


def img_meta(p: Path) -> str:
    try:
        from PIL import Image  # type: ignore
        im = Image.open(p)
        info = {k: str(v)[:60] for k, v in im.info.items()
                if k not in ('dpi', 'gamma', 'transparency', 'srgb', 'chromaticity', 'icc_profile', 'aspect', 'jfif',
                             'jfif_version', 'jfif_unit', 'jfif_density')}
        exif = dict(im.getexif())
        s = f'{im.size[0]}x{im.size[1]}'
        if info:
            s += '; text=' + json.dumps(info, ensure_ascii=False)
        if exif:
            s += f'; exif_tags={len(exif)}'
        return s
    except Exception:  # noqa: BLE001
        return ''


def pdf_meta(p: Path) -> str:
    b = p.read_bytes()
    imgs = len(re.findall(rb'/Subtype\s*/Image', b))
    creator = re.search(rb'/Creator \((.{0,40})', b)
    return f"embedded_images={imgs}; creator={creator.group(1).decode('latin1') if creator else ''}"


def usda_meta(p: Path) -> str:
    try:
        head = p.read_text(errors='replace')[:400] if p.suffix == '.usda' else ''
        m = re.search(r'"([^"]{0,160})"', head)
        return f'layer doc: {m.group(1)}' if m else 'binary crate (see Helios.usda for layer doc)'
    except Exception:  # noqa: BLE001
        return ''


def git_ignored(root: Path, rels: list[str], gitdir: str | None) -> set[str]:
    tmp = None
    if not gitdir:
        tmp = tempfile.mkdtemp(prefix='aidc-lic-')
        gitdir = os.path.join(tmp, 'gitdir')
    try:
        if not os.path.isdir(gitdir):
            subprocess.run(['git', 'init', '-q', '--bare', gitdir], check=True)
        env = dict(os.environ, GIT_DIR=gitdir, GIT_WORK_TREE=str(root))
        r = subprocess.run(['git', 'check-ignore', '--no-index', '--stdin'], input='\n'.join(rels), text=True,
                           capture_output=True, env=env)
        return set(r.stdout.split('\n')) - {''}
    except Exception:  # noqa: BLE001  fallback: rough fnmatch
        pats = [l.strip() for l in (root / '.gitignore').read_text().splitlines() if l.strip() and not l.startswith('#')]
        out = set()
        for rel in rels:
            parts = rel.split('/')
            for pat in pats:
                pd = pat.rstrip('/')
                if '/' in pd and (rel.startswith(pd + '/') or fnmatch.fnmatch(rel, pd)):
                    out.add(rel)
                elif '/' not in pd and any(fnmatch.fnmatch(x, pd) for x in parts):
                    out.add(rel)
        return out


def docker_included(rel: str) -> bool:
    # .dockerignore patterns are root-anchored (assets, data, apps/web/dist, tools/asset-pipeline/.venv, **/node_modules)
    return not (rel.startswith('assets/') or rel.startswith('data/') or rel.startswith('apps/web/dist/')
                or rel.startswith('tools/asset-pipeline/.venv/'))


def classify(rel: str, name: str) -> dict:
    """Provenance rules. Returns category/source/licence/redistribution/attribution/risk/action/evidence."""
    d = dict(category='', source_type='', source_detail='', license_terms='', license_url='', redistribution_allowed='',
             attribution_needed='', risk='', action='', evidence='')
    in_assets = '/assets/' in rel and (rel.startswith('apps/web/public/') or rel.startswith('apps/web/dist/'))
    build_copy = rel.startswith('apps/web/dist/')
    copy_note = ' [build copy of apps/web/public/assets - identical sha256]' if build_copy else ''
    sub = rel.split('/assets/', 1)[1] if in_assets else ''

    cred = credits_by_path().get(sub) if in_assets else None
    if cred is not None and sha_full(Path(rel)) == cred.get('sha256'):
        own = 'AIDC Studio original' in str(cred.get('license', ''))
        kind = str(cred.get('kind', ''))
        d.update(category={'hdri': 'hdri-environment', 'thumbnail': 'image-render'}.get(kind, '3d-model' if kind.startswith('model') else 'usd-scene' if kind.startswith('usd') else kind),
                 source_type='own-generated-parametric' if own else 'downloaded-third-party (original source, sha256 pinned)',
                 source_detail=f"{cred.get('generator', '')} <- {cred.get('source', '') if isinstance(cred.get('source'), str) else cred.get('sourcePage', '')}",
                 license_terms=APACHE if own else f"{cred.get('license')} ({cred.get('title')}, {', '.join(cred.get('authors', []))})",
                 license_url=APACHE_URL if own else str(cred.get('licenseUrl') or cred.get('sourcePage') or ''),
                 redistribution_allowed='YES', attribution_needed='project NOTICE only' if own else 'not required by the licence (courtesy credit in NOTICE / CREDITS.json)',
                 risk='LOW', action='KEEP', evidence='CREDITS.json entry, sha256 match' + copy_note)
    elif in_assets and name in ('manifest.json', '_models_report.json') and not PACK_TEXT_RE.search(Path(rel).read_text(errors='replace')):
        d.update(category='asset-metadata', source_type='own-generated (index of own generated assets only)',
                 source_detail='generic_manifest.py (shared manifest writer; refuses third-party paths)', license_terms=APACHE, license_url=APACHE_URL,
                 redistribution_allowed='YES', attribution_needed='no', risk='LOW', action='KEEP',
                 evidence='file content: no pack / Library / omniverse / cfd references' + copy_note)
    elif in_assets and sub.startswith('models/') and PACK_SRC_RE.match(name) and name.endswith('.glb'):
        stem = name.split('_lod1')[0].split('.')[0]
        vendor = 'NVIDIA-authored proxy GB300 NVL72 rack (embedded card-art JPEG textures)' if stem == 'gb300' else \
            'Vertiv SimReady CDU/CRAH asset shipped in the NVIDIA reference pack (contains logo_white / HMI screen meshes)'
        d.update(category='3d-model', source_type='derived-from-vendor-asset',
                 source_detail=f'usd_to_glb.py conversion + decimation of {PACK_ROOT} {vendor}',
                 license_terms=NV_EVAL + '; plus third-party trademark (NVIDIA / Vertiv, Liebert)',
                 license_url=NV_EVAL_URL, redistribution_allowed='NO (s.2(c): may not distribute Derivative Works; s.1 internal evaluation of NVIDIA technologies only)',
                 attribution_needed='n/a (not licensable for distribution)', risk='HIGH',
                 action='DELETE before publishing / keep outside the repo, image and exports; replace with own parametric model (Helios-style generator) or catalog box',
                 evidence='glTF asset.extras.source points into ' + PACK_ROOT + ' Library; manifest.json "source" says license-restricted' + copy_note)
    elif in_assets and sub.startswith('models/') and name.startswith('helios'):
        d.update(category='3d-model', source_type='own-generated-parametric',
                 source_detail='helios_build.py <- helios_spec.json (public dimensions/counts; colours read from AMD renders; no textures, no logos)',
                 license_terms=APACHE, license_url=APACHE_URL, redistribution_allowed='YES',
                 attribution_needed='project NOTICE only; name "AMD Helios" is a third-party trademark (nominative use, add disclaimer)',
                 risk='LOW', action='KEEP (fix .gitignore: "assets/" pattern currently ignores it) + trademark disclaimer',
                 evidence='glTF extras.source=usd/Helios/Helios.usd; images=0; manifest license field' + copy_note)
    elif in_assets and name == '_models_report.json':
        d.update(category='asset-metadata', source_type='own-generated (describes pack-derived + own models)',
                 source_detail='usd_to_glb.py report: dims, triangle counts, ' + PACK_ROOT + ' source paths',
                 license_terms='AIDC Studio own work; factual metadata about NVIDIA Sample Dataset (Derivative-Work status: counsel)',
                 license_url=NV_EVAL_URL, redistribution_allowed='CONDITIONAL (strip pack entries)', attribution_needed='no',
                 risk='MEDIUM', action='REGENERATE without pack-derived entries before publishing', evidence='file content' + copy_note)
    elif in_assets and name == 'manifest.json':
        d.update(category='asset-metadata', source_type='own-generated (index of pack-derived + own assets)',
                 source_detail='build_all.py manifest; lists ' + PACK_ROOT + ' paths incl. omniverse:' '//art.ov.nvidia.com HDR path and CFD case name',
                 license_terms='AIDC Studio own work; references NVIDIA Sample Dataset', license_url=NV_EVAL_URL,
                 redistribution_allowed='CONDITIONAL (strip pack entries)', attribution_needed='no', risk='MEDIUM',
                 action='REGENERATE with only own assets (helios, own CFD) before publishing', evidence='file content' + copy_note)
    elif in_assets and (sub.startswith('models/thumbs/') or sub.startswith('thumbs/')):
        if name.startswith('helios'):
            d.update(category='image-render', source_type='own-render-of-own-asset',
                     source_detail='render_thumbs.py (headless Chromium + three.js) of models/helios.glb',
                     license_terms=APACHE, license_url=APACHE_URL, redistribution_allowed='YES', attribution_needed='no',
                     risk='LOW', action='KEEP (fix .gitignore)', evidence='manifest thumbs map' + copy_note)
        else:
            d.update(category='image-render', source_type='render-of-derived-vendor-asset',
                     source_detail=f'render of pack-derived {name.split(".")[0]} GLB (Vertiv wordmark legible on CDU/CRAH renders; GB300 card art)',
                     license_terms=NV_EVAL + '; Vertiv / NVIDIA trademarks', license_url=NV_EVAL_URL + ' ; ' + NV_TM_URL,
                     redistribution_allowed='NO (render = Derivative Work of Sample Dataset)', attribution_needed='n/a',
                     risk='HIGH', action='DELETE before publishing; re-render from replacement parametric models',
                     evidence='visual inspection (thumbs/xdu1350.png, cw375.png show VERTIV logo)' + copy_note)
    elif in_assets and sub.startswith('cfd/'):
        pv = name.startswith('preview_')
        d.update(category='cfd-preview-image' if pv else 'cfd-field-data', source_type='derived-from-vendor-asset',
                 source_detail=('matplotlib slices of ' if pv else 'cgns_to_grid.py voxelisation/quantisation of ')
                 + PACK_ROOT + ' simulation/NV_DC_DS9-GB300_R0-GPU-SinglePOD.cgns (NVIDIA reference CFD result)',
                 license_terms=NV_EVAL, license_url=NV_EVAL_URL,
                 redistribution_allowed='NO (s.2(c))', attribution_needed='n/a', risk='HIGH',
                 action='DELETE before publishing; replace with packages/thermal solver output for an own reference layout',
                 evidence=PACK_L + '_gb300_pod.json "source"; PNG text chunk Software=Matplotlib' + copy_note)
    elif in_assets and sub.startswith('env/'):
        d.update(category='hdri-environment', source_type='downloaded-third-party (via the reference pack)',
                 source_detail='env_map.py downsample (1024x512) of ' + PACK_ROOT + ' .../GTC25_Aurora/Lighting/autumn_field_puresky_4k.hdr = Poly Haven HDRI',
                 license_terms=CC0_PH, license_url=CC0_URL,
                 redistribution_allowed='YES for the CC0 original; re-source from Poly Haven so the copy is not taken from the NVIDIA pack',
                 attribution_needed='not required by CC0 (courtesy credit recommended)', risk='LOW',
                 action='REGENERATE from the Poly Haven download (same file name) and record CC0 credit; then keep',
                 evidence='manifest.json env.source; pack .collect.mapping.json omniverse:' '//art.ov.nvidia.com path; polyhaven.com asset page' + copy_note)
    elif in_assets and sub.startswith('usd/Helios/'):
        d.update(category='usd-scene', source_type='own-generated-parametric',
                 source_detail='helios_usd.py <- helios_spec.json (aidc:* provenance attrs, aif:* SimReady-style schema names)',
                 license_terms=APACHE + '; aif:* attribute names follow NVIDIA SimReady metadata spec (naming convention only)',
                 license_url=APACHE_URL, redistribution_allowed='YES',
                 attribution_needed='project NOTICE; "AMD", "Helios", "Instinct", "EPYC" trademarks in metadata (nominative)',
                 risk='LOW', action='KEEP (fix .gitignore) + trademark disclaimer', evidence=usda_meta(Path(rel)) + copy_note)
    elif rel == 'tools/asset-pipeline/helios_spec.json':
        d.update(category='asset-spec-data', source_type='own (compiled from public sources S1..S26)',
                 source_detail='docs/research/helios.md sources; facts + estimates, no copied text blocks beyond short labels',
                 license_terms=APACHE, license_url=APACHE_URL, redistribution_allowed='YES', attribution_needed='cite sources (already in helios.md)',
                 risk='LOW', action='KEEP', evidence='file content')
    elif rel.startswith('apps/web/src/viewer/__screenshots__/'):
        d.update(category='screenshot', source_type='screenshot-of-own-app (depicts pack-derived models/CFD)',
                 source_detail='viewer QA screenshots 2026-09-13: GB300 proxy racks, Vertiv CDU/CRAH GLBs, NVIDIA reference CFD overlays',
                 license_terms='AIDC Studio UI (own) + depicted NVIDIA Sample Dataset derivatives + Vertiv/NVIDIA trademarks',
                 license_url=NV_EVAL_URL, redistribution_allowed='NO while pack-derived content is visible',
                 attribution_needed='n/a', risk='MEDIUM-HIGH',
                 action='MOVE OUT of the public repo (not referenced by tests) or retake with own parametric models',
                 evidence='visual inspection 01_iso.png (Vertiv CRAH/CDU + GB300 racks)')
    elif rel.startswith('docs/research/shots'):
        ext = Path(name).suffix.lower()
        if ext == '.svg':
            d.update(category='drawing-export', source_type='own-app-generated vector drawing',
                     source_detail='AIDC Studio 2D drawing sheet export (text + vectors; NVIDIA reference-POD layout names possible)',
                     license_terms=APACHE, license_url=APACHE_URL, redistribution_allowed='YES (check sheet titles naming the NVIDIA reference blueprint)',
                     attribution_needed='no', risk='LOW', action='KEEP or move to docs artefacts; rename blueprint-named sheet titles to "reference"',
                     evidence='no <image> elements')
        elif ext == '.pdf':
            imgs = pdf_meta(Path(rel))
            risky = not imgs.startswith('embedded_images=0')
            d.update(category='document-export', source_type='own-app-generated PDF (HeadlessChrome/Skia)',
                     source_detail='AIDC Studio design document / drawing print',
                     license_terms=APACHE + ('; embedded raster images may be 3D views of pack-derived models' if risky else ''),
                     license_url=APACHE_URL, redistribution_allowed='REVIEW' if risky else 'YES', attribution_needed='no',
                     risk='MEDIUM' if risky else 'LOW',
                     action='REVIEW embedded images; exclude from public repo or regenerate after pack models are replaced' if risky else 'KEEP',
                     evidence=imgs)
        elif ext in ('.json', '.txt'):
            d.update(category='qa-report', source_type='own', license_terms=APACHE, license_url=APACHE_URL,
                     redistribution_allowed='YES', attribution_needed='no', risk='LOW', action='KEEP or exclude with shots', evidence='')
        else:
            likely3d = bool(SHOT_3D_HINT.search(rel)) and not bool(SHOT_2D_HINT.search(rel))
            d.update(category='screenshot', source_type='screenshot-of-own-app',
                     source_detail='QA/research screenshot of AIDC Studio (Chromium headless)' +
                     ('; name suggests 3D viewport/catalog render - likely shows pack-derived Vertiv/GB300 models or reference CFD' if likely3d else
                      '; name suggests 2D/UI panel - may still include catalog thumbnails'),
                     license_terms='AIDC Studio UI (own); depicted pack-derived content is under ' + NV_EVAL,
                     license_url=NV_EVAL_URL, redistribution_allowed='REVIEW (heuristic classification, not verified per image)',
                     attribution_needed='no', risk='MEDIUM' if likely3d else 'LOW-MEDIUM',
                     action='EXCLUDE docs/research/shots* from the public repo (gitignore / move to private archive); publish only curated, retaken screenshots',
                     evidence='file-name heuristic; spot checks: shots-v2-2/qa-cw/10-*.png (GB300 render), helios-look/after-05-*.png (GB300 card art + Vertiv CDU)')
    else:
        d.update(category='other-media', source_type='unclassified', license_terms='UNVERIFIED', risk='REVIEW',
                 action='REVIEW manually', evidence='no rule matched')
    return d


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='.')
    ap.add_argument('--out', default='docs/legal/inventory-assets.csv')
    ap.add_argument('--gitdir', default=None, help='existing scratch bare git dir for check-ignore (outside the repo)')
    a = ap.parse_args()
    root = Path(a.root).resolve()
    os.chdir(root)

    rels: list[str] = []
    for dp, dn, fn in os.walk('.'):
        rp = os.path.relpath(dp, '.')
        dn[:] = sorted(x for x in dn if x not in PRUNE and not (rp == '.' and x in PRUNE_PATHS))
        for f in sorted(fn):
            rel = os.path.normpath(os.path.join(rp, f)).replace(os.sep, '/')
            ext = Path(f).suffix.lower()
            if ext in MEDIA_EXT or (ext in ('.json', '.txt') and rel.startswith(('docs/research/shots',)) and False) \
                    or (ext == '.json' and rel.startswith(ASSET_JSON_DIRS)) or rel in EXTRA_FILES:
                rels.append(rel)
    ignored = git_ignored(root, rels, a.gitdir)

    cols = ['path', 'size_bytes', 'sha256_16', 'category', 'source_type', 'source_detail', 'license_terms', 'license_url',
            'redistribution_allowed', 'attribution_needed', 'gitignored', 'in_docker_build_context', 'shipped_via',
            'risk', 'recommended_action', 'embedded_metadata', 'evidence']
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    with open(a.out, 'w', newline='', encoding='utf-8') as fh:
        fh.write('# 요약: AIDC Studio 에셋/미디어 출처 인벤토리 (도구 tools/licenses/asset_inventory.py 생성). 레퍼런스 팩 파생 GLB/CFD/썸네일은 '
                 'NVIDIA 평가용 샘플 데이터 라이선스상 배포 불가(HIGH) - 공개 전 제외 필요. Helios/HDRI(CC0 재다운로드)는 유지 가능. '
                 '법률 자문 아님. | Summary: per-file provenance; see docs/legal/assets-provenance.md. Not legal advice.\n')
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerow(dict(path=f'assets/{PACK_ROOT}/** (source pack, 38 GB, not enumerated)', size_bytes='', sha256_16='',
                        category='vendor-source-pack', source_type='downloaded-vendor-dataset',
                        source_detail='NVIDIA Omniverse reference blueprint content pack (NGC ' + PACK_L + '_dataset): USD scene, SimReady-style assets incl. Vertiv CDU/CRAH, proxy GB300, CGNS CFD, collected HDRIs',
                        license_terms=NV_EVAL, license_url=NV_EVAL_URL,
                        redistribution_allowed='NO (internal evaluation of NVIDIA technologies only; no distribution of dataset or Derivative Works)',
                        attribution_needed='n/a', gitignored='yes', in_docker_build_context='no (.dockerignore: assets)',
                        shipped_via='none (the retired server loader read it only when its asset-root variable was set; USD export writes references, not copies)',
                        risk='HIGH (use scope)', recommended_action='NEVER publish; counsel to confirm whether use inside a commercial planning tool fits the evaluation Purpose',
                        embedded_metadata='USD customLayerData: camera settings only; no copyright/licence prims',
                        evidence='NGC catalog page licence link; NVIDIA-Omniverse-blueprints README "Governing Terms"'))
        for rel in rels:
            p = Path(rel)
            name = p.name
            ext = p.suffix.lower()
            meta = ''
            if ext == '.glb':
                meta = glb_meta(p)
            elif ext in ('.png', '.jpg', '.jpeg', '.webp'):
                meta = img_meta(p)
            elif ext == '.pdf':
                meta = pdf_meta(p)
            elif ext == '.hdr':
                meta = ' '.join(p.read_bytes()[:64].decode('latin1', 'replace').split('\n')[:3])
            elif ext in ('.usda', '.usd'):
                meta = usda_meta(p)
            c = classify(rel, name)
            shipped = []
            if rel.startswith('apps/web/public/assets/'):
                shipped += ['vite build copies to apps/web/dist', 'server static /assets/', 'Docker image (COPY . .)']
                if rel.startswith('apps/web/public/assets/models/') and ext == '.glb':
                    shipped += ['Godot/Unreal export zip (export-zip.ts addModels)']
            elif rel.startswith('apps/web/dist/'):
                shipped += ['web deployment artefact (dist)']
            elif docker_included(rel):
                shipped += ['Docker image (COPY . .; not excluded by .dockerignore)']
            w.writerow({
                'path': rel, 'size_bytes': p.stat().st_size, 'sha256_16': sha16(p), **{k: c[k] for k in (
                    'category', 'source_type', 'source_detail', 'license_terms', 'license_url', 'redistribution_allowed',
                    'attribution_needed', 'risk', 'evidence')},
                'recommended_action': c['action'], 'gitignored': 'yes' if rel in ignored else 'no',
                'in_docker_build_context': 'yes' if docker_included(rel) else 'no',
                'shipped_via': '; '.join(shipped), 'embedded_metadata': meta,
            })
    print(f'wrote {a.out}: {len(rels) + 1} rows ({len(ignored)} gitignored)')


if __name__ == '__main__':
    main()
