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
  { id: "walk-cycle", label: "Walk cycle", subject: "A character's walk, run and poses on the shared rig", host: { kind: "page", url: "/arcade/blackout/characters.html" }, panels: [...page, "timeline"], play: "Walk" },
  { id: "aim", label: "Aim", subject: "The survivor's aim, fire and reload", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "feel", label: "Game feel", subject: "Hit, shot and shove feedback", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page, play: "Play" },
  { id: "hud", label: "HUD", subject: "The HUD through a night moment", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
  { id: "progression", label: "Progression", subject: "Inventory, research and the workbench", host: { kind: "page", url: "/arcade/outbreak/" }, panels: page },
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
}

/** The kind that runs a host, and which of its choice slots each command prefix fills. */
export function kindOf(host: SceneHost, station?: string): { kind: string; slotFor: SlotFor } {
  const kind = host.kind === "page"
    ? LAB_KINDS.find(k => k.id === PAGE_STATIONS[station ?? ""])
    : LAB_KINDS.find(k => k.host.kind === "section" && k.host.section === host.section)
  if (!kind) throw new Error(`No lab kind runs ${host.kind === "page" ? `page station "${station}"` : `section "${host.section}"`}`)
  return { kind: kind.id, slotFor: prefix => kind.choices?.find(c => c.prefix === `${prefix}:`)?.slot }
}
