// Two-version comparison (stream T8, DECISIONS-v2 #12, r2-platform.md §4.3): equipment by id (added / removed /
// moved / changed) and a fixed KPI vector from analyzeProject. Deterministic; the caller may pass analyses computed
// under its own catalog (the server runs them under builtin ∪ library ∪ project extensions).
import { findCatalogItem } from '../catalog/catalog.ts';
import { analyzeProject } from '../engines/index.ts';
import type { EquipmentInstance, Project, ProjectAnalysis, VersionDiff } from '../model/types.ts';

/** Position delta above which an item counts as moved (m) — 1 mm, r2-platform.md §4.3. */
export const MOVE_EPS_M = 0.001;

/** KPI keys of `VersionDiff.summaryDelta` in display order (UI labels: i18n `shell.collab.metric.<key>`). */
export const VERSION_KPIS = ['gpus', 'gpuRacks', 'racks', 'equipment', 'itMW', 'facilityMW', 'pue', 'capexUSD', 'rfsDays', 'switches', 'cableKm', 'errors', 'warnings'] as const;
export type VersionKpi = (typeof VERSION_KPIS)[number];

/** true when a larger value is better (for colouring the delta); absent = neutral. */
export const KPI_HIGHER_IS_BETTER: Partial<Record<VersionKpi, boolean>> = { gpus: true, pue: false, capexUSD: false, rfsDays: false, errors: false, warnings: false, cableKm: false };

export function kpiVector(project: Project, analysis: ProjectAnalysis): Record<VersionKpi, number> {
  const s = analysis.summary;
  const rfs = Date.parse(s.readyForService);
  return {
    gpus: s.gpus,
    gpuRacks: s.gpuRacks,
    racks: s.racks,
    equipment: project.equipment.length,
    itMW: s.itMW,
    facilityMW: s.facilityMW,
    pue: s.pue,
    capexUSD: s.capexUSD,
    rfsDays: Number.isFinite(rfs) ? rfs / 86_400_000 : 0,
    switches: analysis.network.fabrics.reduce((a, f) => a + f.totalSwitches, 0),
    cableKm: analysis.network.cablesByType.reduce((a, c) => a + c.totalLengthM, 0) / 1000,
    errors: s.errors,
    warnings: s.warnings,
  };
}

const PLACEMENT_KEYS = new Set<string>(['position', 'rotationDeg', 'hallId', 'elevation']);

function changedFields(a: EquipmentInstance, b: EquipmentInstance): string[] {
  const out: string[] = [];
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ra), ...Object.keys(rb)])) {
    if (PLACEMENT_KEYS.has(k)) continue;
    if (JSON.stringify(ra[k]) !== JSON.stringify(rb[k])) out.push(k);
  }
  return out.sort();
}

export interface VersionDiffDetails {
  diff: VersionDiff;
  kpisFrom: Record<VersionKpi, number>;
  kpisTo: Record<VersionKpi, number>;
  /** per catalog category: counts of added / removed / moved / changed */
  byCategory: { category: string; added: number; removed: number; moved: number; changed: number }[];
  /** changed field names per changed equipment id (first 200) */
  changedFields: Record<string, string[]>;
}

/**
 * Compare two projects (a = from, b = to). `moved`: position delta > 1 mm, elevation change, rotation or hall change.
 * `changed`: any other field (catalogId, tag, pod/row/wave, loadFactor, role, blanking, meta).
 * An item can be both moved and changed. `summaryDelta[k] = kpi(b) − kpi(a)` (rounded to 1e-6).
 */
export function diffProjectsDetailed(a: Project, b: Project, opts: { analysisA?: ProjectAnalysis; analysisB?: ProjectAnalysis } = {}): VersionDiffDetails {
  const mapA = new Map(a.equipment.map((e) => [e.id, e]));
  const mapB = new Map(b.equipment.map((e) => [e.id, e]));
  const added: string[] = [];
  const removed: string[] = [];
  const moved: string[] = [];
  const changed: string[] = [];
  const fields: Record<string, string[]> = {};
  const cat = new Map<string, { category: string; added: number; removed: number; moved: number; changed: number }>();
  const bump = (e: EquipmentInstance, key: 'added' | 'removed' | 'moved' | 'changed') => {
    const category = findCatalogItem(e.catalogId)?.category ?? 'unknown';
    const row = cat.get(category) ?? { category, added: 0, removed: 0, moved: 0, changed: 0 };
    row[key]++;
    cat.set(category, row);
  };
  for (const e of b.equipment) {
    const prev = mapA.get(e.id);
    if (!prev) {
      added.push(e.id);
      bump(e, 'added');
      continue;
    }
    const dxy = Math.hypot(e.position.x - prev.position.x, e.position.y - prev.position.y);
    if (dxy > MOVE_EPS_M || e.rotationDeg !== prev.rotationDeg || e.hallId !== prev.hallId || Math.abs((e.elevation ?? 0) - (prev.elevation ?? 0)) > MOVE_EPS_M) {
      moved.push(e.id);
      bump(e, 'moved');
    }
    const f = changedFields(prev, e);
    if (f.length) {
      changed.push(e.id);
      bump(e, 'changed');
      if (Object.keys(fields).length < 200) fields[e.id] = f;
    }
  }
  for (const e of a.equipment) {
    if (!mapB.has(e.id)) {
      removed.push(e.id);
      bump(e, 'removed');
    }
  }

  const analysisA = opts.analysisA ?? analyzeProject(a);
  const analysisB = opts.analysisB ?? analyzeProject(b);
  const kpisFrom = kpiVector(a, analysisA);
  const kpisTo = kpiVector(b, analysisB);
  const summaryDelta: Record<string, number> = {};
  for (const k of VERSION_KPIS) {
    const d = kpisTo[k] - kpisFrom[k];
    summaryDelta[k] = Number.isFinite(d) ? Math.round(d * 1e6) / 1e6 : 0;
  }
  return {
    diff: { added, removed, moved, changed, summaryDelta },
    kpisFrom,
    kpisTo,
    byCategory: [...cat.values()].sort((x, y) => x.category.localeCompare(y.category)),
    changedFields: fields,
  };
}

/** Contract signature: `diffProjects(a, b): VersionDiff` (analyses computed with the active catalog when omitted). */
export function diffProjects(a: Project, b: Project, opts: { analysisA?: ProjectAnalysis; analysisB?: ProjectAnalysis } = {}): VersionDiff {
  return diffProjectsDetailed(a, b, opts).diff;
}

/** Content key for "did the save change anything": the project without volatile save metadata (updatedAt). */
export function projectContentKey(p: Project): string {
  const rest: Record<string, unknown> = { ...(p as unknown as Record<string, unknown>) };
  delete rest.updatedAt;
  return JSON.stringify(rest);
}
