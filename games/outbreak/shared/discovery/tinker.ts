import type { ItemDef, ItemId } from "@arcade/kit/sim/ledger"

/**
 * Workbench tinkering (D-19 slice 2): two materials go on the bench mat and a held E tries them together. A pair that
 * makes something assembles it on the mat and pins a sketch to the corkboard; a pair that needs the toolbox leaves a
 * faint idea pinned instead; anything else clatters apart and a crossed-out scrap remembers it. Everything the team
 * learns this way is ledger state in `team/known`, so it is deterministic, saved, and the same for every player.
 */

/** What goes on the mat, in the order E cycles through pairs. */
export const TINKER_MATERIALS = ["plank", "scrap", "chem", "battery"] as const

export type TinkerRecipe = { id: string; tinker: readonly [ItemId, ItemId]; tier: number; produces?: ItemId }

/** "plank+scrap": an unordered pair, sorted by material order so both orders agree. */
export function pairKey(a: ItemId, b: ItemId): string {
  const rank = (m: ItemId) => (TINKER_MATERIALS as readonly string[]).indexOf(m)
  return rank(a) <= rank(b) ? `${a}+${b}` : `${b}+${a}`
}

/** Every pair of two materials, doubles included, in cycle order (plank+plank, plank+scrap, … battery+battery). */
export const ALL_PAIRS: readonly (readonly [ItemId, ItemId])[] = TINKER_MATERIALS.flatMap((a, i) =>
  TINKER_MATERIALS.slice(i).map((b) => [a, b] as const),
)

/** The two units a pair takes, as a ledger cost (`{ chem: 2 }` for a double). */
export function pairCost(pair: readonly [ItemId, ItemId]): Record<ItemId, number> {
  const out: Record<ItemId, number> = {}
  for (const m of pair) out[m] = (out[m] ?? 0) + 1
  return out
}

export const matStoreId = (benchId: string) => `mat:${benchId.replace(/^bench:/, "")}`
export const benchOfMat = (matId: string) => `bench:${matId.replace(/^mat:/, "")}`
export const pinStoreId = (recipe: string) => `pin:${recipe}`
export const ideaToken = (recipe: string) => `idea:${recipe}`
export const triedToken = (pair: string) => `tried:${pair}`
export const MAT_SLOTS = 2

export type TinkerOutcome =
  /** The pair makes `recipe` and the bench is good enough: it assembles. */
  | { kind: "assemble"; recipe: string; pair: string }
  /** The pair makes `recipe` but needs a better bench: the parts nearly fit. */
  | { kind: "almost"; recipe: string; pair: string }
  /** Nothing comes of it. `record` is false for a pair that does make something (a passive lesson already known). */
  | { kind: "clatter"; pair: string; record: boolean }

/** What trying `mat` (exactly two materials) at a bench of `tier` would do, or null when the mat is not ready. */
export function judgeMat(recipes: readonly TinkerRecipe[], mat: readonly ItemId[], tier: number, known: (recipe: string) => boolean): TinkerOutcome | null {
  if (mat.length !== MAT_SLOTS || !mat.every((m) => (TINKER_MATERIALS as readonly string[]).includes(m))) return null
  const pair = pairKey(mat[0]!, mat[1]!)
  const recipe = recipes.find((r) => pairKey(r.tinker[0], r.tinker[1]) === pair)
  if (!recipe) return { kind: "clatter", pair, record: true }
  if (recipe.tier > tier) return { kind: "almost", recipe: recipe.id, pair }
  // A lesson with nothing to hold (reinforcing boards) is learned once; trying it again makes nothing.
  if (!recipe.produces && known(recipe.id)) return { kind: "clatter", pair, record: false }
  return { kind: "assemble", recipe: recipe.id, pair }
}

/** Catalog entries for the corkboard's ideas and crossed-out tries. */
export function tinkerKnowledgeItems(recipes: readonly TinkerRecipe[]): ItemDef[] {
  const made = new Set(recipes.map((r) => pairKey(r.tinker[0], r.tinker[1])))
  return [
    ...recipes.map((r): ItemDef => ({ id: ideaToken(r.id), label: `Idea: ${r.id}`, tag: "knowledge" })),
    ...ALL_PAIRS.map(([a, b]) => pairKey(a, b))
      .filter((p) => !made.has(p))
      .map((p): ItemDef => ({ id: triedToken(p), label: `Tried ${p}`, tag: "knowledge" })),
  ]
}

/** The pair after `current` (an index into `ALL_PAIRS`, or -1 for an empty mat) that `have` can pay for; -1 wraps to empty. */
export function nextPair(current: number, have: (item: ItemId) => number): number {
  const n = ALL_PAIRS.length
  for (let step = 1; step <= n; step++) {
    const i = current + step
    if (i >= n) return -1
    const cost = pairCost(ALL_PAIRS[i]!)
    if (Object.entries(cost).every(([m, k]) => have(m) >= k)) return i
  }
  return -1
}

/** What pinned a recipe up: a sketch from making it (or studying one), or a page found in a building. */
export const PIN_SOURCES = ["sketch", "flyer", "chart", "photo"] as const
export type PinSource = (typeof PIN_SOURCES)[number]

/**
 * Who first learned a recipe: the pin store's owner and their seat (stored +1 so seat 0 is a count), and whether
 * the pin is their sketch or a page they found (`counts.found`, an index into `PIN_SOURCES`).
 */
export type Pin = { recipe: string; actor: string | null; seat: number | null; at: { x: number; y: number } | null; source: PinSource }

export function readPin(store: { owner?: string; counts: Record<string, number>; at?: { x: number; y: number } } | undefined, recipe: string): Pin | null {
  if (!store) return null
  const seat = store.counts.seat
  const source = PIN_SOURCES[store.counts.found ?? 0] ?? "sketch"
  return { recipe, actor: store.owner ?? null, seat: seat ? seat - 1 : null, at: store.at ? { ...store.at } : null, source }
}

/** Index of the pair on a mat holding exactly two materials, or -1. */
export function pairIndex(mat: readonly ItemId[]): number {
  if (mat.length !== MAT_SLOTS) return -1
  const key = pairKey(mat[0]!, mat[1]!)
  return ALL_PAIRS.findIndex(([a, b]) => pairKey(a, b) === key)
}
