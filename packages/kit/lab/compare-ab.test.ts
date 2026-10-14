import { expect, test } from "bun:test"
import { vehicleEffectSettings } from "../vehicle/effect-settings"
import { computeSnapshotDiffs } from "./compare-ab"
import { applyGameRecipe, buildGameRecipe } from "./recipe"

test("computeSnapshotDiffs identifies modified parameters and formats deltas against Slot A", () => {
  const snapA = {
    sectionId: "effects",
    sections: {
      effects: { effect: "smoke", size: 1, density: 1, playing: false },
    },
    lighting: { exposure: 0 },
  }
  const snapB = {
    sectionId: "effects",
    sections: {
      effects: { effect: "smoke", size: 1.35, density: 0.8, playing: true },
    },
    lighting: { exposure: 0.25 },
  }
  const diffs = computeSnapshotDiffs(snapA, snapB)
  expect(diffs).toEqual([
    { key: "size", before: 1, after: 1.35, deltaText: "+0.35 vs A" },
    { key: "density", before: 1, after: 0.8, deltaText: "-0.2 vs A" },
    { key: "lighting.exposure", before: 0, after: 0.25, deltaText: "+0.25 vs A" },
  ])
})

test("buildGameRecipe and applyGameRecipe round-trip typed production settings without URL params", () => {
  const origWidth = vehicleEffectSettings.skids.width
  try {
    const recipe = buildGameRecipe({
      sectionId: "getaway-effects",
      settings: {
        effect: "skids",
        seed: 7,
        effectSeed: 19,
        "skids.width": 0.24,
        "skids.life": 14,
      },
      lighting: {},
    })
    expect(recipe.schema).toBe("arcade-game-recipe/v1")
    expect(recipe.modulePath).toBe("packages/kit/vehicle/effect-settings.ts")
    expect(recipe.group).toBe("skids")
    expect(recipe.values).toEqual({ width: 0.24, life: 14 })
    expect(recipe.codeSnippet).toContain("skids: { width: 0.24, life: 14 }")
    expect(recipe.codeSnippet).not.toContain("?")

    const res = applyGameRecipe(JSON.stringify(recipe))
    expect(res).toEqual({ ok: true, appliedKeys: ["skids.width", "skids.life"] })
    expect(vehicleEffectSettings.skids.width).toBe(0.24)
  } finally {
    vehicleEffectSettings.skids.width = origWidth
  }
})
