import { describe, expect, test } from "bun:test"
import { makeTown } from "../shared/map"
import { LocalSession } from "../shared/session"
import { lampFlickerPhase, neonLevel, placeNightLights, sodiumLevel } from "../src/night-lights/placement"
import { DEFAULT_NIGHT_LIGHT_SETTINGS, type OutbreakNightLightSettings } from "../src/night-lights/settings"

const settings = (patch: Partial<OutbreakNightLightSettings> = {}): OutbreakNightLightSettings => ({ ...DEFAULT_NIGHT_LIGHT_SETTINGS, ...patch })

describe("night lights placement", () => {
  test("seeded from the town: the same town places the same lights, nlSeed rerolls them", () => {
    const s = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming")
    const town = s.view.town
    const a = placeNightLights(town, settings())
    expect(a).toEqual(placeNightLights(new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming").view.town, settings()))
    expect(a.length).toBeGreaterThan(0)
    const all = placeNightLights(town, settings({ nlCruisers: 1, nlBeacons: 1, nlNeon: 1 }))
    expect(all.length).toBeGreaterThan(a.length)
    const reroll = placeNightLights(town, settings({ nlSeed: 5, nlCruisers: 0.5, nlBeacons: 0.5, nlNeon: 0.5 }))
    expect(reroll).not.toEqual(placeNightLights(town, settings({ nlCruisers: 0.5, nlBeacons: 0.5, nlNeon: 0.5 })))
  })

  test("sometimes, not everywhere: default shares leave most cars and shops dark", () => {
    const town = new LocalSession(7, 7, 0.22, { zombieCount: 0 }, "streaming").view.town
    const sites = placeNightLights(town, settings())
    const cars = (town.vehicles ?? []).length
    const cruisers = sites.filter((s) => s.kind === "cruiser").length
    expect(cruisers).toBeLessThan(Math.max(2, cars * 0.5))
    expect(placeNightLights(town, settings({ nightLights: false }))).toEqual([])
    expect(placeNightLights(town, settings({ nlCruisers: 0, nlBeacons: 0, nlNeon: 0, nlArmedLeds: false }))).toEqual([])
  })

  test("pharmacies get a green cross; the classic town's shops get signs when asked", () => {
    const town = makeTown(7)
    const neon = placeNightLights(town, settings({ nlNeon: 1 })).filter((s) => s.kind === "neon")
    const pharmacy = neon.find((s) => s.key.endsWith(town.buildings.find((b) => b.kind === "pharmacy")!.id))
    expect(pharmacy && pharmacy.kind === "neon" && pharmacy.colour).toBe("green")
  })

  test("dying lamps and broken neon are deterministic in sim time and stay in range", () => {
    const town = makeTown(7)
    const street = town.lamps.filter((l) => l.kind === "street")
    const flicker = street.filter((l) => lampFlickerPhase(town, settings({ nlSodiumFlicker: 1 }), l) >= 0)
    expect(flicker.length).toBe(street.length)
    expect(street.filter((l) => lampFlickerPhase(town, settings({ nlSodiumFlicker: 0 }), l) >= 0).length).toBe(0)
    let dark = 0
    for (let t = 0; t < 60; t += 0.05) {
      const k = sodiumLevel(0.3, t)
      expect(k).toBeGreaterThanOrEqual(0)
      expect(k).toBeLessThanOrEqual(1)
      if (k < 0.1) dark++
      expect(sodiumLevel(0.3, t)).toBe(k)
      const n = neonLevel(true, 0.6, t)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThanOrEqual(1)
    }
    expect(dark).toBeGreaterThan(0)
  })
})
