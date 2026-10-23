import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * How BARBARA's Backquote panel is laid out: a few top-level sections, each folded, with sub-headings (also folded)
 * for what used to be the subsystems' own groups. Every subsystem keeps adding its rows as before (same keys, so saved
 * values and links still work); `arrangeControl` (the panel's `arrange`) moves each row to its section.
 */
export const SECTIONS = ["Looks & Triggers", "Light & Sky", "Weather", "Forest", "Camp", "People", "Creature", "Map & tape", "Sound", "Camera", "Debug"] as const
export type Section = (typeof SECTIONS)[number]
export const LOOKS_SECTION: Section = "Looks & Triggers"

type Place = { section: Section; sub?: string }

/** Rows that move by key, before their group decides (feel knobs that sit in the wrong subsystem group). */
const BY_KEY: Record<string, Place> = {
  campGlow: { section: "Camp", sub: "Camp lights" },
  ridgeGlow: { section: "Camp", sub: "Ridge beacon" },
  trunkDensity: { section: "Forest", sub: "Trees" },
  flashFlicker: { section: "Light & Sky", sub: "Flashlight" },
  "woods.windows": { section: "Camp", sub: "Camp lights" },
  "woods.stringLights": { section: "Camp", sub: "Camp lights" },
  "woods.campDetail": { section: "Camp", sub: "Camp" },
  "woods.water": { section: "Camp", sub: "Lake" },
}

/** Old group (and sub-heading) → section and sub-heading. */
function placeOf(c: LabControl): Place {
  const byKey = BY_KEY[c.key]
  if (byKey) return byKey
  const g = c.group ?? "", s = c.subsection
  switch (g) {
    case LOOKS_SECTION: return { section: LOOKS_SECTION, ...(s ? { sub: s } : {}) }
    case "Flashlight": return { section: "Light & Sky", sub: s ? ({ Shadows: "Flashlight shadows", "In the air": "Flashlight in the air", "Beam profile": "Flashlight beam profile", Hand: "Flashlight in the hand" } as Record<string, string>)[s] ?? `Flashlight: ${s}` : "Flashlight" }
    case "Night": return { section: "Light & Sky", sub: s === "Moon" ? "Moon" : /^woods\.sky[A-Z]/.test(c.key) ? "Catalogue sky" : "Night sky" }
    case "Mist": return { section: "Weather", sub: !s ? "Mist" : s === "Beam in the mist" ? s : `Mist: ${s.toLowerCase()}` }
    case "Weather": return { section: "Weather", sub: s === "Eye adaptation" ? "Eye after a flash" : s === "Sky" ? "Overcast" : s ?? "Storm" }
    case "Forest": return s === "Wind" ? { section: "Weather", sub: "Wind" } : s === "Camp" || s === "Camp finish" ? { section: "Camp", sub: s } : { section: "Forest", sub: s ?? "Trees" }
    case "Water": return { section: "Camp", sub: "Lake" }
    case "Road flare": return { section: "Light & Sky", sub: s ? `Road flare: ${s.toLowerCase()}` : "Road flare" }
    case "Walking": return { section: "People", sub: "Walking" }
    case "Search": return { section: "People", sub: "The search" }
    case "Friends": return { section: "People", sub: s ? `Friends: ${s.toLowerCase()}` : "Friends" }
    case "Creature": return { section: "Creature", ...(s ? { sub: s } : {}) }
    case "Tape & map": return { section: "Map & tape", sub: "Tape and finds" }
    case "Map": return { section: "Map & tape", sub: s ? `Held map: ${s.toLowerCase()}` : "Held map" }
    case "Sound": return { section: "Sound", sub: s ?? "Mix" }
    case "Voices": return { section: "Sound", sub: "Voices" }
    case "Camera": return { section: "Camera", sub: s ?? "Exposure" }
    case "Camera feel": return { section: "Camera", sub: s ? `Feel: ${s.toLowerCase()}` : "Feel" }
    case "Camera look": return { section: "Camera", sub: s ? `Camera look: ${s.toLowerCase()}` : "Camera look" }
    default: return { section: "Debug", sub: s ? `${g || "Other"}: ${s}` : g || "Other" }
  }
}

/** The panel's `arrange`: the row in its section, under its sub-heading. */
export function arrangeControl(c: LabControl): LabControl {
  const p = placeOf(c)
  const { subsection: _old, ...rest } = c
  return { ...rest, group: p.section, ...(p.sub ? { subsection: p.sub } : {}) } as LabControl
}
