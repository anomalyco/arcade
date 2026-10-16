import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
// Four groups that compose: where and when (Shot), the house theme, which rugs, and whether the sconces light.
const pose = (x: number, y: number, aim: number) => ({ command: "player.pose", args: { x, y, aim } })
const shot = (hour: number, at: ReturnType<typeof pose>) => [set("timeScale", 0), set("hour", hour), set("zoom", 26), at]
const theme = (value: number) => [set("interiorTheme", value)]

const variants: StationVariant[] = [
  // Ash's living room with the roof open, the survivor on the rug; the north-east wing faces a painting and its sconces.
  { id: "living-dusk", group: "Shot", label: "Living room, dusk", note: "19:00, standing on the rug.", setup: shot(19, pose(25.6, 32.4, -Math.PI / 2)) },
  { id: "flashlight", group: "Shot", label: "Night, flashlight", note: "23:30 with the flashlight raking the pile.", setup: shot(23.5, pose(25.4, 31.6, -2.4)) },
  { id: "wing-night", group: "Shot", label: "Painting wing, night", note: "21:00, facing a painting and its pair of sconces.", setup: shot(21, pose(33.7, 27.6, -Math.PI / 2)) },
  { id: "seeded", group: "Theme", label: "Seeded per house", note: "Each building picks its theme and rugs from its archetype and seed.", setup: theme(-1) },
  { id: "mansion", group: "Theme", label: "Mansion (RE1)", note: "Damask above dark wainscot, parquet, gilt frames, grandfather clock.", setup: theme(1) },
  { id: "baker", group: "Theme", label: "Farmhouse (RE7)", note: "Faded stripes, worn boards, threadbare rugs.", setup: theme(2) },
  { id: "station", group: "Theme", label: "Police station (RE2)", note: "Green stripes, herringbone, deco and Turkmen rugs.", setup: theme(3) },
  { id: "village", group: "Theme", label: "Village (RE4)", note: "Plaster, kilims and braided rugs.", setup: theme(4) },
  { id: "plain", group: "Theme", label: "Plain (before)", note: "No theme: today's rooms with the procedural rugs only.", setup: theme(0) },
  { id: "procedural", group: "Rugs", label: "Procedural", note: "Rugs baked by the generator (the Rugs lab).", setup: [set("rugSource", 0)] },
  { id: "handmade", group: "Rugs", label: "Hand-painted", note: "The three original manifest textures instead of the procedural bake.", setup: [set("rugSource", 1)] },
  { id: "sconces", group: "Sconces", label: "Lit", note: "Each painting's pair of sconces lights its wall and a pool of the room, up to the quality tier's budget (3 pairs high, 2 balanced, none low).", setup: [set("sconceLights", -1)] },
  { id: "sconces-off", group: "Sconces", label: "Unlit (before)", note: "The bulbs glow but cast nothing.", setup: [set("sconceLights", 0)] },
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
  defaultVariant: ["living-dusk", "mansion", "procedural", "sconces"],
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
