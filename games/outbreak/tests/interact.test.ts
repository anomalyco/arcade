import { describe, expect, test } from "bun:test"
import { distToRect } from "@arcade/kit/sim/geom"
import { TICK_DT } from "../shared/clock"
import {
  FENCE_VAULT_NOISE,
  InteractionRegistry,
  VAULT_DURATION,
  VAULT_STAMINA_COST,
  createInteractActorState,
  selectInteractTarget,
  vaultLift,
} from "../shared/interact"
import { makeTown, sightRects, solidRects } from "../shared/map"
import { SceneryMemory } from "../shared/scenery-memory"
import { LocalSession } from "../shared/session"
import { VAULT_NOISE, WALK_NOISE } from "../shared/stamina"
import { DEFAULT_VISION, Vision } from "../shared/vision"

describe("contextual window, door, and fence interactions", () => {
  test("selects one target at a time, preferring proximity and using facing angle to break ties", () => {
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

    // Turn east toward the front door from the equidistant midpoint
    actor.aim = 0
    const eastTarget = selectInteractTarget(town, actor)
    expect(eastTarget?.kind).toBe("door")
    expect(eastTarget?.id).toBe("ash-front")

    // Standing right in front of the window selects the window even if mouse aim is oblique or behind
    actor.x = 24.5
    actor.y = 36.0
    for (const aim of [-Math.PI / 2, 0, Math.PI, Math.PI / 2, -0.4, 2.2]) {
      actor.aim = aim
      const target = selectInteractTarget(town, actor)
      expect(target?.kind).toBe("window")
      expect(target?.id).toBe("ash-south-west")
      expect(target?.activeAction.id).toBe("peek")
    }

    // Far from any building or fence: no prompt
    actor.x = 44
    actor.y = 44
    expect(selectInteractTarget(town, actor)).toBeUndefined()
  })

  test("walking up to any window from typical approach angles (both sides, open/closed, sprinting) and pressing E reliably peeks", () => {
    const approaches = [
      // South-west window approached straight north, diagonal NW, diagonal NE, and while holding Shift+W
      { winId: "ash-south-west", startX: 24.5, startY: 37.4, mx: 0, my: -1, aim: -Math.PI / 2, sprint: false },
      { winId: "ash-south-west", startX: 25.8, startY: 37.2, mx: -0.7, my: -1, aim: -2.1, sprint: true },
      { winId: "ash-south-west", startX: 23.2, startY: 37.2, mx: 0.7, my: -1, aim: -0.9, sprint: false },
      // South-east window approached with oblique cursor
      { winId: "ash-south-east", startX: 34.2, startY: 37.3, mx: 0, my: -1, aim: 0.3, sprint: false },
      // East window approached from east (south half -> living room, north half -> bedroom)
      { winId: "ash-east", startX: 38.4, startY: 30.1, mx: -1, my: 0, aim: Math.PI, sprint: false },
      { winId: "ash-east", startX: 38.4, startY: 28.4, mx: -1, my: 0, aim: Math.PI, sprint: true },
      // Inside the house approaching south-west window from north looking out
      { winId: "ash-south-west", startX: 24.5, startY: 33.8, mx: 0, my: 1, aim: Math.PI / 2, sprint: false },
    ]

    for (const cfg of approaches) {
      for (const initiallyOpen of [false, true]) {
        const session = new LocalSession(7)
        const p = session.view.player
        const win = session.view.town.windows.find((w) => w.id === cfg.winId)!
        win.open = initiallyOpen
        Object.assign(p, { x: cfg.startX, y: cfg.startY, vx: 0, vy: 0, aim: cfg.aim })
        session.rebuildCollision()

        // Walk/sprint up to the window over 30 ticks
        for (let i = 0; i < 30; i++) {
          session.update(TICK_DT, { mx: cfg.mx, my: cfg.my, aim: cfg.aim, interact: false, sprint: cfg.sprint }, 0)
        }
        expect(session.view.prompt?.id).toBe(cfg.winId)
        expect(session.view.prompt?.activeAction.id).toBe("peek")

        // Press E while still holding movement/sprint input: must reliably enter Peek!
        session.update(TICK_DT, { mx: cfg.mx, my: cfg.my, aim: cfg.aim, interact: true, sprint: cfg.sprint }, 0)
        expect(p.peekingWindowId).toBe(cfg.winId)
        expect(session.view.peek?.windowId).toBe(cfg.winId)
        expect(session.view.prompt?.activeAction).toEqual({ id: "peek", label: "Stop peeking" })

        // Continuing to press into the wall or strafe slightly along the sill must NOT cancel peek
        for (let i = 0; i < 12; i++) {
          session.update(TICK_DT, { mx: cfg.mx, my: cfg.my, aim: cfg.aim, interact: false, sprint: cfg.sprint }, 0)
        }
        expect(p.peekingWindowId).toBe(cfg.winId)

        // Pressing E again reliably stops peeking, and default action returns to Peek window
        session.update(TICK_DT, { mx: 0, my: 0, aim: cfg.aim, interact: true }, 0)
        expect(p.peekingWindowId).toBeNull()
        expect(session.view.peek).toBeNull()
        expect(session.view.prompt?.activeAction).toEqual({ id: "peek", label: "Peek window" })
      }
    }
  })

  test("window open/close via Q cycle and climb-through via Space or Q+E", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    Object.assign(p, { x: 24.5, y: 36.1, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()

    // Cycle with Q from Peek window -> Open window, then press E to open
    expect(session.view.prompt?.activeAction).toEqual({ id: "peek", label: "Peek window" })
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, cycle: true }, 0)
    expect(session.view.prompt?.activeAction).toEqual({ id: "toggle", label: "Open window" })

    const revBefore = session.view.revision
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    const win = session.view.town.windows.find((w) => w.id === "ash-south-west")!
    expect(win.open).toBe(true)
    expect(session.view.revision).toBe(revBefore + 1)

    // On an open window, E still defaults to Peek window, while Space climbs right through!
    expect(session.view.prompt?.activeAction).toEqual({ id: "peek", label: "Peek window" })
    const staminaBefore = p.stamina
    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false, jump: true }, 0)
    expect(p.vault).not.toBeNull()
    expect(p.stamina).toBeCloseTo(staminaBefore - VAULT_STAMINA_COST, 4)
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

  test("fence vaulting works from both sides via E or Space, costs stamina, makes noise, and lands clear of collision", () => {
    const session = new LocalSession(7)
    const p = session.view.player
    const solids = solidRects(session.view.town)

    // Stand south of north yard fence [18, 20, 39, 20.12] at (26, 20.65) facing north
    Object.assign(p, { x: 26, y: 20.65, vx: 0, vy: 0, aim: -Math.PI / 2 })
    session.rebuildCollision()
    expect(session.view.prompt?.kind).toBe("fence")
    expect(session.view.prompt?.activeAction).toEqual({ id: "climb", label: "Vault fence" })

    // Press E to vault north over the fence
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
    // Verify landing spot is completely clear of solid colliders and player can walk freely north
    for (const r of solids) {
      expect(distToRect(p.x, p.y, r)).toBeGreaterThanOrEqual(0.3)
    }
    const yLanded = p.y
    for (let i = 0; i < 10; i++) {
      session.update(TICK_DT, { mx: 0, my: -1, aim: -Math.PI / 2, interact: false }, 0)
    }
    expect(p.y).toBeLessThan(yLanded - 0.4)

    // Walk back to the fence from the north side and press Space (jump: true) to vault south back into the yard
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
    for (let i = 0; i < 24; i++) {
      session.update(TICK_DT, { mx: 0, my: 1, aim: Math.PI / 2, interact: false }, 0)
    }
    expect(p.peekingWindowId).toBeNull()
    expect(session.view.peek).toBeNull()
    vision.update(p.x, p.y, p.aim, blockers, DEFAULT_VISION, session.view.peek)
    expect(vision.visible(30, 33)).toBe(false)
    expect(vision.state(30, 33)).toBe("explored")
  })

  test("door lock/unlock via Q cycle and custom registry handlers", () => {
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

    // Custom handler registration on InteractionRegistry
    const customRegistry = new InteractionRegistry()
    let triggered = false
    customRegistry.register({
      kind: "radio",
      candidates: () => [
        {
          kind: "radio",
          id: "radio-1",
          rect: [27.5, 36.0, 27.9, 36.3],
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
