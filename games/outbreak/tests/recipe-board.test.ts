import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim } from "../shared/coop-sim"
import { pinStoreId, readPin, recipeFillsIn, recipeWaitsOnPart } from "../shared/discovery/recipes"
import { RECIPES } from "../shared/progression"
import { LocalSession, type Command } from "../shared/session"

const CRAFT = (seconds: number) => Math.ceil(seconds / TICK_DT) + 2

function setup(hour = 12) {
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  session.sim.hour = hour
  const progression = session.sim.progression
  const ledger = progression.ledger
  const p = session.view.player
  const bench = progression.benches.find((b) => b.id === "bench:ash")!
  const step = (cmd: Partial<Command> = {}, n = 1) => {
    for (let i = 0; i < n; i++) session.update(TICK_DT, { mx: 0, my: 0, aim: p.aim, interact: false, ...cmd }, 0)
  }
  const give = (item: string, count = 1) => expect(ledger.apply({ kind: "grant", actor: "player", item, count }).ok).toBe(true)
  const install = (part: string) => expect(ledger.apply({ kind: "grant", actor: "player", item: part, store: bench.id }).ok).toBe(true)
  const notices = () => session.view.notices.splice(0).map((n) => n.text)
  const atBench = () => {
    Object.assign(p, { x: bench.bench.x - 0.85, y: bench.bench.y, aim: 0 })
    session.rebuildCollision()
    step()
  }
  const make = (recipe: string) => step({ pick: { mode: "craft", index: progression.craftable().findIndex((r) => r.id === recipe) } })
  return { session, progression, ledger, p, bench, step, give, install, notices, atBench, make }
}

describe("recipe board rules", () => {
  const recipe = (id: string) => RECIPES.find((r) => r.id === id)!
  const has = (...items: string[]) => (item: string) => items.includes(item)

  test("a recipe fills in once each of its materials has been picked up and its part installed", () => {
    expect(recipeFillsIn(recipe("bandage"), has("chem"), has())).toBe(true)
    expect(recipeFillsIn(recipe("lure"), has("scrap"), has())).toBe(false)
    expect(recipeFillsIn(recipe("lure"), has("scrap", "battery"), has())).toBe(true)
    expect(recipeFillsIn(recipe("reinforced"), has("scrap"), has())).toBe(false)
    expect(recipeWaitsOnPart(recipe("reinforced"), has("scrap"), has())).toBe(true)
    expect(recipeFillsIn(recipe("reinforced"), has("scrap"), has("toolbox"))).toBe(true)
    expect(recipeFillsIn(recipe("battery"), has("scrap", "chem"), has("toolbox"))).toBe(false)
    expect(recipeFillsIn(recipe("battery"), has("scrap", "chem"), has("car-battery"))).toBe(true)
    // The can tripwire is only learned by taking one down.
    expect(recipeFillsIn(recipe("tripwire"), has("scrap", "plank", "chem", "battery"), has("toolbox", "car-battery"))).toBe(false)
  })
})

describe("the recipe board in play", () => {
  test("picking up a material fills in what it feeds, with a brass pin and no notice", () => {
    const { progression, ledger, step, give, notices } = setup()
    step()
    // The survivor starts with planks, which make nothing on their own.
    expect(progression.board.corkboard()).toEqual({ learned: [], ideas: [] })
    give("chem")
    step()
    expect(progression.board.corkboard()).toEqual({ learned: ["bandage"], ideas: [] })
    give("scrap")
    step()
    // Scrap and chem are both in: reinforcing waits on the toolbox and batteries on the generator.
    expect(progression.board.corkboard()).toEqual({ learned: ["bandage", "spiked-board"], ideas: ["reinforced", "battery"] })
    expect(readPin(ledger.store(pinStoreId("spiked-board")), "spiked-board")).toMatchObject({ seat: null, source: "sketch" })
    expect(notices().filter((t) => /learn|recipe/i.test(t))).toEqual([])
  })

  test("installing the toolbox and the generator fills in what waits on them", () => {
    const { progression, step, give, install } = setup()
    give("scrap")
    give("chem")
    step()
    install("toolbox")
    step()
    expect(progression.learned("reinforced")).toBe(true)
    expect(progression.learned("battery")).toBe(false)
    install("car-battery")
    step()
    expect(progression.learned("battery")).toBe(true)
  })

  test("a page still teaches early and pins as the finder's", () => {
    const { session, progression, ledger, p, step } = setup()
    const page = progression.knowledge.pages.find((x) => x.buildingId === "pharmacy")!
    Object.assign(p, { x: page.x, y: page.y + 1, aim: -Math.PI / 2 })
    session.rebuildCollision()
    step({}, 2)
    step({ interact: true })
    step({}, 2)
    expect(progression.learned(page.recipe)).toBe(true)
    expect(readPin(ledger.store(pinStoreId(page.recipe)), page.recipe)).toMatchObject({ actor: "player", seat: 0, source: "chart" })
  })

  test("the bench's E opens its board: no tinkering, no materials used", () => {
    const { session, ledger, step, give, atBench } = setup()
    give("chem", 2)
    atBench()
    expect(session.view.prompt).toMatchObject({ kind: "bench", primary: { id: "board", label: "Recipes" } })
    step({ interact: true })
    step({}, 4)
    expect(ledger.count("player", "chem")).toBe(2)
    expect(session.view.player.channel).toBeNull()
  })

  test("carrying a part, E at the bench installs it", () => {
    const { session, ledger, bench, step, give, atBench } = setup()
    give("toolbox")
    atBench()
    expect(session.view.prompt?.primary.id).toBe("install")
    step({ interact: true })
    step({}, 2)
    expect(ledger.count(bench.id, "toolbox")).toBe(1)
  })
})

describe("making things", () => {
  test("a bandage is made anywhere", () => {
    const { progression, ledger, step, give, make } = setup()
    give("chem", 2)
    step()
    make("bandage")
    step({}, CRAFT(progression.tuning.craftTime))
    expect(ledger.count("player", "bandage")).toBe(1)
  })

  test("a spiked board is made only at a workbench, and only in light", () => {
    const { session, progression, ledger, p, step, give, notices, atBench, make } = setup(23)
    give("scrap", 2)
    step()
    expect(progression.learned("spiked-board")).toBe(true)
    notices()
    make("spiked-board")
    step()
    expect(notices()).toContain("At a workbench")
    p.flashlightOn = false
    atBench()
    make("spiked-board")
    step()
    expect(notices()).toContain("Too dark")
    session.sim.hour = 12
    make("spiked-board")
    step({}, CRAFT(progression.tuning.craftTime))
    expect(ledger.count("player", "spiked-board")).toBe(1)
  })

  test("a flashlight battery charges only at a bench with the generator wired in", () => {
    const { progression, ledger, step, give, install, notices, atBench, make } = setup()
    ledger.apply({ kind: "grant", actor: "player", item: "learned:battery", store: "team/known" })
    give("scrap")
    give("chem")
    atBench()
    notices()
    make("battery")
    step()
    expect(notices()).toContain("Needs the generator wired in")
    install("car-battery")
    make("battery")
    step({}, CRAFT(progression.tuning.craftTime))
    expect(ledger.count("player", "battery")).toBe(1)
  })
})

describe("the recipe board in co-op and across snapshots", () => {
  test("a restored fork fills in the same recipes on the same tick", () => {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    sim.hour = 12
    const slots = ["ann", "bob"].map((id, i) => sim.addSurvivor(id, i))
    const idle: Command = { mx: 0, my: 0, aim: 0, interact: false }
    const tick = (s: CoopSim) => {
      for (const slot of s.slots) s.stepSurvivor(slot, idle, TICK_DT)
      s.stepWorld(TICK_DT, 0)
    }
    tick(sim)
    const fork = CoopSim.fromSnapshot(JSON.parse(JSON.stringify(sim.toSnapshot())))
    for (const s of [sim, fork]) {
      s.progression.ledger.apply({ kind: "grant", actor: "bob", item: "scrap", count: 1 })
      s.progression.ledger.apply({ kind: "grant", actor: "ann", item: "battery", count: 1 })
      tick(s)
    }
    expect(sim.progression.learned("lure")).toBe(true)
    expect(slots).toHaveLength(2)
    expect(JSON.stringify(fork.progression.ledger.snapshot())).toBe(JSON.stringify(sim.progression.ledger.snapshot()))
  })
})
