// r4 stream C: what the drawlist worker hands the 2D pane (structured-clone safe; the packed list's typed arrays are transferred).
import type { Annotation2D, Datum, DrawingCut, DrawingUnits, ElevationTarget, Locale, PackedDrawList, PrimEmitter, Project, ProjectAnalysis, Rect, RowGroup, SectionDepthPreset, Space2D } from '@aidc/core';

/** The prim fields the 2D view needs for styling, hover cards, selection and snapping (not the whole Prim). */
export interface PrimInfo {
  emitter: PrimEmitter;
  category?: string;
  system?: string;
  tag?: string;
  refId?: string;
  rowId?: string;
  podId?: string;
  tier?: string;
  layer?: string;
  /** vertical extent (m) */
  z0?: number;
  z1?: number;
  meta?: Record<string, string | number | boolean>;
}

/** A clearance / clash finding from the wall audit (layout/wallAudit.ts), located for the 2D view. */
export interface ClearanceMark {
  id: string;
  check: string;
  /** plan position (m) */
  x: number;
  y: number;
  z: number;
  depthM?: number;
}

export interface Scene2D {
  /** request key the scene answers */
  key: string;
  space: Space2D;
  hallId: string;
  packed: PackedDrawList;
  ann: Annotation2D[];
  prims: Record<string, PrimInfo>;
  datums: Datum[];
  rows: RowGroup[];
  /** hall interior rect (plan) */
  hallRect: Rect;
  cut?: DrawingCut;
  elevation?: ElevationTarget;
  /** section: depth actually used (m) */
  depthM?: number;
  /** plan: depth window of each requested cut (m) */
  cutDepths?: Record<string, number>;
  clearance: ClearanceMark[];
  /** the wall audit was not cached when the scene was built: `clearance` follows in a 'clearance' message (backlog T2 #6) */
  auditPending?: boolean;
  ms: { prims: number; project: number; annotate: number; audit: number; pack: number; total: number };
  counts: { prims: number; items: number; ann: number };
}

export interface BuildRequest {
  type: 'build';
  key: string;
  hallId: string;
  space: Space2D;
  cut?: DrawingCut;
  elevation?: ElevationTarget;
  depth?: SectionDepthPreset;
  units: DrawingUnits;
  locale: Locale;
  /** plan: cuts whose depth windows the overlay draws */
  cuts?: DrawingCut[];
}

export interface ExportSvgRequest {
  type: 'export-svg';
  key: string;
  build: BuildRequest;
  /** visible world rect and the pane size (CSS px) */
  world: Rect;
  widthPx: number;
  heightPx: number;
  layers: string[] | null;
  lod: 0 | 1 | 2 | 3;
  title: string;
}

export type DrawlistWorkerRequest =
  | { type: 'project'; gen: number; project: Project; analysis: ProjectAnalysis | null }
  | BuildRequest
  | ExportSvgRequest;

export type DrawlistWorkerResponse =
  | { type: 'scene'; gen: number; scene: Scene2D }
  | { type: 'svg'; gen: number; key: string; svg: string }
  | { type: 'clearance'; gen: number; key: string; clearance: ClearanceMark[]; auditMs: number }
  | { type: 'error'; gen: number; key: string; message: string };
