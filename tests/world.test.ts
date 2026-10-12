import { describe, expect, test } from "bun:test"
import { FILL_TO, GUNS, HEALTH, MATCH_SECONDS, RESPAWN_SECONDS } from "../shared/config"
import { buildSnapshot } from "../shared/sim/view"
import { World } from "../shared/sim/world"
import { place, run, world } from "./helpers"

const east = 0

describe("shooting", () => {
  test("four hits kill and the killer scores", () => {
    const w = world()
    place(w, "a", 15, 10)
    place(w, "b", 20, 10)
    run(w, 1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    const b = w.players.get("b")!
    expect(b.alive).toBe(false)
    expect(w.players.get("a")!.kills).toBe(1)
    expect(Math.ceil(HEALTH / GUNS.rifle.damage)).toBe(4)
  })

  test("the sniper kills in one shot and the shotgun in one pump up close", () => {
    for (const gun of ["sniper", "shotgun"] as const) {
      const w = world()
      w.pickGun("a", gun)
      w.spawn(w.players.get("a")!)
      place(w, "a", 15, 10)
      place(w, "b", 18, 10)
      w.players.get("a")!.cooldownUntil = 0
      run(w, 0.1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
      expect(w.players.get("b")!.alive).toBe(false)
    }
  })

  test("semi-automatic guns need a fresh trigger press", () => {
    const w = world(["a"])
    w.pickGun("a", "sniper")
    w.spawn(w.players.get("a")!)
    place(w, "a", 15, 10)
    w.players.get("a")!.cooldownUntil = 0
    run(w, 3, () => ({ aim: east, fire: true }))
    expect(w.players.get("a")!.mag).toBe(GUNS.sniper.mag - 1)
  })

  test("walls stop bullets", () => {
    const w = world()
    place(w, "a", 8, 4)
    place(w, "b", 12, 4)
    run(w, 1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    expect(w.players.get("b")!.health).toBe(HEALTH)
  })

  test("the magazine empties and reloads", () => {
    const w = world(["a"])
    place(w, "a", 15, 10)
    run(w, 4, () => ({ aim: east, fire: true }))
    const a = w.players.get("a")!
    expect(a.mag).toBeLessThan(GUNS.rifle.mag)
    expect(w.takeEvents().some((e) => e.k === "reload")).toBe(true)
  })

  test("health regenerates out of combat", () => {
    const w = world()
    place(w, "a", 15, 10)
    place(w, "b", 20, 10)
    w.players.get("a")!.cooldownUntil = 0
    run(w, 0.1, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    const b = w.players.get("b")!
    expect(b.health).toBeLessThan(HEALTH)
    run(w, 7)
    expect(b.health).toBe(HEALTH)
  })
})

describe("deathmatch", () => {
  test("the dead respawn", () => {
    const w = world()
    const a = w.players.get("a")!
    const b = w.players.get("b")!
    w.kill(b, a)
    run(w, RESPAWN_SECONDS + 0.2)
    expect(b.alive).toBe(true)
    expect(b.health).toBe(HEALTH)
  })

  test("everyone is in every snapshot", () => {
    const w = world(["a", "b", "c"])
    expect(buildSnapshot(w, "a").players.map((p) => p.id).sort()).toEqual(["a", "b", "c"])
  })

  test("bots keep the room full and leave as humans join", () => {
    const w = new World(1)
    w.addHuman("h1", "one")
    expect(w.players.size).toBe(FILL_TO)
    for (let i = 2; i <= FILL_TO + 1; i++) w.addHuman(`h${i}`, "x")
    expect([...w.players.values()].every((p) => p.human)).toBe(true)
  })

  test("the match ends on time, then a new floor starts with scores reset", () => {
    const w = new World(5)
    w.addHuman("h", "h")
    const first = w.map.seed
    w.players.get("h")!.kills = 3
    for (let i = 0; i < 30 * (MATCH_SECONDS + 1) && w.phase === "play"; i++) w.step()
    expect(w.phase).toBe("end")
    for (let i = 0; i < 30 * 15 && w.phase === "end"; i++) w.step()
    expect(w.phase).toBe("play")
    expect(w.map.seed).not.toBe(first)
    expect(w.players.get("h")!.kills).toBe(0)
  })

  test("bots hunt and kill each other without getting stuck in walls", () => {
    const w = new World(42)
    w.fill()
    let kills = 0
    for (let i = 0; i < 30 * 90; i++) {
      w.step()
      kills += w.takeEvents().filter((e) => e.k === "kill").length
      for (const p of w.players.values()) {
        if (!p.alive) continue
        expect(w.solids.some((r) => p.x > r[0] + 0.02 && p.x < r[2] - 0.02 && p.y > r[1] + 0.02 && p.y < r[3] - 0.02)).toBe(false)
      }
    }
    expect(kills).toBeGreaterThan(3)
  })
})
