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
    id: "off",
    label: "Off (today)",
    note: "Current Noir fog of war with no post-process unseen distortion.",
    setup: nightPose(0),
    boardOption: "A",
  },
  {
    id: "acid-knife",
    label: "Acid Knife glitch",
    note: "Low-Hz stepped block & scanline tear, red/cyan chroma split, and slate-indigo wash outside sight.",
    setup: nightPose(1),
    boardOption: "B",
  },
  {
    id: "warp-wobble",
    label: "Warp wobble",
    note: "Slow two-octave domain-warped refraction outside the vision and flashlight cones.",
    setup: nightPose(2),
    boardOption: "C",
  },
  {
    id: "dark-shroud",
    label: "Dark shroud",
    note: "Classic survival-horror fog of war: soft penumbra fade into deep desaturated darkness.",
    setup: nightPose(3),
    boardOption: "D",
  },
  {
    id: "stale-memory",
    label: "Stale memory",
    note: "Unseen rooms freeze as a faded archival snapshot of when last seen; zombies ghosted or hidden.",
    setup: nightPose(4),
    boardOption: "E",
  },
  {
    id: "noise-film",
    label: "Noise film",
    note: "16mm silver-halide grain and ordered Bayer dither thickening progressively away from sight.",
    setup: nightPose(5),
    boardOption: "F",
  },
  {
    id: "daylight",
    label: "By day (subtle)",
    note: "Daylight at 14:00 scales unseen strength down automatically via Night scaling.",
    setup: dayPose(1),
  },
]

export default defineStation({
  id: "outbreak-unseen",
  title: "Outbreak unseen",
  summary:
    "How areas outside the survivor's line-of-sight cone, close awareness circle, and flashlight beam are treated. Variants compare Off against five shader modes at night plus automatic daylight scaling.",
  order: 102,
  prop: "house",
  color: 0x6b8cff,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "acid-knife",
  variants: variants.map((v) => ({ ...v, url: page })),
  paths: [
    "games/outbreak/src/unseen/settings.ts",
    "games/outbreak/src/unseen/shader.ts",
    "games/outbreak/src/fog-of-war.ts",
  ],
  branches: ["unseen-glitch"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [{ widget: "links" }, { widget: "changes" }],
    dock: [{ widget: "variants" }, { widget: "voice" }, { widget: "notes" }],
  },
})
