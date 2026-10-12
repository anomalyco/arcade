import { describe, expect, test } from "bun:test"
import { DT, STEP_RING, WEAPONS } from "../shared/config"
import type { SimEvent } from "../shared/sim/world"
import { darken, intent, liveWorld, place, run } from "./helpers"

type Ring = Extract<SimEvent, { k: "ring" }>
const rings = (ev: SimEvent[]) => ev.filter((e): e is Ring => e.k === "ring")

describe("noise", () => {
  test("sneaking is silent", () => {
    const w = liveWorld(["a"])
    place(w, "a", 12.5, 12)
    run(w, 2, () => intent({ my: 1, stance: "sneak" }))
    expect(rings(w.takeEvents())).toHaveLength(0)
  })

  test("walking leaves soft rings, running loud ones that also expose you", () => {
    const walk = liveWorld(["a"])
    place(walk, "a", 12.5, 12)
    run(walk, 1.5, () => intent({ my: 1, stance: "walk" }))
    const soft = rings(walk.takeEvents())
    expect(soft.length).toBeGreaterThan(0)
    expect(soft.every((r) => r.r === STEP_RING.walk)).toBe(true)
    expect(walk.players.get("a")!.exposed).toBe(false)

    const loud = liveWorld(["a"])
    darken(loud)
    place(loud, "a", 12.5, 12)
    run(loud, 1.5, () => intent({ my: 1, stance: "run" }))
    expect(rings(loud.takeEvents()).some((r) => r.r === STEP_RING.run)).toBe(true)
    expect(loud.players.get("a")!.exposed).toBe(true)
  })

  test("grates make footsteps louder", () => {
    const w = liveWorld(["a"])
    place(w, "a", 38, 6)
    run(w, 1.2, () => intent({ mx: 1, stance: "walk" }))
    expect(rings(w.takeEvents()).some((r) => r.r > STEP_RING.walk)).toBe(true)
  })

  test("the pistol rings at its noise radius after the wind-up, not before", () => {
    const w = liveWorld(["a"])
    place(w, "a", 12.5, 12)
    run(w, DT, () => intent({ fire: true, aim: Math.PI / 2 }))
    expect(rings(w.takeEvents()).filter((r) => r.kind === "shot")).toHaveLength(0)
    run(w, WEAPONS.pistol.windup + 0.1, () => intent({ aim: Math.PI / 2 }))
    const shots = rings(w.takeEvents()).filter((r) => r.kind === "shot")
    expect(shots).toHaveLength(1)
    expect(shots[0]!.r).toBe(WEAPONS.pistol.noise)
    expect(w.players.get("a")!.mag).toBe(WEAPONS.pistol.mag - 1)
  })

  test("the crossbow is silent at the shooter", () => {
    const w = liveWorld(["a"])
    w.setLoadout("a", { weapon: "crossbow", gadgets: ["flare", "decoy"], look: 0 })
    w.players.get("a")!.mag = 1
    place(w, "a", 12.5, 12)
    run(w, DT, () => intent({ fire: true, aim: Math.PI / 2 }))
    run(w, 1, () => intent({ aim: Math.PI / 2 }))
    const near = rings(w.takeEvents()).filter((r) => Math.hypot(r.x - 12.5, r.y - 12) < 1)
    expect(near).toHaveLength(0)
  })

  test("shooting glass shatters it with a loud jagged ring and leaves crunchy shards", () => {
    const w = liveWorld(["a"])
    place(w, "a", 13, 4)
    run(w, DT, () => intent({ fire: true, aim: Math.PI }))
    run(w, 0.5, () => intent({ aim: Math.PI }))
    expect(w.level.glassBroken.some(Boolean)).toBe(true)
    expect(rings(w.takeEvents()).some((r) => r.kind === "glass")).toBe(true)
    place(w, "a", 11.5, 4)
    run(w, 1.5, () => intent({ my: 0.4, stance: "sneak" }))
    expect(rings(w.takeEvents()).some((r) => r.kind === "crunch")).toBe(true)
  })

  test("a decoy rings exactly like a pistol", () => {
    const w = liveWorld(["a"])
    place(w, "a", 12.5, 12)
    run(w, DT, () => intent({ gadget: 1, tx: 12.5, ty: 18 }))
    run(w, 4)
    const shots = rings(w.takeEvents()).filter((r) => r.kind === "shot")
    expect(shots.length).toBe(3)
    expect(shots.every((r) => r.r === WEAPONS.pistol.noise)).toBe(true)
  })
})
