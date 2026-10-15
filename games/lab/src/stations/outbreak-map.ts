import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
// map.demo reveals ground around the survivor as if walked, drops two marks and two zombie sightings, and opens the sheet.
const sheet = (style: number, zoom: number): StationCommand[] => [set("mapStyle", style), set("mapMinimap", 0), { command: "map.demo" }, { command: "map.open", args: { zoom } }]
const onScreen = (mode: number): StationCommand[] => [set("mapMinimap", mode), { command: "map.demo" }, { command: "map.close" }]

const variants: StationVariant[] = [
  { id: "survey", label: "Survey paper", note: "Default. N opens the map; drag or two-finger swipe to pan, pinch to zoom, click to mark.", setup: sheet(0, 2.4) },
  { id: "close", label: "Up close", note: "The start street at 7 px/m: safehouses with their workbench, kerbs, hatched roofs.", setup: sheet(0, 7) },
  { id: "noir", label: "Noir survey", note: "The same sheet in the night look.", setup: sheet(1, 2.4) },
  { id: "compass", label: "Compass ring", note: "Optional. A ring on the ground with bearings to marks, teammates, pings and known places.", setup: onScreen(1) },
  { id: "minimap", label: "Corner minimap", note: "Optional. A north-up minimap from the same cached tiles.", setup: onScreen(2) },
]

export default defineStation({
  id: "outbreak-map",
  title: "Outbreak map",
  summary:
    "The live game's map: only what the survivor has seen, kept per 32 m chunk and drawn from cached tiles. Variants are the sheet's two looks and the two optional on-screen helpers, which are off by default to keep the Diegetic HUD clear.",
  order: 114,
  prop: "panels",
  color: 0xd6cbb0,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "survey",
  variants: variants.map((v) => ({ ...v, url: page })),
  metrics: [
    { label: "Map update with the sheet closed, p95 over a 1 km walk", value: "0.6 ms", source: "games/outbreak/scripts/map-proof.ts" },
    { label: "Opening the sheet (tiles prebuilt while walking)", value: "0 tile builds, 4.7 ms first draw", source: "games/outbreak/scripts/map-proof.ts" },
    { label: "Memory per explored chunk", value: "1 KB cells + tiles in a 96 MB LRU", source: "docs/outbreak-map.md" },
  ],
  paths: ["games/outbreak/src/map", "games/outbreak/scripts/map-proof.ts", "docs/outbreak-map.md"],
  branches: ["outbreak-map*"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" },
    { label: "How the map works", href: "https://github.com/anomalyco/arcade/blob/main/docs/outbreak-map.md" },
  ],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [{ widget: "links" }, { widget: "changes" }],
    dock: [{ widget: "variants" }, { widget: "voice" }, { widget: "notes" }],
  },
})
