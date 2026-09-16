import { create } from 'zustand';
import {
  addHall as addHallToProject, analyzeProject, createReferenceProject, defaultSpinePlacement, duplicateHall as duplicateHallInProject, removeHall as removeHallFromProject,
  renameHall as renameHallInProject, resolveCatalog, setActiveCatalog,
  type CatalogLibrary, type GrowthPattern, type Locale, type NewHallOptions, type Project, type ProjectAnalysis, type SizingSuggestion,
  type ProjectLock, type ProjectVersion,
} from '@aidc/core';
import { detectUiLocale, type UiLocale } from '../i18n/locale.ts';
import { t as tUi } from '../i18n/index.ts';
import type { PowerScenario } from '@aidc/core';
import { normalizeLoadedProject, upgradeProject } from '@aidc/core';
import { hallThermalDrop, hallThermalRestore, withHallThermal } from './hallThermalUndo.ts';
import type { ThermalMetrics, ThermalOptions, ThermalResult, ThermalWorkerRequest, ThermalWorkerResponse } from '@aidc/thermal';
import { appendThermalSnapshot, thermalSnapshotFromResult } from '@aidc/thermal';
import type { CameraMode, CameraPreset, ColorMode, ViewerApi, ViewerOverlays } from '../viewer/index.ts';
import { api, type ProjectListItem, type TrashEntry } from '../app/api.ts';
// v2-2 project management helpers (pure)
import { apiErrorInfo, pickFallbackProject } from '../app/projectMenu.ts';
import { createView2dSlice, type View2DSlice } from '../view2d/store.ts';

export type PageId = 'overview' | 'workload' | 'architecture' | 'site' | 'layout' | 'power' | 'network' | 'cooling' | 'cost' | 'schedule' | 'drawings' | 'docs' | 'catalog';
/** Single CameraPreset declaration lives in viewer/types.ts (S4); re-exported here for existing importers. */
export type { CameraPreset, CameraMode } from '../viewer/index.ts';

export const DEFAULT_VIEW_OVERLAYS: ViewerOverlays = {
  containment: true,
  ceiling: false,
  labels: true,
  cables: false,
  trays: true,
  thermal: { mode: 'off', axis: 'z', position: 1.2, opacity: 0.85, rangeC: [20, 45] },
  airflow: false,
  heatmapFloor: false,
};

export interface ThermalScenario {
  id: string;
  name: string;
  options: ThermalOptions;
  metrics: ThermalMetrics;
  at: string;
}

interface ThermalState {
  status: 'idle' | 'running' | 'done' | 'error' | 'cancelled';
  jobId: string | null;
  options: ThermalOptions;
  history: { step: number; residual: number; maxInletC: number }[];
  metrics: ThermalMetrics | null;
  result: ThermalResult | null;
  error: string | null;
  scenarios: ThermalScenario[];
}


export interface AppState {
  project: Project;
  past: Project[];
  future: Project[];
  dirty: boolean;
  savedAt: string | null;
  serverOnline: boolean;
  analysis: ProjectAnalysis | null;
  analysisError: string | null;
  analysisMs: number;
  hallId: string;
  page: PageId;
  selection: string[];
  editMode: boolean;
  overlays: ViewerOverlays;
  colorMode: ColorMode;
  cameraPreset: CameraPreset;
  cameraNonce: number;
  /** S4 fly camera (PROPOSAL-v2 §3.9): 'orbit' | 'fly' */
  cameraMode: CameraMode;
  panelWide: boolean;
  viewerApi: ViewerApi | null;
  thermal: ThermalState;
  toast: { id: number; kind: 'info' | 'error' | 'ok'; text: string } | null;
  /** S1 fit-to-space preview: a scratch project shown in the 3D viewer instead of `project` (null = none) */
  previewProject: Project | null;
  projects: ProjectListItem[];

  init(): Promise<void>;
  refreshProjects(): Promise<void>;
  /** `skipSave`: do not flush the current project first (it was deleted) */
  openProject(id: string, opts?: { skipSave?: boolean }): Promise<void>;
  // ── v2-2 project management (apps/web/src/ui/ProjectMenu.tsx) ──
  /** the server supports recoverable deletes + name rules (health feature 'project-trash'); false offline / on an older server */
  projectAdmin: boolean;
  /** recently deleted projects (server trash) */
  trash: TrashEntry[];
  refreshTrash(): Promise<void>;
  /** backlog T3 (8): permanently delete every trash entry, or entries deleted more than `olderThanDays` days ago */
  purgeTrash(olderThanDays?: number): Promise<{ ok: true; removed: number } | { ok: false; message: string }>;
  /** create from a template (or a copy of the current project) and open it */
  newProject(opts: { name: string; template: 'reference' | 'empty' | 'nvidia-reference' | 'copy'; preset?: string }): Promise<ProjectActionResult>;
  /** copy the CURRENT in-memory project with these overrides into a new project and open it; the original is not changed */
  saveAsNewProject(opts: { name: string; client?: string; description?: string; siteName?: string; siteLocation?: string }): Promise<ProjectActionResult>;
  /** move a project to the server trash; when it is the open project, open the most recently saved remaining one */
  deleteProject(id: string): Promise<ProjectActionResult>;
  /** restore a trash entry and open it */
  restoreProject(entry: string): Promise<ProjectActionResult>;
  /** the open project was deleted elsewhere (404 on save / gone from the list) → toast + switch */
  handleProjectGone(id: string): Promise<void>;
  /** false when the edit was blocked (read-only while someone else holds the edit lock) */
  update(mutator: (draft: Project) => void, opts?: { history?: boolean }): boolean;
  replaceProject(p: Project): void;
  undo(): void;
  redo(): void;
  runAnalysis(): void;
  save(): Promise<void>;
  setPage(p: PageId): void;
  setHall(id: string): void;
  select(id: string | null, additive?: boolean): void;
  setSelection(ids: string[]): void;
  setEditMode(v: boolean): void;
  setOverlays(patch: Partial<ViewerOverlays>): void;
  setThermalOverlay(patch: Partial<ViewerOverlays['thermal']>): void;
  setColorMode(m: ColorMode): void;
  setCamera(p: CameraPreset): void;
  setCameraMode(m: CameraMode): void;
  setPanelWide(v: boolean): void;
  setViewerApi(api: ViewerApi): void;
  setThermalOptions(patch: Partial<ThermalOptions>): void;
  startThermal(): void;
  cancelThermal(): void;
  saveThermalScenario(name: string): void;
  removeThermalScenario(id: string): void;
  notify(text: string, kind?: 'info' | 'error' | 'ok'): void;
  setPreviewProject(p: Project | null): void;
  // v2 project fields (DECISIONS-v2 #1, #10)
  /** deliverable language written to project.locale (default 'en') */
  setLocale(locale: Locale): void;
  /** build-out pattern written to project.growth (default 'phased') */
  setGrowth(growth: GrowthPattern): void;
  // S3: server-global catalog library
  /** bumps whenever `libraryCache` changes so catalog consumers re-render */
  libraryVersion: number;
  /** load the library (localStorage cache first, then GET /api/catalog/custom) and re-activate the catalog */
  loadLibrary(): Promise<void>;
  /** replace the library: PUT /api/catalog/custom when online, always cached in localStorage; re-activates + re-analyses.
   *  Offline saves mark the cache dirty and are pushed to the server by the next online `loadLibrary()` (never overwritten). */
  saveLibrary(lib: CatalogLibrary): Promise<void>;
  /** true when the browser cache holds library edits the server has not received yet */
  libraryDirty: boolean;
  /** replace the current server project with a fresh reference-hall template under the same id */
  resetProjectToTemplate(template: 'reference'): Promise<void>;
  // S2: workload-first sizing (WorkloadPanel '규모 산정' → LayoutPanel picks it up; not persisted in the project)
  sizingSuggestion: SizingSuggestion | null;
  setSizingSuggestion(s: SizingSuggestion | null): void;
  // ── v2 2차 contract placeholders ──
  /** T5: page panel collapsed (nav rail stays); persisted in localStorage['aidc:panelCollapsed'] */
  panelCollapsed: boolean;
  setPanelCollapsed(v: boolean): void;
  togglePanelCollapsed(): void;
  /** Catalog asks Platform & design units to preselect this GPU rack asset. */
  pendingArchitectureRackId: string | null;
  setPendingArchitectureRackId(id: string | null): void;
  /** Compute platform & design units asks Layout to open with one coherent template/platform/unit selection. */
  pendingGeneratorSetup: { templateId: string; platformId: string; pods: number } | null;
  setPendingGeneratorSetup(setup: { templateId: string; platformId: string; pods: number } | null): void;
  /** T5 → T1: catalog save card asks 배치 > 장비 추가 to preselect this catalog id (LayoutPanel consumes and clears it) */
  pendingAddCatalogId: string | null;
  setPendingAddCatalogId(id: string | null): void;
  /** T8: UI language (independent of project.locale, the deliverable language); default from navigator.language */
  uiLocale: UiLocale;
  setUiLocale(l: UiLocale): void;
  /** T8: LLM assistant drawer */
  assistantOpen: boolean;
  setAssistantOpen(v: boolean): void;
  /** T8: advisory project lock held by someone (null = none / unknown) */
  projectLock: ProjectLock | null;
  setProjectLock(l: ProjectLock | null): void;
  /** T8: saved version history of the current project */
  versions: ProjectVersion[];
  setVersions(v: ProjectVersion[]): void;
  /** T3: active power-plane scenario (null = normal state from analysis.power.paths) */
  powerScenario: PowerScenario | null;
  setPowerScenario(s: PowerScenario | null): void;
  /** T3: ids (busway circuits / busways / racks) highlighted in the 3D power overlay */
  powerHighlight: string[];
  setPowerHighlight(ids: string[]): void;
  // halls lifecycle (pure helpers in core layout/halls.ts; undoable through update; blocked read-only)
  /** new empty hall beside the others; returns its id (null when blocked) and selects it */
  addHall(opts?: NewHallOptions): string | null;
  renameHall(id: string, name: string): boolean;
  /** copy a hall (empty or with its layout); returns the new id and selects it */
  duplicateHall(id: string, withLayout: boolean): string | null;
  /** remove a hall with its equipment and references (never the last hall); drops that hall's thermal result / scenarios */
  removeHall(id: string): boolean;
  /** r4 stream C: in-app 2D view state + actions (view2d/store.ts; C → D hand-off `view2d.open`) */
  view2d: View2DSlice;
}

/** Effective locale of a project (v1 projects have no field → 'en'). */
export const projectLocale = (p: Project): Locale => p.locale ?? 'en';
/** Effective growth pattern of a project (v1 projects have no field → 'phased'). */
export const projectGrowth = (p: Project): GrowthPattern => p.growth ?? 'phased';

/**
 * Server/global catalog library cache (stream S3 fills it from GET /api/catalog). Empty placeholder for now;
 * `activateCatalog` publishes builtin ∪ library ∪ project.catalogExtensions so the viewer, panels and the
 * synchronous analysis all resolve the same ids.
 */
export const libraryCache: CatalogLibrary = { items: [], cables: [] };
function activateCatalog(p: Project) {
  setActiveCatalog(resolveCatalog(p, libraryCache));
}
const LIBRARY_KEY = 'aidc:catalogLibrary';
const LIBRARY_DIRTY_KEY = 'aidc:catalogLibraryDirty';
/** S3: replace the cache contents in place (the object identity is shared with activateCatalog). */
function setLibraryCache(lib: CatalogLibrary) {
  libraryCache.items = (lib.items ?? []).map((it) => ({ ...it, origin: 'library' as const }));
  libraryCache.cables = (lib.cables ?? []).map((c) => ({ ...c, origin: 'library' as const }));
}

const LOCAL_KEY = 'aidc:project';
const PANEL_COLLAPSED_KEY = 'aidc:panelCollapsed';
const UI_LOCALE_KEY = 'aidc:uiLocale';
const LAST_ID_KEY = 'aidc:lastProjectId';
const HISTORY_LIMIT = 60;

// backlog T3 (7): the removed hall's thermal result / scenarios belong to the undo snapshot — store/hallThermalUndo.ts


let analysisTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** re-analyse soon and autosave after 1.5 s of quiet — shared by update, undo and redo (fix v2 2차: undo / redo never saved) */
function scheduleSave(get: () => AppState) {
  clearTimeout(analysisTimer);
  analysisTimer = setTimeout(() => get().runAnalysis(), 120);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void get().save(), 1500);
}
let worker: Worker | null = null;
let initStarted = false;

// ─────────── v2-2 project management ───────────
export type ProjectActionResult = { ok: true; id?: string } | { ok: false; code?: string; message: string; suggestion?: string; holder?: string };
/** a create / delete / restore is switching projects — list polling must not treat the old id as "deleted elsewhere" */
let projectOpBusy = false;
let goneHandling = false;
function projectAdminBlocked(get: () => AppState): ProjectActionResult | null {
  if (!get().serverOnline) return { ok: false, code: 'offline', message: tUi('project.offlineTitle') };
  if (!get().projectAdmin) return { ok: false, code: 'unsupported', message: tUi('project.unsupportedTitle') };
  return null;
}
function projectActionError(e: unknown): ProjectActionResult {
  const info = apiErrorInfo(e);
  return { ok: false, code: info.code, message: info.message, suggestion: info.suggestion, holder: info.holder };
}

function safeLocal<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function defaultThermalOptions(project: Project, hallId: string): ThermalOptions {
  const hall = project.halls.find((h) => h.id === hallId);
  const hasReturnPlenum = (hall?.ceilingPlenumHeight ?? 0) > 0;
  return {
    hallId,
    cellSize: 0.3,
    loadFactor: 1,
    supplyAirC: project.cooling.supplyAirC,
    maxSteps: 600,
    tolerance: 0.01,
    includePlenum: hasReturnPlenum,
    coolerReturn: hasReturnPlenum ? 'plenum' : 'top',
    overrides: { containment: 'as-designed' },
  };
}

/**
 * T8 collaboration hooks (set by app/collab.ts; no import cycle): `beforeEdit` returns false to block update/undo/redo
 * while another person holds the project lock; `onSaveError` returns true when it handled a save failure (412 / 423).
 */
export const storeHooks: { beforeEdit?: () => boolean; onSaveError?: (e: Error, p: Project) => boolean } = {};

const initial = createReferenceProject().project;
activateCatalog(initial);

export const useApp = create<AppState>((set, get) => ({
  project: initial,
  past: [],
  future: [],
  dirty: false,
  savedAt: null,
  serverOnline: false,
  analysis: null,
  analysisError: null,
  analysisMs: 0,
  hallId: initial.halls[0].id,
  page: 'overview',
  view2d: createView2dSlice(set as unknown as Parameters<typeof createView2dSlice>[0], get as unknown as Parameters<typeof createView2dSlice>[1]),
  selection: [],
  editMode: false,
  overlays: DEFAULT_VIEW_OVERLAYS,
  colorMode: 'realistic',
  cameraPreset: 'iso',
  cameraNonce: 0,
  cameraMode: 'orbit',
  panelWide: false,
  viewerApi: null,
  thermal: {
    status: 'idle',
    jobId: null,
    options: defaultThermalOptions(initial, initial.halls[0].id),
    history: [],
    metrics: null,
    result: null,
    error: null,
    scenarios: [],
  },
  toast: null,
  previewProject: null,
  projects: [],
  projectAdmin: false,
  trash: [],

  async refreshProjects() {
    if (!get().serverOnline) return;
    try {
      const prev = get().projects;
      const list = await api.listProjects();
      set({ projects: list });
      // v2-2: the open project vanished from the server list → another client deleted it
      const cur = get().project.id;
      if (get().projectAdmin && !projectOpBusy && prev.some((p) => p.id === cur) && !list.some((p) => p.id === cur)) void get().handleProjectGone(cur);
    } catch {
      /* keep the previous list */
    }
    void get().refreshTrash();
  },

  async openProject(id, opts) {
    if (id === get().project.id) return;
    try {
      const p = await api.getProject(id);
      // v2-2: flush only real edits (a clean read-only project would otherwise PUT → 423 → conflict copy); never a deleted project
      if (!opts?.skipSave && get().dirty) await get().save();
      get().replaceProject(p);
      void get().refreshProjects();
    } catch (e) {
      get().notify(tUi('shell.toast.openFailed', { msg: (e as Error).message }), 'error');
    }
  },

  async init() {
    if (initStarted) return; // StrictMode double-invokes effects in dev
    initStarted = true;
    // analyze the local project right away so the UI never waits on the network
    get().runAnalysis();
    const online = await api.health();
    set({ serverOnline: online });
    if (online) set({ projectAdmin: (await api.features()).includes('project-trash') });
    void get().refreshProjects();
    void get().loadLibrary();
    let project: Project | null = null;
    if (online) {
      try {
        const list = await api.listProjects();
        const lastId = safeLocal(() => localStorage.getItem(LAST_ID_KEY), null);
        const pick = list.find((p) => p.id === lastId) ?? list[0];
        if (pick) project = await api.getProject(pick.id);
        else project = await api.createProject({ template: 'reference' });
      } catch (e) {
        get().notify(tUi('shell.toast.serverLoadFailed', { msg: (e as Error).message }), 'error');
      }
    }
    if (!project) {
      const raw = safeLocal(() => localStorage.getItem(LOCAL_KEY), null);
      if (raw) project = safeLocal(() => JSON.parse(raw) as Project, null);
    }
    if (project) get().replaceProject(project);
    else get().runAnalysis();
  },

  replaceProject(loaded) {
    // finish v2 2차: drop derived records of halls that no longer exist (normalised in memory; the file changes only on the next save)
    // stream A (P1): canonical template ids / enums + inferred standards profile (pure, idempotent)
    const p = normalizeLoadedProject(upgradeProject(loaded));
    const hallId = p.halls.find((h) => h.id === get().hallId)?.id ?? p.halls[0]?.id ?? '';
    safeLocal(() => localStorage.setItem(LAST_ID_KEY, p.id), undefined);
    activateCatalog(p);
    set({
      project: p,
      past: [],
      future: [],
      dirty: false,
      hallId,
      selection: [],
      thermal: { ...get().thermal, status: 'idle', result: null, metrics: null, history: [], options: defaultThermalOptions(p, hallId) },
    });
    get().runAnalysis();
  },

  update(mutator, opts) {
    if (storeHooks.beforeEdit && !storeHooks.beforeEdit()) return false; // T8: read-only while someone else holds the edit lock
    const prev = get().project;
    const draft = structuredClone(prev);
    mutator(draft);
    draft.updatedAt = new Date().toISOString();
    const history = opts?.history ?? true;
    activateCatalog(draft);
    set({
      project: draft,
      past: history ? [...get().past.slice(-HISTORY_LIMIT + 1), prev] : get().past,
      future: history ? [] : get().future,
      dirty: true,
    });
    scheduleSave(get);
    return true;
  },

  undo() {
    const { past, project, future } = get();
    if (!past.length) return;
    if (storeHooks.beforeEdit && !storeHooks.beforeEdit()) return; // T8 read-only
    const prev = past[past.length - 1];
    activateCatalog(prev);
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future], dirty: true, thermal: withHallThermal(get().thermal, prev) });
    get().runAnalysis();
    scheduleSave(get);
  },

  redo() {
    const { past, project, future } = get();
    if (!future.length) return;
    if (storeHooks.beforeEdit && !storeHooks.beforeEdit()) return; // T8 read-only
    const next = future[0];
    activateCatalog(next);
    set({ project: next, past: [...past, project], future: future.slice(1), dirty: true, thermal: withHallThermal(get().thermal, next) });
    get().runAnalysis();
    scheduleSave(get);
  },

  runAnalysis() {
    const t0 = performance.now();
    try {
      const analysis = analyzeProject(get().project);
      set({ analysis, analysisError: null, analysisMs: performance.now() - t0 });
    } catch (e) {
      set({ analysisError: (e as Error).message, analysisMs: performance.now() - t0 });
    }
  },

  async save() {
    const p = get().project;
    safeLocal(() => localStorage.setItem(LOCAL_KEY, JSON.stringify(p)), undefined);
    if (get().serverOnline) {
      try {
        await api.saveProject(p);
      } catch (e) {
        if (storeHooks.onSaveError?.(e as Error, p)) return; // T8: 412 revision conflict / 423 locked → conflict copy + reload
        // v2-2 project management: deleted by another client (404) · rename refused by the name rule (400 / 409)
        const info = apiErrorInfo(e);
        if (info.status === 404 && get().projectAdmin) {
          void get().handleProjectGone(p.id);
          return;
        }
        if (info.code?.startsWith('name-')) {
          const reason = tUi(info.code === 'name-taken' ? 'project.name.taken' : info.code === 'name-too-long' ? 'project.name.tooLong' : 'project.name.empty', { max: 120 });
          get().notify(tUi('project.toast.nameRejected', { name: p.name, reason }), 'error');
          return;
        }
        set({ serverOnline: false });
        get().notify(tUi('shell.toast.saveFailed', { msg: (e as Error).message }), 'error');
        return;
      }
    }
    set({ dirty: false, savedAt: new Date().toISOString() });
  },

  setPage(page) {
    const wideByDefault: PageId[] = ['architecture', 'power', 'cost', 'schedule', 'docs', 'workload', 'catalog', 'drawings'];
    set({ page, panelWide: wideByDefault.includes(page) });
  },
  setHall(hallId) {
    const hall = get().project.halls.find((h) => h.id === hallId);
    const hasReturnPlenum = (hall?.ceilingPlenumHeight ?? 0) > 0;
    set({ hallId, selection: [], thermal: { ...get().thermal, options: { ...get().thermal.options, hallId, includePlenum: hasReturnPlenum, coolerReturn: hasReturnPlenum ? 'plenum' : 'top' }, result: null, status: 'idle' } });
  },
  select(id, additive = false) {
    if (id === null) return set({ selection: [] });
    const cur = get().selection;
    if (additive) set({ selection: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
    else set({ selection: [id] });
  },
  setSelection(ids) {
    set({ selection: ids });
  },
  setEditMode(editMode) {
    set({ editMode });
  },
  setOverlays(patch) {
    set({ overlays: { ...get().overlays, ...patch } });
  },
  setThermalOverlay(patch) {
    const o = get().overlays;
    set({ overlays: { ...o, thermal: { ...o.thermal, ...patch } } });
  },
  setColorMode(colorMode) {
    set({ colorMode });
  },
  setCamera(cameraPreset) {
    set({ cameraPreset, cameraNonce: get().cameraNonce + 1 });
  },
  setCameraMode(cameraMode) {
    if (get().cameraMode === cameraMode) return;
    // entering fly mode drops to eye height in the cold aisle unless the user is already there
    set(cameraMode === 'fly' && get().cameraPreset !== 'eye' && get().cameraPreset !== 'aisle' && get().cameraPreset !== 'hot-aisle'
      ? { cameraMode, cameraPreset: 'eye', cameraNonce: get().cameraNonce + 1 }
      : { cameraMode });
  },
  setPanelWide(panelWide) {
    set({ panelWide });
  },
  setViewerApi(viewerApi) {
    set({ viewerApi });
  },

  setThermalOptions(patch) {
    const t = get().thermal;
    set({ thermal: { ...t, options: { ...t.options, ...patch, overrides: { ...t.options.overrides, ...patch.overrides } } } });
  },

  startThermal() {
    const { project, thermal } = get();
    if (!worker) {
      worker = new Worker(new URL('../workers/thermal.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (ev: MessageEvent<ThermalWorkerResponse>) => {
        const msg = ev.data;
        const t = get().thermal;
        if (msg.jobId !== t.jobId) return;
        if (msg.type === 'progress') {
          const history = [...t.history, { step: msg.metrics.step, residual: msg.metrics.residual, maxInletC: msg.metrics.maxInletC }].slice(-400);
          set({ thermal: { ...t, metrics: msg.metrics, history, result: msg.snapshot ?? t.result } });
        } else if (msg.type === 'done') {
          set({ thermal: { ...t, status: 'done', metrics: msg.result.metrics, result: msg.result } });
          // D2: persist a per-hall CFD-lite snapshot (inlet bottom / middle / top) for the rack elevation documents
          try {
            const hId = t.options.hallId ?? get().hallId;
            const res = msg.result;
            if (hId) get().update((d) => { d.thermalSnapshots = appendThermalSnapshot(d.thermalSnapshots, thermalSnapshotFromResult(d, hId, res, new Date().toISOString())); }, { history: false });
          } catch { /* snapshot is optional */ }
          get().notify(tUi('shell.toast.thermalDone', { c: msg.result.metrics.maxInletC.toFixed(1) }), 'ok');
        } else if (msg.type === 'error') {
          set({ thermal: { ...t, status: 'error', error: msg.message } });
          get().notify(tUi('shell.toast.thermalError', { msg: msg.message }), 'error');
        }
      };
      worker.onerror = (ev) => {
        set({ thermal: { ...get().thermal, status: 'error', error: ev.message } });
      };
    }
    const jobId = `th-${Date.now()}`;
    set({ thermal: { ...thermal, status: 'running', jobId, history: [], error: null } });
    const req: ThermalWorkerRequest = { type: 'run', jobId, project, options: thermal.options, snapshotEvery: 25, library: { items: libraryCache.items, cables: libraryCache.cables } };
    worker.postMessage(req);
    if (get().overlays.thermal.mode === 'off') get().setThermalOverlay({ mode: 'slice' });
  },

  cancelThermal() {
    const t = get().thermal;
    if (worker && t.jobId) worker.postMessage({ type: 'cancel', jobId: t.jobId } satisfies ThermalWorkerRequest);
    set({ thermal: { ...t, status: 'cancelled' } });
  },

  saveThermalScenario(name) {
    const t = get().thermal;
    if (!t.metrics) return;
    const s: ThermalScenario = { id: `sc-${Date.now()}`, name, options: t.options, metrics: t.metrics, at: new Date().toISOString() };
    set({ thermal: { ...t, scenarios: [...t.scenarios, s] } });
  },
  removeThermalScenario(id) {
    const t = get().thermal;
    set({ thermal: { ...t, scenarios: t.scenarios.filter((s) => s.id !== id) } });
  },

  setLocale(locale) {
    if (projectLocale(get().project) === locale) return;
    get().update((d) => { d.locale = locale; }, { history: false });
  },
  setGrowth(growth) {
    if (projectGrowth(get().project) === growth) return;
    // DECISIONS-v2 #1: the growth scenario sets the default spine placement (phased → central-end, single-build →
    // central-center); the Network panel can still override it, and the comparator always evaluates every candidate.
    get().update((d) => {
      d.growth = growth;
      d.network.scaleOut.spinePlacement = defaultSpinePlacement(growth);
      d.network.scaleOut.separateRoom = false;
    });
  },

  // S2: workload-first sizing suggestion (store-level, survives page switches; the Layout panel may consume and clear it)
  sizingSuggestion: null,
  setSizingSuggestion(s) {
    set({ sizingSuggestion: s });
  },

  // v2 2차 contract placeholders (T5 panel collapse · T8 UI locale / assistant / lock / versions)
  panelCollapsed: safeLocal(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === '1', false),
  setPanelCollapsed(v) {
    safeLocal(() => localStorage.setItem(PANEL_COLLAPSED_KEY, v ? '1' : '0'), undefined);
    set({ panelCollapsed: v });
  },
  togglePanelCollapsed() {
    get().setPanelCollapsed(!get().panelCollapsed);
  },
  pendingArchitectureRackId: null,
  setPendingArchitectureRackId(id) {
    set({ pendingArchitectureRackId: id });
  },
  pendingGeneratorSetup: null,
  setPendingGeneratorSetup(pendingGeneratorSetup) {
    set({ pendingGeneratorSetup });
  },
  pendingAddCatalogId: null,
  setPendingAddCatalogId(id) {
    set({ pendingAddCatalogId: id });
  },
  uiLocale: safeLocal(() => {
    const saved = localStorage.getItem(UI_LOCALE_KEY);
    return saved === 'en' || saved === 'ko' ? saved : detectUiLocale(typeof navigator !== 'undefined' ? navigator.language : undefined);
  }, 'en' as UiLocale),
  setUiLocale(l) {
    safeLocal(() => localStorage.setItem(UI_LOCALE_KEY, l), undefined);
    set({ uiLocale: l });
  },
  assistantOpen: false,
  setAssistantOpen(v) {
    set({ assistantOpen: v });
  },
  projectLock: null,
  setProjectLock(l) {
    set({ projectLock: l });
  },
  versions: [],
  setVersions(v) {
    set({ versions: v });
  },
  // T3 power plane
  powerScenario: null,
  setPowerScenario(s) {
    set({ powerScenario: s });
  },
  powerHighlight: [],
  setPowerHighlight(ids) {
    set({ powerHighlight: ids });
  },

  libraryVersion: 0,
  libraryDirty: safeLocal(() => localStorage.getItem(LIBRARY_DIRTY_KEY) === '1', false),
  async loadLibrary() {
    // offline cache first so the catalog page works without the server
    const cached = safeLocal(() => localStorage.getItem(LIBRARY_KEY), null);
    let cachedLib: CatalogLibrary | null = null;
    if (cached) {
      cachedLib = safeLocal(() => JSON.parse(cached) as CatalogLibrary, null);
      if (cachedLib) {
        setLibraryCache(cachedLib);
        activateCatalog(get().project);
        set({ libraryVersion: get().libraryVersion + 1 });
        get().runAnalysis();
      }
    }
    if (!get().serverOnline) return;
    // edits saved while offline win over the server copy: push them first, then adopt what the server returns
    if (get().libraryDirty && cachedLib) {
      try {
        const saved = await api.putCatalogLibrary({ items: cachedLib.items ?? [], cables: cachedLib.cables ?? [] });
        setLibraryCache(saved);
        safeLocal(() => localStorage.setItem(LIBRARY_KEY, JSON.stringify({ items: libraryCache.items, cables: libraryCache.cables })), undefined);
        safeLocal(() => localStorage.removeItem(LIBRARY_DIRTY_KEY), undefined);
        set({ libraryDirty: false, libraryVersion: get().libraryVersion + 1 });
        activateCatalog(get().project);
        get().runAnalysis();
        get().notify(tUi('shell.toast.librarySynced', { n: (saved.items ?? []).length }), 'ok');
        return;
      } catch (e) {
        get().notify(tUi('shell.toast.librarySyncFailed', { msg: (e as Error).message }), 'error');
        return; // keep the dirty cache; never let the server copy overwrite it
      }
    }
    try {
      const lib = await api.getCatalogLibrary();
      setLibraryCache(lib);
      safeLocal(() => localStorage.setItem(LIBRARY_KEY, JSON.stringify({ items: libraryCache.items, cables: libraryCache.cables })), undefined);
      activateCatalog(get().project);
      set({ libraryVersion: get().libraryVersion + 1 });
      get().runAnalysis();
    } catch (e) {
      // a 404 means the server predates the S3 route (no library) — not an error worth a toast
      if (!/^404/.test((e as Error).message)) get().notify(tUi('shell.toast.libraryLoadFailed', { msg: (e as Error).message }), 'error');
    }
  },
  async saveLibrary(lib) {
    // polish v2 2차 (QA collab #7): the library is server-global — blocked while another holder has the current project's lock
    if (storeHooks.beforeEdit && !storeHooks.beforeEdit()) return;
    let saved: CatalogLibrary = lib;
    let dirty = !get().serverOnline;
    if (get().serverOnline) {
      try {
        saved = await api.putCatalogLibrary({ items: lib.items ?? [], cables: lib.cables ?? [] }, get().project.id);
      } catch (e) {
        dirty = true;
        get().notify(tUi('shell.toast.librarySaveFailed', { msg: (e as Error).message }), 'error');
      }
    }
    setLibraryCache(saved);
    safeLocal(() => localStorage.setItem(LIBRARY_KEY, JSON.stringify({ items: libraryCache.items, cables: libraryCache.cables })), undefined);
    if (dirty) safeLocal(() => localStorage.setItem(LIBRARY_DIRTY_KEY, '1'), undefined);
    else safeLocal(() => localStorage.removeItem(LIBRARY_DIRTY_KEY), undefined);
    set({ libraryDirty: dirty });
    activateCatalog(get().project);
    set({ libraryVersion: get().libraryVersion + 1 });
    get().runAnalysis();
  },
  async resetProjectToTemplate(template) {
    // integration v2 2차: a template reset replaces and re-saves the project → blocked while someone else holds the edit lock (T8)
    if (storeHooks.beforeEdit && !storeHooks.beforeEdit()) return;
    const current = get().project;
    try {
      let fresh: Project;
      if (get().serverOnline && get().projectAdmin) {
        // v2-2: a template preview (dryRun) — nothing is stored, so no throwaway project lands in Recently deleted
        fresh = await api.createProject({ template: 'reference', dryRun: true });
      } else if (get().serverOnline) {
        fresh = await api.createProject({ template: 'reference' });
        // the server assigned a new id: drop it again so the reset stays in place
        await api.deleteProject(fresh.id).catch(() => undefined);
      } else {
        fresh = createReferenceProject().project;
      }
      fresh = { ...fresh, id: current.id, name: current.name };
      get().replaceProject(fresh);
      if (get().serverOnline) await api.saveProject(fresh).catch(() => undefined);
      void get().refreshProjects();
      get().notify(tUi('shell.toast.templateReset', { name: current.name, template: tUi(template === 'reference' ? 'shell.toast.tplHall' : 'shell.toast.tplHall') }), 'ok');
    } catch (e) {
      get().notify(tUi('shell.toast.templateResetFailed', { msg: (e as Error).message }), 'error');
    }
  },

  // ── halls lifecycle ──
  addHall(opts) {
    let id: string | null = null;
    const ok = get().update((d) => {
      const r = addHallToProject(d, opts);
      id = r.hallId;
      Object.assign(d, r.project);
    });
    if (!ok || !id) return null;
    get().setHall(id);
    return id;
  },
  renameHall(id, name) {
    const hall = get().project.halls.find((h) => h.id === id);
    if (!hall || !name.trim() || hall.name === name.trim()) return false;
    return get().update((d) => { Object.assign(d, renameHallInProject(d, id, name)); });
  },
  duplicateHall(id, withLayout) {
    if (!get().project.halls.some((h) => h.id === id)) return null;
    let nid: string | null = null;
    const ok = get().update((d) => {
      const r = duplicateHallInProject(d, id, { withLayout });
      nid = r.hallId;
      Object.assign(d, r.project);
    });
    if (!ok || !nid) return null;
    get().setHall(nid);
    return nid;
  },
  removeHall(id) {
    const p = get().project;
    if (p.halls.length <= 1 || !p.halls.some((h) => h.id === id)) return false;
    const th0 = get().thermal;
    const ok = get().update((d) => { Object.assign(d, removeHallFromProject(d, id)); });
    if (!ok) return false;
    const th = get().thermal;
    const resultGone = th.result?.options.hallId === id;
    // backlog T3 (7): the removed hall's thermal result / scenarios travel with the undo snapshot instead of being lost
    const before = get().past[get().past.length - 1];
    if (before) {
      hallThermalRestore.set(before, {
        hallId: id,
        scenarios: th0.scenarios.filter((sc) => sc.options.hallId === id),
        result: resultGone ? th0.result : null,
        metrics: resultGone ? th0.metrics : null,
        history: resultGone ? th0.history : [],
        status: resultGone ? th0.status : 'idle',
      });
    }
    hallThermalDrop.set(get().project, id);
    set({
      thermal: {
        ...th,
        scenarios: th.scenarios.filter((sc) => sc.options.hallId !== id),
        ...(resultGone ? { result: null, metrics: null, history: [], status: 'idle' as const } : {}),
      },
    });
    const halls = get().project.halls;
    if (get().hallId === id || !halls.some((h) => h.id === get().hallId)) get().setHall(halls[0].id);
    return true;
  },

  // ── v2-2 project management ──
  async purgeTrash(olderThanDays) {
    try {
      const r = await api.purgeTrash(olderThanDays);
      await get().refreshTrash();
      return { ok: true as const, removed: r.removed };
    } catch (e) {
      return { ok: false as const, message: (e as Error).message };
    }
  },
  async refreshTrash() {
    if (!get().serverOnline || !get().projectAdmin) return;
    try {
      set({ trash: await api.listTrash() });
    } catch {
      /* keep the previous list */
    }
  },
  async newProject({ name, template, preset }) {
    if (template === 'copy') return get().saveAsNewProject({ name });
    const blocked = projectAdminBlocked(get);
    if (blocked) return blocked;
    projectOpBusy = true;
    try {
      const created = await api.createProject({ template, name, ...(template === 'empty' && preset ? { preset } : {}) });
      await get().openProject(created.id);
      await get().refreshProjects();
      get().notify(tUi('project.toast.created', { name: created.name }), 'ok');
      return { ok: true, id: created.id };
    } catch (e) {
      return projectActionError(e);
    } finally {
      projectOpBusy = false;
    }
  },
  async saveAsNewProject(o) {
    const blocked = projectAdminBlocked(get);
    if (blocked) return blocked;
    projectOpBusy = true;
    try {
      // overrides go into a clone only: the open project (and its server file) keep their values
      const body: Project = structuredClone(get().project);
      body.name = o.name;
      if (o.client !== undefined) body.client = o.client;
      if (o.description !== undefined) body.description = o.description;
      if (o.siteName !== undefined) body.site.name = o.siteName;
      if (o.siteLocation !== undefined) body.site.location = o.siteLocation;
      const created = await api.createProject(body);
      await get().openProject(created.id);
      await get().refreshProjects();
      get().notify(tUi('project.toast.created', { name: created.name }), 'ok');
      return { ok: true, id: created.id };
    } catch (e) {
      return projectActionError(e);
    } finally {
      projectOpBusy = false;
    }
  },
  async deleteProject(id) {
    const blocked = projectAdminBlocked(get);
    if (blocked) return blocked;
    projectOpBusy = true;
    try {
      const isCurrent = id === get().project.id;
      const name = isCurrent ? get().project.name : (get().projects.find((p) => p.id === id)?.name ?? id);
      if (isCurrent) {
        clearTimeout(saveTimer);
        if (get().dirty) await get().save(); // the last edits travel into the trash with the project
      }
      await api.deleteProject(id);
      let list: ProjectListItem[];
      try {
        list = await api.listProjects();
      } catch {
        list = get().projects.filter((p) => p.id !== id);
      }
      set({ projects: list });
      if (isCurrent) {
        clearTimeout(saveTimer);
        set({ dirty: false });
        const next = pickFallbackProject(list, id);
        if (next) await get().openProject(next, { skipSave: true });
      }
      await get().refreshTrash();
      get().notify(tUi('project.toast.deleted', { name }), 'ok');
      return { ok: true };
    } catch (e) {
      return projectActionError(e);
    } finally {
      projectOpBusy = false;
    }
  },
  async restoreProject(entry) {
    const blocked = projectAdminBlocked(get);
    if (blocked) return blocked;
    projectOpBusy = true;
    try {
      const r = await api.restoreTrash(entry);
      await get().refreshProjects();
      await get().openProject(r.project.id);
      await get().refreshTrash();
      get().notify(tUi(r.renamedId || r.renamedName ? 'project.toast.restoredRenamed' : 'project.toast.restored', { name: r.project.name }), 'ok');
      return { ok: true, id: r.project.id };
    } catch (e) {
      return projectActionError(e);
    } finally {
      projectOpBusy = false;
    }
  },
  async handleProjectGone(id) {
    if (projectOpBusy || goneHandling || get().project.id !== id || !get().serverOnline) return;
    goneHandling = true;
    try {
      try {
        await api.getProject(id);
        return; // still there (a transient list glitch)
      } catch (e) {
        if (apiErrorInfo(e).status !== 404) return;
      }
      clearTimeout(saveTimer);
      const name = get().project.name;
      const list = await api.listProjects().catch(() => get().projects.filter((p) => p.id !== id));
      set({ projects: list, dirty: false });
      const nextId = pickFallbackProject(list, id);
      if (nextId) await get().openProject(nextId, { skipSave: true });
      else get().replaceProject(await api.createProject({ template: 'reference' }));
      get().notify(tUi('project.toast.goneRemote', { name, next: get().project.name }), 'error');
      void get().refreshTrash();
    } catch {
      /* stay on the local copy; the next save / poll retries */
    } finally {
      goneHandling = false;
    }
  },

  notify(text, kind = 'info') {
    const id = Date.now();
    set({ toast: { id, kind, text } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 4500);
  },
  setPreviewProject(p) {
    set({ previewProject: p });
  },
}));

// S4: dev/QA hook — lets headless screenshot scripts drive the store (fly mode, pages, viewerApi.flyTo) without UI clicks.
declare global {
  interface Window { __aidcApp?: typeof useApp }
}
if (typeof window !== 'undefined') window.__aidcApp = useApp;
// fix v2 2차 (QA): an edit from the last 1.5 s before the tab is hidden / closed is flushed instead of waiting for the timer
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && useApp.getState().dirty) {
      clearTimeout(saveTimer);
      void useApp.getState().save();
    }
  });
}
