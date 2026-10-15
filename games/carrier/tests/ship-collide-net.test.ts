import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { playerOf } from "../shared/crew"
import { FLEET } from "../shared/fleet"
import { type ServerMsg, decodeServer, encode } from "../shared/protocol"
import { SHIP } from "../shared/ship"

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
  get id(): number {
    return this.all("welcome").at(-1)!.id
  }
}

const EPOCH = 1_000_000

/** Two helms on two carriers; A's ship is put on a T-bone course into B's side at `speed` m/s. */
function ram(speed: number) {
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
  const a = join("ada")
  const b = join("bo")
  const run = (ms: number) => {
    for (let left = ms; left > 0; left -= 50) {
      now += 50
      core.step(now)
    }
  }
  run(100)
  const idA = playerOf(core.crew!, a.id)!.ship
  const idB = playerOf(core.crew!, b.id)!.ship
  const sa = core.ships.get(idA)!
  const sb = core.ships.get(idB)!
  // Far from the islands' ring: B lies still heading north, A comes from the east at `speed`.
  Object.assign(sb, { x: 7000, z: 0, heading: 0, u: 0, v: 0, r: 0, power: 0 })
  const throttle = speed / SHIP.topSpeed
  Object.assign(sa, { x: 7000 + 165 + 38 + speed * 1.5, z: 0, heading: -Math.PI / 2, u: speed, v: 0, r: 0, power: throttle })
  core.message(a, encode({ type: "helm", o: throttle, r: 0 }))
  core.message(b, encode({ type: "helm", o: 0, r: 0 }))
  return { core, a, b, idA, idB, sa, sb, run }
}

describe("carrier collisions in the room", () => {
  test("a 15 m/s T-bone bumps both, damages the rammed ship ~30% and the rammer less, everyone hears it", () => {
    const w = ram(15)
    w.run(3000)
    for (const c of [w.a, w.b]) {
      const bumps = c.all("bump")
      expect(bumps.length).toBeGreaterThan(0)
      expect(bumps[0]!.k).toBeGreaterThan(0.9)
    }
    const hb = w.core.hull(w.idB)!
    const ha = w.core.hull(w.idA)!
    expect(FLEET.hp - hb.hp).toBeGreaterThan(250)
    expect(FLEET.hp - hb.hp).toBeLessThan(350)
    expect(FLEET.hp - ha.hp).toBeLessThan(FLEET.hp - hb.hp)
    expect(FLEET.hp - ha.hp).toBeGreaterThan(0)
    // Credited to the other ship's helm; the ram leaves a fire on the struck side.
    expect(hb.by).toBe(w.a.id)
    expect(ha.by).toBe(w.b.id)
    expect(hb.fires.length).toBe(1)
    // Pushed apart: A's bow is outside B's side, B was shoved west.
    expect(w.sa.x - w.sb.x).toBeGreaterThan(165 + 38 - 1.5)
    expect(w.sb.x).toBeLessThan(7000)
    // Clients see it as a hull change.
    expect(w.b.all("hulls").length).toBeGreaterThan(0)
  })

  test("a nudge does no damage and holding the bow against the side doesn't drain health", () => {
    const w = ram(1.2)
    w.run(20000)
    expect(w.core.hull(w.idB)!.hp).toBe(FLEET.hp)
    expect(w.core.hull(w.idA)!.hp).toBe(FLEET.hp)
    expect(w.sa.x - w.sb.x).toBeLessThan(165 + 38 + 1)
  })

  test("ramming a crippled ship sinks it, credited to the rammer's helm", () => {
    const w = ram(12)
    w.core.hull(w.idB)!.hp = 50
    w.run(3000)
    const sunk = w.b.all("sunk")
    expect(sunk.length).toBe(1)
    expect(sunk[0]!.ship).toBe(w.idB)
    expect(sunk[0]!.by).toBe(w.a.id)
  })
})
