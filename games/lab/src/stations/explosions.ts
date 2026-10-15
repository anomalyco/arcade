import type { StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

// Bigger hits throw burning fragments on their own smoke trails, so they loop slower to let the arcs land.
const presets = [
  ["grenade", "Grenade", 2.2],
  ["propane", "Propane tank", 2.6],
  ["car", "Car", 3.6],
  ["barrel", "Barrel", 3.2],
  ["missile", "Missile airburst", 3.2],
  ["ship", "Ship deck strike", 4.5],
  ["pop", "Small pop", 2.2],
] as const

export default defineStation({
  id: "explosions",
  title: "Explosions",
  summary: "The seven shared explosion presets that Getaway, Blackout, Carrier and the Lab all use, looping on one seed. Big hits throw fragments that trail their own smoke.",
  order: 10,
  prop: "burst",
  color: 0xff7a2f,
  status: "review",
  statusNote: "R-1 changes: fragment smoke trails, no ice-shard spray",
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
  variants: [
    ...presets.map(([id, label, interval]): StationVariant => ({
      id,
      label,
      ...(id === "ship"
        ? { note: "Sixteen burning fragments arc out on their own thinning smoke trails, with three secondary pops and a taller column. Over water (Carrier) they splash in." }
        : {}),
      setup: [
        { command: "scene.set-param", args: { key: "effect", value: "explosion" } },
        { command: "scene.set-param", args: { key: "explosionPreset", value: id } },
        { command: "effect.loop", args: { loop: true, interval } },
        { command: "effect.trigger", args: { seed: 7 } },
      ],
    })),
    {
      id: "blood-wet",
      label: "Blood splatter (Wet ballistic)",
      note: "Surface-clipped ballistic splatter with coagulated venous core, arterial rim, directional streaks, and wet meniscus specular.",
      setup: [
        { command: "scene.select-section", args: { id: "splatter" } },
        { command: "scene.set-param", args: { key: "style", value: 1 } },
        { command: "scene.set-param", args: { key: "preset", value: "zombieBlood" } },
      ],
    },
    {
      id: "blood-legacy",
      label: "Blood splatter (Legacy flat)",
      note: "Previous particle-sprite blood for A/B comparison.",
      setup: [
        { command: "scene.select-section", args: { id: "splatter" } },
        { command: "scene.set-param", args: { key: "style", value: 0 } },
      ],
    },
  ],
  grid: "explosions",
  board: { feature: "AR-15" },
  metrics: [
    { label: "particles at spawn in the car preset", value: "157", source: "perf/explosion-unify.json" },
    { label: "peak particles in the ship hit, trails included (pool 2,048)", value: "1,129", source: "perf/explosion-unify.json" },
  ],
  paths: ["packages/kit/fx/explosion.ts", "packages/kit/fx/projectile-trail.ts", "packages/kit/lab/effects.ts"],
  branches: ["explosion-*"],
  links: [
    { label: "Getaway car blast", href: "/arcade/getaway/?peaceful=1&seed=7" },
    { label: "Blackout frag", href: "/arcade/blackout/?peaceful=1&seed=1" },
  ],
})
