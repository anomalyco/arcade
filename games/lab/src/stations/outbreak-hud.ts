import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const sample = { command: "hud.demo" }
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const defaults = [set("calloutPlacement", 0), set("vitalsPlacement", 0), set("avoidAim", true)]

const variants: StationVariant[] = [
  { id: "below", label: "Callouts below", note: "Default. Hold Shift to sprint and watch the stamina ring.", setup: [...defaults, sample] },
  { id: "above", label: "Callouts above", note: "The previous placement.", setup: [...defaults, set("calloutPlacement", 1), sample] },
  { id: "beside", label: "Callouts beside", setup: [...defaults, set("calloutPlacement", 2), sample] },
  { id: "feet", label: "Rings under feet", setup: [...defaults, set("vitalsPlacement", 1), sample] },
  { id: "edge", label: "Bars at screen edge", note: "Stamina and battery as the old bottom bars.", setup: [...defaults, set("vitalsPlacement", 2), sample] },
  { id: "pinned", label: "Below, no aim avoidance", note: "Callouts stay below even when you aim down.", setup: [...defaults, set("avoidAim", false), sample] },
]

export default defineStation({
  id: "outbreak-hud",
  title: "Outbreak HUD",
  summary:
    "The live game with the character HUD: action callouts under the survivor and stamina, reload, health and battery rings beside them. Variants switch placement.",
  order: 112,
  prop: "figure",
  color: 0xe0b45a,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "below",
  variants: variants.map((v) => ({ ...v, url: page })),
  metrics: [
    { label: "hud.update p95, 3 callouts + rings + teammate", value: "0.2 ms", source: "captures/outbreak-hud/summary.json (hud-proof.ts)" },
  ],
  paths: ["games/outbreak/src/hud", "games/outbreak/scripts/hud-proof.ts"],
  branches: ["outbreak-hud*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
