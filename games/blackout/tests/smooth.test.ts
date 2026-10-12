import { describe, expect, test } from "bun:test"
import { DT, SPRINT_SPEED } from "../shared/config"
import { type Body, stepBody } from "../shared/sim/move"
import { Smoothed } from "../src/game/smooth"
import { Camera } from "../src/render/camera"

const W = 1536
const H = 1024

/** Sprints east at a display refresh rate the way the frame loop does; returns the character's screen x per frame. */
function sprint(hz: number, smooth: boolean): number[] {
  const body: Body = { x: 10, y: 10, vx: SPRINT_SPEED, vy: 0 }
  const drawn = new Smoothed()
  drawn.reset(body)
  const cam = new Camera()
  cam.snap(body.x, body.y)
  const dt = 1 / hz
  let acc = 0
  const xs: number[] = []
  for (let f = 0; f < hz * 2; f++) {
    acc += dt
    while (acc >= DT) {
      acc -= DT
      drawn.tick(body)
      stepBody(body, 1, 0, SPRINT_SPEED, [], DT)
    }
    drawn.update(body, acc / DT, dt)
    const p = smooth ? drawn : body
    cam.follow(p.x, p.y, 0, 0, dt, false)
    cam.update(W / H)
    if (f > hz) xs.push(cam.project(p.x, 0.9, p.y, W, H).x)
  }
  return xs
}

/** The largest frame-to-frame change in on-screen speed, pixels per frame. */
function judder(xs: number[]): number {
  let worst = 0
  for (let i = 2; i < xs.length; i++) worst = Math.max(worst, Math.abs(xs[i]! - 2 * xs[i - 1]! + xs[i - 2]!))
  return worst
}

describe("drawing the predicted body", () => {
  test("the raw 30 Hz body flips between two spots on screen at 60 Hz", () => {
    expect(judder(sprint(60, false))).toBeGreaterThan(10)
  })

  for (const hz of [60, 120, 144]) {
    test(`interpolated between ticks it holds steady on screen at ${hz} Hz`, () => {
      expect(judder(sprint(hz, true))).toBeLessThan(0.5)
    })
  }

  test("a correction keeps the drawn position, then blends out", () => {
    const body = { x: 5, y: 5 }
    const d = new Smoothed()
    d.reset(body)
    d.update(body, 0, 1 / 60)
    body.x += 0.4
    d.correct(0.4, 0)
    d.update(body, 0, 0)
    expect(d.x).toBeCloseTo(5, 6)
    for (let i = 0; i < 60; i++) d.update(body, 0, 1 / 60)
    expect(d.x).toBeCloseTo(5.4, 3)
  })
})
