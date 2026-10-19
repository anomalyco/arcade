import { describe, expect, test } from "bun:test"
import {
  AA_MSAA,
  AA_TAA,
  AA_TAA_UPSCALE,
  DEFAULT_ANTI_ALIASING_SETTINGS,
  antiAliasingControls,
  temporalSettings,
} from "../src/anti-aliasing/settings"
import { createOutbreakSettings, resolveOutbreakSettingTarget } from "../src/settings"

describe("anti-aliasing settings (AR-72)", () => {
  test("every control routes to the view settings and its default is in range", () => {
    const settings = createOutbreakSettings()
    for (const c of antiAliasingControls) {
      expect(resolveOutbreakSettingTarget(c.key)?.subsystem).toBe("view")
      const v = (settings.view as unknown as Record<string, number>)[c.key]
      expect(v).toBe((DEFAULT_ANTI_ALIASING_SETTINGS as Record<string, number>)[c.key]!)
      if ("min" in c) {
        expect(v).toBeGreaterThanOrEqual(c.min)
        expect(v).toBeLessThanOrEqual(c.max)
      }
    }
  })

  test("MSAA (today) is one setting away and maps to the renderer's off state", () => {
    expect(temporalSettings({ ...DEFAULT_ANTI_ALIASING_SETTINGS, aaMode: AA_MSAA })).toBeNull()
    expect(temporalSettings({ ...DEFAULT_ANTI_ALIASING_SETTINGS, aaMode: AA_TAA })?.mode).toBe("taa")
    const up = temporalSettings({ ...DEFAULT_ANTI_ALIASING_SETTINGS, aaMode: AA_TAA_UPSCALE, aaRenderScale: 0.6 })
    expect(up).toEqual({ mode: "taau", renderScale: 0.6, sharpen: DEFAULT_ANTI_ALIASING_SETTINGS.aaSharpen, history: DEFAULT_ANTI_ALIASING_SETTINGS.aaHistory })
  })
})
