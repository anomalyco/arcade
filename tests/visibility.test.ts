import { describe, expect, test } from "bun:test"
import { VIEW_RANGE } from "../shared/config"
import { buildSnapshot, eventsFor } from "../shared/sim/view"
import { intent, liveWorld, place, run } from "./helpers"

describe("visibility rule", () => {
  test("in the dark a sneaking enemy is invisible; running reveals them", () => {
    const w = liveWorld(["a", "b"])
    const a = place(w, "a", 15, 4)
    const b = place(w, "b", 15, 9)
    run(w, 1, (_, id) => (id === "b" ? intent({ mx: 0.3, stance: "sneak" }) : intent({})))
    expect(w.sees(a, b)).toBe(false)
    run(w, 0.5, (_, id) => (id === "b" ? intent({ my: 1, stance: "run" }) : intent({})))
    expect(b.exposed).toBe(true)
    expect(w.sees(a, b)).toBe(true)
  })

  test("standing in a lamp pool exposes you", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 15, 4)
    place(w, "b", 30, 15.5)
    w.step()
    expect(w.players.get("b")!.lit).toBe(true)
  })

  test("shooting out the lamp hides whoever stood in it", () => {
    const w = liveWorld(["a", "b"])
    place(w, "b", 31, 15)
    w.step()
    expect(w.players.get("b")!.lit).toBe(true)
    w.level.lamps[0]!.broken = true
    w.step()
    expect(w.players.get("b")!.lit).toBe(false)
  })

  test("walls block sight even when the target is exposed", () => {
    const w = liveWorld(["a", "b"])
    const a = place(w, "a", 8, 4)
    const b = place(w, "b", 12, 4)
    b.exposedUntil = w.time + 5
    w.step()
    expect(b.exposed).toBe(true)
    expect(w.sees(a, b)).toBe(false)
  })

  test("nobody sees past VIEW_RANGE", () => {
    const w = liveWorld(["a", "b"])
    const a = place(w, "a", 1, 10)
    const b = place(w, "b", 1 + VIEW_RANGE + 1, 10)
    b.exposedUntil = w.time + 5
    w.step()
    expect(w.sees(a, b)).toBe(false)
  })
})

describe("server-side filtering", () => {
  test("hidden enemies never appear in a snapshot, in any form", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 2, 2)
    place(w, "b", 20, 18.3)
    w.step()
    const snap = buildSnapshot(w, "a")
    expect(snap.others.map((o) => o.id)).not.toContain("b")
    expect(JSON.stringify(snap)).not.toContain("18.3")
  })

  test("visible enemies do appear", () => {
    const w = liveWorld(["a", "b"])
    place(w, "a", 15, 4)
    const b = place(w, "b", 15, 9)
    b.exposedUntil = w.time + 5
    w.step()
    expect(buildSnapshot(w, "a").others.map((o) => o.id)).toContain("b")
  })

  test("teammates are always shown; the dead see only living teammates", () => {
    const w = liveWorld(["a", "b", "c"])
    const [a, b, c] = ["a", "b", "c"].map((id) => w.players.get(id)!)
    expect(a!.team).toBe(c!.team)
    place(w, "a", 15, 2)
    place(w, "c", 22, 18)
    const enemy = place(w, "b", 15, 6)
    enemy.exposedUntil = w.time + 5
    w.step()
    expect(buildSnapshot(w, "a").others.map((o) => o.id).sort()).toEqual(["b", "c"])
    w.kill(a!, b!, "pistol")
    w.step()
    expect(buildSnapshot(w, "a").others.map((o) => o.id)).toEqual(["c"])
  })

  test("a mid-round joiner sees no living player", () => {
    const w = liveWorld(["a", "b"])
    w.addHuman("late", "late")
    w.step()
    const snap = buildSnapshot(w, "late")
    expect(snap.you?.alive).toBe(false)
    expect(snap.others).toHaveLength(0)
  })

  test("tracers and killcams are addressed; rings are public", () => {
    const events = [
      { k: "shot" as const, x0: 0, y0: 0, x1: 1, y1: 0, weapon: "pistol" as const, to: ["a"] },
      { k: "ring" as const, x: 0, y: 0, r: 14, kind: "shot" as const },
    ]
    expect(eventsFor(events, "b").map((e) => e.k)).toEqual(["ring"])
    expect(eventsFor(events, "a").map((e) => e.k)).toEqual(["shot", "ring"])
  })
})
