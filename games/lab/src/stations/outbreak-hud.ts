import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
// hud.demo puts a sample on the survivor: an action in progress, loot pops, half-spent stamina and a hit.
const style = (value: number) => [set("hudStyle", value), set("calloutPlacement", -1), set("vitalsPlacement", -1), set("avoidAim", true), { command: "hud.demo" }]

// The same five directions as the board's D-13 prototype; each is one Lab "HUD style" (Backquote › HUD in the page).
const variants: StationVariant[] = [
  { id: "today", boardOption: "1", label: "Today", note: "Callouts above the head, stamina and battery as bars over the hotbar.", setup: style(0) },
  { id: "below", boardOption: "2", label: "Below Feet", note: "Default. Callouts under the survivor, rings beside them. Hold Shift to sprint.", setup: style(1) },
  { id: "hades", boardOption: "3", label: "Hades Style", note: "Thin bars under the feet, no summary, dimmed hotbar.", setup: style(2) },
  { id: "zomboid", boardOption: "4", label: "Zomboid Style", note: "Outlined text and an action bar over the head, status icons top right.", setup: style(3) },
  { id: "diegetic", boardOption: "5", label: "Diegetic", note: "Stamina and health as a ground ring; the hotbar shows only after a slot change.", setup: style(4) },
]

export default defineStation({
  id: "outbreak-hud",
  title: "Outbreak HUD",
  summary:
    "The live game with the character HUD. Variants are the five HUD styles on the board decision: where callouts, stamina, reload, health and battery sit. Each shows a sample on the survivor; play to see it live.",
  order: 112,
  prop: "figure",
  color: 0xe0b45a,
  status: "review",
  statusNote: "D-13 waiting on Kit",
  demo: { kind: "page", url: page },
  defaultVariant: "below",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-24", decision: "D-13" },
  metrics: [
    { label: "hud.update p95, 3 callouts + rings + teammate", value: "0.2 ms", source: "games/outbreak/scripts/hud-proof.ts (docs/outbreak-hud.md)" },
    { label: "Style + layout vs old log, 7 pairs", value: "−0.005 ms/frame (inside spread)", source: "games/outbreak/scripts/hud-proof.ts" },
    { label: "Script vs old log, 7 pairs", value: "+0.033 ms/frame", source: "games/outbreak/scripts/hud-proof.ts" },
    { label: "Proof stills (styles × Noir/70s, stamina states, crowd)", value: "47", source: "games/outbreak/scripts/hud-proof.ts" },
  ],
  paths: ["games/outbreak/src/hud", "games/outbreak/scripts/hud-proof.ts", "games/outbreak/scripts/hud-moment.ts", "docs/outbreak-hud.md"],
  branches: ["outbreak-hud*"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" },
    { label: "Research and defaults", href: "https://github.com/anomalyco/arcade/blob/main/docs/outbreak-hud.md" },
  ],
  // A page demo has no Lab section, so no controls or compare cards; the HUD knobs are in the page's own Lab panel.
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [{ widget: "links" }, { widget: "changes" }],
    dock: [{ widget: "variants" }, { widget: "voice" }, { widget: "notes" }],
  },
})
