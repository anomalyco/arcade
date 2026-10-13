import { expect, test } from "bun:test"
import { PROP_KINDS, SPECS } from "../src/game/props/placement"
import { propMesh } from "../src/render/props-mesh"
import { FLOATS_PER_VERT, Mesh } from "../src/render/mesh"
import { bench, hydrant, barrier } from "../src/render/city/props"

function bounds(mesh: Mesh) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.v.length; i += FLOATS_PER_VERT) for (let axis = 0; axis < 3; axis++) {
    min[axis] = Math.min(min[axis]!, mesh.v[i + axis]!)
    max[axis] = Math.max(max[axis]!, mesh.v[i + axis]!)
  }
  return { min, max, size: max.map((value, i) => value - min[i]!) }
}

test("every authored prop fits its physical collider with the same ground origin", () => {
  for (const kind of PROP_KINDS) {
    const mesh = bounds(propMesh(kind)), spec = SPECS[kind]
    for (let axis = 0; axis < 3; axis++) {
      expect(mesh.min[axis]!, `${kind} min axis ${axis}`).toBeCloseTo(-spec.size[axis]! / 2, 5)
      expect(mesh.max[axis]!, `${kind} max axis ${axis}`).toBeCloseTo(spec.size[axis]! / 2, 5)
    }
  }
})

test("bench seating and legacy city furniture have human-scale dimensions", () => {
  const m = new Mesh()
  bench(m, 0, 0, true, 0)
  expect(bounds(m).size).toEqual([1.8, .85, .55])
  // Seat is a real upward-facing surface at 45 cm, not a uniformly shrunk high seat.
  const seat = []
  for (let i = 0; i < m.v.length; i += FLOATS_PER_VERT) if (Math.abs(m.v[i + 1]! - .45) < 1e-8 && m.v[i + 4]! > .99) seat.push(m.v[i]!)
  expect(Math.max(...seat) - Math.min(...seat)).toBeCloseTo(1.8, 6)
  const h = new Mesh(); hydrant(h, 0, 0, 0)
  expect(bounds(h).size).toEqual([.3, .75, .3])
  const a = new Mesh(); barrier(a, 0, 0, true)
  expect(bounds(a).size).toEqual([2, 1.1, .7])
})

test("furniture dimensions match the scale brief in metres", () => {
  const expected = { cone: .7, bin: 1, dumpster: 1.2, newspaper: 1, bench: .85, planter: .6, hydrant: .75, meter: 1.3, mailbox: 1.1 }
  for (const [kind, height] of Object.entries(expected)) expect(bounds(propMesh(kind as keyof typeof expected)).size[1]).toBeCloseTo(height, 6)
  expect(bounds(propMesh("dumpster")).size).toEqual([1.8, 1.2, 1.2])
})
