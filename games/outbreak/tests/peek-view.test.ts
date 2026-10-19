import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { sightRects } from "../shared/map"
import { LocalSession } from "../shared/session"
import { DEFAULT_VISION, Vision } from "../shared/vision"
import { DEFAULT_PEEK_VIEW, lerpAngle, PeekView, sightAsPeek } from "../src/peek-view"

const S = DEFAULT_PEEK_VIEW

/** Outside Ash, facing its south-west window, pressing E to peek in. */
function peeking() {
  const session = new LocalSession(7)
  const p = session.view.player
  Object.assign(p, { x: 24.5, y: 36.1, vx: 0, vy: 0, aim: -Math.PI / 2 })
  session.rebuildCollision()
  session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
  return { session, p, peek: session.view.peek! }
}

describe("peek blend", () => {
  test("eases in over the peek time with no jump, and out a little quicker", () => {
    const view = new PeekView()
    const { peek } = peeking()
    let prev = 0
    let frames = 0
    while (view.blend < 1 && frames < 200) {
      view.step(1 / 60, peek, S)
      expect(view.blend - prev).toBeLessThan(0.1)
      prev = view.blend
      frames++
    }
    expect(frames / 60).toBeCloseTo(S.peekTime, 1)
    let out = 0
    while (view.blend > 0 && out < 200) {
      view.step(1 / 60, null, S)
      out++
    }
    expect(out).toBeLessThan(frames)
    expect(view.step(1 / 60, null, S)).toBeNull()
  })

  test("the aim turns the short way to the window instead of snapping; Today snapped", () => {
    const { peek, p } = peeking()
    const view = new PeekView()
    view.step(S.peekTime / 2, peek, S)
    const bodyAim = Math.PI / 2 // facing away from the window
    const mid = view.sight(peek, peek, p, bodyAim, DEFAULT_VISION, S)
    // Half way through, the aim is between the body's and the window's (they differ by π, so π/2 off either).
    expect(Math.abs(lerpAngle(peek.aim, mid.aim, 1) - peek.aim)).toBeGreaterThan(0.5)
    expect(Math.abs(mid.aim - bodyAim)).toBeGreaterThan(0.5)
    const today = new PeekView()
    today.step(0.05, peek, { ...S, peekStyle: 0 })
    expect(today.sight(peek, peek, p, bodyAim, DEFAULT_VISION, { ...S, peekStyle: 0 }).aim).toBe(peek.aim)
  })

  test("a window's eye sits in the opening, so the lawn along the wall on your side stays in sight", () => {
    const { session, p, peek } = peeking()
    expect(peek.peephole).toBe(false)
    expect(peek.eyeY).toBeCloseTo(35.39, 2)
    const view = new PeekView()
    for (let i = 0; i < 40; i++) view.step(1 / 60, peek, S)
    const sight = view.sight(peek, peek, p, p.aim, DEFAULT_VISION, S)
    const vision = new Vision()
    vision.update(p.x, p.y, p.aim, sightRects(session.view.town), DEFAULT_VISION, sightAsPeek(peek, sight))
    expect(vision.visible(30, 33)).toBe(true) // into the room
    expect(vision.visible(21, 35.9)).toBe(true) // along the façade outside, beside you
  })

  test("a door's peephole eye crosses the shut door at the midpoint, never inside it", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    Object.assign(p, { x: 27.7, y: 34.6, vx: 0, vy: 0, aim: Math.PI / 2 })
    session.rebuildCollision()
    session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: true, sprint: true }, 0)
    const peek = session.view.peek!
    expect(peek.peephole).toBe(true)
    const view = new PeekView()
    const door = session.view.town.doors.find((d) => d.id === "ash-front")!.rect
    for (let i = 0; i < 30; i++) {
      view.step(1 / 60, peek, S)
      const s = view.sight(peek, peek, p, p.aim, DEFAULT_VISION, S)
      const inside = s.x > door[0] && s.x < door[2] && s.y > door[1] && s.y < door[3]
      expect(inside).toBe(false)
    }
  })
})
