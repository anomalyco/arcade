import { GUN_IDS, type Gun } from "../../shared/config"
import { MAT, type Mat, Mesh, type Rgb } from "./mesh"
import { hex } from "./models"

/**
 * The low-poly soldier (concept/char-1-turnaround.png, char-8-ingame-squad.png): chunky helmet with a glowing ridge,
 * broad shoulders with glowing armbands, a backpack with a glowing stripe, knee pads and boots. It is split into
 * bones that src/game/anim.ts poses one by one. Every part faces +x with +y up and +z to its right, pivot at its joint:
 * limbs hang down -y from the joint, the torso stands up +y from the waist, feet and guns reach forward +x.
 */
export const RIG = {
  /** Hip joints sit this far either side of the pelvis pivot. */
  hipW: 0.11,
  thigh: 0.42,
  shin: 0.41,
  /** Ankle joint above the sole. */
  ankle: 0.085,
  /** Torso pivot above the pelvis pivot. */
  waist: 0.1,
  /** Shoulder joints in the torso frame. */
  shoulderY: 0.43,
  shoulderW: 0.235,
  neckY: 0.5,
  upper: 0.29,
  /** Elbow to the middle of the hand. */
  fore: 0.27,
}

/** Standing pelvis height with soft knees. */
export const HIP = 0.86
/** Rough shoulder height, for aiming the cursor and effects. */
export const SHOULDER = 1.38

/** Where each gun sits, in the aim frame from the body centre on the floor: grip forward, height, to the right. */
export const HOLD: Record<Gun, { fwd: number; up: number; side: number }> = {
  rifle: { fwd: 0.27, up: 1.24, side: 0.07 },
  shotgun: { fwd: 0.27, up: 1.2, side: 0.08 },
  sniper: { fwd: 0.2, up: 1.25, side: 0.07 },
}

/** Points on each gun model (gun-local, grip at the origin). */
export const GUNPTS: Record<Gun, { muzzle: number; fore: number; mag: [number, number, number]; port: [number, number, number] }> = {
  rifle: { muzzle: 0.66, fore: 0.3, mag: [0.1, -0.005, 0], port: [0.08, 0.05, 0.035] },
  shotgun: { muzzle: 0.68, fore: 0.37, mag: [0.1, -0.02, 0], port: [0.08, 0.04, 0.04] },
  sniper: { muzzle: 1.04, fore: 0.32, mag: [0.08, -0.03, 0], port: [0.04, 0.06, 0.04] },
}

/** Muzzle distance ahead of the body centre along the aim. */
export const MUZZLE: Record<Gun, number> = {
  rifle: HOLD.rifle.fwd + GUNPTS.rifle.muzzle,
  shotgun: HOLD.shotgun.fwd + GUNPTS.shotgun.muzzle,
  sniper: HOLD.sniper.fwd + GUNPTS.sniper.muzzle,
}

const CLOTH = hex(0x4a5470)
const CLOTH_D = hex(0x343c52)
const GEAR = hex(0x262a33)
const POUCH = hex(0x5a5a46)
const HELMET = hex(0x2a2e38)
const HELMET_T = hex(0x3c4250)
const VISOR = hex(0x07080b)
const SKIN = hex(0x8a6a50)
const GLOVE = hex(0x7a5c40)
const BOOT = hex(0x2a221d)
const SOLE = hex(0x121010)
const METAL = hex(0x1a1c21)
const METAL_L = hex(0x2c3038)
const WOOD = hex(0x6b4027)
const OLIVE = hex(0x4c5634)
const BRASS = hex(0xd8a640)
const ACC: Rgb = [1, 1, 1]

/** Soldier meshes default to the actor material. */
class Body extends Mesh {
  override box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: Rgb, mat: Mat = MAT.actor, aux = 0, top?: Rgb, bottom = false): void {
    super.box(x0, y0, z0, x1, y1, z1, col, mat === MAT.lit ? MAT.actor : mat, aux, top, bottom)
  }
  override prism(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, sides: number, col: Rgb, mat: Mat = MAT.actor, aux = 0, cap = true): void {
    super.prism(cx, cz, r0, r1, y0, y1, sides, col, mat === MAT.lit ? MAT.actor : mat, aux, cap)
  }
}

const acc = (m: Mesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) => m.box(x0, y0, z0, x1, y1, z1, ACC, MAT.accent)

function pelvis(): Mesh {
  const m = new Body()
  m.box(-0.12, -0.07, -0.18, 0.11, 0.1, 0.18, CLOTH)
  m.box(-0.13, 0.05, -0.19, 0.12, 0.11, 0.19, GEAR)
  // Belt pouches and a holster on the right.
  m.box(-0.16, -0.02, -0.12, -0.12, 0.09, -0.02, POUCH)
  m.box(-0.16, -0.02, 0.02, -0.12, 0.09, 0.12, POUCH)
  m.box(-0.06, -0.12, 0.18, 0.06, 0.08, 0.23, GEAR)
  return m
}

function torso(): Mesh {
  const m = new Body()
  // Abdomen and chest.
  m.box(-0.12, -0.02, -0.16, 0.11, 0.2, 0.16, CLOTH)
  m.box(-0.14, 0.15, -0.21, 0.14, 0.45, 0.21, CLOTH)
  // Plate carrier, front and back, with magazine pouches.
  m.box(-0.16, 0.12, -0.17, 0.17, 0.44, 0.17, GEAR, MAT.lit, 0, hex(0x23272f))
  for (const z of [-0.11, 0, 0.11]) m.box(0.17, 0.15, z - 0.045, 0.22, 0.29, z + 0.045, POUCH)
  m.box(0.17, 0.31, -0.13, 0.2, 0.4, -0.03, GEAR)
  // Collar and shoulder straps.
  m.box(-0.1, 0.42, -0.14, 0.09, 0.5, 0.14, CLOTH_D)
  m.box(-0.14, 0.44, -0.2, 0.14, 0.47, -0.13, GEAR)
  m.box(-0.14, 0.44, 0.13, 0.14, 0.47, 0.2, GEAR)
  // Backpack with a glowing stripe across the top flap and a radio antenna.
  m.box(-0.33, 0.1, -0.15, -0.16, 0.45, 0.15, GEAR, MAT.lit, 0, hex(0x23272f))
  m.box(-0.35, 0.14, -0.12, -0.32, 0.36, 0.12, POUCH)
  acc(m, -0.3, 0.45, -0.1, -0.2, 0.47, 0.1)
  acc(m, -0.355, 0.3, -0.07, -0.345, 0.33, 0.07)
  m.box(-0.3, 0.45, 0.1, -0.28, 0.78, 0.12, METAL)
  return m
}

function head(): Mesh {
  const m = new Body()
  m.box(-0.05, -0.02, -0.05, 0.05, 0.08, 0.05, CLOTH_D)
  // Face under a balaclava, then the helmet shell.
  m.box(-0.07, 0.05, -0.085, 0.1, 0.2, 0.085, hex(0x1d1f25))
  m.box(0.095, 0.1, -0.05, 0.105, 0.13, 0.05, SKIN)
  m.prism(-0.005, 0, 0.165, 0.15, 0.13, 0.25, 8, HELMET)
  m.prism(-0.005, 0, 0.15, 0.085, 0.25, 0.33, 8, HELMET_T)
  // Goggles / visor and ear cups.
  m.box(0.1, 0.13, -0.11, 0.16, 0.2, 0.11, VISOR)
  m.box(-0.04, 0.12, -0.18, 0.06, 0.22, -0.15, GEAR)
  m.box(-0.04, 0.12, 0.15, 0.06, 0.22, 0.18, GEAR)
  // Glowing ridge running front to back over the dome.
  acc(m, -0.09, 0.3, -0.024, 0.09, 0.338, 0.024)
  acc(m, -0.135, 0.255, -0.024, 0.135, 0.3, 0.024)
  acc(m, -0.172, 0.16, -0.024, 0.172, 0.255, 0.024)
  return m
}

function upperArm(): Mesh {
  const m = new Body()
  m.box(-0.085, -0.11, -0.085, 0.085, 0.05, 0.085, GEAR)
  // Glowing strip across the top of the shoulder pad, and an armband below it.
  acc(m, -0.06, 0.05, -0.03, 0.06, 0.07, 0.03)
  m.box(-0.06, -0.29, -0.06, 0.06, -0.05, 0.06, CLOTH)
  acc(m, -0.066, -0.16, -0.066, 0.066, -0.12, 0.066)
  return m
}

function foreArm(): Mesh {
  const m = new Body()
  m.box(-0.055, -0.06, -0.055, 0.055, 0.03, 0.055, CLOTH_D)
  m.box(-0.05, -0.21, -0.05, 0.05, -0.04, 0.05, CLOTH)
  m.box(-0.056, -0.22, -0.056, 0.056, -0.18, 0.056, GEAR)
  // Gloved hand centred on the end of the bone.
  m.box(-0.05, -0.32, -0.045, 0.06, -0.22, 0.045, GLOVE)
  return m
}

function thigh(): Mesh {
  const m = new Body()
  m.box(-0.085, -0.43, -0.08, 0.085, 0.04, 0.08, CLOTH)
  m.box(-0.07, -0.3, -0.095, 0.05, -0.14, 0.095, CLOTH_D)
  return m
}

function shin(): Mesh {
  const m = new Body()
  m.box(-0.065, -0.33, -0.065, 0.065, 0.02, 0.065, CLOTH)
  m.box(0.03, -0.12, -0.07, 0.1, 0.06, 0.07, GEAR)
  m.box(-0.075, -0.42, -0.072, 0.08, -0.29, 0.072, BOOT)
  return m
}

function foot(): Mesh {
  const m = new Body()
  m.box(-0.075, -0.07, -0.065, 0.18, 0.02, 0.065, BOOT)
  m.box(-0.08, -0.085, -0.068, 0.19, -0.065, 0.068, SOLE)
  return m
}

/** Guns: grip at the origin, barrel along +x. Magazines and the shotgun pump are separate parts. */
function gun(g: Gun): Mesh {
  const m = new Body()
  if (g === "rifle") {
    m.box(-0.34, -0.07, -0.025, -0.3, 0.06, 0.025, METAL)
    m.box(-0.3, -0.02, -0.022, -0.06, 0.04, 0.022, METAL_L)
    m.box(-0.07, -0.01, -0.03, 0.2, 0.07, 0.03, METAL)
    m.box(-0.025, -0.12, -0.022, 0.035, 0.0, 0.022, METAL)
    m.box(0.2, 0.0, -0.034, 0.48, 0.066, 0.034, METAL_L, MAT.lit, 0, hex(0x3a3f4a))
    m.box(0.48, 0.022, -0.013, 0.62, 0.045, 0.013, METAL)
    m.box(0.6, 0.015, -0.02, 0.67, 0.052, 0.02, METAL)
    m.box(0.04, 0.07, -0.02, 0.12, 0.12, 0.02, METAL)
    m.box(0.105, 0.085, -0.012, 0.115, 0.11, 0.012, hex(0xff2a20), MAT.glow, 2)
    m.box(0.26, -0.07, -0.018, 0.3, 0.0, 0.018, METAL)
  } else if (g === "shotgun") {
    m.box(-0.38, -0.08, -0.03, -0.18, 0.05, 0.03, WOOD)
    m.box(-0.18, -0.06, -0.026, -0.03, 0.04, 0.026, WOOD)
    m.box(-0.04, -0.03, -0.034, 0.18, 0.07, 0.034, METAL)
    m.box(-0.02, -0.1, -0.02, 0.04, -0.02, 0.02, METAL)
    m.box(0.18, 0.035, -0.024, 0.68, 0.075, 0.024, METAL_L)
    m.box(0.18, -0.015, -0.02, 0.6, 0.032, 0.02, METAL)
    m.box(0.62, 0.075, -0.006, 0.65, 0.09, 0.006, METAL_L)
  } else {
    m.box(-0.44, -0.08, -0.03, -0.36, 0.06, 0.03, OLIVE)
    m.box(-0.36, -0.05, -0.028, -0.12, 0.05, 0.028, OLIVE)
    m.box(-0.12, -0.035, -0.024, 0.02, 0.04, 0.024, OLIVE)
    m.box(-0.03, -0.11, -0.02, 0.03, -0.02, 0.02, OLIVE)
    m.box(0.02, -0.04, -0.034, 0.42, 0.045, 0.034, OLIVE, MAT.lit, 0, hex(0x5e6a42))
    m.box(-0.06, 0.03, -0.028, 0.2, 0.08, 0.028, METAL)
    m.box(0.42, 0.015, -0.016, 0.96, 0.045, 0.016, METAL)
    m.box(0.95, 0.008, -0.026, 1.04, 0.052, 0.026, METAL_L)
    // Scope: tube with bells, and the bolt handle on the right.
    m.box(-0.02, 0.1, -0.028, 0.24, 0.15, 0.028, METAL)
    m.box(-0.06, 0.095, -0.036, 0.0, 0.155, 0.036, METAL)
    m.box(0.21, 0.09, -0.042, 0.3, 0.16, 0.042, METAL)
    m.box(0.299, 0.1, -0.03, 0.305, 0.15, 0.03, hex(0x4a7ab0), MAT.glow, 0.6)
    m.box(0.07, 0.08, -0.01, 0.12, 0.1, 0.01, METAL)
    m.box(-0.02, 0.04, 0.03, 0.01, 0.06, 0.1, METAL_L)
    m.box(0.36, -0.06, -0.03, 0.4, -0.04, 0.03, METAL)
  }
  return m
}

/** Magazine with its top at the origin. */
function mag(g: Gun): Mesh {
  const m = new Body()
  if (g === "rifle") {
    m.box(-0.035, -0.12, -0.018, 0.04, 0.0, 0.018, METAL_L)
    m.box(-0.015, -0.19, -0.018, 0.06, -0.11, 0.018, METAL_L)
  } else if (g === "sniper") {
    m.box(-0.04, -0.07, -0.02, 0.05, 0.0, 0.02, METAL)
  } else {
    // A shotgun shell.
    m.box(-0.03, -0.012, -0.012, 0.035, 0.012, 0.012, hex(0xb02020))
    m.box(-0.045, -0.013, -0.013, -0.03, 0.013, 0.013, BRASS, MAT.glow, 0.25)
  }
  return m
}

function pump(): Mesh {
  const m = new Body()
  m.box(-0.09, -0.035, -0.036, 0.09, 0.03, 0.036, WOOD)
  for (const x of [-0.05, 0, 0.05]) m.box(x - 0.012, -0.04, -0.038, x + 0.012, 0.032, 0.038, hex(0x5a361f))
  return m
}

function casing(g: Gun): Mesh {
  const m = new Body()
  if (g === "shotgun") {
    m.box(-0.03, -0.012, -0.012, 0.035, 0.012, 0.012, hex(0xc02626), MAT.glow, 0.35)
    m.box(-0.045, -0.013, -0.013, -0.03, 0.013, 0.013, BRASS, MAT.glow, 0.5)
  } else {
    const l = g === "sniper" ? 0.04 : 0.026
    m.box(-l, -0.008, -0.008, l, 0.008, 0.008, BRASS, MAT.glow, 0.22)
  }
  return m
}

/** A bullet hole: a dark ragged scorch facing -x, unlit so it reads on lit and dark walls alike. */
function hole(): Mesh {
  const m = new Mesh()
  // Ragged scorch ring around a dark centre, as flat fans facing -x.
  const fan = (x: number, r: (i: number) => number, col: Rgb) => {
    const n = 7
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2
      const a1 = ((i + 1) / n) * Math.PI * 2
      m.facet([x, 0, 0], [x, Math.sin(a0) * r(i), Math.cos(a0) * r(i)], [x, Math.sin(a1) * r(i + 1), Math.cos(a1) * r(i + 1)], col, MAT.glow, 1)
    }
  }
  fan(-0.004, (i) => [0.05, 0.036, 0.046, 0.03, 0.052, 0.04, 0.034][i % 7]!, hex(0x0a0a0c))
  fan(-0.008, (i) => [0.018, 0.014, 0.02, 0.016, 0.017, 0.013, 0.019][i % 7]!, hex(0x030303))
  return m
}

export type PersonModels = {
  pelvis: Mesh
  torso: Mesh
  head: Mesh
  upperArm: Mesh
  foreArm: Mesh
  thigh: Mesh
  shin: Mesh
  foot: Mesh
  pump: Mesh
  gun: Record<Gun, Mesh>
  mag: Record<Gun, Mesh>
  casing: Record<Gun, Mesh>
  hole: Mesh
}

export function personModels(): PersonModels {
  const by = <T>(f: (g: Gun) => T) => Object.fromEntries(GUN_IDS.map((g) => [g, f(g)])) as Record<Gun, T>
  return { pelvis: pelvis(), torso: torso(), head: head(), upperArm: upperArm(), foreArm: foreArm(), thigh: thigh(), shin: shin(), foot: foot(), pump: pump(), gun: by(gun), mag: by(mag), casing: by(casing), hole: hole() }
}
