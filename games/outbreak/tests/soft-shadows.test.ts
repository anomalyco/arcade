import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { polarShader } from "@arcade/kit/gpu/shaders"
import { createOutbreakSettings } from "../src/settings"
import { capsuleSettings, DEFAULT_SOFT_SHADOW_SETTINGS, softShadowsOn } from "../src/soft-shadows/settings"
import { noteLyingBody, takeLyingBodies } from "../src/soft-shadows/lying-bodies"
import { flashlightVolumeShader } from "../src/flashlight-beam"
import { shaders } from "../src/shaders"

describe("soft character shadows (AR-113)", () => {
  test("Today is the default and one setting away", () => {
    const settings = createOutbreakSettings()
    expect(settings.softShadows.softShadowMode).toBe(0)
    expect(softShadowsOn(settings.softShadows)).toBe(false)
    expect(softShadowsOn({ softShadowMode: 1 })).toBe(true)
    expect(capsuleSettings(DEFAULT_SOFT_SHADOW_SETTINGS).mode).toBe(0)
  })

  test("lying bodies are taken once per frame", () => {
    noteLyingBody(1, 0, 2, 0.5)
    noteLyingBody(3, 0, 4, 1)
    const seen: number[][] = []
    takeLyingBodies((x, y, z, yaw) => seen.push([x, y, z, yaw]))
    expect(seen).toEqual([
      [1, 0, 2, 0.5],
      [3, 0, 4, 1],
    ])
    takeLyingBodies(() => seen.push([]))
    expect(seen.length).toBe(2)
  })
})

describe("Outbreak shaders validate with naga", () => {
  const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga")].find((p): p is string => !!p && existsSync(p))
  const sources: Record<string, string> = {
    scene: shaders.scene,
    lookScene: shaders.lookScene,
    polar: polarShader,
    flashlightVolume: flashlightVolumeShader.code,
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      if (!naga) {
        console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
        return
      }
      const dir = mkdtempSync(join(tmpdir(), "outbreak-wgsl-"))
      try {
        const file = join(dir, "shader.wgsl")
        writeFileSync(file, code)
        const run = Bun.spawnSync([naga, file])
        const out = run.stderr.toString() + run.stdout.toString()
        if (run.exitCode !== 0) console.log(out.slice(0, 2000))
        expect(run.exitCode).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
