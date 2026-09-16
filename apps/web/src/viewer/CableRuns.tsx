// Cable bundles from the core geometry (`cableRunPaths`, finish v2 2차; r4 A1: bundles step around interior columns and shafts).
// Bundles are not scene prims (they need the network analysis and carry a 4 000-bundle budget per hall; spec A0 §6.3), but they read the
// same core function as the wall audit, so what the audit checks is what the viewer draws.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cableRunPaths, type CableRun, type CableTray, type Containment, type EquipmentInstance, type Hall, type Vec3, type WallPenetration } from '@aidc/core';
import { fabricColor } from './colormap.ts';

function roundedPath(points: THREE.Vector3[], radius = 0.14): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  const pts = points.filter((p, i) => i === 0 || p.distanceToSquared(points[i - 1]) > 1e-6);
  if (pts.length < 2) return path;
  let cur = pts[0].clone();
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    if (i === pts.length - 1) {
      path.add(new THREE.LineCurve3(cur, p.clone()));
      break;
    }
    const next = pts[i + 1];
    const dIn = p.clone().sub(cur);
    const dOut = next.clone().sub(p);
    const r = Math.min(radius, dIn.length() / 2, dOut.length() / 2);
    const p1 = p.clone().add(dIn.normalize().multiplyScalar(-r));
    const p2 = p.clone().add(dOut.normalize().multiplyScalar(r));
    if (p1.distanceToSquared(cur) > 1e-8) path.add(new THREE.LineCurve3(cur, p1));
    path.add(new THREE.QuadraticBezierCurve3(p1, p.clone(), p2));
    cur = p2;
  }
  return path;
}

/**
 * Cable bundles: rows along X or Y, the 4 000-bundle budget per hall, row-less CRAH / CDU endpoints via the main tray, inter-hall trunks
 * to their trunk sleeve and out along the site pathway, detours around columns / shafts.
 */
export function CableRuns({ hall, items, runs, trays, allEquipment, sleeves, containments }: { hall: Hall; items: EquipmentInstance[]; runs: CableRun[]; trays?: CableTray[]; allEquipment?: EquipmentInstance[]; sleeves?: WallPenetration[]; containments?: Containment[] }) {
  const meshes = useMemo(() => {
    const geo = cableRunPaths(hall, items, runs, trays, { allEquipment, trunkSleeves: sleeves, containments });
    const byColor = new Map<string, THREE.BufferGeometry[]>();
    const P = (p: Vec3) => new THREE.Vector3(p.x, p.z, -p.y);
    for (const c of geo.paths) {
      // a 0.14 m fillet at every corner; column detours are short, so keep their corners tight (≤ a third of the shorter leg)
      const path = roundedPath(c.points.map(P), 0.14);
      const len = path.getLength();
      if (len < 0.05) continue;
      const g = new THREE.TubeGeometry(path as unknown as THREE.Curve<THREE.Vector3>, Math.min(260, Math.max(8, Math.ceil(len / 0.3) + c.points.length * 2)), c.radius, 5, false);
      g.deleteAttribute('uv');
      const color = fabricColor(c.fabric);
      const arr = byColor.get(color) ?? [];
      arr.push(g);
      byColor.set(color, arr);
    }
    const out: { color: string; geometry: THREE.BufferGeometry }[] = [];
    for (const [color, geoms] of byColor) {
      const merged = mergeGeometries(geoms, false);
      geoms.forEach((g) => g.dispose());
      if (merged) out.push({ color, geometry: merged });
    }
    return out;
  }, [hall, items, runs, trays, allEquipment, sleeves, containments]);

  useEffect(() => () => meshes.forEach((m) => m.geometry.dispose()), [meshes]);

  return (
    <group>
      {meshes.map((m) => (
        <mesh key={m.color} geometry={m.geometry} raycast={() => null}>
          <meshStandardMaterial color={m.color} emissive={m.color} emissiveIntensity={0.7} roughness={0.4} metalness={0.05} />
        </mesh>
      ))}
    </group>
  );
}
