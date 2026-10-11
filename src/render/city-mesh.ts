import { CELL, GRID, ROAD_HALF } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import { mulberry32 } from "../../shared/sim/rng"
import { MAT, Mesh, type Rgb } from "./mesh"

const ASPHALT: Rgb = [0.13, 0.14, 0.17]
const SIDEWALK: Rgb = [0.3, 0.3, 0.32]
const CURB: Rgb = [0.4, 0.4, 0.41]
const GRASS: Rgb = [0.12, 0.2, 0.13]
const LINE: Rgb = [0.5, 0.5, 0.48]
const YELLOW: Rgb = [0.85, 0.66, 0.2]
const LEAF: Rgb[] = [
  [0.14, 0.27, 0.15],
  [0.18, 0.31, 0.16],
  [0.11, 0.22, 0.14],
]
const TRUNK: Rgb = [0.25, 0.17, 0.12]
const METAL: Rgb = [0.18, 0.19, 0.21]
const WARM: Rgb = [1.0, 0.72, 0.38]
const AWNINGS: Rgb[] = [
  [0.45, 0.1, 0.1],
  [0.12, 0.26, 0.2],
  [0.15, 0.18, 0.32],
  [0.42, 0.3, 0.12],
]

export type LampLight = { x: number; y: number; z: number; small?: boolean }

/** Builds the whole static district in one vertex buffer: ground, roads, buildings, props. */
export function buildCityMesh(city: City): { mesh: Mesh; lamps: LampLight[] } {
  const m = new Mesh()
  const rng = mulberry32(city.seed * 7 + 3)
  const max = city.max
  const lamps: LampLight[] = []

  // Base ground slab (sidewalk level) and the far surroundings.
  m.quad([-300, -0.02, -300], [-300, -0.02, city.waterZ], [max + 300, -0.02, city.waterZ], [max + 300, -0.02, -300], [0, 1, 0], [0.09, 0.1, 0.12])

  // Roads.
  const lo = -ROAD_HALF
  const hi = GRID * CELL + ROAD_HALF
  for (let k = 0; k <= GRID; k++) {
    const c = k * CELL
    m.quad([c - ROAD_HALF, 0, lo], [c - ROAD_HALF, 0, hi], [c + ROAD_HALF, 0, hi], [c + ROAD_HALF, 0, lo], [0, 1, 0], ASPHALT)
    m.quad([lo, 0.001, c - ROAD_HALF], [lo, 0.001, c + ROAD_HALF], [hi, 0.001, c + ROAD_HALF], [hi, 0.001, c - ROAD_HALF], [0, 1, 0], ASPHALT)
  }

  // Lane markings and crosswalks.
  for (let k = 0; k <= GRID; k++)
    for (let s = 0; s < GRID; s++) {
      const c = k * CELL
      const a = s * CELL + ROAD_HALF + 6
      const b = (s + 1) * CELL - ROAD_HALF - 6
      for (let t = a; t < b - 3; t += 8) {
        m.quad([c - 0.15, 0.02, t], [c - 0.15, 0.02, t + 3.5], [c + 0.15, 0.02, t + 3.5], [c + 0.15, 0.02, t], [0, 1, 0], YELLOW, MAT.flat)
        m.quad([t, 0.02, c - 0.15], [t, 0.02, c + 0.15], [t + 3.5, 0.02, c + 0.15], [t + 3.5, 0.02, c - 0.15], [0, 1, 0], YELLOW, MAT.flat)
      }
      // Crosswalk stripes at both ends of each road segment.
      for (const z0 of [s * CELL + ROAD_HALF + 0.8, (s + 1) * CELL - ROAD_HALF - 3.8]) {
        for (let x = c - ROAD_HALF + 1; x < c + ROAD_HALF - 0.9; x += 1.6) {
          m.quad([x, 0.02, z0], [x, 0.02, z0 + 3], [x + 0.8, 0.02, z0 + 3], [x + 0.8, 0.02, z0], [0, 1, 0], LINE, MAT.flat)
          m.quad([z0, 0.02, x], [z0, 0.02, x + 0.8], [z0 + 3, 0.02, x + 0.8], [z0 + 3, 0.02, x], [0, 1, 0], LINE, MAT.flat)
        }
      }
    }

  // City blocks: raised sidewalk slabs with curbs, or parks.
  const parkSet = new Set(city.parks.map((p) => `${p.x0},${p.z0}`))
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const x0 = i * CELL + ROAD_HALF
      const x1 = (i + 1) * CELL - ROAD_HALF
      const z0 = j * CELL + ROAD_HALF
      const z1 = (j + 1) * CELL - ROAD_HALF
      m.box(x0, x1, 0, 0.15, z0, z1, CURB)
      const park = parkSet.has(`${x0},${z0}`)
      m.quad([x0 + 0.4, 0.16, z0 + 0.4], [x0 + 0.4, 0.16, z1 - 0.4], [x1 - 0.4, 0.16, z1 - 0.4], [x1 - 0.4, 0.16, z0 + 0.4], [0, 1, 0], SIDEWALK)
      if (park) {
        m.box(x0 + 3, x1 - 3, 0.22, 0.42, z0 + 3, z1 - 3, GRASS)
        // Footpaths crossing the park and a fountain plaza.
        const cx = (x0 + x1) / 2
        const cz = (z0 + z1) / 2
        m.box(cx - 1.6, cx + 1.6, 0.42, 0.46, z0 + 3, z1 - 3, SIDEWALK)
        m.box(x0 + 3, x1 - 3, 0.42, 0.46, cz - 1.6, cz + 1.6, SIDEWALK)
        m.prism(cx, cz, 9, 9, 0.42, 0.5, 10, SIDEWALK)
        m.prism(cx, cz, 4, 4, 0.5, 1.1, 10, CURB)
        m.prism(cx, cz, 3.4, 3.4, 1.1, 1.12, 10, [0.15, 0.3, 0.45], MAT.water)
        m.prism(cx, cz, 0.6, 0.3, 1.1, 3.4, 6, CURB)
      }
    }

  // Trees.
  for (const t of city.trees) {
    const s = t.s
    const leaf = LEAF[Math.floor(rng() * LEAF.length)]!
    m.prism(t.x, t.z, 0.25 * s, 0.2 * s, 0.2, 1.6 * s, 5, TRUNK)
    m.prism(t.x, t.z, 2.2 * s, 0, 1.3 * s, 5.2 * s, 6, leaf)
    m.prism(t.x, t.z, 1.6 * s, 0, 3.2 * s, 6.6 * s, 6, leaf)
  }

  // Street lamps at block corners (one per intersection, alternating corners).
  for (let k = 0; k <= GRID; k++)
    for (let n = 0; n <= GRID; n++) {
      const cx = k * CELL
      const cz = n * CELL
      const corners = [
        [1, 1],
        [-1, -1],
      ]
      for (const [sx, sz] of corners) {
        const x = cx + sx! * (ROAD_HALF + 1.2)
        const z = cz + sz! * (ROAD_HALF + 1.2)
        if (x < 0 || z < 0 || x > GRID * CELL || z > GRID * CELL) continue
        m.box(x - 0.15, x + 0.15, 0.2, 6.2, z - 0.15, z + 0.15, METAL)
        m.box(x - 0.45, x + 0.45, 6.2, 6.6, z - 0.45, z + 0.45, METAL)
        m.box(x - 0.35, x + 0.35, 5.95, 6.2, z - 0.35, z + 0.35, WARM, MAT.emissive)
        lamps.push({ x, y: 5.6, z })
      }
    }

  // Alleys: dark asphalt strips, dumpsters against the walls and a caged wall light every so often.
  for (const a of city.alleys) {
    m.quad([a.x0, 0.17, a.z0], [a.x0, 0.17, a.z1], [a.x1, 0.17, a.z1], [a.x1, 0.17, a.z0], [0, 1, 0], [0.1, 0.105, 0.12])
    const alongZ = a.z1 - a.z0 > a.x1 - a.x0
    const len = alongZ ? a.z1 - a.z0 : a.x1 - a.x0
    for (let t = 9; t < len - 9; t += 14 + rng() * 10) {
      const side = rng() < 0.5 ? 0 : 1
      if (alongZ) {
        const x = side ? a.x1 - 0.7 : a.x0 + 0.7
        const z = a.z0 + t
        if (rng() < 0.6) m.box(x - 0.55, x + 0.55, 0.17, 1.3, z - 1, z + 1, [0.16, 0.3, 0.2])
        const lx = side ? a.x1 - 0.15 : a.x0 + 0.15
        m.box(lx - 0.15, lx + 0.15, 3.6, 3.9, z + 2.5, z + 2.9, WARM, MAT.emissive)
        lamps.push({ x: side ? a.x1 - 0.8 : a.x0 + 0.8, y: 3.5, z: z + 2.7, small: true })
      } else {
        const z = side ? a.z1 - 0.7 : a.z0 + 0.7
        const x = a.x0 + t
        if (rng() < 0.6) m.box(x - 1, x + 1, 0.17, 1.3, z - 0.55, z + 0.55, [0.32, 0.22, 0.14])
        const lz = side ? a.z1 - 0.15 : a.z0 + 0.15
        m.box(x + 2.5, x + 2.9, 3.6, 3.9, lz - 0.15, lz + 0.15, WARM, MAT.emissive)
        lamps.push({ x: x + 2.7, y: 3.5, z: side ? a.z1 - 0.8 : a.z0 + 0.8, small: true })
      }
    }
  }

  // Parking lot surfaces with painted bays.
  const lots = new Map<string, { x0: number; x1: number; z0: number; z1: number }>()
  for (const p of city.parked) {
    const key = `${Math.floor(p.x / CELL)},${Math.floor(p.z / CELL)}`
    const cur = lots.get(key) ?? { x0: p.x, x1: p.x, z0: p.z, z1: p.z }
    lots.set(key, { x0: Math.min(cur.x0, p.x), x1: Math.max(cur.x1, p.x), z0: Math.min(cur.z0, p.z), z1: Math.max(cur.z1, p.z) })
    for (const s of [-1, 1]) m.box(p.x + s * 1.55 - 0.06, p.x + s * 1.55 + 0.06, 0.16, 0.18, p.z - 2.4, p.z + 2.4, LINE, MAT.flat)
  }

  // Buildings.
  for (const b of city.boxes) {
    if (b.kind !== "building") continue
    building(m, b.x0, b.x1, b.z0, b.z1, b.h, b.color, b.neon, b.label, rng)
  }

  // Helipad on the precinct roof.
  const hp = city.helipad
  m.prism(hp.x, hp.z, 8, 8, hp.y - 0.5, hp.y, 12, [0.2, 0.22, 0.26])
  m.prism(hp.x, hp.z, 7.4, 7.4, hp.y, hp.y + 0.02, 12, [0.95, 0.75, 0.2], MAT.flat)
  m.prism(hp.x, hp.z, 6.8, 6.8, hp.y + 0.02, hp.y + 0.04, 12, [0.2, 0.22, 0.26])
  m.box(hp.x - 2.4, hp.x - 1.6, hp.y + 0.04, hp.y + 0.06, hp.z - 3, hp.z + 3, [0.95, 0.95, 0.95], MAT.flat)
  m.box(hp.x + 1.6, hp.x + 2.4, hp.y + 0.04, hp.y + 0.06, hp.z - 3, hp.z + 3, [0.95, 0.95, 0.95], MAT.flat)
  m.box(hp.x - 1.6, hp.x + 1.6, hp.y + 0.04, hp.y + 0.06, hp.z - 0.4, hp.z + 0.4, [0.95, 0.95, 0.95], MAT.flat)

  harbor(m, city, rng)
  return { mesh: m, lamps }
}

function building(m: Mesh, x0: number, x1: number, z0: number, z1: number, h: number, color: Rgb, neon: Rgb | null, label: string | null, rng: () => number) {
  const dark: Rgb = [color[0] * 0.55, color[1] * 0.55, color[2] * 0.6]
  const roofTone: Rgb = [0.2 + color[0] * 0.15, 0.21 + color[1] * 0.15, 0.24 + color[2] * 0.15]
  m.box(x0, x1, 0.15, h, z0, z1, color, MAT.facade)
  m.quad([x0, h + 0.02, z0], [x0, h + 0.02, z1], [x1, h + 0.02, z1], [x1, h + 0.02, z0], [0, 1, 0], roofTone)
  // Base course and parapet.
  m.box(x0 - 0.25, x1 + 0.25, 0.15, 0.9, z0 - 0.25, z1 + 0.25, dark)
  m.box(x0 - 0.2, x1 + 0.2, h, h + 0.9, z0 - 0.2, z0 + 0.4, dark)
  m.box(x0 - 0.2, x1 + 0.2, h, h + 0.9, z1 - 0.4, z1 + 0.2, dark)
  m.box(x0 - 0.2, x0 + 0.4, h, h + 0.9, z0, z1, dark)
  m.box(x1 - 0.4, x1 + 0.2, h, h + 0.9, z0, z1, dark)
  // Setback on tall buildings.
  const w = x1 - x0
  const d = z1 - z0
  let top = h
  if (h > 20 && w > 14 && d > 14 && rng() < 0.6) {
    const sx = w * 0.18
    const sz = d * 0.18
    const h2 = h + 5 + rng() * 10
    m.box(x0 + sx, x1 - sx, h, h2, z0 + sz, z1 - sz, color, MAT.facade)
    m.quad([x0 + sx, h2 + 0.02, z0 + sz], [x0 + sx, h2 + 0.02, z1 - sz], [x1 - sx, h2 + 0.02, z1 - sz], [x1 - sx, h2 + 0.02, z0 + sz], [0, 1, 0], roofTone)
    m.box(x0 + sx - 0.2, x1 - sx + 0.2, h2, h2 + 0.7, z0 + sz - 0.2, z1 - sz + 0.2, dark)
    top = h2
    x0 += sx
    x1 -= sx
    z0 += sz
    z1 -= sz
  }
  // Rooftop clutter: AC units, a water tank, a stair hut.
  const roof: Rgb = [0.3, 0.31, 0.34]
  const n = 2 + Math.floor(rng() * 4 + ((x1 - x0) * (z1 - z0)) / 250)
  for (let i = 0; i < n; i++) {
    const cx = x0 + 2 + rng() * Math.max(0.1, x1 - x0 - 4)
    const cz = z0 + 2 + rng() * Math.max(0.1, z1 - z0 - 4)
    const s = 0.6 + rng() * 1.1
    m.box(cx - s, cx + s, top, top + s * 1.1, cz - s * 0.8, cz + s * 0.8, roof)
    m.box(cx - s * 0.6, cx + s * 0.6, top + s * 1.1, top + s * 1.2, cz - s * 0.5, cz + s * 0.5, [0.18, 0.18, 0.2])
  }
  if (rng() < 0.5) {
    // Stair hut with a door light.
    const cx = x0 + 3 + rng() * Math.max(0.1, x1 - x0 - 6)
    const cz = z0 + 3 + rng() * Math.max(0.1, z1 - z0 - 6)
    m.box(cx - 1.6, cx + 1.6, top, top + 2.8, cz - 1.4, cz + 1.4, dark)
    m.box(cx - 0.3, cx + 0.3, top + 2.2, top + 2.4, cz - 1.5, cz - 1.4, WARM, MAT.emissive)
  }
  if (rng() < 0.35) {
    const cx = (x0 + x1) / 2 + (rng() - 0.5) * (x1 - x0) * 0.4
    const cz = (z0 + z1) / 2 + (rng() - 0.5) * (z1 - z0) * 0.4
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.box(cx + lx! * 1.1 - 0.1, cx + lx! * 1.1 + 0.1, top, top + 2, cz + lz! * 1.1 - 0.1, cz + lz! * 1.1 + 0.1, METAL)
    m.prism(cx, cz, 1.6, 1.6, top + 2, top + 4.5, 8, [0.35, 0.27, 0.2])
    m.prism(cx, cz, 1.6, 0, top + 4.5, top + 5.4, 8, [0.3, 0.23, 0.18])
  }

  // Ground-floor storefronts: lit shop glass and a colored awning on one street face.
  if (rng() < 0.55 && w > 8) {
    const awn = AWNINGS[Math.floor(rng() * AWNINGS.length)]!
    const zf = rng() < 0.5 ? z0 : z1
    const out = zf === z0 ? -1 : 1
    const a0 = x0 + 1.2
    const a1 = Math.min(x1 - 1.2, a0 + 6 + rng() * 8)
    m.box(a0, a1, 0.9, 2.6, zf - 0.03 * -out - (out < 0 ? 0.08 : 0), zf + (out > 0 ? 0.08 : 0), [1, 0.78, 0.5], MAT.emissive)
    m.box(a0 - 0.2, a1 + 0.2, 2.9, 3.15, out < 0 ? zf - 1.6 : zf, out < 0 ? zf : zf + 1.6, awn)
  }

  if (neon) {
    // A glowing sign band on one or two street faces, the strongest color accents in the scene.
    const y = 4 + rng() * Math.min(6, h - 7)
    const side = Math.floor(rng() * 4)
    const t = 0.25
    if (side === 0) m.box(x0 + 1.5, x1 - 1.5, y, y + 0.35, z0 - t - 0.05, z0 - 0.05, neon, MAT.emissive)
    if (side === 1) m.box(x0 + 1.5, x1 - 1.5, y, y + 0.35, z1 + 0.05, z1 + t + 0.05, neon, MAT.emissive)
    if (side === 2) m.box(x0 - t - 0.05, x0 - 0.05, y, y + 0.35, z0 + 1.5, z1 - 1.5, neon, MAT.emissive)
    if (side === 3) m.box(x1 + 0.05, x1 + t + 0.05, y, y + 0.35, z0 + 1.5, z1 - 1.5, neon, MAT.emissive)
    // Vertical blade sign.
    if (rng() < 0.6 || label) {
      const bx = side < 2 ? x0 + 2 : side === 2 ? x0 - 0.6 : x1 + 0.6
      const bz = side < 2 ? (side === 0 ? z0 - 0.6 : z1 + 0.6) : z0 + 2
      m.box(bx - 0.25, bx + 0.25, y + 1.5, y + 7, bz - 0.25, bz + 0.25, neon, MAT.emissive)
    }
  }
  void label
}

function harbor(m: Mesh, city: City, rng: () => number) {
  const wz = city.waterZ
  const max = city.max
  // Quay edge, water, piers and stacked containers along the waterfront.
  m.box(-300, max + 300, -3, 0.25, wz - 1, wz + 0.4, [0.26, 0.26, 0.28])
  m.quad([-300, -1.4, wz], [-300, -1.4, wz + 400], [max + 300, -1.4, wz + 400], [max + 300, -1.4, wz], [0, 1, 0], [0.05, 0.1, 0.16], MAT.water)
  for (let x = 30; x < max - 20; x += 46 + rng() * 20) {
    m.box(x, x + 4, -1.2, 0.1, wz, wz + 26 + rng() * 14, [0.28, 0.22, 0.17])
    // Moored boats.
    const bz = wz + 8 + rng() * 10
    const bx = x + 7
    m.box(bx, bx + 3.2, -1.4, -0.4, bz, bz + 9, [0.85, 0.85, 0.88])
    m.box(bx + 0.6, bx + 2.6, -0.4, 0.8, bz + 2.5, bz + 5.5, [0.7, 0.72, 0.76])
  }
}
