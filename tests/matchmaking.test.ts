import { describe, expect, test } from "bun:test"
import { MAX_PLAYERS } from "../shared/config"
import { CODE_CHARS } from "../shared/protocol"
import { Matchmaker, RESERVE_MS, type RoomEntry, STALE_MS, pickRoom } from "../server/matchmaking"

const room = (code: string, players: number, extra: Partial<RoomEntry> = {}): RoomEntry => ({ code, players, phase: "chase", private: false, updatedAt: 0, ...extra })

/** Deterministic rand that walks through a fixed sequence. */
function seq(...vals: number[]) {
  let i = 0
  return () => vals[i++ % vals.length]!
}

describe("pickRoom", () => {
  test("picks the fullest public room that still has space", () => {
    expect(pickRoom([room("AAAA", 2), room("BBBB", 5), room("CCCC", 3)])?.code).toBe("BBBB")
  })

  test("skips private, full and empty rooms", () => {
    const rooms = [room("PRIV", 9, { private: true }), room("FULL", MAX_PLAYERS), room("NONE", 0), room("OPEN", 1)]
    expect(pickRoom(rooms)?.code).toBe("OPEN")
    expect(pickRoom([room("PRIV", 3, { private: true }), room("FULL", MAX_PLAYERS)])).toBeNull()
  })

  test("prefers a waiting room on a tie", () => {
    expect(pickRoom([room("AAAA", 2), room("BBBB", 2, { phase: "waiting" })])?.code).toBe("BBBB")
  })
})

describe("Matchmaker", () => {
  test("quick join returns the fullest open room", () => {
    const mm = new Matchmaker()
    mm.report({ code: "AAAA", players: 3, phase: "chase", private: false }, 0)
    mm.report({ code: "BBBB", players: 6, phase: "chase", private: true }, 0)
    mm.report({ code: "CCCC", players: MAX_PLAYERS, phase: "chase", private: false }, 0)
    expect(mm.quick(1000)).toBe("AAAA")
  })

  test("creates and reserves a new code when nothing is open", () => {
    const mm = new Matchmaker(seq(0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5))
    mm.report({ code: "AAAA", players: 2, phase: "waiting", private: true }, 0)
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
    mm.report({ code: a, players: 1, phase: "waiting", private: false }, 50)
    expect(mm.reserved.has(a)).toBe(false)
    expect(mm.quick(RESERVE_MS * 3)).toBe(a)
  })

  test("create game is private and never handed out by quick join", () => {
    const mm = new Matchmaker()
    const priv = mm.create(0)
    expect(mm.quick(10)).not.toBe(priv)
    mm.report({ code: priv, players: 1, phase: "waiting", private: true }, 20)
    expect(mm.quick(30)).not.toBe(priv)
  })

  test("stale rooms expire and empty rooms drop out", () => {
    const mm = new Matchmaker()
    mm.report({ code: "OLD", players: 4, phase: "chase", private: false }, 0)
    mm.report({ code: "GONE", players: 5, phase: "chase", private: false }, 0)
    mm.report({ code: "GONE", players: 0, phase: "waiting", private: false }, 10)
    expect(mm.rooms.has("GONE")).toBe(false)
    expect(mm.quick(STALE_MS - 1)).toBe("OLD")
    mm.report({ code: "NEW", players: 1, phase: "waiting", private: false }, STALE_MS)
    expect(mm.quick(STALE_MS + 1)).toBe("NEW")
    expect(mm.rooms.has("OLD")).toBe(false)
  })

  test("stats count players everywhere and open public games", () => {
    const mm = new Matchmaker()
    mm.report({ code: "AAAA", players: 3, phase: "chase", private: false }, 0)
    mm.report({ code: "BBBB", players: 2, phase: "waiting", private: true }, 0)
    mm.report({ code: "CCCC", players: MAX_PLAYERS, phase: "chase", private: false }, 0)
    expect(mm.stats(0)).toEqual({ players: 5 + MAX_PLAYERS, games: 1 })
  })
})
