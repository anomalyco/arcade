import type { StationCommand, StationVariant } from "@arcade/kit/lab/overworld/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const stage = (scene: string): StationCommand[] => [
  { command: "scene.set-param", args: { key: "timeScale", value: 0 } },
  { command: "vehicle.stage", args: { scene } },
]

const variants: StationVariant[] = [
  {
    id: "driveway",
    label: "Starter sedan near spawn",
    note: "Press E to enter the running sedan parked on the street curb by Ash House. Drive with WASD, Space handbrake, H horn, F headlights, C seat.",
    setup: stage("driveway"),
  },
  {
    id: "night-headlights",
    label: "Noir night headlights",
    note: "In the Noir look, colour lives in light: the vehicle's halogen headlights cast real-time polar shadows and restore warm colour down the street.",
    setup: stage("night-headlights"),
  },
  {
    id: "need-battery",
    label: "Hardware 4x4 (Needs car battery)",
    note: "A 4x4 pickup parked at the Hardware Store with a dead battery. Press E while carrying a Car Battery to install it and start the engine.",
    setup: stage("need-battery"),
  },
  {
    id: "need-keys",
    label: "Police Cruiser (Needs key)",
    note: "A Police Cruiser parked by the Pharmacy. Press E with a Key on your belt to unlock the ignition and drive.",
    setup: stage("need-keys"),
  },
  {
    id: "police-cruiser",
    label: "Police Cruiser lightbar",
    note: "Running Police Cruiser at night with pulsing red/blue roof lightbar, headlights, and taillights.",
    setup: stage("police-cruiser"),
  },
  {
    id: "drift-night",
    label: "Handbrake drift at night",
    note: "The sedan plays a handbrake turn on its own, then hands back to you. Skid marks multiply onto the lit road, so in Noir they show where the headlights, flashlight and lamps fall; the smoke stays dim until a light catches it. Backquote › Driving FX tunes marks and slip.",
    setup: stage("drift-night"),
  },
  {
    id: "burnout-night",
    label: "Burnout at night",
    note: "Throttle against the handbrake on the spot: the rear tyres scrub a black patch and smoke, then launch away. Hold W and Space yourself to do it again; on a lawn the tyres throw brown dust and ruts instead.",
    setup: stage("burnout-night"),
  },
  {
    id: "horde-runover",
    label: "Zombie roadkill & horde grab",
    note: "Drive forward with W to knock back and run over zombies, or stop to let them grab and bang on the bodywork.",
    setup: stage("horde-runover"),
  },
]

export default defineStation({
  id: "outbreak-vehicles",
  title: "Outbreak vehicles",
  summary:
    "Drivable vehicles (Sedan, Police Cruiser, 4x4 Pickup, Utility Van) placed across districts with battery/key/fuel requirements, Noir headlights, skid marks, tyre smoke and screech from per-wheel slip, OBB collisions, zombie roadkill and grabbing, ChunkDelta persistence, and co-op driver prediction.",
  order: 117,
  prop: "car",
  color: 0xd9a441,
  status: "live",
  demo: { kind: "page", url: page },
  defaultVariant: "night-headlights",
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-23" },
  metrics: [
    {
      label: "Skid marks on screen (4,096 segments), paired GPU A/B",
      value: "+0.05–0.08 ms",
      source: "captures/driving-fx/after.json",
    },
    {
      label: "1.04 km drive @ 17.3 m/s (31 chunk transitions)",
      value: "p50 8.4 ms · p95 10.3 ms · transition p95 13.1 ms",
      source: "captures/outbreak-vehicles/proof.json",
    },
    {
      label: "Co-op driver prediction drift & zombie hits",
      value: "0.0031 m drift · 4/4 roadkill hits",
      source: "captures/outbreak-vehicles/proof.json",
    },
  ],
  paths: [
    "games/outbreak/shared/vehicles.ts",
    "games/outbreak/src/vehicles.ts",
    "games/outbreak/src/vehicle-mesh.ts",
    "games/outbreak/src/vehicle-audio.ts",
    "packages/kit/fx/skids.ts",
    "packages/kit/vehicle/slip.ts",
  ],
  branches: ["outbreak-vehicles"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
