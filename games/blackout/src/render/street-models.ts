import type { LightDef, MapDef, Prop, Wall } from "../../shared/maps"
import { FLOATS_PER_VERT, MAT, type Mat, Mesh, type Rgb } from "./mesh"
import { PAL, hex, rng } from "./models"

/** Downtown props drawn here (with access to the map's lights for their colours) rather than in models.ts. */
export const STREET_PROPS = new Set<Prop["kind"]>(["lamppost", "parklamp", "signal", "hydrant", "bench", "bin", "newsbox", "bollard", "tree", "shelter", "neon", "stool", "floodpole", "bags"])
/** Downtown wall styles drawn here. */
export const STREET_WALLS = new Set<Wall["style"]>(["building", "car", "dumpster", "barrier", "planter", "hedge", "fence", "fountain", "wreck", "hoarding", "subway"])

const METAL = hex(0x22252c)
const METAL_TOP = hex(0x30343e)

/** Rotates the vertices added since `from` by `yaw` around the origin, then moves them by (tx, ty, tz). */
function xform(m: Mesh, from: number, yaw: number, tx: number, ty: number, tz: number): void {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const x = m.v[i]!
    const z = m.v[i + 2]!
    m.v[i] = x * c - z * s + tx
    m.v[i + 1]! += ty
    m.v[i + 2] = x * s + z * c + tz
    const nx = m.v[i + 3]!
    const nz = m.v[i + 5]!
    m.v[i + 3] = nx * c - nz * s
    m.v[i + 5] = nx * s + nz * c
  }
}

/**
 * A quad whose normal points away from `inside` (no backface culling here, so a quad wound the wrong way would just
 * shade as if lit from behind).
 */
function outQuad(m: Mesh, inside: readonly number[], a: number[], b: number[], c: number[], d: number[], col: Rgb, mat: Mat = MAT.lit, aux = 0): void {
  const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]
  const w = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!]
  const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!]
  const mid = [(a[0]! + c[0]!) / 2 - inside[0]!, (a[1]! + c[1]!) / 2 - inside[1]!, (a[2]! + c[2]!) / 2 - inside[2]!]
  if (n[0]! * mid[0]! + n[1]! * mid[1]! + n[2]! * mid[2]! < 0) m.quadAuto(d, c, b, a, col, mat, aux)
  else m.quadAuto(a, b, c, d, col, mat, aux)
}

/** A low-poly blob of foliage: an irregular faceted ball, flat shaded in two greens. */
function blob(m: Mesh, cx: number, cy: number, cz: number, rx: number, ry: number, r: () => number, cols: readonly Rgb[], mat: Mat = MAT.lit): void {
  const rings = 3
  const segs = 7
  const pts: number[][][] = []
  for (let j = 0; j <= rings; j++) {
    const ring: number[][] = []
    const phi = (j / rings) * Math.PI
    for (let i = 0; i < segs; i++) {
      const th = (i / segs) * Math.PI * 2 + j * 0.45
      const k = j === 0 || j === rings ? 1 : 0.82 + r() * 0.36
      ring.push([cx + Math.sin(phi) * Math.cos(th) * rx * k, cy + Math.cos(phi) * ry * (j === rings ? 0.75 : 1), cz + Math.sin(phi) * Math.sin(th) * rx * k])
    }
    pts.push(ring)
  }
  let n = 0
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = pts[j]![i]!
      const b = pts[j]![(i + 1) % segs]!
      const c = pts[j + 1]![(i + 1) % segs]!
      const d = pts[j + 1]![i]!
      const col = cols[(n++ + j) % cols.length]!
      if (j > 0) m.facet(a, c, b, col, mat)
      if (j < rings - 1 || true) m.facet(a, d, c, cols[(n + 1) % cols.length]!, mat)
    }
}

const LEAVES: readonly Rgb[] = [hex(0x2f5a32), hex(0x3d7040), hex(0x26482a), hex(0x4a7c3e)]

// Stroke font for neon signs: segments on a 4 x 6 grid, y up.
const GLYPHS: Record<string, number[][]> = {
  A: [[0, 0, 0, 4], [0, 4, 2, 6], [2, 6, 4, 4], [4, 4, 4, 0], [0, 3, 4, 3]],
  B: [[0, 0, 0, 6], [0, 6, 3, 6], [3, 6, 4, 5], [4, 5, 4, 4], [4, 4, 3, 3], [0, 3, 3, 3], [3, 3, 4, 2], [4, 2, 4, 1], [4, 1, 3, 0], [3, 0, 0, 0]],
  C: [[4, 6, 0, 6], [0, 6, 0, 0], [0, 0, 4, 0]],
  D: [[0, 0, 0, 6], [0, 6, 2.5, 6], [2.5, 6, 4, 4.5], [4, 4.5, 4, 1.5], [4, 1.5, 2.5, 0], [2.5, 0, 0, 0]],
  E: [[4, 6, 0, 6], [0, 6, 0, 0], [0, 0, 4, 0], [0, 3, 3, 3]],
  F: [[4, 6, 0, 6], [0, 6, 0, 0], [0, 3, 3, 3]],
  G: [[4, 6, 0, 6], [0, 6, 0, 0], [0, 0, 4, 0], [4, 0, 4, 3], [4, 3, 2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[2, 0, 2, 6], [1, 6, 3, 6], [1, 0, 3, 0]],
  K: [[0, 0, 0, 6], [4, 6, 0, 3], [0, 3, 4, 0]],
  L: [[0, 6, 0, 0], [0, 0, 4, 0]],
  M: [[0, 0, 0, 6], [0, 6, 2, 3], [2, 3, 4, 6], [4, 6, 4, 0]],
  N: [[0, 0, 0, 6], [0, 6, 4, 0], [4, 0, 4, 6]],
  O: [[0, 0, 0, 6], [0, 6, 4, 6], [4, 6, 4, 0], [4, 0, 0, 0]],
  P: [[0, 0, 0, 6], [0, 6, 4, 6], [4, 6, 4, 3], [4, 3, 0, 3]],
  R: [[0, 0, 0, 6], [0, 6, 4, 6], [4, 6, 4, 3], [4, 3, 0, 3], [1.5, 3, 4, 0]],
  S: [[4, 6, 0, 6], [0, 6, 0, 3], [0, 3, 4, 3], [4, 3, 4, 0], [4, 0, 0, 0]],
  T: [[0, 6, 4, 6], [2, 6, 2, 0]],
  U: [[0, 6, 0, 0], [0, 0, 4, 0], [4, 0, 4, 6]],
  V: [[0, 6, 2, 0], [2, 0, 4, 6]],
  W: [[0, 6, 1, 0], [1, 0, 2, 3], [2, 3, 3, 0], [3, 0, 4, 6]],
  Y: [[0, 6, 2, 3], [4, 6, 2, 3], [2, 3, 2, 0]],
  Z: [[0, 6, 4, 6], [4, 6, 0, 0], [0, 0, 4, 0]],
  "2": [[0, 6, 4, 6], [4, 6, 4, 3], [4, 3, 0, 3], [0, 3, 0, 0], [0, 0, 4, 0]],
  "4": [[0, 6, 0, 3], [0, 3, 4, 3], [3, 6, 3, 0]],
  "7": [[0, 6, 4, 6], [4, 6, 1, 0]],
  "/": [[0, 0, 4, 6]],
}

/**
 * Glowing letters on a board leaning back from a facade so they read from above: in the prop's frame the facade is
 * at z = -hd, the board's foot sits out from it at height y0, and `text` runs along +x.
 */
function neonText(m: Mesh, text: string, hw: number, hd: number, y0: number, col: Rgb, mat: Mat, aux: number, flip: boolean): void {
  const unit = Math.min(0.12, (hw * 2 - 0.2) / Math.max(1, text.length * 5.6 - 1.6))
  const total = (text.length * 5.6 - 1.6) * unit
  const tilt = 0.55
  const up = [0, Math.cos(tilt), -Math.sin(tilt)]
  const nrm = [0, Math.sin(tilt), Math.cos(tilt)]
  const out = 0.25 + (6 * unit + 0.16) * Math.sin(tilt)
  const foot = [0, y0, -hd + out]
  const P = (a: number, b: number, out: number) => [foot[0]! + a, foot[1]! + up[1]! * b + nrm[1]! * out, foot[2]! + up[2]! * b + nrm[2]! * out]
  const boardH = 6 * unit + 0.16
  // Dark backing board with a rim, then the tubes just in front of it.
  m.quad(P(-total / 2 - 0.1, -0.08, 0), P(total / 2 + 0.1, -0.08, 0), P(total / 2 + 0.1, boardH - 0.08, 0), P(-total / 2 - 0.1, boardH - 0.08, 0), nrm, hex(0x0d0f16), MAT.lit)
  // Brackets back to the facade.
  for (const sx of [-1, 1]) m.box(sx * (total / 2) - 0.02, y0 - 0.02, -hd, sx * (total / 2) + 0.02, y0 + 0.02, -hd + out, METAL)
  const w = unit * 0.9
  let x = -total / 2
  for (const ch of text) {
    for (const s of GLYPHS[ch] ?? []) {
      const [a0, b0, a1, b1] = s as [number, number, number, number]
      // Facing away from the camera, the whole line turns half round in the board so it still reads from above.
      const fx = (u: number) => (flip ? -u : u)
      const fy = (v: number) => (flip ? 6 * unit - v : v)
      const ax0 = fx(x + a0 * unit)
      const ay0 = fy(b0 * unit)
      const ax1 = fx(x + a1 * unit)
      const ay1 = fy(b1 * unit)
      const dx = ax1 - ax0
      const dy = ay1 - ay0
      const l = Math.hypot(dx, dy) || 1
      const px = (-dy / l) * (w / 2)
      const py = (dx / l) * (w / 2)
      // Extend each stroke by half its width so joints close.
      const ex = (dx / l) * (w / 2)
      const ey = (dy / l) * (w / 2)
      m.quad(P(ax0 - ex + px, ay0 - ey + py, 0.012), P(ax0 - ex - px, ay0 - ey - py, 0.012), P(ax1 + ex - px, ay1 + ey - py, 0.012), P(ax1 + ex + px, ay1 + ey + py, 0.012), nrm, col, mat, aux)
    }
    x += 5.6 * unit
  }
}

/** Builds a downtown prop into `m` at its place on the plan. Models face +z at rot 0, like models.ts. */
export function streetProp(m: Mesh, p: Prop, seed: number, map: MapDef): void {
  const from = m.length
  const rw = p.rect[2] - p.rect[0]
  const rd = p.rect[3] - p.rect[1]
  const w = p.rot % 2 === 0 ? rw : rd
  const d = p.rot % 2 === 0 ? rd : rw
  const hw = w / 2
  const hd = d / 2
  const r = rng(seed)
  const light: LightDef | undefined = p.light !== undefined ? map.lights[p.light] : undefined
  const lamp = (col: Rgb): [Mat, number, Rgb] => (light ? [MAT.lamp, light.id, col] : [MAT.glow, 1.5, col])
  switch (p.kind) {
    case "lamppost": {
      // Pole at the curb, an arm out over the road, a lantern hanging from it (the light sits under the lantern).
      m.prism(0, 0, 0.16, 0.12, 0, 0.45, 8, METAL)
      m.prism(0, 0, 0.065, 0.05, 0.45, 5.35, 8, METAL)
      m.box(-0.035, 5.25, 0, 0.035, 5.33, 1.25, METAL, MAT.lit, 0, METAL_TOP)
      const [mat, aux] = lamp(hex(0xffc070))
      m.prism(0, 1.25, 0.2, 0.03, 5.2, 5.42, 4, METAL, MAT.lit, 0, true, Math.PI / 4)
      m.prism(0, 1.25, 0.15, 0.12, 4.92, 5.2, 4, hex(0xffcf88), mat, aux, false, Math.PI / 4)
      m.prism(0, 1.25, 0.12, 0.12, 4.9, 4.93, 4, hex(0xfff0d0), mat, aux, true, Math.PI / 4)
      break
    }
    case "parklamp": {
      m.prism(0, 0, 0.17, 0.12, 0, 0.4, 8, METAL)
      m.prism(0, 0, 0.06, 0.05, 0.4, 3.95, 8, METAL)
      const [mat, aux] = lamp(hex(0xffc878))
      m.prism(0, 0, 0.12, 0.17, 3.95, 4.05, 6, METAL)
      m.prism(0, 0, 0.15, 0.17, 4.05, 4.45, 6, hex(0xffd090), mat, aux, false)
      m.prism(0, 0, 0.22, 0.02, 4.45, 4.62, 6, METAL)
      break
    }
    case "floodpole": {
      const top = light?.h ?? 6
      m.prism(0, 0, 0.2, 0.15, 0, 0.5, 8, METAL)
      m.prism(0, 0, 0.08, 0.06, 0.5, top + 0.1, 8, METAL)
      m.box(-0.5, top, -0.05, 0.5, top + 0.08, 0.05, METAL)
      const [mat, aux] = lamp(hex(0xe8f0ff))
      for (const sx of [-1, 1]) {
        m.bevelBox(sx * 0.35 - 0.16, top - 0.08, -0.14, sx * 0.35 + 0.16, top + 0.2, 0.14, 0.02, METAL, METAL_TOP)
        m.box(sx * 0.35 - 0.13, top - 0.1, -0.11, sx * 0.35 + 0.13, top - 0.07, 0.11, hex(0xeef4ff), mat, aux, undefined, true)
      }
      break
    }
    case "signal": {
      // Pole with a head facing +z and one facing -x; the +z head shows this light's colour, the other the opposite.
      m.prism(0, 0, 0.12, 0.1, 0, 0.3, 8, METAL)
      m.prism(0, 0, 0.055, 0.05, 0.3, 3.65, 8, METAL)
      const red = !light || light.color[0] > light.color[1]
      const head = (yaw: number, lit: "red" | "green", mat: Mat, aux: number) => {
        const f = m.length
        m.bevelBox(-0.15, 2.65, 0.06, 0.15, 3.55, 0.32, 0.03, hex(0x1a1c22), hex(0x262a33))
        const lens = (y: number, on: boolean, col: number) => m.box(-0.08, y - 0.08, 0.32, 0.08, y + 0.08, 0.35, on ? hex(col) : hex(0x15161a), on ? mat : MAT.lit, on ? aux : 0)
        lens(3.36, lit === "red", 0xff2a1a)
        lens(3.1, false, 0xffb020)
        lens(2.84, lit === "green", 0x30ff80)
        // Visors over the lenses catch the glow from above.
        for (const y of [3.45, 3.19, 2.93]) m.box(-0.1, y, 0.32, 0.1, y + 0.02, 0.42, hex(0x101114))
        xform(m, f, yaw, 0, 0, 0)
      }
      const [mat, aux] = lamp(hex(0xffffff))
      head(0, red ? "red" : "green", mat, aux)
      head(Math.PI / 2, red ? "green" : "red", MAT.glow, 2.4)
      break
    }
    case "hydrant": {
      const red = hex(0xb4231c)
      m.prism(0, 0, 0.14, 0.14, 0, 0.06, 8, red, MAT.shiny)
      m.prism(0, 0, 0.1, 0.09, 0.06, 0.5, 8, red, MAT.shiny)
      m.prism(0, 0, 0.12, 0.12, 0.42, 0.47, 8, hex(0x8a1a14), MAT.shiny)
      m.prism(0, 0, 0.09, 0.02, 0.5, 0.62, 8, red, MAT.shiny)
      m.box(-0.17, 0.26, -0.04, 0.17, 0.33, 0.04, hex(0xc8c0b0), MAT.shiny)
      m.box(-0.04, 0.26, 0, 0.04, 0.33, 0.15, red, MAT.shiny)
      break
    }
    case "bench": {
      const wood = hex(0x5c4030)
      const woodTop = hex(0x6e5038)
      for (const sx of [-1, 1]) {
        m.box(sx * (hw - 0.12) - 0.03, 0, -hd + 0.05, sx * (hw - 0.12) + 0.03, 0.42, hd - 0.08, METAL)
        m.box(sx * (hw - 0.12) - 0.03, 0.42, -hd + 0.05, sx * (hw - 0.12) + 0.03, 0.88, -hd + 0.12, METAL)
      }
      for (let k = 0; k < 3; k++) {
        const z = -hd + 0.14 + k * ((d - 0.3) / 3)
        m.box(-hw + 0.04, 0.42, z, hw - 0.04, 0.46, z + (d - 0.3) / 3 - 0.03, wood, MAT.lit, 0, woodTop)
      }
      for (let k = 0; k < 2; k++) m.box(-hw + 0.04, 0.56 + k * 0.17, -hd + 0.04, hw - 0.04, 0.68 + k * 0.17, -hd + 0.09, wood, MAT.lit, 0, woodTop)
      break
    }
    case "bin": {
      m.prism(0, 0, 0.21, 0.23, 0, 0.88, 8, hex(0x22342a))
      m.prism(0, 0, 0.24, 0.24, 0.84, 0.9, 8, hex(0x2c4434))
      m.prism(0, 0, 0.17, 0.17, 0.9, 0.91, 8, hex(0x0e1210))
      break
    }
    case "newsbox": {
      const col = [hex(0x2a4a9a), hex(0xa02a2a), hex(0xb89a2a), hex(0x2a6a4a)][Math.floor(r() * 4)]!
      m.box(-0.04, 0, -0.04, 0.04, 0.45, 0.04, METAL)
      m.bevelBox(-hw + 0.02, 0.45, -hd + 0.02, hw - 0.02, 1.05, hd - 0.02, 0.02, col, col, MAT.shiny)
      m.box(-hw + 0.06, 0.62, hd - 0.02, hw - 0.06, 0.92, hd - 0.005, hex(0xd8d8d0), MAT.lit)
      m.box(-hw + 0.08, 0.66, hd - 0.005, -hw + 0.3, 0.7, hd, hex(0x222222))
      break
    }
    case "bollard": {
      m.prism(0, 0, 0.1, 0.09, 0, 0.85, 8, METAL)
      m.prism(0, 0, 0.1, 0.1, 0.7, 0.76, 8, hex(0xc8a030), MAT.shiny)
      break
    }
    case "tree": {
      // A grated tree pit, a slim trunk, two or three faceted clumps of leaves.
      m.box(-0.55, 0, -0.55, 0.55, 0.015, 0.55, hex(0x15171c))
      for (let k = -2; k <= 2; k++) m.box(-0.5, 0.015, k * 0.2 - 0.02, 0.5, 0.025, k * 0.2 + 0.02, hex(0x2a2d34))
      const brown = hex(0x3a2c22)
      m.prism(0, 0, 0.1, 0.07, 0, 2.1, 6, brown)
      const yaw = r() * 6
      m.prism(Math.cos(yaw) * 0.25, Math.sin(yaw) * 0.25, 0.04, 0.03, 1.5, 2.3, 5, brown)
      const s = 0.85 + r() * 0.3
      blob(m, 0, 2.7 * s, 0, 1.25 * s, 0.95 * s, r, LEAVES, MAT.wall)
      blob(m, Math.cos(yaw) * 0.55, 2.35 * s, Math.sin(yaw) * 0.55, 0.85 * s, 0.7 * s, r, [LEAVES[1]!, LEAVES[3]!, LEAVES[0]!], MAT.wall)
      if (r() < 0.6) blob(m, -Math.cos(yaw) * 0.4, 3.2 * s, -Math.sin(yaw) * 0.45, 0.7 * s, 0.55 * s, r, [LEAVES[3]!, LEAVES[1]!], MAT.wall)
      break
    }
    case "shelter": {
      // Open toward the road (+z): posts, a glass roof on a dark frame, a bench along the back, an advert at one end.
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) m.box(sx * (hw - 0.06) - 0.04, 0, sz * (hd - 0.06) - 0.04, sx * (hw - 0.06) + 0.04, 2.35, sz * (hd - 0.06) + 0.04, METAL)
      m.bevelBox(-hw - 0.1, 2.35, -hd - 0.05, hw + 0.1, 2.45, hd + 0.15, 0.03, METAL, hex(0x2a3446), MAT.wall)
      m.box(-hw + 0.1, 2.45, -hd + 0.05, hw - 0.1, 2.46, hd + 0.05, hex(0x3a4a66), MAT.wall)
      m.box(-hw + 0.2, 0.42, -hd + 0.12, hw - 0.6, 0.47, -hd + 0.45, hex(0x6a707c), MAT.shiny)
      for (const sx of [-1, 1]) m.box(sx * (hw * 0.5) - 0.03, 0, -hd + 0.15, sx * (hw * 0.5) + 0.03, 0.42, -hd + 0.4, METAL)
      const ad = r() < 0.5 ? hex(0xff4aa0) : hex(0x5ab8ff)
      m.box(hw - 0.14, 0.3, -hd + 0.15, hw - 0.04, 2.1, hd - 0.15, METAL)
      m.box(hw - 0.16, 0.4, -hd + 0.22, hw - 0.145, 2.0, hd - 0.22, ad, MAT.glow, 1.6)
      m.box(hw - 0.035, 0.4, -hd + 0.22, hw - 0.02, 2.0, hd - 0.22, ad, MAT.glow, 1.6)
      break
    }
    case "neon": {
      const col: Rgb = light ? [light.color[0], light.color[1], light.color[2]] : hex(0xff40c0)
      const [mat, aux] = lamp(col)
      neonText(m, p.text ?? "OPEN", hw, hd, 2.55, col, mat, aux, p.rot === 2)
      break
    }
    case "stool": {
      m.prism(0, 0, 0.17, 0.15, 0, 0.03, 8, METAL)
      m.prism(0, 0, 0.03, 0.03, 0.03, 0.7, 6, PAL.steel, MAT.shiny)
      m.prism(0, 0, 0.18, 0.18, 0.7, 0.78, 8, hex(0x8a2a2a), MAT.shiny)
      break
    }
    case "bags": {
      for (let k = 0; k < 3; k++) {
        const x = (k - 1) * hw * 0.6 + (r() - 0.5) * 0.1
        const z = (r() - 0.5) * (d - 0.4)
        const s = 0.22 + r() * 0.1
        m.prism(x, z, s, s * 0.6, 0, s * 1.3, 5, hex(0x111317), MAT.shiny, 0, true, r() * 3)
        m.prism(x, z, s * 0.6, 0.04, s * 1.3, s * 1.7, 5, hex(0x111317), MAT.shiny, 0, true, r() * 3)
      }
      break
    }
    default:
      m.box(-hw, 0, -hd, hw, 0.8, hd, PAL.cabinet)
  }
  m.place(from, p.rot, (p.rect[0] + p.rect[2]) / 2, 0, (p.rect[1] + p.rect[3]) / 2)
}

// Walls -----------------------------------------------------------------------------------------------------------------

const FACADES: readonly [Rgb, Rgb][] = [
  [hex(0x5a3c34), hex(0x4a302a)],
  [hex(0x4c4440), hex(0x3c3532)],
  [hex(0x56595f), hex(0x45484e)],
  [hex(0x3c4452), hex(0x2e3542)],
  [hex(0x645646), hex(0x524638)],
  [hex(0x3a3b40), hex(0x2c2d32)],
]
const CAR_COLS = [0x702224, 0x243258, 0x8a8e96, 0x26272c, 0x2e4e42, 0xa8aaa6, 0x5a3e26, 0x3c5a78].map(hex)

/** Downtown walls: buildings, cars and street cover. */
export function streetWall(m: Mesh, w: Wall, i: number, seed: number): void {
  const [x0, z0, x1, z1] = w.rect
  const v = w.v ?? i
  switch (w.style) {
    case "building":
      return building(m, w, v, seed)
    case "car":
      return car(m, w, v)
    case "wreck":
      return wreck(m, w, v, seed + i)
    case "dumpster": {
      const r = rng(v + 7)
      const col = [hex(0x2c4a36), hex(0x2a3a5a), hex(0x4a4c50)][Math.floor(r() * 3)]!
      const ax = x1 - x0 >= z1 - z0
      const IN = [(x0 + x1) / 2, 0.3, (z0 + z1) / 2]
      m.box(x0 + 0.05, 0.12, z0 + 0.05, x1 - 0.05, w.h - 0.18, z1 - 0.05, col, MAT.wall)
      for (const [cx, cz] of [[x0 + 0.2, z0 + 0.2], [x1 - 0.2, z0 + 0.2], [x0 + 0.2, z1 - 0.2], [x1 - 0.2, z1 - 0.2]]) m.box(cx! - 0.06, 0, cz! - 0.06, cx! + 0.06, 0.14, cz! + 0.06, METAL)
      // Rim and a sloped lid in two halves, one propped open.
      m.box(x0, w.h - 0.22, z0, x1, w.h - 0.16, z1, hex(0x1a1c20), MAT.wall)
      const open = r() < 0.4
      if (ax) {
        outQuad(m, IN, [x0, w.h - 0.16, z1], [(x0 + x1) / 2, w.h - 0.16, z1], [(x0 + x1) / 2, w.h, z0], [x0, w.h, z0], hex(0x1e2a22), MAT.wall)
        if (open) outQuad(m, IN, [(x0 + x1) / 2, w.h - 0.16, z0], [(x0 + x1) / 2, w.h + 0.6, z0 - 0.15], [x1, w.h + 0.6, z0 - 0.15], [x1, w.h - 0.16, z0], hex(0x1e2a22), MAT.wall)
        else outQuad(m, IN, [(x0 + x1) / 2, w.h - 0.16, z1], [x1, w.h - 0.16, z1], [x1, w.h, z0], [(x0 + x1) / 2, w.h, z0], hex(0x223026), MAT.wall)
      } else {
        outQuad(m, IN, [x1, w.h - 0.16, z0], [x1, w.h - 0.16, (z0 + z1) / 2], [x0, w.h, (z0 + z1) / 2], [x0, w.h, z0], hex(0x1e2a22), MAT.wall)
        outQuad(m, IN, [x1, w.h - 0.16, (z0 + z1) / 2], [x1, w.h - 0.16, z1], [x0, w.h, z1], [x0, w.h, (z0 + z1) / 2], hex(0x223026), MAT.wall)
      }
      return
    }
    case "barrier": {
      // Jersey barriers: a sloped concrete profile in 2 m sections with reflective stripes.
      const ax = x1 - x0 >= z1 - z0
      const L = ax ? x1 - x0 : z1 - z0
      const n = Math.max(1, Math.round(L / 2))
      for (let k = 0; k < n; k++) {
        const a = (ax ? x0 : z0) + (k * L) / n + 0.03
        const b = (ax ? x0 : z0) + ((k + 1) * L) / n - 0.03
        const c = ax ? (z0 + z1) / 2 : (x0 + x1) / 2
        const half = ((ax ? z1 - z0 : x1 - x0) / 2) * 0.95
        const col = hex(0x8c8c86)
        const P = (u: number, y: number, s: number) => (ax ? [u, y, c + s] : [c + s, y, u])
        for (const s of [-1, 1]) {
          const q = (u0: number, u1: number, y0: number, y1: number, w0: number, w1: number, cc: Rgb) => (s > 0 ? outQuad(m, [ax ? (a + b) / 2 : c, 0, ax ? c : (a + b) / 2], P(u0, y0, w0), P(u1, y0, w0), P(u1, y1, w1), P(u0, y1, w1), cc, MAT.wall) : outQuad(m, [ax ? (a + b) / 2 : c, 0, ax ? c : (a + b) / 2], P(u1, y0, -w0), P(u0, y0, -w0), P(u0, y1, -w1), P(u1, y1, -w1), cc, MAT.wall))
          q(a, b, 0, 0.12, half, half, col)
          q(a, b, 0.12, 0.3, half, half * 0.45, col)
          q(a, b, 0.3, w.h, half * 0.45, half * 0.3, k % 2 ? hex(0xc85a1a) : hex(0xd8d8d0))
        }
        const t0 = P(a, w.h, -half * 0.3)
        const t1 = P(b, w.h, half * 0.3)
        m.box(Math.min(t0[0]!, t1[0]!), w.h - 0.01, Math.min(t0[2]!, t1[2]!), Math.max(t0[0]!, t1[0]!), w.h, Math.max(t0[2]!, t1[2]!), hex(0x9a9a94), MAT.wall)
        for (const u of [a, b]) {
          const e0 = P(u - (u === a ? 0 : 0.001), 0, -half)
          const e1 = P(u + (u === a ? 0.001 : 0), w.h, half)
          m.box(Math.min(e0[0]!, e1[0]!), 0, Math.min(e0[2]!, e1[2]!), Math.max(e0[0]!, e1[0]!) + (ax ? 0 : 0), w.h * 0.98, Math.max(e0[2]!, e1[2]!), hex(0x7a7a74), MAT.wall)
        }
      }
      return
    }
    case "planter": {
      const r = rng(v + 3)
      m.bevelBox(x0, 0, z0, x1, w.h, z1, 0.04, hex(0x6c6c68), hex(0x82827c), MAT.wall)
      m.box(x0 + 0.08, w.h - 0.06, z0 + 0.08, x1 - 0.08, w.h + 0.005, z1 - 0.08, hex(0x2a2018))
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      const s = Math.min(x1 - x0, z1 - z0) / 2
      if (r() < 0.5) {
        m.prism(cx, cz, 0.07, 0.05, w.h, w.h + 1.4, 6, hex(0x3a2c22))
        blob(m, cx, w.h + 1.9, cz, s * 1.4, s * 1.1, r, LEAVES, MAT.wall)
      } else {
        blob(m, cx - s * 0.25, w.h + 0.35, cz, s * 0.7, s * 0.45, r, LEAVES)
        blob(m, cx + s * 0.3, w.h + 0.3, cz + s * 0.2, s * 0.55, s * 0.4, r, [LEAVES[3]!, LEAVES[1]!])
      }
      return
    }
    case "hedge": {
      const r = rng(i * 13 + seed)
      m.box(x0, 0, z0, x1, w.h * 0.8, z1, hex(0x22402a), MAT.wall)
      const ax = x1 - x0 >= z1 - z0
      const L = ax ? x1 - x0 : z1 - z0
      const th = ax ? z1 - z0 : x1 - x0
      for (let u = 0.3; u < L; u += 0.6) {
        const c = (ax ? x0 : z0) + u
        const s = th * (0.55 + r() * 0.15)
        blob(m, ax ? c : (x0 + x1) / 2, w.h * 0.82, ax ? (z0 + z1) / 2 : c, s, th * 0.35, r, [hex(0x2a5030), hex(0x346038), hex(0x24462a)], MAT.wall)
      }
      return
    }
    case "fence": {
      // Chain-link: posts, rails, and a mesh of thin wires.
      const ax = x1 - x0 >= z1 - z0
      const L = ax ? x1 - x0 : z1 - z0
      const c = ax ? (z0 + z1) / 2 : (x0 + x1) / 2
      const B = (u0: number, u1: number, y0: number, y1: number, t: number, col: Rgb) => (ax ? m.box((ax ? x0 : 0) + u0, y0, c - t, x0 + u1, y1, c + t, col, MAT.wall) : m.box(c - t, y0, z0 + u0, c + t, y1, z0 + u1, col, MAT.wall))
      for (let u = 0; u <= L + 0.01; u += Math.max(0.5, L / Math.max(1, Math.round(L / 2.4)))) B(Math.max(0, u - 0.035), Math.min(L, u + 0.035), 0, w.h + 0.05, 0.035, METAL)
      B(0, L, w.h - 0.03, w.h + 0.01, 0.025, hex(0x4a4e58))
      B(0, L, 0.08, 0.11, 0.015, hex(0x4a4e58))
      for (let u = 0.12; u < L; u += 0.22) B(u - 0.007, u + 0.007, 0.1, w.h - 0.02, 0.006, hex(0x50555e))
      for (let y = 0.35; y < w.h - 0.1; y += 0.27) B(0, L, y - 0.006, y + 0.006, 0.006, hex(0x50555e))
      return
    }
    case "fountain": {
      const cx = (x0 + x1) / 2
      const cz = (z0 + z1) / 2
      const R = Math.min(x1 - x0, z1 - z0) / 2
      const stone = hex(0x4a4e58)
      m.prism(cx, cz, R, R, 0, 0.55, 14, stone, MAT.wall, 0, false)
      m.prism(cx, cz, R + 0.04, R + 0.04, 0.55, 0.65, 14, hex(0x5a5e68), MAT.wall, 0, false)
      m.prism(cx, cz, R - 0.25, R - 0.25, 0.36, 0.65, 14, hex(0x2a3a48), MAT.wall, 0, false)
      // The rim's top: a ring of quads, so the water inside stays visible.
      for (let k = 0; k < 14; k++) {
        const a0 = (k / 14) * Math.PI * 2
        const a1 = ((k + 1) / 14) * Math.PI * 2
        const P = (a: number, r: number) => [cx + Math.cos(a) * r, 0.65, cz + Math.sin(a) * r]
        m.quad(P(a0, R - 0.25), P(a0, R + 0.04), P(a1, R + 0.04), P(a1, R - 0.25), [0, 1, 0], hex(0x6a6e78), MAT.wall)
      }
      // Dark water lit from below: rings of brighter ripples round the jets.
      m.prism(cx, cz, R - 0.25, R - 0.25, 0.36, 0.37, 14, hex(0x0c3a5a), MAT.glow, 0.8)
      for (const rr of [R * 0.55, R * 0.75]) m.prism(cx, cz, rr, rr, 0.371, 0.372, 14, hex(0x2a9ad0), MAT.glow, 0.9, false)
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2
        m.box(cx + Math.cos(a) * (R - 0.45) - 0.05, 0.37, cz + Math.sin(a) * (R - 0.45) - 0.05, cx + Math.cos(a) * (R - 0.45) + 0.05, 0.4, cz + Math.sin(a) * (R - 0.45) + 0.05, hex(0x9af0ff), MAT.glow, 3)
      }
      m.prism(cx, cz, R * 0.42, R * 0.38, 0.37, 0.75, 10, stone, MAT.wall)
      m.prism(cx, cz, R * 0.32, R * 0.32, 0.75, 0.76, 10, hex(0x30b8f0), MAT.glow, 1.2)
      m.prism(cx, cz, 0.13, 0.1, 0.75, 1.45, 8, stone, MAT.wall)
      m.prism(cx, cz, 0.42, 0.32, 1.38, 1.52, 10, stone, MAT.wall)
      m.prism(cx, cz, 0.3, 0.3, 1.52, 1.53, 10, hex(0x40c8ff), MAT.glow, 1.6)
      m.prism(cx, cz, 0.07, 0.02, 1.52, 2.1, 6, hex(0xbaf4ff), MAT.glow, 2.6)
      return
    }
    case "hoarding": {
      // Plywood site hoarding with posters and a hazard stripe along the foot.
      const r = rng(i * 31 + seed)
      m.box(x0, 0, z0, x1, w.h, z1, hex(0x5c4e3a), MAT.wall, 0, hex(0x6a5a44))
      const ax = x1 - x0 >= z1 - z0
      const L = ax ? x1 - x0 : z1 - z0
      for (let u = 0; u < L; u += 1.22) {
        if (ax) m.box(x0 + u, 0, z1, x0 + u + 0.05, w.h, z1 + 0.02, hex(0x3e3428), MAT.wall)
        else m.box(x1, 0, z0 + u, x1 + 0.02, w.h, z0 + u + 0.05, hex(0x3e3428), MAT.wall)
      }
      for (let u = 0.4; u < L - 1; u += 1.2 + r() * 1.5) {
        if (r() < 0.4) continue
        const col = [hex(0xb03a3a), hex(0x3a6ab0), hex(0xc8b040), hex(0xd0d0c8)][Math.floor(r() * 4)]!
        const y = 0.8 + r() * 0.5
        if (ax) m.box(x0 + u, y, z1, x0 + u + 0.7, y + 0.9, z1 + 0.025, col, MAT.wall)
        else m.box(x1, y, z0 + u, x1 + 0.025, y + 0.9, z0 + u + 0.7, col, MAT.wall)
      }
      for (let u = 0; u < L; u += 0.5) {
        const col = Math.round(u / 0.5) % 2 ? hex(0xd8b020) : hex(0x15161a)
        if (ax) m.box(x0 + u, 0, z1, x0 + Math.min(L, u + 0.5), 0.25, z1 + 0.03, col, MAT.wall)
        else m.box(x1, 0, z0 + u, x1 + 0.03, 0.25, z0 + Math.min(L, u + 0.5), col, MAT.wall)
      }
      return
    }
    case "subway": {
      // A railed stairwell: green railings on three sides, steps falling away toward the open end, light from below.
      const ax = x1 - x0 >= z1 - z0
      const openHi = (v & 1) === 0
      const rail = hex(0x2c4c3c)
      const L = ax ? x1 - x0 : z1 - z0
      const B = (u0: number, u1: number, s0: number, s1: number, y0: number, y1: number, col: Rgb, mat: Mat = MAT.wall, aux = 0) => (ax ? m.box(x0 + u0, y0, z0 + s0, x0 + u1, y1, z0 + s1, col, mat, aux) : m.box(x0 + s0, y0, z0 + u0, x0 + s1, y1, z0 + u1, col, mat, aux))
      const S = ax ? z1 - z0 : x1 - x0
      // The well: dark, with step nosings getting darker toward the bottom and a glow at the far end.
      B(0.08, L - 0.08, 0.08, S - 0.08, 0.104, 0.106, hex(0x0a0c10), MAT.lit)
      const steps = 10
      for (let k = 0; k < steps; k++) {
        const u = openHi ? 0.3 + (k * (L - 0.8)) / steps : L - 0.3 - ((k + 1) * (L - 0.8)) / steps
        const shade = 0.55 - k * 0.045
        B(u, u + 0.06, 0.15, S - 0.15, 0.106, 0.108, [shade * 0.6, shade * 0.65, shade * 0.75], MAT.lit)
      }
      const far = openHi ? L - 0.5 : 0.1
      B(far, far + 0.4, 0.15, S - 0.15, 0.106, 0.109, hex(0xd8f0ff), MAT.glow, 1.4)
      // Railings: posts and a top rail on the two long sides and the closed end.
      const sides: [number, number, number, number][] = [
        [0, L, 0, 0.06],
        [0, L, S - 0.06, S],
        openHi ? [0, 0.06, 0, S] : [L - 0.06, L, 0, S],
      ]
      for (const [u0, u1, s0, s1] of sides) {
        B(u0, u1, s0, s1, w.h - 0.06, w.h, rail)
        B(u0, u1, s0, s1, 0.45, 0.5, rail)
        const long = u1 - u0 > s1 - s0
        const n = Math.max(1, Math.round((long ? u1 - u0 : s1 - s0) / 0.9))
        for (let k = 0; k <= n; k++) {
          const t = k / n
          if (long) B(u0 + t * (u1 - u0) - 0.03, u0 + t * (u1 - u0) + 0.03, s0, s1, 0, w.h, rail)
          else B(u0, u1, s0 + t * (s1 - s0) - 0.03, s0 + t * (s1 - s0) + 0.03, 0, w.h, rail)
        }
      }
      // The sign: a post at the closed end with a glowing cube.
      const pu = openHi ? 0.15 : L - 0.15
      B(pu - 0.05, pu + 0.05, -0.25, -0.15, 0, 2.3, METAL)
      B(pu - 0.22, pu + 0.22, -0.42, 0.02, 2.3, 2.74, hex(0x3a8aff), MAT.glow, 1.6)
      B(pu - 0.12, pu + 0.12, -0.31, -0.09, 2.74, 2.745, hex(0xffffff), MAT.glow, 2.5)
      return
    }
  }
}

/**
 * A solid city building seen mostly from above: facade with rows of windows (a few lit) on the faces the camera sees,
 * a plinth, a parapet round a dark roof dressed with AC units, vents, a hatch, maybe a skylight or a water tank.
 */
function building(m: Mesh, w: Wall, v: number, seed: number): void {
  const [x0, z0, x1, z1] = w.rect
  const r = rng(v * 7 + seed)
  const [face, plinth] = FACADES[v % FACADES.length]!
  const h = w.h
  const roof = h - 0.35
  m.box(x0, 0.45, z0, x1, roof, z1, face, MAT.wall)
  m.box(x0 - 0.02, 0, z0 - 0.02, x1 + 0.02, 0.45, z1 + 0.02, plinth, MAT.wall)
  // Storey bands and windows on the south, west and east faces (north faces are never seen).
  const glassDark = hex(0x10141c)
  const warm = hex(0xffc47a)
  const cool = hex(0x9cc4ff)
  const litP = 0.12 + (v % 5) * 0.03
  const faces: { u0: number; u1: number; fixed: number; axis: "x" | "z"; out: number }[] = [
    { u0: x0, u1: x1, fixed: z1, axis: "x", out: 1 },
    { u0: z0, u1: z1, fixed: x0, axis: "z", out: -1 },
    { u0: z0, u1: z1, fixed: x1, axis: "z", out: 1 },
  ]
  const storey = 3.1
  for (const f of faces) {
    const L = f.u1 - f.u0
    if (L < 1.6) continue
    const n = Math.max(1, Math.floor((L - 0.6) / 2.1))
    const pitch = L / n
    const B = (u0: number, u1: number, y0: number, y1: number, out0: number, out1: number, col: Rgb, mat: Mat = MAT.wall, aux = 0) => {
      const a = f.fixed + f.out * out0
      const b = f.fixed + f.out * out1
      if (f.axis === "x") m.box(u0, y0, Math.min(a, b), u1, y1, Math.max(a, b), col, mat, aux)
      else m.box(Math.min(a, b), y0, u0, Math.max(a, b), y1, u1, col, mat, aux)
    }
    for (let y = storey; y < roof - 0.3; y += storey) B(f.u0, f.u1, y - 0.08, y + 0.04, 0, 0.04, plinth)
    for (let s = 0; ; s++) {
      const y = 0.9 + s * storey
      if (y + 1.4 > roof - 0.2) break
      for (let k = 0; k < n; k++) {
        const c = f.u0 + (k + 0.5) * pitch
        const ww = Math.min(1.1, pitch - 0.6)
        if (s === 0 && r() < 0.25) {
          // A street door: a dark recess with a frame.
          B(c - 0.5, c + 0.5, 0, 2.2, 0, 0.03, hex(0x22252c))
          B(c - 0.42, c + 0.42, 0.02, 2.1, 0.03, 0.035, hex(0x3a2e26))
          continue
        }
        const lit = r() < litP
        const hy = s === 0 ? 1.5 : 1.3
        B(c - ww / 2 - 0.06, c + ww / 2 + 0.06, y - 0.08, y - 0.02, 0, 0.06, plinth)
        B(c - ww / 2, c + ww / 2, y, y + hy, 0, 0.02, lit ? (r() < 0.75 ? warm : cool) : glassDark, lit ? MAT.glow : MAT.shiny, lit ? 0.55 + r() * 0.5 : 0)
        if (lit && r() < 0.5) B(c - 0.02, c + 0.02, y, y + hy, 0.02, 0.03, plinth)
      }
    }
  }
  // Roof: parapet ring, dark membrane, then the clutter.
  const p = 0.22
  const capTop = hex(0x2c3448)
  m.box(x0 + p, roof, z0 + p, x1 - p, roof + 0.02, z1 - p, hex(0x232a3c), MAT.cap)
  for (const [a0, b0, a1, b1] of [
    [x0, z0, x1, z0 + p],
    [x0, z1 - p, x1, z1],
    [x0, z0 + p, x0 + p, z1 - p],
    [x1 - p, z0 + p, x1, z1 - p],
  ] as const)
    m.bevelBox(a0 - 0.01, roof, b0 - 0.01, a1 + 0.01, h, b1 + 0.01, 0.03, hex(0x1c2232), capTop, MAT.wall, MAT.cap, hex(0x5a6684))
  const ix0 = x0 + p + 0.3
  const iz0 = z0 + p + 0.3
  const iw = x1 - x0 - 2 * p - 0.6
  const id = z1 - z0 - 2 * p - 0.6
  if (iw < 1.2 || id < 1.2) return
  const placed: number[][] = []
  const fit = (bw: number, bd: number): [number, number] | null => {
    for (let k = 0; k < 8; k++) {
      const bx = ix0 + r() * Math.max(0, iw - bw)
      const bz = iz0 + r() * Math.max(0, id - bd)
      if (placed.some((q) => bx < q[2]! + 0.25 && bx + bw > q[0]! - 0.25 && bz < q[3]! + 0.25 && bz + bd > q[1]! - 0.25)) continue
      placed.push([bx, bz, bx + bw, bz + bd])
      return [bx, bz]
    }
    return null
  }
  const area = iw * id
  if (area > 30 && r() < 0.55) {
    // Water tank on a steel stand.
    const R = 0.75 + r() * 0.3
    const at = fit(R * 2 + 0.2, R * 2 + 0.2)
    if (at) {
      const cx = at[0] + R + 0.1
      const cz = at[1] + R + 0.1
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) m.box(cx + sx! * R * 0.6 - 0.05, roof, cz + sz! * R * 0.6 - 0.05, cx + sx! * R * 0.6 + 0.05, roof + 0.9, cz + sz! * R * 0.6 + 0.05, METAL, MAT.wall)
      m.box(cx - R * 0.7, roof + 0.85, cz - R * 0.7, cx + R * 0.7, roof + 0.92, cz + R * 0.7, METAL, MAT.wall)
      m.prism(cx, cz, R, R, roof + 0.92, roof + 2.3, 12, hex(0x5a4a3c), MAT.wall, 0, false)
      for (const y of [1.3, 1.8]) m.prism(cx, cz, R + 0.02, R + 0.02, roof + y, roof + y + 0.05, 12, hex(0x2a2a2e), MAT.wall, 0, false)
      m.prism(cx, cz, R + 0.05, 0.08, roof + 2.3, roof + 2.75, 12, hex(0x3e342c), MAT.wall)
    }
  }
  const ac = 1 + Math.floor(area / 18) + Math.floor(r() * 2)
  for (let k = 0; k < ac; k++) {
    const bw = 0.9 + r() * 0.5
    const bd = 0.8 + r() * 0.3
    const at = fit(bw, bd)
    if (!at) continue
    const [bx, bz] = at
    const ht = 0.55 + r() * 0.3
    m.bevelBox(bx, roof, bz, bx + bw, roof + ht, bz + bd, 0.03, hex(0x6e737c), hex(0x8a909a), MAT.wall)
    const fr = Math.min(bw, bd) * 0.32
    m.prism(bx + bw / 2, bz + bd / 2, fr, fr, roof + ht, roof + ht + 0.01, 10, hex(0x1e2026), MAT.wall)
    m.box(bx + bw / 2 - fr, roof + ht + 0.01, bz + bd / 2 - 0.015, bx + bw / 2 + fr, roof + ht + 0.02, bz + bd / 2 + 0.015, hex(0x5a5e66), MAT.wall)
    m.box(bx + bw / 2 - 0.015, roof + ht + 0.01, bz + bd / 2 - fr, bx + bw / 2 + 0.015, roof + ht + 0.02, bz + bd / 2 + fr, hex(0x5a5e66), MAT.wall)
  }
  if (r() < 0.5) {
    const at = fit(1.3, 0.9)
    if (at) {
      // Skylight: a frame over a faint glow from the floor below.
      m.box(at[0], roof, at[1], at[0] + 1.3, roof + 0.22, at[1] + 0.9, hex(0x3a404c), MAT.wall)
      m.box(at[0] + 0.08, roof + 0.22, at[1] + 0.08, at[0] + 1.22, roof + 0.23, at[1] + 0.82, r() < 0.5 ? hex(0xffd8a0) : hex(0x7a8ab0), MAT.glow, 0.25 + r() * 0.3)
      m.box(at[0] + 0.63, roof + 0.23, at[1] + 0.08, at[0] + 0.67, roof + 0.24, at[1] + 0.82, hex(0x3a404c), MAT.wall)
    }
  }
  if (r() < 0.7) {
    const at = fit(0.7, 0.7)
    if (at) m.bevelBox(at[0], roof, at[1], at[0] + 0.7, roof + 0.35, at[1] + 0.7, 0.03, hex(0x4a4f5e), hex(0x5a6070), MAT.wall)
  }
  if (area > 24 && r() < 0.7) {
    // A run of ductwork across the roof.
    const along = iw > id
    const len = (along ? iw : id) * (0.4 + r() * 0.4)
    const at = fit(along ? len : 0.45, along ? 0.45 : len)
    if (at) {
      m.box(at[0], roof, at[1], at[0] + (along ? len : 0.45), roof + 0.4, at[1] + (along ? 0.45 : len), hex(0x5a5f6a), MAT.wall, 0, hex(0x6e7480))
      for (let u = 0.6; u < len; u += 1.2)
        if (along) m.box(at[0] + u, roof, at[1] - 0.02, at[0] + u + 0.06, roof + 0.42, at[1] + 0.47, hex(0x464a54), MAT.wall)
        else m.box(at[0] - 0.02, roof, at[1] + u, at[0] + 0.47, roof + 0.42, at[1] + u + 0.06, hex(0x464a54), MAT.wall)
    }
  }
  for (let k = 0; k < 3 + Math.floor(area / 25); k++) {
    const at = fit(0.25, 0.25)
    if (at) m.prism(at[0] + 0.12, at[1] + 0.12, 0.08, 0.08, roof, roof + 0.5 + r() * 0.4, 6, hex(0x50555f), MAT.wall)
  }
}

/** Parked cars: sedan, hatchback, taxi, police car or van, along the rect's long axis, facing +axis unless flipped. */
function car(m: Mesh, w: Wall, v: number): void {
  const [x0, z0, x1, z1] = w.rect
  const ax = x1 - x0 >= z1 - z0
  const L = ax ? x1 - x0 : z1 - z0
  const Wd = ax ? z1 - z0 : x1 - x0
  const model = v & 7
  const flip = (v & 64) !== 0
  const col = model === 2 ? hex(0xb88a1c) : model === 3 ? hex(0xb4b6b8) : CAR_COLS[(v >> 3) & 7]!
  const dark = hex(0x101218)
  const glass = hex(0x1a2234)
  const from = m.length
  const hl = L / 2
  const hw = Wd / 2
  // Built along +x (front at +x), centred on the origin.
  const van = model === 4
  const IN = [0, 0.3, 0]
  const beltY = van ? 1.05 : 0.82
  // Body: a slab with deep chamfers so it reads rounded from above, the bonnet and boot a shade darker.
  m.bevelBox(-hl, 0.28, -hw, hl, beltY, hw, 0.14, col, col, MAT.shiny, MAT.shiny, [col[0] * 0.8, col[1] * 0.8, col[2] * 0.85])
  if (!van) for (const sx of [-1, 1]) m.box(sx > 0 ? hl * 0.38 : -hl + 0.2, beltY - 0.005, -0.02, sx > 0 ? hl - 0.2 : -hl * 0.6, beltY + 0.003, 0.02, [col[0] * 0.6, col[1] * 0.6, col[2] * 0.6], MAT.shiny)
  if (model === 3) m.box(-hl * 0.55, 0.3, -hw - 0.005, hl * 0.35, beltY - 0.05, hw + 0.005, hex(0x16181e), MAT.shiny)
  // Wheels and wheel arches.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * hl * 0.62 - 0.33, 0, sz * hw - 0.12 - (sz > 0 ? 0 : -0.12) * 0, sx * hl * 0.62 + 0.33, 0.6, sz * hw + 0.02 * sz, dark)
  m.box(-hl + 0.1, 0.18, -hw + 0.1, hl - 0.1, 0.3, hw - 0.1, dark)
  // Bumpers and lights.
  m.box(hl - 0.04, 0.28, -hw + 0.1, hl + 0.04, 0.42, hw - 0.1, hex(0x2a2c32), MAT.shiny)
  m.box(-hl - 0.04, 0.28, -hw + 0.1, -hl + 0.04, 0.42, hw - 0.1, hex(0x2a2c32), MAT.shiny)
  for (const sz of [-1, 1]) {
    m.box(hl - 0.02, 0.55, sz * (hw - 0.3) - 0.17, hl + 0.015, 0.68, sz * (hw - 0.3) + 0.17, hex(0xfff2d0), MAT.glow, 0.35)
    m.box(-hl - 0.015, 0.58, sz * (hw - 0.25) - 0.15, -hl + 0.02, 0.7, sz * (hw - 0.25) + 0.15, hex(0xff2a1a), MAT.glow, 0.5)
  }
  if (van) {
    // Tall box body, sloped windscreen, side windows up front only.
    m.bevelBox(-hl, beltY, -hw, hl - 0.85, w.h, hw, 0.06, col, col, MAT.shiny)
    outQuad(m, IN, [hl - 0.85, w.h, -hw + 0.05], [hl - 0.85, w.h, hw - 0.05], [hl - 0.2, beltY, hw - 0.05], [hl - 0.2, beltY, -hw + 0.05], glass, MAT.shiny)
    for (const sz of [-1, 1]) {
      outQuad(m, IN, sz > 0 ? [hl - 0.85, beltY, hw - 0.05] : [hl - 0.2, beltY, -hw + 0.05], sz > 0 ? [hl - 0.2, beltY, hw - 0.05] : [hl - 0.85, beltY, -hw + 0.05], sz > 0 ? [hl - 0.85, w.h, hw - 0.05] : [hl - 0.85, w.h, -hw + 0.05], sz > 0 ? [hl - 0.85, w.h, hw - 0.05] : [hl - 0.85, w.h, -hw + 0.05], col, MAT.shiny)
      m.box(hl - 1.9, beltY + 0.1, sz * hw - 0.01, hl - 0.95, w.h - 0.2, sz * hw + 0.01, glass, MAT.shiny)
    }
    m.box(-hl + 0.1, w.h - 0.01, -hw + 0.1, hl - 0.95, w.h + 0.06, -hw + 0.18, hex(0x3a3d44))
    m.box(-hl + 0.1, w.h - 0.01, hw - 0.18, hl - 0.95, w.h + 0.06, hw - 0.1, hex(0x3a3d44))
  } else {
    // Cabin: a frustum from the belt line up to the roof, glass on its faces, the roof in body colour.
    const hatch = model === 1
    const f0 = hatch ? hl * 0.3 : hl * 0.32
    const r0 = hatch ? -hl + 0.15 : -hl * 0.52
    const f1 = f0 - 0.55
    const r1 = hatch ? r0 + 0.12 : r0 + 0.42
    const top = w.h - (model === 3 ? 0.1 : model === 2 ? 0.08 : 0)
    const bw = hw - 0.08
    const tw = hw - 0.2
    const A = [f0, beltY, -bw]
    const B = [f0, beltY, bw]
    const C = [r0, beltY, bw]
    const D = [r0, beltY, -bw]
    const a = [f1, top, -tw]
    const b = [f1, top, tw]
    const c = [r1, top, tw]
    const d = [r1, top, -tw]
    outQuad(m, IN, A, B, b, a, glass, MAT.shiny)
    outQuad(m, IN, C, D, d, c, glass, MAT.shiny)
    outQuad(m, IN, B, C, c, b, glass, MAT.shiny)
    outQuad(m, IN, D, A, a, d, glass, MAT.shiny)
    outQuad(m, IN, a, b, c, d, col, MAT.shiny)
    // Pillars between the side windows.
    const mid = (f1 + r1) / 2
    for (const sz of [-1, 1]) outQuad(m, IN, [mid - 0.05, beltY, sz * bw], [mid + 0.05, beltY, sz * bw], [mid + 0.05, top, sz * tw], [mid - 0.05, top, sz * tw], col, MAT.shiny)
    if (model === 2) {
      m.bevelBox(mid - 0.22, top, -0.13, mid + 0.22, top + 0.16, 0.13, 0.02, hex(0xffe080), hex(0xfff0b0), MAT.glow, MAT.glow)
      m.box(-hl + 0.3, 0.6, -hw - 0.006, hl - 0.3, 0.66, -hw, hex(0x18181a))
      m.box(-hl + 0.3, 0.6, hw, hl - 0.3, 0.66, hw + 0.006, hex(0x18181a))
    }
    if (model === 3) {
      m.box(mid - 0.15, top, -0.55, mid + 0.15, top + 0.1, 0.55, hex(0x1a1c22))
      m.box(mid - 0.12, top + 0.02, -0.5, mid + 0.12, top + 0.13, -0.04, hex(0xff2a2a), MAT.glow, 10.31)
      m.box(mid - 0.12, top + 0.02, 0.04, mid + 0.12, top + 0.13, 0.5, hex(0x2a5aff), MAT.glow, 10.67)
    }
  }
  xform(m, from, ax ? (flip ? Math.PI : 0) : flip ? -Math.PI / 2 : Math.PI / 2, (x0 + x1) / 2, 0, (z0 + z1) / 2)
}

/** A burnt-out car, still burning: charred shell, caved roof, glowing embers and flames that flicker with its light. */
function wreck(m: Mesh, w: Wall, v: number, seed: number): void {
  const [x0, z0, x1, z1] = w.rect
  const ax = x1 - x0 >= z1 - z0
  const L = ax ? x1 - x0 : z1 - z0
  const Wd = ax ? z1 - z0 : x1 - x0
  const id = v >> 1
  const r = rng(seed * 3 + 11)
  const from = m.length
  const hl = L / 2
  const hw = Wd / 2
  const IN = [0, 0.3, 0]
  const char = hex(0x141210)
  const rust = hex(0x1e1410)
  m.box(-hl, 0.12, -hw, hl, 0.72, hw, char, MAT.wall, 0, rust)
  outQuad(m, IN, [hl * 0.3, 0.72, -hw + 0.12], [hl * 0.3, 0.72, hw - 0.12], [-hl * 0.1, 1.05, hw - 0.3], [-hl * 0.1, 1.05, -hw + 0.3], hex(0x141210), MAT.wall)
  outQuad(m, IN, [-hl * 0.1, 1.05, -hw + 0.3], [-hl * 0.1, 1.05, hw - 0.3], [-hl * 0.55, 0.72, hw - 0.12], [-hl * 0.55, 0.72, -hw + 0.12], hex(0x181412), MAT.wall)
  // Bonnet sprung open.
  outQuad(m, IN, [hl * 0.35, 0.74, -hw + 0.08], [hl * 0.35, 0.74, hw - 0.08], [hl * 0.62, 1.15, hw - 0.12], [hl * 0.62, 1.15, -hw + 0.12], rust, MAT.wall)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) m.box(sx * hl * 0.62 - 0.3, 0, sz * hw - 0.1, sx * hl * 0.62 + 0.3, 0.42, sz * hw + 0.02, hex(0x0c0c0e))
  // Embers along the floor of the cabin and the engine bay.
  m.box(-hl * 0.5, 0.721, -hw + 0.2, hl * 0.3, 0.73, hw - 0.2, hex(0x5a1804), MAT.lamp, id)
  m.box(hl * 0.4, 0.721, -hw + 0.2, hl - 0.15, 0.73, hw - 0.2, hex(0x6a2206), MAT.lamp, id)
  // The flames themselves are sprites (src/game/map-fx.ts); here, just the glowing seat frames and a few coals.
  for (let k = 0; k < 6; k++) m.yawBox((r() - 0.4) * L * 0.6, (r() - 0.5) * Wd * 0.5, 0.25, 0.08, 0.73, 0.78, r() * 3, hex(0x8a2a08), MAT.lamp, id)
  // Soot smudge and debris on the ground round it.
  for (let k = 0; k < 6; k++) m.yawBox((r() - 0.5) * L * 1.4, (r() - 0.5) * Wd * 2.2, 0.15 + r() * 0.3, 0.1 + r() * 0.2, 0.105, 0.14, r() * 3, hex(0x2a2420))
  xform(m, from, ax ? 0 : Math.PI / 2, (x0 + x1) / 2, 0, (z0 + z1) / 2)
}
