import { houseVariety, houseVarietyKey } from "../../shared/houses/variety"
import { LocalSession } from "../../shared/session"
import { registerOutbreakClientFeature } from "../feature-registry"
import { HOUSE_VARIETY_KEYS, houseVarietyControls, syncHouseVariety } from "./settings"

/**
 * Varied houses (AR-79): Lab › World · Variety. The generator lives in `shared/houses/`; the client draws styled homes
 * in `exterior.ts` and `grounds.ts` from the chunk streamer. A change regenerates the offline world (co-op rooms keep
 * the default houses: `regenerate` only rebuilds the level there).
 */
export const outbreakHousesFeature = registerOutbreakClientFeature({
  id: "houses",
  order: 47,
  labControls: () => houseVarietyControls,
  onSettingChanged: (host, rawKey, routed) => {
    const key = routed?.field ?? rawKey
    if (!HOUSE_VARIETY_KEYS.has(key)) return false
    if (!(host.session() instanceof LocalSession)) return true
    if (syncHouseVariety(host.settings.world)) host.regenerate()
    return true
  },
  harnessState: () => ({ houses: { key: houseVarietyKey(), enabled: houseVariety.enabled } }),
})
