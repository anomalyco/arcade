import { describe, expect, test } from "bun:test"
import { Ledger, type LedgerCatalog, type Stack, type StoreState } from "./ledger"

const catalog = (): LedgerCatalog => ({
  items: [
    { id: "gun", label: "Gun", tag: "tool", slot: 1, charge: { max: 6, initial: 2, ammo: "ammo" } },
    { id: "knife", label: "Knife", tag: "tool", mods: { damage: { add: 5 } }, activeOnly: true },
    { id: "med", label: "Med", tag: "tool", stack: 3 },
    { id: "ammo", label: "Ammo", tag: "ammo", maxCount: 10 },
    { id: "wood", label: "Wood", tag: "resource", maxCount: 5, discovers: ["seen:wood"] },
    { id: "crate", label: "Crate", tag: "part", slots: 2 },
    { id: "seen:wood", label: "Wood", tag: "knowledge" },
    { id: "learned:club", label: "Club", tag: "knowledge" },
    { id: "club", label: "Club", tag: "tool" },
    { id: "hands", label: "Hands", tag: "tool", slot: 0, bound: true },
  ],
  actorStores: [
    { suffix: "belt", mode: "counters", accepts: ["ammo", "resource"], depositable: true },
    { suffix: "hotbar", mode: "slots", size: 3, accepts: ["tool"], preferSlots: true },
    { suffix: "pack", mode: "slots", size: 2, accepts: ["part", "tool"], depositable: true },
  ],
  stores: [
    { id: "bench", mode: "counters", accepts: ["resource", "part"] },
    { id: "loot:1", mode: "slots", size: 3, revealed: false, initial: [{ item: "ammo", count: 4 }, { item: "wood", count: 2 }, { item: "med", count: 1 }] },
  ],
  rules: [
    { id: "learn:club", label: "Learn club", duration: 2, station: "bench", lightMin: 0.4, forbids: { "learned:club": 1 }, consume: { wood: 2 }, produce: { "learned:club": 1 }, produceTo: "team/known" },
    { id: "craft:club", label: "Craft club", duration: 1, requires: { "learned:club": 1 }, consume: { wood: 1 }, produce: { club: 1 } },
  ],
})

/** Every count in every store, for conservation checks. */
function totals(ledger: Ledger, ignore: (st: StoreState) => boolean = () => false): Record<string, number> {
  const out: Record<string, number> = {}
  for (const st of ledger.stores.values()) {
    if (ignore(st)) continue
    const stacks: Stack[] = st.mode === "slots" ? st.slots.filter((s): s is Stack => !!s) : Object.entries(st.counts).map(([item, count]) => ({ item, count }))
    for (const s of stacks) out[s.item] = (out[s.item] ?? 0) + s.count
  }
  return out
}

function invariants(ledger: Ledger): void {
  for (const st of ledger.stores.values()) {
    if (st.mode === "slots") {
      expect(ledger.usedSlots(st)).toBeLessThanOrEqual(st.size)
      for (const s of st.slots) if (s) expect(s.count).toBeGreaterThan(0)
    } else {
      for (const [item, n] of Object.entries(st.counts)) {
        expect(Number.isInteger(n) && n > 0).toBe(true)
        expect(n).toBeLessThanOrEqual(ledger.capFor(st, item))
      }
    }
  }
}

describe("Ledger", () => {
  test("bound items stay with the actor: no drop, deposit or leaving them behind", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    expect(ledger.apply({ kind: "grant", actor: "a", item: "hands" }).ok).toBe(true)
    expect(ledger.apply({ kind: "grant", actor: "a", item: "gun" }).ok).toBe(true)
    ledger.apply({ kind: "select", actor: "a", slot: 0 })
    expect(ledger.activeItem("a")?.item).toBe("hands")
    expect(ledger.apply({ kind: "drop", actor: "a", at: { x: 0, y: 0 } }).reason).toBe("empty")
    expect(ledger.apply({ kind: "drop", actor: "a", at: { x: 0, y: 0 }, items: { hands: 1 } }).reason).toBe("missing_item")
    expect(ledger.apply({ kind: "deposit", actor: "a", to: "bench", from: { store: "a/hotbar", slot: 0 } }).reason).toBe("empty")
    const left = ledger.removeActor("a", { x: 1, y: 1 })!
    expect(ledger.store(left)!.slots.map((s) => s?.item)).toEqual(["gun"])
  })

  test("reveal gates take; take routes by tag, keeps the rest when full, and discovers once", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    expect(ledger.apply({ kind: "take", actor: "a", from: "loot:1" }).reason).toBe("unrevealed")
    expect(ledger.apply({ kind: "reveal", actor: "a", store: "loot:1" }).ok).toBe(true)
    ledger.apply({ kind: "grant", actor: "a", item: "ammo", count: 8 })
    const before = totals(ledger)
    const res = ledger.apply({ kind: "take", actor: "a", from: "loot:1" })
    expect(res.ok).toBe(true)
    expect(res.left).toBe(2) // belt holds 10 ammo; 2 of the 4 stay behind
    expect(ledger.count("a/belt", "ammo")).toBe(10)
    expect(ledger.count("loot:1", "ammo")).toBe(2)
    expect(ledger.count("a/belt", "wood")).toBe(2)
    expect(ledger.count("a/hotbar", "med")).toBe(1)
    expect(ledger.has("a", "seen:wood")).toBe(true)
    expect(res.events.some((e) => e.kind === "rejected" && e.reason === "full")).toBe(true)
    // Conservation: moving items never creates or destroys them (the knowledge token is new).
    const after = totals(ledger)
    expect(after.ammo).toBe(before.ammo)
    expect(after.wood).toBe(before.wood)
    expect(after["seen:wood"]).toBe(1)
    invariants(ledger)
  })

  test("preferred slot, multi-slot parts and a full pack reject without changing anything", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.apply({ kind: "grant", actor: "a", item: "gun" })
    expect(ledger.store("a/hotbar")!.slots[1]?.item).toBe("gun")
    expect(ledger.store("a/hotbar")!.slots[1]?.charge).toBe(2)
    expect(ledger.apply({ kind: "grant", actor: "a", item: "crate" }).ok).toBe(true)
    const snap = JSON.stringify(ledger.snapshot())
    const full = ledger.apply({ kind: "grant", actor: "a", item: "crate" })
    expect(full.ok).toBe(false)
    expect(full.reason).toBe("full")
    expect(JSON.stringify(ledger.snapshot())).toBe(snap)
  })

  test("reload moves ammo into the charge and stat folds active-only mods", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.apply({ kind: "grant", actor: "a", item: "gun" })
    ledger.apply({ kind: "grant", actor: "a", item: "knife" })
    ledger.apply({ kind: "grant", actor: "a", item: "ammo", count: 3 })
    expect(ledger.apply({ kind: "reload", actor: "a" }).ok).toBe(true)
    expect(ledger.store("a/hotbar")!.slots[1]!.charge).toBe(5)
    expect(ledger.count("a", "ammo")).toBe(0)
    expect(ledger.apply({ kind: "reload", actor: "a" }).reason).toBe("missing_item")
    ledger.apply({ kind: "select", actor: "a", slot: 0 })
    expect(ledger.activeItem("a")?.item).toBe("knife")
    expect(ledger.stat("a", "damage", 10)).toBe(15)
    ledger.apply({ kind: "select", actor: "a", slot: 1 })
    expect(ledger.stat("a", "damage", 10)).toBe(10)
  })

  test("a station rule checks light, consumes the station first and shares what it teaches", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.addActor("b")
    ledger.apply({ kind: "grant", actor: "a", item: "wood", count: 3 })
    expect(ledger.apply({ kind: "deposit", actor: "a", to: "bench" }).ok).toBe(true)
    expect(ledger.count("bench", "wood")).toBe(3)
    const tx = { kind: "run", actor: "a", rule: "learn:club", station: "bench" } as const
    expect(ledger.canApply(tx, { light: 0.1 })).toMatchObject({ ok: false, reason: "low_light" })
    expect(ledger.canApply({ ...tx, station: undefined })).toMatchObject({ ok: false, reason: "wrong_station" })
    expect(ledger.start(tx, { light: 1 }).duration).toBe(2)
    expect(ledger.step(1.9)).toEqual([])
    const done = ledger.step(0.2, () => ({ light: 1 }))
    expect(done.some((e) => e.kind === "unlocked" && e.item === "learned:club")).toBe(true)
    expect(ledger.count("bench", "wood")).toBe(1)
    // b never touched the bench but can now craft from their own wood.
    ledger.apply({ kind: "grant", actor: "b", item: "wood", count: 1 })
    expect(ledger.canApply({ kind: "run", actor: "b", rule: "craft:club" }).ok).toBe(true)
    expect(ledger.canApply(tx, { light: 1 })).toMatchObject({ ok: false, reason: "already_known" })
  })

  test("two actors channelling the same thing: the second re-validates and gets nothing", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.addActor("b")
    ledger.apply({ kind: "grant", actor: "a", item: "wood", count: 2 })
    ledger.apply({ kind: "deposit", actor: "a", to: "bench" })
    const learn = (actor: string) => ledger.start({ kind: "run", actor, rule: "learn:club", station: "bench" }, { light: 1 })
    expect(learn("a").ok).toBe(true)
    expect(learn("b").ok).toBe(true)
    const events = ledger.step(2.5, () => ({ light: 1 }))
    const ran = events.filter((e) => e.kind === "ran")
    expect(ran).toHaveLength(1)
    expect(events.some((e) => e.kind === "rejected" && e.actor === "b" && e.reason === "already_known")).toBe(true)
    expect(ledger.count("bench", "wood")).toBe(0)
    invariants(ledger)
  })

  test("two actors taking the last item in one tick: exactly one gets it", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.addActor("b")
    ledger.apply({ kind: "reveal", actor: "a", store: "loot:1" })
    const a = ledger.apply({ kind: "take", actor: "a", from: "loot:1", slot: 2 })
    const b = ledger.apply({ kind: "take", actor: "b", from: "loot:1", slot: 2 })
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(false)
    expect(b.reason).toBe("empty")
    expect(ledger.count("a", "med") + ledger.count("b", "med")).toBe(1)
  })

  test("an environment veto blocks a channel at completion", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.apply({ kind: "grant", actor: "a", item: "wood", count: 1 })
    ledger.apply({ kind: "grant", actor: "a", item: "learned:club", store: "team/known" })
    ledger.start({ kind: "run", actor: "a", rule: "craft:club" })
    const events = ledger.step(1, () => ({ check: () => "busy" }))
    expect(events).toEqual([expect.objectContaining({ kind: "rejected", reason: "blocked", detail: "busy" })])
    expect(ledger.count("a", "wood")).toBe(1)
  })

  test("drops carry charge, vanish when emptied, and deltas converge a mirror", () => {
    const server = new Ledger(catalog())
    server.addActor("a")
    server.addActor("b")
    server.apply({ kind: "grant", actor: "a", item: "gun" })
    server.apply({ kind: "grant", actor: "a", item: "ammo", count: 6 })
    const mirror = new Ledger(catalog())
    mirror.applyDelta(server.diff(0, { visibleTo: "b" })!)
    expect(mirror.store("a/belt")).toBeUndefined()
    let synced = server.rev

    const drop = server.apply({ kind: "drop", actor: "a", at: { x: 1, y: 2 }, store: "a/hotbar", slot: 1 })
    expect(drop.ok).toBe(true)
    const bundle = server.apply({ kind: "drop", actor: "a", at: { x: 1, y: 2 }, items: { ammo: 4 } })
    expect(server.count("a", "ammo")).toBe(2)
    let delta = server.diff(synced, { visibleTo: "b" })!
    synced = delta.toRev
    mirror.applyDelta(delta)
    expect(mirror.store(drop.dropId!)!.slots[0]).toEqual({ item: "gun", count: 1, charge: 2 })
    expect(mirror.count(bundle.dropId!, "ammo")).toBe(4)

    server.apply({ kind: "take", actor: "b", from: drop.dropId! })
    server.apply({ kind: "take", actor: "b", from: bundle.dropId! })
    expect(server.store(drop.dropId!)).toBeUndefined()
    expect(server.store("b/hotbar")!.slots[1]).toEqual({ item: "gun", count: 1, charge: 2 })
    delta = server.diff(synced, { visibleTo: "b" })!
    expect(delta.removed).toEqual([drop.dropId!, bundle.dropId!].sort())
    mirror.applyDelta(delta)
    expect(mirror.store(drop.dropId!)).toBeUndefined()
    expect(mirror.count("b/belt", "ammo")).toBe(4)
    expect(server.diff(delta.toRev, { visibleTo: "b" })).toBeNull()
    invariants(server)
  })

  test("removing an actor leaves what they carried on the ground", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    ledger.apply({ kind: "grant", actor: "a", item: "gun" })
    ledger.apply({ kind: "grant", actor: "a", item: "wood", count: 2 })
    const dropId = ledger.removeActor("a", { x: 3, y: 4 })!
    expect(ledger.store("a/belt")).toBeUndefined()
    expect(ledger.count(dropId, "gun")).toBe(1)
    expect(ledger.count(dropId, "wood")).toBe(2)
  })

  test("swap moves a pack item into the hand only where it fits", () => {
    const ledger = new Ledger(catalog())
    ledger.addActor("a")
    for (const item of ["knife", "gun", "med", "club"]) ledger.apply({ kind: "grant", actor: "a", item })
    expect(ledger.store("a/pack")!.slots[0]?.item).toBe("club")
    expect(ledger.apply({ kind: "swap", actor: "a", a: { store: "a/pack", slot: 0 }, b: { store: "a/hotbar", slot: 0 } }).ok).toBe(true)
    expect(ledger.store("a/hotbar")!.slots[0]?.item).toBe("club")
    expect(ledger.store("a/pack")!.slots[0]?.item).toBe("knife")
    // The two-slot crate does not fit beside the knife, and parts never go into the hand.
    expect(ledger.apply({ kind: "grant", actor: "a", item: "crate" }).reason).toBe("full")
    ledger.apply({ kind: "drop", actor: "a", at: { x: 0, y: 0 }, store: "a/pack", slot: 0 })
    expect(ledger.apply({ kind: "grant", actor: "a", item: "crate" }).ok).toBe(true)
    expect(ledger.apply({ kind: "swap", actor: "a", a: { store: "a/pack", slot: 0 }, b: { store: "a/hotbar", slot: 2 } }).reason).toBe("full")
  })
})
