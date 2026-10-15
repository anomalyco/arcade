import { describe, expect, test } from "bun:test"
import { SPRITE_FLOATS } from "@arcade/kit/gpu/renderer"
import { createAIAgent } from "../shared/ai"
import { makeTown, sightRects, toggleDoor } from "../shared/map"
import { SceneryMemory } from "../shared/scenery-memory"
import { FOG_SIZE, Vision } from "../shared/vision"
import {
  CombinedFogMemory,
  DEFAULT_FOG_OF_WAR,
  ZombieMemoryTracker,
  collectFogSoundSprites,
  fogOfWarControls,
  jitteredSoundOrigin,
} from "../src/fog-of-war"

describe("Outbreak actor visibility & fog-of-war rules", () => {
  test("every FogOfWarSettings key has a corresponding Lab control with valid default", () => {
    const keys = Object.keys(DEFAULT_FOG_OF_WAR).sort()
    const controlKeys = fogOfWarControls.map((c) => String(c.key)).sort()
    expect(controlKeys).toEqual(keys)
    for (const c of fogOfWarControls) {
      const def = DEFAULT_FOG_OF_WAR[c.key as keyof typeof DEFAULT_FOG_OF_WAR]
      if ("min" in c && "max" in c) {
        expect(def).toBeGreaterThanOrEqual(c.min)
        expect(def).toBeLessThanOrEqual(c.max)
      } else if ("options" in c) {
        expect(c.options.some((o) => o.value === def)).toBe(true)
      }
    }
  })

  test("Vision.actorVisible sees actors in LOS and doorway shoulders, but never sees through solid walls or closed doors", () => {
    const town = makeTown(7)
    const v = new Vision()

    // 1. Inside south room looking North at closed bedroom door (27.7, 29.5)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    // Zombie behind closed bedroom door at (27.7, 27.5) is strictly invisible (0)
    expect(v.visible(27.7, 27.5)).toBe(false)
    expect(v.actorVisible(27.7, 27.5)).toBe(0)

    // 2. Open the bedroom door -> zombie in bedroom is now clearly visible (1)
    toggleDoor(town, 27.7, 30.2)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    expect(v.visible(27.7, 27.5)).toBe(true)
    expect(v.actorVisible(27.7, 27.5)).toBe(1)

    // 3. Zombie standing right at the doorway jamb (x = 26.92, z = 28.2) where center is slightly behind jamb
    //    but its 0.28m shoulder disk extends into the open doorway (x = 27.0..28.4)
    expect(v.actorVisible(26.92, 28.2, 0.28)).toBeGreaterThan(0.5)

    // 4. Close awareness (2.5m) sees behind the player when unoccluded, but never through a solid wall
    v.update(22.5, 30, 0, sightRects(town))
    expect(v.actorVisible(23.8, 30)).toBe(1)
    expect(v.actorVisible(21.2, 30)).toBe(0) // blocked by west exterior wall at x = 22.0
  })

  test("CombinedFogMemory merges Vision.explored and SceneryMemory.mask with 3x3 smoothing", () => {
    const town = makeTown(7)
    const v = new Vision()
    const s = new SceneryMemory()
    const comb = new CombinedFogMemory()

    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    s.update(town, v)
    expect(comb.update(v, s)).toBe(true)

    // Cell inside discovered south room (28, 32 -> cell (56, 64)) is non-zero in filtered memory
    const inRoomIdx = 64 * FOG_SIZE + 56
    expect(comb.filtered[inRoomIdx]!).toBeGreaterThan(180)

    // Distant unexplored corner (90, 90 -> cell (180, 180)) remains 0
    expect(comb.filtered[180 * FOG_SIZE + 180]).toBe(0)
  })

  test("ZombieMemoryTracker freezes last-known position on LOS exit, fades over time, and clears when spot is seen empty", () => {
    const town = makeTown(7)
    const v = new Vision()
    const tracker = new ZombieMemoryTracker()
    const agent = createAIAgent(1, 7, 27.7, 27.5, Math.PI / 2)

    // Open door and see zombie at (27.7, 27.5) at t = 1.0s
    toggleDoor(town, 27.7, 30.2)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    tracker.recordSeen(
      agent.id,
      agent.x,
      agent.y,
      agent.aim,
      {
        pelvis: { p: [agent.x, 0.9, agent.y], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
      },
      new Set(),
      1.0,
    )

    // Close door and zombie walks away unseen to (24.5, 25.5)
    toggleDoor(town, 27.7, 30.2)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    agent.x = 24.5
    agent.y = 25.5

    // At t = 2.0s (1.0s after losing sight), ghost still sits at the FROZEN (27.7, 27.5) spot, never leaking (24.5, 25.5)
    const g1 = tracker.getActiveGhost(agent, v, 2.0, 3.2)
    expect(g1).not.toBeNull()
    expect(g1!.ghost.x).toBeCloseTo(27.7, 4)
    expect(g1!.ghost.y).toBeCloseTo(27.5, 4)
    expect(g1!.alpha).toBeGreaterThan(0.2)

    // At t = 5.0s (past 3.2s duration), ghost expires
    expect(tracker.getActiveGhost(agent, v, 5.0, 3.2)).toBeNull()

    // Re-record at (27.7, 27.5) at t = 6.0s, move zombie to (24.5, 25.5), then open door so player sees (27.7, 27.5) is empty
    tracker.recordSeen(agent.id, 27.7, 27.5, agent.aim, {}, new Set(), 6.0)
    toggleDoor(town, 27.7, 30.2)
    v.update(27.7, 31, -Math.PI / 2, sightRects(town))
    expect(v.visible(27.7, 27.5)).toBe(true)
    expect(tracker.getActiveGhost(agent, v, 6.2, 3.2)).toBeNull()
  })

  test("collectFogSoundSprites emits spatially uncertain ripples for unseen zombies without revealing exact coordinates", () => {
    const town = makeTown(7)
    const v = new Vision()
    // Player at (30, 41) facing North (-PI/2)
    v.update(30, 41, -Math.PI / 2, sightRects(town))

    // Unseen chasing zombie behind player at (30, 47) and visible zombie ahead at (30, 37)
    const unseen = createAIAgent(10, 7, 30, 47, -Math.PI / 2)
    unseen.state = "chase"
    unseen.vx = 0
    unseen.vy = -2.2
    const visible = createAIAgent(11, 7, 30, 37, Math.PI / 2)
    visible.state = "chase"

    const [jx, jy] = jitteredSoundOrigin(unseen.id, unseen.x, unseen.y, 1, 1.1)
    const offset = Math.hypot(jx - unseen.x, jy - unseen.y)
    expect(offset).toBeGreaterThan(0.4)
    expect(offset).toBeLessThan(1.5)

    const sprites = new Float32Array(64 * SPRITE_FLOATS)
    // Sound ripples are an off-by-default Lab option.
    expect(collectFogSoundSprites([unseen, visible], [], { x: 30, y: 41 }, v, 1.25, () => 0, DEFAULT_FOG_OF_WAR, sprites, 0)).toBe(0)
    const count = collectFogSoundSprites(
      [unseen, visible],
      [],
      { x: 30, y: 41 },
      v,
      1.25,
      () => 0,
      { ...DEFAULT_FOG_OF_WAR, fogSoundCues: 1 },
      sprites,
      0,
    )
    expect(count).toBeGreaterThanOrEqual(1)
    // Ripple center is near unseen zombie (y > 44), never at the visible zombie (y = 37) or exact (30, 47)
    const rx = sprites[0]!
    const rz = sprites[2]!
    expect(rz).toBeGreaterThan(44)
    expect(Math.hypot(rx - unseen.x, rz - unseen.y)).toBeGreaterThan(0.3)

    // Setting fogSoundCues = 0 disables all sound ripples
    const countOff = collectFogSoundSprites(
      [unseen, visible],
      [],
      { x: 30, y: 41 },
      v,
      1.25,
      () => 0,
      { ...DEFAULT_FOG_OF_WAR, fogSoundCues: 0 },
      sprites,
      0,
    )
    expect(countOff).toBe(0)
  })
})
