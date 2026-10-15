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

    // The window straddling the drop still holds slow frames: no change, and not yet comfortable.
    for (let i = 0; i < 12; i++) {
      now += 50
      ctrl.recordFrame(16.6, 5.0, now)
    }
    expect(ctrl.state(2.0).resolutionScale).toBe(0.9)

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

  /** Frames through a 60 Hz, one-frame-in-flight pipeline: CPU + GPU past a tick misses it. GPU scales with pixels. */
  function play(ctrl: AdaptiveQualityController, seconds: number, cpuMs: number, gpuAt2x: number, start = 0) {
    const tick = 1000 / 60
    let now = start
    let frames = 0
    let missed = 0
    let n = 0
    while (now < start + seconds * 1000) {
      const share = (ctrl.effectivePixelRatio(2) / 2) ** 2
      const gpu = gpuAt2x * (0.17 + 0.83 * share) * (1 + (((n++ * 7919) % 25) - 12) / 100)
      const interval = Math.max(1, Math.ceil((cpuMs + gpu) / tick - 1e-6)) * tick
      now += interval
      frames++
      if (interval > tick + 0.5) missed++
      ctrl.recordFrame(interval, gpu, now)
    }
    return { now, missed: missed / frames }
  }

  test("a GPU 2.5× slower than the Studio at full Retina: Auto sheds pixels when CPU + GPU miss the tick", () => {
    // 13.5 ms GPU (under the old 0.85 budget gate) plus 3.5 ms of serial CPU: most frames miss 60 fps.
    const ctrl = new AdaptiveQualityController({ mode: "auto" })
    const settle = play(ctrl, 10, 3.5, 13.5)
    const after = play(ctrl, 10, 3.5, 13.5, settle.now)
    expect(ctrl.state(2).pixelRatio).toBeLessThan(2)
    expect(after.missed).toBeLessThan(0.08)
  })

  test("GPU time alone with no headroom steps down even before frames miss", () => {
    const ctrl = new AdaptiveQualityController({ mode: "auto", warmupFrames: 0, startupSamples: 4 })
    const { now } = play(ctrl, 0.1, 0.5, 8)
    expect(ctrl.state(2).pixelRatio).toBe(2)
    play(ctrl, 3, 0.5, 15.5, now)
    expect(ctrl.state(2).resolutionScale).toBeLessThan(1)
  })

  test("CPU-bound slow frames and main-thread hitches drop a tier (not resolution), after a few windows", () => {
    const ctrl = new AdaptiveQualityController({ mode: "auto", warmupFrames: 0, startupSamples: 4, cpuWindows: 3 })
    let now = 0
    for (let i = 0; i < 4; i++) ctrl.recordFrame(16.7, 4, (now += 16.7))
    expect(ctrl.getActiveTier()).toBe("high")
    // One adaptation window (1 s) of frames.
    const window = (frame: (i: number) => number) => {
      const end = now + 1000
      for (let i = 0; now < end; i++) {
        const ms = frame(i)
        ctrl.recordFrame(ms, 4, (now += ms))
      }
    }
    window(() => 33.4)
    window(() => 33.4)
    expect(ctrl.getActiveTier()).toBe("high")
    window(() => 33.4)
    window(() => 33.4)
    expect(ctrl.getActiveTier()).toBe("balanced")
    expect(ctrl.state(2).pixelRatio).toBe(1.5)

    // Streaming or HUD hitches: a 60 ms main-thread stall four times a second, GPU idle.
    const hitchy = new AdaptiveQualityController({ mode: "auto", warmupFrames: 0, startupSamples: 4, cpuWindows: 3 })
    now = 0
    for (let i = 0; i < 4; i++) hitchy.recordFrame(16.7, 4, (now += 16.7))
    for (let w = 0; w < 5; w++) for (let i = 0; i < 60; i++) {
      const ms = i % 15 === 0 ? 60 : 16.7
      hitchy.recordFrame(ms, 4, (now += ms))
    }
    expect(hitchy.getActiveTier()).toBe("balanced")
  })

  test("a step up that is undone soon after doubles the wait before the next", () => {
    const ctrl = new AdaptiveQualityController({ mode: "auto", warmupFrames: 0, startupSamples: 4 })
    let now = 0
    const window = (frameMs: number, gpu: number) => {
      for (let i = 0; i < 61; i++) ctrl.recordFrame(frameMs, gpu, (now += frameMs))
    }
    for (let i = 0; i < 4; i++) ctrl.recordFrame(16.7, 4, (now += 16.7))
    window(16.7, 16) // 0.9 budget: down to 0.9
    expect(ctrl.getResolutionScale()).toBe(0.9)
    let changes = 0
    let scale = ctrl.getResolutionScale()
    // A load that fits at 0.9 but not at 0.95: each step up is undone, and the steps up get rarer.
    for (let w = 0; w < 40; w++) {
      window(16.7, ctrl.getResolutionScale() > 0.9 ? 16 : 8)
      if (ctrl.getResolutionScale() !== scale) changes++, (scale = ctrl.getResolutionScale())
    }
    // Without backoff a 3-window recovery would bounce ~20 times in 40 windows.
    expect(changes).toBeLessThan(9)
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
