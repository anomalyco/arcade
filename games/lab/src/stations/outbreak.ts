import { defineStation } from "./define"

const directions = [
  ["noir", "Noir"],
  ["painterly", "Painterly"],
  ["dusk", "Dusk"],
  ["70s", "70s suburban"],
  ["cozy", "Golden hour"],
  ["shipped", "Shipped"],
] as const
const time = (value: number) => ({ command: "scene.set-param", args: { key: "timeScale", value } })
const hour = (value: number) => ({ command: "scene.set-param", args: { key: "hour", value } })

export default defineStation({
  id: "outbreak",
  title: "Outbreak scenes",
  summary: "One Outbreak house lot with the game's own renderer, flashlight and surfaces, switched between the art directions.",
  order: 100,
  prop: "house",
  color: 0xd9a441,
  status: "in-progress",
  demo: {
    kind: "section",
    section: "outbreak-vignette",
    game: "outbreak",
    setup: [
      { command: "vignette.preset", args: { direction: "noir" } },
      { command: "vignette.camera", args: { preset: "game", cutaway: "cutaway" } },
    ],
  },
  // Three groups that compose, applied in this order: the art direction, the time of day, then the camera.
  defaultVariant: ["noir", "as-directed", "game"],
  variants: [
    ...directions.map(([id, label]) => ({
      id,
      group: "Direction",
      label,
      setup: [{ command: "vignette.preset", args: { direction: id } }],
    })),
    { id: "as-directed", group: "Time", label: "As directed", note: "Paused at the direction's own hour.", setup: [time(0)] },
    { id: "day", group: "Time", label: "Day (13:00)", setup: [time(0), hour(13)] },
    { id: "dusk-cycle", group: "Time", label: "Dusk (17:00)", setup: [time(0), hour(17)] },
    { id: "timelapse", group: "Time", label: "Day → Night Time-Lapse", setup: [hour(12.5), time(480)] },
    { id: "game", group: "Camera", label: "Game camera", note: "The game's own camera, walls cut away.", setup: [{ command: "vignette.camera", args: { preset: "game", cutaway: "cutaway" } }] },
    { id: "close-up", group: "Camera", label: "Street close-up", setup: [{ command: "vignette.camera", args: { preset: "street" } }] },
    { id: "fog-grid", group: "Camera", label: "Fog of War (3×1 Grid)", setup: [{ command: "grid.open", args: { preset: "fog" } }] },
  ],
  board: { feature: "AR-12" },
  metrics: [{ label: "ΔE2000 to the 70s target, street at 18:00", value: "12.8 → 5.8", source: "docs/integration.md (release 5)" }],
  paths: ["games/outbreak/src/vignette", "games/outbreak/src/lighting.ts", "games/outbreak/src/level.ts"],
  branches: ["outbreak-*"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?peaceful=1&seed=7" },
    { label: "Inventory and workbench", href: "/arcade/lab/?overworld&station=outbreak-progression" },
    { label: "Outbreak look: grade, lamps, survivor, beam", href: "/arcade/lab/?lab=outbreak/outbreak-look" },
  ],
})
