import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintRect, frontVector } from '../model/geometry.ts';
import type { CatalogItem, Containment, EquipmentInstance, Hall, Project, Rect, Vec3 } from '../model/types.ts';
import { buildHallPrims } from '../scene/build.ts';
import type { HallPrims } from '../scene/prims.ts';
import { RACK_CATEGORIES, networkRoleSystem, SYSTEM_COLOR, type SystemId } from './palette.ts';

/**
 * Engine-neutral view of one hall for the drawing generators: racks, mechanical units, rows, pods, containment
 * and the overhead services (trays / busways / liquid loops). Rows and runs come from the scene prims (scene/build.ts buildHallPrims,
 * hall detail), the single geometry source of the viewer, the 2D view and the r4 sheets (backlog T2 #1).
 */

export interface SceneItem {
  e: EquipmentInstance;
  item: CatalogItem;
  rect: Rect;
  /** rack fronts: unit vector the front faces */
  front: { x: number; y: number };
  isRack: boolean;
  /** system colouring for network racks (fabric) — undefined for other equipment */
  system?: SystemId;
  liquid: boolean;
}

export interface SceneRow {
  id: string;
  axis: 'x' | 'y';
  min: number;
  max: number;
  center: number;
  frontSign: 1 | -1;
  rackH: number;
  depth: number;
  liquid: boolean;
  podId?: string;
  members: SceneItem[];
}

export interface ScenePod {
  id: string;
  name: string;
  rect: Rect;
  waveId?: string;
  rows: SceneRow[];
  rackCount: number;
  gpuCount: number;
}

export interface Run {
  /** hall-local 3D polyline (m) */
  points: Vec3[];
  widthM: number;
  system: SystemId;
  kind: 'tray' | 'busway' | 'pipe' | 'cross-tray';
  rowId?: string;
}

export interface WaveInfo {
  id: string;
  name: string;
  index: number;
  podIds: string[];
}

export interface HallScene {
  hall: Hall;
  items: SceneItem[];
  racks: SceneItem[];
  mech: SceneItem[];
  rows: SceneRow[];
  pods: ScenePod[];
  containments: Containment[];
  runs: Run[];
  waves: WaveInfo[];
  /** wave index per equipment id (0-based; -1 when unknown) */
  waveOf: (e: EquipmentInstance) => number;
  hasLiquid: boolean;
  gpuCount: number;
}

const pad2 = (v: number) => String(v).padStart(2, '0');

export function hallOutline(hall: Hall): { x: number; y: number }[] {
  if (hall.outline && hall.outline.length >= 3) return hall.outline;
  return [
    { x: 0, y: 0 },
    { x: hall.width, y: 0 },
    { x: hall.width, y: hall.depth },
    { x: 0, y: hall.depth },
  ];
}

/**
 * Rows of the hall from the scene prims (backlog T2 #1: one geometry source). `HallPrims.rows` are the layout row groups
 * (layout/rows.ts) the viewer, the 2D view and every r4 sheet use; members are the scene items by equipment id.
 */
function rowsFromPrims(hp: HallPrims, items: readonly SceneItem[]): SceneRow[] {
  const byId = new Map(items.map((s) => [s.e.id, s]));
  const rows: SceneRow[] = [];
  for (const g of hp.rows) {
    const members = g.memberIds.map((id) => byId.get(id)).filter((s): s is SceneItem => !!s);
    if (!members.length) continue;
    let rackH = 0;
    let depth = 0;
    let liquid = false;
    for (const s of members) {
      if (s.isRack) rackH = Math.max(rackH, s.item.dims.h);
      depth = Math.max(depth, s.item.dims.d);
      if (s.liquid) liquid = true;
    }
    rows.push({ id: g.id, axis: g.axis, min: g.a0, max: g.a1, center: g.center, frontSign: g.frontSign, rackH: rackH || 2.3, depth: depth || 1.2, liquid, podId: g.podId ?? members[0].e.podId, members });
  }
  rows.sort((a, b) => a.center - b.center || a.min - b.min);
  return rows;
}

function unionRect(rects: Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.d);
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, d: 0 };
  return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
}

function podName(id: string, index: number): string {
  if (id.startsWith('pod-services')) return 'Services';
  const m = /^pod-(\d+)$/.exec(id);
  if (m) return `DU${pad2(Number(m[1]))}`;
  return id.length > 10 ? `POD${pad2(index + 1)}` : id.toUpperCase();
}

/**
 * Overhead runs from the scene prims (backlog T2 #1): tray (row → 'tray', main → 'cross-tray'; drops skipped), busway and TCS pipe
 * segments exactly as buildHallPrims emits them for the 3D viewer, the 2D view and the r4 sheets (no second derivation here).
 */
function runsFromPrims(hp: HallPrims): Run[] {
  const runs: Run[] = [];
  for (const p of hp.prims) {
    if (p.emitter !== 'tray' && p.emitter !== 'busway' && p.emitter !== 'pipe') continue;
    if (p.shape !== 'bar' && p.shape !== 'tube') continue;
    if (p.emitter === 'tray' && p.meta?.kind === 'drop') continue;
    const kind: Run['kind'] = p.emitter === 'busway' ? 'busway' : p.emitter === 'pipe' ? 'pipe' : p.meta?.kind === 'main' ? 'cross-tray' : 'tray';
    const fallback: SystemId = kind === 'busway' ? 'busway-a' : kind === 'pipe' ? 'cdu-supply' : 'trays';
    const system: SystemId = p.system && p.system in SYSTEM_COLOR ? (p.system as SystemId) : fallback;
    runs.push({ points: [{ ...p.a }, { ...p.b }], widthM: Math.max(0.05, Math.round(2 * p.halfW * 1000) / 1000), system, kind, ...(p.rowId ? { rowId: p.rowId } : {}) });
  }
  return runs;
}

export function buildHallScene(project: Project, hall: Hall, prims?: HallPrims): HallScene {
  const hp = prims ?? buildHallPrims(project, null, { hallId: hall.id, detail: 'hall' });
  const items: SceneItem[] = [];
  for (const e of project.equipment) {
    if (e.hallId !== hall.id) continue;
    const item = findCatalogItem(e.catalogId);
    if (!item) continue;
    const isRack = RACK_CATEGORIES.has(item.category);
    const liquid = item.category === 'gpu-rack' && (item.cooling?.liquidFraction ?? 0) > 0.5;
    items.push({
      e,
      item,
      rect: footprintRect(item.dims, e.position, e.rotationDeg),
      front: frontVector(e.rotationDeg),
      isRack,
      system: item.category === 'network-rack' ? networkRoleSystem(e.networkRole) : undefined,
      liquid,
    });
  }
  items.sort((a, b) => a.e.tag.localeCompare(b.e.tag));
  const racks = items.filter((s) => s.isRack);
  const mech = items.filter((s) => !s.isRack);
  const rows = rowsFromPrims(hp, items);

  // waves (schedule order; fallback = distinct waveIds on the equipment)
  const waveDefs = project.schedule.waves.length
    ? project.schedule.waves
    : [...new Set(items.map((s) => s.e.waveId).filter((w): w is string => !!w))].sort().map((id, i) => ({ id, name: `Wave ${i + 1}`, podIds: [] as string[] }));
  const waves: WaveInfo[] = waveDefs.map((w, i) => ({ id: w.id, name: w.name, index: i, podIds: w.podIds }));
  const waveIndex = new Map(waves.map((w) => [w.id, w.index]));
  const waveOf = (e: EquipmentInstance): number => {
    if (e.waveId && waveIndex.has(e.waveId)) return waveIndex.get(e.waveId)!;
    if (e.podId) {
      const w = waves.find((wv) => wv.podIds.includes(e.podId!));
      if (w) return w.index;
    }
    return waves.length ? 0 : -1;
  };

  // pods = bounding rects of racks sharing a podId (+ their rows)
  const podMap = new Map<string, SceneItem[]>();
  for (const s of racks) {
    const k = s.e.podId ?? 'pod-unassigned';
    const list = podMap.get(k) ?? [];
    list.push(s);
    podMap.set(k, list);
  }
  const pods: ScenePod[] = [];
  let pi = 0;
  for (const [id, members] of podMap) {
    const rect = unionRect(members.map((m) => m.rect));
    const podRows = rows.filter((r) => r.members.some((m) => members.includes(m)));
    // the pod rect spans the rows including the contained aisle between them
    const rr = podRows.length ? unionRect(podRows.map((r) => (r.axis === 'x' ? { x: r.min, y: r.center - r.depth / 2, w: r.max - r.min, d: r.depth } : { x: r.center - r.depth / 2, y: r.min, w: r.depth, d: r.max - r.min }))) : rect;
    const gpuCount = members.reduce((s, m) => s + (m.item.compute?.gpus ?? 0), 0);
    pods.push({ id, name: podName(id, pi++), rect: rr, waveId: members[0].e.waveId, rows: podRows, rackCount: members.length, gpuCount });
  }
  pods.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

  const containments = project.containments.filter((c) => c.hallId === hall.id);
  const runs = runsFromPrims(hp);
  const gpuCount = racks.reduce((s, m) => s + (m.item.compute?.gpus ?? 0), 0);
  return { hall, items, racks, mech, rows, pods, containments, runs, waves, waveOf, hasLiquid: rows.some((r) => r.liquid) || mech.some((m) => m.item.category === 'cdu'), gpuCount };
}

/** Which systems exist in the hall and the first wave that installs each (−1 = absent). */
export function systemFirstWave(scene: HallScene, project: Project): Partial<Record<SystemId, number>> {
  const first: Partial<Record<SystemId, number>> = {};
  const mark = (id: SystemId, w: number) => {
    if (w < 0) return;
    first[id] = first[id] === undefined ? w : Math.min(first[id]!, w);
  };
  for (const s of scene.items) {
    const w = scene.waveOf(s.e);
    const cat = s.item.category;
    if (cat === 'crah' || cat === 'fan-wall') mark('supply-air', w);
    if (cat === 'cdu') {
      mark('cdu-supply', w);
      mark('cdu-return', w);
    }
    if (s.isRack) {
      mark('busway-a', w);
      mark('busway-b', w);
      if (cat === 'gpu-rack') {
        mark('trays', w);
        if (s.liquid) {
          mark('cdu-supply', w);
          mark('cdu-return', w);
        }
        if (project.network.frontend.enabled) mark('frontend', w);
        if (project.network.storage.enabled) mark('storage', w);
        if (project.network.oob.enabled) mark('oob', w);
      }
      if (cat === 'network-rack' && s.system) mark(s.system, w);
      if (cat === 'storage-rack' && project.network.storage.enabled) mark('storage', w);
    }
  }
  for (const c of scene.containments) {
    const pod = scene.pods.find((p) => p.id === c.podId);
    const w = pod ? (pod.rows[0]?.members[0] ? scene.waveOf(pod.rows[0].members[0].e) : 0) : 0;
    if (c.kind === 'hot-aisle' && c.ductedToPlenum) mark('return-air', w);
    else if (c.kind === 'hot-aisle') mark('return-air', w);
  }
  return first;
}
