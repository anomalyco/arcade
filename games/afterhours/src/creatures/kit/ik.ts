import * as THREE from "three/webgpu"
import type { CreatureRig } from "./runtime"

// Pose helpers for creature rigs whose bind pose has no bone rotation: aim a bone along a world direction, solve two-
// bone IK with a pole, and critically damped springs for smooth-but-snappy parameters. No per-frame allocation.

const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _q3 = new THREE.Quaternion()
const _v = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()
const _c = new THREE.Vector3()
const _x = new THREE.Vector3()
const _y = new THREE.Vector3()
const _m = new THREE.Vector3()
const _s = new THREE.Vector3()
const _dp = new THREE.Vector3()
const _ds = new THREE.Vector3()

export function worldQuat(o: THREE.Object3D, out: THREE.Quaternion) {
  o.matrixWorld.decompose(_dp, out, _ds)
  return out
}

/** Rotate `bone` (minimal arc) so its rest direction points along world `dir`. Updates its world matrices. */
export function aimBone(rig: CreatureRig, i: number, dir: THREE.Vector3, weight = 1) {
  const bone = rig.bones[i]!
  // Read `dir` before touching the shared temporaries (callers may pass one of them).
  _v2.copy(dir).normalize()
  worldQuat(bone, _q)
  _v.copy(rig.dir[i]!).applyQuaternion(_q).normalize()
  _q2.setFromUnitVectors(_v, _v2)
  if (weight < 1) _q2.slerp(_q3.identity(), 1 - weight)
  _q2.multiply(_q)
  worldQuat(bone.parent!, _q3)
  bone.quaternion.copy(_q3.invert().multiply(_q2))
  bone.updateMatrixWorld(true)
}

/**
 * Two-bone IK: bones i (root→mid) and j (mid→end, child of i). Moves the end joint (the head of j's child, i.e. j's
 * tail) to `target`, bending in the plane that contains `pole` (a world direction the middle joint should point to).
 */
export function twoBoneIK(rig: CreatureRig, i: number, j: number, target: THREE.Vector3, pole: THREE.Vector3) {
  const bi = rig.bones[i]!
  const bj = rig.bones[j]!
  bi.getWorldPosition(_a)
  bj.getWorldPosition(_b)
  // End joint world position from j's rest direction and length.
  worldQuat(bj, _q)
  const sc = _s.setFromMatrixScale(bj.matrixWorld).x
  _c.copy(rig.dir[j]!).applyQuaternion(_q).multiplyScalar(rig.length[j]! * sc).add(_b)
  const l1 = _a.distanceTo(_b)
  const l2 = _b.distanceTo(_c)
  _x.subVectors(target, _a)
  let d = _x.length()
  // Soft IK: approach full extension asymptotically, so a limb near its reach never snaps straight (the classic
  // source of elbow/knee pops); the end effector falls a few millimetres short instead.
  const L = l1 + l2
  const soft = L * 0.95
  if (d > soft) d = soft + (L - soft) * (1 - Math.exp(-(d - soft) / (L - soft)))
  d = Math.min(Math.max(d, Math.abs(l1 - l2) + 1e-3), L - 1e-4)
  _x.normalize()
  _y.copy(pole).addScaledVector(_x, -pole.dot(_x))
  if (_y.lengthSq() < 1e-8) _y.set(0, 1, 0).addScaledVector(_x, -_x.y)
  _y.normalize()
  const cosA = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA))
  _m.copy(_a).addScaledVector(_x, l1 * cosA).addScaledVector(_y, l1 * sinA)
  aimBone(rig, i, _v.subVectors(_m, _a))
  bj.getWorldPosition(_b)
  aimBone(rig, j, _v.subVectors(_a.copy(_a).addScaledVector(_x, d), _b))
}

/** Critically damped spring on a scalar. */
export class Spring {
  v = 0
  constructor(
    public x = 0,
    public w = 8,
  ) {}
  step(target: number, dt: number, w = this.w) {
    const f = 1 + 2 * dt * w
    const oo = w * w
    const dtoo = dt * oo
    const dtdtoo = dt * dtoo
    const det = 1 / (f + dtdtoo)
    const x = det * (f * this.x + dt * this.v + dtdtoo * target)
    this.v = det * (this.v + dtoo * (target - this.x))
    this.x = x
    return x
  }
}

export const smooth01 = (t: number) => {
  const x = Math.min(1, Math.max(0, t))
  return x * x * (3 - 2 * x)
}
