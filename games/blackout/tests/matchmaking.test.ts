import { describe, expect, test } from "bun:test"
import { MAX_PLAYERS } from "../shared/config"
import { CODE_CHARS } from "../shared/protocol"
import { Matchmaker, RESERVE_MS, type RoomEntry, STALE_MS, pickRoom } from "../server/matchmaking"

const room = (code: string, players: number, extra: Partial<RoomEntry> = {}): RoomEntry => ({ code, players, phase: "play", private: false, updatedAt: 0, ...extra })

describe("Blackout matchmaking policy", () => {
  test("fills any non-full room with players, including populated Create Game rooms", () => {
    expect(pickRoom([room("AAAA", 2), room("BBBB", 5), room("CCCC", 3)])?.code).toBe("BBBB")
    expect(pickRoom([room("PRIV", 9, { private: true }), room("FULL", MAX_PLAYERS), room("NONE", 0), room("OPEN", 1)])?.code).toBe("PRIV")
  })

  test("reserves 4-char lowercase codes and finds populated rooms under churn", () => {
    const mm = new Matchmaker()
    const made = mm.create(0)
    expect(made).toMatch(new RegExp(`^[${CODE_CHARS}]{4}$`))
    expect(mm.quick(10)).not.toBe(made)
    mm.report({ code: made, players: 1, phase: "end", private: true }, 20)
    expect(mm.quick(30)).toBe(made)
    expect(mm.quick(RESERVE_MS * 3)).toBe(made)
    expect(mm.quick(20 + STALE_MS + 1)).not.toBe(made)
  })
})
