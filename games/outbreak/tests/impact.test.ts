import { describe, expect, test } from "bun:test"
import { Camera, HitStop } from "@arcade/kit/client/camera"
import { TICK_DT } from "../shared/clock"
import type { CombatMeleeEvent } from "../shared/combat"
import { sightRects } from "../shared/map"
import { DEFAULT_FIRE_TUNING } from "../shared/fire/fire"
import { throwDynamite } from "../shared/fire/runtime"
import { LocalSession } from "../shared/session"
import { supportHeight } from "../shared/terrain"
import { Vision } from "../shared/vision"
import type { OutbreakFeelFrameContext } from "../src/feel-events"
import { ImpactBodies } from "../src/impact/bodies"
import { blastBlow, meleeBlow, shotBlow, weaponWeight } from "../src/impact/causes"
import { ImpactEvents } from "../src/impact/events"
import { createOutbreakSettings, type OutbreakSettings } from "../src/settings"
import { zombieTuning } from "../src/zombie-profile"
import { ZombieCrowdRenderer } from "../src/zombies"

const idle = { mx: 0, my: 0, aim: 0, interact: false }

/** One client: the shared session it watches, its own zombie renderer, body physics and event watcher. */
function client(session: LocalSession, settings: OutbreakSettings) {
  const crowd = new ZombieCrowdRenderer({ addModel: () => 0 })
  const bodies = new ImpactBodies()
  const events = new ImpactEvents(bodies)
  const cam = new Camera()
  const tracker = { hitStop: new HitStop() }
  const vision = new Vision()
  const town = session.view.town
  events.reset(session.view.player)
  const frame = () => {
    events.process({ session, settings, zombieCrowd: crowd, tracker, cam, addCount: 0, dt: TICK_DT } as unknown as OutbreakFeelFrameContext)
    vision.update(session.view.player.x, session.view.player.y, 0, sightRects(town), { range: 96, cone: 360, awareness: 96 })
    crowd.draw(session.view.zombies, TICK_DT, (x, z) => supportHeight(town, x, z), vision, [0, 0, 96, 96], zombieTuning, false, session.view.time)
  }
  return { crowd, bodies, events, cam, tracker, frame }
}

function fight(style: number) {
  const settings = createOutbreakSettings(new URLSearchParams())
  settings.impact.impactStyle = style
  const session = new LocalSession(7, 7, 0.22, { zombieCount: 0 })
  const town = session.view.town
  Object.assign(session.view.player, { x: 40, y: 44, vx: 0, vy: 0, aim: 0, magAmmo: 8 })
  const z = session.ai.spawnZombie(town, 45, 44, "wander", Math.PI)
  z.hp = 40
  return { settings, session, z }
}

describe("impact settings", () => {
  test("weapons land by weight: knife light, crowbar the reference, fire axe heavy", () => {
    expect(weaponWeight("knife")).toBeLessThan(0.65)
    expect(weaponWeight("crowbar")).toBeCloseTo(1, 5)
    expect(weaponWeight("fire-axe")).toBeGreaterThan(1.3)
    expect(weaponWeight("bat")).toBeGreaterThan(weaponWeight("hammer"))
  })
})

describe("blows", () => {
  test("are a pure function of the replicated event and push the way it travelled", () => {
    const shot = { id: 3, time: 1, fromX: 40, fromY: 44, toX: 45, toY: 44, aim: 0.3, hitZombieId: 9, killed: true, detachBone: null, seed: 1234 }
    expect(shotBlow(shot)).toEqual(shotBlow({ ...shot }))
    expect(shotBlow(shot).dead.dirX).toBeCloseTo(Math.cos(0.3))
    expect(shotBlow({ ...shot, detachBone: "head" }).living.head).toBe(1)
    const swing: CombatMeleeEvent = { id: 1, time: 1, attackerId: "a", attackerIndex: 0, weapon: "fire-axe", x: 44, y: 44, aim: 0, arc: 2, reach: 2, combo: 1, heavy: true, charge: 1, hits: [], hitDoorId: null, doorBroke: false, weaponBroke: false, durabilityLow: false, seed: 5 }
    const hit = { zombieId: 2, x: 45, y: 44, damage: 80, killed: true, knockdown: false, headshot: false, detachBone: null, seed: 1 }
    const axe = meleeBlow(swing, hit, 45.5, 44)
    const knife = meleeBlow({ ...swing, weapon: "knife", heavy: false, charge: 0 }, hit, 45.5, 44)
    expect(axe.dead.push).toBeGreaterThan(knife.dead.push * 1.5)
    expect(axe.living.strength).toBeGreaterThan(knife.living.strength)
    expect(blastBlow(1, 0, 1, 4, 0).dead.lift!).toBeGreaterThan(blastBlow(1, 0, 0.2, 4, 0).dead.lift!)
  })
})

describe("feel per event", () => {
  test("a bullet that hits without killing holds 14 ms; Today adds nothing", () => {
    for (const style of [1, 0]) {
      const { settings, session } = fight(style)
      settings.impact.impactShotHitStop = 14
      const c = client(session, settings)
      c.frame()
      session.view.zombies[0]!.hp = 400
      session.update(TICK_DT, { ...idle, fire: true }, 0, settings)
      expect(session.view.shots.at(-1)!.hitZombieId).not.toBeNull()
      c.frame()
      expect(c.tracker.hitStop.remaining).toBeCloseTo(style ? 0.014 : 0, 4)
      expect(c.bodies.reactions.size).toBe(style ? 1 : 0)
    }
  })

  test("a blast kicks the camera away from it with a hit-stop that falls off with distance", () => {
    const { settings, session } = fight(1)
    const c = client(session, settings)
    const view = session.view
    const ledger = view.progression.ledger
    const st = ledger.store("dyn:0") ?? ledger.createStore({ id: "dyn:0", mode: "slots", scope: "shared", size: 0 })
    st.at = { x: 44, y: 44 }
    st.counts = { t: 10, boom: Math.round(view.time * 10), done: 1 }
    c.frame()
    expect(c.tracker.hitStop.remaining).toBeGreaterThan(0.02)
    expect(c.cam.trauma).toBeGreaterThan(0.05)
    expect(c.events.stats.blasts).toBe(1)
    // The same blast is felt once.
    const before = c.events.stats.blasts
    c.frame()
    expect(c.events.stats.blasts).toBe(before)
  })
})

describe("ragdoll deaths", () => {
  test("a pistol kill falls as a ragdoll from the pose it died in, along the shot, and settles low and asleep", () => {
    const { settings, session, z } = fight(1)
    const c = client(session, settings)
    for (let i = 0; i < 4; i++) c.frame()
    const standing = c.crowd.getAgentBones(z.id)!.bones.pelvis!.p
    session.update(TICK_DT, { ...idle, fire: true }, 0, settings)
    expect(session.view.shots.at(-1)!.killed).toBe(true)
    c.frame()
    expect(c.bodies.stats.spawned).toBe(1)
    // The first ragdoll frame is the last living pose: no pop.
    const first = c.crowd.getAgentBones(z.id)!.bones.pelvis!.p
    expect(Math.hypot(first[0] - standing[0], first[1] - standing[1], first[2] - standing[2])).toBeLessThan(0.12)
    for (let i = 0; i < 300; i++) {
      session.update(TICK_DT, idle, 0, settings)
      c.frame()
    }
    const lying = c.crowd.getAgentBones(z.id)!.bones.pelvis!.p
    expect(lying[1]).toBeLessThan(supportHeight(session.view.town, lying[0], lying[2]) + 0.3)
    expect(lying[0] - standing[0]).toBeGreaterThan(0.2)
    expect(c.bodies.stats.awake).toBe(0)
  })

  test("Today keeps the canned collapse at the sim spot", () => {
    const { settings, session, z } = fight(0)
    const c = client(session, settings)
    for (let i = 0; i < 4; i++) c.frame()
    session.update(TICK_DT, { ...idle, fire: true }, 0, settings)
    for (let i = 0; i < 60; i++) {
      session.update(TICK_DT, idle, 0, settings)
      c.frame()
    }
    expect(c.bodies.stats.spawned).toBe(0)
    const pelvis = c.crowd.getAgentBones(z.id)!.bones.pelvis!.p
    expect(Math.hypot(pelvis[0] - z.x, pelvis[2] - z.y)).toBeLessThan(0.05)
  })

  test("a death we never saw standing keeps the canned collapse instead of starting from a stale pose", () => {
    const { settings, session, z } = fight(1)
    const c = client(session, settings)
    z.state = "dead"
    for (let i = 0; i < 10; i++) c.frame()
    expect(c.bodies.stats.spawned).toBe(0)
    expect(c.bodies.stats.canned).toBe(1)
  })

  test("two clients watching the same fight drop the body the same way (co-op)", () => {
    const run = () => {
      const { settings, session, z } = fight(1)
      const c = client(session, settings)
      for (let i = 0; i < 4; i++) c.frame()
      session.update(TICK_DT, { ...idle, fire: true }, 0, settings)
      for (let i = 0; i < 120; i++) {
        session.update(TICK_DT, idle, 0, settings)
        c.frame()
      }
      return Array.from(Object.values(c.crowd.getAgentBones(z.id)!.bones).flatMap((f) => [...f!.p]))
    }
    expect(run()).toEqual(run())
  })

  test("body physics never touches the simulation", () => {
    const hash = (style: number) => {
      const { settings, session } = fight(style)
      session.ai.spawnZombie(session.view.town, 46, 45, "chase", Math.PI)
      const c = client(session, settings)
      for (let i = 0; i < 180; i++) {
        session.update(TICK_DT, { ...idle, fire: i % 20 === 5 }, 0, settings)
        c.frame()
      }
      return JSON.stringify(session.view.zombies.map((z) => [z.id, z.x.toFixed(5), z.y.toFixed(5), z.hp, z.state]))
    }
    expect(hash(1)).toBe(hash(0))
  })

  test("a dynamite blast through the bodies leaves the simulation the same", () => {
    const hash = (style: number) => {
      const { settings, session } = fight(style)
      const town = session.view.town
      for (let i = 0; i < 8; i++) session.ai.spawnZombie(town, 48 + (i % 4) * 1.3, 43 + Math.floor(i / 4) * 1.8, "wander")
      const slot = session.sim.slots[0]!
      session.sim.progression.ledger.apply({ kind: "grant", actor: slot.id, item: "dynamite", count: 1 })
      expect(throwDynamite(session.sim, slot, { ...DEFAULT_FIRE_TUNING, dynThrow: 9 })).toBe(true)
      const c = client(session, settings)
      for (let i = 0; i < 240; i++) {
        session.update(TICK_DT, idle, 0, settings)
        c.frame()
      }
      const zs = session.view.zombies.map((z) => [z.id, z.x.toFixed(5), z.y.toFixed(5), z.hp, z.state])
      return JSON.stringify([zs, session.view.player.health])
    }
    const physical = hash(1)
    expect(physical).toContain("dead")
    expect(physical).toBe(hash(0))
  })

  test("caps how many fall at once and sleeps the oldest", () => {
    const { settings, session } = fight(1)
    settings.impact.impactMaxAwake = 3
    const town = session.view.town
    const zs = Array.from({ length: 6 }, (_, i) => session.ai.spawnZombie(town, 44 + (i % 3), 40 + i * 1.5, "wander"))
    const c = client(session, settings)
    for (let i = 0; i < 3; i++) c.frame()
    for (const z of zs) {
      z.state = "dead"
      z.hp = 0
    }
    for (let i = 0; i < 4; i++) c.frame()
    expect(c.bodies.stats.spawned).toBe(6)
    expect(c.bodies.stats.awake).toBeLessThanOrEqual(4)
  })
})
