import type { OutbreakAISubsystem } from "../../shared/ai"
import { MELEE_WEAPONS } from "../../shared/combat"
import type { OutbreakSim } from "../../shared/sim-types"
import type { DiscoveryHost } from "../discovery/stage"
import { stageFire } from "../fire/stage"
import { playStunt, stageVehicleScene, type StuntStep, type VehicleLabHost } from "../vehicle-lab"

/**
 * Staged fights for comparing Today against Physical on the same blows (`impact.stage`, the `outbreak-impact` Lab
 * station, `scripts/feel-clips.ts oomph`). Each places the same zombies and plays the same scripted inputs through the
 * normal command path, so with a fixed step (`harness.step`) every run is the same fight.
 *
 * - `melee`: dusk, a fire axe; a charged heavy swing cleaves two of three charging, a light swing rocks the third.
 * - `pistol`: dusk, three in a line down the street; five shots stagger, kill, then drop the ones behind.
 * - `blast`: night, dynamite thrown into a knot of eight (Fire › `dynamite-lit`), then a second stick onto the bodies.
 * - `car`: dusk, a pickup floored into four charging zombies, then braking.
 */
export const IMPACT_SCENES = ["melee", "pistol", "blast", "car"] as const
export type ImpactScene = (typeof IMPACT_SCENES)[number]

export type ImpactStageHost = {
  readonly discoveryHost: DiscoveryHost
  readonly vehicleHost: VehicleLabHost
  session(): { sim: OutbreakSim; ai: OutbreakAISubsystem }
}

function equip(view: ReturnType<DiscoveryHost["view"]>, item: string): void {
  const ledger = view.progression.ledger
  if (item in MELEE_WEAPONS) {
    const hb = ledger.store(`${view.actorId}/hotbar`)
    if (hb) {
      hb.slots[2] = { item, count: 1, charge: MELEE_WEAPONS[item as keyof typeof MELEE_WEAPONS].durability }
      hb.selected = 2
      hb.rev = ++ledger.rev
    }
    return
  }
  if (ledger.count(view.actorId, item) < 1) ledger.apply({ kind: "grant", actor: view.actorId, item, count: 1 })
  const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === item) ?? -1
  if (slot >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot })
}

export function stageImpact(host: ImpactStageHost, scene: ImpactScene): { scene: ImpactScene; zombies: number } {
  const dh = host.discoveryHost
  const session = host.session()
  const { sim, ai } = session
  const view = dh.view()
  const project = () => {
    const slot = sim.slot(view.actorId)
    if (slot) {
      slot.survivor.stamina = 1
      slot.survivor.exhausted = false
      sim.progression.project(slot)
    }
  }
  const steps: StuntStep[] = []
  switch (scene) {
    case "melee": {
      ai.agents.length = 0
      dh.setHour(18.6)
      dh.pose(44, 44, 0)
      equip(view, "fire-axe")
      project()
      const z1 = ai.spawnZombie(view.town, 45.75, 43.7, "chase", Math.PI)
      const z2 = ai.spawnZombie(view.town, 45.9, 44.45, "chase", Math.PI)
      const z3 = ai.spawnZombie(view.town, 47.6, 44.1, "chase", Math.PI)
      z1.hp = z2.hp = 30
      z3.hp = 400
      steps.push(
        { until: 0.3, mx: 0, my: 0, aim: 0 },
        { until: 0.95, mx: 0, my: 0, aim: 0, fire: true, fireHeld: true },
        { until: 1.7, mx: 0, my: 0, aim: 0, fireHeld: false },
        { until: 1.8, mx: 0, my: 0, aim: 0.05, fire: true },
        { until: 3.4, mx: 0, my: 0, aim: 0.05, fireHeld: false },
      )
      break
    }
    case "pistol": {
      ai.agents.length = 0
      dh.setHour(18.6)
      dh.pose(40, 44, 0)
      equip(view, "pistol")
      view.progression.ledger.apply({ kind: "setCharge", actor: view.actorId, item: "pistol", charge: 8 })
      project()
      const zs = [ai.spawnZombie(view.town, 46.5, 44, "chase", Math.PI), ai.spawnZombie(view.town, 48.2, 44.05, "chase", Math.PI), ai.spawnZombie(view.town, 50, 43.95, "chase", Math.PI)]
      zs[0]!.hp = 80
      zs[1]!.hp = 40
      zs[2]!.hp = 40
      for (let i = 0; i < 5; i++) {
        steps.push({ until: 0.3 + i * 0.5, mx: 0, my: 0, aim: 0, fireHeld: false }, { until: 0.34 + i * 0.5, mx: 0, my: 0, aim: 0, fire: true })
      }
      steps.push({ until: 4, mx: 0, my: 0, aim: 0, fireHeld: false })
      break
    }
    case "blast": {
      ai.agents.length = 0
      stageFire(dh, session, "dynamite-lit")
      // The first stick blows at ~2.6 s; the second lands on the bodies.
      steps.push({ until: 3.6, mx: 0, my: 0, aim: 0, fireHeld: false }, { until: 3.65, mx: 0, my: 0, aim: 0, fire: true }, { until: 7, mx: 0, my: 0, aim: 0, fireHeld: false })
      break
    }
    case "car": {
      ai.agents.length = 0
      stageVehicleScene(host.vehicleHost, "horde-runover")
      steps.push({ until: 0.25, mx: 0, my: 0 }, { until: 2.3, mx: 0, my: -1 }, { until: 3.6, mx: 0, my: 1 })
      break
    }
  }
  playStunt(steps)
  return { scene, zombies: ai.agents.length }
}
