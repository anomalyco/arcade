import type { LabControl } from "@arcade/kit/lab-panel"
import type { InteractionsState } from "../../shared/interactions/index"
import { isThrowable } from "../../shared/interactions/throwables"
import { throwHeld } from "../../shared/interactions/tosses"
import { DEFAULT_INTERACTIONS_TUNING, interactionsControls } from "../../shared/interactions/tuning"
import { LocalSession } from "../../shared/session"
import { localSlot } from "../death/spectate"
import { registerOutbreakClientFeature, type OutbreakClientFrameContext } from "../feature-registry"
import type { NetSession } from "../net-session"
import { InteractionsHint, type InteractionHint } from "./hint"
import { InteractionsPresenter } from "./presenter"
import { INTERACTION_SCENES, stageInteraction, type InteractionScene } from "./stage"

let presenter: InteractionsPresenter | null = null
let presenterRenderer: object | null = null
let hint: InteractionsHint | null = null

function offline(session: LocalSession | NetSession): LocalSession {
  if (!(session instanceof LocalSession)) throw new Error("Offline only: a co-op room decides the world")
  return session
}

/** The local survivor's interaction hints this frame (throwables: `◯LMB Throw`, the ring filling as it winds up). */
function hintsFor(ctx: OutbreakClientFrameContext): InteractionHint[] {
  const out: InteractionHint[] = []
  const sim = ctx.session.sim
  const slot = localSlot(ctx.session)
  if (!slot || slot.survivor.vehicleId || slot.survivor.health <= 0) return out
  const state = sim.getFeatureState<InteractionsState>("interactions")
  const item = sim.progression.selected(slot.id)?.item
  if (state && state.tuning.throwables > 0 && isThrowable(item) && (item !== "bottle" || sim.progression.tossBottles)) {
    const aim = presenter?.preview(sim, slot)
    out.push({ code: "Mouse0", verb: "Throw", hold: true, progress: aim ? (aim.power - state.tuning.throwTap) / Math.max(0.01, 1 - state.tuning.throwTap) : 0, note: aim ? undefined : "hold for distance" })
  }
  return out
}

/**
 * World interactions (AR-96), client half: throws in the air and the arc preview (`presenter.ts`), the in-world key
 * hint (`hint.ts`), the Lab's Interactions group (Backquote › Interactions; each interaction's "Today" is one setting
 * away) with staged scenes, the `interactions.stage` command and harness telemetry. The rules are
 * `shared/interactions/`.
 */
export const outbreakInteractionsFeature = registerOutbreakClientFeature({
  id: "interactions",
  order: 31,
  settingsGroup: { subsystem: "interactions", defaults: DEFAULT_INTERACTIONS_TUNING },
  labControls: (host): LabControl[] => [
    ...(interactionsControls as unknown as readonly LabControl[]),
    ...INTERACTION_SCENES.map(
      (scene): LabControl => ({
        key: `interactionsStage-${scene}`,
        label: `Stage: ${scene}`,
        group: "Interactions",
        type: "action",
        run: () => {
          if (host.progressionHost.offline()) stageInteraction(host.discoveryHost, offline(host.session()), scene)
        },
      }),
    ),
  ],
  gameCommands: (host) => [
    {
      id: "interactions.stage",
      label: "Stage a World Interaction Scene",
      shortLabel: "Interaction Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${INTERACTION_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "baseball") as InteractionScene
        if (!INTERACTION_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, at: stageInteraction(host.discoveryHost, offline(host.session()), scene) }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a world interaction scene (`interactions.stage`). */
    stageInteraction(scene: InteractionScene) {
      return stageInteraction(host.discoveryHost, offline(host.session()), scene)
    },
    /** Throws what the local survivor holds at `power` (0..1) along their aim, as releasing the button would. */
    throwHeld(power = 1) {
      const sim = offline(host.session()).sim
      const state = sim.getFeatureState<InteractionsState>("interactions")!
      return throwHeld(sim, sim.slots[0]!, power, state.tuning)
    },
  }),
  harnessState: () => ({ interactions: { ...(presenter?.shown ?? {}), hint: hint?.shown.verb ?? "" } }),
  frame: {
    batches: (ctx) => {
      if (!presenter || presenterRenderer !== ctx.renderer) {
        presenter = new InteractionsPresenter(ctx.renderer)
        presenterRenderer = ctx.renderer
      }
      return presenter.collect(ctx.session.sim, localSlot(ctx.session), ctx.session.view.time)
    },
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      hint ??= new InteractionsHint()
      hint.show(hintsFor(ctx))
    },
  },
})
