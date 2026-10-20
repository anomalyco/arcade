import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean | number> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })
const shot = (hour: number, zoom: number, ...rest: StationCommand[]): StationCommand[] => [set("timeScale", 0), set("hour", hour), set("zoom", zoom), ...rest]

const varied = [set("houseVariety", 1), set("hvDerelict", 0.16), set("hvBurnt", 0.06), set("hvConstruction", 0.05), set("hvBoarded", 0.12), set("hvYard", 1)]

// Two groups that compose: which houses, then where and when (seed 7 positions).
const variants: StationVariant[] = [
  { id: "houses-varied", group: "Houses", boardOption: "1", label: "Varied", note: "Bungalows, colonials, L-shaped ranches, duplexes, shotguns, farmhouses with wrap porches, trailers, small apartment blocks and corner stores, each with its own roof, siding, paint, porch, chimney, garage, fence and yard; some derelict, burnt out or half built.", setup: varied },
  { id: "houses-rough", group: "Houses", label: "Rough town", note: "Half the homes derelict, a fifth burnt out, more half built and boarded: for tuning, not for play.", setup: [...varied, set("hvDerelict", 0.5), set("hvBurnt", 0.2), set("hvConstruction", 0.12), set("hvBoarded", 0.4)] },
  { id: "houses-kept", group: "Houses", label: "Kept town", note: "Every home kept and lived in, yards crowded.", setup: [...varied, set("hvDerelict", 0), set("hvBurnt", 0), set("hvConstruction", 0), set("hvBoarded", 0), set("hvYard", 2)] },
  { id: "houses-today", group: "Houses", boardOption: "2", label: "Today (before)", note: "The three plans every streamed home used before: same roof, same siding, same porch.", setup: [set("houseVariety", 0)] },
  { id: "street-day", group: "Shot", label: "Street, day", note: "Three lots north-east of the start block at 13:00: a burnt-out duplex, a cross-gabled shotgun with a shed porch, and a farmhouse with a wraparound porch, split-rail fence and carport.", setup: shot(13, 62, pose(145, -12.5, -Math.PI / 2)) },
  { id: "street-night", group: "Shot", label: "Street, night", note: "The same street at 22:00 by flashlight.", setup: shot(22, 50, pose(145, -12.5, -Math.PI / 2, { flashlight: true })) },
  { id: "farmhouse-day", group: "Shot", label: "Farmhouse, day", note: "A cross-gabled farmhouse with a wraparound porch, split-rail fence and carport, 14:00.", setup: shot(14, 50, pose(172, -14, -Math.PI / 2)) },
  { id: "burnt-day", group: "Shot", label: "Burnt colonial, day", note: "A burnt-out two-storey colonial: soot over the windows, the roof down to its rafters, the upper floor fallen in.", setup: shot(14, 50, pose(-22.6, -13, -Math.PI / 2)) },
]

export default defineStation({
  id: "outbreak-houses",
  title: "Outbreak houses",
  summary:
    "Kit: \"All the houses look too similar.\" Seeded house styles (AR-79): nine archetypes with their own plans, roofs, siding, porches, garages, fences, yards and households, found kept, derelict, burnt or half built. Backquote › World · Variety (Today is one setting away).",
  order: 129,
  prop: "house",
  color: 0x7a5a3e,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["houses-varied", "street-day"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-79" },
  paths: ["games/outbreak/shared/houses", "games/outbreak/src/houses"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
