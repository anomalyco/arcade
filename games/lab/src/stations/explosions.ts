import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const presets = [
  ["grenade", "Grenade"],
  ["propane", "Propane tank"],
  ["car", "Car"],
  ["barrel", "Barrel"],
  ["missile", "Missile airburst"],
  ["ship", "Ship deck strike"],
  ["pop", "Small pop"],
] as const

export default defineStation({
  id: "explosions",
  title: "Explosions",
  summary: "The seven shared explosion presets that Getaway, Blackout, Carrier and the Lab all use, looping on one seed.",
  order: 10,
  prop: "burst",
  color: 0xff7a2f,
  status: "review",
  statusNote: "R-1 waiting",
  demo: {
    kind: "section",
    section: "effects",
    setup: [
      { command: "scene.set-param", args: { key: "effect", value: "explosion" } },
      { command: "scene.set-param", args: { key: "explosionPreset", value: "grenade" } },
      { command: "effect.loop", args: { loop: true, interval: 2.2 } },
      { command: "effect.trigger", args: { seed: 7 } },
    ],
  },
  defaultVariant: "grenade",
  variants: presets.map(([id, label]): StationVariant => ({
    id,
    label,
    setup: [
      { command: "scene.set-param", args: { key: "explosionPreset", value: id } },
      { command: "effect.trigger", args: { seed: 7 } },
    ],
  })),
  grid: "explosions",
  board: { feature: "AR-15" },
  metrics: [
    { label: "particles in the car preset, the largest ground blast", value: "152", source: "perf/explosion-unify.json" },
  ],
  paths: ["packages/kit/fx/explosion.ts", "packages/kit/lab/effects.ts"],
  branches: ["explosion-*"],
  links: [
    { label: "Getaway car blast", href: "/arcade/getaway/?peaceful=1&seed=7" },
    { label: "Blackout frag", href: "/arcade/blackout/?peaceful=1&seed=1" },
  ],
})
