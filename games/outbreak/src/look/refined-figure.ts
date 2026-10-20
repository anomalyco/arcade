import { hex, MAT, Mesh, type Rgb } from "@arcade/kit/gpu/mesh"
import { BASE_CALLINGS, callingIndex, turnedAgo, zombieHash } from "../../shared/characters/callings"
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
/** Undead skin tones (sRGB hex): corpse grey-green, livor-mortis slate-teal, sallow bile-olive, bruised ash-violet, putrid moss. */
export const ZOMBIE_SKINS = [0x758c6c, 0x6c8475, 0x828c66, 0x727484, 0x637862, 0x848d75] as const
export const ZOMBIE_SKINS_V1 = [0x8f9d82, 0x929aa0, 0xa09a76, 0x897e8a, 0x6f6456] as const
/** Skin of the freshly turned (AR-88 wear): grey, faintly pink or sallow, not yet green. */
const FRESH_SKINS = [0x9c938c, 0x958d8e, 0x9a9583, 0x8c8784] as const

/** Shoe leather the shared foot meshes are tinted to (they are built white so a bathrobe's slipper can differ). */
export const ZOMBIE_BOOT = 0x2a231e
const ZOMBIE_SOLE = 0x141110
/** A bathrobe's one slipper (fluffy pink or powder blue), as a tint on the white foot mesh. */
export const ZOMBIE_SLIPPERS = [0xc79a9f, 0x9fb0c4, 0xb9b2a4] as const

export type ZombieArchetypeId =
  | "office"
  | "nurse"
  | "mechanic"
  | "dress"
  | "cop"
  | "hoodie"
  | "mail"
  | "jogger"
  | "robe"
  | "guard"
  | "courier"
  | "bride"
  | "groom"

export type ZombieArchetypeSpec = {
  readonly id: ZombieArchetypeId
  readonly label: string
  readonly shirts: readonly number[]
  readonly trousers: readonly number[]
  /** Pelvis and legs in the shirt's own colour (a robe, a dress to the floor, a suit). */
  readonly matched?: boolean
  /** Bare skin rather than cloth (short sleeves or a vest; shorts or a short robe). */
  readonly bareArms?: boolean
  readonly bareShins?: boolean
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
  // AR-88: the callings (shared/characters/callings.ts). Order matches CALLING_IDS.
  {
    id: "mail",
    label: "Mail carrier with satchel",
    shirts: [0x8b9cad, 0x93a0aa, 0x8696a6],
    trousers: [0x2f3b52, 0x353f55, 0x2b364a],
    bareShins: true,
  },
  {
    id: "jogger",
    label: "Jogger with earbuds",
    shirts: [0x5f8a96, 0xa25a48, 0x8a8f3c, 0x7d5d8c],
    trousers: [0x2a2c30, 0x3d4a5e, 0x33363b],
    bareArms: true,
    bareShins: true,
  },
  {
    id: "robe",
    label: "Bathrobe and one slipper",
    shirts: [0xb1aa9d, 0x7f90a6, 0xa08389, 0x8f9a82],
    trousers: [0xb1aa9d],
    matched: true,
    bareShins: true,
  },
  {
    id: "guard",
    label: "Night security guard",
    shirts: [0x2a2c31, 0x34363b, 0x2e3034],
    trousers: [0x45474c, 0x2c2e33, 0x3a3c40],
  },
  {
    id: "courier",
    label: "Courier in a hi-vis vest",
    shirts: [0x4a4f57, 0x6b5843, 0x575a52],
    trousers: [0x353b44, 0x4b4337, 0x2f3338],
  },
  { id: "bride", label: "Bride", shirts: [0xd6d0c2, 0xcfc8bb, 0xd2cec8], trousers: [0xd6d0c2], matched: true },
  { id: "groom", label: "Groom", shirts: [0x24262c, 0x2b2a30, 0x1f2126], trousers: [0x24262c], matched: true },
] as const

export { zombieHash }

/** One of the six Former Townsfolk archetypes everyone had before AR-88 (Lab › Characters › Callings off). */
export function zombieArchetypeIndex(seed: number, id = 0): number {
  return zombieHash(seed, id) % BASE_CALLINGS
}

/** The archetype the crowd draws: its calling with Callings on, else the six-archetype pick. */
export function zombieCallingArchetype(seed: number, id: number, occupations: boolean): number {
  return callingIndex(seed, id, occupations)
}

/** sRGB hex to the linear tint the instance shader multiplies cloth by. */
const linear = (h: number): [number, number, number] => hex(h).map(c => c ** 2.2) as [number, number, number]

const pick = <T>(list: readonly T[], n: number): T => list[((n % list.length) + list.length) % list.length]!

/**
 * One zombie's per-part tint (9 parts × rgb, linear) from its deterministic `seed` and `id`:
 * shirt on torso and upper arms, trousers/skirt on pelvis and legs, decayed skin on head and forearms;
 * shoes/boots are untinted. Writes into `out` and returns it.
 */
export function zombiePalette(
  seed: number,
  out: Float32Array,
  id = 0,
  undead = true,
  archetype = zombieArchetypeIndex(seed, id),
  wear = false,
): Float32Array {
  const h = zombieHash(seed, id)
  const arch = ZOMBIE_ARCHETYPES[archetype] ?? ZOMBIE_ARCHETYPES[0]!
  // Days since it turned: fresh clothes nearly clean and skin still grey-pink; weeks old filthy, faded and green.
  const ago = wear && undead ? turnedAgo(seed, id) : -1
  const grime = ago >= 0 ? 0.98 - 0.3 * ago : undead ? 0.86 : 1
  const shirtHex = pick(arch.shirts, h >>> 3)
  const shirt = linear(shirtHex).map((c) => c * grime) as [number, number, number]
  const trousers = (arch.matched ? linear(shirtHex) : linear(pick(arch.trousers, h >>> 7))).map((c) => c * grime) as [number, number, number]
  let skin = linear(pick(undead ? ZOMBIE_SKINS : ZOMBIE_SKINS_V1, h >>> 11))
  if (ago >= 0) {
    const fresh = linear(pick(FRESH_SKINS, h >>> 15))
    const k = Math.min(1, ago * 1.7)
    const rot = 1 - 0.2 * Math.max(0, ago - 0.6) / 0.4
    skin = skin.map((c, i) => (fresh[i]! + (c - fresh[i]!) * k) * rot) as [number, number, number]
  }
  const arm = arch.bareArms ? skin : shirt
  const shin = arch.bareShins ? skin : trousers
  const byPart = [trousers, shirt, skin, arm, skin, trousers, shin, null, null]
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
 * When `undead = true` (default, `zombieLook = 1`), adds unmistakably undead grey-green/bruised flesh, open jaw &
 * throat-to-chest blood bibs, clavicle/shoulder/back bites, exposed bone, and shredded sleeves/trousers.
 */
export function townsfolkZombieMeshes(eyeGlow = 0.35, undead = true): TownsfolkZombieMeshSet {
  const C = MAT.cloth
  const A = MAT.actor
  const white: Rgb = [1, 1, 1]
  const dirty = shadeOf(white, undead ? 0.56 : 0.62)
  const torn = shadeOf(white, undead ? 0.72 : 0.78)
  const blood = hex(undead ? 0x581013 : 0x5e1416)
  const bloodClot = hex(0x3f0a0d)
  const bloodWet = hex(undead ? 0x781518 : 0x8a1c1e)
  const wound = hex(undead ? 0x450c0f : 0x4a1c1c)
  const bruise = hex(0x433548)
  const deadFlesh = hex(0x6c8064)
  const bone = hex(0xc9bea0)
  const hairDark = hex(0x23251f)
  const hairBrown = hex(0x3a2a1e)
  const boot = hex(ZOMBIE_BOOT)
  const sole = hex(ZOMBIE_SOLE)
  const GRIME: BakedShade = undead ? { low: 0.6, under: 0.5 } : { low: 0.68, under: 0.6 }

  const buildBasePelvis = (m: Mesh) => {
    chamferBox(m, -0.125, -0.07, -0.17, 0.125, 0.1, 0.17, 0.03, white, C, GRIME)
    shadedBox(m, 0.115, -0.06, 0.04, 0.132, 0.06, 0.15, blood, A)
    if (undead) {
      // Exposed necrotic lower waist gap & dark clotted bloodstain on hip
      shadedBox(m, 0.112, 0.025, -0.15, 0.132, 0.095, -0.035, deadFlesh, A)
      shadedBox(m, -0.131, -0.045, -0.14, 0.131, 0.035, -0.065, bloodClot, A)
    }
  }

  const buildBaseTorso = (m: Mesh) => {
    chamferBox(m, -0.14, 0.04, -0.2, 0.14, 0.46, 0.2, 0.04, white, C, GRIME)
    // Hunched upper back mass
    chamferBox(m, -0.17, 0.26, -0.16, -0.08, 0.47, 0.16, 0.045, white, C, { low: undead ? 0.74 : 0.85 })
    // Jagged torn shirt hem (shadedBox keeps triangle count low)
    const hem = [0.06, 0.1, 0.03, 0.09, 0.05]
    hem.forEach((d, i) => {
      const z = -0.18 + (0.36 * (i + 0.5)) / hem.length
      shadedBox(
        m,
        -0.135,
        0.04 - d,
        z - 0.032,
        0.135,
        0.055,
        z + 0.032,
        undead && i === 1 ? blood : i % 2 ? dirty : torn,
        undead && i === 1 ? A : C,
      )
    })
    // Rib wound and bloodstains
    shadedBox(m, 0.126, 0.13, -0.15, 0.147, 0.24, -0.05, wound, A)
    for (const y of [0.155, 0.195]) shadedBox(m, 0.14, y, -0.14, 0.151, y + 0.012, -0.06, bone, A)
    shadedBox(m, 0.13, 0.28, -0.02, 0.149, 0.45, 0.07, blood, A)
    shadedBox(m, -0.15, 0.14, 0.04, -0.13, 0.32, 0.16, blood, A)
    if (undead) {
      // Dried blood bib under the throat/collar where blood spills from the slack jaw
      shadedBox(m, 0.055, 0.36, -0.062, 0.15, 0.468, 0.062, blood, A)
      shadedBox(m, 0.085, 0.39, -0.035, 0.153, 0.47, 0.035, bloodClot, A)
    }
  }

  const buildBaseHead = (m: Mesh) => {
    chamferBox(m, -0.07, -0.02, -0.09, 0.115, 0.2, 0.09, 0.03, white, C, { low: undead ? 0.66 : 0.75, under: 0.48 })
    for (const z of [-0.042, 0.042]) {
      if (undead) {
        // Bruised livor-mortis orbital shadow around deep sunken dark socket
        shadedBox(m, 0.096, 0.096, z - 0.027, 0.118, 0.158, z + 0.027, bruise, A)
      }
      shadedBox(m, 0.105, 0.108, z - 0.022, 0.121, 0.152, z + 0.022, hex(0x140c10), A)
      m.box(0.118, 0.122, z - 0.009, 0.124, 0.138, z + 0.009, hex(0xc8d890), MAT.glow, eyeGlow)
    }
    if (undead) {
      // Sunken nasal cavity + slack blood-stained jaw, mouth & bruised cheek hollow
      shadedBox(m, 0.106, 0.078, -0.013, 0.122, 0.106, 0.013, hex(0x1c1014), A)
      shadedBox(m, 0.078, -0.04, -0.054, 0.126, 0.062, 0.054, blood, A)
      shadedBox(m, 0.098, 0.004, -0.038, 0.128, 0.05, 0.038, hex(0x220709), A)
      shadedBox(m, 0.092, -0.036, -0.032, 0.127, 0.018, 0.032, bloodWet, A)
      shadedBox(m, 0.02, 0.03, -0.094, 0.1, 0.095, 0.094, bruise, A)
    } else {
      shadedBox(m, 0.09, -0.03, -0.05, 0.125, 0.04, 0.05, blood, A)
    }
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
        shadedBox(
          torso,
          0.128,
          0.41,
          s * 0.055 - 0.028,
          0.152,
          0.47,
          s * 0.055 + 0.028,
          s < 0 && undead ? blood : dirty,
          s < 0 && undead ? A : C,
        )
      }
      shadedBox(torso, 0.128, 0.28, -0.145, 0.15, 0.35, -0.075, dirty, C)
      chamferBox(head, -0.08, 0.15, -0.095, 0.085, 0.235, 0.095, 0.032, hairDark, A, { low: 0.8 })
      shadedBox(head, -0.085, 0.04, -0.094, -0.02, 0.18, 0.094, hairDark, A)
      if (undead) {
        // Asymmetric blood-soaked dress shirt around pocket/tie + torn shoulder bite + temple gash
        shadedBox(torso, 0.131, 0.18, -0.15, 0.153, 0.41, 0.01, blood, A)
        shadedBox(torso, -0.07, 0.38, -0.204, 0.1, 0.474, -0.095, blood, A)
        shadedBox(torso, -0.175, 0.28, -0.12, -0.12, 0.43, 0.04, bloodClot, A)
        shadedBox(head, -0.01, 0.165, 0.035, 0.08, 0.238, 0.096, blood, A)
      }
    } else if (spec.id === "nurse") {
      // Clinic scrubs: dark V-neck cutout, clip-on white/blue ID badge, lower scrub pockets, bouffant scrub cap
      shadedBox(torso, 0.132, 0.36, -0.045, 0.152, 0.465, 0.045, hex(0x2b302c), A)
      shadedBox(torso, 0.134, 0.31, -0.135, 0.154, 0.365, -0.085, hex(0xd0d8dc), A)
      shadedBox(torso, 0.136, 0.348, -0.132, 0.156, 0.364, -0.088, hex(0x2c5a78), A)
      shadedBox(torso, 0.128, 0.06, 0.06, 0.15, 0.16, 0.165, dirty, C)
      // Bouffant scrub cap (MAT.cloth so it matches the scrub tunic colour!)
      chamferBox(head, -0.095, 0.145, -0.108, 0.105, 0.265, 0.108, 0.04, white, C, { low: 0.78 })
      shadedBox(head, -0.088, 0.04, -0.092, -0.025, 0.15, 0.092, hairBrown, A)
      if (undead) {
        // Heavy crimson surgical/bite blood down the right scrub front, back shoulder & torn scrub cap side
        shadedBox(torso, 0.133, 0.12, -0.04, 0.154, 0.38, 0.145, blood, A)
        shadedBox(torso, 0.135, 0.22, -0.01, 0.156, 0.35, 0.08, bloodClot, A)
        shadedBox(torso, -0.175, 0.3, 0.01, -0.06, 0.474, 0.165, blood, A)
        shadedBox(head, -0.04, 0.16, -0.11, 0.085, 0.266, -0.03, blood, A)
      }
    } else if (spec.id === "mechanic") {
      // Bib overalls: dark denim/slate bib front + shoulder straps + brass clasps + trucker cap with visor
      const bib = hex(0x2f3c4a)
      shadedBox(pelvis, -0.13, 0.04, -0.175, 0.13, 0.11, 0.175, bib, A)
      shadedBox(torso, 0.13, 0.04, -0.135, 0.152, 0.33, 0.135, bib, A, { low: 0.78 })
      shadedBox(torso, -0.15, 0.04, -0.135, -0.128, 0.31, 0.135, bib, A, { low: 0.78 })
      for (const z of [-0.095, 0.095]) {
        const yTop = undead && z < 0 ? 0.35 : 0.47
        shadedBox(torso, -0.148, 0.3, z - 0.026, 0.152, yTop, z + 0.026, bib, A)
        shadedBox(torso, 0.134, 0.31, z - 0.02, 0.156, 0.34, z + 0.02, hex(0x9e8b52), A)
      }
      chamferBox(head, -0.085, 0.15, -0.098, 0.1, 0.255, 0.098, 0.032, bib, A, { low: 0.8 })
      shadedBox(head, 0.085, 0.148, -0.086, 0.175, 0.172, 0.086, hex(0x1f2833), A)
      shadedBox(head, 0.08, 0.18, -0.05, 0.106, 0.23, 0.05, hex(0x9c8e6c), A)
      if (undead) {
        // Snapped left overall strap exposing torn grey-green & bloodied shoulder + gash across bib front
        shadedBox(torso, -0.09, 0.36, -0.204, 0.11, 0.474, -0.07, deadFlesh, A)
        shadedBox(torso, -0.05, 0.37, -0.19, 0.09, 0.476, -0.09, blood, A)
        shadedBox(torso, 0.134, 0.16, -0.09, 0.157, 0.32, 0.07, bloodClot, A)
        shadedBox(head, 0.06, 0.149, -0.088, 0.176, 0.175, 0.01, blood, A)
      }
    } else if (spec.id === "dress") {
      // Torn dress / skirt & cardigan: flared skirt over pelvis/upper thighs + scooped neckline + shoulder-length hair
      chamferBox(pelvis, -0.145, -0.18, -0.195, 0.145, 0.09, 0.195, 0.035, white, C, GRIME)
      for (let i = 0; i < 6; i++) {
        const z = -0.17 + (0.34 * (i + 0.5)) / 6
        const drop = i % 2 === 0 ? 0.07 : 0.03
        const col = undead && (i === 1 || i === 4) ? blood : i % 2 ? dirty : torn
        shadedBox(pelvis, -0.14, -0.18 - drop, z - 0.028, 0.14, -0.15, z + 0.028, col, col === blood ? A : C)
      }
      shadedBox(torso, 0.13, 0.34, -0.075, 0.152, 0.465, 0.075, undead ? deadFlesh : hex(0x524c44), A)
      shadedBox(torso, 0.132, 0.05, -0.02, 0.152, 0.35, 0.02, dirty, C)
      // Longer bob hair framing the head and neck
      chamferBox(head, -0.095, 0.14, -0.105, 0.09, 0.245, 0.105, 0.035, hairBrown, A, { low: 0.8 })
      chamferBox(head, -0.105, -0.03, -0.108, 0.03, 0.19, 0.108, 0.025, hairBrown, A, { low: 0.72 })
      if (undead) {
        // Torn open cardigan front soaked with clotted blood + upper-back bite + blood-matted bob hair
        shadedBox(torso, 0.133, 0.16, -0.07, 0.156, 0.42, 0.07, blood, A)
        shadedBox(torso, 0.135, 0.24, -0.04, 0.158, 0.37, 0.04, bloodClot, A)
        shadedBox(torso, -0.176, 0.28, -0.11, -0.11, 0.45, 0.09, blood, A)
        shadedBox(head, -0.05, 0.12, 0.02, 0.085, 0.246, 0.108, bloodClot, A)
      }
    } else if (spec.id === "cop") {
      // Police officer: duty belt + holster, dark tie, gold shield badge, shoulder epaulets, peaked police cap
      shadedBox(pelvis, -0.135, 0.055, -0.18, 0.135, 0.11, 0.18, hex(0x16181c), A)
      shadedBox(pelvis, 0.122, 0.06, -0.028, 0.144, 0.105, 0.028, hex(0xb89c48), MAT.shiny)
      shadedBox(pelvis, -0.04, -0.07, 0.155, 0.05, 0.07, 0.205, hex(0x16181c), A)
      shadedBox(torso, 0.132, 0.14, -0.02, 0.152, 0.43, 0.02, hex(0x16181c), A)
      shadedBox(torso, 0.134, 0.32, -0.12, 0.156, 0.37, -0.08, hex(0xc4a648), MAT.shiny)
      for (const s of [-1, 1]) {
        if (undead && s > 0) continue
        shadedBox(torso, -0.06, 0.44, s * 0.135 - 0.045, 0.06, 0.475, s * 0.135 + 0.045, hex(0x1a202c), A)
      }
      // Peaked police cap: navy octagonal crown + black visor + gold emblem
      chamferBox(head, -0.1, 0.165, -0.108, 0.11, 0.268, 0.108, 0.03, hex(0x1e2636), A, { low: 0.8 })
      shadedBox(head, -0.085, 0.14, -0.095, 0.095, 0.175, 0.095, hex(0x12151c), A)
      shadedBox(head, 0.085, 0.14, -0.09, 0.178, 0.165, 0.09, hex(0x12151c), A)
      shadedBox(head, 0.098, 0.19, -0.022, 0.118, 0.24, 0.022, hex(0xc4a648), MAT.shiny)
      if (undead) {
        // Ripped right shoulder epaulet bite + chest slash across uniform shirt
        shadedBox(torso, -0.08, 0.37, 0.075, 0.11, 0.474, 0.204, deadFlesh, A)
        shadedBox(torso, -0.04, 0.38, 0.095, 0.09, 0.476, 0.19, blood, A)
        shadedBox(torso, 0.133, 0.18, -0.03, 0.156, 0.4, 0.13, blood, A)
      }
    } else if (spec.id === "mail") {
      // Mail carrier: leather satchel on a strap across the chest, open collar, shoulder patch, navy cap
      const leather = hex(0x5a3f28)
      for (let i = 0; i < 6; i++) {
        const u = i / 5
        const y = 0.45 - u * 0.36
        const z = -0.15 + u * 0.3
        shadedBox(torso, 0.141, y - 0.04, z - 0.03, 0.156, y + 0.03, z + 0.03, leather, A)
        shadedBox(torso, -0.156, y - 0.04, -z - 0.03, -0.141, y + 0.03, -z + 0.03, leather, A)
      }
      chamferBox(torso, -0.09, -0.06, 0.2, 0.13, 0.2, 0.275, 0.02, hex(0x6b4a2c), A, { low: 0.78 })
      shadedBox(torso, -0.095, 0.15, 0.198, 0.135, 0.205, 0.28, hex(0x7a5634), A)
      shadedBox(torso, 0.05, 0.12, 0.274, 0.08, 0.16, 0.282, hex(0xa8955a), MAT.shiny)
      for (const z of [-0.055, 0.055]) shadedBox(torso, 0.128, 0.41, z - 0.028, 0.152, 0.47, z + 0.028, dirty, C)
      shadedBox(torso, -0.03, 0.35, -0.206, 0.05, 0.42, -0.199, hex(0xd8d8d0), A)
      shadedBox(torso, -0.01, 0.37, -0.209, 0.03, 0.4, -0.205, hex(0x8a2b2b), A)
      shadedBox(pelvis, -0.13, 0.065, -0.175, 0.13, 0.1, 0.175, hex(0x1f1a16), A)
      chamferBox(head, -0.085, 0.15, -0.098, 0.1, 0.25, 0.098, 0.03, hex(0x3a4358), A, { low: 0.8 })
      shadedBox(head, 0.085, 0.148, -0.086, 0.172, 0.17, 0.086, hex(0x262d3d), A)
      shadedBox(head, -0.085, 0.04, -0.094, -0.02, 0.16, 0.094, hairBrown, A)
      if (undead) {
        shadedBox(torso, 0.133, 0.16, 0.0, 0.155, 0.36, 0.13, blood, A)
        shadedBox(torso, -0.176, 0.3, -0.13, -0.11, 0.45, 0.02, bloodClot, A)
        shadedBox(head, -0.02, 0.15, 0.03, 0.09, 0.252, 0.1, blood, A)
      }
    } else if (spec.id === "jogger") {
      // Jogger: vest top showing the shoulders, earbud cord, headband and earbuds still in
      for (const s of [-1, 1]) shadedBox(torso, -0.11, 0.36, s > 0 ? 0.15 : -0.205, 0.11, 0.472, s > 0 ? 0.205 : -0.15, deadFlesh, A)
      shadedBox(torso, 0.132, 0.38, -0.06, 0.152, 0.47, 0.06, deadFlesh, A)
      shadedBox(torso, 0.142, 0.22, 0.02, 0.149, 0.4, 0.03, hex(0xe2e0da), A)
      shadedBox(torso, 0.142, 0.17, -0.12, 0.152, 0.2, 0.0, hex(0xe2e0da), A)
      shadedBox(pelvis, -0.128, 0.07, -0.172, 0.128, 0.1, 0.172, hex(0xd8d4cc), A)
      for (const s of [-1, 1]) shadedBox(pelvis, -0.02, -0.07, s * 0.168, 0.02, 0.07, s * 0.176, hex(0xd8d4cc), A)
      chamferBox(head, -0.075, 0.15, -0.092, 0.095, 0.215, 0.092, 0.025, hairDark, A, { low: 0.8 })
      shadedBox(head, -0.078, 0.13, -0.096, 0.12, 0.165, 0.096, hex(0xb8463a), A)
      for (const s of [-1, 1]) shadedBox(head, 0.005, 0.095, s > 0 ? 0.09 : -0.104, 0.04, 0.125, s > 0 ? 0.104 : -0.09, hex(0xeeeeea), A)
      if (undead) {
        shadedBox(torso, 0.133, 0.1, -0.12, 0.155, 0.34, 0.02, blood, A)
        shadedBox(torso, -0.176, 0.24, 0.02, -0.11, 0.42, 0.16, blood, A)
        shadedBox(head, 0.02, 0.165, -0.096, 0.1, 0.2, -0.02, bloodClot, A)
      }
    } else if (spec.id === "robe") {
      // Bathrobe: towelling shawl collar open over the chest, tied belt with hanging ends, robe to the knees, curlers
      shadedBox(torso, 0.132, 0.3, -0.05, 0.152, 0.47, 0.05, deadFlesh, A)
      for (const s of [-1, 1]) {
        shadedBox(torso, 0.138, 0.08, s > 0 ? 0.035 : -0.095, 0.158, 0.47, s > 0 ? 0.095 : -0.035, white, C, { low: 0.9 })
      }
      chamferBox(pelvis, -0.15, -0.38, -0.19, 0.15, 0.09, 0.19, 0.03, white, C, GRIME)
      shadedBox(pelvis, 0.148, -0.38, -0.012, 0.156, 0.08, 0.012, torn, C)
      shadedBox(pelvis, -0.154, 0.04, -0.194, 0.154, 0.095, 0.194, torn, C)
      for (const z of [0.035, 0.08]) shadedBox(pelvis, 0.152, -0.16, z - 0.014, 0.164, 0.06, z + 0.014, torn, C)
      chamferBox(head, -0.085, 0.13, -0.1, 0.09, 0.225, 0.1, 0.03, hairBrown, A, { low: 0.75 })
      for (const [x, z, c] of [
        [-0.04, -0.05, 0xc99aa5],
        [-0.04, 0.05, 0x9fb7c8],
        [0.03, -0.05, 0x9fb7c8],
        [0.03, 0.05, 0xc99aa5],
        [-0.075, 0, 0xc99aa5],
      ] as const) {
        shadedBox(head, x - 0.026, 0.215, z - 0.03, x + 0.026, 0.255, z + 0.03, hex(c), A)
      }
      if (undead) {
        shadedBox(torso, 0.134, 0.12, 0.02, 0.16, 0.36, 0.11, blood, A)
        shadedBox(pelvis, 0.15, -0.3, -0.12, 0.158, -0.08, -0.03, bloodClot, A)
        shadedBox(head, -0.01, 0.13, -0.102, 0.08, 0.2, -0.04, blood, A)
      }
    } else if (spec.id === "guard") {
      // Night security: reflective SECURITY band across the back, radio clipped to the chest, torch on the belt, flat cap
      shadedBox(torso, -0.158, 0.3, -0.17, -0.141, 0.375, 0.17, hex(0xb9b9b0), MAT.shiny)
      for (let i = 0; i < 6; i++) shadedBox(torso, -0.161, 0.322, -0.12 + i * 0.045, -0.157, 0.352, -0.1 + i * 0.045, hex(0x1d1e22), A)
      shadedBox(torso, 0.138, 0.29, -0.13, 0.172, 0.38, -0.075, hex(0x18191c), A)
      shadedBox(torso, 0.15, 0.38, -0.118, 0.158, 0.47, -0.108, hex(0x18191c), A)
      shadedBox(torso, 0.135, 0.32, 0.07, 0.155, 0.37, 0.12, hex(0xa8acb0), MAT.shiny)
      for (const s of [-1, 1]) shadedBox(torso, -0.06, 0.44, s * 0.135 - 0.045, 0.06, 0.475, s * 0.135 + 0.045, hex(0x18191c), A)
      shadedBox(pelvis, -0.135, 0.055, -0.18, 0.135, 0.105, 0.18, hex(0x141416), A)
      shadedBox(pelvis, -0.025, -0.13, 0.172, 0.035, 0.08, 0.21, hex(0x1a1a1c), A)
      shadedBox(pelvis, -0.022, -0.15, 0.175, 0.032, -0.128, 0.207, hex(0xc8cfd6), MAT.shiny)
      chamferBox(head, -0.09, 0.155, -0.1, 0.1, 0.24, 0.1, 0.025, hex(0x1b1c20), A, { low: 0.8 })
      shadedBox(head, 0.085, 0.148, -0.088, 0.17, 0.168, 0.088, hex(0x111214), A)
      if (undead) {
        shadedBox(torso, 0.134, 0.14, -0.02, 0.156, 0.32, 0.12, blood, A)
        shadedBox(torso, -0.08, 0.38, -0.204, 0.1, 0.474, -0.08, deadFlesh, A)
        shadedBox(head, -0.05, 0.14, 0.03, 0.06, 0.242, 0.102, bloodClot, A)
      }
    } else if (spec.id === "courier") {
      // Courier: faded hi-vis vest with reflective stripes front and back, scanner on the belt, cap on backwards
      const vis = hex(0xa9b23a)
      const strip = hex(0xbfc3c4)
      for (const x of [0.14, -0.158]) {
        shadedBox(torso, x, 0.06, -0.175, x + 0.018, 0.44, 0.175, vis, A, { low: 0.8 })
        for (const y of [0.14, 0.25]) shadedBox(torso, x - 0.002, y, -0.176, x + 0.02, y + 0.03, 0.176, strip, MAT.shiny)
      }
      for (const s of [-1, 1]) shadedBox(torso, -0.12, 0.42, s > 0 ? 0.08 : -0.15, 0.12, 0.474, s > 0 ? 0.15 : -0.08, vis, A)
      shadedBox(pelvis, 0.06, -0.08, 0.168, 0.12, 0.06, 0.2, hex(0x222428), A)
      pelvis.box(0.075, 0.0, 0.199, 0.105, 0.04, 0.203, hex(0x9fe08a), MAT.glow, 0.25)
      chamferBox(head, -0.09, 0.15, -0.098, 0.095, 0.245, 0.098, 0.03, hex(0x2c3a52), A, { low: 0.8 })
      shadedBox(head, -0.175, 0.148, -0.08, -0.085, 0.168, 0.08, hex(0x1e2838), A)
      if (undead) {
        shadedBox(torso, 0.157, 0.16, -0.06, 0.163, 0.38, 0.1, blood, A)
        shadedBox(torso, -0.165, 0.26, 0.02, -0.158, 0.42, 0.15, bloodClot, A)
        shadedBox(head, 0.02, 0.15, -0.098, 0.09, 0.245, -0.03, blood, A)
      }
    } else if (spec.id === "bride") {
      // Bride: bodice with a bare neckline, long bell skirt torn at the hem, veil down her back, hair up with flowers
      shadedBox(torso, 0.132, 0.36, -0.1, 0.152, 0.468, 0.1, deadFlesh, A)
      for (const s of [-1, 1]) shadedBox(torso, -0.06, 0.4, s > 0 ? 0.13 : -0.2, 0.08, 0.472, s > 0 ? 0.2 : -0.13, deadFlesh, A)
      shadedBox(torso, 0.142, 0.1, -0.012, 0.15, 0.36, 0.012, torn, C)
      chamferBox(pelvis, -0.2, -0.78, -0.24, 0.2, 0.095, 0.24, 0.04, white, C, GRIME)
      for (let i = 0; i < 7; i++) {
        const z = -0.21 + (0.42 * (i + 0.5)) / 7
        const drop = i % 2 === 0 ? 0.06 : 0.025
        const col = undead && (i === 2 || i === 5) ? blood : i % 2 ? dirty : torn
        shadedBox(pelvis, -0.195, -0.78 - drop, z - 0.03, 0.195, -0.74, z + 0.03, col, col === blood ? A : C)
      }
      const veil = hex(0xc9c4b8)
      shadedBox(head, -0.125, -0.32, -0.12, -0.092, 0.22, 0.12, veil, A, { low: 0.7 })
      shadedBox(head, -0.12, 0.2, -0.1, 0.02, 0.23, 0.1, veil, A)
      chamferBox(head, -0.09, 0.14, -0.1, 0.085, 0.22, 0.1, 0.03, hairBrown, A, { low: 0.8 })
      chamferBox(head, -0.1, 0.18, -0.05, -0.02, 0.27, 0.05, 0.025, hairBrown, A, { low: 0.75 })
      for (const z of [-0.07, -0.02, 0.03, 0.075]) shadedBox(head, 0.0, 0.215, z - 0.016, 0.03, 0.24, z + 0.016, hex(z > 0 ? 0xd9cfd0 : 0xe6e2d6), A)
      if (undead) {
        shadedBox(torso, 0.134, 0.14, -0.08, 0.157, 0.4, 0.06, blood, A)
        shadedBox(torso, 0.136, 0.22, -0.05, 0.159, 0.34, 0.02, bloodClot, A)
        shadedBox(pelvis, 0.198, -0.5, 0.02, 0.204, -0.05, 0.13, blood, A)
        shadedBox(head, -0.128, -0.1, -0.06, -0.122, 0.12, 0.04, blood, A)
      }
    } else if (spec.id === "groom") {
      // Groom: dark suit, white shirt and bow tie, a buttonhole flower still on the lapel, hair combed for the day
      const shirt = hex(0xd0ccc2)
      shadedBox(torso, 0.132, 0.24, -0.045, 0.152, 0.468, 0.045, shirt, A)
      for (const s of [-1, 1]) shadedBox(torso, 0.135, 0.18, s > 0 ? 0.045 : -0.085, 0.155, 0.46, s > 0 ? 0.085 : -0.045, hex(0x15161a), A)
      shadedBox(torso, 0.152, 0.425, -0.042, 0.162, 0.458, 0.042, hex(0x101012), A)
      shadedBox(torso, 0.152, 0.35, -0.115, 0.17, 0.385, -0.08, hex(0xd6d0c4), A)
      shadedBox(torso, 0.168, 0.36, -0.105, 0.174, 0.375, -0.09, hex(0x7a1c22), A)
      for (const y of [0.12, 0.2]) shadedBox(torso, 0.142, y, -0.01, 0.15, y + 0.02, 0.01, hex(0x0e0e10), A)
      chamferBox(head, -0.08, 0.15, -0.094, 0.095, 0.225, 0.094, 0.028, hairDark, A, { low: 0.85 })
      shadedBox(head, -0.085, 0.04, -0.094, -0.02, 0.17, 0.094, hairDark, A)
      if (undead) {
        shadedBox(torso, 0.153, 0.26, -0.04, 0.158, 0.42, 0.04, blood, A)
        shadedBox(torso, -0.175, 0.28, -0.13, -0.11, 0.45, 0.06, blood, A)
        shadedBox(head, -0.02, 0.15, 0.02, 0.08, 0.228, 0.096, bloodClot, A)
      }
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
      if (undead) {
        // Blood-soaked hoodie chest, kangaroo pouch & back/side hood bite
        shadedBox(torso, 0.132, 0.11, -0.09, 0.157, 0.38, 0.08, blood, A)
        shadedBox(torso, 0.135, 0.18, -0.05, 0.159, 0.32, 0.04, bloodClot, A)
        shadedBox(torso, -0.176, 0.26, -0.13, -0.11, 0.44, 0.08, blood, A)
        shadedBox(head, -0.08, 0.14, -0.11, 0.06, 0.256, -0.025, bloodClot, A)
      }
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

  if (undead) {
    // Upper arm: shredded short sleeve + exposed sallow grey-green bicep with dark bite & bruise
    chamferBox(upperArm, -0.075, -0.14, -0.075, 0.075, 0.05, 0.075, 0.028, white, C, GRIME)
    ;[0.05, 0.025, 0.07].forEach((d, i) => {
      const x = -0.06 + 0.06 * i
      shadedBox(upperArm, x - 0.024, -0.14 - d, -0.07, x + 0.024, -0.12, 0.07, i === 1 ? blood : torn, i === 1 ? A : C)
    })
    chamferBox(upperArm, -0.056, -0.3, -0.056, 0.056, -0.13, 0.056, 0.02, deadFlesh, A, { low: 0.76 })
    shadedBox(upperArm, 0.04, -0.25, -0.04, 0.059, -0.16, 0.04, blood, A)
    shadedBox(upperArm, -0.058, -0.27, -0.04, 0.035, -0.18, 0.058, bruise, A)

    // Forearm: decayed skin-tinted forearm + dark forearm bite + clotted blood-stained hands
    chamferBox(foreArm, -0.054, -0.23, -0.054, 0.054, 0.03, 0.054, 0.022, white, C, { low: 0.65 })
    shadedBox(foreArm, 0.042, -0.15, -0.038, 0.06, -0.06, 0.038, blood, A)
    shadedBox(foreArm, -0.056, -0.22, -0.042, 0.042, -0.14, 0.056, bruise, A)
    chamferBox(foreArm, -0.055, -0.31, -0.058, 0.06, -0.225, 0.058, 0.02, bloodClot, A, { low: 0.78 })
    shadedBox(foreArm, 0.036, -0.305, -0.044, 0.062, -0.24, 0.044, blood, A)

    // Thigh & shin: ripped trousers exposing necrotic grey-green leg, dried bloodstains & grave mud
    chamferBox(thigh, -0.085, -0.43, -0.085, 0.085, 0.04, 0.085, 0.035, white, C, GRIME)
    shadedBox(thigh, 0.068, -0.3, -0.054, 0.088, -0.16, 0.054, deadFlesh, A)
    shadedBox(thigh, 0.071, -0.34, -0.042, 0.09, -0.22, 0.042, blood, A)
    chamferBox(shin, -0.067, -0.41, -0.07, 0.067, 0.03, 0.07, 0.03, white, C, { low: 0.42, under: 0.48 })
    shadedBox(shin, 0.056, -0.12, -0.052, 0.075, 0.02, 0.052, deadFlesh, A)
    shadedBox(shin, 0.058, -0.21, -0.046, 0.074, -0.1, 0.046, blood, A)
    shadedBox(shin, 0.055, -0.4, -0.06, 0.072, -0.29, 0.06, shadeOf(hex(0x33271e), 0.9), A)
  } else {
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
  }

  // Shoes/boots: chamfered upper + shadedBox sole, built white and tinted per instance to `ZOMBIE_BOOT` (so a
  // bathrobe's slipper or bare foot can differ); the sole keeps its shade relative to the upper.
  const soleShade: Rgb = [sole[0] / boot[0], sole[1] / boot[1], sole[2] / boot[2]]
  chamferBox(foot, -0.076, -0.072, -0.068, 0.125, 0.015, 0.068, 0.025, white, C, { low: 0.8, under: 0.5 })
  shadedBox(foot, -0.078, -0.085, -0.07, 0.128, -0.062, 0.07, soleShade, C)
  chamferBox(toe, -0.008, 0.012, -0.065, 0.062, 0.075, 0.065, 0.025, white, C, { low: 0.85 })
  shadedBox(toe, -0.006, 0.0, -0.068, 0.066, 0.02, 0.068, soleShade, C)

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
