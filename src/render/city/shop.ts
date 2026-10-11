import { CAMERA_YAW } from "../../../shared/config"
import { BAY_DEPTH, type Shop, SHOP_HEIGHT } from "../../../shared/sim/city"
import type { AtlasRegion } from "../atlas"
import { MAT, type Mat, type Mesh, type Rgb } from "../mesh"
import { cylinder, ground, mix, shade, SKIP, slab, Wall } from "./kit"
import { KERB_H } from "./streets"
import type { LampLight } from "./types"

const BLOCK: Rgb = [0.46, 0.44, 0.4]
const TRIM: Rgb = [0.16, 0.18, 0.22]
const ROOF: Rgb = [0.24, 0.24, 0.25]
const STRIPE: Rgb = [0.85, 0.6, 0.12]
const CONCRETE: Rgb = [0.33, 0.33, 0.34]
const PAINT: Rgb = [0.95, 0.72, 0.15]
const METAL: Rgb = [0.3, 0.31, 0.33]
const RUBBER: Rgb = [0.06, 0.06, 0.07]
const WARM: Rgb = [1, 0.74, 0.42]
const NEON: Rgb = [0.3, 1, 0.82]
/** Height of the roll-up door opening. */
const OPEN = 4

/**
 * A mechanic's garage on its lot: cinder-block walls with a yellow stripe, an open service bay under a roll-up door
 * (rolled up into its housing), a warmly lit interior with a tool wall, tool chest, tyre stack and oil drum, a painted
 * bay outline, a dropped apron across the sidewalk, AUTO REPAIR over the door and a vertical GARAGE neon with a wrench.
 */
export function shop(m: Mesh, s: Shop, lamps: LampLight[]) {
  const { lot } = s
  const side = Math.abs(Math.cos(s.h)) > 0.5 ? 0 : 2
  const W = Wall.of(lot.x0, lot.x1, lot.z0, lot.z1, side)
  const w = W.w
  const depth = side === 0 ? lot.z1 - lot.z0 : lot.x1 - lot.x0
  const along = (x: number, z: number) => (x - W.ox) * W.t[0] + (z - W.oz) * W.t[2]
  const us = [along(s.bay.x0, s.bay.z0), along(s.bay.x1, s.bay.z1)]
  const ub0 = Math.min(...us)
  const ub1 = Math.max(...us)
  const cu = (ub0 + ub1) / 2
  const H = SHOP_HEIGHT
  const BD = BAY_DEPTH
  // Axis-aligned box in lot coordinates: u along the street face, d into the lot.
  const box = (u0: number, u1: number, d0: number, d1: number, y0: number, y1: number, col: Rgb, mat: Mat = MAT.lit, skip: number = SKIP.bottom, top?: Rgb) => {
    const a = W.p(u0, 0, -d0)
    const b = W.p(u1, 0, -d1)
    slab(m, Math.min(a[0], b[0]), Math.max(a[0], b[0]), y0, y1, Math.min(a[2], b[2]), Math.max(a[2], b[2]), col, mat, skip, top)
  }
  const flat = (u0: number, u1: number, d0: number, d1: number, y: number, col: Rgb, mat: Mat = MAT.lit) => {
    const a = W.p(u0, 0, -d0)
    const b = W.p(u1, 0, -d1)
    ground(m, Math.min(a[0], b[0]), Math.max(a[0], b[0]), Math.min(a[2], b[2]), Math.max(a[2], b[2]), y, col, mat)
  }
  const at = (u: number, d: number): [number, number] => {
    const p = W.p(u, 0, -d)
    return [p[0], p[2]]
  }

  // Shell: the two side blocks beside the bay and the workshop behind it, each with a plinth and a coping band.
  for (const [u0, u1, d0, d1] of [
    [0, ub0, 0, BD],
    [ub1, w, 0, BD],
    [0, w, BD, depth],
  ] as const) {
    box(u0, u1, d0, d1, 0, H, BLOCK, MAT.lit, SKIP.bottom, ROOF)
    box(u0 - 0.1, u1 + 0.1, d0 - 0.1, d1 + 0.1, 0, 0.45, shade(BLOCK, 0.7), MAT.lit, SKIP.bottom | SKIP.top)
    box(u0 - 0.12, u1 + 0.12, d0 - 0.12, d1 + 0.12, H - 0.1, H + 0.35, TRIM, MAT.lit, SKIP.bottom, shade(TRIM, 1.4))
  }
  for (const [u0, u1] of [
    [0, ub0],
    [ub1, w],
  ] as const) {
    // Yellow stripe and a dark band under the coping on the street face.
    W.rect(m, u0, u1, 2.9, 3.2, 0.015, STRIPE)
    W.rect(m, u0, u1, H - 0.7, H - 0.1, 0.015, TRIM)
  }
  // Rooftop unit and a vent over the workshop.
  box(w * 0.55, w * 0.55 + 2.4, BD + 0.6, BD + 2.2, H, H + 1.3, METAL, MAT.lit, SKIP.bottom, shade(METAL, 1.15))
  const [vx, vz] = at(w * 0.25, BD + (depth - BD) / 2)
  cylinder(m, vx, vz, 0.25, H, H + 1, 6, METAL)

  // Office window and door on the street face of the wider side block.
  const officeLeft = ub0 >= w - ub1
  const [o0, o1] = officeLeft ? [0, ub0] : [ub1, w]
  if (o1 - o0 > 2.6) {
    const win0 = o0 + 0.6
    const win1 = o1 - (o1 - o0 > 4 ? 1.8 : 0.6)
    W.rect(m, win0, win1, 1.0, 2.6, 0.02, shade(WARM, 0.75), MAT.emissive)
    W.rect(m, win0, win1, 2.0, 2.06, 0.03, TRIM)
    for (let u = win0 + 1.1; u < win1 - 0.3; u += 1.1) W.rect(m, u - 0.04, u + 0.04, 1.0, 2.6, 0.03, TRIM)
    W.ledge(m, win0 - 0.1, win1 + 0.1, 0.86, 1.0, 0.12, shade(BLOCK, 0.8))
    if (o1 - o0 > 4) W.rect(m, win1 + 0.4, o1 - 0.4, 0.45, 2.5, 0.02, [0.14, 0.12, 0.11])
  }

  // Bay: concrete floor flush with the sidewalk, open to the sky so the fixed camera sees in. A lintel over the opening
  // carries the sign and the rolled-up door's housing; a canopy off the workshop shades the back of the bay.
  flat(ub0, ub1, 0, BD, KERB_H, CONCRETE)
  box(ub0, ub1, 0, 0.5, OPEN, H + 0.35, TRIM, MAT.lit, 0, shade(TRIM, 1.4))
  box(ub0 + 0.05, ub1 - 0.05, 0.5, 1.1, OPEN - 0.55, OPEN, METAL, MAT.lit, 0)
  for (const u of [ub0, ub1 - 0.14]) box(u, u + 0.14, 0, 0.6, 0, OPEN, METAL)
  W.decal(m, cu - 2.3, cu + 2.3, OPEN + 0.12, OPEN + 1.27, 0.04, "autoRepair", shade(NEON, 0.75), MAT.neon)
  box(ub0, ub1, BD - 3, BD, H - 0.45, H - 0.1, TRIM, MAT.lit, 0, ROOF)
  box(cu - 2, cu + 2, BD - 1.6, BD - 1.4, H - 0.62, H - 0.45, [1, 0.88, 0.66], MAT.emissive, 0)
  // Big lit window into the workshop at the back.
  W.rect(m, ub0 + 0.5, ub1 - 0.5, 1.0, 3.2, -BD + 0.02, shade(WARM, 0.7), MAT.emissive)
  for (let u = ub0 + 0.5 + 1.5; u < ub1 - 0.8; u += 1.5) W.rect(m, u - 0.05, u + 0.05, 1.0, 3.2, -BD + 0.04, TRIM)

  // The inner side wall that faces the camera gets the tool wall, the tool chest and a warm light bar along its top;
  // tyres and the oil drum stand against the other one.
  const toCam = [-Math.sin(CAMERA_YAW), -Math.cos(CAMERA_YAW)]
  const left = W.t[0] * toCam[0]! + W.t[2] * toCam[1]! > 0
  const wu = left ? ub0 : ub1
  const into = left ? 1 : -1
  const ou = left ? ub1 : ub0
  box(wu, wu + into * 0.04, 1.2, BD - 3.4, 1.1, 2.9, [0.42, 0.3, 0.2])
  for (let k = 0; k < 10; k++) {
    const d = 1.6 + k * 0.38
    if (d > BD - 3.7) break
    const len = 0.32 + (k % 5) * 0.07
    box(wu + into * 0.04, wu + into * 0.08, d - 0.04, d + 0.04, 2.6 - len, 2.6, k > 6 ? [0.6, 0.18, 0.12] : [0.62, 0.64, 0.68])
  }
  box(wu, wu + into * 0.15, 0.8, BD - 3.2, 3.45, 3.6, [1, 0.8, 0.5], MAT.emissive)
  const chest: Rgb = [0.62, 0.1, 0.08]
  box(wu + into * 0.02, wu + into * 0.72, 1.6, 3.0, KERB_H, KERB_H + 1.1, chest, MAT.lit, SKIP.bottom, shade(chest, 1.2))
  for (const y of [0.4, 0.65, 0.9]) box(wu + into * 0.72, wu + into * 0.74, 1.65, 2.95, KERB_H + y, KERB_H + y + 0.03, [0.2, 0.05, 0.04])
  const [dx, dz] = at(ou - into * 0.6, BD - 3.5)
  cylinder(m, dx, dz, 0.36, KERB_H, KERB_H + 0.95, 10, [0.12, 0.3, 0.62], MAT.lit, shade([0.12, 0.3, 0.62], 0.7))
  for (const y of [0.3, 0.65]) cylinder(m, dx, dz, 0.375, KERB_H + y, KERB_H + y + 0.05, 10, shade([0.12, 0.3, 0.62], 0.6))
  const [tx, tz] = at(ou - into * 0.6, BD - 4.6)
  for (let k = 0; k < 4; k++) {
    const y = KERB_H + k * 0.26
    cylinder(m, tx + (k % 2) * 0.04, tz, 0.42, y, y + 0.25, 10, RUBBER, MAT.lit, shade(RUBBER, 1.6))
  }
  m.disc(tx + 0.04, KERB_H + 1.045, tz, 0.2, 8, [0.05, 0.05, 0.05])
  const [sx, sz] = at(ou - into * 0.6, 1.6)
  for (let k = 0; k < 2; k++) cylinder(m, sx, sz, 0.42, KERB_H + k * 0.26, KERB_H + k * 0.26 + 0.25, 10, RUBBER, MAT.lit, shade(RUBBER, 1.6))

  // Painted bay outline and a stop bar.
  const y = KERB_H + 0.012
  const lw = 0.14
  flat(ub0 + 0.45, ub0 + 0.45 + lw, 0.3, BD - 0.4, y, PAINT, MAT.flat)
  flat(ub1 - 0.45 - lw, ub1 - 0.45, 0.3, BD - 0.4, y, PAINT, MAT.flat)
  flat(ub0 + 0.45, ub1 - 0.45, BD - 0.4 - lw, BD - 0.4, y, PAINT, MAT.flat)
  flat(ub0 + 1.4, ub1 - 1.4, BD - 2.4, BD - 2.1, y, shade(PAINT, 0.85), MAT.flat)
  // Dashed entry line across the opening.
  for (let u = ub0 + 0.6; u < ub1 - 0.6; u += 0.9) flat(u, Math.min(u + 0.5, ub1 - 0.6), 0.3, 0.3 + lw, y, PAINT, MAT.flat)
  // Dropped apron across the sidewalk.
  flat(ub0 - 1, ub1 + 1, -5, 0, KERB_H + 0.006, shade(CONCRETE, 1.1))
  for (const u of [ub0 - 1, ub1 + 0.9]) flat(u, u + 0.1, -5, 0, KERB_H + 0.01, shade(CONCRETE, 0.8))

  // Vertical neon: GARAGE on a blade off the front corner of the office block, a wrench at the top.
  blade(m, W, officeLeft ? 0.7 : w - 0.7, 1.6, H + 2.6, lamps)

  const [lx, lz] = at(cu, BD / 2)
  lamps.push({ x: lx, y: 3.4, z: lz })
}

/** A lit blade sign standing out from the wall with GARAGE down both faces and a wrench square on top. */
function blade(m: Mesh, W: Wall, u: number, y0: number, y1: number, lamps: LampLight[]) {
  const t = 0.36
  const d0 = 0.3
  const d1 = 1.7
  const glow = mix(shade(NEON, 0.1), [0.03, 0.03, 0.05], 0.5)
  const a = W.p(u - t / 2, 0, d0)
  const b = W.p(u + t / 2, 0, d1)
  slab(m, Math.min(a[0], b[0]), Math.max(a[0], b[0]), y0, y1, Math.min(a[2], b[2]), Math.max(a[2], b[2]), glow, MAT.emissive, 0)
  for (const y of [y0 + 0.5, y1 - 0.5]) {
    const p = W.p(u, y, 0)
    const q = W.p(u, y, d0)
    slab(m, Math.min(p[0], q[0]) - 0.05, Math.max(p[0], q[0]) + 0.05, y - 0.05, y + 0.05, Math.min(p[2], q[2]) - 0.05, Math.max(p[2], q[2]) + 0.05, TRIM)
  }
  const n = W.n
  const tt = W.t
  const letters = mix(NEON, [1, 1, 1], 0.3)
  const icon = y1 - (d1 - d0) - 0.15
  const face = (region: AtlasRegion, lo: number, hi: number, inset: number, col: Rgb) => {
    for (const s of [-1, 1]) {
      const off = s * (t / 2 + 0.02)
      const p = (d: number, yy: number) => [W.ox + tt[0] * (u + off) + n[0] * d, yy, W.oz + tt[2] * (u + off) + n[2] * d]
      const nn = [tt[0] * s, 0, tt[2] * s]
      if (s > 0) m.decal(p(d1 - inset, lo), p(d0 + inset, lo), p(d0 + inset, hi), p(d1 - inset, hi), nn, region, col, MAT.neon)
      else m.decal(p(d0 + inset, lo), p(d1 - inset, lo), p(d1 - inset, hi), p(d0 + inset, hi), nn, region, col, MAT.neon)
    }
  }
  face("garage", y0 + 0.2, icon - 0.1, 0.12, letters)
  face("wrench", icon, y1 - 0.1, 0.1, [1, 0.8, 0.35])
  // Tube edge along the outer side.
  const e0 = W.p(u - t / 2 - 0.03, 0, d1)
  const e1 = W.p(u + t / 2 + 0.03, 0, d1 + 0.06)
  slab(m, Math.min(e0[0], e1[0]), Math.max(e0[0], e1[0]), y0, y1, Math.min(e0[2], e1[2]), Math.max(e0[2], e1[2]), shade(NEON, 0.6), MAT.emissive, 0)
  const lp = W.p(u, (y0 + y1) / 2, 2.4)
  lamps.push({ x: lp[0], y: lp[1], z: lp[2], small: true })
}
