import { describe, expect, test } from "bun:test"
import { BUST_SECONDS, DT, EXTRACT_BOXED_RATE, EXTRACT_OPEN_SECONDS, EXTRACT_SECONDS } from "../shared/config"
import { NO_INPUT } from "../shared/sim/vehicle"
import { SURVIVAL } from "../shared/sim/world"
import { ROAD_X, ROAD_Z, drive, humanWorld, place, steps, toChase } from "./sim-helpers"

describe("bust", () => {
  test("a robber pinned by two cops at low speed is busted in about BUST_SECONDS", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z)
    place(w, "c1", ROAD_X - 4.5, ROAD_Z)
    place(w, "c2", ROAD_X + 4.5, ROAD_Z)
    let t = 0
    while (!w.busted && t < 10) {
      w.step(DT)
      t += DT
    }
    expect(w.busted).toBe(true)
    expect(w.phase).toBe("end")
    expect(Math.abs(t - BUST_SECONDS)).toBeLessThan(0.25)
    expect(w.drainEvents().some((e) => e.kind === "bust")).toBe(true)
    expect(w.standings.get("c1")!.busts).toBe(1)
  })

  test("one cop alone (pinning against a wall) is slower", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z)
    place(w, "c1", ROAD_X - 4.5, ROAD_Z)
    steps(w, BUST_SECONDS + 0.5)
    expect(w.busted).toBe(false)
    expect(w.boxed).toBe(true)
    expect(w.bust).toBeGreaterThan(0.4)
    steps(w, BUST_SECONDS * 1.5)
    expect(w.busted).toBe(true)
  })

  test("a fast-moving robber is never boxed, even with cops alongside", () => {
    const w = humanWorld()
    toChase(w)
    steps(w, 6, () => {
      place(w, "r", ROAD_X, ROAD_Z, 0, 20)
      place(w, "c1", ROAD_X - 4.5, ROAD_Z, 0, 20)
      place(w, "c2", ROAD_X + 4.5, ROAD_Z, 0, 20)
      w.setInput("r", drive(1))
      expect(w.boxed).toBe(false)
    })
    expect(w.bust).toBe(0)
    expect(w.busted).toBe(false)
  })

  test("bust progress drains once the robber breaks free", () => {
    const w = humanWorld()
    toChase(w)
    place(w, "r", ROAD_X, ROAD_Z)
    place(w, "c1", ROAD_X - 4.5, ROAD_Z)
    place(w, "c2", ROAD_X + 4.5, ROAD_Z)
    steps(w, BUST_SECONDS / 2)
    const peak = w.bust
    expect(peak).toBeGreaterThan(0.4)
    place(w, "r", ROAD_X, ROAD_Z + 40, 0, 25)
    w.setInput("r", drive(1))
    steps(w, 0.5)
    expect(w.boxed).toBe(false)
    expect(w.bust).toBeLessThan(peak)
  })
})

describe.skipIf(SURVIVAL)("extraction", () => {
  test("the extraction point is closed until EXTRACT_OPEN_SECONDS into the chase", () => {
    const w = humanWorld()
    toChase(w)
    expect(w.view("r").exitOpenIn).toBeCloseTo(EXTRACT_OPEN_SECONDS, 1)
    steps(w, 5, () => place(w, "r", w.exit.x, w.exit.z))
    expect(w.extract).toBe(0)
    expect(w.escaped).toBe(false)
  })

  test("holding inside the zone for EXTRACT_SECONDS wins; leaving early does not", () => {
    const w = humanWorld()
    toChase(w)
    steps(w, EXTRACT_OPEN_SECONDS + 0.1)
    expect(w.view("r").exitOpenIn).toBe(0)
    steps(w, EXTRACT_SECONDS - 1, () => place(w, "r", w.exit.x, w.exit.z))
    expect(w.escaped).toBe(false)
    expect(w.view("r").extract).toBeGreaterThan(0.5)
    // Leave the zone: progress drains.
    steps(w, 1.5, () => place(w, "r", w.exit.x + 40, w.exit.z + 40))
    expect(w.escaped).toBe(false)
    expect(w.extract).toBeLessThan(1)
    // Too fast inside the zone does not count.
    steps(w, EXTRACT_SECONDS + 1, () => place(w, "r", w.exit.x, w.exit.z, 0.7, 20))
    expect(w.escaped).toBe(false)
    // Hold properly.
    let t = 0
    while (!w.escaped && t < EXTRACT_SECONDS + 1) {
      place(w, "r", w.exit.x, w.exit.z)
      w.step(DT)
      t += DT
    }
    expect(w.escaped).toBe(true)
    expect(t).toBeLessThan(EXTRACT_SECONDS + 0.1)
    expect(w.standings.get("r")!.escapes).toBe(1)
    expect(w.standings.get("r")!.score).toBeGreaterThanOrEqual(w.loot)
  })

  test("cops pressed against the car slow the loading down", () => {
    const w = humanWorld()
    toChase(w)
    steps(w, EXTRACT_OPEN_SECONDS + 0.1)
    const e = w.exit
    steps(w, 1, () => {
      place(w, "r", e.x, e.z)
      place(w, "c1", e.x + 4.5, e.z + 4.5)
    })
    expect(w.boxed).toBe(true)
    expect(w.extract).toBeCloseTo(EXTRACT_BOXED_RATE, 1)
  })
})

describe("near miss", () => {
  test("+500 once per cooldown for threading past a cop at speed", () => {
    const w = humanWorld()
    toChase(w)
    w.drainEvents()
    const score0 = w.standings.get("r")!.score
    place(w, "c1", ROAD_X - 2.75, ROAD_Z)
    place(w, "c2", ROAD_X - 2.75, ROAD_Z + 15)
    place(w, "r", ROAD_X + 2.75, ROAD_Z - 15, 0, 30)
    w.setInput("r", drive(1))
    steps(w, 1.4)
    let near = w.drainEvents().filter((e) => e.kind === "near")
    expect(near.length).toBe(1)
    expect(w.roundNear).toBe(1)
    expect(w.standings.get("r")!.score - score0).toBeGreaterThanOrEqual(500)
    // After the cooldown, another pass scores again.
    steps(w, 1)
    place(w, "r", ROAD_X + 2.75, ROAD_Z - 15, 0, 30)
    steps(w, 0.8)
    near = w.drainEvents().filter((e) => e.kind === "near")
    expect(near.length).toBe(1)
    expect(w.roundNear).toBe(2)
  })

  test("no near miss for contact or low speed", () => {
    const w = humanWorld()
    toChase(w)
    w.drainEvents()
    place(w, "c1", ROAD_X - 2.75, ROAD_Z)
    place(w, "r", ROAD_X + 2.75, ROAD_Z - 10, 0, 10)
    w.setInput("r", NO_INPUT)
    steps(w, 2)
    expect(w.drainEvents().some((e) => e.kind === "near")).toBe(false)
  })
})
