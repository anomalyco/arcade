import { describe, expect, mock, test } from "bun:test"
import { BUILD } from "../shared/build.gen"
import { ROSTER } from "../shared/characters"
import { STOCKS } from "../shared/config"
import { decodeClient, encodeServer } from "../shared/protocol"
import { buildSnapshot } from "../shared/view"
import { INTENT_OPS, NO_INTENT, World } from "../shared/world"

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }))
const { RoomCore } = await import("../server/room")

const run = (w: World, seconds: number) => {
  for (let i = 0; i < seconds * 30; i++) w.step()
}

describe("brawl world", () => {
  test("bots pick, play a stock round to a winner and return to select", () => {
    const w = new World(7)
    w.botFill = 4
    w.fill()
    expect(w.players.size).toBe(4)
    run(w, 26)
    expect(w.phase).toBe("play")
    for (const f of w.players.values()) expect(f.stocks).toBe(STOCKS)
    let kos = 0
    for (let i = 0; i < 200 * 30 && w.phase === "play"; i++) {
      w.step()
      kos += w.takeEvents().filter((e) => e.k === "ko").length
    }
    expect(kos).toBeGreaterThan(0)
    expect(w.phase).toBe("results")
    expect(w.winner).not.toBe("")
    run(w, 10)
    expect(w.phase).toBe("select")
  })

  test("the same seed replays the same round", () => {
    const play = () => {
      const w = new World(3)
      w.fill(4)
      run(w, 60)
      return JSON.stringify(buildSnapshot(w, "bot1"))
    }
    expect(play()).toBe(play())
  })

  test("knockback grows with damage and fast hits clear the ropes", () => {
    const w = new World(1)
    w.botFill = 0
    const a = w.addHuman("a", "a", "slab")
    const b = w.addHuman("b", "b", "bea")
    w.setReady("a", true)
    w.setReady("b", true)
    w.step()
    run(w, 3.2)
    b.invulnUntil = 0
    b.x = 14
    b.y = 3
    w.hit(b, { damage: 10, knock: 10 }, a, 14, 5, 1)
    const slow = Math.hypot(b.vx, b.vy)
    b.damage = 150
    b.vx = b.vy = 0
    w.hit(b, { damage: 10, knock: 10 }, a, 14, 5, 1)
    expect(Math.hypot(b.vx, b.vy)).toBeGreaterThan(slow * 2)
    run(w, 1.5)
    expect(b.stocks).toBe(STOCKS - 1)
    expect(a.kos).toBe(1)
  })

  test("every character's abilities cast without errors", () => {
    for (const c of ROSTER) {
      const w = new World(5)
      w.botFill = 0
      const a = w.addHuman("a", "a", c.id)
      w.addHuman("b", "b", ROSTER[0]!.id)
      w.setReady("a", true)
      w.setReady("b", true)
      run(w, 3.3)
      for (let s = 0; s < 4; s++) {
        expect(w.abilitySystem.cast(a, s, a.x + 4, a.y)).toBe(true)
        run(w, 1.2)
      }
    }
  })

  test("a room seats humans with the build handshake and broadcasts snapshots", () => {
    const core = new RoomCore("abcd", () => 0)
    const sent: string[] = []
    core.message({ send: (d) => sent.push(d), close: () => {} }, JSON.stringify({ type: "hello", name: "kit", build: BUILD, pick: "chef" }))
    expect(JSON.parse(sent[0]!).type).toBe("welcome")
    expect(core.world.humans[0]!.pick).toBe("chef")
    for (let i = 0; i < 4; i++) core.step()
    expect(sent.some((s) => JSON.parse(s).type === "snap")).toBe(true)
    expect(decodeClient(JSON.stringify({ type: "intent", seq: 1, i: { mx: 1, my: 0, aim: 0, tx: 1, ty: 2, cast: 9 } }))).toEqual({ type: "intent", seq: 1, i: { mx: 1, my: 0, aim: 0, tx: 1, ty: 2, cast: -1 } })
    expect(encodeServer(buildSnapshot(core.world, core.world.humans[0]!.id)).length).toBeLessThan(4000)
  })

  test("a cast survives being merged or stood in for by the room's jitter buffer", () => {
    const cast = { ...NO_INTENT, cast: 2, tx: 5, ty: 6 }
    const move = { ...NO_INTENT, mx: 1, tx: 9, ty: 9 }
    expect(INTENT_OPS.merge(cast, move)).toEqual({ ...move, cast: 2, tx: 5, ty: 6 })
    expect(INTENT_OPS.merge(move, cast)).toEqual(cast)
    expect(INTENT_OPS.standIn(cast).cast).toBe(-1)
    expect(INTENT_OPS.hasEdges(cast) && !INTENT_OPS.hasEdges(move)).toBe(true)
  })

  test("a reconnect with the seat's token keeps the fighter; the public id doesn't", () => {
    const core = new RoomCore("abcd", () => 0)
    const sent: string[] = []
    const conn = { send: (d: string) => sent.push(d), close: () => {} }
    core.message(conn, JSON.stringify({ type: "hello", name: "kit", build: BUILD, pick: "chef" }))
    const welcome = JSON.parse(sent[0]!) as { id: string; token: string }
    core.close(conn)
    const thief: string[] = []
    core.message({ send: (d) => thief.push(d), close: () => {} }, JSON.stringify({ type: "hello", name: "eve", build: BUILD, id: welcome.id, token: welcome.id }))
    expect(JSON.parse(thief[0]!).id).not.toBe(welcome.id)
    const back: string[] = []
    core.message({ send: (d) => back.push(d), close: () => {} }, JSON.stringify({ type: "hello", name: "kit", build: BUILD, token: welcome.token }))
    expect(JSON.parse(back[0]!).id).toBe(welcome.id)
    expect(core.world.humans.length).toBe(2)
  })
})
