import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Hall, HallPrims, Prim } from '@aidc/core';
import { containmentParts, disposeParts, mergeParts, partsByMat } from './geometry/primMeshes.ts';
import { usePrimSubset } from './geometry/usePrims.ts';

/**
 * Aisle containment from the scene prims (r4 A1, G8): aluminium frame, end doors per `Containment.doorType` (sliding or swing-double)
 * only where `endDoors` is set, glass roof panels or chimney walls to the ceiling plenum when ductedToPlenum, blanking behind the rack
 * lines. Axis-aware: a containment along Y gets its doors at its Y ends.
 */
const isContainment = (p: Prim) => p.emitter === 'containment-panel' || p.emitter === 'containment-roof' || (p.emitter === 'door' && p.layer === 'containment-doors');

export function Containments({ prims }: { hall?: Hall; prims: HallPrims | null }) {
  const sub = usePrimSubset(prims, isContainment);
  const geo = useMemo(() => {
    const parts = containmentParts(sub.prims);
    const out: Record<string, THREE.BufferGeometry | null> = {};
    for (const [mat, list] of partsByMat(parts)) out[mat] = mergeParts(list);
    disposeParts(parts);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.key]);

  const mats = useMemo<Record<string, THREE.Material>>(
    () => ({
      frame: new THREE.MeshStandardMaterial({ color: '#c9ced4', metalness: 0.85, roughness: 0.32 }),
      glassHot: new THREE.MeshStandardMaterial({ color: '#dfe8ee', transparent: true, opacity: 0.2, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.4 }),
      glassCold: new THREE.MeshStandardMaterial({ color: '#b9dcf5', transparent: true, opacity: 0.22, roughness: 0.05, metalness: 0.2, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.4 }),
      frosted: new THREE.MeshStandardMaterial({ color: '#9fb2bf', transparent: true, opacity: 0.09, roughness: 0.2, metalness: 0.1, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.4 }),
      // blanking / side panels stand just behind the rack lines over the whole aisle length and height: an opaque near-black box read as a
      // dark wall from inside the hot aisle and hid the rack rears (backlog T2 #11) — smoked translucent panel, both faces, no depth write
      blank: new THREE.MeshStandardMaterial({ color: '#5b636c', transparent: true, opacity: 0.28, roughness: 0.55, metalness: 0.25, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.6 }),
      accentHot: new THREE.MeshStandardMaterial({ color: '#ff6d00', emissive: '#ff6d00', emissiveIntensity: 2.5, toneMapped: false }),
      accentCold: new THREE.MeshStandardMaterial({ color: '#29b6f6', emissive: '#29b6f6', emissiveIntensity: 2.5, toneMapped: false }),
    }),
    [],
  );

  useEffect(() => () => Object.values(geo).forEach((g) => g?.dispose()), [geo]);
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  return (
    <group>
      {Object.entries(geo).map(([k, g]) =>
        g && mats[k] ? <mesh key={k} geometry={g} material={mats[k]} raycast={() => null} renderOrder={k.startsWith('glass') || k === 'frosted' || k === 'blank' ? 2 : 0} /> : null,
      )}
    </group>
  );
}
