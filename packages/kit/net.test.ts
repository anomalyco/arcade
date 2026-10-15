import { describe, expect, test } from "bun:test"
import {
  ByteReader,
  ByteWriter,
  frame,
  packAngle,
  packAngle12,
  packAngle8,
  packNibblePair,
  readBitset,
  unframe,
  unpackAngle,
  unpackAngle12,
  unpackAngle8,
  unpackNibblePair,
  writeBitset,
} from "./net/bytes"
import {
  AckHistory,
  BandwidthPacer,
  inInterestBubble,
  isScheduledOnSnapshot,
  PriorityAccumulator,
  selectInterestStride,
} from "./net/interest"
import { Glide, hermite2, lerpAngle, SnapshotBuffer } from "./net/interpolate"
import { ClockSync } from "./net/clock-sync"
import { roomLocationHint } from "./net/room-core"
import { DEFAULT_JITTER, JitterBuffer, type InputOps, socketJitter } from "./net/jitter-buffer"
import { Predictor, Smoother } from "./net/prediction"
import { RewindHistory } from "./net/rewind"
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

describe("socketJitter", () => {
  /** Inputs at 30 Hz arriving `late(seq)` ticks after they were sent; returns how many ticks each waited in all. */
  function run(late: (seq: number) => number, ticks = 900) {
    const jb = new JitterBuffer(ops, socketJitter(30))
    const arrivals = new Map<number, number[]>()
    for (let seq = 0; seq < ticks; seq++) {
      const at = seq + late(seq)
      arrivals.set(at, [...(arrivals.get(at) ?? []), seq])
    }
    const waited: number[] = []
    for (let tick = 0; tick < ticks; tick++) {
      for (const seq of arrivals.get(tick) ?? []) jb.push(seq, { mx: 1, fire: seq % 50 === 7, n: seq }, tick)
      for (const i of jb.take(tick)) if (i.n >= 0) waited.push(tick - i.n)
    }
    return { jb, waited }
  }

  test("a clean link is taken the tick it arrives", () => {
    const { jb, waited } = run(() => 1)
    expect(jb.stats.synthesized).toBe(0)
    expect(waited.slice(-100).every((w) => w === 1)).toBe(true)
  })

  test("TCP stalls are bridged with stand-ins instead of holding every later input back", () => {
    // ±1 tick of jitter, and every 90 ticks a 6-tick stall that releases everything at once (in order).
    const stalled = (seq: number) => seq % 90 >= 84
    const late = (seq: number) => (stalled(seq) ? 90 - (seq % 90) : 1 + (seq % 3 === 0 ? 1 : 0))
    const { jb, waited } = run(late)
    expect(jb.stats.synthesized).toBeGreaterThan(0)
    // Between stalls inputs wait at most the jitter, not the stall.
    const calm = waited.slice(-200).filter((w) => w <= 3)
    expect(calm.length / 200).toBeGreaterThan(0.9)
    expect(jb.snapshot().target).toBeLessThanOrEqual(2)
  })

  test("presses survive stalls", () => {
    const fired: number[] = []
    const jb = new JitterBuffer(ops, socketJitter(30))
    for (let tick = 0, seq = 0; tick < 600; tick++) {
      // Everything sent in ticks 200-209 arrives at tick 210.
      if (tick < 200 || tick >= 210) {
        const upTo = tick >= 210 && seq < 210 ? 210 : tick + 1
        for (; seq < upTo; seq++) jb.push(seq, { mx: 1, fire: seq % 50 === 7, n: seq }, tick)
      }
      for (const i of jb.take(tick)) if (i.fire) fired.push(tick)
    }
    expect(fired.length).toBe(12)
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

  test("round-trips varints, signed varints, 8/12-bit angles, nibble pairs and bitsets", () => {
    const w = new ByteWriter(16)
    const uvals = [0, 1, 127, 128, 255, 16383, 16384, 1_000_000]
    const ivals = [0, -1, 1, -64, 63, -65, 64, -8192, 8191, -123456, 123456]
    for (const v of uvals) w.uvar(v)
    for (const v of ivals) w.ivar(v)
    w.u8(packNibblePair(-8, 7)).u8(packNibblePair(0, -3))
    const bits = [true, false, true, true, false, false, true, false, true, false, true]
    writeBitset(w, bits)
    const r = new ByteReader(w.finish())
    expect(uvals.map(() => r.uvar())).toEqual(uvals)
    expect(ivals.map(() => r.ivar())).toEqual(ivals)
    expect(unpackNibblePair(r.u8())).toEqual([-8, 7])
    expect(unpackNibblePair(r.u8())).toEqual([0, -3])
    expect(readBitset(r, bits.length)).toEqual(bits)
    expect(Math.abs(unpackAngle8(packAngle8(1.23)) - 1.23)).toBeLessThan(0.03)
    expect(Math.abs(unpackAngle12(packAngle12(1.23)) - 1.23)).toBeLessThan(0.002)
  })
})

describe("Interest & Rewind", () => {
  test("interest bubble, priority accumulator, AckHistory and BandwidthPacer", () => {
    expect(inInterestBubble(50, 50, 48, 48, 64)).toBe(true)
    expect(inInterestBubble(200, 50, 48, 48, 64)).toBe(false)
    expect(selectInterestStride(10, true, true)).toBe(1)
    expect(selectInterestStride(10, false, false)).toBe(1)
    expect(selectInterestStride(10, false, true)).toBe(2)
    expect(selectInterestStride(50, false, true)).toBe(4)
    expect([0, 1, 2, 3].filter((s) => isScheduledOnSnapshot(s, 5, 4)).length).toBe(1)

    const acc = new PriorityAccumulator<number>()
    let sent = 0
    for (let i = 0; i < 8; i++) if (acc.step(1, 50, false, true)) sent++
    expect(sent).toBe(2)
    expect(acc.step(1, 50, true, true)).toBe(true)

    const hist = new AckHistory<string>(4)
    for (let t = 1; t <= 6; t++) hist.record(t * 3, `s${t}`)
    expect(hist.get(3)).toBeUndefined()
    expect(hist.get(9)).toBe("s3")
    expect(hist.latest()).toEqual({ tick: 18, state: "s6" })

    const pacer = new BandwidthPacer(3, 9, 1000)
    pacer.record(100, 0.1)
    pacer.record(100, 0.35)
    expect(pacer.stride()).toBe(3)
    pacer.record(2000, 0.6)
    expect(pacer.stride()).toBeGreaterThan(3)
  })

  test("RewindHistory interpolates past poses and preserves knockback displacement", () => {
    const rw = new RewindHistory<number>(8, 0.2)
    const entities = [{ id: 1, x: 10, y: 20 }]
    rw.record(1, 1.0, entities)
    entities[0]!.x = 12
    rw.record(2, 1.1, entities)
    entities[0]!.x = 14
    rw.record(3, 1.2, entities)

    const sampled = rw.sampleAtTime(1.05)!
    expect(sampled.get(1)!.x).toBeCloseTo(11, 4)

    let seenX = 0
    rw.withRewoundPositions(entities, 1.05, () => {
      seenX = entities[0]!.x
      // Apply a +0.5 m knockback during hitscan evaluation
      entities[0]!.x += 0.5
    })
    expect(seenX).toBeCloseTo(11, 4)
    expect(entities[0]!.x).toBeCloseTo(14.5, 4)
  })

  test("RewindHistory snapshot round-trips through JSON and keeps recording identically", () => {
    const a = new RewindHistory<number>(4, 0.3)
    const ents = [
      { id: 1, x: 0.1, y: 5 },
      { id: 2, x: 7.3, y: -2 },
      { id: 3, x: 1, y: 1 },
    ]
    const live = (e: { id: number }) => e.id !== 3
    for (let t = 0; t < 6; t++) {
      for (const e of ents) e.x += 0.37 * e.id
      a.record(t, t * 0.1, ents, live)
    }
    const b = new RewindHistory<number>(4, 0.3)
    b.restore(JSON.parse(JSON.stringify(a.snapshot())))
    expect(b.snapshot()).toEqual(a.snapshot())
    expect(b.snapshot().length).toBe(4)
    for (const q of [0.31, 0.37, 0.45, 0.5]) expect(b.sampleAtTime(q)).toEqual(a.sampleAtTime(q))
    for (let t = 6; t < 9; t++) {
      for (const e of ents) e.y -= 0.21 * e.id
      a.record(t, t * 0.1, ents, live)
      b.record(t, t * 0.1, ents, live)
    }
    expect(b.snapshot()).toEqual(a.snapshot())
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
    expect(s.span).toBeCloseTo(0.05, 5)
    expect(s.over).toBe(0)
    expect(lerpAngle(3, -3, 0.5)).toBeCloseTo(Math.PI, 1)
  })

  test("hermite2 coasts through a stall and Glide blends out the resume jump", () => {
    const a = { x: 0, y: 0, vx: 6, vy: 0 }
    const b = { x: 0.4, y: 0, vx: 6, vy: 0 }
    const mid = hermite2(a, b, 0.4 / 6, 0.5, 0)
    expect(mid.x).toBeCloseTo(0.2, 4)
    expect(mid.vx).toBeCloseTo(6, 4)
    const coasted = hermite2(a, b, 0.4 / 6, 1, 0.1)
    expect(coasted.x).toBeCloseTo(1.0, 4)
    const g = new Glide(10, 4)
    g.step(0, 0, 6, 0, 0.016)
    const jumped = g.step(0.5, 0, 6, 0, 0.016)
    expect(jumped.x).toBeLessThan(0.2)
  })

  test("time-stretches clock offset and adaptive delay shifts within ±2% of frame dt", () => {
    const buf = new SnapshotBuffer<number>(0.1, 32, 0.25, { min: 0.08, max: 0.1 })
    const dt = 1 / 120
    let local = 1.0
    buf.push(0, 0, local)
    let prev = buf.renderTime(local)
    for (let f = 1; f <= 240; f++) {
      local += dt
      if (f % 8 === 0) {
        const srv = (f / 8) * (1 / 15)
        const spike = f === 80 ? 0.045 : f === 160 ? -0.012 : (f % 24) * 0.001
        buf.push(srv, f, 1.0 + srv + spike)
      }
      const rt = buf.renderTime(local)
      const step = rt - prev
      expect(step).toBeGreaterThanOrEqual(dt * 0.979)
      expect(step).toBeLessThanOrEqual(dt * 1.021)
      prev = rt
    }
  })
})

describe("Predictor & ClockSync & LocationHint", () => {
  test("prevCommands returns recent unacknowledged commands and ClockSync slews monotonically", () => {
    const pred = new Predictor<string>()
    pred.record("a")
    pred.record("b")
    pred.record("c")
    expect(pred.prevCommands(2)).toEqual(["a", "b"])
    const clock = new ClockSync()
    clock.add(100, 1050, 120)
    const t0 = clock.now(150)
    const t1 = clock.now(166)
    expect(t1).toBeGreaterThan(t0)
    expect(roomLocationHint({ cf: { continent: "NA", country: "US", regionCode: "CA" } })).toBe("wnam")
    expect(roomLocationHint({ cf: { continent: "EU", country: "DE" } })).toBe("weur")
  })
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
