// r4 stream C (spec §3.2–§3.4): the in-app 2D view pane — Plan · Section · Elevation of the current hall.
// Canvas2D renderer fed by the drawlist worker; layers, LOD bands, label culling, hover tooltips (viewer tooltip builder), selection
// synced with the store / inspector (non-equipment objects select locally with "Highlight in 3D"), cut tool with snapping, measure
// tool, clearance findings, scale bar + north arrow + coordinate readout, SVG / PNG export. Keys are scoped to the pane
// (data-keyscope="view2d"); consumed keys call preventDefault + stopPropagation.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { findCatalogItem, fmtLength, frameToWorld, rowGroupsFromEquipment, type DrawingCut, type ElevationTarget, type Rect, type Space2D } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { translate, useT } from '../i18n/index.ts';
import { Canvas2DRenderer, cutSegment, DEFAULT_FONT, type CutMarker, type OverlayState } from './renderer/Canvas2DRenderer.ts';
import { exportSvgInWorker, useDrawList } from './useDrawList.ts';
import { fitRect, padRect, panBy, screenToWorld, unionRect, visibleRect, zoomAt, type View2DFrame } from './viewXform.ts';
import { isTypingTarget, pane2DKey } from './keyscope.ts';
import { aisleAt, crossSectionThroughEquipment, crossSectionThroughRow, cutFromDrag, DEFAULT_CUT_DEPTH_M, elevationTargets, longSectionAlongAisle, longSectionThroughRow, NUDGE_FINE_M, NUDGE_TILE_M, type DragCut } from './cutTool.ts';
import { segDist } from './hitGrid.ts';
import { measureReadout, snapPoint, type Pt2 } from './measure.ts';
import { equipmentTooltip, networkRoleLabel } from './equipmentTooltip.ts';
import { downloadBlob, gesture2D, pane2D } from './runtime.ts';
import { LayersPanel } from './LayersPanel.tsx';
import { View2DTools } from './View2DToolbar.tsx';
import { tokens } from './palette2d.ts';
import type { BuildRequest, PrimInfo, Scene2D } from './scene.ts';
import './view2d.css';

const EQUIPMENT = new Set(['rack', 'unit']);
const POWER = new Set(['busway', 'tapoff', 'circuit', 'feeder']);
const GESTURE_IDLE_MS = 160;
const FULL_REDRAW_MS = 100;

declare global {
  interface Window {
    /** dev / QA hook (like window.__aidcApp): the mounted 2D pane */
    __aidcView2d?: { renderer: Canvas2DRenderer | null; scene: Scene2D | null; frameTimes: number[]; fullDraws: number[]; setView?: (v: View2DFrame) => void };
  }
}

interface MenuItem {
  label: string;
  run: () => void;
}

function targetValid(tg: ElevationTarget | null, rows: { id: string }[], containments: { id: string; hallId: string }[], hallId: string): boolean {
  if (!tg) return false;
  if (tg.kind === 'wall') return true;
  if (tg.kind === 'row-face') return rows.some((r) => r.id === tg.rowId);
  return containments.some((c) => c.id === tg.containmentId && c.hallId === hallId);
}

export function View2DPane({ showToolbar }: { showToolbar: boolean }) {
  const t = useT();
  const s = useApp();
  const project = s.previewProject ?? s.project;
  const { analysis, hallId, selection } = s;
  const v = s.view2d;
  const space: Space2D = v.mode === '3d' ? 'plan' : v.mode;
  const hall = project.halls.find((h) => h.id === hallId) ?? project.halls[0];
  const locale = project.locale ?? 'en';
  const hallCuts = useMemo(() => v.cuts.filter((c) => c.hallId === hall?.id), [v.cuts, hall?.id]);
  const activeCut = hallCuts.find((c) => c.id === v.activeCutId) ?? null;
  const rows = useMemo(() => (hall ? rowGroupsFromEquipment(hall.id, project.equipment) : []), [hall?.id, project.equipment]);
  const targets = useMemo(() => (hall ? elevationTargets(rows, project.containments, hall.id) : []), [rows, project.containments, hall?.id]);
  const elevation = hall && targetValid(v.elevation, rows, project.containments, hall.id) ? v.elevation : targets.find((x) => x.kind === 'aisle-end') ?? targets[0] ?? null;
  const eqById = useMemo(() => new Map(project.equipment.map((e) => [e.id, e])), [project.equipment]);
  // keep the store on the target actually shown: with no (or a stale) stored target the pane showed the first aisle end while the
  // toolbar ref ▾ read "—" and X / flip did nothing (QA r4 view2d)
  useEffect(() => {
    if (space === 'elevation' && elevation && elevation !== v.elevation) v.set({ elevation });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, elevation]);

  const req = useMemo<Omit<BuildRequest, 'type' | 'key'> | null>(() => {
    if (!hall) return null;
    if (space === 'plan') return { hallId: hall.id, space, units: v.units, locale, depth: v.depth, cuts: hallCuts };
    if (space === 'section') return activeCut ? { hallId: hall.id, space, cut: activeCut, depth: v.depth, units: v.units, locale } : null;
    return elevation ? { hallId: hall.id, space, elevation, units: v.units, locale } : null;
  }, [hall, space, v.units, locale, v.depth, hallCuts, activeCut, elevation]);
  const { scene: rawScene, loading, error } = useDrawList(project, analysis, req);
  const scene = rawScene && rawScene.space === space && rawScene.hallId === hall?.id ? rawScene : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const rendererRef = useRef<Canvas2DRenderer | null>(null);
  const frames = useRef(new Map<string, View2DFrame>());
  // frames the user has not moved yet: refitted when the pane resizes (Split on / off, panel collapse, first layout).
  // value = the requested world rect (Open in 2D) or null = fit the scene
  const autoFit = useRef(new Map<string, Rect | null>());
  const onResizeRef = useRef<() => void>(() => {});
  const frameKey = `${hall?.id}|${space}|${space === 'section' ? `${activeCut?.id}|${activeCut?.look}|${activeCut?.axis}` : space === 'elevation' ? JSON.stringify(elevation) : ''}`;
  const frameKeyRef = useRef(frameKey);
  frameKeyRef.current = frameKey;

  // interaction state (refs: never re-render on pointer moves)
  const ptr = useRef<{ id: number; sx: number; sy: number; mode: 'pan' | 'marquee' | 'cut' | 'click'; moved: boolean; view0: View2DFrame; button: number } | null>(null);
  const hovered = useRef<number | null>(null);
  const marquee = useRef<OverlayState['marquee']>(null);
  const cutPreview = useRef<DragCut | null>(null);
  const snapMark = useRef<OverlayState['snap']>(null);
  const measureCursor = useRef<Pt2 | null>(null);
  const spaceHeld = useRef(false);
  const camera = useRef<OverlayState['camera']>(null);
  const [measure, setMeasure] = useState<{ pts: Pt2[]; active: boolean }>({ pts: [], active: false });
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const [localPrim, setLocalPrim] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; title: string; lines: string[] } | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const draw = useRef({ raf: 0, full: false, gestureUntil: 0, lastFull: 0, settle: undefined as ReturnType<typeof setTimeout> | undefined });

  // canvas annotation text follows the document language (project.locale), chrome follows the UI language
  const northLabel = translate(locale, 'view2d.north');
  const latest = useRef({ selection, localPrim, hallCuts, activeCut, scene, space, northLabel, split: v.split, measure });
  latest.current = { selection, localPrim, hallCuts, activeCut, scene, space, northLabel, split: v.split, measure };

  // ───────────── drawing ─────────────

  const overlayState = useCallback((): OverlayState => {
    const r = rendererRef.current!;
    const L = latest.current;
    const sel: number[] = [];
    for (const id of L.selection) for (const i of r.itemsOfRef(id)) if (EQUIPMENT.has(r.primOf(i)?.emitter ?? '')) sel.push(i);
    const cuts: CutMarker[] = L.space === 'plan' ? L.hallCuts.map((c) => ({ cut: c, depthM: L.scene?.cutDepths?.[c.id], active: c.id === L.activeCut?.id })) : [];
    const pv = cutPreview.current;
    if (pv && hall) cuts.push({ cut: { id: 'preview', label: '…', hallId: hall.id, kind: 'free', axis: pv.axis, at: pv.at, look: pv.look, depthM: DEFAULT_CUT_DEPTH_M, window: pv.window }, preview: true });
    return {
      selected: sel,
      hovered: hovered.current,
      local: L.localPrim ? r.itemOfPrim(L.localPrim) ?? null : null,
      marquee: marquee.current,
      measure: L.measure.pts.length ? { pts: L.measure.pts, cursor: L.measure.active ? measureCursor.current : null, closed: !L.measure.active } : measureCursor.current && useApp.getState().view2d.tool === 'measure' ? { pts: [], cursor: measureCursor.current } : null,
      snap: snapMark.current,
      cuts,
      camera: L.split && L.space === 'plan' ? camera.current : null,
      northLabel: L.northLabel,
      space: L.space,
      hallRect: L.scene?.hallRect ?? null,
    };
  }, [hall]);

  const frame = useCallback(() => {
    const d = draw.current;
    d.raf = 0;
    const r = rendererRef.current;
    if (!r) return;
    const now = performance.now();
    const gesturing = now < d.gestureUntil;
    const hook = window.__aidcView2d;
    if (d.full) {
      if (gesturing && now - d.lastFull < FULL_REDRAW_MS && r.blit(r.view)) {
        // blit only
      } else {
        r.setOptions({ lite: gesturing });
        const st = r.drawBase();
        d.lastFull = performance.now();
        if (!gesturing) d.full = false;
        hook?.fullDraws.push(st.ms);
        const root = rootRef.current;
        if (root) {
          root.dataset.lod = String(st.band);
          root.dataset.ppm = r.view.ppm.toFixed(2);
          root.dataset.labels = String(st.labels);
          root.dataset.culled = String(st.culled);
        }
      }
    }
    r.drawOverlay(overlayState());
    if (hook) hook.frameTimes.push(now);
  }, [overlayState]);

  const requestDraw = useCallback((kind: 'full' | 'overlay' | 'gesture') => {
    const d = draw.current;
    if (kind !== 'overlay') d.full = true;
    if (kind === 'gesture') {
      d.gestureUntil = performance.now() + GESTURE_IDLE_MS;
      gesture2D.set(true);
      clearTimeout(d.settle);
      d.settle = setTimeout(() => {
        d.full = true;
        gesture2D.set(false);
        if (!d.raf) d.raf = requestAnimationFrame(frame);
      }, GESTURE_IDLE_MS + 10);
    }
    if (!d.raf) d.raf = requestAnimationFrame(frame);
  }, [frame]);

  /** `auto` = a fit (refitted on resize until the user pans / zooms); omitted = a user frame */
  const setView = useCallback((view: View2DFrame, kind: 'full' | 'gesture' = 'full', auto?: { rect: Rect | null }) => {
    const r = rendererRef.current;
    if (!r) return;
    r.setView(view);
    frames.current.set(frameKeyRef.current, view);
    if (auto) autoFit.current.set(frameKeyRef.current, auto.rect);
    else autoFit.current.delete(frameKeyRef.current);
    requestDraw(kind);
  }, [requestDraw]);

  useEffect(() => {
    if (window.__aidcView2d) window.__aidcView2d.setView = (view) => setView(view);
  });

  // renderer lifecycle
  useEffect(() => {
    const base = baseRef.current!;
    const over = overRef.current!;
    const root = rootRef.current!;
    const r = new Canvas2DRenderer(base, over);
    rendererRef.current = r;
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || DEFAULT_FONT;
    r.setOptions({ font });
    window.__aidcView2d = { renderer: r, scene: null, frameTimes: [], fullDraws: [] };
    // size synchronously: a cached scene arriving on remount (3D → Plan) was fitted against the 1 × 1 px initial canvas (0.1 px/m)
    const rect0 = root.getBoundingClientRect();
    r.resize(rect0.width, rect0.height, Math.min(window.devicePixelRatio || 1, 2));
    const ro = new ResizeObserver(() => {
      const rect = root.getBoundingClientRect();
      r.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
      onResizeRef.current();
      requestDraw('full');
    });
    ro.observe(root);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(draw.current.raf);
      clearTimeout(draw.current.settle);
      gesture2D.set(false); // unmounted mid-gesture (Digit1 while panning): never leave the 3D loop paused
      rendererRef.current = null;
      if (window.__aidcView2d?.renderer === r) window.__aidcView2d = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fitFor = useCallback((sc: Scene2D): View2DFrame => {
    const r = rendererRef.current!;
    if (sc.space === 'plan') {
      const hr = sc.hallRect.w > 0 ? padRect(sc.hallRect, 0, 1.2) : sc.packed.bounds;
      return fitRect(hr, r.w, r.h, 0.04);
    }
    const b = sc.packed.bounds;
    return fitRect({ x: b.x - 0.6, y: b.y - 0.9, w: b.w * 1.28 + 1.2, d: b.d + 1.8 }, r.w, r.h, 0.04);
  }, []);

  // scene → renderer
  const pendingFrame = useRef<typeof v.frameRequest>(null);
  const lastPacked = useRef<Scene2D['packed'] | null>(null);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    // a scene that only gained its clearance findings (same packed list) keeps the renderer's batches and view
    if (scene && lastPacked.current === scene.packed) {
      r.setClearance(scene.clearance);
      if (window.__aidcView2d) window.__aidcView2d.scene = scene;
      requestDraw('full');
      return;
    }
    lastPacked.current = scene?.packed ?? null;
    r.setScene(scene ? { space: scene.space, packed: scene.packed, ann: scene.ann, prims: scene.prims, clearance: scene.clearance } : null);
    if (window.__aidcView2d) window.__aidcView2d.scene = scene;
    if (scene) {
      const pf = pendingFrame.current;
      if (pf && pf.space === scene.space && (!pf.hallId || pf.hallId === scene.hallId)) {
        pendingFrame.current = null;
        if (pf.rect) {
          frames.current.set(frameKeyRef.current, fitRect(pf.rect, r.w, r.h, 0.04));
          autoFit.current.set(frameKeyRef.current, pf.rect);
        }
      }
      let f = frames.current.get(frameKeyRef.current);
      if (!f) {
        f = fitFor(scene);
        autoFit.current.set(frameKeyRef.current, null);
      }
      frames.current.set(frameKeyRef.current, f);
      r.setView(f);
    }
    requestDraw('full');
  }, [scene, fitFor, requestDraw]);

  // options → renderer
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    r.setOptions({ theme: v.theme, layers: new Set(v.layers), annotations: v.annotations, units: v.units, forceLabelIds: new Set(selection) });
    requestDraw('full');
  }, [v.theme, v.layers, v.annotations, v.units, selection, requestDraw]);

  useEffect(() => requestDraw('overlay'), [localPrim, hallCuts, activeCut, measure, requestDraw]);

  // selection fit / open() frame requests
  const fitSelection = useCallback(() => {
    const r = rendererRef.current;
    if (!r) return;
    let rect: Rect | null = null;
    for (const id of useApp.getState().selection) for (const i of r.itemsOfRef(id)) rect = unionRect(rect, r.itemRect(i));
    const lp = latest.current.localPrim;
    if (lp) {
      const i = r.itemOfPrim(lp);
      if (i !== undefined) rect = unionRect(rect, r.itemRect(i));
    }
    // 30 % padding with at least 2.5 m of context around a single rack
    if (rect) setView(fitRect(padRect(rect, 0.3, 2.5), r.w, r.h, 0.04));
  }, [setView]);
  useEffect(() => {
    const fr = v.frameRequest;
    if (!fr) return;
    if (fr.selection) return fitSelection();
    pendingFrame.current = fr;
    const r = rendererRef.current;
    if (r && scene && scene.space === fr.space && fr.rect) {
      pendingFrame.current = null;
      setView(fitRect(fr.rect, r.w, r.h, 0.04), 'full', { rect: fr.rect });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.frameRequest?.nonce]);

  const fitHall = useCallback(() => {
    const r = rendererRef.current;
    const sc = latest.current.scene;
    if (r && sc) setView(fitFor(sc), 'full', { rect: null });
  }, [fitFor, setView]);

  // pane resized: refit frames the user has not moved (QA r4 view2d: Split on / off and panel collapse kept a stale fit, e.g. the
  // elevation cut off below the stacked Split pane)
  onResizeRef.current = () => {
    const r = rendererRef.current;
    const sc = latest.current.scene;
    const key = frameKeyRef.current;
    if (!r || !sc || !autoFit.current.has(key)) return;
    const rect = autoFit.current.get(key);
    const f = rect ? fitRect(rect, r.w, r.h, 0.04) : fitFor(sc);
    r.setView(f);
    frames.current.set(key, f);
  };

  const zoom = useCallback((factor: number) => {
    const r = rendererRef.current;
    if (r) setView(zoomAt(r.view, r.w, r.h, r.w / 2, r.h / 2, factor));
  }, [setView]);

  // camera footprint in Split + Plan
  useEffect(() => {
    if (!v.split || space !== 'plan') return;
    const id = setInterval(() => {
      const api = useApp.getState().viewerApi;
      try {
        const pose = api?.getCameraPose();
        if (pose && Number.isFinite(pose.x)) {
          const prev = camera.current;
          if (!prev || Math.abs(prev.x - pose.x) > 0.01 || Math.abs(prev.y - pose.y) > 0.01 || Math.abs(prev.yaw - pose.yaw) > 0.2) {
            camera.current = { x: pose.x, y: pose.y, yaw: pose.yaw, fovDeg: 45 };
            requestDraw('overlay');
          }
        }
      } catch {
        /* viewer not ready */
      }
    }, 250);
    return () => clearInterval(id);
  }, [v.split, space, requestDraw]);

  // ───────────── hover card text ─────────────

  const describe = useCallback((i: number): { title: string; lines: string[] } | null => {
    const r = rendererRef.current;
    if (!r) return null;
    const prim: PrimInfo | undefined = r.primOf(i);
    if (!prim) return null;
    const len = (m: number) => fmtLength(m, v.units) + (v.units === 'metric' ? ' m' : '');
    if (EQUIPMENT.has(prim.emitter) && prim.refId) {
      const e = eqById.get(prim.refId);
      const item = e ? findCatalogItem(e.catalogId) : undefined;
      if (e && item) return equipmentTooltip(t, e, item, { roleLabel: (role) => networkRoleLabel(t, role) });
    }
    const m = prim.meta ?? {};
    const lines: string[] = [];
    const add = (key: string, params: Record<string, string | number>) => lines.push(t(key, params));
    switch (prim.emitter) {
      case 'tray':
      case 'drop':
        if (prim.tier) add('view2d.tip.tier', { tier: prim.tier });
        if (typeof m.widthM === 'number') add('view2d.tip.width', { w: len(m.widthM) });
        if (typeof m.kind === 'string') add('view2d.tip.kind', { kind: m.kind });
        break;
      case 'busway':
      case 'circuit':
      case 'tapoff':
        if (m.side !== undefined) add('view2d.tip.side', { side: String(m.side) });
        if (typeof m.ampacityA === 'number') add('view2d.tip.ampacity', { a: m.ampacityA });
        if (m.circuit !== undefined) add('view2d.tip.circuit', { c: String(m.circuit) });
        if (typeof m.equipmentId === 'string') add('view2d.tip.rack', { tag: eqById.get(m.equipmentId)?.tag ?? m.equipmentId });
        break;
      case 'pipe':
        add('view2d.tip.pipe', { sys: t(prim.system === 'cdu-return' || /#R\b/.test(r.primIdOf(i) ?? '') ? 'view2d.tip.return' : 'view2d.tip.supply') });
        if (prim.rowId) add('view2d.tip.row', { row: prim.rowId });
        break;
      case 'containment-panel':
      case 'containment-roof':
      case 'door':
        if (typeof m.kind === 'string') add('view2d.tip.kind', { kind: m.kind });
        if (typeof m.height === 'number') add('view2d.tip.height', { h: len(m.height) });
        if (typeof m.doorType === 'string') add('view2d.tip.doorType', { type: m.doorType });
        if (typeof m.leaves === 'number') add('view2d.tip.leaves', { n: m.leaves, swing: String(m.swing ?? '') });
        break;
      default:
        if (typeof m.kind === 'string') add('view2d.tip.kind', { kind: m.kind });
    }
    if (prim.z0 !== undefined && prim.z1 !== undefined && Number.isFinite(prim.z0)) add('view2d.tip.z', { z0: fmtLength(prim.z0, v.units), z1: fmtLength(prim.z1, v.units) });
    return { title: `${t(`view2d.emitter.${prim.emitter}`)} · ${prim.tag ?? prim.refId ?? r.primIdOf(i) ?? ''}`, lines };
  }, [eqById, t, v.units]);

  // ───────────── pointer ─────────────

  const local = (e: { clientX: number; clientY: number }) => {
    const b = rootRef.current!.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top] as const;
  };

  const snapCtx = useCallback(() => {
    const r = rendererRef.current!;
    const racks: Rect[] = [];
    const vis = visibleRect(r.view, r.w, r.h);
    for (const i of r.queryRect(vis)) if (EQUIPMENT.has(r.primOf(i)?.emitter ?? '') && racks.length < 4000) racks.push(r.itemRect(i));
    return { rows, rackRects: racks, containments: project.containments.filter((c) => c.hallId === hall?.id), tileSize: hall?.tileSize ?? 0.6, tol: 10 / r.view.ppm };
  }, [rows, project.containments, hall]);

  const measurePoint = useCallback((sx: number, sy: number): Pt2 => {
    const r = rendererRef.current!;
    const [x, y] = screenToWorld(r.view, r.w, r.h, sx, sy);
    if (!useApp.getState().view2d.snap) {
      snapMark.current = null;
      return [x, y];
    }
    const tol = 8 / r.view.ppm;
    const sp = snapPoint([x, y], r.snapPoints(x, y, tol), tol, space === 'plan' ? hall?.tileSize : undefined);
    snapMark.current = sp.snapped ? { x: sp.pt[0], y: sp.pt[1], label: t(`view2d.snap.${sp.snapped}`) } : null;
    return sp.pt;
  }, [space, hall?.tileSize, t]);

  const updateReadout = (sx: number, sy: number) => {
    const r = rendererRef.current;
    const el = readoutRef.current;
    if (!r || !el) return;
    const [x, y] = screenToWorld(r.view, r.w, r.h, sx, sy);
    const u = (m: number) => fmtLength(m, v.units);
    const suffix = v.units === 'metric' ? ' m' : '';
    el.textContent = `${space === 'plan' ? 'x' : 'u'} ${u(x)}  ${space === 'plan' ? 'y' : 'z'} ${u(y)}${suffix} · ${r.view.ppm.toFixed(1)} px/m · LOD ${space === 'plan' ? r.band : 3}`;
  };

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    const r = rendererRef.current;
    if (!r) return;
    setMenu(null);
    rootRef.current?.focus({ preventScroll: true });
    if (e.button === 2) return;
    const [sx, sy] = local(e);
    const tool = v.tool;
    const mode = e.button === 1 || spaceHeld.current || tool === 'pan' ? 'pan' : tool === 'cut' && space === 'plan' ? 'cut' : 'click';
    ptr.current = { id: e.pointerId, sx, sy, mode, moved: false, view0: r.view, button: e.button };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic / already released pointer */
    }
    setTip(null);
    clearTimeout(tipTimer.current);
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const r = rendererRef.current;
    if (!r) return;
    const [sx, sy] = local(e);
    updateReadout(sx, sy);
    const p = ptr.current;
    if (p && p.id === e.pointerId) {
      const dx = sx - p.sx;
      const dy = sy - p.sy;
      if (!p.moved && Math.hypot(dx, dy) > 4) {
        p.moved = true;
        if (p.mode === 'click' && v.tool === 'select') p.mode = 'marquee';
      }
      if (!p.moved) return;
      if (p.mode === 'pan') setView(panBy(p.view0, dx, dy), 'gesture');
      else if (p.mode === 'marquee') {
        marquee.current = { x0: p.sx, y0: p.sy, x1: sx, y1: sy };
        requestDraw('overlay');
      } else if (p.mode === 'cut') {
        const w0 = screenToWorld(r.view, r.w, r.h, p.sx, p.sy);
        const w1 = screenToWorld(r.view, r.w, r.h, sx, sy);
        cutPreview.current = cutFromDrag(w0, w1, snapCtx(), { free: e.altKey || !v.snap });
        snapMark.current = cutPreview.current.snap ? { x: cutPreview.current.seg[0], y: cutPreview.current.seg[1], label: t(`view2d.snap.${cutPreview.current.snap}`) } : null;
        requestDraw('overlay');
      }
      return;
    }
    if (v.tool === 'measure') {
      measureCursor.current = measurePoint(sx, sy);
      requestDraw('overlay');
    }
    const hit = r.pick(sx, sy);
    if (hit !== hovered.current) {
      hovered.current = hit;
      requestDraw('overlay');
      setTip(null);
    }
    clearTimeout(tipTimer.current);
    if (hit !== null) {
      tipTimer.current = setTimeout(() => {
        const d = describe(hit);
        if (d) setTip({ x: sx, y: sy, ...d });
      }, 250);
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const r = rendererRef.current;
    const p = ptr.current;
    if (!r || !p || p.id !== e.pointerId) return;
    ptr.current = null;
    const [sx, sy] = local(e);
    const st = useApp.getState();
    if (p.mode === 'pan') {
      requestDraw('gesture');
      return;
    }
    if (p.mode === 'marquee') {
      const m = marquee.current;
      marquee.current = null;
      if (m) {
        const [x0, y0] = screenToWorld(r.view, r.w, r.h, Math.min(m.x0, m.x1), Math.max(m.y0, m.y1));
        const [x1, y1] = screenToWorld(r.view, r.w, r.h, Math.max(m.x0, m.x1), Math.min(m.y0, m.y1));
        const ids = new Set<string>(e.ctrlKey || e.metaKey ? st.selection : []);
        for (const i of r.queryRect({ x: x0, y: y0, w: x1 - x0, d: y1 - y0 })) {
          const pr = r.primOf(i);
          if (pr && EQUIPMENT.has(pr.emitter) && pr.refId && eqById.has(pr.refId)) ids.add(pr.refId);
        }
        st.setSelection([...ids]);
      }
      requestDraw('overlay');
      return;
    }
    if (p.mode === 'cut') {
      const pv = cutPreview.current;
      cutPreview.current = null;
      snapMark.current = null;
      if (pv && hall && p.moved && Math.hypot(pv.seg[2] - pv.seg[0], pv.seg[3] - pv.seg[1]) * r.view.ppm > 12) {
        v.addCut({ hallId: hall.id, kind: 'free', axis: pv.axis, at: pv.at, look: pv.look, depthM: DEFAULT_CUT_DEPTH_M, window: pv.window });
      }
      requestDraw('overlay');
      return;
    }
    if (p.moved) return;
    if (v.tool === 'measure') {
      const pt = measurePoint(sx, sy);
      setMeasure((m) => (m.active ? { pts: [...m.pts, pt], active: true } : { pts: [pt], active: true }));
      return;
    }
    const hit = r.pick(sx, sy);
    const prim = hit !== null ? r.primOf(hit) : undefined;
    if (prim && EQUIPMENT.has(prim.emitter) && prim.refId && eqById.has(prim.refId)) {
      st.select(prim.refId, e.ctrlKey || e.metaKey);
      setLocalPrim(null);
    } else if (hit !== null) {
      setLocalPrim(r.primIdOf(hit) ?? null);
    } else {
      if (space === 'plan' && hall) {
        const [x, y] = screenToWorld(r.view, r.w, r.h, sx, sy);
        const hallRect = { x: 0, y: 0, w: hall.width, d: hall.depth };
        const nearest = hallCuts.map((cut) => {
          const seg = cutSegment(cut, hallRect);
          return { cut, d: seg ? segDist(x, y, seg[0], seg[1], seg[2], seg[3]) : Infinity };
        }).sort((a, b) => a.d - b.d)[0];
        if (nearest && nearest.d <= 8 / r.view.ppm) {
          v.set({ activeCutId: nearest.cut.id });
          setLocalPrim(null);
          requestDraw('overlay');
          return;
        }
      }
      if (!(e.ctrlKey || e.metaKey)) st.select(null);
      setLocalPrim(null);
    }
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = rendererRef.current;
    if (!r) return;
    if (v.tool === 'measure') {
      setMeasure((m) => ({ ...m, active: false }));
      return;
    }
    const [sx, sy] = local(e);
    const hit = r.pick(sx, sy);
    const prim = hit !== null ? r.primOf(hit) : undefined;
    if (prim?.podId && space === 'plan') {
      let rect: Rect | null = null;
      for (const row of rows.filter((x) => x.podId === prim.podId)) for (const id of row.memberIds) for (const i of r.itemsOfRef(id)) rect = unionRect(rect, r.itemRect(i));
      if (rect) setView(fitRect(padRect(rect, 0.15, 1.5), r.w, r.h, 0.04));
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const r = rendererRef.current;
    if (!r || !hall || space !== 'plan') return;
    const [sx, sy] = local(e);
    const [x, y] = screenToWorld(r.view, r.w, r.h, sx, sy);
    const items: MenuItem[] = [];
    const hit = r.pick(sx, sy);
    const prim = hit !== null ? r.primOf(hit) : undefined;
    const row = prim?.rowId ? rows.find((q) => q.id === prim.rowId) : rows.find((q) => (q.axis === 'x' ? Math.abs(y - q.center) < 0.7 && x >= q.a0 && x <= q.a1 : Math.abs(x - q.center) < 0.7 && y >= q.a0 && y <= q.a1));
    if (row) {
      const selectedEquipment = prim?.refId ? eqById.get(prim.refId) : undefined;
      items.push({ label: t('view2d.quick.crossSection'), run: () => { v.addCut(selectedEquipment ? crossSectionThroughEquipment(selectedEquipment, rows) ?? crossSectionThroughRow(row, rows, x, y) : crossSectionThroughRow(row, rows, x, y)); v.setMode('section'); } });
      items.push({ label: t('view2d.quick.rowSection'), run: () => { v.addCut(longSectionThroughRow(row)); v.setMode('section'); } });
      items.push({ label: t('view2d.quick.rowFace'), run: () => v.set({ mode: 'elevation', elevation: { kind: 'row-face', rowId: row.id, face: 'front' } }) });
    }
    const cont = project.containments.find((c) => c.hallId === hall.id && x >= c.rect.x && x <= c.rect.x + c.rect.w && y >= c.rect.y && y <= c.rect.y + c.rect.d);
    const aisle = cont?.rect ?? aisleAt(rows, 1.2, x, y);
    if (aisle) items.push({ label: t('view2d.quick.longSection'), run: () => { v.addCut(longSectionAlongAisle(aisle, hall.id)); v.setMode('section'); } });
    if (cont) items.push({ label: t('view2d.quick.aisleEnd'), run: () => v.set({ mode: 'elevation', elevation: { kind: 'aisle-end', containmentId: cont.id, end: 0 } }) });
    items.push({ label: t('view2d.quick.sectionHereX'), run: () => { v.addCut({ hallId: hall.id, kind: 'free', axis: 'y', at: y, look: 1, depthM: DEFAULT_CUT_DEPTH_M }); v.setMode('section'); } });
    items.push({ label: t('view2d.quick.sectionHereY'), run: () => { v.addCut({ hallId: hall.id, kind: 'free', axis: 'x', at: x, look: 1, depthM: DEFAULT_CUT_DEPTH_M }); v.setMode('section'); } });
    setMenu({ x: sx, y: sy, items });
  };

  // wheel zoom (non-passive)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const r = rendererRef.current;
      if (!r) return;
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setView(zoomAt(r.view, r.w, r.h, e.clientX - b.left, e.clientY - b.top, k), 'gesture');
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setView]);

  // ───────────── keys (scope view2d) ─────────────

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const ne = e.nativeEvent;
    if (ne.code === 'Space' && !isTypingTarget(ne.target)) {
      spaceHeld.current = true;
      e.preventDefault();
      return;
    }
    const k = pane2DKey(ne, measureRef.current.active);
    if (!k) return;
    let handled = true;
    switch (k) {
      case 'tool-select': v.set({ tool: 'select' }); break;
      case 'tool-pan': v.set({ tool: 'pan' }); break;
      case 'tool-measure': v.set({ tool: 'measure' }); break;
      case 'tool-cut': v.set(space === 'plan' ? { tool: 'cut' } : { tool: 'cut', mode: 'plan' }); break;
      case 'flip': v.flipActive(); break;
      case 'nudge-': v.nudgeActive(-NUDGE_TILE_M); break;
      case 'nudge+': v.nudgeActive(NUDGE_TILE_M); break;
      case 'nudge-fine-': v.nudgeActive(-NUDGE_FINE_M); break;
      case 'nudge-fine+': v.nudgeActive(NUDGE_FINE_M); break;
      case 'prev': v.cycle(-1, targets); break;
      case 'next': v.cycle(1, targets); break;
      case 'layers': v.set({ layersOpen: !v.layersOpen }); break;
      case 'annotations': v.set({ annotations: !v.annotations }); break;
      case 'snap': v.set({ snap: !v.snap }); break;
      case 'fit-hall': fitHall(); break;
      case 'zoom-in': zoom(1.25); break;
      case 'zoom-out': zoom(0.8); break;
      case 'fit-selection':
        fitSelection();
        handled = false; // the global F also frames the selection in 3D ("every visible pane")
        break;
      case 'measure-undo': setMeasure((m) => ({ pts: m.pts.slice(0, -1), active: m.pts.length > 1 })); break;
      case 'measure-end': setMeasure((m) => ({ ...m, active: false })); break;
      case 'escape':
        if (menu) setMenu(null);
        else if (cutPreview.current || marquee.current) {
          cutPreview.current = null;
          marquee.current = null;
          ptr.current = null;
          requestDraw('overlay');
        } else if (measureRef.current.active) setMeasure((m) => ({ ...m, active: false })); // Esc ends the chain (kept on screen)
        else if (measureRef.current.pts.length) setMeasure({ pts: [], active: false }); // a second Esc clears it
        else if (localPrim) setLocalPrim(null);
        else if (v.tool !== 'select') v.set({ tool: 'select' });
        else handled = false;
        break;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.code === 'Space') spaceHeld.current = false;
  };

  // ───────────── export ─────────────

  const baseName = `${project.id}-${hall?.id ?? 'hall'}-${space}${space === 'section' && activeCut ? `-${activeCut.label.split(/[–-]/)[0]}` : ''}`;
  const exportApi = useRef({ exportSvg: async () => {}, exportPng: async () => {}, fitHall: () => {}, zoom: (_k: number) => {} });
  exportApi.current = {
    exportSvg: async () => {
      const r = rendererRef.current;
      if (!r || !req || !scene) return;
      try {
        const svg = await exportSvgInWorker(project, analysis, {
          build: { type: 'build', key: 'export', ...req },
          world: visibleRect(r.view, r.w, r.h),
          widthPx: r.w,
          heightPx: r.h,
          layers: v.layers,
          lod: space === 'plan' ? (Math.max(1, r.band) as 1 | 2 | 3) : 3,
          title: `${hall?.name ?? ''} · ${t(`view2d.mode.${space}`)}`,
        });
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${baseName}.svg`);
        s.notify(t('view2d.toast.exported', { name: `${baseName}.svg` }), 'ok');
      } catch (err) {
        s.notify(t('view2d.toast.exportFailed', { msg: (err as Error).message }), 'error');
      }
    },
    exportPng: async () => {
      const r = rendererRef.current;
      if (!r || !scene) return;
      const scale = Math.min(4, 2 * (window.devicePixelRatio || 1));
      const c = document.createElement('canvas');
      c.width = Math.round(r.w * scale);
      c.height = Math.round(r.h * scale);
      const g = c.getContext('2d');
      if (!g) return;
      r.setOptions({ lite: false });
      r.render(g, r.w, r.h, scale, r.view);
      g.setTransform(scale, 0, 0, scale, 0, 0);
      r.drawScaleBar(g, r.w, r.h, r.view, space === 'plan' ? northLabel : undefined);
      await new Promise<void>((res) => c.toBlob((b) => {
        if (b) {
          downloadBlob(b, `${baseName}.png`);
          s.notify(t('view2d.toast.exported', { name: `${baseName}.png` }), 'ok');
        }
        res();
      }, 'image/png'));
    },
    fitHall,
    zoom,
  };
  useEffect(() => {
    const api = { exportSvg: () => exportApi.current.exportSvg(), exportPng: () => exportApi.current.exportPng(), fitHall: () => exportApi.current.fitHall(), zoom: (k: number) => exportApi.current.zoom(k) };
    pane2D.set(api);
    return () => {
      if (pane2D.get() === api) pane2D.set(null);
    };
  }, []);

  // ───────────── render ─────────────

  const T = tokens(v.theme);
  const localIdx = localPrim && rendererRef.current ? rendererRef.current.itemOfPrim(localPrim) : undefined;
  const localCard = localIdx !== undefined ? describe(localIdx) : null;
  const localInfo = localIdx !== undefined ? rendererRef.current?.primOf(localIdx) : undefined;
  const highlight3D = () => {
    const r = rendererRef.current;
    if (!r || localIdx === undefined || !localInfo) return;
    const st = useApp.getState();
    if (POWER.has(localInfo.emitter) && localInfo.refId) {
      st.setOverlays({ powerPaths: true });
      st.setPowerHighlight([localInfo.refId]);
    }
    const rect = r.itemRect(localIdx);
    let cx = rect.x + rect.w / 2;
    let cy = rect.y + rect.d / 2;
    let cz = localInfo.z1 ?? 2;
    if (space !== 'plan' && scene?.cut) {
      const w = frameToWorld(scene.cut, cx, 0);
      cz = cy;
      cx = w.x;
      cy = w.y;
    }
    if (!v.split) v.set({ split: true });
    const go = () => useApp.getState().viewerApi?.flyTo({ x: cx - 5, y: cy - 5, z: cz + 5, yaw: 45, pitch: -35 });
    if (v.split) go();
    else setTimeout(go, 900);
  };

  let empty: ReactNode = null;
  if (!hall) empty = t('view2d.empty.noHall');
  else if (space === 'section' && !activeCut)
    empty = (
      <>
        <div>{t('view2d.empty.section')}</div>
        <div className="row" style={{ gap: 6, justifyContent: 'center', marginTop: 8 }}>
          <button className="btn sm" onClick={() => v.set({ mode: 'plan', tool: 'cut' })}>{t('view2d.empty.drawCut')}</button>
          {rows.length > 0 && (
            <button className="btn sm" data-v2d-auto-section onClick={() => {
              const selected = project.equipment.find((e) => e.id === selection.at(-1));
              const selectedCut = selected ? crossSectionThroughEquipment(selected, rows) : null;
              const made = v.addCuts([...(selectedCut ? [selectedCut] : []), ...rows.map((row) => longSectionThroughRow(row))]);
              if (selectedCut && made[0]) v.set({ activeCutId: made[0].id });
            }}>{t('view2d.empty.autoSection', { n: rows.length })}</button>
          )}
        </div>
      </>
    );
  else if (space === 'elevation' && !elevation) empty = t('view2d.empty.elevation');

  const mr = measure.pts.length > 1 ? measureReadout(measure.pts, space, v.units) : null;

  return (
    <div className="v2d-pane" style={{ background: T.ground }} data-view2d={space} data-theme2d={v.theme}>
      <div
        ref={rootRef}
        className="v2d-canvas"
        tabIndex={0}
        data-keyscope="view2d"
        data-state={empty ? 'empty' : loading && !scene ? 'loading' : error ? 'error' : 'ready'}
        data-items={scene?.counts.items ?? 0}
        data-tool={v.tool}
        style={{ cursor: v.tool === 'pan' ? 'grab' : v.tool === 'select' ? 'default' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { ptr.current = null; marquee.current = null; cutPreview.current = null; requestDraw('overlay'); }}
        onPointerLeave={() => { if (!ptr.current) { hovered.current = null; setTip(null); clearTimeout(tipTimer.current); requestDraw('overlay'); } }}
        onPointerEnter={() => {
          const a = document.activeElement;
          if (!a || a === document.body || rootRef.current?.closest('.viewport')?.contains(a)) rootRef.current?.focus({ preventScroll: true });
        }}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        aria-label={t(`view2d.mode.${space}`)}
      >
        <canvas ref={baseRef} className="v2d-base" />
        <canvas ref={overRef} className="v2d-overlay" />
      </div>
      {showToolbar && <div className="v2d-pane-toolbar"><View2DTools /></div>}
      <LayersPanel />
      {empty && <div className="v2d-empty glass" data-v2d-empty>{empty}</div>}
      {error && !empty && <div className="v2d-empty glass">{t('view2d.error', { msg: error })}</div>}
      {tip && !menu && (
        <div ref={tipRef} className="v2d-tip glass" style={{ left: tip.x + 14, top: tip.y + 14 }} data-v2d-tip>
          <strong className="mono">{tip.title}</strong>
          {tip.lines.map((l, i) => <div key={i} className="hint">{l}</div>)}
        </div>
      )}
      {menu && (
        <div className="v2d-menu glass" style={{ left: menu.x, top: menu.y }} role="menu" data-v2d-quick>
          {menu.items.map((it, i) => (
            <button key={i} className="btn ghost sm" role="menuitem" onClick={() => { setMenu(null); it.run(); }}>{it.label}</button>
          ))}
        </div>
      )}
      {localCard && (
        <div className="v2d-card glass" data-v2d-card>
          <div className="row"><strong className="mono" style={{ fontSize: 12 }}>{localCard.title}</strong><span className="grow" /><button className="btn ghost sm" onClick={() => setLocalPrim(null)} aria-label={t('view2d.close')}>✕</button></div>
          {localCard.lines.map((l, i) => <div key={i} className="hint">{l}</div>)}
          <div className="hint" style={{ marginTop: 4 }}>{t('view2d.localHint')}</div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={highlight3D}>{t('view2d.highlight3d')}</button>
        </div>
      )}
      {mr && (
        <div className="v2d-measure glass" data-v2d-measure>
          <strong>{t('view2d.tool.measure')}</strong>
          {mr.segments.map((sg, i) => <div key={i} className="mono hint">L {sg.L} · {mr.axes[0]} {sg.d1} · {mr.axes[1]} {sg.d2}</div>)}
          <div className="mono">{t('view2d.measureTotal', { total: mr.total })}{v.units === 'metric' ? ' m' : ''}</div>
          <div className="hint">{t('view2d.measureHint')}</div>
        </div>
      )}
      <div className="v2d-status">
        {loading && <span className="hint">{t('view2d.building')}</span>}
        {scene && <span className="hint" data-v2d-counts>{t('view2d.counts', { items: scene.counts.items.toLocaleString(), ms: Math.round(scene.ms.total) })}{scene.clearance.length ? ` · ${t('view2d.clearance', { n: scene.clearance.length })}` : ''}</span>}
        <span ref={readoutRef} className="mono v2d-readout" data-v2d-readout />
      </div>
    </div>
  );
}
