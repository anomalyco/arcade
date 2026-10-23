import { expect, test } from "bun:test"
import { CREATURE_FIRST, CREATURE_INTERVAL, CREATURE_MIN, planCreature, segmentDistance, triggerCreature, trunkBetween, type CreatureEvent, type Watcher } from "../shared/creature"
import { createWoods, FEEL, SIGNAL_HOLD_SECONDS, stepWoods, type Feel, type PlayerInput, type WoodsState } from "../shared/sim"
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
function night(minutes: number, feel: Feel = { ...FEEL, creature: "figure" }) {
  const state = createWoods(world, 1)
  const you = state.players[0]!, bot = state.players[1]!, brain = state.brains[0]!
  const input: PlayerInput = { yaw: line.yaw, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 }
  const seen: CreatureEvent[] = []
  for (let i = 0; i < minutes * 60 * 60; i++) {
    // Fresh batteries throughout: the night's torches would otherwise die at 8 min (NIGHT.md).
    Object.assign(you, { x: line.x, z: line.z, vx: 0, vz: 0, charge: 1 })
    Object.assign(bot, { x: line.bx, z: line.bz, vx: 0, vz: 0, charge: 1 })
    brain.mode = "found"; brain.timer = 24
    stepWoods(state, world, new Map([[0, input]]), 1 / 60, feel)
    for (const e of state.events) if (e.kind === "creature") seen.push(e)
  }
  return { state, seen }
}

test("on by default, and off sends nothing", () => {
  expect(FEEL.creature).toBe("both")
  expect(night(8, { ...FEEL, creature: "off" }).seen).toEqual([])
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
  const feel = { ...FEEL, creature: "figure" as const, creatureRate: 5 }
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
  const e = triggerCreature(state.distant, world, state.players, 5, { ...FEEL, creature: "figure" as const }, SIGNAL_HOLD_SECONDS)
  expect(e).not.toBeNull()
  expect(segmentDistance(line.x, line.z, e!.x0, e!.z0, e!.x1, e!.z1)).toBeGreaterThanOrEqual(CREATURE_MIN)
  expect(state.distant.busyUntil).toBeGreaterThan(5 + e!.dur)
})

/** You and one friend 70 m off along the clear line, their beam level at `aim` (plan yaw), nothing else lit near. */
function pair(aim: number, pitch = -0.1): Watcher[] {
  return [
    { id: 0, x: line.x, z: line.z, yaw: line.yaw, pitch: 0, light: false, bot: false, signal: 0 },
    { id: 100, x: line.bx, z: line.bz, yaw: aim, pitch, light: true, bot: true, signal: 0 },
  ]
}
const feel = { ...FEEL, creature: "figure" as const }
const back = Math.atan2(-(line.x - line.bx), -(line.z - line.bz))

test("only bright backdrops: a friend's beam across your view gives no sighting, even for Trigger now", () => {
  for (const off of [Math.PI / 2, -Math.PI / 2, Math.PI]) for (let seed = 1; seed < 30; seed++) {
    expect(planCreature(world, pair(back + off), feel, { seed }, SIGNAL_HOLD_SECONDS, true)).toBeNull()
  }
})

test("a friend's beam aimed back at you, or their signal, is a backdrop", () => {
  let aimed = 0, signal = 0
  for (let seed = 1; seed < 30; seed++) {
    if (planCreature(world, pair(back + 0.2), feel, { seed }, SIGNAL_HOLD_SECONDS)) aimed++
    if (planCreature(world, pair(back + 2, 1.35), feel, { seed }, SIGNAL_HOLD_SECONDS)) signal++
  }
  expect(aimed).toBeGreaterThan(20)
  expect(signal).toBeGreaterThan(20)
})

test("camp lights count only from outside camp", () => {
  // The same lit windows, from just inside the camp's far edge and from just outside it.
  const seen = (r: number) => {
    let n = 0
    for (const deg of [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]) {
      const a = (deg * Math.PI) / 180, x = world.camp.x + Math.cos(a) * r, z = world.camp.z + Math.sin(a) * r
      if (isDeepWater(world, x, z)) continue
      for (const l of world.lamps) {
        if (l.kind !== "window") continue
        const me: Watcher = { id: 0, x, z, yaw: Math.atan2(-(l.x - x), -(l.z - z)), pitch: 0, light: false, bot: false, signal: 0 }
        for (let seed = 1; seed < 6; seed++) if (planCreature(world, [me], feel, { seed }, SIGNAL_HOLD_SECONDS)) n++
      }
    }
    return n
  }
  expect(seen(world.camp.radius - 1)).toBe(0)
  expect(seen(world.camp.radius + 12)).toBeGreaterThan(0)
})
