import type { CatalogItem, EquipmentInstance } from '../model/types.ts';
import type { CatalogLibrary } from './registry.ts';
import { acceleratorFlopsKey, ACCELERATOR_FLOPS } from './flops.ts';

/**
 * Stream T4 (technical leftovers, 2026-09-15): small catalog-side helpers shared by the web panels, the BOM, fit-to-space and
 * the library registration path. Pure functions; no vendor defaults.
 */

// ── (1) coolant limit vs project TCS supply ────────────────────────────────────────────────────────────────

export interface CoolantLimitCheck {
  catalogId: string;
  /** item's max allowed coolant supply (°C) */
  limitC: number;
  /** project TCS supply (°C) */
  tcsSupplyC: number;
  /** tcsSupplyC − limitC (> 0) */
  excessC: number;
}

/** A liquid-cooled item whose coolant supply limit is below the project TCS supply; undefined when compatible or not liquid-cooled. */
export function coolantLimitCheck(item: Pick<CatalogItem, 'id' | 'cooling'> | undefined, tcsSupplyC: number): CoolantLimitCheck | undefined {
  const k = item?.cooling;
  if (!item || !k || !(k.liquidFraction > 0)) return undefined;
  const limitC = k.maxCoolantSupplyC;
  if (typeof limitC !== 'number' || !Number.isFinite(limitC) || !Number.isFinite(tcsSupplyC)) return undefined;
  if (tcsSupplyC <= limitC + 1e-9) return undefined;
  return { catalogId: item.id, limitC, tcsSupplyC, excessC: Math.round((tcsSupplyC - limitC) * 10) / 10 };
}

// ── (5) announced figures ───────────────────────────────────────────────────────────────────────────────────

/** `meta.specStatus === 'announced'` (or an item source of `announced`) and the stated fields listed in `meta.announcedFields`. */
export function announcedSpec(item: Pick<CatalogItem, 'source' | 'meta'> | undefined): { announced: boolean; fields: string[] } {
  if (!item) return { announced: false, fields: [] };
  const fields = Array.isArray(item.meta?.announcedFields) ? (item.meta!.announcedFields as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return { announced: item.meta?.specStatus === 'announced' || item.source === 'announced', fields };
}

// ── (2)(6) GPU vs accelerator-slot chip counts ──────────────────────────────────────────────────────────────

/** Accelerator compute-slot rack (Groq LPX / NPU racks placed through a template accelerator slot). */
export const isAcceleratorSlotRack = (e: Pick<EquipmentInstance, 'meta'>): boolean => typeof e.meta?.computeSlot === 'string';

/** Chips of one placed instance: `gpus` for primary compute racks, `accelerators` for accelerator-slot racks (never both). */
export function computeCountsOf(e: Pick<EquipmentInstance, 'meta'>, item: Pick<CatalogItem, 'category' | 'compute'> | undefined): { gpus: number; accelerators: number } {
  if (!item || item.category !== 'gpu-rack') return { gpus: 0, accelerators: 0 };
  const n = item.compute?.gpus ?? 0;
  return isAcceleratorSlotRack(e) ? { gpus: 0, accelerators: n } : { gpus: n, accelerators: 0 };
}

/** GPU and accelerator-slot chip totals per DU id (placed equipment with a `podId`). */
export function computeCountsByPod(equipment: readonly EquipmentInstance[], find: (id: string) => CatalogItem | undefined): Map<string, { gpus: number; accelerators: number }> {
  const out = new Map<string, { gpus: number; accelerators: number }>();
  for (const e of equipment) {
    if (!e.podId) continue;
    const c = computeCountsOf(e, find(e.catalogId));
    const cur = out.get(e.podId) ?? { gpus: 0, accelerators: 0 };
    cur.gpus += c.gpus;
    cur.accelerators += c.accelerators;
    out.set(e.podId, cur);
  }
  return out;
}

// ── (3) normalised compute for fit-to-space ─────────────────────────────────────────────────────────────────

/**
 * Per-chip peak compute (TFLOP/s) used to compare candidates of different accelerator families: the family table's BF16 peak,
 * else the item's own `compute.peakTflops.bf16`, else `compute.gpuFlopsPeak` (FLOP/s → TFLOP/s). Source string says which.
 */
export function chipComputeTflops(item: Pick<CatalogItem, 'compute' | 'meta'> | undefined): { tflops: number; source: string; family: string } {
  const c = item?.compute;
  if (!item || !c || !(c.gpus > 0)) return { tflops: 0, source: 'none', family: 'none' };
  const key = acceleratorFlopsKey(item);
  const fam = key ? ACCELERATOR_FLOPS[key] : undefined;
  const family = key ?? `${c.accelerator?.vendor ?? ''} ${c.accelerator?.family ?? c.gpuModel}`.trim();
  if (fam?.peakTflops.bf16) return { tflops: fam.peakTflops.bf16, source: `family table ${key} (BF16)`, family };
  if (c.peakTflops?.bf16) return { tflops: c.peakTflops.bf16, source: 'catalog peakTflops.bf16', family };
  const t = c.gpuFlopsPeak > 1e6 ? c.gpuFlopsPeak / 1e12 : c.gpuFlopsPeak; // gpuFlopsPeak is FLOP/s in the seeds; tolerate TFLOP/s
  return { tflops: t > 0 ? t : 0, source: 'catalog gpuFlopsPeak', family };
}

// ── (4) library registration records ────────────────────────────────────────────────────────────────────────

/** `meta.registrationOnly`: a library record that only adds template-slot registrations to the item with the same id. */
export const isRegistrationRecord = (it: Pick<CatalogItem, 'meta'>): boolean => it.meta?.registrationOnly === true;

/**
 * Registration-only library record for `base` (a built-in item): identity fields plus `meta.templateSlots`. The spec fields are
 * placeholders that satisfy the server's item validation and are never read — `resolveCatalog` merges the record's registrations
 * into the current built-in item, so later seed updates stay visible.
 */
export function registrationRecord(base: Pick<CatalogItem, 'id' | 'category' | 'name' | 'vendor' | 'model' | 'source'>, templateSlots: readonly string[]): CatalogItem {
  return {
    id: base.id, category: base.category, name: base.name, vendor: base.vendor, model: base.model, source: base.source,
    description: '', dims: { w: 1, d: 1, h: 1 }, weightKg: 0, clearance: { front: 0, rear: 0, sides: 0 }, cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 },
    meta: { registrationOnly: true, templateSlots: [...new Set(templateSlots)] },
  } as CatalogItem;
}

/** Merge registration records into the base items (records without a base are dropped; other items pass through). */
export function mergeRegistrationRecords(base: ReadonlyMap<string, CatalogItem>, items: readonly CatalogItem[]): CatalogItem[] {
  const out: CatalogItem[] = [];
  for (const it of items) {
    if (!isRegistrationRecord(it)) { out.push(it); continue; }
    const b = base.get(it.id);
    if (!b) continue;
    const tags = [...new Set([...(Array.isArray(b.meta?.templateSlots) ? (b.meta!.templateSlots as string[]) : []), ...(Array.isArray(it.meta?.templateSlots) ? (it.meta!.templateSlots as string[]) : [])])];
    out.push({ ...b, origin: b.origin, meta: { ...(b.meta ?? {}), templateSlots: tags } });
  }
  return out;
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

/** Item content without `origin` and `meta.templateSlots` (the fields a library registration copy adds). */
function registrationFree(it: CatalogItem): string {
  const { origin: _o, meta, ...rest } = it;
  void _o;
  const m = { ...(meta ?? {}) };
  delete m.templateSlots;
  return stable({ ...rest, meta: Object.keys(m).length ? m : undefined });
}

/**
 * Safe migration of registration copies (stream T4): a library item with `meta.templateSlots` whose other content equals the
 * built-in item of the same id becomes a registration record. Copies that differ (a user edit or an older seed) are kept as they
 * are and listed in `kept` — the migration never discards content.
 */
export function migrateLibraryRegistrations(lib: CatalogLibrary, builtin: ReadonlyMap<string, CatalogItem>): { library: CatalogLibrary; migrated: string[]; kept: string[] } {
  const migrated: string[] = [];
  const kept: string[] = [];
  const items = (lib.items ?? []).map((it) => {
    const tags = it.meta?.templateSlots;
    const b = builtin.get(it.id);
    if (isRegistrationRecord(it) || !Array.isArray(tags) || !tags.length || !b) return it;
    if (registrationFree(it) === registrationFree(b)) { migrated.push(it.id); return registrationRecord(b, tags as string[]); }
    kept.push(it.id);
    return it;
  });
  return { library: { ...lib, items }, migrated, kept };
}

/** Library-layer registration of `item` (T4 #4): a registration record for built-in items, a tagged copy for library items. */
export function libraryWithRegistration(lib: CatalogLibrary, item: CatalogItem, builtin: ReadonlyMap<string, CatalogItem>, slotKey: string): CatalogLibrary {
  const strip = <T extends { origin?: unknown }>(x: T): T => { const { origin: _o, ...rest } = x; void _o; return rest as T; };
  const { library } = migrateLibraryRegistrations(lib, builtin);
  const items = (library.items ?? []).map(strip);
  const cur = items.find((x) => x.id === item.id);
  const others = items.filter((x) => x.id !== item.id);
  const prevTags = (x?: CatalogItem) => (Array.isArray(x?.meta?.templateSlots) ? (x!.meta!.templateSlots as string[]) : []);
  let next: CatalogItem;
  if (cur && !isRegistrationRecord(cur)) next = { ...cur, meta: { ...(cur.meta ?? {}), templateSlots: [...new Set([...prevTags(cur), slotKey])] } };
  else {
    const b = builtin.get(item.id);
    next = b ? registrationRecord(b, [...prevTags(cur), slotKey]) : { ...strip(item), meta: { ...(item.meta ?? {}), templateSlots: [...new Set([...prevTags(item), slotKey])] } };
  }
  return { items: [...others, next], cables: (library.cables ?? []).map(strip) };
}
