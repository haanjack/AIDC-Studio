import type { PowerScenarioResult, Project, ProjectAnalysis } from '@aidc/core';

export interface ViewerOverlays {
  containment: boolean;
  ceiling: boolean;
  labels: boolean;
  cables: boolean;
  trays: boolean;
  thermal: {
    mode: 'off' | 'slice' | 'volume' | 'both';
    axis: 'x' | 'y' | 'z';
    /** m along axis, hall-local */
    position: number;
    opacity: number;
    rangeC: [number, number];
  };
  airflow: boolean;
  heatmapFloor: boolean;
  /** v2 2차 (T3): 3D power plane (busway A/B · tap-offs · RPP · feeders); absent = off */
  powerPaths?: boolean;
}

export type ColorMode = 'realistic' | 'category' | 'power' | 'inlet-temp' | 'wave' | 'network-role';

/**
 * Regular voxel field. index = i + nx*(j + ny*k); i→plan x, j→plan y, k→up.
 * origin = min corner in hall-local plan meters (z = height above floor).
 */
export interface ScalarField {
  grid: { nx: number; ny: number; nz: number; cellSize: number; origin: { x: number; y: number; z: number } };
  temperature: Float32Array | Uint8Array;
  /** required when temperature is Uint8 quantized: value = min + (u8/255)*(max-min) */
  tempRange?: [number, number];
  /** interleaved (vx plan x, vy plan y, vz up) */
  velocity?: Float32Array | Int8Array;
  /** m/s per int8 unit */
  velocityScale?: number;
  /** 1 = solid */
  solid?: Uint8Array;
}

/** Camera pose in hall-local plan coordinates (x, y plan metres; z height above floor). yaw° = 0 looks toward +X, 90 toward +Y (CCW); pitch° > 0 looks up. */
export interface CameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

export type CameraMode = 'orbit' | 'fly';

export interface EquipmentMove {
  id: string;
  position: { x: number; y: number };
}

export interface ViewerApi {
  screenshot(): string;
  exportGlb(): Promise<ArrayBuffer>;
  focusEquipment(id: string): void;
  /** S4 fly camera: move the camera to a pose (instant when dur = 0; default short glide). Works in orbit and fly mode. */
  flyTo(pose: Partial<CameraPose>, dur?: number): void;
  getCameraPose(): CameraPose;
}

/** Single declaration — the store re-exports this type (S4). 'eye' = 1.7 m eye height in the cold aisle. */
export type CameraPreset = 'iso' | 'top' | 'aisle' | 'hot-aisle' | 'overview' | 'eye';

export interface Viewer3DProps {
  project: Project;
  hallId: string;
  analysis?: ProjectAnalysis | null;
  field?: ScalarField | null;
  /** plan offset added to field.grid.origin */
  fieldAnchor?: { x: number; y: number };
  /** Physical CRAH return topology shown by the design airflow overlay. */
  airReturnMode?: 'plenum' | 'top';
  overlays: ViewerOverlays;
  colorMode: ColorMode;
  rackValues?: Record<string, number>;
  rackValueRange?: [number, number];
  selection: string[];
  onSelect: (id: string | null, additive: boolean) => void;
  editMode?: boolean;
  /** One callback per drag so a multi-selection move becomes one undoable project edit. */
  onMoveEquipment?: (moves: EquipmentMove[]) => void;
  cameraPreset?: CameraPreset;
  cameraNonce?: number;
  /** 'orbit' supports horizontal WASD pan; 'fly' = WASD/QE walkthrough with mouse look. */
  cameraMode?: CameraMode;
  showStats?: boolean;
  onReady?: (api: ViewerApi) => void;
  /** v2 2차 (T3): active power scenario result (run colours, rack states) and ids highlighted from the power panel / one-line */
  powerScenario?: PowerScenarioResult | null;
  powerHighlightIds?: string[];
}

export const DEFAULT_OVERLAYS: ViewerOverlays = {
  containment: true,
  ceiling: false,
  labels: true,
  cables: false,
  trays: true,
  thermal: { mode: 'off', axis: 'z', position: 1.2, opacity: 0.85, rangeC: [20, 45] },
  airflow: false,
  heatmapFloor: false,
};
