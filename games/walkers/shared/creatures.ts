// Creature morphologies as plain data: capsules (centre, angle, half-length, radius, mass) and revolute joints (world
// anchor in the standing pose, limits, max torque). All face +x. Angles: a capsule's core lies along its local x axis.

export type BodyDef = {
  name: string
  x: number
  y: number
  a: number
  hl: number
  r: number
  m: number
  /** Drawn behind the rest (the far legs). */
  far?: boolean
}

export type JointDef = { name: string; a: number; b: number; x: number; y: number; lower: number; upper: number; torque: number }

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
  /** Bodies with ground-contact sensors. */
  feet: number[]
  /** Ground contact on any of these ends the episode as a fall. */
  fallOn: number[]
  /** Torso tilt (radians from upright) that counts as a fall; Infinity for none. */
  fallTilt: number
}

export type CreatureId = "biped" | "quadruped" | "worm"

const UP = Math.PI / 2
const DOWN = -Math.PI / 2

function biped(): CreatureDef {
  const thigh = 0.23, shin = 0.23
  const footR = 0.05
  const hipY = footR + 4 * thigh + 0.02
  const torsoHl = 0.22, torsoR = 0.12
  const bodies: BodyDef[] = [
    { name: "torso", x: 0, y: hipY + torsoHl + 0.02, a: UP, hl: torsoHl, r: torsoR, m: 14 },
    { name: "thigh L", x: 0, y: hipY - thigh, a: DOWN, hl: thigh, r: 0.065, m: 4, far: true },
    { name: "shin L", x: 0, y: hipY - 3 * thigh, a: DOWN, hl: shin, r: footR, m: 2.5, far: true },
    { name: "thigh R", x: 0, y: hipY - thigh, a: DOWN, hl: thigh, r: 0.065, m: 4 },
    { name: "shin R", x: 0, y: hipY - 3 * thigh, a: DOWN, hl: shin, r: footR, m: 2.5 },
  ]
  const kneeY = hipY - 2 * thigh
  return {
    id: "biped",
    label: "Biped",
    blurb: "Torso, two thighs, two shins. Has to balance.",
    bodies,
    joints: [
      { name: "hip L", a: 0, b: 1, x: 0, y: hipY, lower: -0.7, upper: 1.7, torque: 140 },
      { name: "knee L", a: 1, b: 2, x: 0, y: kneeY, lower: -2.3, upper: 0.05, torque: 100 },
      { name: "hip R", a: 0, b: 3, x: 0, y: hipY, lower: -0.7, upper: 1.7, torque: 140 },
      { name: "knee R", a: 3, b: 4, x: 0, y: kneeY, lower: -2.3, upper: 0.05, torque: 100 },
    ],
    torso: 0,
    upright: UP,
    feet: [2, 4],
    fallOn: [0, 1, 3],
    fallTilt: 1.1,
  }
}

function quadruped(): CreatureDef {
  const thigh = 0.16, shin = 0.16
  const footR = 0.045
  const hipY = footR + 4 * thigh + 0.02
  const half = 0.42
  const bodies: BodyDef[] = [{ name: "torso", x: 0, y: hipY + 0.02, a: 0, hl: half + 0.06, r: 0.11, m: 16 }]
  const joints: JointDef[] = []
  const legs: [string, number, boolean][] = [["back far", -half, true], ["front far", half, true], ["back", -half, false], ["front", half, false]]
  const feet: number[] = []
  const thighs: number[] = []
  for (const [name, x, far] of legs) {
    const t = bodies.length
    bodies.push({ name: `${name} thigh`, x, y: hipY - thigh, a: DOWN, hl: thigh, r: 0.055, m: 2.2, far })
    bodies.push({ name: `${name} shin`, x, y: hipY - 3 * thigh, a: DOWN, hl: shin, r: footR, m: 1.2, far })
    const front = x > 0
    joints.push({ name: `${name} hip`, a: 0, b: t, x, y: hipY, lower: -1.2, upper: 1.2, torque: 70 })
    // Front knees fold backward, back knees forward (hocks), like most quadrupeds.
    joints.push(front
      ? { name: `${name} knee`, a: t, b: t + 1, x, y: hipY - 2 * thigh, lower: -2.0, upper: 0.1, torque: 50 }
      : { name: `${name} knee`, a: t, b: t + 1, x, y: hipY - 2 * thigh, lower: -0.1, upper: 2.0, torque: 50 })
    feet.push(t + 1)
    thighs.push(t)
  }
  return {
    id: "quadruped",
    label: "Quadruped",
    blurb: "A long torso on four two-part legs. Stable, learns fast.",
    bodies,
    joints,
    torso: 0,
    upright: 0,
    feet,
    fallOn: [0],
    fallTilt: 1.3,
  }
}

function worm(): CreatureDef {
  const n = 5, hl = 0.15, r = 0.08
  const bodies: BodyDef[] = []
  const joints: JointDef[] = []
  for (let i = 0; i < n; i++) {
    bodies.push({ name: `segment ${i + 1}`, x: (i - (n - 1) / 2) * 2 * hl, y: r + 0.005, a: 0, hl, r, m: 2 })
    if (i > 0) joints.push({ name: `bend ${i}`, a: i - 1, b: i, x: bodies[i]!.x - hl, y: r + 0.005, lower: -1.3, upper: 1.3, torque: 16 })
  }
  return {
    id: "worm",
    label: "Inchworm",
    blurb: "Five segments in a chain. No legs, all wiggle.",
    bodies,
    joints,
    torso: 2,
    upright: 0,
    feet: [0, 1, 2, 3, 4],
    fallOn: [],
    fallTilt: Infinity,
  }
}

export const CREATURES: Record<CreatureId, CreatureDef> = { biped: biped(), quadruped: quadruped(), worm: worm(), }
export const CREATURE_IDS = Object.keys(CREATURES) as CreatureId[]
