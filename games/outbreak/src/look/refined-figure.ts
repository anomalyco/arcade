import { FLOATS_PER_VERT, hex, MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { chamferBox, type BakedShade } from "./chamfer"

/**
 * "Today, refined" (AR-42 paint-over): today's box survivor and zombies with the same proportions and bone frames, made
 * from chamfered boxes with colour-blocked clothing and shading baked into vertex colour. Parts hang in the bone's local
 * frame like today's: X forward, Y up, Z across; limbs hang along −Y from their joint.
 */

const shadeOf = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
const mixOf = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** Survivor parts in the survivor's model order: pelvis, torso, head, upperArm, foreArm, thigh, shin, foot, toe. */
export type RefinedParts = { pelvis: Mesh; torso: Mesh; head: Mesh; upperArm: Mesh; foreArm: Mesh; thigh: Mesh; shin: Mesh; foot: Mesh; toe: Mesh }

const parts = (): RefinedParts => ({
  pelvis: new Mesh(), torso: new Mesh(), head: new Mesh(), upperArm: new Mesh(), foreArm: new Mesh(),
  thigh: new Mesh(), shin: new Mesh(), foot: new Mesh(), toe: new Mesh(),
})

const CLOTH: BakedShade = { low: 0.8, under: 0.65 }
const SKIN: BakedShade = { low: 0.86, under: 0.7 }

/**
 * The survivor: brown work jacket with a turned-up collar, green pack with a bedroll, belt, jeans and lace-up boots.
 * `aux` marks every vertex for a game's hero shading (Outbreak gives it Soft Bean's wrap, sheen and own colour).
 */
export function refinedSurvivorMeshes(palette: { torso: number; legs: number }, aux = 0): RefinedParts {
  const A = MAT.actor
  const p = parts()
  const jacket = hex(palette.torso)
  const jacketDark = shadeOf(jacket, 0.62)
  const collar = mixOf(jacket, hex(0xd8c9a6), 0.35)
  const jeans = hex(palette.legs)
  const seam = shadeOf(jeans, 0.65)
  const skin = hex(0xb58a6c)
  const hair = hex(0x3a2f27)
  const pack = hex(0x4f6457)
  const packLight = hex(0x6d8272)
  const strap = hex(0x2b2a26)
  const roll = hex(0x9c8a66)
  const belt = hex(0x2e2219)
  const metal = hex(0xb7ad94)
  const boot = hex(0x4a3524)
  const bootDark = hex(0x2a1d14)
  const sole = hex(0x16110e)
  const lace = hex(0xa89474)

  // Pelvis: jeans with a belt and buckle at the waist.
  chamferBox(p.pelvis, -0.125, -0.07, -0.17, 0.125, 0.1, 0.17, 0.035, jeans, A, CLOTH)
  chamferBox(p.pelvis, -0.13, 0.065, -0.175, 0.13, 0.11, 0.175, 0.012, belt, A)
  chamferBox(p.pelvis, 0.12, 0.068, -0.032, 0.142, 0.106, 0.032, 0.006, metal, A)

  // Torso: jacket, darker hem band and front placket, chest pocket flaps, turned-up collar.
  chamferBox(p.torso, -0.14, 0.02, -0.2, 0.14, 0.46, 0.2, 0.045, jacket, A, CLOTH)
  chamferBox(p.torso, -0.145, -0.03, -0.205, 0.145, 0.05, 0.205, 0.02, jacketDark, A)
  chamferBox(p.torso, 0.13, 0.04, -0.018, 0.15, 0.44, 0.018, 0.006, jacketDark, A)
  for (const z of [-0.1, 0.1]) chamferBox(p.torso, 0.128, 0.31, z - 0.055, 0.152, 0.36, z + 0.055, 0.008, jacketDark, A)
  chamferBox(p.torso, -0.1, 0.42, -0.12, 0.1, 0.52, 0.12, 0.03, collar, A, { low: 0.8 })
  // Backpack: body, lighter lid and front pocket, a rolled blanket on top, straps over the shoulders.
  chamferBox(p.torso, -0.3, 0.07, -0.155, -0.135, 0.38, 0.155, 0.04, pack, A, CLOTH)
  chamferBox(p.torso, -0.31, 0.3, -0.16, -0.14, 0.41, 0.16, 0.03, packLight, A)
  chamferBox(p.torso, -0.325, 0.1, -0.1, -0.29, 0.24, 0.1, 0.015, packLight, A, { low: 0.8 })
  chamferBox(p.torso, -0.29, 0.41, -0.19, -0.17, 0.5, 0.19, 0.04, roll, A, { low: 0.75 })
  for (const z of [-0.12, 0.12]) {
    chamferBox(p.torso, -0.15, 0.44, z - 0.028, 0.12, 0.47, z + 0.028, 0.008, strap, A)
    chamferBox(p.torso, 0.135, 0.18, z - 0.028, 0.155, 0.47, z + 0.028, 0.006, strap, A)
  }

  // Head: skin block with ears and a nose, hair over the top and back so the top-down camera reads a head of hair.
  chamferBox(p.head, -0.09, 0.0, -0.088, 0.09, 0.22, 0.088, 0.03, skin, A, SKIN)
  chamferBox(p.head, -0.1, 0.17, -0.1, 0.085, 0.285, 0.1, 0.04, hair, A, { low: 0.85 })
  chamferBox(p.head, -0.105, 0.06, -0.098, -0.02, 0.2, 0.098, 0.025, hair, A)
  for (const z of [-0.096, 0.096]) chamferBox(p.head, -0.02, 0.09, z - 0.014, 0.025, 0.15, z + 0.014, 0.008, shadeOf(skin, 0.85), A)
  chamferBox(p.head, 0.085, 0.09, -0.018, 0.108, 0.14, 0.018, 0.008, shadeOf(skin, 0.92), A)

  // Arms: jacket sleeve, a darker cuff, then a bare hand.
  chamferBox(p.upperArm, -0.078, -0.3, -0.078, 0.078, 0.05, 0.078, 0.035, jacket, A, CLOTH)
  chamferBox(p.foreArm, -0.06, -0.19, -0.06, 0.06, 0.03, 0.06, 0.025, jacket, A, CLOTH)
  chamferBox(p.foreArm, -0.064, -0.215, -0.064, 0.064, -0.17, 0.064, 0.015, jacketDark, A)
  chamferBox(p.foreArm, -0.05, -0.3, -0.055, 0.055, -0.21, 0.055, 0.022, skin, A, SKIN)

  // Legs: jeans with a knee seam, boot shafts on the shins.
  chamferBox(p.thigh, -0.088, -0.43, -0.088, 0.088, 0.05, 0.088, 0.04, jeans, A, CLOTH)
  chamferBox(p.shin, -0.068, -0.3, -0.072, 0.068, 0.03, 0.072, 0.03, jeans, A, CLOTH)
  chamferBox(p.shin, 0.062, -0.06, -0.06, 0.074, 0.0, 0.06, 0.005, seam, A)
  chamferBox(p.shin, -0.074, -0.41, -0.078, 0.074, -0.27, 0.078, 0.025, boot, A, { low: 0.8 })
  chamferBox(p.shin, -0.078, -0.3, -0.082, 0.078, -0.27, 0.082, 0.012, bootDark, A)

  // Boots: chamfered upper, a dark sole with a lighter welt, laces on top; the toe cap bends at the ball.
  chamferBox(p.foot, -0.078, -0.07, -0.07, 0.125, 0.02, 0.07, 0.03, boot, A, { low: 0.75, under: 0.5 })
  chamferBox(p.foot, -0.082, -0.085, -0.072, 0.128, -0.06, 0.072, 0.01, sole, A)
  chamferBox(p.foot, 0.0, 0.0, -0.03, 0.12, 0.028, 0.03, 0.01, lace, A)
  chamferBox(p.toe, -0.008, 0.012, -0.066, 0.064, 0.075, 0.066, 0.028, boot, A, { low: 0.8 })
  chamferBox(p.toe, -0.006, 0.0, -0.068, 0.068, 0.02, 0.068, 0.008, sole, A)
  for (const m of Object.values(p)) for (let i = 10; i < m.v.length; i += FLOATS_PER_VERT) m.v[i] = aux
  return p
}

/** Zombie palettes (sRGB hex), picked per zombie from its seed; clothing and skin take them through the instance tint. */
export const ZOMBIE_SHIRTS = [0x55667a, 0xb3ad9c, 0x7a3a30, 0x67676a, 0x5d7c70, 0x6b5843, 0x8a7a45, 0x353331] as const
export const ZOMBIE_TROUSERS = [0x3c4a5c, 0x7a6f56, 0x2c2c2e, 0x55585a, 0x4b3e33] as const
export const ZOMBIE_SKINS = [0x8f9d82, 0x929aa0, 0xa09a76, 0x897e8a, 0x6f6456] as const

/**
 * Zombie parts in the crowd renderer's order (pelvis, torso, head, upperArm, foreArm, thigh, shin, foot, toe). Clothes
 * and skin are white-ish `MAT.cloth`, so each zombie's instance tint picks its shirt, trousers and skin; blood, wounds,
 * hair and boots keep their own colour (`MAT.actor`). Torn hems and sleeves are uneven flaps, the head sits forward
 * and low for a hunch, and dirt is baked darker toward the bottom of every garment.
 */
export function refinedZombieMeshes(eyeGlow = 0.35): Mesh[] {
  const C = MAT.cloth
  const A = MAT.actor
  const p = parts()
  const white: Rgb = [1, 1, 1]
  const dirty = shadeOf(white, 0.62)
  const torn = shadeOf(white, 0.8)
  const blood = hex(0x5e1416)
  const bloodWet = hex(0x8a1c1e)
  const wound = hex(0x4a1c1c)
  const bone = hex(0xc9bea0)
  const hair = hex(0x23251f)
  const boot = hex(0x2a231e)
  const sole = hex(0x141110)
  const GRIME: BakedShade = { low: 0.68, under: 0.6 }

  // Pelvis: trousers, a dark stain down one hip.
  chamferBox(p.pelvis, -0.125, -0.07, -0.17, 0.125, 0.1, 0.17, 0.03, white, C, GRIME)
  chamferBox(p.pelvis, 0.115, -0.06, 0.04, 0.132, 0.06, 0.15, 0.006, blood, A)

  // Torso: shirt with a torn, uneven hem; a hole over the ribs; blood down the front from the mouth; a hunched back.
  chamferBox(p.torso, -0.14, 0.04, -0.2, 0.14, 0.46, 0.2, 0.04, white, C, GRIME)
  chamferBox(p.torso, -0.17, 0.26, -0.16, -0.08, 0.47, 0.16, 0.05, white, C, { low: 0.85 })
  const hem = [0.06, 0.11, 0.03, 0.09, 0.05, 0.12, 0.04]
  hem.forEach((d, i) => {
    const z = -0.2 + (0.4 * (i + 0.5)) / hem.length
    chamferBox(p.torso, -0.135, 0.04 - d, z - 0.026, 0.135, 0.06, z + 0.026, 0.008, i % 2 ? dirty : torn, C)
  })
  chamferBox(p.torso, 0.125, 0.13, -0.15, 0.147, 0.25, -0.05, 0.01, wound, A)
  for (const y of [0.155, 0.19, 0.225]) chamferBox(p.torso, 0.14, y, -0.14, 0.152, y + 0.012, -0.06, 0.003, bone, A)
  chamferBox(p.torso, 0.13, 0.28, -0.02, 0.15, 0.45, 0.07, 0.008, blood, A)
  chamferBox(p.torso, 0.132, 0.2, 0.01, 0.152, 0.3, 0.05, 0.006, bloodWet, A)
  chamferBox(p.torso, -0.152, 0.14, 0.04, -0.13, 0.32, 0.16, 0.008, blood, A)

  // Head: forward and low; sparse hair; dark sockets and a faint eye glint; a slack jaw stained with blood.
  chamferBox(p.head, -0.07, -0.02, -0.09, 0.115, 0.2, 0.09, 0.03, white, C, { low: 0.75, under: 0.55 })
  chamferBox(p.head, -0.08, 0.15, -0.095, 0.085, 0.235, 0.095, 0.035, hair, A, { low: 0.8 })
  chamferBox(p.head, -0.085, 0.04, -0.094, -0.02, 0.18, 0.094, 0.02, hair, A)
  for (const z of [-0.042, 0.042]) {
    chamferBox(p.head, 0.105, 0.11, z - 0.022, 0.12, 0.15, z + 0.022, 0.006, hex(0x1a1414), A)
    p.head.box(0.118, 0.122, z - 0.009, 0.124, 0.138, z + 0.009, hex(0xc8d890), MAT.glow, eyeGlow)
  }
  chamferBox(p.head, 0.09, -0.03, -0.05, 0.125, 0.04, 0.05, 0.012, blood, A)

  // Arms: a sleeve torn short above the elbow, a grey forearm with a bite wound and bloody hands.
  chamferBox(p.upperArm, -0.075, -0.2, -0.075, 0.075, 0.05, 0.075, 0.03, white, C, GRIME)
  ;[0.07, 0.03, 0.09, 0.04].forEach((d, i) => {
    const x = -0.075 + (0.15 * (i + 0.5)) / 4
    chamferBox(p.upperArm, x - 0.02, -0.2 - d, -0.07, x + 0.02, -0.18, 0.07, 0.006, torn, C)
  })
  chamferBox(p.upperArm, -0.055, -0.3, -0.055, 0.055, -0.19, 0.055, 0.02, hex(0x808a7a), A, { low: 0.8 })
  chamferBox(p.foreArm, -0.054, -0.23, -0.054, 0.054, 0.03, 0.054, 0.022, white, C, { low: 0.7 })
  chamferBox(p.foreArm, 0.044, -0.13, -0.035, 0.06, -0.07, 0.035, 0.006, wound, A)
  chamferBox(p.foreArm, -0.055, -0.31, -0.058, 0.06, -0.225, 0.058, 0.02, blood, A, { low: 0.8 })

  // Legs: trousers, one knee torn through to grey skin, grime rising from the ground.
  chamferBox(p.thigh, -0.085, -0.43, -0.085, 0.085, 0.04, 0.085, 0.035, white, C, GRIME)
  chamferBox(p.shin, -0.067, -0.41, -0.07, 0.067, 0.03, 0.07, 0.03, white, C, { low: 0.45, under: 0.5 })
  chamferBox(p.shin, 0.06, -0.08, -0.05, 0.075, 0.02, 0.05, 0.008, hex(0x6c7466), A)
  chamferBox(p.shin, 0.055, -0.4, -0.06, 0.072, -0.3, 0.06, 0.006, shadeOf(hex(0x3a2e24), 0.9), A)

  chamferBox(p.foot, -0.076, -0.072, -0.068, 0.125, 0.015, 0.068, 0.025, boot, A, { low: 0.8, under: 0.5 })
  chamferBox(p.foot, -0.078, -0.085, -0.07, 0.128, -0.062, 0.07, 0.008, sole, A)
  chamferBox(p.toe, -0.008, 0.012, -0.065, 0.062, 0.075, 0.065, 0.025, boot, A, { low: 0.85 })
  chamferBox(p.toe, -0.006, 0.0, -0.068, 0.066, 0.02, 0.068, 0.008, sole, A)
  return [p.pelvis, p.torso, p.head, p.upperArm, p.foreArm, p.thigh, p.shin, p.foot, p.toe]
}

/** sRGB hex to the linear tint the instance shader multiplies cloth by. */
const linear = (h: number): [number, number, number] => hex(h).map(c => c ** 2.2) as [number, number, number]

const pick = <T>(list: readonly T[], n: number): T => list[((n % list.length) + list.length) % list.length]!

/**
 * One zombie's per-part tint (9 parts × rgb, linear) from its seed: shirt on torso and upper arms, trousers on
 * pelvis and legs, skin on head and forearms; boots are untinted. Writes into `out` and returns it.
 */
export function zombiePalette(seed: number, out: Float32Array): Float32Array {
  const h = Math.imul((seed ^ 0x5bd1e995) >>> 0, 0x27d4eb2d) >>> 0
  const shirt = linear(pick(ZOMBIE_SHIRTS, h))
  const trousers = linear(pick(ZOMBIE_TROUSERS, h >>> 5))
  const skin = linear(pick(ZOMBIE_SKINS, h >>> 11))
  const byPart = [trousers, shirt, skin, shirt, skin, trousers, trousers, null, null]
  byPart.forEach((c, i) => {
    out[i * 3] = c ? c[0] : 1
    out[i * 3 + 1] = c ? c[1] : 1
    out[i * 3 + 2] = c ? c[2] : 1
  })
  return out
}
