import { describe, expect, mock, test } from "bun:test"
import { LINKS, type LinkProfile, LinkQueue, TcpLink } from "@arcade/kit/net/link-sim"
import { RollbackClient, TickPacer } from "@arcade/kit/net/rollback"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { wrapDelta } from "../shared/arena"
import { BUILD } from "../shared/build.gen"
import { TICK_HZ } from "../shared/config"
import { BTN } from "../shared/input"
import { hashWorld, rollbackSim } from "../shared/match"
import { type ClientMsg, type Frame, type ServerMsg, decodeServer, encodeClient } from "../shared/protocol"
import { DEFAULT_TUNING } from "../shared/tuning"
import { type SimEvent, World } from "../shared/world"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { RoomCore } = await import("../server/room")

const TICK_MS = 1000 / TICK_HZ
const quantile = (v: number[], q: number) => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

/** Buttons a person might press: runs held for a while, jumps, draws held then loosed, the odd dodge. */
function player(rand: () => number) {
  let dir = 0
  let until = 0
  let draw = 0
  return (t: number): number => {
    if (t >= until) {
      dir = [0, BTN.left, BTN.right, BTN.left | BTN.up, BTN.right | BTN.up, BTN.down][Math.floor(rand() * 6)]!
      until = t + 10 + Math.floor(rand() * 50)
    }
    if (draw <= 0 && rand() < 0.02) draw = 8 + Math.floor(rand() * 20)
    let b = dir
    if (draw > 0 && --draw > 0) b |= BTN.shoot
    if (rand() < 0.03) b |= BTN.jump
    if (rand() < 0.004) b |= BTN.dodge
    return b
  }
}

type Stats = { hashChecks: number; mismatches: number; gaps: number; late: number; sent: number; resim: number[]; own: number[]; remote: number[]; bots: number[]; behind: number[]; lead: number[]; events: Record<string, number> }

/**
 * A room and `clients` browsers over `link`, for `seconds`: each client runs the real rollback loop (pacer, inputs on
 * change plus a heartbeat, confirm, predict) against the real room core. Errors are how far what a client drew at a
 * tick was from where the room's world put the archer at that tick, in tiles (an archer is 1.2 tiles tall).
 */
function run(link: LinkProfile, seconds: number, clients = 2, seed = 3) {
  const rand = mulberry32(seed)
  let ms = 0
  const core = new RoomCore("tst1", "belltower", () => ms)
  const truth = new Map<number, World>()
  const stats: Stats = { hashChecks: 0, mismatches: 0, gaps: 0, late: 0, sent: 0, resim: [], own: [], remote: [], bots: [], behind: [], lead: [], events: {} }
  const cs = Array.from({ length: clients }, (_, k) => {
    const down = new LinkQueue<string>(new TcpLink(link, rand))
    const up = new LinkQueue<string>(new TcpLink(link, rand))
    const conn = { send: (d: string) => down.send(ms, d), close() {} }
    let slot = -1
    const c = {
      k, down, up, conn, id: "", helloAt: 0,
      rb: new RollbackClient(rollbackSim(() => slot)),
      pacer: new TickPacer(TICK_MS),
      press: player(mulberry32(seed * 31 + k)),
      held: 0,
      shown: new Map<number, [number, number][]>(),
      get slot() {
        return slot
      },
      set slot(v: number) {
        slot = v
      },
    }
    return c
  })
  const send = (c: (typeof cs)[number], m: ClientMsg) => c.up.send(ms, encodeClient(m))
  for (const c of cs) {
    core.open(c.conn)
    c.helloAt = ms
    send(c, { type: "hello", build: BUILD })
  }
  const end = seconds * 1000
  let ran = 0
  for (; ms < end; ms++) {
    for (const c of cs)
      for (const raw of c.up.arrived(ms)) {
        const m = JSON.parse(raw) as ClientMsg
        if (m.type === "in") {
          stats.sent++
          if (m.t <= core.world.s.tick) stats.late++
        }
        core.message(c.conn, raw)
      }
    while (ms >= (ran + 1) * TICK_MS) {
      core.step()
      ran++
      truth.set(core.world.s.tick, new World(structuredClone(core.world.s), DEFAULT_TUNING))
    }
    for (const c of cs) {
      for (const raw of c.down.arrived(ms)) {
        const m = decodeServer(raw) as ServerMsg
        if (m.type === "welcome") c.id = m.id
        else if (m.type === "roster") c.slot = m.players.find((p) => p.id === c.id)?.slot ?? -1
        else if (m.type === "state") {
          c.rb.reset(new World(m.s, DEFAULT_TUNING), m.t, { i: m.i })
          c.pacer.start(m.t, ms - c.helloAt, ms)
        } else if (m.type === "f") {
          const frame: Frame = m.c ? { i: m.i, c: m.c } : { i: m.i }
          c.pacer.frame(m.t, ms)
          const ev = c.rb.confirm(m.t, frame)
          if (ev === "gap") {
            stats.gaps++
            send(c, { type: "resync" })
            continue
          }
          for (const v of m.a ?? []) c.pacer.slack(v)
          if (m.h !== undefined) {
            stats.hashChecks++
            if (hashWorld(c.rb.confirmed) !== m.h) stats.mismatches++
          }
          // Score what this client drew at the tick against the room's world.
          const drawn = c.shown.get(m.t)
          const real = truth.get(m.t)
          // What a snapshot-interpolation client would draw instead: the room's world a round trip plus 100 ms ago.
          const old = truth.get(m.t - Math.round((link.rttMs + 100) / TICK_MS))
          if (real && old && c.slot >= 0)
            real.s.archers.forEach((a, i) => {
              const o = old.s.archers[i]
              if (a.bot || a.slot === c.slot || !a.alive || !o?.alive) return
              stats.behind.push(Math.hypot(wrapDelta(a.x - o.x, real.arena.w), wrapDelta(a.y - o.y, real.arena.h)))
            })
          if (drawn && real && c.slot >= 0)
            real.s.archers.forEach((a, i) => {
              const d = drawn[i]
              if (!d || !a.alive) return
              const e = Math.hypot(wrapDelta(a.x - d[0], real.arena.w), wrapDelta(a.y - d[1], real.arena.h))
              ;(a.slot === c.slot ? stats.own : a.bot ? stats.bots : stats.remote).push(e)
            })
          c.shown.delete(m.t)
        }
      }
      if (!c.rb.ready) continue
      c.pacer.atLeast(c.rb.tick)
      const from = c.rb.headTick
      const head = c.pacer.update(ms)
      for (let t = from + 1; t <= head; t++) {
        const b = c.press(t)
        c.rb.input(t, b)
        if (b !== c.held || (b && t % 6 === 0)) send(c, { type: "in", t, b })
        c.held = b
      }
      const events: SimEvent[] = c.rb.advance(head, (w, t) => {
        if (!c.shown.has(t)) c.shown.set(t, w.s.archers.map((a) => [a.x, a.y]))
      })
      if (c.rb.resimulated) stats.resim.push(c.rb.resimulated)
      for (const e of events) stats.events[e.k] = (stats.events[e.k] ?? 0) + 1
      if (ms % 100 === 0) stats.lead.push(c.rb.headTick - core.world.s.tick)
      for (const t of c.shown.keys()) if (t < c.rb.tick - 60) c.shown.delete(t)
    }
    for (const t of truth.keys()) if (t < core.world.s.tick - 400) truth.delete(t)
  }
  // Last check: every client's confirmed world is the room's world at that tick.
  const final = cs.map((c) => truth.get(c.rb.tick) && hashWorld(truth.get(c.rb.tick)!) === hashWorld(c.rb.confirmed))
  return { stats, final, core }
}

describe("online rollback", () => {
  test("two clients over Wi-Fi stay in step with the room", () => {
    const { stats, final, core } = run(LINKS.wifi, 90)
    expect(core.humans).toBe(2)
    expect(stats.hashChecks).toBeGreaterThan(300)
    expect(stats.mismatches).toBe(0)
    expect(stats.gaps).toBe(0)
    expect(final).toEqual([true, true])
    // Archers died and rounds turned over, so arrows met archers across the wire.
    expect(stats.events.kill ?? 0).toBeGreaterThan(5)
    expect(core.world.s.round).toBeGreaterThan(1)
    // Own archer: drawn where the room puts it nearly always (a late input over TCP is the exception).
    expect(quantile(stats.own, 0.9)).toBeLessThan(0.05)
    expect(stats.late / stats.sent).toBeLessThan(0.1)
  })

  test.skipIf(!process.env.ONLINE_BENCH)("bench: good, wifi and bad links", () => {
    const rows = []
    for (const [name, link] of Object.entries(LINKS)) {
      const { stats } = run(link, 60, 2, 11)
      const f = (v: number[], q: number) => quantile(v, q).toFixed(2)
      rows.push({
        link: name,
        "lead ticks p50": quantile(stats.lead, 0.5),
        "late inputs %": ((100 * stats.late) / stats.sent).toFixed(1),
        "resim p50/p95": `${quantile(stats.resim, 0.5)}/${quantile(stats.resim, 0.95)}`,
        "own err p95/p99 tiles": `${f(stats.own, 0.95)}/${f(stats.own, 0.99)}`,
        "other person err p50/p90/p99 tiles": `${f(stats.remote, 0.5)}/${f(stats.remote, 0.9)}/${f(stats.remote, 0.99)}`,
        "other person > 0.25 tile %": ((100 * stats.remote.filter((e) => e > 0.25).length) / Math.max(1, stats.remote.length)).toFixed(1),
        "bots err p99": f(stats.bots, 0.99),
        "interpolated instead p50/p90/p99": `${f(stats.behind, 0.5)}/${f(stats.behind, 0.9)}/${f(stats.behind, 0.99)}`,
        "interpolated > 0.25 tile %": ((100 * stats.behind.filter((e) => e > 0.25).length) / Math.max(1, stats.behind.length)).toFixed(1),
        mismatches: stats.mismatches,
      })
    }
    console.table(rows)
  })
})
