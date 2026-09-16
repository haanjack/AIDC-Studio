import { describe, expect, it } from 'vitest';
import {
  CATALOG,
  analyzeProject,
  createNvidiaReferenceProject,
  findCatalogItem,
  getCatalogItem,
  resolveCatalog,
  withCatalog,
  type CatalogItem,
  type Project,
} from '../src/index.ts';

describe('registry precedence (project > library > builtin)', () => {
  it('a library item overrides builtin and a project item overrides both', () => {
    const base = getCatalogItem('amd-mi355x-dlc-4x');
    const lib: CatalogItem = { ...base, name: 'library MI355X', power: { ...base.power!, nameplateKW: 60 } };
    const prj: CatalogItem = { ...base, name: 'project MI355X', power: { ...base.power!, nameplateKW: 62 } };
    const onlyLib = resolveCatalog(undefined, { items: [lib] });
    expect(onlyLib.items.get(base.id)?.origin).toBe('library');
    expect(onlyLib.items.get(base.id)?.power?.nameplateKW).toBe(60);
    expect(onlyLib.items.size).toBe(CATALOG.length);
    const both = resolveCatalog({ catalogExtensions: [prj] }, { items: [lib] });
    expect(both.items.get(base.id)?.origin).toBe('project');
    expect(both.items.get(base.id)?.name).toBe('project MI355X');
    // builtin object untouched
    expect(findCatalogItem(base.id)).toBe(base);
    expect(findCatalogItem(base.id)?.power?.nameplateKW).toBe(base.power!.nameplateKW);
    // cables follow the same rule
    const cable = both.cables.get('acc-800');
    expect(cable?.origin).toBe('builtin');
    const withCable = resolveCatalog({ cableExtensions: [{ ...cable!, maxReachM: 6 }] }, { cables: [{ ...cable!, maxReachM: 5.5 }] });
    expect(withCable.cables.get('acc-800')?.maxReachM).toBe(6);
    expect(withCable.cables.get('acc-800')?.origin).toBe('project');
  });
});

describe('AMD rack end-to-end', () => {
  const mk = (gpuRackCatalogId: string, pods = 1): Project => createNvidiaReferenceProject({ pods, gpuRackCatalogId, name: `${gpuRackCatalogId} test` }).project;

  it('a reference hall built from MI355X DLC racks analyses without errors (space / power / cooling / network / cost)', () => {
    const p = mk('amd-mi355x-dlc-4x');
    const a = analyzeProject(p);
    expect(a.summary.gpuRacks).toBe(24);
    expect(a.summary.gpus).toBe(24 * 32);
    expect(a.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(a.issues.filter((i) => i.id.startsWith('space-unknown-'))).toEqual([]);
    expect(a.summary.itMW).toBeGreaterThan(1.3);
    expect(a.summary.itMW).toBeLessThan(2.5);
    // cooling sees the liquid share
    expect(a.cooling.liquidHeatKW).toBeCloseTo(24 * 58 * 0.87, 0); // 87 % of the GPU racks to liquid
    expect(a.cooling.cdus.units).toBeGreaterThan(0);
    // network: 8 rails × 400G endpoints per node → a feasible scale-out fabric
    const so = a.network.fabrics.find((f) => /scale-out/i.test(f.name));
    expect(so).toBeDefined();
    expect(so!.endpoints).toBe(24 * 32);
    expect(so!.totalSwitches).toBeGreaterThan(0);
    expect(so!.feasible ?? true).toBe(true);
    expect(a.network.cableRuns.length).toBeGreaterThan(0);
    expect(a.network.costUSD).toBeGreaterThan(0);
    // cost includes the AMD racks
    expect(a.cost.bom.some((l) => /MI355X/.test(l.description))).toBe(true);
    expect(a.summary.capexUSD).toBeGreaterThan(24 * 1_000_000);
    // workloads run on the AMD per-GPU spec
    expect(a.workloads.length).toBeGreaterThan(0);
    for (const w of a.workloads) expect(Number.isFinite(w.gpus)).toBe(true);
  });

  it('air-cooled AMD and NPU racks analyse as air load', () => {
    for (const id of ['amd-mi300x-air-4x', 'intel-gaudi3-air-4x', 'furiosa-rngd-10x']) {
      const a = analyzeProject(mk(id));
      expect(a.summary.gpus, id).toBe(24 * getCatalogItem(id).compute!.gpus);
      expect(a.issues.filter((i) => i.id.startsWith('space-unknown-')), id).toEqual([]);
      expect(a.summary.itMW, id).toBeGreaterThan(0);
    }
  });

  it('a project-scoped clone of an AMD rack behaves like the builtin (and disappears after analysis)', () => {
    const base = mk('amd-mi355x-dlc-4x');
    const src = getCatalogItem('amd-mi355x-dlc-4x');
    const clone: CatalogItem = { ...src, id: 'my-mi355x', name: 'MI355X clone', source: 'user' };
    const p: Project = { ...base, catalogExtensions: [clone], equipment: base.equipment.map((e) => (e.catalogId === src.id ? { ...e, catalogId: clone.id } : e)) };
    const a = analyzeProject(p);
    const b = analyzeProject(base);
    expect(a.summary.gpus).toBe(b.summary.gpus);
    expect(a.summary.itMW).toBeCloseTo(b.summary.itMW, 6);
    expect(findCatalogItem('my-mi355x')).toBeUndefined();
    expect(withCatalog(resolveCatalog(p), () => findCatalogItem('my-mi355x')?.origin)).toBe('project');
  });
});
