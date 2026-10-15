import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { CoopSim, type SurvivorSlot } from "../shared/coop-sim"
import { ALL_PAIRS, judgeMat, matStoreId, nextPair, pairKey, pinStoreId, readPin } from "../shared/discovery/tinker"
import { DEFAULT_PROGRESSION_TUNING, RECIPES } from "../shared/progression"
import { LocalSession, type Command } from "../shared/session"

const T = DEFAULT_PROGRESSION_TUNING
const MAT = matStoreId("bench:ash")
const HOLD = Math.ceil(0.4 / TICK_DT)
const TRY = Math.ceil(T.researchTime / TICK_DT) + 2

function setup(hour = 12) {
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const progression = session.sim.progression
  const ledger = progression.ledger
  const p = session.view.player
  const bench = progression.benches.find((b) => b.id === "bench:ash")!
  const step = (cmd: Partial<Command> = {}, n = 1) => {
    for (let i = 0; i < n; i++) session.update(TICK_DT, { mx: 0, my: 0, aim: p.aim, interact: false, ...cmd }, 0)
  }
  const give = (item: string, count = 1) => expect(ledger.apply({ kind: "grant", actor: "player", item, count }).ok).toBe(true)
  const notices = () => session.view.notices.splice(0).map((n) => n.text)
  const mat = () => progression.mat("bench:ash").map((s) => s.item)
  const tap = () => step({ interact: true })
  /** Holds E long enough to start a try, then lets go and waits for it to finish. */
  const tinker = () => {
    step({ interact: true, interactHeld: true })
    step({ interactHeld: true }, HOLD)
    step({}, TRY)
  }
  session.sim.hour = hour
  Object.assign(p, { x: bench.bench.x - 0.85, y: bench.bench.y, aim: 0 })
  session.rebuildCollision()
  step()
  return { session, progression, ledger, p, bench, step, give, notices, mat, tap, tinker }
}

describe("tinker rules", () => {
  test("pairs are unordered, cover every double, and the right pairs make each recipe", () => {
    expect(ALL_PAIRS).toHaveLength(10)
    expect(pairKey("scrap", "plank")).toBe("plank+scrap")
    const known = () => false
    expect(judgeMat(RECIPES, ["scrap", "plank"], 1, known)).toEqual({ kind: "assemble", recipe: "spiked-board", pair: "plank+scrap" })
    expect(judgeMat(RECIPES, ["chem", "chem"], 1, known)).toMatchObject({ kind: "assemble", recipe: "bandage" })
    expect(judgeMat(RECIPES, ["scrap", "scrap"], 1, known)).toMatchObject({ kind: "almost", recipe: "reinforced" })
    expect(judgeMat(RECIPES, ["scrap", "scrap"], 2, known)).toMatchObject({ kind: "assemble", recipe: "reinforced" })
    expect(judgeMat(RECIPES, ["scrap", "scrap"], 2, () => true)).toEqual({ kind: "clatter", pair: "scrap+scrap", record: false })
    expect(judgeMat(RECIPES, ["plank", "plank"], 2, known)).toEqual({ kind: "clatter", pair: "plank+plank", record: true })
    expect(judgeMat(RECIPES, ["plank"], 1, known)).toBeNull()
    // Every pair the cycle offers can be paid for: with one chem and one scrap there is only chem+scrap.
    const have = (m: string) => (m === "chem" || m === "scrap" ? 1 : 0)
    expect(ALL_PAIRS[nextPair(-1, have)]).toEqual(["scrap", "chem"])
    expect(nextPair(nextPair(-1, have), have)).toBe(-1)
  })
})

describe("the bench mat", () => {
  test("E lays out each pair the survivor can make up in turn, then clears the mat and gives everything back", () => {
    const { ledger, mat, tap, give, session } = setup()
    give("scrap", 1)
    // Starting kit: 2 planks. Pairs: plank+plank, plank+scrap, then the mat clears.
    expect(session.view.prompt?.kind).toBe("bench")
    expect(session.view.prompt?.primary.id).toBe("place")
    tap()
    expect(mat()).toEqual(["plank", "plank"])
    expect(ledger.count("player/belt", "plank")).toBe(0)
    tap()
    expect(mat().sort()).toEqual(["plank", "scrap"])
    expect(ledger.count("player/belt", "plank")).toBe(1)
    tap()
    expect(mat()).toEqual([])
    expect(ledger.count("player/belt", "plank")).toBe(2)
    expect(ledger.count("player/belt", "scrap")).toBe(1)
  })

  test("a pair that makes something assembles on the mat, teaches the squad and pins the maker's sketch", () => {
    const { ledger, progression, mat, tap, tinker, give, notices, session } = setup()
    give("scrap", 1)
    tap()
    tap()
    expect(mat().sort()).toEqual(["plank", "scrap"])
    expect(session.view.prompt?.secondary?.id).toBe("tinker")
    tinker()
    expect(progression.learned("spiked-board")).toBe(true)
    expect(mat()).toEqual(["spiked-board"])
    expect(ledger.count("player", "scrap")).toBe(0)
    expect(readPin(ledger.store(pinStoreId("spiked-board")), "spiked-board")).toMatchObject({ actor: "player", seat: 0 })
    expect(progression.corkboard().learned).toEqual(["spiked-board"])
    // No words: the sketch on the corkboard and the board on the mat are the news.
    expect(notices().filter((t) => /learned|research|recipe/i.test(t))).toEqual([])
    expect(session.view.prompt?.primary.id).toBe("take")
    tap()
    expect(ledger.count("player", "spiked-board")).toBe(1)
    expect(mat()).toEqual([])
  })

  test("a pair that makes nothing clatters loud enough to hear, costs nothing, and is crossed out once", () => {
    const { ledger, progression, mat, tap, tinker, session } = setup()
    tap()
    expect(mat()).toEqual(["plank", "plank"])
    tinker()
    expect(mat()).toEqual(["plank", "plank"])
    expect(session.view.noises.some((n) => n.kind === "clatter" && n.radius === T.clatterNoise)).toBe(true)
    expect(progression.corkboard().tried).toEqual(["plank+plank"])
    const rev = ledger.store("team/known")!.rev
    tinker()
    expect(ledger.store("team/known")!.rev).toBe(rev)
  })

  test("a tier-2 pair at a bare bench pins a faint idea; with the toolbox installed it assembles", () => {
    const { ledger, progression, mat, tap, tinker, give, step, session } = setup()
    give("scrap", 2)
    while (mat().join("+") !== "scrap+scrap") tap()
    tinker()
    expect(progression.corkboard().ideas).toEqual(["reinforced"])
    expect(progression.learned("reinforced")).toBe(false)
    expect(mat()).toEqual(["scrap", "scrap"])
    give("toolbox")
    step()
    expect(session.view.prompt?.primary.id).toBe("install")
    tap()
    expect(progression.tier("bench:ash")).toBe(2)
    expect(ledger.count("player/belt", "plank")).toBe(2)
    tinker()
    expect(progression.learned("reinforced")).toBe(true)
    expect(progression.corkboard().ideas).toEqual([])
    expect(mat()).toEqual([])
  })

  test("too dark: the try is refused; a flashlight on the mat is enough", () => {
    const { progression, mat, tap, tinker, give, notices, p } = setup(23)
    give("chem", 2)
    while (mat().join("+") !== "chem+chem") tap()
    p.flashlightOn = false
    p.flashlightOutput = 0
    tinker()
    expect(notices()).toContain("Too dark")
    expect(progression.learned("bandage")).toBe(false)
    p.flashlightOn = true
    p.flashlightOutput = 1
    tinker()
    expect(progression.learned("bandage")).toBe(true)
  })

  test("holding E tinkers without the tap swapping the pair first", () => {
    const { mat, tap, give, step, session } = setup()
    give("chem", 2)
    while (mat().join("+") !== "chem+chem") tap()
    step({ interact: true, interactHeld: true })
    expect(mat()).toEqual(["chem", "chem"])
    step({ interactHeld: true }, HOLD)
    expect(session.view.player.channel?.kind).toBe("tinker")
    expect(mat()).toEqual(["chem", "chem"])
  })
})

describe("tinkering in co-op and across snapshots", () => {
  const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })

  function room() {
    const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0 })
    sim.hour = 12
    const bench = sim.progression.benches.find((b) => b.id === "bench:ash")!
    const slots = ["ann", "bob"].map((id, i) => {
      const slot = sim.addSurvivor(id, i)
      Object.assign(slot.survivor, { x: bench.bench.x - 0.85, y: bench.bench.y + (i ? 0.45 : -0.45), aim: 0 })
      return slot
    })
    sim.rebuildSolids()
    const tick = (cmds: Partial<Record<string, Partial<Command>>> = {}) => {
      for (const s of slots) sim.stepSurvivor(s, { ...idle(), ...cmds[s.id] }, TICK_DT)
      sim.stepWorld(TICK_DT, 0)
    }
    return { sim, slots, tick }
  }

  const hold = (tick: (c: Partial<Record<string, Partial<Command>>>) => void, who: SurvivorSlot[]) => {
    tick(Object.fromEntries(who.map((s) => [s.id, { interact: true, interactHeld: true }])))
    for (let i = 0; i < HOLD; i++) tick(Object.fromEntries(who.map((s) => [s.id, { interactHeld: true }])))
    for (let i = 0; i < TRY; i++) tick({})
  }

  test("the pin names whoever made it: Bob lays out and tries the pair while Ann watches", () => {
    const { sim, slots, tick } = room()
    const [, bob] = slots
    sim.progression.ledger.apply({ kind: "grant", actor: "bob", item: "scrap", count: 1 })
    sim.progression.ledger.apply({ kind: "grant", actor: "bob", item: "battery", count: 1 })
    const lure = ALL_PAIRS.findIndex(([a, b]) => pairKey(a, b) === "scrap+battery")
    tick({ bob: { pick: { mode: "bench", index: lure } } })
    expect(sim.progression.mat("bench:ash").map((s) => s.item).sort()).toEqual(["battery", "scrap"])
    hold(tick, [bob!])
    expect(sim.progression.learned("lure")).toBe(true)
    expect(readPin(sim.progression.ledger.store(pinStoreId("lure")), "lure")).toMatchObject({ actor: "bob", seat: 1 })
  })

  test("both holding E on one pair at once: it assembles once and costs the pair once", () => {
    const { sim, slots, tick } = room()
    const ledger = sim.progression.ledger
    ledger.apply({ kind: "grant", actor: "ann", item: "chem", count: 2 })
    const bandage = ALL_PAIRS.findIndex(([a, b]) => pairKey(a, b) === "chem+chem")
    tick({ ann: { pick: { mode: "bench", index: bandage } } })
    hold(tick, slots)
    expect(sim.progression.learned("bandage")).toBe(true)
    expect(ledger.count(MAT, "bandage")).toBe(1)
    expect(ledger.count("team/known", "learned:bandage")).toBe(1)
    expect(readPin(ledger.store(pinStoreId("bandage")), "bandage")?.actor).toBe("ann")
  })

  test("the mat, sketches, ideas and tries survive a snapshot, and a restored fork keeps step", () => {
    const { sim, slots, tick } = room()
    const ledger = sim.progression.ledger
    ledger.apply({ kind: "grant", actor: "ann", item: "scrap", count: 3 })
    ledger.apply({ kind: "grant", actor: "ann", item: "plank", count: 2 })
    const pair = (key: string) => ALL_PAIRS.findIndex(([a, b]) => pairKey(a, b) === key)
    tick({ ann: { pick: { mode: "bench", index: pair("plank+scrap") } } })
    hold(tick, [slots[0]!])
    tick({ ann: { interact: true } })
    tick({ ann: { pick: { mode: "bench", index: pair("scrap+scrap") } } })
    hold(tick, [slots[0]!])
    tick({ ann: { pick: { mode: "bench", index: pair("plank+plank") } } })
    expect(sim.progression.corkboard()).toEqual({ learned: ["spiked-board"], ideas: ["reinforced"], tried: [] })
    // Mid-try: the fork must finish the same try the same way.
    tick({ ann: { interact: true, interactHeld: true } })
    for (let i = 0; i < HOLD + 10; i++) tick({ ann: { interactHeld: true } })
    const fork = CoopSim.fromSnapshot(JSON.parse(JSON.stringify(sim.toSnapshot())))
    const forkTick = () => {
      for (const s of fork.slots) fork.stepSurvivor(s, idle(), TICK_DT)
      fork.stepWorld(TICK_DT, 0)
    }
    for (let i = 0; i < TRY; i++) {
      tick({})
      forkTick()
    }
    expect(sim.progression.corkboard().tried).toEqual(["plank+plank"])
    expect(JSON.stringify(fork.progression.ledger.snapshot())).toBe(JSON.stringify(ledger.snapshot()))
    expect(fork.progression.corkboard()).toEqual(sim.progression.corkboard())
    expect(readPin(fork.progression.ledger.store(pinStoreId("spiked-board")), "spiked-board")).toMatchObject({ actor: "ann", seat: 0 })
  })

  test("two rooms fed the same commands learn the same things in the same order", () => {
    const run = () => {
      const { sim, slots, tick } = room()
      sim.progression.ledger.apply({ kind: "grant", actor: "ann", item: "chem", count: 3 })
      sim.progression.ledger.apply({ kind: "grant", actor: "bob", item: "scrap", count: 2 })
      for (let k = 0; k < 6; k++) {
        const who = slots[k % 2]!
        tick({ [who.id]: { interact: true } })
        hold(tick, [who])
      }
      return JSON.stringify(sim.progression.ledger.snapshot())
    }
    expect(run()).toBe(run())
  })
})
