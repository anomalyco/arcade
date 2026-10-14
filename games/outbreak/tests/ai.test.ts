import { describe, expect, test } from "bun:test"
import { TICK_DT } from "../shared/clock"
import { LocalSession } from "../shared/session"
import { agentZombieProfile } from "../src/zombies"
import { zombieTuning } from "../src/zombie-profile"

describe("Outbreak AI integration", () => {
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
})
