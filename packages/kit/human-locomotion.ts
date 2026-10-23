import { HIP, RIG } from "./rig"
import { humanProfiles, type HumanProfile } from "./human-profile"
import { at, clamp, moved, pitch, smooth, smoother, spring, stepSpring, yawFrame, type Frame, type Spring, type V3 } from "./rig"

export type Foot = { p: V3; yaw: number; pitch: number; planted: boolean; lift: V3; liftYaw: number }
/** Presentation state only. No game, weapon, mesh, DOM or network dependency. */
export type Locomotion = {
  x: number; y: number; vx: number; vy: number; aim: number
  svx: number; svy: number; acx: number; acy: number
  legYaw: number; gait: number; duty: number; phase: number; back: boolean; turning: boolean
  unarmed?: boolean; seed?: number
  feet: [Foot, Foot]; motion: ReturnType<typeof newMotion>
  leanX: Spring; leanY: Spring; dip: Spring; hitX: Spring; hitY: Spring
  body?: { gun?: { p: V3 } | null } | null
}
type Avatar = Locomotion
const angleDiff = (a: number, b: number) => {
  let d = a - b
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

/** Deterministic platform-independent hash in [-1, 1] for per-step and per-actor variation. */
export function stepHash(seed: number, step: number, channel: number): number {
  let h = Math.imul((Math.round(seed * 1000) | 0) ^ Math.imul(step + 1, 0x9e3779b1), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13) ^ Math.imul(channel + 1, 0xc2b2ae35), 0x27d4eb2f)
  return ((h ^ (h >>> 16)) >>> 0) / 2147483647.5 - 1
}

const TAU = Math.PI * 2
/** Fastest a stopping boot's landing point moves, m/s. */
const STOP_REAIM = 1.5
export const stiffness = (hz: number) => (hz * TAU) ** 2
export function angleSpring(s: Spring, goal: number, hz: number, dt: number): void {
  stepSpring(s, stiffness(hz), 1, dt, s.x + angleDiff(goal, s.x))
}

export function newMotion(x: number, y: number, aim: number) {
  return {
    enabled: false, run: 0, stride: 1, stepDebt: 0, next: 0, moving: false, start: 0, strafeSign: 0,
    stepCount: 0, clock: 0, footDrag: 0, dragFoot: 1 as 0 | 1,
    strafePhi: 0, strafeCross: 0, sideStep: 0, backness: 0, strafeLateral: 0,
    steady: 0, rawDir: 0, reverseT: 0, effort: 0,
    centreX: { x, v: 0 }, centreY: { x: y, v: 0 },
    pelvis: { x: aim, v: 0 }, chest: { x: aim, v: 0 }, head: { x: aim, v: 0 }, weapon: { x: aim, v: 0 },
    bob: spring(), sway: spring(), drop: spring(), twist: spring(), posture: spring(), crouch: spring(), bank: spring(),
    secondary: spring(), yawOffset: spring(),
    arms: [spring(), spring()] as [Spring, Spring],
    hands: [spring(), spring()] as [Spring, Spring],
    gun: [spring(), spring(), spring()] as [Spring, Spring, Spring],
    swings: [0, 0], durations: [0.2, 0.2], contacts: [1, 1], stances: [0, 0],
    stepReach: [1, 1] as [number, number],
    stepLat: [0, 0] as [number, number],
    stepLiftVar: [1, 1] as [number, number],
    stepToeYaw: [0, 0] as [number, number],
    stepArmVar: [1, 1] as [number, number],
    redirectFrom: [0, 0] as [number, number],
    bowSide: [0, 0] as [number, number],
    targets: [[x, 0, y], [x, 0, y]] as [V3, V3],
    toes: [[x, 0, y], [x, 0, y]] as [V3, V3],
  }
}

/** A fresh standing `Locomotion` state for adapters that keep their own avatar (Outbreak's survivor). */
export function newLocomotion(x = 0, y = 0, aim = 0, seed = 0): Locomotion {
  const foot = (side: number): Foot => {
    const p: V3 = [x + Math.cos(aim + side * 1.2) * 0.15, 0, y + Math.sin(aim + side * 1.2) * 0.15]
    return { p, yaw: aim, pitch: 0, planted: true, lift: [...p], liftYaw: aim }
  }
  return {
    x, y, vx: 0, vy: 0, aim, svx: 0, svy: 0, acx: 0, acy: 0, legYaw: aim, gait: 0, duty: 0.54, phase: 0,
    back: false, turning: false, unarmed: true, seed, feet: [foot(-1), foot(1)], motion: newMotion(x, y, aim),
    leanX: spring(), leanY: spring(), dip: spring(), hitX: spring(), hitY: spring(),
  }
}

/** Smooth Froude transition, using leg length rather than overall character height. `back` (0..1 or a flag) shortens
 * backpedal strides; `sideStep` (0..1, from `strafeStance`) shortens side-steps so the stance never opens past reach. */
export function gaitAt(speed: number, back: boolean | number = false, sideStep = 0, animation: HumanProfile = humanProfiles.soldier) {
  const h = RIG.thigh + RIG.shin
  const froude = speed * speed / (9.81 * h)
  const run = smooth((froude - 0.36) / 0.28)
  // Speed increases mostly via stride at low speeds and increasingly via cadence at high speeds (Alexander 1984).
  // In forward walking (no side-step, no backpedal), ball-of-foot (RIG.foot) push-off lengthens effective leg reach.
  const backW = typeof back === "number" ? clamp(back, 0, 1) : back ? 1 : 0
  const sideW = clamp(sideStep, 0, 1)
  const effSpeed = speed - 0.22 * Math.max(0, speed - 3.6) * smooth((speed - 3.0) / 3.3)
  const dragKeep = 1 - clamp(animation.footDrag ?? 0, 0, 0.95)
  const toeReach = (RIG.foot + RIG.heel) * 0.90 * (1 - run) * (1 - sideW) * (1 - backW) * dragKeep
  const stride = (h * (effSpeed / Math.sqrt(9.81 * h) + 0.665 - 0.015 * run) / 0.83 + toeReach) * animation.strideScale
  // Arcade sprint is 6.3 m/s: shorter support and a longer flight, not an unreachable planted leg.
  return { run, stride: stride * (1 - 0.15 * backW) * (1 - 0.45 * sideW), duty: 0.54 - 0.10 * run - 0.2 * smooth((speed - 2.5) / 3) }
}

/** Travel more than BACK_ENTER rad from the aim turns the legs to backpedal; back under BACK_EXIT turns them forward. */
export const BACK_ENTER = 2.35, BACK_EXIT = 2.1
export function backpedalling(rel: number, back: boolean): boolean {
  return Math.abs(rel) > (back ? BACK_EXIT : BACK_ENTER)
}

/**
 * How far the hips may turn toward travel: square for a side-step (100STYLE's side-step walk and run keep the pelvis
 * within 5° of the chest up to 1.1 m/s), about half the twist at a run so hips and chest share it. `commit` (0..1,
 * from `strafeSettle`) holds the hips square until travel has held its direction for a moment.
 */
export function strafeHipLimit(speed: number, animation: HumanProfile = humanProfiles.soldier, commit = 1): number {
  const side = animation.sideStepTurn ?? 0.2
  return clamp(side + ((animation.strafeHipTurn ?? 0.95) - side) * smooth((speed - 1.2) / 1.6) * clamp(commit, 0, 1), 0, 1.05)
}

/**
 * Leg heading relative to the aim for travel `rel` rad from it. Forward legs turn toward travel, backpedalling legs
 * toward travel + π. Both goals taper to the aim inside the hysteresis band, so the flip never jumps the hips.
 */
export function strafeLegGoal(rel: number, back: boolean, limit: number): number {
  if (!back) return clamp(rel, -limit, limit) * (1 - smooth((Math.abs(rel) - 1.8) / (BACK_EXIT - 1.8)))
  const dir = angleDiff(rel + Math.PI, 0)
  return clamp(dir, -limit, limit) * (1 - smooth((Math.abs(dir) - 0.45) / (Math.PI - BACK_ENTER - 0.45)))
}

/** Sideways share of a step, ignoring the few degrees legs trail travel while they turn. */
const sideways = (phi: number) => Math.max(0, Math.abs(Math.sin(phi)) - 0.1) / 0.9

export type StrafeStance = { phi: number; cross: number; sideStep: number; backness: number; lateral: number }
/**
 * Travel relative to the legs for direction-aware stepping. `phi` is folded into ±π/2 (backpedal steps mirror forward
 * ones); `cross` blends a side-step (feet widen in the leg frame and never pass) into a run-speed crossover (feet
 * either side of the travel line); `sideStep` is the share of each step taken sideways without crossing.
 */
export function strafeStance(speed: number, legYaw: number, travel: number, animation: HumanProfile = humanProfiles.soldier): StrafeStance {
  if (speed < 0.05) return { phi: 0, cross: 0, sideStep: 0, backness: 0, lateral: 0 }
  const raw = angleDiff(travel, legYaw)
  const phi = Math.abs(raw) > Math.PI / 2 ? angleDiff(raw + Math.PI, 0) : raw
  // A crossover needs a travel line ahead of or behind the hips; straight across them it fades back to a side-step,
  // so the fold at ±90° (where phi changes sign) never swaps the feet across the line.
  const cross = smooth((speed - (animation.crossoverSpeed ?? 2.6) + 0.7) / 1.4) * smooth(Math.abs(Math.cos(raw)) / 0.7)
  return { phi, cross, sideStep: sideways(phi) * (1 - cross), backness: clamp(-Math.cos(raw), 0, 1), lateral: Math.sin(raw) }
}

/**
 * Plan offset of foot `i` from the body centre. Side-steps widen the stance in the leg frame just enough that the
 * follower closes to `strafeGap` from the lead instead of passing it; crossovers keep each foot 9 cm off its side
 * of the travel line, so the trailing leg passes in front of the other without the boots touching.
 */
export function strafeFootOffset(st: StrafeStance, legYaw: number, i: number, stride: number, animation: HumanProfile = humanProfiles.soldier, base = 0.145, maxOpen = 0.28): [number, number] {
  const side = i === 0 ? -1 : 1
  const side_ = sideways(st.phi)
  // 100STYLE side-steps open to ~52 cm between the ankles; never wider than that, even when a run-length stride
  // briefly goes sideways (the hips not yet turned after a reversal).
  const open = Math.max(base, Math.min(maxOpen, ((animation.strafeGap ?? 0.2) + stride * 0.5 * Math.abs(Math.sin(st.phi))) / 2))
  const wide = base + (open - base) * smooth(side_ / 0.3)
  const tl = legYaw + st.phi
  const a = (1 - st.cross) * wide, b = st.cross * (base + (0.1 - base) * smooth(side_ / 0.3))
  return [side * (-Math.sin(legYaw) * a - Math.sin(tl) * b), side * (Math.cos(legYaw) * a + Math.cos(tl) * b)]
}

/** Toe yaw relative to the leg heading: a side-step's lead opens toward travel, crossover feet split hips and travel. */
export function strafeFootOpen(st: StrafeStance, i: number): number {
  const side = i === 0 ? -1 : 1
  const lead = side * st.lateral > 0
  const sideOpen = Math.sign(st.lateral) * Math.abs(st.phi) * (lead ? 0.35 : 0.08)
  return clamp((1 - st.cross) * sideOpen + st.cross * 0.6 * st.phi, -0.6, 0.6)
}

function stance(a: Avatar): StrafeStance {
  const m = a.motion
  return { phi: m.strafePhi ?? 0, cross: m.strafeCross ?? 0, sideStep: m.sideStep ?? 0, backness: m.backness ?? 0, lateral: m.strafeLateral ?? 0 }
}

function home(a: Avatar, i: number, lead: number, vx = a.svx, vy = a.svy, extraWidth = 0, animation: HumanProfile = humanProfiles.soldier): V3 {
  const side = i === 0 ? -1 : 1
  const c = Math.cos(a.legYaw), s = Math.sin(a.legYaw)
  const m = a.motion
  const [ox, oz] = strafeFootOffset(stance(a), a.legYaw, i, m.stride, animation, 0.145 + extraWidth)
  const stagger = (i === 0 ? 0.08 : -0.06) * (1 - a.gait)
  return [m.centreX.x + c * stagger + ox + vx * lead, 0, m.centreY.x + s * stagger + oz + vy * lead]
}

/**
 * Keeps a stepping foot on its own side of the other while travel is sideways to the legs: across the leg heading by
 * `strafeGap` for a side-step, across the travel line by 18 cm for a crossover, so boots never land on each other.
 * `p` and `other` are plan positions [x, z].
 */
export function strafeSeparate(st: StrafeStance, legYaw: number, i: number, p: [number, number], other: [number, number], animation: HumanProfile = humanProfiles.soldier): [number, number] {
  const weight = smooth((sideways(st.phi) - 0.05) / 0.3)
  if (weight <= 0) return p
  const side = i === 0 ? -1 : 1
  const tl = legYaw + st.phi
  let rx = -Math.sin(legYaw) * (1 - st.cross) - Math.sin(tl) * st.cross
  let rz = Math.cos(legYaw) * (1 - st.cross) + Math.cos(tl) * st.cross
  const rl = Math.hypot(rx, rz) || 1
  rx /= rl; rz /= rl
  const gap = ((p[0] - other[0]) * rx + (p[1] - other[1]) * rz) * side
  const correction = Math.max(0, (animation.strafeGap ?? 0.2) * (1 - st.cross) + 0.18 * st.cross - gap) * weight
  return [p[0] + rx * side * correction, p[1] + rz * side * correction]
}

function separate(a: Avatar, i: number, p: V3, animation: HumanProfile = humanProfiles.soldier): V3 {
  const o = a.feet[1 - i]!.p
  const [x, z] = strafeSeparate(stance(a), a.legYaw, i, [p[0], p[2]], [o[0], o[2]], animation)
  return [x, p[1], z]
}

function computeTarget(a: Avatar, i: number, remaining: number, animation: HumanProfile, gait: ReturnType<typeof gaitAt>, speed: number, moving: boolean): V3 {
  const m = a.motion
  const travelling = Math.hypot(a.vx, a.vy) > 0.12
  if (!moving || !travelling) return separate(a, i, home(a, i, 0, a.svx, a.svy, 0, animation), animation)
  // When authoritative velocity opposes or turns sharply from smoothed svx/svy, use authoritative
  // velocity for touchdown lookahead so mid-air feet immediately redirect into the new travel path.
  const rawDot = a.vx * a.svx + a.vy * a.svy
  const blend = rawDot < 0 ? 0.9 : 0.65
  const pvx = a.svx + (a.vx - a.svx) * blend, pvy = a.svy + (a.vy - a.svy) * blend
  const pspeed = Math.hypot(pvx, pvy)
  const support = gait.duty * gait.stride / Math.max(pspeed, 0.1)
  const st = stance(a)
  const fwdWalk = (1 - gait.run) * (1 - st.sideStep) * (1 - st.backness)
  const halfStance = Math.min(0.24 + 0.015 * fwdWalk - 0.09 * gait.run, support * (0.49 - 0.04 * gait.run), (0.33 + 0.025 * fwdWalk - 0.09 * gait.run) / Math.max(pspeed, 0.1))
  const lag = clamp(((a.x - m.centreX.x) * pvx + (a.y - m.centreY.x) * pvy) / Math.max(pspeed * pspeed, 0.25), -0.22, 0.22)
  // Both feet reach the same distance, so each moves one stride per cycle. Lead and follow come from the stance
  // offsets (strafeFootOffset): an asymmetric reach starved the follower and forced catch steps.
  const reachVar = m.stepReach?.[i] ?? 1
  const latVar = m.stepLat?.[i] ?? 0
  const t = separate(a, i, home(a, i, (remaining + halfStance + lag) * reachVar, pvx, pvy, latVar, animation), animation)
  // Never aim a landing beyond a leg's reach of where the body will be (the legs flipping between backpedal and
  // forward mid-swing can throw the stride target far past the hip).
  const fx = a.x + pvx * remaining, fz = a.y + pvy * remaining, dx = t[0] - fx, dz = t[2] - fz, d = Math.hypot(dx, dz)
  const reach = 0.46 + 0.06 * Math.max(0, pspeed - 3.4)
  return d > reach ? [fx + dx * reach / d, t[1], fz + dz * reach / d] : t
}

function reset(a: Avatar): void {
  const m = a.motion
  m.centreX = { x: a.x, v: a.vx }
  m.centreY = { x: a.y, v: a.vy }
  for (const s of [m.pelvis, m.chest, m.head, m.weapon]) { s.x = a.aim; s.v = 0 }
  for (const s of [m.bob, m.sway, m.drop, m.twist, m.posture, m.crouch, m.bank, m.secondary, m.yawOffset, ...m.arms, ...m.hands]) { s.x = 0; s.v = 0 }
  m.stepDebt = 0; m.start = 0; m.moving = false; m.next = 0; m.strafeSign = 0; m.stepCount = 0; m.clock = 0
  m.strafePhi = 0; m.strafeCross = 0; m.sideStep = 0; m.backness = 0; m.strafeLateral = 0; m.steady = 0; m.reverseT = 0
  m.effort = Math.hypot(a.vx, a.vy); m.bowSide[0] = 0; m.bowSide[1] = 0
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    f.p = home(a, i, 0); f.lift = [...f.p]; f.yaw = a.legYaw; f.pitch = 0; f.planted = true
    lockToe(a, i)
    m.swings[i] = 0; m.contacts[i] = 1; m.stances[i] = 0; m.targets[i] = [...f.p]
    m.stepReach[i] = 1; m.stepLat[i] = 0; m.stepLiftVar[i] = 1; m.stepToeYaw[i] = 0; m.stepArmVar[i] = 1
  }
  const hold = a.body?.gun?.p ?? [a.x, 1.24, a.y]
  m.gun.forEach((s, i) => { s.x = hold[i]!; s.v = 0 })
  m.enabled = true
}

/** Advances contact ownership separately from stride phase. Returns a touchdown cue. */
export function locomotion(a: Avatar, dt: number, distance: number, teleport: boolean, animation: HumanProfile = humanProfiles.soldier): boolean {
  if (!(dt > 0) || !Number.isFinite(dt)) return false
  dt = Math.min(dt, 0.05)
  const m = a.motion, speed = Math.hypot(a.svx, a.svy)
  const travelling = Math.hypot(a.vx, a.vy) > 0.12
  const stranded = a.feet.every(f => Math.hypot(f.p[0] - a.x, f.p[2] - a.y) > 1.1)
  if (teleport || !m.enabled || stranded) reset(a)
  // |svx| passes through zero on a reversal, so run posture read from it went 1 → 0 → 1 in a few frames (forearms
  // dropped out of the pump, a 90° elbow pop at 30 fps). Effort is |v| smoothed as a scalar at svx's rate: equal to
  // |svx| on a straight line, it does not dip when the direction flips. Posture follows it only while reversing.
  m.effort += (Math.hypot(a.vx, a.vy) - m.effort) * (1 - Math.exp(-dt * 14))
  m.reverseT = travelling && a.vx * a.svx + a.vy * a.svy < 0 ? 0.3 : Math.max(0, (m.reverseT ?? 0) - dt)
  const drive = speed + clamp(m.reverseT / 0.3, 0, 1) * Math.max(0, m.effort - speed)
  const lateral = -a.svx * Math.sin(a.aim) + a.svy * Math.cos(a.aim)
  const strafe = smooth((Math.abs(lateral) / Math.max(speed, 0.01) - 0.5) * 2)
  const strafeSign = strafe > 0.25 && Math.abs(lateral) > 0.25 ? Math.sign(lateral) : 0
  if (strafeSign !== 0 && strafeSign !== m.strafeSign) {
    // Lead with the outside foot when starting or reversing a side-step (Overgrowth HandleFootStance).
    m.next = strafeSign > 0 ? 1 : 0
    m.strafeSign = strafeSign
  } else if (strafe < 0.1) m.strafeSign = 0
  const moving = speed > (m.moving ? 0.12 : 0.25)
  const varAmt = clamp(animation.stepVariation ?? 0.35, 0, 1)
  const actorSeed = a.seed ?? 0
  const actorStrideTrait = actorSeed !== 0 && varAmt > 0 ? 1 + 0.016 * varAmt * stepHash(actorSeed, 0, 8) : 1
  const travelDir = Math.atan2(a.svy, a.svx)
  const preStance = strafeStance(speed, a.legYaw, travelDir, animation)
  const gait = gaitAt(speed, preStance.backness, preStance.sideStep, animation)
  const bias = clamp(animation.timingBias, -0.3, 0.3)
  m.clock = (m.clock ?? 0) + dt
  if (moving && !m.moving) {
    const firstFoot = lateral > 0 ? 1 : 0
    m.start = 0.015; m.stepDebt = 1; m.next = firstFoot
    if (teleport || a.phase === 0) {
      // Align the gait wheel on fresh start so firstFoot begins at its swing boundary while the other foot is in mid-stance.
      const seedPhase = actorSeed !== 0 && varAmt > 0 ? 0.03 * varAmt * stepHash(actorSeed, 0, 10) : 0
      a.phase = (gait.duty - firstFoot * (0.5 + 0.25 * bias) + seedPhase + 1) % 1
    }
    // Start anticipation: lateral weight transfer over the stance foot, crouch dip, and lean impulse into acceleration.
    a.dip.v -= 0.14
    m.sway.v += (firstFoot === 0 ? 1 : -1) * 0.14 * clamp(animation.swayScale, 0, 2)
    a.leanX.v += a.acx * 0.008 * animation.leanScale
    a.leanY.v += a.acy * 0.008 * animation.leanScale
  } else if (!moving && m.moving) {
    // Stop weight-settle impulse over the receiving support foot.
    m.sway.v += (m.next === 0 ? -1 : 1) * 0.10 * clamp(animation.swayScale, 0, 2)
    a.dip.v -= 0.06 * clamp(speed / 4.2, 0, 1)
  }
  m.moving = moving
  m.start = Math.max(0, m.start - dt)
  // Strafe commitment: how long raw travel has held its direction. A snap turn keeps only the share of it that the
  // new direction agrees with, so quick A/D taps step side to side with square hips and the hips open once it settles.
  if (travelling) {
    const rawDir = Math.atan2(a.vy, a.vx)
    const snap = Math.abs(angleDiff(rawDir, m.rawDir ?? rawDir))
    m.steady = snap > 0.3 ? (m.steady ?? 0) * Math.max(0, 1 - snap / Math.PI) : (m.steady ?? 0) + dt
    m.rawDir = rawDir
  } else m.steady = 0
  const settle = clamp(animation.strafeSettle ?? 0, 0, 2)
  const commit = settle > 0 ? smooth((m.steady ?? 0) / settle) : 1
  const transK = stiffness(clamp(animation.transitionHz ?? 6, 2, 14))
  const prevLegYaw = a.legYaw
  // Angular limits are ownership constraints, not springs that can remain outside the limit.
  if (moving) {
    const rel = angleDiff(travelDir, a.aim)
    const limit = strafeHipLimit(speed, animation, commit)
    const wasBack = a.back
    a.back = backpedalling(rel, a.back)
    if (a.back !== wasBack) {
      // Inertialize the quadrant flip (Holden / Bollo GDC 2018) so legYaw has C1 velocity continuity.
      m.yawOffset.x = clamp(m.yawOffset.x + strafeLegGoal(rel, wasBack, limit) - strafeLegGoal(rel, a.back, limit), -0.85, 0.85)
    }
    stepSpring(m.yawOffset, transK, 1, dt, 0)
    // The hips turn partly toward travel; the torso keeps the aim (anim.ts chest spring).
    const goal = a.aim + clamp(strafeLegGoal(rel, a.back, limit) + m.yawOffset.x, -1.05, 1.05)
    a.legYaw += angleDiff(goal, a.legYaw) * (1 - Math.exp(-dt * 9))
    a.turning = false
  } else {
    a.back = false
    stepSpring(m.yawOffset, transK, 1, dt, 0)
    const error = angleDiff(a.aim, a.legYaw)
    if (Math.abs(error) > clamp(animation.turnStep ?? 1.05, 0.3, 1.05)) a.turning = true
    if (a.turning) {
      a.legYaw += error * (1 - Math.exp(-dt * 10))
      if (Math.abs(error) < 0.08) a.turning = false
    }
  }
  a.legYaw = a.aim + clamp(angleDiff(a.legYaw, a.aim), -1.05, 1.05)
  const st = moving ? strafeStance(speed, a.legYaw, travelDir, animation) : strafeStance(0, a.legYaw, travelDir, animation)
  m.strafePhi = st.phi; m.strafeCross = st.cross; m.sideStep = st.sideStep; m.backness = st.backness; m.strafeLateral = st.lateral
  const curGait = gaitAt(speed, st.backness, st.sideStep, animation)
  m.run = gaitAt(drive, st.backness, st.sideStep, animation).run; m.stride = curGait.stride
  m.footDrag = clamp(animation.footDrag, 0, 0.95)
  m.dragFoot = 1
  a.duty = curGait.duty
  const dragSlow = m.footDrag > 0 ? 1 - 0.28 * m.footDrag * (1 - 0.5 * curGait.run) : 1
  const effStride = curGait.stride * actorStrideTrait / dragSlow
  const cadence = moving ? Math.max(0.72, speed / effStride) : (!a.feet[0].planted || !a.feet[1].planted ? 1.7 : 0)
  const wheel = teleport ? 0 : moving ? cadence * dt : distance / effStride
  a.phase = (a.phase + wheel + 1) % 1
  m.stepDebt = Math.min(1, m.stepDebt + wheel * 2)
  const follow = stiffness(animation.footCentreHz)
  stepSpring(m.centreX, follow, 0.65, dt, a.x + a.svx * 0.025)
  stepSpring(m.centreY, follow, 0.65, dt, a.y + a.svy * 0.025)
  for (const [s, goal] of [[m.centreX, a.x], [m.centreY, a.y]] as const) s.x = clamp(s.x, goal - 0.3, goal + 0.3)

  const stanceDur = Math.max(0.08, curGait.duty / Math.max(cadence, 0.85))
  let landed = false
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    if (f.planted) {
      m.contacts[i]! += dt
      m.stances[i] = moving ? clamp(m.contacts[i]! / stanceDur, 0, 1) : 0
      // Pivot at the locked contact, never translate the planted boot.
      f.yaw = a.legYaw + clamp(angleDiff(f.yaw, a.legYaw), -0.96, 0.96)
      continue
    }
    m.stances[i] = 0
    const prevU = m.swings[i]!
    let u = Math.min(1, prevU + dt / m.durations[i]!)
    const rawDot = a.vx * a.svx + a.vy * a.svy
    const stopping = !travelling && speed > 0.2
    const reversing = travelling && rawDot < 0 && (a.feet[1 - i]!.planted || prevU > m.swings[1 - i]!)
    // If the character reverses while this foot is in late swing, redirect it to the new direction
    // and extend its remaining swing once so it never plants behind the reversal.
    if (reversing && prevU >= 0.45 && prevU < 0.95 && !m.redirectFrom?.[i]) {
      if (m.redirectFrom) m.redirectFrom[i] = prevU
      f.liftYaw = f.yaw
      u = 0.25
      const target = m.targets[i] = computeTarget(a, i, (1 - u) * m.durations[i]!, animation, curGait, speed, moving)
      // Restart the swing from where the foot is, not from a lift point that would jump it 25% toward the target.
      const e0 = smoother(u)
      f.lift = [(f.p[0] - target[0] * e0) / (1 - e0), 0, (f.p[2] - target[2] * e0) / (1 - e0)]
    } else if (u < (stopping ? 1 : (m.reverseT ?? 0) > 0 ? 0.9 : 0.75) || (u < 0.94 && landsOutOfReach(a, m.targets[i]!, (1 - u) * m.durations[i]!))) {
      let desired = computeTarget(a, i, (1 - u) * m.durations[i]!, animation, curGait, speed, moving)
      const prevT = m.targets[i]!
      // A late correction eases toward the new landing so the boot never darts. A stop's re-aim spreads evenly over the
      // swing left, stretched so the landing moves at most STOP_REAIM: the boot still lands where the stop wants it (one
      // catch step) without doubling back 27 cm in the last two frames.
      let late = u < 0.75 ? 1 : 0.35
      if (u >= 0.75 && stopping) {
        const left = Math.min(0.2, Math.max((1 - u) * m.durations[i]!, Math.hypot(desired[0] - prevT[0], desired[2] - prevT[2]) / STOP_REAIM))
        m.durations[i] = Math.max(m.durations[i]!, left / (1 - u))
        late = Math.min(1, dt / Math.max(dt, left))
      }
      if (late < 1) desired = [prevT[0] + (desired[0] - prevT[0]) * late, 0, prevT[2] + (desired[2] - prevT[2]) * late]
      // Fold any mid-swing target shift into f.lift so f.p(u) is C0-continuous (no retroactive eHoriz * dTarget snap)
      // while still landing at the exact updated target at u = 1.
      const drag = i === 1 ? clamp(animation.footDrag, 0, 0.95) : 0
      const ep = smoother(prevU) * (drag > 0 ? 1 - 0.38 * drag * (1 - prevU) : 1)
      if (ep > 0 && ep < 0.98) {
        const curX = f.lift[0] + (prevT[0] - f.lift[0]) * ep
        const curZ = f.lift[2] + (prevT[2] - f.lift[2]) * ep
        f.lift[0] = (curX - desired[0] * ep) / (1 - ep)
        f.lift[2] = (curZ - desired[2] * ep) / (1 - ep)
      }
      m.targets[i] = desired
    }
    m.swings[i] = u
    const target = m.targets[i]!
    const drag = i === 1 ? clamp(animation.footDrag, 0, 0.95) : 0
    const e = smoother(u)
    const eHoriz = drag > 0 ? e * (1 - 0.38 * drag * (1 - u)) : e
    const liftScale = clamp(animation.stepLift ?? 1, 0.5, 1.8) * (m.stepLiftVar?.[i] ?? 1)
    // Quadratic liftoff (u=0) and cubic feather-soft touchdown (u=1) so contact foot velocity is ~0.
    const liftBell = 1.72 * Math.sin(Math.PI * u) ** 2 * (1 - u)
    const [bowX, bowZ] = swingBow(a, i, target, animation)
    const bow = Math.sin(Math.PI * u)
    f.p = [f.lift[0] + (target[0] - f.lift[0]) * eHoriz + bowX * bow,
      (0.085 + 0.125 * curGait.run) * liftScale * (i === 1 ? 1 - drag : 1) * liftBell,
      f.lift[2] + (target[2] - f.lift[2]) * eHoriz + bowZ * bow]
    const side = i === 0 ? -1 : 1
    const opening = strafeFootOpen(st, i)
    const toeVar = m.stepToeYaw?.[i] ?? 0
    f.yaw = f.liftYaw + angleDiff(a.legYaw + opening + side * 0.06 + toeVar, f.liftYaw) * e
    // Toe-off plantarflexion in early swing transitioning to dorsiflexed heel-strike preparation in late swing,
    // settling smoothly to flat (0 rad) at u = 1 so touchdown has zero pitch/vertical velocity discontinuity.
    const pushOffPitch = -0.30 * Math.sin(Math.PI * clamp(u / 0.58, 0, 1))
    const heelStrikePitch = (0.20 * (1 - 0.35 * curGait.run) * (1 - st.backness) - 0.10 * st.backness) * Math.sin(Math.PI * clamp((u - 0.54) / 0.36, 0, 1))
    f.pitch = drag > 0
      ? (pushOffPitch * (1 - drag * 0.85) + 0.12 * drag * Math.sin(Math.PI * u)) + heelStrikePitch * (1 - drag * 0.75)
      : pushOffPitch + heelStrikePitch
    if (u === 1) {
      f.planted = true; f.p[1] = 0; f.pitch = 0
      lockToe(a, i)
      m.contacts[i] = 0; m.stances[i] = 0; landed = true
    }
  }
  // Phase-locked anti-phase step release with emergency overstretch catch-steps on sharp reversals.
  if (m.start === 0) {
    const pvx = a.svx + (a.vx - a.svx) * 0.5, pvy = a.svy + (a.vy - a.svy) * 0.5
    const pspeed = Math.max(speed, Math.hypot(pvx, pvy), 0.1)
    const rawDot = a.vx * a.svx + a.vy * a.svy
    const footPhases = [0, 1].map(idx => (a.phase + idx * (0.5 + 0.25 * bias) + 1) % 1)
    const inSwingWindow = [0, 1].map(idx => moving && footPhases[idx]! >= curGait.duty)
    const metrics = [0, 1].map(idx => {
      const f = a.feet[idx]!, p = home(a, idx, 0, a.svx, a.svy, 0, animation)
      const err = Math.hypot(f.p[0] - p[0], f.p[2] - p[2]) + Math.abs(angleDiff(f.yaw, a.legYaw)) * 0.25
      const behind = ((p[0] - f.p[0]) * a.svx + (p[2] - f.p[2]) * a.svy) / Math.max(speed, 0.1)
      const rootBehind = ((a.x - f.p[0]) * pvx + (a.y - f.p[2]) * pvy) / pspeed
      const rootDist = Math.hypot(a.x - f.p[0], a.y - f.p[2])
      return { err, behind, rootBehind, rootDist }
    })
    let preferred = moving
      ? (inSwingWindow[0] && a.feet[0].planted ? 0 : inSwingWindow[1] && a.feet[1].planted ? 1 : m.next)
      : metrics[0]!.err > metrics[1]!.err ? 0 : 1
    if (moving && a.feet[0].planted && a.feet[1].planted && !inSwingWindow[0] && !inSwingWindow[1]) {
      const alt = 1 - preferred
      if (metrics[alt]!.rootBehind > metrics[preferred]!.rootBehind + 0.08) preferred = alt
    }
    // With both boots down, a foot about to run out of reach of its hip steps first, whatever the phase says.
    if (speed > 0.3 && a.feet[0].planted && a.feet[1].planted) {
      const reach = [hipReach(a, 0, 0.05), hipReach(a, 1, 0.05)]
      const far = reach[0]! > reach[1]! ? 0 : 1
      if (reach[far]! > 0.94) preferred = far
    }
    const i = a.feet[preferred]!.planted ? preferred : 1 - preferred
    const other = 1 - i
    const fwdWalk = (1 - curGait.run) * (1 - st.sideStep) * (1 - st.backness)
    // Out of hip reach also counts. In flight (the other foot swinging) only a sideways reach past a straight leg does,
    // so a sharp cut at a sprint lifts the stretched boot without shortening ordinary running strides.
    const reachOut = speed > 0.3 && (a.feet[other]!.planted ? hipReach(a, i, 0.05) > 0.94 : hipReach(a, i, 0.05, true) > 1.04)
    const overstretched = reachOut || (travelling && ((rawDot < 0 && metrics[i]!.rootBehind > 0.34) || metrics[i]!.rootDist > 0.52 || (a.feet[other]!.planted && metrics[i]!.rootBehind > 0.345 + 0.095 * fwdWalk + 0.155 * curGait.run)))
    const flightRelease = 0.32 + 0.16 * st.sideStep
    const supported = a.feet[other]!.planted || (curGait.run > 0.35 && m.swings[other]! > flightRelease) || (overstretched && m.swings[other]! > 0.18)
    const minStance = moving ? Math.max(0.05, stanceDur * 0.55) : 0.04
    const phaseReady = moving && travelling && inSwingWindow[i]! && m.contacts[i]! >= minStance
    const settleReady = !travelling && !moving && metrics[i]!.err > 0.24 && m.contacts[i]! >= 0.05
    if (a.feet[i]!.planted && supported && (phaseReady || (overstretched && m.contacts[i]! >= 0.04) || settleReady)) {
      const f = a.feet[i]!
      // The boot pivoted on its locked ball while planted; lift off from the ankle point that pivot left it at.
      const ball = m.toes[i]!
      f.p = [ball[0] - Math.cos(f.yaw) * RIG.foot, f.p[1], ball[2] - Math.sin(f.yaw) * RIG.foot]
      f.planted = false; f.lift = [f.p[0], 0, f.p[2]]; f.liftYaw = f.yaw
      m.swings[i] = 0; m.stances[i] = 0
      if (m.redirectFrom) m.redirectFrom[i] = 0
      m.bowSide[i] = 0
      const stepIdx = ++m.stepCount
      // Same-foot (stepIdx - 2) high-pass blue-noise variation: genuine step-to-step organic variation
      // while telescoping each foot's mean to zero so L/R step symmetry stays ~1.000.
      const blue = (ch: number) => 0.65 * stepHash(actorSeed, stepIdx, ch) - 0.55 * stepHash(actorSeed, stepIdx - 2, ch)
      m.stepReach[i] = actorStrideTrait * (1 + varAmt * (0.046 + 0.019 * curGait.run) * blue(1))
      m.stepLat[i] = varAmt * 0.018 * stepHash(actorSeed, stepIdx, 2)
      m.stepLiftVar[i] = 1 + varAmt * 0.16 * stepHash(actorSeed, stepIdx, 3)
      m.stepToeYaw[i] = varAmt * 0.065 * stepHash(actorSeed, stepIdx, 4)
      m.stepArmVar[i] = 1 + varAmt * 0.14 * stepHash(actorSeed, stepIdx, 5)
      const swingFrac = (1 - curGait.duty) * (1 + (i === 0 ? -1 : 1) * bias)
      const curFootPhase = (a.phase + i * (0.5 + 0.25 * bias) + 1) % 1
      const phaseLead = moving && curFootPhase >= curGait.duty ? clamp(curFootPhase - curGait.duty, 0, swingFrac * 0.35) : 0
      const rawDur = moving
        ? (swingFrac - phaseLead) / Math.max(0.85, cadence) * (1 + 0.12 * st.backness) * (1 - 0.14 * st.sideStep)
        : 0.19
      // A reversal step crosses from behind the old travel to ahead of the new: give it a full stride's swing, not the
      // short side-step one the stance reads while the hips sweep across travel (3 frames at 30 fps).
      const full = gaitAt(m.effort, st.backness, 0, animation)
      const reverseDur = moving && (m.reverseT ?? 0) > 0 ? (1 - full.duty) * full.stride / Math.max(m.effort, 0.5) : 0
      m.durations[i] = clamp(Math.max(rawDur, reverseDur), 0.08, 0.48)
      m.targets[i] = computeTarget(a, i, m.durations[i]!, animation, curGait, speed, moving)
      m.next = 1 - i; m.stepDebt = Math.max(0, m.stepDebt - 1)
    }
  }
  const midYaw = a.feet[0].yaw + angleDiff(a.feet[1].yaw, a.feet[0].yaw) * 0.5
  angleSpring(m.pelvis, a.aim + clamp(angleDiff(midYaw, a.aim), -1.05, 1.05), animation.bodyHz, dt)
  m.pelvis.x = a.aim + clamp(angleDiff(m.pelvis.x, a.aim), -1.05, 1.05)
  const dx = a.feet[1].p[0] - a.feet[0].p[0], dz = a.feet[1].p[2] - a.feet[0].p[2]
  const footForward = dx * Math.cos(a.legYaw) + dz * Math.sin(a.legYaw)
  const twist = clamp(footForward * 0.30, -0.162, 0.162)
  // Phase-compensated two-stage arm & forearm springs opposing leg swing so the hand peaks in phase with the opposite leg.
  const armScale = clamp(animation.armSwing ?? 1, 0, 2) * (actorSeed !== 0 ? 1 + varAmt * 0.06 * stepHash(actorSeed, 0, 9) : 1)
  const footNorm = clamp(footForward / Math.max(0.35, curGait.stride * 0.44), -1, 1)
  const armLeadRad = 0.14 + 1.14 * curGait.run
  const phaseArm = -Math.cos(TAU * a.phase + armLeadRad) * a.gait
  const armSignal = moving ? footNorm * 0.25 + phaseArm * 0.75 : footNorm
  const slowDrift = 1 + varAmt * 0.05 * Math.sin(m.clock * 1.4 + actorSeed)
  const armAmp = (0.16 + 0.22 * curGait.run) * armScale * slowDrift * a.gait
  const armK = stiffness(Math.max(6.5, animation.chestHz * 1.6))
  const handK = stiffness(Math.max(5.5, animation.chestHz * 1.3))
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1
    const stepArm = m.stepArmVar?.[i] ?? 1
    stepSpring(m.arms[i]!, armK, 0.85, dt, -side * armSignal * armAmp * stepArm)
    stepSpring(m.hands[i]!, handK, 0.82, dt, m.arms[i]!.x)
  }
  // Smooth sinusoidal support wave (-1 in L mid-stance, +1 in R mid-stance) eliminates square-wave contact jerk.
  const support = moving ? -0.74 * Math.sin(TAU * a.phase) * a.gait : (a.feet[0].planted === a.feet[1].planted ? 0 : a.feet[0].planted ? -1 : 1)
  const theta = TAU * a.phase
  const k = stiffness(animation.bodyHz)
  const dropAmp = clamp(animation.hipDrop ?? 0.095, 0, 0.22) * (animation.swayScale / 0.095 * 0.087)
  const dropGoal = -support * dropAmp
  const bobScale = clamp(animation.bobScale ?? 1, 0, 2)
  const forward = (a.svx * Math.cos(a.aim) + a.svy * Math.sin(a.aim)) / Math.max(speed, 0.1)
  // Williams Contact (0) -> Down (-1 at phi=1/8) -> Passing (0 at phi=2/8) -> Up/Flight (+1 at phi=3/8):
  // Compensate spring attenuation and phase lag at 2*cadence so m.bob.x has exact Down/Up timing and 4.4cm/6.2cm amplitude.
  const bobSpringHz = Math.max(5.5, animation.bodyHz * 2)
  const bobK = stiffness(bobSpringHz)
  const stepFreq = 2 * cadence
  const rBob = moving ? stepFreq / bobSpringHz : 0
  const bobGain = 1 / Math.sqrt((1 - rBob * rBob) ** 2 + (2 * 0.85 * rBob) ** 2)
  const bobLead = Math.atan2(2 * 0.85 * rBob, 1 - rBob * rBob) * (1 - 0.58 * curGait.run) + (1 - curGait.run) * 0.98
  const sprintTaper = smooth((speed - 4.5) / 1.8)
  const targetBobAmp = (0.021 + 0.009 * curGait.run - 0.007 * sprintTaper) * bobScale * a.gait
  const bobGoal = -(targetBobAmp / Math.max(0.35, bobGain)) * Math.sin(theta * 2 + bobLead)
  const limp = animation.footDrag > 0 ? clamp(animation.footDrag, 0, 0.95) * a.gait : 0
  stepSpring(m.twist, k, 0.85, dt, twist * animation.twistScale)
  stepSpring(m.sway, k, 0.85, dt, support * (0.055 - curGait.run * 0.02) * animation.swayScale)
  stepSpring(m.drop, k, 0.85, dt, limp > 0 ? dropGoal + limp * 0.055 * Math.sin(theta) : dropGoal)
  stepSpring(m.bob, bobK, 0.85, dt, limp > 0 ? bobGoal - limp * 0.032 * Math.sin(theta) : bobGoal)
  if (a.vx * a.svx + a.vy * a.svy < 0) m.bob.v = clamp(m.bob.v, -0.05, 0.05)
  // Secondary follow-through spring (backpack, gear, head pitch lag behind COM vertical bounce + breathing drift).
  const breathIdle = (1 - a.gait * 0.6) * 0.008 * Math.sin(m.clock * 1.7 + actorSeed)
  stepSpring(m.secondary, stiffness(3.8), 0.68, dt, m.bob.x * 1.35 + breathIdle)
  // Centripetal banking into turns from both lateral linear acceleration and angular turn rate * speed.
  const yawRate = clamp(angleDiff(a.legYaw, prevLegYaw) / Math.max(dt, 1e-3), -8, 8)
  const latAccel = -a.acx * Math.sin(a.legYaw) + a.acy * Math.cos(a.legYaw) + yawRate * speed * 0.55
  const bankScale = clamp(animation.turnBank ?? 1, 0, 2)
  stepSpring(m.bank, k, 0.9, dt, clamp(latAccel * 0.008 * bankScale * a.gait, -0.18, 0.18))
  // Keep PR #9's running attitude separate from root acceleration and contact timing.
  // Unarmed civilians run with an upright athletic lean unless crouch-run is explicitly active.
  const isCrouchOverride = Boolean((a as { crouchRun?: boolean }).crouchRun) || (animation.crouchDepth ?? 0) > 0.085
  const postureScale = a.unarmed && !isCrouchOverride ? 0.32 : 1
  const crouchScale = a.unarmed && !isCrouchOverride ? 0.25 : 1
  const speedRamp = curGait.run * a.gait * (0.65 + 0.35 * smooth((speed - 1.8) / 2.4) + 0.244 * smooth((speed - 4.2) / 2.1))
  const posture = clamp(animation.runPosture, 0, 0.45) * postureScale * speedRamp * smooth(forward)
  const crouch = clamp(animation.crouchDepth ?? 0, 0, 0.16) * crouchScale * speedRamp * (0.35 + 0.65 * smooth(forward))
  stepSpring(m.posture, k, 1, dt, posture)
  stepSpring(m.crouch, k, 1, dt, crouch)
  const backScale = forward < 0 ? 0.35 + 0.65 * (1 - smooth(-forward)) : 1
  const walkLeanRamp = a.unarmed ? 0.22 + 0.78 * smooth((speed - 1.65) / 1.75) : 1
  const unarmedLeanScale = a.unarmed ? 0.62 : 1
  const lean = (v: number, accel: number) => clamp((v * 0.025 * backScale * walkLeanRamp + accel * 0.007) * animation.leanScale * unarmedLeanScale, -0.24, 0.24)
  stepSpring(a.leanX, stiffness(2.5), 1, dt, lean(a.svx, a.acx))
  stepSpring(a.leanY, stiffness(2.5), 1, dt, lean(a.svy, a.acy))
  stepSpring(a.dip, k, 0.8, dt, -Math.min(0.035, Math.hypot(a.acx, a.acy) * 0.002))
  return landed
}

/**
 * True when a landing at `target`, `remaining` seconds from now, would be farther from the body than a leg reaches
 * comfortably (a start, a snap turn or a reversal after the target froze), so the late swing must still bend toward it.
 */
function landsOutOfReach(a: Avatar, target: V3, remaining: number): boolean {
  const fx = a.x + a.vx * remaining, fz = a.y + a.vy * remaining
  return Math.hypot(target[0] - fx, target[2] - fz) > 0.46
}

/**
 * Sideways bow for swing `i` when its straight path from lift-off to landing would pass within the boot gap of the
 * planted foot (a side-step closing in, a step round on the spot): the path curves out on the foot's own side.
 */
function swingBow(a: Avatar, i: number, target: V3, animation: HumanProfile): [number, number] {
  const f = a.feet[i]!, o = a.feet[1 - i]!, m = a.motion
  // Steer round the other boot while it is down; fade over its swing rather than cut off the instant it lifts or lands,
  // which jumped this boot sideways by up to the full bow (21 cm in one frame).
  const weight = o.planted ? 1 : 1 - Math.sin(Math.PI * clamp(m.swings[1 - i]!, 0, 1))
  const dx = target[0] - f.lift[0], dz = target[2] - f.lift[2], l2 = dx * dx + dz * dz
  if (weight <= 0 || l2 < 1e-4) return [0, 0]
  const l = Math.sqrt(l2), gap = (animation.strafeGap ?? 0.2) * 0.9
  const along = ((o.p[0] - f.lift[0]) * dx + (o.p[2] - f.lift[2]) * dz) / l2
  // Signed offset of the path from the other boot along the path normal, and how far the boot lies past either end.
  const nx = -dz / l, nz = dx / l
  const sd = (f.lift[0] - o.p[0]) * nx + (f.lift[2] - o.p[2]) * nz
  const past = Math.max(0, -along, along - 1) * l
  // Pick the side once per swing: "away from the other boot" flipped the instant the path swept over it (23 cm).
  if (!m.bowSide[i]) {
    if (Math.hypot(sd, past) >= gap) return [0, 0]
    const own = (-Math.sin(a.legYaw) * nx + Math.cos(a.legYaw) * nz) * (i === 0 ? -1 : 1)
    m.bowSide[i] = Math.abs(sd) > 1e-3 ? Math.sign(sd) : own < 0 ? -1 : 1
  }
  const bowSide = m.bowSide[i]!
  const need = gap - Math.hypot(Math.max(0, sd * bowSide), past)
  if (need <= 0) return [0, 0]
  const k = need * Math.min(1, l / 0.15) * weight * bowSide
  return [nx * k, nz * k]
}

/**
 * How far planted foot `i` is from its hip, `ahead` seconds from now, as a share of the leg's horizontal reach at the
 * current pelvis height (1 = the knee is straight). With `across`, a boot behind the hip counts only its sideways
 * offset (a running stride trails far behind by design). Side-steps, cuts and reversals run out of reach long
 * before the root-distance limits do.
 */
function hipReach(a: Avatar, i: number, ahead: number, across = false): number {
  const pel = pelvisPoint(a), s = i === 0 ? -1 : 1, f = a.feet[i]!
  const hx = pel[0] - Math.sin(a.legYaw) * s * RIG.hipW + a.svx * ahead
  const hz = pel[2] + Math.cos(a.legYaw) * s * RIG.hipW + a.svy * ahead
  const h = Math.max(0.3, pel[1] - RIG.ankle), leg = RIG.thigh + RIG.shin
  // A trailing boot rolls onto its ball (heel rise), which buys about a foot length of reach behind.
  const sp = Math.hypot(a.svx, a.svy), tx = sp > 0.1 ? a.svx / sp : 0, tz = sp > 0.1 ? a.svy / sp : 0
  const dx = f.p[0] - hx, dz = f.p[2] - hz, along = dx * tx + dz * tz, side = Math.hypot(dx - along * tx, dz - along * tz)
  const reach = Math.hypot(side, along > 0 ? along : across ? 0 : Math.min(0, along + RIG.foot))
  return reach / Math.sqrt(Math.max(1e-4, leg * leg - h * h))
}

function lockToe(a: Avatar, i: number): void {
  const f = a.feet[i]!
  a.motion.toes[i] = [f.p[0] + Math.cos(f.yaw) * RIG.foot, 0, f.p[2] + Math.sin(f.yaw) * RIG.foot]
}

/** Stance foot roll: heel-strike dorsiflexion -> foot-flat -> heel-rise onto the locked ball of the foot -> toe-off. */
export function stanceFootRoll(a: Avatar, i: number): { footPitch: number; heelRisePitch: number; toeRelPitch: number } {
  const f = a.feet[i]!, m = a.motion
  const s = m.stances?.[i] ?? 0
  const isDrag = i === (m.dragFoot ?? 1) && (m.footDrag ?? 0) > 0
  const drag = isDrag ? clamp(m.footDrag ?? 0, 0, 0.95) : 0
  const dragKeep = 1 - drag
  const turnKeep = smooth((0.90 - Math.abs(angleDiff(f.yaw, a.legYaw))) / 0.15)
  const sFlat = 0.16 - 0.04 * m.run
  const heelStrike0 = (1 - (m.backness ?? (a.back ? 1 : 0))) * (0.26 - 0.04 * m.run) * a.gait * dragKeep * turnKeep
  const heelStrikePitch = s < sFlat ? heelStrike0 * (1 - smooth(s / sFlat)) : 0
  const sHeelRise = 0.44 - 0.04 * m.run
  const heelRiseMax = (0.44 + 0.08 * m.run) * a.gait * (1 - 0.55 * drag)
  const riseU = smooth((s - sHeelRise) / (1 - sHeelRise))
  const heelRisePitch = s > sHeelRise ? -heelRiseMax * riseU : 0
  const footPitch = heelStrikePitch + heelRisePitch
  return { footPitch, heelRisePitch, toeRelPitch: -footPitch }
}

/** Heel-strike dorsiflexion at contact rolls flat by Down, then rolls onto the locked ball of the foot in terminal stance (heel-off). */
export function plantedFoot(a: Avatar, i: number) {
  const f = a.feet[i]!, ball = a.motion.toes[i]!
  const { footPitch, heelRisePitch } = stanceFootRoll(a, i)
  const frame = pitch(yawFrame([0, 0, 0], f.yaw), footPitch)
  const riseFrame = pitch(yawFrame([0, 0, 0], f.yaw), heelRisePitch)
  const offset = at(riseFrame, RIG.foot, -RIG.ankle, 0)
  return moved(frame, [ball[0] - offset[0], ball[1] - offset[1], ball[2] - offset[2]])
}

/** Toe (ball-of-foot) frame for a planted foot: locked flat on the ball throughout stance while the foot rolls heel-to-toe. */
export function plantedToe(a: Avatar, i: number, _ft?: Frame) {
  const f = a.feet[i]!, ball = a.motion.toes[i]!
  return yawFrame([ball[0], ball[1], ball[2]], f.yaw)
}

/** Head is the lean pivot; hips move underneath rather than throwing the head forward. */
export function pelvisPoint(a: Avatar): V3 {
  const m = a.motion, c = Math.cos(m.pelvis.x), s = Math.sin(m.pelvis.x)
  const walkDrop = (a.unarmed ? -0.008 : m.footDrag > 0 ? 0.008 : 0.044) * (1 - m.run) + 0.04 * m.run
  const runDrop = a.unarmed ? -0.008 : 0.02
  return [a.x - a.leanX.x * 0.22 - s * m.sway.x + a.hitX.x * 0.5,
    HIP - (walkDrop + m.run * runDrop) * a.gait - m.crouch.x + m.bob.x + a.dip.x - Math.hypot(a.leanX.x, a.leanY.x) ** 2 * 0.3,
    a.y - a.leanY.x * 0.22 + c * m.sway.x + a.hitY.x * 0.5]
}
