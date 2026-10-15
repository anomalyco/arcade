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
  set("feelPreset", "outbreak"),
  set("feelReduceMotion", 2),
]

const variants: StationVariant[] = [
  {
    id: "shot-on",
    label: "Shot + wet blood (Feel on)",
    note: "9mm pistol shot into a zombie inside the Noir flashlight cone: directional recoil kick, subtle peripheral shutter blur, muzzle flash, and wet ballistic blood spray with dark coagulated core and crimson rim.",
    setup: [
      ...baseSetup,
      set("feelIntensity", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 38.2, state: "chase" } },
      { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
      { command: "feel.trigger", args: { kind: "shot", power: 1.15 } },
    ],
  },
  {
    id: "shot-off",
    label: "Shot + legacy blood (Feel off)",
    note: "Same shot with game feel disabled (feelIntensity = 0) and legacy flat blood splatter (bloodStyle = 2) for A/B comparison.",
    setup: [
      ...baseSetup,
      set("feelIntensity", 0),
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
      set("feelIntensity", 1),
      set("bloodStyle", 1),
      poseInterior,
      { command: "ai.spawn", args: { x: 27.7, y: 28.4, state: "chase" } },
      { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
      { command: "feel.trigger", args: { kind: "shot", power: 1.1 } },
    ],
  },
  {
    id: "shove-on",
    label: "Shove lunge + hit-stop (Feel on)",
    note: "Connected melee shove: forward camera lunge along aim, 38 ms sim-safe presentation hit-stop, subtle radial blur, and close-range venous spatter.",
    setup: [
      ...baseSetup,
      set("feelIntensity", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 39.6, state: "chase" } },
      { command: "feel.trigger", args: { kind: "shove", power: 1.2 } },
    ],
  },
  {
    id: "hit-taken-on",
    label: "Hit taken (Feel on)",
    note: "Survivor taking zombie damage: trauma² smooth-noise shake, directional shove away from attacker, subtle dark crimson corner vignette, chromatic nudge, and arterial survivorBlood spatter.",
    setup: [
      ...baseSetup,
      set("feelIntensity", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "ai.spawn", args: { x: 30, y: 39.8, state: "chase" } },
      { command: "feel.trigger", args: { kind: "hit-taken", damage: 28 } },
    ],
  },
  {
    id: "explosion-on",
    label: "Explosion shock (Feel on)",
    note: "Distance-attenuated blast impulse: trauma² translational + rotational shake, zoom/roll punch, radial shock blur, and chromatic nudge.",
    setup: [
      ...baseSetup,
      set("feelIntensity", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "feel.trigger", args: { kind: "explosion", distance: 3.5, power: 1.15 } },
    ],
  },
  {
    id: "reduced-motion",
    label: "Reduced motion (Accessibility)",
    note: "feelReduceMotion = 1 (also honours OS prefers-reduced-motion): suppresses camera shake, recoil kick, roll, hit-stop, and motion blur while retaining a gentle capped damage indicator.",
    setup: [
      ...baseSetup,
      set("feelIntensity", 1),
      set("feelReduceMotion", 1),
      set("bloodStyle", 1),
      poseStreet,
      { command: "feel.trigger", args: { kind: "hit-taken", damage: 28 } },
    ],
  },
]

export default defineStation({
  id: "game-feel",
  title: "Game feel & blood",
  summary:
    "Shared @arcade/kit/feel toolkit (trauma² smooth-noise shake, directional recoil kick, sim-safe hit-stop, impulse motion blur, damage vignette, reduced-motion) and wet ballistic blood splatter with Noir selective colour.",
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
      label: "Active shot motion-blur + wet blood GPU delta (1000×680 M5 Max)",
      value: "+0.023 ms (MAD 0.003 ms)",
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
    "packages/kit/feel/index.ts",
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
