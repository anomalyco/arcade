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
const trigger = { command: "effect.trigger", args: { seed: 7 } }

export default defineStation({
  id: "effects",
  title: "Effects",
  summary:
    "The shared explosions, smoke, fire and tyre smoke that Getaway, Blackout, Carrier and Outbreak use, playing in the Look and world street so they read against the same look and light. Time of day and grade are in the World group.",
  order: 8,
  prop: "burst",
  color: 0xff7a2f,
  status: "review",
  demo: { kind: "section", section: "effects", setup: [set("backdrop", "world")] },
  // Groups that compose, applied in this order: where the effect plays, the light, then the effect itself (it fires
  // last, so it reads against both). The blood variants run the Splatter section; on Home they are a lab of their own.
  defaultVariant: ["world", "day", "grenade"],
  variants: [
    { id: "world", group: "Backdrop", label: "Street", note: "The Look and world street.", setup: [set("backdrop", "world")] },
    { id: "stage-room", group: "Backdrop", label: "Stage room (before)", note: "The old blue stage room the effects used to play in.", setup: [set("backdrop", "stage")] },
    { id: "day", group: "Light", label: "Day", note: "13:00 in the current grade.", setup: [set("worldHour", 13), set("worldLook", "current")] },
    { id: "night", group: "Light", label: "Night, Noir", note: "23:00 under Noir: the flash lights the street.", setup: [set("worldHour", 23), set("worldLook", "noir")] },
    ...explosions.map(([id, label, interval]): StationVariant => ({
      id,
      group: "Effect",
      label,
      setup: [set("effect", "explosion"), set("explosionPreset", id), { command: "effect.loop", args: { loop: true, interval } }, trigger],
    })),
    ...gridVariants("smoke").map(v => ({ ...v, group: "Effect", setup: [set("effect", "smoke"), ...(v.setup ?? []), trigger] })),
    { id: "fire", group: "Effect", label: "Fire", setup: [set("effect", "fire"), trigger] },
    { id: "tyre", group: "Effect", label: "Tyre smoke", setup: [set("effect", "tyre"), trigger] },
    {
      id: "blood-wet",
      group: "Blood",
      label: "Blood splatter (Wet ballistic)",
      note: "Surface-clipped ballistic splatter with coagulated venous core, arterial rim, directional streaks, and wet meniscus specular.",
      setup: [{ command: "scene.select-section", args: { section: "splatter" } }, set("style", 1), set("preset", "zombieBlood")],
    },
    { id: "blood-legacy", group: "Blood", label: "Blood splatter (Legacy flat)", note: "Previous particle-sprite blood for A/B comparison.", setup: [{ command: "scene.select-section", args: { section: "splatter" } }, set("style", 0)] },
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
