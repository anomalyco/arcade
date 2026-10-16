import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })

// The variants are seven groups that compose: a Look, a Hero on top of it, where and when (Shot), surface detail, the
// weather, the beam tier and the unseen layer. Each sets only its own knobs and every group's pick is applied in this
// order, so choosing a Hero keeps the Look and switching the Shot keeps the beam tier.
const look = (preset: string): StationCommand[] => [{ command: "look.preset", args: { preset } }]
const hero = (style: number): StationCommand[] => [set("heroStyle", style)]
const shot = (hour: number, zoom: number, at: StationCommand, ...extra: StationCommand[]): StationCommand[] => [set("timeScale", 0), set("hour", hour), set("zoom", zoom), at, ...extra]
const street = (aim: number) => pose(24, 44, aim)
const hall = (flashlight: boolean) => pose(27.7, 31.2, -0.45, { openDoor: true, flashlight })

const variants: StationVariant[] = [
  // Look presets: every knob in Look · Grade, Look · Lights and Look · Hero, named and versioned (look/presets.ts).
  { id: "today", group: "Look", boardOption: "1", label: "Today", note: "The shipped look: Noir grade by hour, box survivor.", setup: look("today") },
  { id: "deeper-noir", group: "Look", boardOption: "2", label: "Deeper noir", note: "Darker, greyer street; only the beam brings colour back.", setup: look("deeper-noir") },
  { id: "warm-practicals", group: "Look", boardOption: "3", label: "Warmer practicals", note: "Amber porch and window pools that keep their colour.", setup: look("warm-practicals") },
  { id: "cold-moonlight", group: "Look", boardOption: "4", label: "Colder moonlight", note: "Blue-grey moonlit street, dimmer lamps.", setup: look("cold-moonlight") },
  { id: "vivid-world", group: "Look", boardOption: "5", label: "Vivid world, grey hero", note: "More colour in the world, a grey mannequin survivor.", setup: look("vivid-world") },
  { id: "big-walk", group: "Look", boardOption: "6", label: "Big Walk contrast", note: "A flat dark figure with a crisp rim against a richer house.", setup: look("big-walk") },
  // The survivor's style over the Look; "From the look" keeps the one the Look preset chose.
  { id: "hero-from-look", group: "Hero", label: "From the look", note: "The survivor style the Look preset sets.", setup: [] },
  { id: "hero-today", group: "Hero", label: "Today", note: "Jacket, jeans and boots: today's box figure.", setup: hero(0) },
  { id: "hero-mannequin", group: "Hero", label: "Matte mannequin", note: "Smooth putty-grey mannequin, no face, mitten hands.", setup: hero(1) },
  { id: "hero-silhouette", group: "Hero", label: "Flat silhouette", note: "Near-black flat figure; a tight rim draws its edge.", setup: hero(2) },
  { id: "hero-capsule", group: "Hero", label: "Capsule figure", note: "Chalky toy of capsules and a ball head.", setup: hero(3) },
  // Where the survivor stands and when: the start house at dusk is the default start.
  { id: "front-walk-dusk", group: "Shot", label: "Front walk, dusk", note: "The default start: the front walk at 17:30, looking up at the porch.", setup: shot(17.5, 40, pose(27.7, 41, -Math.PI / 2)) },
  { id: "street-night", group: "Shot", label: "Street, night", note: "Down the road at 22:00, beam along the street.", setup: shot(22, 42, street(0.12)) },
  { id: "street-raised-aim", group: "Shot", label: "Street, raised aim", note: "Pistol light on the raised barrel.", setup: shot(22, 42, street(-0.35), { command: "survivor.aim-demo", args: { mode: "aim-fire" } }) },
  { id: "doorway-night", group: "Shot", label: "Doorway, night", note: "The door frame cuts the beam.", setup: shot(22, 34, pose(27.7, 31, Math.PI, { openDoor: true })) },
  { id: "hallway-night", group: "Shot", label: "Hallway, night", note: "Inside at 22:00, flashlight on: the unseen layer around the beam.", setup: shot(22, 36, hall(true)) },
  { id: "entry-hall-night", group: "Shot", label: "Entry hall from above", note: "19:00 on the hall runner by the front door, flashlight up the hall: Kit's Resident Evil house frame.", setup: shot(19, 26, pose(27.7, 34.3, -Math.PI / 2, { flashlight: true })) },
  { id: "hallway-day", group: "Shot", label: "Hallway, day", note: "At 14:00 the unseen layers scale down.", setup: shot(14, 36, hall(false)) },
  // Detail spikes for a Resident Evil house (AR-42): the painted floor plate is Ash's living room and hall only.
  { id: "detail-today", group: "Detail", label: "Today", note: "Procedural floorboards.", setup: [set("paintedPlate", 0)] },
  { id: "painted-plate", group: "Detail", label: "Painted floor plate", note: "Living room and hall floor from the RE mansion paint-over, rectified through the camera, lit live.", setup: [set("paintedPlate", 1)] },
  { id: "clear", group: "Weather", label: "Clear", note: "No rain.", setup: [{ command: "weather.preset", args: { preset: "clear" } }] },
  { id: "rain", group: "Weather", label: "Rain", note: "Rain and mist thicken the air.", setup: [{ command: "weather.preset", args: { preset: "rain" } }] },
  // The flashlight beam (was the outbreak-flashlight station): off and the volumetric tiers.
  { id: "beam-off", group: "Beam", label: "Off", note: "Closed-form air glow only (Noir v2).", setup: [set("beamQuality", 0)] },
  { id: "beam-low", group: "Beam", label: "Low", note: "1/4 resolution, 6 samples.", setup: [set("beamQuality", 1)] },
  { id: "beam-medium", group: "Beam", label: "Medium", note: "Default: 1/2 resolution, 8 samples.", setup: [set("beamQuality", 2)] },
  { id: "beam-high", group: "Beam", label: "High", note: "1/2 resolution, 14 samples.", setup: [set("beamQuality", 3)] },
  // What the survivor can't see (was the outbreak-unseen station); Shroud blend is the default (D-21).
  { id: "unseen-shroud-blend", group: "Unseen", label: "Shroud blend", note: "The default: dark shroud, a little film static and a faint warp.", setup: [set("unseenMode", 10)] },
  { id: "unseen-off", group: "Unseen", label: "Off", note: "Noir fog of war with no unseen post-process.", setup: [set("unseenMode", 0)] },
  { id: "unseen-acid-knife", group: "Unseen", label: "Acid Knife glitch", note: "Stepped block and scanline tear, red/cyan split.", setup: [set("unseenMode", 1)] },
  { id: "unseen-warp", group: "Unseen", label: "Warp wobble", note: "Slow domain-warped refraction outside sight.", setup: [set("unseenMode", 2)] },
  { id: "unseen-dark-shroud", group: "Unseen", label: "Dark shroud", note: "Soft penumbra into deep desaturated dark.", setup: [set("unseenMode", 3)] },
  { id: "unseen-stale-memory", group: "Unseen", label: "Stale memory", note: "Unseen rooms freeze as a faded snapshot.", setup: [set("unseenMode", 4)] },
  { id: "unseen-noise-film", group: "Unseen", label: "Noise film", note: "16mm grain thickening away from sight.", setup: [set("unseenMode", 5)] },
  { id: "unseen-shroud-noise", group: "Unseen", label: "Shroud + Noise", note: "Dark shroud with analog grain.", setup: [set("unseenMode", 6)] },
  { id: "unseen-memory-warp", group: "Unseen", label: "Memory + Warp", note: "Faded memory under slow refraction.", setup: [set("unseenMode", 7)] },
  { id: "unseen-edge-glitch", group: "Unseen", label: "Edge glitch + Shroud", note: "Glitch only on the sight boundary, over the shroud.", setup: [set("unseenMode", 8)] },
]

export default defineStation({
  id: "outbreak-look",
  title: "Outbreak look",
  summary:
    "The start house at dusk in the live game, with every look knob in one place: survivor style, world grade, lamps and sky. Curated presets set all the knobs at once; pick a Hero, shot, weather, beam tier and unseen layer on top of any Look.",
  order: 99,
  prop: "house",
  color: 0xd9a441,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: ["today", "hero-from-look", "front-walk-dusk", "detail-today", "clear", "beam-medium", "unseen-shroud-blend"],
  variants: variants.map(v => ({ ...v, url: page })),
  board: { feature: "AR-42", decision: "D-28" },
  metrics: [
    { label: "Volumetric beam pass + composite, Medium, 3456×1894", value: "0.06 / 0.13 ms street, 0.04 / 0.23 ms interior", source: "games/outbreak/scripts/ab-gpu.ts" },
    { label: "Unseen solo layers, GPU pass delta at 3456×1894", value: "+0.070 to +0.389 ms", source: "games/outbreak/scripts/prove-unseen.ts" },
  ],
  paths: [
    "games/outbreak/src/look",
    "packages/kit/avatar/simple-figure.ts",
    "games/outbreak/src/flashlight-beam.ts",
    "games/outbreak/src/unseen",
    "games/outbreak/src/interiors",
  ],
  branches: ["outbreak-look*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [
      { widget: "controls", title: "Look", groups: ["Look · Presets", "Look · Hero", "Look · Grade", "Look · Lights", "Look · Detail"] },
      { widget: "controls", id: "sections", title: "Beam and unseen", groups: ["Flashlight", "Unseen"] },
    ],
    dock: [{ widget: "variants" }],
  },
})
