// Carrier against carrier: two hulls that touch push apart, bounce a little, grind and yaw, and the room turns hard
// impacts into damage. Pure and DOM-free: the room resolves every pair after each fixed ship step (server/core.ts),
// and the helm's client resolves its own predicted hull against the remotes it draws so it stops where the room does.
//
// Shape: the flight deck's plan (it overhangs the waterline hull boats bounce off), a convex polygon in ship-local
// (f toward the bow, s to starboard), as in shared/ship.ts. Contact is found with the
// separating axis test (the least-overlap edge normal of either hull) and clipped to at most two points on the
// reference edge, so a bow driven into a side, two bows meeting and two sides scraping all give a steady contact.
//
// Response: equal masses (every carrier is the same ship), heavier sideways and in yaw by the water that moves with the
// hull (added mass), yaw inertia from SHIP.gyration. A few sequential impulse
// passes on the points: the closing speed is cancelled and, above `restSpeed`, bounced back by `bounce`; the sliding
// speed is resisted up to `friction` of the normal impulse (a glancing blow slides and yaws). Off-centre points yaw
// both hulls. The overlap left after that is pushed out a share per step (`push`, past `slop`), never more than
// `pushMax`, so two ships resting against each other under power sit still instead of jittering. The ships' own
// sway and yaw damping (shipStep) then soak up what the impact gave them.
//
// Damage (the room's `ShipCollider`): from the closing speed at the first touch, ∝ (speed − harmSpeed)^1.5, capped,
// shared out so the hull doing the ramming takes less than the one it rams. A pair that just hurt each other takes
// only the excess of a harder blow for `cooldown` s, so grinding along a side doesn't drain health every step.

import type { BoatObstacle } from "./boat"
import { BOW_NOTCH, BOW_Z, DECK_X0, DECK_X1, STERN_Z } from "./carrier-spec"
import { SHIP, type Ship } from "./ship"

export const COLLIDE = {
  /** Share of the closing speed bounced back (heavy steel hulls: mostly they shove and grind). */
  bounce: SHIP.bounce,
  /** Below this closing speed (m/s) nothing bounces: resting contact. */
  restSpeed: 1,
  /** Sliding resistance as a share of the normal impulse. */
  friction: 0.3,
  /** Overlap left alone (m), share of the rest pushed out per step, and the most per step (m). */
  slop: 0.05,
  push: 0.25,
  pushMax: 0.5,
  /** Effective mass in surge, sway and yaw (the hull's own is 1): the water a hull pushes sideways or turns moves with
   *  it (added mass), so a carrier shoved beam-on gives much less than one struck end-on. */
  surgeMass: 1.05,
  swayMass: 2,
  yawMass: 1.5,
  /** Impulse passes per step. */
  iterations: 6,
  /** Hulls that sink stay solid this long after the sinking starts (s): by then the deck is awash. */
  sinkSolid: 10,
  /** A touch closing faster than this (m/s) is a bump: a sound and a shake. */
  bumpSpeed: 0.8,
  /** Damage: none below harmSpeed (m/s), then harm · (closing − harmSpeed)^harmExp hp, at most harmMax per hull. */
  harmSpeed: 1.5,
  harm: 6,
  harmExp: 1.5,
  harmMax: 650,
  /** The hull that does the ramming (its own speed into the contact) takes up to this share less. */
  rammer: 0.4,
  /** A pair that just collided takes only the excess of a harder hit for this long (s). */
  cooldown: 1.5,
  /** Closing speed (m/s) of a full-intensity bump (shake and sound). */
  fullBump: 12,
} as const

/**
 * The plan that collides (f, s), convex, going round the outline: the flight deck (330 m × 76 m, bow corners notched),
 * which overhangs the waterline hull (`carrierHalfBeam`) everywhere, so two carriers meet deck edge to deck edge as
 * they are drawn instead of driving their decks into each other.
 */
export const HULL_PLAN: readonly (readonly [f: number, s: number])[] = [
  [BOW_Z, DECK_X1 - BOW_NOTCH],
  [BOW_Z - BOW_NOTCH, DECK_X1],
  [STERN_Z, DECK_X1],
  [STERN_Z, DECK_X0],
  [BOW_Z - BOW_NOTCH, DECK_X0],
  [BOW_Z, DECK_X0 + BOW_NOTCH],
]
const N = HULL_PLAN.length
/** Outward edge normals (ship-local), edge i from vertex i to i + 1. */
const PLAN_NORMALS: readonly (readonly [number, number])[] = HULL_PLAN.map((p, i) => {
  const q = HULL_PLAN[(i + 1) % N]!
  let nf = q[1] - p[1]
  let ns = -(q[0] - p[0])
  const len = Math.hypot(nf, ns)
  nf /= len
  ns /= len
  return nf * p[0] + ns * p[1] < 0 ? [-nf, -ns] : [nf, ns]
})
/** Beyond this centre distance two hulls can't touch (m). */
const REACH = 2 * Math.hypot(BOW_Z, DECK_X1) + 1
const INV_I = 1 / (SHIP.gyration * SHIP.gyration * COLLIDE.yawMass)

/** World velocity change of a hull (heading sin/cos) per unit impulse along (dx, dz), and that change along it: into out. */
function dirMass(sh: number, ch: number, dx: number, dz: number, out: number[]): void {
  const pf = dx * sh - dz * ch
  const ps = dx * ch + dz * sh
  const du = pf / COLLIDE.surgeMass
  const dv = ps / COLLIDE.swayMass
  out[0] = du * sh + dv * ch
  out[1] = -du * ch + dv * sh
  out[2] = pf * du + ps * dv
}
const RN = [0, 0, 0]
const RT = [0, 0, 0]
const IN = [0, 0, 0]
const IT = [0, 0, 0]

/** What a hull needs for collisions: its plan pose and plan velocity; `ground` takes the shake. */
export type HullBody = BoatObstacle & { ground: number }

/** One step's contact between hulls a and b. Points are ship-local carrier-spec (x to port, z to the bow). */
export type Contact = {
  /** Fastest closing speed at a contact point before the response (m/s, ≥ 0). */
  closing: number
  /** How much of that closing speed each hull brought (0..1; 1: it drove into a hull standing still). */
  shareA: number
  shareB: number
  /** Deepest overlap (m). */
  depth: number
  /** The middle of the contact in each hull's frame. */
  ax: number
  az: number
  bx: number
  bz: number
  /** World point and the normal from a toward b. */
  x: number
  z: number
  nx: number
  nz: number
}

export const makeContact = (): Contact => ({ closing: 0, shareA: 0, shareB: 0, depth: 0, ax: 0, az: 0, bx: 0, bz: 0, x: 0, z: 0, nx: 0, nz: 0 })

type Poly = { x: Float64Array; z: Float64Array; nx: Float64Array; nz: Float64Array }
const makePoly = (): Poly => ({ x: new Float64Array(N), z: new Float64Array(N), nx: new Float64Array(N), nz: new Float64Array(N) })
const PA = makePoly()
const PB = makePoly()

function place(s: BoatObstacle, p: Poly): void {
  const sh = Math.sin(s.heading)
  const ch = Math.cos(s.heading)
  for (let i = 0; i < N; i++) {
    const [f, w] = HULL_PLAN[i]!
    p.x[i] = s.x + f * sh + w * ch
    p.z[i] = s.z - f * ch + w * sh
    const [nf, ns] = PLAN_NORMALS[i]!
    p.nx[i] = nf * sh + ns * ch
    p.nz[i] = -nf * ch + ns * sh
  }
}

/** The edge of `a` along which `b` overlaps it least, and `b`'s deepest vertex past it: [separation (< 0 overlapping),
 *  edge, vertex]. */
function maxSeparation(a: Poly, b: Poly, out: number[]): number[] {
  let best = -Infinity
  let edge = 0
  let vert = 0
  for (let i = 0; i < N; i++) {
    const nx = a.nx[i]!
    const nz = a.nz[i]!
    const ox = a.x[i]!
    const oz = a.z[i]!
    let m = Infinity
    let mv = 0
    for (let j = 0; j < N; j++) {
      const d = (b.x[j]! - ox) * nx + (b.z[j]! - oz) * nz
      if (d < m) {
        m = d
        mv = j
      }
    }
    if (m > best) {
      best = m
      edge = i
      vert = mv
    }
  }
  out[0] = best
  out[1] = edge
  out[2] = vert
  return out
}
const SA = [0, 0, 0]
const SB = [0, 0, 0]

// Contact points of this step (world), their overlaps and the solver's accumulated impulses.
const CX = [0, 0]
const CZ = [0, 0]
const CD = [0, 0]
const JN = [0, 0]
const JT = [0, 0]
const BIAS = [0, 0]

/**
 * The contact manifold of the placed polygons: reference hull `ref` (its edge `e` gives the normal), incident hull
 * `inc` with its deepest vertex `v`. Fills CX/CZ/CD and returns the point count (0..2).
 */
function manifold(ref: Poly, e: number, inc: Poly, v: number): number {
  const nx = ref.nx[e]!
  const nz = ref.nz[e]!
  // Incident edge: the one facing the reference edge most among the edges meeting at the deepest vertices (within
  // half a metre: a side lying flat along it has a deep vertex at each end). The most opposed edge of the whole hull
  // can be a far-off one.
  const rx0 = ref.x[e]!
  const rz0 = ref.z[e]!
  const deep = (inc.x[v]! - rx0) * nx + (inc.z[v]! - rz0) * nz + 0.5
  let ie = v
  let low = Infinity
  for (let j = 0; j < N; j++) {
    if ((inc.x[j]! - rx0) * nx + (inc.z[j]! - rz0) * nz > deep) continue
    for (const k of [(j + N - 1) % N, j]) {
      const d = inc.nx[k]! * nx + inc.nz[k]! * nz
      if (d < low) {
        low = d
        ie = k
      }
    }
  }
  let x1 = inc.x[ie]!
  let z1 = inc.z[ie]!
  let x2 = inc.x[(ie + 1) % N]!
  let z2 = inc.z[(ie + 1) % N]!
  const rx = ref.x[e]!
  const rz = ref.z[e]!
  const ex = ref.x[(e + 1) % N]! - rx
  const ez = ref.z[(e + 1) % N]! - rz
  const len = Math.hypot(ex, ez)
  const tx = ex / len
  const tz = ez / len
  // Clip the incident edge to the reference edge's extent along it.
  const clip = (lo: number, hi: number): boolean => {
    for (const [bound, sign] of [
      [lo, 1],
      [hi, -1],
    ] as const) {
      const d1 = sign * ((x1 - rx) * tx + (z1 - rz) * tz - bound)
      const d2 = sign * ((x2 - rx) * tx + (z2 - rz) * tz - bound)
      if (d1 < 0 && d2 < 0) return false
      if (d1 < 0 || d2 < 0) {
        const k = d1 / (d1 - d2)
        const px = x1 + (x2 - x1) * k
        const pz = z1 + (z2 - z1) * k
        if (d1 < 0) {
          x1 = px
          z1 = pz
        } else {
          x2 = px
          z2 = pz
        }
      }
    }
    return true
  }
  let n = 0
  if (!clip(0, len)) return deepestOnly(ref, e, inc, v)
  for (const [px, pz] of [
    [x1, z1],
    [x2, z2],
  ] as const) {
    const sep = (px - rx) * nx + (pz - rz) * nz
    if (sep > 0) continue
    // Halfway between the incident point and the reference edge.
    CX[n] = px - nx * sep * 0.5
    CZ[n] = pz - nz * sep * 0.5
    CD[n] = -sep
    n++
  }
  return n > 0 ? n : deepestOnly(ref, e, inc, v)
}

/** Fallback: one point, the incident hull's deepest vertex. */
function deepestOnly(ref: Poly, e: number, inc: Poly, v: number): number {
  const nx = ref.nx[e]!
  const nz = ref.nz[e]!
  const sep = (inc.x[v]! - ref.x[e]!) * nx + (inc.z[v]! - ref.z[e]!) * nz
  // Only just touching: nothing to resolve yet (and a tie could name a far vertex).
  if (sep > -0.01) return 0
  CX[0] = inc.x[v]! - nx * sep * 0.5
  CZ[0] = inc.z[v]! - nz * sep * 0.5
  CD[0] = Math.max(0, -sep)
  return 1
}

const cross = (ax: number, az: number, nx: number, nz: number) => ax * nz - az * nx

const SCRATCH: HullBody = { x: 0, z: 0, heading: 0, u: 0, v: 0, r: 0, ground: 0 }

/**
 * Finds and resolves the contact between hulls `a` and `b` in place (velocities, a push apart, `ground` for the
 * shake). Returns the contact (written into `out`) or null when they don't touch. `onlyA`: `b` is left untouched (the
 * helm's client resolving its own ship against a remote it only draws).
 */
export function collideHulls(a: HullBody, b: HullBody, out: Contact = makeContact(), onlyA = false): Contact | null {
  if (Math.abs(a.x - b.x) > REACH || Math.abs(a.z - b.z) > REACH || Math.hypot(a.x - b.x, a.z - b.z) > REACH) return null
  if (onlyA) b = Object.assign(SCRATCH, { x: b.x, z: b.z, heading: b.heading, u: b.u, v: b.v, r: b.r, ground: b.ground })
  place(a, PA)
  place(b, PB)
  const [sa, ea, va] = maxSeparation(PA, PB, SA) as [number, number, number]
  if (sa > 0) return null
  const [sb, eb, vb] = maxSeparation(PB, PA, SB) as [number, number, number]
  if (sb > 0) return null
  // The reference hull: the one whose edge separates them best (a, unless b's is clearly better).
  const flip = sb > sa + 0.02
  const ref = flip ? b : a
  const inc = flip ? a : b
  const n = flip ? manifold(PB, eb, PA, vb) : manifold(PA, ea, PB, va)
  if (n === 0) return null
  const pr = flip ? PB : PA
  const e = flip ? eb : ea
  const nx = pr.nx[e]!
  const nz = pr.nz[e]!
  const tx = -nz
  const tz = nx

  // World velocities.
  const rs = Math.sin(ref.heading)
  const rc = Math.cos(ref.heading)
  const is = Math.sin(inc.heading)
  const ic = Math.cos(inc.heading)
  let rvx = ref.u * rs + ref.v * rc
  let rvz = -ref.u * rc + ref.v * rs
  let rr = ref.r
  let ivx = inc.u * is + inc.v * ic
  let ivz = -inc.u * ic + inc.v * is
  let ir = inc.r
  // What a unit impulse along the normal and the tangent does to each hull's velocity (surge and sway masses differ).
  dirMass(rs, rc, nx, nz, RN)
  dirMass(rs, rc, tx, tz, RT)
  dirMass(is, ic, nx, nz, IN)
  dirMass(is, ic, tx, tz, IT)

  // Closing speeds before the response: the bounce target and the damage speed.
  let closing = 0
  let refIn = 0
  let incIn = 0
  let deepest = 0
  for (let k = 0; k < n; k++) {
    const rax = CX[k]! - ref.x
    const raz = CZ[k]! - ref.z
    const iax = CX[k]! - inc.x
    const iaz = CZ[k]! - inc.z
    const vr = (rvx - rr * raz) * nx + (rvz + rr * rax) * nz
    const vi = (ivx - ir * iaz) * nx + (ivz + ir * iax) * nz
    const vn = vi - vr
    BIAS[k] = vn < -COLLIDE.restSpeed ? -COLLIDE.bounce * vn : 0
    JN[k] = 0
    JT[k] = 0
    if (-vn > closing) {
      closing = -vn
      refIn = vr
      incIn = -vi
    }
    if (CD[k]! > CD[deepest]!) deepest = k
  }

  for (let it = 0; it < COLLIDE.iterations; it++) {
    for (let k = 0; k < n; k++) {
      const rax = CX[k]! - ref.x
      const raz = CZ[k]! - ref.z
      const iax = CX[k]! - inc.x
      const iaz = CZ[k]! - inc.z
      // Normal.
      const cr = cross(rax, raz, nx, nz)
      const ci = cross(iax, iaz, nx, nz)
      const vn = (ivx - ir * iaz - (rvx - rr * raz)) * nx + (ivz + ir * iax - (rvz + rr * rax)) * nz
      const kn = RN[2]! + IN[2]! + (cr * cr + ci * ci) * INV_I
      const jn = Math.max(0, JN[k]! - (vn - BIAS[k]!) / kn)
      const dn = jn - JN[k]!
      JN[k] = jn
      ivx += dn * IN[0]!
      ivz += dn * IN[1]!
      ir += dn * ci * INV_I
      rvx -= dn * RN[0]!
      rvz -= dn * RN[1]!
      rr -= dn * cr * INV_I
      // Friction along the contact.
      const ctr = cross(rax, raz, tx, tz)
      const cti = cross(iax, iaz, tx, tz)
      const vt = (ivx - ir * iaz - (rvx - rr * raz)) * tx + (ivz + ir * iax - (rvz + rr * rax)) * tz
      const kt = RT[2]! + IT[2]! + (ctr * ctr + cti * cti) * INV_I
      const lim = COLLIDE.friction * JN[k]!
      const jt = Math.max(-lim, Math.min(lim, JT[k]! - vt / kt))
      const dt = jt - JT[k]!
      JT[k] = jt
      ivx += dt * IT[0]!
      ivz += dt * IT[1]!
      ir += dt * cti * INV_I
      rvx -= dt * RT[0]!
      rvz -= dt * RT[1]!
      rr -= dt * ctr * INV_I
    }
  }

  ref.u = rvx * rs - rvz * rc
  ref.v = rvx * rc + rvz * rs
  ref.r = rr
  inc.u = ivx * is - ivz * ic
  inc.v = ivx * ic + ivz * is
  inc.r = ir

  // Push the rest of the overlap out, half each.
  const depth = CD[deepest]!
  const push = Math.min(COLLIDE.pushMax, Math.max(0, depth - COLLIDE.slop) * COLLIDE.push) * 0.5
  ref.x -= nx * push
  ref.z -= nz * push
  inc.x += nx * push
  inc.z += nz * push

  const shake = Math.min(1, Math.max(0, closing - COLLIDE.bumpSpeed) / (COLLIDE.fullBump - COLLIDE.bumpSpeed))
  if (shake > 0) {
    a.ground = Math.max(a.ground, shake)
    if (!onlyA) b.ground = Math.max(b.ground, shake)
  }

  // Report in a/b order; the normal points from a toward b.
  // The middle of the contact (a bow flat against a side touches at both corners).
  const px = n === 2 ? (CX[0]! + CX[1]!) / 2 : CX[0]!
  const pz = n === 2 ? (CZ[0]! + CZ[1]!) / 2 : CZ[0]!
  const sgn = flip ? -1 : 1
  out.closing = closing
  const shareRef = closing > 1e-6 ? Math.max(0, Math.min(1, refIn / closing)) : 0
  const shareInc = closing > 1e-6 ? Math.max(0, Math.min(1, incIn / closing)) : 0
  out.shareA = flip ? shareInc : shareRef
  out.shareB = flip ? shareRef : shareInc
  out.depth = depth
  out.x = px
  out.z = pz
  out.nx = nx * sgn
  out.nz = nz * sgn
  local(a, px, pz, out, "a")
  local(b, px, pz, out, "b")
  return out
}

/** World (x, z) → carrier-spec ship-local x (to port) and z (to the bow). */
function local(s: BoatObstacle, x: number, z: number, out: Contact, which: "a" | "b"): void {
  const sh = Math.sin(s.heading)
  const ch = Math.cos(s.heading)
  const dx = x - s.x
  const dz = z - s.z
  const f = dx * sh - dz * ch
  const st = dx * ch + dz * sh
  if (which === "a") {
    out.ax = -st
    out.az = f
  } else {
    out.bx = -st
    out.bz = f
  }
}

/** Damage (hp) a collision closing at `closing` m/s does to a hull that brought `share` of that speed. */
export function ramDamage(closing: number, share: number): number {
  if (closing <= COLLIDE.harmSpeed) return 0
  const full = Math.min(COLLIDE.harmMax, COLLIDE.harm * (closing - COLLIDE.harmSpeed) ** COLLIDE.harmExp)
  return full * (1 - COLLIDE.rammer * Math.max(0, Math.min(1, share)))
}

/** 0..1: how hard a bump at `closing` m/s reads (shake, sound). */
export const bumpIntensity = (closing: number): number => Math.max(0, Math.min(1, (closing - COLLIDE.bumpSpeed) / (COLLIDE.fullBump - COLLIDE.bumpSpeed)))

/** Whether a hull still collides at sea time t: afloat, or only just started sinking. */
export const hullSolid = (h: { sinkAt: number } | null | undefined, t: number): boolean => !h || h.sinkAt === -1 || (h.sinkAt >= 0 && t - h.sinkAt < COLLIDE.sinkSolid)

/** A collision the room acts on: the two ships, how hard, the damage to each and where (ship-local, carrier-spec). */
export type Bump = { a: number; b: number; closing: number; k: number; damageA: number; damageB: number; ax: number; az: number; bx: number; bz: number }

export type CollideEntry = { id: number; ship: Ship; solid: boolean }

/**
 * The room's collisions: `step` after every fixed ship step resolves every touching pair (in id order, so it is
 * deterministic) and returns the bumps worth a sound or damage. Each pair's damage window (`cooldown`) is remembered.
 */
export class ShipCollider {
  private pairs = new Map<string, { until: number; dealtA: number; dealtB: number }>()
  private contact = makeContact()

  step(list: readonly CollideEntry[], t: number): Bump[] {
    const out: Bump[] = []
    const sorted = list.length > 1 ? [...list].sort((p, q) => p.id - q.id) : list
    for (let i = 0; i < sorted.length; i++) {
      const A = sorted[i]!
      if (!A.solid) continue
      for (let j = i + 1; j < sorted.length; j++) {
        const B = sorted[j]!
        if (!B.solid) continue
        const c = collideHulls(A.ship, B.ship, this.contact)
        if (!c || c.closing < COLLIDE.bumpSpeed) continue
        const key = `${A.id}:${B.id}`
        let p = this.pairs.get(key)
        const fresh = !p || t >= p.until
        if (!p || fresh) {
          p = { until: t + COLLIDE.cooldown, dealtA: 0, dealtB: 0 }
          this.pairs.set(key, p)
        }
        const dA = ramDamage(c.closing, c.shareA)
        const dB = ramDamage(c.closing, c.shareB)
        const extraA = Math.max(0, dA - p.dealtA)
        const extraB = Math.max(0, dB - p.dealtB)
        if (!fresh && extraA <= 0 && extraB <= 0) continue
        p.dealtA = Math.max(p.dealtA, dA)
        p.dealtB = Math.max(p.dealtB, dB)
        out.push({ a: A.id, b: B.id, closing: c.closing, k: bumpIntensity(c.closing), damageA: extraA, damageB: extraB, ax: c.ax, az: c.az, bx: c.bx, bz: c.bz })
      }
    }
    if (this.pairs.size > 0) for (const [k, p] of this.pairs) if (t > p.until + COLLIDE.cooldown) this.pairs.delete(k)
    return out
  }

  clear(): void {
    this.pairs.clear()
  }
}
