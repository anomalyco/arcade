import type { LabControl } from "@arcade/kit/lab-panel"
import type { OutbreakAISubsystem } from "../../shared/ai"
import { bodiesControls, bodyLoot, bodySites, BODY_SLOTS, type BodySite } from "../../shared/bodies/bodies"
import { ds } from "../../shared/radios/radios"
import type { SessionView } from "../../shared/session"
import type { DiscoveryHost } from "../discovery/stage"
import { registerOutbreakClientFeature } from "../feature-registry"

export const BODY_SCENES = ["body", "body-searched", "body-rising"] as const
export type BodyScene = (typeof BODY_SCENES)[number]

type StageSession = { ai: OutbreakAISubsystem }

/** The body nearest the start that no vignette draws (its own, so it can rise). */
function nearestBody(view: SessionView): BodySite {
  const d = (b: BodySite) => Math.hypot(b.x - 30, b.y - 40)
  const body = bodySites(view.town).filter((b) => !b.vignette).sort((a, b) => d(a) - d(b))[0]
  if (!body) throw new Error("No body in this world")
  return body
}

/**
 * - `body`: dusk, kneeling distance from the body nearest the start, facing it, unsearched (E searches it).
 * - `body-searched`: the same body searched, what it carried on show (digits or E take it).
 * - `body-rising`: the same body as it begins to rise under the survivor's hand.
 */
export function stageBody(host: DiscoveryHost, session: StageSession, scene: BodyScene): string {
  const view = host.view()
  const ledger = view.progression.ledger
  const b = nearestBody(view)
  for (const z of session.ai.agents) z.state = "dead"
  if (ledger.store(b.id)) ledger.deleteStore(b.id)
  if (ledger.store(`drop:body:${b.key}`)) ledger.deleteStore(`drop:body:${b.key}`)
  const st = ledger.createStore({ id: b.id, mode: "slots", scope: "shared", size: BODY_SLOTS, revealed: scene === "body-searched", at: { x: b.x, y: b.y }, initial: bodyLoot(view.town, b.key, view.progression.tuning.lootRate) })
  if (scene === "body-rising") {
    st.counts.rise = Math.max(1, ds(view.time))
    st.rev = ++ledger.rev
  }
  host.setHour(19.2)
  host.pose(b.x - 0.4, b.y + 0.95, Math.atan2(-0.95, 0.4))
  return b.id
}

/**
 * Bodies To Search (AR-56), client half: Lab tunables (Backquote › Bodies; the values sit in the Discovery settings),
 * staged scenes, the `bodies.stage` command and harness telemetry. Bodies are drawn by `BodyProps` in the Discovery
 * props; a searched body's contents show in the prompt's strip like a drawer's.
 */
export const outbreakBodiesFeature = registerOutbreakClientFeature({
  id: "bodies",
  order: 29,
  labControls: (host) => [
    ...(bodiesControls as readonly LabControl[]),
    ...BODY_SCENES.map((scene) => ({
      key: `bodyStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Bodies",
      type: "action" as const,
      run: () => {
        if (host.progressionHost.offline()) stageBody(host.discoveryHost, host.session(), scene)
      },
    })),
  ],
  gameCommands: (host) => [
    {
      id: "bodies.stage",
      label: "Stage a Body to Search",
      shortLabel: "Body Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${BODY_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "body") as BodyScene
        if (!BODY_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, body: stageBody(host.discoveryHost, host.session(), scene) }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a body scene (`bodies.stage`); returns the body's store id. */
    stageBody(scene: BodyScene) {
      return stageBody(host.discoveryHost, host.session(), scene)
    },
  }),
  harnessState: (host) => {
    const s = host.discoveryHost.props.bodies.shown
    return { bodies: { lying: [...s.lying], searched: [...s.searched], rising: [...s.rising] } }
  },
})
