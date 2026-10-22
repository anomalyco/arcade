import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { playerOf } from "../shared/crew"
import { type ClientMsg, type PlaneTuple, type ServerMsg, PLANE_TUPLE_FULL, PLANE_TUPLE_LENGTH, decodeClient, decodeServer, encode , compactPlane } from "../shared/protocol"
import { vehicleCode, vehicleOfCode } from "../shared/vehicles"

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  send(data: string) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame ${data}`)
    this.sent.push(m)
  }
  close() {}
  last<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }> | undefined {
    return this.sent.filter((m): m is Extract<ServerMsg, { type: T }> => m.type === type).at(-1)
  }
  get id(): number {
    return this.last("welcome")!.id
  }
}

function room() {
  let now = 1_000_000
  const core = new RoomCore(
    () => now,
    () => 42,
  )
  const run = (ms: number) => {
    for (let left = ms; left > 0; left -= 50) {
      now += Math.min(50, left)
      core.step(now)
    }
  }
  const join = (name: string) => {
    const c = new FakeConn()
    core.message(c, encode({ type: "hello", build: BUILD, name }))
    return c
  }
  const say = (c: FakeConn, msg: ClientMsg) => core.message(c, encode(msg))
  return { core, run, join, say }
}

/** A jet as the room relays it: the base tuple plus the vehicle code and bay doors. */
const relayed = (p: PlaneTuple, code: number, doors: number): PlaneTuple => {
  const r = p.slice(0, PLANE_TUPLE_LENGTH) as PlaneTuple
  r.push(code, doors)
  // The room rounds relayed jets for the broadcast (shared/protocol.ts compactPlane).
  return compactPlane(r)
}
const jet = (t: number, mode = 1): PlaneTuple => [t, mode, 100.25, 250.5, -300.75, 0, 0.7071, 0, 0.7071, 140, 2, -3, 0.77, 0, 0, 0.2, -0.1]

describe("jets over the network", () => {
  test("protocol round-trips a jet and rejects malformed ones", () => {
    const p = compactPlane(jet(12.5)) // on the wire grid (shared/wire.ts), so it round-trips exactly
    expect(p.length).toBe(PLANE_TUPLE_LENGTH)
    const raw = encode({ type: "plane", p })
    expect(raw.length).toBeLessThan(512)
    expect(decodeClient(raw)).toEqual({ type: "plane", p })
    expect(decodeClient(encode({ type: "plane", p: p.slice(1) as never }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "plane", p: [1, 7, ...p.slice(2)] }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "plane", p: [1, 1, Number.NaN, ...p.slice(3)] }))).toBeNull()
    expect(decodeServer(encode({ type: "planes", p: [[4, ...p]] }))).toEqual({ type: "planes", p: [[4, ...p]] })    // There is no manual way out of a flight: the old "returned" recovery (the removed R key) is ignored.
    expect(decodeClient(JSON.stringify({ type: "recover", how: "returned" }))).toBeNull()
    expect(decodeClient(encode({ type: "recover", how: "landed" }))).toEqual({ type: "recover", how: "landed" })
  })

  test("the room relays only airborne players' jets, ~20 Hz, and drops them when the slot is freed", () => {
    const { core, run, join, say } = room()
    const a = join("ada")
    const b = join("bo")
    // At the helm, not a pilot: ignored.
    say(a, { type: "plane", p: jet(1) })
    run(100)
    expect(core.jets.size).toBe(0)
    say(a, { type: "op", op: "hornet" })
    expect(playerOf(core.crew!, a.id)!.plane).toBeGreaterThanOrEqual(0)
    say(a, { type: "plane", p: jet(2, 0) })
    const before = b.sent.length
    run(500)
    const frames = b.sent.slice(before).filter((m) => m.type === "planes")
    expect(frames.length).toBeGreaterThanOrEqual(9)
    // Relayed with the vehicle code of the pilot's slot (a Hornet) and the bay doors appended.
    expect(b.last("planes")!.p).toEqual([[a.id, ...relayed(jet(2, 0), 0, 0)]])
    // Back on the deck for the next sortie: the old jet goes, and one empty frame tells everyone.
    say(a, { type: "recover", how: "landed" })
    expect(core.jets.size).toBe(0)
    expect(playerOf(core.crew!, a.id)!.plane).toBe(-1)
    run(100)
    expect(b.last("planes")!.p).toEqual([])
    const n = b.sent.length
    run(500)
    expect(b.sent.slice(n).some((m) => m.type === "planes")).toBe(false)
  })

  test("a pilot who disconnects loses the jet", () => {
    const { core, run, join, say } = room()
    const a = join("ada")
    const b = join("bo") // joins ada's ship as a pilot, on deck
    say(b, { type: "plane", p: jet(3) })
    run(100)
    expect(core.jets.size).toBe(0) // no jet until launched
    say(b, { type: "op", op: "hornet" })
    say(b, { type: "plane", p: jet(3) })
    run(100)
    expect(a.last("planes")!.p.length).toBe(1)
    core.close(b)
    expect(core.jets.size).toBe(0)
    run(100)
    expect(a.last("planes")!.p).toEqual([])
  })

  test("the vehicle type and bay doors ride along: old tuples are Hornets, the room stamps the slot's type", () => {
    const p = relayed(jet(3), vehicleCode("f35"), 0.75)
    expect(p.length).toBe(PLANE_TUPLE_FULL)
    expect(decodeClient(encode({ type: "plane", p }))).toEqual({ type: "plane", p })
    expect(decodeServer(encode({ type: "planes", p: [[4, ...p]] }))).toEqual({ type: "planes", p: [[4, ...p]] })
    const short = p.slice(0, 18) as PlaneTuple
    expect(decodeClient(encode({ type: "plane", p: short }))).toEqual({ type: "plane", p: short })
    expect(decodeClient(JSON.stringify({ type: "plane", p: [...jet(3), 1.5] }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "plane", p: [...jet(3), 1, 2] }))).toBeNull()
    expect(decodeClient(JSON.stringify({ type: "plane", p: [...p, 0] }))).toBeNull()
    expect(vehicleOfCode(undefined)).toBe("hornet")
    expect(vehicleOfCode(vehicleCode("f35"))).toBe("f35")
    expect(vehicleOfCode(9)).toBe("hornet")

    const { core, run, join, say } = room()
    const a = join("ada")
    const b = join("bo")
    say(b, { type: "op", op: "f35" })
    // An old client (no tail) or one that claims a Hornet: the room relays what the slot is, an F-35C.
    say(b, { type: "plane", p: jet(4) })
    run(100)
    expect(a.last("planes")!.p).toEqual([[b.id, ...relayed(jet(4), vehicleCode("f35"), 0)]])
    say(b, { type: "plane", p: relayed(jet(5), vehicleCode("hornet"), 1) })
    run(100)
    expect(a.last("planes")!.p).toEqual([[b.id, ...relayed(jet(5), vehicleCode("f35"), 1)]])
    expect(core.fighters.get(b.id)?.vehicle).toBe("f35")
  })
})
