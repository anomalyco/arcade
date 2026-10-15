import { describe, expect, test } from "bun:test"
import { type BombImpact, CombatWorld, type Ground, type MovingShip, bombImpact, bombLaunch, driftShip, makeBombImpact } from "../shared/combat"
import { DECK_Y } from "../shared/carrier-spec"
import { archipelagoFor, terrainHeight } from "../shared/islands"
import { PLANE, type Plane, type Quat, makePlane, quatAxis, quatMul } from "../shared/plane"
import { makeSea } from "../shared/sea"
import { LOADOUTS } from "../shared/weapons"

const DT = PLANE.tick
const DEG = Math.PI / 180
const sea = makeSea(7)
const MAX = LOADOUTS.f35.bombs

/** An F-35C at (x, y, z) flying `speed` along heading `yaw` (0 north), its path `dive` below the horizon, banked. */
function jet(t: number, x: number, y: number, z: number, speed: number, yaw: number, dive: number, bank = 0): Plane {
  const p = makePlane(t)
  // Body +Z is the nose: yaw about world up (0 = north, -z), then the nose down by `dive`, then the bank about the nose.
  const q: Quat = quatMul(quatMul(quatAxis(0, 1, 0, Math.PI - yaw), quatAxis(1, 0, 0, dive)), quatAxis(0, 0, 1, bank))
  ;[p.qx, p.qy, p.qz, p.qw] = q
  p.x = x
  p.y = y
  p.z = z
  const c = Math.cos(dive)
  p.vx = Math.sin(yaw) * c * speed
  p.vy = -Math.sin(dive) * speed
  p.vz = -Math.cos(yaw) * c * speed
  return p
}

type Burst = { x: number; y: number; z: number; water: boolean; ship: { x: number; y: number; z: number; near: number } | null }

/**
 * Releases the next bomb (`bombs` of the F-35C's load left) from `p` in an authoritative CombatWorld at sea time
 * `p.t` (on its step grid) and flies it, the carriers drifting along their courses step by step, until it bursts.
 */
function drop(g: Ground, ships: MovingShip[], p: Plane, bombs: number): Burst {
  const w = new CombatWorld({ ...g, ships }, true)
  w.spawn(1, 0, "f35")
  while (w.t + DT <= p.t + 1e-9) w.step(w.t + DT, [])
  const l = bombLaunch(p, "f35", bombs, MAX, { owner: 1, seq: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, target: -1 })
  expect(w.fire(l, 0)).not.toBeNull()
  let ship: Burst["ship"] = null
  for (let i = 0; i < 60 * 45; i++) {
    for (const s of ships) driftShip(s, DT)
    w.step(w.t + DT, [])
    for (const e of w.events) {
      if (e.k === "ship") ship = { x: e.x, y: e.y, z: e.z, near: e.near }
      if (e.k === "boom") return { x: e.x, y: e.y, z: e.z, water: e.water, ship }
    }
  }
  throw new Error("the bomb never burst")
}

function predict(g: Ground, ships: readonly MovingShip[], p: Plane, bombs: number): BombImpact {
  const l = bombLaunch(p, "f35", bombs, MAX, { owner: 1, seq: 0, t: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, target: -1 })
  return bombImpact(g, ships, l, makeBombImpact())
}

const carrier = (x: number, z: number, heading: number, u: number, r = 0): MovingShip => ({ id: 3, team: 1, x, z, heading, u, v: 0, r, heave: 0.4, pitch: 0.004, roll: -0.006 })

describe("bombImpact: the bombsight's prediction", () => {
  const OPEN: Ground = { sea, arch: null }

  test("lands exactly where a released bomb bursts on the moving sea (speeds, heights, dives, bay and wing stores)", () => {
    let n = 0
    for (const speed of [120, 210, 300])
      for (const [alt, dive] of [
        [250, 0],
        [900, 0],
        [2400, 0],
        [1500, 20 * DEG],
        [1800, 45 * DEG],
        [600, -12 * DEG],
      ] as const)
        for (const bombs of [MAX, 2]) {
          const t0 = 37 + n++ * 13 * DT
          const p = jet(t0, 120, alt, -300, speed, 0.7, dive, bombs === 2 ? 0.3 : -0.15)
          const want = predict(OPEN, [], p, bombs)
          const got = drop(OPEN, [], p, bombs)
          expect(want.kind).toBe("sea")
          expect(got.water).toBe(true)
          expect(Math.abs(want.x - got.x)).toBeLessThan(1e-6)
          expect(Math.abs(want.y - got.y)).toBeLessThan(1e-6)
          expect(Math.abs(want.z - got.z)).toBeLessThan(1e-6)
        }
  })

  test("the jet's velocity carries the bomb: a faster pass at the same height lands further ahead", () => {
    const slow = predict(OPEN, [], jet(10, 0, 1000, 0, 150, 0, 0), MAX)
    const fast = predict(OPEN, [], jet(10, 0, 1000, 0, 300, 0, 0), MAX)
    // Heading north (-z): roughly speed × fall time, a little short of it for the drag.
    expect(-slow.z).toBeGreaterThan(1500)
    expect(-fast.z).toBeGreaterThan(-slow.z * 1.8)
    expect(Math.abs(fast.time - Math.sqrt((2 * 1000) / 9.81))).toBeLessThan(1)
  })

  test("a bomb aimed through a moving carrier's track hits its deck, where the world says it does", () => {
    for (const [u, r, bombs] of [
      [0, 0, MAX],
      [12, 0, 2],
      [20, 0.012, MAX],
    ] as const) {
      const p = jet(50, 0, 1200, 0, 240, 0.4, 10 * DEG)
      const open = predict(OPEN, [], p, bombs)
      // Put the carrier where its course brings it under the bomb as it lands (deck centre, heading across the run).
      const heading = 2.1
      const s0 = carrier(open.x - Math.sin(heading) * u * open.time, open.z + Math.cos(heading) * u * open.time, heading, u, r)
      const want = predict(OPEN, [s0], p, bombs)
      expect(want.kind).toBe("ship")
      expect(want.ship).toBe(0)
      expect(want.local[1]).toBe(DECK_Y)
      const got = drop(OPEN, [{ ...s0 }], p, bombs)
      expect(got.water).toBe(false)
      expect(got.ship).not.toBeNull()
      expect(Math.abs(got.x - want.x)).toBeLessThan(1e-6)
      expect(Math.abs(got.y - want.y)).toBeLessThan(1e-6)
      expect(Math.abs(got.z - want.z)).toBeLessThan(1e-6)
      expect(got.ship!.x).toBeCloseTo(want.local[0], 6)
      expect(got.ship!.y).toBeCloseTo(want.local[1], 6)
      expect(got.ship!.z).toBeCloseTo(want.local[2], 6)
    }
  })

  test("prediction leaves the carriers it is given where they were", () => {
    const s = carrier(100, 200, 1, 15, 0.01)
    const before = { ...s }
    predict(OPEN, [s], jet(5, 0, 800, 0, 200, 0, 0), MAX)
    expect(s).toEqual(before)
  })

  test("over an island it bursts on the ground the world strikes", () => {
    const arch = archipelagoFor(7)
    const isl = [...arch.islands].sort((a, b) => b.peak - a.peak)[0]!
    const g: Ground = { sea, arch }
    // A run at the island's peak from 3 km out, released at 1,400 m.
    const p = jet(80, isl.x, 1400, isl.z + 2600, 230, 0, 15 * DEG)
    const want = predict(g, [], p, MAX)
    const got = drop(g, [], p, MAX)
    expect(want.kind).toBe("land")
    expect(want.y).toBeGreaterThan(terrainHeight(arch, want.x, want.z) - 40)
    expect(Math.abs(want.x - got.x)).toBeLessThan(1e-6)
    expect(Math.abs(want.y - got.y)).toBeLessThan(1e-6)
    expect(Math.abs(want.z - got.z)).toBeLessThan(1e-6)
  })
})
