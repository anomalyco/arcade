import type { CoopSim } from "../../shared/coop-sim"
import type { DeathState } from "../../shared/death/rules"
import type { DeathSoundWorld } from "./death"
import type { SoundWorld } from "./director"

/** The director's view of a `CoopSim`: the offline session's and the co-op client's (filled from snapshots) alike. */
export function soundWorld(sim: CoopSim): SoundWorld {
  return {
    time: sim.time,
    town: sim.town,
    zombies: sim.ai.agents,
    shots: sim.combat.shots,
    meleeSwings: sim.combat.meleeSwings,
    portals: sim.ai.portalStates,
    survivors: sim.slots,
    progression: sim.progression,
    hour: sim.hour,
    death: deathSoundWorld(sim),
    elapsedHours: sim.elapsedHours,
    startHour: sim.ai.config.startHour,
  }
}

function deathSoundWorld(sim: CoopSim): DeathSoundWorld | undefined {
  const state = sim.getFeatureState<DeathState>("death")
  if (!state) return undefined
  const t = state.tuning
  const standing = sim.slots.filter((s) => (state.records[s.index]?.state ?? "alive") === "alive").length
  const bleedMax = standing > 0 ? t.bleedOut : t.soloBleedOut
  return {
    runOver: state.runOver,
    survivors: sim.slots.map((s) => {
      const rec = state.records[s.index]
      const life = rec?.state ?? "alive"
      return { index: s.index, x: s.survivor.x, y: s.survivor.y, state: life, bleed: rec?.bleed ?? 0, bleedMax }
    }),
  }
}

/** Zombies alert, chasing or bashing within `radius` metres: the threat the ambience rises with. */
export function pursuers(zombies: readonly { x: number; y: number; state: string }[], x: number, y: number, radius = 25): number {
  let n = 0
  for (const z of zombies) if ((z.state === "chase" || z.state === "alert" || z.state === "bash") && Math.hypot(z.x - x, z.y - y) < radius) n++
  return n
}
