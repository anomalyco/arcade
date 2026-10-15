import { describe, expect, test } from "bun:test"
import {
  applyFeelPreset,
  createFeelSettings,
  FEEL_PRESET_IDS,
  FEEL_PRESETS,
  feelControls,
  GameFeel,
  randomizeFeelSettings,
  smoothNoise1D,
} from "./index"

describe("@arcade/kit/feel", () => {
  test("all presets and Lab controls have valid ranges, steps and units", () => {
    expect(FEEL_PRESET_IDS).toEqual(["outbreak", "blackout", "getaway", "subtle", "off"])
    for (const id of FEEL_PRESET_IDS) {
      const s = createFeelSettings(id)
      expect(s.feelPreset).toBe(id)
      expect(s.feelIntensity).toBeGreaterThanOrEqual(0)
      expect(s.feelIntensity).toBeLessThanOrEqual(2)
    }
    for (const c of feelControls) {
      expect(c.group).toBe("Feel")
      if ("min" in c) {
        expect(c.max).toBeGreaterThan(c.min)
        expect(c.step).toBeGreaterThan(0)
        expect(typeof c.unit).toBe("string")
      }
    }
  })

  test("smoothNoise1D is continuous, bounded in [-1, 1], and non-constant across time", () => {
    let min = Infinity
    let max = -Infinity
    let maxStepDiff = 0
    let prev = smoothNoise1D(0, 101)
    for (let i = 1; i <= 400; i++) {
      const t = i * 0.02
      const v = smoothNoise1D(t, 101)
      min = Math.min(min, v)
      max = Math.max(max, v)
      maxStepDiff = Math.max(maxStepDiff, Math.abs(v - prev))
      prev = v
    }
    expect(min).toBeGreaterThanOrEqual(-1)
    expect(max).toBeLessThanOrEqual(1)
    expect(max - min).toBeGreaterThan(0.5)
    // Smooth C2 interpolation prevents discontinuous jumps across small steps
    expect(maxStepDiff).toBeLessThan(0.15)
  })

  test("shot event applies opposite recoil kick, trauma², zoom/roll punch, and directional motion blur burst", () => {
    const feel = new GameFeel(createFeelSettings("outbreak"))
    // Shoot east (dir = 0 -> +X)
    feel.emit("shot", { power: 1, dir: 0 })
    expect(feel.trauma).toBeGreaterThan(0)
    expect(feel.kickVx).toBeLessThan(0) // Recoil kicks west (-X)
    expect(Math.abs(feel.kickVz)).toBeLessThan(1e-6)
    expect(feel.blurX).toBeGreaterThan(0)
    expect(feel.radialBlur).toBeGreaterThan(0)
    expect(feel.chromatic).toBeGreaterThan(0)

    const off = feel.step(1 / 60)
    expect(off.x).toBeLessThan(0)
    expect(off.zoom).toBeGreaterThan(0)
    expect(feel.post[0]).not.toBe(0)
    expect(feel.post[2]).toBeGreaterThan(0)
    expect(feel.post[3]).toBeGreaterThan(0)

    // After 1.5 seconds of rest, all offsets and post bursts decay back to 0
    for (let i = 0; i < 90; i++) feel.step(1 / 60)
    expect(feel.trauma).toBe(0)
    expect(Math.abs(feel.offset.x)).toBeLessThan(1e-3)
    expect(Math.abs(feel.offset.z)).toBeLessThan(1e-3)
    expect(feel.post).toEqual([0, 0, 0, 0])
  })

  test("shove event lunges forward along aim and triggers presentation hit-stop only when connecting", () => {
    const feel = new GameFeel(createFeelSettings("outbreak"))
    // Whiffed shove (hits: 0): lunges forward, no hit-stop
    feel.emit("shove", { dir: Math.PI / 2, hits: 0 })
    expect(feel.kickVz).toBeGreaterThan(0)
    expect(feel.hitStopRemaining).toBe(0)
    expect(feel.visualDt(1 / 60)).toBeCloseTo(1 / 60, 6)

    // Connected shove (hits: 2): stronger lunge + hit-stop time dilation
    feel.reset()
    feel.emit("shove", { dir: Math.PI / 2, hits: 2 })
    expect(feel.hitStopRemaining).toBeGreaterThan(0.02)
    expect(feel.visualDt(1 / 60)).toBeLessThan((1 / 60) * 0.2)

    // Stepping advances hit-stop on real wall dt without sticking
    for (let i = 0; i < 6; i++) feel.step(1 / 60)
    expect(feel.hitStopRemaining).toBe(0)
    expect(feel.visualDt(1 / 60)).toBeCloseTo(1 / 60, 6)
  })

  test("hit-taken scales damage vignette pulse, trauma, and directional kick by damage", () => {
    const light = new GameFeel(createFeelSettings("outbreak"))
    const heavy = new GameFeel(createFeelSettings("outbreak"))
    light.emit("hit-taken", { damage: 10, dx: 1, dz: 0 })
    heavy.emit("hit-taken", { damage: 35, dx: 1, dz: 0 })

    expect(heavy.damageFlash).toBeGreaterThan(light.damageFlash)
    expect(heavy.trauma).toBeGreaterThan(light.trauma)
    expect(heavy.kickVx).toBeGreaterThan(light.kickVx)
  })

  test("explosion and barricade-bash attenuate with distance and vanish beyond radius", () => {
    const near = new GameFeel(createFeelSettings("outbreak"))
    const mid = new GameFeel(createFeelSettings("outbreak"))
    const far = new GameFeel(createFeelSettings("outbreak"))

    near.emit("explosion", { x: 10, z: 10, listenerX: 12, listenerZ: 10, radius: 22 })
    mid.emit("explosion", { x: 10, z: 10, listenerX: 20, listenerZ: 10, radius: 22 })
    far.emit("explosion", { x: 10, z: 10, listenerX: 35, listenerZ: 10, radius: 22 })

    expect(near.trauma).toBeGreaterThan(mid.trauma)
    expect(mid.trauma).toBeGreaterThan(0)
    expect(far.trauma).toBe(0)
    expect(far.kickVx).toBe(0)
    expect(far.radialBlur).toBe(0)

    const bashIntact = new GameFeel(createFeelSettings("outbreak"))
    const bashBroke = new GameFeel(createFeelSettings("outbreak"))
    bashIntact.emit("barricade-bash", { distance: 4, broke: false })
    bashBroke.emit("barricade-bash", { distance: 4, broke: true })
    expect(bashBroke.trauma).toBeGreaterThan(bashIntact.trauma)
    expect(bashBroke.radialBlur).toBeGreaterThan(bashIntact.radialBlur)
  })

  test("reduced motion (explicit setting or OS prefers-reduced-motion) suppresses shake, kick, hit-stop, and blur", () => {
    const s = createFeelSettings("outbreak")
    s.feelReduceMotion = 1
    const feel = new GameFeel(s)

    feel.emit("shot", { power: 1.5, dir: 0 })
    feel.emit("shove", { power: 1.5, dir: 1, hits: 2 })
    feel.emit("explosion", { distance: 2 })
    feel.emit("hit-taken", { damage: 40, dx: 1, dz: 0 })

    const off = feel.step(1 / 60)
    expect(off).toEqual({ x: 0, y: 0, z: 0, zoom: 0, roll: 0 })
    expect(feel.post).toEqual([0, 0, 0, 0])
    expect(feel.visualDt(1 / 60)).toBe(1 / 60)
    // Damage flash is still permitted as a gentle non-motion cue, capped <= 0.35
    expect(feel.damageFlash).toBeGreaterThan(0)
    expect(feel.damageFlash).toBeLessThanOrEqual(0.35)

    // Also test OS prefers-reduced-motion when feelReduceMotion === 0 (Auto)
    const autoFeel = new GameFeel(createFeelSettings("outbreak"))
    autoFeel.osReducedMotionOverride = true
    autoFeel.emit("shot", { power: 1, dir: 0 })
    expect(autoFeel.step(1 / 60)).toEqual({ x: 0, y: 0, z: 0, zoom: 0, roll: 0 })
    expect(autoFeel.post).toEqual([0, 0, 0, 0])
  })

  test("rapid fire clamps maximum kick, zoom and roll so the camera never drifts off screen", () => {
    const feel = new GameFeel(createFeelSettings("blackout"))
    for (let i = 0; i < 60; i++) {
      feel.emit("shot", { power: 2.5, dir: 0 })
      feel.step(1 / 120)
    }
    const maxK = FEEL_PRESETS.blackout.maxKickMeters
    const maxS = FEEL_PRESETS.blackout.maxShakeMeters
    expect(Math.hypot(feel.kickX, feel.kickZ)).toBeLessThanOrEqual(maxK + 1e-5)
    expect(Math.hypot(feel.offset.x, feel.offset.z)).toBeLessThanOrEqual(maxK + maxS * 1.5)
    expect(Math.abs(feel.offset.zoom)).toBeLessThanOrEqual(2.5)
    expect(Math.abs(feel.offset.roll)).toBeLessThanOrEqual(0.06)
  })

  test("randomizeFeelSettings is deterministic by seed and applyFeelPreset restores preset defaults", () => {
    const a = createFeelSettings("outbreak")
    const b = createFeelSettings("outbreak")
    randomizeFeelSettings(a, 777)
    randomizeFeelSettings(b, 777)
    expect(a).toEqual(b)

    applyFeelPreset(a, "subtle")
    expect(a.feelPreset).toBe("subtle")
    expect(a.feelIntensity).toBe(FEEL_PRESETS.subtle.settings.feelIntensity)
  })
})
