import type { FacilityAttribute } from './facility-types.ts';

/**
 * Facility assessment thresholds, v1 data center site assessment, v1.0 rev 1.5 (2026-06-30), registry id `facility-v1@1.5`.
 *
 * Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Attribution: the assessment title and revision above,
 * published at https://github.com/opencomputeproject/OCP-Ready-Facility-Recognition-Program. Changes: attribute ids, thresholds and
 * level names re-expressed as data; wording shortened; only attributes a planning model can evaluate are encoded (modified).
 *
 * Informational pre-check basis only — never an assessment, recognition or certification claim (proposal §5.4, §6.2).
 */
export const FACILITY_V1_1_5: readonly FacilityAttribute[] = [
  { ref: '1.0-B', key: 'delivery-path-dock', unit: 'm', compare: 'min-dims', optimum: { h: 2.75, w: 2.4, d: 2.4 }, acceptable: [{ h: 2.75, w: 1.2 }, { h: 2.3, w: 0.9 }] },
  { ref: '1.0-C', key: 'delivery-path-white-space', unit: 'm', compare: 'min-dims', optimum: { h: 2.4, w: 1.8 }, acceptable: [{ h: 2.3, w: 0.9 }] },
  { ref: '1.0-D', key: 'corridor-rolling-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 567, acceptableWithNotes: 459 },
  { ref: '1.0-E', key: 'staging-uniform-load', unit: 'kg/m²', compare: 'min', optimum: 1221, acceptable: 732 },
  { ref: '1.0-F', key: 'staging-concentrated-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 567, acceptableWithNotes: 459 },
  { ref: '2.0-A', key: 'white-space-rolling-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 567, acceptableWithNotes: 459 },
  { ref: '2.0-B', key: 'white-space-uniform-load', unit: 'kg/m²', compare: 'min', optimum: 1221, acceptable: 732 },
  { ref: '2.0-C', key: 'white-space-concentrated-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 567, acceptableWithNotes: 459 },
  { ref: '2.0-D', key: 'clear-height', unit: 'm', compare: 'min', optimum: 4.5, acceptable: 3.1 },
  { ref: '2.1-A', key: 'circuits-to-rack', unit: 'enum', compare: 'enum', optimum: ['2N'], acceptable: ['1N'] },
  { ref: '2.1-G', key: 'upstream-ups', unit: 'enum', compare: 'enum', optimum: ['ups-and-non-ups'], acceptable: ['ups-only'] },
  { ref: '2.1-H', key: 'rack-bbu', unit: 'enum', compare: 'enum', optimum: ['allowed'], acceptable: ['not-allowed'] },
  { ref: '2.1-I', key: 'generator-load-acceptance', unit: 's', compare: 'max', optimum: 60, acceptable: 90 },
  { ref: '2.2-B', key: 'containment', unit: 'enum', compare: 'enum', optimum: ['hot-aisle', 'chimney', 'rdhx'], acceptable: ['hot-aisle', 'cold-aisle'] },
  { ref: '2.2-C', key: 'rack-density', unit: 'kW', compare: 'min', optimum: 12, acceptable: 8, note: 'attribute stops at 12 kW; not an indicator of fitness for liquid-cooled racks' },
  { ref: '2.2-D', key: 'cold-aisle-width', unit: 'mm', compare: 'min', optimum: 1500, acceptable: 1200 },
  { ref: '2.2-E', key: 'cage-cold-aisle-width', unit: 'mm', compare: 'min', optimum: 1200, acceptable: 900 },
  { ref: '2.2-F', key: 'hot-aisle-width', unit: 'mm', compare: 'min', optimum: 1200, acceptable: 900 },
  { ref: '2.2-I', key: 'it-temperature-rise', unit: 'K', compare: 'min', optimum: 12, acceptable: 8 },
];
