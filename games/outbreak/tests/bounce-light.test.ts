import { describe, expect, test } from "bun:test"
import { validateWgsl } from "@arcade/kit/gpu/test-naga"
import { planBounceEmitShader } from "@arcade/kit/gpu/gi/plan-bounce"
import { bounceInput, DEFAULT_BOUNCE_SETTINGS } from "../src/bounce-light/settings"
import { outbreakPlanBounceShader } from "../src/bounce-light/wgsl"
import { createOutbreakSettings } from "../src/settings"

describe("bounced light settings", () => {
  test("Today is the default and sends nothing to the renderer", () => {
    expect(DEFAULT_BOUNCE_SETTINGS.bouncedLight).toBe(0)
    expect(createOutbreakSettings().bounce.bouncedLight).toBe(0)
    expect(bounceInput(DEFAULT_BOUNCE_SETTINGS, 3, 4)).toBeNull()
    expect(bounceInput({ ...DEFAULT_BOUNCE_SETTINGS, bouncedLight: 1, bounceStrength: 0 }, 3, 4)).toBeNull()
  })

  test("on, it carries strength, range, resolution and the colour weight", () => {
    const input = bounceInput({ ...DEFAULT_BOUNCE_SETTINGS, bouncedLight: 1, bounceStrength: 2, bounceColour: 1.5 }, 3, 4)
    expect(input).toMatchObject({ centerX: 3, centerZ: 4, strength: 2, range: DEFAULT_BOUNCE_SETTINGS.bounceRange, texel: 0.5, params: [1.5, 0, 0] })
  })

})

describe("bounced light WGSL validates with naga", () => {
  // The shared scene variants are covered in soft-shadows.test.ts.
  test("Outbreak emission", () => validateWgsl(planBounceEmitShader(outbreakPlanBounceShader)))
})
