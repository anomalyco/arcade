import { catapultTime } from "../shared/launch"
import { describe, expect, test } from "bun:test"
import {
  CAPACITY,
  CREW,
  type Crew,
  type Role,
  createShip,
  createShipError,
  crewCount,
  crewName,
  ensureFleet,
  joinCrew,
  joinShip,
  launch,
  leaveCrew,
  makeCrew,
  playerOf,
  randomCode,
  recover,
  roleOf,
  roomCode,
  runOp,
  scuttle,
  shipName,
  shipOf,
  shipOfPlayer,
  slotReady,
  spawnAt,
  takeHelm,
  teamCss,
  tickCrew,
} from "../shared/crew"
import { OPS, makeSlots } from "../shared/ops"
import { kick, promote, setLock } from "../shared/squad"
import { add, place } from "./crew-helpers"

/** Every invariant the room relies on, checked after each step of the tests. */
function check(c: Crew): void {
  for (const s of c.ships) {
    expect(crewCount(s)).toBeLessThanOrEqual(CAPACITY)
    expect(s.aircraft.length).toBeGreaterThanOrEqual(makeSlots().length)
    expect(s.aircraft.filter((a) => a.op === "hornet").length).toBeGreaterThanOrEqual(CREW.aircraft)
    expect(s.emptySince === null).toBe(crewCount(s) > 0)
    if (s.helm !== null) expect(playerOf(c, s.helm)).toMatchObject({ ship: s.id, role: "helm", plane: -1, mount: -1, team: s.team })
    for (const id of s.pilots) {
      const p = playerOf(c, id)!
      expect(p).toMatchObject({ ship: s.id, team: s.team })
      expect(p.role === "pilot" || p.role === "gunner").toBe(true)
    }
    s.aircraft.forEach((a, i) => {
      if (a.pilot === null) return
      expect(s.pilots).toContain(a.pilot)
      expect(playerOf(c, a.pilot)).toMatchObject({ plane: i, role: "pilot" })
    })
    // One gunner per mount.
    const mounts = c.players.filter((p) => p.ship === s.id && p.role === "gunner").map((p) => p.mount)
    expect(new Set(mounts).size).toBe(mounts.length)
  }
  for (const p of c.players) {
    const s = shipOf(c, p.ship)!
    expect(s).toBeDefined()
    if (p.role === "helm") expect(s.helm).toBe(p.id)
    else expect(s.pilots).toContain(p.id)
    if (p.plane >= 0) expect(s.aircraft[p.plane]!.pilot).toBe(p.id)
    if (p.role === "gunner") expect(p.mount).toBeGreaterThanOrEqual(0)
    else expect(p.mount).toBe(-1)
  }
  for (const s of c.ships) {
    if (crewCount(s) === 0) expect(s).toMatchObject({ captain: null, locked: false })
    else expect(playerOf(c, s.captain!)?.ship).toBe(s.id)
  }
  // Every carrier is its own team: one ship per team at most, each in range.
  const teams = c.ships.map((s) => s.team)
  expect(new Set(teams).size).toBe(teams.length)
  for (const t of teams) expect(t >= 0 && t < CREW.ships).toBe(true)
}

function room(n: number, now = 0): Crew {
  const c = makeCrew(42)
  for (let i = 1; i <= n; i++) expect(joinCrew(c, i, `p${i}`, now).error).toBeUndefined()
  check(c)
  return c
}

const role = (c: Crew, id: number): Role => roleOf(playerOf(c, id)!)
/** The ship on team `team`, by id. */
const teamShip = (c: Crew, team: number) => c.ships.find((s) => s.team === team)?.id

describe("the room", () => {
  test("32 players: 4 carriers, each its own team, 8 aboard", () => {
    expect(CREW.roomMax).toBe(32)
    expect(CREW.ships).toBe(4)
    expect(CAPACITY).toBe(8)
    expect(CREW.ships * CAPACITY).toBe(CREW.roomMax)
  })

  test("every carrier has its own distinct colour", () => {
    const colours = Array.from({ length: CREW.ships }, (_, t) => teamCss(t))
    expect(new Set(colours).size).toBe(CREW.ships)
    for (const css of colours) expect(css).toMatch(/^#[0-9a-f]{6}$/)
    expect(teamCss(CREW.ships)).toBe(teamCss(undefined))
  })

  test("the first join brings out every carrier, one per team; the first player helms team 0's", () => {
    const c = makeCrew(1)
    const out = joinCrew(c, 1, "ada", 0)
    expect(out.events.map((e) => e.k)).toEqual(["new", "new", "new", "new", "join", "captain", "helm"])
    expect(c.ships.map((s) => [s.id, s.team])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [4, 3],
    ])
    expect(c.ships[0]!.helm).toBe(1)
    check(c)
  })

  test("joiners go to the least crewed ship with room, so the first four each get a carrier: 1v1v1v1", () => {
    const c = room(5)
    expect([1, 2, 3, 4].map((id) => playerOf(c, id))).toMatchObject([
      { team: 0, ship: 1, role: "helm" },
      { team: 1, ship: 2, role: "helm" },
      { team: 2, ship: 3, role: "helm" },
      { team: 3, ship: 4, role: "helm" },
    ])
    expect(playerOf(c, 5)).toMatchObject({ team: 0, ship: 1, role: "pilot", plane: -1 })
    // Nothing launches by itself.
    expect(tickCrew(c, 10_000).events).toEqual([])
    check(c)
  })

  test("filling the room: carriers within one of each other, then all 8", () => {
    const c = makeCrew(3)
    for (let i = 1; i <= CREW.roomMax; i++) {
      expect(joinCrew(c, i, "x", 0).error).toBeUndefined()
      const n = c.ships.map(crewCount)
      expect(Math.max(...n) - Math.min(...n)).toBeLessThanOrEqual(1)
      check(c)
    }
    expect(c.ships.map(crewCount)).toEqual([8, 8, 8, 8])
    expect(c.ships.every((s) => s.helm !== null)).toBe(true)
    expect(joinCrew(c, 999, "x", 0).error).toBe("room-full")
    expect(joinCrew(c, 1, "again", 0).error).toBe("joined")
  })

  test("locked ships are skipped; a full ship takes no one", () => {
    const c = room(4)
    setLock(c, 1, true)
    joinCrew(c, 5, "p5", 0)
    expect(playerOf(c, 5)).toMatchObject({ team: 1, ship: 2, role: "pilot" })
    for (let i = 10; i < 10 + CAPACITY - 1; i++) add(c, i, 3)
    expect(crewCount(shipOf(c, 3)!)).toBe(CAPACITY)
    expect(joinShip(c, 5, 3, 0).error).toBe("ship-full")
    check(c)
  })

  test("names are cleaned", () => {
    expect(crewName("  <b>Ada</b>   Lovelace the Great ")).toBe("bAda/b Lovelace")
    expect(crewName("")).toBe("SAILOR")
    expect(crewName(null)).toBe("SAILOR")
  })
})

describe("helm and pilots", () => {
  /** p1 helms ship 1 with p3 aboard (p2 helms ship 2). */
  const pair = () => {
    const c = room(2)
    add(c, 3, 1)
    return c
  }

  test("pilots launch from the menu: at most CREW.aircraft Hornets at once, a destroyed jet's slot recharges", () => {
    const c = room(1)
    const s = c.ships[0]!
    for (let i = 2; i <= 5; i++) add(c, i, s.id)
    expect(runOp(c, 2, "hornet", 10).events).toEqual([{ k: "launch", player: 2, ship: s.id, slot: 0 }])
    // One catapult per ship: the next jet goes once the first has left the bow.
    expect(runOp(c, 3, "hornet", 20).error).toBe("catapult-busy")
    const cat = 10 + catapultTime("hornet") * 1000
    expect(runOp(c, 3, "hornet", cat).events).toEqual([{ k: "launch", player: 3, ship: s.id, slot: 1 }])
    expect(runOp(c, 2, "hornet", cat).error).toBe("flying")
    expect(runOp(c, 4, "hornet", cat).error).toBe("in-use")
    expect(playerOf(c, 3)).toMatchObject({ plane: 1, sortie: 1 })
    check(c)
    const out = recover(c, 2, "crashed", 1000)
    expect(out.events).toEqual([{ k: "recover", player: 2, ship: s.id, slot: 0, how: "crashed", readyAt: 1000 + CREW.recharge }])
    expect(slotReady(s.aircraft[0]!, 1000)).toBe(false)
    expect(runOp(c, 4, "hornet", 1000 + CREW.recharge - 1).error).toBe("recharging")
    expect(runOp(c, 4, "hornet", 1000 + CREW.recharge).events).toEqual([{ k: "launch", player: 4, ship: s.id, slot: 0 }])
    expect(recover(c, 3, "landed", 30_000).events).toEqual([{ k: "recover", player: 3, ship: s.id, slot: 1, how: "landed", readyAt: 30_000 }])
    expect(recover(c, 3, "landed", 30_000).error).toBe("not-flying")
    expect(runOp(c, 5, "hornet", 40_000).error).toBeUndefined()
    check(c)
  })

  test("the helm hands off by launching; a pilot on deck takes the free helm", () => {
    const c = pair()
    expect(runOp(c, 3, "helm", 0).error).toBe("helm-taken")
    expect(runOp(c, 1, "helm", 0).error).toBe("at-helm")
    expect(runOp(c, 1, "nope", 0).error).toBe("bad-op")
    expect(runOp(c, 1, "hornet", 0).events).toEqual([
      { k: "helm", ship: 1, player: null },
      { k: "launch", player: 1, ship: 1, slot: 0 },
    ])
    expect(playerOf(c, 1)).toMatchObject({ role: "pilot", plane: 0, sortie: 1 })
    expect(runOp(c, 3, "helm", 5).events).toEqual([{ k: "helm", ship: 1, player: 3 }])
    expect(runOp(c, 1, "helm", 5).error).toBe("flying")
    check(c)
  })

  test("taking the helm or launching keeps the captaincy", () => {
    const c = pair()
    const ship = shipOfPlayer(c, 1)!
    expect(ship.captain).toBe(1)
    runOp(c, 1, "hornet", 0)
    recover(c, 1, "landed", 1)
    expect(runOp(c, 3, "helm", 2).error).toBeUndefined()
    expect(ship.captain).toBe(1)
    leaveCrew(c, 3, 3)
    runOp(c, 1, "helm", 4)
    expect(ship).toMatchObject({ captain: 1, helm: 1 })
    check(c)
  })

  test("a helm can't launch while every slot recharges; the reconnect hand-off waits on deck", () => {
    const c = room(1)
    const a = shipOfPlayer(c, 1)!
    for (const x of a.aircraft) x.readyAt = 50_000
    expect(runOp(c, 1, "hornet", 1000).error).toBe("recharging")
    launch(c, 1, 1000)
    expect(playerOf(c, 1)).toMatchObject({ role: "pilot", plane: -1 })
    expect(a.helm).toBeNull()
    expect(runOp(c, 1, "hornet", 50_000).events).toEqual([{ k: "launch", player: 1, ship: a.id, slot: 0 }])
    check(c)
  })

  test("leaving vacates the helm, or frees the plane slot; an emptied ship stays afloat", () => {
    const c = pair()
    runOp(c, 3, "hornet", 0)
    expect(leaveCrew(c, 3, 5).events).toEqual([{ k: "leave", player: 3, ship: 1, plane: 0 }])
    expect(shipOf(c, 1)!.aircraft.every((a) => slotReady(a, 5))).toBe(true)
    expect(shipOf(c, 1)!.pilots).toEqual([])
    expect(leaveCrew(c, 1, 5).events).toEqual([
      { k: "leave", player: 1, ship: 1, plane: -1 },
      { k: "helm", ship: 1, player: null },
      { k: "captain", ship: 1, player: null },
    ])
    expect(shipOf(c, 1)!.emptySince).toBe(5)
    // Every carrier stays afloat, crewed or not.
    expect(tickCrew(c, 5 + 3_600_000).events).toEqual([])
    expect(c.ships.map((s) => s.id)).toEqual([1, 2, 3, 4])
    check(c)
  })
})

describe("ships", () => {
  test("boarding another ship: its free helm, else as a pilot; or as asked", () => {
    const c = room(3)
    expect(joinShip(c, 3, 4, 0).error).toBeUndefined()
    expect(playerOf(c, 3)).toMatchObject({ ship: 4, team: 3, role: "helm" })
    expect(joinShip(c, 3, 4, 0).error).toBe("same-ship")
    expect(joinShip(c, 3, 1, 0, "pilot").error).toBeUndefined()
    expect(playerOf(c, 3)).toMatchObject({ ship: 1, team: 0, role: "pilot", plane: -1 })
    expect(joinShip(c, 3, 1, 0, "helm").error).toBe("same-ship")
    expect(joinShip(c, 3, 4, 0, "helm").error).toBeUndefined()
    expect(joinShip(c, 1, 2, 0, "helm").error).toBe("helm-taken")
    check(c)
  })

  test("joining another carrier changes side with it; only room, locks and bans limit it", () => {
    const c = room(3)
    const out = joinShip(c, 3, 1, 0)
    expect(out.error).toBeUndefined()
    expect(playerOf(c, 3)).toMatchObject({ ship: 1, team: 0, role: "pilot" })
    // Nobody balances the carriers: p2 may leave ship 3 empty and pile onto ship 1 too.
    expect(joinShip(c, 2, 1, 0).error).toBeUndefined()
    expect(crewCount(shipOf(c, 1)!)).toBe(3)
    check(c)
  })

  test("CREATE SHIP only while a team has no carrier (a sunk one being refitted); it takes that team", () => {
    const c = room(4)
    expect(createShipError(c, 3)).toBe("fleet-full")
    expect(createShip(c, 3, 0).error).toBe("fleet-full")
    leaveCrew(c, 2, 0)
    scuttle(c, 2, 1000)
    expect(teamShip(c, 1)).toBeUndefined()
    expect(createShipError(c, 3)).toBeNull()
    const out = createShip(c, 3, 1100)
    expect(out.error).toBeUndefined()
    expect(out.events).toContainEqual({ k: "new", ship: 5, team: 1, by: 3 })
    expect(playerOf(c, 3)).toMatchObject({ role: "helm", team: 1, ship: 5 })
    expect(shipOfPlayer(c, 3)!.captain).toBe(3)
    expect(shipOfPlayer(c, 3)!.name).toMatch(/^CV-\d\d [A-Z]+$/)
    expect(createShipError(c, 1)).toBe("fleet-full")
    check(c)
  })

  test("a crewed ship sunk in battle: its crew moves at once to a replacement on the same team", () => {
    const c = room(1)
    for (let i = 2; i <= 4; i++) add(c, i, 1)
    runOp(c, 2, "hornet", 0)
    runOp(c, 3, "ciws-port", 0)
    setLock(c, 1, true)
    const out = scuttle(c, 1, 1000)
    expect(out.events.slice(0, 2)).toEqual([
      { k: "sink", ship: 1 },
      { k: "new", ship: 5, team: 0, by: null },
    ])
    expect(c.players.every((p) => p.ship === 5 && p.team === 0)).toBe(true)
    // The helm takes the new helm, the gunner is a pilot on deck, the flier keeps flying from the new ship.
    expect(playerOf(c, 1)).toMatchObject({ role: "helm" })
    expect(playerOf(c, 3)).toMatchObject({ role: "pilot", mount: -1 })
    expect(playerOf(c, 2)).toMatchObject({ role: "pilot", sortie: 1 })
    expect(playerOf(c, 2)!.plane).toBeGreaterThanOrEqual(0)
    expect(shipOf(c, 5)).toMatchObject({ captain: 1, locked: false })
    expect(tickCrew(c, 1000 + CREW.refitMs).events).toEqual([])
    check(c)
  })

  test("an empty ship sunk in battle is replaced after the refit", () => {
    const c = room(1)
    expect(scuttle(c, 2, 1000).events).toEqual([{ k: "sink", ship: 2 }])
    expect(teamShip(c, 1)).toBeUndefined()
    expect(tickCrew(c, 1000 + CREW.refitMs - 1).events).toEqual([])
    expect(tickCrew(c, 1000 + CREW.refitMs).events).toEqual([{ k: "new", ship: 5, team: 1, by: null }])
    check(c)
  })

  test("offline spawns: every team apart, in the open water at the origin", () => {
    const at = Array.from({ length: CREW.ships }, (_, t) => spawnAt(t, 0.7))
    for (let i = 0; i < at.length; i++)
      for (let j = i + 1; j < at.length; j++) expect(Math.hypot(at[i]!.x - at[j]!.x, at[i]!.z - at[j]!.z)).toBeGreaterThan(280)
    for (const p of at) expect(Math.hypot(p.x, p.z)).toBeLessThan(600)
    for (const p of at) expect(p.heading).toBe(0.7)
  })

  test("names and hull numbers are deterministic and distinct, CV-07 first", () => {
    expect(shipName(5, 0).hull).toBe(7)
    const names = Array.from({ length: 20 }, (_, i) => shipName(5, i).name)
    expect(new Set(names).size).toBe(20)
    expect(shipName(5, 3)).toEqual(shipName(5, 3))
  })

  test("ensureFleet is idempotent", () => {
    const c = room(1)
    expect(ensureFleet(c, 0)).toEqual([])
    expect(c.ships).toHaveLength(CREW.ships)
  })
})

describe("random sequences", () => {
  test("invariants hold through thousands of random operations", () => {
    let s = 7
    const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
    const c = makeCrew(9)
    let next = 1
    const wants: (Role | undefined)[] = [undefined, "helm", "pilot", "gunner"]
    const opIds = OPS.map((o) => o.id)
    for (let step = 0; step < 4000; step++) {
      const now = step * 1000
      const ids = c.players.map((p) => p.id)
      const id = ids[Math.floor(rand() * ids.length)] ?? 0
      const ship = c.ships[Math.floor(rand() * c.ships.length)]?.id ?? 0
      const other = ids[Math.floor(rand() * ids.length)] ?? 0
      switch (Math.floor(rand() * 14)) {
        case 0:
        case 1:
          joinCrew(c, next++, "x", now)
          break
        case 2:
          leaveCrew(c, id, now)
          break
        case 3:
          takeHelm(c, id, now)
          break
        case 4:
          joinShip(c, id, ship, now, wants[Math.floor(rand() * wants.length)])
          break
        case 5:
          createShip(c, id, now)
          break
        case 6:
          launch(c, id, now)
          break
        case 7:
          recover(c, id, rand() < 0.5 ? "crashed" : "landed", now)
          break
        case 8:
          tickCrew(c, now)
          break
        case 9:
          runOp(c, id, opIds[Math.floor(rand() * opIds.length)]!, now)
          break
        case 10:
          setLock(c, id, rand() < 0.5)
          break
        case 11:
          kick(c, id, other, now)
          break
        case 12:
          promote(c, id, other)
          break
        case 13:
          if (rand() < 0.1 && ship) scuttle(c, ship, now)
          break
      }
      check(c)
    }
  })

  test("a test layout helper keeps the invariants too", () => {
    const c = room(2)
    place(c, 2, 1)
    check(c)
  })
})

describe("room codes", () => {
  test("codes use the unambiguous alphabet and normalise", () => {
    for (let i = 0; i < 200; i++) expect(randomCode()).toMatch(/^[a-hj-km-np-z2-9]{4}$/)
    expect(roomCode(" AB-C9 ")).toBe("abc9")
    expect(roomCode("x")).toBeNull()
  })
})
