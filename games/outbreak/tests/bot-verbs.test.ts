import { describe, expect, test } from "bun:test"
import type { AIConfig } from "../shared/ai"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import { tripStoreId } from "../shared/discovery/verbs"
import type { Command } from "../shared/session"
import { createBotWorldView, SurvivorBot, type BotSkillPresetId } from "../shared/survivor-bot"

const DT = 1 / 15

function scene(at: { x: number; y: number; aim: number }, ai: Partial<AIConfig> = {}, preset: BotSkillPresetId = "Skilled") {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, openingCalm: 0, ...ai }, undefined, "classic")
  const slot = sim.addSurvivor("player", 0)
  Object.assign(slot.survivor, at)
  const bot = new SurvivorBot("player", 0, 7, preset)
  return { sim, slot, bot }
}

function run(
  s: { sim: CoopSim; slot: SurvivorSlot; bot: SurvivorBot },
  seconds: number,
  each?: (cmd: Command) => boolean | void,
): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const cmd = s.bot.step(DT, createBotWorldView(s.sim))
    s.sim.stepSurvivor(s.slot, cmd, DT)
    s.sim.stepWorld(DT, 240)
    if (each?.(cmd) || s.slot.survivor.health <= 0) return
  }
}

function grant(sim: CoopSim, item: string, count = 1) {
  sim.progression.ledger.apply({ kind: "grant", actor: "player", item, count })
  sim.progression.project(sim.slots[0]!)
}

/** No planks, so the bot does not spend the scene boarding windows. */
function drainPlanks(sim: CoopSim) {
  const planks = sim.progression.ledger.count("player/pack", "plank")
  if (planks) sim.progression.ledger.apply({ kind: "drain", store: "player/pack", item: "plank", count: planks })
}

describe("Survivor bots use the D-19 slice 4 verbs", () => {
  test("hides in a closet when worn out and chased, waits for the room to clear, and steps out unhurt", () => {
    const s = scene({ x: 27.6, y: 27.2, aim: Math.PI / 2 })
    Object.assign(s.slot.survivor, { stamina: 0.1, exhausted: true })
    s.sim.ai.spawnZombie(s.sim.town, 27.6, 33.5, "chase", -Math.PI / 2)
    s.sim.ai.spawnZombie(s.sim.town, 29.5, 33.5, "chase", -Math.PI / 2)

    let hiddenAt = -1
    let snapshotMidHide: ReturnType<SurvivorBot["toSnapshot"]> | null = null
    run(s, 4, () => {
      if (s.sim.progression.verbs.hiddenIn("player") && hiddenAt < 0) hiddenAt = s.sim.time
    })
    expect(hiddenAt).toBeGreaterThan(0)
    snapshotMidHide = s.bot.toSnapshot()
    // Verb memory is plain data and survives a snapshot round trip exactly.
    expect(JSON.stringify(SurvivorBot.fromSnapshot(JSON.parse(JSON.stringify(snapshotMidHide))).toSnapshot())).toBe(JSON.stringify(snapshotMidHide))
    expect(snapshotMidHide.verbMemory!.hiddenSince).toBeGreaterThan(0)
    expect(snapshotMidHide.knownClosets!.length).toBeGreaterThan(0)

    let leftAt = -1
    run(s, 90, () => {
      if (!s.sim.progression.verbs.hiddenIn("player")) {
        leftAt = s.sim.time
        return true
      }
      expect(s.slot.survivor.health).toBe(100)
    })
    expect(leftAt - hiddenAt).toBeGreaterThanOrEqual(6)
    expect(s.slot.survivor.health).toBe(100)
  })

  test("crouches up to a trapped door's cans and disarms them, learning the tripwire and keeping the cans", () => {
    // The pharmacy's front door faces south, so its cans hang across the step outside.
    const s = scene({ x: 58.7, y: 72.5, aim: -Math.PI / 2 }, { startHour: 12 })
    const store = () => s.sim.progression.ledger.store(tripStoreId("pharmacy-front"))!
    expect(store().counts.armed).toBe(1)
    let crouched = false
    let sprungUpright = false
    run(s, 25, (cmd) => {
      if (cmd.crouch) crouched = true
      if (!store().counts.armed && !store().counts.down) sprungUpright = true
      return Boolean(store().counts.down)
    })
    expect(sprungUpright).toBe(false)
    expect(crouched).toBe(true)
    expect(store().counts.down).toBe(1)
    expect(s.sim.progression.ledger.count("player", "cans")).toBe(1)
    expect(s.sim.progression.learned("tripwire")).toBe(true)
  })

  test("crouches over broken glass so its steps do not crunch", () => {
    // Seed 7's pharmacy: bottles broken in a line out from the front door. The bot comes up the line to the door.
    const s = scene({ x: 53.6, y: 75.2, aim: -Math.PI / 4 }, { startHour: 12 })
    const steps = () => {
      let n = 0
      for (const st of s.sim.progression.ledger.stores.values()) if (st.id.startsWith("glass:")) n += st.counts.steps ?? 0
      return n
    }
    let crouchedNearGlass = false
    let nearest = Infinity
    run(s, 25, (cmd) => {
      const p = s.slot.survivor
      for (const st of s.sim.progression.ledger.stores.values()) {
        if (!st.id.startsWith("glass:") || !st.at) continue
        const d = Math.hypot(st.at.x - p.x, st.at.y - p.y)
        nearest = Math.min(nearest, d)
        if (d < 1 && cmd.crouch) crouchedNearGlass = true
      }
      return Boolean(s.sim.progression.ledger.store(tripStoreId("pharmacy-front"))?.counts.down)
    })
    expect(nearest).toBeLessThan(0.6)
    expect(crouchedNearGlass).toBe(true)
    expect(steps()).toBe(0)
  })

  test("strings carried cans across the safehouse door as night falls", () => {
    const s = scene({ x: 27.7, y: 32.5, aim: Math.PI / 2 }, { startHour: 21 })
    drainPlanks(s.sim)
    grant(s.sim, "cans")
    expect(s.sim.progression.ledger.store(tripStoreId("ash-front"))).toBeUndefined()
    run(s, 20, () => Boolean(s.sim.progression.ledger.store(tripStoreId("ash-front"))?.counts.armed))
    expect(s.sim.progression.ledger.store(tripStoreId("ash-front"))?.counts.armed).toBe(1)
    expect(s.sim.progression.ledger.count("player", "cans")).toBe(0)
  })

  test("throws a bottle to pull off the dead that are coming but have not locked on, and not at ones chasing by sight", () => {
    const s = scene({ x: 44, y: 44, aim: 0 })
    grant(s.sim, "bottle")
    // Three of the dead investigating something to the east, their backs to the bot.
    for (const [dx, dy] of [[8, 0], [8, 1.5], [8.5, -1.5]] as const) s.sim.ai.spawnZombie(s.sim.town, 44 + dx, 44 + dy, "investigate", 0)
    let thrown = false
    s.sim.progression.ledger.on((ev) => {
      if (ev.kind === "ran" && ev.rule === "throw:bottle") thrown = true
    })
    // It breaks where it lands, after its flight (AR-96).
    run(s, 6, () => thrown && s.sim.ai.noiseBus.events.some((e) => e.kind === "glass"))
    expect(thrown).toBe(true)
    expect(s.sim.ai.noiseBus.events.some((e) => e.kind === "glass")).toBe(true)

    // The same three already chasing it by sight: a bottle would not turn them, so it keeps the bottle.
    const chased = scene({ x: 44, y: 44, aim: 0 })
    grant(chased.sim, "bottle")
    for (const [dx, dy] of [[5.5, 0], [5.5, 1.5], [6, -1.5]] as const) chased.sim.ai.spawnZombie(chased.sim.town, 44 + dx, 44 + dy, "chase", Math.PI)
    run(chased, 3)
    expect(chased.sim.progression.ledger.count("player", "bottle")).toBe(1)
  })

  test("re-nails a splintered barricade with a crowbar in hand", () => {
    const s = scene({ x: 34.5, y: 29.2, aim: 0 }, { startHour: 21 })
    grant(s.sim, "crowbar")
    const portal = s.sim.ai.portalStates.get("ash-east")!
    portal.barricadePlanks = 2
    portal.barricadeHp = 60
    let repaired = false
    s.sim.progression.ledger.on((ev) => {
      if (ev.kind === "ran" && ev.rule === "repair") repaired = true
    })
    run(s, 20, () => repaired)
    expect(repaired).toBe(true)
    expect(portal.barricadeHp).toBeGreaterThan(150)
  })

  test("swaps a crowbar out of the pack to re-nail when the hotbar is full", () => {
    const s = scene({ x: 34.5, y: 29.2, aim: 0 }, { startHour: 21 })
    for (const item of ["knife", "medkit", "cans", "crowbar"]) grant(s.sim, item)
    expect(s.sim.progression.ledger.count("player/pack", "crowbar")).toBe(1)
    const portal = s.sim.ai.portalStates.get("ash-east")!
    portal.barricadePlanks = 2
    portal.barricadeHp = 60
    let repaired = false
    s.sim.progression.ledger.on((ev) => {
      if (ev.kind === "ran" && ev.rule === "repair") repaired = true
    })
    run(s, 20, () => repaired)
    expect(repaired).toBe(true)
  })

  test("looks through the peephole before opening an outer door at night, and waits while the dead are outside", () => {
    // Inside Elm House at night with no planks: the bot heads out through the shut front door.
    const elm = (zombieOutside: boolean) => {
      const s = scene({ x: 26.7, y: 63.6, aim: Math.PI / 2 }, { startHour: 21 })
      drainPlanks(s.sim)
      const door = s.sim.town.doors.find((d) => d.id === "elm-front")!
      door.open = false
      if (zombieOutside) s.sim.ai.spawnZombie(s.sim.town, 26.7, 68.4, "wander", Math.PI / 2)
      let peekedAt = -1
      let openedAt = -1
      run(s, 15, (cmd) => {
        if (cmd.interact && cmd.interactAction === "peek" && peekedAt < 0) peekedAt = s.sim.time
        if (door.open && openedAt < 0) openedAt = s.sim.time
      })
      return { peekedAt, openedAt }
    }
    const quiet = elm(false)
    expect(quiet.peekedAt).toBeGreaterThan(0)
    expect(quiet.openedAt).toBeGreaterThan(quiet.peekedAt)
    expect(quiet.openedAt - quiet.peekedAt).toBeLessThan(3)

    const watched = elm(true)
    expect(watched.peekedAt).toBeGreaterThan(0)
    // It saw the dead through the peephole and kept the door shut for a while.
    expect(watched.openedAt < 0 || watched.openedAt - watched.peekedAt > 4).toBe(true)
  })
})
