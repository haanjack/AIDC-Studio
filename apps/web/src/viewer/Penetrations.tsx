// Declared wall / partition / chimney sleeves (finish v2 2차, D1 / D5) as translucent boxes, read from the `sleeve` scene prims (r4 A1),
// and the site pathway of inter-hall trunks (hall-local coordinates, drawn outside the hall towards the peer hall; site-level, not a
// hall prim).
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Hall, HallPrims, NetworkAnalysis, Prim, WallPenetration } from '@aidc/core';
import { boxBetween, mergeParts, sleeveParts, type MeshPart } from './geometry/primMeshes.ts';
import { usePrimSubset } from './geometry/usePrims.ts';

const TRUNK_PATH = new THREE.Color('#9085e9');
const isSleeve = (p: Prim) => p.emitter === 'sleeve';
const noRaycast = () => null;

export function Penetrations({ hall, prims, penetrations, pathways }: { hall: Hall; prims: HallPrims | null; penetrations?: WallPenetration[]; pathways?: NetworkAnalysis['interHallPathways'] }) {
  const sub = usePrimSubset(prims, isSleeve);
  const idKey = (penetrations ?? []).filter((p) => p.hallId === hall.id).map((p) => p.id).sort().join('|');
  const geo = useMemo(() => {
    const ids = new Set(idKey ? idKey.split('|') : []);
    const sleeves = sleeveParts(sub.prims, ids);
    const ducts: MeshPart[] = [];
    for (const path of pathways ?? []) {
      if (!path.hallIds.includes(hall.id)) continue;
      const pts = path.points.map((q) => ({ x: q.x - hall.origin.x, y: q.y - hall.origin.y, z: q.z }));
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const dx = Math.abs(b.x - a.x);
        const dy = Math.abs(b.y - a.y);
        const dz = Math.abs(b.z - a.z);
        const cx = (a.x + b.x) / 2;
        const cy = (a.y + b.y) / 2;
        const cz = (a.z + b.z) / 2;
        // same bar as the viewer seg(): 0.16 m wide, 0.12 m high (vertical: 0.16 × 0.16)
        const [sx, sy, sz] = dz > dx && dz > dy ? [0.16, 0.16, dz] : dx >= dy ? [dx, 0.16, 0.12] : [0.16, dy, 0.12];
        ducts.push({ mat: 'ducts', g: boxBetween(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2), deco: true, color: TRUNK_PATH });
      }
    }
    const out = { sleeves: mergeParts(sleeves, { colors: true }), ducts: mergeParts(ducts, { colors: true }) };
    for (const p of [...sleeves, ...ducts]) p.g.dispose();
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.key, idKey, pathways, hall.id, hall.origin.x, hall.origin.y]);
  useEffect(() => () => Object.values(geo).forEach((g) => g?.dispose()), [geo]);
  const mats = useMemo(
    () => ({
      sleeves: new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }),
      ducts: new THREE.MeshBasicMaterial({ vertexColors: true }),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  return (
    <group name="aidc-penetrations">
      {geo.sleeves && <mesh geometry={geo.sleeves} material={mats.sleeves} raycast={noRaycast} renderOrder={4} />}
      {geo.ducts && <mesh geometry={geo.ducts} material={mats.ducts} raycast={noRaycast} />}
    </group>
  );
}
