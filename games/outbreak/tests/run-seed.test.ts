import { expect, test } from "bun:test"
import { parseRunSeed, runSeedCode, runSeedLink } from "../src/lobby/run-seed"
import { createOutbreakSettings } from "../src/settings"

test("replay codes preserve both the town and changed house seed", () => {
  for (const run of [
    { seed: 7, houseSeed: 7, terrain: 0.22 },
    { seed: 7, houseSeed: 123456789, terrain: 0.4 },
    { seed: 0, houseSeed: 4294967295, terrain: 0 },
  ]) {
    expect(parseRunSeed(runSeedCode(run))).toEqual({ seed: run.seed, houseSeed: run.houseSeed })
    const url = new URL(runSeedLink(run))
    const settings = createOutbreakSettings(url.searchParams)
    expect(Number(url.searchParams.get("seed"))).toBe(run.seed)
    expect(settings.world.houseSeed).toBe(run.houseSeed)
    expect(settings.world.terrain).toBe(run.terrain)
    expect([...url.searchParams.keys()].sort()).toEqual(["houseSeed", "seed", "terrain"])
  }
})

test("seed entry rejects malformed or wrapped integers", () => {
  for (const raw of ["", "-1", "1e3", "7.2.3", "4294967296", "7.4294967296", "abc"]) expect(parseRunSeed(raw)).toBeNull()
  expect(parseRunSeed(" 0 ")).toEqual({ seed: 0, houseSeed: 0 })
  expect(parseRunSeed("4294967295")).toEqual({ seed: 4294967295, houseSeed: 4294967295 })
})
