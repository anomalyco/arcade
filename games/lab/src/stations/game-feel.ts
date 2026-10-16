import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const poseStreet = { command: "player.pose", args: { x: 30, y: 41, aim: -1.5708, flashlight: true, clearZombiesRadius: 14 } }
const poseInterior = {
  command: "player.pose",
  args: { x: 27.7, y: 31.2, aim: -1.5708, flashlight: true, openDoor: true, clearZombiesRadius: 14 },
}

// Three groups that compose, applied in this order: how much Feel, which blood, then the moment that fires with them.
const moment = (hour = 18, zoom = 36) => [set("timeScale", 0), set("hour", hour), set("zoom", zoom)]
const spawn = (x: number, y: number) => ({ command: "ai.spawn", args: { x, y, state: "chase" } })
const aimFire = { command: "survivor.aim-demo", args: { mode: "aim-fire" } }
const impulse = (args: Record<string, number | string>) => ({ command: "camera.impulse", args })

const variants: StationVariant[] = [
  {
    id: "feel-on",
    group: "Feel",
    label: "On",
    note: "Camera shake and directional kick, the shared MotionBlur burst, hit-stop and the damage flash.",
    setup: [set("shakeScale", 1), set("kickScale", 1), set("burst", 1), set("damageFlashScale", 1), set("reduceMotion", 0)],
  },
  {
    id: "feel-off",
    group: "Feel",
    label: "Off",
    note: "Camera shake/kick and motion-blur burst disabled (shakeScale = 0, burst = 0), for A/B comparison.",
    setup: [set("shakeScale", 0), set("kickScale", 0), set("burst", 0), set("damageFlashScale", 1), set("reduceMotion", 0)],
  },
  {
    id: "reduced-motion",
    group: "Feel",
    label: "Reduced motion",
    note: "Accessibility: reduceMotion = 1 (also honours OS prefers-reduced-motion) suppresses camera shake, recoil kick, roll, hit-stop and motion blur while keeping the crimson edge damage flash.",
    setup: [set("shakeScale", 1), set("kickScale", 1), set("burst", 1), set("damageFlashScale", 1), set("reduceMotion", 1)],
  },
  { id: "blood-wet", group: "Blood", label: "Wet ballistic", note: "Dark coagulated core and crimson rim (bloodStyle = 1).", setup: [set("bloodStyle", 1)] },
  { id: "blood-legacy", group: "Blood", label: "Legacy flat", note: "The old flat splatter (bloodStyle = 2).", setup: [set("bloodStyle", 2)] },
  {
    id: "shot",
    group: "Moment",
    label: "Shot",
    note: "9mm pistol shot into a zombie inside the Noir flashlight cone: recoil kick, motion-blur burst, muzzle flash and blood spray.",
    setup: [...moment(), poseStreet, spawn(30, 38.2), aimFire, impulse({ kind: "shot", power: 1.15 })],
  },
  {
    id: "interior-blood",
    group: "Moment",
    label: "Interior shot",
    note: "Indoor shot across the bedroom rug into the north wall: directional arterial fan, coagulated pool under the body, and vertical wall gravity drips.",
    setup: [...moment(19, 32), poseInterior, spawn(27.7, 28.4), aimFire, impulse({ kind: "shot", power: 1.1 })],
  },
  {
    id: "shove",
    group: "Moment",
    label: "Shove",
    note: "Connected melee shove: forward camera lunge along aim, 28 ms sim-safe presentation HitStop, shared MotionBlur burst, and close-range venous spatter.",
    setup: [...moment(), poseStreet, spawn(30, 39.6), impulse({ kind: "shove", power: 1.2 })],
  },
  {
    id: "hit-taken",
    group: "Moment",
    label: "Hit taken",
    note: "Survivor taking zombie damage: trauma² smooth-noise shake, directional shove away from attacker, crimson edge vignette flash, shared MotionBlur burst, and arterial survivorBlood spatter.",
    setup: [...moment(), poseStreet, spawn(30, 39.8), impulse({ kind: "hit-taken", damage: 28 })],
  },
  {
    id: "explosion",
    group: "Moment",
    label: "Explosion",
    note: "Distance-attenuated blast impulse: trauma² translational + rotational shake, zoom/roll punch, and radial MotionBlur shock burst.",
    setup: [...moment(), poseStreet, impulse({ kind: "explosion", power: 1.15 })],
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
  defaultVariant: ["feel-on", "blood-wet", "shot"],
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
