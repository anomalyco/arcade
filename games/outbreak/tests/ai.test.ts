import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { BARRICADE_DURATION, PISTOL_RELOAD_TIME, SEARCH_DURATION } from "../shared/combat"
import { ITEM_CATALOG } from "../shared/inventory"
import { sightRects } from "../shared/map"
import { LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import { Vision } from "../shared/vision"
import { ZombieCrowdRenderer, agentZombieProfile } from "../src/zombies"
import { zombieTuning } from "../src/zombie-profile"

describe("Outbreak AI & survival combat integration", () => {
  test("spawns deterministic wandering zombies and emits noise on door/window/sprint actions", () => {
    const a = new LocalSession(7)
    const b = new LocalSession(7)
    expect(a.view.zombies.length).toBeGreaterThan(20)
    expect(a.view.zombies.map((z) => ({ id: z.id, x: z.x, y: z.y, state: z.state }))).toEqual(
      b.view.zombies.map((z) => ({ id: z.id, x: z.x, y: z.y, state: z.state })),
    )

    // Sprint to emit sprint noise on the bus and attract nearby zombies
    const p = a.view.player
    Object.assign(p, { x: 32, y: 43.2, vx: 0, vy: 0, aim: 0 })
    const nearby = a.ai.spawnZombie(a.view.town, 37.5, 43.2, "wander", Math.PI)
    for (let i = 0; i < 45; i++) {
      a.update(TICK_DT, { mx: 1, my: 0, aim: 0, interact: false, sprint: true }, 0)
    }
    expect(a.view.noises.some((n) => n.kind === "sprint")).toBe(true)
    expect(nearby.awareness).toBeGreaterThan(0.3)
    expect(["investigate", "alert", "chase"]).toContain(nearby.state)
  })

  test("chasing zombie bashes closed door until it opens and paths through", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0, bashInterval: 0.25, aggression: 1.5 })
    const p = session.view.player
    const frontDoor = session.view.town.doors.find((d) => d.id === "ash-front")!
    expect(frontDoor.open).toBe(false)

    // Place survivor inside Ash house and chasing zombie just outside the closed front door
    Object.assign(p, { x: 27.7, y: 33.2, vx: 0, vy: 0, aim: Math.PI / 2 })
    const z = session.ai.spawnZombie(session.view.town, 27.7, 36.1, "chase", -Math.PI / 2)
    z.targetX = p.x
    z.targetY = p.y

    for (let i = 0; i < 120; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
      if (frontDoor.open) break
    }
    expect(frontDoor.open).toBe(true)
  })

  test("dynamic zombie profile increases reach and lurch when chasing", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 1 })
    const z = session.view.zombies[0]!
    z.state = "wander"
    z.vx = 0.5
    const wanderProfile = agentZombieProfile(z, zombieTuning)

    z.state = "chase"
    z.vx = 2.6
    const chaseProfile = agentZombieProfile(z, zombieTuning)

    expect(chaseProfile.armReach).toBeGreaterThan(wanderProfile.armReach)
    expect(chaseProfile.torsoLean).toBeGreaterThan(wanderProfile.torsoLean)
    expect(chaseProfile.footDrag).toBeLessThan(wanderProfile.footDrag)
  })

  test("pistol firing consumes ammo, syncs with inventory ITEM_CATALOG, emits loud gunshot noise, staggers/kills zombie, and reloads with R", () => {
    expect(ITEM_CATALOG.pistol.shortLabel).toBe("9MM")
    expect(ITEM_CATALOG.ammo.stackable).toBe(true)

    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const p = session.view.player
    Object.assign(p, { x: 30, y: 44, vx: 0, vy: 0, aim: 0, magAmmo: 2, reserveAmmo: 6 })
    const target = session.ai.spawnZombie(session.view.town, 34, 44, "wander", Math.PI)
    const distant = session.ai.spawnZombie(session.view.town, 54, 44, "wander", Math.PI)

    // Shot 1: hits and staggers target, populates pistol & ammo in hotbar inventory, emits gunshot noise
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, fire: true }, 0)
    expect(p.magAmmo).toBe(1)
    expect(session.view.inventory.slots.some((s) => s?.kind === "pistol")).toBe(true)
    expect(session.view.inventory.slots.find((s) => s?.kind === "ammo")?.count).toBe(6)
    expect(target.hp).toBeLessThan(100)
    expect(target.state).toBe("stagger")
    expect(session.view.noises.some((n) => n.kind === "gunshot" && n.radius >= 30)).toBe(true)

    // Step through fire cooldown so distant zombie processes gunshot and we can fire shot 2
    for (let i = 0; i < 18; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    }
    expect(distant.awareness).toBeGreaterThan(0.3)

    // Shot 2: kills target and selects a detachable limb
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, fire: true }, 0)
    expect(p.magAmmo).toBe(0)
    expect(target.state).toBe("dead")
    expect(session.view.shots.at(-1)?.killed).toBe(true)
    expect(session.view.shots.at(-1)?.detachBone).not.toBeNull()

    // Reload with R: refills magazine from reserveAmmo after PISTOL_RELOAD_TIME
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, reload: true }, 0)
    expect(p.reloadRemaining).toBeGreaterThan(1.0)
    const reloadSteps = Math.ceil((PISTOL_RELOAD_TIME + 0.05) / TICK_DT)
    for (let i = 0; i < reloadSteps; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false }, 0)
    }
    expect(p.reloadRemaining).toBe(0)
    expect(p.magAmmo).toBe(6)
    expect(p.reserveAmmo).toBe(0)
  })

  test("scavenging house containers yields ammo/planks and melee shove pushes zombies back", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const p = session.view.player
    const container = session.view.containers.find((c) => c.ammo > 0 || c.planks > 0)!
    expect(container).toBeDefined()

    // Stand right beside the container inside the room
    Object.assign(p, { x: container.x, y: container.y + 0.75, vx: 0, vy: 0, aim: -Math.PI / 2, reserveAmmo: 0, planks: 0 })
    session.rebuildCollision()

    session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: true }, 0)
    expect(p.channel?.kind).toBe("search")
    const searchSteps = Math.ceil((SEARCH_DURATION + 0.05) / TICK_DT)
    for (let i = 0; i < searchSteps; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: -Math.PI / 2, interact: false }, 0)
    }
    expect(container.searched).toBe(true)
    expect(p.reserveAmmo + p.planks).toBeGreaterThan(0)

    // Melee shove knocks a close zombie back into stagger
    Object.assign(p, { x: 44, y: 44, aim: 0 })
    const z = session.ai.spawnZombie(session.view.town, 45.1, 44, "chase", Math.PI)
    session.update(TICK_DT, { mx: 0, my: 0, aim: 0, interact: false, melee: true }, 0)
    expect(z.state).toBe("stagger")
    expect(z.staggerVx).toBeGreaterThan(4)
  })

  test("plank barricades board up doors/windows and zombies bash planks down over time", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0, bashInterval: 0.2, aggression: 1.8 })
    const p = session.view.player
    const frontDoor = session.view.town.doors.find((d) => d.id === "ash-front")!

    // Stand inside Ash front door and build 1 plank barricade
    Object.assign(p, { x: 27.7, y: 34.4, vx: 0, vy: 0, aim: Math.PI / 2, planks: 2 })
    session.rebuildCollision()
    session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false, barricade: true }, 0)
    expect(p.channel?.kind).toBe("barricade")

    const buildSteps = Math.ceil((BARRICADE_DURATION + 0.05) / TICK_DT)
    for (let i = 0; i < buildSteps; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
    }
    expect(session.ai.getBarricadePlanks(frontDoor.id)).toBe(1)
    expect(p.planks).toBe(1)

    // Barricaded door cannot be opened normally with E
    session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: true }, 0)
    expect(frontDoor.open).toBe(false)

    // Spawn chasing zombie outside to bash down the plank and then the door
    const z = session.ai.spawnZombie(session.view.town, 27.7, 36.1, "chase", -Math.PI / 2)
    z.targetX = p.x
    z.targetY = p.y
    for (let i = 0; i < 160; i++) {
      session.update(TICK_DT, { mx: 0, my: 0, aim: Math.PI / 2, interact: false }, 0)
      if (session.ai.getBarricadePlanks(frontDoor.id) === 0) break
    }
    expect(session.ai.getBarricadePlanks(frontDoor.id)).toBe(0)
  })

  test("ZombieCrowdRenderer SoA draws all 500 zombies without 128-zombie limb cutoff and supports limb detachment", () => {
    const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
    const town = session.view.town
    for (let i = 0; i < 500; i++) {
      session.ai.spawnZombie(town, 10 + (i * 7) % 76, 10 + (i * 13) % 76, "chase")
    }
    const crowd = new ZombieCrowdRenderer({ addModel: () => 0 })
    const vision = new Vision()
    vision.update(48, 48, 0, sightRects(town), { range: 96, cone: 360, awareness: 96 })
    const batches = crowd.draw(
      session.view.zombies,
      TICK_DT,
      (x, z) => supportHeight(town, x, z),
      vision,
      [0, 0, 96, 96],
      zombieTuning,
      true,
    )
    expect(batches.map((b) => b.count)).toEqual([500, 500, 500, 1000, 1000, 1000, 1000, 1000])

    const first = session.view.zombies[0]!
    const stateBefore = crowd.getAgentBones(first.id)
    expect(stateBefore?.bones.pelvis).toBeDefined()
    expect(stateBefore?.bones["left.upperArm"]).toBeDefined()

    const detached = crowd.detachAgentLimb(first, "left.upperArm", TICK_DT, [1, 0.5, 0])
    expect(detached.length).toBe(2)
    expect(crowd.debris.length).toBe(2)

    const batchesAfter = crowd.draw(
      session.view.zombies,
      TICK_DT,
      (x, z) => supportHeight(town, x, z),
      vision,
      [0, 0, 96, 96],
      zombieTuning,
      true,
    )
    // 500 zombies minus 1 detached upperArm/foreArm + 1 debris piece each = 1000
    expect(batchesAfter.map((b) => b.count)).toEqual([500, 500, 500, 1000, 1000, 1000, 1000, 1000])
  })
})
