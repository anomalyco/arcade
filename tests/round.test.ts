import { describe, expect, test } from "bun:test"
import { DT, MIN_FILL } from "../shared/config"
import { World } from "../shared/sim/world"
import { intent, liveWorld, place, run, testMap } from "./helpers"

describe("rounds", () => {
  test("starting fills the match with bots on even teams", () => {
    const w = new World(3, testMap())
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

  test("one shot kills", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 15, 4)
    place(w, "b", 15, 9)
    run(w, DT, (_, id) => (id === "a" ? intent({ fire: true, aim: Math.PI / 2 }) : intent({})))
    run(w, 0.5, (_, id) => intent({ aim: id === "a" ? Math.PI / 2 : 0 }))
    expect(w.players.get("b")!.alive).toBe(false)
  })

  test("no movement during the loadout phase", () => {
    const w = new World(5, testMap())
    w.addHuman("h", "host")
    w.start("tdm", 3)
    const h = w.players.get("h")!
    const x = h.x
    run(w, 1, () => intent({ mx: 1, stance: "run" }))
    expect(w.phase).toBe("loadout")
    expect(h.x).toBe(x)
  })

  test("best of three ends after two wins", () => {
    const w = new World(9, testMap())
    w.addHuman("a", "a")
    w.addHuman("b", "b")
    w.start("ffa", 3)
    w.wins = { a: 2 }
    w.roundsPlayed = 2
    expect(w.result()).toEqual({ decided: true, winner: "a" })
  })

  test("every round is a new procedural floor", () => {
    const w = new World(21)
    w.addHuman("a", "a")
    w.start("tdm", 3)
    const first = w.map.seed
    w.wins = {}
    for (let i = 0; i < 30 * 400 && w.roundNo < 2; i++) w.step()
    expect(w.roundNo).toBe(2)
    expect(w.map.seed).not.toBe(first)
  })
})

describe("bots", () => {
  test("a bot-only match on procedural floors plays to a result with kills and awards", () => {
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

  test("bots never end up inside solids", () => {
    const w = new World(7)
    w.start("tdm", 3)
    for (let i = 0; i < 30 * 50; i++) {
      w.step()
      for (const p of w.players.values()) {
        if (!p.alive) continue
        const inside = w.level.solids.some((r) => p.x > r[0] + 0.02 && p.x < r[2] - 0.02 && p.y > r[1] + 0.02 && p.y < r[3] - 0.02)
        expect(inside).toBe(false)
      }
    }
  })
})
