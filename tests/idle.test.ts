import { describe, expect, mock, test } from "bun:test"
import { NO_INTENT } from "../shared/sim/world"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { IDLE_KICK_MS, IDLE_WARN_MS, RoomCore } = await import("../server/room")

function setup() {
  let now = 1_000_000
  const core = new RoomCore("idle", "ffa", () => now)
  const sent: string[] = []
  let closed = 0
  const conn = { send: (d: string) => sent.push(d), close: () => closed++ }
  core.message(conn, JSON.stringify({ type: "hello", name: "afk", gun: "rifle" }))
  const id = (JSON.parse(sent[0]!) as { id: string }).id
  let seq = 0
  return {
    core,
    id,
    sent,
    closed: () => closed,
    advance(ms: number, input?: Partial<typeof NO_INTENT>) {
      for (let t = 0; t < ms; t += 1000) {
        now += 1000
        if (input) core.message(conn, JSON.stringify({ type: "intent", seq: ++seq, i: { ...NO_INTENT, ...input } }))
        core.step()
      }
    },
  }
}

describe("idle kick", () => {
  test("no input for the limit kicks you, with a countdown first", () => {
    const s = setup()
    s.advance(IDLE_KICK_MS - IDLE_WARN_MS + 1000)
    expect(s.sent.some((m) => m.includes('"type":"idle"') && !m.includes('"seconds":0'))).toBe(true)
    expect(s.closed()).toBe(0)
    s.advance(IDLE_WARN_MS)
    expect(s.closed()).toBe(1)
    expect(s.sent.some((m) => m.includes("kicked for being idle"))).toBe(true)
    expect(s.core.world.players.has(s.id)).toBe(false)
  })

  test("moving keeps you in", () => {
    const s = setup()
    let flip = 1
    for (let k = 0; k < 4; k++) {
      s.advance(IDLE_KICK_MS / 2, { mx: (flip = -flip) })
    }
    expect(s.closed()).toBe(0)
  })

  test("turning the aim counts; holding still with the same aim does not", () => {
    const s = setup()
    for (let k = 0; k < 6; k++) s.advance(IDLE_KICK_MS / 3, { aim: k * 0.5 })
    expect(s.closed()).toBe(0)
    s.advance(IDLE_KICK_MS + 1000, { aim: 2.5 })
    expect(s.closed()).toBe(1)
  })

  test("time dead doesn't count", () => {
    const s = setup()
    const p = s.core.world.players.get(s.id)!
    s.advance(IDLE_KICK_MS - 5000)
    p.alive = false
    p.respawnAt = Infinity
    s.advance(IDLE_KICK_MS)
    expect(s.closed()).toBe(0)
  })
})
