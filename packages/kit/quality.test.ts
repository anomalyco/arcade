import { describe, expect, test } from "bun:test"
import {
  AdaptiveQualityController,
  QUALITY_PROFILES,
  loadSavedQualityMode,
  resolveQualityMode,
  saveQualityMode,
  selectStartupTier,
  type QualityScaling,
  type QualityTiers,
} from "./quality"
import { GameQuality, qualityStorageKey } from "./client/quality"

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

  test("GameQuality: per-game tiers, saved choice, URL pin, floor-sized canvas and change callbacks", () => {
    const tiers: QualityTiers<QualityScaling & { shadows: number }> = {
      high: { tier: "high", label: "High", dprCap: 2, minScale: 0.7, shadows: 2048 },
      balanced: { tier: "balanced", label: "Balanced", dprCap: 1.5, minScale: 0.6, shadows: 2048 },
      low: { tier: "low", label: "Low", dprCap: 1, minScale: 0.5, shadows: 1024 },
    }
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    const seen: number[] = []
    const q = new GameQuality({ game: "demo", tiers, storage, onChange: (p) => seen.push(p.shadows) })
    expect(q.mode).toBe("auto")
    expect(q.profile.tier).toBe("high")
    const canvas = { width: 0, height: 0 }
    expect(q.fit(canvas, 1001, 701, 2)).toBe(true)
    expect(canvas).toEqual({ width: 2002, height: 1402 })
    expect(q.fit(canvas, 1001, 701, 2)).toBe(false)

    q.setMode("low")
    expect(seen).toEqual([1024])
    expect(store.get(qualityStorageKey("demo"))).toBe("low")
    q.fit(canvas, 1001, 701, 2)
    expect(canvas).toEqual({ width: 1001, height: 701 })
    q.setMode("balanced")
    q.fit(canvas, 1001, 701, 2)
    // floor(1001 × 1.5): the same size the games' old MAX_DPR = 1.5 resize produced.
    expect(canvas).toEqual({ width: 1501, height: 1051 })

    expect(new GameQuality({ game: "demo", tiers, storage }).mode).toBe("balanced")
    const pinned = new GameQuality({ game: "demo", tiers, storage, params: new URLSearchParams("quality=high") })
    expect(pinned.mode).toBe("high")
    expect(store.get(qualityStorageKey("demo"))).toBe("balanced")
    expect((pinned.labControl() as unknown as { options: { value: string }[] }).options.map((o) => o.value)).toEqual(["auto", "high", "balanced", "low"])
  })

  test("GameQuality Auto steps a slow GPU down to a smaller tier and reports it", () => {
    const tiers: QualityTiers = {
      high: { tier: "high", label: "High", dprCap: 2, minScale: 0.7 },
      balanced: { tier: "balanced", label: "Balanced", dprCap: 1.5, minScale: 0.6 },
      low: { tier: "low", label: "Low", dprCap: 1, minScale: 0.5 },
    }
    let gpu = 26
    const tiersSeen: string[] = []
    const q = new GameQuality({ game: "slow", tiers, storage: null, gpuMs: () => gpu, onChange: (p) => tiersSeen.push(p.tier) })
    let now = 1000
    for (let i = 0; i < 60; i++) q.frame((now += 30))
    expect(q.profile.tier).toBe("low")
    expect(tiersSeen.at(-1)).toBe("low")
    expect(q.describe(2)).toContain("Auto → Low")
    gpu = 4
    q.pause()
    expect(q.pixelRatio(2)).toBe(1)
  })
})
