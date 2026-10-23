import { expect, test } from "bun:test"
import { CREATURES } from "../shared/creatures"
import { Episode, policyShape } from "../shared/episode"
import { jointAngle, worldHash } from "../shared/physics"
import { Policy, initParams } from "../shared/policy"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { HumanRealism } from "../shared/realism"
import { envFor } from "../shared/tasks"

test("human mass, one-way elbows/knees and heel/toe support", () => {
  const c = CREATURES.human
  expect(c.bodies.length).toBe(13)
  expect(c.bodies.reduce((a, b) => a + b.m, 0)).toBeCloseTo(75, 10)
  for (const j of c.joints) {
    if (j.name.startsWith("knee")) expect(j.upper).toBe(0)
    if (j.name.startsWith("elbow")) expect(j.lower).toBe(0)
  }
  const ep = new Episode("human", "room", null)
  for (let i = 0; i < 12; i++) ep.step()
  for (const foot of c.feet) {
    const contacts = ep.world.contacts.filter(c => c.a === foot && c.pn > .01)
    expect(contacts.length).toBe(2)
  }
  expect(ep.realism!.illegalContactSeconds).toBe(0)
  expect(ep.realism!.metrics(1).steps).toBe(0)
})

test("human policy, contacts and metrics replay bit-identically", () => {
  const shape = policyShape("human", 8)
  const weights = initParams(shape, mulberry32(7))
  const run = () => {
    const ep = new Episode("human", "heist", new Policy(shape, weights))
    while (!ep.done) ep.step()
    return { ...ep.result(), hash: worldHash(ep.world.bodies) }
  }
  expect(run()).toEqual(run())
})

test("human PD muscles obey joint and force–velocity limits under extreme targets", () => {
  const ep = new Episode("human", "room", null)
  const action = new Float64Array(12)
  for (let i = 0; i < 240; i++) {
    action.fill(i < 120 ? 1 : -1)
    ep.done = false
    ep.step(action)
    for (const j of ep.world.joints) {
      const a = jointAngle(ep.world.bodies, j)
      expect(a).toBeGreaterThanOrEqual(j.lower - .15)
      expect(a).toBeLessThanOrEqual(j.upper + .15)
      expect(Math.abs(j.torque)).toBeLessThanOrEqual(j.limit + 1e-8)
      expect(j.limit).toBeLessThanOrEqual(j.maxTorque * 1.3)
    }
  }
})

// Feed real loaded collision contacts to the rules, with isolated links so a pose doesn't hide the contact type.
function contact(body: number, crouched: boolean, zone: boolean, strength = 1) {
  const ep = new Episode("human", envFor("heist", { stage: 1 }), null)
  ep.world.joints.length = 0
  const b = ep.world.bodies[body]!
  b.y = Math.abs(b.s * b.hl) + b.r
  b.vy = -1
  ep.torso.x = zone ? 4 : 0
  if (crouched && body !== 1) ep.torso.y = .6
  ep.world.step(1 / 120)
  const r = new HumanRealism()
  r.step(ep.world, ep.level, 1, 1 / 60, strength)
  return r
}
test("hands and knees only support a lowered human in an obstacle zone; head/torso always fall", () => {
  for (const body of [10, 12, 3, 6]) {
    expect(contact(body, true, true).illegalContactSeconds).toBe(0)
    expect(contact(body, false, true).illegalContactSeconds).toBeGreaterThan(0)
    expect(contact(body, true, false).illegalContactSeconds).toBeGreaterThan(0)
  }
  // A vertical shin's distal end is not a knee; sliding on it is still illegal inside the crawl zone.
  expect(contact(4, true, true).illegalContactSeconds).toBeGreaterThan(0)
  for (const body of [0, 1, 2]) expect(contact(body, true, true).fall).toBe(true)
  expect(contact(10, true, false, 0).penalty).toBe(0)
})

test("gem requires the hand tip, not proximity of the head or torso", () => {
  const ep = new Episode("human", "heist", null)
  const [hx, hy] = ep.gripAt(), gem = ep.level.gem!
  for (const b of ep.world.bodies) { b.x += gem.x - hx; b.y += gem.y - hy }
  ep.step()
  expect(ep.carrying).toBe(true)
  expect(ep.gemAt()).toEqual(ep.gripAt())
  const miss = new Episode("human", "heist", null)
  for (const b of miss.world.bodies) { b.x += gem.x; b.y += gem.y - 1.63 }
  miss.step()
  expect(miss.carrying).toBe(false)
})
