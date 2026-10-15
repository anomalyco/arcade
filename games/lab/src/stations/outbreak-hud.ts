import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const sample = { command: "hud.demo" }
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const style = (value: number) => [set("hudStyle", value), set("calloutPlacement", -1), set("vitalsPlacement", -1), set("avoidAim", true), sample]

// The same five directions as the board's D-13 prototype; each is one Lab "HUD style".
const variants: StationVariant[] = [
  { id: "today", boardOption: "1", label: "Today", note: "Callouts above the head, bars over the hotbar.", setup: style(0) },
  { id: "below", boardOption: "2", label: "Below Feet", note: "Default. Hold Shift to sprint and watch the stamina ring.", setup: style(1) },
  { id: "hades", boardOption: "3", label: "Hades Style", note: "Thin bars under the feet, quiet screen edges.", setup: style(2) },
  { id: "zomboid", boardOption: "4", label: "Zomboid Style", note: "Action bar over the head, status icons top-right.", setup: style(3) },
  { id: "diegetic", boardOption: "5", label: "Diegetic", note: "Stamina and health on the ground, hotbar only on change.", setup: style(4) },
]

export default defineStation({
  id: "outbreak-hud",
  title: "Outbreak HUD",
  summary:
    "The live game with the character HUD. Variants are the five HUD styles from the board decision: callouts, stamina, reload, health and battery placed on the survivor or at the edge.",
  order: 112,
  prop: "figure",
  color: 0xe0b45a,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "below",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-24", decision: "D-13" },
  metrics: [
    { label: "hud.update p95, 3 callouts + rings + teammate", value: "0.2 ms", source: "captures/outbreak-hud/summary.json (hud-proof.ts)" },
  ],
  paths: ["games/outbreak/src/hud", "games/outbreak/scripts/hud-proof.ts"],
  branches: ["outbreak-hud*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
