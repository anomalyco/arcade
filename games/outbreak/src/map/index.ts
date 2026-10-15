import { registerOutbreakClientFeature } from "../feature-registry"
import { DEFAULT_MAP_SETTINGS, mapControls } from "./settings"

export const outbreakMapFeature = registerOutbreakClientFeature({
  id: "map",
  order: 50,
  settingsGroup: {
    subsystem: "map",
    defaults: DEFAULT_MAP_SETTINGS,
  },
  labControls: () => mapControls,
  onSettingChanged: (host, rawKey, routed) => {
    if (routed?.subsystem === "map" || rawKey in DEFAULT_MAP_SETTINGS) {
      host.map.applySettings()
      return true
    }
    return false
  },
  gameCommands: (host) => (host.map ? host.map.labCommands() : []),
  harnessMethods: (host) => (host.map ? { map: host.map } : {}),
})
