import type { FacilityAttribute } from './facility-types.ts';

/**
 * Facility assessment thresholds, v2 for Hyperscale site assessment, rev 1.15 (2026-06-24; the spreadsheet calls itself
 * "Version 1.0 rev 1.15"), registry id `facility-v2hs@1.15`.
 *
 * Licence: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). Attribution: the assessment title and revision above,
 * published at https://github.com/opencomputeproject/OCP-Ready-Facility-Recognition-Program. Changes: attribute ids, thresholds and
 * level names re-expressed as data; wording shortened; only attributes a planning model can evaluate are encoded (modified).
 * Where the assessment lists no acceptable level, `acceptable` is absent (a value below optimum is an exception).
 *
 * Informational pre-check basis only — never an assessment, recognition or certification claim (proposal §5.4, §6.2).
 */
export const FACILITY_V2HS_1_15: readonly FacilityAttribute[] = [
  { ref: '1.0-C', key: 'delivery-path-dock', unit: 'm', compare: 'min-dims', optimum: { h: 2.75, w: 1.6 } },
  { ref: '1.0-D', key: 'delivery-path-white-space', unit: 'm', compare: 'min-dims', optimum: { h: 2.75, w: 1.6 } },
  { ref: '1.0-E', key: 'corridor-rolling-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 680, note: 'optimum on slab on grade; acceptable on access floor without spreader plates' },
  { ref: '2.0-A', key: 'white-space-rolling-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 680, note: 'optimum on slab; acceptable on access floor' },
  { ref: '2.0-B', key: 'white-space-uniform-load', unit: 'kg/m²', compare: 'min', optimum: 1221, acceptable: 1221, note: 'optimum on slab; acceptable on access floor' },
  { ref: '2.0-C', key: 'white-space-concentrated-load', unit: 'kg', compare: 'min', optimum: 680, acceptable: 680, note: 'optimum on slab; acceptable on access floor' },
  { ref: '2.0-D', key: 'clear-height', unit: 'm', compare: 'min', optimum: 4.5, acceptable: 3.65 },
  { ref: '2.1-B', key: 'circuits-to-rack', unit: 'enum', compare: 'enum', optimum: ['2N'] },
  { ref: '2.1-G', key: 'upstream-ups', unit: 'enum', compare: 'enum', optimum: ['n-plus-n-ups'] },
  { ref: '2.1-H', key: 'rack-bbu', unit: 'enum', compare: 'enum', optimum: ['allowed'] },
  { ref: '2.1-I', key: 'generator-load-acceptance', unit: 's', compare: 'max', optimum: 20, acceptable: 35 },
  { ref: '2.2-D', key: 'containment', unit: 'enum', compare: 'enum', optimum: ['hot-aisle'], acceptable: ['cold-aisle'] },
  { ref: '2.2-E', key: 'rack-density', unit: 'kW', compare: 'min', optimum: 12, note: 'attribute stops at 12 kW; not an indicator of fitness for liquid-cooled racks' },
  { ref: '2.2-F', key: 'cold-aisle-width', unit: 'mm', compare: 'min', optimum: 1400 },
  { ref: '2.2-G', key: 'cage-cold-aisle-width', unit: 'mm', compare: 'min', optimum: 1400 },
  { ref: '2.2-H', key: 'hot-aisle-width', unit: 'mm', compare: 'min', optimum: 1200 },
  { ref: '2.2-K', key: 'it-temperature-rise', unit: 'K', compare: 'min', optimum: 12, note: 'below 12 K acceptable only with supplemental cooling (e.g. rear-door HX) and analysis' },
];
