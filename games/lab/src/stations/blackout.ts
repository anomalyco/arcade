import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const effects = [
  ["shot", "Fire at surface"],
  ["muzzle", "Muzzle flash"],
  ["tracer", "Tracers"],
  ["impact", "Impact sparks"],
  ["glass", "Glass shards"],
  ["blood", "Blood"],
] as const

export default defineStation({
  id: "blackout",
  title: "Blackout",
  summary: "Blackout's own weapon and impact effects in its office level, driven by the game's code through the Lab adapter.",
  order: 110,
  prop: "office",
  color: 0x5b7bd6,
  status: "live",
  demo: { kind: "section", section: "blackout-effects", game: "blackout" },
  variants: effects.map(([id, label]): StationVariant => ({
    id,
    label,
    setup: [{ command: "scene.set-param", args: { key: "effect", value: id } }, { command: "effect.trigger", args: { seed: 7 } }],
  })),
  board: { feature: "AR-15" },
  paths: ["games/blackout/src/lab", "games/blackout/src/render"],
  links: [{ label: "Play Blackout", href: "/arcade/blackout/?peaceful=1&seed=1" }],
})
