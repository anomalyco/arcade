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
  teamCount,
  teamShips,
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
  for (let t = 0; t < CREW.teams; t++) {
    expect(teamShips(c, t).length).toBeLessThanOrEqual(CREW.shipsPerTeam)
    const slots = teamShips(c, t).map((s) => s.slot)
    expect(new Set(slots).size).toBe(slots.length)
  }
}

function room(n: number, now = 0): Crew {
  const c = makeCrew(42)
  for (let i = 1; i <= n; i++) expect(joinCrew(c, i, `p${i}`, now).error).toBeUndefined()
  check(c)
  return c
}

const role = (c: Crew, id: number): Role => roleOf(playerOf(c, id)!)
const ships = (c: Crew, team: number) => teamShips(c, team).map((s) => s.id)

describe("the room", () => {
  test("32 players: 2 teams x 2 ships x 8 aboard", () => {
    expect(CREW.roomMax).toBe(32)
    expect(CREW.shipsPerTeam).toBe(2)
    expect(CAPACITY).toBe(8)
    expect(CREW.teams * CREW.shipsPerTeam * CAPACITY).toBe(CREW.roomMax)
  })

  test("the first join brings out both teams' ships; the first player helms team 0's first", () => {
    const c = makeCrew(1)
    const out = joinCrew(c, 1, "ada", 0)
    expect(out.events.map((e) => e.k)).toEqual(["new", "new", "new", "new", "join", "captain", "helm"])
    expect(ships(c, 0)).toEqual([1, 2])
    expect(ships(c, 1)).toEqual([3, 4])
    expect(c.ships[0]!.helm).toBe(1)
    check(c)
  })

  test("joiners go to the smaller team's most crewed ship with room, taking a free helm", () => {
    const c = room(4)
    expect(playerOf(c, 2)).toMatchObject({ team: 1, ship: 3, role: "helm" })
    expect(playerOf(c, 3)).toMatchObject({ team: 0, ship: 1, role: "pilot", plane: -1 })
    expect(playerOf(c, 4)).toMatchObject({ team: 1, ship: 3, role: "pilot" })
    // Nothing launches by itself.
    expect(tickCrew(c, 10_000).events).toEqual([])
    check(c)
  })

  test("filling the room: teams within one, the first ships fill to 8, then the second ones", () => {
    const c = makeCrew(3)
    for (let i = 1; i <= CREW.roomMax; i++) {
      expect(joinCrew(c, i, "x", 0).error).toBeUndefined()
      expect(Math.abs(teamCount(c, 0) - teamCount(c, 1))).toBeLessThanOrEqual(1)
      check(c)
      if (i === 16) expect(c.ships.map(crewCount)).toEqual([8, 0, 8, 0])
    }
    expect(c.ships.map(crewCount)).toEqual([8, 8, 8, 8])
    expect(c.ships.every((s) => s.helm !== null)).toBe(true)
    expect(joinCrew(c, 999, "x", 0).error).toBe("room-full")
    expect(joinCrew(c, 1, "again", 0).error).toBe("joined")
  })

  test("locked ships are skipped; a full ship takes no one", () => {
    const c = room(2)
    setLock(c, 1, true)
    joinCrew(c, 3, "p3", 0)
    expect(playerOf(c, 3)).toMatchObject({ team: 0, ship: 2, role: "helm" })
    for (let i = 10; i < 10 + CAPACITY - 1; i++) add(c, i, 3)
    expect(crewCount(shipOf(c, 3)!)).toBe(CAPACITY)
    expect(joinShip(c, 3, 3, 0).error).toBe("ship-full")
    check(c)
  })

  test("names are cleaned", () => {
    expect(crewName("  <b>Ada</b>   Lovelace the Great ")).toBe("bAda/b Lovelace")
    expect(crewName("")).toBe("SAILOR")
    expect(crewName(null)).toBe("SAILOR")
  })
})

describe("helm and pilots", () => {
  /** p1 helms ship 1 with p3 aboard (p2 helms team 1's ship 3). */
  const pair = () => room(3)

  test("pilots launch from the menu: at most CREW.aircraft Hornets at once, a destroyed jet's slot recharges", () => {
    const c = room(1)
    const s = c.ships[0]!
    for (let i = 2; i <= 5; i++) add(c, i, s.id)
    expect(runOp(c, 2, "hornet", 10).events).toEqual([{ k: "launch", player: 2, ship: s.id, slot: 0 }])
    expect(runOp(c, 3, "hornet", 10).events).toEqual([{ k: "launch", player: 3, ship: s.id, slot: 1 }])
    expect(runOp(c, 2, "hornet", 10).error).toBe("flying")
    expect(runOp(c, 4, "hornet", 10).error).toBe("in-use")
    expect(playerOf(c, 3)).toMatchObject({ plane: 1, sortie: 1 })
    check(c)
    const out = recover(c, 2, "crashed", 1000)
    expect(out.events).toEqual([{ k: "recover", player: 2, ship: s.id, slot: 0, how: "crashed", readyAt: 1000 + CREW.recharge }])
    expect(slotReady(s.aircraft[0]!, 1000)).toBe(false)
    expect(runOp(c, 4, "hornet", 1000 + CREW.recharge - 1).error).toBe("recharging")
    expect(runOp(c, 4, "hornet", 1000 + CREW.recharge).events).toEqual([{ k: "launch", player: 4, ship: s.id, slot: 0 }])
    expect(recover(c, 3, "landed", 30_000).events).toEqual([{ k: "recover", player: 3, ship: s.id, slot: 1, how: "landed", readyAt: 30_000 }])
    expect(recover(c, 3, "landed", 30_000).error).toBe("not-flying")
    expect(runOp(c, 5, "hornet", 30_000).error).toBeUndefined()
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
    // The team keeps its two ships, crewed or not.
    expect(tickCrew(c, 5 + 10 * CREW.emptyMs).events).toEqual([])
    expect(ships(c, 0)).toEqual([1, 2])
    check(c)
  })
})

describe("ships", () => {
  test("boarding another ship: its free helm, else as a pilot; or as asked", () => {
    const c = room(3)
    expect(joinShip(c, 3, 2, 0).error).toBeUndefined()
    expect(playerOf(c, 3)).toMatchObject({ ship: 2, role: "helm" })
    expect(joinShip(c, 3, 2, 0).error).toBe("same-ship")
    expect(joinShip(c, 3, 1, 0, "pilot").error).toBeUndefined()
    expect(playerOf(c, 3)).toMatchObject({ ship: 1, role: "pilot", plane: -1 })
    expect(joinShip(c, 3, 1, 0, "helm").error).toBe("same-ship")
    expect(joinShip(c, 3, 2, 0, "helm").error).toBeUndefined()
    expect(joinShip(c, 1, 2, 0, "helm").error).toBe("helm-taken")
    check(c)
  })

  test("joining a ship on the other team switches team, only while balanced", () => {
    const c = room(3) // team 0: p1, p3; team 1: p2
    expect(joinShip(c, 2, 1, 0).error).toBe("unbalanced") // 3 v 0
    const out = joinShip(c, 3, 3, 0) // 1 v 2
    expect(out.error).toBeUndefined()
    expect(out.events).toContainEqual({ k: "team", player: 3, team: 1 })
    check(c)
  })

  test("CREATE SHIP only while a team is short of ships (a sunk one being refitted)", () => {
    const c = room(4)
    expect(createShipError(c, 3, 0)).toBe("fleet-full")
    expect(createShip(c, 3, 1, 0).error).toBe("fleet-full")
    expect(createShip(c, 3, 7, 0).error).toBe("bad-team")
    scuttle(c, 2, 1000)
    expect(ships(c, 0)).toEqual([1])
    expect(createShipError(c, 3, 0)).toBeNull()
    const out = createShip(c, 3, 0, 1100)
    expect(out.error).toBeUndefined()
    expect(role(c, 3)).toBe("helm")
    expect(shipOfPlayer(c, 3)!.captain).toBe(3)
    expect(shipOfPlayer(c, 3)!.name).toMatch(/^CV-\d\d [A-Z]+$/)
    expect(createShipError(c, 1, 0)).toBe("fleet-full")
    check(c)
  })

  test("a ship sunk in battle: its crew moves to the team's other ship, a replacement comes out after the refit", () => {
    const c = room(1)
    for (let i = 2; i <= 4; i++) add(c, i, 1)
    runOp(c, 2, "hornet", 0)
    runOp(c, 3, "ciws-port", 0)
    const out = scuttle(c, 1, 1000)
    expect(out.events[0]).toEqual({ k: "sink", ship: 1 })
    expect(c.players.every((p) => p.ship === 2)).toBe(true)
    // The helm takes the free helm, the gunner is a pilot on deck, the flier keeps flying from the new ship.
    expect(playerOf(c, 1)).toMatchObject({ role: "helm" })
    expect(playerOf(c, 3)).toMatchObject({ role: "pilot", mount: -1 })
    expect(playerOf(c, 2)!.plane).toBeGreaterThanOrEqual(0)
    check(c)
    expect(tickCrew(c, 1000 + CREW.refitMs - 1).events).toEqual([])
    const refit = tickCrew(c, 1000 + CREW.refitMs)
    expect(refit.events.map((e) => e.k)).toEqual(["new"])
    expect(teamShips(c, 0)).toHaveLength(2)
    check(c)
  })

  test("when the other ship can't take them all, the replacement comes out at once", () => {
    const c = room(1)
    for (let i = 2; i <= CAPACITY; i++) add(c, i, 1)
    for (let i = 20; i < 20 + CAPACITY - 2; i++) add(c, i, 2)
    const out = scuttle(c, 1, 1000)
    expect(out.events.filter((e) => e.k === "new")).toHaveLength(1)
    expect(teamShips(c, 0)).toHaveLength(2)
    expect(crewCount(shipOf(c, 2)!)).toBe(CAPACITY)
    check(c)
  })

  test("ships start in pairs, apart, each team on its own side", () => {
    const at = [0, 1].flatMap((t) => [0, 1].map((s) => spawnAt(t, s, 0)))
    for (let i = 0; i < at.length; i++)
      for (let j = i + 1; j < at.length; j++) expect(Math.hypot(at[i]!.x - at[j]!.x, at[i]!.z - at[j]!.z)).toBeGreaterThan(200)
    expect(at[0]!.x).toBeLessThan(0)
    expect(at[2]!.x).toBeGreaterThan(0)
    for (const p of at) expect(Math.hypot(p.x, p.z)).toBeLessThan(600)
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
    expect(c.ships).toHaveLength(CREW.teams * CREW.shipsPerTeam)
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
          createShip(c, id, Math.floor(rand() * CREW.teams), now)
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
