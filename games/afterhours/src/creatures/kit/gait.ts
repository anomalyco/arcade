import * as THREE from "three/webgpu"

// A foot-planting stepper for any number of legs. Feet stay locked to the ground in world space; legs take turns in a
// fixed sequence (e.g. a lateral-sequence walk LH → LF → RH → RF) on a steady beat, each step an eased lifted arc to
// where its home spot will be half a cycle from now. Arcs start and end with zero velocity (smootherstep across, sin²
// up), and steps may overlap, so the motion is continuous. `pause` > 0 instead holds between steps (a jerky cadence).
// Idle feet that drift too far from home re-step on their own.

export type LegSpec = {
  /** Home foot position in the creature's root frame (x, z; y is taken from the ground). */
  home: THREE.Vector3
  /** Peak lift of a step (metres). */
  lift: number
}

export type Leg = {
  spec: LegSpec
  planted: THREE.Vector3
  from: THREE.Vector3
  to: THREE.Vector3
  /** Current foot position (world). */
  foot: THREE.Vector3
  /** 0..1 progress of the current swing, or -1 when planted. */
  swing: number
  /** Seconds since the foot landed (for impact jolts). */
  landed: number
}

const _h = new THREE.Vector3()

export class Stepper {
  legs: Leg[]
  /** Leg indices in stepping order. */
  order: number[]
  next = 0
  wait = 0
  /** Seconds per step (swing duration). */
  stepTime = 0.3
  /** Full cycle stride length (metres) at walking speed. */
  stride = 0.9
  /** Fraction of the inter-step interval spent paused before the next leg goes (0 = smooth, 0.6 = very jerky). */
  pause = 0

  constructor(
    specs: LegSpec[],
    order: number[],
    public ground: (x: number, z: number) => number,
  ) {
    this.order = order
    this.legs = specs.map((spec) => ({ spec, planted: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), foot: new THREE.Vector3(), swing: -1, landed: 9 }))
  }

  homeWorld(i: number, root: THREE.Object3D, vel: THREE.Vector3, lead: number, out: THREE.Vector3) {
    out.copy(this.legs[i]!.spec.home).applyMatrix4(root.matrixWorld)
    out.addScaledVector(vel, lead)
    out.y = this.ground(out.x, out.z)
    return out
  }

  /** Put every foot at home. */
  reset(root: THREE.Object3D) {
    root.updateMatrixWorld(true)
    this.legs.forEach((l, i) => {
      this.homeWorld(i, root, _h.set(0, 0, 0), 0, l.planted)
      l.foot.copy(l.planted)
      l.swing = -1
    })
  }

  /** Advance. `speed` scales cadence; `urgency` shortens steps and pauses (lunge). */
  update(dt: number, root: THREE.Object3D, vel: THREE.Vector3, urgency = 0) {
    const speed = Math.hypot(vel.x, vel.z)
    const cycle = speed > 0.02 ? Math.min(4, Math.max(0.45, this.stride / speed)) : 2.4
    const interval = cycle / this.legs.length
    // Steps may overlap the next leg's (a continuous walk) unless the cadence pauses between them.
    const stepTime = Math.min(this.stepTime * (1 - urgency * 0.4), interval * (this.pause > 0 ? 0.95 : 1.6))
    const lead = cycle * 0.5
    // Swing progress.
    for (const l of this.legs) {
      l.landed += dt
      if (l.swing < 0) {
        l.foot.copy(l.planted)
        continue
      }
      l.swing += dt / stepTime
      if (l.swing >= 1) {
        l.swing = -1
        l.planted.copy(l.to)
        l.foot.copy(l.to)
        l.landed = 0
        continue
      }
      const s = l.swing
      // Smootherstep across: zero velocity and acceleration at lift-off and touch-down.
      const e = s * s * s * (s * (s * 6 - 15) + 10)
      l.foot.lerpVectors(l.from, l.to, e)
      // Retarget the landing as the body keeps moving.
      this.homeWorld(this.legs.indexOf(l), root, vel, lead * (1 - s), _h)
      l.to.lerp(_h, Math.min(1, dt * 3) * (1 - s))
      // Lift peaks a little early (the foot clears, then settles), with zero vertical speed at both ends.
      const ls = Math.sin(Math.PI * Math.pow(s, 0.85))
      l.foot.y += l.spec.lift * ls * ls * (1 + urgency * 0.3)
    }
    // Scheduling.
    this.wait -= dt
    const moving = speed > 0.02
    const i = this.order[this.next]!
    const leg = this.legs[i]!
    this.homeWorld(i, root, vel, moving ? lead : 0, _h)
    const err = Math.hypot(leg.planted.x - _h.x, leg.planted.z - _h.z)
    const busy = this.pause > 0 && this.legs.some((l) => l.swing >= 0 && l.swing < 1 - this.pause * 0.5)
    if (this.wait <= 0 && leg.swing < 0 && !busy && (moving || err > 0.16)) {
      if (err > 0.04) {
        leg.from.copy(leg.planted)
        leg.to.copy(_h)
        leg.swing = 0
      }
      this.next = (this.next + 1) % this.order.length
      this.wait = moving ? interval * (1 - urgency * 0.4) : 0.18
    }
  }

  anySwinging() {
    return this.legs.some((l) => l.swing >= 0)
  }
}
