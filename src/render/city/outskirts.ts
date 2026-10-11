import { CELL, GRID, ROAD_HALF } from "../../../shared/config"
import { type Box, GROUND_FLOOR, STOREY } from "../../../shared/sim/city"
import { MAT, type Mesh, type Rgb } from "../mesh"
import { beam, cylinder, ground, shade, SKIP, slab } from "./kit"
import { container } from "./harbor"
import { streetLamp, tree } from "./props"
import { ASPHALT, CURB, SIDEWALK } from "./streets"
import type { LampLight } from "./types"

const CONCRETE: Rgb = [0.36, 0.36, 0.38]
const STEEL: Rgb = [0.17, 0.18, 0.22]
const RAIL: Rgb = [0.5, 0.5, 0.52]
const BALLAST: Rgb = [0.2, 0.19, 0.2]
const SLEEPER: Rgb = [0.18, 0.14, 0.12]
const ROCK: Rgb = [0.27, 0.27, 0.3]
const PALETTE: Rgb[] = [
  [0.44, 0.25, 0.2],
  [0.5, 0.31, 0.23],
  [0.4, 0.34, 0.28],
  [0.52, 0.48, 0.42],
  [0.34, 0.33, 0.36],
]

const EDGE = -ROAD_HALF
const MAX = GRID * CELL + ROAD_HALF

/**
 * Everything outside the playable walls: the elevated rail line to the west, the rail yard to the north-west,
 * filler blocks beyond the edges, and the rock cut with the tunnel to the east.
 */
export function outskirts(m: Mesh, rng: () => number, lamps: LampLight[], waterZ: number, addBuilding: (b: Box, touching: Box[]) => void) {
  // Perimeter road shoulders: a sidewalk strip and a low wall just outside the edge roads.
  ground(m, EDGE - 400, MAX + 400, EDGE - 400, waterZ, -0.02, [0.1, 0.11, 0.14])
  const tz = 2 * CELL
  for (const [x0, x1, z0, z1] of [
    [EDGE - 6, EDGE, EDGE - 6, waterZ],
    [MAX, MAX + 6, EDGE - 6, tz - 7],
    [MAX, MAX + 6, tz + 7, waterZ],
    [EDGE - 6, MAX + 6, EDGE - 6, EDGE],
  ] as const) {
    slab(m, x0, x1, 0, 0.16, z0, z1, CURB, MAT.lit, SKIP.bottom, SIDEWALK)
  }
  // Low retaining wall with a railing along the west and north edges.
  slab(m, EDGE - 6, EDGE - 5.4, 0, 1.1, EDGE - 6, waterZ, CONCRETE)
  slab(m, EDGE - 6, MAX + 6, 0, 1.1, EDGE - 6, EDGE - 5.4, CONCRETE)
  for (let z = EDGE + 10; z < waterZ - 5; z += 25) streetLamp(m, lamps, EDGE - 1.2, z + 12, EDGE - 3, z + 12)
  for (let x = EDGE + 10; x < MAX; x += 25) streetLamp(m, lamps, x, EDGE - 1.2, x, EDGE - 3)

  railViaduct(m, rng, lamps, -24, EDGE - 160, waterZ + 120)
  railYard(m, rng, lamps)
  tunnelCut(m, rng, lamps, waterZ)

  // Filler blocks beyond the west and north edges.
  const filler: Box[] = []
  const lot = (x0: number, x1: number, z0: number, z1: number) => {
    // Split a block into row buildings along its longer side.
    const alongX = x1 - x0 >= z1 - z0
    const len = alongX ? x1 - x0 : z1 - z0
    let t = 0
    while (t < len - 4) {
      const w = Math.min(len - t, 10 + rng() * 10)
      const floors = 2 + Math.floor(rng() * 4)
      const b: Box = {
        x0: alongX ? x0 + t : x0,
        x1: alongX ? x0 + t + w : x1,
        z0: alongX ? z0 : z0 + t,
        z1: alongX ? z1 : z0 + t + w,
        h: GROUND_FLOOR + floors * STOREY,
        color: PALETTE[Math.floor(rng() * PALETTE.length)]!,
        neon: null,
        kind: "building",
        label: null,
        floors,
      }
      filler.push(b)
      t += w
    }
  }
  // West of the viaduct, a service road under it.
  ground(m, -32, -15, EDGE - 6, waterZ, 0.0, ASPHALT)
  for (let z = EDGE - 4; z < waterZ - 20; z += 48) {
    ground(m, -150, -32, z + 36, z + 48, 0.0, ASPHALT)
    lot(-90, -35, z + 2, z + 18)
    lot(-90, -35, z + 18, z + 34)
    lot(-140, -95, z + 2, z + 34)
  }
  // North, east of the rail yard.
  for (let x = 152; x < MAX + 120; x += 52) {
    ground(m, x + 40, x + 52, -170, -14, 0.0, ASPHALT)
    lot(x + 2, x + 38, -38, -17)
    lot(x + 2, x + 38, -64, -38)
    lot(x + 2, x + 38, -112, -80)
  }
  ground(m, 150, MAX + 140, -78, -66, 0.0, ASPHALT)
  for (const b of filler) {
    const touching = filler.filter((o) => o !== b && o.x0 <= b.x1 + 0.3 && o.x1 >= b.x0 - 0.3 && o.z0 <= b.z1 + 0.3 && o.z1 >= b.z0 - 0.3)
    addBuilding(b, touching)
  }
}

/** Elevated rail line along z at x = cx: concrete piers, a steel girder deck, two tracks, railings and masts. */
function railViaduct(m: Mesh, rng: () => number, lamps: LampLight[], cx: number, z0: number, z1: number) {
  const deck = 8.5
  const hw = 4.6
  for (let z = z0; z < z1; z += 20) {
    slab(m, cx - 1.6, cx + 1.6, 0, 0.5, z - 1.6, z + 1.6, shade(CONCRETE, 0.85))
    slab(m, cx - 0.9, cx + 0.9, 0.5, deck - 1.6, z - 0.9, z + 0.9, CONCRETE)
    slab(m, cx - hw + 0.4, cx + hw - 0.4, deck - 1.6, deck - 1.1, z - 1.1, z + 1.1, shade(CONCRETE, 0.9))
  }
  // Girders (dark steel) with stiffener ribs facing the city.
  slab(m, cx - hw, cx + hw, deck - 1.1, deck, z0, z1, STEEL, MAT.lit, 0, BALLAST)
  for (let z = z0; z < z1; z += 2.5) {
    slab(m, cx + hw, cx + hw + 0.12, deck - 1.1, deck, z, z + 0.25, shade(STEEL, 1.25), MAT.lit, SKIP.bottom | SKIP.top)
    slab(m, cx - hw - 0.12, cx - hw, deck - 1.1, deck, z, z + 0.25, shade(STEEL, 1.25), MAT.lit, SKIP.bottom | SKIP.top)
  }
  // Tracks.
  for (const tx of [cx - 1.9, cx + 1.9]) {
    ground(m, tx - 1.5, tx + 1.5, z0, z1, deck + 0.02, shade(BALLAST, 1.2))
    for (let z = z0; z < z1; z += 0.8) ground(m, tx - 1.2, tx + 1.2, z, z + 0.28, deck + 0.06, SLEEPER)
    for (const s of [-0.72, 0.72]) slab(m, tx + s - 0.05, tx + s + 0.05, deck + 0.06, deck + 0.2, z0, z1, RAIL, MAT.lit, SKIP.bottom | SKIP.nz | SKIP.pz)
  }
  // Railings and catenary masts.
  for (const s of [-1, 1]) {
    const x = cx + s * (hw - 0.1)
    slab(m, x - 0.05, x + 0.05, deck + 1.0, deck + 1.1, z0, z1, STEEL, MAT.lit, SKIP.bottom | SKIP.nz | SKIP.pz)
    for (let z = z0; z < z1; z += 2) slab(m, x - 0.04, x + 0.04, deck, deck + 1.05, z, z + 0.08, STEEL, MAT.lit, SKIP.bottom | SKIP.top)
  }
  for (let z = z0 + 5; z < z1; z += 40) {
    cylinder(m, cx + hw - 0.4, z, 0.14, deck, deck + 6, 6, STEEL)
    beam(m, [cx + hw - 0.4, deck + 5.6, z], [cx - 2.6, deck + 5.6, z], 0.12, STEEL)
    m.box(cx + hw - 0.6, cx + hw - 0.2, deck + 1.5, deck + 1.9, z - 0.2, z + 0.2, rng() < 0.5 ? [1, 0.15, 0.1] : [0.3, 1, 0.5], MAT.emissive)
  }
  for (const tx of [cx - 1.9, cx + 1.9]) slab(m, tx - 0.02, tx + 0.02, deck + 5.5, deck + 5.55, z0, z1, [0.1, 0.1, 0.1], MAT.lit, SKIP.bottom)
  // A commuter train parked over the north end, windows lit.
  const tz0 = z0 + 70
  for (let k = 0; k < 4; k++) {
    const a = tz0 + k * 17
    const tx = cx - 1.9
    slab(m, tx - 1.45, tx + 1.45, deck + 0.4, deck + 3.8, a, a + 16, [0.62, 0.63, 0.66], MAT.lit, SKIP.bottom, [0.45, 0.46, 0.5])
    slab(m, tx - 1.47, tx + 1.47, deck + 1.1, deck + 1.35, a, a + 16, [0.6, 0.15, 0.12], MAT.lit, SKIP.bottom | SKIP.top)
    for (let w = a + 1; w < a + 15; w += 2.2) m.quad([tx + 1.46, deck + 1.8, w + 1.4], [tx + 1.46, deck + 1.8, w], [tx + 1.46, deck + 3.1, w], [tx + 1.46, deck + 3.1, w + 1.4], [1, 0, 0], [0.95, 0.85, 0.6], MAT.emissive)
  }
  lamps.push({ x: cx + 3, y: deck + 2.5, z: tz0 + 30, small: true })
}

/** Ground-level sidings north-west of the corner with freight on them and floodlight masts. */
function railYard(m: Mesh, rng: () => number, lamps: LampLight[]) {
  const z0 = EDGE - 60
  const z1 = EDGE - 10
  const x0 = -60
  const x1 = 150
  ground(m, x0, x1, z0, z1, 0.0, shade(BALLAST, 1.1))
  for (let z = z0 + 4; z < z1 - 3; z += 5) {
    for (let x = x0; x < x1; x += 0.9) ground(m, x, x + 0.3, z - 1.1, z + 1.1, 0.03, SLEEPER)
    for (const s of [-0.72, 0.72]) slab(m, x0, x1, 0.03, 0.17, z + s - 0.05, z + s + 0.05, RAIL, MAT.lit, SKIP.bottom | SKIP.nx | SKIP.px)
    // Freight: flatcars with containers, or boxcars.
    for (let x = x0 + 5 + rng() * 10; x < x1 - 16; x += 15 + rng() * 14) {
      if (rng() < 0.4) continue
      slab(m, x, x + 13, 0.5, 1.2, z - 1.3, z + 1.3, [0.18, 0.18, 0.2])
      container(m, { x0: x + 0.4, x1: x + 12.6, z0: z - 1.22, z1: z + 1.22, h: 2.6 * (rng() < 0.3 ? 2 : 1), color: [[0.55, 0.17, 0.14], [0.2, 0.34, 0.55], [0.68, 0.38, 0.14], [0.42, 0.44, 0.46]][Math.floor(rng() * 4)] as Rgb, neon: null, kind: "building", label: null }, 1.2)
    }
  }
  for (const x of [x0 + 30, x0 + 110, x0 + 190]) {
    cylinder(m, x, z0 + 2, 0.3, 0, 18, 6, STEEL)
    slab(m, x - 1.4, x + 1.4, 18, 18.6, z0 + 1.5, z0 + 2.5, STEEL)
    for (const s of [-0.9, 0, 0.9]) m.box(x + s - 0.3, x + s + 0.3, 17.6, 18, z0 + 2.4, z0 + 2.7, [1, 0.9, 0.7], MAT.emissive)
    lamps.push({ x, y: 16, z: z0 + 6 })
  }
}

/** East edge: a faceted rock cut with trees on top and a lit tunnel portal where the road leaves town. */
function tunnelCut(m: Mesh, rng: () => number, lamps: LampLight[], waterZ: number) {
  const x0 = MAX + 6
  const tz = 2 * CELL
  const cols = 10
  const rows = Math.ceil((waterZ + 40 - (EDGE - 120)) / 12)
  const hgt: number[][] = []
  for (let i = 0; i <= cols; i++) {
    hgt.push([])
    for (let j = 0; j <= rows; j++) hgt[i]!.push(i === 0 ? 0 : Math.min(26, 4 + i * 4 + rng() * 6))
  }
  const P = (i: number, j: number) => [x0 + i * 9 + (i > 0 ? (rng() - 0.5) * 2 : 0), hgt[i]![j]!, EDGE - 120 + j * 12]
  const pts: number[][][] = []
  for (let i = 0; i <= cols; i++) {
    pts.push([])
    for (let j = 0; j <= rows; j++) pts[i]!.push(P(i, j))
  }
  for (let i = 0; i < cols; i++)
    for (let j = 0; j < rows; j++) {
      const a = pts[i]![j]!, b = pts[i + 1]![j]!, c = pts[i + 1]![j + 1]!, d = pts[i]![j + 1]!
      // Leave the tunnel mouth open.
      const zc = (a[2]! + c[2]!) / 2
      if (i === 0 && Math.abs(zc - tz) < 10) continue
      const k = 0.85 + rng() * 0.3
      const col = i > 3 ? shade([0.16, 0.24, 0.16], k) : shade(ROCK, k)
      m.facet(a, d, c, col)
      m.facet(a, c, b, shade(col, 0.95))
      if (i > 3 && rng() < 0.35) tree(m, rng, (a[0]! + c[0]!) / 2, zc, 1 + rng() * 0.4, (a[1]! + c[1]!) / 2)
    }
  // Portal: concrete headwall with the bore.
  const px = x0 + 0.5
  slab(m, px, px + 3, 0, 14, tz - 16, tz - 7, CONCRETE)
  slab(m, px, px + 3, 0, 14, tz + 7, tz + 16, CONCRETE)
  slab(m, px, px + 3, 7.5, 14, tz - 7, tz + 7, CONCRETE)
  slab(m, px - 0.3, px + 3.3, 14, 14.6, tz - 16.3, tz + 16.3, shade(CONCRETE, 1.15))
  ground(m, MAX - 1, px + 40, tz - 7, tz + 7, 0.0, ASPHALT)
  // Dark bore with a row of sodium lights receding inside.
  m.quad([px + 40, 0, tz + 7], [px + 40, 0, tz - 7], [px + 40, 7.5, tz - 7], [px + 40, 7.5, tz + 7], [-1, 0, 0], [0.02, 0.02, 0.03])
  for (const s of [-1, 1]) {
    const z = tz + s * 7
    m.quad(s < 0 ? [px + 3, 0, z] : [px + 40, 0, z], s < 0 ? [px + 40, 0, z] : [px + 3, 0, z], s < 0 ? [px + 40, 7.5, z] : [px + 3, 7.5, z], s < 0 ? [px + 3, 7.5, z] : [px + 40, 7.5, z], [0, 0, -s], [0.25, 0.24, 0.24])
  }
  m.quad([px + 3, 7.5, tz - 7], [px + 3, 7.5, tz + 7], [px + 40, 7.5, tz + 7], [px + 40, 7.5, tz - 7], [0, -1, 0], [0.15, 0.15, 0.16])
  for (let x = px + 5; x < px + 40; x += 5) m.box(x, x + 1.4, 7.1, 7.4, tz - 0.3, tz + 0.3, [1, 0.62, 0.25], MAT.emissive)
  lamps.push({ x: px + 6, y: 6, z: tz })
  // Chevron sign over the mouth.
  slab(m, px - 0.2, px, 8.2, 9.6, tz - 4, tz + 4, [0.15, 0.15, 0.17])
  m.decal([px - 0.22, 8.3, tz + 3.8], [px - 0.22, 8.3, tz - 3.8], [px - 0.22, 9.5, tz - 3.8], [px - 0.22, 9.5, tz + 3.8], [-1, 0, 0], "hazardYellow", [1, 1, 1], MAT.neon)
}
