import { add, cross, len, madd, norm, perp, scale, sub, SdfModel, FiberCone, Ellipsoid, Tag, smoothstep, type V3 } from "../kit/sdf"
import { rng } from "../kit/noise"
import { toWorld } from "./skull"

// Antlers that read as antlers: on each side a thick main beam rises from a burr ring, sweeps out, curves up and back,
// and carries 6–7 smooth tapered tines (a forward brow tine low down, then tines rising off the top of the beam), each
// slightly curved. Bone, not wood: pale, with fine longitudinal ridges (fibre cones), darker toward the base. The
// sides differ a little, and the right side has a tine snapped off. No twig fuzz.

/** Pedicle in skull space: the top-back of the cranium, which faces up when the skull hangs snout-down. */
export const PEDICLE: V3 = [0.075, 0.055, -0.035]

type Seg = { a: V3; b: V3; ra: number; rb: number; k: number }

const bez = (p0: V3, p1: V3, p2: V3, p3: V3, t: number): V3 => {
  const u = 1 - t
  const w0 = u * u * u
  const w1 = 3 * u * u * t
  const w2 = 3 * u * t * t
  const w3 = t * t * t
  return [p0[0] * w0 + p1[0] * w1 + p2[0] * w2 + p3[0] * w3, p0[1] * w0 + p1[1] * w1 + p2[1] * w2 + p3[1] * w3, p0[2] * w0 + p1[2] * w1 + p2[2] * w2 + p3[2] * w3]
}

/** A smooth tapered curve as a chain of segments (radius eases from r0 to r1, pointed tip). */
function curve(out: Seg[], p0: V3, p1: V3, p2: V3, p3: V3, r0: number, r1: number, segs: number, rootK: number, broken = 1) {
  let prev = p0
  let prevR = r0
  const n = Math.max(2, Math.round(segs * broken))
  for (let i = 1; i <= n; i++) {
    const t = (i / segs)
    const p = bez(p0, p1, p2, p3, t)
    // Taper: mostly linear, rounding to a point over the last fifth.
    const tip = smoothstep(0.75, 1, t)
    const r = Math.max(0.0035, (r0 + (r1 - r0) * t) * (1 - tip * 0.75))
    out.push({ a: prev, b: p, ra: prevR, rb: r, k: i === 1 ? rootK : 0.004 })
    prev = p
    prevR = r
  }
  return { end: prev, endR: prevR }
}

export function growAntler(side: 1 | -1, seed: number): { segs: Seg[]; base: V3; baseDir: V3; broken: V3[] } {
  const r = rng(seed)
  const segs: Seg[] = []
  const broken: V3[] = []
  const X = (v: V3): V3 => [v[0] * side, v[1], v[2]]
  const j = (s: number) => (r() - 0.5) * s
  const base = toWorld([PEDICLE[0] * side, PEDICLE[1], PEDICLE[2]])
  // Main beam: out and up, then curving up and back, the tip turning slightly inward.
  const B0 = base
  const B1 = add(base, X([0.28 + j(0.04), 0.22, 0.04]))
  const B2 = add(base, X([0.62 + j(0.05), 0.62 + j(0.05), -0.12]))
  const B3 = add(base, X([0.62 + j(0.06), 1.08 + j(0.06), -0.48 + j(0.05)]))
  const beamR0 = 0.042
  const beamR1 = 0.016
  curve(segs, B0, B1, B2, B3, beamR0, beamR1, 26, 0.02)
  const beamAt = (t: number) => bez(B0, B1, B2, B3, t)
  const beamR = (t: number) => beamR0 + (beamR1 - beamR0) * t
  const tangent = (t: number) => norm(sub(beamAt(Math.min(1, t + 0.01)), beamAt(Math.max(0, t - 0.01))))
  // Tines: [position along the beam, angle off the beam (rad), roll around it toward forward (+) / up (0), length].
  // They leave the beam at 40–70° from its upper-front side, so each one reads as a distinct point.
  const tines: [number, number, number, number][] = [
    [0.1, 1.25, 1.1, 0.26], // brow tine, forward over the face
    [0.27, 1.0, 0.55, 0.36],
    [0.42, 0.9, 0.2, 0.4],
    [0.56, 0.85, 0.6, 0.36],
    [0.7, 0.8, 0.05, 0.32],
    [0.84, 0.7, 0.5, 0.24],
  ]
  if (side < 0) tines.splice(3, 0, [0.49, 0.95, -0.35, 0.2]) // an extra short tine on one side
  tines.forEach(([t0, ang, roll, L], i) => {
    const t = t0 + j(0.03)
    const p0 = beamAt(t)
    const tg = tangent(t)
    // The beam's upper normal, rolled toward the front.
    const upN = norm(sub([0, 1, 0], scale(tg, tg[1])))
    const fwdN = norm(sub([0, 0, 1], scale(tg, tg[2])))
    const nrm = norm(add(scale(upN, Math.cos(roll)), scale(fwdN, Math.sin(roll))))
    const a = ang + j(0.12)
    const dir = norm(add(scale(tg, Math.cos(a)), scale(nrm, Math.sin(a))))
    // Start inside the beam, rise, and bend gently toward the crown's centre line and back.
    const len0 = L * (0.92 + r() * 0.16)
    // Each tine curves gently upward along its length.
    const bendTo = norm(add(dir, [0, 0.6, -0.1]))
    const p1 = madd(p0, dir, len0 * 0.4)
    const p3 = madd(madd(p0, dir, len0 * 0.75), bendTo, len0 * 0.3)
    const p2 = madd(p0, norm(add(dir, bendTo)), len0 * 0.7)
    // The right side's third tine is snapped off two-thirds of the way.
    const snap = side < 0 && i === 2 ? 0.62 : 1
    const rr = beamR(t) * 0.62
    const res = curve(segs, p0, p1, p2, p3, rr, rr * 0.35, 12, 0.03, snap)
    if (snap < 1) broken.push(res.end)
  })
  return { segs, base, baseDir: tangent(0.02), broken }
}

export function buildAntlers(head: number): SdfModel {
  const m = new SdfModel()
  for (const side of [1, -1] as const) {
    const r = rng(side > 0 ? 141 : 142)
    const { segs, base, baseDir, broken } = growAntler(side, side > 0 ? 41 : 42)
    // Burr: a knobbly ring around the beam's base, perpendicular to it.
    const u = perp(baseDir)
    const v = cross(baseDir, u)
    const ringC = madd(base, baseDir, 0.03)
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + r() * 0.2
      const off = add(scale(u, Math.cos(a) * 0.047), scale(v, Math.sin(a) * 0.047))
      const rr = 0.012 + r() * 0.006
      m.add(new Ellipsoid(add(ringC, off), [rr, rr * 0.8, rr], undefined, { bone: head, tag: Tag.Bone, k: 0.008 }))
    }
    for (const s of segs) {
      const ra = Math.max(0.0035, s.ra)
      const rb = Math.max(0.0035, s.rb)
      // Fine longitudinal ridges, shallow (bone, not bark).
      m.add(new FiberCone(s.a, s.b, ra, rb, Math.min(0.001, ra * 0.04), Math.max(8, Math.round(ra * 700)), r() * 50, { bone: head, tag: Tag.Bone, k: s.k }))
    }
    // Splintered end on the snapped tine.
    for (const p of broken) {
      for (let k = 0; k < 4; k++) {
        const d = norm([r() - 0.5, 1, r() - 0.5])
        m.add(new FiberCone(p, madd(p, d, 0.012 + r() * 0.018), 0.006, 0.0018, 0.0006, 5, r() * 9, { bone: head, tag: Tag.Bone, k: 0.003 }))
      }
    }
  }
  m.margin = 0.003
  return m
}

/** Paint: grime and darker, older bone at the base, bleaching toward the tips. */
export function paintAntler(p: V3): [number, number, number] {
  const b = toWorld([PEDICLE[0] * Math.sign(p[0] || 1), PEDICLE[1], PEDICLE[2]])
  const d = len(sub(p, b))
  return [Math.max(0, 0.75 - d * 1.6), 0, 0]
}

