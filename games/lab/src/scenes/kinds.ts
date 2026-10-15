import type { KindChoice, LabKind, LabPanel } from "@arcade/kit/lab/scenes/kinds"
import type { SlotFor } from "@arcade/kit/lab/scenes/migrate"
import type { SceneHost } from "@arcade/kit/lab/scenes/model"

/**
 * Every kind of lab the Lab can open today, one per subject. Section kinds run a Lab section; page kinds embed an
 * Arcade page. Each lists only the panels its subject needs (AR-25: no global asset browser).
 */
const tuning: readonly LabPanel[] = ["controls", "variants", "readouts", "measured", "views", "notes", "work"]
const animated: readonly LabPanel[] = [...tuning, "timeline"]
const page: readonly LabPanel[] = ["variants", "measured", "notes", "work"]

const weatherPresets = ["rain", "drizzle", "storm", "fog", "snow", "clear"]
const lookPresets = ["noir", "painterly", "dusk", "sodium_70s", "cozy", "current"]
const directions = ["noir", "painterly", "dusk", "70s", "cozy", "shipped"]
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
  { id: "explosion", label: "Effect", subject: "A shared effect: explosion, smoke, fire or debris", host: { kind: "section", section: "effects" }, panels: animated },
  { id: "splatter", label: "Splatter", subject: "Blood and splatter decals on a surface", host: { kind: "section", section: "splatter" }, panels: animated },
  { id: "fire-water", label: "Fire and water", subject: "Flames, hydrant spray and puddles", host: { kind: "section", section: "fire-water" }, panels: animated },
  { id: "blackout-fx", label: "Blackout effect", subject: "One Blackout weapon or impact effect", host: { kind: "section", section: "blackout-effects" }, panels: animated },
  { id: "getaway-fx", label: "Getaway effect", subject: "One Getaway vehicle effect", host: { kind: "section", section: "getaway-effects" }, panels: animated },
  {
    id: "weather",
    label: "Weather",
    subject: "Rain, fog, snow and wind",
    host: { kind: "section", section: "weather" },
    panels: [...tuning, "choices"],
    choices: [choice("preset", "Weather", "subject", "weather", weatherPresets)],
  },
  { id: "vegetation", label: "Vegetation", subject: "A tree, bush or grass recipe in its test room", host: { kind: "section", section: "foliage" }, panels: tuning },
  {
    id: "look",
    label: "Look",
    subject: "A colour grade and its scene terms",
    host: { kind: "section", section: "looks" },
    panels: [...tuning, "choices"],
    choices: [choice("preset", "Look", "subject", "look", lookPresets)],
  },
  { id: "light", label: "Light", subject: "The lighting rig: lamps, moon, spot and shadows", host: { kind: "section", section: "lighting" }, panels: tuning },
  { id: "material", label: "Material", subject: "A material recipe on swatches", host: { kind: "section", section: "materials" }, panels: tuning },
  { id: "physics", label: "Physics", subject: "Rigid bodies and collisions", host: { kind: "section", section: "physics" }, panels: animated },
  { id: "sound", label: "Sound", subject: "A sound, its variants and its mix", host: { kind: "section", section: "audio" }, panels: ["controls", "variants", "readouts", "notes", "work"] },
  {
    id: "vehicle",
    label: "Vehicle",
    subject: "A car on a test course",
    host: { kind: "section", section: "spawn" },
    panels: [...tuning, "add"],
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
    panels: [...tuning, "choices"],
    choices: [choice("direction", "Art direction", "subject", "vignette", directions)],
  },
  { id: "rug", label: "Rug", subject: "A procedural rug: pattern, palette and wear", host: { kind: "section", section: "rugs" }, panels: tuning },
  {
    id: "style",
    label: "Style",
    subject: "One rendering style on the same Outbreak room combat sim",
    host: { kind: "section", section: "styles" },
    panels: [...tuning, "choices"],
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
    panels: [...page, "controls", "actions", "readouts", "timeline", "views"],
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
  { id: "progression", label: "Progression", subject: "Inventory, research and the workbench", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "pacing", label: "Pacing", subject: "Outbreak's first night: waves, threat and quiet", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "flashlight", label: "Flashlight", subject: "The survivor's flashlight beam in the game", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "outbreak-vehicle", label: "Outbreak vehicle", subject: "Outbreak's cars: finding keys and a battery, headlights, running down the horde", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Drive" },
  { id: "map", label: "Map", subject: "Outbreak's town map and its districts", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "melee", label: "Melee", subject: "Outbreak's melee weapons: swings, hits and timing", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "unseen", label: "Unseen", subject: "What the survivor can't see, and how it reads", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "interiors", label: "Interiors", subject: "Rugs and furnishing in Outbreak's house interiors", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "discovery", label: "Discovery", subject: "What the survivor learns by looking, not by being told", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "bots", label: "Bots", subject: "Survivor bots and the difficulty tuner", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "hordes", label: "Hordes", subject: "Outbreak's roaming hordes and the flow fields they follow", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "ship", label: "Ship", subject: "A Carrier ship and sea at a time of day", host: { kind: "page", url: "/arcade/carrier/" }, panels: page },
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
  "outbreak-flashlight": "flashlight",
  "outbreak-vehicles": "outbreak-vehicle",
  "outbreak-map": "map",
  "outbreak-melee": "melee",
  "outbreak-unseen": "unseen",
  "rugs-interiors": "interiors",
  "survivor-bots": "bots",
  "outbreak-discovery": "discovery",
  "outbreak-hordes": "hordes",
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
