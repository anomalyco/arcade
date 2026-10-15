import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
// Ash's living room at dusk with the roof open; the survivor stands on the rug.
const living = (theme: number, hour = 19) => [set("timeScale", 0), set("hour", hour), set("zoom", 26), set("interiorTheme", theme), set("sconceLights", -1), { command: "player.pose", args: { x: 25.6, y: 32.4, aim: -Math.PI / 2 } }]
// Ash's north-east wing at night, facing the painting and its pair of sconces.
const sconces = (lit: boolean) => [set("timeScale", 0), set("hour", 21), set("zoom", 26), set("interiorTheme", 1), set("sconceLights", lit ? -1 : 0), { command: "player.pose", args: { x: 33.7, y: 27.6, aim: -Math.PI / 2 } }]

const variants: StationVariant[] = [
  { id: "seeded", label: "Seeded per house", note: "Each building picks its theme and rugs from its archetype and seed.", setup: living(-1) },
  { id: "mansion", label: "Mansion (RE1)", note: "Damask above dark wainscot, parquet, gilt frames, grandfather clock.", setup: living(1) },
  { id: "baker", label: "Farmhouse (RE7)", note: "Faded stripes, worn boards, threadbare rugs.", setup: living(2) },
  { id: "station", label: "Police station (RE2)", note: "Green stripes, herringbone, deco and Turkmen rugs.", setup: living(3) },
  { id: "village", label: "Village (RE4)", note: "Plaster, kilims and braided rugs.", setup: living(4) },
  { id: "plain", label: "Plain (before)", note: "No theme: today's rooms with the procedural rugs only.", setup: living(0) },
  { id: "handmade", label: "Hand-painted rugs", note: "The three original manifest textures instead of the procedural bake.", setup: [...living(1), set("rugSource", 1)] },
  { id: "sconces", label: "Sconce light pools", note: "21:00: each painting's pair of sconces lights its wall and a pool of the room, up to the quality tier's budget (3 pairs high, 2 balanced, none low).", setup: sconces(true) },
  { id: "sconces-off", label: "Sconces unlit (before)", note: "The same wing with sconce lights off: the bulbs glow but cast nothing.", setup: sconces(false) },
  { id: "flashlight", label: "Night, flashlight", note: "23:30 with the flashlight raking the pile.", setup: [...living(1, 23.5), { command: "player.pose", args: { x: 25.4, y: 31.6, aim: -2.4 } }] },
]

export default defineStation({
  id: "rugs-interiors",
  title: "Rugs & interiors",
  summary:
    "Outbreak houses dressed Resident Evil style: seeded themes (wallpaper, wainscot, parquet, clocks, bookcases, paintings with lit sconces) and procedural Persian, Turkmen, kilim, Art Deco, braided and shag rugs baked off the main thread at 1024 px with mips and pile height.",
  order: 72,
  prop: "house",
  color: 0x8c2d24,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "mansion",
  variants: variants.map(v => ({ ...v, url: page })),
  board: { feature: "AR-3" },
  paths: ["packages/kit/textures/rug.ts", "packages/kit/textures/interior-tiles.ts", "games/outbreak/src/interiors", "packages/kit/lab/rugs.ts"],
  branches: ["rugs-interiors"],
  links: [
    { label: "Rug inspector (Lab)", href: "/arcade/lab/?section=rugs" },
    { label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" },
  ],
  layout: {
    left: [{ widget: "status" }],
    dock: [{ widget: "variants" }],
  },
})
