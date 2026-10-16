import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })

const nightPose = (mode: number, strength = 1.0) => [
  set("timeScale", 0),
  set("hour", 22),
  set("zoom", 36),
  set("unseenMode", mode),
  set("unseenStrength", strength),
  set("unseenNightScale", 0.75),
  set("unseenEdgeSoftness", 0.85),
  set("unseenUpdateRate", 10),
  set("hideUnseenZombies", true),
  { command: "player.pose", args: { x: 27.7, y: 31.2, aim: -0.45, openDoor: true, flashlight: true } },
]

const dayPose = (mode: number) => [
  set("timeScale", 0),
  set("hour", 14),
  set("zoom", 36),
  set("unseenMode", mode),
  set("unseenStrength", 1.0),
  set("unseenNightScale", 0.75),
  set("unseenEdgeSoftness", 0.85),
  set("unseenUpdateRate", 10),
  set("hideUnseenZombies", true),
  { command: "player.pose", args: { x: 27.7, y: 31.2, aim: -0.45, openDoor: true, flashlight: false } },
]

const variants: StationVariant[] = [
  {
    id: "shroud-blend",
    label: "Shroud blend (default)",
    note: "The game's default: Dark shroud with a little Noise film static and a faint Warp wobble.",
    setup: nightPose(10),
  },
  {
    id: "off",
    label: "Off",
    note: "Current Noir fog of war with no post-process unseen distortion.",
    setup: nightPose(0),
    boardOption: "1",
  },
  {
    id: "acid-knife",
    label: "Acid Knife glitch",
    note: "Low-Hz stepped block & scanline tear, red/cyan chroma split, and slate-indigo wash outside sight.",
    setup: nightPose(1),
    boardOption: "2",
  },
  {
    id: "warp-wobble",
    label: "Warp wobble",
    note: "Slow two-octave domain-warped refraction outside the vision and flashlight cones.",
    setup: nightPose(2),
    boardOption: "3",
  },
  {
    id: "dark-shroud",
    label: "Dark shroud",
    note: "Classic survival-horror fog of war: soft penumbra fade into deep desaturated darkness.",
    setup: nightPose(3),
    boardOption: "4",
  },
  {
    id: "stale-memory",
    label: "Stale memory",
    note: "Unseen rooms freeze as a faded archival snapshot of when last seen; zombies ghosted or hidden.",
    setup: nightPose(4),
    boardOption: "5",
  },
  {
    id: "noise-film",
    label: "Noise film",
    note: "16mm silver-halide grain and ordered Bayer dither thickening progressively away from sight.",
    setup: nightPose(5),
    boardOption: "6",
  },
  {
    id: "shroud-noise",
    label: "Combo: Shroud + Noise",
    note: "Dark shroud (0.85×) + 16mm Noise film (0.75×): deep survival-horror penumbra with tactile analog grain.",
    setup: nightPose(6),
  },
  {
    id: "memory-warp",
    label: "Combo: Memory + Warp",
    note: "Stale memory (0.90×) + Warp wobble (0.65×): faded archival room memory swimming under slow dark-water refraction.",
    setup: nightPose(7),
  },
  {
    id: "edge-glitch-shroud",
    label: "Combo: Edge glitch + Shroud",
    note: "Acid Knife glitch confined to the LOS boundary band (0.85) + Dark shroud (0.85×) + subtle Noise film (0.35×).",
    setup: nightPose(8),
  },
  {
    id: "daylight",
    label: "By day (subtle)",
    note: "Daylight at 14:00 scales unseen layers down automatically via Night scaling.",
    setup: dayPose(10),
  },
]

export default defineStation({
  id: "outbreak-unseen",
  title: "Outbreak unseen",
  summary:
    "How areas outside the survivor's line-of-sight cone, close awareness circle, and flashlight beam are treated. The default is Shroud blend. Variants compare Off, five solo layers, and curated multi-layer combos (Shroud + Noise, Memory + Warp, Edge glitch + Shroud); mix any combination live in the Unseen layers panel.",
  order: 102,
  prop: "house",
  color: 0x6b8cff,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "shroud-blend",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-31", decision: "D-21" },
  metrics: [
    {
      label: "Solo modes (1–5) GPU pass delta at 3456×1894 (Apple M5 Max Metal, paired)",
      value: "+0.070 to +0.389 ms (< 1 ms budget)",
      source: "games/outbreak/scripts/prove-unseen.ts",
    },
    {
      label: "Multi-layer combos (6–8) GPU pass delta at 3456×1894 (Apple M5 Max Metal, paired)",
      value: "+0.275 ms (Shroud+Noise), +0.472 ms (Memory+Warp), +0.760 ms (Edge glitch+Shroud)",
      source: "games/outbreak/scripts/prove-unseen.ts",
    },
    {
      label: "CPU 512-ray visibility mask + flashlight cone + unseen frame eval",
      value: "0.050 ms (< 0.5 ms budget)",
      source: "games/outbreak/scripts/prove-unseen.ts",
    },
  ],
  paths: [
    "games/outbreak/src/unseen/settings.ts",
    "games/outbreak/src/unseen/shader.ts",
    "games/outbreak/src/fog-of-war.ts",
    "games/outbreak/scripts/prove-unseen.ts",
  ],
  branches: ["unseen-glitch"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [{ widget: "controls", title: "Unseen layers", groups: ["Unseen"] }],
    dock: [{ widget: "variants" }],
  },
})
