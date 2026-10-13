import { expect, test } from "bun:test"
import { body, groundNormal, PropPhysics, support, type Body } from "../src/game/props/physics"
import { propGroundShape } from "../src/game/props/contact-shape"
import { SPECS, type PropKind } from "../src/game/props/placement"
import { mulberry32 } from "../shared/sim/rng"

function drop(kind: PropKind, roll: number, pitch: number, spin: number, id: number) {
  const spec = SPECS[kind], [w, h, d] = spec.size
  const b = body(id, 0, 2 + id % 4, 0, w / 2, h / 2, d / 2, spec.mass, id, propGroundShape(kind))
  Object.assign(b, { roll, pitch, wx: spin, wz: -spin * .7, wy: spin * .4, vx: spin * .2 })
  const world = new PropPhysics()
  world.add(b); world.wake(b)
  for (let i = 0; i < 1800 && b.awake; i++) world.update(1 / 120)
  expect(b.awake, `${kind} drop ${id} must actually sleep`).toBe(false)
  expect(b.y).toBeCloseTo(support(b), 6)
  return b
}

// Independent stability check: every small tilt must raise the mass centre, not release stored potential energy.
function stableRest(b: Body) {
  const height = support(b) + groundNormal(b)[1] * b.shape!.centerY
  for (let i = 0; i < 16; i++) {
    const theta = i * Math.PI / 8
    const tilted = { ...b, roll: b.roll + .02 * Math.cos(theta), pitch: b.pitch + .02 * Math.sin(theta) }
    const next = support(tilted) + groundNormal(tilted)[1] * b.shape!.centerY
    expect(next, `drop ${b.id} tilt ${i} must not lower COM`).toBeGreaterThanOrEqual(height - 1e-6)
  }
}

test("cones dropped in 256 seeded orientations never sleep on their tip", () => {
  const random = mulberry32(0xc0ae), poses: Body[] = []
  for (let i = 0; i < 256; i++) {
    const b = drop("cone", random() * Math.PI * 2, Math.asin(random() * 2 - 1), (random() - .5) * 18, i)
    const up = groundNormal(b)
    expect(up[1], `cone ${i} is inverted`).toBeGreaterThan(-.6)
    stableRest(b); poses.push(b)
  }
  expect(poses.some(b => groundNormal(b)[1] > .99)).toBe(true)
  expect(poses.some(b => groundNormal(b)[1] < 0)).toBe(true)
})

test("exactly inverted and almost-inverted cones topple without an external hit", () => {
  for (const [i, offset] of [0, 1e-7, -.001, .01, -.05].entries()) {
    const b = drop("cone", Math.PI + offset, 0, 0, i)
    expect(groundNormal(b)[1]).toBeGreaterThan(-.6)
    stableRest(b)
  }
})

test("barriers, bins, hydrants and signs sleep on supported faces", () => {
  const random = mulberry32(814)
  for (const kind of ["barrier", "sawhorse", "bin", "hydrant", "sign", "meter", "propane"] as const) {
    for (let i = 0; i < 64; i++) {
      const b = drop(kind, i === 0 ? Math.PI : random() * Math.PI * 2, i === 0 ? 0 : Math.asin(random() * 2 - 1), i === 0 ? 0 : (random() - .5) * 12, i)
      stableRest(b)
      if (kind === "hydrant" || kind === "sign" || kind === "barrier") expect(groundNormal(b)[1]).toBeGreaterThan(-.8)
    }
  }
})

test("cone contact follows its tapered shape and low mass centre", () => {
  const shape = propGroundShape("cone")!
  expect(shape.centerY + SPECS.cone.size[1] / 2).toBeCloseTo(.105)
  const b = body(0, 0, 1, 0, .2, .35, .2, 3, 0, shape)
  b.roll = Math.PI - .3
  expect(support(b)).toBeLessThan(support({ ...b, shape: undefined }) - .03)
})

test("shape-aware resting is identical at 30 and 60 Hz", () => {
  const run = (hz: number) => {
    const b = body(0, 0, 3, 0, .2, .35, .2, 3, 0, propGroundShape("cone"))
    b.roll = Math.PI - .1
    const world = new PropPhysics(); world.add(b); world.impulse(b, 2, 1, 3)
    for (let i = 0; i < hz * 8; i++) world.update(1 / hz)
    return [b.x, b.y, b.z, b.roll, b.pitch]
  }
  const thirty = run(30), sixty = run(60)
  thirty.forEach((n, i) => expect(n).toBeCloseTo(sixty[i]!, 8))
})
