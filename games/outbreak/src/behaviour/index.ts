import type { LabControl } from "@arcade/kit/lab-panel"
import type { LabCommand } from "@arcade/kit/lab/commands"
import { ACT_NONE, ACTIVITY_NAMES, attentionOf } from "../../shared/behaviour/activities"
import { applyReplicatedActivities, behaviourOf } from "../../shared/behaviour/mind"
import { behaviourControls, DEFAULT_BEHAVIOUR_TUNING } from "../../shared/behaviour/tuning"
import type { OutbreakSim } from "../../shared/sim-types"
import { supportHeight } from "../../shared/terrain"
import { registerOutbreakClientFeature } from "../feature-registry"
import { BehaviourOverlay } from "./overlay"
import { BehaviourPoser } from "./pose"
import { BEHAVIOUR_SCENES, stageBehaviour, type BehaviourScene } from "./stage"

/**
 * Zombie behaviour (AR-91), client half: Backquote › Zombie behaviour ("Zombie behaviour: Today" turns it off), the
 * personality gait and activity poses on the crowd renderer, the behaviour overlay, co-op activity replication, and
 * `arcade cmd behaviour.stage scene=…` for the Lab station. The rules live in `shared/behaviour/`.
 */

const poser = new BehaviourPoser()
const overlay = new BehaviourOverlay()
const survivors: { x: number; y: number; aim: number; flashlightOn: boolean }[] = []
let poseSim: OutbreakSim | null = null
const activityOf = (id: number) => (poseSim ? (behaviourOf(poseSim)?.minds[id]?.act ?? ACT_NONE) : ACT_NONE)
poser.world = { activity: activityOf, survivors }

function stage(sim: OutbreakSim, scene: string) {
  if (!(BEHAVIOUR_SCENES as readonly string[]).includes(scene)) return { error: `unknown scene "${scene}" (${BEHAVIOUR_SCENES.join(", ")})` }
  return stageBehaviour(sim, scene as BehaviourScene)
}

function summary(sim: OutbreakSim) {
  const st = behaviourOf(sim)
  const doing: Record<string, number> = {}
  const attention: Record<string, number> = {}
  for (const a of sim.ai.agents) {
    if (a.state === "dead") continue
    const act = st?.minds[a.id]?.act ?? ACT_NONE
    const name = ACTIVITY_NAMES[act] ?? String(act)
    doing[name] = (doing[name] ?? 0) + 1
    const at = attentionOf(act)
    attention[at] = (attention[at] ?? 0) + 1
  }
  return { on: (st?.tuning.zbMode ?? 0) >= 1, doing, attention, started: { ...(st?.started ?? {}) }, overlayLabels: overlay.drawn }
}

export const outbreakBehaviourFeature = registerOutbreakClientFeature({
  id: "behaviour",
  order: 19,
  settingsGroup: { subsystem: "behaviour", defaults: DEFAULT_BEHAVIOUR_TUNING },
  labControls: (host): LabControl[] => [
    ...(behaviourControls as readonly LabControl[]),
    ...BEHAVIOUR_SCENES.map(
      (scene): LabControl => ({
        key: `behaviour.stage.${scene}`,
        label: `Stage: ${scene}`,
        group: "Zombie behaviour",
        type: "action",
        run: () => {
          if (!host.progressionHost.offline()) return
          stage(host.session().sim, scene)
        },
      }),
    ),
  ],
  gameCommands: (host): LabCommand[] => [
    {
      id: "behaviour.stage",
      label: "Stage Zombie Behaviour",
      shortLabel: "Behaviour",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${BEHAVIOUR_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: async (_ctx, args) => {
        const out = stage(host.session().sim, String(args?.scene ?? "crowd"))
        await host.harness().step(1 / 60)
        return out
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a behaviour scene around the survivor (`listen`, `follow`, `search`, `rest`, `herd`, `feed`, …). */
    stageBehaviour(scene: string) {
      return stage(host.session().sim, scene)
    },
  }),
  harnessState: (host) => ({ behaviour: summary(host.session().sim) }),
  netSession: {
    onApplyWorld: (net, shared) => {
      const st = behaviourOf(net.sim)
      if (st) applyReplicatedActivities(st, shared.behaviour?.acts ?? [])
      return false
    },
  },
  feel: {
    reset: () => poser.reset(),
    processFrame: ({ session, zombieCrowd, settings, addCount }) => {
      const tuning = settings.behaviour
      if (tuning.zbMode < 1) {
        zombieCrowd.behaviour = null
        return addCount
      }
      poseSim = session.sim
      poser.tuning = tuning
      survivors.length = 0
      for (const slot of session.sim.slots) survivors.push(slot.survivor)
      zombieCrowd.behaviour = poser
      return addCount
    },
  },
  frame: {
    overlay: ({ session, settings, cam, w, h }) => {
      if (!settings.behaviour.zbOverlay) return overlay.hide()
      const sim = session.sim
      poseSim = sim
      overlay.draw(sim.ai.agents, activityOf, (x, z) => supportHeight(sim.town, x, z), cam, w, h)
    },
  },
})
