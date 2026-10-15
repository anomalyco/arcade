import type { LevelData } from "@arcade/kit/gpu/level"
import { createLookSettings, type LookSettings } from "@arcade/kit/gpu/look"
import { MAT, Mesh, hex, packVerts, type Rgb } from "@arcade/kit/gpu/mesh"
import { type SceneLight, flatLighting } from "@arcade/kit/gpu/scene-frame"
import { mulberry32 } from "@arcade/kit/sim/rng"
import { BLOCKS, CENTER, STAGE } from "../../shared/arena"

export type ArenaThemeId = "spotlit_ring" | "neon_club" | "back_alley" | "party_pop"

export type ArenaPalette = {
  id: ArenaThemeId
  label: string
  tiles: Rgb[]
  grout: Rgb
  apron: Rgb
  side: Rgb
  trim: Rgb
  post: Rgb
  ball: Rgb
  ropes: Rgb[]
  ropeGlow: number
  pit: Rgb
  pillar: Rgb
  pillarTop: Rgb
  wall: Rgb
  wallTop: Rgb
  confetti: Rgb[]
  confettiCount: number
  bounce: [number, number, number]
  ambient: [number, number, number, number]
  ao: number
  fighterRimPower: number
  lights: SceneLight[]
  look: () => LookSettings
}

export const ARENA_THEMES: Readonly<Record<ArenaThemeId, ArenaPalette>> = {
  spotlit_ring: {
    id: "spotlit_ring",
    label: "Spotlit Fight Night",
    tiles: [hex(0x161f33), hex(0x1d2942), hex(0x19233a)],
    grout: hex(0x0b101c),
    apron: hex(0x121829),
    side: hex(0x0a0d17),
    trim: hex(0xffb830),
    post: hex(0x222c44),
    ball: hex(0xffb830),
    ropes: [hex(0xff2e55), hex(0xffd24c), hex(0xff2e55)],
    ropeGlow: 0.75,
    pit: hex(0x04050a),
    pillar: hex(0x1b2338),
    pillarTop: hex(0xffb830),
    wall: hex(0x232d45),
    wallTop: hex(0x384566),
    confetti: [hex(0xff2e55), hex(0xffb830), hex(0x38bdf8)],
    confettiCount: 28,
    bounce: [0.15, 0.16, 0.23],
    ambient: [0.08, 0.1, 0.16, 0],
    ao: 0.45,
    fighterRimPower: 0.28,
    lights: [
      { x: CENTER.x, y: CENTER.y + 0.5, h: 14, r: 29, color: [1, 0.92, 0.8], power: 0.92, size: 1.05 },
      { x: STAGE[0] + 1.5, y: STAGE[1] + 1.5, h: 5.5, r: 13, color: [1, 0.24, 0.45], power: 0.36, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 1.5, y: STAGE[1] + 1.5, h: 5.5, r: 13, color: [0.22, 0.68, 1], power: 0.36, size: 0.5, unshadowed: true },
      { x: STAGE[0] + 1.5, y: STAGE[3] - 1.5, h: 5.5, r: 13, color: [1, 0.72, 0.2], power: 0.34, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 1.5, y: STAGE[3] - 1.5, h: 5.5, r: 13, color: [0.52, 0.35, 1], power: 0.34, size: 0.5, unshadowed: true },
    ],
    look: () => createLookSettings("night_ring"),
  },
  neon_club: {
    id: "neon_club",
    label: "Neon Club Pit",
    tiles: [hex(0x130b29), hex(0x1d113d), hex(0x170e33)],
    grout: hex(0x00d8ff),
    apron: hex(0x100824),
    side: hex(0x090414),
    trim: hex(0x00f0ff),
    post: hex(0x28154d),
    ball: hex(0xff2a85),
    ropes: [hex(0x00f0ff), hex(0xff2a85), hex(0x00f0ff)],
    ropeGlow: 1.05,
    pit: hex(0x05020d),
    pillar: hex(0x201140),
    pillarTop: hex(0x00f0ff),
    wall: hex(0x2d1857),
    wallTop: hex(0xff2a85),
    confetti: [hex(0x00f0ff), hex(0xff2a85), hex(0xa855f7)],
    confettiCount: 32,
    bounce: [0.16, 0.1, 0.28],
    ambient: [0.09, 0.05, 0.18, 0],
    ao: 0.5,
    fighterRimPower: 0.32,
    lights: [
      { x: CENTER.x, y: CENTER.y + 0.5, h: 14, r: 28, color: [0.76, 0.82, 1], power: 0.82, size: 1.05 },
      { x: STAGE[0] + 1.5, y: STAGE[1] + 1.5, h: 5.5, r: 15, color: [1, 0.14, 0.62], power: 0.52, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 1.5, y: STAGE[1] + 1.5, h: 5.5, r: 15, color: [0.05, 0.92, 1], power: 0.52, size: 0.5, unshadowed: true },
      { x: STAGE[0] + 1.5, y: STAGE[3] - 1.5, h: 5.5, r: 15, color: [0.62, 0.2, 1], power: 0.48, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 1.5, y: STAGE[3] - 1.5, h: 5.5, r: 15, color: [1, 0.18, 0.68], power: 0.48, size: 0.5, unshadowed: true },
    ],
    look: () => ({
      ...createLookSettings("night_ring"),
      exposure: 0.95,
      contrast: 1.26,
      saturation: 1.34,
      temperature: -0.22,
      splitTone: 0.68,
      shadowTintR: 0.86,
      shadowTintG: 0.68,
      shadowTintB: 1.32,
      highlightTintR: 0.9,
      highlightTintG: 1.04,
      highlightTintB: 1.18,
      bloom: 0.96,
      vignette: 0.64,
    }),
  },
  back_alley: {
    id: "back_alley",
    label: "Back Alley Cage",
    tiles: [hex(0x241d16), hex(0x2e251c), hex(0x292119)],
    grout: hex(0x120e0a),
    apron: hex(0x1d1610),
    side: hex(0x120d09),
    trim: hex(0xf59e0b),
    post: hex(0x382a1e),
    ball: hex(0xff9b38),
    ropes: [hex(0xea580c), hex(0xfacc15), hex(0xea580c)],
    ropeGlow: 0.65,
    pit: hex(0x060504),
    pillar: hex(0x2e2319),
    pillarTop: hex(0xf59e0b),
    wall: hex(0x3b2d21),
    wallTop: hex(0x5c4735),
    confetti: [hex(0xf59e0b), hex(0xea580c)],
    confettiCount: 16,
    bounce: [0.22, 0.15, 0.1],
    ambient: [0.1, 0.08, 0.07, 0],
    ao: 0.52,
    fighterRimPower: 0.28,
    lights: [
      { x: CENTER.x, y: CENTER.y + 0.5, h: 13.5, r: 28, color: [1, 0.68, 0.34], power: 0.96, size: 0.95 },
      { x: STAGE[0] + 2, y: STAGE[1] + 2, h: 5.5, r: 14, color: [1, 0.45, 0.14], power: 0.42, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 2, y: STAGE[1] + 2, h: 5.5, r: 14, color: [0.32, 0.6, 0.96], power: 0.38, size: 0.5, unshadowed: true },
      { x: STAGE[0] + 2, y: STAGE[3] - 2, h: 5.5, r: 14, color: [0.32, 0.6, 0.96], power: 0.38, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 2, y: STAGE[3] - 2, h: 5.5, r: 14, color: [1, 0.52, 0.18], power: 0.42, size: 0.5, unshadowed: true },
    ],
    look: () => ({
      ...createLookSettings("night_ring"),
      exposure: 0.95,
      tonemap: 1,
      contrast: 1.24,
      toe: 0.28,
      saturation: 1.18,
      temperature: 0.26,
      splitTone: 0.72,
      shadowTintR: 0.82,
      shadowTintG: 0.84,
      shadowTintB: 1.02,
      highlightTintR: 1.22,
      highlightTintG: 0.9,
      highlightTintB: 0.62,
      bloom: 0.85,
      halation: 0.26,
      vignette: 0.66,
    }),
  },
  party_pop: {
    id: "party_pop",
    label: "Party Pop (Legacy)",
    tiles: [hex(0xf392c0), hex(0x86dcc8), hex(0xf4d273)],
    grout: hex(0xd8679f),
    apron: hex(0xfff1dc),
    side: hex(0xf06aa6),
    trim: hex(0xffd23f),
    post: hex(0x43c9bf),
    ball: hex(0xffd23f),
    ropes: [hex(0xff4f9a), hex(0xffffff), hex(0x43c9bf)],
    ropeGlow: 0,
    pit: hex(0x2a1850),
    pillar: hex(0x43c9bf),
    pillarTop: hex(0xffd23f),
    wall: hex(0xff7eb6),
    wallTop: hex(0xffffff),
    confetti: [hex(0xff4f9a), hex(0x43c9bf), hex(0xffd23f), hex(0x8f6bff), hex(0x5fd35f), hex(0xff8a3d)],
    confettiCount: 260,
    bounce: [0.62, 0.55, 0.6],
    ambient: [0.3, 0.27, 0.34, 0],
    ao: 0,
    fighterRimPower: 0,
    lights: [
      { x: CENTER.x, y: CENTER.y + 1, h: 14, r: 30, color: [1, 0.95, 0.88], power: 0.62, size: 1.2 },
      { x: STAGE[0] + 3, y: STAGE[1] + 2, h: 6, r: 12, color: [1, 0.4, 0.72], power: 0.32, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 3, y: STAGE[1] + 2, h: 6, r: 12, color: [0.35, 0.8, 1], power: 0.32, size: 0.5, unshadowed: true },
      { x: STAGE[0] + 3, y: STAGE[3] - 2, h: 6, r: 12, color: [1, 0.8, 0.3], power: 0.3, size: 0.5, unshadowed: true },
      { x: STAGE[2] - 3, y: STAGE[3] - 2, h: 6, r: 12, color: [0.65, 0.45, 1], power: 0.3, size: 0.5, unshadowed: true },
    ],
    look: () => createLookSettings("party_pop"),
  },
}

export const DEFAULT_ARENA_THEME: ArenaThemeId = "spotlit_ring"
export const PARTY = ARENA_THEMES.spotlit_ring

export const APRON = 0.9
export const PLATFORM_DEPTH = 1.4
export const PIT_Y = -7

const L = MAT.lit

/** The arena as one static level chunk: the tiled ring on its platform, ropes and posts, pillars and low walls. */
export function arenaLevel(seed = 7, themeId: ArenaThemeId = DEFAULT_ARENA_THEME): LevelData {
  const P = ARENA_THEMES[themeId] ?? ARENA_THEMES.spotlit_ring
  const m = new Mesh()
  const [x0, y0, x1, y1] = STAGE
  // Pit far below, so a fall reads as a drop.
  m.quad([-40, PIT_Y, 64], [72, PIT_Y, 64], [72, PIT_Y, -40], [-40, PIT_Y, -40], [0, 1, 0], P.pit, L)
  // Platform: apron and sides.
  const ax0 = x0 - APRON, ay0 = y0 - APRON, ax1 = x1 + APRON, ay1 = y1 + APRON
  m.box(ax0, -PLATFORM_DEPTH, ay0, ax1, -0.01, ay1, P.side, L, 0, P.apron)
  m.box(ax0 - 0.03, -0.28, ay0 - 0.03, ax1 + 0.03, -0.16, ay1 + 0.03, P.trim, L)
  // Glowing hazard border around the ring edge so the ring-out boundary reads immediately in the dark.
  for (const [a, b, c, d] of [
    [x0 - 0.08, y1 + 0.02, x1 + 0.08, y1 + 0.1],
    [x0 - 0.08, y0 - 0.1, x1 + 0.08, y0 - 0.02],
    [x0 - 0.1, y0 - 0.08, x0 - 0.02, y1 + 0.08],
    [x1 + 0.02, y0 - 0.08, x1 + 0.1, y1 + 0.08],
  ] as const) m.box(a, 0.002, b, c, 0.018, d, P.trim, MAT.glow, 1.1)
  for (const [a, b, c, d] of [
    [ax0, ay1 + 0.04, ax1, ay1 + 0.06],
    [ax0, ay0 - 0.06, ax1, ay0 - 0.04],
    [ax0 - 0.06, ay0, ax0 - 0.04, ay1],
    [ax1 + 0.04, ay0, ax1 + 0.06, ay1],
  ] as const) m.box(a, -PLATFORM_DEPTH + 0.05, b, c, -PLATFORM_DEPTH + 0.18, d, P.ropes[0]!, MAT.glow, 1.4)
  // Tiles: 2 m squares over a dark grout bed.
  m.box(x0, -0.02, y0, x1, 0, y1, P.grout, L)
  const T = 2
  for (let i = 0; i * T < x1 - x0; i++) {
    for (let j = 0; j * T < y1 - y0; j++) {
      const c = P.tiles[(i + j * 2) % P.tiles.length]!
      const tx = x0 + i * T, ty = y0 + j * T
      m.quad([tx + 0.04, 0.004, ty + T - 0.04], [tx + T - 0.04, 0.004, ty + T - 0.04], [tx + T - 0.04, 0.004, ty + 0.04], [tx + 0.04, 0.004, ty + 0.04], [0, 1, 0], c, L)
    }
  }
  // Subtle center-ring fight emblem and inner canvas border so the stage center and ring-out zone anchor the eye.
  m.prism(CENTER.x, CENTER.y, 2.75, 2.75, 0.005, 0.008, 24, P.trim, P.ropeGlow > 0 ? MAT.glow : L, P.ropeGlow > 0 ? 0.55 : 0)
  m.prism(CENTER.x, CENTER.y, 2.52, 2.52, 0.006, 0.01, 24, P.tiles[0]!, L)
  m.prism(CENTER.x, CENTER.y, 0.95, 0.95, 0.007, 0.011, 20, P.ropes[0]!, L)
  m.prism(CENTER.x, CENTER.y, 0.82, 0.82, 0.008, 0.012, 20, P.tiles[1]!, L)
  const inset = 1.6
  for (const [a, b, c, d] of [
    [x0 + inset, y1 - inset - 0.1, x1 - inset, y1 - inset],
    [x0 + inset, y0 + inset, x1 - inset, y0 + inset + 0.1],
    [x0 + inset, y0 + inset, x0 + inset + 0.1, y1 - inset],
    [x1 - inset - 0.1, y0 + inset, x1 - inset, y1 - inset],
  ] as const) m.box(a, 0.005, b, c, 0.009, d, P.ropes[0]!, P.id === "neon_club" ? MAT.glow : L, P.id === "neon_club" ? 0.65 : 0)
  // Confetti accents.
  const r = mulberry32(seed)
  for (let i = 0; i < P.confettiCount; i++) {
    const x = ax0 + r() * (ax1 - ax0)
    const y = ay0 + r() * (ay1 - ay0)
    const a = r() * Math.PI
    const s = 0.05 + r() * 0.05
    const c = Math.cos(a), d = Math.sin(a)
    const at = (u: number, v: number) => [x + (u * c - v * d) * s, 0.009, y + (u * d + v * c) * s]
    const col = P.confetti[i % P.confetti.length]!
    m.quad(at(-1, 0.6), at(1, 0.6), at(1, -0.6), at(-1, -0.6), [0, 1, 0], col, L)
  }
  // Corner posts with glowing turnbuckle tops, and three ropes between them.
  const corners = [[x0 - 0.1, y0 - 0.1], [x1 + 0.1, y0 - 0.1], [x1 + 0.1, y1 + 0.1], [x0 - 0.1, y1 + 0.1]] as const
  for (const [cx, cy] of corners) {
    m.prism(cx, cy, 0.2, 0.17, 0, 1.05, 10, P.post, L)
    m.prism(cx, cy, 0.17, 0.24, 1.05, 1.17, 10, P.ball, P.ropeGlow > 0 ? MAT.glow : L, P.ropeGlow > 0 ? 1.1 : 0)
    m.prism(cx, cy, 0.24, 0.12, 1.17, 1.33, 10, P.ball, P.ropeGlow > 0 ? MAT.glow : L, P.ropeGlow > 0 ? 1.1 : 0)
  }
  const ropeH = [0.34, 0.6, 0.86]
  ropeH.forEach((h, k) => {
    const col = P.ropes[k]!
    const t = 0.035
    const mat = P.ropeGlow > 0 && k === 2 ? MAT.glow : L
    const em = P.ropeGlow > 0 && k === 2 ? P.ropeGlow : 0
    m.box(x0 - 0.1, h - t, y0 - 0.1 - t, x1 + 0.1, h + t, y0 - 0.1 + t, col, mat, em)
    m.box(x0 - 0.1, h - t, y1 + 0.1 - t, x1 + 0.1, h + t, y1 + 0.1 + t, col, mat, em)
    m.box(x0 - 0.1 - t, h - t, y0 - 0.1, x0 - 0.1 + t, h + t, y1 + 0.1, col, mat, em)
    m.box(x1 + 0.1 - t, h - t, y0 - 0.1, x1 + 0.1 + t, h + t, y1 + 0.1, col, mat, em)
  })
  // Pillars (speaker towers) and low striped walls.
  for (const b of BLOCKS) {
    const [bx0, by0, bx1, by1] = b.rect
    if (b.h > 1.5) {
      m.bevelBox(bx0, 0, by0, bx1, b.h, by1, 0.12, P.pillar, P.pillarTop, L)
      const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2
      m.prism(cx, cy, 0.38, 0.38, b.h, b.h + 0.04, 12, hex(0x141724), MAT.shiny)
      m.prism(cx, cy, 0.18, 0.18, b.h + 0.04, b.h + 0.06, 12, P.ropes[0]!, MAT.glow, 1.4)
      for (const yy of [0.5, 1.2]) m.box(bx0 - 0.01, yy, by0 - 0.01, bx1 + 0.01, yy + 0.12, by1 + 0.01, P.trim, L)
    } else {
      m.bevelBox(bx0, 0, by0, bx1, b.h, by1, 0.08, P.wall, P.wallTop, L)
      const n = Math.round((bx1 - bx0) / 0.5)
      for (let i = 0; i < n; i += 2) {
        const sx = bx0 + (i / n) * (bx1 - bx0)
        m.box(sx, 0.08, by0 - 0.01, sx + (bx1 - bx0) / n, b.h - 0.12, by1 + 0.01, P.trim, L)
      }
    }
  }
  const data = packVerts(m.v)
  const lighting = flatLighting(0, 1, P.bounce)
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
