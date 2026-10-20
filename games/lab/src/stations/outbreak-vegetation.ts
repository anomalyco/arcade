import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean | number> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })
const shot = (hour: number, zoom: number, ...rest: StationCommand[]): StationCommand[] => [set("timeScale", 1), set("hour", hour), set("zoom", zoom), set("vegBurnTest", 0), ...rest]

const lively = [set("vegLook", 1), set("vegTreeLook", 0), set("vegWind", 1), set("vegBranchSway", 1), set("vegLeafFlutter", 1), set("vegBushSway", 1), set("vegGrassSway", 1)]
const treeLook = (look: number) => [...lively, set("vegTreeLook", look)]

// Two groups that compose: which vegetation, then where and when.
const variants: StationVariant[] = [
  { id: "veg-lively", group: "Vegetation", boardOption: "1", label: "Lively, Today's trees (#273)", note: "Oak, maple, birch and pine by seed, a few bare trees, limbs that sway with their clumps, stray shoots on the hedges, and one gust field rolling across the town: crowns lean and sway, leaves flutter near the camera, lawns lay over as gusts pass. Canopies part over the survivor.", setup: lively },
  { id: "trees-a", group: "Vegetation", boardOption: "2", label: "A · Diablo Deadwood", note: "Gnarled, twisting limbs and heavy near-black trunks, a few sparse dark clumps or none (a third stand bare); dark and grey outside light, long moon shadows. Strong silhouettes from above.", setup: treeLook(1) },
  { id: "trees-b", group: "Vegetation", boardOption: "3", label: "B · Tiny Glade Fluffy", note: "Soft rounded crowns from clusters of small leaf cards whose shading normals point out from the crown, over dark cores; lively wind on every card.", setup: treeLook(2) },
  { id: "trees-c", group: "Vegetation", boardOption: "4", label: "C · Darkwood × Diablo (default)", note: "Kit's pick (D-42). Deadwood's gnarled limbs carrying Fluffy's card clumps with gaps between; near-black and grey until a flashlight, lamp or fire lands, then rich greens and autumn ochre. A quarter are blighted: Deadwood limbs with a few withered clumps, the worst dead and bare. Long moon shadows.", setup: [...treeLook(3), set("vegTreeBlight", 0.25)] },
  { id: "trees-c-blight", group: "Vegetation", label: "Heavy blight (C)", note: "C with 60% of trees blighted (Vegetation › Blighted trees), to judge the blighted and dead trees.", setup: [...treeLook(3), set("vegTreeBlight", 0.6)] },
  { id: "veg-gale", group: "Vegetation", label: "Gale", note: "Wind 2×, short fast gusts: for tuning the layers, not for play.", setup: [...lively, set("vegWind", 2), set("vegGustScale", 14), set("vegGustSpeed", 9)] },
  { id: "veg-today", group: "Vegetation", label: "Today (before)", note: "The shipped trees and per-plant wobble, every tree the same oak recipe.", setup: [set("vegLook", 0)] },
  { id: "yard-night", group: "Shot", label: "Front yard, night", note: "23:00, flashlight on the woodland trees and the driveway hedge west of Ash's house.", setup: shot(23, 38, pose(22, 41, -2.25, { flashlight: true })) },
  { id: "yard-day", group: "Shot", label: "Front yard, day", note: "13:00 from the front walk: street trees, yard tree, foundation shrubs and the lawn.", setup: shot(13, 38, pose(22, 41, -2.25)) },
  { id: "under-tree", group: "Shot", label: "Under a tree", note: "Standing under the woodland oaks at dusk: the crown parts so the survivor stays readable.", setup: shot(19.5, 30, pose(17.2, 36.4, Math.PI, { flashlight: true })) },
  { id: "street-night", group: "Shot", label: "Street, night, flashlight", note: "23:00 on the front walk, the beam on the woodland trees.", setup: shot(23, 38, pose(21, 40.5, -2.25, { flashlight: true })) },
  { id: "under-lamp", group: "Shot", label: "Under a street lamp", note: "22:30 in the pool of the west street lamp at (8, 51) and its street tree, flashlight off.", setup: shot(22.5, 38, pose(11.2, 50.4, -0.37, { flashlight: false })) },
  { id: "burn-test", group: "Shot", label: "Burn hook test", note: "The nearest tree half burnt (Vegetation › Test: burn nearest tree 0.45): charred limbs, embers. The fire feature drives this per tree.", setup: shot(21, 32, pose(17.2, 36.4, Math.PI, { flashlight: true }), set("vegBurnTest", 0.45)) },
]

export default defineStation({
  id: "outbreak-vegetation",
  title: "Outbreak trees and wind",
  summary:
    "Trees, hedges, shrubs and grass in the town with species, bare trees, swaying limbs and one travelling gust field (AR-66), and the D-41 tree looks A–C (AR-74). Backquote › Vegetation › Tree look; C with a quarter blighted is the default (D-42).",
  order: 127,
  prop: "tree",
  color: 0x4f6b3a,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["trees-c", "yard-night"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-74" },
  paths: ["packages/kit/gpu/foliage.ts", "packages/kit/gpu/foliage-looks.ts", "games/outbreak/src/vegetation", "games/outbreak/src/architecture.ts"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
