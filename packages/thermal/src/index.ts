export type {
  ThermalOptions,
  ThermalGrid,
  RackThermal,
  CoolerThermal,
  ThermalMetrics,
  ThermalResult,
  ThermalWorkerRequest,
  ThermalWorkerResponse,
  InRowCoolerSpec,
  RdhxOptions,
  SidecarOptions,
  SidecarUnitSpec,
} from './types.ts';
export { buildThermalVariant, type ThermalVariant, type ThermalVariantNote } from './variants.ts';
export type { ThermalCase, ThermalRack, ThermalCooler, ThermalHeatSource, ThermalContainmentZone, FaceSet, CellBox } from './case.ts';
export { buildThermalCase, RHO_AIR, CP_AIR, NETWORK_RACK_AIR_KW } from './case.ts';
export { ThermalSolver } from './solver.ts';
export { runThermal, handleThermalWorkerMessage } from './run.ts';
export { zoneStats, sampleTemperature, type ZoneBox, type ZoneStats } from './zones.ts';
export { thermalSnapshotFromResult, appendThermalSnapshot, SNAPSHOT_HEIGHTS_M } from './snapshot.ts';
