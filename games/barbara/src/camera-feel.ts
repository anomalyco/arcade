import { HitStop, TraumaShake, smoothNoise1D } from "@arcade/kit/client/camera"
import type { Walk } from "@arcade/kit/client/walk"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { ThunderEvent } from "@arcade/kit/weather/storm"

/**
 * How the first-person camera moves on top of the shared walk (`Walk`, `WoodsCamera`): a little more head bob on the
 * real gait phase, a jolt when you land, a lean into strafes and turns, a small FOV push when you run, turning inertia,
 * your torch swinging on when you stop, and shake only when something happens (thunder arriving, a near strike, the
 * creature crossing in front of you, being taken, striking a flare), with the kit's `TraumaShake` and `HitStop`. Also
 * the fear that drives your heartbeat. All presentation: aim, movement and the sim never change.
 */
export const CAMERA_FEEL = {
  /** Extra head bob on the gait phase (× about 1.2 cm walking, 2.2 cm running, peak to peak). */
  bob: 1,
  /** The head's nod at each heel strike (degrees). */
  nod: 0.2,
  /** A full jump's landing jolt (degrees of pitch). */
  landJolt: 1.4,
  /** Lean into a strafe at walking speed (degrees). */
  strafeLean: 0.7,
  /** Roll into a turn at 3 rad/s (degrees). */
  turnRoll: 0.6,
  /** Turning inertia: how far the view trails a turn (ms); 0 is locked to the mouse. */
  turnLag: 6,
  /** FOV push at a full run (degrees). */
  sprintFov: 4,
  /** Every event shake (×). */
  shake: 1,
  /** Shake at full trauma (degrees). */
  shakeMax: 1.6,
  /** Freeze the view for a beat at the creature and when you're taken. */
  hitStop: true,
  /** Motion blur on fast turns (× each camera look's own). */
  blur: 1,
  /** Your torch swings on when you stop or start (degrees for a walking stop). */
  handSway: 1.6,
  /** Your breath in the torch beam (× how often and how thick). */
  breath: 1,
  /** Leaves kicked up when you run (×). */
  kick: 1,
  /** How hard your heart reacts to the creature (×). */
  fear: 1,
}
export type CameraFeelSettings = typeof CAMERA_FEEL

const G = "Camera feel"
const range = (key: keyof CameraFeelSettings, label: string, sub: string, max: number, step: number, unit: string): LabControl => ({ key: `woods.feel.${key}`, field: key, label, group: G, subsection: sub, min: 0, max, step, unit })
export const CAMERA_FEEL_CONTROLS: LabControl[] = [
  range("bob", "Head bob (on the gait)", "Movement", 3, 0.05, "×"),
  range("nod", "Nod at heel strike", "Movement", 1, 0.01, "°"),
  range("landJolt", "Landing jolt", "Movement", 4, 0.05, "°"),
  range("strafeLean", "Lean into strafes", "Movement", 3, 0.05, "°"),
  range("turnRoll", "Roll into turns", "Movement", 3, 0.05, "°"),
  range("turnLag", "Turning inertia", "Movement", 40, 1, "ms"),
  range("sprintFov", "FOV push running", "Movement", 12, 0.25, "°"),
  range("handSway", "Torch swings when you stop", "Movement", 5, 0.05, "°"),
  range("shake", "Event shake", "Shake", 3, 0.05, "×"),
  range("shakeMax", "Shake at full trauma", "Shake", 5, 0.05, "°"),
  { key: "woods.feel.hitStop", field: "hitStop", label: "Freeze a beat (creature, taken)", group: G, subsection: "Shake", type: "toggle" },
  range("blur", "Motion blur on fast turns", "Blur", 3, 0.05, "× the look's"),
  range("breath", "Breath in the torch beam", "Details", 3, 0.05, "×"),
  range("kick", "Leaves kicked up running", "Details", 3, 0.05, "×"),
  range("fear", "Heartbeat near the creature", "Details", 3, 0.05, "×"),
]

type Spring = { x: number; v: number }
/** Exact critically damped step towards `target`, settling in about `duration` s (Kit's 2π/ω convention). */
function settle(s: Spring, target: number, dt: number, duration: number) {
  const w = (2 * Math.PI) / duration, e = Math.exp(-w * dt), d = s.x - target, c = s.v + w * d
  s.x = target + (d + c * dt) * e
  s.v = (s.v - w * c * dt) * e
}
/** Underdamped spring towards `target`, substepped. */
function swing(s: Spring, target: number, dt: number, omega: number, zeta: number) {
  for (let left = dt; left > 1e-6; left -= 1 / 240) {
    const h = Math.min(left, 1 / 240)
    s.v += (omega * omega * (target - s.x) - 2 * zeta * omega * s.v) * h
    s.x += s.v * h
  }
}
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x))
const DEG = Math.PI / 180

export type CameraFeelFrame = {
  dt: number
  walk: Walk
  /** Plan velocity (m/s) and the aim's yaw. */
  vx: number
  vz: number
  yaw: number
  /** Height above the ground from a jump (m). */
  rise: number
  walkSpeed: number
  reduced: boolean
  /** The camera look's own head bob (a chest rig bounces on its own): × the extra bob and nod. */
  bobScale: number
}

export class CameraFeel {
  readonly settings: CameraFeelSettings = { ...CAMERA_FEEL }
  /** Fast jolts (landing, the creature, a flare) and the slow rumble of thunder. */
  readonly jolt = new TraumaShake({ shakeScale: 1, reduceMotion: 0 })
  readonly rumble = new TraumaShake({ shakeScale: 1, reduceMotion: 0 })
  readonly hitStop = new HitStop()
  /** What this frame adds to the camera's mount (radians, degrees for fov) and the eye's height (m). */
  readonly out = { yaw: 0, pitch: 0, roll: 0, fov: 0, height: 0 }
  /** The torch's swing in the hand (radians: up, right). */
  readonly hand = { pitch: 0, yaw: 0 }
  /** 0 calm … 1 terrified: your heartbeat. Decays over about 15 s. */
  fear = 0
  private amp: Spring = { x: 0, v: 0 }
  private run: Spring = { x: 0, v: 0 }
  private lean: Spring = { x: 0, v: 0 }
  private fov: Spring = { x: 0, v: 0 }
  private land: Spring = { x: 0, v: 0 }
  private lagYaw: Spring = { x: 0, v: 0 }
  private swayP: Spring = { x: 0, v: 0 }
  private swayY: Spring = { x: 0, v: 0 }
  private lastYaw: number | null = null
  private lastFwd = 0
  private lastSide = 0
  private wasAirborne = false
  private fall = 0
  private lastRise = 0
  private thunder: ThunderEvent[] = []
  private time = 0
  /** Automation: the last frame's trauma and hit-stop, for proofs. */
  get trace() { return { jolt: this.jolt.trauma, rumble: this.rumble.trauma, stop: this.hitStop.remaining, fear: this.fear } }

  /** Presentation dt after any hit-stop (the view and the creature freeze a beat). */
  stopped(dt: number, reduced: boolean): number {
    return this.hitStop.step(dt, this.settings.hitStop && !reduced)
  }

  /** A jolt now, `amount` 0…1 of trauma (capped so repeats stay small). */
  kick(amount: number, cap = 1) { this.jolt.add(amount * this.settings.shake, cap) }

  /** Thunder emitted this frame: each rumbles when it arrives (storm clock), harder the nearer the strike. */
  storm(fresh: readonly ThunderEvent[], clock: number) {
    for (const e of fresh) this.thunder.push(e)
    for (let i = this.thunder.length - 1; i >= 0; i--) {
      const e = this.thunder[i]!
      if (e.arrives > clock) continue
      this.thunder.splice(i, 1)
      if (clock - e.arrives > 1) continue
      const near = clamp(400 / Math.max(1, e.distance), 0, 1.2)
      this.rumble.add(0.6 * near ** 0.8 * this.settings.shake, 0.9)
      if (e.distance < 600) this.jolt.add(0.35 * this.settings.shake * near, 0.6)
    }
  }

  /** The creature crossing `d` m away; `seen` when it crosses in front of where you look. */
  creature(d: number, seen: boolean) {
    const near = clamp(1 - (d - 40) / 90, 0, 1)
    this.fear = Math.min(1, this.fear + this.settings.fear * near * (seen ? 0.9 : 0.35))
    if (!seen) return
    this.jolt.add(0.3 * this.settings.shake, 0.5)
    this.hitStop.trigger(0.08, 0.2)
  }

  /** Something took you. */
  taken() {
    this.fear = 1
    this.jolt.raise(0.9 * Math.min(1, this.settings.shake))
    this.hitStop.trigger(0.12, 0.05)
  }

  /** A sound that shouldn't be (the uncanny tier) within earshot. */
  dread(amount: number) { this.fear = Math.min(1, this.fear + amount * this.settings.fear) }

  frame(f: CameraFeelFrame) {
    const s = this.settings, dt = clamp(f.dt, 0, 0.05), o = this.out
    this.time += dt
    if (dt <= 0) return
    const motion = f.reduced ? 0 : 1
    const sy = Math.sin(f.yaw), cy = Math.cos(f.yaw)
    // View frame: forward is −(sin, cos), right is (cos, −sin).
    const fwd = -f.vx * sy - f.vz * cy, side = f.vx * cy - f.vz * sy
    const speed = Math.hypot(f.vx, f.vz)
    const airborne = f.rise > 0.001
    // Head bob on the gait phase: highest at 0.275 of each step walking, 0.37 running (docs/animation.md).
    const runShare = clamp((speed - f.walkSpeed * 1.1) / (f.walkSpeed * 0.6), 0, 1)
    settle(this.amp, airborne ? this.amp.x : clamp(f.walk.speed / Math.max(0.5, f.walkSpeed), 0, 1.8), dt, 0.3)
    settle(this.run, runShare, dt, 0.4)
    const peak = 0.275 + 0.095 * this.run.x
    const phase = 2 * Math.PI * (f.walk.phase - peak)
    const bob = s.bob * f.bobScale * motion * this.amp.x * (0.006 + 0.005 * this.run.x)
    o.height = bob * Math.cos(phase)
    let pitch = -s.nod * DEG * f.bobScale * motion * Math.min(1, this.amp.x) * Math.max(0, Math.cos(2 * Math.PI * f.walk.phase)) ** 6
    // Landing: the head pitches down with the knees and comes back.
    if (airborne) this.fall = Math.max(this.fall, (this.lastRise - f.rise) / dt)
    if (this.wasAirborne && !airborne) {
      const impact = clamp(this.fall / 2.4, 0, 1)
      this.land.v -= s.landJolt * DEG * impact * motion * Math.E * (2 * Math.PI / 0.35)
      this.kick(0.12 * impact, 0.3)
      this.fall = 0
    }
    this.wasAirborne = airborne
    this.lastRise = f.rise
    settle(this.land, 0, dt, 0.35)
    pitch += this.land.x
    // Lean into strafes and turns.
    const turn = this.lastYaw === null ? 0 : clamp(Math.atan2(Math.sin(f.yaw - this.lastYaw), Math.cos(f.yaw - this.lastYaw)) / dt, -8, 8)
    this.lastYaw = f.yaw
    const leanTo = motion * (-(side / Math.max(0.5, f.walkSpeed)) * s.strafeLean * DEG - (turn / 3) * s.turnRoll * DEG)
    settle(this.lean, clamp(leanTo, -4 * DEG, 4 * DEG), dt, 0.25)
    // Turning inertia: the view trails the aim on a slightly loose spring, never far.
    // At a steady turn it trails by about 1.2 × lag × rate (6 ms at 3 rad/s ≈ 1.2°) and swings a touch past on a stop.
    if (s.turnLag > 0 && motion) {
      this.lagYaw.x = clamp(this.lagYaw.x - turn * dt, -2.5 * DEG, 2.5 * DEG)
      swing(this.lagYaw, 0, dt, 1000 / Math.max(s.turnLag, 3.5), 0.6)
    } else this.lagYaw.x = this.lagYaw.v = 0
    // A small FOV push at a run.
    settle(this.fov, motion * s.sprintFov * runShare, dt, 0.45)
    // Shake: two noise channels per source, trauma² (the kit's convention); none under reduced motion.
    this.jolt.decay(dt, 3.2)
    this.rumble.decay(dt, 0.9)
    this.jolt.tick(dt)
    this.rumble.tick(dt)
    const j = motion * this.jolt.intensity(), r = motion * this.rumble.intensity(), max = s.shakeMax * DEG
    const n = (t: number, seed: number) => smoothNoise1D(t, seed)
    const shY = max * (j * n(this.jolt.time * 16, 11) + r * n(this.rumble.time * 6, 41))
    const shP = max * (j * n(this.jolt.time * 16, 23) + r * n(this.rumble.time * 6, 53))
    const shR = max * 0.6 * (j * n(this.jolt.time * 13, 37) + r * n(this.rumble.time * 5, 67))
    o.yaw = this.lagYaw.x + shY
    o.pitch = pitch + shP
    o.roll = this.lean.x + shR
    o.fov = this.fov.x
    // The torch swings on in the hand when you stop or start (its momentum against the wrist), loosely sprung.
    const dFwd = fwd - this.lastFwd, dSide = side - this.lastSide
    this.lastFwd = fwd; this.lastSide = side
    const sway = s.handSway * DEG * (f.reduced ? 0.5 : 1)
    if (Math.abs(dFwd) < 3) this.swayP.v -= dFwd * sway * 4.4
    if (Math.abs(dSide) < 3) this.swayY.v += dSide * sway * 4.4
    swing(this.swayP, 0, dt, 9, 0.42)
    swing(this.swayY, 0, dt, 8, 0.45)
    this.hand.pitch = clamp(this.swayP.x, -6 * DEG, 6 * DEG)
    this.hand.yaw = clamp(this.swayY.x, -6 * DEG, 6 * DEG)
    this.fear *= Math.exp(-dt / 15)
  }

  reset() {
    for (const sp of [this.amp, this.run, this.lean, this.fov, this.land, this.lagYaw, this.swayP, this.swayY]) sp.x = sp.v = 0
    this.lastYaw = null
    this.jolt.reset(); this.rumble.reset(); this.hitStop.reset()
    Object.assign(this.out, { yaw: 0, pitch: 0, roll: 0, fov: 0, height: 0 })
    this.wasAirborne = false
  }
}
