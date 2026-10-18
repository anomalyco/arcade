import * as THREE from "three/webgpu"

// World-space helpers for posing three.js bones after the AnimationMixer has run: set a bone's world rotation, and a
// two-bone IK that moves the end of a chain (hip → knee → ankle, shoulder → elbow → wrist) to a target while keeping
// the animated bend plane (or a supplied pole). All functions refresh the touched bones' matrixWorld themselves.

const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _m = new THREE.Matrix4()

export function refresh(b: THREE.Object3D) {
  b.updateMatrix()
  if (b.parent) b.matrixWorld.multiplyMatrices(b.parent.matrixWorld, b.matrix)
  else b.matrixWorld.copy(b.matrix)
}

/** Refreshes `b` and every descendant's matrixWorld (after changing `b`). */
export function refreshTree(b: THREE.Object3D) {
  refresh(b)
  for (const c of b.children) refreshTree(c)
}

export function worldPos(b: THREE.Object3D, out: THREE.Vector3) {
  return out.setFromMatrixPosition(b.matrixWorld)
}

export function worldQuat(b: THREE.Object3D, out: THREE.Quaternion) {
  b.matrixWorld.decompose(_p, out, _s)
  return out
}

/** Sets a bone's world rotation (its parent's matrixWorld must be current). Does not refresh children. */
export function setWorldQuat(b: THREE.Object3D, q: THREE.Quaternion) {
  const parent = b.parent as THREE.Object3D
  parent.matrixWorld.decompose(_p, _q, _s)
  b.quaternion.copy(_q.invert()).multiply(q)
  refresh(b)
}

/** Rotates a bone in world space by `r` (premultiplied). */
export function rotateWorld(b: THREE.Object3D, r: THREE.Quaternion) {
  worldQuat(b, _q2)
  setWorldQuat(b, _q2.premultiply(r))
}

const a = new THREE.Vector3()
const bp = new THREE.Vector3()
const c = new THREE.Vector3()
const ac = new THREE.Vector3()
const at = new THREE.Vector3()
const ab = new THREE.Vector3()
const n = new THREE.Vector3()
const dir = new THREE.Vector3()
const tmp = new THREE.Vector3()
const rot = new THREE.Quaternion()

/**
 * Two-bone IK: rotates `upper` and `mid` so `end` reaches `target` (clamped to reach). The bend plane is the current
 * (animated) one unless `pole` (a world direction the middle joint should bend toward) is given and `force`; with
 * `force` false the pole only decides a (nearly) straight chain's bend. `weight` 0..1 blends
 * from the animated pose. The end bone keeps its world rotation.
 */
export function twoBoneIK(upper: THREE.Bone, mid: THREE.Bone, end: THREE.Bone, target: THREE.Vector3, weight = 1, pole?: THREE.Vector3, force = true) {
  if (weight <= 0) return
  const endQ = worldQuat(end, new THREE.Quaternion())
  worldPos(upper, a)
  worldPos(mid, bp)
  worldPos(end, c)
  const l1 = a.distanceTo(bp)
  const l2 = bp.distanceTo(c)
  const goal = tmp.copy(c).lerp(target, weight)
  at.subVectors(goal, a)
  const d = THREE.MathUtils.clamp(at.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4)
  // Bend plane normal: from the pole, or the current chain.
  ac.subVectors(c, a)
  ab.subVectors(bp, a)
  n.crossVectors(ac, ab)
  const bent = n.lengthSq() > 1e-6 * ac.lengthSq() * ab.lengthSq()
  const usePole = !!pole && (force || !bent)
  if (usePole) n.crossVectors(at, pole!)
  if (n.lengthSq() < 1e-10) n.set(1, 0, 0)
  n.normalize()
  // Desired middle joint: in the plane, at angle alpha from the chord.
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)
  dir.copy(at).normalize()
  const perp = new THREE.Vector3().crossVectors(n, dir).normalize()
  // Keep the bend on the same side as the current knee/elbow.
  if (!usePole && perp.dot(ab) < 0) perp.negate()
  if (usePole && perp.dot(pole!) < 0) perp.negate()
  const midGoal = new THREE.Vector3().copy(a).addScaledVector(dir, l1 * cosA).addScaledVector(perp, l1 * Math.sqrt(1 - cosA * cosA))
  // Upper: swing current upper→mid onto upper→midGoal.
  rot.setFromUnitVectors(ab.normalize(), midGoal.clone().sub(a).normalize())
  rotateWorld(upper, rot)
  refresh(mid)
  refresh(end)
  // Mid: swing mid→end onto mid→goal.
  worldPos(mid, bp)
  worldPos(end, c)
  const cur = new THREE.Vector3().subVectors(c, bp).normalize()
  const want = new THREE.Vector3().copy(a).addScaledVector(dir, d).sub(bp).normalize()
  rot.setFromUnitVectors(cur, want)
  rotateWorld(mid, rot)
  refresh(end)
  setWorldQuat(end, endQ)
}

/** Composes a world rotation whose local axes (`ax`, `ay` in the bone's own space) point along world `x` and `y`. */
export function aimQuat(axLocal: THREE.Vector3, ayLocal: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3, out: THREE.Quaternion) {
  const lz = new THREE.Vector3().crossVectors(axLocal, ayLocal).normalize()
  const ly = new THREE.Vector3().crossVectors(lz, axLocal).normalize()
  const wz = new THREE.Vector3().crossVectors(x, y).normalize()
  const wy = new THREE.Vector3().crossVectors(wz, x).normalize()
  const local = _m.makeBasis(axLocal.clone().normalize(), ly, lz)
  const world = new THREE.Matrix4().makeBasis(x.clone().normalize(), wy, wz)
  return out.setFromRotationMatrix(world.multiply(local.transpose()))
}
