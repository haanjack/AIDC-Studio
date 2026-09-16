// Overhead infrastructure of one hall, drawn from the scene prims (r4 A1, spec S1): ladder trays, vertical tray drops and per-rack cable
// drops (G4 / G5), busways at 0.17 m (G3) with tap-off boxes on both A and B (G6), TCS supply / return pipes (cut at columns, G2) and
// pipe fittings when a derived pipe network is present, plus hanger rods to the ceiling (decoration). The prims come from
// `buildHallPrims(project, analysis, { detail: 'pod' })` — the list the 2D view, the sheets and the wall audit read — so the old
// viewer-side row detection and fallback derivation are gone (G1).
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Hall, HallPrims, Prim } from '@aidc/core';
import { buswayParts, disposeParts, mergeParts, partsByMat, pipeParts, trayParts } from './geometry/primMeshes.ts';
import { usePrimSubset } from './geometry/usePrims.ts';

export { CableRuns } from './CableRuns.tsx';

const OVERHEAD = new Set<Prim['emitter']>(['tray', 'drop', 'busway', 'tapoff', 'pipe', 'fitting']);
const isOverhead = (p: Prim) => OVERHEAD.has(p.emitter) && !(p.emitter === 'tapoff' && p.shape !== 'box');

export function Trays({ hall, prims, rods: showRods = false }: { hall: Hall; prims: HallPrims | null; rods?: boolean }) {
  const sub = usePrimSubset(prims, isOverhead);
  const geo = useMemo(() => {
    const parts = [...trayParts(sub.prims, showRods ? { rodTop: hall.clearHeight } : {}), ...buswayParts(sub.prims), ...pipeParts(sub.prims)];
    const out: Record<string, THREE.BufferGeometry | null> = {};
    for (const [mat, list] of partsByMat(parts)) out[mat] = mergeParts(list);
    disposeParts(parts);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.key, showRods, hall.clearHeight]);

  const mats = useMemo<Record<string, THREE.Material>>(
    () => ({
      tray: new THREE.MeshStandardMaterial({ color: '#f2b705', roughness: 0.45, metalness: 0.05 }),
      busway: new THREE.MeshStandardMaterial({ color: '#1f2225', roughness: 0.4, metalness: 0.7 }),
      tapoff: new THREE.MeshStandardMaterial({ color: '#40464d', roughness: 0.5, metalness: 0.5 }),
      supply: new THREE.MeshStandardMaterial({ color: '#1e63c8', roughness: 0.3, metalness: 0.3, side: THREE.DoubleSide }),
      return: new THREE.MeshStandardMaterial({ color: '#c62828', roughness: 0.3, metalness: 0.3, side: THREE.DoubleSide }),
      fitting: new THREE.MeshStandardMaterial({ color: '#2f3a44', roughness: 0.5, metalness: 0.6 }),
      rods: new THREE.MeshStandardMaterial({ color: '#6b7178', roughness: 0.5, metalness: 0.6 }),
    }),
    [],
  );
  useEffect(() => () => Object.values(geo).forEach((g) => g?.dispose()), [geo]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  return (
    <group>
      {Object.entries(geo).map(([k, g]) => (g && mats[k] ? <mesh key={k} geometry={g} material={mats[k]} castShadow={false} receiveShadow raycast={() => null} /> : null))}
    </group>
  );
}
