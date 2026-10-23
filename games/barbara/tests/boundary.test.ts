import { expect, test } from "bun:test"
import { WoodsRoomCore, type NightCheckpoint } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { packIntent, type ServerMsg } from "../shared/protocol"
import { createWoods, movePlayer, newPlayer, PLAYER_RADIUS, stepWoods, type PlayerInput } from "../shared/sim"
import { boundaryLine, makeWorld } from "../shared/world"
import { friendBeamLevel } from "../src/friends-view"

const world = makeWorld(), L = boundaryLine(world), half = world.params.half
const input = (o: Partial<PlayerInput> = {}): PlayerInput => ({ yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0, ...o })
const inside = (p: { x: number; z: number }) => Math.max(Math.abs(p.x), Math.abs(p.z)) <= L - PLAYER_RADIUS + 1e-6

test("a walker caught between the fence and the map's edge comes back in, never out", () => {
  for (const [x, z, mx, mz] of [[half - 1, 0, 1, 0], [-(half - 0.5), 20, -1, 0], [10, half - 1.5, 0, 1], [half - 1, -(half - 1), 1, -1]] as const) {
    const p = newPlayer(1, false, "A", x, z, 0)
    for (let i = 0; i < 120; i++) movePlayer(world, p, mx, mz, 3, 1 / 60)
    expect(inside(p)).toBe(true)
    // And walking back in is free.
    const before = Math.max(Math.abs(p.x), Math.abs(p.z))
    for (let i = 0; i < 60; i++) movePlayer(world, p, -mx, -mz, 3, 1 / 60)
    expect(Math.max(Math.abs(p.x), Math.abs(p.z))).toBeLessThan(before - 1)
  }
})

test("a walker pressing on the fence from inside stops at it", () => {
  const p = newPlayer(1, false, "A", L - 3, 0, 0)
  for (let i = 0; i < 240; i++) movePlayer(world, p, 1, 0, 3, 1 / 60)
  expect(p.x).toBeGreaterThan(L - PLAYER_RADIUS - 0.05)
  expect(inside(p)).toBe(true)
})

test("a checkpoint with a walker past the fence restores them inside it", () => {
  let now = 100_000
  const room = new WoodsRoomCore("edge", () => now, world)
  const frames: ServerMsg[] = []
  const conn = { send: (s: string) => frames.push(JSON.parse(s)), close() {} }
  room.message(conn, JSON.stringify({ type: "hello", build: BUILD, name: "Searcher" }))
  room.message(conn, JSON.stringify({ type: "intent", seq: 0, i: packIntent(input()) }))
  now += 1000 / 30; room.step()
  const night: NightCheckpoint = JSON.parse(JSON.stringify(room.checkpoint()))
  const me = night.state.players.find((p) => !p.bot)!
  expect(me).toBeTruthy()
  me.x = half - 0.4; me.z = -(half - 0.2)
  const restored = WoodsRoomCore.restore(night, () => now)
  for (const p of restored.state.players) expect(inside(p)).toBe(true)
})

test("a flare thrown at the fence lands inside it", () => {
  // Facing east (+x) a few metres in from the fence, then north, south and west; each throw comes to rest inside.
  for (const [yaw, x, z] of [[-Math.PI / 2, L - 4, 6], [0, 6, -(L - 4)], [Math.PI, -6, L - 4], [Math.PI / 2, -(L - 4), -6]] as const) {
    const state = createWoods(world, 0)
    const me = state.players[0]!
    Object.assign(me, { x, z, vx: 0, vz: 0 })
    for (const b of state.players) if (b.bot) Object.assign(b, { x: 0, z: 0 })
    for (let i = 0; i < 60 * 7; i++) stepWoods(state, world, new Map([[0, input({ yaw, pitch: 0.25, flare: state.t < 0.05 })]]), 1 / 60)
    const f = state.flares.list.find((q) => q.by === 0)!
    expect(f.body?.rest).toBe(true)
    expect(Math.max(Math.abs(f.body!.x), Math.abs(f.body!.z))).toBeLessThanOrEqual(L + 0.05)
  }
})

test("a friend reading the map dims their torch to the reading level, never off", () => {
  expect(friendBeamLevel(1, 0, 0.003)).toBe(1)
  expect(friendBeamLevel(1, 1, 0.003)).toBeCloseTo(0.003, 6)
  expect(friendBeamLevel(0.8, 0.9, 0.003)).toBeGreaterThan(0)
  expect(friendBeamLevel(0, 1, 0.003)).toBeNull()
  expect(friendBeamLevel(0.005, 0, 0.003)).toBeNull()
})
