import type { LabControl } from "@arcade/kit/lab-panel"
import { registerOutbreakClientFeature } from "../feature-registry"
import { ImpactBodies } from "./bodies"
import { ImpactEvents } from "./events"
import { DEFAULT_IMPACT_SETTINGS, impactControls } from "./settings"
import { IMPACT_SCENES, stageImpact, type ImpactScene } from "./stage"

const bodies = new ImpactBodies()
const events = new ImpactEvents(bodies)

/** The live body physics, for proofs and tests. */
export const impactBodies = (): ImpactBodies => bodies

/**
 * Combat oomph and physics (AR-90), client half: directional hit reactions and ragdoll deaths on the zombie renderer
 * (`ImpactBodies`, attached as `ZombieCrowdRenderer.physics`), bodies pushed by blasts and cars, and the feel layers
 * the replicated events drive (`ImpactEvents`). Lab: Backquote › Feel (Impact: Today / Physical, weapon weight, blast)
 * and Physics; the `impact.stage` command and the `outbreak-impact` station replay the same fights. Presentation
 * only: nothing here reaches the simulation or the wire.
 */
export const outbreakImpactFeature = registerOutbreakClientFeature({
  id: "impact",
  order: 23,
  settingsGroup: { subsystem: "impact", defaults: DEFAULT_IMPACT_SETTINGS },
  labControls: (host) => [
    ...impactControls,
    ...IMPACT_SCENES.map(
      (scene): LabControl => ({
        key: `impactStage-${scene}`,
        label: `Stage fight: ${scene}`,
        group: "Physics",
        type: "action",
        run: () => {
          if (host.progressionHost.offline()) stageImpact(host, scene)
        },
      }),
    ),
  ],
  gameCommands: (host) => [
    {
      id: "impact.stage",
      label: "Stage an Impact Fight",
      shortLabel: "Impact Fight",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${IMPACT_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "melee") as ImpactScene
        if (!IMPACT_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return stageImpact(host, scene)
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages an impact fight (`impact.stage`): melee, pistol, blast, car. */
    stageImpact(scene: ImpactScene) {
      return stageImpact(host, scene)
    },
  }),
  harnessState: () => ({ impact: { ...bodies.stats, reactions: bodies.reactions.size, ...events.stats } }),
  feel: {
    reset: (_tracker, player) => events.reset(player),
    processFrame: (ctx) => {
      events.process(ctx)
      return ctx.addCount
    },
  },
})
