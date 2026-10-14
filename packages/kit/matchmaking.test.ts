import { describe, expect, test } from "bun:test"
import {
  DEFAULT_RESERVE_MS,
  DEFAULT_STALE_MS,
  LOWER_CODE_CHARS,
  SharedMatchmaker,
  UPPER_CODE_CHARS,
  cleanPlayerName,
  pickOpenRoom,
  randomRoomCode,
  type RoomEntry,
} from "./sim/matchmaking"

const entry = (code: string, players: number, extra: Partial<RoomEntry> = {}): RoomEntry => ({
  code,
  players,
  phase: "play",
  private: false,
  updatedAt: 0,
  ...extra,
})

function seq(...vals: number[]) {
  let i = 0
  return () => vals[i++ % vals.length]!
}

describe("SharedMatchmaker & pickOpenRoom", () => {
  test("picks the fullest open room, with optional phase preference, then latest report, then code", () => {
    const publicOpen = (r: RoomEntry) => !r.private && r.players > 0 && r.players < 10
    expect(pickOpenRoom([entry("AAAA", 2), entry("BBBB", 5), entry("CCCC", 3)], publicOpen)?.code).toBe("BBBB")
    expect(pickOpenRoom([entry("AAAA", 2), entry("BBBB", 2, { phase: "waiting" })], publicOpen, "waiting")?.code).toBe("BBBB")
    expect(pickOpenRoom([entry("AAAA", 2, { updatedAt: 5 }), entry("BBBB", 2, { updatedAt: 9 })], publicOpen)?.code).toBe("BBBB")
    expect(pickOpenRoom([entry("BBBB", 2, { updatedAt: 5 }), entry("AAAA", 2, { updatedAt: 5 })], publicOpen)?.code).toBe("AAAA")
  })

  test("reserves shared public codes up to capacity, keeps private rooms separate, and prunes stale entries", () => {
    const mm = new SharedMatchmaker({
      maxPlayers: 4,
      rand: seq(0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5),
      randomCode: (r) => randomRoomCode(UPPER_CODE_CHARS, r),
    })
    const a = mm.quick(0)
    expect(a).toMatch(new RegExp(`^[${UPPER_CODE_CHARS}]{4}$`))
    expect(mm.quick(10)).toBe(a)
    expect(mm.quick(20)).toBe(a)
    expect(mm.quick(30)).toBe(a)
    expect(mm.quick(40)).not.toBe(a)
    expect(mm.quick(DEFAULT_RESERVE_MS + 1)).not.toBe(a)

    const priv = mm.create(100)
    mm.report({ code: priv, players: 2, private: true }, 110)
    expect(mm.quick(120)).not.toBe(priv)
    expect(mm.info(priv, 120)).toEqual({ code: priv, players: 2, full: false, live: true })

    mm.report({ code: "LIVE", players: 3, private: false }, 200)
    expect(mm.quick(210)).toBe("LIVE")
    expect(mm.stats(210)).toEqual({ players: 5, games: 1 })
    mm.report({ code: "LIVE", players: 0, private: false }, 220)
    expect(mm.rooms.has("LIVE")).toBe(false)

    mm.report({ code: "STALE", players: 2, private: false }, 0)
    expect(mm.info("STALE", DEFAULT_STALE_MS + 1).live).toBe(false)
  })

  test("cleanPlayerName strips disallowed symbols and falls back when empty", () => {
    expect(cleanPlayerName("  Alice!@#  ", 16, "Driver")).toBe("Alice")
    expect(cleanPlayerName("   ", 16, "Driver")).toBe("Driver")
    expect(randomRoomCode(LOWER_CODE_CHARS, () => 0)).toHaveLength(4)
  })
})
