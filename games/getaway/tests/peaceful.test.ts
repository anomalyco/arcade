import { expect, test } from "bun:test"
import { LocalSession } from "../src/game/session"

test("peaceful seed 7 gives identical five-minute drives without cops or round endings", () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "location")
  const random = Math.random
  Object.defineProperty(globalThis, "location", { configurable: true, value: { search: "?peaceful=1&seed=7" } })
  try {
    const run = () => {
      const session = new LocalSession("Dax", { robber: "muscle", cop: "cruiser" })
      const input = { throttle: 1, brake: 0, steer: 0, handbrake: false, boost: false }
      let view = session.update(0, input)
      for (let tick = 0; tick < 18000; tick++) {
        input.steer = Math.sin(tick / 120) * 0.3
        view = session.update(1 / 60, input)
      }
      expect(session.world.phase).toBe("waiting")
      expect(session.world.cops()).toHaveLength(0)
      expect(session.world.heli.active).toBe(false)
      expect(session.world.cars).toHaveLength(1)
      return view
    }
    expect(run()).toEqual(run())
  } finally {
    Math.random = random
    if (saved) Object.defineProperty(globalThis, "location", saved)
    else Reflect.deleteProperty(globalThis, "location")
  }
})
