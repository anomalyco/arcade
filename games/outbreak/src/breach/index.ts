import type { LabControl } from "@arcade/kit/lab-panel"
import { applyBreachSnapshot } from "../../shared/breach/net"
import { createBreachState, type BreachState } from "../../shared/breach/rules"
import { registerOutbreakClientFeature, type OutbreakClientFrameContext } from "../feature-registry"
import { setDoorLeafOverride } from "../world/door-leaf"
import { BreachPresenter } from "./presenter"
import { breachLabControls, DEFAULT_BREACH_SETTINGS } from "./settings"
import { applyStageHold, BREACH_SCENES, stageBreach, type BreachScene } from "./stage"

let presenter: BreachPresenter | null = null
let updatedThisFrame = false

/** The live presenter, for proofs and tests. */
export const breachPresenter = (): BreachPresenter | null => presenter

function frame(ctx: OutbreakClientFrameContext): BreachPresenter {
  if (!presenter) {
    presenter = new BreachPresenter(ctx.renderer)
    setDoorLeafOverride(presenter.drawsDoor)
  }
  if (!updatedThisFrame) {
    applyStageHold(ctx.session.sim)
    presenter.update({ session: ctx.session, settings: ctx.settings.breach, cam: ctx.cam, dt: ctx.dt })
    updatedThisFrame = true
  }
  return presenter
}

/**
 * Doors & barricades (AR-97), client half: the presenter draws damaged doors (cracks by stage, jolts, bulging, arms
 * through a punched panel, light and feet's shadows under the door) and breaches by kind, and plays the extra layers
 * of sound; the co-op client takes the room's wear from the `breach` section. Lab: Backquote › Doors & barricades
 * ("Doors & barricades: Today" turns rules and looks off), stage actions, `breach.stage`, station `outbreak-breach`.
 */
export const outbreakBreachFeature = registerOutbreakClientFeature({
  id: "breach",
  order: 60,
  settingsGroup: { subsystem: "breach", defaults: DEFAULT_BREACH_SETTINGS },
  labControls: (host) => [
    ...breachLabControls,
    ...BREACH_SCENES.map(
      (scene): LabControl => ({
        key: `breachStage-${scene}`,
        label: `Stage: ${scene.replace(/-/g, " ")}`,
        group: "Doors & barricades",
        type: "action",
        run: () => {
          if (host.progressionHost.offline()) stageBreach(host, scene)
        },
      }),
    ),
  ],
  gameCommands: (host) => [
    {
      id: "breach.stage",
      label: "Stage a Door Breach",
      shortLabel: "Door Breach",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${BREACH_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "giving") as BreachScene
        if (!BREACH_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return stageBreach(host, scene)
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a door (`breach.stage`): a wear stage, a breach type or bracing. */
    stageBreach(scene: BreachScene) {
      presenter?.reset()
      return stageBreach(host, scene)
    },
  }),
  harnessState: (host) => {
    const sim = host.session().sim
    const state = sim.getFeatureState<BreachState>("breach")
    const front = state?.portals["ash-front"]
    return {
      breach: {
        ...(presenter?.stats ?? {}),
        front: front ? { integrity: sim.ai.portalStates.get("ash-front")?.integrity, pushers: front.pushers, braced: front.braced, givingAt: front.givingAt, broken: front.broken, kind: front.kind, holed: front.holed } : null,
      },
    }
  },
  netSession: {
    onApplyWorld: (net, shared) => {
      const sim = net.sim
      let state = sim.getFeatureState<BreachState>("breach")
      if (!state) {
        state = createBreachState()
        sim.featureStates.set("breach", state)
      }
      applyBreachSnapshot(state, sim.town, sim.ai.portalStates, shared.breach)
    },
  },
  frame: {
    lights: (ctx, lights, count, max) => frame(ctx).writeLights(lights, count, max),
    batches: (ctx) => {
      const p = frame(ctx)
      updatedThisFrame = false
      return p.batches()
    },
  },
})
