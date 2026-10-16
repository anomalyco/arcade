import { defineStation } from "./define"

const directions = [
  ["noir", "Noir"],
  ["painterly", "Painterly"],
  ["dusk", "Dusk"],
  ["70s", "70s suburban"],
  ["cozy", "Golden hour"],
  ["shipped", "Shipped"],
] as const

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
  defaultVariant: "noir",
  variants: [
    ...directions.map(([id, label]) => ({
      id,
      label,
      setup: [
        { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
        { command: "vignette.preset", args: { direction: id } },
      ],
    })),
    {
      id: "day",
      label: "Day (13:00)",
      setup: [
        { command: "vignette.preset", args: { direction: "noir" } },
        { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
        { command: "scene.set-param", args: { key: "hour", value: 13 } },
      ],
    },
    {
      id: "dusk-cycle",
      label: "Dusk (17:00)",
      setup: [
        { command: "vignette.preset", args: { direction: "noir" } },
        { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
        { command: "scene.set-param", args: { key: "hour", value: 17 } },
      ],
    },
    {
      id: "timelapse",
      label: "Day → Night Time-Lapse",
      setup: [
        { command: "vignette.preset", args: { direction: "noir" } },
        { command: "scene.set-param", args: { key: "hour", value: 12.5 } },
        { command: "scene.set-param", args: { key: "timeScale", value: 480 } },
      ],
    },
    {
      id: "fog-grid",
      label: "Fog of War (3×1 Grid)",
      setup: [{ command: "grid.open", args: { preset: "fog" } }],
    },
    { id: "close-up", label: "Street close-up", setup: [{ command: "vignette.camera", args: { preset: "street" } }] },
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
