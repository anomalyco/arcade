import { hex, MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { chamferBox, shadedBox, type BakedShade } from "./chamfer"
import {
  buildColourBlocksSurvivorMeshes,
  resolveSurvivorVariant,
  SURVIVORS,
  type SurvivorParts,
  type SurvivorVariantSpec,
} from "./survivors"

export { buildColourBlocksSurvivorMeshes, resolveSurvivorVariant, SURVIVORS, type SurvivorVariantSpec }
export type RefinedParts = SurvivorParts

/**
 * Colour Blocks survivor (`heroStyle = 5`) and Former Townsfolk zombies (`zombieLook = 1`).
 * Major body parts use `chamferBox` so bevels catch the rim and flashlight; flat garment trims, ties, straps, badges
 * and torn hems use 12-triangle `shadedBox` to keep vertex counts compact for 500-zombie hordes.
 */
export function refinedSurvivorMeshes(
  palette?: { torso: number; legs: number },
  aux = 0,
  variant: number | SurvivorVariantSpec = 0,
): RefinedParts {
  return buildColourBlocksSurvivorMeshes(variant, palette, aux)
}

const shadeOf = (c: Rgb, k: number): Rgb => [c[0] * k, c[1] * k, c[2] * k]

/** Zombie palettes (sRGB hex), decayed and desaturated so hordes read as dead former civilians, not bright teams. */
export const ZOMBIE_SHIRTS = [
  0x55667a, 0xb3ad9c, 0x7a3a30, 0x67676a, 0x5d7c70, 0x6b5843, 0x8a7a45, 0x353331,
] as const
export const ZOMBIE_TROUSERS = [0x3c4a5c, 0x7a6f56, 0x2c2c2e, 0x55585a, 0x4b3e33] as const
export const ZOMBIE_SKINS = [0x8f9d82, 0x929aa0, 0xa09a76, 0x897e8a, 0x6f6456] as const

export type ZombieArchetypeId = "office" | "nurse" | "mechanic" | "dress" | "cop" | "hoodie"

export type ZombieArchetypeSpec = {
  readonly id: ZombieArchetypeId
  readonly label: string
  readonly shirts: readonly number[]
  readonly trousers: readonly number[]
}

export const ZOMBIE_ARCHETYPES: readonly ZombieArchetypeSpec[] = [
  {
    id: "office",
    label: "Office shirt & tie",
    shirts: [0xb3ad9c, 0x8f9ba6, 0x9c9284, 0x8a7978],
    trousers: [0x363b42, 0x4b463d, 0x2c2e33, 0x525458],
  },
  {
    id: "nurse",
    label: "Clinic scrubs",
    shirts: [0x587a74, 0x576f82, 0x687d6b, 0x8e9694],
    trousers: [0x4c6b66, 0x4b6070, 0x596b5c, 0x747c7a],
  },
  {
    id: "mechanic",
    label: "Mechanic overalls",
    shirts: [0x6e6a63, 0x7a4438, 0x857852, 0x525961],
    trousers: [0x384657, 0x42474d, 0x4d4336, 0x2f3842],
  },
  {
    id: "dress",
    label: "Torn dress & cardigan",
    shirts: [0x784846, 0x63586e, 0x5c7065, 0x877658],
    trousers: [0x5e3b3a, 0x4e4557, 0x48574f, 0x695b43],
  },
  {
    id: "cop",
    label: "Police uniform",
    shirts: [0x354254, 0x2e3846, 0x46515e, 0x3b4047],
    trousers: [0x242c38, 0x1f2530, 0x2d333b, 0x26282b],
  },
  {
    id: "hoodie",
    label: "Streetwear hoodie",
    shirts: [0x67676a, 0x733b32, 0x556452, 0x6b5843],
    trousers: [0x3c434d, 0x2c2c2e, 0x4f4a42, 0x46484a],
  },
] as const

export function zombieHash(seed: number, id = 0): number {
  let h = ((seed | 0) ^ Math.imul((id | 0) + 1, 0x9e3779b1)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

export function zombieArchetypeIndex(seed: number, id = 0): number {
  return zombieHash(seed, id) % ZOMBIE_ARCHETYPES.length
}

/** sRGB hex to the linear tint the instance shader multiplies cloth by. */
const linear = (h: number): [number, number, number] => hex(h).map(c => c ** 2.2) as [number, number, number]

const pick = <T>(list: readonly T[], n: number): T => list[((n % list.length) + list.length) % list.length]!

/**
 * One zombie's per-part tint (9 parts × rgb, linear) from its deterministic `seed` and `id`:
 * shirt on torso and upper arms, trousers/skirt on pelvis and legs, decayed skin on head and forearms;
 * shoes/boots are untinted. Writes into `out` and returns it.
 */
export function zombiePalette(seed: number, out: Float32Array, id = 0): Float32Array {
  const h = zombieHash(seed, id)
  const arch = ZOMBIE_ARCHETYPES[h % ZOMBIE_ARCHETYPES.length]!
  const shirt = linear(pick(arch.shirts, h >>> 3))
  const trousers = linear(pick(arch.trousers, h >>> 7))
  const skin = linear(pick(ZOMBIE_SKINS, h >>> 11))
  const byPart = [trousers, shirt, skin, shirt, skin, trousers, trousers, null, null]
  byPart.forEach((c, i) => {
    out[i * 3] = c ? c[0] : 1
    out[i * 3 + 1] = c ? c[1] : 1
    out[i * 3 + 2] = c ? c[2] : 1
  })
  return out
}

export type TownsfolkZombieMeshSet = {
  /** Per-archetype pelvis (0), torso (1) and head (2) meshes. */
  archetypes: { id: ZombieArchetypeId; pelvis: Mesh; torso: Mesh; head: Mesh }[]
  /** Shared limb and boot meshes (parts 3..8: upperArm, foreArm, thigh, shin, foot, toe), tinted per instance. */
  shared: [Mesh, Mesh, Mesh, Mesh, Mesh, Mesh]
}

/**
 * Builds the Former Townsfolk zombie meshes: 6 distinct civilian archetypes for pelvis, torso and head, plus shared
 * cloth/skin-tinted limb and shoe meshes so a 500-zombie horde stays fast and GPU-instanced.
 */
export function townsfolkZombieMeshes(eyeGlow = 0.35): TownsfolkZombieMeshSet {
  const C = MAT.cloth
  const A = MAT.actor
  const white: Rgb = [1, 1, 1]
  const dirty = shadeOf(white, 0.62)
  const torn = shadeOf(white, 0.78)
  const blood = hex(0x5e1416)
  const bloodWet = hex(0x8a1c1e)
  const wound = hex(0x4a1c1c)
  const bone = hex(0xc9bea0)
  const hairDark = hex(0x23251f)
  const hairBrown = hex(0x3a2a1e)
  const boot = hex(0x2a231e)
  const sole = hex(0x141110)
  const GRIME: BakedShade = { low: 0.68, under: 0.6 }

  const buildBasePelvis = (m: Mesh) => {
    chamferBox(m, -0.125, -0.07, -0.17, 0.125, 0.1, 0.17, 0.03, white, C, GRIME)
    shadedBox(m, 0.115, -0.06, 0.04, 0.132, 0.06, 0.15, blood, A)
  }

  const buildBaseTorso = (m: Mesh) => {
    chamferBox(m, -0.14, 0.04, -0.2, 0.14, 0.46, 0.2, 0.04, white, C, GRIME)
    // Hunched upper back mass
    chamferBox(m, -0.17, 0.26, -0.16, -0.08, 0.47, 0.16, 0.045, white, C, { low: 0.85 })
    // Jagged torn shirt hem (shadedBox keeps triangle count low)
    const hem = [0.06, 0.1, 0.03, 0.09, 0.05]
    hem.forEach((d, i) => {
      const z = -0.18 + (0.36 * (i + 0.5)) / hem.length
      shadedBox(m, -0.135, 0.04 - d, z - 0.032, 0.135, 0.055, z + 0.032, i % 2 ? dirty : torn, C)
    })
    // Rib wound and bloodstains
    shadedBox(m, 0.126, 0.13, -0.15, 0.147, 0.24, -0.05, wound, A)
    for (const y of [0.155, 0.195]) shadedBox(m, 0.14, y, -0.14, 0.151, y + 0.012, -0.06, bone, A)
    shadedBox(m, 0.13, 0.28, -0.02, 0.149, 0.45, 0.07, blood, A)
    shadedBox(m, -0.15, 0.14, 0.04, -0.13, 0.32, 0.16, blood, A)
  }

  const buildBaseHead = (m: Mesh) => {
    chamferBox(m, -0.07, -0.02, -0.09, 0.115, 0.2, 0.09, 0.03, white, C, { low: 0.75, under: 0.55 })
    for (const z of [-0.042, 0.042]) {
      shadedBox(m, 0.105, 0.11, z - 0.022, 0.12, 0.15, z + 0.022, hex(0x1a1414), A)
      m.box(0.118, 0.122, z - 0.009, 0.124, 0.138, z + 0.009, hex(0xc8d890), MAT.glow, eyeGlow)
    }
    shadedBox(m, 0.09, -0.03, -0.05, 0.125, 0.04, 0.05, blood, A)
  }

  const archetypes = ZOMBIE_ARCHETYPES.map((spec) => {
    const pelvis = new Mesh()
    const torso = new Mesh()
    const head = new Mesh()
    buildBasePelvis(pelvis)
    buildBaseTorso(torso)
    buildBaseHead(head)

    if (spec.id === "office") {
      // Dress belt + open collar points + askew dark crimson/navy necktie + breast pocket
      shadedBox(pelvis, -0.13, 0.068, -0.175, 0.13, 0.105, 0.175, hex(0x241d18), A)
      shadedBox(torso, 0.132, 0.12, -0.022, 0.154, 0.43, 0.018, hex(0x3b171c), A)
      shadedBox(torso, 0.134, 0.06, -0.032, 0.155, 0.13, 0.008, hex(0x2e1115), A)
      for (const s of [-1, 1]) {
        shadedBox(torso, 0.128, 0.41, s * 0.055 - 0.028, 0.152, 0.47, s * 0.055 + 0.028, dirty, C)
      }
      shadedBox(torso, 0.128, 0.28, -0.145, 0.15, 0.35, -0.075, dirty, C)
      chamferBox(head, -0.08, 0.15, -0.095, 0.085, 0.235, 0.095, 0.032, hairDark, A, { low: 0.8 })
      shadedBox(head, -0.085, 0.04, -0.094, -0.02, 0.18, 0.094, hairDark, A)
    } else if (spec.id === "nurse") {
      // Clinic scrubs: dark V-neck cutout, clip-on white/blue ID badge, lower scrub pockets, bouffant scrub cap
      shadedBox(torso, 0.132, 0.36, -0.045, 0.152, 0.465, 0.045, hex(0x2b302c), A)
      shadedBox(torso, 0.134, 0.31, -0.135, 0.154, 0.365, -0.085, hex(0xd0d8dc), A)
      shadedBox(torso, 0.136, 0.348, -0.132, 0.156, 0.364, -0.088, hex(0x2c5a78), A)
      shadedBox(torso, 0.128, 0.06, 0.06, 0.15, 0.16, 0.165, dirty, C)
      // Bouffant scrub cap (MAT.cloth so it matches the scrub tunic colour!)
      chamferBox(head, -0.095, 0.145, -0.108, 0.105, 0.265, 0.108, 0.04, white, C, { low: 0.78 })
      shadedBox(head, -0.088, 0.04, -0.092, -0.025, 0.15, 0.092, hairBrown, A)
    } else if (spec.id === "mechanic") {
      // Bib overalls: dark denim/slate bib front + shoulder straps + brass clasps + trucker cap with visor
      const bib = hex(0x2f3c4a)
      shadedBox(pelvis, -0.13, 0.04, -0.175, 0.13, 0.11, 0.175, bib, A)
      shadedBox(torso, 0.13, 0.04, -0.135, 0.152, 0.33, 0.135, bib, A, { low: 0.78 })
      shadedBox(torso, -0.15, 0.04, -0.135, -0.128, 0.31, 0.135, bib, A, { low: 0.78 })
      for (const z of [-0.095, 0.095]) {
        shadedBox(torso, -0.148, 0.3, z - 0.026, 0.152, 0.47, z + 0.026, bib, A)
        shadedBox(torso, 0.134, 0.31, z - 0.02, 0.156, 0.34, z + 0.02, hex(0x9e8b52), A)
      }
      chamferBox(head, -0.085, 0.15, -0.098, 0.1, 0.255, 0.098, 0.032, bib, A, { low: 0.8 })
      shadedBox(head, 0.085, 0.148, -0.086, 0.175, 0.172, 0.086, hex(0x1f2833), A)
      shadedBox(head, 0.08, 0.18, -0.05, 0.106, 0.23, 0.05, hex(0x9c8e6c), A)
    } else if (spec.id === "dress") {
      // Torn dress / skirt & cardigan: flared skirt over pelvis/upper thighs + scooped neckline + shoulder-length hair
      chamferBox(pelvis, -0.145, -0.18, -0.195, 0.145, 0.09, 0.195, 0.035, white, C, GRIME)
      for (let i = 0; i < 6; i++) {
        const z = -0.17 + (0.34 * (i + 0.5)) / 6
        const drop = i % 2 === 0 ? 0.07 : 0.03
        shadedBox(pelvis, -0.14, -0.18 - drop, z - 0.028, 0.14, -0.15, z + 0.028, i % 2 ? dirty : torn, C)
      }
      shadedBox(torso, 0.13, 0.34, -0.075, 0.152, 0.465, 0.075, hex(0x524c44), A)
      shadedBox(torso, 0.132, 0.05, -0.02, 0.152, 0.35, 0.02, dirty, C)
      // Longer bob hair framing the head and neck
      chamferBox(head, -0.095, 0.14, -0.105, 0.09, 0.245, 0.105, 0.035, hairBrown, A, { low: 0.8 })
      chamferBox(head, -0.105, -0.03, -0.108, 0.03, 0.19, 0.108, 0.025, hairBrown, A, { low: 0.72 })
    } else if (spec.id === "cop") {
      // Police officer: duty belt + holster, dark tie, gold shield badge, shoulder epaulets, peaked police cap
      shadedBox(pelvis, -0.135, 0.055, -0.18, 0.135, 0.11, 0.18, hex(0x16181c), A)
      shadedBox(pelvis, 0.122, 0.06, -0.028, 0.144, 0.105, 0.028, hex(0xb89c48), MAT.shiny)
      shadedBox(pelvis, -0.04, -0.07, 0.155, 0.05, 0.07, 0.205, hex(0x16181c), A)
      shadedBox(torso, 0.132, 0.14, -0.02, 0.152, 0.43, 0.02, hex(0x16181c), A)
      shadedBox(torso, 0.134, 0.32, -0.12, 0.156, 0.37, -0.08, hex(0xc4a648), MAT.shiny)
      for (const s of [-1, 1]) {
        shadedBox(torso, -0.06, 0.44, s * 0.135 - 0.045, 0.06, 0.475, s * 0.135 + 0.045, hex(0x1a202c), A)
      }
      // Peaked police cap: navy octagonal crown + black visor + gold emblem
      chamferBox(head, -0.1, 0.165, -0.108, 0.11, 0.268, 0.108, 0.03, hex(0x1e2636), A, { low: 0.8 })
      shadedBox(head, -0.085, 0.14, -0.095, 0.095, 0.175, 0.095, hex(0x12151c), A)
      shadedBox(head, 0.085, 0.14, -0.09, 0.178, 0.165, 0.09, hex(0x12151c), A)
      shadedBox(head, 0.098, 0.19, -0.022, 0.118, 0.24, 0.022, hex(0xc4a648), MAT.shiny)
    } else {
      // Streetwear hoodie: bulky hood collar ring, front kangaroo pouch, track stripes, pulled-up hood cowl
      chamferBox(torso, -0.15, 0.39, -0.155, 0.11, 0.51, 0.155, 0.035, dirty, C, { low: 0.78 })
      shadedBox(torso, 0.128, 0.07, -0.13, 0.154, 0.21, 0.13, dirty, C, { low: 0.75 })
      for (const z of [-0.04, 0.04]) {
        shadedBox(torso, 0.134, 0.28, z - 0.008, 0.154, 0.43, z + 0.008, hex(0xb8b2a6), A)
      }
      for (const s of [-1, 1]) {
        shadedBox(pelvis, -0.02, -0.07, s * 0.168, 0.02, 0.09, s * 0.176, hex(0xb8b2a6), A)
      }
      // Pulled-up hood over the crown and sides of the head (MAT.cloth so it matches the torso hoodie!)
      chamferBox(head, -0.108, 0.02, -0.108, 0.095, 0.255, 0.108, 0.035, dirty, C, { low: 0.75 })
    }

    return { id: spec.id, pelvis, torso, head }
  })

  // Shared limb and shoe meshes (parts 3..8)
  const upperArm = new Mesh()
  const foreArm = new Mesh()
  const thigh = new Mesh()
  const shin = new Mesh()
  const foot = new Mesh()
  const toe = new Mesh()

  // Upper arm: sleeve torn above the elbow + grey-green lower bicep
  chamferBox(upperArm, -0.075, -0.2, -0.075, 0.075, 0.05, 0.075, 0.03, white, C, GRIME)
  ;[0.06, 0.03, 0.08].forEach((d, i) => {
    const x = -0.06 + 0.06 * i
    shadedBox(upperArm, x - 0.024, -0.2 - d, -0.07, x + 0.024, -0.18, 0.07, torn, C)
  })
  chamferBox(upperArm, -0.055, -0.3, -0.055, 0.055, -0.19, 0.055, 0.02, hex(0x808a7a), A, { low: 0.8 })

  // Forearm: skin-tinted forearm + bite wound + bloody hand
  chamferBox(foreArm, -0.054, -0.23, -0.054, 0.054, 0.03, 0.054, 0.022, white, C, { low: 0.7 })
  shadedBox(foreArm, 0.044, -0.13, -0.035, 0.06, -0.07, 0.035, wound, A)
  chamferBox(foreArm, -0.055, -0.31, -0.058, 0.06, -0.225, 0.058, 0.02, blood, A, { low: 0.8 })
  shadedBox(foreArm, 0.04, -0.28, -0.04, 0.062, -0.23, 0.04, bloodWet, A)

  // Thigh & shin: trousers/skirt-tinted legs with knee tear and mud at the cuff
  chamferBox(thigh, -0.085, -0.43, -0.085, 0.085, 0.04, 0.085, 0.035, white, C, GRIME)
  chamferBox(shin, -0.067, -0.41, -0.07, 0.067, 0.03, 0.07, 0.03, white, C, { low: 0.45, under: 0.5 })
  shadedBox(shin, 0.06, -0.08, -0.05, 0.075, 0.02, 0.05, hex(0x6c7466), A)
  shadedBox(shin, 0.055, -0.4, -0.06, 0.072, -0.3, 0.06, shadeOf(hex(0x3a2e24), 0.9), A)

  // Shoes/boots: chamfered upper + shadedBox sole
  chamferBox(foot, -0.076, -0.072, -0.068, 0.125, 0.015, 0.068, 0.025, boot, A, { low: 0.8, under: 0.5 })
  shadedBox(foot, -0.078, -0.085, -0.07, 0.128, -0.062, 0.07, sole, A)
  chamferBox(toe, -0.008, 0.012, -0.065, 0.062, 0.075, 0.065, 0.025, boot, A, { low: 0.85 })
  shadedBox(toe, -0.006, 0.0, -0.068, 0.066, 0.02, 0.068, sole, A)

  return {
    archetypes,
    shared: [upperArm, foreArm, thigh, shin, foot, toe],
  }
}

/**
 * Compatibility helper returning the 9 zombie part meshes for archetype 0 (pelvis, torso, head, upperArm, foreArm,
 * thigh, shin, foot, toe).
 */
export function refinedZombieMeshes(eyeGlow = 0.35): Mesh[] {
  const { archetypes, shared } = townsfolkZombieMeshes(eyeGlow)
  const a0 = archetypes[0]!
  return [a0.pelvis, a0.torso, a0.head, ...shared]
}
