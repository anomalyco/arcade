import type { Box, City } from "../../../shared/sim/city"
import { MAT, type Mesh, type Rgb } from "../mesh"
import { beam, cylinder, ground, shade, SKIP, slab, type V3 } from "./kit"
import { streetLamp } from "./props"
import type { LampLight } from "./types"

const CRANE: Rgb = [0.62, 0.17, 0.13]
const CONCRETE: Rgb = [0.32, 0.32, 0.34]
const IRON: Rgb = [0.1, 0.11, 0.13]

/** Container with corrugated sides, end doors and a darker roof. */
export function container(m: Mesh, b: Box, base = 0) {
  const tiers = Math.max(1, Math.round(b.h / 2.6))
  for (let k = 0; k < tiers; k++) {
    // Stacked boxes alternate color a little.
    const c = k === 0 ? b.color : shade(b.color, 0.82 + ((k * 37 + Math.round(b.x0)) % 5) * 0.06)
    const y0 = base + k * 2.6
    const y1 = y0 + 2.55
    const { x0, x1, z0, z1 } = b
    const alongX = x1 - x0 > z1 - z0
    slab(m, x0, x1, y0, y1, z0, z1, shade(c, 0.95), MAT.lit, SKIP.bottom, shade(c, 0.8))
    const e = 0.02
    // Corrugation decals on the long sides.
    if (alongX) {
      m.decal([x1, y0 + 0.1, z0 - e], [x0, y0 + 0.1, z0 - e], [x0, y1 - 0.1, z0 - e], [x1, y1 - 0.1, z0 - e], [0, 0, -1], "container", c, MAT.decal)
      m.decal([x0, y0 + 0.1, z1 + e], [x1, y0 + 0.1, z1 + e], [x1, y1 - 0.1, z1 + e], [x0, y1 - 0.1, z1 + e], [0, 0, 1], "container", c, MAT.decal)
      // Door end: two lock bars.
      for (const dz of [0.7, 1.7]) m.box(x0 - 0.05, x0, y0 + 0.2, y1 - 0.2, z0 + dz - 0.04, z0 + dz + 0.04, shade(c, 0.5))
    } else {
      m.decal([x0 - e, y0 + 0.1, z0], [x0 - e, y0 + 0.1, z1], [x0 - e, y1 - 0.1, z1], [x0 - e, y1 - 0.1, z0], [-1, 0, 0], "container", c, MAT.decal)
      m.decal([x1 + e, y0 + 0.1, z1], [x1 + e, y0 + 0.1, z0], [x1 + e, y1 - 0.1, z0], [x1 + e, y1 - 0.1, z1], [1, 0, 0], "container", c, MAT.decal)
    }
  }
}

/** Rail-mounted gantry crane over the yard: four legs from the city boxes, portal beams, a boom out over the water. */
export function crane(m: Mesh, legs: Box[], lamps: LampLight[], waterZ: number) {
  if (legs.length < 4) return
  const xs = [...new Set(legs.map((l) => (l.x0 + l.x1) / 2))].sort((a, b) => a - b)
  const zs = [...new Set(legs.map((l) => (l.z0 + l.z1) / 2))].sort((a, b) => a - b)
  const xa = xs[0]!
  const xb = xs[xs.length - 1]!
  const za = zs[0]!
  const zb = zs[zs.length - 1]!
  const top = legs[0]!.h
  for (const l of legs) {
    const cx = (l.x0 + l.x1) / 2
    const cz = (l.z0 + l.z1) / 2
    // Bogie with wheels at the foot, then the leg.
    slab(m, cx - 1.1, cx + 1.1, 0, 0.9, cz - 0.9, cz + 0.9, [0.2, 0.2, 0.22])
    for (const s of [-0.6, 0.6]) cylinder(m, cx + s, cz - 0.95, 0.42, 0.0, 0.08, 8, [0.08, 0.08, 0.09])
    slab(m, l.x0, l.x1, 0.9, top, l.z0, l.z1, CRANE)
  }
  // Portal beams.
  for (const z of [za, zb]) slab(m, xa - 1, xb + 1, top - 1.6, top, z - 0.8, z + 0.8, CRANE, MAT.lit, 0)
  for (const x of [xa, xb]) slab(m, x - 0.8, x + 0.8, top - 1.2, top - 0.1, za, zb, CRANE, MAT.lit, SKIP.bottom)
  // Leg bracing.
  for (const x of [xa, xb]) {
    beam(m, [x, 2, za], [x, top - 2, zb], 0.35, shade(CRANE, 0.9))
    beam(m, [x, 2, zb], [x, top - 2, za], 0.35, shade(CRANE, 0.9))
    slab(m, x - 0.35, x + 0.35, 6, 6.6, za, zb, shade(CRANE, 0.9))
  }
  for (const z of [za, zb]) {
    beam(m, [xa, 3, z], [xb, top - 2, z], 0.35, shade(CRANE, 0.9))
  }
  // Boom: a long truss reaching out over the road and the water.
  const cx = (xa + xb) / 2
  const by = top + 1.2
  const bz0 = za - 6
  const bz1 = waterZ + 34
  slab(m, cx - 1.2, cx + 1.2, by - 1.2, by, bz0, bz1, CRANE, MAT.lit, 0)
  for (let z = bz0; z < bz1 - 2; z += 4) {
    beam(m, [cx - 1.2, by, z], [cx - 1.2, by + 2.2, z + 2], 0.18, CRANE)
    beam(m, [cx - 1.2, by + 2.2, z + 2], [cx - 1.2, by, z + 4], 0.18, CRANE)
    beam(m, [cx + 1.2, by, z], [cx + 1.2, by + 2.2, z + 2], 0.18, CRANE)
    beam(m, [cx + 1.2, by + 2.2, z + 2], [cx + 1.2, by, z + 4], 0.18, CRANE)
  }
  slab(m, cx - 1.3, cx - 1.0, by + 2.1, by + 2.4, bz0, bz1 - 2, CRANE, MAT.lit, 0)
  slab(m, cx + 1.0, cx + 1.3, by + 2.1, by + 2.4, bz0, bz1 - 2, CRANE, MAT.lit, 0)
  // Machinery house, the A-frame and the stays.
  slab(m, xa - 1, xb + 1, top, top + 3.4, za - 4, za + 3, [0.55, 0.53, 0.5], MAT.lit, SKIP.bottom, [0.3, 0.3, 0.32])
  for (const s of [-1, 1]) beam(m, [cx + s * 1.5, top + 3.4, za], [cx + s * 0.6, top + 12, za + 2], 0.45, CRANE)
  for (const s of [-1, 1]) beam(m, [cx + s * 0.6, top + 12, za + 2], [cx + s * 1.1, by + 0.3, bz1 - 6], 0.12, [0.25, 0.25, 0.27])
  for (const s of [-1, 1]) beam(m, [cx + s * 0.6, top + 12, za + 2], [cx + s * 1.1, by + 0.3, (za + bz1) / 2], 0.12, [0.25, 0.25, 0.27])
  // Trolley with the spreader hanging over the yard, and a lit cab.
  const tz = (za + zb) / 2
  slab(m, cx - 1.8, cx + 1.8, by - 2.6, by - 1.2, tz - 1.5, tz + 1.5, [0.85, 0.78, 0.35], MAT.lit, 0)
  slab(m, cx - 1.6, cx + 1.6, by - 4.6, by - 2.6, tz - 1.5 , tz - 0.2, [0.55, 0.53, 0.5], MAT.lit, 0)
  m.quad([cx + 1.4, by - 4.3, tz - 1.52], [cx - 1.4, by - 4.3, tz - 1.52], [cx - 1.4, by - 3.0, tz - 1.52], [cx + 1.4, by - 3.0, tz - 1.52], [0, 0, -1], [0.95, 0.8, 0.55], MAT.emissive)
  for (const s of [-1.2, 1.2]) beam(m, [cx + s, by - 2.6, tz + 0.6], [cx + s, 9.5, tz + 0.6], 0.06, [0.15, 0.15, 0.17])
  slab(m, cx - 3, cx + 3, 8.8, 9.5, tz - 0.4, tz + 1.6, [0.85, 0.7, 0.2], MAT.lit, 0)
  // "HARBOR 7" on the portal beam and warning lights on top.
  m.decal([xb + 0.6, top - 1.45, za - 0.82], [xa - 0.6, top - 1.45, za - 0.82], [xa - 0.6, top - 0.15, za - 0.82], [xb + 0.6, top - 0.15, za - 0.82], [0, 0, -1], "harbor", [0.85, 0.85, 0.82], MAT.decal)
  for (const p of [
    [xa - 1, top + 3.6, za - 4],
    [xb + 1, top + 3.6, za - 4],
    [cx, top + 12.3, za + 2],
    [cx, by + 2.6, bz1 - 2],
  ] as const) m.box(p[0] - 0.2, p[0] + 0.2, p[1], p[1] + 0.35, p[2] - 0.2, p[2] + 0.2, [1, 0.12, 0.08], MAT.emissive)
  // Work lights under the portal.
  for (const x of [xa, xb]) {
    m.box(x - 0.3, x + 0.3, top - 2, top - 1.6, tz - 0.3, tz + 0.3, [1, 0.85, 0.6], MAT.emissive)
    lamps.push({ x, y: top - 3, z: tz })
  }
}

/** Waterfront: quay wall, railing, bollards, water, piers with moored boats and the marina. */
export function waterfront(m: Mesh, city: City, rng: () => number, lamps: LampLight[]) {
  const wz = city.waterZ
  const max = city.max
  // Quay apron between the road edge and the water.
  ground(m, -320, max + 320, wz - 0.01, wz + 2.5, 0.02, CONCRETE)
  slab(m, -320, max + 320, -3, 0.02, wz + 2.5, wz + 2.9, shade(CONCRETE, 0.8), MAT.lit, SKIP.bottom | SKIP.top)
  slab(m, -320, max + 320, 0.02, 0.24, wz + 2.3, wz + 2.9, [0.55, 0.55, 0.55])
  m.quad([-320, -1.3, wz + 2.9], [-320, -1.3, wz + 420], [max + 320, -1.3, wz + 420], [max + 320, -1.3, wz + 2.9], [0, 1, 0], [0.06, 0.12, 0.2], MAT.water)
  // Wrought-iron railing: thin bars facing the camera, a top rail and posts.
  const fz = wz + 2.15
  for (let x = -60; x < max + 60; x += 0.32) {
    if (Math.abs(x - 3 * 76) < 8) continue
    m.quad([x + 0.05, 0.24, fz], [x, 0.24, fz], [x, 1.25, fz], [x + 0.05, 1.25, fz], [0, 0, -1], IRON)
  }
  slab(m, -60, max + 60, 1.2, 1.32, fz - 0.05, fz + 0.05, IRON, MAT.lit, SKIP.bottom)
  slab(m, -60, max + 60, 0.5, 0.56, fz - 0.03, fz + 0.03, IRON, MAT.lit, SKIP.bottom)
  for (let x = -60; x < max + 60; x += 3) slab(m, x - 0.06, x + 0.06, 0.24, 1.4, fz - 0.06, fz + 0.06, IRON, MAT.lit, SKIP.bottom)
  for (let x = -40; x < max + 40; x += 25) {
    streetLamp(m, lamps, x, wz + 1.3, x, wz + 1.9, 0.02)
  }
  // Piers with moored boats.
  for (let x = 20; x < max - 20; x += 44 + rng() * 18) {
    if (Math.abs(x - 3 * 76) < 30) continue
    const len = 24 + rng() * 16
    slab(m, x, x + 4, -1.3, 0.1, wz + 2.9, wz + 2.9 + len, [0.3, 0.22, 0.16], MAT.lit, SKIP.bottom, [0.36, 0.27, 0.19])
    for (let z = wz + 6; z < wz + len; z += 5) for (const px of [x, x + 4]) cylinder(m, px, z, 0.18, -1.4, 0.5, 5, [0.2, 0.16, 0.12])
    boat(m, rng, x + 7.5, wz + 8 + rng() * 12, rng() < 0.5)
    if (rng() < 0.6) boat(m, rng, x - 3.5, wz + 10 + rng() * 10, rng() < 0.5)
  }
  // Marina at the extraction point: floating finger docks with small boats.
  const mx = 3 * 76
  slab(m, mx - 2, mx + 2, -1.3, 0.05, wz + 2.9, wz + 40, [0.42, 0.38, 0.32], MAT.lit, SKIP.bottom)
  for (let z = wz + 8; z < wz + 38; z += 8)
    for (const s of [-1, 1]) {
      const x0 = s < 0 ? mx - 14 : mx + 2
      slab(m, x0, x0 + 12, -1.2, -0.95, z, z + 1.4, [0.42, 0.38, 0.32])
      boat(m, rng, s < 0 ? mx - 9 : mx + 9, z + 3.4, true)
    }
  for (const z of [wz + 14, wz + 30]) {
    m.box(mx - 0.2, mx + 0.2, 0.05, 1.3, z - 0.2, z + 0.2, [0.15, 0.15, 0.17])
    m.box(mx - 0.25, mx + 0.25, 1.3, 1.6, z - 0.25, z + 0.25, [0.6, 1, 0.75], MAT.emissive)
    lamps.push({ x: mx, y: 1.8, z, small: true })
  }
  // Far breakwater with a little lighthouse, so the bay has an edge.
  slab(m, -100, max + 100, -1.3, 0.8, wz + 150, wz + 158, [0.25, 0.25, 0.28])
  cylinder(m, max * 0.6, wz + 154, 2, 0.8, 9, 8, [0.85, 0.85, 0.82])
  cylinder(m, max * 0.6, wz + 154, 1.4, 9, 10.5, 8, [1, 0.85, 0.5], MAT.emissive)
}

function boat(m: Mesh, rng: () => number, x: number, z: number, small: boolean) {
  const L = small ? 7 : 11
  const W = small ? 2.4 : 3.4
  const hull: Rgb = rng() < 0.7 ? [0.82, 0.82, 0.85] : [0.25, 0.32, 0.45]
  const y0 = -1.4
  const y1 = small ? -0.5 : -0.2
  const z0 = z - L / 2
  const z1 = z + L / 2
  // Hull: a box with a pointed bow.
  slab(m, x - W / 2, x + W / 2, y0, y1, z0, z1 - 2, hull, MAT.lit, SKIP.bottom | SKIP.pz)
  const bow: V3 = [x, y1, z1 + 0.5]
  m.facet([x - W / 2, y0, z1 - 2], [x - W / 2, y1, z1 - 2], bow, hull)
  m.facet([x + W / 2, y1, z1 - 2], [x + W / 2, y0, z1 - 2], bow, hull)
  m.facet([x - W / 2, y1, z1 - 2], [x + W / 2, y1, z1 - 2], bow, shade(hull, 1.1))
  ground(m, x - W / 2 + 0.2, x + W / 2 - 0.2, z0 + 0.2, z1 - 2, y1 + 0.01, [0.55, 0.42, 0.3])
  slab(m, x - W / 2 + 0.4, x + W / 2 - 0.4, y1, y1 + 1.2, z - 1, z + 1.5, [0.9, 0.9, 0.92], MAT.lit, SKIP.bottom)
  m.quad([x + W / 2 - 0.45, y1 + 0.6, z - 1.01], [x - W / 2 + 0.45, y1 + 0.6, z - 1.01], [x - W / 2 + 0.45, y1 + 1.05, z - 1.01], [x + W / 2 - 0.45, y1 + 1.05, z - 1.01], [0, 0, -1], rng() < 0.4 ? [0.9, 0.7, 0.4] : [0.1, 0.12, 0.16], rng() < 0.4 ? MAT.emissive : MAT.glass)
  if (!small) cylinder(m, x, z + 0.3, 0.06, y1 + 1.2, y1 + 6, 4, [0.7, 0.7, 0.72])
}
