import { describe, expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CoopSim, hashSimState } from "../shared/coop-sim"
import type { BodiesState } from "../shared/bodies/runtime"
import { forceLife } from "../shared/death/runtime"
import { DEFAULT_DEATH_TUNING } from "../shared/death/rules"
import { outbreakSharedFeatures } from "../shared/feature-registry"
import { radioStoreId, ds as rds } from "../shared/radios/radios"
import type { RadiosState } from "../shared/radios/runtime"
import type { Command, SessionTuning, SurvivorSlot } from "../shared/sim-types"
import { generateWorldChunk, MACRO_SIZE } from "../shared/world"
import { DEFAULT_FIRE_TUNING } from "../shared/fire/fire"
import { explode } from "../shared/fire/runtime"
import { BOLT_CUTTERS } from "../shared/way-out/car"
import { broadcastOn, carriesFlyer, EVENT_BLOWN, EVENT_CUT, EVENT_ESCAPED, EVENT_HOTWIRED, EVENT_LEFT_BEHIND, EVENT_MISSED, policeSites, roadSites } from "../shared/way-out/clues"
import { roadblocksOf } from "../shared/way-out/roadblocks"
import { landmarkRects } from "../shared/way-out/landmark"
import { WayOutSounds } from "../src/way-out/sounds"
import type { SoundEvent } from "../src/audio/types"
import type { SoundHold } from "../src/audio/inventory"
import { outbreakWayOutSharedFeature } from "../shared/way-out/index"
import { alongRoute, DESTINATION_KINDS, routeLength, TOWN_CROSSROADS, wayOutPlan } from "../shared/way-out/plan"
import { nearDawnHour, planOf, seedOf, type WayOutState } from "../shared/way-out/runtime"
import { wayOutOf, WAY_OUT_STORE } from "../shared/way-out/state"
import { DEFAULT_WAY_OUT_TUNING, MISSED_LATE_BOAT, STAND_FIXED, type WayOutTuning } from "../shared/way-out/tuning"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession } from "../src/net-session"
import { Loopback } from "./loopback"

const T = DEFAULT_WAY_OUT_TUNING
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const quiet = (seed = 7, houseSeed = seed) => new CoopSim(seed, houseSeed, 0.22, { zombieCount: 0, directorPacing: 0 })
const tuning = (patch: Partial<WayOutTuning> = {}): SessionTuning => ({ wayOut: { ...T, ...patch } }) as SessionTuning
const stateOf = (sim: CoopSim) => sim.getFeatureState<WayOutState>("wayOut")!
const view = (sim: CoopSim) => wayOutOf(sim.progression.ledger)

function step(sim: CoopSim, ticks: number, tune: SessionTuning = tuning(), timeScale = 1, cmd: (slot: SurvivorSlot) => Command = (s) => idle(s.survivor.aim)): void {
  for (let i = 0; i < ticks; i++) {
    for (const slot of sim.slots) sim.stepSurvivor(slot, cmd(slot), TICK_DT, tune)
    sim.stepWorld(TICK_DT, timeScale, tune)
  }
}

const place = (sim: CoopSim, slot: SurvivorSlot, x: number, y: number, aim = 0) => {
  Object.assign(slot.survivor, { x, y, aim })
  sim.rebuildCollision()
}

/** Steps until it gets light (the clock run fast from just before dawn). */
function toDawn(sim: CoopSim, tune: SessionTuning, cmd?: (slot: SurvivorSlot) => Command): void {
  sim.hour = nearDawnHour()
  step(sim, 2, tune, 1, cmd)
  for (let i = 0; i < 600 && stateOf(sim).wasDark; i++) step(sim, 1, tune, 600, cmd)
}

describe("The Way Out: the destination", () => {
  test("one per town, the same every time, 1.5–3 km out by road on the road grid", () => {
    const kinds = new Set<string>()
    for (let seed = 1; seed <= 60; seed++) {
      const a = wayOutPlan(seed, seed * 7 + 1, T)
      const b = wayOutPlan(seed, seed * 7 + 1, { ...T })
      expect(b).toEqual(a)
      kinds.add(a.kind)
      expect(a.distance).toBeGreaterThanOrEqual(T.minDistance)
      expect(a.distance).toBeLessThanOrEqual(T.maxDistance)
      expect(routeLength(a.route)).toBe(a.distance)
      expect(a.route[0]).toEqual(TOWN_CROSSROADS)
      expect(a.route.at(-1)).toEqual({ x: a.x, y: a.y })
      // Every leg runs along a road: one coordinate is on a road line (44 + 96n) the whole way.
      for (let i = 0; i < a.route.length - 1; i++) {
        const p = a.route[i]!
        const q = a.route[i + 1]!
        expect(p.x === q.x || p.y === q.y).toBe(true)
        const fixed = p.x === q.x ? p.x : p.y
        expect((((fixed - 44) % MACRO_SIZE) + MACRO_SIZE) % MACRO_SIZE).toBe(0)
      }
    }
    expect(kinds.size).toBe(DESTINATION_KINDS.length)
    // Another town, another way out.
    expect(wayOutPlan(7, 7, T)).not.toEqual(wayOutPlan(7, 8, T))
  })

  test("distance and kind follow the tuning", () => {
    const near = wayOutPlan(11, 11, { ...T, minDistance: 400, maxDistance: 500 })
    expect(near.distance).toBeGreaterThanOrEqual(384)
    expect(near.distance).toBeLessThanOrEqual(500)
    for (let k = 0; k < 4; k++) expect(wayOutPlan(11, 11, { ...T, destination: k }).kind).toBe(DESTINATION_KINDS[k]!)
  })

  test("the road sign and the soldier lie on the route's pavement, clear of buildings", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const plan = wayOutPlan(seed, seed, T)
      for (const site of roadSites(plan)) {
        const spot = site.kind === "sign" ? plan.sign : plan.soldier
        const p = alongRoute(plan.route, spot.along)
        expect(Math.abs(Math.hypot(site.x - p.x, site.y - p.y) - 5)).toBeLessThan(0.05)
        const cx = Math.floor(site.x / 32)
        const cy = Math.floor(site.y / 32)
        const chunk = generateWorldChunk(seed, seed, cx, cy, "streaming")
        for (const b of chunk.buildings) {
          const inside = site.x > b.rect[0] && site.x < b.rect[2] && site.y > b.rect[1] && site.y < b.rect[3]
          expect(inside).toBe(false)
        }
      }
    }
  })
})

describe("The Way Out: clues", () => {
  test("the chain is always completable: a police station a block south of town holds a map piece, and the route has a sign and a soldier", () => {
    for (let seed = 1; seed <= 20; seed++) {
      // Block (0, 1) is always civic; its police station stands in chunk (1, 3).
      const chunk = generateWorldChunk(seed, seed, 1, 3, "streaming")
      const town = { buildings: chunk.buildings, props: chunk.props } as Parameters<typeof policeSites>[0]
      expect(policeSites(town).length).toBeGreaterThan(0)
      expect(roadSites(wayOutPlan(seed, seed, T)).map((s) => s.kind)).toEqual(["sign", "soldier"])
    }
  })

  test("rumour, direction, confirmed: reading the sign then searching the soldier pins it", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    step(sim, 2)
    expect(view(sim)?.tier).toBe(0)
    const plan = planOf(sim, T)
    const handler = sim.registry.get("clue")!
    // Walk (teleport) to the sign: its prompt is offered, and reading it gives the direction.
    place(sim, a, plan.sign.x + 0.9, plan.sign.y)
    sim.refreshPrompt(a)
    const offered = handler.candidates(sim.town, a.survivor).map((c) => c.id)
    expect(offered).toContain("sign")
    expect(handler.execute(sim.town, a.survivor, "sign", "read").handled).toBe(true)
    expect(view(sim)?.tier).toBe(2)
    expect(a.notices.at(-1)?.key).toBe("wayout")
    // Reading it again changes nothing.
    expect(handler.execute(sim.town, a.survivor, "sign", "read").handled).toBe(false)
    place(sim, a, plan.soldier.x + 0.8, plan.soldier.y)
    expect(handler.execute(sim.town, a.survivor, "soldier", "search").handled).toBe(true)
    expect(view(sim)?.tier).toBe(3)
  })

  test("a broadcast on a playing radio is a rumour, only while it is on and only close by", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    step(sim, 2)
    const r = sim.getFeatureState<RadiosState>("radios")!.sites[0]!
    expect(r).toBeDefined()
    sim.progression.ledger.createStore({ id: radioStoreId(r.buildingId), mode: "counters", scope: "shared", initial: { on: 1, start: rds(sim.time), until: rds(sim.time + 600) } })
    place(sim, a, r.x + 1, r.y + 1)
    // Off air: nothing.
    const offAir = [0.1, 0.5, 1, 1.5].map((h) => 9 + h).find((h) => !broadcastOn(h, T.broadcastEvery, T.broadcastLength))!
    sim.hour = offAir
    step(sim, 3)
    expect(view(sim)?.tier ?? 0).toBe(0)
    sim.hour = 10.1
    expect(broadcastOn(sim.hour, T.broadcastEvery, T.broadcastLength)).toBe(true)
    place(sim, a, r.x + T.radioHear + 3, r.y)
    step(sim, 3)
    expect(view(sim)?.tier ?? 0).toBe(0)
    place(sim, a, r.x + 1, r.y + 1)
    step(sim, 3)
    expect(view(sim)?.tier).toBe(1)
    expect(view(sim)?.clues.has("radio")).toBe(true)
  })

  test("searching a body that carries a flyer is a rumour; homes hold notes", () => {
    const sim = quiet()
    sim.addSurvivor("a", 0)
    const tune = tuning({ flyerShare: 1, noteShare: 1 })
    step(sim, 2, tune)
    const body = sim.getFeatureState<BodiesState>("bodies")!.sites[0]!
    expect(carriesFlyer(seedOf(sim), body.key, 1)).toBe(true)
    sim.progression.ledger.store(body.id)!.revealed = true
    step(sim, 1, tune)
    expect(view(sim)?.clues.has(`flyer:${body.key}`)).toBe(true)
    expect(view(sim)?.tier).toBe(1)
    const notes = stateOf(sim).sites.filter((s) => s.kind === "note")
    expect(notes.length).toBeGreaterThan(0)
  })

  test("arriving at the destination confirms it, whatever was found before", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    step(sim, 2)
    const plan = planOf(sim, T)
    place(sim, a, plan.x - 30, plan.y)
    step(sim, 2)
    expect(view(sim)?.tier).toBe(3)
    expect(view(sim)?.clues.has("arrive")).toBe(true)
  })
})

describe("The Way Out: the stand and the escape", () => {
  test("signal at the post, hold until dawn against the siege, and the squad in the zone escapes", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const b = sim.addSurvivor("b", 1)
    const tune = tuning()
    step(sim, 2, tune)
    const plan = planOf(sim, T)
    place(sim, a, plan.signal.x + 0.6, plan.signal.y)
    place(sim, b, plan.x - 200, plan.y)
    step(sim, 1, tune)
    const post = sim.registry.get("signal")!
    expect(post.candidates(sim.town, a.survivor).length).toBe(1)
    expect(post.execute(sim.town, a.survivor, "signal", "toggle").handled).toBe(true)
    expect(view(sim)?.signalled).toBe(true)
    const before = sim.ai.agents.filter((z) => z.state !== "dead").length
    step(sim, Math.ceil(4 / TICK_DT), tune)
    expect(sim.ai.agents.filter((z) => z.state !== "dead").length).toBeGreaterThan(before)
    expect(view(sim)?.wave).toBeGreaterThan(0)
    // Hold still at the post (the dead are made harmless here so the test is about the clock).
    for (const z of sim.ai.agents) z.state = "dead"
    toDawn(sim, tune, () => idle(0))
    const v = view(sim)!
    expect(v.won).toBe(true)
    expect(v.last).toBe(EVENT_ESCAPED)
    expect(v.escaped).toEqual([a.index])
    expect(v.wonNight).toBeGreaterThanOrEqual(1)
    // Once out: nothing moves, nothing hurts.
    const x = a.survivor.x
    step(sim, 5, tune, 1, () => ({ mx: 1, my: 0, aim: 0, interact: false }))
    expect(a.survivor.x).toBe(x)
    expect(a.prompt).toBeUndefined()
  })

  test("a flare burning in the zone or a horn there signals too; the fixed hold ends the stand", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const tune = tuning({ standRule: STAND_FIXED, standHold: 20 })
    step(sim, 2, tune)
    const plan = planOf(sim, T)
    place(sim, a, plan.x + 2, plan.y + 2)
    sim.progression.ledger.createStore({ id: "flare:test", mode: "counters", scope: "shared", owner: a.id, at: { x: plan.x, y: plan.y }, initial: { t: rds(sim.time), until: rds(sim.time + 30) } })
    step(sim, 1, tune)
    expect(view(sim)?.signalled).toBe(true)
    for (let i = 0; i < Math.ceil(21 / TICK_DT); i++) {
      for (const z of sim.ai.agents) z.state = "dead"
      step(sim, 1, tune)
    }
    expect(view(sim)?.won).toBe(true)
  })

  test("nobody in the zone at dawn: it leaves without them and they can signal again", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const tune = tuning({ siegeWave: 0 })
    step(sim, 2, tune)
    const plan = planOf(sim, T)
    place(sim, a, plan.signal.x + 0.6, plan.signal.y)
    sim.registry.get("signal")!.execute(sim.town, a.survivor, "signal", "toggle")
    place(sim, a, plan.x + 90, plan.y)
    toDawn(sim, tune)
    const v = view(sim)!
    expect(v.won).toBe(false)
    expect(v.last).toBe(EVENT_LEFT_BEHIND)
    expect(v.signalled).toBe(false)
  })

  test("the deadline: after the dawn of the last night the way out is gone, unless a late boat is allowed", () => {
    for (const rule of [0, MISSED_LATE_BOAT]) {
      const sim = quiet()
      sim.addSurvivor("a", 0)
      const tune = tuning({ deadlineNight: 1, missedRule: rule, lateNights: 2 })
      step(sim, 2, tune)
      expect(view(sim)?.night).toBe(1)
      toDawn(sim, tune)
      const v = view(sim)!
      if (rule === MISSED_LATE_BOAT) {
        expect(v.missed).toBe(false)
        expect(v.late).toBe(true)
        expect(v.deadline).toBe(3)
      } else {
        expect(v.missed).toBe(true)
        expect(v.last).toBe(EVENT_MISSED)
        // Gone means gone: the post offers nothing.
        const plan = planOf(sim, T)
        const a = sim.slots[0]!
        place(sim, a, plan.signal.x + 0.6, plan.signal.y)
        expect(sim.registry.get("signal")!.candidates(sim.town, a.survivor)).toEqual([])
      }
    }
  })

  test("the dead never escape; the down are carried aboard; kills go on the card", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const b = sim.addSurvivor("b", 1)
    const c = sim.addSurvivor("c", 2)
    const tune = tuning({ standRule: STAND_FIXED, standHold: 5, siegeWave: 0 })
    step(sim, 2, tune)
    const plan = planOf(sim, T)
    for (const [s, dx] of [[a, 1], [b, 2], [c, 3]] as const) place(sim, s, plan.x + dx, plan.y + 1)
    forceLife(sim, b, "down", DEFAULT_DEATH_TUNING)
    forceLife(sim, c, "dead", DEFAULT_DEATH_TUNING)
    sim.getFeatureState<{ records: Record<number, { kills: number }> }>("death")!.records[a.index]!.kills = 7
    sim.registry.get("signal")!
    stateOf(sim)
    place(sim, a, plan.signal.x + 0.6, plan.signal.y)
    sim.registry.get("signal")!.execute(sim.town, a.survivor, "signal", "toggle")
    step(sim, Math.ceil(6 / TICK_DT), tune)
    const v = view(sim)!
    expect(v.won).toBe(true)
    expect(v.escaped).toEqual([a.index, b.index])
    expect(v.kills[a.index]).toBe(7)
  })
})

const holdE = (s: SurvivorSlot): Command => ({ ...idle(s.survivor.aim), interactHeld: true })
const give = (sim: CoopSim, slot: SurvivorSlot, item: string, count = 1) => {
  sim.progression.ledger.apply({ kind: "grant", actor: slot.id, item, count })
  sim.progression.project(slot)
}
const hasRect = (rects: readonly (readonly number[])[], r: readonly number[]) => rects.some((x) => x.every((v, i) => v === r[i]))

describe("The Way Out: the car and the roadblocks", () => {
  test("roadblocks lie across the route past the soldier, spaced, with a gap people fit through and cars do not", () => {
    let gates = 0
    for (let seed = 1; seed <= 40; seed++) {
      const plan = wayOutPlan(seed, seed, T)
      const blocks = roadblocksOf(plan, T)
      expect(roadblocksOf(plan, { ...T })).toEqual(blocks)
      expect(blocks.length).toBeGreaterThan(0)
      expect(blocks.length).toBeLessThanOrEqual(T.roadblocks)
      expect(roadblocksOf(plan, { ...T, roadblocks: 0 })).toEqual([])
      let prev = plan.soldier.along
      for (const b of blocks) {
        expect(b.along - prev).toBeGreaterThanOrEqual(90)
        expect(b.along).toBeLessThanOrEqual(plan.distance - 139)
        prev = b.along
        const p = alongRoute(plan.route, b.along)
        expect(Math.hypot(p.x - b.x, p.y - b.y)).toBeLessThan(0.01)
        // The car box spans the road and both verges; the gap is inside it but in no walk box.
        const across = b.dx ? b.car[3] - b.car[1] : b.car[2] - b.car[0]
        expect(across).toBeGreaterThanOrEqual(24)
        const inRect = (r: readonly number[], x: number, y: number) => x > r[0]! && x < r[2]! && y > r[1]! && y < r[3]!
        expect(inRect(b.car, b.gap.x, b.gap.y)).toBe(true)
        expect(b.walk.some((r) => inRect(r, b.gap.x, b.gap.y))).toBe(false)
        const gapWide = b.dx ? Math.min(...b.walk.map((r) => Math.abs((r[1]! + r[3]!) / 2 - b.gap.y))) : Math.min(...b.walk.map((r) => Math.abs((r[0]! + r[2]!) / 2 - b.gap.x)))
        expect(gapWide).toBeGreaterThan(0)
        if (b.kind === "gate") gates++
      }
    }
    expect(gates).toBeGreaterThan(5)
  })

  test("a standing roadblock stops cars and people outside its gap; a blast clears it and the road opens", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const tune = tuning()
    step(sim, 2, tune)
    const b = roadblocksOf(planOf(sim, T), T)[0]!
    place(sim, a, b.x - b.dx * 10, b.y - b.dy * 10)
    step(sim, 2, tune)
    expect(hasRect(sim.vehicleSolids, b.car)).toBe(true)
    expect(view(sim)?.seen.has(0)).toBe(true)
    // Into a walk box: pushed out. At the gap: through.
    const wall = b.walk[0]!
    place(sim, a, (wall[0] + wall[2]) / 2, (wall[1] + wall[3]) / 2)
    step(sim, 1, tune)
    const inWall = a.survivor.x > wall[0] && a.survivor.x < wall[2] && a.survivor.y > wall[1] && a.survivor.y < wall[3]
    expect(inWall).toBe(false)
    place(sim, a, b.gap.x, b.gap.y)
    step(sim, 1, tune)
    expect(Math.hypot(a.survivor.x - b.gap.x, a.survivor.y - b.gap.y)).toBeLessThan(0.2)
    // A blast far off does nothing; dynamite at the block clears it.
    place(sim, a, b.x - b.dx * 20, b.y - b.dy * 20)
    explode(sim, b.x - b.dx * 30, b.y - b.dy * 30, a.id, DEFAULT_FIRE_TUNING)
    step(sim, 1, tune)
    expect(view(sim)?.cleared[0]).toBeUndefined()
    explode(sim, b.x - b.dx * 3, b.y - b.dy * 3, a.id, DEFAULT_FIRE_TUNING)
    step(sim, 1, tune)
    expect(view(sim)?.cleared[0]).toBe(1)
    expect(view(sim)?.last).toBe(EVENT_BLOWN)
    expect(hasRect(sim.vehicleSolids, b.car)).toBe(false)
  })

  test("bolt cutters open a chained gate: hold E at the padlock", () => {
    let seed = 1
    while (!roadblocksOf(wayOutPlan(seed, seed, T), T).some((b) => b.kind === "gate")) seed++
    const sim = quiet(seed)
    const a = sim.addSurvivor("a", 0)
    const tune = tuning()
    step(sim, 2, tune)
    const gate = roadblocksOf(planOf(sim, T), T).find((b) => b.kind === "gate")!
    place(sim, a, gate.lock.x - gate.dx * 0.6, gate.lock.y - gate.dy * 0.6, Math.atan2(gate.dy, gate.dx))
    step(sim, 1, tune)
    expect(a.prompt?.kind).not.toBe("gate")
    give(sim, a, BOLT_CUTTERS)
    step(sim, 1, tune)
    expect(a.prompt?.kind).toBe("gate")
    // Letting go loses the cut; holding it through finishes it.
    step(sim, Math.ceil(1 / TICK_DT), tune, 1, holdE)
    expect(view(sim)?.cut?.progress).toBeGreaterThan(0.1)
    step(sim, 40, tune)
    expect(view(sim)?.cut).toBeNull()
    step(sim, Math.ceil((T.cutTime + 0.5) / TICK_DT), tune, 1, holdE)
    expect(view(sim)?.cleared[gate.index]).toBe(2)
    expect(view(sim)?.last).toBe(EVENT_CUT)
    expect(hasRect(sim.vehicleSolids, gate.car)).toBe(false)
  })

  // Kit: "I was able to start the car right away." The sedan by the start used to spawn with its keys and 80% fuel.
  test("the car project: no parked car starts right away, the one by the start included, near or far", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const notReady = () => {
      expect(sim.vehicles.list.length).toBeGreaterThan(0)
      for (const v of sim.vehicles.list) {
        if (v.modified) continue
        expect([v.id, v.hasBattery && v.hasKeys]).toEqual([v.id, false])
        expect([v.id, v.fuel]).toEqual([v.id, 0])
      }
    }
    expect(sim.vehicles.list.length).toBeGreaterThanOrEqual(4)
    notReady()
    const tune = tuning()
    const starter = sim.vehicles.byId(1)!
    expect(Math.hypot(starter.x - a.survivor.x, starter.y - a.survivor.y)).toBeLessThan(6)
    expect(starter.hasKeys).toBe(false)
    step(sim, 2, tune)
    expect(sim.vehicles.enter(a, starter, sim.progression, sim.ai, sim.time)).toBe(true)
    const throttle = (s: SurvivorSlot): Command => ({ ...idle(s.survivor.aim), my: -1 })
    const [x0, y0] = [starter.x, starter.y]
    step(sim, 60, tune, 1, throttle)
    expect(starter.engineOn).toBe(false)
    expect(Math.hypot(starter.x - x0, starter.y - y0)).toBeLessThan(0.1)
    // A key from a house and a gas can: now it goes.
    give(sim, a, "key")
    give(sim, a, "fuel")
    step(sim, 30, tune, 1, throttle)
    expect(starter.engineOn).toBe(true)
    expect(Math.hypot(starter.x - x0, starter.y - y0)).toBeGreaterThan(0.5)
    // Cars streamed in far from town are no different.
    sim.vehicles.leaveSeat(a.id, a.survivor)
    a.survivor.vehicleId = null
    place(sim, a, 7 * 96 + 44, 3 * 96 + 20)
    step(sim, 5, tune)
    expect(sim.vehicles.list.filter((v) => !v.modified).length).toBeGreaterThan(0)
    notReady()
  })

  test("with the car project off the start sedan is ready as before, and untouched cars follow the switch", () => {
    const sim = quiet()
    sim.addSurvivor("a", 0)
    step(sim, 1, tuning({ carProject: 0 }))
    const starter = sim.vehicles.byId(1)!
    expect([starter.hasBattery, starter.hasKeys, starter.fuel]).toEqual([true, true, 80])
    step(sim, 1, tuning())
    expect([starter.hasKeys, starter.fuel]).toEqual([false, 0])
    step(sim, 1, tuning({ wayOut: 0 }))
    expect([starter.hasKeys, starter.fuel]).toEqual([true, 80])
  })

  test("a toolbox hotwires a car with no keys; gas cans fill a tank, the pumps are dry, Chem no longer does", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const tune = tuning()
    step(sim, 2, tune)
    const v = sim.vehicles.spawnVehicle("sedan", 44, 70, Math.PI / 2, { fuel: 0, hasKeys: false })
    place(sim, a, 41.8, 70, 0)
    step(sim, 1, tune)
    expect(a.prompt?.kind).toBe("vehicle")
    give(sim, a, "toolbox")
    step(sim, 1, tune)
    expect(a.prompt?.kind).toBe("hotwire")
    step(sim, Math.ceil((T.hotwireTime + 0.5) / TICK_DT), tune, 1, holdE)
    expect(v.hasKeys).toBe(true)
    expect(view(sim)?.last).toBe(EVENT_HOTWIRED)
    // Chem does nothing for an empty tank now; two gas cans pour in when you get in.
    give(sim, a, "chem", 4)
    give(sim, a, "fuel", 2)
    expect(sim.vehicles.enter(a, v, sim.progression, sim.ai, sim.time)).toBe(true)
    expect(v.fuel).toBe(T.canFill * 2)
    expect(sim.progression.ledger.count(a.id, "chem")).toBe(4)
    expect(sim.progression.ledger.count(a.id, "fuel")).toBe(0)
    expect(sim.vehicles.refuelRule().pumps).toBe(false)
    // As before with the car project off: Chem fills an empty tank to 55, the pumps work.
    step(sim, 1, tuning({ carProject: 0 }))
    expect(sim.vehicles.refuelRule()).toMatchObject({ item: "chem", pumps: true })
  })
})

describe("The Way Out: polish", () => {
  test("the dead do not walk through the destination's solids or a roadblock, but squeeze through its gap", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const tune = tuning()
    step(sim, 2, tune)
    const plan = planOf(sim, T)
    const b = roadblocksOf(plan, T)[0]!
    place(sim, a, b.x - b.dx * 30, b.y - b.dy * 30)
    const wall = b.walk[0]!
    const solid = landmarkRects(plan)[0]!
    const inside = (r: readonly number[], p: { x: number; y: number }) => p.x > r[0]! && p.x < r[2]! && p.y > r[1]! && p.y < r[3]!
    const z1 = sim.ai.spawnZombie(sim.town, (wall[0] + wall[2]) / 2, (wall[1] + wall[3]) / 2, "wander")
    const z2 = sim.ai.spawnZombie(sim.town, (solid[0] + solid[2]) / 2, (solid[1] + solid[3]) / 2, "wander")
    const z3 = sim.ai.spawnZombie(sim.town, b.gap.x, b.gap.y, "wander")
    step(sim, 1, tune)
    expect(inside(wall, z1)).toBe(false)
    expect(inside(solid, z2)).toBe(false)
    expect(Math.hypot(z3.x - b.gap.x, z3.y - b.gap.y)).toBeLessThan(0.5)
  })

  test("a driver stopped at a gas station hears the pumps are dry", () => {
    const sim = quiet()
    const a = sim.addSurvivor("a", 0)
    const tune = tuning()
    step(sim, 2, tune)
    // The nearest gas station in the streamed world: walk there so its chunk loads.
    let at: { x: number; y: number } | null = null
    for (let r = 0; r < 12 && !at; r++) {
      for (let cx = -r; cx <= r && !at; cx++) {
        for (let cy = -r; cy <= r && !at; cy++) {
          if (Math.max(Math.abs(cx), Math.abs(cy)) !== r) continue
          const g = generateWorldChunk(7, 7, cx, cy, "streaming").buildings.find((x) => (x.archetype ?? x.kind) === "gas_station")
          if (g) at = { x: (g.rect[0] + g.rect[2]) / 2, y: g.rect[3] + 3 }
        }
      }
    }
    expect(at).not.toBeNull()
    place(sim, a, at!.x, at!.y)
    step(sim, 2, tune)
    const station = sim.town.buildings.find((x) => (x.archetype ?? x.kind) === "gas_station")!
    expect(station).toBeDefined()
    const v = sim.vehicles.spawnVehicle("sedan", station.rect[0] - 4, (station.rect[1] + station.rect[3]) / 2, Math.PI / 2, { fuel: 30 })
    v.seats[0] = a.id
    a.survivor.vehicleId = v.id
    step(sim, 2, tune)
    expect(a.notices.some((n) => n.text?.includes("pumps are dry"))).toBe(true)
    expect(v.fuel).toBeLessThan(31)
  })

  test("sounds come from the store: a clue, the hotwire held and caught, a blast, the escape", () => {
    const stores = new Map<string, { counts: Record<string, number> }>()
    const sounds = new WayOutSounds()
    const run = () => {
      const out: SoundEvent[] = []
      const holds: SoundHold[] = []
      sounds.observe({ stores } as never, { x: 1, y: 2 }, (e) => out.push(e), holds)
      return { ids: out.map((e) => e.id), holds: holds.map((h) => h.id) }
    }
    expect(run()).toEqual({ ids: [], holds: [] })
    stores.set(WAY_OUT_STORE, { counts: { last: 5, lastAt: 10 } })
    expect(run().ids).toEqual(["pickup.item"])
    expect(run().ids).toEqual([])
    stores.get(WAY_OUT_STORE)!.counts = { last: 5, lastAt: 10, hw: 4000, hx: 440, hy: 700 }
    expect(run()).toEqual({ ids: [], holds: ["craft.tinker.loop"] })
    stores.get(WAY_OUT_STORE)!.counts = { last: EVENT_HOTWIRED, lastAt: 11, ex: 440, ey: 700 }
    expect(run().ids).toEqual(["craft.tinker.done", "flashlight.click"])
    stores.get(WAY_OUT_STORE)!.counts = { last: EVENT_BLOWN, lastAt: 12 }
    expect(run().ids).toEqual(["melee.hit.metal", "impact.bullet.metal"])
    stores.get(WAY_OUT_STORE)!.counts = { last: EVENT_ESCAPED, lastAt: 13 }
    expect(run().ids).toEqual(["bench.research.done"])
  })
})

describe("The Way Out: co-op and Off", () => {
  test("clients see the clues and the escape; a won room restarts", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("test", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 2)
    const ann = new NetSession({ features, url: "loop", room: "test", name: "Ann", now: () => net.now, WebSocket: net.socketClass() })
    const tick = (n: number) => {
      for (let i = 0; i < n; i++) {
        virtualMs = net.now * 1000
        net.step()
        if (core.phase === "lobby") core.start()
        ann.update(TICK_DT, idle(0))
        ann.sync(TICK_DT)
      }
    }
    tick(30)
    expect(ann.connected).toBe(true)
    const sa = core.sim.slot(ann.id)!
    const plan = planOf(core.sim, T)
    // The client computes the same plan and offers the same clue prompts.
    expect(planOf(ann.sim, T)).toEqual(plan)
    place(core.sim, sa, plan.sign.x + 0.9, plan.sign.y)
    tick(20)
    expect(core.sim.registry.get("clue")!.execute(core.sim.town, sa.survivor, "sign", "read").handled).toBe(true)
    tick(10)
    expect(wayOutOf(ann.sim.progression.ledger)?.tier).toBe(2)
    expect(ann.view.notices.some((n) => n.key === "wayout")).toBe(true)
    // Escape: the client sees it and the room may restart.
    place(core.sim, sa, plan.signal.x + 0.6, plan.signal.y)
    tick(10)
    const state = core.sim.getFeatureState<WayOutState>("wayOut")!
    state.tuning = { ...state.tuning }
    core.sim.registry.get("signal")!.execute(core.sim.town, sa.survivor, "signal", "toggle")
    core.sim.hour = nearDawnHour()
    for (let i = 0; i < 4000 && !core.runOver; i++) {
      for (const z of core.sim.ai.agents) z.state = "dead"
      tick(1)
    }
    expect(core.runOver).toBe(true)
    tick(5)
    expect(wayOutOf(ann.sim.progression.ledger)?.won).toBe(true)
    const old = core.sim
    ann.restart()
    tick(6)
    expect(core.sim).not.toBe(old)
    expect(core.runOver).toBe(false)
    ann.close()
  })

  test("Off is endless survival, exactly as without the feature", () => {
    const run = (registered: boolean) => {
      if (!registered) outbreakSharedFeatures.unregister("wayOut")
      try {
        const sim = new CoopSim(7, 7, 0.22, { zombieCount: 6 })
        sim.addSurvivor("a", 0)
        const tune = tuning({ wayOut: 0 })
        step(sim, 300, tune, 120, (s) => ({ mx: 0.4, my: 0.2, aim: 0.3, interact: false, sprint: true }))
        const snap = sim.toSnapshot()
        delete (snap.featureStates as Record<string, unknown>).wayOut
        expect(sim.progression.ledger.store(WAY_OUT_STORE)).toBeUndefined()
        return hashSimState(snap)
      } finally {
        if (!registered) outbreakSharedFeatures.register(outbreakWayOutSharedFeature)
      }
    }
    expect(run(true)).toBe(run(false))
  })
})
