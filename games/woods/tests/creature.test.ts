import { expect, test } from "bun:test"
import { CREATURE_FIRST, CREATURE_INTERVAL, CREATURE_MIN, segmentDistance, triggerCreature, trunkBetween, type CreatureEvent } from "../shared/creature"
import { createWoods, FEEL, SIGNAL_HOLD_SECONDS, stepWoods, type PlayerInput, type WoodsState } from "../shared/sim"
import { isDeepWater, makeWorld } from "../shared/world"

const world = makeWorld()

/** A spot out in the woods with a clear 70 m line of sight to another (where a friend can stand signalling). */
function clearLine() {
  for (let x = -150; x <= 150; x += 7) for (let z = -150; z <= 150; z += 7) {
    if (isDeepWater(world, x, z) || Math.hypot(x - world.camp.x, z - world.camp.z) < 40) continue
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, bx = x + Math.cos(a) * 70, bz = z + Math.sin(a) * 70
      if (Math.abs(bx) > 180 || Math.abs(bz) > 180 || isDeepWater(world, bx, bz)) continue
      if (!trunkBetween(world, x, z, bx, bz, 0.3)) return { x, z, bx, bz, yaw: Math.atan2(-(bx - x), -(bz - z)) }
    }
  }
  throw new Error("no clear line")
}
const line = clearLine()

/** You stand looking at a friend (a bot) 70 m off who holds their beam up the whole night. */
function night(minutes: number, feel = { ...FEEL, creature: true }) {
  const state = createWoods(world, 1)
  const you = state.players[0]!, bot = state.players[1]!, brain = state.brains[0]!
  const input: PlayerInput = { yaw: line.yaw, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 }
  const seen: CreatureEvent[] = []
  for (let i = 0; i < minutes * 60 * 60; i++) {
    Object.assign(you, { x: line.x, z: line.z, vx: 0, vz: 0 })
    Object.assign(bot, { x: line.bx, z: line.bz, vx: 0, vz: 0 })
    brain.mode = "found"; brain.timer = 24
    stepWoods(state, world, new Map([[0, input]]), 1 / 60, feel)
    for (const e of state.events) if (e.kind === "creature") seen.push(e)
  }
  return { state, seen }
}

test("off by default: the room's feel never sends it", () => {
  expect(FEEL.creature).toBe(false)
  expect(night(8, FEEL).seen).toEqual([])
})

test("rare, seeded and never early: the same night gives the same sightings, minutes apart, none in the first four minutes", () => {
  const a = night(16).seen, b = night(16).seen
  expect(a.length).toBeGreaterThanOrEqual(2)
  expect(b).toEqual(a)
  expect(a[0]!.at).toBeGreaterThanOrEqual(CREATURE_FIRST)
  for (let i = 1; i < a.length; i++) expect(a[i]!.at - a[i - 1]!.at).toBeGreaterThanOrEqual(CREATURE_INTERVAL * 0.6 - 1e-6)
})

test("distant and brief: it crosses in front of the friend's light 45–80 m out, under 1.2 s, never within 35 m of anyone", () => {
  const { seen } = night(16)
  for (const e of seen) {
    expect(e.dur).toBeGreaterThanOrEqual(0.5)
    expect(e.dur).toBeLessThanOrEqual(1.2)
    expect(segmentDistance(line.x, line.z, e.x0, e.z0, e.x1, e.z1)).toBeGreaterThanOrEqual(CREATURE_MIN)
    // Where its path cuts your line of sight to the friend: inside the band, in front of the light.
    const ux = (line.bx - line.x) / 70, uz = (line.bz - line.z) / 70
    const px = e.x1 - e.x0, pz = e.z1 - e.z0
    const s0 = (e.x0 - line.x) * -uz + (e.z0 - line.z) * ux, s1 = (e.x1 - line.x) * -uz + (e.z1 - line.z) * ux
    expect(Math.sign(s0)).not.toBe(Math.sign(s1))
    const k = s0 / (s0 - s1), cx = e.x0 + px * k, cz = e.z0 + pz * k
    const along = (cx - line.x) * ux + (cz - line.z) * uz
    expect(along).toBeGreaterThanOrEqual(44.9)
    expect(along).toBeLessThanOrEqual(66.1)
  }
})

test("it only comes with a light to cross: nobody's beam out there, no sighting", () => {
  const state = createWoods(world, 0)
  const you = state.players[0]!
  Object.assign(you, { x: line.x, z: line.z })
  const feel = { ...FEEL, creature: true, creatureRate: 5 }
  let n = 0
  for (let i = 0; i < 12 * 60 * 60; i++) {
    stepWoods(state, world, new Map([[0, { yaw: line.yaw, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 }]]), 1 / 60, feel)
    n += state.events.filter((e) => e.kind === "creature").length
  }
  expect(n).toBe(0)
})

test("Trigger now places one at once by the same rules and keeps the distant sounds off it", () => {
  const state: WoodsState = createWoods(world, 1)
  Object.assign(state.players[0]!, { x: line.x, z: line.z, yaw: line.yaw })
  Object.assign(state.players[1]!, { x: line.bx, z: line.bz, pitch: 1.35, light: true })
  const e = triggerCreature(state.distant, world, state.players, 5, { ...FEEL, creature: true }, SIGNAL_HOLD_SECONDS)
  expect(e).not.toBeNull()
  expect(segmentDistance(line.x, line.z, e!.x0, e!.z0, e!.x1, e!.z1)).toBeGreaterThanOrEqual(CREATURE_MIN)
  expect(state.distant.busyUntil).toBeGreaterThan(5 + e!.dur)
})
