import { describe, expect, test } from "bun:test"
import { CombatWorld, type CombatEvent, type GroundShip } from "../shared/combat"
import { BOW_Z, DECK_Y, ISLAND } from "../shared/carrier-spec"
import { CREW, type Crew, createShip, joinCrew, playerOf, recover, runOp, scuttle, shipOf } from "../shared/crew"
import { FLEET, Fleet, deckOpen, hullLimits, hullZone, isHullTuple, makeHull, packHull, settleOf, settled, shipDamage, unpackHull, waterlineDistance } from "../shared/fleet"
import { PLANE, shipToWorld } from "../shared/plane"
import { makeSea } from "../shared/sea"
import { SHIP, makeShip, shipStep } from "../shared/ship"

const pct = (v: number) => (v / FLEET.hp) * 100

describe("ship damage values", () => {
  test("guns chip, a missile ~5%, a direct bomb ~17.5%, four bombs ~70%, a crash ~5%, near misses less", () => {
    // A full gun overheat run: 3.2 s at 50 rps.
    expect(pct(shipDamage("gun") * 160)).toBeGreaterThanOrEqual(3)
    expect(pct(shipDamage("gun") * 160)).toBeLessThanOrEqual(5)
    expect(pct(shipDamage("missile"))).toBeGreaterThanOrEqual(4)
    expect(pct(shipDamage("missile"))).toBeLessThanOrEqual(6)
    expect(pct(shipDamage("bomb"))).toBeGreaterThanOrEqual(15)
    expect(pct(shipDamage("bomb"))).toBeLessThanOrEqual(20)
    expect(pct(shipDamage("bomb") * 4)).toBeGreaterThanOrEqual(60)
    expect(pct(shipDamage("bomb") * 4)).toBeLessThanOrEqual(80)
    expect(pct(shipDamage("crash"))).toBe(5)
    expect(shipDamage("bomb", 1)).toBeLessThan(shipDamage("bomb"))
    expect(shipDamage("bomb", 20)).toBeLessThan(shipDamage("bomb", 5))
    expect(shipDamage("bomb", FLEET.near + 1)).toBe(0)
  })

  test("friendly fire is off; zones: the island slows the ship, the deck burns and closes", () => {
    const f = new Fleet()
    f.add(1, 0)
    expect(f.hit({ ship: 1, by: 9, team: 0, w: "bomb", x: 0, y: DECK_Y, z: 0, near: 0 }, 10)).toBe(0)
    expect(f.hulls.get(1)!.hp).toBe(FLEET.hp)
    expect(hullZone(15, DECK_Y, 50)).toBe("deck")
    expect(hullZone(-30, DECK_Y + 20, -30)).toBe("island")
    expect(hullZone(25, 8, 0)).toBe("hull")
    f.hit({ ship: 1, by: 9, team: 1, w: "bomb", x: (ISLAND.x0 + ISLAND.x1) / 2, y: DECK_Y + 20, z: (ISLAND.z0 + ISLAND.z1) / 2, near: 0 }, 10)
    const h = f.hulls.get(1)!
    expect(h.hp).toBe(FLEET.hp - FLEET.bomb)
    expect(hullLimits(h).speed).toBeLessThan(1)
    expect(deckOpen(h, 10)).toBe(true)
    f.hit({ ship: 1, by: 9, team: 1, w: "missile", x: 15, y: DECK_Y, z: 40, near: 0 }, 12)
    expect(deckOpen(h, 13)).toBe(false)
    expect(deckOpen(h, 12 + FLEET.deckFire + 0.1)).toBe(true)
    expect(h.fires.length).toBe(2)
  })

  test("repair after a quiet spell; fires go out once the hull is out of danger", () => {
    const f = new Fleet()
    f.add(1, 0)
    f.hit({ ship: 1, by: 9, team: 1, w: "missile", x: 0, y: DECK_Y, z: 0, near: 0 }, 0)
    let t = 0
    for (; t < FLEET.repairDelay - 1; t += 0.05) f.step(t, 0.05)
    expect(f.hulls.get(1)!.hp).toBe(FLEET.hp - FLEET.missile)
    for (; t < FLEET.repairDelay + 60; t += 0.05) f.step(t, 0.05)
    expect(f.hulls.get(1)!.hp).toBe(FLEET.hp)
    expect(f.hulls.get(1)!.fires.length).toBe(0)
  })

  test("settle: lower and listing as health falls, then down by the bow while sinking", () => {
    const h = makeHull(1, 0)
    expect(settleOf(h, 0)).toEqual({ heave: -0, pitch: 0, roll: 0 })
    h.hp = 300
    h.side = 100 // hits on the port side
    const s = settleOf(h, 0)
    expect(s.heave).toBeLessThan(-1)
    expect(s.roll).toBeLessThan(0)
    h.hp = 0
    h.sinkAt = 100
    const deep = settleOf(h, 100 + FLEET.sinkTime)
    expect(deep.heave).toBeLessThan(-FLEET.sinkDepth + 1)
    expect(deep.pitch).toBeLessThan(-0.2)
  })

  test("a ship at zero health sinks, then goes under after sinkTime", () => {
    const f = new Fleet()
    f.add(3, 1)
    for (let i = 0; i < 5; i++) f.hit({ ship: 3, by: 7, team: 0, w: "bomb", x: 0, y: DECK_Y, z: 0, near: 0 }, i)
    expect(f.hit({ ship: 3, by: 8, team: 0, w: "bomb", x: 0, y: DECK_Y, z: 0, near: 0 }, 5)).toBeGreaterThan(0)
    expect(f.events.filter((e) => e.k === "sinking")).toEqual([{ k: "sinking", ship: 3, by: 8 }])
    expect(hullLimits(f.hulls.get(3)).speed).toBe(0)
    // No more damage while it goes down.
    expect(f.hit({ ship: 3, by: 7, team: 0, w: "bomb", x: 0, y: DECK_Y, z: 0, near: 0 }, 6)).toBe(0)
    for (let t = 6; t < 5 + FLEET.sinkTime + 1; t += 0.1) f.step(t, 0.1)
    expect(f.events.filter((e) => e.k === "sunk")).toEqual([{ k: "sunk", ship: 3, by: 8 }])
  })

  test("hulls round-trip on the wire", () => {
    const f = new Fleet()
    const h = f.add(4, 1)
    f.hit({ ship: 4, by: 2, team: 0, w: "bomb", x: 10.4, y: DECK_Y, z: -40.2, near: 0 }, 50)
    f.hit({ ship: 4, by: 2, team: 0, w: "bomb", x: -30, y: DECK_Y + 20, z: -30, near: 0 }, 51)
    const v = packHull(h, 53)
    expect(isHullTuple(v)).toBe(true)
    expect(isHullTuple(JSON.parse(JSON.stringify(v)))).toBe(true)
    const u = unpackHull(v, 53, 1)
    expect(u.hp).toBeCloseTo(h.hp, 1)
    expect(u.island).toBeCloseTo(h.island, 3)
    expect(u.fires.length).toBe(2)
    expect(u.fires[0]).toEqual({ x: 10, y: DECK_Y, z: -40, t: 50 })
    expect(deckOpen(u, 53)).toBe(false)
    expect(isHullTuple([1, 2, 3])).toBe(false)
  })
})

test("the fleet is deterministic: the same hits and steps give the same hulls", () => {
  const run = () => {
    const f = new Fleet()
    f.add(1, 0)
    f.add(2, 1)
    let t = 0
    for (let i = 0; i < 600; i++) {
      t += 0.05
      if (i % 37 === 0) f.hit({ ship: 2, by: 3, team: 0, w: i % 2 ? "bomb" : "missile", x: (i % 7) - 3, y: DECK_Y, z: i - 300, near: 0 }, t)
      if (i % 11 === 0) f.hit({ ship: 1, by: 4, team: 1, w: "gun", x: 0, y: DECK_Y, z: 0, near: 0, n: 12 }, t)
      f.step(t, 0.05)
    }
    return JSON.stringify({ h: [...f.hulls.values()], e: f.events })
  }
  expect(run()).toBe(run())
})

describe("bombs and missiles against a moving, pitching carrier", () => {
  /** A carrier at speed on a big swell (it pitches and heaves), and an F-35C's bomb dropped to hit `offset` m off its bow line. */
  function drop(aimX: number): { events: CombatEvent[]; pitch: number } {
    const sea = makeSea(7)
    const ship = makeShip(0, 0, 0, 0)
    const ctl = { throttle: 1, rudder: 0 }
    for (let i = 0; i < 40 / SHIP.tick; i++) shipStep(ship, ctl, sea, null, SHIP.tick)
    const gs: GroundShip = Object.assign({}, ship, { id: 5, team: 1 })
    const w = new CombatWorld({ sea, arch: null, ships: [gs] }, true)
    w.spawn(1, 0, "f35", ship.t)
    w.t = ship.t
    // Release 400 m up, ahead of the ship, timed so the bomb falls onto the moving deck at ship-local (aimX, 60).
    const fall = Math.sqrt((2 * (400 - DECK_Y)) / 9.81)
    const lead = ship.u * fall
    const at = shipToWorld(ship, aimX, 0, 60, [0, 0, 0])
    const fwd = [Math.sin(ship.heading), -Math.cos(ship.heading)]
    w.fire({ owner: 1, seq: 0, t: ship.t, x: at[0] + fwd[0]! * lead - fwd[0]! * 150 * fall, y: 400, z: at[2] + fwd[1]! * lead - fwd[1]! * 150 * fall, vx: fwd[0]! * 150, vy: 0, vz: fwd[1]! * 150, target: -1, kind: "bomb" })
    const events: CombatEvent[] = []
    let pitch = 0
    for (let i = 0; i < 15 / PLANE.tick && !events.some((e) => e.k === "boom"); i++) {
      shipStep(ship, ctl, sea, null, SHIP.tick)
      Object.assign(gs, ship)
      pitch = Math.max(pitch, Math.abs(ship.pitch))
      w.step(ship.t, [])
      events.push(...w.events.splice(0))
    }
    return { events, pitch }
  }

  test("a bomb onto the runway is a direct deck hit; one 15 m off the side is a near miss", () => {
    const hit = drop(15)
    expect(hit.pitch).toBeGreaterThan(0.002)
    const direct = hit.events.find((e) => e.k === "ship")
    expect(direct).toMatchObject({ k: "ship", ship: 5, owner: 1, w: "bomb", near: 0 })
    if (direct?.k !== "ship") throw new Error()
    expect(direct.y).toBe(DECK_Y)
    expect(hullZone(direct.x, direct.y, direct.z)).toBe("deck")
    const miss = drop(-(51 / 2 + 15))
    const near = miss.events.find((e) => e.k === "ship")
    expect(near).toBeDefined()
    if (near?.k !== "ship") throw new Error()
    expect(near.near).toBeGreaterThan(5)
    expect(near.near).toBeLessThanOrEqual(FLEET.near)
    expect(miss.events.find((e) => e.k === "boom")).toMatchObject({ water: true })
    // Far off: no ship event at all.
    expect(drop(-120).events.some((e) => e.k === "ship")).toBe(false)
  })

  test("a dumbfire missile into the hull side is a direct hit", () => {
    const ship = makeShip(0, 0, 0, 0)
    const gs: GroundShip = Object.assign({}, ship, { id: 2, team: 1 })
    const w = new CombatWorld({ sea: null, arch: null, ships: [gs] }, true)
    w.spawn(1, 0)
    // From the port beam, level with the hangar, flying at the hull.
    const at = shipToWorld(ship, 300, 20, 0, [0, 0, 0])
    const to = shipToWorld(ship, 0, 20, 0, [0, 0, 0])
    const d = Math.hypot(to[0] - at[0], to[2] - at[2])
    w.fire({ owner: 1, seq: 0, t: 0, x: at[0], y: 22, z: at[2], vx: ((to[0] - at[0]) / d) * 250, vy: 0, vz: ((to[2] - at[2]) / d) * 250, target: -1 })
    for (let i = 0; i < 6 / PLANE.tick; i++) w.step(w.t + PLANE.tick, [])
    const e = w.events.find((x) => x.k === "ship")
    expect(e).toMatchObject({ ship: 2, w: "missile", near: 0 })
    if (e?.k !== "ship") throw new Error()
    expect(hullZone(e.x, e.y, e.z)).toBe("hull")
  })

  test("settled poses agree everywhere: the same health gives the same offset", () => {
    const h = makeHull(1, 0)
    h.hp = 400
    h.side = -1
    const a = settled(makeShip(0, 0, 0), h, 10, makeShip(0, 0, 0))
    const b = settled(makeShip(0, 0, 0), unpackHull(packHull(h, 10), 10), 10, makeShip(0, 0, 0))
    expect(b.heave).toBeCloseTo(a.heave, 6)
    expect(b.roll).toBeCloseTo(a.roll, 6)
  })

  test("waterline distance", () => {
    expect(waterlineDistance(0, 0)).toBe(0)
    expect(waterlineDistance(51 / 2 + 10, 0)).toBeCloseTo(10)
    expect(waterlineDistance(0, BOW_Z + 20)).toBeCloseTo(20)
  })
})

describe("sinking and the crew", () => {
  /**
   * Team 1 has ship A (helm 1, pilot 2 on deck, pilot 3 in the air) and ship B (helm 4); team 0 has ship C (helm 5).
   */
  function fleet(): { c: Crew; sunk: number; other: number } {
    const c: Crew = { seed: 1, made: 3, nextShip: 4, ships: [], players: [] }
    const ship = (id: number, team: number, helm: number, pilots: number[]) =>
      c.ships.push({ id, name: `CV-0${id}`, hull: id, team, slot: id, helm, pilots, aircraft: [{ op: "hornet", pilot: null, readyAt: 0 }, { op: "hornet", pilot: null, readyAt: 0 }, { op: "f35", pilot: null, readyAt: 0 }], emptySince: null, captain: helm, locked: false, bans: [] })
    ship(1, 1, 1, [2, 3])
    ship(2, 1, 4, [])
    ship(3, 0, 5, [])
    const player = (id: number, team: number, shipId: number, role: "helm" | "pilot") => c.players.push({ id, name: `p${id}`, team, ship: shipId, role, plane: -1, mount: -1, sortie: 0, waitSince: 0, since: 0 })
    player(1, 1, 1, "helm")
    player(2, 1, 1, "pilot")
    player(3, 1, 1, "pilot")
    player(4, 1, 2, "helm")
    player(5, 0, 3, "helm")
    expect(runOp(c, 3, "hornet", 2).error).toBeUndefined()
    expect(playerOf(c, 3)!.plane).toBe(0)
    return { c, sunk: 1, other: 2 }
  }

  test("scuttling moves the helm and the deck crew to another ship; an airborne pilot keeps flying", () => {
    const { c, sunk, other } = fleet()
    const sortie = playerOf(c, 3)!.sortie
    const out = scuttle(c, sunk, 10)
    expect(out.error).toBeUndefined()
    expect(out.events[0]).toEqual({ k: "sink", ship: sunk })
    expect(shipOf(c, sunk)).toBeUndefined()
    for (const id of [1, 2, 3]) {
      const p = playerOf(c, id)!
      expect(p.team).toBe(1)
      expect(shipOf(c, p.ship)!.team).toBe(1)
    }
    const flier = playerOf(c, 3)!
    expect(flier.plane).toBeGreaterThanOrEqual(0)
    expect(flier.sortie).toBe(sortie)
    expect(shipOf(c, flier.ship)!.aircraft[flier.plane]!.pilot).toBe(3)
    expect(playerOf(c, 1)!.ship === other || playerOf(c, 1)!.ship !== sunk).toBe(true)
    // Nobody is aboard a ship that no longer exists, and ships stay within capacity.
    for (const s of c.ships) expect((s.helm !== null ? 1 : 0) + s.pilots.length).toBeLessThanOrEqual(CREW.capacity)
  })

  test("the rescued airborne pilot lands on another friendly ship and joins it; its extra slot goes away", () => {
    const { c, sunk } = fleet()
    scuttle(c, sunk, 10)
    // Everyone went to ship 2 (the only team-1 ship with room): the flier holds one of its slots.
    expect(playerOf(c, 3)!.ship).toBe(2)
    // Team 1 commissions another ship; the flier lands on it and joins it.
    createShip(c, 2, 1, 15)
    const third = playerOf(c, 2)!.ship
    expect(third).not.toBe(2)
    const out = recover(c, 3, "landed", 20, third)
    expect(out.error).toBeUndefined()
    expect(playerOf(c, 3)).toMatchObject({ ship: third, plane: -1, role: "pilot" })
    expect(out.events.some((e) => e.k === "board" && e.to === third)).toBe(true)
    // A ship of the other team doesn't take a landing pilot.
    runOp(c, 3, "hornet", 21)
    recover(c, 3, "landed", 30, 3)
    expect(playerOf(c, 3)!.ship).toBe(third)
    for (const s of c.ships) expect(s.aircraft.length).toBeLessThanOrEqual(3)
  })
})
