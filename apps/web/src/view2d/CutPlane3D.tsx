// r4 stream C (spec §3.2 Split, P1): the active section cut drawn in the 3D view as a translucent vertical sheet with its depth
// window and a look arrow. Rendered inside the Viewer3D canvas; shown only in Split with the Section mode.
import { useMemo } from 'react';
import * as THREE from 'three';
import type { Hall } from '@aidc/core';
import { useApp } from '../store/appStore.ts';
import { cutPlanSpan } from './cutTool.ts';

export function CutPlane3D({ hall }: { hall: Hall }) {
  const v = useApp((s) => s.view2d);
  const cut = v.split && v.mode === 'section' ? v.cuts.find((c) => c.id === v.activeCutId && c.hallId === hall.id) : undefined;
  const geo = useMemo(() => {
    if (!cut) return null;
    const span = cutPlanSpan(cut) ?? (cut.axis === 'y' ? [0, hall.width] : [0, hall.depth]);
    const h = Math.max(hall.clearHeight, 1);
    const len = span[1] - span[0];
    const mid = (span[0] + span[1]) / 2;
    const depth = typeof v.depth === 'number' ? v.depth : cut.depthM;
    // three.js mapping (viewer): P(x, y, z) = (x, z, −y)
    const at = cut.at;
    const plane = cut.axis === 'y' ? { pos: [mid, h / 2, -at], size: [len, h, 0.02] } : { pos: [at, h / 2, -mid], size: [0.02, h, len] };
    const far = cut.axis === 'y' ? { pos: [mid, h / 2, -(at + cut.look * depth)], size: [len, h, 0.01] } : { pos: [at + cut.look * depth, h / 2, -mid], size: [0.01, h, len] };
    const arrowPos = cut.axis === 'y' ? [mid, h + 0.4, -(at + cut.look * 0.6)] : [at + cut.look * 0.6, h + 0.4, -mid];
    // cone points +y by default: rotate towards the look direction (world −z for +y plan, +x for +x plan)
    const arrowRot: [number, number, number] = cut.axis === 'y' ? [cut.look === 1 ? -Math.PI / 2 : Math.PI / 2, 0, 0] : [0, 0, cut.look === 1 ? -Math.PI / 2 : Math.PI / 2];
    return { plane, far, arrowPos, arrowRot, h };
  }, [cut, hall.width, hall.depth, hall.clearHeight, v.depth]);
  if (!cut || !geo) return null;
  return (
    <group name="aidc-cut-plane">
      <mesh position={geo.plane.pos as [number, number, number]} renderOrder={10}>
        <boxGeometry args={geo.plane.size as [number, number, number]} />
        <meshBasicMaterial color="#3987e5" transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={geo.far.pos as [number, number, number]} renderOrder={10}>
        <boxGeometry args={geo.far.size as [number, number, number]} />
        <meshBasicMaterial color="#3987e5" transparent opacity={0.08} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={geo.arrowPos as [number, number, number]} rotation={geo.arrowRot}>
        <coneGeometry args={[0.25, 0.7, 16]} />
        <meshBasicMaterial color="#3987e5" />
      </mesh>
    </group>
  );
}
