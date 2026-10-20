import { describe, expect, test } from "bun:test"
import { edgeMark, markMode } from "../src/teammates/edge"

// Playtest (Oct 20): "Where'd you guys go?" Kit: "You can easily lose each other."
describe("teammate markers", () => {
  test("off screen pins to the edge on the line from the centre, pointing at them", () => {
    const right = edgeMark(2400, 400, 1280, 800, 28)
    expect(right.onScreen).toBe(false)
    expect(right.x).toBeCloseTo(1280 - 28)
    expect(right.y).toBeCloseTo(400)
    expect(right.angle).toBeCloseTo(0)
    const corner = edgeMark(-5000, -5000, 1280, 800, 28)
    expect(corner.x).toBeGreaterThanOrEqual(28 - 1e-6)
    expect(corner.y).toBeCloseTo(28)
    // Behind the camera, the plan direction decides.
    const behind = edgeMark(0, 0, 1280, 800, 28, false, { x: 0, y: 10 })
    expect(behind.y).toBeCloseTo(800 - 28)
    expect(edgeMark(600, 300, 1280, 800, 28).onScreen).toBe(true)
  })

  test("in plain view nothing; on screen but unseen a ring; off screen an arrow; a nearby downed mate is the death HUD's", () => {
    expect(markMode({ onScreen: true, visible: true, down: false, dist: 5 })).toBeNull()
    expect(markMode({ onScreen: true, visible: false, down: false, dist: 5 })).toBe("ring")
    expect(markMode({ onScreen: false, visible: false, down: false, dist: 60 })).toBe("edge")
    expect(markMode({ onScreen: true, visible: true, down: true, dist: 10 })).toBeNull()
    expect(markMode({ onScreen: true, visible: false, down: true, dist: 40 })).toBe("ring")
    expect(markMode({ onScreen: false, visible: false, down: true, dist: 10 })).toBe("edge")
  })
})
