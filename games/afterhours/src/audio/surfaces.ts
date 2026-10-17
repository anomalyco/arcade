import { ACCESS_ROAD, BOOTH, BUILDING, CORE, COUNTY_ROAD, FENCE, FIRE_ESCAPE, FREIGHT, PARKING_LOT, ROOF_Y, accessRoadSamples, countyRoadZ } from "../world/layout"

// What the walker is standing on, for footsteps. A floor's own `surface` tag (`Floor.surface` in world/context.ts)
// wins; otherwise this derives a default from where the feet are. Owners refine by tagging floors with one of these:

export type Surface =
  | "concrete"
  | "linoleum"
  | "tile"
  | "carpet"
  | "raised" // computer-room access floor: hollow panels on pedestals
  | "wood"
  | "metal" // chequer plate (lift cars, dock plates)
  | "grating" // open steel grating (fire escape)
  | "gravel"
  | "asphalt"
  | "grass"
  | "forest" // pine needles, earth, twigs
  | "ladder"

export const SURFACES: readonly Surface[] = ["concrete", "linoleum", "tile", "carpet", "raised", "wood", "metal", "grating", "gravel", "asphalt", "grass", "forest", "ladder"]

const road = accessRoadSamples(2)
const within = (x: number, z: number, r: { min: readonly [number, number]; max: readonly [number, number] }, pad = 0) =>
  x >= r.min[0] - pad && x <= r.max[0] + pad && z >= r.min[1] - pad && z <= r.max[1] + pad

function roadDistance(x: number, z: number) {
  let best = Math.abs(z - countyRoadZ(x)) - COUNTY_ROAD.width / 2
  const half = ACCESS_ROAD.width / 2
  for (let i = 1; i < road.length; i++) {
    const [ax, az] = road[i - 1]!
    const [bx, bz] = road[i]!
    if (Math.abs(x - ax) > 12 && Math.abs(x - bx) > 12) continue
    const dx = bx - ax
    const dz = bz - az
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)))
    best = Math.min(best, Math.hypot(x - ax - dx * t, z - az - dz * t) - half)
  }
  return best
}

/** Interior finish by storey (0 ground … 4), per the building program. */
const STOREY: Surface[] = ["linoleum", "carpet", "linoleum", "raised", "concrete"]

/**
 * Surface at the feet. `tag` is the step event's surface ("ground" on terrain, "ladder", "floor" for an untagged floor,
 * or an owner's tag, which is returned as is).
 */
export function surfaceAt(tag: string, x: number, y: number, z: number): Surface {
  if (tag === "ladder") return "ladder"
  if (tag !== "floor" && tag !== "ground") return tag as Surface
  const M = BUILDING.main
  if (tag === "ground") {
    if (within(x, z, PARKING_LOT)) return "asphalt"
    const d = roadDistance(x, z)
    if (d < 0) return "asphalt"
    if (d < Math.max(ACCESS_ROAD.shoulder, COUNTY_ROAD.shoulder) + 0.8) return "gravel"
    const inFence = x > FENCE.min[0] && x < FENCE.max[0] && z > FENCE.min[1] && z < FENCE.max[1]
    return inFence ? "grass" : "forest"
  }
  // An untagged floor.
  if (x < M.min[0] && x > FIRE_ESCAPE.x - FIRE_ESCAPE.depth - 0.6 && z > FIRE_ESCAPE.z0 - 1.5 && z < FIRE_ESCAPE.z1 + 1.5) return "grating"
  if (within(x, z, { min: [BOOTH.x - BOOTH.w / 2, BOOTH.z - BOOTH.d / 2], max: [BOOTH.x + BOOTH.w / 2, BOOTH.z + BOOTH.d / 2] }, 0.2)) return "linoleum"
  if (within(x, z, CORE.lift) || within(x, z, FREIGHT.car)) return "metal"
  const inMain = within(x, z, M)
  const inAnnex = within(x, z, BUILDING.annex)
  if (inMain || inAnnex) {
    if (y >= (inMain ? ROOF_Y : BUILDING.annex.height) - 0.3) return "gravel"
    if (within(x, z, CORE.stair)) return "concrete"
    if (y < BUILDING.floorY - 1) return "concrete"
    if (inAnnex) return "linoleum"
    const storey = Math.max(0, Math.min(STOREY.length - 1, Math.round((y - BUILDING.floorY) / M.storeyHeight)))
    return STOREY[storey]!
  }
  if (within(x, z, PARKING_LOT)) return "asphalt"
  return "concrete"
}
