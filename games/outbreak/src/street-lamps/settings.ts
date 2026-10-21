import type { LabControl } from "@arcade/kit/lab-panel"

/**
 * Street lamps as the Lot's lens emitters (`@arcade/kit/gpu/lights/street`, #364/#368), through Outbreak's own lamp
 * grid and polar shadows (Lab › Look · Street lamps, `streetLampStyle` 0 is Today). A cobra head throws the pool it is
 * designed to light: an even ellipse along the road, out past a mounting height on the street side, short on the house
 * side (the photometric web I = E / cos³θ), light leaving the whole lens (1 / (d² + b²): no hot spot under the head),
 * polar shadows softened by the lens size, and the air under the lens lit from the lens, not a dot.
 */
export type OutbreakStreetLampSettings = {
  /** 0 Today (round point lamp, unshadowed), 1 lens emitter + street photometry. */
  streetLampStyle: number
  /** Half-maximum reach of the pool along the road, in mounting heights. */
  slAlong: number
  /** Half-maximum reach towards the road (the arm side), in mounting heights. */
  slStreet: number
  /** Half-maximum reach behind the pole (house side), in mounting heights. */
  slHouse: number
  /** Refractor cutoff, degrees from nadir. */
  slCutoff: number
  /** Light the bowl throws sideways (sag lens), share of nadir. */
  slGlow: number
  /** Light on the ground as a multiple of Today's lamp (the same flux, spread over the designed pool). */
  slFlux: number
  /** Light radius, in mounting heights (where the pool is windowed to zero). */
  slReach: number
  /** Lens half-length along the arm, metres. */
  slLensA: number
  /** Lens half-width across the arm, metres (the soft core of the falloff). */
  slLensB: number
  /** Shadow penumbra, × the lens width. */
  slSoftness: number
  /** Air lit under the lens, × Today's sodium cone. */
  slAir: number
}

export const DEFAULT_STREET_LAMP_SETTINGS: OutbreakStreetLampSettings = {
  streetLampStyle: 0,
  slAlong: 1.2,
  slStreet: 1.1,
  slHouse: 0.6,
  slCutoff: 62,
  slGlow: 0.02,
  slFlux: 1.25,
  slReach: 2.4,
  slLensA: 0.22,
  slLensB: 0.13,
  slSoftness: 1,
  slAir: 1,
}

const G = "Look · Street lamps"

export const streetLampControls: readonly LabControl[] = [
  {
    key: "streetLampStyle",
    label: "Street lamps",
    group: G,
    type: "select",
    options: [
      { value: 0, label: "Today (round point lamp)" },
      { value: 1, label: "Lens emitter + street photometry" },
    ],
  },
  { key: "slAlong", label: "Pool reach along road", group: G, subsection: "Photometry", min: 0.5, max: 4, step: 0.05, unit: "MH" },
  { key: "slStreet", label: "Pool reach street side", group: G, subsection: "Photometry", min: 0.3, max: 4, step: 0.05, unit: "MH" },
  { key: "slHouse", label: "Pool reach house side", group: G, subsection: "Photometry", min: 0.1, max: 3, step: 0.05, unit: "MH" },
  { key: "slCutoff", label: "Refractor cutoff", group: G, subsection: "Photometry", min: 50, max: 88, step: 0.5, unit: "°" },
  { key: "slGlow", label: "Side glow (sag lens)", group: G, subsection: "Photometry", min: 0, max: 0.3, step: 0.005, unit: "×" },
  { key: "slFlux", label: "Light vs Today's lamp", group: G, subsection: "Photometry", min: 0.2, max: 3, step: 0.05, unit: "×" },
  { key: "slReach", label: "Light radius", group: G, subsection: "Photometry", min: 1.2, max: 4, step: 0.05, unit: "MH" },
  { key: "slLensA", label: "Lens half-length", group: G, subsection: "Emitter", min: 0.05, max: 0.5, step: 0.01, unit: "m" },
  { key: "slLensB", label: "Lens half-width", group: G, subsection: "Emitter", min: 0.03, max: 0.45, step: 0.01, unit: "m" },
  { key: "slSoftness", label: "Shadow softness (lens size)", group: G, subsection: "Emitter", min: 0, max: 4, step: 0.05, unit: "×" },
  { key: "slAir", label: "Air under the lens", group: G, subsection: "Emitter", min: 0, max: 3, step: 0.05, unit: "×" },
]

export const streetLensOn = (s: Pick<OutbreakStreetLampSettings, "streetLampStyle"> | undefined): boolean => (s?.streetLampStyle ?? 0) > 0.5

/** Floats `packStreetLampUniforms` writes: (along, street, house, cos cutoff), (on, glow, air, 0), nearest head (arm x, arm z, a, b). */
export const STREET_LAMP_UNIFORM_FLOATS = 12

export function packStreetLampUniforms(s: OutbreakStreetLampSettings | undefined, arm: readonly [number, number], out: Float32Array, offset: number): void {
  const v = s ?? DEFAULT_STREET_LAMP_SETTINGS
  const on = streetLensOn(v) ? 1 : 0
  out.set([v.slAlong, v.slStreet, v.slHouse, Math.cos((v.slCutoff * Math.PI) / 180)], offset)
  out.set([on, v.slGlow, v.slAir, 0], offset + 4)
  out.set([arm[0], arm[1], v.slLensA, v.slLensB], offset + 8)
}
