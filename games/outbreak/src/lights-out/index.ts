import type { LabControl } from "@arcade/kit/lab-panel"
import { lampHeads, lampStoreId, lightsControls, porchSwitch } from "../../shared/lights-out/lights"
import { breakLamp, type LightsState } from "../../shared/lights-out/runtime"
import type { Lamp } from "../../shared/map"
import type { SessionView } from "../../shared/session"
import type { DiscoveryHost } from "../discovery/stage"
import { registerOutbreakClientFeature } from "../feature-registry"
import { currentNightLights } from "../night-lights/presenter"

export const LIGHTS_SCENES = ["lamp-street", "lamp-porch", "lamp-out"] as const
export type LightsScene = (typeof LIGHTS_SCENES)[number]

type StageSession = { sim: Parameters<typeof breakLamp>[0] }

/** The street lamp nearest Ash's house, and the porch light on its front. */
function lamps(view: SessionView): { street: Lamp; porch: Lamp } {
  const ash = view.town.buildings.find((b) => b.id === "ash")!
  const cx = (ash.rect[0] + ash.rect[2]) / 2
  const by = ash.rect[3]
  const d = (l: Lamp) => Math.hypot(l.x - cx, l.y - by)
  const street = view.town.lamps.filter((l) => l.kind === "street").sort((a, b) => d(a) - d(b))[0]!
  const porch = view.town.lamps.filter((l) => l.kind === "porch").sort((a, b) => d(a) - d(b))[0]!
  return { street, porch }
}

/**
 * - `lamp-street`: night, the pistol in hand, a few metres from the street lamp nearest Ash's house and aimed at its
 *   head (fire to shoot it out).
 * - `lamp-porch`: night, on Ash's porch step facing the porch light's switch (E switches it off).
 * - `lamp-out`: the same street lamp already shot out, glass on the pavement, the survivor standing in the dark under it.
 */
export function stageLights(host: DiscoveryHost, session: StageSession, scene: LightsScene): string {
  const view = host.view()
  const ledger = view.progression.ledger
  const { street, porch } = lamps(view)
  for (const l of [street, porch]) {
    if (ledger.store(lampStoreId(l))) ledger.deleteStore(lampStoreId(l))
    if (ledger.store(`glass:${lampStoreId(l)}`)) ledger.deleteStore(`glass:${lampStoreId(l)}`)
  }
  host.setHour(22)
  if (scene === "lamp-porch") {
    const sw = porchSwitch(porch)
    host.pose(sw.x - 0.1, sw.y + 0.7, -Math.PI / 2)
    return lampStoreId(porch)
  }
  const head = lampHeads(street)[0]!
  if (scene === "lamp-out") {
    const state = session.sim.getFeatureState<LightsState>("lights")
    if (state) breakLamp(session.sim, state, street, session.sim.time)
    host.pose(head.x + 0.6, head.y + 0.8, -Math.PI / 2)
    return lampStoreId(street)
  }
  const pistol = view.progression.hotbar(view.actorId)?.slots.findIndex((s) => s?.item === "pistol") ?? -1
  if (pistol >= 0) ledger.apply({ kind: "select", actor: view.actorId, slot: pistol })
  host.pose(head.x - 3.2, head.y + 3.2, Math.atan2(-3.2, 3.2))
  return lampStoreId(street)
}

/**
 * Lights Out (AR-56), client half: Lab tunables (Backquote › Lights out; the values sit in the Discovery settings),
 * staged scenes, the `lights.stage` command and harness telemetry. Dark lamps are trimmed in the night-lights
 * presenter (`trimLamp`); the glass is the verbs' glass, and `InventorySounds` plays the pop and the switch.
 */
export const outbreakLightsFeature = registerOutbreakClientFeature({
  id: "lights",
  order: 27,
  labControls: (host) => [
    ...(lightsControls as readonly LabControl[]),
    ...LIGHTS_SCENES.map((scene) => ({
      key: `lightsStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Lights out",
      type: "action" as const,
      run: () => {
        if (host.progressionHost.offline()) stageLights(host.discoveryHost, host.session(), scene)
      },
    })),
  ],
  gameCommands: (host) => [
    {
      id: "lights.stage",
      label: "Stage a Lights Out Scene",
      shortLabel: "Lights Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${LIGHTS_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "lamp-street") as LightsScene
        if (!LIGHTS_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, lamp: stageLights(host.discoveryHost, host.session(), scene) }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a Lights Out scene (`lights.stage`); returns the lamp's store id. */
    stageLights(scene: LightsScene) {
      return stageLights(host.discoveryHost, host.session(), scene)
    },
  }),
  harnessState: (host) => {
    const view = host.session().view
    const dark: string[] = []
    for (const st of view.progression.ledger.stores.values()) if (st.id.startsWith("lamp:") && (st.counts.broken || st.counts.off)) dark.push(st.id)
    return { lightsOut: { dark, trimmed: currentNightLights()?.shown.dark ?? 0 } }
  },
})
