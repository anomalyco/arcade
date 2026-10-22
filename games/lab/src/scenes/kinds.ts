import type { KindChoice, LabKind, LabPanel } from "@arcade/kit/lab/scenes/kinds"
import type { SlotFor } from "@arcade/kit/lab/scenes/migrate"
import type { SceneHost } from "@arcade/kit/lab/scenes/model"
import type { LabStation } from "@arcade/kit/lab/stations/types"

/**
 * Every kind of lab the Lab can open today, one per subject. Section kinds run a Lab section; page kinds embed an
 * Arcade page. Each opts into only the panels its subject needs (`LabPanel` in @arcade/kit/lab/scenes/kinds): the
 * Outliner only with placeable objects, the clock only for subjects that play out, compare only where directions are
 * weighed side by side, and never a voice-note panel.
 */
const still: readonly LabPanel[] = ["controls", "variants", "measured", "views"]
const effect: readonly LabPanel[] = [...still, "transport", "readouts", "timeline"]
const directions: readonly LabPanel[] = [...still, "choices", "compare"]
const page: readonly LabPanel[] = ["controls", "variants", "measured"]

const weatherPresets = ["rain", "drizzle", "storm", "fog", "snow", "clear"]
const lookPresets = ["noir", "painterly", "dusk", "sodium_70s", "cozy", "current"]
const vignetteDirections = ["noir", "painterly", "dusk", "70s", "cozy", "shipped"]
const parts = (prefix: string, ids: readonly string[]) => ids.map(id => ({ part: `${prefix}:${id}`, label: id.replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase()) }))
const choice = (slot: string, label: string, role: KindChoice["role"], prefix: string, ids?: readonly string[]): KindChoice => ({
  slot,
  label,
  role,
  prefix: `${prefix}:`,
  ...(ids ? { parts: parts(prefix, ids) } : {}),
})
const PROPS = ["cone", "barrier", "sawhorse", "bin", "dumpster", "bench", "planter", "crate", "pallet", "sign", "hydrant", "propane", "canister", "fuel"]

export const LAB_KINDS: readonly LabKind[] = [
  { id: "explosion", label: "Effect", subject: "A shared effect: explosion, smoke, fire or debris", host: { kind: "section", section: "effects" }, panels: effect },
  { id: "splatter", label: "Splatter", subject: "Blood and splatter decals on a surface", host: { kind: "section", section: "splatter" }, panels: effect },
  { id: "fire-water", label: "Fire and water", subject: "Flames, hydrant spray and puddles", host: { kind: "section", section: "fire-water" }, panels: effect },
  { id: "blackout-fx", label: "Blackout effect", subject: "One Blackout weapon or impact effect", host: { kind: "section", section: "blackout-effects" }, panels: effect },
  { id: "getaway-fx", label: "Getaway effect", subject: "One Getaway vehicle effect", host: { kind: "section", section: "getaway-effects" }, panels: effect },
  {
    id: "weather",
    label: "Weather",
    subject: "Rain, fog, snow and wind",
    host: { kind: "section", section: "weather" },
    panels: [...still, "choices"],
    choices: [choice("preset", "Weather", "subject", "weather", weatherPresets)],
  },
  { id: "vegetation", label: "Vegetation", subject: "A tree, bush or grass recipe in its test room", host: { kind: "section", section: "foliage" }, panels: still },
  {
    id: "look",
    label: "Look",
    subject: "A colour grade and its scene terms",
    host: { kind: "section", section: "looks" },
    panels: directions,
    choices: [choice("preset", "Look", "subject", "look", lookPresets)],
  },
  {
    id: "world",
    label: "Look and world",
    subject: "The shared debug world: look, light, weather, materials and vegetation as knobs and presets",
    host: { kind: "section", section: "world" },
    panels: [...still, "compare"],
  },
  { id: "light", label: "Light", subject: "The lighting rig: lamps, moon, spot and shadows", host: { kind: "section", section: "lighting" }, panels: still },
  { id: "material", label: "Material", subject: "A material recipe on swatches", host: { kind: "section", section: "materials" }, panels: still },
  { id: "physics", label: "Physics", subject: "Rigid bodies and collisions", host: { kind: "section", section: "physics" }, panels: [...still, "transport", "readouts", "timeline"] },
  { id: "sound", label: "Sound", subject: "A sound, its variants and its mix", host: { kind: "section", section: "audio" }, panels: ["controls", "variants"] },
  {
    id: "vehicle",
    label: "Vehicle",
    subject: "A car on a test course",
    host: { kind: "section", section: "spawn" },
    panels: [...still, "add", "objects"],
    // The car, what's selected and the course; not the room, characters or effects (the Spawn section has them all).
    groups: ["Vehicle & Skids", "Transform", "Light", "Items", "Lights"],
    add: [
      { group: "Obstacles", parts: parts("prop", PROPS) },
      { group: "Lights", parts: parts("light", ["lamp", "spotlight", "torch"]) },
    ],
    play: "Drive",
  },
  {
    id: "scene-look",
    label: "Scene look",
    subject: "An Outbreak house lot in the game's own renderer, under one art direction",
    host: { kind: "section", section: "outbreak-vignette" },
    panels: directions,
    choices: [choice("direction", "Art direction", "subject", "vignette", vignetteDirections)],
  },
  { id: "rug", label: "Rug", subject: "A procedural rug: pattern, palette and wear", host: { kind: "section", section: "rugs" }, panels: still },
  { id: "furniture", label: "Furniture", subject: "A generated furniture or clutter prop and its LODs", host: { kind: "section", section: "props" }, panels: still },
  {
    id: "style",
    label: "Style",
    subject: "One rendering style on the same Outbreak room combat sim",
    host: { kind: "section", section: "styles" },
    panels: [...directions, "readouts"],
    choices: [choice("style", "Style", "subject", "style")],
  },
  { id: "walk-cycle", label: "Walk cycle", subject: "A character's walk, run and poses on the shared rig", host: { kind: "page", url: "/arcade/blackout/characters.html" }, panels: [...page, "timeline"], play: "Walk" },
  { id: "aim", label: "Aim", subject: "The survivor's aim, fire and reload", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  {
    id: "feel",
    label: "Feel",
    subject: "Camera shake and kick, blur bursts, hit-stop, damage flash and blood, on the survivor and a few dummy zombies",
    // Phase 2 runs in the Outbreak page; phase 4 moves it to a Lab arena built on the Styles section's room sim.
    host: { kind: "page", url: "/arcade/outbreak/" },
    panels: [...page, "actions", "readouts", "timeline", "views"],
    actions: [
      { id: "shot", label: "Shot", key: "S", command: "camera.impulse", args: { kind: "shot", power: 1 } },
      { id: "shove", label: "Shove", key: "V", command: "camera.impulse", args: { kind: "shove", power: 1 } },
      { id: "hit-taken", label: "Hit taken", key: "T", command: "camera.impulse", args: { kind: "hit-taken", damage: 25 } },
      // Needs a feel.kill command (a killing shot on the nearest dummy); camera.impulse has no kill kind yet.
      { id: "kill", label: "Kill", key: "X", command: "feel.kill" },
      { id: "explosion", label: "Explosion", key: "B", command: "camera.impulse", args: { kind: "explosion", power: 1 } },
    ],
    play: "Play",
  },
  { id: "hud", label: "HUD", subject: "The HUD through a night moment", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "progression", label: "Progression", subject: "Inventory, recipes and the workbench", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "pacing", label: "Pacing", subject: "Outbreak's first night: waves, threat and quiet", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-vehicle", label: "Outbreak vehicle", subject: "Outbreak's cars: finding keys and a battery, headlights, running down the horde", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Drive" },
  { id: "map", label: "Map", subject: "Outbreak's town map and its districts", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "melee", label: "Melee", subject: "Outbreak's melee weapons: swings, hits and timing", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  {
    id: "outbreak-look",
    label: "Outbreak look",
    subject: "The start house at dusk: survivor style, grade, lamps and sky, the beam and what the survivor can't see",
    host: { kind: "page", url: "/arcade/outbreak/" },
    panels: page,
    play: "Play",
  },
  { id: "interiors", label: "Interiors", subject: "Rugs and furnishing in Outbreak's house interiors", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "discovery", label: "Discovery", subject: "What the survivor learns by looking, not by being told", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "bots", label: "Bots", subject: "Survivor bots and the difficulty tuner", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "blood-lights", label: "Blood & night lights", subject: "Outbreak's blood that stays in the world and its coloured night practicals", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "details", label: "World details", subject: "Outbreak's lived-in, then-abandoned rooms and streets, and the crows, televisions and dogs that keep it alive", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-vegetation", label: "Trees & wind", subject: "Outbreak's trees, hedges, shrubs and grass and the gusts that move them", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-houses", label: "Houses", subject: "Outbreak's seeded house styles: forms, conditions, roofs, porches, yards and households", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "hordes", label: "Hordes", subject: "Outbreak's roaming hordes and the flow fields they follow", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-fire", label: "Fire & explosives", subject: "Outbreak's flamethrower, dynamite, firecrackers, molotovs, flare gun and bear traps, and the fire they light", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-weather", label: "Weather", subject: "Outbreak's seeded weather: rain in the light, the wet road and its puddles, lightning and thunder", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "impact", label: "Combat oomph", subject: "Outbreak's hits and deaths: hit reactions, ragdolls, bodies pushed by blasts and cars, weapon-weighted hit-stop", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "interactions", label: "World interactions", subject: "Outbreak's ways to act on the world: throwables with an arc, loose furniture dragged and braced against doors, hauling a downed teammate", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "breach", label: "Door breaches", subject: "Outbreak's doors and barricades as the dead break them: wear you can read, the warning beat, and how they give", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-secrets", label: "Secrets", subject: "Outbreak's subtle details, strange sightings and one hidden chain, staged one at a time", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-characters", label: "Who they were", subject: "Outbreak's dead as the people they were: callings, wear, habit loops they keep until they notice you, and small body language", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "zombie-behaviour", label: "Zombie behaviour", subject: "How Outbreak's dead hear, follow, search and give up, rest by day, herd at night, feed and climb, each with its own walk", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "way-out", label: "The Way Out", subject: "Outbreak's hidden way out of town: the clues, the destination at night, the final stand and the escape", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "onboarding", label: "Onboarding", subject: "Outbreak's training room and the clearer E prompts: one wordless beat at a time from the bed to the street", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "ship", label: "Ship", subject: "A Carrier ship and sea at a time of day", host: { kind: "page", url: "/arcade/carrier/" }, panels: page },
  { id: "brawler", label: "Brawler", subject: "Brawl's characters, their abilities and the props they throw around", host: { kind: "page", url: "/arcade/brawl/playground.html" }, panels: page, play: "Play" },
  { id: "woods-camera", label: "Woods camera", subject: "The night woods through different cameras and the realism effects a real camera adds", host: { kind: "page", url: "/arcade/woods/" }, panels: page, play: "Play" },
  { id: "archer", label: "Archer", subject: "Archers' arenas, movement tuning and power-ups", host: { kind: "page", url: "/arcade/archers/playground.html" }, panels: page, play: "Play" },
]

/** Page stations share URLs, so their kind is by station id. */
const PAGE_STATIONS: Record<string, string> = {
  characters: "walk-cycle",
  "survivor-aim": "aim",
  "game-feel": "feel",
  "outbreak-hud": "hud",
  "outbreak-progression": "progression",
  carrier: "ship",
  "first-night": "pacing",
  "outbreak-vehicles": "outbreak-vehicle",
  "outbreak-map": "map",
  "outbreak-melee": "melee",
  "outbreak-look": "outbreak-look",
  "rugs-interiors": "interiors",
  "survivor-bots": "bots",
  "outbreak-discovery": "discovery",
  "outbreak-hordes": "hordes",
  "outbreak-fire": "outbreak-fire",
  "outbreak-weather": "outbreak-weather",
  "outbreak-way-out": "way-out",
  "outbreak-blood-lights": "blood-lights",
  "outbreak-details": "details",
  "outbreak-characters": "outbreak-characters",
  "outbreak-vegetation": "outbreak-vegetation",
  "outbreak-houses": "outbreak-houses",
  "outbreak-impact": "impact",
  "outbreak-interactions": "interactions",
  "outbreak-breach": "breach",
  "outbreak-secrets": "outbreak-secrets",
  "outbreak-zombie-behaviour": "zombie-behaviour",
  "outbreak-onboarding": "onboarding",
  brawl: "brawler",
  archers: "archer",
  "woods-camera": "woods-camera",
}

/** What a station nobody gave a kind yet opens as, so a new station file never stops the Lab from starting. */
export const FALLBACK_KINDS = { section: "section", page: "page" } as const

/** The kind that runs a host, and which of its choice slots each command prefix fills. */
export function kindOf(host: SceneHost, station?: string): { kind: string; slotFor: SlotFor } {
  const kind = host.kind === "page"
    ? LAB_KINDS.find(k => k.id === PAGE_STATIONS[station ?? ""])
    : LAB_KINDS.find(k => k.host.kind === "section" && k.host.section === host.section)
  if (!kind) {
    console.warn(`[labs] no lab kind runs ${host.kind === "page" ? `page station "${station}"` : `section "${host.section}"`}; add one to kinds.ts`)
    return { kind: FALLBACK_KINDS[host.kind], slotFor: () => undefined }
  }
  return { kind: kind.id, slotFor: prefix => kind.choices?.find(c => c.prefix === `${prefix}:`)?.slot }
}

/** The kind a station opens as (a page station by its id, a section station by its section); undefined for none yet. */
export function kindForStation(station: Pick<LabStation, "id" | "demo">): LabKind | undefined {
  if (station.demo.kind === "page") return LAB_KINDS.find(k => k.id === PAGE_STATIONS[station.id])
  const section = station.demo.section
  return LAB_KINDS.find(k => k.host.kind === "section" && k.host.section === section)
}
