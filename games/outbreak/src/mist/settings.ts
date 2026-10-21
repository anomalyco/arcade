import type { FogSettings } from "@arcade/kit/gpu/fog-scatter"
import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Low mist in yards and gutters (Lab › Look · Low mist, `mistStyle` 0 is Today): the kit's drifting fog bank (#359,
 * `fogScatterVolume({ atmosphere: true })`) retuned for Outbreak's camera. From 38 m above, the Lot's 4 m bank read as
 * ~6 % haze, so the mist here is a dense, knee-high layer that pools where the ground is low: thick in yards and in
 * the gutters along the kerbs, thin on the carriageway and sidewalks, none indoors (`mist/wgsl.ts` `outbreakMistMask`).
 * It is grey sky-lit air at night, takes colour only where a lamp's glow or the torch's beam is in it, and the sight
 * shroud dims it like everything else (it leaves the scene's colour mask in HDR alpha alone).
 */
export type OutbreakMistSettings = {
  /** 0 Today (no mist), 1 low mist. */
  mistStyle: number
  /** Extinction inside the thickest mist, per metre. */
  mistDensity: number
  /** Mist layer height, metres. */
  mistHeight: number
  /** Size of the drifting billows, metres. */
  mistScale: number
  /** Clear gaps between billows (0 an even blanket). */
  mistGaps: number
  /** Drift speed, m/s. */
  mistWind: number
  /** Drift heading, degrees. */
  mistHeading: number
  /** Mist over yards and grass, × density. */
  mistYards: number
  /** Extra mist along the gutters by the kerbs, × density. */
  mistGutters: number
  /** Mist over the road and sidewalks, × density. */
  mistRoads: number
  /** Sky-lit mist brightness at night (kept near black: colour only in light). */
  mistNight: number
  /** Sky-lit mist brightness by day. */
  mistDay: number
  /** Lamp glow in the mist (the lamps' top-down glow map). */
  mistLamps: number
  /** How much more lamp and torch beams scatter inside the mist. */
  mistBeams: number
  /** March steps through the layer. */
  mistSteps: number
  /** The fog slot's resolution while the mist is on: 1/n of the screen per axis (the mist is soft, so 3 hides it). */
  mistDownscale: number
}

export const DEFAULT_MIST_SETTINGS: OutbreakMistSettings = {
  mistStyle: 0,
  mistDensity: 0.9,
  mistHeight: 1.1,
  mistScale: 5.5,
  mistGaps: 0.3,
  mistWind: 0.35,
  mistHeading: 210,
  mistYards: 1,
  mistGutters: 1.4,
  mistRoads: 0.3,
  mistNight: 0.006,
  mistDay: 0.05,
  mistLamps: 1.6,
  mistBeams: 6,
  mistSteps: 6,
  mistDownscale: 3,
}

const G = "Look · Low mist"

export const mistControls: readonly LabControl[] = [
  {
    key: "mistStyle",
    label: "Low mist",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Today (no mist)" },
      { value: 1, label: "Low mist in yards and gutters" },
    ],
  },
  { key: "mistDensity", label: "Density", group: G, min: 0, max: 4, step: 0.05, unit: "/m" },
  { key: "mistHeight", label: "Height", group: G, min: 0.3, max: 4, step: 0.05, unit: "m" },
  { key: "mistScale", label: "Billow size", group: G, min: 1, max: 20, step: 0.25, unit: "m" },
  { key: "mistGaps", label: "Gaps", group: G, min: 0, max: 0.9, step: 0.01, unit: "" },
  { key: "mistWind", label: "Drift", group: G, min: 0, max: 3, step: 0.05, unit: "m/s" },
  { key: "mistHeading", label: "Drift heading", group: G, min: 0, max: 360, step: 5, unit: "°" },
  { key: "mistYards", label: "Yards", group: G, subsection: "Where it pools", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "mistGutters", label: "Gutters", group: G, subsection: "Where it pools", min: 0, max: 3, step: 0.05, unit: "×" },
  { key: "mistRoads", label: "Road and sidewalks", group: G, subsection: "Where it pools", min: 0, max: 2, step: 0.05, unit: "×" },
  { key: "mistNight", label: "Sky light at night", group: G, subsection: "Light", min: 0, max: 0.05, step: 0.001, unit: "" },
  { key: "mistDay", label: "Sky light by day", group: G, subsection: "Light", min: 0, max: 0.3, step: 0.005, unit: "" },
  { key: "mistLamps", label: "Lamp glow in the mist", group: G, subsection: "Light", min: 0, max: 5, step: 0.05, unit: "×" },
  { key: "mistBeams", label: "Beams in the mist", group: G, subsection: "Light", min: 0, max: 20, step: 0.25, unit: "×" },
  { key: "mistSteps", label: "Steps", group: G, subsection: "Cost", min: 2, max: 12, step: 1 },
  { key: "mistDownscale", label: "Resolution", group: G, subsection: "Cost", type: "select", options: [{ value: 2, label: "Half" }, { value: 3, label: "Third" }, { value: 4, label: "Quarter" }] },
]

export const mistOn = (s: Pick<OutbreakMistSettings, "mistStyle"> | undefined): boolean => (s?.mistStyle ?? 0) > 0.5

/** Floats in the mist mask's volume params: (yards, gutters, roads, 0). */
export const MIST_PARAM_FLOATS = 4

/**
 * The fog the mist rides on: with the lamp fog at Today, a near-clear scatter medium (so only the bank and the beams
 * inside it show); otherwise the lamp fog's own settings with the bank added. `sun` 0..1 blends night to day sky light.
 */
export function mistFogSettings(base: FogSettings, lampFogOn: boolean, m: OutbreakMistSettings, sun: number, out: FogSettings): FogSettings {
  Object.assign(out, base)
  out.mode = "scatter"
  if (!lampFogOn) {
    out.density = 0.0015
    out.falloff = 0.12
    out.strength = 0.25
    out.leak = 0.02
  }
  out.base = 0
  out.hue = 205
  out.saturation = 0.08
  out.brightness = 1
  out.bank = "drift"
  out.bankDensity = m.mistDensity * 2
  out.bankHeight = m.mistHeight
  out.bankScale = m.mistScale
  out.bankThreshold = m.mistGaps
  out.bankUndulation = 0.7
  out.bankWind = m.mistWind
  out.bankWindHeading = m.mistHeading
  out.bankSteps = m.mistSteps
  out.bankDistance = 90
  out.bankBrightness = m.mistNight + (m.mistDay - m.mistNight) * Math.max(0, Math.min(1, sun))
  out.bankGlow = m.mistLamps
  out.bankLamp = m.mistBeams
  out.glowSpread = 4
  out.clouds = "today"
  out.blur = "today"
  out.reflection = lampFogOn ? base.reflection : 0
  out.glint = lampFogOn ? base.glint : 0
  return out
}
