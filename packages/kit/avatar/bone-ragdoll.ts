import { HIP, RIG } from "../rig"
import { Rng } from "../sim/rng"

/**
 * Verlet ragdoll for any figure posed as the 15 semantic bone frames of `@arcade/kit/human-pose` (`boneIds` order:
 * pelvis, torso, head, upper arms, forearms, thighs, shins, feet, toes; 12 floats per bone: origin, then the x, y and z
 * axes). It starts from the exact pose drawn on the frame of death, so there is no pop, takes its first velocities from
 * the previous frame plus a seeded death impulse, and writes the same frames back each step, so the figure's own
 * renderer draws it.
 *
 * Sixteen points (hips, shoulders, neck, crown, knees, ankles, balls of the feet, elbows, hands) joined by distance
 * constraints: a rigid hip-shoulder block, a neck that flops within limits, jointed limbs, and minimum spans that stop
 * knees, elbows and feet folding flat or legs passing through each other. Ground contact uses a caller height
 * function, walls are plan rectangles. Flat typed arrays, no allocation per step, no `Math.random`: the same pose,
 * impulse and seed give the same fall on every client. It sleeps once it has settled and wakes on a push.
 */

export const RAGDOLL_BONES = 15
const P_HIP_L = 0
const P_HIP_R = 1
const P_SH_L = 2
const P_SH_R = 3
const P_NECK = 4
const P_CROWN = 5
const P_KNEE_L = 6
const P_KNEE_R = 7
const P_ANK_L = 8
const P_ANK_R = 9
const P_BALL_L = 10
const P_BALL_R = 11
const P_ELB_L = 12
const P_ELB_R = 13
const P_HAND_L = 14
const P_HAND_R = 15
const N = 16

const RADIUS = new Float32Array([0.1, 0.1, 0.09, 0.09, 0.08, 0.11, 0.07, 0.07, 0.06, 0.06, 0.04, 0.04, 0.055, 0.055, 0.05, 0.05])
/** Points of the upper body, lower body and legs, for region pushes. */
const UPPER = [P_SH_L, P_SH_R, P_NECK, P_CROWN, P_ELB_L, P_ELB_R, P_HAND_L, P_HAND_R]
const HIPS = [P_HIP_L, P_HIP_R]
const LEGS = [P_KNEE_L, P_KNEE_R, P_ANK_L, P_ANK_R, P_BALL_L, P_BALL_R]

/** How each bone's frame is rebuilt: from the rigid hip-shoulder block, or from two points with a reference axis. */
const enum Drive {
  Block,
  Limb,
}
type BoneDrive = { kind: Drive; a: number; b: number; ref: 0 | 2 }
/** ref 0 = the block's lateral axis, 2 = its forward axis (whichever is not along the bone). */
const DRIVES: readonly BoneDrive[] = [
  { kind: Drive.Block, a: 0, b: 0, ref: 0 }, // pelvis
  { kind: Drive.Block, a: 0, b: 0, ref: 0 }, // torso
  { kind: Drive.Limb, a: P_NECK, b: P_CROWN, ref: 2 }, // head
  { kind: Drive.Limb, a: P_SH_L, b: P_ELB_L, ref: 2 },
  { kind: Drive.Limb, a: P_SH_R, b: P_ELB_R, ref: 2 },
  { kind: Drive.Limb, a: P_ELB_L, b: P_HAND_L, ref: 2 },
  { kind: Drive.Limb, a: P_ELB_R, b: P_HAND_R, ref: 2 },
  { kind: Drive.Limb, a: P_HIP_L, b: P_KNEE_L, ref: 2 },
  { kind: Drive.Limb, a: P_HIP_R, b: P_KNEE_R, ref: 2 },
  { kind: Drive.Limb, a: P_KNEE_L, b: P_ANK_L, ref: 2 },
  { kind: Drive.Limb, a: P_KNEE_R, b: P_ANK_R, ref: 2 },
  { kind: Drive.Limb, a: P_ANK_L, b: P_BALL_L, ref: 0 },
  { kind: Drive.Limb, a: P_ANK_R, b: P_BALL_R, ref: 0 },
  { kind: Drive.Limb, a: P_ANK_L, b: P_BALL_L, ref: 0 }, // toe rides the foot
  { kind: Drive.Limb, a: P_ANK_R, b: P_BALL_R, ref: 0 },
]

const C_EXACT = 0
const C_MIN = 1
const C_MAX = 2

export type RagdollTuning = {
  /** m/s². Heavier than 9.8 so a body drops with weight from a top-down camera. */
  gravity: number
  /** Velocity kept per 1/120 s substep while a point touches the ground (0..1). */
  friction: number
  /** Upward speed kept on a bounce (0..1). */
  bounce: number
  /** Constraint passes per substep. */
  iterations: number
  /** Seconds below the sleep speed before it sleeps. */
  sleepAfter: number
  /** Settles anyway after this many seconds awake. */
  maxAwake: number
}

export const DEFAULT_RAGDOLL_TUNING: RagdollTuning = {
  gravity: 15,
  friction: 0.955,
  bounce: 0.22,
  iterations: 6,
  sleepAfter: 0.45,
  maxAwake: 7,
}

export type BoneRagdoll = {
  readonly pos: Float32Array
  readonly prev: Float32Array
  readonly ca: Int8Array
  readonly cb: Int8Array
  readonly cd: Float32Array
  readonly ck: Int8Array
  readonly count: number
  /** Each bone's frame in its driver's frame, captured on the frame of death. */
  readonly local: Float32Array
  /** Plan rectangles `[x0, z0, x1, z1]` it collides with (walls near where it fell). */
  rects: readonly (readonly [number, number, number, number])[]
  acc: number
  still: number
  age: number
  awakeFor: number
  asleep: boolean
  readonly rng: Rng
}

const SUB = 1 / 120
const scratch = new Float32Array(12)
const driver = new Float32Array(12)

function blockFrame(pos: Float32Array, out: Float32Array): void {
  // Origin mid-hips; x lateral (left → right shoulder), y up the spine (hips → neck), z = x × y (forward or back).
  const ox = (pos[P_HIP_L * 3]! + pos[P_HIP_R * 3]!) * 0.5
  const oy = (pos[P_HIP_L * 3 + 1]! + pos[P_HIP_R * 3 + 1]!) * 0.5
  const oz = (pos[P_HIP_L * 3 + 2]! + pos[P_HIP_R * 3 + 2]!) * 0.5
  let xx = pos[P_SH_R * 3]! - pos[P_SH_L * 3]! + pos[P_HIP_R * 3]! - pos[P_HIP_L * 3]!
  let xy = pos[P_SH_R * 3 + 1]! - pos[P_SH_L * 3 + 1]! + pos[P_HIP_R * 3 + 1]! - pos[P_HIP_L * 3 + 1]!
  let xz = pos[P_SH_R * 3 + 2]! - pos[P_SH_L * 3 + 2]! + pos[P_HIP_R * 3 + 2]! - pos[P_HIP_L * 3 + 2]!
  let l = Math.hypot(xx, xy, xz) || 1
  xx /= l
  xy /= l
  xz /= l
  let yx = pos[P_NECK * 3]! - ox
  let yy = pos[P_NECK * 3 + 1]! - oy
  let yz = pos[P_NECK * 3 + 2]! - oz
  const d = yx * xx + yy * xy + yz * xz
  yx -= xx * d
  yy -= xy * d
  yz -= xz * d
  l = Math.hypot(yx, yy, yz) || 1
  yx /= l
  yy /= l
  yz /= l
  out[0] = ox
  out[1] = oy
  out[2] = oz
  out[3] = xx
  out[4] = xy
  out[5] = xz
  out[6] = yx
  out[7] = yy
  out[8] = yz
  out[9] = xy * yz - xz * yy
  out[10] = xz * yx - xx * yz
  out[11] = xx * yy - xy * yx
}

/** A frame at point a whose y runs from b to a (up the bone), x from the block's reference axis. */
function limbFrame(pos: Float32Array, a: number, b: number, block: Float32Array, ref: 0 | 2, out: Float32Array): void {
  let yx = pos[a * 3]! - pos[b * 3]!
  let yy = pos[a * 3 + 1]! - pos[b * 3 + 1]!
  let yz = pos[a * 3 + 2]! - pos[b * 3 + 2]!
  let l = Math.hypot(yx, yy, yz) || 1
  yx /= l
  yy /= l
  yz /= l
  const r0 = ref === 0 ? 3 : 9
  const r1 = ref === 0 ? 9 : 3
  let rx = block[r0]!
  let ry = block[r0 + 1]!
  let rz = block[r0 + 2]!
  let d = rx * yx + ry * yy + rz * yz
  if (Math.abs(d) > 0.9) {
    rx = block[r1]!
    ry = block[r1 + 1]!
    rz = block[r1 + 2]!
    d = rx * yx + ry * yy + rz * yz
  }
  let xx = rx - yx * d
  let xy = ry - yy * d
  let xz = rz - yz * d
  l = Math.hypot(xx, xy, xz) || 1
  xx /= l
  xy /= l
  xz /= l
  out[0] = pos[a * 3]!
  out[1] = pos[a * 3 + 1]!
  out[2] = pos[a * 3 + 2]!
  out[3] = xx
  out[4] = xy
  out[5] = xz
  out[6] = yx
  out[7] = yy
  out[8] = yz
  out[9] = xy * yz - xz * yy
  out[10] = xz * yx - xx * yz
  out[11] = xx * yy - xy * yx
}

function driverOf(pos: Float32Array, bone: number, block: Float32Array, out: Float32Array): Float32Array {
  const d = DRIVES[bone]!
  if (d.kind === Drive.Block) return block
  limbFrame(pos, d.a, d.b, block, d.ref, out)
  return out
}

/** `out = Dᵀ (F − D)`: frame F expressed in driver D. */
function toLocal(D: Float32Array, F: Float32Array, fo: number, out: Float32Array, oo: number): void {
  const px = F[fo]! - D[0]!
  const py = F[fo + 1]! - D[1]!
  const pz = F[fo + 2]! - D[2]!
  for (let k = 0; k < 4; k++) {
    const vx = k === 0 ? px : F[fo + k * 3]!
    const vy = k === 0 ? py : F[fo + k * 3 + 1]!
    const vz = k === 0 ? pz : F[fo + k * 3 + 2]!
    out[oo + k * 3] = vx * D[3]! + vy * D[4]! + vz * D[5]!
    out[oo + k * 3 + 1] = vx * D[6]! + vy * D[7]! + vz * D[8]!
    out[oo + k * 3 + 2] = vx * D[9]! + vy * D[10]! + vz * D[11]!
  }
}

/** `F = D + D·L`: the inverse of `toLocal`. */
function fromLocal(D: Float32Array, L: Float32Array, lo: number, out: Float32Array, oo: number): void {
  for (let k = 0; k < 4; k++) {
    const a = L[lo + k * 3]!
    const b = L[lo + k * 3 + 1]!
    const c = L[lo + k * 3 + 2]!
    const base = k === 0 ? 1 : 0
    out[oo + k * 3] = D[0]! * base + D[3]! * a + D[6]! * b + D[9]! * c
    out[oo + k * 3 + 1] = D[1]! * base + D[4]! * a + D[7]! * b + D[10]! * c
    out[oo + k * 3 + 2] = D[2]! * base + D[5]! * a + D[8]! * b + D[11]! * c
  }
}

/** The 16 joint points of a 15-bone pose at `off` (bone frames as written by Outbreak's zombie renderer). */
export function bonePoints(bones: Float32Array, off: number, out: Float32Array): Float32Array {
  const f = (bone: number, i: number) => bones[off + bone * 12 + i]!
  const put = (p: number, x: number, y: number, z: number) => {
    out[p * 3] = x
    out[p * 3 + 1] = y
    out[p * 3 + 2] = z
  }
  // Limb frames run y from the far joint up to the near one, so the far joint is origin − y × length.
  const tip = (bone: number, length: number, p: number) =>
    put(p, f(bone, 0) - f(bone, 6) * length, f(bone, 1) - f(bone, 7) * length, f(bone, 2) - f(bone, 8) * length)
  put(P_HIP_L, f(7, 0), f(7, 1), f(7, 2))
  put(P_HIP_R, f(8, 0), f(8, 1), f(8, 2))
  put(P_SH_L, f(3, 0), f(3, 1), f(3, 2))
  put(P_SH_R, f(4, 0), f(4, 1), f(4, 2))
  put(P_NECK, f(2, 0), f(2, 1), f(2, 2))
  put(P_CROWN, f(2, 0) + f(2, 6) * 0.24, f(2, 1) + f(2, 7) * 0.24, f(2, 2) + f(2, 8) * 0.24)
  put(P_KNEE_L, f(9, 0), f(9, 1), f(9, 2))
  put(P_KNEE_R, f(10, 0), f(10, 1), f(10, 2))
  put(P_ANK_L, f(11, 0), f(11, 1), f(11, 2))
  put(P_ANK_R, f(12, 0), f(12, 1), f(12, 2))
  put(P_BALL_L, f(13, 0), f(13, 1), f(13, 2))
  put(P_BALL_R, f(14, 0), f(14, 1), f(14, 2))
  put(P_ELB_L, f(5, 0), f(5, 1), f(5, 2))
  put(P_ELB_R, f(6, 0), f(6, 1), f(6, 2))
  tip(5, RIG.fore, P_HAND_L)
  tip(6, RIG.fore, P_HAND_R)
  return out
}

export type RagdollStart = {
  /** This frame's pose (15 bones from `off`). */
  bones: Float32Array
  off: number
  /** The previous frame's pose for the body's own motion, or null to start still. */
  prevBones?: Float32Array | null
  prevOff?: number
  /** Seconds between the two poses. */
  dt?: number
  seed: number
  rects?: readonly (readonly [number, number, number, number])[]
}

const startPts = new Float32Array(N * 3)
const prevPts = new Float32Array(N * 3)

export function createBoneRagdoll(start: RagdollStart): BoneRagdoll {
  const pos = new Float32Array(N * 3)
  const prev = new Float32Array(N * 3)
  bonePoints(start.bones, start.off, startPts)
  pos.set(startPts)
  const hasPrev = Boolean(start.prevBones) && (start.dt ?? 0) > 1e-4
  if (hasPrev) bonePoints(start.prevBones!, start.prevOff ?? start.off, prevPts)
  // The body's own motion, as a substep displacement, capped so a teleport or a long frame cannot fling it.
  const k = hasPrev ? SUB / start.dt! : 0
  for (let i = 0; i < N; i++) {
    let vx = hasPrev ? (startPts[i * 3]! - prevPts[i * 3]!) * k : 0
    let vy = hasPrev ? (startPts[i * 3 + 1]! - prevPts[i * 3 + 1]!) * k : 0
    let vz = hasPrev ? (startPts[i * 3 + 2]! - prevPts[i * 3 + 2]!) * k : 0
    const v = Math.hypot(vx, vy, vz)
    const cap = 7 * SUB
    if (v > cap) {
      vx *= cap / v
      vy *= cap / v
      vz *= cap / v
    }
    prev[i * 3] = pos[i * 3]! - vx
    prev[i * 3 + 1] = pos[i * 3 + 1]! - vy
    prev[i * 3 + 2] = pos[i * 3 + 2]! - vz
  }

  const ca: number[] = []
  const cb: number[] = []
  const cd: number[] = []
  const ck: number[] = []
  const rest = (a: number, b: number) =>
    Math.hypot(pos[a * 3]! - pos[b * 3]!, pos[a * 3 + 1]! - pos[b * 3 + 1]!, pos[a * 3 + 2]! - pos[b * 3 + 2]!)
  const link = (a: number, b: number, kind = C_EXACT, d = rest(a, b)) => {
    ca.push(a)
    cb.push(b)
    cd.push(d)
    ck.push(kind)
  }
  const block = [P_HIP_L, P_HIP_R, P_SH_L, P_SH_R, P_NECK]
  for (let i = 0; i < block.length; i++) for (let j = i + 1; j < block.length; j++) link(block[i]!, block[j]!)
  // The neck flops but the head cannot fold into the chest or hang off the back.
  link(P_NECK, P_CROWN)
  link(P_SH_L, P_CROWN, C_MIN, rest(P_SH_L, P_CROWN) * 0.86)
  link(P_SH_R, P_CROWN, C_MIN, rest(P_SH_R, P_CROWN) * 0.86)
  link(P_SH_L, P_CROWN, C_MAX, rest(P_SH_L, P_CROWN) * 1.08)
  link(P_SH_R, P_CROWN, C_MAX, rest(P_SH_R, P_CROWN) * 1.08)
  // Limbs keep the rig's lengths, not whatever IK stretch the last frame had.
  link(P_HIP_L, P_KNEE_L, C_EXACT, RIG.thigh)
  link(P_HIP_R, P_KNEE_R, C_EXACT, RIG.thigh)
  link(P_KNEE_L, P_ANK_L, C_EXACT, RIG.shin)
  link(P_KNEE_R, P_ANK_R, C_EXACT, RIG.shin)
  link(P_ANK_L, P_BALL_L)
  link(P_ANK_R, P_BALL_R)
  link(P_SH_L, P_ELB_L, C_EXACT, RIG.upper)
  link(P_SH_R, P_ELB_R, C_EXACT, RIG.upper)
  link(P_ELB_L, P_HAND_L, C_EXACT, RIG.fore)
  link(P_ELB_R, P_HAND_R, C_EXACT, RIG.fore)
  // Joint limits as minimum spans: knees and elbows cannot fold flat, feet cannot fold into the shin, legs and arms
  // cannot pass through each other or into the chest.
  link(P_HIP_L, P_ANK_L, C_MIN, 0.36)
  link(P_HIP_R, P_ANK_R, C_MIN, 0.36)
  link(P_KNEE_L, P_BALL_L, C_MIN, rest(P_KNEE_L, P_BALL_L) * 0.88)
  link(P_KNEE_R, P_BALL_R, C_MIN, rest(P_KNEE_R, P_BALL_R) * 0.88)
  link(P_SH_L, P_HAND_L, C_MIN, 0.22)
  link(P_SH_R, P_HAND_R, C_MIN, 0.22)
  link(P_KNEE_L, P_KNEE_R, C_MIN, 0.15)
  link(P_ANK_L, P_ANK_R, C_MIN, 0.12)
  link(P_NECK, P_KNEE_L, C_MIN, 0.5)
  link(P_NECK, P_KNEE_R, C_MIN, 0.5)
  link(P_HAND_L, P_HIP_R, C_MIN, 0.14)
  link(P_HAND_R, P_HIP_L, C_MIN, 0.14)

  // Bind every bone to its driver on this exact pose.
  const local = new Float32Array(RAGDOLL_BONES * 12)
  blockFrame(pos, driver)
  const blk = new Float32Array(driver)
  for (let b = 0; b < RAGDOLL_BONES; b++) {
    const D = driverOf(pos, b, blk, scratch)
    toLocal(D, start.bones, start.off + b * 12, local, b * 12)
  }

  return {
    pos,
    prev,
    ca: Int8Array.from(ca),
    cb: Int8Array.from(cb),
    cd: Float32Array.from(cd),
    ck: Int8Array.from(ck),
    count: ca.length,
    local,
    rects: start.rects ?? [],
    acc: 0,
    still: 0,
    age: 0,
    awakeFor: 0,
    asleep: false,
    rng: new Rng(start.seed >>> 0 || 1),
  }
}

/** Adds velocity (m/s) to one point. */
function addVel(r: BoneRagdoll, i: number, vx: number, vy: number, vz: number): void {
  r.prev[i * 3] = r.prev[i * 3]! - vx * SUB
  r.prev[i * 3 + 1] = r.prev[i * 3 + 1]! - vy * SUB
  r.prev[i * 3 + 2] = r.prev[i * 3 + 2]! - vz * SUB
}

function wake(r: BoneRagdoll): void {
  r.asleep = false
  r.still = 0
  r.awakeFor = 0
}

/**
 * How a death plays: `push` m/s along the plan direction at the chest (the hips take half, the legs a fifth), `lift`
 * m/s up, `spin` m/s twisting the shoulders about the spine, `buckle` m/s folding the knees forward and down (the
 * crumple), and `sweep` m/s taking the legs out along the direction (a car).
 */
export type RagdollImpulse = { dirX: number; dirZ: number; push: number; lift?: number; spin?: number; buckle?: number; sweep?: number }

export function impulseRagdoll(r: BoneRagdoll, imp: RagdollImpulse): void {
  const l = Math.hypot(imp.dirX, imp.dirZ) || 1
  const dx = imp.dirX / l
  const dz = imp.dirZ / l
  const lift = imp.lift ?? 0
  const spin = imp.spin ?? 0
  const buckle = imp.buckle ?? 0
  const sweep = imp.sweep ?? 0
  for (const i of UPPER) addVel(r, i, dx * imp.push, lift, dz * imp.push)
  for (const i of HIPS) addVel(r, i, dx * imp.push * 0.55, lift * 0.7, dz * imp.push * 0.55)
  for (const i of LEGS) addVel(r, i, dx * (imp.push * 0.2 + sweep), lift * 0.25 + sweep * 0.35, dz * (imp.push * 0.2 + sweep))
  if (spin !== 0) {
    // Twist about the spine: the shoulders go opposite ways along the body's forward axis.
    blockFrame(r.pos, driver)
    const fx = driver[9]!
    const fz = driver[11]!
    addVel(r, P_SH_L, fx * spin, 0, fz * spin)
    addVel(r, P_SH_R, -fx * spin, 0, -fz * spin)
    addVel(r, P_CROWN, -fx * spin * 0.4, 0, -fz * spin * 0.4)
  }
  if (buckle !== 0) {
    blockFrame(r.pos, driver)
    const fx = driver[9]!
    const fz = driver[11]!
    for (const i of [P_KNEE_L, P_KNEE_R]) addVel(r, i, fx * buckle * 1.2, -buckle, fz * buckle * 1.2)
    for (const i of [P_HIP_L, P_HIP_R, P_NECK]) addVel(r, i, 0, -buckle * 0.6, 0)
  }
  wake(r)
}

/**
 * A radial push from a blast centre (plan x, z; height y): `strength` m/s at the centre falling off linearly to
 * `radius`, with `lift` × that thrown upward. Returns whether it reached the body.
 */
export function blastRagdoll(r: BoneRagdoll, cx: number, cy: number, cz: number, strength: number, radius: number, lift = 0.6): boolean {
  let any = false
  for (let i = 0; i < N; i++) {
    const dx = r.pos[i * 3]! - cx
    const dy = r.pos[i * 3 + 1]! - cy
    const dz = r.pos[i * 3 + 2]! - cz
    const d = Math.hypot(dx, dy, dz)
    if (d >= radius) continue
    any = true
    const f = strength * (1 - d / radius)
    const inv = 1 / (d || 1)
    addVel(r, i, dx * inv * f, Math.max(0, dy * inv) * f + f * lift, dz * inv * f)
  }
  if (any) wake(r)
  return any
}

/** A plan box: centre, heading (radians, length along it) and half extents (metres). */
export type SweepBox = { x: number; z: number; yaw: number; halfLength: number; halfWidth: number }

/**
 * Something solid sweeping through (a car): every point inside the plan box below `top` takes the mover's velocity
 * plus `lift` m/s, so a body under a bumper is thrown and tumbles. Returns the points it touched.
 */
export function sweepRagdoll(r: BoneRagdoll, box: SweepBox, top: number, vx: number, vz: number, lift: number): number {
  let n = 0
  const c = Math.cos(box.yaw)
  const s = Math.sin(box.yaw)
  for (let i = 0; i < N; i++) {
    const dx = r.pos[i * 3]! - box.x
    const y = r.pos[i * 3 + 1]!
    const dz = r.pos[i * 3 + 2]! - box.z
    if (y > top || Math.abs(dx * c + dz * s) > box.halfLength || Math.abs(-dx * s + dz * c) > box.halfWidth) continue
    // Match the mover's speed, never slow a point that is already flying faster.
    const cvx = (r.pos[i * 3]! - r.prev[i * 3]!) / SUB
    const cvz = (r.pos[i * 3 + 2]! - r.prev[i * 3 + 2]!) / SUB
    addVel(r, i, (vx - cvx) * 0.85, lift * (0.6 + 0.4 * r.rng.next()), (vz - cvz) * 0.85)
    n++
  }
  if (n) wake(r)
  return n
}

function solve(r: BoneRagdoll): void {
  const { pos, ca, cb, cd, ck } = r
  for (let c = 0; c < r.count; c++) {
    const a = ca[c]! * 3
    const b = cb[c]! * 3
    const dx = pos[b]! - pos[a]!
    const dy = pos[b + 1]! - pos[a + 1]!
    const dz = pos[b + 2]! - pos[a + 2]!
    const l = Math.hypot(dx, dy, dz) || 1e-6
    const kind = ck[c]!
    if (kind === C_MIN && l >= cd[c]!) continue
    if (kind === C_MAX && l <= cd[c]!) continue
    const k = ((l - cd[c]!) / l) * 0.5
    pos[a] = pos[a]! + dx * k
    pos[a + 1] = pos[a + 1]! + dy * k
    pos[a + 2] = pos[a + 2]! + dz * k
    pos[b] = pos[b]! - dx * k
    pos[b + 1] = pos[b + 1]! - dy * k
    pos[b + 2] = pos[b + 2]! - dz * k
  }
}

const groundAt = new Float32Array(N)

function collide(r: BoneRagdoll, t: RagdollTuning): void {
  const { pos, prev } = r
  for (let i = 0; i < N; i++) {
    const o = i * 3
    const rad = RADIUS[i]!
    const g = groundAt[i]! + rad
    if (pos[o + 1]! < g) {
      const vy = pos[o + 1]! - prev[o + 1]!
      pos[o + 1] = g
      prev[o + 1] = g + (vy < 0 ? vy * t.bounce : vy)
      prev[o] = pos[o]! - (pos[o]! - prev[o]!) * t.friction
      prev[o + 2] = pos[o + 2]! - (pos[o + 2]! - prev[o + 2]!) * t.friction
    }
    if (pos[o + 1]! > groundAt[i]! + 2.4) continue
    for (const w of r.rects) {
      const x0 = w[0] - rad
      const x1 = w[2] + rad
      const z0 = w[1] - rad
      const z1 = w[3] + rad
      const x = pos[o]!
      const z = pos[o + 2]!
      if (x <= x0 || x >= x1 || z <= z0 || z >= z1) continue
      const m = Math.min(x - x0, x1 - x, z - z0, z1 - z)
      if (m === x - x0) pos[o] = x0
      else if (m === x1 - x) pos[o] = x1
      else if (m === z - z0) pos[o + 2] = z0
      else pos[o + 2] = z1
    }
  }
}

/**
 * Advances the ragdoll by `dt` seconds in fixed 1/120 s substeps (at most 8 per call, so a hitch cannot spiral).
 * `ground(x, z)` is the floor height under a point. Returns whether it moved.
 */
export function stepBoneRagdoll(
  r: BoneRagdoll,
  dt: number,
  ground: (x: number, z: number) => number,
  t: RagdollTuning = DEFAULT_RAGDOLL_TUNING,
): boolean {
  if (r.asleep || dt <= 0) return false
  r.age += dt
  r.awakeFor += dt
  for (let i = 0; i < N; i++) groundAt[i] = ground(r.pos[i * 3]!, r.pos[i * 3 + 2]!)
  r.acc = Math.min(r.acc + dt, SUB * 8)
  let moving = 0
  const drop = t.gravity * SUB * SUB
  const { pos, prev } = r
  while (r.acc >= SUB) {
    r.acc -= SUB
    for (let i = 0; i < N; i++) {
      const o = i * 3
      const vx = (pos[o]! - prev[o]!) * 0.998
      const vy = (pos[o + 1]! - prev[o + 1]!) * 0.998
      const vz = (pos[o + 2]! - prev[o + 2]!) * 0.998
      prev[o] = pos[o]!
      prev[o + 1] = pos[o + 1]!
      prev[o + 2] = pos[o + 2]!
      pos[o] = pos[o]! + vx
      pos[o + 1] = pos[o + 1]! + vy - drop
      pos[o + 2] = pos[o + 2]! + vz
      const m = Math.abs(vx) + Math.abs(vy) + Math.abs(vz)
      if (m > moving) moving = m
    }
    for (let it = 0; it < t.iterations; it++) {
      solve(r)
      collide(r, t)
    }
  }
  r.still = moving < 0.0011 ? r.still + dt : 0
  if (r.still > t.sleepAfter || r.awakeFor > t.maxAwake) {
    r.asleep = true
    for (let i = 0; i < N * 3; i++) prev[i] = pos[i]!
  }
  return true
}

/** Writes the ragdoll's 15 bone frames into `out` from `off`, in the layout it started from. */
export function writeRagdollBones(r: BoneRagdoll, out: Float32Array, off: number): void {
  blockFrame(r.pos, driver)
  const blk = driver
  for (let b = 0; b < RAGDOLL_BONES; b++) {
    const D = driverOf(r.pos, b, blk, scratch)
    fromLocal(D, r.local, b * 12, out, off + b * 12)
  }
}

/** The ragdoll's mid-hip point on the plan and its height, for blood, sound and culling. */
export function ragdollHips(r: BoneRagdoll): { x: number; y: number; z: number } {
  return {
    x: (r.pos[P_HIP_L * 3]! + r.pos[P_HIP_R * 3]!) * 0.5,
    y: (r.pos[P_HIP_L * 3 + 1]! + r.pos[P_HIP_R * 3 + 1]!) * 0.5,
    z: (r.pos[P_HIP_L * 3 + 2]! + r.pos[P_HIP_R * 3 + 2]!) * 0.5,
  }
}

/** Fastest point speed (m/s) over the last substep: how hard it is still moving (sound on landing, debug). */
export function ragdollSpeed(r: BoneRagdoll): number {
  let m = 0
  for (let i = 0; i < N * 3; i += 3) {
    const v = Math.hypot(r.pos[i]! - r.prev[i]!, r.pos[i + 1]! - r.prev[i + 1]!, r.pos[i + 2]! - r.prev[i + 2]!)
    if (v > m) m = v
  }
  return m / SUB
}

/** Largest relative error of the exact (limb and block) constraints, for tests. */
export function ragdollStretch(r: BoneRagdoll): number {
  let worst = 0
  for (let c = 0; c < r.count; c++) {
    if (r.ck[c] !== C_EXACT) continue
    const a = r.ca[c]! * 3
    const b = r.cb[c]! * 3
    const l = Math.hypot(r.pos[b]! - r.pos[a]!, r.pos[b + 1]! - r.pos[a + 1]!, r.pos[b + 2]! - r.pos[a + 2]!)
    worst = Math.max(worst, Math.abs(l - r.cd[c]!) / r.cd[c]!)
  }
  return worst
}

/**
 * A neutral standing pose in the 15-bone layout at plan (x, z) facing `yaw`, feet on `groundY`: the fixture tests and
 * Lab replays start ragdolls from. Frames follow Outbreak's zombie renderer (yaw frames for the trunk and head with x
 * forward, limb frames whose y runs up the bone).
 */
export function standingBones(x: number, z: number, yaw: number, groundY = 0, out = new Float32Array(RAGDOLL_BONES * 12)): Float32Array {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const yawFrame = (b: number, px: number, py: number, pz: number) => {
    const o = b * 12
    out.set([px, py, pz, c, 0, s, 0, 1, 0, -s, 0, c], o)
  }
  // Limb frame: origin at the near joint, y up the bone (pointing from far to near), x forward.
  const limb = (b: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    let yx = ax - bx
    let yy = ay - by
    let yz = az - bz
    const l = Math.hypot(yx, yy, yz) || 1
    yx /= l
    yy /= l
    yz /= l
    const d = c * yx + s * yz
    let xx = c - yx * d
    let xy = -yy * d
    let xz = s - yz * d
    const xl = Math.hypot(xx, xy, xz) || 1
    xx /= xl
    xy /= xl
    xz /= xl
    out.set([ax, ay, az, xx, xy, xz, yx, yy, yz, xy * yz - xz * yy, xz * yx - xx * yz, xx * yy - xy * yx], b * 12)
  }
  const side = (k: number, lat: number): [number, number] => [x - s * lat * k, z + c * lat * k]
  const hipY = groundY + HIP
  yawFrame(0, x, hipY, z)
  yawFrame(1, x, hipY + RIG.waist, z)
  yawFrame(2, x, hipY + RIG.waist + RIG.neckY, z)
  for (let i = 0; i < 2; i++) {
    const k = i ? 1 : -1
    const [hx, hz] = side(k, RIG.hipW)
    const kneeY = hipY - RIG.thigh
    const ankY = kneeY - RIG.shin
    limb(7 + i, hx, hipY, hz, hx + c * 0.02, kneeY, hz + s * 0.02)
    limb(9 + i, hx + c * 0.02, kneeY, hz + s * 0.02, hx, ankY, hz)
    yawFrame(11 + i, hx, ankY, hz)
    yawFrame(13 + i, hx + c * RIG.foot, ankY - RIG.ankle, hz + s * RIG.foot)
    const [sx, sz] = side(k, RIG.shoulderW)
    const shY = hipY + RIG.waist + RIG.shoulderY
    const elY = shY - RIG.upper
    limb(3 + i, sx, shY, sz, sx + c * 0.04, elY, sz + s * 0.04)
    limb(5 + i, sx + c * 0.04, elY, sz + s * 0.04, sx + c * 0.1, elY - RIG.fore * 0.98, sz + s * 0.1)
  }
  return out
}
