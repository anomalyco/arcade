import { angleDiff } from "../../shared/geom"
import { HIP, RIG } from "../render/person"
import type { Avatar } from "./anim"
import { animation } from "./anim-settings"
import { at, clamp, moved, pitch, smooth, smoother, spring, stepSpring, yawFrame, type Spring, type V3 } from "./rig"

const TAU = Math.PI * 2
export const stiffness = (hz: number) => (hz * TAU) ** 2
export function angleSpring(s: Spring, goal: number, hz: number, dt: number): void {
  stepSpring(s, stiffness(hz), 1, dt, s.x + angleDiff(goal, s.x))
}

export function newMotion(x: number, y: number, aim: number) {
  return {
    enabled: false, run: 0, stride: 1, stepDebt: 0, next: 0, moving: false, start: 0,
    centreX: { x, v: 0 }, centreY: { x: y, v: 0 },
    pelvis: { x: aim, v: 0 }, chest: { x: aim, v: 0 }, head: { x: aim, v: 0 }, weapon: { x: aim, v: 0 },
    bob: spring(), sway: spring(), drop: spring(), twist: spring(),
    gun: [spring(), spring(), spring()] as [Spring, Spring, Spring],
    swings: [0, 0], durations: [0.2, 0.2], contacts: [1, 1],
    targets: [[x, 0, y], [x, 0, y]] as [V3, V3],
    toes: [[x, 0, y], [x, 0, y]] as [V3, V3],
  }
}

/** Smooth Froude transition, using leg length rather than overall character height. */
export function gaitAt(speed: number, back = false, strafe = 0) {
  const h = RIG.thigh + RIG.shin
  const froude = speed * speed / (9.81 * h)
  const run = smooth((froude - 0.36) / 0.28)
  const stride = h * (speed / Math.sqrt(9.81 * h) + 0.7) / 0.83 * animation.strideScale
  // Arcade sprint is 6.3 m/s: shorter support and a longer flight, not an unreachable planted leg.
  return { run, stride: stride * (back ? 0.85 : 1 - 0.18 * strafe), duty: 0.6 - 0.16 * run - 0.2 * smooth((speed - 2.5) / 3) }
}

function home(a: Avatar, i: number, lead: number): V3 {
  const side = i === 0 ? -1 : 1
  const c = Math.cos(a.legYaw), s = Math.sin(a.legYaw)
  const m = a.motion
  const width = 0.145
  const stagger = (i === 0 ? 0.08 : -0.06) * (1 - a.gait)
  return [m.centreX.x + c * stagger - s * side * width + a.svx * lead, 0,
    m.centreY.x + s * stagger + c * side * width + a.svy * lead]
}

function separate(a: Avatar, i: number, p: V3): V3 {
  const o = a.feet[1 - i]!.p, side = i === 0 ? -1 : 1
  // Aim space stays consistent during sideways reversals, unlike the rotating pelvis.
  const s = Math.sin(a.aim), c = Math.cos(a.aim)
  const gap = (-(p[0] - o[0]) * s + (p[2] - o[2]) * c) * side
  const correction = Math.max(0, 0.20 - gap)
  return [p[0] - s * side * correction, p[1], p[2] + c * side * correction]
}

function reset(a: Avatar): void {
  const m = a.motion
  m.centreX = { x: a.x, v: a.vx }
  m.centreY = { x: a.y, v: a.vy }
  for (const s of [m.pelvis, m.chest, m.head, m.weapon]) { s.x = a.aim; s.v = 0 }
  for (const s of [m.bob, m.sway, m.drop, m.twist]) { s.x = 0; s.v = 0 }
  m.stepDebt = 0; m.start = 0; m.moving = false; m.next = 0
  for (let i = 0; i < 2; i++) {
    const f = a.feet[i]!
    f.p = home(a, i, 0); f.lift = [...f.p]; f.yaw = a.legYaw; f.pitch = 0; f.planted = true
    lockToe(a, i)
    m.swings[i] = 0; m.contacts[i] = 1
  }
  const hold = a.body?.gun?.p ?? [a.x, 1.24, a.y]
  m.gun.forEach((s, i) => { s.x = hold[i]!; s.v = 0 })
  m.enabled = true
}

/** Advances contact ownership separately from stride phase. Returns a touchdown cue. */
export function locomotion(a: Avatar, dt: number, distance: number, teleport: boolean): boolean {
  const m = a.motion, speed = Math.hypot(a.svx, a.svy)
  const travelling = Math.hypot(a.vx, a.vy) > 0.12
  if (teleport || !m.enabled) reset(a)
  const lateral = -a.svx * Math.sin(a.aim) + a.svy * Math.cos(a.aim)
  const strafe = smooth((Math.abs(lateral) / Math.max(speed, 0.01) - 0.5) * 2)
  const moving = speed > (m.moving ? 0.12 : 0.25)
  if (moving && !m.moving) { m.start = 0.05; m.stepDebt = 1; m.next = lateral > 0 ? 1 : 0; a.dip.v -= 0.2 }
  m.moving = moving
  m.start = Math.max(0, m.start - dt)
  // Angular limits are ownership constraints, not springs that can remain outside the limit.
  if (moving) {
    let direction = Math.atan2(a.svy, a.svx)
    const error = Math.abs(angleDiff(direction, a.aim))
    if (a.back ? error < 1.72 : error > 2.05) a.back = !a.back
    if (a.back) direction += Math.PI
    // Sideways shuffles retain a wider silhouette and let the lead boot open.
    const limit = 1.05 - strafe * 0.6
    const goal = a.aim + clamp(angleDiff(direction, a.aim), -limit, limit)
    a.legYaw += angleDiff(goal, a.legYaw) * (1 - Math.exp(-dt * 9))
    a.turning = false
  } else {
    a.back = false
    const error = angleDiff(a.aim, a.legYaw)
    if (Math.abs(error) > 1.05) a.turning = true
    if (a.turning) {
      a.legYaw += error * (1 - Math.exp(-dt * 10))
      if (Math.abs(error) < 0.08) a.turning = false
    }
  }
  a.legYaw = a.aim + clamp(angleDiff(a.legYaw, a.aim), -1.05, 1.05)
  const gait = gaitAt(speed, a.back, strafe)
  m.run = gait.run; m.stride = gait.stride
  a.duty = gait.duty
  const wheel = teleport ? 0 : distance / gait.stride
  a.phase = (a.phase + wheel) % 1
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
    const u = Math.min(1, m.swings[i]! + dt / m.durations[i]!)
    m.swings[i] = u
    // Extrapolate early; freeze the last 25% so touchdown cannot chase the root.
    if (u < 0.75 || !travelling) {
      const remaining = (1 - u) * m.durations[i]!
      const support = gait.duty * gait.stride / Math.max(speed, 0.1)
      const lag = ((a.x - m.centreX.x) * a.svx + (a.y - m.centreY.x) * a.svy) / Math.max(speed * speed, 0.1)
      m.targets[i] = home(a, i, moving && travelling ? remaining + Math.min(0.15, support * 0.45, 0.24 / Math.max(speed, 0.1)) + lag : 0)
    }
    let target = m.targets[i]!
    if (strafe > 0.2) target = separate(a, i, target)
    const e = smoother(u)
    f.p = [f.lift[0] + (target[0] - f.lift[0]) * e,
      (0.08 + 0.12 * gait.run) * 9.48 * (1 - u) ** 3 * u,
      f.lift[2] + (target[2] - f.lift[2]) * e]
    if (strafe > 0.2) f.p = separate(a, i, f.p)
    const side = i === 0 ? -1 : 1
    const opening = strafe * Math.sign(lateral) * (side * lateral > 0 ? 0.6 : 0.12)
    f.yaw = f.liftYaw + angleDiff(a.legYaw + opening + side * 0.06, f.liftYaw) * e
    f.pitch = -0.4 * Math.sin(Math.PI * u) + (a.back ? -0.16 : 0.12) * smooth((u - 0.7) / 0.3)
    if (u === 1) {
      f.planted = true; f.p[1] = 0; f.pitch = 0
      lockToe(a, i)
      m.contacts[i] = 0; landed = true
    }
  }
  // Walking requests a step only with support. Running releases the support toe after the
  // other swing is committed; this flight is essential at the game's 6.3 m/s sprint speed.
  if (m.start === 0) {
    const errors = a.feet.map((f, i) => {
      const p = home(a, i, 0)
      return Math.hypot(f.p[0] - p[0], f.p[2] - p[2]) + Math.abs(angleDiff(f.yaw, a.legYaw)) * 0.25
    })
    const preferred = moving ? m.next : errors[0]! > errors[1]! ? 0 : 1
    const i = a.feet[preferred]!.planted ? preferred : 1 - preferred
    const other = 1 - i
    const supported = a.feet[other]!.planted || gait.run > 0.5 && m.swings[other]! > 0.35
    const centre = home(a, i, 0), foot = a.feet[i]!
    const behind = ((centre[0] - foot.p[0]) * a.svx + (centre[2] - foot.p[2]) * a.svy) / Math.max(speed, 0.1)
    // An ahead-of-root contact is supporting the next step, not asking for another one.
    const urgent = travelling ? behind > 0.26 : errors[i]! > 0.22
    if (a.feet[i]!.planted && supported && (urgent || moving && m.stepDebt >= 1) && m.contacts[i]! >= 0.04) {
      const f = a.feet[i]!
      f.planted = false; f.lift = [...f.p]; f.liftYaw = f.yaw
      m.targets[i] = home(a, i, moving ? 0.15 : 0)
      m.swings[i] = 0
      // Shorter/faster lead-follow shuffle, slower backpedal. Do not reset the wheel at transition.
      const cadence = Math.max(0.95, speed / gait.stride)
      m.durations[i] = moving ? clamp((1 - gait.duty) / cadence * (a.back ? 1.12 : 1 - strafe * 0.12), 0.11, 0.22 + gait.run * 0.08) : 0.19
      m.next = 1 - i; m.stepDebt = Math.max(0, m.stepDebt - 1)
    }
  }
  const midYaw = a.feet[0].yaw + angleDiff(a.feet[1].yaw, a.feet[0].yaw) * 0.5
  angleSpring(m.pelvis, a.aim + clamp(angleDiff(midYaw, a.aim), -1.05, 1.05), animation.bodyHz, dt)
  m.pelvis.x = a.aim + clamp(angleDiff(m.pelvis.x, a.aim), -1.05, 1.05)
  const dx = a.feet[1].p[0] - a.feet[0].p[0], dz = a.feet[1].p[2] - a.feet[0].p[2]
  const twist = clamp((dx * Math.cos(a.legYaw) + dz * Math.sin(a.legYaw)) * 0.32, -0.17, 0.17)
  const support = a.feet[0].planted === a.feet[1].planted ? 0 : a.feet[0].planted ? -1 : 1
  const theta = TAU * (a.phase - a.duty / 2)
  const k = stiffness(animation.bodyHz)
  stepSpring(m.twist, k, 0.85, dt, twist * animation.twistScale)
  stepSpring(m.sway, k, 0.85, dt, support * (0.055 - gait.run * 0.02) * animation.swayScale)
  stepSpring(m.drop, k, 0.85, dt, -support * 0.087 * animation.swayScale)
  stepSpring(m.bob, k, 0.85, dt, (1 - 2 * gait.run) * 0.035 * Math.cos(theta * 2) * a.gait)
  const lean = (v: number, accel: number) => clamp((v * 0.025 + accel * 0.007) * animation.leanScale, -0.22, 0.22)
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
  return [a.x - a.leanX.x * 0.6 - s * m.sway.x + a.hitX.x * 0.5,
    HIP - (0.04 + m.run * 0.02) * a.gait + m.bob.x + a.dip.x - Math.hypot(a.leanX.x, a.leanY.x) ** 2 * 0.3,
    a.y - a.leanY.x * 0.6 + c * m.sway.x + a.hitY.x * 0.5]
}
