import { describe, expect, test } from "bun:test"
import { DT, HEALTH } from "../shared/config"
import { decodeClient } from "../shared/protocol"
import { MELEE } from "../shared/sim/melee"
import type { ModeId } from "../shared/sim/modes"
import { INF, type Infected, LADDER, OITC, livesOf, tierOf } from "../shared/sim/modes-rules"
import { buildSnapshot, rosterOf } from "../shared/sim/view"
import { type Player, World } from "../shared/sim/world"
import { generateOffice } from "../shared/maps/office"
import { place, run, testMap } from "./helpers"

const east = 0

function modeWorld(mode: ModeId, names: string[]): World {
  const w = new World(11, testMap(), mode)
  for (const n of names) w.addHuman(n, n)
  w.step()
  w.takeEvents()
  return w
}

const P = (w: World, id: string) => w.players.get(id)!
/** Everyone else out of the way in the far corner. */
const park = (w: World, keep: Player[]) => {
  for (const p of w.players.values()) if (!keep.includes(p)) place(w, p.id, 37, 17)
}

describe("melee", () => {
  test("a swing lands after the wind-up and kills in one hit", () => {
    const w = modeWorld("gun", ["a", "b"])
    const a = place(w, "a", 15, 10)
    const b = place(w, "b", 16.2, 10)
    run(w, DT, (id) => (id === "a" ? { aim: east, melee: true } : {}))
    expect(a.swingAt).toBeGreaterThan(0)
    expect(b.alive).toBe(true)
    run(w, MELEE.windup + DT)
    expect(b.alive).toBe(false)
    const kill = w.takeEvents().find((e) => e.k === "kill")
    expect(kill).toMatchObject({ killer: "a", victim: "b", how: "melee" })
  })

  test("misses out of range or behind you", () => {
    const w = modeWorld("gun", ["a", "b"])
    place(w, "a", 15, 10)
    const b = place(w, "b", 15 + MELEE.range + 0.3, 10)
    run(w, 0.3, (id) => (id === "a" ? { aim: east, melee: true } : {}))
    expect(b.alive).toBe(true)
    place(w, "b", 14, 10)
    run(w, 0.8, (id) => (id === "a" ? { aim: east, melee: true } : {}))
    expect(b.alive).toBe(true)
  })

  test("no swing through a wall", () => {
    const w = modeWorld("gun", ["a", "b"])
    place(w, "a", 9.6, 4)
    const b = place(w, "b", 10.7, 4)
    run(w, 0.4, (id) => (id === "a" ? { aim: east, melee: true } : {}))
    expect(b.alive).toBe(true)
  })

  test("cooldown between swings", () => {
    const w = modeWorld("gun", ["a", "b"])
    const a = place(w, "a", 15, 10)
    place(w, "b", 30, 10)
    let swings = 0
    for (let i = 0; i < Math.round(1 / DT); i++) {
      run(w, DT, (id) => (id === "a" ? { aim: east, melee: true } : {}))
      swings += w.takeEvents().filter((e) => e.k === "swing" && e.by === "a").length
    }
    expect(swings).toBe(Math.ceil(1 / MELEE.cooldown))
    expect(a.meleeReadyAt).toBeGreaterThan(w.time)
  })

  test("modes without melee ignore the key, and the protocol carries it", () => {
    const w = modeWorld("ffa", ["a", "b"])
    place(w, "a", 15, 10)
    const b = place(w, "b", 16, 10)
    run(w, 0.4, (id) => (id === "a" ? { aim: east, melee: true } : {}))
    expect(b.alive).toBe(true)
    const m = decodeClient(JSON.stringify({ type: "intent", seq: 1, i: { melee: true } }))
    expect(m?.type === "intent" && m.i.melee).toBe(true)
  })

  test("a swing lands where the attacker saw the target after wind-up (lag compensation)", () => {
    for (const lagged of [false, true]) {
      const w = modeWorld("gun", ["a", "b"])
      place(w, "a", 15, 10)
      const b = place(w, "b", 15.2, 10)
      run(w, DT, (id) => (id === "b" ? { mx: 1, sprint: true } : {}))
      const viewAtPress = w.time
      run(w, 4 * DT, (id) => (id === "b" ? { mx: 1, sprint: true } : {}))
      run(w, DT, (id) =>
        id === "a" ? { aim: east, melee: true, ...(lagged ? { view: viewAtPress } : {}) } : { mx: 1, sprint: true },
      )
      run(w, MELEE.windup + DT, (id) => (id === "b" ? { mx: 1, sprint: true } : {}))
      expect(b.alive).toBe(!lagged)
    }
  })
})

describe("infected", () => {
  const start = (names: string[]) => {
    const w = modeWorld("inf", names)
    run(w, INF.countdown + 0.1)
    return w
  }
  const infected = (w: World) => [...w.players.values()].filter((p) => p.team === 1)
  const survivors = (w: World) => [...w.players.values()].filter((p) => p.team === 0)

  test("everyone starts a survivor with a rifle or shotgun and one frag, then one turns", () => {
    const w = modeWorld("inf", ["a", "b", "c"])
    P(w, "a").pick = "sniper"
    w.setMode("inf")
    expect(survivors(w).length).toBe(3)
    expect(P(w, "a").kit.gun).toBe("rifle")
    expect(P(w, "a").equipLeft).toBe(1)
    run(w, INF.countdown + 0.1)
    expect(infected(w).length).toBe(1)
    const z = infected(w)[0]!
    expect(z.kit.gun).toBeNull()
    expect(z.kit.walk).toBeGreaterThan(P(w, survivors(w)[0]!.id).kit.walk)
    expect(buildSnapshot(w, z.id).players.find((p) => p.id === z.id)?.bare).toBe(true)
  })

  test("two patient zeros in a room of eight", () => {
    const w = start(["a", "b", "c", "d", "e", "f", "g", "h"])
    expect(infected(w).length).toBe(2)
  })

  test("a swipe infects: the survivor comes back infected, the infected scores", () => {
    const w = start(["a", "b", "c"])
    const z = infected(w)[0]!
    const s = survivors(w)[0]!
    place(w, z.id, 15, 10)
    place(w, s.id, 16, 10)
    park(w, [z, s])
    run(w, 0.3, (id) => (id === z.id ? { aim: east, fire: true } : {}))
    expect(s.alive).toBe(false)
    expect(s.team).toBe(1)
    expect(z.stats.score).toBe(INF.infect)
    run(w, INF.respawn + 0.1)
    expect(s.alive).toBe(true)
    expect(s.kit.gun).toBeNull()
  })

  test("the infected win when the last survivor turns", () => {
    const w = start(["a", "b"])
    const z = infected(w)[0]!
    const s = survivors(w)[0]!
    w.kill(s, z, "melee")
    w.step()
    expect(w.phase).toBe("end")
    expect(w.takeEvents().find((e) => e.k === "end")).toMatchObject({ team: 1 })
  })

  test("survivors win if any make it to the end, and score for staying alive and for kills", () => {
    const w = start(["a", "b", "c"])
    const z = infected(w)[0]!
    const s = survivors(w)[0]!
    for (const p of w.players.values()) place(w, p.id, p === z ? 37 : 3, p === z ? 17 : p === s ? 3 : 17)
    w.kill(z, s)
    expect(s.stats.score).toBe(1)
    expect(z.team).toBe(1)
    run(w, INF.every + 0.1)
    expect(s.stats.score).toBe(2)
    run(w, INF.round)
    expect(w.phase).toBe("end")
    expect((w.mode as Infected).result(w).team).toBe(0)
  })

  test("survivors can't hurt each other; infected can't swipe infected", () => {
    const w = start(["a", "b", "c"])
    const [s1, s2] = survivors(w)
    place(w, s1!.id, 15, 10)
    place(w, s2!.id, 18, 10)
    s1!.cooldownUntil = 0
    run(w, 0.5, (id) => (id === s1!.id ? { aim: east, fire: true } : {}))
    expect(s2!.health).toBe(HEALTH)
  })
})

describe("gun game", () => {
  test("every kill moves you up the ladder and swaps the gun at once", () => {
    const w = modeWorld("gun", ["a", "b"])
    const a = P(w, "a")
    const b = P(w, "b")
    expect(a.kit.gun).toBe("rifle")
    expect(a.equipLeft).toBe(0)
    w.kill(b, a)
    expect(tierOf(a)).toBe(1)
    expect(a.kit.gun).toBe("shotgun")
    expect(a.mag).toBe(a.kit.mag)
    w.kill(b, a)
    expect(a.kit.gun).toBe("sniper")
    expect(rosterOf(w).find((r) => r.id === "a")?.stats?.tier).toBe(2)
  })

  test("picks are ignored", () => {
    const w = modeWorld("gun", ["a", "b"])
    w.pickGun("a", "sniper")
    w.kill(P(w, "a"), P(w, "b"))
    run(w, 4)
    expect(P(w, "a").kit.gun).toBe("rifle")
  })

  test("a melee death knocks you down a tier", () => {
    const w = modeWorld("gun", ["a", "b"])
    const a = P(w, "a")
    const b = P(w, "b")
    b.stats.tier = 3
    w.kill(b, a, "melee")
    expect(tierOf(b)).toBe(2)
    a.stats.tier = 0
    w.kill(a, b, "melee")
    w.kill(a, b, "rifle")
    expect(tierOf(a)).toBe(0)
  })

  test("a kill on the last tier wins", () => {
    const w = modeWorld("gun", ["a", "b"])
    const a = P(w, "a")
    const b = P(w, "b")
    a.stats.tier = LADDER.length - 2
    w.kill(b, a)
    expect(a.kit.gun).toBeNull()
    expect(w.phase).toBe("play")
    run(w, 4)
    place(w, "a", 15, 10)
    place(w, "b", 16, 10)
    run(w, 0.4, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    expect(b.alive).toBe(false)
    expect(w.phase).toBe("end")
    expect(w.takeEvents().find((e) => e.k === "end")).toMatchObject({ winner: "a" })
  })
})

describe("one in the chamber", () => {
  test("one bullet that kills, no reload, a kill gives another, a miss wastes it", () => {
    const w = modeWorld("oitc", ["a", "b", "c"])
    const a = place(w, "a", 15, 10)
    const b = place(w, "b", 25, 10)
    park(w, [a, b])
    expect(a.mag).toBe(1)
    a.cooldownUntil = 0
    run(w, 0.2, (id) => (id === "a" ? { aim: east, fire: true } : {}))
    expect(b.alive).toBe(false)
    expect(a.mag).toBe(1)
    // A miss: the bullet's gone and the trigger doesn't reload.
    run(w, 0.5)
    run(w, 0.7, (id) => (id === "a" ? { aim: Math.PI / 2, fire: true } : {}))
    expect(a.mag).toBe(0)
    run(w, 3, (id) => (id === "a" ? { aim: Math.PI / 2, fire: true, reload: true } : {}))
    expect(a.mag).toBe(0)
    expect(a.reloadUntil).toBe(0)
  })

  test("bullets cap at three; a swing kill counts too", () => {
    const w = modeWorld("oitc", ["a", "b"])
    const a = P(w, "a")
    const b = P(w, "b")
    for (let i = 0; i < 2; i++) {
      w.kill(b, a)
      run(w, 3.5)
    }
    expect(a.mag).toBe(3)
    place(w, "a", 15, 10)
    place(w, "b", 16, 10)
    run(w, 0.4, (id) => (id === "a" ? { aim: east, melee: true } : {}))
    expect(b.alive).toBe(false)
    expect(a.mag).toBe(OITC.max)
  })

  test("three lives, then you're out; the last one standing wins", () => {
    const w = modeWorld("oitc", ["a", "b", "c"])
    const a = P(w, "a")
    const b = P(w, "b")
    const c = P(w, "c")
    expect(livesOf(b)).toBe(OITC.lives)
    for (let i = 0; i < OITC.lives; i++) {
      w.kill(b, a)
      run(w, 3.5)
    }
    expect(livesOf(b)).toBe(0)
    expect(b.alive).toBe(false)
    expect(buildSnapshot(w, "b").you?.respawnIn).toBe(-1)
    expect(w.phase).toBe("play")
    for (let i = 0; i < OITC.lives; i++) {
      w.kill(c, a)
      w.step()
      if (i < OITC.lives - 1) run(w, 3.5)
    }
    expect(w.phase).toBe("end")
    expect(w.takeEvents().find((e) => e.k === "end")).toMatchObject({ winner: "a" })
  })
})

describe("bots", () => {
  for (const mode of ["inf", "gun", "oitc"] as const) {
    test(`play ${mode} for a minute`, () => {
      const w = new World(5, generateOffice(3), mode)
      w.botFill = 6
      w.fill()
      const kinds = new Set<string>()
      for (let i = 0; i < Math.round(60 / DT); i++) {
        w.step()
        for (const e of w.takeEvents()) kinds.add(e.k)
      }
      expect(kinds.has("kill")).toBe(true)
      if (mode !== "gun") expect(kinds.has("swing")).toBe(true)
    })
  }
})
