import { CELL, GRID, ROAD_HALF } from "../../../shared/config"
import type { Alley, City } from "../../../shared/sim/city"
import { MAT, type Mesh, type Rgb } from "../mesh"
import { ground, shade } from "./kit"

export const ASPHALT: Rgb = [0.15, 0.17, 0.23]
const ASPHALT_PATCH: Rgb = [0.13, 0.15, 0.2]
const ALLEY_TAR: Rgb = [0.12, 0.13, 0.17]
export const SIDEWALK: Rgb = [0.25, 0.25, 0.29]
const SEAM: Rgb = [0.21, 0.22, 0.26]
export const CURB: Rgb = [0.38, 0.38, 0.4]
const LINE: Rgb = [0.46, 0.46, 0.45]
export const KERB_H = 0.16
const R = 3

/** Asphalt, lane paint, crosswalks, and every block's raised sidewalk ring with rounded curbs. */
export function streets(m: Mesh, city: City, rng: () => number) {
  const lo = -ROAD_HALF
  const hi = GRID * CELL + ROAD_HALF
  ground(m, lo, hi, lo, hi, 0, ASPHALT)

  // Repair patches and manholes, so the asphalt is not one flat sheet.
  for (let k = 0; k <= GRID; k++)
    for (let s = 0; s < GRID; s++) {
      const c = k * CELL
      for (let p = 0; p < 3; p++) {
        const t = s * CELL + ROAD_HALF + 4 + rng() * (CELL - 2 * ROAD_HALF - 12)
        const off = (rng() - 0.5) * 10
        const pw = 1.5 + rng() * 3
        const pl = 2 + rng() * 5
        if (rng() < 0.5) ground(m, c + off - pw / 2, c + off + pw / 2, t, t + pl, 0.004, ASPHALT_PATCH, MAT.flat)
        else ground(m, t, t + pl, c + off - pw / 2, c + off + pw / 2, 0.004, ASPHALT_PATCH, MAT.flat)
      }
      const t = s * CELL + CELL / 2 + (rng() - 0.5) * 30
      m.disc(c + 3.5, 0.008, t, 0.5, 8, [0.1, 0.11, 0.13], MAT.flat)
      m.disc(t, 0.008, c - 3.5, 0.5, 8, [0.1, 0.11, 0.13], MAT.flat)
    }

  // Dashed centre lines, stop bars and zebra crosswalks.
  for (let k = 0; k <= GRID; k++)
    for (let s = 0; s < GRID; s++) {
      const c = k * CELL
      const a = s * CELL + ROAD_HALF + 5
      const b = (s + 1) * CELL - ROAD_HALF - 5
      for (let t = a + 1.5; t < b - 3; t += 7) {
        ground(m, c - 0.12, c + 0.12, t, t + 3.2, 0.012, LINE, MAT.flat)
        ground(m, t, t + 3.2, c - 0.12, c + 0.12, 0.012, LINE, MAT.flat)
      }
      for (const [z0, dir] of [
        [s * CELL + ROAD_HALF + 0.6, 1],
        [(s + 1) * CELL - ROAD_HALF - 3.6, -1],
      ] as const) {
        for (let x = c - ROAD_HALF + 0.9; x < c + ROAD_HALF - 0.8; x += 1.3) {
          ground(m, x, x + 0.7, z0, z0 + 3, 0.012, LINE, MAT.flat)
          ground(m, z0, z0 + 3, x, x + 0.7, 0.012, LINE, MAT.flat)
        }
        // Stop bar on the approaching lane.
        const sb = dir > 0 ? z0 + 3.8 : z0 - 0.8
        const lane = dir > 0 ? [c - ROAD_HALF + 0.6, c] : [c, c + ROAD_HALF - 0.6]
        ground(m, lane[0]!, lane[1]!, sb, sb + 0.45, 0.012, LINE, MAT.flat)
        const laneX = dir > 0 ? [c, c + ROAD_HALF - 0.6] : [c - ROAD_HALF + 0.6, c]
        ground(m, sb, sb + 0.45, laneX[0]!, laneX[1]!, 0.012, LINE, MAT.flat)
      }
    }

  // Alleys: darker tar with grime.
  for (const al of city.alleys) {
    ground(m, al.x0, al.x1, al.z0, al.z1, 0.01, ALLEY_TAR)
    const alongZ = al.z1 - al.z0 > al.x1 - al.x0
    const cx = (al.x0 + al.x1) / 2
    const cz = (al.z0 + al.z1) / 2
    if (alongZ) ground(m, cx - 0.2, cx + 0.2, al.z0 + 6, al.z1 - 6, 0.014, shade(ALLEY_TAR, 0.75), MAT.flat)
    else ground(m, al.x0 + 6, al.x1 - 6, cz - 0.2, cz + 0.2, 0.014, shade(ALLEY_TAR, 0.75), MAT.flat)
  }

  const parkSet = new Set(city.parks.map((p) => `${p.x0},${p.z0}`))
  const sw = city.sidewalk
  for (let i = 0; i < GRID; i++)
    for (let j = 0; j < GRID; j++) {
      const x0 = i * CELL + ROAD_HALF
      const x1 = (i + 1) * CELL - ROAD_HALF
      const z0 = j * CELL + ROAD_HALF
      const z1 = (j + 1) * CELL - ROAD_HALF
      const gaps = city.alleys.filter((a) => a.x0 >= x0 - 0.1 && a.x1 <= x1 + 0.1 && a.z0 >= z0 - 0.1 && a.z1 <= z1 + 0.1)
      sidewalkRing(m, x0, x1, z0, z1, parkSet.has(`${x0},${z0}`) ? 0 : sw, gaps)
      if (!parkSet.has(`${x0},${z0}`)) ground(m, x0 + sw, x1 - sw, z0 + sw, z1 - sw, 0.005, ALLEY_TAR)
    }
}

/**
 * Raised sidewalk ring around a block: rounded outer curb, paving with seams, broken where alleys cut through.
 * A width of 0 paves the whole block (parks, plazas).
 */
function sidewalkRing(m: Mesh, x0: number, x1: number, z0: number, z1: number, sw: number, gaps: Alley[]) {
  const y = KERB_H
  const full = sw <= 0
  const inner = full ? Math.min(x1 - x0, z1 - z0) / 2 : sw
  // Corners: quarter-circle fans from the inner corner.
  const corners = [
    [x0, z0, 1, 1],
    [x1, z0, -1, 1],
    [x1, z1, -1, -1],
    [x0, z1, 1, -1],
  ] as const
  const seg = 6
  for (const [cx, cz, sx, sz] of corners) {
    const ax = cx + sx * R
    const az = cz + sz * R
    const ix = cx + sx * inner
    const iz = cz + sz * inner
    const pts: number[][] = [[ix, y, cz]]
    for (let k = 0; k <= seg; k++) {
      const ang = (k / seg) * (Math.PI / 2)
      // From the point on the z edge round to the point on the x edge.
      pts.push([ax - sx * Math.sin(ang) * R, y, az - sz * Math.cos(ang) * R])
    }
    pts.push([cx, y, iz])
    const cen = [ix, y, iz]
    for (let k = 0; k < pts.length - 1; k++) tri(m, cen, pts[k]!, pts[k + 1]!, SIDEWALK)
    // Curb face and top band along the arc.
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * (Math.PI / 2)
      const a1 = ((k + 1) / seg) * (Math.PI / 2)
      const p0 = [ax - sx * Math.sin(a0) * R, az - sz * Math.cos(a0) * R]
      const p1 = [ax - sx * Math.sin(a1) * R, az - sz * Math.cos(a1) * R]
      if (sx * sz > 0) wallSeg(m, p0[0]!, p0[1]!, p1[0]!, p1[1]!, 0, y, CURB)
      else wallSeg(m, p1[0]!, p1[1]!, p0[0]!, p0[1]!, 0, y, CURB)
      const q0 = [ax - sx * Math.sin(a0) * (R - 0.32), az - sz * Math.cos(a0) * (R - 0.32)]
      const q1 = [ax - sx * Math.sin(a1) * (R - 0.32), az - sz * Math.cos(a1) * (R - 0.32)]
      tri(m, [p0[0]!, y + 0.004, p0[1]!], [p1[0]!, y + 0.004, p1[1]!], [q1[0]!, y + 0.004, q1[1]!], CURB)
      tri(m, [p0[0]!, y + 0.004, p0[1]!], [q1[0]!, y + 0.004, q1[1]!], [q0[0]!, y + 0.004, q0[1]!], CURB)
    }
  }
  // Straight sides, split around alley mouths.
  const sides = [
    { a: x0 + inner, b: x1 - inner, along: "x", edge: z0, out: -1 },
    { a: x0 + inner, b: x1 - inner, along: "x", edge: z1, out: 1 },
    { a: z0 + inner, b: z1 - inner, along: "z", edge: x0, out: -1 },
    { a: z0 + inner, b: z1 - inner, along: "z", edge: x1, out: 1 },
  ] as const
  for (const s of sides) {
    const cuts = gaps
      .filter((g) => (s.along === "x" ? (s.out < 0 ? g.z0 <= z0 + 0.1 : g.z1 >= z1 - 0.1) && g.x1 - g.x0 < 20 : (s.out < 0 ? g.x0 <= x0 + 0.1 : g.x1 >= x1 - 0.1) && g.z1 - g.z0 < 20))
      .map((g) => (s.along === "x" ? [g.x0, g.x1] : [g.z0, g.z1]) as [number, number])
      .sort((p, q) => p[0] - q[0])
    const runs: [number, number][] = []
    let t = s.a
    for (const [g0, g1] of cuts) {
      if (g0 > t) runs.push([t, g0])
      t = Math.max(t, g1)
    }
    if (s.b > t) runs.push([t, s.b])
    for (const [ra, rb] of runs) {
      const e = s.edge
      const ie = e - s.out * inner
      if (s.along === "x") {
        const [za, zb] = s.out < 0 ? [e, ie] : [ie, e]
        ground(m, ra, rb, za, zb, y, SIDEWALK)
        wallSeg(m, s.out < 0 ? rb : ra, e, s.out < 0 ? ra : rb, e, 0, y, CURB)
        const [ca, cb] = s.out < 0 ? [e, e + 0.32] : [e - 0.32, e]
        ground(m, ra, rb, ca, cb, y + 0.004, CURB)
        if (!full) for (let u = ra + 2.5; u < rb - 0.5; u += 2.5) ground(m, u, u + 0.05, Math.min(za, zb) + 0.32, Math.max(za, zb), y + 0.003, SEAM)
        if (!full) ground(m, ra, rb, (za + zb) / 2 - 0.025 + s.out * 0.16, (za + zb) / 2 + 0.025 + s.out * 0.16, y + 0.003, SEAM)
        // Curb faces at the ends of the run where an alley cuts through.
        if (ra > s.a + 0.01) wallSeg(m, ra, s.out < 0 ? e : ie, ra, s.out < 0 ? ie : e, 0, y, CURB)
        if (rb < s.b - 0.01) wallSeg(m, rb, s.out < 0 ? ie : e, rb, s.out < 0 ? e : ie, 0, y, CURB)
        if (!full) wallSeg(m, s.out < 0 ? ra : rb, ie, s.out < 0 ? rb : ra, ie, 0, y, shade(CURB, 0.8))
      } else {
        const [xa, xb] = s.out < 0 ? [e, ie] : [ie, e]
        ground(m, xa, xb, ra, rb, y, SIDEWALK)
        wallSeg(m, e, s.out < 0 ? ra : rb, e, s.out < 0 ? rb : ra, 0, y, CURB)
        const [ca, cb] = s.out < 0 ? [e, e + 0.32] : [e - 0.32, e]
        ground(m, ca, cb, ra, rb, y + 0.004, CURB)
        if (!full) for (let u = ra + 2.5; u < rb - 0.5; u += 2.5) ground(m, Math.min(xa, xb) + (s.out < 0 ? 0.32 : 0), Math.max(xa, xb) - (s.out > 0 ? 0.32 : 0), u, u + 0.05, y + 0.003, SEAM)
        if (ra > s.a + 0.01) wallSeg(m, s.out < 0 ? ie : e, ra, s.out < 0 ? e : ie, ra, 0, y, CURB)
        if (rb < s.b - 0.01) wallSeg(m, s.out < 0 ? e : ie, rb, s.out < 0 ? ie : e, rb, 0, y, CURB)
        if (!full) wallSeg(m, ie, s.out < 0 ? rb : ra, ie, s.out < 0 ? ra : rb, 0, y, shade(CURB, 0.8))
      }
    }
  }
  if (full) ground(m, x0 + inner - 0.01, x1 - inner + 0.01, z0 + inner - 0.01, z1 - inner + 0.01, y, SIDEWALK)
}

function tri(m: Mesh, a: number[], b: number[], c: number[], col: Rgb) {
  // Ground triangles always face up; fix the winding if needed.
  const cross = (b[0]! - a[0]!) * (c[2]! - a[2]!) - (b[2]! - a[2]!) * (c[0]! - a[0]!)
  if (cross > 0) m.tri(a, c, b, [0, 1, 0], col)
  else m.tri(a, b, c, [0, 1, 0], col)
}

/** Vertical wall segment, seen from the side where a is on the left and b on the right. */
export function wallSeg(m: Mesh, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, col: Rgb) {
  const dx = bx - ax
  const dz = bz - az
  const l = Math.hypot(dx, dz) || 1
  const n = [-dz / l, 0, dx / l]
  m.quad([ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az], n, col)
}
