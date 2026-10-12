import { describe, expect, test } from "bun:test"
import { MAX_PLAYERS } from "../shared/config"
import { CODE_CHARS } from "../shared/protocol"
import { Matchmaker, RESERVE_MS, type RoomEntry, STALE_MS, pickRoom } from "../server/matchmaking"

const room = (code: string, players: number, extra: Partial<RoomEntry> = {}): RoomEntry => ({ code, players, phase: "play", private: false, updatedAt: 0, ...extra })

/** Deterministic rand that walks through a fixed sequence. */
function seq(...vals: number[]) {
  let i = 0
  return () => vals[i++ % vals.length]!
}

describe("pickRoom", () => {
  test("picks the fullest public room that still has space", () => {
    expect(pickRoom([room("AAAA", 2), room("BBBB", 5), room("CCCC", 3)])?.code).toBe("BBBB")
  })

  test("skips full and empty rooms, but not ones made with Create game", () => {
    const rooms = [room("PRIV", 9, { private: true }), room("FULL", MAX_PLAYERS), room("NONE", 0), room("OPEN", 1)]
    expect(pickRoom(rooms)?.code).toBe("PRIV")
    expect(pickRoom([room("FULL", MAX_PLAYERS), room("NONE", 0)])).toBeNull()
  })

  test("phase and mode don't matter: the most players wins", () => {
    expect(pickRoom([room("PLAY", 3, { phase: "play", mode: "snd" }), room("ENDS", 4, { phase: "end", mode: "ffa" })])?.code).toBe("ENDS")
    expect(pickRoom([room("PLAY", 5, { phase: "play", mode: "ctf" }), room("ENDS", 4, { phase: "end" })])?.code).toBe("PLAY")
  })

  test("ties go to the room that reported last", () => {
    expect(pickRoom([room("AAAA", 2, { updatedAt: 5 }), room("BBBB", 2, { updatedAt: 9 })])?.code).toBe("BBBB")
  })
})

describe("Matchmaker", () => {
  test("quick join returns the fullest open room", () => {
    const mm = new Matchmaker()
    mm.report({ code: "AAAA", players: 3, phase: "play", private: false }, 0)
    mm.report({ code: "BBBB", players: 6, phase: "play", private: true }, 0)
    mm.report({ code: "CCCC", players: MAX_PLAYERS, phase: "play", private: false }, 0)
    expect(mm.quick(1000)).toBe("BBBB")
  })

  test("creates and reserves a new code when nothing is open", () => {
    const mm = new Matchmaker(seq(0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5))
    mm.report({ code: "AAAA", players: MAX_PLAYERS, phase: "end", private: false }, 0)
    const code = mm.quick(0)
    expect(code).toMatch(new RegExp(`^[${CODE_CHARS}]{4}$`))
    expect(code).not.toBe("AAAA")
    expect(code).not.toMatch(/[IO]/)
    expect(mm.reserved.has(code)).toBe(true)
  })

  test("concurrent quick joins share the reserved code, until it expires", () => {
    const mm = new Matchmaker()
    const a = mm.quick(0)
    expect(mm.quick(100)).toBe(a)
    expect(mm.quick(200)).toBe(a)
    expect(mm.quick(RESERVE_MS + 1)).not.toBe(a)
  })

  test("the reserved room takes over once it reports in", () => {
    const mm = new Matchmaker()
    const a = mm.quick(0)
    mm.report({ code: a, players: 1, phase: "end", private: false }, 50)
    expect(mm.reserved.has(a)).toBe(false)
    expect(mm.quick(RESERVE_MS * 3)).toBe(a)
  })

  test("an empty Create game code isn't handed out, but once people are in it quick join finds it", () => {
    const mm = new Matchmaker()
    const made = mm.create(0)
    expect(mm.quick(10)).not.toBe(made)
    mm.report({ code: made, players: 1, phase: "end", private: true }, 20)
    expect(mm.quick(30)).toBe(made)
  })

  test("stale rooms expire and empty rooms drop out", () => {
    const mm = new Matchmaker()
    mm.report({ code: "OLD", players: 4, phase: "play", private: false }, 0)
    mm.report({ code: "GONE", players: 5, phase: "play", private: false }, 0)
    mm.report({ code: "GONE", players: 0, phase: "end", private: false }, 10)
    expect(mm.rooms.has("GONE")).toBe(false)
    expect(mm.quick(STALE_MS - 1)).toBe("OLD")
    mm.report({ code: "NEW", players: 1, phase: "end", private: false }, STALE_MS)
    expect(mm.quick(STALE_MS + 1)).toBe("NEW")
    expect(mm.rooms.has("OLD")).toBe(false)
  })

  test("stats count players everywhere and games with a free seat", () => {
    const mm = new Matchmaker()
    mm.report({ code: "AAAA", players: 3, phase: "play", private: false }, 0)
    mm.report({ code: "BBBB", players: 2, phase: "end", private: true }, 0)
    mm.report({ code: "CCCC", players: MAX_PLAYERS, phase: "play", private: false }, 0)
    expect(mm.stats(0)).toEqual({ players: 5 + MAX_PLAYERS, games: 2 })
  })
})

describe("quick join under churn", () => {
  test("always the room with the most players, as rooms grow, shrink, change phase and mode", () => {
    const mm = new Matchmaker()
    let t = 0
    const live = new Map<string, { players: number; phase: string; mode: string; private: boolean }>()
    const codes = ["aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff"]
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let step = 0; step < 2000; step++) {
      t += 1000
      const code = codes[Math.floor(rnd() * codes.length)]!
      const r = live.get(code) ?? { players: 0, phase: "play", mode: "ffa", private: rnd() < 0.3 }
      r.players = Math.max(0, Math.min(MAX_PLAYERS, r.players + (rnd() < 0.55 ? 1 : -1)))
      r.phase = rnd() < 0.2 ? "end" : "play"
      r.mode = ["ffa", "tdm", "dom", "snd", "ctf"][Math.floor(rnd() * 5)]!
      live.set(code, r)
      mm.report({ code, ...r }, t)
      // Every live room heartbeats inside the stale window.
      for (const [c, o] of live) if (o.players > 0 && step % 5 === 0) mm.report({ code: c, ...o }, t)
      const open = [...live.entries()].filter(([, o]) => o.players > 0 && o.players < MAX_PLAYERS)
      if (!open.length) continue
      const most = Math.max(...open.map(([, o]) => o.players))
      const got = mm.quick(t)
      expect(live.get(got)?.players).toBe(most)
    }
  })
})
