import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1&infiniteAmmo=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean | number> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })
const spawn = (x: number, y: number, state = "chase") => ({ command: "ai.spawn", args: { x, y, state } })
const shot = (hour: number, zoom: number, ...rest: StationCommand[]): StationCommand[] => [set("timeScale", 0), set("hour", hour), set("zoom", zoom), ...rest]
const fight = (hour: number): StationCommand[] =>
  shot(
    hour,
    40,
    pose(27.7, 41, -Math.PI / 2, { flashlight: true, clearZombiesRadius: 16 }),
    spawn(27.2, 37.4),
    spawn(28.6, 37.8),
    spawn(26.4, 38.6),
    spawn(29.4, 38.9),
    spawn(25.4, 39.6, "crawler"),
    { command: "survivor.aim-demo", args: { mode: "aim-fire" } },
  )

// Three groups that compose: how much Blood, which Night lights, then where and when.
const variants: StationVariant[] = [
  { id: "blood-today", group: "Blood", boardOption: "1", label: "Today", note: "Seeded stains in streets, yards and houses (more where something happened), fight stains that stay, pools that spread, crawler drag trails and bloody prints.", setup: [set("bloodWorld", true), set("bloodWorldDensity", 1), set("bloodIncidents", 0.5), set("bloodPersist", true)] },
  { id: "blood-heavy", group: "Blood", boardOption: "2", label: "Heavy", note: "Twice the stains and something happened in every house.", setup: [set("bloodWorld", true), set("bloodWorldDensity", 2), set("bloodIncidents", 1), set("bloodPersist", true)] },
  { id: "blood-light", group: "Blood", boardOption: "3", label: "Light", note: "Half the world stains, a quarter of the houses.", setup: [set("bloodWorld", true), set("bloodWorldDensity", 0.5), set("bloodIncidents", 0.25), set("bloodPersist", true)] },
  { id: "blood-off", group: "Blood", label: "Off (before)", note: "Only the wet splatter, which fades after about 30 s.", setup: [set("bloodWorld", false), set("bloodPersist", false)] },
  { id: "lights-today", group: "Night lights", boardOption: "1", label: "Today", note: "Car alarms flash amber and red on the street; some police cars still flash red and blue, some shops sweep a red alarm beacon, broken neon, dying sodium lamps.", setup: [set("nightLights", true), set("nlCruisers", 0.25), set("nlBeacons", 0.35), set("nlNeon", 0.5), set("nlSodiumFlicker", 0.18)] },
  { id: "lights-all", group: "Night lights", label: "Every one on", note: "Every car a police car, every shop a beacon and a sign: for tuning, not for play.", setup: [set("nightLights", true), set("nlCruisers", 1), set("nlBeacons", 1), set("nlNeon", 1), set("nlSodiumFlicker", 0.5)] },
  { id: "lights-off", group: "Night lights", label: "Off (before)", note: "Only the warm street, porch and window lamps.", setup: [set("nightLights", false)] },
  { id: "house-night", group: "Shot", label: "Start house, night", note: "Ash was broken into: a pool, a drag trail toward the door and a hand print on the wall, at 21:00 by flashlight.", setup: shot(21, 38, pose(27.7, 31.2, -0.3, { openDoor: true, flashlight: true })) },
  { id: "hardware-night", group: "Shot", label: "Hardware frontage, night", note: "A wailing car alarm beside a police car with its bar still flashing and the shop's red beacon sweeping the pavement, 22:00.", setup: shot(22, 40, pose(50.5, 44.5, 0.1, { flashlight: true }), { command: "discovery.stage", args: { scene: "car-alarm" } }) },
  { id: "fight-night", group: "Shot", label: "Fight, night", note: "Four zombies and a crawler shot on the street at 21:00: spray, pools under the bodies, a drag trail.", setup: fight(21) },
  { id: "fight-day", group: "Shot", label: "Fight, day", note: "The same fight at 14:00: dark wine-brown blood that only shows red in light.", setup: fight(14) },
]

export default defineStation({
  id: "outbreak-blood-lights",
  title: "Outbreak blood & night lights",
  summary:
    "Darkwood-style grimy blood that stays in the world (seeded stains from the town seed, persistent fight stains in a bounded ring, pools, drag trails, prints) and coloured night practicals (car alarms, police light bars, shop alarm beacons, neon, dying sodium lamps). Backquote › Blood and › Night lights.",
  order: 123,
  prop: "burst",
  color: 0x7a1a14,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["blood-today", "lights-today", "hardware-night"],
  variants: variants.map((v) => ({ ...v, url: page })),
  board: { feature: "AR-55" },
  paths: ["games/outbreak/src/blood", "games/outbreak/src/night-lights", "games/outbreak/src/scene/frame-renderer.ts"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
})
