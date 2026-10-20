import { DEFAULT_PROGRESSION_TUNING } from "../../shared/progression/tuning"
import { registerOutbreakClientFeature } from "../feature-registry"
import {
  applyProgressionSetting,
  PROGRESSION_SCENES,
  progressionLabControls,
  stageProgression,
  type ProgressionScene,
} from "./lab"

export const outbreakProgressionFeature = registerOutbreakClientFeature({
  id: "progression",
  order: 20,
  settingsGroup: {
    subsystem: "progression",
    defaults: DEFAULT_PROGRESSION_TUNING,
  },
  labControls: (host) => (host.progressionHost ? progressionLabControls(host.progressionHost) : []),
  onSettingChanged: (host, rawKey, routed) =>
    host.progressionHost
      ? applyProgressionSetting(host.progressionHost, routed?.field ?? rawKey, host.settings.progression)
      : false,
  gameCommands: (host) => [
    {
      id: "progression.stage",
      label: "Stage an Inventory or Workbench Scene",
      shortLabel: "Progression Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${PROGRESSION_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "bench") as ProgressionScene
        if (!PROGRESSION_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        stageProgression(host.progressionHost, scene)
        return { scene }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Sets loaded rounds and, optionally, supply counts (`{ ammo: 4, plank: 3 }`) through the progression ledger. */
    stock(loaded?: number, belt: Record<string, number> = {}) {
      const session = host.session()
      const { progression, actorId } = session.view
      const ledger = progression.ledger
      if (loaded !== undefined) ledger.apply({ kind: "setCharge", actor: actorId, item: "pistol", charge: loaded })
      for (const [item, n] of Object.entries(belt)) {
        for (const store of [`${actorId}/hotbar`, `${actorId}/pack`]) {
          const have = ledger.count(store, item)
          if (have) ledger.apply({ kind: "drain", store, item, count: have })
        }
        if (n) ledger.apply({ kind: "grant", actor: actorId, item, count: n })
      }
      const slot = session.sim.slot(actorId)
      if (slot) progression.project(slot)
    },
    /** Stages a Lab scene (`progression.stage`): search, strip, bench, dark-bench, generator, field-craft, handoff. */
    stageProgression(scene: ProgressionScene) {
      stageProgression(host.progressionHost, scene)
    },
    /** The inventory HUD (pack, field craft, prompts), for proofs. */
    inventoryHud() {
      return host.progressionHost.hud
    },
    /** Gives the local survivor an item, routed to belt, hand or pack. */
    give(item: string, count = 1) {
      const session = host.session()
      return session.view.progression.ledger.apply({ kind: "grant", actor: session.view.actorId, item, count }).ok
    },
  }),
  netSession: {
    onApplyWorld: (net, s) => {
      const progression = net.sim.progression
      if (progression.pings.length || s.pings.length) {
        progression.pings.splice(
          0,
          progression.pings.length,
          ...s.pings.map((p) => ({ id: p.id, by: p.by, x: p.x, y: p.y, label: p.label, until: s.time + p.left })),
        )
      }
      if (progression.lures.length || s.lures.length) {
        progression.lures.splice(
          0,
          progression.lures.length,
          ...s.lures.map((l) => ({ id: l.id, x: l.x, y: l.y, until: s.time + l.left, next: Infinity })),
        )
      }
    },
  },
})
