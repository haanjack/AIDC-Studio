import type { CatalogItem, Locale, NetworkRackLoad, ProjectAnalysis } from '../model/types.ts';
import { findCatalogItem } from '../catalog/catalog.ts';
import { deviceWords, tr } from './i18n.ts';
import { rackSlotMap, type RackSlot, type RackSlotCategory } from '../layout/rackContents.ts';
import { INK, INK_SOFT, LINE_LIGHT, PAPER, SYSTEM_COLOR } from './palette.ts';
import type { HallScene, SceneItem } from './scene.ts';
import { fitText, line, rect, text, textWidth } from './svg.ts';

/**
 * 200-series sheets: front elevations (U-maps) per rack type. Rack-scale systems (NVL72 / Helios) use the
 * tray stack from the catalog (compute / scale-up switch / power shelves); HGX-style racks stack nodes; network
 * racks take their switch list from analysis.network.rackLoads (grouped by identical switch signature).
 * The U-maps are schematic planning estimates unless a vendor rack map is known — every sheet says so.
 */

export type UKind = 'compute' | 'switch' | 'power' | 'mgmt' | 'server' | 'storage' | 'controller' | 'leaf' | 'spine' | 'core' | 'patch' | 'blank' | 'pdu';

export interface UBlock {
  /** lowest unit (1-based, from the bottom) */
  u0: number;
  units: number;
  kind: UKind;
  label: string;
  /** repeated identical units are drawn once with a count */
  count: number;
}

export interface UMap {
  totalU: number;
  /** 'U' (EIA 44.45 mm) or 'OU' (Open Rack 48 mm) */
  unit: 'U' | 'OU';
  blocks: UBlock[];
  note: string;
}

const KIND_COLOR: Record<UKind, string> = {
  compute: '#c9d6e3',
  switch: '#a9c4d8',
  power: '#e6d6b8',
  mgmt: '#d9dbdd',
  server: '#dfe6ee',
  storage: '#e6dcf4',
  controller: '#d6c8ec',
  leaf: '#ffe08a',
  spine: '#ffc46b',
  core: '#f7a37b',
  patch: '#e2e4e6',
  blank: '#f6f7f8',
  pdu: '#f0cfd3',
};

const SLOT_KIND: Record<RackSlotCategory, UKind> = {
  'compute-tray': 'compute', 'gpu-node': 'compute', 'scaleup-switch-tray': 'switch', 'power-shelf': 'power', switch: 'leaf', 'storage-shelf': 'storage',
  'storage-controller': 'controller', 'cpu-server': 'server', 'mgmt-server': 'server', 'patch-panel': 'patch', 'cable-manager': 'patch', stiffener: 'blank', reserved: 'mgmt', blank: 'blank', other: 'mgmt',
};

/**
 * Catalogue U-map of a rack type (200-series reference sheet, catalog schematic). Area D2: a view over the shared resolver
 * layout/rackContents.ts (same U positions as the rack plan, the cable schedule and the per-DU elevation sheets).
 * `leafTor` is kept for signature compatibility — ToR positions come from the network analysis switches.
 */
export function rackUMap(item: CatalogItem, locale: Locale, load?: NetworkRackLoad, leafTor = false): UMap {
  void leafTor;
  const L = locale;
  const map = rackSlotMap(item, load?.switches, findCatalogItem, { ruCapacity: load?.ruCapacity });
  const labelOf = (sl: RackSlot): string => {
    switch (sl.category) {
      case 'compute-tray': return `${tr(L, 'computeTray')} (${item.compute?.gpusPerNode ?? 4}× GPU)`;
      case 'gpu-node': return `${tr(L, 'server')} HGX / UBB8 ${item.compute?.gpusPerNode ?? 8}× GPU`;
      case 'scaleup-switch-tray': return tr(L, 'switchTray');
      case 'power-shelf': return tr(L, 'powerShelf');
      case 'switch': {
        const sw = sl.catalogId ? findCatalogItem(sl.catalogId) : undefined;
        const role = sl.role ?? 'leaf';
        return `${sw?.model ?? sl.catalogId} · ${tr(L, role)} · ${deviceWords(L, String(sl.fabric ?? ''))}`;
      }
      case 'patch-panel': return tr(L, 'patchPanel');
      case 'storage-shelf': return tr(L, 'storageShelf');
      case 'cpu-server': return `${tr(L, 'server')} 1U`;
      case 'mgmt-server': return `${tr(L, 'server')} (${tr(L, 'mgmt')})`;
      case 'reserved': return /^TOR/.test(sl.label) ? `${tr(L, 'leaf')} (ToR)` : tr(L, 'mgmtUnit');
      case 'blank': return tr(L, 'blank');
      // backlog T2 #12: generated slot models (power shelf, compute tray …) in the sheet language; catalog product names stay
      default: return deviceWords(L, sl.model);
    }
  };
  const blocks: UBlock[] = [];
  for (const sl of map.slots) {
    const kind: UKind = sl.category === 'switch' ? (sl.role === 'spine' ? 'spine' : sl.role === 'core' ? 'core' : 'leaf') : SLOT_KIND[sl.category];
    const label = labelOf(sl);
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && last.label === label && last.units === sl.units && last.u0 === sl.uEnd + 1) {
      last.u0 = sl.uStart;
      last.count += 1;
      continue;
    }
    blocks.push({ u0: sl.uStart, units: sl.units, kind, label, count: 1 });
  }
  // blanks of one run merge into 1-unit blocks with a count (drawn per unit)
  for (const b of blocks) if (b.kind === 'blank' && b.units > 1 && b.count === 1) { b.count = b.units; b.units = 1; }
  const est = L === 'ko' ? 'U-map은 계획용 추정치' : 'U-map is a planning estimate';
  const loadNote = load ? ` · ${load.ru}/${load.ruCapacity} U · ${load.kw.toFixed(1)}/${load.kwCapacity.toFixed(0)} kW` : '';
  return { totalU: map.totalU, unit: map.unit, blocks, note: `${map.source === 'estimate' ? `${est} — ` : ''}${deviceWords(L, map.note)}${loadNote}` };
}

export interface ElevationGroup {
  key: string;
  item: CatalogItem;
  members: SceneItem[];
  umap: UMap;
  load?: NetworkRackLoad;
}

/** Group racks by type (network racks additionally by their switch signature). */
export function elevationGroups(scenes: HallScene[], analysis: ProjectAnalysis | null, locale: Locale, leafTor: boolean): ElevationGroup[] {
  const loads = new Map<string, NetworkRackLoad>();
  for (const l of analysis?.network.rackLoads ?? []) loads.set(l.rackId, l);
  const groups = new Map<string, ElevationGroup>();
  for (const sc of scenes) {
    for (const r of sc.racks) {
      const load = r.item.category === 'network-rack' ? loads.get(r.e.id) : undefined;
      const sig = load ? load.switches.map((s) => `${s.role}:${s.catalogId}:${s.count}`).sort().join('|') : r.e.networkRole ?? '';
      const key = `${r.item.id}#${sig}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, item: r.item, members: [], umap: rackUMap(r.item, locale, load, leafTor), load };
        groups.set(key, g);
      }
      g.members.push(r);
    }
  }
  return [...groups.values()].sort((a, b) => b.members.length - a.members.length || a.item.id.localeCompare(b.item.id));
}

/** paper scale for elevations */
export const ELEV_MM_PER_M = 1000 / 20;

/** Draw one rack elevation with its U ruler at (x, y) top-left. Returns the cell size used. */
export function drawElevation(x: number, y: number, g: ElevationGroup, locale: Locale): { svg: string; w: number; h: number } {
  const L = locale;
  const s = ELEV_MM_PER_M;
  const rw = g.item.dims.w * s;
  const rh = g.item.dims.h * s;
  const rulerW = 7;
  const labelW = 58;
  const headH = 18;
  const rx = x + rulerW;
  const ry = y + headH;
  const out: string[] = [];
  const u = g.umap;
  const uH = rh / Math.max(1, u.totalU);
  // header
  out.push(text(x, y + 3.2, fitText(g.item.name, 2.6, rulerW + rw + labelW), { size: 2.6, weight: 700, fill: INK }));
  const tags = g.members.map((m) => m.e.tag).sort();
  const shown = tags.slice(0, 3).join(', ') + (tags.length > 3 ? ` +${tags.length - 3} ${tr(L, 'similar')}` : '');
  out.push(text(x, y + 6.6, fitText(`${g.members.length} ${tr(L, 'instances')}: ${shown}`, 1.9, rulerW + rw + labelW), { size: 1.9, fill: INK_SOFT }));
  const pw = g.item.power ? `${g.item.power.nameplateKW.toFixed(0)} kW` : '—';
  out.push(text(x, y + 10, fitText(`${g.item.dims.w.toFixed(2)} × ${g.item.dims.d.toFixed(2)} × ${g.item.dims.h.toFixed(2)} m · ${g.item.weightKg.toLocaleString('en-US')} kg · ${pw} · [${g.item.source}]`, 1.8, rulerW + rw + labelW), { size: 1.8, fill: INK_SOFT }));
  out.push(text(x, y + 13.4, fitText(u.note, 1.8, rulerW + rw + labelW), { size: 1.8, fill: INK_SOFT, italic: true }));
  // rack frame
  out.push(rect(rx, ry, rw, rh, { fill: PAPER, stroke: INK, sw: 0.4 }));
  out.push(rect(rx, ry + rh, rw, 1.6, { fill: '#2a2c30' })); // plinth
  out.push(text(rx + rw / 2, ry + rh + 4.6, tr(L, 'front'), { size: 1.8, anchor: 'middle', fill: INK_SOFT, letterSpacing: 0.4 }));
  // U ruler
  // numerals every 5 U at the 1.8 mm A1 minimum (ISO 3098); ticks every U, longer every 5
  const step = 5;
  for (let k = 1; k <= u.totalU; k++) {
    const yy = ry + rh - k * uH;
    out.push(line(rx - (k % step === 0 ? 2 : 1), yy, rx, yy, { stroke: LINE_LIGHT, sw: 0.12 }));
    if (k % step === 0 || k === 1) out.push(text(rx - 2.4, yy + uH / 2 + 0.7, String(k), { size: 1.8, anchor: 'end', fill: INK_SOFT }));
  }
  out.push(text(rx - 2.4, ry - 0.8, u.unit, { size: 1.8, anchor: 'end', fill: INK_SOFT }));
  // blocks
  for (const b of u.blocks) {
    const blockH = b.units * uH;
    for (let i = 0; i < b.count; i++) {
      const by = ry + rh - (b.u0 + i * b.units) * uH - blockH + uH;
      const yy = by - uH + blockH - blockH; // top of this unit block
      const top = ry + rh - (b.u0 - 1 + (i + 1) * b.units) * uH;
      void by;
      void yy;
      out.push(rect(rx + 0.4, top + 0.15, rw - 0.8, blockH - 0.3, { fill: KIND_COLOR[b.kind], stroke: b.kind === 'blank' ? LINE_LIGHT : INK_SOFT, sw: 0.12 }));
      if (b.kind === 'compute' || b.kind === 'switch') {
        // tray handles / LEDs
        out.push(rect(rx + 1.2, top + blockH / 2 - 0.3, 1.6, 0.6, { fill: INK_SOFT }));
        out.push(rect(rx + rw - 2.8, top + blockH / 2 - 0.3, 1.6, 0.6, { fill: INK_SOFT }));
      }
      if (b.kind === 'leaf' || b.kind === 'spine' || b.kind === 'core') {
        for (let p = 0; p < Math.min(16, Math.floor(rw / 1.5)); p++) out.push(rect(rx + 1.2 + p * 1.5, top + blockH - 0.9, 1.0, 0.5, { fill: INK_SOFT }));
      }
    }
    // group label to the right (once per block)
    const gTop = ry + rh - (b.u0 - 1 + b.count * b.units) * uH;
    const gH = b.count * b.units * uH;
    const label = `${b.count > 1 ? `${b.count} × ` : ''}${b.label}${b.units > 1 || b.count > 1 ? ` (${b.units}${u.unit})` : ''}`;
    out.push(line(rx + rw, gTop + gH / 2, rx + rw + 2, gTop + gH / 2, { stroke: INK_SOFT, sw: 0.12 }));
    out.push(text(rx + rw + 2.6, gTop + gH / 2 + 0.6, fitText(label, 1.8, labelW - 3), { size: 1.8, fill: b.kind === 'blank' ? LINE_LIGHT : INK }));
    if (b.kind !== 'blank') out.push(line(rx + rw + 0.3, gTop + 0.2, rx + rw + 0.3, gTop + gH - 0.2, { stroke: KIND_COLOR[b.kind] === '#f6f7f8' ? LINE_LIGHT : SYSTEM_COLOR.oob, sw: 0.3 }));
  }
  return { svg: out.join(''), w: rulerW + rw + labelW + 4, h: headH + rh + 8 };
}
