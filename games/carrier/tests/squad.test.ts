import { describe, expect, test } from "bun:test"
import { CAPACITY, type Crew, crewCount, createShip, joinCrew, joinShip, joinShipError, leaveCrew, makeCrew, playerOf, scuttle, shipOf, tickCrew } from "../shared/crew"
import { add } from "./crew-helpers"
import { SQUAD, captainShip, kick, kickLeft, kickedFrom, lockError, members, promote, setLock } from "../shared/squad"

const T = 1_000_000

/** A crew with `n` players joined in order (ids 1..n), one ms apart: round the four carriers, so ship 1 has p1, p5, p9. */
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
    const c = room(5)
    expect(ship(c, 1).id).toBe(ship(c, 5).id)
    expect(ship(c, 1).captain).toBe(1)
    check(c)
  })

  test("whoever creates a ship captains it (a team without a carrier)", () => {
    const c = room(3)
    scuttle(c, 4, T + 5)
    expect(createShip(c, 3, T + 10).error).toBeUndefined()
    expect(ship(c, 3)).toMatchObject({ captain: 3, team: 3 })
    check(c)
  })

  test("when the captain leaves, the longest-serving member takes over", () => {
    const c = room(9)
    const s = ship(c, 1)
    expect(members(c, s)).toEqual([1, 5, 9])
    leaveCrew(c, 1, T + 100)
    expect(s.captain).toBe(5)
    check(c)
    // Moving to another ship is leaving too.
    expect(joinShip(c, 5, 4, T + 200).error).toBeUndefined()
    expect(s.captain).toBe(9)
    expect(ship(c, 5).captain).toBe(4)
    check(c)
  })

  test("an emptied ship has no captain and unlocks; the next to board captains it", () => {
    const c = room(4)
    const s = ship(c, 1)
    setLock(c, 1, true)
    joinCrew(c, 5, "p5", T + 5)
    // Locked: the joiner goes to the next least crewed carrier.
    expect(playerOf(c, 5)!.ship).toBe(2)
    leaveCrew(c, 1, T + 10)
    expect(s.captain).toBeNull()
    expect(s.locked).toBe(false)
    expect(joinShip(c, 5, s.id, T + 20).error).toBeUndefined()
    expect(s.captain).toBe(5)
    check(c)
  })

  test("the captain can promote a member; nobody else can", () => {
    const c = room(5)
    const s = ship(c, 1)
    expect(promote(c, 5, 1).error).toBe("not-captain")
    expect(promote(c, 1, 1).error).toBe("self")
    expect(promote(c, 1, 99).error).toBe("no-player")
    const out = promote(c, 1, 5)
    expect(out.error).toBeUndefined()
    expect(out.events).toEqual([{ k: "captain", ship: s.id, player: 5 }])
    expect(s.captain).toBe(5)
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
    const c = room(5) // p1, p5 on ship 1; p2, p3, p4 helm ships 2, 3, 4
    const s = ship(c, 1)
    expect(lockError(c, 5)).toBe("not-captain")
    expect(setLock(c, 5, true).error).toBe("not-captain")
    expect(setLock(c, 1, true).events).toEqual([{ k: "lock", ship: s.id, locked: true }])
    expect(s.locked).toBe(true)
    expect(setLock(c, 1, true).events).toEqual([])
    // Auto-assign skips the locked ship...
    joinCrew(c, 6, "p6", T + 10)
    expect(playerOf(c, 6)!.ship).toBe(2)
    expect(members(c, s)).toEqual([1, 5])
    // ...and JOIN is refused.
    expect(joinShipError(c, 6, s.id)).toBe("locked")
    expect(joinShip(c, 6, s.id, T + 20).error).toBe("locked")
    expect(setLock(c, 1, false).events).toEqual([{ k: "lock", ship: s.id, locked: false }])
    expect(joinShipError(c, 6, s.id)).toBeNull()
    // Any other carrier's crew may come over: there are no teams to balance.
    expect(joinShipError(c, 4, s.id)).toBeNull()
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

/** Fills ship `id` to capacity with fresh players from `from` up. */
function fill(c: Crew, id: number, from: number): void {
  for (let p = from; crewCount(shipOf(c, id)!) < CAPACITY; p++) add(c, p, id)
}

describe("kicks", () => {
  test("the captain kicks a member onto the least crewed other carrier, an enemy now, banned for a while", () => {
    const c = room(5) // p1, p5 on ship 1
    const s = ship(c, 1)
    expect(kick(c, 5, 1, T + 10).error).toBe("not-captain")
    expect(kick(c, 1, 1, T + 10).error).toBe("self")
    const out = kick(c, 1, 5, T + 10)
    expect(out.error).toBeUndefined()
    expect(out.events[0]).toEqual({ k: "kick", ship: s.id, player: 5, by: 1 })
    expect(playerOf(c, 5)).toMatchObject({ ship: 2, team: 1 })
    expect(kickedFrom(s, 5, T + 11)).toBe(true)
    expect(kickLeft(s, 5, T + 10)).toBe(SQUAD.kickMs / 1000)
    expect(joinShipError(c, 5, s.id, undefined, T + 11)).toBe("kicked")
    expect(joinShip(c, 5, s.id, T + 11).error).toBe("kicked")
    const later = T + 10 + SQUAD.kickMs
    tickCrew(c, later)
    expect(s.bans).toEqual([])
    expect(kickedFrom(s, 5, later)).toBe(false)
    expect(joinShip(c, 5, s.id, later).error).toBeUndefined()
    check(c)
  })

  test("with every other carrier full and a team without one, the kicked player gets a new ship (and captains it)", () => {
    const c = room(1)
    add(c, 5, 1)
    scuttle(c, 2, T + 5)
    fill(c, 3, 20)
    fill(c, 4, 40)
    expect(kick(c, 1, 5, T + 10).error).toBeUndefined()
    expect(ship(c, 5)).toMatchObject({ team: 1, captain: 5, helm: 5 })
    check(c)
  })

  test("a locked other ship takes a kicked player only when nothing else can; a full one refuses the kick", () => {
    const c = room(1)
    add(c, 5, 1)
    add(c, 2, 2)
    setLock(c, 2, true)
    fill(c, 3, 20)
    fill(c, 4, 40)
    expect(kick(c, 1, 5, T + 50).error).toBeUndefined()
    const to = ship(c, 5)
    expect(to.id).toBe(2)
    expect(to.locked).toBe(true)
    check(c)
    fill(c, 2, 60)
    add(c, 80, 1)
    expect(kick(c, 1, 80, T + 70).error).toBe("fleet-full")
  })

  test("the captain can only kick members of their own ship", () => {
    const c = room(4)
    expect(kick(c, 1, 2, T + 10).error).toBe("not-member")
  })
})
