import { SPEED, type Gun } from "../../shared/config"
import { angleDiff } from "../../shared/geom"
import { HIP, SHOULDER } from "../render/person"

type Rgb3 = [number, number, number]

/** Registered model ids for the soldier's parts (see src/render/person.ts). */
export type PartModels = { legL: number; legR: number; torso: number; arms: Record<Gun, number>; whole: Record<Gun, number> }

/** Pushes one instanced part: model, position, yaw, team tint, pitch, roll, hit flash, alpha. */
export type PushPart = (model: number, x: number, y: number, z: number, yaw: number, tint: Rgb3, pitch: number, roll: number, flash: number, alpha?: number) => void

/** A body where someone died, falling away from the shot direction (dx, dy). t0 is seconds. */
export type Corpse = { id: string; x: number; y: number; dx: number; dy: number; t0: number; gun: Gun }

/** Animation state for one soldier on screen. */
export type Avatar = {
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
  legYaw: number
  phase: number
  kick: number
  flash: number
  reloadAt: number
  reloadFor: number
  gun: Gun
  alive: boolean
  stepAt: number
}

const WALK_STRIDE = 3.9

export function newAvatar(id: string, x: number, y: number, aim: number, gun: Gun): Avatar {
  return { id, x, y, vx: 0, vy: 0, tx: x, ty: y, tvx: 0, tvy: 0, aim, legYaw: aim, phase: 0, kick: 0, flash: 0, reloadAt: -10, reloadFor: 0, gun, alive: false, stepAt: 0 }
}

/** Advances one soldier's animation state. Returns true on a footfall. */
export function animate(a: Avatar, dt: number, x: number, y: number, vx: number, vy: number, aim: number): boolean {
  a.x = x
  a.y = y
  a.vx = vx
  a.vy = vy
  a.aim = aim
  const speed = Math.hypot(vx, vy)
  const k = Math.min(1, speed / SPEED)
  a.phase += speed * dt * WALK_STRIDE
  let want = aim
  if (speed > 0.3) {
    want = Math.atan2(vy, vx)
    // Backpedalling: legs face the aim and walk backwards rather than spinning round.
    if (Math.abs(angleDiff(want, aim)) > Math.PI * 0.6) want += Math.PI
  }
  a.legYaw += angleDiff(want, a.legYaw) * Math.min(1, dt * 14)
  a.kick *= Math.exp(-dt * 13)
  a.flash *= Math.exp(-dt * 14)
  if (k > 0.3 && a.phase - a.stepAt > Math.PI) {
    a.stepAt = a.phase
    return true
  }
  return false
}

/** Pushes the parts of one soldier in its current pose. `now` is seconds, matching reloadAt. */
export function pose(push: PushPart, a: Avatar, color: Rgb3, models: PartModels, now: number): void {
  const speed = Math.hypot(a.vx, a.vy)
  const k = Math.min(1, speed / SPEED)
  const backwards = Math.abs(angleDiff(a.legYaw, Math.atan2(a.vy, a.vx))) > Math.PI / 2 && speed > 0.3
  const swing = Math.sin(a.phase) * 0.62 * k * (backwards ? -1 : 1)
  const bob = Math.abs(Math.sin(a.phase)) * 0.05 * k
  const ca = Math.cos(a.aim)
  const sa = Math.sin(a.aim)
  const fwd = (a.vx * ca + a.vy * sa) / SPEED
  const side = (-a.vx * sa + a.vy * ca) / SPEED
  const hip = HIP + bob
  push(models.legL, a.x, hip, a.y, a.legYaw, color, swing, 0, a.flash)
  push(models.legR, a.x, hip, a.y, a.legYaw, color, -swing, 0, a.flash)
  const lean = -fwd * 0.1 - a.kick * 0.07
  const roll = side * 0.1
  push(models.torso, a.x, hip - 0.02, a.y, a.aim, color, lean, roll, a.flash)
  // Arms: recoil pushes them back and tips the muzzle up; reloading dips the gun.
  let rp = a.kick * 0.32
  let rr = 0
  const rt = (now - a.reloadAt) / Math.max(0.01, a.reloadFor)
  if (rt >= 0 && rt < 1) {
    const dip = Math.sin(rt * Math.PI)
    rp -= dip * 0.75
    rr = dip * 0.5
  }
  const back = a.kick * 0.14
  const sx = a.x - ca * back - sa * roll * 0.1
  const sz = a.y - sa * back + ca * roll * 0.1
  push(models.arms[a.gun], sx, SHOULDER + bob - 0.02 + Math.sin(lean) * 0.4, sz, a.aim, color, rp + lean, rr + roll, a.flash)
}

/** Pushes a corpse in its death pose. Returns false once it has faded and can be dropped. */
export function corpsePose(push: PushPart, c: Corpse, color: Rgb3, models: PartModels, now: number): boolean {
  const age = now - c.t0
  const f = Math.min(1, age / 0.38)
  const ease = f * f
  const slide = (1 - (1 - f) * (1 - f)) * 0.6
  const fade = Math.max(0, Math.min(1, 1 - (age - 2.2) / 0.6))
  if (fade <= 0) return false
  const bounce = f >= 1 ? Math.max(0, Math.sin((age - 0.38) * 18) * 0.06 * Math.exp(-(age - 0.38) * 10)) : 0
  const dim: Rgb3 = [color[0] * 0.5, color[1] * 0.5, color[2] * 0.5]
  push(models.whole[c.gun], c.x + c.dx * slide, 0.16 * ease + bounce, c.y + c.dy * slide, Math.atan2(-c.dy, -c.dx), dim, (Math.PI / 2) * ease, 0, 0, fade)
  return true
}
