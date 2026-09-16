// r4 stream C (spec §3.2, r4-ux §B.1): the `view2d` slice of the app store. Created here and mounted by store/appStore.ts as
// `view2d: createView2dSlice(set, get)`. Per-user view state persisted in localStorage['aidc:view2d'] (try/catch), never in the
// project: mode, split, theme, units, layers, tools, cuts (A–A …, "not saved to project" until drawingCuts is persisted, P1).
// C → D hand-off: `useApp.getState().view2d.open({ mode, hallId, frame | cutId | cut | elevation })`.
import { LAYERS, LAYER_PRESETS, type DrawingCut, type DrawingUnits, type ElevationTarget, type LayerId, type LayerPresetId, type Rect, type SectionDepthPreset, type Space2D } from '@aidc/core';
import { DEFAULT_CUT_DEPTH_M, flipCut, flipTarget, nextCutLabel, nudgeCut } from './cutTool.ts';
import type { Theme2D } from './palette2d.ts';

export type ViewMode = '3d' | Space2D;
export type Tool2D = 'select' | 'pan' | 'measure' | 'cut';

export interface View2DOpenArgs {
  mode: ViewMode;
  hallId?: string;
  /** world rect to frame (plan {x, y, w, d}; section / elevation {x: u0, y: z0, w, d}) */
  frame?: Rect;
  cutId?: string;
  cut?: DrawingCut;
  elevation?: ElevationTarget;
}

export interface FrameRequest {
  nonce: number;
  hallId: string | null;
  space: Space2D;
  rect: Rect | null;
  /** fit the current selection instead of a rect */
  selection?: boolean;
}

export interface View2DState {
  mode: ViewMode;
  split: boolean;
  /** 3D pane share of the viewport in Split (0.2 … 0.8) */
  splitRatio: number;
  splitAxis: 'auto' | 'h' | 'v';
  theme: Theme2D;
  units: DrawingUnits;
  layers: LayerId[];
  layersOpen: boolean;
  annotations: boolean;
  snap: boolean;
  tool: Tool2D;
  cuts: DrawingCut[];
  activeCutId: string | null;
  depth: SectionDepthPreset;
  elevation: ElevationTarget | null;
  frameRequest: FrameRequest | null;
}

export interface View2DActions {
  set(patch: Partial<View2DState>): void;
  setMode(mode: ViewMode): void;
  toggleSplit(): void;
  setLayer(id: LayerId, on: boolean): void;
  applyPreset(p: LayerPresetId): void;
  /** adds a cut with the next free label and makes it active */
  addCut(c: Omit<DrawingCut, 'id' | 'label'>): DrawingCut;
  /** adds several cuts in one state update; used for the complete set of physical row sections */
  addCuts(cuts: readonly Omit<DrawingCut, 'id' | 'label'>[]): DrawingCut[];
  updateCut(id: string, patch: Partial<DrawingCut>): void;
  removeCut(id: string): void;
  flipActive(): void;
  nudgeActive(delta: number): void;
  /** previous / next cut (section) or target (elevation) */
  cycle(dir: 1 | -1, targets?: ElevationTarget[]): void;
  requestFrame(r: Omit<FrameRequest, 'nonce'>): void;
  open(args: View2DOpenArgs): void;
}

export type View2DSlice = View2DState & View2DActions;

const STORE_KEY = 'aidc:view2d';
const PERSIST: (keyof View2DState)[] = ['mode', 'split', 'splitRatio', 'splitAxis', 'theme', 'units', 'layers', 'layersOpen', 'annotations', 'snap', 'tool', 'cuts', 'activeCutId', 'depth', 'elevation'];
const LAYER_IDS = new Set<string>(LAYERS.map((l) => l.id));

export const DEFAULT_VIEW2D: View2DState = {
  mode: '3d',
  split: false,
  splitRatio: 0.5,
  splitAxis: 'auto',
  theme: 'paper',
  units: 'metric',
  layers: LAYERS.filter((l) => l.defaultOn).map((l) => l.id),
  layersOpen: false,
  annotations: true,
  snap: true,
  tool: 'select',
  cuts: [],
  activeCutId: null,
  depth: 'next-row',
  elevation: null,
  frameRequest: null,
};

/** Parse persisted state defensively (unknown keys and bad values fall back to defaults). */
export function parseView2dState(raw: string | null): Partial<View2DState> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Partial<View2DState>;
    const out: Partial<View2DState> = {};
    if (o.mode === '3d' || o.mode === 'plan' || o.mode === 'section' || o.mode === 'elevation') out.mode = o.mode;
    if (typeof o.split === 'boolean') out.split = o.split;
    if (typeof o.splitRatio === 'number' && o.splitRatio >= 0.2 && o.splitRatio <= 0.8) out.splitRatio = o.splitRatio;
    if (o.splitAxis === 'auto' || o.splitAxis === 'h' || o.splitAxis === 'v') out.splitAxis = o.splitAxis;
    if (o.theme === 'paper' || o.theme === 'dark') out.theme = o.theme;
    if (o.units === 'metric' || o.units === 'imperial') out.units = o.units;
    if (Array.isArray(o.layers)) out.layers = o.layers.filter((l) => LAYER_IDS.has(l));
    if (typeof o.layersOpen === 'boolean') out.layersOpen = o.layersOpen;
    if (typeof o.annotations === 'boolean') out.annotations = o.annotations;
    if (typeof o.snap === 'boolean') out.snap = o.snap;
    if (o.tool === 'select' || o.tool === 'pan' || o.tool === 'measure' || o.tool === 'cut') out.tool = o.tool;
    if (Array.isArray(o.cuts)) out.cuts = o.cuts.filter((c) => c && typeof c.id === 'string' && (c.axis === 'x' || c.axis === 'y') && Number.isFinite(c.at) && (c.look === 1 || c.look === -1));
    if (typeof o.activeCutId === 'string' || o.activeCutId === null) out.activeCutId = o.activeCutId;
    if (o.depth === 'cut' || o.depth === 'next-row' || o.depth === 'wall' || (typeof o.depth === 'number' && o.depth >= 0)) out.depth = o.depth;
    if (o.elevation && typeof o.elevation === 'object' && 'kind' in o.elevation) out.elevation = o.elevation;
    return out;
  } catch {
    return {};
  }
}

function load(): Partial<View2DState> {
  try {
    return parseView2dState(localStorage.getItem(STORE_KEY));
  } catch {
    return {};
  }
}

function persist(s: View2DState) {
  try {
    const o: Record<string, unknown> = {};
    for (const k of PERSIST) o[k] = s[k];
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch {
    /* storage blocked: defaults next time */
  }
}

interface Host {
  view2d: View2DSlice;
  hallId: string;
  setHall(id: string): void;
}
type SetFn = (fn: (s: Host) => Partial<Host>) => void;
type GetFn = () => Host;

let nonce = 0;
let cutSeq = 0;

export function createView2dSlice(set: SetFn, get: GetFn): View2DSlice {
  const patch = (p: Partial<View2DState>) => {
    set((s) => ({ view2d: { ...s.view2d, ...p } }));
    persist(get().view2d);
  };
  const init: View2DState = { ...DEFAULT_VIEW2D, ...load() };
  return {
    ...init,
    set: patch,
    setMode(mode) {
      const v = get().view2d;
      // the Cut tool only draws on plans: leaving Plan returns it to Select (QA r4 view2d: Digit4 after Digit3 kept a dead Cut tool,
      // crosshair cursor and no marquee in Section / Elevation)
      patch({ mode, ...(mode === '3d' ? { split: false } : {}), ...(mode !== 'plan' && v.tool === 'cut' ? { tool: 'select' as Tool2D } : {}) });
    },
    toggleSplit() {
      const v = get().view2d;
      if (v.split) patch({ split: false });
      else patch({ split: true, mode: v.mode === '3d' ? 'plan' : v.mode });
    },
    setLayer(id, on) {
      const cur = new Set(get().view2d.layers);
      if (on) cur.add(id);
      else cur.delete(id);
      patch({ layers: LAYERS.map((l) => l.id).filter((l) => cur.has(l)) });
    },
    applyPreset(p) {
      patch({ layers: [...LAYER_PRESETS[p]] });
    },
    addCut(c) {
      const v = get().view2d;
      const { label } = nextCutLabel(v.cuts.filter((x) => x.hallId === c.hallId));
      const cut: DrawingCut = { ...c, id: `cut-${Date.now().toString(36)}-${++cutSeq}`, label, depthM: c.depthM ?? DEFAULT_CUT_DEPTH_M };
      patch({ cuts: [...v.cuts, cut], activeCutId: cut.id });
      return cut;
    },
    addCuts(input) {
      const v = get().view2d;
      const made: DrawingCut[] = [];
      const next = [...v.cuts];
      for (const c of input) {
        const { label } = nextCutLabel(next.filter((x) => x.hallId === c.hallId));
        const cut: DrawingCut = { ...c, id: `cut-${Date.now().toString(36)}-${++cutSeq}`, label, depthM: c.depthM ?? DEFAULT_CUT_DEPTH_M };
        next.push(cut);
        made.push(cut);
      }
      if (made.length) patch({ cuts: next, activeCutId: made[0].id });
      return made;
    },
    updateCut(id, p) {
      patch({ cuts: get().view2d.cuts.map((c) => (c.id === id ? { ...c, ...p, id } : c)) });
    },
    removeCut(id) {
      const v = get().view2d;
      const cuts = v.cuts.filter((c) => c.id !== id);
      patch({ cuts, activeCutId: v.activeCutId === id ? cuts.filter((c) => c.hallId === get().hallId).at(-1)?.id ?? null : v.activeCutId });
    },
    flipActive() {
      const v = get().view2d;
      if (v.mode === 'elevation' && v.elevation) return patch({ elevation: flipTarget(v.elevation) });
      const c = v.cuts.find((x) => x.id === v.activeCutId);
      if (c) patch({ cuts: v.cuts.map((x) => (x.id === c.id ? flipCut(x) : x)) });
    },
    nudgeActive(delta) {
      const v = get().view2d;
      const c = v.cuts.find((x) => x.id === v.activeCutId);
      if (c) patch({ cuts: v.cuts.map((x) => (x.id === c.id ? nudgeCut(x, delta) : x)) });
    },
    cycle(dir, targets) {
      const v = get().view2d;
      if (v.mode === 'elevation' && targets?.length) {
        const i = v.elevation ? targets.findIndex((t) => JSON.stringify({ ...t, face: undefined, end: undefined }) === JSON.stringify({ ...v.elevation, face: undefined, end: undefined })) : -1;
        return patch({ elevation: targets[(i + dir + targets.length) % targets.length] });
      }
      const hallCuts = v.cuts.filter((c) => c.hallId === get().hallId);
      if (!hallCuts.length) return;
      const i = hallCuts.findIndex((c) => c.id === v.activeCutId);
      patch({ activeCutId: hallCuts[(i + dir + hallCuts.length) % hallCuts.length].id });
    },
    requestFrame(r) {
      set((s) => ({ view2d: { ...s.view2d, frameRequest: { ...r, nonce: ++nonce } } }));
    },
    open(args) {
      const host = get();
      if (args.hallId && args.hallId !== host.hallId) host.setHall(args.hallId);
      const v = get().view2d;
      const p: Partial<View2DState> = { mode: args.mode };
      if (args.cut) {
        const exists = v.cuts.some((c) => c.id === args.cut!.id);
        p.cuts = exists ? v.cuts.map((c) => (c.id === args.cut!.id ? { ...args.cut! } : c)) : [...v.cuts, { ...args.cut }];
        p.activeCutId = args.cut.id;
      } else if (args.cutId && v.cuts.some((c) => c.id === args.cutId)) p.activeCutId = args.cutId;
      if (args.elevation) p.elevation = args.elevation;
      patch(p);
      if (args.mode !== '3d') set((s) => ({ view2d: { ...s.view2d, frameRequest: { nonce: ++nonce, hallId: args.hallId ?? s.hallId, space: args.mode as Space2D, rect: args.frame ?? null } } }));
    },
  };
}
