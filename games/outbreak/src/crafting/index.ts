import { registerOutbreakClientFeature } from "../feature-registry"
import { craftingControls, DEFAULT_CRAFTING_SETTINGS } from "./settings"

/** Crafting HUD styles and tips (Lab › Crafting). The drawing lives in `ui.ts`, owned by `InventoryHud`. */
export const outbreakCraftingFeature = registerOutbreakClientFeature({
  id: "crafting",
  order: 21,
  settingsGroup: { subsystem: "crafting", defaults: DEFAULT_CRAFTING_SETTINGS },
  labControls: (host) => [
    ...craftingControls,
    {
      key: "craftForgetTips",
      label: "Forget shown tips",
      group: "Crafting",
      type: "action",
      run: () => host.progressionHost.hud.craft.resetTips(),
    },
  ],
  harnessMethods: (host) => ({
    /** The crafting tip on screen, or null. */
    craftTip() {
      return host.progressionHost.hud.craft.currentTip
    },
    /** Forgets shown crafting tips. */
    resetCraftTips() {
      host.progressionHost.hud.craft.resetTips()
    },
  }),
})
