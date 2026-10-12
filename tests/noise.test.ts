import { describe, expect, test } from "bun:test"
import { DT, FOOT_RING, WEAPONS } from "../shared/config"
import { type SimEvent } from "../shared/sim/world"
import { intent, liveWorld, place, run } from "./helpers"

const ripples = (events: SimEvent[]) => events.filter((e): e is Extract<SimEvent, { k: "ripple" }> => e.k === "ripple")

describe("noise", () => {
  test("sneaking is silent", () => {
    const w = liveWorld(["a"])
    place(w, "a", 10, 10)
    run(w, 2, () => intent({ mx: 1, stance: "sneak" }))
    expect(ripples(w.takeEvents())).toHaveLength(0)
  })

  test("walking leaves soft footstep rings, running leaves loud ones", () => {
    const walk = liveWorld(["a"])
    place(walk, "a", 10, 10)
    run(walk, 1.2, () => intent({ mx: 1, stance: "walk" }))
    const soft = ripples(walk.takeEvents())
    expect(soft.length).toBeGreaterThan(0)
    expect(soft.every((r) => r.r === FOOT_RING.walk || r.r === FOOT_RING.walk * 1.5)).toBe(true)

    const run_ = liveWorld(["a"])
    place(run_, "a", 10, 10)
    run(run_, 1.2, () => intent({ mx: 1, stance: "run" }))
    const loud = ripples(run_.takeEvents())
    expect(loud.some((r) => r.r === FOOT_RING.run)).toBe(true)
    expect(loud.length).toBeGreaterThan(soft.length)
  })

  test("the suppressed pistol shot rings at its noise radius, after the wind-up", () => {
    const w = liveWorld(["a"])
    place(w, "a", 10, 10)
    w.push("a", 1, intent({ fire: true, aim: 0 }))
    w.step()
    expect(ripples(w.takeEvents()).filter((r) => r.kind === "shot")).toHaveLength(0)
    const ticks = Math.ceil(WEAPONS.pistol.windup / DT) + 1
    run(w, ticks * DT)
    const shots = ripples(w.takeEvents()).filter((r) => r.kind === "shot")
    expect(shots).toHaveLength(1)
    expect(shots[0]!.r).toBe(WEAPONS.pistol.noise)
    expect(w.players.get("a")!.mag).toBe(WEAPONS.pistol.mag - 1)
  })

  test("the crossbow is silent", () => {
    const w = liveWorld(["a"])
    place(w, "a", 10, 10)
    w.setLoadout("a", { weapon: "crossbow", gadgets: ["flare", "decoy"] })
    w.players.get("a")!.mag = 1
    w.push("a", 1, intent({ fire: true, aim: 0 }))
    run(w, 1)
    expect(ripples(w.takeEvents()).filter((r) => r.kind === "shot")).toHaveLength(0)
  })
})
