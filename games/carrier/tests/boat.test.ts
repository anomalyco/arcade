import { describe, expect, test } from "bun:test"
import {
  BOAT,
  BOAT_HEALTH,
  BOAT_MODE,
  type Boat,
  BoatCombat,
  type BoatControls,
  type BoatNet,
  type BoatObstacle,
  BoatRounds,
  type BoatTarget,
  CRANE,
  GUN,
  KNOT,
  boatDamage,
  boatSegmentHit,
  boatStep,
  carrierHalfBeam,
  copyBoat,
  cranePose,
  isBoatTuple,
  makeBoat,
  makeTurret,
  muzzleWorld,
  packBoat,
  recoverTime,
  recoverable,
  releaseBoat,
  turretGun,
  turretStep,
  unpackBoat,
} from "../shared/boat"
import { headingTo, makeShip } from "../shared/ship"
import { makeArchipelago, terrainHeight } from "../shared/islands"
import { makeSea, seaHeight, type Sea } from "../shared/sea"
import { makeWeatherSea, WEATHER_PRESETS } from "../shared/weather"
import type { Vec3 } from "../shared/plane"

const FULL: BoatControls = { throttle: 1, steer: 0, boost: false }
const IDLE: BoatControls = { throttle: 0, steer: 0, boost: false }

/** A sea with every wave flattened to 1% (dynamics without swell). */
function calm(): Sea {
  const s = makeSea(7)
  return { ...s, waves: s.waves.map((w) => ({ ...w, amp: w.amp * 0.01 })) }
}

function storm(): Sea {
  const w = makeWeatherSea(makeSea(7))
  w.set(WEATHER_PRESETS.heavy)
  return w.sea
}

function run(b: Boat, seconds: number, c: BoatControls, sea: Sea, arch: ReturnType<typeof makeArchipelago> | null = null, ships: BoatObstacle[] = [], each?: (b: Boat) => void, dt: number = BOAT.tick): void {
  const n = Math.round(seconds / dt)
  for (let i = 0; i < n; i++) {
    boatStep(b, c, sea, arch, ships, dt)
    each?.(b)
  }
}

const finite = (b: Boat) => [b.x, b.z, b.heading, b.u, b.v, b.r, b.heave, b.pitch, b.roll].every(Number.isFinite)

describe("boat sim", () => {
  test("is deterministic", () => {
    const sea = storm()
    const a = makeBoat(10, 20, 0.4, 50)
    const b = makeBoat(10, 20, 0.4, 50)
    const plan = (i: number): BoatControls => ({ throttle: i % 400 < 300 ? 1 : -0.3, steer: Math.sin(i / 90), boost: i % 700 < 120 })
    for (let i = 0; i < 1800; i++) {
      boatStep(a, plan(i), sea, null)
      boatStep(b, plan(i), sea, null)
    }
    expect(a).toEqual(b)
  })

  test("floats at rest on the waterline, level", () => {
    const sea = calm()
    const b = makeBoat(0, 0, 0)
    run(b, 20, IDLE, sea)
    const wy = seaHeight(sea, b.x, b.z, b.t)
    // The origin is the rest waterline: the hull sits within a few cm of it.
    expect(Math.abs(b.heave - wy)).toBeLessThan(0.08)
    expect(Math.abs(b.pitch)).toBeLessThan(0.02)
    expect(Math.abs(b.roll)).toBeLessThan(0.02)
    expect(b.wet).toBe(1)
    expect(Math.abs(b.u)).toBeLessThan(0.05)
  })

  test("reaches ~45 kn, most of it in ~4 s", () => {
    const sea = calm()
    const b = makeBoat(0, 0, 0)
    let t90 = -1
    run(b, 15, FULL, sea, null, [], (x) => {
      if (t90 < 0 && x.u > 0.85 * BOAT.topSpeed) t90 = x.t
    })
    expect(b.u / KNOT).toBeGreaterThan(43)
    expect(b.u / KNOT).toBeLessThan(47)
    expect(t90).toBeGreaterThan(2)
    expect(t90).toBeLessThan(5)
  })

  test("boost is a short burst faster than top speed, then recharges", () => {
    const sea = calm()
    const b = makeBoat(0, 0, 0)
    run(b, 10, FULL, sea)
    let peak = 0
    run(b, BOAT.boostTime + 1, { ...FULL, boost: true }, sea, null, [], (x) => (peak = Math.max(peak, x.u)))
    expect(peak).toBeGreaterThan(BOAT.topSpeed * 1.08)
    expect(b.boosting).toBe(false)
    expect(b.boost).toBeLessThan(0.1)
    run(b, BOAT.boostRecharge + 0.5, FULL, sea)
    expect(b.boost).toBe(1)
  })

  test("turns a tight circle at speed (~60 m across) and heels into it", () => {
    const sea = calm()
    const b = makeBoat(0, 0, 0)
    run(b, 10, FULL, sea)
    run(b, 6, { ...FULL, steer: 1 }, sea)
    const radius = b.u / b.r
    expect(radius * 2).toBeGreaterThan(40)
    expect(radius * 2).toBeLessThan(80)
    // Heels INTO a starboard turn: starboard down is roll > 0.
    expect(b.roll).toBeGreaterThan(0.05)
  })

  test("goes astern and stops", () => {
    const sea = calm()
    const b = makeBoat(0, 0, 0)
    run(b, 8, FULL, sea)
    run(b, 12, { throttle: -BOAT.astern, steer: 0, boost: false }, sea)
    expect(b.u).toBeLessThan(-1)
    run(b, 25, IDLE, sea)
    expect(Math.abs(b.u)).toBeLessThan(0.1)
  })

  test("planes: the bow rises at speed and settles when slow", () => {
    const sea = calm()
    const b = makeBoat(0, 0, 0)
    run(b, 5, IDLE, sea)
    const rest = b.pitch
    let hump = 0
    run(b, 12, FULL, sea, null, [], (x) => (hump = Math.max(hump, x.pitch)))
    const plane = b.pitch
    expect(hump).toBeGreaterThan(rest + 0.05)
    expect(plane).toBeGreaterThan(rest + 0.03)
    // Up on the plane the hull also rides higher.
    expect(b.heave - seaHeight(sea, b.x, b.z, b.t)).toBeGreaterThan(0.15)
    run(b, 30, IDLE, sea)
    expect(Math.abs(b.pitch - rest)).toBeLessThan(0.02)
  })

  test("gets airborne off storm crests and slams back down", () => {
    const sea = storm()
    const b = makeBoat(0, 0, 0, 100)
    let maxAir = 0
    let maxClear = 0
    run(b, 90, FULL, sea, null, [], (x) => {
      maxAir = Math.max(maxAir, x.air)
      maxClear = Math.max(maxClear, x.clear)
      expect(finite(x)).toBe(true)
    })
    expect(maxAir).toBeGreaterThan(0.6)
    expect(maxClear).toBeGreaterThan(2)
    expect(b.slams).toBeGreaterThan(3)
    // It always comes back down into the water.
    expect(Math.abs(b.heave - seaHeight(sea, b.x, b.z, b.t))).toBeLessThan(25)
  })

  test("calm seas barely toss it", () => {
    const sea = makeSea(7)
    const b = makeBoat(0, 0, Math.PI / 2, 100)
    let maxClear = 0
    run(b, 60, FULL, sea, null, [], (x) => (maxClear = Math.max(maxClear, x.clear)))
    expect(maxClear).toBeLessThan(3)
  })

  for (const hz of [30, 60, 144]) {
    test(`stays stable in a storm at ${hz} Hz`, () => {
      const sea = storm()
      const b = makeBoat(0, 0, 0.3, 100)
      let ok = true
      run(b, 40, { throttle: 1, steer: 0.4, boost: false }, sea, null, [], (x) => {
        if (!finite(x) || Math.abs(x.heave) > 60 || Math.abs(x.pitch) > BOAT.maxPitch + 0.05 || Math.abs(x.roll) > BOAT.maxRoll + 0.05) ok = false
      }, 1 / hz)
      expect(ok).toBe(true)
      expect(b.u).toBeGreaterThan(10)
    })
  }

  test("runs aground on an island instead of passing through it", () => {
    const arch = makeArchipelago(7)
    const isl = arch.islands[0]!
    const sea = calm()
    const d = Math.hypot(isl.x, isl.z)
    const start = isl.radius * 1.6 + 600
    const x = isl.x - (isl.x / d) * start
    const z = isl.z - (isl.z / d) * start
    const b = makeBoat(x, z, headingTo(x, z, isl.x, isl.z))
    let grounded = false
    run(b, 120, FULL, sea, arch, [], (q) => {
      if (q.ground > 0.05) grounded = true
    })
    expect(grounded).toBe(true)
    // It never ends up on dry land.
    expect(terrainHeight(arch, b.x, b.z)).toBeLessThan(1)
    expect(Math.hypot(b.x - isl.x, b.z - isl.z)).toBeGreaterThan(isl.radius * 0.4)
  })

  test("bounces off a carrier's hull instead of passing through", () => {
    const sea = calm()
    // A carrier heading north at the origin; the boat comes at its starboard side from the east, heading west.
    const ship: BoatObstacle = { x: 0, z: 0, heading: 0, u: 0, v: 0, r: 0 }
    const b = makeBoat(150, 20, -Math.PI / 2)
    let minX = Infinity
    let hit = false
    run(b, 20, FULL, sea, null, [ship], (q) => {
      minX = Math.min(minX, q.x)
      if (q.ground > 0.05) hit = true
    })
    expect(hit).toBe(true)
    // Starboard half-beam amidships is 25.6 m; the boat's half-beam 2.8: it never gets inside.
    expect(minX).toBeGreaterThan(carrierHalfBeam(20) - 1)
  })

  test("the world edge turns it back", () => {
    const sea = calm()
    const b = makeBoat(BOAT.edge + 300, 0, Math.PI / 2)
    run(b, 60, FULL, sea)
    expect(b.x).toBeLessThan(BOAT.edge + 900)
  })
})

describe("launch and recovery", () => {
  const ship = Object.assign(makeShip(0, 0, 0.5), { u: 8, v: 0, r: 0, heave: 0.3, pitch: 0.01, roll: -0.02 })

  test("the crane carries it from the elevator down to the water", () => {
    const sea = calm()
    const water = (x: number, z: number) => seaHeight(sea, x, z, 0)
    const out = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 }
    cranePose(0, ship, water, null, out)
    expect(out.y).toBeGreaterThan(20)
    cranePose(CRANE.release, ship, water, null, out)
    expect(Math.abs(out.y - water(out.x, out.z))).toBeLessThan(0.05)
    // Swung out over the port side, clear of the hull.
    const local = { s: (out.x - ship.x) * Math.cos(ship.heading) + (out.z - ship.z) * Math.sin(ship.heading) }
    expect(-local.s).toBeGreaterThan(carrierHalfBeam(CRANE.z) + 3)
  })

  test("released, it moves with the carrier", () => {
    const b = releaseBoat(makeBoat(0, 0, 0), ship, 0, 10)
    expect(b.heading).toBeCloseTo(ship.heading, 6)
    expect(b.u).toBeCloseTo(ship.u, 1)
    expect(b.t).toBe(10)
  })

  test("only slow, nearby boats are picked up", () => {
    const sea = calm()
    const b = releaseBoat(makeBoat(0, 0, 0), ship, 0, 0)
    boatStep(b, IDLE, sea, null)
    // Moving with the carrier at the crane point: recoverable.
    expect(recoverable(b, ship)).not.toBeNull()
    // Too fast relative to it.
    const fast = copyBoat(b, makeBoat(0, 0, 0))
    fast.u += 12
    expect(recoverable(fast, ship)).toBeNull()
    // Far away.
    const far = copyBoat(b, makeBoat(0, 0, 0))
    far.x += 400
    expect(recoverable(far, ship)).toBeNull()
    // Behind the stern, slow: recoverable.
    const stern = copyBoat(b, makeBoat(0, 0, 0))
    stern.x = ship.x - Math.sin(ship.heading) * 200
    stern.z = ship.z + Math.cos(ship.heading) * 200
    expect(recoverable(stern, ship)).not.toBeNull()
    // In the air: no.
    const air = copyBoat(b, makeBoat(0, 0, 0))
    air.wet = 0
    expect(recoverable(air, ship)).toBeNull()
  })

  test("a recovery hoists it back up onto the elevator", () => {
    const sea = calm()
    const water = (x: number, z: number) => seaHeight(sea, x, z, 0)
    const from = { x: 70, z: -20, yaw: 0.3 }
    const T = recoverTime(from.x, from.z)
    expect(T).toBeGreaterThan(CRANE.hoist)
    expect(T).toBeLessThan(8)
    const out = { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 }
    cranePose(0, ship, water, from, out)
    expect(Math.abs(out.y - water(out.x, out.z))).toBeLessThan(0.05)
    cranePose(T, ship, water, from, out)
    expect(out.y).toBeGreaterThan(20)
  })
})

describe("turret and rounds", () => {
  test("slews to the aim inside its arcs, not through the wheelhouse", () => {
    const b = makeBoat(0, 0, 0)
    const tr = makeTurret()
    // Aim ahead and to port, a little up: north is −z, port is west (−x) for heading 0.
    for (let i = 0; i < 120; i++) turretStep(tr, b, -300, 30, -300, BOAT.tick)
    expect(tr.onTarget).toBe(true)
    expect(tr.yaw).toBeGreaterThan(0.6)
    // Dead astern: clamped to the arc, never on target.
    for (let i = 0; i < 240; i++) turretStep(tr, b, 0, 2, 500, BOAT.tick)
    expect(Math.abs(tr.yaw)).toBeLessThanOrEqual(GUN.arc + 1e-9)
    expect(tr.onTarget).toBe(false)
  })

  test("fires at its rate and overheats", () => {
    const tr = makeTurret()
    let n = 0
    let t = 0
    while (!tr.overheated && t < 20) {
      n += turretGun(tr, true, BOAT.tick)
      t += BOAT.tick
    }
    expect(t).toBeCloseTo(GUN.heatTime, 0)
    expect(n / t).toBeCloseTo(GUN.rate, 0)
    expect(turretGun(tr, true, BOAT.tick)).toBe(0)
  })

  test("rounds hit an enemy boat, never a friendly one", () => {
    const sea = calm()
    const me = makeBoat(0, 0, 0)
    const enemy = makeBoat(0, -400, Math.PI / 2)
    const friend = makeBoat(0, -400, Math.PI / 2)
    const pos: Vec3 = [0, 0, 0]
    const dir: Vec3 = [0, 0, 0]
    const tr = makeTurret()
    for (let i = 0; i < 120; i++) turretStep(tr, me, 0, 1.5, -400, BOAT.tick)
    muzzleWorld(me, tr.yaw, tr.pitch, pos, dir)
    for (const [target, team, expectHit] of [
      [enemy, 1, true],
      [friend, 0, false],
    ] as const) {
      const r = new BoatRounds()
      const hits: string[] = []
      const boats: BoatTarget[] = [{ id: 7, team, pose: target, vx: 0, vz: 0, alive: true }]
      for (let k = 0; k < 6; k++) r.fire(1, 0, k, pos[0], pos[1], pos[2], dir[0], dir[1], dir[2], 0, 0)
      for (let i = 0; i < 60; i++) r.step(BOAT.tick, i * BOAT.tick, [], boats, { sea, arch: null }, (_o, kind, id) => hits.push(`${kind}:${id}`))
      expect(hits.some((h) => h === "boat:7")).toBe(expectHit)
    }
  })

  test("rounds hit a low jet in range", () => {
    const sea = calm()
    const r = new BoatRounds()
    const hits: string[] = []
    const jet = { id: 9, team: 1, x: 0, y: 60, z: -600, vx: 0, vy: 0, vz: 0, alive: true }
    const d = Math.hypot(60, 600)
    for (let k = 0; k < 4; k++) r.fire(1, 0, k, 0, 2.5, 0, 0, 60 / d + 0.0015, -600 / d, 0, 0)
    for (let i = 0; i < 70; i++) r.step(BOAT.tick, i * BOAT.tick, [jet], [], { sea, arch: null }, (_o, kind, id) => hits.push(`${kind}:${id}`))
    expect(hits).toContain("jet:9")
  })

  test("the box test finds a boat's hull", () => {
    const b = Object.assign(makeBoat(100, 50, 1), { heave: 0.2 })
    expect(boatSegmentHit(b, 100, 2, 0, 100, 2, 100)).toBeGreaterThanOrEqual(0)
    expect(boatSegmentHit(b, 100, 20, 0, 100, 20, 100)).toBe(-1)
  })
})

describe("boat health", () => {
  test("damage, friendly fire off, kill credit, repair", () => {
    const c = new BoatCombat()
    c.spawn(1, 0)
    expect(c.hit(1, 2, 0, "cannon", 50)).toBe(0)
    expect(c.hit(1, 1, 0, "cannon", 50)).toBe(0)
    expect(c.hit(1, 2, 1, "cannon", boatDamage("cannon", 10))).toBeGreaterThan(0)
    expect(c.hp(1)).toBe(BOAT_HEALTH.max - boatDamage("cannon", 10))
    c.step(BOAT_HEALTH.repairDelay + 5)
    expect(c.hp(1)).toBeGreaterThan(BOAT_HEALTH.max - boatDamage("cannon", 10))
    c.events.length = 0
    c.hit(1, 2, 1, "missile", boatDamage("missile", 1, 0))
    c.hit(1, 2, 1, "bomb", boatDamage("bomb", 1, 0))
    expect(c.boats.get(1)!.alive).toBe(false)
    expect(c.events.some((e) => e.k === "bkill" && e.on === 1 && e.by === 2)).toBe(true)
  })

  test("a boat lost after a hit credits the attacker", () => {
    const c = new BoatCombat()
    c.spawn(1, 0)
    c.hit(1, 5, 1, "gun", boatDamage("gun", 3))
    c.lose(1)
    expect(c.events.at(-1)).toEqual({ k: "bkill", on: 1, by: 5, w: "gun" })
  })

  test("the round budget limits reported hits", () => {
    const c = new BoatCombat()
    c.spawn(1, 0)
    expect(c.spend(1, 100)).toBeLessThanOrEqual(GUN.rate)
    expect(c.spend(1, 100)).toBe(0)
    c.step(2)
    expect(c.spend(1, 100)).toBeGreaterThan(0)
  })

  test("explosives fall off with distance, a missile and a bomb finish it", () => {
    expect(boatDamage("missile", 1, 0)).toBeGreaterThan(boatDamage("missile", 1, 10))
    expect(boatDamage("missile", 1, 20)).toBe(0)
    expect(boatDamage("missile") + boatDamage("bomb")).toBeGreaterThanOrEqual(BOAT_HEALTH.max)
    // A jet's gun takes a fair burst: more than a second of solid hits.
    expect(BOAT_HEALTH.max / boatDamage("gun")).toBeGreaterThan(50)
  })
})

describe("wire", () => {
  test("round-trips a boat tuple", () => {
    const n: BoatNet = { id: 4, t: 123.456, x: -1200.25, z: 845.5, heading: -2.1, u: 22.4, v: -0.7, r: 0.31, power: 0.8, rudder: -0.4, yaw: 0.9, pitch: 0.12, mode: BOAT_MODE.recover, modeAt: 120.5, ship: 3, from: { x: 62, z: -14, yaw: 0.2 }, firing: true, boosting: false }
    const t = packBoat(n)
    expect(isBoatTuple(t)).toBe(true)
    const back = unpackBoat(JSON.parse(JSON.stringify(t)))
    expect(back.id).toBe(4)
    expect(back.mode).toBe(BOAT_MODE.recover)
    expect(back.from).toEqual({ x: 62, z: -14, yaw: 0.2 })
    expect(back.x).toBeCloseTo(n.x, 1)
    expect(back.heading).toBeCloseTo(n.heading, 3)
    expect(back.firing).toBe(true)
    expect(isBoatTuple([...t, 1])).toBe(false)
    expect(isBoatTuple(t.map((v, i) => (i === 12 ? 9 : v)))).toBe(false)
    expect(unpackBoat(packBoat({ ...n, mode: BOAT_MODE.drive })).from).toBeNull()
  })
})
