import type { LabControl } from "@arcade/kit/lab-panel"
import { radioControls, radioSites, radioState } from "../../shared/radios/radios"
import { registerOutbreakClientFeature } from "../feature-registry"
import { RADIO_SCENES, stageRadio, type RadioScene } from "./stage"

const lookControls: LabControl[] = [
  { key: "radioDialGlow", label: "Dial glow while playing", group: "Radios", min: 0, max: 6, step: 0.1, unit: "×" },
  { key: "radioShake", label: "Cabinet shake", group: "Radios", min: 0, max: 3, step: 0.1, unit: "×" },
]

/**
 * House radios (AR-56), client half: Lab tunables (Backquote › Radios; the values sit in the Discovery settings),
 * staged scenes, the `radios.stage` command and harness telemetry. The props are drawn by `RadioProps` inside the
 * Discovery props, and `InventorySounds` plays them from the ledger.
 */
export const outbreakRadiosFeature = registerOutbreakClientFeature({
  id: "radios",
  order: 26,
  labControls: (host) => [
    ...(radioControls as readonly LabControl[]),
    ...lookControls,
    ...RADIO_SCENES.map((scene) => ({
      key: `radioStage-${scene}`,
      label: `Stage: ${scene.replace(/-/g, " ")}`,
      group: "Radios",
      type: "action" as const,
      run: () => {
        if (!host.progressionHost.offline()) return
        stageRadio(host.discoveryHost, host.session(), scene, host.settings.discovery.radioBattery)
      },
    })),
  ],
  gameCommands: (host) => [
    {
      id: "radios.stage",
      label: "Stage a House Radio Scene",
      shortLabel: "Radio Scene",
      category: "Scene",
      undoable: false,
      args: { scene: { type: "string", description: `Scene (${RADIO_SCENES.join(", ")})` } },
      enabled: () => !host.coop.net,
      run: (_ctx, args) => {
        const scene = String(args?.scene ?? "radio-playing") as RadioScene
        if (!RADIO_SCENES.includes(scene)) throw new Error(`Unknown scene ${scene}`)
        const site = stageRadio(host.discoveryHost, host.session(), scene, host.settings.discovery.radioBattery)
        return { scene, radio: site.id }
      },
    },
  ],
  harnessMethods: (host) => ({
    /** Stages a radio scene (`radios.stage`); returns the radio's site. */
    stageRadio(scene: RadioScene) {
      return stageRadio(host.discoveryHost, host.session(), scene, host.settings.discovery.radioBattery)
    },
  }),
  harnessState: (host) => {
    const view = host.session().view
    return {
      radios: {
        shown: { ...host.discoveryHost.props.radios.shown },
        states: Object.fromEntries(radioSites(view.town).map((s) => [s.id, radioState(view.progression.ledger.store(s.id), view.time)])),
      },
    }
  },
})
