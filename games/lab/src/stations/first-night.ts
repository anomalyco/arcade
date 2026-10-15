import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7"
const stage = (scene: string, pause = true): StationCommand[] => [
  ...(pause ? [{ command: "scene.set-param", args: { key: "timeScale", value: 0 } }] : []),
  { command: "pacing.stage", args: { scene } },
]

const variants: StationVariant[] = [
  {
    id: "opening-calm",
    label: "Opening calm (16:30)",
    note: "20 m safe radius around spawn & Ash House (0 zombies within 15 m, 0 inside Ash), 7 spaced solitary shamblers across the block, and warm late-afternoon light.",
    setup: stage("opening-calm", false),
  },
  {
    id: "safehouse-workbench",
    label: "Safehouse & workbench (16:48)",
    note: "Late-afternoon window light (0.78 >= 0.35 required) lets the player search Ash House and research at the workbench before night falls without draining the flashlight.",
    setup: stage("safehouse-workbench"),
  },
  {
    id: "first-contact",
    label: "First encounter (17:50 dusk)",
    note: "After exploring the safehouse, 1–2 shamblers drift into the street corridor outside as dusk settles and streetlamps warm up.",
    setup: stage("first-contact"),
  },
  {
    id: "late-night-horde",
    label: "Late night & loud noise (22:30)",
    note: "Full nocturnal threat and gunshot heat: active chasers capped by Max active near player (4 solo, scaled in co-op) while outer roamers prowl the perimeter.",
    setup: stage("late-night-horde"),
  },
  {
    id: "legacy-rush",
    label: "Before: Unpaced rush (18:00)",
    note: "Legacy t = 0 state (directorPacing = 0, safeRadius = 3.5 m, initialDensity = 1.0, hour = 18:00): 11 zombies within 15 m including lawn and Ash interior.",
    setup: stage("legacy-rush"),
  },
]

export default defineStation({
  id: "first-night",
  title: "Outbreak first-night pacing",
  summary:
    "Opening safe radius around the safehouse, sparse initial shamblers, late-afternoon 16:30 start for workbench light, first 1–3 zombie dusk encounter, and time/exploration/noise/threat ramp with co-op scaling. Tunables live in the Pacing group.",
  order: 114,
  prop: "house",
  color: 0xd98a3c,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "opening-calm",
  variants: variants.map((v) => ({ ...v, url: page })),
  metrics: [
    { label: "Zombies within 15 m / 30 m at t = 0 (solo)", value: "16 → 0 / 26 → 4", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
    { label: "First contact time / peak simultaneous chasers (solo)", value: "0.1 s → 43.85 s / 22 → 4", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
    { label: "4-player co-op peak simultaneous chasers", value: "23 → 11 (scaled by player count)", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
  ],
  paths: [
    "games/outbreak/shared/pacing.ts",
    "games/outbreak/shared/ai.ts",
    "games/outbreak/scripts/prove-first-night.ts",
    "games/outbreak/tests/pacing.test.ts",
  ],
  branches: ["first-night"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" },
    { label: "Inventory and workbench", href: "/arcade/lab/?overworld&station=outbreak-progression" },
  ],
})
