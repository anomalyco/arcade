import { describe, expect, test } from "bun:test"
import { LINKS, LinkQueue, TcpLink } from "./net/link-sim"
import { InputRelay, RollbackClient, type RollbackSim, TickPacer } from "./net/rollback"
import { mulberry32 } from "./sim/rng"

/** Two counters: each tick adds each seat's input; a "wrap" event every time one passes a multiple of 10. */
type S = { x: [number, number] }
type F = { i: [number, number] }
type E = { k: "wrap"; seat: number; at: number }

const sim = (me: 0 | 1): RollbackSim<S, F, E> => ({
  clone: (s) => ({ x: [s.x[0], s.x[1]] }),
  step(s, f) {
    const out: E[] = []
    for (const k of [0, 1] as const) {
      const before = Math.floor(s.x[k] / 10)
      s.x[k] += f.i[k]
      if (Math.floor(s.x[k] / 10) !== before) out.push({ k: "wrap", seat: k, at: s.x[k] })
    }
    return out
  },
  predict(last, own) {
    const i: [number, number] = [last.i[0], last.i[1]]
    if (own !== undefined) i[me] = own
    return { i }
  },
  sig: (e) => `${e.k}:${e.seat}:${Math.floor(e.at / 10)}`,
})

describe("RollbackClient", () => {
  test("own inputs apply at once; a remote change is corrected when its frame arrives", () => {
    const c = new RollbackClient(sim(0))
    c.reset({ x: [0, 0] }, 0, { i: [0, 1] })
    for (let t = 1; t <= 5; t++) c.input(t, 2)
    c.advance(5)
    expect(c.state.x).toEqual([10, 5])
    // The room says seat 1 stopped after tick 2.
    c.confirm(1, { i: [2, 1] })
    c.confirm(2, { i: [2, 1] })
    c.confirm(3, { i: [2, 0] })
    c.advance(5)
    expect(c.state.x).toEqual([10, 2])
    expect(c.resimulated).toBe(2)
    expect(c.confirmed.x).toEqual([6, 2])
  })

  test("a missed frame is a gap, an old one is ignored", () => {
    const c = new RollbackClient(sim(0))
    c.reset({ x: [0, 0] }, 10, { i: [0, 0] })
    expect(c.confirm(9, { i: [1, 1] })).toEqual([])
    expect(c.confirm(12, { i: [1, 1] })).toBe("gap")
    expect(c.tick).toBe(10)
  })

  test("re-simulated events show once, and an event the prediction missed shows when confirmed", () => {
    const c = new RollbackClient(sim(0))
    c.reset({ x: [8, 0] }, 0, { i: [0, 0] })
    c.input(1, 1)
    c.input(2, 1)
    // Predicted: seat 0 passes 10 at tick 2.
    expect(c.advance(3).map((e) => e.seat)).toEqual([0])
    // Seat 1 really moved 10 per tick from tick 1; our own wrap is re-simulated, not shown again.
    expect((c.confirm(1, { i: [1, 10] }) as E[]).map((e) => e.seat)).toEqual([1])
    expect(c.advance(3).map((e) => e.seat)).toEqual([1, 1])
  })

  test("the prediction waits at maxAhead past the confirmed tick", () => {
    const c = new RollbackClient(sim(0), { maxAhead: 5 })
    c.reset({ x: [0, 0] }, 0, { i: [1, 1] })
    c.advance(100)
    expect(c.headTick).toBe(5)
  })
})

describe("InputRelay", () => {
  test("on time applies on its tick, late on the next tick, and the seat holds its last input", () => {
    const r = new InputRelay<string>()
    r.receive("a", 5, 3, 2)
    expect(r.drain("a")).toEqual([2])
    expect(r.drain("a")).toEqual([])
    expect([r.take("a", 3), r.take("a", 4), r.take("a", 5), r.take("a", 6)]).toEqual([0, 0, 3, 3])
    // Tick 6 has run; an input for tick 6 is a tick late and applies on 7.
    r.receive("a", 6, 1, 6)
    expect(r.drain("a")).toEqual([-1])
    expect(r.take("a", 7)).toBe(1)
    r.release("a")
    expect(r.take("a", 8)).toBe(0)
  })
})

describe("rollback over a Wi-Fi link", () => {
  for (const [name, roomRate] of [["a room on time", 1], ["a room ticking 10% slow", 0.9], ["a room ticking 20% slow", 0.8], ["a room ticking 5% fast", 1.05]] as const)
  test(`${name}: clients agree with it and the pacer keeps inputs on time`, () => {
    const TICK = 1000 / 60
    const rand = mulberry32(7)
    const room: S = { x: [0, 0] }
    const relay = new InputRelay<number>()
    const up = [0, 1].map(() => new LinkQueue<{ t: number; b: number; beat?: boolean }>(new TcpLink(LINKS.wifi, rand)))
    const down = [0, 1].map(() => new LinkQueue<{ t: number; f: F; slack: number[] }>(new TcpLink(LINKS.wifi, rand)))
    const clients = ([0, 1] as const).map((k) => new RollbackClient(sim(k)))
    const pacers = [0, 1].map(() => new TickPacer(TICK))
    const held = [0, 0]
    const history = new Map<number, [number, number]>()
    let ran = 0
    let late = 0
    let sent = 0
    for (const k of [0, 1]) {
      clients[k]!.reset({ x: [0, 0] }, 0, { i: [0, 0] })
      pacers[k]!.start(0, 80, 0)
    }
    const step = (s: S, f: F) => sim(0).step(s, f)
    for (let ms = 0; ms < 60_000; ms++) {
      // Room: inputs in, then a tick every TICK ms, broadcasting its frame.
      for (const k of [0, 1]) for (const m of up[k]!.arrived(ms)) {
        if (m.t <= ran && !m.beat) late++
        relay.receive(k, m.t, m.b, ran)
      }
      if (ms >= ((ran + 1) * TICK) / roomRate) {
        ran++
        const f: F = { i: [relay.take(0, ran), relay.take(1, ran)] }
        step(room, f)
        history.set(ran, [room.x[0], room.x[1]])
        for (const k of [0, 1]) down[k]!.send(ms, { t: ran, f, slack: relay.drain(k) })
      }
      // Clients: frames in, then their own fixed step at the pacer's rate.
      for (const k of [0, 1] as const) {
        const c = clients[k]!
        const p = pacers[k]!
        for (const m of down[k]!.arrived(ms)) {
          c.confirm(m.t, m.f)
          p.frame(m.t, ms)
          for (const v of m.slack) p.slack(v)
        }
        p.atLeast(c.tick)
        const before = p.tick
        const head = p.update(ms)
        for (let t = before + 1; t <= head; t++) {
          const was = held[k]!
          if (rand() < 0.02) held[k] = Math.floor(rand() * 3)
          c.input(t, held[k]!)
          // Like the game: send changes, plus a heartbeat every 6 ticks while something is held.
          if (held[k] !== was) {
            up[k]!.send(ms, { t, b: held[k]! })
            sent++
          } else if (held[k] && t % 6 === 0) up[k]!.send(ms, { t, b: held[k]!, beat: true })
        }
        c.advance(head)
      }
    }
    for (const c of clients) {
      expect(c.tick).toBeGreaterThan(ran - 30)
      expect(c.confirmed.x).toEqual(history.get(c.tick)!)
    }
    // Over TCP a lost segment or a Wi-Fi stall holds every input behind it, so a few changes always land late.
    expect(late / sent).toBeLessThan(0.1)
    for (const p of pacers) expect(p.tick - ran).toBeLessThan(10)
  })
})
