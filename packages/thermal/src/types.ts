import type { Rect } from '../../core/src/index.ts';

/**
 * In-row cooler boundary condition (T4, r2-platform.md §2.3 C): a cabinet inside the row line that takes air from
 * its rear (hot-aisle) face and supplies conditioned air from its front (cold-aisle) face.
 * Removal Q = min(capacityKW, ṁ·c_p·(T̄_return − T_supply)); airflow ≤ airflowM3s.
 */
export interface InRowCoolerSpec {
  id: string;
  tag?: string;
  /** plan footprint, hall-local meters */
  rect: Rect;
  /** cabinet height (default 2.0 m) */
  heightM?: number;
  /** front (supply) direction, equipment convention: 0 → +Y, 90 → −X, 180 → −Y, 270 → +X */
  rotationDeg: 0 | 90 | 180 | 270;
  capacityKW: number;
  airflowM3s: number;
}

/**
 * Rear-door heat exchanger (T4, r2-platform.md §2.3 E): heat removed at the rack exhaust face before the air reaches
 * the aisle, `airKW_eff = airKW − Q_door`, Q_door = min(airKW, doorKW, fraction·airKW). Active door: rack airflow unchanged.
 */
export interface RdhxOptions {
  /** rated capacity per door (kW) */
  doorKW?: number;
  /** fraction of the rack air-side heat removed (0..1) */
  fraction?: number;
  /** racks with a door (default: every rack in the domain) */
  rackIds?: string[];
}

/** An explicit liquid-to-air sidecar cabinet (solid, front intake / rear exhaust like a rack). */
export interface SidecarUnitSpec {
  id: string;
  tag?: string;
  rect: Rect;
  heightM?: number;
  rotationDeg: 0 | 90 | 180 | 270;
  /** racks whose liquid heat this cabinet rejects */
  rackIds: string[];
}

/**
 * Liquid-to-air sidecars (T4, r2-platform.md §2.3 D): the liquid share of rack heat (+ sidecar fan power) is rejected
 * to room air. Racks served by an explicit `units` cabinet reject it there; the others reject it co-located at their
 * own exhaust face with the sidecar airflow added to the rack airflow.
 */
export interface SidecarOptions {
  /** racks cooled by sidecars (default: every rack with liquidFraction > 0) */
  rackIds?: string[];
  /** sidecar airflow per kW of liquid heat (m³/s per kW) */
  airflowPerKW: number;
  /** sidecar fan input per kW of liquid heat (kW/kW) */
  fanKWPerKW: number;
  units?: SidecarUnitSpec[];
}

export interface ThermalOptions {
  hallId: string;
  /** cubic cell size in meters (default 0.3) */
  cellSize: number;
  /** IT utilization 0..1 applied to rack heat (EquipmentInstance.loadFactor overrides per rack) */
  loadFactor: number;
  /** CRAH supply air temperature (defaults to project.cooling.supplyAirC) */
  supplyAirC?: number;
  /** pseudo-time steps (default 600) */
  maxSteps?: number;
  /** convergence tolerance, °C change per step of rack inlets / cooler returns (default 0.01) */
  tolerance?: number;
  /** restrict the domain to a plan sub-rectangle of the hall (hall-local meters) */
  region?: Rect;
  /** model the ceiling return plenum (default true when hall.ceilingPlenumHeight > 0) */
  includePlenum?: boolean;
  overrides?: { containment?: 'as-designed' | 'none'; blanking?: boolean };
  /** per-equipment air-side heat override in kW, keyed by EquipmentInstance.id */
  airHeatOverridesKW?: Record<string, number>;
  /** per-equipment airflow override in m³/s (replaces the catalog airflow curve and fan scaling) */
  airflowOverridesM3s?: Record<string, number>;
  /** CRAH airflow as a multiple of the IT airflow demand (default 1.1), capped by unit capacity */
  coolerAirflowRatio?: number;
  /** CRAH return path: ducted to the ceiling plenum (default when a plenum exists) or through the unit top in the room */
  coolerReturn?: 'plenum' | 'top';
  /** extra open areas in the suspended ceiling (return grilles, open ceiling zones) as hall-local plan rectangles */
  ceilingOpenings?: Rect[];
  // ── v2 2차 (T4) cooling-topology boundary conditions ──
  /** in-row coolers (return from the hot-aisle face, supply into the cold aisle) */
  inRowCoolers?: InRowCoolerSpec[];
  /** rear-door heat exchangers on racks */
  rdhx?: RdhxOptions;
  /** liquid-to-air sidecars (rack liquid heat to room air) */
  sidecars?: SidecarOptions;
  /** 'none' drops the hall's CRAHs / fan walls from the domain (e.g. an in-row-only variant) */
  roomCoolers?: 'as-designed' | 'none';
  /** multiplies the capacity and max airflow of the hall's CRAHs / fan walls (e.g. an L2A variant whose room system must carry all rack heat) */
  roomCoolerScale?: number;
}

export interface ThermalGrid {
  nx: number;
  ny: number;
  nz: number;
  cellSize: number;
  origin: { x: number; y: number; z: number };
}

export interface RackThermal {
  id: string;
  tag: string;
  inletAvgC: number;
  inletMaxC: number;
  exhaustC: number;
  airKW: number;
  airflowM3s: number;
  /** heat removed by the rear door (kW, T4) */
  doorKW?: number;
}

export interface CoolerThermal {
  id: string;
  tag: string;
  returnC: number;
  supplyC: number;
  loadKW: number;
  capacityKW: number;
  airflowM3s: number;
  /** T4: room unit (CRAH / fan wall / virtual) or in-row cooler */
  kind?: 'room' | 'in-row';
}

export interface ThermalMetrics {
  step: number;
  residual: number;
  converged: boolean;
  elapsedMs: number;
  racks: RackThermal[];
  coolers: CoolerThermal[];
  maxInletC: number;
  avgInletC: number;
  /** Rack Cooling Index (high side), % — 100 = no intake above 27 °C (ASHRAE recommended) */
  rciHi: number;
  /** Rack Cooling Index (low side), % — 100 = no intake below 18 °C */
  rciLo: number;
  /** Return Temperature Index, % — 100 = no bypass / no recirculation imbalance */
  rti: number;
  /** Supply Heat Index (0..1) — share of heat picked up by supply air before rack intakes */
  shi: number;
  /** heat released to room air (rack exhaust after doors, aux units, static sources), kW */
  airHeatKW: number;
  /** heat removed by air coolers (room + in-row), kW */
  removedKW: number;
  /** (airHeat − removed) / airHeat */
  balanceError: number;
  hotspots: { x: number; y: number; z: number; tempC: number }[];
  /** T4: heat removed at rack rear doors (water side, not part of airHeat/removed), kW */
  doorRemovedKW?: number;
  /** T4: mean air temperature inside the hot-aisle containment zones (floor to containment height), °C */
  hotAisleAvgC?: number;
}

export interface ThermalResult {
  grid: ThermalGrid;
  /** °C per cell, index = i + nx*(j + ny*k) */
  temperature: Float32Array;
  /** m/s, cell-centered, xyz interleaved in plan axes (x, y, up) */
  velocity: Float32Array;
  /** 1 = solid (equipment, columns, CRAH return ducts) */
  solid: Uint8Array;
  metrics: ThermalMetrics;
  options: ThermalOptions;
}

export type ThermalWorkerRequest =
  | {
      type: 'run';
      jobId: string;
      project: import('../../core/src/index.ts').Project;
      options: ThermalOptions;
      snapshotEvery?: number;
      /** server / web catalog library so the worker's own core instance resolves library racks (builtin ∪ library ∪ project) */
      library?: import('../../core/src/index.ts').CatalogLibrary | null;
    }
  | { type: 'cancel'; jobId: string };

export type ThermalWorkerResponse =
  | { type: 'progress'; jobId: string; metrics: ThermalMetrics; snapshot?: ThermalResult }
  | { type: 'done'; jobId: string; result: ThermalResult }
  | { type: 'error'; jobId: string; message: string };
