import { MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import type { LevelChunk, LevelData } from "@arcade/kit/gpu/level"
import { CHUNK, SIZE, type Town, type Prop } from "../shared/map"

export const hex = (v: number): Rgb => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
const floor = (m: Mesh, x: number, z: number, r: number, b: number, h: number, color: number, kind: number) => m.quad([x, h, b], [r, h, b], [r, h, z], [x, h, z], [0, 1, 0], hex(color), MAT.floor, kind)

function furniture(m: Mesh, p: Prop): void {
  const { x, y: z, kind } = p
  if (kind === "tree") {
    m.prism(x, z, .22, .13, 0, 2.8, 7, hex(0x4e4133))
    const h = 3.5 + p.variant * 1.5
    m.prism(x, z, 1.5, .25, 2, h, 7, hex(0x3b5142))
    m.prism(x + .3, z - .2, 1.0, 0, h - 1, h + .6, 6, hex(0x506249))
    return
  }
  const wood = hex(0x75604b), legs = hex(0x3b3934)
  if (kind === "bed") {
    m.box(x - .8, .12, z - 1.2, x + .8, .45, z + 1.2, wood)
    m.bevelBox(x - .78, .45, z - 1.15, x + .78, .65, z + 1.15, .07, hex(0x637578), hex(0x889c9b))
    m.box(x - .65, .66, z - 1.0, x + .65, .77, z - .6, hex(0xc0baab))
    m.box(x - .86, .15, z - 1.3, x + .86, 1, z - 1.17, wood)
  } else if (kind === "sofa") {
    m.box(x - .55, .15, z - 1.25, x + .55, .62, z + 1.25, hex(0x705c49))
    m.box(x + .35, .5, z - 1.3, x + .65, 1.1, z + 1.3, hex(0x82715e))
    for (const s of [-1, 1]) m.box(x - .55, .4, z + s * 1.17 - .12, x + .55, .88, z + s * 1.17 + .12, hex(0x82715e))
  } else if (kind === "table") {
    m.box(x - .75, .7, z - .5, x + .75, .82, z + .5, wood)
    for (const dx of [-.65, .65]) for (const dz of [-.4, .4]) m.box(x + dx - .05, .1, z + dz - .05, x + dx + .05, .7, z + dz + .05, legs)
    m.box(x - .2, .82, z - .15, x + .2, .87, z + .15, hex(0xb5b0a0))
  } else {
    for (const dx of [-.8, .8]) m.box(x + dx - .06, .1, z - .38, x + dx + .06, 1.8, z + .38, legs)
    for (const h of [.3, .85, 1.4]) {
      m.box(x - .85, h, z - .4, x + .85, h + .07, z + .4, wood)
      for (let i = 0; i < 5; i++) {
        const px = x - .68 + i * .3
        m.box(px, h + .07, z - .25, px + .2, h + .2 + (p.variant + i * .13) % .27, z + .25, hex(i % 2 ? 0xa39b7c : 0x5a7973))
      }
    }
  }
}

/** Nine logical 32m chunks; each render chunk retains real bounds for overhanging geometry. */
export function buildLevel(town: Town): LevelData {
  const meshes = town.chunks.map(() => new Mesh()), glasses = town.chunks.map(() => new Mesh())
  const at = (x: number, z: number, glass = false) => (glass ? glasses : meshes)[Math.min(2, Math.max(0, Math.floor(z / CHUNK))) * 3 + Math.min(2, Math.max(0, Math.floor(x / CHUNK)))]!
  for (const [i, r] of town.chunks.entries()) floor(meshes[i]!, ...r, 0, 0x374538, 8)
  // Segment streets at chunk edges to retain useful culling.
  for (let v = 0; v < SIZE; v += CHUNK) {
    floor(at(44, v), 40, v, 48, v + CHUNK, .012, 0x2d3035, 5)
    floor(at(v, 44), v, 40, v + CHUNK, 48, .014, 0x2d3035, 5)
    for (const s of [38, 48]) {
      floor(at(s, v), s, v, s + 2, v + CHUNK, .1, 0x858278, 6)
      floor(at(v, s), v, s, v + CHUNK, s + 2, .11, 0x858278, 6)
    }
  }
  for (let v = 2; v < SIZE; v += 5) {
    if (v > 37 && v < 51) continue
    const m = at(v, 44)
    m.box(v, .025, 43.9, v + 2.4, .027, 44.02, hex(0xb9ab7a))
    at(44, v).box(43.9, .025, v, 44.02, .027, v + 2.4, hex(0xb9ab7a))
  }
  for (const b of town.buildings) {
    const [x, z, r, end] = b.rect, m = at(x, z)
    floor(m, x, z, r, end, .13, b.kind === "house" ? 0x8d7760 : 0x89968b, b.kind === "house" ? 2 : 1)
    floor(m, x + 4.8, end, x + 6.6, end + 2, .08, 0x777b74, 3)
    if (b.kind !== "house") {
      const color = hex(b.kind === "pharmacy" ? 0x406d62 : 0x8b593d)
      m.box(x + .3, 2.05, end + .01, r - .3, 2.6, end + .2, color, MAT.wall)
      // Hardware pegboard / pharmacy cross in geometry, readable at street scale.
      if (b.kind === "pharmacy") {
        m.box(x + 1.2, 2.1, end + .21, x + 1.5, 2.55, end + .23, hex(0xcad8b7))
        m.box(x + 1.05, 2.23, end + .21, x + 1.65, 2.4, end + .23, hex(0xcad8b7))
      }
    }
  }
  for (const b of town.barriers) {
    const [x, z, r, end] = b.rect, m = at(x, z), color = hex(b.color)
    if (b.kind === "wall") {
      m.bevelBox(x, .13, z, r, 2.8, end, .035, color, hex(0xb5ad99), MAT.wall, MAT.cap)
      m.box(x - .02, .14, z - .02, r + .02, .3, end + .02, hex(0x4b4a41), MAT.wall)
    } else if (b.kind === "window") {
      m.box(x, .13, z, r, .85, end, color, MAT.wall)
      m.box(x, 2.15, z, r, 2.8, end, color, MAT.wall)
      const g = at(x, z, true)
      g.box(x + .025, .87, z + .025, r - .025, 2.14, end - .025, hex(0x809c9e), MAT.glass)
      if (r - x > 1) {
        for (const px of [x, (x + r) / 2, r - .06]) m.box(px, .85, z - .03, px + .06, 2.2, end + .03, hex(0xc4bfab), MAT.wall)
      } else {
        for (const pz of [z, (z + end) / 2, end - .06]) m.box(x - .03, .85, pz, r + .03, 2.2, pz + .06, hex(0xc4bfab), MAT.wall)
      }
    } else {
      const horizontal = r - x > end - z, length = horizontal ? r - x : end - z
      for (let d = 0; d < length; d += .45) {
        const px = x + (horizontal ? d : 0), pz = z + (horizontal ? 0 : d)
        m.box(px, .05, pz, px + .09, 1.1, pz + .09, color)
      }
      for (const h of [.35, .8]) m.box(x, h, z, r, h + .08, end, color)
    }
  }
  for (const p of town.props) furniture(at(p.x, p.y), p)
  for (const [id, p] of town.lamps.entries()) {
    const m = at(p.x, p.y)
    m.prism(p.x, p.y, .13, .07, .1, 3.8, 8, hex(0x353d3c))
    m.box(p.x - .08, 3.65, p.y - .08, p.x + .7, 3.8, p.y + .08, hex(0x353d3c))
    m.box(p.x + .3, 3.55, p.y - .18, p.x + .8, 3.65, p.y + .18, hex(0xffc980), MAT.lamp, id)
  }
  const chunks = (list: Mesh[]): LevelChunk[] => list.filter(m => m.count).map(m => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, top = 0
    for (let i = 0; i < m.v.length; i += 11) {
      x0 = Math.min(x0, m.v[i]!); x1 = Math.max(x1, m.v[i]!)
      z0 = Math.min(z0, m.v[i + 2]!); z1 = Math.max(z1, m.v[i + 2]!); top = Math.max(top, m.v[i + 1]!)
    }
    return { data: m.pack(), box: [x0, z0, x1, z1], cutBox: [x0, 0, z0, x1, top, z1] }
  })
  // Indoor sky mask: roofs are cut away, but rooms still receive only subdued daylight.
  const data = new Uint8Array(SIZE * SIZE * 2)
  for (let z = 0; z < SIZE; z++) for (let x = 0; x < SIZE; x++) {
    const indoor = town.buildings.some(b => x >= b.rect[0] && x < b.rect[2] && z >= b.rect[1] && z < b.rect[3])
    data[(z * SIZE + x) * 2] = indoor ? 55 : 0
    data[(z * SIZE + x) * 2 + 1] = indoor ? 32 : 255
  }
  return { chunks: chunks(meshes), glass: chunks(glasses), floor: { data, w: SIZE, h: SIZE }, bounce: { data: new Uint8Array([0, 0, 0, 255]), w: 1, h: 1 } }
}
