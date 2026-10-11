import { CELL, GRID, ROAD_HALF } from "../../../shared/config"
import type { City, Tree } from "../../../shared/sim/city"
import { MAT, type Mesh, type Rgb } from "../mesh"
import { beam, cylinder, facetCone, ground, jitter, shade, SKIP, slab, type V3 } from "./kit"
import { CURB, KERB_H, SIDEWALK } from "./streets"
import type { LampLight } from "./types"

export const LEAF: Rgb[] = [
  [0.16, 0.26, 0.16],
  [0.19, 0.28, 0.16],
  [0.13, 0.23, 0.16],
  [0.21, 0.27, 0.14],
  [0.15, 0.26, 0.2],
]
const TRUNK: Rgb = [0.27, 0.19, 0.13]
const POLE: Rgb = [0.13, 0.14, 0.17]
const LAMP_GLOW: Rgb = [1.0, 0.78, 0.46]
const PLANTER: Rgb = [0.42, 0.4, 0.4]
const SOIL: Rgb = [0.12, 0.1, 0.09]
const WOOD: Rgb = [0.36, 0.24, 0.15]

/** Head height of a street lamp; scene.ts draws its glow sprite at 6.05. */
export const LAMP_Y = 6.05

/** Curbside street lamp: octagonal pole, a short arm and a lantern hanging over the gutter. */
export function streetLamp(m: Mesh, lamps: LampLight[], x: number, z: number, px: number, pz: number, y = KERB_H) {
  slab(m, px - 0.25, px + 0.25, y, y + 0.5, pz - 0.25, pz + 0.25, POLE)
  cylinder(m, px, pz, 0.11, y + 0.5, LAMP_Y + 0.75, 6, POLE)
  const top: V3 = [px, LAMP_Y + 0.65, pz]
  const head: V3 = [x, LAMP_Y + 0.55, z]
  beam(m, top, head, 0.1, POLE)
  // Decorative curl under the arm.
  beam(m, [px, LAMP_Y + 0.1, pz], [(px + x) / 2, LAMP_Y + 0.6, (pz + z) / 2], 0.06, POLE)
  // Lantern: cap, glowing glass, bottom.
  m.prism(x, z, 0.42, 0.08, LAMP_Y + 0.35, LAMP_Y + 0.62, 6, POLE)
  m.prism(x, z, 0.3, 0.36, LAMP_Y - 0.15, LAMP_Y + 0.35, 6, LAMP_GLOW, MAT.emissive)
  m.prism(x, z, 0.22, 0.3, LAMP_Y - 0.25, LAMP_Y - 0.15, 6, POLE)
  lamps.push({ x, y: LAMP_Y - 0.4, z })
}

/** Faceted low-poly conifer-ish tree: a trunk and two or three jittered cone tiers. */
export function tree(m: Mesh, rng: () => number, x: number, z: number, s: number, y = KERB_H) {
  const leaf = LEAF[Math.floor(rng() * LEAF.length)]!
  const hgt = (6.2 + rng() * 2.2) * s
  cylinder(m, x, z, 0.16 * s, y, y + hgt * 0.32, 5, TRUNK)
  const tiers = rng() < 0.6 ? 3 : 2
  const rot = rng() * 6
  for (let k = 0; k < tiers; k++) {
    const t0 = 0.22 + (k / tiers) * 0.48
    const r = (2.1 - k * 0.5) * s * (tiers === 2 ? 1.08 : 1)
    const c = jitter(leaf, rng, 0.08)
    facetCone(m, x, z, r, y + hgt * t0, y + hgt * (k === tiers - 1 ? 1 : t0 + 0.42), 7, shade(c, 1 + k * 0.06), rng, rot + k * 0.4)
  }
}

/** Square stone planter with a tree. */
function plantedTree(m: Mesh, rng: () => number, t: Tree, base: number) {
  const s = 0.85
  const top = base + 0.55
  slab(m, t.x - s, t.x + s, base, top, t.z - s, t.z + s, PLANTER, MAT.lit, SKIP.bottom, shade(PLANTER, 1.15))
  ground(m, t.x - s + 0.15, t.x + s - 0.15, t.z - s + 0.15, t.z + s - 0.15, top + 0.005, SOIL)
  tree(m, rng, t.x, t.z, t.s, top - 0.1)
}

export function trees(m: Mesh, rng: () => number, city: City) {
  for (const t of city.trees) {
    if (t.planter) plantedTree(m, rng, t, KERB_H)
    else tree(m, rng, t.x, t.z, t.s, 0.42)
  }
}

export function bench(m: Mesh, x: number, z: number, alongX: boolean, y = KERB_H) {
  const hx = alongX ? 0.9 : 0.25
  const hz = alongX ? 0.25 : 0.9
  slab(m, x - hx, x + hx, y + 0.42, y + 0.5, z - hz, z + hz, WOOD)
  for (const s of [-0.75, 0.75]) {
    const lx = alongX ? x + s : x
    const lz = alongX ? z : z + s
    slab(m, lx - 0.05, lx + 0.05, y, y + 0.42, lz - 0.05, lz + 0.05, POLE)
  }
  // Backrest on the building side.
  if (alongX) slab(m, x - hx, x + hx, y + 0.55, y + 0.85, z + 0.18, z + 0.25, WOOD)
  else slab(m, x + 0.18, x + 0.25, y + 0.55, y + 0.85, z - hz, z + hz, WOOD)
}

function bin(m: Mesh, x: number, z: number, y = KERB_H) {
  cylinder(m, x, z, 0.3, y, y + 0.9, 7, [0.18, 0.24, 0.2], MAT.lit, [0.1, 0.1, 0.1])
}

function hydrant(m: Mesh, x: number, z: number, y = KERB_H) {
  cylinder(m, x, z, 0.16, y, y + 0.6, 6, [0.62, 0.14, 0.12])
  m.prism(x, z, 0.18, 0.05, y + 0.6, y + 0.78, 6, [0.62, 0.14, 0.12])
  slab(m, x - 0.25, x + 0.25, y + 0.32, y + 0.42, z - 0.07, z + 0.07, [0.55, 0.12, 0.1])
}

export function barrel(m: Mesh, x: number, z: number, y = 0) {
  const orange: Rgb = [0.85, 0.36, 0.1]
  const white: Rgb = [0.85, 0.85, 0.82]
  cylinder(m, x, z, 0.32, y, y + 0.12, 8, [0.1, 0.1, 0.1])
  const bands = [orange, white, orange, white, orange]
  for (let k = 0; k < bands.length; k++) cylinder(m, x, z, 0.29, y + 0.12 + k * 0.17, y + 0.29 + k * 0.17, 8, bands[k]!)
}

/** Striped A-frame barrier. */
export function barrier(m: Mesh, x: number, z: number, alongX: boolean, len = 2.6, y = 0) {
  const h = len / 2
  const a: V3 = alongX ? [x - h, 0, z] : [x, 0, z - h]
  const t: V3 = alongX ? [1, 0, 0] : [0, 0, 1]
  const n: V3 = alongX ? [0, 0, -1] : [-1, 0, 0]
  for (const yy of [0.55, 0.95]) {
    const p = (u: number, v: number): V3 => [a[0] + t[0] * u + n[0] * 0.04, y + v, a[2] + t[2] * u + n[2] * 0.04]
    m.decal(p(0, yy), p(len, yy), p(len, yy + 0.25), p(0, yy + 0.25), n, "hazard", [0.9, 0.9, 0.9], MAT.decal)
    const q = (u: number, v: number): V3 => [a[0] + t[0] * u - n[0] * 0.04, y + v, a[2] + t[2] * u - n[2] * 0.04]
    m.decal(q(len, yy), q(0, yy), q(0, yy + 0.25), q(len, yy + 0.25), [-n[0], 0, -n[2]], "hazard", [0.9, 0.9, 0.9], MAT.decal)
  }
  for (const u of [0.15, len - 0.15]) {
    const px = a[0] + t[0] * u
    const pz = a[2] + t[2] * u
    beam(m, [px - n[0] * 0.4, y, pz - n[2] * 0.4], [px, y + 1.25, pz], 0.07, [0.8, 0.8, 0.78])
    beam(m, [px + n[0] * 0.4, y, pz + n[2] * 0.4], [px, y + 1.25, pz], 0.07, [0.8, 0.8, 0.78])
  }
  m.box(a[0] + t[0] * 0.15 - 0.08, a[0] + t[0] * 0.15 + 0.08, y + 1.25, y + 1.42, a[2] + t[2] * 0.15 - 0.08, a[2] + t[2] * 0.15 + 0.08, [1, 0.55, 0.15], MAT.emissive)
}

/** Lamps along every sidewalk, plus small street furniture beside some of them. */
export function streetFurniture(m: Mesh, rng: () => number, city: City, lamps: LampLight[]) {
  for (const l of city.lamps) {
    const px = l.px ?? l.x
    const pz = l.pz ?? l.z
    streetLamp(m, lamps, l.x, l.z, px, pz)
    // Inward direction (from the curb toward the buildings).
    const ix = Math.sign(px - l.x)
    const iz = Math.sign(pz - l.z)
    const tx = iz !== 0 ? 1 : 0
    const tz = ix !== 0 ? 1 : 0
    const roll = rng()
    if (roll < 0.3) bench(m, px + ix * 1.6 + tx * 2.2, pz + iz * 1.6 + tz * 2.2, tx === 1)
    else if (roll < 0.5) bin(m, px + tx * 1.0 + ix * 0.2, pz + tz * 1.0 + iz * 0.2)
    else if (roll < 0.6) hydrant(m, px - tx * 1.5, pz - tz * 1.5)
  }
}

/** Parking lots, paved courts and the container yard surface. */
export function yards(m: Mesh, city: City) {
  const line: Rgb = [0.6, 0.6, 0.58]
  for (const y of city.yards) {
    if (y.kind === "lot") {
      ground(m, y.x0, y.x1, y.z0, y.z1, 0.012, [0.15, 0.16, 0.2])
      for (const p of city.parked) {
        if (p.x < y.x0 || p.x > y.x1 || p.z < y.z0 || p.z > y.z1) continue
        for (const s of [-1.55, 1.55]) ground(m, p.x + s - 0.06, p.x + s + 0.06, p.z - 2.4, p.z + 2.4, 0.016, line, MAT.flat)
      }
      // Wheel stops along the lot edges.
      for (let x = y.x0 + 1; x < y.x1 - 1; x += 3.4) {
        slab(m, x + 0.6, x + 2.2, 0.01, 0.14, y.z0 + 0.4, y.z0 + 0.65, CURB)
        slab(m, x + 0.6, x + 2.2, 0.01, 0.14, y.z1 - 0.65, y.z1 - 0.4, CURB)
      }
    } else if (y.kind === "court") {
      slab(m, y.x0, y.x1, 0, KERB_H, y.z0, y.z1, CURB, MAT.lit, SKIP.bottom, SIDEWALK)
      for (let x = y.x0 + 2; x < y.x1 - 0.5; x += 2) ground(m, x, x + 0.05, y.z0, y.z1, KERB_H + 0.003, shade(SIDEWALK, 0.82))
      for (let z = y.z0 + 2; z < y.z1 - 0.5; z += 2) ground(m, y.x0, y.x1, z, z + 0.05, KERB_H + 0.003, shade(SIDEWALK, 0.82))
      bench(m, (y.x0 + y.x1) / 2, y.z0 + 1.2, true)
    } else {
      ground(m, y.x0, y.x1, y.z0, y.z1, 0.012, [0.27, 0.28, 0.3])
      const yellow: Rgb = [0.8, 0.62, 0.18]
      for (let z = y.z0 + 6.5; z < y.z1 - 2; z += 12.5) ground(m, y.x0 + 1, y.x1 - 1, z, z + 0.18, 0.016, yellow, MAT.flat)
    }
  }
}

/** Raised corner beds with a cluster of trees at about half the block corners, like the mockup's street corners. */
export function cornerBeds(m: Mesh, rng: () => number, city: City) {
  const parks = new Set(city.parks.map((p) => `${p.x0},${p.z0}`))
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const bx0 = i * CELL + ROAD_HALF
      const bx1 = (i + 1) * CELL - ROAD_HALF
      const bz0 = j * CELL + ROAD_HALF
      const bz1 = (j + 1) * CELL - ROAD_HALF
      if (parks.has(`${bx0},${bz0}`)) continue
      for (const [cx, sx] of [
        [bx0, 1],
        [bx1, -1],
      ] as const)
        for (const [cz, sz] of [
          [bz0, 1],
          [bz1, -1],
        ] as const) {
          if (rng() < 0.5) continue
          const a = cx + sx * 2.1
          const b = cx + sx * 4.7
          const c = cz + sz * 2.1
          const d = cz + sz * 4.7
          const x0 = Math.min(a, b), x1 = Math.max(a, b), z0 = Math.min(c, d), z1 = Math.max(c, d)
          slab(m, x0, x1, KERB_H, KERB_H + 0.75, z0, z1, PLANTER, MAT.lit, SKIP.bottom, shade(PLANTER, 1.15))
          ground(m, x0 + 0.18, x1 - 0.18, z0 + 0.18, z1 - 0.18, KERB_H + 0.755, SOIL)
          tree(m, rng, (x0 + x1) / 2 + (rng() - 0.5) * 0.6, (z0 + z1) / 2 + (rng() - 0.5) * 0.6, 0.9 + rng() * 0.25, KERB_H + 0.7)
          for (let k = 0; k < 3; k++) m.prism(x0 + 0.5 + rng() * (x1 - x0 - 1), z0 + 0.5 + rng() * (z1 - z0 - 1), 0.45, 0.15, KERB_H + 0.75, KERB_H + 1.3, 5, shade(LEAF[k]!, 0.9))
        }
    }
}
