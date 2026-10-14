import { describe, expect, test } from "bun:test"
import {
  VARIATION_GRID_PRESETS,
  computeVariationGridLayout,
  pickVariationGridTileAt,
  resolveVariationGridConfig,
  summarizeTileSettings,
} from "./variation-grid"

describe("variation-grid", () => {
  test("computeVariationGridLayout partitions a 3x2 6-tile grid and picks tiles accurately", () => {
    const layout = computeVariationGridLayout(6, 1200, 800, 3)
    expect(layout.cols).toBe(3)
    expect(layout.rows).toBe(2)
    expect(layout.rects).toHaveLength(6)
    expect(layout.rects[0]).toEqual({
      index: 0,
      tileNumber: 1,
      col: 0,
      row: 0,
      x: 0,
      y: 0,
      width: 400,
      height: 400,
    })
    expect(layout.rects[5]).toEqual({
      index: 5,
      tileNumber: 6,
      col: 2,
      row: 1,
      x: 800,
      y: 400,
      width: 400,
      height: 400,
    })

    expect(pickVariationGridTileAt(layout, 50, 50)?.tileNumber).toBe(1)
    expect(pickVariationGridTileAt(layout, 450, 50)?.tileNumber).toBe(2)
    expect(pickVariationGridTileAt(layout, 850, 450)?.tileNumber).toBe(6)
    expect(pickVariationGridTileAt(layout, -10, 50)).toBeNull()
  })

  test("resolveVariationGridConfig resolves built-in looks (6 tiles) and explosions (4 tiles) presets", () => {
    const looksGrid = resolveVariationGridConfig({ preset: "looks" }, "spawn")
    expect(looksGrid.id).toBe("looks")
    expect(looksGrid.section).toBe("looks")
    expect(looksGrid.cols).toBe(3)
    expect(looksGrid.rows).toBe(2)
    expect(looksGrid.tiles).toHaveLength(6)
    expect(looksGrid.tiles.map(t => t.preset)).toEqual([
      "current",
      "noir",
      "painterly",
      "cinematic_dusk",
      "sodium_70s",
      "cozy_golden_hour",
    ])

    const expGrid = resolveVariationGridConfig({ preset: "explosions" }, "effects")
    expect(expGrid.id).toBe("explosions")
    expect(expGrid.section).toBe("effects")
    expect(expGrid.cols).toBe(2)
    expect(expGrid.rows).toBe(2)
    expect(expGrid.tiles).toHaveLength(4)
    expect(expGrid.tiles.map(t => t.label)).toEqual([
      "Standard Blast",
      "Heavy Fireball",
      "Dense Soot Column",
      "High-Velocity Shrapnel",
    ])
  })

  test("resolveVariationGridConfig accepts custom 2..9 tile arrays and rejects invalid tile counts", () => {
    const custom = resolveVariationGridConfig(
      {
        title: "Custom Look Pair",
        section: "looks",
        tiles: [
          { label: "Noir", preset: "noir" },
          { label: "Painterly", preset: "painterly" },
        ],
      },
      "looks",
    )
    expect(custom.cols).toBe(2)
    expect(custom.rows).toBe(1)
    expect(custom.tiles).toHaveLength(2)
    expect(summarizeTileSettings(custom.tiles[0]!)).toContain("noir")

    expect(() => resolveVariationGridConfig({ tiles: [{ label: "Only One" }] }, "looks")).toThrow(/between 2 and 9/)
    expect(() => resolveVariationGridConfig({ preset: "not-a-preset" }, "looks")).toThrow(/Unknown variation grid preset/)
    expect(Object.keys(VARIATION_GRID_PRESETS)).toEqual([
      "looks",
      "explosions",
      "smoke",
      "materials",
      "foliage",
      "lighting",
      "fog",
      "weather",
    ])
  })
})
