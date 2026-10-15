import type { StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean) => ({ command: "scene.set-param", args: { key, value } })
const night = [set("timeScale", 0), set("hour", 22)]
const street = (aim: number) => [...night, set("zoom", 42), { command: "player.pose", args: { x: 24, y: 44, aim } }]
const hall = (aim: number) => [...night, set("zoom", 34), { command: "player.pose", args: { x: 27.7, y: 31, aim, openDoor: true } }]

// Beam off is today's closed-form air glow; Low, Medium and High are the volumetric quality tiers (Backquote › Flashlight).
const variants: StationVariant[] = [
  { id: "beam-off", label: "Beam off", note: "Closed-form air glow only (Noir v2).", setup: [...street(0.12), set("beamQuality", 0)] },
  { id: "beam-low", label: "Low", note: "1/4 resolution, 6 samples.", setup: [...street(0.12), set("beamQuality", 1)] },
  { id: "beam-medium", label: "Medium", note: "Default: 1/2 resolution, 8 samples.", setup: [...street(0.12), set("beamQuality", 2)] },
  { id: "beam-high", label: "High", note: "1/2 resolution, 14 samples.", setup: [...street(0.12), set("beamQuality", 3)] },
  { id: "raised", label: "Raised aim", note: "Pistol light on the raised barrel.", setup: [...street(-0.35), set("beamQuality", 2), { command: "survivor.aim-demo", args: { mode: "aim-fire" } }] },
  { id: "rain", label: "Rain", note: "Rain and mist thicken the air.", setup: [...street(0.12), set("beamQuality", 2), { command: "weather.preset", args: { preset: "rain" } }] },
  { id: "doorway", label: "Through a doorway", note: "Door frame cuts the shaft.", setup: [...hall(Math.PI), set("beamQuality", 2)] },
]

export default defineStation({
  id: "outbreak-flashlight",
  title: "Outbreak flashlight",
  summary:
    "The live game at night with the survivor's flashlight as a volumetric shaft from the pistol or hand. Variants switch the beam off and through its quality tiers, raise the pistol, add rain and aim through a doorway.",
  order: 101,
  prop: "lamp",
  color: 0xffc46b,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "beam-medium",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-12" },
  metrics: [
    { label: "Volumetric pass + composite, Medium, 3456×1894, aimed north / across the screen", value: "0.06 / 0.13 ms street, 0.04 / 0.23 ms interior", source: "games/outbreak/scripts/ab-gpu.ts (pass amplified ×5, paired)" },
    { label: "High vs Medium per pass, aimed north", value: "0.10 / 0.09 ms street / interior", source: "games/outbreak/scripts/ab-gpu.ts" },
  ],
  paths: ["games/outbreak/src/flashlight-beam.ts", "games/outbreak/src/lighting.ts", "games/outbreak/scripts/beam-sweep.ts"],
  branches: ["flashlight-beam"],
  links: [{ label: "Play Outbreak at night", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    dock: [{ widget: "variants" }],
  },
})
