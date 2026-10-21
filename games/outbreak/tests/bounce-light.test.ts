import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { planBounceEmitShader } from "@arcade/kit/gpu/gi/plan-bounce"
import { bounceControls, bounceInput, DEFAULT_BOUNCE_SETTINGS } from "../src/bounce-light/settings"
import { outbreakPlanBounceShader } from "../src/bounce-light/wgsl"
import { shaders } from "../src/shaders"
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

  test("every slider's range holds its default", () => {
    for (const c of bounceControls) {
      if (!("min" in c) || c.min === undefined || c.max === undefined) continue
      const v = DEFAULT_BOUNCE_SETTINGS[c.key as keyof typeof DEFAULT_BOUNCE_SETTINGS]
      expect(v).toBeGreaterThanOrEqual(c.min)
      expect(v).toBeLessThanOrEqual(c.max)
    }
  })
})

describe("bounced light WGSL validates with naga", () => {
  const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga"), join(homedir(), ".cache/naga-cli/bin/naga")].find(
    (p): p is string => !!p && existsSync(p),
  )
  const sources: Record<string, string> = {
    "Outbreak emission": planBounceEmitShader(outbreakPlanBounceShader),
    "Outbreak scene": shaders.scene,
    "Outbreak look scene": shaders.lookScene,
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      if (!naga) {
        console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
        return
      }
      const dir = mkdtempSync(join(tmpdir(), "outbreak-bounce-wgsl-"))
      try {
        const file = join(dir, "shader.wgsl")
        writeFileSync(file, code)
        const run = Bun.spawnSync([naga, file])
        const out = run.stderr.toString() + run.stdout.toString()
        if (run.exitCode !== 0) console.log(out.slice(0, 4000))
        expect(run.exitCode).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
