import { expect, test } from "bun:test"
import { ByteReader, ByteWriter } from "@arcade/kit/net/bytes"
import { AckHistory } from "@arcade/kit/net/interest"
import { CoopSim } from "../shared/coop-sim"
import { decodeShared, encodeShared, type SharedSnapshot } from "../shared/net-protocol"
import { bodiesNetSection, SEC_BODIES } from "../shared/bodies/net"
import { specialsNetSection, SEC_SPECIALS } from "../shared/specials/net"
import { specialsOf } from "../shared/specials/specials"
import { GasClouds } from "../src/specials/gas"

test("persistent hazard sections: bounded nearby payload, zero quiet-delta bytes, clears, late full and lost-base recovery", () => {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  sim.addSurvivor("a", 0)
  const history = new AckHistory<SharedSnapshot>(16)
  const client = new AckHistory<SharedSnapshot>(16)
  const bits = (bytes: Uint8Array) => {
    const r = new ByteReader(bytes)
    r.u32(); r.f32(); r.u16(); r.u16()
    return r.uvar()
  }
  const send = (tick: number, base?: number) => {
    const out: { snap?: SharedSnapshot } = {}
    const bytes = encodeShared(sim, tick, new Map(), undefined, { viewerCenter: { cx: 1, cy: 1 }, baseSnap: base ? history.get(base) : undefined, outSnapshot: out })
    history.record(tick, out.snap!)
    return { snap: decodeShared(bytes, 7, client), bits: bits(bytes) }
  }
  expect(send(1).bits & (SEC_SPECIALS | SEC_BODIES)).toBe(0)
  const clouds = specialsOf(sim).clouds
  clouds.push({ id: 1, x: 33.123, y: 46, born: 0, until: 8, radius: 3.2 }, { id: 2, x: 1033, y: 46, born: 0, until: 8, radius: 3.2 })
  for (const [id, x] of [["body:near", 33], ["body:far", 1033]] as const) {
    const s = sim.progression.ledger.createStore({ id, mode: "slots", size: 1, scope: "shared", at: { x, y: 46 } })
    s.counts.rise = 1
  }
  const event = send(2, 1)
  expect(event.snap.specials!.clouds).toHaveLength(1)
  expect(event.snap.bodies!.rising.map((s) => s.id)).toEqual(["body:near"])
  const context = { sim, tick: 2, isDelta: true }
  const writer = new ByteWriter()
  specialsNetSection.encode(writer, event.snap.specials!, context)
  expect(writer.length).toBe(20)
  writer.reset()
  bodiesNetSection.encode(writer, event.snap.bodies!, context)
  expect(writer.length).toBe(14)
  const quiet = send(3, 2)
  expect(quiet.bits & (SEC_SPECIALS | SEC_BODIES)).toBe(0)
  expect(quiet.snap.specials).toEqual(event.snap.specials)
  expect(quiet.snap.bodies).toEqual(event.snap.bodies)
  // A recipient still acknowledging the pre-event base is resent the hazard, as is a new join.
  expect(send(4, 1).snap.specials).toEqual(event.snap.specials)
  expect(send(5).snap.bodies).toEqual(event.snap.bodies)
  const gas = new GasClouds()
  gas.sync(event.snap.specials!.clouds, 4)
  expect(gas.clouds[0]).toMatchObject({ born: 0, life: 8, x: 33.12 })
  gas.sync(event.snap.specials!.clouds, 9)
  expect(gas.clouds).toEqual([])
  sim.time = 9
  sim.progression.ledger.store("body:near")!.counts = {}
  const cleared = send(6, 3)
  expect(cleared.bits & (SEC_SPECIALS | SEC_BODIES)).toBe(SEC_SPECIALS | SEC_BODIES)
  expect(cleared.snap.specials).toBeUndefined()
  expect(cleared.snap.bodies).toBeUndefined()
  expect(send(7, 6).bits & (SEC_SPECIALS | SEC_BODIES)).toBe(0)
})
