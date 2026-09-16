import * as THREE from 'three';

/** Plan (x, y, z-up, hall-local meters) → three.js world (x, y-up, z). */
export function planToThree(x: number, y: number, z = 0, target = new THREE.Vector3()): THREE.Vector3 {
  return target.set(x, z, -y);
}

/** three.js world → plan. */
export function threeToPlan(v: THREE.Vector3): { x: number; y: number; z: number } {
  return { x: v.x, y: -v.z, z: v.y };
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Instance matrix for equipment placed at plan (x, y) with rotationDeg CCW about up axis. */
export function equipmentMatrix(x: number, y: number, rotationDeg: number, elevation = 0, target = new THREE.Matrix4()): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, (rotationDeg * Math.PI) / 180);
  return target.compose(new THREE.Vector3(x, elevation, -y), q, new THREE.Vector3(1, 1, 1));
}
