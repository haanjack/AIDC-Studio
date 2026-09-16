import { useEffect, useRef, type MutableRefObject } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';

const ORBIT_ROTATE_SPEED = 0.6;
/** Wheel zoom: share of the distance to the point under the cursor covered per 100 px of wheel delta (one notch). */
const WHEEL_ZOOM_PER_100 = 0.2;
/** Zoom-in never crawls: at least this many metres per notch… */
const MIN_ZOOM_STEP_M = 0.25;
/** …and it stops this far in front of the surface under the cursor. */
const MIN_SURFACE_DIST_M = 0.35;
const MAX_ORBIT_DIST_M = 600;
const MAX_EYE_DIST_M = 1500;
import { findCatalogItem, frontVector, type Hall, type Project, footprintRect } from '@aidc/core';
import type { CameraMode, CameraPose, CameraPreset } from './types.ts';
import { flyKeyAllowed } from '../view2d/keyscope.ts';

export interface RigHandle {
  focus(id: string): void;
  flyTo(pose: Partial<CameraPose>, dur?: number): void;
  getPose(): CameraPose;
}

/**
 * Fly-mode key map (PROPOSAL-v2 §3.9). Codes are KeyboardEvent.code values so the layout is language independent.
 * Shift + forward/back = up/down, Shift + left/right = fast strafe. Wheel changes the speed. Replace entries with
 * `setFlyKeymap` (a settings UI is planned for 2차).
 */
export interface FlyKeymap {
  forward: string[];
  back: string[];
  left: string[];
  right: string[];
  yawLeft: string[];
  yawRight: string[];
  modifier: string[];
}
export const FLY_KEYMAP: FlyKeymap = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  modifier: ['ShiftLeft', 'ShiftRight'],
};
export function setFlyKeymap(patch: Partial<FlyKeymap>) {
  Object.assign(FLY_KEYMAP, patch);
}
/** Eye height of the walkthrough presets (m) — ISO 7250 standing eye height of an average adult. */
export const EYE_HEIGHT_M = 1.7;
const YAW_SPEED_DEG = 70; // Q/E
const LOOK_DEG_PER_PX = 0.18;
const PITCH_LIMIT = 85;

const P = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
const dirFromYawPitch = (yawDeg: number, pitchDeg: number) => {
  const yaw = (yawDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), -Math.cos(pitch) * Math.sin(yaw));
};
const yawPitchFromDir = (d: THREE.Vector3) => ({ yaw: (Math.atan2(-d.z, d.x) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, d.y))) * 180) / Math.PI });

function presetPose(preset: CameraPreset, hall: Hall, project: Project, aspect: number): { pos: THREE.Vector3; target: THREE.Vector3 } {
  const W = hall.width;
  const D = hall.depth;
  const M = Math.max(W, D);
  const cont = project.containments.find((c) => c.hallId === hall.id);
  switch (preset) {
    case 'top': {
      const fovY = (45 * Math.PI) / 180;
      const hFit = D / 2 / Math.tan(fovY / 2);
      const wFit = W / 2 / Math.tan(fovY / 2) / Math.max(0.3, aspect);
      const h = Math.max(hFit, wFit) * 1.12 + hall.clearHeight;
      return { pos: P(W / 2, D / 2 - 0.01, h), target: P(W / 2, D / 2, 0) };
    }
    case 'overview':
      return { pos: P(-0.75 * W - 6, -0.45 * D - 6, M * 0.95 + 8), target: P(W / 2, D / 2, 0) };
    case 'aisle': {
      if (!cont) return { pos: P(1.5, D / 2, 1.7), target: P(W, D / 2, 1.2) };
      const rackD = 1.2;
      let y = cont.rect.y - rackD - 1.35;
      if (y < 0.6) y = cont.rect.y + cont.rect.d + rackD + 1.35;
      return { pos: P(cont.rect.x - 1.8, y, 1.75), target: P(cont.rect.x + cont.rect.w * 0.75, y + 0.35, 1.25) };
    }
    case 'eye': {
      // walkthrough start: eye height at the cold-aisle entrance, looking straight down the aisle
      if (!cont) return { pos: P(1.0, D / 2, EYE_HEIGHT_M), target: P(W, D / 2, EYE_HEIGHT_M) };
      const rackD = 1.2;
      let y = cont.rect.y - rackD - 0.6;
      if (y < 0.6) y = cont.rect.y + cont.rect.d + rackD + 0.6;
      return { pos: P(Math.max(0.5, cont.rect.x - 0.5), y, EYE_HEIGHT_M), target: P(cont.rect.x + cont.rect.w, y, EYE_HEIGHT_M - 0.05) };
    }
    case 'hot-aisle': {
      if (!cont) return { pos: P(1.5, D / 2, 1.7), target: P(W, D / 2, 1.2) };
      const y = cont.rect.y + cont.rect.d / 2;
      return { pos: P(cont.rect.x + 0.35, y, 1.65), target: P(cont.rect.x + cont.rect.w, y, 1.45) };
    }
    case 'iso':
    default:
      return { pos: P(-0.18 * W - 2, -0.12 * D - 2, M * 0.46 + 4), target: P(W * 0.5, D * 0.46, 0.8) };
  }
}

const isTypingTarget = (t: EventTarget | null) => {
  const tag = (t as HTMLElement | null)?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t as HTMLElement | null)?.isContentEditable === true;
};
const visibleInScene = (o: THREE.Object3D | null) => {
  for (let p = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

export function CameraRig({
  hall,
  project,
  preset,
  nonce,
  rigRef,
  mode = 'orbit',
}: {
  hall: Hall;
  project: Project;
  preset: CameraPreset;
  nonce?: number;
  rigRef: MutableRefObject<RigHandle | null>;
  mode?: CameraMode;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);
  const anim = useRef<{ fromP: THREE.Vector3; toP: THREE.Vector3; fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number } | null>(null);
  const first = useRef(true);
  // fly state (refs: no re-render per frame)
  const fly = useRef({ yaw: 0, pitch: 0, speed: 3, keys: new Set<string>(), look: false, lastX: 0, lastY: 0 });
  const modeRef = useRef<CameraMode>(mode);
  modeRef.current = mode;
  const tmp = useRef({ dir: new THREE.Vector3(), right: new THREE.Vector3(), move: new THREE.Vector3(), target: new THREE.Vector3() }).current;

  const syncYawPitchFromCamera = () => {
    camera.getWorldDirection(tmp.dir);
    const yp = yawPitchFromDir(tmp.dir);
    fly.current.yaw = yp.yaw;
    fly.current.pitch = yp.pitch;
  };

  const goTo = (pos: THREE.Vector3, target: THREE.Vector3, dur = 1.1) => {
    // never animate to a non-finite pose (a NaN camera stays black); recover by jumping when the current pose is already non-finite
    if (![pos.x, pos.y, pos.z, target.x, target.y, target.z].every(Number.isFinite)) return;
    const c = controls.current;
    if (![camera.position.x, camera.position.y, camera.position.z].every(Number.isFinite) || (c && ![c.target.x, c.target.y, c.target.z].every(Number.isFinite))) dur = 0;
    if (dur <= 0) {
      camera.position.copy(pos);
      if (c) {
        c.target.copy(target);
        if (modeRef.current === 'orbit') c.update();
      }
      if (modeRef.current === 'fly') {
        camera.lookAt(target);
        syncYawPitchFromCamera();
      }
      anim.current = null;
      return;
    }
    anim.current = { fromP: camera.position.clone(), toP: pos, fromT: c ? c.target.clone() : camera.position.clone().add(camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(3)), toT: target, t: 0, dur };
  };

  useEffect(() => {
    const { pos, target } = presetPose(preset, hall, project, size.width / Math.max(1, size.height));
    goTo(pos, target, first.current ? 0 : 1.1);
    first.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, nonce, hall.id]);

  // default fly speed scales with the hall (≈ walking pace in a 60 m hall)
  useEffect(() => {
    fly.current.speed = Math.max(2, 0.05 * Math.max(hall.width, hall.depth));
  }, [hall.width, hall.depth]);

  // mode switch: freeze OrbitControls in fly mode, hand the pose back when returning to orbit
  useEffect(() => {
    const c = controls.current;
    if (mode === 'fly') {
      syncYawPitchFromCamera();
      if (c) c.enabled = false;
    } else {
      fly.current.keys.clear();
      fly.current.look = false;
      if (document.pointerLockElement === gl.domElement) document.exitPointerLock();
      if (c) {
        camera.getWorldDirection(tmp.dir);
        c.target.copy(camera.position).addScaledVector(tmp.dir, 4);
        c.enabled = true;
        c.update();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Keyboard navigation shares one layout-independent map: orbit mode translates camera + target horizontally, while fly mode
  // walks at eye level and keeps Q/E mouse-look controls. The focused 3D keyscope prevents WASD from leaking out of the viewport.
  useEffect(() => {
    const el = gl.domElement;
    const f = fly.current;
    const onKeyDown = (e: KeyboardEvent) => {
      // r4 (spec §3.3): ignore keys another scope consumed (defaultPrevented) or pressed inside a non-3D key scope (2D pane, Drawings)
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || !flyKeyAllowed(e)) return;
      const km = FLY_KEYMAP;
      const all = modeRef.current === 'fly'
        ? [...km.forward, ...km.back, ...km.left, ...km.right, ...km.yawLeft, ...km.yawRight, ...km.modifier]
        : [...km.forward, ...km.back, ...km.left, ...km.right, ...km.modifier];
      if (!all.includes(e.code)) return;
      f.keys.add(e.code);
      anim.current = null;
      if (!km.modifier.includes(e.code)) e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => f.keys.delete(e.code);
    const onBlur = () => f.keys.clear();
    const onPointerDown = (e: PointerEvent) => {
      if (modeRef.current !== 'fly') return;
      if (e.button === 2) {
        f.look = true;
        f.lastX = e.clientX;
        f.lastY = e.clientY;
        el.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      } else if (e.button === 0 && document.pointerLockElement !== el) {
        try {
          const p = el.requestPointerLock?.() as unknown;
          if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
        } catch {
          /* pointer lock unavailable (headless / iframe) — right-drag look still works */
        }
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (modeRef.current !== 'fly') return;
      let dx = 0;
      let dy = 0;
      if (document.pointerLockElement === el) {
        dx = e.movementX;
        dy = e.movementY;
      } else if (f.look) {
        dx = e.clientX - f.lastX;
        dy = e.clientY - f.lastY;
        f.lastX = e.clientX;
        f.lastY = e.clientY;
      } else return;
      f.yaw -= dx * LOOK_DEG_PER_PX;
      f.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, f.pitch - dy * LOOK_DEG_PER_PX));
      anim.current = null;
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.button === 2) {
        f.look = false;
        el.releasePointerCapture?.(e.pointerId);
      }
    };
    const onContextMenu = (e: Event) => {
      if (modeRef.current === 'fly') e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      if (modeRef.current !== 'fly') return;
      e.preventDefault();
      f.speed = Math.max(0.5, Math.min(40, f.speed * Math.pow(1.15, -e.deltaY / 100)));
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('contextmenu', onContextMenu);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('contextmenu', onContextMenu);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl]);

  // Orbit-mode pan and zoom, replacing OrbitControls' own. Those scale with the distance to the orbit target, so they crawl
  // near the target and the wheel can never pass it. Here a middle/right drag keeps the grabbed point under the cursor, and
  // the wheel scales camera and orbit target together about the point under the cursor, so the view direction and that
  // point's screen position stay put.
  useEffect(() => {
    const el = gl.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const plane = new THREE.Plane();
    const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const dir = new THREE.Vector3();
    let grab: { anchor: THREE.Vector3; pointerId: number } | null = null;
    let wheel: { anchor: THREE.Vector3; x: number; y: number; t: number } | null = null;

    const aim = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
    };
    /** world point under the cursor: nearest visible opaque mesh, else the floor, else a point at the orbit distance */
    const pick = (out: THREE.Vector3) => {
      for (const h of ray.intersectObjects(scene.children, true)) {
        const o = h.object as THREE.Mesh;
        if (!o.isMesh || !visibleInScene(o)) continue;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        if (m && m.transparent && m.opacity < 0.35) continue;
        return out.copy(h.point);
      }
      if (ray.ray.intersectPlane(ground, out) && out.distanceTo(ray.ray.origin) < MAX_EYE_DIST_M) return out;
      const c = controls.current;
      return ray.ray.at(c ? camera.position.distanceTo(c.target) : 10, out);
    };
    const orbitReady = () => {
      const c = controls.current;
      // drag-edit disables the controls while moving equipment
      return modeRef.current === 'orbit' && c && c.enabled ? c : null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if ((e.button !== 1 && e.button !== 2) || !orbitReady()) return;
      aim(e.clientX, e.clientY);
      const anchor = pick(new THREE.Vector3());
      camera.getWorldDirection(dir);
      plane.setFromNormalAndCoplanarPoint(dir, anchor);
      grab = { anchor, pointerId: e.pointerId };
      anim.current = null;
      el.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      const c = orbitReady();
      if (!grab || e.pointerId !== grab.pointerId || !c) return;
      aim(e.clientX, e.clientY);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      hit.subVectors(grab.anchor, hit);
      camera.position.add(hit);
      c.target.add(hit);
      c.update();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!grab || e.pointerId !== grab.pointerId) return;
      grab = null;
      el.releasePointerCapture?.(e.pointerId);
    };
    // middle-button autoscroll (Windows browsers) would fight the drag
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 1 && orbitReady()) e.preventDefault();
    };
    const onWheel = (e: WheelEvent) => {
      const c = orbitReady();
      if (!c) return;
      e.preventDefault();
      anim.current = null;
      const now = performance.now();
      // keep the anchor while the cursor rests so a wheel burst zooms towards one world point
      if (!wheel || Math.abs(e.clientX - wheel.x) > 3 || Math.abs(e.clientY - wheel.y) > 3 || now - wheel.t > 250) {
        aim(e.clientX, e.clientY);
        wheel = { anchor: pick(new THREE.Vector3()), x: e.clientX, y: e.clientY, t: now };
      } else wheel.t = now;
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      if (!px) return;
      const a = wheel.anchor;
      const dist = Math.max(1e-3, camera.position.distanceTo(a));
      const orbit = Math.max(1e-3, camera.position.distanceTo(c.target));
      const notches = -px / 100; // > 0 = zoom in
      let k = Math.pow(1 - WHEEL_ZOOM_PER_100, notches);
      if (k < 1) {
        k = Math.min(k, (dist - MIN_ZOOM_STEP_M * notches) / dist);
        k = Math.max(k, MIN_SURFACE_DIST_M / dist);
        if (k >= 1) return;
      } else {
        k = Math.min(k, MAX_ORBIT_DIST_M / orbit, MAX_EYE_DIST_M / dist);
        if (k <= 1) return;
      }
      camera.position.sub(a).multiplyScalar(k).add(a);
      c.target.sub(a).multiplyScalar(k).add(a);
      c.update();
    };
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('wheel', onWheel, { passive: false });
    const debug = (window.__AIDC_VIEWER_FLAGS as unknown as { exposeOrbit?: boolean } | undefined)?.exposeOrbit;
    if (debug) (window as unknown as { __aidcOrbit?: unknown }).__aidcOrbit = { camera, controls, pickAt: (x: number, y: number) => (aim(x, y), pick(new THREE.Vector3())) };
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, camera, scene]);

  rigRef.current = {
    focus(id: string) {
      const e = project.equipment.find((q) => q.id === id);
      if (!e) return;
      const item = findCatalogItem(e.catalogId);
      const d = item?.dims.d ?? 1.2;
      const h = item?.dims.h ?? 2;
      const f = frontVector(Number.isFinite(e.rotationDeg) ? e.rotationDeg : 0);
      const side = { x: -f.y, y: f.x };
      // Keep the eye inside the hall: a rack at a row end next to a wall would otherwise be framed from outside the wall
      // (dark wall face). Try the service (front) side, then the rear, with the lateral offset on either side; pick the first
      // candidate whose eye is inside the hall (0.4 m margin), else the one with the most room, then clamp it into the hall.
      const margin = 0.4;
      const W = hall.width;
      const D = hall.depth;
      const room = (x: number, y: number) => Math.min(x - margin, W - margin - x, y - margin, D - margin - y);
      // fix v2 2차 (QA): the eye used to land inside the neighbouring row (3.2 m in front, rows 3.4 m apart) → a black frame. Reject
      // eyes inside any equipment footprint (+0.3 m) or containment of the hall, keep the eye above the neighbouring racks, and fall
      // back to an oblique top view when every candidate collides.
      const blockers = [
        ...project.equipment.filter((q) => q.hallId === e.hallId).map((q) => {
          const it = findCatalogItem(q.catalogId);
          if (!it) return undefined;
          const r = footprintRect(it.dims, q.position, q.rotationDeg);
          return { x: r.x - 0.3, y: r.y - 0.3, w: r.w + 0.6, d: r.d + 0.6 };
        }),
        ...project.containments.filter((c) => c.hallId === e.hallId).map((c) => c.rect),
      ].filter((r): r is { x: number; y: number; w: number; d: number } => !!r);
      const blocked = (x: number, y: number) => blockers.some((r) => x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.d);
      const aisleHalf = (hall.layoutPolicy?.corridors?.coldAisleM ?? 1.2) / 2;
      const candidates = [d / 2 + aisleHalf, d / 2 + 1.8, d / 2 + 3.2].flatMap((dist) =>
        [{ dir: 1, lat: 0 }, { dir: 1, lat: 1 }, { dir: 1, lat: -1 }, { dir: -1, lat: 0 }, { dir: -1, lat: 1 }, { dir: -1, lat: -1 }].map(({ dir, lat }) => {
          const x = e.position.x + f.x * dist * dir + side.x * 1.4 * lat;
          const y = e.position.y + f.y * dist * dir + side.y * 1.4 * lat;
          return { x, y, room: room(x, y), dist };
        }),
      );
      const eyeZ = Math.max(h + 0.8, 2.6);
      const best = candidates.find((c) => c.room >= 0 && !blocked(c.x, c.y));
      if (!best) {
        // oblique top view from the service side, above everything
        const ox = Math.min(W - margin, Math.max(margin, e.position.x + f.x * 4));
        const oy = Math.min(D - margin, Math.max(margin, e.position.y + f.y * 4));
        goTo(P(ox, oy, h + 6), P(e.position.x, e.position.y, h * 0.5), 1.0);
        return;
      }
      const pos = P(best.x, best.y, eyeZ);
      goTo(pos, P(e.position.x, e.position.y, h * 0.55), 1.0);
    },
    flyTo(pose, dur = 0.8) {
      const cur = this.getPose();
      const p = { ...cur, ...pose };
      const pos = P(p.x, p.y, p.z);
      const dir = dirFromYawPitch(p.yaw, p.pitch);
      goTo(pos, pos.clone().addScaledVector(dir, 4), dur);
    },
    getPose() {
      camera.getWorldDirection(tmp.dir);
      const yp = yawPitchFromDir(tmp.dir);
      return { x: camera.position.x, y: -camera.position.z, z: camera.position.y, yaw: yp.yaw, pitch: yp.pitch };
    },
  };

  useFrame((_, dt) => {
    const a = anim.current;
    const c = controls.current;
    const flyMode = modeRef.current === 'fly';
    if (a) {
      a.t += dt / a.dur;
      const k = a.t >= 1 ? 1 : 1 - Math.pow(1 - a.t, 3);
      camera.position.lerpVectors(a.fromP, a.toP, k);
      tmp.target.lerpVectors(a.fromT, a.toT, k);
      if (c) c.target.copy(tmp.target);
      if (flyMode) {
        camera.lookAt(tmp.target);
        syncYawPitchFromCamera();
      } else if (c) c.update();
      if (a.t >= 1) anim.current = null;
      return;
    }
    if (!flyMode) {
      if (!c?.enabled) return;
      const f = fly.current;
      const km = FLY_KEYMAP;
      const has = (codes: string[]) => codes.some((k) => f.keys.has(k));
      const fwd = (has(km.forward) ? 1 : 0) - (has(km.back) ? 1 : 0);
      const str = (has(km.right) ? 1 : 0) - (has(km.left) ? 1 : 0);
      if (!fwd && !str) return;
      camera.getWorldDirection(tmp.dir);
      tmp.dir.y = 0;
      if (tmp.dir.lengthSq() < 1e-9) tmp.dir.set(1, 0, 0);
      else tmp.dir.normalize();
      tmp.right.set(-tmp.dir.z, 0, tmp.dir.x);
      tmp.move.set(0, 0, 0).addScaledVector(tmp.dir, fwd).addScaledVector(tmp.right, str);
      if (tmp.move.lengthSq() > 0) {
        tmp.move.normalize().multiplyScalar(f.speed * (has(km.modifier) ? 3 : 1) * Math.min(dt, 0.1));
        tmp.target.copy(c.target).add(tmp.move);
        tmp.target.x = Math.max(-5, Math.min(hall.width + 5, tmp.target.x));
        tmp.target.z = Math.max(-(hall.depth + 5), Math.min(5, tmp.target.z));
        tmp.move.subVectors(tmp.target, c.target);
        camera.position.add(tmp.move);
        c.target.copy(tmp.target);
        c.update();
      }
      return;
    }
    if (c && c.enabled) c.enabled = false; // drag-edit re-enables controls; keep them frozen while flying
    const f = fly.current;
    const km = FLY_KEYMAP;
    const has = (codes: string[]) => codes.some((k) => f.keys.has(k));
    const mod = has(km.modifier);
    const step = Math.min(dt, 0.1);
    if (has(km.yawLeft)) f.yaw += YAW_SPEED_DEG * step;
    if (has(km.yawRight)) f.yaw -= YAW_SPEED_DEG * step;
    if (f.keys.size) {
      // horizontal forward (walkthrough): projected view direction; right = forward × up
      tmp.dir.set(Math.cos((f.yaw * Math.PI) / 180), 0, -Math.sin((f.yaw * Math.PI) / 180));
      tmp.right.set(-tmp.dir.z, 0, tmp.dir.x);
      tmp.move.set(0, 0, 0);
      const fwd = (has(km.forward) ? 1 : 0) - (has(km.back) ? 1 : 0);
      const str = (has(km.right) ? 1 : 0) - (has(km.left) ? 1 : 0);
      if (mod) {
        tmp.move.y += fwd; // Shift+W/S = up/down
        tmp.move.addScaledVector(tmp.right, str * 3); // Shift+A/D = fast strafe
      } else {
        tmp.move.addScaledVector(tmp.dir, fwd);
        tmp.move.addScaledVector(tmp.right, str);
      }
      if (tmp.move.lengthSq() > 0) {
        camera.position.addScaledVector(tmp.move, f.speed * step);
        // stay inside the hall envelope (hall-local plan → three: x, y=height, z=-plan y)
        camera.position.x = Math.max(-5, Math.min(hall.width + 5, camera.position.x));
        camera.position.z = Math.max(-(hall.depth + 5), Math.min(5, camera.position.z));
        camera.position.y = Math.max(0.4, Math.min(hall.clearHeight + hall.ceilingPlenumHeight + 5, camera.position.y));
      }
    }
    const look = dirFromYawPitch(f.yaw, f.pitch);
    tmp.target.copy(camera.position).addScaledVector(look, 4);
    camera.lookAt(tmp.target);
    if (c) c.target.copy(tmp.target); // seamless hand-back to orbit
  });

  if (typeof window !== 'undefined' && window.__AIDC_VIEWER_FLAGS?.controls === false) return null;
  // Left-drag orbit stays with OrbitControls (slower than the 1.0 default); pan and wheel zoom are the cursor-anchored
  // handlers above, so OrbitControls' own pan/zoom are off. minDistance is tiny so zooming onto a surface is not clamped.
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.12}
      rotateSpeed={ORBIT_ROTATE_SPEED}
      enablePan={false}
      enableZoom={false}
      minDistance={0.01}
      maxDistance={MAX_ORBIT_DIST_M}
      screenSpacePanning
      maxPolarAngle={Math.PI * 0.495}
      enabled={mode !== 'fly'}
    />
  );
}
