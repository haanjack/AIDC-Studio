import { findCatalogItem } from '../catalog/catalog.ts';
import type { CableType, CatalogItem, EquipmentInstance, Hall, Project, Redundancy, Vec2 } from '../model/types.ts';
import { redundantCount } from '../layout/estimates.ts';

/** A placed equipment instance resolved against the catalog. */
export interface Placed {
  e: EquipmentInstance;
  item: CatalogItem;
  hall: Hall | undefined;
}

export const IT_LOAD_CATEGORIES: ReadonlySet<string> = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'mgmt-rack']);
export const RACK_CATEGORIES: ReadonlySet<string> = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);
export const FACILITY_ENDPOINT_CATEGORIES: ReadonlySet<string> = new Set(['cdu', 'crah', 'fan-wall', 'rpp', 'ups', 'chiller', 'dry-cooler']);

export interface Ctx {
  project: Project;
  placed: Placed[];
  unknown: EquipmentInstance[];
  halls: Map<string, Hall>;
  byHall: Map<string, Placed[]>;
  byPod: Map<string, Placed[]>;
  /** total GPUs placed */
  gpus: number;
  /** GPU rack model carrying the most GPUs (per-GPU specs for workload models) */
  gpuRack: CatalogItem | undefined;
  /** finish v2 2차: chips in accelerator compute-slot racks (meta.computeSlot — LPX / NPU racks), not counted in `gpus` */
  acceleratorChips: number;
}

export function podKey(e: EquipmentInstance): string {
  return e.podId ?? `hall:${e.hallId}`;
}

export function buildContext(project: Project): Ctx {
  const halls = new Map(project.halls.map((h) => [h.id, h]));
  const placed: Placed[] = [];
  const unknown: EquipmentInstance[] = [];
  const byHall = new Map<string, Placed[]>();
  const byPod = new Map<string, Placed[]>();
  const gpuByModel = new Map<string, number>();
  let gpus = 0;
  let acceleratorChips = 0;
  for (const e of project.equipment) {
    const item = findCatalogItem(e.catalogId);
    if (!item) {
      unknown.push(e);
      continue;
    }
    const p: Placed = { e, item, hall: halls.get(e.hallId) };
    placed.push(p);
    push(byHall, e.hallId, p);
    push(byPod, podKey(e), p);
    // finish v2 2차 (QA templates #1): accelerator compute-slot racks (Groq LPX, NPU racks — meta.computeSlot) are not the primary platform:
    // they stay out of the GPU count that training / inference size jobs from and cannot take over `gpuRack`
    const g = item.category === 'gpu-rack' && typeof e.meta?.computeSlot !== 'string' ? item.compute?.gpus ?? 0 : 0;
    if (item.category === 'gpu-rack' && typeof e.meta?.computeSlot === 'string') acceleratorChips += item.compute?.gpus ?? 0;
    if (g > 0) {
      gpus += g;
      gpuByModel.set(item.id, (gpuByModel.get(item.id) ?? 0) + g);
    }
  }
  let gpuRack: CatalogItem | undefined;
  let best = -1;
  for (const [id, g] of gpuByModel) {
    if (g > best) {
      best = g;
      gpuRack = findCatalogItem(id);
    }
  }
  return { project, placed, unknown, halls, byHall, byPod, gpus, gpuRack, acceleratorChips };
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const arr = m.get(k);
  if (arr) arr.push(v);
  else m.set(k, [v]);
}

export function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of items) push(m, key(t), t);
  return m;
}

export function sumBy<T>(items: readonly T[], f: (t: T) => number): number {
  let s = 0;
  for (const t of items) s += f(t);
  return s;
}

/** Site-plan position (hall origin + hall-local position). */
export function siteXY(p: Placed): Vec2 {
  return { x: (p.hall?.origin.x ?? 0) + p.e.position.x, y: (p.hall?.origin.y ?? 0) + p.e.position.y };
}

export function itemPriceUSD(project: Project, item: CatalogItem): number {
  return project.pricing.itemOverrides[item.id] ?? item.cost.capexUSD;
}

/**
 * Price of one cable incl. both transceiver ends.
 * `pricing.cableOverrides[id]` is a flat per-cable price that already includes optics.
 */
export function cableUnitUSD(project: Project, type: CableType, lengthM: number): number {
  const o = project.pricing.cableOverrides[type.id];
  if (o !== undefined) return o;
  return type.cableUSD + type.cableUSDPerM * lengthM + 2 * type.transceiverUSD;
}

/** Units required for a load: n = ceil(load / unit), installed = n + redundancy. */
export function unitsFor(requiredKW: number, unitKW: number, redundancy: Redundancy | string): { n: number; units: number } {
  if (requiredKW <= 0 || unitKW <= 0) return { n: 0, units: 0 };
  const n = Math.ceil(requiredKW / unitKW - 1e-9);
  return { n, units: redundantCount(n, redundancy) };
}

export function isFeedAKey(i: number): 'A' | 'B' {
  return i % 2 === 0 ? 'A' : 'B';
}

// ───────────── dates (UTC, calendar days) ─────────────

export function parseISO(d: string): number {
  const [y, m, dd] = d.split('-').map(Number);
  return Date.UTC(y, (m ?? 1) - 1, dd ?? 1);
}

export function toISO(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return toISO(parseISO(iso) + Math.round(days) * 86_400_000);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseISO(b) - parseISO(a)) / 86_400_000);
}

// ───────────── deterministic pseudo-random ─────────────

export function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const round = (v: number, digits = 1): number => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Largest-remainder integer split of `total` proportional to `weights`. */
export function distribute(total: number, weights: readonly number[]): number[] {
  const wsum = weights.reduce((s, w) => s + w, 0);
  if (total <= 0 || wsum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => (total * w) / wsum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((s, v) => s + v, 0);
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) out[order[k].i]++;
  return out;
}
