import type { City, Park } from "../../../shared/sim/city"
import { MAT, type Mesh, type Rgb } from "../mesh"
import { beam, cylinder, ground, shade, SKIP, slab } from "./kit"
import { streetLamp, tree } from "./props"
import { CURB, KERB_H, SIDEWALK } from "./streets"
import type { LampLight } from "./types"

const GRASS: Rgb = [0.14, 0.23, 0.15]
const PAVING: Rgb = [0.4, 0.4, 0.43]
const STONE: Rgb = [0.5, 0.48, 0.46]
const HEDGE: Rgb = [0.13, 0.24, 0.15]

export function parks(m: Mesh, city: City, rng: () => number, lamps: LampLight[]) {
  for (const p of city.parks) {
    if (p.kind === "plaza") plaza(m, p, rng, lamps)
    else park(m, p, rng, lamps)
  }
}

/** Riverside Park: raised lawn, crossing paths, a fountain, benches and path lamps. */
function park(m: Mesh, p: Park, rng: () => number, lamps: LampLight[]) {
  const e = 3.2
  const x0 = p.x0 + e
  const x1 = p.x1 - e
  const z0 = p.z0 + e
  const z1 = p.z1 - e
  const cx = (p.x0 + p.x1) / 2
  const cz = (p.z0 + p.z1) / 2
  const top = KERB_H + 0.3
  slab(m, x0, x1, KERB_H, top, z0, z1, CURB, MAT.lit, SKIP.bottom, GRASS)
  // Low hedge border with gaps for the paths, and the paths themselves.
  const hedge = (a: number, b: number, c: number, d: number) => slab(m, a, b, top, top + 0.7, c, d, HEDGE)
  for (const [z, zz] of [
    [z0, z0 + 0.8],
    [z1 - 0.8, z1],
  ] as const) {
    hedge(x0, cx - 1.8, z, zz)
    hedge(cx + 1.8, x1, z, zz)
  }
  for (const [x, xx] of [
    [x0, x0 + 0.8],
    [x1 - 0.8, x1],
  ] as const) {
    hedge(x, xx, z0 + 0.8, cz - 1.8)
    hedge(x, xx, cz + 1.8, z1 - 0.8)
  }
  ground(m, cx - 1.8, cx + 1.8, z0, z1, top + 0.01, PAVING)
  ground(m, x0, x1, cz - 1.8, cz + 1.8, top + 0.01, PAVING)
  // Ring path and fountain.
  m.prism(cx, cz, 10.5, 10.5, top, top + 0.02, 16, PAVING)
  m.prism(cx, cz, 4.6, 4.6, top + 0.04, top + 0.65, 12, STONE)
  m.prism(cx, cz, 4.0, 4.0, top + 0.65, top + 0.67, 12, [0.15, 0.3, 0.42], MAT.water)
  cylinder(m, cx, cz, 0.6, top + 0.65, top + 2.2, 8, STONE)
  m.prism(cx, cz, 1.8, 1.8, top + 2.2, top + 2.5, 10, STONE)
  m.prism(cx, cz, 0.4, 0.1, top + 2.5, top + 3.6, 6, [0.6, 0.75, 0.9], MAT.emissive)
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + 0.4
    const lx = cx + Math.cos(a) * 9
    const lz = cz + Math.sin(a) * 9
    if (k % 2 === 0) streetLamp(m, lamps, lx, lz, lx, lz, top)
  }
  void rng
}

/** Riverdale Plaza: stepped terrace, statue in a round planter, banners, the plaza sign and roadworks. */
function plaza(m: Mesh, p: Park, rng: () => number, lamps: LampLight[]) {
  const cx = (p.x0 + p.x1) / 2
  const cz = (p.z0 + p.z1) / 2
  const base = KERB_H
  // Upper terrace with steps down on all four sides.
  const half = 19
  const steps = 4
  const rise = 0.22
  for (let k = 0; k < steps; k++) {
    const hk = half - k * 0.6
    slab(m, cx - hk, cx + hk, base, base + rise * (k + 1), cz - hk, cz + hk, shade(STONE, 0.9 + k * 0.03), MAT.lit, SKIP.bottom, shade(PAVING, 1 + k * 0.03))
  }
  const top = base + rise * steps
  const ih = half - steps * 0.6
  for (let x = cx - ih + 2.4; x < cx + ih; x += 2.4) ground(m, x, x + 0.06, cz - ih, cz + ih, top + 0.004, shade(PAVING, 0.85))
  for (let z = cz - ih + 2.4; z < cz + ih; z += 2.4) ground(m, cx - ih, cx + ih, z, z + 0.06, top + 0.004, shade(PAVING, 0.85))
  // Round planter with shrubs and the abstract statue.
  m.prism(cx, cz, 7.5, 7.5, top, top + 0.7, 16, STONE)
  m.prism(cx, cz, 7.0, 7.0, top + 0.7, top + 0.72, 16, [0.12, 0.1, 0.09])
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2
    const r = 5.4 + rng() * 1
    m.prism(cx + Math.cos(a) * r, cz + Math.sin(a) * r, 0.8 + rng() * 0.4, 0.25, top + 0.7, top + 1.6 + rng() * 0.6, 6, shade(HEDGE, 1 + rng() * 0.4))
  }
  slab(m, cx - 2, cx + 2, top + 0.7, top + 2, cz - 2, cz + 2, shade(STONE, 1.1))
  const bronze: Rgb = [0.42, 0.36, 0.3]
  m.facet([cx - 1.2, top + 2, cz - 0.8], [cx + 0.8, top + 2, cz - 1.2], [cx + 0.2, top + 8.5, cz + 0.3], bronze)
  m.facet([cx + 0.8, top + 2, cz - 1.2], [cx + 1, top + 2, cz + 1], [cx + 0.2, top + 8.5, cz + 0.3], shade(bronze, 0.8))
  m.facet([cx + 1, top + 2, cz + 1], [cx - 1.2, top + 2, cz - 0.8], [cx + 0.2, top + 8.5, cz + 0.3], shade(bronze, 0.65))
  m.facet([cx - 1.5, top + 4, cz + 0.2], [cx - 0.2, top + 3.4, cz - 0.6], [cx - 2.2, top + 7, cz - 0.4], shade(bronze, 1.1))
  m.facet([cx - 0.2, top + 3.4, cz - 0.6], [cx - 0.6, top + 4.4, cz + 0.8], [cx - 2.2, top + 7, cz - 0.4], shade(bronze, 0.7))
  m.facet([cx - 0.6, top + 4.4, cz + 0.8], [cx - 1.5, top + 4, cz + 0.2], [cx - 2.2, top + 7, cz - 0.4], shade(bronze, 0.9))
  // Uplights on the statue.
  for (const [dx, dz] of [
    [-2.6, -2.6],
    [2.6, -2.6],
  ] as const) {
    m.box(cx + dx - 0.2, cx + dx + 0.2, top + 0.7, top + 0.95, cz + dz - 0.2, cz + dz + 0.2, [1, 0.9, 0.7], MAT.emissive)
  }
  lamps.push({ x: cx - 3.5, y: top + 1.2, z: cz - 3.5, small: true })
  // Corner planters with trees and benches between.
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const px = cx + sx * (ih - 4.5)
      const pz = cz + sz * (ih - 4.5)
      slab(m, px - 3, px + 3, top, top + 0.8, pz - 3, pz + 3, STONE, MAT.lit, SKIP.bottom, [0.12, 0.1, 0.09])
      tree(m, rng, px - 1.2, pz - 1, 1.05, top + 0.75)
      tree(m, rng, px + 1.3, pz + 1.1, 0.9, top + 0.75)
      tree(m, rng, px + 1, pz - 1.4, 0.8, top + 0.75)
      streetLamp(m, lamps, cx + sx * (ih - 1), cz + sz * 9, cx + sx * (ih - 1), cz + sz * 9, top)
    }
  // Banners on tall poles at the front steps.
  for (const s of [-1, 1]) {
    const bx = cx - half - 1
    const bz = cz + s * 6
    cylinder(m, bx, bz, 0.12, base, base + 7.5, 6, [0.13, 0.14, 0.17])
    beam(m, [bx, base + 7.2, bz], [bx, base + 7.2, bz + s * 1.6], 0.08, [0.13, 0.14, 0.17])
    const z0 = s > 0 ? bz + 0.2 : bz - 1.6
    const z1 = s > 0 ? bz + 1.6 : bz - 0.2
    m.decal([bx - 0.05, base + 3.6, z0], [bx - 0.05, base + 3.6, z1], [bx - 0.05, base + 7.1, z1], [bx - 0.05, base + 7.1, z0], [-1, 0, 0], s > 0 ? "bannerA" : "bannerB", [0.6, 0.6, 0.6], MAT.decal)
    m.decal([bx + 0.05, base + 3.6, z1], [bx + 0.05, base + 3.6, z0], [bx + 0.05, base + 7.1, z0], [bx + 0.05, base + 7.1, z1], [1, 0, 0], s > 0 ? "bannerA" : "bannerB", [0.6, 0.6, 0.6], MAT.decal)
  }
  // RIVERDALE PLAZA sign wall at the south-west corner.
  const wx0 = p.x0 + 2
  const wz0 = p.z0 + 2
  slab(m, wx0, wx0 + 12, base, base + 2.2, wz0, wz0 + 1, [0.36, 0.32, 0.3], MAT.lit, SKIP.bottom, STONE)
  m.decal([wx0 + 11.6, base + 0.7, wz0 - 0.02], [wx0 + 0.4, base + 0.7, wz0 - 0.02], [wx0 + 0.4, base + 1.8, wz0 - 0.02], [wx0 + 11.6, base + 1.8, wz0 - 0.02], [0, 0, -1], "plaza", [1, 0.78, 0.45], MAT.neon)
  slab(m, wx0 - 0.4, wx0 + 12.4, base, base + 0.6, wz0 - 2.6, wz0, STONE, MAT.lit, SKIP.bottom, [0.12, 0.1, 0.09])
  for (let k = 0; k < 6; k++) m.prism(wx0 + 1 + k * 2, wz0 - 1.3, 0.75, 0.2, base + 0.6, base + 1.4, 6, shade(HEDGE, 1.2))
  lamps.push({ x: wx0 + 6, y: base + 0.6, z: wz0 - 3, small: true })
  // Movable furniture and roadworks are instanced by StreetProps on the lower pavement.
  void SIDEWALK
}
