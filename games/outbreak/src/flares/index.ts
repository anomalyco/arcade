import type { LabControl } from "@arcade/kit/lab-panel"
import type { OutbreakAISubsystem } from "../../shared/ai"
import { flareControls } from "../../shared/flares/flares"
import { throwFlare, type FlaresState } from "../../shared/flares/runtime"
import { supportHeight } from "../../shared/terrain"
import type { DiscoveryHost } from "../discovery/stage"
import { registerOutbreakClientFeature } from "../feature-registry"
import { flareSprites } from "./props"

export const FLARE_SCENES = ["flare-hand", "flare-lit"] as const
export type FlareScene = (typeof FLARE_SCENES)[number]

type StageSession = { sim: Parameters<typeof throwFlare>[0]; ai: OutbreakAISubsystem }

/**
 * - `flare-hand`: night on the street south of Ash's house, three flares in hand and six of the dead wandering up the
 *   road (fire throws one).
 * - `flare-lit`: the same, a flare already burning in the road between them and the survivor.
 */
export function stageFlare(host: DiscoveryHost, session: StageSession, scene: FlareScene): { x: number; y: number } {
  const view = host.view()
  const { sim, ai } = session
  const ledger = view.progression.ledger
  for (const st of [...ledger.stores.values()]) if (st.id.startsWith("flare:")) ledger.deleteStore(st.id)
  for (const z of ai.agents) z.state = "dead"
  host.setHour(22)
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  const street = ash.rect[3] + 7
  const x = (ash.rect[0] + ash.rect[2]) / 2
  for (let i = 0; i < 6; i++) ai.spawnZombie(view.town, x + 16 + (i % 3) * 1.6, street - 1.5 + Math.floor(i / 3) * 2.2, "wander")
  const have = ledger.count(view.actorId, "flare")
  if (have < 3) ledger.apply({ kind: "grant", actor: view.actorId, item: "flare", count: 3 - have })
  const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === "flare") ?? -1
  if (slot >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot })
  host.pose(x, street, 0)
  if (scene === "flare-lit") {
    const me = sim.slots[0]
    const state = sim.getFeatureState<FlaresState>("flares")
    if (me && state) throwFlare(sim, me, { ...state.tuning, flareThrow: 7 })
  }
  return { x, y: street }
}

/**
 * Road flares (AR-56), client half: Lab tunables (Backquote › Flares; light and smoke under Night lights), staged
 * scenes, the `flares.stage` command, harness telemetry, and each burning flare's smoke and white-hot core as frame
 * sprites. The stick is drawn by `FlareProps` in the Discovery props and its red light by the night-lights presenter.
 */
export const outbreakFlaresFeature = registerOutbreakClientFeature({
  id: "flares",
  order: 28,
  labControls: (host) => [
    ...(flareControls as readonly LabControl[]),
    ...FLARE_SCENES.map((scene) => ({
      key: `flareStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Flares",
      type: "action" as const,
      run: () => {
        if (host.progressionHost.offline()) stageFlare(host.discoveryHost, host.session(), scene)
      },
    })),
  ],
  gameCommands: (host) => [
    {
      id: "flares.stage",
      label: "Stage a Road Flare Scene",
      shortLabel: "Flare Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${FLARE_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "flare-lit") as FlareScene
        if (!FLARE_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, at: stageFlare(host.discoveryHost, host.session(), scene) }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a road flare scene (`flares.stage`). */
    stageFlare(scene: FlareScene) {
      return stageFlare(host.discoveryHost, host.session(), scene)
    },
  }),
  harnessState: (host) => {
    const view = host.session().view
    const burning = [...view.progression.ledger.stores.values()].filter((s) => s.id.startsWith("flare:")).map((s) => s.id)
    return { flares: { burning, drawn: host.discoveryHost.props.flares.shown.burning } }
  },
  feel: {
    processFrame: (ctx) => {
      const view = ctx.session.view
      return flareSprites(view, (x, z) => supportHeight(view.town, x, z), ctx.settings.nightLights, ctx.addSprites, ctx.addCount)
    },
  },
})
