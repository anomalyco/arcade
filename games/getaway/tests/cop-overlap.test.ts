import { describe, expect, test } from "bun:test"
import { ROAD_X, ROAD_Z, humanWorld, place, steps, toChase } from "./sim-helpers"

describe("cop cars", () => {
  test("cops gently separate without a crash, but still hit the driver", () => {
    const w = humanWorld(["c1", "c2"])
    toChase(w)
    place(w, "r", ROAD_X + 300, ROAD_Z + 200)
    place(w, "c1", ROAD_X, ROAD_Z, 0)
    place(w, "c2", ROAD_X, ROAD_Z + 1, 0)
    steps(w, 0.5)
    const a = w.carOf("c1")!.body
    const b = w.carOf("c2")!.body
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1.9)
    expect(a.stun).toBe(0)
    expect(b.stun).toBe(0)
    expect(w.carOf("c1")!.impact).toBe(0)
    expect(w.carOf("c2")!.impact).toBe(0)
    place(w, "r", ROAD_X + 0.5, ROAD_Z + 1, 0)
    steps(w, 0.5)
    const r = w.carOf("r")!.body
    expect(Math.hypot(r.x - a.x, r.z - a.z)).toBeGreaterThan(1.5)
  })
})
