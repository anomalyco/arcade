/** How far the eye may be from a chunk's box (m) for its full baked geometry; past it the chunk draws its far mesh. */
export const STATIC_NEAR = 70

/** Horizontal distance from (x, z) to a (x0, y0, z0, x1, y1, z1) box, 0 inside its footprint. */
export function boxDistanceXZ(b: readonly number[], x: number, z: number) {
  return Math.hypot(Math.max(b[0]! - x, x - b[3]!, 0), Math.max(b[2]! - z, z - b[5]!, 0))
}

/** Whether the eye at (x, z) draws a chunk's full baked geometry (`near`) rather than its far mesh. */
export const nearStatic = (bakedBox: readonly number[], x: number, z: number) => boxDistanceXZ(bakedBox, x, z) < STATIC_NEAR

/** Whether a (x0, y0, z0, x1, y1, z1) box reaches inside the frustum's planes (`frustumPlanes`). */
export function boxInFrustum(planes: number[][], b: readonly number[]): boolean {
  for (const p of planes) {
    const x = p[0]! >= 0 ? b[3]! : b[0]!, y = p[1]! >= 0 ? b[4]! : b[1]!, z = p[2]! >= 0 ? b[5]! : b[2]!
    if (p[0]! * x + p[1]! * y + p[2]! * z + p[3]! < 0) return false
  }
  return true
}
