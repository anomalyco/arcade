import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import {
  DEFAULT_FLASHLIGHT_TUNING,
  flashlightAwarenessAt,
  flashlightColor,
  flashlightControls,
  type FlashlightTuning,
} from "../shared/flashlight"
import { HOTBAR_SIZE } from "../shared/inventory"
import { sightRects } from "../shared/map"
import { LocalSession } from "../shared/session"
import { DEFAULT_STAMINA_TUNING } from "../shared/stamina"

describe("flashlight battery, flicker, cutout, and awareness", () => {
  test("drains while on, toggles off with F, waits for recharge delay, and regenerates while off", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    expect(p.flashlightOn).toBe(true)
    expect(p.battery).toBe(1)
    expect(p.flashlightOutput).toBe(1)

    // Run for 2.0 s with flashlight on
    for (let i = 0; i < 120; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    }
    const afterDrain = p.battery
    expect(afterDrain).toBeCloseTo(1 - DEFAULT_FLASHLIGHT_TUNING.flashlightDrain * 2, 4)
    expect(p.flashlightOutput).toBe(1)
    expect(session.view.inventory.slots[0]?.charge).toBeCloseTo(afterDrain, 4)

    // Press F (flashlight: true) to turn off
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, flashlight: true }, 0)
    expect(p.flashlightOn).toBe(false)
    expect(p.flashlightOutput).toBe(0)
    expect(p.lightSignature).toBe(0)
    expect(session.view.inventory.slots[0]?.active).toBe(false)

    // Advance 0.6 s (< 1.2 s flashlightDelay): battery does not recharge yet
    const offBattery = p.battery
    for (let i = 0; i < 36; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    }
    expect(p.battery).toBeCloseTo(offBattery, 5)

    // Advance another 65 ticks (total 1 + 36 + 65 = 102 ticks = 1.2 s delay + 0.5 s regen)
    for (let i = 0; i < 65; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    }
    expect(p.battery).toBeCloseTo(Math.min(1, offBattery + DEFAULT_FLASHLIGHT_TUNING.flashlightRegen * 0.5), 2)
  })

  test("dims and flickers below threshold, cuts out at empty, and locks out until recovered", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const tuning = {
      ...DEFAULT_STAMINA_TUNING,
      ...DEFAULT_FLASHLIGHT_TUNING,
      flashlightDrain: 0.5, // Drains in 2.0 s
      flashlightRegen: 0.5, // Recharges 0.5 / s
      flashlightDelay: 0.4,
      flashlightFlicker: 0.3,
      flashlightRecovery: 0.35,
    } satisfies typeof DEFAULT_STAMINA_TUNING & FlashlightTuning

    // Drain for 1.5 s -> battery = 0.25 (< 0.30 flicker threshold)
    for (let i = 0; i < 90; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0, tuning)
    }
    expect(p.battery).toBeCloseTo(0.25, 3)
    expect(p.flashlightOn).toBe(true)

    // Collect 20 ticks of output in the flicker region: output dims (< 0.95) and varies deterministically
    const outputs: number[] = []
    for (let i = 0; i < 20; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0, tuning)
      outputs.push(p.flashlightOutput)
    }
    expect(Math.max(...outputs)).toBeLessThan(0.95)
    expect(Math.min(...outputs)).toBeGreaterThan(0)
    expect(new Set(outputs).size).toBeGreaterThan(3)

    // Drain remaining ~0.17 s until battery hits 0 -> automatic cutout!
    for (let i = 0; i < 15; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0, tuning)
    }
    expect(p.battery).toBe(0)
    expect(p.batteryDepleted).toBe(true)
    expect(p.flashlightOn).toBe(false)
    expect(p.flashlightOutput).toBe(0)

    // Trying to toggle back on while depleted fails
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, flashlight: true }, 0, tuning)
    expect(p.flashlightOn).toBe(false)

    // Wait through cutout cooldown (0.6 s) + 0.8 s recharge -> battery >= 0.35 recovery threshold
    for (let i = 0; i < 90; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0, tuning)
    }
    expect(p.battery).toBeGreaterThanOrEqual(0.35)
    expect(p.batteryDepleted).toBe(false)

    // Now pressing F turns the flashlight back on
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, flashlight: true }, 0, tuning)
    expect(p.flashlightOn).toBe(true)
    expect(p.flashlightOutput).toBeGreaterThan(0.9)
  })

  test("zombie awareness reacts to the beam cone and respects wall occlusion", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const blockers = sightRects(session.view.town)

    // Stand on street at (44, 44) aiming east (0)
    Object.assign(p, { x: 44, y: 44, aim: 0 })
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)

    // Target 8 m ahead inside cone -> lit!
    expect(flashlightAwarenessAt(p, 52, 44, blockers)).toBeGreaterThan(0.7)
    // Target behind player -> 0
    expect(flashlightAwarenessAt(p, 36, 44, blockers)).toBe(0)
    // Target beyond range (30 m > 19 m) -> 0
    expect(flashlightAwarenessAt(p, 74, 44, blockers)).toBe(0)

    // Target behind a solid wall (Ash house west wall x = 22)
    Object.assign(p, { x: 20, y: 30, aim: 0 })
    expect(flashlightAwarenessAt(p, 25, 30, blockers)).toBe(0)

    // Turn flashlight off -> awareness drops to 0
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, flashlight: true }, 0)
    Object.assign(p, { x: 44, y: 44, aim: 0 })
    expect(flashlightAwarenessAt(p, 52, 44, blockers)).toBe(0)
  })

  test("Lab controls cover all flashlight tuning keys and colour warmth interpolates cleanly", () => {
    expect(flashlightControls.map((c) => String(c.key)).sort()).toEqual(Object.keys(DEFAULT_FLASHLIGHT_TUNING).sort())
    for (const control of flashlightControls) {
      expect(typeof control.unit).toBe("string")
    }
    const cool = flashlightColor(0)
    const warm = flashlightColor(1)
    expect(warm[0]).toBeGreaterThan(cool[0])
    expect(cool[2]).toBeGreaterThan(warm[2])
  })
})

describe("inventory 1-5 hotbar", () => {
  test("selects slots 1-5 by Digit key and cycles with the wheel", () => {
    const session = new LocalSession(7)
    const view = () => session.view.inventory

    expect(view().slots).toHaveLength(HOTBAR_SIZE)
    expect(view().selectedSlot).toBe(1)
    expect(view().slots[0]?.kind).toBe("flashlight")
    expect(view().slots[1]?.kind).toBe("pistol")

    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, hotbarSlot: 2 }, 0)
    expect(view().selectedSlot).toBe(2)
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, hotbarDelta: 3 }, 0)
    expect(view().selectedSlot).toBe(0)
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, hotbarDelta: -1 }, 0)
    expect(view().selectedSlot).toBe(4)
  })
})
