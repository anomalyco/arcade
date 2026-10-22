import { describe, expect, test } from "bun:test"
import { LIGHT_FLOATS } from "@arcade/kit/limits"
import { Vision } from "../shared/vision"
import { createOutbreakSettings } from "../src/settings"
import { MATE_BEAM_CONE_W, mateBeamSight, TEAM_BEAMS_FULL, writeMateBeam } from "../src/teammates/beams"

describe("teammates' flashlights (playtest Oct 21)", () => {
  test("full beams are the default, Today one setting away", () => {
    const settings = createOutbreakSettings()
    expect(settings.flashlight.teamBeams).toBe(TEAM_BEAMS_FULL)
    expect(settings.flashlight.teamBeamPower).toBe(1)
  })

  test("a teammate's beam packs at full range with its own axis and pitch", () => {
    const lights = new Float32Array(4 * LIGHT_FLOATS)
    writeMateBeam(lights, 2, { x: 10, y: 20, h: 1.3, yaw: Math.PI / 2, pitch: -0.2 }, 19, [1, 0.9, 0.7], 0.48, 56, 0.35, 12)
    const slot = Array.from(lights.subarray(2 * LIGHT_FLOATS, 3 * LIGHT_FLOATS))
    expect(slot[0]).toBe(10)
    expect(slot[2]).toBe(20)
    expect(slot[3]).toBe(19)
    expect(slot[9]).toBeCloseTo(1)
    // Its own nominal half-angle (a low local battery must not narrow it) and the shaft in the cone code's fraction.
    expect(slot[10]).toBeCloseTo((56 * Math.PI) / 360)
    expect(slot[11]).toBeCloseTo(MATE_BEAM_CONE_W + 0.35 * 0.2)
    expect(slot[12]).toBeCloseTo(-0.2)
    expect(slot[13]).toBe(12)
  })

  test("zombies a teammate lights are seen past your own cone and range, never through walls", () => {
    const vision = new Vision()
    const wall: [number, number, number, number] = [30, 0, 31, 60]
    // You look north from (10, 10) with a 27 m sight; your teammate stands at (20, 40) shining east.
    vision.update(10, 10, -Math.PI / 2, [wall], { range: 8, cone: 90, awareness: 1.5 }, null, null, false)
    expect(vision.actorVisible(26, 40)).toBe(0)
    vision.setBeams([mateBeamSight(20, 40, 0, 19, 56, 1)], [wall], [])
    expect(vision.actorVisible(26, 40)).toBe(1)
    expect(vision.visible(26, 40)).toBe(true)
    // Behind the teammate, or past the wall in the beam's path: still dark.
    expect(vision.actorVisible(14, 40)).toBe(0)
    expect(vision.actorVisible(34, 40)).toBe(0)
  })

  test("a teammate holding a lit torch shows wherever you have a clear line to them", () => {
    const vision = new Vision()
    const wall: [number, number, number, number] = [14, 0, 15, 20]
    vision.update(10, 10, -Math.PI / 2, [wall], { range: 8, cone: 90, awareness: 1.5 }, null, null, false)
    vision.setBeams([mateBeamSight(10, 30, 0, 19, 56, 1), mateBeamSight(18, 10, 0, 19, 56, 1)], [wall], [])
    expect(vision.actorVisible(10, 30)).toBe(1)
    expect(vision.actorVisible(18, 10)).toBe(0)
  })

  test("a beam never shows through a closed window, under a roof drawn for you, or into what you have explored", () => {
    const vision = new Vision()
    const window: [number, number, number, number] = [24, 38, 24.2, 42]
    vision.update(10, 10, -Math.PI / 2, [], { range: 8, cone: 90, awareness: 1.5 }, null, null, false)
    // Sight passes the closed window (it only stops light), but the beam's light does not.
    vision.setBeams([mateBeamSight(20, 40, 0, 19, 56, 1)], [window], [])
    expect(vision.actorVisible(28, 40)).toBe(0)
    expect(vision.actorVisible(22, 40)).toBe(1)
    // A teammate lighting a room whose roof is still on for you shows nothing.
    vision.setBeams([mateBeamSight(20, 40, 0, 19, 56, 1)], [], [[21, 35, 30, 45]])
    expect(vision.actorVisible(26, 40)).toBe(0)
    // Lit rooms are seen, not explored.
    vision.setBeams([mateBeamSight(20, 40, 0, 19, 56, 1)], [], [])
    expect(vision.visible(26, 40)).toBe(true)
    expect(vision.ownVisible(26, 40)).toBe(false)
  })

  test("a dying battery shortens what the beam shows", () => {
    expect(mateBeamSight(0, 0, 0, 19, 56, 0.3).range).toBeCloseTo(19 * 0.45)
    expect(mateBeamSight(0, 0, 0, 19, 56, 1).range).toBe(19)
  })
})
