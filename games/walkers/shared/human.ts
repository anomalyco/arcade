// Sagittal-plane human, 1.75 m / 75 kg. Mass fractions: Winter, Biomechanics and Motor Control of Human
// Movement (4th ed.), anthropometry table. Trunk .497 is split chest .32 / pelvis .177; forearm + hand
// .016 + .006 are one rigid link. Lengths and COM fractions are rounded segment-table values, not a scan.
import type { BodyDef, CreatureDef, JointDef } from "./creatures"
import { wrapAngle } from "./fmath"
import { jointAngle, type World } from "./physics"

export const HUMAN = { pelvis: 0, chest: 1, head: 2, thighs: [3, 6], shins: [4, 7], feet: [5, 8], arms: [9, 11], hands: [10, 12] } as const
export function human(): CreatureDef {
  const up = Math.PI / 2, down = -up
  const bodies: BodyDef[] = [
    { name: "pelvis", x: 0, y: 1.015, a: up, hl: .07, r: .09, m: 75 * .177, part: "torso" },
    { name: "chest", x: 0, y: 1.30, a: up, hl: .13, r: .105, m: 75 * .32, part: "torso" },
    { name: "head", x: 0, y: 1.63, a: up, hl: .035, r: .105, m: 75 * .081, part: "head" },
  ]
  const joints: JointDef[] = [
    { name: "spine", a: 0, b: 1, x: 0, y: 1.11, lower: -.65, upper: .35, torque: 140, mode: "motor", kp: 8, maxSpeed: 4 },
    { name: "neck", a: 1, b: 2, x: 0, y: 1.51, lower: -.55, upper: .65, torque: 18, mode: "spring", kp: 6, maxSpeed: 4 },
  ]
  for (let side = 0; side < 2; side++) {
    const n = bodies.length, far = side === 0, suffix = far ? "L" : "R"
    bodies.push(
      { name: `thigh ${suffix}`, x: 0, y: .94 - .433 * .43, a: down, hl: .155, r: .06, m: 75 * .10, far, part: "leg" },
      { name: `shin ${suffix}`, x: 0, y: .51 - .433 * .43, a: down, hl: .175, r: .038, m: 75 * .0465, far, part: "leg" },
      { name: `foot ${suffix}`, x: .055, y: .045, a: 0, hl: .095, r: .04, m: 75 * .0145, friction: 1.1, far, part: "paw" },
    )
    joints.push(
      { name: `hip ${suffix}`, a: 0, b: n, x: 0, y: .94, lower: -.45, upper: 2.1, torque: 190, mode: "motor", kp: 8, maxSpeed: 7 },
      { name: `knee ${suffix}`, a: n, b: n + 1, x: 0, y: .51, lower: -2.5, upper: 0, torque: 150, mode: "motor", kp: 8, maxSpeed: 9 },
      { name: `ankle ${suffix}`, a: n + 1, b: n + 2, x: 0, y: .08, lower: -.65, upper: .4, torque: 110, mode: "motor", kp: 8, maxSpeed: 6 },
    )
  }
  for (let side = 0; side < 2; side++) {
    const n = bodies.length, far = side === 0, suffix = far ? "L" : "R"
    bodies.push(
      { name: `upper arm ${suffix}`, x: 0, y: 1.44 - .436 * .326, a: down, hl: .128, r: .035, m: 75 * .028, far, part: "arm" },
      // Forearm .146H + hand .108H combined. Collision capsule is centred approximately on the combined COM.
      { name: `forearm + hand ${suffix}`, x: 0, y: .90, a: down, hl: .192, r: .03, m: 75 * .022, far, part: "arm" },
    )
    joints.push(
      { name: `shoulder ${suffix}`, a: 1, b: n, x: 0, y: 1.44, lower: -.65, upper: 2.8, torque: 55, mode: "motor", kp: 8, maxSpeed: 7 },
      { name: `elbow ${suffix}`, a: n, b: n + 1, x: 0, y: 1.114, lower: 0, upper: 2.5, torque: 35, mode: "motor", kp: 8, maxSpeed: 8 },
    )
  }
  return { id: "human", label: "Human", blurb: "75 kg human. Limited muscles, one-way knees, heel and toe contacts.", bodies, joints, torso: 1, upright: up, mouth: 12, feet: [5, 8], fallOn: [0, 1, 2], fallTilt: Infinity }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))
/** Phase-conditioned PD targets with an authored ankle/hip balance reflex and counter-swing prior.
 * Both are ordinary target offsets: the policy can override them and all muscle limits still apply.
 * No body positions, velocities or contact locks are imposed. A sinusoidal leg cycle was tried first,
 * but trapped ES in a backwards-falling local optimum (800 generations). */
export class HumanControl {
  phase = 0
  pace = .8
  readonly targets = new Float64Array(11)
  step(world: World, action: Float64Array, dt: number): Float64Array {
    const pace = Number.isFinite(action[11]) ? action[11]! : 0
    this.pace += (clamp(.8 + pace * .65, .15, 1.45) - this.pace) * .08
    this.phase += dt * this.pace
    const out = this.targets
    let k = 0
    for (let i = 0; i < 12; i++) {
      if (i === 1) continue // passive neck
      const j = world.joints[i]!, raw = action[k] ?? 0
      const a = Number.isFinite(raw) ? clamp(raw, -1, 1) : 0
      out[k++] = a >= 0 ? a * j.upper : -a * j.lower
    }
    const chest = world.bodies[1]!, tilt = wrapAngle(chest.a - Math.PI / 2)
    for (let side = 0; side < 2; side++) {
      if (world.bodies[HUMAN.feet[side]!]!.ground) {
        out[3 + side * 3]! += 4 * tilt + 1.5 * chest.w
        out[1 + side * 3]! += tilt + .3 * chest.w
      }
      out[7 + side * 2]! -= .4 * jointAngle(world.bodies, world.joints[2 + side * 3]!)
    }
    return out
  }
}
