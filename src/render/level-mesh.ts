import type { MapDef } from "../../shared/maps"
import { MAT, Mesh, type Rgb } from "./mesh"
import { PAL, buildProp, hex } from "./models"

const FLOOR_KIND = { carpet: 0, tile: 1, wood: 2, concrete: 3, grate: 4 } as const
const FLOOR_COLOR = { carpet: PAL.carpet, tile: PAL.tile, wood: PAL.wood, concrete: PAL.concrete, grate: PAL.grate } as const

function floorQuad(m: Mesh, r: readonly number[], y: number, col: Rgb, mat: (typeof MAT)[keyof typeof MAT], aux = 0): void {
  m.quad([r[0]!, y, r[3]!], [r[2]!, y, r[3]!], [r[2]!, y, r[1]!], [r[0]!, y, r[1]!], [0, 1, 0], col, mat, aux)
}

/** Static opaque geometry for a floor: the city below, floors, walls, windows' frames, furniture and light fixtures. */
export function buildLevel(map: MapDef): Mesh {
  const m = new Mesh()
  const [W, H] = map.size
  m.quad([-120, -36, 120], [120, -36, 120], [120, -36, -120], [-120, -36, -120], [0, 1, 0], [0, 0, 0], MAT.city)
  // The slab edge of the tower floor.
  m.box(-0.4, -0.8, -0.4, W + 0.4, -0.01, H + 0.4, hex(0x141826))

  map.floors.forEach((f, i) => floorQuad(m, f.rect, i === 0 ? 0 : 0.002 + i * 0.0004, FLOOR_COLOR[f.kind], MAT.floor, FLOOR_KIND[f.kind]))
  for (const t of map.tape) floorQuad(m, t, 0.012, hex(0x9a7a2a), MAT.tape)

  for (const w of map.walls) {
    const [x0, z0, x1, z1] = w.rect
    switch (w.style) {
      case "wall":
        m.box(x0, 0, z0, x1, w.h, z1, PAL.wallSide, MAT.wall, 0, PAL.wallTop)
        break
      case "partition":
      case "stall":
        m.box(x0, 0, z0, x1, w.h - 0.04, z1, PAL.partition, MAT.wall)
        m.box(x0 - 0.01, w.h - 0.04, z0 - 0.01, x1 + 0.01, w.h, z1 + 0.01, PAL.partitionCap, MAT.wall)
        break
      case "pillar":
        m.box(x0, 0, z0, x1, w.h, z1, PAL.pillar, MAT.wall, 0, hex(0x6a7086))
        break
      case "core": {
        // Lift shafts and stairwells: a dark block with steel doors on its long faces.
        m.box(x0, 0, z0, x1, w.h, z1, PAL.core, MAT.wall, 0, hex(0x3a4154))
        const n = Math.max(1, Math.floor((x1 - x0) / 1.8))
        for (let i = 0; i < n; i++) {
          const cx = x0 + ((i + 0.5) * (x1 - x0)) / n
          m.box(cx - 0.55, 0, z0 - 0.02, cx + 0.55, 2.2, z0, PAL.steel, MAT.wall)
          m.box(cx - 0.55, 0, z1, cx + 0.55, 2.2, z1 + 0.02, PAL.steel, MAT.wall)
        }
        break
      }
      case "rack": {
        m.box(x0, 0, z0, x1, w.h, z1, PAL.rack, MAT.wall, 0, hex(0x232835))
        const vertical = z1 - z0 > x1 - x0
        const len = vertical ? z1 - z0 : x1 - x0
        for (let k = 0.3; k < len - 0.2; k += 0.6)
          for (let y = 0.3; y < w.h - 0.2; y += 0.35) {
            const col = (Math.floor(k * 7 + y * 13) % 3 === 0 ? hex(0x40ff90) : hex(0x3a7aff)) as Rgb
            if (vertical) {
              m.box(x0 - 0.01, y, z0 + k, x0, y + 0.03, z0 + k + 0.06, col, MAT.glow, 2.5)
              m.box(x1, y, z0 + k, x1 + 0.01, y + 0.03, z0 + k + 0.06, col, MAT.glow, 2.5)
            } else {
              m.box(x0 + k, y, z0 - 0.01, x0 + k + 0.06, y + 0.03, z0, col, MAT.glow, 2.5)
              m.box(x0 + k, y, z1, x0 + k + 0.06, y + 0.03, z1 + 0.01, col, MAT.glow, 2.5)
            }
          }
        break
      }
      case "shelf": {
        m.box(x0, 0, z0, x1, 0.06, z1, PAL.steel, MAT.wall)
        for (let y = 0.5; y < w.h; y += 0.55) m.box(x0, y, z0, x1, y + 0.04, z1, PAL.steel, MAT.wall)
        for (const [ax, az] of [
          [x0, z0],
          [x1 - 0.05, z0],
          [x0, z1 - 0.05],
          [x1 - 0.05, z1 - 0.05],
        ] as const)
          m.box(ax, 0, az, ax + 0.05, w.h, az + 0.05, PAL.steel, MAT.wall)
        const vertical = z1 - z0 > x1 - x0
        const len = vertical ? z1 - z0 : x1 - x0
        for (let y = 0.06; y < w.h - 0.4; y += 0.55)
          for (let k = 0.05; k < len - 0.5; k += 0.55) {
            const s = 0.32 + ((k * 13 + y * 7) % 0.15)
            if ((k * 31 + y * 17) % 1 < 0.25) continue
            if (vertical) m.box(x0 + 0.05, y + 0.04, z0 + k, x1 - 0.05, y + 0.04 + s, z0 + k + 0.45, PAL.box, MAT.wall)
            else m.box(x0 + k, y + 0.04, z0 + 0.05, x0 + k + 0.45, y + 0.04 + s, z1 - 0.05, PAL.box, MAT.wall)
          }
        break
      }
    }
  }

  // Window frames: a sill, mullions every 2.4 m and a head beam. The glass itself is in the transparent mesh.
  for (const w of map.windows) {
    const [x0, z0, x1, z1] = w
    m.box(x0, 0, z0, x1, 0.35, z1, PAL.glassFrame, MAT.wall, 0, hex(0x2c3346))
    m.box(x0, 2.6, z0, x1, 2.75, z1, PAL.glassFrame, MAT.wall)
    const horizontal = x1 - x0 > z1 - z0
    const len = horizontal ? x1 - x0 : z1 - z0
    for (let k = 0; k <= len; k += 2.4) {
      if (horizontal) m.box(x0 + k - 0.06, 0, z0, x0 + k + 0.06, 2.75, z1, PAL.glassFrame, MAT.wall)
      else m.box(x0, 0, z0 + k - 0.06, x1, 2.75, z0 + k + 0.06, PAL.glassFrame, MAT.wall)
    }
  }

  map.props.forEach((p, i) => buildProp(m, p, map.seed + i * 17))

  for (const l of map.lights) {
    switch (l.kind) {
      case "panel":
        m.box(l.x - 0.6, l.h, l.y - 0.3, l.x + 0.6, l.h + 0.04, l.y + 0.3, hex(0x2a2f3c))
        m.box(l.x - 0.55, l.h - 0.01, l.y - 0.25, l.x + 0.55, l.h + 0.045, l.y + 0.25, hex(0xdfe9ff), MAT.lamp, l.id)
        break
      case "pendant":
        m.box(l.x - 0.01, l.h, l.y - 0.01, l.x + 0.01, 2.75, l.y + 0.01, PAL.dark)
        m.prism(l.x, l.y, 0.32, 0.08, l.h - 0.18, l.h, 8, hex(0x2c2c30))
        m.prism(l.x, l.y, 0.26, 0.26, l.h - 0.17, l.h - 0.16, 8, hex(0xffd9a0), MAT.lamp, l.id)
        break
      case "bulb":
        m.prism(l.x, l.y, 0.16, 0.12, 0, 0.04, 6, PAL.dark)
        m.box(l.x - 0.015, 0, l.y - 0.015, l.x + 0.015, l.h - 0.2, l.y + 0.015, PAL.dark)
        m.prism(l.x, l.y, 0.24, 0.16, l.h - 0.25, l.h, 6, hex(0xffcf90), MAT.lamp, l.id)
        break
      case "exit": {
        const dx = l.cone?.[0] ?? 0
        const dz = l.cone?.[1] ?? 1
        const cx = l.x - dx * 0.25
        const cz = l.y - dz * 0.25
        const along = Math.abs(dz) > 0.5
        if (along) m.box(cx - 0.42, l.h - 0.12, cz - 0.05, cx + 0.42, l.h + 0.14, cz + 0.05, hex(0xff3a7a), MAT.lamp, l.id)
        else m.box(cx - 0.05, l.h - 0.12, cz - 0.42, cx + 0.05, l.h + 0.14, cz + 0.42, hex(0xff3a7a), MAT.lamp, l.id)
        break
      }
      case "server":
        m.box(l.x - 0.4, 2.6, l.y - 0.08, l.x + 0.4, 2.65, l.y + 0.08, hex(0x8ab0ff), MAT.lamp, l.id)
        break
    }
  }

  for (const b of map.breakers) {
    m.box(b.x - 0.25, 1.0, b.y - 0.12, b.x + 0.25, 1.6, b.y + 0.12, hex(0x6a7084))
    m.box(b.x - 0.05, 1.45, b.y - 0.13, b.x + 0.05, 1.52, b.y + 0.13, hex(0xffc040), MAT.glow, 3)
  }
  return m
}

/** Transparent geometry: window glass, interior glass panes (or their shards), puddles. */
export function buildGlass(map: MapDef, broken: readonly boolean[]): Mesh {
  const m = new Mesh()
  const G = hex(0x8fb8e8)
  for (const w of map.windows) m.box(w[0] + 0.12, 0.35, w[1] + 0.12, w[2] - 0.12, 2.6, w[3] - 0.12, G, MAT.glass)
  for (const g of map.glass) {
    const [x0, z0, x1, z1] = g.rect
    if (!broken[g.id]) {
      m.box(x0, 0.0, z0, x1, 2.5, z1, G, MAT.glass)
      continue
    }
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    const horizontal = x1 - x0 > z1 - z0
    const len = horizontal ? x1 - x0 : z1 - z0
    for (let i = 0; i < 26; i++) {
      const t = Math.sin(g.id * 31 + i * 12.7) * 0.5 + 0.5
      const s = Math.sin(g.id * 7 + i * 3.1)
      const a = (horizontal ? x0 : z0) + t * len
      const off = s * 0.8
      const px = horizontal ? a : cx + off
      const pz = horizontal ? cz + off : a
      const r = 0.05 + (Math.abs(Math.sin(i * 5.3)) * 0.08)
      m.facet([px, 0.012, pz], [px + r, 0.012, pz + r * 0.4], [px + r * 0.3, 0.012, pz - r], hex(0xcfe4ff), MAT.glow, 0.5)
    }
  }
  for (const n of map.noisy) {
    if (n.kind !== "puddle") continue
    const [x0, z0, x1, z1] = n.rect
    const cx = (x0 + x1) / 2
    const cz = (z0 + z1) / 2
    const rx = (x1 - x0) / 2
    const rz = (z1 - z0) / 2
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * Math.PI * 2
      const a1 = ((i + 1) / 10) * Math.PI * 2
      const k0 = 0.8 + 0.2 * Math.sin(i * 2.3 + cx)
      const k1 = 0.8 + 0.2 * Math.sin((i + 1) * 2.3 + cx)
      m.facet([cx, 0.008, cz], [cx + Math.cos(a1) * rx * k1, 0.008, cz + Math.sin(a1) * rz * k1], [cx + Math.cos(a0) * rx * k0, 0.008, cz + Math.sin(a0) * rz * k0], hex(0x1a3350), MAT.glass)
    }
  }
  return m
}
