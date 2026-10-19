import type { LabCommand } from "@arcade/kit/lab/commands"
import type { LabControl } from "@arcade/kit/lab-panel"
import type { Town } from "../../shared/map"
import type { DiscoveryHost } from "../discovery/stage"
import { registerOutbreakClientFeature } from "../feature-registry"
import { currentFx } from "../scene/fx-particles"
import type { OutbreakSettings } from "../settings"
import { airControls, DEFAULT_AIR_SETTINGS } from "./settings"
import { smokeSources, type SmokeSource } from "./smoke"

const SCENES = ["steam", "car"] as const
type AirScene = (typeof SCENES)[number]

/**
 * Stages the night air: 22:00, the survivor five metres short of a venting manhole (`steam`) or a smouldering car
 * (`car`), beam on it. Picks a source that smokes under the current settings, nearest the start; with none venting it
 * turns that kind on.
 */
function stageAir(host: DiscoveryHost, settings: OutbreakSettings, town: Town, scene: AirScene): SmokeSource | null {
  const air = settings.air
  air.worldSmoke = 1
  const kinds = scene === "car" ? ["car"] : ["steam", "drain"]
  let pick = smokeSources(town, air).filter((s) => kinds.includes(s.kind))
  if (!pick.length) {
    if (scene === "car") air.smokeCars = Math.max(air.smokeCars, 1)
    else air.smokeManholes = Math.max(air.smokeManholes, 1)
    pick = smokeSources(town, air).filter((s) => kinds.includes(s.kind))
  }
  const ash = town.buildings.find((b) => b.id === "ash")
  const from = ash ? { x: (ash.rect[0] + ash.rect[2]) / 2, z: ash.rect[3] + 7 } : { x: pick[0]?.x ?? 0, z: pick[0]?.z ?? 0 }
  pick.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z))
  const src = pick[0]
  if (!src) return null
  host.setHour(22)
  host.pose(src.x - 4.6, src.z + 1.6, Math.atan2(-1.6, 4.6))
  return src
}

/**
 * The air (client only): world smoke (Lab › World smoke) and the beam dust (Lab › Beam dust). Both are drawn from
 * `scene/frame-renderer.ts`: smoke through the kit particle pool (`scene/fx-particles.ts`), dust by `air/dust.ts`.
 */
export const outbreakAirFeature = registerOutbreakClientFeature({
  id: "air",
  order: 30,
  settingsGroup: { subsystem: "air", defaults: DEFAULT_AIR_SETTINGS },
  labControls: (host) => [
    ...airControls,
    ...SCENES.map(
      (scene): LabControl => ({
        key: `airStage-${scene}`,
        label: scene === "steam" ? "Stage: steam in the beam" : "Stage: smouldering car",
        group: "World smoke",
        type: "action",
        run: () => {
          if (host.progressionHost.offline()) stageAir(host.discoveryHost, host.settings, host.session().view.town, scene)
        },
      }),
    ),
  ],
  gameCommands: (host): LabCommand[] => [
    {
      id: "air.stage",
      label: "Stage Night Smoke and Beam Dust",
      shortLabel: "Smoke Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "steam") as AirScene
        if (!SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        return { scene, source: stageAir(host.discoveryHost, host.settings, host.session().view.town, scene) }
      },
    },
  ],
  harnessState: () => ({ fx: currentFx()?.stats() ?? null }),
  harnessMethods: (host) => ({
    /** Stages night smoke in the beam (`air.stage`). */
    stageAir(scene: AirScene = "steam") {
      return stageAir(host.discoveryHost, host.settings, host.session().view.town, scene)
    },
  }),
})
