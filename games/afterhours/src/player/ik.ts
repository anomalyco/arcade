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
const at = new THREE.Vector3()
const ab = new THREE.Vector3()
const dir = new THREE.Vector3()
const tmp = new THREE.Vector3()
const rot = new THREE.Quaternion()

/**
 * Two-bone IK: rotates `upper` and `mid` so `end` reaches `target` (clamped to reach). The middle joint bends toward
 * `pole` when `force`; otherwise the way it is animated, easing toward `pole` only as the chain straightens. `weight`
 * 0..1 blends
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
  // Bend direction: the animated knee/elbow's offset from the chord, blended continuously toward `pole` as the chain
  // straightens (a hard switch between the two flipped the bend plane: a knee pop once per stride).
  dir.copy(at).normalize()
  ab.subVectors(bp, a)
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1)
  // Measured against the *current* chord (hip → animated ankle), then made perpendicular to the goal chord.
  const curDir = new THREE.Vector3().subVectors(c, a).normalize()
  const animated = new THREE.Vector3().copy(ab).addScaledVector(curDir, -ab.dot(curDir))
  animated.addScaledVector(dir, -animated.dot(dir))
  const bend = animated.length() / Math.max(1e-6, l1)
  const perp = new THREE.Vector3()
  if (pole) perp.copy(pole).addScaledVector(dir, -pole.dot(dir)).normalize()
  const k = !pole ? 1 : force ? 0 : THREE.MathUtils.smoothstep(bend, 0.02, 0.12)
  if (k > 0 && bend > 1e-6) perp.multiplyScalar(1 - k).addScaledVector(animated.normalize(), k)
  if (perp.lengthSq() < 1e-10) perp.set(0, -1, 0).addScaledVector(dir, -dir.y)
  perp.normalize()
  // A joint that must bend one way (knees forward): never let the animated bend carry it past the pole's side.
  if (pole && !force) {
    const pp = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize()
    const c = perp.dot(pp)
    if (c < 0.3) perp.lerp(pp, THREE.MathUtils.clamp((0.3 - c) / 0.6, 0, 1)).normalize()
  }
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
