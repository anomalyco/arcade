import type { StationCommand, StationVariant } from "@arcade/kit/lab/stations/types"
import { defineStation } from "./define"

const page = "/arcade/outbreak/?seed=7&peaceful=1"
const set = (key: string, value: number | boolean | string) => ({ command: "scene.set-param", args: { key, value } })
const pose = (x: number, y: number, aim: number, extra: Record<string, boolean> = {}) => ({ command: "player.pose", args: { x, y, aim, ...extra } })

// Every variant starts from the game's own defaults for the other sections, so switching never leaves rain or a beam
// tier behind: the Shroud blend unseen look (D-21), Medium beam, clear weather.
const defaults: StationCommand[] = [
  set("unseenMode", 10),
  set("beamQuality", 2),
  { command: "weather.preset", args: { preset: "clear" } },
]

/** The start house at dusk, the default start: the survivor on the front walk at 17:30, looking up at the porch. */
const startHouse: StationCommand[] = [...defaults, set("timeScale", 0), set("hour", 17.5), set("zoom", 40), pose(27.7, 41, -Math.PI / 2)]
const look = (preset: string): StationCommand[] => [...startHouse, { command: "look.preset", args: { preset } }]
const hero = (style: number): StationCommand[] => [...look("today"), set("heroStyle", style)]

const night: StationCommand[] = [...defaults, set("timeScale", 0), set("hour", 22)]
const street = (aim: number) => [...night, set("zoom", 42), pose(24, 44, aim)]
const hall = (aim: number) => [...night, set("zoom", 34), pose(27.7, 31, aim, { openDoor: true })]
const unseen = (mode: number, hour = 22): StationCommand[] => [
  ...defaults,
  set("timeScale", 0),
  set("hour", hour),
  set("zoom", 36),
  set("unseenMode", mode),
  pose(27.7, 31.2, -0.45, { openDoor: true, flashlight: hour > 18 }),
]

const variants: StationVariant[] = [
  // Look presets: every knob in Look · Grade, Look · Lights and Look · Hero, named and versioned (look/presets.ts).
  { id: "today", boardOption: "1", label: "Look · Today", note: "The shipped look: Noir grade by hour, box survivor.", setup: look("today") },
  { id: "deeper-noir", boardOption: "2", label: "Look · Deeper noir", note: "Darker, greyer street; only the beam brings colour back.", setup: look("deeper-noir") },
  { id: "warm-practicals", boardOption: "3", label: "Look · Warmer practicals", note: "Amber porch and window pools that keep their colour.", setup: look("warm-practicals") },
  { id: "cold-moonlight", boardOption: "4", label: "Look · Colder moonlight", note: "Blue-grey moonlit street, dimmer lamps.", setup: look("cold-moonlight") },
  { id: "vivid-world", boardOption: "5", label: "Look · Vivid world, grey hero", note: "More colour in the world, a grey mannequin survivor.", setup: look("vivid-world") },
  { id: "big-walk", boardOption: "6", label: "Look · Big Walk contrast", note: "A flat dark figure with a crisp rim against a richer house.", setup: look("big-walk") },
  // The survivor's style alone, on today's world.
  { id: "hero-today", label: "Hero · Today", note: "Jacket, jeans and boots: today's box figure.", setup: hero(0) },
  { id: "hero-mannequin", label: "Hero · Matte mannequin", note: "Smooth putty-grey mannequin, no face, mitten hands.", setup: hero(1) },
  { id: "hero-silhouette", label: "Hero · Flat silhouette", note: "Near-black flat figure; a tight rim draws its edge.", setup: hero(2) },
  { id: "hero-capsule", label: "Hero · Capsule figure", note: "Chalky toy of capsules and a ball head.", setup: hero(3) },
  // The flashlight beam (was the outbreak-flashlight station): off and the volumetric tiers, at night.
  { id: "beam-off", label: "Beam · Off", note: "Closed-form air glow only (Noir v2).", setup: [...street(0.12), set("beamQuality", 0)] },
  { id: "beam-low", label: "Beam · Low", note: "1/4 resolution, 6 samples.", setup: [...street(0.12), set("beamQuality", 1)] },
  { id: "beam-medium", label: "Beam · Medium", note: "Default: 1/2 resolution, 8 samples.", setup: street(0.12) },
  { id: "beam-high", label: "Beam · High", note: "1/2 resolution, 14 samples.", setup: [...street(0.12), set("beamQuality", 3)] },
  { id: "beam-raised", label: "Beam · Raised aim", note: "Pistol light on the raised barrel.", setup: [...street(-0.35), { command: "survivor.aim-demo", args: { mode: "aim-fire" } }] },
  { id: "beam-rain", label: "Beam · Rain", note: "Rain and mist thicken the air.", setup: [...street(0.12), { command: "weather.preset", args: { preset: "rain" } }] },
  { id: "beam-doorway", label: "Beam · Through a doorway", note: "Door frame cuts the shaft.", setup: hall(Math.PI) },
  // What the survivor can't see (was the outbreak-unseen station); Shroud blend is the default (D-21).
  { id: "unseen-shroud-blend", label: "Unseen · Shroud blend (default)", note: "Dark shroud, a little film static and a faint warp.", setup: unseen(10) },
  { id: "unseen-off", label: "Unseen · Off", note: "Noir fog of war with no unseen post-process.", setup: unseen(0) },
  { id: "unseen-acid-knife", label: "Unseen · Acid Knife glitch", note: "Stepped block and scanline tear, red/cyan split.", setup: unseen(1) },
  { id: "unseen-warp", label: "Unseen · Warp wobble", note: "Slow domain-warped refraction outside sight.", setup: unseen(2) },
  { id: "unseen-dark-shroud", label: "Unseen · Dark shroud", note: "Soft penumbra into deep desaturated dark.", setup: unseen(3) },
  { id: "unseen-stale-memory", label: "Unseen · Stale memory", note: "Unseen rooms freeze as a faded snapshot.", setup: unseen(4) },
  { id: "unseen-noise-film", label: "Unseen · Noise film", note: "16mm grain thickening away from sight.", setup: unseen(5) },
  { id: "unseen-shroud-noise", label: "Unseen · Shroud + Noise", note: "Dark shroud with analog grain.", setup: unseen(6) },
  { id: "unseen-memory-warp", label: "Unseen · Memory + Warp", note: "Faded memory under slow refraction.", setup: unseen(7) },
  { id: "unseen-edge-glitch", label: "Unseen · Edge glitch + Shroud", note: "Glitch only on the sight boundary, over the shroud.", setup: unseen(8) },
  { id: "unseen-daylight", label: "Unseen · By day", note: "At 14:00 the unseen layers scale down.", setup: unseen(10, 14) },
]

export default defineStation({
  id: "outbreak-look",
  title: "Outbreak look",
  summary:
    "The start house at dusk in the live game, with every look knob in one place: survivor style, world grade, lamps and sky. Curated presets set all the knobs at once; the beam and unseen sections are here too.",
  order: 99,
  prop: "house",
  color: 0xd9a441,
  status: "review",
  demo: { kind: "page", url: page },
  defaultVariant: "today",
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
  ],
  branches: ["outbreak-look*"],
  links: [{ label: "Play Outbreak", href: "/arcade/outbreak/?seed=7" }],
  layout: {
    left: [{ widget: "status" }, { widget: "metrics" }],
    right: [
      { widget: "controls", title: "Look", groups: ["Look · Presets", "Look · Hero", "Look · Grade", "Look · Lights"] },
      { widget: "controls", id: "sections", title: "Beam and unseen", groups: ["Flashlight", "Unseen"] },
    ],
    dock: [{ widget: "variants" }],
  },
})
