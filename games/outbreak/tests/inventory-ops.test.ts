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

describe("inventory moves (AR-94)", () => {
  test("pack and unpack every end and count", () => {
    const ops: InventoryOp[] = [
      { from: { at: "hotbar", slot: 0 }, to: { at: "pack", slot: 3 } },
      { from: { at: "target", slot: 7 }, to: { at: "hotbar", slot: 4 }, count: 1 },
      { from: { at: "belt", slot: 0 }, to: { at: "mate", slot: 5 }, count: 12 },
      { from: { at: "pack", slot: 31 }, to: { at: "ground", slot: 0 }, count: 255 },
    ]
    for (const op of ops) expect(unpackInventoryOp(packInventoryOp(op))).toEqual(op)
    expect(unpackInventoryOp(0)).toBeNull()
    expect(unpackInventoryOp(-3)).toBeNull()
    expect(unpackInventoryOp("x")).toBeNull()
  })

  test("a command with a move survives the tuple and the binary wire", () => {
    const inv: InventoryOp = { from: { at: "belt", slot: 0 }, to: { at: "mate", slot: 2 }, count: 6 }
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

  test("swaps between hands and pack, and refuses a part in the hands with a notice", () => {
    const { sim, slots } = scene()
    const me = slots[0]!
    const l = sim.progression.ledger
    l.apply({ kind: "grant", actor: "player", item: "toolbox", count: 1 })
    const hotbar = () => l.store("player/hotbar")!.slots.map((s) => s?.item ?? null)
    const pack = () => l.store("player/pack")!.slots.map((s) => s?.item ?? null)
    l.apply({ kind: "grant", actor: "player", item: "knife", count: 1 })
    const handItem = hotbar().indexOf("knife")
    const firstItem = "knife"
    step(sim, me, { from: { at: "hotbar", slot: handItem }, to: { at: "pack", slot: 2 } })
    expect(pack()[2]).toBe(firstItem)
    expect(hotbar()[handItem]).toBeNull()
    const toolboxAt = pack().indexOf("toolbox")
    me.notices.length = 0
    step(sim, me, { from: { at: "pack", slot: toolboxAt }, to: { at: "hotbar", slot: 4 } })
    expect(pack()[toolboxAt]).toBe("toolbox")
    expect(me.notices.some((n) => /pack/i.test(n.text))).toBe(true)
  })

  test("drops part of a belt stack on the ground and hands a stack to a teammate in reach", () => {
    const { sim, slots } = scene(2)
    const [me, mate] = slots as [ReturnType<CoopSim["addSurvivor"]>, ReturnType<CoopSim["addSurvivor"]>]
    const l = sim.progression.ledger
    l.apply({ kind: "grant", actor: "player", item: "ammo", count: 10 })
    const ammoBefore = l.count("player", "ammo")
    const mateBefore = l.count("mate1", "ammo")
    step(sim, me, { from: { at: "belt", slot: 0 }, to: { at: "ground", slot: 0 }, count: 4 })
    expect(l.count("player", "ammo")).toBe(ammoBefore - 4)
    const drops = [...l.stores.values()].filter((s) => s.id.startsWith("drop:"))
    expect(drops.some((d) => (d.slots.find((s) => s?.item === "ammo")?.count ?? 0) === 4)).toBe(true)

    step(sim, me, { from: { at: "belt", slot: 0 }, to: { at: "mate", slot: mate.index }, count: 3 })
    expect(l.count("player", "ammo")).toBe(ammoBefore - 7)
    expect(l.count("mate1", "ammo")).toBe(mateBefore + 3)
    expect(mate.notices.some((n) => /gave you/.test(n.text))).toBe(true)

    // Out of reach: nothing moves and the giver is told why.
    mate.survivor.x += 10
    me.notices.length = 0
    step(sim, me, { from: { at: "belt", slot: 0 }, to: { at: "mate", slot: mate.index }, count: 1 })
    expect(l.count("player", "ammo")).toBe(ammoBefore - 7)
    expect(me.notices.some((n) => /closer/i.test(n.text))).toBe(true)
  })

  test("a teammate with full hands finds the gift at their feet", () => {
    const { sim, slots } = scene(2)
    const [me, mate] = slots as [ReturnType<CoopSim["addSurvivor"]>, ReturnType<CoopSim["addSurvivor"]>]
    const l = sim.progression.ledger
    const fill = (store: string) => {
      const st = l.store(store)!
      for (let i = 0; i < st.slots.length; i++) if (!st.slots[i]) st.slots[i] = { item: "knife", count: 1, charge: 10 }
      st.rev = ++l.rev
    }
    fill("mate1/hotbar")
    fill("mate1/pack")
    l.apply({ kind: "grant", actor: "player", item: "toolbox", count: 1 })
    const at = l.store("player/pack")!.slots.findIndex((s) => s?.item === "toolbox")
    step(sim, me, { from: { at: "pack", slot: at }, to: { at: "mate", slot: mate.index } })
    expect(l.count("player", "toolbox")).toBe(0)
    expect(l.count("mate1", "toolbox")).toBe(0)
    const drop = [...l.stores.values()].find((s) => s.id.startsWith("drop:") && s.slots.some((x) => x?.item === "toolbox"))
    expect(drop?.at).toEqual({ x: mate.survivor.x, y: mate.survivor.y })
    expect(me.notices.some((n) => /feet/.test(n.text))).toBe(true)
  })
})
