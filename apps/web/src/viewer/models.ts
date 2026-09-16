import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { CatalogItem } from '@aidc/core';
import { mechFrontTexture, rackFrontTexture, rackRearTexture, sidePanelTexture, grilleTexture, type RackFaceKind } from './textures.ts';
import { isModelAllowed } from './modelIndex.ts';

/**
 * Equipment model = list of parts in LOCAL space:
 * footprint-centered, base at y = 0, width along X, depth along Z, FRONT facing −Z.
 */
export interface ModelPart {
  geometry: THREE.BufferGeometry;
  /** single material or per-group array */
  material: THREE.Material | THREE.Material[];
  /** receives per-instance colour in analytic colour modes */
  tint: boolean;
  castShadow: boolean;
}

export interface EquipmentModel {
  parts: ModelPart[];
  source: 'glb' | 'procedural';
  dims: { w: number; d: number; h: number };
}

const matCache = new Map<string, THREE.Material>();
function mat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined;
  if (!m) {
    m = make();
    matCache.set(key, m);
  }
  return m;
}

/** Neutral material used for analytic colour modes (instance colour shows clearly). */
export function tintMaterial(): THREE.MeshStandardMaterial {
  return mat('tint', () => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.55, metalness: 0.05, envMapIntensity: 0.6 }));
}

function rackKind(item: CatalogItem): RackFaceKind {
  switch (item.category) {
    case 'gpu-rack':
      return (item.cooling?.liquidFraction ?? 0) > 0.5 ? 'gpu-liquid' : 'gpu-air';
    case 'storage-rack':
      return 'storage';
    case 'network-rack':
      return 'network';
    case 'mgmt-rack':
      return 'mgmt';
    default:
      return 'cpu';
  }
}

function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function rackModel(item: CatalogItem): EquipmentModel {
  const { w, d, h } = item.dims;
  const kind = rackKind(item);
  const front = rackFrontTexture(kind);
  const rear = rackRearTexture(kind);
  const side = mat('rack-side', () => new THREE.MeshStandardMaterial({ map: sidePanelTexture(false), color: 0x9aa0a6, roughness: 0.5, metalness: 0.55 }));
  const top = mat('rack-top', () => new THREE.MeshStandardMaterial({ color: 0x1c1f23, roughness: 0.6, metalness: 0.5 }));
  const frontMat = mat(`rack-front-${kind}`, () =>
    new THREE.MeshStandardMaterial({ map: front.map, emissiveMap: front.emissive, emissive: 0xffffff, emissiveIntensity: 2.2, roughness: 0.42, metalness: 0.35 }),
  );
  const rearMat = mat(`rack-rear-${kind}`, () =>
    new THREE.MeshStandardMaterial({ map: rear.map, emissiveMap: rear.emissive, emissive: 0xffffff, emissiveIntensity: 1.6, roughness: 0.5, metalness: 0.35 }),
  );
  const plinthH = 0.05;
  // BoxGeometry groups: +x, −x, +y, −y, +z (rear), −z (front)
  const cabinet = box(w - 0.004, h - plinthH, d - 0.01, 0, plinthH + (h - plinthH) / 2, 0);
  const parts: ModelPart[] = [
    { geometry: cabinet, material: [side, side, top, top, rearMat, frontMat], tint: true, castShadow: false },
    {
      geometry: box(w - 0.03, plinthH, d - 0.06, 0, plinthH / 2, 0),
      material: mat('plinth', () => new THREE.MeshStandardMaterial({ color: 0x0b0c0e, roughness: 0.8 })),
      tint: false,
      castShadow: false,
    },
  ];
  // neutral status light bar at the top of the front door (no brand colours; QA neutral leaks)
  const accent = kind === 'network' ? 0xc9ccd0 : kind === 'storage' ? 0x9aa3ad : kind === 'mgmt' ? 0xdfe5e8 : 0x8fbf9a;
  parts.push({
    geometry: box(w * 0.7, 0.012, 0.008, 0, h - 0.07, -d / 2 - 0.004),
    material: mat(`led-${accent}`, () => new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 4, toneMapped: false })),
    tint: false,
    castShadow: false,
  });
  // door handles (front and rear)
  const handle = mat('handle', () => new THREE.MeshStandardMaterial({ color: 0xc9ced4, roughness: 0.25, metalness: 0.9 }));
  parts.push({
    geometry: mergeGeometries([box(0.012, 0.22, 0.025, w / 2 - 0.045, h * 0.52, -d / 2 - 0.012), box(0.012, 0.22, 0.025, -w / 2 + 0.045, h * 0.52, d / 2 + 0.012)]),
    material: handle,
    tint: false,
    castShadow: false,
  });
  if (kind === 'gpu-liquid') {
    // TCS supply/return hoses rising from the rear top to the overhead manifold
    const blue = mat('hose-blue', () => new THREE.MeshStandardMaterial({ color: 0x1e63c8, roughness: 0.35, metalness: 0.2 }));
    const red = mat('hose-red', () => new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.35, metalness: 0.2 }));
    const hose = (x: number) => {
      const g = new THREE.CylinderGeometry(0.028, 0.028, 0.28, 12);
      g.translate(x, h + 0.14, d / 2 - 0.12);
      return g;
    };
    parts.push({ geometry: hose(-0.12), material: blue, tint: false, castShadow: false });
    parts.push({ geometry: hose(0.12), material: red, tint: false, castShadow: false });
  }
  return { parts, source: 'procedural', dims: { w, d, h } };
}

function mechModel(item: CatalogItem): EquipmentModel {
  const { w, d, h } = item.dims;
  const kind = item.category === 'cdu' ? 'cdu' : item.category === 'crah' || item.category === 'fan-wall' ? 'crah' : 'power';
  const tex = mechFrontTexture(kind, w / h);
  const side = mat('mech-side', () => new THREE.MeshStandardMaterial({ map: sidePanelTexture(true), roughness: 0.45, metalness: 0.2 }));
  const frontMat = mat(`mech-front-${kind}-${(w / h).toFixed(2)}`, () =>
    new THREE.MeshStandardMaterial({ map: tex.map, emissiveMap: tex.emissive, emissive: 0xffffff, emissiveIntensity: 2.0, roughness: 0.45, metalness: 0.2 }),
  );
  const top =
    kind === 'crah'
      ? mat('crah-top', () => {
          const t = grilleTexture().clone();
          t.repeat.set(Math.max(1, w * 2), Math.max(1, d * 2));
          t.needsUpdate = true;
          return new THREE.MeshStandardMaterial({ map: t, roughness: 0.6, metalness: 0.4 });
        })
      : mat('mech-top', () => new THREE.MeshStandardMaterial({ color: 0xbfc3c7, roughness: 0.5, metalness: 0.3 }));
  const parts: ModelPart[] = [
    {
      geometry: box(w - 0.004, h - 0.04, d - 0.004, 0, 0.04 + (h - 0.04) / 2, 0),
      material: [side, side, top, top, side, frontMat],
      tint: true,
      castShadow: false,
    },
    {
      geometry: box(w - 0.02, 0.04, d - 0.02, 0, 0.02, 0),
      material: mat('mech-plinth', () => new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.8 })),
      tint: false,
      castShadow: false,
    },
  ];
  if (kind === 'cdu') {
    const blue = mat('pipe-blue', () => new THREE.MeshStandardMaterial({ color: 0x1565c0, roughness: 0.3, metalness: 0.4 }));
    const red = mat('pipe-red', () => new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.3, metalness: 0.4 }));
    const pipe = (x: number, z: number) => {
      const g = new THREE.CylinderGeometry(0.07, 0.07, 0.5, 16);
      g.translate(x, h + 0.25, z);
      return g;
    };
    parts.push({ geometry: mergeGeometries([pipe(-w * 0.25, d * 0.15), pipe(-w * 0.25, -d * 0.15)]), material: blue, tint: false, castShadow: false });
    parts.push({ geometry: mergeGeometries([pipe(w * 0.25, d * 0.15), pipe(w * 0.25, -d * 0.15)]), material: red, tint: false, castShadow: false });
  }
  return { parts, source: 'procedural', dims: { w, d, h } };
}

export function proceduralModel(item: CatalogItem): EquipmentModel {
  switch (item.category) {
    case 'gpu-rack':
    case 'cpu-rack':
    case 'storage-rack':
    case 'network-rack':
    case 'mgmt-rack':
      return rackModel(item);
    case 'column': {
      const { w, d, h } = item.dims;
      return {
        parts: [{ geometry: box(w, h, d, 0, h / 2, 0), material: mat('concrete', () => new THREE.MeshStandardMaterial({ color: 0x8f9398, roughness: 0.9 })), tint: false, castShadow: false }],
        source: 'procedural',
        dims: { w, d, h },
      };
    }
    default:
      return mechModel(item);
  }
}

// ───────────────────────────── GLB loading ─────────────────────────────

const gltfCache = new Map<string, Promise<GLTF | null>>();
const loader = new GLTFLoader();

/**
 * Fetch + parse a GLB; resolves null when absent (dev servers answer 404 or index.html) and — without any request — when the
 * file is not a redistributable model listed in /assets/manifest.json (modelIndex.ts). Callers then keep the procedural model.
 */
export function fetchGltf(url: string): Promise<GLTF | null> {
  let p = gltfCache.get(url);
  if (!p) {
    p = (async () => {
      try {
        if (!(await isModelAllowed(url))) return null;
        const res = await fetch(url);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 12 || new DataView(buf).getUint32(0, true) !== 0x46546c67) return null; // 'glTF'
        const base = url.slice(0, url.lastIndexOf('/') + 1);
        return await loader.parseAsync(buf, base);
      } catch {
        return null;
      }
    })();
    gltfCache.set(url, p);
  }
  return p;
}

/**
 * Bake a GLTF scene into parts, merged per material and fitted to the catalog footprint
 * (X/Z scaled to catalog width/depth, native height kept, base at y = 0).
 */
export function modelFromGltf(gltf: GLTF, item: CatalogItem): EquipmentModel {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(scene);
  const size = bounds.getSize(new THREE.Vector3());
  const sx = size.x > 1e-3 ? item.dims.w / size.x : 1;
  const sz = size.z > 1e-3 ? item.dims.d / size.z : 1;
  const norm = new THREE.Matrix4()
    .makeScale(sx, 1, sz)
    .multiply(new THREE.Matrix4().makeTranslation(-(bounds.min.x + bounds.max.x) / 2, -bounds.min.y, -(bounds.min.z + bounds.max.z) / 2));

  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const baseGeom = mesh.geometry;
    const m = new THREE.Matrix4().multiplyMatrices(norm, mesh.matrixWorld);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = baseGeom.groups.length > 0 && Array.isArray(mesh.material) ? baseGeom.groups : [{ start: 0, count: baseGeom.index ? baseGeom.index.count : baseGeom.attributes.position.count, materialIndex: 0 }];
    for (const grp of groups) {
      const material = materials[grp.materialIndex ?? 0];
      let g = baseGeom.index ? baseGeom.clone() : baseGeom.clone();
      if (groups.length > 1 && g.index) {
        const idx = g.index.array.slice(grp.start, grp.start + grp.count);
        g.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      g.clearGroups();
      g.applyMatrix4(m);
      // keep only attributes common to merging
      for (const name of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.attributes.uv) {
        g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
      }
      if (!g.index) {
        const n = g.attributes.position.count;
        const arr = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
        for (let i = 0; i < n; i++) arr[i] = i;
        g.setIndex(new THREE.BufferAttribute(arr, 1));
      }
      const list = byMaterial.get(material) ?? [];
      list.push(g);
      byMaterial.set(material, list);
    }
  });

  const parts: ModelPart[] = [];
  for (const [material, geoms] of byMaterial) {
    const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms.map((g) => (g.index && g.index.array instanceof Uint16Array ? toUint32Index(g) : g)));
    if (!merged) continue;
    const std = material as THREE.MeshStandardMaterial;
    if ('envMapIntensity' in std) std.envMapIntensity = 0.7;
    if (std.isMeshStandardMaterial && std.metalness > 0.4) std.roughness = Math.max(std.roughness, 0.38);
    const emissiveLike = /screen|led|emis/i.test(material.name);
    if (emissiveLike && 'emissive' in std) {
      std.emissive = new THREE.Color(0x3aa0ff);
      std.emissiveIntensity = 1.5;
    }
    parts.push({ geometry: merged, material, tint: true, castShadow: false });
  }
  return { parts, source: 'glb', dims: { w: item.dims.w, d: item.dims.d, h: size.y } };
}

function toUint32Index(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const idx = g.index!;
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx.array), 1));
  return g;
}

export function modelUrl(item: CatalogItem, lod1 = false, base = '/assets/models/'): string | null {
  const glb = item.asset?.glb;
  if (!glb) return null;
  return base + (lod1 ? glb.replace(/\.glb$/i, '_lod1.glb') : glb);
}

/**
 * GLBs known to be generated by the AIDC asset pipeline itself — same GLB contract (Y-up, metres, footprint centred,
 * front −Z): the 'generic_*' form-factor models from generic_build.py (generic_spec.json). The runtime
 * source of truth is the manifest allowlist (modelIndex.ts / allowedModelFiles in @aidc/core).
 */
export const GENERATED_MODELS = new Set([
  'generic_rack_eia48_dlc.glb', 'generic_rack_orv3_44ou_dlc.glb', 'generic_rack_orw_44ou_dlc.glb', 'generic_cdu_900x2122.glb', 'generic_cdu_1200x2400.glb',
  'generic_crah_2515x1829.glb', 'generic_crah_3099x2388.glb', 'generic_crah_3050x3407.glb', 'generic_fanwall_3600x3000.glb',
]);

export function isGeneratedModel(glb: string | undefined): boolean {
  return !!glb && GENERATED_MODELS.has(glb.toLowerCase());
}
