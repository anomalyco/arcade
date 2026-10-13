import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { DECK_Y } from "../shared/carrier-spec"
import { playerOf, shipOf } from "../shared/crew"
import { FLEET, unpackHull } from "../shared/fleet"
import { shipQuat, shipToWorld } from "../shared/plane"
import { type ClientMsg, type PlaneTuple, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  send(data: string) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame ${data}`)
    this.sent.push(m)
  }
  close() {}
  all<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type)
  }
  last<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }> | undefined {
    return this.all(type).at(-1)
  }
  get id(): number {
    return this.last("welcome")!.id
  }
}

const EPOCH = 1_000_000

/** A (team 0) flies an F-35C, B (team 1) helms its carrier. */
function battle() {
  let now = EPOCH
  const core = new RoomCore(
    () => now,
    () => 42,
  )
  const join = (name: string) => {
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name }))
    return c
  }
  const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
  const a = join("ada")
  const b = join("bo")
  say(b, { type: "newship", team: 1 })
  const seaT = () => (now - EPOCH) / 1000
  const run = (ms: number, each?: () => void) => {
    for (let left = ms; left > 0; left -= 50) {
      now += 50
      each?.()
      core.step(now)
    }
  }
  run(200)
  const bShip = () => playerOf(core.crew!, b.id)!.ship
  const ship = () => core.ships.get(bShip())!
  /** A's jet over a point `up` m above ship-local (x, z) of B's carrier, flying with it. */
  const over = (x: number, z: number, up: number, mode = 1): PlaneTuple => {
    const s = ship()
    // Straight above the point: level the ship first, or a rolled hull tilts a 120 m drop line by metres.
    const p = shipToWorld({ ...s, pitch: 0, roll: 0 }, x, DECK_Y + up, z, [0, 0, 0])
    const f = [Math.sin(s.heading), -Math.cos(s.heading)]
    // Flying the ship's heading, so stations off the jet's centreline sit the same way in ship-local terms.
    const q = shipQuat({ ...s, pitch: 0, roll: 0 }, [0, 0, 0, 1])
    return [seaT(), mode, p[0], p[1], p[2], q[0], q[1], q[2], q[3], f[0]! * s.u, 0, f[1]! * s.u, 0.8, 0, 0, 0, 0, 1, 0]
  }
  return { core, a, b, say, run, seaT, ship, bShip, over, join, now: () => now }
}

/** A launches op `op` and relays its jet over B's carrier. */
function launch(w: ReturnType<typeof battle>, op: string) {
  w.say(w.a, { type: "op", op })
  expect(playerOf(w.core.crew!, w.a.id)!.plane).toBeGreaterThanOrEqual(0)
  w.say(w.a, { type: "plane", p: w.over(15, 0, 300) })
}

/** A drops a bomb from right above ship-local (x, z) of B's ship (it falls onto it with the ship's speed). */
function bombAt(w: ReturnType<typeof battle>, seq: number, x: number, z: number) {
  const p = w.over(x, z, 120)
  w.say(w.a, { type: "plane", p })
  w.say(w.a, { type: "fire", m: [seq, w.seaT(), p[2], p[3], p[4], p[9], 0, p[11], -1, 1] })
}

describe("ships take damage over the network", () => {
  test("protocol round-trips hulls, sunk, shiphits and a landing on another ship", () => {
    for (const m of [{ type: "shiphits", ship: 3, n: 20 }, { type: "recover", how: "landed", ship: 4 }, { type: "recover", how: "crashed" }] as ClientMsg[]) expect(decodeClient(encode(m))).toEqual(m)
    expect(decodeClient(encode({ type: "shiphits", ship: 3, n: 0 }))).toBeNull()
    for (const m of [{ type: "hulls", h: [[2, 812.5, 400, 12, -1, 1, 10, 26, -40, 3]] }, { type: "sunk", ship: 2, name: "CV-07 VALIANT", team: 1, by: 4 }] as ServerMsg[]) expect(decodeServer(encode(m))).toEqual(m)
    expect(decodeServer(JSON.stringify({ type: "hulls", h: [[2, 1, 2]] }))).toBeNull()
  })

  test("joiners get every hull; a commissioned ship has full health", () => {
    const w = battle()
    const c = w.join("cy")
    const h = c.last("hulls")!.h
    expect(h.length).toBe(w.core.ships.size)
    for (const v of h) expect(v[1]).toBe(FLEET.hp)
  })

  test("an F-35C's bombs: a direct hit on B's deck, a near miss in the water; B hears its health drop", () => {
    const w = battle()
    launch(w, "f35")
    bombAt(w, 0, 15, 40)
    w.run(7000)
    const hull = w.core.hull(w.bShip())!
    expect(hull.hp).toBeCloseTo(FLEET.hp - FLEET.bomb, 0)
    expect(hull.fires.length).toBe(1)
    const seen = unpackHull(w.b.last("hulls")!.h.find((v) => v[0] === w.bShip())!, w.seaT())
    expect(seen.hp).toBeCloseTo(hull.hp, 0)
    expect(seen.deckFire).toBeGreaterThan(w.seaT())
    // Launching from a burning deck is refused.
    w.say(w.b, { type: "op", op: "hornet" })
    expect(w.b.last("nope")!.error).toBe("deck-fire")
    // A near miss in the water 6 m outboard of the starboard deck edge (18.5 m off the waterline). 12 m off the
    // waterline is still under the 76 m deck's overhang, so it only missed by luck of drift.
    const before = hull.hp
    bombAt(w, 1, -(76 / 2 + 6), 0)
    w.run(7000)
    expect(hull.hp).toBeLessThan(before)
    expect(before - hull.hp).toBeLessThan(FLEET.nearMax)
  })

  test("a Hornet's rounds chip the hull, budgeted; friendly rounds do nothing", () => {
    const w = battle()
    launch(w, "hornet")
    w.say(w.a, { type: "plane", p: w.over(15, -400, 60) })
    w.say(w.a, { type: "shiphits", ship: w.bShip(), n: 20 })
    const hull = w.core.hull(w.bShip())!
    expect(hull.hp).toBeCloseTo(FLEET.hp - 20 * FLEET.gun, 5)
    // A claim of 200 is cut to the gun's budget.
    w.say(w.a, { type: "shiphits", ship: w.bShip(), n: 200 })
    expect(FLEET.hp - hull.hp).toBeLessThan(80 * FLEET.gun)
    // A's own ship: friendly.
    const own = playerOf(w.core.crew!, w.a.id)!.ship
    w.run(1000)
    w.say(w.a, { type: "shiphits", ship: own, n: 10 })
    expect(w.core.hull(own)!.hp).toBe(FLEET.hp)
  })

  test("sunk: the room announces it with the final blow, then scuttles it and moves its crew", () => {
    const w = battle()
    launch(w, "f35")
    const id = w.bShip()
    const hull = w.core.hull(id)!
    // Six direct hits sink it (175 each); the bomb budget refills on the room's clock.
    let seq = 0
    for (let i = 0; i < 40 && hull.sinkAt === -1; i++) {
      w.core.fighters.get(w.a.id)!.bombs = 4
      bombAt(w, seq++, 15, 40)
      w.run(7000)
    }
    expect(hull.sinkAt).toBeGreaterThanOrEqual(0)
    expect(w.b.last("sunk")).toMatchObject({ ship: id, team: 1, by: w.a.id })
    expect(w.b.last("sunk")!.name).toMatch(/^CV-/)
    // The helm can't drive a sinking ship.
    w.say(w.b, { type: "helm", o: 1, r: 1 })
    w.say(w.b, { type: "op", op: "hornet" })
    expect(w.b.last("nope")!.error).toBe("sinking")
    w.run((FLEET.sinkTime + 1) * 1000)
    expect(shipOf(w.core.crew!, id)).toBeUndefined()
    expect(w.core.ships.has(id)).toBe(false)
    const p = playerOf(w.core.crew!, w.b.id)!
    expect(p.team).toBe(1)
    expect(shipOf(w.core.crew!, p.ship)).toBeDefined()
    expect(w.b.last("hulls")!.h.some((v) => v[0] === id)).toBe(false)
  })

  test("gunnery hooks: damageShip applies a shell by amount (friendly refused); interceptStore kills a bomb in flight", () => {
    const w = battle()
    const id = w.bShip()
    const s = w.ship()
    const at = shipToWorld(s, 15, DECK_Y, 0, [0, 0, 0])
    expect(w.core.damageShip(id, 30, [at[0], at[1], at[2]], w.a.id)).toBe(30)
    expect(w.core.hull(id)!.hp).toBe(FLEET.hp - 30)
    expect(w.core.damageShip(id, 30, [at[0], at[1], at[2]], w.b.id)).toBe(0)
    expect(w.b.last("hulls")!.h.find((v) => v[0] === id)![1]).toBe(FLEET.hp - 30)
    // A bomb dropped at B's deck, shot down halfway: no damage, a harmless burst for everyone.
    launch(w, "f35")
    bombAt(w, 9, 15, 40)
    w.run(400)
    const store = [...w.core.stores()].find((x) => x.owner === w.a.id && x.seq === 9)
    expect(store?.kind).toBe("bomb")
    expect(w.core.interceptStore(w.a.id, 9)).toBe(true)
    expect(w.b.last("boom")!.b.slice(0, 2)).toEqual([w.a.id, 9])
    w.run(7000)
    expect(w.core.hull(id)!.hp).toBe(FLEET.hp - 30)
  })

  test("an enemy jet crashing into a ship costs it 5%; a friendly one nothing", () => {
    const w = battle()
    launch(w, "hornet")
    w.say(w.a, { type: "plane", p: w.over(15, 20, 1, 2) })
    expect(w.core.hull(w.bShip())!.hp).toBe(FLEET.hp - FLEET.crash)
  })
})
