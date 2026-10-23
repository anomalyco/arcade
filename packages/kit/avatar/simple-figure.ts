import { MAT, Mesh, type Mat } from "../gpu/mesh"

/**
 * Simple single-tone figures for the shared rig's bones: smooth matte surfaces, no texture or colour detail, so a
 * player character reads by silhouette and motion against a detailed world (the Big Walk / Playdead rule,
 * docs/research/rendering-techniques.md §7). Each mesh sits in the bone's local frame the way Outbreak's box survivor does:
 * limbs hang along −Y from their joint, X points forward, the torso rises from the waist, the head from the neck,
 * the foot hangs from the ankle and the toe starts at the ball.
 *
 * Vertices are white `MAT.cloth`, so the instance tint colours the whole figure and shaders treat it as an actor.
 * `aux` marks the figure for a game's own hero shading (Outbreak's flat tone and tight rim).
 */
export type SimpleFigureShape = "mannequin" | "capsule"

export type SimpleFigureBone = "pelvis" | "torso" | "head" | "upperArm" | "foreArm" | "thigh" | "shin" | "foot" | "toe"

export type SimpleFigureOptions = { aux?: number; mat?: Mat; segments?: number }

type Profile = readonly (readonly [number, number])[]

const WHITE = [1, 1, 1] as const

/**
 * Smooth body of revolution around the `axis` through `centre`: `profile` lists (position along the axis, radius
 * scale) pairs, closed when the end radii are 0; `sa`/`sb` scale the cross-section on the two other axes.
 */
export function lathe(
  m: Mesh,
  centre: readonly [number, number, number],
  axis: "x" | "y",
  profile: Profile,
  sa: number,
  sb: number,
  segments: number,
  mat: Mat,
  aux: number,
  color: readonly [number, number, number] = WHITE,
): void {
  const rings = profile.length
  // Points and normals in (along, a, b) space: along is the axis, a and b span the cross-section.
  const pt = (i: number, j: number) => {
    const [t, r] = profile[i]!
    const th = (j / segments) * Math.PI * 2
    return [t, sa * r * Math.cos(th), sb * r * Math.sin(th)] as const
  }
  const nrm = (i: number, j: number) => {
    const prev = profile[Math.max(0, i - 1)]!
    const next = profile[Math.min(rings - 1, i + 1)]!
    const dt = next[0] - prev[0]
    const dr = next[1] - prev[1]
    const th = (j / segments) * Math.PI * 2
    const c = Math.cos(th)
    const s = Math.sin(th)
    // Tangents along the profile (dt, sa·dr·c, sb·dr·s) and around (0, −sa·s, sb·c); profiles run in increasing t,
    // so the outward normal is their cross product negated.
    const n = [-sa * sb * dr, dt * sb * c, dt * sa * s]
    const l = Math.hypot(n[0]!, n[1]!, n[2]!) || 1
    return [n[0]! / l, n[1]! / l, n[2]! / l] as const
  }
  const world = (q: readonly [number, number, number]): [number, number, number] =>
    axis === "y" ? [centre[0] + q[1], centre[1] + q[0], centre[2] + q[2]] : [centre[0] + q[0], centre[1] + q[2], centre[2] + q[1]]
  const worldN = (q: readonly [number, number, number]): [number, number, number] =>
    axis === "y" ? [q[1], q[0], q[2]] : [q[0], q[2], q[1]]
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    const pa = world(pt(...a)), pb = world(pt(...b)), pc = world(pt(...c))
    const na = worldN(nrm(...a)), nb = worldN(nrm(...b)), nc = worldN(nrm(...c))
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]]
    const f = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!]
    const area = Math.hypot(f[0]!, f[1]!, f[2]!)
    if (area < 1e-10) return
    const avg = [na[0] + nb[0] + nc[0], na[1] + nb[1] + nc[1], na[2] + nb[2] + nc[2]]
    // Counter-clockwise seen from outside.
    const ccw = f[0]! * avg[0]! + f[1]! * avg[1]! + f[2]! * avg[2]! >= 0
    const order = ccw ? [[pa, na], [pb, nb], [pc, nc]] : [[pa, na], [pc, nc], [pb, nb]]
    for (const [p, n] of order) m.vert(p!, n!, color, mat, aux)
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const j1 = (j + 1) % segments
      tri([i, j], [i + 1, j], [i + 1, j1])
      tri([i, j], [i + 1, j1], [i, j1])
    }
  }
}

/** Ellipsoid profile with `rings` latitude steps, from −1 to 1 along the axis. */
function ellipse(rings: number, half: number, centre = 0): Profile {
  return Array.from({ length: rings + 1 }, (_, i) => {
    const a = Math.PI * (i / rings - 0.5)
    return [centre + Math.sin(a) * half, Math.cos(a)] as const
  })
}

/** Capsule profile from `y0` (radius `r0`) to `y1` (radius `r1`) with hemispherical ends, radii normalised to 1. */
function capsule(y0: number, y1: number, r0: number, r1: number, capRings = 3): Profile {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  const rLo = y0 < y1 ? r0 : r1
  const rHi = y0 < y1 ? r1 : r0
  const out: [number, number][] = []
  for (let i = 0; i <= capRings; i++) {
    const a = (Math.PI / 2) * (i / capRings)
    out.push([lo + rLo - Math.cos(a) * rLo, Math.sin(a) * rLo])
  }
  for (let i = 0; i <= capRings; i++) {
    const a = (Math.PI / 2) * (i / capRings)
    out.push([hi - rHi + Math.sin(a) * rHi, Math.cos(a) * rHi])
  }
  return out
}

function ellipsoid(m: Mesh, c: readonly [number, number, number], r: readonly [number, number, number], seg: number, mat: Mat, aux: number, rings = 8) {
  lathe(m, [c[0], c[1], c[2]], "y", ellipse(rings, r[1]), r[0], r[2], seg, mat, aux)
}

function limb(m: Mesh, top: number, bottom: number, rTop: number, rBottom: number, seg: number, mat: Mat, aux: number, flatten = 1) {
  // Radii are absolute; the lathe scales its unit cross-section by 1 so the profile carries them.
  lathe(m, [0, 0, 0], "y", capsule(bottom, top, rBottom, rTop), 1, flatten, seg, mat, aux)
}

/** One mesh per bone for the given shape. */
export function simpleFigureMeshes(shape: SimpleFigureShape, opts: SimpleFigureOptions = {}): Record<SimpleFigureBone, Mesh> {
  const mat = opts.mat ?? MAT.cloth
  const aux = opts.aux ?? 0
  const seg = opts.segments ?? 14
  const out = {} as Record<SimpleFigureBone, Mesh>
  for (const bone of ["pelvis", "torso", "head", "upperArm", "foreArm", "thigh", "shin", "foot", "toe"] as const) out[bone] = new Mesh()
  if (shape === "mannequin") {
    // An artist's mannequin: slender tapered segments, an egg head with no face, mitten hands and rounded shoes.
    ellipsoid(out.pelvis, [0, 0.02, 0], [0.105, 0.1, 0.15], seg, mat, aux)
    lathe(out.torso, [0, 0, 0], "y", [
      [-0.04, 0], [-0.025, 0.6], [0.05, 0.7], [0.18, 0.84], [0.32, 0.98], [0.4, 1], [0.46, 0.84], [0.5, 0.5], [0.515, 0],
    ], 0.125, 0.19, seg, mat, aux)
    limb(out.head, 0.07, -0.02, 0.042, 0.042, seg, mat, aux)
    ellipsoid(out.head, [0.012, 0.15, 0], [0.092, 0.118, 0.082], seg, mat, aux)
    limb(out.upperArm, 0.035, -0.29, 0.054, 0.043, seg, mat, aux)
    limb(out.foreArm, 0.02, -0.235, 0.042, 0.033, seg, mat, aux)
    ellipsoid(out.foreArm, [0.004, -0.275, 0], [0.036, 0.058, 0.043], seg, mat, aux, 6)
    limb(out.thigh, 0.035, -0.42, 0.083, 0.058, seg, mat, aux)
    limb(out.shin, 0.02, -0.395, 0.056, 0.042, seg, mat, aux)
    lathe(out.foot, [0, -0.043, 0], "x", ellipse(7, 0.104, 0.024), 0.054, 0.04, seg, mat, aux)
    lathe(out.toe, [0, 0.03, 0], "x", ellipse(6, 0.04, 0.026), 0.05, 0.03, seg, mat, aux)
  } else {
    // A toy of capsules: a bean torso, a ball head, even round limbs, ball hands and nub feet.
    ellipsoid(out.pelvis, [0, 0.03, 0], [0.12, 0.11, 0.155], seg, mat, aux)
    lathe(out.torso, [0, 0, 0], "y", capsule(-0.02, 0.5, 0.15, 0.15, 4), 1, 1.33, seg, mat, aux)
    ellipsoid(out.head, [0.01, 0.15, 0], [0.122, 0.122, 0.122], seg, mat, aux)
    limb(out.upperArm, 0.04, -0.3, 0.058, 0.058, seg, mat, aux)
    limb(out.foreArm, 0.03, -0.22, 0.052, 0.052, seg, mat, aux)
    ellipsoid(out.foreArm, [0, -0.265, 0], [0.056, 0.056, 0.056], seg, mat, aux, 6)
    limb(out.thigh, 0.04, -0.43, 0.076, 0.076, seg, mat, aux)
    limb(out.shin, 0.03, -0.41, 0.068, 0.068, seg, mat, aux)
    lathe(out.foot, [0, -0.036, 0], "x", ellipse(7, 0.1, 0.03), 0.06, 0.049, seg, mat, aux)
    lathe(out.toe, [0, 0.032, 0], "x", ellipse(6, 0.036, 0.02), 0.042, 0.052, seg, mat, aux)
  }
  return out
}

/**
 * Soft Bean's shape (the hero concept's design 1): multipliers on its default proportions, all 1 by default.
 * `round` is how much the limbs and body swell between their joints (0 straight capsules, 1 full sausages).
 */
export type SoftBeanShape = { head: number; body: number; limb: number; round: number; face: boolean }

export const DEFAULT_SOFT_BEAN: SoftBeanShape = { head: 1, body: 1, limb: 1, round: 0.35, face: true }

/** Eye colour: the instance tint multiplies it, so the eyes stay near-black on every player colour. */
const EYE = [0.02, 0.02, 0.025] as const

/**
 * Capsule profile from `y0` (radius `r0`) to `y1` (radius `r1`) with hemispherical ends and the straight middle
 * swelling by `bulge` of its radius at the centre, so neighbouring bones overlap into one soft limb.
 */
function softCapsule(y0: number, y1: number, r0: number, r1: number, bulge: number, capRings = 5, midRings = 4): Profile {
  const lo = Math.min(y0, y1)
  const hi = Math.max(y0, y1)
  const rLo = y0 < y1 ? r0 : r1
  const rHi = y0 < y1 ? r1 : r0
  const a = lo + rLo
  const b = Math.max(a, hi - rHi)
  const out: [number, number][] = []
  for (let i = 0; i <= capRings; i++) {
    const t = (Math.PI / 2) * (i / capRings)
    out.push([a - Math.cos(t) * rLo, Math.sin(t) * rLo])
  }
  for (let i = 1; i < midRings; i++) {
    const u = i / midRings
    out.push([a + (b - a) * u, (rLo + (rHi - rLo) * u) * (1 + bulge * Math.sin(Math.PI * u))])
  }
  for (let i = 0; i <= capRings; i++) {
    const t = (Math.PI / 2) * (i / capRings)
    out.push([b + Math.sin(t) * rHi, Math.cos(t) * rHi])
  }
  return out
}

/**
 * Soft Bean: a round head with two dot eyes (or none), a bean body and thick soft limbs whose capsule ends overlap at
 * every joint so the figure reads as one smooth toy. Same bone frames and white cloth vertices as the other shapes.
 */
export function softBeanMeshes(shape: SoftBeanShape = DEFAULT_SOFT_BEAN, opts: SimpleFigureOptions = {}): Record<SimpleFigureBone, Mesh> {
  const mat = opts.mat ?? MAT.cloth
  const aux = opts.aux ?? 0
  const seg = opts.segments ?? 16
  const out = {} as Record<SimpleFigureBone, Mesh>
  for (const bone of ["pelvis", "torso", "head", "upperArm", "foreArm", "thigh", "shin", "foot", "toe"] as const) out[bone] = new Mesh()
  const round = Math.max(0, Math.min(1, shape.round))
  const bulge = 0.2 * round
  const body = shape.body
  const l = shape.limb
  const soft = (m: Mesh, top: number, bottom: number, rTop: number, rBottom: number, flatten = 1, s = seg) =>
    lathe(m, [0, 0, 0], "y", softCapsule(bottom, top, rBottom * l, rTop * l, bulge), 1, flatten, s, mat, aux)

  // Hips and belly: one bean from below the waist to the shoulders, wider across than front to back.
  ellipsoid(out.pelvis, [0, 0.01, 0], [0.13 * body, 0.12, 0.175 * body], seg, mat, aux, 10)
  lathe(out.torso, [0, 0, 0], "y", softCapsule(-0.08, 0.5, 0.175 * body, 0.16 * body, 0.6 * bulge, 6, 6), 1, 1.22, seg + 4, mat, aux)

  // Round head sitting straight on the shoulders; a squarer egg at low roundness.
  const r = 0.16 * shape.head
  const cy = 0.02 + r * 0.92
  const headC: [number, number, number] = [0.012, cy, 0]
  ellipsoid(out.head, headC, [r, r * (1.08 - 0.08 * round), r], seg + 4, mat, aux, 12)
  if (shape.face) {
    // Two dots on the front, a little above centre so the steep top-down camera still sees them.
    for (const side of [-1, 1]) {
      const az = 0.34 * side
      const el = 0.2
      const d = r * 0.975
      const c: [number, number, number] = [headC[0] + d * Math.cos(el) * Math.cos(az), cy + d * Math.sin(el), d * Math.cos(el) * Math.sin(az)]
      const e = 0.019 * Math.max(0.8, shape.head)
      lathe(out.head, c, "x", ellipse(6, e * 0.55), e, e * 1.25, 10, mat, aux, EYE)
    }
  }

  // Arms: soft capsules overlapping at the elbow, a ball mitten for a hand.
  soft(out.upperArm, 0.05, -0.29, 0.07, 0.064)
  soft(out.foreArm, 0.035, -0.24, 0.062, 0.058)
  ellipsoid(out.foreArm, [0, -0.272, 0], [0.064 * l, 0.064 * l, 0.06 * l], seg, mat, aux, 8)
  // Legs: thick and short-looking, overlapping at the knee and into the hips.
  soft(out.thigh, 0.06, -0.42, 0.098, 0.088)
  soft(out.shin, 0.04, -0.4, 0.086, 0.08)
  // Round nub feet: the ankle sits inside the shin's end, the sole on the ground (−RIG.ankle).
  lathe(out.foot, [0.02, -0.042, 0], "x", ellipse(8, 0.105), 0.072 * Math.max(1, l * 0.9), 0.045, seg, mat, aux)
  lathe(out.toe, [0.012, 0.036, 0], "x", ellipse(6, 0.045), 0.068 * Math.max(1, l * 0.9), 0.044, seg, mat, aux)
  return out
}
