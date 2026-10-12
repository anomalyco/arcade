import { describe, expect, test } from "bun:test"
import { CAMERA_YAW, SCREEN_AHEAD } from "../shared/config"
import { ROAD_X, ROAD_Z, humanWorld, place, steps, toChase } from "./sim-helpers"

describe("cop's own screen", () => {
  test("the driver stays drawn for a cop whose screen still shows them, even after radar loses them", () => {
    const w = humanWorld(["c1", "c2"])
    toChase(w)
    place(w, "c2", ROAD_X + 300, ROAD_Z - 200)
    place(w, "c1", ROAD_X, ROAD_Z, 0)
    // Just past the radar box ahead of c1 (camera forward), but well within what the screen shows.
    const d = SCREEN_AHEAD + 15
    place(w, "r", ROAD_X + Math.sin(CAMERA_YAW) * d, ROAD_Z + Math.cos(CAMERA_YAW) * d, 0)
    steps(w, 0.2)
    expect(w.seen).toBe(false)
    const mine = w.view("c1").cars.find((c) => c.ownerId === "r")!
    expect(mine.ghost).toBe(false)
    expect(mine.radar).toBe(false)
    const other = w.view("c2").cars.find((c) => c.ownerId === "r")
    expect(other?.ghost ?? true).toBe(true)
  })
})
