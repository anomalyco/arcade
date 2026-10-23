import { describe, expect, test } from "bun:test"
import { makePlane } from "../shared/plane"
import { FlightFeel } from "../src/flight/feel"

/** Runs a 9 g pull with a missile at 0.5 s for `secs` at `fps`, returning the feel. */
function run(fps: number, secs: number): FlightFeel {
  const feel = new FlightFeel()
  const p = makePlane()
  p.g = 9
  p.p = 0.8
  p.r = 1.5
  const dt = 1 / fps
  let fired = false
  for (let t = 0; t < secs - 1e-9; t += dt) {
    if (!fired && t >= 0.5 - 1e-9) {
      feel.missile()
      fired = true
    }
    feel.update(p, dt, true)
  }
  return feel
}

describe("flight feel", () => {
  test("sustained g builds the grey-out, unloading clears it", () => {
    const feel = run(60, 4)
    expect(feel.grey).toBeGreaterThan(0.4)
    expect(feel.red).toBe(0)
    const p = makePlane()
    for (let i = 0; i < 240; i++) feel.update(p, 1 / 60, true)
    expect(feel.grey).toBeLessThan(0.02)
  })

  test("negative g reds out", () => {
    const feel = new FlightFeel()
    const p = makePlane()
    p.g = -4
    for (let i = 0; i < 240; i++) feel.update(p, 1 / 60, true)
    expect(feel.red).toBeGreaterThan(0.5)
  })

  test("the same at any frame rate", () => {
    for (const secs of [0.62, 1.5]) {
      const a = run(30, secs)
      const b = run(144, secs)
      expect(Math.abs(a.grey - b.grey)).toBeLessThan(0.02)
      expect(Math.abs(a.offsets.roll - b.offsets.roll)).toBeLessThan(0.005)
      expect(Math.abs(a.offsets.up - b.offsets.up)).toBeLessThan(0.03)
    }
  })

  test("a missile release bumps the jet up and settles", () => {
    expect(run(60, 0.6).bump).toBeGreaterThan(0.1)
    expect(Math.abs(run(60, 3).bump)).toBeLessThan(0.01)
  })
})
