import type { FacilityPrecheckKey } from '../types.ts';
import { FACILITY_V1_1_5 } from './facility-v1-1.5.ts';
import { FACILITY_V2HS_1_15 } from './facility-v2hs-1.15.ts';

/**
 * One facility assessment attribute as data (stream B / P2; proposal §5.4 FC rules read these).
 * `compare`: `min` = design value ≥ threshold, `max` = design value ≤ threshold, `min-dims` = every given dimension ≥ threshold,
 * `enum` = design value in the listed set. Levels: optimum → acceptable → (acceptableWithNotes) → exception.
 */
export interface FacilityAttribute {
  /** attribute reference in the assessment revision, e.g. '2.2-D' */
  ref: string;
  /** neutral key shared by both revisions */
  key: string;
  unit: 'm' | 'mm' | 'kg' | 'kg/m²' | 's' | 'kW' | 'K' | 'enum';
  compare: 'min' | 'max' | 'min-dims' | 'enum';
  optimum: number | string[] | { h: number; w: number; d?: number };
  acceptable?: number | string[] | { h: number; w: number; d?: number }[];
  acceptableWithNotes?: number;
  note?: string;
}

/** Attribute sets by pre-check key (`off` has none). Items the model cannot see are listed in `FACILITY_ATTRIBUTES_NOT_MODELLED`. */
export function facilityAttributes(key: FacilityPrecheckKey): readonly FacilityAttribute[] {
  if (key === 'facility-v1@1.5') return FACILITY_V1_1_5;
  if (key === 'facility-v2hs@1.15') return FACILITY_V2HS_1_15;
  return [];
}

/** Assessment areas outside a planning model (reported as not modelled, never as passed). */
export const FACILITY_ATTRIBUTES_NOT_MODELLED = ['security', 'service-levels', 'telecom-and-meet-me-room', 'operations', 'air-quality', 'receptacle-types', 'certifications'] as const;
