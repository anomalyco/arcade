import { describe, expect, test } from "bun:test"
import { DT, MIN_FILL } from "../shared/config"
import { getMap } from "../shared/maps"
import { navFor } from "../shared/sim/nav"
import { World } from "../shared/sim/world"
import { intent, liveWorld, place, run } from "./helpers"

describe("rounds", () => {
  test("starting fills the match with bots on even teams", () => {
    const w = new World(3)
    w.addHuman("h", "host")
    expect(w.phase).toBe("lobby")
    w.start("tdm", 3)
    expect(w.phase).toBe("loadout")
    expect(w.players.size).toBe(MIN_FILL)
    const teams = [...w.players.values()].map((p) => p.team)
    expect(teams.filter((t) => t === 0).length).toBe(teams.filter((t) => t === 1).length)
  })

  test("the round ends when one side is left", () => {
    const w = liveWorld(["a", "b"])
    const a = w.players.get("a")!
    w.kill(w.players.get("b")!, a, "pistol")
    w.step()
    expect(w.phase).toBe("over")
    expect(w.wins[w.keyOf(a)]).toBe(1)
  })

  test("a shot kills an enemy in one hit", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 12.5, 12)
    place(w, "b", 12.5, 16)
    run(w, DT, (_, id) => (id === "a" ? intent({ fire: true, aim: Math.PI / 2 }) : intent({})))
    run(w, 0.5, (_, id) => intent({ aim: id === "a" ? Math.PI / 2 : 0 }))
    expect(w.players.get("b")!.alive).toBe(false)
  })

  test("no movement during the loadout phase", () => {
    const w = new World(5)
    w.addHuman("h", "host")
    w.start("tdm", 3)
    const h = w.players.get("h")!
    const x = h.x
    run(w, 1, () => intent({ mx: 1, stance: "run" }))
    expect(w.phase).toBe("loadout")
    expect(h.x).toBe(x)
  })

  test("best of three ends after two wins", () => {
    const w = new World(9)
    w.addHuman("a", "a")
    w.addHuman("b", "b")
    w.start("ffa", 3)
    w.wins = { a: 2 }
    w.roundsPlayed = 2
    expect(w.result()).toEqual({ decided: true, winner: "a" })
  })
})

describe("map", () => {
  const map = getMap("office")
  const nav = navFor(map)

  test("every spawn is walkable and every pair of spawns is connected", () => {
    for (const s of map.spawns) expect(nav.walkable(s)).toBe(true)
    for (const s of map.spawns.slice(1)) expect(nav.path(map.spawns[0]!, s)).not.toBeNull()
  })

  test("no spawn starts in light", () => {
    const w = new World(1)
    w.step()
    for (const s of map.spawns) expect(w.litAt(s.x, s.y)).toBe(false)
  })

  test("light ids match their index and fit the GPU budget with room for flares", () => {
    map.lights.forEach((l, i) => expect(l.id).toBe(i))
    expect(map.lights.length).toBeLessThanOrEqual(24)
  })
})

describe("bots", () => {
  test("a bot-only match plays to a result: kills happen and awards are given", () => {
    const w = new World(42)
    w.start("ffa", 3)
    const events = []
    for (let i = 0; i < 30 * 60 * 12 && w.phase !== "match"; i++) {
      w.step()
      events.push(...w.takeEvents())
    }
    expect(w.phase).toBe("match")
    expect(events.some((e) => e.k === "kill")).toBe(true)
    expect(w.awards.length).toBeGreaterThan(0)
  })

  test("bots move and do not wedge into walls", () => {
    const w = new World(7)
    w.start("tdm", 3)
    for (let i = 0; i < 30 * 40; i++) w.step()
    for (const p of w.players.values()) {
      if (!p.alive) continue
      expect(w.level.solids.some((r) => p.x > r[0] && p.x < r[2] && p.y > r[1] && p.y < r[3])).toBe(false)
    }
  })
})
