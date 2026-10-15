import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const effects = [
  ["explosion", "Explosion"],
  ["sparks", "Sparks"],
  ["skids", "Skids"],
  ["nitro", "Nitro flame"],
  ["pops", "Exhaust pops"],
  ["hydrant", "Hydrant water"],
  ["tyre", "Tyre smoke"],
] as const

export default defineStation({
  id: "getaway",
  title: "Getaway",
  summary: "Getaway's car effects on its street chunk, from the game's own emitters: skids, sparks, nitro, exhaust and crashes.",
  order: 120,
  prop: "car",
  color: 0xe5484d,
  status: "live",
  demo: { kind: "section", section: "getaway-effects", game: "getaway" },
  variants: effects.map(([id, label]): StationVariant => ({
    id,
    label,
    setup: [{ command: "scene.set-param", args: { key: "effect", value: id } }, { command: "effect.trigger", args: { seed: 7 } }],
  })),
  board: { feature: "AR-15" },
  paths: ["games/getaway/src/lab", "games/getaway/src/fx"],
  links: [{ label: "Play Getaway", href: "/arcade/getaway/?peaceful=1&seed=7" }],
})
