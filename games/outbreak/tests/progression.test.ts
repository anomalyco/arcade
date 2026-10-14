import { describe, expect, test } from "bun:test"
import {
  addOutbreakSurvivor,
  createOutbreakLedger,
  type LedgerEvent,
} from "../shared/progression"
import type { Tx } from "@arcade/kit/sim/ledger"

describe("Outbreak progression & inventory ledger", () => {
  test("1. reload: draws ammo from belt into active pistol magazine and formats badge", () => {
    const ledger = createOutbreakLedger()
    addOutbreakSurvivor(ledger, "p1")

    // Starts with 6/8 loaded and 6 in reserve on the belt
    expect(ledger.formatStack("p1", ledger.activeItem("p1"))).toBe("9MM 6/6")

    // Fire 3 shots
    for (let i = 0; i < 3; i++) {
      expect(ledger.apply({ kind: "useCharge", actor: "p1" }).ok).toBe(true)
    }
    expect(ledger.formatStack("p1", ledger.activeItem("p1"))).toBe("9MM 3/6")

    // Reload pulls 5 rounds from p1/belt into the pistol charge
    const reload = ledger.apply({ kind: "reload", actor: "p1" })
    expect(reload.ok).toBe(true)
    expect(ledger.activeItem("p1")?.charge).toBe(8)
    expect(ledger.count("p1/belt", "ammo")).toBe(1)
    expect(ledger.formatStack("p1", ledger.activeItem("p1"))).toBe("9MM 8/1")

    // Reloading when full rejects cleanly
    const full = ledger.apply({ kind: "reload", actor: "p1" })
    expect(full.ok).toBe(false)
    expect(full.reason).toBe("full")
  })

  test("2. search-a-container: two-speed reveal, auto-routing to belt/hotbar/pack, and touch-to-discover", () => {
    const ledger = createOutbreakLedger([
      {
        id: "loot:dresser-4",
        mode: "slots",
        size: 3,
        revealed: false,
        initial: [
          { item: "ammo", count: 6 },
          { item: "medkit", count: 1 },
          { item: "chem", count: 2 },
        ],
      },
      {
        id: "loot:shelf-1",
        mode: "slots",
        size: 2,
        revealed: false,
        initial: [{ item: "toolbox", count: 1 }],
      },
    ])
    addOutbreakSurvivor(ledger, "p1")

    // Taking before reveal is blocked
    expect(ledger.apply({ kind: "take", actor: "p1", from: "loot:dresser-4" }).reason).toBe("unrevealed")

    // Quiet search (1.2s, 3.5m noise) vs Fast smash (0.35s, 14m noise)
    const quietCheck = ledger.canApply({ kind: "reveal", actor: "p1", store: "loot:dresser-4", mode: "quiet" })
    const smashCheck = ledger.canApply({ kind: "reveal", actor: "p1", store: "loot:shelf-1", mode: "smash" })
    expect(quietCheck).toEqual({ ok: true, duration: 1.2, noise: 3.5, label: "Searching container" })
    expect(smashCheck).toEqual({ ok: true, duration: 0.35, noise: 14.0, label: "Smashing container" })

    // Reveal and take all from dresser-4
    expect(ledger.apply({ kind: "reveal", actor: "p1", store: "loot:dresser-4", mode: "quiet" }).ok).toBe(true)
    const take = ledger.apply({ kind: "take", actor: "p1", from: "loot:dresser-4" })
    expect(take.ok).toBe(true)

    // Auto-routed: ammo (6+6=12) and chem (2) on belt; medkit in hotbar slot 2; touch-to-discover unlocked bandage & molotov
    expect(ledger.count("p1/belt", "ammo")).toBe(12)
    expect(ledger.count("p1/belt", "chem")).toBe(2)
    expect(ledger.store("p1/hotbar")?.slots[2]?.item).toBe("medkit")
    expect(ledger.has("p1", "proto:bandage")).toBe(true)
    expect(ledger.has("p1", "proto:molotov")).toBe(true)

    // Smash shelf-1 and take toolbox -> routes to p1/pack slot 0
    ledger.apply({ kind: "reveal", actor: "p1", store: "loot:shelf-1", mode: "smash" })
    ledger.apply({ kind: "take", actor: "p1", from: "loot:shelf-1" })
    expect(ledger.store("p1/pack")?.slots[0]?.item).toBe("toolbox")
  })

  test("3. drop-for-a-teammate: toss supply bundle or active item onto floor and teammate picks up", () => {
    const ledger = createOutbreakLedger()
    addOutbreakSurvivor(ledger, "p1")
    addOutbreakSurvivor(ledger, "p2")

    // Drain p2's ammo and planks
    ledger.apply({ kind: "drain", store: "p2/belt", item: "ammo", count: 6 })
    ledger.apply({ kind: "drain", store: "p2/belt", item: "plank", count: 2 })
    expect(ledger.count("p2/belt", "ammo")).toBe(0)

    // Player 1 holds KeyG to toss a +4 ammo / +2 plank bundle at (28.4, 41.0)
    const drop = ledger.apply({
      kind: "drop",
      actor: "p1",
      items: { ammo: 4, plank: 2 },
      at: { x: 28.4, y: 41.0 },
    })
    expect(drop.ok).toBe(true)
    expect(drop.dropId).toBe("drop:1")
    expect(ledger.count("p1/belt", "ammo")).toBe(2)
    expect(ledger.count("p1/belt", "plank")).toBe(0)

    // Player 2 taps KeyE on the floor pickup; transient drop store is deleted once emptied
    const pickup = ledger.apply({ kind: "take", actor: "p2", from: drop.dropId! })
    expect(pickup.ok).toBe(true)
    expect(ledger.count("p2/belt", "ammo")).toBe(4)
    expect(ledger.count("p2/belt", "plank")).toBe(2)
    expect(ledger.store(drop.dropId!)).toBeUndefined()
  })

  test("4. research-at-bench (Direction 1): deposit supplies, prototype in light, and squad field-crafts", () => {
    const ledger = createOutbreakLedger()
    addOutbreakSurvivor(ledger, "p1")
    addOutbreakSurvivor(ledger, "p2")

    // Give p1 scrap, battery, toolbox, and give p2 chem
    ledger.apply({ kind: "grant", actor: "p1", item: "scrap", count: 4 })
    ledger.apply({ kind: "grant", actor: "p1", item: "battery", count: 1 })
    ledger.apply({ kind: "grant", actor: "p1", item: "toolbox", count: 1 })
    ledger.apply({ kind: "grant", actor: "p2", item: "chem", count: 1 })

    // Hold KeyE at bench:ash deposits scrap, planks, battery, and toolbox, but keeps p1's 9mm ammo on belt
    expect(ledger.apply({ kind: "deposit", actor: "p1", to: "bench:ash" }).ok).toBe(true)
    expect(ledger.count("bench:ash", "toolbox")).toBe(1)
    expect(ledger.count("bench:ash", "scrap")).toBe(4)
    expect(ledger.count("p1/belt", "ammo")).toBe(6)

    // In darkness (light 0.12 < 0.35), prototyping is blocked
    const darkTry = ledger.apply(
      { kind: "run", actor: "p1", rule: "proto:uv-stun", station: "bench:ash" },
      { light: 0.12, threat: 0.7 },
    )
    expect(darkTry.ok).toBe(false)
    expect(darkTry.reason).toBe("low_light")

    // With room lamp on (light 0.82 >= 0.35), p1 prototypes UV Stun Capacitor for the whole squad
    const proto = ledger.apply(
      { kind: "run", actor: "p1", rule: "proto:uv-stun", station: "bench:ash" },
      { light: 0.82, threat: 0.42 },
    )
    expect(proto.ok).toBe(true)
    expect(ledger.has("p2", "proto:uv-stun")).toBe(true)
    expect(ledger.stat("p2", "uvStunBurst", 0)).toBe(1)
    expect(ledger.count("bench:ash", "scrap")).toBe(1)

    // Player 2 field-crafts a Bandage in the dark using the shared prototype
    const fieldCraft = ledger.apply(
      { kind: "run", actor: "p2", rule: "craft:bandage" },
      { light: 0.1, threat: 0.84 },
    )
    expect(fieldCraft.ok).toBe(true)
    expect(ledger.count("p2/hotbar", "bandage")).toBe(1)
    expect(ledger.count("p2/belt", "chem")).toBe(0)
  })

  test("5. learn-from-manual (Direction 2): 4s study channel in light grants squad recipe and Fast Triage perk", () => {
    const ledger = createOutbreakLedger()
    addOutbreakSurvivor(ledger, "p1")
    addOutbreakSurvivor(ledger, "p2")
    ledger.apply({ kind: "grant", actor: "p1", item: "manual:trauma", count: 1 })

    // Cannot start studying in the dark
    expect(
      ledger.start({ kind: "run", actor: "p1", rule: "study:trauma" }, { light: 0.15 }).reason,
    ).toBe("low_light")

    // Start 4.0s study channel under Pharmacy lamp (light 0.85)
    const started = ledger.start({ kind: "run", actor: "p1", rule: "study:trauma" }, { light: 0.85 })
    expect(started.ok).toBe(true)
    expect(ledger.channels.get("p1")?.duration).toBe(4.0)

    // Step 2.0s -> in progress; step another 2.0s -> completed
    ledger.step(2.0, { light: 0.85 })
    expect(ledger.has("p2", "perk:fast-triage")).toBe(false)
    ledger.step(2.0, { light: 0.85 })

    // Manual consumed; both survivors get Fast Triage (healTime 2.0s -> 1.1s) and Adrenaline Syringe recipe
    expect(ledger.count("p1", "manual:trauma")).toBe(0)
    expect(ledger.has("p2", "proto:syringe")).toBe(true)
    expect(ledger.has("p2", "perk:fast-triage")).toBe(true)
    expect(ledger.stat("p2", "healTime", 2.0)).toBe(1.1)
  })

  test("6. skill XP by doing (Direction 2): night threat scales XP and auto-unlocks Rank II stat modifiers", () => {
    const ledger = createOutbreakLedger()
    addOutbreakSurvivor(ledger, "p1")

    // Baseline vault noise is 14.0m
    expect(ledger.stat("p1", "vaultNoise", 14.0)).toBe(14.0)
    expect(ledger.stat("p1", "acousticPeek", 0)).toBe(0)

    // Vaulting during Noir Night (threat 1.0 -> 2.0x XP): 30 base XP grants 60 XP (crosses Rank I at 50)
    ledger.apply(
      { kind: "grant", actor: "p1", store: "p1/skills", item: "xp:stealth", count: 30, scaleWithNight: true },
      { threat: 1.0 },
    )
    expect(ledger.count("p1/skills", "xp:stealth")).toBe(60)
    expect(ledger.has("p1", "rank:stealth:1")).toBe(true)
    expect(ledger.has("p1", "rank:stealth:2")).toBe(false)

    // Second night action (+25 base -> +50 XP = 110 XP) crosses Rank II (100 XP)
    ledger.apply(
      { kind: "grant", actor: "p1", store: "p1/skills", item: "xp:stealth", count: 25, scaleWithNight: true },
      { threat: 1.0 },
    )
    expect(ledger.has("p1", "rank:stealth:2")).toBe(true)
    expect(ledger.stat("p1", "vaultNoise", 14.0)).toBe(8.4)
    expect(ledger.stat("p1", "acousticPeek", 0)).toBe(1)
  })

  test("7. run-end meta unlock & 4-rack Supply Locker (Direction 3): 1 rack per player and 100% shared sample banking", () => {
    const ledger = createOutbreakLedger([
      {
        id: "locker:ash",
        mode: "slots",
        scope: "shared",
        size: 3,
        claimLimit: 1,
        initial: [
          { item: "rack:shotgun", count: 1 },
          { item: "rack:nailgun", count: 1 },
          { item: "rack:trauma", count: 1 },
        ],
      },
      { id: "profile:p1", mode: "counters", scope: "persistent", owner: "p1", accepts: ["sample", "upgrade"] },
      { id: "profile:p2", mode: "counters", scope: "persistent", owner: "p2", accepts: ["sample", "upgrade"] },
    ])
    addOutbreakSurvivor(ledger, "p1")
    addOutbreakSurvivor(ledger, "p2")

    // Dusk Supply Locker: p1 claims Rack 0 (Pump Shotgun + 12 Shells)
    expect(ledger.apply({ kind: "take", actor: "p1", from: "locker:ash", slot: 0 }).ok).toBe(true)
    expect(ledger.count("p1/hotbar", "shotgun")).toBe(1)
    expect(ledger.count("p1/belt", "shells")).toBe(12)

    // p1 cannot greedy-claim a second rack; p2 can claim Rack 2
    expect(ledger.apply({ kind: "take", actor: "p1", from: "locker:ash", slot: 1 }).reason).toBe("claim_limit")
    expect(ledger.apply({ kind: "take", actor: "p2", from: "locker:ash", slot: 2 }).ok).toBe(true)
    expect(ledger.count("p2/hotbar", "medkit")).toBe(2)

    // Collect 65 Research Samples into team/bag during the run, then bank at Dawn to both player profiles
    ledger.apply({ kind: "grant", actor: "p1", store: "team/bag", item: "sample", count: 65 })
    expect(
      ledger.apply({ kind: "bank", actor: "p1", from: "team/bag", to: ["profile:p1", "profile:p2"], item: "sample" }).ok,
    ).toBe(true)
    expect(ledger.count("team/bag", "sample")).toBe(0)
    expect(ledger.count("profile:p1", "sample")).toBe(65)
    expect(ledger.count("profile:p2", "sample")).toBe(65)

    // Spend 60 samples at the Safehouse Terminal to unlock Backup Battery Bank
    const meta = ledger.apply({ kind: "run", actor: "p1", rule: "meta:battery-bank", station: "profile:p1" })
    expect(meta.ok).toBe(true)
    expect(ledger.count("profile:p1", "sample")).toBe(5)
    expect(ledger.count("profile:p1", "upgrade:battery-bank")).toBe(1)
    expect(ledger.stat("p1", "safehouseLampHours", 0, ["profile:p1"])).toBe(3)
  })

  test("8. barricade & deterministic co-op replay: server and client converge on identical state and HUD events", () => {
    const server = createOutbreakLedger([
      {
        id: "loot:hardware-1",
        mode: "slots",
        size: 2,
        revealed: false,
        initial: [
          { item: "plank", count: 3 },
          { item: "scrap", count: 4 },
        ],
      },
    ])
    const client = createOutbreakLedger([
      {
        id: "loot:hardware-1",
        mode: "slots",
        size: 2,
        revealed: false,
        initial: [
          { item: "plank", count: 3 },
          { item: "scrap", count: 4 },
        ],
      },
    ])
    addOutbreakSurvivor(server, "p1")
    addOutbreakSurvivor(server, "p2")
    addOutbreakSurvivor(client, "p1")
    addOutbreakSurvivor(client, "p2")

    const serverEvents: LedgerEvent[] = []
    const clientEvents: LedgerEvent[] = []
    server.on((ev) => serverEvents.push(ev))
    client.on((ev) => clientEvents.push(ev))

    const log: { tx: Tx; light: number; threat: number }[] = [
      { tx: { kind: "reveal", actor: "p1", store: "loot:hardware-1", mode: "quiet" }, light: 0.9, threat: 0.2 },
      { tx: { kind: "take", actor: "p1", from: "loot:hardware-1" }, light: 0.9, threat: 0.2 },
      { tx: { kind: "run", actor: "p1", rule: "barricade", target: "portal:win-1" }, light: 0.8, threat: 0.3 },
      { tx: { kind: "run", actor: "p1", rule: "barricade", target: "portal:win-1" }, light: 0.8, threat: 0.3 },
      { tx: { kind: "run", actor: "p1", rule: "barricade", target: "portal:win-1" }, light: 0.8, threat: 0.3 },
      // 4th plank on a 3/3 window must fail with "full" and preserve p1's remaining 2 planks
      { tx: { kind: "run", actor: "p1", rule: "barricade", target: "portal:win-1" }, light: 0.8, threat: 0.3 },
      { tx: { kind: "drop", actor: "p1", items: { plank: 2 }, at: { x: 30, y: 40 } }, light: 0.6, threat: 0.5 },
      { tx: { kind: "take", actor: "p2", from: "drop:1" }, light: 0.6, threat: 0.5 },
    ]

    for (const step of log) {
      server.apply(step.tx, { light: step.light, threat: step.threat })
      client.apply(step.tx, { light: step.light, threat: step.threat })
    }

    expect(server.count("portal:win-1", "plank")).toBe(3)
    expect(server.count("p1/belt", "plank")).toBe(0)
    expect(server.count("p2/belt", "plank")).toBe(4)
    expect(server.snapshot()).toEqual(client.snapshot())
    expect(serverEvents).toEqual(clientEvents)

    // Verify incremental delta sync onto a fresh joiner
    const joiner = createOutbreakLedger()
    addOutbreakSurvivor(joiner, "p1")
    addOutbreakSurvivor(joiner, "p2")
    const delta = server.diff(0)!
    joiner.applyDelta(delta)
    expect(joiner.snapshot()).toEqual(server.snapshot())
  })
})
