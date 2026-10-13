import { describe, expect, test } from "bun:test"
import { CREW } from "../shared/crew"
import { OPS } from "../shared/ops"
import { type PlaneEntry, type PlaneTuple, compactPlane, decodeServer, encode } from "../shared/protocol"

/** A jet as the flight seam sends it (its own rounding: shared/protocol.ts PlaneTuple notes). */
function sent(i: number): PlaneTuple {
  const r = (v: number, k: number) => Math.round(v * k) / k
  const a = i * 0.7
  return [r(1234.5678 + i * 0.013, 1e3), 1, r(-3456.789 + i * 311.1, 1e2), r(812.345 + i, 1e2), r(5678.123 - i * 97.3, 1e2), r(Math.sin(a) * 0.3, 1e4), r(Math.cos(a) * 0.9, 1e4), r(0.0123 * i, 1e4), r(0.3123, 1e4), r(-141.37 + i, 10), r(3.47, 10), r(-201.13, 10), 0.77, 1, 0, r(0.123, 100), r(-0.456, 100), 0, 0]
}

describe("a 32-player room on the wire", () => {
  test("the jet relay stays compact with every jet slot in the air", () => {
    // 2 Hornets + 1 F-35C per ship, 4 ships.
    const perShip = OPS.filter((o) => o.kind === "vehicle" && o.vehicle).reduce((n, o) => n + o.cap, 0)
    const jets = (CREW.roomMax / CREW.capacity) * perShip
    expect(jets).toBe(12)
    const before = encode({ type: "planes", p: Array.from({ length: jets }, (_, i): PlaneEntry => [i + 1, ...sent(i)]) }).length
    const after = encode({ type: "planes", p: Array.from({ length: jets }, (_, i): PlaneEntry => [i + 1, ...compactPlane(sent(i))]) }).length
    console.log(`planes frame, ${jets} jets: ${before} B as sent, ${after} B compacted; x20 Hz x${CREW.roomMax} clients = ${((after * 20 * CREW.roomMax) / 1024).toFixed(0)} KB/s out of the room`)
    expect(after).toBeLessThan(before)
    expect(after / jets).toBeLessThan(110)
    // Still a valid frame.
    expect(decodeServer(encode({ type: "planes", p: [[1, ...compactPlane(sent(1))]] }))?.type).toBe("planes")
  })

  test("landing jets keep the carrier id in qw", () => {
    const p = sent(0)
    p[1] = 3
    p[8] = 7
    expect(compactPlane(p)[8]).toBe(7)
  })
})
