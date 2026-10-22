import { registerOutbreakClientFeature } from "../feature-registry"
import { skyControls } from "@arcade/kit/sky/settings"
import { renderSky } from "./render"

registerOutbreakClientFeature({
  id: "sky",
  order: 6,
  labControls: () => skyControls(),
  frame: { render: renderSky },
})
