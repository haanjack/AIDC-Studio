#!/usr/bin/env python3
"""Downsample the Poly Haven "Autumn Field (Pure Sky)" HDRI (CC0) into a small RLE-compressed Radiance .hdr for the web viewer.

Source: https://polyhaven.com/a/autumn_field_puresky — licence CC0 1.0 (https://polyhaven.com/license),
authors Sergej Majboroda (original) and Jarod Guest (sky edits). The 4k .hdr is downloaded from the Poly Haven CDN (or read
from --src), verified against the pinned sha256, cached under ~/.cache/aidc-asset-pipeline/ and resized to 1024 x 512.
No third-party content pack is read.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

import cv2
import numpy as np

SOURCE_PAGE = 'https://polyhaven.com/a/autumn_field_puresky'
SOURCE_URL = 'https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/4k/autumn_field_puresky_4k.hdr'
SOURCE_SHA256 = '52e13951317a14f74d9c04d687368d702f1c0648b48265f17831310a95eba2e9'
SOURCE_BYTES = 16984221
LICENSE = 'CC0-1.0'
LICENSE_URL = 'https://polyhaven.com/license'
AUTHORS = ['Sergej Majboroda (original)', 'Jarod Guest (sky edits)']
CACHE = Path.home() / '.cache' / 'aidc-asset-pipeline'


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch_source(src: str | None) -> Path:
    if src:
        p = Path(src)
    else:
        p = CACHE / Path(SOURCE_URL).name
        if not p.exists() or sha256(p) != SOURCE_SHA256:
            p.parent.mkdir(parents=True, exist_ok=True)
            print(f'[env] downloading {SOURCE_URL}')
            tmp = p.with_suffix('.part')
            urllib.request.urlretrieve(SOURCE_URL, tmp)
            tmp.replace(p)
    digest = sha256(p)
    if digest != SOURCE_SHA256:
        raise RuntimeError(f'{p}: sha256 {digest} does not match the pinned Poly Haven file {SOURCE_SHA256}')
    return p


def update_credits(assets_root: Path, entry: dict) -> Path:
    """Merge one asset entry (matched by `path`) into <assets>/CREDITS.json, keeping every other entry."""
    path = assets_root / 'CREDITS.json'
    credits = json.loads(path.read_text()) if path.exists() else {}
    credits.setdefault('schema', 'aidc.asset-credits/1')
    assets = [a for a in credits.get('assets', []) if a.get('path') != entry['path']]
    assets.append(entry)
    credits['assets'] = sorted(assets, key=lambda a: a['path'])
    path.write_text(json.dumps(credits, indent=2, ensure_ascii=False) + '\n')
    return path


def main(argv=None):
    here = Path(__file__).resolve().parent
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=None, help='local copy of autumn_field_puresky_4k.hdr (default: download from Poly Haven)')
    ap.add_argument('--out', default=str(here / '../../apps/web/public/assets'))
    ap.add_argument('--width', type=int, default=1024)
    ap.add_argument('--no-credits', action='store_true', help='do not update <out>/CREDITS.json')
    args = ap.parse_args(argv)
    src = fetch_source(args.src)
    img = cv2.imread(str(src), cv2.IMREAD_ANYDEPTH | cv2.IMREAD_COLOR)
    if img is None:
        raise RuntimeError(f'cannot read {src}')
    h = args.width // 2
    small = cv2.resize(img.astype(np.float32), (args.width, h), interpolation=cv2.INTER_AREA)
    out_dir = Path(args.out) / 'env'
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / 'sky_1k.hdr'
    cv2.imwrite(str(dst), small)
    print(f'[env] {src.name} {img.shape[1]}x{img.shape[0]} → {dst} {args.width}x{h} ({dst.stat().st_size/1024:.0f} KiB)')
    digest = sha256(dst)
    if not args.no_credits:
        update_credits(Path(args.out), {
            'path': 'env/sky_1k.hdr', 'kind': 'hdri', 'title': 'Autumn Field (Pure Sky)', 'authors': AUTHORS,
            'sourcePage': SOURCE_PAGE, 'sourceUrl': SOURCE_URL, 'sourceSha256': SOURCE_SHA256, 'sourceBytes': SOURCE_BYTES,
            'license': LICENSE, 'licenseUrl': LICENSE_URL, 'sha256': digest, 'bytes': dst.stat().st_size,
            'generator': f'tools/asset-pipeline/env_map.py (OpenCV INTER_AREA resize to {args.width}x{h}, Radiance RLE)',
            'modified': True,
        })
    return {
        'file': 'env/sky_1k.hdr', 'width': args.width, 'height': h, 'bytes': dst.stat().st_size, 'sha256': digest,
        'generated': True, 'generator': 'tools/asset-pipeline/env_map.py',
        'source': {'title': 'Autumn Field (Pure Sky)', 'page': SOURCE_PAGE, 'url': SOURCE_URL, 'sha256': SOURCE_SHA256, 'bytes': SOURCE_BYTES, 'authors': AUTHORS},
        'license': LICENSE, 'licenseUrl': LICENSE_URL,
    }


if __name__ == '__main__':
    print(json.dumps(main(), indent=2))
