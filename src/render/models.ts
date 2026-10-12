import { LOOKS, type Weapon } from "../../shared/config"
import type { Prop } from "../../shared/maps"
import { MAT, Mesh, type Rgb } from "./mesh"

/** sRGB hex to a 0..1 triple (the shader linearises). */
export const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]

export const PAL = {
  carpet: hex(0x1d2439),
  tile: hex(0x2b3349),
  wood: hex(0x3b3136),
  concrete: hex(0x272b35),
  grate: hex(0x2e3a4c),
  wallSide: hex(0x343c52),
  wallTop: hex(0x5f6880),
  partition: hex(0x3a445c),
  partitionCap: hex(0x7d869b),
  deskTop: hex(0x8d7f6c),
  dark: hex(0x22252e),
  steel: hex(0x6c7487),
  chair: hex(0x23262f),
  pot: hex(0x3b3f4b),
  leaf: hex(0x2f6a48),
  leaf2: hex(0x41845a),
  cabinet: hex(0x4a5267),
  sofa: hex(0x3b3652),
  table: hex(0x6f6150),
  paper: hex(0xd8d9d4),
  white: hex(0xc8ccd3),
  crate: hex(0x6d5337),
  book: [hex(0x8a3c36), hex(0x2f5a7a), hex(0x8a7a3a), hex(0x3e6a4a), hex(0x5a4070)],
  box: hex(0x7c5d3d),
  rack: hex(0x15181f),
  core: hex(0x2b3041),
  pillar: hex(0x4b5164),
  glassFrame: hex(0x1a1f2b),
}

/** Footprint of a prop in its own frame: width along local x, depth along local z (front faces +z). */
function local(p: Prop): { w: number; d: number } {
  const rw = p.rect[2] - p.rect[0]
  const rd = p.rect[3] - p.rect[1]
  return p.rot % 2 === 0 ? { w: rw, d: rd } : { w: rd, d: rw }
}

function monitor(m: Mesh, x: number, z: number, on: boolean): void {
  m.box(x - 0.28, 0.76, z - 0.03, x + 0.28, 1.08, z + 0.03, PAL.dark)
  m.box(x - 0.25, 0.79, z + 0.031, x + 0.25, 1.05, z + 0.04, on ? hex(0x2a4a7a) : hex(0x0c0e14), on ? MAT.glow : MAT.lit, on ? 0.6 : 0)
  m.box(x - 0.04, 0.74, z - 0.04, x + 0.04, 0.78, z + 0.04, PAL.dark)
}

/** Builds one prop into `m` at its place on the plan. */
export function buildProp(m: Mesh, p: Prop, seed: number): void {
  const from = m.length
  const { w, d } = local(p)
  const hw = w / 2
  const hd = d / 2
  const r = (k: number) => {
    const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453
    return x - Math.floor(x)
  }
  switch (p.kind) {
    case "desk": {
      m.box(-hw, 0.72, -hd, hw, 0.76, hd, PAL.deskTop)
      for (const sx of [-1, 1]) m.box(sx * hw - (sx > 0 ? 0.05 : -0.05) - 0.025, 0, -hd + 0.05, sx * hw - (sx > 0 ? 0.05 : -0.05) + 0.025, 0.72, hd - 0.05, PAL.dark)
      monitor(m, (r(1) - 0.5) * w * 0.3, -hd + 0.22, r(2) < 0.12)
      m.box(-0.22, 0.76, -hd + 0.36, 0.22, 0.78, -hd + 0.5, PAL.dark)
      if (r(3) < 0.6) m.box(hw - 0.42, 0.76, -0.05, hw - 0.12, 0.775, 0.17, PAL.paper)
      if (r(4) < 0.4) m.prism(-hw + 0.2, hd - 0.2, 0.05, 0.05, 0.76, 0.86, 6, hex(0xa0503a))
      break
    }
    case "chair": {
      m.prism(0, 0, 0.22, 0.05, 0.02, 0.1, 5, PAL.dark)
      m.box(-0.03, 0.08, -0.03, 0.03, 0.42, 0.03, PAL.steel)
      m.box(-0.22, 0.42, -0.22, 0.22, 0.5, 0.2, PAL.chair)
      m.box(-0.2, 0.5, 0.17, 0.2, 0.95, 0.24, PAL.chair)
      break
    }
    case "cabinet": {
      m.box(-hw, 0, -hd, hw, 1.1, hd, PAL.cabinet, MAT.lit, 0, hex(0x5a6278))
      for (let y = 0.25; y < 1.1; y += 0.35) m.box(-hw + 0.05, y, hd, hw - 0.05, y + 0.02, hd + 0.01, PAL.steel)
      break
    }
    case "plant": {
      const s = Math.min(w, d) / 2
      m.prism(0, 0, s * 0.55, s * 0.7, 0, 0.42, 6, PAL.pot)
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + r(i)
        const len = s * (0.9 + r(i + 9) * 0.5)
        const tip = [Math.cos(a) * len, 0.75 + r(i + 3) * 0.45, Math.sin(a) * len]
        const side = [Math.cos(a + 1.6) * 0.09, 0, Math.sin(a + 1.6) * 0.09]
        m.facet([side[0]!, 0.42, side[2]!], [-side[0]!, 0.42, -side[2]!], tip, i % 2 ? PAL.leaf : PAL.leaf2)
      }
      break
    }
    case "sofa": {
      m.box(-hw, 0, -hd, hw, 0.42, hd, PAL.sofa)
      m.box(-hw, 0.42, -hd, hw, 0.85, -hd + 0.22, PAL.sofa)
      for (const sx of [-1, 1]) m.box(sx > 0 ? hw - 0.18 : -hw, 0.42, -hd, sx > 0 ? hw : -hw + 0.18, 0.62, hd, PAL.sofa)
      m.box(-hw + 0.2, 0.42, -hd + 0.24, hw - 0.2, 0.5, hd - 0.05, hex(0x47415f))
      break
    }
    case "table": {
      m.box(-hw, 0.7, -hd, hw, 0.75, hd, PAL.table)
      m.box(-0.06, 0, -0.06, 0.06, 0.7, 0.06, PAL.dark)
      m.box(-Math.min(hw, 0.4), 0, -Math.min(hd, 0.4), Math.min(hw, 0.4), 0.03, Math.min(hd, 0.4), PAL.dark)
      if (r(5) < 0.5) m.box(-0.12, 0.75, -0.1, 0.18, 0.765, 0.12, PAL.paper)
      break
    }
    case "vending": {
      m.box(-hw, 0, -hd, hw, 1.9, hd, hex(0x1b2636), MAT.lit, 0, hex(0x2a3a50))
      const lamp = p.light ?? -1
      if (lamp >= 0) {
        m.box(-hw + 0.1, 0.55, hd, hw * 0.35, 1.75, hd + 0.02, hex(0x3ad8ff), MAT.lamp, lamp)
        m.box(hw * 0.45, 0.9, hd, hw - 0.1, 1.6, hd + 0.02, hex(0x2a9ac8), MAT.lamp, lamp)
        for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) m.box(-hw + 0.18 + i * 0.22, 0.75 + j * 0.3, hd + 0.02, -hw + 0.3 + i * 0.22, 0.92 + j * 0.3, hd + 0.03, hex(0xe8fbff), MAT.lamp, lamp)
      }
      break
    }
    case "copier":
    case "printer": {
      const h = p.kind === "copier" ? 1.0 : 0.85
      m.box(-hw, 0, -hd, hw, h, hd, PAL.white, MAT.lit, 0, hex(0xdfe2e7))
      m.box(-hw + 0.1, h, -hd + 0.1, hw - 0.1, h + 0.08, hd - 0.15, hex(0x8e939e))
      m.box(hw - 0.3, h + 0.08, hd - 0.3, hw - 0.12, h + 0.1, hd - 0.18, hex(0x30ff90), MAT.glow, 1.2)
      break
    }
    case "counter": {
      m.box(-hw, 0, -hd, hw, 0.9, hd, hex(0x5d6578), MAT.lit, 0, hex(0xa9aebb))
      m.box(-0.3, 0.9, -0.15, 0.3, 0.91, 0.15, hex(0x8a909c))
      break
    }
    case "fridge":
      m.box(-hw, 0, -hd, hw, 1.85, hd, hex(0xb9bec9), MAT.lit, 0, hex(0xd2d6dd))
      m.box(hw - 0.12, 1.0, hd, hw - 0.08, 1.5, hd + 0.04, PAL.steel)
      break
    case "cooler":
      m.box(-hw, 0, -hd, hw, 1.0, hd, hex(0xc8d4e0))
      m.prism(0, 0, 0.13, 0.13, 1.0, 1.4, 8, hex(0x4aa0e0), MAT.glow, 0.35)
      break
    case "bookshelf": {
      m.box(-hw, 0, -hd, hw, 1.9, hd, hex(0x3a2f2b))
      for (let y = 0.1; y < 1.8; y += 0.45)
        for (let x = -hw + 0.06; x < hw - 0.1; ) {
          const bw = 0.05 + r(x * 10 + y) * 0.06
          m.box(x, y, -hd + 0.05, x + bw, y + 0.28 + r(x + y * 3) * 0.08, hd + 0.01, PAL.book[Math.floor(r(x * 7 + y * 5) * 5)]!)
          x += bw + 0.01
        }
      break
    }
    case "crate":
      m.box(-hw, 0, -hd, hw, Math.min(w, d) * 0.9, hd, PAL.crate, MAT.lit, 0, hex(0x84673f))
      break
    case "whiteboard":
      m.box(-hw, 0.9, -hd, hw, 2.0, hd, hex(0xe6eaef))
      break
    case "reception": {
      m.box(-hw, 0, -hd, hw, 1.05, hd, hex(0x3a4155), MAT.lit, 0, hex(0x9c8b70))
      monitor(m, 0.3, -hd + 0.25, true)
      break
    }
    case "lamp": {
      // Desk lamp on a desk: base, arm and a shade that glows with its light.
      m.prism(0, 0, 0.08, 0.06, 0.76, 0.79, 6, PAL.dark)
      m.box(-0.015, 0.79, -0.015, 0.015, 1.05, 0.015, PAL.dark)
      m.prism(0, 0.06, 0.12, 0.05, 0.94, 1.08, 6, hex(0x2c2c30))
      if (p.light !== undefined) m.prism(0, 0.06, 0.1, 0.1, 0.935, 0.945, 6, hex(0xffcf8a), MAT.lamp, p.light)
      break
    }
    case "exitdoor":
      m.box(-hw - 0.08, 0, -0.06, -hw, 2.25, 0.06, PAL.steel)
      m.box(hw, 0, -0.06, hw + 0.08, 2.25, 0.06, PAL.steel)
      break
    default:
      m.box(-hw, 0, -hd, hw, 0.8, hd, PAL.cabinet)
  }
  m.place(from, p.rot, (p.rect[0] + p.rect[2]) / 2, 0, (p.rect[1] + p.rect[3]) / 2)
}

/** A low-poly person facing +x, about 1.75 m tall. Material 8 parts take the team colour from the instance. */
export function buildPerson(look: number, weapon: Weapon): Mesh {
  const m = new Mesh()
  const cloth = hex(0x262a35)
  const skin = hex(0x9a7a64)
  const ACC = MAT.accent
  // Legs.
  m.box(-0.08, 0, -0.17, 0.08, 0.8, -0.04, cloth)
  m.box(-0.08, 0, 0.04, 0.08, 0.8, 0.17, cloth)
  m.box(-0.1, 0, -0.18, 0.14, 0.08, -0.03, PAL.dark)
  m.box(-0.1, 0, 0.03, 0.14, 0.08, 0.18, PAL.dark)
  // Torso with a team-coloured vest.
  m.box(-0.13, 0.8, -0.23, 0.13, 1.42, 0.23, cloth)
  m.box(-0.145, 0.88, -0.2, 0.145, 1.38, 0.2, [1, 1, 1], ACC)
  // Head.
  m.prism(0, 0, 0.13, 0.12, 1.45, 1.72, 6, look === 3 ? hex(0x1a1c22) : skin)
  if (look === 1) m.prism(-0.02, 0, 0.16, 0.08, 1.48, 1.8, 6, cloth)
  if (look === 2) {
    m.prism(0, 0, 0.14, 0.14, 1.66, 1.76, 6, [1, 1, 1], ACC)
    m.box(0.05, 1.66, -0.12, 0.26, 1.69, 0.12, [1, 1, 1], ACC)
  }
  if (look === 4) m.box(0.08, 1.56, -0.11, 0.15, 1.62, 0.11, hex(0x60e0ff), MAT.glow, 2)
  // Arms reaching forward to the weapon.
  m.box(-0.02, 1.16, -0.3, 0.36, 1.3, -0.2, cloth)
  m.box(0.0, 1.16, 0.2, 0.42, 1.3, 0.3, cloth)
  m.box(0.34, 1.15, -0.1, 0.46, 1.27, 0.08, skin)
  // Weapon.
  const g = hex(0x101216)
  if (weapon === "pistol") {
    m.box(0.4, 1.2, -0.04, 0.72, 1.28, 0.04, g)
    m.box(0.72, 1.21, -0.03, 0.9, 1.27, 0.03, hex(0x1c1f26))
  } else if (weapon === "shotgun") {
    m.box(0.1, 1.18, -0.05, 1.05, 1.28, 0.05, g)
    m.box(0.45, 1.14, -0.06, 0.75, 1.2, 0.06, hex(0x4a3526))
  } else {
    m.box(0.15, 1.2, -0.04, 0.95, 1.27, 0.04, hex(0x3a2c22))
    m.facet([0.85, 1.24, 0], [0.7, 1.24, -0.42], [0.74, 1.24, 0], g)
    m.facet([0.85, 1.24, 0], [0.7, 1.24, 0.42], [0.74, 1.24, 0], g)
    m.box(0.7, 1.235, -0.42, 0.72, 1.245, 0.42, hex(0xbfc4cc))
  }
  return m
}

export function personModels(): Mesh[][] {
  return LOOKS.map((_, look) => (["pistol", "shotgun", "crossbow"] as const).map((w) => buildPerson(look, w)))
}

/** Door leaf, hinged at the origin and extending 1.4 m along +x. */
export function buildDoor(): Mesh {
  const m = new Mesh()
  m.box(0.02, 0, -0.035, 1.38, 2.2, 0.035, hex(0x4c556c), MAT.lit, 0, hex(0x6a7388))
  m.box(1.2, 1.0, -0.06, 1.28, 1.05, 0.06, PAL.steel)
  return m
}

/** Flare stick lying on the floor, glowing red. */
export function buildFlare(): Mesh {
  const m = new Mesh()
  m.box(-0.12, 0, -0.03, 0.12, 0.06, 0.03, hex(0x8a1a12))
  m.box(0.12, 0.0, -0.035, 0.18, 0.07, 0.035, hex(0xff5a3a), MAT.glow, 6)
  return m
}

/** Noise decoy: a small grey puck with a blinking eye (the blink comes from the instance). */
export function buildDecoy(): Mesh {
  const m = new Mesh()
  m.prism(0, 0, 0.12, 0.1, 0, 0.07, 8, hex(0x5a6070))
  m.prism(0, 0, 0.04, 0.04, 0.07, 0.08, 6, [1, 1, 1], MAT.accent)
  return m
}

export function buildMine(): Mesh {
  const m = new Mesh()
  m.prism(0, 0, 0.16, 0.13, 0, 0.05, 6, hex(0x2a2e38))
  m.prism(0, 0, 0.05, 0.05, 0.05, 0.06, 6, [1, 1, 1], MAT.accent)
  return m
}

export function buildBolt(): Mesh {
  const m = new Mesh()
  m.box(-0.22, 0.02, -0.012, 0.22, 0.045, 0.012, hex(0x9a7a50))
  m.box(0.18, 0.02, -0.03, 0.24, 0.05, 0.03, hex(0xb8bec8))
  return m
}
