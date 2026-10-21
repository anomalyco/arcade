import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONTACT_KNOB_FLOATS,
  CONTACT_SHADOW_DEFAULTS,
  contactShadowControls,
  contactShadowInput,
  contactShadowVolume,
  createContactShadowSettings,
  packContactShadowKnobs,
} from "./contact-shadows"
import { fogParamsWgsl } from "./fog-scatter"

describe("contact shadow settings", () => {
  test("Today is the default, the first row, and runs no pass", () => {
    expect(CONTACT_SHADOW_DEFAULTS.mode).toBe("today")
    expect(contactShadowControls()[0]?.key).toBe("contact.mode")
    expect(contactShadowInput(createContactShadowSettings())).toBeNull()
  })

  test("screen mode asks for a half-resolution pass with history", () => {
    expect(contactShadowInput(createContactShadowSettings({ mode: "screen" }))).toEqual({ downscale: 2, history: 0.25, moving: 1 })
    // Kept in motion by setting (the history reprojects by the very surfaces the shadows lie on).
    expect(contactShadowInput(createContactShadowSettings({ mode: "screen", historyMoving: 0.25 }))?.moving).toBe(0.25)
    expect(contactShadowInput(createContactShadowSettings({ mode: "screen", halfRes: false }))?.downscale).toBe(1)
  })

  test("knobs pack at an offset with whole steps", () => {
    const out = packContactShadowKnobs(createContactShadowSettings({ length: 0.4, steps: 9.6, lights: 1 }), new Float32Array(CONTACT_KNOB_FLOATS + 2), 2)
    expect(out[2]).toBeCloseTo(0.4, 6)
    expect(out[6]).toBe(10)
    expect(out[7]).toBe(1)
  })
})

describe("WGSL validates with naga", () => {
  const naga = [process.env.NAGA, Bun.which("naga"), join(homedir(), ".cargo/bin/naga")].find((p): p is string => !!p && existsSync(p))
  const night = "struct Night { a: vec4f, b: vec4f }\n@group(0) @binding(13) var<uniform> N: Night;"
  const sources: Record<string, string> = {
    "contact volume": contactShadowVolume({ declarations: night, knobs: ["N.a", "N.b"] }).code,
    "contact volume, fog ambient": contactShadowVolume({ declarations: fogParamsWgsl + night, knobs: ["N.a", "N.b"], ambient: "fogAmbient(n)" }).code,
  }
  for (const [name, code] of Object.entries(sources)) {
    test(name, () => {
      if (!naga) {
        console.log("naga not found, skipping WGSL validation (cargo install naga-cli)")
        return
      }
      const dir = mkdtempSync(join(tmpdir(), "contact-wgsl-"))
      try {
        const file = join(dir, "shader.wgsl")
        writeFileSync(file, code)
        const run = Bun.spawnSync([naga, file])
        const out = run.stderr.toString() + run.stdout.toString()
        if (run.exitCode !== 0) console.log(out)
        expect(run.exitCode).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
