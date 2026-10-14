import { describe, expect, test } from "bun:test"
import { ByteReader, ByteWriter, frame, packAngle, unframe, unpackAngle } from "./net/bytes"
import { lerpAngle, SnapshotBuffer } from "./net/interpolate"
import { DEFAULT_JITTER, JitterBuffer, type InputOps } from "./net/jitter-buffer"
import { Predictor, Smoother } from "./net/prediction"
import { Seats } from "./net/seats"

type In = { mx: number; fire: boolean; n: number }
const ops: InputOps<In> = {
  merge: (a, b) => ({ ...b, fire: a.fire || b.fire }),
  standIn: (last) => ({ ...last, fire: false, n: -1 }),
  hasEdges: (i) => i.fire,
}

describe("JitterBuffer", () => {
  test("steady stream: one input per tick, in order, after the target delay", () => {
    const jb = new JitterBuffer(ops)
    const applied: number[] = []
    for (let tick = 0; tick < 40; tick++) {
      jb.push(tick, { mx: 1, fire: false, n: tick }, tick)
      for (const i of jb.take(tick)) applied.push(i.n)
    }
    expect(applied.length).toBeGreaterThanOrEqual(36)
    expect(applied).toEqual(applied.map((_, i) => i))
    expect(jb.stats.synthesized).toBe(0)
  })

  test("a dry tick repeats movement without edges, and the late original's fire is not lost", () => {
    const jb = new JitterBuffer(ops)
    const applied: In[] = []
    let tick = 0
    for (; tick < 30; tick++) {
      jb.push(tick, { mx: 1, fire: false, n: tick }, tick)
      applied.push(...jb.take(tick))
    }
    // Inputs 30..33 are delayed by 6 ticks; 31 carries a shot.
    const delayed = [30, 31, 32, 33]
    for (; tick < 36; tick++) applied.push(...jb.take(tick))
    for (const seq of delayed) jb.push(seq, { mx: 1, fire: seq === 31, n: seq }, tick)
    for (; tick < 60; tick++) {
      if (tick >= 36) jb.push(tick - 2, { mx: 1, fire: false, n: tick - 2 }, tick)
      applied.push(...jb.take(tick))
    }
    expect(jb.stats.synthesized).toBeGreaterThan(0)
    expect(applied.filter((i) => i.n === -1).every((i) => i.mx === 1)).toBe(true)
    expect(applied.filter((i) => i.fire).length).toBe(1)
  })

  test("queue overflow carries edges forward instead of dropping them", () => {
    const jb = new JitterBuffer(ops, { ...DEFAULT_JITTER, queueMax: 4 })
    jb.push(0, { mx: 0, fire: false, n: 0 }, 0)
    jb.take(0)
    for (let s = 1; s <= 10; s++) jb.push(s, { mx: 0, fire: s === 2, n: s }, 0)
    expect(jb.stats.dropped).toBe(7)
    const out: In[] = []
    for (let tick = 1; tick < 20; tick++) out.push(...jb.take(tick))
    expect(out.some((i) => i.fire)).toBe(true)
  })

  test("catches up by applying two inputs in one tick, merging edges", () => {
    const jb = new JitterBuffer(ops)
    jb.push(0, { mx: 0, fire: false, n: 0 }, 0)
    jb.take(0)
    for (let s = 1; s <= 8; s++) jb.push(s, { mx: 0, fire: s === 1, n: s }, 1)
    let twice = false
    const all: In[] = []
    for (let tick = 1; tick < 12; tick++) {
      const got = jb.take(tick)
      if (got.length === 2) twice = true
      all.push(...got)
    }
    expect(twice).toBe(true)
    expect(all.map((i) => i.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(all.filter((i) => i.fire).length).toBe(1)
  })
})

describe("Seats", () => {
  test("public id and private token differ; only the token reclaims a seat within grace", () => {
    let now = 0
    const seats = new Seats<{ hp: number }>(2, 1000, () => now)
    const a = seats.join("Ann", undefined, () => ({ hp: 100 }))
    if (!a.ok) throw new Error("full")
    expect(a.seat.id).not.toBe(a.seat.token)
    expect(a.seat.token.length).toBe(32)
    a.seat.data.hp = 40
    seats.leave(a.seat.id)
    // Presenting the public id as a token does not reclaim it.
    const thief = seats.join("Eve", a.seat.id, () => ({ hp: 100 }))
    expect(thief.ok && thief.seat.id !== a.seat.id).toBe(true)
    const back = seats.join("Ann", a.seat.token, () => ({ hp: 100 }))
    expect(back.ok && back.resumed && back.seat.data.hp === 40).toBe(true)
    expect(seats.join("Bob", undefined, () => ({ hp: 1 })).ok).toBe(false)
  })

  test("expired seats free their slot index for the next player", () => {
    let now = 0
    const seats = new Seats<null>(4, 1000, () => now)
    const a = seats.join("A", undefined, () => null)
    const b = seats.join("B", undefined, () => null)
    if (!a.ok || !b.ok) throw new Error()
    seats.leave(a.seat.id)
    now = 999
    expect(seats.expire()).toEqual([])
    now = 1000
    expect(seats.expire().map((s) => s.id)).toEqual([a.seat.id])
    const c = seats.join("C", a.seat.token, () => null)
    expect(c.ok && !c.resumed && c.seat.index === 0).toBe(true)
  })
})

describe("bytes", () => {
  test("round-trips scalars, strings and a shared-prefix frame", () => {
    const w = new ByteWriter(4)
    w.u8(7).u16(65535).i16(-1234).u32(4_000_000_000).f32(1.5).str("héllo")
    const shared = w.finish()
    const personal = new ByteWriter().u32(99).finish()
    const { personal: p, shared: s } = unframe(frame(personal, shared))
    expect(new ByteReader(p).u32()).toBe(99)
    const r = new ByteReader(s)
    expect([r.u8(), r.u16(), r.i16(), r.u32(), r.f32(), r.str()]).toEqual([7, 65535, -1234, 4_000_000_000, 1.5, "héllo"])
    expect(Math.abs(unpackAngle(packAngle(-Math.PI / 2)) - Math.PI * 1.5)).toBeLessThan(1e-3)
  })
})

describe("SnapshotBuffer", () => {
  test("renders between the two snapshots around now − delay despite arrival jitter", () => {
    const buf = new SnapshotBuffer<number>(0.1)
    const jitter = [0, 0.03, 0.005, 0.04, 0.01, 0.02, 0, 0.035]
    for (let i = 0; i < jitter.length; i++) buf.push(i * 0.05, i, 0.2 + i * 0.05 + jitter[i]!)
    const local = 0.2 + 7 * 0.05 + 0.01
    const s = buf.sample(local)!
    // Server time rendered ≈ 0.36 − 0.2 − 0.1 = 0.26 s → between snapshots 5 (0.25) and 6 (0.30).
    expect([s.a, s.b]).toEqual([5, 6])
    expect(s.t).toBeGreaterThan(0)
    expect(s.t).toBeLessThan(1)
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1)
  })
})

describe("Predictor", () => {
  test("reconciliation replays unacknowledged commands on top of the server state", () => {
    // A 1D survivor: x += mx each tick. The server lags two commands behind and once disagrees by 0.5.
    const predictor = new Predictor<number>()
    let x = 0
    const moves = [1, 1, 0.5, 1, -1, 1]
    for (const m of moves) {
      predictor.record(m)
      x += m
    }
    expect(x).toBe(3.5)
    const serverAfterSeq3 = 1 + 1 + 0.5 + 1 + 0.5
    const smoother = new Smoother()
    const before = x
    const replayed = predictor.reconcile(
      3,
      () => (x = serverAfterSeq3),
      (m) => (x += m),
    )
    smoother.correct(before, 0, x, 0)
    expect(replayed).toBe(2)
    expect(x).toBe(4)
    expect(smoother.x).toBeCloseTo(-0.5)
    smoother.step(1)
    expect(Math.abs(smoother.x)).toBeLessThan(1e-3)
    expect(predictor.reconcile(2, () => (x = 0), () => {})).toBe(0)
  })
})
