import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

// The arachnid gait walking a slow loop through the night forest, on the forest renderer. Distant is the first sight
// (45–60 m between the trunks), Walks past stands 20–30 m off it, Near follows it at 20 m, Walk is free.
const page = "/arcade/lab/spider.html"
const set = (key: string, value: number | boolean | string): StationCommand => ({ command: "scene.set-param", args: { key, value } })
const camera = (id: string, label: string, note: string): StationVariant => ({ id, group: "Camera", label, note, setup: [set("spider.camera", id)] })
const shape = (id: string, label: string, note: string, values: Record<string, number>): StationVariant =>
  ({ id: `shape-${id}`, group: "Shape", label, note, setup: Object.entries(values).map(([k, v]) => set(`spider.${k}`, v)) })

const variants: StationVariant[] = [
  camera("distant", "Distant", "The first sight: standing still 45–60 m off, it crosses between the trunks through a friend's sweeping beam."),
  camera("pass", "Walks past", "Standing 20–30 m off its path on a longer lens that holds the body and every leg."),
  camera("near", "Near", "20 m off its flank, following, to judge the feet and the body."),
  camera("walk", "Walk", "Free: click the woods, WASD, F for the torch."),
  shape("harvestman", "Harvestman", "Body scale 3.5, legs × 2.5, body 0.55: a large body slung high, stepping slowly and softly.", { size: 3.5, legs: 2.5, hips: 0.55, ride: 0.42, swing: 1.5, lift: 1.6 }),
  shape("tall", "Taller", "Legs × 3: the body up near the lowest branches.", { size: 3.5, legs: 3, hips: 0.5, ride: 0.46, swing: 1.6, lift: 1.6 }),
  shape("wolf", "Wolf spider", "Lamplight's spider exactly, horse-sized: low, wide and quick.", { size: 3.5, legs: 1, hips: 1, ride: 0.34, swing: 1, lift: 0.8 }),
]

export default defineStation({
  id: "spider-gait",
  title: "Spider gait",
  summary:
    "Lamplight's arachnid, ported to the kit: eight world-space feet in two alternating groups, at least four always down, a planted foot never moves. Here as a harvestman-proportioned giant walking slowly through the night forest. Size, leg length, height and step timing are on the panel (Spider).",
  order: 210,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["distant", "shape-harvestman"],
  variants: variants.map(v => ({ ...v, url: page })),
  metrics: [
    { label: "Duty factor, walk / run (lamplight 0.656 / 0.514)", value: "0.63–0.68 / 0.50–0.55", source: "packages/kit/creature/arachnid-legs.test.ts" },
    { label: "Planted-foot slip, 40 s route through trunks", value: "0", source: "scripts/arachnid-motion-check.ts" },
  ],
  paths: ["packages/kit/creature/arachnid-legs.ts", "packages/kit/sim/creature-motion.ts", "packages/kit/creature/arachnid-view.ts"],
  branches: ["spider-*"],
  layout: {
    right: [{ widget: "controls", groups: ["Spider"], title: "Spider" }],
    dock: [{ widget: "variants" }],
  },
})
