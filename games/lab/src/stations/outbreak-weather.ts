import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean | string): StationCommand => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean> = {}): StationCommand => ({ command: "player.pose", args: { x, y, aim, ...extra } })
const weather = (state: string): StationCommand => ({ command: "weather.set", args: { state } })
const shot = (hour: number, zoom: number, at: StationCommand, ...extra: StationCommand[]): StationCommand[] => [set("timeScale", 0), set("hour", hour), set("zoom", zoom), at, ...extra]
const street = (aim: number, extra: Record<string, boolean> = {}) => pose(24, 44, aim, extra)

const variants: StationVariant[] = [
  { id: "drizzle-day", group: "Weather", label: "Drizzle, day", note: "14:00 under a drizzle front: fine streaks you only catch against the shade, a damp darker road and no puddles yet.", setup: shot(14, 42, street(0.12), weather("drizzle")) },
  { id: "storm-night", group: "Weather", label: "Storm night, a flash", note: "22:00 in a storm: rain only in the beam and the lamp pools, then a near strike lifts the shroud for a beat, shows the dead around you, and thunder follows.", setup: shot(22, 42, street(0.12, { flashlight: true }), weather("storm"), { command: "weather.flash", args: { near: true } }) },
  { id: "wet-street", group: "Weather", label: "Wet street, puddles", note: "Rain held at night with the beam down the road: the road dark and soaked, standing water in the gutters and dips, gloss only where light falls.", setup: shot(22, 38, street(0.3, { flashlight: true }), weather("rain")) },
  { id: "cycle", group: "Weather", label: "The seeded cycle", note: "Let the town's weather run: fronts every four minutes, mostly clear, storms rare and at night.", setup: [set("timeScale", 1), weather("cycle")] },
  { id: "clear", group: "Weather", label: "Clear (Today)", note: "Weather off: the look before AR-71.", setup: [weather("clear")] },
]

export default defineStation({
  id: "outbreak-weather",
  title: "Outbreak weather",
  summary:
    "A seeded weather cycle per town (clear, drizzle, rain, storm, mostly at night): rain seen only in light, a wet road with puddles in the gutters, lightning that lifts the shroud for a beat with thunder after it, and rain beds that muffle indoors. Rain masks footsteps from the dead and shortens their sight a little. Tunables are in Backquote › Weather.",
  order: 127,
  prop: "panels",
  color: 0x6c8fb8,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "storm-night",
  pickOne: true,
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-71" },
  metrics: [{ label: "Weather tests", value: "13", source: "games/outbreak/tests/weather-cycle.test.ts, weather.test.ts" }],
  paths: ["games/outbreak/shared/weather", "games/outbreak/src/weather"],
  branches: ["outbreak-weather*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
