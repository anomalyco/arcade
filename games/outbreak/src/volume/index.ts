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
      menu ??= new VolumeMenu(() => ctx.settings.audio as unknown as VolumeTarget)
      menu.sync()
    },
  },
  harnessState: () => ({ volume: menu ? { open: menu.isOpen } : null }),
})
