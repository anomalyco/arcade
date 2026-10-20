import { ordinarySeed, specialKindOf, SPECIAL_NONE } from "../specials/kinds"

/**
 * Who a zombie was (AR-88): its calling, read from its seed and id, so every client draws the same person with nothing
 * on the wire. The first six are the Former Townsfolk archetypes everyone already had (`BASE_CALLINGS`); the rest are
 * the people a street would have had in it the morning it turned. Brides and grooms are rare on their own and stand in
 * pairs at the church (`sites.ts`), where the sim picks a seed that reads as them (`seedForCalling`).
 */
export const CALLING_IDS = [
  "office",
  "nurse",
  "mechanic",
  "dress",
  "cop",
  "hoodie",
  "mail",
  "jogger",
  "robe",
  "guard",
  "courier",
  "bride",
  "groom",
] as const

export type CallingId = (typeof CALLING_IDS)[number]

export const CALLING_LABELS: Readonly<Record<CallingId, string>> = {
  office: "Office shirt & tie",
  nurse: "Clinic scrubs",
  mechanic: "Mechanic overalls",
  dress: "Torn dress & cardigan",
  cop: "Police uniform",
  hoodie: "Streetwear hoodie",
  mail: "Mail carrier with satchel",
  jogger: "Jogger with earbuds",
  robe: "Bathrobe and one slipper",
  guard: "Night security guard",
  courier: "Courier in a hi-vis vest",
  bride: "Bride",
  groom: "Groom",
}

/** How many callings the Former Townsfolk look had before AR-88; "Today" draws only these. */
export const BASE_CALLINGS = 6

/** Out of 1000 ordinary zombies, how many were each calling. */
const CALLING_WEIGHTS: readonly number[] = [120, 95, 110, 120, 55, 152, 55, 75, 90, 55, 65, 4, 4]
const CALLING_CUMULATIVE = CALLING_WEIGHTS.reduce<number[]>((acc, w) => [...acc, (acc.at(-1) ?? 0) + w], [])

export const callingIndexOf = (id: CallingId): number => CALLING_IDS.indexOf(id)

/** A zombie's 32-bit look hash (murmur3 finaliser over seed and id); the palette and calling read its bits. */
export function zombieHash(seed: number, id = 0): number {
  let h = ((seed | 0) ^ Math.imul((id | 0) + 1, 0x9e3779b1)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/**
 * The calling index (into `CALLING_IDS`) of zombie `id` with `seed`. With `occupations` off, or for a special (whose
 * silhouette is its own), it is one of the six base archetypes exactly as before AR-88.
 */
export function callingIndex(seed: number, id: number, occupations = true): number {
  const h = zombieHash(seed, id)
  if (!occupations || specialKindOf(seed) !== SPECIAL_NONE) return h % BASE_CALLINGS
  const r = (h >>> 9) % 1000
  for (let i = 0; i < CALLING_CUMULATIVE.length; i++) if (r < CALLING_CUMULATIVE[i]!) return i
  return BASE_CALLINGS - 1
}

/**
 * How long ago it turned, 0 (this morning: clothes nearly clean, skin still grey-pink) to 1 (weeks: filthy, faded,
 * green). Seeded, independent of the calling's bits.
 */
export function turnedAgo(seed: number, id: number): number {
  const h = zombieHash(seed ^ 0x6a09e667, id)
  const u = (h & 0xffff) / 0xffff
  // Most of the town turned in the first days; a few have been walking a long time.
  return u * u * 0.75 + ((h >>> 16) & 0xff) / 255 * 0.25
}

/**
 * An ordinary seed near `seed` that reads as calling `calling` for zombie `id` (the sim gives a habit zombie the person
 * its place implies). Deterministic; returns `seed` unchanged if it already reads as that calling.
 */
export function seedForCalling(seed: number, id: number, calling: number): number {
  let s = ordinarySeed(seed)
  if (callingIndex(s, id) === calling) return s
  for (let k = 1; k < 50_000; k++) {
    s = ordinarySeed((Math.imul(seed ^ (k * 0x2545f491), 0x9e3779b1) ^ (k << 7)) >>> 0)
    if (callingIndex(s, id) === calling) return s
  }
  return ordinarySeed(seed)
}

const LEASH_CALLINGS = new Set(["robe", "hoodie", "dress", "office", "jogger"])

/** About one in thirty-five of those who were out walking still holds a dog's lead, with nothing on the end of it. */
export function walksEmptyLeash(seed: number, id: number, occupations = true): boolean {
  if (!occupations || specialKindOf(seed) !== SPECIAL_NONE) return false
  if (!LEASH_CALLINGS.has(CALLING_IDS[callingIndex(seed, id)]!)) return false
  return zombieHash(seed ^ 0x1eaf5, id) % 1000 < 70
}
