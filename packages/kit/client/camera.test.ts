import { describe, expect, test } from "bun:test"
import {
  Camera,
  HitStop,
  attenuateShake,
  cameraShakeControls,
  cameraShakeDefaults,
  TraumaShake,
  kickVector,
  shakeWave,
  smoothNoise1D,
} from "./camera"

describe("Camera shake, directional kick, and HitStop", () => {
  test("cameraShakeDefaults and cameraShakeControls have valid ranges and steps", () => {
    const defaults = cameraShakeDefaults()
    for (const c of cameraShakeControls) {
      expect(c.key in defaults).toBe(true)
      if ("min" in c) {
        expect(c.max).toBeGreaterThan(c.min)
        expect(c.step).toBeGreaterThan(0)
      }
    }
  })

  test("smoothNoise1D is continuous, bounded in [-1, 1], and varies smoothly", () => {
    let maxStepDelta = 0
    let prev = smoothNoise1D(0, 101)
    for (let i = 1; i <= 400; i++) {
      const cur = smoothNoise1D(i * 0.01, 101)
      expect(cur).toBeGreaterThanOrEqual(-1)
      expect(cur).toBeLessThanOrEqual(1)
      maxStepDelta = Math.max(maxStepDelta, Math.abs(cur - prev))
      prev = cur
    }
    expect(maxStepDelta).toBeLessThan(0.08)
  })

  test("Camera.add applies trauma², directional kick, and decays cleanly to zero", () => {
    const cam = new Camera()
    cam.snap(10, 20)
    cam.add(0.5, 0, 2.5)
    expect(cam.trauma).toBeCloseTo(0.5, 5)

    cam.follow(10, 20, 0, 0, 1 / 60, false)
    cam.update(16 / 9)
    expect(cam.offset.x).toBeGreaterThan(0.01)
    expect(Math.abs(cam.offset.roll)).toBeGreaterThan(0)

    for (let i = 0; i < 180; i++) {
      cam.follow(10, 20, 0, 0, 1 / 60, false)
      cam.update(16 / 9)
    }
    expect(cam.trauma).toBe(0)
    expect(Math.hypot(cam.offset.x, cam.offset.z)).toBeLessThan(1e-3)
  })

  test("rapid kicks and trauma are clamped by maxShakeOffset, maxShakeRoll, and maxKickOffset", () => {
    const cam = new Camera()
    cam.snap(0, 0)
    for (let i = 0; i < 30; i++) {
      cam.add(0.4, 0.3, 4.0)
      cam.punch(0.6, 0.02)
      cam.follow(0, 0, 0, 0, 1 / 60, false)
      cam.update(16 / 9)
      expect(cam.trauma).toBeLessThanOrEqual(1)
      expect(Math.hypot(cam.offset.x, cam.offset.z)).toBeLessThanOrEqual(
        cam.shakeSettings.maxKickOffset + cam.shakeSettings.maxShakeOffset * 1.5,
      )
      expect(Math.abs(cam.offset.roll)).toBeLessThanOrEqual(0.05 + cam.shakeSettings.maxShakeRoll + 1e-4)
    }
  })

  test("reduceMotion suppresses shake, kick, zoom punch, and roll", () => {
    const settings = cameraShakeDefaults()
    settings.reduceMotion = 1
    const cam = new Camera(settings)
    cam.snap(5, 5)
    cam.add(0.8, Math.PI / 4, 3.5)
    cam.punch(0.5, 0.02)
    cam.follow(5, 5, 0, 0, 1 / 60, false)
    cam.update(16 / 9)
    expect(cam.trauma).toBe(0)
    expect(cam.offset).toEqual({ x: 0, z: 0, zoom: 0, roll: 0 })
  })

  test("attenuateShake, kickVector, damageFlash, and HitStop work independently", () => {
    expect(attenuateShake(0, 20)).toBe(1)
    expect(attenuateShake(10, 20)).toBeCloseTo(0.25, 5)
    expect(attenuateShake(20, 20)).toBe(0)
    expect(attenuateShake(25, 20)).toBe(0)

    const [kx, kz] = kickVector(0, 3)
    expect(kx).toBeCloseTo(3, 5)
    expect(kz).toBeCloseTo(0, 5)

    const cam = new Camera()
    cam.addFlash(0.6)
    expect(cam.damageFlash).toBeCloseTo(0.6, 5)
    cam.follow(0, 0, 0, 0, 0.1, false)
    expect(cam.damageFlash).toBeLessThan(0.6)
    expect(cam.damageFlash).toBeGreaterThan(0.2)

    const hs = new HitStop()
    hs.trigger(0.03, 0.1)
    const vdt1 = hs.step(0.016)
    expect(vdt1).toBeCloseTo(0.0016, 5)
    const vdt2 = hs.step(0.02)
    expect(vdt2).toBeCloseTo(0.014 * 0.1 + 0.006, 5)
    expect(hs.remaining).toBe(0)
  })
})

describe("TraumaShake for rig-owned cameras", () => {
  test("add caps, raise holds the larger, decay keeps a floor, drain is linear", () => {
    const s = new TraumaShake()
    s.add(0.3, 0.45)
    s.add(0.3, 0.45)
    expect(s.trauma).toBeCloseTo(0.45, 6)
    s.raise(0.2)
    expect(s.trauma).toBeCloseTo(0.45, 6)
    s.raise(3)
    expect(s.trauma).toBe(1)
    s.decay(1, 2.2, 0.1)
    expect(s.trauma).toBeCloseTo(Math.exp(-2.2), 6)
    s.decay(10, 2.2, 0.1)
    expect(s.trauma).toBeCloseTo(0.1, 6)
    s.drain(0.1, 2.4)
    expect(s.trauma).toBe(0)
  })

  test("intensity is trauma² of the larger source, scaled, and zero under reduced motion", () => {
    const settings = cameraShakeDefaults()
    const s = new TraumaShake(settings)
    s.raise(0.5)
    expect(s.intensity()).toBeCloseTo(0.25, 6)
    expect(s.intensity(0.8)).toBeCloseTo(0.64, 6)
    expect(s.intensity(2)).toBeCloseTo(1, 6)
    settings.shakeScale = 2
    expect(s.intensity()).toBeCloseTo(0.5, 6)
    settings.reduceMotion = 1
    expect(s.intensity()).toBe(0)
  })

  test("shakeWave mixes two sines 0.6/0.4, or is one plain sine", () => {
    expect(shakeWave(0.3, 23.1, 0, 37.7, 1.3)).toBeCloseTo(Math.sin(0.3 * 23.1) * 0.6 + Math.sin(0.3 * 37.7 + 1.3) * 0.4, 9)
    expect(shakeWave(0.3, 53.7, 1)).toBeCloseTo(Math.sin(0.3 * 53.7 + 1), 9)
  })
})
