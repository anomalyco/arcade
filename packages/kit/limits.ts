/** Polar-light capacities shared by game simulations (vision rays, light budgets) and the renderer's CPU writers and WGSL. */
export const MAX_LIGHTS = 64
export const MAX_OCCLUDERS = 16384
export const MAX_MAP_LIGHTS = 2048
export const POLAR_RAYS = 1024
export const LIGHT_FLOATS = 16
/**
 * `cone.w` of a capsule light: lit from the nearest point of the segment `pos ± cone.xyz` (the scene's `lightSum`), with
 * `pos.w` the reach from the centre (radius plus the segment's plan half-length). Lies in the porch-light range
 * (`cone.w < -0.5`), so hosts that keep those out of rooms treat capsules the same.
 */
export const LIGHT_CAPSULE = -1.75
export const OCC_FLOATS = 8
