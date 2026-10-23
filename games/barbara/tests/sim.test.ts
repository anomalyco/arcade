import { expect, test } from "bun:test"
import type { DistantEvent } from "../shared/distant"
import { createWoods, DISTANT_AFTER_SIGNAL, FEEL, SIGNAL_HOLD_SECONDS, stepWoods, tieTarget, type PlayerInput } from "../shared/sim"
import { groundHeight, isDeepWater, makeWorld, terrainHeight } from "../shared/world"

const world = makeWorld()
const still = (): PlayerInput => ({ yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 })

test("the world is deterministic and plain data", () => {
  const again = makeWorld()
  expect(again.trees.length).toBe(world.trees.length)
  expect(again.trees[123]).toEqual(world.trees[123]!)
  expect(world.markers.length).toBe(4)
  expect(terrainHeight(world.terrain, 10, -20)).toBe(groundHeight(again, 10, -20))
  expect(JSON.parse(JSON.stringify(createWoods(world)))).toBeTruthy()
})

test("camp sits on dry ground by the lake, with no trees in it", () => {
  const { camp, lake } = world
  expect(groundHeight(world, camp.spawn.x, camp.spawn.z)).toBeGreaterThan(lake.level)
  expect(isDeepWater(world, lake.x, lake.z)).toBe(true)
  expect(world.trees.some((t) => Math.hypot(t.x - camp.x, t.z - camp.z) < camp.radius)).toBe(false)
  for (const m of world.markers) expect(Math.hypot(m.x - camp.x, m.z - camp.z)).toBeGreaterThan(100)
})

function standFacing(state: ReturnType<typeof createWoods>, treeId: number) {
  const t = world.trees[treeId]!
  const p = state.players[0]!
  p.x = t.x; p.z = t.z + t.radius + 0.8; p.yaw = 0
  return { yaw: 0, pitch: 0, light: true, map: false, mx: 0, mz: 0 }
}

test("holding tie on a tree for the tie time ties one tape; holding again removes it", () => {
  const state = createWoods(world, 0)
  const tree = world.trees.find((t) => t.species === "pine" && Math.abs(t.x) < 100)!
  const base = standFacing(state, tree.id)
  expect(tieTarget(world, state.players[0]!, FEEL.tapeReach)?.id).toBe(tree.id)
  const hold = (tie: boolean, seconds: number) => { for (let i = 0; i < seconds * 60; i++) stepWoods(state, world, new Map<number, PlayerInput>([[0, { ...base, tie }]]), 1 / 60) }
  hold(true, FEEL.tapeTieTime * 0.5)
  expect(state.tapes.length).toBe(0)
  hold(true, FEEL.tapeTieTime)
  expect(state.tapes.length).toBe(1)
  expect(state.players[0]!.map.tapes).toContain(state.tapes[0]!.id)
  hold(true, 1)
  expect(state.tapes.length).toBe(1)
  // A blip in the held key (a lost input in a room) doesn't start untying what you just tied.
  hold(false, 2 / 60)
  hold(true, FEEL.tapeTieTime * 1.5)
  expect(state.tapes.length).toBe(1)
  hold(false, 0.3)
  hold(true, FEEL.tapeTieTime)
  expect(state.tapes.length).toBe(0)
})

test("a bot keeps at most botTapes up, ties only bare trunks, and a tape that comes down leaves every map", () => {
  const state = createWoods(world, 1, world.params.seed, [])
  const bot = state.players[0]!, brain = state.brains[0]!
  const trees = world.trees.filter((t) => t.species === "pine" && Math.abs(t.x) < 120).slice(0, FEEL.botTapes + 3)
  const tieAt = (id: number) => {
    const t = world.trees[id]!
    Object.assign(bot, { x: t.x, z: t.z + t.radius + 0.8, vx: 0, vz: 0 })
    Object.assign(brain, { mode: "tie", heading: 0, timer: FEEL.tapeTieTime + 0.6 })
    for (let i = 0; i < 60 * 2; i++) { stepWoods(state, world, new Map(), 1 / 60); bot.x = t.x; bot.z = t.z + t.radius + 0.8 }
  }
  for (const t of trees) tieAt(t.id)
  const mine = state.tapes.filter((t) => t.by === bot.id)
  expect(mine.length).toBe(FEEL.botTapes)
  expect(mine.map((t) => t.tree)).toEqual(trees.slice(-FEEL.botTapes).map((t) => t.id))
  expect(bot.map.tapes.sort()).toEqual(mine.map((t) => t.id).sort())
  // Back at a trunk that already has its tape: it doesn't take it down.
  tieAt(trees.at(-1)!.id)
  expect(state.tapes.some((t) => t.tree === trees.at(-1)!.id)).toBe(true)
})

test("walking near a marker finds it and pencils it onto that map only", () => {
  const state = createWoods(world, 1)
  const m = world.markers[0]!
  Object.assign(state.players[0]!, { x: m.x + 1, z: m.z })
  stepWoods(state, world, new Map([[0, still()]]), 1 / 60)
  expect(state.events.some((e) => e.kind === "marker-found" && e.marker === m.id)).toBe(true)
  expect(state.players[0]!.map.markers).toEqual([m.id])
  expect(state.players[1]!.map.markers).toEqual([])
})

test("raising the map next to a friend copies their pencil marks", () => {
  const state = createWoods(world, 1)
  const friend = state.players[1]!
  friend.map.markers.push(3)
  friend.map.trail.push(friend.x + 30, friend.z)
  Object.assign(state.players[0]!, { x: friend.x + 1, z: friend.z })
  for (let i = 0; i < 60; i++) stepWoods(state, world, new Map([[0, { ...still(), map: true }]]), 1 / 60)
  expect(state.players[0]!.map.markers).toContain(3)
  expect(state.players[0]!.map.heard.some((h) => h.from === friend.id)).toBe(true)
})

test("bots wander the woods, tie tape and answer a signal", () => {
  const state = createWoods(world, 3)
  const you = state.players[0]!
  for (let i = 0; i < 60 * 90; i++) stepWoods(state, world, new Map([[0, still()]]), 1 / 60)
  const moved = state.players.slice(1).map((p) => Math.hypot(p.x - you.x, p.z - you.z))
  expect(Math.max(...moved)).toBeGreaterThan(15)
  expect(state.tapes.some((t) => t.by !== 0)).toBe(true)
  for (let i = 0; i < 60 * 1.5; i++) stepWoods(state, world, new Map([[0, { ...still(), pitch: 1.4 }]]), 1 / 60)
  expect(state.brains.every((b) => b.mode === "signal" || b.mode === "regroup")).toBe(true)
})

test("the sim owns the distant sounds: the same seed gives the same events, and none start while anyone signals", () => {
  const night = (signal: (t: number) => boolean) => {
    const state = createWoods(world, 0)
    const out: { e: DistantEvent; signalling: boolean }[] = []
    let until = -1
    for (let i = 0; i < 60 * 60 * 12; i++) {
      const t = i / 60
      stepWoods(state, world, new Map([[0, { ...still(), pitch: signal(t) ? 1.4 : 0 }]]), 1 / 60, { ...FEEL, distantRate: 3 })
      if (state.players[0]!.signal > SIGNAL_HOLD_SECONDS) until = state.t + DISTANT_AFTER_SIGNAL
      for (const e of state.events) if (e.kind === "distant") out.push({ e, signalling: state.t < until })
    }
    return out
  }
  const a = night(() => false), b = night(() => false)
  expect(a.length).toBeGreaterThan(8)
  expect(b.map((x) => x.e)).toEqual(a.map((x) => x.e))
  // A long signal (two minutes, far past the old 8 s hold) holds the woods quiet throughout, then they come back.
  const held = night((t) => t > 120 && t < 240)
  expect(held.filter((x) => x.signalling)).toEqual([])
  expect(held.some((x) => x.e.at > 240 + DISTANT_AFTER_SIGNAL)).toBe(true)
  expect(held.filter((x) => x.e.at > 120 && x.e.at < 240 + DISTANT_AFTER_SIGNAL)).toEqual([])
})

test("the world converts to the forest renderer's shape with one ground height", async () => {
  const { toForestWorld } = await import("../shared/forest-world")
  const state = createWoods(world, 0)
  const tree = world.trees[10]!
  state.tapes.push({ id: 1, tree: tree.id, x: tree.x, y: tree.y + 1.5, z: tree.z, yaw: 0, by: 0, at: 0 })
  const f = toForestWorld(world, state.tapes)
  expect(f.trees.length).toBe(world.trees.length)
  expect(f.height(12, -40)).toBe(groundHeight(world, 12, -40))
  expect(f.camp!.buildings.filter((b) => b.kind === "mess-hall")[0]!.lit).toBe(1)
  // Flag yaw is Tape.yaw unchanged (atan2(dz, dx) of the knot), as the forest build reads it.
  expect(f.flags![0]!.yaw).toBe(0)
  // The dock starts at the shore end and runs +z over its whole footprint; string lights hang between 5 posts.
  const dock = world.buildings.find((b) => b.kind === "dock")!
  expect(f.camp!.dock).toEqual({ x: (dock.rect[0] + dock.rect[2]) / 2, z: dock.rect[1], yaw: 0, length: dock.rect[3] - dock.rect[1], width: dock.rect[2] - dock.rect[0] })
  expect(f.camp!.stringLights![0]!.points.length).toBe(5)
  expect(f.flags![0]!.r).toBe(tree.radius)
})
