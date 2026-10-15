import { SCENE_SCHEMA, type LabScene } from "@arcade/kit/lab/scenes/model"

/**
 * The Feel lab worked example (AR-25): the survivor and three dummy zombies at night, the six feel knobs featured,
 * and Feel on/off, Punchy and Reduced motion as variants. Impacts are the Feel kind's actions, not variants, so any
 * variant can take any impact. `hitStopScale` and `bloodAmount` are new knobs this lab needs from Outbreak.
 */
export const FEEL_ARENA: LabScene = {
  schema: SCENE_SCHEMA,
  id: "feel-arena",
  collection: "game-feel",
  kind: "feel",
  title: "Feel arena",
  status: "kept",
  summary: "Shot, shove, hit taken, kill and explosion on the survivor and three dummy zombies, with feel on and off.",
  author: "Plinkazop",
  created: "2026-10-15T12:00:00.000Z",
  updated: "2026-10-15T12:00:00.000Z",
  games: ["outbreak"],
  host: {
    kind: "page",
    url: "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1",
    // The survivor at the street spot with three dummy zombies a metre apart in front of her.
    setup: [
      { command: "player.pose", args: { x: 30, y: 41, aim: -1.5708, flashlight: true, clearZombiesRadius: 14 } },
      { command: "ai.spawn", args: { x: 29, y: 38.2, state: "investigate" } },
      { command: "ai.spawn", args: { x: 30, y: 38.2, state: "investigate" } },
      { command: "ai.spawn", args: { x: 31, y: 38.2, state: "investigate" } },
    ],
  },
  choices: {},
  extras: [],
  settings: {
    timeScale: 0,
    hour: 18,
    zoom: 36,
    shakeScale: 1,
    kickScale: 1,
    burst: 1,
    damageFlashScale: 1,
    hitStopScale: 1,
    bloodAmount: 1,
    bloodStyle: 1,
    reduceMotion: 0,
  },
  seeds: { room: 7 },
  views: [{ id: "game", label: "Game camera", kind: "game" }],
  view: "game",
  variants: [
    { id: "on", label: "Feel on" },
    {
      id: "off",
      label: "Feel off",
      note: "No shake, kick, blur burst, hit-stop or flash; legacy flat blood.",
      set: { shakeScale: 0, kickScale: 0, burst: 0, damageFlashScale: 0, hitStopScale: 0, bloodStyle: 2 },
    },
    { id: "punchy", label: "Punchy", set: { kickScale: 1.4, hitStopScale: 1.5, burst: 1.3, bloodAmount: 1.2 } },
    { id: "reduced", label: "Reduced motion", note: "Keeps the damage flash and blood.", set: { reduceMotion: 1 } },
  ],
  variant: "on",
  layout: {
    featured: { keys: ["shakeScale", "kickScale", "burst", "hitStopScale", "damageFlashScale", "bloodAmount"] },
    watch: ["shakeScale", "hitStopScale"],
  },
  info: {
    board: { feature: "AR-15" },
    metrics: [{ label: "Steady-state GPU delta, street", value: "+0.007 ms", source: "captures/game-feel/feel-proof.json" }],
    paths: ["packages/kit/client/camera.ts", "packages/kit/gpu/motion-blur.ts", "games/outbreak/src/feel-events.ts", "games/outbreak/src/combat-fx.ts"],
    work: "in-progress",
  },
}
