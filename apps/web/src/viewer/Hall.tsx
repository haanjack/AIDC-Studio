import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { dominantRowAxis, primAabb, type EquipmentInstance, type Hall, type HallPrims, type Prim } from '@aidc/core';
import { ceilingTexture, floorTexture, wallTexture } from './textures.ts';
import type { ViewerOverlays } from './types.ts';
import { disposeParts, lightMatrix, lightStrips, lightUnitGeometry, mergeParts, partsByMat, reserveOutlines, shellParts, worldUv, type LightStrip } from './geometry/primMeshes.ts';
import { usePrimSubset } from './geometry/usePrims.ts';

export { aisleStrips, dominantRowAxis, fixtureHeight, type AisleStrip } from '@aidc/core';

/**
 * Hall shell, fixtures and lighting (stream T1, DECISIONS-v2-2 F3c, r2-layout.md §4.3), drawn from the scene prims (r4 A1, spec S1):
 *
 *   walls / doors      0.30 m wall slabs split around room doors with a header above each door (G9); door frames + leaves in the
 *                      opening and a floor decal in front of it; walls between the camera and the hall fade out
 *   partitions         separate-room partitions to the clear height, closed against both walls (G10)
 *   V1 fixture strips  the `light` prims of core scene/shell.ts aisleStrips (moved from here, identical rule): one continuous strip per
 *                      open aisle, never over racks, contained hot aisles or tray centre lines (TIA-942-B §6.4.2.5, §8.6.4) — one
 *                      InstancedMesh, emissive only
 *   V2 strip height    z = clamp(max(2.6, trayHeight), 2.6, clearHeight − 0.2) (TIA-942-B §6.4.2.4 ≥ 2.6 m to obstructions)
 *   V3 key light       shadow-casting directional light, azimuth parallel to the dominant row axis, elevation 65°
 *   V4 shadow frustum  the eight hall-box corners in light space ± 2 m; mapSize = clamp(nextPow2(extent / 0.04 m), 1024, 4096)
 *   V5 fill            hemisphere #dfe9f5 / #23272c, ambient 0.12, non-shadow fill from the opposite azimuth
 * Rendering conventions V3–V5 are estimates (r2-layout.md §4.3), not photometric.
 */

function boxAt(list: THREE.BufferGeometry[], cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
  // plan center/size → three box
  const g = new THREE.BoxGeometry(sx, sz, sy);
  g.translate(cx, cz, -cy);
  list.push(g.toNonIndexed());
}

export function mergeNonIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!parts.length) return null;
  const hasUv = parts.every((p) => p.attributes.uv);
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const uv = hasUv ? new Float32Array(n * 2) : null;
  let o = 0;
  for (const p0 of parts) {
    const p = p0.index ? p0.toNonIndexed() : p0;
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    if (p.attributes.normal) nor.set(p.attributes.normal.array as Float32Array, o * 3);
    if (uv && p.attributes.uv) uv.set(p.attributes.uv.array as Float32Array, o * 2);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

export { boxAt };

function stripeTexture(a: string, b: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = a;
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = b;
  g.lineWidth = 14;
  for (let i = -64; i < 128; i += 32) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i + 64, 64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function FixtureStrips({ strips, overlays, clearHeight }: { strips: LightStrip[]; overlays: ViewerOverlays; clearHeight: number }) {
  const geom = useMemo(() => lightUnitGeometry(), []);
  const mat = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#f4f7fb', emissiveIntensity: 3.2, toneMapped: false }), []);
  const ref = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    strips.forEach((s, i) => mesh.setMatrixAt(i, lightMatrix(s, m)));
    mesh.count = strips.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [strips]);
  useFrame(({ camera }) => {
    // luminaires only when looking from inside the room (or with the ceiling shown)
    if (ref.current) ref.current.visible = overlays.ceiling || camera.position.y < clearHeight;
  });
  useEffect(
    () => () => {
      geom.dispose();
      mat.dispose();
    },
    [geom, mat],
  );
  if (!strips.length) return null;
  return <instancedMesh key={strips.length} ref={ref} args={[geom, mat, strips.length]} frustumCulled={false} raycast={() => null} />;
}

const SHELL = new Set<Prim['emitter']>(['wall', 'column', 'partition', 'door', 'ceiling', 'room', 'light']);
const isShell = (p: Prim) => SHELL.has(p.emitter) && (p.emitter !== 'door' || p.layer === 'doors') && (p.emitter !== 'room' || p.layer === 'hall-outline' || p.layer === 'egress' || p.layer === 'reserves');

const WALL_OUTSIDE: Record<string, (x: number, y: number, W: number, D: number) => boolean> = {
  S: (_x, y) => y < 0,
  N: (_x, y, _W, D) => y > D,
  W: (x) => x < 0,
  E: (x, _y, W) => x > W,
};

export function HallShell({ hall, overlays, prims }: { hall: Hall; overlays: ViewerOverlays; prims: HallPrims | null }) {
  const W = hall.width;
  const D = hall.depth;
  const Hc = hall.clearHeight;
  const sub = usePrimSubset(prims, isShell);

  const floorMat = useMemo(() => {
    const t = floorTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(W / (hall.tileSize || 0.6), D / (hall.tileSize || 0.6));
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.32, metalness: 0.05, envMapIntensity: 0.6 });
  }, [W, D, hall.tileSize]);

  const ceilMat = useMemo(() => {
    const t = ceilingTexture().clone();
    t.needsUpdate = true;
    t.repeat.set(W / 0.6, D / 0.6);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.85, side: THREE.FrontSide });
  }, [W, D]);

  const shell = useMemo(() => {
    const parts = shellParts(sub.prims);
    const by = partsByMat(parts);
    const walls = (['S', 'N', 'W', 'E'] as const).flatMap((side) => {
      const list = by.get(`wall-${side}`);
      const g = list ? mergeParts(list) : null;
      if (!g) return [];
      worldUv(g, 4);
      return [{ side, geometry: g }];
    });
    const merged = (k: string, uv = false) => (by.get(k) ? mergeParts(by.get(k)!, { uv }) : null);
    const out = {
      walls,
      curb: merged('curb'),
      cols: merged('column'),
      partitions: merged('partition'),
      doorFrame: merged('doorFrame'),
      doorLeaf: merged('doorLeaf'),
      doorDecal: merged('doorDecal', true),
      egress: merged('egress', true),
      floor: sub.prims.find((p) => p.emitter === 'room' && p.layer === 'hall-outline'),
      ceiling: sub.prims.find((p) => p.emitter === 'ceiling' && p.meta?.kind !== 'deck'),
      deck: sub.prims.find((p) => p.emitter === 'ceiling' && p.meta?.kind === 'deck'),
      strips: lightStrips(sub.prims),
      reserves: (() => {
        const pts: number[] = [];
        for (const r of reserveOutlines(sub.prims)) for (let i = 0; i < r.segs.length; i += 2) pts.push(r.segs[i], 0.012, -r.segs[i + 1]);
        if (!pts.length) return null;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        return g;
      })(),
    };
    disposeParts(parts);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sub.key]);
  useEffect(
    () => () => {
      shell.walls.forEach((w) => w.geometry.dispose());
      [shell.curb, shell.cols, shell.partitions, shell.doorFrame, shell.doorLeaf, shell.doorDecal, shell.egress, shell.reserves].forEach((g) => g?.dispose());
    },
    [shell],
  );

  const wallMats = useMemo(() => {
    const tex = wallTexture().clone();
    tex.needsUpdate = true;
    tex.repeat.set(1, 1);
    return shell.walls.map(() => new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0, transparent: true, opacity: 1 }));
  }, [shell]);
  useEffect(() => () => wallMats.forEach((m) => m.dispose()), [wallMats]);

  const wallRefs = useRef<(THREE.Mesh | null)[]>([]);
  useFrame(({ camera }) => {
    const cx = camera.position.x;
    const cy = -camera.position.z;
    shell.walls.forEach((w, i) => {
      const m = wallRefs.current[i];
      const mat = wallMats[i];
      if (!m || !mat) return;
      const ghost = WALL_OUTSIDE[w.side](cx, cy, W, D);
      const target = ghost ? 0.0 : 1;
      mat.opacity += (target - mat.opacity) * 0.2;
      m.visible = mat.opacity > 0.02;
      mat.depthWrite = mat.opacity > 0.95;
    });
  });

  const doorMat = useMemo(() => new THREE.MeshStandardMaterial({ map: stripeTexture('#1b1d20', '#f2c200'), roughness: 0.6 }), []);
  const egressMat = useMemo(() => new THREE.MeshStandardMaterial({ map: stripeTexture('#10301a', '#3ddc84'), roughness: 0.6 }), []);

  useEffect(
    () => () => {
      floorMat.map?.dispose();
      floorMat.dispose();
      ceilMat.dispose();
    },
    [floorMat, ceilMat],
  );

  const planeAt = (p: Prim | undefined) => {
    if (!p) return null;
    const b = primAabb(p);
    return { cx: (b.min.x + b.max.x) / 2, cy: (b.min.y + b.max.y) / 2, z: b.min.z, w: b.max.x - b.min.x, d: b.max.y - b.min.y };
  };
  const floor = planeAt(shell.floor) ?? { cx: W / 2, cy: D / 2, z: 0, w: W, d: D };
  const ceiling = planeAt(shell.ceiling);
  const deck = planeAt(shell.deck);

  return (
    <group>
      {/* outer slab for context */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[W / 2, -0.01, -D / 2]} receiveShadow raycast={() => null}>
        <planeGeometry args={[W * 4 + 60, D * 4 + 60]} />
        <meshStandardMaterial color="#15181c" roughness={0.95} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[floor.cx, floor.z, -floor.cy]} receiveShadow material={floorMat} raycast={() => null}>
        <planeGeometry args={[floor.w, floor.d]} />
      </mesh>
      {shell.walls.map((w, i) => (
        <mesh key={w.side} ref={(m) => (wallRefs.current[i] = m)} geometry={w.geometry} material={wallMats[i]} receiveShadow raycast={() => null} />
      ))}
      {shell.curb && (
        <mesh geometry={shell.curb} raycast={() => null}>
          <meshStandardMaterial color="#3a3f45" roughness={0.8} />
        </mesh>
      )}
      {shell.doorFrame && (
        <mesh geometry={shell.doorFrame} castShadow raycast={() => null}>
          <meshStandardMaterial color="#8d949b" roughness={0.5} metalness={0.6} />
        </mesh>
      )}
      {shell.doorLeaf && (
        <mesh geometry={shell.doorLeaf} raycast={() => null}>
          <meshStandardMaterial color="#2b3036" roughness={0.6} metalness={0.3} />
        </mesh>
      )}
      <FixtureStrips strips={shell.strips} overlays={overlays} clearHeight={Hc} />
      {shell.reserves && (
        <lineSegments geometry={shell.reserves} onUpdate={(l: THREE.LineSegments) => l.computeLineDistances()} raycast={() => null}>
          <lineDashedMaterial color="#8fa3b8" dashSize={0.16} gapSize={0.1} transparent opacity={0.85} />
        </lineSegments>
      )}
      {shell.partitions && (
        <mesh geometry={shell.partitions} raycast={() => null}>
          <meshStandardMaterial color="#9aa5b1" roughness={0.9} transparent opacity={0.35} depthWrite={false} />
        </mesh>
      )}
      {overlays.ceiling && (
        <group>
          {/* suspended ceiling, visible only from below */}
          {ceiling && (
            <mesh rotation={[Math.PI / 2, 0, 0]} position={[ceiling.cx, ceiling.z, -ceiling.cy]} material={ceilMat} raycast={() => null}>
              <planeGeometry args={[ceiling.w, ceiling.d]} />
            </mesh>
          )}
          {deck && (
            <mesh rotation={[Math.PI / 2, 0, 0]} position={[deck.cx, deck.z, -deck.cy]} raycast={() => null}>
              <planeGeometry args={[deck.w, deck.d]} />
              <meshStandardMaterial color="#2a2e33" roughness={0.9} side={THREE.FrontSide} />
            </mesh>
          )}
        </group>
      )}
      {shell.cols && (
        <mesh geometry={shell.cols} castShadow receiveShadow raycast={() => null}>
          <meshStandardMaterial color="#9a9ea3" roughness={0.9} />
        </mesh>
      )}
      {shell.doorDecal && <mesh geometry={shell.doorDecal} material={doorMat} raycast={() => null} />}
      {shell.egress && <mesh geometry={shell.egress} material={egressMat} raycast={() => null} />}
    </group>
  );
}

// ───────────────────────────── lights ─────────────────────────────

export interface KeyLightRig {
  axis: 'x' | 'y';
  position: THREE.Vector3;
  target: THREE.Vector3;
  fill: THREE.Vector3;
  left: number;
  right: number;
  top: number;
  bottom: number;
  near: number;
  far: number;
  mapSize: number;
}

const KEY_ELEVATION_DEG = 65;
const FILL_ELEVATION_DEG = 40;
const TEXEL_M = 0.04;

/** V3 / V4: key-light placement and the shadow frustum fitted to the hall box in light space. Pure. */
export function keyLightRig(W: number, D: number, Ht: number, axis: 'x' | 'y'): KeyLightRig {
  const el = THREE.MathUtils.degToRad(KEY_ELEVATION_DEG);
  // plan azimuth parallel to the rows: +X, or +Y (three: −Z)
  const az = axis === 'x' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1);
  const dir = new THREE.Vector3(az.x * Math.cos(el), -Math.sin(el), az.z * Math.cos(el)).normalize();
  const target = new THREE.Vector3(W / 2, 0, -D / 2);
  const dist = Math.hypot(W, D, Ht) + 3 * Ht;
  const position = target.clone().addScaledVector(dir, -dist);
  const fe = THREE.MathUtils.degToRad(FILL_ELEVATION_DEG);
  const fill = target.clone().add(new THREE.Vector3(az.x * Math.cos(fe) * dist, Math.sin(fe) * dist, az.z * Math.cos(fe) * dist));
  // light space = the shadow camera's view (Object3D.lookAt for lights: −Z towards the target)
  const world = new THREE.Matrix4().lookAt(position, target, new THREE.Vector3(0, 1, 0));
  world.setPosition(position);
  const view = world.clone().invert();
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const p = new THREE.Vector3();
  for (const x of [0, W]) for (const y of [0, Ht]) for (const z of [0, -D]) {
    p.set(x, y, z).applyMatrix4(view);
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    minZ = Math.min(minZ, p.z);
    maxZ = Math.max(maxZ, p.z);
  }
  const left = minX - 2;
  const right = maxX + 2;
  const bottom = minY - 2;
  const top = maxY + 2;
  const extent = Math.max(right - left, top - bottom);
  const mapSize = Math.min(4096, Math.max(1024, 2 ** Math.ceil(Math.log2(Math.max(1, extent / TEXEL_M)))));
  return { axis, position, target, fill, left, right, top, bottom, near: Math.max(0.1, -maxZ - 2), far: -minZ + 2, mapSize };
}

export function HallLights({ hall, items }: { hall: Hall; items?: EquipmentInstance[] }) {
  const W = hall.width;
  const D = hall.depth;
  const Ht = hall.clearHeight + hall.ceilingPlenumHeight;
  const axis = useMemo(() => dominantRowAxis(hall, items ?? []), [hall, items]);
  const rig = useMemo(() => keyLightRig(W, D, Ht, axis), [W, D, Ht, axis]);
  const light = useRef<THREE.DirectionalLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  const lastMap = useRef(0);
  useEffect(() => {
    const l = light.current;
    if (!l) return;
    target.position.copy(rig.target);
    target.updateMatrixWorld();
    l.target = target;
    l.position.copy(rig.position);
    const cam = l.shadow.camera as THREE.OrthographicCamera;
    cam.left = rig.left;
    cam.right = rig.right;
    cam.top = rig.top;
    cam.bottom = rig.bottom;
    cam.near = rig.near;
    cam.far = rig.far;
    cam.updateProjectionMatrix();
    if (lastMap.current !== rig.mapSize) {
      l.shadow.mapSize.set(rig.mapSize, rig.mapSize);
      l.shadow.map?.dispose();
      (l.shadow as unknown as { map: THREE.WebGLRenderTarget | null }).map = null;
      lastMap.current = rig.mapSize;
    }
    l.shadow.needsUpdate = true;
  }, [rig, target]);
  return (
    <group>
      <primitive object={target} />
      <hemisphereLight args={['#dfe9f5', '#23272c', 0.85]} />
      <ambientLight intensity={0.12} />
      <directionalLight
        ref={light}
        position={[rig.position.x, rig.position.y, rig.position.z]}
        intensity={2.2}
        color="#fff6ea"
        castShadow
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
        shadow-radius={3}
      />
      <directionalLight position={[rig.fill.x, rig.fill.y, rig.fill.z]} intensity={0.45} color="#bcd4ff" />
    </group>
  );
}
