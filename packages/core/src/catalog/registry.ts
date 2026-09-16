import type { CableType, CatalogItem, Project } from '../model/types.ts';
import { CABLE_TYPES, CATALOG } from './catalog.ts';
import { mergeRegistrationRecords } from './checks.ts';

/**
 * Catalog registry (v2 contract).
 *
 * Effective catalog = builtin ∪ server/global library ∪ project.catalogExtensions (later layers win on id
 * collision; every item is tagged with `origin`). Engines, docs, exporters, the viewer and the server all read the
 * *active* index through `findCatalogItem` / `getCatalogItem` / `catalogItems()` / `cableTypes()` in catalog.ts;
 * the default active index is the builtin catalog so nothing changes for callers that never touch the registry.
 *
 * Activation:
 *   - `withCatalog(index, fn)` sets the index, runs the synchronous `fn` and restores the previous index (finally).
 *     `analyzeProject` and every server request handler use this.
 *   - `setActiveCatalog(index)` publishes an index for long-lived consumers (web store, workers).
 *
 * The registry is deliberately synchronous and global (module state) so the ~60 existing `findCatalogItem`
 * call sites keep working unchanged. Async code must not rely on `withCatalog` spanning an `await`.
 */
export interface CatalogIndex {
  items: Map<string, CatalogItem>;
  cables: Map<string, CableType>;
  list(): CatalogItem[];
  cableList(): CableType[];
}

export interface CatalogLibrary {
  items?: CatalogItem[];
  cables?: CableType[];
}

function makeIndex(items: Iterable<CatalogItem>, cables: Iterable<CableType>): CatalogIndex {
  const im = new Map<string, CatalogItem>();
  for (const it of items) im.set(it.id, it);
  const cm = new Map<string, CableType>();
  for (const c of cables) cm.set(c.id, c);
  return {
    items: im,
    cables: cm,
    list: () => [...im.values()],
    cableList: () => [...cm.values()],
  };
}

const tag = <T extends { origin?: CatalogItem['origin'] }>(xs: readonly T[] | undefined, origin: NonNullable<CatalogItem['origin']>): T[] =>
  (xs ?? []).map((x) => (x.origin === origin ? x : { ...x, origin }));

let builtin: CatalogIndex | null = null;

/**
 * Builtin catalog index (CATALOG ∪ CABLE_TYPES), built lazily on first use.
 * Builtin objects keep their identity (origin is stamped in place) so `findCatalogItem(id) === CATALOG[i]` still holds.
 */
export function builtinCatalog(): CatalogIndex {
  if (!builtin) {
    for (const it of CATALOG) if (!it.origin) it.origin = 'builtin';
    for (const c of CABLE_TYPES) if (!c.origin) c.origin = 'builtin';
    builtin = makeIndex(CATALOG, CABLE_TYPES);
  }
  return builtin;
}

/**
 * Resolve the effective catalog for a project: builtin ∪ library ∪ project extensions (later wins).
 * Both arguments are optional so `resolveCatalog()` is simply the builtin index.
 *
 * S3 note: when `library` is omitted (`undefined`), the base layer is the *currently active* index instead of the bare
 * builtin one, so `analyzeProject` (which calls `resolveCatalog(project)` inside `withCatalog(builtin ∪ library ∪ …)`)
 * keeps the server / web library layer instead of dropping it. Passing `library: null` forces the builtin base.
 * With nothing activated the two are identical, so every v2-contract guarantee (identity, layering) still holds.
 */
export function resolveCatalog(project?: Pick<Project, 'catalogExtensions' | 'cableExtensions'> | null, library?: CatalogLibrary | null): CatalogIndex {
  const b = library === undefined ? getActiveCatalog() : builtinCatalog();
  // stream T4 (#4): registration-only library records add meta.templateSlots to the current base item instead of hiding it
  const libItems = library?.items?.length ? tag(mergeRegistrationRecords(b.items, library.items), 'library') : [];
  const libCables = library?.cables?.length ? tag(library.cables, 'library') : [];
  const prjItems = project?.catalogExtensions?.length ? tag(project.catalogExtensions, 'project') : [];
  const prjCables = project?.cableExtensions?.length ? tag(project.cableExtensions, 'project') : [];
  if (!libItems.length && !libCables.length && !prjItems.length && !prjCables.length) return b;
  return makeIndex([...b.items.values(), ...libItems, ...prjItems], [...b.cables.values(), ...libCables, ...prjCables]);
}

let active: CatalogIndex | null = null;

/** Publish an index for long-lived consumers (web store, workers). `null` restores the builtin catalog. */
export function setActiveCatalog(index: CatalogIndex | null): void {
  active = index;
}

/** The index every catalog lookup reads from (builtin when nothing was activated). */
export function getActiveCatalog(): CatalogIndex {
  return active ?? builtinCatalog();
}

/** Run a synchronous function with `index` active, restoring the previous index afterwards. */
export function withCatalog<T>(index: CatalogIndex, fn: () => T): T {
  const prev = active;
  active = index;
  try {
    return fn();
  } finally {
    active = prev;
  }
}
