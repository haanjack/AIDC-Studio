import { findCatalogItem } from '../catalog/catalog.ts';
import type { CatalogItem, EquipmentInstance, Locale, NetworkRackLoad, Project, ProjectAnalysis, SpecSource } from '../model/types.ts';
import { makeFormatters, mdTable } from '../docs/index.ts';
import { RACK_CATS, waveOf } from './bom.ts';
import { deployStrings } from './strings.ts';
import { orderRackSwitches, rackSlotMap, type RackSlot } from '../layout/rackContents.ts';
import { buildRackContents } from './rackElevationsData.ts';

export interface RackPlanRow {
  hallId: string;
  hall: string;
  row: string;
  /** 1-based slot along the row, counted from the row start (min x, or min y for rotated rows) */
  position: number;
  tag: string;
  catalogId: string;
  type: string;
  category: string;
  waveId: string;
  wave: string;
  kw: number;
  weightKg: number;
  podId?: string;
  networkRole?: string;
  x: number;
  y: number;
  rotationDeg: number;
  /** key of the U-map this rack shares */
  umapKey: string;
}

export interface RackUMapEntry {
  /** e.g. "U1–U2" */
  ru: string;
  ruFrom: number;
  ruTo: number;
  content: string;
  qty: number;
  source: SpecSource;
}

export interface RackUMap {
  key: string;
  catalogId: string;
  type: string;
  category: string;
  ruCapacity: number;
  ruUsed: number;
  kw: number;
  kwCapacity: number;
  entries: RackUMapEntry[];
  rackIds: string[];
  tags: string[];
}

export interface RackPlan {
  rows: RackPlanRow[];
  umaps: RackUMap[];
}

// finish v2 2차 (QA rack-elevations m1): racks without a rowId bucket along the cross-row axis (x for 90° / 270° rows, y otherwise)
const rowKeyOf = (e: EquipmentInstance, tile: number) => {
  if (e.rowId) return e.rowId;
  const t = Math.max(0.1, tile);
  const vertical = e.rotationDeg % 180 !== 0;
  return vertical ? `x${(Math.round(e.position.x / t) * t).toFixed(1)}` : `y${(Math.round(e.position.y / t) * t).toFixed(1)}`;
};

/** Deterministic U-map for one rack — a view over the shared resolver layout/rackContents.ts (area D2): consecutive
 *  identical slots merge into one entry (top-down); blanking panels are not listed (free U = capacity − used). */
export function umapFor(item: CatalogItem, load: NetworkRackLoad | undefined, locale: Locale = 'en'): { entries: RackUMapEntry[]; ruCapacity: number; ruUsed: number; kw: number; kwCapacity: number; key: string } {
  const S = deployStrings(locale).umapItems;
  const map = rackSlotMap(item, load?.switches, findCatalogItem, { ruCapacity: load?.ruCapacity });
  const perNode = item.compute?.gpusPerNode ?? Math.max(1, item.compute?.scaleUp.domainSize || 8);
  const contentOf = (s: RackSlot): string => {
    switch (s.category) {
      case 'switch': {
        const sw = s.catalogId ? findCatalogItem(s.catalogId) : undefined;
        const role = s.role === 'leaf' ? S.leaf : s.role === 'spine' ? S.spine : S.core;
        return `${sw?.name ?? s.catalogId} — ${role} (${s.fabric})`;
      }
      case 'power-shelf': return S.powerShelf;
      case 'compute-tray': return S.computeTray;
      case 'scaleup-switch-tray': return S.nvswitch;
      case 'gpu-node': return S.gpuServer(perNode);
      case 'cpu-server': return S.cpuServer;
      case 'storage-shelf': return S.storageNode;
      case 'mgmt-server': return S.mgmtServer;
      case 'reserved': return /^TOR/.test(s.label) ? S.torSwitch : `${s.model}`;
      default: return s.model;
    }
  };
  const entries: RackUMapEntry[] = [];
  for (const s of map.slots) {
    if (s.category === 'blank') continue;
    const content = contentOf(s);
    const last = entries[entries.length - 1];
    if (last && last.content === content && last.ruFrom === s.uEnd + 1 && (last.ruTo - last.ruFrom + 1) % s.units === 0 && (last.ruTo - last.ruFrom + 1) / last.qty === s.units) {
      last.ruFrom = s.uStart;
      last.qty += 1;
      last.ru = `U${last.ruFrom}–U${last.ruTo}`;
      continue;
    }
    entries.push({ ru: s.units === 1 ? `U${s.uStart}` : `U${s.uStart}–U${s.uEnd}`, ruFrom: s.uStart, ruTo: s.uEnd, content, qty: 1, source: s.source });
  }
  const used = map.slots.filter((s) => s.category !== 'blank').reduce((a, s) => a + s.units, 0);
  if (item.category === 'network-rack') {
    const sws = orderRackSwitches(load?.switches ?? [], true);
    const key = `${item.id}|${sws.map((x) => `${x.catalogId}:${x.role}:${x.count}`).join(',')}`;
    return { entries, ruCapacity: map.totalU, ruUsed: load?.ru ?? used, kw: load?.kw ?? 0, kwCapacity: load?.kwCapacity ?? (item.power?.nameplateKW ?? 0), key };
  }
  return { entries, ruCapacity: map.totalU, ruUsed: used, kw: item.power?.nameplateKW ?? 0, kwCapacity: item.power?.nameplateKW ?? 0, key: item.id };
}

export function buildRackPlan(project: Project, analysis: ProjectAnalysis | null, locale: Locale = 'en'): RackPlan {
  const S = deployStrings(locale);
  const loads = new Map((analysis?.network.rackLoads ?? []).map((l) => [l.rackId, l]));
  const halls = new Map(project.halls.map((h) => [h.id, h]));
  const waveName = (id: string) => (id === 'common' ? S.common : project.schedule.waves.find((w) => w.id === id)?.name ?? id);
  const racks = project.equipment
    .map((e) => ({ e, item: findCatalogItem(e.catalogId), hall: halls.get(e.hallId) }))
    .filter((x): x is { e: EquipmentInstance; item: CatalogItem; hall: NonNullable<ReturnType<typeof halls.get>> } => !!x.item && !!x.hall && RACK_CATS.has(x.item.category));
  // position within row: sort by x for 0/180° rows, by y for 90/270° rows
  const byRow = new Map<string, typeof racks>();
  for (const r of racks) {
    const k = `${r.e.hallId}|${rowKeyOf(r.e, r.hall.tileSize)}`;
    const arr = byRow.get(k) ?? [];
    arr.push(r);
    byRow.set(k, arr);
  }
  const posOf = new Map<string, number>();
  for (const [, arr] of byRow) {
    const vertical = arr.every((r) => r.e.rotationDeg === 90 || r.e.rotationDeg === 270);
    arr.sort((a, b) => (vertical ? a.e.position.y - b.e.position.y : a.e.position.x - b.e.position.x) || a.e.tag.localeCompare(b.e.tag));
    arr.forEach((r, i) => posOf.set(r.e.id, i + 1));
  }
  // finish v2 2차 (QA rack-elevations M6): kW, weight and U used come from the shared rack-contents resolver, so rack-plan.csv agrees with
  // rack-summary.csv and the elevations (network racks carry their switch kW and weight; U used excludes reserved positions and includes
  // the network rack patch panel)
  const contents = new Map(buildRackContents(project, analysis, { thermal: [] }).map((c) => [c.rack.id, c]));
  const umaps = new Map<string, RackUMap>();
  const rows: RackPlanRow[] = racks.map(({ e, item, hall }) => {
    const wid = waveOf(e, project);
    const um = umapFor(item, loads.get(e.id), locale);
    const rc = contents.get(e.id);
    if (rc) Object.assign(um, { ruUsed: rc.usedU, kw: rc.kwDesign });
    const cur = umaps.get(um.key) ?? { key: um.key, catalogId: item.id, type: item.name, category: item.category, ruCapacity: um.ruCapacity, ruUsed: um.ruUsed, kw: um.kw, kwCapacity: um.kwCapacity, entries: um.entries, rackIds: [], tags: [] };
    cur.rackIds.push(e.id);
    cur.tags.push(e.tag);
    umaps.set(um.key, cur);
    return {
      hallId: hall.id, hall: hall.name, row: rowKeyOf(e, hall.tileSize), position: posOf.get(e.id) ?? 0, tag: e.tag, catalogId: item.id, type: item.name, category: item.category,
      waveId: wid, wave: waveName(wid), kw: rc ? rc.kwDesign : Math.round((item.power?.nameplateKW ?? 0) * (e.loadFactor ?? 1) * 10) / 10, weightKg: rc ? rc.weightKg : item.weightKg,
      podId: e.podId, networkRole: e.networkRole, x: Math.round(e.position.x * 100) / 100, y: Math.round(e.position.y * 100) / 100, rotationDeg: e.rotationDeg, umapKey: um.key,
    };
  });
  rows.sort((a, b) => a.hall.localeCompare(b.hall) || a.row.localeCompare(b.row) || a.position - b.position || a.tag.localeCompare(b.tag));
  return { rows, umaps: [...umaps.values()].sort((a, b) => b.rackIds.length - a.rackIds.length || a.key.localeCompare(b.key)) };
}

const csvCell = (v: string | number | undefined) => {
  if (v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function rackPlanCsv(plan: RackPlan): string {
  const header = ['hall', 'row', 'position', 'tag', 'type', 'catalogId', 'category', 'wave', 'kW', 'weightKg', 'pod', 'networkRole', 'x', 'y', 'rotationDeg'];
  return [header.join(','), ...plan.rows.map((r) => [r.hall, r.row, r.position, r.tag, r.type, r.catalogId, r.category, r.waveId, r.kw, r.weightKg, r.podId, r.networkRole, r.x, r.y, r.rotationDeg].map(csvCell).join(','))].join('\n') + '\n';
}

export function rackPlanMarkdown(project: Project, plan: RackPlan, locale: Locale = 'en'): string {
  const S = deployStrings(locale);
  const { n } = makeFormatters(locale);
  const C = S.rackCols;
  const out: string[] = [`# ${S.rackTitle(project.name)}`, '', S.rackIntro, ''];
  for (const hall of project.halls) {
    const rows = plan.rows.filter((r) => r.hallId === hall.id);
    if (!rows.length) continue;
    out.push(`## ${hall.name}`, '');
    out.push(mdTable([C.row, C.position, C.tag, C.type, C.category, C.wave, C.kw, C.weight, C.pod, C.role, C.x, C.y, C.rot], rows.map((r) => [
      r.row, r.position, r.tag, r.type, S.categories[r.category] ?? r.category, r.wave, n(r.kw, 1), n(r.weightKg), r.podId ?? '-', r.networkRole ?? '-', n(r.x, 2), n(r.y, 2), r.rotationDeg,
    ])), '');
  }
  out.push(`## ${S.umapTitle}`, '', S.umapIntro, '');
  const U = S.umapCols;
  for (const um of plan.umaps) {
    out.push(`### ${um.type} — ${S.categories[um.category] ?? um.category}`, '');
    out.push(`- ${S.umapRacks(um.rackIds.length, um.tags.slice(0, 12).join(', ') + (um.tags.length > 12 ? ' …' : ''))}`);
    out.push(`- ${S.ruUsed(um.ruUsed, um.ruCapacity, n(um.kw, 1), n(um.kwCapacity, 1))}`, '');
    const freeTop = um.entries.length ? Math.min(...um.entries.map((e) => e.ruFrom)) - 1 : um.ruCapacity;
    const entries = um.entries.map((e) => [e.ru, e.content, e.qty, S.sourceLabel[e.source] ?? e.source] as (string | number)[]);
    if (freeTop > 0) entries.push([freeTop === 1 ? 'U1' : `U1–U${freeTop}`, S.free, freeTop, S.sourceLabel.estimate]);
    out.push(mdTable([U.ru, U.content, U.qty, U.source], entries), '');
  }
  return out.join('\n');
}
