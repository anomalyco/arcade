/**
 * Mocap locomotion for people: real walk and run cycles (CMU, `gait.gen.ts`) drive the body in place of the
 * procedural rig's gait, which reads as a crouched shuffle on a realistic mesh. The cycle's phase advances with the
 * distance walked (stride scaled gently with speed), so the stance foot stays put; planted feet lock to the ground
 * through turns and speed changes. Standing, turning on the spot, strafing and walking backward hand back to the
 * rig, whose idle and weight shift already suit the mesh. Hand reaches (a torch carried, a knot tied) apply on top.
 * Pure: no DOM or GPU.
 */
import type { Locomotion } from "../human-locomotion"
import { poseArms, type HumanBody } from "../human-pose"
import { extractBodyJoints, jointsToBody, type PoseJointId, type RigJointMap } from "../pose-diff"
import { at, lerp3, RIG, type V3 } from "../rig"
import { GAIT_FRAMES, GAIT_JOINTS, GAITS } from "./gait.gen"
import type { TerrainLoco } from "./terrain"

type Clip = (typeof GAITS)[keyof typeof GAITS]

/** World speeds (m/s): mocap fades in over `move`, the run over `run`; `strafe` (rad) off the aim hands back to the rig. */
export const GAIT = { move: [0.3, 0.8], run: [2.4, 3.1], strafe: 1.2, stride: [0.3, 1.15], blendRate: 6, turnRate: 8 } as const
/** How far (rig units) a planted foot may be left behind the gait's own foot before it follows. */
const LOCK_REACH = 0.45

type Lock = { on: boolean; at: [number, number]; off: [number, number]; lift: V3; ground: number }
export type GaitState = { phase: number; move: number; run: number; yaw: number; init: boolean; lock: [Lock, Lock]; loco: TerrainLoco & { motion: { targets: V3[] } } }

const newLock = (): Lock => ({ on: false, at: [0, 0], off: [0, 0], lift: [0, 0, 0], ground: 0 })
export const newGait = (): GaitState => ({
  phase: 0, move: 0, run: 0, yaw: 0, init: false, lock: [newLock(), newLock()],
  loco: { x: 0, y: 0, feet: [{ planted: true, p: [0, 0, 0], lift: [0, 0, 0] }, { planted: true, p: [0, 0, 0], lift: [0, 0, 0] }], motion: { targets: [[0, 0, 0], [0, 0, 0]] } },
})

const J = GAIT_JOINTS.length
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b))
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const ease = (x: number, to: number, rate: number, dt: number) => x + (to - x) * (1 - Math.exp(-rate * dt))

/** One clip's joints at phase u (0..1), interpolated, into `out` (rig units, in place). */
function sampleClip(c: Clip, u: number, out: Float32Array): void {
  const pos = (((u % 1) + 1) % 1) * GAIT_FRAMES, i0 = Math.floor(pos) % GAIT_FRAMES, i1 = (i0 + 1) % GAIT_FRAMES, t = pos - Math.floor(pos)
  const a = i0 * J * 3, b = i1 * J * 3
  for (let k = 0; k < J * 3; k++) out[k] = (c.joints[a + k]! + (c.joints[b + k]! - c.joints[a + k]!) * t) / 1000
}
/** Planted between two frames only if both are: the last stance frame blends into a lifted foot. */
const plantedAt = (c: Clip, side: number, u: number) => {
  const i = Math.floor((((u % 1) + 1) % 1) * GAIT_FRAMES) % GAIT_FRAMES
  return c.planted[side]![i] === "1" && c.planted[side]![(i + 1) % GAIT_FRAMES] === "1"
}
/** Phase at which a foot's stance begins in a clip. */
const plantStart = (c: Clip, side: number) => {
  const s = c.planted[side]!
  for (let i = 0; i < GAIT_FRAMES; i++) if (s[i] === "1" && s[(i + GAIT_FRAMES - 1) % GAIT_FRAMES] === "0") return i / GAIT_FRAMES
  return 0
}
/** Phase at which each foot next plants (from u). */
function nextPlant(c: Clip, side: number, u: number): number {
  const s = c.planted[side]!, i0 = Math.floor((((u % 1) + 1) % 1) * GAIT_FRAMES)
  for (let d = 1; d <= GAIT_FRAMES; d++) {
    const i = (i0 + d) % GAIT_FRAMES
    if (s[i] === "1" && s[(i + GAIT_FRAMES - 1) % GAIT_FRAMES] === "0") return u + d / GAIT_FRAMES
  }
  return u + 1
}

const walkJ = new Float32Array(J * 3), runJ = new Float32Array(J * 3)
const IDX = Object.fromEntries(GAIT_JOINTS.map((n, i) => [n, i])) as Record<PoseJointId, number>
const LEG: [PoseJointId[], PoseJointId[]] = [["kneeL", "ankleL", "ballL", "toeL"], ["kneeR", "ankleR", "ballR", "toeR"]]
const ARM: [PoseJointId[], PoseJointId[]] = [["elbowL", "wristL"], ["elbowR", "wristR"]]

/** The blended cycle at phase u, stride-scaled by k, placed at (x, z) facing yaw: a joint map in rig world space. */
function cycleAt(st: GaitState, u: number, k: number, x: number, z: number): RigJointMap {
  sampleClip(GAITS.walk, u, walkJ)
  sampleClip(GAITS.run, u, runJ)
  const r = st.run, j = (n: PoseJointId): V3 => {
    const o = IDX[n] * 3
    return [walkJ[o]! + (runJ[o]! - walkJ[o]!) * r, walkJ[o + 1]! + (runJ[o + 1]! - walkJ[o + 1]!) * r, walkJ[o + 2]! + (runJ[o + 2]! - walkJ[o + 2]!) * r]
  }
  const m = {} as RigJointMap
  for (const n of GAIT_JOINTS) m[n] = j(n)
  // A slower walk takes shorter steps: legs (about each hip) and arm swing (about each shoulder) scale by k.
  for (let side = 0; side < 2; side++) {
    const hip = m[side ? "hipR" : "hipL"], sh = m[side ? "shoulderR" : "shoulderL"]
    for (const n of LEG[side]!) m[n] = [hip[0] + (m[n][0] - hip[0]) * k, m[n][1], hip[2] + (m[n][2] - hip[2]) * k]
    for (const n of ARM[side]!) m[n] = [sh[0] + (m[n][0] - sh[0]) * k, m[n][1], m[n][2]]
  }
  const c = Math.cos(st.yaw), s = Math.sin(st.yaw)
  for (const n of GAIT_JOINTS) { const p = m[n]; m[n] = [x + p[0] * c - p[2] * s, p[1], z + p[0] * s + p[2] * c] }
  return m
}

/**
 * The body a person walks with this frame (rig world space) and the foot state `terrainFeet` reads, from the rig's
 * avatar `a` (its position, velocity, aim and hand reaches) and the body the rig posed (`idle`, used standing and
 * blended in and out). `s` is the person's rig scale.
 */
export function gaitBody(st: GaitState, a: Locomotion & { reach?: { l?: V3; r?: V3; k: number } }, idle: HumanBody, s: number, dt: number): { body: HumanBody; loco: TerrainLoco } {
  const v = Math.hypot(a.svx, a.svy), vw = v * s
  const heading = v > 1e-4 ? Math.atan2(a.svy, a.svx) : a.aim
  const sideways = vw > 0.2 && Math.abs(angleDiff(heading, a.aim)) > GAIT.strafe
  // The cycle faces where the rig's body faces: its aim when standing, slow, backpedalling or strafing (so blending
  // in never meets a stale or reversed facing), the direction of travel when walking forward.
  const facing = a.back || sideways || vw <= 0.2 ? a.aim : heading
  if (!st.init || st.move < 0.01) { st.yaw = facing; st.init = true }
  else st.yaw += angleDiff(facing, st.yaw) * (1 - Math.exp(-GAIT.turnRate * dt))
  st.move = ease(st.move, a.back || sideways ? 0 : smooth(GAIT.move[0], GAIT.move[1], vw), GAIT.blendRate, dt)
  st.run = ease(st.run, smooth(GAIT.run[0], GAIT.run[1], vw), GAIT.blendRate, dt)
  const stride = GAITS.walk.stride + (GAITS.run.stride - GAITS.walk.stride) * st.run
  const natural = stride / (GAITS.walk.duration + (GAITS.run.duration - GAITS.walk.duration) * st.run)
  const k = Math.max(GAIT.stride[0], Math.min(GAIT.stride[1], Math.sqrt(v / natural)))
  const clip = st.run < 0.5 ? GAITS.walk : GAITS.run
  // While the rig leads, the cycle follows its stride: the rig's left foot lands at its phase 0, the clip's at its
  // first plant. So the hand-over never meets a foot the rig has planted mid-swing in the clip, or the reverse.
  if (st.move < 0.01) st.phase = (a.phase + plantStart(clip, 0)) % 1
  else st.phase = (st.phase + (dt * v) / (k * stride)) % 1
  const mocap = st.move > 0.5
  const m = st.move > 0.01 ? cycleAt(st, st.phase, k, a.x, a.y) : null
  const rig = st.move < 0.999 ? extractBodyJoints(idle) : null
  const joints = {} as RigJointMap
  for (const n of GAIT_JOINTS) joints[n] = !m ? rig![n] : !rig ? m[n] : lerp3(rig[n], m[n], st.move)
  // One foot lock over whichever gait leads: a planted foot stays where it landed until that gait lifts it, so
  // blending in and out (starting, stopping) never drags a foot; a lock drifting past LOCK_REACH follows at that.
  const loco = st.loco
  loco.x = a.x; loco.y = a.y
  for (let side = 0; side < 2; side++) {
    const L = st.lock[side]!, ankle = side ? "ankleR" : "ankleL"
    const planted = mocap ? plantedAt(clip, side, st.phase) : a.feet[side].planted
    // A planted foot stands at the height of the gait that planted it: blending in the other's foot would lift it.
    // Before the lock: the foot's height tilts the ankle -> ball line, which moves the ball the lock holds.
    // Eased, so a hand-over where the gaits disagree on which foot is down does not drop or lift one in a frame.
    // The leader's foot height crosses from rig to cycle over move 0.4-0.6, not in the frame the lead changes.
    const lw = smooth(0.4, 0.6, st.move)
    L.ground = ease(L.ground, planted ? 1 : 0, 20, dt)
    for (const n of LEG[side]!) if (!n.startsWith("knee")) {
      const ly = !m ? rig![n][1] : !rig ? m[n][1] : rig[n][1] + (m[n][1] - rig[n][1]) * lw
      joints[n] = [joints[n][0], joints[n][1] + (ly - joints[n][1]) * L.ground, joints[n][2]]
    }
    const jb = joints[side ? "ballR" : "ballL"], ja = joints[ankle]
    // The ball the mesh is pinned to: along ankle -> ball at the rig foot's own length (jointsToBody, posePerson).
    const d0 = Math.hypot(jb[0] - ja[0], jb[1] - ja[1], jb[2] - ja[2]) || 1, reachBall = Math.hypot(RIG.foot, RIG.ankle) / d0
    const ball: V3 = [ja[0] + (jb[0] - ja[0]) * reachBall, 0, ja[2] + (jb[2] - ja[2]) * reachBall]
    if (planted && !L.on) { L.on = true; L.at = [ball[0] + L.off[0], ball[2] + L.off[1]] }
    if (!planted && L.on) { L.on = false; L.lift = [joints[ankle][0] + L.off[0], joints[ankle][1], joints[ankle][2] + L.off[1]] }
    if (L.on) {
      L.off = [L.at[0] - ball[0], L.at[1] - ball[2]]
      const d = Math.hypot(L.off[0], L.off[1])
      if (d > LOCK_REACH) { L.off = [(L.off[0] * LOCK_REACH) / d, (L.off[1] * LOCK_REACH) / d]; L.at = [ball[0] + L.off[0], ball[2] + L.off[1]] }
    } else L.off = [L.off[0] * Math.exp(-dt * 10), L.off[1] * Math.exp(-dt * 10)]
    for (const n of LEG[side]!) { const p = joints[n], w = n.startsWith("knee") ? 0.5 : 1; joints[n] = [p[0] + L.off[0] * w, p[1], p[2] + L.off[1] * w] }
    const f = loco.feet[side]!
    f.planted = planted
    f.p = joints[ankle]
    f.lift = L.lift
    if (mocap) {
      // Where the swinging foot will land: the cycle at its next plant, carried on by the walk until then.
      const u = nextPlant(clip, side, st.phase), tau = ((u - st.phase) * k * stride) / Math.max(v, 1e-3)
      loco.motion.targets[side] = cycleAt(st, u, k, a.x + a.svx * tau, a.y + a.svy * tau)[ankle]
    } else loco.motion.targets[side] = a.motion.targets[side]!
  }
  const body = jointsToBody(joints)
  if (a.reach && a.reach.k > 0) {
    const kk = Math.min(1, a.reach.k)
    const wrist = (i: number): V3 => { const f = body.fa[i]!; return [f.p[0] - f.y[0] * RIG.fore, f.p[1] - f.y[1] * RIG.fore, f.p[2] - f.y[2] * RIG.fore] }
    const l = a.reach.l ? lerp3(wrist(0), at(body.torso, a.reach.l[0], a.reach.l[1], a.reach.l[2]), kk) : wrist(0)
    const r = a.reach.r ? lerp3(wrist(1), at(body.torso, a.reach.r[0], a.reach.r[1], a.reach.r[2]), kk) : wrist(1)
    const arms = poseArms(body.torso, l, r)
    if (a.reach.l) { body.ua[0] = arms.ua[0]; body.fa[0] = arms.fa[0] }
    if (a.reach.r) { body.ua[1] = arms.ua[1]; body.fa[1] = arms.fa[1] }
  }
  return { body, loco }
}
