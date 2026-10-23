import type { ReplaySim } from "@arcade/kit/sim/replay"
import { CoopSim } from "../../shared/coop-sim"
import type { Command } from "../../shared/session"

/** Same 20 Hz integration step as the existing bot-runner regression tests. */
export const REPLAY_DT = 1 / 20

/** Snapshot-only projection: math differs by a few ULPs across Bun's Mac/Linux builds.
 * Preserve discrete values and special numbers; compare fractions to 1e-9 game units.
 * Never write these rounded values back into the simulation or recorded inputs.
 */
export function replayNumber(value: number): number {
  return Number.isFinite(value) && !Number.isInteger(value) ? Math.round(value * 1e9) / 1e9 : value
}

export const scavenging: ReplaySim<CoopSim, Command> = {
  version: "outbreak-scavenging-v2",
  normalizeNumber: replayNumber,
  init(recording) {
    const sim = new CoopSim(recording.seed, recording.seed, 0.22, undefined, undefined, "classic")
    recording.players.forEach((id, i) => sim.addSurvivor(id, i))
    sim.ai.pacing.stepAfterCrowd(sim.ai.nav, sim.ai.agents, sim.slots.map((s) => s.survivor), sim.ai.config, 0, false)
    return sim
  },
  step(sim, commands, dt) {
    sim.slots.forEach((slot, i) => sim.stepSurvivor(slot, commands[i]!, dt))
    sim.stepWorld(dt, 240)
  },
  fields(sim) {
    const { slots, ...world } = sim.toSnapshot()
    const fields: Record<string, unknown> = { ...world }
    // Keep full world state (including RNG, features and rewind); give survivor
    // failures more useful names than just "slots" without duplicating their hashes.
    fields["slots.ids"] = slots.map((slot) => [slot.id, slot.index])
    for (const slot of slots) {
      fields[`slots.${slot.id}.notices`] = slot.notices
      for (const [key, value] of Object.entries(slot.survivor)) fields[`slots.${slot.id}.${key}`] = value
    }
    return fields
  },
}

/** A small street encounter: one pistol, one bat, two nearby attackers. */
export const combat: ReplaySim<CoopSim, Command> = {
  ...scavenging,
  version: "outbreak-combat-v2",
  init(recording) {
    const sim = new CoopSim(recording.seed, recording.seed, 0.22, { zombieCount: 0, directorPacing: 0, openingCalm: 0 }, undefined, "classic")
    recording.players.forEach((id, i) => {
      const slot = sim.addSurvivor(id, i)
      Object.assign(slot.survivor, { x: 44, y: 44 + i * 4, aim: 0 })
      if (i === 1) {
        sim.progression.ledger.apply({ kind: "grant", actor: id, item: "bat" })
        sim.progression.project(slot)
      }
      sim.ai.spawnZombie(sim.town, 46 + i, 44 + i * 4, "chase", Math.PI)
    })
    sim.rebuildCollision()
    return sim
  },
}

export function combatInputs(tick: number): Command[] {
  return [0, 1].map((i) => ({
    mx: tick >= 200 && tick < 240 ? -1 : tick >= 300 && tick < 340 ? 1 : 0,
    my: 0,
    aim: 0,
    interact: false,
    hotbarSlot: tick === 0 ? (i === 0 ? 1 : 2) : undefined,
    fire: tick < 180 && tick % 20 === 0,
    fireHeld: i === 1 && tick >= 100 && tick < 125,
    reload: i === 0 && tick === 80,
    sprint: tick >= 200 && tick < 240,
    crouch: tick >= 300 && tick < 340,
    flashlight: tick === 400 || tick === 500,
    ping: tick === 450,
  }))
}
