import type { LabControl } from "@arcade/kit/lab-panel"
import { prefersReducedMotion, shakeWave } from "@arcade/kit/client/camera"
import type { Plane } from "../../shared/plane"
import { WEAPONS } from "../../shared/weapons"
import { SHAKE } from "../render/camera"

/**
 * How the flight camera and the screen answer the jet (typed settings on the dev panel's Flight tab, FEEL group): the
 * chase camera leaning into rolls and lagging hard turns, pulling in under g and kicked back by the catapult; the
 * cockpit head pushed down by g and lagging rolls; the gun's recoil and buzz, the missile and bomb release bumps; and
 * the g-load grey-out and red-out. Presentation only (the flight model never sees any of it). Live edits.
 */
export type FeelSettings = {
  /** Chase: extra roll into the jet's roll rate (degrees per rad/s), capped. */
  lean: number
  leanMax: number
  /** Chase: the camera falls behind pitch and yaw rates (degrees per rad/s), capped. */
  turnLag: number
  turnLagMax: number
  /** Chase: share of the distance pulled in at full g (`greyFull`). */
  gPull: number
  /** Chase: metres the catapult shot kicks the camera back. */
  catKick: number
  /** Cockpit: centimetres the head sinks per g above 1 (rises under negative g), capped at 9 g. */
  headG: number
  /** Cockpit: degrees the head lags the roll per rad/s. */
  headRoll: number
  /** Gun: recoil (cm per round burst) and vibration (degrees) while firing. */
  gunKick: number
  gunBuzz: number
  /** Missile and bomb release: the jet's bump up (m) and the camera's (m). */
  missileBump: number
  bombBump: number
  cameraBump: number
  /** Grey-out: starts at `greyOnset` g, full at `greyFull` g; builds over `greyIn` s, clears over `greyOut` s. */
  greyOnset: number
  greyFull: number
  greyIn: number
  greyOut: number
  /** Red-out: starts at `redOnset` g, full at `redFull` g (negative). */
  redOnset: number
  redFull: number
  /** Darkest the screen edges get (0..1). */
  vignette: number
}

export const FEEL_DEFAULTS: Readonly<FeelSettings> = {
  lean: 1.6,
  leanMax: 6,
  turnLag: 3,
  turnLagMax: 4,
  gPull: 0.14,
  catKick: 4,
  headG: 1.6,
  headRoll: 1.2,
  gunKick: 25,
  gunBuzz: 0.22,
  missileBump: 0.35,
  bombBump: 0.5,
  cameraBump: 0.35,
  greyOnset: 6.5,
  greyFull: 11,
  greyIn: 1.4,
  greyOut: 0.6,
  redOnset: -1.5,
  redFull: -4.5,
  vignette: 0.75,
}
export const FEEL: FeelSettings = { ...FEEL_DEFAULTS }

const G = "Flight feel"
export const FEEL_CONTROLS: LabControl[] = [
  { key: "lean", label: "Chase lean into rolls", group: G, min: 0, max: 5, step: 0.1, unit: "°/(rad/s)" },
  { key: "leanMax", label: "Chase lean max", group: G, min: 0, max: 15, step: 0.5, unit: "°" },
  { key: "turnLag", label: "Chase turn lag", group: G, min: 0, max: 8, step: 0.1, unit: "°/(rad/s)" },
  { key: "turnLagMax", label: "Chase turn lag max", group: G, min: 0, max: 10, step: 0.5, unit: "°" },
  { key: "gPull", label: "Chase pull-in at full g", group: G, min: 0, max: 0.4, step: 0.01, unit: "×" },
  { key: "catKick", label: "Catapult kick back", group: G, min: 0, max: 12, step: 0.5, unit: "m" },
  { key: "headG", label: "Cockpit head sink per g", group: G, min: 0, max: 4, step: 0.1, unit: "cm" },
  { key: "headRoll", label: "Cockpit head roll lag", group: G, min: 0, max: 4, step: 0.1, unit: "°/(rad/s)" },
  { key: "gunKick", label: "Gun recoil", group: G, min: 0, max: 80, step: 1, unit: "cm" },
  { key: "gunBuzz", label: "Gun vibration", group: G, min: 0, max: 1, step: 0.01, unit: "°" },
  { key: "missileBump", label: "Missile release bump", group: G, min: 0, max: 1.5, step: 0.05, unit: "m" },
  { key: "bombBump", label: "Bomb release bump", group: G, min: 0, max: 1.5, step: 0.05, unit: "m" },
  { key: "cameraBump", label: "Camera bump on release", group: G, min: 0, max: 1.5, step: 0.05, unit: "m" },
  { key: "greyOnset", label: "Grey-out onset", group: G, min: 3, max: 12, step: 0.5, unit: "g" },
  { key: "greyFull", label: "Grey-out full", group: G, min: 5, max: 16, step: 0.5, unit: "g" },
  { key: "greyIn", label: "Grey-out builds over", group: G, min: 0.1, max: 4, step: 0.1, unit: "s" },
  { key: "greyOut", label: "Grey-out clears over", group: G, min: 0.1, max: 4, step: 0.1, unit: "s" },
  { key: "redOnset", label: "Red-out onset", group: G, min: -4, max: 0, step: 0.25, unit: "g" },
  { key: "redFull", label: "Red-out full", group: G, min: -8, max: -1, step: 0.25, unit: "g" },
  { key: "vignette", label: "Tunnel darkness", group: G, min: 0, max: 1, step: 0.02, unit: "" },
]

const DEG = Math.PI / 180
const ease = (dt: number, lag: number) => 1 - Math.exp(-dt / lag)
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * A critically damped spring at rest at 0, stepped exactly (closed form), so it moves the same at any frame rate.
 * `kick` adds velocity; `target` is where it settles.
 */
export class Spring {
  x = 0
  v = 0
  target = 0
  constructor(public w: number) {}
  kick(v: number): void {
    this.v += v
  }
  step(dt: number): number {
    const w = this.w
    const x0 = this.x - this.target
    const e = Math.exp(-w * dt)
    const c = this.v + w * x0
    this.x = this.target + (x0 + c * dt) * e
    this.v = (this.v - w * c * dt) * e
    return this.x
  }
  reset(): void {
    this.x = this.v = this.target = 0
  }
}

/** What the flight camera adds this frame (`FlightCam.update` reads it; zero is no change). */
export type FeelOffsets = {
  /** Chase: extra rotations of the camera frame before it is placed (rad: pitch down +, yaw left +). */
  lagPitch: number
  lagYaw: number
  /** Chase: extra roll of the view (rad, right +), distance factor, and offsets in the camera frame (m: up, back). */
  roll: number
  dist: number
  up: number
  back: number
  /** Cockpit: head offset in the jet's frame (m, up +) and roll (rad, right +). */
  headUp: number
  headRoll: number
  /** Both: small view wobble (rad: pitch down +, roll right +). */
  buzzPitch: number
  buzzRoll: number
}

/**
 * The jet's feel state: smoothed body rates and g, the grey-out and red-out levels, and the springs the shots and the
 * catapult kick. `Flight` feeds it events and the drawn jet each frame; `offsets` go to the camera, `bump` to the drawn
 * jet, `grey`/`red` to the screen overlay and `strain` to the cockpit breathing.
 */
export class FlightFeel {
  readonly offsets: FeelOffsets = { lagPitch: 0, lagYaw: 0, roll: 0, dist: 1, up: 0, back: 0, headUp: 0, headRoll: 0, buzzPitch: 0, buzzRoll: 0 }
  /** Grey-out and red-out 0..1 (eased: sustained g builds them). */
  grey = 0
  red = 0
  /** Brief motor glare 0..1 after a missile leaves the rail. */
  glare = 0
  /** The jet's drawn bump along its own up axis (m). */
  bump = 0
  private p = 0
  private r = 0
  private w = 0
  private g = 1
  private time = 0
  private firing = 0
  private jet = new Spring(16)
  private camUp = new Spring(9)
  private camBack = new Spring(7)

  /** Strained breathing 0..1 for the cockpit audio: the grey-out, or the red-out's push. */
  get strain(): number {
    return Math.max(this.grey, this.red * 0.8)
  }

  reset(): void {
    this.p = this.r = this.w = 0
    this.g = 1
    this.grey = this.red = this.glare = this.bump = 0
    this.firing = 0
    this.jet.reset()
    this.camUp.reset()
    this.camBack.reset()
  }

  /** Rounds fired since the last frame (the gun's recoil and buzz follow). */
  gun(rounds: number): void {
    if (rounds <= 0) return
    this.firing = 0.09
    // Per round, so a held trigger settles at `gunKick` closer (the jet slowed by its recoil) at any frame rate.
    const w = this.camBack.w
    this.camBack.kick(-(FEEL.gunKick / 100) * ((w * w) / WEAPONS.gun.rate) * rounds * this.kicks)
  }

  /** A missile off the rail: the jet lifts, the camera follows a beat later, the motor glares. */
  missile(): void {
    this.jet.kick(FEEL.missileBump * this.jet.w * Math.E * this.kicks)
    this.camUp.kick(FEEL.cameraBump * this.camUp.w * Math.E * this.kicks)
    this.glare = 1
  }

  /** A bomb off its station: the jet thumps up, the camera with it. */
  bomb(): void {
    this.jet.kick(FEEL.bombBump * this.jet.w * Math.E * this.kicks)
    this.camUp.kick(FEEL.cameraBump * 1.3 * this.camUp.w * Math.E * this.kicks)
  }

  /** The catapult stroke: kicked back at the shot, held back while it runs, settling once off the bow. */
  catapult(stroke: boolean, start: boolean): void {
    const k = FEEL.catKick * this.kicks
    if (start) this.camBack.kick(k * this.camBack.w * 1.5)
    this.camBack.target = stroke ? k * 0.6 : 0
  }

  /** Motion scale for kicks and buzz: off under reduced motion, else the shake and kick settings. */
  private get kicks(): number {
    return this.reduced ? 0 : Math.max(0, SHAKE.shakeScale) * Math.max(0, SHAKE.kickScale)
  }

  private get reduced(): boolean {
    return Boolean(SHAKE.reduceMotion) || prefersReducedMotion()
  }

  /** Per rendered frame with the drawn jet; `flying` is false on the deck, landing and crashed (the g effects ease out). */
  update(s: Plane, dt: number, flying: boolean): void {
    this.time += dt
    const k = ease(dt, 0.12)
    this.p += ((flying ? s.p : 0) - this.p) * k
    this.r += ((flying ? s.r : 0) - this.r) * k
    this.w += ((flying ? s.w : 0) - this.w) * k
    this.g += ((flying ? s.g : 1) - this.g) * ease(dt, 0.25)

    const greyT = smooth(FEEL.greyOnset, FEEL.greyFull, this.g)
    this.grey += (greyT - this.grey) * ease(dt, greyT > this.grey ? FEEL.greyIn : FEEL.greyOut)
    const redT = smooth(-FEEL.redOnset, -FEEL.redFull, -this.g)
    this.red += (redT - this.red) * ease(dt, redT > this.red ? FEEL.greyIn * 0.6 : FEEL.greyOut)
    this.glare = Math.max(0, this.glare - dt / 0.3)
    this.firing = Math.max(0, this.firing - dt)

    // Lean, lag and head motion are how the jet reads, so reduced motion only softens them.
    const comfort = this.reduced ? 0.3 : 1
    const o = this.offsets
    const lag = FEEL.turnLagMax * DEG
    o.lagPitch = clamp(FEEL.turnLag * DEG * this.p, -lag, lag) * comfort
    o.lagYaw = clamp(FEEL.turnLag * DEG * this.w, -lag, lag) * comfort
    const lean = FEEL.leanMax * DEG
    o.roll = clamp(FEEL.lean * DEG * this.r, -lean, lean) * comfort
    o.dist = 1 - FEEL.gPull * smooth(2, FEEL.greyFull, this.g) * comfort
    o.headUp = -(FEEL.headG / 100) * clamp(this.g - 1, -3, 8) * comfort
    o.headRoll = -FEEL.headRoll * DEG * this.r * comfort

    this.bump = this.jet.step(dt)
    o.up = this.camUp.step(dt)
    o.back = this.camBack.step(dt)
    const buzz = this.firing > 0 ? FEEL.gunBuzz * DEG * this.kicks : 0
    o.buzzPitch = buzz * shakeWave(this.time, 31.7, 0, 47.3, 0.9)
    o.buzzRoll = buzz * 0.6 * shakeWave(this.time, 37.1, 1.7, 53.9, 0.3)
  }
}
