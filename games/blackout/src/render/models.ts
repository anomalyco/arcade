import type { LightDef, MapDef, Prop } from "../../shared/maps"
import { FLOATS_PER_VERT, MAT, Mesh, type Rgb } from "./mesh"

/** sRGB hex to a 0..1 triple (the shader linearises). */
export const hex = (h: number): Rgb => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255]

/** Deterministic 0..1 generator from a seed. */
export function rng(seed: number): () => number {
  let s = Math.floor(Math.abs(seed * 2654435761) % 2147483647) || 1
  return () => {
    s = (s * 48271) % 2147483647
    return s / 2147483647
  }
}

export const PAL = {
  carpet: hex(0x363c4c),
  tile: hex(0x55575c),
  wood: hex(0x5a4436),
  concrete: hex(0x43464c),
  grate: hex(0x3a4656),
  tape: hex(0xb08a2a),
  wallSide: hex(0x6a6862),
  wallTop: hex(0x2c3448),
  capSide: hex(0x1c2232),
  capEdge: hex(0x5a6684),
  skirting: hex(0x161a24),
  doorFrame: hex(0x2a2e38),
  partition: hex(0x4a4c56),
  stall: hex(0x5a5c66),
  partitionCap: hex(0x5c6478),
  deskTop: hex(0x5e584e),
  deskBody: hex(0x3a3f4c),
  dark: hex(0x1c1f27),
  steel: hex(0x6c7487),
  chair: hex(0x22252d),
  pot: hex(0xd4d6d8),
  soil: hex(0x2a2018),
  leaf: hex(0x2f6a3e),
  leaf2: hex(0x4a8a4a),
  cabinet: hex(0x5a5e6a),
  sofa: hex(0x3a3a52),
  table: hex(0x5e4a3a),
  paper: hex(0xe0e0da),
  white: hex(0xc8ccd3),
  crate: hex(0x9a7448),
  book: [hex(0x8a3c36), hex(0x2f5a7a), hex(0x8a7a3a), hex(0x3e6a4a), hex(0x5a4070)],
  box: hex(0x8a6a44),
  rack: hex(0x13161d),
  core: hex(0x3a3c44),
  pillar: hex(0x5a5a5e),
  glassFrame: hex(0x1a1f2b),
  fixture: hex(0x2a2f3a),
  fixtureTop: hex(0x3a4052),
  screenOn: hex(0x7ac0ff),
  screenOff: hex(0x0c1018),
}

/** Footprint of a prop in its own frame: width along local x, depth along local z (front faces +z). */
function local(p: Prop): { w: number; d: number } {
  const rw = p.rect[2] - p.rect[0]
  const rd = p.rect[3] - p.rect[1]
  return p.rot % 2 === 0 ? { w: rw, d: rd } : { w: rd, d: rw }
}

/** Match buildProp's exact desk RNG sequence, including the optional second monitor. */
export function deskMonitorLights(map: MapDef): (LightDef & { yaw: number })[] {
  const lights: (LightDef & { yaw: number })[] = []
  map.props.forEach((p, i) => {
    if (p.kind !== "desk") return
    const r = rng(map.seed + i * 17)
    r(); r() // pedestal and PC tower
    const { w, d } = local(p)
    const mx = (r() - 0.5) * Math.max(0, w - 0.9) * 0.6
    const yaw = p.rot * Math.PI / 2
    const c = Math.cos(yaw), s = Math.sin(yaw)
    const add = (x: number, z: number) => lights.push({
      id: map.lights.length + lights.length, kind: "desk", yaw,
      x: (p.rect[0] + p.rect[2]) / 2 + x * c - z * s,
      y: (p.rect[1] + p.rect[3]) / 2 + x * s + z * c,
      h: 1, r: 1.65, color: [0.12, 0.65, 1], power: 0.35, flicker: 0,
      cone: [-s, c, -0.3],
    })
    if (r() < 0.28) add(mx, -d / 2 + 0.2)
    if (r() < 0.25 && r() < 0.3) add(mx + (mx > 0 ? -0.58 : 0.58), -d / 2 + 0.22)
  })
  return lights
}

/** Rotates every vertex added since `from` by `yaw` around (cx, cz). */
function spin(m: Mesh, from: number, yaw: number, cx = 0, cz = 0): void {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  for (let i = from; i < m.v.length; i += FLOATS_PER_VERT) {
    const x = m.v[i]! - cx
    const z = m.v[i + 2]! - cz
    m.v[i] = x * c - z * s + cx
    m.v[i + 2] = x * s + z * c + cz
    const nx = m.v[i + 3]!
    const nz = m.v[i + 5]!
    m.v[i + 3] = nx * c - nz * s
    m.v[i + 5] = nx * s + nz * c
  }
}

function monitor(m: Mesh, x: number, z: number, on: boolean, y = 0.76): void {
  m.prism(x, z - 0.02, 0.09, 0.07, y, y + 0.015, 6, PAL.dark)
  m.box(x - 0.02, y, z - 0.04, x + 0.02, y + 0.12, z - 0.01, PAL.dark)
  m.bevelBox(x - 0.27, y + 0.08, z - 0.025, x + 0.27, y + 0.4, z + 0.015, 0.01, PAL.dark, hex(0x262a33), MAT.shiny)
  m.box(x - 0.25, y + 0.1, z + 0.015, x + 0.25, y + 0.38, z + 0.022, on ? PAL.screenOn : PAL.screenOff, on ? MAT.glow : MAT.shiny, on ? 1.4 : 0)
}

function keyboard(m: Mesh, x: number, z: number, y = 0.76): void {
  m.box(x - 0.21, y, z - 0.07, x + 0.21, y + 0.018, z + 0.07, hex(0x15171c))
  m.box(x - 0.19, y + 0.018, z - 0.055, x + 0.19, y + 0.022, z + 0.055, hex(0x2c3038))
}

function mug(m: Mesh, x: number, z: number, col: Rgb, y = 0.76): void {
  m.prism(x, z, 0.04, 0.04, y, y + 0.1, 7, col)
  m.prism(x, z, 0.033, 0.033, y + 0.095, y + 0.101, 7, hex(0x2a1a10))
}

function papers(m: Mesh, x: number, z: number, r: () => number, y = 0.76): void {
  const n = 1 + Math.floor(r() * 3)
  for (let k = 0; k < n; k++) m.yawBox(x + (r() - 0.5) * 0.06, z + (r() - 0.5) * 0.06, 0.21, 0.29, y + k * 0.004, y + k * 0.004 + 0.004, (r() - 0.5) * 0.6, PAL.paper)
}

function plantModel(m: Mesh, s: number, r: () => number): void {
  // Square white planter, dark soil, a fan of folded faceted leaves.
  const pw = s * 0.62
  m.bevelBox(-pw, 0, -pw, pw, 0.42, pw, 0.03, PAL.pot, hex(0xe4e6e8), MAT.lit)
  m.box(-pw + 0.03, 0.4, -pw + 0.03, pw - 0.03, 0.425, pw - 0.03, PAL.soil)
  const n = 9
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + r() * 0.5
    const len = s * (0.9 + r() * 0.7)
    const up = 0.75 + r() * 0.5
    const mid = [Math.cos(a) * len * 0.55, 0.42 + up * 0.85, Math.sin(a) * len * 0.55]
    const tip = [Math.cos(a) * len, 0.42 + up * (0.55 + r() * 0.3), Math.sin(a) * len]
    const wdt = 0.07 + r() * 0.05
    const side = [Math.cos(a + Math.PI / 2) * wdt, 0, Math.sin(a + Math.PI / 2) * wdt]
    const base = [Math.cos(a) * 0.04, 0.43, Math.sin(a) * 0.04]
    const l = [mid[0]! + side[0]!, mid[1]! - 0.03, mid[2]! + side[2]!]
    const rr = [mid[0]! - side[0]!, mid[1]! - 0.03, mid[2]! - side[2]!]
    const c1 = i % 2 ? PAL.leaf : PAL.leaf2
    const c2 = i % 2 ? PAL.leaf2 : PAL.leaf
    m.facet(base, l, mid, c1)
    m.facet(base, mid, rr, c2)
    m.facet(l, tip, mid, c2)
    m.facet(mid, tip, rr, c1)
  }
}

function chairModel(m: Mesh, r: () => number): void {
  // Five-star base on casters, gas lift, seat, backrest at -z (you sit facing +z), arms.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3
    m.yawBox(Math.cos(a) * 0.13, Math.sin(a) * 0.13, 0.26, 0.04, 0.05, 0.09, a, PAL.dark)
    m.prism(Math.cos(a) * 0.25, Math.sin(a) * 0.25, 0.025, 0.025, 0, 0.05, 5, hex(0x0e1014))
  }
  m.prism(0, 0, 0.035, 0.035, 0.08, 0.42, 6, PAL.steel, MAT.shiny)
  m.bevelBox(-0.24, 0.42, -0.22, 0.24, 0.5, 0.22, 0.03, PAL.chair, hex(0x2a2e38))
  m.bevelBox(-0.22, 0.52, -0.27, 0.22, 1.0, -0.2, 0.03, PAL.chair, hex(0x2c303a))
  m.box(-0.04, 0.45, -0.24, 0.04, 0.62, -0.19, PAL.dark)
  if (r() < 0.8)
    for (const sx of [-1, 1]) {
      m.box(sx * 0.25 - 0.02, 0.5, -0.05, sx * 0.25 + 0.02, 0.66, -0.01, PAL.dark)
      m.box(sx * 0.25 - 0.035, 0.66, -0.14, sx * 0.25 + 0.035, 0.69, 0.1, PAL.dark)
    }
}

/** Builds one prop into `m` at its place on the plan. */
export function buildProp(m: Mesh, p: Prop, seed: number): void {
  const from = m.length
  const { w, d } = local(p)
  const hw = w / 2
  const hd = d / 2
  const r = rng(seed)
  switch (p.kind) {
    case "desk": {
      const top = 0.76
      m.bevelBox(-hw, top - 0.04, -hd, hw, top, hd, 0.012, hex(0x8a8070), PAL.deskTop)
      // Side panels, a modesty panel at the back, a drawer pedestal on one side.
      for (const sx of [-1, 1]) m.box(sx * hw - (sx > 0 ? 0.04 : 0), 0, -hd + 0.03, sx * hw + (sx > 0 ? 0 : 0.04), top - 0.04, hd - 0.04, PAL.deskBody)
      m.box(-hw + 0.04, 0.25, -hd + 0.03, hw - 0.04, top - 0.04, -hd + 0.06, PAL.deskBody)
      const ped = r() < 0.5 ? -1 : 1
      const px0 = ped < 0 ? -hw + 0.04 : hw - 0.44
      m.box(px0, 0.02, -hd + 0.1, px0 + 0.4, top - 0.06, hd - 0.06, hex(0x464c5a))
      for (let k = 0; k < 3; k++) {
        const y = 0.06 + k * 0.22
        m.box(px0 + 0.02, y, hd - 0.06, px0 + 0.38, y + 0.2, hd - 0.05, hex(0x50576a))
        m.box(px0 + 0.14, y + 0.15, hd - 0.05, px0 + 0.26, y + 0.17, hd - 0.035, PAL.steel)
      }
      // PC tower under the desk opposite the pedestal, with a tiny LED.
      if (r() < 0.6) {
        const tx = ped < 0 ? hw - 0.3 : -hw + 0.12
        m.box(tx, 0, -hd + 0.15, tx + 0.18, 0.42, -hd + 0.6, hex(0x16181e))
        m.box(tx + 0.07, 0.36, -hd + 0.6, tx + 0.11, 0.38, -hd + 0.61, hex(0x40a0ff), MAT.glow, 3)
      }
      const mx = (r() - 0.5) * Math.max(0, w - 0.9) * 0.6
      monitor(m, mx, -hd + 0.2, r() < 0.28)
      if (r() < 0.25) monitor(m, mx + (mx > 0 ? -0.58 : 0.58), -hd + 0.22, r() < 0.3)
      keyboard(m, mx, -hd + 0.48)
      m.box(mx + 0.3, top, -hd + 0.44, mx + 0.36, top + 0.02, -hd + 0.53, hex(0x15171c))
      if (r() < 0.75) papers(m, mx > 0 ? -hw + 0.3 : hw - 0.3, 0.05, r)
      if (r() < 0.55) mug(m, mx + (r() < 0.5 ? -0.4 : 0.45), -hd + 0.38, [hex(0xe0e0e0), hex(0xb03a2a), hex(0x2a5a9a), hex(0x2a2a2a)][Math.floor(r() * 4)]!)
      if (r() < 0.25) {
        // Little desk plant.
        const from2 = m.length
        plantModel(m, 0.12, r)
        for (let i = from2; i < m.v.length; i += FLOATS_PER_VERT) {
          m.v[i]! *= 0.55
          m.v[i + 1] = m.v[i + 1]! * 0.45 + top
          m.v[i + 2]! *= 0.55
          m.v[i]! += hw - 0.15
          m.v[i + 2]! += -hd + 0.15
        }
      }
      if (r() < 0.35) {
        // Pen cup and a binder stack.
        m.prism(-hw + 0.15, -hd + 0.18, 0.035, 0.035, top, top + 0.1, 6, hex(0x2a2e38))
        m.box(-hw + 0.25, top, -hd + 0.08, -hw + 0.33, top + 0.28, -hd + 0.34, [hex(0x2a4a8a), hex(0x8a2a2a), hex(0x2a2a2a)][Math.floor(r() * 3)]!)
      }
      break
    }
    case "chair": {
      chairModel(m, r)
      spin(m, from, (r() - 0.5) * 0.7)
      break
    }
    case "cabinet": {
      const h = 1.1 + (r() < 0.4 ? 0.3 : 0)
      m.bevelBox(-hw, 0, -hd, hw, h, hd, 0.02, PAL.cabinet, hex(0x667089))
      const n = h > 1.2 ? 4 : 3
      const dh = (h - 0.1) / n
      for (let k = 0; k < n; k++) {
        const y = 0.06 + k * dh
        m.box(-hw + 0.04, y, hd, hw - 0.04, y + dh - 0.03, hd + 0.012, hex(0x5e6882))
        m.box(-0.08, y + dh - 0.12, hd + 0.012, 0.08, y + dh - 0.1, hd + 0.035, PAL.steel, MAT.shiny)
        m.box(-0.06, y + dh - 0.2, hd + 0.012, 0.06, y + dh - 0.16, hd + 0.016, PAL.paper)
      }
      if (r() < 0.4) m.yawBox((r() - 0.5) * w * 0.4, (r() - 0.5) * d * 0.3, 0.3, 0.22, h, h + 0.08 + r() * 0.1, r() - 0.5, PAL.box)
      break
    }
    case "plant": {
      plantModel(m, Math.min(w, d) / 2, r)
      break
    }
    case "sofa": {
      m.bevelBox(-hw, 0.08, -hd, hw, 0.4, hd, 0.03, PAL.sofa, hex(0x434360))
      m.bevelBox(-hw, 0.4, -hd, hw, 0.85, -hd + 0.22, 0.04, PAL.sofa, hex(0x47476a))
      for (const sx of [-1, 1]) m.bevelBox(sx > 0 ? hw - 0.18 : -hw, 0.4, -hd, sx > 0 ? hw : -hw + 0.18, 0.64, hd, 0.04, PAL.sofa, hex(0x47476a))
      const n = Math.max(2, Math.round((w - 0.36) / 0.6))
      const cw = (w - 0.36) / n
      for (let k = 0; k < n; k++) {
        const x = -hw + 0.18 + k * cw
        m.bevelBox(x + 0.01, 0.4, -hd + 0.22, x + cw - 0.01, 0.5, hd - 0.03, 0.04, hex(0x4a4a68), hex(0x52527a))
      }
      for (const sx of [-1, 1]) m.box(sx * (hw - 0.06) - 0.03, 0, -hd + 0.05, sx * (hw - 0.06) + 0.03, 0.08, hd - 0.05, PAL.dark)
      break
    }
    case "table": {
      const big = w > 1.6 || d > 1.6
      m.bevelBox(-hw, 0.71, -hd, hw, 0.75, hd, 0.015, hex(0x4a3a2e), PAL.table)
      if (big) {
        for (const [sx, sz] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ] as const)
          m.box(sx * (hw - 0.12) - 0.03, 0, sz * (hd - 0.12) - 0.03, sx * (hw - 0.12) + 0.03, 0.71, sz * (hd - 0.12) + 0.03, PAL.dark)
        for (let k = 0; k < 3; k++) if (r() < 0.6) papers(m, (r() - 0.5) * (w - 0.5), (r() - 0.5) * (d - 0.4), r, 0.75)
        if (r() < 0.6) mug(m, (r() - 0.5) * (w - 0.4), (r() - 0.5) * (d - 0.3), PAL.white, 0.75)
        if (r() < 0.5) {
          // An open laptop.
          const lx = (r() - 0.5) * (w - 0.6)
          m.box(lx - 0.17, 0.75, -0.12, lx + 0.17, 0.765, 0.12, hex(0x9aa0aa), MAT.shiny)
          m.box(lx - 0.17, 0.765, -0.13, lx + 0.17, 0.99, -0.115, hex(0x9aa0aa), MAT.shiny)
          m.box(lx - 0.15, 0.78, -0.114, lx + 0.15, 0.97, -0.11, PAL.screenOn, MAT.glow, 0.9)
        }
      } else {
        m.prism(0, 0, 0.05, 0.05, 0, 0.71, 6, PAL.dark)
        m.prism(0, 0, Math.min(hw, hd, 0.35), Math.min(hw, hd, 0.35) * 0.9, 0, 0.03, 8, PAL.dark)
        if (r() < 0.5) papers(m, -0.05, 0.02, r, 0.75)
        if (r() < 0.5) mug(m, 0.2, -0.1, PAL.white, 0.75)
      }
      break
    }
    case "vending": {
      m.bevelBox(-hw, 0, -hd, hw, 1.9, hd, 0.03, hex(0x1b2636), hex(0x2a3a50), MAT.shiny)
      const lamp = p.light ?? -1
      const glowMat = lamp >= 0 ? MAT.lamp : MAT.glow
      const glowAux = lamp >= 0 ? lamp : 0.6
      // Glass front with rows of cans, a selection panel and a lit header.
      m.box(-hw + 0.08, 0.5, hd, hw * 0.4, 1.72, hd + 0.015, hex(0x2a8ab0), glowMat, glowAux)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 4; i++) {
          const x = -hw + 0.13 + i * ((hw * 1.4 - 0.12) / 4)
          const col = [hex(0xff4040), hex(0x40c0ff), hex(0xffd040), hex(0x60ff80), hex(0xffffff)][(i + j * 3 + Math.floor(r() * 2)) % 5]!
          m.box(x, 0.58 + j * 0.28, hd + 0.015, x + 0.1, 0.76 + j * 0.28, hd + 0.03, col, glowMat, glowAux)
        }
      m.box(hw * 0.5, 0.9, hd, hw - 0.08, 1.5, hd + 0.02, hex(0x101820))
      for (let k = 0; k < 6; k++) m.box(hw * 0.55, 1.42 - k * 0.08, hd + 0.02, hw * 0.55 + 0.05, 1.46 - k * 0.08, hd + 0.03, hex(0x9ad8ff), MAT.glow, 1.5)
      m.box(-hw + 0.08, 1.76, hd, hw - 0.08, 1.86, hd + 0.02, hex(0x7af0ff), glowMat, glowAux)
      m.box(-hw + 0.1, 0.1, hd, hw - 0.1, 0.38, hd + 0.03, hex(0x0a0e14))
      break
    }
    case "copier":
    case "printer": {
      const h = p.kind === "copier" ? 0.95 : 0.8
      m.bevelBox(-hw, 0.05, -hd, hw, h, hd, 0.03, PAL.white, hex(0xdfe2e7))
      m.box(-hw + 0.03, 0, -hd + 0.03, hw - 0.03, 0.05, hd - 0.03, PAL.dark)
      for (let k = 0; k < 2; k++) m.box(-hw + 0.05, 0.15 + k * 0.22, hd, hw - 0.05, 0.33 + k * 0.22, hd + 0.01, hex(0xb4b9c2))
      m.bevelBox(-hw + 0.06, h, -hd + 0.06, hw - 0.08, h + 0.08, hd - 0.18, 0.02, hex(0x8e939e), hex(0x9ea3ae))
      m.box(hw - 0.35, h, hd - 0.17, hw - 0.04, h + 0.05, hd - 0.04, hex(0x3a3e48))
      m.box(hw - 0.32, h + 0.05, hd - 0.15, hw - 0.18, h + 0.055, hd - 0.07, hex(0x60b0ff), MAT.glow, 1.2)
      m.box(hw - 0.12, h + 0.05, hd - 0.12, hw - 0.08, h + 0.06, hd - 0.08, hex(0x30ff90), MAT.glow, 3)
      // Output tray with a sheet.
      m.box(-hw - 0.12, h - 0.25, -0.15, -hw, h - 0.23, 0.15, hex(0x9aa0aa))
      m.box(-hw - 0.1, h - 0.23, -0.12, -hw + 0.08, h - 0.225, 0.12, PAL.paper)
      break
    }
    case "counter": {
      m.box(-hw, 0, -hd, hw, 0.86, hd, hex(0x3e4658))
      for (let x = -hw + 0.02; x < hw - 0.3; x += 0.6) {
        m.box(x, 0.1, hd, x + 0.57, 0.8, hd + 0.012, hex(0x4a5468))
        m.box(x + 0.25, 0.7, hd + 0.012, x + 0.32, 0.72, hd + 0.03, PAL.steel, MAT.shiny)
      }
      m.bevelBox(-hw - 0.02, 0.86, -hd - 0.02, hw + 0.02, 0.9, hd + 0.03, 0.01, hex(0x7a808e), hex(0xb0b4bc), MAT.shiny)
      // Sink, coffee machine, kettle.
      if (w > 1.2) {
        m.box(-0.25, 0.86, -0.18, 0.25, 0.905, 0.18, hex(0x50565f), MAT.shiny)
        m.box(-0.2, 0.88, -0.14, 0.2, 0.906, 0.14, hex(0x1a1d22), MAT.shiny)
        m.box(-0.02, 0.9, -hd + 0.04, 0.02, 1.15, -hd + 0.08, PAL.steel, MAT.shiny)
        m.box(-0.02, 1.12, -hd + 0.04, 0.02, 1.15, -0.1, PAL.steel, MAT.shiny)
      }
      const cx = hw - 0.35
      m.bevelBox(cx - 0.15, 0.9, -hd + 0.05, cx + 0.15, 1.3, -hd + 0.35, 0.02, hex(0x1a1c22), hex(0x2a2c34), MAT.shiny)
      m.box(cx + 0.05, 1.2, -hd + 0.35, cx + 0.1, 1.22, -hd + 0.36, hex(0xff4020), MAT.glow, 3)
      m.prism(cx, -hd + 0.42, 0.04, 0.04, 0.9, 1.0, 7, PAL.white)
      if (w > 2) m.bevelBox(-hw + 0.1, 0.9, -hd + 0.05, -hw + 0.6, 1.2, -hd + 0.4, 0.02, hex(0xd0d2d6), hex(0xdcdee2))
      break
    }
    case "fridge":
      m.bevelBox(-hw, 0, -hd, hw, 1.85, hd, 0.04, hex(0xb9bec9), hex(0xd2d6dd), MAT.shiny)
      m.box(-hw + 0.02, 1.2, hd, hw - 0.02, 1.215, hd + 0.01, hex(0x7a808a))
      m.box(hw - 0.12, 1.3, hd, hw - 0.08, 1.7, hd + 0.04, PAL.steel, MAT.shiny)
      m.box(hw - 0.12, 0.7, hd, hw - 0.08, 1.1, hd + 0.04, PAL.steel, MAT.shiny)
      for (let k = 0; k < 3; k++) m.box(-hw + 0.15 + k * 0.12, 1.5 - k * 0.1, hd, -hw + 0.24 + k * 0.12, 1.6 - k * 0.1, hd + 0.005, [hex(0xe8d870), hex(0xff8aa0), hex(0x8ad0ff)][k]!)
      break
    case "cooler":
      m.bevelBox(-0.16, 0, -0.16, 0.16, 1.0, 0.16, 0.02, hex(0xd8dce4), hex(0xe4e8ee))
      m.box(-0.1, 0.62, 0.16, 0.1, 0.85, 0.17, hex(0x2a2e38))
      m.box(-0.06, 0.72, 0.17, -0.02, 0.76, 0.2, hex(0x3a7aff))
      m.box(0.02, 0.72, 0.17, 0.06, 0.76, 0.2, hex(0xff4a3a))
      m.box(-0.08, 0.62, 0.16, 0.08, 0.64, 0.22, hex(0x7a808a))
      m.prism(0, 0, 0.14, 0.14, 1.0, 1.36, 10, hex(0x3a8ae0), MAT.shiny)
      m.prism(0, 0, 0.14, 0.06, 1.36, 1.44, 10, hex(0x3a8ae0), MAT.shiny)
      m.prism(0, 0, 0.145, 0.145, 1.12, 1.15, 10, hex(0x5aa8ff), MAT.shiny)
      break
    case "bookshelf": {
      m.box(-hw, 0, -hd, hw, 1.9, hd, hex(0x3a2f2b), MAT.lit, 0, hex(0x4a3c36))
      for (let y = 0.1; y < 1.8; y += 0.45) {
        m.box(-hw + 0.03, y - 0.02, -hd + 0.02, hw - 0.03, y, hd + 0.005, hex(0x4a3c36))
        for (let x = -hw + 0.06; x < hw - 0.1; ) {
          const bw = 0.04 + r() * 0.05
          if (r() < 0.1) {
            x += 0.15
            continue
          }
          m.box(x, y, -hd + 0.05, x + bw, y + 0.26 + r() * 0.1, hd + 0.01, PAL.book[Math.floor(r() * 5)]!)
          x += bw + 0.008
        }
      }
      break
    }
    case "crate": {
      // A stack of cardboard boxes with tape.
      const s = Math.min(w, d)
      const h0 = s * 0.55
      m.box(-hw, 0, -hd, hw, h0, hd, PAL.crate, MAT.lit, 0, hex(0xae8656))
      m.box(-hw - 0.002, h0 - 0.002, -0.04, hw + 0.002, h0 + 0.002, 0.04, hex(0xc8b080))
      if (r() < 0.7) {
        const from2 = m.length
        const s2 = s * (0.55 + r() * 0.2)
        m.box(-s2 / 2, h0, -s2 / 2, s2 / 2, h0 + s2 * 0.7, s2 / 2, hex(0x8a6a44), MAT.lit, 0, hex(0xa47c50))
        m.box(-s2 / 2 - 0.002, h0 + s2 * 0.7 - 0.002, -0.035, s2 / 2 + 0.002, h0 + s2 * 0.7 + 0.002, 0.035, hex(0xc8b080))
        spin(m, from2, (r() - 0.5) * 0.8)
      }
      break
    }
    case "whiteboard": {
      // Wall-mounted board facing +z with scribbles and a marker tray.
      m.box(-hw, 0.9, -hd, hw, 2.0, -hd + 0.04, hex(0x9aa0aa), MAT.lit)
      m.box(-hw + 0.03, 0.93, -hd + 0.04, hw - 0.03, 1.97, -hd + 0.047, hex(0xeef1f4), MAT.shiny)
      for (let k = 0; k < 7; k++) {
        const x = -hw + 0.2 + r() * (w - 0.7)
        const y = 1.1 + r() * 0.7
        const col = [hex(0x2a4ab0), hex(0xb02a2a), hex(0x2a8a4a), hex(0x222222)][Math.floor(r() * 4)]!
        const from2 = m.length
        m.box(-0.12 - r() * 0.15, -0.012, 0, 0.12 + r() * 0.15, 0.012, 0.004, col)
        spin(m, from2, 0)
        for (let i = from2; i < m.v.length; i += FLOATS_PER_VERT) {
          m.v[i]! += x
          m.v[i + 1]! += y
          m.v[i + 2]! += -hd + 0.047
        }
      }
      m.box(-hw + 0.2, 0.9, -hd + 0.04, hw - 0.2, 0.92, -hd + 0.1, hex(0x9aa0aa))
      for (let k = 0; k < 3; k++) m.box(-0.2 + k * 0.12, 0.92, -hd + 0.06, -0.12 + k * 0.12, 0.94, -hd + 0.08, [hex(0x2a4ab0), hex(0xb02a2a), hex(0x2a8a4a)][k]!)
      break
    }
    case "reception": {
      m.bevelBox(-hw, 0, -hd, hw, 1.05, hd, 0.02, hex(0x3a4155), hex(0xb0a080), MAT.lit)
      m.box(-hw + 0.05, 0.1, hd, hw - 0.05, 0.14, hd + 0.01, hex(0x7ad0ff), MAT.glow, 1.2)
      m.box(-hw + 0.05, 0.72, -hd - 0.3, hw - 0.05, 0.76, -hd, PAL.deskTop)
      monitor(m, 0.3, -hd - 0.15, true, 0.76)
      break
    }
    case "lamp": {
      // Articulated desk lamp: weighted base, two arm segments, a shade whose inside glows with its light.
      m.prism(0, 0, 0.08, 0.07, 0.76, 0.79, 8, PAL.dark)
      m.box(-0.012, 0.78, -0.012, 0.012, 0.98, 0.012, hex(0x2a2c32))
      m.yawBox(0.06, 0, 0.14, 0.022, 0.97, 0.995, 0, hex(0x2a2c32))
      m.prism(0.12, 0.0, 0.11, 0.05, 0.9, 1.04, 8, hex(0x26282e), MAT.shiny)
      if (p.light !== undefined) {
        m.prism(0.12, 0.0, 0.095, 0.095, 0.895, 0.905, 8, hex(0xffcf8a), MAT.lamp, p.light, true)
        m.prism(0.12, 0.0, 0.035, 0.035, 0.9, 0.94, 6, hex(0xfff2d0), MAT.lamp, p.light)
      }
      break
    }
    case "exitdoor": {
      // Steel fire door set into the wall (whose faces are 0.15 either side of the line), with frame and push bar.
      for (const s of [-1, 1]) {
        const z0 = s * 0.15
        const z1 = s * 0.19
        const lo = Math.min(z0, z1)
        const hi = Math.max(z0, z1)
        m.box(-hw + 0.02, 0, lo, -hw + 0.1, 2.28, hi, PAL.doorFrame)
        m.box(hw - 0.1, 0, lo, hw - 0.02, 2.28, hi, PAL.doorFrame)
        m.box(-hw + 0.02, 2.2, lo, hw - 0.02, 2.28, hi, PAL.doorFrame)
        m.box(-hw + 0.1, 0, Math.min(z0, s * 0.172), hw - 0.1, 2.2, Math.max(z0, s * 0.172), hex(0x46565a), MAT.shiny)
        m.box(-hw + 0.2, 1.0, Math.min(s * 0.172, s * 0.22), hw - 0.2, 1.06, Math.max(s * 0.172, s * 0.22), PAL.steel, MAT.shiny)
      }
      break
    }
    case "boards": {
      // Plasterboard stacked on two battens, the top sheets a little askew.
      for (const sx of [-0.3, 0.3]) m.box(sx * w - 0.04, 0, -hd + 0.02, sx * w + 0.04, 0.08, hd - 0.02, hex(0x5a4430))
      const sheets = 3 + Math.floor(r() * 4)
      for (let k = 0; k < sheets; k++) {
        const from2 = m.length
        const y = 0.08 + k * 0.05
        m.box(-hw + 0.02, y, -hd + 0.02, hw - 0.02, y + 0.045, hd - 0.02, k % 2 ? hex(0xb4b6b0) : hex(0xa8aaa4), MAT.lit, 0, hex(0xc4c6c0))
        if (k >= sheets - 2) spin(m, from2, (r() - 0.5) * 0.12)
      }
      break
    }
    case "ladder": {
      // An aluminium ladder laid on the floor: two rails and rungs.
      for (const sx of [-1, 1]) m.box(sx * hw - (sx > 0 ? 0.05 : 0), 0, -hd, sx * hw + (sx > 0 ? 0 : 0.05), 0.07, hd, hex(0x9aa2ae), MAT.shiny)
      for (let z = -hd + 0.15; z < hd - 0.1; z += 0.28) m.box(-hw + 0.05, 0.02, z - 0.02, hw - 0.05, 0.05, z + 0.02, hex(0x8a929e), MAT.shiny)
      break
    }
    default:
      m.box(-hw, 0, -hd, hw, 0.8, hd, PAL.cabinet)
  }
  m.place(from, p.rot, (p.rect[0] + p.rect[2]) / 2, 0, (p.rect[1] + p.rect[3]) / 2)
}
