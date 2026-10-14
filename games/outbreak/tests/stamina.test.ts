import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"
import {
  DEFAULT_STAMINA_TUNING,
  IDLE_NOISE,
  SPRINT_NOISE,
  WALK_NOISE,
  staminaControls,
  type StaminaTuning,
} from "../shared/stamina"

describe("sprint and stamina", () => {
  test("sprinting travels faster than walking, drains stamina, and raises noise signature", () => {
    const walkSession = new LocalSession(7)
    const sprintSession = new LocalSession(7)
    Object.assign(walkSession.view.player, { x: 30, y: 44, vx: 0, vy: 0, aim: 0 })
    Object.assign(sprintSession.view.player, { x: 30, y: 44, vx: 0, vy: 0, aim: 0 })

    for (let i = 0; i < 60; i++) {
      walkSession.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: false }, 0)
      sprintSession.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0)
    }

    const walkDist = walkSession.view.player.x - 30
    const sprintDist = sprintSession.view.player.x - 30
    expect(walkDist).toBeCloseTo(DEFAULT_STAMINA_TUNING.walkSpeed, 4)
    expect(sprintDist).toBeCloseTo(DEFAULT_STAMINA_TUNING.sprintSpeed, 4)
    expect(sprintDist).toBeGreaterThan(walkDist * 1.5)
    expect(walkSession.view.player.stamina).toBe(1)
    expect(sprintSession.view.player.stamina).toBeCloseTo(1 - DEFAULT_STAMINA_TUNING.staminaDrain, 4)
    expect(sprintSession.view.player.sprinting).toBe(true)
    expect(sprintSession.view.player.noise).toBeCloseTo(SPRINT_NOISE, 4)
    expect(walkSession.view.player.noise).toBeCloseTo(WALK_NOISE, 4)
    expect(sprintSession.view.player.noise).toBeGreaterThan(walkSession.view.player.noise)
  })

  test("holding sprint while stationary does not drain stamina or raise sprint noise", () => {
    const session = new LocalSession(7)
    for (let i = 0; i < 60; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, sprint: true }, 0)
    }
    expect(session.view.player.stamina).toBe(1)
    expect(session.view.player.sprinting).toBe(false)
    expect(session.view.player.noise).toBeCloseTo(IDLE_NOISE, 4)
  })

  test("stamina waits for regenDelay after sprinting, then regenerates to full", () => {
    const session = new LocalSession(7)
    Object.assign(session.view.player, { x: 20, y: 44, vx: 0, vy: 0, aim: 0 })

    // Sprint for 1.0 s
    for (let i = 0; i < 60; i++) {
      session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0)
    }
    const drained = session.view.player.stamina
    expect(drained).toBeCloseTo(1 - DEFAULT_STAMINA_TUNING.staminaDrain, 4)

    // Walk for 0.5 s (< 0.9 s regenDelay): stamina stays flat
    for (let i = 0; i < 30; i++) {
      session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: false }, 0)
    }
    expect(session.view.player.stamina).toBeCloseTo(drained, 5)
    expect(session.view.player.regenCooldown).toBeGreaterThan(0.35)

    // Walk for another 1.4 s (0.4 s remaining delay + 1.0 s regen)
    for (let i = 0; i < 84; i++) {
      session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: false }, 0)
    }
    expect(session.view.player.stamina).toBeCloseTo(drained + DEFAULT_STAMINA_TUNING.staminaRegen * 1.0, 2)
  })

  test("depleting stamina latches exhausted state until stamina recovers to threshold", () => {
    const session = new LocalSession(7)
    Object.assign(session.view.player, { x: 10, y: 44, vx: 0, vy: 0, aim: 0 })
    const tuning: StaminaTuning = {
      walkSpeed: 3.4,
      sprintSpeed: 5.6,
      staminaDrain: 1.0, // Drains in 1.0 s
      staminaRegen: 0.5, // Recovers 0.5 / s
      staminaDelay: 0.5,
      staminaThreshold: 0.4,
    }

    // Sprint 1.0 s until completely depleted
    for (let i = 0; i < 60; i++) {
      session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0, tuning)
    }
    expect(session.view.player.stamina).toBe(0)
    expect(session.view.player.exhausted).toBe(true)
    expect(session.view.player.sprinting).toBe(false)

    // Keep holding sprint while moving: cannot sprint while exhausted, moves at walkSpeed
    const xExhaustedStart = session.view.player.x
    // Advance 0.5 s delay + 0.5 s regen (stamina reaches 0.25 < 0.4 threshold)
    for (let i = 0; i < 60; i++) {
      session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0, tuning)
    }
    expect(session.view.player.x - xExhaustedStart).toBeCloseTo(tuning.walkSpeed * 1.0, 3)
    expect(session.view.player.stamina).toBeCloseTo(0.25, 2)
    expect(session.view.player.exhausted).toBe(true)
    expect(session.view.player.sprinting).toBe(false)

    // Advance another 0.35 s so stamina reaches >= 0.4 threshold and clears exhaustion
    for (let i = 0; i < 21; i++) {
      session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: false }, 0, tuning)
    }
    expect(session.view.player.stamina).toBeGreaterThanOrEqual(0.4)
    expect(session.view.player.exhausted).toBe(false)

    // Now sprinting works again
    session.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0, tuning)
    expect(session.view.player.sprinting).toBe(true)
  })

  test("stamina Lab controls cover all tuning keys with explicit units", () => {
    expect(staminaControls.map((c) => String(c.key)).sort()).toEqual(Object.keys(DEFAULT_STAMINA_TUNING).sort())
    for (const control of staminaControls) {
      expect(typeof control.unit).toBe("string")
    }
  })
})
