import { describe, expect, test } from "bun:test"
import { makeSea, type Sea } from "../shared/sea"
import { SHIP, type Ship, copyShip, makeShip, shipStep } from "../shared/ship"
import { type Bump, COLLIDE, ShipCollider, collideHulls, hullSolid, ramDamage } from "../shared/ship-collide"

const calm = (seed = 7): Sea => ({ ...makeSea(seed), waves: [] })

type Run = { a: Ship; b: Ship; bumps: Bump[]; maxDepth: number; damageA: number; damageB: number }

/** A ship at (x, z) heading h, already doing the speed its throttle holds. */
function moving(x: number, z: number, heading: number, throttle: number): Ship {
  const s = makeShip(x, z, heading)
  s.power = throttle
  s.order = throttle
  s.u = throttle * SHIP.topSpeed
  return s
}

/** Overlap of two hulls (m), without touching them. */
function depth(a: Ship, b: Ship): number {
  const c = collideHulls(copyShip(a, makeShip(0, 0, 0)), copyShip(b, makeShip(0, 0, 0)))
  return c ? c.depth : 0
}

/** Steps both ships in lockstep like the room: ship steps, then the collider. */
function run(a: Ship, b: Ship, seconds: number, ta: number, tb: number, each?: (r: Run, i: number) => void, sea = calm()): Run {
  const col = new ShipCollider()
  const r: Run = { a, b, bumps: [], maxDepth: 0, damageA: 0, damageB: 0 }
  const n = Math.round(seconds / SHIP.tick)
  for (let i = 0; i < n; i++) {
    shipStep(a, { throttle: ta, rudder: 0 }, sea, null)
    shipStep(b, { throttle: tb, rudder: 0 }, sea, null)
    r.maxDepth = Math.max(r.maxDepth, depth(a, b))
    for (const x of col.step([{ id: 1, ship: a, solid: true }, { id: 2, ship: b, solid: true }], a.t)) {
      r.bumps.push(x)
      r.damageA += x.damageA
      r.damageB += x.damageB
    }
    each?.(r, i)
  }
  return r
}

/** Throttle that holds `ms` m/s. */
const at = (ms: number) => ms / SHIP.topSpeed

describe("ship collisions", () => {
  test("the plan is the flight deck's outline (76 m × 330 m), convex and closed", () => {
    // Two hulls side by side 76 m apart (the deck's width) just touch; 77 m apart they don't.
    const a = makeShip(0, 0, 0)
    expect(collideHulls(copyShip(a, makeShip(0, 0, 0)), makeShip(77, 0, 0))).toBeNull()
    expect(depth(a, makeShip(75.8, 0, 0))).toBeCloseTo(0.2, 1)
    // Bow to bow: 330 m apart touch, 331 m don't.
    expect(collideHulls(makeShip(0, 0, 0), makeShip(0, -331, Math.PI))).toBeNull()
    expect(depth(makeShip(0, 0, 0), makeShip(0, -329.5, Math.PI))).toBeCloseTo(0.5, 1)
    // A hull lying across just ahead of the bow.
    expect(collideHulls(makeShip(0, 0, 0), makeShip(0, -165 - 38 - 0.5, Math.PI / 2))).toBeNull()
    expect(depth(makeShip(0, 0, 0), makeShip(0, -165 - 38 + 0.5, Math.PI / 2))).toBeCloseTo(0.5, 1)
  })

  test("head-on: they stop each other, bounce back a little, both take the same heavy damage", () => {
    const a = moving(0, 0, 0, at(10))
    const b = moving(0, -360, Math.PI, at(10))
    const r = run(a, b, 12, 0, 0)
    expect(r.bumps.length).toBeGreaterThan(0)
    const first = r.bumps[0]!
    expect(first.closing).toBeGreaterThan(19)
    expect(first.closing).toBeLessThan(21)
    // Inelastic: mostly stopped, a slight bounce back.
    expect(a.u).toBeLessThan(0.5)
    expect(a.u).toBeGreaterThan(-3)
    expect(b.u).toBeLessThan(0.5)
    expect(r.maxDepth).toBeLessThan(1.5)
    expect(r.damageA).toBeCloseTo(r.damageB, 6)
    expect(r.damageA).toBeGreaterThan(200)
    // Never through each other: A stays south of B.
    expect(b.z).toBeLessThan(a.z - 320)
  })

  test("T-bone at 15 m/s: the rammed hull takes ~25-35%, the rammer less, and is shoved sideways", () => {
    const b = makeShip(0, 0, 0)
    const a = moving(320, 0, -Math.PI / 2, at(15))
    const r = run(a, b, 10, at(15), 0)
    const first = r.bumps[0]!
    expect(first.a).toBe(1)
    expect(first.closing).toBeGreaterThan(14)
    expect(first.closing).toBeLessThan(15.5)
    expect(r.damageB).toBeGreaterThan(250)
    expect(r.damageB).toBeLessThan(350)
    expect(r.damageA).toBeLessThan(r.damageB * 0.75)
    expect(r.damageA).toBeGreaterThan(r.damageB * 0.5)
    // Struck amidships: pushed west, hardly turned.
    expect(b.x).toBeLessThan(-5)
    expect(Math.abs(b.heading)).toBeLessThan(0.03)
    expect(r.maxDepth).toBeLessThan(1.5)
    // The bow hit B's starboard (−X in carrier-spec) side amidships.
    expect(first.bx).toBeLessThan(-20)
    expect(Math.abs(first.bz)).toBeLessThan(15)
  })

  test("off-centre: a blow near the bow yaws the struck ship", () => {
    const b = makeShip(0, 0, 0)
    const a = moving(320, -120, -Math.PI / 2, at(15))
    run(a, b, 15, at(15), 0)
    // Pushed west at its bow: the bow swings west, to port (heading falls).
    expect(b.heading).toBeLessThan(-0.02)
  })

  test("glancing: the hulls slide past, the striker yaws away and keeps most of its speed, little damage", () => {
    const b = makeShip(0, 0, 0)
    // 8° toward B, coming up from astern on B's starboard side.
    const ang = (-8 * Math.PI) / 180
    const a = moving(110, 300, ang, at(15))
    const u0 = a.u
    let minH = 0
    const r = run(a, b, 30, at(15), 0, (x) => {
      minH = Math.min(minH, x.a.heading)
    })
    expect(r.bumps.length).toBeGreaterThan(0)
    expect(r.bumps[0]!.closing).toBeLessThan(4)
    expect(r.damageA + r.damageB).toBeLessThan(0.05 * 1000)
    // Turned away (heading back toward north or east of it) and still moving.
    expect(a.heading).toBeGreaterThan(ang + 0.02)
    expect(a.u).toBeGreaterThan(0.5 * u0)
    expect(r.maxDepth).toBeLessThan(1)
    expect(a.z).toBeLessThan(-100)
  })

  test("resting contact: a ship pushing into another under power sits still, no jitter, no repeated damage", () => {
    const b = makeShip(0, 0, 0)
    const a = moving(203.5, 0, -Math.PI / 2, at(1))
    const xs: number[] = []
    const hs: number[] = []
    const r = run(a, b, 40, 1, 0, (x) => {
      xs.push(x.a.x - x.b.x)
      hs.push(x.b.heading)
    })
    // Settled after the first push: the gap between the centres holds within a centimetre, the hulls don't twitch.
    const tail = xs.slice(xs.length - 20 * 60)
    expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(0.01)
    let wobble = 0
    for (let i = hs.length - 20 * 60; i < hs.length; i++) wobble = Math.max(wobble, Math.abs(hs[i]! - hs[i - 1]!))
    expect(wobble).toBeLessThan(1e-4)
    expect(r.maxDepth).toBeLessThan(1)
    // A gentle first touch, then nothing more.
    expect(r.damageA + r.damageB).toBeLessThan(20)
    const late = r.bumps.filter((x) => x.closing > 1.5)
    expect(late.length).toBeLessThanOrEqual(1)
    // Full power shoves the other ship along: both move west together.
    expect(b.x).toBeLessThan(-20)
    expect(a.x - b.x).toBeCloseTo(165 + 38, 0)
  })

  test("two hulls placed overlapping push apart and come to rest without oscillating", () => {
    const a = makeShip(0, 0, 0)
    const b = makeShip(74, 0, 0)
    const gaps: number[] = []
    run(a, b, 20, 0, 0, (x) => gaps.push(x.b.x - x.a.x))
    expect(gaps.at(-1)!).toBeGreaterThan(75.9)
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]!).toBeGreaterThanOrEqual(gaps[i - 1]! - 1e-9)
  })

  test("damage scales with closing speed: a nudge is nothing, a full-speed ram heavy, capped", () => {
    expect(ramDamage(1, 0)).toBe(0)
    expect(ramDamage(2, 0)).toBeLessThan(5)
    expect(ramDamage(5, 0)).toBeLessThan(50)
    expect(ramDamage(15, 0)).toBeGreaterThan(250)
    expect(ramDamage(15, 0)).toBeLessThan(350)
    expect(ramDamage(15, 1)).toBeCloseTo(ramDamage(15, 0) * (1 - COLLIDE.rammer), 6)
    expect(ramDamage(2 * SHIP.topSpeed, 0)).toBe(COLLIDE.harmMax)
    for (let v = 2; v < 50; v++) expect(ramDamage(v, 0)).toBeGreaterThanOrEqual(ramDamage(v - 1, 0))
  })

  test("cooldown: grinding at speed doesn't drain health every step; a harder blow adds only its excess", () => {
    const col = new ShipCollider()
    const a = makeShip(0, 0, 0)
    const b = makeShip(75.8, 0, 0)
    let dealt = 0
    let t = 0
    const hit = (speed: number) => {
      // Keep them touching, B driving into A's side at `speed`.
      Object.assign(a, makeShip(0, 0, 0, t))
      Object.assign(b, makeShip(75.8, 0, 0, t))
      b.v = -speed
      for (const x of col.step([{ id: 1, ship: a, solid: true }, { id: 2, ship: b, solid: true }], t)) dealt += x.damageA
      t += SHIP.tick
    }
    hit(6)
    const one = dealt
    expect(one).toBeGreaterThan(0)
    for (let i = 0; i < 60; i++) hit(6)
    expect(dealt).toBeCloseTo(one, 6)
    hit(10)
    expect(dealt).toBeCloseTo(ramDamage(10, 0), 6)
    // Past the cooldown the same blow counts again.
    t += COLLIDE.cooldown
    hit(6)
    expect(dealt).toBeCloseTo(ramDamage(10, 0) + one, 6)
  })

  test("is deterministic", () => {
    const go = () => {
      const a = moving(0, 0, 0.3, at(18))
      const b = moving(150, -330, -2.4, at(12))
      const r = run(a, b, 25, at(18), at(12), undefined, makeSea(4))
      return { a: r.a, b: r.b, bumps: r.bumps }
    }
    const x = go()
    expect(x.bumps.length).toBeGreaterThan(0)
    expect(go()).toEqual(x)
  })

  test("no tunnelling at top speed, from any heading and offset", () => {
    let worst = 0
    let hits = 0
    for (let hb = 1; hb < 12; hb++) {
      for (const off of [-160, -90, 0, 90, 160]) {
        const head = (hb / 12) * Math.PI * 2
        // B heads along `head` toward the meeting point; A goes north through the origin.
        const a = moving(0, 700, 0, 1)
        const b = moving(-Math.sin(head) * 700 + off * Math.cos(head), Math.cos(head) * 700 + off * Math.sin(head), head, 1)
        const r = run(a, b, 45, 1, 1)
        worst = Math.max(worst, r.maxDepth)
        if (r.bumps.length) hits++
      }
    }
    expect(hits).toBeGreaterThan(25)
    expect(worst).toBeLessThan(2)
  })

  test("a sinking hull stays solid only at first", () => {
    expect(hullSolid(null, 5)).toBe(true)
    expect(hullSolid({ sinkAt: -1 }, 5)).toBe(true)
    expect(hullSolid({ sinkAt: 100 }, 100 + COLLIDE.sinkSolid - 1)).toBe(true)
    expect(hullSolid({ sinkAt: 100 }, 100 + COLLIDE.sinkSolid + 1)).toBe(false)
    expect(hullSolid({ sinkAt: -2 }, 5)).toBe(false)
  })

  test("onlyA leaves the other hull alone", () => {
    const a = moving(0, 0, -Math.PI / 2, at(10))
    const b = makeShip(-180, 0, 0)
    const before = { ...b }
    a.x = -180 + 38 + 165 - 0.5
    const c = collideHulls(a, b, undefined, true)
    expect(c).not.toBeNull()
    expect(b).toEqual(before)
    // Equal masses, a bow into a beam: the struck hull would take most of the speed, the striker keeps some.
    expect(a.u).toBeLessThan(6)
    expect(a.u).toBeGreaterThan(2)
  })
})
