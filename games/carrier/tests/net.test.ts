import { describe, expect, test } from "bun:test"
import { type Conn, RoomCore, SILENT_MS } from "../server/core"
import { BUILD } from "../shared/build.gen"
import { ClockSync } from "../shared/clock"
import { type ServerMsg, decodeClient, decodeServer, encode, roomName } from "../shared/protocol"

/** Deterministic PRNG so failures reproduce. */
function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Net = {
  /** Remote clock for local time t (ms). */
  remote: (t: number) => number
  /** One-way delays for a ping sent at local t. */
  delays: (t: number) => [up: number, down: number]
}

/**
 * Runs a client: a ping every `pingMs` (a burst of 5 first), the screen reading the clock every 16 ms. Checks the shown
 * time never goes backwards and returns the worst error against the true remote time after `settleMs`.
 */
function simulate(net: Net, opts: { ms: number; settleMs: number; pingMs?: number; sync?: ClockSync }) {
  const sync = opts.sync ?? new ClockSync()
  const pingMs = opts.pingMs ?? 2000
  type Flight = { sent: number; arrive: number; remote: number }
  const flights: Flight[] = []
  const sends: number[] = [0, 50, 100, 150, 200]
  for (let t = 200 + pingMs; t < opts.ms; t += pingMs) sends.push(t)
  for (const sent of sends) {
    const [up, down] = net.delays(sent)
    flights.push({ sent, remote: net.remote(sent + up), arrive: sent + up + down })
  }
  flights.sort((a, b) => a.arrive - b.arrive)
  let prev = -Infinity
  let worst = 0
  let backwards = 0
  let next = 0
  let firstRead = true
  for (let t = 0; t < opts.ms; t += 16) {
    while (next < flights.length && flights[next]!.arrive <= t) {
      const f = flights[next++]!
      sync.add(f.sent, f.remote, f.arrive)
    }
    if (sync.offset() === null) continue
    const shown = sync.now(t)
    if (firstRead) firstRead = false
    else if (shown < prev) backwards++
    prev = shown
    if (t >= opts.settleMs) worst = Math.max(worst, Math.abs(shown - net.remote(t)))
  }
  return { worst, backwards, sync }
}

const OFFSET = 1.76e12 - 12_345.678

describe("ClockSync", () => {
  test("first sample snaps", () => {
    const sync = new ClockSync()
    expect(Number.isNaN(sync.now(5))).toBe(true)
    sync.add(1000, 50_000, 1040)
    const off = sync.offset()!
    expect(off).toBeCloseTo(50_000 - 1020, 6)
    expect(sync.now(2000)).toBeCloseTo(2000 + off, 6)
  })

  test("converges within a few ms under jitter and asymmetric outliers", () => {
    let worstAll = 0
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const rnd = mulberry(seed)
      const { worst, backwards } = simulate(
        {
          remote: (t) => t + OFFSET,
          delays: () => {
            // 20 ms each way, up to 40 ms of jitter, and one ping in five held up 100-400 ms in one direction only.
            let up = 20 + rnd() * 40
            let down = 20 + rnd() * 40
            if (rnd() < 0.2) {
              if (rnd() < 0.5) up += 100 + rnd() * 300
              else down += 100 + rnd() * 300
            }
            return [up, down]
          },
        },
        { ms: 120_000, settleMs: 20_000 },
      )
      expect(backwards).toBe(0)
      worstAll = Math.max(worstAll, worst)
    }
    // Each sample alone is only good to ±20 ms; the intersection of the window's intervals is far tighter.
    expect(worstAll).toBeLessThan(6)
  })

  test("never goes backwards when the remote clock steps back", () => {
    const rnd = mulberry(9)
    const remote = (t: number) => t + OFFSET - (t > 30_000 ? 400 : 0)
    const { worst, backwards } = simulate(
      { remote, delays: () => [15 + rnd() * 20, 15 + rnd() * 20] },
      // A 400 ms step at 5% slew takes 8 s to absorb.
      { ms: 90_000, settleMs: 50_000 },
    )
    expect(backwards).toBe(0)
    expect(worst).toBeLessThan(6)
  })

  test("slews a forward step at a bounded rate", () => {
    const sync = new ClockSync()
    sync.add(0, 1000, 0)
    let prev = sync.now(0)
    sync.add(100, 1100 + 300, 100) // remote now 300 ms ahead
    for (let t = 16; t < 10_000; t += 16) {
      const shown = sync.now(t)
      const rate = (shown - prev) / 16
      expect(rate).toBeGreaterThanOrEqual(0.95 - 1e-9)
      expect(rate).toBeLessThanOrEqual(1.05 + 1e-9)
      prev = shown
    }
    expect(prev).toBeCloseTo(9_984 + 1300, 6)
  })

  test("jumps forward, not back, after a long local pause (sleeping laptop)", () => {
    const sync = new ClockSync()
    sync.add(0, 1000, 0)
    expect(sync.now(10)).toBe(1010)
    // performance.now stood still for an hour.
    sync.add(20, 1020 + 3_600_000, 20)
    expect(sync.now(30)).toBe(30 + 1000 + 3_600_000)
  })

  test("tracks a steady drift", () => {
    for (const [ppm, limit] of [
      [100, 6], // a poor crystal
      [-100, 6],
      [1000, 30], // ten times the assumed bound: 60 ms a minute
      [-1000, 30],
    ] as const) {
      const rnd = mulberry(7)
      const { worst, backwards } = simulate(
        { remote: (t) => t * (1 + ppm * 1e-6) + OFFSET, delays: () => [20 + rnd() * 20, 20 + rnd() * 20] },
        { ms: 600_000, settleMs: 20_000 },
      )
      expect(backwards).toBe(0)
      expect(worst).toBeLessThan(limit)
    }
  })

  test("ignores impossible samples", () => {
    const sync = new ClockSync()
    sync.add(10, 100, 5)
    sync.add(Number.NaN, 100, 5)
    expect(sync.offset()).toBeNull()
  })
})

class FakeConn implements Conn {
  sent: ServerMsg[] = []
  closed: number | null = null
  send(data: string) {
    const m = decodeServer(data)
    if (!m) throw new Error(`bad frame ${data}`)
    this.sent.push(m)
  }
  close(code?: number) {
    this.closed = code ?? 1000
  }
  last<T extends ServerMsg["type"]>(type: T): Extract<ServerMsg, { type: T }> | undefined {
    return this.sent.findLast((m): m is Extract<ServerMsg, { type: T }> => m.type === type)
  }
}

function room() {
  let now = 1_000_000
  let seeds = 0
  const core = new RoomCore(
    () => now,
    () => ++seeds * 1000,
  )
  return { core, advance: (ms: number) => (now += ms), now: () => now }
}

const hello = (resume?: { seed: number; epoch: number }) => encode({ type: "hello", build: BUILD, resume })

describe("RoomCore", () => {
  test("first joiner creates the world, later joiners share it", () => {
    const { core, advance } = room()
    const a = new FakeConn()
    const b = new FakeConn()
    core.message(a, hello())
    const wa = a.last("welcome")!
    expect(wa).toMatchObject({ seed: 1000, epoch: 1_000_000, now: 1_000_000, players: 1 })
    advance(5000)
    core.message(b, hello())
    expect(b.last("welcome")).toMatchObject({ seed: 1000, epoch: 1_000_000, now: 1_005_000, players: 2 })
    expect(a.last("players")).toEqual({ type: "players", n: 2 })
    core.close(b)
    expect(a.last("players")).toEqual({ type: "players", n: 1 })
    expect(core.world).toEqual({ seed: 1000, epoch: 1_000_000 })
  })

  test("forgets the world when the last player leaves", () => {
    const { core, advance } = room()
    const a = new FakeConn()
    core.message(a, hello())
    core.close(a)
    expect(core.world).toBeNull()
    advance(1000)
    const b = new FakeConn()
    core.message(b, hello())
    expect(b.last("welcome")).toMatchObject({ seed: 2000, epoch: 1_001_000 })
  })

  test("an empty room adopts a reconnecting client's world; an occupied one keeps its own", () => {
    const { core, advance } = room()
    const a = new FakeConn()
    core.message(a, hello({ seed: 77, epoch: 900_000 }))
    expect(a.last("welcome")).toMatchObject({ seed: 77, epoch: 900_000 })
    const b = new FakeConn()
    core.message(b, hello({ seed: 88, epoch: 950_000 }))
    expect(b.last("welcome")).toMatchObject({ seed: 77, epoch: 900_000 })
    core.close(a)
    core.close(b)
    advance(10)
    // An epoch in the future is not believed.
    const c = new FakeConn()
    core.message(c, hello({ seed: 99, epoch: 5_000_000 }))
    expect(c.last("welcome")).toMatchObject({ seed: 1000, epoch: 1_000_010 })
  })

  test("pong echoes the client time with the server time, even before hello", () => {
    const { core } = room()
    const a = new FakeConn()
    core.message(a, encode({ type: "ping", c: 123.456 }))
    expect(a.sent).toEqual([{ type: "pong", c: 123.456, s: 1_000_000 }])
    expect(core.players).toBe(0)
    expect(core.world).toBeNull()
  })

  test("a stale build is told to reload and doesn't join", () => {
    const { core } = room()
    const a = new FakeConn()
    core.message(a, encode({ type: "hello", build: "old" }))
    expect(a.sent).toEqual([{ type: "reload" }])
    expect(a.closed).toBe(4003)
    expect(core.world).toBeNull()
  })

  test("ignores malformed frames and repeated hellos", () => {
    const { core } = room()
    const a = new FakeConn()
    for (const raw of ["", "{", "null", "[]", '{"type":"ping"}', '{"type":"ping","c":"x"}', '{"type":"hello"}', "x".repeat(10_000), 42])
      core.message(a, raw)
    expect(a.sent).toEqual([])
    core.message(a, hello())
    core.message(a, hello())
    expect(a.sent.filter((m) => m.type === "welcome")).toHaveLength(1)
    expect(core.players).toBe(1)
  })

  test("drops silent connections, forgetting the world if they were the last", () => {
    const { core, advance } = room()
    const ghost = new FakeConn()
    const live = new FakeConn()
    core.message(ghost, hello())
    core.message(live, hello())
    advance(SILENT_MS / 2)
    core.message(live, encode({ type: "ping", c: 1 }))
    advance(SILENT_MS / 2 + 1)
    core.message(live, encode({ type: "ping", c: 2 }))
    expect(ghost.closed).toBe(4000)
    expect(live.last("players")).toEqual({ type: "players", n: 1 })
    advance(SILENT_MS + 1)
    const next = new FakeConn()
    core.message(next, hello())
    expect(live.closed).toBe(4000)
    expect(next.last("welcome")).toMatchObject({ seed: 2000, players: 1 })
  })
})

describe("protocol", () => {
  test("roomName", () => {
    expect(roomName(null)).toBe("open-sea")
    expect(roomName("")).toBe("open-sea")
    expect(roomName("  My Room!! ")).toBe("my-room")
    expect(roomName("---")).toBe("open-sea")
    expect(roomName("a".repeat(100))).toHaveLength(32)
    expect(roomName("../../etc")).toBe("etc")
  })

  test("hello drops an invalid resume", () => {
    expect(decodeClient(JSON.stringify({ type: "hello", build: "x", resume: { seed: -1, epoch: 5 } }))).toEqual({ type: "hello", build: "x" })
    expect(decodeClient(JSON.stringify({ type: "hello", build: "x", resume: { seed: 4294967295, epoch: 5 } }))).toEqual({
      type: "hello",
      build: "x",
      resume: { seed: 4294967295, epoch: 5 },
    })
  })
})
