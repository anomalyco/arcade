import { describe, expect, test } from "bun:test"
import { CoopRoomCore } from "../server/room-core"
import { BUILD } from "../shared/build.gen"
import { TICK_DT } from "../shared/clock"
import { DEFAULT_COOP_ROOM } from "../shared/coop-config"
import { CoopSim, hashSimState, type SimState } from "../shared/coop-sim"
import { outbreakDeathSharedFeature } from "../shared/death/index"
import { deathSnapshotOf, readDeath, writeDeath } from "../shared/death/net"
import { causeText, DEFAULT_DEATH_TUNING, fallenStoreId, RESPAWN_NEVER, type DeathState } from "../shared/death/rules"
import { forceLife, lifeOf } from "../shared/death/runtime"
import { outbreakSharedFeatures } from "../shared/feature-registry"
import type { Command, SessionTuning, SurvivorSlot } from "../shared/sim-types"
import { SPAWN_POINTS } from "../shared/spawn-points"
import { ByteReader, ByteWriter } from "@arcade/kit/net/bytes"
import { spectateTarget } from "../src/death/spectate"
import { outbreakClientFeatures as features } from "../src/features"
import { NetSession } from "../src/net-session"
import { Loopback } from "./loopback"

const T = DEFAULT_DEATH_TUNING
const idle = (aim = 0): Command => ({ mx: 0, my: 0, aim, interact: false })
const quiet = () => new CoopSim(7, 7, 0.22, { zombieCount: 0, directorPacing: 0 })
const deathOf = (sim: CoopSim) => sim.getFeatureState<DeathState>("death")!

function squad(n: number): { sim: CoopSim; slots: SurvivorSlot[] } {
  const sim = quiet()
  const slots = Array.from({ length: n }, (_, i) => sim.addSurvivor(`s${i}`, i))
  return { sim, slots }
}

/** `ticks` fixed ticks: every survivor's command, then the world (timeScale 1 keeps the clock nearly still). */
function step(sim: CoopSim, ticks: number, cmd: (slot: SurvivorSlot, i: number) => Command = (s) => idle(s.survivor.aim), tuning?: SessionTuning, timeScale = 1): void {
  for (let i = 0; i < ticks; i++) {
    for (const slot of sim.slots) sim.stepSurvivor(slot, cmd(slot, i), TICK_DT, tuning)
    sim.stepWorld(TICK_DT, timeScale, tuning)
  }
}

const seconds = (s: number) => Math.ceil(s / TICK_DT)
const place = (sim: CoopSim, slot: SurvivorSlot, x: number, y: number, aim = 0) => {
  Object.assign(slot.survivor, { x, y, aim })
  sim.rebuildSolids()
}

describe("Death in the sim", () => {
  test("at 0 HP a survivor goes down instead of fighting on", () => {
    const { sim, slots } = squad(1)
    const [a] = slots
    step(sim, 2)
    expect(lifeOf(sim, a!.index)).toBe("alive")
    a!.survivor.health = 0
    step(sim, 1)
    expect(lifeOf(sim, a!.index)).toBe("down")
    const rec = deathOf(sim).records[a!.index]!
    expect(rec.bleed).toBe(T.soloBleedOut)
    expect(a!.prompt).toBeUndefined()
  })

  test("down: crawl slowly and nothing else (no shots, reloads, sprint or doors)", () => {
    const { sim, slots } = squad(1)
    const a = slots[0]!
    a.survivor.health = 0
    step(sim, 1)
    const x0 = a.survivor.x
    const y0 = a.survivor.y
    const ammo = sim.progression.pistol(a.id).loaded
    const shots = sim.combat.shots.length
    step(sim, seconds(1), () => ({ mx: 0, my: 1, aim: Math.PI / 2, interact: true, interactHeld: true, fire: true, reload: true, sprint: true, melee: true }))
    const moved = Math.hypot(a.survivor.x - x0, a.survivor.y - y0)
    expect(moved).toBeGreaterThan(T.crawlSpeed * 0.8)
    expect(moved).toBeLessThan(T.crawlSpeed * 1.2)
    expect(sim.progression.pistol(a.id).loaded).toBe(ammo)
    expect(sim.combat.shots.length).toBe(shots)
    expect(a.survivor.reloadRemaining).toBe(0)
    expect(a.survivor.shoveAnim).toBe(0)
  })

  test("a teammate holding E beside them brings them back with a little health; letting go starts over", () => {
    const { sim, slots } = squad(2)
    const [a, b] = slots as [SurvivorSlot, SurvivorSlot]
    place(sim, a, 27.7, 42, 0)
    place(sim, b, 28.6, 42, 0)
    b.survivor.health = 0
    step(sim, 1)
    expect(lifeOf(sim, b.index)).toBe("down")
    expect(a.prompt?.kind).toBe("downed")
    expect(a.prompt?.primary.id).toBe("revive")
    const hold = (s: SurvivorSlot, i: number): Command => (s === a ? { ...idle(0), interact: i === 0, interactHeld: true } : idle(0))
    step(sim, seconds(T.reviveTime / 2), hold)
    const half = deathOf(sim).records[b.index]!.revive
    expect(half).toBeGreaterThan(0.4)
    expect(half).toBeLessThan(0.6)
    step(sim, seconds(0.5))
    expect(deathOf(sim).records[b.index]!.revive).toBe(0)
    step(sim, seconds(T.reviveTime) + 2, hold)
    expect(lifeOf(sim, b.index)).toBe("alive")
    expect(b.survivor.health).toBe(T.reviveHealth)
    expect(a.prompt?.kind).not.toBe("downed")
  })

  test("bleeding out alone kills: the body keeps their kit and a solo run is over", () => {
    const { sim, slots } = squad(1)
    const a = slots[0]!
    a.survivor.health = 0
    step(sim, seconds(T.soloBleedOut) - 5)
    expect(lifeOf(sim, a.index)).toBe("down")
    step(sim, 10)
    expect(lifeOf(sim, a.index)).toBe("dead")
    const state = deathOf(sim)
    expect(state.runOver).toBe(true)
    expect(state.bodies).toHaveLength(1)
    const body = fallenStoreId(state.bodies[0]!)
    expect(sim.progression.ledger.count(body, "pistol")).toBe(1)
    expect(sim.progression.ledger.count(body, "ammo")).toBe(6)
    expect(sim.progression.ledger.count(a.id, "pistol")).toBe(0)
    expect(a.survivor.flashlightOn).toBe(false)
    expect(causeText(state.records[a.index]!)).toMatch(/^Taken by the dead on (Night|Day) 1$/)
  })

  test("in co-op the bleed-out is longer, and the dead feeding shortens it", () => {
    const { sim, slots } = squad(2)
    const b = slots[1]!
    b.survivor.health = 0
    step(sim, seconds(T.soloBleedOut + 1))
    expect(lifeOf(sim, b.index)).toBe("down")
    const before = deathOf(sim).records[b.index]!.bleed
    outbreakDeathSharedFeature.modifySurvivorDamage!(sim, b, 50, deathOf(sim), "crowd")
    step(sim, 1)
    expect(before - deathOf(sim).records[b.index]!.bleed).toBeCloseTo(TICK_DT + 50 * T.feedBleed, 3)
    step(sim, seconds(T.bleedOut))
    expect(lifeOf(sim, b.index)).toBe("dead")
    expect(deathOf(sim).runOver).toBe(false)
  })

  test("a new survivor in a reused seat leaves a distinct body without overwriting the old kit", () => {
    const { sim, slots } = squad(2)
    const old = slots[1]!
    forceLife(sim, old, "dead", T)
    const state = deathOf(sim)
    const firstId = fallenStoreId(state.bodies[0]!)
    const firstStore = sim.progression.ledger.store(firstId)!
    const firstKit = structuredClone(firstStore.slots)
    sim.removeSurvivor(old.id)
    step(sim, 1)
    expect(state.records[old.index]).toBeUndefined()

    const newcomer = sim.addSurvivor("newcomer", old.index)
    newcomer.survivor.x += 4
    forceLife(sim, newcomer, "dead", T)
    const secondId = fallenStoreId(state.bodies[1]!)
    expect(secondId).not.toBe(firstId)
    expect(sim.progression.ledger.store(firstId)).toBe(firstStore)
    expect(sim.progression.ledger.store(firstId)!.slots).toEqual(firstKit)
    expect(sim.progression.ledger.count(secondId, "pistol")).toBe(1)
    expect(state.records[newcomer.index]!.deaths).toBe(1)
  })

  test("a teammate takes what the dead carried from their body", () => {
    const { sim, slots } = squad(2)
    const [a, b] = slots as [SurvivorSlot, SurvivorSlot]
    place(sim, a, 27.7, 42, 0)
    place(sim, b, 28.5, 42, 0)
    forceLife(sim, b, "dead", T)
    step(sim, 1)
    expect(a.prompt?.kind).toBe("fallen")
    const ammo = sim.progression.ledger.count(a.id, "ammo")
    step(sim, 2, (s, i) => (s === a ? { ...idle(0), interact: i === 0 } : idle()))
    expect(sim.progression.ledger.count(a.id, "ammo")).toBe(ammo + 6)
    expect(sim.progression.contents(fallenStoreId(deathOf(sim).bodies[0]!))).toHaveLength(0)
  })

  test("the dead watch a standing teammate and wake at the safehouse with a kit at the squad's next dawn", () => {
    const { sim, slots } = squad(2)
    const [a, b] = slots as [SurvivorSlot, SurvivorSlot]
    place(sim, a, 40, 50)
    forceLife(sim, a, "dead", T)
    step(sim, 1)
    const state = deathOf(sim)
    expect(spectateTarget(state, sim.slots, a.index, null)).toBe(b.index)
    expect(spectateTarget(state, sim.slots, b.index, null)).toBeNull()
    expect(sim.ai.agents.length).toBe(0)
    // The crowd cannot see the dead.
    const dawns = state.dawns
    sim.hour = 6.4
    step(sim, 1)
    for (let i = 0; i < 400 && lifeOf(sim, a.index) === "dead"; i++) step(sim, 1, undefined, undefined, 1200)
    expect(state.dawns).toBe(dawns + 1)
    expect(lifeOf(sim, a.index)).toBe("alive")
    expect(a.survivor.health).toBe(a.survivor.maxHealth)
    expect(Math.hypot(a.survivor.x - SPAWN_POINTS[a.index]![0], a.survivor.y - SPAWN_POINTS[a.index]![1])).toBeLessThan(0.5)
    expect(sim.progression.ledger.count(a.id, "pistol")).toBe(1)
    expect(sim.progression.pistol(a.id).loaded).toBeGreaterThan(0)
  })

  test("with 'never come back' the dead stay dead through dawn", () => {
    const { sim, slots } = squad(2)
    const tuning = { death: { ...T, respawnRule: RESPAWN_NEVER } } as SessionTuning
    forceLife(sim, slots[0]!, "dead", T)
    sim.hour = 6.4
    for (let i = 0; i < 200; i++) step(sim, 1, undefined, tuning, 1200)
    expect(deathOf(sim).dawns).toBeGreaterThan(0)
    expect(lifeOf(sim, slots[0]!.index)).toBe("dead")
  })

  test("when the last one standing goes down they bleed out as if alone, and the run is over", () => {
    const { sim, slots } = squad(3)
    forceLife(sim, slots[0]!, "dead", T)
    forceLife(sim, slots[1]!, "dead", T)
    slots[2]!.survivor.health = 0
    step(sim, 1)
    expect(deathOf(sim).records[2]!.bleed).toBeLessThanOrEqual(T.soloBleedOut)
    expect(deathOf(sim).runOver).toBe(false)
    step(sim, seconds(T.soloBleedOut) + 2)
    expect(sim.slots.map((s) => lifeOf(sim, s.index))).toEqual(["dead", "dead", "dead"])
    expect(deathOf(sim).runOver).toBe(true)
  })

  test("kills count for whoever landed the last blow", () => {
    const { sim, slots } = squad(1)
    const a = slots[0]!
    const z = sim.ai.spawnZombie(sim.town, a.survivor.x + 4, a.survivor.y, "wander")
    z.state = "dead"
    z.lastHitBy = a.id
    step(sim, 1)
    expect(deathOf(sim).records[a.index]!.kills).toBe(1)
  })
})

describe("Today (deathMode 0)", () => {
  const today: SessionTuning = { death: { ...T, deathMode: 0 } } as SessionTuning
  test("health stops at 0 and the survivor walks and shoots on as before", () => {
    const { sim, slots } = squad(1)
    const a = slots[0]!
    a.survivor.health = 0
    step(sim, 2, undefined, today)
    const x0 = a.survivor.x
    const loaded = sim.progression.pistol(a.id).loaded
    step(sim, seconds(1), (_s, i) => ({ mx: 1, my: 0, aim: 0, interact: false, fire: i === 0 }), today)
    expect(lifeOf(sim, a.index)).toBe("alive")
    expect(a.survivor.x - x0).toBeGreaterThan(1.5)
    expect(sim.progression.pistol(a.id).loaded).toBe(loaded - 1)
    expect(deathOf(sim).runOver).toBe(false)
  })

  test("the world is unchanged by the death feature until somebody dies (same hashes without it)", () => {
    const run = () => {
      const sim = new CoopSim(11)
      const slot = sim.addSurvivor("player", 0)
      for (let i = 0; i < 360; i++) {
        sim.stepSurvivor(slot, { mx: Math.cos(i / 50), my: Math.sin(i / 70), aim: i / 40, interact: false, sprint: i % 120 < 40, fire: i % 90 === 0 }, TICK_DT)
        sim.stepWorld(TICK_DT, 240)
      }
      expect(slot.survivor.health).toBeGreaterThan(0)
      const snap = sim.toSnapshot() as SimState
      delete snap.featureStates.death
      return hashSimState(snap)
    }
    const withDeath = run()
    outbreakSharedFeatures.unregister("death")
    let without: string
    try {
      without = run()
    } finally {
      outbreakSharedFeatures.register(outbreakDeathSharedFeature)
    }
    expect(without).toBe(withDeath)
  })
})

describe("Death over the wire", () => {
  test("the death section round-trips exactly", () => {
    const { sim, slots } = squad(3)
    forceLife(sim, slots[0]!, "dead", T)
    slots[1]!.survivor.health = 0
    step(sim, 30)
    forceLife(sim, slots[2]!, "dead", T)
    step(sim, seconds(T.soloBleedOut) + 2)
    const snap = deathSnapshotOf(deathOf(sim), sim.slots)!
    expect(snap.over).not.toBeNull()
    const w = new ByteWriter(256)
    writeDeath(w, snap)
    expect(readDeath(new ByteReader(w.finish()))).toEqual(snap)
  })

  test("clients see who is down, revive through the room, and see the dead, their bodies and the run's end", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("test", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 3)
    const memory = new Map<string, string>()
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) }
    const ann = new NetSession({ features, url: "loop", room: "test", name: "Ann", storage, now: () => net.now, WebSocket: net.socketClass() })
    const bob = new NetSession({ features, url: "loop", room: "test", name: "Bob", now: () => net.now, WebSocket: net.socketClass() })
    const tick = (n: number, annCmd: (i: number) => Command = () => idle(0)) => {
      for (let i = 0; i < n; i++) {
        virtualMs = net.now * 1000
        net.step()
        if (core.phase === "lobby") core.start()
        ann.update(TICK_DT, annCmd(i))
        bob.update(TICK_DT, idle(0))
        ann.sync(TICK_DT)
        bob.sync(TICK_DT)
      }
    }
    tick(30)
    expect(ann.connected && bob.connected).toBe(true)
    const sa = core.sim.slot(ann.id)!
    const sb = core.sim.slot(bob.id)!
    place(core.sim, sa, 27.7, 42, 0)
    place(core.sim, sb, 28.6, 42, 0)
    tick(20)
    sb.survivor.health = 0
    tick(20)
    const server = deathOf(core.sim)
    for (const c of [ann, bob]) {
      const st = deathOf(c.sim)
      expect(st.records[sb.index]?.state).toBe("down")
      expect(Math.abs(st.records[sb.index]!.bleed - server.records[sb.index]!.bleed)).toBeLessThan(0.3)
      expect(st.records[sa.index]?.state ?? "alive").toBe("alive")
    }
    // Ann's own client offers the revive, and holding E there brings Bob back through the room.
    expect(ann.local.prompt?.kind).toBe("downed")
    tick(seconds(T.reviveTime) + 30, (i) => ({ ...idle(0), interact: i === 0, interactHeld: true }))
    expect(lifeOf(core.sim, sb.index)).toBe("alive")
    tick(10)
    for (const c of [ann, bob]) expect(deathOf(c.sim).records[sb.index]?.state).toBe("alive")
    expect(bob.view.player.health).toBe(T.reviveHealth)

    // Bob dies; both clients see his body, Ann still stands, the run goes on.
    forceLife(core.sim, sb, "dead", T)
    tick(10)
    for (const c of [ann, bob]) {
      const st = deathOf(c.sim)
      expect(st.records[sb.index]?.state).toBe("dead")
      expect(st.bodies).toEqual(server.bodies.map((b) => ({ ...b, yaw: st.bodies[0]!.yaw })))
      expect(st.runOver).toBe(false)
    }
    expect(spectateTarget(deathOf(bob.sim), bob.sim.slots, bob.local.index, null)).toBe(ann.local.index)
    // Ann goes too: the run is over everywhere.
    forceLife(core.sim, sa, "dead", T)
    tick(10)
    expect(core.runOver).toBe(true)
    for (const c of [ann, bob]) expect(deathOf(c.sim).runOver).toBe(true)
    ann.close()
    bob.close()
  })

  test("after the run, a restart gives the room a fresh world and tells clients to reload into it", () => {
    let virtualMs = 0
    const core = new CoopRoomCore("test", { ...DEFAULT_COOP_ROOM, zombieCount: 0 }, () => virtualMs, BUILD)
    const net = new Loopback(core, 2)
    const reloads: string[] = []
    const ann = new NetSession({ features, url: "loop", room: "test", name: "Ann", now: () => net.now, WebSocket: net.socketClass(), onReload: () => reloads.push("ann") })
    for (let i = 0; i < 20; i++) {
      virtualMs = net.now * 1000
      net.step()
      if (core.phase === "lobby") core.start()
      ann.update(TICK_DT, idle(0))
    }
    const old = core.sim
    const pump = (n: number) => {
      for (let i = 0; i < n; i++) {
        virtualMs = net.now * 1000
        net.step()
      }
    }
    ann.restart()
    pump(6)
    expect(core.sim).toBe(old)
    forceLife(core.sim, core.sim.slot(ann.id)!, "dead", T)
    pump(2)
    expect(core.runOver).toBe(true)
    ann.restart()
    pump(6)
    expect(core.sim).not.toBe(old)
    expect(core.runOver).toBe(false)
    expect(lifeOf(core.sim, core.sim.slot(ann.id)!.index)).toBe("alive")
    expect(reloads).toEqual(["ann"])
    expect(ann.status).toBe("Starting the run again…")
    ann.close()
  })
})
