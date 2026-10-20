// One creature in one level: builds the world, turns body and surroundings into an observation vector, runs the
// policy at the control rate and scores the run.
//
// Fitness ≈ metres of forward progress + a small upright bonus − effort; falls end the run with a penalty and
// crossing the goal ends it with a bonus per second left. In the heist, progress past the gem only counts once the
// gem is carried, grabbing it pays a bonus, the exit only counts with the gem, and touching a beam or being seen by a
// camera for 50 ms sounds the alarm: each alarm costs points, every body-second in (or within 4 cm of) a beam or in a cone costs
// more (so ES can tell "grazed it with one paw" from "walked straight through", and "missed by 1 cm" from "by 4 cm"), and the escape bonus halves with one alarm, thirds with two.
// Alarms don't end the run unless maxAlarms says so: when they did, the population learned to stop in front of the
// first beam, since that forfeits nothing, and never found out what lies past it.

import { actuated, CREATURES, type CreatureDef, type CreatureId } from "./creatures"
import { sincos, wrapAngle } from "./fmath"
import { beamContact, beamsAt, conesAt, inCone, type Beam, type BeamContact, type Cone } from "./hazards"
import type { Level } from "./level"
import { DEFAULT_PHYSICS, JointMode, World, groundHeight, jointAngle, jointSpeed, makeBox, makeCapsule, makeJoint, makeStatics, raySegment, type Body, type Joint, type Statics } from "./physics"
import { Policy, type PolicyShape } from "./policy"
import { envFor, envKey, levelFor, type Env, type TaskId } from "./tasks"
import { HumanControl } from "./human"
import { HumanRealism, type GaitMetrics } from "./realism"

export const CONTROL_HZ = 60
export const SUBSTEPS = 2
export const CONTROL_DT = 1 / CONTROL_HZ
const SUB_DT = CONTROL_DT / SUBSTEPS
const LOOKAHEAD = [0.4, 0.8, 1.2, 1.6]
/** Terrain whiskers from the head: angles from straight ahead (radians, negative is down). */
export const WHISKERS = [-1.2, -0.8, -0.5, -0.25, 0, 0.3, 0.7]
/** Laser whiskers: rays that see active beams and camera cone edges. */
export const LASER_RAYS = [-0.6, -0.3, 0, 0.3, 0.6]
export const RAY_RANGE = 3
/** How far ahead (m) the next timed hazard shows up in the observation. */
export const HAZARD_RANGE = 1.5
const SMOOTHING = 0.4

export type RewardSettings = {
  /** Human realism strength, 0 = loose, 1 = enforced. Optional for v2 saved policies. */
  realism?: number
  /** Episode length (s); the heist gets heistSeconds. */
  seconds: number
  heistSeconds: number
  /** Points per metre of forward torso travel. */
  progress: number
  /** Extra fraction of the progress reward for metres covered fully upright. */
  upright: number
  /** Points lost per second at full effort on every joint. */
  effort: number
  /** Points lost for a fall (the run ends). */
  fall: number
  /** Points per second left when the goal is reached. */
  finish: number
  /** Period of the clock the policy sees (s). */
  phase: number
  /** Heist: points for grabbing the gem, and for escaping with it. */
  gem: number
  escape: number
  /** Heist: points lost per alarm, and per body-second inside a beam or camera cone (at most EXPOSURE_CAP a run). */
  alarm: number
  exposure: number
  /** Heist: this many alarms ends the run as caught; 0 never does. */
  maxAlarms: number
}

/** Uncapped, a creature that fell over inside a beam lost hundreds of points and the population learned to keep away
 *  from the first beam altogether. */
export const EXPOSURE_CAP = 3

/** A beam (or a camera) has to be broken for this many control steps (50 ms) to trip, like a real sensor's debounce.
 *  Without it, a back paw flicking through the trip wire for one frame cost the escape, and the clean gait was too
 *  narrow a target for ES to hold under its own noise (4000+ generations at one alarm a run). */
export const TRIP_STEPS = 3

export const DEFAULT_REWARD: RewardSettings = { seconds: 14, heistSeconds: 30, progress: 1, upright: 0.15, effort: 0.04, fall: 1.5, finish: 0.5, phase: 0.9, gem: 2, escape: 8, alarm: 2, exposure: 4, maxAlarms: 0 }

export type Outcome = "running" | "timeout" | "fell" | "finished" | "caught"
export type EpisodeResult = { fitness: number; distance: number; time: number; outcome: Outcome; gem: boolean; alarms: number; gait?: GaitMetrics }

export const observationSize = (c: CreatureDef): number =>
  6 + 2 * actuated(c).length + c.feet.length + 2 + LOOKAHEAD.length + WHISKERS.length + LASER_RAYS.length + 2 + 2 + 5
export const policyShape = (id: CreatureId, hidden: number): PolicyShape => {
  const c = CREATURES[id]
  return { inputs: observationSize(c), hidden, outputs: actuated(c).length + (id === "human" ? 1 : 0) }
}

const staticsCache = new Map<string, Statics>()
export function staticsFor(env: Env, level: Level): Statics {
  const key = envKey(env)
  let s = staticsCache.get(key)
  if (!s) staticsCache.set(key, (s = makeStatics(level.floor, level.blocks)))
  return s
}

export class Episode {
  readonly human: HumanControl | null
  readonly realism: HumanRealism | null
  readonly creature: CreatureDef
  readonly env: Env
  readonly level: Level
  readonly world: World
  readonly obs: Float64Array
  readonly action: Float64Array
  readonly motors: number[]
  /** Creature bodies are world.bodies[0 .. n); props follow. */
  readonly n: number
  readonly goal: number
  readonly seconds: number
  readonly beams: Beam[] = []
  readonly cones: Cone[] = []
  time = 0
  steps = 0
  fitness = 0
  done = false
  outcome: Outcome = "running"
  carrying = false
  gemTime = -1
  platePressed = false
  /** Smallest beam clearance this step (m); for near-miss slow motion. */
  clearance = Infinity
  /** Alarms so far, what set off the last one (a beam index, or -1 - camera index) and when (s). */
  alarms = 0
  /** Points lost to time spent in beams and cones so far. */
  exposure = 0
  alarmBy: number | null = null
  alarmAt = -Infinity
  /** Consecutive control steps each beam (then each camera) has been broken; an alarm fires at TRIP_STEPS. */
  private broken: number[] = []
  private contact: BeamContact = { clearance: Infinity, touching: 0, near: 0, mask: 0 }
  /** Furthest torso x (m from the start). */
  best = 0
  private startX: number
  private credited: number
  private targets: Float64Array
  private sc: [number, number] = [0, 0]

  constructor(creature: CreatureId, task: TaskId | Env, readonly policy: Policy | null, readonly reward: RewardSettings = DEFAULT_REWARD) {
    const def = CREATURES[creature]
    this.creature = def
    this.env = { ...(typeof task === "string" ? envFor(task) : task), ...(creature === "human" ? { human: true } : {}) }
    this.human = creature === "human" ? new HumanControl() : null
    this.realism = this.human ? new HumanRealism() : null
    this.level = levelFor(this.env)
    const statics = staticsFor(this.env, this.level)
    const bodies: Body[] = def.bodies.map((b) => makeCapsule(b.x, b.y + groundHeight(statics, b.x), b.a, b.hl, b.r, b.m, b.friction ?? 0.8, 0))
    const joints: Joint[] = def.joints.map((j) =>
      makeJoint(bodies, j.a, j.b, j.x, j.y + groundHeight(statics, j.x), {
        lower: j.lower, upper: j.upper, mode: j.mode === "motor" ? JointMode.Motor : JointMode.Spring, maxTorque: j.torque, kp: j.kp ?? 12, maxSpeed: j.maxSpeed ?? 10, hill: this.human ? j.maxSpeed ?? 8 : 0,
      }))
    this.n = bodies.length
    for (const p of this.level.props) {
      if (p.kind === "crate") bodies.push(makeBox(p.x, p.y, 0, p.hx, p.hy, p.m, 0.7))
      else if (p.kind === "seesaw") {
        bodies.push(makeBox(p.x, p.y, p.tilt, p.hx, p.hy, p.m, 0.9))
        joints.push(makeJoint(bodies, bodies.length - 1, -1, p.x, p.y, { lower: -0.4, upper: 0.4 }))
      } else {
        const b = makeBox(p.x, p.y, 0, p.hx, p.hy, 0, 0.9)
        b.drive = { x0: p.x, y0: p.y, ax: p.ax, ay: p.ay, period: p.period, phase: p.phase }
        bodies.push(b)
      }
    }
    this.world = new World(bodies, joints, statics, DEFAULT_PHYSICS)
    this.motors = actuated(def)
    this.obs = new Float64Array(observationSize(def))
    this.action = new Float64Array(this.motors.length + (this.human ? 1 : 0))
    this.targets = new Float64Array(this.motors.length)
    this.goal = this.level.goal
    this.seconds = this.level.gem ? reward.heistSeconds : Math.max(reward.seconds, this.level.seconds ?? 0)
    this.startX = bodies[def.torso]!.x
    this.credited = this.startX
    this.updateHazards()
  }

  get torso(): Body {
    return this.world.bodies[this.creature.torso]!
  }

  get mouth(): Body {
    return this.world.bodies[this.creature.mouth]!
  }

  gripAt(): [number, number] {
    const m = this.mouth
    return this.human ? [m.x + m.c * (m.hl + .02), m.y + m.s * (m.hl + .02)] : [m.x, m.y]
  }

  get distance(): number {
    return this.torso.x - this.startX
  }

  /** Where the creature is headed: the gem until it has it, then the goal. */
  target(): [number, number] {
    const gem = this.level.gem
    if (gem && !this.carrying) return [gem.x, gem.y]
    return [this.goal, groundHeight(this.world.statics, this.goal) + 0.4]
  }

  /** The gem's position (on its pedestal, or in the mouth). */
  gemAt(): [number, number] | null {
    const gem = this.level.gem
    if (!gem) return null
    if (!this.carrying) return [gem.x, gem.y]
    if (this.human) return this.gripAt()
    const m = this.mouth
    return [m.x + m.c * (m.hl + 0.02), m.y + m.s * (m.hl + 0.02) - 0.02]
  }

  private updateHazards(): void {
    const { level, world } = this
    if (level.plate && !this.platePressed) {
      const { x0, x1 } = level.plate
      for (let i = 0; i < this.n; i++) {
        const b = world.bodies[i]!
        if (b.ground && b.x > x0 && b.x < x1) this.platePressed = true
      }
    }
    if (level.lasers.length) beamsAt(level, this.time, this.platePressed, this.beams)
    if (level.cameras.length) conesAt(level, this.time, this.cones)
  }

  observe(): Float64Array {
    const { creature: c, world, obs, sc } = this
    const bodies = world.bodies
    const t = this.torso
    let k = 0
    sincos(t.a - c.upright, sc)
    obs[k++] = sc[0]
    obs[k++] = sc[1]
    obs[k++] = t.w * 0.25
    obs[k++] = t.vx * 0.3
    obs[k++] = t.vy * 0.3
    const ground = groundHeight(world.statics, t.x)
    obs[k++] = t.y - ground - c.bodies[c.torso]!.y
    for (const i of this.motors) {
      const j = world.joints[i]!
      obs[k++] = jointAngle(bodies, j)
      obs[k++] = jointSpeed(bodies, j) * 0.1
    }
    for (const f of c.feet) obs[k++] = bodies[f]!.contact ? 1 : 0
    // Keep the v2 operation order: reassociating multiply/divide changes chaotic saved replays.
    sincos(this.human ? 6.283185307179586 * this.human.phase : (6.283185307179586 * this.time) / this.reward.phase, sc)
    obs[k++] = sc[0]
    obs[k++] = sc[1]
    for (const dx of LOOKAHEAD) obs[k++] = Math.max(-1, Math.min(1, (groundHeight(world.statics, t.x + dx) - ground) * 3))
    const m = this.human ? bodies[2]! : this.mouth
    const ox = m.x, oy = m.y
    for (const a of WHISKERS) {
      sincos(a, sc)
      obs[k++] = 1 - world.raycast(ox, oy, sc[1], sc[0], RAY_RANGE, 0) / RAY_RANGE
    }
    for (const a of LASER_RAYS) {
      sincos(a, sc)
      obs[k++] = 1 - this.laserRay(ox, oy, sc[1], sc[0]) / RAY_RANGE
    }
    const [gx, gy] = this.target()
    obs[k++] = Math.max(-1, Math.min(1, (gx - t.x) / 5))
    obs[k++] = Math.max(-1, Math.min(1, (gy - t.y) / 2))
    obs[k++] = this.carrying ? 1 : 0
    obs[k++] = this.platePressed ? 1 : 0
    this.nextHazard(t.x, obs, k)
    return obs
  }

  /** Distance along a ray to the nearest active beam or camera cone edge. */
  private laserRay(ox: number, oy: number, dx: number, dy: number): number {
    let best = RAY_RANGE
    for (const b of this.beams) {
      if (!b.active) continue
      const d = raySegment(ox, oy, dx, dy, b.x1, b.y1, b.x2, b.y2)
      if (d < best) best = d
    }
    const sc = this.sc
    for (const cn of this.cones) {
      for (const side of [-1, 1]) {
        sincos(side * cn.half, sc)
        const ex = cn.dx * sc[1] - cn.dy * sc[0], ey = cn.dx * sc[0] + cn.dy * sc[1]
        const d = raySegment(ox, oy, dx, dy, cn.x, cn.y, cn.x + ex * cn.range, cn.y + ey * cn.range)
        if (d < best) best = d
      }
    }
    return best
  }

  /** The nearest timed hazard within HAZARD_RANGE ahead: distance, on/off, phase of its cycle, seconds to its next flip. */
  private nextHazard(x: number, obs: Float64Array, k: number): void {
    let bestDx = Infinity
    let active = 0, phase = 0, flip = 0
    const consider = (hx: number, on: boolean, ph: number, fl: number) => {
      const dx = hx - x
      // Only near: a policy from the earlier stages never saw these inputs move, and when a pulsing beam switched them
      // on from 6 m (then 3 m, right under the high beam) away, the population's gait fell apart there.
      if (dx < -0.4 || dx > HAZARD_RANGE || dx >= bestDx) return
      bestDx = dx
      active = on ? 1 : 0
      phase = ph
      flip = fl
    }
    for (const b of this.beams) if (b.phase >= 0) consider(Math.min(b.x1, b.x2), b.active, b.phase, Math.min(3, b.flip))
    for (const cn of this.cones) consider(cn.x - 1.2, true, cn.phase, 0)
    if (bestDx === Infinity) {
      obs[k++] = 1; obs[k++] = 0; obs[k++] = 0; obs[k++] = 0; obs[k] = 0
      return
    }
    const sc = this.sc
    sincos(6.283185307179586 * phase, sc)
    obs[k++] = Math.max(-1, Math.min(1, bestDx / HAZARD_RANGE))
    obs[k++] = active
    obs[k++] = sc[0]
    obs[k++] = sc[1]
    obs[k] = flip / 3
  }

  /** One control step: the policy acts (or `controls` if given), then the world takes its substeps. */
  step(controls?: ArrayLike<number>): void {
    if (this.done) return
    const { world, reward, creature: c, motors, targets } = this
    const u = controls ?? (this.policy ? this.policy.act(this.observe(), this.action) : this.action)
    if (u !== this.action) for (let i = 0; i < this.action.length; i++) this.action[i] = u[i] ?? 0
    const humanTargets = (this.policy || controls) ? this.human?.step(world, this.action, CONTROL_DT) : null
    for (let i = 0; i < motors.length; i++) {
      const j = world.joints[motors[i]!]!
      let a = this.action[i]!
      if (!(a === a)) a = 0
      if (a > 1) a = 1
      else if (a < -1) a = -1
      const goal = humanTargets ? Math.max(j.lower, Math.min(j.upper, humanTargets[i]!)) : a >= 0 ? a * j.upper : -a * j.lower
      targets[i]! += (goal - targets[i]!) * (this.human ? .18 : SMOOTHING)
      j.target = targets[i]!
    }
    for (let s = 0; s < SUBSTEPS; s++) {
      world.step(SUB_DT)
      this.realism?.energy(world, SUB_DT)
    }
    this.steps++
    this.time = this.steps * CONTROL_DT
    this.updateHazards()

    const t = this.torso
    let effort = 0
    for (const i of motors) {
      const j = world.joints[i]!
      const e = j.torque / j.maxTorque
      effort += e * e
    }
    effort /= motors.length
    const tilt = wrapAngle(t.a - c.upright)
    const upright = c.fallTilt === Infinity ? 0 : Math.max(0, 1 - (tilt * tilt) / (c.fallTilt * c.fallTilt))
    const gem = this.level.gem
    if (gem && !this.carrying) {
      const [mx, my] = this.gripAt()
      const dx = mx - gem.x, dy = my - gem.y
      const reach = this.human ? .16 : .35
      if (dx * dx + dy * dy < reach * reach) {
        this.carrying = true
        this.gemTime = this.time
        this.fitness += reward.gem
      }
    }
    const cap = gem && !this.carrying ? gem.x + 0.3 : Infinity
    const credited = Math.min(t.x, cap)
    // The upright bonus is per metre gained, not per second: per second, standing still in front of the first beam (or
    // the first wall) outscored walking into it, and the population never found out what lies past it.
    const gained = credited - this.credited
    this.fitness += reward.progress * gained * (1 + reward.upright * upright) - reward.effort * effort * CONTROL_DT
    // Human lesson zero also trains balance. Without survival shaping ES preferred an immediate collapse
    // to a longer, costly fall; later lessons remove this incentive to stand in front of a beam.
    if (this.human && this.env.task === "heist" && this.env.stage === 0) this.fitness += .5 * CONTROL_DT
    this.credited = credited
    if (this.realism) {
      const strength = reward.realism ?? 1
      this.fitness -= this.realism.step(world, this.level, this.time, CONTROL_DT, strength)
      // Mechanical effort, scaled by body weight; unlike torque-squared this charges fast flailing.
      let power = 0
      for (const j of world.joints) power += Math.abs(j.torque * jointSpeed(world.bodies, j))
      this.fitness -= strength * .2 * power / (75 * 9.81) * CONTROL_DT
    }
    const d = t.x - this.startX
    if (d > this.best) this.best = d

    // Alarms: a new one each time a beam is first touched or a camera first sees the creature.
    this.clearance = Infinity
    let exposed = 0
    if (this.beams.length) {
      const hit = beamContact(this.beams, world.bodies, this.n, this.contact)
      this.clearance = hit.clearance
      // Close counts a little before touching, so the gradient points away from the beam before it trips.
      exposed += hit.near
      for (let i = 0; i < this.beams.length; i++) this.debounce(i, (hit.mask >> i) & 1, i)
    }
    let seen = 0
    for (let i = 0; i < this.cones.length; i++) {
      const cn = this.cones[i]!
      const a = inCone(cn, t.x, t.y), b = inCone(cn, this.mouth.x, this.mouth.y)
      if (a || b) {
        seen |= 1 << i
        exposed += (a ? 1 : 0) + (b ? 1 : 0)
      }
    }
    for (let i = 0; i < this.cones.length; i++) this.debounce(this.beams.length + i, (seen >> i) & 1, -1 - i)
    if (exposed) {
      const cost = Math.min(reward.exposure * exposed * CONTROL_DT, EXPOSURE_CAP - this.exposure)
      if (cost > 0) {
        this.exposure += cost
        this.fitness -= cost
      }
    }

    let broken = false
    for (const b of world.bodies) if (!(b.x === b.x && b.y === b.y && b.a === b.a)) broken = true
    let fell = broken || Math.abs(tilt) > c.fallTilt
    for (const i of c.fallOn) if (world.bodies[i]!.ground) fell = true
    if (this.realism && (reward.realism ?? 1) > .5) fell ||= this.realism.fall || this.realism.illegalContactSeconds > .12
    if (reward.maxAlarms > 0 && this.alarms >= reward.maxAlarms) this.end("caught")
    else if (fell) {
      this.end("fell")
      this.fitness -= reward.fall
    } else if (t.x >= this.goal && (!gem || this.carrying)) {
      this.end("finished")
      this.fitness += reward.finish * Math.max(0, this.seconds - this.time) + (gem ? reward.escape / (1 + this.alarms) : 0)
    } else if (this.time >= this.seconds - 1e-9) this.end("timeout")
  }

  private debounce(slot: number, on: number, by: number): void {
    const n = on ? (this.broken[slot] ?? 0) + 1 : 0
    this.broken[slot] = n
    if (n === TRIP_STEPS) this.alarm(by)
  }

  private alarm(by: number): void {
    this.alarms++
    this.alarmBy = by
    this.alarmAt = this.time
    this.fitness -= this.reward.alarm
  }

  private end(o: Outcome): void {
    this.outcome = o
    this.done = true
  }

  get fell(): boolean {
    return this.outcome === "fell"
  }

  get finished(): boolean {
    return this.outcome === "finished"
  }

  result(): EpisodeResult {
    return { fitness: this.fitness, distance: this.distance, time: this.time, outcome: this.outcome, gem: this.carrying, alarms: this.alarms, ...(this.realism ? { gait: this.realism.metrics(this.distance) } : {}) }
  }
}

/** Runs one whole episode headless. */
export function evaluate(creature: CreatureId, env: TaskId | Env, shape: PolicyShape, params: Float64Array, reward: RewardSettings = DEFAULT_REWARD): EpisodeResult {
  const ep = new Episode(creature, env, new Policy(shape, params), reward)
  while (!ep.done) ep.step()
  return ep.result()
}
