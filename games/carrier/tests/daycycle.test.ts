import { describe, expect, test } from "bun:test"
import {
  DAY_CYCLE,
  RoomTime,
  TIME_OVERRIDE_LEAD,
  celestial,
  clockText,
  elevation,
  hourOfPhase,
  moonDir,
  nextPhaseOf,
  packTime,
  phaseNow,
  phaseOfHour,
  skyAt,
  sunDir,
  timeOverride,
  timelinePhase,
  unpackTime,
} from "../shared/daycycle"

/** Hours the clock moves forward from a to b (wrapping at midnight). */
const ahead = (a: number, b: number) => (((b - a) % 24) + 24) % 24
/** Clock distance between two hours, either way round. */
const apart = (a: number, b: number) => Math.min(ahead(a, b), ahead(b, a))

describe("clock", () => {
  test("runs forward, continuously, through a whole cycle", () => {
    let prev = hourOfPhase(0)
    for (let i = 1; i <= 24_000; i++) {
      const h = hourOfPhase(i / 24_000)
      const d = ahead(prev, h)
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThan(0.01)
      prev = h
    }
  })

  test("is periodic", () => {
    for (const p of [0, 0.13, 0.5, 0.97]) expect(hourOfPhase(p + 3)).toBeCloseTo(hourOfPhase(p), 9)
  })

  test("phaseOfHour inverts hourOfPhase", () => {
    for (let h = 0; h < 24; h += 0.37) expect(apart(h, hourOfPhase(phaseOfHour(h)))).toBeLessThan(1e-6)
    for (let p = 0; p < 1; p += 0.031) expect(Math.abs(phaseOfHour(hourOfPhase(p)) - p)).toBeLessThan(1e-6)
  })

  test("most of the cycle is daylight; dusk, night and dawn pass quicker", () => {
    const minutes = (a: number, b: number) => {
      const pa = phaseOfHour(a)
      const pb = nextPhaseOf(pa, b)
      return ((pb - pa) * DAY_CYCLE) / 60
    }
    // Shares of the cycle (5 min): 14/24 day, 2.5/24 golden hour to dusk, 5/24 night, 2.5/24 dawn.
    const share = (a: number, b: number) => minutes(a, b) / (DAY_CYCLE / 60)
    expect(share(7, 17)).toBeCloseTo(14 / 24, 1)
    expect(share(17, 19.5)).toBeCloseTo(2.5 / 24, 1)
    expect(share(19.5, 4.5)).toBeCloseTo(5 / 24, 1)
    expect(share(4.5, 7)).toBeCloseTo(2.5 / 24, 1)
    expect(DAY_CYCLE).toBe(300)
  })

  test("rooms start in the morning, seeded", () => {
    const starts = new Set<string>()
    for (let seed = 1; seed < 40; seed++) {
      const h = hourOfPhase(timelinePhase(seed, 0))
      expect(h).toBeGreaterThanOrEqual(9 - 1e-6)
      expect(h).toBeLessThanOrEqual(11 + 1e-6)
      starts.add(h.toFixed(2))
    }
    expect(starts.size).toBeGreaterThan(20)
  })

  test("clockText", () => {
    expect(clockText(7.5)).toBe("07:30")
    expect(clockText(23.999)).toBe("23:59")
    expect(clockText(24.25)).toBe("00:15")
  })
})

describe("overrides", () => {
  const seed = 7

  test("set an hour: continuous at the start, lands on the hour after the fade, then runs at its speed", () => {
    const o = timeOverride(seed, null, 100, 22, 1, 8)
    expect(phaseNow(seed, 100, o)).toBeCloseTo(timelinePhase(seed, 100), 6)
    expect(phaseNow(seed, 100.001, o)).toBeCloseTo(timelinePhase(seed, 100.001), 4)
    expect(hourOfPhase(phaseNow(seed, 108, o))).toBeCloseTo(22, 4)
    const later = phaseNow(seed, 108 + 60, o)
    expect((later - phaseNow(seed, 108, o)) * DAY_CYCLE).toBeCloseTo(60, 4)
  })

  test("the fade always runs forward", () => {
    const o = timeOverride(seed, null, 50, 8, 1, 10)
    let prev = phaseNow(seed, 50, o)
    for (let t = 50.1; t <= 61; t += 0.1) {
      const p = phaseNow(seed, t, o)
      expect(p).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = p
    }
    expect(o.to - o.from).toBeLessThan(1)
    expect(o.to).toBeGreaterThanOrEqual(o.from)
  })

  test("freeze, then chain an override from a frozen clock", () => {
    const a = timeOverride(seed, null, 10, 12, 0, 0)
    expect(hourOfPhase(phaseNow(seed, 500, a))).toBeCloseTo(12, 5)
    const b = timeOverride(seed, a, 600, 18, 1, 5)
    expect(b.fromSpeed).toBe(0)
    expect(b.from).toBeCloseTo(phaseNow(seed, 600, a), 6)
    expect(phaseNow(seed, 600.001, b)).toBeCloseTo(b.from, 5)
    expect(hourOfPhase(phaseNow(seed, 605, b))).toBeCloseTo(18, 4)
  })

  test("back to the timeline shows the timeline's hour", () => {
    const a = timeOverride(seed, null, 10, 2, 0, 0)
    const b = timeOverride(seed, a, 300, null, 1, 6)
    for (const t of [306, 400, 2000]) expect(apart(hourOfPhase(timelinePhase(seed, t)), hourOfPhase(phaseNow(seed, t, b)))).toBeLessThan(1e-4)
  })

  test("RoomTime keeps the previous override until the new one starts", () => {
    const room = new RoomTime(seed)
    const a = timeOverride(seed, null, 10, 21, 1, 0)
    room.set(a)
    const b = timeOverride(seed, a, 200 + TIME_OVERRIDE_LEAD, 9, 1, 0)
    room.set(b)
    expect(room.phase(200)).toBeCloseTo(phaseNow(seed, 200, a), 9)
    expect(hourOfPhase(room.phase(201.5))).toBeCloseTo(9 + 0.5 / 3600 * 24, 1)
  })

  test("wire form round-trips and rejects bad input", () => {
    const o = timeOverride(seed, null, 123.5, 19.25, 4, 12)
    expect(unpackTime(JSON.parse(JSON.stringify(packTime(o))))).toEqual(o)
    expect(unpackTime([1, 2, 3])).toBeNull()
    expect(unpackTime([0, 5, 1, 1, 0.5, 1])).toBeNull()
    expect(unpackTime([0, 1, 1, 1, 3, 1])).toBeNull()
    expect(unpackTime([0, 5, 1, 1, 1.5, -1])).toBeNull()
    expect(unpackTime([0, 5, 1, 1, 1.5, 1e6])).toBeNull()
    expect(unpackTime([0, Number.NaN, 1, 1, 1.5, 1])).toBeNull()
  })
})

describe("sky", () => {
  test("the sun rises in the north at 06:00, peaks at noon toward the concepts' bearing, sets in the north-east at 18:00", () => {
    expect(elevation(sunDir(6))).toBeCloseTo(0, 6)
    expect(elevation(sunDir(18))).toBeCloseTo(0, 6)
    expect(elevation(sunDir(12))).toBeCloseTo(60, 6)
    expect(elevation(sunDir(0))).toBeCloseTo(-60, 6)
    const n = sunDir(12)
    expect((Math.atan2(n[0], -n[2]) * 180) / Math.PI).toBeCloseTo(26, 6)
    const rise = sunDir(6)
    expect((Math.atan2(rise[0], -rise[2]) * 180) / Math.PI).toBeCloseTo(1, 6)
    const set = sunDir(18)
    expect((Math.atan2(set[0], -set[2]) * 180) / Math.PI).toBeCloseTo(51, 6)
    // Golden hour stands ahead and to the right of a camera looking north.
    const gold = sunDir(17.2)
    expect(gold[2]).toBeLessThan(0)
    expect(gold[0]).toBeGreaterThan(0)
    // Continuous all round the clock.
    for (let h = 0; h < 24; h += 0.01) {
      const a = sunDir(h)
      const b = sunDir(h + 0.01)
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(0.01)
    }
  })

  test("the moon is up all night and nearly full", () => {
    for (let day = 0; day < 30; day++)
      for (const h of [20, 22, 0, 2, 4]) {
        const p = day + phaseOfHour(h)
        const s = skyAt(9, p)
        expect(elevation(moonDir(9, p))).toBeGreaterThan(5)
        expect(s.moonLit).toBeGreaterThan(0.85)
      }
  })

  test("celestial is a rotation", () => {
    const m = celestial(1.1)
    const col = (i: number) => [m[i]!, m[i + 1]!, m[i + 2]!]
    const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
    for (let i = 0; i < 3; i++) {
      expect(dot(col(i * 3), col(i * 3))).toBeCloseTo(1, 9)
      for (let j = i + 1; j < 3; j++) expect(dot(col(i * 3), col(j * 3))).toBeCloseTo(0, 9)
    }
  })
})

describe("room clock (protocol + server)", () => {
  test("a broadcast clock reaches everyone, joiners get it, and clients show the room's hour", async () => {
    const { RoomCore } = await import("../server/core")
    const { BUILD } = await import("../shared/build.gen")
    const { decodeClient, decodeServer, encode } = await import("../shared/protocol")
    type Msg = NonNullable<ReturnType<typeof decodeServer>>
    const conn = () => {
      const sent: Msg[] = []
      return { sent, send: (d: string) => void sent.push(decodeServer(d)!), close: () => {} }
    }
    const last = (c: { sent: Msg[] }) => c.sent.filter((m) => m.type === "time").at(-1) as Extract<Msg, { type: "time" }> | undefined
    let now = 1_000_000
    const core = new RoomCore(
      () => now,
      () => 42,
    )
    const a = conn()
    core.message(a, encode({ type: "hello", build: BUILD, name: "ada" }))
    expect(last(a)).toEqual({ type: "time", o: null })
    expect(decodeClient(encode({ type: "time", h: 25, s: 1, f: 8 }))).toBeNull()
    expect(decodeClient(encode({ type: "time", h: 12, s: 1e6, f: 8 }))).toBeNull()
    expect(decodeClient(encode({ type: "time", h: 12, s: 1, f: -1 }))).toBeNull()
    expect(decodeClient(encode({ type: "time", h: null, s: 1, f: 8 }))).not.toBeNull()
    core.message(a, encode({ type: "time", h: 22, s: 0, f: 6 }))
    const msg = last(a)!
    const o = unpackTime(msg.o)!
    expect(o.speed).toBe(0)
    const b = conn()
    core.message(b, encode({ type: "hello", build: BUILD, name: "bo" }))
    expect(last(b)).toEqual(msg)
    const client = new RoomTime(core.world!.seed)
    client.set(o)
    now += 20_000
    const t = (now - core.world!.epoch) / 1000
    expect(hourOfPhase(client.phase(t))).toBeCloseTo(22, 4)
    core.message(b, encode({ type: "time", h: null, s: 1, f: 0 }))
    const back = unpackTime(last(a)!.o)!
    client.set(back)
    const t2 = t + 30
    const want = hourOfPhase(timelinePhase(core.world!.seed, t2))
    const got = hourOfPhase(client.phase(t2))
    expect(Math.min(Math.abs(want - got), 24 - Math.abs(want - got))).toBeLessThan(1e-3)
  })
})
