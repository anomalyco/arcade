import type { LabControl } from "@arcade/kit/lab-panel"
import type { OutbreakAISubsystem } from "../../shared/ai"
import { dogControls, dogSites, type DogSite } from "../../shared/dogs/dogs"
import { ds } from "../../shared/radios/radios"
import type { SessionView } from "../../shared/session"
import type { DiscoveryHost } from "../discovery/stage"
import { registerOutbreakClientFeature } from "../feature-registry"

export const DOG_SCENES = ["dog", "dog-fed", "dog-dead"] as const
export type DogScene = (typeof DOG_SCENES)[number]

type StageSession = { ai: OutbreakAISubsystem }

const lookControls: LabControl[] = [
  { key: "dogLunge", label: "Dog lunges on its chain", group: "Dogs", min: 0, max: 3, step: 0.1, unit: "×" },
  { key: "dogWag", label: "Tail wag", group: "Dogs", min: 0, max: 3, step: 0.1, unit: "×" },
]

/** The chained dog nearest the start. */
function nearestDog(view: SessionView): DogSite {
  const d = (s: DogSite) => Math.hypot(s.x - 30, s.y - 40)
  const dog = dogSites(view.town).sort((a, b) => d(a) - d(b))[0]
  if (!dog) throw new Error("No dog in this world")
  return dog
}

/**
 * - `dog`: dusk, a few steps from the chained dog nearest the start, a tin of food in hand; it barks (E feeds it).
 * - `dog-fed`: the same dog just fed, wagging at the survivor.
 * - `dog-dead`: the same dog, killed by the dead.
 */
export function stageDog(host: DiscoveryHost, session: StageSession, scene: DogScene): string {
  const view = host.view()
  const ledger = view.progression.ledger
  const d = nearestDog(view)
  for (const z of session.ai.agents) z.state = "dead"
  if (ledger.store(d.id)) ledger.deleteStore(d.id)
  const t = ds(view.time)
  const counts: Record<string, number> = scene === "dog-fed" ? { bark: 0, dead: 0, fed: 1, hush: t + 1200 } : scene === "dog-dead" ? { bark: 0, dead: 1 } : { bark: 0, dead: 0 }
  ledger.createStore({ id: d.id, mode: "counters", scope: "shared", at: { x: d.x, y: d.y }, initial: counts })
  const have = ledger.count(view.actorId, "food")
  if (have < 2) ledger.apply({ kind: "grant", actor: view.actorId, item: "food", count: 2 - have })
  const slot = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === "food") ?? -1
  if (slot >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot })
  host.setHour(19.2)
  const side = d.kennel.x > d.x ? -1 : 1
  host.pose(d.x + side * (d.chain + 0.7), d.y + 1.2, Math.atan2(-1.2, -side * (d.chain + 0.7)))
  return d.id
}

/**
 * Chained dogs (AR-56), client half: Lab tunables (Backquote › Dogs; the values sit in the Discovery settings),
 * staged scenes, the `dogs.stage` command and harness telemetry. Dogs are drawn by `DogProps` in the Discovery props
 * and barked by `InventorySounds` from their stores.
 */
export const outbreakDogsFeature = registerOutbreakClientFeature({
  id: "dogs",
  order: 30,
  labControls: (host) => [
    ...(dogControls as readonly LabControl[]),
    ...lookControls,
    ...DOG_SCENES.map((scene) => ({
      key: `dogStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Dogs",
      type: "action" as const,
      run: () => {
        if (host.progressionHost.offline()) stageDog(host.discoveryHost, host.session(), scene)
      },
    })),
  ],
  gameCommands: (host) => [
    {
      id: "dogs.stage",
      label: "Stage a Chained Dog Scene",
      shortLabel: "Dog Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${DOG_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "dog") as DogScene
        if (!DOG_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, dog: stageDog(host.discoveryHost, host.session(), scene) }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a chained dog scene (`dogs.stage`); returns the dog's store id. */
    stageDog(scene: DogScene) {
      return stageDog(host.discoveryHost, host.session(), scene)
    },
  }),
  harnessState: (host) => ({ dogs: { ...host.discoveryHost.props.dogs.shown } }),
})
