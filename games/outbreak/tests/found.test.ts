import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import { heldOutWindow, looksReinforced, PAGE_BY_ARCHETYPE, pageSite, practiceFactor, PRACTICE_FULL } from "../shared/discovery/found"
import { pinStoreId, readPin } from "../shared/discovery/tinker"
import { DEFAULT_PROGRESSION_TUNING } from "../shared/progression"
import type { Command } from "../shared/session"

const T = DEFAULT_PROGRESSION_TUNING
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const BOARD = Math.ceil(T.barricadeTime / TICK_DT) + 2
const STUDY = Math.ceil(T.studyTime / TICK_DT) + 2

type Pose = { x: number; y: number; aim: number }

function room(poses: Record<string, Pose>, strapped = false) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
  if (strapped) {
    for (let i = 0; i < 2; i++) sim.ai.addBarricadePlank("hardware-south-east", T.reinforcedPlankHp)
    sim.ai.rebuildTopology(sim.town)
  }
  sim.hour = 12
  const slots: SurvivorSlot[] = Object.entries(poses).map(([id, pose], i) => {
    const slot = sim.addSurvivor(id, i)
    Object.assign(slot.survivor, pose)
    return slot
  })
  sim.rebuildSolids()
  const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}, n = 1) => {
    for (let k = 0; k < n; k++) {
      for (const s of sim.slots) sim.stepSurvivor(s, { ...idle(s.survivor.aim), ...cmds[s.id] }, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
    }
  }
  const slot = (id: string) => sim.slot(id)!
  return { sim, slots, tick, slot, ledger: sim.progression.ledger, progression: sim.progression }
}

/** In front of a page's shelf, facing it. */
const beforePage = (sim: CoopSim, building: string): Pose => {
  const page = sim.progression.pages.find((p) => p.buildingId === building)!
  return { x: page.x, y: page.y + 1, aim: -Math.PI / 2 }
}

/** Inside the hardware store, a step back from its boarded south-east window and facing it. */
const STUDY_SPOT: Pose = { x: 70.25, y: 36.4, aim: Math.PI / 2 }

/** Inside Ash by its east window, and a teammate further back in the same room. */
const ASH_WINDOW: Pose = { x: 36.2, y: 28.8, aim: 0 }

describe("pages left in buildings", () => {
  test("each kind of building holds the same page in the same place, every time; houses hold none", () => {
    const a = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    const b = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    expect(a.progression.pages).toEqual(b.progression.pages)
    expect(a.progression.pages.map((p) => [p.buildingId, p.recipe, p.style])).toEqual([
      ["hardware", "reinforced", "flyer"],
      ["pharmacy", "bandage", "chart"],
    ])
    for (const house of a.town.buildings.filter((x) => x.kind === "house")) expect(pageSite(a.town, house)).toBeNull()
    for (const p of a.progression.pages) {
      const building = a.town.buildings.find((x) => x.id === p.buildingId)!
      expect(PAGE_BY_ARCHETYPE[building.archetype ?? building.kind]).toBe(p.recipe)
      expect(a.progression.ledger.count(p.id, "page")).toBe(1)
    }
  })

  test("E reads a page: the squad knows the recipe and the page itself goes up on the board, without a word", () => {
    const { sim, tick, slot, ledger, progression } = room({ ann: { x: 0, y: 0, aim: 0 } })
    Object.assign(slot("ann").survivor, beforePage(sim, "hardware"))
    sim.rebuildSolids()
    tick()
    expect(slot("ann").prompt?.kind).toBe("page")
    expect(slot("ann").prompt?.primary.id).toBe("read")
    const notices = slot("ann").notices.length
    tick({ ann: { interact: true } })
    expect(progression.learned("reinforced")).toBe(true)
    expect(ledger.count("page:hardware", "page")).toBe(0)
    expect(readPin(ledger.store(pinStoreId("reinforced")), "reinforced")).toMatchObject({ actor: "ann", seat: 0, source: "flyer" })
    expect(slot("ann").notices.length).toBe(notices)
    tick()
    expect(slot("ann").prompt?.kind).not.toBe("page")
  })

  test("a page for something the squad already made is read and gone, and their own sketch stays pinned", () => {
    const { sim, tick, slot, ledger } = room({ ann: { x: 0, y: 0, aim: 0 } })
    ledger.apply({ kind: "grant", actor: "ann", item: "learned:bandage", store: "team/known" })
    ledger.createStore({ id: pinStoreId("bandage"), mode: "counters", scope: "shared", owner: "ann", at: { x: 0, y: 0 }, initial: { seat: 1 } })
    Object.assign(slot("ann").survivor, beforePage(sim, "pharmacy"))
    sim.rebuildSolids()
    tick()
    tick({ ann: { interact: true } })
    expect(ledger.count("page:pharmacy", "page")).toBe(0)
    expect(readPin(ledger.store(pinStoreId("bandage")), "bandage")?.source).toBe("sketch")
  })

  test("a read page survives a snapshot", () => {
    const { sim, tick, slot } = room({ ann: { x: 0, y: 0, aim: 0 } })
    Object.assign(slot("ann").survivor, beforePage(sim, "pharmacy"))
    sim.rebuildSolids()
    tick()
    tick({ ann: { interact: true } })
    const fork = CoopSim.fromSnapshot(JSON.parse(JSON.stringify(sim.toSnapshot())))
    expect(fork.progression.pages).toEqual(sim.progression.pages)
    expect(fork.progression.ledger.count("page:pharmacy", "page")).toBe(0)
    expect(fork.progression.ledger.count("page:hardware", "page")).toBe(1)
    expect(readPin(fork.progression.ledger.store(pinStoreId("bandage")), "bandage")?.source).toBe("chart")
  })
})

describe("practice", () => {
  test("the curve: each board nailed takes a little off the time and the noise, down to the floor", () => {
    expect(practiceFactor(0, 0.6)).toBe(1)
    expect(practiceFactor(PRACTICE_FULL / 2, 0.6)).toBeCloseTo(0.8)
    expect(practiceFactor(PRACTICE_FULL, 0.6)).toBeCloseTo(0.6)
    expect(practiceFactor(PRACTICE_FULL * 3, 0.6)).toBeCloseTo(0.6)
  })

  test("boarding up gets faster and quieter with each board, with nothing on screen to say so", () => {
    const { tick, slot, ledger, progression, sim } = room({ ann: ASH_WINDOW })
    ledger.apply({ kind: "grant", actor: "ann", item: "plank", count: 4 })
    const board = () => {
      const before = sim.ai.noiseBus.events.length
      tick({ ann: { barricade: true } })
      const duration = slot("ann").survivor.channel?.duration ?? 0
      const noise = sim.ai.noiseBus.events.slice(before).find((e) => e.kind === "barricade")?.radius ?? 0
      tick({}, BOARD)
      return { duration, noise }
    }
    const first = board()
    const second = board()
    const third = board()
    expect(first.duration).toBeCloseTo(T.barricadeTime)
    expect(first.noise).toBeCloseTo(T.barricadeNoise)
    expect(second.duration).toBeCloseTo(T.barricadeTime * practiceFactor(1, T.practiceTimeFloor))
    expect(third.noise).toBeCloseTo(T.barricadeNoise * practiceFactor(2, T.practiceNoiseFloor))
    expect(third.duration).toBeLessThan(second.duration)
    expect(progression.practice("ann", "barricade")).toBe(3)
    expect(sim.ai.getBarricadePlanks("ash-east")).toBe(3)
  })

  test("practice survives a snapshot, and a restored fork boards the next window just as fast", () => {
    const { tick, slot, ledger, sim } = room({ ann: ASH_WINDOW })
    ledger.apply({ kind: "grant", actor: "ann", item: "plank", count: 4 })
    for (let i = 0; i < 3; i++) {
      tick({ ann: { barricade: true } })
      tick({}, BOARD)
    }
    const fork = CoopSim.fromSnapshot(JSON.parse(JSON.stringify(sim.toSnapshot())))
    expect(fork.progression.mastery).toEqual(sim.progression.mastery)
    // To the south-east window, and board it in both.
    for (const s of [sim, fork]) {
      Object.assign(s.slot("ann")!.survivor, { x: 34.2, y: 34.6, aim: Math.PI / 2 })
      s.rebuildSolids()
      s.stepSurvivor(s.slot("ann")!, { ...idle(Math.PI / 2), barricade: true }, TICK_DT)
      s.stepWorld(TICK_DT, 0)
    }
    const d = slot("ann").survivor.channel?.duration
    expect(d).toBeCloseTo(T.barricadeTime * practiceFactor(3, T.practiceTimeFloor))
    expect(fork.slot("ann")!.survivor.channel?.duration).toBe(d!)
  })

  test("watching a teammate board up teaches a little; through a wall it teaches nothing", () => {
    const { tick, ledger, progression } = room({
      ann: ASH_WINDOW,
      bob: { x: 32.6, y: 28.8, aim: 0 },
      // Outside Ash's east wall, close but with brick in the way.
      cal: { x: 38.5, y: 25.5, aim: Math.atan2(28.8 - 25.5, 36.2 - 38.5) },
      // In the room, near enough, but looking the other way.
      dee: { x: 33.4, y: 30.4, aim: Math.PI },
    })
    ledger.apply({ kind: "grant", actor: "ann", item: "plank", count: 2 })
    for (let i = 0; i < 2; i++) {
      tick({ ann: { barricade: true } })
      tick({}, BOARD)
    }
    expect(progression.practice("ann", "barricade")).toBe(2)
    expect(progression.practice("bob", "barricade")).toBeCloseTo(2 * T.watchShare)
    expect(progression.practice("cal", "barricade")).toBe(0)
    expect(progression.practice("dee", "barricade")).toBe(0)
  })
})

describe("learning by looking", () => {
  test("a warehouse was held out from inside: its south window boarded and reinforced once, before anyone arrives", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    // The classic town's hardware store is left as it was; dressed as a streamed warehouse, it is held out.
    expect(sim.ai.getBarricadePlanks("hardware-south-east")).toBe(0)
    expect(sim.progression.heldOut).toEqual([])
    const hardware = sim.town.buildings.find((b) => b.id === "hardware")!
    expect(heldOutWindow(sim.town, hardware)).toBeNull()
    hardware.archetype = "warehouse"
    expect(heldOutWindow(sim.town, hardware)).toBe("hardware-south-east")
    expect(sim.progression.boardHeldOut(sim.town, sim.ai)).toBe(true)
    expect(sim.progression.boardHeldOut(sim.town, sim.ai)).toBe(false)
    const st = sim.ai.portalStates.get("hardware-south-east")!
    expect(st.barricadePlanks).toBe(2)
    expect(looksReinforced(st.barricadePlanks, st.barricadeHp)).toBe(true)
    expect(sim.progression.heldOut).toEqual(["hardware"])
  })

  test("standing still and looking closely at a reinforced barricade teaches how it was done", () => {
    const { tick, ledger, progression } = room({ ann: STUDY_SPOT }, true)
    tick({}, Math.floor(STUDY / 2))
    expect(progression.learned("reinforced")).toBe(false)
    expect(progression.study.ann?.portal).toBe("hardware-south-east")
    tick({}, STUDY)
    expect(progression.learned("reinforced")).toBe(true)
    expect(readPin(ledger.store(pinStoreId("reinforced")), "reinforced")).toMatchObject({ actor: "ann", seat: 0, source: "sketch" })
    expect(progression.study).toEqual({})
  })

  test("walking past it or looking away teaches nothing", () => {
    const pace = room({ ann: STUDY_SPOT }, true)
    for (let i = 0; i < STUDY * 2; i++) pace.tick({ ann: { mx: i % 60 < 30 ? 1 : -1, aim: STUDY_SPOT.aim } })
    expect(pace.progression.learned("reinforced")).toBe(false)
    const away = room({ ann: { ...STUDY_SPOT, aim: -Math.PI / 2 } }, true)
    away.tick({}, STUDY * 2)
    expect(away.progression.learned("reinforced")).toBe(false)
  })

  test("a study cut short by a snapshot finishes the same way in the restored fork", () => {
    const { sim, tick } = room({ ann: STUDY_SPOT }, true)
    tick({}, Math.floor(STUDY / 2))
    const fork = CoopSim.fromSnapshot(JSON.parse(JSON.stringify(sim.toSnapshot())))
    expect(fork.progression.study).toEqual(sim.progression.study)
    for (let i = 0; i < STUDY; i++) {
      tick()
      for (const s of fork.slots) fork.stepSurvivor(s, idle(s.survivor.aim), TICK_DT)
      fork.stepWorld(TICK_DT, 0)
    }
    expect(fork.progression.learned("reinforced")).toBe(true)
    expect(JSON.stringify(fork.progression.ledger.snapshot())).toBe(JSON.stringify(sim.progression.ledger.snapshot()))
  })
})
