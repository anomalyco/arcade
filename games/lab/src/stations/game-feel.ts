import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const poseStreet = { command: "player.pose", args: { x: 30, y: 41, aim: -1.5708, flashlight: true, clearZombiesRadius: 14 } }
const poseInterior = {
  command: "player.pose",
  args: { x: 27.7, y: 31.2, aim: -1.5708, flashlight: true, openDoor: true, clearZombiesRadius: 14 },
}

const baseSetup = [
  set("timeScale", 0),
  set("hour", 18),
  set("zoom", 36),
  set("reduceMotion", 0),
]

const variants: StationVariant[] = [
  {
    id: "shot-on",
    label: "Shot + wet blood (Feel on)",
    note: "9mm pistol shot into a zombie inside the Noir flashlight cone: directional recoil kick, shared MotionBlur impulse burst, muzzle flash, and wet ballistic blood spray with dark coagulated core and crimson rim.",
    setup: [
      ...baseSetup,
      set("shakeScale", 1),
      set("kickScale", 1),
      set("burst", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 38.2, state: "chase" } },
      { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
      { command: "camera.impulse", args: { kind: "shot", power: 1.15 } },
    ],
  },
  {
    id: "shot-off",
    label: "Shot + legacy blood (Feel off)",
    note: "Same shot with camera shake/kick and motion-blur burst disabled (shakeScale = 0, burst = 0) and legacy flat blood splatter (bloodStyle = 2) for A/B comparison.",
    setup: [
      ...baseSetup,
      set("shakeScale", 0),
      set("kickScale", 0),
      set("burst", 0),
      set("bloodStyle", 2),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 38.2, state: "chase" } },
      { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
    ],
  },
  {
    id: "interior-blood",
    label: "Interior rug & wall splatter",
    note: "Indoor shot across the bedroom rug into the north wall: directional arterial fan, coagulated pool under the body, and vertical wall gravity drips.",
    setup: [
      ...baseSetup,
      set("hour", 19),
      set("zoom", 32),
      set("shakeScale", 1),
      set("kickScale", 1),
      set("burst", 1),
      set("bloodStyle", 1),
      poseInterior,
      { command: "ai.spawn", args: { x: 27.7, y: 28.4, state: "chase" } },
      { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
      { command: "camera.impulse", args: { kind: "shot", power: 1.1 } },
    ],
  },
  {
    id: "shove-on",
    label: "Shove lunge + hit-stop (Feel on)",
    note: "Connected melee shove: forward camera lunge along aim, 28 ms sim-safe presentation HitStop, shared MotionBlur burst, and close-range venous spatter.",
    setup: [
      ...baseSetup,
      set("shakeScale", 1),
      set("kickScale", 1),
      set("burst", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 39.6, state: "chase" } },
      { command: "camera.impulse", args: { kind: "shove", power: 1.2 } },
    ],
  },
  {
    id: "hit-taken-on",
    label: "Hit taken (Feel on)",
    note: "Survivor taking zombie damage: trauma² smooth-noise shake, directional shove away from attacker, crimson edge vignette flash (G.z), shared MotionBlur burst, and arterial survivorBlood spatter.",
    setup: [
      ...baseSetup,
      set("shakeScale", 1),
      set("kickScale", 1),
      set("damageFlashScale", 1),
      set("burst", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 39.8, state: "chase" } },
      { command: "camera.impulse", args: { kind: "hit-taken", damage: 28 } },
    ],
  },
  {
    id: "explosion-on",
    label: "Explosion shock (Feel on)",
    note: "Distance-attenuated blast impulse: trauma² translational + rotational shake, zoom/roll punch, and radial MotionBlur shock burst.",
    setup: [
      ...baseSetup,
      set("shakeScale", 1),
      set("kickScale", 1),
      set("burst", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "camera.impulse", args: { kind: "explosion", power: 1.15 } },
    ],
  },
  {
    id: "reduced-motion",
    label: "Reduced motion (Accessibility)",
    note: "reduceMotion = 1 (also honours OS prefers-reduced-motion): suppresses camera shake, recoil kick, roll, hit-stop, and motion blur while retaining the crimson edge damage flash.",
    setup: [
      ...baseSetup,
      set("shakeScale", 1),
      set("reduceMotion", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "camera.impulse", args: { kind: "hit-taken", damage: 28 } },
    ],
  },
]

export default defineStation({
  id: "game-feel",
  title: "Game feel & blood",
  summary:
    "Composable camera shake + directional kick (@arcade/kit/client/camera), shared MotionBlur impulse burst (@arcade/kit/gpu/motion-blur), presentation HitStop, look/post damage flash, and wet ballistic blood splatter with Noir selective colour.",
  order: 116,
  prop: "burst",
  color: 0xc92a2a,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "shot-on",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-15" },
  metrics: [
    {
      label: "Steady-state GPU delta (3456×1894 M2 Max, 6 interleaved rounds)",
      value: "+0.007 ms street / -0.016 ms interior",
      source: "captures/game-feel/feel-proof.json",
    },
    {
      label: "Noir selective-red ratio (beam blood vs outside-beam blood)",
      value: "7.38× → 36.16×",
      source: "captures/game-feel/blood-metrics.json",
    },
    {
      label: "Street beam blood / wall splatter ΔE2000 to paint-over target",
      value: "10.41 → 8.46 / 17.82 → 12.67",
      source: "captures/game-feel/blood-metrics.json",
    },
  ],
  paths: [
    "packages/kit/client/camera.ts",
    "packages/kit/gpu/motion-blur.ts",
    "packages/kit/fx/splatter.ts",
    "packages/kit/fx/splatter-renderer.ts",
    "games/outbreak/src/combat-fx.ts",
  ],
  branches: ["game-feel"],
  links: [
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7&infiniteAmmo=1" },
    { label: "Lab Splatter section", href: "/arcade/lab/?game=blackout&section=splatter" },
  ],
})
