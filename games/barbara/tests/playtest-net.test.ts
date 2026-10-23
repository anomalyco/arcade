import { expect, spyOn, test } from "bun:test"
import { stepBody } from "@arcade/kit/sim/move"
import { JitterBuffer } from "@arcade/kit/net/jitter-buffer"
import { WoodsRoomCore, type NightCheckpoint } from "../server/room-core"
import { loadNight } from "../server/checkpoint"
import { BUILD } from "../shared/build.gen"
import { GRACE_MS, intentOps, packIntent, playerRow, quantizeInput, roundTrail, type ServerMsg, type Snapshot } from "../shared/protocol"
import { createWoods, FEEL, MAX_TAPES, newPlayer, PLAYER_RADIUS, stepMotion, stepWoods, TRAIL_MAX, type PlayerInput } from "../shared/sim"
import { makeWorld } from "../shared/world"

const world = makeWorld(), dt = 1 / 30
const input = (i: Partial<PlayerInput> = {}): PlayerInput => ({ yaw: 0, pitch: 0, light: true, mx: 0, mz: 0, tie: false, map: false, ...i })
function join(room: WoodsRoomCore, token?: string, build = BUILD) {
  const frames: ServerMsg[] = []
  const conn = { send: (s: string) => frames.push(JSON.parse(s)), close() {} }
  room.message(conn, JSON.stringify({ type: "hello", token, build, name: "Searcher" }))
  const welcome = frames.find((m) => m.type === "welcome")
  return { conn, frames, token: welcome?.type === "welcome" ? welcome.token : undefined, first: frames.find((m): m is Snapshot => m.type === "s") }
}

test("a cold room restores two private seats, poses, tapes, finds, maps and the full night schedule", () => {
  let now = 100_000
  const old = new WoodsRoomCore("proof", () => now, world)
  const a = join(old), b = join(old)
  for (let i = 0; i < 90; i++) {
    old.message(a.conn, JSON.stringify({ type: "intent", seq: i, i: packIntent(input({ mx: -1, yaw: 0.7, pitch: 0.2 })) }))
    old.message(b.conn, JSON.stringify({ type: "intent", seq: i, i: packIntent(input({ mx: 1, yaw: -0.9, pitch: -0.3 })) }))
    now += 1000 / 30; old.step()
  }
  const s = old.state, tree = world.trees[0]!
  s.t = 1020
  s.tapes = [{ id: 3, tree: tree.id, x: tree.x, z: tree.z, y: tree.y + 1.5, yaw: 0.4, by: 1, at: 400 }]
  s.nextTape = 4; s.found = { 0: [1, 2] }; s.rev.found++
  for (const p of s.players.filter((p) => !p.bot)) { p.map.tapes = [3]; p.map.markers = [0] }
  s.players[0]!.map.heard = [{ from: 2, serial: s.players[1]!.serial, trail: [...s.players[1]!.map.trail] }]
  // JSON is the actual SQLite boundary; don't keep any old runtime objects alive.
  const night: NightCheckpoint = JSON.parse(JSON.stringify(old.checkpoint()))
  now += 5000
  const restarted = WoodsRoomCore.restore(night, () => now, "new-build")
  const stale = join(restarted, a.token)
  expect(stale.frames).toEqual([{ type: "reload" }])
  expect(restarted.humans).toBe(2)
  const again = [join(restarted, a.token, "new-build"), join(restarted, b.token, "new-build")]
  for (let i = 0; i < 2; i++) {
    const p = s.players[i]!, c = again[i]!
    expect(c.first!.me).toBe(p.id)
    expect(c.first!.ack).toBe(-1)
    expect(c.first!.you![0]).toBeCloseTo(p.x, 4)
    expect(c.first!.you![1]).toBeCloseTo(p.z, 4)
    expect(c.first!.you![7]).toBeCloseTo(p.yaw, 4)
    expect(c.first!.you![8]).toBeCloseTo(p.pitch, 4)
    expect(c.first!.found).toEqual(s.found)
    expect(c.first!.tapes![0]![0]).toBe(3)
    expect(c.first!.map!.tapes).toEqual([3])
    expect(c.first!.map!.markers).toEqual([0])
    expect(c.first!.t).toBe(1020)
    expect(c.first!.distant).toEqual(s.distant)
  }
  expect(restarted.state.voices).toEqual(s.voices)
  expect(restarted.state.night).toEqual(s.night)
  expect(restarted.state.rng).toEqual(s.rng)
  const map = s.players[0]!.map
  expect(restarted.state.players[0]!.map).toEqual({ ...map, trail: roundTrail(map.trail), heard: map.heard.map((h) => ({ ...h, trail: roundTrail(h.trail) })) })
  expect(restarted.state.brains).toEqual(s.brains)
  // Public seat ids cannot steal a saved player; connected tokens still get a separate seat.
  const publicId = again[0]!.frames.find((m) => m.type === "welcome")!
  expect(publicId.type).toBe("welcome")
  const stranger = join(restarted, publicId.type === "welcome" ? publicId.id : "", "new-build")
  expect(stranger.first!.me).toBe(3)
  expect(join(restarted, a.token, "new-build").first!.me).toBe(4)
})

test("checkpoints run every two seconds and on seat changes, and grace never renews after a restart", () => {
  let now = 100_000, writes = 0
  const room = new WoodsRoomCore("proof", () => now, world)
  room.onCheckpoint = () => writes++
  const a = join(room)
  expect(writes).toBe(1)
  for (let i = 0; i < 70; i++) { now += 1000 / 30; room.step() }
  expect(writes).toBe(2)
  room.close(a.conn)
  expect(writes).toBe(3)
  const night = JSON.parse(JSON.stringify(room.checkpoint())) as NightCheckpoint
  now += GRACE_MS + 1
  const restored = WoodsRoomCore.restore(night, () => now)
  expect(restored.humans).toBe(0)
  expect(restored.state.players.every((p) => p.bot)).toBe(true)
})

test("recovery preserves clue knowledge, batteries and the next-night sequence", () => {
  const room = new WoodsRoomCore("proof", () => 100_000, world), a = join(room)
  room.state.night.phase = "lost"
  let saved: NightCheckpoint | undefined
  room.onCheckpoint = (night) => { saved = night }
  room.message(a.conn, JSON.stringify({ type: "again" }))
  expect(saved!.nights).toBe(1)
  const secondSeed = room.state.night.seed, p = room.state.players.find((p) => p.id === a.first!.me)!
  p.map.clues = [0, 1]; p.charge = 0.37; p.spare = true
  room.state.night.finds = [{ clue: 0, by: p.id, at: 10 }]
  const restored = WoodsRoomCore.restore(JSON.parse(JSON.stringify(room.checkpoint())), () => 100_000)
  const again = join(restored, a.token)
  expect(again.first!.night!.seed).toBe(secondSeed)
  expect(again.first!.map!.clues).toEqual([0, 1])
  expect(restored.state.players.find((q) => q.id === p.id)!.charge).toBe(0.37)
  expect(restored.state.night.finds).toEqual(room.state.night.finds)
  room.state.night.phase = restored.state.night.phase = "lost"
  room.message(a.conn, JSON.stringify({ type: "again" }))
  restored.message(again.conn, JSON.stringify({ type: "again" }))
  expect(restored.state.night.seed).toBe(room.state.night.seed)
  expect(restored.state.night.seed).not.toBe(secondSeed)
})

test("battery and hop occupy distinct wire fields, and captured walkers cannot start a jump", () => {
  const p = newPlayer(1, false, "A", world.camp.spawn.x, world.camp.spawn.z, 0)
  p.charge = 0.37
  stepMotion(world, p, input({ jump: true }), FEEL, dt)
  const row = playerRow(p, false)
  expect(row[10]).toBe(37)
  expect(row[11]).toBe(Math.round(p.air.y * 1000))
  expect(row[12]).toBe(Math.round(p.air.v * 1000))
  const captured = newPlayer(2, false, "B", p.x + 2, p.z, 0)
  captured.capture = { by: 1, left: 4 }
  stepMotion(world, captured, input({ jump: true, mx: 1 }), FEEL, dt)
  expect(captured.air.airborne).toBe(false)
  expect(captured.x).toBe(p.x + 2)
})

test("bad JSON, unsupported schemas, changed shared builds and broken state are discarded and the room can reopen", () => {
  const room = new WoodsRoomCore("proof", () => 100_000, world)
  join(room)
  const night = room.checkpoint()
  const bad = ["{secret seat token", "null", JSON.stringify({ ...night, version: 2 }),
    JSON.stringify({ ...night, build: "old-state-or-world-generator" }), JSON.stringify({ ...night, state: null })]
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    for (const data of bad) {
      let stored: string | undefined = data, deletes = 0
      const load = () => loadNight("proof", stored, () => { stored = undefined; deletes++ }, () => 100_000)
      const fresh = load()
      expect(deletes).toBe(1)
      expect(fresh.state.t).toBe(0)
      expect(join(fresh).first!.me).toBe(1)
      expect(join(load()).first!.me).toBe(1)
      expect(deletes).toBe(1)
    }
    expect(warn).toHaveBeenCalledTimes(bad.length)
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret seat token")
    const valid = loadNight("proof", JSON.stringify(night), () => { throw new Error("valid snapshot discarded") }, () => 100_000)
    expect(valid.humans).toBe(1)
  } finally { warn.mockRestore() }
})

test("failed checkpoint writes back off across ticks and seat changes, then resume saving the latest state", () => {
  let now = 100_000, writes = 0, failing = true, saved: NightCheckpoint | undefined
  const room = new WoodsRoomCore("proof", () => now, world)
  room.onCheckpoint = (night) => { writes++; if (failing) throw new Error("storage full"); saved = night }
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const a = join(room)
    expect(writes).toBe(1)
    room.close(a.conn)
    for (let i = 0; i < 59; i++) { now += 1000 / 30; room.step() }
    expect(writes).toBe(1)
    now = 102_000; room.step()
    expect(writes).toBe(2)
    now = 105_999; room.step()
    expect(writes).toBe(2)
    failing = false; now = 106_000; room.step()
    expect(writes).toBe(3)
    expect(saved!.state.t).toBe(room.state.t)
    now = 108_000; room.step()
    expect(writes).toBe(4)
    expect(warn).toHaveBeenCalledTimes(2)
  } finally { warn.mockRestore() }
})

test("a six-walker hour and fully saturated copied maps stay below 1.2 MB without rounding live paths", () => {
  const room = new WoodsRoomCore("hour", () => 100_000, world)
  for (let i = 0; i < 6; i++) join(room)
  const inputs = new Map(room.state.players.map((p) => [p.id, input({ map: true })]))
  // Fast-forward an hour of map sharing along a moving survey loop, without socket encoding overhead.
  for (let second = 0; second < 3600; second++) {
    for (const [i, p] of room.state.players.entries()) {
      p.x = Math.cos(second / 20) * 140 + i * 0.6; p.z = Math.sin(second / 20) * 140
    }
    stepWoods(room.state, world, inputs, 1)
  }
  expect(room.state.t).toBe(3600)
  const bytes = () => new TextEncoder().encode(JSON.stringify(room.checkpoint())).length
  expect(bytes()).toBeLessThan(1_200_000)
  // Go beyond the hour: every path at its hard cap, every walker holding every other path, all tapes present.
  for (const p of room.state.players) p.map.trail = Array.from({ length: TRAIL_MAX * 2 }, (_, i) => 199 * Math.sin(i + p.id * 0.7))
  for (const p of room.state.players) {
    p.map.heard = room.state.players.filter((q) => q !== p).map((q) => ({ from: q.id, serial: q.serial, trail: q.map.trail.slice() }))
    p.map.tapes = Array.from({ length: MAX_TAPES }, (_, i) => i)
  }
  room.state.tapes = Array.from({ length: MAX_TAPES }, (_, i) => {
    const tree = world.trees[i]!
    return { id: i, tree: tree.id, x: tree.x, y: tree.y, z: tree.z, yaw: 0.1, by: 1, at: i }
  })
  const original = structuredClone(room.state.players[0]!.map), night = room.checkpoint()
  const size = bytes()
  console.log(`six-walker saturated checkpoint: ${size} bytes`)
  expect(size).toBeLessThan(1_200_000)
  expect(room.state.players[0]!.map).toEqual(original)
  const restored = WoodsRoomCore.restore(JSON.parse(JSON.stringify(night)), () => 100_000)
  expect(restored.state.players[0]!.map.trail).toEqual(roundTrail(original.trail))
  expect(restored.state.players[0]!.map.heard).toEqual(night.state.players[0]!.map.heard)
}, 20_000)

test("friends and bots stop a walker at two body radii, slide, and are never pushed", () => {
  for (const bot of [false, true]) {
    const s = world.camp.spawn
    const a = newPlayer(1, false, "A", s.x, s.z, 0), b = newPlayer(2, bot, "B", s.x, s.z - 1, 0)
    for (let i = 0; i < 120; i++) stepMotion(world, a, input({ mz: -1, sprint: true }), FEEL, dt, [a, b])
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeCloseTo(PLAYER_RADIUS * 2, 5)
    expect(b.x).toBe(s.x); expect(b.z).toBe(s.z - 1)
    for (let i = 0; i < 20; i++) stepMotion(world, a, input({ mx: 1, mz: -1 }), FEEL, dt, [a, b])
    expect(a.x - b.x).toBeGreaterThan(0.6)
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(PLAYER_RADIUS * 2 - 1e-8)
  }
})

test("two approaching people stay separated in the shared sim; prediction agrees against a stationary peer", () => {
  const s = createWoods(world, 0, 42, [{ id: 1, name: "A" }, { id: 2, name: "B" }])
  const [a, b] = s.players
  Object.assign(b!, { x: a!.x, z: a!.z - 2 })
  for (let i = 0; i < 90; i++) {
    stepWoods(s, world, new Map([[1, input({ mz: -1 })], [2, input({ mz: 1 })]]), dt)
    expect(Math.hypot(a!.x - b!.x, a!.z - b!.z)).toBeGreaterThanOrEqual(0.56 - 1e-8)
  }
  const predicted = structuredClone(a!)
  for (let i = 0; i < 30; i++) {
    const q = quantizeInput(input({ mz: -1, mx: 0.3, jump: i === 0 }))
    stepMotion(world, predicted, q, FEEL, dt, [b!])
    b!.vx = b!.vz = 0
    stepWoods(s, world, new Map([[1, q], [2, input()]]), dt)
    expect([predicted.x, predicted.z, predicted.vx, predicted.vz, predicted.air]).toEqual([a!.x, a!.z, a!.vx, a!.vz, a!.air])
  }
})

test("a body cannot tunnel through another or squeeze it through a wall", () => {
  const b = { x: 0, y: 0, vx: 20, vy: 0 }
  const obstacle = { x: 1, y: 0, radius: 0.28 }
  for (let i = 0; i < 30; i++) stepBody(b, 1, 0, 20, [], dt, 0.28, 18, [obstacle])
  expect(b.x).toBeCloseTo(0.44, 6)
  expect(obstacle.x).toBe(1)
  const pinned = { x: 0, y: 0, vx: 0, vy: 0 }
  for (let i = 0; i < 60; i++) stepBody(pinned, 1, 1, 3, [[-1, 0.3, 2, 1]], dt, 0.28, 18, [{ x: 0.56, y: 0, radius: 0.28 }])
  expect(pinned.y).toBeLessThanOrEqual(0.02 + 1e-8)
  expect(Math.hypot(pinned.x - 0.56, pinned.y)).toBeGreaterThanOrEqual(0.56 - 1e-8)
})

test("coincident walkers choose opposite id-derived exits instead of both freezing against a tree", () => {
  const run = (order: number[]) => {
    const bodies = [1, 2].map((id) => ({ collisionId: id, x: 0, y: 0, vx: 0, vy: 0, radius: 0.28 }))
    for (let tick = 0; tick < 5; tick++) for (const i of order) {
      stepBody(bodies[i]!, 0, 0, 0, [[0.3, -1, 1, 2]], dt, 0.28, 18, [bodies[1 - i]!])
    }
    expect(Math.hypot(bodies[0]!.x - bodies[1]!.x, bodies[0]!.y - bodies[1]!.y)).toBeGreaterThanOrEqual(0.56 - 1e-8)
    expect(bodies.every((b) => b.x <= 0.02 + 1e-8)).toBe(true)
    return bodies
  }
  expect(run([0, 1])).toEqual(run([0, 1]))
  run([1, 0])
  const exits = [1, 2].map((id) => {
    const b = { collisionId: id, x: 0, y: 0, vx: 0, vy: 0 }
    stepBody(b, 0, 0, 0, [], dt, 0.28, 18, [{ collisionId: 3 - id, x: 0, y: 0, radius: 0.28 }])
    return b
  })
  expect(exits[0]!.x).toBe(-exits[1]!.x)
  expect(exits[0]!.y).toBe(-exits[1]!.y)
})

test("jump is a half-second 0.3 m hop with no air jump, identically quantized and edge-carried", () => {
  for (const hz of [30, 60, 144]) {
    const s = world.camp.spawn, p = newPlayer(1, false, "A", s.x, s.z, 0)
    let peak = 0
    for (let i = 0; i < hz; i++) {
      stepMotion(world, p, quantizeInput(input({ jump: i === 0 || i === Math.floor(hz / 4) })), FEEL, 1 / hz)
      peak = Math.max(peak, p.air.y)
      if (i > hz * 0.55) expect(p.air.airborne).toBe(false)
    }
    expect(peak).toBeGreaterThan(0.298); expect(peak).toBeLessThanOrEqual(0.3)
  }
  const jitter = new JitterBuffer(intentOps)
  jitter.push(0, input(), 0); jitter.take(0)
  jitter.take(1)
  jitter.push(1, input({ jump: true }), 2)
  jitter.push(2, input(), 2)
  let presses = 0
  for (let i = 2; i < 20; i++) for (const q of jitter.take(i)) if (q.jump) presses++
  expect(presses).toBe(1)
})
