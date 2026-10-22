import { WORLD_PRESETS } from "@arcade/kit/lab/world/presets"
import { defineStation } from "./define"

export default defineStation({
  id: "sky",
  title: "Sky",
  summary: "Catalogue stars, Milky Way, airglow and the Moon in the shared debug world.",
  order: 6,
  status: "in-progress",
  demo: { kind: "section", section: "world", setup: [{ command: "world.preset", args: { preset: "sky-moonless" } }] },
  defaultVariant: "sky-moonless",
  variants: WORLD_PRESETS.filter(p => p.idea === "sky").map(p => ({ id: p.id, label: p.label, setup: [{ command: "world.preset", args: { preset: p.id } }] })),
  paths: ["packages/kit/sky", "packages/kit/weather"],
  branches: ["night-sky", "weather-realism"],
  layout: { left: [{ widget: "status" }], right: [{ widget: "controls", groups: ["Sky"], title: "Sky" }], dock: [{ widget: "variants" }, { widget: "compare" }] },
})
