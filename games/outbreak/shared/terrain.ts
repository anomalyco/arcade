import type { Rect } from "@arcade/kit/sim/geom"
import { buildingFootprint, frontageEnd, inBuildingFootprint, SIZE, type Building, type Door, type Town } from "./map"

const clamp = (x: number) => Math.max(0, Math.min(1, x))
const smooth = (x: number) => { x = clamp(x); return x * x * (3 - 2 * x) }
const distance = (x: number, z: number, a: number, b: number, c: number, d: number) => Math.hypot(Math.max(a-x, 0, x-c), Math.max(b-z, 0, z-d))
const foldMacro = (v: number) => (v >= 0 && v <= SIZE ? v : ((v % SIZE) + SIZE) % SIZE)

const inStreetBand = (v: number) => { const l = foldMacro(v); return l > 37.8 && l < 50.2 }

/** How far south of (x, z) the street (with its sidewalk) begins, up to 9 m; 2 when it is further. */
export function toStreet(x: number, z: number): number {
  for (let d = 0; d < 9; d += 0.25) if (inStreetBand(x) || inStreetBand(z + d)) return d
  return 2
}

const flatsCache = new WeakMap<Door[], Map<Building, Rect[]>>()

/**
 * A styled home's front paths (one per front door) and its driveway, out to the street. Kept level like Today's front
 * walk and drive: on the rolling lawn their pads sank under the grass in patches.
 */
export function styledFlats(town: Town, b: Building): readonly Rect[] {
  if (!b.style) return []
  let byBuilding = flatsCache.get(town.doors)
  if (!byBuilding) flatsCache.set(town.doors, (byBuilding = new Map()))
  let out = byBuilding.get(b)
  if (out) return out
  out = []
  for (const d of town.doors) {
    if (!d.id.startsWith(`${b.id}-front`)) continue
    const cx = (d.rect[0] + d.rect[2]) / 2
    out.push([cx - 0.6, d.rect[3], cx + 0.6, d.rect[3] + toStreet(cx, d.rect[3])])
  }
  out.push([b.rect[0] - 3.2, b.rect[1] - 0.5, b.rect[0] - 0.2, b.rect[3] + toStreet(b.rect[0] - 1.7, b.rect[3])])
  byBuilding.set(b, out)
  return out
}

/** Heights at integer terrain vertices. Roads, foundations and entrance walks remain flat. */
export function terrainVertex(town: Town, x: number, z: number): number {
  const lx = town.activeChunkKeys ? foldMacro(x) : x
  const lz = town.activeChunkKeys ? foldMacro(z) : z
  let free = Math.min(distance(lx,lz,38,0,50,96), distance(lx,lz,0,38,96,50))
  for (const b of town.buildings) {
    if (x < b.rect[0] - 6 || x > b.rect[2] + 3 || z < b.rect[1] - 3 || z > b.rect[3] + (b.style ? 11.5 : 7.5)) continue
    free = Math.min(free, distance(x,z,...b.rect), distance(x,z,b.rect[0]+4.5,b.rect[3],b.rect[0]+7,frontageEnd(b)+2),distance(x,z,b.rect[0]-3,b.rect[1],b.rect[0]-.35,frontageEnd(b)+2))
    // Half a metre either side, so the 1 m terrain cells never lift a pad's edge into the grass.
    if (b.style) for (const f of styledFlats(town, b)) free = Math.min(free, distance(x,z,f[0]-.5,f[1],f[2]+.5,f[3]+.5))
  }
  const s = town.seed * .37
  return smooth(free / 2) * town.terrain * (.55 + .25 * Math.sin(x*.41+s)*Math.cos(z*.32-s) + .2*Math.sin(x*.17-z*.23+s))
}

/** Exact barycentric interpolation of the two triangles emitted for each metre cell. */
export function groundHeight(town: Town, x: number, z: number): number {
  const ix=Math.floor(x), iz=Math.floor(z), u=x-ix, v=z-iz
  const a=terrainVertex(town,ix,iz), b=terrainVertex(town,ix+1,iz), c=terrainVertex(town,ix+1,iz+1), d=terrainVertex(town,ix,iz+1)
  return v <= u ? a+(b-a)*u+(c-b)*v : a+(c-d)*u+(d-a)*v
}

/** Rendered walking surfaces, including the shallow curb ramp and the level thresholds. */
export function supportHeight(town: Town, x: number, z: number): number {
  for (const b of town.buildings) {
    const [a,c,r,e]=b.rect
    if (x < a - 3.5 || x > r + 0.5 || z < c - 0.5 || z > e + 5.0) continue
    if (inBuildingFootprint(b, x, z)) return .13
    if (x>=a+5 && x<=a+6.4 && z>=e && z<=frontageEnd(b)+2) return .13
    if (x>=a+4.5 && x<=a+7 && z>=e && z<=e+1.3) return .13
  }
  const lx = town.activeChunkKeys ? foldMacro(x) : x
  const lz = town.activeChunkKeys ? foldMacro(z) : z
  if ((lx>=40 && lx<=48) || (lz>=40 && lz<=48)) return .014
  let height=groundHeight(town,x,z)
  for (const b of town.buildings) {
    const [a,c,,e]=b.rect
    if (x>=a-3 && x<=a-.35 && z>=c && z<=frontageEnd(b)+2) height=Math.max(.035,height)
    if (b.style && x >= a - 3.5 && x <= b.rect[2] && z >= c - 0.5 && z <= e + 9) for (const f of styledFlats(town, b)) if (x >= f[0] && x <= f[2] && z >= f[1] && z <= f[3]) height = Math.max(.035, height)
  }
  const curb = (v: number) => v>=38 && v<=40 ? .014+.086 * Math.min(1,(40-v)/.25) : v>=48 && v<=50 ? .014+.086 * Math.min(1,(v-48)/.25) : 0
  if ((lx>=38 && lx<=50) || (lz>=38 && lz<=50)) return Math.max(height,.014,curb(lx),curb(lz))
  return height
}
