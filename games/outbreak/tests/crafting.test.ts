import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { LocalSession, type Command } from "../shared/session"
import { coachState, coachTips, craftRows, craftStation, learnHint, whereToFind } from "../src/crafting/model"
import { RECIPES } from "../shared/progression/catalog"

function setup() {
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const progression = session.sim.progression
  const ledger = progression.ledger
  const p = session.view.player
  const step = (cmd: Partial<Command> = {}, n = 1) => {
    for (let i = 0; i < n; i++) session.update(TICK_DT, { mx: 0, my: 0, aim: p.aim, interact: false, ...cmd }, 0)
  }
  const learn = (id: string) => ledger.apply({ kind: "grant", actor: "player", item: `learned:${id}`, store: "team/known" })
  const give = (item: string, count = 1) => expect(ledger.apply({ kind: "grant", actor: "player", item, count }).ok).toBe(true)
  return { session, progression, ledger, p, step, learn, give }
}

describe("crafting rows", () => {
  test("learned recipes come first in digit order with have/need; the rest are listed unlearned", () => {
    const { progression, learn, give } = setup()
    learn("spiked-board")
    learn("bandage")
    give("chem")
    const rows = craftRows(progression, "player", null)
    expect(rows.map((r) => [r.recipe.id, r.learned, r.index])).toEqual([
      ["bandage", true, 0],
      ["spiked-board", true, 1],
      ["lure", false, -1],
      ["battery", false, -1],
      ["tripwire", false, -1],
    ])
    expect(rows[0]).toMatchObject({ ok: true, cost: [{ item: "chem", need: 1, have: 1 }] })
    // The survivor starts with two planks and no scrap, and spiked boards are made at a workbench.
    expect(rows[1]).toMatchObject({ ok: false, blocked: "bench", cost: [{ item: "plank", need: 1, have: 2 }, { item: "scrap", need: 2, have: 0 }] })
    expect(rows[2]!.ok).toBe(false)
  })

  test("costs follow the Lab's cost multiplier, as the sim charges them", () => {
    const { progression, learn } = setup()
    learn("lure")
    progression.setTuning({ costScale: 2 })
    const lure = craftRows(progression, "player", null).find((r) => r.recipe.id === "lure")!
    expect(lure.cost.map((c) => [c.item, c.need])).toEqual([
      ["scrap", 2],
      ["battery", 2],
    ])
  })

  test("at the stash the bench's stock counts, as it does when the craft runs there", () => {
    const { session, progression, ledger, p, step, learn } = setup()
    learn("bandage")
    ledger.apply({ kind: "grant", actor: "player", item: "chem", count: 1, store: "bench:ash" })
    const bench = progression.benches.find((b) => b.id === "bench:ash")!
    Object.assign(p, { x: bench.stash.x + 0.8, y: bench.stash.y, aim: Math.PI })
    session.rebuildCollision()
    step()
    expect(session.view.prompt?.kind).toBe("stash")
    const station = craftStation(progression, session.view.prompt)
    expect(station).toBe("bench:ash")
    expect(craftRows(progression, "player", station)[0]!.ok).toBe(true)
    expect(craftRows(progression, "player", null)[0]!.ok).toBe(false)
    step({ pick: { mode: "craft", index: 0 } })
    step({}, Math.ceil(2 / TICK_DT) + 2)
    expect(ledger.count("player", "bandage")).toBe(1)
    expect(ledger.count("bench:ash", "chem")).toBe(0)
  })

  test("crafting short says what is missing in the belt's own words", () => {
    const { session, step, learn } = setup()
    learn("bandage")
    step({ pick: { mode: "craft", index: 0 } })
    step()
    expect(session.view.notices.map((n) => n.text)).toContain("Need chem")
  })

  test("every recipe still to find says what fills it in, and every material where it turns up", () => {
    const { progression, give, step } = setup()
    const hint = (id: string) => learnHint(progression, RECIPES.find((r) => r.id === id)!)
    for (const r of RECIPES.filter((r) => r.produces)) expect(learnHint(progression, r).length).toBeGreaterThan(4)
    expect(hint("bandage")).toBe("Pick up chem")
    expect(hint("battery")).toBe("Pick up scrap and chem")
    expect(hint("tripwire")).toContain("tripwire")
    give("scrap")
    give("chem")
    step()
    expect(hint("battery")).toBe("Wire in the generator")
    expect(whereToFind("chem")).toContain("pharmacies")
    for (const m of ["plank", "scrap", "chem", "battery"]) expect(whereToFind(m).split(", ").length).toBe(2)
  })
})

describe("crafting coach", () => {
  test("says nothing on the first look, then teaches the bench, a recipe filling in and one ready", () => {
    const { progression, learn, give } = setup()
    const look = (atBench = false) => coachState(progression, "player", atBench)
    let before = look()
    expect(coachTips(null, before)).toEqual([])
    let now = look(true)
    expect(coachTips(before, now)).toEqual([{ kind: "bench" }])
    before = now
    give("chem")
    learn("bandage")
    now = look(true)
    // Learned with a chem on the belt: the lesson, not "ready" as well.
    expect(coachTips(before, now)).toEqual([{ kind: "learned", recipe: "bandage", bench: false }])
    before = now
    learn("spiked-board")
    now = look(true)
    expect(coachTips(before, now)).toEqual([{ kind: "learned", recipe: "spiked-board", bench: true }])
    before = now
    progression.ledger.apply({ kind: "drain", store: "player/belt", item: "chem", count: 1 })
    now = look()
    expect(coachTips(before, now)).toEqual([])
    before = now
    give("chem")
    now = look()
    expect(coachTips(before, now)).toEqual([{ kind: "ready", recipe: "bandage" }])
  })

  test("a lesson with nothing to make (reinforced boards) earns no craft tip", () => {
    const { progression, learn } = setup()
    const before = coachState(progression, "player", false)
    learn("reinforced")
    expect(coachTips(before, coachState(progression, "player", false))).toEqual([])
  })
})
