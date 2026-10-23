import { expect, test } from "bun:test"
import { WoodsRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { trunkBetween, type Beacon } from "../shared/creature"
import { decodeServer, type Snapshot } from "../shared/protocol"
import { createWoods, EYE_HEIGHT, FEEL, SIGNAL_HOLD_SECONDS, stepWoods, type Feel, type PlayerInput } from "../shared/sim"
import { placeSpiderSigns } from "../shared/spider-signs"
import { BEAT_FIRST, createStalker, SPIDER_BODY_Y, poseFromRow, SPIDER_SIZE, STALKER_MIN, stalkerPose, stalkerRow, stalkerX, stalkerZ, stepStalker, type StalkerEvent, type StalkerState, type StalkerWalker } from "../shared/stalker"
import { boundaryLine, isDeepWater, makeWorld, nextRandom, standHeight, trailDistance } from "../shared/world"

const world = makeWorld()
const DT = 1 / 30
const eye = (w: StalkerWalker) => [w.x, standHeight(world, w.x, w.z) + EYE_HEIGHT, w.z] as const
const walker = (o: Partial<StalkerWalker> = {}): StalkerWalker => ({ id: 0, x: world.camp.x, z: world.camp.z, yaw: 0, pitch: 0, light: false, bot: false, signal: 0, isolated: 0, ...o })
const step = (s: StalkerState, walkers: StalkerWalker[], t: number) => stepStalker(s, world, walkers, t, DT, FEEL, SIGNAL_HOLD_SECONDS, eye)
const distance = (s: StalkerState, w: StalkerWalker) => Math.hypot(stalkerX(s) - w.x, stalkerZ(s) - w.z)
const place = (s: StalkerState, x: number, z: number) => { s.motion.x = x / SPIDER_SIZE; s.motion.z = z / SPIDER_SIZE; s.tx = x; s.tz = z }

/** A spot `d` m from (x, z) along `yaw` with open ground and no trunk in the way, or null. */
function clearSight(x: number, z: number, d: number): { yaw: number; x: number; z: number } | null {
  for (let i = 0; i < 64; i++) {
    const yaw = (i / 64) * Math.PI * 2, tx = x - Math.sin(yaw) * d, tz = z - Math.cos(yaw) * d
    if (isDeepWater(world, tx, tz) || Math.abs(tx) > world.params.half - 25 || Math.abs(tz) > world.params.half - 25) continue
    if (!trunkBetween(world, x, z, tx, tz, 0.3)) return { yaw, x: tx, z: tz }
  }
  return null
}

test("the same night is the same spider: replay gives the same root and the same drums and beats", () => {
  const run = () => {
    const state = createWoods(world, 2, 4242)
    const rows: number[][] = [], events: StalkerEvent[] = []
    const feel: Feel = { ...FEEL, creature: "spider" }
    for (let f = 0; f < 8 * 60 * 30; f++) {
      // You wander off camp with your torch on, sweeping slowly.
      const input: PlayerInput = { yaw: f * 0.0015, pitch: 0, light: f % 3000 < 2000, tie: false, map: false, mx: Math.sin(f * 0.0007) * 0.8, mz: -0.6 }
      stepWoods(state, world, new Map([[0, input]]), DT, feel)
      for (const e of state.events) if (e.kind === "spider-drum" || e.kind === "spider-beat") events.push(e)
      if (f % 30 === 0) rows.push(stalkerRow(state.stalker))
    }
    return { rows, events }
  }
  const a = run(), b = run()
  expect(b.rows).toEqual(a.rows)
  expect(b.events).toEqual(a.events)
  // It moved.
  expect(new Set(a.rows.map((r) => `${r[0]},${r[1]}`)).size).toBeGreaterThan(20)
})

test("it never comes within 20 m, even of someone walking straight at it in the dark", () => {
  const s = createStalker(world, 9)
  const w = walker({ isolated: 60 })
  place(s, w.x + 60, w.z + 20)
  let closest = Infinity
  for (let f = 0; f < 4 * 60 * 30; f++) {
    // Walk at it (1.9 m/s), torch off.
    const dx = stalkerX(s) - w.x, dz = stalkerZ(s) - w.z, d = Math.hypot(dx, dz)
    if (d > 1) { w.x += (dx / d) * 1.9 * DT; w.z += (dz / d) * 1.9 * DT }
    w.yaw = Math.atan2(-dx, -dz)
    step(s, [w], f * DT)
    closest = Math.min(closest, distance(s, w))
  }
  expect(closest).toBeGreaterThanOrEqual(STALKER_MIN)
})

test("a beam held on it drives it off; a glance doesn't", () => {
  const w = walker({ light: true })
  const spot = clearSight(w.x, w.z, 30)
  expect(spot).not.toBeNull()
  // The beam aims at its body, 4.5 m up, from your eye.
  const g = standHeight(world, spot!.x, spot!.z), e = eye(w)
  w.yaw = spot!.yaw
  w.pitch = Math.atan2(g + 4.5 - e[1], 30)

  const glance = createStalker(world, 3)
  place(glance, spot!.x, spot!.z)
  for (let f = 0; f < 12; f++) step(glance, [w], f * DT)
  expect(glance.mode).toBe("shadow")

  const s = createStalker(world, 3)
  place(s, spot!.x, spot!.z)
  for (let f = 0; f < 30; f++) step(s, [w], f * DT)
  expect(s.mode).toBe("flee")
  for (let f = 30; f < 30 * 30; f++) step(s, [w], f * DT)
  expect(distance(s, w)).toBeGreaterThan(60)
})

test("darkness and being alone draw it in, out of reach; company keeps it far off", () => {
  const w = walker({ x: world.camp.x + 10, z: world.camp.z - 90, isolated: 40 })
  const lone = createStalker(world, 5)
  place(lone, w.x + 90, w.z - 40)
  for (let f = 0; f < 3 * 60 * 30; f++) step(lone, [w], f * DT)
  const d = distance(lone, w)
  expect(d).toBeGreaterThanOrEqual(STALKER_MIN)
  expect(d).toBeLessThan(48)

  const friend = walker({ ...w, id: 1, x: w.x + 4, isolated: 0, light: true, yaw: Math.PI })
  const kept = createStalker(world, 5)
  place(kept, w.x + 90, w.z - 40)
  for (let f = 0; f < 3 * 60 * 30; f++) step(kept, [{ ...w, isolated: 0 }, friend], f * DT)
  expect(distance(kept, w)).toBeGreaterThan(70)
})

test("a beat is a slow distant walk across someone's view that starts out of sight", () => {
  const s = createStalker(world, 11)
  // Someone with their torch up and level, looking down a long open line.
  let w: StalkerWalker | null = null
  for (let k = 0; k < 40 && !w; k++) {
    const x = world.camp.x + 20 + k * 3, z = world.camp.z - 60 - k * 2
    const spot = clearSight(x, z, 46)
    if (spot) w = walker({ x, z, yaw: spot.yaw, light: true })
  }
  expect(w).not.toBeNull()
  place(s, w!.x + 120, w!.z + 60)
  const jump = s.jump
  let beat: StalkerEvent | undefined
  for (let f = Math.round(BEAT_FIRST / DT); f < Math.round((BEAT_FIRST + 200) / DT) && !beat; f++) beat = step(s, [w!], f * DT).find((e) => e.kind === "spider-beat")
  expect(beat?.kind).toBe("spider-beat")
  if (beat?.kind !== "spider-beat") return
  expect(s.jump).toBe(jump + 1)
  expect(s.mode).toBe("beat")
  expect(Math.hypot(beat.x0 - w!.x, beat.z0 - w!.z)).toBeGreaterThanOrEqual(36)
  expect(Math.hypot(beat.x1 - w!.x, beat.z1 - w!.z)).toBeGreaterThanOrEqual(36)
  // It walks it slowly (about a metre a second), then goes back to the shadow.
  const t0 = beat.at
  let f = Math.round(t0 / DT) + 1
  for (; s.mode === "beat" && f < Math.round((t0 + 40) / DT); f++) step(s, [w!], f * DT)
  expect(s.mode).not.toBe("beat")
  const seconds = f * DT - t0
  expect(seconds).toBeGreaterThan(8)
  expect(seconds).toBeLessThan(31)
})

test("its root survives the wire: a row back to a pose within a centimetre and a milliradian", () => {
  const s = createStalker(world, 21)
  s.motion.heading = 1.2345
  const p = stalkerPose(s), q = poseFromRow(stalkerRow(s))
  expect(Math.abs(q.x - p.x)).toBeLessThan(0.006)
  expect(Math.abs(q.z - p.z)).toBeLessThan(0.006)
  expect(Math.abs(q.heading - p.heading)).toBeLessThan(0.001)
  expect(q.mode).toBe(p.mode)
  expect(q.jump).toBe(p.jump)
})

test("a room sends the spider in every snapshot, the same root for everyone", () => {
  let now = 0
  const room = new WoodsRoomCore("spider1", () => now)
  const got: Snapshot[][] = [[], []]
  for (const [i, name] of ["Kit", "Aiden"].entries()) {
    const conn = { send: (d: string) => { const m = decodeServer(d); if (m?.type === "s") got[i]!.push(m) }, close() {} }
    room.open(conn)
    room.message(conn, JSON.stringify({ type: "hello", build: BUILD, name }))
  }
  for (let i = 0; i < 90; i++) { now += 1000 / 30; room.step() }
  const a = got[0]!.at(-1)!, b = got[1]!.at(-1)!
  expect(a.sp).toEqual(stalkerRow(room.state.stalker))
  expect(b.sp).toEqual(a.sp)
})

test("its signs: a web across the trail between two trunks, and bundles high in the canopy, the same for a seed", () => {
  const a = placeSpiderSigns(world, 77), b = placeSpiderSigns(world, 77)
  expect(b).toEqual(a)
  expect(a.webs.length).toBe(1)
  const web = a.webs[0]!
  expect(trailDistance(world.trail, web.x, web.z).d).toBeLessThan(2)
  const [t, u] = web.trees.map((id) => world.trees[id]!)
  expect(Math.hypot(t!.x - u!.x, t!.z - u!.z) - t!.radius - u!.radius).toBeGreaterThanOrEqual(2.5)
  expect(web.tape).toBeGreaterThan(0)
  expect(a.bundles.some((x) => x.size === "person")).toBe(true)
  for (const x of a.bundles) expect(x.y - x.length / 2 - standHeight(world, x.x, x.z)).toBeGreaterThan(3)
  expect(placeSpiderSigns(world, 78)).not.toEqual(a)
  // A night the spider didn't take her: the web and smaller bundles, no person-sized one.
  const other = placeSpiderSigns(world, 77, false)
  expect(other.webs).toEqual(a.webs)
  expect(other.bundles.some((x) => x.size === "person")).toBe(false)
})

test("someone taken is out of its night: it neither keeps stalking where they stood nor counts them alone", () => {
  const state = createWoods(world, 0, 31, [{ id: 0, name: "A" }, { id: 1, name: "B" }])
  const a = state.players[0]!, b = state.players[1]!
  const c = world.camp
  Object.assign(a, { x: c.x - 80, z: c.z - 90, light: false, isolated: 1000 })
  Object.assign(b, { x: c.x + 80, z: c.z - 90, light: false })
  state.night.verdict.gone.push({ id: a.id, x: a.x, z: a.z, yaw: 0, at: 0 })
  place(state.stalker, c.x, c.z - 170)
  const still: PlayerInput = { yaw: 0, pitch: 0, light: false, tie: false, map: false, mx: 0, mz: 0 }
  const feel: Feel = { ...FEEL, creature: "spider", botCount: 0 }
  for (let f = 0; f < 3 * 60 * 30; f++) stepWoods(state, world, new Map([[0, still], [1, still]]), DT, feel)
  expect(a.isolated).toBe(0)
  const s = state.stalker, toB = Math.hypot(stalkerX(s) - b.x, stalkerZ(s) - b.z)
  expect(toB).toBeGreaterThanOrEqual(STALKER_MIN)
  expect(toB).toBeLessThan(48)
  expect(Math.hypot(stalkerX(s) - a.x, stalkerZ(s) - a.z)).toBeGreaterThan(toB)
})

test("driven off, it keeps 20 m from everyone and stays out of the lake", () => {
  const run = (s: StalkerState, walkers: StalkerWalker[]) => {
    s.glare = 5
    let closest = Infinity, wet = false
    for (let f = 0; f < 25 * 30; f++) {
      step(s, walkers, f * DT)
      for (const w of walkers) closest = Math.min(closest, distance(s, w))
      wet ||= isDeepWater(world, stalkerX(s), stalkerZ(s))
    }
    return { closest, wet, mode: s.mode }
  }
  // A torch on it from the south, and someone standing in the dark right where straight away would take it.
  const x = world.camp.x + 10, z = world.camp.z - 110
  const torch = walker({ x, z: z + 30, yaw: 0, light: true }), dark = walker({ id: 1, x, z: z - 40 })
  const a = createStalker(world, 7)
  place(a, x, z)
  const one = run(a, [torch, dark])
  expect(one.closest).toBeGreaterThanOrEqual(STALKER_MIN)
  expect(one.wet).toBe(false)

  // On the lake's east shore with a torch on it from the east: straight away is the water.
  const lake = world.lake
  let sx = lake.x + lake.rx
  while (isDeepWater(world, sx, lake.z)) sx += 1
  sx += 8
  const b = createStalker(world, 8)
  place(b, sx, lake.z)
  const two = run(b, [walker({ x: sx + 32, z: lake.z, yaw: Math.PI / 2, light: true })])
  expect(two.closest).toBeGreaterThanOrEqual(STALKER_MIN)
  expect(two.wet).toBe(false)
})

test("it starts inside the fence and out of the lake on every night", () => {
  const line = boundaryLine(world)
  for (let seed = 0; seed < 200; seed++) {
    const s = createStalker(world, seed), x = stalkerX(s), z = stalkerZ(s)
    expect(Math.abs(x) < line && Math.abs(z) < line).toBe(true)
    expect(isDeepWater(world, x, z)).toBe(false)
  }
})

test("a burning road flare out in the dark is a backdrop for its walk across", () => {
  // Out in the woods looking away from camp (its lit windows are a backdrop too), with a clear 70 m line ahead.
  let line: { w: StalkerWalker; bx: number; bz: number } | null = null
  for (let k = 0; k < 40 && !line; k++) {
    const x = world.camp.x + 20 + k * 3, z = world.camp.z - 100 - k * 2
    for (let i = 0; i < 64 && !line; i++) {
      const yaw = (i / 64) * Math.PI * 2, fx = -Math.sin(yaw), fz = -Math.cos(yaw)
      if (fx * (world.camp.x - x) + fz * (world.camp.z - z) > 0) continue
      const bx = x + fx * 70, bz = z + fz * 70
      if (isDeepWater(world, bx, bz) || Math.abs(bx) > world.params.half - 25 || Math.abs(bz) > world.params.half - 25) continue
      if (!trunkBetween(world, x, z, bx, bz, 0.3)) line = { w: walker({ x, z, yaw }), bx, bz }
    }
  }
  expect(line).not.toBeNull()
  const { w, bx, bz } = line!
  const flare: Beacon = { x: bx, z: bz, by: -1, held: false, level: 1 }
  let without = 0, withFlare = 0
  for (let seed = 1; seed < 12; seed++) {
    for (const beacons of [[], [flare]]) {
      const s = createStalker(world, seed)
      place(s, w.x + 150, w.z + 60)
      const beat = stepStalker(s, world, [w], 400, DT, FEEL, SIGNAL_HOLD_SECONDS, eye, beacons).some((e) => e.kind === "spider-beat")
      if (beat) beacons.length ? withFlare++ : without++
    }
  }
  // Torch off and no other light: only the flare gives it something to cross.
  expect(without).toBe(0)
  expect(withFlare).toBeGreaterThan(0)
})

/**
 * Someone walks straight at it (1.9 m/s) with their torch held on its body for `seconds`. Returns the longest it was
 * ever within `STALKER_MIN` of them (s), and whether it ever left the fence or went into the lake.
 */
function chase(s: StalkerState, w: StalkerWalker, seconds: number) {
  const line = boundaryLine(world)
  let inside = 0, longest = 0, fence = false, wet = false
  for (let f = 0; f < seconds * 30; f++) {
    const sx = stalkerX(s), sz = stalkerZ(s), dx = sx - w.x, dz = sz - w.z, d = Math.hypot(dx, dz)
    const nx = w.x + (dx / d) * 1.9 * DT, nz = w.z + (dz / d) * 1.9 * DT
    if (d > 1 && !isDeepWater(world, nx, nz) && Math.abs(nx) < line - 1 && Math.abs(nz) < line - 1) { w.x = nx; w.z = nz }
    w.yaw = Math.atan2(-dx, -dz)
    w.pitch = Math.atan2(standHeight(world, sx, sz) + SPIDER_BODY_Y - eye(w)[1], d)
    step(s, [w], f * DT)
    const now = distance(s, w)
    inside = now < STALKER_MIN ? inside + DT : 0
    longest = Math.max(longest, inside)
    fence ||= Math.abs(stalkerX(s)) >= line || Math.abs(stalkerZ(s)) >= line
    wet ||= isDeepWater(world, stalkerX(s), stalkerZ(s))
  }
  return { longest, fence, wet }
}

test("cornered against the fence in a beam, it doesn't freeze: it's out of reach at once, inside the fence", () => {
  const h = world.params.half
  const s = createStalker(world, 12)
  place(s, h - 25, h - 25)
  const r = chase(s, walker({ x: h - 50, z: h - 50, light: true }), 40)
  expect(r.longest).toBeLessThanOrEqual(0.25)
  expect(r.fence).toBe(false)
  expect(r.wet).toBe(false)
})

test("backed up to the lake shore in a beam, the same", () => {
  const lake = world.lake
  let sx = lake.x + lake.rx
  while (isDeepWater(world, sx, lake.z)) sx += 1
  const s = createStalker(world, 13)
  place(s, sx + 3, lake.z)
  const r = chase(s, walker({ x: sx + 28, z: lake.z, light: true }), 40)
  expect(r.longest).toBeLessThanOrEqual(0.25)
  expect(r.fence).toBe(false)
  expect(r.wet).toBe(false)
})

test("200 nights, someone walking straight at it with a torch on it from anywhere: never within 20 m past a moment", () => {
  const line = boundaryLine(world)
  let worst = 0
  for (let seed = 0; seed < 200; seed++) {
    const s = createStalker(world, seed), rng = { seed: seed * 7919 + 1 }
    let x = 0, z = 0
    for (let i = 0; i < 50; i++) {
      const a = nextRandom(rng) * Math.PI * 2, d = 45 + 30 * nextRandom(rng)
      x = stalkerX(s) + Math.sin(a) * d; z = stalkerZ(s) + Math.cos(a) * d
      if (Math.abs(x) < line - 2 && Math.abs(z) < line - 2 && !isDeepWater(world, x, z)) break
    }
    const r = chase(s, walker({ x, z, light: true }), 30)
    worst = Math.max(worst, r.longest)
    expect(r.fence).toBe(false)
    expect(r.wet).toBe(false)
  }
  expect(worst).toBeLessThanOrEqual(0.25)
})
