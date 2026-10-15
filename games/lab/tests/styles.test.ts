import { describe, expect, test } from "bun:test"
import { VARIATION_GRID_PRESETS } from "@arcade/kit/lab/variation-grid"
import {
  STYLE_LIST,
  STYLE_MODULES,
  STYLE_ORDER,
  buildStylePostShaderWgsl,
  createDefaultStyleStates,
  resolveStyleId,
} from "../src/styles"
import { STYLE_HERO_TICK, STYLE_LOOP_TICKS, StylePlaygroundSim } from "../src/styles/sim-loop"

describe("Style Playground", () => {
  test("all 9 style presentation modules are registered with unique indices and WGSL entry functions", () => {
    expect(STYLE_LIST.length).toBe(9)
    expect(STYLE_ORDER.length).toBe(9)
    const wgsl = buildStylePostShaderWgsl()
    STYLE_LIST.forEach((mod, i) => {
      expect(mod.index).toBe(i)
      expect(STYLE_MODULES[mod.id]).toBe(mod)
      expect(wgsl).toContain(`fn evalStyle_${i}(uv: vec2f) -> vec3f`)
      expect(resolveStyleId(mod.id)).toBe(mod.id)
      expect(resolveStyleId(i + 1)).toBe(mod.id)
    })
    const defaults = createDefaultStyleStates()
    expect(Object.keys(defaults)).toEqual([...STYLE_ORDER])
  })

  test("variation grid preset 'styles' has 9 tiles matching STYLE_ORDER in a 3×3 layout", () => {
    const grid = VARIATION_GRID_PRESETS.styles
    expect(grid).toBeDefined()
    expect(grid!.section).toBe("styles")
    expect(grid!.cols).toBe(3)
    expect(grid!.rows).toBe(3)
    expect(grid!.tiles.map(t => t.id)).toEqual([...STYLE_ORDER])
  })

  test("deterministic Outbreak room sim fires shots, kills zombies, and reproduces identical state across runs", () => {
    const simA = new StylePlaygroundSim(7)
    const simB = new StylePlaygroundSim(7)
    expect(simA.tick).toBe(STYLE_HERO_TICK)
    expect(simA.view.player.x).toBeCloseTo(simB.view.player.x, 6)
    expect(simA.view.player.y).toBeCloseTo(simB.view.player.y, 6)
    expect(simA.view.zombies.length).toBe(3)

    // At hero tick 85, one zombie is already dead from tick 52 and the shot from tick 84 is active
    const deadAtHero = simA.view.zombies.filter(z => z.state === "dead").length
    expect(deadAtHero).toBeGreaterThanOrEqual(1)
    const shot = simA.activeShotSummary()
    expect(shot.shotIntensity).toBeGreaterThan(0.8)
    expect(shot.hitIntensity).toBeGreaterThan(0.8)

    // Seek forward and backward deterministically
    simA.seekToTick(180)
    simB.seekToTick(180)
    expect(simA.view.zombies.map(z => [z.x, z.y, z.state, z.hp])).toEqual(
      simB.view.zombies.map(z => [z.x, z.y, z.state, z.hp]),
    )

    // Wrap around full 450-tick loop
    simA.seekToTick(STYLE_LOOP_TICKS - 1)
    simA.step(1 / 60)
    expect(simA.tick).toBe(0)
  })
})
