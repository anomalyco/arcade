import { WORLD_PRESETS } from "@arcade/kit/lab/world/presets"
import { defineStation } from "./define"

export default defineStation({
  id: "look-and-world",
  title: "Look and world",
  summary:
    "One small street — a house corner with a doorway and a window, a lamp, a tree, a puddle, a figure and a car — on the kit renderer, with the kit look, weather, floor materials and foliage. Tabs for Look, Light, Weather, Materials and Vegetation; each idea is a preset.",
  order: 5,
  prop: "house",
  color: 0xc77dff,
  status: "in-progress",
  demo: { kind: "section", section: "world", setup: [{ command: "world.preset", args: { preset: "day" } }] },
  defaultVariant: "day",
  variants: WORLD_PRESETS.map(p => ({ id: p.id, label: p.label, note: p.note, setup: [{ command: "world.preset", args: { preset: p.id } }] })),
  board: { feature: "AR-12" },
  paths: ["packages/kit/lab/world", "packages/kit/gpu/look.ts", "packages/kit/weather", "packages/kit/gpu/foliage.ts", "packages/kit/gpu/shaders.ts"],
  branches: ["lab-cleanup", "lab-world-*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?peaceful=1&seed=7" }],
  // Details carries every knob, tabbed by idea; the dock holds the presets and the A/B wipe.
  layout: { left: [{ widget: "status" }], right: [], dock: [{ widget: "variants" }, { widget: "compare" }] },
})
