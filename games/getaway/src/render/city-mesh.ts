import type { Box, City } from "../../shared/sim/city"
import { mulberry32 } from "../../shared/sim/rng"
import type { AtlasRegion } from "./atlas"
import { BigMesh } from "./city/big-mesh"
import { building, type BuildingCtx } from "./city/building"
import { container, crane, waterfront } from "./city/harbor"
import { FLOATS_PER_VERT, MAT, type Mesh } from "./mesh"
import { outskirts } from "./city/outskirts"
import { parks } from "./city/parks"
import { cornerBeds, streetFurniture, trees, yards } from "./city/props"
import { shop } from "./city/shop"
import { streets } from "./city/streets"
import { ramps } from "./city/ramps"
import type { LampLight, ShopSpill } from "./city/types"

export type { LampLight }

export type CityChunk = {
  first: number
  count: number
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

/** Partitions the static city mesh into ~64m x 64m spatial AABB chunks packed in one contiguous buffer. */
export function partitionCityMesh(mesh: Mesh, cellSize = 64): { data: Float32Array<ArrayBuffer>; chunks: CityChunk[]; count: number } {
  const src = mesh.toArray()
  const triFloats = FLOATS_PER_VERT * 3
  const numTris = Math.floor(src.length / triFloats)
  const buckets = new Map<
    number,
    {
      tris: number[]
      minX: number
      minY: number
      minZ: number
      maxX: number
      maxY: number
      maxZ: number
    }
  >()
  const LARGE_KEY = 0x7fffffff

  for (let t = 0; t < numTris; t++) {
    const o = t * triFloats
    const x0 = src[o]!,
      y0 = src[o + 1]!,
      z0 = src[o + 2]!
    const x1 = src[o + 12]!,
      y1 = src[o + 13]!,
      z1 = src[o + 14]!
    const x2 = src[o + 24]!,
      y2 = src[o + 25]!,
      z2 = src[o + 26]!
    const tx0 = Math.min(x0, x1, x2),
      tx1 = Math.max(x0, x1, x2)
    const ty0 = Math.min(y0, y1, y2),
      ty1 = Math.max(y0, y1, y2)
    const tz0 = Math.min(z0, z1, z2),
      tz1 = Math.max(z0, z1, z2)
    const isLarge = tx1 - tx0 > cellSize * 2 || tz1 - tz0 > cellSize * 2
    const cx = Math.floor((x0 + x1 + x2) / (3 * cellSize)) + 64
    const cz = Math.floor((z0 + z1 + z2) / (3 * cellSize)) + 64
    const key = isLarge ? LARGE_KEY : (cx << 8) | (cz & 0xff)
    let b = buckets.get(key)
    if (!b) {
      b = { tris: [], minX: tx0, minY: ty0, minZ: tz0, maxX: tx1, maxY: ty1, maxZ: tz1 }
      buckets.set(key, b)
    } else {
      if (tx0 < b.minX) b.minX = tx0
      if (ty0 < b.minY) b.minY = ty0
      if (tz0 < b.minZ) b.minZ = tz0
      if (tx1 > b.maxX) b.maxX = tx1
      if (ty1 > b.maxY) b.maxY = ty1
      if (tz1 > b.maxZ) b.maxZ = tz1
    }
    b.tris.push(t)
  }

  const data = new Float32Array(src.length)
  const chunks: CityChunk[] = []
  let writeFloat = 0
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b)
  for (const key of sortedKeys) {
    const b = buckets.get(key)!
    const first = writeFloat / FLOATS_PER_VERT
    for (let i = 0; i < b.tris.length; i++) {
      const srcOff = b.tris[i]! * triFloats
      for (let k = 0; k < triFloats; k++) {
        data[writeFloat + k] = src[srcOff + k]!
      }
      writeFloat += triFloats
    }
    chunks.push({
      first,
      count: b.tris.length * 3,
      minX: b.minX,
      minY: b.minY,
      minZ: b.minZ,
      maxX: b.maxX,
      maxY: b.maxY,
      maxZ: b.maxZ,
    })
  }
  return { data, chunks, count: numTris * 3 }
}

/** Spots that always get the mockup's signature art, near the staged chase intersection at (228, 152). */
const HOTEL_AT = [
  [253, 190],
  [400, 330],
  [90, 420],
] as const
const BILLBOARD_AT = [
  [252, 172, "billboardA"],
  [130, 260, "billboardB"],
  [360, 440, "billboardA"],
  [470, 100, "billboardB"],
] as const
const LETTERING_AT = [
  [206, 178],
  [330, 300],
] as const

/** Builds the whole static district in one vertex buffer: ground, roads, buildings, props. */
export function buildCityMesh(city: City): { mesh: Mesh; lamps: LampLight[]; spills: ShopSpill[] } {
  const m = new BigMesh()
  const rng = mulberry32(city.seed * 7 + 3)
  const lamps: LampLight[] = []

  streets(m, city, rng)
  ramps(m, city.ramps)
  yards(m, city)
  parks(m, city, rng, lamps)

  const spills: ShopSpill[] = []
  const buildings = city.boxes.filter((b) => b.kind === "building" && !b.use)
  const nearest = (x: number, z: number, ok: (b: Box) => boolean) => {
    let best: Box | null = null
    let bd = Infinity
    for (const b of buildings) {
      if (!ok(b)) continue
      const d = Math.hypot((b.x0 + b.x1) / 2 - x, (b.z0 + b.z1) / 2 - z)
      if (d < bd) {
        bd = d
        best = b
      }
    }
    return best
  }
  const blades = new Map<Box, AtlasRegion>()
  const boards = new Map<Box, AtlasRegion>()
  const letters = new Set<Box>()
  for (const [x, z] of HOTEL_AT) {
    const b = nearest(x, z, (b) => !b.label && (b.floors ?? 0) >= 2)
    if (b) blades.set(b, "hotel")
  }
  for (const b of buildings) if (b.neon && !b.label && !blades.has(b) && rng() < 0.4) blades.set(b, rng() < 0.5 ? "bar" : "motel")
  for (const [x, z, region] of BILLBOARD_AT) {
    const b = nearest(x, z, (b) => !b.label && !blades.has(b) && (b.floors ?? 0) >= 2)
    if (b) boards.set(b, region)
  }
  for (const [x, z] of LETTERING_AT) {
    const b = nearest(x, z, (b) => !b.label && !boards.has(b) && !blades.has(b) && (b.floors ?? 0) >= 2)
    if (b) letters.add(b)
  }

  const touchingOf = (b: Box, pool: Box[]) => pool.filter((o) => o !== b && touches(o, b))
  const draw = (b: Box, touching: Box[]) => {
    const ctx: BuildingCtx = { m, rng, lamps, spills, touching, sidewalk: city.sidewalk, blade: blades.get(b) ?? null, billboard: boards.get(b) ?? null, lettering: letters.has(b) }
    building(ctx, b)
  }
  for (const b of buildings) draw(b, touchingOf(b, buildings))

  for (const s of city.shops) shop(m, s, lamps)
  for (const b of city.boxes) if (b.use === "container") container(m, b)
  crane(m, city.boxes.filter((b) => b.use === "crane"), lamps, city.waterZ)

  trees(m, rng, city)
  cornerBeds(m, rng, city)
  streetFurniture(m, rng, city, lamps)
  helipad(m, city)
  waterfront(m, city, rng, lamps)
  outskirts(m, rng, lamps, city.waterZ, draw)
  return { mesh: m, lamps, spills }
}

function touches(a: Box, b: Box) {
  return a.x0 <= b.x1 + 0.3 && a.x1 >= b.x0 - 0.3 && a.z0 <= b.z1 + 0.3 && a.z1 >= b.z0 - 0.3
}

/** Helipad on the precinct roof: concrete deck, yellow ring, the H and edge lights. */
function helipad(m: Mesh, city: City) {
  const hp = city.helipad
  m.prism(hp.x, hp.z, 8, 8, hp.y - 0.5, hp.y, 12, [0.24, 0.26, 0.3])
  m.prism(hp.x, hp.z, 7.4, 7.4, hp.y, hp.y + 0.02, 12, [0.95, 0.75, 0.2], MAT.flat)
  m.prism(hp.x, hp.z, 6.8, 6.8, hp.y + 0.02, hp.y + 0.04, 12, [0.24, 0.26, 0.3])
  m.box(hp.x - 2.4, hp.x - 1.6, hp.y + 0.04, hp.y + 0.06, hp.z - 3, hp.z + 3, [0.95, 0.95, 0.95], MAT.flat)
  m.box(hp.x + 1.6, hp.x + 2.4, hp.y + 0.04, hp.y + 0.06, hp.z - 3, hp.z + 3, [0.95, 0.95, 0.95], MAT.flat)
  m.box(hp.x - 1.6, hp.x + 1.6, hp.y + 0.04, hp.y + 0.06, hp.z - 0.4, hp.z + 0.4, [0.95, 0.95, 0.95], MAT.flat)
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2
    const x = hp.x + Math.cos(a) * 7.8
    const z = hp.z + Math.sin(a) * 7.8
    m.box(x - 0.15, x + 0.15, hp.y, hp.y + 0.2, z - 0.15, z + 0.15, k % 2 ? [0.3, 1, 0.45] : [0.4, 0.6, 1], MAT.emissive)
  }
}
