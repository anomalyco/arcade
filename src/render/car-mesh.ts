import { VEHICLES, type Vehicle } from "../../shared/config"
import { MAT, Mesh, type Rgb } from "./mesh"

const TIRE: Rgb = [0.05, 0.05, 0.06]
const GLASS: Rgb = [0.08, 0.1, 0.14]
const HEAD: Rgb = [1.0, 0.95, 0.85]
const TAIL: Rgb = [1.0, 0.08, 0.06]
const CHROME: Rgb = [0.5, 0.52, 0.55]
const BLACK: Rgb = [0.06, 0.06, 0.07]

/** Siren lamps are emissive with a special material; red is encoded by r > b. */
const SIREN_RED: Rgb = [1, 0.05, 0.05]
const SIREN_BLUE: Rgb = [0.1, 0.25, 1]

export const MAT_SIREN = MAT.siren

/** A tapered cabin with sloped windshield and rear glass. */
function cabin(m: Mesh, hw: number, y0: number, y1: number, zr0: number, zr1: number, zf0: number, zf1: number, roof: Rgb, glass: Rgb) {
  const tw = hw * 0.86
  // Roof
  m.quad([-tw, y1, zr1], [-tw, y1, zf1], [tw, y1, zf1], [tw, y1, zr1], [0, 1, 0], roof)
  // Windshield (front slope)
  const nf = norm([0, zf0 - zf1, y1 - y0])
  m.quad([-tw, y1, zf1], [-hw, y0, zf0], [hw, y0, zf0], [tw, y1, zf1], nf, glass)
  // Rear glass
  const nr = norm([0, zr1 - zr0, -(y1 - y0)])
  m.quad([-hw, y0, zr0], [-tw, y1, zr1], [tw, y1, zr1], [hw, y0, zr0], [0, nr[1]!, nr[2]!], glass)
  // Side windows
  for (const s of [-1, 1]) {
    const n = [s, 0.25, 0]
    const a = [s * hw, y0, zr0]
    const b = [s * tw, y1, zr1]
    const c = [s * tw, y1, zf1]
    const d = [s * hw, y0, zf0]
    if (s > 0) m.quad(a, b, c, d, n, glass)
    else m.quad(a, d, c, b, n, glass)
  }
}

function norm(v: number[]) {
  const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1
  return [v[0]! / l, v[1]! / l, v[2]! / l]
}

function wheels(m: Mesh, hw: number, zf: number, zr: number, r: number, w: number) {
  for (const z of [zf, zr])
    for (const s of [-1, 1]) {
      const x = s * (hw - w * 0.4)
      m.box(x - w / 2, x + w / 2, 0.02, r * 2, z - r, z + r, TIRE)
      m.box(x - w / 2 - 0.01, x + w / 2 + 0.01, r * 0.6, r * 1.4, z - r * 0.4, z + r * 0.4, CHROME)
    }
}

function lights(m: Mesh, hw: number, y: number, zf: number, zr: number, inset = 0.25) {
  for (const s of [-1, 1]) {
    m.box(s * (hw - inset) - 0.22, s * (hw - inset) + 0.22, y - 0.1, y + 0.1, zf - 0.02, zf + 0.04, HEAD, MAT.emissive)
    m.box(s * (hw - inset) - 0.24, s * (hw - inset) + 0.24, y - 0.08, y + 0.1, zr - 0.04, zr + 0.02, TAIL, MAT.emissive)
  }
}

function lightbar(m: Mesh, y: number, z: number, w: number) {
  m.box(-w, w, y, y + 0.08, z - 0.25, z + 0.25, BLACK)
  m.box(-w, -0.05, y + 0.08, y + 0.3, z - 0.22, z + 0.22, SIREN_RED, MAT.siren)
  m.box(0.05, w, y + 0.08, y + 0.3, z - 0.22, z + 0.22, SIREN_BLUE, MAT.siren)
}

export function buildCar(v: Vehicle): Mesh {
  const m = new Mesh()
  const L = v.length
  const hw = v.width / 2
  const paint = v.paint
  const accent = v.accent
  const zf = L / 2
  const zr = -L / 2
  switch (v.id) {
    case "bike": {
      m.box(-0.12, 0.12, 0.05, 0.7, zf - 0.7, zf, TIRE)
      m.box(-0.12, 0.12, 0.05, 0.7, zr, zr + 0.7, TIRE)
      m.box(-0.3, 0.3, 0.5, 1.0, zr + 0.4, zf - 0.5, paint)
      m.box(-0.25, 0.25, 0.9, 1.15, zr + 0.6, zr + 1.4, BLACK)
      m.box(-0.36, 0.36, 0.9, 1.7, zr + 0.8, zr + 1.5, [0.1, 0.1, 0.12])
      m.box(-0.22, 0.22, 1.7, 2.0, zr + 0.95, zr + 1.35, accent)
      m.box(-0.45, 0.45, 1.05, 1.12, zf - 0.85, zf - 0.75, CHROME)
      m.box(-0.12, 0.12, 0.85, 1.05, zf - 0.55, zf - 0.45, HEAD, MAT.emissive)
      m.box(-0.12, 0.12, 0.75, 0.9, zr + 0.1, zr + 0.2, TAIL, MAT.emissive)
      break
    }
    case "van":
    case "swat": {
      wheels(m, hw, zf - 0.9, zr + 1.0, 0.42, 0.34)
      m.box(-hw, hw, 0.35, 1.0, zr, zf, paint)
      m.box(-hw, hw, 1.0, 2.35, zr, zf - 1.2, paint)
      const n = norm([0, 1.2, 1.35])
      m.quad([-hw * 0.95, 2.35, zf - 1.2], [-hw, 1.0, zf], [hw, 1.0, zf], [hw * 0.95, 2.35, zf - 1.2], n, GLASS)
      m.box(-hw - 0.01, hw + 0.01, 1.4, 2.0, zf - 2.0, zf - 1.3, GLASS)
      m.box(-hw * 0.9, hw * 0.9, 2.35, 2.4, zr + 0.2, zf - 1.4, v.id === "swat" ? accent : [0.85, 0.85, 0.87])
      if (v.id === "swat") {
        m.box(-hw - 0.02, hw + 0.02, 1.05, 1.25, zr + 0.4, zf - 1.5, accent)
        lightbar(m, 2.4, zf - 1.6, hw * 0.8)
      } else m.box(-hw - 0.02, hw + 0.02, 1.2, 1.3, zr + 0.3, zf - 1.5, accent)
      lights(m, hw, 0.8, zf, zr)
      m.box(-hw, hw, 0.3, 0.5, zf - 0.02, zf + 0.12, BLACK)
      break
    }
    default: {
      const r = 0.36
      wheels(m, hw, zf - 0.85, zr + 0.85, r, 0.3)
      const beltY = 0.95
      const lowY = 0.32
      const muscle = v.id === "muscle"
      const cop = v.role === "cop"
      // Lower body with slightly pinched nose and tail.
      m.box(-hw, hw, lowY, beltY, zr + 0.1, zf - 0.1, paint)
      m.box(-hw * 0.94, hw * 0.94, lowY + 0.05, beltY - 0.05, zr, zf, paint)
      // Hood and trunk tops, two-tone for police (black hood/trunk, white doors).
      const panel: Rgb = cop && v.id === "cruiser" ? BLACK : paint
      const hoodEnd = zf - 0.02
      const cabFront = zf - (muscle ? 2.0 : v.id === "compact" ? 1.15 : 1.6)
      const cabRear = zr + (muscle ? 1.0 : v.id === "compact" ? 0.55 : 1.0)
      m.box(-hw * 0.96, hw * 0.96, beltY - 0.02, beltY + 0.04, cabFront, hoodEnd, panel)
      m.box(-hw * 0.96, hw * 0.96, beltY - 0.02, beltY + 0.04, zr + 0.02, cabRear, panel)
      if (cop && v.id === "cruiser") {
        m.box(-hw - 0.01, hw + 0.01, lowY, beltY, zf - 1.1, zf - 0.1, BLACK)
        m.box(-hw - 0.01, hw + 0.01, lowY, beltY, zr + 0.1, zr + 0.9, BLACK)
        m.box(-hw - 0.02, hw + 0.02, 0.55, 0.72, cabRear + 0.2, cabFront - 0.2, [0.15, 0.3, 0.75])
      }
      const roofY = v.id === "compact" ? 1.6 : muscle ? 1.3 : 1.48
      const roofCol: Rgb = cop && v.id === "cruiser" ? [0.93, 0.94, 0.96] : paint
      cabin(m, hw * 0.92, beltY + 0.04, roofY, cabRear, cabRear + 0.45, cabFront, cabFront - 0.6, roofCol, GLASS)
      if (muscle) {
        // Racing stripes and a ducktail spoiler.
        m.box(-0.32, -0.12, beltY + 0.045, beltY + 0.06, cabFront, hoodEnd, accent)
        m.box(0.12, 0.32, beltY + 0.045, beltY + 0.06, cabFront, hoodEnd, accent)
        m.box(-hw * 0.9, hw * 0.9, beltY + 0.04, beltY + 0.28, zr + 0.05, zr + 0.3, paint)
        m.box(-hw * 0.4, hw * 0.4, beltY + 0.04, beltY + 0.2, cabFront + 0.6, cabFront + 1.3, BLACK)
      }
      if (cop) lightbar(m, roofY, (cabRear + cabFront) / 2 - 0.1, hw * 0.75)
      lights(m, hw, 0.72, zf, zr)
      // Bumpers.
      m.box(-hw * 0.9, hw * 0.9, 0.3, 0.48, zf - 0.05, zf + 0.08, cop ? BLACK : CHROME)
      m.box(-hw * 0.9, hw * 0.9, 0.3, 0.48, zr - 0.08, zr + 0.05, cop ? BLACK : CHROME)
      if (cop) m.box(-hw * 0.55, hw * 0.55, 0.3, 0.8, zf + 0.05, zf + 0.25, BLACK)
    }
  }
  return m
}

/** Helicopter in local space: body, tail boom, skids. Rotor is a separate spinning instance. */
export function buildHeli(): Mesh {
  const m = new Mesh()
  const body: Rgb = [0.1, 0.11, 0.14]
  const white: Rgb = [0.85, 0.86, 0.88]
  m.box(-1.0, 1.0, 0.6, 2.2, -1.6, 1.4, body)
  m.box(-0.85, 0.85, 0.8, 2.0, 1.4, 2.4, GLASS)
  m.box(-1.01, 1.01, 0.9, 1.3, -1.4, 1.2, white)
  m.box(-0.3, 0.3, 1.3, 1.9, -6.5, -1.6, body)
  m.box(-0.08, 0.08, 1.6, 3.0, -6.6, -5.8, body)
  m.box(-0.9, 0.9, 1.7, 1.8, -6.4, -6.0, white)
  for (const s of [-1, 1]) {
    m.box(s * 1.1 - 0.08, s * 1.1 + 0.08, 0, 0.12, -1.8, 1.8, BLACK)
    m.box(s * 0.9 - 0.06, s * 0.9 + 0.06, 0.1, 0.7, -0.8, -0.6, BLACK)
    m.box(s * 0.9 - 0.06, s * 0.9 + 0.06, 0.1, 0.7, 0.8, 1.0, BLACK)
  }
  m.box(-0.2, 0.2, 2.2, 2.6, -0.2, 0.2, BLACK)
  m.box(-0.12, 0.12, 0.45, 0.6, 2.2, 2.4, HEAD, MAT.emissive)
  m.box(-0.05, 0.05, 2.9, 3.05, -6.3, -6.2, TAIL, MAT.emissive)
  return m
}

export function buildRotor(): Mesh {
  const m = new Mesh()
  m.box(-0.18, 0.18, 0, 0.06, -6, 6, [0.12, 0.12, 0.13])
  m.box(-6, 6, 0, 0.06, -0.18, 0.18, [0.12, 0.12, 0.13])
  return m
}

export const CAR_MODELS = VEHICLES.map((v) => v.id)
