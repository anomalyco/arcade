import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import {
  InteractionRegistry,
  VAULT_DURATION,
  createInteractActorState,
  selectInteractTarget,
  vaultLift,
} from "../shared/interact"
import { makeTown, sightRects } from "../shared/map"
import { SceneryMemory } from "../shared/scenery-memory"
import { LocalSession } from "../shared/session"
import { VAULT_NOISE, WALK_NOISE } from "../shared/stamina"
import { DEFAULT_VISION, Vision } from "../shared/vision"

describe("contextual window and door interactions", () => {
  test("selects one target at a time, preferring the nearest and most-facing candidate", () => {
    const town = makeTown(7)
    const actor = {
      x: 26.25, // Midpoint between ash-south-west window [23.5..25.5] and ash-front door [27..28.4]
      y: 36.1,
      aim: Math.PI, // Facing west toward the window
      noise: 0,
      ...createInteractActorState(),
    }

    const westTarget = selectInteractTarget(town, actor)
    expect(westTarget?.kind).toBe("window")
    expect(westTarget?.id).toBe("ash-south-west")

    // Turn east toward the front door from the same spot
    actor.aim = 0
    const eastTarget = selectInteractTarget(town, actor)
    expect(eastTarget?.kind).toBe("door")
    expect(eastTarget?.id).toBe("ash-front")

    // Far from any building: no prompt
    actor.x = 44
    actor.y = 44
    expect(selectInteractTarget(town, actor)).toBeUndefined()
  })

  test("contextual E progression on an openable window: peek -> stop peek -> open -> climb through", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    // Stand outside ash-south-west window [23.5, 35.28, 25.5, 35.5]
    Object.assign(p, { x: 24.5, y: 36.1, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()

    // Initial prompt is Peek window
    expect(session.view.prompt?.id).toBe("ash-south-west")
    expect(session.view.prompt?.activeAction).toEqual({ id: "peek", label: "Peek window" })

    // 1st E press: enter Peek
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.peekingWindowId).toBe("ash-south-west")
    expect(session.view.peek?.windowId).toBe("ash-south-west")
    expect(session.view.prompt?.activeAction).toEqual({ id: "peek", label: "Stop peeking" })

    // 2nd E press: stop peeking; contextual default advances to Open window
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.peekingWindowId).toBeNull()
    expect(session.view.peek).toBeNull()
    expect(session.view.prompt?.activeAction).toEqual({ id: "toggle", label: "Open window" })

    // 3rd E press: open the window; contextual default advances to Climb through
    const revBefore = session.view.revision
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    const win = session.view.town.windows.find((w) => w.id === "ash-south-west")!
    expect(win.open).toBe(true)
    expect(session.view.revision).toBe(revBefore + 1)
    expect(session.view.prompt?.activeAction).toEqual({ id: "climb", label: "Climb through" })

    // 4th E press: climb through the open window (short vault duration, noisy)
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.vault).not.toBeNull()
    expect(p.noise).toBeGreaterThanOrEqual(VAULT_NOISE - 0.5)
    expect(p.noise).toBeGreaterThan(WALK_NOISE * 2)

    // Mid-vault has positive vertical lift over the sill
    session.update(VAULT_DURATION * 0.5, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, 0)
    expect(vaultLift(p)).toBeGreaterThan(0.4)

    // Finish vault: lands inside the living room north of the south wall (y < 35.0)
    for (let i = 0; i < 15; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, 0)
    }
    expect(p.vault).toBeNull()
    expect(p.y).toBeLessThan(35.0)
  })

  test("peeking extends LOS into the room and releases automatically when moving away", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const town = session.view.town
    const blockers = sightRects(town)
    const vision = new Vision()
    const scenery = new SceneryMemory()

    Object.assign(p, { x: 24.5, y: 36.1, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()

    // Before peeking: wide interior point (30, 33) behind the south wall is occluded
    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    expect(vision.visible(30, 33)).toBe(false)
    expect(vision.state(30, 33)).toBe("unexplored")

    // Start peeking: interior room points become visible and room scenery is discovered
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(session.view.peek).not.toBeNull()
    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    scenery.update(town, vision)
    expect(vision.visible(30, 33)).toBe(true)
    expect(vision.visible(22.8, 34.2)).toBe(true)

    // Walk away from the window: peek releases automatically and interior returns to explored shroud
    for (let i = 0; i < 20; i++) {
      session.update(TICK_DT, { mx: 0, my: 1, aim: Math.PI / 2, interact: false }, 0)
    }
    expect(p.peekingWindowId).toBeNull()
    expect(session.view.peek).toBeNull()
    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    expect(vision.visible(30, 33)).toBe(false)
    expect(vision.state(30, 33)).toBe("explored")
  })

  test("cycling actions with Q switches window and door actions, including door lock/unlock", () => {
    const session = new LocalSession(7)
    const p = session.view.player

    // At front door [27, 35.28, 28.4, 35.5]
    Object.assign(p, { x: 27.7, y: 36.2, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.id).toBe("ash-front")
    expect(session.view.prompt?.activeAction.id).toBe("toggle")

    // Cycle with Q to Lock door, then press E
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, cycle: true }, 0)
    expect(session.view.prompt?.activeAction).toEqual({ id: "lock", label: "Lock door" })
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)

    const door = session.view.town.doors.find((d) => d.id === "ash-front")!
    expect(door.locked).toBe(true)
    expect(door.open).toBe(false)
    expect(session.view.prompt?.activeAction).toEqual({ id: "lock", label: "Unlock door" })

    // Press E to unlock, then E to open
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(door.locked).toBe(false)
    expect(session.view.prompt?.activeAction).toEqual({ id: "toggle", label: "Open door" })
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(door.open).toBe(true)
  })

  test("fixed glass store window offers Peek only and custom registry handlers work", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    // Hardware store front window [54.5, 37.78, 56.5, 38] is fixed glass (openable: false)
    Object.assign(p, { x: 55.5, y: 38.6, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.id).toBe("hardware-south-west")
    expect(session.view.prompt?.actions).toEqual([{ id: "peek", label: "Peek window" }])

    // Custom handler registration on InteractionRegistry
    const customRegistry = new InteractionRegistry()
    let triggered = false
    customRegistry.register({
      kind: "radio",
      candidates: () => [
        {
          kind: "radio",
          id: "radio-1",
          rect: [55.2, 38.4, 55.8, 38.5],
          actions: [{ id: "toggle", label: "Tune radio" }],
          defaultAction: { id: "toggle", label: "Tune radio" },
        },
      ],
      execute: () => {
        triggered = true
        return { handled: true, kind: "radio", targetId: "radio-1", action: "toggle" }
      },
    })
    const target = selectInteractTarget(session.view.town, p, customRegistry)
    expect(target?.kind).toBe("radio")
    expect(target?.activeAction.label).toBe("Tune radio")
    customRegistry.get("radio")?.execute(session.view.town, p, "radio-1", "toggle")
    expect(triggered).toBe(true)
  })
})
