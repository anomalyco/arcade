import type { Box, City } from "../../shared/sim/city"
import { mulberry32 } from "../../shared/sim/rng"
import type { AtlasRegion } from "./atlas"
import { BigMesh } from "./city/big-mesh"
import { building, type BuildingCtx } from "./city/building"
import { container, crane, waterfront } from "./city/harbor"
import { MAT, type Mesh } from "./mesh"
import { outskirts } from "./city/outskirts"
import { parks } from "./city/parks"
import { cornerBeds, streetFurniture, trees, yards } from "./city/props"
import { shop } from "./city/shop"
import { streets } from "./city/streets"
import type { LampLight } from "./city/types"

export type { LampLight }

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
export function buildCityMesh(city: City): { mesh: Mesh; lamps: LampLight[] } {
  const m = new BigMesh()
  const rng = mulberry32(city.seed * 7 + 3)
  const lamps: LampLight[] = []

  streets(m, city, rng)
  yards(m, city)
  parks(m, city, rng, lamps)

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
    const ctx: BuildingCtx = { m, rng, lamps, touching, sidewalk: city.sidewalk, blade: blades.get(b) ?? null, billboard: boards.get(b) ?? null, lettering: letters.has(b) }
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
  return { mesh: m, lamps }
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
