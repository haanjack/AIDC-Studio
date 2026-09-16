import type { EquipmentCategory, EquipmentInstance, Locale } from '../model/types.ts';
import { tr, type StrKey } from './i18n.ts';

/** Paper ink & ghost colours (print-first; the sheet is white). */
export const INK = '#1a1a1a';
export const INK_SOFT = '#4a4f55';
export const LINE_LIGHT = '#9aa0a6';
export const GHOST_FILL = '#dfe2e5';
export const GHOST_STROKE = '#8c9196';
export const ENVELOPE = '#b8bdc2';
export const PAPER = '#ffffff';
export const GRID = '#c9cdd1';

/** Building systems drawn on the 400-series sheets and listed in the phase matrix. */
export type SystemId = 'supply-air' | 'return-air' | 'cdu-supply' | 'cdu-return' | 'busway-a' | 'busway-b' | 'trays' | 'frontend' | 'storage' | 'oob';

export interface SystemDef {
  id: SystemId;
  color: string;
  label: StrKey;
  /** trunk infrastructure shared by every pod: tie-in of a new wave stops it temporarily */
  shared: boolean;
  layer: 'plenum' | 'overhead' | 'floor' | 'underfloor';
}

export const SYSTEMS: SystemDef[] = [
  { id: 'supply-air', color: '#19b5d6', label: 'supplyAir', shared: true, layer: 'floor' },
  { id: 'return-air', color: '#2fa84f', label: 'returnAir', shared: false, layer: 'plenum' },
  { id: 'cdu-supply', color: '#2563d9', label: 'cduSupply', shared: true, layer: 'overhead' },
  { id: 'cdu-return', color: '#d7302a', label: 'cduReturn', shared: true, layer: 'overhead' },
  // MEP convention keeps supply-blue / return-red for the liquid loop; the busways sit off red (A orange, B navy) so a busway slab
  // 30 cm from a return pipe never reads as the same system (QA-drawings-v2 palette ΔE)
  { id: 'busway-a', color: '#f28c00', label: 'buswayA', shared: true, layer: 'overhead' },
  { id: 'busway-b', color: '#1e3a8a', label: 'buswayB', shared: true, layer: 'overhead' },
  { id: 'trays', color: '#e2b400', label: 'traysScaleOut', shared: false, layer: 'overhead' },
  { id: 'frontend', color: '#c2189e', label: 'frontend', shared: false, layer: 'overhead' },
  { id: 'storage', color: '#7b48c8', label: 'storageNet', shared: false, layer: 'overhead' },
  { id: 'oob', color: '#7d848b', label: 'oob', shared: false, layer: 'overhead' },
];

export const SYSTEM_COLOR: Record<SystemId, string> = Object.fromEntries(SYSTEMS.map((s) => [s.id, s.color])) as Record<SystemId, string>;

/** Containment outlines on the plan: their own colours, distinct from the liquid loop (red/blue) and the busways (orange/navy). */
export const CONTAINMENT_COLOR = { 'hot-aisle': '#8a4b1f', 'cold-aisle': '#0f7c8c' } as const;

/** Phase-matrix state fills — pattern-coded (hatched amber = stopped, green with a check = operational) so they cannot be read as a system swatch. */
export const STATE_STYLE = {
  operational: { fill: '#8fd9a5', stroke: '#1f7a3a', mark: 'check' as const },
  stopped: { fill: '#ffe08a', stroke: '#b8860b', mark: 'hatch' as const },
};

export function systemLabel(id: SystemId, locale: Locale): string {
  const def = SYSTEMS.find((s) => s.id === id)!;
  return tr(locale, def.label);
}

/** Plan colours per equipment category (fill / stroke). */
export const CATEGORY_PLAN: Partial<Record<EquipmentCategory, { fill: string; stroke: string }>> = {
  'gpu-rack': { fill: '#e6e8ea', stroke: '#5f6569' },
  'cpu-rack': { fill: '#dfe6ee', stroke: '#4d6478' },
  'storage-rack': { fill: '#e6dcf4', stroke: '#7b48c8' },
  'network-rack': { fill: '#fff1b8', stroke: '#b38f00' },
  'mgmt-rack': { fill: '#e4e4e4', stroke: '#7d848b' },
  cdu: { fill: '#d6e4fa', stroke: '#2563d9' },
  crah: { fill: '#d2f1f7', stroke: '#19b5d6' },
  'fan-wall': { fill: '#d2f1f7', stroke: '#19b5d6' },
  rpp: { fill: '#fde5c8', stroke: '#c96f00' },
  'busway-tapoff': { fill: '#fde5c8', stroke: '#c96f00' },
  ups: { fill: '#fde5c8', stroke: '#c96f00' },
  battery: { fill: '#fde5c8', stroke: '#c96f00' },
  column: { fill: '#b8bdc2', stroke: '#4a4f55' },
};

export function categoryPlanStyle(cat: EquipmentCategory): { fill: string; stroke: string } {
  return CATEGORY_PLAN[cat] ?? { fill: '#ececec', stroke: '#6b7075' };
}

/** Network racks are coloured by the fabric they host. */
export function networkRoleSystem(role: EquipmentInstance['networkRole']): SystemId {
  switch (role) {
    case 'frontend':
      return 'frontend';
    case 'storage':
      return 'storage';
    case 'oob':
      return 'oob';
    default:
      return 'trays';
  }
}

export const RACK_CATEGORIES = new Set<EquipmentCategory>(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);
