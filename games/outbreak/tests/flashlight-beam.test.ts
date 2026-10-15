import { describe, expect, test } from "bun:test"
import { beamPose, beamScreenRect, beamWeatherAir, flashlightVolumeShader } from "../src/flashlight-beam"

describe("flashlight beam pose and shaft", () => {
  const down = -0.5
  const gun = { p: [10.4, 1.05, 20] as const, d: [Math.cos(down), Math.sin(down), 0] as const, mounted: true }

  test("a pistol light follows the barrel's yaw but never dips past the pool-distance tilt", () => {
    const beam = beamPose(gun, 10, 20, 1.2, 0, 5.5, [])
    expect(beam.yaw).toBeCloseTo(0, 5)
    expect(beam.h).toBeCloseTo(1.05, 5)
    expect(beam.pitch).toBeCloseTo(-Math.atan2(1.05, 5.5), 5)
    const raised = beamPose({ ...gun, d: [1, 0.05, 0] }, 10, 20, 0, 0, 5.5, [])
    expect(raised.pitch).toBeCloseTo(Math.atan2(0.05, 1), 5)
  })

  test("a hand-held light points along the aim at the pool tilt", () => {
    const hand = { p: [10, 1.1, 20.3] as const, d: [0, 0, 1] as const, mounted: false }
    const beam = beamPose(hand, 10, 20, Math.PI, 0, 4, [])
    expect(beam.yaw).toBeCloseTo(Math.PI, 5)
    expect(beam.pitch).toBeCloseTo(-Math.atan2(1.1, 4), 5)
  })

  test("the lens is pulled back out of a wall the hand reaches into", () => {
    const wall = [10.2, 19, 10.6, 21] as const
    const beam = beamPose(gun, 10, 20, 0, 0, 5.5, [wall])
    expect(beam.x).toBeLessThan(10.2)
    expect(beam.x).toBeGreaterThan(10)
  })

  test("the screen rect stays on screen and holds the lens", () => {
    // Orthographic-ish stand-in projection: plan x, z map straight to the screen.
    const project = (x: number, _y: number, z: number) => ({ x: x / 40, y: z / 40, ok: true })
    const rect = beamScreenRect(project, [10, 1.1, 20], 0, -0.2, 0.49, 12, 0)
    expect(rect[0]).toBeLessThanOrEqual(10 / 40)
    expect(rect[2]).toBeGreaterThan(20 / 40)
    for (const v of rect) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })

  test("rain and mist thicken the air, capped", () => {
    expect(beamWeatherAir({ intensity: 0, mist: 0 })).toBe(0)
    expect(beamWeatherAir({ intensity: 1, mist: 1 })).toBeCloseTo(1.8, 6)
    expect(beamWeatherAir({ intensity: 3, mist: 3 })).toBe(2)
  })

  test("the volume shader binds only the frame, lights, polar map and custom uniforms", () => {
    const bindings = [...flashlightVolumeShader.code.matchAll(/@binding\((\d+)\)/g)].map((m) => Number(m[1])).sort((a, b) => a - b)
    expect(bindings).toEqual([0, 1, 2, 13])
    expect(flashlightVolumeShader.code).toContain("@fragment fn fs")
    expect(flashlightVolumeShader.code).toContain("@vertex fn vs")
  })
})
