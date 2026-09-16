// N1a (neutralization): redistributable web-asset allowlist — only generated models with a stated licence qualify.
import { describe, expect, it } from 'vitest';
import { allowedModelFiles, allowedThumbnails, isRedistributableModel, type AssetManifest } from '../src/index.ts';

const manifest: AssetManifest = {
  models: [
    { name: 'helios', file: 'helios.glb', lod1: 'helios_lod1.glb', generated: true, license: 'MIT' },
    { name: 'converted', file: 'converted.glb', lod1: 'converted_lod1.glb', sourceUsd: 'Library/Assets/x.usd' },
    { name: 'no-licence', file: 'nolic.glb', generated: true },
    { name: 'blank-licence', file: 'blank.glb', generated: true, license: '  ' },
    { name: 'string-flag', file: 'flag.glb', generated: 'true' as unknown as boolean, license: 'CC0-1.0' },
    { name: 'traversal', file: '../secret.glb', generated: true, license: 'CC0-1.0' },
    { name: 'nested', file: 'sub/x.glb', generated: true, license: 'CC0-1.0' },
    { name: 'bad-lod1', file: 'ok.glb', lod1: '../evil.glb', generated: true, license: 'CC0-1.0' },
  ],
  thumbs: { 'helios.glb': 'thumbs/helios.png', 'converted.glb': 'thumbs/converted.png', 'ok.glb': '../thumbs/ok.png' },
};

describe('asset manifest allowlist (N1a)', () => {
  it('accepts only generated: true + non-empty licence + plain *.glb basename', () => {
    expect(isRedistributableModel(manifest.models![0])).toBe(true);
    for (const m of manifest.models!.slice(1, 7)) expect(isRedistributableModel(m), m.name).toBe(false);
    expect(isRedistributableModel(null)).toBe(false);
    expect(isRedistributableModel('helios.glb')).toBe(false);
  });

  it('allowedModelFiles lists LOD0 + safe LOD1 names of qualifying entries', () => {
    expect([...allowedModelFiles(manifest)].sort()).toEqual(['helios.glb', 'helios_lod1.glb', 'ok.glb']);
    expect([...allowedModelFiles(manifest, { lod1: false })].sort()).toEqual(['helios.glb', 'ok.glb']);
    expect(allowedModelFiles(null).size).toBe(0);
    expect(allowedModelFiles({}).size).toBe(0);
    expect(allowedModelFiles({ models: 'nope' as unknown as [] }).size).toBe(0);
  });

  it('allowedThumbnails drops thumbnails of non-qualifying models and unsafe paths', () => {
    expect(allowedThumbnails(manifest)).toEqual({ 'helios.glb': 'thumbs/helios.png' });
    expect(allowedThumbnails(null)).toEqual({});
  });
});
