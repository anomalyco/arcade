import { describe, expect, test } from "bun:test"
import { DT, LOADOUT_SECONDS, ROUND_OVER_SECONDS } from "../shared/config"
import { World } from "../shared/sim/world"
import { buildSnapshot } from "../shared/sim/view"
import { liveWorld, place, run } from "./helpers"

describe("rounds", () => {
  test("a lobby waits for the host; starting fills bots to four", () => {
    const w = new World(3, "tdm", 3)
    w.addHuman("h", "host")
    expect(w.phase).toBe("lobby")
    w.requestStart("tdm", 3)
    expect(w.phase).toBe("loadout")
    expect([...w.players.values()].filter((p) => !p.human)).toHaveLength(3)
    expect(w.players.size).toBe(4)
  })

  test("the round ends when one team is left standing", () => {
    expect(liveWorld(["a", "b"]).players.get("a")!.team).not.toBe(liveWorld(["a", "b"]).players.get("b")!.team)
    const w = liveWorld(["a", "b"])
    const a = w.players.get("a")!
    const red = w.teamKey(a)
    const others = [...w.players.values()].filter((p) => w.teamKey(p) !== red && p.inRound)
    for (const p of others) w.kill(p, a, "pistol")
    run(w, DT * 2)
    expect(w.phase).toBe("over")
    expect(w.wins[red]).toBe(1)
  })

  test("a mid-round joiner spectates and sees no living player", () => {
    const w = liveWorld(["a", "b"])
    w.addHuman("late", "late")
    const late = w.players.get("late")!
    expect(late.alive).toBe(false)
    const snap = buildSnapshot(w, "late", 0)
    expect(snap.you?.alive).toBe(false)
    expect(snap.others).toHaveLength(0)
  })

  test("loadout freezes movement until the round is live", () => {
    const w = new World(5, "tdm", 3)
    w.addHuman("h", "host")
    w.startMatch("tdm", 3)
    const h = place(w, "h", 3, 2)
    run(w, 1, () => ({ mx: 1, my: 0, stance: "run", aim: 0, fire: false, reload: false, gadget: -1, tx: 0, ty: 0, use: false }))
    expect(w.phase).toBe("loadout")
    expect(h.x).toBeCloseTo(3, 0)
    expect(LOADOUT_SECONDS).toBeGreaterThan(0)
    expect(ROUND_OVER_SECONDS).toBeGreaterThan(0)
  })
})

describe("bots", () => {
  test("a bot-only match runs to a result without errors and produces awards", () => {
    const w = new World(42, "ffa", 3)
    w.requestStart("ffa", 3)
    let ticks = 0
    const limit = 30 * 60 * 15
    while (w.phase !== "match" && w.phase !== "lobby" && ticks < limit) {
      w.step()
      ticks++
    }
    expect(w.phase === "match" || w.phase === "lobby").toBe(true)
    expect(w.roundsPlayed).toBeGreaterThan(0)
    const events = w.takeEvents()
    expect(events.some((e) => e.k === "kill")).toBe(true)
    expect(w.awards().length).toBeGreaterThan(0)
  })
})
