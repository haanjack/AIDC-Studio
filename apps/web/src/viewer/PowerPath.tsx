// 3D power plane (stream T3, DECISIONS-v2-2 §B): busway circuits A/B with loading heat, tap-off drops to rack tops,
// feeders to the electrical rooms outside the hall, scenario colouring (failed runs grey, overloaded runs red and pulsing
// unless the user prefers reduced motion, dropped racks dimmed, capped / bypass / single-path rack plates) and
// one-line ↔ 3D highlighting. Geometry is merged per material (a handful of draw calls regardless of hall size).
// r4 A1 (G7): the geometry comes from the circuit / feeder / tap-off / electrical-room scene prims; the analysis paths only colour them.
// Mounted in Viewer3D inside the hall group when `overlays.powerPaths` is true. The viewer stays store- and i18n-free:
// the only text is technical abbreviations (SWBD A/B, kW).
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { buildPowerPlane, primAabb, type Hall, type HallPrims, type PowerPath, type PowerRoom, type PowerScenarioResult, type Prim, type Project } from '@aidc/core';
import { mergeParts, partsByMat, POWER_SIDE_COLORS, POWER_STATE_COLORS, powerPlaneParts } from './geometry/primMeshes.ts';
import { usePrimSubset } from './geometry/usePrims.ts';

export { POWER_SIDE_COLORS, POWER_STATE_COLORS } from './geometry/primMeshes.ts';
export { Penetrations } from './Penetrations.tsx';

export interface PowerPathOverlayProps {
  hall: Hall;
  project: Project;
  /** scene prims of the hall (pod detail: tap-off drop bars) */
  prims: HallPrims | null;
  paths?: PowerPath[];
  /** sized electrical rooms from the analysis (analysis.power.rooms); with `paths` the overlay never builds its own power plane */
  rooms?: PowerRoom[];
  highlightIds?: string[];
  scenario?: PowerScenarioResult | null;
}

const POWER = new Set<Prim['emitter']>(['circuit', 'feeder', 'tapoff', 'room', 'rack', 'unit']);
const isPower = (p: Prim) => POWER.has(p.emitter) && (p.emitter !== 'tapoff' || p.shape === 'bar') && (p.emitter !== 'room' || p.layer === 'electrical-rooms');
const prefersReducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const noRaycast = () => null;

export function PowerPathOverlay({ hall, project, prims, paths, highlightIds, scenario }: PowerPathOverlayProps) {
  // polish v2 2차 (QA m8): reuse analysis.power.paths; only a viewer without an analysis builds the plane (once, memoised) for colours
  const fallback = useMemo(() => (paths ? null : buildPowerPlane(project)), [paths, project]);
  const allPaths = paths ?? fallback?.paths ?? [];
  const sub = usePrimSubset(prims, isPower);

  const geo = useMemo(() => {
    const parts = powerPlaneParts(sub.prims, { paths: allPaths.filter((p) => p.hallId === hall.id), scenario, highlightIds });
    const out: Record<string, THREE.BufferGeometry | null> = {};
    for (const [mat, list] of partsByMat(parts)) out[mat] = mergeParts(list, { colors: true });
    for (const p of parts) p.g.dispose();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.key, allPaths, hall.id, scenario, highlightIds]);
  useEffect(() => () => Object.values(geo).forEach((g) => g?.dispose()), [geo]);

  const rooms = useMemo(() => sub.prims.filter((p) => p.emitter === 'room'), [sub]);
  const roomEdges = useMemo(() => ({ A: geo['rooms-A'] ? new THREE.EdgesGeometry(geo['rooms-A']) : null, B: geo['rooms-B'] ? new THREE.EdgesGeometry(geo['rooms-B']) : null }), [geo]);
  useEffect(() => () => Object.values(roomEdges).forEach((g) => g?.dispose()), [roomEdges]);

  const mats = useMemo(
    () => ({
      colored: new THREE.MeshBasicMaterial({ vertexColors: true }),
      over: new THREE.MeshBasicMaterial({ color: POWER_STATE_COLORS.over }),
      glow: new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28, depthWrite: false }),
      veil: new THREE.MeshBasicMaterial({ color: '#05070a', transparent: true, opacity: 0.62, depthWrite: false }),
      roomA: new THREE.MeshBasicMaterial({ color: POWER_SIDE_COLORS.A, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
      roomB: new THREE.MeshBasicMaterial({ color: POWER_SIDE_COLORS.B, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }),
      edgeA: new THREE.LineBasicMaterial({ color: POWER_SIDE_COLORS.A }),
      edgeB: new THREE.LineBasicMaterial({ color: POWER_SIDE_COLORS.B }),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const reduced = useRef(prefersReducedMotion());
  const base = useMemo(() => new THREE.Color(POWER_STATE_COLORS.over), []);
  const bright = useMemo(() => new THREE.Color('#ff9a9a'), []);
  useFrame((state) => {
    if (!geo.over) return;
    if (reduced.current) {
      mats.over.color.copy(base);
      return;
    }
    mats.over.color.copy(base).lerp(bright, 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 5));
  });

  const roomKW = (id: string, side: 'A' | 'B') => {
    const el = scenario?.elements?.find((e) => e.id === id);
    if (el) return el.loadKW;
    return allPaths.filter((p) => p.kind === 'feeder' && p.fromId === id && p.side === side).reduce((s, p) => s + (p.connectedKW ?? 0), 0);
  };

  return (
    <group name="aidc-power-plane">
      {(['runs', 'feeders', 'taps', 'plates'] as const).map((k) => (geo[k] ? <mesh key={k} geometry={geo[k]!} material={mats.colored} raycast={noRaycast} /> : null))}
      {geo.over && <mesh geometry={geo.over} material={mats.over} raycast={noRaycast} />}
      {geo.glow && <mesh geometry={geo.glow} material={mats.glow} raycast={noRaycast} renderOrder={2} />}
      {geo.veil && <mesh geometry={geo.veil} material={mats.veil} raycast={noRaycast} renderOrder={3} />}
      {geo['rooms-A'] && <mesh geometry={geo['rooms-A']} material={mats.roomA} raycast={noRaycast} renderOrder={1} />}
      {geo['rooms-B'] && <mesh geometry={geo['rooms-B']} material={mats.roomB} raycast={noRaycast} renderOrder={1} />}
      {roomEdges.A && <lineSegments geometry={roomEdges.A} material={mats.edgeA} raycast={noRaycast} />}
      {roomEdges.B && <lineSegments geometry={roomEdges.B} material={mats.edgeB} raycast={noRaycast} />}
      {rooms.map((r) => {
        const b = primAabb(r);
        const side = r.meta?.side === 'B' ? 'B' : 'A';
        return (
          <Html key={r.id} position={[(b.min.x + b.max.x) / 2, b.max.z + 0.3, -(b.min.y + b.max.y) / 2]} center zIndexRange={[20, 0]} style={{ pointerEvents: 'none' }}>
            <div style={{ background: 'rgba(10,14,18,0.85)', border: `1px solid ${POWER_SIDE_COLORS[side]}`, borderRadius: 4, padding: '2px 6px', color: '#dfe6ee', font: '11px/1.3 system-ui, sans-serif', whiteSpace: 'nowrap' }}>
              SWBD {side} · {Math.round(roomKW(String(r.meta?.switchboardId ?? ''), side)).toLocaleString('en-US')} kW
            </div>
          </Html>
        );
      })}
    </group>
  );
}
