import { describe, expect, test } from "bun:test"
import { Ledger, type LedgerCatalog, type StoreState } from "./ledger"

const catalog = (): LedgerCatalog => ({
  items: [
    { id: "hands", label: "Hands", tag: "hand", slot: 0, bound: true },
    { id: "gun", label: "Gun", tag: "tool", grid: { w: 2, h: 2 }, unique: true },
    { id: "bar", label: "Bar", tag: "tool", grid: { w: 4, h: 1 } },
    { id: "ammo", label: "Ammo", tag: "ammo", stack: 10, grid: { w: 1, h: 1 } },
    { id: "can", label: "Gas can", tag: "resource", grid: { w: 2, h: 3 } },
  ],
  actorStores: [
    { suffix: "hotbar", mode: "slots", size: 2, accepts: ["hand", "tool"], preferSlots: true },
    { suffix: "pack", mode: "slots", grid: { cols: 4, rows: 3 }, accepts: ["tool", "ammo", "resource"], depositable: true },
  ],
  stores: [{ id: "box", mode: "slots", size: 4, scope: "shared", revealed: true, at: { x: 0, y: 0 }, initial: [{ item: "bar", count: 1 }, { item: "ammo", count: 7 }] }],
})

const cells = (ledger: Ledger, st: StoreState) => {
  const occ = ledger.occupancy(st)
  const rows: string[] = []
  for (let y = 0; y < st.grid!.rows; y++) rows.push(occ.slice(y * st.grid!.cols, (y + 1) * st.grid!.cols).map((i) => (i < 0 ? "." : (st.slots[i]!.item[0] ?? "?"))).join(""))
  return rows
}

describe("Ledger grid stores", () => {
  test("stacks land top-left first, turned when only that fits, and stop when no shape fits", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    const pack = ledger.store("a/pack")!
    expect(pack.size).toBe(12)
    ledger.apply({ kind: "grant", actor: "a", item: "hands" })
    ledger.apply({ kind: "grant", actor: "a", item: "bar", count: 2 })
    // One bar in the free hand slot, the other across the top of the pack.
    expect(cells(ledger, pack)).toEqual(["bbbb", "....", "...."])
    expect(ledger.apply({ kind: "grant", actor: "a", item: "can" }).ok).toBe(true)
    // Two rows left: the 2×3 can goes in turned (3×2).
    expect(cells(ledger, pack)).toEqual(["bbbb", "ccc.", "ccc."])
    // A second can no longer fits as it lies or turned.
    expect(ledger.room("a", "can", 1)).toBe(0)
    expect(ledger.apply({ kind: "grant", actor: "a", item: "can" }).reason).toBe("full")
    // Ammo tops up its stack before taking a new cell.
    ledger.apply({ kind: "grant", actor: "a", item: "ammo", count: 14 })
    expect(cells(ledger, pack)).toEqual(["bbbb", "ccca", "ccca"])
    expect(ledger.room("a", "ammo", 30)).toBe(6)
  })

  test("place moves, turns and tops up; refuses overlaps and the edge", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    const pack = ledger.store("a/pack")!
    ledger.apply({ kind: "grant", actor: "a", item: "hands" })
    ledger.apply({ kind: "grant", actor: "a", item: "bar", count: 2 })
    const bar = pack.slots.findIndex((s) => s?.item === "bar")
    // Turned a quarter it stands 1×4: too tall for three rows.
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/pack", slot: bar }, to: "a/pack", x: 0, y: 0, r: true }).reason).toBe("full")
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/pack", slot: bar }, to: "a/pack", x: 0, y: 2 }).ok).toBe(true)
    expect(cells(ledger, pack)).toEqual(["....", "....", "bbbb"])
    ledger.apply({ kind: "grant", actor: "a", item: "gun" })
    const gun = pack.slots.findIndex((s) => s?.item === "gun")
    expect(cells(ledger, pack)).toEqual(["gg..", "gg..", "bbbb"])
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/pack", slot: gun }, to: "a/pack", x: 1, y: 1 }).reason).toBe("full")
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/pack", slot: gun }, to: "a/pack", x: 1, y: 0 }).ok).toBe(true)
    expect(cells(ledger, pack)).toEqual([".gg.", ".gg.", "bbbb"])
    // Split ammo, then drop part of one stack onto the other to top it up.
    ledger.apply({ kind: "grant", actor: "a", item: "ammo", count: 9 })
    const ammo = pack.slots.findIndex((s) => s?.item === "ammo")
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/pack", slot: ammo }, to: "a/pack", x: 3, y: 1, count: 4 }).ok).toBe(true)
    expect(pack.slots.filter((s) => s?.item === "ammo").map((s) => s!.count).sort()).toEqual([4, 5])
    const four = pack.slots.findIndex((s) => s?.item === "ammo" && s.count === 4)
    const five = pack.slots.findIndex((s) => s?.item === "ammo" && s.count === 5)
    const at = pack.places![five]!
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/pack", slot: four }, to: "a/pack", x: at.x, y: at.y }).ok).toBe(true)
    expect(pack.slots.filter((s) => s?.item === "ammo").map((s) => s!.count)).toEqual([9])
  })

  test("place brings things in from the hands and from a revealed box, and a swap finds the hand item a place", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    const pack = ledger.store("a/pack")!
    ledger.apply({ kind: "grant", actor: "a", item: "hands" })
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "box", slot: 0 }, to: "a/pack", x: 0, y: 1 }).ok).toBe(true)
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "box", slot: 1 }, to: "a/pack", x: 3, y: 0, count: 3 }).ok).toBe(true)
    expect(cells(ledger, pack)).toEqual(["...a", "bbbb", "...."])
    expect(ledger.store("box")!.slots[1]!.count).toBe(4)
    // Fists never go in the case.
    expect(ledger.apply({ kind: "place", actor: "a", from: { store: "a/hotbar", slot: 0 }, to: "a/pack", x: 0, y: 2 }).reason).toBe("empty")
    ledger.apply({ kind: "grant", actor: "a", item: "gun" })
    expect(ledger.store("a/hotbar")!.slots[1]!.item).toBe("gun")
    // Swapping the bar into the hand puts the gun where the bar lay if it fits, else anywhere.
    const bar = pack.slots.findIndex((s) => s?.item === "bar")
    expect(ledger.apply({ kind: "swap", actor: "a", a: { store: "a/pack", slot: bar }, b: { store: "a/hotbar", slot: 1 } }).ok).toBe(true)
    expect(ledger.store("a/hotbar")!.slots[1]!.item).toBe("bar")
    expect(cells(ledger, pack)).toEqual(["...a", "gg..", "gg.."])
  })

  test("growing keeps every place, snapshots and deltas carry the grid, and drop takes a count", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.apply({ kind: "grant", actor: "a", item: "can" })
    ledger.apply({ kind: "grant", actor: "a", item: "ammo", count: 8 })
    const rev = ledger.rev
    expect(ledger.growGrid("a/pack", { cols: 3, rows: 2 })).toBe(false)
    expect(ledger.growGrid("a/pack", { cols: 5, rows: 4 })).toBe(true)
    const pack = ledger.store("a/pack")!
    expect(pack.size).toBe(20)
    expect(cells(ledger, pack)).toEqual(["cca..", "cc...", "cc...", "....."])
    const mirror = new Ledger(catalog())
    mirror.applyDelta(ledger.diff(0)!)
    expect(cells(mirror, mirror.store("a/pack")!)).toEqual(cells(ledger, pack))
    expect(ledger.diff(rev)!.upserted.map((s) => s.id)).toContain("a/pack")
    const ammo = pack.slots.findIndex((s) => s?.item === "ammo")
    const res = ledger.apply({ kind: "drop", actor: "a", at: { x: 1, y: 1 }, store: "a/pack", slot: ammo, count: 5 })
    expect(ledger.store(res.dropId!)!.slots[0]).toEqual({ item: "ammo", count: 5 })
    expect(pack.slots[ammo]).toEqual({ item: "ammo", count: 3 })
    const restored = new Ledger(catalog())
    restored.restore(ledger.snapshot())
    expect(cells(restored, restored.store("a/pack")!)).toEqual(cells(ledger, pack))
  })
})
