import { expect, test } from "bun:test"
import { DEFAULT_DEATH_TUNING as T, type DeathState } from "../shared/death/rules"
import { forceLife, lifeOf } from "../shared/death/runtime"
import { deathSnapshotOf } from "../shared/death/net"
import { spectateTarget } from "../src/death/spectate"
import { featureRoom } from "./coop-feature-room"

for (const seat of [0, 1]) test(`seat ${seat}: down, revive, fallen kit, spectate, dawn and run over match the room`, () => {
  const r = featureRoom()
  try {
    const actor = r.clients[seat]!
    const mate = r.clients[1 - seat]!
    r.place(actor, 30, 46)
    r.place(mate, 30.8, 46, Math.PI)
    const slot = r.core.sim.slot(actor.id)!
    slot.survivor.health = 0
    r.tick(12)
    r.flush()
    for (const c of r.clients) expect(lifeOf(c.sim, actor.index)).toBe("down")
    r.act(mate, { interactHeld: true }, Math.ceil((T.reviveTime + 0.3) * 60))
    r.flush()
    for (const sim of [r.core.sim, ...r.clients.map((c) => c.sim)]) expect(lifeOf(sim, actor.index)).toBe("alive")
    forceLife(r.core.sim, slot, "dead", T)
    r.tick(12)
    r.ledgerParity(["fallen:"])
    r.join()
    r.tick(12)
    r.flush()
    for (const c of r.clients) {
      const state = c.sim.getFeatureState<DeathState>("death")!
      expect(lifeOf(c.sim, actor.index)).toBe("dead")
      expect(spectateTarget(state, c.sim.slots, actor.index, null)).toBe(mate.index)
      expect(deathSnapshotOf(state, c.sim.slots)).toEqual(deathSnapshotOf(r.core.sim.getFeatureState<DeathState>("death")!, r.core.sim.slots))
    }
    r.core.sim.hour = 22
    r.tick(1)
    r.core.sim.hour = 10
    r.tick(12)
    r.flush()
    for (const sim of [r.core.sim, ...r.clients.map((c) => c.sim)]) expect(lifeOf(sim, actor.index)).toBe("alive")
    for (const s of r.core.sim.slots) forceLife(r.core.sim, s, "dead", T)
    r.tick(12)
    r.flush()
    for (const c of r.clients) expect(c.sim.getFeatureState<DeathState>("death")!.runOver).toBe(true)
  } finally { r.close() }
})

test("a dead player's snapshot follows the living teammate's interest bubble", () => {
  const r = featureRoom()
  try {
    r.place(r.b, 350, 46)
    const zombie = r.core.sim.ai.spawnZombie(r.core.sim.town, 355, 46, "wander")
    zombie.speedScale = 0
    forceLife(r.core.sim, r.core.sim.slot(r.a.id)!, "dead", T)
    r.tick(18)
    r.flush()
    const snap = r.a.snapHistory.get(r.a.lastServerTick)!
    expect(snap.zombies.some((z) => z.id === zombie.id)).toBe(true)
  } finally { r.close() }
})

test("spectator target switches on a fall, stays on that teammate after revival, and clears at dawn", () => {
  const r = featureRoom()
  try {
    const third = r.join()
    r.tick(12)
    r.place(r.b, 350, 46)
    r.place(third, 650, 46)
    const nearB = r.core.sim.ai.spawnZombie(r.core.sim.town, 355, 46, "wander")
    const nearThird = r.core.sim.ai.spawnZombie(r.core.sim.town, 655, 46, "wander")
    nearB.speedScale = nearThird.speedScale = 0
    const life = (c: typeof r.a, state: "dead" | "down" | "alive") => {
      forceLife(r.core.sim, r.core.sim.slot(c.id)!, state, T)
      r.tick(12)
      r.flush()
    }
    const check = (target: number, present: number, absent: number) => {
      const snap = r.a.snapHistory.get(r.a.lastServerTick)!
      expect(snap.death?.survivors.find((s) => s.index === r.a.index)?.watching).toBe(target)
      expect(snap.zombies.some((z) => z.id === present)).toBe(true)
      expect(snap.zombies.some((z) => z.id === absent)).toBe(false)
      for (const c of r.clients) expect(c.sim.getFeatureState<DeathState>("death")!.records[r.a.index]!.watching).toBe(target)
    }
    life(r.a, "dead")
    check(r.b.index, nearB.id, nearThird.id)
    life(r.b, "down")
    check(third.index, nearThird.id, nearB.id)
    life(r.b, "alive")
    check(third.index, nearThird.id, nearB.id)
    const late = r.join()
    r.tick(12)
    r.flush()
    expect(late.sim.getFeatureState<DeathState>("death")!.records[r.a.index]!.watching).toBe(third.index)
    r.core.sim.hour = 22
    r.tick(1)
    r.core.sim.hour = 10
    r.tick(12)
    r.flush()
    for (const c of r.clients) expect(c.sim.getFeatureState<DeathState>("death")!.records[r.a.index]!.watching).toBeUndefined()
  } finally { r.close() }
})

// Playtest (Oct 20): "you can't see the other person's screen" / "I have the bot, damn it, the whole time" — a dropped
// seat's survivor stands idle for up to a minute, and the dead used to end up watching it.
test("the dead cycle teammates with Space or a click, and never watch a seat whose player has gone", () => {
  const r = featureRoom()
  try {
    const third = r.join()
    r.tick(12)
    r.place(r.b, 40, 46)
    r.place(third, 44, 46)
    forceLife(r.core.sim, r.core.sim.slot(r.a.id)!, "dead", T)
    r.tick(12)
    r.flush()
    const watching = () => r.a.sim.getFeatureState<DeathState>("death")!.records[r.a.index]!.watching
    expect(watching()).toBe(r.b.index)
    r.act(r.a, { jump: true })
    r.tick(12)
    r.flush()
    expect(watching()).toBe(third.index)
    r.act(r.a, { fire: true })
    r.tick(12)
    r.flush()
    expect(watching()).toBe(r.b.index)
    // b's player drops: their survivor stays in the room for the grace window, but nobody watches it.
    r.b.close()
    r.tick(12)
    r.flush()
    expect(r.core.sim.slot(r.b.id)).toBeDefined()
    expect(watching()).toBe(third.index)
    r.act(r.a, { jump: true })
    r.tick(12)
    r.flush()
    expect(watching()).toBe(third.index)
  } finally { r.close() }
})
