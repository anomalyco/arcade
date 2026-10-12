import type { LightDef, MapDef, Wall } from "../../shared/maps"
import { SHOP_H as SHOP_TOP } from "../../shared/maps/downtown-town"
import { MAT, Mesh, type Rgb } from "./mesh"
import { PAL, buildProp, hex, rng } from "./models"
import { STREET_PROPS, STREET_WALLS, streetProp, streetWall } from "./street-models"

const FLOOR_KIND = { carpet: 0, tile: 1, wood: 2, concrete: 3, grate: 4, asphalt: 5, sidewalk: 6, plaza: 7, grass: 8, parking: 9 } as const
const FLOOR_COLOR = { carpet: PAL.carpet, tile: PAL.tile, wood: PAL.wood, concrete: PAL.concrete, grate: PAL.grate, asphalt: hex(0x24262c), sidewalk: hex(0x45484f), plaza: hex(0x4e5058), grass: hex(0x283a28), parking: hex(0x2a2c32) } as const
/** Downtown: sidewalks, plazas, parks and ground floors stand this far above the road, with curbs where they meet it. */
const CURB = 0.1
const LOW_FLOORS = new Set(["asphalt"])
/** Level geometry is cut into square chunks this wide so only those in view are drawn. */
const CHUNK = 12
/** Baked floor map resolution, metres per texel. */
const CELL = 0.125

export type LevelChunk = { data: ArrayBuffer; box: readonly [number, number, number, number] }
export type FloorMap = { data: Uint8Array<ArrayBuffer>; w: number; h: number }
export type LevelData = { chunks: LevelChunk[]; glass: ArrayBuffer; floor: FloorMap; bounce: FloorMap }
/** Bounce map resolution, metres per texel. */
const BOUNCE_CELL = 0.5

type Rect4 = readonly [number, number, number, number]

/** Geometry gets routed into the chunk containing its anchor point; each chunk records its real bounds. */
type Job = { x: number; z: number; build: (m: Mesh) => void }

function floorQuad(m: Mesh, r: Rect4, y: number, col: Rgb, mat: (typeof MAT)[keyof typeof MAT], aux = 0): void {
  m.quad([r[0], y, r[3]], [r[2], y, r[3]], [r[2], y, r[1]], [r[0], y, r[1]], [0, 1, 0], col, mat, aux)
}

function bounds(m: Mesh): [number, number, number, number] {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (let i = 0; i < m.v.length; i += 11) {
    const x = m.v[i]!
    const z = m.v[i + 2]!
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return [x0 - 0.2, z0 - 0.2, x1 + 0.2, z1 + 0.2]
}

/** A spatial lookup of wall rects, for finding free wall ends (door jambs). */
class WallGrid {
  private cells = new Map<number, number[]>()
  constructor(private walls: readonly Wall[]) {
    walls.forEach((w, i) => {
      for (let cy = Math.floor(w.rect[1] / 2); cy <= Math.floor(w.rect[3] / 2); cy++)
        for (let cx = Math.floor(w.rect[0] / 2); cx <= Math.floor(w.rect[2] / 2); cx++) {
          const k = cy * 4096 + cx
          let c = this.cells.get(k)
          if (!c) this.cells.set(k, (c = []))
          c.push(i)
        }
    })
  }
  hits(r: Rect4, skip: number): boolean {
    for (let cy = Math.floor(r[1] / 2); cy <= Math.floor(r[3] / 2); cy++)
      for (let cx = Math.floor(r[0] / 2); cx <= Math.floor(r[2] / 2); cx++)
        for (const i of this.cells.get(cy * 4096 + cx) ?? []) {
          if (i === skip) continue
          const w = this.walls[i]!.rect
          if (w[0] < r[2] && w[2] > r[0] && w[1] < r[3] && w[3] > r[1]) return true
        }
    return false
  }
}

/** Wall art and fittings on a face. `side` is the face's outward normal along the short axis. */
function decorate(m: Mesh, w: Wall, i: number, seed: number): void {
  const [x0, z0, x1, z1] = w.rect
  const horizontal = x1 - x0 >= z1 - z0
  const len = horizontal ? x1 - x0 : z1 - z0
  if (len < 1.6) return
  const r = rng(seed + i * 31)
  // Faces the camera can see: south faces of east-west walls, both faces of north-south walls but sparser.
  const faces: number[] = horizontal ? [1] : [-1, 1]
  for (const side of faces) {
    let u = 0.5 + r() * 1.5
    while (u < len - 0.8) {
      const pick = r()
      const at = (along: number, up: number, out: number): [number, number, number] =>
        horizontal ? [x0 + along, up, side > 0 ? z1 + out : z0 - out] : [side > 0 ? x1 + out : x0 - out, up, z0 + along]
      const plate = (a0: number, a1: number, y0: number, y1: number, depth: number, col: Rgb, mat: (typeof MAT)[keyof typeof MAT] = MAT.lit, aux = 0, out0 = 0) => {
        const p0 = at(a0, y0, out0)
        const p1 = at(a1, y1, out0 + depth)
        m.box(Math.min(p0[0], p1[0]), y0, Math.min(p0[2], p1[2]), Math.max(p0[0], p1[0]), y1, Math.max(p0[2], p1[2]), col, mat, aux)
      }
      if (!horizontal && pick > 0.35) {
        u += 2 + r() * 3
        continue
      }
      if (pick < 0.3) {
        // Framed print: dark frame, pale mount, a block of muted colour.
        const fw = 0.6 + r() * 0.5
        const fh = 0.45 + r() * 0.3
        const y = 1.35 + r() * 0.15
        plate(u, u + fw, y, y + fh, 0.03, hex(0x1b1d24))
        plate(u + 0.04, u + fw - 0.04, y + 0.04, y + fh - 0.04, 0.012, hex(0xb9b4a6), MAT.lit, 0, 0.03)
        const art = [hex(0x3c6e8a), hex(0x8a4a3a), hex(0x4a7a52), hex(0x7a6a9a), hex(0xb08a3a)][Math.floor(r() * 5)]!
        plate(u + 0.1, u + fw - 0.1, y + 0.1, y + fh - 0.1, 0.006, art, MAT.lit, 0, 0.042)
        u += fw + 1.5 + r() * 2.5
      } else if (pick < 0.48) {
        // Cork board with pinned notes.
        const fw = 0.9 + r() * 0.4
        const y = 1.2
        plate(u, u + fw, y, y + 0.65, 0.025, hex(0x4a3a2c))
        plate(u + 0.04, u + fw - 0.04, y + 0.04, y + 0.61, 0.01, hex(0x9a7448), MAT.lit, 0, 0.025)
        for (let k = 0; k < 5; k++) {
          const a = u + 0.1 + r() * (fw - 0.3)
          const yy = y + 0.1 + r() * 0.35
          plate(a, a + 0.12 + r() * 0.06, yy, yy + 0.14, 0.004, k % 3 === 0 ? hex(0xe8d870) : hex(0xe4e4dc), MAT.lit, 0, 0.035)
        }
        u += fw + 2 + r() * 2
      } else if (pick < 0.56) {
        // Fire extinguisher on a bracket.
        const p = at(u, 0, 0.12)
        m.prism(p[0], p[2], 0.08, 0.08, 0.35, 0.85, 8, hex(0xb02020), MAT.shiny)
        m.prism(p[0], p[2], 0.05, 0.03, 0.85, 0.95, 6, hex(0x1a1a1a))
        plate(u - 0.12, u + 0.12, 1.0, 1.25, 0.01, hex(0xb02020))
        u += 3 + r() * 3
      } else if (pick < 0.64) {
        // Wall clock.
        const p = at(u, 2.0, 0.02)
        m.box(p[0] - (horizontal ? 0.16 : 0.02), 1.84, p[2] - (horizontal ? 0.02 : 0.16), p[0] + (horizontal ? 0.16 : 0.02), 2.16, p[2] + (horizontal ? 0.02 : 0.16), hex(0x1d1f26))
        plate(u - 0.13, u + 0.13, 1.87, 2.13, 0.008, hex(0xdedbd2), MAT.lit, 0, 0.02)
        u += 4 + r() * 3
      } else if (pick < 0.72) {
        // Whiteboard strip with a few marks.
        const fw = 1.2 + r() * 0.6
        plate(u, u + fw, 1.0, 1.9, 0.02, hex(0xa6abb4))
        plate(u + 0.03, u + fw - 0.03, 1.03, 1.87, 0.006, hex(0xe8ecf0), MAT.shiny, 0, 0.02)
        for (let k = 0; k < 4; k++) {
          const a = u + 0.15 + r() * (fw - 0.6)
          const yy = 1.15 + r() * 0.6
          plate(a, a + 0.15 + r() * 0.3, yy, yy + 0.025, 0.003, [hex(0x2a4ab0), hex(0xb02a2a), hex(0x2a8a4a)][k % 3]!, MAT.lit, 0, 0.026)
        }
        u += fw + 2.5
      } else {
        u += 1.5 + r() * 2.5
      }
    }
  }
}

function wallGeometry(m: Mesh, w: Wall, i: number, grid: WallGrid, seed: number): void {
  const [x0, z0, x1, z1] = w.rect
  if (STREET_WALLS.has(w.style)) return streetWall(m, w, i, seed)
  switch (w.style) {
    case "wall":
    case "shop":
    case "core":
    case "pillar": {
      const side = w.style === "core" ? PAL.core : w.style === "pillar" ? PAL.pillar : w.style === "shop" ? SHOP_SIDE : PAL.wallSide
      const capH = 0.07
      m.box(x0, 0.1, z0, x1, w.h - capH, z1, side, MAT.wall)
      // Skirting, a hair proud of the face.
      m.box(x0 - 0.012, 0, z0 - 0.012, x1 + 0.012, 0.1, z1 + 0.012, PAL.skirting, MAT.wall)
      // Cap: a slightly overhanging, bevelled slab that reads from above even in the dark.
      m.bevelBox(x0 - 0.015, w.h - capH, z0 - 0.015, x1 + 0.015, w.h, z1 + 0.015, 0.035, PAL.capSide, PAL.wallTop, MAT.wall, MAT.cap, PAL.capEdge)
      if (w.style === "core" && x1 - x0 > 1.4 && z1 - z0 > 1.4) {
        // The lift shaft's roof: plant boxes, a hatch, ducts, a blinking beacon.
        const r = rng(seed + i * 53)
        const top = w.h
        const cx0 = x0 + 0.4
        const cz0 = z0 + 0.4
        const cw = x1 - x0 - 0.8
        const cd = z1 - z0 - 0.8
        m.box(x0 + 0.15, top, z0 + 0.15, x1 - 0.15, top + 0.02, z1 - 0.15, hex(0x262d40), MAT.cap)
        for (let k = 0; k < 2; k++) {
          const bw = Math.min(cw * 0.6, 0.5 + r() * 0.5)
          const bd = Math.min(cd * 0.4, 0.45 + r() * 0.4)
          const bx = cx0 + r() * Math.max(0, cw - bw)
          const bz = cz0 + r() * Math.max(0, cd - bd)
          m.bevelBox(bx, top, bz, bx + bw, top + 0.35 + r() * 0.3, bz + bd, 0.03, hex(0x3a4258), hex(0x4a5470))
          m.prism(bx + bw / 2, bz + bd / 2, Math.min(bw, bd) * 0.3, Math.min(bw, bd) * 0.3, top + 0.35, top + 0.66, 10, hex(0x22283a), MAT.lit, 0, true)
        }
        m.box(cx0 + cw * 0.1, top, cz0 + cd * 0.7, cx0 + cw * 0.1 + 0.55, top + 0.12, cz0 + cd * 0.7 + 0.55, hex(0x4a4f5e), MAT.lit, 0, hex(0x5a6070))
        m.box(cx0, top + 0.02, cz0 + cd * 0.45, cx0 + cw, top + 0.2, cz0 + cd * 0.45 + 0.25, hex(0x3a4050))
        m.prism(x1 - 0.5, z0 + 0.5, 0.05, 0.04, top, top + 0.25, 6, hex(0x2a2e38))
        m.prism(x1 - 0.5, z0 + 0.5, 0.04, 0.04, top + 0.25, top + 0.31, 6, hex(0xff2a2a), MAT.glow, 3)
      }
      if (w.style === "core") {
        const n = Math.max(1, Math.floor((x1 - x0) / 1.8))
        for (let k = 0; k < n; k++) {
          const cx = x0 + ((k + 0.5) * (x1 - x0)) / n
          for (const [za, zb] of [
            [z0 - 0.03, z0],
            [z1, z1 + 0.03],
          ] as const) {
            m.box(cx - 0.62, 0, za - 0.005, cx + 0.62, 2.28, zb + 0.005, PAL.doorFrame, MAT.wall)
            m.box(cx - 0.55, 0, za - 0.01, cx - 0.005, 2.2, zb + 0.01, PAL.steel, MAT.shiny)
            m.box(cx + 0.005, 0, za - 0.01, cx + 0.55, 2.2, zb + 0.01, PAL.steel, MAT.shiny)
          }
        }
      }
      if (w.style === "wall" || w.style === "shop") {
        // Door frames on free wall ends.
        const horizontal = x1 - x0 >= z1 - z0
        const ends: Rect4[] = horizontal
          ? [
              [x0 - 0.08, z0 + 0.05, x0 - 0.01, z1 - 0.05],
              [x1 + 0.01, z0 + 0.05, x1 + 0.08, z1 - 0.05],
            ]
          : [
              [x0 + 0.05, z0 - 0.08, x1 - 0.05, z0 - 0.01],
              [x0 + 0.05, z1 + 0.01, x1 - 0.05, z1 + 0.08],
            ]
        ends.forEach((e, k) => {
          if (grid.hits(e, i)) return
          const t = 0.07
          if (horizontal) {
            const ex = k === 0 ? x0 : x1
            const a = k === 0 ? ex : ex - t
            m.box(a - 0.005, 0, z0 - 0.035, a + t + 0.005, 2.25, z1 + 0.035, PAL.doorFrame, MAT.wall)
          } else {
            const ez = k === 0 ? z0 : z1
            const a = k === 0 ? ez : ez - t
            m.box(x0 - 0.035, 0, a - 0.005, x1 + 0.035, 2.25, a + t + 0.005, PAL.doorFrame, MAT.wall)
          }
        })
        if (w.style === "wall") decorate(m, w, i, seed)
      }
      break
    }
    case "partition":
    case "stall": {
      const fabric = w.style === "stall" ? PAL.stall : PAL.partition
      m.box(x0, 0.04, z0, x1, w.h - 0.05, z1, fabric, MAT.wall)
      m.box(x0 - 0.008, 0, z0 - 0.008, x1 + 0.008, 0.06, z1 + 0.008, PAL.skirting, MAT.wall)
      m.bevelBox(x0 - 0.012, w.h - 0.05, z0 - 0.012, x1 + 0.012, w.h, z1 + 0.012, 0.015, PAL.partitionCap, PAL.partitionCap, MAT.wall, MAT.shiny)
      break
    }
    case "rack": {
      // A row of server cabinets: lighter vented tops so the aisles read from above, unit seams, and columns of status
      // LEDs on both faces, some blinking.
      m.box(x0, 0, z0, x1, w.h - 0.04, z1, PAL.rack, MAT.wall)
      m.bevelBox(x0 - 0.01, w.h - 0.04, z0 - 0.01, x1 + 0.01, w.h, z1 + 0.01, 0.015, PAL.rack, hex(0x283048), MAT.wall, MAT.cap, hex(0x3c4870))
      const vertical = z1 - z0 > x1 - x0
      const len = vertical ? z1 - z0 : x1 - x0
      const r = rng(seed + i * 7)
      const unit = 0.6
      for (let k = 0; k + unit <= len + 0.01; k += unit) {
        const seam = k + unit - 0.015
        if (vertical) m.box(x0 - 0.006, 0.05, z0 + seam, x1 + 0.006, w.h - 0.02, z0 + seam + 0.03, hex(0x080a0e), MAT.wall)
        else m.box(x0 + seam, 0.05, z0 - 0.006, x0 + seam + 0.03, w.h - 0.02, z1 + 0.006, hex(0x080a0e), MAT.wall)
        // Vent grille on top.
        for (let g = 0.1; g < unit - 0.1; g += 0.08) {
          if (vertical) m.box(x0 + 0.08, w.h, z0 + k + g, x1 - 0.08, w.h + 0.004, z0 + k + g + 0.03, hex(0x161a24))
          else m.box(x0 + k + g, w.h, z0 + 0.08, x0 + k + g + 0.03, w.h + 0.004, z1 - 0.08, hex(0x161a24))
        }
        for (const side of [-1, 1]) {
          const cols = 1 + Math.floor(r() * 3)
          for (let c = 0; c < cols; c++) {
            const kk = k + 0.08 + c * 0.07
            for (let y = 0.35 + r() * 0.1; y < w.h - 0.25; y += 0.09 + Math.floor(r() * 3) * 0.045) {
              if (r() < 0.3) continue
              const roll = r()
              const col = roll < 0.55 ? hex(0x40ff90) : roll < 0.9 ? hex(0x3a8aff) : hex(0xffa040)
              const aux = r() < 0.3 ? 10 + r() : 2.5
              const face = side < 0 ? (vertical ? x0 : z0) : vertical ? x1 : z1
              const f0 = side < 0 ? face - 0.012 : face
              const f1 = side < 0 ? face : face + 0.012
              if (vertical) m.box(f0, y, z0 + kk, f1, y + 0.022, z0 + kk + 0.035, col, MAT.glow, aux)
              else m.box(x0 + kk, y, f0, x0 + kk + 0.035, y + 0.022, f1, col, MAT.glow, aux)
            }
          }
        }
      }
      break
    }
    case "shelf": {
      const r = rng(seed + i * 13)
      m.box(x0, 0, z0, x1, 0.06, z1, PAL.steel, MAT.wall)
      for (let y = 0.5; y < w.h; y += 0.55) m.box(x0, y, z0, x1, y + 0.04, z1, PAL.steel, MAT.wall)
      for (const [ax, az] of [
        [x0, z0],
        [x1 - 0.05, z0],
        [x0, z1 - 0.05],
        [x1 - 0.05, z1 - 0.05],
      ] as const)
        m.box(ax, 0, az, ax + 0.05, w.h, az + 0.05, hex(0x3a4050), MAT.wall)
      const vertical = z1 - z0 > x1 - x0
      const len = vertical ? z1 - z0 : x1 - x0
      for (let y = 0.06; y < w.h - 0.4; y += 0.55)
        for (let k = 0.05; k < len - 0.5; k += 0.5 + r() * 0.1) {
          if (r() < 0.25) continue
          const s = 0.25 + r() * 0.2
          const col = r() < 0.7 ? PAL.box : r() < 0.5 ? hex(0x3a4a6a) : hex(0xb8b8b0)
          const d = (vertical ? x1 - x0 : z1 - z0) - 0.12
          if (vertical) m.box(x0 + 0.06, y + 0.04, z0 + k, x0 + 0.06 + d * (0.7 + r() * 0.3), y + 0.04 + s, z0 + k + 0.4, col, MAT.wall)
          else m.box(x0 + k, y + 0.04, z0 + 0.06, x0 + k + 0.4, y + 0.04 + s, z0 + 0.06 + d * (0.7 + r() * 0.3), col, MAT.wall)
        }
      break
    }
  }
}

const SHOP_SIDE = hex(0x4e3c36)

function windowGeometry(m: Mesh, w: Rect4, shop: boolean): void {
  const [x0, z0, x1, z1] = w
  m.box(x0, 0, z0, x1, 0.35, z1, PAL.glassFrame, MAT.wall, 0, hex(0x3a4560))
  m.box(x0, 2.6, z0, x1, 2.75, z1, PAL.glassFrame, MAT.wall, 0, PAL.wallTop)
  if (shop) {
    // A shopfront: the wall carries on over the glass up to the parapet.
    m.box(x0, 2.75, z0, x1, SHOP_TOP - 0.07, z1, SHOP_SIDE, MAT.wall)
    m.bevelBox(x0 - 0.015, SHOP_TOP - 0.07, z0 - 0.015, x1 + 0.015, SHOP_TOP, z1 + 0.015, 0.035, PAL.capSide, PAL.wallTop, MAT.wall, MAT.cap, PAL.capEdge)
  }
  const horizontal = x1 - x0 > z1 - z0
  const len = horizontal ? x1 - x0 : z1 - z0
  for (let k = 0; k <= len; k += 2.4) {
    if (horizontal) m.box(x0 + k - 0.06, 0, z0, x0 + k + 0.06, 2.75, z1, PAL.glassFrame, MAT.wall, 0, PAL.wallTop)
    else m.box(x0, 0, z0 + k - 0.06, x1, 2.75, z0 + k + 0.06, PAL.glassFrame, MAT.wall, 0, PAL.wallTop)
  }
}

/** The letters E X I T as flat strokes on a sign's top face, reading along +x. */
function exitLetters(m: Mesh, cx: number, y: number, cz: number, along: boolean): void {
  const strokes: [number, number, number, number][] = [
    // E
    [-0.27, -0.05, -0.25, 0.05],
    [-0.27, -0.05, -0.18, -0.035],
    [-0.27, -0.008, -0.19, 0.008],
    [-0.27, 0.035, -0.18, 0.05],
    // I
    [0.04, -0.05, 0.06, 0.05],
    // T
    [0.11, -0.05, 0.25, -0.035],
    [0.17, -0.05, 0.19, 0.05],
  ]
  const col = hex(0xfff0f4)
  for (const [a0, b0, a1, b1] of strokes) {
    if (along) m.box(cx + a0, y, cz + b0, cx + a1, y + 0.006, cz + b1, col, MAT.glow, 5)
    else m.box(cx + b0, y, cz - a1, cx + b1, y + 0.006, cz - a0, col, MAT.glow, 5)
  }
  // X: two diagonal strokes.
  for (const yaw of [0.75, -0.75]) {
    if (along) m.yawBox(cx - 0.065, cz, 0.12, 0.018, y, y + 0.006, yaw, col, MAT.glow, 5)
    else m.yawBox(cx, cz + 0.065, 0.12, 0.018, y, y + 0.006, yaw + Math.PI / 2, col, MAT.glow, 5)
  }
}

function fixture(m: Mesh, l: LightDef, r: () => number): void {
  switch (l.kind) {
    case "panel": {
      // Twin-tube fluorescent fixture floating at its height (no ceiling is drawn).
      const along = r() < 0.5
      const hx = along ? 0.68 : 0.22
      const hz = along ? 0.22 : 0.68
      m.bevelBox(l.x - hx, l.h, l.y - hz, l.x + hx, l.h + 0.06, l.y + hz, 0.02, PAL.fixture, PAL.fixtureTop)
      // From above you see the diffuser glowing through louvres between the housing rails.
      m.box(l.x - hx + 0.06, l.h + 0.06, l.y - hz + 0.06, l.x + hx - 0.06, l.h + 0.065, l.y + hz - 0.06, hex(0xc8d4ee), MAT.lamp, l.id)
      for (let k = 1; k < 6; k++) {
        const f = k / 6
        if (along) m.box(l.x - hx + 0.06 + f * (hx - 0.06) * 2 - 0.008, l.h + 0.065, l.y - hz + 0.06, l.x - hx + 0.06 + f * (hx - 0.06) * 2 + 0.008, l.h + 0.075, l.y + hz - 0.06, PAL.fixtureTop)
        else m.box(l.x - hx + 0.06, l.h + 0.065, l.y - hz + 0.06 + f * (hz - 0.06) * 2 - 0.008, l.x + hx - 0.06, l.h + 0.075, l.y - hz + 0.06 + f * (hz - 0.06) * 2 + 0.008, PAL.fixtureTop)
      }
      m.box(l.x - hx + 0.05, l.h - 0.012, l.y - hz + 0.05, l.x + hx - 0.05, l.h + 0.002, l.y + hz - 0.05, hex(0x9aa6c0), MAT.lamp, l.id, undefined, true)
      for (const s of [-1, 1]) {
        if (along) m.box(l.x - hx + 0.07, l.h - 0.035, l.y + s * 0.08 - 0.025, l.x + hx - 0.07, l.h - 0.005, l.y + s * 0.08 + 0.025, hex(0xeef4ff), MAT.lamp, l.id, hex(0xeef4ff), true)
        else m.box(l.x + s * 0.08 - 0.025, l.h - 0.035, l.y - hz + 0.07, l.x + s * 0.08 + 0.025, l.h - 0.005, l.y + hz - 0.07, hex(0xeef4ff), MAT.lamp, l.id, hex(0xeef4ff), true)
      }
      // Two thin hangers up toward the slab above.
      for (const s of [-1, 1]) {
        const ax = along ? l.x + s * (hx - 0.12) : l.x
        const az = along ? l.y : l.y + s * (hz - 0.12)
        m.box(ax - 0.006, l.h + 0.06, az - 0.006, ax + 0.006, l.h + 0.5, az + 0.006, PAL.dark)
      }
      break
    }
    case "pendant":
      m.box(l.x - 0.008, l.h, l.y - 0.008, l.x + 0.008, l.h + 0.6, l.y + 0.008, PAL.dark)
      m.prism(l.x, l.y, 0.34, 0.1, l.h - 0.22, l.h, 10, hex(0x22242a), MAT.shiny)
      m.prism(l.x, l.y, 0.3, 0.3, l.h - 0.215, l.h - 0.2, 10, hex(0xffd9a0), MAT.lamp, l.id)
      m.prism(l.x, l.y, 0.09, 0.09, l.h - 0.24, l.h - 0.15, 8, hex(0xfff2d8), MAT.lamp, l.id)
      break
    case "bulb":
      if (l.h >= 2.2) {
        // Caged utility bulb on a short drop.
        m.box(l.x - 0.008, l.h + 0.1, l.y - 0.008, l.x + 0.008, l.h + 0.45, l.y + 0.008, PAL.dark)
        m.prism(l.x, l.y, 0.08, 0.06, l.h + 0.04, l.h + 0.12, 8, hex(0x2a2c32))
        m.prism(l.x, l.y, 0.07, 0.07, l.h - 0.1, l.h + 0.04, 8, hex(0xffcf90), MAT.lamp, l.id)
        for (let k = 0; k < 4; k++) {
          const a = (k / 4) * Math.PI * 2 + 0.4
          m.box(l.x + Math.cos(a) * 0.085 - 0.006, l.h - 0.12, l.y + Math.sin(a) * 0.085 - 0.006, l.x + Math.cos(a) * 0.085 + 0.006, l.h + 0.05, l.y + Math.sin(a) * 0.085 + 0.006, hex(0x2a2c32))
        }
      } else {
        // Standing floor lamp with a drum shade.
        m.prism(l.x, l.y, 0.18, 0.14, 0, 0.04, 8, PAL.dark)
        m.box(l.x - 0.015, 0, l.y - 0.015, l.x + 0.015, l.h - 0.2, l.y + 0.015, PAL.steel, MAT.shiny)
        m.prism(l.x, l.y, 0.26, 0.2, l.h - 0.25, l.h + 0.05, 10, hex(0xe8c8a0), MAT.lamp, l.id, false)
        m.prism(l.x, l.y, 0.2, 0.2, l.h + 0.04, l.h + 0.05, 10, hex(0xfff0d0), MAT.lamp, l.id)
      }
      break
    case "exit": {
      const dx = l.cone?.[0] ?? 0
      const dz = l.cone?.[1] ?? 1
      const cx = l.x - dx * 0.2
      const cz = l.y - dz * 0.2
      const along = Math.abs(dz) > 0.5
      const y0 = l.h - 0.1
      const y1 = l.h + 0.14
      if (along) {
        m.box(cx - 0.34, y0, cz - 0.09, cx + 0.34, y1, cz + 0.09, hex(0x2a0a14), MAT.lit)
        m.box(cx - 0.32, y0 + 0.02, cz - 0.095, cx + 0.32, y1 - 0.02, cz + 0.095, hex(0xff2a6a), MAT.lamp, l.id)
      } else {
        m.box(cx - 0.09, y0, cz - 0.34, cx + 0.09, y1, cz + 0.34, hex(0x2a0a14), MAT.lit)
        m.box(cx - 0.095, y0 + 0.02, cz - 0.32, cx + 0.095, y1 - 0.02, cz + 0.32, hex(0xff2a6a), MAT.lamp, l.id)
      }
      m.box(cx - (along ? 0.33 : 0.08), y1, cz - (along ? 0.08 : 0.33), cx + (along ? 0.33 : 0.08), y1 + 0.004, cz + (along ? 0.08 : 0.33), hex(0x7a1030), MAT.lamp, l.id)
      exitLetters(m, cx, y1 + 0.004, cz, along)
      break
    }
    case "server":
      m.box(l.x - 0.6, 2.62, l.y - 0.06, l.x + 0.6, 2.68, l.y + 0.06, PAL.fixture)
      m.box(l.x - 0.55, 2.68, l.y - 0.03, l.x + 0.55, 2.685, l.y + 0.03, hex(0x8ab8ff), MAT.lamp, l.id)
      m.box(l.x - 0.56, 2.6, l.y - 0.035, l.x + 0.56, 2.625, l.y + 0.035, hex(0x8ab8ff), MAT.lamp, l.id, undefined, true)
      break
  }
}

/** Haze cone under a ceiling fixture: a frustum from the lamp to the floor, drawn additively. */
function haze(m: Mesh, l: LightDef): void {
  const c = l.color as unknown as Rgb
  if (l.kind === "panel" || l.kind === "server") {
    const top = l.kind === "panel" ? 0.6 : 0.55
    const tw = 0.18
    const bw = l.kind === "panel" ? 1.9 : 1.4
    const y0 = 0
    const y1 = l.h - 0.04
    const bh = bw * 0.75
    const corners = (hx: number, hz: number, y: number) => [
      [l.x - hx, y, l.y - hz],
      [l.x + hx, y, l.y - hz],
      [l.x + hx, y, l.y + hz],
      [l.x - hx, y, l.y + hz],
    ]
    const t = corners(top, tw, y1)
    const b = corners(bw, bh, y0)
    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4
      m.quadAuto(b[k]!, b[k2]!, t[k2]!, t[k]!, c, MAT.haze, l.id)
    }
  } else if (l.kind === "pendant" || (l.kind === "bulb" && l.h >= 2.2) || l.kind === "street" || l.kind === "flood") {
    const sides = 10
    const rt = l.kind === "pendant" ? 0.28 : l.kind === "street" ? 0.14 : l.kind === "flood" ? 0.5 : 0.1
    const rb = l.kind === "pendant" ? 1.4 : l.kind === "street" ? 2.3 : l.kind === "flood" ? 3.6 : 1.1
    const y1 = l.kind === "pendant" ? l.h - 0.22 : l.kind === "street" ? l.h - 0.3 : l.h
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2
      const a1 = ((k + 1) / sides) * Math.PI * 2
      m.quadAuto(
        [l.x + Math.cos(a0) * rb, 0, l.y + Math.sin(a0) * rb],
        [l.x + Math.cos(a0) * rt, y1, l.y + Math.sin(a0) * rt],
        [l.x + Math.cos(a1) * rt, y1, l.y + Math.sin(a1) * rt],
        [l.x + Math.cos(a1) * rb, 0, l.y + Math.sin(a1) * rb],
        c,
        MAT.haze,
        l.id,
      )
    }
  }
}

/** Dust specks hanging in a fixture's light; the vertex shader drifts them and turns each quad to face the camera. */
function motes(m: Mesh, l: LightDef, r: () => number): void {
  const n = l.kind === "panel" ? 26 : l.kind === "pendant" || l.kind === "desk" ? 16 : l.kind === "bulb" || l.kind === "vending" ? 12 : 0
  const c = l.color as unknown as Rgb
  for (let k = 0; k < n; k++) {
    const y = 0.25 + r() * (l.h - 0.35)
    // Wider near the floor, like the light itself.
    const spread = 0.25 + (1 - y / Math.max(l.h, 0.5)) * (l.kind === "desk" ? 0.8 : 1.4)
    const a = r() * Math.PI * 2
    const d = Math.sqrt(r()) * spread
    const p = [l.x + Math.cos(a) * d, y, l.y + Math.sin(a) * d]
    const ph = r() * 2 - 1
    const corner = (u: number, v: number) => m.vert(p, [u, v, ph], c, MAT.mote, l.id)
    corner(-1, -1)
    corner(1, -1)
    corner(1, 1)
    corner(-1, -1)
    corner(1, 1)
    corner(-1, 1)
  }
}

/**
 * Bakes the floor map: r = ambient occlusion from walls and furniture (blurred footprint coverage), g = moonlight
 * falling through the outer windows, striped by mullions and stopped by walls.
 */
export function bakeFloor(map: MapDef): FloorMap {
  const [W, H] = map.size
  const w = Math.max(1, Math.ceil(W / CELL))
  const h = Math.max(1, Math.ceil(H / CELL))
  const cx = W / w
  const cy = H / h
  const occ = new Float32Array(w * h)
  const fill = (r: Rect4, v: number) => {
    const a0 = Math.max(0, Math.floor(r[0] / cx))
    const a1 = Math.min(w - 1, Math.ceil(r[2] / cx) - 1)
    const b0 = Math.max(0, Math.floor(r[1] / cy))
    const b1 = Math.min(h - 1, Math.ceil(r[3] / cy) - 1)
    for (let y = b0; y <= b1; y++) for (let x = a0; x <= a1; x++) occ[y * w + x] = Math.max(occ[y * w + x]!, v)
  }
  for (const wl of map.walls) fill(wl.rect, wl.h >= 2 ? 1 : 0.7)
  for (const r of map.windows) fill(r, 0.6)
  const PROP_AO: Record<string, number> = { tree: 0.3, bench: 0.3, bin: 0.4, newsbox: 0.45, desk: 0.55, table: 0.35, cabinet: 0.9, sofa: 0.8, vending: 1, copier: 0.85, printer: 0.8, counter: 0.9, fridge: 1, cooler: 0.6, bookshelf: 1, crate: 0.85, reception: 0.9, plant: 0.4, chair: 0.2 }
  for (const p of map.props) fill(p.rect, PROP_AO[p.kind] ?? 0)
  const walls = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) walls[i] = occ[i]! >= 0.95 ? 1 : 0
  // Two box blurs of ~0.5 m make a soft tent falloff.
  const tmp = new Float32Array(w * h)
  const blur = (src: Float32Array, dst: Float32Array, rad: number) => {
    const inv = 1 / (rad * 2 + 1)
    for (let y = 0; y < h; y++) {
      let acc = 0
      for (let x = -rad; x <= rad; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))]!
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = acc * inv
        acc += src[y * w + Math.min(w - 1, x + rad + 1)]! - src[y * w + Math.max(0, x - rad)]!
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let y = -rad; y <= rad; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!
      for (let y = 0; y < h; y++) {
        dst[y * w + x] = acc * inv
        acc += tmp[Math.min(h - 1, y + rad + 1) * w + x]! - tmp[Math.max(0, y - rad) * w + x]!
      }
    }
  }
  const ao = new Float32Array(w * h)
  blur(occ, ao, 3)
  blur(ao, ao, 3)

  const moon = new Float32Array(w * h)
  if (map.kind === "downtown") skyMoon(map, moon, w, h, cx, cy)
  // Moonlight: trace each texel near a window back along the moon direction to the glass.
  const tanE = 0.62
  const [mcx, mcy] = [W / 2, H / 2]
  for (const win of map.windows) {
    const horizontal = win[2] - win[0] > win[3] - win[1]
    // Inward normal: away from the map edge the window sits on.
    const nx = horizontal ? 0 : (win[0] + win[2]) / 2 < mcx ? 1 : -1
    const ny = horizontal ? ((win[1] + win[3]) / 2 < mcy ? 1 : -1) : 0
    // Slant the moon 35 degrees off the normal.
    const s = Math.sin(0.6)
    const c = Math.cos(0.6)
    const mx = nx * c - ny * s
    const my = nx * s + ny * c
    const reach = 2.7 / tanE + 0.5
    const line = horizontal ? (ny > 0 ? win[3] : win[1]) : nx > 0 ? win[2] : win[0]
    const bx0 = Math.min(win[0], win[0] + mx * reach) - 1
    const bx1 = Math.max(win[2], win[2] + mx * reach) + 1
    const by0 = Math.min(win[1], win[1] + my * reach) - 1
    const by1 = Math.max(win[3], win[3] + my * reach) + 1
    for (let ty = Math.max(0, Math.floor(by0 / cy)); ty <= Math.min(h - 1, Math.ceil(by1 / cy)); ty++)
      for (let tx = Math.max(0, Math.floor(bx0 / cx)); tx <= Math.min(w - 1, Math.ceil(bx1 / cx)); tx++) {
        const px = (tx + 0.5) * cx
        const py = (ty + 0.5) * cy
        // Distance back along -moon to the window line.
        const dist = horizontal ? (py - line) / my : (px - line) / mx
        if (!(dist > 0)) continue
        const hy = dist * tanE
        if (hy < 0.35 || hy > 2.6) continue
        const hx = horizontal ? px - mx * dist : py - my * dist
        const a0 = horizontal ? win[0] : win[1]
        const a1 = horizontal ? win[2] : win[3]
        if (hx < a0 || hx > a1) continue
        const mull = (hx - a0) % 2.4
        if (mull < 0.08 || mull > 2.32) continue
        // Stopped by walls on the way.
        let blocked = false
        for (let k = 0.3; k < dist - 0.2; k += CELL * 1.5) {
          const qx = Math.floor((px - mx * k) / cx)
          const qy = Math.floor((py - my * k) / cy)
          if (qx >= 0 && qy >= 0 && qx < w && qy < h && walls[qy * w + qx]) {
            blocked = true
            break
          }
        }
        if (blocked) continue
        // Soft at the sill and head edges.
        const edge = Math.min(1, (hy - 0.35) / 0.2, (2.6 - hy) / 0.3)
        moon[ty * w + tx] = Math.max(moon[ty * w + tx]!, edge)
      }
  }
  blur(moon, moon, 1)

  const data = new Uint8Array(w * h * 2)
  for (let i = 0; i < w * h; i++) {
    data[i * 2] = Math.min(255, Math.round(Math.min(1, ao[i]! * 1.25) * 255))
    data[i * 2 + 1] = Math.round(Math.min(1, moon[i]!) * 255)
  }
  return { data, w, h }
}

/**
 * Bakes indirect light: each light's colour flood-filled through open floor (walls block, low partitions don't) with a
 * falloff by path length, so a lit room glows faintly into the corridor through its door and around corners. Stored as
 * sqrt(rgb) for precision in the dark.
 */
export function bakeBounce(map: MapDef): FloorMap {
  const [W, H] = map.size
  const w = Math.max(1, Math.ceil(W / BOUNCE_CELL))
  const h = Math.max(1, Math.ceil(H / BOUNCE_CELL))
  const cx = W / w
  const cy = H / h
  const solid = new Uint8Array(w * h)
  for (const wl of map.walls) {
    if (wl.h < 1.8) continue
    const r = wl.rect
    // Only cells mostly covered by the wall block, so thin walls between cells still stop the fill.
    const a0 = Math.max(0, Math.floor(r[0] / cx))
    const a1 = Math.min(w - 1, Math.ceil(r[2] / cx) - 1)
    const b0 = Math.max(0, Math.floor(r[1] / cy))
    const b1 = Math.min(h - 1, Math.ceil(r[3] / cy) - 1)
    for (let y = b0; y <= b1; y++) for (let x = a0; x <= a1; x++) solid[y * w + x] = 1
  }
  const acc = new Float32Array(w * h * 3)
  const dist = new Float32Array(w * h).fill(Infinity)
  const touched: number[] = []
  const N8 = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const
  const STRENGTH: Record<string, number> = { desk: 0.6, panel: 1, pendant: 1, exit: 0.8, vending: 1.2, server: 0.7, bulb: 0.9, street: 0.8, signal: 0.5, neon: 1.1, fire: 1.2, flood: 0.8, glow: 0.9 }
  for (const l of map.lights) {
    const reach = l.r * 1.5
    const sx = Math.min(w - 1, Math.max(0, Math.floor(l.x / cx)))
    const sy = Math.min(h - 1, Math.max(0, Math.floor(l.y / cy)))
    // Dijkstra over the grid with a simple binary heap.
    const heap: number[] = []
    const push = (i: number, d: number) => {
      heap.push(d, i)
      let k = heap.length / 2 - 1
      while (k > 0) {
        const p = ((k - 1) >> 1)
        if (heap[p * 2]! <= heap[k * 2]!) break
        ;[heap[p * 2], heap[k * 2]] = [heap[k * 2]!, heap[p * 2]!]
        ;[heap[p * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[p * 2 + 1]!]
        k = p
      }
    }
    const pop = (): [number, number] => {
      const d = heap[0]!
      const i = heap[1]!
      const ld = heap.pop()!
      const li = heap.pop()!
      // pop() took index then distance from the end; restore order.
      if (heap.length) {
        heap[0] = li
        heap[1] = ld
        let k = 0
        const n = heap.length / 2
        for (;;) {
          const a = k * 2 + 1
          const b = a + 1
          let m = k
          if (a < n && heap[a * 2]! < heap[m * 2]!) m = a
          if (b < n && heap[b * 2]! < heap[m * 2]!) m = b
          if (m === k) break
          ;[heap[m * 2], heap[k * 2]] = [heap[k * 2]!, heap[m * 2]!]
          ;[heap[m * 2 + 1], heap[k * 2 + 1]] = [heap[k * 2 + 1]!, heap[m * 2 + 1]!]
          k = m
        }
      }
      return [d, i]
    }
    dist[sy * w + sx] = 0
    touched.push(sy * w + sx)
    push(sy * w + sx, 0)
    while (heap.length) {
      const [d, i] = pop()
      if (d > dist[i]!) continue
      const x = i % w
      const y = (i / w) | 0
      for (const [dx, dy, c] of N8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = ny * w + nx
        if (solid[j]) continue
        // No cutting wall corners diagonally.
        if (dx && dy && (solid[y * w + nx] || solid[ny * w + x])) continue
        const nd = d + c * cx
        if (nd >= reach || nd >= dist[j]!) continue
        if (dist[j] === Infinity) touched.push(j)
        dist[j] = nd
        push(j, nd)
      }
    }
    const k = l.power * (STRENGTH[l.kind] ?? 1)
    for (const i of touched) {
      const t = 1 - dist[i]! / reach
      const f = t * t * k
      acc[i * 3] += l.color[0] * f
      acc[i * 3 + 1] += l.color[1] * f
      acc[i * 3 + 2] += l.color[2] * f
      dist[i] = Infinity
    }
    touched.length = 0
  }
  const data = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.sqrt(Math.min(1, acc[i * 3 + c]! * 0.5)) * 255)
    data[i * 4 + 3] = solid[i] ? 0 : 255
  }
  return { data, w, h }
}

/** Static geometry for a floor, chunked: floors, walls and their fittings, windows' frames, furniture, light fixtures. */
export function buildLevel(map: MapDef): LevelData {
  const [W, H] = map.size
  const jobs: Job[] = []
  const grid = new WallGrid(map.walls)
  const seed = map.seed

  const downtown = map.kind === "downtown"
  // Floors, cut into chunk-sized pieces. Downtown, everything but the roads stands on a curb.
  map.floors.forEach((f, i) => {
    const y = (i === 0 ? 0 : 0.002 + (i % 8) * 0.0004) + (downtown && !LOW_FLOORS.has(f.kind) ? CURB : 0)
    for (let x = f.rect[0]; x < f.rect[2] - 1e-3; x += CHUNK)
      for (let z = f.rect[1]; z < f.rect[3] - 1e-3; z += CHUNK) {
        const r: Rect4 = [x, z, Math.min(f.rect[2], x + CHUNK), Math.min(f.rect[3], z + CHUNK)]
        jobs.push({ x: (r[0] + r[2]) / 2, z: (r[1] + r[3]) / 2, build: (m) => floorQuad(m, r, y, FLOOR_COLOR[f.kind], MAT.floor, FLOOR_KIND[f.kind]) })
      }
  })
  for (const t of map.tape) jobs.push({ x: (t[0] + t[2]) / 2, z: (t[1] + t[3]) / 2, build: (m) => floorQuad(m, t, 0.012, PAL.tape, MAT.tape) })
  if (downtown) {
    const raised = map.floors.filter((f) => !LOW_FLOORS.has(f.kind)).map((f) => f.rect)
    for (const p of map.paint ?? []) {
      const cx = (p.rect[0] + p.rect[2]) / 2
      const cz = (p.rect[1] + p.rect[3]) / 2
      const y = 0.008 + (raised.some((r) => cx > r[0] && cx < r[2] && cz > r[1] && cz < r[3]) ? CURB : 0)
      const col = p.color === "white" ? hex(0x666a72) : hex(0x8a6820)
      // Long lines are cut so each piece lands in the chunk it crosses.
      const ax = p.rect[2] - p.rect[0] >= p.rect[3] - p.rect[1]
      for (let a = ax ? p.rect[0] : p.rect[1]; a < (ax ? p.rect[2] : p.rect[3]) - 1e-3; a += CHUNK) {
        const r: Rect4 = ax ? [a, p.rect[1], Math.min(p.rect[2], a + CHUNK), p.rect[3]] : [p.rect[0], a, p.rect[2], Math.min(p.rect[3], a + CHUNK)]
        jobs.push({ x: (r[0] + r[2]) / 2, z: (r[1] + r[3]) / 2, build: (m) => floorQuad(m, r, y, col, MAT.tape) })
      }
    }
    for (const c of curbs(map)) jobs.push({ x: (c[0] + c[2]) / 2, z: (c[1] + c[3]) / 2, build: (m) => m.box(c[0], 0, c[1], c[2], CURB + 0.004, c[3], hex(0x5e6168), MAT.lit, 0, hex(0x6c6f76)) })
  }
  map.walls.forEach((w, i) => jobs.push({ x: (w.rect[0] + w.rect[2]) / 2, z: (w.rect[1] + w.rect[3]) / 2, build: (m) => wallGeometry(m, w, i, grid, seed) }))
  for (const w of map.windows) jobs.push({ x: (w[0] + w[2]) / 2, z: (w[1] + w[3]) / 2, build: (m) => windowGeometry(m, w, downtown) })
  map.props.forEach((p, i) => jobs.push({ x: (p.rect[0] + p.rect[2]) / 2, z: (p.rect[1] + p.rect[3]) / 2, build: (m) => (STREET_PROPS.has(p.kind) ? streetProp(m, p, seed + i * 17, map) : buildProp(m, p, seed + i * 17)) }))
  for (const l of map.lights) jobs.push({ x: l.x, z: l.y, build: (m) => fixture(m, l, rng(seed + l.id * 101)) })

  const buckets = new Map<number, Job[]>()
  for (const j of jobs) {
    const k = Math.floor(j.z / CHUNK) * 1024 + Math.floor(j.x / CHUNK)
    let b = buckets.get(k)
    if (!b) buckets.set(k, (b = []))
    b.push(j)
  }
  const chunks: LevelChunk[] = []
  // The city far below and the slab edge are always drawn.
  const base = new Mesh()
  if (downtown) surroundings(base, map)
  else {
    base.quad([-200, -36, 200], [200, -36, 200], [200, -36, -200], [-200, -36, -200], [0, 1, 0], [0, 0, 0], MAT.city)
    base.box(-0.4, -0.8, -0.4, W + 0.4, -0.01, H + 0.4, hex(0x141826))
  }
  chunks.push({ data: base.pack(), box: [-1e5, -1e5, 1e5, 1e5] })
  for (const b of buckets.values()) {
    const m = new Mesh()
    for (const j of b) j.build(m)
    if (m.count) chunks.push({ data: m.pack(), box: bounds(m) })
  }

  const glass = new Mesh()
  const G = hex(0x8fb8e8)
  for (const w of map.windows) glass.box(w[0] + 0.12, 0.35, w[1] + 0.12, w[2] - 0.12, 2.6, w[3] - 0.12, G, MAT.glass)
  for (const g of map.glass) glass.box(g[0], 0, g[1], g[2], 2.5, g[3], G, MAT.glass)
  for (const l of map.lights) haze(glass, l)
  for (const l of map.lights) motes(glass, l, rng(seed + l.id * 7 + 3))

  return { chunks, glass: glass.pack(), floor: bakeFloor(map), bounce: bakeBounce(map) }
}

/** Downtown's sidewalk edges that face the road: a curb along each, from the road up to the sidewalk. */
function curbs(map: MapDef): Rect4[] {
  const raised = map.floors.filter((f) => !LOW_FLOORS.has(f.kind)).map((f) => f.rect)
  const inside = (x: number, y: number) => raised.some((r) => x > r[0] && x < r[2] && y > r[1] && y < r[3])
  const out: Rect4[] = []
  const T = 0.14
  for (const r of raised) {
    for (const side of ["n", "s", "w", "e"] as const) {
      const hz = side === "n" || side === "s"
      const a0 = hz ? r[0] : r[1]
      const a1 = hz ? r[2] : r[3]
      const line = side === "n" ? r[1] : side === "s" ? r[3] : side === "w" ? r[0] : r[2]
      const o = side === "n" || side === "w" ? -0.05 : 0.05
      let run = -1
      const flush = (end: number) => {
        if (run < 0 || end - run < 0.1) return
        const lo = side === "n" || side === "w" ? line : line - T
        out.push(hz ? [run, lo, end, lo + T] : [lo, run, lo + T, end])
      }
      for (let a = a0; a <= a1 + 1e-6; a += 0.25) {
        const u = Math.min(a + 0.125, a1 - 0.01)
        const open = a < a1 - 1e-6 && !(hz ? inside(u, line + o) : inside(line + o, u))
        if (open && run < 0) run = a
        if (!open && run >= 0) {
          flush(Math.min(a, a1))
          run = -1
        }
      }
      flush(a1)
    }
  }
  return out
}

/**
 * Downtown has no windows to let the moon in: it falls on the open ground from high in the north-north-west, and the
 * buildings cast long shadows toward the camera.
 */
function skyMoon(map: MapDef, moon: Float32Array, w: number, h: number, cx: number, cy: number): void {
  const S = 2
  const hw = Math.ceil(w / S)
  const hh = Math.ceil(h / S)
  const hm = new Float32Array(hw * hh)
  for (const wl of map.walls) {
    if (wl.h < 1.5) continue
    const r = wl.rect
    for (let y = Math.max(0, Math.floor(r[1] / (cy * S))); y <= Math.min(hh - 1, Math.ceil(r[3] / (cy * S)) - 1); y++)
      for (let x = Math.max(0, Math.floor(r[0] / (cx * S))); x <= Math.min(hw - 1, Math.ceil(r[2] / (cx * S)) - 1); x++) hm[y * hw + x] = Math.max(hm[y * hw + x]!, wl.h)
  }
  // Toward the moon on the plan, and how fast the ray climbs per metre.
  const dx = -0.32
  const dy = -0.95
  const climb = 0.95
  const stepM = cx * S
  const maxD = 11 / climb
  const lo = new Float32Array(hw * hh)
  for (let ty = 0; ty < hh; ty++)
    for (let tx = 0; tx < hw; tx++) {
      if (hm[ty * hw + tx]! > 0) continue
      const px = (tx + 0.5) * stepM
      const py = (ty + 0.5) * stepM
      let lit = 1
      for (let d = stepM; d < maxD; d += stepM) {
        const qx = Math.floor((px + dx * d) / stepM)
        const qy = Math.floor((py + dy * d) / stepM)
        if (qx < 0 || qy < 0 || qx >= hw || qy >= hh) break
        if (hm[qy * hw + qx]! > d * climb) {
          lit = 0
          break
        }
      }
      lo[ty * hw + tx] = lit
    }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) moon[y * w + x] = lo[Math.min(hh - 1, Math.floor(y / S)) * hw + Math.min(hw - 1, Math.floor(x / S))]!
}

/** Outside a downtown map: more city, a ring of rooftops round the edge with the roads running on into it. */
function surroundings(m: Mesh, map: MapDef): void {
  const [W, H] = map.size
  const r = rng(map.seed * 13 + 5)
  m.quad([-200, -0.02, 200], [200, -0.02, 200], [200, -0.02, -200], [-200, -0.02, -200], [0, 1, 0], hex(0x0e1016), MAT.lit)
  const D = 34
  const exits = (map.roads ?? []).map((rd) => rd.rect).filter((rc) => rc[0] < 0.5 || rc[1] < 0.5 || rc[2] > W - 0.5 || rc[3] > H - 0.5)
  // The roads that leave the map carry on into the city.
  for (const e of exits) {
    const pad = 3
    if (e[1] < 0.5) floorQuad(m, [e[0] - pad, -D, e[2] + pad, 0], -0.01, hex(0x24262c), MAT.floor, 5)
    if (e[3] > H - 0.5) floorQuad(m, [e[0] - pad, H, e[2] + pad, H + D], -0.01, hex(0x24262c), MAT.floor, 5)
    if (e[0] < 0.5) floorQuad(m, [-D, e[1] - pad, 0, e[3] + pad], -0.01, hex(0x24262c), MAT.floor, 5)
    if (e[2] > W - 0.5) floorQuad(m, [W, e[1] - pad, W + D, e[3] + pad], -0.01, hex(0x24262c), MAT.floor, 5)
  }
  const blocked = (rc: Rect4) => exits.some((e) => {
    const pad = 3.2
    return rc[0] < e[2] + pad && rc[2] > e[0] - pad && rc[1] < e[3] + pad && rc[3] > e[1] - pad && !(e[0] > 0.5 && e[2] < W - 0.5 && e[1] > 0.5 && e[3] < H - 0.5)
  })
  const extend = (e: Rect4): Rect4 => [e[0] < 0.5 ? -D : e[0], e[1] < 0.5 ? -D : e[1], e[2] > W - 0.5 ? W + D : e[2], e[3] > H - 0.5 ? H + D : e[3]]
  const lanes = exits.map(extend)
  const put = (rc: Rect4) => {
    if (lanes.some((e) => rc[0] < e[2] + 3 && rc[2] > e[0] - 3 && rc[1] < e[3] + 3 && rc[3] > e[1] - 3)) return
    const ht = 7 + r() * 8
    const v = Math.floor(r() * 65536)
    streetWall(m, { rect: rc, h: ht, style: "building", v }, 0, map.seed)
  }
  void blocked
  // Rows of blocks along each side, two deep, of varied widths.
  for (const [a0, a1, side] of [[-D, W + D, "n"], [-D, W + D, "s"], [0, H, "w"], [0, H, "e"]] as const) {
    for (let a = a0; a < a1; ) {
      const len = 9 + r() * 12
      const b = Math.min(a1, a + len)
      for (const [d0, d1] of [[0, 14 + r() * 4], [18 + r() * 2, D]] as const) {
        const rc: Rect4 = side === "n" ? [a, -d1, b, -d0] : side === "s" ? [a, H + d0, b, H + d1] : side === "w" ? [-d1, a, -d0, b] : [W + d0, a, W + d1, b]
        if (b - a > 4) put(rc)
      }
      a = b + (r() < 0.25 ? 3 : 0)
    }
  }
}
