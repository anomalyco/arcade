import { HUMAN } from "./human"
import { wrapAngle } from "./fmath"
import type { Level } from "./level"
import { jointSpeed, type World } from "./physics"

export type GaitMetrics = { cadence: number; strideLength: number; dutyFactor: number; costOfTransport: number | null; slip: number; steps: number; illegalContactSeconds: number; penalty: number }
/** Measured from loaded contacts, not the controller's desired phase. Work is absolute mechanical joint work,
 * not a metabolic estimate. A standing/failed run has undefined transport cost. */
export class HumanRealism {
  work = 0
  penalty = 0
  illegalContactSeconds = 0
  reason = ""
  fall = false
  steps = 0
  private stance = 0
  private samples = 0
  private slip = 0
  private contactSamples = 0
  private down = [true, true]
  private off = [0, 0]
  private lastTouch = [-1, -1]
  private lastX = [0, 0]
  private stride = 0
  private strides = 0
  private firstStep = -1
  private lastStep = -1
  private airborne = 0
  private lastSide = -1

  energy(world: World, dt: number): void {
    for (const j of world.joints) this.work += Math.abs(j.torque * jointSpeed(world.bodies, j)) * dt
  }

  step(world: World, level: Level, time: number, dt: number, strength: number): number {
    const bs = world.bodies, chest = bs[HUMAN.chest]!
    this.reason = ""
    const low = !!level.crawlZones?.some(z => chest.x >= z.x0 && chest.x <= z.x1 && chest.y < z.height)
    let cost = 0, illegal = false
    const loaded = new Set<number>()
    const forbidden = new Set<number>()
    let slip = 0, contacts = 0
    for (const c of world.contacts) {
      if (c.pn < .01 || c.sep > .006) continue
      loaded.add(c.a)
      if (c.b >= 0) loaded.add(c.b)
      if (c.a >= 3 && c.a <= 12 && !HUMAN.feet.includes(c.a as 5 | 8)) {
        const b = bs[c.a]!, along = b.c * c.rax + b.s * c.ray
        const hand = HUMAN.hands.includes(c.a as 10 | 12) && along > b.hl - .06
        const knee = (HUMAN.thighs.includes(c.a as 3 | 6) && along > b.hl - .06) || (HUMAN.shins.includes(c.a as 4 | 7) && along < -b.hl + .06)
        if (!(low && c.ny > .4 && (hand || knee))) forbidden.add(c.a)
      }
      if (HUMAN.feet.includes(c.a as 5 | 8) && c.ny > .5) {
        const b = bs[c.a]!, other = c.b < 0 ? null : bs[c.b]!
        const vx = b.vx - b.w * c.ray - (other ? other.vx - other.w * c.rby : 0)
        const vy = b.vy + b.w * c.rax - (other ? other.vy + other.w * c.rbx : 0)
        slip += Math.abs(-vx * c.ny + vy * c.nx)
        contacts++
      }
    }
    for (const i of loaded) {
      if (i > 12 || HUMAN.feet.includes(i as 5 | 8)) continue
      if (i === 0 || i === 1 || i === 2) {
        this.fall = true
        this.reason = "head / torso contact"
        illegal = true
      } else if (forbidden.has(i)) {
        illegal = true
        if (!this.reason) this.reason = "non-foot contact"
      }
    }
    if (illegal) { cost += 8 * dt; this.illegalContactSeconds += dt }
    if (contacts) {
      slip /= contacts
      this.slip += slip
      this.contactSamples++
      cost += 2 * slip * dt
      if (slip > .15 && !this.reason) this.reason = "foot slip"
    }
    if (!low) {
      const lean = Math.abs(wrapAngle(chest.a - Math.PI / 2))
      cost += 1.5 * Math.max(0, lean - .22) * dt
      if (lean > .5 && !this.reason) this.reason = "torso lean"
      // Penalise same-direction arm/leg swing, rather than forcing an animation pose.
      for (let side = 0; side < 2; side++) {
        const arm = wrapAngle(bs[HUMAN.arms[side]!]!.a + Math.PI / 2)
        const thigh = wrapAngle(bs[HUMAN.thighs[side]!]!.a + Math.PI / 2)
        cost += .15 * Math.max(0, arm * thigh) * dt
      }
      const vault = level.lasers.some(l => l.kind === "beam" && l.y1 < .35 && l.y2 < .35 && Math.abs(chest.x - l.x1) < .9)
      const supported = HUMAN.feet.some(f => loaded.has(f))
      this.airborne = supported ? 0 : this.airborne + dt
      if (!vault && this.airborne > .18) {
        cost += 2 * dt
        if (!this.reason) this.reason = "flight outside vault"
      }
      cost += Math.max(0, Math.abs(chest.vx) - 1.8) * dt
    }
    for (let side = 0; side < 2; side++) {
      const foot = bs[HUMAN.feet[side]!]!, on = loaded.has(HUMAN.feet[side]!) && foot.ground
      if (on) this.stance++
      this.off[side] = on ? 0 : this.off[side]! + dt
      if (!on && this.off[side]! >= .12) this.down[side] = false
      if (on && !this.down[side]) {
        this.down[side] = true
        this.steps++
        if (!low && side === this.lastSide) cost += .5
        this.lastSide = side
        if (this.firstStep < 0) this.firstStep = time
        this.lastStep = time
        if (this.lastTouch[side]! >= 0) {
          const period = time - this.lastTouch[side]!, length = Math.abs(foot.x - this.lastX[side]!)
          this.stride += length; this.strides++
          if (!low) cost += Math.max(0, .65 - period) + Math.max(0, length - 1.7) + (chest.vx > .3 ? Math.max(0, period - 2.5) * .2 : 0)
        }
        this.lastTouch[side] = time; this.lastX[side] = foot.x
      }
    }
    this.samples++
    const applied = cost * strength
    this.penalty += applied
    return applied
  }

  metrics(distance: number): GaitMetrics {
    return { cadence: this.steps > 1 ? (this.steps - 1) * 60 / (this.lastStep - this.firstStep) : 0,
      strideLength: this.strides ? this.stride / this.strides : 0, dutyFactor: this.samples ? this.stance / (2 * this.samples) : 0,
      costOfTransport: distance > .5 ? this.work / (75 * 9.81 * distance) : null,
      slip: this.contactSamples ? this.slip / this.contactSamples : 0, steps: this.steps, illegalContactSeconds: this.illegalContactSeconds, penalty: this.penalty }
  }
}
