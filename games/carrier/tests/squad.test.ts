import { describe, expect, test } from "bun:test"
import { CAPACITY, type Crew, crewCount, createShip, joinCrew, joinShip, joinShipError, leaveCrew, makeCrew, playerOf, scuttle, shipOf, tickCrew } from "../shared/crew"
import { add } from "./crew-helpers"
import { SQUAD, captainShip, kick, kickLeft, kickedFrom, lockError, members, promote, setLock } from "../shared/squad"

const T = 1_000_000

/** A crew with `n` players joined in order (ids 1..n), one ms apart: odd ids on team 0 (ship 1 first), even on team 1. */
function room(n: number): Crew {
  const c = makeCrew(7)
  for (let i = 1; i <= n; i++) expect(joinCrew(c, i, `p${i}`, T + i).error).toBeUndefined()
  return c
}

const ship = (c: Crew, id: number) => shipOf(c, playerOf(c, id)!.ship)!

/** Captains are always aboard their ship; empty ships have none and are unlocked. */
function check(c: Crew): void {
  for (const s of c.ships) {
    const crew = members(c, s)
    if (crew.length === 0) {
      expect(s.captain).toBeNull()
      expect(s.locked).toBe(false)
    } else expect(crew).toContain(s.captain!)
  }
}

describe("captains", () => {
  test("the first player aboard a room-made ship is its captain", () => {
    const c = room(3)
    expect(ship(c, 1).id).toBe(ship(c, 3).id)
    expect(ship(c, 1).captain).toBe(1)
    check(c)
  })

  test("whoever creates a ship captains it (a team short of ships)", () => {
    const c = room(3)
    scuttle(c, 2, T + 5)
    expect(createShip(c, 3, 0, T + 10).error).toBeUndefined()
    expect(ship(c, 3).captain).toBe(3)
    check(c)
  })

  test("when the captain leaves, the longest-serving member takes over", () => {
    const c = room(5)
    const s = ship(c, 1)
    expect(members(c, s)).toEqual([1, 3, 5])
    leaveCrew(c, 1, T + 100)
    expect(s.captain).toBe(3)
    check(c)
    // Moving to another ship is leaving too.
    expect(joinShip(c, 3, 2, T + 200).error).toBeUndefined()
    expect(s.captain).toBe(5)
    expect(ship(c, 3).captain).toBe(3)
    check(c)
  })

  test("an emptied ship has no captain and unlocks; the next to board captains it", () => {
    const c = room(2)
    const s = ship(c, 1)
    setLock(c, 1, true)
    joinCrew(c, 3, "p3", T + 5)
    // Locked: the joiner goes to the team's other ship.
    expect(playerOf(c, 3)!.ship).toBe(2)
    leaveCrew(c, 1, T + 10)
    expect(s.captain).toBeNull()
    expect(s.locked).toBe(false)
    expect(joinShip(c, 3, s.id, T + 20).error).toBeUndefined()
    expect(s.captain).toBe(3)
    check(c)
  })

  test("the captain can promote a member; nobody else can", () => {
    const c = room(3)
    const s = ship(c, 1)
    expect(promote(c, 3, 1).error).toBe("not-captain")
    expect(promote(c, 1, 1).error).toBe("self")
    expect(promote(c, 1, 99).error).toBe("no-player")
    const out = promote(c, 1, 3)
    expect(out.error).toBeUndefined()
    expect(out.events).toEqual([{ k: "captain", ship: s.id, player: 3 }])
    expect(s.captain).toBe(3)
    expect(captainShip(c, 1)).toBeUndefined()
    check(c)
  })

  test("a captain can't promote someone on another ship", () => {
    const c = room(4)
    expect(promote(c, 1, 2).error).toBe("not-member")
  })
})

describe("locks", () => {
  test("only the captain locks; a locked ship takes nobody new, members stay", () => {
    const c = room(4) // team 0: p1, p3 on ship 1; team 1: p2, p4 on ship 3
    const s = ship(c, 1)
    expect(lockError(c, 3)).toBe("not-captain")
    expect(setLock(c, 3, true).error).toBe("not-captain")
    expect(setLock(c, 1, true).events).toEqual([{ k: "lock", ship: s.id, locked: true }])
    expect(s.locked).toBe(true)
    expect(setLock(c, 1, true).events).toEqual([])
    // Auto-assign would put p5 here (team 0's most crewed ship), but skips the locked ship...
    joinCrew(c, 5, "p5", T + 10)
    expect(playerOf(c, 5)!.ship).toBe(2)
    expect(members(c, s)).toEqual([1, 3])
    // ...and JOIN is refused.
    expect(joinShipError(c, 5, s.id)).toBe("locked")
    expect(joinShip(c, 5, s.id, T + 20).error).toBe("locked")
    expect(setLock(c, 1, false).events).toEqual([{ k: "lock", ship: s.id, locked: false }])
    expect(joinShipError(c, 5, s.id)).toBeNull()
    expect(joinShipError(c, 4, s.id)).toBe("unbalanced")
    check(c)
  })

  test("a full ship says full, even when locked", () => {
    const c = room(1)
    const s = ship(c, 1)
    for (let id = 2; id <= CAPACITY; id++) add(c, id, s.id, "pilot", T + id)
    joinCrew(c, 99, "late", T + 50)
    expect(joinShipError(c, 99, s.id)).toBe("ship-full")
    setLock(c, 1, true)
    expect(joinShipError(c, 99, s.id)).toBe("ship-full")
  })
})

describe("kicks", () => {
  test("the captain kicks a member onto the team's other ship, and they can't come back for a while", () => {
    const c = room(5) // team 0: p1, p3, p5 on ship 1
    const s = ship(c, 1)
    expect(kick(c, 3, 1, T + 10).error).toBe("not-captain")
    expect(kick(c, 1, 1, T + 10).error).toBe("self")
    const out = kick(c, 1, 3, T + 10)
    expect(out.error).toBeUndefined()
    expect(out.events[0]).toEqual({ k: "kick", ship: s.id, player: 3, by: 1 })
    expect(playerOf(c, 3)).toMatchObject({ ship: 2, team: s.team })
    expect(kickedFrom(s, 3, T + 11)).toBe(true)
    expect(kickLeft(s, 3, T + 10)).toBe(SQUAD.kickMs / 1000)
    expect(joinShipError(c, 3, s.id, undefined, T + 11)).toBe("kicked")
    expect(joinShip(c, 3, s.id, T + 11).error).toBe("kicked")
    const later = T + 10 + SQUAD.kickMs
    tickCrew(c, later)
    expect(s.bans).toEqual([])
    expect(kickedFrom(s, 3, later)).toBe(false)
    expect(joinShip(c, 3, s.id, later).error).toBeUndefined()
    check(c)
  })

  test("with the team's other ship sunk, the kicked player gets a new ship (and captains it)", () => {
    const c = room(3)
    const s = ship(c, 1)
    scuttle(c, 2, T + 5)
    expect(c.ships.filter((x) => x.team === s.team)).toHaveLength(1)
    expect(kick(c, 1, 3, T + 10).error).toBeUndefined()
    const p3 = playerOf(c, 3)!
    expect(p3.ship).not.toBe(s.id)
    expect(p3.team).toBe(s.team)
    expect(ship(c, 3).captain).toBe(3)
    check(c)
  })

  test("a locked other ship takes a kicked player only when nothing else can; a full one refuses the kick", () => {
    const c = room(3)
    joinShip(c, 3, 2, T + 5)
    joinCrew(c, 4, "p4", T + 6)
    joinCrew(c, 5, "p5", T + 7)
    expect(ship(c, 5).id).toBe(1)
    setLock(c, 3, true)
    expect(kick(c, 1, 5, T + 50).error).toBeUndefined()
    const to = ship(c, 5)
    expect(to.id).toBe(2)
    expect(to.locked).toBe(true)
    check(c)
    for (let id = 20; crewCount(shipOf(c, 2)!) < CAPACITY; id++) add(c, id, 2)
    add(c, 40, 1)
    expect(kick(c, 1, 40, T + 70).error).toBe("fleet-full")
  })

  test("the captain can only kick members of their own ship", () => {
    const c = room(4)
    expect(kick(c, 1, 2, T + 10).error).toBe("not-member")
  })
})
