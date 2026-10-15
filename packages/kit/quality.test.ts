import { describe, expect, test } from "bun:test"
import {
  AdaptiveQualityController,
  QUALITY_PROFILES,
  loadSavedQualityMode,
  resolveQualityMode,
  saveQualityMode,
  selectStartupTier,
} from "./quality"

describe("@arcade/kit/quality", () => {
  test("resolves quality modes and storage persistence", () => {
    expect(resolveQualityMode("auto")).toBe("auto")
    expect(resolveQualityMode("high")).toBe("high")
    expect(resolveQualityMode("balanced")).toBe("balanced")
    expect(resolveQualityMode("low")).toBe("low")
    expect(resolveQualityMode("2x")).toBe("high")
    expect(resolveQualityMode("1.5x")).toBe("balanced")
    expect(resolveQualityMode("1x")).toBe("low")
    expect(resolveQualityMode("unknown")).toBe("auto")

    const store = new Map<string, string>()
    const mockStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    expect(loadSavedQualityMode(mockStorage)).toBeNull()
    saveQualityMode(mockStorage, "balanced")
    expect(loadSavedQualityMode(mockStorage)).toBe("balanced")
  })

  test("startup auto-select keeps full Retina (high) when GPU/frame time fits budget", () => {
    expect(selectStartupTier(16.6, 5.2)).toBe("high")
    expect(selectStartupTier(16.6, 18.2)).toBe("balanced")
    expect(selectStartupTier(28.0, 25.0)).toBe("low")

    const ctrl = new AdaptiveQualityController({
      mode: "auto",
      warmupFrames: 3,
      startupSamples: 6,
    })
    let now = 100
    for (let i = 0; i < 9; i++) {
      now += 16.6
      ctrl.recordFrame(16.6, 4.2, now)
    }
    const st = ctrl.state(2.0)
    expect(st.startupResolved).toBe(true)
    expect(st.activeTier).toBe("high")
    expect(st.pixelRatio).toBe(2.0)
    expect(st.adaptations).toBe(0)
  })

  test("startup auto-select drops to balanced or low when initial frames run long", () => {
    const ctrl = new AdaptiveQualityController({
      mode: "auto",
      warmupFrames: 2,
      startupSamples: 6,
    })
    let now = 100
    let changed = false
    for (let i = 0; i < 8; i++) {
      now += 21.0
      if (ctrl.recordFrame(21.0, 19.2, now)) changed = true
    }
    expect(changed).toBe(true)
    const st = ctrl.state(2.0)
    expect(st.startupResolved).toBe(true)
    expect(st.activeTier).toBe("balanced")
    expect(st.pixelRatio).toBe(1.5)
  })

  test("runtime hysteresis steps resolution down quickly on overload and recovers slowly after consecutive good windows", () => {
    const ctrl = new AdaptiveQualityController({
      mode: "auto",
      warmupFrames: 2,
      startupSamples: 4,
      adaptWindowMs: 500,
      minWindowSamples: 5,
      recoverWindows: 3,
    })
    let now = 0
    for (let i = 0; i < 6; i++) {
      now += 16.6
      ctrl.recordFrame(16.6, 4.0, now)
    }
    expect(ctrl.state(2.0).activeTier).toBe("high")
    expect(ctrl.state(2.0).resolutionScale).toBe(1.0)

    // Spike GPU to 21 ms for one 500 ms window -> drops resolutionScale from 1.0 to 0.9
    for (let i = 0; i < 12; i++) {
      now += 50
      ctrl.recordFrame(22.0, 21.0, now)
    }
    expect(ctrl.state(2.0).resolutionScale).toBe(0.9)
    expect(ctrl.state(2.0).pixelRatio).toBe(1.8)

    // 2 comfortable windows are not enough to step up (recoverWindows = 3)
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < 12; i++) {
        now += 50
        ctrl.recordFrame(16.6, 5.0, now)
      }
      expect(ctrl.state(2.0).resolutionScale).toBe(0.9)
    }

    // 3rd consecutive comfortable window steps resolutionScale up by +0.05 to 0.95
    for (let i = 0; i < 12; i++) {
      now += 50
      ctrl.recordFrame(16.6, 5.0, now)
    }
    expect(ctrl.state(2.0).resolutionScale).toBe(0.95)
  })

  test("manual tier override locks exact profile and ignores runtime adaptation", () => {
    const ctrl = new AdaptiveQualityController({
      mode: "balanced",
      warmupFrames: 1,
      startupSamples: 2,
      adaptWindowMs: 100,
      minWindowSamples: 2,
    })
    let now = 0
    for (let i = 0; i < 20; i++) {
      now += 30
      expect(ctrl.recordFrame(30, 28, now)).toBe(false)
    }
    const st = ctrl.state(2.0)
    expect(st.mode).toBe("balanced")
    expect(st.activeTier).toBe("balanced")
    expect(st.resolutionScale).toBe(1.0)
    expect(st.pixelRatio).toBe(QUALITY_PROFILES.balanced.dprCap)
  })
})
