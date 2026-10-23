/**
 * Eight legs under a creature root, hand-ported from lamplight's arachnid (`src/arachnid/mod.rs`, the planar path:
 * `step_planar`, `step_gait_planar`, `foothold`, `clearance`, `leg`, `solve_knees`). This TypeScript is now the source.
 *
 * Presentation only: the legs follow a `CreatureMotion` root (`@arcade/kit/sim/creature-motion`) and never feed back
 * into it, so they never go on the wire. Feet live in world space and move in two numbered alternating groups; at
 * least four stay planted, and a planted foot never moves. A foot whose reach would run out is promoted early. Each
 * swing lifts nearly vertically, travels and sets down, with its apex cleared over the terrain under the whole chord.
 * Three segments per leg: femur and tibia by two-bone IK whose knee stays near the last solution and turns up round
 * its circle to clear the ground, then a steep tarsus. Second-order springs carry body height, pitch, roll and the
 * abdomen's lag, stiffer with more feet down. Touchdowns are reported as `contacts` (footsteps, prints, sound).
 *
 * Like the root, the gait runs in creature units (lamplight's scale) and the pose comes out in metres, scaled by
 * `size` (m per unit). `hips` shrinks the body and its hip ring against the legs: 1 is lamplight's wolf spider, about
 * 1/legScale gives a harvestman, a small body slung between long legs.
 *
 * Not ported (yet): jumping, the stalk crouch and pounce, and lamplight's whole-limb terrain sweep (`terrain.rs`).
 */
import { add, cross, dist, dot, len, lerp3, madd, norm, rot, scale, sub, type V3 } from "../rig"
import { SecondOrder, type CreatureMotion, type CreatureSurface, type CreatureTurn } from "../sim/creature-motion"

export type ArachnidShape = {
  /** Body and hip ring against the legs: 1 = lamplight's spider, ~0.4 = a harvestman. */
  hips: number
  /** Body ride height over the support, creature units (lamplight 0.34; legs are about 1 long). */
  ride: number
  /** Swing time against lamplight's 0.15 creature-seconds: above 1 steps slower and more deliberately. */
  swing: number
  /**
   * Lift curve exponent, sin(πt)^lift. Lamplight's 0.8 snaps the foot up and slams it down (an unbounded slope at
   * both ends, a pop at giant scale); 1 starts and lands at a finite speed; 2 eases off and onto the ground.
   */
  lift: number
}
/** Lamplight's wolf spider, exactly. */
export const SPIDER_SHAPE: ArachnidShape = { hips: 1, ride: 0.34, swing: 1, lift: 0.8 }
/** A small body slung high between long legs, stepping slowly and setting each foot down softly. */
export const HARVESTMAN_SHAPE: ArachnidShape = { hips: 0.4, ride: 0.42, swing: 1.5, lift: 1.6 }

export type ArachnidLegPose = {
  /** Hip, knee, ankle, foot in metres. */
  joints: [V3, V3, V3, V3]
  planted: boolean
}
export type ArachnidPose = {
  /** Body centre (metres), heading (lamplight convention) and body pitch/roll (rad). */
  body: V3
  heading: number
  pitch: number
  roll: number
  /** The abdomen's own pitch behind the body (rad). */
  abdomenPitch: number
  legs: ArachnidLegPose[]
  /** Metres per creature unit this pose was drawn at, and the hip shrink, so a view can size the body. */
  size: number
  hips: number
  turn: CreatureTurn
}
/** A foot coming down this tick (metres). */
export type ArachnidContact = { leg: number; x: number; y: number; z: number }

const PI = Math.PI
const TAU = PI * 2
const FOOT = 0.018
/** Foot-sized patch that must be solid and nearly level to accept a foothold. */
const PATCH = 0.035
const SWING = 0.15
const GROUPS = [[7, 2, 5, 0], [3, 6, 1, 4]] as const
/** Time constant of the springs' targets, creature seconds (a third of a swing). */
const TARGET_EASE = 0.05
const Y: V3 = [0, 1, 0]
const ANGLES = [28, 68, 108, 146].map(a => (a * PI) / 180)
const RADII = [0.79, 0.72, 0.7, 0.82]
const HIP_X = [0.23, 0.15, 0.07, -0.015]
const HIP_Z = [0.115, 0.16, 0.17, 0.15]
const FEMUR = [0.43, 0.4, 0.38, 0.46]
const TIBIA = [0.5, 0.45, 0.44, 0.52]
const TARSUS = [0.15, 0.14, 0.14, 0.16]

export const legLengths = (i: number): [number, number, number] => [FEMUR[i % 4]!, TIBIA[i % 4]!, TARSUS[i % 4]!]
const side = (i: number) => (i < 4 ? 1 : -1)
const rest = (i: number): V3 => {
  const p = i % 4
  return [0.08 + Math.cos(ANGLES[p]!) * RADII[p]!, FOOT, side(i) * Math.sin(ANGLES[p]!) * RADII[p]!]
}
const smooth = (t: number) => {
  const u = Math.max(0, Math.min(1, t))
  return u * u * (3 - 2 * u)
}
const swingProgress = (t: number) => smooth((t - 0.12) / 0.72)
const swingLift = (t: number, lift = 0.8) => Math.sin(PI * Math.max(0, Math.min(1, t))) ** lift
const fract = (x: number) => x - Math.floor(x)
const flat = (v: V3): V3 => [v[0], 0, v[2]]
const clampLength = (v: V3, max: number): V3 => {
  const l = len(v)
  return l > max ? scale(v, max / l) : v
}
/** Rotation about +Y by h (three.js/glam sign: +X turns toward −Z). */
const yaw = (v: V3, h: number): V3 => {
  const c = Math.cos(h), s = Math.sin(h)
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]
}
/** Lamplight's orientation: yaw · pitch (about Z, +X up) · roll (about X). */
const orient = (v: V3, h: number, p: number, r: number): V3 => {
  const cr = Math.cos(r), sr = Math.sin(r)
  const a: V3 = [v[0], v[1] * cr - v[2] * sr, v[1] * sr + v[2] * cr]
  const cp = Math.cos(p), sp = Math.sin(p)
  return yaw([a[0] * cp - a[1] * sp, a[0] * sp + a[1] * cp, a[2]], h)
}

type Foot = { at: V3; from: V3; to: V3; t: number; duration: number; lift: number; deviation: number }
const planted = (f: Foot) => f.t >= 1

const walkable = (g: CreatureSurface, x: number, z: number) => (g.walkable ? g.walkable(x, z) : true)

function search(g: CreatureSurface, ix: number, iz: number, tx: number, tz: number, reach: (p: V3) => boolean, rings: number): [number, number] | null {
  let best: [number, number, number] | null = null
  let fallback: [number, number, number] | null = null
  for (let ring = 0; ring < rings; ring++) {
    const radius = ring * 0.05
    const count = ring === 0 ? 1 : 6 + ring * 4
    for (let k = 0; k < count; k++) {
      const a = (k / count) * TAU + ring * 0.37
      const px = ix + Math.cos(a) * radius, pz = iz + Math.sin(a) * radius
      if (!walkable(g, px, pz)) continue
      const h = g.heightAt(px, pz)
      if (!reach([px, h + FOOT, pz])) continue
      let solid = 0, rough = 0
      for (let j = 0; j < 6; j++) {
        const b = (j / 6) * TAU
        const qx = px + Math.cos(b) * PATCH, qz = pz + Math.sin(b) * PATCH
        if (walkable(g, qx, qz)) solid++
        rough = Math.max(rough, Math.abs(g.heightAt(qx, qz) - h))
      }
      // Stay back from edges: count unwalkable ground a little further out.
      let edge = 0
      for (let j = 0; j < 8; j++) {
        const b = (j / 8) * TAU
        if (!walkable(g, px + Math.cos(b) * 0.09, pz + Math.sin(b) * 0.09)) edge++
      }
      const behind = Math.max(0, -((px - ix) * tx + (pz - iz) * tz))
      const cost = radius * radius + edge * 0.0025 + rough * 0.6 + behind * behind * 2
      if (solid === 6 && rough < 0.03) {
        if (!best || cost < best[0]) best = [cost, px, pz]
      } else {
        const partial = (6 - solid) * 0.05 + cost
        if (!fallback || partial < fallback[0]) fallback = [partial, px, pz]
      }
    }
    // Rings grow outward: once a valid spot exists, farther rings cost more.
    if (best && best[0] < (radius + 0.05) ** 2) break
  }
  const pick = best ?? fallback
  return pick ? [pick[1], pick[2]] : null
}

/**
 * The nearest good foothold to the ideal spot: a ring search scored by distance, edge margin, flatness and how far
 * behind the direction of travel (tx, tz) it lies, after ETH's ANYmal foothold planning. Within reach first; if
 * nothing solid is in reach, a wider search beats stepping somewhere unwalkable.
 */
export function foothold(g: CreatureSurface, ix: number, iz: number, tx: number, tz: number, reach: (p: V3) => boolean = () => true): V3 {
  const p = search(g, ix, iz, tx, tz, reach, 7) ?? search(g, ix, iz, tx, tz, () => true, 10) ?? [ix, iz]
  return [p[0], g.heightAt(p[0], p[1]) + FOOT, p[1]]
}

/** Apex height that clears every point of terrain under the swing path. */
function clearance(g: CreatureSurface, from: V3, to: V3, liftCurve = 0.8): number {
  let lift = Math.max(0.055, Math.min(0.15, dist(from, to) * 0.34))
  for (let k = 1; k < 12; k++) {
    const t = 0.1 + (0.8 * k) / 12
    const at = lerp3(from, to, swingProgress(t))
    const needed = g.heightAt(at[0], at[2]) + FOOT + 0.03 - at[1]
    lift = Math.max(lift, needed / Math.max(0.25, swingLift(t, liftCurve)))
  }
  return Math.min(0.45, lift)
}

export class ArachnidLegs {
  /** Metres per creature unit. */
  size: number
  readonly shape: ArachnidShape
  /** Touchdowns from the last `step`, in metres. */
  readonly contacts: ArachnidContact[] = []

  private x = 0
  private z = 0
  private heading = 0
  private vx = 0
  private vz = 0
  private turn: CreatureTurn = "travel"
  private floor = 0
  private body: V3
  private pitch = 0
  private roll = 0
  private abdomenPitch = 0
  private feet: Foot[]
  private knees: (V3 | null)[] = new Array(8).fill(null)
  private group = 0
  private stepped = 0
  private stalled = 0
  private bodyFilter = [new SecondOrder(), new SecondOrder(), new SecondOrder()]
  private pitchFilter = new SecondOrder()
  private rollFilter = new SecondOrder()
  private abdomenFilter = new SecondOrder()
  private landingFilter = new SecondOrder()
  private cooldown = 0
  private settle = 0
  private landing = 0
  private clock = 0
  private phase = 0
  private idleStep = 1.8
  private angularVelocity = 0
  private desiredVx = 0
  private desiredVz = 0
  private targets = { sx: 0, sz: 0, fraction: 1, pitch: 0, roll: 0, accel: 0, response: 0 }
  private eased = false

  /** Stands the legs at their rest footholds under `root` (creature units) on `ground` (creature units). */
  constructor(root: CreatureMotion, ground: CreatureSurface, size = 1, shape: ArachnidShape = SPIDER_SHAPE) {
    this.size = size
    this.shape = { ...shape }
    this.x = root.x
    this.z = root.z
    this.heading = root.heading
    this.floor = ground.heightAt(root.x, root.z)
    this.body = [root.x, this.floor + this.shape.ride, root.z]
    this.feet = Array.from({ length: 8 }, (_, i) => {
      const home = this.home(i)
      const at = foothold(ground, home[0], home[2], 0, 0)
      return { at, from: at, to: at, t: 1, duration: SWING, lift: 0.1, deviation: Math.hypot(at[0] - home[0], at[2] - home[2]) }
    })
    this.floor = this.supportFloor()
    this.body[1] = this.floor + this.shape.ride
    this.solveKnees(ground)
  }

  private hip(i: number): V3 {
    const p = i % 4, k = this.shape.hips
    return [HIP_X[p]! * k, -0.025, side(i) * HIP_Z[p]! * k]
  }
  private root(): V3 {
    return [this.x, this.floor, this.z]
  }
  private home(i: number): V3 {
    return add(this.root(), yaw(rest(i), this.heading))
  }
  /** Horizontal drift of a foot from its rest spot under the body, less the offset its foothold had to take. */
  private drift(i: number): number {
    return Math.max(0, len(flat(sub(this.feet[i]!.at, this.home(i)))) - this.feet[i]!.deviation)
  }
  /** Ground the body rides above: planted feet where they stand, swinging ones where they will land. */
  private supportFloor(): number {
    let s = 0
    for (const f of this.feet) s += f.to[1] - FOOT
    return s / 8
  }
  private reachableFoothold(i: number, g: CreatureSurface, root: V3, ix: number, iz: number, tx: number, tz: number): V3 {
    const hipAt = add(add(root, yaw(this.hip(i), this.heading)), [0, this.shape.ride, 0])
    const [a, b, c] = legLengths(i)
    return foothold(g, ix, iz, tx, tz, p => len(sub(add(p, [0, c, 0]), hipAt)) < (a + b) * 0.93)
  }
  private reach(i: number, travel: V3): number {
    const [hip, , ankle] = this.leg(i)
    const [a, b] = legLengths(i)
    return len(sub(sub(ankle, hip), travel)) / (a + b)
  }

  /** True when every foot is down, and when every foot is also near its rest spot (lamplight's pivot gates). */
  get allPlanted(): boolean {
    return this.feet.every(planted)
  }
  get aligned(): boolean {
    return this.feet.every((f, i) => planted(f) && this.drift(i) < 0.18)
  }
  /** Feet carrying weight right now. */
  get supports(): number {
    return this.feet.filter(planted).length
  }

  /** Follows the root one tick (creature seconds, creature-unit ground). */
  step(root: CreatureMotion, g: CreatureSurface, dt: number): void {
    this.contacts.length = 0
    const oldVx = this.vx, oldVz = this.vz
    this.x = root.x
    this.z = root.z
    this.heading = root.heading
    this.vx = root.vx
    this.vz = root.vz
    this.turn = root.turn
    this.angularVelocity = root.angularVelocity
    this.desiredVx = root.desiredVx
    this.desiredVz = root.desiredVz
    const run = root.run
    this.clock += dt
    this.idleStep = Math.max(0, this.idleStep - dt)
    const speed = Math.hypot(this.vx, this.vz)
    // Lamplight measured turning per 1/60 s tick; keep its threshold whatever the step.
    const turning = Math.abs(this.angularVelocity) / 60 > 0.001

    // Constant recovery time; faster travel shortens stance, not swing.
    const duty = 0.65 - 0.15 * run
    const stride = Math.max(0.32, (speed * SWING * this.shape.swing) / (1 - duty))
    this.phase = fract(this.phase + (speed * dt) / stride)
    // Low-pass the support height so uneven footholds don't make it bob.
    this.floor += (this.supportFloor() - this.floor) * (1 - Math.exp(-14 * dt))
    this.settle = speed > 0.025 || turning ? 1.4 : Math.max(0, this.settle - dt)

    // A foot already in swing always finishes, even after input stops.
    for (let i = 0; i < 8; i++) {
      const f = this.feet[i]!
      if (planted(f)) continue
      f.t = Math.min(1, f.t + dt / f.duration)
      f.at = madd(lerp3(f.from, f.to, swingProgress(f.t)), Y, f.lift * swingLift(f.t, this.shape.lift))
      if (f.t >= 1) {
        f.at = f.to
        this.landingFilter.speed -= 0.065
        this.contacts.push({ leg: i, x: f.at[0] * this.size, y: f.at[1] * this.size, z: f.at[2] * this.size })
      }
      // Never pass through a support, even one the apex missed.
      const floor = g.heightAt(f.at[0], f.at[2]) + FOOT
      if (f.at[1] < floor) f.at = [f.at[0], floor, f.at[2]]
    }
    this.stepGait(speed, turning, run, g, dt)

    // The support set changes in steps (a foot lifts, a foot lands) and the root's acceleration is bang-bang. Fed raw
    // into anticipating springs (negative response), each step is an impulse: a twitch in lamplight, a pop at giant
    // scale. A short low-pass makes the targets continuous; the springs keep all their character.
    const raw = this.supportAndSlope()
    const localAccelRaw = ((this.vx - oldVx) * Math.cos(this.heading) - (this.vz - oldVz) * Math.sin(this.heading)) / dt
    const ease = 1 - Math.exp(-dt / TARGET_EASE)
    const t = this.targets
    if (!this.eased) { t.sx = raw.shift[0]; t.sz = raw.shift[2]; t.fraction = raw.fraction; t.pitch = raw.slopePitch; t.roll = raw.slopeRoll; t.accel = 0; this.eased = true }
    t.sx += (raw.shift[0] - t.sx) * ease
    t.sz += (raw.shift[2] - t.sz) * ease
    t.fraction += (raw.fraction - t.fraction) * ease
    t.pitch += (raw.slopePitch - t.pitch) * ease
    t.roll += (raw.slopeRoll - t.roll) * ease
    t.accel += (localAccelRaw - t.accel) * ease
    const shift: V3 = [t.sx, 0, t.sz], fraction = t.fraction, slopePitch = t.pitch, slopeRoll = t.roll
    const activity = Math.min(1, speed / 0.7)
    const phase = this.phase * TAU
    const bob = Math.cos(phase * 2) * 0.012 * (1 - 0.65 * run) * activity
    const sway = Math.sin(phase) * 0.012 * activity
    const noise = Math.sin(this.clock * 0.71) * Math.sin(this.clock * 1.13 + 0.7)
    const desiredSpeed = Math.hypot(this.desiredVx, this.desiredVz)
    const preparing = this.turn !== "travel" || speed > desiredSpeed + 0.05
    // Anticipation switches on as it brakes or turns; eased like the targets so the switch itself isn't a kick.
    t.response += ((preparing ? -0.85 : 0) - t.response) * ease
    const response = t.response
    this.landing = this.landingFilter.step(this.landing, 0, 4.2, 0.55, 0, dt)
    const height = this.floor + this.shape.ride - 0.025 * speed - 0.055 * (1 - fraction) + this.landing + bob
    const rx = Math.sin(this.heading), rz = Math.cos(this.heading)
    // Filter only the support offsets horizontally. Root travel is exact, and keeping each response's velocity
    // through every mode switch inertializes the pose.
    const ox = this.bodyFilter[0]!.step(this.body[0] - (this.x - this.vx * dt), shift[0] + rx * sway, 4, 0.9, response, dt)
    const by = this.bodyFilter[1]!.step(this.body[1], height, 5 * Math.sqrt(fraction), 0.85, response, dt)
    const oz = this.bodyFilter[2]!.step(this.body[2] - (this.z - this.vz * dt), shift[2] + rz * sway, 4, 0.9, response, dt)
    this.body = [this.x + ox, by, this.z + oz]
    const localAccel = t.accel
    const localShift = shift[0] * rx + shift[2] * rz
    const k = Math.sqrt(fraction)
    this.pitch = this.pitchFilter.step(this.pitch, Math.max(-0.18, Math.min(0.25, -localAccel * 0.015)) + Math.max(-0.35, Math.min(0.35, slopePitch)), 3.5 * k, 0.85, response, dt)
    this.roll = this.rollFilter.step(this.roll, Math.max(-0.08, Math.min(0.08, -localShift * 0.5)) + Math.max(-0.25, Math.min(0.25, slopeRoll)) + sway * 0.8 + noise * 0.003, 3.3 * k, 0.9, response, dt)
    this.abdomenPitch = this.abdomenFilter.step(
      this.abdomenPitch,
      -this.pitch * 0.7 - this.bodyFilter[1]!.speed * 0.025 + Math.sin(phase) * (0.055 + 0.013 * run) * activity + Math.sin(this.clock * 1.5) * 0.009 * (1 - activity) + noise * 0.004,
      3,
      0.8,
      0,
      dt,
    )
    this.solveKnees(g)
  }

  private stepGait(speed: number, turning: boolean, run: number, g: CreatureSurface, dt: number): void {
    this.cooldown = Math.max(0, this.cooldown - dt)
    const vel: V3 = [this.vx, 0, this.vz]
    if (speed > 0.03 || turning) this.stalled = 0
    // Lamplight looks 0.08 s ahead for a 0.15 s swing; a slower swing has to start that much earlier.
    const ahead = scale(vel, 0.08 * this.shape.swing)
    let urgent = -1, worst = 0.94
    for (let i = 0; i < 8; i++) {
      if (!planted(this.feet[i]!) || this.stalled & (1 << i)) continue
      const r = this.reach(i, ahead)
      if (r > worst) { worst = r; urgent = i }
    }
    if ((this.cooldown !== 0 && urgent < 0) || this.turn === "planting") return
    const moving = speed > 0.03 || turning
    const threshold = moving ? 0.14 - 0.04 * run : this.settle > 0 ? 0.09 : 0.18
    const maxSwing = moving ? 4 : 1
    let selected = -1
    if (this.feet.filter(f => !planted(f)).length < maxSwing) {
      selected = urgent
      // Alternating numbered groups stop a greedy leg starving its neighbours. At least four feet carry weight.
      for (let pass = 0; pass < 2 && selected < 0; pass++) {
        for (const i of GROUPS[this.group]!) {
          const f = this.feet[i]!
          if (!planted(f) || this.stepped & (1 << i) || this.stalled & (1 << i) || this.drift(i) < threshold || (!moving && this.settle === 0 && this.idleStep > 0)) continue
          const busy = [i - 1, i + 1].some(j => j >= 0 && j < 8 && j >> 2 === i >> 2 && !planted(this.feet[j]!) && this.feet[j]!.t < 0.8)
          if (!busy) { selected = i; break }
        }
        if (selected >= 0) break
        if (pass === 0 && GROUPS[this.group]!.every(i => this.feet[i]!.t >= 0.8)) {
          this.group = 1 - this.group
          this.stepped = 0
        } else break
      }
    }
    if (selected < 0) return
    const i = selected, swing = SWING * this.shape.swing
    this.stepped |= 1 << i
    const from = this.feet[i]!.at
    const home = add(this.root(), yaw(rest(i), this.heading + this.angularVelocity * swing))
    const desired = Math.hypot(this.desiredVx, this.desiredVz)
    const braking: V3 = speed > desired ? [(this.vx - this.desiredVx) * 0.035, 0, (this.vz - this.desiredVz) * 0.035] : [0, 0, 0]
    const lead = add(add(scale(vel, swing * 1.15), braking), scale(clampLength(sub(home, from), 0.15), moving ? 0.3 : 0))
    const ideal = add(home, lead)
    const tl = speed > 0 ? Math.min(1, speed) / speed : 0
    // Reach is checked from where the hip will be at touchdown. Braking, the body covers about the mean of its speed
    // and the speed it wants, not its whole speed: a foot placed for the full speed lands out of reach and snaps.
    const travel: V3 = [(this.vx + this.desiredVx) * 0.5 * swing, 0, (this.vz + this.desiredVz) * 0.5 * swing]
    const touchdown = speed > desired ? travel : scale(vel, swing)
    const to = this.reachableFoothold(i, g, add(this.root(), touchdown), ideal[0], ideal[2], this.vx * tl, this.vz * tl)
    const deviation = Math.hypot(to[0] - ideal[0], to[2] - ideal[2])
    if (dist(to, from) < 0.03) {
      // Nowhere better to stand: stay planted.
      this.stalled |= 1 << i
      this.feet[i]!.deviation = deviation
    } else {
      this.feet[i] = { at: from, from, to, t: 0, duration: swing, lift: clearance(g, from, to, this.shape.lift), deviation }
    }
    this.cooldown = 0.025 * (1 - run)
    if (!moving) this.idleStep = 1.8 + 0.4 * Math.sin(this.clock * 0.7)
  }

  private supportAndSlope(): { shift: V3; fraction: number; slopePitch: number; slopeRoll: number } {
    let support: V3 = [0, 0, 0], count = 0
    for (const f of this.feet) if (planted(f)) { support = add(support, f.at); count++ }
    support = count > 0 ? scale(support, 1 / count) : this.root()
    const shift = clampLength(scale(flat(sub(support, this.root())), 0.22), 0.09)
    const local = this.feet.map(f => yaw(sub(f.to, this.root()), -this.heading))
    const mean = (ids: readonly number[]): V3 => scale(ids.reduce<V3>((s, i) => add(s, local[i]!), [0, 0, 0]), 1 / ids.length)
    const front = mean([0, 1, 4, 5]), back = mean([2, 3, 6, 7])
    const left = mean([0, 1, 2, 3]), right = mean([4, 5, 6, 7])
    return {
      shift,
      // Never zero: the springs' frequency scales with √fraction.
      fraction: Math.max(1, count) / 8,
      slopePitch: Math.atan2(front[1] - back[1], Math.max(0.2, front[0] - back[0])),
      slopeRoll: -Math.atan2(left[1] - right[1], Math.max(0.2, left[2] - right[2])),
    }
  }

  /** Fixed-length femur and tibia solved against a steep tarsus (creature units). */
  private leg(i: number): [V3, V3, V3, V3] {
    const hip = add(this.body, orient(this.hip(i), this.heading, this.pitch, this.roll))
    let foot = this.feet[i]!.at
    const [a, b, c] = legLengths(i)
    const radialRaw = flat(yaw(sub(rest(i), [0.08, 0, 0]), this.heading))
    const radial = len(radialRaw) > 1e-6 ? norm(radialRaw) : ([0, 0, 1] as V3)
    const tarsus = scale(norm(add(scale(Y, 0.95), scale(radial, 0.3))), c)
    // A swinging foot carries no weight: draw it at full reach rather than stretch the leg when it outruns the hip.
    if (!planted(this.feet[i]!)) {
      const reach = a + b - 0.002
      const delta = sub(add(foot, tarsus), hip)
      if (len(delta) > reach) foot = sub(add(hip, scale(norm(delta), reach)), tarsus)
    }
    const ankle = add(foot, tarsus)
    const delta = sub(ankle, hip)
    const actual = Math.max(0.0001, len(delta))
    const d = Math.max(Math.abs(a - b) + 0.001, Math.min(a + b - 0.001, actual))
    const direction = scale(delta, 1 / actual)
    const cos = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)))
    const center = madd(hip, direction, a * cos)
    const knee0 = this.knees[i]
    const pole = knee0 ? sub(knee0, center) : add(Y, scale(radial, 0.65))
    const perp = madd(pole, direction, -dot(pole, direction))
    const bend = len(perp) > 1e-9 ? norm(perp) : Y
    const knee = madd(center, bend, a * Math.sqrt(Math.max(0, 1 - cos * cos)))
    return [hip, knee, ankle, foot]
  }

  /**
   * The two-bone solution is a circle. Stay near the previous knee, with a gentle pull back to the authored pole,
   * and turn up round that circle only when terrain rules out the nearest solution.
   */
  private solveKnees(g: CreatureSurface): void {
    for (let i = 0; i < 8; i++) {
      const previous = this.knees[i]
      this.knees[i] = null
      const [hip, preferred, ankle] = this.leg(i)
      const axisRaw = sub(ankle, hip)
      const axis = len(axisRaw) > 1e-9 ? norm(axisRaw) : ([1, 0, 0] as V3)
      const center = madd(hip, axis, dot(sub(preferred, hip), axis))
      const radius = dist(preferred, center)
      const last = previous ?? preferred
      const pole = sub(lerp3(last, preferred, 0.12), center)
      const perp = madd(pole, axis, -dot(pole, axis))
      const nearest = len(perp) > 1e-9 ? norm(perp) : Y
      let best = preferred, cost = Infinity
      for (let j = 0; j < 33; j++) {
        const angle = j === 0 ? 0 : ((j - 16.5) * TAU) / 32
        const knee = madd(center, rot(nearest, axis, angle), radius)
        const penetration = Math.max(0, g.heightAt(knee[0], knee[2]) + 0.025 - knee[1])
        const candidate = dist(knee, last) ** 2 + 0.12 * dist(knee, preferred) ** 2 + penetration * 1000
        if (candidate < cost) { cost = candidate; best = knee }
      }
      this.knees[i] = best
    }
  }

  /** The drawn pose, in metres. */
  pose(): ArachnidPose {
    const s = this.size
    return {
      body: scale(this.body, s),
      heading: this.heading,
      pitch: this.pitch,
      roll: this.roll,
      abdomenPitch: this.abdomenPitch,
      legs: this.feet.map((f, i) => ({ joints: this.leg(i).map(p => scale(p, s)) as [V3, V3, V3, V3], planted: planted(f) })),
      size: s,
      hips: this.shape.hips,
      turn: this.turn,
    }
  }

  /** Body frame axes in world space (forward, up, right) for the current pose. */
  axes(): { forward: V3; up: V3; right: V3 } {
    const forward = orient([1, 0, 0], this.heading, this.pitch, this.roll)
    const up = orient([0, 1, 0], this.heading, this.pitch, this.roll)
    return { forward, up, right: cross(forward, up) }
  }
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

/** Presentation-only sub-tick blend between two adjacent poses. */
export function interpolateArachnidPose(a: ArachnidPose, b: ArachnidPose, t: number): ArachnidPose {
  const u = Math.max(0, Math.min(1, t))
  if (u >= 0.9999) return b
  if (u <= 0.0001) return a
  return {
    body: lerp3(a.body, b.body, u),
    heading: a.heading + wrap(b.heading - a.heading) * u,
    pitch: a.pitch + (b.pitch - a.pitch) * u,
    roll: a.roll + (b.roll - a.roll) * u,
    abdomenPitch: a.abdomenPitch + (b.abdomenPitch - a.abdomenPitch) * u,
    legs: a.legs.map((l, i) => ({ joints: l.joints.map((p, j) => lerp3(p, b.legs[i]!.joints[j]!, u)) as [V3, V3, V3, V3], planted: u < 0.5 ? l.planted : b.legs[i]!.planted })),
    size: b.size,
    hips: b.hips,
    turn: b.turn,
  }
}

/** The foot point rides a foot's radius above the ground; the tarsus continues that far to touch it. */
export const ARACHNID_FOOT = FOOT

/** Where the drawn tarsus tip meets the ground (metres): the ankle→foot line carried on by the foot's radius. */
export function arachnidSole(leg: ArachnidLegPose, size: number): V3 {
  const [, , ankle, foot] = leg.joints
  const d = sub(foot, ankle), l = len(d) || 1
  return madd(foot, d, (FOOT * size) / l)
}

/** Lamplight's orientation applied to a body-local point (forward +X, up +Y, left +Z), for views. */
export const arachnidLocal = (pose: ArachnidPose, local: V3): V3 => add(pose.body, scale(orient(local, pose.heading, pose.pitch, pose.roll), pose.size))
