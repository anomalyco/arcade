// One creature in one task: builds its world, turns the body into an observation vector, runs the policy at the control
// rate and scores the run. Fitness is roughly "metres gained", plus a small upright bonus, minus effort and falls.

import { CREATURES, type CreatureDef, type CreatureId } from "./creatures"
import { sincos, wrapAngle } from "./fmath"
import { DEFAULT_PHYSICS, World, groundHeight, jointAngle, jointSpeed, makeBody, makeJoint, makeTerrain, type Terrain } from "./physics"
import { Policy, type PolicyShape } from "./policy"
import { TASKS, type TaskId } from "./tasks"

export const CONTROL_HZ = 60
export const SUBSTEPS = 2
export const CONTROL_DT = 1 / CONTROL_HZ
const SUB_DT = CONTROL_DT / SUBSTEPS
const LOOKAHEAD = [0.4, 0.8, 1.2, 1.6]

export type RewardSettings = {
  /** Episode length (s). */
  seconds: number
  /** Points per metre of forward torso travel. */
  progress: number
  /** Points per second of fully upright torso. */
  upright: number
  /** Points lost per second at full torque on every joint. */
  effort: number
  /** Points lost for a fall (the run ends). */
  fall: number
  /** Points per second left when the torso crosses the goal. */
  finish: number
  /** Period of the clock the policy sees (s). */
  phase: number
}

export const DEFAULT_REWARD: RewardSettings = { seconds: 14, progress: 1, upright: 0.15, effort: 0.04, fall: 1.5, finish: 0.5, phase: 0.9 }

export type EpisodeResult = { fitness: number; distance: number; time: number; fell: boolean; finished: boolean }

export const observationSize = (c: CreatureDef): number => 6 + 2 * c.joints.length + c.feet.length + 2 + LOOKAHEAD.length
export const policyShape = (id: CreatureId, hidden: number): PolicyShape => {
  const c = CREATURES[id]
  return { inputs: observationSize(c), hidden, outputs: c.joints.length }
}

const terrains = new Map<TaskId, Terrain>()
export function terrainFor(task: TaskId): Terrain {
  let t = terrains.get(task)
  if (!t) terrains.set(task, (t = makeTerrain(TASKS[task].points)))
  return t
}

export class Episode {
  readonly creature: CreatureDef
  readonly world: World
  readonly obs: Float64Array
  readonly action: Float64Array
  readonly goal: number
  time = 0
  steps = 0
  fitness = 0
  done = false
  fell = false
  finished = false
  /** Furthest torso x (m from the start). */
  best = 0
  private startX: number
  private lastX: number
  private sc: [number, number] = [0, 0]

  constructor(creature: CreatureId, readonly task: TaskId, readonly policy: Policy | null, readonly reward: RewardSettings = DEFAULT_REWARD) {
    const def = CREATURES[creature]
    this.creature = def
    const terrain = terrainFor(task)
    const bodies = def.bodies.map((b) => makeBody(b.x, b.y + groundHeight(terrain, b.x), b.a, b.hl, b.r, b.m))
    const joints = def.joints.map((j) => makeJoint(bodies, j.a, j.b, j.x, j.y + groundHeight(terrain, j.x), j.lower, j.upper, j.torque))
    this.world = new World(bodies, joints, terrain, DEFAULT_PHYSICS)
    this.obs = new Float64Array(observationSize(def))
    this.action = new Float64Array(def.joints.length)
    this.goal = TASKS[task].goal
    this.startX = bodies[def.torso]!.x
    this.lastX = this.startX
  }

  get torso() {
    return this.world.bodies[this.creature.torso]!
  }

  get distance(): number {
    return this.torso.x - this.startX
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
    const ground = groundHeight(world.terrain, t.x)
    obs[k++] = (t.y - ground) - (c.bodies[c.torso]!.y)
    for (const j of world.joints) {
      obs[k++] = jointAngle(bodies, j)
      obs[k++] = jointSpeed(bodies, j) * 0.1
    }
    for (const f of c.feet) obs[k++] = bodies[f]!.contact ? 1 : 0
    sincos((6.283185307179586 * this.time) / this.reward.phase, sc)
    obs[k++] = sc[0]
    obs[k++] = sc[1]
    for (const dx of LOOKAHEAD) obs[k++] = Math.max(-1, Math.min(1, (groundHeight(world.terrain, t.x + dx) - ground) * 3))
    return obs
  }

  /** One control step: the policy acts (or `controls` if given), then the world takes its substeps. */
  step(controls?: ArrayLike<number>): void {
    if (this.done) return
    const { world, reward, creature: c } = this
    const u = controls ?? (this.policy ? this.policy.act(this.observe(), this.action) : this.action)
    if (u !== this.action) for (let i = 0; i < this.action.length; i++) this.action[i] = u[i] ?? 0
    for (let s = 0; s < SUBSTEPS; s++) world.step(SUB_DT, this.action)
    this.steps++
    this.time = this.steps * CONTROL_DT

    const t = this.torso
    let effort = 0
    for (let i = 0; i < this.action.length; i++) effort += this.action[i]! * this.action[i]!
    effort /= this.action.length
    const tilt = wrapAngle(t.a - c.upright)
    const upright = c.fallTilt === Infinity ? 0 : Math.max(0, 1 - (tilt * tilt) / (c.fallTilt * c.fallTilt))
    this.fitness += reward.progress * (t.x - this.lastX) + (reward.upright * upright - reward.effort * effort) * CONTROL_DT
    this.lastX = t.x
    const d = t.x - this.startX
    if (d > this.best) this.best = d

    let broken = false
    for (const b of world.bodies) if (!(Math.abs(b.vx) + Math.abs(b.vy) < 200) || !(Math.abs(b.w) < 400)) broken = true
    let fell = broken || Math.abs(tilt) > c.fallTilt
    for (const i of c.fallOn) if (world.bodies[i]!.contact) fell = true
    if (fell) {
      this.fell = true
      this.done = true
      this.fitness -= reward.fall
    } else if (d >= this.goal) {
      this.finished = true
      this.done = true
      this.fitness += reward.finish * Math.max(0, reward.seconds - this.time)
    } else if (this.time >= reward.seconds - 1e-9) this.done = true
  }

  result(): EpisodeResult {
    return { fitness: this.fitness, distance: this.distance, time: this.time, fell: this.fell, finished: this.finished }
  }
}

/** Runs one whole episode headless. */
export function evaluate(creature: CreatureId, task: TaskId, shape: PolicyShape, params: Float64Array, reward: RewardSettings = DEFAULT_REWARD): EpisodeResult {
  const ep = new Episode(creature, task, new Policy(shape, params), reward)
  while (!ep.done) ep.step()
  return ep.result()
}
