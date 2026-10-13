import type { LightDef, MapDef, Prop, Wall } from "../../shared/maps"
import { MAT, Mesh } from "./mesh"
import { hex, rng } from "./models"

const STONE = hex(0x424958), EDGE = hex(0x626977), WOOD = hex(0x563822), IRON = hex(0x20232b), GOLD = hex(0xb08743)

/** Presentation copy: the office's footprints, collisions and light IDs stay intact. */
export function castleMap(map: MapDef): MapDef {
  if (map.id === "castle-hall") return map
  if (map.kind !== "office") return map
  return { ...map, tape: [], props: map.props.map((p) => ({ ...p, kind: p.kind === "desk" || p.kind === "reception" || p.kind === "counter" ? "table" : p.kind === "chair" ? "sofa" : ["cabinet", "vending", "fridge", "copier", "printer"].includes(p.kind) ? "bookshelf" : p.kind })), lights: map.lights.map((l, i) => {
    // Every third ceiling fixture becomes a chandelier; the rest mount on the nearest wall face.
    if (i % 3 === 0) return { ...l, kind: "fire", h: 2.45, r: 5, color: [1, 0.53, 0.16], power: 0.65, flicker: 0, cone: undefined }
    let best = Infinity, x = l.x, y = l.y
    for (const w of map.walls) {
      if (w.h < 2) continue
      const r = w.rect
      const candidates = [[Math.max(r[0], Math.min(r[2], l.x)), r[1] - 0.23], [Math.max(r[0], Math.min(r[2], l.x)), r[3] + 0.23], [r[0] - 0.23, Math.max(r[1], Math.min(r[3], l.y))], [r[2] + 0.23, Math.max(r[1], Math.min(r[3], l.y))]]
      for (const [cx, cy] of candidates) {
        const d = Math.hypot(cx! - l.x, cy! - l.y)
        if (d < best && cx! > 0 && cy! > 0 && cx! < map.size[0] && cy! < map.size[1]) { best = d; x = cx!; y = cy! }
      }
    }
    return { ...l, x, y, kind: "fire", h: 1.8, r: 4.6, color: [1, 0.45, 0.1], power: 0.7, flicker: 0, cone: undefined }
  }) }
}

export function castleWall(m: Mesh, w: Wall, seed: number): void {
  const [x0, z0, x1, z1] = w.rect, random = rng(seed)
  m.box(x0, 0, z0, x1, w.h - 0.12, z1, hex(0x272d38), MAT.wall)
  const horizontal = x1 - x0 >= z1 - z0, length = horizontal ? x1 - x0 : z1 - z0
  for (let row = 0; row * 0.4 < w.h - 0.12; row++) {
    for (let u = row % 2 ? -0.5 : 0; u < length; u += 0.95) {
      const a = Math.max(0, u) + 0.015, b = Math.min(length, u + 0.95) - 0.015
      if (b <= a) continue
      const col = STONE.map((c) => c * (0.85 + random() * 0.25)) as [number, number, number]
      const lo = row * 0.4 + 0.018, hi = Math.min(w.h - 0.12, lo + 0.37)
      if (horizontal) m.box(x0 + a, lo, z0 - 0.025, x0 + b, hi, z1 + 0.025, col, MAT.wall)
      else m.box(x0 - 0.025, lo, z0 + a, x1 + 0.025, hi, z0 + b, col, MAT.wall)
    }
  }
  m.bevelBox(x0 - 0.06, w.h - 0.12, z0 - 0.06, x1 + 0.06, w.h, z1 + 0.06, 0.035, STONE, EDGE, MAT.wall, MAT.cap)
  if (length > 3 && w.h > 2) {
    const from = m.length
    banner(m, Math.min(0.85, length / 4), w.h - 0.2)
    m.place(from, horizontal ? 0 : 1, horizontal ? (x0 + x1) / 2 : x0 - 0.05, 0, horizontal ? z1 + 0.05 : (z0 + z1) / 2)
  }
}

function banner(m: Mesh, width: number, top: number): void {
  const hw = width / 2, bottom = Math.max(0.45, top - 1.6)
  m.box(-hw - 0.12, top, -0.025, hw + 0.12, top + 0.045, 0.025, GOLD)
  m.box(-hw, bottom + 0.24, 0, hw, top, 0.03, hex(0x652732))
  m.facet([-hw, bottom + 0.24, 0.03], [0, bottom, 0.03], [hw, bottom + 0.24, 0.03], hex(0x652732))
  for (const x of [-hw + 0.035, hw - 0.065]) m.box(x, bottom + 0.25, 0.03, x + 0.03, top, 0.04, GOLD)
  // A simple diamond sigil, readable from the gameplay camera.
  const mid = (bottom + top) / 2
  m.quadAuto([0, mid - 0.25, 0.045], [0.13, mid, 0.045], [0, mid + 0.25, 0.045], [-0.13, mid, 0.045], GOLD)
}

function candle(m: Mesh, x: number, y: number, z: number, light?: number): void {
  m.prism(x, z, 0.055, 0.045, y, y + 0.22, 6, hex(0xc8b990))
  m.prism(x, z, 0.033, 0, y + 0.22, y + 0.35, 5, hex(0xffb13b), light === undefined ? MAT.glow : MAT.lamp, light ?? 1.7)
}

export function castleProp(m: Mesh, p: Prop, seed: number): void {
  const from = m.length, random = rng(seed)
  const rw = p.rect[2] - p.rect[0], rd = p.rect[3] - p.rect[1]
  const w = p.rot % 2 ? rd : rw, d = p.rot % 2 ? rw : rd, hw = w / 2, hd = d / 2
  if (p.kind === "table" || p.kind === "sofa") {
    const top = p.kind === "table" ? 0.78 : 0.43
    const n = Math.max(2, Math.ceil(d / 0.22))
    for (let i = 0; i < n; i++) m.box(-hw, top - 0.09, -hd + d * i / n + 0.008, hw, top, -hd + d * (i + 1) / n - 0.008, WOOD, MAT.lit, 0, hex(i % 2 ? 0x725037 : 0x68472e))
    for (const x of [-hw * 0.7, hw * 0.7]) m.box(x - 0.065, 0, -hd * 0.75, x + 0.065, top - 0.09, hd * 0.75, WOOD)
    m.box(-hw * 0.7, 0.2, -0.035, hw * 0.7, 0.27, 0.035, WOOD)
    if (p.kind === "table") {
      candle(m, 0, top, 0)
      m.box(-hw * 0.5 - 0.13, top, -0.15, -hw * 0.5 + 0.13, top + 0.055, 0.15, hex(0xb7a57a))
    }
  } else if (p.kind === "bookshelf") {
    m.box(-hw, 0, -hd, hw, 1.95, -hd + 0.045, WOOD)
    for (const x of [-hw, hw - 0.065]) m.box(x, 0, -hd, x + 0.065, 1.95, hd, WOOD)
    for (let y = 0.08; y < 2; y += 0.45) {
      m.box(-hw, y, -hd, hw, y + 0.065, hd, WOOD)
      if (y > 1.7) break
      for (let x = -hw + 0.08; x < hw - 0.12; x += 0.1) {
        const color = [0x65432d, 0x753238, 0x354d60, 0x5a623c][Math.floor(random() * 4)]!
        m.box(x, y + 0.065, -hd + 0.06, x + 0.075, y + 0.29 + random() * 0.11, hd - 0.025, hex(color))
        m.box(x, y + 0.13, hd - 0.025, x + 0.075, y + 0.145, hd - 0.019, GOLD)
      }
    }
    candle(m, -hw * 0.5, 1.95, 0)
    candle(m, hw * 0.4, 1.95, 0.04)
  } else if (p.kind === "whiteboard") banner(m, w, 2.25)
  else if (p.kind === "lamp") candle(m, 0, 0.78, 0, p.light)
  else {
    // Small office clutter becomes a coopered barrel rather than modern equipment.
    const r = Math.min(hw, hd), h = Math.min(1.1, r * 2.4)
    m.prism(0, 0, r * 0.85, r, 0, h * 0.5, 10, WOOD)
    m.prism(0, 0, r, r * 0.85, h * 0.5, h, 10, WOOD)
    for (const y of [h * 0.15, h * 0.75]) m.prism(0, 0, r * 0.97, r * 0.97, y, y + 0.055, 10, IRON)
  }
  m.place(from, p.rot, (p.rect[0] + p.rect[2]) / 2, 0, (p.rect[1] + p.rect[3]) / 2)
}

export function castleFixture(m: Mesh, l: LightDef): void {
  const from = m.length
  if (l.h > 2) {
    // Open octagonal iron ring, not a solid floating plate.
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4, x = Math.cos(a) * 0.48, z = Math.sin(a) * 0.48
      m.yawBox(x, z, 0.42, 0.045, -0.08, 0, a + Math.PI / 2, IRON)
      candle(m, x, 0, z, l.id)
      if (i % 2 === 0) m.box(x - 0.012, 0, z - 0.012, x + 0.012, 0.55, z + 0.012, IRON)
    }
  } else {
    m.box(-0.065, -0.58, -0.065, 0.065, -0.04, 0.065, WOOD)
    m.prism(0, 0, 0.07, 0.14, -0.22, -0.04, 6, IRON)
    m.prism(0, 0, 0.13, 0.065, -0.05, 0.12, 5, hex(0xff8118), MAT.lamp, l.id)
    m.prism(0.025, 0, 0.065, 0, 0.12, 0.32, 5, hex(0xffce62), MAT.lamp, l.id)
    m.box(-0.14, -0.45, -0.16, 0.14, -0.37, 0.04, IRON)
  }
  m.place(from, 0, l.x, l.h, l.y)
}
