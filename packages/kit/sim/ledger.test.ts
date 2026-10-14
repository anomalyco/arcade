import { describe, expect, test } from "bun:test"
import { Ledger } from "./ledger"

describe("@arcade/kit/sim/ledger", () => {
  test("multi-slot heavy items, dynamic belt caps, and race-safe channels", () => {
    const ledger = new Ledger({
      items: [
        { id: "ammo", label: "Ammo", tag: "resource", maxCount: 10 },
        { id: "pouch", label: "Ammo Pouch", tag: "upgrade", mods: { "cap:ammo": { add: 10 } } },
        { id: "battery-heavy", label: "Heavy Battery", tag: "part", stack: 1, slots: 2 },
        { id: "fuse", label: "Fuse", tag: "part", stack: 1, slots: 1 },
        { id: "beacon", label: "Beacon", tag: "knowledge" },
      ],
      actorStores: [
        { suffix: "belt", mode: "counters", accepts: ["resource"] },
        { suffix: "pack", mode: "slots", size: 3, accepts: ["part"] },
      ],
      stores: [{ id: "bench:main", mode: "counters", scope: "shared", accepts: ["part"] }],
      rules: [
        {
          id: "build:beacon",
          label: "Build Beacon",
          duration: 1.0,
          station: "bench",
          forbids: { beacon: 1 },
          consume: { fuse: 1 },
          produce: { beacon: 1 },
          produceTo: "team/known",
        },
      ],
    })

    ledger.addActor("p1")
    ledger.addActor("p2")

    // Heavy battery uses 2 of 3 pack slots; 1 fuse fits, a second heavy battery is rejected
    expect(ledger.apply({ kind: "grant", actor: "p1", item: "battery-heavy" }).ok).toBe(true)
    expect(ledger.usedSlots(ledger.store("p1/pack")!)).toBe(2)
    expect(ledger.apply({ kind: "grant", actor: "p1", item: "fuse" }).ok).toBe(true)
    expect(ledger.usedSlots(ledger.store("p1/pack")!)).toBe(3)
    expect(ledger.canApply({ kind: "take", actor: "p1", from: "bench:main" }).ok).toBe(false)

    // Dynamic belt cap modifier via "pouch" in team/known
    ledger.apply({ kind: "grant", actor: "p1", item: "ammo", count: 15 })
    expect(ledger.count("p1/belt", "ammo")).toBe(10)
    ledger.apply({ kind: "grant", actor: "p1", store: "team/known", item: "pouch" })
    ledger.apply({ kind: "grant", actor: "p1", item: "ammo", count: 15 })
    expect(ledger.count("p1/belt", "ammo")).toBe(20)

    // Co-op race: both p1 and p2 start a 1.0s channel against a single fuse in bench:main
    ledger.apply({ kind: "grant", actor: "p1", store: "bench:main", item: "fuse", count: 1 })
    expect(ledger.start({ kind: "run", actor: "p1", rule: "build:beacon", station: "bench:main" }).ok).toBe(true)
    expect(ledger.start({ kind: "run", actor: "p2", rule: "build:beacon", station: "bench:main" }).ok).toBe(true)

    const events = ledger.step(1.0)
    expect(ledger.count("team/known", "beacon")).toBe(1)
    expect(ledger.count("p1/pack", "fuse")).toBe(0)
    // p2's duplicate channel is rejected by `forbids: { beacon: 1 }`, preserving bench:main's fuse
    expect(ledger.count("bench:main", "fuse")).toBe(1)
    expect(events.some((e) => e.kind === "rejected" && e.reason === "already_known")).toBe(true)
  })
})
