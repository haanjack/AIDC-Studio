#!/usr/bin/env python3
"""Patch `asset.extras` of a GLB written by usd_to_glb.py (JSON chunk only; the BIN chunk is copied unchanged)."""
from __future__ import annotations

import json
from pathlib import Path


def set_gltf_extras(path: Path, extras: dict):
    """Patch asset.extras of a GLB written by usd_to_glb (JSON chunk only; the BIN chunk is copied unchanged)."""
    import struct

    data = path.read_bytes()
    jlen = struct.unpack_from('<I', data, 12)[0]
    js = json.loads(data[20:20 + jlen])
    js['asset'].setdefault('extras', {}).update(extras)
    rest = data[20 + jlen:]
    nj = json.dumps(js, separators=(',', ':')).encode()
    while len(nj) % 4:
        nj += b' '
    total = 12 + 8 + len(nj) + len(rest)
    path.write_bytes(struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(nj), 0x4E4F534A) + nj + rest)
