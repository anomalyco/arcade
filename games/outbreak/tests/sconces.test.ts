import { afterEach, describe, expect, test } from "bun:test"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { QUALITY_PROFILES } from "@arcade/kit/quality"
import { inBuildingFootprint, makeTown } from "../shared/map"
import { generateWorldChunk } from "../shared/world"
import { collectSconces, DEFAULT_INTERIOR_SETTINGS, interiorSettings, SconceLights } from "../src/interiors"
import { INTERIOR_THEMES } from "../src/interiors/plan"
import { SCONCE_CONE_W, SCONCE_FLOATS } from "../src/interiors/sconces"
import { shaders } from "../src/shaders"
import { compileSingleWorldChunk } from "../src/world-streamer"

const MANSION = INTERIOR_THEMES.indexOf("mansion")
afterEach(() => {
  interiorSettings.theme = -1
})

const pairs = (src: Float32Array) => {
  const out = []
  for (let o = 0; o < src.length; o += SCONCE_FLOATS) out.push(src.subarray(o, o + SCONCE_FLOATS))
  return out
}

describe("sconce placement", () => {
  test("mansion houses hang a pair of sconces beside each painting, facing into the house", () => {
    interiorSettings.theme = MANSION
    const town = makeTown(7)
    const src = collectSconces(town)
    expect(src.length % SCONCE_FLOATS).toBe(0)
    const all = pairs(src)
    expect(all.length).toBeGreaterThanOrEqual(town.buildings.length * 2)
    for (const s of all) {
      const [x, z, y, nx, nz, back, left, right, half, bx0, bz0, bx1, bz1] = s as unknown as number[]
      const b = town.buildings.find(b => b.rect[0] === bx0 && b.rect[1] === bz0 && b.rect[2] === bx1 && b.rect[3] === bz1)!
      expect(b).toBeDefined()
      expect(Math.abs(nx!) + Math.abs(nz!)).toBe(1)
      // The bulbs sit inside the footprint and the wall is just behind them.
      expect(inBuildingFootprint(b, x!, z!)).toBe(true)
      expect(inBuildingFootprint(b, x! + nx! * 0.5, z! + nz! * 0.5)).toBe(true)
      expect(y).toBeCloseTo(1.79, 2)
      expect(back).toBeGreaterThan(0.165)
      expect(back).toBeLessThanOrEqual(0.23)
      expect(left).toBeGreaterThanOrEqual(0)
      expect(right).toBeGreaterThanOrEqual(0)
      expect(left).toBeLessThanOrEqual(4)
      expect(right).toBeLessThanOrEqual(4)
      expect(half).toBeGreaterThan(0.45)
    }
  })

  test("plain rooms have none, and streamed chunks carry theirs out of the compile", () => {
    interiorSettings.theme = INTERIOR_THEMES.indexOf("plain")
    expect(collectSconces(makeTown(7)).length).toBe(0)
    interiorSettings.theme = MANSION
    const chunk = generateWorldChunk(7, 7, 4, 1, "streaming")
    const compiled = compileSingleWorldChunk(chunk, 7, 7, 0.22, 1)
    expect(compiled.sconces).toBeInstanceOf(Float32Array)
    expect(compiled.sconces.length % SCONCE_FLOATS).toBe(0)
    if (chunk.buildings.length) expect(compiled.sconces.length).toBeGreaterThan(0)
  })
})

describe("sconce lights", () => {
  interiorSettings.theme = MANSION
  const town = makeTown(7)
  const src = collectSconces(town)
  interiorSettings.theme = -1
  const ash = town.buildings.find(b => b.id === "ash")!
  const settings = { ...DEFAULT_INTERIOR_SETTINGS }
  const write = (cutX: number, cutY: number, max = 3, level = 0.8) => {
    const lights = new Float32Array(64 * LIGHT_FLOATS)
    const sconces = new SconceLights()
    sconces.setSources([src])
    const next = sconces.write(lights, 2, 64, max, cutX, cutY, level, 0.88, settings)
    return { lights, n: next - 2, list: sconces.list() }
  }

  test("only the house the cut point is inside lights, nearest pair first, within the budget", () => {
    const { lights, n } = write(33.7, 27.6, 2)
    expect(n).toBe(2)
    let prev = -1
    for (let k = 0; k < n; k++) {
      const o = (2 + k) * LIGHT_FLOATS
      const [x, , z] = [lights[o]!, lights[o + 1]!, lights[o + 2]!]
      expect(x).toBeGreaterThan(ash.rect[0])
      expect(x).toBeLessThan(ash.rect[2])
      expect(z).toBeGreaterThan(ash.rect[1])
      expect(z).toBeLessThan(ash.rect[3])
      const d = Math.hypot(x - 33.7, z - 27.6)
      expect(d).toBeGreaterThanOrEqual(prev)
      prev = d
      // Marked as a sconce, unshadowed, never mistaken for a flashlight, kit cone falloff disabled.
      expect(lights[o + 11]).toBe(SCONCE_CONE_W)
      expect(lights[o + 13]!).toBeLessThanOrEqual(-1)
      expect(lights[o + 15]!).toBeGreaterThan(0)
      expect(lights[o + 10]!).toBeLessThanOrEqual(-1.25)
      // Warm.
      expect(lights[o + 4]!).toBeGreaterThan(lights[o + 5]!)
      expect(lights[o + 5]!).toBeGreaterThan(lights[o + 6]!)
    }
  })

  test("nothing lights outdoors, by day, with sconces off, or past the light buffer", () => {
    expect(write(45, 45).n).toBe(0)
    expect(write(33.7, 27.6, 3, 0).n).toBe(0)
    expect(write(33.7, 27.6, 0).n).toBe(0)
    const lights = new Float32Array(4 * LIGHT_FLOATS)
    const sconces = new SconceLights()
    sconces.setSources([src])
    expect(sconces.write(lights, 3, 4, 3, 33.7, 27.6, 0.8, 0.88, settings)).toBe(4)
  })

  test("bulbs follow the room-lamp level, and the scene shader knows sconces", () => {
    expect(SconceLights.bulb(0, settings)).toBe(0)
    expect(SconceLights.bulb(1, settings)).toBeGreaterThan(SconceLights.bulb(0.5, settings))
    expect(SconceLights.bulb(1, { ...settings, sconcePower: 0 })).toBe(0)
    expect(shaders.scene).toContain("L.cone.w > 1.125 && L.cone.w < 1.5")
  })

  test("quality tiers budget sconce pairs and drop them on low", () => {
    expect(QUALITY_PROFILES.high.maxSconceLights).toBeGreaterThanOrEqual(QUALITY_PROFILES.balanced.maxSconceLights)
    expect(QUALITY_PROFILES.balanced.maxSconceLights).toBeGreaterThan(0)
    expect(QUALITY_PROFILES.low.maxSconceLights).toBe(0)
  })
})
