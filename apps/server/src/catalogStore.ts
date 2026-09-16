import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CATALOG_IMAGE_MAX_BYTES, catalogImageDataUrlBytes, type CableType, type CatalogItem, type CatalogLibrary } from '../../../packages/core/src/index.ts';
import { canonicalSpecSource } from '../../../packages/core/src/catalog/aliases.ts';

/**
 * Server-global catalog library (stream S3): `data/catalog/custom.json` = { items: CatalogItem[], cables: CableType[] }.
 * Loaded once at server start into the module-level `library` of app.ts (mutated in place so every request that calls
 * `resolveCatalog(project, library)` sees the current content) and replaced wholesale by PUT /api/catalog/custom.
 * Validation is structural (like isProjectLike) — the engines tolerate missing optional blocks, so we only guard the
 * fields every consumer dereferences.
 */

export const CATALOG_FILE = 'custom.json';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SOURCES = new Set(['open-standard', 'vendor-datasheet', 'public-spec', 'estimate', 'announced', 'user']);
/** legacy stored source tags are accepted as input and rewritten by normalizeLibrary (stream A, catalog/aliases.ts) */
const isSource = (v: unknown): boolean => canonicalSpecSource(v) !== undefined;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function catalogItemErrors(v: unknown, path = 'item'): string[] {
  const errs: string[] = [];
  const it = v as Partial<CatalogItem> | null;
  if (!it || typeof it !== 'object') return [`${path}: not an object`];
  if (typeof it.id !== 'string' || !ID_RE.test(it.id)) errs.push(`${path}.id: invalid (letters, digits, . _ -; ≤ 128 chars)`);
  if (typeof it.category !== 'string' || !it.category) errs.push(`${path}.category: required`);
  if (typeof it.name !== 'string' || !it.name.trim()) errs.push(`${path}.name: required`);
  if (typeof it.vendor !== 'string') errs.push(`${path}.vendor: required`);
  if (typeof it.model !== 'string') errs.push(`${path}.model: required`);
  if (typeof it.description !== 'string') errs.push(`${path}.description: required (may be empty)`);
  const d = it.dims;
  if (!d || !isNum(d.w) || !isNum(d.d) || !isNum(d.h) || d.w <= 0 || d.d <= 0 || d.h <= 0) errs.push(`${path}.dims: w/d/h must be positive numbers`);
  if (!isNum(it.weightKg) || it.weightKg < 0) errs.push(`${path}.weightKg: must be ≥ 0`);
  const c = it.clearance;
  if (!c || !isNum(c.front) || !isNum(c.rear) || !isNum(c.sides)) errs.push(`${path}.clearance: front/rear/sides required`);
  const cost = it.cost;
  if (!cost || !isNum(cost.capexUSD) || !isNum(cost.installHours) || !isNum(cost.leadTimeWeeks)) errs.push(`${path}.cost: capexUSD/installHours/leadTimeWeeks required`);
  if (typeof it.source !== 'string' || !isSource(it.source)) errs.push(`${path}.source: must be one of ${[...SOURCES].join(', ')}`);
  if (it.power) {
    const p = it.power;
    if (!isNum(p.nameplateKW) || !isNum(p.typicalKW) || !isNum(p.idleKW) || !isNum(p.peakKW) || !isNum(p.feeds) || !isNum(p.voltageV)) errs.push(`${path}.power: nameplateKW/typicalKW/idleKW/peakKW/feeds/voltageV required`);
    else if (p.nameplateKW < 0 || p.typicalKW > p.peakKW + 1e-9 || p.idleKW > p.nameplateKW + 1e-9) errs.push(`${path}.power: expect idle ≤ nameplate and typical ≤ peak`);
  }
  if (it.cooling) {
    const k = it.cooling;
    if (!isNum(k.liquidFraction) || k.liquidFraction < 0 || k.liquidFraction > 1) errs.push(`${path}.cooling.liquidFraction: 0..1`);
    if (!isNum(k.airflowM3s) || !isNum(k.liquidFlowLpm) || !isNum(k.maxInletC)) errs.push(`${path}.cooling: airflowM3s/liquidFlowLpm/maxInletC required`);
  }
  if (it.compute) {
    const x = it.compute;
    if (!isNum(x.gpus) || !isNum(x.cpus) || !isNum(x.scaleOutPortsPerGpu) || !isNum(x.scaleOutPortGbps) || !isNum(x.gpuMemoryGB) || !isNum(x.gpuFlopsPeak))
      errs.push(`${path}.compute: gpus/cpus/scaleOutPortsPerGpu/scaleOutPortGbps/gpuMemoryGB/gpuFlopsPeak required`);
    if (!x.scaleUp || typeof x.scaleUp.kind !== 'string' || !isNum(x.scaleUp.domainSize) || !isNum(x.scaleUp.gbpsPerGpu))
      errs.push(`${path}.compute.scaleUp: kind/domainSize/gbpsPerGpu required`);
  }
  if (it.image != null) errs.push(...catalogImageErrors(it.image, `${path}.image`));
  if (it.switch) {
    const s = it.switch;
    if (typeof s.fabric !== 'string' || !isNum(s.ports) || !isNum(s.portGbps) || !isNum(s.rackUnits) || typeof s.role !== 'string') errs.push(`${path}.switch: fabric/ports/portGbps/rackUnits/role required`);
  }
  return errs;
}

/**
 * T5 (F6) image rule shared by the server library PUT and the project save path (integration v2 2차): user images are PNG / JPEG /
 * WebP base64 data URLs ≤ CATALOG_IMAGE_MAX_BYTES (1 MB); `src` only /assets/… image paths; no remote / script URLs.
 */
export function catalogImageErrors(image: unknown, path = 'image'): string[] {
  const errs: string[] = [];
  const im = image as { kind?: unknown; dataUrl?: unknown; src?: unknown; credit?: unknown };
  if (!im || typeof im !== 'object' || !['thumbnail', 'schematic', 'user'].includes(String(im.kind))) errs.push(`${path}.kind: thumbnail | schematic | user`);
  if (!im || typeof im !== 'object') return errs;
  if (im.dataUrl != null) {
    const n = typeof im.dataUrl === 'string' ? catalogImageDataUrlBytes(im.dataUrl) : -1;
    if (n < 0) errs.push(`${path}.dataUrl: must be a base64 data:image/png|jpeg|webp URL`);
    else if (n > CATALOG_IMAGE_MAX_BYTES) errs.push(`${path}.dataUrl: ${n} bytes exceeds the ${CATALOG_IMAGE_MAX_BYTES} byte cap`);
  }
  if (im.src != null && (typeof im.src !== 'string' || !/^\/?assets\/[\w./-]+\.(png|jpe?g|webp)$/i.test(im.src))) errs.push(`${path}.src: only /assets/… image paths are allowed`);
  if (im.credit != null && (typeof im.credit !== 'string' || im.credit.length > 200)) errs.push(`${path}.credit: string ≤ 200 chars`);
  return errs;
}

/** Image errors of every `project.catalogExtensions[]` item (the project save path; other extension fields stay unvalidated). */
export function projectCatalogImageErrors(project: { catalogExtensions?: unknown }): string[] {
  const ext = project.catalogExtensions;
  if (ext == null) return [];
  if (!Array.isArray(ext)) return ['catalogExtensions: must be an array'];
  return ext.flatMap((it, i) => (it && typeof it === 'object' && (it as { image?: unknown }).image != null ? catalogImageErrors((it as { image: unknown }).image, `catalogExtensions[${i}].image`) : []));
}

export function cableTypeErrors(v: unknown, path = 'cable'): string[] {
  const errs: string[] = [];
  const c = v as Partial<CableType> | null;
  if (!c || typeof c !== 'object') return [`${path}: not an object`];
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) errs.push(`${path}.id: invalid`);
  if (typeof c.kind !== 'string') errs.push(`${path}.kind: required`);
  if (typeof c.name !== 'string' || !c.name.trim()) errs.push(`${path}.name: required`);
  for (const k of ['gbps', 'maxReachM', 'minReachM', 'cableUSD', 'cableUSDPerM', 'transceiverUSD', 'transceiverW', 'latencyNsPerM'] as const) {
    if (!isNum(c[k])) errs.push(`${path}.${k}: number required`);
  }
  if (isNum(c.minReachM) && isNum(c.maxReachM) && c.minReachM > c.maxReachM) errs.push(`${path}: minReachM > maxReachM`);
  if (typeof c.source !== 'string' || !isSource(c.source)) errs.push(`${path}.source: invalid`);
  return errs;
}

/** Validate a library body; returns the error list (empty = ok). Duplicate ids inside the library are rejected. */
export function catalogLibraryErrors(v: unknown): string[] {
  const lib = v as Partial<CatalogLibrary> | null;
  if (!lib || typeof lib !== 'object' || Array.isArray(lib)) return ['body must be { items?: CatalogItem[], cables?: CableType[] }'];
  if (lib.items == null && lib.cables == null) return ['body must carry at least one of items / cables (an empty library is { items: [] })'];
  const errs: string[] = [];
  if (lib.items != null) {
    if (!Array.isArray(lib.items)) errs.push('items must be an array');
    else {
      const seen = new Set<string>();
      lib.items.forEach((it, i) => {
        errs.push(...catalogItemErrors(it, `items[${i}]`));
        const id = (it as Partial<CatalogItem>)?.id;
        if (typeof id === 'string') {
          if (seen.has(id)) errs.push(`items[${i}].id: duplicate '${id}'`);
          seen.add(id);
        }
      });
    }
  }
  if (lib.cables != null) {
    if (!Array.isArray(lib.cables)) errs.push('cables must be an array');
    else {
      const seen = new Set<string>();
      lib.cables.forEach((c, i) => {
        errs.push(...cableTypeErrors(c, `cables[${i}]`));
        const id = (c as Partial<CableType>)?.id;
        if (typeof id === 'string') {
          if (seen.has(id)) errs.push(`cables[${i}].id: duplicate '${id}'`);
          seen.add(id);
        }
      });
    }
  }
  return errs;
}

/** Strip registry-only fields and tag the library origin. */
export function normalizeLibrary(lib: CatalogLibrary): Required<CatalogLibrary> {
  return {
    items: (lib.items ?? []).map((it) => ({ ...it, source: canonicalSpecSource(it.source) ?? it.source, origin: 'library' as const })),
    cables: (lib.cables ?? []).map((c) => ({ ...c, source: canonicalSpecSource(c.source) ?? c.source, origin: 'library' as const })),
  };
}

/** JSON-file store for the server-global catalog library (`<dir>/custom.json`). */
export class CatalogStore {
  constructor(readonly dir: string) {}

  get file(): string {
    return join(this.dir, CATALOG_FILE);
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Load the library; a missing or unreadable file yields an empty library (never throws at boot). */
  async load(): Promise<{ library: Required<CatalogLibrary>; errors: string[] }> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      const errors = catalogLibraryErrors(raw);
      if (errors.length) return { library: { items: [], cables: [] }, errors };
      return { library: normalizeLibrary(raw as CatalogLibrary), errors: [] };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { library: { items: [], cables: [] }, errors: [] };
      return { library: { items: [], cables: [] }, errors: [`${this.file}: ${(e as Error).message}`] };
    }
  }

  async save(lib: CatalogLibrary): Promise<Required<CatalogLibrary>> {
    const norm = normalizeLibrary(lib);
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ ...norm, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    await rename(tmp, this.file);
    return norm;
  }
}
