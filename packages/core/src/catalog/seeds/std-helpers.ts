import type { CatalogItem, EquipmentCategory, SpecSource } from '../../model/types.ts';
import { findStandard } from '../../standards/registry.ts';
import type { ItemStandard, ParamProvenance, SpecStatus, StandardLevel, StandardScope, Verification } from '../../standards/types.ts';

/**
 * Helpers for the standards building-block seeds (stream B / P2, OCP-DESIGN-PROPOSAL §3).
 *
 * Rules the seeds follow:
 *  - every value derived from a cited document carries `paramSources[path] = { standardId, clause?, verification }`;
 *    planner estimates carry `{ verification: 'estimate' }` with a short note — no document text, only parameters;
 *  - ids and names never carry an organisation's mark; document titles appear only through the registry (`standardCitation`);
 *  - `specStatus` is the weakest status of the registry ids the item declares (non-registry entries are skipped).
 */

/** `standardId` of a `proprietary` / class-only entry that implements no cited document (renders no citation). */
export const NO_STANDARD = 'none';

/** Weakest order used for items (accepted > external > contributed > review > draft > roadmap). */
const ORDER: SpecStatus[] = ['accepted', 'external', 'contributed', 'review', 'draft', 'roadmap'];

/** Weakest status over the registry ids an item declares; entries without a registry document are ignored (undefined when none). */
export function itemSpecStatus(standards: readonly ItemStandard[] | undefined): SpecStatus | undefined {
  let worst = -1;
  for (const s of standards ?? []) {
    const ref = findStandard(s.standardId);
    if (ref) worst = Math.max(worst, ORDER.indexOf(ref.status));
  }
  return worst < 0 ? undefined : ORDER[worst];
}

export type EvidenceKind = NonNullable<NonNullable<ItemStandard['evidence']>['kind']>;

export function std(
  standardId: string,
  level: StandardLevel,
  scope: StandardScope,
  verification: Verification,
  extra: { note?: string; classId?: string; evidence?: { kind: EvidenceKind; label: string; url: string; accessed: string } } = {},
): ItemStandard {
  return { standardId, level, scope, verification, ...extra };
}

/** Provenance shorthands: verified from the document, derived by arithmetic, planner estimate, unverified. */
export const V = (standardId: string, clause?: string, note?: string): ParamProvenance => ({ standardId, verification: 'verified', ...(clause ? { clause } : {}), ...(note ? { note } : {}) });
export const D = (standardId: string | undefined, note: string): ParamProvenance => ({ ...(standardId ? { standardId } : {}), verification: 'derived', note });
export const E = (note: string): ParamProvenance => ({ verification: 'estimate', note });
export const U = (note: string, standardId?: string): ParamProvenance => ({ ...(standardId ? { standardId } : {}), verification: 'unverified', note });

/** Kinds of non-floor building blocks (`meta.blockKind`). Floor equipment keeps its normal category and no block kind. */
export type BlockKind =
  | 'rack-enclosure'
  | 'power-shelf'
  | 'bbu-shelf'
  | 'busbar'
  | 'power-rack'
  | 'rack-manager'
  | 'quick-connector'
  | 'rack-manifold'
  | 'row-header'
  | 'rack-pump-unit'
  | 'door-hx'
  | 'switch-tray';

export interface BlockInput extends Partial<CatalogItem> {
  id: string;
  category: EquipmentCategory;
  name: string;
  model: string;
  description: string;
  notes: string;
  source?: SpecSource;
  blockKind?: BlockKind;
  /** hidden unless the profile includes draft specs (DO-4: HPR V2 shelf, ±400 VDC sidecar) */
  behindDraftsToggle?: boolean;
}

/**
 * A generic building block: vendor `Generic`, zero clearances unless given, estimate cost unless given, `specStatus` derived.
 * Non-floor blocks get `meta.blockKind` and `meta.placeable: false`.
 */
export function block(o: BlockInput): CatalogItem {
  const { blockKind, behindDraftsToggle, meta, ...rest } = o;
  const item: CatalogItem = {
    vendor: 'Generic',
    dims: { w: 0.1, d: 0.1, h: 0.05 },
    weightKg: 0,
    clearance: { front: 0, rear: 0, sides: 0 },
    cost: { capexUSD: 0, installHours: 0, leadTimeWeeks: 0 },
    source: 'open-standard',
    ...rest,
    meta: {
      ...(blockKind ? { blockKind, placeable: false } : {}),
      ...(behindDraftsToggle ? { behindDraftsToggle: true } : {}),
      ...(meta ?? {}),
    },
  } as CatalogItem;
  item.specStatus = itemSpecStatus(item.standards);
  return item;
}

/** Heat carried per L/min at ΔT (kW): Q [L/min] × ρ [kg/L] × cp [kJ/kg·K] × ΔT / 60. PG25 ρ≈1.02, cp≈3.95; water ρ≈0.997, cp≈4.18 (proposal §3.2, D). */
export const FLUID_PROPS = { pg25: { rho: 1.02, cp: 3.95 }, 'treated-water': { rho: 0.997, cp: 4.18 } } as const;
export function kwPerLpm(fluid: keyof typeof FLUID_PROPS, deltaTK: number): number {
  const f = FLUID_PROPS[fluid];
  return (f.rho * f.cp * deltaTK) / 60;
}

export const PSI_TO_KPA = 6.894757;
export const GPM_TO_LPM = 3.785412;
export const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
