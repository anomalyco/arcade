import { HIP, RIG } from "./rig"
import { humanProfiles, type HumanProfile } from "./human-profile"
import { at, clamp, moved, pitch, smooth, smoother, spring, stepSpring, yawFrame, type Spring, type V3 } from "./rig"

export type Foot = { p: V3; yaw: number; pitch: number; planted: boolean; lift: V3; liftYaw: number }
/** Presentation state only. No game, weapon, mesh, DOM or network dependency. */
export type Locomotion = {
  x: number; y: number; vx: number; vy: number; aim: number
  svx: number; svy: number; acx: number; acy: number
  legYaw: number; gait: number; duty: number; phase: number; back: boolean; turning: boolean
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

const TAU = Math.PI * 2
export const stiffness = (hz: number) => (hz * TAU) ** 2
export function angleSpring(s: Spring, goal: number, hz: number, dt: number): void {
  stepSpring(s, stiffness(hz), 1, dt, s.x + angleDiff(goal, s.x))
}

export function newMotion(x: number, y: number, aim: number) {
  return {
    enabled: false, run: 0, stride: 1, stepDebt: 0, next: 0, moving: false, start: 0, strafeSign: 0,
    centreX: { x, v: 0 }, centreY: { x: y, v: 0 },
    pelvis: { x: aim, v: 0 }, chest: { x: aim, v: 0 }, head: { x: aim, v: 0 }, weapon: { x: aim, v: 0 },
    bob: spring(), sway: spring(), drop: spring(), twist: spring(), posture: spring(), crouch: spring(), bank: spring(),
    yawOffset: spring(),
    arms: [spring(), spring()] as [Spring, Spring],
    hands: [spring(), spring()] as [Spring, Spring],
    gun: [spring(), spring(), spring()] as [Spring, Spring, Spring],
    swings: [0, 0], durations: [0.2, 0.2], contacts: [1, 1],
    targets: [[x, 0, y], [x, 0, y]] as [V3, V3],
    toes: [[x, 0, y], [x, 0, y]] as [V3, V3],
  }
}

/** Smooth Froude transition, using leg length rather than overall character height. */
export function gaitAt(speed: number, back = false, strafe = 0, animation: HumanProfile = humanProfiles.soldier) {
  const h = RIG.thigh + RIG.shin
  const froude = speed * speed / (9.81 * h)
  const run = smooth((froude - 0.36) / 0.28)
  // Speed increases mostly via stride at low speeds and increasingly via cadence at high speeds (Alexander 1984).
  const effSpeed = speed - 0.22 * Math.max(0, speed - 3.6) * smooth((speed - 3.0) / 3.3)
  const stride = h * (effSpeed / Math.sqrt(9.81 * h) + 0.7) / 0.83 * animation.strideScale
  // Arcade sprint is 6.3 m/s: shorter support and a longer flight, not an unreachable planted leg.
  return { run, stride: stride * (back ? 0.85 : 1 - 0.18 * strafe), duty: 0.6 - 0.16 * run - 0.2 * smooth((speed - 2.5) / 3) }
}

function home(a: Avatar, i: number, lead: number, vx = a.svx, vy = a.svy, extraWidth = 0): V3 {
  const side = i === 0 ? -1 : 1
  const c = Math.cos(a.legYaw), s = Math.sin(a.legYaw)
  const m = a.motion
  const width = 0.145 + extraWidth
  const stagger = (i === 0 ? 0.08 : -0.06) * (1 - a.gait)
  return [m.centreX.x + c * stagger - s * side * width + vx * lead, 0,
    m.centreY.x + s * stagger + c * side * width + vy * lead]
}

function separate(a: Avatar, i: number, p: V3, weight = 1): V3 {
  if (weight <= 0) return p
  const o = a.feet[1 - i]!.p, side = i === 0 ? -1 : 1
  // Aim space stays consistent during sideways reversals, unlike the rotating pelvis.
  const s = Math.sin(a.aim), c = Math.cos(a.aim)
  const gap = (-(p[0] - o[0]) * s + (p[2] - o[2]) * c) * side
  const correction = Math.max(0, 0.20 - gap) * weight
  return [p[0] - s * side * correction, p[1], p[2] + c * side * correction]
}

function computeTarget(a: Avatar, i: number, remaining: number, strafe: number, gait: ReturnType<typeof gaitAt>, speed: number, moving: boolean): V3 {
  const m = a.motion
  const travelling = Math.hypot(a.vx, a.vy) > 0.12
  if (!moving || !travelling) return separate(a, i, home(a, i, 0), smooth((strafe - 0.05) / 0.20))
  // When authoritative velocity opposes or turns sharply from smoothed svx/svy, use authoritative
  // velocity for touchdown lookahead so mid-air feet immediately redirect into the new travel path.
  const rawDot = a.vx * a.svx + a.vy * a.svy
  const blend = rawDot < 0 ? 0.9 : 0.65
  const pvx = a.svx + (a.vx - a.svx) * blend, pvy = a.svy + (a.vy - a.svy) * blend
  const pspeed = Math.hypot(pvx, pvy)
  const support = gait.duty * gait.stride / Math.max(pspeed, 0.1)
  const halfStance = Math.min(0.15, support * 0.45, 0.24 / Math.max(pspeed, 0.1))
  const lag = clamp(((a.x - m.centreX.x) * pvx + (a.y - m.centreY.x) * pvy) / Math.max(pspeed * pspeed, 0.25), -0.22, 0.22)
  // Overgrowth-style lateral shuffle: the outside/leading foot steps out first while the inside/following
  // foot steps up beside it without lunging across the leading leg.
  const side = i === 0 ? -1 : 1
  const lat = -pvx * Math.sin(a.aim) + pvy * Math.cos(a.aim)
  const isLead = side * lat > 0
  const strafeLeadScale = strafe > 0.05 ? (isLead ? 1 + 0.08 * strafe : 1 - 0.32 * strafe) : 1
  const extraWidth = strafe * (isLead ? 0.025 : 0.01)
  return separate(a, i, home(a, i, (remaining + halfStance) * strafeLeadScale + lag, pvx, pvy, extraWidth), smooth((strafe - 0.05) / 0.20))
}

function reset(a: Avatar): void {
  const m = a.motion
  m.centreX = { x: a.x, v: a.vx }
  m.centreY = { x: a.y, v: a.vy }
  for (const s of [m.pelvis, m.chest, m.head, m.weapon]) { s.x = a.aim; s.v = 0 }
  for (const s of [m.bob, m.sway, m.drop, m.twist, m.posture, m.crouch, m.bank, m.yawOffset, ...m.arms, ...m.hands]) { s.x = 0; s.v = 0 }
  m.stepDebt = 0; m.start = 0; m.moving = false; m.next = 0; m.strafeSign = 0
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    f.p = home(a, i, 0); f.lift = [...f.p]; f.yaw = a.legYaw; f.pitch = 0; f.planted = true
    lockToe(a, i)
    m.swings[i] = 0; m.contacts[i] = 1; m.targets[i] = [...f.p]
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
  const stranded = a.feet.every(f => Math.hypot(f.p[0] - a.x, f.p[2] - a.y) > 0.72)
  if (teleport || !m.enabled || stranded) reset(a)
  const lateral = -a.svx * Math.sin(a.aim) + a.svy * Math.cos(a.aim)
  const strafe = smooth((Math.abs(lateral) / Math.max(speed, 0.01) - 0.5) * 2)
  const strafeSign = strafe > 0.25 && Math.abs(lateral) > 0.25 ? Math.sign(lateral) : 0
  if (strafeSign !== 0 && strafeSign !== m.strafeSign) {
    // Lead with the outside foot when starting or reversing a side-step (Overgrowth HandleFootStance).
    m.next = strafeSign > 0 ? 1 : 0
    m.strafeSign = strafeSign
  } else if (strafe < 0.1) m.strafeSign = 0
  const moving = speed > (m.moving ? 0.12 : 0.25)
  if (moving && !m.moving) {
    m.start = 0.015; m.stepDebt = 1; m.next = lateral > 0 ? 1 : 0
    // Start anticipation: subtle crouch dip and initial lean impulse into acceleration.
    a.dip.v -= 0.22
    a.leanX.v += a.acx * 0.008 * animation.leanScale
    a.leanY.v += a.acy * 0.008 * animation.leanScale
  }
  m.moving = moving
  m.start = Math.max(0, m.start - dt)
  const transK = stiffness(clamp(animation.transitionHz ?? 6, 2, 14))
  // Angular limits are ownership constraints, not springs that can remain outside the limit.
  if (moving) {
    let direction = Math.atan2(a.svy, a.svx)
    const error = Math.abs(angleDiff(direction, a.aim))
    const limit = 1.05 - strafe * 0.6
    const flipped = a.back ? error < 1.72 : error > 2.05
    if (flipped) {
      const oldDir = direction + (a.back ? Math.PI : 0)
      const oldGoal = a.aim + clamp(angleDiff(oldDir, a.aim), -limit, limit)
      a.back = !a.back
      const newDir = direction + (a.back ? Math.PI : 0)
      const newGoal = a.aim + clamp(angleDiff(newDir, a.aim), -limit, limit)
      // Inertialize the quadrant flip (Holden / Bollo GDC 2018) so legYaw has C1 velocity continuity.
      m.yawOffset.x = clamp(m.yawOffset.x + angleDiff(oldGoal, newGoal), -0.85, 0.85)
    }
    if (a.back) direction += Math.PI
    stepSpring(m.yawOffset, transK, 1, dt, 0)
    // Sideways shuffles retain a wider silhouette and let the lead boot open.
    const rawGoal = a.aim + clamp(angleDiff(direction, a.aim), -limit, limit)
    const goal = a.aim + clamp(angleDiff(rawGoal + m.yawOffset.x, a.aim), -1.05, 1.05)
    a.legYaw += angleDiff(goal, a.legYaw) * (1 - Math.exp(-dt * 9))
    a.turning = false
  } else {
    a.back = false
    stepSpring(m.yawOffset, transK, 1, dt, 0)
    const error = angleDiff(a.aim, a.legYaw)
    if (Math.abs(error) > 1.05) a.turning = true
    if (a.turning) {
      a.legYaw += error * (1 - Math.exp(-dt * 10))
      if (Math.abs(error) < 0.08) a.turning = false
    }
  }
  a.legYaw = a.aim + clamp(angleDiff(a.legYaw, a.aim), -1.05, 1.05)
  const gait = gaitAt(speed, a.back, strafe, animation)
  m.run = gait.run; m.stride = gait.stride
  a.duty = gait.duty
  const wheel = teleport ? 0 : distance / gait.stride
  // Phase-synchronised blending: softly lock the normalized gait phase to the active swing foot
  // so walk <-> run <-> sprint speed ramps keep body oscillations matched to actual footfalls.
  let phaseSync = 0
  if (!teleport && wheel > 0 && a.feet[0].planted !== a.feet[1].planted) {
    const swIdx = !a.feet[0].planted ? 0 : 1
    const targetPhase = (swIdx * 0.5 + a.duty * 0.5 + m.swings[swIdx]! * (1 - a.duty) * 0.5) % 1
    const diff = ((targetPhase - a.phase + 1.5) % 1) - 0.5
    phaseSync = clamp(diff * 0.15, -wheel * 0.35, wheel * 0.35)
  }
  a.phase = (a.phase + wheel + phaseSync + 1) % 1
  m.stepDebt = Math.min(1, m.stepDebt + wheel * 2)
  const follow = stiffness(animation.footCentreHz)
  stepSpring(m.centreX, follow, 0.65, dt, a.x + a.svx * 0.025)
  stepSpring(m.centreY, follow, 0.65, dt, a.y + a.svy * 0.025)
  for (const [s, goal] of [[m.centreX, a.x], [m.centreY, a.y]] as const) s.x = clamp(s.x, goal - 0.3, goal + 0.3)

  let landed = false
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    if (f.planted) {
      m.contacts[i]! += dt
      // Pivot at the locked contact, never translate the planted boot.
      f.yaw = a.legYaw + clamp(angleDiff(f.yaw, a.legYaw), -0.96, 0.96)
      continue
    }
    const prevU = m.swings[i]!
    let u = Math.min(1, prevU + dt / m.durations[i]!)
    const rawDot = a.vx * a.svx + a.vy * a.svy
    const stopping = !travelling && speed > 0.2
    const reversing = travelling && rawDot < 0 && (a.feet[1 - i]!.planted || prevU > m.swings[1 - i]!)
    // If the character reverses while this foot is in late swing, redirect it to the new direction
    // and extend its remaining swing once so it never plants behind the reversal.
    if (reversing && prevU >= 0.60 && prevU < 0.95) {
      f.lift = [f.p[0], 0, f.p[2]]
      f.liftYaw = f.yaw
      u = 0.30
      m.targets[i] = computeTarget(a, i, (1 - u) * m.durations[i]!, strafe, gait, speed, moving)
    } else if (u < (stopping ? 0.90 : 0.75)) {
      const desired = computeTarget(a, i, (1 - u) * m.durations[i]!, strafe, gait, speed, moving)
      const prevT = m.targets[i]!
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
    const liftScale = clamp(animation.stepLift ?? 1, 0.5, 1.8)
    f.p = [f.lift[0] + (target[0] - f.lift[0]) * eHoriz,
      (0.08 + 0.12 * gait.run) * liftScale * (i === 1 ? 1 - drag : 1) * 9.48 * (1 - u) ** 3 * u,
      f.lift[2] + (target[2] - f.lift[2]) * eHoriz]
    const sepW = smooth((strafe - 0.05) / 0.20)
    if (sepW > 0) f.p = separate(a, i, f.p, sepW)
    const side = i === 0 ? -1 : 1
    const opening = strafe * Math.sign(lateral) * (side * lateral > 0 ? 0.6 : 0.12)
    f.yaw = f.liftYaw + angleDiff(a.legYaw + opening + side * 0.06, f.liftYaw) * e
    f.pitch = (drag > 0 ? (-0.4 * (1 - drag * 0.85) + 0.16 * drag) * Math.sin(Math.PI * u) - 0.12 * smooth((u - 0.7) / 0.3) * (1 - drag * 0.7)
      : -0.4 * Math.sin(Math.PI * u) - 0.12 * smooth((u - 0.7) / 0.3))
    if (u === 1) {
      f.planted = true; f.p[1] = 0; f.pitch = 0
      lockToe(a, i)
      m.contacts[i] = 0; landed = true
      // Weight-acceptance Down impulse on touchdown (Williams / Lamplight walk.rs:1455).
      a.dip.v -= (0.04 + 0.08 * gait.run) * clamp(animation.bobScale ?? 1, 0, 2) * a.gait
    }
  }
  // Walking requests a step only with support. Running releases the support toe after the
  // other swing is committed, or early if a reversal stretches a trailing planted leg.
  if (m.start === 0) {
    const pvx = a.svx + (a.vx - a.svx) * 0.5, pvy = a.svy + (a.vy - a.svy) * 0.5
    const pspeed = Math.max(speed, Math.hypot(pvx, pvy), 0.1)
    const metrics = [0, 1].map(idx => {
      const f = a.feet[idx]!, p = home(a, idx, 0)
      const err = Math.hypot(f.p[0] - p[0], f.p[2] - p[2]) + Math.abs(angleDiff(f.yaw, a.legYaw)) * 0.25
      const behind = ((p[0] - f.p[0]) * a.svx + (p[2] - f.p[2]) * a.svy) / Math.max(speed, 0.1)
      const rootBehind = ((a.x - f.p[0]) * pvx + (a.y - f.p[2]) * pvy) / pspeed
      return { err, behind, rootBehind }
    })
    let preferred = moving ? m.next : metrics[0]!.err > metrics[1]!.err ? 0 : 1
    if (moving && a.feet[0].planted && a.feet[1].planted) {
      const alt = 1 - preferred
      if (metrics[alt]!.rootBehind > metrics[preferred]!.rootBehind + 0.06) preferred = alt
    }
    const i = a.feet[preferred]!.planted ? preferred : 1 - preferred
    const other = 1 - i
    const overstretched = metrics[i]!.rootBehind > 0.34
    const flightRelease = 0.35 + 0.16 * strafe
    const supported = a.feet[other]!.planted || (gait.run > 0.5 && m.swings[other]! > flightRelease) || (overstretched && m.swings[other]! > 0.18)
    // An ahead-of-root contact is supporting the next step, not asking for another one.
    const urgent = travelling ? (metrics[i]!.behind > 0.26 || overstretched) : metrics[i]!.err > 0.22
    if (a.feet[i]!.planted && supported && (urgent || moving && m.stepDebt >= 1) && m.contacts[i]! >= 0.04) {
      const f = a.feet[i]!
      f.planted = false; f.lift = [...f.p]; f.liftYaw = f.yaw
      m.swings[i] = 0
      // Shorter/faster lead-follow shuffle, slower backpedal. Do not reset the wheel at transition.
      const cadence = Math.max(0.95, speed / gait.stride)
      m.durations[i] = moving ? clamp((1 - gait.duty) / cadence * (a.back ? 1.12 : 1 - strafe * 0.14), 0.11, 0.22 + gait.run * 0.08) : 0.19
      m.durations[i]! *= 1 + (i === 0 ? -1 : 1) * clamp(animation.timingBias, -0.3, 0.3)
      m.targets[i] = computeTarget(a, i, m.durations[i]!, strafe, gait, speed, moving)
      m.next = 1 - i; m.stepDebt = Math.max(0, m.stepDebt - 1)
    }
  }
  const midYaw = a.feet[0].yaw + angleDiff(a.feet[1].yaw, a.feet[0].yaw) * 0.5
  angleSpring(m.pelvis, a.aim + clamp(angleDiff(midYaw, a.aim), -1.05, 1.05), animation.bodyHz, dt)
  m.pelvis.x = a.aim + clamp(angleDiff(m.pelvis.x, a.aim), -1.05, 1.05)
  const dx = a.feet[1].p[0] - a.feet[0].p[0], dz = a.feet[1].p[2] - a.feet[0].p[2]
  const footForward = dx * Math.cos(a.legYaw) + dz * Math.sin(a.legYaw)
  const twist = clamp(footForward * 0.32, -0.17, 0.17)
  // Two-stage arm & forearm follow-through springs opposing actual foot separation (Lamplight walk.rs:1494).
  const armScale = clamp(animation.armSwing ?? 1, 0, 2)
  const footNorm = clamp(footForward / Math.max(0.35, gait.stride * 0.48), -1, 1)
  const armAmp = (0.24 + 0.12 * gait.run) * armScale * a.gait
  const armK = stiffness(Math.max(3.5, animation.chestHz * 1.1))
  const handK = stiffness(Math.max(2.8, animation.chestHz * 0.85))
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1
    stepSpring(m.arms[i]!, armK, 0.85, dt, -side * footNorm * armAmp)
    stepSpring(m.hands[i]!, handK, 0.78, dt, m.arms[i]!.x)
  }
  const support = a.feet[0].planted === a.feet[1].planted ? 0 : a.feet[0].planted ? -1 : 1
  const theta = TAU * (a.phase - a.duty / 2)
  const k = stiffness(animation.bodyHz)
  const dropAmp = clamp(animation.hipDrop ?? 0.095, 0, 0.22) * (animation.swayScale / 0.095 * 0.087)
  const dropGoal = -support * dropAmp
  const bobScale = clamp(animation.bobScale ?? 1, 0, 2)
  // Phase-shifted harmonic preserves full bounce amplitude across the walk->run transition (gait.run = 0.5)
  // while shifting the vertical peak from mid-stance (walk) to flight (run).
  const bobGoal = 0.035 * bobScale * Math.cos(theta * 2 - Math.PI * gait.run) * a.gait
  const limp = animation.footDrag > 0 ? clamp(animation.footDrag, 0, 0.95) * a.gait : 0
  stepSpring(m.twist, k, 0.85, dt, twist * animation.twistScale)
  stepSpring(m.sway, k, 0.85, dt, support * (0.055 - gait.run * 0.02) * animation.swayScale)
  stepSpring(m.drop, k, 0.85, dt, limp > 0 ? dropGoal + limp * 0.055 * Math.sin(theta) : dropGoal)
  stepSpring(m.bob, k, 0.85, dt, limp > 0 ? bobGoal - limp * 0.032 * Math.sin(theta) : bobGoal)
  // Centripetal banking into turns from lateral acceleration in legYaw frame.
  const latAccel = -a.acx * Math.sin(a.legYaw) + a.acy * Math.cos(a.legYaw)
  const bankScale = clamp(animation.turnBank ?? 1, 0, 2)
  stepSpring(m.bank, k, 0.9, dt, clamp(latAccel * 0.008 * bankScale * a.gait, -0.18, 0.18))
  // Keep PR #9's running attitude separate from root acceleration and contact timing.
  const forward = (a.svx * Math.cos(a.aim) + a.svy * Math.sin(a.aim)) / Math.max(speed, 0.1)
  const speedRamp = gait.run * a.gait * (0.65 + 0.35 * smooth((speed - 1.8) / 2.4) + 0.25 * smooth((speed - 4.2) / 2.1))
  const posture = clamp(animation.runPosture, 0, 0.45) * speedRamp * smooth(forward)
  const crouch = clamp(animation.crouchDepth ?? 0, 0, 0.16) * speedRamp * (0.35 + 0.65 * smooth(forward))
  stepSpring(m.posture, k, 1, dt, posture)
  stepSpring(m.crouch, k, 1, dt, crouch)
  const backScale = forward < 0 ? 0.35 + 0.65 * (1 - smooth(-forward)) : 1
  const lean = (v: number, accel: number) => clamp((v * 0.025 * backScale + accel * 0.007) * animation.leanScale, -0.24, 0.24)
  stepSpring(a.leanX, stiffness(2.5), 1, dt, lean(a.svx, a.acx))
  stepSpring(a.leanY, stiffness(2.5), 1, dt, lean(a.svy, a.acy))
  stepSpring(a.dip, k, 0.8, dt, -Math.min(0.035, Math.hypot(a.acx, a.acy) * 0.002))
  return landed
}

function lockToe(a: Avatar, i: number): void {
  const f = a.feet[i]!
  a.motion.toes[i] = [f.p[0] + Math.cos(f.yaw) * 0.19, 0, f.p[2] + Math.sin(f.yaw) * 0.19]
}

/** Toe-first contact rolls the heel down; yaw pivots about the same world-space toe. */
export function plantedFoot(a: Avatar, i: number) {
  const f = a.feet[i]!, toe = a.motion.toes[i]!
  const heel = -0.12 * (1 - smooth(a.motion.contacts[i]! / 0.06))
  const frame = pitch(yawFrame([0, 0, 0], f.yaw), heel)
  const offset = at(frame, 0.19, -RIG.ankle, 0)
  return moved(frame, [toe[0] - offset[0], toe[1] - offset[1], toe[2] - offset[2]])
}

/** Head is the lean pivot; hips move underneath rather than throwing the head forward. */
export function pelvisPoint(a: Avatar): V3 {
  const m = a.motion, c = Math.cos(m.pelvis.x), s = Math.sin(m.pelvis.x)
  return [a.x - a.leanX.x * 0.22 - s * m.sway.x + a.hitX.x * 0.5,
    HIP - (0.04 + m.run * 0.02) * a.gait - m.crouch.x + m.bob.x + a.dip.x - Math.hypot(a.leanX.x, a.leanY.x) ** 2 * 0.3,
    a.y - a.leanY.x * 0.22 + c * m.sway.x + a.hitY.x * 0.5]
}
