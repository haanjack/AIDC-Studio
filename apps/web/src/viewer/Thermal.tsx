import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { colormapTexture } from './colormap.ts';
import type { PreparedField } from './field.ts';

const VERT = /* glsl */ `
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const COMMON = /* glsl */ `
uniform sampler3D uTemp;
uniform sampler3D uSolid;
uniform sampler2D uColormap;
uniform vec2 uTexRange;
uniform vec2 uRange;
uniform vec3 uOrigin;
uniform vec3 uSize;
uniform vec4 uClip;
varying vec3 vWorld;
vec3 toPlan(vec3 w) { return vec3(w.x, -w.z, w.y); }
float tempAt(vec3 uvw) { return mix(uTexRange.x, uTexRange.y, texture(uTemp, uvw).r); }
float tnorm(float T) { return clamp((T - uRange.x) / max(1e-3, uRange.y - uRange.x), 0.0, 1.0); }
vec4 cmap(float T) { return texture(uColormap, vec2(tnorm(T), 0.5)); }
bool clipped(vec3 p) { return p.x < uClip.x || p.y < uClip.y || p.x > uClip.z || p.y > uClip.w; }`;

const SLICE_FRAG = /* glsl */ `
${COMMON}
uniform float uOpacity;
uniform float uFixedZ;
void main() {
  vec3 p = toPlan(vWorld);
  if (uFixedZ >= 0.0) p.z = uFixedZ;
  if (clipped(p)) discard;
  vec3 uvw = (p - uOrigin) / uSize;
  if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) discard;
  if (texture(uSolid, uvw).r > 0.5) discard;
  float T = tempAt(uvw);
  vec3 col = cmap(T).rgb;
  // isotherms every 2 °C
  float s = T * 0.5;
  float d = min(fract(s), 1.0 - fract(s));
  float line = 1.0 - smoothstep(0.0, fwidth(s) * 1.25, d);
  col *= 1.0 - 0.3 * line;
  gl_FragColor = vec4(col * 1.2, uOpacity);
}`;

const VOLUME_FRAG = /* glsl */ `
${COMMON}
uniform float uOpacity;
uniform float uDensity;
uniform float uStep;
vec2 hitBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1);
  vec3 tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
float hash12(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 ro = toPlan(cameraPosition);
  vec3 rd = normalize(toPlan(vWorld) - ro);
  vec3 bmin = vec3(max(uOrigin.xy, uClip.xy), uOrigin.z);
  vec3 bmax = vec3(min(uOrigin.xy + uSize.xy, uClip.zw), uOrigin.z + uSize.z);
  vec2 t = hitBox(ro, rd, bmin, bmax);
  t.x = max(t.x, 0.0);
  if (t.x >= t.y) discard;
  float tt = t.x + uStep * hash12(gl_FragCoord.xy);
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 320; i++) {
    if (tt > t.y || acc.a > 0.96) break;
    vec3 uvw = (ro + rd * tt - uOrigin) / uSize;
    if (texture(uSolid, uvw).r > 0.5) break;
    float T = tempAt(uvw);
    vec4 c = cmap(T);
    float hot = smoothstep(0.45, 0.88, tnorm(T));
    float a = clamp(c.a * (0.15 + 0.85 * hot) * uDensity * uStep, 0.0, 1.0);
    acc.rgb += (1.0 - acc.a) * c.rgb * a;
    acc.a += (1.0 - acc.a) * a;
    tt += uStep;
  }
  gl_FragColor = vec4(acc.rgb * 1.3, acc.a) * uOpacity;
}`;

export type ClipRect = [number, number, number, number];
const NO_CLIP: ClipRect = [-1e6, -1e6, 1e6, 1e6];

function baseUniforms(f: PreparedField, rangeC: [number, number], clip: ClipRect = NO_CLIP) {
  return {
    uClip: { value: new THREE.Vector4(...clip) },
    uTemp: { value: f.tempTex },
    uSolid: { value: f.solidTex },
    uColormap: { value: colormapTexture() },
    uTexRange: { value: new THREE.Vector2(f.tMin, f.tMax) },
    uRange: { value: new THREE.Vector2(rangeC[0], rangeC[1]) },
    uOrigin: { value: new THREE.Vector3(f.origin.x, f.origin.y, f.origin.z) },
    uSize: { value: new THREE.Vector3(f.size.x, f.size.y, f.size.z) },
  };
}

function useSliceMaterial(f: PreparedField, rangeC: [number, number], opacity: number, fixedZ: number, clip: ClipRect, version: number) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: SLICE_FRAG,
        uniforms: { ...baseUniforms(f, rangeC, clip), uOpacity: { value: opacity }, uFixedZ: { value: fixedZ } },
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [f],
  );
  useEffect(() => {
    mat.uniforms.uRange.value.set(rangeC[0], rangeC[1]);
    mat.uniforms.uOpacity.value = opacity;
    mat.uniforms.uFixedZ.value = fixedZ;
    mat.uniforms.uClip.value.set(...clip);
    mat.uniforms.uTexRange.value.set(f.tMin, f.tMax);
  }, [mat, f, rangeC, opacity, fixedZ, clip, version]);
  useEffect(() => () => mat.dispose(), [mat]);
  return mat;
}

export function ThermalSlice({ field, axis, position, opacity, rangeC, clip = NO_CLIP, version = 0 }: { field: PreparedField; axis: 'x' | 'y' | 'z'; position: number; opacity: number; rangeC: [number, number]; clip?: ClipRect; version?: number }) {
  const mat = useSliceMaterial(field, rangeC, opacity, -1, clip, version);
  const { origin: o, size: s } = field;
  let pos: [number, number, number];
  let rot: [number, number, number];
  let scale: [number, number, number];
  if (axis === 'z') {
    const z = Math.min(o.z + s.z - 1e-3, Math.max(o.z + 1e-3, position));
    pos = [o.x + s.x / 2, z, -(o.y + s.y / 2)];
    rot = [-Math.PI / 2, 0, 0];
    scale = [s.x, s.y, 1];
  } else if (axis === 'x') {
    const x = Math.min(o.x + s.x - 1e-3, Math.max(o.x + 1e-3, position));
    pos = [x, o.z + s.z / 2, -(o.y + s.y / 2)];
    rot = [0, Math.PI / 2, 0];
    scale = [s.y, s.z, 1];
  } else {
    const y = Math.min(o.y + s.y - 1e-3, Math.max(o.y + 1e-3, position));
    pos = [o.x + s.x / 2, o.z + s.z / 2, -y];
    rot = [0, 0, 0];
    scale = [s.x, s.z, 1];
  }
  return (
    <mesh position={pos} rotation={rot} scale={scale} material={mat} renderOrder={5} raycast={() => null}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

export function FloorHeatmap({ field, rangeC, sampleZ = 0.6, clip = NO_CLIP, version = 0 }: { field: PreparedField; rangeC: [number, number]; sampleZ?: number; clip?: ClipRect; version?: number }) {
  const mat = useSliceMaterial(field, rangeC, 0.92, sampleZ, clip, version);
  const { origin: o, size: s } = field;
  return (
    <mesh position={[o.x + s.x / 2, 0.012, -(o.y + s.y / 2)]} rotation={[-Math.PI / 2, 0, 0]} scale={[s.x, s.y, 1]} material={mat} renderOrder={1} raycast={() => null}>
      <planeGeometry args={[1, 1]} />
    </mesh>
  );
}

export function ThermalVolume({ field, rangeC, opacity, clip = NO_CLIP, version = 0 }: { field: PreparedField; rangeC: [number, number]; opacity: number; clip?: ClipRect; version?: number }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: VOLUME_FRAG,
        uniforms: {
          ...baseUniforms(field, rangeC, clip),
          uOpacity: { value: opacity },
          uDensity: { value: 0.4 },
          uStep: { value: Math.max(0.05, field.cs * 0.8) },
        },
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.BackSide,
        premultipliedAlpha: true,
        blending: THREE.NormalBlending,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field],
  );
  useEffect(() => {
    mat.uniforms.uRange.value.set(rangeC[0], rangeC[1]);
    mat.uniforms.uOpacity.value = opacity;
    mat.uniforms.uClip.value.set(...clip);
    mat.uniforms.uTexRange.value.set(field.tMin, field.tMax);
  }, [mat, field, rangeC, opacity, clip, version]);
  useEffect(() => () => mat.dispose(), [mat]);
  const { origin: o, size: s } = field;
  return (
    <mesh position={[o.x + s.x / 2, o.z + s.z / 2, -(o.y + s.y / 2)]} scale={[s.x, s.z, s.y]} material={mat} renderOrder={10} frustumCulled={false} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
    </mesh>
  );
}
