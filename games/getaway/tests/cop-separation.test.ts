import { expect, test } from "bun:test"
import { DT } from "../shared/config"
import { copBrain } from "../shared/sim/bots"
import { carShape, shapeGap } from "../shared/sim/collide"
import { newBody, NO_INPUT } from "../shared/sim/vehicle"
import { World } from "../shared/sim/world"
import { bot, human } from "./sim-helpers"

function chase() {
  const w = new World(7, [human("r"), ...["a", "b", "c", "d"].map(bot)])
  w.phase = "chase"; w.phaseT = 30; w.robberId = "r"
  // A clear avenue isolates cop spacing from ramps, buildings and gadgets.
  w.city.boxes = []; w.city.ramps = []
  w.carOf("r")!.role = "robber"
  Object.assign(w.carOf("r")!.body, newBody(228, 150, 0), { vz: 26 })
  for (const [i, c] of w.cars.filter(c => c.ownerId !== "r").entries()) {
    c.role = "cop"
    Object.assign(c.body, newBody(226 + i % 2 * 4, 124 - Math.floor(i / 2) * 6, 0), { vz: 26 })
    for (const g of c.gadgets) g.charges = 0
  }
  return w
}

test("four cops pursuing one moving target keep space without cop crash events, deterministically", () => {
  const a = chase(), b = chase()
  let minimum = Infinity
  let gap = Infinity
  for (let tick = 0; tick < 240; tick++) {
    for (const w of [a, b]) {
      w.setInput("r", { ...NO_INPUT, throttle: 1, boost: true })
      w.step(DT)
    }
    expect(a.view()).toEqual(b.view())
    const cops = a.cops()
    for (let i = 0; i < cops.length; i++) {
      const c = cops[i]!
      expect(c.body.stun).toBe(0)
      expect(c.impact).toBe(0)
      for (const d of cops.slice(i + 1)) {
        minimum = Math.min(minimum, Math.hypot(c.body.x - d.body.x, c.body.z - d.body.z))
        gap = Math.min(gap, shapeGap(carShape(c.body, c.vehicle), carShape(d.body, d.vehicle)))
      }
    }
    expect(a.events.filter(e => e.kind === "impact")).toHaveLength(0)
  }
  expect(minimum).toBeGreaterThan(2) // Cruiser width is 1.95 m.
  expect(gap).toBeGreaterThan(-0.4) // Soft bumper overlap is allowed; stacked bodies are not.
})

test("separation responds more strongly to closing traffic and leaves isolated pursuit alone", () => {
  const w = chase(), a = w.carOf("a")!, b = w.carOf("b")!
  w.cars = [w.carOf("r")!, a, b]
  Object.assign(a.body, newBody(226, 124, 0), { vz: 20 })
  Object.assign(b.body, newBody(229, 128, 0), { vz: 20 })
  const parallel = copBrain(w, a)
  b.body.vz = 0
  const closing = copBrain(w, a)
  expect(closing.steer).toBeLessThan(parallel.steer)
  expect(closing.brake).toBeGreaterThan(parallel.brake)
  expect(closing.boost).toBe(false)
  b.body.x = 500
  const far = copBrain(w, a)
  w.cars.pop()
  expect(copBrain(w, a)).toEqual(far)
})

test("overlapping cops gently separate without impulse or stun, respecting height and frozen phases", () => {
  for (const variant of ["overlap", "above", "frozen"] as const) {
    const w = chase(), a = w.carOf("a")!, b = w.carOf("b")!
    w.cars = [a, b]; w.phase = variant === "frozen" ? "intro" : "waiting"
    a.human = b.human = true
    Object.assign(a.body, newBody(228, 120, 0))
    Object.assign(b.body, newBody(228, 120, 0), variant === "above" ? { y: 4, airborne: true } : {})
    for (let i = 0; i < 15; i++) w.step(DT)
    const distance = Math.hypot(a.body.x - b.body.x, a.body.z - b.body.z)
    if (variant === "overlap") expect(distance).toBeGreaterThan(1.5)
    else expect(distance).toBe(0)
    for (const c of [a, b]) {
      expect(c.body.vx).toBe(0); expect(c.body.vz).toBe(0)
      expect(c.body.stun).toBe(0); expect(c.impact).toBe(0)
    }
  }
})
