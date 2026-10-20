import { afterEach, describe, expect, test } from "bun:test"
import { featureRoom } from "./coop-feature-room"

// Playtest (Oct 20): "I can't switch off my gun." / "I'm out of ammo and I don't have a melee." / "What's the purpose
// of switching between the light and the gun?" Checked through the real room, both peers and their predictions.
let room: ReturnType<typeof featureRoom> | undefined
afterEach(() => room?.close())

describe("co-op hands", () => {
  test("slot 1 is bare hands on every peer: the gun goes away, the button shoves, F still works", () => {
    room = featureRoom()
    const { core, a, b, act, tick, flush } = room
    const server = core.sim.slot(b.id)!.survivor
    expect(b.view.inventory.slots[0]?.kind).toBe("fists")
    expect(b.view.inventory.slots.some((s) => s?.kind === "flashlight")).toBe(false)
    expect(server.equippedItem).toBe("pistol")

    act(b, { hotbarSlot: 0 })
    tick(6)
    flush()
    expect(server.equippedItem).toBe("hands")
    expect(b.view.player.equippedItem).toBe("hands")
    expect(b.view.inventory.selectedSlot).toBe(0)
    // The teammate sees the gun put away too.
    expect(a.sim.slot(b.id)!.survivor.equippedItem).toBe("hands")

    const rounds = server.magAmmo
    const shoved = server.shoveAnim
    act(b, { fire: true })
    tick(2)
    expect(server.magAmmo).toBe(rounds)
    expect(server.shoveAnim).toBeGreaterThan(shoved)

    const lit = server.flashlightOn
    act(b, { flashlight: true })
    tick(6)
    flush()
    expect(server.flashlightOn).toBe(!lit)
    expect(b.view.player.flashlightOn).toBe(!lit)
  })

  test("an empty gun still has a melee: V shoves and the callout names it", () => {
    room = featureRoom()
    const { core, b, act, tick } = room
    const p = core.sim.progression
    const server = core.sim.slot(b.id)!.survivor
    p.ledger.apply({ kind: "setCharge", actor: b.id, item: "pistol", charge: 0 })
    p.ledger.apply({ kind: "drain", store: `${b.id}/belt`, item: "ammo", count: p.ledger.count(`${b.id}/belt`, "ammo") })
    p.project(core.sim.slot(b.id)!)
    tick(6)
    act(b, { fire: true })
    tick(3)
    expect(server.lootMessage).toContain("shove (V)")
    expect(b.view.player.lootMessage).toContain("shove (V)")
    tick(30)
    act(b, { melee: true })
    tick(3)
    expect(server.shoveAnim).toBeGreaterThan(0)
  })
})
