import { findCatalogItem } from '../catalog/catalog.ts';
import { footprintSize } from '../model/geometry.ts';
import type { Containment, EquipmentCategory, Hall, Keepout, Project, ProjectAnalysis } from '../model/types.ts';
import { CATEGORY_COLORS, r4, selectHalls, toSite, zUpToUnreal, zUpToYUp, type Tuple3 } from './transforms.ts';

/**
 * Engine-neutral scene description ("aidc.layout/1"). See SCHEMA.md.
 * Consumed by the Godot loader, the Unreal import script and any external tool.
 */

export interface LayoutTransform {
  /** Z-up right-handed meters, site space (USD / Omniverse / Blender Z-up) */
  zUp: { position: Tuple3; rotationZDeg: number };
  /** Y-up right-handed meters (glTF / Godot / three.js) */
  yUp: { position: Tuple3; rotationYDeg: number };
  /** Unreal Engine: Z-up left-handed centimeters */
  unreal: { location: Tuple3; yawDeg: number };
}

export interface LayoutCatalogEntry {
  id: string;
  name: string;
  category: EquipmentCategory;
  vendor: string;
  model: string;
  dims: { w: number; d: number; h: number };
  color: string;
  glb: string | null;
  usd: string | null;
  nameplateKW: number;
  weightKg: number;
}

export interface LayoutEquipment {
  id: string;
  tag: string;
  catalogId: string;
  category: EquipmentCategory;
  hallId: string;
  podId: string | null;
  rowId: string | null;
  waveId: string | null;
  networkRole: string | null;
  plan: { x: number; y: number; elevation: number; rotationDeg: number };
  /** transform of the footprint center at the equipment base */
  transform: LayoutTransform;
}

export interface LayoutBox {
  id: string;
  hallId: string;
  kind: string;
  label?: string;
  /** axis-aligned box: center + size, in each convention */
  zUp: { center: Tuple3; size: Tuple3 };
  yUp: { center: Tuple3; size: Tuple3 };
  unreal: { center: Tuple3; size: Tuple3 };
}

export interface LayoutContainment extends LayoutBox {
  containment: 'hot-aisle' | 'cold-aisle';
  roof: boolean;
  endDoors: boolean;
  ductedToPlenum: boolean;
  podId: string | null;
}

export interface LayoutHall {
  id: string;
  name: string;
  origin: { x: number; y: number };
  width: number;
  depth: number;
  clearHeight: number;
  ceilingPlenumHeight: number;
  raisedFloorHeight: number;
  trayHeight: number;
  itPowerBudgetKW: number;
  floor: LayoutBox;
  keepouts: LayoutBox[];
}

export interface LayoutCableRun {
  id: string;
  fabric: string;
  fromId: string;
  toId: string;
  lengthM: number;
  cableTypeId: string;
  count: number;
  /** tray-level endpoints (site Z-up meters) above the connected equipment */
  fromZUp: Tuple3 | null;
  toZUp: Tuple3 | null;
}

export interface LayoutScene {
  schema: 'aidc.layout/1';
  generator: string;
  generatedAt: string;
  project: { id: string; name: string; description: string; client: string | null };
  units: { length: 'm'; power: 'kW'; mass: 'kg' };
  conventions: Record<string, string>;
  halls: LayoutHall[];
  catalog: Record<string, LayoutCatalogEntry>;
  equipment: LayoutEquipment[];
  containments: LayoutContainment[];
  cableRuns: LayoutCableRun[];
  summary: ProjectAnalysis['summary'] | null;
}

function box(id: string, hall: Hall, kind: string, minX: number, minY: number, minZ: number, sx: number, sy: number, sz: number, label?: string): LayoutBox {
  const c = toSite(hall, { x: minX + sx / 2, y: minY + sy / 2 }, minZ + sz / 2);
  const yc = zUpToYUp(c);
  const uc = zUpToUnreal(c);
  return {
    id,
    hallId: hall.id,
    kind,
    label,
    zUp: { center: [r4(c.x), r4(c.y), r4(c.z)], size: [r4(sx), r4(sy), r4(sz)] },
    yUp: { center: yc, size: [r4(sx), r4(sz), r4(sy)] },
    unreal: { center: uc, size: [r4(sx * 100), r4(sy * 100), r4(sz * 100)] },
  };
}

export function equipmentTransform(hall: Hall, x: number, y: number, elevation: number, rotationDeg: number): LayoutTransform {
  const p = toSite(hall, { x, y }, elevation);
  const rot = ((rotationDeg % 360) + 360) % 360;
  return {
    zUp: { position: [r4(p.x), r4(p.y), r4(p.z)], rotationZDeg: rot },
    yUp: { position: zUpToYUp(p), rotationYDeg: rot },
    unreal: { location: zUpToUnreal(p), yawDeg: rot === 0 ? 0 : -rot },
  };
}

export function buildLayoutScene(project: Project, analysis?: ProjectAnalysis | null, opts: { hallId?: string } = {}): LayoutScene {
  const halls = selectHalls(project, opts.hallId);
  const hallIds = new Set(halls.map((h) => h.id));
  const hallMap = new Map(halls.map((h) => [h.id, h]));

  const catalog: Record<string, LayoutCatalogEntry> = {};
  const equipment: LayoutEquipment[] = [];
  const posById = new Map<string, { hall: Hall; x: number; y: number; h: number }>();

  for (const e of project.equipment) {
    if (!hallIds.has(e.hallId)) continue;
    const hall = hallMap.get(e.hallId)!;
    const item = findCatalogItem(e.catalogId);
    const category: EquipmentCategory = item?.category ?? 'other';
    if (item && !catalog[item.id]) {
      catalog[item.id] = {
        id: item.id,
        name: item.name,
        category,
        vendor: item.vendor,
        model: item.model,
        dims: { ...item.dims },
        color: item.asset?.color ?? CATEGORY_COLORS[category],
        glb: item.asset?.glb ?? null,
        usd: item.asset?.usd ?? null,
        nameplateKW: item.power?.nameplateKW ?? 0,
        weightKg: item.weightKg,
      };
    }
    const elevation = e.elevation ?? 0;
    equipment.push({
      id: e.id,
      tag: e.tag,
      catalogId: e.catalogId,
      category,
      hallId: e.hallId,
      podId: e.podId ?? null,
      rowId: e.rowId ?? null,
      waveId: e.waveId ?? null,
      networkRole: e.networkRole ?? null,
      plan: { x: e.position.x, y: e.position.y, elevation, rotationDeg: e.rotationDeg },
      transform: equipmentTransform(hall, e.position.x, e.position.y, elevation, e.rotationDeg),
    });
    posById.set(e.id, { hall, x: e.position.x, y: e.position.y, h: (item?.dims.h ?? 2.3) + elevation });
  }

  const layoutHalls: LayoutHall[] = halls.map((h) => ({
    id: h.id,
    name: h.name,
    origin: { ...h.origin },
    width: h.width,
    depth: h.depth,
    clearHeight: h.clearHeight,
    ceilingPlenumHeight: h.ceilingPlenumHeight,
    raisedFloorHeight: h.raisedFloorHeight,
    trayHeight: h.trayHeight,
    itPowerBudgetKW: h.itPowerBudgetKW,
    floor: box(`${h.id}-floor`, h, 'floor', 0, 0, -0.2, h.width, h.depth, 0.2),
    keepouts: h.keepouts.map((k: Keepout) => {
      const height = k.kind === 'column' || k.kind === 'shaft' ? h.clearHeight + h.ceilingPlenumHeight : k.kind === 'door' || k.kind === 'egress' ? 2.4 : 0.05;
      return box(k.id, h, k.kind, k.rect.x, k.rect.y, 0, k.rect.w, k.rect.d, height, k.label);
    }),
  }));

  const containments: LayoutContainment[] = project.containments
    .filter((c: Containment) => hallIds.has(c.hallId))
    .map((c) => {
      const hall = hallMap.get(c.hallId)!;
      const b = box(c.id, hall, 'containment', c.rect.x, c.rect.y, 0, c.rect.w, c.rect.d, c.height);
      return { ...b, containment: c.kind, roof: c.roof, endDoors: c.endDoors, ductedToPlenum: c.ductedToPlenum, podId: c.podId ?? null };
    });

  const tray = (id: string): Tuple3 | null => {
    const p = posById.get(id);
    if (!p) return null;
    const s = toSite(p.hall, { x: p.x, y: p.y }, Math.max(p.hall.trayHeight, p.h + 0.3));
    return [r4(s.x), r4(s.y), r4(s.z)];
  };
  const cableRuns: LayoutCableRun[] = (analysis?.network?.cableRuns ?? [])
    .filter((c) => posById.has(c.fromId) || posById.has(c.toId))
    .map((c) => ({ ...c, fromZUp: tray(c.fromId), toZUp: tray(c.toId) }));

  return {
    schema: 'aidc.layout/1',
    generator: 'AIDC Studio',
    generatedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, description: project.description, client: project.client ?? null },
    units: { length: 'm', power: 'kW', mass: 'kg' },
    conventions: {
      plan: 'Hall-local, right-handed, Z-up. rotationDeg is CCW about +Z. At 0° the equipment front (cold-air inlet) faces +Y.',
      zUp: 'Site space (hall.origin + plan), Z-up right-handed meters. Same as a Z-up OpenUSD stage (metersPerUnit=1).',
      yUp: 'glTF / Godot / three.js: (x, y, z)zUp → (x, z, -y). rotationYDeg equals rotationZDeg. Model files: front faces -Z, width along X, base at y=0.',
      unreal: 'Unreal Engine: (x, y, z)zUp → (100x, -100y, 100z) cm, left-handed; yawDeg = -rotationZDeg.',
      boxes: 'Boxes are axis-aligned: center + full size in the same convention.',
    },
    halls: layoutHalls,
    catalog,
    equipment,
    containments,
    cableRuns,
    summary: analysis?.summary ?? null,
  };
}

export function exportLayoutJson(project: Project, analysis?: ProjectAnalysis | null, opts: { hallId?: string } = {}): string {
  return JSON.stringify(buildLayoutScene(project, analysis, opts), null, 2);
}

/** Plan footprint extents of an equipment after rotation (helper for engine importers). */
export function footprintExtents(entry: LayoutCatalogEntry, rotationDeg: number): { sx: number; sy: number } {
  return footprintSize(entry.dims, rotationDeg);
}
