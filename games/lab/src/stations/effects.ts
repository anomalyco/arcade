import { gridVariants, type StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

// Bigger hits throw burning fragments on their own smoke trails, so they loop slower to let the arcs land.
const explosions = [
  ["grenade", "Grenade", 2.2],
  ["propane", "Propane tank", 2.6],
  ["car", "Car", 3.6],
  ["barrel", "Barrel", 3.2],
  ["missile", "Missile airburst", 3.2],
  ["ship", "Ship deck strike", 4.5],
  ["pop", "Small pop", 2.2],
] as const
const set = (key: string, value: string | number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const world = [set("backdrop", "world")]

export default defineStation({
  id: "effects",
  title: "Effects",
  summary:
    "The shared explosions, smoke, fire and tyre smoke that Getaway, Blackout, Carrier and Outbreak use, playing in the Look and world street so they read against the same look and light. Time of day and grade are in the World group.",
  order: 8,
  prop: "burst",
  color: 0xff7a2f,
  status: "review",
  demo: { kind: "section", section: "effects", setup: [...world, set("effect", "explosion"), set("explosionPreset", "grenade"), { command: "effect.loop", args: { loop: true, interval: 2.2 } }, { command: "effect.trigger", args: { seed: 7 } }] },
  defaultVariant: "grenade",
  variants: [
    ...explosions.map(([id, label, interval]): StationVariant => ({
      id,
      label,
      setup: [...world, set("effect", "explosion"), set("explosionPreset", id), { command: "effect.loop", args: { loop: true, interval } }, { command: "effect.trigger", args: { seed: 7 } }],
    })),
    ...gridVariants("smoke").map(v => ({ ...v, setup: [...world, set("effect", "smoke"), ...(v.setup ?? []), { command: "effect.trigger", args: { seed: 7 } }] })),
    { id: "fire", label: "Fire", setup: [...world, set("effect", "fire"), { command: "effect.trigger", args: { seed: 7 } }] },
    { id: "tyre", label: "Tyre smoke", setup: [...world, set("effect", "tyre"), { command: "effect.trigger", args: { seed: 7 } }] },
    { id: "night-grenade", label: "Grenade at night", note: "23:00 under Noir: the flash lights the street.", setup: [...world, set("worldHour", 23), set("worldLook", "noir"), set("effect", "explosion"), set("explosionPreset", "grenade"), { command: "effect.trigger", args: { seed: 7 } }] },
    {
      id: "blood-wet",
      label: "Blood splatter (Wet ballistic)",
      note: "Surface-clipped ballistic splatter with coagulated venous core, arterial rim, directional streaks, and wet meniscus specular.",
      setup: [{ command: "scene.select-section", args: { section: "splatter" } }, set("style", 1), set("preset", "zombieBlood")],
    },
    { id: "blood-legacy", label: "Blood splatter (Legacy flat)", note: "Previous particle-sprite blood for A/B comparison.", setup: [{ command: "scene.select-section", args: { section: "splatter" } }, set("style", 0)] },
    { id: "stage-room", label: "Stage room (before)", note: "The old blue stage room the effects used to play in.", setup: [set("backdrop", "stage"), set("effect", "explosion"), set("explosionPreset", "grenade"), { command: "effect.trigger", args: { seed: 7 } }] },
  ],
  grid: "explosions",
  board: { feature: "AR-15" },
  metrics: [
    { label: "particles at spawn in the car preset", value: "157", source: "perf/explosion-unify.json" },
    { label: "peak particles in the ship hit, trails included (pool 2,048)", value: "1,129", source: "perf/explosion-unify.json" },
  ],
  paths: ["packages/kit/fx/explosion.ts", "packages/kit/fx/volume.ts", "packages/kit/fx/particles.ts", "packages/kit/lab/effects.ts", "packages/kit/lab/world"],
  branches: ["explosion-*", "smoke-*"],
  links: [
    { label: "Getaway car blast", href: "/arcade/getaway/?peaceful=1&seed=7" },
    { label: "Blackout frag", href: "/arcade/blackout/?peaceful=1&seed=1" },
  ],
})
