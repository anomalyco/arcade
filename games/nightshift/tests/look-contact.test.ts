import { expect, test } from "bun:test"
import { bakeContact, LOOK_CONTACT } from "../src/look/contact"
import { buildWorld, occluders } from "../src/world"

test("contact map darkens the carpet at partition feet and under desks, and leaves the aisle open", () => {
  buildWorld(false)
  const size = 256, started = performance.now(), map = bakeContact(occluders, size)
  const at = (x: number, z: number) => {
    const i = Math.floor((x - LOOK_CONTACT.x) / LOOK_CONTACT.w * size), j = Math.floor((z - LOOK_CONTACT.z) / LOOK_CONTACT.d * size)
    return [map[(j * size + i) * 4]!, map[(j * size + i) * 4 + 1]!]
  }
  expect(at(0, 0)[0]).toBeGreaterThan(250)
  expect(at(0, 0)[1]).toBe(0)
  // Beside the aisle partition at x 1.18 (z −2 row), on its aisle side.
  expect(at(1.18 - .045 - .03, -2)[0]).toBeLessThan(170)
  // Under the hero desk (top at 0.79 m).
  expect(at(-.2, -5.55)[1]).toBeGreaterThan(190)
  expect(performance.now() - started).toBeLessThan(1500)
})
