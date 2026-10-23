import type { ForestWorld } from "../sim/forest-world"

export const LAKE_HORIZON_BINS = 64
/** Coarse canopy silhouette from actual tree heights, not invented shoreline objects.
 * Each azimuth stores the tallest apparent tree; shader distance is from the water point.
 */
export function lakeHorizon(world: ForestWorld): Float32Array<ArrayBuffer> {
  const data = new Float32Array(LAKE_HORIZON_BINS * 4)
  const lake = world.lake
  if (!lake) return data
  const slopes = new Float64Array(LAKE_HORIZON_BINS)
  for (const tree of world.trees) {
    const dx = tree.x - lake.x, dz = tree.z - lake.z, distance = Math.hypot(dx,dz)
    if (distance < 1) continue
    const height = Math.max(0, world.height(tree.x,tree.z) + tree.h - lake.level)
    const angle = Math.atan2(dz,dx), width = Math.atan2(tree.h * 0.16 + tree.r,distance)
    for (let i = 0; i < LAKE_HORIZON_BINS; i++) {
      const delta = Math.atan2(Math.sin(i*Math.PI*2/LAKE_HORIZON_BINS-angle),Math.cos(i*Math.PI*2/LAKE_HORIZON_BINS-angle))
      if (Math.abs(delta) > width + Math.PI/LAKE_HORIZON_BINS) continue
      if (height/distance <= slopes[i]!) continue
      slopes[i] = height/distance
      data.set([tree.x,tree.z,height,1],i*4)
    }
  }
  return data
}
