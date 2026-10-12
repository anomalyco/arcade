import { GUN_IDS, type Gun } from "../../shared/config"
import { MAT, Mesh } from "./mesh"
import { hex } from "./models"

/**
 * A low-poly soldier split into parts so it can animate. Every part faces +x with its pivot at the origin:
 * legs hang from the hip, the torso (with head) stands on the hip, and the arms and gun reach forward from the
 * shoulder. HIP and SHOULDER are the pivot heights. Accent parts take the player's colour.
 */
export const HIP = 0.82
export const SHOULDER = 1.32
/** Muzzle position relative to the shoulder pivot, along the aim. */
export const MUZZLE: Record<Gun, number> = { rifle: 1.0, shotgun: 0.95, sniper: 1.35 }

const CLOTH = hex(0x2a2f3b)
const DARK = hex(0x15171d)
const SKIN = hex(0x9a7a64)
const GUNMETAL = hex(0x111318)

function leg(side: number): Mesh {
  const m = new Mesh()
  const z0 = side < 0 ? -0.19 : 0.05
  const z1 = side < 0 ? -0.05 : 0.19
  m.box(-0.08, -0.45, z0, 0.08, 0, z1, CLOTH)
  m.box(-0.07, -0.78, z0 + 0.01, 0.07, -0.45, z1 - 0.01, CLOTH)
  m.box(-0.08, -0.82, z0, 0.18, -0.74, z1, DARK)
  return m
}

function torso(): Mesh {
  const m = new Mesh()
  m.box(-0.13, 0, -0.22, 0.12, 0.2, 0.22, DARK)
  m.box(-0.14, 0.16, -0.24, 0.14, 0.62, 0.24, CLOTH)
  // Vest in the team colour, and shoulder pads.
  m.box(-0.155, 0.22, -0.2, 0.155, 0.58, 0.2, [1, 1, 1], MAT.accent)
  m.box(-0.1, 0.52, -0.3, 0.1, 0.62, -0.2, CLOTH)
  m.box(-0.1, 0.52, 0.2, 0.1, 0.62, 0.3, CLOTH)
  // Head with a helmet and a dark visor slit facing forward.
  m.prism(0, 0, 0.12, 0.11, 0.64, 0.86, 6, SKIN)
  m.prism(-0.01, 0, 0.15, 0.12, 0.8, 0.95, 6, hex(0x343a48))
  m.box(0.09, 0.74, -0.09, 0.14, 0.8, 0.09, DARK)
  return m
}

/** Arms holding the gun out front. Origin at the shoulder line. */
function arms(gun: Gun): Mesh {
  const m = new Mesh()
  // Upper arms down from the shoulders, forearms forward to the grip.
  m.box(-0.06, -0.24, -0.3, 0.08, 0.02, -0.18, CLOTH)
  m.box(-0.06, -0.24, 0.18, 0.08, 0.02, 0.3, CLOTH)
  m.box(0.02, -0.22, -0.26, 0.36, -0.1, -0.14, CLOTH)
  m.box(0.02, -0.22, 0.04, 0.5, -0.1, 0.16, CLOTH)
  m.box(0.34, -0.2, -0.16, 0.44, -0.1, -0.02, SKIN)
  m.box(0.48, -0.2, 0.0, 0.58, -0.1, 0.12, SKIN)
  const y0 = -0.2
  if (gun === "rifle") {
    m.box(-0.12, y0 - 0.02, -0.04, 0.2, y0 + 0.07, 0.04, GUNMETAL)
    m.box(0.2, y0 - 0.01, -0.035, 0.66, y0 + 0.07, 0.035, hex(0x1c1f27))
    m.box(0.66, y0 + 0.01, -0.02, 0.98, y0 + 0.05, 0.02, GUNMETAL)
    m.box(0.18, y0 - 0.16, -0.03, 0.26, y0, 0.03, GUNMETAL)
    m.box(0.3, y0 + 0.07, -0.025, 0.42, y0 + 0.11, 0.025, GUNMETAL)
  } else if (gun === "shotgun") {
    m.box(-0.14, y0 - 0.03, -0.045, 0.24, y0 + 0.07, 0.045, hex(0x3a2a20))
    m.box(0.24, y0 + 0.0, -0.04, 0.92, y0 + 0.07, 0.04, GUNMETAL)
    m.box(0.42, y0 - 0.05, -0.05, 0.7, y0 + 0.0, 0.05, hex(0x4a3526))
  } else {
    m.box(-0.18, y0 - 0.03, -0.04, 0.3, y0 + 0.06, 0.04, hex(0x2a3324))
    m.box(0.3, y0 + 0.0, -0.025, 1.32, y0 + 0.045, 0.025, GUNMETAL)
    m.prism(0.15, 0, 0.045, 0.045, y0 + 0.08, y0 + 0.11, 6, GUNMETAL)
    m.box(0.05, y0 + 0.07, -0.035, 0.3, y0 + 0.12, 0.035, GUNMETAL)
  }
  return m
}

/** The whole soldier standing, for corpses. */
function whole(gun: Gun): Mesh {
  const m = new Mesh()
  for (const part of [leg(-1), leg(1)]) {
    const from = m.length
    m.v.push(...part.v)
    m.place(from, 0, 0, HIP, 0)
  }
  const t = torso()
  let from = m.length
  m.v.push(...t.v)
  m.place(from, 0, 0, HIP, 0)
  const a = arms(gun)
  from = m.length
  m.v.push(...a.v)
  m.place(from, 0, 0, SHOULDER, 0)
  return m
}

export type PersonModels = { legL: Mesh; legR: Mesh; torso: Mesh; arms: Record<Gun, Mesh>; whole: Record<Gun, Mesh> }

export function personModels(): PersonModels {
  const armsBy = {} as Record<Gun, Mesh>
  const wholeBy = {} as Record<Gun, Mesh>
  for (const g of GUN_IDS) {
    armsBy[g] = arms(g)
    wholeBy[g] = whole(g)
  }
  return { legL: leg(-1), legR: leg(1), torso: torso(), arms: armsBy, whole: wholeBy }
}
