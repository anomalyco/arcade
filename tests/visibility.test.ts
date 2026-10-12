import { describe, expect, test } from "bun:test"
import { DT, VIEW_RANGE } from "../shared/config"
import { clearLine, rayRect } from "../shared/geom"
import { type Light, isLit, lightAt } from "../shared/sim/light"
import { buildSnapshot, eventsFor } from "../shared/sim/view"
import { getMap } from "../shared/maps"
import { intent, liveWorld, place, run } from "./helpers"

const lamp = (x: number, y: number, on = true): Light => ({ id: 0, kind: "lamp", x, y, radius: 9, power: 1, color: [1, 1, 1], on })

describe("light", () => {
  test("falls off to zero at the radius and needs a clear line", () => {
    const walls: [number, number, number, number][] = [[4, -1, 4.5, 1]]
    const l = lamp(0, 0)
    expect(lightAt(2, 0, [l], [])).toBeGreaterThan(0.3)
    expect(lightAt(9.5, 0, [l], [])).toBe(0)
    expect(lightAt(6, 0, [l], walls)).toBe(0)
    expect(lightAt(6, 3, [l], walls)).toBeGreaterThan(0)
  })

  test("a dark lamp lights nothing", () => {
    expect(isLit(1, 0, [lamp(0, 0, false)], [])).toBe(false)
  })

  test("ray vs rectangle returns the entry distance", () => {
    expect(rayRect(0, 0, 1, 0, [3, -1, 4, 1], 10)).toBeCloseTo(3)
    expect(rayRect(0, 0, 0, 1, [3, -1, 4, 1], 10)).toBe(Infinity)
  })

  test("clearLine detects a wall between two points", () => {
    expect(clearLine(0, 0, 10, 0, [[4, -1, 5, 1]])).toBe(false)
    expect(clearLine(0, 0, 10, 0, [[4, 2, 5, 5]])).toBe(true)
  })
})

describe("visibility rule", () => {
  test("a sneaking player in the dark is hidden, a runner in the dark is seen, a lit walker is seen", () => {
    const w = liveWorld(["a", "b"])
    const a = place(w, "a", 3, 3)
    const b = place(w, "b", 40, 27)
    w.lamps.forEach((l) => (l.dimUntil = 1e9))
    w.doors.forEach((d) => (d.open = false))
    w.rebuildWalls()
    w.walls = [[0, 0, 0, 0]]
    w.lamps.forEach((l) => (l.broken = true))
    run(w, DT, () => intent({ stance: "sneak" }))
    expect(w.canSee(a, b)).toBe(false)
    run(w, 0.2, () => intent({ stance: "run" }))
    expect(b.exposed).toBe(false)
  })

  test("walls block sight even for an exposed player", () => {
    const w = liveWorld(["a", "b"])
    const a = place(w, "a", 3, 3)
    const b = place(w, "b", 10, 3)
    w.walls = [[6, 0, 6.5, 6]]
    w.lamps.forEach((l) => (l.broken = true))
    w.step()
    b.lastRunAt = w.time
    expect(w.canSee(a, b)).toBe(false)
  })

  test("range caps sight", () => {
    const w = liveWorld(["a", "b"])
    const a = place(w, "a", 1, 1)
    const b = place(w, "b", 1 + VIEW_RANGE + 2, 1)
    w.walls = []
    w.lamps.forEach((l) => (l.broken = true))
    b.lastRunAt = w.time
    w.step()
    expect(w.canSee(a, b)).toBe(false)
  })

  test("a player standing in a lamp pool is exposed", () => {
    const w = liveWorld(["a", "b"])
    const lampAt = w.lamps[0]!
    place(w, "a", 1, 1)
    place(w, "b", lampAt.x, lampAt.y)
    w.step()
    expect(w.players.get("b")!.lit).toBe(true)
    expect(w.players.get("b")!.exposed).toBe(true)
  })
})

describe("server-side filtering", () => {
  test("hidden players never appear in the snapshot", () => {
    const w = liveWorld(["a", "b", "c"])
    place(w, "a", 3, 3)
    place(w, "b", 40, 27)
    place(w, "c", 3.5, 3.5)
    w.walls = []
    w.lamps.forEach((l) => (l.broken = true))
    w.step()
    const snap = buildSnapshot(w, "a", 0)
    const ids = snap.others.map((o) => o.id)
    expect(ids).not.toContain("b")
    expect(JSON.stringify(snap)).not.toContain('"x":40')
  })

  test("a dead viewer sees no living players", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 3, 3)
    place(w, "b", w.lamps[0]!.x, w.lamps[0]!.y)
    w.step()
    w.kill(w.players.get("a")!, null, "pistol")
    w.step()
    expect(buildSnapshot(w, "a", 0).others).toHaveLength(0)
  })

  test("the snapshot carries your own full state, but not your hidden position to others", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 3, 3)
    place(w, "b", 4, 3)
    w.step()
    const snap = buildSnapshot(w, "b", 0)
    expect(snap.you?.id).toBe("b")
    expect(snap.others.find((o) => o.id === "a")).toBeUndefined()
  })

  test("tracers are addressed to the shooter only", () => {
    const events = [
      { k: "shot" as const, x0: 0, y0: 0, x1: 1, y1: 0, hit: false, to: ["a"] },
      { k: "ripple" as const, x: 0, y: 0, r: 14, kind: "shot" as const, t: 0 },
    ]
    expect(eventsFor(events, "b").map((e) => e.k)).toEqual(["ripple"])
    expect(eventsFor(events, "a").map((e) => e.k)).toEqual(["shot", "ripple"])
  })
})

describe("maps", () => {
  test("spawns and nav points stand clear of walls", () => {
    const m = getMap("warehouse")
    const inside = (x: number, y: number) => m.walls.some((r) => x > r[0] - 0.34 && x < r[2] + 0.34 && y > r[1] - 0.34 && y < r[3] + 0.34)
    for (const s of m.spawns) expect(inside(s.x, s.y)).toBe(false)
    for (const n of m.nav) expect(inside(n.x, n.y)).toBe(false)
  })
})
