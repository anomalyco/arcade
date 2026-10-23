import { expect, test } from "bun:test"
import { planCreature, trunkBetween } from "../shared/creature"
import { FLARE_BEAT, FLARE_SCRAPE, flareSources, flareTable, flyFor, launchBody, layFlare, stepFlareBodies, type Flare } from "../shared/flares"
import { applyFlares, flareRow, packIntent, TICK_DT, unpackIntent } from "../shared/protocol"
import { createWoods, FEEL, FLARE_SEEN, SIGNAL_HOLD_SECONDS, stepWoods, type PlayerInput, type WoodsEvent, type WoodsState } from "../shared/sim"
import { isDeepWater, makeWorld } from "../shared/world"

const world = makeWorld()
const input = (o: Partial<PlayerInput> = {}): PlayerInput => ({ yaw: 0.4, pitch: 0.1, light: true, tie: false, map: false, mx: 0, mz: 0, ...o })

/** Steps solo for `seconds` with the flare key as `key(t)` gives it; returns the events. */
function run(state: WoodsState, seconds: number, key: (t: number) => boolean, dt = 1 / 60): WoodsEvent[] {
  const out: WoodsEvent[] = []
  for (let i = 0; i < Math.round(seconds / dt); i++) {
    stepWoods(state, world, new Map([[0, input({ flare: key(state.t) })]]), dt)
    out.push(...state.events)
  }
  return out
}

test("a tap strikes the flare, it catches, flares up in the hand, then is thrown and comes to rest", () => {
  const state = createWoods(world, 0)
  const me = state.players[0]!
  expect(me.flares).toBe(1)
  const events = run(state, 6, (t) => t < 0.05)
  const struck = events.find((e) => e.kind === "flare-struck")!, thrown = events.find((e) => e.kind === "flare-thrown")!
  expect(struck).toBeTruthy()
  expect(thrown).toBeTruthy()
  expect(me.flares).toBe(0)
  const f = state.flares.list[0]!
  expect(f.lit).toBeCloseTo((struck as { at: number }).at + FLARE_SCRAPE, 3)
  expect((thrown as { at: number }).at).toBeGreaterThanOrEqual(f.lit + FLARE_BEAT - 1e-6)
  expect(f.body?.rest).toBe(true)
  const d = Math.hypot(f.body!.x - me.x, f.body!.z - me.z)
  expect(d).toBeGreaterThan(3)
  expect(d).toBeLessThan(25)
  // A second tap with an empty pocket does nothing.
  expect(run(state, 2, (t) => t < 6.1).some((e) => e.kind === "flare-struck")).toBe(false)
})

test("holding the key keeps it lit in the hand; letting go throws it", () => {
  const state = createWoods(world, 0)
  run(state, 4, () => true)
  const f = state.flares.list[0]!
  expect(f.thrown).toBe(-1)
  const src = flareSources(state.flares, world, state.players, state.t, FEEL)
  expect(src[0]?.held).toBe(true)
  expect(src[0]!.level).toBeGreaterThan(0.9)
  const events = run(state, 0.1, () => false)
  expect(events.some((e) => e.kind === "flare-thrown")).toBe(true)
})

test("the room and a client fly the same throw to the same spot at any step size", () => {
  const state = createWoods(world, 0)
  run(state, 1.2, (t) => t < 0.05, TICK_DT)
  const f = state.flares.list[0]!
  expect(f.launch).not.toBeNull()
  run(state, 6, () => false, TICK_DT)
  const room = f.body!
  for (const frame of [1 / 144, 1 / 60, 1 / 37]) {
    const client: Flare = { ...f, body: launchBody(f) }
    for (let i = 0; i < 6 / frame && !client.body!.rest; i++) flyFor(world, client, frame)
    const mm = (v: number) => Math.round(v * 1000) / 1000
    expect(client.body!.rest).toBe(true)
    expect([mm(client.body!.x), mm(client.body!.y), mm(client.body!.z)]).toEqual([room.x, room.y, room.z])
  }
})

test("the wire carries the flare: intent bit, rows, a flight caught up and its resting place", () => {
  expect(unpackIntent(packIntent(input({ flare: true }))).flare).toBe(true)
  expect(unpackIntent(packIntent(input({ flare: false, sprint: true }))).flare).toBe(false)
  const state = createWoods(world, 0)
  run(state, 1, (t) => t < 0.05, TICK_DT)
  const view = createWoods(world, 0)
  applyFlares(view.flares, { spares: state.flares.spares, rows: state.flares.list.map(flareRow) }, state.t, (f, s) => flyFor(world, f, s))
  const copy = view.flares.list[0]!
  expect(copy.launch).toEqual(state.flares.list[0]!.launch)
  expect(copy.body!.rest).toBe(false)
  run(state, 6, () => false, TICK_DT)
  applyFlares(view.flares, { spares: state.flares.spares, rows: state.flares.list.map(flareRow) }, state.t, (f, s) => flyFor(world, f, s))
  expect(view.flares.list[0]!.body!.rest).toBe(true)
  expect(view.flares.list[0]!.body!.x).toBe(state.flares.list[0]!.body!.x)
  expect(view.flares.list[0]!.body!.z).toBe(state.flares.list[0]!.body!.z)
})

test("an empty pocket takes a spare at the camp table", () => {
  const state = createWoods(world, 0)
  const me = state.players[0]!
  me.flares = 0
  const t = flareTable(world)
  // Stand just off the table's edge.
  Object.assign(me, { x: t.x, z: t.z + 1.2 })
  const events = run(state, 0.2, () => false)
  expect(events.some((e) => e.kind === "flare-picked")).toBe(true)
  expect(me.flares).toBe(1)
  expect(state.flares.spares).toBe(1)
})

test("a flare burns out and goes; maps within sight of one burning mark it", () => {
  const state = createWoods(world, 0)
  const me = state.players[0]!
  const f = layFlare(state, world, me.x + 60, me.z, 5)
  run(state, 0.1, () => false)
  expect(me.map.flares.length).toBe(2)
  expect(Math.abs(me.map.flares[0]! - f.body!.x)).toBeLessThan(0.01)
  const far = layFlare(state, world, me.x, me.z + FLARE_SEEN + 30, 5)
  run(state, 0.1, () => false)
  expect(me.map.flares.length).toBe(2)
  void far
  const feel = { ...FEEL, flareBurn: 10 }
  stepFlareBodies(state.flares, world, state.t + 60, 1 / 60, feel, new Set([0]))
  expect(state.flares.list.length).toBe(0)
})

test("a burning flare 70 m off in sight is a backdrop the creature can cross", () => {
  let line: { x: number; z: number; bx: number; bz: number; yaw: number } | null = null
  search: for (let x = -150; x <= 150; x += 7) for (let z = -150; z <= 150; z += 7) {
    if (isDeepWater(world, x, z) || Math.hypot(x - world.camp.x, z - world.camp.z) < 40) continue
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2, bx = x + Math.cos(a) * 70, bz = z + Math.sin(a) * 70
      if (Math.abs(bx) > 180 || Math.abs(bz) > 180 || isDeepWater(world, bx, bz)) continue
      if (!trunkBetween(world, x, z, bx, bz, 0.3)) { line = { x, z, bx, bz, yaw: Math.atan2(-(bx - x), -(bz - z)) }; break search }
    }
  }
  expect(line).not.toBeNull()
  const me = { x: line!.x, z: line!.z, yaw: line!.yaw, pitch: 0, light: true, bot: false, id: 0, signal: 0 }
  const feel = { ...FEEL, creature: "figure" as const }
  let without = 0, withFlare = 0
  for (let seed = 1; seed < 12; seed++) {
    if (planCreature(world, [me], feel, { seed }, SIGNAL_HOLD_SECONDS)) without++
    if (planCreature(world, [me], feel, { seed }, SIGNAL_HOLD_SECONDS, false, [{ x: line!.bx, z: line!.bz, by: -1, held: false, level: 1 }])) withFlare++
  }
  expect(withFlare).toBeGreaterThan(without)
})

test("jump and the flare key are different bits on the wire", () => {
  const both = unpackIntent(packIntent(input({ jump: true, flare: true })))
  expect([both.jump, both.flare]).toEqual([true, true])
  const jump = unpackIntent(packIntent(input({ jump: true })))
  expect([jump.jump, jump.flare]).toEqual([true, false])
  const flare = unpackIntent(packIntent(input({ flare: true })))
  expect([flare.jump, flare.flare]).toEqual([false, true])
})

test("someone taken while holding a lit flare lets it fall, and it burns on the ground where they were", () => {
  const state = createWoods(world, 0)
  const me = state.players[0]!
  run(state, 2, () => true)
  const f = state.flares.list[0]!
  expect(f.thrown).toBe(-1)
  me.capture = { by: 900, left: 30 }
  const events = run(state, 3, () => true)
  expect(events.some((e) => e.kind === "flare-dropped" && e.flare === f.id)).toBe(true)
  expect(me.flareLatch).toBe(false)
  expect(f.body?.rest).toBe(true)
  expect(Math.hypot(f.body!.x - me.x, f.body!.z - me.z)).toBeLessThan(1)
  const src = flareSources(state.flares, world, state.players, state.t, FEEL)
  expect(src.map((s) => [s.id, s.held])).toEqual([[f.id, false]])
  // Taken, they strike nothing, even with another in the pocket and the key down.
  me.flares = 1
  expect(run(state, 1, () => true).some((e) => e.kind === "flare-struck")).toBe(false)
  expect(state.flares.list.length).toBe(1)
})
