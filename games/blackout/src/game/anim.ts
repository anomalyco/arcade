import { SPEED, type Gun } from "../../shared/config"
import { angleDiff } from "../../shared/geom"
import { Rng, seedOf } from "../../shared/rng"
import { GUNPTS, HIP, HOLD, RIG } from "../render/person"
import { animation } from "./anim-settings"
import { angleSpring, locomotion, newMotion, pelvisPoint, stiffness } from "./anim-locomotion"
import { bodyJoints } from "./anim-pose"
import { profileHands, profileTorso, type HumanProfile } from "@arcade/kit/human-profile"
import { boneVisible, jointVelocities, poseArms, poseLegs, type BoneId, type HumanBody, type HiddenBones } from "@arcade/kit/human-pose"
import {
  type Frame,
  type PushPart,
  type Spring,
  type V3,
  at,
  clamp,
  dirIn,
  emit,
  ik,
  kick,
  lerp3,
  limb,
  moved,
  pitch,
  roll,
  smooth,
  smoother,
  spring,
  stepSpring,
  yawFrame,
} from "./rig"

export type { PushPart } from "./rig"
type Rgb3 = readonly [number, number, number]

/** Registered model ids for the soldier's parts (see src/render/person.ts). */
export type PartModels = {
  pelvis: number
  torso: number
  head: number
  upperArm: number
  foreArm: number
  thigh: number
  shin: number
  foot: number
  pump: number
  gun: Record<Gun, number>
  mag: Record<Gun, number>
  casing: Record<Gun, number>
  hole: number
}

/** Animation cues returned by animate(), for sounds and effects synced to the motion. */
export const EV = {
  step: 1,
  eject: 2,
  magDrop: 4,
  magOut: 8,
  magIn: 16,
  charge: 32,
  pumpBack: 64,
  pumpFwd: 128,
  boltOpen: 256,
  boltClose: 512,
  shellIn: 1024,
  raise: 2048,
  grab: 4096,
} as const

/** Every posed part of one soldier, as world frames. */
export type Body = HumanBody & {
  /** Joint velocities from consecutive presentation frames; never networked. */
  velocities?: V3[]
  gun: Frame | null
  pump: Frame | null
  mag: Frame | null
}

type Foot = { p: V3; yaw: number; pitch: number; planted: boolean; lift: V3; liftYaw: number }

/** Animation state for one soldier on screen. */
export type Avatar = {
  /** Per-actor presentation override. Omit to follow the Lab's soldier defaults. */
  profile?: HumanProfile
  hiddenBones?: Set<BoneId>
  id: string
  x: number
  y: number
  vx: number
  vy: number
  /** Server position and velocity the smoothed values chase. */
  tx: number
  ty: number
  tvx: number
  tvy: number
  aim: number
  gun: Gun
  alive: boolean
  /** Hit flash, 0..1. */
  flash: number
  reloadAt: number
  reloadFor: number
  // Locomotion.
  t: number
  seed: number
  rng: Rng
  motion: ReturnType<typeof newMotion>
  svx: number
  svy: number
  acx: number
  acy: number
  aimVel: number
  legYaw: number
  turning: boolean
  back: boolean
  phase: number
  duty: number
  gait: number
  /** 0..1 blend into the sprint: longer stride, deeper lean, gun down across the chest. */
  sprint: number
  feet: [Foot, Foot]
  leanX: Spring
  leanY: Spring
  dip: Spring
  // Weapon.
  prevGun: Gun | null
  raiseAt: number
  firedAt: number
  cycleAt: number
  heat: number
  recBack: Spring
  recPitch: Spring
  recYaw: Spring
  recRoll: Spring
  torsoKick: Spring
  hitX: Spring
  hitY: Spring
  hitTwist: Spring
  /** Previous clip times, for firing cues once. */
  clipPrev: { reload: number; cycle: number }
  /** Pose from the last animate(). */
  body: Body | null
  /** Where the right hand is moving, for dropped magazines. */
  handVel: V3
  /** Last frag throw and claymore plant, on the animation clock. */
  throwAt: number
  plantAt: number
  /** No gun, just hands (infected claws, the gun game knife); and the last melee swing, on the animation clock. */
  bare: boolean
  /** Slower, readable wind-up for the skeleton's rake. */
  shambler?: boolean
  swingAt: number
}

export function newAvatar(id: string, x: number, y: number, aim: number, gun: Gun): Avatar {
  const seed = seedOf(id)
  const foot = (side: number): Foot => {
    const p: V3 = [x + Math.cos(aim + side * 1.2) * 0.15, 0, y + Math.sin(aim + side * 1.2) * 0.15]
    return { p, yaw: aim, pitch: 0, planted: true, lift: [...p], liftYaw: aim }
  }
  return {
    id,
    x,
    y,
    vx: 0,
    vy: 0,
    tx: x,
    ty: y,
    tvx: 0,
    tvy: 0,
    aim,
    gun,
    alive: false,
    flash: 0,
    reloadAt: -10,
    reloadFor: 1,
    t: 0,
    seed: seed / 4294967296 * 100,
    rng: new Rng(seed),
    motion: newMotion(x, y, aim),
    svx: 0,
    svy: 0,
    acx: 0,
    acy: 0,
    aimVel: 0,
    legYaw: aim,
    turning: false,
    back: false,
    phase: 0,
    duty: 0.6,
    gait: 0,
    sprint: 0,
    feet: [foot(-1), foot(1)],
    leanX: spring(),
    leanY: spring(),
    dip: spring(),
    prevGun: null,
    raiseAt: -10,
    firedAt: -10,
    cycleAt: -10,
    heat: 0,
    recBack: spring(),
    recPitch: spring(),
    recYaw: spring(),
    recRoll: spring(),
    torsoKick: spring(),
    hitX: spring(),
    hitY: spring(),
    hitTwist: spring(),
    clipPrev: { reload: 2, cycle: 2 },
    body: null,
    handVel: [0, 0, 0],
    throwAt: -10,
    plantAt: -10,
    bare: false,
    swingAt: -10,
  }
}

// Weapon handling profiles ------------------------------------------------------------------------------------------

type Recoil = { back: number; pitch: number; yaw: number; roll: number; torso: number; k: number; z: number; heat: number }
const RECOIL: Record<Gun, Recoil> = {
  rifle: { back: 0.05, pitch: 0.11, yaw: 0.05, roll: 0.08, torso: 0.035, k: 1300, z: 0.42, heat: 0.14 },
  shotgun: { back: 0.13, pitch: 0.42, yaw: 0.05, roll: 0.12, torso: 0.13, k: 420, z: 0.4, heat: 0 },
  sniper: { back: 0.15, pitch: 0.4, yaw: 0.03, roll: 0.06, torso: 0.15, k: 380, z: 0.4, heat: 0 },
}
/** Bladed stance: how far the torso turns right of the aim so the left shoulder leads. */
const BLADE: Record<Gun, number> = { rifle: 0.42, shotgun: 0.36, sniper: 0.5 }
/** Pump or bolt cycle after a shot: delay and length, seconds. */
const CYCLE: Record<Gun, { delay: number; dur: number } | null> = {
  rifle: null,
  shotgun: { delay: 0.12, dur: 0.44 },
  sniper: { delay: 0.24, dur: 0.66 },
}
const RAISE = 0.42

/** A shot: snaps the gun back and up, the shoulders back, and starts the pump or bolt cycle. */
export function fire(a: Avatar, now: number): void {
  const r = RECOIL[a.gun]
  const scale = animation.animationMode === "new" ? animation.recoilScale : 1
  const j = () => random(a) * 2 - 1
  kick(a.recBack, scale * r.back * (0.9 + random(a) * 0.2), r.k)
  kick(a.recPitch, scale * r.pitch * (0.8 + random(a) * 0.4) * (1 + a.heat * 0.4), r.k)
  kick(a.recYaw, scale * j() * r.yaw * (1 + a.heat), r.k)
  kick(a.recRoll, scale * j() * r.roll, r.k)
  kick(a.torsoKick, scale * r.torso, 260)
  a.heat = Math.min(1, a.heat + r.heat)
  a.firedAt = now
  const c = CYCLE[a.gun]
  if (c) a.cycleAt = now + c.delay
}

/** Throwing a frag (an overarm whip with the free hand) or planting a claymore (a dip and a reach to the floor). */
export function useGear(a: Avatar, now: number, plant: boolean): void {
  if (plant) {
    a.plantAt = now
    kick(a.dip, -0.22, 120)
  } else {
    a.throwAt = now
    kick(a.torsoKick, -0.08, 200)
  }
}
const THROW = 0.42
const PLANT = 0.55

/** A melee swing: wind-up (matching the server's), strike, recovery, seconds overall. */
export function swing(a: Avatar, now: number): void {
  a.swingAt = now
}
const SWING = 0.4
const WINDUP = 0.15 / SWING
const STRIKE = 0.6

function random(a: Avatar): number {
  return a.rng.next()
}

/** Where a swing is: how far into the wind-up (0..1), the strike (0..1) and the recovery (1 back to 0), and the torso twist. */
function swingPhase(a: Avatar, now: number): { wind: number; strike: number; back: number; twist: number } | null {
  const duration = a.shambler ? 0.65 : SWING
  const windup = a.shambler ? 0.23 / duration : WINDUP
  const contact = a.shambler ? 0.35 / duration : STRIKE
  const u = (now - a.swingAt) / duration
  if (u < 0 || u >= 1) return null
  const wind = smooth(Math.min(1, u / windup))
  const strike = u < windup ? 0 : smooth(Math.min(1, (u - windup) / (contact - windup)))
  const back = u < contact ? 1 : 1 - smooth((u - contact) / (1 - contact))
  return { wind, strike, back, twist: (0.45 * wind - 0.95 * strike) * back }
}

/** Taking a hit from direction (dx, dy): the body flinches away, the head snaps and the gun is knocked off line. */
export function hit(a: Avatar, dx: number, dy: number, power = 1): void {
  const l = Math.hypot(dx, dy) || 1
  kick(a.hitX, (dx / l) * 0.2 * power, 160)
  kick(a.hitY, (dy / l) * 0.2 * power, 160)
  const side = -dx * Math.sin(a.aim) + dy * Math.cos(a.aim)
  kick(a.hitTwist, (side < 0 ? -1 : 1) * 0.25 * power, 160)
  kick(a.recYaw, (random(a) - 0.5) * 0.25 * power, 600)
  kick(a.recPitch, -0.12 * power, 600)
  a.flash = 0.07
}

// Clips: keyframed hand paths for reloads, pumps and bolts ---------------------------------------------------------

/** Hand key space: 0 gun-local, 1 torso-local, 2 pelvis-local; "home" keys sit on the grip or fore-end. */
type Space = 0 | 1 | 2
type HandKey = [t: number, space: Space, x: number, y: number, z: number] | [t: number, home: "home"]
/** Gun offsets: pitch (muzzle up), roll, pull back, drop, and yaw across the body (positive swings the muzzle left). */
type GunKey = [t: number, pitch: number, roll: number, pull: number, drop: number, yaw?: number]
type Clip = {
  left?: HandKey[]
  right?: HandKey[]
  gun?: GunKey[]
  /** Shotgun pump travel, metres back. */
  pump?: [number, number][]
  /** Where the magazine is: gun, left hand, or nowhere. */
  mag?: [number, "gun" | "hand" | "none"][]
  head?: [number, number][]
  cues: [number, number][]
}

const H = "home" as const
const TILT: GunKey = [0, 0, 0, 0, 0]
const RELOAD: Record<Gun, Clip> = {
  rifle: {
    gun: [TILT, [0.1, -0.3, 0.75, 0.16, 0.1, 0.55], [0.56, -0.34, 0.8, 0.16, 0.11, 0.6], [0.62, -0.2, 0.65, 0.14, 0.09, 0.5], [0.72, -0.12, 0.35, 0.12, 0.06, 0.35], [0.84, -0.05, 0.15, 0.06, 0.03, 0.15], [1, 0, 0, 0, 0, 0]],
    left: [[0, H], [0.08, 0, 0.1, -0.09, 0], [0.16, 0, 0.1, -0.12, -0.01], [0.24, 0, 0.12, -0.25, -0.08], [0.34, 1, 0.22, 0.18, -0.2], [0.44, 1, 0.24, 0.18, -0.18], [0.54, 0, 0.11, -0.22, -0.02], [0.62, 0, 0.1, -0.1, 0], [0.7, 0, -0.03, 0.09, -0.07], [0.79, 0, -0.12, 0.1, -0.06], [0.9, H], [1, H]],
    mag: [[0, "gun"], [0.18, "none"], [0.42, "hand"], [0.61, "gun"]],
    head: [[0, 0], [0.12, 0.35], [0.85, 0.3], [1, 0]],
    cues: [[0.16, EV.magOut], [0.18, EV.magDrop], [0.38, EV.grab], [0.61, EV.magIn], [0.78, EV.charge]],
  },
  shotgun: {
    gun: [TILT, [0.1, -0.15, -0.9, 0.1, 0.1, 0.45], [0.78, -0.15, -0.9, 0.1, 0.1, 0.45], [0.86, -0.04, -0.2, 0.04, 0.03, 0.1], [1, 0, 0, 0, 0, 0]],
    left: [
      [0, H],
      ...[0, 1, 2, 3].flatMap((i): HandKey[] => {
        const s = 0.1 + i * 0.165
        return [
          [s, 2, 0.02, 0.0, -0.21],
          [s + 0.05, 2, 0.03, 0.02, -0.22],
          [s + 0.12, 0, 0.1, -0.07, 0.0],
          [s + 0.145, 0, 0.14, -0.05, 0.0],
        ]
      }),
      [0.84, H],
      [0.88, 0, GUNPTS.shotgun.fore - 0.12, -0.04, 0],
      [0.94, H],
      [1, H],
    ],
    mag: [[0, "none"], ...[0, 1, 2, 3].flatMap((i): [number, "hand" | "none"][] => [[0.1 + i * 0.165 + 0.04, "hand"], [0.1 + i * 0.165 + 0.14, "none"]])],
    pump: [[0, 0], [0.84, 0], [0.88, 0.12], [0.94, 0], [1, 0]],
    head: [[0, 0], [0.1, 0.32], [0.8, 0.32], [1, 0]],
    cues: [...[0, 1, 2, 3].map((i): [number, number] => [0.1 + i * 0.165 + 0.14, EV.shellIn]), [0.845, EV.pumpBack], [0.9, EV.pumpFwd]],
  },
  sniper: {
    gun: [TILT, [0.1, -0.18, -0.45, 0.1, 0.07, 0.3], [0.22, -0.22, 0.5, 0.12, 0.08, 0.4], [0.7, -0.24, 0.55, 0.12, 0.08, 0.45], [0.8, -0.1, -0.3, 0.08, 0.05, 0.2], [0.92, -0.03, -0.1, 0.02, 0.01, 0], [1, 0, 0, 0, 0, 0]],
    right: [[0, H], [0.08, 0, -0.01, 0.06, 0.09], [0.14, 0, -0.01, 0.1, 0.1], [0.2, 0, -0.13, 0.1, 0.1], [0.72, 0, -0.13, 0.1, 0.1], [0.8, 0, -0.01, 0.1, 0.1], [0.86, 0, -0.01, 0.06, 0.09], [0.94, H], [1, H]],
    left: [[0, H], [0.22, 0, 0.08, -0.08, 0], [0.28, 0, 0.1, -0.16, -0.04], [0.4, 1, 0.24, 0.22, -0.08], [0.48, 1, 0.24, 0.2, -0.06], [0.58, 0, 0.09, -0.16, 0], [0.64, 0, 0.08, -0.08, 0], [0.74, H], [1, H]],
    mag: [[0, "gun"], [0.26, "none"], [0.46, "hand"], [0.64, "gun"]],
    head: [[0, 0], [0.12, 0.3], [0.85, 0.25], [1, 0]],
    cues: [[0.13, EV.boltOpen], [0.2, EV.eject], [0.25, EV.magOut], [0.27, EV.magDrop], [0.44, EV.grab], [0.63, EV.magIn], [0.8, EV.boltClose]],
  },
}

const CYCLES: Record<Gun, Clip> = {
  rifle: { cues: [] },
  shotgun: {
    gun: [TILT, [0.3, -0.05, 0.08, 0.03, 0.01], [0.6, -0.03, 0.05, 0.02, 0.0], [1, 0, 0, 0, 0]],
    pump: [[0, 0], [0.38, 0.13], [0.52, 0.13], [0.86, 0], [1, 0]],
    cues: [[0.02, EV.pumpBack], [0.4, EV.eject], [0.6, EV.pumpFwd]],
  },
  sniper: {
    gun: [TILT, [0.2, -0.08, -0.4, 0.03, 0.03, 0.12], [0.75, -0.08, -0.4, 0.03, 0.03, 0.12], [1, 0, 0, 0, 0, 0]],
    right: [[0, H], [0.14, 0, -0.01, 0.07, 0.1], [0.22, 0, -0.01, 0.14, 0.11], [0.4, 0, -0.2, 0.14, 0.11], [0.52, 0, -0.2, 0.14, 0.11], [0.66, 0, -0.01, 0.14, 0.11], [0.74, 0, -0.01, 0.07, 0.1], [0.9, H], [1, H]],
    cues: [[0.22, EV.boltOpen], [0.44, EV.eject], [0.72, EV.boltClose]],
  },
}

function keyed<T extends readonly [number, ...unknown[]]>(keys: readonly T[], t: number): [T, T, number] {
  let i = 0
  while (i < keys.length - 1 && keys[i + 1]![0] <= t) i++
  const a = keys[i]!
  const b = keys[Math.min(i + 1, keys.length - 1)]!
  const span = b[0] - a[0]
  return [a, b, span > 0 ? smooth((t - a[0]) / span) : 1]
}

function scalarAt(keys: [number, number][] | undefined, t: number): number {
  if (!keys) return 0
  const [a, b, u] = keyed(keys, t)
  return a[1] + (b[1] - a[1]) * u
}

function cues(c: Clip, prev: number, t: number): number {
  let ev = 0
  for (const [at, e] of c.cues) if (prev < at && t >= at) ev |= e
  return ev
}

// Animate ----------------------------------------------------------------------------------------------------------

const frac = (v: number) => v - Math.floor(v)
const plan = (p: V3, x: number, z: number) => Math.hypot(p[0] - x, p[2] - z)

/** Where a foot rests relative to the body: a staggered, bladed stance when still, narrow tracks when running. */
function restOffset(i: number, gait: number): [number, number] {
  const side = i === 0 ? -1 : 1
  const idle: [number, number] = i === 0 ? [0.13, -0.15] : [-0.1, 0.16]
  return [idle[0] * (1 - gait), side * (0.12 * gait) + idle[1] * (1 - gait)]
}

/**
 * Advances one soldier's animation and poses it. `now` is seconds on the same clock as reloadAt and fire().
 * Returns EV cue bits for sounds and effects.
 */
export function animate(a: Avatar, dt: number, now: number, x: number, y: number, vx: number, vy: number, aim: number, wizard = false): number {
  let ev = 0
  dt = Math.max(1e-4, Math.min(0.05, dt))
  a.t += dt
  const enhanced = animation.animationMode === "new"
  const profile = a.profile ?? animation
  const distance = Math.hypot(x - a.x, y - a.y)
  const teleport = Math.hypot(x - a.x, y - a.y) > 2.5 || !a.body
  a.x = x
  a.y = y
  a.vx = vx
  a.vy = vy
  a.aimVel += (angleDiff(aim, a.aim) / dt - a.aimVel) * Math.min(1, dt * 12)
  a.aim = aim
  if (a.gun !== a.prevGun) {
    if (a.prevGun !== null || teleport) {
      a.raiseAt = now
      ev |= EV.raise
    }
    a.prevGun = a.gun
  }
  if (teleport) {
    a.raiseAt = now
    a.svx = vx
    a.svy = vy
    a.legYaw = aim + BLADE[a.gun] * 0.6
    for (let i = 0; i < 2; i++) {
      const [f, s] = restOffset(i, 0)
      const c = Math.cos(a.legYaw)
      const sn = Math.sin(a.legYaw)
      const ft = a.feet[i]!
      ft.p = [x + c * f - sn * s, 0, y + sn * f + c * s]
      ft.planted = true
      ft.yaw = a.legYaw
      ft.pitch = 0
    }
  }

  // Smoothed velocity and acceleration.
  const kv = 1 - Math.exp(-dt * 14)
  const nvx = a.svx + (vx - a.svx) * kv
  const nvy = a.svy + (vy - a.svy) * kv
  const ka = 1 - Math.exp(-dt * 10)
  a.acx += ((nvx - a.svx) / dt - a.acx) * ka
  a.acy += ((nvy - a.svy) / dt - a.acy) * ka
  a.svx = nvx
  a.svy = nvy
  const sp = Math.hypot(nvx, nvy)
  const k = clamp(sp / SPEED, 0, 1)
  a.gait += ((sp > 0.35 ? 1 : 0) - a.gait) * Math.min(1, dt * 6)
  // Only sprinters go faster than a walk (snapshots carry velocity, not the key). A shot drops it at once.
  const sprinting = sp > SPEED + 0.6 && now - a.firedAt > 0.25
  if (now - a.firedAt < 0.05) a.sprint = 0
  a.sprint += ((sprinting ? 1 : 0) - a.sprint) * Math.min(1, dt * 9)
  const s = smooth(a.sprint)

  if (enhanced) {
    if (locomotion(a, dt, distance, teleport)) ev |= EV.step
  } else {
    a.motion.enabled = false
    // Retained gait for the Lab's Old comparison.
    const blade = a.bare ? 0 : BLADE[a.gun]
    if (sp > 0.4) {
      a.turning = false
      let mv = Math.atan2(nvy, nvx)
      const dAim = Math.abs(angleDiff(mv, aim))
      if (a.back ? dAim < 1.72 : dAim > 2.05) a.back = !a.back
      if (a.back) mv += Math.PI
      const want = aim + clamp(angleDiff(mv, aim), -1.05, 1.05)
      a.legYaw += angleDiff(want, a.legYaw) * Math.min(1, dt * 9)
    } else {
      a.back = false
      const rest = aim + blade * 0.55
      const d = angleDiff(rest, a.legYaw)
      if (Math.abs(d) > 0.8) a.turning = true
      if (a.turning) {
        a.legYaw += d * Math.min(1, dt * 9)
        if (Math.abs(d) < 0.08) a.turning = false
      }
    }

    // Keep stepping while a foot is airborne or out of place, including turns on the spot.
    const strideLen = 0.7 + 0.22 * sp + 0.3 * s
    a.duty += ((0.62 - 0.22 * k - 0.06 * s) - a.duty) * Math.min(1, dt * 5)
    const duty = a.duty
    const cl = Math.cos(a.legYaw)
    const sl = Math.sin(a.legYaw)
    const rest = (i: number): [number, number] => {
      const [f, s] = restOffset(i, a.gait)
      return [x + cl * f - sl * s, y + sl * f + cl * s]
    }
    let rate = sp > 0.35 ? sp / strideLen : 0
    if (rate < 1.7) {
      const air = !a.feet[0].planted || !a.feet[1].planted
      let need = false
      for (let i = 0; i < 2; i++) {
        const f = a.feet[i]!
        const [rx, ry] = rest(i)
        if (plan(f.p, rx, ry) > 0.2 || Math.abs(angleDiff(f.yaw, a.legYaw)) > 0.55) need = true
      }
      if (air || need) rate = Math.max(rate, 1.7)
    }
    a.phase = frac(a.phase + rate * dt)
    for (let i = 0; i < 2; i++) {
      const f = a.feet[i]!
      const p = frac(a.phase + i * 0.5)
      const swing = rate > 0 && p >= duty
      if (swing) {
        if (f.planted) {
          f.planted = false
          f.lift = [f.p[0], 0, f.p[2]]
          f.liftYaw = f.yaw
        }
        const u = (p - duty) / (1 - duty)
        const left = (1 - p) / rate
        const stance = duty / rate
        const [rx, ry] = rest(i)
        const lead = left + stance * 0.5
        let tx = rx + nvx * lead
        let ty = ry + nvy * lead
        // Keep the swing foot on its own side of the planted one in aim space.
        const o = a.feet[1 - i]!
        const side = i === 0 ? -1 : 1
        const ca = Math.cos(aim)
        const sa = Math.sin(aim)
        const lat = (-(tx - o.p[0]) * sa + (ty - o.p[2]) * ca) * side
        if (lat < 0.16) {
          tx += -sa * side * (0.16 - lat)
          ty += ca * side * (0.16 - lat)
        }
        const e = smoother(u)
        f.p = [f.lift[0] + (tx - f.lift[0]) * e, Math.sin(Math.PI * u) * (0.06 + 0.09 * k + 0.07 * s), f.lift[2] + (ty - f.lift[2]) * e]
        f.yaw = f.liftYaw + angleDiff(a.legYaw + (i === 0 ? -0.12 : 0.12), f.liftYaw) * e
        f.pitch = -Math.sin(Math.PI * 2 * u) * (0.45 + 0.25 * s) * k
      } else if (!f.planted) {
        f.planted = true
        f.p = [f.p[0], 0, f.p[2]]
        f.pitch = 0
        ev |= EV.step
      }
    }

    const along = a.acx * nvx + a.acy * nvy
    const brake = along < 0 ? 0.0065 : -0.0025
    stepSpring(a.leanX, 90, 0.38, dt, nvx * 0.035 - a.acx * brake)
    stepSpring(a.leanY, 90, 0.38, dt, nvy * 0.035 - a.acy * brake)
    stepSpring(a.dip, 140, 0.35, dt, -Math.min(0.06, Math.hypot(a.acx, a.acy) * 0.0016))
  }
  if (!enhanced || now - a.firedAt >= animation.recoilHold / 60) {
    for (const s of [a.recBack, a.recPitch, a.recYaw, a.recRoll]) stepSpring(s, RECOIL[a.gun].k, RECOIL[a.gun].z, dt)
  }
  stepSpring(a.torsoKick, 260, 0.45, dt)
  stepSpring(a.hitX, 160, 0.35, dt)
  stepSpring(a.hitY, 160, 0.35, dt)
  stepSpring(a.hitTwist, 160, 0.35, dt)
  a.heat *= Math.exp(-dt * (now - a.firedAt < 0.2 ? 0.8 : 4))
  a.flash *= Math.exp(-dt * 22)
  if (enhanced) {
    angleSpring(a.motion.chest, aim + (a.bare || profile.handPose !== "weapon" ? 0 : BLADE[a.gun]) - a.motion.twist.x * 0.65, profile.chestHz, dt)
    angleSpring(a.motion.head, aim, profile.headHz, dt)
    const ergonomics = animation[`${a.gun}Ergonomics`]
    angleSpring(a.motion.weapon, aim, animation.weaponHz * ergonomics, dt)
    const c = Math.cos(a.motion.weapon.x), sn = Math.sin(a.motion.weapon.x), hold = HOLD[a.gun]
    const target = [a.x + c * hold.fwd - sn * hold.side, hold.up, a.y + sn * hold.fwd + c * hold.side]
    a.motion.gun.forEach((s, i) => stepSpring(s, stiffness(animation.weaponHz * ergonomics), 1, dt, target[i]!))
  }

  // Clips: reload first, then the pump or bolt cycle.
  let clip: Clip | null = null
  let ct = 0
  const rt = (now - a.reloadAt) / Math.max(0.01, a.reloadFor)
  if (rt >= 0 && rt < 1) {
    clip = RELOAD[a.gun]
    ct = rt
    ev |= cues(clip, a.clipPrev.reload, rt)
    a.clipPrev.reload = rt
  } else a.clipPrev.reload = rt < 0 ? -1 : 2
  const cyc = CYCLE[a.gun]
  if (!clip && cyc) {
    const c = (now - a.cycleAt) / cyc.dur
    if (c >= 0 && c < 1) {
      clip = CYCLES[a.gun]
      ct = c
      ev |= cues(clip, a.clipPrev.cycle, c)
      a.clipPrev.cycle = c
    } else a.clipPrev.cycle = c < 0 ? -1 : 2
  }

  const prevHand = a.body ? at(a.body.fa[0], 0, -RIG.fore, 0) : null
  const previous = enhanced && !teleport && a.body ? bodyJoints(a.body, a.gun) : null
  a.body = build(a, now, k, clip, ct, wizard)
  if (previous) a.body.velocities = jointVelocities(bodyJoints(a.body, a.gun), previous, dt)
  if (prevHand) {
    const h = at(a.body.fa[0], 0, -RIG.fore, 0)
    a.handVel = [(h[0] - prevHand[0]) / dt, (h[1] - prevHand[1]) / dt, (h[2] - prevHand[2]) / dt]
  }
  return ev
}

/** Builds the pose: pelvis over the feet, a twisting torso aiming the gun, IK arms on the gun and IK legs to the feet. */
function build(a: Avatar, now: number, k: number, clip: Clip | null, ct: number, wizard: boolean): Body {
  const enhanced = animation.animationMode === "new"
  const profile = a.profile ?? animation
  const m = a.motion
  const t = a.t
  const g = a.gun
  const duty = a.duty
  const th = Math.PI * 2 * (a.phase - duty / 2)
  const moving = a.gait * k
  const still = 1 - a.gait
  // Sprint pose, eased off while a clip (reload, pump) needs the hands.
  const sprint = smooth(a.sprint)
  const port = sprint * (clip ? 0.35 : 1)
  const breath = Math.sin(t * 1.7 + a.seed)
  const speed = Math.max(0.1, Math.hypot(a.svx, a.svy))
  const postureX = enhanced ? m.posture.x * a.svx / speed : 0
  const postureY = enhanced ? m.posture.x * a.svy / speed : 0

  // Pelvis: low and bobbing when running, swaying its weight when standing, kept within reach of both feet.
  const legLen = RIG.thigh + RIG.shin - 0.015
  let h = HIP - 0.05 * moving - 0.035 * moving * Math.cos(2 * th) - 0.03 * sprint * Math.cos(2 * th) + a.dip.x + breath * 0.004 * still
  const sway = Math.sin(t * 0.55 + a.seed) * 0.025 * still
  const cl = Math.cos(a.legYaw)
  const sl = Math.sin(a.legYaw)
  const px = a.x - sl * sway + a.hitX.x * 0.5
  const pz = a.y + cl * sway + a.hitY.x * 0.5
  for (let i = 0; !enhanced && i < 2; i++) {
    const f = a.feet[i]!
    const side = i === 0 ? -1 : 1
    const hx = px - sl * side * RIG.hipW
    const hz = pz + cl * side * RIG.hipW
    const d = Math.hypot(f.p[0] - hx, f.p[2] - hz)
    const reach = Math.sqrt(Math.max(0, legLen * legLen - d * d)) + RIG.ankle + f.p[1]
    h = Math.min(h, reach)
  }
  const twist = -Math.sin(th) * (0.22 + 0.12 * sprint) * moving
  let pelvis = yawFrame([px, h, pz], a.legYaw + twist)
  pelvis = pitch(pelvis, -0.12 * moving - 0.05)
  pelvis = roll(pelvis, 0.06 * moving * Math.cos(th) + sway * 1.4)
  if (enhanced) {
    pelvis = yawFrame(pelvisPoint(a), a.aim + clamp(angleDiff(m.pelvis.x + m.twist.x, a.aim), -1.05, 1.05))
    pelvis = roll(pelvis, m.drop.x)
    // Pitch after the support roll, about the hip-to-hip axis: hip joint positions and
    // both leg reaches remain identical. The waist, shoulders and head lean together.
    pelvis = pitch(pelvis, -0.7 * (postureX * Math.cos(a.legYaw) + postureY * Math.sin(a.legYaw)))
  }

  // Lean in the torso's own axes: travel lean and hit pushes come in plan space.
  const ca = Math.cos(a.aim)
  const sa = Math.sin(a.aim)
  const lx = a.leanX.x + a.hitX.x * 1.4 + postureX
  const ly = a.leanY.x + a.hitY.x * 1.4 + postureY
  const leanFwd = lx * ca + ly * sa
  const leanSide = -lx * sa + ly * ca
  let gunPitch = 0
  let gunRoll = 0
  let gunPull = 0
  let gunDrop = 0
  let gunYaw = 0
  if (clip?.gun) {
    const [k0, k1, u] = keyed(clip.gun, ct)
    gunPitch = k0[1] + (k1[1] - k0[1]) * u
    gunRoll = k0[2] + (k1[2] - k0[2]) * u
    gunPull = k0[3] + (k1[3] - k0[3]) * u
    gunDrop = k0[4] + (k1[4] - k0[4]) * u
    gunYaw = (k0[5] ?? 0) + ((k1[5] ?? 0) - (k0[5] ?? 0)) * u
  }
  const rs = (now - a.raiseAt) / RAISE
  const raise = rs >= 0 && rs < 1 ? 1 - smoother(rs) : 0
  const look = scalarAt(clip?.head, ct)
  const reloadHunch = clip?.head ? look * 0.25 : 0

  // Sprinting squares the chest up to the run and carries the gun with it.
  const run = angleDiff(a.legYaw, a.aim) * port * 0.7
  const sw = swingPhase(a, now)
  const torsoYaw = (sw?.twist ?? 0) + (enhanced ? m.chest.x : a.aim + run + (a.bare ? 0 : BLADE[g]) * (1 - 0.4 * port) + Math.sin(th) * (0.12 + 0.1 * sprint) * moving) + a.hitTwist.x + a.recYaw.x * 0.4
  const waist = at(pelvis, 0, RIG.waist, 0)
  let torso = yawFrame(waist, torsoYaw)
  // Pitch and roll by the lean measured along the aim (the torso is bladed, so convert).
  const tb = torsoYaw - a.aim
  const fwd = (a.bare ? 0.2 : 0) + (enhanced ? 0.06 + leanFwd : 0.1 + 0.08 * moving + 0.2 * sprint + leanFwd * 2.2) - a.torsoKick.x + breath * 0.012 * still + reloadHunch + raise * 0.1
  const side = leanSide * (enhanced ? 1 : 2.2) + Math.sin(2 * th) * 0.02 * moving
  torso = pitch(torso, -(fwd * Math.cos(tb) + side * Math.sin(tb)))
  torso = roll(torso, side * Math.cos(tb) - fwd * Math.sin(tb) * 0.4)
  if (enhanced) torso = profileTorso(torso, profile)

  // Gun: hung off the shoulder line along the exact aim, then recoil, sway, clip tilt and the raise.
  const staff = wizard && g === "rifle"
  const hold = staff ? { fwd: 0.2, up: 1.12, side: 0.27 } : HOLD[g]
  // Port arms: muzzle swung left across the chest, down and pulled in.
  gunYaw += 0.75 * port
  gunPitch -= 0.4 * port
  gunRoll += 0.35 * port
  gunPull += 0.1 * port
  gunDrop += 0.12 * port
  const gy = enhanced ? m.weapon.x : a.aim + run
  const ga = Math.cos(gy)
  const gs = Math.sin(gy)
  const shoulderC = at(torso, 0, RIG.shoulderY, 0)
  const rest = HIP + RIG.waist + RIG.shoulderY
  const sway2 = still * 0.012
  const yaw =
    gy +
    a.recYaw.x +
    Math.sin(t * 0.9 + a.seed) * sway2 +
    Math.sin(th) * 0.03 * moving +
    a.heat * 0.035 * Math.sin(t * 41 + a.seed) +
    a.hitTwist.x * 0.3 -
    gunYaw
  let gunF = yawFrame([shoulderC[0] + ga * hold.fwd - gs * hold.side, shoulderC[1] + hold.up - rest - gunDrop - raise * 0.22, shoulderC[2] + gs * hold.fwd + ga * hold.side], yaw)
  if (enhanced) gunF = moved(gunF, [m.gun[0].x, m.gun[1].x - gunDrop - raise * 0.22, m.gun[2].x])
  gunF = pitch(gunF, a.recPitch.x + gunPitch - raise * 0.95 + Math.sin(t * 1.3 + a.seed) * sway2 + Math.sin(2 * th) * (enhanced ? 0.008 : 0.025 + 0.05 * sprint) * moving + a.heat * 0.03 * Math.sin(t * 53))
  gunF = roll(gunF, a.recRoll.x + gunRoll + clamp(-a.aimVel * 0.03, -0.3, 0.3) + raise * 0.5)
  // A swing with a gun in hand: a bash, the gun driven forward.
  const bash = sw && !a.bare ? Math.sin(Math.PI * sw.strike) * sw.back : 0
  gunF = moved(gunF, at(gunF, -a.recBack.x - gunPull - raise * 0.12 + bash * 0.3, 0, 0))

  // Hands.
  const pumpBack = g === "shotgun" ? scalarAt(clip?.pump, ct) : 0
  const pts = GUNPTS[g]
  const home = (right: boolean): V3 => (right ? at(gunF, 0, -0.035, 0) : staff ? at(torso, 0.3, 0.23, -0.25) : at(gunF, pts.fore - pumpBack, -0.04, 0))
  const handAt = (keys: HandKey[] | undefined, right: boolean): V3 => {
    if (!keys) return home(right)
    const [k0, k1, u] = keyed(keys, ct)
    const pos = (key: HandKey): V3 => {
      if (key[1] === "home") return home(right)
      const [, sp, x, y, z] = key
      return at(sp === 0 ? gunF : sp === 1 ? torso : pelvis, x, y, z)
    }
    return lerp3(pos(k0), pos(k1), u)
  }
  let handL = handAt(clip?.left, false)
  let handR = handAt(clip?.right, true)
  const hands = enhanced ? profileHands(torso, profile) : null
  if (hands && !clip) [handL, handR] = hands
  if (a.bare) {
    // Arms out ahead, clawing; a swing raises the right hand behind the shoulder and rakes it across.
    const bob = Math.sin(t * 5 + a.seed) * 0.03
    handL = hands?.[0] ?? at(torso, 0.42, RIG.shoulderY - 0.1 + bob, -0.17)
    handR = hands?.[1] ?? at(torso, 0.42, RIG.shoulderY - 0.1 - bob, 0.17)
    if (sw) {
      const back = at(torso, -0.08, RIG.shoulderY + 0.22, 0.42)
      const end = at(torso, 0.5, RIG.shoulderY - 0.15, -0.25)
      handR = sw.strike > 0 ? (sw.back < 1 ? lerp3(handR, end, sw.back) : lerp3(back, end, sw.strike)) : lerp3(handR, back, sw.wind)
    }
  }
  // Gear: the free hand snaps up behind the shoulder, whips forward and comes back; or reaches down to plant.
  const tw = (now - a.throwAt) / THROW
  if (tw >= 0 && tw < 1) {
    const back = at(torso, -0.22, 0.66, -0.3)
    const out = at(torso, 0.52, 0.42, -0.1)
    handL = tw < 0.15 ? lerp3(handL, back, smooth(tw / 0.15)) : tw < 0.4 ? lerp3(back, out, smooth((tw - 0.15) / 0.25)) : lerp3(out, handL, smooth((tw - 0.4) / 0.6))
  }
  const pw = (now - a.plantAt) / PLANT
  if (pw >= 0 && pw < 1) {
    const down = at(torso, 0.45, -0.25, -0.12)
    handL = lerp3(handL, down, Math.sin(Math.PI * Math.min(1, pw * 1.3)))
  }

  const { ua, fa } = poseArms(torso, handL, handR)

  // Head follows the aim, looks down at the gun while reloading.
  let head = yawFrame(at(torso, 0.02, RIG.neckY, 0), a.aim + a.hitTwist.x * 1.6 + clamp(a.aimVel * 0.02, -0.25, 0.25))
  if (enhanced) head = yawFrame(at(torso, 0.02, RIG.neckY, 0), m.head.x + a.hitTwist.x)
  const headLean = fwd - (postureX * ca + postureY * sa)
  head = pitch(head, -0.1 - look * 1.1 - a.torsoKick.x * 0.6 - headLean * 0.3 + Math.sin(2 * th) * 0.03 * moving)
  head = roll(head, side * 0.5 - a.hitTwist.x * 0.5)
  if (enhanced) head = roll(head, clamp(profile.headTilt, -0.3, 0.3))

  // Legs.
  const legs = enhanced ? poseLegs(a, pelvis) : null
  const th2: Frame[] = legs?.th ?? []
  const sh2: Frame[] = legs?.sh ?? []
  const ft2: Frame[] = legs?.ft ?? []
  for (let i = 0; !enhanced && i < 2; i++) {
    const s = i === 0 ? -1 : 1
    const hip = at(pelvis, 0, 0, s * RIG.hipW)
    const f = a.feet[i]!
    const ankle: V3 = [f.p[0], f.p[1] + RIG.ankle, f.p[2]]
    const pole = dirIn(pelvis, 1, 0, s * 0.3)
    const [knee, ank] = ik(hip, ankle, RIG.thigh, RIG.shin, pole)
    th2.push(limb(hip, knee, pole, pelvis.x))
    sh2.push(limb(knee, ank, pole, pelvis.x))
    ft2.push(pitch(yawFrame(ank, f.yaw), f.pitch))
  }

  let mag: Frame | null = null
  const magState = clip?.mag ? keyed(clip.mag, ct)[0][1] : "gun"
  if (magState === "gun") mag = moved(gunF, at(gunF, pts.mag[0], pts.mag[1], pts.mag[2]))
  else if (magState === "hand") mag = moved(gunF, at(fa[0], 0, -RIG.fore - 0.02, 0))
  const pump = g === "shotgun" ? moved(gunF, at(gunF, pts.fore - pumpBack, 0.005, 0)) : null
  if (a.bare || enhanced && profile.handPose !== "weapon") return { pelvis, torso, head, ua, fa, th: [th2[0]!, th2[1]!], sh: [sh2[0]!, sh2[1]!], ft: [ft2[0]!, ft2[1]!], gun: null, pump: null, mag: null }
  return { pelvis, torso, head, ua, fa, th: [th2[0]!, th2[1]!], sh: [sh2[0]!, sh2[1]!], ft: [ft2[0]!, ft2[1]!], gun: gunF, pump, mag }
}

/** The team colour (sRGB-ish palette) as a linear glow, so accents stay saturated through tone mapping. */
export function glow(c: Rgb3, k = 1.5): [number, number, number] {
  return [c[0] ** 2.2 * k, c[1] ** 2.2 * k, c[2] ** 2.2 * k]
}

/** Pushes every part of a posed body. */
export function emitBody(push: PushPart, b: Body, gun: Gun, rgb: Rgb3, models: PartModels, flash: number, alpha = 1, hidden?: HiddenBones): void {
  const color = glow(rgb)
  if (boneVisible("pelvis", hidden)) emit(push, models.pelvis, b.pelvis, color, flash, alpha)
  if (boneVisible("torso", hidden)) emit(push, models.torso, b.torso, color, flash, alpha)
  if (boneVisible("head", hidden)) emit(push, models.head, b.head, color, flash, alpha)
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? "left" : "right"
    if (boneVisible(`${side}.upperArm`, hidden)) emit(push, models.upperArm, b.ua[i]!, color, flash, alpha)
    if (boneVisible(`${side}.foreArm`, hidden)) emit(push, models.foreArm, b.fa[i]!, color, flash, alpha)
    if (boneVisible(`${side}.thigh`, hidden)) emit(push, models.thigh, b.th[i]!, color, flash, alpha)
    if (boneVisible(`${side}.shin`, hidden)) emit(push, models.shin, b.sh[i]!, color, flash, alpha)
    if (boneVisible(`${side}.foot`, hidden)) emit(push, models.foot, b.ft[i]!, color, flash, alpha)
  }
  if (boneVisible("right.foreArm", hidden)) {
    if (b.gun) emit(push, models.gun[gun], b.gun, color, 0, alpha)
    if (b.pump) emit(push, models.pump, b.pump, color, 0, alpha)
    if (b.mag) emit(push, models.mag[gun], b.mag, color, 0, alpha)
  }
}

/** Pushes the parts of one living soldier in its current pose. */
export function pose(push: PushPart, a: Avatar, color: Rgb3, models: PartModels): void {
  if (a.body) emitBody(push, a.body, a.gun, color, models, a.flash, 1, a.hiddenBones)
}

/** World position of the muzzle, and the ejection port, from the last pose. */
export function gunPoints(a: Avatar): { muzzle: V3; port: V3; dir: V3; right: V3; magwell: V3 } | null {
  const g = a.body?.gun
  if (!g) return null
  const p = GUNPTS[a.gun]
  return { muzzle: at(g, p.muzzle, 0.03, 0), port: at(g, p.port[0], p.port[1], p.port[2]), dir: g.x, right: g.z, magwell: at(g, p.mag[0], p.mag[1] - 0.05, p.mag[2]) }
}
