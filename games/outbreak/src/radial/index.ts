import { registerOutbreakClientFeature } from "../feature-registry"
import { radialControls, type RadialSettings } from "./settings"
import { radialInteract } from "./state"
import { RadialView } from "./view"

/** The radial E menu (Backquote › Controls › E actions): the input drives `radialInteract`, this draws it. */
let view: RadialView | null = null
radialInteract.onReset = () => view?.draw(radialInteract, 0)

export const outbreakRadialFeature = registerOutbreakClientFeature({
  id: "radial",
  order: 66,
  labControls: () => radialControls,
  frame: {
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      if (!view && !radialInteract.isOpen) return
      view ??= new RadialView()
      view.draw(radialInteract, (ctx.settings.hud as unknown as RadialSettings).radialRadius)
    },
  },
  harnessState: () => ({ radial: { phase: radialInteract.phase, shown: view?.shown ? { ...view.shown } : null } }),
})
