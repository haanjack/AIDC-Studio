import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  CATALOG,
  catalogItems,
  createNvidiaReferenceProject,
  findCatalogItem,
  getActiveCatalog,
  getCatalogItem,
  resolveCatalog,
  setActiveCatalog,
  withCatalog,
  type CatalogItem,
  type Project,
} from '../src/index.ts';

const ref = () => createNvidiaReferenceProject().project;

describe('catalog registry (v2 contract)', () => {
  it('default active index is the builtin catalog', () => {
    expect(getActiveCatalog().items.size).toBe(CATALOG.length);
    expect(findCatalogItem('nvidia-gb300-nvl72')).toBe(CATALOG.find((c) => c.id === 'nvidia-gb300-nvl72'));
    expect(findCatalogItem('nvidia-gb300-nvl72')?.origin).toBe('builtin');
    expect(findCatalogItem('nvidia-gb300-nvl72')?.compute?.scaleUp).toMatchObject({ kind: 'nvlink', domainSize: 72 });
    expect(findCatalogItem('nvidia-gb300-nvl72')).not.toHaveProperty('scalableUnit');
    expect(findCatalogItem('nope')).toBeUndefined();
  });

  it('resolveCatalog merges builtin ∪ library ∪ project extensions (later wins) and tags origin', () => {
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    const lib: CatalogItem = { ...gb300, id: 'lib-rack', name: 'Library rack' };
    const prj: CatalogItem = { ...gb300, id: 'prj-rack', name: 'Project rack' };
    const override: CatalogItem = { ...gb300, id: 'lib-rack', name: 'Project override of the library rack' };
    const p: Project = { ...ref(), catalogExtensions: [prj, override] };
    const idx = resolveCatalog(p, { items: [lib] });
    expect(idx.items.size).toBe(CATALOG.length + 2);
    expect(idx.items.get('prj-rack')?.origin).toBe('project');
    expect(idx.items.get('lib-rack')?.name).toBe('Project override of the library rack');
    expect(idx.items.get('lib-rack')?.origin).toBe('project');
    expect(idx.items.get('nvidia-gb300-nvl72')?.origin).toBe('builtin');
    // builtin objects are not copied
    expect(idx.items.get('nvidia-gb300-nvl72')).toBe(gb300);
    // no extensions → the builtin index itself
    expect(resolveCatalog(ref())).toBe(resolveCatalog());
  });

  it('withCatalog activates for the synchronous call and restores afterwards', () => {
    const prev = getActiveCatalog();
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    const idx = resolveCatalog({ catalogExtensions: [{ ...gb300, id: 'tmp-rack' }] });
    const seen = withCatalog(idx, () => {
      expect(getActiveCatalog()).toBe(idx);
      return findCatalogItem('tmp-rack')?.id;
    });
    expect(seen).toBe('tmp-rack');
    expect(getActiveCatalog()).toBe(prev);
    expect(findCatalogItem('tmp-rack')).toBeUndefined();
    expect(() => withCatalog(idx, () => { throw new Error('boom'); })).toThrow('boom');
    expect(getActiveCatalog()).toBe(prev);
  });

  it('setActiveCatalog publishes an index for long-lived consumers', () => {
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    const idx = resolveCatalog({ catalogExtensions: [{ ...gb300, id: 'published-rack' }] });
    setActiveCatalog(idx);
    try {
      expect(catalogItems().some((c) => c.id === 'published-rack')).toBe(true);
    } finally {
      setActiveCatalog(null);
    }
    expect(catalogItems().some((c) => c.id === 'published-rack')).toBe(false);
  });

  it('a project-scoped catalogExtension item is analysed like a builtin item', () => {
    const base = ref();
    const baseline = analyzeProject(base);
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    const clone: CatalogItem = { ...gb300, id: 'my-gb300-clone', name: 'GB300 NVL72 (project clone)', source: 'user' };
    const p: Project = {
      ...base,
      catalogExtensions: [clone],
      equipment: base.equipment.map((e) => (e.catalogId === gb300.id ? { ...e, catalogId: clone.id } : e)),
    };
    const a = analyzeProject(p);
    expect(a.summary.gpus).toBe(6912);
    expect(a.summary.gpuRacks).toBe(96);
    expect(a.issues.filter((i) => i.id.startsWith('space-unknown-'))).toEqual([]);
    expect(a.summary.itMW).toBeCloseTo(baseline.summary.itMW, 6);
    expect(a.summary.capexUSD).toBeCloseTo(baseline.summary.capexUSD, 3);
    // the extension does not leak into the global index after analysis
    expect(findCatalogItem('my-gb300-clone')).toBeUndefined();
    // the same equipment without the extension is unknown
    const r = analyzeProject({ ...p, catalogExtensions: undefined });
    expect(r.summary.gpus).toBe(0);
    expect(r.issues.some((i) => i.id.startsWith('space-unknown-'))).toBe(true);
  });
});

describe('catalog registry — S3 semantics (library layer survives the inner resolveCatalog(project))', () => {
  /** Every activation point (analyzeProject, server routes, both thermal workers, fit.worker.ts, the web store) does
   *  `withCatalog(resolveCatalog(project, library), …)` / `setActiveCatalog(resolveCatalog(project, library))` and then
   *  `analyzeProject` runs `withCatalog(resolveCatalog(project), …)` inside. With `library` omitted the base layer is the
   *  active index, so the result is builtin ∪ library ∪ project at every call site. */
  it('builtin ∪ library ∪ project inside withCatalog / setActiveCatalog; builtin ∪ project without the library', () => {
    const base = ref();
    const gb300 = getCatalogItem('nvidia-gb300-nvl72');
    const libRack: CatalogItem = { ...gb300, id: 'lib-gb300', name: 'Library GB300', source: 'user' };
    const prjRack: CatalogItem = { ...gb300, id: 'prj-gb300', name: 'Project GB300', source: 'user' };
    const library = { items: [libRack] };
    let n = 0;
    const p: Project = {
      ...base,
      catalogExtensions: [prjRack],
      equipment: base.equipment.map((e) => (e.catalogId === gb300.id ? { ...e, catalogId: n++ % 2 ? libRack.id : prjRack.id } : e)),
    };
    const gpus = analyzeProject(base).summary.gpus;
    expect(gpus).toBe(6912);

    // server-route pattern
    const a = withCatalog(resolveCatalog(p, library), () => analyzeProject(p));
    expect(a.summary.gpus).toBe(gpus);
    expect(a.issues.filter((i) => i.id.startsWith('space-unknown'))).toEqual([]);
    expect(withCatalog(resolveCatalog(p, library), () => resolveCatalog(p).items.get('lib-gb300')?.origin)).toBe('library');

    // worker / store pattern
    setActiveCatalog(resolveCatalog(p, library));
    try {
      const idx = resolveCatalog(p); // library omitted → layered over the active index
      expect(idx.items.get('lib-gb300')?.origin).toBe('library');
      expect(idx.items.get('prj-gb300')?.origin).toBe('project');
      expect(idx.items.get('nvidia-gb300-nvl72')).toBe(gb300);
      expect(analyzeProject(p).summary.gpus).toBe(gpus);
    } finally {
      setActiveCatalog(null);
    }

    // explicit `null` library → builtin base (contract); nothing activated → the library rack is unknown
    expect(resolveCatalog(p, null).items.has('lib-gb300')).toBe(false);
    expect(resolveCatalog(p, null).items.has('prj-gb300')).toBe(true);
    const b = analyzeProject(p);
    expect(b.summary.gpus).toBe(gpus / 2);
    expect(b.issues.some((i) => i.id.startsWith('space-unknown'))).toBe(true);
    // the active index is untouched afterwards
    expect(getActiveCatalog().items.size).toBe(CATALOG.length);
  });
});
