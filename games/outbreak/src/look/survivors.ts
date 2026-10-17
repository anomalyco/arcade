import { FLOATS_PER_VERT, hex, MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { chamferBox, shadedBox, type BakedShade } from "./chamfer"

/**
 * Colour Blocks survivor roster (`Look · Hero` › `Colour Blocks`, `heroStyle = 5`).
 *
 * Lobby / co-op variant contract:
 * - `SURVIVORS` is the canonical ordered roster (`0..SURVIVORS.length - 1`).
 * - Solo play uses `variant = 0` (`SURVIVORS[0]`).
 * - Co-op defaults each player to their seat index (`variant = slot.index`), wrapped modulo `SURVIVORS.length` via
 *   `resolveSurvivorVariant(variant ?? slot.index)`.
 * - A pre-game lobby or loadout screen can pass any `variant: number` (`0..SURVIVORS.length - 1`) to
 *   `new Survivor(slotIndex, isRemote, variant)` or `survivor.setVariant(variant)` without changing animations,
 *   weapons, flashlight or hit reactions.
 */

export type SurvivorParts = {
  pelvis: Mesh
  torso: Mesh
  head: Mesh
  upperArm: Mesh
  foreArm: Mesh
  thigh: Mesh
  shin: Mesh
  foot: Mesh
  toe: Mesh
}

export type SurvivorHeadgear = "hair" | "cap" | "beanie" | "boonie"

export type SurvivorBuild = {
  /** Multiplier on torso & pelvis width (Z axis in bone-local frame). */
  readonly torsoWidth: number
  /** Multiplier on torso & pelvis depth (X axis in bone-local frame). */
  readonly torsoDepth: number
  /** Multiplier on arm and leg thickness. */
  readonly limbScale: number
  /** Multiplier on head dimensions. */
  readonly headScale: number
  /** True when forearms are rolled sleeves showing bare skin. */
  readonly rolledSleeves?: boolean
}

export type SurvivorVariantSpec = {
  readonly id: string
  readonly name: string
  readonly role: string
  readonly headgear: SurvivorHeadgear
  readonly beard?: boolean
  readonly build: SurvivorBuild
  /** sRGB hex palette for clothing, gear, skin and hair/hat. */
  readonly palette: {
    readonly jacket: number
    readonly jacketAccent: number
    readonly shirt: number
    readonly collar: number
    readonly trousers: number
    readonly skin: number
    readonly hair: number
    readonly hat: number
    readonly hatTrim: number
    readonly pack: number
    readonly packTrim: number
    readonly roll: number
    readonly belt: number
    readonly boot: number
  }
}

export const SURVIVORS: readonly SurvivorVariantSpec[] = [
  {
    id: "cole",
    name: "Cole",
    role: "Scavenger",
    headgear: "hair",
    build: { torsoWidth: 1.03, torsoDepth: 1.02, limbScale: 1.02, headScale: 1.0 },
    palette: {
      jacket: 0x82654c,
      jacketAccent: 0x574130,
      shirt: 0xd8d0c0,
      collar: 0xc8b493,
      trousers: 0x3e526b,
      skin: 0xb58a6c,
      hair: 0x3a2f27,
      hat: 0x3a2f27,
      hatTrim: 0x261e18,
      pack: 0x4f6457,
      packTrim: 0x6d8272,
      roll: 0x9c8a66,
      belt: 0x2e2219,
      boot: 0x4a3524,
    },
  },
  {
    id: "maya",
    name: "Maya",
    role: "Medic",
    headgear: "cap",
    build: { torsoWidth: 0.92, torsoDepth: 0.94, limbScale: 0.93, headScale: 0.98 },
    palette: {
      jacket: 0x3b667d,
      jacketAccent: 0x264454,
      shirt: 0xe0ddd4,
      collar: 0xd4d9de,
      trousers: 0x353b45,
      skin: 0x7c533d,
      hair: 0x1e1815,
      hat: 0x284357,
      hatTrim: 0xd8dde2,
      pack: 0x8f4336,
      packTrim: 0xd8d6ce,
      roll: 0x54626b,
      belt: 0x23262b,
      boot: 0x2e2a28,
    },
  },
  {
    id: "hank",
    name: "Hank",
    role: "Mechanic",
    headgear: "beanie",
    beard: true,
    build: { torsoWidth: 1.12, torsoDepth: 1.08, limbScale: 1.08, headScale: 1.04, rolledSleeves: true },
    palette: {
      jacket: 0x9c6832,
      jacketAccent: 0x6b3a24,
      shirt: 0x85392b,
      collar: 0x5c3622,
      trousers: 0x59543e,
      skin: 0xc49578,
      hair: 0x4a3525,
      hat: 0x6e2b25,
      hatTrim: 0x4d1c18,
      pack: 0x3d403c,
      packTrim: 0x595e57,
      roll: 0xb5933e,
      belt: 0x332418,
      boot: 0x523822,
    },
  },
  {
    id: "tess",
    name: "Tess",
    role: "Ranger",
    headgear: "boonie",
    build: { torsoWidth: 0.96, torsoDepth: 0.96, limbScale: 0.96, headScale: 0.99 },
    palette: {
      jacket: 0x4a6b53,
      jacketAccent: 0x314a38,
      shirt: 0xc9be9f,
      collar: 0x7a8768,
      trousers: 0x7d684d,
      skin: 0xc29b7c,
      hair: 0x573b26,
      hat: 0x69573f,
      hatTrim: 0x3d3223,
      pack: 0x7d6c4e,
      packTrim: 0x968567,
      roll: 0x3a4d3e,
      belt: 0x2b2118,
      boot: 0x3d2e20,
    },
  },
] as const

export function resolveSurvivorVariant(variant = 0): SurvivorVariantSpec {
  const n = SURVIVORS.length
  const idx = ((Math.trunc(Number.isFinite(variant) ? variant : 0) % n) + n) % n
  return SURVIVORS[idx]!
}

const shadeOf = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]
const mixOf = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

const emptyParts = (): SurvivorParts => ({
  pelvis: new Mesh(),
  torso: new Mesh(),
  head: new Mesh(),
  upperArm: new Mesh(),
  foreArm: new Mesh(),
  thigh: new Mesh(),
  shin: new Mesh(),
  foot: new Mesh(),
  toe: new Mesh(),
})

const CLOTH: BakedShade = { low: 0.8, under: 0.65 }
const SKIN: BakedShade = { low: 0.86, under: 0.7 }

/**
 * Builds the 9 rig meshes for a Colour Blocks survivor variant.
 * Major body and gear masses use `chamferBox` so bevels catch the flashlight and rim light; flat garment trims
 * (shirt V, placket, pocket flaps, belt, holster, straps, soles) use 12-triangle `shadedBox` to stay light on GPU.
 */
export function buildColourBlocksSurvivorMeshes(
  variantInput: number | SurvivorVariantSpec = 0,
  paletteOverride?: { torso?: number; legs?: number },
  aux = 0,
): SurvivorParts {
  const spec = typeof variantInput === "number" ? resolveSurvivorVariant(variantInput) : variantInput
  const A = MAT.actor
  const p = emptyParts()
  const { build, palette } = spec
  const tw = build.torsoWidth
  const td = build.torsoDepth
  const ls = build.limbScale
  const hs = build.headScale

  const jacket = hex(paletteOverride?.torso ?? palette.jacket)
  const jacketDark = shadeOf(jacket, 0.64)
  const jacketAccent = hex(palette.jacketAccent)
  const shirt = hex(palette.shirt)
  const collar = mixOf(jacket, hex(palette.collar), 0.55)
  const trousers = hex(paletteOverride?.legs ?? palette.trousers)
  const seam = shadeOf(trousers, 0.66)
  const skin = hex(palette.skin)
  const hair = hex(palette.hair)
  const hat = hex(palette.hat)
  const hatTrim = hex(palette.hatTrim)
  const pack = hex(palette.pack)
  const packLight = hex(palette.packTrim)
  const strap = hex(0x2b2a26)
  const roll = hex(palette.roll)
  const belt = hex(palette.belt)
  const holster = shadeOf(belt, 0.78)
  const metal = hex(0xb7ad94)
  const boot = hex(palette.boot)
  const bootDark = shadeOf(boot, 0.6)
  const sole = hex(0x16110e)
  const lace = hex(0xa89474)

  // Pelvis: trousers block with leather belt, metal buckle, left utility pouch and right-hip pistol holster.
  chamferBox(p.pelvis, -0.125 * td, -0.07, -0.17 * tw, 0.125 * td, 0.1, 0.17 * tw, 0.035, trousers, A, CLOTH)
  shadedBox(p.pelvis, -0.13 * td, 0.064, -0.176 * tw, 0.13 * td, 0.11, 0.176 * tw, belt, A)
  shadedBox(p.pelvis, 0.12 * td, 0.067, -0.032, 0.142 * td, 0.107, 0.032, metal, A)
  // Right-hip holster (+Z is right side in bone frame where +X is forward, +Y is up)
  chamferBox(p.pelvis, -0.045, -0.085, 0.155 * tw, 0.055, 0.075, 0.215 * tw, 0.014, holster, A, CLOTH)
  shadedBox(p.pelvis, -0.025, 0.06, 0.165 * tw, 0.035, 0.115, 0.205 * tw, hex(0x302c28), A)
  // Left-hip ammo/utility pouch
  shadedBox(p.pelvis, 0.02, 0.02, -0.195 * tw, 0.095, 0.095, -0.155 * tw, holster, A, CLOTH)

  // Torso: colour-blocked jacket, inner shirt V at chest, darker hem & placket, chest pockets, turned-up collar.
  chamferBox(p.torso, -0.14 * td, 0.02, -0.2 * tw, 0.14 * td, 0.46, 0.2 * tw, 0.045, jacket, A, CLOTH)
  shadedBox(p.torso, -0.145 * td, -0.03, -0.205 * tw, 0.145 * td, 0.05, 0.205 * tw, jacketDark, A)
  // Shirt front block & V-neck visible between open jacket lapels
  shadedBox(p.torso, 0.132 * td, 0.24, -0.052, 0.15 * td, 0.45, 0.052, shirt, A, { low: 0.85 })
  shadedBox(p.torso, 0.13 * td, 0.04, -0.018, 0.149 * td, 0.26, 0.018, jacketDark, A)
  // Lapel strips flanking the shirt insert
  for (const s of [-1, 1]) {
    shadedBox(p.torso, 0.132 * td, 0.22, s * 0.058 - 0.016, 0.152 * td, 0.44, s * 0.058 + 0.016, jacketAccent, A)
    shadedBox(p.torso, 0.128 * td, 0.29, s * 0.11 * tw - 0.048, 0.152 * td, 0.35, s * 0.11 * tw + 0.048, jacketDark, A)
  }
  chamferBox(p.torso, -0.1 * td, 0.42, -0.125 * tw, 0.1 * td, 0.52, 0.125 * tw, 0.028, collar, A, { low: 0.8 })

  // Backpack: chamfered main pack and bedroll cylinder, shadedBox lid/pocket/straps.
  chamferBox(p.torso, -0.3 * td, 0.07, -0.155 * tw, -0.135 * td, 0.38, 0.155 * tw, 0.038, pack, A, CLOTH)
  shadedBox(p.torso, -0.31 * td, 0.3, -0.16 * tw, -0.14 * td, 0.41, 0.16 * tw, packLight, A, { low: 0.85 })
  shadedBox(p.torso, -0.325 * td, 0.1, -0.1 * tw, -0.29 * td, 0.24, 0.1 * tw, packLight, A, { low: 0.8 })
  chamferBox(p.torso, -0.29 * td, 0.41, -0.19 * tw, -0.17 * td, 0.5, 0.19 * tw, 0.038, roll, A, { low: 0.75 })
  for (const z of [-0.12 * tw, 0.12 * tw]) {
    shadedBox(p.torso, -0.15 * td, 0.44, z - 0.026, 0.12 * td, 0.47, z + 0.026, strap, A)
    shadedBox(p.torso, 0.135 * td, 0.18, z - 0.024, 0.154 * td, 0.47, z + 0.024, strap, A)
  }

  // Head: skin block with ears & nose, plus distinct headgear silhouette per co-op survivor.
  chamferBox(p.head, -0.09 * hs, 0.0, -0.088 * hs, 0.09 * hs, 0.22 * hs, 0.088 * hs, 0.03 * hs, skin, A, SKIN)
  for (const z of [-0.095 * hs, 0.095 * hs]) {
    shadedBox(p.head, -0.02 * hs, 0.09 * hs, z - 0.013, 0.025 * hs, 0.15 * hs, z + 0.013, shadeOf(skin, 0.85), A)
  }
  shadedBox(p.head, 0.085 * hs, 0.09 * hs, -0.018 * hs, 0.108 * hs, 0.14 * hs, 0.018 * hs, shadeOf(skin, 0.92), A)

  if (spec.beard) {
    chamferBox(p.head, 0.01 * hs, -0.015 * hs, -0.092 * hs, 0.102 * hs, 0.085 * hs, 0.092 * hs, 0.02 * hs, hair, A, { low: 0.75 })
  }

  if (spec.headgear === "cap") {
    // Baseball cap crown + forward visor + ponytail out the back
    chamferBox(p.head, -0.1 * hs, 0.155 * hs, -0.098 * hs, 0.096 * hs, 0.275 * hs, 0.098 * hs, 0.035 * hs, hat, A, { low: 0.82 })
    shadedBox(p.head, 0.075 * hs, 0.155 * hs, -0.088 * hs, 0.175 * hs, 0.182 * hs, 0.088 * hs, hatTrim, A, { low: 0.8 })
    shadedBox(p.head, -0.102 * hs, 0.06 * hs, -0.092 * hs, -0.02 * hs, 0.17 * hs, 0.092 * hs, hair, A)
    chamferBox(p.head, -0.155 * hs, 0.05 * hs, -0.038 * hs, -0.085 * hs, 0.145 * hs, 0.038 * hs, 0.018 * hs, hair, A)
  } else if (spec.headgear === "beanie") {
    // Ribbed knit watch cap sitting high and rounded with a folded cuff band
    chamferBox(p.head, -0.102 * hs, 0.165 * hs, -0.102 * hs, 0.092 * hs, 0.305 * hs, 0.102 * hs, 0.042 * hs, hat, A, { low: 0.82 })
    shadedBox(p.head, -0.108 * hs, 0.148 * hs, -0.106 * hs, 0.096 * hs, 0.195 * hs, 0.106 * hs, hatTrim, A, { low: 0.85 })
    shadedBox(p.head, -0.102 * hs, 0.06 * hs, -0.095 * hs, -0.03 * hs, 0.16 * hs, 0.095 * hs, hair, A)
  } else if (spec.headgear === "boonie") {
    // Wide-brimmed ranger / boonie hat (unmistakable circular/oval overhead silhouette) + crown + hatband
    chamferBox(p.head, -0.165 * hs, 0.158 * hs, -0.165 * hs, 0.165 * hs, 0.192 * hs, 0.165 * hs, 0.015 * hs, hat, A, { low: 0.78 })
    chamferBox(p.head, -0.095 * hs, 0.18 * hs, -0.095 * hs, 0.095 * hs, 0.285 * hs, 0.095 * hs, 0.032 * hs, hat, A, { low: 0.85 })
    shadedBox(p.head, -0.098 * hs, 0.182 * hs, -0.098 * hs, 0.098 * hs, 0.21 * hs, 0.098 * hs, hatTrim, A)
    shadedBox(p.head, -0.105 * hs, 0.05 * hs, -0.092 * hs, -0.02 * hs, 0.165 * hs, 0.092 * hs, hair, A)
  } else {
    // Full tousled hair block over top, brow and nape
    chamferBox(p.head, -0.102 * hs, 0.168 * hs, -0.102 * hs, 0.092 * hs, 0.285 * hs, 0.102 * hs, 0.038 * hs, hair, A, { low: 0.85 })
    shadedBox(p.head, -0.106 * hs, 0.06 * hs, -0.098 * hs, -0.02 * hs, 0.2 * hs, 0.098 * hs, hair, A)
  }

  // Arms: upper sleeve, forearm (either full sleeve + cuff or rolled flannel cuff + bare forearm), and bare hand.
  const armCol = build.rolledSleeves ? shirt : jacket
  chamferBox(p.upperArm, -0.078 * ls, -0.3, -0.078 * ls, 0.078 * ls, 0.05, 0.078 * ls, 0.034 * ls, armCol, A, CLOTH)
  if (build.rolledSleeves) {
    shadedBox(p.foreArm, -0.066 * ls, -0.06, -0.066 * ls, 0.066 * ls, 0.035, 0.066 * ls, shadeOf(armCol, 0.8), A)
    chamferBox(p.foreArm, -0.058 * ls, -0.21, -0.058 * ls, 0.058 * ls, -0.04, 0.058 * ls, 0.024 * ls, skin, A, SKIN)
  } else {
    chamferBox(p.foreArm, -0.06 * ls, -0.19, -0.06 * ls, 0.06 * ls, 0.03, 0.06 * ls, 0.025 * ls, jacket, A, CLOTH)
    shadedBox(p.foreArm, -0.064 * ls, -0.215, -0.064 * ls, 0.064 * ls, -0.17, 0.064 * ls, jacketDark, A)
  }
  chamferBox(p.foreArm, -0.05 * ls, -0.3, -0.055 * ls, 0.055 * ls, -0.21, 0.055 * ls, 0.022 * ls, skin, A, SKIN)

  // Legs: trousers with knee seam, laced boots on lower shin, foot and toe cap.
  chamferBox(p.thigh, -0.088 * ls, -0.43, -0.088 * ls, 0.088 * ls, 0.05, 0.088 * ls, 0.038 * ls, trousers, A, CLOTH)
  chamferBox(p.shin, -0.068 * ls, -0.3, -0.072 * ls, 0.068 * ls, 0.03, 0.072 * ls, 0.028 * ls, trousers, A, CLOTH)
  shadedBox(p.shin, 0.062 * ls, -0.06, -0.06 * ls, 0.074 * ls, 0.0, 0.06 * ls, seam, A)
  chamferBox(p.shin, -0.074 * ls, -0.41, -0.078 * ls, 0.074 * ls, -0.27, 0.078 * ls, 0.024 * ls, boot, A, { low: 0.8 })
  shadedBox(p.shin, -0.078 * ls, -0.3, -0.082 * ls, 0.078 * ls, -0.27, 0.082 * ls, bootDark, A)

  chamferBox(p.foot, -0.078 * ls, -0.07, -0.07 * ls, 0.125, 0.02, 0.07 * ls, 0.028, boot, A, { low: 0.75, under: 0.5 })
  shadedBox(p.foot, -0.082 * ls, -0.085, -0.072 * ls, 0.128, -0.06, 0.072 * ls, sole, A)
  shadedBox(p.foot, 0.0, 0.0, -0.03, 0.12, 0.028, 0.03, lace, A)
  chamferBox(p.toe, -0.008, 0.012, -0.066 * ls, 0.064, 0.075, 0.066 * ls, 0.026, boot, A, { low: 0.8 })
  shadedBox(p.toe, -0.006, 0.0, -0.068 * ls, 0.068, 0.02, 0.068 * ls, sole, A)

  if (aux !== 0) {
    for (const m of Object.values(p)) {
      for (let i = 10; i < m.v.length; i += FLOATS_PER_VERT) m.v[i] = aux
    }
  }
  return p
}
