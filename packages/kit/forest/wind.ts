/** The forest's wind on the CPU: the direction the shader's `woodsWind` blows along and its travelling gust. */

/** Downwind direction in plan (x, z). */
export const FOREST_WIND_DIR = [0.88, 0.47] as const

/**
 * Wind strength at (x, z) and time `t` (s), as `woodsWind` scales its sway: the look's `wind` × a gust that travels
 * downwind across the stand (`gust` is the look's gust share), never under 15% of `wind`.
 */
export function forestWindAt(x: number, z: number, t: number, wind: number, gust: number): number {
  const [dx, dz] = FOREST_WIND_DIR
  const g = 1 + gust * (0.5 * Math.sin((x * dx + z * dz) * 0.045 - t * 0.55) + 0.35 * Math.sin((-x * dz + z * dx) * 0.031 + t * 0.23))
  return wind * Math.max(g, 0.15)
}

/**
 * How far `woodsWind` moves a trunk point (x, y, z) sideways: `share` is its height over the tree's height, `phase`
 * the instance's wind phase (`treePlacement`), `sway` the look's trunk sway. Writes plan (dx, dz) into `out`.
 */
export function forestTrunkSway(x: number, z: number, t: number, share: number, phase: number, look: { wind: number; gust: number; trunkSway: number }, out: [number, number]): [number, number] {
  const [dx, dz] = FOREST_WIND_DIR
  const ph = phase * Math.PI * 2
  const trunk = share * share * look.trunkSway * forestWindAt(x, z, t, look.wind, look.gust)
  const along = (0.16 + 0.12 * Math.sin(t * 0.9 + ph)) * trunk, across = Math.sin(t * 0.63 + ph * 1.3) * 0.08 * trunk
  out[0] = dx * along - dz * across
  out[1] = dz * along + dx * across
  return out
}
