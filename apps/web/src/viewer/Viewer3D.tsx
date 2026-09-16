import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AdaptiveDpr, PerformanceMonitor, Stats } from '@react-three/drei';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { buildHallPrims, findCatalogItem, type CatalogItem, type EquipmentInstance } from '@aidc/core';
import { Airflow } from './Airflow.tsx';
import { AIR_PATH_COLORS, AirPathOverlay } from './AirPaths.tsx';
import { CameraRig, type RigHandle } from './CameraRig.tsx';
import { CATEGORY_COLORS, NETWORK_ROLE_COLORS, WAVE_COLORS, cfdGradientCss, valueColor, valueGradientCss } from './colormap.ts';
import { Containments } from './Containment.tsx';
import { EquipmentLayer } from './Equipment.tsx';
import { prepareField, rackInletTemp, type PreparedField } from './field.ts';
import { HallLights, HallShell } from './Hall.tsx';
import { Labels } from './Labels.tsx';
import { PlainRender, PostFX } from './PostFX.tsx';
import { viewerStatus } from './status.ts';
import { FloorHeatmap, ThermalSlice, ThermalVolume } from './Thermal.tsx';
import { Trays } from './Trays.tsx';
import { CableRuns } from './CableRuns.tsx';
import { PowerPathOverlay } from './PowerPath.tsx';
import { Penetrations } from './Penetrations.tsx';
import { useT, type TParams } from '../i18n/index.ts';
import { equipmentTooltip } from '../view2d/equipmentTooltip.ts';
import { CutPlane3D } from '../view2d/CutPlane3D.tsx';
import { FrameGate3D, useGesture2D } from '../view2d/FrameGate3D.tsx';

type Tr = (key: string, params?: TParams) => string;
import type { ColorMode, ViewerApi, Viewer3DProps } from './types.ts';

type Legend =
  | { kind: 'none' }
  | { kind: 'ramp'; title: string; unit: string; min: number; max: number; gradient: string }
  | { kind: 'swatches'; title: string; entries: { label: string; color: string }[] };

const RACK_CATS = new Set(['gpu-rack', 'cpu-rack', 'storage-rack', 'network-rack', 'mgmt-rack']);
const CAT_LABEL_KEY: Record<string, string> = {
  'gpu-rack': 'shell.viewer.cat.gpuRack',
  'cpu-rack': 'shell.viewer.cat.cpuRack',
  'storage-rack': 'shell.viewer.cat.storageRack',
  'network-rack': 'shell.viewer.cat.networkRack',
  'mgmt-rack': 'shell.viewer.cat.mgmtRack',
};
const CAT_ABBR: Record<string, string> = { cdu: 'CDU', crah: 'CRAH' };
const catLabel = (t: Tr, k: string) => (CAT_LABEL_KEY[k] ? t(CAT_LABEL_KEY[k]) : CAT_ABBR[k] ?? k);
const ROLE_LABEL: Record<string, string> = {
  'scale-out-leaf': 'Scale-out Leaf',
  'scale-out-spine': 'Scale-out Spine',
  'scale-out-core': 'Core',
  frontend: 'Front-end',
  storage: 'Storage',
  oob: 'OOB',
  mixed: 'Mixed',
};
const roleLabel = (t: Tr, r: string) => (r === 'none' ? t('shell.viewer.role.none') : ROLE_LABEL[r] ?? r);

function computeColors(
  mode: ColorMode,
  items: EquipmentInstance[],
  rackValues: Record<string, number> | undefined,
  rackValueRange: [number, number] | undefined,
  field: PreparedField | null,
  t: Tr,
): { colors: Map<string, THREE.Color> | null; legend: Legend } {
  if (mode === 'realistic') return { colors: null, legend: { kind: 'none' } };
  const colors = new Map<string, THREE.Color>();
  const neutral = new THREE.Color('#4a4f56');
  if (mode === 'category') {
    const seen = new Set<string>();
    for (const e of items) {
      const item = findCatalogItem(e.catalogId);
      if (!item) continue;
      const c = CATEGORY_COLORS[item.category] ?? CATEGORY_COLORS.other;
      colors.set(e.id, new THREE.Color(c));
      seen.add(item.category);
    }
    return { colors, legend: { kind: 'swatches', title: t('shell.viewer.legend.category'), entries: [...seen].map((k) => ({ label: catLabel(t, k), color: CATEGORY_COLORS[k] ?? CATEGORY_COLORS.other })) } };
  }
  if (mode === 'wave') {
    const waves = [...new Set(items.map((e) => e.waveId ?? '-'))].sort();
    for (const e of items) colors.set(e.id, new THREE.Color(WAVE_COLORS[waves.indexOf(e.waveId ?? '-') % WAVE_COLORS.length]));
    return { colors, legend: { kind: 'swatches', title: t('shell.viewer.legend.wave'), entries: waves.map((w, i) => ({ label: w, color: WAVE_COLORS[i % WAVE_COLORS.length] })) } };
  }
  if (mode === 'network-role') {
    const seen = new Set<string>();
    for (const e of items) {
      const item = findCatalogItem(e.catalogId);
      const role = e.networkRole ?? (item?.category === 'network-rack' ? 'mixed' : 'none');
      colors.set(e.id, new THREE.Color(NETWORK_ROLE_COLORS[role] ?? NETWORK_ROLE_COLORS.none));
      seen.add(role);
    }
    return { colors, legend: { kind: 'swatches', title: t('shell.viewer.legend.networkRole'), entries: [...seen].map((r) => ({ label: roleLabel(t, r), color: NETWORK_ROLE_COLORS[r] ?? NETWORK_ROLE_COLORS.none })) } };
  }
  // value modes
  const values = new Map<string, number>();
  for (const e of items) {
    const item = findCatalogItem(e.catalogId);
    if (!item) continue;
    let v = rackValues?.[e.id];
    if (v === undefined) {
      if (mode === 'power') v = (item.power?.nameplateKW ?? NaN) * (e.loadFactor ?? 1);
      else v = field && RACK_CATS.has(item.category) ? rackInletTemp(field, e, item) : NaN;
    }
    if (Number.isFinite(v)) values.set(e.id, v!);
  }
  let range = rackValueRange;
  if (!range) {
    if (mode === 'power') range = [0, Math.max(1, ...values.values())];
    else range = [20, 40];
  }
  const span = Math.max(1e-6, range[1] - range[0]);
  for (const e of items) {
    const v = values.get(e.id);
    colors.set(e.id, v === undefined ? neutral.clone() : valueColor((v - range[0]) / span));
  }
  return {
    colors,
    legend: mode === 'power' ? { kind: 'ramp', title: t('shell.viewer.legend.rackPower'), unit: 'kW', min: range[0], max: range[1], gradient: valueGradientCss() } : { kind: 'ramp', title: t('shell.viewer.legend.rackInlet'), unit: '°C', min: range[0], max: range[1], gradient: valueGradientCss() },
  };
}

function SceneSetup({ items }: { items: EquipmentInstance[] }) {
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const shadowFrames = useRef(240);
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    scene.environmentIntensity = 0.55;
    scene.background = new THREE.Color('#0a0d11');
    gl.toneMapping = THREE.NoToneMapping;
    gl.info.autoReset = false;
    gl.shadowMap.autoUpdate = false;
    gl.shadowMap.needsUpdate = true;
    try {
      const ctx = gl.getContext();
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      viewerStatus.renderer = ext ? String(ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(ctx.getParameter(ctx.RENDERER));
    } catch {
      /* ignore */
    }
    return () => {
      env.dispose();
      pmrem.dispose();
      scene.environment = null;
    };
  }, [gl, scene]);
  useEffect(() => {
    shadowFrames.current = Math.max(shadowFrames.current, 90);
  }, [items]);
  useFrame((state, dt) => {
    state.gl.info.reset();
    if (shadowFrames.current > 0 && (shadowFrames.current-- % 15 === 0 || viewerStatus.glbPending > 0)) state.gl.shadowMap.needsUpdate = true;
    viewerStatus.frames++;
    perf.t += dt;
    perf.n++;
    if (perf.t >= 1) {
      viewerStatus.fps = Math.round((perf.n / perf.t) * 10) / 10;
      perf.t = 0;
      perf.n = 0;
    }
  }, -1);
  useFrame((state) => {
    viewerStatus.drawCalls = state.gl.info.render.calls;
    viewerStatus.triangles = state.gl.info.render.triangles;
    if (viewerStatus.frames % 120 === 30) {
      const err = state.gl.getContext().getError();
      if (err && !viewerStatus.glError) viewerStatus.glError = err;
    }
  }, 2);
  return null;
}
const perf = { t: 0, n: 0 };

function ApiBridge({ onReady, rig, exportRoot }: { onReady?: (api: ViewerApi) => void; rig: React.MutableRefObject<RigHandle | null>; exportRoot: React.RefObject<THREE.Group | null> }) {
  const gl = useThree((s) => s.gl);
  // Stable API object: consumers commonly pass an inline onReady that stores the api in state; handing
  // back the same object keeps that a no-op update instead of an effect ⇄ render loop.
  const api = useMemo<ViewerApi>(
    () => ({
      screenshot: () => gl.domElement.toDataURL('image/png'),
      exportGlb: async () => {
        const root = exportRoot.current;
        if (!root) throw new Error('scene not ready');
        const hidden: THREE.Object3D[] = [];
        root.traverse((o) => {
          if (o.userData.pick && o.visible) {
            o.visible = false;
            hidden.push(o);
          }
        });
        try {
          const res = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true });
          return res as ArrayBuffer;
        } finally {
          hidden.forEach((o) => (o.visible = true));
        }
      },
      focusEquipment: (id: string) => rig.current?.focus(id),
      // S4 fly camera
      flyTo: (pose, dur) => rig.current?.flyTo(pose, dur),
      getCameraPose: () => rig.current?.getPose() ?? { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
    }),
    [gl, rig, exportRoot],
  );
  const notified = useRef<{ api: ViewerApi; cb: ((a: ViewerApi) => void) | undefined } | null>(null);
  useEffect(() => {
    if (!onReady) return;
    // notify once per api instance (a new inline callback with the same api does not re-notify)
    if (notified.current?.api === api) return;
    notified.current = { api, cb: onReady };
    onReady(api);
  }, [api, onReady]);
  return null;
}

function LegendView({ legend, thermal, airPaths }: { legend: Legend; thermal: [number, number] | null; airPaths: boolean }) {
  const t = useT();
  const box: React.CSSProperties = {
    background: 'rgba(10,14,18,0.82)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    padding: '8px 10px',
    color: '#dfe6ee',
    font: '12px/1.3 system-ui, sans-serif',
    minWidth: 180,
  };
  if (legend.kind === 'none' && !thermal && !airPaths) return null;
  return (
    <div style={{ position: 'absolute', left: 12, bottom: 12, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      {legend.kind === 'ramp' && (
        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {legend.title} ({legend.unit})
          </div>
          <div style={{ height: 10, borderRadius: 3, background: legend.gradient }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.8, marginTop: 2 }}>
            <span>{legend.min.toFixed(0)}</span>
            <span>{((legend.min + legend.max) / 2).toFixed(0)}</span>
            <span>{legend.max.toFixed(0)}</span>
          </div>
        </div>
      )}
      {legend.kind === 'swatches' && (
        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{legend.title}</div>
          {legend.entries.map((e) => (
            <div key={e.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: e.color, display: 'inline-block' }} />
              {e.label}
            </div>
          ))}
        </div>
      )}
      {thermal && (
        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('shell.viewer.legend.airTempCfd')}</div>
          <div style={{ height: 10, borderRadius: 3, background: cfdGradientCss() }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', opacity: 0.8, marginTop: 2 }}>
            <span>{thermal[0].toFixed(0)}</span>
            <span>{((thermal[0] + thermal[1]) / 2).toFixed(0)}</span>
            <span>{thermal[1].toFixed(0)}</span>
          </div>
        </div>
      )}
      {airPaths && (
        <div style={box}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t('shell.viewer.legend.airPath')}</div>
          {[
            [t('shell.viewer.legend.supplyAir'), AIR_PATH_COLORS.supply],
            [t('shell.viewer.legend.returnAir'), AIR_PATH_COLORS.return],
            [t('shell.viewer.legend.exhaustRise'), AIR_PATH_COLORS.exhaust],
          ].map(([label, color]) => (
            <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 16, height: 3, borderRadius: 2, background: color, display: 'inline-block' }} />
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Viewer3D(props: Viewer3DProps): JSX.Element {
  const { project, hallId, analysis, field, fieldAnchor, airReturnMode, overlays, colorMode, rackValues, rackValueRange, selection, onSelect, editMode, onMoveEquipment, cameraPreset, cameraNonce, cameraMode, showStats, onReady } = props;
  const t = useT();
  const hall = project.halls.find((h) => h.id === hallId) ?? project.halls[0];
  const items = useMemo(() => project.equipment.filter((e) => e.hallId === hall?.id), [project.equipment, hall?.id]);
  // r4 A1 (spec S1): one geometry source — the hall shell, containment, trays / busways / pipes, power plane and sleeves draw these prims
  const hallPrims = useMemo(() => (hall ? buildHallPrims(project, analysis ?? null, { hallId: hall.id, detail: 'pod' }) : null), [project, analysis, hall?.id]);
  const needsRaster = !!field && !field.solid;

  // field buffers/textures persist across solver snapshots with the same grid (updated in place)
  const prevField = useRef<PreparedField | null>(null);
  const prepared = useMemo(
    () => {
      if (!field || !hall) return null;
      const pf = prepareField(field, fieldAnchor, project, hall.id, prevField.current);
      prevField.current = pf;
      return pf;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field, fieldAnchor?.x, fieldAnchor?.y, hall?.id, needsRaster ? project.equipment : null],
  );
  useEffect(() => {
    if (!prepared && prevField.current) {
      prevField.current.dispose();
      prevField.current = null;
    }
  }, [prepared]);
  useEffect(
    () => () => {
      prevField.current?.dispose();
      prevField.current = null;
    },
    [],
  );
  const fieldVersion = prepared?.version ?? -1;
  const clipRect = useMemo<[number, number, number, number]>(() => [0, 0, hall?.width ?? 0, hall?.depth ?? 0], [hall?.width, hall?.depth]);

  const { colors, legend } = useMemo(
    () => computeColors(colorMode, items, rackValues, rackValueRange, prepared, t),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colorMode, items, rackValues, rackValueRange, prepared, fieldVersion, t],
  );

  const rig = useRef<RigHandle | null>(null);
  const exportRoot = useRef<THREE.Group>(null);
  const [dpr, setDpr] = useState(() => Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 1.75));
  const flags = (typeof window !== 'undefined' && window.__AIDC_VIEWER_FLAGS) || {};
  // 0 = full post-processing, 1 = without AO, 2 = plain render (automatic fallback on black frames)
  const [fxLevel, setFxLevel] = useState(() => (flags.postfx === false ? 2 : flags.ao === false ? 1 : 0));
  viewerStatus.fxLevel = fxLevel;
  // r4 QA view2d: pause the 3D render loop while the 2D pane in Split is being panned / zoomed (view2d/FrameGate3D.tsx)
  const gesture2d = useGesture2D();

  // r4: one tooltip builder for the 3D view and the 2D view (view2d/equipmentTooltip.ts)
  const tooltip = (e: EquipmentInstance, item: CatalogItem) =>
    equipmentTooltip(t, e, item, { inletC: prepared && RACK_CATS.has(item.category) ? rackInletTemp(prepared, e, item) : undefined, value: rackValues?.[e.id], roleLabel: (r) => roleLabel(t, r) });

  if (!hall) return <div style={{ color: '#ccc', padding: 16 }}>{t('shell.viewer.noHall')}</div>;
  const thermalOn = !!prepared && overlays.thermal.mode !== 'off';
  const clip = clipRect;
  const runs = analysis?.network?.cableRuns ?? [];
  const returnMode = airReturnMode ?? (hall.ceilingPlenumHeight > 0 ? 'plenum' : 'top');

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: '#0a0d11', overflow: 'hidden' }}>
      <Canvas
        frameloop={gesture2d ? 'never' : 'always'}
        shadows={{ enabled: true, type: THREE.PCFShadowMap }}
        dpr={dpr}
        gl={{ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', stencil: false, alpha: false }}
        camera={{ fov: 45, near: 0.05, far: 3000, position: [-10, 30, 10] }}
        onPointerMissed={(e) => {
          if (e.button === 0) onSelect(null, false);
        }}
      >
        <PerformanceMonitor onDecline={() => setDpr((d) => Math.max(1, d - 0.25))} onIncline={() => setDpr((d) => Math.min(2, d + 0.25))} />
        <AdaptiveDpr pixelated={false} />
        <SceneSetup items={items} />
        <HallLights hall={hall} items={items} />
        <group ref={exportRoot} name="aidc-hall">
          <HallShell hall={hall} overlays={overlays} prims={hallPrims} />
          <EquipmentLayer hall={hall} items={items} colors={colors} selection={selection} editMode={!!editMode} onSelect={onSelect} onMoveEquipment={onMoveEquipment} tooltip={tooltip} />
          {overlays.containment && <Containments hall={hall} prims={hallPrims} />}
          {overlays.airflow && <AirPathOverlay hall={hall} items={items} containments={project.containments.filter((c) => c.hallId === hall.id)} returnMode={returnMode} />}
          {overlays.trays && <Trays hall={hall} prims={hallPrims} rods={overlays.ceiling} />}
          {overlays.cables && runs.length > 0 && <CableRuns hall={hall} items={items} runs={runs} trays={project.trays} allEquipment={project.equipment} sleeves={analysis?.network.penetrations} containments={project.containments} />}
          {overlays.powerPaths && <PowerPathOverlay hall={hall} project={project} prims={hallPrims} paths={analysis?.power.paths} rooms={analysis?.power.rooms} scenario={props.powerScenario} highlightIds={props.powerHighlightIds} />}
          {(overlays.powerPaths || overlays.cables) && (
            <Penetrations hall={hall} prims={hallPrims} penetrations={[...(overlays.powerPaths ? analysis?.power.penetrations ?? [] : []), ...(overlays.cables ? analysis?.network.penetrations ?? [] : [])]} pathways={overlays.cables ? analysis?.network.interHallPathways : undefined} />
          )}
        </group>
        <CutPlane3D hall={hall} />
        <FrameGate3D />
        {prepared && (overlays.thermal.mode === 'slice' || overlays.thermal.mode === 'both') && (
          <ThermalSlice field={prepared} axis={overlays.thermal.axis} position={overlays.thermal.position} opacity={overlays.thermal.opacity} rangeC={overlays.thermal.rangeC} clip={clip} version={fieldVersion} />
        )}
        {prepared && (overlays.thermal.mode === 'volume' || overlays.thermal.mode === 'both') && <ThermalVolume field={prepared} rangeC={overlays.thermal.rangeC} opacity={overlays.thermal.opacity} clip={clip} version={fieldVersion} />}
        {prepared && overlays.heatmapFloor && <FloorHeatmap field={prepared} rangeC={overlays.thermal.rangeC} clip={clip} version={fieldVersion} />}
        {prepared && overlays.airflow && prepared.vel && <Airflow field={prepared} rangeC={overlays.thermal.rangeC} clip={clip} version={fieldVersion} />}
        {overlays.labels && <Labels hall={hall} items={items} />}
        <CameraRig hall={hall} project={project} preset={cameraPreset ?? 'iso'} nonce={cameraNonce} rigRef={rig} mode={cameraMode ?? 'orbit'} />
        {fxLevel < 2 ? (
          <PostFX ao={fxLevel === 0} nanGuard={flags.nanGuard !== false} aoHalfRes={flags.aoHalfRes !== false} onBlackFrame={flags.autoFallback === false ? undefined : () => setFxLevel((l) => Math.min(2, l + 1))} />
        ) : (
          <PlainRender />
        )}
        <ApiBridge onReady={onReady} rig={rig} exportRoot={exportRoot} />
        {showStats && <Stats />}
      </Canvas>
      <LegendView legend={legend} thermal={thermalOn || (overlays.airflow && prepared) || (overlays.heatmapFloor && prepared) ? overlays.thermal.rangeC : null} airPaths={overlays.airflow} />
    </div>
  );
}
