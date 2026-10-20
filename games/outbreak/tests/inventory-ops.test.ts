import { describe, expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import { packInventoryOp, unpackInventoryOp, type InventoryOp } from "../shared/inventory-ops/ops"
import { packCommand, unpackCommand, encodeClientIn, decodeClient } from "../shared/net-protocol"
import type { Command } from "../shared/session"

const DT = 1 / 60

function scene(players = 1) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 }, undefined, "classic")
  const slots = Array.from({ length: players }, (_, i) => {
    const slot = sim.addSurvivor(i === 0 ? "player" : `mate${i}`, i)
    Object.assign(slot.survivor, { x: 27.6 + i * 1.2, y: 27.2, aim: 0 })
    return slot
  })
  return { sim, slots }
}

const idle = (extra: Partial<Command> = {}): Command => ({ mx: 0, my: 0, aim: 0, interact: false, ...extra })

function step(sim: CoopSim, slot: ReturnType<CoopSim["addSurvivor"]>, inv: InventoryOp) {
  sim.stepSurvivor(slot, idle({ inv }), DT)
}

/** Every cell of `actor`'s case taken by scrap. */
function fillCase(sim: CoopSim, actor: string) {
  const l = sim.progression.ledger
  while (l.room(actor, "scrap", 1) > 0) l.apply({ kind: "grant", actor, item: "scrap", count: 1 })
}

const caseCells = (sim: CoopSim, actor: string) => {
  const l = sim.progression.ledger
  const st = l.store(`${actor}/pack`)!
  const occ = l.occupancy(st)
  const rows: string[] = []
  for (let y = 0; y < st.grid!.rows; y++)
    rows.push(occ.slice(y * st.grid!.cols, (y + 1) * st.grid!.cols).map((i) => (i < 0 ? "." : st.slots[i]!.item === "plank" ? "p" : st.slots[i]!.item === "ammo" ? "a" : (st.slots[i]!.item[0] ?? "?"))).join(""))
  return rows
}

describe("inventory moves (AR-94, the Attaché Case)", () => {
  test("pack and unpack every end, cell, turn and count", () => {
    const ops: InventoryOp[] = [
      { from: { at: "hotbar", slot: 0 }, to: { at: "pack", slot: 3 } },
      { from: { at: "target", slot: 7 }, to: { at: "hotbar", slot: 4 }, count: 1 },
      { from: { at: "pack", slot: 53 }, to: { at: "mate", slot: 5 }, count: 12 },
      { from: { at: "pack", slot: 31 }, to: { at: "ground", slot: 0 }, count: 255 },
      { from: { at: "target", slot: 2 }, to: { at: "case", slot: 53, r: true }, count: 7 },
      { from: { at: "pack", slot: 127 }, to: { at: "case", slot: 127, r: true }, count: 255 },
    ]
    for (const op of ops) expect(unpackInventoryOp(packInventoryOp(op))).toEqual(op)
    expect(unpackInventoryOp(0)).toBeNull()
    expect(unpackInventoryOp(-3)).toBeNull()
    expect(unpackInventoryOp("x")).toBeNull()
    expect(unpackInventoryOp(2 ** 31)).toBeNull()
  })

  test("a command with a move survives the tuple and the binary wire", () => {
    const inv: InventoryOp = { from: { at: "pack", slot: 9 }, to: { at: "case", slot: 40, r: true }, count: 6 }
    const cmd = idle({ inv })
    expect(unpackCommand(packCommand(cmd)).inv).toEqual(inv)
    const msg = decodeClient(encodeClientIn(1, [packCommand(cmd), packCommand(idle())]))
    expect(msg?.t).toBe("in")
    const tuples = msg && msg.t === "in" ? msg.c : []
    expect(unpackCommand(tuples[0]).inv).toEqual(inv)
    expect(unpackCommand(tuples[1]).inv).toBeUndefined()
    // A pick and a move in one command keep both.
    const both = idle({ pick: { mode: "take", index: 2 }, inv })
    const back = decodeClient(encodeClientIn(1, [packCommand(both)]))
    const c = back && back.t === "in" ? unpackCommand(back.c[0]) : null
    expect(c?.pick).toEqual({ mode: "take", index: 2 })
    expect(c?.inv).toEqual(inv)
  })

  test("everyone starts with a 6×3 school backpack holding their rounds and planks", () => {
    const { sim } = scene()
    expect(sim.progression.bagOf("player").bag.id).toBe("school-bag")
    expect(caseCells(sim, "player")).toEqual(["apppp.", "......", "......"])
  })

  test("moves and turns within the case, swaps with the hands, and refuses what doesn't fit", () => {
    const { sim, slots } = scene()
    const me = slots[0]!
    const l = sim.progression.ledger
    const pack = l.store("player/pack")!
    const planks = pack.slots.findIndex((s) => s?.item === "plank")
    // Planks (4×1) turned stand 1×4: too tall for three rows.
    me.notices.length = 0
    step(sim, me, { from: { at: "pack", slot: planks }, to: { at: "case", slot: 5, r: true } })
    expect(me.notices.some((n) => /doesn't fit/.test(n.text))).toBe(true)
    step(sim, me, { from: { at: "pack", slot: planks }, to: { at: "case", slot: 2 * 6 + 2 } })
    expect(caseCells(sim, "player")).toEqual(["a.....", "......", "..pppp"])
    // The pistol into the case (2×2) and back to a hand.
    const pistolHand = l.store("player/hotbar")!.slots.findIndex((s) => s?.item === "pistol")
    step(sim, me, { from: { at: "hotbar", slot: pistolHand }, to: { at: "case", slot: 4 } })
    expect(caseCells(sim, "player")).toEqual(["a...pp", "....pp", "..pppp"])
    const pistolSlot = pack.slots.findIndex((s) => s?.item === "pistol")
    step(sim, me, { from: { at: "pack", slot: pistolSlot }, to: { at: "hotbar", slot: 1 } })
    expect(l.store("player/hotbar")!.slots[1]?.item).toBe("pistol")
    // A part never goes in a hand.
    l.apply({ kind: "grant", actor: "player", item: "toolbox", count: 1 })
    const toolboxAt = pack.slots.findIndex((s) => s?.item === "toolbox")
    me.notices.length = 0
    step(sim, me, { from: { at: "pack", slot: toolboxAt }, to: { at: "hotbar", slot: 4 } })
    expect(pack.slots[toolboxAt]?.item).toBe("toolbox")
    expect(me.notices.some((n) => /case/i.test(n.text))).toBe(true)
  })

  test("drops part of a stack on the ground and hands a stack to a teammate in reach", () => {
    const { sim, slots } = scene(2)
    const [me, mate] = slots as [ReturnType<CoopSim["addSurvivor"]>, ReturnType<CoopSim["addSurvivor"]>]
    const l = sim.progression.ledger
    l.apply({ kind: "grant", actor: "player", item: "ammo", count: 4 })
    const ammoAt = () => l.store("player/pack")!.slots.findIndex((s) => s?.item === "ammo")
    const ammoBefore = l.count("player", "ammo")
    const mateBefore = l.count("mate1", "ammo")
    step(sim, me, { from: { at: "pack", slot: ammoAt() }, to: { at: "ground", slot: 0 }, count: 4 })
    expect(l.count("player", "ammo")).toBe(ammoBefore - 4)
    const drops = [...l.stores.values()].filter((s) => s.id.startsWith("drop:"))
    expect(drops.some((d) => (d.slots.find((s) => s?.item === "ammo")?.count ?? 0) === 4)).toBe(true)

    step(sim, me, { from: { at: "pack", slot: ammoAt() }, to: { at: "mate", slot: mate.index }, count: 3 })
    expect(l.count("player", "ammo")).toBe(ammoBefore - 7)
    expect(l.count("mate1", "ammo")).toBe(mateBefore + 3)
    expect(mate.notices.some((n) => /gave you/.test(n.text))).toBe(true)

    // Out of reach: nothing moves and the giver is told why.
    mate.survivor.x += 10
    me.notices.length = 0
    step(sim, me, { from: { at: "pack", slot: ammoAt() }, to: { at: "mate", slot: mate.index }, count: 1 })
    expect(l.count("player", "ammo")).toBe(ammoBefore - 7)
    expect(me.notices.some((n) => /closer/i.test(n.text))).toBe(true)
  })

  test("a teammate with a full case finds the gift at their feet", () => {
    const { sim, slots } = scene(2)
    const [me, mate] = slots as [ReturnType<CoopSim["addSurvivor"]>, ReturnType<CoopSim["addSurvivor"]>]
    const l = sim.progression.ledger
    fillCase(sim, "mate1")
    l.apply({ kind: "grant", actor: "player", item: "toolbox", count: 1 })
    const at = l.store("player/pack")!.slots.findIndex((s) => s?.item === "toolbox")
    step(sim, me, { from: { at: "pack", slot: at }, to: { at: "mate", slot: mate.index } })
    expect(l.count("player", "toolbox")).toBe(0)
    expect(l.count("mate1", "toolbox")).toBe(0)
    const drop = [...l.stores.values()].find((s) => s.id.startsWith("drop:") && s.slots.some((x) => x?.item === "toolbox"))
    expect(drop?.at).toEqual({ x: mate.survivor.x, y: mate.survivor.y })
    expect(me.notices.some((n) => /feet/.test(n.text))).toBe(true)
  })

  test("takes from what you face straight onto a cell, and a bag found is worn: the case grows", () => {
    const { sim, slots } = scene()
    const me = slots[0]!
    const l = sim.progression.ledger
    const box = l.createStore({ id: "drop:900", mode: "slots", scope: "shared", size: 3, at: { x: 27.9, y: 27.2 }, initial: [{ item: "machete", count: 1 }, { item: "hiking-pack", count: 1 }] })
    me.prompt = { kind: "drop", id: box.id } as typeof me.prompt
    step(sim, me, { from: { at: "target", slot: 0 }, to: { at: "case", slot: 2 * 6 + 2 } })
    expect(caseCells(sim, "player")).toEqual(["apppp.", "......", "..mmmm"])
    step(sim, me, { from: { at: "target", slot: 0 }, to: { at: "case", slot: 0 } })
    expect(l.count("player/worn", "hiking-pack")).toBe(1)
    const pack = l.store("player/pack")!
    expect(pack.grid).toEqual({ cols: 7, rows: 4 })
    // Everything keeps its place; the new column and row are free.
    expect(caseCells(sim, "player")).toEqual(["apppp..", ".......", "..mmmm.", "......."])
  })

  test("co-op: a client mirror built from the room's ledger deltas lays the case out cell for cell", () => {
    const { sim, slots } = scene()
    const me = slots[0]!
    const client = new CoopSim(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 }, undefined, "classic")
    client.addSurvivor("player", 0)
    const l = sim.progression.ledger
    const sync = () => client.progression.ledger.applyDelta(l.diff(0, { visibleTo: "player" })!)
    l.apply({ kind: "grant", actor: "player", item: "hiking-pack", count: 1 })
    sim.progression.project(me)
    const pk = l.store("player/pack")!
    step(sim, me, { from: { at: "pack", slot: pk.slots.findIndex((s) => s?.item === "plank") }, to: { at: "case", slot: 3 * 7 + 3 } })
    step(sim, me, { from: { at: "pack", slot: pk.slots.findIndex((s) => s?.item === "ammo") }, to: { at: "case", slot: 6, r: true } })
    sync()
    expect(caseCells(client, "player")).toEqual(caseCells(sim, "player"))
    expect(caseCells(client, "player")).toEqual(["......a", ".......", ".......", "...pppp"])
  })

  test("a pouch from the bench adds a row, two at most; the Breacher starts with the attaché case", () => {
    const { sim, slots } = scene()
    const me = slots[0]!
    const l = sim.progression.ledger
    l.apply({ kind: "grant", actor: "player", item: "learned:pouch", store: "team/known" })
    l.apply({ kind: "grant", actor: "player", item: "chem", count: 2 })
    l.apply({ kind: "grant", actor: "player", item: "scrap", count: 2 })
    expect(l.apply({ kind: "run", actor: "player", rule: "craft:pouch", station: sim.progression.benches[0]!.id }).ok).toBe(true)
    expect(l.count("player/worn", "pouch")).toBe(1)
    sim.progression.project(me)
    expect(l.store("player/pack")!.grid).toEqual({ cols: 6, rows: 4 })
    l.apply({ kind: "grant", actor: "player", item: "pouch", count: 1 })
    expect(l.apply({ kind: "grant", actor: "player", item: "pouch", count: 1 }).ok).toBe(false)
    sim.progression.project(me)
    expect(l.store("player/pack")!.grid).toEqual({ cols: 6, rows: 5 })
    // A third is refused (two at most); the recipe makes them at a bench.
    const bench = sim.progression.benches[0]!.id
    l.apply({ kind: "grant", actor: "player", item: "learned:pouch", store: "team/known" })
    l.apply({ kind: "grant", actor: "player", item: "chem", count: 2 })
    l.apply({ kind: "grant", actor: "player", item: "scrap", count: 2 })
    const third = l.canApply({ kind: "run", actor: "player", rule: "craft:pouch", station: bench })
    expect(third.ok ? null : third.reason).toBe("full")
    sim.progression.setLoadout(me, "breacher")
    expect(sim.progression.bagOf("player").bag.id).toBe("attache")
    expect(l.store("player/pack")!.grid).toEqual({ cols: 7, rows: 3 })
  })
})
