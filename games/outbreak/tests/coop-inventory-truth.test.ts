import { afterEach, describe, expect, test } from "bun:test"
import { DEFAULT_DEATH_TUNING } from "../shared/death/rules"
import { forceLife } from "../shared/death/runtime"
import { inventoryView } from "../shared/inventory"
import { featureRoom } from "./coop-feature-room"

// Playtest (Oct 20): "Oh, I have a machete now? Where did I get that from?" / "Wait, I got bullets now? Nothing is
// matching up to anything." / "Says I have zero bullets." Every check compares what a client shows with the room.
let room: ReturnType<typeof featureRoom> | undefined
afterEach(() => room?.close())

function agree(r: ReturnType<typeof featureRoom>, who: (typeof r.clients)[number]): void {
  r.flush()
  const server = r.core.sim.slot(who.id)!.survivor
  const shown = who.view.player
  expect({ mag: shown.magAmmo, reserve: shown.reserveAmmo, held: shown.equippedItem }).toEqual({
    mag: server.magAmmo,
    reserve: server.reserveAmmo,
    held: server.equippedItem,
  })
  const kinds = (v: ReturnType<typeof inventoryView>) => v.slots.map((s) => s?.kind ?? null)
  expect(kinds(who.view.inventory)).toEqual(kinds(inventoryView(r.core.sim.progression, who.id)))
  expect(who.view.inventory.selectedSlot).toBe(inventoryView(r.core.sim.progression, who.id).selectedSlot)
  expect(who.sim.progression.ledger.count(`${who.id}/belt`, "ammo")).toBe(r.core.sim.progression.ledger.count(`${who.id}/belt`, "ammo"))
}

describe("co-op inventory truth", () => {
  test("shots, a dry magazine, a reload and picked-up rounds read the same on the client as in the room", () => {
    room = featureRoom()
    const { b, act, tick } = room
    agree(room, b)
    for (let i = 0; i < 8; i++) {
      act(b, { fire: true })
      tick(14)
    }
    agree(room, b)
    expect(b.view.player.magAmmo).toBe(0)
    act(b, { reload: true })
    tick(150)
    agree(room, b)
    expect(b.view.player.magAmmo).toBeGreaterThan(0)
  })

  test("rounds handed over by a teammate land on the receiver's belt on every screen", () => {
    room = featureRoom()
    const { core, a, b, act, tick, place } = room
    place(a, 40, 50, 0)
    place(b, 41, 50, Math.PI)
    act(a, { bundle: true })
    tick(12)
    agree(room, a)
    agree(room, b)
    expect(core.sim.progression.ledger.count(`${b.id}/belt`, "ammo")).toBe(12)
  })

  test("a fallen teammate's kit only moves on a completed hold, and the second pistol stays on the body", () => {
    room = featureRoom()
    const { core, a, b, act, tick, place, hold } = room
    hold(b, "machete")
    place(a, 27.7, 42, 0)
    place(b, 28.5, 42, Math.PI)
    forceLife(core.sim, core.sim.slot(b.id)!, "dead", DEFAULT_DEATH_TUNING)
    tick(120)
    // A tap of E on the body (trying to "bring him back") takes nothing.
    act(a, { interact: true })
    tick(12)
    agree(room, a)
    expect(core.sim.progression.ledger.count(a.id, "machete")).toBe(0)
    // Holding E takes the kit; a's own pistol means b's stays on the body.
    for (let i = 0; i < 40; i++) act(a, { interact: i === 0, interactHeld: true })
    tick(12)
    agree(room, a)
    expect(core.sim.progression.ledger.count(a.id, "machete")).toBe(1)
    expect(core.sim.progression.ledger.count(a.id, "pistol")).toBe(1)
    expect(a.view.inventory.slots.filter((s) => s?.kind === "pistol")).toHaveLength(1)
  })
})
