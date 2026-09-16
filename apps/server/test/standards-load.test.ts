// Stream A (P1): server load hooks run upgradeProject (storage read + version snapshots); library legacy source tags load.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createNvidiaReferenceProject, getCatalogItem, LEGACY_KEYS, type Project } from '../../../packages/core/src/index.ts';
import { catalogLibraryErrors, CatalogStore } from '../src/catalogStore.ts';
import { ProjectStore } from '../src/storage.ts';

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'aidc-standards-load-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('server load hooks (stream A)', () => {
  it('ProjectStore.get preserves a current template id, infers the profile and leaves the file untouched', async () => {
    const dir = scratch();
    const { project } = createNvidiaReferenceProject({ pods: 1 });
    const legacy: Project = { ...project, id: 'legacy-p', standards: undefined };
    const raw = JSON.stringify(legacy, null, 2);
    writeFileSync(join(dir, 'legacy-p.json'), raw);
    const store = new ProjectStore(dir);
    const got = (await store.get('legacy-p'))!;
    expect(got.halls[0].layoutPolicy?.templateId).toBe('rack-scale-liquid-du');
    expect(got.standards?.inferred).toBe(true);
    expect(got.updatedAt).toBe(legacy.updatedAt);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'legacy-p.json'), 'utf8')).toBe(raw);
  });

  it('a library with the legacy source tag validates and loads with the canonical source', async () => {
    const dir = scratch();
    const base = getCatalogItem('intel-gaudi3-air-4x');
    const { origin: _o, ...item } = { ...base, id: 'lib-legacy', source: LEGACY_KEYS.specSources[0] };
    void _o;
    const body = { items: [item], cables: [] };
    expect(catalogLibraryErrors(body)).toEqual([]);
    writeFileSync(join(dir, 'custom.json'), JSON.stringify(body));
    const { library, errors } = await new CatalogStore(dir).load();
    expect(errors).toEqual([]);
    expect(library.items[0].source).toBe('vendor-datasheet');
  });
});
