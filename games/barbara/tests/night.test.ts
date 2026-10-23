import { expect, test } from "bun:test"
import { WoodsRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { CLUE, EDGE_MARGIN, nextStep, placeNight, seesClue, targetsFrom, watchMinutes, WATCH_DAWN, type NightEvent } from "../shared/night"
import { decodeServer, packIntent, type ServerMsg, type Snapshot } from "../shared/protocol"
import { BOT_ID, createWoods, EYE_HEIGHT, FEEL, PLAYER_RADIUS, removePlayer, stepWoods, type PlayerInput, type WoodsState } from "../shared/sim"
import { isDeepWater, makeWorld, solidsNear, standHeight } from "../shared/world"

const world = makeWorld()
const DT = 1 / 60
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

test("a night's layout comes from its seed alone: five clues on a trail to the ridge light, one near camp, inside the edge", () => {
  expect(placeNight(world, 7)).toEqual(placeNight(world, 7))
  expect(JSON.stringify(placeNight(world, 8))).not.toBe(JSON.stringify(placeNight(world, 7)))
  let tied = 0
  for (let seed = 1; seed <= 60; seed++) {
    const n = placeNight(world, seed)
    const [car, page, badge, cassette, strip] = n.clues
    // At most one clue (the car in the lot) near camp; none in the lake or near the world's edge.
    expect(n.clues.filter((c) => dist(c, world.camp) < 62).map((c) => c.kind)).toEqual(["car"])
    for (const c of n.clues) {
      expect(isDeepWater(world, c.x, c.z)).toBe(false)
      expect(Math.max(Math.abs(c.x), Math.abs(c.z))).toBeLessThan(world.params.half - EDGE_MARGIN + 1)
    }
    // The strip is tied to a trunk; so is the page wherever there's one near (else a stake).
    expect(strip!.tree).toBeGreaterThanOrEqual(0)
    if (page!.tree >= 0) tied++
    // Page and badge go off either side, too far apart for one group to see both.
    expect(dist(page!, car!)).toBeGreaterThan(60)
    expect(dist(badge!, car!)).toBeGreaterThan(60)
    expect(dist(page!, badge!)).toBeGreaterThan(40)
    // The car's bearings reach them; their two bearings cross at the cassette.
    const found = new Set<number>()
    const fromCar = targetsFrom(n, [CLUE.car], new Set([CLUE.car]))
    for (const t of fromCar) {
      const c = n.clues[t.clue]!
      const along = (c.x - t.x) * t.line!.dx + (c.z - t.z) * t.line!.dz, off = Math.abs((c.x - t.x) * -t.line!.dz + (c.z - t.z) * t.line!.dx)
      expect(along).toBeGreaterThan(50)
      expect(off).toBeLessThan(7.5)
    }
    found.add(CLUE.car).add(CLUE.page).add(CLUE.badge)
    const cross = targetsFrom(n, [CLUE.page, CLUE.badge], found).find((t) => t.clue === CLUE.cassette)!
    expect(dist(cross, cassette!)).toBeLessThan(10)
    // The tape says she went up to the ridge light; the strip is on a trunk near it.
    expect(cassette!.leads[0]!.ridge).toBe(true)
    expect(dist(strip!, n.ridge)).toBeLessThan(32)
    // Three spares on the mess table, one or two in the woods.
    expect(n.spares.filter((s) => s.camp).length).toBe(3)
    expect(n.spares.filter((s) => !s.camp).length).toBeGreaterThanOrEqual(1)
  }
})

/** A solo night with bots: you step just out of camp (starting the clock) and wait there, torch off. */
function botNight(seed: number, feel = FEEL, maxMinutes = 25, each?: (state: WoodsState) => void) {
  const state = createWoods(world, 3, seed)
  const you = state.players[0]!
  you.x = world.camp.x; you.z = world.camp.z - world.camp.radius - 8
  const wait = new Map<number, PlayerInput>([[0, { yaw: 0, pitch: 0, light: false, tie: false, map: false, mx: 0, mz: 0 }]])
  const events: NightEvent[] = []
  const voices: string[] = []
  for (let i = 0; i < maxMinutes * 60 * 60 && (state.night.phase === "camp" || state.night.phase === "search"); i++) {
    stepWoods(state, world, wait, DT, feel)
    each?.(state)
    for (const e of state.events) {
      if (e.kind === "clue-found" || e.kind === "night" || e.kind === "spare-taken" || e.kind === "torch") events.push(e)
      if (e.kind === "voice") voices.push(e.line)
    }
  }
  return { state, events, voices }
}

const summary = (r: ReturnType<typeof botNight>) => ({ phase: r.state.night.phase, reason: r.state.night.reason, minutes: +((r.state.night.end - r.state.night.start) / 60).toFixed(2), finds: r.state.night.finds.map((f) => `${f.clue}@${((f.at - r.state.night.start) / 60).toFixed(1)}`) })

test("bots work the leads on their own and a default night is won before dawn", () => {
  const r = botNight(4)
  const n = r.state.night
  console.log("bot night", JSON.stringify(summary(r)))
  expect(n.phase).toBe("won")
  expect(n.reason).toBe("strip")
  expect(n.end - n.start).toBeLessThan(FEEL.dawnMinutes * 60)
  // Every clue was found in order of the trail it lays, and each find was news to everyone once.
  const order = n.finds.map((f) => f.clue)
  expect(new Set(order).size).toBe(order.length)
  expect(order[0]).toBe(CLUE.car)
  expect(order.at(-1)).toBe(CLUE.strip)
  expect(order.indexOf(CLUE.cassette)).toBeGreaterThan(Math.min(order.indexOf(CLUE.page) < 0 ? 99 : order.indexOf(CLUE.page), order.indexOf(CLUE.badge) < 0 ? 99 : order.indexOf(CLUE.badge)))
  // The finder's searcher says what it is; the tape plays Barbara saying where she was going.
  expect(r.voices.some((l) => l.includes(".car."))).toBe(true)
  expect(r.voices.some((l) => l === "night.barbara.tape-tower.1")).toBe(true)
  // Then the extra searcher calls "Over here!" from the ridge, and the bots go to it.
  expect(r.voices.includes("night.walt.extra.1")).toBe(true)
  expect(n.calls).toBeGreaterThan(0)
  // The end carries the debrief: everyone's path and the finds.
  const end = r.events.find((e) => e.kind === "night" && e.phase === "won")
  expect(end && end.kind === "night" ? end.debrief?.walkers.length : 0).toBe(4)
  expect(end && end.kind === "night" ? end.debrief?.tapes.length : 0).toBeGreaterThan(0)
  expect(watchMinutes(n, n.end + 999)).toBeLessThan(WATCH_DAWN)
})

test("the night is lost at dawn, or when every torch is dead with no spare left", () => {
  const dawn = botNight(5, { ...FEEL, dawnMinutes: 2 })
  expect(dawn.state.night.phase).toBe("lost")
  expect(dawn.state.night.reason).toBe("dawn")
  expect(dawn.state.night.end - dawn.state.night.start).toBeCloseTo(120, 0)
  expect(watchMinutes(dawn.state.night, dawn.state.t)).toBeCloseTo(WATCH_DAWN, 0)

  // Batteries that last twelve seconds and no spares anywhere.
  const state = createWoods(world, 2, 5)
  state.night.layout.spares = []
  const you = state.players[0]!
  you.x = world.camp.x; you.z = world.camp.z - world.camp.radius - 8
  const lit = new Map<number, PlayerInput>([[0, { yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 }]])
  const feel = { ...FEEL, batteryMinutes: 0.2, dawnMinutes: 30 }
  const kinds: string[] = []
  for (let i = 0; i < 90 * 60 && state.night.phase !== "lost"; i++) {
    stepWoods(state, world, lit, DT, feel)
    for (const e of state.events) if (e.kind === "torch" && e.by === 0) kinds.push(e.state)
  }
  expect(state.night.reason).toBe("dark")
  expect(kinds).toEqual(["low", "dead"])
  expect(state.players.every((p) => !p.light && p.charge === 0)).toBe(true)
})

test("a spare goes in when the torch dies: dark for the swap, then a full battery", () => {
  const state = createWoods(world, 0, 9)
  const you = state.players[0]!
  const table = state.night.layout.spares.find((s) => s.camp)!
  you.x = table.x; you.z = table.z
  const lit = new Map<number, PlayerInput>([[0, { yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 }]])
  stepWoods(state, world, lit, DT)
  expect(you.spare).toBe(true)
  expect(state.events.some((e) => e.kind === "spare-taken" && e.by === 0)).toBe(true)
  // Out of camp so the clock (and the battery) runs; nearly flat.
  you.x = world.camp.x; you.z = world.camp.z - world.camp.radius - 8
  stepWoods(state, world, lit, DT)
  expect(state.night.phase).toBe("search")
  you.charge = 0.001
  const seen: string[] = []
  for (let i = 0; i < (FEEL.swapSeconds + 1) * 60; i++) {
    stepWoods(state, world, lit, DT)
    for (const e of state.events) if (e.kind === "torch") seen.push(e.state)
    if (seen.includes("swap") && !seen.includes("fresh")) expect(you.light).toBe(false)
  }
  expect(seen).toEqual(["dead", "swap", "fresh"])
  expect(you.charge).toBeGreaterThan(0.99)
  expect(you.spare).toBe(false)
  expect(you.light).toBe(true)
})

test("a clue is found only up close with your torch on it, and goes on the finder's map alone", () => {
  const state = createWoods(world, 1, 11)
  const [you, bot] = state.players as [WoodsState["players"][0], WoodsState["players"][0]]
  bot.x = world.camp.x - 20; bot.z = world.camp.z + 20
  state.brains[0]!.mode = "wait"; state.brains[0]!.timer = 999
  const badge = state.night.layout.clues[CLUE.badge]!
  you.x = badge.x; you.z = badge.z + 3
  const eye = standHeight(world, you.x, you.z) + EYE_HEIGHT
  const pitch = Math.atan2(badge.y + badge.h - eye, 3)
  const step = (i: Partial<PlayerInput>) => stepWoods(state, world, new Map([[0, { yaw: 0, pitch, light: true, tie: false, map: false, mx: 0, mz: 0, ...i }]]), DT)
  step({ light: false })
  expect(state.night.phase).toBe("search")
  expect(state.night.finds.length).toBe(0)
  step({ yaw: Math.PI })
  expect(state.night.finds.length).toBe(0)
  expect(seesClue({ ...you, light: true, yaw: 0, pitch }, badge, eye)).toBe(true)
  step({})
  expect(state.night.finds).toEqual([{ clue: CLUE.badge, by: 0, at: state.t }])
  expect(state.events.some((e) => e.kind === "clue-found" && e.by === 0 && e.what === "badge")).toBe(true)
  expect(you.map.clues).toEqual([CLUE.badge])
  expect(bot.map.clues).toEqual([])
})

// ---------------------------------------------------------------- rooms

test("a room sends the night when it changes and starts the next one on `again` once it's over", () => {
  let now = 0
  const room = new WoodsRoomCore("night1", () => now)
  const got: ServerMsg[] = []
  const conn = { send: (d: string) => { const m = decodeServer(d); if (m) got.push(m) }, close() {} }
  room.open(conn)
  room.message(conn, JSON.stringify({ type: "hello", build: BUILD, name: "Kit" }))
  const tick = (n: number) => { for (let i = 0; i < n; i++) { now += 1000 / 30; room.step() } }
  const snaps = () => got.filter((m): m is Snapshot => m.type === "s")
  tick(3)
  const first = snaps().find((s) => s.night)!.night!
  expect(first.seed).toBe(room.state.night.seed)
  expect(first.phase).toBe("camp")
  // Walk out of camp: the clock starts and the change goes out once.
  const me = room.state.players.find((p) => !p.bot)!
  me.x = world.camp.x; me.z = world.camp.z - world.camp.radius - 8
  const before = snaps().length
  room.message(conn, JSON.stringify({ type: "intent", seq: 0, i: packIntent({ yaw: 0, pitch: 0, light: true, tie: false, map: false, mx: 0, mz: 0 }) }))
  tick(6)
  const later = snaps().slice(before).filter((s) => s.night)
  expect(later.length).toBe(1)
  expect(later[0]!.night!.phase).toBe("search")
  // `again` does nothing mid-search.
  const seed = room.state.night.seed
  room.message(conn, JSON.stringify({ type: "again" }))
  expect(room.state.night.seed).toBe(seed)
  // Dawn: the night ends; then `again` brings everyone back to camp for the next layout.
  room.state.night.dawn = room.state.t
  tick(2)
  expect(room.state.night.phase).toBe("lost")
  room.message(conn, JSON.stringify({ type: "again" }))
  expect(room.state.night.seed).not.toBe(seed)
  expect(room.state.night.phase).toBe("camp")
  const back = room.state.players.find((p) => !p.bot)!
  expect(dist(back, world.camp)).toBeLessThan(world.camp.radius)
  tick(2)
  const fresh = snaps().at(-1)!
  expect(fresh.night?.seed).toBe(room.state.night.seed)
  expect(fresh.map?.reset).toBe(true)
  expect(fresh.tapes).toEqual([])
})

test("the goal line always says what to do next, from what your map knows", () => {
  const n = { phase: "search" as const, layout: placeNight(world, 3), finds: [] as { clue: number; by: number; at: number }[], calls: 0 }
  const name = () => "Tess"
  expect(nextStep(n, [], name)).toContain("her car")
  expect(nextStep(n, [CLUE.car], name)).toContain("Two trails")
  n.finds.push({ clue: CLUE.badge, by: 5, at: 1 })
  expect(nextStep(n, [CLUE.car], name)).toContain("Tess found her ID badge")
  expect(nextStep(n, [CLUE.car, CLUE.page, CLUE.badge], name)).toContain("cross")
  expect(nextStep(n, [CLUE.cassette], name)).toContain("red light on the ridge")
  expect(nextStep({ ...n, calls: 1 }, [], name)).toContain("Over here!")
})

test("a person finding the car first doesn't strand the bots: they look for themselves and still win", () => {
  // You find the car the moment the night starts, then stand far off where no bot meets you.
  const far = { x: world.camp.x - (world.ridgeLight.x - world.camp.x) * 0.5, z: world.camp.z - (world.ridgeLight.z - world.camp.z) * 0.5 }
  const r = botNight(4, FEEL, 25, (state) => {
    const n = state.night, you = state.players[0]!
    if (n.phase === "search" && !n.finds.length) { n.finds.push({ clue: CLUE.car, by: 0, at: state.t }); you.map.clues.push(CLUE.car) }
    you.x = far.x; you.z = far.z
  })
  console.log("car found by you", JSON.stringify(summary(r)))
  expect(r.state.night.finds[0]!.by).toBe(0)
  expect(r.state.night.phase).toBe("won")
})

test("a clue whose only holder leaves goes to the nearest searcher, and the night goes on", () => {
  let gone = -1, heir = -1, clue = -1
  const r = botNight(4, FEEL, 25, (state) => {
    const n = state.night
    if (gone >= 0) return
    const f = n.finds.find((k) => k.clue !== CLUE.car && k.by >= BOT_ID)
    if (!f) return
    gone = f.by; clue = f.clue
    const leaver = state.players.find((p) => p.id === gone)!
    expect(state.players.filter((p) => p.id !== gone && p.map.clues.includes(clue))).toEqual([])
    const rest = state.players.filter((p) => p.id !== gone)
    heir = rest.reduce((a, b) => (Math.hypot(b.x - leaver.x, b.z - leaver.z) < Math.hypot(a.x - leaver.x, a.z - leaver.z) ? b : a)).id
    removePlayer(state, gone)
  })
  console.log("holder left", JSON.stringify(summary(r)), { gone, heir, clue })
  const n = r.state.night
  expect(gone).toBeGreaterThanOrEqual(0)
  expect(n.finds.find((f) => f.clue === clue)!.held).toBe(heir)
  // The goal line sends you to whoever has it now, not to the one who left.
  const only = { ...n, phase: "search" as const, calls: 0, finds: n.finds.filter((f) => f.clue === clue) }
  expect(nextStep(only, [], (id) => (id === heir ? "Heir" : "Gone"))).toContain("Heir has")
  // Someone still knows it, and the trail carried on past it.
  expect(n.finds.length).toBeGreaterThan(2)
})

test("every clue and spare can be reached: none inside a trunk, rock or building, over 60 seeds", () => {
  const free = (x: number, z: number) => !isDeepWater(world, x, z) && solidsNear(world, x, z, 3).every(([x0, z0, x1, z1]) => x < x0 - PLAYER_RADIUS || x > x1 + PLAYER_RADIUS || z < z0 - PLAYER_RADIUS || z > z1 + PLAYER_RADIUS)
  const standable = (x: number, z: number, reach: number) => {
    for (let r = 0.4; r <= reach; r += 0.3) for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2
      if (free(x + Math.cos(a) * r, z + Math.sin(a) * r)) return true
    }
    return false
  }
  const inside = (x: number, z: number) =>
    world.rocks.some((k) => Math.abs(k.x - x) < Math.max(k.w, k.d) * 0.5 && Math.abs(k.z - z) < Math.max(k.w, k.d) * 0.5) ||
    world.buildings.some((b) => b.kind !== "dock" && b.kind !== "canoe" && b.kind !== "table" && x > b.rect[0] && x < b.rect[2] && z > b.rect[1] && z < b.rect[3])
  for (let seed = 1; seed <= 60; seed++) {
    const n = placeNight(world, seed)
    for (const c of n.clues) {
      expect(standable(c.x, c.z, c.reach - 0.3), `seed ${seed} ${c.kind}`).toBe(true)
      if (c.tree < 0) expect(inside(c.x, c.z), `seed ${seed} ${c.kind} in a solid`).toBe(false)
    }
    for (const sp of n.spares) {
      expect(standable(sp.x, sp.z, 1.3), `seed ${seed} spare ${sp.id}`).toBe(true)
      if (!sp.camp) expect(inside(sp.x, sp.z), `seed ${seed} spare ${sp.id} in a solid`).toBe(false)
    }
  }
})
