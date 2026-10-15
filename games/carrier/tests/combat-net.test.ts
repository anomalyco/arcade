import { catapultTime } from "../shared/launch"
import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { playerOf, shipOf } from "../shared/crew"
import { type ClientMsg, type FireTuple, type PlaneTuple, type ServerMsg, decodeClient, decodeServer, encode } from "../shared/protocol"
import { LOADOUTS, WEAPONS } from "../shared/weapons"

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

/** A room with A (team 0) and B (team 1) both airborne in Hornets; `fly` relays straight-and-level jets every step. */
function dogfight() {
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
  say(a, { type: "op", op: "hornet" })
  say(b, { type: "op", op: "hornet" })
  /** Jets flying north at 140 m/s at 1,000 m: A starts `gap` metres behind B. */
  const pos = new Map<FakeConn, { x: number; z: number }>([
    [a, { x: 0, z: 0 }],
    [b, { x: 0, z: -600 }],
  ])
  const seaT = () => (now - EPOCH) / 1000
  const tuple = (c: FakeConn, mode = 1): PlaneTuple => {
    const p = pos.get(c)!
    return [seaT(), mode, p.x, 1000, p.z, 0, 1, 0, 0, 0, 0, -140, 0.77, 0, 0, 0, 0]
  }
  const relay = (mode = 1) => {
    for (const c of [a, b]) say(c, { type: "plane", p: tuple(c, mode) })
  }
  const run = (ms: number, each?: () => void) => {
    for (let left = ms; left > 0; left -= 50) {
      now += 50
      for (const p of pos.values()) p.z -= 140 * 0.05
      relay()
      each?.()
      core.step(now)
    }
  }
  relay()
  return { core, a, b, say, run, pos, seaT, tuple, join }
}

describe("weapons over the network", () => {
  test("protocol round-trips the weapon messages and rejects malformed ones", () => {
    const fire: FireTuple = [3, 12.5, 1, 2, 3, 4, 5, 6, 7, 0]
    for (const m of [
      { type: "gun", on: true },
      { type: "hits", on: 4, n: 12 },
      { type: "fire", m: fire },
      { type: "flare", f: [1, 2, 3, 4, 5, 6, 7] },
      { type: "seek", on: -1, locked: false },
    ] as ClientMsg[])
      expect(decodeClient(encode(m))).toEqual(m)
    expect(decodeClient(encode({ type: "hits", on: 4, n: 0 }))).toBeNull()
    expect(decodeClient(encode({ type: "hits", on: 4, n: 5000 }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "fire", m: [3, 12.5, 1, 2, 3, 4, 5, 6, 7, 2] }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "seek", on: -2, locked: true }))).toBeNull()
    for (const m of [
      { type: "gun", id: 2, on: false },
      { type: "fire", id: 2, m: fire },
      { type: "flare", id: 2, f: [1, 2, 3, 4, 5, 6, 7] },
      { type: "seek", by: 2, s: 2 },
      { type: "boom", b: [2, 0, 1, 2, 3, -1, 1, 0] },
      { type: "hp", id: 3, hp: 52.5, by: 2, w: "gun" },
      { type: "kill", on: 3, by: -1, w: "" },
      { type: "stats", s: [[2, 1, 0]] },
    ] as ServerMsg[])
      expect(decodeServer(encode(m))).toEqual(m)
    expect(decodeServer(JSON.stringify({ type: "kill", on: 3, by: 2, w: "laser" }))).toBeNull()
  })

  test("A's cannon hits bring B down: damage, kill feed, tallies, and B's slot recharges after recovery", () => {
    const { core, a, b, say, run } = dogfight()
    expect(playerOf(core.crew!, a.id)!.team).not.toBe(playerOf(core.crew!, b.id)!.team)
    say(a, { type: "hits", on: b.id, n: 10 })
    expect(b.last("hp")).toEqual({ type: "hp", id: b.id, hp: 100 - 10 * WEAPONS.gun.damage, by: a.id, w: "gun" })
    // Claims beyond the gun's rate are cut down; steady fire at the gun's rate kills within a couple of seconds.
    run(3000, () => say(a, { type: "hits", on: b.id, n: 3 }))
    expect(core.hp(b.id)).toBe(0)
    expect(b.all("kill")).toEqual([{ type: "kill", on: b.id, by: a.id, w: "gun" }])
    const tallies = new Map(a.last("stats")!.s.map(([id, k, d]) => [id, [k, d]]))
    expect(tallies.get(a.id)).toEqual([1, 0])
    expect(tallies.get(b.id)).toEqual([0, 1])
    // B's client crashes the jet ("shot") and recovers it as a crash: the slot recharges.
    say(b, { type: "recover", how: "crashed" })
    const ship = shipOf(core.crew!, playerOf(core.crew!, b.id)!.ship)!
    const slot = ship.aircraft.find((x) => x.pilot === null && x.readyAt > EPOCH)
    expect(slot).toBeDefined()
    // A late joiner gets the tallies.
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name: "cy" }))
    expect(c.last("stats")!.s.length).toBe(2)
  })

  test("friendly fire is refused, and so are hits from beyond gun range", () => {
    const { core, a, b, say, pos, join } = dogfight()
    pos.get(b)!.z = -5000
    say(b, { type: "plane", p: [0, 1, 0, 1000, -5000, 0, 1, 0, 0, 0, 0, -140, 0.77, 0, 0, 0, 0] })
    say(a, { type: "hits", on: b.id, n: 10 })
    expect(core.hp(b.id)).toBe(100)
    // A crewmate of A (boarded A's ship) launches and claims hits on A.
    const c = join("cy")
    say(c, { type: "board", ship: playerOf(core.crew!, a.id)!.ship })
    expect(playerOf(core.crew!, c.id)!.team).toBe(playerOf(core.crew!, a.id)!.team)
    say(c, { type: "op", op: "hornet" })
    say(c, { type: "plane", p: [0, 1, 0, 1000, 50, 0, 1, 0, 0, 0, 0, -140, 0.77, 0, 0, 0, 0] })
    say(c, { type: "hits", on: a.id, n: 5 })
    expect(core.hp(a.id)).toBe(100)
    // A third carrier's pilot is everyone's enemy: the same claim lands.
    const d = join("di")
    expect(new Set([a, b, d].map((x) => playerOf(core.crew!, x.id)!.team)).size).toBe(3)
    say(d, { type: "op", op: "hornet" })
    say(d, { type: "plane", p: [0, 1, 0, 1000, 50, 0, 1, 0, 0, 0, 0, -140, 0.77, 0, 0, 0, 0] })
    say(d, { type: "hits", on: a.id, n: 5 })
    expect(core.hp(a.id)).toBeLessThan(100)
  })

  test("a missile the room flies hits B; others hear the launch; B gets the seeker warning", () => {
    const { core, a, b, say, run, seaT } = dogfight()
    say(a, { type: "seek", on: b.id, locked: true })
    expect(b.last("seek")).toEqual({ type: "seek", by: a.id, s: 2 })
    say(a, { type: "fire", m: [0, seaT(), 0, 999, -10, 0, 0, -140, b.id, 0] })
    expect(b.last("fire")!.id).toBe(a.id)
    expect(a.all("fire").length).toBe(0)
    run(6000)
    const boom = b.last("boom")!
    expect(boom.b[5]).toBe(b.id)
    expect(core.hp(b.id)).toBeLessThan(100 - WEAPONS.missile.edge + 1)
    expect(b.last("hp")!.w).toBe("missile")
  })

  test("a gunner's SAM seeker warns the jet exactly like a missile seeker, and stops when the gunner leaves", () => {
    const { core, a, b, say, join } = dogfight()
    // A crewmate of A mans a SAM launcher and locks B.
    const c = join("cy")
    say(c, { type: "board", ship: playerOf(core.crew!, a.id)!.ship })
    say(c, { type: "op", op: "sam-port" })
    expect(playerOf(core.crew!, c.id)!.role).toBe("gunner")
    say(c, { type: "seek", on: b.id, locked: false })
    expect(b.last("seek")).toEqual({ type: "seek", by: c.id, s: 1 })
    say(c, { type: "seek", on: b.id, locked: true })
    expect(b.last("seek")).toEqual({ type: "seek", by: c.id, s: 2 })
    // A friendly jet is never warned.
    say(c, { type: "seek", on: a.id, locked: true })
    expect(b.last("seek")).toEqual({ type: "seek", by: c.id, s: 0 })
    expect(a.all("seek").length).toBe(0)
    // Locked again, then the gunner drops: the warning clears.
    say(c, { type: "seek", on: b.id, locked: true })
    core.close(c)
    expect(b.last("seek")).toEqual({ type: "seek", by: c.id, s: 0 })
  })

  test("B's flares decoy the missile", () => {
    const { core, a, b, say, run, seaT, pos } = dogfight()
    say(a, { type: "fire", m: [0, seaT(), 0, 999, -10, 0, 0, -140, b.id, 0] })
    let flared = false
    run(6000, () => {
      const m = core.fighters.get(b.id)
      if (!flared && m && seaT() > 0.6) {
        flared = true
        const p = pos.get(b)!
        say(b, { type: "flare", f: [seaT(), p.x, 1000, p.z, 0, 0, -140] })
      }
    })
    expect(a.last("flare")!.id).toBe(b.id)
    expect(b.last("boom")!.b[5]).toBe(-1)
    expect(core.hp(b.id)).toBe(100)
  })

  test("a damaged jet that crashes credits its attacker; a missile spam beyond the rails is refused", () => {
    const { core, a, b, say, seaT, tuple } = dogfight()
    say(a, { type: "hits", on: b.id, n: 10 })
    say(b, { type: "plane", p: tuple(b, 2) })
    expect(b.last("kill")).toEqual({ type: "kill", on: b.id, by: a.id, w: "gun" })
    for (let i = 0; i < 5; i++) say(a, { type: "fire", m: [10 + i, seaT(), 0, 999, -10, 0, 0, -140, -1, 0] })
    expect(b.all("fire").length).toBe(WEAPONS.missile.reload > 0 ? 2 : 5)
    expect(core.hp(a.id)).toBe(100)
  })

  test("an F-35C has no gun: the room takes no hits from it, but its bombs up to its load", () => {
    const { core, a, b, say, seaT, join, run } = dogfight()
    const c = join("cy")
    say(c, { type: "board", ship: playerOf(core.crew!, a.id)!.ship })
    expect(playerOf(core.crew!, c.id)!.team).toBe(playerOf(core.crew!, a.id)!.team)
    // A's Hornet has left the ship's one catapult.
    run(catapultTime("hornet") * 1000)
    say(c, { type: "op", op: "f35" })
    expect(core.fighters.get(c.id)?.vehicle).toBe("f35")
    say(c, { type: "plane", p: [seaT(), 1, 0, 1000, -580, 0, 1, 0, 0, 0, 0, -140, 0.77, 0, 0, 0, 0] })
    say(c, { type: "hits", on: b.id, n: 10 })
    expect(core.hp(b.id)).toBe(100)
    for (let i = 0; i <= LOADOUTS.f35.bombs; i++) say(c, { type: "fire", m: [i, seaT(), 0, 998, -580, 0, -4, -140, -1, 1] })
    expect(b.all("fire").filter((f) => f.id === c.id && f.m[9] === 1).length).toBe(LOADOUTS.f35.bombs)
    // A Hornet has no bombs at all.
    say(a, { type: "fire", m: [50, seaT(), 0, 999, -10, 0, 0, -140, -1, 1] })
    expect(b.all("fire").some((f) => f.id === a.id && f.m[9] === 1)).toBe(false)
  })
})
