import { WET_ASPHALT, WET_CONCRETE, WET_GRAVEL, type WetMaterial } from "@arcade/kit/gpu/reflections/wet"

/** Authored recipes, indexed by the ground vertex's aux value. The road and lot are different materials. */
export const EXTERIOR_WET: readonly (readonly [string, WetMaterial])[] = [
  ["asphalt_lot", WET_ASPHALT],
  ["asphalt", { porosity: 0.6, film: 0.13, puddles: 1 }],
  ["gravel", WET_GRAVEL],
  ["concrete_floor", WET_CONCRETE],
]
/** Terrain vertex colour holds grass/dirt weights rather than a pre-clamped colour multiplier. */
export const TERRAIN_MAT = 42
