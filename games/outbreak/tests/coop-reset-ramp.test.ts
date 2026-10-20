import { expect, test } from "bun:test"
import { DEFAULT_DEATH_TUNING, type DeathState } from "../shared/death/rules"
import { forceLife } from "../shared/death/runtime"
import { DEFAULT_NIGHT_RAMP_TUNING as T, lateAmmoDrop, lateAmmoDropId } from "../shared/night-ramp/ramp"
import type { NightRampState } from "../shared/night-ramp/runtime"
import { SPECIAL_BLOATER } from "../shared/specials/kinds"
import { spawnSpecial, specialsOf } from "../shared/specials/specials"
import { findClue, type WayOutState } from "../shared/way-out/runtime"
import { wayOutOf } from "../shared/way-out/state"
import { sampleWeather } from "../shared/weather/schedule"
import { placeAmbientBlood } from "../src/blood/placement"
import { DEFAULT_BLOOD_SETTINGS } from "../src/blood/settings"
import { placeNightLights } from "../src/night-lights/placement"
import { DEFAULT_NIGHT_LIGHT_SETTINGS } from "../src/night-lights/settings"
import { featureRoom } from "./coop-feature-room"

for (const seat of [0, 1]) test(`seat ${seat}: night-two ammo drops and night ramp outcomes reach peers and late join`, () => {
  const r = featureRoom()
  try {
    for (const hour of [22, 10, 22]) { r.core.sim.hour = hour; r.tick(1) }
    expect(r.core.sim.getFeatureState<NightRampState>("nightRamp")!.night).toBe(2)
    expect(r.core.sim.ai.pacing.escalation.populationBonus).toBeGreaterThan(0)
    const actor = r.clients[seat]!
    r.place(actor, 30, 46)
    const z = r.core.sim.ai.spawnZombie(r.core.sim.town, 33, 46, "wander")
    z.id = 60000
    while (!lateAmmoDrop(T, 2, 7, z.id).length) z.id++
    z.hp = 1
    z.speedScale = 0
    r.act(actor, { fire: true })
    r.tick(12)
    expect(z.state).toBe("dead")
    expect(r.core.sim.progression.ledger.store(lateAmmoDropId(z.id))).toBeDefined()
    r.ledgerParity([lateAmmoDropId(z.id)])
    r.join()
    r.tick(12)
    r.ledgerParity([lateAmmoDropId(z.id)])
  } finally { r.close() }
})

for (const seat of [0, 1]) test(`seat ${seat}: Restart replaces all feature state and rejoined clients start fresh`, () => {
  const r = featureRoom()
  try {
    const actor = r.clients[seat]!
    r.place(actor, 30, 46)
    r.hold(actor, "flamethrower")
    const bloater = spawnSpecial(r.core.sim, SPECIAL_BLOATER, 33, 46)!
    bloater.hp = 1
    r.act(actor, { fireHeld: true }, 12)
    r.tick(12)
    const old = r.core.sim
    expect(specialsOf(old).clouds.length).toBeGreaterThan(0)
    findClue(old, old.getFeatureState<WayOutState>("wayOut")!, "sign", "sign", old.slot(actor.id)!)
    // Persistent stores for every ledger-backed feature are deliberately dirty before the reset.
    for (const id of ["radio:reset", "dog:reset", "lamp:reset", "trap:reset", "dyn:reset", "crack:reset", "flare:reset", "scorch:reset", "pin:reset", "body:reset", "drop:rounds:reset"])
      old.progression.ledger.createStore({ id, mode: "counters", scope: "shared", initial: { dirty: 1 } })
    old.time = 1410
    old.hour = 22
    old.getFeatureState<NightRampState>("nightRamp")!.night = 4
    for (const s of old.slots) forceLife(old, s, "dead", DEFAULT_DEATH_TUNING)
    r.tick(12)
    const storage = [...r.stores]
    const ids = r.clients.map((c) => c.id)
    actor.restart()
    r.tick(6)
    expect(r.reloads).toEqual(["restart", "restart"])
    expect(r.core.sim).not.toBe(old)
    for (const c of r.clients) c.close()
    r.clients.length = 0
    for (const s of storage) r.join(s)
    r.tick(24)
    r.flush()
    expect(r.clients.map((c) => c.id)).toEqual(ids)
    for (const sim of [r.core.sim, ...r.clients.map((c) => c.sim)]) {
      expect([...sim.progression.ledger.stores.keys()].some((id) => id.endsWith(":reset"))).toBe(false)
      expect([...sim.progression.ledger.stores.keys()].some((id) => /^(burn|fire|flamer|fallen):/.test(id))).toBe(false)
      expect(specialsOf(sim).clouds).toEqual([])
      expect(sim.getFeatureState<DeathState>("death")!.runOver).toBe(false)
      expect(sim.getFeatureState<NightRampState>("nightRamp")!.night).toBe(1)
      expect(wayOutOf(sim.progression.ledger)?.tier ?? 0).toBe(0)
      expect(sampleWeather(sim.town.seed, sim.time, sim.hour).state).toBe("clear")
      expect(sim.slots.every((s) => !s.peek && !s.survivor.vehicleId && s.survivor.health === 100)).toBe(true)
      expect(placeAmbientBlood(sim.town, DEFAULT_BLOOD_SETTINGS)).toEqual(placeAmbientBlood(r.core.sim.town, DEFAULT_BLOOD_SETTINGS))
      expect(placeNightLights(sim.town, DEFAULT_NIGHT_LIGHT_SETTINGS)).toEqual(placeNightLights(r.core.sim.town, DEFAULT_NIGHT_LIGHT_SETTINGS))
    }
  } finally { r.close() }
})
