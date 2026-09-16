import { findCatalogItem, footprintRect, frontVector } from '../../core/src/index.ts';
import type { CatalogItem, EquipmentInstance, Hall, Project, Rect } from '../../core/src/index.ts';
import type { ThermalGrid, ThermalOptions } from './types.ts';

export const RHO_AIR = 1.19; // kg/m³ at ~25 °C
export const CP_AIR = 1006; // J/(kg·K)

export const FLAG_OPEN = 0;
export const FLAG_BLOCKED = 1;
export const FLAG_FIXED = 2;

/** Default air-side heat of a network rack (kW) when no override is given. */
export const NETWORK_RACK_AIR_KW = 25;
/** Design ΔT used to derive airflow for equipment without an airflow spec. */
const DESIGN_DELTA_T = 12;
/** Portion of a CRAH front face used as supply (from the floor up). */
const SUPPLY_FRACTION = 0.55;
/** Share of exhaust recirculating internally when blanking panels are missing. */
export const RECIRCULATION_NO_BLANKING = 0.08;

/**
 * A planar set of device faces on the MAC grid.
 * `sign` is the outward normal of the device along `axis` (the direction air enters the room
 * through an exhaust/supply face). `cells` are the fluid cells adjacent to each face.
 */
export interface FaceSet {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
  faces: Int32Array;
  cells: Int32Array;
}

export interface CellBox {
  i0: number;
  i1: number;
  j0: number;
  j1: number;
  k0: number;
  k1: number;
}

export interface ThermalRack {
  id: string;
  tag: string;
  catalogId: string;
  airKW: number;
  /** airflow at nameplate (m³/s) before the fan scale */
  nominalAirflowM3s: number;
  airflowCurve?: [number, number][];
  /** fan speed scale (load factor with a 40% floor) */
  flowScale: number;
  recirculation: number;
  inlet: FaceSet;
  exhaust: FaceSet;
  /** cells receiving the heat when the rack has no usable inlet/exhaust faces */
  fallbackCells: Int32Array;
  /** auxiliary in-row unit (e.g. CDU cabinet): contributes heat & airflow, excluded from IT inlet metrics */
  aux?: boolean;
  /** T4 RDHx: rated door capacity (kW) and/or removed fraction of airKW */
  doorKW?: number;
  doorFraction?: number;
  /** T4 co-located L2A sidecar: airflow added on top of the rack fans (m³/s) */
  extraAirflowM3s?: number;
}

export interface ThermalCooler {
  id: string;
  tag: string;
  catalogId: string;
  capacityKW: number;
  maxAirflowM3s: number;
  supply: FaceSet;
  /** plenum cells the return duct draws from (volumetric sinks) */
  sinkCells: Int32Array;
  /** return faces on top of the unit when there is no plenum */
  returnFaces: FaceSet | null;
  virtual: boolean;
  /** T4: in-row coolers return from a horizontal (hot-aisle) face instead of the plenum / unit top */
  kind?: 'room' | 'in-row';
}

export interface ThermalHeatSource {
  id: string;
  tag: string;
  cells: Int32Array;
  watts: number;
}

export interface ThermalContainmentZone extends CellBox {
  id: string;
  podId?: string;
  kind: 'hot-aisle' | 'cold-aisle';
  /** top cell index of the zone including a ducted chimney */
  chimneyTopK: number;
}

export interface ThermalCase {
  grid: ThermalGrid;
  options: ThermalOptions;
  hallId: string;
  clearHeight: number;
  /** w-face index of the suspended ceiling (-1 = no plenum) */
  ceilingK: number;
  supplyC: number;
  solid: Uint8Array;
  flagU: Uint8Array;
  flagV: Uint8Array;
  flagW: Uint8Array;
  racks: ThermalRack[];
  coolers: ThermalCooler[];
  heatSources: ThermalHeatSource[];
  containments: ThermalContainmentZone[];
  /** connected air volume per cell (-1 = solid) */
  component: Int32Array;
  componentCount: number;
  /** one pressure anchor cell per component */
  anchors: Int32Array;
  warnings: string[];
}

const RACK_CATEGORIES = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);
const COOLER_CATEGORIES = new Set(['crah', 'fan-wall']);

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clipRegion(region: Rect | undefined, hall: Hall): Rect {
  if (!region) return { x: 0, y: 0, w: hall.width, d: hall.depth };
  const x0 = clamp(region.x, 0, hall.width);
  const y0 = clamp(region.y, 0, hall.depth);
  const x1 = clamp(region.x + region.w, 0, hall.width);
  const y1 = clamp(region.y + region.d, 0, hall.depth);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) throw new Error('thermal: region does not intersect the hall');
  return { x: x0, y: y0, w: x1 - x0, d: y1 - y0 };
}

export function buildThermalCase(project: Project, options: ThermalOptions): ThermalCase {
  const hall = project.halls.find((x) => x.id === options.hallId);
  if (!hall) throw new Error(`thermal: hall not found: ${options.hallId}`);
  const h = options.cellSize > 0 ? options.cellSize : 0.3;
  const loadFactor = Math.max(0, options.loadFactor ?? 1);
  const supplyC = options.supplyAirC ?? project.cooling?.supplyAirC ?? 24;
  const plenum = options.includePlenum !== false && hall.ceilingPlenumHeight > 0;
  const reg = clipRegion(options.region, hall);
  const nx = Math.max(4, Math.round(reg.w / h));
  const ny = Math.max(4, Math.round(reg.d / h));
  const height = hall.clearHeight + (plenum ? hall.ceilingPlenumHeight : 0);
  const nz = Math.max(4, Math.round(height / h));
  const ceilingK = plenum ? clamp(Math.round(hall.clearHeight / h), 2, nz - 1) : -1;
  const ox = reg.x;
  const oy = reg.y;
  const N = nx * ny * nz;
  const nxny = nx * ny;
  const warnings: string[] = [];

  const cell = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const uIdx = (i: number, j: number, k: number) => i + (nx + 1) * (j + ny * k);
  const vIdx = (i: number, j: number, k: number) => i + nx * (j + (ny + 1) * k);
  const wIdx = (i: number, j: number, k: number) => i + nx * (j + ny * k);

  /** cells whose centers fall in [a0, a1) — at least one cell for thin objects */
  const span = (a0: number, a1: number, o: number, n: number): [number, number] | null => {
    let i0 = Math.ceil((a0 - o) / h - 0.5 - 1e-6);
    let i1 = Math.ceil((a1 - o) / h - 0.5 - 1e-6) - 1;
    if (i1 < i0) {
      const c = Math.floor(((a0 + a1) / 2 - o) / h);
      i0 = c;
      i1 = c;
    }
    if (i1 < 0 || i0 > n - 1) return null;
    return [Math.max(0, i0), Math.min(n - 1, i1)];
  };
  const planeIndex = (p: number, o: number, n: number) => clamp(Math.round((p - o) / h), 0, n);

  const solid = new Uint8Array(N);
  const fillSolid = (b: CellBox) => {
    for (let k = b.k0; k <= b.k1; k++) for (let j = b.j0; j <= b.j1; j++) for (let i = b.i0; i <= b.i1; i++) solid[cell(i, j, k)] = 1;
  };

  // ── 1. rasterize equipment & keepouts ──────────────────────────────────────────────
  interface Placed {
    inst: EquipmentInstance;
    item: CatalogItem;
    box: CellBox;
  }
  const placed: Placed[] = [];
  for (const inst of project.equipment) {
    if (inst.hallId !== hall.id) continue;
    const item = findCatalogItem(inst.catalogId);
    if (!item || item.category === 'switch') continue;
    if (options.roomCoolers === 'none' && COOLER_CATEGORIES.has(item.category)) continue;
    const fr = footprintRect(item.dims, inst.position, inst.rotationDeg);
    if (fr.x + fr.w <= reg.x || fr.x >= reg.x + reg.w || fr.y + fr.d <= reg.y || fr.y >= reg.y + reg.d) continue;
    const is = span(fr.x, fr.x + fr.w, ox, nx);
    const js = span(fr.y, fr.y + fr.d, oy, ny);
    const z0 = inst.elevation ?? 0;
    const ks = span(z0, z0 + item.dims.h, 0, nz);
    if (!is || !js || !ks) continue;
    let k1 = ks[1];
    if (ceilingK > 0 && k1 >= ceilingK) k1 = ceilingK - 1;
    const box: CellBox = { i0: is[0], i1: is[1], j0: js[0], j1: js[1], k0: ks[0], k1 };
    fillSolid(box);
    placed.push({ inst, item, box });
  }
  for (const ko of hall.keepouts ?? []) {
    if (ko.kind !== 'column' && ko.kind !== 'shaft' && ko.kind !== 'other') continue;
    const is = span(ko.rect.x, ko.rect.x + ko.rect.w, ox, nx);
    const js = span(ko.rect.y, ko.rect.y + ko.rect.d, oy, ny);
    if (!is || !js) continue;
    // columns & shafts run through the plenum; partitions ('other') stop at the suspended ceiling
    const k1 = ko.kind === 'other' && ceilingK > 0 ? ceilingK - 1 : nz - 1;
    fillSolid({ i0: is[0], i1: is[1], j0: js[0], j1: js[1], k0: 0, k1 });
  }
  // T4: synthetic cabinets (in-row coolers, explicit L2A sidecars) are solid like equipment
  const unitBox = (r: Rect, heightM: number): CellBox | null => {
    const is = span(r.x, r.x + r.w, ox, nx);
    const js = span(r.y, r.y + r.d, oy, ny);
    const ks = span(0, heightM, 0, nz);
    if (!is || !js || !ks) return null;
    const k1 = ceilingK > 0 && ks[1] >= ceilingK ? ceilingK - 1 : ks[1];
    return { i0: is[0], i1: is[1], j0: js[0], j1: js[1], k0: ks[0], k1 };
  };
  const inRowBoxes: { spec: NonNullable<ThermalOptions['inRowCoolers']>[number]; box: CellBox }[] = [];
  for (const spec of options.inRowCoolers ?? []) {
    const box = unitBox(spec.rect, spec.heightM ?? 2.0);
    if (!box) continue;
    fillSolid(box);
    inRowBoxes.push({ spec, box });
  }
  const sidecarBoxes: { spec: NonNullable<NonNullable<ThermalOptions['sidecars']>['units']>[number]; box: CellBox }[] = [];
  for (const spec of options.sidecars?.units ?? []) {
    const box = unitBox(spec.rect, spec.heightM ?? 2.3);
    if (!box) continue;
    fillSolid(box);
    sidecarBoxes.push({ spec, box });
  }
  // CRAH return ducts: solid column from the unit top to the ceiling
  if (ceilingK > 0 && options.coolerReturn !== 'top') {
    for (const p of placed) {
      if (!COOLER_CATEGORIES.has(p.item.category)) continue;
      if (p.box.k1 < ceilingK - 1) fillSolid({ ...p.box, k0: p.box.k1 + 1, k1: ceilingK - 1 });
    }
  }

  // ── 2. base face flags: domain boundary and solid adjacency are blocked ───────────
  const flagU = new Uint8Array((nx + 1) * ny * nz);
  const flagV = new Uint8Array(nx * (ny + 1) * nz);
  const flagW = new Uint8Array(nx * ny * (nz + 1));
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i <= nx; i++) {
        const blocked = i === 0 || i === nx || solid[cell(i - 1, j, k)] === 1 || solid[cell(i, j, k)] === 1;
        flagU[uIdx(i, j, k)] = blocked ? FLAG_BLOCKED : FLAG_OPEN;
      }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i < nx; i++) {
        const blocked = j === 0 || j === ny || solid[cell(i, j - 1, k)] === 1 || solid[cell(i, j, k)] === 1;
        flagV[vIdx(i, j, k)] = blocked ? FLAG_BLOCKED : FLAG_OPEN;
      }
  for (let k = 0; k <= nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const blocked = k === 0 || k === nz || solid[cell(i, j, k - 1)] === 1 || solid[cell(i, j, k)] === 1;
        flagW[wIdx(i, j, k)] = blocked ? FLAG_BLOCKED : FLAG_OPEN;
      }
  const blockU = (i: number, j: number, k: number) => {
    if (i < 0 || i > nx || j < 0 || j >= ny || k < 0 || k >= nz) return;
    const f = uIdx(i, j, k);
    if (flagU[f] === FLAG_OPEN) flagU[f] = FLAG_BLOCKED;
  };
  const blockV = (i: number, j: number, k: number) => {
    if (i < 0 || i >= nx || j < 0 || j > ny || k < 0 || k >= nz) return;
    const f = vIdx(i, j, k);
    if (flagV[f] === FLAG_OPEN) flagV[f] = FLAG_BLOCKED;
  };
  const blockW = (i: number, j: number, k: number) => {
    if (i < 0 || i >= nx || j < 0 || j >= ny || k < 0 || k > nz) return;
    const f = wIdx(i, j, k);
    if (flagW[f] === FLAG_OPEN) flagW[f] = FLAG_BLOCKED;
  };

  // ── 3. containment thin walls, doors, roofs and chimneys ─────────────────────────
  const useContainment = options.overrides?.containment !== 'none';
  const ceilingOpen = new Uint8Array(nxny);
  const containments: ThermalContainmentZone[] = [];
  const hallContainments = (project.containments ?? []).filter((c) => c.hallId === hall.id);
  for (const c of hallContainments) {
    const r = c.rect;
    const is = span(r.x, r.x + r.w, ox, nx);
    const js = span(r.y, r.y + r.d, oy, ny);
    if (!is || !js) continue;
    const kTop = clamp(Math.round(c.height / h), 1, ceilingK > 0 ? ceilingK : nz);
    const zone: ThermalContainmentZone = {
      id: c.id,
      podId: c.podId,
      kind: c.kind,
      i0: is[0],
      i1: is[1],
      j0: js[0],
      j1: js[1],
      k0: 0,
      k1: kTop - 1,
      chimneyTopK: kTop - 1,
    };
    containments.push(zone);
    if (!useContainment) continue;
    const jf0 = planeIndex(r.y, oy, ny);
    const jf1 = planeIndex(r.y + r.d, oy, ny);
    const if0 = planeIndex(r.x, ox, nx);
    const if1 = planeIndex(r.x + r.w, ox, nx);
    for (let k = 0; k < kTop; k++) {
      for (let i = is[0]; i <= is[1]; i++) {
        blockV(i, jf0, k);
        blockV(i, jf1, k);
      }
      // end doors keep a one-cell undercut at the floor: the containment leakage path that lets CRAH
      // oversupply bypass into the hot aisle (or hot air leak back out when cooling is short)
      if (c.endDoors && k > 0) {
        for (let j = js[0]; j <= js[1]; j++) {
          blockU(if0, j, k);
          blockU(if1, j, k);
        }
      }
    }
    const ducted = c.kind === 'hot-aisle' && c.ductedToPlenum && ceilingK > 0;
    if (c.kind === 'hot-aisle' && c.ductedToPlenum && ceilingK < 0) {
      warnings.push(`${c.id}: ducted HAC without a ceiling plenum — roof treated as open`);
    }
    // CAC without a raised floor has no supply path — keep its roof perforated.
    const cacNeedsOpenRoof = c.kind === 'cold-aisle' && hall.raisedFloorHeight <= 0;
    if (cacNeedsOpenRoof && c.roof) warnings.push(`${c.id}: cold-aisle containment without raised floor — roof modeled as perforated`);
    if (ducted) {
      zone.chimneyTopK = ceilingK - 1;
      for (let k = kTop; k < ceilingK; k++) {
        for (let i = is[0]; i <= is[1]; i++) {
          blockV(i, jf0, k);
          blockV(i, jf1, k);
        }
        for (let j = js[0]; j <= js[1]; j++) {
          blockU(if0, j, k);
          blockU(if1, j, k);
        }
      }
      for (let j = js[0]; j <= js[1]; j++) for (let i = is[0]; i <= is[1]; i++) ceilingOpen[i + nx * j] = 1;
    } else if (c.roof && !cacNeedsOpenRoof && !(c.kind === 'hot-aisle' && c.ductedToPlenum)) {
      for (let j = js[0]; j <= js[1]; j++) for (let i = is[0]; i <= is[1]; i++) blockW(i, j, kTop);
    }
  }

  // ── 4. suspended ceiling with return openings ─────────────────────────────────────
  if (ceilingK > 0) {
    // Return grilles above the exhaust zone of every rack that does not exhaust into an active
    // containment (a designer puts ceiling returns over open hot aisles). The zone spans the rack
    // width and ~1.2 m behind the rear face.
    const inActiveZone = (i: number, j: number) => {
      if (!useContainment) return false;
      for (const z of containments) if (i >= z.i0 && i <= z.i1 && j >= z.j0 && j <= z.j1) return true;
      return false;
    };
    const reach = Math.max(1, Math.round(1.2 / h));
    for (const p of placed) {
      if (!RACK_CATEGORIES.has(p.item.category)) continue;
      const f = frontVector(p.inst.rotationDeg);
      const b = p.box;
      let i0: number, i1: number, j0: number, j1: number;
      if (Math.abs(f.y) > 0.5) {
        i0 = b.i0;
        i1 = b.i1;
        j0 = f.y > 0 ? b.j0 - reach : b.j1 + 1;
        j1 = f.y > 0 ? b.j0 - 1 : b.j1 + reach;
      } else {
        j0 = b.j0;
        j1 = b.j1;
        i0 = f.x > 0 ? b.i0 - reach : b.i1 + 1;
        i1 = f.x > 0 ? b.i0 - 1 : b.i1 + reach;
      }
      const ci = clamp(Math.round((i0 + i1) / 2), 0, nx - 1);
      const cj = clamp(Math.round((j0 + j1) / 2), 0, ny - 1);
      if (inActiveZone(ci, cj)) continue;
      for (let j = Math.max(0, j0); j <= Math.min(ny - 1, j1); j++)
        for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) ceilingOpen[i + nx * j] = 1;
    }
    for (const r of options.ceilingOpenings ?? []) {
      const is = span(r.x, r.x + r.w, ox, nx);
      const js = span(r.y, r.y + r.d, oy, ny);
      if (!is || !js) continue;
      for (let j = js[0]; j <= js[1]; j++) for (let i = is[0]; i <= is[1]; i++) ceilingOpen[i + nx * j] = 1;
    }
    let openings = 0;
    for (let n = 0; n < nxny; n++) openings += ceilingOpen[n];
    if (openings === 0) {
      for (let j = 1; j < ny - 1; j += 3) for (let i = 1; i < nx - 1; i += 3) ceilingOpen[i + nx * j] = 1;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!ceilingOpen[i + nx * j]) blockW(i, j, ceilingK);
  }

  // ── 5. device faces ───────────────────────────────────────────────────────────────
  const makeFaceSet = (box: CellBox, axis: 0 | 1 | 2, sign: 1 | -1, kLo: number, kHi: number): FaceSet => {
    const faces: number[] = [];
    const cells: number[] = [];
    if (axis === 0) {
      const iface = sign > 0 ? box.i1 + 1 : box.i0;
      const inb = sign > 0 ? box.i1 + 1 : box.i0 - 1;
      if (inb >= 0 && inb < nx)
        for (let k = kLo; k <= kHi; k++)
          for (let j = box.j0; j <= box.j1; j++) {
            const nb = cell(inb, j, k);
            if (solid[nb]) continue;
            const f = uIdx(iface, j, k);
            flagU[f] = FLAG_FIXED;
            faces.push(f);
            cells.push(nb);
          }
    } else if (axis === 1) {
      const jface = sign > 0 ? box.j1 + 1 : box.j0;
      const jnb = sign > 0 ? box.j1 + 1 : box.j0 - 1;
      if (jnb >= 0 && jnb < ny)
        for (let k = kLo; k <= kHi; k++)
          for (let i = box.i0; i <= box.i1; i++) {
            const nb = cell(i, jnb, k);
            if (solid[nb]) continue;
            const f = vIdx(i, jface, k);
            flagV[f] = FLAG_FIXED;
            faces.push(f);
            cells.push(nb);
          }
    } else {
      const kface = sign > 0 ? box.k1 + 1 : box.k0;
      const knb = sign > 0 ? box.k1 + 1 : box.k0 - 1;
      if (knb >= 0 && knb < nz)
        for (let j = box.j0; j <= box.j1; j++)
          for (let i = box.i0; i <= box.i1; i++) {
            const nb = cell(i, j, knb);
            if (solid[nb]) continue;
            const f = wIdx(i, j, kface);
            flagW[f] = FLAG_FIXED;
            faces.push(f);
            cells.push(nb);
          }
    }
    return { axis, sign, faces: Int32Array.from(faces), cells: Int32Array.from(cells) };
  };
  const frontAxis = (rot: number): { axis: 0 | 1; sign: 1 | -1 } => {
    const f = frontVector(rot);
    return Math.abs(f.x) > 0.5 ? { axis: 0, sign: f.x > 0 ? 1 : -1 } : { axis: 1, sign: f.y > 0 ? 1 : -1 };
  };
  const neighborCells = (box: CellBox): Int32Array => {
    const out: number[] = [];
    const top = box.k1 + 1;
    if (top < nz) for (let j = box.j0; j <= box.j1; j++) for (let i = box.i0; i <= box.i1; i++) if (!solid[cell(i, j, top)]) out.push(cell(i, j, top));
    if (out.length === 0) {
      for (let k = box.k0; k <= box.k1; k++)
        for (let j = box.j0 - 1; j <= box.j1 + 1; j++)
          for (let i = box.i0 - 1; i <= box.i1 + 1; i++) {
            if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
            if (i >= box.i0 && i <= box.i1 && j >= box.j0 && j <= box.j1) continue;
            if (!solid[cell(i, j, k)]) out.push(cell(i, j, k));
          }
    }
    return Int32Array.from(out);
  };

  const racks: ThermalRack[] = [];
  const coolers: ThermalCooler[] = [];
  const heatSources: ThermalHeatSource[] = [];
  const overrides = options.airHeatOverridesKW ?? {};
  const blankingOverride = options.overrides?.blanking;
  /** liquid share of rack heat at the load factor (kW) — rejected to room air by T4 sidecars */
  const rackLiquidKW = new Map<string, number>();

  for (const p of placed) {
    const { inst, item, box } = p;
    const lf = Math.max(0, inst.loadFactor ?? loadFactor);
    if (RACK_CATEGORIES.has(item.category)) {
      const liquid = item.cooling?.liquidFraction ?? 0;
      let airKW: number;
      if (overrides[inst.id] !== undefined) airKW = overrides[inst.id];
      else if (item.category === 'network-rack') airKW = NETWORK_RACK_AIR_KW;
      else airKW = (item.power?.nameplateKW ?? 0) * lf * (1 - liquid);
      if (item.category !== 'network-rack' && liquid > 0) rackLiquidKW.set(inst.id, (item.power?.nameplateKW ?? 0) * lf * liquid);
      const designKW = item.category === 'network-rack' ? airKW : (item.power?.nameplateKW ?? 0) * (1 - liquid);
      let nominal = item.cooling?.airflowM3s ?? 0;
      if (nominal <= 0 && designKW > 0) nominal = (designKW * 1000) / (RHO_AIR * CP_AIR * DESIGN_DELTA_T);
      const fa = frontAxis(inst.rotationDeg);
      const inlet = makeFaceSet(box, fa.axis, fa.sign, box.k0, box.k1);
      const exhaust = makeFaceSet(box, fa.axis, fa.sign > 0 ? -1 : 1, box.k0, box.k1);
      const blanking = blankingOverride !== undefined ? blankingOverride : inst.blanking !== false;
      const flowOverride = options.airflowOverridesM3s?.[inst.id];
      racks.push({
        id: inst.id,
        tag: inst.tag,
        catalogId: item.id,
        airKW,
        nominalAirflowM3s: flowOverride ?? nominal,
        airflowCurve: flowOverride !== undefined || item.category === 'network-rack' ? undefined : item.cooling?.airflowCurve,
        flowScale: flowOverride !== undefined || item.category === 'network-rack' ? 1 : Math.max(0.4, lf),
        recirculation: blanking ? 0 : RECIRCULATION_NO_BLANKING,
        inlet,
        exhaust,
        fallbackCells: inlet.faces.length && exhaust.faces.length ? new Int32Array(0) : neighborCells(box),
      });
      if (!inlet.faces.length || !exhaust.faces.length) warnings.push(`${inst.tag}: inlet or exhaust face is blocked — heat released without airflow`);
    } else if (COOLER_CATEGORIES.has(item.category)) {
      const fa = frontAxis(inst.rotationDeg);
      const nk = box.k1 - box.k0 + 1;
      const supply = makeFaceSet(box, fa.axis, fa.sign, box.k0, box.k0 + Math.max(0, Math.ceil(SUPPLY_FRACTION * nk) - 1));
      let sinkCells = new Int32Array(0);
      let returnFaces: FaceSet | null = null;
      if (ceilingK > 0 && options.coolerReturn !== 'top') {
        const out: number[] = [];
        for (let j = box.j0; j <= box.j1; j++) for (let i = box.i0; i <= box.i1; i++) out.push(cell(i, j, ceilingK));
        sinkCells = Int32Array.from(out);
      } else {
        returnFaces = makeFaceSet(box, 2, 1, 0, 0);
      }
      coolers.push({
        id: inst.id,
        tag: inst.tag,
        catalogId: item.id,
        capacityKW: (item.capacity?.coolingKW ?? 0) * Math.max(0, options.roomCoolerScale ?? 1),
        maxAirflowM3s: (item.capacity?.airflowM3s ?? 0) * Math.max(0, options.roomCoolerScale ?? 1),
        supply,
        sinkCells,
        returnFaces,
        virtual: false,
      });
      if (!supply.faces.length) warnings.push(`${inst.tag}: CRAH supply face is blocked`);
    } else if (item.category === 'cdu') {
      // in-row CDU electrical/pump cabinet: pump & drive losses leave front-to-back with the
      // cabinet fans (sized for the design ΔT) instead of heating stagnant air above the unit
      const kw = overrides[inst.id] ?? (item.power?.nameplateKW ?? 0) * 0.15 * Math.max(0.5, lf);
      if (kw > 0) {
        const fa = frontAxis(inst.rotationDeg);
        const inlet = makeFaceSet(box, fa.axis, fa.sign, box.k0, box.k1);
        const exhaust = makeFaceSet(box, fa.axis, fa.sign > 0 ? -1 : 1, box.k0, box.k1);
        if (inlet.faces.length && exhaust.faces.length) {
          racks.push({
            id: inst.id,
            tag: inst.tag,
            catalogId: item.id,
            airKW: kw,
            nominalAirflowM3s: (kw * 1000) / (RHO_AIR * CP_AIR * DESIGN_DELTA_T),
            flowScale: 1,
            recirculation: 0,
            inlet,
            exhaust,
            fallbackCells: new Int32Array(0),
            aux: true,
          });
        } else {
          const cells = neighborCells(box);
          if (cells.length) heatSources.push({ id: inst.id, tag: inst.tag, cells, watts: kw * 1000 });
        }
      }
    } else if (overrides[inst.id] !== undefined && overrides[inst.id] > 0) {
      const cells = neighborCells(box);
      if (cells.length) heatSources.push({ id: inst.id, tag: inst.tag, cells, watts: overrides[inst.id] * 1000 });
    }
  }

  // ── T4: in-row coolers — supply from the front (cold-aisle) face, return through the rear (hot-aisle) face ──
  for (const { spec, box } of inRowBoxes) {
    const fa = frontAxis(spec.rotationDeg);
    const supply = makeFaceSet(box, fa.axis, fa.sign, box.k0, box.k1);
    const returnFaces = makeFaceSet(box, fa.axis, fa.sign > 0 ? -1 : 1, box.k0, box.k1);
    coolers.push({
      id: spec.id,
      tag: spec.tag ?? spec.id,
      catalogId: 'in-row',
      capacityKW: spec.capacityKW,
      maxAirflowM3s: spec.airflowM3s,
      supply,
      sinkCells: new Int32Array(0),
      returnFaces,
      virtual: false,
      kind: 'in-row',
    });
    if (!supply.faces.length || !returnFaces.faces.length) warnings.push(`${spec.tag ?? spec.id}: in-row cooler supply or return face is blocked`);
  }

  // ── T4: rear-door heat exchangers (removal at the rack exhaust face) ──
  const rdhx = options.rdhx;
  if (rdhx && (rdhx.doorKW !== undefined || rdhx.fraction !== undefined)) {
    const ids = rdhx.rackIds ? new Set(rdhx.rackIds) : null;
    for (const r of racks) {
      if (r.aux || (ids && !ids.has(r.id))) continue;
      if (rdhx.doorKW !== undefined) r.doorKW = Math.max(0, rdhx.doorKW);
      if (rdhx.fraction !== undefined) r.doorFraction = clamp(rdhx.fraction, 0, 1);
    }
  } else if (!rdhx) {
    // polish v2 2차: doors placed with "Place with this topology" live in the rack meta (rated kW) — simulate them as designed
    const byId = new Map(project.equipment.map((e) => [e.id, e]));
    for (const r of racks) {
      if (r.aux) continue;
      const kw = Number(byId.get(r.id)?.meta?.rdhxDoorKW ?? 0);
      if (kw > 0) r.doorKW = kw;
    }
  }

  // ── T4: liquid-to-air sidecars (rack liquid heat + sidecar fans rejected to room air) ──
  const sc = options.sidecars;
  if (sc) {
    const ids = sc.rackIds ? new Set(sc.rackIds) : null;
    const fanPerKW = Math.max(0, sc.fanKWPerKW);
    const flowPerKW = Math.max(0, sc.airflowPerKW);
    const served = new Set<string>();
    for (const { spec, box } of sidecarBoxes) {
      let liq = 0;
      for (const id of spec.rackIds) {
        const l = rackLiquidKW.get(id) ?? 0;
        if ((ids && !ids.has(id)) || served.has(id) || l <= 0) continue;
        liq += l;
        served.add(id);
      }
      if (liq <= 0) continue;
      const kw = liq * (1 + fanPerKW);
      const tag = spec.tag ?? spec.id;
      const fa = frontAxis(spec.rotationDeg);
      const inlet = makeFaceSet(box, fa.axis, fa.sign, box.k0, box.k1);
      const exhaust = makeFaceSet(box, fa.axis, fa.sign > 0 ? -1 : 1, box.k0, box.k1);
      if (inlet.faces.length && exhaust.faces.length) {
        racks.push({
          id: spec.id,
          tag,
          catalogId: 'sidecar-l2a',
          airKW: kw,
          nominalAirflowM3s: Math.max(liq * flowPerKW, (kw * 1000) / (RHO_AIR * CP_AIR * 60)),
          flowScale: 1,
          recirculation: 0,
          inlet,
          exhaust,
          fallbackCells: new Int32Array(0),
          aux: true,
        });
      } else {
        const cells = neighborCells(box);
        if (cells.length) heatSources.push({ id: spec.id, tag, cells, watts: kw * 1000 });
        warnings.push(`${tag}: sidecar inlet or exhaust face is blocked — heat released without airflow`);
      }
    }
    // racks without an explicit cabinet reject the liquid heat co-located at their own exhaust
    for (const r of racks) {
      if (r.aux || served.has(r.id) || (ids && !ids.has(r.id))) continue;
      const liq = rackLiquidKW.get(r.id) ?? 0;
      if (liq <= 0) continue;
      r.airKW += liq * (1 + fanPerKW);
      r.extraAirflowM3s = (r.extraAirflowM3s ?? 0) + liq * flowPerKW;
    }
  }

  // No cooler inside the domain (e.g. a region crop): supply through the side boundaries
  // below 2 m and return through the top layer, so heat still has a way out.
  if (coolers.length === 0) {
    const faces: number[] = [];
    const cells: number[] = [];
    const signs: number[] = [];
    const kMax = Math.max(1, Math.min(nz - 1, Math.round(2.0 / h)));
    for (let k = 0; k < kMax; k++) {
      for (let j = 0; j < ny; j++) {
        for (const [i, nbI, s] of [
          [0, 0, 1],
          [nx, nx - 1, -1],
        ] as const) {
          const nb = cell(nbI, j, k);
          if (solid[nb]) continue;
          const f = uIdx(i, j, k);
          flagU[f] = FLAG_FIXED;
          faces.push(f);
          cells.push(nb);
          signs.push(s);
        }
      }
    }
    // x-boundaries only keep the FaceSet single-axis; y-boundaries are handled as a second virtual unit
    const sinkTop: number[] = [];
    const ktop = ceilingK > 0 ? nz - 1 : nz - 1;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (!solid[cell(i, j, ktop)]) sinkTop.push(cell(i, j, ktop));
    // split into two single-sign face sets (west supplies +x, east supplies −x)
    const west = faces.filter((_, n) => signs[n] > 0);
    const westCells = cells.filter((_, n) => signs[n] > 0);
    const east = faces.filter((_, n) => signs[n] < 0);
    const eastCells = cells.filter((_, n) => signs[n] < 0);
    const half = Math.floor(sinkTop.length / 2);
    coolers.push({
      id: 'virtual-west',
      tag: 'Virtual supply (W boundary)',
      catalogId: 'virtual',
      capacityKW: 1e9,
      maxAirflowM3s: 0,
      supply: { axis: 0, sign: 1, faces: Int32Array.from(west), cells: Int32Array.from(westCells) },
      sinkCells: Int32Array.from(sinkTop.slice(0, half)),
      returnFaces: null,
      virtual: true,
    });
    coolers.push({
      id: 'virtual-east',
      tag: 'Virtual supply (E boundary)',
      catalogId: 'virtual',
      capacityKW: 1e9,
      maxAirflowM3s: 0,
      supply: { axis: 0, sign: -1, faces: Int32Array.from(east), cells: Int32Array.from(eastCells) },
      sinkCells: Int32Array.from(sinkTop.slice(half)),
      returnFaces: null,
      virtual: true,
    });
    warnings.push('no CRAH inside the thermal domain — virtual boundary supply/return used');
  }

  // ── 6. connected air volumes (pressure compatibility) ───────────────────────────
  const parent = new Int32Array(N);
  for (let n = 0; n < N; n++) parent[n] = n;
  const find = (a: number) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) if (flagU[uIdx(i, j, k)] === FLAG_OPEN) union(cell(i - 1, j, k), cell(i, j, k));
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) if (flagV[vIdx(i, j, k)] === FLAG_OPEN) union(cell(i, j - 1, k), cell(i, j, k));
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) if (flagW[wIdx(i, j, k)] === FLAG_OPEN) union(cell(i, j, k - 1), cell(i, j, k));
  const component = new Int32Array(N).fill(-1);
  const rootToComp = new Map<number, number>();
  const anchors: number[] = [];
  for (let n = 0; n < N; n++) {
    if (solid[n]) continue;
    const r = find(n);
    let c = rootToComp.get(r);
    if (c === undefined) {
      c = anchors.length;
      rootToComp.set(r, c);
      anchors.push(n);
    }
    component[n] = c;
  }
  for (const r of racks) {
    if (r.inlet.cells.length && r.exhaust.cells.length && component[r.inlet.cells[0]] !== component[r.exhaust.cells[0]]) {
      warnings.push(`${r.tag}: inlet and exhaust are in disconnected air volumes`);
    }
  }
  for (const c of coolers) {
    const ret = c.sinkCells.length ? c.sinkCells[0] : c.returnFaces?.cells[0];
    if (c.supply.cells.length && ret !== undefined && component[c.supply.cells[0]] !== component[ret]) {
      warnings.push(`${c.tag}: supply and return are in disconnected air volumes`);
    }
  }

  return {
    grid: { nx, ny, nz, cellSize: h, origin: { x: ox, y: oy, z: 0 } },
    options,
    hallId: hall.id,
    clearHeight: hall.clearHeight,
    ceilingK,
    supplyC,
    solid,
    flagU,
    flagV,
    flagW,
    racks,
    coolers,
    heatSources,
    containments,
    component,
    componentCount: anchors.length,
    anchors: Int32Array.from(anchors),
    warnings,
  };
}
