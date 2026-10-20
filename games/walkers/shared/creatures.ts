// Creature morphologies as plain data: capsules (centre, angle, half-length, radius, mass, friction) and revolute
// joints (world anchor in the standing pose, limits, motor). All face +x; a capsule's core lies along its local x.
//
// Actuated joints ("motor") take a target angle from the policy: u ∈ [-1, 1] maps to [lower, upper] with 0 at the
// creation pose. The motor drives toward it at up to maxSpeed with at most maxTorque, so commands come out as
// compliant, rate-limited movements rather than torque spikes. Passive joints ("spring") pull back to the creation
// pose with a small torque (ankles, tail).

import { human } from "./human"

export type BodyDef = {
  name: string
  x: number
  y: number
  a: number
  hl: number
  r: number
  m: number
  friction?: number
  /** Drawn behind the rest (the far legs). */
  far?: boolean
  /** Drawing role, for colour. */
  part?: "torso" | "head" | "tail" | "leg" | "paw" | "arm"
}

export type JointDef = {
  name: string
  a: number
  b: number
  x: number
  y: number
  lower: number
  upper: number
  mode: "motor" | "spring"
  torque: number
  kp?: number
  maxSpeed?: number
}

export type CreatureDef = {
  id: CreatureId
  label: string
  blurb: string
  bodies: BodyDef[]
  joints: JointDef[]
  /** Body whose position is progress and whose tilt is uprightness. */
  torso: number
  /** Torso angle when upright. */
  upright: number
  /** Body that grabs the gem (the mouth). */
  mouth: number
  /** Bodies with contact sensors. */
  feet: number[]
  /** Floor contact on any of these ends the episode as a fall. */
  fallOn: number[]
  /** Torso tilt (radians from upright) that counts as a fall; Infinity for none. */
  fallTilt: number
}

export type CreatureId = "human" | "biped" | "quadruped" | "worm"

const UP = Math.PI / 2
const DOWN = -Math.PI / 2

function biped(): CreatureDef {
  const thigh = 0.23, shin = 0.23
  const footR = 0.05
  const hipY = footR + 4 * thigh + 0.02
  const torsoHl = 0.22, torsoR = 0.12
  const bodies: BodyDef[] = [
    { name: "torso", x: 0, y: hipY + torsoHl + 0.02, a: UP, hl: torsoHl, r: torsoR, m: 14, part: "torso" },
    { name: "thigh L", x: 0, y: hipY - thigh, a: DOWN, hl: thigh, r: 0.065, m: 4, far: true, part: "leg" },
    { name: "shin L", x: 0, y: hipY - 3 * thigh, a: DOWN, hl: shin, r: footR, m: 2.5, far: true, friction: 1.1, part: "paw" },
    { name: "thigh R", x: 0, y: hipY - thigh, a: DOWN, hl: thigh, r: 0.065, m: 4, part: "leg" },
    { name: "shin R", x: 0, y: hipY - 3 * thigh, a: DOWN, hl: shin, r: footR, m: 2.5, friction: 1.1, part: "paw" },
  ]
  const kneeY = hipY - 2 * thigh
  const hip = { lower: -0.7, upper: 1.7, mode: "motor" as const, torque: 150, kp: 14, maxSpeed: 12 }
  const knee = { lower: -2.3, upper: 0.05, mode: "motor" as const, torque: 110, kp: 14, maxSpeed: 12 }
  return {
    id: "biped",
    label: "Biped",
    blurb: "Torso, two thighs, two shins. Has to balance.",
    bodies,
    joints: [
      { name: "hip L", a: 0, b: 1, x: 0, y: hipY, ...hip },
      { name: "knee L", a: 1, b: 2, x: 0, y: kneeY, ...knee },
      { name: "hip R", a: 0, b: 3, x: 0, y: hipY, ...hip },
      { name: "knee R", a: 3, b: 4, x: 0, y: kneeY, ...knee },
    ],
    torso: 0,
    upright: UP,
    mouth: 0,
    feet: [2, 4],
    fallOn: [0, 1, 3],
    fallTilt: 1.1,
  }
}

/**
 * Quadruped v2: chest and hips joined by an actuated spine, a head on an actuated neck (it carries the gem), a springy
 * tail, and four legs of thigh, shin and a grippy paw on a springy ankle. Front knees fold back, back hocks forward.
 */
function quadruped(): CreatureDef {
  const thigh = 0.11, shin = 0.11, pawHl = 0.04, pawR = 0.03
  const ankleY = pawR + 0.004
  const kneeY = ankleY + 2 * shin
  const hipY = kneeY + 2 * thigh
  const bodyY = hipY + 0.02
  const bodies: BodyDef[] = [
    { name: "chest", x: 0.2, y: bodyY, a: 0, hl: 0.17, r: 0.1, m: 8, friction: 0.5, part: "torso" },
    { name: "hips", x: -0.2, y: bodyY, a: 0, hl: 0.17, r: 0.095, m: 6, friction: 0.5, part: "torso" },
    { name: "head", x: 0.5, y: bodyY + 0.13, a: 0.55, hl: 0.07, r: 0.075, m: 1.5, friction: 0.5, part: "head" },
    { name: "tail", x: -0.5, y: bodyY + 0.06, a: Math.PI - 0.35, hl: 0.13, r: 0.022, m: 0.35, friction: 0.4, part: "tail" },
  ]
  const joints: JointDef[] = [
    { name: "spine", a: 1, b: 0, x: 0, y: bodyY, lower: -0.45, upper: 0.45, mode: "motor", torque: 110, kp: 8, maxSpeed: 10 },
    // Actuated so the thief can duck its head under a beam (with a spring neck, the head bobbed into it).
    { name: "neck", a: 0, b: 2, x: 0.42, y: bodyY + 0.07, lower: -0.9, upper: 0.4, mode: "motor", torque: 30, kp: 8, maxSpeed: 8 },
    { name: "tail", a: 1, b: 3, x: -0.38, y: bodyY + 0.02, lower: -0.8, upper: 0.8, mode: "spring", torque: 5, kp: 6, maxSpeed: 8 },
  ]
  const feet: number[] = []
  const legs: [string, number, number, boolean][] = [["back far", -0.3, 1, true], ["front far", 0.3, 0, true], ["back", -0.3, 1, false], ["front", 0.3, 0, false]]
  for (const [name, x, parent, far] of legs) {
    const t = bodies.length
    bodies.push({ name: `${name} thigh`, x, y: hipY - thigh, a: DOWN, hl: thigh, r: 0.048, m: 1.3, friction: 0.5, far, part: "leg" })
    bodies.push({ name: `${name} shin`, x, y: kneeY - shin, a: DOWN, hl: shin, r: 0.036, m: 0.6, friction: 0.6, far, part: "leg" })
    bodies.push({ name: `${name} paw`, x: x + pawHl, y: ankleY, a: 0, hl: pawHl, r: pawR, m: 0.3, friction: 1.4, far, part: "paw" })
    const front = x > 0
    joints.push({ name: `${name} hip`, a: parent, b: t, x, y: hipY, lower: -1.1, upper: 1.1, mode: "motor", torque: 60, kp: 8, maxSpeed: 12 })
    joints.push(front
      ? { name: `${name} knee`, a: t, b: t + 1, x, y: kneeY, lower: -1.9, upper: 0.15, mode: "motor", torque: 45, kp: 8, maxSpeed: 12 }
      : { name: `${name} hock`, a: t, b: t + 1, x, y: kneeY, lower: -0.15, upper: 1.9, mode: "motor", torque: 45, kp: 8, maxSpeed: 12 })
    joints.push({ name: `${name} ankle`, a: t + 1, b: t + 2, x, y: ankleY, lower: -0.8, upper: 0.7, mode: "spring", torque: 16, kp: 10, maxSpeed: 10 })
    feet.push(t + 2)
  }
  return {
    id: "quadruped",
    label: "Quadruped",
    blurb: "Spine, head, tail, paws on springy ankles. The thief.",
    bodies,
    joints,
    torso: 0,
    upright: 0,
    mouth: 2,
    feet,
    // Not the head: nosing the floor (ducking under a beam, stepping up a wall) isn't a fall.
    fallOn: [0, 1],
    fallTilt: 1.0,
  }
}

function worm(): CreatureDef {
  const n = 5, hl = 0.15, r = 0.08
  const bodies: BodyDef[] = []
  const joints: JointDef[] = []
  for (let i = 0; i < n; i++) {
    bodies.push({ name: `segment ${i + 1}`, x: (i - (n - 1) / 2) * 2 * hl, y: r + 0.005, a: 0, hl, r, m: 2, friction: 0.9, part: i === n - 1 ? "head" : "torso" })
    if (i > 0) joints.push({ name: `bend ${i}`, a: i - 1, b: i, x: bodies[i]!.x - hl, y: r + 0.005, lower: -1.3, upper: 1.3, mode: "motor", torque: 30, kp: 12, maxSpeed: 14 })
  }
  return {
    id: "worm",
    label: "Inchworm",
    blurb: "Five segments in a chain. No legs, all wiggle.",
    bodies,
    joints,
    torso: 2,
    upright: 0,
    mouth: 4,
    feet: [0, 1, 2, 3, 4],
    fallOn: [],
    fallTilt: Infinity,
  }
}

export const CREATURES: Record<CreatureId, CreatureDef> = { human: human(), biped: biped(), quadruped: quadruped(), worm: worm() }
export const CREATURE_IDS = Object.keys(CREATURES) as CreatureId[]

/** Indices of the joints the policy drives. */
export const actuated = (c: CreatureDef): number[] => c.joints.flatMap((j, i) => (j.mode === "motor" ? [i] : []))
