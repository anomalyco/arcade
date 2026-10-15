import { describe, expect, test } from "bun:test"
import { SnapshotBuffer } from "@arcade/kit/net/interpolate"
import { decodeServer, encodeServer } from "../shared/protocol"
import { type Snapshot, buildSnapshot } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { pushSnapshot, sampleRemote, soldierAt, vehicleAt } from "../src/game/remote"

function busyWorld(): World {
  const w = new World(4242, null, "ffa", "downtown")
  w.addHuman("me", "me")
  w.botFill = 8
  w.fill()
  for (let t = 0; t < 30 * 20; t++) {
    w.step()
    w.takeEvents()
  }
  return w
}

describe("Blackout snapshot wire format", () => {
  test("decodes to the same snapshot, entities within rounding, kit and everything else exact", () => {
    const w = busyWorld()
    const s = buildSnapshot(w, "me")
    const back = decodeServer(encodeServer(s)) as Snapshot
    expect(back.type).toBe("snap")
    expect(back.you!.kit).toEqual(s.you!.kit)
    expect({ ...back, players: 0, vehicles: 0, grenades: 0, claymores: 0, you: 0, t: 0, left: 0 }).toEqual({ ...JSON.parse(JSON.stringify(s)), players: 0, vehicles: 0, grenades: 0, claymores: 0, you: 0, t: 0, left: 0 })
    expect(back.players.length).toBe(s.players.length)
    s.players.forEach((p, i) => {
      const q = back.players[i]!
      expect([q.id, q.alive, q.gun, !!q.bare, q.veh, q.seat]).toEqual([p.id, p.alive, p.gun, !!p.bare, p.veh, p.seat])
      for (const k of ["x", "y", "vx", "vy", "aim"] as const) expect(Math.abs(q[k] - p[k])).toBeLessThanOrEqual(0.005)
    })
    expect(back.vehicles!.length).toBe(s.vehicles!.length)
    s.vehicles!.forEach((v, i) => {
      const q = back.vehicles![i]!
      expect([q.id, q.kind, q.seats, q.wreck, q.horn, q.hb]).toEqual([v.id, v.kind, v.seats, v.wreck, v.horn, v.hb])
      expect(Math.abs(q.h - v.h)).toBeLessThanOrEqual(0.0005)
      expect(Math.abs(q.x - v.x)).toBeLessThanOrEqual(0.005)
    })
  })

  test("is about half the size of the plain JSON snapshot", () => {
    const w = busyWorld()
    const s = buildSnapshot(w, "me")
    const plain = JSON.stringify(s, (_k, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1000) / 1000 : v))
    expect(encodeServer(s).length).toBeLessThan(plain.length * 0.6)
  })
})

describe("Blackout remote interpolation", () => {
  const snap = (t: number, x: number, alive = true, vx = 0): Snapshot =>
    ({ type: "snap", t, map: 1, match: 0, players: [{ id: "a", x, y: 0, vx, vy: 0, aim: 0, alive, gun: "rifle", health: 100 }], vehicles: [{ id: 1, kind: "jeep", x, y: 0, h: 0, vx, vy: 0, w: 0, hp: 1, seats: [], steer: 0, thr: 0 }] }) as unknown as Snapshot

  test("draws on the curve between the two snapshots around now − delay, velocities as tangents", () => {
    const buf = new SnapshotBuffer<Snapshot>(0.1)
    pushSnapshot(buf, snap(1, 0, true, 19), 10)
    pushSnapshot(buf, snap(1.05, 1, true, 21), 10.05)
    const b = sampleRemote(buf, 10.125)!
    expect(b.t).toBeCloseTo(0.5, 5)
    expect(soldierAt(b, "a")!.x).toBeCloseTo(0.4875, 5)
    expect(soldierAt(b, "a")!.vx).toBeCloseTo(20, 5)
    expect(vehicleAt(b, 1)!.x).toBeCloseTo(0.4875, 5)
    // At each snapshot the curve passes through it at its velocity.
    expect(soldierAt(sampleRemote(buf, 10.1)!, "a")!.vx).toBeCloseTo(19, 5)
  })

  test("a stalled stream coasts on the last velocity for a moment instead of freezing", () => {
    const buf = new SnapshotBuffer<Snapshot>(0.1)
    pushSnapshot(buf, snap(1, 0, true, 20), 10)
    pushSnapshot(buf, snap(1.05, 1, true, 20), 10.05)
    expect(soldierAt(sampleRemote(buf, 10.2)!, "a")!.x).toBeCloseTo(2, 5)
    expect(soldierAt(sampleRemote(buf, 11)!, "a")!.x).toBeCloseTo(6, 5)
  })

  test("a respawn or teleport draws the newest snapshot instead of sliding", () => {
    const buf = new SnapshotBuffer<Snapshot>(0.1)
    pushSnapshot(buf, snap(1, 0, false), 10)
    pushSnapshot(buf, snap(1.05, 1), 10.05)
    expect(soldierAt(sampleRemote(buf, 10.125)!, "a")).toBeNull()
    pushSnapshot(buf, snap(1.1, 9), 10.1)
    expect(soldierAt(sampleRemote(buf, 10.175)!, "a")).toBeNull()
  })

  test("a fresh room (server time going backwards) starts the buffer over", () => {
    const buf = new SnapshotBuffer<Snapshot>(0.1)
    pushSnapshot(buf, snap(50, 0), 10)
    pushSnapshot(buf, snap(1, 3), 10.05)
    expect(buf.size).toBe(1)
    expect(buf.latest!.t).toBe(1)
  })
})
