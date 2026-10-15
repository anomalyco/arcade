import type { CoopSim } from "../../shared/coop-sim"
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
  }
}

/** Zombies alert, chasing or bashing within `radius` metres: the threat the ambience rises with. */
export function pursuers(zombies: readonly { x: number; y: number; state: string }[], x: number, y: number, radius = 25): number {
  let n = 0
  for (const z of zombies) if ((z.state === "chase" || z.state === "alert" || z.state === "bash") && Math.hypot(z.x - x, z.y - y) < radius) n++
  return n
}
