import { describe, expect, test } from "bun:test"
import { distToRect } from "@arcade/kit/sim/geom"
import { TICK_DT } from "../shared/clock"
import {
  FENCE_VAULT_NOISE,
  HOLD_DURATION,
  InteractionRegistry,
  VAULT_DURATION,
  VAULT_STAMINA_COST,
  createInteractActorState,
  holdProgress,
  selectInteractTarget,
  vaultLift,
} from "../shared/interact"
import { makeTown, sightRects, solidRects } from "../shared/map"
import { SceneryMemory } from "../shared/scenery-memory"
import { LocalSession } from "../shared/session"
import { VAULT_NOISE, WALK_NOISE } from "../shared/stamina"
import { DEFAULT_VISION, Vision } from "../shared/vision"

describe("simultaneous dual-action contextual interactions (E primary, F / Hold E secondary)", () => {
  test("selects one target at a time with simultaneous primary and secondary actions (no cycling)", () => {
    const town = makeTown(7)
    const actor = {
      x: 26.25, // Equidistant between ash-south-west window [23.5..25.5] and ash-front door [27..28.4]
      y: 36.1,
      aim: Math.PI, // Facing west toward the window
      noise: 0,
      ...createInteractActorState(),
    }

    const westTarget = selectInteractTarget(town, actor)
    expect(westTarget?.kind).toBe("window")
    expect(westTarget?.id).toBe("ash-south-west")
    expect(westTarget?.primary).toEqual({ id: "peek", label: "Peek" })
    expect(westTarget?.secondary).toEqual({ id: "toggle", label: "Open", hold: true })

    // Turn east toward the front door from the equidistant midpoint
    actor.aim = 0
    const eastTarget = selectInteractTarget(town, actor)
    expect(eastTarget?.kind).toBe("door")
    expect(eastTarget?.id).toBe("ash-front")
    expect(eastTarget?.primary).toEqual({ id: "toggle", label: "Open" })
    expect(eastTarget?.secondary).toEqual({ id: "lock", label: "Lock", hold: true })

    // Standing right in front of the window selects the window even if mouse aim is oblique or behind
    actor.x = 24.5
    actor.y = 36.0
    for (const aim of [-Math.PI / 2, 0, Math.PI, Math.PI / 2, -0.4, 2.2]) {
      actor.aim = aim
      const target = selectInteractTarget(town, actor)
      expect(target?.kind).toBe("window")
      expect(target?.id).toBe("ash-south-west")
      expect(target?.primary).toEqual({ id: "peek", label: "Peek" })
      expect(target?.secondary).toEqual({ id: "toggle", label: "Open", hold: true })
    }

    // Far from any building or fence: no prompt
    actor.x = 44
    actor.y = 44
    expect(selectInteractTarget(town, actor)).toBeUndefined()
  })

  test("walking up to any closed window from typical approach angles (both sides, sprinting) and pressing E reliably peeks", () => {
    const approaches = [
      { winId: "ash-south-west", startX: 24.5, startY: 37.4, mx: 0, my: -1, aim: -Math.PI / 2, sprint: false },
      { winId: "ash-south-west", startX: 25.8, startY: 37.2, mx: -0.7, my: -1, aim: -2.1, sprint: true },
      { winId: "ash-south-west", startX: 23.2, startY: 37.2, mx: 0.7, my: -1, aim: -0.9, sprint: false },
      { winId: "ash-south-east", startX: 34.2, startY: 37.3, mx: 0, my: -1, aim: 0.3, sprint: false },
      { winId: "ash-east", startX: 38.4, startY: 30.1, mx: -1, my: 0, aim: Math.PI, sprint: false },
      { winId: "ash-east", startX: 38.4, startY: 28.4, mx: -1, my: 0, aim: Math.PI, sprint: true },
      { winId: "ash-south-west", startX: 24.5, startY: 33.8, mx: 0, my: 1, aim: Math.PI / 2, sprint: false },
    ]

    for (const cfg of approaches) {
      const session = new LocalSession(7)
      const p = session.view.player
      Object.assign(p, { x: cfg.startX, y: cfg.startY, vx: 0, vy: 0, aim: cfg.aim })
      session.rebuildCollision()

      for (let i = 0; i < 30; i++) {
        session.update(TICK_DT, { mx: cfg.mx, my: cfg.my, aim: cfg.aim, interact: false, sprint: cfg.sprint }, 0)
      }
      expect(session.view.prompt?.id).toBe(cfg.winId)
      expect(session.view.prompt?.primary).toEqual({ id: "peek", label: "Peek" })
      expect(session.view.prompt?.secondary).toEqual({ id: "toggle", label: "Open", hold: true })

      // Press E while still holding movement/sprint input: must reliably enter Peek!
      session.update(TICK_DT, { mx: cfg.mx, my: cfg.my, aim: cfg.aim, interact: true, sprint: cfg.sprint }, 0)
      expect(p.peekingWindowId).toBe(cfg.winId)
      expect(session.view.peek?.windowId).toBe(cfg.winId)
      expect(session.view.prompt?.primary).toEqual({ id: "peek", label: "Stop peeking" })
      expect(session.view.prompt?.secondary).toEqual({ id: "toggle", label: "Open", hold: true })

      // Continuing to press into the wall must NOT cancel peek
      for (let i = 0; i < 12; i++) {
        session.update(TICK_DT, { mx: cfg.mx, my: cfg.my, aim: cfg.aim, interact: false, sprint: cfg.sprint }, 0)
      }
      expect(p.peekingWindowId).toBe(cfg.winId)

      // Pressing E again reliably stops peeking
      session.update(TICK_DT, { mx: 0, my: 0, aim: cfg.aim, interact: true }, 0)
      expect(p.peekingWindowId).toBeNull()
      expect(session.view.peek).toBeNull()
      expect(session.view.prompt?.primary).toEqual({ id: "peek", label: "Peek" })
    }
  })

  test("automatic window context: closed -> E Peek / Hold E Open; open -> E Climb / Hold E Close", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    Object.assign(p, { x: 24.5, y: 36.1, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()

    // Closed window: primary is Peek (E), secondary is Open (Hold E)
    expect(session.view.prompt?.primary).toEqual({ id: "peek", label: "Peek" })
    expect(session.view.prompt?.secondary).toEqual({ id: "toggle", label: "Open", hold: true })

    // Tap E to Peek
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.peekingWindowId).toBe("ash-south-west")
    expect(session.view.prompt?.primary).toEqual({ id: "peek", label: "Stop peeking" })
    expect(session.view.prompt?.secondary).toEqual({ id: "toggle", label: "Open", hold: true })

    // Hold E for HOLD_DURATION (0.38s) while peeking -> opens window and switches context to E Climb · Hold E Close!
    const revBefore = session.view.revision
    const holdTicks = Math.ceil(HOLD_DURATION / TICK_DT) + 1
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true, interactHeld: true }, 0)
    for (let i = 0; i < holdTicks; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: true }, 0)
    }
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: false }, 0)
    const win = session.view.town.windows.find((w) => w.id === "ash-south-west")!
    expect(win.open).toBe(true)
    expect(session.view.revision).toBe(revBefore + 1)
    expect(session.view.prompt?.primary).toEqual({ id: "climb", label: "Climb" })
    expect(session.view.prompt?.secondary).toEqual({ id: "toggle", label: "Close", hold: true })

    // Hold E again on open window -> closes window without climbing, context returns to E Peek · Hold E Open
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true, interactHeld: true }, 0)
    for (let i = 0; i < holdTicks; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: true }, 0)
    }
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: false }, 0)
    expect(win.open).toBe(false)
    expect(p.vault).toBeNull()
    expect(p.peekingWindowId).toBeNull()
    expect(session.view.prompt?.primary).toEqual({ id: "peek", label: "Peek" })

    // Open again via Hold E, then tap E (primary: Climb) to climb right through!
    for (let i = 0; i < holdTicks; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: i === 0, interactHeld: true }, 0)
    }
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: false }, 0)
    expect(win.open).toBe(true)
    const staminaBefore = p.stamina
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.vault).not.toBeNull()
    expect(p.stamina).toBeCloseTo(staminaBefore - VAULT_STAMINA_COST, 4)
    expect(p.noise).toBeGreaterThanOrEqual(VAULT_NOISE - 0.5)
    expect(p.noise).toBeGreaterThan(WALK_NOISE * 2)

    session.update(VAULT_DURATION * 0.5, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, 0)
    expect(vaultLift(p)).toBeGreaterThan(0.4)

    for (let i = 0; i < 15; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, 0)
    }
    expect(p.vault).toBeNull()
    expect(p.y).toBeLessThan(35.0)
  })

  test("fence vaulting works from both sides via E or Space, costs stamina, makes noise, and lands clear of collision", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const solids = solidRects(session.view.town)

    Object.assign(p, { x: 26, y: 20.65, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.kind).toBe("fence")
    expect(session.view.prompt?.primary).toEqual({ id: "climb", label: "Vault" })
    expect(session.view.prompt?.secondary).toBeUndefined()

    const stamina0 = p.stamina
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.vault).not.toBeNull()
    expect(p.stamina).toBeCloseTo(stamina0 - VAULT_STAMINA_COST, 4)
    expect(p.noise).toBeGreaterThanOrEqual(FENCE_VAULT_NOISE - 0.5)

    for (let i = 0; i < 22; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, 0)
    }
    expect(p.vault).toBeNull()
    expect(p.y).toBeLessThan(19.6)
    for (const r of solids) {
      expect(distToRect(p.x, p.y, r)).toBeGreaterThanOrEqual(0.3)
    }
    const yLanded = p.y
    for (let i = 0; i < 10; i++) {
      session.update(TICK_DT, { mx: 0, my: -1, aim: -Math.PI / 2, interact: false }, 0)
    }
    expect(p.y).toBeLessThan(yLanded - 0.4)

    // Vault back south with Space (jump: true)
    Object.assign(p, { x: 26, y: 19.45, vx: 0, vy: 0, aim: Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.kind).toBe("fence")
    session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false, jump: true }, 0)
    expect(p.vault).not.toBeNull()
    for (let i = 0; i < 22; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
    }
    expect(p.vault).toBeNull()
    expect(p.y).toBeGreaterThan(20.5)
  })

  test("peeking extends LOS into the room and releases automatically when walking away from the window", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const town = session.view.town
    const blockers = sightRects(town)
    const vision = new Vision()
    const scenery = new SceneryMemory()

    Object.assign(p, { x: 24.5, y: 36.1, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()

    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    expect(vision.visible(30, 33)).toBe(false)
    expect(vision.state(30, 33)).toBe("unexplored")

    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(session.view.peek).not.toBeNull()
    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    scenery.update(town, vision)
    expect(vision.visible(30, 33)).toBe(true)
    expect(vision.visible(22.8, 34.2)).toBe(true)

    for (let i = 0; i < 24; i++) {
      session.update(TICK_DT, { mx: 0, my: 1, aim: Math.PI / 2, interact: false }, 0)
    }
    expect(p.peekingWindowId).toBeNull()
    expect(session.view.peek).toBeNull()
    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    expect(vision.visible(30, 33)).toBe(false)
    expect(vision.state(30, 33)).toBe("explored")
  })

  test("door open/close via E and lock/unlock via Hold E", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const door = session.view.town.doors.find((d) => d.id === "ash-front")!

    Object.assign(p, { x: 27.7, y: 36.2, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.id).toBe("ash-front")
    expect(session.view.prompt?.primary).toEqual({ id: "toggle", label: "Open" })
    expect(session.view.prompt?.secondary).toEqual({ id: "lock", label: "Lock", hold: true })

    // Hold E for HOLD_DURATION (0.38s): initial press opens, holding through 0.38s closes & locks!
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true, interactHeld: true }, 0)
    expect(door.open).toBe(true)
    const holdTicks = Math.ceil(HOLD_DURATION / TICK_DT) + 1
    for (let i = 0; i < holdTicks; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: true }, 0)
      if (i === 5) expect(holdProgress(p)).toBeGreaterThan(0.1)
    }
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, interactHeld: false }, 0)
    expect(door.open).toBe(false)
    expect(door.locked).toBe(true)
    expect(session.view.prompt?.primary).toEqual({ id: "lock", label: "Unlock" })

    // Tap E to unlock, then tap E to open
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(door.locked).toBe(false)
    expect(session.view.prompt?.primary).toEqual({ id: "toggle", label: "Open" })
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(door.open).toBe(true)

    // Custom handler registration on InteractionRegistry
    const customRegistry = new InteractionRegistry()
    let triggered = false
    const tune: { id: "toggle"; label: string } = { id: "toggle", label: "Tune radio" }
    customRegistry.register({
      kind: "radio",
      candidates: () => [
        {
          kind: "radio",
          id: "radio-1",
          rect: [27.5, 36.0, 27.9, 36.3],
          worldX: 27.7,
          worldY: 36.15,
          primary: tune,
          actions: [tune],
        },
      ],
      execute: () => {
        triggered = true
        return { handled: true, kind: "radio", targetId: "radio-1", action: "toggle" }
      },
    })
    const target = selectInteractTarget(session.view.town, p, customRegistry)
    expect(target?.kind).toBe("radio")
    expect(target?.primary.label).toBe("Tune radio")
    customRegistry.get("radio")?.execute(session.view.town, p, "radio-1", "toggle")
    expect(triggered).toBe(true)
  })
})
