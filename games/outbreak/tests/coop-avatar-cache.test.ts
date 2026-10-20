import { expect, test } from "bun:test"
import type { Vision } from "../shared/vision"
import { LocalSession } from "../shared/session"
import { CoopView } from "../src/coop-view"

test("remote survivor churn reuses uploaded models for every seat and variant", () => {
  let uploads = 0
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const slots = [0, 1, 2, 3].map((index) => ({ ...session.slot, id: `peer-${index}`, index }))
  const net = { remotes: slots, variantOfSeat: (index: number) => index }
  // Exercise the production body lifecycle without constructing its DOM lobby or GPU device.
  const view: CoopView = Object.assign(Object.create(CoopView.prototype), {
    renderer: { addModel: () => uploads++ }, net, avatars: new Map(), avatarCache: new Map(),
    hidden: () => false,
  })
  const vision = { visible: () => true } as unknown as Vision
  const draw = () => view.bodies(1 / 60, 0, session.sim.town, vision)
  for (let round = 0; round < 4; round++) {
    net.variantOfSeat = (index) => (index + round) % 4
    expect(draw().length).toBeGreaterThan(0)
  }
  const warmed = uploads
  expect(warmed).toBeGreaterThan(0)
  for (let round = 0; round < 12; round++) {
    net.remotes = []
    expect(draw()).toHaveLength(0)
    net.remotes = slots
    net.variantOfSeat = (index) => (index + round) % 4
    expect(draw().length).toBeGreaterThan(0)
  }
  expect(uploads).toBe(warmed)
})
