// r4 stream C (spec §3.2 Selection sync): the equipment hover tooltip builder shared by the 3D viewer and the 2D view, so both
// show identical text. The caller supplies what only it knows (inlet temperature from its thermal field, colour-mode value,
// its role-label function).
import type { CatalogItem, EquipmentInstance } from '@aidc/core';

// local shape of the i18n translator (no import from i18n/index.ts: that module needs Vite's import.meta, and this file is also
// compiled by the server test project through apps/server/test/view2d-r4.test.ts)
type Tr = (key: string, params?: Record<string, string | number>) => string;

export interface EquipmentTooltipExtras {
  /** rack inlet temperature (°C), NaN / undefined = none */
  inletC?: number;
  /** colour-mode value of the rack */
  value?: number;
  roleLabel: (role: string) => string;
}

export function equipmentTooltip(t: Tr, e: EquipmentInstance, item: CatalogItem, x: EquipmentTooltipExtras): { title: string; lines: string[] } {
  const lines = [item.name];
  if (item.power?.nameplateKW) lines.push(t('shell.viewer.tip.power', { kw: (item.power.nameplateKW * (e.loadFactor ?? 1)).toFixed(1) }));
  if (item.compute?.gpus) lines.push(`GPU ${item.compute.gpus} · ${item.compute.gpuModel}`);
  if (item.capacity?.coolingKW) lines.push(t('shell.viewer.tip.coolingCapacity', { kw: item.capacity.coolingKW.toLocaleString() }));
  if (x.inletC !== undefined && Number.isFinite(x.inletC)) lines.push(t('shell.viewer.tip.inletTemp', { c: x.inletC.toFixed(1) }));
  if (x.value !== undefined) lines.push(t('shell.viewer.tip.value', { v: x.value.toFixed(1) }));
  if (e.networkRole) lines.push(t('shell.viewer.tip.role', { role: x.roleLabel(e.networkRole) }));
  if (e.waveId) lines.push(t('shell.viewer.tip.wave', { wave: e.waveId }));
  return { title: e.tag, lines };
}

/** Role labels (same table as the viewer legend). */
const ROLE_LABEL: Record<string, string> = {
  'scale-out-leaf': 'Scale-out Leaf',
  'scale-out-spine': 'Scale-out Spine',
  'scale-out-core': 'Core',
  frontend: 'Front-end',
  storage: 'Storage',
  oob: 'OOB',
  mixed: 'Mixed',
};
export const networkRoleLabel = (t: Tr, r: string) => (r === 'none' ? t('shell.viewer.role.none') : ROLE_LABEL[r] ?? r);
