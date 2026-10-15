import type { LevelData } from "@arcade/kit/gpu/level"
import { MAT, Mesh, hex, packVerts, type Rgb } from "@arcade/kit/gpu/mesh"
import { flatLighting } from "@arcade/kit/gpu/scene-frame"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { BLOCKS, STAGE } from "../../shared/arena"

/** The party palette: pastel floor tiles, candy trim. */
export const PARTY = {
  tiles: [hex(0xf392c0), hex(0x86dcc8), hex(0xf4d273)] as Rgb[],
  grout: hex(0xd8679f),
  apron: hex(0xfff1dc),
  side: hex(0xf06aa6),
  trim: hex(0xffd23f),
  post: hex(0x43c9bf),
  ball: hex(0xffd23f),
  ropes: [hex(0xff4f9a), hex(0xffffff), hex(0x43c9bf)] as Rgb[],
  pit: hex(0x2a1850),
  pillar: hex(0x43c9bf),
  pillarTop: hex(0xffd23f),
  wall: hex(0xff7eb6),
  wallTop: hex(0xffffff),
  confetti: [hex(0xff4f9a), hex(0x43c9bf), hex(0xffd23f), hex(0x8f6bff), hex(0x5fd35f), hex(0xff8a3d)] as Rgb[],
}

export const APRON = 0.9
export const PLATFORM_DEPTH = 1.4
export const PIT_Y = -7

const L = MAT.lit

/** The arena as one static level chunk: the tiled ring on its platform, ropes and posts, pillars and low walls. */
export function arenaLevel(seed = 7): LevelData {
  const m = new Mesh()
  const [x0, y0, x1, y1] = STAGE
  // Pit far below, so a fall reads as a drop.
  m.quad([-40, PIT_Y, 64], [72, PIT_Y, 64], [72, PIT_Y, -40], [-40, PIT_Y, -40], [0, 1, 0], PARTY.pit, L)
  // Platform: apron and sides.
  const ax0 = x0 - APRON, ay0 = y0 - APRON, ax1 = x1 + APRON, ay1 = y1 + APRON
  m.box(ax0, -PLATFORM_DEPTH, ay0, ax1, -0.01, ay1, PARTY.side, L, 0, PARTY.apron)
  m.box(ax0 - 0.03, -0.28, ay0 - 0.03, ax1 + 0.03, -0.16, ay1 + 0.03, PARTY.trim, L)
  for (const [a, b, c, d] of [
    [ax0, ay1 + 0.04, ax1, ay1 + 0.06],
    [ax0, ay0 - 0.06, ax1, ay0 - 0.04],
    [ax0 - 0.06, ay0, ax0 - 0.04, ay1],
    [ax1 + 0.04, ay0, ax1 + 0.06, ay1],
  ] as const) m.box(a, -PLATFORM_DEPTH + 0.05, b, c, -PLATFORM_DEPTH + 0.18, d, PARTY.ropes[0]!, MAT.glow, 1.4)
  // Tiles: 2 m squares in three alternating pastels over a grout bed.
  m.box(x0, -0.02, y0, x1, 0, y1, PARTY.grout, L)
  const T = 2
  for (let i = 0; i * T < x1 - x0; i++) {
    for (let j = 0; j * T < y1 - y0; j++) {
      const c = PARTY.tiles[(i + j * 2) % 3]!
      const tx = x0 + i * T, ty = y0 + j * T
      m.quad([tx + 0.04, 0.004, ty + T - 0.04], [tx + T - 0.04, 0.004, ty + T - 0.04], [tx + T - 0.04, 0.004, ty + 0.04], [tx + 0.04, 0.004, ty + 0.04], [0, 1, 0], c, L)
    }
  }
  // Confetti.
  const r = mulberry32(seed)
  for (let i = 0; i < 260; i++) {
    const x = ax0 + r() * (ax1 - ax0)
    const y = ay0 + r() * (ay1 - ay0)
    const a = r() * Math.PI
    const s = 0.05 + r() * 0.05
    const c = Math.cos(a), d = Math.sin(a)
    const at = (u: number, v: number) => [x + (u * c - v * d) * s, 0.009, y + (u * d + v * c) * s]
    const col = PARTY.confetti[i % PARTY.confetti.length]!
    m.quad(at(-1, 0.6), at(1, 0.6), at(1, -0.6), at(-1, -0.6), [0, 1, 0], col, L)
  }
  // Corner posts with ball tops, and three ropes between them.
  const corners = [[x0 - 0.1, y0 - 0.1], [x1 + 0.1, y0 - 0.1], [x1 + 0.1, y1 + 0.1], [x0 - 0.1, y1 + 0.1]] as const
  for (const [cx, cy] of corners) {
    m.prism(cx, cy, 0.2, 0.17, 0, 1.05, 10, PARTY.post, L)
    m.prism(cx, cy, 0.17, 0.24, 1.05, 1.17, 10, PARTY.ball, L)
    m.prism(cx, cy, 0.24, 0.12, 1.17, 1.33, 10, PARTY.ball, L)
  }
  const ropeH = [0.34, 0.6, 0.86]
  ropeH.forEach((h, k) => {
    const col = PARTY.ropes[k]!
    const t = 0.035
    m.box(x0 - 0.1, h - t, y0 - 0.1 - t, x1 + 0.1, h + t, y0 - 0.1 + t, col, L)
    m.box(x0 - 0.1, h - t, y1 + 0.1 - t, x1 + 0.1, h + t, y1 + 0.1 + t, col, L)
    m.box(x0 - 0.1 - t, h - t, y0 - 0.1, x0 - 0.1 + t, h + t, y1 + 0.1, col, L)
    m.box(x1 + 0.1 - t, h - t, y0 - 0.1, x1 + 0.1 + t, h + t, y1 + 0.1, col, L)
  })
  // Pillars (speaker towers) and low candy-striped walls.
  for (const b of BLOCKS) {
    const [bx0, by0, bx1, by1] = b.rect
    if (b.h > 1.5) {
      m.bevelBox(bx0, 0, by0, bx1, b.h, by1, 0.12, PARTY.pillar, PARTY.pillarTop, L)
      const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2
      m.prism(cx, cy, 0.38, 0.38, b.h, b.h + 0.04, 12, hex(0x23263a), MAT.shiny)
      m.prism(cx, cy, 0.18, 0.18, b.h + 0.04, b.h + 0.06, 12, PARTY.ropes[0]!, MAT.glow, 1.2)
      for (const yy of [0.5, 1.2]) m.box(bx0 - 0.01, yy, by0 - 0.01, bx1 + 0.01, yy + 0.12, by1 + 0.01, PARTY.trim, L)
    } else {
      m.bevelBox(bx0, 0, by0, bx1, b.h, by1, 0.08, PARTY.wall, PARTY.wallTop, L)
      const n = Math.round((bx1 - bx0) / 0.5)
      for (let i = 0; i < n; i += 2) {
        const sx = bx0 + (i / n) * (bx1 - bx0)
        m.box(sx, 0.08, by0 - 0.01, sx + (bx1 - bx0) / n, b.h - 0.12, by1 + 0.01, PARTY.trim, L)
      }
    }
  }
  const data = packVerts(m.v)
  const lighting = flatLighting(0, 1, [0.62, 0.55, 0.6])
  return { chunks: [{ data, box: [-40, -40, 72, 64] }], glass: [], floor: lighting.floor, bounce: lighting.bounce }
}

/** Shoveable props, modelled at the origin with +x along the heading. */
export function propMeshes(): Record<string, Mesh> {
  const A = MAT.actor
  const crate = new Mesh()
  const wood = hex(0xc0864c), dark = hex(0x7d522c)
  crate.box(-0.45, 0, -0.45, 0.45, 0.9, 0.45, wood, A, 0, hex(0xd39a5e))
  for (const [x, z] of [[-0.45, -0.45], [0.45, -0.45], [0.45, 0.45], [-0.45, 0.45]] as const) crate.box(x - 0.06, 0, z - 0.06, x + 0.06, 0.91, z + 0.06, dark, A)
  for (const y of [0, 0.84]) {
    crate.box(-0.46, y, -0.46, 0.46, y + 0.07, -0.4, dark, A)
    crate.box(-0.46, y, 0.4, 0.46, y + 0.07, 0.46, dark, A)
    crate.box(-0.46, y, -0.46, -0.4, y + 0.07, 0.46, dark, A)
    crate.box(0.4, y, -0.46, 0.46, y + 0.07, 0.46, dark, A)
  }
  crate.yawBox(0, 0, 1.15, 0.08, 0.905, 0.925, Math.PI / 4, dark, A)

  const barrel = new Mesh()
  const red = hex(0xd8262c)
  barrel.prism(0, 0, 0.3, 0.32, 0, 0.5, 12, red, A)
  barrel.prism(0, 0, 0.32, 0.3, 0.5, 1, 12, red, A)
  barrel.prism(0, 0, 0.33, 0.33, 0.42, 0.58, 12, hex(0xffd23f), A)
  for (const y of [0.04, 0.94]) barrel.prism(0, 0, 0.325, 0.325, y, y + 0.05, 12, hex(0x8a8f9c), MAT.shiny)
  barrel.prism(0, 0, 0.26, 0.26, 1, 1.01, 12, hex(0xb81e24), A)
  barrel.box(0.1, 1, -0.05, 0.2, 1.04, 0.05, hex(0x8a8f9c), MAT.shiny)

  const cart = new Mesh()
  const wire = hex(0xc7ccd8)
  cart.box(-0.5, 0.36, -0.34, 0.45, 0.42, 0.34, wire, MAT.shiny)
  for (const z of [-0.34, 0.31]) cart.box(-0.5, 0.42, z, 0.5, 0.95, z + 0.03, wire, MAT.shiny)
  for (const x of [-0.5, 0.47]) cart.box(x, 0.42, -0.34, x + 0.03, 0.95, 0.34, wire, MAT.shiny)
  for (let x = -0.4; x < 0.45; x += 0.15) for (const z of [-0.345, 0.335]) cart.box(x, 0.42, z, x + 0.02, 0.95, z + 0.015, hex(0x9aa1b2), A)
  cart.box(-0.62, 0.95, -0.32, -0.55, 1.02, 0.32, hex(0xe8323a), A)
  cart.box(-0.6, 0.6, -0.3, -0.5, 0.97, -0.26, wire, MAT.shiny)
  cart.box(-0.6, 0.6, 0.26, -0.5, 0.97, 0.3, wire, MAT.shiny)
  for (const x of [-0.42, 0.38]) for (const z of [-0.28, 0.28]) {
    cart.box(x - 0.015, 0.1, z - 0.015, x + 0.015, 0.36, z + 0.015, wire, MAT.shiny)
    cart.box(x - 0.06, 0, z - 0.03, x + 0.06, 0.12, z + 0.03, hex(0x23263a), A)
  }

  const car = new Mesh()
  const body = hex(0xe8392f), cream = hex(0xfff0d4), glass = hex(0x5fd8e8), tyre = hex(0x1d1e26)
  for (const x of [-1.25, 1.2]) for (const z of [-0.8, 0.8]) car.prism(x, z, 0.34, 0.34, 0, 0.66, 10, tyre, A)
  car.bevelBox(-1.9, 0.22, -0.88, 1.9, 0.86, 0.88, 0.14, body, body, A)
  car.bevelBox(-1.05, 0.86, -0.78, 0.75, 1.35, 0.78, 0.12, cream, cream, A)
  car.box(0.75, 0.88, -0.7, 0.8, 1.26, 0.7, glass, MAT.shiny)
  car.box(-1.1, 0.88, -0.7, -1.05, 1.26, 0.7, glass, MAT.shiny)
  for (const z of [-1, 1]) car.box(-0.95, 0.9, z * 0.78 - 0.02, 0.65, 1.24, z * 0.78 + 0.02, glass, MAT.shiny)
  for (const z of [-0.6, 0.6]) car.box(1.88, 0.55, z - 0.14, 1.92, 0.72, z + 0.14, hex(0xfff6c0), MAT.glow, 1.6)
  car.box(1.9, 0.3, -0.5, 1.95, 0.42, 0.5, hex(0xc7ccd8), MAT.shiny)
  car.box(-1.95, 0.3, -0.5, -1.9, 0.42, 0.5, hex(0xc7ccd8), MAT.shiny)

  return { crate, barrel, cart, car }
}
