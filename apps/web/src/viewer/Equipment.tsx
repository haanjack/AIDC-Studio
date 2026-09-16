import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { findCatalogItem, footprintSize, type CatalogItem, type EquipmentInstance, type Hall } from '@aidc/core';
import { equipmentMatrix, planToThree } from './coords.ts';
import { fetchGltf, modelFromGltf, modelUrl, proceduralModel, tintMaterial, type EquipmentModel } from './models.ts';
import { viewerStatus } from './status.ts';
import type { EquipmentMove } from './types.ts';

const pickMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });

export interface HoverInfo {
  id: string;
}

interface GroupProps {
  item: CatalogItem;
  instances: EquipmentInstance[];
  colors: Map<string, THREE.Color> | null;
  editMode: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string | null, additive: boolean) => void;
  onDragStart: (inst: EquipmentInstance, item: CatalogItem, e: ThreeEvent<PointerEvent>) => void;
  suppressClick: () => boolean;
}

const WHITE = new THREE.Color(1, 1, 1);
/** above this many instances of one catalog item the viewer loads the LOD1 GLB */
export const LOD1_MIN_INSTANCES = 60;

function EquipmentGroup({ item, instances, colors, editMode, onHover, onSelect, onDragStart, suppressClick }: GroupProps) {
  const [model, setModel] = useState<EquipmentModel>(() => proceduralModel(item));

  // LOD choice follows the instance count on every render: the effect below re-runs when the count crosses LOD1_MIN_INSTANCES (an edit,
  // a regenerate or a project switch that keeps this catalog item), not only at mount (backlog T2 #9)
  const preferLod1 = instances.length > LOD1_MIN_INSTANCES;
  useEffect(() => {
    let alive = true;
    const url = modelUrl(item, preferLod1) ?? (preferLod1 ? modelUrl(item, false) : undefined);
    if (!url) {
      // no GLB for this item (or it was removed): keep / restore the procedural model
      setModel(proceduralModel(item));
      return;
    }
    viewerStatus.glbPending++;
    (async () => {
      let g = await fetchGltf(url);
      if (!g && preferLod1) {
        const u0 = modelUrl(item, false);
        if (u0) g = await fetchGltf(u0);
      }
      if (alive && g) {
        setModel(modelFromGltf(g, item));
        viewerStatus.glbLoaded++;
      }
    })().finally(() => {
      viewerStatus.glbPending--;
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, preferLod1]);

  const count = instances.length;
  const meshes = useMemo(
    () =>
      model.parts.map((p) => {
        const m = new THREE.InstancedMesh(p.geometry, p.material, count);
        m.castShadow = p.castShadow;
        m.receiveShadow = true;
        m.userData.part = p;
        return m;
      }),
    [model, count],
  );

  const pick = useMemo(() => {
    const { w, d, h } = model.dims;
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(0, h / 2, 0);
    const m = new THREE.InstancedMesh(g, pickMaterial, count);
    m.castShadow = true;
    m.receiveShadow = false;
    m.userData.pick = true;
    return m;
  }, [model.dims, count]);

  useLayoutEffect(() => {
    const mat = new THREE.Matrix4();
    instances.forEach((e, i) => {
      equipmentMatrix(e.position.x, e.position.y, e.rotationDeg, e.elevation ?? 0, mat);
      for (const m of meshes) m.setMatrixAt(i, mat);
      pick.setMatrixAt(i, mat);
    });
    for (const m of [...meshes, pick]) {
      m.instanceMatrix.needsUpdate = true;
      m.boundingSphere = null;
      m.boundingBox = null;
    }
  }, [instances, meshes, pick]);

  useLayoutEffect(() => {
    for (const m of meshes) {
      const part = m.userData.part as EquipmentModel['parts'][number];
      if (!part.tint) continue;
      if (!colors) {
        m.material = part.material;
        if (m.instanceColor) {
          for (let i = 0; i < count; i++) m.setColorAt(i, WHITE);
          m.instanceColor.needsUpdate = true;
        }
      } else {
        const tm = tintMaterial();
        m.material = Array.isArray(part.material) ? part.material.map(() => tm) : tm;
        instances.forEach((e, i) => m.setColorAt(i, colors.get(e.id) ?? WHITE));
        if (m.instanceColor) m.instanceColor.needsUpdate = true;
      }
    }
  }, [colors, meshes, instances, count]);

  useEffect(
    () => () => {
      for (const m of meshes) m.dispose();
      pick.geometry.dispose();
      pick.dispose();
    },
    [meshes, pick],
  );

  return (
    <group>
      {meshes.map((m, i) => (
        <primitive key={i} object={m} />
      ))}
      <primitive
        object={pick}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          if (e.instanceId != null) onHover(instances[e.instanceId]?.id ?? null);
        }}
        onPointerOut={() => onHover(null)}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId == null) return;
          if (suppressClick()) return;
          const ne = e.nativeEvent;
          onSelect(instances[e.instanceId].id, ne.shiftKey || ne.ctrlKey || ne.metaKey);
        }}
        onPointerDown={(e: ThreeEvent<PointerEvent>) => {
          if (!editMode || e.instanceId == null || e.nativeEvent.button !== 0) return;
          e.stopPropagation();
          onDragStart(instances[e.instanceId], item, e);
        }}
      />
    </group>
  );
}

function edgeFrameGeometry(w: number, h: number, d: number, t: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const hw = w / 2 + t;
  const hd = d / 2 + t;
  const add = (sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.translate(x, y, z);
    parts.push(g);
  };
  for (const y of [-t / 2, h + t / 2]) {
    add(2 * hw, t, t, 0, y, -hd);
    add(2 * hw, t, t, 0, y, hd);
    add(t, t, 2 * hd, -hw, y, 0);
    add(t, t, 2 * hd, hw, y, 0);
  }
  for (const x of [-hw, hw]) for (const z of [-hd, hd]) add(t, h + t, t, x, h / 2, z);
  return mergeAll(parts);
}

function mergeAll(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // manual merge for non-indexed box pieces (BoxGeometry is indexed; convert)
  const nonIdx = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let n = 0;
  for (const p of nonIdx) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  let o = 0;
  for (const p of nonIdx) {
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nor.set(p.attributes.normal.array as Float32Array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return g;
}

const selectMat = new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 3, toneMapped: false });
const hoverMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.2, toneMapped: false });

function Frames({ ids, byId, material, thickness }: { ids: string[]; byId: Map<string, EquipmentInstance>; material: THREE.Material; thickness: number }) {
  const geom = useMemo(() => {
    viewerStatus.frameBuilds++;
    const geos: THREE.BufferGeometry[] = [];
    const m = new THREE.Matrix4();
    for (const id of ids) {
      const e = byId.get(id);
      if (!e) continue;
      const item = findCatalogItem(e.catalogId);
      if (!item) continue;
      const g = edgeFrameGeometry(item.dims.w, item.dims.h, item.dims.d, thickness);
      g.applyMatrix4(equipmentMatrix(e.position.x, e.position.y, e.rotationDeg, e.elevation ?? 0, m));
      geos.push(g);
    }
    return geos.length ? mergeAll(geos) : null;
  }, [ids, byId, thickness]);
  useEffect(() => () => geom?.dispose(), [geom]);
  if (!geom) return null;
  return <mesh geometry={geom} material={material} raycast={() => null} />;
}

export interface EquipmentLayerProps {
  hall: Hall;
  items: EquipmentInstance[];
  colors: Map<string, THREE.Color> | null;
  selection: string[];
  editMode: boolean;
  onSelect: (id: string | null, additive: boolean) => void;
  onMoveEquipment?: (moves: EquipmentMove[]) => void;
  tooltip: (e: EquipmentInstance, item: CatalogItem) => { title: string; lines: string[] };
}

export function EquipmentLayer({ hall, items, colors, selection, editMode, onSelect, onMoveEquipment, tooltip }: EquipmentLayerProps) {
  viewerStatus.layerRenders++;
  const groups = useMemo(() => {
    const map = new Map<string, { item: CatalogItem; instances: EquipmentInstance[] }>();
    for (const e of items) {
      const item = findCatalogItem(e.catalogId);
      if (!item || item.category === 'switch') continue;
      let g = map.get(item.id);
      if (!g) map.set(item.id, (g = { item, instances: [] }));
      g.instances.push(e);
    }
    return [...map.values()];
  }, [items]);
  const byId = useMemo(() => new Map(items.map((e) => [e.id, e])), [items]);

  const [hover, setHover] = useState<string | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const onHover = (id: string | null) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    if (id === null) hoverTimer.current = window.setTimeout(() => setHover(null), 60);
    else
      setHover((prev) => {
        if (prev !== id) viewerStatus.hoverChanges++;
        return id;
      });
  };

  // ───── drag (edit mode) ─────
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls);
  type DragMember = { inst: EquipmentInstance; item: CatalogItem; start: { x: number; y: number } };
  type DragState = { anchor: DragMember; members: DragMember[]; delta: { x: number; y: number } };
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const grab = useRef({ x: 0, y: 0 });
  const suppressClickUntil = useRef(0);

  const onDragStart = (inst: EquipmentInstance, item: CatalogItem, e: ThreeEvent<PointerEvent>) => {
    grab.current = { x: e.point.x - inst.position.x, y: -e.point.z - inst.position.y };
    const ids = selection.includes(inst.id) && selection.length > 1 ? selection : [inst.id];
    const members = ids.flatMap((id): DragMember[] => {
      const member = byId.get(id);
      const memberItem = member ? findCatalogItem(member.catalogId) : undefined;
      return member && memberItem ? [{ inst: member, item: memberItem, start: { ...member.position } }] : [];
    });
    const anchor = members.find((x) => x.inst.id === inst.id) ?? { inst, item, start: { ...inst.position } };
    setDrag({ anchor, members: members.length ? members : [anchor], delta: { x: 0, y: 0 } });
  };

  useEffect(() => {
    if (!drag) return;
    const ctrl = controls as unknown as { enabled: boolean } | null;
    if (ctrl) ctrl.enabled = false;
    const el = gl.domElement;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const ray = new THREE.Raycaster();
    const hit = new THREE.Vector3();
    const ndc = new THREE.Vector2();
    const { sx, sy } = footprintSize(drag.anchor.item.dims, drag.anchor.inst.rotationDeg);
    const tile = hall.tileSize || 0.6;
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      let x = hit.x - grab.current.x;
      let y = -hit.z - grab.current.y;
      x = Math.round((x - sx / 2) / tile) * tile + sx / 2;
      y = Math.round((y - sy / 2) / tile) * tile + sy / 2;
      const cur = dragRef.current;
      if (!cur) return;
      let dx = x - cur.anchor.start.x;
      let dy = y - cur.anchor.start.y;
      let minDx = -Infinity;
      let maxDx = Infinity;
      let minDy = -Infinity;
      let maxDy = Infinity;
      for (const m of cur.members) {
        const fp = footprintSize(m.item.dims, m.inst.rotationDeg);
        minDx = Math.max(minDx, fp.sx / 2 - m.start.x);
        maxDx = Math.min(maxDx, hall.width - fp.sx / 2 - m.start.x);
        minDy = Math.max(minDy, fp.sy / 2 - m.start.y);
        maxDy = Math.min(maxDy, hall.depth - fp.sy / 2 - m.start.y);
      }
      dx = Math.min(maxDx, Math.max(minDx, dx));
      dy = Math.min(maxDy, Math.max(minDy, dy));
      if (cur.delta.x !== dx || cur.delta.y !== dy) setDrag({ ...cur, delta: { x: dx, y: dy } });
    };
    const up = () => {
      const cur = dragRef.current;
      if (cur && (Math.abs(cur.delta.x) > 1e-9 || Math.abs(cur.delta.y) > 1e-9)) {
        const moves: EquipmentMove[] = cur.members.map((m) => ({ id: m.inst.id, position: { x: m.start.x + cur.delta.x, y: m.start.y + cur.delta.y } }));
        onMoveEquipment?.(moves);
        suppressClickUntil.current = performance.now() + 150;
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (ctrl) ctrl.enabled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.anchor.inst.id]);

  const hoverIds = useMemo(() => (hover ? [hover] : []), [hover]);
  const hovered = hover ? byId.get(hover) : undefined;
  const hoveredItem = hovered ? findCatalogItem(hovered.catalogId) : undefined;
  const tip = hovered && hoveredItem && window.__AIDC_VIEWER_FLAGS?.tooltip !== false ? tooltip(hovered, hoveredItem) : null;

  return (
    <group>
      {groups.map((g) => (
        <EquipmentGroup key={`${g.item.id}|${g.item.asset?.glb ?? ''}`} item={g.item} instances={g.instances} colors={colors} editMode={editMode} onHover={onHover} onSelect={onSelect} onDragStart={onDragStart} suppressClick={() => performance.now() < suppressClickUntil.current} />
      ))}
      <Frames ids={selection} byId={byId} material={selectMat} thickness={0.025} />
      {hover && !selection.includes(hover) && <Frames ids={hoverIds} byId={byId} material={hoverMat} thickness={0.012} />}
      {drag && drag.members.map((m) => (
        <mesh key={m.inst.id} position={planToThree(m.start.x + drag.delta.x, m.start.y + drag.delta.y, (m.inst.elevation ?? 0) + m.item.dims.h / 2)} rotation={[0, (m.inst.rotationDeg * Math.PI) / 180, 0]} raycast={() => null}>
          <boxGeometry args={[m.item.dims.w, m.item.dims.h, m.item.dims.d]} />
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.35} depthWrite={false} />
        </mesh>
      ))}
      {tip && hovered && hoveredItem && !drag && (
        <Html position={planToThree(hovered.position.x, hovered.position.y, (hovered.elevation ?? 0) + hoveredItem.dims.h + 0.35)} center zIndexRange={[40, 30]} style={{ pointerEvents: 'none' }}>
          <div
            style={{
              background: 'rgba(12,16,22,0.92)',
              border: '1px solid rgba(118,185,0,0.6)',
              borderRadius: 6,
              padding: '6px 9px',
              color: '#e6edf3',
              font: '12px/1.35 system-ui, sans-serif',
              whiteSpace: 'nowrap',
              boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
              transform: 'translateY(-50%)',
            }}
          >
            <div style={{ fontWeight: 600, color: '#9be15d' }}>{tip.title}</div>
            {tip.lines.map((l, i) => (
              <div key={i} style={{ opacity: 0.85 }}>
                {l}
              </div>
            ))}
          </div>
        </Html>
      )}
    </group>
  );
}
