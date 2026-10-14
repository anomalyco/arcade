import { describe, expect, test } from "bun:test"
import { MAX_PLAYERS } from "../shared/config"
import { CODE_CHARS } from "../shared/protocol"
import { Matchmaker, RESERVE_MS, type RoomEntry, STALE_MS, pickRoom } from "../server/matchmaking"

const room = (code: string, players: number, extra: Partial<RoomEntry> = {}): RoomEntry => ({ code, players, phase: "chase", private: false, updatedAt: 0, ...extra })

describe("Getaway matchmaking policy", () => {
  test("skips private, full and empty rooms, and prefers waiting rooms on a tie", () => {
    expect(pickRoom([room("AAAA", 2), room("BBBB", 5), room("CCCC", 3)])?.code).toBe("BBBB")
    expect(pickRoom([room("PRIV", 9, { private: true }), room("FULL", MAX_PLAYERS), room("NONE", 0), room("OPEN", 1)])?.code).toBe("OPEN")
    expect(pickRoom([room("AAAA", 2), room("BBBB", 2, { phase: "waiting" })])?.code).toBe("BBBB")
  })

  test("reserves 4-letter uppercase codes, keeps Create Game private, and expires after 120s", () => {
    const mm = new Matchmaker()
    const code = mm.quick(0)
    expect(code).toMatch(new RegExp(`^[${CODE_CHARS}]{4}$`))
    expect(mm.quick(100)).toBe(code)
    expect(mm.quick(RESERVE_MS + 1)).not.toBe(code)
    const priv = mm.create(0)
    mm.report({ code: priv, players: 2, phase: "waiting", private: true }, 20)
    expect(mm.quick(30)).not.toBe(priv)
    mm.report({ code: "OPEN", players: 3, phase: "chase", private: false }, 20)
    expect(mm.stats(20)).toEqual({ players: 5, games: 1 })
    expect(mm.quick(STALE_MS + 21)).not.toBe("OPEN")
  })
})
