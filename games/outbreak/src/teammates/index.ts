import { registerOutbreakClientFeature } from "../feature-registry"
import { TeammateMarkers } from "./markers"
import { teammateMarkerControls } from "./settings"

/** Teammate markers: where everyone is when out of sight or off screen (Backquote › HUD › Teammates). */
let markers: TeammateMarkers | null = null

export const outbreakTeammatesFeature = registerOutbreakClientFeature({
  id: "teammates",
  order: 62,
  labControls: () => teammateMarkerControls,
  frame: {
    overlay: (ctx) => {
      if (typeof document === "undefined") return
      markers ??= new TeammateMarkers()
      markers.draw(ctx)
    },
  },
  harnessState: () => ({ teammates: markers ? { drawn: markers.drawn.map((d) => ({ ...d })) } : null }),
})
