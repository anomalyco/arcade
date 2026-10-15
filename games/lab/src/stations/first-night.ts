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
    label: "Opening calm (17:30 dusk)",
    note: "Starts in the Noir palette: 20 m safe radius around spawn & Ash House (0 zombies within 15 m, 0 inside Ash), 7 spaced solitary shamblers, and an opening clock at 0.25x so 18:00 arrives about 60 s in.",
    setup: stage("opening-calm", false),
  },
  {
    id: "safehouse-workbench",
    label: "Safehouse & workbench (17:48)",
    note: "About 35 s in, the last daylight plus the flashlight light the bench (0.46 >= 0.35 required), so the player researches before first contact (about 42 s). Opening calm eases zombie perception in over 50 s.",
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
    "17:30 dusk start in the Noir palette with a slowed opening clock (nightfall about 60 s in), opening safe radius and calm, sparse initial shamblers, workbench time before a first 1–3 zombie encounter, and a time/exploration/noise/threat ramp with co-op scaling. Tunables live in the Pacing group.",
  order: 114,
  prop: "house",
  color: 0xd98a3c,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "opening-calm",
  variants: variants.map((v) => ({ ...v, url: page })),
  metrics: [
    { label: "Zombies within 15 m / 30 m at t = 0 (solo)", value: "16 → 0 / 26 → 4", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
    { label: "First contact time / peak simultaneous chasers (solo)", value: "0.1 s → 42.05 s / 23 → 4", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
    { label: "4-player co-op first contact / peak simultaneous chasers", value: "0.1 s → 43.75 s / 23 → 11 (scaled by player count)", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
    { label: "Nightfall (18:00) after the 17:30 start", value: "60 s (opening clock 0.25x of 120x)", source: "captures/outbreak-first-night/pacing-10m-proof.json" },
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
