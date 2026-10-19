import type { OutbreakAISubsystem } from "../../shared/ai"
import type { CoopSim } from "../../shared/coop-sim"
import { ds, radioSites, type RadioSite } from "../../shared/radios/radios"
import { switchRadio } from "../../shared/radios/runtime"
import type { DiscoveryHost } from "../discovery/stage"

/** Staged radio scenes for the Lab, the `radios.stage` command and the clip. */
export const RADIO_SCENES = ["radio-off", "radio-playing", "radio-lure", "radio-broken"] as const
export type RadioScene = (typeof RADIO_SCENES)[number]

type StageSession = { sim: CoopSim; ai: OutbreakAISubsystem; rebuildCollision: () => void }

/** Ash's radio (the start house), or the first one in the world. */
function ashRadio(sim: CoopSim): RadioSite {
  const sites = radioSites(sim.town)
  const site = sites.find((s) => s.buildingId === "ash") ?? sites[0]
  if (!site) throw new Error("No radio in this world")
  return site
}

/**
 * - `radio-off`: at night, standing at Ash's living-room table with the radio off (E switches it on).
 * - `radio-playing`: the same, the radio on and the dial lit.
 * - `radio-lure`: the radio on in Ash's house with its front door open, six of the dead out on the street and the
 *   survivor across the road in the dark; they turn and go in to it.
 * - `radio-broken`: the radio knocked to the floor by the dead.
 */
export function stageRadio(host: DiscoveryHost, session: StageSession, scene: RadioScene, battery: number): RadioSite {
  const { sim, ai } = session
  const ledger = sim.progression.ledger
  const site = ashRadio(sim)
  if (ledger.store(site.id)) ledger.deleteStore(site.id)
  host.setHour(22)
  switch (scene) {
    case "radio-off":
      host.pose(site.x, site.y + 1, -Math.PI / 2)
      break
    case "radio-playing":
      switchRadio(sim, site, sim.time, battery)
      host.pose(site.x + 0.4, site.y + 1.2, -Math.PI / 2)
      break
    case "radio-lure": {
      for (const z of ai.agents) z.state = "dead"
      const front = sim.town.doors.find((d) => d.id === `${site.buildingId}-front`)
      if (front && !front.open) {
        front.open = true
        session.rebuildCollision()
      }
      switchRadio(sim, site, sim.time, 600)
      const b = sim.town.buildings.find((x) => x.id === site.buildingId)!
      const street = b.rect[3] + 7
      for (let i = 0; i < 6; i++) ai.spawnZombie(sim.town, b.rect[0] - 4 + i * 3.2, street + (i % 2) * 1.6, "wander")
      host.pose(site.x + 8, street + 9, -Math.PI / 2)
      break
    }
    case "radio-broken": {
      const st = ledger.createStore({ id: site.id, mode: "counters", scope: "shared", at: { x: site.x, y: site.y }, initial: { on: 0, broken: 1, left: ds(20) } })
      st.rev = ++ledger.rev
      host.pose(site.x + 0.6, site.y + 1.6, -Math.PI / 2)
      break
    }
  }
  return site
}
