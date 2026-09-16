import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { findCatalogItem, footprintRect, frontVector, type Containment, type EquipmentInstance, type Hall } from '@aidc/core';

export const AIR_PATH_COLORS = {
  supply: '#35b8ff',
  return: '#57d68d',
  exhaust: '#ff9d45',
} as const;

export type AirReturnMode = 'plenum' | 'top';

interface AirPathOverlayProps {
  hall: Hall;
  items: EquipmentInstance[];
  containments: Containment[];
  returnMode: AirReturnMode;
}

interface CoolerView {
  id: string;
  x: number;
  y: number;
  h: number;
  w: number;
  d: number;
  supplyOrigin: THREE.Vector3;
  supplyDirection: THREE.Vector3;
}

function planPoint(x: number, y: number, height: number): THREE.Vector3 {
  return new THREE.Vector3(x, height, -y);
}

function DashedRoutes({ routes, color }: { routes: THREE.Vector3[][]; color: string }) {
  const lines = useMemo(
    () =>
      routes.map((points) => {
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.9, dashSize: 0.55, gapSize: 0.28, depthWrite: false });
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances();
        line.renderOrder = 40;
        return line;
      }),
    [routes, color],
  );
  useEffect(
    () => () => {
      for (const line of lines) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
    },
    [lines],
  );
  return <>{lines.map((line, i) => <primitive key={i} object={line} />)}</>;
}

/**
 * Design-intent air path overlay. The CFD particles show a solved vector field; this layer makes the
 * otherwise invisible physical return topology explicit before and after a run.
 */
export function AirPathOverlay({ hall, items, containments, returnMode }: AirPathOverlayProps) {
  const layout = useMemo(() => {
    const coolers: CoolerView[] = [];
    for (const e of items) {
      const item = findCatalogItem(e.catalogId);
      if (!item || (item.category !== 'crah' && item.category !== 'fan-wall')) continue;
      const rect = footprintRect(item.dims, e.position, e.rotationDeg);
      const front = frontVector(e.rotationDeg);
      const edge = Math.abs(front.x) * rect.w / 2 + Math.abs(front.y) * rect.d / 2;
      coolers.push({
        id: e.id,
        x: e.position.x,
        y: e.position.y,
        h: item.dims.h,
        w: rect.w,
        d: rect.d,
        supplyOrigin: planPoint(e.position.x + front.x * (edge + 0.08), e.position.y + front.y * (edge + 0.08), Math.min(0.8, item.dims.h * 0.38)),
        supplyDirection: new THREE.Vector3(front.x, 0, -front.y).normalize(),
      });
    }

    const hotAisles = containments.filter((c) => c.kind === 'hot-aisle');
    const routeHeight = returnMode === 'plenum' ? hall.clearHeight + Math.min(0.45, Math.max(0.2, hall.ceilingPlenumHeight * 0.35)) : Math.min(hall.clearHeight - 0.15, 3.2);
    const returnRoutes: THREE.Vector3[][] = [];
    const exhaustArrows: { origin: THREE.Vector3; length: number }[] = [];

    for (const c of hotAisles) {
      const x = c.rect.x + c.rect.w / 2;
      const y = c.rect.y + c.rect.d / 2;
      const riseFrom = Math.min(c.height + 0.08, routeHeight - 0.15);
      exhaustArrows.push({ origin: planPoint(x, y, riseFrom), length: Math.max(0.35, routeHeight - riseFrom) });
      const nearest = coolers
        .map((cooler) => ({ cooler, distance: Math.hypot(cooler.x - x, cooler.y - y) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, Math.min(2, coolers.length));
      for (const { cooler } of nearest) {
        const sinkHeight = returnMode === 'plenum' ? routeHeight : cooler.h + 0.15;
        returnRoutes.push([
          planPoint(x, y, routeHeight),
          planPoint(cooler.x, y, routeHeight),
          planPoint(cooler.x, cooler.y, routeHeight),
          planPoint(cooler.x, cooler.y, sinkHeight),
        ]);
      }
    }

    return { coolers, hotAisles, returnRoutes, exhaustArrows };
  }, [hall, items, containments, returnMode]);

  const hasPlenum = returnMode === 'plenum' && hall.ceilingPlenumHeight > 0;
  return (
    <group name="air-path-design-overlay">
      {hasPlenum && (
        <mesh position={[hall.width / 2, hall.clearHeight + hall.ceilingPlenumHeight / 2, -hall.depth / 2]} renderOrder={10}>
          <boxGeometry args={[hall.width, hall.ceilingPlenumHeight, hall.depth]} />
          <meshBasicMaterial color={AIR_PATH_COLORS.return} transparent opacity={0.055} wireframe depthWrite={false} />
        </mesh>
      )}
      {hasPlenum && layout.hotAisles.map((c) => (
        <mesh key={`opening-${c.id}`} position={[c.rect.x + c.rect.w / 2, hall.clearHeight + 0.025, -(c.rect.y + c.rect.d / 2)]} renderOrder={42}>
          <boxGeometry args={[c.rect.w, 0.05, c.rect.d]} />
          <meshBasicMaterial color={AIR_PATH_COLORS.return} transparent opacity={0.42} depthWrite={false} />
        </mesh>
      ))}
      {hasPlenum && layout.coolers.map((c) => {
        const height = Math.max(0.05, hall.clearHeight - c.h);
        return (
          <mesh key={`riser-${c.id}`} position={[c.x, c.h + height / 2, -c.y]} renderOrder={41}>
            <boxGeometry args={[Math.max(0.2, c.w * 0.72), height, Math.max(0.2, c.d * 0.72)]} />
            <meshBasicMaterial color={AIR_PATH_COLORS.return} transparent opacity={0.28} wireframe depthWrite={false} />
          </mesh>
        );
      })}
      <DashedRoutes routes={layout.returnRoutes} color={AIR_PATH_COLORS.return} />
      {layout.exhaustArrows.map((arrow, i) => (
        <arrowHelper key={`exhaust-${i}`} args={[new THREE.Vector3(0, 1, 0), arrow.origin, arrow.length, AIR_PATH_COLORS.exhaust, 0.32, 0.18]} />
      ))}
      {layout.coolers.map((c) => (
        <arrowHelper key={`supply-${c.id}`} args={[c.supplyDirection, c.supplyOrigin, 1.45, AIR_PATH_COLORS.supply, 0.34, 0.18]} />
      ))}
    </group>
  );
}
