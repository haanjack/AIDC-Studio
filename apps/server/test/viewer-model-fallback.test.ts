// N1a (neutralization): the 3D viewer requests a GLB only when /assets/manifest.json lists it as a redistributable generated
// model; every other catalog item keeps its procedural model without a network request (no 404 noise).
// Lives here because the root vitest config collects apps/server/test (not apps/web).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isModelAllowed, loadModelIndex, modelFileOf, setModelIndex } from '../../web/src/viewer/modelIndex.ts';

const manifest = {
  models: [
    { name: 'helios', file: 'helios.glb', lod1: 'helios_lod1.glb', generated: true, license: 'Apache-2.0' },
    { name: 'gb300', file: 'gb300.glb', lod1: 'gb300_lod1.glb', sourceUsd: 'third-party/legacy-rack.usd' },
  ],
};
const okFetcher = () => vi.fn(async () => ({ ok: true, json: async () => manifest }));

afterEach(() => {
  setModelIndex(null);
  vi.unstubAllGlobals();
});

describe('viewer model index (N1a)', () => {
  it('modelFileOf strips path, query and hash', () => {
    expect(modelFileOf('/assets/models/helios.glb')).toBe('helios.glb');
    expect(modelFileOf('/assets/models/helios_lod1.glb?v=2#x')).toBe('helios_lod1.glb');
  });

  it('allows manifest-listed generated models (LOD0 + LOD1) and rejects the rest; manifest fetched once', async () => {
    const f = okFetcher();
    expect(await isModelAllowed('/assets/models/helios.glb', f)).toBe(true);
    expect(await isModelAllowed('/assets/models/helios_lod1.glb', f)).toBe(true);
    expect(await isModelAllowed('/assets/models/gb300.glb', f)).toBe(false);
    expect(await isModelAllowed('/assets/models/xdu2300.glb', f)).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('missing (404) or unreadable manifest → procedural for everything', async () => {
    expect((await loadModelIndex('/assets/manifest.json', async () => ({ ok: false, json: async () => ({}) }))).size).toBe(0);
    setModelIndex(null);
    expect((await loadModelIndex('/assets/manifest.json', async () => { throw new Error('offline'); })).size).toBe(0);
    setModelIndex(null);
    expect((await loadModelIndex('/assets/manifest.json', async () => ({ ok: true, json: async () => { throw new SyntaxError('html'); } }))).size).toBe(0);
  });

  it('fetchGltf resolves null for a non-allowlisted model without calling fetch', async () => {
    const { fetchGltf } = await import('../../web/src/viewer/models.ts');
    const fetchSpy = vi.fn(async () => new Response('not found', { status: 404 }));
    vi.stubGlobal('fetch', fetchSpy);
    setModelIndex(['helios.glb']);
    expect(await fetchGltf('/assets/models/gb300.glb')).toBeNull();
    expect(await fetchGltf('/assets/models/gb300_lod1.glb')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // an allowlisted URL is fetched (the fake 404 still resolves null → procedural)
    expect(await fetchGltf('/assets/models/helios.glb')).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
