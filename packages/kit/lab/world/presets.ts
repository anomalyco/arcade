/**
 * Curated presets for the Look and world lab: each is a named set of knob values over the defaults (Clear day,
 * Current look, Oak and Lawn, wet asphalt), one per idea the separate Looks, Lighting, Weather, Materials and
 * Vegetation labs used to show. Add a preset here rather than a new lab. Keys are the world section's setting keys.
 */
export const WORLD_PRESET_VERSION = 1

export type WorldPresetIdea = "look" | "light" | "sky" | "weather" | "materials" | "vegetation"
export type WorldPreset = {
  id: string
  label: string
  idea: WorldPresetIdea
  note: string
  values: Readonly<Record<string, string | number | boolean>>
}

export const WORLD_PRESETS: readonly WorldPreset[] = [
  { id: "sky-today", label: "Today", idea: "sky", note: "Original night background.", values: { hour: 0, skyMode: "today" } },
  { id: "sky-moonless", label: "Moonless", idea: "sky", note: "Catalogue stars, airglow and a faint Milky Way.", values: { hour: 0, skyMode: "physical", skyMoon: "none" } },
  { id: "sky-crescent", label: "Crescent", idea: "sky", note: "A half-degree crescent with earthshine.", values: { hour: 0, skyMode: "physical", skyMoon: "crescent" } },
  { id: "sky-half", label: "Half moon", idea: "sky", note: "Quarter-phase Moon.", values: { hour: 0, skyMode: "physical", skyMoon: "half" } },
  { id: "sky-full", label: "Full moon", idea: "sky", note: "Full Moon with a haze aureole.", values: { hour: 0, skyMode: "physical", skyMoon: "full" } },
  { id: "day", label: "Clear day", idea: "light", note: "13:00, no grade, dry: the neutral reference.", values: {} },
  { id: "golden-hour", label: "Golden hour", idea: "look", note: "18:30 sun low in the west under the Golden hour grade.", values: { hour: 18.5, lookPreset: "cozy_golden_hour" } },
  { id: "dusk", label: "Dusk", idea: "look", note: "19:30, lamps coming on, the Dusk grade.", values: { hour: 19.5, lookPreset: "cinematic_dusk" } },
  { id: "noir-rain", label: "Noir rain", idea: "look", note: "23:00 rain under the Noir grade with the survivor's flashlight.", values: { hour: 23, lookPreset: "noir", weatherPreset: "rain", flashlight: true } },
  { id: "sodium-70s", label: "70s sodium", idea: "look", note: "21:30 drizzle under the 70s sodium grade.", values: { hour: 21.5, lookPreset: "sodium_70s", weatherPreset: "drizzle" } },
  { id: "painterly", label: "Painterly", idea: "look", note: "Late afternoon under the Painterly grade.", values: { hour: 16.5, lookPreset: "painterly" } },
  { id: "storm", label: "Storm night", idea: "weather", note: "Heavy rain, wind and lightning at 22:30; the parked car's headlights on.", values: { hour: 22.5, weatherPreset: "storm", headlights: true } },
  { id: "rain-volumes", label: "Lamp-lit rain", idea: "weather", note: "Short streaks lit by three-dimensional lamp cones.", values: { hour: 22.5, weatherPreset: "rain", headlights: true, "rainLight.mode": "volume" } },
  { id: "storm-adaptation", label: "Flash recovery", idea: "weather", note: "A lightning flash leaves a darker view that gradually recovers.", values: { hour: 22.5, weatherPreset: "storm", headlights: true, "exposure.mode": "adapt" } },
  { id: "fog-dawn", label: "Foggy dawn", idea: "weather", note: "06:40, fog banks rolling over the street.", values: { hour: 6.7, weatherPreset: "fog" } },
  { id: "snow-night", label: "Snow night", idea: "weather", note: "Snow at 22:00 with the lamps on.", values: { hour: 22, weatherPreset: "snow" } },
  { id: "night-lamps", label: "Night lamps", idea: "light", note: "Midnight, dry: streetlamp, porch lamp and the lamp inside only.", values: { hour: 0 } },
  { id: "night-physical", label: "Night lamps, physical", idea: "light", note: "Night lamps under the physical light model: inverse-square pools, the streetlamp's 3D cone, GGX highlights and sky reflections.", values: { hour: 0, lightModel: "physical" } },
  { id: "spot-shadows", label: "Spot shadow maps", idea: "light", note: "Night lamps, physical, with perspective shadow maps for the streetlamp and porch cones: the canopy, car and porch roof cast what plan shadows can't.", values: { hour: 0, lightModel: "physical", spotShadows: 2 } },
  { id: "dying-lamps", label: "Dying lamps", idea: "light", note: "Midnight with the shared flicker: the sodium streetlamp cycles out and restrikes pink, the porch tube stutters.", values: { hour: 0, flicker: 1.5 } },
  { id: "brick-street", label: "Brick and concrete", idea: "materials", note: "Brick-red walls, dry asphalt, plaza paving, carpet inside.", values: { wall: "brick", street: 5, walk: 7, path: 7, floor: 0, car: "teal" } },
  { id: "autumn", label: "Autumn yard", idea: "vegetation", note: "Maple, an overgrown shrub and an overgrown lawn at 16:00.", values: { hour: 16, treePreset: "maple", bushPreset: "overgrown", grassPreset: "overgrown" } },
  { id: "pine-weeds", label: "Pine and weeds", idea: "vegetation", note: "A pine over weeds and dead grass, sage walls.", values: { treePreset: "pine", grassPreset: "weeds", bushPreset: "hydrangea", wall: "sage" } },
]

export const worldPreset = (id: string): WorldPreset | undefined => WORLD_PRESETS.find(p => p.id === id)

/** The order presets apply in: the picks that reset a whole state first, single knobs after. */
export const PRESET_PICKS = ["lookPreset", "weatherPreset", "treePreset", "bushPreset", "grassPreset"] as const

export type WorldPresetFile = {
  version: typeof WORLD_PRESET_VERSION
  kind: "arcade.lab.world"
  preset?: string
  values: Record<string, string | number | boolean>
}
