import { muteOnM, type ControlSettings } from "../controls/settings"
import { registerOutbreakClientFeature } from "../feature-registry"
import { VolumeMenu, type VolumeTarget } from "./menu"

/** The player's volume button and panel (top right); the values are `settings.audio`'s, which the audio applies and saves. */
let menu: VolumeMenu | null = null

export const outbreakVolumeFeature = registerOutbreakClientFeature({
  id: "volume",
  order: 64,
  frame: {
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      const settings = ctx.settings
      menu ??= new VolumeMenu(
        () => settings.audio as unknown as VolumeTarget,
        () => muteOnM(settings.hud as unknown as ControlSettings),
      )
      menu.sync()
    },
  },
  harnessState: () => ({ volume: menu ? { open: menu.isOpen } : null }),
})
