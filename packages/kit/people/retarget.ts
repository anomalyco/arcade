/**
 * Drives a skinned MakeHuman `game_engine` skeleton (53 bones, UE-style names) from the shared kit rig's `HumanBody`.
 *
 * The rig stays the motion source: stride clock, planted feet, swing, pelvis springs, arm swing and hand targets.
 * Here its frames become bone rotations, and two-bone IK on the mesh's own bone lengths puts each ankle and wrist
 * exactly where the rig (scaled to the person) wants it, bending toward the rig's own knee and elbow, so planted
 * feet never slide whatever the person's proportions. Pure: no DOM or GPU; `people.test.ts` checks it.
 *
 * Spaces: the model is glTF Y-up, facing +Z, its left at +X. Rig frames are x forward, y up, z right. A bone's
 * world rotation is `F_now · F_bind⁻¹ · R_bind`, where F is the same construction (a rigid rig frame, or a limb's
 * direction and hinge axis) evaluated on the rig now and on the mesh's bind pose.
 */
import { ik, RIG, type Frame, type V3 } from "../rig"
import type { HumanBody } from "../human-pose"
import { qAngle, qAxisAngle, qBasis, qConj, qFromTo, qMul, qNorm, qRot, qSlerp, writeMatrix, type Q } from "./quat"

export type Skeleton = {
  names: string[]
  /** Parent joint index, or -1. Joints are ordered parents first. */
  parent: number[]
  /** Bind pose in model space (inverse of each inverse-bind matrix). */
  bindPos: V3[]
  bindRot: Q[]
  /** Column-major inverse bind matrices, 16 floats per joint. */
  ibm: Float32Array
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: V3) => Math.hypot(a[0], a[1], a[2])
const norm = (a: V3): V3 => mul(a, 1 / (len(a) || 1))
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const frameQ = (f: Frame): Q => qBasis(f.x, f.y, f.z)

/** Model-space rig frame of the bind pose: forward +Z, up +Y, right −X. */
const BIND_BODY = qBasis([0, 0, 1], [0, 1, 0], [-1, 0, 0])
const FWD: V3 = [0, 0, 1]

/** Limb basis: bone direction, hinge axis made orthogonal to it, and their cross product. */
function limbQ(dir: V3, hinge: V3): Q {
  const h = norm(sub(hinge, mul(dir, dot(hinge, dir))))
  return qBasis(dir, h, cross(dir, h))
}

type Chain = { upper: number; lower: number; end: number; lu: number; ll: number; bindU: Q; bindL: Q }

export type PersonRest = {
  skeleton: Skeleton
  local: { pos: V3[]; rot: Q[] }
  idx: Record<string, number>
  /** World = rig × scale for this person (mesh leg length over the rig's). */
  scale: number
  /** The sole under each heel, foot-local. */
  heel: [V3, V3]
  /** Height of the mesh's ball-of-foot joint above the sole (m). */
  ballHeight: number
  /** The mesh boot along the ground (m, world): ball back to the ankle, and ball back to the heel. */
  sole: { toAnkle: number; toHeel: number }
  /** Pelvis bone origin relative to the mid-hip, model space. */
  pelvisOffset: V3
  arms: [Chain, Chain]
  legs: [Chain, Chain]
  /** Foot and ball bind bases (rig-like: forward along the foot, up, right). */
  footBind: [Q, Q]
  /** Standing height of the top of the head (m, model space). */
  height: number
  hands: [HandRest, HandRest]
}

export type HandRest = {
  /** Barrel axis of a held flashlight, hand-local (bind). */
  barrel: V3
  /** Grip centre, hand-local. */
  grip: V3
  /** Fingers closed round that barrel, solved for this hand (`solveTorchGrip`). */
  torch: HandPose
  joints: { index: number; finger: Finger; joint: number; flex: V3; spread: V3; oppose?: V3 }[]
}
export type Finger = "index" | "middle" | "ring" | "pinky" | "thumb"

const need = (idx: Record<string, number>, n: string) => {
  const i = idx[n]
  if (i === undefined) throw new Error(`skeleton has no ${n} bone`)
  return i
}

export function personRest(skeleton: Skeleton): PersonRest {
  const { names, parent, bindPos, bindRot } = skeleton
  const idx: Record<string, number> = {}
  names.forEach((n, i) => { idx[n] = i })
  const local = { pos: [] as V3[], rot: [] as Q[] }
  for (let i = 0; i < names.length; i++) {
    const p = parent[i]!
    if (p < 0) { local.pos.push(bindPos[i]!); local.rot.push(bindRot[i]!); continue }
    const inv = qConj(bindRot[p]!)
    local.pos.push(qRot(inv, sub(bindPos[i]!, bindPos[p]!)))
    local.rot.push(qNorm(qMul(inv, bindRot[i]!)))
  }
  const P = (n: string) => bindPos[need(idx, n)]!
  const chain = (u: string, l: string, e: string): Chain => {
    const upper = need(idx, u), lower = need(idx, l), end = need(idx, e)
    const dU = norm(sub(bindPos[lower]!, bindPos[upper]!)), dL = norm(sub(bindPos[end]!, bindPos[lower]!))
    const hinge = norm(cross(dU, FWD))
    return { upper, lower, end, lu: len(sub(bindPos[lower]!, bindPos[upper]!)), ll: len(sub(bindPos[end]!, bindPos[lower]!)), bindU: limbQ(dU, hinge), bindL: limbQ(dL, hinge) }
  }
  const legs: [Chain, Chain] = [chain("thigh_l", "calf_l", "foot_l"), chain("thigh_r", "calf_r", "foot_r")]
  const meshLeg = legs[0].lu + legs[0].ll + P("foot_l")[1]
  const scale = meshLeg / (RIG.thigh + RIG.shin + RIG.ankle)
  const footBind = (["l", "r"] as const).map((s) => {
    const f = sub(P(`ball_${s}`), P(`foot_${s}`))
    const fwd = norm([f[0], 0, f[2]])
    return qBasis(fwd, [0, 1, 0], cross(fwd, [0, 1, 0]))
  }) as [Q, Q]
  const midHip = mul(add(P("thigh_l"), P("thigh_r")), 0.5)
  let top = 0
  for (const p of bindPos) top = Math.max(top, p[1])
  const rest: PersonRest = {
    skeleton, local, idx, scale, footBind,
    ballHeight: Math.max(0, P("ball_l")[1]),
    sole: (() => {
      const f = sub(P("ball_l"), P("foot_l")), toAnkle = Math.hypot(f[0], f[2])
      return { toAnkle, toHeel: toAnkle + RIG.heel * scale }
    })(),
    heel: (["l", "r"] as const).map((s) => {
      const f = P(`foot_${s}`), ball = P(`ball_${s}`), back = norm([f[0] - ball[0], 0, f[2] - ball[2]])
      return qRot(qConj(bindRot[need(idx, `foot_${s}`)]!), sub([f[0] + back[0] * RIG.heel * scale, 0, f[2] + back[2] * RIG.heel * scale], f))
    }) as [V3, V3],
    pelvisOffset: sub(P("pelvis"), midHip),
    arms: [chain("upperarm_l", "lowerarm_l", "hand_l"), chain("upperarm_r", "lowerarm_r", "hand_r")],
    legs,
    height: top + 0.12,
    hands: [handRest(skeleton, idx, "l"), handRest(skeleton, idx, "r")],
  }
  for (const side of [0, 1] as const) rest.hands[side].torch = solveTorchGrip(rest, side)
  return rest
}

const FINGERS = ["index", "middle", "ring", "pinky"] as const

/** Measures one hand at the bind pose: each finger joint's flexion axis (bone × palm normal), after Aiden's hands.ts. */
function handRest(sk: Skeleton, idx: Record<string, number>, s: "l" | "r"): HandRest {
  const P = (n: string) => sk.bindPos[need(idx, n)]!
  const hand = P(`hand_${s}`), along = norm(sub(P(`middle_01_${s}`), hand)), across = norm(sub(P(`index_01_${s}`), P(`pinky_01_${s}`)))
  // Fingers curl toward the palm: palm = along × across for the right hand, mirrored for the left.
  const palm = norm(mul(cross(along, across), s === "r" ? 1 : -1))
  const inv = qConj(sk.bindRot[need(idx, `hand_${s}`)]!)
  const joints: HandRest["joints"] = []
  for (const finger of [...FINGERS, "thumb"] as const) {
    for (let j = 1; j <= 3; j++) {
      const index = idx[`${finger}_0${j}_${s}`]
      if (index === undefined) continue
      const next = idx[`${finger}_0${j + 1}_${s}`]
      const p = sk.bindPos[index]!
      const dir = next !== undefined ? norm(sub(sk.bindPos[next]!, p)) : j > 1 ? norm(sub(p, sk.bindPos[idx[`${finger}_0${j - 1}_${s}`]!]!)) : along
      const binv = qConj(sk.bindRot[index]!)
      let flex = norm(cross(dir, palm))
      let oppose: V3 | undefined
      if (finger === "thumb") {
        const toward = norm(add(palm, mul(across, -0.6)))
        flex = norm(cross(dir, toward))
        oppose = qRot(binv, mul(along, s === "r" ? -1 : 1))
      }
      joints.push({ index, finger, joint: j, flex: qRot(binv, flex), spread: qRot(binv, palm), oppose })
    }
  }
  // A flashlight lies diagonally in the fist, from the heel of the hand to the index knuckle, front end out past the
  // index and thumb; its axis runs one finger's half-thickness plus the barrel's radius in front of the knuckles.
  const barrel = qRot(inv, norm(add(across, mul(along, GRIP.diagonal))))
  const knuckles = mul(add(P(`index_01_${s}`), P(`pinky_01_${s}`)), 0.5)
  const grip = qRot(inv, add(sub(knuckles, hand), add(mul(palm, GRIP.radius + GRIP.finger), mul(along, GRIP.back))))
  return { barrel, grip, torch: TORCH_GRIP, joints }
}

/** A held flashlight: barrel radius, a finger's half-thickness (m), its diagonal in the palm (along per across), and
 * how far behind the knuckles its axis sits (m). */
export const GRIP = { radius: 0.018, finger: 0.0085, diagonal: 0.45, back: -0.012 }

/**
 * Closes one hand round its flashlight barrel: per finger, the MCP and PIP flexion (DIP two-thirds of PIP) that put
 * the finger's joints and tip on the barrel's surface; then the thumb's opposition, swing and curl that wrap it over
 * the other side. Fingers differ in length and knuckle height, so one set of angles for every hand leaves some
 * fingers inside the barrel and others off it. Once per person, at load.
 */
function solveTorchGrip(rest: PersonRest, side: 0 | 1): HandPose {
  const sk = rest.skeleton, hr = rest.hands[side]!, s = side === 1 ? "r" : "l"
  const pose: PersonPose = { rot: sk.bindRot.map((q) => [...q] as Q), pos: sk.bindPos.map((p) => [...p] as V3), torch: null }
  const hand = rest.idx[`hand_${s}`]!
  const axis = qRot(sk.bindRot[hand]!, hr.barrel), centre = add(sk.bindPos[hand]!, qRot(sk.bindRot[hand]!, hr.grip))
  const R = GRIP.radius + GRIP.finger
  const off = (p: V3) => { const d = sub(p, centre); return len(sub(d, mul(axis, dot(d, axis)))) }
  const pts = (f: Finger) => {
    const j = [1, 2, 3].map((k) => pose.pos[rest.idx[`${f}_0${k}_${s}`]!]!)
    return [j[1]!, j[2]!, add(j[2]!, mul(sub(j[2]!, j[1]!), 0.85))]
  }
  const best: HandPose = { ...TORCH_GRIP, index: [...TORCH_GRIP.index], middle: [...TORCH_GRIP.middle], ring: [...TORCH_GRIP.ring], pinky: [...TORCH_GRIP.pinky], thumb: [...TORCH_GRIP.thumb], together: 0 }
  // Inside the barrel costs more than off it.
  const miss = (ps: V3[]) => ps.reduce((a, p) => { const e = off(p) - R; return a + (e < 0 ? 4 * e * e : e * e) }, 0)
  for (const f of FINGERS) {
    let low = Infinity
    const at = (m: number, q: number) => {
      if (m < 0 || m > 95 || q < 0 || q > 110) return
      poseFingers(rest, side, { ...best, [f]: [m, q, q * 0.66] }, pose)
      const c = miss(pts(f))
      if (c < low) { low = c; best[f] = [m, q, q * 0.66] }
    }
    for (let m = 0; m <= 95; m += 5) for (let q = 0; q <= 110; q += 5) at(m, q)
    const [m0, q0] = best[f]
    for (const dm of [-2.5, 0, 2.5]) for (const dq of [-2.5, 0, 2.5]) at(m0 + dm, q0 + dq)
  }
  let low = Infinity
  const along = (p: V3) => dot(sub(p, centre), axis)
  poseFingers(rest, side, best, pose)
  const indexAt = along(pose.pos[rest.idx[`index_02_${s}`]!]!)
  const thumb = (o: number, w: number, c: number) => {
    if (o < 0 || o > 90 || w < -60 || w > 30 || c < 0 || c > 60) return
    const trial = { ...best, thumbOppose: o, thumbAlong: w, thumb: [c * 0.5, c, c] as [number, number, number] }
    poseFingers(rest, side, trial, pose)
    const [, b, tip] = pts("thumb")
    // The thumb closes over the barrel at the index end, its last bone and tip on the surface.
    const cost = miss([b!, tip!]) + 0.05 * (along(tip!) - indexAt) ** 2
    if (cost < low) { low = cost; best.thumbOppose = o; best.thumbAlong = w; best.thumb = trial.thumb }
  }
  for (let o = 0; o <= 90; o += 10) for (let w = -60; w <= 30; w += 10) for (let c = 0; c <= 60; c += 10) thumb(o, w, c)
  const [o0, w0, c0] = [best.thumbOppose, best.thumbAlong, best.thumb[1]]
  for (const d of [-5, 0, 5]) for (const e of [-5, 0, 5]) for (const g of [-5, 0, 5]) thumb(o0 + d, w0 + e, c0 + g)
  return best
}

/** Finger angles in degrees: [MCP, PIP, DIP] per finger, thumb opposition, swing and curl, fingers together. */
export type HandPose = {
  index: [number, number, number]; middle: [number, number, number]; ring: [number, number, number]; pinky: [number, number, number]
  thumbOppose: number; thumbAlong: number; thumb: [number, number, number]; together: number
}
/** A relaxed, hanging hand (flexion grows from index to pinky). */
export const RELAXED: HandPose = { index: [28, 42, 20], middle: [32, 50, 22], ring: [36, 54, 24], pinky: [40, 56, 26], thumbOppose: 40, thumbAlong: -10, thumb: [10, 18, 20], together: -6 }
/** A fist round a flashlight barrel (~35 mm): the starting point; each hand solves its own (`HandRest.torch`). */
export const TORCH_GRIP: HandPose = { index: [62, 78, 40], middle: [68, 80, 42], ring: [72, 80, 44], pinky: [76, 80, 46], thumbOppose: 60, thumbAlong: -45, thumb: [20, 30, 38], together: 2 }

export type PoseInput = {
  /** The rig's posed body in rig space (world / scale), on a flat floor at y = 0. */
  body: HumanBody
  /** World y added to the whole body (terrain support minus any reach drop). */
  lift: number
  /** World y added to each foot's ball target on top of `lift` (terrain under each foot relative to the support). */
  feet?: [number, number]
  /** Extra pitch per foot (rad, positive raises the heel) to lie along sloping ground. */
  tilt?: [number, number]
  /** Point the barrel of a flashlight held in hand `side` (0 left, 1 right) along world `dir`. */
  torch?: { side: 0 | 1; dir: V3 }
  /** Finger poses per hand (default RELAXED; a torch hand defaults to TORCH_GRIP). */
  grip?: [HandPose | null, HandPose | null]
  /** Extra head turn (rad): yaw left-positive about up, pitch up-positive; split between neck and head. */
  look?: { yaw: number; pitch: number }
  /** Breathing phase (rad); 0 amplitude when `breath` is 0. */
  breathPhase?: number
  breath?: number
  /**
   * Standing weight shift, −1 (onto the left leg) to 1 (onto the right): the hips slide over the loaded leg and the
   * free hip drops, the chest leans back over, the head stays level and the free knee unlocks (by IK).
   */
  shift?: number
  /** Plan offset in world units, added after scaling (for placing the person at world x/z exactly). */
  origin?: V3
  /** Seconds since the last pose of this `out`, to ease the reach sink back up; without it the sink is per frame. */
  dt?: number
}

export type PersonPose = {
  rot: Q[]
  pos: V3[]
  /** World frame of the held torch (x along the barrel), when `torch` was given. */
  torch: Frame | null
  /** How far the body sank last pose so short mesh legs reach the rig's ankles (world units). */
  sink?: number
}

export const newPose = (rest: PersonRest): PersonPose => ({ rot: rest.local.rot.map((q) => [...q] as Q), pos: rest.local.pos.map((p) => [...p] as V3), torch: null, sink: 0 })
/** Rate (1/s) the reach sink lets go. */
const SINK_RELEASE = 10

const limbHinge = (dU: V3, dL: V3, fallback: V3): V3 => {
  const bent = cross(dU, dL), b = len(bent)
  if (b < 1e-6) return fallback
  const n = mul(bent, (dot(bent, fallback) < 0 ? -1 : 1) / b)
  const w = smooth(0.05, 0.3, b)
  return norm(add(mul(fallback, 1 - w), mul(n, w)))
}

/** Poses every bone. Positions and rotations are world space. */
export function posePerson(rest: PersonRest, input: PoseInput, out: PersonPose): void {
  const { skeleton: sk, local, idx, scale: s } = rest
  const b = input.body
  const o = input.origin ?? [0, 0, 0]
  const W = (p: V3, dy = 0): V3 => [p[0] * s + o[0], p[1] * s + input.lift + dy + o[1], p[2] * s + o[2]]
  const n = sk.names.length
  const set = new Uint8Array(n)
  const rot = out.rot, pos = out.pos
  const delta = (f: Frame, bind: Q) => qMul(frameQ(f), qConj(bind))
  const dPelvis = delta(b.pelvis, BIND_BODY), dTorso = delta(b.torso, BIND_BODY)
  let dHead = delta(b.head, BIND_BODY)
  if (input.look) {
    const yaw = qAxisAngle(b.torso.y, input.look.yaw), pit = qAxisAngle(b.head.z, input.look.pitch)
    dHead = qMul(qMul(yaw, pit), dHead)
  }
  const breath = (input.breath ?? 0) * Math.sin(input.breathPhase ?? 0)
  const drive = (name: string, d: Q) => { const i = idx[name]; if (i !== undefined) { rot[i] = qNorm(qMul(d, sk.bindRot[i]!)); set[i] = 1 } }
  const shift = input.shift ?? 0
  // Rig frames: x forward, y up, z to the right. A positive roll about x lowers the right side.
  const hipRoll = qAxisAngle(b.pelvis.x, -shift * SHIFT.hipRoll), chestRoll = qAxisAngle(b.torso.x, shift * SHIFT.chestRoll)
  const slide = mul(b.pelvis.z, shift * SHIFT.slide)
  drive("pelvis", qMul(hipRoll, dPelvis))
  const chestLift = qAxisAngle(b.torso.z, breath * 0.025)
  drive("spine_01", qMul(qSlerp(hipRoll, chestRoll, 0.5), qSlerp(dPelvis, dTorso, 0.4)))
  drive("spine_02", qMul(qMul(chestLift, chestRoll), qSlerp(dPelvis, dTorso, 0.75)))
  drive("spine_03", qMul(qMul(chestLift, chestRoll), dTorso))
  drive("neck_01", qSlerp(dTorso, dHead, 0.45))
  drive("head", dHead)
  // Leg targets first. Foot attitude comes from the rig's foot frame (tilted along the ground); the ankle goes where
  // the mesh's ball lands on the rig's ball (the pivot the rig locks), or its heel on the rig's heel at heel strike,
  // so heel rise and toe-off never slide the forefoot whatever the mesh foot's length.
  const legTargets = [0, 1].map((i) => {
    const foot = idx[i === 0 ? "foot_l" : "foot_r"]!, ball = idx[i === 0 ? "ball_l" : "ball_r"]!
    const ft = b.ft[i]!
    const tiltQ = input.tilt?.[i] ? qAxisAngle(ft.z, -input.tilt[i]!) : null
    let footRot = qNorm(qMul(delta(ft, rest.footBind[i]!), sk.bindRot[foot]!))
    if (tiltQ) footRot = qNorm(qMul(tiltQ, footRot))
    const dy = input.feet?.[i] ?? 0
    const rigBall = W([ft.p[0] + ft.x[0] * RIG.foot - ft.y[0] * RIG.ankle, ft.p[1] + ft.x[1] * RIG.foot - ft.y[1] * RIG.ankle, ft.p[2] + ft.x[2] * RIG.foot - ft.y[2] * RIG.ankle], rest.ballHeight + dy)
    const heelDy = dy + Math.sin(input.tilt?.[i] ?? 0) * rest.sole.toHeel
    const rigHeel = W([ft.p[0] - ft.x[0] * RIG.heel - ft.y[0] * RIG.ankle, ft.p[1] - ft.x[1] * RIG.heel - ft.y[1] * RIG.ankle, ft.p[2] - ft.x[2] * RIG.heel - ft.y[2] * RIG.ankle], heelDy)
    const fromBall = sub(rigBall, qRot(footRot, local.pos[ball]!)), fromHeel = sub(rigHeel, qRot(footRot, rest.heel[i]!))
    const w = smooth(0, 0.06, ft.x[1])
    // The pole sits 20 cm ahead of the rig knee along the thigh's forward axis. On the raw knee, a nearly straight
    // leg (heel strike, terminal stance) let the mesh's own hip→ankle chord pass in front of it and the knee flip back.
    return { foot, ball, footRot, ankle: add(mul(fromBall, 1 - w), mul(fromHeel, w)), pole: add(W(b.sh[i]!.p, dy), mul(b.th[i]!.x, 0.2)) }
  })
  // Pelvis bone origin: the rig's mid-hip, plus the mesh's own pelvis offset turned with the hips. Where the mesh's
  // legs are a little short of the rig's targets (other proportions), the whole body sinks just enough to reach.
  const pelvis = need(idx, "pelvis")
  pos[pelvis] = add(add(W(b.pelvis.p), slide), qRot(rot[pelvis]!, rest.pelvisOffset))
  let sink = 0
  for (let i = 0; i < 2; i++) {
    const ch = rest.legs[i]!, t = legTargets[i]!
    const hip = add(pos[pelvis]!, qRot(rot[pelvis]!, local.pos[ch.upper]!))
    const L = (ch.lu + ch.ll) * 0.998
    const dx = hip[0] - t.ankle[0], dz = hip[2] - t.ankle[2], h2 = L * L - dx * dx - dz * dz
    if (h2 > 0) sink = Math.max(sink, hip[1] - t.ankle[1] - Math.sqrt(h2))
  }
  sink = Math.min(sink, 0.12)
  // Sink at once for a leg that needs it, but let go on an ease. Near full extension the reach height swings steeply
  // with the ankle's plan distance: a swing ankle drifting 3 cm closer cut the sink 10 → 3 cm and the body jumped up.
  if (input.dt !== undefined && sink < (out.sink ?? 0)) sink += ((out.sink ?? 0) - sink) * Math.exp(-input.dt * SINK_RELEASE)
  out.sink = sink
  if (sink > 0) { pos[pelvis] = [pos[pelvis]![0], pos[pelvis]![1] - sink, pos[pelvis]![2]] }
  // FK pass for everything not yet posed, in parent order; chains overwrite their bones below.
  const fk = (i: number) => {
    const p = sk.parent[i]!
    if (p < 0) { if (!set[i]) rot[i] = sk.bindRot[i]!; if (i !== pelvis) pos[i] = sk.bindPos[i]!; return }
    if (i !== pelvis) pos[i] = add(pos[p]!, qRot(rot[p]!, local.pos[i]!))
    if (!set[i]) rot[i] = qNorm(qMul(rot[p]!, local.rot[i]!))
  }
  for (let i = 0; i < n; i++) fk(i)
  // Clavicles shrug a touch with each breath.
  for (const side of ["l", "r"] as const) {
    const c = idx[`clavicle_${side}`]
    if (c !== undefined && breath) { rot[c] = qNorm(qMul(qAxisAngle(b.torso.x, breath * 0.012 * (side === "l" ? -1 : 1)), rot[c]!)); }
  }
  const solveChain = (ch: Chain, target: V3, poleAt: V3, fallback: V3) => {
    const root = pos[ch.upper]!
    const [mid, end] = ik(root, target, ch.lu, ch.ll, sub(poleAt, root))
    const dU = norm(sub(mid, root)), dL = norm(sub(end, mid))
    const h = limbHinge(dU, dL, fallback)
    rot[ch.upper] = qNorm(qMul(qMul(limbQ(dU, h), qConj(ch.bindU)), sk.bindRot[ch.upper]!))
    rot[ch.lower] = qNorm(qMul(qMul(limbQ(dL, h), qConj(ch.bindL)), sk.bindRot[ch.lower]!))
    set[ch.upper] = set[ch.lower] = 1
  }
  const subtree = (i: number) => {
    // Re-run FK below a re-posed joint (the arrays are parent-first, so one forward sweep suffices).
    const mark = new Uint8Array(n); mark[i] = 1
    for (let j = i + 1; j < n; j++) if (mark[sk.parent[j]!]) { mark[j] = 1; fk(j) }
  }
  for (let i = 0; i < 2; i++) {
    const ch = rest.legs[i]!, t = legTargets[i]!
    solveChain(ch, t.ankle, t.pole, b.th[i]!.z)
    subtree(ch.upper)
    rot[t.foot] = t.footRot; set[t.foot] = 1
    subtree(t.foot)
    const toe = b.toe?.[i]
    if (toe) {
      const tq = qNorm(qMul(delta(toe, rest.footBind[i]!), sk.bindRot[t.ball]!))
      // Keep the toes flat on the ground when the boot tilts with it.
      rot[t.ball] = input.tilt?.[i] ? qNorm(qMul(qAxisAngle(b.ft[i]!.z, -input.tilt[i]!), tq)) : tq
      set[t.ball] = 1; subtree(t.ball)
    }
  }
  out.torch = null
  for (let i = 0; i < 2; i++) {
    const ch = rest.arms[i]!
    const fa = b.fa[i]!, ua = b.ua[i]!
    // The rig's arm, shoulder to elbow to wrist, hung from the mesh's own shoulder and scaled to the mesh's arm: the
    // same angles at every elbow, never a wrist target past the mesh's reach (the mesh's arms are 10-13% shorter and
    // its shoulders narrower than the rig's at leg scale, so absolute targets locked its elbows straight).
    const k = (ch.lu + ch.ll) / ((RIG.upper + RIG.fore) * s)
    const sh = W(ua.p), root = pos[ch.upper]!
    const fromShoulder = (p: V3) => add(root, mul(sub(W(p), sh), k))
    const torch = input.torch?.side === i ? input.torch : null
    // An elbow never locks: reach eases toward a soft limit, lower for a hand holding a torch out, which keeps the
    // elbow bent about 60° as people hold a flashlight (the rig's reach puts it at 91-100% of the arm).
    const want = sub(fromShoulder([fa.p[0] - fa.y[0] * RIG.fore, fa.p[1] - fa.y[1] * RIG.fore, fa.p[2] - fa.y[2] * RIG.fore]), root)
    const reach = len(want) / (ch.lu + ch.ll), [knee, limit] = torch ? ARM_REACH.torch : ARM_REACH.free
    const eased = reach <= knee ? reach : knee + (limit - knee) * (1 - Math.exp(-(reach - knee) / (limit - knee)))
    const target = add(root, mul(want, eased / (reach || 1)))
    solveChain(ch, target, fromShoulder(fa.p), ua.z)
    subtree(ch.upper)
    const hand = ch.end
    const hr = rest.hands[i]!
    if (torch) {
      // Bend the wrist so the barrel points along the beam (up to 75°), then the torch frame comes from the hand.
      const now = qRot(rot[hand]!, hr.barrel)
      let q = qFromTo(now, norm(torch.dir))
      const a = qAngle(q), lim = 1.3
      if (a > lim) q = qSlerp([0, 0, 0, 1], q, lim / a)
      rot[hand] = qNorm(qMul(q, rot[hand]!)); set[hand] = 1
      subtree(hand)
      const x = qRot(rot[hand]!, hr.barrel)
      const up0: V3 = Math.abs(x[1]) > 0.95 ? b.torso.x : [0, 1, 0]
      const z = norm(cross(x, up0)), y = cross(z, x)
      out.torch = { p: add(pos[hand]!, qRot(rot[hand]!, hr.grip)), x, y, z }
    }
    const grip = input.grip?.[i] ?? (torch ? hr.torch : RELAXED)
    poseFingers(rest, i, grip, out)
  }
}

const DEG = Math.PI / 180
/** Weight shift at full `shift`: hips slide (m) and roll (rad), the chest counter-rolls (rad). */
export const SHIFT = { slide: 0.035, hipRoll: 0.07, chestRoll: 0.045 }
/**
 * Where a person carries a flashlight, torso space (x forward, y up from the hips, z right; `Avatar.reach.r`), for a
 * beam at `pitch` (rad): low and a little forward of the hip with the thumb forward, so the fist aims the barrel ahead
 * and down with a nearly straight wrist; raised for a beam above level. Searched with the cast for least wrist bend
 * (26° at a −0.25 rad beam, against 55° with the hand held out at chest height).
 */
export const torchCarry = (pitch: number): V3 => [0.17, -0.1 + Math.max(0, Math.min(1, pitch)) * 0.35, 0.2]

/** Arm reach as a fraction of the mesh arm: [where easing starts, the limit it approaches]. */
export const ARM_REACH = { free: [0.9, 0.975], torch: [0.7, 0.86] } as const

function poseFingers(rest: PersonRest, side: number, p: HandPose, out: PersonPose): void {
  const { skeleton: sk, local } = rest
  const hr = rest.hands[side]!
  const sign = side === 1 ? 1 : -1
  for (const jt of hr.joints) {
    let q = local.rot[jt.index]!
    if (jt.finger === "thumb") {
      if (jt.joint === 1) {
        q = qMul(q, qAxisAngle(jt.spread, p.thumbAlong * DEG * sign))
        q = qMul(q, qAxisAngle(jt.oppose!, p.thumbOppose * DEG))
      }
      q = qMul(q, qAxisAngle(jt.flex, p.thumb[jt.joint - 1]! * DEG))
    } else {
      if (jt.joint === 1) q = qMul(q, qAxisAngle(jt.spread, { index: 1, middle: 0, ring: -1, pinky: -2 }[jt.finger] * p.together * DEG * sign))
      q = qMul(q, qAxisAngle(jt.flex, p[jt.finger][jt.joint - 1]! * DEG))
    }
    const parent = sk.parent[jt.index]!
    out.rot[jt.index] = qNorm(qMul(out.rot[parent]!, q))
    out.pos[jt.index] = add(out.pos[parent]!, qRot(out.rot[parent]!, local.pos[jt.index]!))
  }
}

/** Joint skinning matrices (world × inverse bind), 16 floats per joint. */
export function skinMatrices<T extends Float32Array>(rest: PersonRest, pose: PersonPose, out: T): T {
  const n = rest.skeleton.names.length
  for (let i = 0; i < n; i++) writeMatrix(out, i * 16, pose.rot[i]!, pose.pos[i]!, rest.skeleton.ibm, i * 16)
  return out
}
