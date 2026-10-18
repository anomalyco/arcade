import type { LabControl } from "@arcade/kit/lab-panel"
import { registerOutbreakClientFeature } from "../feature-registry"
import type { OutbreakLabControlHost } from "../lab-controls"
import { propDressingState } from "../props/state"
import { setOutbreakSetting, type OutbreakSettings } from "../settings"
import { HERO_STYLE_SURFACES, heroLookControls } from "./hero"
import { lookPreset, OUTBREAK_LOOK_PRESETS } from "./presets"
import { DEFAULT_LOOK_TRIMS, lookTrimControls } from "./world"

/** The start house at dusk, Outbreak's default start: the survivor on the front walk looking up at the porch. */
export const START_HOUSE_VIEW = { x: 27.7, y: 41, aim: -Math.PI / 2, hour: 17.5, zoom: 40 } as const

/** Sets every Look knob from a curated preset; returns false for an unknown id. */
export function applyLookPreset(settings: OutbreakSettings, id: string): boolean {
  const preset = lookPreset(id)
  if (!preset) return false
  for (const [key, value] of Object.entries(preset.knobs)) setOutbreakSetting(settings, key, value)
  propDressingState.modelStyle = preset.knobs.modelStyle
  if (id === "today") settings.zombies.zombieLook = 1
  settings.look.lookIdea = preset.id
  return true
}

const PRESETS_GROUP = "Look · Presets"

function controls(host: OutbreakLabControlHost): LabControl[] {
  return [
    {
      key: "lookIdea",
      label: "Look idea",
      group: PRESETS_GROUP,
      options: OUTBREAK_LOOK_PRESETS.map(p => ({ label: `${p.label} · v${p.version}`, value: p.id })),
    },
    {
      key: "lookReset",
      label: "Reset to today",
      group: PRESETS_GROUP,
      type: "action",
      run: () => {
        applyLookPreset(host.settings, DEFAULT_LOOK_TRIMS.lookIdea)
        host.lab().refresh()
      },
    },
    ...heroLookControls,
    {
      key: "zombieLook",
      label: "Zombie look",
      group: "Look · Hero",
      options: [
        { label: "Today (boxes)", value: 0 },
        { label: "Former Townsfolk", value: 1 },
        { label: "Former Townsfolk (v1)", value: 2 },
      ],
    },
    ...lookTrimControls,
  ]
}

export const outbreakLookFeature = registerOutbreakClientFeature({
  id: "look",
  order: 15,
  settingsGroup: { subsystem: "look", defaults: DEFAULT_LOOK_TRIMS },
  labControls: controls,
  onSettingChanged: (host, rawKey, routed, value) => {
    const key = routed?.field ?? rawKey
    if (key === "lookIdea") {
      applyLookPreset(host.settings, String(value ?? host.settings.look.lookIdea))
      host.lab().refresh()
      return true
    }
    if (key === "modelStyle") {
      const v = Math.max(0, Math.min(3, Math.round(Number(value ?? host.settings.look.modelStyle))))
      host.settings.look.modelStyle = v
      propDressingState.modelStyle = v
      host.lab().refresh()
      return true
    }
    if (key === "heroStyle") {
      // A style brings its own tone, rim and flatness; the knobs then tune from there.
      Object.assign(host.settings.survivor, HERO_STYLE_SURFACES[Math.round(Number(value ?? host.settings.survivor.heroStyle))] ?? {})
      host.lab().refresh()
      return true
    }
    return false
  },
  gameCommands: host => [
    {
      id: "look.preset",
      label: "Apply an Outbreak Look Preset",
      shortLabel: "Look Preset",
      category: "Scene",
      undoable: false,
      args: { preset: { type: "string", description: `Preset (${OUTBREAK_LOOK_PRESETS.map(p => p.id).join(", ")})` } },
      enabled: () => true,
      run: (_ctx, args) => {
        const id = String(args?.preset ?? "today")
        if (!applyLookPreset(host.settings, id)) throw new Error(`Unknown look preset ${id}`)
        host.lab.refresh()
        return { preset: id }
      },
    },
  ],
  harnessMethods: host => ({
    /** Applies a curated Look preset (`look.preset`). */
    lookPreset(id: string) {
      if (!applyLookPreset(host.settings, id)) throw new Error(`Unknown look preset ${id}`)
    },
  }),
  harnessState: host => ({
    look: { idea: host.settings.look.lookIdea, heroStyle: host.settings.survivor.heroStyle },
  }),
})
