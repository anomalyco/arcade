import { describe, expect, test } from "bun:test"
import { CoopSim } from "../shared/coop-sim"
import { applyInventoryOp } from "../shared/inventory-ops/ops"
import { ITEMS } from "../shared/progression/catalog"
import { ITEM_SHAPES } from "../shared/progression/shapes"
import type { SessionView } from "../shared/session"
import { fitAt, inventoryModel, moveFor, parseRef, quickMoveFor, type InvModel } from "../src/inventory/model"
import { caseHtml, packShapes } from "../src/inventory/render"
import { PORTRAITS } from "../src/portraits"

function scene(withDrop: boolean) {
  const sim = new CoopSim(7, 7, 0.22, { zombieCount: 0, openingCalm: 0 }, undefined, "classic")
  const me = sim.addSurvivor("player", 0)
  const mate = sim.addSurvivor("mate1", 1)
  Object.assign(me.survivor, { x: 27.6, y: 27.2, aim: 0 })
  Object.assign(mate.survivor, { x: 28.6, y: 27.2, aim: 0 })
  if (withDrop) {
    sim.progression.ledger.createStore({ id: "drop:900", mode: "slots", scope: "shared", size: 3, at: { x: 27.9, y: 27.2 }, initial: [{ item: "machete", count: 1 }, { item: "plank", count: 2 }] })
    me.prompt = { kind: "drop", id: "drop:900" } as typeof me.prompt
  }
  const view = () => ({ progression: sim.progression, actorId: "player", prompt: me.prompt, player: me.survivor }) as unknown as SessionView
  const model = (): InvModel => inventoryModel(view(), { sim }, (i) => `Seat ${i}`, () => "#fff")
  return { sim, me, model }
}

describe("the Attaché Case (AR-94, D-46)", () => {
  test("every carried item has a shape and a painted portrait", () => {
    const carried = ITEMS.filter((d) => d.tag !== "knowledge")
    for (const d of carried) {
      expect(ITEM_SHAPES[d.id]).toBeDefined()
      expect(d.grid).toEqual(ITEM_SHAPES[d.id])
      expect(PORTRAITS[d.id]).toContain(`${d.id}.webp`)
    }
  })

  test("the model lays the case out from the room's places", () => {
    const { model } = scene(false)
    const m = model()
    expect([m.case.cols, m.case.rows, m.case.bag]).toEqual([6, 3, "School Backpack"])
    expect(m.case.items.map((i) => `${i.stack!.item}@${i.x},${i.y} ${i.w}×${i.h}`)).toEqual(["ammo@0,0 1×1", "plank@1,0 4×1"])
    expect(m.case.used).toBe(5)
    expect(m.mates.map((x) => x.index)).toEqual([1])
  })

  test("fit: free cells, topping up a stack, and blocked by others, the edge or the wrong turn", () => {
    const { sim, model } = scene(false)
    const l = sim.progression.ledger
    const m = model()
    const planks = m.case.items.find((i) => i.stack!.item === "plank")!.ref
    const ammo = m.case.items.find((i) => i.stack!.item === "ammo")!.ref
    expect(fitAt(m, l, planks, 2, 0, false)).toBe("fit") // overlaps only itself
    expect(fitAt(m, l, planks, 0, 0, false)).toBe("blocked") // the ammo
    expect(fitAt(m, l, planks, 3, 1, false)).toBe("blocked") // off the edge
    expect(fitAt(m, l, planks, 5, 0, true)).toBe("blocked") // turned: 4 tall in 3 rows
    expect(fitAt(m, l, { at: "hotbar", slot: 1 }, 4, 1, false)).toBe("fit") // the pistol, 2×2
    expect(fitAt(m, l, { at: "hotbar", slot: 0 }, 4, 1, false)).toBe("blocked") // fists never go in
    l.apply({ kind: "grant", actor: "player", item: "ammo", count: 15 })
    const m2 = model()
    // The first box is full now (15); the rest started a second one, which the full box can top up.
    const spare = m2.case.items.find((i) => i.stack!.item === "ammo" && i.ref.slot !== ammo.slot)!
    expect(fitAt(m2, l, spare.ref, 0, 0, false)).toBe("blocked")
    expect(fitAt(m2, l, ammo, spare.x, spare.y, false)).toBe("merge")
  })

  test("drags become exact moves; meaningless ones do nothing", () => {
    const { model } = scene(true)
    const m = model()
    const planks = m.case.items.find((i) => i.stack!.item === "plank")!.ref
    expect(moveFor(m, planks, { at: "case", slot: 13, r: true })).toEqual({ from: planks, to: { at: "case", slot: 13, r: true }, count: 0 })
    expect(moveFor(m, { at: "hotbar", slot: 1 }, { at: "pack", slot: -1 })?.to).toEqual({ at: "pack", slot: 0 })
    expect(moveFor(m, { at: "target", slot: 0 }, { at: "hotbar", slot: 2 })?.to).toEqual({ at: "hotbar", slot: 2 })
    expect(moveFor(m, { at: "target", slot: 1 }, { at: "case", slot: 7 })?.to).toEqual({ at: "case", slot: 7 })
    expect(moveFor(m, planks, { at: "mate", slot: 1 }, 1)).toEqual({ from: planks, to: { at: "mate", slot: 1 }, count: 1 })
    expect(moveFor(m, planks, { at: "target", slot: 1 })?.to).toEqual({ at: "target", slot: 0 })
    expect(moveFor(m, { at: "hotbar", slot: 0 }, { at: "case", slot: 7 })).toBeNull()
    expect(moveFor(m, { at: "hotbar", slot: 1 }, { at: "hotbar", slot: 1 })).toBeNull()
    expect(moveFor(m, { at: "target", slot: 0 }, { at: "ground", slot: 0 })).toBeNull()
  })

  test("a click quick-moves: out of what you face, into it when open, else between hands and case", () => {
    const open = scene(true).model()
    expect(quickMoveFor(open, { at: "target", slot: 0 })?.to.at).toBe("me")
    expect(quickMoveFor(open, { at: "hotbar", slot: 1 })?.to.at).toBe("target")
    const shut = scene(false)
    const m = shut.model()
    expect(quickMoveFor(m, { at: "hotbar", slot: 1 })?.to.at).toBe("pack")
    const planks = m.case.items.find((i) => i.stack!.item === "plank")!.ref
    expect(quickMoveFor(m, planks)).toBeNull() // supplies stay in the case
  })

  test("the moves the model makes are the moves the room accepts", () => {
    const { sim, me, model } = scene(true)
    const machete = moveFor(model(), { at: "target", slot: 0 }, { at: "case", slot: 2 * 6 + 2 })!
    expect(applyInventoryOp(sim, me, machete).ok).toBe(true)
    const m = model()
    const item = m.case.items.find((i) => i.stack!.item === "machete")!
    expect([item.x, item.y, item.w, item.h]).toEqual([2, 2, 4, 1])
    expect(fitAt(m, sim.progression.ledger, item.ref, 2, 1, false)).toBe("fit")
  })

  test("renders portraits on the paper, quick slots on the lid, the crate beside, unfolding cells after growth", () => {
    const { sim, model } = scene(true)
    const ledger = sim.progression.ledger
    const html = caseHtml(model(), { fresh: new Set(), pending: new Set(), grown: { cols: 5, rows: 3 } }, (i) => ledger.footprint(i))
    expect(html).toContain('data-ref="case:-1"')
    expect(html).toContain("plank.webp")
    expect(html).toContain('data-ref="target:0"')
    expect(html.match(/class="inv-quick /g)).toHaveLength(5)
    expect(html.match(/data-new="true"/g)).toHaveLength(3)
    expect(html).toContain("School Backpack")
  })

  test("refs parse from data attributes", () => {
    expect(parseRef("pack:2")).toEqual({ at: "pack", slot: 2 })
    expect(parseRef("case:-1")).toEqual({ at: "case", slot: -1 })
    expect(parseRef("nope:1")).toBeNull()
    expect(parseRef(undefined)).toBeNull()
  })

  test("the crate packs shapes without overlap, turning what is too long", () => {
    const shapes = packShapes(
      [
        { id: "a", w: 4, h: 2 },
        { id: "b", w: 3, h: 2 },
        { id: "c", w: 1, h: 1 },
        { id: "d", w: 9, h: 1 },
      ],
      8,
    )
    expect(shapes).toHaveLength(4)
    expect(shapes.find((s) => s.id === "d")?.rot).toBe(true)
    const taken = new Set<string>()
    for (const s of shapes) {
      expect(s.x + s.w).toBeLessThanOrEqual(8)
      for (let y = s.y; y < s.y + s.h; y++)
        for (let x = s.x; x < s.x + s.w; x++) {
          expect(taken.has(`${x},${y}`)).toBe(false)
          taken.add(`${x},${y}`)
        }
    }
  })
})
