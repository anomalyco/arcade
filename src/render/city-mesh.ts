import { CELL, GRID, ROAD_HALF } from "../../shared/config"
import type { City } from "../../shared/sim/city"
import { mulberry32 } from "../../shared/sim/rng"
import { MAT, Mesh, type Rgb } from "./mesh"

const ASPHALT: Rgb = [0.13, 0.14, 0.17]
const SIDEWALK: Rgb = [0.3, 0.3, 0.32]
const CURB: Rgb = [0.4, 0.4, 0.41]
const GRASS: Rgb = [0.12, 0.2, 0.13]
const LINE: Rgb = [0.75, 0.72, 0.62]
const YELLOW: Rgb = [0.85, 0.66, 0.2]
const LEAF: Rgb[] = [
  [0.14, 0.27, 0.15],
  [0.18, 0.31, 0.16],
  [0.11, 0.22, 0.14],
]
const TRUNK: Rgb = [0.25, 0.17, 0.12]
const METAL: Rgb = [0.18, 0.19, 0.21]
const WARM: Rgb = [1.0, 0.72, 0.38]

export type LampLight = { x: number; y: number; z: number }

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
      m.box(x0, x1, 0, 0.22, z0, z1, CURB)
      const park = parkSet.has(`${x0},${z0}`)
      m.quad([x0 + 0.4, 0.23, z0 + 0.4], [x0 + 0.4, 0.23, z1 - 0.4], [x1 - 0.4, 0.23, z1 - 0.4], [x1 - 0.4, 0.23, z0 + 0.4], [0, 1, 0], SIDEWALK)
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

  // Buildings.
  for (const b of city.boxes) {
    if (b.kind === "wall") continue
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
  m.box(x0, x1, 0.22, h, z0, z1, color, MAT.facade)
  // Base course and parapet.
  m.box(x0 - 0.25, x1 + 0.25, 0.22, 1.0, z0 - 0.25, z1 + 0.25, dark)
  m.box(x0 - 0.2, x1 + 0.2, h, h + 0.9, z0 - 0.2, z0 + 0.4, dark)
  m.box(x0 - 0.2, x1 + 0.2, h, h + 0.9, z1 - 0.4, z1 + 0.2, dark)
  m.box(x0 - 0.2, x0 + 0.4, h, h + 0.9, z0, z1, dark)
  m.box(x1 - 0.4, x1 + 0.2, h, h + 0.9, z0, z1, dark)
  // Setback on tall buildings.
  const w = x1 - x0
  const d = z1 - z0
  let top = h
  if (h > 26 && w > 14 && d > 14 && rng() < 0.6) {
    const sx = w * 0.18
    const sz = d * 0.18
    const h2 = h + 5 + rng() * 10
    m.box(x0 + sx, x1 - sx, h, h2, z0 + sz, z1 - sz, color, MAT.facade)
    m.box(x0 + sx - 0.2, x1 - sx + 0.2, h2, h2 + 0.7, z0 + sz - 0.2, z1 - sz + 0.2, dark)
    top = h2
    x0 += sx
    x1 -= sx
    z0 += sz
    z1 -= sz
  }
  // Rooftop clutter: AC units, a water tank, a stair hut.
  const roof: Rgb = [0.22, 0.23, 0.26]
  const n = 1 + Math.floor(rng() * 3)
  for (let i = 0; i < n; i++) {
    const cx = x0 + 2 + rng() * Math.max(0.1, x1 - x0 - 4)
    const cz = z0 + 2 + rng() * Math.max(0.1, z1 - z0 - 4)
    const s = 0.8 + rng() * 1.2
    m.box(cx - s, cx + s, top, top + s * 1.1, cz - s * 0.8, cz + s * 0.8, roof)
  }
  if (rng() < 0.35) {
    const cx = (x0 + x1) / 2 + (rng() - 0.5) * (x1 - x0) * 0.4
    const cz = (z0 + z1) / 2 + (rng() - 0.5) * (z1 - z0) * 0.4
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.box(cx + lx! * 1.1 - 0.1, cx + lx! * 1.1 + 0.1, top, top + 2, cz + lz! * 1.1 - 0.1, cz + lz! * 1.1 + 0.1, METAL)
    m.prism(cx, cz, 1.6, 1.6, top + 2, top + 4.5, 8, [0.35, 0.27, 0.2])
    m.prism(cx, cz, 1.6, 0, top + 4.5, top + 5.4, 8, [0.3, 0.23, 0.18])
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
