import { describe, expect, mock, test } from "bun:test"
import { Flock } from "@arcade/kit/sim/boids"
import { BUILD } from "../shared/build.gen"
import { ROSTER } from "../shared/characters"
import { DT, RESULTS_SECONDS, SELECT_SECONDS, STOCKS } from "../shared/config"
import { decodeClient, encodeServer } from "../shared/protocol"
import { buildSnapshot } from "../shared/view"
import {
  INTENT_OPS, NO_INTENT, World, cloneSnapshot, diffSnapshot, forkSnapshot,
  hashSnapshot, loadSnapshot, saveSnapshot, step,
} from "../shared/world"

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
    run(w, SELECT_SECONDS + 1)
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
    run(w, RESULTS_SECONDS + 1)
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

  test("toSnapshot and restoreSnapshot preserve bit-identical continuation across all roster abilities, swarms and props", () => {
    const w = new World(11)
    w.botFill = 6
    w.fill(6)
    ROSTER.forEach((c, idx) => {
      const f = w.actors[idx]!
      f.pick = f.char = c.id
    })
    w.startRound()
    run(w, 8)
    expect(w.abilitySystem.projectiles.length + w.abilitySystem.zones.length + w.abilitySystem.swarms.length).toBeGreaterThan(0)

    const saved = saveSnapshot(w.toSnapshot())
    const restored = World.fromSnapshot(loadSnapshot(saved))
    expect(diffSnapshot(restored.toSnapshot(), w.toSnapshot())).toEqual([])
    expect(hashSnapshot(restored.toSnapshot())).toBe(hashSnapshot(w.toSnapshot()))

    for (let t = 0; t < 180; t++) {
      w.step()
      restored.step()
      if (t % 30 === 29) {
        expect(diffSnapshot(restored.toSnapshot(), w.toSnapshot())).toEqual([])
        expect(hashSnapshot(restored.toSnapshot())).toBe(hashSnapshot(w.toSnapshot()))
      }
    }
    expect(JSON.stringify(buildSnapshot(restored, "bot1"))).toBe(JSON.stringify(buildSnapshot(w, "bot1")))
  })

  test("pure step(state, inputs, dt) matches mutable World.step, never mutates input state, and honours caller edits", () => {
    const w = new World(19)
    w.botFill = 3
    w.addHuman("p1", "p1", "chef")
    w.setReady("p1", true)
    w.step()

    let s = w.toSnapshot()
    for (let t = 0; t < 120; t++) {
      const intent = {
        mx: Math.cos(t * 0.1),
        my: Math.sin(t * 0.13),
        aim: t * 0.07,
        tx: 14 + Math.cos(t * 0.1) * 3,
        ty: 10 + Math.sin(t * 0.1) * 3,
        cast: t % 25 === 0 ? (t / 25) % 4 : -1,
      }
      const before = cloneSnapshot(s)
      w.push("p1", t + 1, intent)
      w.step(DT)
      const next = step(s, { p1: intent }, DT)
      expect(diffSnapshot(s, before)).toEqual([])
      expect(diffSnapshot(next, w.toSnapshot())).toEqual([])
      // Stepping `s` a second time (after live world was consumed) restores fresh and gives the exact same state.
      if (t === 60) {
        expect(diffSnapshot(step(s, { p1: intent }, DT), next)).toEqual([])
      }
      s = next
    }

    // Mutating a returned snapshot forces a fresh restore that honours the caller's edit.
    s.players[0]!.x += 2.5
    s.players[0]!.damage = 88
    const edited = cloneSnapshot(s)
    const fresh = World.fromSnapshot(edited)
    fresh.step(DT)
    expect(diffSnapshot(step(s, undefined, DT), fresh.toSnapshot())).toEqual([])
  })

  test("fork equivalence: interleaved forks never share mutable state and identical forks replay bit-identically", () => {
    const w = new World(23)
    w.fill(4)
    w.startRound()
    run(w, 5)
    const base = w.toSnapshot()

    let forkA1 = forkSnapshot(base, { rolloutSeed: 101 })
    let forkA2 = forkSnapshot(base, { rolloutSeed: 101 })
    let forkB = forkSnapshot(base, { rolloutSeed: 202 })

    for (let t = 0; t < 90; t++) {
      forkA1 = step(forkA1, undefined, DT)
      forkB = step(forkB, undefined, DT)
      forkA2 = step(forkA2, undefined, DT)
    }
    expect(diffSnapshot(forkA1, forkA2)).toEqual([])
    expect(hashSnapshot(forkA1)).toBe(hashSnapshot(forkA2))
    expect(hashSnapshot(forkA1)).not.toBe(hashSnapshot(forkB))
  })

  test("Flock boids toSnapshot and restoreSnapshot are bit-identical", () => {
    const a = new Flock(14, 77, 10, 1.2, 8, 0.75)
    for (let i = 0; i < 30; i++) a.step(DT, 14, 10 + i * 0.1, 1.2, 8, 3, 1, 0.75)
    const snap = JSON.parse(JSON.stringify(a.toSnapshot()))
    const b = Flock.fromSnapshot(snap)
    for (let i = 0; i < 30; i++) {
      a.step(DT, 12, 13, 1.2, 9, -2, 2, 0.75, 0.2)
      b.step(DT, 12, 13, 1.2, 9, -2, 2, 0.75, 0.2)
    }
    expect(b.toSnapshot()).toEqual(a.toSnapshot())
  })

  test("lag-compensated cast (intent.view) hits a moving target at its rendered past position", () => {
    const w = new World(31)
    w.botFill = 0
    const a = w.addHuman("a", "Alice", "slab")
    const b = w.addHuman("b", "Bob", "chef")
    w.setReady("a", true)
    w.setReady("b", true)
    w.step()
    while (w.time < w.goAt + 0.1) w.step()
    a.invulnUntil = b.invulnUntil = 0
    a.x = 12
    a.y = 10
    b.x = 13.4
    b.y = 10
    const hitTime = w.time
    w.rewind.record(w.tick, w.time, w.actors, (f) => f.alive)
    // Bob moves 2.5 m away over the next 4 ticks (133 ms later on the server)
    for (let i = 0; i < 4; i++) {
      b.x += 0.65
      w.time += DT
      w.tick++
      w.rewind.record(w.tick, w.time, w.actors, (f) => f.alive)
    }
    // Alice swings at +X (0 rad) with `view: hitTime` (when Bob was at x = 13.4, within melee range)
    w.push("a", 1, { ...NO_INTENT, aim: 0, tx: 14, ty: 10, cast: 0, view: hitTime })
    for (let i = 0; i < 8; i++) w.step()
    expect(b.damage).toBeGreaterThan(0)
  })
})
