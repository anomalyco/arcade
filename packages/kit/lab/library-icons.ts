import type { LabLibraryCategory } from "./types"

/** Line icons for Library items, drawn on a 16 px grid with the current text colour. */
const PATHS = {
  tree: '<path d="M8 1.8 4.2 7h2L3.4 11h9.2L9.8 7h2Z"/><path d="M8 11v3.2"/>',
  pine: '<path d="M8 1.5 5 6h1.6L4 10h2L3.5 13h9L10 10h2L9.4 6H11Z"/><path d="M8 13v1.8"/>',
  bush: '<path d="M2.5 12.5c-.8-2.6.9-4.6 2.8-4.3.2-2.3 2.4-3.6 4.3-2.7 1.8-.9 4 .6 3.6 3 1.6.5 1.7 2.8 1 4Z"/><path d="M1.5 12.5h13"/>',
  grass: '<path d="M2 13.5c.6-3 .4-5.4-.6-7.5M5 13.5c0-3.6.8-6.4 2.4-8.6M8.5 13.5c-.2-2.8-1.2-5-3-6.6M11 13.5c.4-2.4 1.6-4.4 3.6-6M13 13.5c-.3-1.8-1-3.2-2.2-4.2"/>',
  lot: '<path d="M2 8 8 3l6 5"/><path d="M3.5 7v6.5h9V7"/><path d="M7 13.5v-3.5h2v3.5"/>',
  cone: '<path d="M6.6 3h2.8l3 9.5H3.6Z"/><path d="M5.5 7.2h5M4.6 10h6.8M2.5 12.5h11"/>',
  box: '<path d="m8 2 5.5 3v6L8 14l-5.5-3V5Z"/><path d="M2.5 5 8 8l5.5-3M8 8v6"/>',
  barrel: '<ellipse cx="8" cy="3.6" rx="4" ry="1.6"/><path d="M4 3.6v8.8c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6V3.6M4 8c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6"/>',
  car: '<path d="M2 10.5V8.3l1.6-3.4h8.8L14 8.3v2.2Z"/><path d="M2 8.3h12"/><circle cx="4.7" cy="11.4" r="1.3"/><circle cx="11.3" cy="11.4" r="1.3"/>',
  person: '<circle cx="8" cy="3.4" r="1.7"/><path d="M8 5.6v4.6M5 7.6l3-1.4 3 1.4M6 14l2-3.8 2 3.8"/>',
  bulb: '<path d="M5.4 9.6a4 4 0 1 1 5.2 0c-.6.5-.9 1.1-.9 1.8H6.3c0-.7-.3-1.3-.9-1.8Z"/><path d="M6.4 13.4h3.2"/>',
  spot: '<path d="M4 2.5h3l1 3H3Z"/><path d="M3.5 5.5 1.5 14h12L8 5.5"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  moon: '<path d="M10.8 11.8A5 5 0 0 1 6.2 2.6a5.2 5.2 0 1 0 6.6 7.6 5 5 0 0 1-2 1.6Z"/>',
  smoke: '<path d="M4.2 13.5c-2 0-2.9-2.6-1.2-3.6-.6-2 1.4-3.4 3-2.4.4-2.6 4-3 4.8-.6 2-.2 3 2.2 1.8 3.4 1.2 1.6 0 3.2-1.6 3.2Z"/><path d="M8.4 4.4c-.6-1.1.1-2.3 1.3-2.4"/>',
  fire: '<path d="M8 14.2c-2.8 0-4.6-1.9-4.6-4.4 0-2.6 2.2-3.8 2.6-6.6 1.2.8 1.9 2 1.9 3.2.7-.5 1.2-1.4 1.3-2.4 1.8 1.4 3.4 3.4 3.4 5.8 0 2.5-1.8 4.4-4.6 4.4Z"/><path d="M8 14.2c-1.2 0-2-.8-2-1.9 0-1.2 1.1-1.8 1.4-3 1.6.9 2.6 1.8 2.6 3 0 1.1-.8 1.9-2 1.9Z"/>',
  burst: '<path d="m8 1.5 1.3 3.6 3.6-1.6-1.6 3.6 3.2 1.4-3.4 1.2 1.2 3.6-3.4-1.8L8 14.5l-.9-3-3.4 1.8 1.2-3.6-3.4-1.2 3.2-1.4L3.1 3.5l3.6 1.6Z"/>',
  drop: '<path d="M8 1.8c2.4 3 4.2 5.4 4.2 7.8A4.2 4.2 0 0 1 3.8 9.6C3.8 7.2 5.6 4.8 8 1.8Z"/>',
  rain: '<path d="M4 8.5a3 3 0 0 1 .6-5.9 3.6 3.6 0 0 1 6.8.8A2.6 2.6 0 0 1 12 8.5Z"/><path d="m5 10.5-1 3M8.2 10.5l-1 3M11.4 10.5l-1 3"/>',
  shards: '<path d="M2 2.5 7 7l-3.5 6.5L2 2.5ZM9 2l5 4-4.5 1Zm-.6 7 5.6 1-1.5 4Z"/>',
  sparks: '<path d="M8 8 3 3M8 8l5.5-3.5M8 8l1.5 6M8 8l-6 2.5"/><circle cx="8" cy="8" r="1.2"/>',
  splat: '<path d="M7.6 3.4c1.4-.6 1.8 1.4 3 1.2 1.6-.3 2.6 1.4 1.6 2.6-.8 1 .9 2.2-.2 3.4-1 1-2-.1-3 .9-1.2 1.2-3 .5-3.2-1C5.6 9.2 3.4 9 3.6 7.4c.2-1.4 2-1 2.2-2.2.2-1.2.6-1.5 1.8-1.8Z"/><circle cx="13" cy="12.6" r=".9"/><circle cx="2.6" cy="12" r=".7"/>',
  bullet: '<path d="M3 11.5 9.6 4.9a2.5 2.5 0 0 1 3.5 3.5L6.5 15"/><path d="m2 9 5 5M10.5 2.5l1 1"/>',
  wind: '<path d="M1.5 6h8.2a2 2 0 1 0-2-2M1.5 10h11a2 2 0 1 1-2 2M1.5 8h6"/>',
  wave: '<path d="M1.5 8h1.6M4.4 5v6M6.6 2.5v11M8.8 5.5v5M11 4v8M13.2 6.5v3"/>',
  sphere: '<circle cx="8" cy="8" r="5.6"/><path d="M2.6 9.4c1.6 1.4 9.2 1.4 10.8 0"/><path d="M5.2 5.4a3 3 0 0 1 2.4-1.4" stroke-opacity=".6"/>',
  swatch: '<rect x="2" y="2" width="5.4" height="5.4" rx="1"/><rect x="8.6" y="2" width="5.4" height="5.4" rx="1"/><rect x="2" y="8.6" width="5.4" height="5.4" rx="1"/><rect x="8.6" y="8.6" width="5.4" height="5.4" rx="1"/>',
  look: '<circle cx="8" cy="8" r="5.6"/><path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none" fill-opacity=".55"/>',
  room: '<path d="M2 13.5V4.5L8 2l6 2.5v9"/><path d="M2 13.5h12M8 2v11.5M2 4.5l6 2.5 6-2.5"/>',
  wheel: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="1.6"/><path d="M8 2.4v4M8 9.6v4M2.4 8h4M9.6 8h4"/>',
  solver: '<circle cx="5" cy="11" r="2.6"/><path d="M9 3.5h4.5V8H9Z"/><path d="M7 9.2 9.6 7"/>',
  replay: '<path d="M2.8 7.2A5.4 5.4 0 1 1 3.8 11"/><path d="M2.4 3.6v3.8h3.8"/>',
  section: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M2 5.5h12M5 5.5v8"/>',
  pin: '<path d="M8 14.5s4.5-4.4 4.5-8a4.5 4.5 0 0 0-9 0c0 3.6 4.5 8 4.5 8Z"/><circle cx="8" cy="6.4" r="1.6"/>',
  tool: '<path d="M9.8 2.2a3.4 3.4 0 0 0-3.4 4.4L2 11a1.4 1.4 0 0 0 2 2l4.4-4.4a3.4 3.4 0 0 0 4.4-3.4l-2 2-1.8-.4-.4-1.8Z"/>',
} as const

export type LibraryIcon = keyof typeof PATHS

const CATEGORY_ICON: Record<LabLibraryCategory, LibraryIcon> = {
  effects: "burst",
  objects: "box",
  lighting: "bulb",
  audio: "wave",
  materials: "sphere",
  foliage: "tree",
  looks: "look",
}

/** Whole words (plural allowed), so "vehicles" matches "vehicle" and "ash" doesn't match "splash". */
const w = (words: string) => new RegExp(`\\b(?:${words})(?:s|es)?\\b`)

/** Keyword rules over an entry's label, tag, group and id, checked in order; the first match wins. */
const RULES: readonly [RegExp, LibraryIcon][] = [
  [w("pine|spruce|fir|conifer"), "pine"],
  [w("outbreak lot|all three|bungalow|lot"), "lot"],
  [w("tree|oak|maple|birch|willow|elm"), "tree"],
  [w("bush|shrub|hedge|hydrangea"), "bush"],
  [w("grass|lawn|weeds|verge|meadow"), "grass"],
  [w("audio|sound|cue|footstep|engine|gunshot|sfx"), "wave"],
  [w("rain|storm|snow|drizzle|weather"), "rain"],
  [w("wind|gust|fog|mist|haze"), "wind"],
  [w("smoke|steam|dust|exhaust|vapou?r"), "smoke"],
  [w("fire|flame|burn|molotov|ember"), "fire"],
  [w("explosion|grenade|blast|burst|frag|detonation"), "burst"],
  [w("water|hydrant|splash|puddle|wet|fountain"), "drop"],
  [w("glass|window|pane|shard"), "shards"],
  [w("spark|electric|ricochet"), "sparks"],
  [w("blood|splat|splatter|gore|decal|paint"), "splat"],
  [w("shot|bullet|impact|gun|muzzle|tracer|hit"), "bullet"],
  [w("skid|tyre|tire|wheel|drift"), "wheel"],
  [w("car|vehicle|muscle|truck|van|sedan|taxi|police|bus"), "car"],
  [w("character|soldier|survivor|zombie|walker|player|human|npc"), "person"],
  [w("cone|bollard"), "cone"],
  [w("barrel|propane|tank|drum|canister"), "barrel"],
  [w("spot|flashlight|headlight|torch|beam"), "spot"],
  [w("moon|night"), "moon"],
  [w("sun|day|dusk|dawn"), "sun"],
  [w("lamp|light|bulb|neon|sodium|fluorescent"), "bulb"],
  [w("swatch|palette"), "swatch"],
  [w("material|concrete|brick|asphalt|wood|metal|plaster|tile|fabric"), "sphere"],
  [w("look|grade|noir|film|lut|tone"), "look"],
  [w("room|office|stage|yard|street|alley|plaza|interior"), "room"],
  [w("physics|solver|collision|rigid|ragdoll"), "solver"],
  [w("prop|crate|box|bench|desk|table|chair|bin|dumpster|sign"), "box"],
  [w("tool"), "tool"],
  [w("section"), "section"],
]

export type IconEntry = { id: string; label: string; tag: string; group: string }

/** The icon for a Library entry: keyword rules first, then its category's icon. */
export function libraryIconFor(entry: IconEntry, category: LabLibraryCategory): LibraryIcon {
  // Underscores and separators become spaces so `spawn-prop:propane_tank` matches word rules.
  const text = `${entry.label} ${entry.tag} ${entry.group} ${entry.id}`.toLowerCase().replace(/[_:./-]+/g, " ")
  if (category === "audio") return "wave"
  for (const [re, icon] of RULES) if (re.test(text)) return icon
  return CATEGORY_ICON[category]
}

export function libraryIconSvg(icon: LibraryIcon, size = 16): string {
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[icon]}</svg>`
}

export const LIBRARY_ICON_NAMES = Object.keys(PATHS) as LibraryIcon[]
