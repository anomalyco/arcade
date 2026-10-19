import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean | number> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })
const shot = (hour: number, zoom: number, ...rest: StationCommand[]): StationCommand[] => [set("timeScale", 1), set("hour", hour), set("zoom", zoom), ...rest]

const lively = [set("vegLook", 1), set("vegWind", 1), set("vegBranchSway", 1), set("vegLeafFlutter", 1), set("vegBushSway", 1), set("vegGrassSway", 1)]

// Two groups that compose: which vegetation, then where and when.
const variants: StationVariant[] = [
  { id: "veg-lively", group: "Vegetation", boardOption: "2", label: "Lively", note: "Oak, maple, birch and pine by seed, a few bare trees, limbs that sway with their clumps, stray shoots on the hedges, and one gust field rolling across the town: crowns lean and sway, leaves flutter near the camera, lawns lay over as gusts pass. Canopies part over the survivor.", setup: lively },
  { id: "veg-gale", group: "Vegetation", label: "Gale", note: "Wind 2×, short fast gusts: for tuning the layers, not for play.", setup: [...lively, set("vegWind", 2), set("vegGustScale", 14), set("vegGustSpeed", 9)] },
  { id: "veg-today", group: "Vegetation", boardOption: "1", label: "Today (before)", note: "The shipped trees and per-plant wobble, every tree the same oak recipe.", setup: [set("vegLook", 0)] },
  { id: "yard-night", group: "Shot", label: "Front yard, night", note: "23:00, flashlight on the woodland trees and the driveway hedge west of Ash's house.", setup: shot(23, 38, pose(22, 41, -2.25, { flashlight: true })) },
  { id: "yard-day", group: "Shot", label: "Front yard, day", note: "13:00 from the front walk: street trees, yard tree, foundation shrubs and the lawn.", setup: shot(13, 38, pose(22, 41, -2.25)) },
  { id: "under-tree", group: "Shot", label: "Under a tree", note: "Standing under the woodland oaks at dusk: the crown parts so the survivor stays readable.", setup: shot(19.5, 30, pose(17.2, 36.4, Math.PI, { flashlight: true })) },
]

export default defineStation({
  id: "outbreak-vegetation",
  title: "Outbreak trees and wind",
  summary:
    "Trees, hedges, shrubs and grass in the town with species, bare trees, swaying limbs and one travelling gust field (AR-66). Backquote › Vegetation; Today is one setting away.",
  order: 125,
  prop: "tree",
  color: 0x4f6b3a,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["veg-lively", "yard-night"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-66" },
  paths: ["packages/kit/gpu/foliage.ts", "games/outbreak/src/vegetation", "games/outbreak/src/architecture.ts"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
