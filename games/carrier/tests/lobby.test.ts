import { describe, expect, test } from "bun:test"
import { Matchmaker, RESERVE_MS, type RoomEntry, STALE_MS, isOpen, pickRoom } from "../server/matchmaking"
import { CREW } from "../shared/crew"

const entry = (code: string, players: number, updatedAt = 0, priv = false): RoomEntry => ({ code, players, private: priv, updatedAt })

/** Deterministic PRNG so codes reproduce. */
function seq(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

describe("open rooms", () => {
  test("only public rooms with people and space are open", () => {
    expect(isOpen(entry("a", 3))).toBe(true)
    expect(isOpen(entry("a", 0))).toBe(false)
    expect(isOpen(entry("a", CREW.roomMax))).toBe(false)
    expect(isOpen(entry("a", 3, 0, true))).toBe(false)
  })

  test("quick join picks the fullest open room, then the latest report, then the code", () => {
    expect(pickRoom([entry("a", 2), entry("b", 7), entry("c", CREW.roomMax), entry("d", 9, 0, true)])?.code).toBe("b")
    expect(pickRoom([entry("a", 4, 1), entry("b", 4, 5)])?.code).toBe("b")
    expect(pickRoom([entry("b", 4, 5), entry("a", 4, 5)])?.code).toBe("a")
    expect(pickRoom([entry("a", CREW.roomMax)])).toBeNull()
  })
})

describe("matchmaker", () => {
  test("quick join goes to a live room, else everyone shares one fresh reservation", () => {
    const mm = new Matchmaker(seq(1))
    const a = mm.quick(0)
    expect(mm.quick(1)).toBe(a)
    expect(mm.quick(2)).toBe(a)
    // Once the reservation lapses without the room reporting, a new one is made.
    expect(mm.quick(RESERVE_MS + 10)).not.toBe(a)
    mm.report({ code: "live", players: 3, private: false }, 100)
    expect(mm.quick(200)).toBe("live")
  })

  test("a reservation is shared only up to the room's capacity", () => {
    const mm = new Matchmaker(seq(2))
    const first = mm.quick(0)
    for (let i = 1; i < CREW.roomMax; i++) expect(mm.quick(0)).toBe(first)
    expect(mm.quick(0)).not.toBe(first)
  })

  test("created rooms are private: quick join never hands them out, even once people are in", () => {
    const mm = new Matchmaker(seq(3))
    const code = mm.create(0)
    expect(mm.quick(1)).not.toBe(code)
    mm.report({ code, players: 2, private: true }, 2)
    const q = mm.quick(3)
    expect(q).not.toBe(code)
    expect(mm.info(code, 3)).toEqual({ code, players: 2, full: false, live: true })
  })

  test("stale and emptied rooms drop out", () => {
    const mm = new Matchmaker(seq(4))
    mm.report({ code: "old", players: 5, private: false }, 0)
    mm.report({ code: "gone", players: 5, private: false }, 0)
    mm.report({ code: "gone", players: 0, private: false }, 10)
    expect(mm.rooms.has("gone")).toBe(false)
    expect(mm.quick(STALE_MS - 1)).toBe("old")
    expect(mm.quick(STALE_MS + 1)).not.toBe("old")
    expect(mm.info("old", STALE_MS + 1).live).toBe(false)
  })

  test("full rooms are reported full and skipped", () => {
    const mm = new Matchmaker(seq(5))
    mm.report({ code: "full", players: CREW.roomMax, private: false }, 0)
    expect(mm.info("full", 1).full).toBe(true)
    expect(mm.quick(1)).not.toBe("full")
  })

  test("handed-out codes are unique among live rooms and reservations", () => {
    // A generator that keeps repeating forces the retry path.
    const vals = [0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5]
    let i = 0
    const mm = new Matchmaker(() => vals[i++ % vals.length]!)
    const a = mm.create(0)
    const b = mm.create(0)
    expect(a).not.toBe(b)
    const many = new Matchmaker(seq(6))
    const codes = new Set<string>()
    for (let k = 0; k < 500; k++) codes.add(many.create(0))
    expect(codes.size).toBe(500)
  })

  test("stats count players and open games", () => {
    const mm = new Matchmaker(seq(7))
    mm.report({ code: "a", players: 3, private: false }, 0)
    mm.report({ code: "b", players: 2, private: true }, 0)
    expect(mm.stats(1)).toEqual({ players: 5, games: 1 })
  })
})
