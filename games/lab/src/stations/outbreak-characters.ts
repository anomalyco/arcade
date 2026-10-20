import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean): StationCommand => ({ command: "scene.set-param", args: { key, value } })
const on = [set("chStyle", 1), set("chCallings", true), set("chWear", true), set("chHabits", 1), set("chLeash", true)]
const stage = (scene: string, hour = 21, zoom = 30): StationCommand[] => [
  set("timeScale", 0),
  set("hour", hour),
  set("zoom", zoom),
  ...on,
  { command: "characters.stage", args: { scene } },
]

const variants: StationVariant[] = [
  { id: "callings", group: "Who they were", label: "Every calling", note: "The six old outfits and the seven new ones in a line: mail carrier with satchel, jogger with earbuds, bathrobe and one slipper, night security, courier in hi-vis, bride, groom. Each is read from the zombie's seed, so every co-op client sees the same person.", setup: stage("callings", 14, 22) },
  { id: "callings-today", group: "Who they were", label: "Today", note: "The same line-up with Characters set to Today: the six Former Townsfolk outfits.", setup: [...stage("callings", 14, 22), set("chStyle", 0)] },
  { id: "knock", group: "Habit loops", label: "Knocking from inside", note: "Inside a house, facing its own shut front door: three knocks, a rest, three more. You hear it from the street.", setup: stage("knock") },
  { id: "stove", group: "Habit loops", label: "At the cold stove", note: "Stirring a pan that is not there.", setup: stage("stove") },
  { id: "bed", group: "Habit loops", label: "Over the bed", note: "Standing over a bed, head bowed, swaying.", setup: stage("bed") },
  { id: "fence", group: "Habit loops", label: "In the fence", note: "Hands through the wire, rattling it, a hard pull every few seconds.", setup: stage("fence") },
  { id: "wedding", group: "Habit loops", label: "Bride and groom", note: "Outside the church doors, slow-dancing.", setup: stage("wedding", 20, 30) },
  { id: "leash", group: "Habit loops", label: "Empty lead", note: "Out for the walk still: the lead taut ahead, the collar at a small dog's neck height, nosing side to side, nothing in it.", setup: stage("leash", 14, 26) },
]

export default defineStation({
  id: "outbreak-characters",
  title: "Outbreak: who they were",
  summary:
    "The dead hint at who they were (AR-88): callings read from the seed (mail carriers, joggers, bathrobes, guards, couriers, a bride and groom), clothes and skin by days since turning, habit loops at places in the town (knocking from inside a front door, a cold stove, a bed, a fence, a slow dance at the church, an empty lead) that they keep until they notice you, heads that turn to noises and a flinch from the torch. Backquote › Characters; Today is one setting away.",
  order: 126.5,
  prop: "house",
  color: 0x6a5446,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["callings"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-88" },
  paths: ["games/outbreak/src/characters", "games/outbreak/shared/characters", "games/outbreak/src/zombies.ts", "games/outbreak/src/look/refined-figure.ts"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
